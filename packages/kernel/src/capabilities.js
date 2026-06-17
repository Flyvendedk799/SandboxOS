// Capability matching. The whole authorization model in one small, testable file.
//
// A capability grant is a pattern string over "<server>.<tool>":
//   "*"            → everything (the owner's grant on their own Sandbox)
//   "fs.*"         → every tool on the fs server
//   "proc.exec"    → exactly proc.exec
//
// Default-deny: if no held pattern matches, the call is forbidden. There is no
// ambient authority — see docs/09-security-model.md.

/** Does a single grant pattern authorize "<server>.<tool>"? */
export function patternMatches(pattern, server, tool) {
  if (pattern === "*") return true;
  const [pServer, pTool] = pattern.split(".");
  if (pServer !== server) return false;
  return pTool === "*" || pTool === tool;
}

/**
 * Check a set of held grant patterns against a target tool.
 * Returns the matching pattern (for the audit record) or null if denied.
 */
export function authorize(heldPatterns, server, tool) {
  for (const pattern of heldPatterns) {
    if (patternMatches(pattern, server, tool)) return pattern;
  }
  return null;
}

/**
 * Does a single held pattern fully cover (subsume) a requested pattern?
 *   "*"      covers everything
 *   "fs.*"   covers "fs.*" and "fs.read"
 *   "fs.read" covers only "fs.read"
 * Used to enforce attenuating delegation: you can only grant what you hold.
 */
export function patternCovers(held, requested) {
  if (held === "*") return true;
  if (held === requested) return true;
  const [hServer, hTool] = held.split(".");
  const [rServer] = requested.split(".");
  return hTool === "*" && hServer === rServer; // fs.* covers fs.<anything>
}

/** Can the holder of `heldPatterns` grant `requested`? (delegation only attenuates) */
export function canDelegate(heldPatterns, requested) {
  return heldPatterns.some((h) => patternCovers(h, requested));
}
