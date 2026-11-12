// What a Braiwser session may reach, decided per request.
//
// The browser runs on the Gateway's host, so "anything the host can reach" would
// include the Gateway itself, other tenants' Cells and the cloud metadata address.
// Every request the page makes is therefore classified before it leaves:
//
//   port    — localhost / 127.0.0.1 / ::1 on any port means *your machine's* port:
//             it is routed into your Cell, and only if you hold ports.access and
//             the port is exposed. The same rule the /p/<port> preview follows.
//   public  — a public host, checked against the Sandbox's net egress policy and
//             resolved: a name that resolves to a private address is refused.
//   blocked — everything else that names a private, link-local or internal place.
//
// The same egress policy and SSRF guard the `net.fetch` tool uses, so an agent and a
// person at the Browser have one definition of "outside".

import net from "node:net";
import { isBlockedAddress, normalizeHost, egressAllowed, resolveAndGuard } from "../../kernel/src/servers/net.js";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export function classify(raw) {
  let u;
  try { u = new URL(raw); } catch { return { kind: "blocked", reason: "That is not a valid address." }; }
  const scheme = u.protocol;
  if (!["http:", "https:", "ws:", "wss:"].includes(scheme)) return { kind: "other", scheme };
  const host = normalizeHost(u.hostname);
  const secure = scheme === "https:" || scheme === "wss:";
  if (LOOPBACK_NAMES.has(host) || host.endsWith(".localhost") || /^127\./.test(host)) {
    const port = Number(u.port || (secure ? 443 : 80));
    return { kind: "port", port, secure, host };
  }
  if (net.isIP(host)) {
    return isBlockedAddress(host)
      ? { kind: "blocked", host, reason: `${host} is a private address. Your own machine's ports are at http://localhost:<port>.` }
      : { kind: "public", host };
  }
  if (!host.includes(".") || /\.(local|internal|lan|home\.arpa|intranet|corp)$/.test(host)) {
    return { kind: "blocked", host, reason: `${host} is not a public name.` };
  }
  return { kind: "public", host };
}

/** Throws with a sentence a person can read when a public host may not be reached. */
export async function guardPublic(policy, host, cache = defaultCache) {
  const p = policy ?? { egress: "allow" };
  if (!egressAllowed(p, host)) throw new Error(`${host} is not allowed by this machine's network policy.`);
  const hit = cache.get(host);
  if (hit && hit.until > Date.now()) { if (hit.error) throw new Error(hit.error); return; }
  try {
    await resolveAndGuard(p, host);
    cache.set(host, { until: Date.now() + 60_000 });
  } catch (e) {
    const error = /private|loopback/.test(e.message)
      ? `${host} points at a private address, which this browser does not open.`
      : `Could not find ${host}.`;
    cache.set(host, { until: Date.now() + 15_000, error });
    throw new Error(error);
  }
}
const defaultCache = new Map();

/**
 * What a person typed into the address bar, as somewhere to go: a URL, a bare
 * domain, a local port, or else a search. Mirrors Braiwser's own address bar.
 */
export function normalizeAddress(input, searchUrl = "https://duckduckgo.com/?q=") {
  const text = String(input ?? "").trim();
  if (!text) return "about:blank";
  if (/^about:blank$/i.test(text)) return "about:blank";
  if (/^https?:\/\//i.test(text)) return text;
  if (/^:\d{1,5}(\/.*)?$/.test(text)) return `http://localhost${text}`;
  if (/^\d{2,5}$/.test(text) && Number(text) > 0 && Number(text) < 65536) return `http://localhost:${text}/`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/.*)?$/i.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /^[^/?#]+\.[a-z][a-z0-9-]*(:\d{1,5})?([/?#].*)?$/i.test(text)) return `https://${text}`;
  return searchUrl + encodeURIComponent(text);
}

/** The page shown in place of a navigation the policy refused. */
export function blockedPage(url, reason) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  return `<!doctype html><meta charset="utf-8"><title>Not opened</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1d2330}
main{max-width:520px;padding:32px}h1{font-size:20px;margin:0 0 8px}code{background:#e8ebf0;padding:2px 6px;border-radius:4px;word-break:break-all}p{color:#4a5263}</style>
<main><h1>Braiwser did not open this page</h1><p>${esc(reason)}</p><p><code>${esc(url)}</code></p></main>`;
}
