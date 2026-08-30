// os.js — boot the OS experience full screen.
//
// This is the machine as a place: you land in it, and it looks the way you left
// it because the desktop is a document on the server, not state in a tab.

import { $, h, slug, toast, toastError } from "../core.js";
import { mountSprite } from "./sprite.js";
import { os, loadOs, connect, onOs, call, select } from "./client.js";
import { createScreen } from "./shell.js";
import { startBroker } from "./frames.js";
import { mountAssistantWindow } from "./agent.js";
import { createBuilder } from "./builder.js";

mountSprite();

const root = $("#os-root");

// Windows whose renderer needs more than the built-ins have: the Assistant is a
// streaming conversation, and the Studio pane is the builder itself.
function mountSpecial(appId, host, win, ctx) {
  if (appId === "assistant") return mountAssistantWindow(host, win, ctx);
  if (appId === "studio") {
    const builder = createBuilder({});
    builder.el.style.cssText = "width:100%;height:100%;border-right:0;background:transparent;";
    host.append(builder.el);
    builder.render();
    const off = onOs(() => builder.render());
    return () => off();
  }
  return null;
}

const screen = createScreen({
  ctx: {
    mountSpecial,
    openStudio: () => { location.href = `/${slug}/studio`; },
    onSelect: (id, kind) => select(id, kind),
  },
});
root.append(screen.el);

onOs(() => screen.render());

startBroker({
  notify: ({ title, body, kind, app }) => call("notify", { title, body, kind, app }).catch(() => {}),
});

(async () => {
  try {
    await loadOs();
    connect();
    screen.render();
    document.title = `${os.doc.name} · SandboxOS`;
  } catch (e) {
    toastError("Could not load this machine's OS", e);
    root.append(h("div", { style: { padding: "40px", textAlign: "center", color: "var(--stx-text-2)" } },
      h("p", "The OS document could not be read."),
      h("a", { href: `/${slug}` }, "Open Command Central instead")));
  }
})();

// A machine you cannot leave is a trap: one shortcut back to Command Central,
// one to the Studio.
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
  if (e.key.toLowerCase() === "c") { e.preventDefault(); location.href = `/${slug}`; }
  if (e.key.toLowerCase() === "b") { e.preventDefault(); location.href = `/${slug}/studio`; }
});

window.addEventListener("online", () => toast("Back online", { kind: "ok", timeout: 2000 }));
