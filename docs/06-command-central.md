# 06 · Command Central

> The remote-first console. Control your Sandbox — and your agents — from everywhere.

Command Central is the human's seat at the machine. It is **one authenticated MCP
client** with a console UX, available two ways:

- **Web terminal** at your slug (browser, `xterm.js` — nothing to install).
- **`sbx` CLI** (native binary, holds a machine token, same capabilities anywhere).

Both connect through the Gateway to your Cell's Kernel and speak MCP. "Control remotely,
from everywhere" is the requirement; the Cloudflare-tunneled Gateway is how a Mac Mini
behind home NAT is reachable from any network without opening ports.

## Three input modes, one console

Command Central accepts intent at three levels of abstraction. You move between them
fluidly in the same session.

### 1. Shell verbs (familiar)
Unix-shaped commands that map to MCP tool calls. The console ships a **verb map** from
shell idiom → `(server, tool, args)`:

```
ls /projects        → fs.list   { path:"/projects" }
cat notes.md        → fs.read   { path:"notes.md" }
tree src 2          → fs.tree   { path:"src", depth:2 }
grep TODO src       → fs.search { query:"TODO", path:"src" }
run "npm run dev"   → proc.start  { cmd:"npm run dev" }   # supervised, outlives the request
logs p3f8a1         → proc.logs   { id:"p3f8a1" }
port expose 3000    → ports.expose { port:3000 }          # then it is at /<slug>/p/3000/
ps                  → proc.list {}
run "npm test"      → proc.exec { cmd:"npm test" }
tide push           → tide.push {}
agent run scout …   → agents.spawn { role:"scout", … }
install gmail       → mcp-registry.install { server:"gmail" }
```

This makes the OS instantly approachable — a newcomer types `ls` and it works — while
every command is, underneath, an audited capability-checked MCP call. The verb map is
itself customizable per Sandbox (aliases, custom verbs → tool sequences).

### 2. Raw MCP (powerful)
Drop to the metal and call any tool directly with typed args. For power users, scripts,
and debugging:

```
:call fs.write { path:"a.txt", content:"hi" }
:tools                      # list the full tool catalog (the union of enabled servers)
:describe tide.link         # show a tool's typed schema
:capabilities               # what may I invoke right now?
:audit fs.write --since 1h  # query the audit log
```

The `:`-prefix is the escape hatch to the real ABI. Nothing in the shell layer can do
something raw MCP can't — the shell is sugar, not a gate.

### 3. Natural language (AI-native)
Because SandboxOS is agent-native, the console embeds an agent that translates intent
into MCP calls. Type a sentence; it plans, shows the tool calls it intends, and (per
your confirmation policy) executes:

```
> find every TODO in my projects added this week and open them in a workspace
  ⟶ proposes: fs.search + tide.init + … (preview)  [confirm] [edit] [deny]
```

This is the same propose→confirm pattern your other projects use for AI edits. NL is a
mode of the console, not a separate product — and it bottoms out in the *same* audited
MCP calls as the other two modes, so it is never a magic side-channel.

## Supervising agents from the console

Command Central is also mission control for your fleet. Through the `agents` server:

```
agent list                       # running agents, their roles, capability sets
agent run reviewer --on pr/123   # spawn an agent with a scoped capability set
agent watch reviewer             # stream its MCP calls live (it's all auditable)
agent message reviewer "focus on the auth changes"
agent pause / retire reviewer
```

You see, in real time, every tool an agent invokes — because every agent action is an
audited MCP call through the same Kernel. The human is always able to watch, steer, and
stop. This is the supervision story that makes an agent-native OS trustworthy.

## Session, identity, and reach-from-everywhere

- **Web:** log in → session bound to your tenant and its capabilities → the terminal is
  scoped to exactly what you may do. Close the laptop, reopen on your phone, same slug,
  same session model.
- **CLI:** `sbx login` once mints a **machine token** for that device (capability-scoped,
  revocable). `sbx` then works from any network — home, office, a café — reaching the
  Gateway over the public tunnel. The same `sbx` talks to any Sandbox you own.
- **Multiplexing:** the console connection is multiplexed (command I/O, log streams,
  agent watch, file events) over one channel, so a single session gives you the whole
  machine, not one pipe at a time.

## Customizable console

Per vision principle (interchangeable by default), Command Central is configurable in
the Sandbox manifest: the verb map and aliases, the default confirmation policy for NL
actions, the prompt/theme, which servers' tools are surfaced first, and startup
scripts. A distro can ship its own console personality.

## The `sbx` surface (sketch)

```
sbx login                     # mint a machine token for this device
sbx <slug>                    # attach a console to a Sandbox (default: your primary)
sbx run "<command>"           # one-shot command, non-interactive
sbx call <tool> <json>        # raw MCP from the shell
sbx agent <verb> …            # agent lifecycle
sbx tide <verb> …             # delegate to the tide tool/daemon
sbx tunnel                    # expose a local port into a Sandbox (dev loop)
```

`sbx` is the human CLI; `tide` is the data-sync CLI. They are siblings, not the same
binary — keeping "command my machine" and "move my data" as distinct, memorable tools.
