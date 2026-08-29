// settings.js — everything about this machine that is not a workspace.
//
// Account and provider key, the Cell's power state and resource quota, which MCP
// servers are enabled (the manifest, edited live), the tenant's other sandboxes,
// distros, and machine tokens.

import {
  $, h, fill, api, bus, state, setState, toast, toastError, dialog, confirmDialog,
  fmtAgo, fmtBytes, slug,
} from "./core.js";
import { power } from "./shell.js";
import { registerAction } from "./palette.js";

function section(title, description, ...children) {
  return h("div.card", { style: { marginBottom: "var(--s-4)" } },
    h("h3", { style: { fontSize: "var(--fs-md)" } }, title),
    description ? h("p.dim", { style: { fontSize: "var(--fs-sm)", margin: "4px 0 var(--s-3)" } }, description) : null,
    ...children,
  );
}

export function initSettings() {
  const body = $("#settings-body");
  let profile = null;
  let quota = null;
  let servers = { enabled: [], available: [] };
  let sandboxes = [];
  let distros = [];
  let access = [];
  let tokens = [];
  let me = null;

  async function load() {
    const [p, q, s, sb, d, ac, tk] = await Promise.all([
      api.get("/api/profile").catch(() => null),
      api.get("/api/quota").catch(() => null),
      api.tryMcp("mcp-registry", "list", {}),
      api.get("/api/sandboxes").catch(() => ({ sandboxes: [] })),
      api.get("/api/distros").catch(() => ({ distros: [] })),
      api.get("access").catch(() => ({ access: [] })),
      api.get("tokens").catch(() => ({ tokens: [] })),
    ]);
    profile = p;
    quota = q?.quota ?? null;
    servers = s ?? servers;
    sandboxes = sb?.sandboxes ?? [];
    distros = d?.distros ?? [];
    access = ac?.access ?? [];
    me = ac?.you ?? null;
    tokens = tk?.tokens ?? [];
    if (p) setState({ user: p.user, tenant: p.tenant, profile: p.profile });
    if (s) setState({ servers: s.enabled ?? [] });
    render();
  }

  // ── Provider key ───────────────────────────────────────────────────────────

  function providerSection() {
    const providers = profile?.profile?.providers ?? [];
    const current = profile?.profile?.llmProvider;
    const keyInput = h("input", { type: "password", placeholder: "paste a new key", autocomplete: "new-password" });

    const picker = h("div.choice-grid", null, ...providers.map((p) => h("label.choice", null,
      h("input", { type: "radio", name: "provider", value: p.id, checked: p.id === current }),
      h("span.name", p.label ?? p.id),
      h("span.note", p.configured ? "key set" : "no key yet"),
    )));

    return section("AI provider",
      "Natural-language commands and AI agents run against this provider. The key is stored encrypted and never returned to the browser.",
      picker,
      h("div.row", { style: { marginTop: "var(--s-3)" } },
        keyInput,
        h("button", {
          onclick: async () => {
            const chosen = picker.querySelector("input:checked")?.value ?? current;
            try {
              const r = await api.post("/api/profile", {
                llmProvider: chosen,
                ...(keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
                completeOnboarding: true,
              });
              profile = r;
              setState({ profile: r.profile });
              keyInput.value = "";
              toast("Provider saved", { kind: "ok" });
              render();
            } catch (e) { toastError("Could not save the provider", e); }
          },
        }, "Save"),
        h("button.ghost", {
          onclick: async () => {
            if (!await confirmDialog("Clear the stored key?", "Natural language and AI agents stop working until a new key is saved.")) return;
            try {
              profile = await api.post("/api/profile", { clearApiKey: true });
              toast("Key cleared", { kind: "ok" });
              render();
            } catch (e) { toastError("Could not clear the key", e); }
          },
        }, "Clear key"),
      ),
    );
  }

  // ── Cell ───────────────────────────────────────────────────────────────────

  function cellSection() {
    return section("Cell",
      "The isolation boundary that executes this Sandbox. It wakes on demand and hibernates when idle; the volume survives either way.",
      h("div.row", { style: { flexWrap: "wrap" } },
        h("span.chip", { class: state.cell === "running" ? "ok" : "" }, state.cell),
        state.backend ? h("span.chip.mono", state.backend) : null,
        h("span.spacer"),
        h("button.ghost.sm", { onclick: () => power("wake") }, "Wake"),
        h("button.ghost.sm", { onclick: () => power("hibernate") }, "Hibernate"),
      ),
      quota ? h("div", { style: { marginTop: "var(--s-3)" } },
        h("table.data", null,
          h("tbody", null,
            ...[["Sandboxes", quota.max_sandboxes], ["Concurrent agents", quota.max_agents],
                ["Running cells", quota.max_running], ["Memory", `${quota.mem_mb} MB`],
                ["CPU shares", quota.cpu_shares]].map(([k, v]) =>
              h("tr", null, h("td.dim", k), h("td.right.mono", String(v)))))),
        h("button.ghost.sm", { style: { marginTop: "var(--s-2)" }, onclick: editQuota }, "Edit quota"),
      ) : null,
    );
  }

  async function editQuota() {
    const got = await dialog({
      title: "Resource quota",
      message: "Applies to your tenant. The host may enforce a lower ceiling of its own.",
      fields: [
        { name: "maxSandboxes", label: "Max sandboxes", type: "number", value: String(quota.max_sandboxes) },
        { name: "maxAgents", label: "Max concurrent agents", type: "number", value: String(quota.max_agents) },
        { name: "maxRunning", label: "Max running cells", type: "number", value: String(quota.max_running) },
        { name: "memMb", label: "Memory (MB)", type: "number", value: String(quota.mem_mb) },
        { name: "cpuShares", label: "CPU shares", type: "number", value: String(quota.cpu_shares) },
      ],
      confirmLabel: "Save",
    });
    if (!got) return;
    try {
      const r = await api.post("/api/quota", {
        maxSandboxes: Number(got.maxSandboxes), maxAgents: Number(got.maxAgents),
        maxRunning: Number(got.maxRunning), memMb: Number(got.memMb), cpuShares: Number(got.cpuShares),
      });
      quota = r.quota;
      toast("Quota updated", { kind: "ok" });
      render();
    } catch (e) { toastError("Could not update the quota", e); }
  }

  // ── Servers (the manifest) ─────────────────────────────────────────────────

  function serversSection() {
    const enabled = new Set(servers.enabled ?? []);
    const installed = new Set(servers.installed ?? []);
    const builtin = new Set(servers.available ?? []);
    const all = [...new Set([...builtin, ...installed, ...enabled])].sort();
    return section("MCP servers",
      "A Sandbox is composed, not fixed. Enabling a server adds its tools to this machine's kernel immediately; a marketplace server runs out of process and is governed identically.",
      h("div.cards", null, ...all.map((name) => h("div.item", null,
        h("div.item-head", null,
          h("span.dot", { class: enabled.has(name) ? "running" : "stopped" }),
          h("span.item-title.grow.mono", name),
          installed.has(name) ? h("span.chip.sand", "marketplace") : null,
        ),
        h("div.item-actions", null,
          enabled.has(name)
            ? h("button.ghost.sm", { disabled: name === "kernel" || name === "mcp-registry", onclick: () => toggleServer(name, false) }, "Disable")
            : h("button.ghost.sm", { onclick: () => toggleServer(name, true) }, "Enable"),
          installed.has(name)
            ? h("button.ghost.sm.danger", { onclick: () => uninstallServer(name) }, "Uninstall")
            : null,
        ),
      ))),
      h("button.ghost.sm", { style: { marginTop: "var(--s-3)" }, onclick: installServer }, "Install a server…"),
    );
  }

  async function installServer() {
    const got = await dialog({
      title: "Install an MCP server",
      message: "A marketplace server runs in its own process with no handle to the control plane. Its tools still go through the Kernel, so they are authorized and audited like any other.",
      fields: [
        { name: "name", label: "Name", placeholder: "weather", hint: "How it will be addressed: name.tool" },
        { name: "source", label: "Source", placeholder: "npm:some-mcp-server  ·  /path/to/server.js",
          hint: "An npm package or a file path, subject to the host's install allowlist." },
      ],
      confirmLabel: "Install",
    });
    if (!got?.name || !got.source) return;
    try {
      await api.mcp("mcp-registry", "install", { name: got.name, source: got.source });
      toast("Server installed", { body: `${got.name} is enabled`, kind: "ok" });
      await load();
      bus.emit("kernel:mutated", { line: `servers ${got.name}` });
    } catch (e) { toastError("Install failed", e); }
  }

  async function uninstallServer(name) {
    if (!await confirmDialog("Uninstall this server?",
      `${name} is removed from the manifest and its process is stopped. Anything that called ${name}.* will start failing.`,
      { confirmLabel: "Uninstall" })) return;
    try {
      await api.mcp("mcp-registry", "uninstall", { name });
      await load();
      bus.emit("kernel:mutated", { line: `servers ${name}` });
    } catch (e) { toastError("Uninstall failed", e); }
  }

  async function toggleServer(name, on) {
    try {
      await api.mcp("mcp-registry", on ? "enable" : "disable", { server: name });
      toast(on ? `${name} enabled` : `${name} disabled`, { kind: "ok" });
      await load();
      bus.emit("kernel:mutated", { line: `servers ${name}` });
    } catch (e) { toastError(`Could not ${on ? "enable" : "disable"} ${name}`, e); }
  }

  // ── Sandboxes + distros ────────────────────────────────────────────────────

  function sandboxesSection() {
    return section("Sandboxes",
      "Every slug is a machine. They sleep when idle and wake when you open them.",
      h("table.data", null,
        h("thead", null, h("tr", null, h("th", "Slug"), h("th", "Name"), h("th", "State"), h("th", "Last active"), h("th.right", ""))),
        h("tbody", null, ...sandboxes.map((sb) => h("tr", null,
          h("td.mono", sb.slug === slug ? h("strong", sb.slug) : sb.slug),
          h("td", sb.name ?? "—"),
          h("td", h("span.chip", { class: sb.state === "running" ? "ok" : "" }, sb.state)),
          h("td.dim", fmtAgo(sb.last_active_at)),
          h("td.right", sb.slug === slug
            ? h("button.ghost.sm", { onclick: snapshot }, "Snapshot as distro")
            : h("button.ghost.sm", { onclick: () => { location.href = `/${sb.slug}`; } }, "Open")),
        )))),
      h("button.ghost.sm", { style: { marginTop: "var(--s-2)" }, onclick: () => $("#machine-btn").click() }, "New sandbox…"),
    );
  }

  function distrosSection() {
    if (!distros.length) {
      return section("Distros",
        "A distro is a named manifest — a machine described well enough to recreate. Snapshot this Sandbox to make one.",
        h("button.ghost.sm", { onclick: snapshot }, "Snapshot this sandbox"));
    }
    return section("Distros", "Named manifests you can create new sandboxes from.",
      h("table.data", null,
        h("thead", null, h("tr", null, h("th", "Name"), h("th", "Description"), h("th.right", ""))),
        h("tbody", null, ...distros.map((d) => h("tr", null,
          h("td.mono", d.name),
          h("td.dim", d.description || "—"),
          h("td.right", h("button.ghost.sm.danger", { onclick: () => removeDistro(d.name) }, "Delete")),
        )))),
      h("button.ghost.sm", { style: { marginTop: "var(--s-2)" }, onclick: snapshot }, "Snapshot this sandbox"));
  }

  async function snapshot() {
    const got = await dialog({
      title: "Snapshot as a distro",
      message: "Captures this Sandbox's manifest — its enabled servers, apps and ports — under a name you can build new machines from.",
      fields: [
        { name: "name", label: "Name", placeholder: "web-dev" },
        { name: "description", label: "Description", placeholder: "Node + a dev server on :3000" },
      ],
      confirmLabel: "Snapshot",
    });
    if (!got?.name) return;
    try {
      await api.post(`sandboxes/${slug}/snapshot`, { name: got.name, description: got.description });
      toast("Distro created", { body: got.name, kind: "ok" });
      load();
    } catch (e) { toastError("Snapshot failed", e); }
  }

  async function removeDistro(name) {
    if (!await confirmDialog("Delete this distro?", `${name} is removed. Sandboxes already created from it are untouched.`)) return;
    try { await api.del(`/api/distros/${encodeURIComponent(name)}`); load(); }
    catch (e) { toastError("Could not delete the distro", e); }
  }

  // ── Machine tokens ─────────────────────────────────────────────────────────

  // ── Access ─────────────────────────────────────────────────────────────────

  function accessSection() {
    const people = access.filter((a) => a.kind === "human");
    const agents = access.filter((a) => a.kind === "agent");
    return section("Who can reach this machine",
      "Access is a set of capability patterns, not a role. You can share only what you already hold.",
      h("table.data", null,
        h("thead", null, h("tr", null,
          h("th", "Principal"), h("th", "Can invoke"), h("th", "Since"), h("th.right", ""))),
        h("tbody", null, ...[...people, ...agents].map((a) => h("tr", null,
          h("td", null,
            h("div.row", null,
              h("span", a.username ?? a.name),
              a.principalId === me ? h("span.chip.accent", "you") : null,
              a.kind !== "human" ? h("span.chip", a.kind) : null,
            )),
          h("td", h("div.row", { style: { flexWrap: "wrap" } },
            ...a.patterns.map((p) => h("span.chip.mono", p)))),
          h("td.dim", fmtAgo(a.grantedAt)),
          h("td.right", a.principalId === me
            ? null
            : h("button.ghost.sm.danger", { onclick: () => revoke(a) }, "Revoke")),
        )))),
      h("button.ghost.sm", { style: { marginTop: "var(--s-2)" }, onclick: share }, "Share with someone…"),
    );
  }

  async function share() {
    const got = await dialog({
      title: "Share this sandbox",
      message: "They will see it in their machine switcher, and can invoke exactly the tools you grant — nothing more.",
      fields: [
        { name: "username", label: "Username", placeholder: "alice" },
        { name: "patterns", label: "Capabilities", value: "fs.read, proc.list",
          hint: "Comma-separated patterns. Use * to give full access." },
      ],
      confirmLabel: "Share",
    });
    if (!got?.username) return;
    try {
      const r = await api.post("access", {
        username: got.username.trim(),
        patterns: got.patterns.split(",").map((p) => p.trim()).filter(Boolean),
      });
      toast(r.added.length ? "Shared" : "Already shared",
        { body: `${got.username} · ${r.patterns.join(", ")}`, kind: "ok" });
      load();
    } catch (e) { toastError("Could not share", e); }
  }

  async function revoke(a) {
    if (!await confirmDialog("Revoke access?",
      `${a.username ?? a.name} loses every capability they hold on /${slug}. ${a.kind === "human" ? "Their account is untouched." : "Any token they hold is destroyed."}`,
      { confirmLabel: "Revoke" })) return;
    try { await api.del(`access/${a.principalId}`); load(); }
    catch (e) { toastError("Could not revoke access", e); }
  }

  // ── Tokens ─────────────────────────────────────────────────────────────────

  function tokensSection() {
    return section("Machine tokens",
      "Mint a token for the sbx CLI, a device, or CI. A token can never hold more capability than you do — the mint attenuates it. Revoking one destroys the credential, not just its grants.",
      tokens.length
        ? h("table.data", null,
            h("thead", null, h("tr", null,
              h("th", "Label"), h("th", "Can invoke"), h("th", "Expires"), h("th.right", ""))),
            h("tbody", null, ...tokens.map((t) => h("tr", null,
              h("td", null, h("div.row", null,
                h("span.mono", t.label),
                t.active ? null : h("span.chip.warn", "expired"))),
              h("td", h("div.row", { style: { flexWrap: "wrap" } },
                ...t.patterns.map((p) => h("span.chip.mono", p)))),
              h("td.dim", t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : "—"),
              h("td.right", h("button.ghost.sm.danger", { onclick: () => revokeToken(t) }, "Revoke")),
            ))))
        : h("p.dim", { style: { fontSize: "var(--fs-sm)" } }, "No tokens minted for this sandbox yet."),
      h("button.ghost.sm", { style: { marginTop: "var(--s-2)" }, onclick: mintToken }, "Mint a token"),
    );
  }

  async function revokeToken(t) {
    if (!await confirmDialog("Revoke this token?",
      `${t.label} stops authenticating immediately. Anything using it — a CLI, a device, CI — will start getting 401s.`,
      { confirmLabel: "Revoke" })) return;
    try { await api.del(`tokens/${t.principalId}`); load(); }
    catch (e) { toastError("Could not revoke the token", e); }
  }

  async function mintToken() {
    const got = await dialog({
      title: "Mint a machine token",
      fields: [
        { name: "label", label: "Label", placeholder: "laptop" },
        { name: "patterns", label: "Capabilities", value: "fs.*, proc.exec",
          hint: "Comma-separated patterns, attenuated against your own grants." },
      ],
      confirmLabel: "Mint",
    });
    if (!got) return;
    try {
      const r = await api.post("tokens", {
        label: got.label || "device",
        patterns: got.patterns.split(",").map((p) => p.trim()).filter(Boolean),
      });
      await dialog({
        title: "Token minted", wide: true, confirmLabel: "Done",
        render: () => h("div.col", { style: { gap: "var(--s-3)" } },
          h("p.dim", { style: { fontSize: "var(--fs-sm)" } }, "Copy it now — it is not shown again."),
          h("div.log", r.token),
          h("div.row", { style: { flexWrap: "wrap" } }, ...r.patterns.map((p) => h("span.chip.mono.accent", p))),
          h("button.ghost.sm", { onclick: () => navigator.clipboard?.writeText(r.token).then(() => toast("Token copied")) }, "Copy token"),
        ),
      });
      load();
    } catch (e) { toastError("Could not mint a token", e); }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const u = profile?.user;
    fill(body,
      section("Account", null,
        h("div.row", { style: { flexWrap: "wrap" } },
          h("span.chip", u?.name ?? "—"),
          profile?.tenant ? h("span.chip.mono", profile.tenant.name) : null,
          u?.isOperator ? h("span.chip.sand", "operator") : null,
          h("span.spacer"),
          h("span.dim", { style: { fontSize: "var(--fs-xs)" } },
            profile?.profile?.updatedAt ? `updated ${fmtAgo(profile.profile.updatedAt)}` : ""),
        )),
      providerSection(),
      cellSection(),
      serversSection(),
      accessSection(),
      tokensSection(),
      sandboxesSection(),
      distrosSection(),
    );
  }

  bus.on("workspace:settings", load);
  registerAction({ group: "Actions", icon: "settings", label: "Mint a machine token", run: mintToken });
  registerAction({ group: "Actions", icon: "settings", label: "Snapshot this sandbox as a distro", run: snapshot });

  return { load, refresh: load };
}
