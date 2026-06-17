# 07 · Slug Routing & Auth

> "Enter a URL and a slug, and it goes to exactly yours — if you're logged in."

This is the front door: turning `host/<slug>` into an authenticated connection to a
tenant's Cell, on a Mac Mini behind home NAT, for both you and (eventually) many
tenants.

## Addressing: path vs. subdomain

Two equivalent address forms, both supported:

- **Path form:** `sandboxos.dev/tobias` — simplest, one cert, great for early days.
- **Subdomain form:** `tobias.sandboxos.dev` — cleaner origin isolation (each Sandbox
  its own browser origin → stronger cookie/storage separation), better for the
  multi-tenant product and for serving Sandbox-hosted web apps safely.

We start with **path form** and add **wildcard subdomains** for the product. Wildcard
TLS + custom tenant domains (`tobias.com → their Sandbox`) come via **Cloudflare for
SaaS** — the same mechanism publisher-palace already uses. The Gateway treats both
forms as "resolve a slug."

## The resolution pipeline

```
GET sandboxos.dev/tobias
      │
      ▼
┌──────────────────── GATEWAY ────────────────────┐
│ 1. Terminate TLS (via Cloudflare Tunnel)          │
│ 2. Parse slug  (path segment or subdomain)        │
│ 3. AuthN: validate session / machine token        │
│ 4. AuthZ: is this caller allowed on this slug?    │
│ 5. Look up slug → Sandbox → Cell in the Registry  │
│ 6. If Cell cold → Scheduler.wake() (warm pool)    │
│ 7. Proxy (HTTP/WS/Tide) into the Cell's Kernel    │
└──────────────────────────────────────────────────┘
```

Every step is at the **control plane**. The tenant's data is only ever reached through
the Kernel in step 7 — the Gateway routes and authenticates; it does not read Sandbox
data.

## Reaching a home Mac Mini from everywhere

The host sits behind home NAT with no public IP and no open inbound ports. Public
reachability is provided by a **Cloudflare Tunnel** (`cloudflared`) that the host dials
out to establish — the same pattern ServerHoster uses (login-tunnel re-runs on boot).
Cloudflare terminates public TLS and forwards to the Gateway over the tunnel.
Consequences:

- **No ports opened** on the home router; nothing inbound to attack directly.
- **Wildcard + custom domains** via Cloudflare for SaaS, so `*.sandboxos.dev` and
  tenant vanity domains "just work."
- **DDoS/edge protection** for free at Cloudflare's edge.
- If the tunnel drops, the host re-establishes on boot/health-check; the Gateway is
  otherwise unreachable, which is a *safe* failure mode.

## Authentication

Two principal types, one capability model behind them:

- **Humans** → interactive login (email/passkey/OAuth) → a **session** (httpOnly,
  secure cookie; per-origin in subdomain form). Sessions carry the tenant identity and
  resolve to a capability set.
- **Machines** → **machine tokens** (Bearer), minted by `sbx login` or issued to the
  Tide daemon, CI, or external agents. Capability-scoped, revocable, expiring. This is
  the same Bearer-token muscle FM-ECOM/ServerHoster already use.

Both reduce to: *a principal with a capability set.* The Kernel doesn't care whether a
call came from a browser session or a machine token — only what capabilities it carries.

## Authorization: who may open *this* slug

Slug access is itself a capability. The Registry holds, per Sandbox, the grant table:
which principals (the owner, invited collaborators, specific agents, specific machine
tokens) may attach, and with what rights. Default: only the owner. Sharing a Sandbox is
granting a capability to another principal — visible, scoped, revocable, audited.

This is what makes "goes to exactly *yours*" true: an unauthenticated or unauthorized
request to `sandboxos.dev/tobias` never reaches the Cell — it's denied at the Gateway.

## Multitenancy from day one (even with one tenant)

Per the kickoff decision, this is a personal OS **and** a multi-tenant product from the
start. So even while you are the only tenant, the design is multi-tenant-correct:

- **Tenant is a first-class entity** in the Registry; every Sandbox, slug, token, and
  grant hangs off a tenant.
- **Isolation is per-Cell**, never per-app-logic — there is no "shared mode" that would
  have to be retrofitted into isolation later.
- **Quotas & billing** entities exist in the schema from v0 (dormant for you, live for
  others) — no migration to "become" multi-tenant.
- **Origin isolation** (subdomain form) is available the moment untrusted tenants
  arrive, without re-architecting routing.

The single-tenant phase is just the multi-tenant system with one row in the tenant
table — never a different codebase.

## Slug rules

- Globally unique, DNS-safe, reserved-word-protected (`api`, `www`, `admin`, …).
- A tenant may own **many** slugs (many Sandboxes). A slug maps to exactly one Sandbox.
- Slugs are renamable (with redirect) and transferable between tenants (audited).
- Sandbox-hosted web apps get a stable sub-path/sub-subdomain under the slug so a
  Sandbox can *serve* things, not just *be* a console.

## Why this is low-risk to build

Every piece here — Cloudflare Tunnel, for-SaaS wildcard domains, Bearer/machine-token
auth, a SQLite-backed control plane resolving a slug to a per-project runtime — is
already running in your ServerHoster and publisher-palace projects. The Gateway is, in
effect, ServerHoster's router generalized to "resolve a slug → wake a Cell → proxy MCP."
We are standing on proven ground, not prototyping infrastructure.
