/**
 * Append-only audit ledger with a SHA-256 hash chain (same idea as ~/amp/cx/studio/receipts.py):
 * every row commits to the previous one, so editing or deleting any row breaks verification.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const GENESIS = "0".repeat(64);

export interface LedgerRow {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

function rowHash(prev: string, ts: number, actor: string, action: string, payload: string): string {
  return createHash("sha256").update([prev, ts, actor, action, payload].join("␟")).digest("hex");
}

export class Ledger {
  constructor(private db: Database) {}

  append(actor: string, action: string, payload: Record<string, unknown> = {}): LedgerRow {
    const last = this.db.query("SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1").get() as { hash: string } | null;
    const prev = last?.hash ?? GENESIS;
    const ts = Date.now();
    const body = JSON.stringify(payload);
    const hash = rowHash(prev, ts, actor, action, body);
    const res = this.db.query("INSERT INTO ledger(ts, actor, action, payload, prev_hash, hash) VALUES (?,?,?,?,?,?)")
      .run(ts, actor, action, body, prev, hash);
    return { seq: Number(res.lastInsertRowid), ts, actor, action, payload: body, prev_hash: prev, hash };
  }

  /** Returns the first broken sequence number, or null when the whole chain verifies. */
  verify(): number | null {
    let prev = GENESIS;
    for (const r of this.db.query("SELECT * FROM ledger ORDER BY seq").all() as LedgerRow[]) {
      if (r.prev_hash !== prev || rowHash(prev, r.ts, r.actor, r.action, r.payload) !== r.hash) return r.seq;
      prev = r.hash;
    }
    return null;
  }

  recent(limit = 200): LedgerRow[] {
    return this.db.query("SELECT * FROM ledger ORDER BY seq DESC LIMIT ?").all(limit) as LedgerRow[];
  }
}
