// Command Central — Phase 5 frontend.
// Three-tab desktop: Terminal (+ NL propose/confirm) | Agents | Apps.
"use strict";

const slug = location.pathname.split("/").filter(Boolean)[0];

// ── DOM refs ────────────────────────────────────────────────────────────────
const $slug      = document.getElementById("slug");
const $ps        = document.getElementById("ps");
const $out       = document.getElementById("out");
const $line      = document.getElementById("line");
const $auditList = document.getElementById("audit-list");
const $dot       = document.getElementById("dot");
const $cellState = document.getElementById("cell-state");
const $logout    = document.getElementById("logout");

$slug.textContent = slug;
$ps.textContent   = slug + " ▸";

// ── Tab switching ────────────────────────────────────────────────────────────
const tabs   = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".tab-panel");

tabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabs.forEach((b) => b.classList.remove("active"));
    panels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "agents") refreshAgents();
    if (btn.dataset.tab === "apps")   refreshApps();
    if (btn.dataset.tab === "shell")  initShell();
  });
});

// ── Terminal output ──────────────────────────────────────────────────────────
const history = [];
let hPos = history.length;

function print(text, cls) {
  const div = document.createElement("div");
  div.className = "row" + (cls ? " " + cls : "");
  div.textContent = text;
  $out.appendChild(div);
  $out.scrollTop = $out.scrollHeight;
}

function echo(cmd) { print(slug + " ▸ " + cmd, "echo"); }

// NL propose/confirm card
function showPropose(hint, proposed) {
  const card = document.createElement("div");
  card.className = "propose-card";
  const hintEl = document.createElement("span");
  hintEl.className = "propose-hint";
  hintEl.textContent = hint;
  const runBtn = document.createElement("button");
  runBtn.textContent = "Run";
  runBtn.className = "propose-run";
  runBtn.onclick = () => { card.remove(); run(proposed); };
  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "Dismiss";
  dismissBtn.className = "ghost propose-dismiss";
  dismissBtn.onclick = () => card.remove();
  card.append(hintEl, runBtn, dismissBtn);
  $out.appendChild(card);
  $out.scrollTop = $out.scrollHeight;
}

async function run(cmd) {
  echo(cmd);
  try {
    const resp = await fetch(`/${slug}/exec-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: cmd }),
    });
    if (!resp.ok) {
      const data = await resp.json();
      print("✗ " + (data.error ?? `http ${resp.status}`), "err");
      return;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop();
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        let ev;
        try { ev = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        if (ev.type === "stdout" || ev.type === "line") {
          const text = ev.chunk ?? ev.text ?? "";
          print(text, text.startsWith("✗") || text.startsWith("stderr:") ? "err" : "");
        } else if (ev.type === "stderr") {
          print(ev.chunk ?? "", "err");
        } else if (ev.type === "clear") {
          $out.innerHTML = "";
        } else if (ev.type === "proposed") {
          showPropose(ev.hint ?? "", ev.proposed ?? "");
        } else if (ev.type === "error") {
          print("✗ " + ev.text, "err");
        }
      }
    }
  } catch (e) {
    print("✗ " + e.message, "err");
  }
}

// Input handling
$line.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const cmd = $line.value.trim();
    $line.value = "";
    hPos = history.length;
    if (!cmd) return;
    history.push(cmd);
    hPos = history.length;
    run(cmd);
  } else if (e.key === "ArrowUp") {
    if (hPos > 0) { hPos--; $line.value = history[hPos]; e.preventDefault(); }
  } else if (e.key === "ArrowDown") {
    if (hPos < history.length - 1) { hPos++; $line.value = history[hPos]; }
    else { hPos = history.length; $line.value = ""; }
  }
});

// ── Logout ───────────────────────────────────────────────────────────────────
$logout.addEventListener("click", async () => {
  await fetch("/logout", { method: "POST" });
  location.href = "/";
});

// ── Live audit stream ────────────────────────────────────────────────────────
const es = new EventSource(`/${slug}/events`);
es.addEventListener("hello", (e) => {
  const { state } = JSON.parse(e.data);
  setState(state || "running");
});
es.onmessage = (e) => {
  if (!_auditLive) return; // suppress live events while a filter query is active
  const ev = JSON.parse(e.data);
  if (!ev.server) return;
  const li = document.createElement("li");
  li.className = "ev " + ev.resultKind;
  const t = new Date(ev.ts).toISOString().slice(11, 19);
  li.innerHTML =
    `<span class="t">${t}</span>` +
    `<span class="k">${ev.resultKind}</span>` +
    `<span class="tool">${ev.server}.${ev.tool}</span>`;
  $auditList.prepend(li);
  while ($auditList.children.length > 100) $auditList.lastChild.remove();
};
es.onerror = () => setState("offline");

function setState(s) {
  $cellState.textContent = s;
  $dot.className = "dot " + (s === "running" ? "ok" : s === "offline" ? "bad" : "warn");
}

// ── Agents panel ─────────────────────────────────────────────────────────────
let agentsPoll = null;

async function refreshAgents() {
  try {
    const r = await fetch(`/${slug}/agents`);
    const data = await r.json();
    const el = document.getElementById("agents-list");
    if (!data.ok || !data.agents?.length) {
      el.innerHTML = '<p class="muted-p">No agents yet. Spawn one above.</p>';
      return;
    }
    el.innerHTML = data.agents.map((a) => {
      const stateClass = { queued: "warn", running: "ok", done: "muted", failed: "bad", killed: "muted" }[a.state] ?? "";
      const canKill = a.state === "queued" || a.state === "running";
      return `<div class="agent-row">
        <span class="ag-state ${stateClass}">${a.state}</span>
        <span class="ag-kind">${a.kind ?? "shell"}</span>
        <span class="ag-name">${esc(a.name)}</span>
        <span class="ag-cmd">${esc(a.cmd || a.name)}</span>
        <span class="ag-time">${a.created_at ? new Date(a.created_at).toISOString().slice(11, 19) : ""}</span>
        ${canKill ? `<button class="ghost sm-btn" onclick="killAgent('${a.id}')">Kill</button>` : "<span></span>"}
      </div>`;
    }).join("");
  } catch (e) {
    document.getElementById("agents-list").innerHTML = `<p class="muted-p">Error: ${esc(e.message)}</p>`;
  }
}

window.killAgent = async (id) => {
  await fetch(`/${slug}/agents/${id}`, { method: "DELETE" });
  refreshAgents();
};

// Spawn form
document.getElementById("spawn-btn").addEventListener("click", async () => {
  const name   = document.getElementById("spawn-name").value.trim();
  const prompt = document.getElementById("spawn-prompt").value.trim();
  const kind   = document.getElementById("spawn-kind").value;
  if (!name || !prompt) return;
  const args = kind === "ai"
    ? { name, kind: "ai", patterns: ["fs.*", "proc.exec"], prompt }
    : { name, kind: "shell", patterns: ["proc.exec"], cmd: prompt };
  await fetch(`/${slug}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: "agents", tool: "spawn", args }),
  });
  document.getElementById("spawn-name").value = "";
  document.getElementById("spawn-prompt").value = "";
  refreshAgents();
});

// ── Apps panel ───────────────────────────────────────────────────────────────
async function refreshApps() {
  try {
    const r = await fetch(`/${slug}/apps`);
    const data = await r.json();
    const grid = document.getElementById("apps-grid");
    if (!data.ok || !data.apps?.length) {
      grid.innerHTML = '<p class="muted-p">No apps installed. Click + Install to add one.</p>';
      return;
    }
    grid.innerHTML = data.apps.map((a) => `
      <div class="app-card">
        <span class="app-icon">📦</span>
        <div class="app-info">
          <span class="app-name">${esc(a.name)}</span>
          <span class="app-desc">${esc(a.description || "")}</span>
          <span class="app-pat">${(a.patterns ?? []).join(", ")}</span>
        </div>
        <button onclick="launchApp('${esc(a.name)}')">Launch</button>
      </div>
    `).join("");
  } catch (e) {
    document.getElementById("apps-grid").innerHTML = `<p class="muted-p">Error: ${esc(e.message)}</p>`;
  }
}

window.launchApp = async (name) => {
  const r = await fetch(`/${slug}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: "apps", tool: "launch", args: { name } }),
  });
  const data = await r.json();
  if (data.ok) {
    window.open(`${data.result.url}?token=${encodeURIComponent(data.result.token)}`, "_blank");
  }
};

// Install form toggle
document.getElementById("install-toggle").addEventListener("click", () => {
  document.getElementById("install-form").classList.toggle("hidden");
});
document.getElementById("app-cancel").addEventListener("click", () => {
  document.getElementById("install-form").classList.add("hidden");
});
document.getElementById("app-submit").addEventListener("click", async () => {
  const name     = document.getElementById("app-name").value.trim();
  const url      = document.getElementById("app-url").value.trim();
  const patterns = document.getElementById("app-patterns").value.split(",").map((s) => s.trim()).filter(Boolean);
  const desc     = document.getElementById("app-desc").value.trim();
  if (!name || !url) return;
  await fetch(`/${slug}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: "apps", tool: "install", args: { name, url, patterns, description: desc } }),
  });
  document.getElementById("install-form").classList.add("hidden");
  ["app-name", "app-url", "app-patterns", "app-desc"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  refreshApps();
});

// ── Shell / PTY tab ──────────────────────────────────────────────────────────
let _ptyWs    = null;
let _ptyTerm  = null;
let _shellReady = false;

function initShell() {
  if (_shellReady) return;
  _shellReady = true;

  if (typeof Terminal === "undefined") {
    document.getElementById("pty-container").textContent = "xterm.js failed to load (check network).";
    return;
  }

  _ptyTerm = new Terminal({
    theme: { background: "#0a0e13", foreground: "#e7eef6", cursor: "#4fd1c5" },
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: 14,
    cursorBlink: true,
  });
  _ptyTerm.open(document.getElementById("pty-container"));

  document.getElementById("pty-connect").addEventListener("click", ptyConnect);
  document.getElementById("pty-disconnect").addEventListener("click", ptyDisconnect);
}

function ptyConnect() {
  if (_ptyWs) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Use the session cookie by letting the browser send it (same-origin).
  // The gateway also accepts ?token= for non-browser clients.
  _ptyWs = new WebSocket(`${proto}//${location.host}/${slug}/pty`);
  _ptyWs.binaryType = "arraybuffer";

  _ptyTerm.clear();
  _ptyTerm.writeln("\r\n\x1b[36m── connecting to shell ──\x1b[0m\r\n");

  _ptyWs.onopen = () => {
    _ptyTerm.writeln("\x1b[32m── connected ──\x1b[0m\r\n");
    document.getElementById("pty-connect").disabled = true;
    document.getElementById("pty-disconnect").disabled = false;
    _ptyTerm.onData((data) => {
      if (_ptyWs?.readyState === WebSocket.OPEN) {
        _ptyWs.send(new TextEncoder().encode(data));
      }
    });
  };

  _ptyWs.onmessage = (e) => {
    const bytes = e.data instanceof ArrayBuffer ? e.data : e.data;
    _ptyTerm.write(new Uint8Array(bytes));
  };

  _ptyWs.onclose = _ptyWs.onerror = () => {
    _ptyWs = null;
    _ptyTerm?.writeln("\r\n\x1b[31m── disconnected ──\x1b[0m\r\n");
    document.getElementById("pty-connect").disabled = false;
    document.getElementById("pty-disconnect").disabled = true;
  };
}

function ptyDisconnect() {
  _ptyWs?.close();
  _ptyWs = null;
}

// ── Utilities ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Audit query ──────────────────────────────────────────────────────────────
let _auditLive = true; // true = streaming SSE mode; false = query-filter mode

async function queryAuditPanel() {
  const server = document.getElementById("audit-filter-server")?.value || undefined;
  const kind   = document.getElementById("audit-filter-kind")?.value || undefined;
  const params = new URLSearchParams();
  if (server) params.set("server", server);
  if (kind)   params.set("kind", kind);
  params.set("limit", "100");
  try {
    const r = await fetch(`/${slug}/audit?${params}`);
    const data = await r.json();
    if (!data.ok) return;
    const $al = document.getElementById("audit-list");
    $al.innerHTML = "";
    for (const e of data.events ?? []) {
      const li = document.createElement("li");
      li.className = "ev " + (e.result_kind ?? "");
      const t = new Date(e.ts).toISOString().slice(11, 19);
      li.innerHTML =
        `<span class="t">${t}</span>` +
        `<span class="k">${e.result_kind}</span>` +
        `<span class="tool">${e.server}.${e.tool}</span>`;
      $al.appendChild(li);
    }
    _auditLive = false;
    const $mode = document.getElementById("audit-mode");
    if ($mode) $mode.textContent = "filtered";
  } catch {}
}

document.getElementById("audit-query-btn")?.addEventListener("click", () => {
  const server = document.getElementById("audit-filter-server")?.value;
  const kind   = document.getElementById("audit-filter-kind")?.value;
  if (!server && !kind) {
    // Reset to live mode.
    _auditLive = true;
    const $mode = document.getElementById("audit-mode");
    if ($mode) $mode.textContent = "live";
    document.getElementById("audit-list").innerHTML = "";
  } else {
    queryAuditPanel();
  }
});

// ── Secrets panel ────────────────────────────────────────────────────────────
async function refreshSecrets() {
  const el = document.getElementById("secrets-list");
  if (!el) return;
  try {
    const r = await fetch(`/${slug}/secrets`);
    const data = await r.json();
    if (!data.ok) { el.innerHTML = `<p class="muted-p">Error: ${esc(data.error)}</p>`; return; }
    if (!data.secrets?.length) { el.innerHTML = '<p class="muted-p">No secrets stored. Click + Add to store one.</p>'; return; }
    el.innerHTML = data.secrets.map((s) => `
      <div class="secret-row">
        <span class="secret-name">${esc(s.name)}</span>
        <span class="secret-ref muted">${esc(s.ref)}</span>
        <button class="ghost sm-btn" onclick="deleteSecret('${esc(s.name)}')">Remove</button>
      </div>`).join("");
  } catch (e) {
    el.innerHTML = `<p class="muted-p">Error: ${esc(e.message)}</p>`;
  }
}

window.deleteSecret = async (name) => {
  await fetch(`/${slug}/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
  refreshSecrets();
};

document.getElementById("secret-add-toggle")?.addEventListener("click", () => {
  document.getElementById("secret-add-form").classList.toggle("hidden");
  document.getElementById("secret-name")?.focus();
});
document.getElementById("secret-cancel")?.addEventListener("click", () => {
  document.getElementById("secret-add-form").classList.add("hidden");
});
document.getElementById("secret-submit")?.addEventListener("click", async () => {
  const name  = document.getElementById("secret-name").value.trim();
  const value = document.getElementById("secret-value").value;
  if (!name || !value) return;
  const r = await fetch(`/${slug}/secrets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, value }),
  });
  const data = await r.json();
  if (data.ok) {
    document.getElementById("secret-name").value = "";
    document.getElementById("secret-value").value = "";
    document.getElementById("secret-add-form").classList.add("hidden");
    refreshSecrets();
  }
});

// Wire tab switch for secrets.
tabs.forEach((btn) => {
  if (btn.dataset.tab === "secrets") {
    btn.addEventListener("click", refreshSecrets);
  }
});

// ── Sandbox switcher ─────────────────────────────────────────────────────────
(async () => {
  const $sel = document.getElementById("sandbox-select");
  if (!$sel) return;
  try {
    const r = await fetch("/api/sandboxes");
    const data = await r.json();
    if (!data.ok) return;
    for (const sb of data.sandboxes ?? []) {
      const opt = document.createElement("option");
      opt.value = sb.slug;
      opt.textContent = sb.slug + (sb.state === "running" ? " ●" : "");
      if (sb.slug === slug) opt.selected = true;
      $sel.appendChild(opt);
    }
    $sel.addEventListener("change", () => {
      const target = $sel.value;
      if (target && target !== slug) location.href = `/${target}`;
    });
  } catch {}
})();

// ── Boot ─────────────────────────────────────────────────────────────────────
print("SandboxOS · Command Central — Phase 5", "muted");
print("type 'help' for verbs · '? <intent>' for NL · ':call server.tool {}' for raw MCP", "muted");
setState("running");
