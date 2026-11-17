/** Pure policy checks used by the PreToolUse hook (kept separate so they can be unit-tested). */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Safe in every repo; the CLI is told to allow these too, the hook still checks each call. */
export const ALWAYS_ALLOWED = ["git status", "git diff", "git log", "git show", "git blame", "git grep", "git ls-files", "git branch --show-current", "git rev-parse", "git add", "git commit", "git restore", "git checkout --", "git stash", "ls", "pwd"];
/** Patterns the CLI is told to allow on top (the hook checks the real rule): git in one repo of a multi-repo session, TenAI's own command. */
export const EXTRA_ALLOWED = ["git -C", "tenai"];

const FORBIDDEN = [
  /\bgit\s+(push|remote|config|fetch|pull|clone|submodule|credential|filter-branch|reset\s+--hard\s+origin)\b/i,
  // programs: only a command's first word can run them (one command, no chaining) — "…/service/Foo.java" is fine
  /^(curl|wget|nc|ncat|telnet|ssh|scp|sftp|rsync|ftp)\b/i,
  /^(psql|mysql|mongo|mongosh|redis-cli|sqlite3|clickhouse-client|cqlsh)\b/i,
  /^(vault|aws|gcloud|az|kubectl|helm|terraform|docker|podman|systemctl|service|sudo|su)\b/i,
  /\b(env|printenv|export|set)\b\s*$/i,
  /(~|\$HOME|\/home\/|\/root\/|\/etc\/|\/srv\/tenai\/secrets|\.ssh|\.aws|\.claude|\.credentials|\.env\b)/i,
  /\bgit\s+commit\b.*--(no-verify|author|amend)/i,
];

// Shell control characters: chaining, pipes, redirection, substitution, background, globbing into $().
const META = /[;&|`<>]|\$\(|\$\{|\n|\r/;

export function checkBash(command: string, allowedPrefixes: string[], root?: string): { ok: boolean; reason?: string } {
  let cmd = command.trim();
  if (!cmd) return { ok: false, reason: "empty command" };
  if (META.test(cmd)) return { ok: false, reason: "one plain command only — no chaining, pipes, redirection or substitution" };
  // "git -C <repo> log …" is "git log …" run inside one repo of the session; the directory must be inside it
  const gc = cmd.match(/^git\s+-C\s+("[^"]*"|'[^']*'|\S+)\s+(.*)$/);
  if (gc) {
    const dir = gc[1].replace(/^["']|["']$/g, "");
    if (!root || !insideWorktree(root, isAbsolute(dir) ? dir : resolve(root, dir))) return { ok: false, reason: "git -C must point at a repository inside this session" };
    cmd = `git ${gc[2]}`;
  }
  // TenAI's own command (branch switching, status) — it talks to the TenAI server, nothing else
  if (/^tenai(\s|$)/.test(cmd)) {
    return /^tenai(\s+[\w.\/@:+-]+)*$/.test(cmd) ? { ok: true } : { ok: false, reason: "tenai takes plain words only" };
  }
  for (const re of FORBIDDEN) if (re.test(cmd)) return { ok: false, reason: `command not allowed: ${cmd.split(/\s+/).slice(0, 3).join(" ")}` };
  const prefixes = [...ALWAYS_ALLOWED, ...allowedPrefixes];
  const okPrefix = prefixes.some((p) => cmd === p || cmd.startsWith(p + " "));
  if (!okPrefix) return { ok: false, reason: `only git and this repo's build/test commands are allowed (${allowedPrefixes.join(", ") || "none configured"})` };
  return { ok: true };
}

/** True when `path` resolves inside `root` (symlinks resolved, non-existent files checked via their parent). */
export function insideWorktree(root: string, path: string): boolean {
  if (!path) return false;
  const abs = isAbsolute(path) ? path : resolve(root, path);
  let real = abs;
  let probe = abs;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    real = resolve(realpathSync(probe), relative(probe, abs));
  } catch {
    return false;
  }
  const rel = relative(root, real);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
