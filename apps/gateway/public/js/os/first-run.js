// first-run.js — the first screen a new machine shows. goal.md T5.1.
//
// It has one job and one screen: explain the single idea this whole system is
// built on, let you pick what the machine starts as, and then hand you a machine
// that is *doing something* — a folder in your volume, served by a job you can
// stop, at an address under your own slug.
//
// Two rules it keeps:
//
//   · It never lies about what happened. `desktop.setup` reports every step,
//     including the ones this host could not do (an image with no Node cannot
//     serve a folder), and this screen prints them as they come back rather than
//     showing a tick and hoping.
//   · It is skippable, and skipping is honest too: the machine is marked set up
//     and the welcome folder is simply not written. Nothing here is a wall.

import { h, fill, icon, api, toastError } from "../core.js";
import { call } from "./client.js";

const IDEA = [
  ["The desktop is a document",
   "Every window, widget, theme and app is one JSON object on the server. Nothing lives only in this tab."],
  ["So a second tab is the same machine",
   "Open it on a phone, come back tomorrow, let an agent move a window: same document, same revision counter."],
  ["And every change is a tool call",
   "You and an agent use the same desktop tools, authorized against what you hold and written to the audit log."],
  ["Which means every change can be undone",
   "History keeps the last forty revisions, and an undo can be aimed at one part — the windows, say — not just rewound."],
];

/**
 * Show the welcome screen. Resolves when the machine is set up (or the person
 * chose to skip), so the caller can render the desktop it produced.
 */
export function firstRun(host, { seeds, onDone, viewport }) {
  return new Promise((resolve) => {
    let chosen = seeds[0]?.id ?? "dev";
    let busy = false;
    const stepsEl = h("div.fr-steps", { hidden: true });
    const finish = async (result) => { await onDone?.(result); resolve(result); };

    const seedButton = (s) => h("button.fr-seed", {
      class: s.id === chosen ? "on" : "",
      onclick: () => { if (busy) return; chosen = s.id; paint(); },
      "aria-pressed": s.id === chosen ? "true" : "false",
    },
      h("span.fr-swatch", { style: { background: s.hue ?? "var(--os-accent)" } }),
      h("span.fr-seed-name", s.name),
      h("span.fr-seed-desc", s.description ?? ""));

    const go = h("button.fr-go");
    const skip = h("button.fr-skip", { onclick: () => start({ skip: true }) }, "Skip — I will set it up myself");

    async function start(opts = {}) {
      if (busy) return;
      busy = true;
      paint();
      fill(stepsEl, h("div.fr-step", null, h("span.fr-dot.on"), h("span", opts.skip ? "marking this machine set up…" : "setting up your machine…")));
      stepsEl.hidden = false;
      try {
        const r = await api.mcp("desktop", "setup", opts.skip ? { skip: true } : { seed: chosen });
        // Print what actually happened, in the words the tool used.
        fill(stepsEl, ...(r.steps ?? []).map((st) => h("div.fr-step", { class: st.ok ? "" : "bad" },
          h("span.fr-dot", { class: st.ok ? "on" : "bad" }),
          h("span", null, st.what, st.why ? h("span.fr-why", ` — ${st.why}`) : null))));
        if (!opts.skip && !(r.steps ?? []).every((st) => st.ok)) {
          // Something did not happen. Leave the list on screen and let the
          // person read it before the desktop appears behind it.
          stepsEl.append(h("button.fr-go.small", { onclick: () => finish(r) }, "Take me to the desktop anyway"));
          busy = false;
          return;
        }
        await onDone?.(r);
        // Tidy the windows the setup opened against this actual screen — through
        // the client, so it commits against the revision the client now holds.
        if (!opts.skip && viewport) await call("arrange", { preset: "grid", viewport }).catch(() => {});
        resolve(r);
      } catch (e) {
        busy = false;
        paint();
        toastError("Setup could not finish", e);
        fill(stepsEl, h("div.fr-step.bad", null, h("span.fr-dot.bad"), h("span", e.message)),
          h("button.fr-go.small", { onclick: () => finish(null) }, "Go to the desktop"));
      }
    }

    go.addEventListener("click", () => start());

    function paint() {
      fill(go, busy ? "Setting up…" : `Start as ${seeds.find((s) => s.id === chosen)?.name ?? chosen}`);
      go.disabled = busy;
      skip.disabled = busy;
      for (const el of panel.querySelectorAll(".fr-seed")) {
        const on = el.dataset.seed === chosen;
        el.classList.toggle("on", on);
        el.setAttribute("aria-pressed", on ? "true" : "false");
        el.disabled = busy;
      }
    }

    const panel = h("div.fr-panel", { role: "dialog", "aria-modal": "true", "aria-label": "Set up this machine" },
      h("div.fr-head", null,
        h("span.fr-mark", null, icon("layers", 20)),
        h("div", null,
          h("h1.fr-title", "One idea, and then it is yours"),
          h("p.fr-sub", "Ninety seconds of reading, and a machine that is already doing something."))),

      h("div.fr-idea", null, ...IDEA.map(([title, body], i) => h("div.fr-card", null,
        h("span.fr-n", String(i + 1)),
        h("b", title),
        h("p", body)))),

      h("div.fr-pick", null,
        h("h2", "What should it start as?"),
        h("p.fr-sub", "A seed is only a starting desktop — you can change every part of it afterwards, or fork someone else's."),
        h("div.fr-seeds", null, ...seeds.map((s) => {
          const b = seedButton(s);
          b.dataset.seed = s.id;
          return b;
        }))),

      h("div.fr-actions", null, go, skip),
      stepsEl,
      h("p.fr-foot", null,
        "Setup writes a ", h("code", "welcome/"), " folder into your volume, serves it as a supervised job, and exposes its port under your slug. ",
        "All three are ordinary things you can open, edit and stop."));

    fill(host, h("div.fr-scrim", null, panel));
    paint();
    panel.querySelector(".fr-seed")?.focus?.();
  });
}

/** Has this machine been through first run? Old documents predate the field. */
export const needsFirstRun = (doc) => doc?.setup ? !doc.setup.done : false;
