// What a proposed change would touch — goal.md T2.3.
//
// A proposal is a list of `desktop.*` calls that have not run. "Show me the diff
// before I apply it" is the right instinct and the wrong mechanism: the ops are
// executed by tool handlers that mutate the stored document, so simulating them
// would mean either running them (which is applying) or maintaining a second,
// pure implementation of every tool (which is a second implementation to keep
// honest, and the one people would stop trusting first).
//
// What can be said truthfully, before anything runs, is *which parts of the
// document each call changes*. That is this table. The panel reads it to say
// "would change: windows, theme" above the exact calls, and after applying, the
// history's own structural diff says precisely what did change — measured rather
// than predicted.
//
// The table is checked against the tool list by the suite, so a new desktop tool
// cannot be added without saying what it touches.

/** Document sections, in the words the inspector and the history already use. */
export const DOC_SECTIONS = Object.freeze([
  "windows", "widgets", "workspaces", "theme", "animation", "layout",
  "shell", "apps", "widgetKinds", "notifications", "checkpoints", "proposals", "name", "everything",
]);

/** Which sections each writable `desktop.*` tool changes. */
export const PROPOSAL_TOUCHES = Object.freeze({
  // The document as a whole.
  set: ["everything"],
  patch: ["everything"],
  reset: ["everything"],
  revert: ["everything"],
  revertScopes: [],
  distroFork: ["everything"],
  distroImport: ["everything"],
  machineRestore: ["everything"],
  checkpointRestore: ["everything"],
  setup: ["everything"],
  rename: ["name"],

  // Appearance.
  themeSet: ["theme"],
  themeDefine: ["theme"],
  themeRemove: ["theme"],
  wallpaperSet: ["workspaces"],
  animationSet: ["animation"],
  animationDefine: ["animation"],
  animationRemove: ["animation"],

  // Chrome and layout.
  dockSet: ["shell"],
  dockPin: ["shell"],
  shellSet: ["shell"],
  keySet: ["shell"],
  associate: ["shell"],
  layoutSet: ["layout", "workspaces", "windows"],
  tile: ["workspaces", "windows"],

  // Workspaces.
  workspaceAdd: ["workspaces"],
  workspaceRemove: ["workspaces", "windows", "widgets"],
  workspaceRename: ["workspaces"],
  workspaceSwitch: ["workspaces"],

  // Windows.
  open: ["windows"],
  close: ["windows"],
  move: ["windows", "widgets"],
  resize: ["windows", "widgets"],
  focus: ["windows"],
  windowSet: ["windows"],
  arrange: ["windows"],
  snap: ["windows"],
  cycleFocus: ["windows"],
  minimizeAll: ["windows"],

  // Widgets.
  widgetAdd: ["widgets"],
  widgetRemove: ["widgets"],
  widgetSet: ["widgets"],

  // Apps, widget kinds, and their source.
  appDefine: ["apps"],
  appRemove: ["apps", "windows"],
  appWrite: ["apps"],
  appDelete: ["apps"],
  appSuspend: ["apps"],
  widgetDefine: ["widgetKinds"],
  widgetKindRemove: ["widgetKinds", "widgets"],
  widgetWrite: ["widgetKinds"],
  widgetDelete: ["widgetKinds"],

  // Everything else that writes.
  notify: ["notifications"],
  notificationsRead: ["notifications"],
  notificationsClear: ["notifications"],
  checkpoint: ["checkpoints"],
  checkpointRemove: ["checkpoints"],
  propose: ["proposals"],
  applyProposal: ["everything"],
  discardProposal: ["proposals"],
  distroPublish: [],
  distroSet: [],
  machineExport: [],
  keyList: [],
  appLedger: [],
  checkpoints: [],
  checkpointDiff: [],
  setupSeeds: [],
});

/**
 * What a proposal would touch, and what it is made of.
 *
 * `sections` is deliberately a claim about *parts*, never about values: a call
 * that has not run cannot be diffed, and a predicted diff that turned out wrong
 * would be worse than no diff at all. `unknown` names any op whose tool is not
 * in the table, so a proposal is never described as harmless by omission.
 */
export function proposalImpact(proposal) {
  const ops = Array.isArray(proposal?.ops) ? proposal.ops : [];
  const sections = new Set();
  const unknown = [];
  for (const op of ops) {
    const tool = String(op?.tool ?? "");
    const touches = PROPOSAL_TOUCHES[tool];
    if (!touches) { unknown.push(tool || "(nameless)"); sections.add("everything"); continue; }
    for (const s of touches) sections.add(s);
  }
  // "everything" says it all; listing the parts beside it would read as narrower
  // than it is.
  const list = sections.has("everything") ? ["everything"] : DOC_SECTIONS.filter((s) => sections.has(s));
  return {
    ops: ops.length,
    sections: list,
    ...(unknown.length ? { unknown } : {}),
  };
}
