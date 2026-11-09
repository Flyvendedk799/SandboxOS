// test/task-release-verification.test.js
// Acceptance test suite and release verification invariants for SandboxOS.
// Validates:
// 1. Release check runner (scripts/release-check.mjs) behavior and exit status
// 2. Performance benchmark budgets in scripts/bench.mjs (12 wire and write constraints)
// 3. JSON reporting formatting (RELEASE_JSON=1, BENCH_JSON=1)
// 4. Release check stage definitions and host report generation

import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import { BUDGETS, runBench } from "../scripts/bench.mjs";

const runNode = (args, { env = {} } = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  p.stdout.on("data", (d) => { stdout += d.toString(); });
  p.stderr.on("data", (d) => { stderr += d.toString(); });
  p.on("close", (code) => {
    resolve({ code, stdout, stderr });
  });
});

test("scripts/bench.mjs measures and passes all 12 wire and write performance budgets", async () => {
  const { code, stdout, stderr } = await runNode(["scripts/bench.mjs"], {
    env: { BENCH_JSON: "1" },
  });
  assert.equal(code, 0, `bench.mjs failed with exit code ${code}\nstderr: ${stderr}\nstdout: ${stdout}`);
  assert.match(stdout, /every budget met/, "bench output must confirm every budget met");

  const jsonLine = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  assert.ok(jsonLine, "bench with BENCH_JSON=1 should produce JSON payload");
  const json = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
  assert.ok(Array.isArray(json.results), "json.results must be an array");
  assert.equal(json.results.length, 12, `expected 12 benchmark budgets, got ${json.results.length}`);

  for (const item of json.results) {
    assert.equal(item.ok, true, `budget exceeded for '${item.name}': value ${item.value} > budget ${item.budget} ${item.unit}`);
  }
});

test("scripts/release-check.mjs with --quick passes and outputs valid headline counts", async () => {
  const { code, stdout, stderr } = await runNode(["scripts/release-check.mjs", "--quick"]);
  assert.equal(code, 0, `release-check --quick failed: ${stderr}\n${stdout}`);
  assert.match(stdout, /the suite/, "must contain 'the suite'");
  assert.match(stdout, /the bench/, "must contain 'the bench'");
  assert.match(stdout, /skipped — --quick/, "must report browser/docker stages skipped in quick mode");
  assert.match(stdout, /green as far as it went/, "must report green status for executed stages");
});

test("scripts/release-check.mjs supports RELEASE_JSON=1 structured reporting", async () => {
  const { code, stdout, stderr } = await runNode(["scripts/release-check.mjs", "--quick"], {
    env: { RELEASE_JSON: "1" },
  });
  assert.equal(code, 0, `release-check with RELEASE_JSON=1 failed: ${stderr}\n${stdout}`);
  const data = JSON.parse(stdout);
  assert.equal(typeof data.at, "number");
  assert.equal(data.green, true);
  assert.ok(data.host, "host report must be present");
  assert.ok(data.host.platform, "host platform must be present");
  assert.ok(data.host.node, "host node version must be present");
  assert.ok(Array.isArray(data.stages), "stages must be an array");

  const suite = data.stages.find((s) => s.key === "suite");
  assert.ok(suite, "suite stage must be present in report");
  assert.equal(suite.code, 0);

  const bench = data.stages.find((s) => s.key === "bench");
  assert.ok(bench, "bench stage must be present in report");
  assert.equal(bench.code, 0);
});

test("BUDGETS canonical definitions match all 12 wire and write performance constraints", async () => {
  assert.equal(BUDGETS.length, 12, "expected 12 canonical performance budgets");
  for (const item of BUDGETS) {
    assert.ok(item.name, "budget item must have a name");
    assert.ok(typeof item.budget === "number" && item.budget >= 0, `budget threshold must be non-negative: ${item.name}`);
    assert.ok(item.unit, `budget item must have a unit: ${item.name}`);
  }

  const { results, failed } = await runBench({ silent: true });
  assert.equal(failed, 0, `in-process runBench reported ${failed} budget failure(s)`);
  assert.equal(results.length, 12, `expected 12 results from runBench, got ${results.length}`);
  for (const item of results) {
    assert.equal(item.ok, true, `budget exceeded for '${item.name}': value ${item.value} > budget ${item.budget} ${item.unit}`);
  }
});
