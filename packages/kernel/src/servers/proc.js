// The `proc` core MCP server — processes as tools.
//
// Two shapes of execution live here:
//   • one-shot   — `exec` runs a command to completion and returns its output.
//   • supervised — `start` launches a long-running process (a dev server, a build
//                  watcher, a queue worker) that outlives the request. The Kernel
//                  keeps its handle, tails its output into a bounded ring buffer,
//                  and exposes `jobs` / `logs` / `stop` to manage it.
//
// Everything runs *inside the Cell* and goes through the Kernel, so even "run a
// shell command" is an authorized, audited MCP call rather than a raw PTY bypass.

import { notifyJobEnded } from "../../../os/src/notify.js";
import { raiseFailure } from "../../../cell/src/shell.js";
import { listSessions, killSession, renameSession, killAllSessions } from "../pty-sessions.js";
import { loadJobs, saveJobs } from "./job-store.js";

// Supervised processes, keyed by Sandbox id → job id → record. Module-level (not
// per-server-instance) because the Kernel rebuilds its server set whenever the
// manifest changes, and a running dev server must survive that.
const _jobs = new Map();

/** Max log lines retained per supervised process (older lines are dropped). */
const MAX_LOG_LINES = 2000;
/** Max characters retained in one log line. */
const MAX_LINE_CHARS = 4000;

function jobsFor(sandboxId) {
  let m = _jobs.get(sandboxId);
  if (!m) { m = new Map(); _jobs.set(sandboxId, m); }
  return m;
}

let _seq = 0;
const nextJobId = () => `p${Date.now().toString(36)}${(_seq++).toString(36)}`;

/** Public view of a supervised process (no handle, no logs). */
function jobView(rec) {
  return {
    id: rec.id, name: rec.name, cmd: rec.cmd, pid: rec.pid ?? null,
    state: rec.state, code: rec.code ?? null,
    ...(rec.failure ? { failure: rec.failure } : {}),
    startedAt: rec.startedAt, exitedAt: rec.exitedAt ?? null,
    lines: rec.logs.length,
  };
}

/** Append a chunk to a record's ring buffer, splitting on newlines. A chunk can
 *  end mid-line, so the tail is held in `rec.pending` until its newline arrives —
 *  otherwise a single log line would be torn across two entries. */
function pushLog(rec, stream, chunk) {
  const parts = ((rec.pending ?? "") + String(chunk)).split("\n");
  rec.pending = parts.pop() ?? "";
  for (const text of parts) {
    rec.logs.push({ ts: Date.now(), stream, text: text.replace(/\r$/, "").slice(0, MAX_LINE_CHARS) });
  }
  if (rec.logs.length > MAX_LOG_LINES) rec.logs.splice(0, rec.logs.length - MAX_LOG_LINES);
}

/** Flush any partial trailing line when a process exits. */
function flushLog(rec) {
  if (rec.pending) {
    rec.logs.push({ ts: Date.now(), stream: "stdout", text: rec.pending.slice(0, MAX_LINE_CHARS) });
    rec.pending = "";
  }
}

/** Terminate every supervised process for a Sandbox (used on hibernate/teardown). */
export function stopAllProcs(sandboxId) {
  const m = _jobs.get(sandboxId);
  if (!m) return 0;
  let killed = 0;
  for (const rec of m.values()) {
    if (rec.state === "running") { try { rec.handle?.kill?.("SIGKILL"); killed += 1; } catch { /* already gone */ } }
  }
  _jobs.delete(sandboxId);
  killed += killAllSessions(sandboxId);
  return killed;
}

/** Terminate every supervised process on this host.
 *
 *  These are children of the Gateway process, so they must not outlive it: an
 *  orphaned dev server keeps its port bound, which means the next boot cannot
 *  rebind it and nothing in the job table records what is holding it. Called from
 *  the Gateway's shutdown path. */
export function stopAllProcsEverywhere() {
  let killed = 0;
  for (const sandboxId of [..._jobs.keys()]) killed += stopAllProcs(sandboxId);
  return killed;
}

/**
 * Start one supervised process and put it in the table.
 *
 * Shared by `proc.start` and by restore, because a restored job is not a
 * different kind of thing: same id, same command, same supervision. What it does
 * not get is the old logs — those belong to a process that no longer exists, and
 * a fresh log is the honest account of a fresh process.
 */
async function startJob(cell, sandbox, sandboxId, { id, cmd, name, timeoutMs, restoredFrom = null }) {
  await cell.ensureRunning();
  const rec = {
    id: id ?? nextJobId(),
    name: name || cmd.split(/\s+/)[0],
    cmd,
    timeoutMs: timeoutMs ?? null,
    state: "running",
    startedAt: Date.now(),
    ...(restoredFrom ? { restoredFrom } : {}),
    logs: [],
    pending: "",
    handle: null,
    pid: null,
  };
  const table = jobsFor(sandboxId);
  table.set(rec.id, rec);
  remember(sandbox, table);

  // execStream is sync on the local backend and async on docker/firecracker;
  // awaiting normalizes both.
  const handle = await cell.execStream(cmd, (ev) => {
    if (ev.type === "stdout" || ev.type === "stderr") pushLog(rec, ev.type, ev.chunk);
    else if (ev.type === "done") {
      flushLog(rec);
      // A shell that never started is a job that never ran: say which.
      if (ev.failure) rec.failure = ev.failure;
      rec.state = rec.state === "stopped" ? "stopped" : ev.code === 0 ? "exited" : "failed";
      rec.code = ev.code;
      rec.exitedAt = Date.now();
      remember(sandbox, table);
      // A build that finishes while you are looking elsewhere should still be
      // waiting for you when you come back. No-op on a Sandbox that has never
      // been opened as an OS.
      notifyJobEnded(sandbox, jobView(rec));
    }
  }, { timeoutMs: timeoutMs ?? 24 * 60 * 60 * 1000 });

  rec.handle = handle;
  rec.pid = handle?.pid ?? null;
  return rec;
}

/** Write the table down, if this Sandbox is a real one with somewhere to put it. */
function remember(sandbox, table) {
  if (!sandbox?.volume_path) return;
  try { saveJobs(sandbox, [...table.values()]); } catch { /* bookkeeping is not the job */ }
}

// Restore runs once per Sandbox per Gateway process. Not once per `procServer`
// call: the Kernel rebuilds its server set whenever the manifest changes, and
// starting everything again on each rebuild would be a fork bomb with a calendar.
const _restored = new Set();

/** Forget that restore has run, so a test can boot the same Sandbox twice. */
export function _resetJobRestore() { _restored.clear(); }

/**
 * Bring back what was running when the last Gateway went away.
 *
 * Finished jobs come back as history, so the Jobs list is not blank; running
 * ones are started again under their own ids. There is no retry: a command that
 * fails immediately becomes a failed job you can read, which is information,
 * where a restart loop would be noise.
 *
 * Ordering matters and is free: `startJob` awaits `cell.ensureRunning()`, and
 * that is where a Cell adopted from a dead Gateway is emptied of its orphans. So
 * reaping always finishes before the first restored job starts, and a restored
 * dev server never races the corpse of its predecessor for the port.
 */
export async function restoreJobs(cell, sandbox) {
  const sandboxId = sandbox?.id ?? cell?.root ?? "default";
  if (!sandbox?.volume_path || _restored.has(sandboxId)) return { restored: 0, remembered: 0 };
  _restored.add(sandboxId);

  const saved = loadJobs(sandbox);
  if (!saved.length) return { restored: 0, remembered: 0 };
  const table = jobsFor(sandboxId);

  // History first, so the list is complete before anything starts running in it.
  for (const j of saved.filter((x) => x.state !== "running")) {
    if (table.has(j.id)) continue;
    table.set(j.id, {
      ...j, logs: [], pending: "", handle: null, pid: null,
      // The logs went with the Gateway that captured them; say so rather than
      // showing an empty tail that reads like a process that printed nothing.
      interrupted: true,
    });
  }

  let restored = 0;
  for (const j of saved.filter((x) => x.state === "running")) {
    if (table.has(j.id)) continue;
    try {
      await startJob(cell, sandbox, sandboxId, {
        id: j.id, cmd: j.cmd, name: j.name, timeoutMs: j.timeoutMs ?? undefined,
        restoredFrom: j.startedAt ?? null,
      });
      restored += 1;
    } catch (e) {
      // A job that cannot be started is a job that is not running, and the list
      // should say that rather than quietly losing the entry.
      table.set(j.id, {
        ...j, state: "failed", code: null, exitedAt: Date.now(),
        failure: `could not restart: ${e.message}`,
        logs: [], pending: "", handle: null, pid: null,
      });
    }
  }
  remember(sandbox, table);
  if (restored) console.log(`cell ${sandboxId}: restarted ${restored} supervised process${restored === 1 ? "" : "es"} from before the restart`);
  return { restored, remembered: saved.length };
}

export function procServer(cell, sandbox) {
  // `sandbox` is optional so existing callers that pass only a cell keep working;
  // supervised processes are then keyed by the cell's volume root.
  const sandboxId = sandbox?.id ?? cell?.root ?? "default";

  // Fire-and-forget: building the server set must not wait on a container boot,
  // and a Sandbox whose jobs cannot be restored is still a working Sandbox.
  restoreJobs(cell, sandbox).catch((e) => console.error(`restore jobs: ${e.message}`));

  return {
    name: "proc",
    tools: {
      exec: {
        description: "Run a shell command inside the Sandbox and return its output.",
        inputSchema: {
          type: "object", required: ["cmd"],
          properties: { cmd: { type: "string" }, timeoutMs: { type: "number" } },
        },
        async handler(_ctx, args) {
          const r = raiseFailure(await cell.exec(args.cmd, { timeoutMs: args.timeoutMs ?? 30_000 }), "run commands");
          return { cmd: args.cmd, stdout: r.stdout, stderr: r.stderr, code: r.code, ...(r.timedOut ? { timedOut: true } : {}) };
        },
      },
      list: {
        description: "List processes running inside the Sandbox.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          // `ps` flavors differ (busybox vs coreutils); fall back gracefully.
          const r = raiseFailure(await cell.exec("ps -ef 2>/dev/null || ps aux 2>/dev/null || ps"), "list processes");
          return { processes: r.stdout };
        },
      },

      start: {
        description: "Start a long-running supervised process inside the Sandbox. Returns immediately with a job id; use proc.logs to tail it.",
        inputSchema: {
          type: "object", required: ["cmd"],
          properties: {
            cmd: { type: "string" },
            name: { type: "string", description: "Human-readable label." },
            timeoutMs: { type: "number", description: "Hard kill after this long (default 24h)." },
          },
        },
        async handler(_ctx, args) {
          const rec = await startJob(cell, sandbox, sandboxId, {
            cmd: args.cmd, name: args.name, timeoutMs: args.timeoutMs,
          });
          return jobView(rec);
        },
      },

      jobs: {
        description: "List supervised processes started with proc.start.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          return { jobs: [...jobsFor(sandboxId).values()].map(jobView) };
        },
      },

      logs: {
        description: "Tail the captured output of a supervised process.",
        inputSchema: {
          type: "object", required: ["id"],
          properties: {
            id: { type: "string" },
            tail: { type: "number", description: "Return only the last N lines (default 200)." },
            since: { type: "number", description: "Only lines newer than this epoch-ms timestamp." },
          },
        },
        async handler(_ctx, args) {
          const rec = jobsFor(sandboxId).get(args.id);
          if (!rec) throw new Error(`no such process: ${args.id}`);
          let lines = rec.logs;
          if (args.since != null) lines = lines.filter((l) => l.ts > Number(args.since));
          const tail = Math.min(Number(args.tail ?? 200), MAX_LOG_LINES);
          return { ...jobView(rec), logs: lines.slice(-tail) };
        },
      },

      stop: {
        description: "Stop a supervised process started with proc.start.",
        inputSchema: {
          type: "object", required: ["id"],
          properties: { id: { type: "string" }, signal: { type: "string", description: "Default SIGTERM." } },
        },
        async handler(_ctx, args) {
          const rec = jobsFor(sandboxId).get(args.id);
          if (!rec) throw new Error(`no such process: ${args.id}`);
          if (rec.state !== "running") return { id: rec.id, stopped: false, reason: `already ${rec.state}` };
          try { rec.handle?.kill?.(args.signal || "SIGTERM"); } catch { /* raced with exit */ }
          rec.state = "stopped";
          rec.exitedAt = Date.now();
          // Stopping something is a decision, and it has to outlive the Gateway
          // as surely as starting it does — otherwise the next boot helpfully
          // starts the very thing you just turned off.
          remember(sandbox, jobsFor(sandboxId));
          return { id: rec.id, stopped: true };
        },
      },

      forget: {
        description: "Drop a finished supervised process and its captured logs.",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        async handler(_ctx, args) {
          const m = jobsFor(sandboxId);
          const rec = m.get(args.id);
          if (!rec) return { id: args.id, forgotten: false };
          if (rec.state === "running") throw new Error("process is still running — stop it first");
          m.delete(args.id);
          remember(sandbox, m);
          return { id: args.id, forgotten: true };
        },
      },

      // ── terminal sessions ─────────────────────────────────────────────────
      //
      // A pty is a process, so it belongs here beside the supervised ones. The
      // shell itself is created by the WebSocket that attaches to it (a terminal
      // needs a socket); these are the tools for seeing and ending one, so an
      // agent can answer "what shells are open on my machine" and a window can
      // reattach to the session it left.

      sessions: {
        description: "List the terminal sessions on this Sandbox — shells that outlive the windows they were opened in.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          return { sessions: listSessions(sandboxId) };
        },
      },

      sessionRename: {
        description: "Name a terminal session, so it is findable a day later.",
        inputSchema: {
          type: "object", required: ["id", "name"],
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
        async handler(_ctx, args) {
          const s = renameSession(sandboxId, args.id, args.name);
          if (!s) throw new Error(`no such session: ${args.id}`);
          return { session: s };
        },
      },

      sessionKill: {
        description: "End a terminal session and the shell inside it. Closing a window does not do this.",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        async handler(_ctx, args) {
          return { id: args.id, killed: killSession(sandboxId, args.id) };
        },
      },

      signal: {
        description: "Send a signal to a process id inside the Sandbox.",
        inputSchema: {
          type: "object", required: ["pid"],
          properties: { pid: { type: "number" }, signal: { type: "string", description: "Default TERM." } },
        },
        async handler(_ctx, args) {
          const sig = String(args.signal || "TERM").replace(/^SIG/, "");
          const r = raiseFailure(await cell.exec(`kill -${sig} ${Number(args.pid)}`), "signal processes");
          return { pid: Number(args.pid), signal: sig, code: r.code, stderr: r.stderr };
        },
      },
    },
  };
}
