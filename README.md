# TenAI — OpenWallet Terminal

A terminal of agents for OpenWallet engineers. Sign in with a `@example.com` email OTP, pick a repo, and talk to a
codebase-aware agent that runs on the server in its own git worktree. Every session sees what the others are
changing (the **spine**). Admins watch everything in the dashboard.

- **Code only.** Guardrails and an intent gate refuse anything that isn't about our code *before* a Claude
  token is spent. Agents never touch databases, Vault, servers or the network.
- **Branch + MR only.** `/ship` makes the server (not the agent) squash the session into one commit authored by
  the engineer, push `tenai/<user>/<slug>`, and open an MR to the repo's base branch. A human merges.
- **Auditable.** Every gate decision, tool denial, block and ship goes into a SHA-256 hash-chained ledger.

```
apps/server     Bun.serve HTTP + WebSocket: auth, guard, gate, runner, spine, git/MR, ledger, admin API   :8470
apps/cli        `openwallet` Ink terminal (login, /repo /new /diff /ship /attach /cancel /sessions /resume …)
apps/web        admin dashboard (Live, Sessions, Spine, Changes, People, Tokens, Gate, Ledger, Freeze, ⌘K)
packages/amp    AMP/1 envelopes (canonical JSON + HMAC-SHA256), byte-compatible with the Python hub
packages/wire   zod schemas for every WS frame
packages/providers  AgentProvider + Claude Code CLI provider + PreToolUse policy hook
sidecar/intent  TF-IDF + calibrated linear SVM gate on loopback                                          :8471
ops/            bootstrap.sh (root, once), deploy.sh (laptop), systemd units, sudoers, env template
```

## Install (what the Teams channel posts)

```bash
curl -fsSL http://127.0.0.1:8470/install | bash     # then open a terminal and type: openwallet
```

One self-contained binary (no Bun/Node needed) for Linux x64/arm64 and macOS, installed to `~/.local/bin/openwallet`
and checked against `SHA256SUMS`. First run shows the OPENWALLET banner and signs in with an email code inline.
Rebuild after CLI changes: `cd apps/cli && OPENWALLET_PUBLIC_URL=http://127.0.0.1:8470 bun run build`, then
`cd dist/cli && sha256sum openwallet-* > SHA256SUMS` and redeploy. Re-running the install line updates.

## Develop

```bash
export PATH=$HOME/.bun/bin:$PATH
bun install && bun test                                    # 60 tests
(cd sidecar/intent && python3 -m venv .venv && .venv/bin/pip install scikit-learn joblib \
  && .venv/bin/python train.py && .venv/bin/python serve.py)          # gate on :8471 (optional: rules fallback)
(cd apps/web && bun run build)
TENAI_DEV_PRINT_OTP=1 TENAI_ADMINS=you@example.com \
TENAI_REPOS='[{"name":"demo","path":"/abs/clone","baseBranch":"env/dev","allowedCommands":[]}]' bun run server
OPENWALLET_SERVER=http://127.0.0.1:8470 bun run cli login && OPENWALLET_SERVER=http://127.0.0.1:8470 bun run cli
```

Without `TENAI_CLAUDE_TOKEN_FILE` the agent uses the local `claude` login — laptop dev only.

## Intent gate

`train.py` refuses to write a model unless the hand-written held-out set clears **out-of-scope recall ≥ 0.95**
and **code false-refusal ≤ 0.05**. The gate scores *code vs not* (P(task)+P(question)), so task/question ambiguity
never refuses an engineer. Current v1: held-out 28/28 (tuned against it), separate blind set 21/22 — the miss was a
false refusal. Low-confidence code prompts get a "rephrase" message, not a silent drop, and every decision shows in
the dashboard's Gate view for retraining. Short follow-ups (≤40 chars / "yes", "do it") inherit the last code label
for 10 minutes.

## Deploy (127.0.0.1)

1. **Bootstrap (root, once):** copy `ops/` to the host, `sudo ops/bootstrap.sh`. Creates users `tenai` (server)
   and `tenai-agent` (agent, no secrets), `/srv/tenai/{app,bin,repos,data,etc,secrets}`, sudoers, systemd units.
2. **Toolchain:** put `bun` and `claude` at `/srv/tenai/bin/bun` and `/srv/tenai/bin/claude` (copy the binaries;
   both must be executable by `tenai-agent`).
3. **Secrets** (`/srv/tenai/secrets`, `tenai:tenai 600`):
   - `claude_token` ← `claude setup-token` output (pilot: the owner's subscription; switch to the company API key
     later — provider is config).
   - `gitlab_bot` ← GitLab project access token, role Developer, scope `write_repository`.
   - `smtp_pass` ← once SMTP is chosen; until then `TENAI_DEV_PRINT_OTP=1` prints OTPs to the journal.
4. **GitLab:** protect `env/dev`, `env/uat`, `main` (no push for Developer). The bot can then only create branches.
5. **Repos:** as `tenai`, clone each allowlisted repo into `/srv/tenai/repos/<name>` with the bot token, then
   `git config core.sharedRepository group` (the agent commits as `tenai-agent` in the same group). List them in
   `TENAI_REPOS` in `/srv/tenai/etc/tenai.env`. Add `data/context/<name>.md` packs for repo-specific guidance.
6. **Ship it:** from a laptop, `ops/deploy.sh riley@127.0.0.1`.
7. Engineers: `openwallet login` with `OPENWALLET_SERVER=http://127.0.0.1:8470`. The Teams channel carries this link.

To verify on the host after the first deploy (not testable on a laptop): `sudo -u tenai-agent` start under the
hardened unit, `tenai-agent` cannot read `/srv/tenai/secrets` or `/home/*`, a worktree commit by the agent succeeds,
and a bot push to `env/dev` is rejected by GitLab.

## Guarantees and their limits

- Refused prompts create zero usage rows. Guardrails run before the gate.
- Bash runs only allowlisted prefixes; no `;`, `|`, `&`, `$()`, redirects or newlines; paths are confined to the
  worktree (symlinks resolved). DB clients, Vault, cloud CLIs, `curl`/`wget`, `ssh`, `git push` are denied twice
  (CLI denylist + hook).
- Per-repo build commands (e.g. `./gradlew test`) execute repo code the agent may have edited, and that code runs
  with the agent's environment (including the Claude token). Keep `allowedCommands` empty for repos where that is
  not acceptable, and restrict the host's egress for `tenai-agent` to GitLab and Anthropic.
