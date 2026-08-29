// SandboxOS client SDK — drive a Sandbox from anywhere.
//
// The Gateway is the whole API, and every capability of the machine is an MCP
// tool behind it. This client is a thin, typed-ish shape over that: one place
// that knows the routes, so a script, a CI job or an agent does not have to.
//
//   import { SandboxClient } from "sandboxos/sdk";
//
//   const sbx = new SandboxClient({ url: "https://sandboxos.dev", slug: "tobias", token });
//   await sbx.fs.write("hello.txt", "hi");
//   const job = await sbx.proc.start("npm run dev", { name: "web" });
//   await sbx.ports.expose(3000, "web");
//   for await (const ev of sbx.assistant.ask("what changed today?")) console.log(ev);
//
// Zero dependencies: global fetch and nothing else.

export class SandboxError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "SandboxError";
    this.status = status;
    this.code = code;
  }
}

export class SandboxClient {
  /**
   * @param {object} o
   * @param {string} o.url    Gateway origin, e.g. https://sandboxos.dev
   * @param {string} o.slug   the machine to drive
   * @param {string} o.token  a machine token (see `sbx token`)
   * @param {typeof fetch} [o.fetch] injectable for tests
   */
  constructor({ url, slug, token, fetch: f = globalThis.fetch }) {
    if (!url) throw new SandboxError("url is required");
    if (!slug) throw new SandboxError("slug is required");
    this.url = String(url).replace(/\/$/, "");
    this.slug = slug;
    this.token = token;
    this._fetch = f;

    this.fs = new FsApi(this);
    this.proc = new ProcApi(this);
    this.ports = new PortsApi(this);
    this.agents = new AgentsApi(this);
    this.secrets = new SecretsApi(this);
    this.assistant = new AssistantApi(this);
  }

  get headers() {
    return {
      "Content-Type": "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  /** Raw HTTP against the Gateway. Paths starting with "/" are absolute. */
  async request(path, { method = "GET", body, headers = {}, raw = false } = {}) {
    const target = path.startsWith("/") ? `${this.url}${path}` : `${this.url}/${this.slug}/${path}`;
    const res = await this._fetch(target, {
      method,
      headers: { ...this.headers, ...headers },
      body: body === undefined ? undefined : (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)),
    });
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) throw new SandboxError(data?.error ?? text.slice(0, 200) ?? res.statusText, { status: res.status });
    return data;
  }

  /** One MCP call. Throws on denial or tool error; returns the result. */
  async call(server, tool, args = {}) {
    const env = await this.request("mcp", { method: "POST", body: { server, tool, args } });
    if (!env.ok) throw new SandboxError(env.error ?? `${server}.${tool} failed`, { code: env.code });
    return env.result;
  }

  /** The tool catalogue this token can actually reach. */
  tools() { return this.call("kernel", "tools", {}); }
  whoami() { return this.call("kernel", "whoami", {}); }
  capabilities() { return this.call("kernel", "capabilities", {}); }
  metrics() { return this.call("metrics", "snapshot", {}); }

  /** Run one Command Central line (shell verbs, `:call`, or `? natural language`). */
  exec(line) { return this.request("exec", { method: "POST", body: { line } }); }

  wake() { return this.request("wake", { method: "POST" }); }
  hibernate() { return this.request("hibernate", { method: "POST" }); }

  audit(opts = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v != null) p.set(k, String(v));
    return this.request(`audit?${p}`);
  }

  /** Live audit events, as an async iterator. */
  async *events({ signal } = {}) {
    const res = await this.request("events", { raw: true, headers: { Accept: "text/event-stream" }, signal });
    yield* sseEvents(res);
  }

  /** Stream a command's output. Yields {type:"stdout"|"stderr"|"done", …}. */
  async *stream(cmd) {
    const res = await this.request("stream", { method: "POST", body: { cmd }, raw: true });
    if (!res.ok) throw new SandboxError(`stream failed: ${res.status}`, { status: res.status });
    yield* sseEvents(res);
  }
}

// ── Sub-APIs ─────────────────────────────────────────────────────────────────

class FsApi {
  constructor(c) { this.c = c; }
  list(path = ".") { return this.c.call("fs", "list", { path }); }
  read(path) { return this.c.call("fs", "read", { path }).then((r) => r.content); }
  write(path, content) { return this.c.call("fs", "write", { path, content }); }
  append(path, content) { return this.c.call("fs", "append", { path, content }); }
  mkdir(path) { return this.c.call("fs", "mkdir", { path }); }
  remove(path, { recursive = false } = {}) { return this.c.call("fs", "remove", { path, recursive }); }
  move(from, to) { return this.c.call("fs", "move", { from, to }); }
  copy(from, to) { return this.c.call("fs", "copy", { from, to }); }
  stat(path) { return this.c.call("fs", "stat", { path }); }
  tree(path = ".", opts = {}) { return this.c.call("fs", "tree", { path, ...opts }); }
  search(query, opts = {}) { return this.c.call("fs", "search", { query, ...opts }); }

  /** Stream a file's bytes out of the Cell (binary-safe, any size). */
  async download(path) {
    const res = await this.c.request(`file?path=${encodeURIComponent(path)}`, { raw: true });
    if (!res.ok) throw new SandboxError(`download failed: ${res.status}`, { status: res.status });
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Stream bytes into the Cell. Accepts a string, Uint8Array or Blob. */
  upload(path, data) {
    return this.c.request(`file?path=${encodeURIComponent(path)}`, {
      method: "PUT", body: data, headers: { "Content-Type": "application/octet-stream" },
    });
  }
}

class ProcApi {
  constructor(c) { this.c = c; }
  exec(cmd, opts = {}) { return this.c.call("proc", "exec", { cmd, ...opts }); }
  list() { return this.c.call("proc", "list", {}); }
  start(cmd, opts = {}) { return this.c.call("proc", "start", { cmd, ...opts }); }
  jobs() { return this.c.call("proc", "jobs", {}).then((r) => r.jobs); }
  logs(id, opts = {}) { return this.c.call("proc", "logs", { id, ...opts }); }
  stop(id, opts = {}) { return this.c.call("proc", "stop", { id, ...opts }); }
  forget(id) { return this.c.call("proc", "forget", { id }); }

  /** Poll a supervised process until it leaves the running state. */
  async wait(id, { intervalMs = 500, timeoutMs = 300_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.logs(id, { tail: 1 });
      if (r.state !== "running") return r;
      if (Date.now() > deadline) throw new SandboxError(`timed out waiting for ${id}`);
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }
}

class PortsApi {
  constructor(c) { this.c = c; }
  list(opts = {}) { return this.c.call("ports", "list", opts).then((r) => r.ports); }
  expose(port, name) { return this.c.call("ports", "expose", { port, name }); }
  unexpose(port) { return this.c.call("ports", "unexpose", { port }); }
  check(port, opts = {}) { return this.c.call("ports", "check", { port, ...opts }); }
  scan() { return this.c.call("ports", "scan", {}).then((r) => r.listening); }
  /** The public URL a browser would use for an exposed port. */
  url(port) { return `${this.c.url}/${this.c.slug}/p/${port}/`; }
}

class AgentsApi {
  constructor(c) { this.c = c; }
  list() { return this.c.call("agents", "list", {}).then((r) => r.agents); }
  get(id) { return this.c.call("agents", "get", { id }); }
  kill(id) { return this.c.call("agents", "kill", { id }); }
  spawn(name, { cmd, prompt, kind = cmd ? "shell" : "ai", patterns = ["proc.exec"], system } = {}) {
    return this.c.call("agents", "spawn", { name, kind, patterns, cmd, prompt, system });
  }
  /** Poll an agent until it finishes. */
  async wait(id, { intervalMs = 700, timeoutMs = 300_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const a = await this.get(id);
      if (a.state !== "queued" && a.state !== "running") return a;
      if (Date.now() > deadline) throw new SandboxError(`timed out waiting for agent ${id}`);
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }
}

class SecretsApi {
  constructor(c) { this.c = c; }
  list() { return this.c.call("secrets", "list", {}).then((r) => r.secrets); }
  put(name, value) { return this.c.call("secrets", "put", { name, value }); }
  remove(name) { return this.c.call("secrets", "remove", { name }); }
  /** Run a command with named secrets injected as env. Values never come back. */
  useInEnv(names, cmd, opts = {}) {
    return this.c.call("secrets", "useInEnv", {
      refs: names.map((n) => (n.startsWith("secret://") ? n : `secret://${n}`)), cmd, ...opts,
    });
  }
}

class AssistantApi {
  constructor(c) { this.c = c; }
  chats() { return this.c.request("chats").then((r) => r.chats); }
  create(title) { return this.c.request("chats", { method: "POST", body: { title } }).then((r) => r.chat); }
  transcript(id) { return this.c.request(`chats/${id}`); }
  remove(id) { return this.c.request(`chats/${id}`, { method: "DELETE" }); }

  /**
   * Ask a question and iterate the turn's events as they arrive:
   * {type:"text"|"tool_call"|"tool_result"|"done"|"error"|"end", …}
   * Starts a new conversation unless `chatId` is given.
   */
  async *ask(input, { chatId } = {}) {
    const id = chatId ?? (await this.create()).id;
    const res = await this.c.request(`chats/${id}/send`, { method: "POST", body: { input }, raw: true });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new SandboxError(err.error ?? `assistant failed: ${res.status}`, { status: res.status });
    }
    for await (const ev of sseEvents(res)) yield { ...ev, chatId: id };
  }

  /** Ask, and resolve with just the final prose. */
  async askText(input, opts) {
    let out = "";
    for await (const ev of this.ask(input, opts)) {
      if (ev.type === "text") out += ev.text;
      if (ev.type === "error") throw new SandboxError(ev.error);
    }
    return out;
  }
}

// ── SSE ──────────────────────────────────────────────────────────────────────

/** Yield parsed `data:` payloads from an SSE response body. */
export async function* sseEvents(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data || data === "[DONE]") continue;
        try { yield JSON.parse(data); } catch { /* keepalive */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
