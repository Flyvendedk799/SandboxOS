// jobs.js — background processes and the schedule.
//
// Two tables that answer "what is this machine doing when I am not looking at
// it": supervised processes started with proc.start (with a live log tail), and
// cron jobs that fire Kernel calls on a timer.

import {
  $, h, fill, api, bus, state, setState, toast, toastError, dialog, confirmDialog,
  fmtAgo, fmtDuration, emptyState,
} from "./core.js";
import { registerAction } from "./palette.js";
import { railBadge } from "./shell.js";

const PROC_KIND = { running: "accent", exited: "ok", failed: "err", stopped: "warn" };

export function initJobs() {
  const procsEl = $("#procs-list");
  const cronEl = $("#cron-list");
  let procs = [];
  let cron = [];
  let poll = null;
  const openLogs = new Set();

  // ── Background processes ───────────────────────────────────────────────────

  function procCard(p) {
    const running = p.state === "running";
    const card = h("div.item", null,
      h("div.item-head", null,
        running ? h("span.spinner") : null,
        h("span.item-title.grow.truncate", { title: p.cmd }, p.name),
        h("span.chip", { class: PROC_KIND[p.state] ?? "" }, p.state),
      ),
      h("div.item-meta.truncate", { title: p.cmd }, p.cmd),
      h("div.item-meta", [
        p.pid ? `pid ${p.pid}` : null,
        `${p.lines} line${p.lines === 1 ? "" : "s"}`,
        running ? `up ${fmtDuration(Date.now() - p.startedAt)}` : `ran ${fmtDuration((p.exitedAt ?? 0) - p.startedAt)}`,
        p.code != null ? `exit ${p.code}` : null,
      ].filter(Boolean).join(" · ")),
      h("div.item-actions", null,
        h("button.ghost.sm", { onclick: () => toggleLogs(p.id) }, openLogs.has(p.id) ? "Hide logs" : "Logs"),
        running
          ? h("button.ghost.sm.danger", { onclick: () => stop(p.id) }, "Stop")
          : h("button.ghost.sm", { onclick: () => forget(p.id) }, "Dismiss"),
      ),
    );
    if (openLogs.has(p.id)) card.append(h("div.log", { id: `log-${p.id}` }, "loading…"));
    return card;
  }

  function renderProcs() {
    setState({ procs });
    railBadge("jobs", procs.filter((p) => p.state === "running").length);
    if (!procs.length) {
      fill(procsEl, emptyState("▷", "Nothing running in the background",
        "Start a dev server or a watcher and it keeps running between requests, with its output captured here.",
        { label: "Run a process", run: start }));
      return;
    }
    fill(procsEl, ...procs.map(procCard));
    for (const id of openLogs) loadLogs(id);
  }

  async function loadLogs(id) {
    const host = $(`#log-${id}`);
    if (!host) return;
    try {
      const r = await api.mcp("proc", "logs", { id, tail: 300 });
      fill(host, ...(r.logs ?? []).map((l) => h("div", { class: l.stream === "stderr" ? "stderr" : "" }, l.text)));
      if (!r.logs?.length) fill(host, h("span.dim", `no output yet — ${r.state}`));
      host.scrollTop = host.scrollHeight;
    } catch (e) { fill(host, h("span.stderr", e.message)); }
  }

  function toggleLogs(id) {
    if (openLogs.has(id)) openLogs.delete(id); else openLogs.add(id);
    renderProcs();
  }

  async function start() {
    const got = await dialog({
      title: "Run a background process",
      message: "It keeps running after this request finishes; its output is captured for you to tail.",
      fields: [
        { name: "cmd", label: "Command", placeholder: "python3 -m http.server 8000" },
        { name: "name", label: "Label", placeholder: "server" },
      ],
      confirmLabel: "Run",
    });
    if (!got?.cmd) return;
    try {
      const p = await api.mcp("proc", "start", { cmd: got.cmd, name: got.name || undefined });
      toast("Process started", { body: `${p.name} · pid ${p.pid ?? "?"}`, kind: "ok" });
      openLogs.add(p.id);
      refresh();
    } catch (e) { toastError("Could not start the process", e); }
  }

  async function stop(id) {
    try { await api.mcp("proc", "stop", { id }); refresh(); }
    catch (e) { toastError("Could not stop the process", e); }
  }

  async function forget(id) {
    try { await api.mcp("proc", "forget", { id }); openLogs.delete(id); refresh(); }
    catch (e) { toastError("Could not dismiss the process", e); }
  }

  // ── Scheduled jobs ─────────────────────────────────────────────────────────

  function renderCron() {
    if (!cron.length) {
      fill(cronEl, emptyState("◴", "Nothing scheduled",
        "A scheduled job fires a Kernel call on a timer, with the capabilities of whoever scheduled it.",
        { label: "Schedule a job", run: schedule }));
      return;
    }
    fill(cronEl, h("table.data", null,
      h("thead", null, h("tr", null,
        h("th", "Job"), h("th", "Target"), h("th", "Next run"), h("th", "Repeat"), h("th.right", ""))),
      h("tbody", null, ...cron.map((j) => h("tr", null,
        h("td.mono", j.id),
        h("td.mono", `${j.server}.${j.tool}`),
        h("td", j.due_at ? new Date(j.due_at).toLocaleString() : "—"),
        h("td", j.interval_ms ? `every ${fmtDuration(j.interval_ms)}` : "once"),
        h("td.right", h("button.ghost.sm.danger", { onclick: () => cancel(j.id) }, "Cancel")),
      ))),
    ));
  }

  async function schedule() {
    const got = await dialog({
      title: "Schedule a job",
      message: "The job runs as you, with your capabilities — it can never do more than you can.",
      fields: [
        { name: "target", label: "Tool", placeholder: "proc.exec", hint: "server.tool" },
        { name: "args", label: "Arguments (JSON)", type: "textarea", rows: 3, value: "{}" },
        { name: "every", label: "Repeat every (minutes)", type: "number", placeholder: "0 = run once" },
        { name: "delay", label: "First run in (minutes)", type: "number", value: "1" },
      ],
      confirmLabel: "Schedule",
    });
    if (!got?.target) return;
    const [server, tool] = got.target.split(".");
    if (!server || !tool) return toast("Target must look like server.tool", { kind: "err" });
    let args;
    try { args = JSON.parse(got.args || "{}"); } catch { return toast("Arguments must be valid JSON", { kind: "err" }); }
    const everyMs = Number(got.every) * 60_000;
    try {
      if (everyMs > 0) await api.mcp("cron", "every", { intervalMs: everyMs, server, tool, args });
      else await api.mcp("cron", "at", { delayMs: Math.max(1, Number(got.delay) || 1) * 60_000, server, tool, args });
      toast("Job scheduled", { kind: "ok" });
      refresh();
    } catch (e) { toastError("Could not schedule the job", e); }
  }

  async function cancel(id) {
    if (!await confirmDialog("Cancel this job?", `Job ${id} will not fire again.`, { confirmLabel: "Cancel job" })) return;
    try { await api.mcp("cron", "cancel", { id }); refresh(); }
    catch (e) { toastError("Could not cancel the job", e); }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  async function refresh() {
    const [p, c] = await Promise.all([
      api.tryMcp("proc", "jobs", {}),
      api.tryMcp("cron", "list", {}),
    ]);
    procs = p?.jobs ?? [];
    cron = c?.jobs ?? [];
    renderProcs();
    renderCron();
    clearTimeout(poll);
    if (procs.some((x) => x.state === "running")) poll = setTimeout(refresh, 3000);
  }

  $("#jobs-refresh").addEventListener("click", refresh);
  $("#proc-start-btn").addEventListener("click", start);
  bus.on("workspace:jobs", refresh);
  bus.on("kernel:mutated", (e) => { if (/^(run|jobs|logs|stop)\b/.test(e.detail?.line ?? "")) refresh(); });
  registerAction({ group: "Actions", icon: "play", label: "Run a background process", run: start });
  registerAction({ group: "Actions", icon: "jobs", label: "Schedule a job", run: schedule });

  refresh();
  return { refresh, start };
}
