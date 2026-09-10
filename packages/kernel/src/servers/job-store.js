// What a Sandbox remembers about its supervised processes.
//
// The job table has always been a Map in the Gateway's memory, which meant a
// restart lost it. For a long time that was survivable in the worst way: the
// process kept running inside the Cell, so at least the dev server was still up
// — invisible, unstoppable, holding its port, but up. Reaping orphans (orphans.js)
// removes the invisible half, and without this the other half goes with it: you
// would come back to an empty Jobs list and nothing running.
//
// So the list is written down. `supervised` is what the word means: something
// that is looked after across the life of the machine, not the life of a process
// that happens to be looking after it.
//
// It lives beside the Cell volume rather than inside it, next to `os/`, for the
// same reason the OS document does: it is the machine's own bookkeeping, not the
// user's files, and it should not appear in Files or travel in a distro.

import fs from "node:fs";
import path from "node:path";

/** Where one Sandbox's job list is kept (a sibling of the Cell volume). */
export const jobsPath = (sandbox) => path.join(path.dirname(sandbox.volume_path), "jobs.json");

/** How many finished jobs are kept as history. Running ones are never dropped. */
export const MAX_REMEMBERED = 50;

/** The fields worth surviving a restart. Deliberately not the logs: they belong
 *  to a process that no longer exists, and a restored job starts a new log rather
 *  than pretending to continue an old one. */
function persistable(rec) {
  return {
    id: rec.id,
    name: rec.name,
    cmd: rec.cmd,
    timeoutMs: rec.timeoutMs ?? null,
    state: rec.state === "running" ? "running" : rec.state,
    code: rec.code ?? null,
    startedAt: rec.startedAt,
    exitedAt: rec.exitedAt ?? null,
    ...(rec.failure ? { failure: rec.failure } : {}),
  };
}

/**
 * Read the remembered list. Anything unreadable reads as empty: a corrupt file
 * must not stop a machine from booting, and the cost of forgetting is one Jobs
 * list, which is exactly what the old behaviour cost every time.
 */
export function loadJobs(sandbox) {
  try {
    const raw = JSON.parse(fs.readFileSync(jobsPath(sandbox), "utf8"));
    const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
    return jobs.filter((j) => j && typeof j.id === "string" && typeof j.cmd === "string");
  } catch {
    return [];
  }
}

/**
 * Write the list. Called on every state change, so it is small, synchronous and
 * atomic-by-rename — a Gateway being SIGKILLed mid-write is the normal case here,
 * not the exceptional one, and a half-written file would be read as no file.
 */
export function saveJobs(sandbox, records) {
  const all = [...records].map(persistable);
  const running = all.filter((j) => j.state === "running");
  const finished = all.filter((j) => j.state !== "running")
    .sort((a, b) => (b.exitedAt ?? b.startedAt ?? 0) - (a.exitedAt ?? a.startedAt ?? 0))
    .slice(0, MAX_REMEMBERED);
  const file = jobsPath(sandbox);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, jobs: [...running, ...finished] }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // A read-only or vanished home is not a reason to fail the call that caused
    // this. The job still starts; it just will not be there tomorrow.
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
  }
}

/** Forget everything, for a Sandbox being destroyed. */
export function clearJobs(sandbox) {
  try { fs.rmSync(jobsPath(sandbox), { force: true }); } catch { /* already gone */ }
}
