// agents.js — spawn, watch and steer the fleet.
//
// An agent is a supervised task with its own attenuated principal. This panel
// shows what each one is, what it was granted, and what it produced — plus a
// live event tail per agent while it runs.

import {
  $, h, fill, icon, api, bus, state, toast, toastError, dialog, confirmDialog,
  fmtAgo, fmtDuration, emptyState,
} from "./core.js";
import { railBadge } from "./shell.js";
import { registerAction } from "./palette.js";

const STATE_KIND = { queued: "info", running: "accent", done: "ok", failed: "err", killed: "warn" };

export function initAgents() {
  const list = $("#agents-list");
  let agents = [];
  let poll = null;

  function card(a) {
    const running = a.state === "queued" || a.state === "running";
    return h("div.item", null,
      h("div.item-head", null,
        running ? h("span.spinner") : null,
        h("span.item-title.grow.truncate", a.name),
        h("span.chip", { class: STATE_KIND[a.state] ?? "" }, a.state),
      ),
      h("div.item-meta.truncate", { title: a.cmd || a.prompt || "" }, a.kind === "ai" ? "AI" : "shell", " · ", a.cmd || a.prompt || "—"),
      h("div.item-meta", a.finished_at
        ? `ran ${fmtDuration((a.finished_at ?? 0) - (a.started_at ?? a.created_at))} · ${fmtAgo(a.finished_at)}`
        : `started ${fmtAgo(a.created_at)}`),
      h("div.item-actions", null,
        h("button.ghost.sm", { onclick: () => detail(a.id) }, "Details"),
        running
          ? h("button.ghost.sm.danger", { onclick: () => kill(a.id) }, "Kill")
          : h("button.ghost.sm", { onclick: () => rerun(a) }, "Run again"),
      ),
    );
  }

  function render() {
    if (!agents.length) {
      fill(list, emptyState("◇", "No agents yet",
        "Spawn one to delegate work. Shell agents run a command; AI agents drive a tool loop with the capabilities you grant them.",
        { label: "Spawn an agent", run: spawn }));
      return;
    }
    fill(list, ...agents.map(card));
    railBadge("agents", agents.filter((a) => a.state === "running" || a.state === "queued").length);
  }

  async function refresh() {
    try {
      const r = await api.get("agents");
      agents = r.agents ?? [];
      render();
      schedulePoll();
    } catch (e) {
      fill(list, emptyState("!", "Could not load agents", e.message));
    }
  }

  /** Poll only while something is in flight — a still fleet costs nothing. */
  function schedulePoll() {
    clearTimeout(poll);
    if (agents.some((a) => a.state === "running" || a.state === "queued")) {
      poll = setTimeout(refresh, 2000);
    }
  }

  async function detail(id) {
    let a;
    try { a = (await api.get(`agents/${id}`)).agent; } catch (e) { return toastError("Agent not found", e); }
    await dialog({
      title: a.name,
      wide: true,
      confirmLabel: "Close",
      render: () => h("div.col", { style: { gap: "var(--s-3)" } },
        h("div.row", null,
          h("span.chip", { class: STATE_KIND[a.state] ?? "" }, a.state),
          h("span.chip.mono", a.kind),
          a.exit_code != null ? h("span.chip.mono", `exit ${a.exit_code}`) : null,
        ),
        h("div.field", null, h("label", "Command"), h("div.log", a.cmd || a.prompt || "—")),
        h("div.field", null, h("label", "Granted capabilities"),
          h("div.row", { style: { flexWrap: "wrap" } },
            ...(a.patterns ?? []).map((p) => h("span.chip.mono.accent", p)))),
        a.result ? h("div.field", null, h("label", "Result"), h("div.log", a.result)) : null,
        a.error ? h("div.field", null, h("label", "Error"), h("div.log.stderr", a.error)) : null,
      ),
    });
  }

  async function kill(id) {
    if (!await confirmDialog("Kill agent?", "The agent is marked killed; a shell command already running may finish on its own.")) return;
    try {
      await api.del(`agents/${id}`);
      toast("Agent killed", { kind: "ok" });
      refresh();
    } catch (e) { toastError("Could not kill the agent", e); }
  }

  async function spawn(prefill = {}) {
    const got = await dialog({
      title: "Spawn an agent",
      fields: [
        { name: "name", label: "Name", placeholder: "build", value: prefill.name ?? "" },
        { name: "kind", label: "Kind", type: "select", value: prefill.kind ?? "shell",
          options: [{ value: "shell", label: "shell — run a command" }, { value: "ai", label: "AI — drive a tool loop" }] },
        { name: "task", label: "Command or prompt", type: "textarea", rows: 3, value: prefill.task ?? "" },
        { name: "patterns", label: "Capabilities", value: prefill.patterns ?? "proc.exec",
          hint: "Comma-separated patterns. An agent can never hold more than you do." },
      ],
      confirmLabel: "Spawn",
    });
    if (!got?.name || !got.task) return;
    const patterns = got.patterns.split(",").map((p) => p.trim()).filter(Boolean);
    try {
      await api.mcp("agents", "spawn", {
        name: got.name,
        kind: got.kind,
        patterns: patterns.length ? patterns : ["proc.exec"],
        ...(got.kind === "ai" ? { prompt: got.task } : { cmd: got.task }),
      });
      toast("Agent spawned", { body: got.name, kind: "ok" });
      refresh();
    } catch (e) { toastError("Spawn failed", e); }
  }

  const rerun = (a) => spawn({
    name: a.name, kind: a.kind, task: a.cmd || a.prompt || "",
    patterns: (a.patterns ?? ["proc.exec"]).join(", "),
  });

  $("#agents-refresh").addEventListener("click", refresh);
  $("#agent-spawn-btn").addEventListener("click", () => spawn());
  bus.on("workspace:agents", refresh);
  bus.on("kernel:mutated", (e) => { if (/^agents?\b/.test(e.detail?.line ?? "")) refresh(); });
  registerAction({ group: "Actions", icon: "agents", label: "Spawn an agent", run: () => spawn() });

  refresh();
  return { refresh, spawn };
}
