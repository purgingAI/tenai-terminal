/**
 * Read-only GitLab: which merge requests are open into each repo's base branch, and which files they touch.
 * Agents see this in their context and editing one of those files raises a warning, so two people don't
 * unknowingly change the same code in parallel. Only GET requests exist in this client — the credential can
 * do more (it is the pilot's user login), so writes are deliberately impossible from here.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Config, RepoConfig } from "./config";

export interface OpenMr {
  repo: string; iid: number; title: string; author: string; authorUsername: string;
  branch: string; url: string; updated: string; draft: boolean; files: string[];
}

interface Remote { base: string; project: string }

/** Whose session is asking, and how recent an MR must be to count. */
export interface Who { email: string; name: string; withinMs: number }

export class GitLab {
  private tok: { value: string; header: "Authorization" | "PRIVATE-TOKEN"; exp: number } | null = null;
  private cache = new Map<string, OpenMr[]>();              // repo → open MRs
  private files = new Map<string, { updated: string; files: string[] }>(); // "repo!iid" → files at that update
  lastRefresh = 0;
  lastError: string | null = null;

  constructor(private cfg: Config) {}

  private credential(): string | undefined {
    const f = process.env.TENAI_GITLAB_TOKEN_FILE;
    return f && existsSync(f) ? readFileSync(f, "utf8").trim() || undefined : this.cfg.gitlabToken;
  }

  private remote(repo: RepoConfig): Remote | null {
    const r = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    const m = r.stdout.toString().trim().match(/^(https?:\/\/[^/]+)\/(.+?)(?:\.git)?$/);
    return m ? { base: m[1], project: m[2] } : null;
  }

  /** A PAT is used as-is; "user:password" (pilot) is exchanged for a 2-hour OAuth token, refreshed as needed. */
  private async auth(base: string): Promise<{ header: "Authorization" | "PRIVATE-TOKEN"; value: string }> {
    if (this.tok && this.tok.exp > Date.now() + 60_000) return this.tok;
    const cred = this.credential();
    if (!cred) throw new Error("No GitLab credential configured");
    if (!cred.includes(":")) {
      this.tok = { header: "PRIVATE-TOKEN", value: cred, exp: Number.MAX_SAFE_INTEGER };
      return this.tok;
    }
    const i = cred.indexOf(":");
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(20_000),
      body: new URLSearchParams({ grant_type: "password", username: cred.slice(0, i), password: cred.slice(i + 1) }),
    });
    if (!res.ok) throw new Error(`GitLab sign-in failed (${res.status})`);
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    this.tok = { header: "Authorization", value: `Bearer ${j.access_token}`, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.tok;
  }

  private async get<T>(base: string, path: string): Promise<T> {
    const a = await this.auth(base);
    const res = await fetch(`${base}/api/v4${path}`, { headers: { [a.header]: a.value }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) this.tok = null;
    if (!res.ok) throw new Error(`GitLab ${res.status} on ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }

  /** Refresh every repo's open MRs (files are re-read only for MRs that changed since last time). */
  async refresh(repos: RepoConfig[]): Promise<void> {
    try {
      for (const repo of repos) {
        const rem = this.remote(repo);
        if (!rem) continue;
        const pid = encodeURIComponent(rem.project);
        const list = await this.get<any[]>(rem.base,
          `/projects/${pid}/merge_requests?state=opened&target_branch=${encodeURIComponent(repo.baseBranch)}&per_page=100&order_by=updated_at`);
        const out: OpenMr[] = [];
        for (const m of list) {
          const key = `${repo.name}!${m.iid}`;
          let f = this.files.get(key);
          if (!f || f.updated !== m.updated_at) {
            const changes = await this.get<{ changes: Array<{ new_path: string; old_path: string }> }>(rem.base, `/projects/${pid}/merge_requests/${m.iid}/changes`);
            f = { updated: m.updated_at, files: [...new Set(changes.changes.flatMap((c) => [c.new_path, c.old_path]))] };
            this.files.set(key, f);
          }
          out.push({
            repo: repo.name, iid: m.iid, title: m.title, author: m.author?.name ?? "?", authorUsername: m.author?.username ?? "",
            branch: m.source_branch, url: m.web_url, updated: m.updated_at, draft: !!m.draft, files: f.files,
          });
        }
        this.cache.set(repo.name, out);
      }
      this.lastRefresh = Date.now();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  mrs(repo?: string): OpenMr[] {
    return repo ? this.cache.get(repo) ?? [] : [...this.cache.values()].flat();
  }

  /**
   * Open MRs worth comparing against: someone else's (never the person's own), updated within `withinMs`, not the
   * session's own branch. Old, quiet MRs and your own work only made noise.
   */
  relevant(repo: string, who: Who, ownBranch?: string): OpenMr[] {
    const since = Date.now() - who.withinMs;
    const local = who.email.split("@")[0].toLowerCase();
    return this.mrs(repo).filter((m) => m.branch !== ownBranch && Date.parse(m.updated) >= since &&
      m.authorUsername.toLowerCase() !== local && m.author.toLowerCase() !== who.name.toLowerCase());
  }

  /** Relevant MRs touching this path (exact file, or a file inside this directory). */
  touching(repo: string, path: string, who: Who, ownBranch?: string): OpenMr[] {
    const p = path.replace(/\/+$/, "");
    return this.relevant(repo, who, ownBranch).filter((m) => m.files.some((f) => f === p || f.startsWith(p + "/")));
  }

  /** For the agent's system prompt: open MRs and the files they change, newest first, kept short. */
  digest(repo: string, base: string, who: Who, ownBranch?: string, maxChars = 2500): string {
    const list = this.relevant(repo, who, ownBranch);
    if (!list.length) return "";
    const lines = [`## Teammates' open merge requests into ${base}, active in the last ${Math.round(who.withinMs / 86_400_000)} days (avoid conflicting edits; mention overlaps to the user)`];
    for (const m of list.slice(0, 15)) {
      lines.push(`- !${m.iid} ${m.draft ? "[draft] " : ""}"${m.title.slice(0, 80)}" by ${m.author} (${m.branch}): ${m.files.slice(0, 6).join(", ")}${m.files.length > 6 ? ` +${m.files.length - 6} more` : ""}`);
    }
    const t = lines.join("\n");
    return t.length > maxChars ? t.slice(0, maxChars) + "\n…" : t;
  }
}
