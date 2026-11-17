import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBash, insideWorktree } from "../src/policy";

const allowed = ["./gradlew -q :HBL:test", "npm test", "npm run build"];

describe("Bash policy", () => {
  const ok = ["git status", "git diff --stat", "git add HBL/src/Foo.java", "git commit -m \"fix dob\"", "npm test", "./gradlew -q :HBL:test --tests X"];
  for (const c of ok) test(`allows: ${c}`, () => expect(checkBash(c, allowed).ok).toBe(true));

  const bad = [
    "git push origin HEAD", "git push", "curl -s https://x", "wget x", "mysql -h db", "redis-cli -h x",
    "vault kv get dev/all-config", "kubectl get pods", "sudo ls", "cat ~/.claude/.credentials.json",
    "git status && curl x", "npm test | tee out", "npm test > /tmp/x", "echo $(cat /etc/passwd)", "ls `pwd`",
    "git commit -m x --no-verify", "git commit --amend", "git remote -v", "rm -rf /", "python3 -c 'x'", "printenv",
    "cat /srv/tenai/secrets/claude_token",
  ];
  for (const c of bad) test(`denies: ${c}`, () => expect(checkBash(c, allowed).ok).toBe(false));

  test("multi-repo: git -C inside the session, tenai's own command, service paths", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-"));
    mkdirSync(join(root, "core-api"));
    for (const c of ["git -C core-api log --oneline -5", "git -C core-api grep -il block -- *.java", "git -C core-api diff", "tenai status", "tenai use core-api feature/dp-x feature/dp-y",
      "tenai branches admin-console access", "git log -- src/main/java/com/openwallet/service/Foo.java"]) expect(checkBash(c, allowed, root)).toEqual({ ok: true });
    for (const c of ["git -C /etc log", "git -C ../other log", "git -C core-api push", "git -C core-api remote -v", "git -C core-api log", "tenai use x $HOME", "service nginx stop"])
      expect(checkBash(c, allowed, c.includes("log") && c.includes("wallet") ? undefined : root).ok).toBe(false);
  });
});

describe("worktree confinement", () => {
  const root = mkdtempSync(join(tmpdir(), "wt-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "A.java"), "class A {}");
  const outside = mkdtempSync(join(tmpdir(), "out-"));
  symlinkSync(outside, join(root, "escape"));

  test("inside paths, including new files", () => {
    expect(insideWorktree(root, join(root, "src", "A.java"))).toBe(true);
    expect(insideWorktree(root, join(root, "src", "New.java"))).toBe(true);
    expect(insideWorktree(root, "src/A.java")).toBe(true);
  });
  test("outside paths, .. and symlink escapes", () => {
    expect(insideWorktree(root, "/etc/passwd")).toBe(false);
    expect(insideWorktree(root, join(root, "..", "x"))).toBe(false);
    expect(insideWorktree(root, join(root, "escape", "secret.txt"))).toBe(false);
    expect(insideWorktree(root, "")).toBe(false);
  });
});
