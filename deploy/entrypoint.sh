#!/bin/sh
# Quai container entrypoint.
#
# Brings up the deploy channel before the supervisor: sshd with keys pinned to
# the forced command, so a deploy credential can never yield a shell. Without
# this the CLI has nothing to talk to and the whole deploy path is unusable.
set -e

QUAI_HOMES="${QUAI_HOMES:-/srv/quai/homes}"
QUAI_STATE="${QUAI_STATE:-/srv/quai/state}"
mkdir -p "$QUAI_HOMES" "$QUAI_STATE" /run/sshd /root/.ssh

# A token is required for the supervisor's administrative endpoints. Generating
# one when absent keeps a fresh instance from silently accepting no credential.
if [ -z "$QUAI_DEPLOY_TOKEN" ]; then
  if [ ! -f "$QUAI_STATE/deploy-token" ]; then
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$QUAI_STATE/deploy-token"
    chmod 600 "$QUAI_STATE/deploy-token"
  fi
  QUAI_DEPLOY_TOKEN="$(cat "$QUAI_STATE/deploy-token")"
fi
export QUAI_DEPLOY_TOKEN

# Host keys live on the volume so a container rebuild does not make every
# client warn about a changed identity.
mkdir -p "$QUAI_STATE/ssh"
if [ ! -f "$QUAI_STATE/ssh/ssh_host_ed25519_key" ]; then
  ssh-keygen -q -t ed25519 -N "" -f "$QUAI_STATE/ssh/ssh_host_ed25519_key"
fi
cp "$QUAI_STATE/ssh/ssh_host_ed25519_key"* /etc/ssh/ 2>/dev/null || true
chmod 600 /etc/ssh/ssh_host_ed25519_key

# Operator-supplied deploy keys, each pinned to the forced command.
: > /root/.ssh/authorized_keys
if [ -f "$QUAI_STATE/authorized_keys" ]; then
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    case "$key" in \#*) continue ;; esac
    printf 'command="/usr/local/bin/quai-forced-command",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc %s\n' "$key" >> /root/.ssh/authorized_keys
  done < "$QUAI_STATE/authorized_keys"
fi
chmod 600 /root/.ssh/authorized_keys

# The token reaches the forced command through its own environment file rather
# than the SSH session, which carries nothing the client controls.
printf 'export QUAI_DEPLOY_TOKEN=%s\nexport QUAI_SUPERVISOR=http://127.0.0.1:%s\n' \
  "$QUAI_DEPLOY_TOKEN" "${QUAI_PORT:-8080}" > /etc/quai-env
chmod 600 /etc/quai-env

/usr/sbin/sshd -e 2>&1 | sed 's/^/sshd: /' &

exec bun run /opt/quai/src/supervisor/main.ts

