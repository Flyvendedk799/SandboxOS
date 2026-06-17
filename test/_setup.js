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
