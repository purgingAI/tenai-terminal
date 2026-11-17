/**
 * The gate's learning loop (Studio-style): inbox of refused / borderline / appealed prompts → human labels →
 * train a challenger in the sidecar → judge it on the fixed golden exam + held-out labels → shadow it on real
 * traffic → promote or roll back. The server only orchestrates; the sidecar trains, judges and never self-promotes.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Config } from "./config";
import type { Ledger } from "./ledger";

const LABELS = new Set(["code_task", "code_question", "out_of_scope"]);
const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

export class GateOps {
  constructor(private db: Database, private cfg: Config, private ledger: Ledger) {}

  private async sidecar<T>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    const res = await fetch(this.cfg.intentSidecarUrl + path, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => { throw new Error("The intent sidecar is not reachable."); });
    const j = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(j.error ?? `sidecar ${res.status}`);
    return j;
  }

  /** `/appeal` from the terminal: the person's last model refusal in this session goes to the top of the inbox. */
  appeal(email: string, sessionId: string, note: string): { ok: boolean; error?: string } {
    const t = this.db.query(`SELECT id, prompt, gate_label, gate_score, gate_version FROM turns
       WHERE session_id = ? AND email = ? AND outcome = 'refused' AND gate_label IN ('out_of_scope','code_task','code_question')
       AND started > ? ORDER BY started DESC LIMIT 1`).get(sessionId, email, Date.now() - 60 * 60_000) as
      { id: string; prompt: string; gate_label: string; gate_score: number; gate_version: number | null } | null;
    if (!t) return { ok: false, error: "There is no recent refusal by the intent gate in this session to appeal." };
    const existing = this.db.query("SELECT id FROM gate_reviews WHERE turn_id = ?").get(t.id) as { id: string } | null;
    if (existing) {
      this.db.query("UPDATE gate_reviews SET reason = 'appeal', note = ?, status = 'open' WHERE id = ?").run(note.slice(0, 500) || null, existing.id);
    } else {
      this.db.query(`INSERT INTO gate_reviews(id, turn_id, email, text, model_label, model_score, model_version, reason, note, created)
        VALUES (?,?,?,?,?,?,?,'appeal',?,?)`).run(randomUUID(), t.id, email, t.prompt, t.gate_label, t.gate_score, t.gate_version, note.slice(0, 500) || null, Date.now());
    }
    this.ledger.append(email, "gate.appeal", { sessionId, turnId: t.id });
    return { ok: true };
  }

  /** Open items grouped by normalised text (one decision labels every copy); appeals first. */
  inbox() {
    const rows = this.db.query(`SELECT * FROM gate_reviews WHERE status = 'open' ORDER BY created DESC LIMIT 1000`).all() as any[];
    const groups = new Map<string, any>();
    for (const r of rows) {
      const k = norm(r.text);
      const g = groups.get(k) ?? { key: k, text: r.text, ids: [], people: new Set<string>(), reasons: new Set<string>(), notes: [] as string[],
        model_label: r.model_label, model_score: r.model_score, model_version: r.model_version, latest: r.created };
      g.ids.push(r.id); g.people.add(r.email); g.reasons.add(r.reason);
      if (r.note) g.notes.push(r.note);
      groups.set(k, g);
    }
    const rank = (g: { reasons: string[] }) => (g.reasons.includes("appeal") ? 0 : g.reasons.includes("refused") ? 1 : 2);
    const items = [...groups.values()].map((g) => ({ ...g, people: [...g.people], reasons: [...g.reasons], count: g.ids.length }))
      .sort((a, b) => rank(a) - rank(b) || b.latest - a.latest);
    const counts = this.db.query(`SELECT status, COUNT(*) AS n FROM gate_reviews GROUP BY status`).all() as Array<{ status: string; n: number }>;
    return { items, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
  }

  label(ids: string[], label: string, by: string) {
    if (label !== "dismiss" && !LABELS.has(label)) throw new Error("Unknown label");
    const now = Date.now();
    const q = label === "dismiss"
      ? this.db.query("UPDATE gate_reviews SET status = 'dismissed', labelled_by = ?, labelled_at = ? WHERE id = ? AND status = 'open'")
      : this.db.query("UPDATE gate_reviews SET status = 'labelled', label = ?, labelled_by = ?, labelled_at = ? WHERE id = ? AND status = 'open'");
    let n = 0;
    for (const id of ids.slice(0, 500)) n += (label === "dismiss" ? q.run(by, now, id) : q.run(label, by, now, id)).changes;
    this.ledger.append(by, "gate.label", { label, n });
    return { ok: true, updated: n };
  }

  /** Human labels, one per distinct text (latest wins). */
  private labels(): Array<[string, string]> {
    const rows = this.db.query("SELECT text, label FROM gate_reviews WHERE status = 'labelled' ORDER BY labelled_at").all() as Array<{ text: string; label: string }>;
    const m = new Map<string, [string, string]>();
    for (const r of rows) m.set(norm(r.text), [r.text, r.label]);
    return [...m.values()];
  }

  async models() {
    const v = await this.sidecar<any>("/versions");
    const lastTrained = Math.max(0, ...v.versions.map((x: any) => x.created ?? 0));
    const fresh = (this.db.query("SELECT COUNT(*) AS n FROM gate_reviews WHERE status = 'labelled' AND labelled_at > ?").get(lastTrained) as { n: number }).n;
    return { ...v, labels: { total: this.labels().length, sinceLastTrain: fresh } };
  }

  async train(by: string) {
    const labels = this.labels();
    const r = await this.sidecar<any>("/train", { labels, by }, 300_000);
    this.ledger.append(by, "gate.train", { version: r.version, passed: r.passed, labels: labels.length });
    return r;
  }

  async shadow(version: number | null, by: string) {
    const r = await this.sidecar<any>("/shadow", { version });
    this.ledger.append(by, "gate.shadow", { version });
    return r;
  }

  async promote(version: number, by: string) {
    const r = await this.sidecar<any>("/promote", { version, by });
    this.ledger.append(by, "gate.promote", { version, previous: r.previous });
    return r;
  }

  /** Last 14 days: what the gate did each day, and how often the shadow model agreed with live. */
  drift() {
    const since = Date.now() - 14 * 86_400_000;
    const rows = this.db.query(`SELECT started, outcome, gate_label, gate_score, detail, shadow_label, shadow_score FROM turns
      WHERE started >= ? AND (gate_label IS NULL OR gate_label != 'guardrail')`).all(since) as any[];
    const days = new Map<string, any>();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      days.set(d, { day: d, prompts: 0, refused: 0, borderline: 0, appeals: 0, shadowSeen: 0, shadowAgree: 0 });
    }
    const allowed = (label: string | null, score: number | null) => label != null && label !== "out_of_scope" && (score ?? 0) >= 0.6;
    for (const r of rows) {
      const d = days.get(new Date(r.started).toISOString().slice(0, 10));
      if (!d || !r.gate_label) continue;
      d.prompts++;
      if (r.outcome === "refused" && r.gate_label !== "guardrail" && !["budget", "frozen"].includes(r.detail)) d.refused++;
      else if (r.detail !== "followup" && (r.gate_score ?? 1) < 0.75) d.borderline++;
      if (r.shadow_label) {
        d.shadowSeen++;
        d.shadowAgree += Number(allowed(r.gate_label, r.gate_score) === allowed(r.shadow_label, r.shadow_score));
      }
    }
    const appeals = this.db.query("SELECT created FROM gate_reviews WHERE reason = 'appeal' AND created >= ?").all(since) as Array<{ created: number }>;
    for (const a of appeals) { const d = days.get(new Date(a.created).toISOString().slice(0, 10)); if (d) d.appeals++; }
    return [...days.values()];
  }
}
