// terminal.js — the Terminal app: a real PTY, not a command box.
//
// It speaks the Gateway's existing shell protocol at `/:slug/pty`: binary frames
// are terminal bytes, and a frame beginning with SOH (0x01) is a JSON control
// message — which is how the browser tells the Cell its window got bigger.
//
// The renderer is ours (ansi.js) rather than xterm from a CDN, because an OS that
// cannot draw its own terminal without the public internet is not one. It has an
// alternate screen and cursor addressing, so full-screen programs paint. Tabs
// are window props: which shells you had open survives the tab, because the
// window does. (The sessions themselves do not — a PTY is a process, and a
// reopened window gets fresh ones.)

import { h, fill, icon, slug } from "../core.js";
import { call } from "./client.js";
import { createScreen } from "./ansi.js";

const SOH = 0x01;

/** One PTY session: a screen, a socket, and the keys between them. */
function createSession(host, { onStatus, onTitle }) {
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
    onStatus("connecting…", "warn");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/${slug}/pty`);
    ws.binaryType = "arraybuffer";
    const dec = new TextDecoder();
    ws.onopen = () => { onStatus("connected", "ok"); fit(); };
    ws.onmessage = (e) => {
      const text = typeof e.data === "string" ? e.data : dec.decode(new Uint8Array(e.data));
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
    focus: () => view.focus(),
    reconnect() { try { ws?.close(); } catch { /* gone */ } screen.clear(); connect(); },
    close() { closed = true; ro.disconnect(); try { ws?.close(); } catch { /* gone */ } view.remove(); },
  };
}

export function mountTerminal(host, win, ctx) {
  // Tabs live in the window's props: `{ tabs: [{ id, title }], active }`.
  let tabs = Array.isArray(win.props?.tabs) && win.props.tabs.length ? win.props.tabs.map((t) => ({ id: String(t.id), title: String(t.title ?? "shell").slice(0, 40) })) : [{ id: "t1", title: "shell" }];
  let active = tabs.some((t) => t.id === win.props?.active) ? win.props.active : tabs[0].id;
  const sessions = new Map();
  const lastStatus = new Map(); // tab id → [text, cls]; set before the session object exists

  const tabBar = h("div.term-tabs");
  const status = h("span.term-status", "");
  const body = h("div.term-body");
  const bar = h("div.app-bar", null,
    tabBar,
    h("button.app-btn", { title: "New tab", onclick: () => addTab() }, icon("plus", 12)),
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
    const s = createSession(body, {
      onStatus: (text, cls = "") => { lastStatus.set(id, [text, cls]); if (id === active) { status.textContent = text; status.className = `term-status ${cls}`; } },
      onTitle: (title) => { const t = tabs.find((x) => x.id === id); if (t && t.title !== title) { t.title = title; paintTabs(); persist(); } },
    });
    sessions.set(id, s);
    return s;
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

  function addTab() {
    const id = `t${Date.now().toString(36)}`;
    tabs = [...tabs, { id, title: "shell" }];
    show(id);
    persist();
  }
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

  function paintTabs() {
    fill(tabBar, ...tabs.map((t) => h("div.term-tab", { class: t.id === active ? "on" : "" },
      h("button.name", { onclick: () => show(t.id) }, t.title),
      tabs.length > 1 ? h("button.x", { title: "Close tab", onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, icon("x", 10)) : null)));
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
