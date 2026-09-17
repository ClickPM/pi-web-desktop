"use strict";

/**
 * Host Process Controller for Electron Main Process.
 * Spawns the headless Next.js bridge and manages the FD 3/4 binary framing carrier.
 */

const { spawn } = require("child_process");
const { once } = require("events");
const {
  DESKTOP_PIPE_CHUNK_BYTES,
  DESKTOP_REQUEST_PIPE_FD,
  DESKTOP_RESPONSE_PIPE_FD,
  FrameDecoder,
  encodeRequestStart,
  encodeRequestData,
  encodeRequestEnd,
  encodeRequestCancel,
} = require("./host-protocol");

// Statuses the Fetch spec forbids a body on.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

class DesktopHostProcess {
  constructor(executable, bridgeScript, pkgDir, options = {}) {
    this.executable = executable;
    this.bridgeScript = bridgeScript;
    this.pkgDir = pkgDir;
    this.env = options.env || process.env;
    this.dbg = options.dbg || (() => {});

    this.child = null;
    this.requestPipe = null;
    this.responsePipe = null;
    this.responseDecoder = new FrameDecoder(false);
    this.nextStreamId = 1;
    this.pending = new Map(); // streamId -> PendingResponse
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
  }

  async start() {
    if (this.child) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.dbg(`spawning host bridge: ${this.executable} ${this.bridgeScript} ${this.pkgDir}`);

    const child = spawn(this.executable, [this.bridgeScript, this.pkgDir], {
      cwd: this.pkgDir,
      env: {
        ...this.env,
        NODE_ENV: "production",
        ELECTRON_RUN_AS_NODE: "1",
      },
      // FD 0: ignore, FD 1: stdout, FD 2: stderr, FD 3: req, FD 4: res, FD 5: ipc
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });

    const requestPipe = child.stdio[DESKTOP_REQUEST_PIPE_FD];
    const responsePipe = child.stdio[DESKTOP_RESPONSE_PIPE_FD];

    if (!requestPipe || !responsePipe) {
      child.kill("SIGTERM");
      throw new Error("Host process failed to expose the required FD 3/4 pipes");
    }

    this.child = child;
    this.requestPipe = requestPipe;
    this.responsePipe = responsePipe;

    child.stdout.on("data", (d) => {
      const txt = d.toString().trim();
      if (txt) this.dbg(`[bridge stdout] ${txt}`);
    });
    child.stderr.on("data", (d) => {
      const txt = d.toString().trim();
      if (txt) this.dbg(`[bridge stderr] ${txt}`);
    });

    responsePipe.on("data", (chunk) => {
      try {
        const frames = this.responseDecoder.push(chunk);
        for (const frame of frames) {
          this.handleResponseFrame(frame);
        }
      } catch (err) {
        this.dbg(`response pipe decode error: ${err.message}`);
      }
    });

    child.on("message", (msg) => {
      if (msg && msg.type === "ready") {
        this.dbg("host bridge reported ready");
        this.readyResolve();
      } else if (msg && msg.type === "fatal") {
        const err = new Error(msg.message || "Host bridge reported fatal error");
        this.dbg(`host bridge fatal: ${err.message}`);
        this.readyReject(err);
      }
    });

    child.once("exit", (code, signal) => {
      this.dbg(`host bridge exited: code=${code}, signal=${signal}`);
      for (const [streamId, pending] of this.pending.entries()) {
        pending.reject(new Error(`Host bridge exited unexpectedly (code ${code})`));
      }
      this.pending.clear();
      this.child = null;
    });

    return this.readyPromise;
  }

  async fetch(webRequest) {
    await this.start();
    if (!this.child || !this.requestPipe) {
      throw new Error("Host process is unavailable");
    }

    const streamId = this.nextStreamId++;
    const method = webRequest.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && webRequest.body !== null;

    return new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        controller: null,
        started: false,
      };
      this.pending.set(streamId, pending);

      // Encode request start
      const headers = [];
      for (const [k, v] of webRequest.headers.entries()) {
        headers.push([k, v]);
      }

      this.writeFrame(encodeRequestStart(streamId, {
        url: webRequest.url,
        method,
        headers,
        hasBody,
      }));

      // Stream request body if present
      if (hasBody && webRequest.body) {
        this.pumpRequestBody(streamId, webRequest.body).catch((err) => {
          this.dbg(`failed pumping request body for stream ${streamId}: ${err.message}`);
        });
      }
    });
  }

  async pumpRequestBody(streamId, body) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        for (let offset = 0; offset < buf.length; offset += DESKTOP_PIPE_CHUNK_BYTES) {
          const slice = buf.subarray(offset, offset + DESKTOP_PIPE_CHUNK_BYTES);
          await this.writeFrame(encodeRequestData(streamId, slice));
        }
      }
      await this.writeFrame(encodeRequestEnd(streamId));
    } finally {
      reader.releaseLock();
    }
  }

  async writeFrame(buf) {
    if (!this.requestPipe || this.requestPipe.destroyed) return;
    if (!this.requestPipe.write(buf)) {
      await once(this.requestPipe, "drain");
    }
  }

  handleResponseFrame(frame) {
    const pending = this.pending.get(frame.streamId);
    if (!pending) return;

    if (frame.type === "start") {
      pending.started = true;
      const { status, headers, hasBody } = frame.meta;

      // 204/205/304 and friends must be constructed with a null body, or the
      // Response constructor throws and the request would hang forever.
      const nullBody = hasBody === false || NULL_BODY_STATUSES.has(status);
      if (nullBody) {
        pending.resolve(
          new Response(null, { status, headers: new Headers(headers) })
        );
        return;
      }

      const bodyStream = new ReadableStream({
        start: (controller) => {
          pending.controller = controller;
        },
        cancel: () => {
          this.writeFrame(encodeRequestCancel(frame.streamId)).catch(() => {});
          this.pending.delete(frame.streamId);
        },
      });

      const response = new Response(bodyStream, {
        status,
        headers: new Headers(headers),
      });

      pending.resolve(response);
      return;
    }

    if (frame.type === "data") {
      if (pending.controller) {
        pending.controller.enqueue(new Uint8Array(frame.data));
      }
      return;
    }

    if (frame.type === "end") {
      if (pending.controller) {
        try {
          pending.controller.close();
        } catch {}
      }
      this.pending.delete(frame.streamId);
      return;
    }

    if (frame.type === "error") {
      const err = new Error(frame.message || "Host response error");
      if (pending.controller) {
        pending.controller.error(err);
      } else {
        pending.reject(err);
      }
      this.pending.delete(frame.streamId);
      return;
    }
  }

  async stop() {
    if (!this.child) return;
    try {
      this.child.send({ type: "shutdown" });
    } catch {}
    this.requestPipe?.destroy();
    this.child = null;
  }
}

module.exports = { DesktopHostProcess };
