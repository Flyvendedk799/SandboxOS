// secrets.js — names and references, never values.
//
// The secrets server hands out `secret://name` references; the plaintext only
// ever exists inside the Cell for the duration of a command that asked for it.
// This panel reflects that: you can store, reference and use a secret from here,
// but there is nothing in the UI that can show you one back.

import {
  $, h, fill, api, bus, toast, toastError, dialog, confirmDialog, emptyState, fmtAgo,
} from "./core.js";
import { registerAction } from "./palette.js";

export function initSecrets() {
  const list = $("#secrets-list");
  let secrets = [];

  function render() {
    if (!secrets.length) {
      fill(list, emptyState("⚿", "No secrets stored",
        "Store an API key or token here and reference it as secret://name. The value is encrypted at rest and never returned to the browser.",
        { label: "Add a secret", run: add }));
      return;
    }
    fill(list, h("table.data", null,
      h("thead", null, h("tr", null,
        h("th", "Name"), h("th", "Reference"), h("th", "Added"), h("th.right", ""))),
      h("tbody", null, ...secrets.map((s) => h("tr", null,
        h("td", s.name),
        h("td.mono.dim", s.ref ?? `secret://${s.name}`),
        h("td.dim", s.created_at ? fmtAgo(s.created_at) : "—"),
        h("td.right", h("div.row", { style: { justifyContent: "flex-end" } },
          h("button.ghost.sm", { onclick: () => useSecret(s.name) }, "Use in a command"),
          h("button.ghost.sm", { onclick: () => copyRef(s.name) }, "Copy ref"),
          h("button.ghost.sm.danger", { onclick: () => remove(s.name) }, "Delete"),
        )),
      ))),
    ));
  }

  async function refresh() {
    try {
      secrets = (await api.get("secrets")).secrets ?? [];
      render();
    } catch (e) {
      fill(list, emptyState("!", "Secrets unavailable", e.message));
    }
  }

  async function add() {
    const got = await dialog({
      title: "Store a secret",
      message: "The value is encrypted immediately and never comes back out of the Kernel.",
      fields: [
        { name: "name", label: "Name", placeholder: "GITHUB_TOKEN" },
        { name: "value", label: "Value", type: "password", placeholder: "paste the secret" },
      ],
      confirmLabel: "Store",
    });
    if (!got?.name || !got.value) return;
    try {
      await api.post("secrets", { name: got.name, value: got.value });
      toast("Secret stored", { body: `secret://${got.name}`, kind: "ok" });
      refresh();
    } catch (e) { toastError("Could not store the secret", e); }
  }

  async function useSecret(name) {
    const got = await dialog({
      title: `Run with ${name}`,
      message: `The value is injected as the environment variable ${name} for this one command. Only stdout, stderr and the exit code come back.`,
      fields: [{ name: "cmd", label: "Command", placeholder: `curl -H "Authorization: Bearer $${name}" https://api.example.com` }],
      confirmLabel: "Run",
    });
    if (!got?.cmd) return;
    try {
      const r = await api.post(`secrets/${encodeURIComponent(name)}/use`, { cmd: got.cmd });
      await dialog({
        title: "Result", wide: true, confirmLabel: "Close",
        render: () => h("div.col", { style: { gap: "var(--s-3)" } },
          h("div.row", null, h("span.chip", { class: r.code ? "err" : "ok" }, `exit ${r.code}`)),
          r.stdout ? h("div.field", null, h("label", "stdout"), h("div.log", r.stdout)) : null,
          r.stderr ? h("div.field", null, h("label", "stderr"), h("div.log.stderr", r.stderr)) : null,
        ),
      });
    } catch (e) { toastError("Command failed", e); }
  }

  function copyRef(name) {
    navigator.clipboard?.writeText(`secret://${name}`)
      .then(() => toast("Reference copied", { body: `secret://${name}` }))
      .catch(() => toast("Could not copy", { kind: "err" }));
  }

  async function remove(name) {
    if (!await confirmDialog("Delete this secret?", `${name} is removed permanently. Anything referencing secret://${name} will start failing.`,
      { confirmLabel: "Delete" })) return;
    try { await api.del(`secrets/${encodeURIComponent(name)}`); refresh(); }
    catch (e) { toastError("Could not delete the secret", e); }
  }

  $("#secrets-refresh").addEventListener("click", refresh);
  $("#secret-add-btn").addEventListener("click", add);
  bus.on("workspace:secrets", refresh);
  registerAction({ group: "Actions", icon: "secrets", label: "Store a secret", run: add });

  return { refresh };
}
