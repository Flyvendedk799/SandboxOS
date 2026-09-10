// First run — goal.md T5.1, "ten minutes to useful".
//
// A brand-new machine used to open on a tidy but idle desktop, which reads as a
// screenshot. What a person needs in the first minute is their machine *doing
// something*, made of parts they can see and take apart: a folder of ordinary
// files, a page served from it, and a job they can stop.
//
// So this module holds the two things the `desktop.setup` tool needs and the
// document does not: what to write into the volume, and how to serve it on a
// host whose contents we do not control.

/**
 * The welcome project, as ordinary files in the volume. Nothing here is
 * special-cased anywhere: it is a folder you can rename, edit or delete, and the
 * point of the first screen is that you can see that.
 */
export function firstRunFiles(machineName, seed) {
  const name = String(machineName ?? "your machine").slice(0, 64);
  const title = name.replace(/[<>&]/g, "");
  return {
    "welcome/index.html": [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      `<title>${title}</title>`,
      '<link rel="stylesheet" href="./style.css" />',
      "</head>",
      "<body>",
      "  <main>",
      `    <h1>${title}</h1>`,
      "    <p class=\"lede\">This page is a file in your machine's volume, served by a job you started, ",
      "    reached through your own slug. Nothing about it is a demo.</p>",
      "    <ol>",
      "      <li><b>The folder</b> is <code>welcome/</code>. Open it in Files and change this line.</li>",
      "      <li><b>The server</b> is a supervised process called <code>welcome</code>. Open Jobs to see its log, or stop it.</li>",
      "      <li><b>The address</b> is an exposed port. Open Ports to see it, unexpose it, or add another.</li>",
      "      <li><b>The desktop</b> is one JSON document. Open the Manual and read <i>The one idea</i>.</li>",
      "    </ol>",
      "    <p class=\"dim\">Everything you just read is something an agent can do too, through the same tools.</p>",
      "  </main>",
      "</body>",
      "</html>",
      "",
    ].join("\n"),

    "welcome/style.css": [
      ":root { color-scheme: dark light; }",
      "body {",
      "  margin: 0; padding: 8vh 6vw; background: #0b0f14; color: #e6edf3;",
      "  font: 15px/1.7 ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif;",
      "}",
      "main { max-width: 62ch; margin: 0 auto; }",
      "h1 { font-size: 26px; margin: 0 0 10px; letter-spacing: -.01em; }",
      ".lede { color: #9fb0c0; margin: 0 0 22px; }",
      "ol { padding-left: 20px; }",
      "li { margin: 10px 0; }",
      "code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px;",
      "  background: rgba(255,255,255,.07); border-radius: 5px; padding: 1px 5px; }",
      ".dim { color: #6b7f92; font-size: 13px; margin-top: 26px; }",
      "@media (prefers-color-scheme: light) { body { background: #f6f8fa; color: #16202a; }",
      "  .lede { color: #4d6273; } .dim { color: #6b7f92; } code { background: rgba(0,0,0,.06); } }",
      "",
    ].join("\n"),

    // The server, written beside the page whether or not this host can run it:
    // a file you can read is worth more than a command you cannot see.
    "welcome/serve.cjs": firstRunServeJs(),

    // A note, in the folder the Notes app reads by default, so the second thing
    // you open is already yours to write in.
    "notes/first-day.md": [
      `# ${title}`,
      "",
      `Started from the **${seed?.name ?? "default"}** seed.`,
      "",
      "Three things worth knowing on day one:",
      "",
      "1. The desktop is a document. Every window, widget, theme and app is one",
      "   JSON object on the server, changed only through `desktop.*` tools. That is",
      "   why a second tab, a phone and an agent all see the same machine, and why",
      "   every change can be undone.",
      "2. You and an agent have the same tools. Anything you can do by hand is a",
      "   tool call, audited; anything an agent does is a change you can read first",
      "   and revert after.",
      "3. Nothing here is fixed. Open the Studio and change an app, a theme or the",
      "   keyboard; publish the result as a distro and hand it to someone.",
      "",
      "Delete this note whenever you like — it is an ordinary file.",
      "",
    ].join("\n"),
  };
}

/**
 * How to serve a folder on *this* Cell. The image may have Node, or Python, or
 * only busybox, or none of them — so ask, in that order, and let the caller say
 * out loud when the answer is none.
 *
 * `probe` is a function that runs a command in the Cell and resolves to the
 * Kernel's result envelope, so this stays pure and testable.
 */
export async function firstRunServer(probe) {
  const candidates = [
    { label: "node", test: "command -v node", cmd: (port) => `node welcome/serve.cjs ${port}` },
    { label: "python3", test: "command -v python3", cmd: (port) => `python3 -m http.server ${port} --directory welcome` },
    { label: "python", test: "command -v python", cmd: (port) => `python -m http.server ${port} --directory welcome` },
    // Not "is busybox here" but "does this busybox have httpd": `--list` prints
    // the applets it was built with, and exits 0 while `--help` exits 1.
    { label: "busybox httpd", test: "busybox --list 2>/dev/null | grep -qx httpd", cmd: (port) => `busybox httpd -f -p ${port} -h welcome` },
    { label: "httpd", test: "command -v httpd", cmd: (port) => `httpd -f -p ${port} -h welcome` },
  ];
  const tried = [];
  for (const c of candidates) {
    const r = await probe("proc", "exec", { cmd: c.test });
    // `ok:false` is the Cell refusing to run anything at all — no shell, no
    // capability — and there is no point asking about the next binary.
    if (!r.ok) return { cmd: null, why: `nothing can run in this Cell: ${r.error}` };
    if (r.result?.code === 0) return c;
    tried.push(c.label);
  }
  return { cmd: null, why: `this image has none of: ${tried.join(", ")} — the folder is there, but nothing here can serve it` };
}

/** The tiny static server the Node branch runs. Written with the project. */
export function firstRunServeJs() {
  return [
    "// The server behind your welcome page. Ordinary Node, ordinary files: read",
    "// it, change it, or stop the job in Jobs and start your own.",
    "//",
    "// The .cjs suffix is deliberate: a volume that happens to sit under a",
    "// package.json saying \"type\": \"module\" would otherwise turn require() into",
    "// an error nobody asked for.",
    "const http = require('node:http');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "",
    "const port = Number(process.argv[2]) || 8080;",
    "const root = path.join(__dirname);",
    "const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };",
    "",
    "http.createServer((req, res) => {",
    "  const rel = decodeURIComponent((req.url || '/').split('?')[0]);",
    "  const file = path.join(root, rel === '/' ? 'index.html' : rel);",
    "  // Never serve outside the folder, however the URL is spelled.",
    "  if (!file.startsWith(root)) { res.writeHead(403).end('no'); return; }",
    "  fs.readFile(file, (err, body) => {",
    "    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here'); return; }",
    "    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });",
    "    res.end(body);",
    "  });",
    "}).listen(port, '127.0.0.1', () => console.log('welcome on :' + port));",
    "",
  ].join("\n");
}

/** Ports first run tries first: ordinary numbers a person recognises. */
export const FIRST_RUN_PORTS = Object.freeze([8080, 8081, 8090, 8123, 3000]);

/**
 * A port nothing is answering on: one of the friendly ones if it is free, and
 * otherwise something out of the way. `probe` runs `ports.check` and resolves
 * to the Kernel envelope.
 *
 * Returning a busy port would be worse than returning none — the server would
 * start, die of EADDRINUSE, and first run would have to report a failure it
 * caused itself — so when everything it tries is taken it says so with null and
 * lets the caller be honest about it.
 */
export async function firstRunPort(probe) {
  const free = async (port) => {
    const r = await probe("ports", "check", { port });
    // A Cell that cannot probe at all cannot tell us anything; take the port and
    // let the server's own failure be the reading.
    if (!r.ok) return true;
    return !r.result?.up;
  };
  for (const port of FIRST_RUN_PORTS) if (await free(port)) return port;
  // The obvious numbers are all in use on this host — a developer machine with
  // three things already running is normal. Try somewhere quieter.
  for (let i = 0; i < 12; i += 1) {
    const port = 8200 + Math.floor(Math.random() * 700);
    if (await free(port)) return port;
  }
  return null;
}
