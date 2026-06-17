// The `apps` MCP server — Phase 5's application model.
//
// An "app" is a named frontend (a URL) paired with a set of capability patterns.
// Apps live in the manifest's `apps` section. `apps.launch` mints an attenuated
// machine token scoped to the app's patterns, returning it alongside the app URL
// so the frontend can open the app with a proper auth header.

import { loadManifest, saveManifest } from "../../../manifest/src/manifest.js";
import { mintMachineToken } from "../../../control-db/src/registry.js";

export function appsServer(deps) {
  const { sandbox } = deps;

  function getApps() {
    return loadManifest(sandbox).apps ?? {};
  }

  function mutateApps(fn) {
    const m = loadManifest(sandbox);
    m.apps = fn(m.apps ?? {});
    saveManifest(sandbox, m);
    return m.apps;
  }

  return {
    name: "apps",
    tools: {
      list: {
        description: "List apps installed in this Sandbox.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          const apps = getApps();
          return { apps: Object.entries(apps).map(([name, cfg]) => ({ name, ...cfg })) };
        },
      },
      install: {
        description: "Install an app (registers it in the manifest).",
        inputSchema: {
          type: "object",
          required: ["name", "url"],
          properties: {
            name: { type: "string" },
            url: { type: "string" },
            patterns: { type: "array", items: { type: "string" } },
            description: { type: "string" },
          },
        },
        async handler(_ctx, a) {
          if (!a.name || !a.url) throw new Error("name and url required");
          mutateApps((apps) => ({
            ...apps,
            [a.name]: { url: a.url, patterns: a.patterns ?? [], description: a.description ?? "" },
          }));
          return { ok: true, name: a.name };
        },
      },
      remove: {
        description: "Remove an installed app from the manifest.",
        inputSchema: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        async handler(_ctx, a) {
          let removed = false;
          mutateApps((apps) => {
            removed = a.name in apps;
            const next = { ...apps };
            delete next[a.name];
            return next;
          });
          return { ok: true, removed };
        },
      },
      launch: {
        description: "Mint an attenuated machine token for an app and return its URL.",
        inputSchema: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        async handler(ctx, a) {
          const app = getApps()[a.name];
          if (!app) throw new Error(`no such app: ${a.name}`);
          const patterns = app.patterns?.length ? app.patterns : ["*"];
          const minted = mintMachineToken(ctx.principalId, sandbox.id, patterns, { label: `app-${a.name}` });
          return { token: minted.token, url: app.url, name: a.name, patterns: minted.patterns };
        },
      },
    },
  };
}
