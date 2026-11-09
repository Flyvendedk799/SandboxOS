// Test isolation. Imported FIRST by every test file so these env vars are set
// before packages/config reads them. Points SANDBOXOS_HOME at a throwaway temp dir
// and forces the `local` Cell backend, so tests never touch the real control DB,
// the real ~/.sandboxos, or Docker. (The survhub lesson, encoded.)

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const home = path.join(os.tmpdir(), `sandboxos-test-${crypto.randomUUID().slice(0, 8)}`);
process.env.SANDBOXOS_HOME = home;
process.env.SANDBOXOS_CELL_BACKEND = "local";
process.env.SANDBOXOS_PASSWORD = "test";

export const TEST_HOME = home;

import fs from "node:fs";

/**
 * Read a module's own text for a test that asserts on it.
 *
 * Normalised to LF. Git checks this repository out with CRLF on Windows, so a
 * pattern written with \n — which is every pattern anyone writes — misses there
 * and nowhere else, and the failure reads as "Windows is broken" rather than as
 * "this test read the bytes without deciding what a line is".
 */
export const readSource = (url) => fs.readFileSync(url, "utf8").replace(/\r\n/g, "\n");
