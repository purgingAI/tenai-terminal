/**
 * Which Claude account TenAI's agents run on, how much of its subscription windows is used, and switching it.
 * The secret lives in TenAI's own store file (0600, never in the DB, never sent to a browser); the dashboard
 * only ever sees a label, the kind and a short fingerprint. Usage comes free with every turn (rate_limit_event).
 */
import { probeCredential, type Credential, type RateLimitInfo } from "@tenai/providers";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Config } from "./config";
import type { Ledger } from "./ledger";

export interface AccountMeta {
  kind: Credential["kind"];
  label: string;
  fingerprint: string;
  setAt: number;
  setBy: string;
  source: "dashboard" | "config";
}

interface Usage extends RateLimitInfo { at: number; fingerprint: string }

/** Models the agents may run on (Claude Code aliases, always the latest of each family). */
export const MODELS = [
  { id: "opus", label: "Opus", note: "Best reasoning; questions requests and catches mistakes. Uses the subscription fastest." },
  { id: "sonnet", label: "Sonnet", note: "Fast and capable for most code changes. About a third of Opus's usage." },
  { id: "haiku", label: "Haiku", note: "Quickest and cheapest; fine for lookups and history questions, weak on real changes." },
] as const;

const fingerprint = (secret: string) => createHash("sha256").update(secret).digest("hex").slice(0, 10);

export class ClaudeAccount {
  private cred: Credential | undefined;
  private meta: AccountMeta | undefined;

  constructor(private db: Database, private cfg: Config, private ledger: Ledger) {
    this.load();
  }

  private load(): void {
    const store = this.cfg.claudeStore;
    if (store && existsSync(store)) {
      const j = JSON.parse(readFileSync(store, "utf8")) as { kind: Credential["kind"]; secret: string; label: string; setAt: number; setBy: string };
      this.cred = { kind: j.kind, secret: j.secret };
      this.meta = { kind: j.kind, label: j.label, fingerprint: fingerprint(j.secret), setAt: j.setAt, setBy: j.setBy, source: "dashboard" };
    } else if (this.cfg.claudeToken) {
      this.cred = { kind: "oauth", secret: this.cfg.claudeToken };
      const named = this.db.query("SELECT value FROM settings WHERE key = 'claude.configLabel'").get() as { value: string } | null;
      this.meta = { kind: "oauth", label: named?.value ?? "Initial token (server config)", fingerprint: fingerprint(this.cfg.claudeToken), setAt: 0, setBy: "server", source: "config" };
    }
  }

  credential(): Credential | undefined {
    return this.cred;
  }

  /** Set by main: a shared-account alert every terminal and dashboard should see (once per window and level). */
  onAlert?: (level: "warn" | "bad", text: string) => void;

  /** Called with the rate_limit_event of every turn (and every probe). */
  recordUsage(info: RateLimitInfo): void {
    if (!this.meta) return;
    const u: Usage = { ...info, at: Date.now(), fingerprint: this.meta.fingerprint };
    this.db.query("INSERT INTO settings(key, value) VALUES ('claude.usage', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(u));
    const last = this.db.query("SELECT five_hour, seven_day FROM claude_usage_samples WHERE fingerprint = ? ORDER BY ts DESC LIMIT 1").get(u.fingerprint) as { five_hour: number; seven_day: number } | null;
    if (!last || last.five_hour !== (info.fiveHour?.utilization ?? null) || last.seven_day !== (info.sevenDay?.utilization ?? null)) {
      this.db.query("INSERT INTO claude_usage_samples(ts, fingerprint, five_hour, five_resets, seven_day, seven_resets, status) VALUES (?,?,?,?,?,?,?)")
        .run(u.at, u.fingerprint, info.fiveHour?.utilization ?? null, info.fiveHour?.resetsAt ?? null, info.sevenDay?.utilization ?? null, info.sevenDay?.resetsAt ?? null, info.status);
      this.db.query("DELETE FROM claude_usage_samples WHERE ts < ?").run(Date.now() - 14 * 86_400_000);
    }
    this.alerts(info);
  }

  private alerts(info: RateLimitInfo): void {
    const once = (key: string, fn: () => void) => {
      const k = `claude.alert.${this.meta!.fingerprint}.${key}`;
      if (this.db.query("SELECT 1 FROM settings WHERE key = ?").get(k)) return;
      this.db.query("INSERT INTO settings(key, value) VALUES (?, '1')").run(k);
      fn();
    };
    const at = (s: number) => new Date(s * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" });
    const f = info.fiveHour, w = info.sevenDay;
    if (info.status === "rejected") once(`rejected.${f?.resetsAt ?? 0}`, () => this.onAlert?.("bad", `The shared Claude account hit its limit. Agents pause until ${f ? at(f.resetsAt) + " UAE" : "the window resets"}.`));
    if (f && f.utilization >= 0.95) once(`5h95.${f.resetsAt}`, () => this.onAlert?.("bad", `Shared Claude usage is at ${Math.round(f.utilization * 100)}% of the 5-hour window (resets ${at(f.resetsAt)} UAE). Keep prompts focused.`));
    else if (f && f.utilization >= 0.85) once(`5h85.${f.resetsAt}`, () => this.onAlert?.("warn", `Heads-up: shared Claude usage is at ${Math.round(f.utilization * 100)}% of the 5-hour window (resets ${at(f.resetsAt)} UAE).`));
    if (w && w.utilization >= 0.9) once(`7d90.${w.resetsAt}`, () => this.onAlert?.("warn", `The shared Claude account has used ${Math.round(w.utilization * 100)}% of its weekly limit.`));
  }

  /**
   * Burn rate of the 5-hour window from samples inside the current window: when does it hit 100% at this pace?
   * Needs at least 10 minutes of samples; null otherwise (a single turn is not a trend).
   */
  forecast() {
    const u = this.usage();
    const since = Date.now() - 24 * 3600_000;
    const samples = this.meta ? this.db.query("SELECT ts, five_hour, seven_day FROM claude_usage_samples WHERE fingerprint = ? AND ts >= ? ORDER BY ts")
      .all(this.meta.fingerprint, since) as Array<{ ts: number; five_hour: number | null; seven_day: number | null }> : [];
    let fiveHour: null | { perHour: number; hitsAt: number | null; beforeReset: boolean } = null;
    const f = u?.fiveHour;
    if (f && this.meta) {
      const win = this.db.query("SELECT ts, five_hour FROM claude_usage_samples WHERE fingerprint = ? AND five_resets = ? AND ts >= ? ORDER BY ts")
        .all(this.meta.fingerprint, f.resetsAt, Date.now() - 90 * 60_000) as Array<{ ts: number; five_hour: number }>;
      if (win.length >= 2 && win.at(-1)!.ts - win[0].ts >= 10 * 60_000) {
        const perMs = (win.at(-1)!.five_hour - win[0].five_hour) / (win.at(-1)!.ts - win[0].ts);
        const hitsAt = perMs > 0 ? Date.now() + (1 - f.utilization) / perMs : null;
        fiveHour = { perHour: perMs * 3600_000, hitsAt, beforeReset: hitsAt != null && hitsAt < f.resetsAt * 1000 };
      }
    }
    return { fiveHour, samples };
  }

  private usage(): Usage | null {
    const r = this.db.query("SELECT value FROM settings WHERE key = 'claude.usage'").get() as { value: string } | null;
    const u = r ? (JSON.parse(r.value) as Usage) : null;
    return u && u.fingerprint === this.meta?.fingerprint ? u : null; // usage of a previous account is meaningless now
  }

  /** The model every new turn runs on: the dashboard's choice, else the server's TENAI_MODEL. */
  model(): string {
    const r = this.db.query("SELECT value FROM settings WHERE key = 'agent.model'").get() as { value: string } | null;
    return r?.value ?? this.cfg.model;
  }

  setModel(model: string, by: string) {
    if (!MODELS.some((m) => m.id === model)) return { ok: false, error: `Unknown model ${model}` };
    const from = this.model();
    this.db.query("INSERT INTO settings(key, value) VALUES ('agent.model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(model);
    this.ledger.append(by, "agent.model.changed", { from, to: model });
    return { ok: true };
  }

  status() {
    const day = Date.now() - 24 * 3600_000, week = Date.now() - 7 * 24 * 3600_000;
    const spend = (since: number) => this.db.query(
      "SELECT COALESCE(SUM(cost_usd),0) AS c, COUNT(*) AS n, COALESCE(SUM(input_tokens+output_tokens+cache_write),0) AS t FROM usage WHERE ts >= ?",
    ).get(since) as { c: number; n: number; t: number };
    const history = this.db.query("SELECT ts, actor, payload FROM ledger WHERE action = 'claude.account.changed' ORDER BY seq DESC LIMIT 10").all() as Array<{ ts: number; actor: string; payload: string }>;
    return {
      account: this.meta ?? null,
      model: { current: this.model(), serverDefault: this.cfg.model, options: MODELS },
      usage: this.usage(),
      forecast: this.forecast(),
      spend: { day: spend(day), week: spend(week) },
      history: history.map((h) => ({ ts: h.ts, actor: h.actor, ...JSON.parse(h.payload) })),
    };
  }

  /** Name the current account (the token itself can't tell us its email). No secret changes. */
  rename(labelRaw: string, by: string) {
    const label = labelRaw.trim().slice(0, 80);
    if (!label || !this.meta) return { ok: false, error: "Nothing to rename." };
    if (this.meta.source === "dashboard" && this.cfg.claudeStore) {
      const j = JSON.parse(readFileSync(this.cfg.claudeStore, "utf8"));
      const tmp = this.cfg.claudeStore + ".tmp";
      writeFileSync(tmp, JSON.stringify({ ...j, label }), { mode: 0o600 });
      renameSync(tmp, this.cfg.claudeStore);
    } else {
      this.db.query("INSERT INTO settings(key, value) VALUES ('claude.configLabel', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(label);
    }
    this.ledger.append(by, "claude.account.renamed", { from: this.meta.label, label, fingerprint: this.meta.fingerprint });
    this.meta = { ...this.meta, label };
    return { ok: true };
  }

  /** Spend a fraction of a cent to refresh the usage windows right now. */
  async check(by: string) {
    if (!this.cred) return { ok: false, error: "No Claude credential is configured." };
    const r = await probeCredential(this.cfg.claudeBin, this.cred, this.cfg.agentHomesDir);
    if (r.rateLimit) this.recordUsage(r.rateLimit);
    this.ledger.append(by, "claude.account.checked", { ok: r.ok, fingerprint: this.meta?.fingerprint, error: r.error });
    return { ok: r.ok, error: r.error };
  }

  /** Test the new credential live; only if it works, store it and switch every following turn to it. */
  async switchTo(kind: Credential["kind"], secretRaw: string, labelRaw: string, by: string) {
    const secret = secretRaw.trim();
    const label = labelRaw.trim().slice(0, 80);
    if (!this.cfg.claudeStore) return { ok: false, error: "TENAI_CLAUDE_STORE is not configured on the server." };
    if (!label) return { ok: false, error: "Give the account a label (e.g. the email it belongs to and its plan)." };
    if (kind === "oauth" && !/^sk-ant-oat\d*-[\w-]{20,}$/.test(secret)) return { ok: false, error: "That doesn't look like a `claude setup-token` token (sk-ant-oat…)." };
    if (kind === "api_key" && !/^sk-ant-api\d*-[\w-]{20,}$/.test(secret)) return { ok: false, error: "That doesn't look like an Anthropic API key (sk-ant-api…)." };
    const cred: Credential = { kind, secret };
    const probe = await probeCredential(this.cfg.claudeBin, cred, this.cfg.agentHomesDir);
    if (!probe.ok) {
      this.ledger.append(by, "claude.account.rejected", { kind, label, fingerprint: fingerprint(secret), error: probe.error });
      return { ok: false, error: `Claude did not accept it: ${probe.error}` };
    }
    const now = Date.now();
    const tmp = this.cfg.claudeStore + ".tmp";
    writeFileSync(tmp, JSON.stringify({ kind, secret, label, setAt: now, setBy: by }), { mode: 0o600 });
    renameSync(tmp, this.cfg.claudeStore);
    const from = this.meta ? { label: this.meta.label, fingerprint: this.meta.fingerprint } : null;
    this.cred = cred;
    this.meta = { kind, label, fingerprint: fingerprint(secret), setAt: now, setBy: by, source: "dashboard" };
    if (probe.rateLimit) this.recordUsage(probe.rateLimit);
    this.ledger.append(by, "claude.account.changed", { kind, label, fingerprint: this.meta.fingerprint, from });
    return { ok: true };
  }
}
