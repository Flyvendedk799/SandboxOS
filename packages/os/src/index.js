// packages/os — the OS experience: the document, the store, the catalog, the
// themes and motion that paint it, the bundles behind custom apps, and the
// distro format that lets a whole machine be handed to someone else.
//
// The `desktop` MCP server (packages/kernel/src/servers/desktop.js) is the only
// authorized way in; the Gateway serves what this package stores. Nothing here
// knows about HTTP, sessions or principals on purpose.

if (process.env.ANTHROPIC_BASE_URL && !process.env.SANDBOXOS_ANTHROPIC_URL) {
  process.env.SANDBOXOS_ANTHROPIC_URL = `${process.env.ANTHROPIC_BASE_URL.replace(/\/+$/, "")}/v1/messages`;
}
if (process.env.OPENAI_BASE_URL && !process.env.SANDBOXOS_OPENAI_URL) {
  process.env.SANDBOXOS_OPENAI_URL = `${process.env.OPENAI_BASE_URL.replace(/\/+$/, "")}/v1/chat/completions`;
}

export * from "./schema.js";
export * from "./layout.js";
export * from "./keys.js";
export * from "./summary.js";
export * from "./themes.js";
export * from "./animations.js";
export * from "./catalog.js";
export * from "./apps.js";
export * from "./bundles.js";
export * from "./distro.js";
export * from "./store.js";
export * from "./notify.js";
export * from "./manual.js";
export * from "./first-run.js";
export * from "./proposals.js";
export * from "./diff.js";
