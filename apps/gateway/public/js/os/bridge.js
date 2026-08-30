// bridge.js — the API a custom app sees. Runs INSIDE the untrusted frame.
//
// The Gateway injects this into every bundle's entry document, so `sbx` exists
// whether or not the app's author asked for it. The frame is opaque-origin and
// its CSP forbids connect-src entirely: this postMessage channel is the only way
// out, and the shell on the other side holds a token attenuated to exactly what
// the app declared and its opener actually has. An app cannot widen that from in
// here, and nothing it does can reach the machine unaudited.

(function () {
  const tag = document.currentScript;
  const slug = tag?.dataset.slug ?? "";
  const appId = tag?.dataset.app ?? "";
  const kind = tag?.dataset.kind ?? "app";

  // Inherit the OS palette: the same compiled stylesheet the shell wears, so a
  // custom app that uses var(--os-accent) restyles itself when the OS does.
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/${slug}/os/theme.css`;
  document.head.append(link);

  const pending = new Map();
  let seq = 0;

  function post(type, payload) {
    const id = `${appId}:${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      parent.postMessage({ __sbx: 1, app: appId, kind, id, type, ...payload }, "*");
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${type} timed out`));
      }, 30_000);
    });
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.__sbx !== 1 || !m.id) return;
    const p = pending.get(m.id);
    if (!p) {
      if (m.type === "event") {
        for (const fn of subscribers) { try { fn(m.event, m.detail); } catch (err) { console.error(err); } }
      }
      return;
    }
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(Object.assign(new Error(m.error ?? "call failed"), { code: m.code }));
  });

  const subscribers = new Set();

  window.sbx = {
    /** Which app this is, and the capabilities it was actually granted. */
    app: appId,
    kind,
    slug,
    permissions: [],

    /** One MCP call against this machine, brokered by the shell. */
    mcp: (server, tool, args = {}) => post("mcp", { server, tool, args }),

    /** Read/write files in the Cell — sugar over the fs server. */
    read: (path) => post("mcp", { server: "fs", tool: "read", args: { path } }).then((r) => r.content),
    write: (path, content) => post("mcp", { server: "fs", tool: "write", args: { path, content } }),
    list: (path = ".") => post("mcp", { server: "fs", tool: "list", args: { path } }).then((r) => r.entries),
    exec: (cmd) => post("mcp", { server: "proc", tool: "exec", args: { cmd } }),

    /** Talk to the OS around you. */
    notify: (title, body, kindOfNote) => post("notify", { title, body, noteKind: kindOfNote }),
    setTitle: (title) => post("title", { title }),
    resize: (w, h) => post("resize", { w, h }),
    close: () => post("close", {}),

    /** Tell the shell the app has painted (it fades the frame in). */
    ready: () => { try { parent.postMessage({ __sbx: 1, app: appId, kind, type: "ready" }, "*"); } catch { /* detached */ } },

    /** Subscribe to shell events ('theme', 'focus', 'blur'). */
    on: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
  };

  // Ask the shell what we ended up with, so an app can degrade honestly rather
  // than fail at the first denied call.
  post("permissions", {}).then((r) => { window.sbx.permissions = r?.patterns ?? []; }).catch(() => {});
})();
