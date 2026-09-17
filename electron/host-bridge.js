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
    // allowHalfOpen: an EOF on one direction must never auto-end the other, or the
    // server half would close before it has written its response.
    super({ allowHalfOpen: true });
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
      activeStreams.set(streamId, { clientSocket, serverSocket });

      let parsedUrl;
      try {
        parsedUrl = new URL(meta.url, "http://localhost");
      } catch {
        parsedUrl = new URL("http://localhost/");
      }
      const requestPath = parsedUrl.pathname + parsedUrl.search;
      const method = (meta.method || "GET").toUpperCase();

      // Hook up clientSocket reading to parse HTTP response and emit FD 4 frames
      setupResponseConsumer(streamId, clientSocket, method === "HEAD");

      // Connect serverSocket to Next.js HTTP server
      server.emit("connection", serverSocket);

      // Construct and send raw HTTP/1.1 request into clientSocket
      let rawHeader = `${method} ${requestPath} HTTP/1.1\r\n`;
      let hasHost = false;
      let hasContentLength = false;
      let hasTransferEncoding = false;

      if (Array.isArray(meta.headers)) {
        for (const [k, v] of meta.headers) {
          const lk = k.toLowerCase();
          if (lk === "host") hasHost = true;
          if (lk === "content-length") hasContentLength = true;
          if (lk === "transfer-encoding") hasTransferEncoding = true;
          rawHeader += `${k}: ${v}\r\n`;
        }
      } else if (meta.headers && typeof meta.headers === "object") {
        for (const [k, v] of Object.entries(meta.headers)) {
          const lk = k.toLowerCase();
          if (lk === "host") hasHost = true;
          if (lk === "content-length") hasContentLength = true;
          if (lk === "transfer-encoding") hasTransferEncoding = true;
          rawHeader += `${k}: ${v}\r\n`;
        }
      }

      if (!hasHost) {
        rawHeader += "Host: localhost\r\n";
      }

      const isChunked = !!meta.hasBody && !hasContentLength && !hasTransferEncoding;
      if (isChunked) {
        rawHeader += "Transfer-Encoding: chunked\r\n";
      }
      rawHeader += "\r\n";

      activeStreams.set(streamId, { clientSocket, serverSocket, isChunked });

      clientSocket.write(rawHeader);
      return;
    }

    if (frame.type === "data") {
      const active = activeStreams.get(streamId);
      if (active && active.clientSocket.writable) {
        if (active.isChunked) {
          const sizeHex = frame.data.length.toString(16);
          active.clientSocket.write(`${sizeHex}\r\n`);
          active.clientSocket.write(frame.data);
          active.clientSocket.write("\r\n");
        } else {
          active.clientSocket.write(frame.data);
        }
      }
      return;
    }

    if (frame.type === "end") {
      const active = activeStreams.get(streamId);
      if (active && active.clientSocket.writable) {
        if (active.isChunked) {
          // Terminal chunk ends the request body. Do NOT end the socket here: a real
          // HTTP client keeps the connection open while the server writes its response.
          active.clientSocket.write("0\r\n\r\n");
        }
      }
      return;
    }

    if (frame.type === "cancel") {
      closeStream(streamId);
      return;
    }
  }

  function closeStream(streamId) {
    const active = activeStreams.get(streamId);
    if (!active) return;
    activeStreams.delete(streamId);
    try {
      active.clientSocket.destroy();
    } catch {
      /* ignore */
    }
    try {
      active.serverSocket?.destroy();
    } catch {
      /* ignore */
    }
  }

  function setupResponseConsumer(streamId, clientSocket, forceNoBody) {
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
        closeStream(streamId);
      },
      // onError
      async (err) => {
        await writeResponse(encodeResponseError(streamId, err.message));
        closeStream(streamId);
      },
      { forceNoBody }
    );

    clientSocket.on("data", (chunk) => {
      parser.push(chunk);
    });

    clientSocket.once("end", () => {
      parser.finish();
      closeStream(streamId);
    });

    clientSocket.once("error", (err) => {
      parser.onError(err);
      closeStream(streamId);
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
