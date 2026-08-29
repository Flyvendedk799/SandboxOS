// The `metrics` core MCP server — what this machine is actually doing.
//
// Observability is a capability like any other, so it is a server rather than a
// side channel: an agent can watch its own Sandbox's load with the same call the
// dashboard makes, and every read is authorized and audited.
//
// Numbers come from inside the Cell wherever they are meaningful (load, memory,
// disk, process count) and from the control plane where they are not (audit
// rollups, uptime, the Cell's declared state). Anything a backend cannot answer
// comes back null rather than zero — a missing reading and an idle machine are
// different facts.

import { auditRollup, recentAudit } from "../../../control-db/src/registry.js";
import { exposedPorts } from "./ports.js";

/** Rolling samples per Sandbox so the dashboard can draw a sparkline. */
const _history = new Map(); // sandboxId -> [{ ts, cpu, memUsed, memTotal, disk, procs }]
const MAX_SAMPLES = 120;

function record(sandboxId, sample) {
  const arr = _history.get(sandboxId) ?? [];
  arr.push(sample);
  if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
  _history.set(sandboxId, arr);
  return arr;
}

export function _resetMetrics(sandboxId) {
  if (sandboxId) _history.delete(sandboxId); else _history.clear();
}

/** Parse `/proc/meminfo` into bytes. Absent on macOS — callers handle null. */
function parseMeminfo(text) {
  const kb = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (total == null) return null;
  return { total, available, used: available == null ? null : total - available };
}

export function metricsServer(deps) {
  const { cell, sandbox, kernel } = deps;

  /** One shell round-trip for every reading we want; cheap and portable. */
  async function probe() {
    await cell.ensureRunning();
    const r = await cell.exec(
      [
        "echo '<<load'",   "cat /proc/loadavg 2>/dev/null || uptime 2>/dev/null || true",
        "echo '<<mem'",    "cat /proc/meminfo 2>/dev/null | head -5 || true",
        "echo '<<disk'",   "du -sk . 2>/dev/null | cut -f1 || true",
        "echo '<<files'",  "find . -type f 2>/dev/null | wc -l || true",
        "echo '<<procs'",  "ps -e 2>/dev/null | wc -l || ps 2>/dev/null | wc -l || true",
        "echo '<<end'",
      ].join("; "),
      { timeoutMs: 15_000 },
    );

    const sections = {};
    let key = null;
    for (const line of (r.stdout ?? "").split("\n")) {
      const m = line.match(/^<<(\w+)$/);
      if (m) { key = m[1]; sections[key] = []; continue; }
      if (key) sections[key].push(line);
    }
    const text = (k) => (sections[k] ?? []).join("\n").trim();
    const num = (k) => {
      const v = Number(text(k).split(/\s+/)[0]);
      return Number.isFinite(v) ? v : null;
    };

    const loadLine = text("load");
    const loadMatch = loadLine.match(/(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)/);
    const diskKb = num("disk");

    return {
      load: loadMatch ? [Number(loadMatch[1]), Number(loadMatch[2]), Number(loadMatch[3])] : null,
      memory: parseMeminfo(text("mem")),
      diskBytes: diskKb == null ? null : diskKb * 1024,
      files: num("files"),
      // `ps`/`wc -l` counts the header row too.
      processes: num("procs") == null ? null : Math.max(0, num("procs") - 1),
    };
  }

  return {
    name: "metrics",
    tools: {
      snapshot: {
        description: "Current resource usage for this Sandbox: load, memory, disk, processes, and what is enabled.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          const p = await probe();
          const ts = Date.now();
          record(sandbox.id, {
            ts,
            load: p.load?.[0] ?? null,
            memUsed: p.memory?.used ?? null,
            memTotal: p.memory?.total ?? null,
            disk: p.diskBytes,
            procs: p.processes,
          });
          return {
            ts,
            sandbox: { id: sandbox.id, slug: sandbox.slug, name: sandbox.name, state: sandbox.state },
            cell: { backend: cell.backend ?? sandbox.cell_backend, root: undefined },
            load: p.load,
            memory: p.memory,
            disk: { bytes: p.diskBytes, files: p.files },
            processes: p.processes,
            servers: kernel ? [...kernel.servers.keys()] : [],
            tools: kernel ? kernel.listTools().length : null,
            ports: Object.keys(exposedPorts(sandbox)).map(Number).sort((a, b) => a - b),
            hostUptimeMs: Math.round(process.uptime() * 1000),
          };
        },
      },

      history: {
        description: "Recent metric samples for this Sandbox, oldest first.",
        inputSchema: { type: "object", properties: { limit: { type: "number" } } },
        async handler(_ctx, a) {
          const arr = _history.get(sandbox.id) ?? [];
          const limit = Math.min(Number(a.limit ?? MAX_SAMPLES), MAX_SAMPLES);
          return { samples: arr.slice(-limit) };
        },
      },

      activity: {
        description: "Audit rollup for this Sandbox: call counts by server, tool and result over a window.",
        inputSchema: {
          type: "object",
          properties: { windowMs: { type: "number", description: "Look-back window (default 1h)." } },
        },
        async handler(_ctx, a) {
          const windowMs = Math.min(Number(a.windowMs ?? 3_600_000), 30 * 24 * 3_600_000);
          const since = Date.now() - windowMs;
          const roll = auditRollup(sandbox.id, since);
          return { since, windowMs, ...roll };
        },
      },

      recent: {
        description: "The most recent audit events for this Sandbox.",
        inputSchema: { type: "object", properties: { limit: { type: "number" } } },
        async handler(_ctx, a) {
          const rows = recentAudit(sandbox.id, Math.min(Number(a.limit ?? 50), 500));
          return {
            events: rows.map((r) => ({
              id: r.id, ts: r.ts, server: r.server, tool: r.tool,
              resultKind: r.result_kind, error: r.error, capability: r.capability,
            })),
          };
        },
      },
    },
  };
}
