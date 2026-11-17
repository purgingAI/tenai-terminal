#!/usr/bin/env bash
# TenAI on a shared box without root (same pattern as Studio's ~/amp/deploy/run_server.sh):
#   ./run.sh          start what isn't running (cron runs this every minute and at boot)
#   ./run.sh status   ./run.sh stop   ./run.sh smtp  (refresh SMTP settings from Vault)
set -u
T="$HOME/tenai"; APP="$T/app"; LOG="$T/logs"; mkdir -p "$LOG"
up() { ss -ltn 2>/dev/null | grep -q ":$1 "; }
smtp() {  # read-only Vault fetch in a throwaway subshell; the Vault token never reaches TenAI's env
  ( set -a; . "$HOME/amp/.env.vault"; set +a
    "$HOME/amp/.venv/bin/python" "$APP/ops/host/smtp_from_vault.py" "$T/secrets/smtp_pass" ) > "$T/etc/smtp.env.tmp" \
    && mv "$T/etc/smtp.env.tmp" "$T/etc/smtp.env" && chmod 600 "$T/etc/smtp.env" && echo "  smtp settings refreshed"
}
case "${1:-up}" in
  status) for p in 8471:intent 8470:server; do printf '  %-7s :%s  ' "${p#*:}" "${p%%:*}"; up "${p%%:*}" && echo up || echo DOWN; done; exit 0;;
  stop) crontab -l 2>/dev/null | grep -v 'tenai/app/ops/host/run.sh' | crontab -
        for p in 8470 8471; do PID=$(ss -ltnp 2>/dev/null | grep ":$p " | grep -oP 'pid=\K[0-9]+' | head -1)
          [ -n "$PID" ] && kill "$PID" && echo "  stopped :$p"; done; exit 0;;
  smtp) smtp; exit $?;;
esac
if ! crontab -l 2>/dev/null | grep -q 'tenai/app/ops/host/run.sh'; then
  ( crontab -l 2>/dev/null; echo "* * * * * $APP/ops/host/run.sh >/dev/null 2>&1"; echo "@reboot $APP/ops/host/run.sh >/dev/null 2>&1" ) | crontab -
fi
[ -f "$T/etc/smtp.env" ] || smtp
# every 10 minutes (and on first run): fetch the repos + rebuild context packs, one at a time
if [ $(( 10#$(date +%M) % 10 )) -eq 0 ] || [ ! -d "$T/data/context" ]; then
  ( flock -n 9 || exit 0; python3 "$APP/ops/host/refresh.py" >> "$LOG/refresh.log" 2>&1 ) 9>"$T/data/.refresh.lock" &
fi
if ! up 8471 && ! pgrep -u "$(id -u)" -f "serve.py model.joblib 8471" >/dev/null; then
  ( cd "$APP/sidecar/intent" && nohup setsid .venv/bin/python serve.py model.joblib 8471 >> "$LOG/intent.log" 2>&1 < /dev/null & )
  echo "  intent: starting on :8471"
fi
if ! up 8470 && ! pgrep -u "$(id -u)" -f "apps/server/src/main.ts" >/dev/null; then
  # env -i: the server (and so the agent) starts from a clean environment — no Vault token, no AWS keys, nothing
  # inherited from this login shell. Only tenai.env + smtp.env.
  ( cd "$APP" && nohup setsid env -i HOME="$HOME" PATH="$T/bin:$HOME/.local/bin:/usr/bin:/bin" LANG=C.UTF-8 \
      bash -c "set -a; . '$T/etc/tenai.env'; . '$T/etc/smtp.env'; set +a; exec '$T/bin/bun' run apps/server/src/main.ts" \
      >> "$LOG/server.log" 2>&1 < /dev/null & )
  echo "  server: starting on :8470"
fi
