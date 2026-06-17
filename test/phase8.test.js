// Phase 8: WebSocket PTY — shell bridge, frame codec, gateway upgrade handler.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, mintMachineToken } from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";
import { upgradeWebSocket } from "../packages/pty/src/index.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox, kernel, held, machineToken;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  const m = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p8-test" });
  machineToken = m.token;
});
test.after(() => closeDb());

// ─── helpers ──────────────────────────────────────────────────────────────────

const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Open a raw TCP socket, send the HTTP upgrade handshake, return a WsTestConn. */
async function wsConnect(port, path, { expectCode = 101 } = {}) {
  const key = crypto.randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Connection: Upgrade\r\n` +
        `Upgrade: websocket\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      socket.off("data", onData);
      const headerText = buf.slice(0, sep).toString("utf8");
      const statusLine = headerText.split("\r\n")[0];
      const code = parseInt(statusLine.split(" ")[1]);
      if (code !== expectCode) {
        socket.destroy();
        if (code === 200 || code >= 400) resolve(null); // auth fail → socket closed quickly
        else reject(new Error(`Expected ${expectCode}, got ${statusLine}`));
        return;
      }
      const remaining = buf.slice(sep + 4);
      resolve(new WsTestConn(socket, remaining));
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("close", () => resolve(null)); // server rejected → closed without response
    setTimeout(() => { socket.destroy(); reject(new Error("ws timeout")); }, 4000);
  });
}

class WsTestConn {
  constructor(socket, initial = Buffer.alloc(0)) {
    this.socket    = socket;
    this._buf      = initial;
    this.received  = ""; // accumulated text from all frames
    this._waiters  = [];
    socket.on("data", (c) => { this._buf = Buffer.concat([this._buf, c]); this._drain(); });
    socket.on("close", () => {
      for (const w of this._waiters) { clearTimeout(w.timer); w.reject(new Error("ws closed")); }
      this._waiters = [];
    });
    // process any bytes already in `initial`
    if (initial.length) this._drain();
  }

  _drain() {
    for (;;) {
      const f = this._readFrame();
      if (!f) break;
      if (f.opcode === 0x8) { this.socket.destroy(); break; }
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        this.received += f.payload.toString("utf8");
        this._check();
      }
    }
  }

  _readFrame() {
    const b = this._buf;
    if (b.length < 2) return null;
    const opcode  = b[0] & 0x0f;
    let payLen    = b[1] & 0x7f;
    let offset    = 2;
    if (payLen === 126) {
      if (b.length < 4) return null;
      payLen = b.readUInt16BE(2); offset = 4;
    } else if (payLen === 127) {
      if (b.length < 10) return null;
      payLen = Number(b.readBigUInt64BE(2)); offset = 10;
    }
    if (b.length < offset + payLen) return null;
    const payload = Buffer.from(b.slice(offset, offset + payLen));
    this._buf = b.slice(offset + payLen);
    return { opcode, payload };
  }

  _check() {
    this._waiters = this._waiters.filter((w) => {
      const hit = typeof w.pattern === "string"
        ? this.received.includes(w.pattern)
        : w.pattern.test(this.received);
      if (hit) { clearTimeout(w.timer); w.resolve(this.received); }
      return !hit;
    });
  }

  /** Resolve when `pattern` appears in accumulated output, or reject on timeout. */
  waitFor(pattern, timeoutMs = 4000) {
    const hit = typeof pattern === "string"
      ? this.received.includes(pattern)
      : pattern.test(this.received);
    if (hit) return Promise.resolve(this.received);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`waitFor("${pattern}") timeout — got: ${JSON.stringify(this.received)}`));
      }, timeoutMs);
      this._waiters.push({ pattern, resolve, reject, timer });
    });
  }

  /** Send raw bytes as a masked binary WebSocket frame (client→server). */
  send(data) {
    const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    const mk = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mk[i % 4];
    const len = payload.length;
    let hdr;
    if (len <= 125)      hdr = Buffer.from([0x82, 0x80 | len]);
    else if (len <= 65535) { hdr = Buffer.alloc(4); hdr[0] = 0x82; hdr[1] = 0xfe; hdr.writeUInt16BE(len, 2); }
    this.socket.write(Buffer.concat([hdr, mk, masked]));
  }

  close() {
    // Masked empty close frame.
    this.socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
    setTimeout(() => this.socket.destroy(), 100);
  }
}

function withServer(fn) {
  const srv = createServer();
  return new Promise((resolve, reject) => {
    srv.listen(0, "127.0.0.1", async () => {
      const port = srv.address().port;
      try { await fn(port); resolve(); }
      catch (e) { reject(e); }
      finally { srv.close(); }
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. upgradeWebSocket unit tests
// ═════════════════════════════════════════════════════════════════════════════

test("upgradeWebSocket returns null when Sec-WebSocket-Key header is missing", (t) => {
  const destroyed = [];
  const fakeSocket = { destroy() { destroyed.push(true); }, write() {} };
  const result = upgradeWebSocket({ headers: {} }, fakeSocket, Buffer.alloc(0));
  assert.equal(result, null);
  assert.ok(destroyed.length > 0, "socket should be destroyed");
});

test("upgradeWebSocket writes a 101 Switching Protocols response", () => {
  const written = [];
  const fakeSocket = {
    destroy() {},
    write(data) { written.push(data); },
    on() { return this; },
    unshift() {},
  };
  const key = crypto.randomBytes(16).toString("base64");
  const conn = upgradeWebSocket({ headers: { "sec-websocket-key": key } }, fakeSocket, Buffer.alloc(0));
  assert.ok(conn, "should return a WsConn");
  const response = written[0];
  assert.ok(response.includes("101 Switching Protocols"), "missing 101");
  assert.ok(response.includes("Upgrade: websocket"), "missing Upgrade header");
  const expectedAccept = crypto.createHash("sha1").update(key + MAGIC).digest("base64");
  assert.ok(response.includes(expectedAccept), "wrong Sec-WebSocket-Accept");
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Gateway PTY endpoint — connection lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test("GET /:slug/pty without auth closes the socket", async () => {
  await withServer(async (port) => {
    const conn = await wsConnect(port, `/${sandbox.slug}/pty`);
    assert.equal(conn, null, "unauthenticated connection should be rejected");
  });
});

test("GET /:slug/pty with invalid slug closes the socket", async () => {
  await withServer(async (port) => {
    const conn = await wsConnect(port, `/no-such-slug/pty?token=${machineToken}`);
    assert.equal(conn, null, "unknown slug should be rejected");
  });
});

test("GET /:slug/pty on a non-pty action closes the socket", async () => {
  await withServer(async (port) => {
    const conn = await wsConnect(port, `/${sandbox.slug}/not-pty?token=${machineToken}`);
    assert.equal(conn, null, "non-pty WebSocket path should be rejected");
  });
});

test("GET /:slug/pty with a valid machine token upgrades successfully (101)", async () => {
  await withServer(async (port) => {
    const conn = await wsConnect(port, `/${sandbox.slug}/pty?token=${machineToken}`);
    assert.ok(conn, "valid auth should produce a 101 upgrade");
    conn.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Shell I/O through the PTY endpoint
// ═════════════════════════════════════════════════════════════════════════════

test("shell echoes command output back over WebSocket", async () => {
  await withServer(async (port) => {
    const conn = await wsConnect(port, `/${sandbox.slug}/pty?token=${machineToken}`);
    assert.ok(conn, "expected 101");
    // Give the shell a moment to start, then send a command.
    await new Promise((r) => setTimeout(r, 150));
    conn.send("printf 'PTY_ROUND_TRIP\\n'\n");
    await conn.waitFor("PTY_ROUND_TRIP", 5000);
    assert.ok(conn.received.includes("PTY_ROUND_TRIP"), `output: ${JSON.stringify(conn.received)}`);
    conn.close();
  });
});

test("shell runs multiple sequential commands", async () => {
  await withServer(async (port) => {
    const conn = await wsConnect(port, `/${sandbox.slug}/pty?token=${machineToken}`);
    assert.ok(conn);
    await new Promise((r) => setTimeout(r, 150));
    conn.send("printf 'FIRST\\n'\n");
    conn.send("printf 'SECOND\\n'\n");
    await conn.waitFor("SECOND", 5000);
    assert.ok(conn.received.includes("FIRST"), "FIRST missing");
    assert.ok(conn.received.includes("SECOND"), "SECOND missing");
    conn.close();
  });
});

test("shell send exit terminates the shell and server closes the WS", async () => {
  await withServer(async (port) => {
    const conn = await wsConnect(port, `/${sandbox.slug}/pty?token=${machineToken}`);
    assert.ok(conn);
    await new Promise((r) => setTimeout(r, 150));
    conn.send("exit 0\n");
    // After the shell exits, the gateway should close the WebSocket.
    await new Promise((r, j) => {
      const t = setTimeout(() => j(new Error("close event timeout")), 3000);
      conn.socket.on("close", () => { clearTimeout(t); r(); });
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Cell backend execInteractive
// ═════════════════════════════════════════════════════════════════════════════

test("LocalBackend.execInteractive exists and returns a shell handle", async () => {
  assert.equal(typeof kernel.cell.execInteractive, "function", "execInteractive must exist");
  const chunks = [];
  await new Promise((resolve) => {
    const handle = kernel.cell.execInteractive(
      (data) => chunks.push(Buffer.from(data).toString()),
      resolve,
      {},
    );
    assert.equal(typeof handle.write, "function");
    assert.equal(typeof handle.kill, "function");
    // Send a command and let the shell exit.
    setTimeout(() => { handle.write("printf 'BACKEND_OK\\n' && exit 0\n"); }, 100);
  });
  assert.ok(chunks.some((c) => c.includes("BACKEND_OK")), `chunks: ${JSON.stringify(chunks)}`);
});

test("LocalBackend.execInteractive handle.kill terminates the shell", async () => {
  await new Promise((resolve) => {
    const handle = kernel.cell.execInteractive(() => {}, resolve, {});
    setTimeout(() => handle.kill(), 200);
  });
  // If we got here the onClose callback was called — pass.
});
