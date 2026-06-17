// Minimal WebSocket upgrade handler and frame codec — no external deps.
//
// Implements enough of RFC 6455 for a bidirectional shell bridge:
//   text (0x1) + binary (0x2) data frames, ping/pong, close.
// Client frames are always masked; server frames are never masked.

import { EventEmitter } from "node:events";
import crypto from "node:crypto";

const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Complete the WebSocket handshake on a raw Node socket and return a WsConn.
 * Returns null (and destroys the socket) if the request headers are invalid.
 */
export function upgradeWebSocket(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash("sha1").update(key + MAGIC).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    "\r\n",
  );
  // Re-inject any bytes that arrived before the data listener was set.
  if (head?.length) socket.unshift(head);
  return new WsConn(socket);
}

/** Live WebSocket connection — emits 'message' (Buffer) and 'close'. */
export class WsConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this._buf = Buffer.alloc(0);
    socket.on("data", (c) => { this._buf = Buffer.concat([this._buf, c]); this._drain(); });
    socket.on("close", () => this.emit("close"));
    socket.on("error", () => this.emit("close"));
  }

  _drain() {
    for (;;) {
      const f = this._parse();
      if (!f) break;
      if (f.opcode === 0x8) { this.emit("close"); break; }
      if (f.opcode === 0x9) { this._write(0xa, f.payload); continue; } // pong
      if (f.opcode === 0x1 || f.opcode === 0x2) this.emit("message", f.payload);
    }
  }

  _parse() {
    const b = this._buf;
    if (b.length < 2) return null;
    const opcode  = b[0] & 0x0f;
    const masked  = !!(b[1] & 0x80);
    let payLen    = b[1] & 0x7f;
    let offset    = 2;
    if (payLen === 126) {
      if (b.length < 4) return null;
      payLen = b.readUInt16BE(2); offset = 4;
    } else if (payLen === 127) {
      if (b.length < 10) return null;
      payLen = Number(b.readBigUInt64BE(2)); offset = 10;
    }
    const need = offset + (masked ? 4 : 0) + payLen;
    if (b.length < need) return null;
    let payload;
    if (masked) {
      const mk = b.slice(offset, offset + 4);
      payload = Buffer.from(b.slice(offset + 4, offset + 4 + payLen));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i % 4];
      this._buf = b.slice(offset + 4 + payLen);
    } else {
      payload = Buffer.from(b.slice(offset, offset + payLen));
      this._buf = b.slice(offset + payLen);
    }
    return { opcode, payload };
  }

  _write(opcode, payload) {
    const n = payload.length;
    let hdr;
    if (n <= 125)      hdr = Buffer.from([0x80 | opcode, n]);
    else if (n <= 65535) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | opcode; hdr[1] = 126; hdr.writeUInt16BE(n, 2); }
    else               { hdr = Buffer.alloc(10); hdr[0] = 0x80 | opcode; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(n), 2); }
    try { this.socket.write(Buffer.concat([hdr, payload])); } catch { /* socket gone */ }
  }

  /** Send raw bytes (binary frame). */
  send(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this._write(0x2, buf);
  }

  close() {
    try { this._write(0x8, Buffer.alloc(0)); this.socket.destroy(); } catch {}
  }
}
