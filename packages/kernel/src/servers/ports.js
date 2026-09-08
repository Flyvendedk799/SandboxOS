// The `ports` core MCP server — network services inside a Cell, as tools.
//
// A Sandbox is only half useful if you can run a dev server in it but never see
// it. `ports` closes that loop: expose a port, and the Gateway will proxy
// `/<slug>/p/<port>/...` straight into the Cell, so a web app you started with
// `proc.start` is reachable from the same browser tab you launched it from.
//
// Exposure is declarative and lives in the manifest (`ports`), so it survives
// hibernate/wake and travels with a distro like every other part of the machine's
// description. Reaching the service is the Cell backend's job — each backend
// answers `endpoint(port)` with the address the Gateway should dial.

import net from "node:net";
import { loadManifest, saveManifest } from "../../../manifest/src/manifest.js";

/** Ports below this are system services; exposing them is almost always a mistake. */
const MIN_PORT = 1;
const MAX_PORT = 65535;

function assertPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
    throw new Error(`invalid port: ${port}`);
  }
  return n;
}

/** TCP-connect to host:port with a deadline. Resolves true iff something answered. */
export function probe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/** The exposed-port table for a Sandbox, as a plain object keyed by port string. */
export function exposedPorts(sandbox) {
  return loadManifest(sandbox).ports ?? {};
}

export function portsServer(deps) {
  const { sandbox, cell } = deps;

  function mutate(fn) {
    const m = loadManifest(sandbox);
    m.ports = fn(m.ports ?? {});
    saveManifest(sandbox, m);
    return m.ports;
  }

  return {
    name: "ports",
    tools: {
      expose: {
        description: "Expose a port running inside the Sandbox so it is reachable at /<slug>/p/<port>/.",
        inputSchema: {
          type: "object", required: ["port"],
          properties: {
            port: { type: "number" },
            name: { type: "string", description: "Human-readable label, e.g. 'web'." },
            description: { type: "string" },
          },
        },
        async handler(_ctx, a) {
          const port = assertPort(a.port);
          const ports = mutate((p) => ({
            ...p,
            [String(port)]: {
              name: a.name ?? `port-${port}`,
              description: a.description ?? "",
              exposedAt: p[String(port)]?.exposedAt ?? Date.now(),
            },
          }));
          return { port, path: `/${sandbox.slug}/p/${port}/`, ports: Object.keys(ports).map(Number) };
        },
      },

      unexpose: {
        description: "Stop exposing a port (the service keeps running; only the proxy route is removed).",
        inputSchema: { type: "object", required: ["port"], properties: { port: { type: "number" } } },
        async handler(_ctx, a) {
          const port = assertPort(a.port);
          let removed = false;
          mutate((p) => {
            removed = String(port) in p;
            const next = { ...p };
            delete next[String(port)];
            return next;
          });
          return { port, removed };
        },
      },

      list: {
        description: "List the ports exposed by this Sandbox, with live reachability.",
        inputSchema: { type: "object", properties: { check: { type: "boolean", description: "Probe each port (default true)." } } },
        async handler(_ctx, a) {
          const table = exposedPorts(sandbox);
          const check = a.check !== false;
          const out = [];
          for (const [key, meta] of Object.entries(table)) {
            const port = Number(key);
            let up = null;
            if (check) {
              try {
                const ep = await cell.endpoint(port);
                up = await probe(ep.host, ep.port);
              } catch { up = false; }
            }
            out.push({ port, ...meta, up, path: `/${sandbox.slug}/p/${port}/` });
          }
          out.sort((x, y) => x.port - y.port);
          return { ports: out };
        },
      },

      check: {
        description: "Probe whether something is listening on a port inside the Sandbox.",
        inputSchema: {
          type: "object", required: ["port"],
          properties: { port: { type: "number" }, timeoutMs: { type: "number" } },
        },
        async handler(_ctx, a) {
          const port = assertPort(a.port);
          try {
            const ep = await cell.endpoint(port);
            const up = await probe(ep.host, ep.port, Math.min(Number(a.timeoutMs ?? 1500), 10_000));
            return { port, up, host: ep.host };
          } catch (e) {
            return { port, up: false, error: e.message };
          }
        },
      },

      scan: {
        description: "List TCP ports currently listening inside the Sandbox.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          await cell.ensureRunning();
          const found = new Set();
          const add = (port) => { if (port >= MIN_PORT && port <= MAX_PORT) found.add(port); };
          const tried = [];

          // Each strategy belongs to a kind of machine, and a machine that has
          // none of them is told which were tried: a scan that found nothing and
          // a scan that could not look are different answers.
          const strategies = [
            // `ss` on modern distros, `netstat` on older/busybox images.
            {
              needs: "ss/netstat",
              cmd: "ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null || true",
              // The local-address column: 0.0.0.0:3000, [::]:8080, 127.0.0.1:5432
              parse: (out) => { for (const l of out.split("\n")) { const m = l.match(/(?:^|\s)(?:\[[^\]]*\]|[\d.*]+):(\d{1,5})(?:\s|$)/); if (m) add(Number(m[1])); } },
            },
            // The kernel's own table, always there on Linux. State 0A is LISTEN;
            // the local port is hex after the colon.
            {
              needs: "/proc/net/tcp",
              cmd: "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true",
              parse: (out) => { for (const l of out.split("\n")) { const m = l.match(/^\s*\d+:\s+[0-9A-Fa-f]+:([0-9A-Fa-f]{4})\s+[0-9A-Fa-f]+:[0-9A-Fa-f]{4}\s+0A\s/); if (m) add(parseInt(m[1], 16)); } },
            },
            // Windows' netstat, whose LISTENING lines read differently enough to
            // deserve their own parse rather than a hopeful regex over both.
            {
              needs: "netstat -ano",
              cmd: 'netstat -ano -p TCP 2>/dev/null || netstat -ano -p TCP 2>nul || true',
              parse: (out) => { for (const l of out.split("\n")) { const m = l.match(/^\s*TCP\s+\S+:(\d{1,5})\s+\S+\s+LISTENING/i); if (m) add(Number(m[1])); } },
            },
          ];
          for (const s of strategies) {
            if (found.size) break;
            const r = await cell.exec(s.cmd);
            if (r.failure) { tried.push(`${s.needs}: ${r.failure.message}`); break; }
            if (!r.stdout) { tried.push(`${s.needs}: no output`); continue; }
            s.parse(r.stdout);
            if (!found.size) tried.push(`${s.needs}: nothing listening`);
          }

          const exposed = new Set(Object.keys(exposedPorts(sandbox)).map(Number));
          const listening = [...found].sort((a, b) => a - b).map((port) => ({ port, exposed: exposed.has(port) }));
          // Honesty over emptiness: when nothing could look, say so, so a caller
          // can show "cannot scan here" rather than "nothing is listening".
          if (!listening.length && tried.length === strategies.length && tried.every((t) => !t.includes("nothing listening"))) {
            return { listening, unavailable: `cannot list listening ports on this host (tried ${strategies.map((s) => s.needs).join(", ")})`, tried };
          }
          return { listening };
        },
      },
    },
  };
}
