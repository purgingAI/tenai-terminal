#!/usr/bin/env bun
/**
 * PreToolUse hook — the real policy, applied to every tool call before it runs:
 *  - files (Read/Edit/Write/Grep/Glob) must stay inside TENAI_WORKTREE;
 *  - Bash may only run a single command starting with an allowed prefix — no chaining, pipes,
 *    redirection, substitution, network, database, Vault or push.
 * A denial is returned to the agent as "TenAI policy: ..." and recorded by the server.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { checkBash, insideWorktree } from "./policy";

const input = JSON.parse(await Bun.stdin.text());
const worktree = process.env.TENAI_WORKTREE;
const allowed: string[] = JSON.parse(process.env.TENAI_ALLOWED_COMMANDS ?? "[]");

function deny(reason: string): never {
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `TenAI policy: ${reason}` },
  }));
  process.exit(0);
}

if (!worktree) deny("no worktree configured");
const root = realpathSync(worktree!);
const tool: string = input.tool_name;
const ti = input.tool_input ?? {};

if (tool === "Bash") {
  const verdict = checkBash(String(ti.command ?? ""), allowed, root);
  if (!verdict.ok) deny(verdict.reason!);
} else if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const p = String(ti.file_path ?? ti.notebook_path ?? "");
  if (!insideWorktree(root, p)) deny(`${tool} is limited to this session's worktree`);
} else if (["Grep", "Glob"].includes(tool)) {
  const p = String(ti.path ?? root);
  if (!insideWorktree(root, isAbsolute(p) ? p : resolve(root, p))) deny(`${tool} is limited to this session's worktree`);
} else {
  deny(`${tool} is not available in TenAI`);
}
process.exit(0);
