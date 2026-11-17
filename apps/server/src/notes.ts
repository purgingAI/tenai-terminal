/**
 * Team notes pinned to a repo path ("don't touch HBLProcessor until !1742 merges"). Every agent working in the
 * repo sees them in its context, and anyone whose agent edits under a noted path gets the note in their terminal.
 */
import type { Database } from "bun:sqlite";
import type { Spine } from "./spine";

export interface Note { id: number; repo: string; path: string; text: string; email: string; created: number }

export class Notes {
  constructor(private db: Database, private spine: Spine) {
    db.exec(`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
      email TEXT NOT NULL, created INTEGER NOT NULL, removed INTEGER)`);
  }

  add(email: string, repo: string, path: string, text: string): Note {
    const clean = path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
    const t = text.trim().slice(0, 500);
    if (!t) throw new Error("A note needs some text.");
    const r = this.db.query("INSERT INTO notes(repo, path, text, email, created) VALUES (?,?,?,?,?)").run(repo, clean, t, email, Date.now());
    const note = { id: Number(r.lastInsertRowid), repo, path: clean, text: t, email, created: Date.now() };
    this.spine.emit("note", email, repo, { id: note.id, path: clean, text: t });
    return note;
  }

  remove(id: number, email: string, admin: boolean): boolean {
    const n = this.db.query("SELECT email, repo FROM notes WHERE id = ? AND removed IS NULL").get(id) as { email: string; repo: string } | null;
    if (!n || (n.email !== email && !admin)) return false;
    this.db.query("UPDATE notes SET removed = ? WHERE id = ?").run(Date.now(), id);
    this.spine.emit("note.removed", email, n.repo, { id });
    return true;
  }

  list(repo?: string): Note[] {
    return (repo
      ? this.db.query("SELECT id, repo, path, text, email, created FROM notes WHERE removed IS NULL AND repo = ? ORDER BY created DESC").all(repo)
      : this.db.query("SELECT id, repo, path, text, email, created FROM notes WHERE removed IS NULL ORDER BY created DESC").all()) as Note[];
  }

  /** Notes that apply to a file: repo-wide notes and notes on the file or any parent folder. */
  forPath(repo: string, path: string): Note[] {
    return this.list(repo).filter((n) => !n.path || path === n.path || path.startsWith(n.path + "/"));
  }

  digest(repo: string): string {
    const list = this.list(repo).slice(0, 20);
    if (!list.length) return "";
    return ["## Team notes for this repo (written by engineers; follow them and tell the user when one applies)",
      ...list.map((n) => `- ${n.path ? `[${n.path}] ` : ""}${n.text} — ${n.email.split("@")[0]}`)].join("\n");
  }
}
