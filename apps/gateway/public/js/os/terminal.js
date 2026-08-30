// terminal.js — the Terminal app: a real PTY, not a command box.
//
// It speaks the Gateway's existing shell protocol at `/:slug/pty`: binary frames
// are terminal bytes, and a frame beginning with SOH (0x01) is a JSON control
// message — which is how the browser tells the Cell its window got bigger.
//
// The renderer is ours (ansi.js) rather than xterm from a CDN, because an OS that
// cannot draw its own terminal without the public internet is not one. The cost
// is honest and stated in the window: no alternate screen, so full-screen TUIs do
// not paint.

import { h, fill, icon, slug } from "../core.js";
import { createScreen } from "./ansi.js";

const SOH = 0x01;

export function mountTerminal(host, win, ctx) {
  const view = h("div.term-screen", { tabindex: "0" });
  const status = h("span.term-status", "connecting…");
  const sample = h("span", { style: { position: "absolute", visibility: "hidden", whiteSpace: "pre" } }, "0000000000");
  view.append(sample);

  const screen = createScreen(view);
  let ws = null;
  let closed = false;

  const bar = h("div.app-bar", null,
    h("span.path", `${slug} · shell`),
    status,
    h("button.app-btn", { onclick: () => screen.clear(), title: "Clear" }, "Clear"),
    h("button.app-btn", { onclick: reconnect, title: "Reconnect" }, icon("refresh", 12)),
  );
  fill(host, h("div.app", null, bar, view));

  function setStatus(text, cls = "") {
    status.textContent = text;
    status.className = `term-status ${cls}`;
  }

  function sendControl(obj) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const body = new TextEncoder().encode(JSON.stringify(obj));
    const frame = new Uint8Array(body.length + 1);
    frame[0] = SOH;
    frame.set(body, 1);
    ws.send(frame);
  }

  function fit() {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const { cols, rows } = screen.measure(sample);
    sendControl({ type: "resize", cols, rows });
  }

  function connect() {
    if (closed) return;
    setStatus("connecting…", "warn");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/${slug}/pty`);
    ws.binaryType = "arraybuffer";
    const dec = new TextDecoder();

    ws.onopen = () => { setStatus("connected", "ok"); view.focus(); fit(); };
    ws.onmessage = (e) => {
      screen.write(typeof e.data === "string" ? e.data : dec.decode(new Uint8Array(e.data)));
    };
    ws.onclose = () => {
      if (closed) return;
      setStatus("disconnected");
      screen.write("\r\n\x1b[2m— session ended —\x1b[0m\r\n");
    };
    ws.onerror = () => setStatus("error", "err");
  }

  function reconnect() {
    try { ws?.close(); } catch { /* already gone */ }
    screen.clear();
    connect();
  }

  const send = (text) => { if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(text)); };

  // Keys the shell needs, mapped by hand. The OS's own shortcuts (⌘K, ⌘W) are
  // deliberately let through — a terminal that swallows the window manager is a
  // terminal you cannot get out of.
  const KEYS = {
    Enter: "\r", Backspace: "\x7f", Tab: "\t", Escape: "\x1b",
    ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
    Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~", PageUp: "\x1b[5~", PageDown: "\x1b[6~",
  };

  view.addEventListener("keydown", (e) => {
    if (e.metaKey && !e.ctrlKey) return;              // leave ⌘-shortcuts to the OS
    if (e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === "v" || k === "c" && !e.shiftKey && window.getSelection()?.toString()) return; // copy/paste
      if (k.length === 1 && k >= "a" && k <= "z") {
        e.preventDefault();
        send(String.fromCharCode(k.charCodeAt(0) - 96));
        return;
      }
      return;
    }
    const mapped = KEYS[e.key] ?? (e.key.length === 1 ? e.key : null);
    if (mapped == null) return;
    e.preventDefault();
    send(mapped);
  });

  view.addEventListener("paste", (e) => {
    e.preventDefault();
    send(e.clipboardData.getData("text"));
  });
  view.addEventListener("pointerdown", (e) => { e.stopPropagation(); setTimeout(() => view.focus(), 0); });

  const ro = new ResizeObserver(() => fit());
  ro.observe(view);
  connect();

  ctx?.setTitle?.(win.title);
  return () => {
    closed = true;
    ro.disconnect();
    try { ws?.close(); } catch { /* already gone */ }
  };
}
