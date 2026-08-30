// agent.js — the build agent.
//
// This is not a chat bolted onto a builder. It is the same streaming tool-use
// loop Command Central runs, pointed at a machine whose desktop is now part of
// the tool surface. "Add a weather widget", "make it warmer", "write me a little
// app that lists my ports" are `desktop.widgetAdd`, `desktop.themeSet` and
// `desktop.appDefine` + `desktop.appWrite` — real calls, rendered inline as they
// run, landing in the same audit log as everything else.
//
// The panel and the built-in Assistant window share this code, so a conversation
// looks and behaves the same wherever you have it open.

import { h, fill, icon, api, slug, toastError } from "../core.js";

const SYSTEM_HINT = [
  "Ask for a window, a widget, a colour, a whole app.",
  "Try: “add a clock widget”, “switch to the aurora theme”, “tile the windows”,",
  "or “build me a small app that shows my exposed ports”.",
].join(" ");

const QUICK = [
  "Aurora theme",
  "Add a weather widget",
  "Tile the windows",
  "Build me a port monitor app",
];

function preview(value, max = 90) {
  if (value == null) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function createAgentPanel({ onClose, quick = QUICK, title = "Build agent" } = {}) {
  const log = h("div.agent-log");
  const input = h("textarea", { rows: 1, placeholder: "Ask the agent to build or restyle…" });
  const send = h("button.send", { title: "Send" }, icon("send", 15));
  let chatId = null;
  let busy = false;
  const liveTools = new Map();
  let liveText = null;

  const el = h("aside.stx-agent", null,
    h("div.panel-head", null,
      h("span", { style: { color: "var(--stx-agent)", display: "flex" } }, icon("assistant", 15)),
      h("span.title", title),
      h("span.spacer"),
      onClose ? h("button.rail-btn", { style: { width: "24px", height: "24px" }, onclick: onClose }, icon("x", 13)) : null,
    ),
    log,
    h("div.quick-row", ...quick.map((q) => h("button.chip", { onclick: () => submit(q) }, q))),
    h("div.composer", null, input, send),
  );

  function bubble(role, text) {
    return h("div.agent-msg", { class: role },
      h("span.who", role === "user" ? "You" : "Agent"),
      h("div.txt", text));
  }

  function say(role, text) {
    const b = bubble(role, text);
    log.append(b);
    log.scrollTop = 1e6;
    return b;
  }

  say("agent", SYSTEM_HINT);

  function toolCard(name, args) {
    const card = h("div.tool-card", null,
      h("div.hd", null, h("b", name), h("span", preview(args))),
      h("div.res", null, h("span.spinner")));
    log.append(card);
    log.scrollTop = 1e6;
    return card;
  }

  async function ensureChat() {
    if (chatId) return chatId;
    const r = await api.post(`/${slug}/chats`, {});
    chatId = r.chat.id;
    return chatId;
  }

  function setBusy(v) {
    busy = v;
    send.disabled = v;
    send.replaceChildren(v ? h("span.spinner") : icon("send", 15));
  }

  async function submit(text) {
    const line = (text ?? input.value).trim();
    if (!line || busy) return;
    input.value = "";
    input.style.height = "";
    say("user", line);
    liveText = null;
    liveTools.clear();
    setBusy(true);

    try {
      await ensureChat();
      const res = await fetch(`/${slug}/chats/${chatId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: line }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const payload = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (!payload) continue;
          let ev;
          try { ev = JSON.parse(payload); } catch { continue; }
          handle(ev);
        }
      }
    } catch (e) {
      say("agent", `I could not finish that: ${e.message}`);
      if (/HTTP 4/.test(e.message)) {
        say("agent", "If no provider key is configured yet, add one in Settings — the rest of the OS works without it.");
      }
    } finally {
      setBusy(false);
    }
  }

  function handle(ev) {
    switch (ev.type) {
      case "text":
        if (!liveText) liveText = say("agent", "");
        liveText.querySelector(".txt").append(document.createTextNode(ev.text));
        log.scrollTop = 1e6;
        break;
      case "tool_call":
        liveText = null;
        liveTools.set(ev.id, toolCard(`${ev.server}.${ev.tool}`, ev.args));
        break;
      case "tool_result": {
        const card = liveTools.get(ev.id);
        if (!card) break;
        const res = card.querySelector(".res");
        res.classList.toggle("err", ev.ok === false);
        res.textContent = ev.ok === false ? (ev.error ?? "failed") : preview(ev.result ?? "ok");
        break;
      }
      case "error":
        say("agent", `error: ${ev.error ?? "unknown"}`);
        break;
      default:
        break;
    }
  }

  send.addEventListener("click", () => submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  });

  return { el, focus: () => input.focus(), submit };
}

/** The Assistant built-in app: the same agent, inside a window. */
export function mountAssistantWindow(host) {
  const panel = createAgentPanel({ title: "Assistant", quick: QUICK.slice(0, 3) });
  panel.el.classList.remove("stx-agent");
  Object.assign(panel.el.style, { width: "100%", height: "100%", background: "transparent", borderLeft: "0", display: "flex", flexDirection: "column" });
  panel.el.querySelector(".panel-head")?.remove();
  fill(host, panel.el);
  return () => {};
}
