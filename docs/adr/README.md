# Architecture Decision Records

Each ADR captures **one** decision that shapes SandboxOS: the context, the choice, and
the consequences. ADRs are append-only — to change a decision, write a new ADR that
supersedes the old one (and mark the old one `Superseded by ADR-XXXX`).

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-mcp-as-syscall-layer.md) | MCP is the system-call interface | Accepted |
| [0002](0002-tide-versioned-core-plus-live.md) | Tide = versioned core + live mirror | Accepted |
| [0003](0003-control-data-plane-split.md) | Control plane / data plane split | Accepted |

Write a new ADR when a choice is hard to reverse, affects multiple subsystems, or
resolves an item from [`../13-open-questions.md`](../13-open-questions.md).
