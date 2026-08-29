// sync.js — Tide, the fourth pillar, with a face.
//
// Tide is version control built for agents: a workspace maps a path inside the
// Cell to an object store, `mark` snapshots it, `log` is the history, `checkout`
// restores it, and the wire primitives let a laptop daemon push and pull the
// same objects. All of that has been callable since Phase 2 and visible nowhere.
//
// This panel is the missing half: what changed, what it changed from, and the
// ability to move between marks — every action going through the tide MCP server,
// so an agent doing the same thing shows up in the same audit log.

import {
  $, h, fill, clear, api, bus, toast, toastError, dialog, confirmDialog,
  fmtAgo, fmtTime, emptyState,
} from "./core.js";
import { registerAction } from "./palette.js";

const STATUS_KIND = { added: "ok", modified: "warn", deleted: "err" };
const STATUS_MARK = { added: "+", modified: "~", deleted: "−" };

export function initSync() {
  const listEl = $("#tide-workspaces");
  const bodyEl = $("#tide-body");

  let workspaces = [];
  let current = null;
  let changes = [];
  let marks = [];
  let selectedMark = null;
  let markDiff = null;

  // ── Workspaces ─────────────────────────────────────────────────────────────

  function renderList() {
    if (!workspaces.length) {
      fill(listEl, h("div.dim", { style: { padding: "var(--s-3)", fontSize: "var(--fs-xs)" } },
        "No workspaces yet."));
      return;
    }
    fill(listEl, ...workspaces.map((w) => h("div.chat-item", {
      class: w.name === current ? "selected" : "",
      onclick: () => select(w.name),
    },
      h("span.nm.truncate", w.name),
      h("span.dim", { style: { fontSize: "10px" } }, w.head ? w.head.slice(0, 8) : "no marks yet"),
    )));
  }

  async function refresh() {
    try {
      workspaces = (await api.mcp("tide", "listWorkspaces", {})).workspaces ?? [];
      renderList();
      if (!current && workspaces.length) return select(workspaces[0].name);
      if (current) return select(current);
      render();
    } catch (e) {
      fill(bodyEl, emptyState("!", "Tide unavailable",
        `${e.message}. Enable the tide server for this Sandbox from Settings.`));
    }
  }

  async function select(name) {
    current = name;
    selectedMark = null;
    markDiff = null;
    renderList();
    try {
      const [st, lg] = await Promise.all([
        api.mcp("tide", "status", { workspace: name }),
        api.mcp("tide", "log", { workspace: name, limit: 50 }),
      ]);
      changes = st.changes ?? [];
      marks = lg.marks ?? [];
      render();
    } catch (e) { toastError(`Could not read ${name}`, e); }
  }

  async function createWorkspace() {
    const got = await dialog({
      title: "New Tide workspace",
      message: "A workspace maps a path inside this Sandbox to a versioned object store. Marking it snapshots that path; a laptop daemon can push and pull the same objects.",
      fields: [
        { name: "workspace", label: "Name", placeholder: "notes" },
        { name: "path", label: "Path in the Sandbox", placeholder: "notes", hint: "Defaults to the workspace name." },
      ],
      confirmLabel: "Create",
    });
    if (!got?.workspace) return;
    try {
      await api.mcp("tide", "init", { workspace: got.workspace, path: got.path || undefined });
      toast("Workspace created", { body: got.workspace, kind: "ok" });
      current = got.workspace;
      refresh();
    } catch (e) { toastError("Could not create the workspace", e); }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function mark() {
    if (!current) return;
    if (!changes.length) return toast("Nothing to mark", { body: "The working tree matches the last mark." });
    const got = await dialog({
      title: "Mark this workspace",
      message: `${changes.length} change${changes.length === 1 ? "" : "s"} will be snapshotted as a new mark.`,
      fields: [{ name: "message", label: "Message", placeholder: "what changed and why" }],
      confirmLabel: "Mark",
    });
    if (!got) return;
    try {
      const r = await api.mcp("tide", "mark", { workspace: current, message: got.message });
      if (!r.commit) return toast("Nothing changed", { body: "No mark was written." });
      toast("Marked", { body: r.commit.slice(0, 12), kind: "ok" });
      select(current);
    } catch (e) { toastError("Could not mark", e); }
  }

  async function openMark(m) {
    selectedMark = m.hash;
    markDiff = null;
    render();
    try {
      // Diff a mark against its parent; a root mark diffs against nothing.
      const r = await api.mcp("tide", "diff", {
        workspace: current,
        from: m.parents?.[0] ?? undefined,
        to: m.hash,
      });
      markDiff = r.changes ?? [];
      render();
    } catch (e) { toastError("Could not diff", e); }
  }

  async function checkout(m) {
    if (!await confirmDialog("Restore this mark?",
      `The working tree at ${current} is replaced with the contents of ${m.hash.slice(0, 12)}. Anything not marked is lost.`,
      { confirmLabel: "Restore" })) return;
    try {
      await api.mcp("tide", "checkout", { workspace: current, ref: m.hash });
      toast("Restored", { body: m.hash.slice(0, 12), kind: "ok" });
      bus.emit("files:changed");
      select(current);
    } catch (e) { toastError("Could not restore", e); }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function changeRow(c) {
    return h("div.row", { style: { gap: "var(--s-2)", padding: "3px 0", fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" } },
      h("span.chip", { class: STATUS_KIND[c.status] ?? "", style: { width: "18px", justifyContent: "center" } },
        STATUS_MARK[c.status] ?? "?"),
      h("span.truncate", { title: c.path }, c.path),
    );
  }

  function render() {
    if (!current) {
      fill(bodyEl, emptyState("≈", "No Tide workspace yet",
        "Tide is version control shaped for agents: mark a path in this Sandbox, see its history, restore any mark, and push or pull the same objects from your laptop.",
        { label: "Create a workspace", run: createWorkspace }));
      return;
    }

    const ws = workspaces.find((w) => w.name === current);

    const statusCard = h("div.card", { style: { marginBottom: "var(--s-4)" } },
      h("div.row", null,
        h("h3", { style: { fontSize: "var(--fs-md)" } }, "Working tree"),
        h("span.chip", { class: changes.length ? "warn" : "ok" },
          changes.length ? `${changes.length} change${changes.length === 1 ? "" : "s"}` : "clean"),
        h("span.spacer"),
        h("span.dim.mono", { style: { fontSize: "var(--fs-xs)" } }, ws?.path ?? ""),
        h("button.sm", { disabled: !changes.length, onclick: mark }, "Mark"),
      ),
      changes.length
        ? h("div", { style: { marginTop: "var(--s-3)" } }, ...changes.slice(0, 200).map(changeRow))
        : h("p.dim", { style: { fontSize: "var(--fs-sm)", marginTop: "var(--s-2)" } },
            "Everything in this workspace matches its last mark."),
    );

    const historyCard = h("div.card", null,
      h("h3", { style: { fontSize: "var(--fs-md)", marginBottom: "var(--s-3)" } }, "History"),
      marks.length
        ? h("div", null, ...marks.map((m) => {
            const open = selectedMark === m.hash;
            return h("div", { style: { borderTop: "1px solid var(--line-soft)" } },
              h("div.row", {
                style: { padding: "var(--s-2) 0", cursor: "pointer" },
                onclick: () => (open ? (selectedMark = null, render()) : openMark(m)),
              },
                h("span.chip.mono", m.hash.slice(0, 8)),
                h("span.grow.truncate", m.message || h("span.dim", "(no message)")),
                h("span.dim", { style: { fontSize: "var(--fs-xs)" }, title: new Date(m.ts).toLocaleString() }, fmtAgo(m.ts)),
                h("button.ghost.sm", { onclick: (e) => { e.stopPropagation(); checkout(m); } }, "Restore"),
              ),
              open
                ? h("div", { style: { padding: "0 0 var(--s-3) var(--s-3)" } },
                    markDiff === null
                      ? h("div.row", null, h("span.spinner"), h("span.dim", "diffing…"))
                      : markDiff.length
                        ? h("div", null, ...markDiff.slice(0, 200).map(changeRow))
                        : h("span.dim", { style: { fontSize: "var(--fs-sm)" } }, "no file changes in this mark"))
                : null,
            );
          }))
        : h("p.dim", { style: { fontSize: "var(--fs-sm)" } },
            "No marks yet. Change something in this workspace and mark it."),
    );

    fill(bodyEl, statusCard, historyCard);
  }

  $("#tide-new").addEventListener("click", createWorkspace);
  $("#tide-refresh").addEventListener("click", refresh);
  bus.on("workspace:sync", () => { if (!workspaces.length) refresh(); });
  registerAction({ group: "Actions", icon: "sync", label: "Mark the current Tide workspace", run: mark });

  render();
  return { refresh, mark };
}
