"use strict";

/**
 * Binary framed byte-stream protocol for Electron <-> Next.js child process.
 * Replicates DeepSeek Harness Desktop's FD 3/4 framing architecture.
 */

const FRAME_MAGIC = 0x44534833; // 'DSH3'
const FRAME_HEADER_BYTES = 13;
const MAX_CONTROL_PAYLOAD_BYTES = 1024 * 1024; // 1 MB
const DESKTOP_PIPE_CHUNK_BYTES = 64 * 1024; // 64 KB

const DESKTOP_REQUEST_PIPE_FD = 3;
const DESKTOP_RESPONSE_PIPE_FD = 4;

const FRAME_TYPE = {
  START: 1,
  DATA: 2,
  END: 3,
  CANCEL: 4,
  ERROR: 4, // in response direction
};

function encodeHeader(type, streamId, payloadLength) {
  const buf = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  buf.writeUInt32BE(FRAME_MAGIC, 0);
  buf.writeUInt8(type, 4);
  buf.writeUInt32BE(streamId, 5);
  buf.writeUInt32BE(payloadLength, 9);
  return buf;
}

// ---------------------------------------------------------------------------
// Request Encoders (Main -> Child, over FD 3)
// ---------------------------------------------------------------------------
function encodeRequestStart(streamId, meta) {
  const payload = Buffer.from(JSON.stringify(meta), "utf8");
  return Buffer.concat([encodeHeader(FRAME_TYPE.START, streamId, payload.length), payload]);
}

function encodeRequestData(streamId, data) {
  return Buffer.concat([encodeHeader(FRAME_TYPE.DATA, streamId, data.length), data]);
}

function encodeRequestEnd(streamId) {
  return encodeHeader(FRAME_TYPE.END, streamId, 0);
}

function encodeRequestCancel(streamId) {
  return encodeHeader(FRAME_TYPE.CANCEL, streamId, 0);
}

// ---------------------------------------------------------------------------
// Response Encoders (Child -> Main, over FD 4)
// ---------------------------------------------------------------------------
function encodeResponseStart(streamId, meta) {
  const payload = Buffer.from(JSON.stringify(meta), "utf8");
  return Buffer.concat([encodeHeader(FRAME_TYPE.START, streamId, payload.length), payload]);
}

function encodeResponseData(streamId, data) {
  return Buffer.concat([encodeHeader(FRAME_TYPE.DATA, streamId, data.length), data]);
}

function encodeResponseEnd(streamId) {
  return encodeHeader(FRAME_TYPE.END, streamId, 0);
}

function encodeResponseError(streamId, message) {
  const payload = Buffer.from(message || "Internal Host Error", "utf8");
  return Buffer.concat([encodeHeader(FRAME_TYPE.ERROR, streamId, payload.length), payload]);
}

// ---------------------------------------------------------------------------
// Frame Stream Decoder (handles chunking across arbitrary read boundaries)
// ---------------------------------------------------------------------------
class FrameDecoder {
  constructor(isRequest = true) {
    this.isRequest = isRequest;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];

    while (this.buffer.length >= FRAME_HEADER_BYTES) {
      const magic = this.buffer.readUInt32BE(0);
      if (magic !== FRAME_MAGIC) {
        throw new Error(`Invalid frame magic 0x${magic.toString(16)} (expected 0x${FRAME_MAGIC.toString(16)})`);
      }
      const type = this.buffer.readUInt8(4);
      const streamId = this.buffer.readUInt32BE(5);
      const payloadLength = this.buffer.readUInt32BE(9);

      if (payloadLength > MAX_CONTROL_PAYLOAD_BYTES && (type === FRAME_TYPE.START || type === FRAME_TYPE.ERROR)) {
        throw new Error(`Frame payload exceeds maximum size (${payloadLength} bytes)`);
      }

      const totalFrameBytes = FRAME_HEADER_BYTES + payloadLength;
      if (this.buffer.length < totalFrameBytes) {
        // Wait for more data
        break;
      }

      const payload = this.buffer.subarray(FRAME_HEADER_BYTES, totalFrameBytes);
      this.buffer = this.buffer.subarray(totalFrameBytes);

      frames.push(this.decodeFrame(type, streamId, payload));
    }

    return frames;
  }

  decodeFrame(type, streamId, payload) {
    if (type === FRAME_TYPE.START) {
      const meta = JSON.parse(payload.toString("utf8"));
      return { type: "start", streamId, meta };
    }
    if (type === FRAME_TYPE.DATA) {
      return { type: "data", streamId, data: payload };
    }
    if (type === FRAME_TYPE.END) {
      return { type: "end", streamId };
    }
    if (type === FRAME_TYPE.CANCEL) {
      return { type: this.isRequest ? "cancel" : "error", streamId, message: payload.toString("utf8") };
    }
    throw new Error(`Unknown frame type: ${type}`);
  }

  finish() {
    if (this.buffer.length > 0) {
      throw new Error(`Truncated frame data at end of stream (${this.buffer.length} bytes remaining)`);
    }
  }
}

module.exports = {
  FRAME_MAGIC,
  FRAME_HEADER_BYTES,
  DESKTOP_PIPE_CHUNK_BYTES,
  DESKTOP_REQUEST_PIPE_FD,
  DESKTOP_RESPONSE_PIPE_FD,
  encodeRequestStart,
  encodeRequestData,
  encodeRequestEnd,
  encodeRequestCancel,
  encodeResponseStart,
  encodeResponseData,
  encodeResponseEnd,
  encodeResponseError,
  FrameDecoder,
};
