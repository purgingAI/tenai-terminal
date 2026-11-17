/**
 * Email OTP sign-in (only the configured domain), opaque session tokens stored hashed, per-session
 * AMP HMAC secret, and the "agent model" id each connection is shown as.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Config } from "./config";
import type { Ledger } from "./ledger";
import type { Mailer } from "./mailer";

export class AuthError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface Principal {
  email: string;
  name: string;
  role: "user" | "admin";
  modelId: string;
  ampSecret: string;
  tokenHash: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function nameFromEmail(email: string): string {
  return email.split("@")[0].split(/[._-]+/).filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

export class Auth {
  constructor(private db: Database, private cfg: Config, private mailer: Mailer, private ledger: Ledger) {}

  normalizeEmail(raw: string): string {
    const email = String(raw ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+$/.test(email)) throw new AuthError("Enter a valid email address");
    if (!email.endsWith("@" + this.cfg.allowedEmailDomain)) {
      throw new AuthError(`Only @${this.cfg.allowedEmailDomain} accounts can connect`, 403);
    }
    return email;
  }

  async requestOtp(rawEmail: string, ip: string): Promise<void> {
    const email = this.normalizeEmail(rawEmail);
    const now = Date.now();
    const row = this.db.query("SELECT hour_start, hour_count FROM otp WHERE email = ?").get(email) as
      | { hour_start: number; hour_count: number } | null;
    const inWindow = row && now - row.hour_start < 3600_000;
    const count = inWindow ? row!.hour_count : 0;
    if (count >= this.cfg.otpPerHourPerEmail) {
      this.ledger.append(email, "otp.rate_limited", { ip });
      throw new AuthError("Too many codes requested. Try again in an hour.", 429);
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.db.query(
      `INSERT INTO otp(email, code_hash, expires, tries, hour_start, hour_count) VALUES (?,?,?,0,?,?)
       ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires=excluded.expires, tries=0,
       hour_start=excluded.hour_start, hour_count=excluded.hour_count`,
    ).run(email, sha256(email + ":" + code), now + this.cfg.otpTtlMs, inWindow ? row!.hour_start : now, count + 1);
    await this.mailer.sendOtp(email, code);
    this.ledger.append(email, "otp.sent", { ip });
  }

  verifyOtp(rawEmail: string, code: string, ip: string): { token: string; principal: Principal } {
    const email = this.normalizeEmail(rawEmail);
    const row = this.db.query("SELECT code_hash, expires, tries FROM otp WHERE email = ?").get(email) as
      | { code_hash: string; expires: number; tries: number } | null;
    if (!row || Date.now() > row.expires) throw new AuthError("Code expired. Request a new one.", 401);
    if (row.tries >= this.cfg.otpMaxTries) throw new AuthError("Too many wrong codes. Request a new one.", 429);
    const given = Buffer.from(sha256(email + ":" + String(code ?? "").trim()), "hex");
    const expected = Buffer.from(row.code_hash, "hex");
    if (!timingSafeEqual(given, expected)) {
      this.db.query("UPDATE otp SET tries = tries + 1 WHERE email = ?").run(email);
      this.ledger.append(email, "otp.failed", { ip });
      throw new AuthError("Wrong code", 401);
    }
    this.db.query("DELETE FROM otp WHERE email = ?").run(email);

    const now = Date.now();
    const existing = this.db.query("SELECT blocked FROM users WHERE email = ?").get(email) as { blocked: number } | null;
    if (existing?.blocked) {
      this.ledger.append(email, "login.blocked", { ip });
      throw new AuthError("Your access to TenAI is blocked. Contact an admin.", 403);
    }
    if (!existing) {
      const role = this.cfg.admins.includes(email) ? "admin" : "user";
      this.db.query("INSERT INTO users(email, name, role, daily_token_budget, created) VALUES (?,?,?,?,?)")
        .run(email, nameFromEmail(email), role, this.cfg.defaultDailyTokenBudget, now);
    }
    this.db.query("UPDATE users SET last_seen = ? WHERE email = ?").run(now, email);

    const token = "tenai_" + randomBytes(32).toString("hex");
    const ampSecret = randomBytes(24).toString("hex");
    const modelId = `${email.split("@")[0].replace(/[^a-z0-9]+/g, "-")}·m${randomBytes(2).toString("hex")}`;
    this.db.query("INSERT INTO auth_sessions(token_hash, email, model_id, amp_secret, expires, created) VALUES (?,?,?,?,?,?)")
      .run(sha256(token), email, modelId, ampSecret, now + this.cfg.sessionTtlMs, now);
    this.ledger.append(email, "login", { ip, modelId });
    return { token, principal: this.principalFor(sha256(token))! };
  }

  /** Resolves a bearer token; null when unknown, expired, revoked or the user is blocked. */
  resolve(token: string | null | undefined): Principal | null {
    if (!token) return null;
    return this.principalFor(sha256(token));
  }

  private principalFor(tokenHash: string): Principal | null {
    const r = this.db.query(
      `SELECT s.email, s.model_id, s.amp_secret, s.expires, s.revoked, u.name, u.role, u.blocked
       FROM auth_sessions s JOIN users u ON u.email = s.email WHERE s.token_hash = ?`,
    ).get(tokenHash) as
      | { email: string; model_id: string; amp_secret: string; expires: number; revoked: number; name: string; role: string; blocked: number }
      | null;
    if (!r || r.revoked || r.blocked || Date.now() > r.expires) return null;
    return { email: r.email, name: r.name, role: r.role as Principal["role"], modelId: r.model_id, ampSecret: r.amp_secret, tokenHash };
  }

  logout(tokenHash: string): void {
    this.db.query("UPDATE auth_sessions SET revoked = 1 WHERE token_hash = ?").run(tokenHash);
  }

  setBlocked(email: string, blocked: boolean, by: string): void {
    this.db.query("UPDATE users SET blocked = ? WHERE email = ?").run(blocked ? 1 : 0, email);
    if (blocked) this.db.query("UPDATE auth_sessions SET revoked = 1 WHERE email = ?").run(email);
    this.ledger.append(by, blocked ? "user.blocked" : "user.unblocked", { email });
  }
}
