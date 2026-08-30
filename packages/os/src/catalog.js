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
    description: "Files · Terminal · Assistant · git-wired",
    apps: ["files", "terminal", "assistant"], widgets: ["clock", "load"],
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
    description: "Metrics · Browser · scheduled agents",
    apps: ["metrics", "browser"], widgets: ["load", "audit"],
  },
  {
    id: "minimal", name: "Minimal", hue: "#c9b48c", theme: "mono",
    description: "One clock. One terminal. Nothing else.",
    apps: ["terminal"], widgets: ["clock"],
  },
];

export const builtinApp = (id) => BUILTIN_APPS.find((a) => a.id === id) ?? null;
export const builtinWidget = (kind) => BUILTIN_WIDGETS.find((w) => w.kind === kind) ?? null;
export const builtinDistro = (id) => BUILTIN_DISTROS.find((d) => d.id === id) ?? null;
