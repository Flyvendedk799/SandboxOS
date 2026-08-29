// ports.js — expose a service running inside the Cell, then look at it.
//
// The payoff of the ports server is the preview: an app you started with
// `run "npm run dev"` becomes an iframe in this tab, proxied through the
// Gateway, with no tunnel and no published host port.

import {
  $, h, fill, api, bus, state, setState, toast, toastError, dialog, confirmDialog,
  emptyState, slug,
} from "./core.js";
import { registerAction } from "./palette.js";

export function initPorts() {
  const list = $("#ports-list");
  const body = $("#ports-body");
  const preview = $("#port-preview");
  const frame = $("#port-frame");
  const previewPath = $("#port-preview-path");
  let ports = [];

  const routeFor = (port) => `/${slug}/p/${port}/`;

  function card(p) {
    return h("div.item", null,
      h("div.item-head", null,
        h("span.dot", { class: p.up ? "running" : "stopped" }),
        h("span.item-title.grow.truncate", p.name || `port ${p.port}`),
        h("span.chip.mono", String(p.port)),
      ),
      p.description ? h("div.item-meta", p.description) : null,
      h("div.item-meta.truncate", routeFor(p.port)),
      h("div.item-actions", null,
        h("button.sm", { disabled: !p.up, onclick: () => openPreview(p.port) }, "Preview"),
        h("button.ghost.sm", { onclick: () => window.open(routeFor(p.port), "_blank", "noopener") }, "New tab"),
        h("button.ghost.sm.danger", { onclick: () => unexpose(p.port) }, "Close"),
      ),
    );
  }

  function render() {
    setState({ ports });
    if (!ports.length) {
      fill(list, emptyState("◎", "No ports exposed",
        "Start something inside the Cell — a dev server, an API — then expose its port and it becomes reachable right here.",
        { label: "Expose a port", run: expose }));
      return;
    }
    fill(list, ...ports.map(card));
  }

  async function refresh() {
    try {
      const r = await api.mcp("ports", "list", { check: true });
      ports = r.ports ?? [];
      render();
    } catch (e) {
      fill(list, emptyState("!", "Ports unavailable",
        `${e.message}. Enable the ports server from Settings if it is not in this Sandbox's manifest.`));
    }
  }

  async function expose(prefillPort) {
    const got = await dialog({
      title: "Expose a port",
      message: "The service keeps running inside the Cell; exposing it only opens a proxied route to it.",
      fields: [
        { name: "port", label: "Port", type: "number", value: prefillPort ?? "3000" },
        { name: "name", label: "Label", placeholder: "web" },
      ],
      confirmLabel: "Expose",
    });
    if (!got?.port) return;
    try {
      await api.mcp("ports", "expose", { port: Number(got.port), name: got.name || undefined });
      toast("Port exposed", { body: routeFor(got.port), kind: "ok" });
      refresh();
    } catch (e) { toastError("Could not expose the port", e); }
  }

  async function unexpose(port) {
    if (!await confirmDialog("Close this route?", `Nothing inside the Cell is stopped — only the /p/${port}/ route is removed.`,
      { confirmLabel: "Close route" })) return;
    try {
      await api.mcp("ports", "unexpose", { port });
      if (frame.dataset.port === String(port)) closePreview();
      refresh();
    } catch (e) { toastError("Could not close the route", e); }
  }

  async function scan() {
    try {
      const r = await api.mcp("ports", "scan", {});
      const found = r.listening ?? [];
      if (!found.length) return toast("Nothing is listening", { body: "No TCP listeners were found inside the Cell." });
      const unexposed = found.filter((p) => !p.exposed);
      if (!unexposed.length) return toast("All listeners are already exposed", { kind: "ok" });
      const got = await dialog({
        title: "Listening inside the Cell",
        message: "These ports have something behind them but no route yet.",
        fields: [{
          name: "port", label: "Expose", type: "select",
          options: unexposed.map((p) => ({ value: String(p.port), label: `port ${p.port}` })),
        }],
        confirmLabel: "Expose",
      });
      if (got?.port) {
        await api.mcp("ports", "expose", { port: Number(got.port) });
        refresh();
      }
    } catch (e) { toastError("Scan failed", e); }
  }

  function openPreview(port) {
    frame.dataset.port = String(port);
    frame.src = routeFor(port);
    previewPath.textContent = routeFor(port);
    body.classList.add("hidden");
    preview.classList.remove("hidden");
  }

  function closePreview() {
    preview.classList.add("hidden");
    body.classList.remove("hidden");
    frame.src = "about:blank";
    delete frame.dataset.port;
  }

  $("#ports-refresh").addEventListener("click", refresh);
  $("#ports-scan").addEventListener("click", scan);
  $("#port-expose-btn").addEventListener("click", () => expose());
  $("#port-preview-close").addEventListener("click", closePreview);
  $("#port-preview-reload").addEventListener("click", () => { frame.src = frame.src; });
  $("#port-preview-open").addEventListener("click", () => {
    if (frame.dataset.port) window.open(routeFor(frame.dataset.port), "_blank", "noopener");
  });

  bus.on("workspace:ports", refresh);
  bus.on("kernel:mutated", (e) => { if (/^ports?\b/.test(e.detail?.line ?? "")) refresh(); });
  registerAction({ group: "Actions", icon: "ports", label: "Expose a port", run: () => expose() });

  refresh();
  return { refresh, expose, preview: openPreview };
}
