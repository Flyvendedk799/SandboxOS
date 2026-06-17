// The `net` core MCP server — networking as tools, with egress policy + rate limiting.
//
// Egress policy comes from the manifest:
//   { egress: "allow", deny: [hosts] }  → default-allow except denied
//   { egress: "deny",  allow: [hosts] } → default-deny except allowed
// Host patterns support exact match and "*.example.com" wildcards.
//
// Rate limiting: per-sandbox sliding window (default 60 req / 60 s).
// Configurable via manifest: { egress: "allow", rateLimit: { requests: N, windowMs: M } }
// or env SANDBOXOS_NET_RATE_LIMIT=N (requests per 60 s).

import dns from "node:dns/promises";
import net from "node:net";

function hostMatches(pattern, host) {
  if (pattern === host) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix);
  }
  return false;
}

export function egressAllowed(policy, host) {
  const allow = policy.allow ?? [];
  const deny = policy.deny ?? [];
  if (deny.some((p) => hostMatches(p, host))) return false;
  if ((policy.egress ?? "allow") === "deny") {
    return allow.some((p) => hostMatches(p, host));
  }
  return true; // default-allow
}

// ── SSRF guard (backlog item #6) ──────────────────────────────────────────────
// Default egress is "allow", so an agent could otherwise fetch internal/cloud-
// metadata targets (http://127.0.0.1:<port>/api/admin/backup, 169.254.169.254,
// RFC1918 hosts) and exfiltrate the response body. The egress *host pattern*
// check is necessary but not sufficient: it is string-only and a public DNS
// name can resolve to a private IP (or be rebound mid-request). So after the
// egress-policy check we resolve the host to concrete IP(s) and unconditionally
// reject any private/loopback/link-local/unique-local address — unless an
// operator-set explicit allow entry names that exact host. To defeat DNS
// rebinding we *pin* the validated IP and issue the actual request against it
// while preserving the original Host header (see fetchPinned below).

// Returns true if `ip` (a literal IPv4/IPv6 string) is in a range an untrusted
// Sandbox must never reach: loopback, link-local, unique-local, or RFC1918.
export function isBlockedAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true; // not a valid literal IP → fail closed
}

function isBlockedV4(ip) {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (o[0] === 127) return true;                                  // 127.0.0.0/8 loopback
  if (o[0] === 10) return true;                                   // 10.0.0.0/8 private
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;      // 172.16.0.0/12 private
  if (o[0] === 192 && o[1] === 168) return true;                  // 192.168.0.0/16 private
  if (o[0] === 169 && o[1] === 254) return true;                  // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (o[0] === 0) return true;                                    // 0.0.0.0/8 "this host"
  return false;
}

function isBlockedV6(ip) {
  let a = ip.toLowerCase().split("%")[0]; // drop any zone id (fe80::1%en0)
  // IPv4-mapped / -compatible (::ffff:127.0.0.1, ::127.0.0.1) → judge by the v4 part.
  const v4 = a.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) return isBlockedV4(v4[1]);
  if (a === "::1" || a === "::") return true;                     // loopback / unspecified
  if (a.startsWith("fe8") || a.startsWith("fe9") ||
      a.startsWith("fea") || a.startsWith("feb")) return true;    // fe80::/10 link-local
  if (a.startsWith("fc") || a.startsWith("fd")) return true;      // fc00::/7 unique-local
  return false;
}

// True only when the operator explicitly named this exact host in the policy's
// allow list (exact or wildcard). Such an entry is a deliberate operator escape
// hatch and is allowed to reach an otherwise-blocked address.
function explicitlyAllowed(policy, host) {
  const allow = policy.allow ?? [];
  return allow.some((p) => hostMatches(p, host));
}

// Resolve `host` and throw if it maps to (or literally is) a blocked address,
// unless the operator explicitly allow-listed it. Returns the validated IP to
// pin the request to (defeats DNS rebinding). `family` carries the IP version.
export async function resolveAndGuard(policy, host) {
  const literal = net.isIP(host);
  if (literal) {
    if (isBlockedAddress(host) && !explicitlyAllowed(policy, host)) {
      throw new Error(`egress blocked: ${host} resolves to a private/loopback address`);
    }
    return { ip: host, family: literal };
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true }); // [{ address, family }, …]
  } catch (e) {
    throw new Error(`dns resolution failed for ${host}: ${e.message}`);
  }
  const allowed = explicitlyAllowed(policy, host);
  for (const { address } of addrs) {
    if (isBlockedAddress(address) && !allowed) {
      throw new Error(`egress blocked: ${host} resolves to a private/loopback address (${address})`);
    }
  }
  // Pin the first resolved address so the actual request can't be rebound to a
  // different (private) IP between this check and the fetch.
  const pin = addrs[0];
  return { ip: pin.address, family: pin.family };
}

// Rewrite `parsed`'s host with the pinned literal IP, preserving scheme, port,
// path, query and fragment. IPv6 literals are bracketed. The original hostname
// is sent back via the Host header by the caller.
function buildPinnedUrl(parsed, ip, family) {
  const u = new URL(parsed.href);
  u.hostname = family === 6 ? `[${ip}]` : ip;
  return u.toString();
}

// ── Sliding-window rate limiter ───────────────────────────────────────────────
// One counter map per sandbox (keyed by sandboxId). Each entry is an array of
// timestamps (ms). On each request, flush entries older than windowMs, then check.

const _windows = new Map(); // sandboxId -> number[]

export function checkRateLimit(sandboxId, { requests, windowMs }) {
  if (!requests || requests <= 0) return; // no limit configured
  const now = Date.now();
  let ts = _windows.get(sandboxId) ?? [];
  ts = ts.filter((t) => now - t < windowMs);
  if (ts.length >= requests) {
    throw new Error(`net.fetch rate limit exceeded: ${requests} requests per ${windowMs / 1000}s`);
  }
  ts.push(now);
  _windows.set(sandboxId, ts);
}

// ── Server factory ─────────────────────────────────────────────────────────────

const DEFAULT_RATE = Number(process.env.SANDBOXOS_NET_RATE_LIMIT ?? 60);

export function netServer(deps) {
  const policy = deps.manifest?.servers?.net ?? { egress: "allow", allow: [], deny: [] };
  const rateConfig = {
    requests: policy.rateLimit?.requests ?? DEFAULT_RATE,
    windowMs: policy.rateLimit?.windowMs ?? 60_000,
  };
  const sandboxId = deps.sandbox?.id;

  return {
    name: "net",
    tools: {
      fetch: {
        description: "HTTP request from inside the Sandbox (egress-policy gated, rate limited).",
        inputSchema: {
          type: "object", required: ["url"],
          properties: {
            url: { type: "string" }, method: { type: "string" },
            headers: { type: "object" }, body: { type: "string" }, timeoutMs: { type: "number" },
          },
        },
        async handler(_ctx, a) {
          let parsed;
          try { parsed = new URL(a.url); }
          catch { throw new Error(`invalid url: ${a.url}`); }
          const host = parsed.hostname;
          if (!egressAllowed(policy, host)) throw new Error(`egress denied by policy: ${host}`);

          // SSRF guard (backlog #6): resolve the host and reject private/loopback/
          // link-local/unique-local targets, then pin the validated IP for the
          // actual request so it cannot be DNS-rebound to a private address.
          const { ip, family } = await resolveAndGuard(policy, host);
          const pinnedUrl = buildPinnedUrl(parsed, ip, family);
          // Preserve the original Host header so name-based vhosts/TLS SNI still work.
          const headers = { ...(a.headers ?? {}), Host: parsed.host };

          if (sandboxId) checkRateLimit(sandboxId, rateConfig);

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), a.timeoutMs ?? 15_000);
          try {
            const res = await fetch(pinnedUrl, {
              method: a.method ?? "GET", headers, body: a.body, signal: controller.signal,
            });
            const text = await res.text();
            return {
              status: res.status,
              ok: res.ok,
              headers: Object.fromEntries([...res.headers].slice(0, 25)),
              body: text.length > 64_000 ? text.slice(0, 64_000) + "…[truncated]" : text,
            };
          } finally {
            clearTimeout(timer);
          }
        },
      },
    },
  };
}
