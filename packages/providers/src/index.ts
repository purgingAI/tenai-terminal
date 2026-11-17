/**
 * Provider abstraction. Today: the Claude Code CLI on the owner's session. Later: the company API key
 * (Agent SDK), Codex, or a customer's own key — the server only ever talks to this interface.
 */

export interface ToolPolicy {
  /** Directory the agent works in; every file and command is confined to it. */
  worktree: string;
  /** Bash command prefixes the agent may run (git status, git diff, gradle test, ...). */
  allowedCommands: string[];
  /** Directory put first on the agent's PATH (TenAI's own `tenai` command). */
  binDir?: string;
  /** Extra environment for the agent's commands (the turn's key for the `tenai` command). */
  env?: Record<string, string>;
}

export interface TurnRequest {
  /** Provider's own session reference, to continue a conversation. */
  sessionRef?: string;
  prompt: string;
  systemAppend: string;
  tools: ToolPolicy;
  model: string;
  signal: AbortSignal;
}

/** Subscription window usage Claude reports on every turn (0..1 utilization, resetsAt in epoch seconds). */
export interface RateLimitInfo {
  status: string;
  fiveHour?: { utilization: number; resetsAt: number; status?: string };
  sevenDay?: { utilization: number; resetsAt: number; status?: string };
  overageStatus?: string;
}

/** What the agent authenticates with: a Claude subscription token (claude setup-token) or an Anthropic API key. */
export type Credential = { kind: "oauth"; secret: string } | { kind: "api_key"; secret: string };

export type AgentEvent =
  | { kind: "ratelimit"; info: RateLimitInfo }
  | { kind: "session"; sessionRef: string; model?: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; id: string; ok: boolean; text: string; denied?: boolean }
  | { kind: "usage"; model?: string; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number }
  | { kind: "done"; text: string }
  | { kind: "error"; message: string };

export interface AgentProvider {
  readonly id: "claude-cli" | "claude-agent-sdk" | "anthropic-api" | "codex";
  startTurn(req: TurnRequest): AsyncIterable<AgentEvent>;
  capabilities(): { resume: boolean; images: boolean; mcp: boolean; hooks: boolean };
}

export { ClaudeCliProvider, type ClaudeCliOptions, probeCredential } from "./claude-cli";
