import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checks, kindOf, modulesFor } from "../src/checks";

function gradleRepo() {
  const root = mkdtempSync(join(tmpdir(), "tenai-check-"));
  writeFileSync(join(root, "gradlew"), "#!/bin/sh\necho SHOULD-NOT-RUN\n");
  for (const m of ["IncentiveEngine", "Transaction"]) { mkdirSync(join(root, m)); writeFileSync(join(root, m, "build.gradle"), ""); }
  return { name: "wallet", path: root, baseBranch: "env/dev", allowedCommands: [] };
}

describe("build checks", () => {
  test("knows the repo kind and which Gradle modules changed", () => {
    const repo = gradleRepo();
    expect(kindOf(repo)).toBe("gradle");
    expect(modulesFor(repo, ["IncentiveEngine/src/main/java/A.java", "Transaction/src/X.java", "IncentiveEngine/src/B.java", "README.md", "docs/x.md"]))
      .toEqual(["IncentiveEngine", "Transaction"]);
  });

  test("a Gradle check never runs while build files are changed (they are code the build executes)", async () => {
    const repo = gradleRepo();
    const checks = new Checks({ home: mkdtempSync(join(tmpdir(), "tenai-home-")) } as never);
    for (const f of ["IncentiveEngine/build.gradle", "settings.gradle", "gradle.properties", "gradle/wrapper/gradle-wrapper.properties", "buildSrc/x.groovy", "gradlew"]) {
      const r = await checks.run(repo, repo.path, ["IncentiveEngine/src/A.java", f]);
      expect(r.ok).toBe(false);
      expect(r.output).toContain("build files were changed");
    }
    expect((await checks.run(repo, repo.path, ["README.md"])).output).toContain("nothing to compile");
    expect((await checks.run(repo, repo.path, ["x"], "../etc")).ok).toBe(false);
  });
});
