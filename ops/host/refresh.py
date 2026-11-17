"""Keep the server's repo clones fresh and rebuild each repo's context pack (data/context/<repo>.md).

Run by run.sh every 10 minutes. Fetch uses ~/tenai/bin/git-auth (credential via env, never argv). The pack is a
cheap, deterministic map the agent gets in its system prompt so it finds code without burning tokens on searching:
the repo's own AGENTS.md/CLAUDE.md, a module index, and the latest merges. Reads only; never writes to the repos.
"""
import json
import os
import re
import subprocess
from pathlib import Path

T = Path.home() / "tenai"
GIT_AUTH = str(T / "bin" / "git-auth")
MAX = 7500  # runner.ts caps the pack at 8000 chars


def repos():
    for line in (T / "etc" / "tenai.env").read_text().splitlines():
        if line.startswith("TENAI_REPOS="):
            return json.loads(line.split("=", 1)[1].strip().strip("'"))
    return []


def git(path, *args):
    return subprocess.run(["git", *args], cwd=path, capture_output=True, text=True, timeout=120).stdout


def java_modules(root: Path):
    out = []
    for mod in sorted(p for p in root.iterdir() if p.is_dir() and ((p / "build.gradle").exists() or (p / "pom.xml").exists())):
        src = mod / "src" / "main" / "java"
        pkg = ""
        if src.is_dir():
            cur = src
            # descend while there is exactly one sub-package: com/openwallet/<module>
            while True:
                kids = [k for k in cur.iterdir() if k.is_dir()]
                if len(kids) != 1:
                    break
                cur = kids[0]
            pkg = str(cur.relative_to(src)).replace("/", ".")
            subs = sorted(k.name for k in cur.iterdir() if k.is_dir())[:10]
            pkg += f" [{', '.join(subs)}]" if subs else ""
        out.append(f"- {mod.name}/ {pkg}".rstrip())
    return out


def angular_features(root: Path):
    """Feature folders: walk src/app down through single-purpose wrappers (views/, pages/) to where features fan out."""
    app = root / "src" / "app"
    out = []

    def walk(d: Path, depth: int):
        kids = sorted(k for k in d.iterdir() if k.is_dir() and not k.name.startswith("."))
        if not kids:
            return
        out.append(f"- {d.relative_to(root)}/: {', '.join(k.name for k in kids[:70])}")
        if depth < 3:
            for k in kids:
                if k.name in ("views", "pages", "modules", "features", "components"):
                    walk(k, depth + 1)

    if app.is_dir():
        walk(app, 0)
    return out


def pack(r):
    root = Path(r["path"])
    base = f"origin/{r['baseBranch']}"
    parts = [f"# {r['name']} (base {r['baseBranch']})"]
    docs = [d for d in ("AGENTS.md", "CLAUDE.md", "README.md") if (root / d).exists()]
    if docs:
        parts.append(f"Team conventions live in {docs[0]} at the repo root: read it before changing code.")
    mods = java_modules(root) if (root / "settings.gradle").exists() else angular_features(root)
    if mods:
        parts.append("## Map\n" + "\n".join(mods))
    merges = git(root, "log", "--merges", "-15", "--date=short", "--format=%ad %an: %s", base)
    merges = "\n".join(re.sub(r"Merge branch '([^']+)' into '[^']+'", r"merged \1", l) for l in merges.splitlines())
    if merges:
        parts.append("## Latest merges\n" + merges)
    text = "\n\n".join(parts)
    return text[:MAX]


def main():
    out_dir = T / "data" / "context"
    out_dir.mkdir(parents=True, exist_ok=True)
    for r in repos():
        subprocess.run([GIT_AUTH, "fetch", "-q", "origin", r["baseBranch"]], cwd=r["path"], timeout=300,
                       capture_output=True)
        # every branch under scan/* so agents can compare branches and find someone's work (shared by worktrees)
        subprocess.run([GIT_AUTH, "fetch", "-q", "--prune", "origin", "+refs/heads/*:refs/remotes/scan/*"], cwd=r["path"],
                       timeout=600, capture_output=True)
        tmp = out_dir / f".{r['name']}.md"
        tmp.write_text(pack(r))
        os.replace(tmp, out_dir / f"{r['name']}.md")
        print(f"refreshed {r['name']}")


if __name__ == "__main__":
    main()
