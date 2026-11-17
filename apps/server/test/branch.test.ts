import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGit, targetAllowed, Workspace } from "../src/workspace";

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).toString().trim();

function world() {
  const root = mkdtempSync(join(tmpdir(), "tenai-branch-"));
  sh("git init -q --bare origin.git", root);
  sh("git clone -q origin.git seed", root);
  const seed = join(root, "seed");
  writeFileSync(join(seed, "A.java"), "class A {}\n");
  sh("git add -A && git commit -qm init && git branch -M env/dev && git push -q origin env/dev", seed);
  sh("git checkout -qb feature/beneficiary-missing-details && echo 'class B {}' > B.java && git add -A && git commit -qm sagar && git push -q origin feature/beneficiary-missing-details", seed);
  sh("git clone -q --single-branch -b env/dev origin.git server", root);
  const repo = { name: "wallet", path: join(root, "server"), baseBranch: "env/dev", allowedCommands: [] };
  return { root, seed, repo, ws: new Workspace(makeGit(), join(root, "worktrees")) };
}

describe("working on an existing branch", () => {
  test("protected branches and odd names are refused", () => {
    const repo = { name: "w", path: "/x", baseBranch: "env/dev", allowedCommands: [] };
    for (const b of ["env/dev", "env/uat", "main", "master", "release/1.2", "prod", "a..b", "-x"]) expect(targetAllowed(repo, b)).not.toBeNull();
    expect(targetAllowed(repo, "feature/beneficiary-missing-details")).toBeNull();
  });

  test("lists remote branches the single-branch clone can't see, works on one, pushes one commit by the engineer", async () => {
    const { seed, repo, ws } = world();
    expect(await ws.branches(repo, "missing")).toEqual(["feature/beneficiary-missing-details"]);
    const dir = await ws.createOn(repo, "s1abcdef", "tenai/alex/on-x-s1abcd", "feature/beneficiary-missing-details");
    expect(sh("ls", dir)).toContain("B.java"); // Sagar's work is there
    writeFileSync(join(dir, "B.java"), "class B { int missing; }\n");
    sh("git commit -qam wip", dir); // the agent may commit locally; ship squashes
    writeFileSync(join(dir, "C.java"), "class C {}\n");
    const r = await ws.shipToBranch({ repo, dir, target: "feature/beneficiary-missing-details", title: "Return form config shape", authorName: "Alex Morgan", authorEmail: "alex.morgan@example.com" });
    expect(r.files.sort()).toEqual(["B.java", "C.java"]);
    sh("git fetch -q origin", seed);
    expect(sh("git log -1 --format='%an <%ae> | %cn | %s' origin/feature/beneficiary-missing-details", seed)).toBe("Alex Morgan <alex.morgan@example.com> | TenAI | Return form config shape");
    expect(sh("git rev-list --count origin/env/dev..origin/feature/beneficiary-missing-details", seed)).toBe("2"); // sagar + one squashed commit
  });

  test("someone pushed meanwhile: rebases onto it; a real conflict stops and pushes nothing", async () => {
    const { seed, repo, ws } = world();
    const target = "feature/beneficiary-missing-details";
    const dir = await ws.createOn(repo, "s2abcdef", "tenai/alex/on-x-s2abcd", target);
    writeFileSync(join(dir, "C.java"), "class C {}\n");
    sh(`git checkout -q ${target} && echo 'class D {}' > D.java && git add -A && git commit -qm other && git push -q origin ${target}`, seed);
    await ws.shipToBranch({ repo, dir, target, title: "add C", authorName: "V", authorEmail: "v@example.com" });
    sh("git fetch -q origin", seed);
    expect(sh(`git log --format=%s origin/${target} -3`, seed).split("\n")).toEqual(["add C", "other", "sagar"]);

    const dir2 = await ws.createOn(repo, "s3abcdef", "tenai/alex/on-x-s3abcd", target);
    writeFileSync(join(dir2, "B.java"), "class B { int mine; }\n");
    sh(`git pull -q origin ${target} && echo 'class B { int theirs; }' > B.java && git commit -qam clash && git push -q origin ${target}`, seed);
    const before = sh(`git rev-parse origin/${target}`, seed);
    await expect(ws.shipToBranch({ repo, dir: dir2, target, title: "mine", authorName: "V", authorEmail: "v@example.com" })).rejects.toThrow(/conflicts/);
    sh("git fetch -q origin", seed);
    expect(sh(`git rev-parse origin/${target}`, seed)).toBe(before);
    await expect(ws.createOn(repo, "s4abcdef", "tenai/alex/on-y-s4abcd", "env/dev")).rejects.toThrow(/protected/);
  });

  test("finds a person's unmerged branches and links branches that carry the same change", async () => {
    const { seed, repo, ws } = world();
    const as = (who: string) => `GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=${who}`;
    sh(`git checkout -q env/dev && git checkout -qb feature/P1S-1311 && echo x > Portal.ts && git add -A && ${as("dev@example.com")} git commit -qm "Block developers (P1S-1311)" && git push -q origin feature/P1S-1311`, seed);
    sh(`git checkout -q env/dev && git checkout -qb feature/P1S-1311_fromEnv/uat && echo x > Portal.ts && git add -A && ${as("Sagar.Uniyal@example.com")} git commit -qm "Block developers (P1S-1311)" && git push -q origin feature/P1S-1311_fromEnv/uat`, seed);
    sh(`git checkout -q env/dev && git checkout -qb feature/other && echo y > O.ts && git add -A && ${as("alex@example.com")} git commit -qm other && git push -q origin feature/other`, seed);
    sh(`git checkout -q feature/P1S-1311 && git checkout -qb feature/P1S-1311-stacked && git push -q origin feature/P1S-1311-stacked`, seed);
    const mine = await ws.mine(repo, "dev@example.com");
    expect(mine.map((b) => b.name).sort()).toEqual(["feature/P1S-1311", "feature/P1S-1311-stacked", "feature/P1S-1311_fromEnv/uat"]);
    expect(mine.find((x) => x.name === "feature/P1S-1311-stacked")!.related).toEqual(["feature/P1S-1311_fromEnv/uat"]); // same commit as 1311: not a copy of it
    const b = mine.find((x) => x.name === "feature/P1S-1311")!;
    expect(b.files).toEqual(["Portal.ts"]);
    expect(b.related).toEqual(["feature/P1S-1311_fromEnv/uat"]); // a copy (different commit, same message)
    expect(await ws.mine(repo, "dev@openwallet.comX")).toEqual([]); // the email is matched literally, not as a pattern
  });

  test("ship copies the commit onto further branches; a branch where it conflicts is skipped, untouched", async () => {
    const { seed, repo, ws } = world();
    sh("git checkout -q env/dev && git checkout -qb feature/port-ok && echo z > Z.java && git add -A && git commit -qm z && git push -q origin feature/port-ok", seed);
    sh("git checkout -q env/dev && git checkout -qb feature/port-clash && echo 'class A { int clash; }' > A.java && git commit -qam clash && git push -q origin feature/port-clash", seed);
    const target = "feature/beneficiary-missing-details";
    const dir = await ws.createOn(repo, "s5abcdef", "tenai/alex/on-x-s5abcd", target);
    writeFileSync(join(dir, "A.java"), "class A { int fix; }\n");
    const r = await ws.shipToBranch({ repo, dir, target, title: "fix A", authorName: "Alex", authorEmail: "alex@example.com" });
    const ok = await ws.portTo(repo, r.sha, "feature/port-ok", "s5abcdef");
    const clash = await ws.portTo(repo, r.sha, "feature/port-clash", "s5abcdef");
    const again = await ws.portTo(repo, r.sha, "feature/port-ok", "s5abcdef");
    const prot = await ws.portTo(repo, r.sha, "env/dev", "s5abcdef");
    expect(ok.ok).toBe(true);
    expect(clash).toMatchObject({ ok: false });
    expect(clash.error).toMatch(/conflicts/);
    expect(again).toMatchObject({ ok: true, already: true });
    expect(prot.error).toMatch(/protected/);
    sh("git fetch -q origin", seed);
    expect(sh("git log -1 --format='%an | %cn | %s' origin/feature/port-ok", seed)).toBe("Alex | TenAI | fix A");
    expect(sh("git log -1 --format=%s origin/feature/port-clash", seed)).toBe("clash");
    expect(sh("git worktree list", repo.path).split("\n").some((l) => l.includes("-port-"))).toBe(false); // throwaway worktrees cleaned
  });

  test("recently pushed branches and the files they change (for teammates' overlap warnings)", async () => {
    const { seed, repo, ws } = world();
    sh("git checkout -q env/dev && git checkout -qb feature/alex-now && echo 'class A { int v; }' > A.java && git commit -qam v && git push -q origin feature/alex-now", seed);
    const rows = await ws.recentBranches(repo, 86_400_000);
    expect(rows.find((b) => b.name === "feature/alex-now")?.files).toEqual(["A.java"]);
    expect(rows.some((b) => b.name === "env/dev")).toBe(false);
    expect(await ws.recentBranches(repo, -1)).toEqual(rows); // cached
  });
});
