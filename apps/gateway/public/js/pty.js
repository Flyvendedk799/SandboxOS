// pty.js — the interactive shell workspace.
//
// A WebSocket to /:slug/pty bridged to xterm.js. Binary frames are terminal
// bytes; a frame beginning with SOH (0x01) is a JSON control message, which is
// how the browser tells the Cell that the terminal was resized.

import { $, h, bus, state, toast, toastError } from "./core.js";

const SOH = 0x01;

export function initPty() {
  const container = $("#pty-container");
  const statusEl = $("#pty-status");
  const connectBtn = $("#pty-connect");
  const disconnectBtn = $("#pty-disconnect");

  let term = null;
  let ws = null;

  function setStatus(text, kind = "") {
    statusEl.textContent = text;
    statusEl.className = `chip mono ${kind}`;
    connectBtn.disabled = text === "connected" || text === "connecting…";
    disconnectBtn.disabled = text !== "connected";
  }

  /** Fit the terminal to the container using xterm's measured cell size. */
  function fit() {
    if (!term || term._fallback) return;
    const core = term._core;
    const cw = core?._renderService?.dimensions?.css?.cell?.width;
    const ch = core?._renderService?.dimensions?.css?.cell?.height;
    if (!cw || !ch) return;
    const cols = Math.max(20, Math.floor((container.clientWidth - 16) / cw));
    const rows = Math.max(6, Math.floor((container.clientHeight - 16) / ch));
    if (cols === term.cols && rows === term.rows) return;
    term.resize(cols, rows);
    sendControl({ type: "resize", cols, rows });
  }

  function sendControl(obj) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const body = new TextEncoder().encode(JSON.stringify(obj));
    const frame = new Uint8Array(body.length + 1);
    frame[0] = SOH;
    frame.set(body, 1);
    ws.send(frame);
  }

  function ensureTerm() {
    if (term) return term;
    if (typeof window.Terminal !== "function") {
      // xterm is loaded from a CDN, which is exactly the thing that is missing on
      // an air-gapped host or behind a strict egress policy. Rather than leaving
      // the Shell tab dead, fall back to a plain renderer: it cannot draw vim,
      // but it runs a shell, which is what most sessions actually need.
      term = fallbackTerminal();
      return term;
    }
    term = new window.Terminal({
      fontFamily: getComputedStyle(document.body).getPropertyValue("--mono").trim() || "monospace",
      fontSize: 13,
      cursorBlink: true,
      convertEol: true,
      theme: terminalTheme(),
    });
    term.open(container);
    wireTerm();
    new ResizeObserver(() => fit()).observe(container);
    bus.on("theme", () => { if (!term._fallback) term.options.theme = terminalTheme(); });
    return term;
  }

  /** A minimal xterm-shaped terminal: write(), onData(), resize(), focus(). */
  function fallbackTerminal() {
    const view = h("pre", {
      style: {
        margin: "0", padding: "var(--s-3)", height: "100%", overflow: "auto",
        fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.5",
        whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text)",
        background: "var(--bg-0)", borderRadius: "var(--r-md)", outline: "none",
      },
      tabindex: "0",
    });
    container.replaceChildren(view);
    toast("Using the built-in terminal", {
      body: "xterm.js could not be fetched, so full-screen programs will not render.",
      kind: "warn",
    });

    let onData = () => {};
    const decoder = new TextDecoder();
    // Enough of the escape vocabulary to keep a normal shell session readable.
    const strip = (t) => t.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

    view.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "c") { e.preventDefault(); onData("\u0003"); }
        if (e.key.toLowerCase() === "d") { e.preventDefault(); onData("\u0004"); }
        return;
      }
      const map = { Enter: "\r", Backspace: "\u007f", Tab: "\t", Escape: "\u001b",
                    ArrowUp: "\u001b[A", ArrowDown: "\u001b[B", ArrowRight: "\u001b[C", ArrowLeft: "\u001b[D" };
      const send = map[e.key] ?? (e.key.length === 1 ? e.key : null);
      if (send == null) return;
      e.preventDefault();
      onData(send);
    });

    return {
      cols: 80,
      rows: 24,
      options: {},
      open() {},
      focus: () => view.focus(),
      resize() {},
      onData: (fn) => { onData = fn; },
      writeln: (t) => { view.append(document.createTextNode(`${strip(String(t))}\n`)); view.scrollTop = view.scrollHeight; },
      write(data) {
        const text = typeof data === "string" ? data : decoder.decode(data);
        view.append(document.createTextNode(strip(text)));
        view.scrollTop = view.scrollHeight;
      },
      _fallback: true,
    };
  }

  function terminalTheme() {
    const css = getComputedStyle(document.documentElement);
    const v = (n, fallback) => css.getPropertyValue(n).trim() || fallback;
    return {
      background: v("--bg-0", "#080b0f"),
      foreground: v("--text", "#e6edf3"),
      cursor: v("--accent", "#35d6c4"),
      selectionBackground: v("--accent-dim", "rgba(53,214,196,.2)"),
    };
  }

  /** Bridge terminal keystrokes onto the socket. */
  function wireTerm() {
    term.onData((d) => { if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d)); });
  }

  function connect() {
    const created = !term;
    if (!ensureTerm()) return;
    if (created && term._fallback) wireTerm();
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    setStatus("connecting…", "warn");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/${state.slug}/pty`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      setStatus("connected", "ok");
      term.focus();
      fit();
    };
    ws.onmessage = (e) => {
      const data = typeof e.data === "string" ? e.data : new Uint8Array(e.data);
      term.write(data);
    };
    ws.onclose = () => { setStatus("disconnected"); term?.writeln("\r\n\x1b[2m— session ended —\x1b[0m"); };
    ws.onerror = () => setStatus("error", "err");
  }

  function disconnect() {
    ws?.close();
    ws = null;
    setStatus("disconnected");
  }

  connectBtn.addEventListener("click", connect);
  disconnectBtn.addEventListener("click", disconnect);
  bus.on("workspace:shell", () => { ensureTerm(); fit(); if (!ws) connect(); else term?.focus(); });
  window.addEventListener("beforeunload", () => ws?.close());

  setStatus("disconnected");
  return { connect, disconnect };
}
