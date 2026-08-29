// metrics.js — the dashboard.
//
// Everything here comes from the `metrics` MCP server, so what you see is
// exactly what an agent holding `metrics.*` would see. Charts are hand-drawn
// SVG: a sparkline and a bar histogram are not worth a charting library, and a
// dependency-free page loads instantly on a phone over a tunnel.

import { $, h, fill, api, bus, state, fmtBytes, fmtAgo, fmtDuration, emptyState, toastError } from "./core.js";

const WINDOWS = [
  { label: "15m", ms: 15 * 60_000 },
  { label: "1h", ms: 3_600_000 },
  { label: "24h", ms: 24 * 3_600_000 },
  { label: "7d", ms: 7 * 24 * 3_600_000 },
];

/** A filled sparkline over `values`, scaled to its own range. */
function sparkline(values, { width = 200, height = 32, color = "var(--accent)" } = {}) {
  const pts = values.filter((v) => v != null && Number.isFinite(v));
  if (pts.length < 2) return h("div.dim", { style: { fontSize: "var(--fs-xs)", height: `${height}px` } }, "collecting…");
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const step = width / (pts.length - 1);
  const y = (v) => height - 2 - ((v - min) / span) * (height - 4);
  const line = pts.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const mk = (tag, attrs) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  svg.append(mk("path", { d: area, fill: color, "fill-opacity": "0.14" }));
  svg.append(mk("path", { d: line, fill: "none", stroke: color, "stroke-width": "1.5", "stroke-linejoin": "round" }));
  return svg;
}

/** A bar histogram of {ts, n} buckets. */
function histogram(buckets, bucketMs) {
  if (!buckets.length) return h("div.dim", { style: { fontSize: "var(--fs-xs)" } }, "no calls in this window");
  const max = Math.max(1, ...buckets.map((b) => b.n));
  return h("div.row", { style: { alignItems: "flex-end", gap: "2px", height: "72px" } },
    ...buckets.map((b) => h("div", {
      title: `${new Date(b.ts).toLocaleString()} — ${b.n} call${b.n === 1 ? "" : "s"}`,
      style: {
        flex: "1",
        minWidth: "2px",
        maxWidth: "18px",
        height: `${Math.max(2, (b.n / max) * 72)}px`,
        borderRadius: "2px 2px 0 0",
        background: "var(--accent)",
        opacity: b.n ? "0.8" : "0.2",
      },
    })));
}

function stat(label, value, unit, spark) {
  return h("div.stat", null,
    h("div.label", label),
    h("div.value", value ?? "—", unit ? h("small", ` ${unit}`) : null),
    spark ?? null,
  );
}

export function initMetrics() {
  const body = $("#metrics-body");
  const ageEl = $("#metrics-age");
  let windowMs = 3_600_000;
  let timer = null;
  let lastAt = 0;

  async function refresh() {
    try {
      const [snap, hist, act] = await Promise.all([
        api.mcp("metrics", "snapshot", {}),
        api.tryMcp("metrics", "history", { limit: 60 }),
        api.tryMcp("metrics", "activity", { windowMs }),
      ]);
      lastAt = Date.now();
      render(snap, hist?.samples ?? [], act);
    } catch (e) {
      fill(body, emptyState("!", "Metrics unavailable",
        `${e.message}. Enable the metrics server for this Sandbox from Settings.`));
    }
  }

  function render(s, samples, act) {
    const mem = s.memory;

    const cards = h("div.stat-grid", null,
      stat("Load (1m)", s.load ? s.load[0].toFixed(2) : "—", "",
        sparkline(samples.map((x) => x.load))),
      stat("Memory used", mem?.used != null ? fmtBytes(mem.used) : "—",
        mem?.total ? `of ${fmtBytes(mem.total)}` : "",
        mem?.used != null ? sparkline(samples.map((x) => x.memUsed), { color: "var(--info)" }) : null),
      stat("Disk", s.disk?.bytes != null ? fmtBytes(s.disk.bytes) : "—",
        s.disk?.files != null ? `${s.disk.files} files` : "",
        sparkline(samples.map((x) => x.disk), { color: "var(--sand)" })),
      stat("Processes", s.processes ?? "—", "",
        sparkline(samples.map((x) => x.procs), { color: "var(--ok)" })),
    );

    const composition = h("div.card", { style: { marginTop: "var(--s-4)" } },
      h("h3", { style: { fontSize: "var(--fs-md)", marginBottom: "var(--s-3)" } }, "Composition"),
      h("div.row", { style: { flexWrap: "wrap", marginBottom: "var(--s-3)" } },
        ...(s.servers ?? []).map((n) => h("span.chip.mono.accent", n))),
      h("div.row", { class: "dim", style: { gap: "var(--s-4)", fontSize: "var(--fs-xs)", flexWrap: "wrap" } },
        h("span", `${s.tools ?? 0} tools`),
        h("span", `cell: ${s.cell?.backend ?? "—"}`),
        h("span", `state: ${s.sandbox?.state ?? "—"}`),
        h("span", `ports: ${s.ports?.length ? s.ports.join(", ") : "none"}`),
        h("span", `gateway up ${fmtDuration(s.hostUptimeMs)}`),
      ),
    );

    const activity = act ? h("div.card", { style: { marginTop: "var(--s-4)" } },
      h("div.row", { style: { marginBottom: "var(--s-3)" } },
        h("h3", { style: { fontSize: "var(--fs-md)" } }, "Kernel calls"),
        h("span.spacer"),
        ...WINDOWS.map((w) => h("button", {
          class: w.ms === windowMs ? "sm" : "ghost sm",
          onclick: () => { windowMs = w.ms; refresh(); },
        }, w.label)),
      ),
      histogram(act.histogram ?? [], act.bucketMs),
      h("div.row", { style: { gap: "var(--s-2)", marginTop: "var(--s-3)", flexWrap: "wrap" } },
        h("span.chip", `${act.total} total`),
        ...Object.entries(act.byKind ?? {}).map(([k, n]) =>
          h("span.chip", { class: k === "ok" ? "ok" : k === "denied" ? "warn" : "err" }, `${k} ${n}`)),
      ),
      (act.byTool ?? []).length
        ? h("table.data", { style: { marginTop: "var(--s-3)" } },
            h("thead", null, h("tr", null, h("th", "Tool"), h("th.right", "Calls"))),
            h("tbody", null, ...act.byTool.map((t) => h("tr", null,
              h("td.mono", `${t.server}.${t.tool}`),
              h("td.right", String(t.n)),
            ))))
        : null,
    ) : null;

    fill(body, cards, composition, activity);
  }

  function tickAge() {
    ageEl.textContent = lastAt ? fmtAgo(lastAt) : "—";
  }

  $("#metrics-refresh").addEventListener("click", refresh);
  bus.on("workspace:metrics", () => {
    refresh();
    clearInterval(timer);
    timer = setInterval(() => { refresh(); }, 15_000);
  });
  bus.on("workspace", (e) => { if (e.detail !== "metrics") clearInterval(timer); });
  setInterval(tickAge, 1000);

  return { refresh };
}
