// Phase 46: what a proposal would touch.
//
// T2.3 asked to "see a structural diff (windows, widgets, theme keys, files
// changed) and Apply or Discard" before an agent's change runs. Apply and
// Discard shipped with Track 2. The diff is the interesting part, because a
// truthful one is not available: the ops have not run, and their effect can only
// be simulated by running them — or by a second, pure implementation of every
// desktop tool, which is a second implementation to keep honest and the one
// people would stop trusting first.
//
// What *is* true before anything happens is which parts of the document each
// call changes. That is `PROPOSAL_TOUCHES`, checked here against the real tool
// list so a new tool cannot be added without saying what it touches — and after
// applying, the history's own structural diff says exactly what did change.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { PROPOSAL_TOUCHES, DOC_SECTIONS, proposalImpact } from "../packages/os/src/proposals.js";
import { READ_ONLY_DESKTOP_TOOLS } from "../packages/os/src/catalog.js";

let kernel, owner, sandbox, held;
const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
const ok = async (server, tool, args) => { const r = await call(server, tool, args); assert.ok(r.ok, `${server}.${tool}: ${r.error}`); return r.result; };
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  await ok("desktop", "reset", {});
});
test.after(() => { _resetKernels(); closeDb(); });

// ── the table cannot fall behind the tools ─────────────────────────────────

test("every desktop tool says what it touches", async () => {
  const { tools } = await ok("kernel", "tools", {});
  const desktopTools = tools.filter((t) => t.name.startsWith("desktop.")).map((t) => t.name.slice("desktop.".length));
  assert.ok(desktopTools.length > 50, `there are a lot of them (${desktopTools.length})`);

  const missing = desktopTools.filter((t) => !READ_ONLY_DESKTOP_TOOLS.has(t) && !Object.hasOwn(PROPOSAL_TOUCHES, t));
  assert.deepEqual(missing, [],
    "a tool that can be proposed must say which parts of the document it changes");

  // And the table cannot drift the other way either.
  const stale = Object.keys(PROPOSAL_TOUCHES).filter((t) => !desktopTools.includes(t));
  assert.deepEqual(stale, [], "the table has no entries for tools that no longer exist");

  // Every section named is one the rest of the OS already uses.
  for (const [tool, sections] of Object.entries(PROPOSAL_TOUCHES)) {
    for (const s of sections) {
      assert.ok(DOC_SECTIONS.includes(s), `${tool} touches "${s}", which is not a section`);
    }
  }
});

// ── and it says the true thing ─────────────────────────────────────────────

test("a proposal's impact is the union of what its calls touch", () => {
  assert.deepEqual(proposalImpact({ ops: [{ tool: "arrange" }, { tool: "widgetAdd" }] }).sections, ["windows", "widgets"]);
  assert.deepEqual(proposalImpact({ ops: [{ tool: "themeSet" }] }).sections, ["theme"]);
  assert.deepEqual(proposalImpact({ ops: [{ tool: "appWrite" }, { tool: "appDefine" }] }).sections, ["apps"]);
  assert.equal(proposalImpact({ ops: [{ tool: "move" }, { tool: "move" }] }).ops, 2, "and it counts the calls");
});

test("a call that replaces the document says so instead of listing parts", () => {
  // "windows, everything" would read as narrower than it is.
  assert.deepEqual(proposalImpact({ ops: [{ tool: "move" }, { tool: "reset" }] }).sections, ["everything"]);
  assert.deepEqual(proposalImpact({ ops: [{ tool: "distroFork" }] }).sections, ["everything"]);
});

test("a tool nobody recognises is named, not treated as harmless", () => {
  const impact = proposalImpact({ ops: [{ tool: "someNewThing" }] });
  assert.deepEqual(impact.unknown, ["someNewThing"]);
  assert.deepEqual(impact.sections, ["everything"], "an unknown call is assumed to touch anything");
  const nameless = proposalImpact({ ops: [{}] });
  assert.deepEqual(nameless.unknown, ["(nameless)"]);
  assert.deepEqual(proposalImpact(null).sections, [], "and nothing at all touches nothing");
});

// ── the tool reports it, and the panel reads the same table ────────────────

test("desktop.proposals carries the impact of each one", async () => {
  await ok("desktop", "propose", {
    label: "tidy and theme",
    ops: [{ tool: "arrange", args: { preset: "grid" } }, { tool: "themeSet", args: { theme: "tide" } }],
  });
  const { proposals } = await ok("desktop", "proposals", {});
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].impact.sections, ["windows", "theme"]);
  assert.equal(proposals[0].impact.ops, 2);
  assert.deepEqual(proposals[0].ops.map((o) => o.tool), ["arrange", "themeSet"], "the exact calls are still there");
});

test("what actually changed is measured afterwards, not predicted before", async () => {
  const before = (await ok("desktop", "state", {})).doc;
  const { proposals } = await ok("desktop", "proposals", {});
  const applied = await ok("desktop", "applyProposal", { id: proposals[0].id });
  assert.ok(applied.ok);

  // The history's own diff, from the revision before the first op: this is the
  // real answer, and the panel's "what changed" reads exactly this.
  const from = applied.rev - (applied.applied.length + 1);
  const r = await ok("desktop", "history", { rev: Math.max(0, from) });
  assert.ok(r.diff, "the history can diff any revision against now");
  assert.equal((await ok("desktop", "state", {})).doc.theme.base, "tide", "and the change did happen");
  assert.notEqual(before.theme.base, "tide");
});

test("the panel says would-change, and does not claim to know the values", () => {
  const agent = read("../apps/gateway/public/js/os/agent.js");
  assert.match(agent, /import \{ proposalImpact \} from "\/static\/js\/os\/lib\/proposals\.js"/,
    "the panel reads the same table the tool does");
  assert.match(agent, /"would change"/);
  assert.match(agent, /Deliberately not a predicted diff/, "and the comment says why");
  assert.match(agent, /impact\.unknown/, "an unrecognised call is shown as such");
  assert.match(agent, /async function showApplied\(\)/, "with the measured diff available after applying");
  assert.match(agent, /api\.mcp\("desktop", "history", \{ rev:/);
  const server = read("../apps/gateway/src/server.js");
  assert.match(server, /"keys\.js", "proposals\.js"/, "and the module is served from packages/os rather than copied");
});
