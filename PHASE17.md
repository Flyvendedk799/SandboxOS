# Phase 17 — Security & Correctness Hardening

Phase 17 is a security-hardening wave driven by a multi-agent audit of the whole
codebase against its grand-plan docs. The audit mapped all 9 subsystems, ran 8
dimension reviewers (security, correctness, architecture, drift, tests, lifecycle,
hardening, ergonomics), adversarially verified every finding, and synthesized a
ranked backlog. This phase implements the verified findings.

**Root cause the audit surfaced:** the authorization model was strong at the
kernel/capability layer (default-deny, attenuating delegation, on-behalf-of audit)
but had **no operator/admin authority tier**, so two endpoints collapsed multi-tenant
isolation, and credential/secret material was under-protected at rest.

## What was implemented

### #1 — Operator authority tier (CRITICAL)
- `principals.is_operator` column (additive migration). New registry accessors
  `isOperator(principalId)` / `setOperator(principalId, bool)`. The seed owner is
  marked operator in `ensureSeed`; **self-service signups never are**, and operator
  authority is **not delegable** via machine tokens.
- Gateway `requireOperator(principal)` helper now gates the two host-wide holes:
  - `GET /api/admin/backup` (streamed the entire control DB to any logged-in user) → **operator-only**.
  - `POST /api/quota` with an attacker-supplied `tenantId` (cross-tenant quota IDOR — e.g. setting a victim's `max_running` to 0) → cross-tenant writes are **operator-only**; non-operators may only write their own tenant.

### #2 — Bearer tokens hashed at rest (CRITICAL)
- `sessions.token` PK now stores `sha256(token)`; the raw token is returned to the
  caller once and never persisted. A leaked DB no longer yields replayable session/
  machine tokens. Added `purgeExpiredSessions()`, called hourly from the gateway boot loop.

### #3 — fs path-escape guard now resolves symlinks (HIGH)
- `fs.js` canonicalizes via `realpath` and asserts containment within the canonical
  volume root for read/list/stat; for write/mkdir it realpaths the parent and opens
  the leaf with `O_NOFOLLOW`. An in-volume symlink pointing outside the volume
  (plantable via `proc.exec ln -s /etc escape`) is now rejected with `path escapes sandbox`.

### #4 — Audit log truly append-only and verified (HIGH)
- `deleteSandbox` no longer `DELETE`s audit rows (which severed the global hash
  chain). Added `verifyAuditChain()` → `{ ok, count, brokenAtId }`, run on gateway
  boot (logs loudly on a break).

### #5 — Deep, value-aware audit redaction (HIGH)
- `redact()` now recurses (depth + node caps, cycle-guarded), expands the sensitive
  key set (`value`, `payload`, `body`, `data`, `env`, `cmd`, `password`, …), and
  scrubs by value shape (`Bearer …`, `sk-…`, JWTs, long base64/hex blobs). Closes the
  canonical leaks: `secrets.put` (secret under `value`) and `net.fetch` (`Authorization` header).

### #6 — net.fetch SSRF guard (HIGH)
- After the egress-policy check, the host is resolved and the request is rejected if
  any address is loopback / link-local / unique-local / RFC1918 (blocks
  `127.0.0.1:<port>/api/admin/backup`, cloud metadata `169.254.169.254`, LAN), unless
  an operator explicitly allow-listed it. The validated IP is **pinned** for the
  request to defeat DNS rebinding. New exports `isBlockedAddress`, `resolveAndGuard`.

### #7 — Unisolated 'local' backend fails safe (HIGH)
- `LocalBackend` no longer inherits the full host `process.env` (only `PATH` + a
  minimal set + caller env), so host secrets don't leak into sandboxed commands.
- `SANDBOXOS_REQUIRE_ISOLATION=1` makes the gateway refuse to create a Cell on the
  local backend (503). `/health` now reports `cellBackend` and `isolationEnforced`.

### #8 — Least-privilege console agent spawn (MEDIUM)
- `agent spawn` no longer hardcodes `['fs.*','proc.exec']`; it defaults to the
  minimum (`['proc.exec']`) and accepts an explicit `--patterns=a.b,c.*` opt-in
  (still attenuated against the spawner). Granted patterns are surfaced in the result.

### #9 — Transactional sandbox deletion + orphan cleanup (MEDIUM)
- `deleteSandbox` runs in a single `withTransaction`, and also removes the machine
  principals minted for the sandbox plus their sessions (only when not shared across
  sandboxes), eliminating orphaned credential rows.

### #10 — Strong password hashing + auth rate limiting (MEDIUM)
- Account passwords use `scrypt` with a self-describing `scrypt$N$r$p$salt$hash`
  format (upgradeable), compared with `timingSafeEqual`; legacy PBKDF2 hashes still
  verify for backward compatibility. `/login` and `/signup` are per-IP rate-limited
  (`SANDBOXOS_AUTH_RATE`, default 10/60s) → 429 on abuse.

### #11 — Master key custody (MEDIUM, partial)
- `master.key` is written/repaired to `0600` and relocatable via
  `SANDBOXOS_MASTER_KEY_PATH`. **Deferred:** per-tenant key derivation (HKDF) +
  rotation (needs a cross-file re-encryption migration).

### #12 — Marketplace install hardening (MEDIUM, interim)
- `mcp-registry.install` enforces a source allowlist (`SANDBOXOS_MCP_ALLOWLIST`,
  default `npm:`/`file:` incl. bare local paths) and records provenance
  (`source`, `resolvedPath`, sha256 `hash`, `installedAt`) in the manifest.
  **Deferred:** out-of-process hosting of untrusted servers (the proper Phase-1 fix;
  install still does an in-process `import()` of third-party code).

### #13 — Resource enforcement (LOW, partial)
- Plain `DockerBackend` now honors the tenant quota (`memMb`/`cpuShares` in the run
  args, wired through `cell.js`). AI agents have a wall-clock + token budget
  (`SANDBOXOS_AGENT_MAX_MS` / `SANDBOXOS_AGENT_MAX_TOKENS`) and finalize cleanly when
  exhausted. **Deferred:** a host-global concurrent-agent ceiling.

### #14 — Migration hardening (LOW, partial)
- `runMigrations` distinguishes benign "column/table already exists" from genuine
  failures (which now surface). Added a `schema_version` table and a `withTransaction`
  helper. **Deferred (intentional):** the better-sqlite3 driver swap — keeping
  node:sqlite preserves the zero-runtime-dependency control-plane goal (docs/11).

## How it was built
- **Audit:** 1 workflow — 9 subsystem mappers → 8 dimension reviewers → adversarial
  verification of all findings → synthesized ranked backlog (54 findings verified).
- **Implementation Wave 1:** 7 implementers on strictly disjoint files (data layer,
  fs, net, mcp-registry, agents, cell, secrets-store).
- **Wave 2 (gateway):** operator gating, quota IDOR fix, auth rate limiting,
  isolation enforcement, boot-time audit verification + session purge.
- **Wave 3:** `test/phase17.test.js` security regression suite + doc.

## Deferred to a future phase (genuinely larger / cross-cutting)
- Per-tenant secret key derivation + rotation (#11).
- Out-of-process hosting of untrusted marketplace servers (#12) — the real isolation fix.
- Host-global agent concurrency ceiling (#13).
- better-sqlite3 v11 driver swap (#14) — only if the zero-dep tradeoff is revisited.
- Multi-host scheduler, federation, billing/metering — require external infrastructure.
