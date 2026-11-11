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
  const p = normalizeHost(pattern);
  const h = String(host).toLowerCase();
  if (p === h) return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix);
  }
  return false;
}

/** The host as policy and DNS should both see it: no IPv6 brackets, no root dot.
 *  `[::1]` and `::1`, `evil.com.` and `evil.com`, are one host each — a deny
 *  entry that matched only one spelling was a deny entry that did not hold. */
export function normalizeHost(host) {
  let h = String(host ?? "").toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.length > 1 && h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

export function egressAllowed(policy, rawHost) {
  const host = normalizeHost(rawHost);
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

// Returns true if `ip` (a literal IPv4/IPv6 string, with or without brackets) is in a
// range an untrusted Sandbox must never reach: loopback, link-local, unique-local,
// multicast, CGNAT, RFC1918, or documentation/reserved.
export function isBlockedAddress(ip) {
  const clean = typeof ip === "string" && ip.startsWith("[") && ip.endsWith("]")
    ? ip.slice(1, -1)
    : String(ip);
  const kind = net.isIP(clean);
  if (kind === 4) return isBlockedV4(clean);
  if (kind === 6) return isBlockedV6(clean);
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
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;     // 100.64.0.0/10 CGNAT RFC 6598
  if (o[0] >= 224 && o[0] <= 239) return true;                    // 224.0.0.0/4 multicast
  if (o[0] >= 240) return true;                                   // 240.0.0.0/4 reserved / broadcast
  if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true;       // 192.0.0.0/24 IETF protocol assignments
  if (o[0] === 192 && o[1] === 0 && o[2] === 2) return true;       // 192.0.2.0/24 TEST-NET-1
  if (o[0] === 198 && o[1] === 51 && o[2] === 100) return true;    // 198.51.100.0/24 TEST-NET-2
  if (o[0] === 203 && o[1] === 0 && o[2] === 113) return true;    // 203.0.113.0/24 TEST-NET-3
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true; // 198.18.0.0/15 benchmarking
  return false;
}

function parseIPv6Words(ip) {
  let s = ip.toLowerCase().split("%")[0];
  const v4Match = s.match(/(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const octets = v4Match[2].split(".").map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${v4Match[1]}${hi}:${lo}`;
  }
  const doubleColon = s.indexOf("::");
  let left = [];
  let right = [];
  if (doubleColon !== -1) {
    if (s.indexOf("::", doubleColon + 1) !== -1) return null;
    const leftPart = s.slice(0, doubleColon);
    const rightPart = s.slice(doubleColon + 2);
    if (leftPart) left = leftPart.split(":").map((h) => parseInt(h, 16));
    if (rightPart) right = rightPart.split(":").map((h) => parseInt(h, 16));
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    const words = [...left, ...Array(missing).fill(0), ...right];
    if (words.some((w) => Number.isNaN(w) || w < 0 || w > 0xffff)) return null;
    return words;
  } else {
    const words = s.split(":").map((h) => parseInt(h, 16));
    if (words.length !== 8 || words.some((w) => Number.isNaN(w) || w < 0 || w > 0xffff)) return null;
    return words;
  }
}

function isBlockedV6(ip) {
  const words = parseIPv6Words(ip);
  if (!words) return true; // invalid -> fail closed
  if (words.every((w) => w === 0)) return true; // :: unspecified
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true; // ::1 loopback
  if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((words[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return true; // 100::/64 discard
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if ((words[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated, still routed)
  if (words[0] === 0x2001 && words[1] === 0) return true; // 2001::/32 Teredo — tunnels to an arbitrary v4
  if (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  // IPv4-translated (::ffff:0:a.b.c.d, RFC 2765)
  if (words.slice(0, 4).every((w) => w === 0) && words[4] === 0xffff && words[5] === 0) {
    const v4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`;
    return isBlockedV4(v4);
  }
  // 6to4 prefix (2002::/16)
  if (words[0] === 0x2002) {
    const v4 = `${(words[1] >> 8) & 0xff}.${words[1] & 0xff}.${(words[2] >> 8) & 0xff}.${words[2] & 0xff}`;
    return isBlockedV4(v4);
  }
  // NAT64 prefix (64:ff9b::/96)
  if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    const v4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`;
    return isBlockedV4(v4);
  }
  // IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::0:0/96)
  if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) {
    const v4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`;
    return isBlockedV4(v4);
  }
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
export async function resolveAndGuard(policy, rawHost) {
  const host = normalizeHost(rawHost);
  const cleanHost = host;
  const literal = net.isIP(cleanHost);
  if (literal) {
    if (isBlockedAddress(cleanHost) && !explicitlyAllowed(policy, cleanHost)) {
      throw new Error(`egress blocked: ${host} resolves to a private/loopback address`);
    }
    return { ip: cleanHost, family: literal };
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

const MAX_REDIRECTS = 5;
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
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error(`unsupported url scheme: ${parsed.protocol}`);
          }

          if (sandboxId) checkRateLimit(sandboxId, rateConfig);

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), a.timeoutMs ?? 15_000);
          let method = a.method ?? "GET";
          let body = a.body;
          try {
            // Redirects are followed here, one hop at a time, rather than by
            // fetch: every hop is a new destination, and a guard that checked
            // only the first let a public host answer 302 → 169.254.169.254.
            for (let hop = 0; ; hop++) {
              const host = parsed.hostname;
              if (!egressAllowed(policy, host)) throw new Error(`egress denied by policy: ${normalizeHost(host)}`);

              // SSRF guard (backlog #6): resolve the host and reject private/loopback/
              // link-local/unique-local targets, then pin the validated IP for the
              // actual request so it cannot be DNS-rebound to a private address.
              const { ip, family } = await resolveAndGuard(policy, host);
              const pinnedUrl = buildPinnedUrl(parsed, ip, family);
              // Preserve the original Host header so name-based vhosts/TLS SNI still work.
              const headers = { ...(a.headers ?? {}), Host: parsed.host };

              const res = await fetch(pinnedUrl, {
                method, headers, body, signal: controller.signal, redirect: "manual",
              });
              const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
              if (location) {
                if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
                await res.body?.cancel().catch(() => {});
                // Relative to the URL that was asked for, not the pinned one.
                let next;
                try { next = new URL(location, parsed); }
                catch { throw new Error(`invalid redirect location: ${location}`); }
                if (next.protocol !== "http:" && next.protocol !== "https:") {
                  throw new Error(`unsupported redirect scheme: ${next.protocol}`);
                }
                // What a browser does: 303 always, and 301/302 for a POST, become a GET.
                if (res.status === 303 || ((res.status === 301 || res.status === 302) && method.toUpperCase() === "POST")) {
                  method = "GET";
                  body = undefined;
                }
                parsed = next;
                continue;
              }
              const text = await res.text();
              return {
                status: res.status,
                ok: res.ok,
                headers: Object.fromEntries([...res.headers].slice(0, 25)),
                body: text.length > 64_000 ? text.slice(0, 64_000) + "…[truncated]" : text,
              };
            }
          } finally {
            clearTimeout(timer);
          }
        },
      },
    },
  };
}
