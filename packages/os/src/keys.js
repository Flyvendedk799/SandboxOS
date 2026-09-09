// keys.js — the keyboard, as a closed grammar shared by both sides.
//
// Every shortcut the shell honours is an *action* with a *chord*, and the map
// lives in the OS document (`shell.keys`). That makes the keyboard remappable,
// travelling with a distro, rebindable by an agent through `desktop.keySet` —
// and, just as importantly, readable: the cheat sheet is generated from the map
// rather than written a second time somewhere that drifts (goal.md T3.2).
//
// This module has no Node imports on purpose. The Gateway serves it to the
// browser from the same file the Kernel imports, so the shell that *matches* a
// key and the tool that *validates* one can never disagree about the grammar.

/** What the shell can be asked to do, and what to call it in the cheat sheet. */
export const KEY_ACTIONS = {
  spotlight: "Search apps, files, widgets and tools",
  cheatSheet: "Show the keyboard",
  closeWindow: "Close the front window",
  minimizeWindow: "Minimise the front window",
  minimizeAll: "Minimise everything",
  zoomWindow: "Zoom the front window",
  unzoomWindow: "Unzoom the front window",
  snapLeft: "Snap the front window left",
  snapRight: "Snap the front window right",
  cycleFocus: "Next window",
  cycleFocusBack: "Previous window",
  notifications: "Open the notification centre",
  toggleDnd: "Do not disturb, on or off",
};

export const DEFAULT_KEYS = {
  spotlight: "mod+k",
  cheatSheet: "?",
  closeWindow: "mod+w",
  minimizeWindow: "mod+m",
  minimizeAll: "mod+shift+d",
  zoomWindow: "mod+ArrowUp",
  unzoomWindow: "mod+ArrowDown",
  snapLeft: "mod+ArrowLeft",
  snapRight: "mod+ArrowRight",
  cycleFocus: "mod+`",
  cycleFocusBack: "mod+shift+`",
  notifications: "mod+shift+n",
  toggleDnd: "mod+shift+u",
};

/** Modifiers, then exactly one key. `mod` is ⌘ on a Mac and Ctrl everywhere else. */
const NAMED = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Space", "Tab", "Home", "End", "PageUp", "PageDown",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];
const PLAIN = /^[A-Za-z0-9`~!@#$%^&*()_+\-=[\]{};':",.<>/?\\|]$/;

export function parseChord(chord) {
  if (typeof chord !== "string" || chord.length > 32) return null;
  const parts = chord.split("+");
  const key = parts.pop();
  const mods = new Set(parts);
  for (const m of mods) if (!["mod", "shift", "alt"].includes(m)) return null;
  if (!key || (!NAMED.includes(key) && !PLAIN.test(key))) return null;
  return { mod: mods.has("mod"), shift: mods.has("shift"), alt: mods.has("alt"), key };
}

/** A chord is valid, or it is not stored: an unreadable binding is worse than a
 *  missing one, because the key it claimed then does nothing at all. */
export const isChord = (v) => parseChord(v) !== null;

/**
 * Complete a document's keymap: the defaults, overridden by what is stored.
 *
 * `null` is kept rather than dropped, because "deliberately unbound" has to be
 * *representable*: a missing key would simply come back as its default on the
 * next normalization, and unbinding something would silently undo itself.
 * Anything unreadable is dropped instead — a binding nobody can press is worse
 * than none, since it also steals the key.
 */
export function cleanKeys(input) {
  const out = { ...DEFAULT_KEYS };
  for (const [action, chord] of Object.entries(input ?? {})) {
    if (!Object.hasOwn(KEY_ACTIONS, action)) continue;
    if (chord === null) { out[action] = null; continue; }
    if (isChord(chord)) out[action] = chord;
  }
  return out;
}

/** Does this keyboard event match that chord? */
export function matchesChord(chord, e) {
  const c = parseChord(chord);
  if (!c) return false;
  const mod = !!(e.metaKey || e.ctrlKey);
  if (c.mod !== mod) return false;
  if (c.alt !== !!e.altKey) return false;
  // `?` is shift+/ on most layouts, so a chord that names a shifted character
  // does not also have to name the shift.
  const shifted = c.key.length === 1 && c.key !== c.key.toLowerCase() ? true : c.shift;
  if (c.key.length === 1 && !PLAIN.test(c.key)) return false;
  if (c.key.length > 1) {
    if (c.shift !== !!e.shiftKey) return false;
    return e.key === c.key || (c.key === "Space" && e.key === " ");
  }
  if (!/[A-Za-z0-9]/.test(c.key)) {
    // A punctuation chord matches the character the layout produced, whatever
    // shift did to get there.
    return e.key === c.key;
  }
  if (shifted !== !!e.shiftKey) return false;
  return String(e.key).toLowerCase() === c.key.toLowerCase();
}

/** A chord as a person reads it: ⌘⇧K, not "mod+shift+k". */
export function prettyChord(chord, { mac = true } = {}) {
  const c = parseChord(chord);
  if (!c) return String(chord ?? "");
  const glyphs = [];
  if (c.mod) glyphs.push(mac ? "⌘" : "Ctrl+");
  if (c.shift) glyphs.push(mac ? "⇧" : "Shift+");
  if (c.alt) glyphs.push(mac ? "⌥" : "Alt+");
  const key = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "↵", Escape: "Esc", Space: "Space" }[c.key]
    ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  return glyphs.join("") + key;
}
