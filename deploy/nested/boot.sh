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

# An image already loaded into the inner daemon — as the test suite does with a
# locally built one — must not be replaced by a registry lookup that would fail.
if ! docker image inspect "$QUAI_IMAGE" >/dev/null 2>&1; then
  log "pulling $QUAI_IMAGE"
  if ! docker pull "$QUAI_IMAGE" >/dev/null 2>&1; then
    # A pull can fail because the tag is local-only and still being loaded from
    # outside, so failing here would lose a race rather than report a problem.
    log "could not pull it; waiting for it to be loaded instead"
    for _ in $(seq 120); do
      docker image inspect "$QUAI_IMAGE" >/dev/null 2>&1 && break
      sleep 1
    done
  fi
fi

docker image inspect "$QUAI_IMAGE" >/dev/null 2>&1 || {
  log "$QUAI_IMAGE is not available to the inner daemon"
  exit 1
}

if [ ! -f "$IMG" ]; then
  log "creating a ${QUAI_HOMES_SIZE}GiB XFS image (first boot only)"
  # fallocate is not available on every filesystem backing the volume; dd is.
  fallocate -l "${QUAI_HOMES_SIZE}G" "$IMG" 2>/dev/null ||
    dd if=/dev/zero of="$IMG" bs=1M count=$((QUAI_HOMES_SIZE * 1024)) status=none

  # Formatted with the Quai image's mkfs.xfs rather than this one.
  #
  # A newer xfsprogs enables on-disk features a slightly older kernel refuses,
  # and the mount then fails with nothing but 'Invalid argument'. The version
  # shipped alongside the supervisor is the one every kernel Quai supports has
  # been verified against, so the filesystem is made by the same tool that
  # will use it.
  docker run --rm -v "$DATA:/data" --entrypoint mkfs.xfs "$QUAI_IMAGE" -q /data/homes.img
fi

# A restart re-enters this script with the mount gone, so mounting is
# unconditional but tolerates being asked twice.
if ! grep -q " $HOMES " /proc/mounts; then
  # '-t xfs' is not decoration.
  #
  # Without a type, busybox mount tries each filesystem already listed in
  # /proc/filesystems. Where xfs is a module the host has not loaded yet, it is
  # absent from that list, never tried, and the failure surfaces as a bare
  # 'Invalid argument' that says nothing about a missing module. Naming the
  # type makes the kernel load it on demand instead.
  if ! mount -t xfs -o loop,prjquota "$IMG" "$HOMES" 2>&1; then
    # 'Invalid argument' is all mount says when a loop mount is refused, which
    # covers several unrelated causes. The kernel log names the real one.
    log "the loop mount was refused; what the kernel said:"
    dmesg 2>/dev/null | tail -15 | sed 's/^/    /' || log "    (dmesg unavailable)"
    log "xfs support: $(grep -c xfs /proc/filesystems) entry/entries in /proc/filesystems"
    log "loop devices: $(losetup -a 2>&1 | head -3)"
    exit 1
  fi
fi
grep -q " $HOMES " /proc/mounts || { log "the XFS volume did not mount"; exit 1; }
log "project homes carry prjquota"

# --- run Quai -------------------------------------------------------------
# Replacing rather than reusing: the container is disposable, while everything
# worth keeping lives on the two volumes.
docker rm -f quai >/dev/null 2>&1 || true

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
