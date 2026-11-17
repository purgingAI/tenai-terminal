import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../src/auth";
import { openDb } from "../src/db";
import { Ledger } from "../src/ledger";
import { Runner } from "../src/runner";
import { Spine } from "../src/spine";
import { makeGit, Workspace } from "../src/workspace";

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).toString().trim();

/** Two repos (backend + admin UI), each with env/dev and feature branches, cloned single-branch like the server. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "tenai-multi-"));
  const repos = [];
  for (const name of ["wallet", "shield"]) {
    sh(`git init -q --bare ${name}.git && git -C ${name}.git config receive.advertisePushOptions true`, root);
    sh(`git clone -q ${name}.git ${name}-seed`, root);
    const seed = join(root, `${name}-seed`);
    writeFileSync(join(seed, "App.txt"), `${name} v1\n`);
    sh("git add -A && git commit -qm init && git branch -M env/dev && git push -q origin env/dev", seed);
    for (const b of ["feature/dp", "feature/dp-uat"]) sh(`git checkout -q env/dev && git checkout -qb ${b} && echo ${b} > F.txt && git add -A && git commit -qm ${b} && git push -q origin ${b}`, seed);
    sh(`git clone -q --single-branch -b env/dev ${name}.git ${name}`, root);
    repos.push({ name, path: join(root, name), baseBranch: "env/dev", allowedCommands: [] });
  }
  const db = openDb(":memory:");
  db.query("INSERT INTO users(email, name, daily_token_budget, created) VALUES ('alex@example.com', 'Alex', 1000000, 0)").run();
  const cfg = { repos, home: root, port: 0, agentBinDir: "", maxConcurrentTurns: 1, turnTimeoutMs: 60_000, model: "x", worktreesDir: join(root, "wt") } as never;
  const provider = { id: "fake", capabilities: () => ({}), async *startTurn() {} } as never;
  const ws = new Workspace(makeGit(), join(root, "wt"));
  const runner = new Runner(db, cfg, provider, ws, new Spine(db), new Ledger(db));
  const p = { email: "alex@example.com", name: "Alex", role: "user", modelId: "m" } as Principal;
  return { root, runner, p };
}

describe("one session across repos", () => {
  test("every repo is checked out; each can move to its own branch; /ship ships all of them; ending cleans up", async () => {
    const { root, runner, p } = world();
    const s = await runner.open(p, "wallet");
    const slots = runner.slots(s);
    expect(slots.map((x) => x.repo)).toEqual(["wallet", "shield"]); // the repo it started in first
    for (const x of slots) expect(existsSync(join(x.dir, "App.txt"))).toBe(true);

    // the agent switches the UI repo onto an existing branch and its port, through its `tenai` command
    (runner as any).agentKeys.set("k1", { sessionId: s.id });
    expect(await runner.agentRun("k1", ["use", "shield", "feature/dp", "feature/dp-uat"])).toContain("on feature/dp");
    await expect(runner.agentRun("nope", ["status"])).rejects.toThrow(/not inside/);
    const shield = runner.slots(s).find((x) => x.repo === "shield")!;
    expect(existsSync(join(shield.dir, "F.txt"))).toBe(true);

    // edits in both repos, like one feature (backend + UI)
    const wallet = runner.slots(s).find((x) => x.repo === "wallet")!;
    writeFileSync(join(wallet.dir, "Api.txt"), "GET /dp/requests\n");
    writeFileSync(join(shield.dir, "App.txt"), "shield v1 + requests page\n");
    await expect(runner.useBranch(p, s.id, "wallet", "feature/dp")).rejects.toThrow(/unshipped/); // never throws work away
    expect(await runner.agentRun("k1", ["status"])).toMatch(/shield: on feature\/dp .*also copies to feature\/dp-uat; unshipped: App\.txt\nwallet: fresh branch .* unshipped: Api\.txt/); // focus follows the last switch

    const shipped = await runner.ship(p, s.id, "Developer access requests", "");
    expect(shipped.results.map((r) => [r.repo, !!r.error])).toEqual([["shield", false], ["wallet", false]]);
    expect(shipped.results[0].pushedTo).toBe("feature/dp");
    expect(shipped.results[0].ports).toMatchObject([{ branch: "feature/dp-uat", ok: true }]);
    expect(sh(`git log -1 --format='%an|%s' ${wallet.branch}`, join(root, "wallet.git"))).toBe("Alex|Developer access requests");
    for (const b of ["feature/dp", "feature/dp-uat"]) expect(sh(`git show ${b}:App.txt`, join(root, "shield.git"))).toBe("shield v1 + requests page");
    await expect(runner.ship(p, s.id, "again", "")).rejects.toThrow(/nothing to ship/);

    // shipped → the repo can move again
    expect((await runner.useBranch(p, s.id, "wallet", "feature/dp")).target_branch).toBe("feature/dp");
    await expect(runner.useBranch(p, s.id, "wallet", "env/dev")).rejects.toThrow(/protected/);
    await expect(runner.useBranch(p, s.id, "wallet", "feature/missing")).rejects.toThrow(/No branch/);

    runner.end(p, s.id);
    await Bun.sleep(1500);
    expect(existsSync(s.worktree)).toBe(false); // nothing unshipped → worktrees and folder removed
  }, 30_000);

  test("a session that ends with unshipped work keeps that repo's worktree", async () => {
    const { runner, p } = world();
    const s = await runner.open(p, "shield");
    const [shield, wallet] = runner.slots(s);
    writeFileSync(join(shield.dir, "Wip.txt"), "half done\n");
    runner.end(p, s.id);
    await Bun.sleep(1500);
    expect(existsSync(shield.dir)).toBe(true);
    expect(existsSync(wallet.dir)).toBe(false);
  }, 30_000);

  test("an older single-repo session is upgraded in place, keeping its unshipped edits", async () => {
    const { runner, p } = world();
    const ws = (runner as any).workspace as Workspace;
    const id = "legacy0-0000-0000-0000-000000000000";
    const repo = { name: "wallet", path: (runner as any).cfg.repos[0].path, baseBranch: "env/dev", allowedCommands: [] };
    const dir = await ws.create(repo, id, "tenai/alex/old-legacy");
    writeFileSync(join(dir, "Half.txt"), "backend edit\n");
    (runner as any).db.query(`INSERT INTO term_sessions(id, email, model_id, repo, worktree, branch, provider, provider_session, status, started)
      VALUES (?, 'alex@example.com', 'm', 'wallet', ?, 'tenai/alex/old-legacy', 'fake', 'claude-conv-1', 'active', 0)`).run(id, dir);
    expect(await runner.upgrade(runner.session(id)!)).toBe(true);
    const s = runner.session(id)!;
    expect(s.provider_session).toBeNull();
    expect(runner.slots(s).map((x) => [x.repo, x.branch])).toEqual([["wallet", "tenai/alex/old-legacy"], ["shield", expect.stringMatching(/^tenai\/alex\//)]]);
    expect(await runner.unshipped(s, runner.slots(s)[0])).toEqual(["Half.txt"]);
    expect(existsSync(join(runner.slots(s)[1].dir, "App.txt"))).toBe(true);
    expect(await runner.upgrade(s)).toBe(false);
  }, 30_000);

  test("undo goes back turn by turn (one repo or all), and nothing is lost: the undone state is saved first", async () => {
    const { runner, p } = world();
    const s = await runner.open(p, "wallet");
    const [wallet, shield] = runner.slots(s);
    await runner.checkpoint(s, "turn 1");                      // before turn 1: clean
    writeFileSync(join(wallet.dir, "App.txt"), "wallet v2\n");
    writeFileSync(join(shield.dir, "New.ts"), "export const x = 1;\n");
    expect(await runner.checkpoint(s, "turn 2")).toBe(true);    // before turn 2
    expect(await runner.checkpoint(s, "turn 2 again")).toBe(false); // nothing changed → no new checkpoint
    writeFileSync(join(wallet.dir, "App.txt"), "wallet v3\n");

    const u1 = await runner.undo(p, s.id, "wallet");            // only the backend, back one turn
    expect(u1.label).toBe("turn 2");
    expect(readFileSync(join(wallet.dir, "App.txt"), "utf8")).toBe("wallet v2\n");
    expect(existsSync(join(shield.dir, "New.ts"))).toBe(true);  // other repo untouched

    const u2 = await runner.undo(p, s.id);                       // everything, one more step back
    expect(u2.label).toBe("turn 1");
    expect(readFileSync(join(wallet.dir, "App.txt"), "utf8")).toBe("wallet v1\n");
    expect(existsSync(join(shield.dir, "New.ts"))).toBe(false); // a file added since is removed
    expect((await runner.undo(p, s.id)).label).toBeNull();      // nothing older
  }, 30_000);

  test("review: drop one change, keep the others", async () => {
    const { runner, p } = world();
    const s = await runner.open(p, "wallet");
    const wallet = runner.slots(s)[0];
    writeFileSync(join(wallet.dir, "Long.txt"), Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const sh = (c: string) => execSync(c, { cwd: wallet.dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
    sh("git add -A && git commit -qm long && git push -q origin HEAD:env/dev && git fetch -q origin env/dev && git reset -q --hard origin/env/dev");
    const lines = readFileSync(join(wallet.dir, "Long.txt"), "utf8").split("\n");
    lines[2] = "line 2 CHANGED"; lines[30] = "line 30 CHANGED";
    writeFileSync(join(wallet.dir, "Long.txt"), lines.join("\n"));
    writeFileSync(join(wallet.dir, "Added.txt"), "brand new\n");
    const hs = await runner.hunks(p, s.id);
    expect(hs.map((h) => h.file).sort()).toEqual(["Added.txt", "Long.txt", "Long.txt"]);
    const first = hs.find((h) => h.file === "Long.txt" && h.lines.some((l) => l.includes("line 2 CHANGED")))!;
    const left = await runner.dropHunk(p, s.id, "wallet", first.id);
    expect(left.map((h) => h.file).sort()).toEqual(["Added.txt", "Long.txt"]);
    const now = readFileSync(join(wallet.dir, "Long.txt"), "utf8");
    expect(now).toContain("line 2\n");
    expect(now).toContain("line 30 CHANGED");
    const added = left.find((h) => h.file === "Added.txt")!;
    await runner.dropHunk(p, s.id, "wallet", added.id);
    expect(existsSync(join(wallet.dir, "Added.txt"))).toBe(false);
    expect((await runner.undo(p, s.id, "wallet")).label).toBe("your /review"); // a dropped change can come back
  }, 30_000);

  test("contracts: a removed DTO field still used by the UI blocks /ship until fixed or forced", async () => {
    const { runner, p, root } = world();
    const shWallet = (c: string) => execSync(c, { cwd: join(root, "wallet-seed"), stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
    mkdirSync(join(root, "wallet-seed", "dto"), { recursive: true });
    writeFileSync(join(root, "wallet-seed", "dto", "CampaignDTO.java"), "public class CampaignDTO {\n    private String discountValue;\n    @GetMapping(\"/incentive/campaign-simulate\")\n    private Long budgetCap;\n}\n");
    shWallet("git checkout -q env/dev && git add -A && git commit -qm dto && git push -q origin env/dev");
    const shShield = (c: string) => execSync(c, { cwd: join(root, "shield-seed"), stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
    writeFileSync(join(root, "shield-seed", "sim.component.ts"), "const v = campaign.discountValue;\nhttp.get(`${base}/incentive/campaign-simulate`);\n");
    shShield("git checkout -q env/dev && git add -A && git commit -qm ui && git push -q origin env/dev");

    const s = await runner.open(p, "wallet");
    const [wallet, shield] = runner.slots(s);
    writeFileSync(join(wallet.dir, "dto", "CampaignDTO.java"), "public class CampaignDTO {\n    private String discountAmount;\n    @GetMapping(\"/incentive/simulate\")\n    private Long budgetCap;\n}\n");
    const found = await runner.contracts(p, s.id);
    expect(found.map((f) => [f.kind, f.name, f.uses.map((u) => `${u.repo}/${u.file}:${u.line}`)])).toEqual([
      ["field", "discountValue", ["shield/sim.component.ts:1"]],
      ["path", "/incentive/campaign-simulate", ["shield/sim.component.ts:2"]],
    ]);
    await expect(runner.ship(p, s.id, "rename", "")).rejects.toThrow(/would break code in another repo/);
    // the agent fixes the UI in the same session → nothing left to warn about
    writeFileSync(join(shield.dir, "sim.component.ts"), "const v = campaign.discountAmount;\nhttp.get(`${base}/incentive/simulate`);\n");
    expect((await runner.contracts(p, s.id)).filter((f) => f.uses.length)).toEqual([]);
    const shipped = await runner.ship(p, s.id, "Rename discount field", "");
    expect(shipped.results.map((r) => [r.repo, !!r.error])).toEqual([["wallet", false], ["shield", false]]);
  }, 30_000);

  test("a session opened from a Jira ticket names its MR after the ticket and links it", async () => {
    const { runner, p, root } = world();
    const ticket = { key: "P1S-1311", url: "https://your-org.atlassian.net/browse/P1S-1311", summary: "Block developers" };
    const s = await runner.open(p, "wallet", "P1S-1311 Block developers", undefined, [], ticket);
    expect(runner.slots(s)[0].branch).toMatch(/^tenai\/alex\/p1s-1311-block-developers-/);
    writeFileSync(join(runner.slots(s)[0].dir, "B.txt"), "x\n");
    await runner.ship(p, s.id, "Admin can block developers", "");
    const b = runner.slots(s)[0].branch;
    expect(execSync(`git log -1 --format=%s ${b}`, { cwd: join(root, "wallet.git") }).toString().trim()).toBe("P1S-1311: Admin can block developers");
  }, 30_000);

  test("pairing: invite by name, members work in the session, only the owner ends it, hand-over and leave", async () => {
    const { runner, p } = world();
    const db = (runner as any).db;
    db.query("INSERT INTO users(email, name, daily_token_budget, created) VALUES ('dev@example.com', 'Sagar Uniyal', 1, 0), ('sagar.k@example.com', 'Sagar Kumar', 1, 0)").run();
    const sagar = { email: "dev@example.com", name: "Sagar Uniyal", role: "user", modelId: "m" } as Principal;
    const s = await runner.open(p, "wallet");
    expect(() => runner.owned(sagar, s.id)).toThrow(/not found/);           // not invited yet
    expect(() => runner.invite(p, s.id, "sagar")).toThrow(/matches/);       // two Sagars → ask for the email
    expect(() => runner.invite(p, s.id, "nobody")).toThrow(/signed in/);
    expect(runner.invite(p, s.id, "dev").person.email).toBe("dev@example.com");
    expect(runner.owned(sagar, s.id).id).toBe(s.id);                        // member can work in it
    writeFileSync(join(runner.slots(s)[0].dir, "Pair.txt"), "x\n");
    expect((await runner.hunks(sagar, s.id)).length).toBe(1);
    expect(() => runner.end(sagar, s.id)).toThrow(/Only the session's owner/);
    expect(() => runner.handoff(sagar, s.id, "alex")).toThrow(/Only the session's owner/);
    expect(runner.members(p, s.id).members.map((m: { email: string }) => m.email)).toEqual(["dev@example.com"]);

    runner.handoff(p, s.id, "Sagar Uniyal");                                 // Alex hands it to Sagar
    expect(runner.session(s.id)!.email).toBe("dev@example.com");
    expect(runner.members(sagar, s.id).members.map((m: { email: string }) => m.email)).toEqual(["alex@example.com"]);
    runner.leave(p, s.id);                                                   // Alex drops out
    expect(() => runner.owned(p, s.id)).toThrow(/not found/);
    expect(() => runner.leave(sagar, s.id)).toThrow(/You own this session/);
    const shipped = await runner.ship(sagar, s.id, "Pair change", "");      // the one who ships is the author
    expect(shipped.results[0].error).toBeUndefined();
  }, 30_000);
});
