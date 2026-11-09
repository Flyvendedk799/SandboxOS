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

/**
 * Meaningful remediation hints for common SandboxOS failure modes.
 */
function resolveRemediation({ code, message = "", server, tool, status }) {
  if (code === "denied" || message.includes("denied")) {
    if (server && tool) return `Grant the '${server}.${tool}' capability pattern to your machine token or request access.`;
    return "Check capability patterns on your token or request required permissions.";
  }
  if (code === "unknown_tool" || message.includes("unknown tool")) {
    if (server && tool) return `Verify that tool '${tool}' exists on server '${server}' and that '${server}' is enabled in the manifest (see tools catalog).`;
    return "Verify the server and tool name in the Kernel tools catalog.";
  }
  if (code === "not_found" || status === 404 || message.includes("not found")) {
    return "Check that the requested path, resource, or identifier exists in the sandbox.";
  }
  if (code === "unauthorized" || status === 401) {
    return "Authenticate with valid credentials or mint a new machine token via 'sbx login'.";
  }
  if (code === "quota_exceeded" || status === 429 || message.includes("quota")) {
    return "Request a quota increase or terminate unused sandboxes/agents.";
  }
  if (code === "bad_request" || status === 400 || message.includes("bad_request") || message.includes("malformed")) {
    return "Check request arguments against the tool's input schema.";
  }
  if (code === "unsupported_host") {
    return "Switch to a supported cell execution backend or check host environment configuration.";
  }
  if (code === "stale_rev") {
    return "Refresh desktop state and retry the update with the latest revision.";
  }
  if (code === "timeout") {
    return "The operation exceeded its deadline; check process/agent logs or increase timeoutMs.";
  }
  return "Review server logs or audit events via 'sbx audit' to diagnose the issue.";
}

export class SandboxError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number} [options.status] HTTP status code
   * @param {string} [options.code] Error code (e.g. 'denied', 'unknown_tool', 'not_found')
   * @param {string} [options.server] MCP server name
   * @param {string} [options.tool] MCP tool name
   * @param {string} [options.remediation] Practical guidance for resolving the error
   */
  constructor(message, { status, code, server, tool, remediation } = {}) {
    super(message);
    this.name = "SandboxError";
    this.status = status;
    this.server = server;
    this.tool = tool;

    this.code = code || (
      status === 401 ? "unauthorized" :
      status === 403 ? "denied" :
      status === 404 ? "not_found" :
      status === 429 ? "quota_exceeded" :
      message?.startsWith("denied:") ? "denied" :
      message?.startsWith("unknown tool:") ? "unknown_tool" :
      "error"
    );

    this.remediation = remediation || resolveRemediation({
      code: this.code,
      message,
      server,
      tool,
      status,
    });
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      ...(this.status ? { status: this.status } : {}),
      ...(this.server ? { server: this.server } : {}),
      ...(this.tool ? { tool: this.tool } : {}),
      ...(this.remediation ? { remediation: this.remediation } : {}),
    };
  }
}

/**
 * Unwraps an error payload from a response body or error event into a structured SandboxError.
 * Handles string errors, error objects ({ message, code, remediation }), and status defaults.
 */
function buildSandboxError(data, fallbackMessage = "error", { status, server, tool, code: fallbackCode, remediation: fallbackRemediation } = {}) {
  const err = data?.error !== undefined ? data.error : data;
  if (err instanceof SandboxError) return err;

  if (typeof err === "object" && err !== null) {
    const message = err.message ?? err.error ?? fallbackMessage;
    const code = err.code ?? data?.code ?? fallbackCode;
    const remediation = err.remediation ?? data?.remediation ?? fallbackRemediation;
    const s = err.server ?? data?.server ?? server;
    const t = err.tool ?? data?.tool ?? tool;
    const st = err.status ?? data?.status ?? status;
    return new SandboxError(String(message), { status: st, code, server: s, tool: t, remediation });
  }

  const message = typeof err === "string" && err ? err : fallbackMessage;
  const code = data?.code ?? fallbackCode;
  const remediation = data?.remediation ?? fallbackRemediation;
  return new SandboxError(message, { status, code, server, tool, remediation });
}

export class SandboxClient {
  /**
   * @param {object} o
   * @param {string} o.url    Gateway origin, e.g. https://sandboxos.dev
   * @param {string} o.slug   the machine to drive
   * @param {string} [o.token]  a machine token (see `sbx token`)
   * @param {typeof fetch} [o.fetch] injectable for tests
   */
  constructor({ url, slug, token, fetch: f = globalThis.fetch } = {}) {
    if (!url) throw new SandboxError("url is required", { code: "invalid_argument", remediation: "Provide a Gateway origin URL (e.g. http://127.0.0.1:3939)" });
    if (!slug) throw new SandboxError("slug is required", { code: "invalid_argument", remediation: "Provide a sandbox slug to connect to" });
    this.url = String(url).replace(/\/$/, "");
    this.slug = slug;
    this.token = token;
    this._fetch = f;

    this.fs = new FsApi(this);
    this.proc = new ProcApi(this);
    this.ports = new PortsApi(this);
    this.agents = new AgentsApi(this);
    this.secrets = new SecretsApi(this);
    this.desktop = new DesktopApi(this);
    this.assistant = new AssistantApi(this);
    this.tokens = new TokensApi(this);
    this.tide = new TideApi(this);
    this.access = new AccessApi(this);
    this.sandboxes = new SandboxesApi(this);
    this.quota = new QuotaApi(this);
  }

  get headers() {
    return {
      "Content-Type": "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  /** Raw HTTP against the Gateway. Paths starting with "/" are absolute. */
  async request(path, { method = "GET", body, headers = {}, raw = false, signal } = {}) {
    const target = path.startsWith("/") ? `${this.url}${path}` : `${this.url}/${this.slug}/${path}`;
    const res = await this._fetch(target, {
      method,
      headers: { ...this.headers, ...headers },
      body: body === undefined ? undefined : (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)),
      signal,
    });
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      throw buildSandboxError(data, text.slice(0, 200) || res.statusText, { status: res.status });
    }
    return data;
  }

  /** One MCP call. Throws on denial or tool error; returns the result. */
  async call(server, tool, args = {}) {
    const env = await this.request("mcp", { method: "POST", body: { server, tool, args } });
    if (!env.ok) {
      throw buildSandboxError(env, `${server}.${tool} failed`, { server, tool });
    }
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
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw buildSandboxError(data, `stream failed: ${res.status}`, { status: res.status });
    }
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
  rm(path, opts) { return this.remove(path, opts); }
  move(from, to) { return this.c.call("fs", "move", { from, to }); }
  mv(from, to) { return this.move(from, to); }
  copy(from, to) { return this.c.call("fs", "copy", { from, to }); }
  cp(from, to) { return this.copy(from, to); }
  stat(path) { return this.c.call("fs", "stat", { path }); }
  tree(path = ".", opts = {}) { return this.c.call("fs", "tree", { path, ...opts }); }
  search(query, opts = {}) { return this.c.call("fs", "search", { query, ...opts }); }

  /**
   * Read binary file content as a plain Uint8Array.
   * @param {string} path Remote file path
   * @param {object} [opts] Options (e.g. maxBytes)
   * @returns {Promise<Uint8Array>}
   */
  async readBytes(path, opts = {}) {
    const res = await this.c.call("fs", "readBytes", { path, ...opts });
    const b64 = res.base64 || "";
    if (typeof Buffer !== "undefined") {
      const b = Buffer.from(b64, "base64");
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    }
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  /**
   * Write binary file content.
   * @param {string} path Remote file path
   * @param {Uint8Array|Buffer|ArrayBuffer|string} data Binary bytes, or base64-encoded string
   */
  writeBytes(path, data) {
    let base64;
    if (typeof data === "string") {
      base64 = data;
    } else if (typeof Buffer !== "undefined" && (Buffer.isBuffer(data) || data instanceof Uint8Array)) {
      base64 = Buffer.from(data).toString("base64");
    } else {
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      let bin = "";
      for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      base64 = btoa(bin);
    }
    return this.c.call("fs", "writeBytes", { path, base64 });
  }

  /** Stream a file's bytes out of the Cell (binary-safe, any size). */
  async download(path) {
    const res = await this.c.request(`file?path=${encodeURIComponent(path)}`, { raw: true });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const code = res.status === 404 ? "not_found" : res.status === 403 ? "denied" : "download_failed";
      throw buildSandboxError(data, `download failed: ${res.status}`, { status: res.status, code });
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Stream bytes into the Cell. Accepts a string, Uint8Array or Buffer. */
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
  sessions() { return this.c.call("proc", "sessions", {}).then((r) => r.sessions); }
  sessionRename(id, name) { return this.c.call("proc", "sessionRename", { id, name }).then((r) => r.session); }
  sessionKill(id) { return this.c.call("proc", "sessionKill", { id }); }
  signal(pid, signal = "TERM") { return this.c.call("proc", "signal", { pid: Number(pid), signal }); }

  /** Poll a supervised process until it leaves the running state. */
  async wait(id, { intervalMs = 500, timeoutMs = 300_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.logs(id, { tail: 1 });
      if (r.state !== "running") return r;
      if (Date.now() > deadline) {
        throw new SandboxError(`timed out waiting for process ${id}`, {
          code: "timeout", remediation: "Check process logs using sbx.proc.logs(id) or increase timeoutMs.",
        });
      }
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }
}

class PortsApi {
  constructor(c) { this.c = c; }
  list(opts = {}) { return this.c.call("ports", "list", opts).then((r) => r.ports); }
  expose(port, nameOrOpts) {
    const args = typeof nameOrOpts === "string"
      ? { port: Number(port), name: nameOrOpts }
      : { port: Number(port), ...nameOrOpts };
    return this.c.call("ports", "expose", args);
  }
  unexpose(port) { return this.c.call("ports", "unexpose", { port: Number(port) }); }
  check(port, opts = {}) { return this.c.call("ports", "check", { port: Number(port), ...opts }); }
  scan() { return this.c.call("ports", "scan", {}).then((r) => r.listening); }
  /** The public URL a browser would use for an exposed port. */
  url(port) { return `${this.c.url}/${this.c.slug}/p/${port}/`; }
}

class AgentsApi {
  constructor(c) { this.c = c; }
  list(opts = {}) { return this.c.call("agents", "list", opts).then((r) => r.agents); }
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
      if (Date.now() > deadline) {
        throw new SandboxError(`timed out waiting for agent ${id}`, {
          code: "timeout", remediation: "Inspect agent details via sbx.agents.get(id) or terminate it.",
        });
      }
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  /** Live audit events of an agent as an async iterator. */
  async *events(id, { signal } = {}) {
    const res = await this.c.request(`agents/${id}/events`, { raw: true, headers: { Accept: "text/event-stream" }, signal });
    yield* sseEvents(res);
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

/** The OS itself. Everything here is a `desktop.*` call, which is the same door
 *  the desktop's own front end and any agent use — there is no other one. */
class DesktopApi {
  constructor(c) { this.c = c; }

  /** Document + resolved theme/motion + the app, widget, theme and distro catalogs. */
  get() { return this.c.call("desktop", "get", {}); }
  state() { return this.c.call("desktop", "state", {}).then((r) => r.doc); }
  patch(patch, opts = {}) { return this.c.call("desktop", "patch", { patch, ...opts }); }
  set(doc, opts = {}) { return this.c.call("desktop", "set", { doc, ...opts }); }
  rename(name) { return this.c.call("desktop", "rename", { name }); }

  open(app, opts = {}) { return this.c.call("desktop", "open", { app, ...opts }).then((r) => r.window); }
  close(id) { return this.c.call("desktop", "close", { id }); }
  focus(id) { return this.c.call("desktop", "focus", { id }); }
  move(id, x, y) { return this.c.call("desktop", "move", { id, x, y }); }
  resize(id, w, h) { return this.c.call("desktop", "resize", { id, w, h }); }
  windowSet(id, opts = {}) { return this.c.call("desktop", "windowSet", { id, ...opts }); }
  arrange(preset, opts = {}) { return this.c.call("desktop", "arrange", { preset, ...opts }); }
  layout(mode, opts = {}) { return this.c.call("desktop", "layoutSet", { mode, ...opts }); }
  /** Tiling: rebuild a workspace's tree from a preset (master-stack, columns, rows, grid). */
  tile(preset, opts = {}) { return this.c.call("desktop", "layoutSet", { preset, ...opts }); }
  /** Tiling: move the sash between two windows, flip a split, or swap two leaves. */
  tileSet(id, opts = {}) { return this.c.call("desktop", "tile", { id, ...opts }); }
  /** The desktop as a short textual map — read it before rearranging a machine you cannot see. */
  summary() { return this.c.call("desktop", "summarize", {}).then((r) => r.map); }
  /** A semantic screenshot: SVG silhouettes of windows and widgets in the theme's colours. */
  silhouette(opts = {}) { return this.c.call("desktop", "silhouette", opts).then((r) => r.svg); }
  snap(id, region, viewport) { return this.c.call("desktop", "snap", { id, region, ...(viewport ? { viewport } : {}) }); }
  cycleFocus(direction = "next") { return this.c.call("desktop", "cycleFocus", { direction }); }
  showDesktop(restore = false) { return this.c.call("desktop", "minimizeAll", { restore }); }
  /** Which app opens a file extension. Pass app=null to clear. */
  associate(ext, app) { return this.c.call("desktop", "associate", { ext, app }); }
  workspaceSwitch(n) { return this.c.call("desktop", "workspaceSwitch", { n: Number(n) }); }

  widgets() { return this.c.call("desktop", "widgetList", {}).then((r) => r.widgets); }
  addWidget(kind, opts = {}) { return this.c.call("desktop", "widgetAdd", { kind, ...opts }).then((r) => r.widget); }
  removeWidget(id) { return this.c.call("desktop", "widgetRemove", { id }); }

  theme(theme, tokens) { return this.c.call("desktop", "themeSet", { theme, ...(tokens ? { tokens } : {}) }); }
  themeDefine(def) { return this.c.call("desktop", "themeDefine", def); }
  themeRemove(key) { return this.c.call("desktop", "themeRemove", { key }); }
  wallpaperSet(opts = {}) { return this.c.call("desktop", "wallpaperSet", opts); }
  animation(preset) { return this.c.call("desktop", "animationSet", { preset }); }
  notify(title, body, kind = "info") { return this.c.call("desktop", "notify", { title, body, kind }); }

  /** Define a custom app and write its source — how an agent builds UI. */
  apps() { return this.c.call("desktop", "appList", {}).then((r) => r.apps); }
  defineApp(def) { return this.c.call("desktop", "appDefine", def).then((r) => r.app); }
  removeApp(id, opts = {}) { return this.c.call("desktop", "appRemove", { id, ...opts }); }
  /** Switch an app's tool face on or off (its server registers or deregisters). */
  appTools(id, enabled) { return this.c.call("desktop", "appDefine", { id, mcp: { enabled } }).then((r) => r.server); }
  appFiles(id) { return this.c.call("desktop", "appFiles", { id }).then((r) => r.files); }
  readApp(id, path) { return this.c.call("desktop", "appRead", { id, path }).then((r) => r.content); }
  writeApp(id, path, content) { return this.c.call("desktop", "appWrite", { id, path, content }); }

  /** Undo. Every desktop change is a revision. */
  history(opts = {}) { return this.c.call("desktop", "history", opts).then((r) => r.revisions); }
  /** What a revision changed against the current document. */
  diff(rev) { return this.c.call("desktop", "history", { rev }).then((r) => r.diff); }
  revert(rev, opts = {}) { return this.c.call("desktop", "revert", { rev, ...opts }); }

  /** The gallery: seeds, your tenant's distros, and every public one. */
  distros(opts = {}) { return this.c.call("desktop", "distroList", opts).then((r) => r.distros); }
  publish(name, description, opts = {}) { return this.c.call("desktop", "distroPublish", { name, description, replace: true, ...opts }); }
  /** Who can see a distro you published: private, tenant or public. */
  visibility(name, visibility) { return this.c.call("desktop", "distroSet", { name, visibility }); }
  fork(idOrName, opts = {}) { return this.c.call("desktop", "distroFork", { id: idOrName, ...opts }); }
  export() { return this.c.call("desktop", "distroExport", {}).then((r) => r.payload); }
  import(payload, name) { return this.c.call("desktop", "distroImport", { payload, ...(name ? { name } : {}) }); }

  /** Checkpoints: durable named desktop snapshots. */
  checkpoint(name, opts = {}) { return this.c.call("desktop", "checkpoint", { name, ...opts }); }
  checkpoints() { return this.c.call("desktop", "checkpoints", {}); }
  checkpointRestore(id) { return this.c.call("desktop", "checkpointRestore", { id }); }
  checkpointRemove(id) { return this.c.call("desktop", "checkpointRemove", { id }); }

  /** Proposals: propose desktop changes for review instead of applying immediately. */
  propose(ops, opts = {}) { return this.c.call("desktop", "propose", { ops, ...opts }).then((r) => r.proposal); }
  applyProposal(id) { return this.c.call("desktop", "applyProposal", { id }); }
  discardProposal(id) { return this.c.call("desktop", "discardProposal", { id }); }
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
      throw buildSandboxError(err, `assistant failed: ${res.status}`, { status: res.status });
    }
    for await (const ev of sseEvents(res)) yield { ...ev, chatId: id };
  }

  /** Ask, and resolve with just the final prose. */
  async askText(input, opts) {
    let out = "";
    for await (const ev of this.ask(input, opts)) {
      if (ev.type === "text") out += ev.text;
      if (ev.type === "error") throw buildSandboxError(ev.error, "assistant error");
    }
    return out;
  }
}

class TokensApi {
  constructor(c) { this.c = c; }
  list() { return this.c.request("tokens").then((r) => r.tokens); }
  mint(patterns, { label = "sdk" } = {}) {
    return this.c.request("tokens", { method: "POST", body: { patterns, label } });
  }
  revoke(principalId) {
    return this.c.request(`tokens/${encodeURIComponent(principalId)}`, { method: "DELETE" });
  }
}

class TideApi {
  constructor(c) { this.c = c; }
  init(workspace, path) { return this.c.call("tide", "init", { workspace, path }); }
  listWorkspaces() { return this.c.call("tide", "listWorkspaces", {}).then((r) => r.workspaces); }
  status(workspace) { return this.c.call("tide", "status", { workspace }).then((r) => r.changes); }
  mark(workspace, opts = {}) { return this.c.call("tide", "mark", { workspace, ...opts }); }
  log(workspace, limit = 50) { return this.c.call("tide", "log", { workspace, limit }).then((r) => r.marks); }
  diff(workspace, from, to) { return this.c.call("tide", "diff", { workspace, from, to }).then((r) => r.changes); }
  checkout(workspace, ref) { return this.c.call("tide", "checkout", { workspace, ref }); }
  refs(workspace) { return this.c.call("tide", "refs", { workspace }).then((r) => r.head); }
  putState(workspace, type, data) { return this.c.call("tide", "putState", { workspace, type, data }); }
  getState(workspace, type) { return this.c.call("tide", "getState", { workspace, type }).then((r) => r.data); }
  listStates(workspace) { return this.c.call("tide", "listStates", { workspace }).then((r) => r.types); }
  fetchObjects(workspace, have = []) { return this.c.call("tide", "fetchObjects", { workspace, have }); }
  receiveObjects(workspace, head, objects, path) {
    return this.c.call("tide", "receiveObjects", { workspace, head, objects, ...(path ? { path } : {}) });
  }
}

class AccessApi {
  constructor(c) { this.c = c; }
  list() { return this.c.request("access").then((r) => r.access); }
  share(username, patterns = ["*"]) {
    return this.c.request("access", { method: "POST", body: { username, patterns } });
  }
  revoke(principalId) {
    return this.c.request(`access/${encodeURIComponent(principalId)}`, { method: "DELETE" });
  }
}

class SandboxesApi {
  constructor(c) { this.c = c; }
  list() { return this.c.request("/api/sandboxes").then((r) => r.sandboxes); }
  create(slug, opts = {}) {
    return this.c.request("/api/sandboxes", { method: "POST", body: { slug, name: opts.name ?? slug, ...opts } });
  }
  delete(slug) { return this.c.request(`/api/sandboxes/${slug}`, { method: "DELETE" }); }
  snapshot(slug, name) {
    return this.c.request(`/api/sandboxes/${slug}/snapshot`, { method: "POST", body: { name } });
  }
}

class QuotaApi {
  constructor(c) { this.c = c; }
  get() { return this.c.request("/api/quota").then((r) => r.quota); }
  set(limits) { return this.c.request("/api/quota", { method: "POST", body: limits }).then((r) => r.quota); }
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
