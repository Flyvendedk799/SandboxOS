// The `agents` MCP server — Phase 3's core.
//
// An agent is a supervised task with its own scoped principal (minted via
// attenuating delegation from the spawner). Shell agents run a command in the
// Cell; the result is stored and retrievable. Every spawn/list/get/kill is
// authorized + audited through the Kernel like any other call.
//
// Lifecycle: queued → running → done | failed | killed
//
// On-behalf-of: the agent's principal_id appears in its audit entries; the
// spawned_by column (registry) and onBehalfOf (Kernel call header) tie the
// action back to the delegating human. A fleet of agents all trace to their
// operator.

import {
  createAgent, getAgent, listAgents, updateAgentState, mintMachineToken,
  runningAgentCount, runningAgentCountGlobal,
} from "../../control-db/src/registry.js";
import { runAI } from "./ai-runner.js";

const maxConcurrentAgents = () => Number(process.env.SANDBOXOS_MAX_AGENTS ?? 10);
// Backlog #13: a host-wide ceiling on concurrent agents, independent of the per-sandbox
// cap, so no single tenant's agent fleet can starve co-tenants on the shared host.
const maxConcurrentAgentsGlobal = () => Number(process.env.SANDBOXOS_MAX_AGENTS_GLOBAL ?? 100);

export function agentsServer(deps) {
  const { sandbox, cell } = deps;

  // In-process tracker for running tasks: agentId → { cancelled }
  const _live = new Map();

  async function _runShell(agentId, cmd) {
    updateAgentState(agentId, "running", { startedAt: Date.now() });
    const tracker = { cancelled: false };
    _live.set(agentId, tracker);
    try {
      const r = await cell.exec(cmd, { timeoutMs: 60_000 });
      if (tracker.cancelled) return; // killed — discard result
      updateAgentState(agentId, r.code === 0 ? "done" : "failed", {
        result: r.stdout, error: r.stderr || null, exitCode: r.code, finishedAt: Date.now(),
      });
    } catch (e) {
      if (!tracker.cancelled) {
        updateAgentState(agentId, "failed", { error: e.message, finishedAt: Date.now() });
      }
    } finally {
      _live.delete(agentId);
    }
  }

  return {
    name: "agents",
    tools: {
      spawn: {
        description: "Spawn a supervised agent with attenuated capabilities. kind='shell' runs a shell command; kind='ai' drives an LLM tool loop.",
        inputSchema: {
          type: "object",
          required: ["name", "patterns"],
          properties: {
            name: { type: "string", description: "Human-readable agent label." },
            patterns: { type: "array", items: { type: "string" }, description: "Capability patterns to grant (must be a subset of caller's)." },
            cmd: { type: "string", description: "Shell command (kind: shell)." },
            kind: { type: "string", enum: ["shell", "ai"], default: "shell" },
            prompt: { type: "string", description: "Initial user message (kind: ai)." },
            system: { type: "string", description: "System prompt (kind: ai)." },
          },
        },
        async handler(ctx, a) {
          const kind = a.kind ?? "shell";
          if (kind === "shell" && !a.cmd) throw new Error("cmd is required for shell agents");
          if (kind === "ai" && !a.prompt) throw new Error("prompt is required for ai agents");

          // Quota: cap concurrent agents per Sandbox.
          const running = runningAgentCount(sandbox.id);
          if (running >= maxConcurrentAgents()) throw new Error(`agent quota exceeded (max ${maxConcurrentAgents()} concurrent)`);
          // Quota: host-global ceiling (backlog #13) — protects co-tenants on the shared host.
          if (runningAgentCountGlobal() >= maxConcurrentAgentsGlobal())
            throw new Error(`host agent capacity reached (max ${maxConcurrentAgentsGlobal()} concurrent host-wide)`);

          const minted = mintMachineToken(ctx.principalId, sandbox.id, a.patterns, { label: a.name });
          const agent = createAgent(sandbox.id, {
            principalId: minted.principalId,
            spawnedBy: ctx.principalId,
            name: a.name,
            patterns: minted.patterns,
            cmd: a.cmd ?? "",
            kind,
            prompt: a.prompt,
            systemPrompt: a.system,
          });

          if (kind === "shell") {
            _runShell(agent.id, a.cmd).catch(() => {});
          } else {
            runAI(agent.id, {
              agentPrincipalId: minted.principalId,
              spawnedBy: ctx.principalId,
              patterns: minted.patterns,
              prompt: a.prompt,
              systemPrompt: a.system ?? "",
              kernel: ctx.kernel,
              sandbox,
            }).catch(() => {});
          }
          return { id: agent.id, state: "queued", kind, patterns: minted.patterns };
        },
      },

      list: {
        description: "List agents for this Sandbox.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
        async handler(_ctx, a) {
          const rows = listAgents(sandbox.id, a.limit ?? 50);
          return {
            agents: rows.map((r) => ({
              id: r.id, name: r.name, kind: r.kind, state: r.state,
              cmd: r.cmd, created_at: r.created_at, finished_at: r.finished_at,
            })),
          };
        },
      },

      get: {
        description: "Get the full detail and result of an agent.",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        async handler(_ctx, a) {
          const agent = getAgent(a.id);
          if (!agent || agent.sandbox_id !== sandbox.id) throw new Error(`no such agent: ${a.id}`);
          return {
            id: agent.id, name: agent.name, kind: agent.kind,
            state: agent.state, cmd: agent.cmd,
            patterns: JSON.parse(agent.patterns),
            spawned_by: agent.spawned_by,
            result: agent.result, error: agent.error, exit_code: agent.exit_code,
            created_at: agent.created_at, started_at: agent.started_at, finished_at: agent.finished_at,
          };
        },
      },

      kill: {
        description: "Terminate a running agent (marks it killed; shell process may complete naturally).",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        async handler(_ctx, a) {
          const agent = getAgent(a.id);
          if (!agent || agent.sandbox_id !== sandbox.id) throw new Error(`no such agent: ${a.id}`);
          if (agent.state === "done" || agent.state === "failed" || agent.state === "killed") {
            return { killed: false, reason: `already ${agent.state}` };
          }
          const tracker = _live.get(a.id);
          if (tracker) tracker.cancelled = true;
          updateAgentState(a.id, "killed", { finishedAt: Date.now() });
          return { killed: true };
        },
      },
    },
  };
}
