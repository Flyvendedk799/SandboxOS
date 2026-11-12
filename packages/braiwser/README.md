# `braiwser` — the Browser app is Braiwser

SandboxOS's Browser is [Braiwser](https://github.com/Flyvendedk799/Braiwser): a real
Chromium per open window, running next to the Gateway and driven through Braiwser's own
Playwright driver (`src/main/services/browser/drivers/playwright.js` in the pinned
revision). The window shows JPEG frames of the page and sends back what the person does
as Braiwser human input — clicks, typing, scrolling, back/forward, tabs.

It works on a brand-new machine with nothing configured: type an address or a search.
Configuration is only for the specialised cases (ports, egress policy, limits).

## Runtime

Braiwser is not vendored. `runtime.json` pins one revision, and the host installs that
exact tree once — the same layout and receipts as openbot's installer, so one runtime
can serve both (`BRAIWSER_RUNTIME_ROOT` is honoured).

* **Automatic.** The first time anyone opens the Browser on a host without the runtime,
  the Gateway runs `scripts/install-braiwser-runtime.mjs` in the background and the
  window shows its progress (clone → dependencies → Chromium). Needs git, npm and
  network access. `SANDBOXOS_BRAIWSER_AUTOINSTALL=0` turns this off.
* **Ahead of time.** `npm run braiwser:install [dir]` (add `--system-chromium` to use
  `/usr/bin/chromium`). The install builds in a staging directory and renames it into
  place only when finished; the `runtime-revision` receipt is what "installed" means.
* Until it is ready, the window can still open the machine's exposed ports directly.

## What a page may reach (`src/guard.js`)

The browser runs on the Gateway's host, so every request is classified first:

| destination | rule |
|---|---|
| `localhost` / `127.0.0.1` / `::1` on any port | **this Sandbox's port**, routed into its Cell — only with `ports.access` and only if the port is exposed (the `/p/<port>` rule, checked per request). WebSockets are relayed, so dev-server hot reload works. |
| a public host | the Sandbox's `net` egress policy, then resolved: a name that resolves to a private address is refused |
| private, link-local, metadata, single-label or `.local`/`.internal` names | refused (a readable page for a navigation, dropped for a sub-resource) |

Service workers are blocked (their requests would bypass the per-request policy). Known
gap, shared with `net.fetch`'s threat model but not its pinning: Chromium resolves a name
again after the guard did, so a DNS-rebinding host could in principle swap addresses
between the two lookups.

## Agents

`net.browse` is also a Kernel tool: an agent opens a page in Braiwser and gets its
rendered text and title back — for pages that need JavaScript, where `net.fetch` returns
an empty shell. Same policy as above, per request; a few run at once per host
(`SANDBOXOS_BRAIWSER_AGENT_CONCURRENCY`, default 2), the rest wait.

## Capability and limits

Using it needs `net.browse` (owners hold `*`). Environment knobs:
`SANDBOXOS_BRAIWSER_MAX` (host total, default 4), `SANDBOXOS_BRAIWSER_PER_SANDBOX` (2),
`SANDBOXOS_BRAIWSER_IDLE_MS` (180000 — a session nobody watches is closed; the window
remembers its address and reopens there), `SANDBOXOS_BRAIWSER_NO_SANDBOX=1` (Chromium
without its own sandbox, for a root container where the container is the boundary).
