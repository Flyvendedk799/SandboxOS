import { api, dialog, fill, h, slug, toastError } from "../core.js";

const profile = ".sandboxos-run.json";
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function projectControls({ openPreview, logs }) {
  const el = h("div.project-status.project-controls", { hidden: true });
  let version = 0, timer, current, activeFolder;
  function clear() {
    version++;
    clearTimeout(timer);
    current = null; activeFolder = null;
    el.hidden = true;
  }
  async function configure(folder) {
    const path = folder === "." ? profile : folder + "/" + profile;
    const old = current?.folder === folder ? current.config : {};
    const got = await dialog({ title: "Project run settings", fields: [
      { name: "command", label: "Start command", value: old.command, placeholder: "npm run dev" },
      { name: "port", label: "Preview port", type: "number", value: old.port ?? 3000 },
    ], confirmLabel: "Save settings" });
    if (!got) return;
    try {
      const config = { command: got.command.trim(), port: Number(got.port) };
      validate(config);
      await api.mcp("fs", "write", { path, content: JSON.stringify(config, null, 2) });
      if (activeFolder === folder) await load(folder, true);
    } catch (e) { toastError("Could not configure project", e); }
  }
  function validate(c) {
    if (typeof c?.command !== "string" || !c.command.trim() || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
      throw new Error("Enter a start command and a port between 1 and 65535.");
  }
  async function load(folder, configured) {
    clear();
    activeFolder = folder;
    const ticket = version;
    if (!configured) return;
    const path = folder === "." ? profile : folder + "/" + profile;
    try {
      const { content } = await api.mcp("fs", "read", { path });
      if (ticket !== version) return;
      const config = JSON.parse(content);
      validate(config);
      current = { config, folder };
      const name = "Project · " + folder;
      const cmd = "cd " + quote("./" + folder) + " && " + config.command;
      const find = async () => (await api.mcp("proc", "jobs", {})).jobs.filter(j => j.name === name).at(-1);
      const button = (label, fn) => h("button.app-btn", { onclick: async e => {
        e.currentTarget.disabled = true;
        try { await fn(); } catch (err) { toastError(label, err); }
        if (version === ticket) refresh();
      } }, label);
      let reading = 0;
      async function run() {
        const start = async () => {
          if ((await find())?.state === "running") return;
          if ((await api.mcp("ports", "check", { port: config.port })).up) throw new Error("That port is already in use. Choose another in Project settings.");
          await api.mcp("proc", "start", { name, cmd });
        };
        if (navigator.locks) await navigator.locks.request(slug + "/" + name, start);
        else await start();
      }
      async function refresh() {
        if (ticket !== version) return;
        const attempt = ++reading;
        clearTimeout(timer);
        try {
          const job = await find();
          const running = job?.state === "running";
          const ready = running && (await api.mcp("ports", "check", { port: config.port })).up;
          if (version !== ticket || attempt !== reading) return;
          const failed = job && !running && (job.failure || job.code > 0 || job.state === "failed");
          fill(el, h("span", { title: cmd }, config.command),
            ready ? button("Open preview", async () => {
              await api.mcp("ports", "expose", { port: config.port, name });
              await openPreview(config.port, folder);
            }) : running ? h("span", "Waiting for port " + config.port + "…") : null,
            failed ? button("View error", () => logs(job.id)) : null,
            running ? button("Stop", () => api.mcp("proc", "stop", { id: job.id })) : button("Run", run),
            job && !failed ? button("Logs", () => logs(job.id)) : null,
            button("Settings", () => configure(folder)));
        } catch (err) { if (ticket === version && attempt === reading) fill(el, err.message); }
        if (ticket === version && attempt === reading) timer = setTimeout(refresh, 3000);
      }
      el.hidden = false;
      await refresh();
    } catch (err) {
      if (ticket !== version) return;
      el.hidden = false;
      fill(el, err.message, h("button.app-btn", { onclick: () => configure(folder) }, "Edit settings"));
    }
  }
  return { el, configure, load, clear, profile };
}
