// shell.js — the frame: rail, workspace switching, theme, machine switcher,
// live Cell state and the status bar. Panels never touch this file; they publish
// on the bus and the shell reflects it.

import { $, $$, h, fill, icon, api, bus, state, setState, toast, toastError, dialog,
         confirmDialog, menu, fmtAgo, isMac } from "./core.js";

export const WORKSPACES = [
  { id: "console",  icon: "console",  label: "Console",  key: "1" },
  { id: "assistant", icon: "assistant", label: "Assistant", key: "2" },
  { id: "files",    icon: "files",    label: "Files",    key: "3" },
  { id: "shell",    icon: "shell",    label: "Shell",    key: "4" },
  { id: "agents",   icon: "agents",   label: "Agents",   key: "5" },
  { id: "ports",    icon: "ports",    label: "Ports",    key: "6" },
  { id: "jobs",     icon: "jobs",     label: "Processes",key: "7" },
  { id: "sync",     icon: "sync",     label: "Sync",     key: "8" },
  { id: "apps",     icon: "apps",     label: "Apps",     key: "9" },
  { id: "secrets",  icon: "secrets",  label: "Secrets",  key: "0" },
  { id: "metrics",  icon: "metrics",  label: "Observability", key: "." },
  { id: "settings", icon: "settings", label: "Settings", key: "," },
];

const THEME_KEY = "sbx.theme";
const WS_KEY = "sbx.workspace";
const DOCK_KEY = "sbx.dock";

let current = null;

export function initShell() {
  const rail = $("#rail");

  // ── Rail ───────────────────────────────────────────────────────────────────
  for (const ws of WORKSPACES) {
    rail.append(h("button.rail-btn", {
      id: `rail-${ws.id}`,
      "data-tip": `${ws.label}   ${isMac ? "⌘" : "Ctrl+"}${ws.key}`,
      "aria-label": ws.label,
      onclick: () => show(ws.id),
    }, icon(ws.icon, 17)));
  }

  // ── Theme ──────────────────────────────────────────────────────────────────
  const applyTheme = (t) => {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem(THEME_KEY, t);
    bus.emit("theme", t);
  };
  applyTheme(localStorage.getItem(THEME_KEY) ?? "dark");
  $("#theme-btn").addEventListener("click", () => {
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });

  // ── Dock ───────────────────────────────────────────────────────────────────
  // On a phone the dock covers the workspace, so it starts closed unless the
  // reader has said otherwise on this device.
  const dockPref = localStorage.getItem(DOCK_KEY) ?? (window.innerWidth < 860 ? "collapsed" : "open");
  if (dockPref === "collapsed") document.body.classList.add("dock-collapsed");
  $("#dock-btn").addEventListener("click", () => {
    const collapsed = document.body.classList.toggle("dock-collapsed");
    localStorage.setItem(DOCK_KEY, collapsed ? "collapsed" : "open");
  });

  // ── Machine switcher ───────────────────────────────────────────────────────
  const omniKey = $("#omni .kbd");
  if (omniKey) omniKey.textContent = isMac ? "⌘K" : "Ctrl K";
  $("#slug").textContent = state.slug;
  $("#machine-btn").addEventListener("click", (e) => machineMenu(e.currentTarget));

  // ── Sign out ───────────────────────────────────────────────────────────────
  $("#logout").addEventListener("click", async () => {
    await fetch("/logout", { method: "POST" });
    location.href = "/";
  });

  // ── Keyboard: ⌘1..⌘0 switch workspaces ─────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const ws = WORKSPACES.find((w) => w.key === e.key);
    if (ws) { e.preventDefault(); show(ws.id); }
  });

  show(localStorage.getItem(WS_KEY) ?? "console");
  bus.on("state", renderStatus);
}

/** Switch workspaces. Panels lazily initialise on their first `workspace:<id>`. */
export function show(id) {
  if (!WORKSPACES.some((w) => w.id === id)) id = "console";
  current = id;
  localStorage.setItem(WS_KEY, id);
  for (const ws of WORKSPACES) {
    $(`#ws-${ws.id}`)?.classList.toggle("active", ws.id === id);
    $(`#rail-${ws.id}`)?.classList.toggle("active", ws.id === id);
  }
  bus.emit(`workspace:${id}`);
  bus.emit("workspace", id);
}

export const currentWorkspace = () => current;

/** A small unread/attention badge on a rail button. */
export function railBadge(id, count) {
  const btn = $(`#rail-${id}`);
  if (!btn) return;
  btn.querySelector(".badge")?.remove();
  if (count) btn.append(h("span.badge", count > 99 ? "99+" : String(count)));
}

// ── Machine switcher ─────────────────────────────────────────────────────────

async function machineMenu(anchor) {
  let sandboxes = state.sandboxes;
  if (!sandboxes.length) {
    try { sandboxes = (await api.get("/api/sandboxes")).sandboxes; setState({ sandboxes }); }
    catch (e) { return toastError("Could not list sandboxes", e); }
  }
  menu(anchor, [
    ...sandboxes.map((sb) => ({
      label: `${sb.slug}${sb.slug === state.slug ? "  ·  current" : ""}`,
      icon: sb.state === "running" ? "play" : "stop",
      disabled: sb.slug === state.slug,
      run: () => { location.href = `/${sb.slug}`; },
    })),
    "-",
    { label: "New sandbox…", icon: "plus", run: newSandbox },
    { label: "Delete this sandbox…", icon: "trash", danger: true, run: deleteSandbox },
  ]);
}

async function newSandbox() {
  let distros = [];
  try { distros = (await api.get("/api/distros")).distros ?? []; } catch { /* optional */ }
  const got = await dialog({
    title: "New sandbox",
    message: "A slug is a machine. It becomes the URL you open to reach it.",
    fields: [
      { name: "slug", label: "Slug", placeholder: "scratch", hint: "lowercase letters, digits and dashes" },
      { name: "name", label: "Name", placeholder: "Scratch machine" },
      ...(distros.length
        ? [{ name: "distro", label: "From distro", type: "select", options: [{ value: "", label: "— none —" }, ...distros.map((d) => ({ value: d.name, label: d.name }))] }]
        : []),
    ],
    confirmLabel: "Create",
  });
  if (!got?.slug) return;
  try {
    const r = await api.post("/api/sandboxes", { slug: got.slug, name: got.name || got.slug, distro: got.distro || undefined });
    toast("Sandbox created", { body: `/${r.slug}`, kind: "ok" });
    location.href = `/${r.slug}`;
  } catch (e) { toastError("Could not create sandbox", e); }
}

async function deleteSandbox() {
  const yes = await confirmDialog("Delete this sandbox?",
    `Everything in /${state.slug} — its filesystem, secrets and history — is destroyed. This cannot be undone.`,
    { confirmLabel: "Delete forever" });
  if (!yes) return;
  try {
    await api.del(`/api/sandboxes/${state.slug}`);
    location.href = "/";
  } catch (e) { toastError("Could not delete sandbox", e); }
}

// ── Cell state + status bar ──────────────────────────────────────────────────

export function setCellState(s) {
  setState({ cell: s });
  const cls = s === "running" ? "running" : s === "waking" || s === "connecting" ? "waking"
    : s === "error" ? "error" : "stopped";
  for (const el of [$("#cell-dot"), $("#status-dot")]) {
    if (el) el.className = `dot ${cls}`;
  }
  $("#cell-state").textContent = s;
  $("#status-cell").textContent = s;
}

function renderStatus() {
  $("#status-backend").textContent = state.backend ? `cell: ${state.backend}` : "";
  $("#status-user").textContent = state.user ? `${state.user.name}${state.tenant ? ` · ${state.tenant.name}` : ""}` : "";

  const running = state.procs.filter((p) => p.state === "running").length;
  const procs = $("#status-procs");
  fill(procs, running ? `${running} process${running === 1 ? "" : "es"}` : "");

  const ports = $("#status-ports");
  fill(ports, state.ports.length ? `${state.ports.length} port${state.ports.length === 1 ? "" : "s"}` : "");
}

/** Wake or hibernate the Cell from anywhere in the UI. */
export async function power(action) {
  try {
    setCellState(action === "wake" ? "waking" : "stopping");
    const r = await api.post(action, {});
    setCellState(r.state ?? (action === "wake" ? "running" : "stopped"));
    toast(action === "wake" ? "Cell awake" : "Cell hibernated", { kind: "ok" });
  } catch (e) {
    setCellState("error");
    toastError(`Could not ${action} the Cell`, e);
  }
}
