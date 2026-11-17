/**
 * TenAI server: email-OTP auth, terminal WebSocket (signed AMP frames), admin API + live feed, static web.
 */
import { verify as ampVerify, type Envelope } from "@tenai/amp";
import { ClaudeCliProvider } from "@tenai/providers";
import { ClientFrame, type ServerFrame } from "@tenai/wire";
import type { ServerWebSocket } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Auth, AuthError, type Principal } from "./auth";
import { ClaudeAccount } from "./claude-account";
import { GateOps } from "./gate-ops";
import { GitLab } from "./gitlab";
import { Notes } from "./notes";
import { Checks } from "./checks";
import { Teams } from "./teams";
import { config, type RepoConfig } from "./config";
import { openDb } from "./db";
import { Ledger } from "./ledger";
import { createMailer } from "./mailer";
import { alsoOf, Runner } from "./runner";
import { Spine } from "./spine";
import { makeGit, targetAllowed, Workspace, type MyBranch } from "./workspace";

const db = openDb(config.dbPath);
const ledger = new Ledger(db);
const auth = new Auth(db, config, createMailer(config), ledger);
const spine = new Spine(db);
const workspace = new Workspace(makeGit(config.gitlabToken), config.worktreesDir);
mkdirSync(config.agentHomesDir, { recursive: true });
const claude = new ClaudeAccount(db, config, ledger);
const gateOps = new GateOps(db, config, ledger);
const gitlab = new GitLab(config);
const teams = new Teams(config.teamsWebhookFile);
const provider = new ClaudeCliProvider({
  bin: config.claudeBin, credential: () => claude.credential(),
  agentHome: config.agentHomesDir, // used only when a credential is set (provider checks per turn)
  hookCommand: config.hookCommand, runAs: config.agentUser,
});
const runner = new Runner(db, config, provider, workspace, spine, ledger);
runner.onRateLimit = (info) => claude.recordUsage(info);
const notes = new Notes(db, spine);
claude.onAlert = (level, text) => {
  ledger.append("tenai", "claude.alert", { level, text });
  runner.broadcast({ type: "notice", level, text });
  void teams.post(level === "bad" ? "⛔ TenAI: Claude limit" : "⚠ TenAI: Claude usage", text, level === "bad" ? "Attention" : "Warning");
};
// Overlaps worth a warning: teammates' recent open MRs and recently pushed branches — never the person's own work.
function whoFor(sessionId: string) {
  const s = runner.session(sessionId);
  const email = s?.email ?? "";
  const name = (db.query("SELECT name FROM users WHERE email = ?").get(email) as { name: string } | null)?.name ?? "";
  // the session's own branches (and their copies) are never "someone else's"
  const own = new Set(s ? runner.slots(s).flatMap((x) => [x.branch, x.target_branch, ...alsoOf(x)]).filter(Boolean) as string[] : []);
  return { email, name, withinMs: config.mrOverlapDays * 86_400_000, own };
}
function branchesTouching(repoName: string, path: string, who: ReturnType<typeof whoFor>) {
  const repo = config.repos.find((r) => r.name === repoName);
  if (!repo) return [];
  const p = path.replace(/\/+$/, "");
  const local = who.email.split("@")[0].toLowerCase();
  const withMr = new Set(gitlab.relevant(repoName, who).map((m) => m.branch));
  return workspace.cachedRecent(repo, config.branchOverlapDays * 86_400_000).filter((b) =>
    b.email !== who.email.toLowerCase() && !who.own.has(b.name) && !withMr.has(b.name) && !b.name.startsWith(`tenai/${local}/`) &&
    b.files.some((f) => f === p || f.startsWith(p + "/")));
}
runner.extraContext = (repo, base, branch, sessionId) => {
  // files this session already edited that a teammate's open MR or fresh branch also changes: the agent must know too
  const who = whoFor(sessionId);
  const mine = spine.activeClaims(repo).filter((c) => c.session_id === sessionId).map((c) => c.path);
  const overlap = mine.flatMap((path) => [
    ...gitlab.touching(repo, path, who, branch).map((m) => `- ${path}: also changed in open MR !${m.iid} "${m.title.slice(0, 60)}" by ${m.author}`),
    ...branchesTouching(repo, path, who).map((b) => `- ${path}: also changed on ${b.author}'s branch ${b.name} (pushed ${new Date(b.updated).toISOString().slice(0, 16).replace("T", " ")} UTC)`),
  ]);
  return [notes.digest(repo), gitlab.digest(repo, base, who, branch),
    overlap.length ? "## Files you edited that teammates are also changing (tell the user; suggest coordinating)\n" + overlap.slice(0, 20).join("\n") : ""]
    .filter(Boolean).join("\n\n");
};
// "my work": unmerged branches carrying the person's commits, per repo (a few git calls per branch → cached)
const mineCache = new Map<string, { at: number; rows: MyBranch[] }>();
async function myBranches(email: string, repo: RepoConfig): Promise<MyBranch[]> {
  const key = `${email}|${repo.name}`;
  const hit = mineCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.rows;
  const rows = await workspace.mine(repo, email);
  mineCache.set(key, { at: Date.now(), rows });
  return rows;
}
runner.myWork = async (email, current) => {
  // the session's repo first, and a budget per repo, so a busy repo can't push the others out of the prompt
  const repos = [...config.repos].sort((a, b) => Number(b.name === current) - Number(a.name === current));
  const all = await Promise.all(repos.map((r) => myBranches(email, r).catch(() => [] as MyBranch[])));
  const parts = ["## This user's unmerged branches, every repo (their commits not yet in the base; newest first)"];
  for (const [i, repo] of repos.entries()) {
    const rows = all[i];
    const lines = [`### ${repo.name}${repo.name === current ? " (this session's repo)" : ""}: ${rows.length ? `${rows.length} branch${rows.length === 1 ? "" : "es"}` : "none"}`];
    for (const b of rows.slice(0, 6)) {
      const mr = gitlab.mrs(repo.name).find((m) => m.branch === b.name);
      const rel = b.related.length ? ` · copies of its commits also on: ${b.related.slice(0, 3).join(", ")}${b.related.length > 3 ? ` +${b.related.length - 3}` : ""}` : "";
      lines.push(`- ${b.name} · ${b.updated} · ${b.commits.length} of their commits · ${b.files.length} files${mr ? ` · open MR !${mr.iid}` : ""}${rel}`);
      lines.push(`  ${b.commits.slice(0, 3).map((c) => c.subject.slice(0, 80)).join(" | ")}`);
    }
    parts.push(lines.join("\n").slice(0, 1800));
  }
  return parts.join("\n");
};
runner.checks = new Checks(config);
runner.modelNow = () => claude.model();
runner.claimHints = (repo, path, branch, sessionId) => {
  const who = whoFor(sessionId);
  return {
    mrs: gitlab.touching(repo, path, who, branch),
    branches: branchesTouching(repo, path, who).map((b) => ({ name: b.name, author: b.author })),
    notes: notes.forPath(repo, path),
  };
};
runner.findMr = (repo, branch) => gitlab.mrs(repo).find((m) => m.branch === branch)?.url ?? null;
spine.subscribe((ev) => {
  if (ev.kind === "branch.pushed") {
    const who = (db.query("SELECT name FROM users WHERE email = ?").get(ev.actor) as { name: string } | null)?.name ?? ev.actor;
    const files = (ev.payload.files as string[] | undefined) ?? [];
    const mr = ev.payload.mrUrl as string | null;
    void teams.post(`⬆ ${who} pushed to ${ev.payload.branch} (${ev.repo})`, `${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 6).join(", ")}${files.length > 6 ? " …" : ""}`,
      "Good", mr ? { title: "Open the merge request", url: mr } : undefined);
    return;
  }
  if (ev.kind !== "mr.opened") return;
  const who = (db.query("SELECT name FROM users WHERE email = ?").get(ev.actor) as { name: string } | null)?.name ?? ev.actor;
  const files = (ev.payload.files as string[] | undefined) ?? [];
  const url = ev.payload.mrUrl as string | null;
  void teams.post(`🚀 ${who} shipped a change in ${ev.repo}`,
    `Branch ${ev.payload.branch} · ${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 6).join(", ")}${files.length > 6 ? " …" : ""}`,
    "Good", url ? { title: "Open the merge request", url } : undefined);
});
const refreshMrs = () => void gitlab.refresh(config.repos);
setTimeout(refreshMrs, 5_000);
setInterval(refreshMrs, 10 * 60_000);
const WEB_DIR = resolve(import.meta.dir, "../../web/dist");
const CLI_DIR = resolve(import.meta.dir, "../../../dist/cli");

/**
 * Starter questions for a repo, built from its latest merges so they change every day — no tokens spent.
 * Cached per repo for 5 minutes; reads the server's own clone only.
 */
const suggestionCache = new Map<string, { at: number; merges: Array<{ who: string; branch: string }> }>();
function suggestionsFor(repo: RepoConfig, userName: string): string[] {
  let hit = suggestionCache.get(repo.name);
  if (!hit || Date.now() - hit.at > 5 * 60_000) {
    const r = Bun.spawnSync(["git", "log", "--merges", "-12", "--format=%an\t%s", `origin/${repo.baseBranch}`], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    const merges = r.stdout.toString().split("\n").map((l) => {
      const [who, subject] = l.split("\t");
      const m = subject?.match(/Merge branch '([^']+)'/);
      return m && who ? { who: who.split(/\s+/)[0], branch: m[1] } : null;
    }).filter((x): x is { who: string; branch: string } => !!x && !/^(env|main|master|release)/.test(x.branch))
      .filter((m, i, all) => all.findIndex((o) => o.branch === m.branch) === i);
    hit = { at: Date.now(), merges };
    suggestionCache.set(repo.name, hit);
  }
  const seen = new Set<string>();
  const people = hit.merges.map((m) => m.who).filter((w) => w && !seen.has(w) && seen.add(w));
  const out = [
    ...hit.merges.slice(0, 2).map((m) => `What changed in ${m.branch}?`),
    ...people.slice(0, 2).map((w) => `What did ${w} merge into ${repo.baseBranch} this week?`),
    "Show me the latest merges and summarise each one",
    `What did I (${userName.split(/\s+/)[0]}) change last week?`,
    repo.name.includes("core-api") ? "Walk me through how a cross-border transaction is processed" :
      repo.name.includes("shield") ? "Where is the Incentive Engine screen and how does it load campaigns?" :
      "How does login and routing work in this app?",
  ];
  return [...new Set(out)].slice(0, 6);
}

/** Installs `openwallet` into ~/.local/bin for the current OS/arch and checks it against SHA256SUMS. */
function installScript(server: string): string {
  return `#!/usr/bin/env bash
# OpenWallet Terminal installer — ${server}
set -euo pipefail
SERVER="${server}"
case "$(uname -s)" in Linux) OS=linux;; Darwin) OS=darwin;; *) echo "Unsupported OS: $(uname -s)"; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=x64;; arm64|aarch64) ARCH=arm64;; *) echo "Unsupported CPU: $(uname -m)"; exit 1;; esac
NAME="openwallet-$OS-$ARCH"; DEST="$HOME/.local/bin"; mkdir -p "$DEST"
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
echo "Downloading the OpenWallet Terminal ($OS/$ARCH)…"
if command -v curl >/dev/null; then curl -fL --progress-bar "$SERVER/download/$NAME" -o "$TMP"; SUMS=$(curl -fsSL "$SERVER/download/SHA256SUMS")
else wget -q --show-progress "$SERVER/download/$NAME" -O "$TMP"; SUMS=$(wget -qO- "$SERVER/download/SHA256SUMS"); fi
WANT=$(printf '%s\n' "$SUMS" | awk -v n="$NAME" '$2==n{print $1}')
GOT=$( (command -v sha256sum >/dev/null && sha256sum "$TMP" || shasum -a 256 "$TMP") | awk '{print $1}')
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "Checksum mismatch — download corrupted, not installing."; exit 1; }
install -m 755 "$TMP" "$DEST/openwallet"
case ":$PATH:" in *":$DEST:"*) ;; *)
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do [ -f "$rc" ] && ! grep -q '.local/bin' "$rc" && echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"; done
  echo "Added ~/.local/bin to your PATH — open a new terminal first.";;
esac
echo ""
echo "  ✓ OpenWallet Terminal installed. Type:  openwallet"
echo ""
`;
}

interface WsData {
  kind: "terminal" | "admin";
  principal?: Principal;
  unsubs: Array<() => void>;
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
const clientIp = (req: Request, server: { requestIP(r: Request): { address: string } | null }) =>
  req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? server.requestIP(req)?.address ?? "?";

function requireUser(req: Request): Principal {
  const p = auth.resolve(bearer(req));
  if (!p) throw new AuthError("Sign in again", 401);
  return p;
}

function requireAdmin(req: Request): Principal {
  const p = requireUser(req);
  if (p.role !== "admin") throw new AuthError("Admins only", 403);
  return p;
}

/** Every open terminal per person, to reach someone who isn't in the session yet (invites, hand-overs). */
const terminals = new Map<string, Set<ServerWebSocket<WsData>>>();
function toPerson(email: string, frame: ServerFrame): number {
  const set = terminals.get(email);
  for (const ws of set ?? []) wsSend(ws, frame);
  return set?.size ?? 0;
}

/** Who has a terminal open right now (connected, session or not). Several terminals per person are counted once. */
const online = new Map<string, { email: string; name: string; modelId: string; since: number; conns: number }>();
function presence(p: Principal, delta: 1 | -1) {
  const cur = online.get(p.email);
  if (delta === 1) {
    if (cur) cur.conns++;
    else { online.set(p.email, { email: p.email, name: p.name, modelId: p.modelId, since: Date.now(), conns: 1 }); spine.emit("presence.online", p.email, null, { name: p.name }); }
  } else if (cur && --cur.conns <= 0) {
    online.delete(p.email);
    spine.emit("presence.offline", p.email, null, { name: p.name });
  }
}

function adminOverview() {
  const since = new Date().setHours(0, 0, 0, 0);
  const sessions = db.query(
    `SELECT s.*, u.name,
       (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turns,
       (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id AND t.outcome = 'refused') AS refused,
       (SELECT COALESCE(SUM(input_tokens + output_tokens + cache_write), 0) FROM usage g WHERE g.session_id = s.id) AS tokens,
       (SELECT COALESCE(SUM(cost_usd), 0) FROM usage g WHERE g.session_id = s.id) AS cost
     FROM term_sessions s JOIN users u ON u.email = s.email ORDER BY s.started DESC LIMIT 200`,
  ).all() as Array<Record<string, unknown>>;
  const people = db.query(
    `SELECT u.email, u.name, u.role, u.blocked, u.daily_token_budget, u.last_seen,
       (SELECT COUNT(*) FROM term_sessions s WHERE s.email = u.email) AS sessions,
       (SELECT COALESCE(SUM(input_tokens + output_tokens + cache_write), 0) FROM usage g WHERE g.email = u.email AND g.ts >= ?) AS tokens_today,
       (SELECT COALESCE(SUM(cost_usd), 0) FROM usage g WHERE g.email = u.email) AS cost_total
     FROM users u ORDER BY u.last_seen DESC`,
  ).all(since);
  const totals = db.query(
    `SELECT (SELECT COUNT(*) FROM term_sessions WHERE status = 'active') AS active_sessions,
            (SELECT COUNT(*) FROM turns WHERE started >= ?) AS turns_today,
            (SELECT COUNT(*) FROM turns WHERE started >= ? AND outcome = 'refused') AS refused_today,
            (SELECT COALESCE(SUM(input_tokens + output_tokens + cache_write), 0) FROM usage WHERE ts >= ?) AS tokens_today,
            (SELECT COALESCE(SUM(cost_usd), 0) FROM usage WHERE ts >= ?) AS cost_today,
            (SELECT COUNT(*) FROM changes) AS mrs_total`,
  ).get(since, since, since, since);
  return { totals: { ...(totals as object), online: online.size }, online: [...online.values()], sessions, people, frozen: runner.frozen(), running: [...db.query("SELECT session_id FROM turns WHERE outcome = 'running'").all()].map((r: any) => r.session_id) };
}

async function routeHttp(req: Request, url: URL, ip: string): Promise<Response> {
  const path = url.pathname;
  const body = async () => (req.headers.get("content-type")?.includes("json") ? await req.json().catch(() => ({})) : {}) as Record<string, any>;

  // ---- auth ----
  if (path === "/auth/otp/request" && req.method === "POST") {
    await auth.requestOtp((await body()).email, ip);
    return json({ ok: true });
  }
  if (path === "/auth/otp/verify" && req.method === "POST") {
    const b = await body();
    const { token, principal } = auth.verifyOtp(b.email, b.code, ip);
    return json({ token, ampSecret: principal.ampSecret, email: principal.email, name: principal.name, role: principal.role, modelId: principal.modelId });
  }
  if (path === "/auth/logout" && req.method === "POST") {
    const p = requireUser(req);
    auth.logout(p.tokenHash);
    ledger.append(p.email, "logout", {});
    return json({ ok: true });
  }

  // ---- terminal API ----
  if (path === "/api/me") {
    const p = requireUser(req);
    return json({ email: p.email, name: p.name, role: p.role, modelId: p.modelId, tokensToday: runner.tokensToday(p.email) });
  }
  if (path === "/api/repos") {
    requireUser(req);
    return json(config.repos.map((r) => ({ name: r.name, baseBranch: r.baseBranch })));
  }
  if (path === "/api/who") {
    requireUser(req);
    const rows = db.query(`SELECT s.id, s.email, u.name, s.repo, s.branch, s.started,
        (SELECT MAX(started) FROM turns t WHERE t.session_id = s.id) AS last_turn,
        (SELECT prompt FROM turns t WHERE t.session_id = s.id AND t.outcome != 'refused' ORDER BY started DESC LIMIT 1) AS last_prompt
      FROM term_sessions s JOIN users u ON u.email = s.email WHERE s.status = 'active' ORDER BY last_turn DESC`).all() as any[];
    const running = new Set(runner.runningIds());
    return json(rows.map((r) => ({
      ...r, last_prompt: r.last_prompt ? String(r.last_prompt).slice(0, 90) : null, working: running.has(r.id),
      editing: spine.activeClaims(r.repo).filter((c) => c.session_id === r.id).map((c) => c.path).slice(0, 8),
    })));
  }
  if (path === "/api/branches") {
    requireUser(req);
    const repo = config.repos.find((r) => r.name === url.searchParams.get("repo"));
    if (!repo) throw new AuthError("Unknown repo", 400);
    const names = await workspace.branches(repo, url.searchParams.get("q") ?? "");
    const q = url.searchParams.get("q") ?? "";
    return json(names.slice(0, q ? 60 : 3000).map((n) => ({ name: n, protected: !!targetAllowed(repo, n), mr: gitlab.mrs(repo.name).find((m) => m.branch === n)?.iid ?? null })));
  }
  if (path === "/api/members" && req.method === "GET") {
    return json(runner.members(requireUser(req), url.searchParams.get("sessionId") ?? ""));
  }
  if (path === "/api/undo" && req.method === "POST") {
    const p = requireUser(req);
    const b = await body();
    return json(await runner.undo(p, String(b.sessionId ?? ""), b.repo ? String(b.repo) : undefined));
  }
  if (path === "/api/hunks" && req.method === "GET") {
    return json(await runner.hunks(requireUser(req), url.searchParams.get("sessionId") ?? ""));
  }
  if (path === "/api/hunks/drop" && req.method === "POST") {
    const p = requireUser(req);
    const b = await body();
    return json(await runner.dropHunk(p, String(b.sessionId ?? ""), String(b.repo ?? ""), String(b.id ?? "")));
  }
  if (path === "/api/contracts" && req.method === "GET") {
    return json(await runner.contracts(requireUser(req), url.searchParams.get("sessionId") ?? ""));
  }
  if (path === "/api/check" && req.method === "POST") {
    const p = requireUser(req);
    const b = await body();
    return json(await runner.check(p, String(b.sessionId ?? ""), b.repo ? String(b.repo) : undefined));
  }
  if (path === "/api/mine") {
    const p = requireUser(req);
    const words = (url.searchParams.get("q") ?? "").toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !["my", "the", "and", "changes", "change", "work", "what", "about", "branch", "branches"].includes(w));
    const repos = config.repos.filter((r) => !url.searchParams.get("repo") || r.name === url.searchParams.get("repo"));
    const all = (await Promise.all(repos.map((r) => myBranches(p.email, r)))).flat();
    // every word must appear; hits in the repo, branch name or commit messages rank above hits in file paths
    const head = (b: MyBranch) => [b.repo, b.name, ...b.commits.map((c) => c.subject)].join(" ").toLowerCase().replace(/[-_/]/g, " ");
    const files = (b: MyBranch) => b.files.join(" ").toLowerCase();
    const score = (b: MyBranch) => words.reduce((n, w) => n + (head(b).includes(w) ? 3 : files(b).includes(w) ? 1 : -99), 0);
    const hits = words.length ? all.map((b) => ({ b, n: score(b) })).filter((x) => x.n >= 3) /* at least one word outside file paths */.sort((x, y) => y.n - x.n || y.b.updated.localeCompare(x.b.updated)).map((x) => x.b) : all;
    return json(hits.slice(0, 30).map((b) => ({ ...b, files: b.files.slice(0, 12), fileCount: b.files.length, commits: b.commits.slice(0, 5),
      mr: gitlab.mrs(b.repo).find((m) => m.branch === b.name)?.iid ?? null })));
  }
  if (path === "/api/mrs") {
    requireUser(req);
    return json(gitlab.mrs(url.searchParams.get("repo") ?? undefined).map(({ files, ...m }) => ({ ...m, fileCount: files.length, files: files.slice(0, 30) })));
  }
  if (path === "/api/notes" && req.method === "GET") { requireUser(req); return json(notes.list(url.searchParams.get("repo") ?? undefined)); }
  if (path === "/api/notes" && req.method === "POST") {
    const p = requireUser(req);
    const b = await body();
    const repo = String(b.repo ?? "");
    if (!config.repos.some((r) => r.name === repo)) throw new AuthError("Unknown repo", 400);
    const n = notes.add(p.email, repo, String(b.path ?? ""), String(b.text ?? ""));
    ledger.append(p.email, "note.add", { id: n.id, repo, path: n.path });
    return json(n);
  }
  {
    const nm = path.match(/^\/api\/notes\/(\d+)\/remove$/);
    if (nm && req.method === "POST") {
      const p = requireUser(req);
      const ok = notes.remove(Number(nm[1]), p.email, p.role === "admin");
      if (ok) ledger.append(p.email, "note.remove", { id: Number(nm[1]) });
      return json(ok ? { ok } : { ok, error: "Only the note's author or an admin can remove it." });
    }
  }
  if (path === "/api/appeal" && req.method === "POST") {
    const p = requireUser(req);
    const b = await body();
    return json(gateOps.appeal(p.email, String(b.sessionId ?? ""), String(b.note ?? "")));
  }
  if (path === "/api/suggestions") {
    const p = requireUser(req);
    const repo = config.repos.find((r) => r.name === url.searchParams.get("repo")) ?? config.repos[0];
    return json(repo ? { repo: repo.name, suggestions: suggestionsFor(repo, p.name) } : { repo: null, suggestions: [] });
  }
  if (path === "/api/sessions" && req.method === "GET") {
    const p = requireUser(req);
    return json(db.query(`SELECT s.id, s.repo, s.branch, s.status, s.started, CASE WHEN s.email = ? THEN NULL ELSE s.email END AS owner
      FROM term_sessions s WHERE s.status = 'active' AND (s.email = ? OR s.id IN (SELECT session_id FROM session_members WHERE email = ?))
      ORDER BY s.started DESC`).all(p.email, p.email, p.email));
  }
  if (path === "/api/attachments" && req.method === "POST") {
    const p = requireUser(req);
    const s = runner.owned(p, url.searchParams.get("sessionId") ?? "");
    const name = (url.searchParams.get("name") ?? "file").replace(/[^\w.-]/g, "_").slice(0, 80);
    const data = new Uint8Array(await req.arrayBuffer());
    if (data.byteLength > 10 * 1024 * 1024) throw new AuthError("Attachments are limited to 10 MB", 413);
    const stored = `${Date.now()}-${name}`;
    const dir = join(s.worktree, ".tenai", "attachments");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, stored), data);
    ledger.append(p.email, "attachment", { sessionId: s.id, name: stored, bytes: data.byteLength });
    return json({ name: stored });
  }

  // ---- admin API ----
  if (path.startsWith("/admin/api/")) {
    const admin = requireAdmin(req);
    const rest = path.slice("/admin/api/".length);
    if (rest === "overview") return json(adminOverview());
    if (rest === "claude") return json(claude.status());
    if (rest === "collab") return json({
      mrs: gitlab.mrs(), notes: notes.list(), gitlab: { lastRefresh: gitlab.lastRefresh, lastError: gitlab.lastError },
      teams: { connected: teams.connected(), configured: !!config.teamsWebhookFile },
      claims: spine.activeClaims(),
    });
    if (rest === "gitlab/refresh" && req.method === "POST") { await gitlab.refresh(config.repos); return json({ ok: !gitlab.lastError, error: gitlab.lastError }); }
    if (rest === "integrations/teams" && req.method === "POST") {
      const r = await teams.set(String((await body()).url ?? ""));
      if (r.ok) ledger.append(admin.email, "teams.connected", {});
      return json(r);
    }
    if (rest === "integrations/teams/disconnect" && req.method === "POST") { teams.disconnect(); ledger.append(admin.email, "teams.disconnected", {}); return json({ ok: true }); }
    if (rest === "gate/inbox") return json(gateOps.inbox());
    if (rest === "gate/label" && req.method === "POST") { const b = await body(); return json(gateOps.label((b.ids ?? []).map(String), String(b.label), admin.email)); }
    if (rest === "gate/models") return json(await gateOps.models());
    if (rest === "gate/train" && req.method === "POST") return json(await gateOps.train(admin.email));
    if (rest === "gate/shadow" && req.method === "POST") { const b = await body(); return json(await gateOps.shadow(b.version == null ? null : Number(b.version), admin.email)); }
    if (rest === "gate/promote" && req.method === "POST") return json(await gateOps.promote(Number((await body()).version), admin.email));
    if (rest === "gate/drift") return json(gateOps.drift());
    if (rest === "claude/check" && req.method === "POST") return json({ ...(await claude.check(admin.email)), ...claude.status() });
    if (rest === "claude/rename" && req.method === "POST") return json({ ...claude.rename(String((await body()).label ?? ""), admin.email), ...claude.status() });
    if (rest === "claude/model" && req.method === "POST") return json({ ...claude.setModel(String((await body()).model ?? ""), admin.email), ...claude.status() });
    if (rest === "claude/switch" && req.method === "POST") {
      const b = await body();
      const kind = b.kind === "api_key" ? "api_key" : "oauth";
      return json({ ...(await claude.switchTo(kind, String(b.secret ?? ""), String(b.label ?? ""), admin.email)), ...claude.status() });
    }
    if (rest === "ledger") return json(ledger.recent(Number(url.searchParams.get("limit") ?? 300)));
    if (rest === "ledger/verify") return json({ brokenAt: ledger.verify() });
    if (rest === "changes") return json(db.query("SELECT * FROM changes ORDER BY ts DESC LIMIT 200").all());
    if (rest === "claims") return json(spine.activeClaims());
    if (rest === "spine") return json(spine.since(Number(url.searchParams.get("since") ?? 0), 300));
    if (rest === "gate") return json(db.query("SELECT id, session_id, email, prompt, gate_label, gate_score, outcome, detail, started FROM turns WHERE outcome = 'refused' ORDER BY started DESC LIMIT 300").all());
    let m = rest.match(/^turns\/([\w-]+)\/events$/);
    if (m) return json(runner.turnEvents(m[1]));
    m = rest.match(/^sessions\/([\w-]+)\/turns$/);
    if (m) return json(db.query("SELECT t.*, g.input_tokens, g.output_tokens, g.cache_write, g.cost_usd FROM turns t LEFT JOIN usage g ON g.turn_id = t.id WHERE t.session_id = ? ORDER BY t.started").all(m[1]));
    m = rest.match(/^sessions\/([\w-]+)\/diff$/);
    if (m) return json(await runner.diff(admin, m[1]));
    m = rest.match(/^sessions\/([\w-]+)\/block$/);
    if (m && req.method === "POST") { runner.block(m[1], admin.email, String((await body()).reason ?? "blocked by admin")); return json({ ok: true }); }
    m = rest.match(/^users\/([^/]+)\/(block|unblock)$/);
    if (m && req.method === "POST") {
      const email = decodeURIComponent(m[1]);
      auth.setBlocked(email, m[2] === "block", admin.email);
      if (m[2] === "block") for (const s of db.query("SELECT id FROM term_sessions WHERE email = ? AND status = 'active'").all(email) as Array<{ id: string }>) runner.block(s.id, admin.email, "user blocked");
      return json({ ok: true });
    }
    if (rest === "freeze" && req.method === "POST") { runner.setFrozen(Boolean((await body()).on), admin.email); return json({ ok: true, frozen: runner.frozen() }); }
    return json({ error: "not found" }, 404);
  }

  // ---- CLI install: `curl -fsSL <server>/install | bash` (the link the Teams channel carries) ----
  if (req.method === "GET" && path === "/api/cli") {
    const v = Bun.file(join(CLI_DIR, "VERSION"));
    return json({ version: (await v.exists()) ? (await v.text()).trim() : null, install: `curl -fsSL ${config.publicUrl}/install | bash` });
  }
  if (req.method === "GET" && path === "/install") {
    return new Response(installScript(config.publicUrl), { headers: { "content-type": "text/x-shellscript; charset=utf-8" } });
  }
  const dl = path.match(/^\/download\/(openwallet-(?:linux|darwin)-(?:x64|arm64)|SHA256SUMS)$/);
  if (req.method === "GET" && dl) {
    const file = Bun.file(join(CLI_DIR, dl[1]));
    if (!(await file.exists())) return json({ error: "not built for this platform yet" }, 404);
    return new Response(file, { headers: { "content-type": "application/octet-stream" } });
  }

  // ---- static web (admin dashboard + web terminal) ----
  if (req.method === "GET" && existsSync(WEB_DIR)) {
    const rel = path === "/" || path === "/admin" || path.startsWith("/admin/") ? "index.html" : path.slice(1);
    const file = Bun.file(join(WEB_DIR, rel.includes("..") ? "index.html" : rel));
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(join(WEB_DIR, "index.html")));
  }
  return json({ error: "not found" }, 404);
}

function wsSend(ws: ServerWebSocket<WsData>, frame: ServerFrame) {
  ws.send(JSON.stringify(frame));
}

async function onTerminalFrame(ws: ServerWebSocket<WsData>, p: Principal, env: Envelope) {
  if (env.from !== p.modelId || !ampVerify(env, p.ampSecret)) return wsSend(ws, { type: "error", message: "Bad AMP signature" });
  // Re-check on every frame: blocks and revocations take effect immediately.
  const stillValid = db.query(
    "SELECT 1 FROM auth_sessions s JOIN users u ON u.email = s.email WHERE s.token_hash = ? AND s.revoked = 0 AND u.blocked = 0 AND s.expires > ?",
  ).get(p.tokenHash, Date.now());
  if (!stillValid) {
    wsSend(ws, { type: "session.blocked", reason: "Your access was revoked." });
    return ws.close(4003, "revoked");
  }
  const parsed = ClientFrame.safeParse(env.body);
  if (!parsed.success) return wsSend(ws, { type: "error", message: "Invalid frame" });
  const f = parsed.data;
  const follow = (sessionId: string) => ws.data.unsubs.push(runner.watch(sessionId, (fr) => wsSend(ws, fr)));
  switch (f.type) {
    case "session.open": {
      const s = await runner.open(p, f.repo, f.title, f.branch?.trim() || undefined, f.also, f.ticket);
      void runner.myWork?.(p.email, s.repo).catch(() => undefined); // warm the "my branches" cache before the first prompt
      for (const r of config.repos) workspace.cachedRecent(r, config.branchOverlapDays * 86_400_000); // and "teammates' fresh branches"
      follow(s.id);
      wsSend(ws, { type: "session.opened", sessionId: s.id, repo: s.repo, branch: s.branch, resumed: false, target: s.target_branch, also: alsoOf(s) });
      return wsSend(ws, { type: "session.repos", sessionId: s.id, repos: runner.repoView(s) });
    }
    case "session.use": {
      // session.repos reaches this socket through the session's watchers
      await runner.useBranch(p, f.sessionId, f.repo, f.branch?.trim() || null, f.also);
      return;
    }
    case "session.also": {
      const s = await runner.setAlso(p, f.sessionId, f.branches);
      return wsSend(ws, { type: "session.opened", sessionId: s.id, repo: s.repo, branch: s.branch, resumed: true, target: s.target_branch, also: alsoOf(s) });
    }
    case "session.resume": {
      let s = runner.owned(p, f.sessionId);
      if (await runner.upgrade(s).catch((e) => { console.error(`upgrade: ${(e as Error).message}`); return false; })) {
        s = runner.session(s.id)!;
        wsSend(ws, { type: "notice", level: "info", text: `This session now has every repo checked out (${config.repos.map((r) => r.name).join(", ")}). Unshipped edits in ${s.repo} are kept; the agent starts a fresh conversation.` });
      }
      if (s.status !== "active") return wsSend(ws, { type: "error", message: `Session is ${s.status}` });
      follow(s.id);
      if (s.email !== p.email) runner.broadcastTo(s.id, { type: "hint", sessionId: s.id, text: `👋 ${p.name} joined this session` });
      wsSend(ws, { type: "session.opened", sessionId: s.id, repo: s.repo, branch: s.branch, resumed: true, target: s.target_branch, also: alsoOf(s) });
      return wsSend(ws, { type: "session.repos", sessionId: s.id, repos: runner.repoView(s) });
    }
    case "prompt.submit":
      runner.submit(p, f.sessionId, f.text, f.attachments).catch((e) => wsSend(ws, { type: "error", message: (e as Error).message }));
      return;
    case "turn.cancel":
      runner.owned(p, f.sessionId);
      return runner.cancel(f.sessionId);
    case "diff.request": {
      const d = await runner.diff(p, f.sessionId);
      return wsSend(ws, { type: "diff", sessionId: f.sessionId, ...d });
    }
    case "ship": {
      const r = await runner.ship(p, f.sessionId, f.title, f.description, f.force);
      return wsSend(ws, { type: "shipped", sessionId: f.sessionId, sha: r.sha, files: r.files, mrUrl: r.mrUrl, diffstat: r.diffstat, pushedTo: r.pushedTo, ports: r.ports, results: r.results });
    }
    case "session.end":
      return runner.end(p, f.sessionId);
    case "session.invite": {
      const { session, person } = runner.invite(p, f.sessionId, f.who);
      const reached = toPerson(person.email, { type: "session.invited", sessionId: session.id, from: p.name, fromEmail: p.email, label: runner.label(session), handoff: false });
      return wsSend(ws, { type: "notice", level: "info", text: reached
        ? `🤝 Invited ${person.name}. They see it in their terminal now; once they /join, you'll both see every turn.`
        : `🤝 Invited ${person.name}. Their terminal isn't open — they'll find it under /sessions (or /join ${session.id.slice(0, 8)}) when they start TenAI.` });
    }
    case "session.handoff": {
      const { session, person } = runner.handoff(p, f.sessionId, f.who);
      toPerson(person.email, { type: "session.invited", sessionId: session.id, from: p.name, fromEmail: p.email, label: runner.label(session), handoff: true });
      return wsSend(ws, { type: "notice", level: "info", text: `🔁 ${person.name} owns this session now (its changes and the agent's memory of it). You're still in it as a member; /leave to drop out.` });
    }
    case "session.leave":
      runner.leave(p, f.sessionId);
      return wsSend(ws, { type: "notice", level: "info", text: "You left that session." });
    case "spine.subscribe":
      for (const ev of spine.since(f.since, 100)) wsSend(ws, { type: "spine.event", ...ev });
      return;
  }
}

void runner.sweep().catch((e) => console.error(`sweep: ${(e as Error).message}`)); // remove worktrees of ended sessions (only ones with nothing unshipped)
const server = Bun.serve<WsData>({
  hostname: config.host,
  port: config.port,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" || url.pathname === "/admin/ws") {
      const ok = srv.upgrade(req, { data: { kind: url.pathname === "/ws" ? "terminal" : "admin", unsubs: [] } });
      return ok ? undefined : json({ error: "upgrade failed" }, 400);
    }
    // compiles can take minutes: no idle cut-off on these two
    if (url.pathname === "/agent/run" || url.pathname === "/api/check") srv.timeout(req, 0);
    if (url.pathname === "/agent/run") {
      // the agent's `tenai` command: loopback only (the socket's own address, never a header), and the running turn's key
      const ip = srv.requestIP(req)?.address ?? "";
      if (!/^(127\.|::1$|::ffff:127\.)/.test(ip) || req.method !== "POST") return new Response("forbidden\n", { status: 403 });
      try {
        const b = (await req.json()) as { args?: unknown };
        const args = Array.isArray(b.args) ? b.args.map(String).slice(0, 12) : [];
        return new Response(await runner.agentRun(req.headers.get("x-tenai-agent") ?? "", args), { headers: { "content-type": "text/plain" } });
      } catch (e) {
        return new Response(`tenai: ${(e as Error).message}`, { headers: { "content-type": "text/plain" } });
      }
    }
    try {
      return await routeHttp(req, url, clientIp(req, srv));
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 400;
      return json({ error: (e as Error).message }, status);
    }
  },
  websocket: {
    idleTimeout: 120,
    open(ws) {
      // Nothing is sent until the client authenticates with its first frame.
      setTimeout(() => { if (!ws.data.principal) ws.close(4001, "auth timeout"); }, 10_000);
    },
    async message(ws, raw) {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return ws.close(4000, "bad json"); }
      if (!ws.data.principal) {
        const p = msg?.type === "auth" ? auth.resolve(msg.token) : null;
        if (!p || (ws.data.kind === "admin" && p.role !== "admin")) return ws.close(4001, "unauthorized");
        ws.data.principal = p;
        if (ws.data.kind === "admin") {
          ws.data.unsubs.push(runner.watchAll((fr) => wsSend(ws, fr)));
          ws.data.unsubs.push(spine.subscribe((ev) => wsSend(ws, { type: "spine.event", ...ev })));
        } else {
          ws.data.unsubs.push(spine.subscribe((ev) => wsSend(ws, { type: "spine.event", ...ev })));
          wsSend(ws, { type: "hello", email: p.email, name: p.name, modelId: p.modelId, role: p.role, repos: config.repos.map((r) => r.name) });
          presence(p, 1);
          const set = terminals.get(p.email) ?? new Set();
          set.add(ws);
          terminals.set(p.email, set);
        }
        return;
      }
      if (ws.data.kind !== "terminal") return;
      try {
        await onTerminalFrame(ws, ws.data.principal, msg as Envelope);
      } catch (e) {
        wsSend(ws, { type: "error", message: (e as Error).message });
      }
    },
    close(ws) {
      for (const u of ws.data.unsubs) u();
      if (ws.data.kind === "terminal" && ws.data.principal) {
        presence(ws.data.principal, -1);
        terminals.get(ws.data.principal.email)?.delete(ws);
      }
    },
  },
});

ledger.append("system", "server.start", { port: server.port, provider: provider.id, repos: config.repos.map((r) => r.name) });
console.log(`TenAI server on http://${server.hostname}:${server.port} (provider ${provider.id}, ${config.repos.length} repos)`);
