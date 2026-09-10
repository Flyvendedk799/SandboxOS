// notify.js — how the machine tells you something happened.
//
// A build that finishes while you are in another tab, an agent that comes back
// with an answer, a supervised process that dies at 3am: the desktop should know
// about all of it, and should still know when you open it tomorrow. So a system
// notification is a document write like everything else — not an ephemeral toast
// that only exists if a browser happened to be watching.
//
// One rule keeps this honest: **notifying never creates a desktop.** A machine
// nobody has ever opened as an OS stays without one; a `proc.start` on a headless
// Sandbox should not quietly materialize a Sandboxfile's worth of state on disk.
// `hasOs` is the guard, and it is why this lives in its own module rather than
// inside store.js — the callers are servers that must not depend on the OS
// existing.

import fs from "node:fs";

import { mutateOs, osPath } from "./store.js";
import { rid, LIMITS } from "./schema.js";

/** Has this Sandbox ever been opened as an OS? */
export function hasOs(sandbox) {
  try { return fs.existsSync(osPath(sandbox)); } catch { return false; }
}

/**
 * Post a system notification, if there is a desktop to post it to.
 * Never throws: a notification that cannot be delivered must not fail the thing
 * it was reporting on.
 *
 * @returns {boolean} whether it was delivered
 */
export function notifyOs(sandbox, { app = "system", title, body = "", kind = "info", source = "system", action = null, quiet: askedQuiet = false } = {}) {
  if (!sandbox || !title || !hasOs(sandbox)) return false;
  try {
    mutateOs(sandbox, (d) => {
      if (d.shell?.notifications?.enabled === false) return;
      // Do-not-disturb does not throw anything away: the notification is
      // recorded exactly as it would have been, and marked `quiet` so no
      // surface interrupts anyone with it. The decision is made here, once, so
      // a phone, a second tab and the terminal renderer all agree (T3.3).
      // A caller can also ask for quiet on its own account: a routine success
      // belongs in the notification centre, not in front of somebody. "Batched"
      // in goal.md T3.3 means exactly this — collected where you look for it
      // rather than announced — and it is one flag rather than a queue with
      // timers, because the centre already groups by who is talking.
      const n = d.shell?.notifications ?? {};
      const quiet = askedQuiet || (!!n.dnd && !(n.allow ?? []).includes(source));
      d.notifications.push({
        id: rid("n"),
        app: String(app).slice(0, LIMITS.nameLen),
        title: String(title).slice(0, LIMITS.titleLen),
        body: String(body).slice(0, 600),
        kind: ["ok", "warn", "err", "info", "accent"].includes(kind) ? kind : "info",
        source: ["agents", "procs", "apps", "system"].includes(source) ? source : "system",
        ...(quiet ? { quiet: true } : {}),
        ...(action ? { action } : {}),
        ts: Date.now(),
        read: false,
      });
      while (d.notifications.length > LIMITS.notifications) d.notifications.shift();
    }, { op: "notify", label: `${app}: ${title}`.slice(0, 60) });
    return true;
  } catch {
    return false;
  }
}

/** The notification a supervised process earns when it stops running. */
export function notifyJobEnded(sandbox, job) {
  const ok = job.state === "exited" && (job.code === 0 || job.code == null);
  return notifyOs(sandbox, {
    app: "Processes",
    source: "procs",
    // Exited cleanly: worth recording, not worth interrupting for. A failure or
    // a stop is the other thing, and it comes through.
    quiet: ok,
    kind: ok ? "ok" : job.state === "stopped" ? "info" : "err",
    title: ok ? `${job.name} finished` : job.state === "stopped" ? `${job.name} stopped` : `${job.name} failed`,
    body: job.state === "stopped"
      ? `Job ${job.id} was stopped.`
      : `Job ${job.id} exited with code ${job.code ?? "?"}.`,
    // Clicking it goes back to the job it is about, following its log (T1.1). A
    // notification that tells you something failed and then leaves you to find
    // it is a notification that made you do the work twice.
    action: { app: "jobs", props: { job: job.id, follow: true } },
  });
}

/** The notification an agent earns when it comes back. */
export function notifyAgentEnded(sandbox, agent, state) {
  const kind = state === "done" ? "accent" : state === "killed" ? "info" : "err";
  // An agent coming back is the interruption most people do want through a
  // do-not-disturb, which is why `allow: ["agents"]` is the default.
  return notifyOs(sandbox, {
    app: "Agents",
    source: "agents",
    kind,
    title: `${agent.name ?? "Agent"} ${state}`,
    body: state === "done"
      ? String(agent.result ?? "").slice(0, 200) || "Finished with no output."
      : String(agent.error ?? "").slice(0, 200) || `The agent ${state}.`,
    // …and back to the agent, with its transcript and its tool calls.
    action: { app: "agents", props: { agent: agent.id } },
  });
}
