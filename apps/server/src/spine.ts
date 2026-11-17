/**
 * The spine: one event stream every session sees. File claims (made automatically when an agent edits),
 * commits, merge requests and session start/stop are recorded and broadcast, collisions are detected
 * (same file, or one claim containing the other), and each turn gets a short digest of what other
 * sessions are doing in the same repo.
 */
import type { Database } from "bun:sqlite";

export interface SpineEvent {
  seq: number;
  ts: number;
  kind: string;
  actor: string;
  repo: string | null;
  payload: Record<string, unknown>;
}

export interface Claim {
  id: number;
  session_id: string;
  email: string;
  repo: string;
  path: string;
  created: number;
}

type Listener = (ev: SpineEvent) => void;

function overlaps(a: string, b: string): boolean {
  const na = a.replace(/\/+$/, "");
  const nb = b.replace(/\/+$/, "");
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

export class Spine {
  private listeners = new Set<Listener>();

  constructor(private db: Database) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(kind: string, actor: string, repo: string | null, payload: Record<string, unknown> = {}): SpineEvent {
    const ts = Date.now();
    const res = this.db.query("INSERT INTO spine_events(ts, kind, actor, repo, payload) VALUES (?,?,?,?,?)")
      .run(ts, kind, actor, repo, JSON.stringify(payload));
    const ev: SpineEvent = { seq: Number(res.lastInsertRowid), ts, kind, actor, repo, payload };
    for (const fn of this.listeners) {
      try { fn(ev); } catch { /* a broken listener must not stop the spine */ }
    }
    return ev;
  }

  /** Active claims by OTHER sessions that overlap `paths`. */
  collisions(repo: string, paths: string[], sessionId: string): Claim[] {
    const active = this.db.query("SELECT * FROM claims WHERE repo = ? AND released IS NULL AND session_id != ?")
      .all(repo, sessionId) as Claim[];
    return active.filter((c) => paths.some((p) => overlaps(c.path, p)));
  }

  /** Claims paths for a session (idempotent) and returns any collisions with other sessions. */
  claim(sessionId: string, email: string, repo: string, paths: string[]): Claim[] {
    const fresh: string[] = [];
    for (const path of paths) {
      const exists = this.db.query("SELECT 1 FROM claims WHERE session_id = ? AND repo = ? AND path = ? AND released IS NULL").get(sessionId, repo, path);
      if (!exists) {
        this.db.query("INSERT INTO claims(session_id, email, repo, path, created) VALUES (?,?,?,?,?)")
          .run(sessionId, email, repo, path, Date.now());
        fresh.push(path);
      }
    }
    const hits = this.collisions(repo, paths, sessionId);
    if (fresh.length) this.emit("claim", email, repo, { sessionId, paths: fresh });
    if (hits.length) {
      this.emit("collision", email, repo, {
        sessionId, paths, with: hits.map((h) => ({ email: h.email, sessionId: h.session_id, path: h.path })),
      });
    }
    return hits;
  }

  release(sessionId: string, email: string, repo: string, paths?: string[]): void {
    if (paths?.length) {
      for (const p of paths) this.db.query("UPDATE claims SET released = ? WHERE session_id = ? AND repo = ? AND path = ? AND released IS NULL").run(Date.now(), sessionId, repo, p);
    } else {
      this.db.query("UPDATE claims SET released = ? WHERE session_id = ? AND released IS NULL").run(Date.now(), sessionId);
    }
    this.emit("release", email, repo, { sessionId, paths: paths ?? "all" });
  }

  activeClaims(repo?: string): Claim[] {
    return (repo
      ? this.db.query("SELECT * FROM claims WHERE released IS NULL AND repo = ? ORDER BY created DESC").all(repo)
      : this.db.query("SELECT * FROM claims WHERE released IS NULL ORDER BY created DESC").all()) as Claim[];
  }

  since(seq: number, limit = 200): SpineEvent[] {
    return (this.db.query("SELECT * FROM spine_events WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as any[])
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  /**
   * What other sessions are doing in this repo, for the agent's system prompt. Kept short: claims by
   * others, their recent commits and MRs (last 24h), and any collision with this session's claims.
   */
  digest(repo: string, sessionId: string, maxChars = 5000): string {
    const others = this.activeClaims(repo).filter((c) => c.session_id !== sessionId);
    const changes = this.db.query(
      "SELECT email, branch, files, mr_url, ts FROM changes WHERE repo = ? AND session_id != ? AND ts > ? ORDER BY ts DESC LIMIT 10",
    ).all(repo, sessionId, Date.now() - 24 * 3600_000) as Array<{ email: string; branch: string; files: string; mr_url: string | null }>;
    const mine = this.activeClaims(repo).filter((c) => c.session_id === sessionId).map((c) => c.path);
    const clashes = mine.length ? this.collisions(repo, mine, sessionId) : [];
    if (!others.length && !changes.length) return "";

    const lines = ["## Other TenAI sessions in this repo (live)"];
    const byPerson = new Map<string, string[]>();
    for (const c of others) byPerson.set(c.email, [...(byPerson.get(c.email) ?? []), c.path]);
    for (const [email, paths] of byPerson) lines.push(`- ${email} is editing: ${paths.slice(0, 12).join(", ")}${paths.length > 12 ? ` (+${paths.length - 12} more)` : ""}`);
    for (const ch of changes) {
      const files = (JSON.parse(ch.files) as string[]).slice(0, 8).join(", ");
      lines.push(`- ${ch.email} committed on ${ch.branch}: ${files}${ch.mr_url ? ` (MR ${ch.mr_url})` : ""}`);
    }
    if (clashes.length) {
      lines.push("", "WARNING: these files are also being edited by someone else — coordinate, keep your change minimal there, and mention it to the user:");
      for (const c of clashes) lines.push(`- ${c.path} (${c.email})`);
    }
    const text = lines.join("\n");
    return text.length > maxChars ? text.slice(0, maxChars) + "\n…" : text;
  }
}
