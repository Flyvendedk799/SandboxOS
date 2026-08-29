// app.js — boot.
//
// Mount the shell, then each workspace. Panels are independent: they talk to the
// Gateway themselves and coordinate through the bus, so one failing panel never
// takes the desktop down with it.

import { $, api, bus, state, setState, toast, toastError, dialog } from "./core.js";
import { initShell, setCellState } from "./shell.js";
import { initActivity } from "./activity.js";
import { initConsole } from "./console.js";
import { initFiles } from "./files.js";
import { initPty } from "./pty.js";
import { initAgents } from "./agents.js";
import { initPorts } from "./ports.js";
import { initJobs } from "./jobs.js";
import { initApps } from "./apps.js";
import { initSecrets } from "./secrets.js";
import { initMetrics } from "./metrics.js";
import { initSettings } from "./settings.js";
import { initPalette } from "./palette.js";

/** Mount a panel, and never let one panel's failure stop the rest booting. */
function mount(name, fn) {
  try { return fn(); }
  catch (e) {
    console.error(`[sandboxos] ${name} failed to start`, e);
    toast(`${name} failed to start`, { body: e.message, kind: "err", timeout: 0 });
    return null;
  }
}

async function loadContext() {
  const [health, profile, tools, registry] = await Promise.all([
    fetch("/health").then((r) => r.json()).catch(() => null),
    api.get("/api/profile").catch(() => null),
    api.tryMcp("kernel", "tools", {}),
    api.tryMcp("mcp-registry", "list", {}),
  ]);

  setState({
    backend: health?.cellBackend ?? null,
    user: profile?.user ?? null,
    tenant: profile?.tenant ?? null,
    profile: profile?.profile ?? null,
    servers: registry?.enabled ?? [],
    tools: (tools?.tools ?? []).map((t) => t.name ?? t),
  });

  // A fresh account has no provider key yet; make that the first thing it sees.
  const wantsOnboarding = new URLSearchParams(location.search).has("onboarding")
    || (profile && !profile.profile?.onboardingCompleted);
  if (wantsOnboarding) onboard(profile);
}

async function onboard(profile) {
  const providers = profile?.profile?.providers ?? [{ id: "claude", label: "Claude" }, { id: "openai", label: "OpenAI" }];
  const got = await dialog({
    title: "Finish setting up your machine",
    message: "Natural-language commands and AI agents need a provider key. You can skip this and add one later from Settings — everything else works without it.",
    fields: [
      { name: "provider", label: "Provider", type: "select", value: profile?.profile?.llmProvider ?? "claude",
        options: providers.map((p) => ({ value: p.id, label: p.label ?? p.id })) },
      { name: "apiKey", label: "API key", type: "password", placeholder: "paste your key", hint: "Stored encrypted; never returned to the browser." },
    ],
    confirmLabel: "Save and continue",
  });

  // Dismissing the dialog still completes onboarding — it should not reappear on
  // every load once the user has decided to skip it.
  try {
    const r = await api.post("/api/profile", {
      llmProvider: got?.provider ?? profile?.profile?.llmProvider ?? "claude",
      ...(got?.apiKey?.trim() ? { apiKey: got.apiKey.trim() } : {}),
      completeOnboarding: true,
    });
    setState({ profile: r.profile });
    if (got?.apiKey?.trim()) toast("You are set up", { body: "Try ? followed by plain English in the console.", kind: "ok" });
  } catch (e) { toastError("Could not save your setup", e); }

  history.replaceState(null, "", location.pathname);
}

function boot() {
  setCellState("connecting");
  initShell();

  const consolePanel = mount("Console", initConsole);
  const files = mount("Files", initFiles);
  mount("Activity", initActivity);
  mount("Shell", initPty);
  mount("Agents", initAgents);
  mount("Ports", initPorts);
  mount("Processes", initJobs);
  mount("Apps", initApps);
  mount("Secrets", initSecrets);
  mount("Metrics", initMetrics);
  mount("Settings", initSettings);

  mount("Palette", () => initPalette({
    files,
    runCommand: (line) => bus.emit("console:run", line),
  }));

  loadContext().catch((e) => toastError("Could not load this machine", e));

  // Anything that reshapes the machine from the console should refresh the tree.
  bus.on("kernel:mutated", (e) => {
    if (/^(write|mkdir|rm|mv|cp|touch)\b/.test(e.detail?.line ?? "")) bus.emit("files:changed");
  });

  // Global shortcuts that are not workspace switches.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.activeElement?.blur?.();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
