# Phase 19 — Remaining Deferred Hardening (#11, #13, #14)

Phase 19 closes the last three items deferred from the Phase 17 audit backlog.

## #11 — Per-tenant secret key derivation + rotation (MEDIUM)
Previously every tenant's secrets were sealed under the **single shared master key**, so
a leak of that key (or of one tenant's plaintext) exposed everyone. Now each secret is
encrypted under a key **derived from the master key AND the owning tenant** via
HKDF-SHA256:

```
key = HKDF-SHA256(master, salt="sandboxos/secret-key/v1", info="tenant:<tenantId>")
```

- **`packages/secrets/src/store.js`** — `tenantKey(tenantId)` derivation; `encrypt`/
  `decrypt` are tenant-scoped (the store resolves a sandbox's tenant internally, so the
  secrets server is unchanged). The master key no longer directly encrypts any new secret.
- **`secrets.key_version`** column (additive migration): `0` = legacy master-key rows,
  `1` = per-tenant HKDF. Legacy rows still decrypt (backward compatible).
- **`upgradeSecretsToPerTenant()`** — idempotent rotation that re-seals all legacy rows
  under their tenant key; safe to run on boot. Returns the count upgraded.

**Isolation now holds:** a tenant's ciphertext fails GCM authentication under any other
tenant's derived key (tested by planting tenant A's exact ciphertext under tenant B).

## #13 — Host-global agent concurrency ceiling (LOW)
The per-sandbox `max_agents` quota didn't bound the host as a whole, so one tenant's agent
fleet could starve co-tenants on the shared Mac Mini. Added a **host-wide** ceiling at the
single spawn chokepoint (`agents.spawn`):

- **`runningAgentCountGlobal()`** (registry) counts queued+running agents across all sandboxes.
- **`agents/server.js`** rejects a spawn when `runningAgentCountGlobal() >= SANDBOXOS_MAX_AGENTS_GLOBAL`
  (default 100), independent of and in addition to the per-sandbox cap.

## #14 — better-sqlite3 as the production driver (LOW)
The correctness half of #14 (schema_version table, hardened migrations, `withTransaction`)
already shipped in Phase 17 on `node:sqlite`. The remaining piece — the documented
production driver better-sqlite3 v11 (docs/11) — is done **without regressing the zero-
dependency default**, by making the driver selectable behind the existing `openDb()` seam:

- **`SANDBOXOS_DB_DRIVER`** = `node` (default — `node:sqlite`, zero runtime deps) |
  `better-sqlite3` | `auto` (use better-sqlite3 if installed, else fall back).
- better-sqlite3 is an **optionalDependency** (a host without a build toolchain still
  installs; runtime defaults to node:sqlite). Its API is a strict superset of the subset
  we use (`exec` / `prepare`→`run·get·all` / `close`), so no registry code changed.
- **Verified end-to-end:** the full suite passes under **both** drivers (344/344 each).
  `npm run test:better-sqlite3` runs the suite against better-sqlite3.

## Tests
- **`test/phase19.test.js`** (5): per-tenant round-trip + `key_version=1`; cross-tenant
  ciphertext isolation; legacy decrypt + rotation upgrade; host-global ceiling blocks and
  (under headroom) allows spawn.
- **#14 driver parity** is proven by running the entire suite under `SANDBOXOS_DB_DRIVER=better-sqlite3`.

Full suite after Phase 19: **344 tests, 0 failures** (under each driver).

## Remaining (genuinely out of scope here — need external infrastructure)
Multi-host scheduler, federation, billing/metering, running `npm install` itself inside
the Cell, and a real external security review. None are buildable in-process today.
