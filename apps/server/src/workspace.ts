/**
 * Git work for sessions: a worktree per session on its own tenai/<user>/<slug> branch, and shipping —
 * the server (never the agent) squashes the session's work into one commit authored by the engineer,
 * pushes only that branch and opens a merge request to the base branch via GitLab push options.
 */
import { mkdirSync, existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoConfig } from "./config";

export class GitError extends Error {}

const BRANCH_RE = /^tenai\/[a-z0-9.-]+\/[a-z0-9-]+$/;
/** Branches TenAI never pushes to directly — they only change through a reviewed merge request. */
const PROTECTED = /^(env\/|main$|master$|develop$|release|prod|production|hotfix\/prod|uat$|staging$)/i;
const TARGET_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,200}(?<![./])$/;

/** Can people work directly on this existing branch? (Not protected, not the repo's base, a sane ref name.) */
export function targetAllowed(repo: RepoConfig, branch: string): string | null {
  if (!TARGET_RE.test(branch)) return `“${branch}” is not a valid branch name`;
  if (branch === repo.baseBranch || PROTECTED.test(branch)) return `${branch} is protected — changes to it go through a merge request (start a normal session and /ship)`;
  return null;
}

export interface GitRunner {
  (args: string[], cwd: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Runs git with an HTTP auth header when a credential is configured; it never touches the worktree.
 * The credential is a bot token, or "user:password" for the pilot. It goes in through GIT_CONFIG_* env
 * (readable only by this OS user), never as a `-c` argument, which every user on a shared box sees in `ps`.
 */
export function makeGit(token?: string): GitRunner {
  const auth: Record<string, string> = token
    ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(token.includes(":") ? token : "oauth2:" + token).toString("base64")}` }
    : {};
  return async (args, cwd, extra) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...auth, ...extra },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  };
}

export function slugify(text: string, max = 40): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
  return s || "change";
}

export function branchOn(email: string, target: string, sessionId: string): string {
  const user = email.split("@")[0].toLowerCase().replace(/[^a-z0-9.]+/g, "-");
  return `tenai/${user}/on-${slugify(target, 28)}-${sessionId.slice(0, 6)}`;
}

export function branchFor(email: string, title: string, sessionId: string): string {
  const user = email.split("@")[0].toLowerCase().replace(/[^a-z0-9.]+/g, "-");
  return `tenai/${user}/${slugify(title, 32)}-${sessionId.slice(0, 6)}`;
}

export interface MyBranch {
  repo: string; name: string; updated: string; ahead: number;
  commits: Array<{ sha: string; date: string; subject: string }>; files: string[]; related: string[];
}

/** One change block of a file's diff, applyable on its own. */
export interface Hunk { id: string; file: string; header: string; lines: string[]; adds: number; dels: number; patch: string; newFile: boolean }

/** Unified diff → hunks. Binary files (no @@ blocks) are skipped: they can't be reviewed line by line. */
export function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  for (const block of diff.split(/^(?=diff --git )/m)) {
    if (!block.startsWith("diff --git ")) continue;
    const at = block.search(/^@@ /m);
    if (at < 0) continue;
    const head = block.slice(0, at);
    const file = (head.match(/^\+\+\+ b\/(.+)$/m) ?? head.match(/^--- a\/(.+)$/m))?.[1] ?? "?";
    const newFile = /^new file mode/m.test(head);
    for (const part of block.slice(at).split(/^(?=@@ )/m)) {
      if (!part.startsWith("@@ ")) continue;
      const lines = part.replace(/\n$/, "").split("\n");
      const body = lines.slice(1);
      out.push({
        id: createHash("sha1").update(file + "\0" + body.join("\n")).digest("hex").slice(0, 12), file, header: lines[0], lines: body, newFile,
        adds: body.filter((l) => l.startsWith("+")).length, dels: body.filter((l) => l.startsWith("-")).length,
        patch: head + part + (part.endsWith("\n") ? "" : "\n"),
      });
    }
  }
  return out;
}

export interface RecentBranch { name: string; updated: number; email: string; author: string; files: string[] }

export interface PortResult { branch: string; ok: boolean; sha?: string; already?: boolean; error?: string }

export class Workspace {
  constructor(private git: GitRunner, private worktreesDir: string) {
    mkdirSync(worktreesDir, { recursive: true });
  }

  private async must(args: string[], cwd: string): Promise<string> {
    const r = await this.git(args, cwd);
    if (r.code !== 0) throw new GitError(`git ${args[0]} failed: ${r.stderr.trim().split("\n").slice(-2).join(" ")}`);
    return r.stdout;
  }

  /** The session's folder (one worktree per repo inside it). */
  sessionDir(sessionId: string): string {
    return join(this.worktreesDir, sessionId);
  }

  /** Fresh worktree from the latest base branch (at `at`, default the session folder itself — older single-repo sessions). */
  async create(repo: RepoConfig, sessionId: string, branch: string, at?: string): Promise<string> {
    if (!BRANCH_RE.test(branch)) throw new GitError(`invalid branch name ${branch}`);
    const dir = at ?? join(this.worktreesDir, sessionId);
    if (existsSync(dir)) return dir;
    await this.must(["fetch", "--quiet", "origin", repo.baseBranch], repo.path);
    await this.must(["worktree", "add", "-q", "-b", branch, dir, `origin/${repo.baseBranch}`], repo.path);
    return dir;
  }

  private branchCache = new Map<string, { at: number; names: string[] }>();

  /** Remote branch names (cached a minute). The server clones only the base branch, so ask the remote. */
  async branches(repo: RepoConfig, filter = ""): Promise<string[]> {
    let hit = this.branchCache.get(repo.name);
    if (!hit || Date.now() - hit.at > 60_000) {
      const out = await this.must(["ls-remote", "--heads", "origin"], repo.path);
      hit = { at: Date.now(), names: out.split("\n").map((l) => l.split("refs/heads/")[1]).filter(Boolean).sort() };
      this.branchCache.set(repo.name, hit);
    }
    const f = filter.toLowerCase();
    return hit.names.filter((n) => !f || n.toLowerCase().includes(f));
  }

  /** Worktree on top of an existing remote branch; the session's own local branch tracks it. */
  async createOn(repo: RepoConfig, sessionId: string, localBranch: string, target: string, at?: string): Promise<string> {
    if (!BRANCH_RE.test(localBranch)) throw new GitError(`invalid branch name ${localBranch}`);
    const why = targetAllowed(repo, target);
    if (why) throw new GitError(why);
    const dir = at ?? join(this.worktreesDir, sessionId);
    if (existsSync(dir)) return dir;
    const fetched = await this.git(["fetch", "--quiet", "origin", `+refs/heads/${target}:refs/remotes/origin/${target}`], repo.path);
    if (fetched.code !== 0) throw new GitError(`No branch “${target}” in ${repo.name}. Use /branches to search.`);
    await this.must(["worktree", "add", "-q", "-b", localBranch, dir, `origin/${target}`], repo.path);
    return dir;
  }

  /**
   * Push the session's work straight onto the chosen branch as one commit by the engineer. Never forces:
   * if someone pushed meanwhile, rebase onto it first; on a conflict, stop and say so.
   */
  async shipToBranch(opts: {
    repo: RepoConfig; dir: string; target: string; title: string; authorName: string; authorEmail: string;
  }): Promise<{ sha: string; files: string[]; diffstat: string }> {
    const { repo, dir, target } = opts;
    const why = targetAllowed(repo, target);
    if (why) throw new GitError(why);
    const files = await this.changedFiles(dir, target);
    if (!files.length) throw new GitError("nothing to ship: no changes in this session");
    await this.must(["add", "-A", "--", ".", ":!.tenai"], dir);
    await this.must(["reset", "--soft", `origin/${target}`], dir);
    const message = opts.title.trim().split("\n")[0].slice(0, 120);
    const ident = ["-c", "user.name=TenAI", "-c", "user.email=tenai-bot@example.com"];
    await this.must([...ident, "commit", "-q", "--no-verify", `--author=${opts.authorName} <${opts.authorEmail}>`, "-m", message], dir);
    const fetched = await this.git(["fetch", "--quiet", "origin", `+refs/heads/${target}:refs/remotes/origin/${target}`], dir);
    if (fetched.code !== 0) throw new GitError(`could not fetch ${target}: ${fetched.stderr.trim().split("\n").pop()}`);
    const behind = (await this.must(["rev-list", "--count", `HEAD..origin/${target}`], dir)).trim();
    if (behind !== "0") {
      const rb = await this.git([...ident, "rebase", `origin/${target}`], dir);
      if (rb.code !== 0) {
        await this.git(["rebase", "--abort"], dir);
        throw new GitError(`Someone pushed to ${target} since you started and it conflicts with your change. Nothing was pushed — ask the agent to re-apply the change on the latest ${target} (start again with /branch ${target}).`);
      }
    }
    const sha = (await this.must(["rev-parse", "HEAD"], dir)).trim();
    const diffstat = (await this.must(["diff", "--shortstat", "HEAD~1", "HEAD"], dir)).trim();
    const push = await this.git(["push", "--porcelain", "origin", `HEAD:refs/heads/${target}`], dir);
    if (push.code !== 0) throw new GitError(`push to ${target} failed: ${push.stderr.trim().split("\n").slice(-3).join(" ")}`);
    await this.git(["fetch", "--quiet", "origin", `+refs/heads/${target}:refs/remotes/origin/${target}`], dir);
    return { sha, files, diffstat };
  }

  private scanning = new Map<string, Promise<void>>();
  private scannedAt = new Map<string, number>();

  /**
   * Every remote branch as refs/remotes/scan/<name> (one fetch, at most every 5 minutes). Worktrees share refs,
   * so agents can compare branches (`git diff origin/env/dev...scan/feature/x`). A failed fetch keeps the old refs.
   */
  async scan(repo: RepoConfig, maxAgeMs = 5 * 60_000): Promise<void> {
    if (Date.now() - (this.scannedAt.get(repo.name) ?? 0) < maxAgeMs) return;
    let p = this.scanning.get(repo.name);
    if (!p) {
      p = this.git(["fetch", "-q", "--prune", "origin", "+refs/heads/*:refs/remotes/scan/*"], repo.path)
        .then((r) => { if (r.code === 0) this.scannedAt.set(repo.name, Date.now()); })
        .finally(() => this.scanning.delete(repo.name));
      this.scanning.set(repo.name, p);
    }
    await p;
  }

  /**
   * Branches carrying this person's commits that aren't in the base yet (last `days` days), newest first,
   * with what they changed. Branches carrying the same commit message as a *different* commit are "related": the
   * change was copied (a feature branch and its port to another base), so a fix usually belongs on all of them.
   * Branches merely stacked on each other share the very same commits and are not linked.
   */
  async mine(repo: RepoConfig, email: string, days = 120): Promise<MyBranch[]> {
    await this.scan(repo);
    const since = Math.floor(Date.now() / 1000) - days * 86_400;
    const refs = (await this.must(["for-each-ref", "refs/remotes/scan", "--sort=-committerdate", "--format=%(refname:strip=3)%09%(committerdate:unix)"], repo.path))
      .split("\n").map((l) => l.split("\t")).filter(([n, t]) => n && Number(t) >= since && n !== repo.baseBranch && !PROTECTED.test(n) && n !== "HEAD");
    const author = `--author=<${email.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&")}>`;
    const out: MyBranch[] = [];
    for (const [name, t] of refs.slice(0, 400)) {
      const log = (await this.must(["log", "--no-merges", "-i", author, "-n", "30", "--date=short", "--format=%h%x1f%ad%x1f%s", `origin/${repo.baseBranch}..scan/${name}`], repo.path)).trim();
      if (!log) continue;
      const commits = log.split("\n").map((l) => { const [sha, date, subject] = l.split("\x1f"); return { sha, date, subject }; });
      const ahead = Number((await this.must(["rev-list", "--count", `origin/${repo.baseBranch}..scan/${name}`], repo.path)).trim());
      const files = (await this.must(["diff", "--name-only", `origin/${repo.baseBranch}...scan/${name}`], repo.path)).split("\n").filter(Boolean);
      out.push({ repo: repo.name, name, updated: new Date(Number(t) * 1000).toISOString().slice(0, 10), ahead, commits, files, related: [] });
    }
    for (const b of out) {
      const bySubject = new Map(b.commits.map((c) => [c.subject, c.sha]));
      b.related = out.filter((o) => o !== b && o.commits.some((c) => bySubject.has(c.subject) && bySubject.get(c.subject) !== c.sha)).map((o) => o.name);
    }
    return out;
  }

  private recentCache = new Map<string, { at: number; rows: RecentBranch[] }>();

  /**
   * Branches pushed in the last `withinMs` (not protected, not the base) and the files each changes against the base,
   * with the tip commit's author — for "someone else is changing this file on their branch" warnings. Cached 5 minutes;
   * `cached` returns what is there without waiting (empty on a cold cache, which then warms in the background).
   */
  async recentBranches(repo: RepoConfig, withinMs: number): Promise<RecentBranch[]> {
    const hit = this.recentCache.get(repo.name);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.rows;
    await this.scan(repo);
    const since = Math.floor((Date.now() - withinMs) / 1000);
    const refs = (await this.must(["for-each-ref", "refs/remotes/scan", "--format=%(refname:strip=3)%09%(committerdate:unix)%09%(authoremail)%09%(authorname)"], repo.path))
      .split("\n").map((l) => l.split("\t")).filter(([n, t]) => n && n !== "HEAD" && Number(t) >= since && n !== repo.baseBranch && !PROTECTED.test(n));
    const rows: RecentBranch[] = [];
    for (const [name, t, mail, author] of refs.slice(0, 200)) {
      const files = (await this.git(["diff", "--name-only", `origin/${repo.baseBranch}...scan/${name}`], repo.path)).stdout.split("\n").filter(Boolean);
      if (files.length && files.length < 3000) rows.push({ name, updated: Number(t) * 1000, email: mail.replace(/[<>]/g, "").toLowerCase(), author, files });
    }
    this.recentCache.set(repo.name, { at: Date.now(), rows });
    return rows;
  }

  cachedRecent(repo: RepoConfig, withinMs: number): RecentBranch[] {
    const hit = this.recentCache.get(repo.name);
    if (!hit || Date.now() - hit.at >= 5 * 60_000) void this.recentBranches(repo, withinMs).catch(() => undefined);
    return hit?.rows ?? [];
  }

  /**
   * Copy a shipped commit onto another branch: cherry-pick (the engineer stays the author) in a throwaway
   * worktree, then push without force. If someone pushed meanwhile, rebase once and retry; a conflict pushes nothing.
   */
  async portTo(repo: RepoConfig, sha: string, target: string, tag: string): Promise<PortResult> {
    const why = targetAllowed(repo, target);
    if (why) return { branch: target, ok: false, error: why };
    const dir = join(this.worktreesDir, `${tag}-port-${slugify(target, 30)}`);
    const ref = `+refs/heads/${target}:refs/remotes/origin/${target}`;
    const ident = ["-c", "user.name=TenAI", "-c", "user.email=tenai-bot@example.com"];
    if ((await this.git(["fetch", "--quiet", "origin", ref], repo.path)).code !== 0) return { branch: target, ok: false, error: `no branch ${target}` };
    if (existsSync(dir)) await this.git(["worktree", "remove", "--force", dir], repo.path);
    try {
      await this.must(["worktree", "add", "-q", "--detach", dir, `origin/${target}`], repo.path);
      const cp = await this.git([...ident, "cherry-pick", sha], dir);
      if (cp.code !== 0) {
        const empty = /empty|nothing to commit/i.test(cp.stderr + cp.stdout);
        await this.git(["cherry-pick", "--abort"], dir);
        return empty ? { branch: target, ok: true, already: true } : { branch: target, ok: false, error: `conflicts with what is on ${target} — nothing was pushed there` };
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const push = await this.git(["push", "--porcelain", "origin", `HEAD:refs/heads/${target}`], dir);
        if (push.code === 0) {
          const out = (await this.must(["rev-parse", "HEAD"], dir)).trim();
          await this.git(["fetch", "--quiet", "origin", ref], repo.path);
          return { branch: target, ok: true, sha: out };
        }
        if (attempt === 1 || !/rejected|non-fast-forward|fetch first/i.test(push.stderr + push.stdout)) {
          return { branch: target, ok: false, error: `push failed: ${push.stderr.trim().split("\n").slice(-2).join(" ")}` };
        }
        await this.must(["fetch", "--quiet", "origin", ref], dir);
        const rb = await this.git([...ident, "rebase", `origin/${target}`], dir);
        if (rb.code !== 0) {
          await this.git(["rebase", "--abort"], dir);
          return { branch: target, ok: false, error: `someone pushed to ${target} meanwhile and it conflicts — nothing was pushed there` };
        }
      }
      return { branch: target, ok: false, error: "push failed" };
    } catch (e) {
      return { branch: target, ok: false, error: (e as Error).message };
    } finally {
      await this.git(["worktree", "remove", "--force", dir], repo.path);
    }
  }

  async remove(repo: RepoConfig, dir: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", dir], repo.path);
  }

  /**
   * Snapshot of everything in a worktree — tracked edits AND new files — as a commit, without touching the real
   * index, HEAD or the files (built in a throwaway index). Kept alive by a ref, so `restore` can bring it back.
   */
  async snapshot(dir: string, ref: string): Promise<string> {
    const idx = join(tmpdir(), `tenai-idx-${randomBytes(6).toString("hex")}`);
    const env = { GIT_INDEX_FILE: idx };
    try {
      const head = await this.git(["rev-parse", "--verify", "-q", "HEAD"], dir);
      if (head.code === 0) await this.mustEnv(["read-tree", "HEAD"], dir, env);
      await this.mustEnv(["add", "-A", "--", ".", ":!.tenai"], dir, env);
      const tree = (await this.mustEnv(["write-tree"], dir, env)).trim();
      const commit = (await this.mustEnv(["commit-tree", tree, "-m", "tenai checkpoint"], dir,
        { ...env, GIT_AUTHOR_NAME: "TenAI", GIT_AUTHOR_EMAIL: "tenai-bot@example.com", GIT_COMMITTER_NAME: "TenAI", GIT_COMMITTER_EMAIL: "tenai-bot@example.com" })).trim();
      await this.must(["update-ref", ref, commit], dir);
      return commit;
    } finally {
      try { unlinkSync(idx); } catch { /* never created */ }
    }
  }

  /**
   * Put a worktree's files back exactly as in a snapshot (files added since are removed). HEAD and the real index are
   * left alone, so the session's branch is unchanged — only the working files move. Returns the files that changed.
   */
  async restore(dir: string, commit: string, redoRef: string): Promise<string[]> {
    const now = await this.snapshot(dir, redoRef);
    const changed = (await this.must(["diff", "--name-only", commit, now], dir)).split("\n").filter(Boolean);
    if (!changed.length) return [];
    const added = (await this.must(["diff", "--name-only", "--diff-filter=A", commit, now], dir)).split("\n").filter(Boolean);
    for (const f of added) rmSync(join(dir, f), { force: true });
    const idx = join(tmpdir(), `tenai-idx-${randomBytes(6).toString("hex")}`);
    try {
      await this.mustEnv(["read-tree", commit], dir, { GIT_INDEX_FILE: idx });
      await this.mustEnv(["checkout-index", "-a", "-f"], dir, { GIT_INDEX_FILE: idx });
    } finally {
      try { unlinkSync(idx); } catch { /* never created */ }
    }
    // the real index may still hold content staged before; line it up with HEAD so diffs read cleanly
    await this.git(["reset", "-q"], dir);
    return changed;
  }

  /** The session's changes in this worktree against `base`, cut into hunks (new files included). */
  async hunks(dir: string, base: string): Promise<Hunk[]> {
    await this.must(["add", "-A", "--", ".", ":!.tenai"], dir);
    const diff = await this.must(["diff", "--no-color", "--no-ext-diff", `origin/${base}`], dir);
    return parseHunks(diff);
  }

  /** Throw away one hunk from the working files (and the index), leaving every other change as it is. */
  async revertHunk(dir: string, base: string, id: string): Promise<Hunk> {
    const h = (await this.hunks(dir, base)).find((x) => x.id === id);
    if (!h) throw new GitError("That change is no longer there (the files changed since). Run the review again.");
    const patch = join(tmpdir(), `tenai-hunk-${randomBytes(6).toString("hex")}.patch`);
    writeFileSync(patch, h.patch);
    try {
      await this.must(["apply", "-R", "--index", "--whitespace=nowarn", patch], dir);
    } finally {
      try { unlinkSync(patch); } catch { /* gone */ }
    }
    return h;
  }

  /** Forget a session's checkpoint refs in a repo (their commits are then garbage-collected by git as usual). */
  async dropRefs(repo: RepoConfig, sessionId: string): Promise<void> {
    const refs = (await this.must(["for-each-ref", "--format=%(refname)", `refs/tenai/ckpt/${sessionId}`, `refs/tenai/now/${sessionId}`, `refs/tenai/redo/${sessionId}`], repo.path)).split("\n").filter(Boolean);
    for (const r of refs) await this.git(["update-ref", "-d", r], repo.path);
  }

  /** Tree id of a commit — or, with `live`, of the worktree's files right now (snapshotted to `ref`). */
  async treeOf(dir: string, commitOrRef: string, live = false): Promise<string> {
    const c = live ? await this.snapshot(dir, commitOrRef) : commitOrRef;
    return (await this.must(["rev-parse", `${c}^{tree}`], dir)).trim();
  }

  /** Whole-word search in a worktree's tracked files: [{file, line, text}] (at most `max`). */
  async grep(dir: string, word: string, globs: string[], max = 20): Promise<Array<{ file: string; line: number; text: string }>> {
    const r = await this.git(["grep", "-n", "-I", "-w", "-F", "-e", word, "--", ...globs], dir);
    return r.stdout.split("\n").filter(Boolean).slice(0, max).map((l) => {
      const m = l.match(/^([^:]+):(\d+):(.*)$/);
      return m ? { file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 160) } : { file: l, line: 0, text: "" };
    });
  }

  /** The session's changes against `base` with no context lines (what was removed/added, per file). */
  async rawDiff(dir: string, base: string): Promise<string> {
    await this.must(["add", "-A", "--", ".", ":!.tenai"], dir);
    return this.must(["diff", "--no-color", "--no-ext-diff", "-U0", `origin/${base}`], dir);
  }

  private async mustEnv(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
    const r = await this.git(args, cwd, env);
    if (r.code !== 0) throw new GitError(`git ${args[0]} failed: ${r.stderr.trim().split("\n").slice(-2).join(" ")}`);
    return r.stdout;
  }

  /** Move a worktree to another folder (git keeps tracking it; uncommitted edits move with it). */
  async move(repo: RepoConfig, from: string, to: string): Promise<void> {
    await this.must(["worktree", "move", from, to], repo.path);
  }

  /** Drop a session's worktree and its local tenai/* branch (callers check first that nothing unshipped is in it). */
  async discard(repo: RepoConfig, dir: string, branch: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", dir], repo.path);
    rmSync(dir, { recursive: true, force: true });
    await this.git(["worktree", "prune"], repo.path);
    if (BRANCH_RE.test(branch)) await this.git(["branch", "-D", branch], repo.path);
  }

  /** HEAD's sha when nothing is uncommitted (TenAI's own .tenai folder aside), else null. */
  async headClean(dir: string): Promise<string | null> {
    const dirty = (await this.must(["status", "--porcelain"], dir)).split("\n").filter((l) => l && !l.slice(3).startsWith(".tenai/"));
    return dirty.length ? null : (await this.must(["rev-parse", "HEAD"], dir)).trim();
  }

  async changedFiles(dir: string, base: string): Promise<string[]> {
    const committed = await this.must(["diff", "--name-only", `origin/${base}...HEAD`], dir);
    const working = await this.must(["status", "--porcelain"], dir);
    const files = new Set<string>(committed.split("\n").filter(Boolean));
    for (const line of working.split("\n").filter(Boolean)) files.add(line.slice(3).replace(/^.* -> /, ""));
    return [...files].filter((f) => !f.startsWith(".tenai/"));
  }

  async diff(dir: string, base: string): Promise<string> {
    await this.git(["add", "-A", "--", ".", ":!.tenai"], dir);
    return this.must(["diff", "--stat", "--patch", `origin/${base}`], dir);
  }

  /**
   * Squash everything the session did into one commit by the engineer and push it as an MR.
   * Returns the MR URL (or null when GitLab did not report one) and the commit sha.
   */
  async ship(opts: {
    repo: RepoConfig; dir: string; branch: string; title: string; description: string;
    authorName: string; authorEmail: string;
  }): Promise<{ sha: string; files: string[]; diffstat: string; mrUrl: string | null }> {
    const { repo, dir, branch } = opts;
    if (!BRANCH_RE.test(branch)) throw new GitError(`refusing to push ${branch}: only tenai/<user>/<slug> branches can be pushed`);
    const files = await this.changedFiles(dir, repo.baseBranch);
    if (!files.length) throw new GitError("nothing to ship: no changes in this session");

    await this.must(["add", "-A", "--", ".", ":!.tenai"], dir);
    await this.must(["reset", "--soft", `origin/${repo.baseBranch}`], dir);
    const message = opts.title.trim().split("\n")[0].slice(0, 120);
    await this.must([
      "-c", `user.name=TenAI`, "-c", `user.email=tenai-bot@example.com`,
      "commit", "-q", "--no-verify", `--author=${opts.authorName} <${opts.authorEmail}>`, "-m", message,
    ], dir);
    const sha = (await this.must(["rev-parse", "HEAD"], dir)).trim();
    const diffstat = (await this.must(["diff", "--shortstat", `origin/${repo.baseBranch}`, "HEAD"], dir)).trim();

    const push = await this.git([
      "push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`,
      "-o", "merge_request.create",
      "-o", `merge_request.target=${repo.baseBranch}`,
      "-o", `merge_request.title=${message}`,
      "-o", `merge_request.description=${opts.description.replace(/\n/g, " ").slice(0, 900)}`,
    ], dir);
    if (push.code !== 0) throw new GitError(`push failed: ${push.stderr.trim().split("\n").slice(-3).join(" ")}`);
    const mr = (push.stderr + push.stdout).match(/https?:\/\/\S+\/merge_requests\/\d+/);
    return { sha, files, diffstat, mrUrl: mr ? mr[0] : null };
  }
}
