// console.js — Command Central in the browser.
//
// One input, three modes (shell verbs / raw MCP / natural language), streamed
// over SSE so a long `npm install` prints as it runs instead of arriving in one
// lump at the end. History, completion and a propose→confirm gate for NL.

import { $, h, clear, api, bus, state, slug, toast, toastError, mod } from "./core.js";

const HISTORY_KEY = "sbx.history";
const MAX_HISTORY = 200;

const BANNER = [
  ["Welcome to SandboxOS.", "Everything you type here becomes an authorized, audited MCP call."],
  [`Type <strong>help</strong> for the verb map, <strong>?</strong> followed by plain English to have it translated, or <strong>:call server.tool {}</strong> to drive the Kernel directly. Press <strong>${mod}+K</strong> for the command palette.`],
];

export function initConsole() {
  const out = $("#console-out");
  const input = $("#console-input");
  const modeEl = $("#console-mode");

  let history = [];
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); } catch { history = []; }
  let cursor = history.length;
  let draft = "";
  let busy = false;

  function print(text, cls = "l") {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    const line = h("div", { class: cls }, text);
    out.append(line);
    if (atBottom) out.scrollTop = out.scrollHeight;
    return line;
  }

  function printHtml(html, cls = "l") {
    const line = h("div", { class: cls, html });
    out.append(line);
    out.scrollTop = out.scrollHeight;
    return line;
  }

  function banner() {
    for (const para of BANNER) {
      out.append(h("div.console-banner", { html: para.join(" ") }));
    }
  }

  /** A streaming chunk appends to the last node rather than creating a line per chunk. */
  let streamNode = null;
  function stream(chunk, cls) {
    if (!streamNode || streamNode.dataset.cls !== cls) {
      streamNode = h("div", { class: cls, dataset: { cls } });
      out.append(streamNode);
    }
    streamNode.append(document.createTextNode(chunk));
    out.scrollTop = out.scrollHeight;
  }

  function proposeBox(hint, proposed) {
    streamNode = null;
    const box = h("div.propose", null,
      h("div", null, h("span.dim", "proposed  "), h("span.cmd", proposed)),
      h("div.actions", null,
        h("button.sm", { onclick: () => { box.remove(); runLine(proposed, { echo: true }); } }, "Run it"),
        h("button.ghost.sm", { onclick: () => { box.remove(); input.value = proposed; input.focus(); } }, "Edit"),
        h("button.ghost.sm", { onclick: () => box.remove() }, "Dismiss"),
      ),
    );
    out.append(box);
    out.scrollTop = out.scrollHeight;
  }

  function remember(line) {
    if (history.at(-1) !== line) history.push(line);
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    cursor = history.length;
  }

  /** Run one line through /exec-stream and render the events as they arrive. */
  async function runLine(line, { echo = true } = {}) {
    const text = line.trim();
    if (!text || busy) return;
    if (echo) print(`${slug} ▸ ${text}`, "echo");
    remember(text);
    streamNode = null;

    if (text === "clear") { clear(out); banner(); return; }

    busy = true;
    modeEl.textContent = "running…";
    input.disabled = true;

    try {
      const res = await fetch(`/${slug}/exec-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: text }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const payload = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (!payload) continue;
          let ev;
          try { ev = JSON.parse(payload); } catch { continue; }
          switch (ev.type) {
            case "stdout": stream(ev.chunk, "l"); break;
            case "stderr": stream(ev.chunk, "err"); break;
            case "line": streamNode = null; print(ev.text, ev.text?.startsWith("✗") ? "err" : "l"); break;
            case "clear": clear(out); banner(); break;
            case "proposed": proposeBox(ev.hint, ev.proposed); break;
            case "error": streamNode = null; print(ev.text, "err"); break;
            case "done":
              done = true;
              if (ev.code) print(`(exit ${ev.code})`, "sys");
              break;
            default: break;
          }
        }
      }
      // Any command may have reshaped the machine; let the panels know.
      bus.emit("kernel:mutated", { line: text });
    } catch (e) {
      print(`✗ ${e.message}`, "err");
    } finally {
      busy = false;
      input.disabled = false;
      modeEl.textContent = "";
      input.focus();
    }
  }

  // ── Input handling ─────────────────────────────────────────────────────────

  function updateMode() {
    const v = input.value.trimStart();
    modeEl.textContent = busy ? "running…"
      : v.startsWith("?") ? "natural language"
      : v.startsWith(":") ? "raw MCP"
      : "";
  }

  input.addEventListener("input", updateMode);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const line = input.value;
      input.value = "";
      updateMode();
      runLine(line);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (cursor === history.length) draft = input.value;
      cursor = Math.max(0, cursor - 1);
      input.value = history[cursor] ?? draft;
      updateMode();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor = Math.min(history.length, cursor + 1);
      input.value = cursor === history.length ? draft : history[cursor];
      updateMode();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      complete();
      return;
    }
    if (e.key === "l" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      clear(out);
      banner();
    }
  });

  /** Tab completion over verbs and, after `:call`, the live tool catalogue. */
  const VERBS = ["ls", "cat", "stat", "write", "mkdir", "rm", "mv", "cp", "tree", "grep",
    "ps", "run", "jobs", "logs", "stop", "ports", "port", "whoami", "servers", "enable",
    "disable", "fetch", "secrets", "secret", "pkg", "agent", "agents", "llm", "help", "clear"];

  function complete() {
    const v = input.value;
    const token = v.split(/\s+/).pop() ?? "";
    const pool = v.trimStart().startsWith(":call")
      ? state.tools ?? []
      : v.includes(" ") ? [] : VERBS;
    const hits = pool.filter((t) => t.startsWith(token));
    if (!hits.length) return;
    if (hits.length === 1) {
      input.value = v.slice(0, v.length - token.length) + hits[0] + " ";
      return;
    }
    // Extend to the longest common prefix, then show the alternatives.
    let prefix = hits[0];
    for (const hit of hits) while (!hit.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (prefix.length > token.length) input.value = v.slice(0, v.length - token.length) + prefix;
    print(hits.slice(0, 40).join("   "), "sys");
  }

  $("#ws-console").addEventListener("click", (e) => {
    if (window.getSelection()?.toString()) return;
    if (e.target.closest("button, a, input")) return;
    input.focus();
  });

  bus.on("workspace:console", () => input.focus());
  bus.on("console:run", (e) => { document.querySelector("#rail-console")?.click(); runLine(e.detail); });

  banner();
  updateMode();

  return { run: runLine, print, focus: () => input.focus() };
}
