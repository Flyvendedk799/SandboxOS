# Phase 15 — MicroVM Backend

Phase 15 hardens the Cell execution layer with a four-tier backend stack (firecracker > hardened-docker > docker > local), wires resource limits (mem_mb, cpu_shares) from per-tenant quota all the way into Cell startup, and scaffolds the Linux-only Firecracker microVM backend.

## What was built

### 1. `HardenedDockerBackend` — L1 container defense-in-depth

**`packages/cell/src/hardened-docker-backend.js`** — the new default Docker backend:

| Defence layer | Flag |
|---|---|
| Drop all Linux capabilities | `--cap-drop=ALL` |
| Add back only the minimum 12 | `--cap-add=CHOWN` … `--cap-add=SETFCAP` |
| No privilege escalation | `--security-opt=no-new-privileges` |
| Isolated network namespace | `--network=none` |
| Process count cap | `--pids-limit=256` |
| Memory limit (from quota) | `--memory=${memMb}m` |
| No swap | `--memory-swap=${memMb}m` (== memory) |
| CPU quota (from quota) | `--cpus=${cpuShares}` |

Capabilities explicitly absent from the re-add list: `NET_RAW`, `NET_ADMIN`, `SYS_ADMIN`, `SYS_PTRACE`, `SYS_MODULE`, `SYS_BOOT`, `SYS_RAWIO`, `DAC_READ_SEARCH`.

The `_buildRunArgs()` method is extracted so security configuration can be unit-tested without a running Docker daemon.

### 2. `FirecrackerBackend` — L2 microVM scaffold

**`packages/cell/src/firecracker-backend.js`** — hardware-isolated microVM backend (Linux/KVM only):

- **HTTP API client** — `_api(method, path, body)` communicates via Unix socket (`/tmp/sandboxos-fc-${id}.sock`) using Node's built-in `http` module.
- **Pure config builders** (testable without a binary):
  - `_bootSourceConfig()` — kernel path + boot args
  - `_machineConfig()` — vcpu_count + mem_size_mib
  - `_driveConfig()` — overlay qcow2 rootfs as root device
  - `_networkConfig(tap)` — TAP interface + guest MAC
- **Overlay rootfs** — per-sandbox copy-on-write qcow2 via `qemu-img create -b $FC_ROOTFS`.
- **SSH-based exec** — `exec()`, `execStream()`, `execInteractive()` all talk to the guest via SSH using a shared host keypair (`~/.sandboxos/cell-key`).
- **Real PTY** via `ssh -t -t` in `execInteractive()` — this resolves the PTY resize issue deferred from Phase 10. Host-side `resize()` is a no-op stub until node-pty is wired (Phase 16).
- **VM snapshot on stop** — `stop()` calls `PUT /snapshot/create` (Diff type) before killing the Firecracker process, enabling fast resume on next wake.
- **Graceful macOS rejection** — `ensureRunning()` throws `"requires Linux"` on non-Linux hosts rather than failing cryptically.

### 3. Four-tier `cell.js` with backend resolution

**`packages/cell/src/cell.js`** — unified factory:

```
auto resolution order:
  1. firecracker    — Linux + /dev/kvm + firecracker binary in PATH
  2. hardened-docker — docker daemon available
  3. local          — fallback (tests / CI / no-docker)
```

`SANDBOXOS_CELL_BACKEND` / `config.cellBackend` overrides the auto detection.

`getCell(sandbox, { memMb, cpuShares })` now accepts resource parameters, which are passed to the backend constructor and applied at container/VM creation time. Results are cached per sandbox ID so the resource config is fixed at first wake (subsequent wakes hit the cache).

### 4. Resource quota columns (`mem_mb`, `cpu_shares`)

**`packages/control-db/src/db.js`** — two new Phase-15 migrations:

```sql
ALTER TABLE tenant_quotas ADD COLUMN mem_mb     INTEGER NOT NULL DEFAULT 512
ALTER TABLE tenant_quotas ADD COLUMN cpu_shares REAL    NOT NULL DEFAULT 1.0
```

**`packages/control-db/src/registry.js`** — `getQuota` and `setQuota` extended:

```js
getQuota(tenantId)
// → { tenant_id, max_sandboxes, max_agents, max_running, mem_mb, cpu_shares }

setQuota(tenantId, { maxSandboxes?, maxAgents?, maxRunning?, memMb?, cpuShares? })
// Partial upsert — omitted keys preserve current value.
```

### 5. Quota → Scheduler → Cell pipeline

**`packages/scheduler/src/scheduler.js`** — `wake(sandbox, quota = {}, now)`:
- Accepts optional quota object from the gateway.
- Extracts `{ mem_mb, cpu_shares }` and passes them to `getCell()`.
- All existing wake calls that pass only `now` as the second arg are unaffected (quota defaults to `{}`).

**`apps/gateway/src/server.js`** — three `scheduler.wake()` call sites updated to pass `getQuota(principal.tenant_id)`:
- `GET /:slug` (background wake on desktop load)
- `POST /:slug/wake` (explicit wake)
- WebSocket PTY upgrade handler

**`POST /api/quota`** now accepts `memMb` and `cpuShares` fields.

### 6. `sbx quota` CLI additions

```
sbx quota                                          # get (now shows mem_mb, cpu_shares)
sbx quota set --mem-mb 1024 --cpu-shares 2.0      # set resource limits
```

### 7. `scripts/setup-microvm.sh` — Linux host bootstrap

Idempotent setup script (run once as root on a Linux host):
- Grants `/dev/kvm` to group `kvm`; adds `$SANDBOXOS_USER` to the group
- Creates host bridge `br0` at `172.20.0.1/24`
- Creates TAP pool `tap0..tap7`, attached to `br0`
- Adds iptables MASQUERADE rule for the guest subnet
- Writes systemd-networkd drop-ins for persistence across reboots

## Test coverage — `test/phase15.test.js` (17 tests)

| Section | Tests |
|---|---|
| `HardenedDockerBackend._buildRunArgs()` security flags | 4 |
| Resource limits from quota | 3 |
| `FirecrackerBackend` config builders | 4 |
| `FirecrackerBackend.ensureRunning()` non-Linux rejection | 1 |
| `mem_mb` / `cpu_shares` DB roundtrip | 3 |
| Resource quota REST | 2 |

Full suite after Phase 15: **300 tests, 0 failures**.

## What's deferred to Phase 16+

- **Real PTY resize** — `ssh -t -t` gives a PTY but `resize()` is a no-op; needs `node-pty` (native module) or sending an escape-code resize sequence to the SSH session.
- **TAP allocation management** — `FirecrackerBackend` currently derives the TAP name from the last 6 chars of the sandbox ID; a proper TAP pool allocator ensures no two VMs share a TAP and reclaims on destroy.
- **Firecracker snapshot restore** — `_doEnsure()` creates a cold VM every time; fast resume from a Diff snapshot is scaffolded in `stop()` but the restore path (`PUT /snapshot/load`) is not yet wired in `_doEnsure()`.
- **`max_running` quota enforcement** — `tenant_quotas.max_running` is stored and returned but the Scheduler's `wake()` budget still uses the constructor `maxRunning` (the global `SANDBOXOS_MAX_RUNNING` env cap). Per-tenant running-cell budgets need the Scheduler to accept a dynamic max.
- **Cell image CI pipeline** — the base rootfs image (`FC_ROOTFS`) and Docker cell image (`config.cellImage`) are assumed to exist; building and publishing them is a separate ops concern.
- **billing / metering** — compute-hours per tenant based on Cell running time.
