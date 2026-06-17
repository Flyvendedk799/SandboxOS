// SandboxOS Marketplace Server SDK.
//
// The only contract a third-party server must fulfill:
//   1. Export a factory (the return value of createMcpServer) as the default export.
//   2. The factory signature is (deps) => { name, tools } — matching the built-in pattern.
//
// deps carries { cell, sandbox, kernel, manifest } so advanced servers can reach the
// host Cell, but most servers only need their own tools map.

/**
 * @param {{ name: string, tools: Record<string, { description: string, inputSchema: object, handler: Function }> }} def
 * @returns {(deps: object) => { name: string, tools: object }}
 */
export function createMcpServer(def) {
  return (_deps) => ({ name: def.name, tools: def.tools });
}
