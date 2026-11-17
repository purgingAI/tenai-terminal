#!/usr/bin/env bash
# One-time, as root on the host: users, dirs, sudoers, units. Idempotent. Does not touch other services.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)

id tenai >/dev/null 2>&1 || useradd --system --home /srv/tenai --shell /usr/sbin/nologin tenai
id tenai-agent >/dev/null 2>&1 || useradd --system --home /srv/tenai/data/agent-home --shell /usr/sbin/nologin tenai-agent
usermod -aG tenai tenai-agent   # shared group: agent edits worktrees the server created

install -d -o tenai -g tenai -m 2775 /srv/tenai /srv/tenai/app /srv/tenai/bin /srv/tenai/repos /srv/tenai/data \
  /srv/tenai/data/worktrees /srv/tenai/data/attachments /srv/tenai/data/agent-home
install -d -o root -g tenai -m 750 /srv/tenai/etc
install -d -o tenai -g tenai -m 700 /srv/tenai/secrets            # agent (other user) cannot list or read
chown tenai-agent:tenai /srv/tenai/data/agent-home; chmod 2770 /srv/tenai/data/agent-home
# The agent commits inside worktrees owned by tenai: git refuses "dubious ownership" without this.
printf '[safe]\n\tdirectory = *\n' > /srv/tenai/data/agent-home/.gitconfig
chown tenai-agent:tenai /srv/tenai/data/agent-home/.gitconfig

[[ -f /srv/tenai/etc/tenai.env ]] || install -o root -g tenai -m 640 "$HERE/tenai.env.example" /srv/tenai/etc/tenai.env
install -o root -g root -m 440 "$HERE/sudoers.tenai" /etc/sudoers.d/tenai && visudo -cf /etc/sudoers.d/tenai
install -m 644 "$HERE/tenai-server.service" "$HERE/tenai-intent.service" /etc/systemd/system/
systemctl daemon-reload
echo "bootstrap ok. Next: secrets (README §Secrets), repo clones, then ops/deploy.sh from a laptop."
