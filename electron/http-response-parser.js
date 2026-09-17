"use strict";

/**
 * Lightweight HTTP/1.1 Response Parser.
 * Accurately detects response completion for:
 *  - Transfer-Encoding: chunked (terminal 0\r\n\r\n)
 *  - Content-Length: N (exact byte counter)
 *  - Status codes with no body (204, 304, etc.)
 */
class HttpResponseParser {
  constructor(onStart, onData, onEnd, onError, options = {}) {
    this.onStart = onStart;
    this.onData = onData;
    this.onEnd = onEnd;
    this.onError = onError;
    // A HEAD response carries the headers of the GET response (Content-Length
    // included) but never a body, so never wait for one.
    this.forceNoBody = !!options.forceNoBody;

    this.state = "HEADER"; // HEADER, CHUNK_SIZE, CHUNK_DATA, CHUNK_CRLF, FIXED_BODY, DONE
    this.buffer = Buffer.alloc(0);
    this.statusCode = 200;
    this.headers = [];
    this.isChunked = false;
    this.contentLength = -1;
    this.bytesRead = 0;
    this.currentChunkSize = 0;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.parse();
  }

  parse() {
    try {
      while (this.buffer.length > 0 && this.state !== "DONE") {
        if (this.state === "HEADER") {
          const headerEnd = this.buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return; // Wait for full header

          const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
          this.buffer = this.buffer.subarray(headerEnd + 4);

          const lines = headerText.split("\r\n");
          const statusMatch = lines[0].match(/HTTP\/[0-9.]+\s+(\d+)/i);
          this.statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 200;

          for (let i = 1; i < lines.length; i++) {
            const colon = lines[i].indexOf(":");
            if (colon !== -1) {
              const k = lines[i].slice(0, colon).trim();
              const v = lines[i].slice(colon + 1).trim();
              const lk = k.toLowerCase();

              if (lk === "transfer-encoding" && v.toLowerCase().includes("chunked")) {
                this.isChunked = true;
              } else if (lk === "content-length") {
                this.contentLength = parseInt(v, 10);
              }

              if (lk !== "connection" && lk !== "transfer-encoding") {
                this.headers.push([k, v]);
              }
            }
          }

          // Emit response start
          const hasNoBody =
            this.forceNoBody ||
            this.statusCode === 204 ||
            this.statusCode === 304 ||
            (this.contentLength === 0 && !this.isChunked);

          this.onStart(this.statusCode, this.headers, !hasNoBody);

          if (hasNoBody) {
            this.state = "DONE";
            this.onEnd();
            return;
          }

          if (this.isChunked) {
            this.state = "CHUNK_SIZE";
          } else if (this.contentLength >= 0) {
            this.state = "FIXED_BODY";
          } else {
            // Raw streaming body
            this.state = "RAW_STREAM";
          }
        }

        if (this.state === "FIXED_BODY") {
          const remaining = this.contentLength - this.bytesRead;
          if (remaining <= 0) {
            this.state = "DONE";
            this.onEnd();
            return;
          }

          const toTake = Math.min(this.buffer.length, remaining);
          const data = this.buffer.subarray(0, toTake);
          this.buffer = this.buffer.subarray(toTake);
          this.bytesRead += toTake;

          this.onData(data);

          if (this.bytesRead >= this.contentLength) {
            this.state = "DONE";
            this.onEnd();
            return;
          }
        }

        if (this.state === "CHUNK_SIZE") {
          const crlf = this.buffer.indexOf("\r\n");
          if (crlf === -1) return; // Wait for chunk size line

          const sizeLine = this.buffer.subarray(0, crlf).toString("utf8").trim();
          this.buffer = this.buffer.subarray(crlf + 2);

          const chunkSize = parseInt(sizeLine.split(";")[0], 16);
          if (isNaN(chunkSize)) {
            throw new Error(`Invalid chunk size in HTTP response: "${sizeLine}"`);
          }

          this.currentChunkSize = chunkSize;

          if (chunkSize === 0) {
            // Terminal 0 chunk reached!
            this.state = "CHUNK_TRAILER";
          } else {
            this.state = "CHUNK_DATA";
          }
        }

        if (this.state === "CHUNK_DATA") {
          if (this.buffer.length < this.currentChunkSize) return; // Wait for full chunk

          const chunk = this.buffer.subarray(0, this.currentChunkSize);
          this.buffer = this.buffer.subarray(this.currentChunkSize);
          this.state = "CHUNK_CRLF";

          this.onData(chunk);
        }

        if (this.state === "CHUNK_CRLF") {
          if (this.buffer.length < 2) return; // Wait for trailing CRLF
          this.buffer = this.buffer.subarray(2);
          this.state = "CHUNK_SIZE";
        }

        if (this.state === "CHUNK_TRAILER") {
          const trailerEnd = this.buffer.indexOf("\r\n");
          if (trailerEnd === -1) return;
          this.buffer = this.buffer.subarray(trailerEnd + 2);
          this.state = "DONE";
          this.onEnd();
          return;
        }

        if (this.state === "RAW_STREAM") {
          if (this.buffer.length > 0) {
            const data = this.buffer;
            this.buffer = Buffer.alloc(0);
            this.onData(data);
          }
          return;
        }
      }
    } catch (err) {
      this.state = "DONE";
      this.onError(err);
    }
  }

  finish() {
    if (this.state === "RAW_STREAM") {
      this.state = "DONE";
      this.onEnd();
    } else if (this.state !== "DONE") {
      this.onError(new Error(`Unexpected EOF while in state ${this.state}`));
    }
  }
}

module.exports = { HttpResponseParser };
