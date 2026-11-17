/**
 * Claude Code CLI provider: one `claude -p --output-format stream-json` process per turn, continued with
 * --resume. The prompt goes on STDIN (the tool-list options are variadic and would swallow a positional
 * prompt). Every tool call is re-checked by the PreToolUse hook (pretooluse.ts) inside the worktree.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentProvider, Credential, RateLimitInfo, TurnRequest } from "./index";
import { ALWAYS_ALLOWED, EXTRA_ALLOWED } from "./policy";

export interface ClaudeCliOptions {
  bin: string;
  /** Read on every turn so an admin can switch accounts without a restart. Absent → the CLI's own login (laptop dev). */
  credential?: () => Credential | undefined;
  /** Isolated home for the agent process (no owner memory, CLAUDE.md, plugins). */
  agentHome?: string;
  /** Command that runs the hook, e.g. ["bun", "/srv/tenai/app/packages/providers/src/pretooluse.ts"]. */
  hookCommand?: string;
  /** Run the agent as this OS user via `sudo -n -u` (server deploys: the agent must not read the server's secrets). */
  runAs?: string;
}

const TOOLS = "Read,Grep,Glob,Edit,Write,Bash";
// Belt and braces: the hook enforces the real policy, these keep the CLI from even offering them.
const DISALLOWED = [
  "Bash(git push:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(ssh:*)", "Bash(scp:*)", "Bash(psql:*)",
  "Bash(mysql:*)", "Bash(mongo:*)", "Bash(mongosh:*)", "Bash(redis-cli:*)", "Bash(vault:*)",
  "Bash(aws:*)", "Bash(kubectl:*)", "Bash(sudo:*)", "WebFetch", "WebSearch",
];

const PASS_ENV = ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "PATH", "TENAI_AGENT_KEY", "TENAI_AGENT_URL", "HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "TENAI_WORKTREE", "TENAI_ALLOWED_COMMANDS",
  "GIT_TERMINAL_PROMPT", "LANG", "TERM"];

export class ClaudeCliProvider implements AgentProvider {
  readonly id = "claude-cli" as const;

  constructor(private opts: ClaudeCliOptions) {}

  capabilities() {
    return { resume: true, images: true, mcp: true, hooks: true };
  }

  async *startTurn(req: TurnRequest): AsyncIterable<AgentEvent> {
    const hookCmd = this.opts.hookCommand
      ?? `bun ${fileURLToPath(new URL("./pretooluse.ts", import.meta.url))}`;
    const settings = {
      includeCoAuthoredBy: false,
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCmd }] }] },
    };
    const allowed = ["Read", "Grep", "Glob", "Edit", "Write", ...[...ALWAYS_ALLOWED, ...EXTRA_ALLOWED, ...req.tools.allowedCommands].map((c) => `Bash(${c}:*)`)];
    const args = [
      "-p", "--output-format", "stream-json", "--verbose",
      "--model", req.model,
      "--setting-sources", "project",
      "--settings", JSON.stringify(settings),
      "--strict-mcp-config",
      "--tools", TOOLS,
      "--allowedTools", ...allowed,
      "--disallowedTools", ...DISALLOWED,
      "--append-system-prompt", req.systemAppend,
    ];
    if (req.sessionRef) args.push("--resume", req.sessionRef);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(ANTHROPIC_API_KEY|TENAI_.*TOKEN.*|.*SECRET.*|.*PASSWORD.*)$/i.test(k)) env[k] = v;
    }
    env.TENAI_WORKTREE = req.tools.worktree;
    env.TENAI_ALLOWED_COMMANDS = JSON.stringify(req.tools.allowedCommands);
    env.GIT_TERMINAL_PROMPT = "0";
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1"; // nothing the agent learns in one session is carried into another
    if (req.tools.binDir) env.PATH = `${req.tools.binDir}:${env.PATH ?? "/usr/bin:/bin"}`;
    Object.assign(env, req.tools.env ?? {});
    const cred = this.opts.credential?.();
    if (cred) {
      applyCredential(env, cred);
      if (this.opts.agentHome) {
        env.HOME = this.opts.agentHome;
        env.CLAUDE_CONFIG_DIR = this.opts.agentHome + "/.claude";
      }
    }

    // sudo resets the environment, so the keys the agent needs are passed through explicitly (sudoers grants SETENV).
    const [cmd, argv] = this.opts.runAs
      ? ["sudo", ["-n", "-u", this.opts.runAs, `--preserve-env=${PASS_ENV.filter((k) => k in env).join(",")}`, this.opts.bin, ...args]]
      : [this.opts.bin, args];
    const child = spawn(cmd, argv, { cwd: req.tools.worktree, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const kill = () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, 3000).unref();
    };
    if (req.signal.aborted) kill();
    req.signal.addEventListener("abort", kill, { once: true });

    // a CLI that dies early (bad credential, missing binary) must not crash the server with EPIPE/ENOENT
    child.stdin.on("error", () => undefined);
    child.on("error", (e) => { stderr += String(e); });
    child.stdin.end(req.prompt);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    const exited = new Promise<number>((res) => child.on("close", (code) => res(code ?? -1)));

    const toolNames = new Map<string, string>();
    let sawResult = false;
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "rate_limit_event" && ev.rate_limit_info) {
        yield { kind: "ratelimit", info: parseRateLimit(ev.rate_limit_info) };
      } else if (ev.type === "system" && ev.subtype === "init") {
        yield { kind: "session", sessionRef: ev.session_id, model: ev.model };
      } else if (ev.type === "assistant") {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text" && c.text) yield { kind: "text", text: c.text };
          if (c.type === "tool_use") {
            toolNames.set(c.id, c.name);
            yield { kind: "tool_use", id: c.id, name: c.name, input: c.input ?? {} };
          }
        }
      } else if (ev.type === "user") {
        for (const c of ev.message?.content ?? []) {
          if (c?.type !== "tool_result") continue;
          const text = typeof c.content === "string" ? c.content
            : Array.isArray(c.content) ? c.content.map((p: any) => p.text ?? "").join("\n") : "";
          const denied = /PreToolUse:\w+ hook error|TenAI policy/.test(text);
          yield { kind: "tool_result", id: c.tool_use_id, ok: !c.is_error && !denied, text, denied };
        }
      } else if (ev.type === "result") {
        sawResult = true;
        const u = ev.usage ?? {};
        yield {
          kind: "usage", model: ev.modelUsage ? Object.keys(ev.modelUsage)[0] : undefined,
          inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
          costUsd: ev.total_cost_usd ?? 0,
        };
        if (ev.is_error || ev.subtype !== "success") yield { kind: "error", message: String(ev.result ?? ev.subtype) };
        else yield { kind: "done", text: String(ev.result ?? "") };
      }
    }
    const code = await exited;
    req.signal.removeEventListener("abort", kill);
    if (req.signal.aborted) yield { kind: "error", message: "cancelled" };
    else if (!sawResult) yield { kind: "error", message: `agent exited (${code}) ${stderr.trim().slice(-300)}` };
  }
}

function applyCredential(env: Record<string, string>, cred: Credential): void {
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  if (cred.kind === "oauth") env.CLAUDE_CODE_OAUTH_TOKEN = cred.secret;
  else env.ANTHROPIC_API_KEY = cred.secret;
}

function parseRateLimit(r: any): RateLimitInfo {
  const w = r.unifiedWindows ?? {};
  const win = (x: any) => (x ? { utilization: Number(x.utilization ?? 0), resetsAt: Number(x.resetsAt ?? 0), status: x.status } : undefined);
  return { status: String(r.status ?? "unknown"), fiveHour: win(w.five_hour), sevenDay: win(w.seven_day), overageStatus: r.overageStatus };
}

/**
 * One tiny turn (Haiku, no tools, empty temp dir) to prove a credential works and read its usage windows.
 * Costs a fraction of a cent. Used before switching accounts and by the dashboard's "Check now".
 */
export async function probeCredential(bin: string, cred: Credential, agentHome?: string, timeoutMs = 90_000):
  Promise<{ ok: boolean; error?: string; rateLimit?: RateLimitInfo; costUsd?: number }> {
  const dir = mkdtempSync(join(tmpdir(), "tenai-probe-"));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: agentHome ?? dir };
  if (agentHome) env.CLAUDE_CONFIG_DIR = agentHome + "/.claude";
  applyCredential(env, cred);
  try {
    const child = spawn(bin, ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--setting-sources", "project",
      "--strict-mcp-config", "--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    let rateLimit: RateLimitInfo | undefined, ok = false, error = "", costUsd = 0, stderr = "";
    child.stdin.on("error", () => undefined);
    child.on("error", (e) => { stderr += String(e); });
    child.stdin.end("Reply with the single word: ok");
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-1000); });
    for await (const line of createInterface({ input: child.stdout })) {
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "rate_limit_event" && ev.rate_limit_info) rateLimit = parseRateLimit(ev.rate_limit_info);
      if (ev.type === "result") {
        costUsd = ev.total_cost_usd ?? 0;
        ok = !ev.is_error && ev.subtype === "success";
        if (!ok) error = String(ev.result ?? ev.subtype);
      }
    }
    clearTimeout(timer);
    if (!ok && !error) error = stderr.trim().split("\n").pop() || "the credential was not accepted";
    return { ok, error: ok ? undefined : error.slice(0, 300), rateLimit, costUsd };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
