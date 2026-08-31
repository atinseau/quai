#!/bin/sh
# Brings up Quai inside a Docker-in-Docker host.
#
# Everything Quai needs from a host — an XFS volume with project quotas, a
# shared cgroup namespace, NET_ADMIN and SYS_ADMIN — is provided by this inner
# Docker rather than by the machine. The outer host contributes one privileged
# container and nothing else: no mkfs, no mount, no cgroup writes, and no
# iptables rules mixed into whatever else it already runs.
#
# The isolation Quai enforces is unchanged. The inner daemon runs in its own
# cgroup namespace, so the 'cgroup: host' the supervisor requires is satisfied
# relative to this container, and every cgroup it creates stays inside it.
set -e

QUAI_IMAGE="${QUAI_IMAGE:-ghcr.io/atinseau/quai:latest}"
QUAI_ZONE="${QUAI_ZONE:-quai.localhost}"
# Sized in GiB. XFS needs 512 MiB at the very least, and every project quota
# is carved out of this one file.
QUAI_HOMES_SIZE="${QUAI_HOMES_SIZE:-8}"

DATA=/quai-data
IMG="$DATA/homes.img"
HOMES=/srv/quai/homes

log() { echo "[quai-nested] $*"; }

# The dind image ships DOCKER_HOST=tcp://docker:2375 for clients running in a
# sibling container. This script is not one of them: it talks to the daemon
# beside it, and inheriting that variable sends every command to a hostname
# that does not resolve — which looks exactly like a daemon that never came up.
unset DOCKER_HOST

# --- wait for the inner daemon -------------------------------------------
# Compose starts this script alongside dockerd, so the socket is not there yet.
#
# Three minutes rather than one: a restart makes dockerd restore its previous
# containers and rebuild its network sandboxes before it answers, which was
# measured to overrun a 60s budget on an ordinary machine. Giving up early
# here costs a whole container restart to reach the same place.
for _ in $(seq 180); do
  docker info >/dev/null 2>&1 && break
  sleep 1
done
if ! docker info >/dev/null 2>&1; then
  log "the inner Docker daemon never came up; its log follows"
  tail -20 /var/log/dockerd.log 2>/dev/null || true
  exit 1
fi

# --- the XFS volume, built here rather than on the host ------------------
# The image is created once and kept on a named volume, so projects and their
# quotas survive a restart of this container.
mkdir -p "$DATA" "$HOMES"

if [ ! -f "$IMG" ]; then
  log "creating a ${QUAI_HOMES_SIZE}GiB XFS image (first boot only)"
  # fallocate is not available on every filesystem backing the volume; dd is.
  fallocate -l "${QUAI_HOMES_SIZE}G" "$IMG" 2>/dev/null ||
    dd if=/dev/zero of="$IMG" bs=1M count=$((QUAI_HOMES_SIZE * 1024)) status=none
  mkfs.xfs -q "$IMG"
fi

# A restart re-enters this script with the mount gone, so mounting is
# unconditional but tolerates being asked twice.
if ! grep -q " $HOMES " /proc/mounts; then
  mount -o loop,prjquota "$IMG" "$HOMES"
fi
grep -q " $HOMES " /proc/mounts || { log "the XFS volume did not mount"; exit 1; }
log "project homes carry prjquota"

# --- run Quai -------------------------------------------------------------
# Replacing rather than reusing: the container is disposable, while everything
# worth keeping lives on the two volumes.
docker rm -f quai >/dev/null 2>&1 || true

log "pulling $QUAI_IMAGE"
docker pull "$QUAI_IMAGE" >/dev/null

log "starting the supervisor"
# shellcheck disable=SC2086  # the token flag is deliberately unquoted: it must
# vanish entirely when no token is set rather than become an empty argument.
docker run -d --name quai \
  --restart unless-stopped \
  --cgroupns host \
  --cap-add NET_ADMIN --cap-add SYS_ADMIN \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$HOMES:/srv/quai/homes" \
  -v quai-state:/srv/quai/state \
  -p 8080:8080 \
  -p 22:22 \
  -e QUAI_HOMES=/srv/quai/homes \
  -e QUAI_STATE=/srv/quai/state \
  -e QUAI_PORT=8080 \
  -e QUAI_ZONE="$QUAI_ZONE" \
  ${QUAI_DEPLOY_TOKEN:+-e QUAI_DEPLOY_TOKEN="$QUAI_DEPLOY_TOKEN"} \
  "$QUAI_IMAGE" >/dev/null

log "supervisor started; zone $QUAI_ZONE"

# --- stay in the foreground ----------------------------------------------
# This process is the container's lifetime. Following the supervisor's log both
# keeps it alive and puts that log where 'docker logs' on the host finds it.
#
# A nested Quai that has silently died should take its wrapper down rather
# than keep looking healthy from outside.
docker logs -f quai 2>&1 &
LOGS=$!

trap 'docker stop quai >/dev/null 2>&1; kill $LOGS 2>/dev/null; exit 0' TERM INT

while docker inspect -f '{{.State.Running}}' quai 2>/dev/null | grep -q true; do
  sleep 5
done

log "the supervisor stopped"
kill $LOGS 2>/dev/null || true
exit 1
