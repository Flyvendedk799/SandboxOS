// terminal.js — the Terminal app: a real PTY, not a command box.
//
// It speaks the Gateway's existing shell protocol at `/:slug/pty`: binary frames
// are terminal bytes, and a frame beginning with SOH (0x01) is a JSON control
// message — which is how the browser tells the Cell its window got bigger.
//
// The renderer is ours (ansi.js) rather than xterm from a CDN, because an OS that
// cannot draw its own terminal without the public internet is not one. It has an
// alternate screen and cursor addressing, so full-screen programs paint.
//
// A shell outlives its window. Tabs are window props and each one remembers the
// *session* it was attached to, so closing the Terminal detaches and reopening it
// reattaches — same shell, same scrollback, the build still running (goal.md
// T1.8). Ending a session is a separate, named gesture, because closing a window
// and killing your work are not the same intention.

import { h, fill, icon, slug, api, menu, dialog, toastError } from "../core.js";
import { call } from "./client.js";
import { createScreen } from "./ansi.js";

const SOH = 0x01;

/** One attached terminal session: a screen, a socket, and the keys between them. */
function createSession(host, { sessionId = null, onStatus, onTitle, onSession }) {
  const view = h("div.term-screen", { tabindex: "0" });
  const sample = h("span", { style: { position: "absolute", visibility: "hidden", whiteSpace: "pre" } }, "0000000000");
  view.append(sample);
  const screen = createScreen(view);
  let ws = null;
  let closed = false;

  function sendControl(obj) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const body = new TextEncoder().encode(JSON.stringify(obj));
    const frame = new Uint8Array(body.length + 1);
    frame[0] = SOH;
    frame.set(body, 1);
    ws.send(frame);
  }

  function fit() {
    const { cols, rows } = screen.measure(sample);
    screen.resize(cols, rows);
    sendControl({ type: "resize", cols, rows });
  }

  function connect() {
    if (closed) return;
    onStatus(sessionId ? "reattaching…" : "connecting…", "warn");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
    ws = new WebSocket(`${proto}//${location.host}/${slug}/pty${q}`);
    ws.binaryType = "arraybuffer";
    const dec = new TextDecoder();
    ws.onopen = () => { onStatus("connected", "ok"); fit(); };
    ws.onmessage = (e) => {
      const bytes = typeof e.data === "string" ? null : new Uint8Array(e.data);
      // A control frame from the Gateway — today, which session this is, so a
      // reopened window can ask for the same one.
      if (bytes?.[0] === SOH) {
        try {
          const ctrl = JSON.parse(dec.decode(bytes.subarray(1)));
          if (ctrl.type === "session") { sessionId = ctrl.id; onSession?.(ctrl); }
        } catch { /* an unreadable control frame is not fatal */ }
        return;
      }
      const text = bytes ? dec.decode(bytes) : e.data;
      // A title the shell sets (OSC 0/2) names the tab.
      const t = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(text);
      if (t) onTitle?.(t[1].slice(0, 40));
      screen.write(text);
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus("disconnected");
      screen.write("\r\n\x1b[2m— session ended —\x1b[0m\r\n");
    };
    ws.onerror = () => onStatus("error", "err");
  }

  const send = (text) => { if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(text)); };

  // Keys the shell needs, mapped by hand. The OS's own ⌘ shortcuts are let
  // through — a terminal that swallows the window manager is a terminal you
  // cannot get out of. Ctrl+letters go to the shell (^C, ^D, ^Z, ^L…).
  const KEYS = {
    Enter: "\r", Backspace: "\x7f", Tab: "\t", Escape: "\x1b",
    ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
    Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~", Insert: "\x1b[2~", PageUp: "\x1b[5~", PageDown: "\x1b[6~",
    F1: "\x1bOP", F2: "\x1bOQ", F3: "\x1bOR", F4: "\x1bOS", F5: "\x1b[15~", F6: "\x1b[17~", F7: "\x1b[18~", F8: "\x1b[19~",
    F9: "\x1b[20~", F10: "\x1b[21~", F11: "\x1b[23~", F12: "\x1b[24~",
  };
  view.addEventListener("keydown", (e) => {
    if (e.metaKey && !e.ctrlKey) return;
    if (e.ctrlKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "v" || (k === "c" && !e.shiftKey && window.getSelection()?.toString())) return;
      if (k.length === 1 && k >= "a" && k <= "z") { e.preventDefault(); send(String.fromCharCode(k.charCodeAt(0) - 96)); return; }
      if (e.key === "[") { e.preventDefault(); send("\x1b"); return; }
      return;
    }
    const mapped = KEYS[e.key] ?? (e.key.length === 1 ? e.key : null);
    if (mapped == null) return;
    e.preventDefault();
    send(e.altKey && mapped.length === 1 ? `\x1b${mapped}` : mapped);
  });
  view.addEventListener("paste", (e) => { e.preventDefault(); send(e.clipboardData.getData("text")); });
  view.addEventListener("pointerdown", (e) => { e.stopPropagation(); setTimeout(() => view.focus(), 0); });

  const ro = new ResizeObserver(() => { if (view.isConnected) fit(); });
  ro.observe(view);
  connect();

  return {
    view, screen, fit,
    get sessionId() { return sessionId; },
    focus: () => view.focus(),
    reconnect() { try { ws?.close(); } catch { /* gone */ } screen.clear(); connect(); },
    /** End the shell itself, for everyone attached to it. */
    end() { sendControl({ type: "kill" }); },
    /** Stop watching. The shell keeps running; this is what closing a window does. */
    close() { closed = true; ro.disconnect(); try { ws?.close(); } catch { /* gone */ } view.remove(); },
  };
}

export function mountTerminal(host, win, ctx) {
  // Tabs live in the window's props: `{ tabs: [{ id, title }], active }`.
  let tabs = Array.isArray(win.props?.tabs) && win.props.tabs.length
    ? win.props.tabs.map((t) => ({ id: String(t.id), title: String(t.title ?? "shell").slice(0, 40), ...(t.session ? { session: String(t.session) } : {}) }))
    : [{ id: "t1", title: "shell" }];
  let active = tabs.some((t) => t.id === win.props?.active) ? win.props.active : tabs[0].id;
  const sessions = new Map();
  const lastStatus = new Map(); // tab id → [text, cls]; set before the session object exists

  const tabBar = h("div.term-tabs");
  const status = h("span.term-status", "");
  const body = h("div.term-body");
  const bar = h("div.app-bar", null,
    tabBar,
    h("button.app-btn", { title: "New tab", onclick: () => addTab() }, icon("plus", 12)),
    h("button.app-btn", { title: "Shells on this machine", onclick: (e) => sessionMenu(e.currentTarget) }, icon("shell", 12)),
    h("span.spacer"),
    status,
    h("button.app-btn", { onclick: () => current()?.screen.clear(), title: "Clear" }, "Clear"),
    h("button.app-btn", { onclick: () => current()?.reconnect(), title: "Reconnect" }, icon("refresh", 12)),
  );
  fill(host, h("div.app", null, bar, body));

  const current = () => sessions.get(active);
  const persist = () => call("windowSet", { id: win.id, props: { tabs, active } }).catch(() => {});

  function session(id) {
    if (sessions.has(id)) return sessions.get(id);
    const tab = tabs.find((x) => x.id === id);
    const s = createSession(body, {
      // The tab remembers which shell it was watching; this is what makes a
      // reopened window a reattachment rather than a new machine.
      sessionId: tab?.session ?? null,
      onStatus: (text, cls = "") => { lastStatus.set(id, [text, cls]); if (id === active) { status.textContent = text; status.className = `term-status ${cls}`; } },
      onTitle: (title) => { const t = tabs.find((x) => x.id === id); if (t && t.title !== title) { t.title = title; paintTabs(); persist(); } },
      onSession: ({ id: sid }) => {
        const t = tabs.find((x) => x.id === id);
        if (t && t.session !== sid) { t.session = sid; persist(); }
      },
    });
    sessions.set(id, s);
    return s;
  }

  /** Every shell on this machine, attached or not — including the ones another
   *  window (or a closed one) left running. */
  async function sessionMenu(anchor) {
    let list = [];
    try { list = (await api.mcp("proc", "sessions", {})).sessions ?? []; }
    catch (e) { toastError("Could not list sessions", e); return; }
    const mine = new Set(tabs.map((t) => t.session).filter(Boolean));
    const items = list.map((s) => ({
      label: `${s.name}${mine.has(s.id) ? " · open here" : s.attached ? " · attached elsewhere" : " · detached"}`,
      run: () => { if (!mine.has(s.id)) addTab({ session: s.id, title: s.name }); },
    }));
    menu(anchor, [
      ...(items.length ? items : [{ label: "no other shells", run: () => {} }]),
      "-",
      { label: "New shell", icon: "plus", run: () => addTab() },
    ]);
  }

  function show(id) {
    active = id;
    for (const [sid, s] of sessions) s.view.hidden = sid !== id;
    const s = session(id);
    if (!s.view.isConnected) body.append(s.view);
    s.view.hidden = false;
    const [text, cls] = lastStatus.get(id) ?? ["connecting…", "warn"];
    status.textContent = text; status.className = `term-status ${cls}`;
    s.fit();
    s.focus();
    paintTabs();
    ctx?.setTitle?.(tabs.length > 1 ? `Terminal · ${tabs.find((t) => t.id === id)?.title ?? "shell"}` : win.title);
  }

  function addTab({ session: sid = null, title = "shell" } = {}) {
    const id = `t${Date.now().toString(36)}`;
    tabs = [...tabs, { id, title, ...(sid ? { session: sid } : {}) }];
    show(id);
    persist();
  }

  /** Stop watching a shell. It keeps running; `endTab` is the other thing. */
  function closeTab(id) {
    if (tabs.length === 1) { ctx?.close?.(); return; }
    sessions.get(id)?.close();
    sessions.delete(id);
    lastStatus.delete(id);
    const i = tabs.findIndex((t) => t.id === id);
    tabs = tabs.filter((t) => t.id !== id);
    if (active === id) show(tabs[Math.max(0, i - 1)].id); else paintTabs();
    persist();
  }

  /** End the shell and everything it is running. Named, and asked about. */
  async function endTab(id) {
    const t = tabs.find((x) => x.id === id);
    const s = sessions.get(id);
    if (!t) return;
    const got = await dialog({
      title: `End “${t.title}”?`,
      message: "The shell and anything running in it stop. Closing the tab or the window only detaches.",
      confirmLabel: "End session", danger: true,
    });
    if (!got) return;
    s?.end();
    if (t.session) await api.tryMcp("proc", "sessionKill", { id: t.session });
    closeTab(id);
  }

  function tabMenu(at, id) {
    const t = tabs.find((x) => x.id === id);
    menu(at, [
      { label: "Rename…", run: async () => {
        const got = await dialog({ title: "Name this shell", fields: [{ name: "name", label: "Name", value: t?.title ?? "shell" }], confirmLabel: "Rename" });
        if (!got?.name) return;
        t.title = String(got.name).slice(0, 40);
        if (t.session) await api.tryMcp("proc", "sessionRename", { id: t.session, name: t.title });
        paintTabs(); persist();
      } },
      { label: "Detach (keep it running)", run: () => closeTab(id) },
      "-",
      { label: "End session", danger: true, run: () => endTab(id) },
    ]);
  }

  function paintTabs() {
    fill(tabBar, ...tabs.map((t) => h("div.term-tab", {
      class: t.id === active ? "on" : "",
      oncontextmenu: (e) => { e.preventDefault(); tabMenu({ x: e.clientX, y: e.clientY }, t.id); },
      title: t.session ? `session ${t.session} — right-click for rename, detach, end` : "connecting",
    },
      h("button.name", { onclick: () => show(t.id) }, t.title),
      tabs.length > 1 ? h("button.x", { title: "Close tab (the shell keeps running)", onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, icon("x", 10)) : null)));
  }

  host.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
    if (e.key.toLowerCase() === "t") { e.preventDefault(); addTab(); }
    if (e.key === "]" || e.key === "}") { e.preventDefault(); const i = tabs.findIndex((t) => t.id === active); show(tabs[(i + 1) % tabs.length].id); }
    if (e.key === "[" || e.key === "{") { e.preventDefault(); const i = tabs.findIndex((t) => t.id === active); show(tabs[(i - 1 + tabs.length) % tabs.length].id); }
  });

  for (const t of tabs) session(t.id).view.hidden = true;
  show(active);
  return () => { for (const s of sessions.values()) s.close(); sessions.clear(); };
}
