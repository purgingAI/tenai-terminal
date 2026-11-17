/**
 * `tenai check <repo>`: compile what the agent changed before anyone ships it.
 *  - Angular repos: the TypeScript type-check (tsc --noEmit) with the repo's packages, installed once per repo and
 *    linked into each worktree. tsc only reads code; it never runs it.
 *  - Gradle repos: compileJava of the modules that changed. A Gradle build runs the repo's build scripts, and the
 *    agent can edit files, so a check is refused while any build file differs from the branch it started from.
 * Runs as the server's user with a minimal environment (no tokens), at low priority, one Gradle build at a time.
 */
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Config, RepoConfig } from "./config";

export interface CheckResult { ok: boolean; command: string; seconds: number; output: string }

const BUILD_FILE = /(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|gradlew(\.bat)?)$|^gradle\/|^buildSrc\//;

export function kindOf(repo: RepoConfig): "tsc" | "gradle" | null {
  if (existsSync(join(repo.path, "gradlew"))) return "gradle";
  if (existsSync(join(repo.path, "package.json")) && existsSync(join(repo.path, "tsconfig.app.json"))) return "tsc";
  return null;
}

/** Gradle modules (top-level folders with a build file) that the changed files belong to. */
export function modulesFor(repo: RepoConfig, files: string[]): string[] {
  const mods = new Set<string>();
  for (const f of files) {
    const top = f.split("/")[0];
    if (f.includes("/") && (existsSync(join(repo.path, top, "build.gradle")) || existsSync(join(repo.path, top, "build.gradle.kts")))) mods.add(top);
  }
  return [...mods].sort();
}

export class Checks {
  private gradleBusy: Promise<unknown> = Promise.resolve();

  constructor(private cfg: Config) {}

  private env(): Record<string, string> {
    const home = join(this.cfg.home, "build-home");
    mkdirSync(home, { recursive: true });
    return {
      PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, LANG: "C.UTF-8",
      GRADLE_USER_HOME: join(this.cfg.home, "gradle-home"),
      // one daemon kept warm for 30 minutes, capped, so repeat checks take seconds instead of minutes
      GRADLE_OPTS: "-Dorg.gradle.daemon.idletimeout=1800000",
      CI: "1", NG_CLI_ANALYTICS: "false",
    };
  }

  private async exec(argv: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string; seconds: number }> {
    const t0 = Date.now();
    const proc = Bun.spawn(["nice", "-n", "10", ...argv], { cwd, env: this.env(), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { code, out: (out + "\n" + err).trim(), seconds: Math.round((Date.now() - t0) / 1000) };
  }

  /** Compile the repo as it is in this worktree. `changed` = files the session changed (picks Gradle modules, guards build files). */
  async run(repo: RepoConfig, dir: string, changed: string[], module?: string): Promise<CheckResult> {
    const kind = kindOf(repo);
    if (kind === "tsc") {
      const nm = join(repo.path, "node_modules");
      if (!existsSync(join(nm, "typescript", "bin", "tsc"))) return { ok: false, command: "tsc", seconds: 0, output: `${repo.name}'s packages are not installed on the server yet (ask an admin).` };
      const link = join(dir, "node_modules");
      if (!existsSync(link) && !isLink(link)) symlinkSync(nm, link);
      const argv = ["node", join(nm, "typescript", "bin", "tsc"), "--noEmit", "-p", "tsconfig.app.json"];
      const r = await this.exec(argv, dir, 5 * 60_000);
      return { ok: r.code === 0, command: "tsc --noEmit -p tsconfig.app.json", seconds: r.seconds, output: tail(r.out, r.code === 0 ? "no type errors" : "") };
    }
    if (kind === "gradle") {
      const touched = changed.filter((f) => BUILD_FILE.test(f));
      if (touched.length) {
        return { ok: false, command: "gradle", seconds: 0, output: `Not compiled: build files were changed in this session (${touched.join(", ")}). Builds run those files, so TenAI only compiles with the branch's own build setup. Undo the build-file change to check, or ship and let CI build it.` };
      }
      const mods = module ? [module.replace(/^:/, "")] : modulesFor(repo, changed);
      if (!mods.length) return { ok: true, command: "gradle", seconds: 0, output: "No Java module changed in this repo — nothing to compile." };
      for (const m of mods) if (!/^[\w.-]+$/.test(m) || !existsSync(join(dir, m))) return { ok: false, command: "gradle", seconds: 0, output: `No module ${m} in ${repo.name}.` };
      const tasks = mods.flatMap((m) => [`:${m}:compileJava`, ...(changed.some((f) => f.startsWith(`${m}/src/test/`)) ? [`:${m}:compileTestJava`] : [])]);
      const argv = ["./gradlew", "-q", "--console=plain", "-Dorg.gradle.jvmargs=-Xmx2g", ...tasks];
      // one Gradle build at a time on this shared machine
      const prev = this.gradleBusy;
      let done!: () => void;
      this.gradleBusy = new Promise<void>((r) => (done = r));
      await prev.catch(() => undefined);
      try {
        const r = await this.exec(argv, dir, 15 * 60_000);
        return { ok: r.code === 0, command: `gradlew ${tasks.join(" ")}`, seconds: r.seconds, output: tail(r.out, r.code === 0 ? "compiled" : "") };
      } finally {
        done();
      }
    }
    return { ok: false, command: "", seconds: 0, output: `No build check is set up for ${repo.name}.` };
  }
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** The useful end of a compiler's output: errors first, capped. */
function tail(out: string, okText: string): string {
  const lines = out.split("\n").filter((l) => l.trim() && !/^(Download|> Task|Starting a Gradle Daemon|To honour the JVM settings)/.test(l));
  if (!lines.length) return okText || "(no output)";
  const errors = lines.filter((l) => /error|ERROR|FAILED|cannot find symbol|TS\d{4}/.test(l));
  const pick = errors.length ? [...new Set([...errors.slice(0, 40), ...lines.slice(-15)])] : lines.slice(-40);
  return pick.join("\n").slice(0, 6000);
}
