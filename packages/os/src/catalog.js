// The built-in catalog: the apps and widgets every SandboxOS desktop starts with.
//
// A built-in is a name, an icon and a hue — the renderer that draws it lives in
// the client. Everything a built-in can do, a *custom* app can do too: the only
// difference is that a custom app ships its own HTML instead of being drawn by
// code we shipped. That symmetry is the point of the whole feature, so keep the
// two descriptor shapes identical (see `appDescriptor` in apps.js).

/** Icons resolve against the OS sprite sheet (`#i-<icon>` in os.html). */
export const BUILTIN_APPS = [
  { id: "files",     name: "Files",         icon: "files",     hue: "#35d6c4", window: { w: 460, h: 300 }, needs: ["fs.*"] },
  { id: "terminal",  name: "Terminal",      icon: "shell",     hue: "#e8c98a", window: { w: 520, h: 300 }, needs: ["proc.exec"] },
  { id: "console",   name: "Console",       icon: "code",      hue: "#f0b849", window: { w: 480, h: 300 }, needs: ["proc.exec"] },
  { id: "notes",     name: "Notes",         icon: "notes",     hue: "#6aa9ff", window: { w: 420, h: 300 }, needs: ["fs.read", "fs.write"] },
  { id: "assistant", name: "Assistant",     icon: "assistant", hue: "#b98cff", window: { w: 440, h: 340 }, needs: [] },
  { id: "metrics",   name: "Observability", icon: "metrics",   hue: "#43d17f", window: { w: 400, h: 280 }, needs: ["metrics.*"] },
  { id: "media",     name: "Media",         icon: "media",     hue: "#ff8f5e", window: { w: 420, h: 320 }, needs: ["fs.list"] },
  { id: "browser",   name: "Browser",       icon: "browser",   hue: "#3ec8ff", window: { w: 520, h: 360 }, needs: ["ports.list"] },
  { id: "settings",  name: "Settings",      icon: "settings",  hue: "#9fb0c0", window: { w: 400, h: 300 }, needs: [] },
  { id: "studio",    name: "OS Studio",     icon: "layers",    hue: "#35d6c4", window: { w: 640, h: 420 }, needs: ["desktop.*"] },
  // The machine's own work, on the desktop rather than in a console: a desktop
  // that sends you elsewhere to restart a dev server is a demo of a desktop
  // (goal.md Track 1).
  { id: "jobs",      name: "Jobs",          icon: "play",      hue: "#f0b849", window: { w: 620, h: 400 }, needs: ["proc.*", "cron.*"] },
  { id: "ports",     name: "Ports",         icon: "network",   hue: "#3ec8ff", window: { w: 560, h: 380 }, needs: ["ports.*"] },
  { id: "agents",    name: "Agents",        icon: "assistant", hue: "#b98cff", window: { w: 620, h: 420 }, needs: ["agents.*"] },
  { id: "secrets",   name: "Secrets",       icon: "key",       hue: "#e8c98a", window: { w: 480, h: 340 }, needs: ["secrets.*"] },
  { id: "sync",      name: "Sync",          icon: "refresh",   hue: "#7be3d0", window: { w: 600, h: 400 }, needs: ["tide.*"] },
  { id: "access",    name: "Access",        icon: "shield",    hue: "#9fb0c0", window: { w: 560, h: 380 }, needs: ["access.*"] },
  { id: "audit",     name: "Audit",         icon: "list",      hue: "#43d17f", window: { w: 680, h: 420 }, needs: ["kernel.auditQuery"] },
];

export const BUILTIN_WIDGETS = [
  { kind: "clock",    name: "Clock",         icon: "jobs",     size: { w: 220, h: 120 } },
  { kind: "load",     name: "System Load",   icon: "metrics",  size: { w: 220, h: 150 } },
  { kind: "calendar", name: "Calendar",      icon: "notes",    size: { w: 220, h: 210 } },
  { kind: "weather",  name: "Weather",       icon: "theme",    size: { w: 220, h: 130 } },
  { kind: "audit",    name: "Audit Feed",    icon: "activity", size: { w: 240, h: 180 } },
  { kind: "actions",  name: "Quick Actions", icon: "apps",     size: { w: 220, h: 140 } },
  { kind: "jobs",     name: "Processes",     icon: "jobs",     size: { w: 240, h: 170 } },
  { kind: "notes",    name: "Sticky Note",   icon: "notes",    size: { w: 220, h: 160 } },
];

/** Distro seeds: a name, the theme it wears, and what it opens with. */
export const BUILTIN_DISTROS = [
  {
    id: "dev", name: "Developer Box", hue: "#35d6c4", theme: "midnight",
    description: "Files · Terminal · Jobs · Ports · Assistant",
    apps: ["files", "terminal", "jobs", "assistant"], widgets: ["clock", "load"],
    dock: ["files", "terminal", "jobs", "ports", "assistant", "settings"],
  },
  {
    id: "research", name: "Research Box", hue: "#3ec8ff", theme: "tide",
    description: "Browser · Notes · Assistant · citations",
    apps: ["browser", "notes", "assistant"], widgets: ["clock", "calendar"],
  },
  {
    id: "creator", name: "Creator Studio", hue: "#b98cff", theme: "aurora",
    description: "Media · Notes · animation presets",
    apps: ["media", "notes"], widgets: ["clock", "actions"],
  },
  {
    id: "ops", name: "Social Ops", hue: "#ff8f5e", theme: "sunset",
    description: "Jobs · Ports · Observability · scheduled agents",
    apps: ["jobs", "ports", "metrics"], widgets: ["load", "audit"],
    dock: ["jobs", "ports", "agents", "metrics", "audit", "settings"],
  },
  {
    id: "minimal", name: "Minimal", hue: "#c9b48c", theme: "mono",
    description: "One clock. One terminal. Nothing else.",
    apps: ["terminal"], widgets: ["clock"],
  },
  {
    // The Tide-native posture: the app's UI is ordinary files in the Cell tree,
    // edited in Files, versioned by Tide, served through the same containment
    // check as everything else. Fork it to see what `origin: "volume"` feels like.
    id: "workshop", name: "Workshop", hue: "#7be3d0", theme: "tide",
    description: "Files · Terminal · a Notebook app whose source lives in the volume",
    apps: ["files", "terminal"], widgets: ["clock"],
    customApps: [{
      id: "notebook", name: "Notebook", icon: "notes", hue: "#7be3d0", kind: "bundle",
      origin: "volume", volumePath: "apps/notebook", permissions: ["fs.read", "fs.write", "fs.list"],
      window: { w: 520, h: 360 },
      description: "A notebook that keeps its pages in notes/. Its own source is in apps/notebook — open it in Files.",
    }],
    seedFiles: {
      "apps/notebook/index.html": [
        "<!doctype html>", '<html lang="en"><head><meta charset="utf-8" /><title>Notebook</title>',
        "<style>",
        "  body { margin:0; padding:14px; font:13px/1.5 ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif; color:var(--os-text,#e6edf3); background:transparent; display:flex; flex-direction:column; height:100vh; box-sizing:border-box; }",
        "  h1 { font-size:14px; margin:0 0 8px; } .dim { color:var(--os-text-3,#6b7f92); font-size:11px; margin:0 0 10px; }",
        "  textarea { flex:1; border:1px solid var(--os-line,#1e2833); border-radius:8px; background:var(--os-chip,rgba(255,255,255,.05)); color:inherit; padding:10px; font:12px/1.6 inherit; outline:none; resize:none; }",
        "  .bar { display:flex; gap:8px; margin-top:8px; align-items:center; } button { height:26px; padding:0 10px; border:0; border-radius:7px; background:var(--os-accent,#35d6c4); color:#04211e; font-weight:600; cursor:pointer; }",
        "  #status { font-size:11px; color:var(--os-text-3,#6b7f92); }",
        "</style></head><body>",
        "<h1>Notebook</h1>",
        '<p class="dim">This app is three files in <code>apps/notebook/</code> inside your machine. Edit them in Files; Tide keeps their history.</p>',
        '<textarea id="page" placeholder="Write…"></textarea>',
        '<div class="bar"><button id="save">Save to notes/notebook.md</button><span id="status"></span></div>',
        '<script type="module" src="./app.js"></script>',
        "</body></html>", "",
      ].join("\n"),
      "apps/notebook/app.js": [
        "const page = document.getElementById('page');",
        "const status = document.getElementById('status');",
        "const PATH = 'notes/notebook.md';",
        "async function load() {",
        "  try { page.value = await sbx.read(PATH); status.textContent = 'loaded'; }",
        "  catch { status.textContent = 'new page'; }",
        "}",
        "document.getElementById('save').addEventListener('click', async () => {",
        "  try { await sbx.write(PATH, page.value); status.textContent = 'saved ' + new Date().toLocaleTimeString(); }",
        "  catch (e) { status.textContent = 'error: ' + e.message; }",
        "});",
        "load(); sbx.ready();", "",
      ].join("\n"),
      "notes/notebook.md": "# Notebook\n\nThis page is written by the Notebook app — whose own source is in apps/notebook.\n",
    },
  },
];

export const builtinApp = (id) => BUILTIN_APPS.find((a) => a.id === id) ?? null;
export const builtinWidget = (kind) => BUILTIN_WIDGETS.find((w) => w.kind === kind) ?? null;
export const builtinDistro = (id) => BUILTIN_DISTROS.find((d) => d.id === id) ?? null;
