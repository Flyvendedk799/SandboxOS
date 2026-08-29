# 14 · Surface Map

> Docs 00–13 describe the design. This one describes **what exists**: every HTTP route,
> every MCP tool, every console verb and every CLI command that is implemented today.
> When the two disagree, this file is wrong and should be fixed — the tests are the
> arbiter.

Everything below is reached through the Gateway, and every MCP call goes through the
Kernel's `authenticate → authorize → route → execute → audit` path. There is no side
channel.

---

## 1 · HTTP routes

### Public

| method | route | |
|---|---|---|
| `GET` | `/` | login page, or a redirect to your primary slug |
| `POST` | `/login` | `{username, password}` or the legacy `{password}` |
| `POST` | `/signup` | `{username, password}` → new tenant + Sandbox |
| `POST` | `/logout` | |
| `GET` | `/health` | uptime, Sandbox count, Cell backend, isolation posture |
| `GET` | `/static/*` | the desktop's assets |

### Tenant API

| method | route | |
|---|---|---|
| `GET` | `/api/me` | authenticated? which slug? |
| `GET/POST` | `/api/profile` | account, AI provider, onboarding state |
| `GET/DELETE` | `/api/claude-code` | is a Claude subscription connected for this tenant; disconnect |
| `POST` | `/api/claude-code/login` | begin the PKCE login — returns the URL to approve at |
| `POST` | `/api/claude-code/login/complete` | finish it with the pasted `code#state` |
| `GET/POST` | `/api/quota` | resource limits (cross-tenant writes need operator authority) |
| `GET` | `/api/stats` | tenant-wide Sandbox and agent counts |
| `GET/POST` | `/api/sandboxes` | list, create (optionally from a distro) |
| `DELETE` | `/api/sandboxes/:slug` | destroy a Sandbox |
| `POST` | `/api/sandboxes/:slug/snapshot` | capture its manifest as a distro |
| `GET/POST` | `/api/distros` | list, create |
| `DELETE` | `/api/distros/:name` | |

### Operator-only

| method | route | |
|---|---|---|
| `GET` | `/api/admin/backup` | stream the control DB |
| `GET` | `/api/admin/audit/verify` | walk the hash chain host-wide |

### Per-Sandbox

All require a grant on that Sandbox.

| method | route | |
|---|---|---|
| `GET` | `/:slug` | the desktop (wakes the Cell) |
| `POST` | `/:slug/exec` | one Command Central line |
| `POST` | `/:slug/exec-stream` | the same, streamed over SSE |
| `POST` | `/:slug/stream` | run a raw command, streaming stdout/stderr |
| `POST` | `/:slug/mcp` | one raw MCP call |
| `GET` | `/:slug/events` | SSE tail of the audit log |
| `GET` | `/:slug/audit` | query the log (`server`, `tool`, `kind`, `after`, `cursor`, `limit`) |
| `GET` | `/:slug/audit/export` | `?format=json\|csv`, same filters |
| `POST` | `/:slug/wake` · `/:slug/hibernate` | Cell power |
| `POST` | `/:slug/tokens` | mint an attenuated machine token |
| `GET` | `/:slug/tokens` | list them |
| `DELETE` | `/:slug/tokens/:principalId` | revoke one, credential included |
| `GET/POST` | `/:slug/access` | who can reach this machine · share with an account |
| `DELETE` | `/:slug/access/:principalId` | revoke |
| `GET/PUT` | `/:slug/file?path=…` | stream a file out (`&download=1`) or in |
| `ANY` | `/:slug/p/:port/*` | reverse-proxy into a service inside the Cell |
| `GET` | `/:slug/agents` · `/:slug/agents/:id` | list · detail |
| `DELETE` | `/:slug/agents/:id` | kill |
| `GET` | `/:slug/agents/:id/events` | SSE tail of one agent's calls |
| `GET/POST` | `/:slug/secrets` | list · store |
| `DELETE` | `/:slug/secrets/:name` | |
| `POST` | `/:slug/secrets/:name/use` | run a command with it injected as env |
| `GET` | `/:slug/apps` | installed apps |
| `POST` | `/:slug/propose` | translate natural language without running it |
| `GET/POST` | `/:slug/chats` | assistant conversations |
| `GET/PATCH/DELETE` | `/:slug/chats/:id` | transcript · rename · delete |
| `POST` | `/:slug/chats/:id/send` | run one assistant turn, streamed |
| `WS` | `/:slug/pty` | interactive shell |
| `WS` | `/:slug/p/:port/*` | upgrade proxied into the Cell (HMR) |

### The port proxy

`/:slug/p/:port/…` requires a `ports.access` capability **and** a port that
`ports.expose` has declared. It redirects a bare `/p/3000` to `/p/3000/`, injects
`<base href="…">` into HTML so root-relative asset URLs stay under the prefix, rewrites
`Location` headers, and tunnels WebSocket upgrades. Which address it dials is the Cell
backend's answer to `endpoint(port)`:

| backend | endpoint |
|---|---|
| `local` | `127.0.0.1` — the Cell shares the host loopback |
| `docker` | the container's network IP |
| `hardened-docker` | *unavailable* — these Cells run `--network=none` |
| `firecracker` | the guest's TAP address |

---

## 2 · MCP tools

Namespaced `server.tool`. A capability pattern is `*`, `server.*`, or `server.tool`.

**`fs`** — `list` `read` `write` `append` `mkdir` `remove` `move` `copy` `stat` `tree`
`search` `readBytes` `writeBytes`
Every path is canonicalized and asserted to stay inside the Cell volume; an in-volume
symlink pointing out is rejected, and the root cannot be deleted.

**`proc`** — `exec` `list` · `start` `logs` `jobs` `stop` `forget` `signal`
`start` supervises a process that outlives the request, with a bounded, line-buffered
log ring. The job table is keyed per Sandbox and survives Kernel rebuilds.

**`ports`** — `expose` `unexpose` `list` `check` `scan`
Exposure lives in the manifest, so it survives hibernate/wake and travels with a distro.

**`net`** — `fetch` (egress-policy gated, rate limited)
**`secrets`** — `put` `list` `remove` `useInEnv` (values are never returned)
**`pkg`** — `install` `remove` `list`
**`cron`** — `at` `every` `list` `cancel` (jobs fire as the scheduling principal)
**`agents`** — `spawn` `list` `get` `kill` (kind `shell` or `ai`; capabilities attenuate)
**`llm`** — `complete` `models`
**`metrics`** — `snapshot` `history` `activity` `recent`
**`apps`** — `list` `install` `remove` `launch` (launch mints a scoped token)
**`tide`** — `init` `listWorkspaces` `status` `mark` `log` `diff` `checkout` `refs` ·
`putState` `getState` `listStates` · `fetchObjects` `receiveObjects` (the wire
primitives a laptop daemon drives). Paths returned to callers are Sandbox-relative.
**`mcp-registry`** — `list` `enable` `disable` `configure` `install` `uninstall`
**`kernel`** — `whoami` `capabilities` `tools` `auditQuery` `manifestGet` `manifestSet`

Marketplace servers appear under the name they were installed as. Their code runs
**out of process** with no handle to the control plane; the Kernel registers a proxy, so
authorization and audit are unchanged.

---

## 3 · Command Central verbs

```
files          ls · cat · stat · write · mkdir · rm [-r] · mv · cp · tree · grep
processes      ps · <anything else> runs in the Cell shell
background     run "<cmd>" [name] · jobs · logs <id> [n] · stop <id>
ports          ports · port expose <n> [name] · port close <n> · port scan · port check <n>
secrets        secrets · secret put <name> <value> · secret rm <name>
network        fetch <url>
packages       pkg install|remove|list
servers        servers · enable <name> · disable <name>
agents         agent spawn <name> "<cmd>" [--patterns=a.b,c.*] · agents · agent get|kill <id>
ai             llm "<prompt>"
self           whoami · :capabilities · :audit [n]
raw MCP        :tools · :call <server.tool> {json}
natural lang   ? <what you want>
meta           help · clear
```

---

## 4 · The `sbx` CLI

```
connect     login · token · sandbox <list|create|wake|hibernate|delete>
work        run · call · stream · ask
files       fs <ls|cat|tree|grep|mkdir|rm|get|put>
processes   proc <list|start|logs|stop>
ports       port <list|expose|close|scan>
agents      agent <list|spawn|get|kill>
state       secret · app · distro
observe     metrics · audit · watch
admin       access <list|share|revoke> · quota · backup
```

Config lives at `~/.sbx/config.json` (`SBX_CONFIG` overrides). Any unrecognized first
word is shorthand for `run`, so `sbx ls` works.

---

## 5 · The client SDK

```js
import { SandboxClient } from "sandboxos/sdk";
const sbx = new SandboxClient({ url, slug, token });
```

`sbx.call(server, tool, args)` is the escape hatch; the rest is sugar over it:
`sbx.fs.*`, `sbx.proc.*` (with `wait()`), `sbx.ports.*` (with `url()`), `sbx.agents.*`
(with `wait()`), `sbx.secrets.*`, and `sbx.assistant.ask()` which yields turn events as
they stream. `sbx.stream()` and `sbx.events()` are async iterators.

Errors are `SandboxError` and carry the Kernel's reason — `denied: proc.exec`, not
`HTTP 200`.

---

## 6 · Configuration

| variable | |
|---|---|
| `SANDBOXOS_HOME` | where the control DB and Cell volumes live |
| `SANDBOXOS_PORT` | Gateway port (default 3939) |
| `SANDBOXOS_PASSWORD` | the legacy single-password login |
| `SANDBOXOS_CELL_BACKEND` | `local` · `docker` · `hardened-docker` · `firecracker` · auto |
| `SANDBOXOS_REQUIRE_ISOLATION` | refuse to serve Cells on the unisolated `local` backend |
| `SANDBOXOS_DOMAIN` | enable `{slug}.{domain}` subdomain routing |
| `SANDBOXOS_MAX_RUNNING` · `_IDLE_MS` | Scheduler concurrency and hibernate delay |
| `SANDBOXOS_MAX_SANDBOXES` · `_MAX_AGENTS` · `_MAX_AGENTS_GLOBAL` | ceilings |
| `SANDBOXOS_AUTH_RATE` | login/signup attempts per IP per minute |
| `SANDBOXOS_ASSISTANT_MAX_STEPS` · `_MAX_MS` · `_MAX_TOKENS` | assistant turn budgets |
| `SANDBOXOS_AGENT_MAX_MS` · `_MAX_TOKENS` | AI agent budgets |
| `SANDBOXOS_DB_DRIVER` | `node:sqlite` (default) or `better-sqlite3` |
| `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` | fallback when no tenant key is stored |
| `SANDBOXOS_HOST_SUBSCRIPTION` | `1` lets the host's own `claude`/`codex` login pay for tenant calls (off by default: on a shared host it bills everyone's work to one plan) |
| `CLAUDE_CREDENTIALS_FILE` · `CODEX_AUTH_FILE` | where those CLI logins live, when not the default paths |
