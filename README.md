# SandboxOS

> An AI-first, web-based, MCP-native operating system. Every user gets an isolated
> machine at a URL slug, controls it from anywhere through **Command Central**, and
> moves data between cloud and local through **Tide** — a versioned, live-syncing
> protocol that is git-like but built for agents.

SandboxOS is a 10-year project. This repository is, for now, **the grand plan** — a
complete A-to-Z design that everything else will be built against. Code follows the
docs, not the other way around.

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

Architecture Decision Records live in [`docs/adr/`](docs/adr).

## Status

**Phase: Plan.** No production code yet. The immediate next build is the **spine**
(Phase 0 in the roadmap): slug gateway → one container → web terminal → an MCP Kernel
with `fs` and `proc`. Everything in these docs is designed so that spine grows into
the whole system without throwing work away.

## Naming & metaphor

SandboxOS keeps a single coherent metaphor: a **sandbox** on a shore. Sand is the
substrate, a **Cell** is the isolation boundary, and **Tide** is the water that
washes data in and out — versioned at the low-water mark, live at the flood. Names
marked *(provisional)* in the glossary are open for a better word; the concepts are not.
