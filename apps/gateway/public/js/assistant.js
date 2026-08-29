// assistant.js — the chat workspace.
//
// What makes this different from a chat box bolted onto a product: every tool
// call the model makes is a real Kernel call against this machine, so the
// transcript is not a description of work, it *is* the work. Tool cards render
// inline as they run — name, arguments, and the result — and each one is
// simultaneously landing in the audit dock two panels over.

import {
  $, h, fill, clear, icon, api, bus, state, slug, toast, toastError,
  dialog, confirmDialog, menu, fmtAgo, emptyState, mod,
} from "./core.js";
import { registerAction } from "./palette.js";

/** Render a JSON value compactly enough to scan in a tool card. */
function preview(value, max = 160) {
  if (value == null) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function initAssistant() {
  const listEl = $("#chat-list");
  const streamEl = $("#chat-stream");
  const inputEl = $("#chat-input");
  const sendBtn = $("#chat-send");
  const stopBtn = $("#chat-stop");
  const titleEl = $("#chat-title");

  let chats = [];
  let chatId = null;
  let controller = null;
  let liveText = null;   // the streaming assistant paragraph
  const liveTools = new Map(); // tool id → card element

  // ── Conversation list ──────────────────────────────────────────────────────

  function renderList() {
    if (!chats.length) {
      fill(listEl, h("div.dim", { style: { padding: "var(--s-3)", fontSize: "var(--fs-xs)" } }, "No conversations yet."));
      return;
    }
    fill(listEl, ...chats.map((c) => h("div.chat-item", {
      class: c.id === chatId ? "selected" : "",
      onclick: () => open(c.id),
      oncontextmenu: (e) => { e.preventDefault(); chatMenu(e, c); },
    },
      h("span.nm.truncate", c.title || "Untitled"),
      h("span.dim", { style: { fontSize: "10px" } }, fmtAgo(c.updated_at)),
    )));
  }

  function chatMenu(e, c) {
    menu({ x: e.clientX, y: e.clientY }, [
      { label: "Rename…", run: () => rename(c) },
      { label: "Delete", icon: "trash", danger: true, run: () => remove(c) },
    ]);
  }

  async function refreshList() {
    try {
      chats = (await api.get("chats")).chats ?? [];
      renderList();
    } catch (e) { toastError("Could not load conversations", e); }
  }

  async function rename(c) {
    const got = await dialog({ title: "Rename conversation", fields: [{ name: "title", label: "Title", value: c.title ?? "" }], confirmLabel: "Rename" });
    if (!got) return;
    await fetch(`/${slug}/chats/${c.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: got.title }),
    });
    refreshList();
  }

  async function remove(c) {
    if (!await confirmDialog("Delete this conversation?", `“${c.title || "Untitled"}” and its transcript are removed.`)) return;
    await api.del(`chats/${c.id}`);
    if (chatId === c.id) { chatId = null; showBlank(); }
    refreshList();
  }

  // ── Transcript ─────────────────────────────────────────────────────────────

  function bubble(role, text) {
    return h("div.msg", { class: role },
      h("div.msg-role", role === "user" ? "you" : "assistant"),
      h("div.msg-body", text),
    );
  }

  function toolCard(name, args) {
    const card = h("div.tool-card", null,
      h("div.tool-head", null,
        h("span.spinner"),
        h("span.mono.grow", name),
        h("span.chip", "running"),
      ),
      h("div.tool-args.mono", preview(args, 240)),
    );
    return card;
  }

  function completeToolCard(card, { ok, result, error }) {
    const head = card.querySelector(".tool-head");
    head.querySelector(".spinner")?.remove();
    const chip = head.querySelector(".chip");
    chip.textContent = ok ? "ok" : "error";
    chip.className = `chip ${ok ? "ok" : "err"}`;
    card.append(h("div.tool-result.mono", { class: ok ? "" : "stderr" },
      ok ? preview(result, 600) || "(no result)" : error));
  }

  function atBottom() {
    return streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 80;
  }
  function scroll(force = false) {
    if (force || atBottom()) streamEl.scrollTop = streamEl.scrollHeight;
  }

  function showBlank() {
    titleEl.textContent = "Assistant";
    fill(streamEl, emptyState("✦", "Ask this machine to do something",
      `The assistant holds exactly your capabilities and reaches for the same MCP tools you would type. Try “what is in this sandbox?” or “start a static server on port 8080 and expose it”. Press ${mod}+Enter to send.`,
      { label: "New conversation", run: newChat }));
  }

  function renderTranscript(transcript) {
    clear(streamEl);
    const pending = new Map();
    for (const item of transcript) {
      if (item.kind === "text") {
        if (item.role === "tool") continue;
        streamEl.append(bubble(item.role, item.text));
      } else if (item.kind === "tool_call") {
        const card = toolCard(item.name, item.args);
        pending.set(item.id, card);
        streamEl.append(card);
      } else if (item.kind === "tool_result") {
        const card = pending.get(item.id);
        if (card) {
          const isError = item.text.startsWith("Error:");
          completeToolCard(card, { ok: !isError, result: item.text, error: item.text });
        }
      }
    }
    // Anything still spinning was interrupted (a reload mid-turn).
    for (const card of pending.values()) {
      if (card.querySelector(".spinner")) {
        card.querySelector(".spinner").remove();
        const chip = card.querySelector(".chip");
        chip.textContent = "interrupted";
        chip.className = "chip warn";
      }
    }
    if (!streamEl.childElementCount) {
      streamEl.append(emptyState("✦", "Empty conversation", "Say something to get started."));
    }
    scroll(true);
  }

  async function open(id) {
    chatId = id;
    renderList();
    try {
      const r = await api.get(`chats/${id}`);
      titleEl.textContent = r.chat.title || "Untitled";
      renderTranscript(r.transcript ?? []);
      inputEl.focus();
    } catch (e) { toastError("Could not open the conversation", e); }
  }

  async function newChat() {
    try {
      const r = await api.post("chats", {});
      chats.unshift({ ...r.chat, messages: 0 });
      chatId = r.chat.id;
      renderList();
      titleEl.textContent = "New conversation";
      clear(streamEl);
      streamEl.append(emptyState("✦", "New conversation", "Ask for something and watch it happen."));
      inputEl.focus();
    } catch (e) { toastError("Could not start a conversation", e); }
  }

  // ── Sending a turn ─────────────────────────────────────────────────────────

  function setBusy(busy) {
    sendBtn.disabled = busy;
    stopBtn.disabled = !busy;
    inputEl.disabled = false; // typing ahead while it works is fine
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    if (!chatId) await newChat();
    if (!chatId) return;

    inputEl.value = "";
    inputEl.style.height = "";
    // The server titles an untitled conversation after its first message; mirror
    // that here so the header does not sit on "New conversation" until a reload.
    const current = chats.find((c) => c.id === chatId);
    if (current && !current.title) {
      current.title = text.slice(0, 60);
      titleEl.textContent = current.title;
      renderList();
    }
    if (streamEl.querySelector(".empty")) clear(streamEl);
    streamEl.append(bubble("user", text));
    scroll(true);

    liveText = null;
    liveTools.clear();
    controller = new AbortController();
    setBusy(true);

    const thinking = h("div.msg.assistant.thinking", null,
      h("div.msg-role", "assistant"),
      h("div.msg-body.row", null, h("span.spinner"), h("span.dim", "thinking…")));
    streamEl.append(thinking);
    scroll(true);

    try {
      const res = await fetch(`/${slug}/chats/${chatId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text }),
        signal: controller.signal,
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
          if (ev.type === "end") done = true;
          handle(ev, thinking);
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        streamEl.append(h("div.msg.error", null, h("div.msg-role", "error"), h("div.msg-body", e.message)));
      }
    } finally {
      thinking.remove();
      setBusy(false);
      controller = null;
      scroll();
      refreshList();
      bus.emit("kernel:mutated", { line: "assistant" });
    }
  }

  function handle(ev, thinking) {
    switch (ev.type) {
      case "text": {
        thinking.remove();
        if (!liveText) {
          liveText = bubble("assistant", "");
          streamEl.append(liveText);
        }
        liveText.querySelector(".msg-body").append(document.createTextNode(ev.text));
        scroll();
        break;
      }
      case "tool_call": {
        thinking.remove();
        liveText = null; // prose after a tool call starts a new paragraph
        const card = toolCard(`${ev.server}.${ev.tool}`, ev.args);
        liveTools.set(ev.id, card);
        streamEl.append(card);
        scroll();
        break;
      }
      case "tool_result": {
        const card = liveTools.get(ev.id);
        if (card) completeToolCard(card, ev);
        scroll();
        break;
      }
      case "stopped":
        streamEl.append(h("div.msg.note", null, h("div.msg-body.dim", `stopped: ${ev.reason.replace(/_/g, " ")}`)));
        scroll();
        break;
      case "error":
        streamEl.append(h("div.msg.error", null, h("div.msg-role", "error"), h("div.msg-body", ev.error)));
        scroll();
        break;
      case "done":
        if (ev.tokens) titleEl.title = `${ev.tokens} tokens · ${ev.steps} step${ev.steps === 1 ? "" : "s"}`;
        break;
      default:
        break;
    }
  }

  function stop() {
    controller?.abort();
    setBusy(false);
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
  });

  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", stop);
  $("#chat-new").addEventListener("click", newChat);

  bus.on("workspace:assistant", () => {
    if (!chats.length) refreshList();
    inputEl.focus();
  });

  registerAction({
    group: "Actions", icon: "assistant", label: "Ask the assistant",
    run: () => { document.querySelector("#rail-assistant")?.click(); inputEl.focus(); },
  });

  setBusy(false);
  showBlank();
  refreshList();

  return {
    refresh: refreshList,
    /** Open the assistant with a question already typed in. */
    ask(question) {
      document.querySelector("#rail-assistant")?.click();
      inputEl.value = question;
      send();
    },
  };
}
