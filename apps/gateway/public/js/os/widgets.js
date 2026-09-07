// widgets.js — the built-in desktop widgets.
//
// Every one of these reads the real machine. There is no decorative data on this
// desktop: the load bars come from `metrics.snapshot`, the audit feed from the
// audit log, the weather from an actual egress-gated `net.fetch`. If a reading is
// unavailable — the Cell asleep, egress denied — the widget says so rather than
// inventing a number, because a dashboard that lies once cannot be trusted after.
//
// A widget is `{ mount(host, widget, ctx) → stop() }`. Custom widget kinds are
// bundles in an iframe instead (see frames.js); the two are interchangeable
// everywhere else in the OS.

import { h, fill, api, fmtBytes, slug } from "../core.js";
import { call } from "./client.js";

const pad2 = (n) => String(n).padStart(2, "0");
const timeStr = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const dayStr = () => new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

/** Run `fn` now and on an interval; returns a stopper. */
function loop(fn, ms) {
  let alive = true;
  const tick = async () => { if (alive) { try { await fn(); } catch { /* a widget must never break the desktop */ } } };
  tick();
  const id = setInterval(tick, ms);
  return () => { alive = false; clearInterval(id); };
}

const bar = (label, value, pct, color) => h("div.w-bar", null,
  h("div.row", null, h("span", label), h("span", value)),
  h("div.track", h("i", { style: { width: `${Math.max(0, Math.min(100, pct))}%`, background: color ?? "var(--os-accent)" } })),
);

// ── the widgets ─────────────────────────────────────────────────────────────

const clock = {
  mount(host) {
    const t = h("div.w-clock", timeStr());
    const d = h("div.w-day", dayStr());
    fill(host, t, d);
    return loop(() => { t.textContent = timeStr(); d.textContent = dayStr(); }, 10_000);
  },
};

const load = {
  mount(host) {
    const body = h("div.w-bars", h("span.dim", { style: { fontSize: "11px" } }, "reading…"));
    fill(host, h("div.w-label", "System load"), body);
    return loop(async () => {
      let m;
      try { m = await api.mcp("metrics", "snapshot", {}); }
      catch { fill(body, h("span.dim", { style: { fontSize: "11px" } }, "metrics unavailable")); return; }
      const cpu = m.load?.[0];
      const mem = m.memory;
      const rows = [];
      rows.push(bar("CPU", cpu == null ? "—" : cpu.toFixed(2), cpu == null ? 0 : Math.min(100, cpu * 100)));
      if (mem?.total) {
        rows.push(bar("Memory", `${fmtBytes(mem.used ?? 0)} / ${fmtBytes(mem.total)}`, ((mem.used ?? 0) / mem.total) * 100));
      } else {
        rows.push(bar("Memory", "—", 0));
      }
      rows.push(bar("Disk", m.disk?.bytes == null ? "—" : fmtBytes(m.disk.bytes),
        m.disk?.bytes ? Math.min(100, (m.disk.bytes / (50 * 1024 ** 3)) * 100) : 0, "var(--os-sand)"));
      rows.push(h("div.row", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--os-text-3)" } },
        h("span", `${m.processes ?? "—"} processes`), h("span", `${m.tools ?? "—"} tools`)));
      fill(body, ...rows);
    }, 6000);
  },
};

const calendar = {
  mount(host) {
    // Local, and only local: no calendar service, so no egress and nothing to
    // be honest about being unavailable. Month navigation is a view, not a write.
    const now = new Date();
    let y = now.getFullYear(), mo = now.getMonth();
    const stop = (e) => e.stopPropagation();
    function paint() {
      const first = new Date(y, mo, 1).getDay();
      const days = new Date(y, mo + 1, 0).getDate();
      const isNow = y === now.getFullYear() && mo === now.getMonth();
      const cells = ["S", "M", "T", "W", "T", "F", "S"].map((d) => h("span.dow", d));
      for (let i = 0; i < first; i += 1) cells.push(h("span"));
      for (let i = 1; i <= days; i += 1) cells.push(h("span", { class: isNow && i === now.getDate() ? "today" : "" }, String(i)));
      fill(host,
        h("div.w-cal-head", null,
          h("button", { onpointerdown: stop, onclick: (e) => { stop(e); mo -= 1; if (mo < 0) { mo = 11; y -= 1; } paint(); } }, "‹"),
          h("div.w-label", { onpointerdown: stop, onclick: (e) => { stop(e); y = now.getFullYear(); mo = now.getMonth(); paint(); }, title: "Back to today" },
            new Date(y, mo, 1).toLocaleDateString([], { month: "long", year: "numeric" })),
          h("button", { onpointerdown: stop, onclick: (e) => { stop(e); mo += 1; if (mo > 11) { mo = 0; y += 1; } paint(); } }, "›")),
        h("div.w-cal", ...cells));
    }
    paint();
    // Roll over at midnight, so "today" stays honest on a machine left open.
    const id = setInterval(() => { const d = new Date(); if (d.getDate() !== now.getDate()) { now.setTime(d.getTime()); paint(); } }, 60_000);
    return () => clearInterval(id);
  },
};

const weather = {
  mount(host, widget) {
    const place = widget.props?.place ?? "Copenhagen";
    const lat = widget.props?.lat ?? 55.6761;
    const lon = widget.props?.lon ?? 12.5683;
    const temp = h("div.w-big", "—");
    const sub = h("div", { style: { fontSize: "11px", color: "var(--os-text-2)", cursor: "text" }, title: "Double-click to change the place" }, place);
    sub.addEventListener("dblclick", async (e) => {
      e.stopPropagation();
      const name = prompt("Place (name, or lat,lon)", place);
      if (!name) return;
      const m = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(name);
      call("widgetSet", { id: widget.id, props: m ? { lat: Number(m[1]), lon: Number(m[2]), place: name } : { place: name } }).catch(() => {});
    });
    const note = h("div", { style: { fontSize: "11px", color: "var(--os-text-3)", marginTop: "10px" } }, "fetching…");
    fill(host,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } },
        h("div", null, temp, sub)),
      note);

    // A real request through the `net` server, so it obeys this machine's egress
    // policy. Denied egress is a legitimate answer, and the widget says so.
    return loop(async () => {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
          + "&current=temperature_2m&daily=temperature_2m_max,temperature_2m_min&timezone=auto";
        const r = await api.mcp("net", "fetch", { url, method: "GET" });
        const data = JSON.parse(r.body ?? r.text ?? "{}");
        const t = data?.current?.temperature_2m;
        temp.textContent = t == null ? "—" : `${Math.round(t)}°`;
        const hi = data?.daily?.temperature_2m_max?.[0];
        const lo = data?.daily?.temperature_2m_min?.[0];
        note.textContent = hi == null ? "no forecast" : `H ${Math.round(hi)}° L ${Math.round(lo)}°`;
      } catch (e) {
        temp.textContent = "—";
        note.textContent = /denied|egress/i.test(e.message) ? "egress denied by policy" : "unavailable offline";
      }
    }, 15 * 60_000);
  },
};

const audit = {
  mount(host) {
    const feed = h("div.w-feed");
    fill(host, h("div.w-label", "Audit feed"), feed);
    return loop(async () => {
      const r = await api.get(`/${slug}/audit?limit=6`);
      const rows = (r.events ?? []).map((e) => h("div.line", null,
        h("span", { class: e.result_kind ?? e.resultKind }, e.result_kind ?? e.resultKind),
        h("span.what", `${e.server}.${e.tool}`)));
      fill(feed, ...(rows.length ? rows : [h("span.dim", { style: { fontSize: "10px" } }, "nothing yet")]));
    }, 6000);
  },
};

const jobs = {
  mount(host, widget, ctx) {
    const list = h("div.w-feed");
    fill(host, h("div.w-label", "Processes"), list);
    const stop = (e) => e.stopPropagation();
    // Actions are the same proc.* calls the console makes; a denied one shows
    // the Kernel's answer rather than pretending the button did nothing.
    const act = async (label, fn) => {
      try { await fn(); } catch (e) { ctx?.notify?.(`${label} failed`, e.message); }
    };
    return loop(async () => {
      const r = await api.tryMcp("proc", "jobs", {});
      if (!r) { fill(list, h("span.dim", { style: { fontSize: "10px" } }, "proc.jobs unavailable")); return; }
      const rows = (r.jobs ?? []).slice(0, 6).map((j) => h("div.line", null,
        h("span", { class: j.state === "running" ? "ok" : "denied" }, j.state ?? "?"),
        h("span.what", j.name ?? j.cmd ?? j.id),
        h("span.acts", null,
          h("button", { title: "Logs (opens the Console)", onpointerdown: stop, onclick: (e) => { stop(e); ctx?.launch?.("console", { run: `logs ${j.id}` }); } }, "logs"),
          j.state === "running" ? h("button", { title: "Stop", onpointerdown: stop, onclick: (e) => { stop(e); act("stop", () => api.mcp("proc", "stop", { id: j.id })); } }, "stop") : null)));
      fill(list, ...(rows.length ? rows : [h("span.dim", { style: { fontSize: "10px" } }, "no supervised jobs · run \"<cmd>\" name")]));
    }, 5000);
  },
};

const actions = {
  mount(host, widget, ctx) {
    const defs = [
      { label: "Terminal", run: () => ctx.launch("terminal") },
      { label: "New note", run: () => ctx.launch("notes") },
      { label: "Tile", run: () => call("layoutSet", { mode: "tiling" }) },
      { label: "Arrange", run: () => ctx.mark() },
    ];
    fill(host,
      h("div.w-label", "Quick actions"),
      h("div.w-actions", ...defs.map((d) => h("button", { onclick: (e) => { e.stopPropagation(); d.run(); } }, d.label))));
    return () => {};
  },
};

const notes = {
  mount(host, widget) {
    const ta = h("textarea.w-note", { placeholder: "Sticky note…", spellcheck: "false" });
    ta.value = widget.props?.text ?? "";
    let timer = null;
    ta.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => call("widgetSet", { id: widget.id, props: { text: ta.value.slice(0, 4000) } }).catch(() => {}), 700);
    });
    ta.addEventListener("pointerdown", (e) => e.stopPropagation()); // typing, not dragging
    fill(host, h("div.w-label", "Note"), ta);
    return () => clearTimeout(timer);
  },
};

export const WIDGETS = { clock, load, calendar, weather, audit, jobs, actions, notes };

/** Render one built-in widget into its host. Returns a stopper, or null if the
 *  kind is not built in (a custom bundle — frames.js takes it from here). */
export function mountWidget(kind, host, widget, ctx) {
  const w = WIDGETS[kind];
  if (!w) return null;
  return w.mount(host, widget, ctx) ?? (() => {});
}
