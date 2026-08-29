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

export function procServer(cell, sandbox) {
  // `sandbox` is optional so existing callers that pass only a cell keep working;
  // supervised processes are then keyed by the cell's volume root.
  const sandboxId = sandbox?.id ?? cell?.root ?? "default";

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
          const r = await cell.exec(args.cmd, { timeoutMs: args.timeoutMs ?? 30_000 });
          return { cmd: args.cmd, stdout: r.stdout, stderr: r.stderr, code: r.code };
        },
      },
      list: {
        description: "List processes running inside the Sandbox.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          // `ps` flavors differ (busybox vs coreutils); fall back gracefully.
          const r = await cell.exec("ps -ef 2>/dev/null || ps aux 2>/dev/null || ps");
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
          await cell.ensureRunning();
          const rec = {
            id: nextJobId(),
            name: args.name || args.cmd.split(/\s+/)[0],
            cmd: args.cmd,
            state: "running",
            startedAt: Date.now(),
            logs: [],
            pending: "",
            handle: null,
            pid: null,
          };
          jobsFor(sandboxId).set(rec.id, rec);

          // execStream is sync on the local backend and async on docker/firecracker;
          // awaiting normalizes both.
          const handle = await cell.execStream(args.cmd, (ev) => {
            if (ev.type === "stdout" || ev.type === "stderr") pushLog(rec, ev.type, ev.chunk);
            else if (ev.type === "done") {
              flushLog(rec);
              rec.state = rec.state === "stopped" ? "stopped" : ev.code === 0 ? "exited" : "failed";
              rec.code = ev.code;
              rec.exitedAt = Date.now();
            }
          }, { timeoutMs: args.timeoutMs ?? 24 * 60 * 60 * 1000 });

          rec.handle = handle;
          rec.pid = handle?.pid ?? null;
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
          return { id: args.id, forgotten: true };
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
          const r = await cell.exec(`kill -${sig} ${Number(args.pid)}`);
          return { pid: Number(args.pid), signal: sig, code: r.code, stderr: r.stderr };
        },
      },
    },
  };
}
