/**
 * Server configuration, all from environment (systemd EnvironmentFile on the server).
 * Secrets are read from files so they never sit in the environment of anything the agent can see.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface RepoConfig {
  /** Short name users pick, e.g. "core-api". */
  name: string;
  /** Clone the server owns; worktrees are created from it. */
  path: string;
  /** Branch new work starts from and MRs target. */
  baseBranch: string;
  /** Extra Bash prefixes the agent may run in this repo (build/test only). */
  allowedCommands: string[];
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined) throw new Error(`Missing required env ${name}`);
    return fallback;
  }
  return v;
}

function readSecret(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim() || undefined;
}

const root = resolve(env("TENAI_HOME", join(process.cwd(), "data")));

export const config = {
  home: root,
  dbPath: join(root, "tenai.db"),
  worktreesDir: join(root, "worktrees"),
  attachmentsDir: join(root, "attachments"),
  agentHomesDir: join(root, "agent-home"),
  /** TenAI's `tenai` command for agents (put first on their PATH). */
  agentBinDir: resolve(import.meta.dir, "../../../ops/agent/bin"),
  host: env("TENAI_HOST", "127.0.0.1"),
  port: Number(env("TENAI_PORT", "8470")),
  publicUrl: env("TENAI_PUBLIC_URL", "http://127.0.0.1:8470"),
  allowedEmailDomain: env("TENAI_EMAIL_DOMAIN", "example.com"),
  /** Comma-separated emails that get the admin role on first login. */
  admins: env("TENAI_ADMINS", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  otpTtlMs: 10 * 60_000,
  otpMaxTries: 5,
  otpPerHourPerEmail: 5,
  sessionTtlMs: 12 * 3600_000,
  maxConcurrentTurns: Number(env("TENAI_MAX_CONCURRENT", "4")),
  turnTimeoutMs: Number(env("TENAI_TURN_TIMEOUT_MS", String(15 * 60_000))),
  defaultDailyTokenBudget: Number(env("TENAI_DAILY_TOKENS", "2000000")),
  model: env("TENAI_MODEL", "sonnet"),
  /** Overlap warnings compare against teammates' open MRs updated within this many days… */
  mrOverlapDays: Number(env("TENAI_MR_OVERLAP_DAYS", "2")),
  /** …and teammates' branches (without such an MR) pushed within this many days. Never your own. */
  branchOverlapDays: Number(env("TENAI_BRANCH_OVERLAP_DAYS", "1")),
  claudeBin: env("TENAI_CLAUDE_BIN", "claude"),
  /** Absolute hook command for servers where bun is not on PATH; default resolves bun from PATH. */
  hookCommand: process.env.TENAI_HOOK_CMD || undefined,
  /** OS user the agent runs as (server deploys); empty = same user as the server (laptop dev). */
  agentUser: process.env.TENAI_AGENT_USER || undefined,
  /** Claude Code OAuth token (claude setup-token). Absent → the CLI's own login is used (laptop dev only). */
  claudeToken: readSecret(process.env.TENAI_CLAUDE_TOKEN_FILE),
  /** Where an admin-switched Claude credential is stored (0600 JSON). Overrides TENAI_CLAUDE_TOKEN_FILE once set. */
  claudeStore: process.env.TENAI_CLAUDE_STORE || undefined,
  /** Teams Workflows webhook URL file (0600); written from the dashboard. */
  teamsWebhookFile: process.env.TENAI_TEAMS_WEBHOOK_FILE || undefined,
  /** GitLab bot token used only by the server for git push; never given to the agent. */
  gitlabToken: readSecret(process.env.TENAI_GITLAB_TOKEN_FILE),
  intentSidecarUrl: env("TENAI_INTENT_URL", "http://127.0.0.1:8471"),
  smtp: {
    host: process.env.TENAI_SMTP_HOST,
    port: Number(env("TENAI_SMTP_PORT", "587")),
    user: process.env.TENAI_SMTP_USER,
    pass: readSecret(process.env.TENAI_SMTP_PASS_FILE),
    from: env("TENAI_SMTP_FROM", "TenAI <no-reply@example.com>"),
  },
  /** Dev only: print OTPs to the server log instead of emailing them. */
  devPrintOtp: env("TENAI_DEV_PRINT_OTP", "0") === "1",
  repos: JSON.parse(env("TENAI_REPOS", "[]")) as RepoConfig[],
};

export type Config = typeof config;
