# 00 · Vision & Principles

## North star

> **An operating system whose native inhabitant is an AI agent, whose native
> interface is MCP, and whose native location is a URL.**

For fifty years, operating systems were designed for humans typing into shells and,
later, clicking in windows. Agents were grafted on top — wrapped around terminals,
screen-scraping GUIs, fighting a substrate that was never built for them. SandboxOS
inverts that. The agent is the first-class user. The human supervises, steers, and
co-works through the same fabric the agent uses. There is no impedance mismatch
because there is only one interface underneath everything: **MCP**.

SandboxOS should feel, to a person, like the simplest computer they've ever used —
"open a URL, you're in your machine." It should feel, to an agent, like the most
*legible* computer it has ever used — every capability discoverable, typed, scoped,
and audited, with no GUI to scrape and no syscall it can't reason about.

## What it is

- **An OS, web-delivered.** Not a website that pretends to be an OS, and not a Linux
  box with a web terminal stapled on. A real isolated machine per user, addressed by
  a slug, reached from anywhere, whose entire control surface is MCP.
- **MCP from top to end.** Files, processes, network, secrets, packages, scheduling,
  agents, the GUI, *and the OS's own administration* are all MCP servers. "Full MCP
  control" is literal: there is no privileged side-door that isn't itself MCP.
- **Highly customizable, fully interchangeable.** Every subsystem is a swappable MCP
  server. A sandbox is described by a manifest you can fork, share, and reproduce.
- **Agent-native and human-supervised.** Agents are processes with capabilities.
  Humans drive Command Central. Both speak MCP. Neither is a second-class citizen.
- **Local and remote as one.** Tide keeps your laptop and your sandbox in lockstep,
  versioned and live, so "where the file is" stops being a question you ask.

## What it is *not* (anti-goals)

- **Not a new programming language.** Tide has a command vocabulary like git's; it is
  a protocol and a tool, not a language. We invent the *minimum* new surface needed.
- **Not a Linux replacement.** Inside a Cell there can be a real Linux userland. We
  replace the *control plane and the interface*, not the kernel of computing.
- **Not a thin GUI over an LLM.** The intelligence is pervasive but the substrate is
  real: real isolation, real files, real audit. Magic that can't be inspected is a bug.
- **Not locked to one model or vendor.** Provider-abstracted from day one (Claude
  first, others pluggable), MCP-standard so any compliant tool or agent interoperates.

## Design principles (the rules that don't bend)

1. **One interface to rule them.** If a capability isn't reachable through MCP, it
   doesn't exist to SandboxOS. No hidden APIs, no privileged bypass. This is what
   makes the system uniformly automatable, auditable, and swappable.
2. **Capabilities, not credentials.** A caller can do exactly the MCP tools it was
   granted — nothing ambient, nothing inherited by accident. Security is a graph of
   grants, and every grant is visible.
3. **Everything is observable.** Every MCP call is logged with provenance: who, what,
   when, on whose behalf, with what result. An AI-first OS that you can't audit is a
   liability, not a product.
4. **Interchangeable by default.** Any subsystem can be replaced by swapping its MCP
   server. The `fs` could be local disk, an object store, or content-addressed Tide
   objects — callers never know or care.
5. **Reproducible by description.** A sandbox is a manifest plus its data. Given the
   manifest, you can rebuild the machine. This is what makes distros, forking, and
   fleet portability possible.
6. **Simple surface, deep capability.** "Open a URL, you're in." The depth lives
   behind a surface a newcomer can use in sixty seconds.
7. **Local-first ergonomics, cloud-first truth.** Work offline against a mirror; the
   versioned core is the source of truth; Tide reconciles. Latency is never an excuse
   for losing work.
8. **Build the spine, not the skin.** Every phase must produce a load-bearing spine
   that the next phase extends. We do not build demos we throw away.

## Who it's for

Both, by explicit decision (see the kickoff Q&A):

- **You and your agents, first.** SandboxOS is a control plane for one operator
  running a fleet of agents across many projects — depth, power, and your workflow
  come first. This is the "dogfood" tenant and it is never a toy.
- **A multi-tenant product, from the start.** The same primitives — slug→machine,
  capability tokens, hibernate/wake, Tide portability — are the multi-tenant product.
  We do not build a single-user thing and "add multi-tenancy later"; isolation,
  quotas, and per-tenant billing are designed in from v0, even while only one tenant
  (you) exists.
- **An open platform, eventually.** The 10-year arc opens the SDK so others self-host
  and extend SandboxOS — the substrate, not just the service.

## The 10-year shape (the arc, not the schedule)

1. **The spine** — slug → container → web terminal → MCP Kernel. Prove it.
2. **The Kernel & Command Central** — full core MCP servers, the remote console, the
   capability model, hibernate/wake.
3. **Tide** — versioned core, then live mirror, MCP-exposed.
4. **Agent-native** — first-class agents, orchestration, NL control, the MCP marketplace.
5. **The product** — signup, billing, quotas, hard isolation, distros, sharing.
6. **The fleet** — multi-host, portability, microVMs, regions.
7. **The ecosystem** — open SDK, third-party servers and apps, the "Linux of agent OSes."

The schedule lives in [`12-roadmap.md`](12-roadmap.md). The arc lives here, and it
should not change much over ten years even as the schedule does.

## How we'll know it worked

- A new user goes from URL to a working, isolated machine in **under 60 seconds**.
- An agent can discover and use **100% of OS capabilities** through MCP with **zero**
  GUI scraping or out-of-band syscalls.
- A complete sandbox can be **forked, moved between hosts, and rebuilt from its
  manifest** with no manual surgery.
- You can **prove what every agent did** to any sandbox, ever, from the audit log.
- Swapping a core subsystem (e.g. the filesystem backend) requires **changing one
  MCP server**, not touching callers.
