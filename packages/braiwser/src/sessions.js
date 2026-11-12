// Braiwser sessions: one real Chromium per open Browser window.
//
// The window is a view onto a browser that runs next to the Gateway. It shows
// frames (JPEG screenshots of the page) and sends what the person does — clicks,
// typing, scrolling, an address — back as Braiwser human input. The page itself
// never runs in the person's tab, so it cannot see their SandboxOS cookies, and
// what it can reach is decided per request by ./guard.js.
//
// A session is keyed by the window, so reloading the desktop reattaches to the same
// page rather than starting over. Nobody watching for `idleMs` closes it; the window
// remembers its address and reopens there.

import { classify, guardPublic, normalizeAddress, blockedPage } from "./guard.js";

const MIN = 240, MAX = 4096;
const clampSize = (n, fallback) => Math.max(MIN, Math.min(MAX, Math.round(Number(n) || fallback)));

export class BraiwserError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export class BraiwserSessions {
  /**
   * @param {object} o
   * @param {() => object} o.loadDriver       Braiwser driver (runtime.loadDriver)
   * @param {(sandboxId: string, port: number) => Promise<{host: string, port: number}>} o.resolvePort
   *        Where `localhost:<port>` goes for this Sandbox; throws a readable Error to refuse.
   * @param {(sandboxId: string) => object} [o.policyFor]  the Sandbox's net egress policy
   */
  constructor({ loadDriver, resolvePort, policyFor = () => null, maxSessions = 4, maxPerSandbox = 2, idleMs = 3 * 60_000, now = () => Date.now() } = {}) {
    this.loadDriver = loadDriver;
    this.resolvePort = resolvePort;
    this.policyFor = policyFor;
    this.maxSessions = maxSessions;
    this.maxPerSandbox = maxPerSandbox;
    this.idleMs = idleMs;
    this.now = now;
    this.sessions = new Map(); // key → record
    this.opening = new Map();  // key → Promise<record>
    this._driver = null;
  }

  static key(sandboxId, windowId) { return `${sandboxId}:${windowId}`; }

  get(key) { return this.sessions.get(key) ?? null; }

  list(sandboxId) {
    return [...this.sessions.values()].filter((r) => r.sandboxId === sandboxId)
      .map((r) => ({ windowId: r.windowId, url: r.activeUrl(), lastSeen: r.lastSeen }));
  }

  /** Open (or rejoin) the session behind a window. */
  async open({ sandboxId, windowId, width, height, url }) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(windowId))) throw new BraiwserError("BAD_WINDOW", "window id required");
    const key = BraiwserSessions.key(sandboxId, windowId);
    const existing = this.sessions.get(key);
    if (existing) { existing.lastSeen = this.now(); return existing; }
    if (this.opening.has(key)) return this.opening.get(key);
    const p = this._open(key, { sandboxId, windowId, width, height, url }).finally(() => this.opening.delete(key));
    this.opening.set(key, p);
    return p;
  }

  async _open(key, { sandboxId, windowId, width, height, url }) {
    // Room: a Sandbox past its share gives up its least recently watched window;
    // the host past its total refuses rather than evicting someone else's.
    const mine = [...this.sessions.values()].filter((r) => r.sandboxId === sandboxId).sort((a, b) => a.lastSeen - b.lastSeen);
    while (mine.length >= this.maxPerSandbox) await this.close(mine.shift().key);
    const othersOpening = [...this.opening.keys()].filter((k) => k !== key).length;
    if (this.sessions.size + othersOpening >= this.maxSessions) {
      throw new BraiwserError("BUSY", "Every browser on this host is in use. Close a Braiwser window and try again.", 429);
    }
    this._driver ??= this.loadDriver();
    const rec = new Session(this, { key, sandboxId, windowId });
    rec.session = await this._driver.open({
      mode: "headless",
      viewport: { width: clampSize(width, 1280), height: clampSize(height, 800) },
      // Default-deny underneath: our own route (installed next) answers every
      // request, so the driver's filter only matters if that route is ever absent.
      requestFilter: () => "block",
      onPageEvent: (event) => rec.onPageEvent(event),
    });
    try {
      await rec.installPolicy();
    } catch (e) { await rec.session.close().catch(() => {}); throw e; }
    rec.activePageId = [...rec.session.pages.keys()][0];
    this.sessions.set(key, rec);
    if (url && url !== "about:blank") rec.navigate(url).catch(() => {});
    return rec;
  }

  async close(key) {
    const rec = this.sessions.get(key);
    if (!rec) return false;
    this.sessions.delete(key);
    for (const ws of rec.sockets) { try { ws.close(); } catch {} }
    rec.sockets.clear();
    await rec.session.close().catch(() => {});
    return true;
  }

  /** Close sessions nobody has looked at for `idleMs`. Returns how many. */
  async reap() {
    const stale = [...this.sessions.values()].filter((r) => this.now() - r.lastSeen > this.idleMs);
    for (const r of stale) await this.close(r.key);
    return stale.length;
  }

  async closeAll() { for (const key of [...this.sessions.keys()]) await this.close(key); }
}

class Session {
  constructor(owner, { key, sandboxId, windowId }) {
    this.owner = owner;
    this.key = key;
    this.sandboxId = sandboxId;
    this.windowId = windowId;
    this.session = null;
    this.activePageId = null;
    this.lastSeen = owner.now();
    this.lastNavigationError = null;
    this.sockets = new Set(); // relayed upstream WebSockets, closed with the session
  }

  page() {
    const pages = this.session.pages;
    let page = pages.get(this.activePageId);
    if (!page) {
      page = [...pages.values()].at(-1) ?? null;
      this.activePageId = page?.pageId ?? null;
    }
    return page;
  }

  activeUrl() { try { return this.page()?.url() ?? "about:blank"; } catch { return "about:blank"; } }

  onPageEvent(event) {
    // A popup (target=_blank, window.open) is where the person's attention went:
    // show it, the way a browser focuses a new tab.
    if (event?.type === "popup" || event?.type === "page") this.activePageId = event.pageId;
  }

  async installPolicy() {
    const context = this.session._context;
    if (!context || typeof context.route !== "function") {
      throw new BraiwserError("RUNTIME_MISMATCH", "This Braiwser runtime does not expose its browser context; reinstall the pinned revision.", 500);
    }
    await context.route("**/*", (route) => this.routeRequest(route));
    if (typeof context.routeWebSocket === "function") await context.routeWebSocket(/.*/, (ws) => this.routeSocket(ws));
  }

  async destination(url) {
    const c = classify(url);
    if (c.kind === "port") {
      if (c.secure) throw new Error(`Your machine's ports are plain http — open http://localhost:${c.port}/ instead.`);
      const ep = await this.owner.resolvePort(this.sandboxId, c.port);
      const u = new URL(url);
      u.hostname = ep.host;
      u.port = String(ep.port);
      return { url: u.href };
    }
    if (c.kind === "public") { await guardPublic(this.owner.policyFor(this.sandboxId), c.host); return { url: null }; }
    throw new Error(c.reason ?? "That address is not one this browser opens.");
  }

  async routeRequest(route) {
    const request = route.request();
    const url = request.url();
    try {
      const dest = await this.destination(url);
      if (isTopLevel(request)) this.lastNavigationError = null;
      if (!dest.url) return await route.continue();
      // Into the Cell, streamed (not buffered, so server-sent events still flow).
      // The page keeps believing it is on localhost:<port>; Chromium sends the
      // Cell's address as Host, which dev servers accept for IP hosts by default.
      return await route.continue({ url: dest.url });
    } catch (e) {
      if (isTopLevel(request)) {
        this.lastNavigationError = { url, reason: e.message, at: this.owner.now() };
        return route.fulfill({ status: 403, contentType: "text/html; charset=utf-8", body: blockedPage(url, e.message) }).catch(() => {});
      }
      return route.abort("blockedbyclient").catch(() => {});
    }
  }

  async routeSocket(ws) {
    let dest;
    try { dest = await this.destination(ws.url()); }
    catch { return ws.close({ code: 1008, reason: "not allowed" }); }
    if (!dest.url) { ws.connectToServer(); return; }
    // A dev server's hot reload lives on a WebSocket into the Cell. Playwright cannot
    // redirect one, so it is relayed: page ⇄ here ⇄ the Cell's port.
    if (typeof WebSocket !== "function") return ws.close({ code: 1011, reason: "relay unavailable" });
    const upstream = new WebSocket(dest.url.replace(/^http/, "ws"));
    this.sockets.add(upstream);
    upstream.addEventListener("close", () => this.sockets.delete(upstream));
    upstream.binaryType = "arraybuffer";
    const pending = [];
    upstream.onopen = () => { for (const m of pending.splice(0)) upstream.send(m); };
    upstream.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : Buffer.from(e.data));
    upstream.onclose = (e) => ws.close({ code: e.code === 1005 ? 1000 : e.code, reason: e.reason }).catch?.(() => {});
    upstream.onerror = () => ws.close({ code: 1011, reason: "upstream error" }).catch?.(() => {});
    ws.onMessage((m) => (upstream.readyState === 1 ? upstream.send(m) : pending.push(m)));
    ws.onClose(() => { try { upstream.close(); } catch {} });
  }

  touch() { this.lastSeen = this.owner.now(); }

  async frame({ quality = 65 } = {}) {
    this.touch();
    let page = this.page();
    if (!page) { page = await this.session.newPage(); this.activePageId = page.pageId; }
    const raw = page._raw;
    const q = Math.max(30, Math.min(90, Number(quality) || 65));
    const bytes = await raw.screenshot({ type: "jpeg", quality: q, timeout: 8000, caret: "initial" });
    const vp = raw.viewportSize() ?? { width: 0, height: 0 };
    return { bytes, width: vp.width, height: vp.height, ...(await this.describe()) };
  }

  async describe() {
    const tabs = [];
    for (const p of this.session.pages.values()) {
      let title = "";
      try { title = await p._raw.title(); } catch {}
      tabs.push({ id: p.pageId, url: safeUrl(p), title: title.slice(0, 200) });
    }
    const active = this.page();
    return { url: active ? safeUrl(active) : "about:blank", tabs, activeTab: this.activePageId, blocked: this.recentBlock() };
  }

  recentBlock() {
    const b = this.lastNavigationError;
    return b && this.owner.now() - b.at < 10_000 ? { url: b.url, reason: b.reason } : null;
  }

  async navigate(input) {
    this.touch();
    const url = normalizeAddress(input);
    this.lastNavigationError = null;
    const page = this.page() ?? await this.session.newPage();
    this.activePageId = page.pageId;
    if (url === "about:blank") { await page._raw.goto("about:blank").catch(() => {}); return { url, outcome: "ready" }; }
    const result = await page.navigate(url);
    return { url, outcome: result?.outcome ?? null, status: result?.status ?? null };
  }

  /** One thing the person did. Coordinates are in page pixels of the last frame. */
  async input(body) {
    this.touch();
    const page = this.page();
    if (!page) throw new BraiwserError("NO_PAGE", "no page");
    const kind = body?.kind;
    if (kind === "forward") { await page._raw.goForward({ waitUntil: "load", timeout: 20000 }).catch(() => null); return { dispatched: true }; }
    if (kind === "dblclick" || kind === "contextmenu") {
      const { x, y } = body;
      if (![x, y].every(Number.isFinite)) throw new BraiwserError("BAD_INPUT", "coordinates required");
      await page._raw.mouse.click(x, y, kind === "dblclick" ? { clickCount: 2 } : { button: "right" });
      return { dispatched: true };
    }
    if (!["click", "move", "text", "key", "scroll", "back", "reload"].includes(kind)) throw new BraiwserError("BAD_INPUT", `unsupported input: ${kind}`);
    try {
      return await page.humanInput({ kind, x: body.x, y: body.y, key: body.key, text: body.text, deltaX: body.deltaX, deltaY: body.deltaY });
    } catch (e) {
      throw new BraiwserError("BAD_INPUT", e.message || "input refused");
    }
  }

  async resize(width, height) {
    const page = this.page();
    if (!page) return;
    await page._raw.setViewportSize({ width: clampSize(width, 1280), height: clampSize(height, 800) });
  }

  async tab(op, id) {
    this.touch();
    if (op === "new") { const p = await this.session.newPage(); this.activePageId = p.pageId; return { id: p.pageId }; }
    const page = this.session.pages.get(id);
    if (!page) throw new BraiwserError("NO_TAB", "no such tab", 404);
    if (op === "switch") { this.activePageId = id; await page._raw.bringToFront().catch(() => {}); return { id }; }
    if (op === "close") {
      await page.close().catch(() => {});
      if (this.activePageId === id) this.activePageId = null;
      if (!this.session.pages.size) { const p = await this.session.newPage(); this.activePageId = p.pageId; }
      return { id };
    }
    throw new BraiwserError("BAD_TAB", `unsupported tab op: ${op}`);
  }
}

/** A navigation of a tab's own document (not a frame inside it). A popup's first
 *  request has no frame yet — Playwright throws when asked — and it is top-level. */
function isTopLevel(request) {
  if (!request.isNavigationRequest()) return false;
  try { const frame = request.frame(); return frame === frame.page().mainFrame(); } catch { return true; }
}

function safeUrl(page) { try { return page.url(); } catch { return "about:blank"; } }
