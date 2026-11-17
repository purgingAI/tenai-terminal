/**
 * Sessions and turns: guardrails → intent gate → budget → queue → agent, with every step ledgered and
 * streamed. Refused prompts never reach the agent, so they cost no tokens.
 */
import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentProvider } from "@tenai/providers";
import type { ServerFrame } from "@tenai/wire";
import type { Principal } from "./auth";
import type { Config, RepoConfig } from "./config";
import { BORDERLINE, CONFIDENT_REFUSAL, classify, REFUSAL, type GateDecision, type GateLabel } from "./gate";
import { checkPrompt, redact } from "./guard";
import type { Ledger } from "./ledger";
import type { Spine } from "./spine";
import { branchFor, branchOn, targetAllowed, type Workspace } from "./workspace";
import { pathNeedle, removedFromDiff, type Finding } from "./contracts";

export interface SessionRow {
  id: string;
  email: string;
  model_id: string;
  repo: string;
  worktree: string;
  branch: string;
  provider: string;
  provider_session: string | null;
  status: string;
  started: number;
  /** Set when the session works on an existing branch (/branch): /ship pushes onto it. */
  target_branch: string | null;
  /** JSON list of further branches /ship copies the same commit onto (the change belongs on several branches). */
  also_branches: string | null;
  /** JSON {key, url, summary} when the session was opened from a Jira ticket (/ticket). */
  ticket: string | null;
}

export interface Ticket { key: string; url: string; summary: string }
const ticketOf = (s: SessionRow): Ticket | null => (s.ticket ? JSON.parse(s.ticket) : null);

export const alsoOf = (s: { also_branches: string | null }): string[] => (s.also_branches ? JSON.parse(s.also_branches) : []);

/** One repo inside a session: its worktree, the session's local branch, and where /ship sends it. */
export interface ShipResult {
  repo: string; sha: string; files: string[]; diffstat: string; mrUrl: string | null; pushedTo?: string;
  ports?: Array<{ branch: string; ok: boolean; sha?: string; already?: boolean; error?: string }>; error?: string;
}

export interface Slot { repo: string; dir: string; branch: string; target_branch: string | null; also_branches: string | null }

type Sink = (frame: ServerFrame) => void;

const FOLLOW_UP_WINDOW_MS = 10 * 60_000;

export class Runner {
  private running = new Map<string, AbortController>(); // sessionId → running turn
  private queue: Array<() => void> = [];
  private active = 0;
  private sinks = new Map<string, Set<Sink>>(); // sessionId → listeners
  private adminSinks = new Set<Sink>();
  private lastCodeLabel = new Map<string, { label: GateLabel; at: number }>();

  /** Set by main: open MRs + team notes for the agent's context, and what to warn about when a file is edited. */
  extraContext?: (repo: string, base: string, branch: string, sessionId: string) => string;
  /** Set by main: this person's unmerged branches in every repo, for "what about my X changes" questions. */
  myWork?: (email: string, repo: string) => Promise<string>;
  /** Set by main: the open MR (if any) whose source is this branch — shown after a direct push. */
  findMr?: (repo: string, branch: string) => string | null;
  claimHints?: (repo: string, path: string, branch: string, sessionId: string) => {
    mrs: Array<{ iid: number; author: string; title: string }>; branches: Array<{ name: string; author: string }>; notes: Array<{ text: string; email: string; path: string }>;
  };
  private hinted = new Map<string, Set<string>>(); // sessionId → hints already shown
  private agentKeys = new Map<string, { sessionId: string }>(); // running turn's key → session (the agent's `tenai` command)

  /** Set by main: the model new turns run on (switchable from the dashboard). */
  modelNow?: () => string;

  /** Set by main: compiles a repo of a session (`tenai check`, /check). */
  checks?: import("./checks").Checks;

  /** Set by main: every turn reports the Claude subscription's usage windows. */
  onRateLimit?: (info: import("@tenai/providers").RateLimitInfo) => void;

  constructor(
    private db: Database, private cfg: Config, private provider: AgentProvider,
    private workspace: Workspace, private spine: Spine, private ledger: Ledger,
  ) {}

  // ---- delivery ----
  watch(sessionId: string, sink: Sink): () => void {
    const set = this.sinks.get(sessionId) ?? new Set<Sink>();
    set.add(sink);
    this.sinks.set(sessionId, set);
    return () => set.delete(sink);
  }

  watchAll(sink: Sink): () => void {
    this.adminSinks.add(sink);
    return () => this.adminSinks.delete(sink);
  }

  /** To every connected terminal and dashboard (shared-account alerts). */
  broadcast(frame: ServerFrame): void {
    for (const set of this.sinks.values()) for (const s of set) s(frame);
    for (const s of this.adminSinks) s(frame);
  }

  private step(turnId: string, kind: string, name: string | null, text: string | null): void {
    this.db.query("INSERT INTO turn_events(turn_id, ts, kind, name, text) VALUES (?,?,?,?,?)").run(turnId, Date.now(), kind, name, text?.slice(0, 4000) ?? null);
  }

  runningIds(): string[] { return [...this.running.keys()]; }

  turnEvents(turnId: string) {
    return this.db.query("SELECT seq, ts, kind, name, text FROM turn_events WHERE turn_id = ? ORDER BY seq").all(turnId);
  }

  /** To everyone watching one session (used by main for join notices). */
  broadcastTo(sessionId: string, frame: ServerFrame): void {
    this.send(sessionId, frame);
  }

  private send(sessionId: string, frame: ServerFrame): void {
    for (const s of this.sinks.get(sessionId) ?? []) s(frame);
    for (const s of this.adminSinks) s(frame);
  }

  repo(name: string): RepoConfig {
    const r = this.cfg.repos.find((x) => x.name === name);
    if (!r) throw new Error(`Unknown repo ${name}`);
    return r;
  }

  session(id: string): SessionRow | null {
    return this.db.query("SELECT * FROM term_sessions WHERE id = ?").get(id) as SessionRow | null;
  }

  // ---- sessions ----
  /**
   * A session spans every configured repo: one folder with a worktree per repo, each on a fresh tenai/* branch,
   * except the repo the session starts in, which may start on an existing branch (/branch).
   */
  async open(p: Principal, repoName: string, title = "tenai change", target?: string, also: string[] = [], ticket?: Ticket): Promise<SessionRow> {
    const focus = this.repo(repoName);
    const id = randomUUID();
    if (target) {
      const why = targetAllowed(focus, target);
      if (why) throw new Error(why);
    }
    also = await this.checkAlso(focus, also.filter((b) => b !== target));
    const dir = this.workspace.sessionDir(id);
    mkdirSync(join(dir, ".tenai", "attachments"), { recursive: true });
    const fresh = branchFor(p.email, title, id);
    const made = await Promise.allSettled(this.cfg.repos.map(async (repo): Promise<Slot> => {
      const t = repo.name === focus.name ? target ?? null : null;
      const branch = t ? branchOn(p.email, t, id) : fresh;
      const at = join(dir, repo.name);
      if (t) await this.workspace.createOn(repo, id, branch, t, at);
      else await this.workspace.create(repo, id, branch, at);
      return { repo: repo.name, dir: at, branch, target_branch: t, also_branches: repo.name === focus.name && also.length ? JSON.stringify(also) : null };
    }));
    const slots = made.flatMap((m) => (m.status === "fulfilled" ? [m.value] : []));
    const focusSlot = slots.find((x) => x.repo === focus.name);
    if (!focusSlot) {
      for (const sl of slots) await this.workspace.discard(this.repo(sl.repo), sl.dir, sl.branch);
      rmSync(dir, { recursive: true, force: true });
      const err = made[this.cfg.repos.indexOf(focus)];
      throw err.status === "rejected" ? err.reason : new Error("could not open the session");
    }
    for (const m of made) if (m.status === "rejected") console.error(`session ${id}: a repo failed to open: ${(m.reason as Error).message}`);
    this.db.query(
      `INSERT INTO term_sessions(id, email, model_id, repo, worktree, branch, provider, status, started, target_branch, also_branches)
       VALUES (?,?,?,?,?,?,?, 'active', ?, ?, ?)`,
    ).run(id, p.email, p.modelId, focus.name, dir, focusSlot.branch, this.provider.id, Date.now(), target ?? null, focusSlot.also_branches);
    for (const sl of slots) {
      this.db.query("INSERT INTO session_repos(session_id, repo, dir, branch, target_branch, also_branches) VALUES (?,?,?,?,?,?)")
        .run(id, sl.repo, sl.dir, sl.branch, sl.target_branch, sl.also_branches);
    }
    if (ticket) this.db.query("UPDATE term_sessions SET ticket = ? WHERE id = ?").run(JSON.stringify(ticket), id);
    this.ledger.append(p.email, "session.open", { sessionId: id, repo: focus.name, repos: slots.map((x) => x.repo), ticket: ticket?.key, branch: focusSlot.branch, target: target ?? null, also, modelId: p.modelId });
    this.spine.emit("session.start", p.email, focus.name, { sessionId: id, branch: focusSlot.branch, target: target ?? null, modelId: p.modelId });
    return this.session(id)!;
  }

  /**
   * An older single-repo session becomes one spanning every repo, keeping its worktree and any unshipped edits:
   * the worktree moves into the session folder next to fresh worktrees of the other repos. The agent's conversation
   * restarts (it is tied to the old folder). Returns false when there was nothing to do.
   */
  async upgrade(s: SessionRow): Promise<boolean> {
    if (s.status !== "active" || this.multi(s) || this.running.has(s.id) || !existsSync(s.worktree)) return false;
    const repo = this.repo(s.repo);
    const dir = this.workspace.sessionDir(s.id);
    const parked = `${dir}.upgrading`;
    await this.workspace.move(repo, s.worktree, parked);
    mkdirSync(join(dir, ".tenai", "attachments"), { recursive: true });
    const own = join(dir, repo.name);
    await this.workspace.move(repo, parked, own);
    const slots: Slot[] = [{ repo: repo.name, dir: own, branch: s.branch, target_branch: s.target_branch, also_branches: s.also_branches }];
    for (const other of this.cfg.repos.filter((r) => r.name !== repo.name)) {
      const at = join(dir, other.name);
      const branch = branchFor(s.email, "change", s.id);
      try {
        await this.workspace.create(other, s.id, branch, at);
        slots.push({ repo: other.name, dir: at, branch, target_branch: null, also_branches: null });
      } catch (e) {
        console.error(`upgrade ${s.id}: ${other.name}: ${(e as Error).message}`);
      }
    }
    for (const sl of slots) {
      this.db.query("INSERT INTO session_repos(session_id, repo, dir, branch, target_branch, also_branches) VALUES (?,?,?,?,?,?)")
        .run(s.id, sl.repo, sl.dir, sl.branch, sl.target_branch, sl.also_branches);
    }
    this.db.query("UPDATE term_sessions SET worktree = ?, provider_session = NULL WHERE id = ?").run(dir, s.id);
    this.lastCodeLabel.delete(s.id);
    this.ledger.append(s.email, "session.upgraded", { sessionId: s.id, repos: slots.map((x) => x.repo) });
    return true;
  }

  /** The repos of a session, the one it focuses on first. Older single-repo sessions have exactly one, at the session folder. */
  slots(s: SessionRow): Slot[] {
    const rows = this.db.query("SELECT repo, dir, branch, target_branch, also_branches FROM session_repos WHERE session_id = ?").all(s.id) as Slot[];
    if (!rows.length) return [{ repo: s.repo, dir: s.worktree, branch: s.branch, target_branch: s.target_branch, also_branches: s.also_branches }];
    return rows.sort((a, b) => Number(b.repo === s.repo) - Number(a.repo === s.repo) || a.repo.localeCompare(b.repo));
  }

  multi(s: SessionRow): boolean {
    return !!this.db.query("SELECT 1 FROM session_repos WHERE session_id = ?").get(s.id);
  }

  /** Files changed in this repo that are not yet pushed (nothing, right after a /ship, until the next edit). */
  async unshipped(s: SessionRow, sl: Slot): Promise<string[]> {
    const repo = this.repo(sl.repo);
    const files = await this.workspace.changedFiles(sl.dir, sl.target_branch ?? repo.baseBranch);
    if (!files.length) return [];
    const last = this.db.query("SELECT sha FROM changes WHERE session_id = ? AND repo = ? AND branch = ? ORDER BY ts DESC LIMIT 1")
      .get(s.id, sl.repo, sl.target_branch ?? sl.branch) as { sha: string } | null;
    if (last && (await this.workspace.headClean(sl.dir)) === last.sha) return [];
    return files;
  }

  /**
   * Point one repo of the session at an existing branch (or back to a fresh branch with target null), with extra
   * branches /ship copies the commit onto. Local only — nothing is pushed. Refused while that repo has unshipped changes.
   */
  async useBranch(p: Principal, sessionId: string, repoName: string, target: string | null, also: string[] = [], by: "user" | "agent" = "user"): Promise<Slot> {
    const s = this.owned(p, sessionId);
    if (s.status !== "active") throw new Error(`This session is ${s.status}.`);
    if (!this.multi(s)) throw new Error("This session is from an older TenAI version and holds one repo. Start a new one with /new to work across repos.");
    if (by === "user" && this.running.has(sessionId)) throw new Error("Wait for the running turn to finish (or Esc) before switching branches.");
    const repo = this.repo(repoName);
    const sl = this.slots(s).find((x) => x.repo === repo.name);
    if (!sl) throw new Error(`${repo.name} is not part of this session.`);
    if (target) {
      const why = targetAllowed(repo, target);
      if (why) throw new Error(why);
    }
    const extra = await this.checkAlso(repo, also.filter((b) => b !== target));
    const alsoJson = extra.length ? JSON.stringify(extra) : null;
    if ((target ?? null) !== sl.target_branch) {
      const left = await this.unshipped(s, sl);
      if (left.length) {
        throw new Error(`${repo.name} has unshipped changes on ${sl.target_branch ?? sl.branch} (${left.slice(0, 4).join(", ")}${left.length > 4 ? " …" : ""}). Ship them (/ship) or undo them before switching it to ${target ?? "a fresh branch"}.`);
      }
      if (target && !(await this.workspace.branches(repo)).includes(target)) throw new Error(`No branch “${target}” in ${repo.name}. Search with /branches or \`tenai branches ${repo.name} <word>\`.`);
      await this.workspace.discard(repo, sl.dir, sl.branch);
      const branch = target ? branchOn(s.email, target, s.id) : branchFor(s.email, "change", s.id);
      try {
        if (target) await this.workspace.createOn(repo, s.id, branch, target, sl.dir);
        else await this.workspace.create(repo, s.id, branch, sl.dir);
      } catch (e) {
        // never leave the repo missing from the session: fall back to a fresh branch
        if (target) await this.workspace.create(repo, s.id, branchFor(s.email, "change", s.id), sl.dir).catch(() => undefined);
        const back = branchFor(s.email, "change", s.id);
        this.db.query("UPDATE session_repos SET branch = ?, target_branch = NULL, also_branches = NULL WHERE session_id = ? AND repo = ?").run(back, s.id, repo.name);
        throw e;
      }
      sl.branch = branch;
      this.spine.release(s.id, s.email, repo.name);
    }
    sl.target_branch = target;
    sl.also_branches = alsoJson;
    this.db.query("UPDATE session_repos SET branch = ?, target_branch = ?, also_branches = ? WHERE session_id = ? AND repo = ?")
      .run(sl.branch, target, alsoJson, s.id, repo.name);
    // the session's headline (status bar, /who) follows the repo last switched
    this.db.query("UPDATE term_sessions SET repo = ?, branch = ?, target_branch = ?, also_branches = ? WHERE id = ?").run(repo.name, sl.branch, target, alsoJson, s.id);
    this.ledger.append(p.email, "session.use", { sessionId: s.id, repo: repo.name, target, also: extra, by });
    this.spine.emit("session.branch", s.email, repo.name, { sessionId: s.id, target, also: extra, by });
    this.send(s.id, { type: "session.repos", sessionId: s.id, repos: this.repoView(this.session(s.id)!) });
    return sl;
  }

  repoView(s: SessionRow) {
    return this.slots(s).map((x) => ({ repo: x.repo, branch: x.branch, target: x.target_branch, also: alsoOf(x) }));
  }

  /** After a session ends: drop the worktrees that hold nothing unshipped (kept otherwise, so no work is lost). */
  async cleanup(s: SessionRow): Promise<void> {
    if (!this.multi(s)) return;
    for (const r of this.cfg.repos) await this.workspace.dropRefs(r, s.id).catch(() => undefined); // checkpoints
    let kept = 0;
    for (const sl of this.slots(s)) {
      if (!existsSync(sl.dir)) continue;
      const left = await this.unshipped(s, sl).catch(() => ["?"]);
      if (left.length) { kept++; continue; }
      await this.workspace.discard(this.repo(sl.repo), sl.dir, sl.branch);
    }
    if (!kept) rmSync(s.worktree, { recursive: true, force: true });
  }

  /** On start-up: clean up after sessions that ended while the server was down or before cleanup existed. */
  async sweep(): Promise<void> {
    const ended = this.db.query("SELECT * FROM term_sessions WHERE status != 'active' AND ended > ?").all(Date.now() - 30 * 86_400_000) as SessionRow[];
    for (const s of ended) if (existsSync(s.worktree)) await this.cleanup(s).catch(() => undefined);
  }

  /** Every extra branch must exist and be one people may push to; the first bad one is reported. */
  private async checkAlso(repo: RepoConfig, names: string[]): Promise<string[]> {
    const uniq = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (uniq.length > 5) throw new Error("At most 5 extra branches per session.");
    if (!uniq.length) return [];
    const all = new Set(await this.workspace.branches(repo));
    for (const b of uniq) {
      const why = targetAllowed(repo, b);
      if (why) throw new Error(why);
      if (!all.has(b)) throw new Error(`No branch “${b}” in ${repo.name}. Use /branches to search.`);
    }
    return uniq;
  }

  /** Change which further branches /ship copies the commit onto (replaces the list; [] clears it). */
  async setAlso(p: Principal, sessionId: string, names: string[]): Promise<SessionRow> {
    const s = this.owned(p, sessionId);
    if (this.multi(s)) {
      await this.useBranch(p, sessionId, s.repo, s.target_branch, names);
      return this.session(s.id)!;
    }
    const also = await this.checkAlso(this.repo(s.repo), names.filter((b) => b !== s.target_branch));
    this.db.query("UPDATE term_sessions SET also_branches = ? WHERE id = ?").run(also.length ? JSON.stringify(also) : null, s.id);
    this.ledger.append(p.email, "session.also", { sessionId: s.id, also });
    return this.session(s.id)!;
  }

  end(p: Principal, sessionId: string): void {
    const s = this.owned(p, sessionId);
    if (s.email !== p.email && p.role !== "admin") throw new Error("Only the session's owner can end it. /leave drops you out.");
    this.cancel(sessionId);
    this.db.query("UPDATE term_sessions SET status = 'ended', ended = ? WHERE id = ?").run(Date.now(), sessionId);
    this.spine.release(sessionId, p.email, s.repo);
    this.spine.emit("session.end", p.email, s.repo, { sessionId });
    this.ledger.append(p.email, "session.end", { sessionId });
    void this.cleanup(s).catch((e) => console.error(`cleanup ${sessionId}: ${(e as Error).message}`));
  }

  /** The owner, an invited member, or an admin may work in a session. */
  owned(p: Principal, sessionId: string): SessionRow {
    const s = this.session(sessionId);
    if (!s || (s.email !== p.email && p.role !== "admin" && !this.isMember(sessionId, p.email))) throw new Error("Session not found");
    return s;
  }

  isMember(sessionId: string, email: string): boolean {
    return !!this.db.query("SELECT 1 FROM session_members WHERE session_id = ? AND email = ?").get(sessionId, email);
  }

  // ---- pairing ----

  /** A teammate by email, email name ("alex.morgan") or display name ("Alex"). They must have signed in once. */
  findPerson(who: string): { email: string; name: string } {
    const w = who.trim().replace(/^@/, "").toLowerCase();
    const all = this.db.query("SELECT email, name FROM users WHERE blocked = 0").all() as Array<{ email: string; name: string }>;
    const exact = all.filter((u) => u.email === w || u.email.split("@")[0] === w || u.name.toLowerCase() === w);
    const loose = exact.length ? exact : all.filter((u) => u.email.split("@")[0].includes(w) || u.name.toLowerCase().includes(w));
    if (!loose.length) throw new Error(`No one called “${who}” has signed in to TenAI yet. They need to install it and sign in once.`);
    if (loose.length > 1) throw new Error(`“${who}” matches ${loose.slice(0, 5).map((u) => u.email).join(", ")} — use the email.`);
    return loose[0];
  }

  members(p: Principal, sessionId: string) {
    const s = this.owned(p, sessionId);
    const owner = this.db.query("SELECT email, name FROM users WHERE email = ?").get(s.email) as { email: string; name: string };
    const rest = this.db.query("SELECT u.email, u.name, m.added_by, m.added_at FROM session_members m JOIN users u ON u.email = m.email WHERE m.session_id = ? ORDER BY m.added_at").all(s.id) as Array<{ email: string; name: string; added_by: string; added_at: number }>;
    return { owner, members: rest };
  }

  invite(p: Principal, sessionId: string, who: string) {
    const s = this.owned(p, sessionId);
    if (s.status !== "active") throw new Error(`This session is ${s.status}.`);
    const u = this.findPerson(who);
    if (u.email === s.email) throw new Error(`${u.name} owns this session already.`);
    this.db.query("INSERT INTO session_members(session_id, email, added_by, added_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run(s.id, u.email, p.email, Date.now());
    this.ledger.append(p.email, "session.invite", { sessionId: s.id, member: u.email });
    this.send(s.id, { type: "hint", sessionId: s.id, text: `🤝 ${p.name} invited ${u.name} into this session` });
    return { session: s, person: u };
  }

  /** Give the session to someone else: they own it from now on (and its agent conversation); you stay in as a member. */
  handoff(p: Principal, sessionId: string, who: string) {
    const s = this.owned(p, sessionId);
    if (s.email !== p.email && p.role !== "admin") throw new Error("Only the session's owner can hand it over.");
    if (this.running.has(sessionId)) throw new Error("Wait for the running turn to finish before handing over.");
    const u = this.findPerson(who);
    if (u.email === s.email) throw new Error(`${u.name} already owns it.`);
    this.db.query("UPDATE term_sessions SET email = ? WHERE id = ?").run(u.email, s.id);
    this.db.query("DELETE FROM session_members WHERE session_id = ? AND email = ?").run(s.id, u.email);
    this.db.query("INSERT INTO session_members(session_id, email, added_by, added_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run(s.id, s.email, p.email, Date.now());
    this.ledger.append(p.email, "session.handoff", { sessionId: s.id, from: s.email, to: u.email });
    this.send(s.id, { type: "hint", sessionId: s.id, text: `🔁 ${p.name} handed this session to ${u.name}` });
    return { session: this.session(s.id)!, person: u };
  }

  leave(p: Principal, sessionId: string): void {
    const s = this.owned(p, sessionId);
    if (s.email === p.email) throw new Error("You own this session — /handoff <name> to give it to someone, or /end it.");
    this.db.query("DELETE FROM session_members WHERE session_id = ? AND email = ?").run(s.id, p.email);
    this.ledger.append(p.email, "session.leave", { sessionId: s.id });
    this.send(s.id, { type: "hint", sessionId: s.id, text: `👋 ${p.name} left this session` });
  }

  /** How a session is named to the people invited into it. */
  label(s: SessionRow): string {
    const t = ticketOf(s);
    return t ? `${t.key} · ${t.summary.slice(0, 60)}` : `${s.repo}${s.target_branch ? ` ⎇ ${s.target_branch}` : ""}`;
  }

  // ---- admin ----
  block(sessionId: string, by: string, reason: string): void {
    const s = this.session(sessionId);
    if (!s) return;
    this.cancel(sessionId);
    this.db.query("UPDATE term_sessions SET status = 'blocked', ended = ? WHERE id = ?").run(Date.now(), sessionId);
    this.spine.release(sessionId, s.email, s.repo);
    this.ledger.append(by, "session.blocked", { sessionId, email: s.email, reason });
    this.send(sessionId, { type: "session.blocked", sessionId, reason });
  }

  frozen(): boolean {
    return (this.db.query("SELECT value FROM settings WHERE key = 'frozen'").get() as { value: string } | null)?.value === "1";
  }

  setFrozen(on: boolean, by: string): void {
    this.db.query("INSERT INTO settings(key, value) VALUES ('frozen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? "1" : "0");
    if (on) for (const id of [...this.running.keys()]) this.cancel(id);
    this.ledger.append(by, on ? "freeze.on" : "freeze.off", {});
  }

  cancel(sessionId: string): void {
    this.running.get(sessionId)?.abort();
  }

  tokensToday(email: string): number {
    const since = new Date().setHours(0, 0, 0, 0);
    const r = this.db.query("SELECT COALESCE(SUM(input_tokens + output_tokens + cache_write), 0) AS t FROM usage WHERE email = ? AND ts >= ?").get(email, since) as { t: number };
    return r.t;
  }

  // ---- turns ----
  async submit(p: Principal, sessionId: string, text: string, attachments: string[] = []): Promise<void> {
    const s = this.owned(p, sessionId);
    const turnId = randomUUID();
    const prompt = redact(text);
    const record = (outcome: string, extra: { label?: string; score?: number; detail?: string; gate?: GateDecision } = {}) =>
      this.db.query(`INSERT INTO turns(id, session_id, email, prompt, gate_label, gate_score, outcome, detail, started, ended,
                       gate_version, shadow_label, shadow_score, shadow_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(turnId, sessionId, p.email, prompt, extra.label ?? null, extra.score ?? null, outcome, extra.detail ?? null, Date.now(),
          outcome === "queued" ? null : Date.now(), extra.gate?.version ?? null, extra.gate?.shadow?.label ?? null,
          extra.gate?.shadow?.score ?? null, extra.gate?.shadow?.version ?? null);
    const review = (reason: "refused" | "borderline", gate: GateDecision) =>
      this.db.query(`INSERT INTO gate_reviews(id, turn_id, email, text, model_label, model_score, model_version, reason, created)
                     VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(), turnId, p.email, prompt, gate.label, gate.score, gate.version ?? null, reason, Date.now());
    const refuse = (reason: string, rule?: string, label?: string) => {
      this.ledger.append(p.email, "turn.refused", { sessionId, turnId, rule, label });
      this.send(sessionId, { type: "gate.refused", sessionId, reason, rule, label });
    };

    if (s.status !== "active") { record("refused", { detail: "session " + s.status }); return refuse(`This session is ${s.status}.`, "session"); }
    // in a shared session everyone sees who asked what
    this.send(sessionId, { type: "turn.prompt", sessionId, turnId, email: p.email, name: p.name, text: prompt.slice(0, 2000) });
    if (this.frozen()) { record("refused", { detail: "frozen" }); return refuse("TenAI is paused by an admin. Try again later.", "frozen"); }
    if (this.running.has(sessionId)) { return this.send(sessionId, { type: "error", message: "A turn is already running in this session. Cancel it or wait." }); }

    const guard = checkPrompt(text);
    if (!guard.allowed) { record("refused", { label: "guardrail", detail: guard.rule }); return refuse(guard.reason!, guard.rule); }

    const prev = this.lastCodeLabel.get(sessionId);
    const gate = await classify(text, {
      sidecarUrl: this.cfg.intentSidecarUrl,
      previousCodeLabel: prev && Date.now() - prev.at < FOLLOW_UP_WINDOW_MS ? prev.label : null,
    });
    if (!gate.allowed) {
      record("refused", { label: gate.label, score: gate.score, detail: gate.source, gate });
      if (gate.score < CONFIDENT_REFUSAL) review("refused", gate); // a sure "tell me a joke" teaches nothing; /appeal still reaches the inbox
      return refuse(gate.clarify ?? REFUSAL, "intent", gate.label);
    }
    if (gate.source !== "followup" && gate.score < BORDERLINE) review("borderline", gate);
    this.lastCodeLabel.set(sessionId, { label: gate.label, at: Date.now() });

    const budget = (this.db.query("SELECT daily_token_budget FROM users WHERE email = ?").get(p.email) as { daily_token_budget: number }).daily_token_budget;
    if (this.tokensToday(p.email) >= budget) { record("refused", { detail: "budget" }); return refuse("You have used today's token budget. It resets at midnight.", "budget"); }

    record("queued", { label: gate.label, score: gate.score, detail: gate.source, gate });
    this.ledger.append(p.email, "turn.queued", { sessionId, turnId, label: gate.label, score: gate.score });
    const ctl = new AbortController();
    this.running.set(sessionId, ctl);

    await this.acquire(sessionId);
    try {
      if (ctl.signal.aborted) throw new Error("cancelled");
      await this.execute(p, s, turnId, text, attachments, ctl.signal);
    } finally {
      this.running.delete(sessionId);
      this.release();
    }
  }

  private acquire(sessionId: string): Promise<void> {
    if (this.active < this.cfg.maxConcurrentTurns) { this.active++; return Promise.resolve(); }
    return new Promise((resolve) => {
      this.queue.push(() => { this.active++; resolve(); });
      this.send(sessionId, { type: "queue.position", sessionId, position: this.queue.length });
    });
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }

  private systemPrompt(s: SessionRow, repo: RepoConfig, myWork: string): string {
    const also = alsoOf(s);
    const ctxFile = join(this.cfg.home, "context", `${repo.name}.md`);
    const repoContext = existsSync(ctxFile) ? readFileSync(ctxFile, "utf8").slice(0, 8000) : "";
    return [
      `You are a TenAI coding agent working for ${s.email} on the OpenWallet repository "${repo.name}".`,
      s.target_branch
        ? `Your working directory is a git worktree on top of the existing branch ${s.target_branch} (the user chose it). When they /ship, your work is pushed straight onto ${s.target_branch} as one commit — so build on what is already there.`
        : `Your working directory is a git worktree on branch ${s.branch}, created from ${repo.baseBranch}. /ship opens a merge request into ${repo.baseBranch}.`,
      also.length
        ? `On /ship the same commit is also copied (cherry-picked) onto: ${also.join(", ")}. Before changing a file, check it looks the same there (\`git diff ${s.target_branch ? "origin/" + s.target_branch : "HEAD"} scan/<branch> -- <path>\`); if a branch differs in the code you touch, tell the user — that copy may conflict and then needs its own session.`
        : "",
      `- Every remote branch of this repo is readable as scan/<name>: \`git log origin/${repo.baseBranch}..scan/<name>\`, \`git diff origin/${repo.baseBranch}...scan/<name> --stat\`, \`git show scan/<name>:<path>\`.`,
      "- You cannot switch branches yourself. When the user wants to change existing branches (\"my branch\", \"my developer portal changes\", \"feature/x\"), find them (the list below, or scan/ refs), explain what is on them, and give the exact command to type: " +
        "`/branch <repo>:<name>` for one branch, or `/branch <repo>:<name> <other> …` when the same change belongs on several branches of that repo (e.g. a feature branch and its port to another base) — /ship then pushes onto the first and copies the commit to the others. " +
        "Put each command alone in inline backticks on its own line. One session covers one repo: work spanning repos (backend + portal UI) needs one /branch per repo, done one after the other. Never push yourself.",
      "Rules you must follow:",
      "- Check the request against its goal before you build it. When the user states a problem (\"it goes negative\", \"shows the wrong fee\") and also prescribes a fix, test the fix against the problem with a concrete example. If it would not solve it (e.g. \"discount between min and max\" still lets a flat 10 exceed a 5 transaction), say so FIRST, in one or two lines with the counter-example and the rule that would work, then ask which they want before editing. Do the same when a change would break other callers, double-count, or contradict existing behaviour. Never silently implement something you can see won't achieve what they want.",
      "- Only work on this codebase: read, explain, and change code. Never operate databases, Vault, servers or deployments.",
      "- Commit with plain messages (no Co-Authored-By or 'Generated with' lines). Never push; the user ships with /ship, which opens a merge request.",
      `- You may run git status/diff/log/add/commit and this repo's build/test commands: ${repo.allowedCommands.join(", ") || "none"}. Nothing else.`,
      "- Match the surrounding code's style. Keep changes focused on the request. Say clearly what you changed and what you could not verify.",
      "- Never reveal credentials, tokens or file contents outside this repository.",
      `- Today is ${new Date().toISOString().slice(0, 10)}. For "who changed what / what did X do / what was merged" questions, use git history: ` +
        `\`git log -i --author=<name> --since="<when>" --stat -- <path>\`, \`git log --merges --since=...\`, \`git show <sha> --stat\`. ` +
        `This worktree has ${repo.baseBranch}'s full history; merged MRs are "Merge branch ... into ${repo.baseBranch}" commits. ` +
        "One plain git command per call (no pipes). Answer with dates, authors, commit/MR titles, the files touched and a short plain summary of what changed.",
      repoContext ? `\n## Repository context\n${repoContext}` : "",
      myWork,
      this.spine.digest(repo.name, s.id),
      this.extraContext?.(repo.name, repo.baseBranch, s.branch, s.id) ?? "",
    ].filter(Boolean).join("\n");
  }

  /** A session over every repo: the agent works like an engineer with all of them checked out side by side. */
  private multiPrompt(s: SessionRow, slots: Slot[], myWork: string): string {
    const ship = (sl: Slot) => {
      const base = this.repo(sl.repo).baseBranch;
      const also = alsoOf(sl);
      return (sl.target_branch ? `on the existing branch ${sl.target_branch} — /ship pushes onto it` : `fresh branch from ${base} — /ship opens a merge request into ${base}`) +
        (also.length ? `, then copies the commit onto ${also.join(", ")}` : "");
    };
    const pack = (sl: Slot, max: number) => {
      const f = join(this.cfg.home, "context", `${sl.repo}.md`);
      return existsSync(f) ? readFileSync(f, "utf8").slice(0, max) : "";
    };
    return [
      `You are a TenAI coding agent working for ${s.email} across OpenWallet's repositories. Your working directory holds one git worktree per repository, side by side:`,
      ...slots.map((sl) => `- ${sl.repo}/ — ${ship(sl)}`),
      ticketOf(s) ? `This session is for Jira ticket ${ticketOf(s)!.key} (${ticketOf(s)!.url}): “${ticketOf(s)!.summary}”. Keep the work to that ticket.` : "",
      "What the team calls them: \"Admin Console\", \"Admin Console FE\", \"admin panel\" = admin-console (Angular); \"BE\", \"backend\", \"API\", service names like IncentiveEngine or Transaction = core-api (Java); \"developer portal\", \"DP\" = developer-portal-global (Angular).",
      "- When the user names a repo or product (\"in Admin Console\", \"FE only\"), change only that one. Touch another repo only if they ask, or if the change can't work without it — and then say so before editing it. If you think the other side also needs a fix, suggest it instead of making it.",
      "- When a request spans repos (an API plus the screen that calls it), change all of them in the same turn and keep them consistent (paths, field names, DTOs).",
      "## Git and branches",
      "- Run git inside one repo with `git -C <repo> <command>` (status, diff, log, show, blame, add, commit, restore, stash). One plain command per call: no pipes, chaining or redirection.",
      "- Every remote branch of a repo is readable as scan/<name>: `git -C <repo> log origin/<base>..scan/<name>`, `git -C <repo> diff origin/<base>...scan/<name> --stat`, `git -C <repo> show scan/<name>:<path>`.",
      "- You switch branches yourself with the `tenai` command (local only, nothing is pushed):",
      "  `tenai status` — each repo's branch and its unshipped files",
      "  `tenai branches <repo> <word>` — search a repo's branches",
      "  `tenai use <repo> <branch> [<branch> …]` — work on an existing branch; extra branches get the same commit copied on /ship (e.g. a feature branch and its port to another base)",
      "  `tenai use <repo> --fresh` — back to a fresh branch from the base",
      "  `tenai contracts` — backend DTO fields / endpoint paths this session removed or renamed, and where Admin Console / the portal still use them. Run it after any backend API change and update those callers in the same turn; /ship refuses while callers would break.",
      "  `tenai check [<repo> [module]]` — compile: TypeScript type-check for the Angular repos, Gradle compileJava of the changed modules for core-api. With no repo it checks every repo you changed.",
      "- After changing code, run `tenai check` and fix what it reports before you say you're done; report the result. Don't run npm, npx, tsc, gradle or mvn yourself — they are blocked; `tenai check` is the way. A Gradle check is refused while build files (build.gradle, settings.gradle, gradle.properties) are changed.",
      "- When the user refers to existing work (“my branch”, “my developer portal changes”, a ticket or branch name), find it (the list below, or scan/ refs) and switch each repo involved before editing. " +
        "If it is clear which branches they mean, just switch and say so; if several branches could fit, ask which. Changes on a branch that also lives on a sibling copy usually belong on both — list both in `tenai use`, after checking with `git -C <repo> diff scan/<a> scan/<b> -- <path>` that the code you touch is the same there.",
      "- A repo with unshipped changes can't be switched; tell the user to /ship first.",
      "- Never push. The user types /ship <message>, which ships every repo you changed (merge request or push, as listed above).",
      "## Rules",
      "- Check the request against its goal before you build it. When the user states a problem (\"it goes negative\", \"shows the wrong fee\") and also prescribes a fix, test the fix against the problem with a concrete example. If it would not solve it (e.g. \"discount between min and max\" still lets a flat 10 exceed a 5 transaction), say so FIRST, in one or two lines with the counter-example and the rule that would work, then ask which they want before editing. Do the same when a change would break other callers, double-count, or contradict existing behaviour. Never silently implement something you can see won't achieve what they want.",
      "- Only work on code: read, explain, change. Never operate databases, Vault, servers or deployments.",
      "- Commit with plain messages (no Co-Authored-By or 'Generated with' lines) — or leave changes uncommitted; /ship squashes them per repo.",
      "- Match the surrounding code's style. Keep changes focused. Say clearly what you changed in which repo and what you could not verify.",
      "- Never reveal credentials, tokens or anything outside these repositories.",
      `- Today is ${new Date().toISOString().slice(0, 10)}. For history questions use \`git -C <repo> log -i --author=<name> --since="<when>" --stat -- <path>\`, \`git -C <repo> log --merges --since=...\`, \`git -C <repo> show <sha> --stat\`; ` +
        'merged MRs are "Merge branch ... into <base>" commits. Answer with dates, authors, titles, files and a short plain summary.',
      this.recap(s),
      myWork,
      ...slots.map((sl, i) => {
        const ctx = pack(sl, i === 0 ? 6000 : 2500);
        const extra = this.extraContext?.(sl.repo, this.repo(sl.repo).baseBranch, sl.branch, s.id) ?? "";
        return [`\n# ${sl.repo}`, ctx, this.spine.digest(sl.repo, s.id, i === 0 ? 5000 : 1500), i === 0 ? extra : extra.slice(0, 1200)].filter(Boolean).join("\n");
      }),
    ].filter(Boolean).join("\n");
  }

  /**
   * When the agent's conversation starts over inside an existing session (upgrade, lost conversation), it gets the
   * earlier turns back as a recap — otherwise it forgets what it already found, warned about or agreed with the user.
   */
  private recap(s: SessionRow): string {
    if (s.provider_session) return "";
    const turns = this.db.query(`SELECT t.id, t.prompt FROM turns t WHERE t.session_id = ? AND t.outcome IN ('done', 'failed', 'cancelled')
      ORDER BY t.started DESC LIMIT 6`).all(s.id) as Array<{ id: string; prompt: string }>;
    if (!turns.length) return "";
    const lines = ["## Earlier in this session (your previous conversation was reset; this is what was said — keep any warnings and open questions in mind)"];
    for (const t of turns.reverse()) {
      const said = (this.db.query("SELECT text FROM turn_events WHERE turn_id = ? AND kind = 'text' ORDER BY seq").all(t.id) as Array<{ text: string }>).map((x) => x.text).join(" ");
      lines.push(`- User: ${t.prompt.slice(0, 400)}`, `  You: ${said.replace(/\s+/g, " ").slice(-900)}`);
    }
    return lines.join("\n").slice(0, 7000);
  }

  /** Compile one repo of the session, or every repo with unshipped changes. */
  async check(p: Principal, sessionId: string, repoName?: string, module?: string) {
    if (!this.checks) throw new Error("build checks are not set up on this server");
    const s = this.owned(p, sessionId);
    const out: Array<{ repo: string } & import("./checks").CheckResult> = [];
    for (const sl of this.slots(s)) {
      if (repoName && sl.repo !== repoName) continue;
      const repo = this.repo(sl.repo);
      const changed = await this.workspace.changedFiles(sl.dir, sl.target_branch ?? repo.baseBranch);
      if (!repoName && !changed.length) continue;
      const r = await this.checks.run(repo, sl.dir, changed, module);
      this.ledger.append(p.email, "check", { sessionId: s.id, repo: sl.repo, ok: r.ok, command: r.command, seconds: r.seconds });
      out.push({ repo: sl.repo, ...r });
    }
    if (!out.length) throw new Error(repoName ? `${repoName} is not part of this session` : "nothing changed yet, so nothing to check");
    return out;
  }

  /** The agent's `tenai` command, called back over loopback with the running turn's key. */
  async agentRun(key: string, args: string[]): Promise<string> {
    const k = this.agentKeys.get(key);
    if (!k) throw new Error("not inside a running TenAI turn");
    const s = this.session(k.sessionId)!;
    const p = { email: s.email, role: "user" } as Principal;
    const [cmd, repoName, ...rest] = args;
    const lines = (sl: Slot, files: string[]) =>
      `${sl.repo}: ${sl.target_branch ? `on ${sl.target_branch} (ships onto it)` : `fresh branch ${sl.branch} (ships as a merge request into ${this.repo(sl.repo).baseBranch})`}` +
      `${alsoOf(sl).length ? `; also copies to ${alsoOf(sl).join(", ")}` : ""}; ${files.length ? `unshipped: ${files.slice(0, 8).join(", ")}${files.length > 8 ? " …" : ""}` : "no unshipped changes"}`;
    switch (cmd) {
      case "status": {
        const out = [];
        for (const sl of this.slots(s)) out.push(lines(sl, await this.unshipped(s, sl)));
        return out.join("\n");
      }
      case "branches": {
        if (!repoName) return "usage: tenai branches <repo> [word]";
        const repo = this.repo(repoName);
        const names = await this.workspace.branches(repo, rest.join(" "));
        if (!names.length) return `no branches in ${repo.name} match “${rest.join(" ")}”`;
        return names.slice(0, 40).map((n) => `${n}${targetAllowed(repo, n) ? "  (protected: merge request only)" : ""}${this.findMr?.(repo.name, n) ? `  (open MR)` : ""}`).join("\n") +
          (names.length > 40 ? `\n… ${names.length - 40} more, narrow the word` : "");
      }
      case "use": {
        if (!repoName || !rest.length) return "usage: tenai use <repo> <branch> [<branch> …]   or   tenai use <repo> --fresh";
        const fresh = rest[0] === "--fresh";
        const sl = await this.useBranch(p, s.id, repoName, fresh ? null : rest[0], fresh ? [] : rest.slice(1), "agent");
        this.send(s.id, { type: "hint", sessionId: s.id, text: `⎇ ${sl.repo} → ${sl.target_branch ?? "a fresh branch"}${alsoOf(sl).length ? ` (+ copies to ${alsoOf(sl).join(", ")})` : ""}` });
        return `ok — ${lines(sl, [])}. Its files in ${sl.repo}/ are now that branch's.`;
      }
      case "contracts": {
        const found = await this.contracts(p, s.id);
        if (!found.length) return "No backend field or endpoint was removed or renamed in this session.";
        return found.map((f) => `${f.kind} “${f.name}” removed/renamed in ${f.repo}/${f.file}` +
          (f.uses.length ? ` — STILL USED:\n${f.uses.map((u) => `    ${u.repo}/${u.file}:${u.line}  ${u.text}`).join("\n")}` : " — no use found in the other repos")).join("\n");
      }
      case "check": {
        const out = await this.check(p, s.id, repoName, rest[0]);
        return out.map((r) => `${r.repo}: ${r.ok ? "OK" : "FAILED"} (${r.command}, ${r.seconds}s)\n${r.output}`).join("\n\n");
      }
      default:
        return "tenai commands: status | branches <repo> [word] | use <repo> <branch> [more…] | use <repo> --fresh | check [<repo> [module]]";
    }
  }

  private async execute(p: Principal, s: SessionRow, turnId: string, text: string, attachments: string[], signal: AbortSignal): Promise<void> {
    const repo = this.repo(s.repo);
    this.db.query("UPDATE turns SET outcome = 'running' WHERE id = ?").run(turnId);
    await this.checkpoint(s, `the turn “${text.replace(/\s+/g, " ").slice(0, 80)}”`, turnId).catch((e) => console.error(`checkpoint ${s.id}: ${(e as Error).message}`));
    this.send(s.id, { type: "turn.start", sessionId: s.id, turnId });
    this.step(turnId, "start", null, redact(text));
    const files = attachments.map((a) => join(s.worktree, ".tenai", "attachments", a.replace(/[^\w.-]/g, "")));
    const prompt = files.length
      ? `${text}\n\nThe user attached ${files.length} file${files.length === 1 ? "" : "s"} (screenshots/logs). Open each with the Read tool before answering — images are shown to you:\n${files.map((f) => `- ${f}`).join("\n")}`
      : text;

    const myWork = (await this.myWork?.(s.email, repo.name).catch(() => "")) ?? "";
    const multi = this.multi(s);
    const slotsNow = this.slots(s);
    const agentKey = randomBytes(24).toString("hex");
    this.agentKeys.set(agentKey, { sessionId: s.id });
    let finalText = "";
    let failed: string | null = null;
    const timer = setTimeout(() => this.cancel(s.id), this.cfg.turnTimeoutMs);
    try {
      for await (const ev of this.provider.startTurn({
        sessionRef: s.provider_session ?? undefined, prompt,
        systemAppend: multi ? this.multiPrompt(s, slotsNow, myWork) : this.systemPrompt(s, repo, myWork),
        tools: {
          worktree: s.worktree, allowedCommands: [...new Set(slotsNow.flatMap((sl) => this.repo(sl.repo).allowedCommands))],
          binDir: multi ? this.cfg.agentBinDir : undefined,
          env: multi ? { TENAI_AGENT_KEY: agentKey, TENAI_AGENT_URL: `http://127.0.0.1:${this.cfg.port}` } : undefined,
        },
        model: this.modelNow?.() ?? this.cfg.model, signal,
      })) {
        switch (ev.kind) {
          case "session":
            if (ev.sessionRef !== s.provider_session) {
              this.db.query("UPDATE term_sessions SET provider_session = ? WHERE id = ?").run(ev.sessionRef, s.id);
              s.provider_session = ev.sessionRef;
            }
            break;
          case "text":
            this.send(s.id, { type: "turn.text", sessionId: s.id, turnId, text: redact(ev.text) });
            this.step(turnId, "text", null, redact(ev.text));
            break;
          case "tool_use": {
            const path = typeof ev.input.file_path === "string" ? ev.input.file_path : undefined;
            const summary = redact(path ? relative(s.worktree, path) : String(ev.input.command ?? ev.input.pattern ?? ""));
            this.send(s.id, { type: "turn.tool", sessionId: s.id, turnId, name: ev.name, summary });
            this.step(turnId, "tool", ev.name, summary);
            // which repo of the session the file is in (slots can change mid-turn via `tenai use`)
            const sl = path ? this.slots(s).find((x) => path === x.dir || path.startsWith(x.dir + "/")) : undefined;
            if ((ev.name === "Edit" || ev.name === "Write") && path && sl) {
              const rel = relative(sl.dir, path);
              const hits = this.spine.claim(s.id, p.email, sl.repo, [rel]);
              if (hits.length) {
                this.send(s.id, { type: "collision.warning", sessionId: s.id, paths: [rel], with: hits.map((h) => ({ email: h.email, path: h.path })) });
              }
              const hint = this.claimHints?.(sl.repo, rel, sl.target_branch ?? sl.branch, s.id);
              const seen = this.hinted.get(s.id) ?? new Set<string>();
              this.hinted.set(s.id, seen);
              for (const m of hint?.mrs ?? []) {
                if (seen.has(`mr${m.iid}:${rel}`)) continue;
                seen.add(`mr${m.iid}:${rel}`);
                this.send(s.id, { type: "collision.warning", sessionId: s.id, paths: [rel], with: [{ email: `open MR !${m.iid} · ${m.author}`, path: rel }] });
              }
              for (const b of hint?.branches ?? []) {
                if (seen.has(`br${b.name}:${rel}`)) continue;
                seen.add(`br${b.name}:${rel}`);
                this.send(s.id, { type: "collision.warning", sessionId: s.id, paths: [rel], with: [{ email: `${b.author}'s branch ${b.name}`, path: rel }] });
              }
              for (const n of hint?.notes ?? []) {
                if (seen.has(`note:${n.text}`)) continue;
                seen.add(`note:${n.text}`);
                this.send(s.id, { type: "hint", sessionId: s.id, text: `📌 ${n.path ? n.path + ": " : ""}${n.text} — ${n.email.split("@")[0]}` });
              }
            }
            break;
          }
          case "tool_result":
            if (ev.denied) {
              this.ledger.append(p.email, "tool.denied", { sessionId: s.id, turnId, detail: redact(ev.text).slice(0, 300) });
              this.step(turnId, "denied", null, redact(ev.text).replace(/^.*?TenAI policy:/s, "TenAI policy:").slice(0, 300));
            }
            this.send(s.id, { type: "turn.tool_result", sessionId: s.id, turnId, ok: ev.ok, denied: !!ev.denied, text: redact(ev.text).slice(0, 2000) });
            break;
          case "ratelimit":
            this.onRateLimit?.(ev.info);
            break;
          case "usage":
            this.db.query(
              `INSERT INTO usage(turn_id, session_id, email, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, ts)
               VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(turn_id) DO UPDATE SET input_tokens=excluded.input_tokens,
               output_tokens=excluded.output_tokens, cache_read=excluded.cache_read, cache_write=excluded.cache_write, cost_usd=excluded.cost_usd`,
            ).run(turnId, s.id, p.email, ev.model ?? this.cfg.model, ev.inputTokens, ev.outputTokens, ev.cacheRead, ev.cacheWrite, ev.costUsd, Date.now());
            break;
          case "done":
            finalText = ev.text;
            break;
          case "error":
            failed = ev.message;
            break;
        }
      }
    } catch (e) {
      failed = (e as Error).message;
    } finally {
      clearTimeout(timer);
      this.agentKeys.delete(agentKey);
    }

    const u = this.db.query("SELECT input_tokens + output_tokens + cache_write AS t, cost_usd AS c FROM usage WHERE turn_id = ?").get(turnId) as { t: number; c: number } | null;
    if (failed) {
      this.db.query("UPDATE turns SET outcome = ?, detail = ?, ended = ? WHERE id = ?").run(failed === "cancelled" ? "cancelled" : "failed", failed.slice(0, 500), Date.now(), turnId);
      this.ledger.append(p.email, "turn.failed", { sessionId: s.id, turnId, reason: failed.slice(0, 200) });
      this.send(s.id, { type: "turn.error", sessionId: s.id, turnId, message: failed });
      this.step(turnId, "error", null, failed.slice(0, 500));
    } else {
      this.db.query("UPDATE turns SET outcome = 'done', ended = ? WHERE id = ?").run(Date.now(), turnId);
      this.ledger.append(p.email, "turn.done", { sessionId: s.id, turnId, tokens: u?.t ?? 0, costUsd: u?.c ?? 0 });
      this.send(s.id, { type: "turn.done", sessionId: s.id, turnId, text: redact(finalText), tokens: u?.t ?? 0, costUsd: u?.c ?? 0 });
      this.step(turnId, "done", null, JSON.stringify({ tokens: u?.t ?? 0, costUsd: u?.c ?? 0 }));
    }
  }

  // ---- diff + ship (every repo of the session) ----
  async diff(p: Principal, sessionId: string): Promise<{ files: string[]; patch: string }> {
    const s = this.owned(p, sessionId);
    const multi = this.multi(s);
    const files: string[] = [];
    const patches: string[] = [];
    for (const sl of this.slots(s)) {
      const base = sl.target_branch ?? this.repo(sl.repo).baseBranch;
      const f = await this.workspace.changedFiles(sl.dir, base);
      if (!f.length) continue;
      files.push(...f.map((x) => (multi ? `${sl.repo}/${x}` : x)));
      const d = redact(await this.workspace.diff(sl.dir, base));
      patches.push(multi ? `### ${sl.repo} (vs ${base})\n${d}` : d);
    }
    return { files, patch: patches.join("\n").slice(0, 200_000) };
  }

  /** Ship every repo with unshipped changes: a merge request, or a push onto the chosen branch, plus copies. */
  async ship(p: Principal, sessionId: string, title: string, description: string, force = false) {
    const s = this.owned(p, sessionId);
    if (s.status !== "active") throw new Error(`This session is ${s.status}.`);
    if (this.running.has(sessionId)) throw new Error("Wait for the running turn to finish before shipping.");
    if (!force && this.multi(s)) {
      const found = (await this.contracts(p, sessionId)).filter((f) => f.uses.length);
      if (found.length) {
        throw new Error(`Not shipped — ${found.length} backend change${found.length === 1 ? "" : "s"} would break code in another repo:\n` +
          found.slice(0, 6).map((f) => `  ${f.kind} “${f.name}” (${f.file.split("/").pop()}) is still used in ${f.uses.slice(0, 3).map((u) => `${u.repo}/${u.file}:${u.line}`).join(", ")}${f.uses.length > 3 ? ` +${f.uses.length - 3}` : ""}`).join("\n") +
          "\nAsk the agent to update those callers (or /contracts for the full list). If the old name is meant to stay working, ship anyway with /ship --force <message>.");
      }
    }
    const ticket = ticketOf(s);
    if (ticket && !title.includes(ticket.key)) title = `${ticket.key}: ${title}`.slice(0, 120);
    if (ticket) description = `${description}\n\nJira: ${ticket.url}`.trim();
    // the person who types /ship is the author (in a shared session that may not be the owner)
    const user = this.db.query("SELECT name FROM users WHERE email = ?").get(p.email) as { name: string };
    const authorEmail = p.email;
    const todo: Slot[] = [];
    for (const sl of this.slots(s)) if ((await this.unshipped(s, sl)).length) todo.push(sl);
    if (!todo.length) throw new Error("nothing to ship: no unshipped changes in any repo of this session");
    if (force) this.ledger.append(p.email, "ship.forced", { sessionId: s.id });
    const across = todo.length > 1 ? `\n\nPart of one change across ${todo.map((x) => x.repo).join(", ")}.` : "";
    const results: ShipResult[] = [];
    for (const sl of todo) {
      const repo = this.repo(sl.repo);
      try {
        if (sl.target_branch) {
          const r = await this.workspace.shipToBranch({ repo, dir: sl.dir, target: sl.target_branch, title, authorName: user.name, authorEmail });
          const mrUrl = this.findMr?.(sl.repo, sl.target_branch) ?? null;
          this.db.query("INSERT INTO changes(session_id, email, repo, branch, sha, files, diffstat, mr_url, ts) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(s.id, s.email, sl.repo, sl.target_branch, r.sha, JSON.stringify(r.files), r.diffstat, mrUrl, Date.now());
          this.ledger.append(p.email, "push.branch", { sessionId: s.id, repo: sl.repo, branch: sl.target_branch, sha: r.sha, files: r.files.length });
          this.spine.emit("branch.pushed", s.email, sl.repo, { sessionId: s.id, branch: sl.target_branch, sha: r.sha, files: r.files, mrUrl });
          results.push({ repo: sl.repo, ...r, mrUrl, pushedTo: sl.target_branch, ports: await this.ports(p, s, sl, r.sha, r.files) });
        } else {
          const r = await this.workspace.ship({
            repo, dir: sl.dir, branch: sl.branch, title,
            description: `${description}${across}\n\nRaised by ${user.name} via TenAI (session ${s.id.slice(0, 8)}).`,
            authorName: user.name, authorEmail,
          });
          this.db.query("INSERT INTO changes(session_id, email, repo, branch, sha, files, diffstat, mr_url, ts) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(s.id, s.email, sl.repo, sl.branch, r.sha, JSON.stringify(r.files), r.diffstat, r.mrUrl, Date.now());
          this.ledger.append(p.email, "ship", { sessionId: s.id, repo: sl.repo, branch: sl.branch, sha: r.sha, mrUrl: r.mrUrl, files: r.files.length });
          this.spine.emit("mr.opened", s.email, sl.repo, { sessionId: s.id, branch: sl.branch, mrUrl: r.mrUrl, files: r.files });
          results.push({ repo: sl.repo, ...r, ports: await this.ports(p, s, sl, r.sha, r.files) });
        }
      } catch (e) {
        results.push({ repo: sl.repo, sha: "", files: [], diffstat: "", mrUrl: null, error: (e as Error).message });
      }
    }
    const first = results.find((r) => !r.error);
    if (!first) throw new Error(results.map((r) => `${r.repo}: ${r.error}`).join(" · "));
    return { ...first, results };
  }

  // ---- checkpoints (/undo) ----

  /** Snapshot every repo's files; skipped when nothing changed since the last checkpoint. */
  async checkpoint(s: SessionRow, label: string, turnId: string | null = null): Promise<boolean> {
    if (!this.multi(s)) return false;
    const n = (this.db.query("SELECT COUNT(*) AS n FROM session_checkpoints WHERE session_id = ?").get(s.id) as { n: number }).n + 1;
    const snap: Record<string, { commit: string; tree: string }> = {};
    for (const sl of this.slots(s)) {
      if (!existsSync(sl.dir)) continue;
      const commit = await this.workspace.snapshot(sl.dir, `refs/tenai/ckpt/${s.id}/${n}/${sl.repo}`);
      snap[sl.repo] = { commit, tree: await this.workspace.treeOf(sl.dir, commit) };
    }
    const last = this.db.query("SELECT snap FROM session_checkpoints WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(s.id) as { snap: string } | null;
    if (last) {
      const prev = JSON.parse(last.snap) as typeof snap;
      if (Object.keys(snap).every((r) => prev[r]?.tree === snap[r].tree)) return false;
    }
    this.db.query("INSERT INTO session_checkpoints(session_id, turn_id, label, created, snap) VALUES (?,?,?,?,?)").run(s.id, turnId, label, Date.now(), JSON.stringify(snap));
    this.db.query("DELETE FROM settings WHERE key = ?").run(`undo.cursor.${s.id}`); // new work: undo starts from the top again
    return true;
  }

  /**
   * Put the files back as they were before the latest turn that changed them (in one repo, or all). Repeating it goes
   * further back. Local only: nothing pushed is touched, and the state undone is itself saved first.
   */
  async undo(p: Principal, sessionId: string, repoName?: string) {
    const s = this.owned(p, sessionId);
    if (this.running.has(sessionId)) throw new Error("Wait for the running turn to finish (or Esc) before undoing.");
    if (!this.multi(s)) throw new Error("Undo needs a session from TenAI 1.0 or later (/new).");
    const slots = this.slots(s).filter((x) => !repoName || x.repo === repoName);
    if (!slots.length) throw new Error(`${repoName} is not part of this session.`);
    const now: Record<string, string> = {};
    for (const sl of slots) now[sl.repo] = await this.workspace.treeOf(sl.dir, `refs/tenai/now/${s.id}/${sl.repo}`, true);
    // undo only walks backwards: after going back to checkpoint k, the next undo looks at older ones only
    const cursorKey = `undo.cursor.${s.id}`;
    const cursor = Number((this.db.query("SELECT value FROM settings WHERE key = ?").get(cursorKey) as { value: string } | null)?.value ?? Infinity);
    const cps = (this.db.query("SELECT id, label, created, snap FROM session_checkpoints WHERE session_id = ? ORDER BY id DESC").all(s.id) as Array<{ id: number; label: string; created: number; snap: string }>)
      .filter((c) => c.id < cursor);
    const cp = cps.find((c) => { const snap = JSON.parse(c.snap); return slots.some((sl) => snap[sl.repo] && snap[sl.repo].tree !== now[sl.repo]); });
    if (!cp) return { label: null, repos: [] as Array<{ repo: string; files: string[] }> };
    const snap = JSON.parse(cp.snap) as Record<string, { commit: string; tree: string }>;
    const repos = [];
    for (const sl of slots) {
      if (!snap[sl.repo] || snap[sl.repo].tree === now[sl.repo]) continue;
      const files = await this.workspace.restore(sl.dir, snap[sl.repo].commit, `refs/tenai/redo/${s.id}/${sl.repo}`);
      if (files.length) repos.push({ repo: sl.repo, files });
    }
    this.db.query("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(cursorKey, String(cp.id));
    this.ledger.append(p.email, "session.undo", { sessionId: s.id, repo: repoName ?? null, to: cp.id, files: repos.reduce((n, r) => n + r.files.length, 0) });
    return { label: cp.label, at: cp.created, repos };
  }

  // ---- review change by change ----

  async hunks(p: Principal, sessionId: string) {
    const s = this.owned(p, sessionId);
    const out = [];
    for (const sl of this.slots(s)) {
      const base = sl.target_branch ?? this.repo(sl.repo).baseBranch;
      for (const h of await this.workspace.hunks(sl.dir, base)) out.push({ repo: sl.repo, id: h.id, file: h.file, header: h.header, lines: h.lines.map(redact), adds: h.adds, dels: h.dels, newFile: h.newFile });
    }
    return out;
  }

  async dropHunk(p: Principal, sessionId: string, repoName: string, id: string) {
    const s = this.owned(p, sessionId);
    if (this.running.has(sessionId)) throw new Error("Wait for the running turn to finish before changing files.");
    const sl = this.slots(s).find((x) => x.repo === repoName);
    if (!sl) throw new Error(`${repoName} is not part of this session.`);
    await this.checkpoint(s, "your /review");
    const h = await this.workspace.revertHunk(sl.dir, sl.target_branch ?? this.repo(sl.repo).baseBranch, id);
    this.ledger.append(p.email, "hunk.dropped", { sessionId: s.id, repo: repoName, file: h.file, adds: h.adds, dels: h.dels });
    return this.hunks(p, sessionId);
  }

  // ---- cross-repo contracts ----

  /** Backend fields/paths this session removed that the session's other repos still use. */
  async contracts(p: Principal, sessionId: string): Promise<Finding[]> {
    const s = this.owned(p, sessionId);
    const slots = this.slots(s);
    const out: Finding[] = [];
    for (const sl of slots) {
      const base = sl.target_branch ?? this.repo(sl.repo).baseBranch;
      const removed = removedFromDiff(sl.repo, await this.workspace.rawDiff(sl.dir, base));
      for (const r of removed.slice(0, 40)) {
        const uses: Finding["uses"] = [];
        for (const other of slots.filter((x) => x.repo !== sl.repo)) {
          const needle = r.kind === "field" ? r.name : pathNeedle(r.name);
          if (!needle) continue;
          for (const u of await this.workspace.grep(other.dir, needle, ["*.ts", "*.html"], 10)) uses.push({ repo: other.repo, ...u });
        }
        out.push({ ...r, uses });
      }
    }
    return out;
  }

  /** The same commit onto each extra branch of that repo, one by one; a branch that conflicts is skipped and reported. */
  private async ports(p: Principal, s: SessionRow, sl: Slot, sha: string, files: string[]) {
    const out = [];
    const repo = this.repo(sl.repo);
    for (const b of alsoOf(sl)) {
      const r = await this.workspace.portTo(repo, sha, b, s.id);
      out.push(r);
      this.ledger.append(p.email, "push.port", { sessionId: s.id, repo: sl.repo, from: sha, ...r });
      if (r.ok && r.sha) {
        const mrUrl = this.findMr?.(sl.repo, b) ?? null;
        this.db.query("INSERT INTO changes(session_id, email, repo, branch, sha, files, diffstat, mr_url, ts) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(s.id, s.email, sl.repo, b, r.sha, JSON.stringify(files), "", mrUrl, Date.now());
        this.spine.emit("branch.pushed", s.email, sl.repo, { sessionId: s.id, branch: b, sha: r.sha, files, mrUrl, portedFrom: sha });
      }
    }
    return out;
  }
}
