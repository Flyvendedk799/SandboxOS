# Phase 24 — The CLI, the SDK and the Docs

Four phases added a lot of machine. This one makes sure the machine is reachable from
outside a browser, and that the documentation describes what exists rather than what was
planned.

## `sbx` grew up

The CLI could run a Command Central line, tail the audit log, and manage agents,
sandboxes, secrets, apps, distros and quotas. It could not touch any of the surfaces
Phases 20–23 added. Now it can:

```
files       fs ls · fs cat · fs tree · fs grep · fs mkdir · fs rm
            fs get <remote> [local] · fs put <local> [remote]
processes   proc list · proc start "<cmd>" --name N · proc logs <id> -f · proc stop <id>
ports       port list · port expose <port> [name] · port close <port> · port scan
observe     metrics
admin       access <list|share|revoke>
assistant   ask "<question>" [--chat ID]
```

`fs get` and `fs put` use the streaming endpoints rather than the MCP surface, so a
binary of any size round-trips byte for byte instead of becoming base64 inside a JSON
envelope. `proc logs -f` follows a supervised process by timestamp, so a tail does not
re-print what it already showed.

`sbx ask` is the one worth calling out. It streams the assistant into your terminal:
prose on stdout, tool calls traced on stderr as `→ fs.write {…}`, and the conversation
id printed at the end so `--chat` continues it. That means the same assistant that
drives the desktop drives a shell pipeline.

The help text is now organised by what you are trying to do rather than alphabetically.

## A client SDK

`packages/sdk` previously held one function, for *writing* a server. It now has both
halves — writing a server the Kernel can host, and driving a machine from outside:

```js
import { SandboxClient } from "sandboxos/sdk";

const sbx = new SandboxClient({ url, slug: "tobias", token });
await sbx.fs.write("hello.txt", "hi");
const job = await sbx.proc.start("npm run dev", { name: "web" });
await sbx.ports.expose(3000, "web");
console.log(sbx.ports.url(3000));

for await (const ev of sbx.assistant.ask("summarise today's changes")) {
  if (ev.type === "text") process.stdout.write(ev.text);
}
```

`sbx.call(server, tool, args)` is the escape hatch and everything else is sugar over it:
`fs`, `proc` (with `wait()`), `ports` (with `url()`), `agents` (with `wait()`), `secrets`,
and `assistant`. `stream()`, `events()` and `assistant.ask()` are async iterators, so
streaming reads like a loop instead of a callback tangle.

Errors are `SandboxError` carrying the Kernel's own reason. A caller holding only
`fs.read` who tries `proc.exec` gets `denied: proc.exec`, not `HTTP 200`.

Zero dependencies: global `fetch` and nothing else. The package exports map means
`sandboxos/sdk` resolves without a build step.

## Docs that match the code

- **`README.md`** rewritten. It said "no production code yet". It now says how to run
  it, lists every core server and its tools, describes the eleven workspaces, and shows
  the CLI and SDK doing real work.
- **`docs/14-surface-map.md`** is new and is the authoritative inventory: every HTTP
  route, every MCP tool, every console verb, every CLI command, and every environment
  variable. Docs 00–13 describe the design; this one describes the build, and when they
  disagree the tests are the arbiter.
- **`docs/12-roadmap.md`** gained a status header: Phases 0–3 are implemented along with
  most of Phase 4; multi-host scheduling and the open ecosystem are not.
- **`docs/03-mcp-kernel.md`** and **`docs/06-command-central.md`** had tool and verb
  tables that had drifted from the implementation. They now match.

## Tests

`test/phase24.test.js` — 22 tests, split between the two surfaces and both driven
against a real Gateway.

The SDK half covers identity and capabilities, an `fs` round trip, binary-safe
upload/download, supervising a process and waiting for it, exposing a port and computing
its URL, streaming a command, spawning an agent and waiting for its result, storing a
secret and using it without ever seeing the value, error messages carrying the Kernel's
reason, and the assistant iterator.

The CLI half spawns the actual `sbx` binary with its own config file: put/ls/cat/get,
tree and grep, start/list/stop, port expose/list/close, metrics, access, that an unknown
subcommand fails loudly, that a bare word is still shorthand for `run`, and that
`sbx ask` streams prose to stdout and tool traces to stderr.

Full suite: **456 passing**.
