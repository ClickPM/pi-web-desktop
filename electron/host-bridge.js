"use strict";

/**
 * Headless Next.js Host Bridge for pi-web-desktop.
 * Uses native Node.js http.Server via in-memory socket pairs (zero TCP ports).
 * Carries all requests/responses across FD 3/4 binary framing carrier.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const { Duplex } = require("stream");
const { HttpResponseParser } = require("./http-response-parser");
const {
  DESKTOP_PIPE_CHUNK_BYTES,
  DESKTOP_REQUEST_PIPE_FD,
  DESKTOP_RESPONSE_PIPE_FD,
  FrameDecoder,
  encodeResponseStart,
  encodeResponseData,
  encodeResponseEnd,
  encodeResponseError,
} = require("./host-protocol");

class MemorySocket extends Duplex {
  constructor(peer) {
    super();
    this.peer = peer;
    this.remoteAddress = "127.0.0.1";
    this.remotePort = 54321;
    this.localAddress = "127.0.0.1";
    this.localPort = 80;
    this.encrypted = false;
  }
  _write(chunk, encoding, callback) {
    if (this.peer) this.peer.push(chunk);
    callback();
  }
  _read() {}
  _final(callback) {
    if (this.peer) this.peer.push(null);
    callback();
  }
}

function createSocketPair() {
  const s1 = new MemorySocket();
  const s2 = new MemorySocket(s1);
  s1.peer = s2;
  return [s1, s2];
}

async function main() {
  const pkgDir = process.argv[2];
  if (!pkgDir || !fs.existsSync(pkgDir)) {
    throw new Error(`Host bridge: valid package directory required, got: ${pkgDir}`);
  }

  const requestStream = fs.createReadStream("", { fd: DESKTOP_REQUEST_PIPE_FD, autoClose: false });
  const responseStream = fs.createWriteStream("", { fd: DESKTOP_RESPONSE_PIPE_FD, autoClose: false });

  let writeTail = Promise.resolve();
  function writeResponse(frame) {
    const write = writeTail.then(() => {
      if (!responseStream.write(frame)) {
        return new Promise((resolve) => responseStream.once("drain", resolve));
      }
    });
    writeTail = write.catch(() => {});
    return write;
  }

  let nextFactory;
  try {
    const nextPath = require.resolve("next", {
      paths: [pkgDir, path.resolve(pkgDir, "..", ".."), path.resolve(pkgDir, "..")],
    });
    nextFactory = require(nextPath);
  } catch (e) {
    try {
      nextFactory = require("next");
    } catch {
      throw new Error(`Cannot resolve 'next' from ${pkgDir}: ${e.message}`);
    }
  }

  const app = nextFactory({ dev: false, dir: pkgDir });
  await app.prepare();
  const handle = app.getRequestHandler();

  // Create native HTTP server without calling listen()
  const server = http.createServer((req, res) => handle(req, res));

  const decoder = new FrameDecoder(true);
  const activeStreams = new Map(); // streamId -> { clientSocket }

  requestStream.on("data", async (chunk) => {
    try {
      const frames = decoder.push(chunk);
      for (const frame of frames) {
        handleRequestFrame(frame);
      }
    } catch (err) {
      if (process.send) {
        process.send({ type: "fatal", message: `Pipe decoding error: ${err.message}` });
      }
    }
  });

  requestStream.once("end", () => {
    process.exit(0);
  });

  function handleRequestFrame(frame) {
    const { streamId } = frame;

    if (frame.type === "start") {
      const { meta } = frame;
      const [clientSocket, serverSocket] = createSocketPair();
      activeStreams.set(streamId, { clientSocket });

      let parsedUrl;
      try {
        parsedUrl = new URL(meta.url, "http://localhost");
      } catch {
        parsedUrl = new URL("http://localhost/");
      }
      const requestPath = parsedUrl.pathname + parsedUrl.search;
      const method = (meta.method || "GET").toUpperCase();

      // Hook up clientSocket reading to parse HTTP response and emit FD 4 frames
      setupResponseConsumer(streamId, clientSocket);

      // Connect serverSocket to Next.js HTTP server
      server.emit("connection", serverSocket);

      // Construct and send raw HTTP/1.1 request into clientSocket
      let rawHeader = `${method} ${requestPath} HTTP/1.1\r\n`;
      let hasHost = false;

      if (Array.isArray(meta.headers)) {
        for (const [k, v] of meta.headers) {
          if (k.toLowerCase() === "host") hasHost = true;
          rawHeader += `${k}: ${v}\r\n`;
        }
      } else if (meta.headers && typeof meta.headers === "object") {
        for (const [k, v] of Object.entries(meta.headers)) {
          if (k.toLowerCase() === "host") hasHost = true;
          rawHeader += `${k}: ${v}\r\n`;
        }
      }

      if (!hasHost) {
        rawHeader += "Host: localhost\r\n";
      }
      rawHeader += "\r\n";

      clientSocket.write(rawHeader);
      return;
    }

    if (frame.type === "data") {
      const active = activeStreams.get(streamId);
      if (active && active.clientSocket.writable) {
        active.clientSocket.write(frame.data);
      }
      return;
    }

    if (frame.type === "end") {
      const active = activeStreams.get(streamId);
      if (active && active.clientSocket.writable) {
        active.clientSocket.end();
      }
      return;
    }

    if (frame.type === "cancel") {
      const active = activeStreams.get(streamId);
      if (active) {
        active.clientSocket.destroy();
        activeStreams.delete(streamId);
      }
      return;
    }
  }

  function setupResponseConsumer(streamId, clientSocket) {
    const parser = new HttpResponseParser(
      // onStart
      async (status, headers, hasBody) => {
        await writeResponse(encodeResponseStart(streamId, {
          status,
          headers,
          hasBody,
        }));
      },
      // onData
      async (data) => {
        for (let offset = 0; offset < data.length; offset += DESKTOP_PIPE_CHUNK_BYTES) {
          const slice = data.subarray(offset, offset + DESKTOP_PIPE_CHUNK_BYTES);
          await writeResponse(encodeResponseData(streamId, slice));
        }
      },
      // onEnd
      async () => {
        await writeResponse(encodeResponseEnd(streamId));
        clientSocket.destroy();
        activeStreams.delete(streamId);
      },
      // onError
      async (err) => {
        await writeResponse(encodeResponseError(streamId, err.message));
        clientSocket.destroy();
        activeStreams.delete(streamId);
      }
    );

    clientSocket.on("data", (chunk) => {
      parser.push(chunk);
    });

    clientSocket.once("end", () => {
      parser.finish();
      activeStreams.delete(streamId);
    });

    clientSocket.once("error", (err) => {
      parser.onError(err);
      activeStreams.delete(streamId);
    });
  }

  process.on("message", (msg) => {
    if (msg && msg.type === "shutdown") {
      process.exit(0);
    }
  });

  if (process.send) {
    process.send({ type: "ready" });
  }
}

main().catch((err) => {
  console.error("Host bridge fatal error:", err);
  if (process.send) {
    process.send({ type: "fatal", message: err.message });
  }
  process.exit(1);
});
