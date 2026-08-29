// apps.js — the app model.
//
// An app is a frontend URL plus the capability patterns it may use. Launching
// one mints an attenuated machine token scoped to exactly those patterns, so an
// app never inherits your full authority just by being installed.

import {
  $, h, fill, api, bus, toast, toastError, dialog, confirmDialog, emptyState,
} from "./core.js";
import { registerAction } from "./palette.js";

export function initApps() {
  const list = $("#apps-list");
  let apps = [];

  function card(a) {
    return h("div.item", null,
      h("div.item-head", null,
        h("span.item-title.grow.truncate", a.name),
        h("span.chip.mono", `${a.patterns?.length ?? 0} cap${a.patterns?.length === 1 ? "" : "s"}`),
      ),
      a.description ? h("div.item-meta", a.description) : null,
      h("div.item-meta.truncate", { title: a.url }, a.url),
      h("div.row", { style: { flexWrap: "wrap" } },
        ...(a.patterns ?? []).map((p) => h("span.chip.mono.accent", p))),
      h("div.item-actions", null,
        h("button.sm", { onclick: () => launch(a.name) }, "Launch"),
        h("button.ghost.sm.danger", { onclick: () => remove(a.name) }, "Remove"),
      ),
    );
  }

  function render() {
    if (!apps.length) {
      fill(list, emptyState("▦", "No apps installed",
        "An app is a frontend paired with a set of capabilities. Install one and it runs against this Sandbox with exactly the authority you granted.",
        { label: "Install an app", run: install }));
      return;
    }
    fill(list, ...apps.map(card));
  }

  async function refresh() {
    try {
      apps = (await api.get("apps")).apps ?? [];
      render();
    } catch (e) {
      fill(list, emptyState("!", "Apps unavailable", e.message));
    }
  }

  async function install() {
    const got = await dialog({
      title: "Install an app",
      fields: [
        { name: "name", label: "Name", placeholder: "notes" },
        { name: "url", label: "URL", placeholder: "/static/apps/notes.html" },
        { name: "patterns", label: "Capabilities", placeholder: "fs.read, fs.write",
          hint: "Comma-separated. Leave blank to grant nothing." },
        { name: "description", label: "Description", placeholder: "What it does" },
      ],
      confirmLabel: "Install",
    });
    if (!got?.name || !got.url) return;
    try {
      await api.mcp("apps", "install", {
        name: got.name, url: got.url, description: got.description || "",
        patterns: got.patterns.split(",").map((p) => p.trim()).filter(Boolean),
      });
      toast("App installed", { body: got.name, kind: "ok" });
      refresh();
    } catch (e) { toastError("Install failed", e); }
  }

  async function launch(name) {
    try {
      const r = await api.mcp("apps", "launch", { name });
      const url = r.url.includes("?") ? `${r.url}&token=${encodeURIComponent(r.token)}` : `${r.url}?token=${encodeURIComponent(r.token)}`;
      window.open(url, "_blank", "noopener");
      toast("App launched", { body: `scoped to ${r.patterns.join(", ")}`, kind: "ok" });
    } catch (e) { toastError("Launch failed", e); }
  }

  async function remove(name) {
    if (!await confirmDialog("Remove this app?", `${name} is removed from the manifest. Nothing it wrote is deleted.`,
      { confirmLabel: "Remove" })) return;
    try { await api.mcp("apps", "remove", { name }); refresh(); }
    catch (e) { toastError("Could not remove the app", e); }
  }

  $("#apps-refresh").addEventListener("click", refresh);
  $("#app-install-btn").addEventListener("click", install);
  bus.on("workspace:apps", refresh);
  registerAction({ group: "Actions", icon: "apps", label: "Install an app", run: install });

  return { refresh };
}
