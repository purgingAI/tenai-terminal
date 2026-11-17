import { describe, expect, test } from "bun:test";
import { Auth, AuthError } from "../src/auth";
import { openDb } from "../src/db";
import { Ledger } from "../src/ledger";
import { Spine } from "../src/spine";
import { branchFor } from "../src/workspace";

const cfg = {
  allowedEmailDomain: "example.com", admins: ["dev@example.com"], otpTtlMs: 60_000, otpMaxTries: 3,
  otpPerHourPerEmail: 2, sessionTtlMs: 3600_000, defaultDailyTokenBudget: 1000,
} as never;

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const sent: Record<string, string> = {};
  const auth = new Auth(db, cfg, { async sendOtp(to, code) { sent[to] = code; } }, ledger);
  return { db, ledger, auth, sent };
}

describe("OTP auth", () => {
  test("only @example.com can request a code", async () => {
    const { auth } = setup();
    await expect(auth.requestOtp("someone@gmail.com", "1.1.1.1")).rejects.toBeInstanceOf(AuthError);
  });

  test("right code signs in once; wrong codes are limited; admins come from config", async () => {
    const { auth, sent } = setup();
    await auth.requestOtp("Alex.Morgan@example.com", "ip");
    expect(() => auth.verifyOtp("alex.morgan@example.com", "000000" === sent["alex.morgan@example.com"] ? "111111" : "000000", "ip")).toThrow();
    const { token, principal } = auth.verifyOtp("alex.morgan@example.com", sent["alex.morgan@example.com"], "ip");
    expect(principal).toMatchObject({ email: "alex.morgan@example.com", name: "Alex Morgan", role: "user" });
    expect(principal.modelId).toMatch(/^alex-morgan·m[0-9a-f]{4}$/);
    expect(auth.resolve(token)?.email).toBe("alex.morgan@example.com");
    // a code is single-use
    expect(() => auth.verifyOtp("alex.morgan@example.com", sent["alex.morgan@example.com"], "ip")).toThrow();

    await auth.requestOtp("dev@example.com", "ip");
    expect(auth.verifyOtp("dev@example.com", sent["dev@example.com"], "ip").principal.role).toBe("admin");
  });

  test("rate limit per email and blocking revokes live sessions", async () => {
    const { auth, sent } = setup();
    await auth.requestOtp("a@example.com", "ip");
    await auth.requestOtp("a@example.com", "ip");
    await expect(auth.requestOtp("a@example.com", "ip")).rejects.toThrow(/Too many/);
    const { token } = auth.verifyOtp("a@example.com", sent["a@example.com"], "ip");
    auth.setBlocked("a@example.com", true, "admin@example.com");
    expect(auth.resolve(token)).toBeNull();
  });
});

describe("ledger", () => {
  test("hash chain verifies and detects tampering", () => {
    const { db, ledger } = setup();
    ledger.append("a", "x", { n: 1 });
    ledger.append("b", "y", { n: 2 });
    expect(ledger.verify()).toBeNull();
    db.query("UPDATE ledger SET payload = '{\"n\":9}' WHERE seq = 1").run();
    expect(ledger.verify()).toBe(1);
  });
});

describe("spine", () => {
  test("claims broadcast, collisions on same file or folder, digest for the other session", () => {
    const { db } = setup();
    const spine = new Spine(db);
    const seen: string[] = [];
    spine.subscribe((e) => seen.push(e.kind));
    expect(spine.claim("s1", "alex@example.com", "wallet", ["HBL/src/A.java"])).toEqual([]);
    const hits = spine.claim("s2", "jordan@example.com", "wallet", ["HBL/src"]);
    expect(hits.map((h) => h.email)).toEqual(["alex@example.com"]);
    expect(seen).toEqual(["claim", "claim", "collision"]);
    expect(spine.claim("s3", "x@example.com", "shield", ["HBL/src/A.java"])).toEqual([]); // other repo
    const digest = spine.digest("wallet", "s2");
    expect(digest).toContain("alex@example.com is editing: HBL/src/A.java");
    expect(digest).toContain("WARNING");
    spine.release("s1", "alex@example.com", "wallet");
    expect(spine.collisions("wallet", ["HBL/src"], "s2")).toEqual([]);
  });

  test("branch names are tenai/<user>/<slug>", () => {
    expect(branchFor("alex.morgan@example.com", "Fix DOB format for CityBank!", "abcdef123")).toBe("tenai/alex.morgan/fix-dob-format-for-citybank-abcdef");
  });
});

describe("Claude account", () => {
  const { ClaudeAccount } = require("../src/claude-account");
  const mk = (extra: Record<string, unknown> = {}) => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    return { db, ledger, acc: new ClaudeAccount(db, { claudeToken: "sk-ant-oat01-initialinitialinitial", claudeBin: "/bin/false", ...extra } as never, ledger) };
  };

  test("starts on the configured token, shows only label + fingerprint", () => {
    const { acc } = mk();
    const s = acc.status();
    expect(s.account.label).toContain("Initial");
    expect(s.account.fingerprint).toHaveLength(10);
    expect(JSON.stringify(s)).not.toContain("sk-ant");
  });

  test("usage of a previous account is not shown for the new one", () => {
    const { acc, db } = mk();
    acc.recordUsage({ status: "allowed", fiveHour: { utilization: 0.14, resetsAt: 1 } });
    expect(acc.status().usage.fiveHour.utilization).toBe(0.14);
    db.query("UPDATE settings SET value = json_set(value, '$.fingerprint', 'other') WHERE key = 'claude.usage'").run();
    expect(acc.status().usage).toBeNull();
  });

  test("switch rejects malformed secrets and a missing label before spending anything", async () => {
    const { acc } = mk({ claudeStore: "/tmp/never-written.json" });
    expect((await acc.switchTo("oauth", "hello", "x", "a@example.com")).error).toContain("setup-token");
    expect((await acc.switchTo("api_key", "sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa", "x", "a@example.com")).error).toContain("API key");
    expect((await acc.switchTo("oauth", "sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa", " ", "a@example.com")).error).toContain("label");
  });

  test("rename names the config token and survives a restart", () => {
    const { acc, db, ledger } = mk();
    expect(acc.rename("dev@example.com · Max", "a@example.com").ok).toBe(true);
    const again = new ClaudeAccount(db, { claudeToken: "sk-ant-oat01-initialinitialinitial", claudeBin: "/bin/false" } as never, ledger);
    expect(again.status().account.label).toBe("dev@example.com · Max");
  });

  test("a credential Claude refuses is not stored", async () => {
    const { acc, ledger } = mk({ claudeStore: "/tmp/tenai-test-store-never.json" });
    const r = await acc.switchTo("oauth", "sk-ant-oat01-bbbbbbbbbbbbbbbbbbbbbbbb", "test", "a@example.com");
    expect(r.ok).toBe(false);
    expect(require("node:fs").existsSync("/tmp/tenai-test-store-never.json")).toBe(false);
    expect(acc.status().account.label).toContain("Initial");
    expect(ledger.recent(5).some((x: { action: string }) => x.action === "claude.account.rejected")).toBe(true);
  });
});

describe("Gate learning loop", () => {
  const { GateOps } = require("../src/gate-ops");
  const mk = () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const ops = new GateOps(db, { intentSidecarUrl: "http://127.0.0.1:9" } as never, ledger);
    const turn = (id: string, prompt: string, outcome: string, label: string, score: number, extra = "") =>
      db.query(`INSERT INTO turns(id, session_id, email, prompt, gate_label, gate_score, outcome, detail, started${extra ? ", shadow_label, shadow_score" : ""})
        VALUES (?,?,?,?,?,?,?,?,?${extra ? ",?,?" : ""})`).run(...[id, "s1", "a@example.com", prompt, label, score, outcome, "sidecar", Date.now(), ...(extra ? [extra, 0.9] : [])]);
    return { db, ops, turn };
  };

  test("appeal needs a recent model refusal in the session; it jumps to the top of the inbox", () => {
    const { db, ops, turn } = mk();
    expect(ops.appeal("a@example.com", "s1", "it's the incentive code").ok).toBe(false);
    turn("t1", "how do campaigns reserve budget", "refused", "out_of_scope", 0.72);
    db.query(`INSERT INTO gate_reviews(id, turn_id, email, text, reason, created) VALUES ('r0','t0','b@example.com','borderline thing','borderline',?)`).run(Date.now() + 5);
    expect(ops.appeal("a@example.com", "s1", "it's the incentive code").ok).toBe(true);
    const box = ops.inbox();
    expect(box.items[0].reasons).toContain("appeal");
    expect(box.items[0].notes[0]).toContain("incentive");
    expect(ops.appeal("b@example.com", "s1", "").ok).toBe(false); // not their turn
  });

  test("same text from different people is one inbox item; labelling it labels every copy", () => {
    const { db, ops } = mk();
    for (const [id, who] of [["x1", "a"], ["x2", "b"]])
      db.query(`INSERT INTO gate_reviews(id, email, text, reason, created) VALUES (?,?,?,?,?)`).run(id, `${who}@example.com`, "Show me  the latest commits", "refused", Date.now());
    const box = ops.inbox();
    expect(box.items).toHaveLength(1);
    expect(box.items[0].count).toBe(2);
    expect(ops.label(box.items[0].ids, "code_question", "admin@example.com").updated).toBe(2);
    expect(ops.inbox().items).toHaveLength(0);
    expect(() => ops.label(["x1"], "nonsense", "admin@example.com")).toThrow();
  });

  test("drift counts refusals, and shadow agreement on the allow/refuse decision", () => {
    const { ops, turn } = mk();
    turn("d1", "a", "done", "code_task", 0.95, "code_task");      // agree
    turn("d2", "b", "refused", "out_of_scope", 0.9, "code_question"); // disagree
    const today = ops.drift().at(-1);
    expect(today.prompts).toBe(2);
    expect(today.refused).toBe(1);
    expect(today.shadowSeen).toBe(2);
    expect(today.shadowAgree).toBe(1);
  });
});

describe("Claude usage alerts + forecast", () => {
  const { ClaudeAccount } = require("../src/claude-account");
  const mk = () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const acc = new ClaudeAccount(db, { claudeToken: "sk-ant-oat01-initialinitialinitial", claudeBin: "/bin/false" } as never, ledger);
    const alerts: string[] = [];
    acc.onAlert = (level: string, text: string) => alerts.push(`${level}:${text}`);
    return { db, acc, alerts };
  };
  const reset = Math.floor(Date.now() / 1000) + 3 * 3600;

  test("85% alerts once per window, 95% escalates, rejected says when it resets", () => {
    const { acc, alerts } = mk();
    acc.recordUsage({ status: "allowed", fiveHour: { utilization: 0.5, resetsAt: reset } });
    expect(alerts).toHaveLength(0);
    acc.recordUsage({ status: "allowed", fiveHour: { utilization: 0.86, resetsAt: reset } });
    acc.recordUsage({ status: "allowed", fiveHour: { utilization: 0.88, resetsAt: reset } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toStartWith("warn:Heads-up");
    acc.recordUsage({ status: "allowed", fiveHour: { utilization: 0.96, resetsAt: reset } });
    acc.recordUsage({ status: "rejected", fiveHour: { utilization: 1, resetsAt: reset } });
    expect(alerts.map((a) => a.split(":")[0])).toEqual(["warn", "bad", "bad"]);
    expect(alerts[2]).toContain("hit its limit");
  });

  test("forecast needs 10+ minutes of samples in this window, then projects the hit time", () => {
    const { db, acc } = mk();
    acc.recordUsage({ status: "allowed", fiveHour: { utilization: 0.4, resetsAt: reset } });
    expect(acc.forecast().fiveHour).toBeNull();
    const fp = acc.status().account.fingerprint;
    db.query("INSERT INTO claude_usage_samples(ts, fingerprint, five_hour, five_resets) VALUES (?,?,?,?)").run(Date.now() - 30 * 60_000, fp, 0.2, reset);
    const f = acc.forecast().fiveHour;
    expect(f.perHour).toBeCloseTo(0.4, 1);          // 20 points in 30 minutes
    expect(f.beforeReset).toBe(true);                // 60% left at 40%/h ≈ 1.5h < 3h to reset
    expect(f.hitsAt - Date.now()).toBeGreaterThan(80 * 60_000);
  });
});

describe("Collaboration: notes, open MRs, Teams", () => {
  const { Notes } = require("../src/notes");
  const { GitLab } = require("../src/gitlab");
  const { Teams } = require("../src/teams");

  test("notes apply to their path and children, repo-wide notes everywhere; only author/admin removes", () => {
    const db = openDb(":memory:");
    const notes = new Notes(db, new Spine(db));
    const a = notes.add("alex@example.com", "wallet", "HBL/", "Don't touch HBLProcessor until !1742 merges");
    notes.add("jordan@example.com", "wallet", "", "Release freeze Thursday");
    expect(notes.forPath("wallet", "HBL/src/HBLProcessor.java").map((n: { text: string }) => n.text)).toHaveLength(2);
    expect(notes.forPath("wallet", "UBL/src/X.java")).toHaveLength(1);
    expect(notes.digest("wallet")).toContain("[HBL] Don't touch");
    expect(notes.remove(a.id, "someone@example.com", false)).toBe(false);
    expect(notes.remove(a.id, "admin@example.com", true)).toBe(true);
    expect(notes.list("wallet")).toHaveLength(1);
    expect(() => notes.add("x@example.com", "wallet", "", "  ")).toThrow();
  });

  test("open MRs: only teammates' MRs active in the window are compared — never your own, never stale ones", () => {
    const gl = new GitLab({} as never);
    const now = new Date().toISOString(), old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const f = ["Transaction/src/BeneficiaryValidator.java"];
    (gl as any).cache.set("wallet", [
      { repo: "wallet", iid: 1742, title: "Beneficiary regex", author: "Alex", authorUsername: "alex.morgan", branch: "feature/x", url: "u", updated: now, draft: false, files: f },
      { repo: "wallet", iid: 9, title: "Session's own", author: "Someone", authorUsername: "s", branch: "tenai/me/mine", url: "u", updated: now, draft: true, files: f },
      { repo: "wallet", iid: 1690, title: "My other MR", author: "Sagar Uniyal", authorUsername: "dev", branch: "feature/rbac", url: "u", updated: now, draft: false, files: f },
      { repo: "wallet", iid: 1036, title: "Old", author: "Jordan", authorUsername: "jordan", branch: "feature/old", url: "u", updated: old, draft: false, files: f },
    ]);
    const who = { email: "dev@example.com", name: "Sagar Uniyal", withinMs: 2 * 86_400_000 };
    expect(gl.touching("wallet", f[0], who, "tenai/me/mine").map((m: { iid: number }) => m.iid)).toEqual([1742]);
    expect(gl.touching("wallet", "Transaction", who, "tenai/me/mine")).toHaveLength(1);
    expect(gl.touching("wallet", "UBL/x.java", who)).toHaveLength(0);
    const d = gl.digest("wallet", "env/dev", who, "tenai/me/mine");
    expect(d).toContain('!1742 "Beneficiary regex" by Alex');
    expect(d).not.toContain("!1690");
    expect(d).not.toContain("!1036");
  });

  test("Teams only accepts Workflows webhook URLs", async () => {
    const t = new Teams("/tmp/tenai-teams-test-never");
    expect((await t.set("https://evil.example.com/hook")).ok).toBe(false);
    expect(t.connected()).toBe(false);
  });
});
