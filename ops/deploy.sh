#!/usr/bin/env bash
# From a laptop: ship the code to the host, build, train the gate, restart. Usage: ops/deploy.sh [user@host]
set -euo pipefail
HOST=${1:-riley@127.0.0.1}
cd "$(dirname "$0")/.."
rsync -az --delete --exclude node_modules --exclude data --exclude spike --exclude .git --exclude apps/web/dist \
  --exclude 'sidecar/intent/.venv' --exclude 'sidecar/intent/models' --exclude '*.joblib' --exclude .env ./ "$HOST:/tmp/tenai-app/"
ssh "$HOST" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
rsync -a --delete --exclude 'sidecar/intent/.venv' --exclude 'sidecar/intent/models' --exclude '*.joblib' /tmp/tenai-app/ /srv/tenai/app/
chown -R tenai:tenai /srv/tenai/app
cd /srv/tenai/app
[[ -x /srv/tenai/bin/bun ]] || { echo "missing /srv/tenai/bin/bun (README §Toolchain)"; exit 1; }
[[ -x /srv/tenai/bin/claude ]] || { echo "missing /srv/tenai/bin/claude (README §Toolchain)"; exit 1; }
sudo -u tenai /srv/tenai/bin/bun install --frozen-lockfile
sudo -u tenai bash -c 'cd apps/web && /srv/tenai/bin/bun run build'
sudo -u tenai bash -c 'cd sidecar/intent && { [[ -d .venv ]] || python3 -m venv .venv; } \
  && .venv/bin/pip install -q scikit-learn joblib && .venv/bin/python train.py model.joblib | tail -2'
systemctl enable --now tenai-intent tenai-server
systemctl restart tenai-intent tenai-server
sleep 2; systemctl --no-pager --lines=5 status tenai-server | head -12
curl -sf http://127.0.0.1:8471/health && echo
REMOTE
