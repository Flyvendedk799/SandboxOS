// Phase 24: the CLI and the SDK.
//
// Everything the desktop can do, a script should be able to do. These tests
// drive a real Gateway through the client SDK and through the `sbx` binary, so
// the two surfaces are held to the same behaviour as the browser.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, mintMachineToken } from "../packages/control-db/src/registry.js";
import { _resetKernels } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";
import { SandboxClient, SandboxError } from "../packages/sdk/src/index.js";
import { stubProvider } from "./fixtures/stub-provider.js";

const SBX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/sbx-cli/src/sbx.js");

let owner, sandbox, server, base, sbx, token, cliConfig;

/** Run the sbx binary with its own config file, returning {code, stdout, stderr}. */
function runSbx(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SBX, ...args], {
      env: { ...process.env, SBX_CONFIG: cliConfig },
      timeout: 30_000,
    }, (err, stdout, stderr) => resolve({
      code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
    }));
  });
}

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  token = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "sdk-test" }).token;
  sbx = new SandboxClient({ url: base, slug: sandbox.slug, token });

  cliConfig = path.join(os.tmpdir(), `sbx-cli-${Date.now()}.json`);
  fs.writeFileSync(cliConfig, JSON.stringify({ url: base, slug: sandbox.slug, token }));
});
test.after(() => {
  try { fs.unlinkSync(cliConfig); } catch { /* already gone */ }
  server.close();
  _resetKernels();
  closeDb();
});

// ── The client SDK ───────────────────────────────────────────────────────────

test("the client identifies itself and reports what it may do", async () => {
  const me = await sbx.whoami();
  assert.equal(me.sandbox, sandbox.slug);
  assert.equal(me.kind, "machine", "a machine token authenticates as a machine principal");
  const caps = await sbx.capabilities();
  assert.deepEqual(caps.capabilities, ["*"]);
});

test("fs round-trips through the SDK", async () => {
  await sbx.fs.mkdir("p24/nested");
  await sbx.fs.write("p24/hello.txt", "hello sdk");
  assert.equal(await sbx.fs.read("p24/hello.txt"), "hello sdk");

  await sbx.fs.append("p24/hello.txt", "\nmore");
  assert.equal(await sbx.fs.read("p24/hello.txt"), "hello sdk\nmore");

  await sbx.fs.copy("p24/hello.txt", "p24/nested/copy.txt");
  await sbx.fs.move("p24/nested/copy.txt", "p24/nested/moved.txt");
  const listed = await sbx.fs.list("p24/nested");
  assert.deepEqual(listed.entries.map((e) => e.name), ["moved.txt"]);

  const found = await sbx.fs.search("hello", { path: "p24" });
  assert.ok(found.matches.length >= 1);

  await sbx.fs.remove("p24/nested", { recursive: true });
  assert.rejects(() => sbx.fs.read("p24/nested/moved.txt"), SandboxError);
});

test("SDK upload and download are binary-safe", async () => {
  const payload = new Uint8Array([0, 1, 2, 250, 251, 255, 0]);
  await sbx.fs.upload("p24/blob.bin", payload);
  const back = await sbx.fs.download("p24/blob.bin");
  assert.deepEqual(Array.from(back), Array.from(payload));
});

test("SDK supervises a background process and waits for it", async () => {
  const job = await sbx.proc.start("echo alpha; echo beta", { name: "sdk-job" });
  assert.equal(job.state, "running");
  const finished = await sbx.proc.wait(job.id, { intervalMs: 50, timeoutMs: 15_000 });
  assert.equal(finished.state, "exited");
  const logs = await sbx.proc.logs(job.id);
  assert.deepEqual(logs.logs.map((l) => l.text), ["alpha", "beta"]);
  await sbx.proc.forget(job.id);
});

test("SDK exposes a port and reports its public URL", async () => {
  await sbx.ports.expose(5599, "sdk");
  const ports = await sbx.ports.list({ check: false });
  assert.ok(ports.some((p) => p.port === 5599 && p.name === "sdk"));
  assert.equal(sbx.ports.url(5599), `${base}/${sandbox.slug}/p/5599/`);
  await sbx.ports.unexpose(5599);
});

test("SDK streams a command's output", async () => {
  const chunks = [];
  let code = null;
  for await (const ev of sbx.stream("echo one; echo two")) {
    if (ev.type === "stdout") chunks.push(ev.chunk);
    if (ev.type === "done") code = ev.code;
  }
  assert.equal(code, 0);
  assert.match(chunks.join(""), /one[\s\S]*two/);
});

test("SDK spawns an agent and waits for its result", async () => {
  const spawned = await sbx.agents.spawn("sdk-agent", { cmd: "echo from-the-agent" });
  const done = await sbx.agents.wait(spawned.id, { intervalMs: 100, timeoutMs: 20_000 });
  assert.equal(done.state, "done");
  assert.match(done.result, /from-the-agent/);
});

test("SDK stores a secret and uses it without ever seeing the value", async () => {
  await sbx.secrets.put("SDK_TOKEN", "super-secret");
  const listed = await sbx.secrets.list();
  const entry = listed.find((s) => s.name === "SDK_TOKEN");
  assert.equal(entry.ref, "secret://SDK_TOKEN");
  assert.ok(!JSON.stringify(listed).includes("super-secret"), "the value must never be listed");

  const r = await sbx.secrets.useInEnv(["SDK_TOKEN"], "echo $SDK_TOKEN");
  assert.equal(r.stdout.trim(), "super-secret", "the Cell sees it");
  await sbx.secrets.remove("SDK_TOKEN");
});

test("SDK errors carry the Kernel's reason, not just a status code", async () => {
  const narrow = new SandboxClient({
    url: base, slug: sandbox.slug,
    token: mintMachineToken(owner.id, sandbox.id, ["fs.read"], { label: "narrow" }).token,
  });
  await assert.rejects(() => narrow.proc.exec("echo nope"), (e) => {
    assert.ok(e instanceof SandboxError);
    assert.match(e.message, /denied: proc\.exec/);
    return true;
  });
});

test("SDK reads the tool catalogue and the metrics snapshot", async () => {
  const cat = await sbx.tools();
  assert.ok(cat.tools.some((t) => t.name === "fs.write"));
  const m = await sbx.metrics();
  assert.equal(m.sandbox.slug, sandbox.slug);
});

test("SDK drives the assistant and yields its events", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const stub = stubProvider([
    { tools: [{ name: "fs__write", args: { path: "p24/from-sdk.txt", content: "sdk" } }] },
    { text: "Done." },
  ]);
  process.env.SANDBOXOS_ANTHROPIC_URL = await stub.listen();
  try {
    const seen = [];
    for await (const ev of sbx.assistant.ask("write a file")) seen.push(ev.type);
    assert.ok(seen.includes("tool_call"));
    assert.ok(seen.includes("tool_result"));
    assert.ok(seen.includes("end"));
    assert.equal(await sbx.fs.read("p24/from-sdk.txt"), "sdk");
  } finally {
    stub.close();
    delete process.env.SANDBOXOS_ANTHROPIC_URL;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("a client with no url or slug fails immediately, not on first call", () => {
  assert.throws(() => new SandboxClient({ slug: "x" }), /url is required/);
  assert.throws(() => new SandboxClient({ url: base }), /slug is required/);
});

// ── The sbx CLI ──────────────────────────────────────────────────────────────

test("sbx help lists the command groups", async () => {
  const r = await runSbx(["help"]);
  assert.equal(r.code, 0);
  for (const group of ["files", "processes", "ports", "agents", "observe"]) {
    assert.match(r.stdout, new RegExp(group));
  }
});

test("sbx fs put / ls / cat / get round-trips a file", async () => {
  const local = path.join(os.tmpdir(), `sbx-upload-${Date.now()}.txt`);
  fs.writeFileSync(local, "from the cli\n");
  try {
    let r = await runSbx(["fs", "put", local, "p24/cli.txt"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /p24\/cli\.txt/);

    r = await runSbx(["fs", "cat", "p24/cli.txt"]);
    assert.equal(r.stdout, "from the cli\n");

    r = await runSbx(["fs", "ls", "p24"]);
    assert.match(r.stdout, /cli\.txt/);

    const back = path.join(os.tmpdir(), `sbx-download-${Date.now()}.txt`);
    r = await runSbx(["fs", "get", "p24/cli.txt", back]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(back, "utf8"), "from the cli\n");
    fs.unlinkSync(back);
  } finally { fs.unlinkSync(local); }
});

test("sbx fs tree and grep read the machine", async () => {
  let r = await runSbx(["fs", "tree", "p24"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /cli\.txt/);

  r = await runSbx(["fs", "grep", "from the cli", "p24"]);
  assert.match(r.stdout, /p24\/cli\.txt:1/);
});

test("sbx proc starts, tails and stops a background process", async () => {
  let r = await runSbx(["proc", "start", "sleep 30", "--name", "sleeper"]);
  assert.equal(r.code, 0, r.stderr);
  const id = r.stdout.trim().split(/\s+/)[0];
  assert.ok(id);

  r = await runSbx(["proc", "list"]);
  assert.match(r.stdout, /sleeper/);

  r = await runSbx(["proc", "stop", id]);
  assert.match(r.stdout, /stopped/);
});

test("sbx port expose / list / close", async () => {
  let r = await runSbx(["port", "expose", "5601", "cli"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`/${sandbox.slug}/p/5601/`));

  r = await runSbx(["port", "list"]);
  assert.match(r.stdout, /5601/);

  r = await runSbx(["port", "close", "5601"]);
  assert.match(r.stdout, /closed :5601/);
});

test("sbx metrics prints a readable snapshot", async () => {
  const r = await runSbx(["metrics"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /sandbox\s+tobias/);
  assert.match(r.stdout, /servers\s+.*fs/);
});

test("sbx access lists who can reach the machine", async () => {
  const r = await runSbx(["access", "list"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /machine/, "the token's own principal should be listed");
});

test("an unknown subcommand fails loudly rather than silently", async () => {
  const r = await runSbx(["fs", "frobnicate"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown fs subcommand/);
});

test("a bare word is still shorthand for `run`", async () => {
  const r = await runSbx(["ls"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /p24/);
});

test("sbx ask streams the assistant to the terminal", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const stub = stubProvider([
    { tools: [{ name: "fs__list", args: { path: "." } }] },
    { text: "There is a p24 directory." },
  ]);
  const url = await stub.listen();
  try {
    // The CLI talks to the Gateway in this process, so the stub URL must be set
    // here rather than in the child.
    process.env.SANDBOXOS_ANTHROPIC_URL = url;
    const r = await runSbx(["ask", "what is here?"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /There is a p24 directory\./);
    assert.match(r.stderr, /→ fs\.list/, "tool calls are traced on stderr");
    assert.match(r.stderr, /chat: cnv_/, "it tells you how to continue the conversation");
  } finally {
    stub.close();
    delete process.env.SANDBOXOS_ANTHROPIC_URL;
    delete process.env.ANTHROPIC_API_KEY;
  }
});
