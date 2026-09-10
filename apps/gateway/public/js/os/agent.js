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

import { h, fill, icon, api, slug, toast, toastError } from "../core.js";
import { call, onOs, os } from "./client.js";
// The impact table is shared with the tool that reports it, served from
// packages/os, so the panel and the Kernel cannot disagree about what a call
// touches.
import { proposalImpact } from "/static/js/os/lib/proposals.js";

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
  "Tidy this workspace",
  "Summarize my desktop",
];

function preview(value, max = 90) {
  if (value == null) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function createAgentPanel({ onClose, quick = QUICK, title = "Build agent", onTool, review = false } = {}) {
  const log = h("div.agent-log");
  // Review mode: the agent's desktop changes arrive as a proposal you read before
  // anything moves (goal.md T2.3). It is per person and per surface, remembered
  // in the browser, because it is a working preference and not desktop truth.
  let propose = review && localStorage.getItem("sbx.agent.review") !== "0";
  const proposalsEl = h("div.agent-proposals");
  const reviewBtn = h("button.chip", {
    title: "Review the agent's desktop changes before they happen",
    onclick: () => { propose = !propose; localStorage.setItem("sbx.agent.review", propose ? "1" : "0"); paintReview(); },
  });
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
    proposalsEl,
    h("div.quick-row", ...(review ? [reviewBtn] : []), ...quick.map((q) => h("button.chip", { onclick: () => submit(q) }, q))),
    h("div.composer", null, input, send),
  );

  /**
   * What a proposal would do: which parts of the document it touches, then the
   * exact calls.
   *
   * Deliberately not a predicted diff. The ops have not run, so their effect can
   * only be simulated by running them — and a prediction that turned out wrong
   * would be worse than no prediction. What *is* true before anything happens is
   * which sections each call changes (`proposalImpact`), and after applying, the
   * history's own structural diff says exactly what did change: measured rather
   * than guessed. The last-applied line below is the way to it.
   */
  function paintProposals() {
    if (!review) return;
    const list = os.doc?.proposals ?? [];
    if (!list.length) { fill(proposalsEl, ...(lastApplied ? [appliedRow()] : [])); return; }
    fill(proposalsEl, ...list.map((p) => {
      const impact = proposalImpact(p);
      return h("div.proposal", null,
        h("div.hd", null,
          h("b", p.label),
          h("span.dim", `${p.ops.length} change${p.ops.length === 1 ? "" : "s"}`)),
        h("div.touches", null,
          h("span.dim", "would change"),
          ...impact.sections.map((sec) => h("span.chip-tag", sec)),
          ...(impact.unknown ? [h("span.chip-tag.warn", `unknown: ${impact.unknown.join(", ")}`)] : [])),
        h("div.ops", null, ...p.ops.map((op) => h("div.op", null,
          h("code", `desktop.${op.tool}`), h("span.dim", preview(op.args, 60))))),
        h("div.act", null,
          h("button.app-btn.primary", { onclick: () => applyProposal(p) }, "Apply"),
          h("button.app-btn", { onclick: () => discardProposal(p) }, "Discard")),
      );
    }), ...(lastApplied ? [appliedRow()] : []));
  }

  /** After applying: the diff that actually happened, on request. */
  let lastApplied = null;
  function appliedRow() {
    return h("div.proposal.applied", null,
      h("div.hd", null, h("b", lastApplied.label), h("span.dim", `applied · r${lastApplied.rev}`)),
      h("div.act", null,
        h("button.app-btn", { onclick: () => showApplied() }, "What changed"),
        h("button.app-btn", { onclick: () => { lastApplied = null; paintProposals(); } }, "Dismiss")));
  }

  async function showApplied() {
    try {
      const r = await api.mcp("desktop", "history", { rev: Math.max(0, lastApplied.rev - lastApplied.ops) });
      const d = r.diff ?? {};
      const part = (k, v) => (v && (v.added || v.removed || v.changed)
        ? `${k} +${v.added} −${v.removed} ~${v.changed}`
        : Array.isArray(v) && v.length ? `${k} (${v.join(", ")})` : null);
      const said = ["windows", "widgets", "workspaces", "theme", "animation", "wm", "shell", "apps"]
        .map((k) => part(k, d[k])).filter(Boolean);
      toast(`${lastApplied.label}`, {
        body: said.length ? said.join(" · ") : "nothing changed structurally",
        timeout: 7000,
      });
    } catch (e) { toastError("Could not read what changed", e); }
  }

  async function applyProposal(p) {
    try {
      const r = await call("applyProposal", { id: p.id });
      // Each op was its own revision, so the diff of what happened starts that
      // many revisions back. Kept so "what changed" is answerable afterwards.
      lastApplied = { label: p.label, rev: r.rev, ops: (r.applied?.length ?? 0) + 1 };
      if (r.failure) toast("Partly applied", { body: `${r.failure.tool}: ${r.failure.error}`, kind: "err", timeout: 5000 });
      else toast("Applied", { body: `${r.applied.length} change${r.applied.length === 1 ? "" : "s"}`, timeout: 2200 });
      paintProposals();
    } catch (e) { toastError("Could not apply it", e); }
  }
  async function discardProposal(p) {
    try { await call("discardProposal", { id: p.id }); }
    catch (e) { toastError("Could not discard it", e); }
  }

  function paintReview() {
    reviewBtn.classList.toggle("on", propose);
    fill(reviewBtn, icon(propose ? "eye" : "play", 12), propose ? "Review changes" : "Apply directly");
  }
  if (review) { paintReview(); paintProposals(); }
  const offOs = review ? onOs((kind) => { if (kind === "doc" || kind === "local") paintProposals(); }) : null;

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
        body: JSON.stringify({ input: line, ...(propose ? { propose: true } : {}) }),
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
      case "tool_call": {
        liveText = null;
        const card = toolCard(`${ev.server}.${ev.tool}`, ev.args);
        card.dataset.server = ev.server; card.dataset.tool = ev.tool;
        card._args = ev.args;
        liveTools.set(ev.id, card);
        break;
      }
      case "tool_result": {
        const card = liveTools.get(ev.id);
        if (!card) break;
        const res = card.querySelector(".res");
        res.classList.toggle("err", ev.ok === false);
        res.textContent = ev.ok === false ? (ev.error ?? "failed") : preview(ev.result ?? "ok");
        // A card that touched the desktop is a link back into the builder: the
        // file it wrote opens in Code, the window it opened gets selected.
        if (ev.ok !== false && card.dataset.server === "desktop") {
          const link = onTool?.({ tool: card.dataset.tool, args: card._args ?? {}, result: ev.result });
          if (link) {
            card.classList.add("linked");
            card.querySelector(".hd").append(h("button.reveal", { onclick: () => link.run() }, link.label));
            if (link.auto) link.run();
          }
        }
        break;
      }
      case "proposal":
        say("agent", `Queued ${ev.ops} change${ev.ops === 1 ? "" : "s"} for review — read them below and apply or discard.`);
        paintProposals();
        break;
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

  return { el, focus: () => input.focus(), submit, destroy: () => offOs?.() };
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
