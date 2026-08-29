// First-run content for a brand-new Cell volume.
//
// An empty machine is a bad first impression and, worse, an uninformative one:
// nothing in it tells you that `run` supervises a process, that a port has to be
// exposed before you can see it, or that the assistant holds your capabilities
// and no more. One file does, and it costs nothing — it is a normal file the
// owner can delete, not a hidden fixture.

import fs from "node:fs";
import path from "node:path";

const WELCOME = `# Welcome to your Sandbox

This is a real machine. It has a filesystem, processes and a network, and every
one of those is reached the same way: an **MCP tool call through the Kernel**,
authorized against what you hold and written to the audit log. The console, the
assistant, an agent and the \`sbx\` CLI are four doors into the same room.

## Try these, in order

    ls                          this directory, through fs.list
    tree                        the whole thing, bounded
    grep Sandbox .              search file contents
    write hello.txt hi there    fs.write — watch it appear in Files

## Run something that outlives the request

    run "python3 -m http.server 8080" web

That is \`proc.start\`: a supervised process. It keeps running after the command
returns, and its output is captured for you.

    jobs                        what is running
    logs <id>                   tail it
    stop <id>                   stop it

## Then look at it

A service inside this Cell is not reachable until you say so:

    port expose 8080 web

Now it is at \`/<your-slug>/p/8080/\` — open the **Ports** panel and preview it in
place. WebSocket upgrades are proxied too, so a dev server's hot reload works.

## Ask instead of typing

Press the **Assistant** in the left rail, or prefix a console line with \`?\` to
have plain English translated into a command before it runs. The assistant reaches
for the same tools you would, under *your* capabilities — it can never do
something you could not do yourself, and every call it makes shows up in the
Activity dock beside yours.

## Where things are

| panel | |
|---|---|
| Console | shell verbs, \`:call server.tool {}\`, or \`? plain English\` |
| Assistant | a conversation that drives the machine |
| Files | tree + editor; drag a file in to upload |
| Shell | a real interactive PTY |
| Agents | delegate work with narrowed capabilities |
| Ports | expose and preview services running in here |
| Processes | supervised jobs and the cron schedule |
| Sync | Tide: mark, diff and restore versions of a path |
| Secrets | stored encrypted; you get references, never values |
| Observability | load, disk, Kernel calls, and the full audit log |
| Settings | provider key, quota, servers, who can reach this machine |

\`⌘K\` searches every workspace, file, action and MCP tool at once.
\`help\` in the console prints the whole verb map.

Delete this file whenever you like — it is just a file.
`;

/**
 * Write first-run content into a Sandbox volume, but only when it is untouched.
 * Idempotent and non-destructive: an existing volume with anything in it is left
 * exactly as it is.
 *
 * @returns {boolean} whether anything was written
 */
export function seedVolume(sandbox) {
  const root = sandbox?.volume_path;
  if (!root) return false;
  try {
    fs.mkdirSync(root, { recursive: true });
    if (fs.readdirSync(root).length > 0) return false;
    fs.writeFileSync(path.join(root, "WELCOME.md"), WELCOME, "utf8");
    return true;
  } catch {
    // A volume we cannot seed is not a reason to fail creating the Sandbox.
    return false;
  }
}

export { WELCOME };
