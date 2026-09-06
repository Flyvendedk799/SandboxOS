# Heroplan — Desktop & Studio, Next Level

> For a sophisticated coding agent. Phase 27 made the machine a *place*. This plan
> makes that place *world-class*: deeper window management, a real authoring
> environment, apps that are MCP servers, distros that travel, a mobile OS that is
> not a folded desktop, and a contract so clear a second renderer can exist.
>
> Canonical truth today: [`docs/15-os-experience.md`](docs/15-os-experience.md),
> [`packages/os`](packages/os), [`packages/kernel/src/servers/desktop.js`](packages/kernel/src/servers/desktop.js),
> [`apps/gateway/public/js/os/`](apps/gateway/public/js/os/), [`PHASE27.md`](PHASE27.md).
> Older docs (`08`, roadmap Phase 3) still describe the *vision* of apps-as-MCP;
> treat `15` as what shipped and this file as what comes next.

---

## 0 · Thesis

**The desktop is a document.** That decision is load-bearing and must not be
revisited. Every next-level move either deepens the document, deepens the tools
that rewrite it, or deepens the renderers that honour it — never invents a
privileged path around the Kernel.

What Phase 27 proved:

- One JSON object beside the Cell, mutated only by `desktop.*`, SSE-synced,
  revisioned, agent-writable under closed grammars.
- A dependency-free ES-module shell that is itself a client of those tools.
- Custom apps in opaque-origin frames with attenuated capability sessions.
- Distros as document + bundle source, tenant-scoped publish/fork/export/import.
- The Studio stage *is* the desktop — no preview drift.

What Phase 27 left thin, missing, or deliberately deferred — and what this plan
attacks:

| Status | Area |
|---|---|
| Thin | Tiling (equal √N grid), Studio Code (textarea), animation authoring (preset pick only), Media/Browser builtins, compact phone (widgets gone), history UI (8 of 40), alias apps (`open` rejects them) |
| Schema-only | `widgetKinds.refreshMs` (unused by frame host) |
| Dual / ununified | Manifest/Tide distros (`docs/08`) vs OS document distros (`distros.os`) |
| Vision unmet | App = GUI **+** MCP server (`docs/08` §app model) |
| Deliberately absent | Cross-tenant distro registry, SSR, per-app Cell process, CRDT (LWW + `expectRev` is enough) |
| Untapped | `expectRev` unused by shell gestures; volume-origin apps; second renderer; decorative menubar status |

The sky is the limit *within the contract*. Ambition that breaks
"document → Kernel → audit → SSE → renderer" is out of scope. Ambition that
makes that loop feel like macOS + Figma + VS Code + an agent that lives there
is exactly in scope.

---

## 1 · Invariants (do not break)

An implementing agent must treat these as hard constraints. If a feature needs
to violate one, stop and propose an ADR instead of shipping the feature.

1. **No privileged UI path.** If the shell can do it, `desktop.*` can do it, and
   an agent can do it under the same authZ. Gestures may paint locally; they
   commit once through a tool.
2. **`normalizeDoc` never throws.** Hostile / agent-written documents are
   clamped, truncated, re-homed. Ceilings stay; raise them only with a test and
   a reason.
3. **Closed appearance grammars.** Colours = hex/`rgb(a)`. Wallpapers = gradients
   and colours only. Motion presets = numbers + closed easings → compiled CSS.
   Never accept free-form CSS from the document.
4. **Server is viewport-agnostic.** Geometry tools take `viewport` from the
   caller. Tiling trees and snap regions are semantic; pixels are a client
   concern.
5. **OS storage stays beside the Cell**, not in the volume (except apps that
   explicitly choose `origin: "volume"`).
6. **Notifying never creates a desktop.** `hasOs()` remains the guard for
   `proc` / `agents` auto-notify.
7. **Custom app sandbox stays opaque-origin + `connect-src 'none'` + brokered
   token.** Attenuation = declared ∩ opener. Frame never sees credentials.
8. **Dependency-free front end** unless a phase explicitly adopts a library and
   documents why (Terminal alternate-screen is the only likely candidate).
9. **Tests pin the contract.** Extend `test/phase27.test.js` (or a successor
   `test/phase28*.test.js`); keep browser smoke for shell/Studio/frame broker.
10. **Write like the codebase.** Short comments that explain *why*; PHASE notes
    and `docs/15` stay the narrative source of truth after each wave.

---

## 2 · Current capability map (ground truth)

### Strong (extend, don't rewrite)

- Document model, store, bus, history, `expectRev` API
- Full `desktop.*` surface (~62 tools) + SDK `DesktopApi` + `sbx os`
- Theme/motion compilers + shared `theme.css`
- Floating WM, edge snap with audited regions, optimistic gestures
- Custom app/widget bundles, starters, path containment, CSP, session minting
- Distro publish/fork/export/import + five seeds + first-run Developer Box
- SSE as source of truth; tool result as hint
- Built-in Files + Terminal (own `ansi.js`, real PTY) as proof the shell is real

### Thin (deepen in place)

- Tiling WM → equal grid only (`wm.js` `tileBoxes`)
- Studio Code → single textarea, full iframe reload on save
- Theme panel → accent swatches + wallpaper string; no visual token editor
- Animation library → pick preset; `animationDefine` exists but Studio ignores it
- Compact &lt;720px → front window only; widgets hidden; no phone-native chrome
- Builtins uneven: Media ≈ image list; Browser ≈ port iframes; Console = line mode;
  calendar widget static; weather needs egress
- Layers history shows 8; store keeps 40
- Menubar wifi/battery decorative when `showStatus`

### Missing (build)

- Persisted tiling / split-tree layout in the document
- App ↔ companion MCP server packaging
- Cross-tenant / public distro gallery
- Unified manifest+OS distro snapshot
- Conflict UX (`stale_rev` surfacing; gesture `expectRev`)
- `refreshMs` / visibility-aware widget lifecycle
- Alias resolution on `open`
- Second renderer (TUI / agent desktop map)
- Serious Code IDE in Studio (tree, multi-file, syntax, agent co-edit)
- Visual motion designer mapping to closed number grammar
- Mobile widget shelf + workspace carousel
- Accessibility pass (focus rings, ARIA on chrome, reduced-motion honouring
  beyond preset `none`)

---

## 3 · Ambition horizons

Work is organized in **waves**, not calendar estimates. Each wave ships a
load-bearing spine the next wave extends (vision principle #8). A coding agent
may take one wave end-to-end, or slice vertically across waves if a single
feature needs schema + tool + UI + test together — but must not leave the
document and the shell disagreeing about what a field means.

```
Wave A  Foundation depth     — document + WM + contract gaps
Wave B  Studio as IDE        — builder becomes an authoring environment
Wave C  Apps as dual beings  — GUI + MCP server packaging
Wave D  Distro ecosystem     — unify + gallery + Tide-native path
Wave E  Presence & polish    — mobile, a11y, motion craft, builtin depth
Wave F  Second surface       — TUI / agent map / multi-client proof
```

Optional mega-moves (Wave G+) are listed at the end; they are in-scope for a
sufficiently ambitious agent but should not block A–F.

---

## 4 · Wave A — Foundation depth

**Goal:** make the document express layouts an agent can reason about, close
schema/tool holes, and make concurrent human+agent edits fail honestly.

### A1 · Real tiling in the document

Today `wm.mode = "tiling"` computes an equal √N grid in the client and does not
persist splits. Elevate tiling to a first-class layout model:

- Extend `doc.wm` (or add per-workspace `layout`) with a **split tree**:
  nodes are `{ type: "split", dir: "row"|"col", ratio, a, b }` or
  `{ type: "leaf", windowId }`, plus optional `masterStack` preset.
- Keep the server viewport-agnostic: tools mutate the tree / assign leaves;
  clients compute pixels from live viewport + `gap`.
- New or extended tools (names illustrative — match existing verb style):
  - `layoutSet` already flips mode — deepen args for tree/preset
  - `split` / `join` / `setRatio` / `swapLeaves` (or fold into `arrange` +
    `windowSet` if you can keep the tool count honest)
  - `arrange` presets: `master-stack`, `columns`, `rows`, `fullscreen-focus`
- Client: drag sash to resize ratio (commit once on release); disable free
  float drag while tiling (already true); show leaf focus ring.
- Migration: `normalizeDoc` accepts missing tree → synthesizes equal split from
  current workspace windows so old documents keep working.
- Tests: normalize round-trip, tool mutations, revert restores tree, two
  viewports tile differently from same tree.

### A2 · Honour the waiting schema

- **`refreshMs`:** frame host / widget mount schedules refresh; pause when
  workspace hidden or compact-hidden; custom widgets get a `visibility` /
  `tick` hint via bridge if needed (still no raw network from frame).
- **`alias` apps:** `desktop.open` resolves aliases; dock/spotlight show
  alias name; prevent cycles in `normalizeDoc`.
- **Associations UX:** Settings + Files "Open with…" already exist — ensure
  Studio Inspector can set associations and Spotlight "open file" uses them
  consistently.

### A3 · Conflict-aware commits

- Shell gestures and Studio inspectors pass `expectRev: os.doc.rev` on
  commit tools.
- On `stale_rev`: pull via SSE/state, toast with "Desktop moved — refreshed",
  do not silently LWW overwrite a concurrent agent edit without notice.
- Optional: short-lived local merge for pure geometry (same id, only x/y/w/h
  changed) — nice-to-have; honesty > cleverness.
- Document the policy in `docs/15` §live sync.

### A4 · History surface

- Layers panel: full 40 revisions with op/label/time; confirm before revert;
  optional "diff this rev" (structural: windows/widgets/theme keys changed).
- Tool already exists (`history` / `revert`); this is mostly UI + a small
  `history` payload enrichment if labels are thin.

### A5 · Menubar truth or silence

- Either wire status icons to real signals (egress/`net` reachability, Cell
  metrics) or hide them when data is unavailable — same honesty rule as
  widgets ("say so when a reading is unavailable").

**Done when:** an agent can `layoutSet` a master-stack, a human can drag a
sash, both see the same tree in `desktop.state`, a concurrent edit surfaces
`stale_rev`, and aliases/`refreshMs` work end-to-end with tests.

---

## 5 · Wave B — Studio as a serious builder

**Goal:** the Studio stops feeling like a control panel and becomes the place
you *make* an OS — Figma-grade selection, VS Code-grade source, agent as
co-author on the same stage.

### B1 · Code tab → multi-file editor

Replace the single textarea workflow in `builder.js` `codeTab()` with:

- File tree (bundle list) with add/rename/delete (`appDelete` / write empty /
  new tools only if grammar needs them)
- Tabbed editors or split pane; monospace editor with the same discipline as
  Command Central's Files editor (syntax highlight, indent, pair close,
  comment toggle, ⌘S) — prefer extracting shared editor primitives from
  `apps/gateway/public/js/editor.js` rather than inventing a third one
- Dirty-state per file; confirm on switch
- **Save → targeted frame reload** (already `reloadFramesFor`); add optional
  "hot inject" for CSS-only writes (swap `<link>` or inject text into frame
  without full reload) where CSP allows
- Origin toggle UI: `store` vs `volume` with clear copy about Tide/Files

### B2 · Visual theme studio

- Token editor for every `--os-*` key the compiler emits (not just accent):
  colour inputs constrained to closed colour grammar; live preview on stage
- Wallpaper builder: gradient stops UI that *emits* allowed wallpaper strings
  (never free CSS)
- `themeDefine` / `themeRemove` from UI (Library already half-does this —
  deepen)
- Export theme as JSON snippet an agent can re-apply

### B3 · Visual motion designer

- Map UI controls ↔ `animationDefine` number grammar (opacity, scale, x, y,
  rotate, blur, duration, easing enum)
- Live preview of `os-open` / `os-close` on a sample window chrome without
  writing until Save
- Preset gallery with "duplicate & edit" → custom preset in document

### B4 · Design-mode craft

- Multi-select + align/distribute (emit one `patch` or batched moves)
- Alignment guides / smart edges against other windows/widgets
- Inspector: full property sheet (props JSON editor with size cap honesty,
  pin, associations, singleton hints)
- Keyboard nudges (arrow keys → `move` by gridSize)
- Z-order tools exposed in Layers (already have z — make them obvious)

### B5 · Agent ↔ builder loop

- Agent panel can deep-link "open Code for app X" / select layer on tool call
- Tool cards that reference `appWrite` auto-reveal the file in Code
- Optional: propose→confirm for destructive distro fork/reset from agent
  (match Command Central risk posture where expensive)

### B6 · Studio information architecture

- Persist builder width, last tab, last code target (localStorage ok — chrome
  chrome, not desktop truth)
- Command palette inside Studio (in addition to OS Spotlight) scoped to
  builder actions: "new app", "define theme", "publish distro", "revert rev N"
- Empty states that teach the document model in one sentence (match existing
  voice)

**Done when:** a human can create an app, edit three files with ⌘S, design a
custom motion preset visually, align a row of widgets, and watch an agent
`appWrite` land in the open editor and the live frame — without leaving
Studio.

---

## 6 · Wave C — Apps as dual beings

**Goal:** fulfil `docs/08`'s app model: an app is a GUI for humans **and** an
MCP server for agents, same capability story.

### C1 · App package shape

Extend custom app definition (document + bundle metadata) with optional:

```jsonc
{
  "id": "port-monitor",
  "kind": "bundle",
  "permissions": ["ports.list"],
  "mcp": {
    "name": "port-monitor",
    "tools": [ /* schema */ ],
    // OR
    "entrypoint": "server.js",   // runs in-Cell or as marketplace-hosted worker
    "runtime": "cell" | "host-sandboxed"
  }
}
```

Design choice to decide in an ADR before coding (add `docs/adr/0004-app-mcp-duality.md`):

- **Lean A (faster):** GUI bundle + tools implemented as *attenuated aliases*
  that call existing kernel tools (thin façade) — good for dashboards.
- **Lean B (real):** companion process via `proc.start` / marketplace host,
  registered into `mcp-registry` for that Sandbox, capabilities = app
  permissions.
- Prefer **B for the spine**, A as a documented simplification for pure UI
  apps. Do not pretend A is B.

### C2 · Lifecycle

- `appDefine` / install registers MCP server when `mcp` present
- `appRemove` deregisters and stops companion process
- Distro payload includes server source + tool schemas
- Attenuation unchanged: app's tools still sit behind Kernel grants

### C3 · Studio & agent UX

- New App wizard: "UI only" vs "UI + tools"
- Starter templates that include a minimal tool (`ping` / `list`) and a UI
  that calls it via `sbx.mcp`
- Spotlight + `kernel.tools` show the app's tools after install
- Assistant/agent can call `port-monitor.list` without opening the window

### C4 · Security

- Companion servers are principals with grants — same as marketplace installs
- GUI frame still opaque-origin; it does not become the server
- Signing/hash of bundle+server for distro import (even a SHA256 manifest
  stub prepares Phase 6 trust)

**Done when:** publishing a distro that includes a custom app with tools, then
forking it on another Sandbox, yields both a dock icon and callable tools in
the catalog — with audit rows for both GUI-brokered and direct agent calls.

---

## 7 · Wave D — Distro ecosystem

**Goal:** "hand someone your machine" becomes a product loop, not a JSON file
dance — and the two distro concepts become one story.

### D1 · Unify OS distro ↔ manifest distro

- Define a **Sandbox snapshot** format: `Sandboxfile` / Tide state **+** OS
  document payload **+** bundle map **+** optional seed files list
- `distroPublish` / export grow to include manifest servers/agents when present
- Fork instantiates Cell composition *and* desktop
- Migration: old `distros.os`-only and Phase-4 manifest-only rows still fork;
  unified is additive
- Update `docs/08` and `docs/15` so they describe one model with two layers

### D2 · Gallery (tenant → public)

- Tenant gallery UI in Studio Library (already lists distros — make it
  browsable: search, tags, preview thumbnail generated from theme+wallpaper+
  window silhouette, not a screenshot of secrets)
- Cross-tenant registry table (control DB) with visibility:
  `private | tenant | public`
- Install from gallery = fork + record lineage
- Rate limits + payload ceiling already 8 MB — keep; add virus-of-agents
  caution: imported servers start disabled until user enables (cap model)

### D3 · Volume-origin as the Tide-native path

- Productize `origin: "volume"`: Studio default for "power" apps; Files can
  open `volumePath`; Tide versions UI source
- Seed a distro example where the app UI lives in the Cell tree
- Document when to choose store vs volume (store = trusted OS sibling;
  volume = agent/Tide workflow)

### D4 · Distro UX craft

- Publish dialog: name, description, tags, include-notifications? (default
  strip), replace-existing
- Diff-before-fork: "this replaces your OS — windows/widgets/theme"
- Export filename `*.sandboxos.json` already — add drag-drop import on Library
- First-run: allow picking a seed in onboarding, not only Developer Box

**Done when:** a user publishes "Research Box+" with a custom citation app
(MCP tools included), another tenant finds it in the gallery, forks it, and
lands in an arranged desktop with working tools — lineage visible in
`doc.distro`.

---

## 8 · Wave E — Presence, mobile, builtins, craft

**Goal:** the OS feels inhabited and intentional on every viewport; builtins
earn their dock pins; motion and a11y are designed, not incidental.

### E1 · Mobile OS (same document, better renderer)

Compact mode (&lt;720px) today hides widgets and shows one front window. Keep
the "no separate mobile document" rule; improve the renderer:

- **Dock as app switcher** — already; add labels, swipe between windows
- **Workspace carousel** (dots / swipe) → `workspaceSwitch`
- **Widget shelf** — pull-up sheet listing widgets for active workspace
  (read-only rearrange optional); do not delete widgets from the document
  when compacting
- Menubar collapses to status + Spotlight
- Touch targets ≥ 44px; snap gestures become long-press edge actions
- Tests: browser smoke at 390px width already exists — extend assertions

### E2 · Builtin depth

Upgrade without breaking the "builtins are just apps we shipped" symmetry:

| App | Next level |
|---|---|
| **Terminal** | Alternate screen buffer *or* documented opt-in to a vendored xterm; keep offline-first ethos — if CDN, fail soft to `ansi.js`. Multi-tab PTYs as window `props` |
| **Files** | Dual-pane optional; Tide status badges; drag to dock to pin; richer Open with |
| **Notes** | Multi-file notes folder; simple preview markdown; still `fs.*` only |
| **Media** | Image grid + lightbox; audio/video if MIME allowlist permits; directory watch |
| **Browser** | Port picker + history in `props`; screenshot-less; clear empty state when no ports |
| **Console** | Multi-line transcript chrome closer to Command Central mini |
| **Observability** | Sparklines already? deepen; link-through to audit explorer |
| **Settings** | Desktop section: theme, motion, dock, associations, layout mode, notifications |
| **Assistant** | Parity with CC assistant streaming UX; suggest desktop actions |
| **Studio** | In-window Studio uses same builder modules (avoid diverging forks) |

Widgets: calendar with real month nav (still local); weather honest about
egress; sticky notes persist via `widgetSet` props; jobs widget actions
(`stop`/`logs`) with capability checks.

### E3 · Motion & visual craft

- Respect `prefers-reduced-motion` → force `none` unless user overrides in doc
- Open/close/minimize genie using compiled keyframes consistently (audit CSS
  for ad-hoc transitions that ignore tokens)
- Wallpaper atmosphere: optional subtle noise/grain as *compiled* CSS from
  tokens (still closed), not flat fills
- Focus-visible rings on all chrome; contrast check for each builtin theme
- Icon sprite completeness for new actions

### E4 · Notifications as a place

- Notification centre grouping (proc vs agent vs app)
- Click → deep link (focus window, open metrics, reveal job logs)
- `notificationsRead` already; add per-id dismiss if missing
- Do not toast away information that belongs in the document

### E5 · Keyboard & Spotlight completeness

- Spotlight: actions for layout presets, "edit app source", "publish distro",
  recent files, jumping to Studio tabs
- Chord cheat-sheet overlay (`⌘?`)
- Vim-ish optional later — not required

**Done when:** phone layout feels intentional, Terminal can run a full-screen
TUI *or* clearly states why not, Settings can reshape the desktop without
Studio, and reduced-motion users get a calm machine.

---

## 9 · Wave F — Second surface (prove the contract)

**Goal:** demonstrate that the document is the OS — not the browser tab.

### F1 · Agent desktop map

- `desktop.state` already returns the doc; add a **summarize** tool or SDK
  helper: compact textual map (workspaces, windows with app/title/geom,
  widgets, theme, rev) sized for LLM context
- Studio agent and CC assistant inject this map when `desktop.*` is in play
- Optional: `desktop.screenshot` *semantic* (SVG/HTML silhouette from doc) —
  not a pixel grab of user content

### F2 · TUI renderer (`sbx os tui` or `sbx desk`)

- Read-only first: show workspaces/windows/widgets from `state`
- Keybindings call the same tools (`focus`, `workspaceSwitch`, `open`)
- Proves viewport-agnostic design; great for SSH-only operators

### F3 · Multi-client stress

- Automated test: two EventSource clients + agent patching → convergence
- Gesture + agent race with `expectRev`
- Document known LWW cases

**Done when:** an agent can reorganize a desktop it has never "seen" as pixels,
and a TUI session can switch workspaces on a machine whose browser tab is
closed.

---

## 10 · Wave G+ — Skybox (optional mega-moves)

Only after A–F spines exist — or in parallel by a second agent on a branch
that does not destabilize the document schema without versioning.

1. **Schema version 2** — if split trees + app MCP metadata deserve a bump;
   keep `normalizeDoc` migrating v1→v2.
2. **CRDT for collaborative geometry** — docs/15 says not warranted; revisit
   only if multi-human editing becomes a product requirement. Prefer better
   `expectRev` UX first.
3. **Per-app Cell process isolation for UI** — heavy; usually wrong (UI is
   browser). Prefer companion MCP in-Cell (Wave C).
4. **Native/wrapper shell** (Tauri/WKWebView) — same document, different
   renderer; still talks MCP.
5. **Plugin renderers for builtins** — load builtin UI from versioned bundles
   so distros can restyle even Files (careful: security + update story).
6. **Design-system package** — extract tokens, typography, dataviz shared by
   OS, Studio, CC, and custom app starters (`docs/08` theming ambition).
7. **AI layout co-pilot** — "tidy this workspace" as one agent skill using
   arrange/split tools; evaluate results via desktop map.
8. **Marketplace of widgets/apps** — beyond distros; signed packages; ratings
   (Phase 6 roadmap) with OS install path `appDefine` from URL.
9. **Realtime co-presence cursors** — another tab's focus ring; still LWW doc.
10. **Accessibility tree export** for agents — structured role/name/state of
    chrome derived from document + known builtin semantics.

---

## 11 · Cross-cutting engineering rules

### Schema & migrations

- Every new document field goes through `normalizeDoc` with defaults.
- Bump `OS_DOC_VERSION` when meaning changes; write migrator in `normalizeDoc`.
- Update `LIMITS` deliberately; add tests for ceilings.

### Tools

- Add tools to `packages/kernel/src/servers/desktop.js`, catalog registration,
  SDK `DesktopApi`, `sbx os` CLI, and `docs/14-surface-map.md` + `docs/15` in
  the same change set.
- Prefer deepening existing verbs over exploding tool count; agents drown in
  near-duplicates.

### Front end

- Keep id-stable WM reconcile (iframe/terminal survival is sacred).
- Gestures: local paint, one commit on release.
- Extract shared modules when Studio and OS diverge (editor, spotlight,
  dialogs).
- `os.css` stays token-driven; no hard-coded theme colours in components.

### Security checklist per PR

- [ ] New app/frame path still opaque-origin + CSP
- [ ] New string fields from agents cleaned (colour/wallpaper/path/id)
- [ ] Bundle path containment tests if touch `bundles.js`
- [ ] Distro import still size-capped and normalized before disk
- [ ] No token in `postMessage` payloads to frames

### Testing

- Unit: schema, tools, distro, attenuation (extend phase27 style)
- Integration: HTTP `/os/doc`, `/os/events`, `/os/theme.css`, app session
- Browser smoke: OS boot, Studio split, compact 390px, custom app write +
  deny, Terminal connect, new Wave features' happy paths
- Do not leave Wave A–C without tests on normalize + tools; UI-only polish
  in E can be thinner but needs smoke where interaction is novel

### Docs & PHASE note

- After each wave: `PHASE28.md` / `PHASE29.md` … in the project voice, plus
  surgical updates to `docs/15` (and `08`/`12`/`14` when surfaces change).
- Move resolved open questions out of `docs/13` if any were desktop-shaped.

---

## 12 · Suggested execution order for one ambitious agent

If taking this end-to-end in one long run, prefer this dependency order:

1. **A2** (alias, refreshMs) — small, unblocks honesty  
2. **A1** (tiling tree) — schema spine  
3. **A3–A5** (conflicts, history, status)  
4. **B1** (Code editor) — highest Studio leverage  
5. **B2–B4** (theme/motion/design craft)  
6. **C1 ADR then C2–C4** (app MCP duality)  
7. **D1–D4** (distro unify + gallery)  
8. **E1–E5** (mobile + builtins + craft)  
9. **F1–F3** (second surface)  
10. **G** only with explicit remaining budget  

Commit after each lettered wave (or after each major sub-item). Push and keep
`docs/15` accurate so the next agent can resume.

Parallelization: B and E2 can proceed beside A once A1's schema is parked
behind feature flags / tolerant normalize; C depends on stable `appDefine`
metadata; D depends on C if gallery includes toolful apps — otherwise D1/D3
can start earlier.

---

## 13 · Acceptance vision (the "done" picture)

A stranger opens `/slug/os` and feels a finished computer. They hit `/slug/studio`,
design a motion preset, split the tiling tree, write a Port Monitor with a
`ports.summary` tool, publish it as a distro. A second tenant forks it from the
gallery and their agent calls `ports.summary` without opening a window. On a
phone, the same document is a stack + widget shelf. On SSH, `sbx os tui` focuses
Terminal. An audit log explains every step. Revert brings the machine back.

Nothing in that paragraph requires abandoning the document. That is the point.

---

## 14 · File map (where to work)

| Area | Paths |
|---|---|
| Schema / store | `packages/os/src/schema.js`, `store.js`, `index.js` |
| Themes / motion | `packages/os/src/themes.js`, `animations.js` |
| Apps / bundles / distros | `packages/os/src/apps.js`, `bundles.js`, `distro.js`, `catalog.js`, `notify.js` |
| MCP tools | `packages/kernel/src/servers/desktop.js`, `packages/kernel/src/catalog.js` |
| Gateway HTTP/SSE/CSP | `apps/gateway/src/server.js` |
| Shell / WM | `apps/gateway/public/js/os/{shell,wm,client,os}.js`, `os.css` |
| Studio / builder | `apps/gateway/public/js/os/{studio,builder,agent}.js`, `studio.html` |
| Frames / bridge | `apps/gateway/public/js/os/{frames,bridge}.js` |
| Builtins / widgets / term | `apps/gateway/public/js/os/{builtins,widgets,terminal,ansi}.js` |
| SDK / CLI | `packages/sdk/src/client.js`, `packages/sbx-cli/src/sbx.js` |
| Tests | `test/phase27.test.js` → add `test/phase28*.test.js` |
| Docs | `docs/15-os-experience.md`, `docs/14-surface-map.md`, `docs/08-*.md`, `PHASE*.md` |

---

## 15 · Out of scope (explicit)

- Replacing MCP as the ABI for desktop mutation  
- Pixel screenshot capture of the user's Cell contents as a core feature  
- Building a general CRDT collaborative office suite inside the WM  
- Rewriting the OS in React/Vue (unless a dedicated ADR overturns
  dependency-free ES modules — default is no)  
- Multi-host scheduling / billing (roadmap Phases 5–4) except where distro
  gallery needs control-DB rows  

---

*This plan is a spine, not a cage. An implementing agent should deepen any
wave with discoveries from the code, but should not silently drop invariants
in §1 or ship a preview that is not the live document.*
