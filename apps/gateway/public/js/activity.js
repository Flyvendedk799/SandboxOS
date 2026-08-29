// activity.js — the audit dock.
//
// Every Kernel call emits an audit event; this panel is the live tail of them.
// It seeds from the stored log so the dock is never empty on load, then follows
// the SSE stream. Filters apply to both sources.

import { $, h, fill, clear, api, bus, state, setState, fmtTime, toast } from "./core.js";
import { setCellState } from "./shell.js";

const MAX_ROWS = 400;

export function initActivity() {
  const list = $("#audit-list");
  const modeEl = $("#dock-mode");
  const serverSel = $("#audit-server");
  const kindSel = $("#audit-kind");

  let rows = [];
  let filters = { server: "", kind: "" };

  const normalize = (e) => ({
    ts: e.ts,
    server: e.server,
    tool: e.tool,
    kind: e.resultKind ?? e.result_kind ?? "ok",
    error: e.error ?? null,
    capability: e.capability ?? null,
  });

  function passes(r) {
    return (!filters.server || r.server === filters.server) && (!filters.kind || r.kind === filters.kind);
  }

  function rowEl(r) {
    return h("li.audit-item", { class: r.kind, title: r.error ? `${r.server}.${r.tool} — ${r.error}` : `${r.server}.${r.tool}` },
      h("span.t", fmtTime(r.ts)),
      h("span.target", r.error ? `${r.server}.${r.tool} — ${r.error}` : `${r.server}.${r.tool}`),
      h("span.k", r.kind === "ok" ? "ok" : r.kind),
    );
  }

  function render() {
    const shown = rows.filter(passes).slice(-MAX_ROWS);
    if (!shown.length) {
      fill(list, h("li.palette-empty", rows.length ? "Nothing matches these filters." : "No activity yet."));
      return;
    }
    fill(list, ...shown.map(rowEl));
    list.scrollTop = list.scrollHeight;
  }

  function push(ev) {
    const r = normalize(ev);
    rows.push(r);
    if (rows.length > MAX_ROWS * 2) rows = rows.slice(-MAX_ROWS);
    if (!passes(r)) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    if (list.firstElementChild?.classList.contains("palette-empty")) clear(list);
    list.append(rowEl(r));
    while (list.childElementCount > MAX_ROWS) list.firstElementChild.remove();
    if (atBottom) list.scrollTop = list.scrollHeight;
    bus.emit("audit", r);
  }

  // ── Seed from the stored log ───────────────────────────────────────────────
  api.get("audit?limit=80")
    .then((d) => { rows = (d.events ?? []).map(normalize); render(); })
    .catch(() => render());

  // ── Follow the live stream ─────────────────────────────────────────────────
  let es = null;
  let retry = 0;

  function connect() {
    es?.close();
    es = new EventSource(`/${state.slug}/events`);

    es.addEventListener("hello", (e) => {
      retry = 0;
      modeEl.textContent = "live";
      try { setCellState(JSON.parse(e.data).state ?? "running"); } catch { setCellState("running"); }
    });

    es.onmessage = (e) => {
      try { push(JSON.parse(e.data)); } catch { /* keepalive or malformed frame */ }
    };

    es.onerror = () => {
      modeEl.textContent = "reconnecting…";
      setCellState("stopped");
      es.close();
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * 2 ** retry);
    };
  }
  connect();

  // ── Filters ────────────────────────────────────────────────────────────────
  bus.on("state", () => {
    const servers = state.servers ?? [];
    if (serverSel.dataset.filled === String(servers.length)) return;
    serverSel.dataset.filled = String(servers.length);
    const keep = serverSel.value;
    fill(serverSel, h("option", { value: "" }, "all servers"),
      ...servers.map((s) => h("option", { value: s }, s)));
    serverSel.value = keep;
  });

  serverSel.addEventListener("change", () => { filters.server = serverSel.value; render(); });
  kindSel.addEventListener("change", () => { filters.kind = kindSel.value; render(); });
  $("#dock-clear").addEventListener("click", () => { rows = []; render(); });

  render();

  return { push, rows: () => rows };
}
