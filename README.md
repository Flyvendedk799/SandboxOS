# SandboxOS

> An AI-first, web-based, MCP-native operating system. Every user gets an isolated
> machine at a URL slug, controls it from anywhere through **Command Central**, and
> moves data between cloud and local through **Tide** — a versioned, live-syncing
> protocol that is git-like but built for agents.

---

## The one-paragraph pitch

You open `sandboxos.dev/tobias`, log in, and you are *inside your machine* — a real
isolated environment with its own filesystem, processes, and network. You don't drive
it with raw Linux syscalls; you drive it with **MCP**. Every capability of the OS —
files, processes, network, secrets, packages, the scheduler, even the OS's own
configuration — is an MCP server. Agents speak MCP natively, so SandboxOS is the
first operating system whose *system call interface is a tool-calling protocol*. You
command it through **Command Central** (a console reachable from any browser or the
`sbx` CLI), and you keep your laptop and your sandbox in lockstep through **Tide**.

## The four pillars

1. **MCP is the kernel ABI.** Not an add-on — the contract. Everything is an MCP
   server; permissions are which MCP tools a caller may invoke. See
   [`docs/03-mcp-kernel.md`](docs/03-mcp-kernel.md).
2. **A slug is a machine.** `host/<slug>` resolves to *your* isolated Cell, woken on
   demand. See [`docs/07-slug-routing-auth.md`](docs/07-slug-routing-auth.md).
3. **Command Central is remote-first.** One authenticated console — shell verbs,
   raw MCP, or natural language — reachable from everywhere. See
   [`docs/06-command-central.md`](docs/06-command-central.md).
4. **Tide moves everything.** Versioned core (push/pull/diff) + live mirror
   (real-time bidirectional), pick per workspace. See
   [`docs/05-tide-protocol.md`](docs/05-tide-protocol.md).

---

## Run it

Node 22.13 or newer — the 22 LTS line included — and no dependencies to install.
(On Node 22.5–22.12 add `--experimental-sqlite`; `node:sqlite` needs no flag from 22.13 on.)

```bash
git clone https://github.com/Flyvendedk799/SandboxOS && cd SandboxOS
SANDBOXOS_PASSWORD=letmein npm start          # → http://127.0.0.1:3939
npm test                                       # the whole suite
```

Open the URL, sign in, and you land on your slug. Docker is used for real Cell
isolation when present; without it the `local` backend runs the same code paths so the
whole system works on any machine. Expose it publicly with
`cloudflared tunnel --url http://localhost:3939`.

```bash
npx sbx login --url http://127.0.0.1:3939     # mint a machine token for this device
npx sbx ls                                     # your Sandbox's files
npx sbx ask "start a static server on 8080 and expose it"
```

---

## What ships today

The spine is alive and has grown into a machine you can work in. Roughly Phases 0–4 of
the roadmap, plus the desktop.

### The Kernel

Every call goes **authenticate → authorize (default-deny) → route → execute → audit
(hash-chained)**. Nothing reaches a Cell any other way.

| server | what it gives you |
|--------|-------------------|
| `fs` | list · read · write · append · mkdir · remove · move · copy · stat · tree · search · readBytes · writeBytes |
| `proc` | exec · list · **start / logs / jobs / stop / forget / signal** (supervised background processes) |
| `ports` | expose · unexpose · list · check · scan — and the Gateway proxies them |
| `net` | fetch, egress-policy gated |
| `secrets` | put · list · remove · useInEnv — references, never values |
| `pkg` | install · remove · list |
| `cron` | at · every · list · cancel |
| `agents` | spawn · list · get · kill, with attenuated delegation |
| `llm` | complete · models |
| `metrics` | snapshot · history · activity · recent |
| `apps` | install · list · launch · remove |
| `tide` | init · status · mark · log · diff · checkout · state objects · push/pull wire primitives |
| `mcp-registry` | list · enable · disable · configure · install · uninstall |
| `kernel` | whoami · capabilities · tools · auditQuery · manifestGet · manifestSet |

### Paying for the model

Four providers, split by *billing* rather than by vendor: a metered **Anthropic** or
**OpenAI** API key, encrypted per tenant; a **Claude subscription** the tenant signs in to
from the settings page, so calls bill to their own plan rather than to whoever set the
host up; or the **`codex` login** already on the machine, for a self-hosted instance where
the operator's plan is the point. All four go through one credential resolver, so the
Assistant, the AI agents and the `llm` server never learn the difference.

Ported from [ai-auth](https://github.com/Flyvendedk799/ai-auth), including the handful of
details that each cost a day to find out — chief among them that a subscription token must
open with the Claude Code identity block, or Anthropic refuses Sonnet and Opus with a 429
on a plan nowhere near its limit, while Haiku answers fine. See
[`packages/ai-auth/README.md`](packages/ai-auth/README.md) for the rest of them.

### The desktop

A dependency-free ES-module app behind the Gateway, in light and dark. A brand-new
Sandbox is seeded with a `WELCOME.md` that walks you through its first five minutes.

- **Console** — Command Central, streamed. Shell verbs, `:call server.tool {}`, or
  `? plain English`. History and tab-completion over the live tool catalogue.
- **Assistant** — a streaming conversation that drives the machine with real MCP tool
  calls, under your capabilities, with each call rendered inline and audited.
- **Files** — a lazy tree plus a tabbed code editor with syntax highlighting,
  auto-indent, pair closing, comment toggling and ⌘S. Upload by drag-and-drop.
- **Shell** — a WebSocket PTY (with a built-in fallback renderer when the xterm CDN
  is unreachable).
- **Agents** — spawn, watch, inspect granted capabilities, kill, re-run.
- **Ports** — expose a service and preview it in an iframe, proxied through the
  Gateway with WebSocket upgrades for HMR.
- **Processes** — supervised jobs with a live log tail, and the cron schedule.
- **Sync** — Tide: workspaces, working-tree status, marks, per-mark diffs, restore.
- **Apps**, **Secrets** — the app model and reference-only secret handling.
- **Observability** — load/memory/disk/process charts, Kernel-call histograms, and a
  full audit explorer with filters, export and hash-chain verification.
- **Settings** — provider key, Cell power and quota, the manifest edited live, who
  can reach the machine, machine tokens, sandboxes and distros.

⌘K searches workspaces, files, actions and every MCP tool at once.

### The CLI and the SDK

```bash
sbx fs put ./dist/app.js build/app.js        # streamed, binary-safe
sbx proc start "npm run dev" --name web
sbx port expose 3000 web
sbx proc logs <id> --follow
sbx ask "why is the build failing?"          # tool calls traced on stderr
sbx access share alice --patterns fs.read,proc.list
```

```js
import { SandboxClient } from "sandboxos/sdk";

const sbx = new SandboxClient({ url, slug: "tobias", token });
await sbx.fs.write("hello.txt", "hi");
const job = await sbx.proc.start("npm run dev", { name: "web" });
await sbx.ports.expose(3000, "web");
for await (const ev of sbx.assistant.ask("summarise today's changes")) {
  if (ev.type === "text") process.stdout.write(ev.text);
}
```

`createMcpServer()` from the same SDK is how you write a server the Kernel can host.

---

## Read in this order

| # | Doc | What it answers |
|---|-----|-----------------|
| 00 | [Vision & principles](docs/00-vision.md) | Why this exists, what it must always be |
| 01 | [Glossary](docs/01-glossary.md) | The shared vocabulary (read this second) |
| 02 | [Architecture](docs/02-architecture.md) | How the pieces fit, on one Mac Mini |
| 03 | [The MCP Kernel](docs/03-mcp-kernel.md) | MCP as the syscall layer |
| 04 | [Execution substrate](docs/04-execution-substrate.md) | Cells, isolation, hibernate/wake |
| 05 | [Tide protocol](docs/05-tide-protocol.md) | The git-like + live sync protocol |
| 06 | [Command Central](docs/06-command-central.md) | The remote console |
| 07 | [Slug routing & auth](docs/07-slug-routing-auth.md) | URL→machine, multitenancy |
| 08 | [Customization & distros](docs/08-customization-distros.md) | Interchangeable everything |
| 09 | [Security model](docs/09-security-model.md) | Capabilities, isolation, audit |
| 10 | [Data & storage](docs/10-data-and-storage.md) | Where state lives |
| 11 | [Tech stack](docs/11-tech-stack.md) | Concrete choices, aligned to the Mac Mini |
| 12 | [Roadmap](docs/12-roadmap.md) | Phase 0 → year 10 |
| 13 | [Open questions & risks](docs/13-open-questions.md) | What we deliberately deferred |
| 14 | [Surface map](docs/14-surface-map.md) | Every route, tool and command that exists today |

Architecture Decision Records live in [`docs/adr/`](docs/adr). Each build phase has its
own note: `PHASE0.md` … `PHASE24.md`.

## Layout

```
apps/gateway         the front door: slug routing, auth, proxying, the desktop
packages/kernel      the MCP router + the core servers
packages/cell        four execution backends behind one interface
packages/assistant   the streaming tool-use loop
packages/agents      supervised, capability-scoped agents
packages/ai-auth     bring-your-own-credential auth: API keys and subscription logins
packages/tide        the versioned + live sync protocol
packages/control-db  the control plane's SQLite schema and queries
packages/sbx-cli     the sbx binary
packages/sdk         SandboxClient + createMcpServer
test/                one suite per phase
```

## Naming & metaphor

SandboxOS keeps a single coherent metaphor: a **sandbox** on a shore. Sand is the
substrate, a **Cell** is the isolation boundary, and **Tide** is the water that
washes data in and out — versioned at the low-water mark, live at the flood. Names
marked *(provisional)* in the glossary are open for a better word; the concepts are not.
