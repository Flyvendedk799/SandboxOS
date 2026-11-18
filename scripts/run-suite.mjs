// Keep wall-clock release budgets off the CPUs used by parallel test workers.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const options = process.argv.slice(2);
const releaseTest = "test/task-release-verification.test.js";
const run = files => {
  const result = spawnSync(process.execPath, ["--test", "--no-warnings", ...options, ...files], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

// Explicit CLI arguments use Node's normal option and discovery rules, as do
// workspaces with no release benchmark (such as the release-check fixture).
if (options.length || !fs.existsSync(releaseTest)) {
  process.exitCode = run([]);
} else {
  const functional = fs.globSync("test/**/*.{js,cjs,mjs,ts,cts,mts}", {
    exclude: file => path.basename(file) === "node_modules",
  }).filter(file => path.normalize(file) !== path.normalize(releaseTest)).sort();
  const functionalCode = run(functional);
  const releaseCode = run([releaseTest]);
  process.exitCode = functionalCode || releaseCode;
}
