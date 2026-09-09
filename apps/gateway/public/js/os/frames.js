// frames.js — hosting code we did not write.
//
// A custom app runs in an iframe with `allow-scripts` and NOT `allow-same-origin`,
// which gives it an opaque origin: no access to our cookies, our storage, or the
// parent DOM. Its CSP forbids connect-src, so it cannot call the Gateway at all.
// Everything it wants goes through the broker below.
//
// The broker holds a machine token minted server-side for exactly the patterns
// the app declared INTERSECTED with what the person opening it holds. The frame
// never sees that token. The client-side pattern check here is a courtesy that
// gives the app a clean error instead of an audit-log denial — the real boundary
// is the Kernel, which will refuse anything outside the token's grants no matter
// what this file does.

import { h, slug } from "../core.js";

const sessions = new Map(); // appId → Promise<{token, patterns, withheld}>
const frames = new Set();   // {id, kind, el, onTitle, onResize, onClose}

// What each app has said about itself lately — errors and warnings from inside
// the frame, kept per app so the Studio can show them next to the source. A ring:
// an app in a loop must not become a memory leak in the shell.
const LOG_KEEP = 200;
const logs = new Map();      // appId → [{level, text, where, at}]
const logWatchers = new Set();

/** The recent output of one app's frame (or all of them). */
export function frameLogs(id = null) {
  if (id) return [...(logs.get(id) ?? [])];
  return [...logs.entries()].flatMap(([app, list]) => list.map((l) => ({ ...l, app })));
}

/** Forget an app's output — a fresh start after a fix. */
export function clearFrameLogs(id = null) {
  if (id) logs.delete(id); else logs.clear();
  for (const fn of logWatchers) { try { fn(id); } catch { /* a watcher is not the point */ } }
}

/** Watch what apps print. Returns an unsubscribe. */
export function onFrameLog(fn) { logWatchers.add(fn); return () => logWatchers.delete(fn); }

function pushLog(id, entry) {
  const list = logs.get(id) ?? [];
  list.push(entry);
  while (list.length > LOG_KEEP) list.shift();
  logs.set(id, list);
  for (const fn of logWatchers) { try { fn(id, entry); } catch { /* as above */ } }
}

export function appSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, fetch(`/${slug}/os/apps/${encodeURIComponent(id)}/session`, { method: "POST" })
      .then((r) => r.json())
      .then((r) => (r.ok ? r : { token: null, patterns: [], withheld: [] }))
      .catch(() => ({ token: null, patterns: [], withheld: [] })));
  }
  return sessions.get(id);
}

/** Forget a session — after an app's permissions change, or it is removed. */
export function dropSession(id) { sessions.delete(id); }

const covers = (held, wanted) => {
  if (held === "*" || held === wanted) return true;
  const [hs, ht] = held.split(".");
  const [ws, wt] = wanted.split(".");
  return hs === ws && (ht === "*" || ht === wt);
};

/**
 * Create a frame for a custom app or widget.
 * @param opts.id      app id / widget kind
 * @param opts.kind    "app" | "widget"
 * @param opts.onTitle called when the app renames its own window
 * @param opts.onResize called when the app asks for a size
 * @param opts.onClose  called when the app closes itself
 */
export function createFrame({ id, kind = "app", onTitle, onResize, onClose, onFocusOut }) {
  const path = kind === "widget" ? "widgets" : "apps";
  const frame = h("iframe", {
    sandbox: "allow-scripts allow-forms allow-popups allow-modals",
    referrerpolicy: "no-referrer",
    title: id,
  });
  // The src waits for the session, because it carries the *asset key*: the
  // frame runs at an opaque origin and can send no cookie, so its own files
  // are read through a key in the path instead. Without it an app could load
  // its entry document and nothing it imported — a CORS error in a console
  // that belongs to nobody (goal.md T2.2).
  appSession(id).then((s) => {
    frame.src = s.assetKey
      ? `/${slug}/os/${path}/${encodeURIComponent(id)}/k/${encodeURIComponent(s.assetKey)}/`
      : `/${slug}/os/${path}/${encodeURIComponent(id)}/`;
  });
  // Registered by ELEMENT, not by contentWindow: an app's first message can beat
  // the iframe's load event, and a frame whose very first call is dropped as
  // "not one of ours" is a bug that only shows up on fast machines.
  frames.add({ id, kind, el: frame, onTitle, onResize, onClose, onFocusOut });
  return frame;
}

/** Which registered frame sent this message, if any. */
function frameFor(source) {
  for (const entry of frames) {
    if (entry.el.contentWindow === source) return entry;
  }
  return null;
}

export function destroyFrame(frame) {
  for (const entry of frames) if (entry.el === frame) frames.delete(entry);
  frame?.remove();
}

/**
 * Reload every frame running a given app or widget. Called when its source
 * changes — which is how "the agent just rewrote my app" becomes something you
 * see rather than something you have to go and refresh.
 */
export function reloadFramesFor(id, { path = null } = {}) {
  if (!id) return;
  // A CSS-only write does not need a reload: the frame swaps the stylesheet in
  // place and keeps whatever it was doing. Anything else is a full reload.
  if (path && /\.css$/i.test(path)) {
    for (const entry of frames) {
      if (entry.id !== id) continue;
      try { entry.el.contentWindow?.postMessage({ __sbx: 1, id: "event", type: "event", event: "css", detail: { path } }, "*"); }
      catch { /* frame gone */ }
    }
    return;
  }
  dropSession(id); // its permissions may have changed with its definition
  for (const entry of frames) {
    if (entry.id !== id) continue;
    const el = entry.el;
    const path = entry.kind === "widget" ? "widgets" : "apps";
    // A fresh session, because the definition may have changed what this app
    // is allowed to hold — and because the asset key lives in the path, the
    // reload has to rebuild the URL rather than append a cache-buster to it.
    appSession(id).then((s) => {
      const base = s.assetKey
        ? `/${slug}/os/${path}/${encodeURIComponent(id)}/k/${encodeURIComponent(s.assetKey)}/`
        : `/${slug}/os/${path}/${encodeURIComponent(id)}/`;
      el.src = `${base}?r=${Date.now()}`;
      delete el.dataset.ready;
    });
  }
}

/** Push an event into every live frame (theme changes, focus). */
export function broadcast(event, detail) {
  for (const entry of frames) {
    try { entry.el.contentWindow?.postMessage({ __sbx: 1, id: "event", type: "event", event, detail }, "*"); }
    catch { /* frame gone */ }
  }
}

// ── the watchdog ────────────────────────────────────────────────────────────
//
// An app is code we did not write, running in a frame we cannot reach into. If
// it locks up, the window it is in must not become a dead rectangle with no
// explanation — and the shell around it must stay usable (goal.md T4.3). So the
// broker pings every live frame and watches for the answer: a frame that has
// stopped replying is *reported*, and the window manager paints a card over it
// offering a reload, a close, and a way to its source.

const PING_MS = 4000;
const STUCK_AFTER_MS = 9000;
const health = new Map();      // appId → { lastSeen, stuck }
const healthWatchers = new Set();

export function frameHealth(id) {
  return health.get(id) ?? { lastSeen: 0, stuck: false };
}

/** Watch apps becoming stuck or coming back. Returns an unsubscribe. */
export function onFrameHealth(fn) { healthWatchers.add(fn); return () => healthWatchers.delete(fn); }

function setStuck(id, stuck) {
  const h = health.get(id) ?? { lastSeen: 0, stuck: false };
  if (h.stuck === stuck) return;
  h.stuck = stuck;
  health.set(id, h);
  for (const fn of healthWatchers) { try { fn(id, stuck); } catch { /* a watcher is not the point */ } }
}

let watchdog = null;
function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (document.hidden) return;    // a background tab is not a stuck app
    const now = Date.now();
    for (const entry of frames) {
      if (!entry.el.isConnected || entry.el.hidden) continue;
      if (!entry.el.dataset.ready) continue;   // it has not painted yet; that is not stuck
      const h = health.get(entry.id) ?? { lastSeen: now, stuck: false };
      health.set(entry.id, h);
      try { entry.el.contentWindow?.postMessage({ __sbx: 1, id: "event", type: "event", event: "ping" }, "*"); }
      catch { /* frame gone */ }
      setStuck(entry.id, now - h.lastSeen > STUCK_AFTER_MS);
    }
  }, PING_MS);
  watchdog.unref?.();
}

let started = false;

/** Start the broker. Idempotent; both the OS and the Studio call it. */
export function startBroker({ notify, closeWindowForFrame } = {}) {
  if (started) return;
  started = true;
  startWatchdog();

  window.addEventListener("message", async (e) => {
    const m = e.data;
    if (!m || m.__sbx !== 1) return;
    const entry = frameFor(e.source);
    if (!entry) return; // not one of ours — ignore silently

    const reply = (payload) => {
      if (!m.id) return;
      try { e.source.postMessage({ __sbx: 1, id: m.id, ...payload }, "*"); } catch { /* frame gone */ }
    };

    // An app may only ever speak for itself: the message must name the frame we
    // registered, not a neighbour it would rather be.
    if (m.app && m.app !== entry.id) return reply({ ok: false, error: "identity mismatch" });

    const session = await appSession(entry.id);

    switch (m.type) {
      case "ready":
        entry.el.dataset.ready = "1";
        health.set(entry.id, { lastSeen: Date.now(), stuck: false });
        return;

      // The answer to the watchdog's ping. One-way, like a log.
      // Escape inside a frame: give the keyboard back to the shell.
      case "focusOut":
        entry.onFocusOut?.();
        return;

      case "pong": {
        const h = health.get(entry.id) ?? { lastSeen: 0, stuck: false };
        h.lastSeen = Date.now();
        health.set(entry.id, h);
        setStuck(entry.id, false);
        return;
      }

      // One-way: an app reporting what went wrong inside it. No reply, and it
      // reaches the Studio's console rather than a place nobody looks.
      case "log":
        pushLog(entry.id, {
          level: m.level === "error" || m.level === "warn" ? m.level : "log",
          text: String(m.text ?? "").slice(0, 2000),
          where: m.where ? String(m.where).slice(0, 120) : null,
          at: Number(m.at) || Date.now(),
          kind: entry.kind,
        });
        return;

      case "permissions":
        return reply({ ok: true, result: { patterns: session.patterns ?? [], withheld: session.withheld ?? [] } });

      case "mcp": {
        const target = `${m.server}.${m.tool}`;
        if (!session.token || !(session.patterns ?? []).some((p) => covers(p, target))) {
          return reply({ ok: false, code: "denied", error: `${entry.id} was not granted ${target}` });
        }
        try {
          const res = await fetch(`/${slug}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
            body: JSON.stringify({ server: m.server, tool: m.tool, args: m.args ?? {} }),
          });
          const env = await res.json();
          return reply(env.ok
            ? { ok: true, result: env.result }
            : { ok: false, code: env.code, error: env.error });
        } catch (err) {
          return reply({ ok: false, error: err.message });
        }
      }

      case "title":
        entry.onTitle?.(String(m.title ?? "").slice(0, 120));
        return reply({ ok: true, result: true });

      case "resize":
        entry.onResize?.(Number(m.w) || null, Number(m.h) || null);
        return reply({ ok: true, result: true });

      case "close":
        (entry.onClose ?? closeWindowForFrame)?.(entry);
        return reply({ ok: true, result: true });

      case "notify":
        await notify?.({ title: m.title, body: m.body, kind: m.noteKind, app: entry.id });
        return reply({ ok: true, result: true });

      default:
        return reply({ ok: false, error: `unknown request: ${m.type}` });
    }
  });
}

