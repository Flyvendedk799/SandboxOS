// ops.js — the machine's own work, as apps on the desktop.
//
// Command Central could start a dev server, expose it, watch its logs, share it
// and read the audit trail. The desktop could not, so "live in your machine"
// ended at the first real task and sent you to a console (goal.md Track 1).
// These are the seven apps that close that gap: Jobs, Ports, Agents, Secrets,
// Sync, Access and Audit.
//
// They are ordinary built-ins — the same window manager, the same `needs`
// declaration, the same Kernel. Every one of them is a thin, honest client of
// tools an agent can call itself; none has a private channel, and where a
// reading is unavailable they say so rather than showing a plausible zero.

import {
  h, fill, icon, api, slug, fmtBytes, toast, toastError, dialog, confirmDialog, menu,
} from "../core.js";
import { call, os } from "./client.js";

// ── shared furniture ────────────────────────────────────────────────────────

const ago = (ts) => {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

const clock = (ts) => (ts ? new Date(Number(ts)).toLocaleTimeString() : "—");

/** An app shell: a bar, a body, and a poll that stops with the window. */
function frame(host, { bar, body }) {
  fill(host, h("div.app", null, bar, body));
}

/** Poll while the window is open. Returns a stopper the mount hands back. */
function poll(fn, ms) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await fn(); } catch { /* the panel shows its own error */ }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  let timer = setTimeout(tick, ms);
  return () => { stopped = true; clearTimeout(timer); };
}

/** A state that reads as a state: running, exited, failed, denied. */
const pill = (text, kind = "") => h("span.ops-pill", { class: kind }, text);

const emptyCard = (glyph, title, ...body) =>
  h("div.empty", null, icon(glyph, 26), h("h3", title), ...body.map((b) => (typeof b === "string" ? h("p", b) : b)));

/** The panel every app uses to say "this did not work, and here is why". */
const errorCard = (e) => h("div.ops-error", null, icon("bell", 14), h("span", e?.message ?? String(e)));

const rows = (list, render) => (list.length ? list.map(render) : [h("div.dim.ops-none", "nothing here yet")]);

// ── Jobs ────────────────────────────────────────────────────────────────────
//
// Supervised processes and the cron schedule: what is running, what it printed,
// what it will do next. Everything here is `proc.*` and `cron.*`.

const jobs = {
  mount(host, win, ctx) {
    let jobList = [];
    let sessions = [];
    let crons = [];
    // Exposed ports that answer. Deliberately not claimed as "this job's": a
    // supervised process does not tell the machine which ports it bound, and
    // guessing would be a confident lie. What a person wants after starting a dev
    // server is the URL, and this is where they are looking.
    let openPorts = [];
    let selected = win.props?.job ?? null;
    let follow = win.props?.follow !== false;
    let filter = "";
    let logs = [];
    let error = null;
    let tab = win.props?.tab === "schedule" ? "schedule" : "jobs";

    const listEl = h("div.ops-list");
    const paneEl = h("div.ops-pane");
    const body = h("div.app-body.ops-split", null, listEl, paneEl);
    const bar = h("div.app-bar", null,
      h("button.app-btn", { onclick: () => startDialog() }, icon("plus", 12), "Start…"),
      h("button.app-btn", { onclick: () => scheduleDialog() }, icon("clock", 12), "Schedule…"),
      h("span.spacer"),
      h("div.chip-row", null,
        h("button.chip", { class: tab === "jobs" ? "on" : "", onclick: () => { tab = "jobs"; save(); paint(); } }, "Running"),
        h("button.chip", { class: tab === "schedule" ? "on" : "", onclick: () => { tab = "schedule"; save(); paint(); } }, "Schedule")),
      h("button.app-btn", { title: "Refresh", onclick: () => refresh() }, icon("refresh", 12)),
    );
    frame(host, { bar, body });

    const save = () => call("windowSet", { id: win.id, props: { job: selected, follow, tab } }).catch(() => {});

    async function refresh() {
      try {
        const [j, s, c, p] = await Promise.all([
          api.mcp("proc", "jobs", {}),
          api.tryMcp("proc", "sessions", {}),
          api.tryMcp("cron", "list", {}),
          api.tryMcp("ports", "list", {}),
        ]);
        jobList = j.jobs ?? [];
        sessions = s?.sessions ?? [];
        crons = c?.jobs ?? c?.schedule ?? [];
        openPorts = (p?.ports ?? []).filter((x) => x.up);
        error = null;
      } catch (e) { error = e; }
      if (selected && follow) await loadLogs();
      paint();
    }

    async function loadLogs() {
      if (!selected) { logs = []; return; }
      try {
        const r = await api.mcp("proc", "logs", { id: selected, tail: 400 });
        logs = r.logs ?? [];
        const rec = jobList.find((x) => x.id === selected);
        if (rec) Object.assign(rec, { state: r.state, code: r.code });
      } catch (e) { logs = [{ ts: Date.now(), stream: "stderr", text: e.message }]; }
    }

    async function startDialog() {
      const got = await dialog({
        title: "Start a process",
        message: "It is supervised: it outlives this window, its output is captured, and stopping it stops what it started.",
        fields: [
          { name: "cmd", label: "Command", placeholder: "npm run dev" },
          { name: "name", label: "Label", placeholder: "web" },
        ],
        confirmLabel: "Start",
      });
      if (!got?.cmd) return;
      try {
        const rec = await api.mcp("proc", "start", { cmd: got.cmd, ...(got.name ? { name: got.name } : {}) });
        selected = rec.id; follow = true; save();
        toast(`Started ${rec.name}`, { body: rec.cmd, timeout: 2500 });
        refresh();
      } catch (e) { toastError("Could not start it", e); }
    }

    async function scheduleDialog() {
      const got = await dialog({
        title: "Schedule a tool call",
        message: "The scheduler calls it on your behalf, with your capabilities, and every run is audited.",
        fields: [
          { name: "target", label: "Tool", placeholder: "proc.exec", hint: "server.tool" },
          { name: "args", label: "Arguments (JSON)", type: "textarea", rows: 3, value: '{ "cmd": "echo hello" }' },
          { name: "every", label: "Repeat every (minutes)", type: "number", placeholder: "0 = run once" },
          // The tool takes milliseconds; a person thinks in minutes. The
          // translation happens here rather than in the tool, because "every
          // 1800000" is not a thing anybody means to type.
        ],
        confirmLabel: "Schedule",
      });
      if (!got?.target) return;
      let args = {};
      try { args = got.args ? JSON.parse(got.args) : {}; }
      catch { toastError("Arguments must be JSON", new Error("could not parse the arguments")); return; }
      const [server, tool] = String(got.target).split(".");
      const every = Number(got.every) || 0;
      try {
        if (every > 0) await api.mcp("cron", "every", { intervalMs: every * 60_000, server, tool, args });
        else await api.mcp("cron", "at", { at: Date.now() + 1000, server, tool, args });
        tab = "schedule"; save(); refresh();
      } catch (e) { toastError("Could not schedule it", e); }
    }

    function jobMenu(at, rec) {
      menu(at, [
        { label: "Follow the log", run: () => { selected = rec.id; follow = true; save(); loadLogs().then(paint); } },
        rec.state === "running"
          ? { label: "Stop", icon: "stop", run: () => act(() => api.mcp("proc", "stop", { id: rec.id })) }
          : { label: "Start it again", icon: "play", run: () => act(() => api.mcp("proc", "start", { cmd: rec.cmd, name: rec.name })) },
        "-",
        { label: "Forget", icon: "trash", danger: true, disabled: rec.state === "running",
          run: () => act(() => api.mcp("proc", "forget", { id: rec.id })) },
      ]);
    }

    async function act(fn) {
      try { await fn(); refresh(); }
      catch (e) { toastError("That did not work", e); }
    }

    function paint() {
      if (tab === "schedule") return paintSchedule();

      fill(listEl,
        error ? errorCard(error) : null,
        h("div.ops-head", "Processes"),
        ...rows(jobList, (rec) => h("button.row-line", {
          class: rec.id === selected ? "on" : "",
          onclick: () => { selected = rec.id; save(); loadLogs().then(paint); },
          oncontextmenu: (e) => { e.preventDefault(); jobMenu({ x: e.clientX, y: e.clientY }, rec); },
        },
          h("span", null, h("b", rec.name), h("span.dim", ` ${rec.cmd.slice(0, 40)}`)),
          pill(rec.failure ? "never started" : rec.state, rec.state === "running" ? "ok" : rec.state === "failed" || rec.failure ? "err" : ""),
        )),
        // Shells are processes too, and this is where you look for processes.
        h("div.ops-head", "Shells"),
        ...rows(sessions, (s) => h("button.row-line", {
          onclick: () => ctx.launch?.("terminal", { tabs: [{ id: "t1", title: s.name, session: s.id }], active: "t1" }),
          oncontextmenu: (e) => {
            e.preventDefault();
            menu({ x: e.clientX, y: e.clientY }, [
              { label: "Open in a Terminal", run: () => ctx.launch?.("terminal", { tabs: [{ id: "t1", title: s.name, session: s.id }], active: "t1" }) },
              { label: "End session", danger: true, run: () => act(() => api.mcp("proc", "sessionKill", { id: s.id })) },
            ]);
          },
        },
          h("span", null, h("b", s.name), h("span.dim", ` ${s.attached ? `${s.attached} attached` : "detached"}`)),
          h("span.sz", fmtBytes(s.bytes)),
        )),
      );

      const rec = jobList.find((x) => x.id === selected);
      if (!rec) {
        fill(paneEl, emptyCard("play", "Nothing selected",
          "Pick a process to tail its output, or start one. A supervised process keeps running when this window closes."));
        return;
      }
      const shown = filter ? logs.filter((l) => l.text.toLowerCase().includes(filter.toLowerCase())) : logs;
      const search = h("input.ops-search", { value: filter, placeholder: "filter the log", oninput: (e) => { filter = e.target.value; paint(); } });
      fill(paneEl,
        h("div.ops-pane-head", null,
          h("b", rec.name),
          pill(rec.state, rec.state === "running" ? "ok" : rec.state === "failed" ? "err" : ""),
          rec.pid ? h("span.dim", `pid ${rec.pid}`) : null,
          h("span.spacer"),
          search,
          h("button.app-btn", { class: follow ? "on" : "", onclick: () => { follow = !follow; save(); paint(); } }, follow ? "Following" : "Paused"),
          rec.state === "running"
            ? h("button.app-btn", { onclick: () => act(() => api.mcp("proc", "stop", { id: rec.id })) }, "Stop")
            : h("button.app-btn", { onclick: () => act(() => api.mcp("proc", "start", { cmd: rec.cmd, name: rec.name })) }, "Start again"),
        ),
        rec.failure ? h("div.ops-error", null, icon("bell", 14), h("span", `${rec.failure.message} — the command never ran`)) : null,
        openPorts.length
          ? h("div.ops-ports", null,
              h("span.dim", "answering now:"),
              ...openPorts.map((p) => h("button.app-btn", {
                title: `Open :${p.port} in the Browser`,
                onclick: () => ctx.launch?.("browser", { port: Number(p.port), path: "/" }),
              }, `:${p.port}`, p.name ? h("span.dim", ` ${p.name}`) : null)))
          : null,
        h("div.ops-log", null, ...(shown.length
          ? shown.map((l) => h("div.ops-line", { class: l.stream === "stderr" ? "err" : "" },
              h("span.t", clock(l.ts)), h("span.m", l.text)))
          : [h("div.dim.ops-none", filter ? "nothing in the log matches" : "no output yet")])),
      );
      const logEl = paneEl.querySelector(".ops-log");
      if (logEl && follow) logEl.scrollTop = logEl.scrollHeight;
    }

    function paintSchedule() {
      fill(listEl, h("div.ops-head", "Scheduled"), ...rows(crons, (c) => h("button.row-line", {
        oncontextmenu: (e) => {
          e.preventDefault();
          menu({ x: e.clientX, y: e.clientY }, [
            { label: "Cancel", danger: true, run: () => act(() => api.mcp("cron", "cancel", { id: c.id })) },
          ]);
        },
      },
        // The row comes from the jobs table as it is stored: interval_ms and
        // due_at. Reading fields that were never there showed "once" for a
        // recurring job and no time at all for either.
        h("span", null, h("b", `${c.server}.${c.tool}`), h("span.dim", c.interval_ms ? ` every ${Math.round(c.interval_ms / 60000)}m` : " once")),
        h("span.sz", c.due_at ? clock(c.due_at) : "—"),
      )));
      fill(paneEl, emptyCard("clock", "The schedule",
        "Every entry is a tool call the scheduler makes on your behalf, with your capabilities. Right-click one to cancel it."));
    }

    refresh();
    const stop = poll(async () => { if (follow || tab === "schedule") await refresh(); }, 2000);
    return () => stop();
  },
};

// ── Ports ───────────────────────────────────────────────────────────────────

const ports = {
  mount(host, win, ctx) {
    let listening = [];
    let exposed = [];
    let unavailable = null;
    let error = null;

    const listEl = h("div.ops-list");
    const paneEl = h("div.ops-pane");
    const body = h("div.app-body.ops-split", null, listEl, paneEl);
    const bar = h("div.app-bar", null,
      h("button.app-btn", { onclick: () => exposeDialog() }, icon("plus", 12), "Expose…"),
      h("span.spacer"),
      h("button.app-btn", { title: "Scan again", onclick: () => refresh() }, icon("refresh", 12)),
    );
    frame(host, { bar, body });

    async function refresh() {
      try {
        const [scan, list] = await Promise.all([api.mcp("ports", "scan", {}), api.mcp("ports", "list", {})]);
        listening = scan.listening ?? [];
        unavailable = scan.unavailable ?? null;
        exposed = list.ports ?? [];
        error = null;
      } catch (e) { error = e; }
      paint();
    }

    async function exposeDialog() {
      const got = await dialog({
        title: "Expose a port",
        message: "The Gateway proxies it under your slug, with WebSocket upgrades, for anyone who can reach this machine.",
        fields: [
          { name: "port", label: "Port", type: "number", placeholder: "3000" },
          { name: "name", label: "Label", placeholder: "web" },
        ],
        confirmLabel: "Expose",
      });
      if (!got?.port) return;
      try { await api.mcp("ports", "expose", { port: Number(got.port), ...(got.name ? { name: got.name } : {}) }); refresh(); }
      catch (e) { toastError("Could not expose it", e); }
    }

    const urlFor = (port) => `${location.origin}/${slug}/p/${port}/`;

    /**
     * Sharing a port is sharing the machine, narrowly. The URL is behind the same
     * authentication as everything else, so the honest one-click share is a grant
     * — and the narrowest one that lets somebody load the page.
     */
    async function shareDialog(port) {
      const got = await dialog({
        title: `Share :${port}`,
        message: `${urlFor(port)} is behind this machine's own sign-in, so sharing it means giving someone access. This gives them the narrowest grant that lets them load it, and nothing else.`,
        fields: [
          { name: "username", label: "Their username", placeholder: "someone" },
          { name: "patterns", label: "What they may call", value: "ports.list",
            hint: "the proxy needs no tool of its own; this lets them see what is exposed" },
        ],
        confirmLabel: "Share",
      });
      if (!got?.username) return;
      const patterns = String(got.patterns ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      try {
        await api.mcp("access", "share", { username: got.username.trim(), ...(patterns.length ? { patterns } : {}) });
        toast(`${got.username} can reach :${port}`, { body: "Manage it in Access.", kind: "ok", timeout: 3200 });
        ctx.launch?.("access");
      } catch (e) { toastError("Could not share it", e); }
    }

    function paint() {
      const exposedPorts = new Set(exposed.map((p) => Number(p.port)));
      fill(listEl,
        error ? errorCard(error) : null,
        h("div.ops-head", "Listening inside the machine"),
        ...(unavailable
          ? [h("div.ops-error", null, icon("bell", 14), h("span", unavailable))]
          : rows(listening, (p) => h("button.row-line", {
              onclick: () => (exposedPorts.has(p.port) ? preview(p.port) : expose(p.port)),
            },
              h("span", null, h("b", `:${p.port}`), h("span.dim", exposedPorts.has(p.port) ? " exposed" : " not exposed")),
              h("span.sz", exposedPorts.has(p.port) ? "open" : "expose"),
            ))),
        h("div.ops-head", "Exposed"),
        ...rows(exposed, (p) => h("button.row-line", {
          onclick: () => preview(Number(p.port)),
          oncontextmenu: (e) => {
            e.preventDefault();
            menu({ x: e.clientX, y: e.clientY }, [
              { label: "Open in the Browser", run: () => preview(Number(p.port)) },
              { label: "Copy the URL", run: () => navigator.clipboard?.writeText(urlFor(p.port)).then(() => toast("URL copied", { timeout: 1800 })) },
              // The URL is only reachable by someone who can reach this machine,
              // so "share this port" is really "give that person access" — which
              // is the Access app, not a link (T1.2 → T1.6).
              { label: "Share it with someone…", icon: "shield", run: () => shareDialog(Number(p.port)) },
              { label: "Check it", run: () => check(Number(p.port)) },
              "-",
              { label: "Unexpose", danger: true, run: async () => { try { await api.mcp("ports", "unexpose", { port: Number(p.port) }); refresh(); } catch (err) { toastError("Could not unexpose", err); } } },
            ]);
          },
        },
          h("span", null, h("b", `:${p.port}`), h("span.dim", ` ${p.name ?? ""}`)),
          h("span.sz", "open"),
        )),
      );
      fill(paneEl, emptyCard("network", "Ports",
        "What is listening inside the machine, and what the Gateway serves to the outside. Click a listening port to expose it; right-click an exposed one for its URL.",
        h("div.dim", { style: { fontSize: "11px", marginTop: "8px" } },
          "Exposing is ", h("code", "ports.expose"), " — an agent can do it, and it is audited.")));
    }

    async function expose(port) {
      try { await api.mcp("ports", "expose", { port }); refresh(); }
      catch (e) { toastError(`Could not expose :${port}`, e); }
    }
    async function check(port) {
      try {
        const r = await api.mcp("ports", "check", { port });
        toast(`:${port} ${r.up ? "answers" : "does not answer"}`, { body: r.error ?? "", timeout: 2600 });
      } catch (e) { toastError("Could not check it", e); }
    }
    const preview = (port) => ctx.launch?.("browser", { port, path: "/" });

    refresh();
    const stop = poll(refresh, 4000);
    return () => stop();
  },
};

// ── Agents ──────────────────────────────────────────────────────────────────

const agents = {
  mount(host, win) {
    let list = [];
    let selected = win.props?.agent ?? null;
    let detail = null;
    let error = null;

    const listEl = h("div.ops-list");
    const paneEl = h("div.ops-pane");
    const body = h("div.app-body.ops-split", null, listEl, paneEl);
    const bar = h("div.app-bar", null,
      h("button.app-btn", { onclick: () => spawnDialog() }, icon("plus", 12), "Spawn…"),
      h("span.spacer"),
      h("button.app-btn", { title: "Refresh", onclick: () => refresh() }, icon("refresh", 12)),
    );
    frame(host, { bar, body });

    async function refresh() {
      try { list = (await api.mcp("agents", "list", {})).agents ?? []; error = null; }
      catch (e) { error = e; }
      if (selected) await load(selected);
      paint();
    }

    async function load(id) {
      try { detail = await api.mcp("agents", "get", { id }); }
      catch (e) { detail = { error: e.message }; }
    }

    /**
     * Spawn, or re-run. Passing a previous agent fills the dialog with what it
     * was: the same command, the same capabilities, the same kind — so "run that
     * again, but with one word changed" is one dialog rather than a retyping
     * exercise (T1.3).
     */
    async function spawnDialog(from = null) {
      const mine = await api.tryMcp("kernel", "capabilities", {});
      const prior = from
        ? { name: from.name ?? "", kind: from.kind ?? "shell", cmd: from.cmd ?? from.prompt ?? "", patterns: (from.patterns ?? from.capabilities ?? []).join(", ") }
        : { name: "", kind: "shell", cmd: "", patterns: "" };
      const got = await dialog({
        title: from ? `Run ${prior.name || "it"} again` : "Spawn an agent",
        message: from
          ? "Change anything before it goes. The original stays in the list with its own transcript."
          : "It runs with the capabilities you give it and nothing else — a subset of your own, checked by the Kernel.",
        fields: [
          { name: "name", label: "Name", placeholder: "build", value: prior.name },
          { name: "kind", label: "Kind", type: "select", value: prior.kind,
            options: [{ value: "shell", label: "shell — run a command" }, { value: "ai", label: "ai — drive a tool loop" }] },
          { name: "cmd", label: "Command or prompt", type: "textarea", rows: 3, placeholder: "npm test", value: prior.cmd },
          { name: "patterns", label: "Capabilities", placeholder: "proc.exec, fs.read", value: prior.patterns,
            hint: `you hold: ${(mine?.capabilities ?? ["—"]).join(", ").slice(0, 90)}` },
        ],
        confirmLabel: from ? "Run it again" : "Spawn",
      });
      if (!got?.name) return;
      const patterns = String(got.patterns ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      try {
        const r = await api.mcp("agents", "spawn", {
          name: got.name, kind: got.kind, patterns: patterns.length ? patterns : ["proc.exec"],
          ...(got.kind === "ai" ? { prompt: got.cmd } : { cmd: got.cmd }),
        });
        selected = r.id ?? r.agent?.id ?? null;
        refresh();
      } catch (e) { toastError("Could not spawn it", e); }
    }

    function paint() {
      fill(listEl,
        error ? errorCard(error) : null,
        h("div.ops-head", "Agents"),
        ...rows(list, (a) => h("button.row-line", {
          class: a.id === selected ? "on" : "",
          onclick: () => { selected = a.id; call("windowSet", { id: win.id, props: { agent: a.id } }).catch(() => {}); load(a.id).then(paint); },
          oncontextmenu: (e) => {
            e.preventDefault();
            menu({ x: e.clientX, y: e.clientY }, [
              { label: "Run again with edits…", icon: "refresh", run: () => spawnDialog(a) },
              { label: "Kill", danger: true, disabled: a.state !== "running" && a.state !== "queued",
                run: async () => { try { await api.mcp("agents", "kill", { id: a.id }); refresh(); } catch (err) { toastError("Could not kill it", err); } } },
            ]);
          },
        },
          h("span", null, h("b", a.name), h("span.dim", ` ${a.kind}`)),
          pill(a.state, a.state === "running" ? "ok" : a.state === "failed" ? "err" : ""),
        )),
      );

      if (!detail || !selected) {
        fill(paneEl, emptyCard("assistant", "No agent selected",
          "An agent is a principal with its own grants. Spawn one, watch what it calls, kill it if it goes wrong — the audit log keeps every step."));
        return;
      }
      const a = detail.agent ?? detail;
      fill(paneEl,
        h("div.ops-pane-head", null, h("b", a.name ?? selected), pill(a.state ?? "—", a.state === "running" ? "ok" : ""),
          h("span.spacer"),
          a.state === "running" ? h("button.app-btn", { onclick: async () => { await api.tryMcp("agents", "kill", { id: selected }); refresh(); } }, "Kill") : null),
        h("div.kv", null, h("span.k", "Capabilities"), h("span.v.mono", (a.patterns ?? a.capabilities ?? []).join(", ") || "—")),
        h("div.kv", null, h("span.k", "Started"), h("span.v", ago(a.created_at))),
        h("div.kv", null, h("span.k", "Finished"), h("span.v", a.finished_at ? ago(a.finished_at) : "—")),
        a.cmd ? h("div.kv", null, h("span.k", "Command"), h("span.v.mono", a.cmd)) : null,
        h("div.ops-head", "Result"),
        h("pre.ops-out", detail.error ?? (typeof a.result === "string" ? a.result : JSON.stringify(a.result ?? a.output ?? {}, null, 2))),
      );
    }

    refresh();
    const stop = poll(refresh, 3000);
    return () => stop();
  },
};

// ── Secrets ─────────────────────────────────────────────────────────────────

const secrets = {
  mount(host) {
    let list = [];
    let error = null;
    const listEl = h("div.ops-list");
    const paneEl = h("div.ops-pane");
    const body = h("div.app-body.ops-split", null, listEl, paneEl);
    const bar = h("div.app-bar", null,
      h("button.app-btn", { onclick: () => putDialog() }, icon("plus", 12), "Add…"),
      h("span.spacer"),
      h("button.app-btn", { title: "Refresh", onclick: () => refresh() }, icon("refresh", 12)),
    );
    frame(host, { bar, body });

    async function refresh() {
      try { list = (await api.mcp("secrets", "list", {})).secrets ?? []; error = null; }
      catch (e) { error = e; }
      paint();
    }

    async function putDialog() {
      const got = await dialog({
        title: "Store a secret",
        message: "The value is encrypted per tenant and never returned — not to you, not to an agent, not to an app. You use it by reference.",
        fields: [
          { name: "name", label: "Name", placeholder: "GITHUB_TOKEN" },
          { name: "value", label: "Value", type: "password", placeholder: "paste the secret" },
        ],
        confirmLabel: "Store",
      });
      if (!got?.name || !got.value) return;
      try { await api.mcp("secrets", "put", { name: got.name.trim(), value: got.value }); refresh(); }
      catch (e) { toastError("Could not store it", e); }
    }

    async function useDialog(name) {
      const got = await dialog({
        title: `Use ${name}`,
        message: "The command runs inside the machine with the secret in its environment. The output comes back; the value does not.",
        fields: [{ name: "cmd", label: "Command", placeholder: `curl -H "Authorization: Bearer $${name}" https://api.example.com` }],
        confirmLabel: "Run",
      });
      if (!got?.cmd) return;
      try {
        const r = await api.mcp("secrets", "useInEnv", { names: [name], cmd: got.cmd });
        fill(paneEl,
          h("div.ops-pane-head", null, h("b", name), h("span.dim", `exit ${r.code}`)),
          h("pre.ops-out", (r.stdout || "") + (r.stderr ? `\n${r.stderr}` : "")));
      } catch (e) { toastError("That did not run", e); }
    }

    function paint() {
      fill(listEl,
        error ? errorCard(error) : null,
        h("div.ops-head", "Secrets"),
        ...rows(list, (s) => h("button.row-line", {
          onclick: () => useDialog(typeof s === "string" ? s : s.name),
          oncontextmenu: (e) => {
            e.preventDefault();
            const name = typeof s === "string" ? s : s.name;
            menu({ x: e.clientX, y: e.clientY }, [
              { label: "Use in a command…", run: () => useDialog(name) },
              { label: "Remove", danger: true, run: async () => {
                if (!(await confirmDialog(`Remove ${name}?`, "Anything using it by reference will start failing."))) return;
                try { await api.mcp("secrets", "remove", { name }); refresh(); } catch (err) { toastError("Could not remove it", err); }
              } },
            ]);
          },
        },
          h("span", null, h("b", typeof s === "string" ? s : s.name)),
          h("span.sz", "use"),
        )),
      );
      if (!paneEl.querySelector(".ops-out")) {
        fill(paneEl, emptyCard("key", "References, never values",
          "A secret goes in and never comes back out: you name it, and the machine puts it in a command's environment for exactly that call."));
      }
    }

    refresh();
    return () => {};
  },
};

// ── Sync (Tide) ─────────────────────────────────────────────────────────────

const sync = {
  mount(host, win) {
    let workspaces = [];
    let ws = win.props?.workspace ?? null;
    let changes = [];
    let marks = [];
    let error = null;

    const listEl = h("div.ops-list");
    const paneEl = h("div.ops-pane");
    const body = h("div.app-body.ops-split", null, listEl, paneEl);
    const bar = h("div.app-bar", null,
      h("button.app-btn", { onclick: () => initDialog() }, icon("plus", 12), "New workspace…"),
      h("button.app-btn", { onclick: () => markDialog(), title: "Snapshot the working tree" }, icon("save", 12), "Mark…"),
      h("span.spacer"),
      h("button.app-btn", { title: "Refresh", onclick: () => refresh() }, icon("refresh", 12)),
    );
    frame(host, { bar, body });

    async function refresh() {
      try {
        workspaces = (await api.mcp("tide", "listWorkspaces", {})).workspaces ?? [];
        error = null;
        const names = workspaces.map((w) => (typeof w === "string" ? w : w.name));
        if (!ws || !names.includes(ws)) ws = names[0] ?? null;
        if (ws) {
          const [st, lg] = await Promise.all([
            api.tryMcp("tide", "status", { workspace: ws }),
            api.tryMcp("tide", "log", { workspace: ws, limit: 40 }),
          ]);
          changes = st?.changes ?? [];
          marks = lg?.marks ?? [];
        } else { changes = []; marks = []; }
      } catch (e) { error = e; }
      paint();
    }

    async function initDialog() {
      const got = await dialog({
        title: "New Tide workspace",
        fields: [
          { name: "workspace", label: "Name", placeholder: "src" },
          { name: "path", label: "Path in the machine", placeholder: "src" },
        ],
        confirmLabel: "Create",
      });
      if (!got?.workspace) return;
      try { await api.mcp("tide", "init", { workspace: got.workspace, ...(got.path ? { path: got.path } : {}) }); ws = got.workspace; refresh(); }
      catch (e) { toastError("Could not create it", e); }
    }

    async function markDialog() {
      if (!ws) { toastError("No workspace", new Error("create one first")); return; }
      const got = await dialog({
        title: `Mark ${ws}`,
        message: `${changes.length} change${changes.length === 1 ? "" : "s"} since the last mark.`,
        fields: [{ name: "message", label: "Message", placeholder: "what changed" }],
        confirmLabel: "Mark",
      });
      if (!got) return;
      try {
        const r = await api.mcp("tide", "mark", { workspace: ws, message: got.message ?? "" });
        toast(r.changed ? "Marked" : "Nothing to mark", { timeout: 2000 });
        refresh();
      } catch (e) { toastError("Could not mark it", e); }
    }

    function paint() {
      fill(listEl,
        error ? errorCard(error) : null,
        h("div.ops-head", "Workspaces"),
        ...rows(workspaces, (w) => {
          const name = typeof w === "string" ? w : w.name;
          return h("button.row-line", {
            class: name === ws ? "on" : "",
            onclick: () => { ws = name; call("windowSet", { id: win.id, props: { workspace: name } }).catch(() => {}); refresh(); },
          }, h("span", null, h("b", name), h("span.dim", ` ${typeof w === "object" && w.path ? w.path : ""}`)));
        }),
        h("div.ops-head", "Marks"),
        ...rows(marks, (m) => h("button.row-line", {
          oncontextmenu: (e) => {
            e.preventDefault();
            menu({ x: e.clientX, y: e.clientY }, [
              { label: "Show what it changed", run: () => showDiff(m) },
              { label: "Restore the working tree to this", danger: true, run: async () => {
                if (!(await confirmDialog("Restore this mark?", "The working tree goes back to this snapshot. Anything unmarked is lost."))) return;
                try { await api.mcp("tide", "checkout", { workspace: ws, ref: m.id ?? m.hash ?? m.ref }); refresh(); }
                catch (err) { toastError("Could not restore it", err); }
              } },
            ]);
          },
          onclick: () => showDiff(m),
        },
          h("span", null, h("b", (m.message || "(no message)").slice(0, 32)), h("span.dim", ` ${(m.id ?? m.hash ?? "").slice(0, 7)}`)),
          h("span.sz", ago(m.ts ?? m.at)),
        )),
      );

      fill(paneEl,
        h("div.ops-pane-head", null, h("b", ws ?? "no workspace"),
          h("span.dim", `${changes.length} change${changes.length === 1 ? "" : "s"} since the last mark`),
          h("span.spacer"),
          ws ? h("button.app-btn", { onclick: () => markDialog() }, "Mark") : null),
        ...(changes.length
          ? changes.map((c) => h("div.ops-line", null,
              h("span.t", String(c.kind ?? c.status ?? "changed").slice(0, 8)),
              h("span.m.mono", String(c.path ?? c.file ?? c))))
          : [h("div.dim.ops-none", ws ? "the working tree matches the last mark" : "create a workspace to version a folder of this machine")]),
      );
    }

    async function showDiff(m) {
      try {
        const r = await api.mcp("tide", "diff", { workspace: ws, from: m.parent ?? undefined, to: m.id ?? m.hash });
        fill(paneEl,
          h("div.ops-pane-head", null, h("b", (m.message || "(no message)")), h("span.dim", (m.id ?? "").slice(0, 7))),
          ...((r.changes ?? []).length
            ? r.changes.map((c) => h("div.ops-line", null,
                h("span.t", String(c.kind ?? c.status ?? "changed").slice(0, 8)),
                h("span.m.mono", String(c.path ?? c.file ?? c))))
            : [h("div.dim.ops-none", "no file changes in this mark")]));
      } catch (e) { toastError("Could not read the diff", e); }
    }

    refresh();
    return () => {};
  },
};

// ── Access ──────────────────────────────────────────────────────────────────

const access = {
  mount(host) {
    let list = [];
    let tokens = [];
    let you = null;
    let error = null;

    const listEl = h("div.ops-list");
    const paneEl = h("div.ops-pane");
    const body = h("div.app-body.ops-split", null, listEl, paneEl);
    const bar = h("div.app-bar", null,
      h("button.app-btn", { onclick: () => shareDialog() }, icon("plus", 12), "Share…"),
      h("button.app-btn", { onclick: () => mintDialog() }, icon("key", 12), "New token…"),
      h("span.spacer"),
      h("button.app-btn", { title: "Refresh", onclick: () => refresh() }, icon("refresh", 12)),
    );
    frame(host, { bar, body });

    async function refresh() {
      try {
        const [a, t] = await Promise.all([api.mcp("access", "list", {}), api.tryMcp("access", "tokens", {})]);
        list = a.access ?? [];
        you = a.you ?? null;
        tokens = t?.tokens ?? [];
        error = null;
      } catch (e) { error = e; }
      paint();
    }

    async function shareDialog() {
      const got = await dialog({
        title: "Share this machine",
        message: "They get what you give them, and never more than you hold. Leave the patterns empty to share everything you have.",
        fields: [
          { name: "username", label: "Account", placeholder: "alice" },
          { name: "patterns", label: "Capabilities", placeholder: "fs.read, proc.list" },
        ],
        confirmLabel: "Share",
      });
      if (!got?.username) return;
      const patterns = String(got.patterns ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      try { await api.mcp("access", "share", { username: got.username.trim(), ...(patterns.length ? { patterns } : {}) }); refresh(); }
      catch (e) { toastError("Could not share it", e); }
    }

    async function mintDialog() {
      const got = await dialog({
        title: "Mint a machine token",
        message: "For a device, a CI job or the sbx CLI. It is shown once — after that it exists only as a hash.",
        fields: [
          { name: "label", label: "Label", placeholder: "laptop" },
          { name: "patterns", label: "Capabilities", placeholder: "fs.*, proc.exec" },
        ],
        confirmLabel: "Mint",
      });
      if (!got) return;
      const patterns = String(got.patterns ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      try {
        const r = await api.mcp("access", "mint", { label: got.label || "device", ...(patterns.length ? { patterns } : {}) });
        fill(paneEl,
          h("div.ops-pane-head", null, h("b", "Copy this now")),
          h("pre.ops-out.select", r.token),
          h("div.dim", { style: { padding: "0 12px 12px", fontSize: "11px" } },
            "It holds ", h("code", r.patterns.join(", ")), ". This is the only time it is shown."),
          h("div", { style: { padding: "0 12px 12px" } },
            h("button.app-btn", { onclick: () => navigator.clipboard?.writeText(r.token).then(() => toast("Token copied", { timeout: 1800 })) }, "Copy")));
        refresh();
      } catch (e) { toastError("Could not mint it", e); }
    }

    function paint() {
      fill(listEl,
        error ? errorCard(error) : null,
        h("div.ops-head", "People"),
        ...rows(list, (a) => h("button.row-line", {
          oncontextmenu: (e) => {
            e.preventDefault();
            menu({ x: e.clientX, y: e.clientY }, [
              { label: a.principalId === you ? "This is you" : "Revoke", danger: a.principalId !== you, disabled: a.principalId === you,
                run: async () => {
                  if (!(await confirmDialog(`Revoke ${a.username ?? a.name}?`, "Their grants and any machine token minted for them go away."))) return;
                  try { await api.mcp("access", "revoke", { principalId: a.principalId }); refresh(); }
                  catch (err) { toastError("Could not revoke it", err); }
                } },
            ]);
          },
        },
          h("span", null, h("b", a.username ?? a.name ?? a.principalId), a.principalId === you ? h("span.dim", " (you)") : null),
          h("span.sz.mono", (a.patterns ?? []).join(" ").slice(0, 22) || "—"),
        )),
        h("div.ops-head", "Machine tokens"),
        ...rows(tokens, (t) => h("button.row-line", {
          oncontextmenu: (e) => {
            e.preventDefault();
            menu({ x: e.clientX, y: e.clientY }, [
              { label: "Revoke", danger: true, run: async () => {
                try { await api.mcp("access", "revoke", { principalId: t.principalId ?? t.id }); refresh(); }
                catch (err) { toastError("Could not revoke it", err); }
              } },
            ]);
          },
        },
          h("span", null, h("b", t.label ?? t.name ?? "token"), h("span.dim", ` ${ago(t.created_at ?? t.createdAt)}`)),
          h("span.sz.mono", (t.patterns ?? []).join(" ").slice(0, 22) || "—"),
        )),
      );
      if (!paneEl.querySelector(".ops-out")) {
        fill(paneEl, emptyCard("shield", "Who can reach this machine",
          "Sharing is attenuated: you can only hand over capabilities you hold. Right-click anyone to revoke them — it takes their tokens with it.",
          h("div.dim", { style: { fontSize: "11px", marginTop: "8px" } },
            "All of this is ", h("code", "access.*"), " — the same tools your agent would use.")));
      }
    }

    refresh();
    return () => {};
  },
};

// ── Audit ───────────────────────────────────────────────────────────────────

const audit = {
  mount(host, win) {
    let events = [];
    let error = null;
    let chain = null;
    const f = {
      server: win.props?.server ?? "", tool: win.props?.tool ?? "", kind: win.props?.kind ?? "",
      // Scoping to one caller (goal.md T1.7). A window passes an app's minted
      // principal here, which is how "everything this app has called" becomes a
      // query rather than a separate feature.
      principalId: win.props?.principalId ?? "",
    };
    const scopedTo = win.props?.scopeLabel ?? null;

    const listEl = h("div.ops-list.wide");
    const paneEl = h("div.ops-pane");
    const body = h("div.app-body.ops-split", null, listEl, paneEl);
    const inp = (key, placeholder) => h("input.ops-search", {
      value: f[key], placeholder,
      oninput: (e) => { f[key] = e.target.value; call("windowSet", { id: win.id, props: { ...f } }).catch(() => {}); refresh(); },
    });
    const bar = h("div.app-bar", null,
      inp("server", "server"), inp("tool", "tool"),
      h("select.ops-search", {
        onchange: (e) => { f.kind = e.target.value; refresh(); },
      }, ...[["", "any result"], ["ok", "ok"], ["error", "error"], ["denied", "denied"]].map(([v, l]) =>
        h("option", { value: v, selected: f.kind === v }, l))),
      scopedTo
        ? h("button.app-btn.on", {
            title: "Stop scoping to one caller",
            onclick: () => { f.principalId = ""; call("windowSet", { id: win.id, props: { principalId: "", scopeLabel: null } }).catch(() => {}); refresh(); },
          }, icon("shield", 12), scopedTo, " ×")
        : null,
      h("span.spacer"),
      h("button.app-btn", { title: "Save these rows, with the filter and the chain's verdict", onclick: () => exportRows() }, icon("save", 12), "Export"),
      h("button.app-btn", { onclick: () => verify() }, "Verify the chain"),
      h("button.app-btn", { title: "Refresh", onclick: () => refresh() }, icon("refresh", 12)),
    );
    frame(host, { bar, body });

    async function refresh() {
      try {
        const r = await api.mcp("kernel", "auditQuery", {
          limit: 200,
          ...(f.server ? { server: f.server } : {}),
          ...(f.tool ? { tool: f.tool } : {}),
          ...(f.kind ? { resultKind: f.kind } : {}),
          ...(f.principalId ? { principalId: f.principalId } : {}),
        });
        events = (r.events ?? []).slice().reverse();
        error = null;
      } catch (e) { error = e; }
      paint();
    }

    /**
     * The rows on screen, as a file. The whole point of a hash-chained log is
     * that it can leave the machine and still be checked, so the export carries
     * the filter that produced it and the chain's own verdict beside the rows —
     * a bag of events with no context is evidence of nothing.
     */
    async function exportRows() {
      try {
        const verdict = await api.tryMcp("kernel", "auditVerify", {});
        const payload = {
          exportedAt: new Date().toISOString(),
          machine: os.doc?.name ?? null,
          filter: { ...f },
          chain: verdict ?? { ok: null, note: "the chain could not be verified at export time" },
          count: events.length,
          events,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const a = h("a", { href: URL.createObjectURL(blob), download: `audit-${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        toast(`Exported ${events.length} rows`, { body: "With the filter and the chain's verdict beside them.", kind: "ok", timeout: 3000 });
      } catch (e) { toastError("Could not export", e); }
    }

    async function verify() {
      try {
        chain = await api.mcp("kernel", "auditVerify", {});
        toast(chain.ok ? "The chain is intact" : "The chain is broken", {
          body: chain.ok ? `${chain.count} rows verified` : `first break at row ${chain.brokenAtId}`,
          kind: chain.ok ? "" : "err", timeout: 4000,
        });
        paint();
      } catch (e) { toastError("Could not verify it", e); }
    }

    function paint() {
      fill(listEl,
        error ? errorCard(error) : null,
        chain ? h("div.ops-head", chain.ok ? `chain intact · ${chain.count} rows` : `chain broken at row ${chain.brokenAtId}`) : null,
        ...rows(events, (e) => h("button.row-line", {
          onclick: () => show(e),
        },
          h("span", null,
            h("b.mono", `${e.server}.${e.tool}`),
            h("span.dim", ` ${clock(e.ts)}`)),
          pill(e.result_kind, e.result_kind === "ok" ? "ok" : e.result_kind === "denied" ? "warn" : "err"),
        )),
      );
      if (!paneEl.querySelector(".ops-out")) {
        fill(paneEl, emptyCard("list", "Every call, in order",
          "Hash-chained: each row carries the hash of the one before it, so a deleted or edited row is detectable. Click a row to see its arguments."));
      }
    }

    function show(e) {
      let args = e.args_json;
      try { args = JSON.stringify(JSON.parse(e.args_json ?? "null"), null, 2); } catch { /* keep the raw text */ }
      fill(paneEl,
        h("div.ops-pane-head", null, h("b.mono", `${e.server}.${e.tool}`), pill(e.result_kind, e.result_kind === "ok" ? "ok" : "err")),
        h("div.kv", null, h("span.k", "When"), h("span.v", `${new Date(e.ts).toLocaleString()} · ${ago(e.ts)}`)),
        h("div.kv", null, h("span.k", "Principal"), h("span.v.mono", e.principal_id ?? "—")),
        h("div.kv", null, h("span.k", "Capability"), h("span.v.mono", e.capability ?? "—")),
        e.error ? h("div.kv", null, h("span.k", "Error"), h("span.v", e.error)) : null,
        h("div.kv", null, h("span.k", "Hash"), h("span.v.mono", String(e.hash ?? "").slice(0, 16))),
        h("div.ops-head", "Arguments"),
        h("pre.ops-out", args ?? "—"),
      );
    }

    refresh();
    const stop = poll(refresh, 5000);
    return () => stop();
  },
};

export const OPS_APPS = { jobs, ports, agents, secrets, sync, access, audit };
