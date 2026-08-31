#!/bin/bash
# Quai's nested deployment, verified end to end.
#
# deploy/nested/compose.yaml claims a host can run Quai while granting nothing
# but one privileged container: no mkfs, no mount, no cgroup writes of its own.
# That claim is only worth something if the isolation still holds inside, so
# this runs the full integration suite nested and checks the wrapper's own
# promises around it.
#
# Usage: test/nested.sh [image]

set -uo pipefail

IMAGE="${1:-ghcr.io/atinseau/quai:latest}"
NAME="quai-nested-test"
PORT="${QUAI_NESTED_PORT:-18110}"
ZONE="quai.test"
DATA_VOLUME="quai-nested-data"
DOCKER_VOLUME="quai-nested-docker"

PASS=0
FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
sect() { echo; echo "== $1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  docker volume rm "$DATA_VOLUME" "$DOCKER_VOLUME" >/dev/null 2>&1
}
trap cleanup EXIT

# The compose file's own shape is checked by CI; what needs proving here is
# that a dind host really can carry Quai, so the container is started directly
# with the same boot script compose runs.
sect "starting a nested host"
cleanup

# The same volumes deploy/nested/compose.yaml declares.
#
# The XFS image cannot live on the container's own overlayfs: a loop mount of a
# file on overlay fails with a bare 'Invalid argument', which reads like a
# corrupt filesystem rather than an unsupported location. This is exactly what
# CI hit while a developer machine — whose Docker storage sits on btrfs —
# passed, so the test now mirrors the deployment instead of approximating it.
docker volume create "$DATA_VOLUME" >/dev/null
docker volume create "$DOCKER_VOLUME" >/dev/null

docker run -d --name "$NAME" --privileged \
  -e DOCKER_TLS_CERTDIR= \
  -e QUAI_IMAGE="$IMAGE" \
  -e QUAI_ZONE="$ZONE" \
  -e QUAI_HOMES_SIZE=2 \
  -v "$DATA_VOLUME:/quai-data" \
  -v "$DOCKER_VOLUME:/var/lib/docker" \
  -v "$ROOT/deploy/nested/boot.sh:/boot.sh:ro" \
  -p "$PORT:8080" \
  docker:29-dind /bin/sh -c \
  'dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 & exec /bin/sh /boot.sh' \
  >/dev/null || { echo "could not start the nested host"; exit 1; }

# A locally built image exists only on this machine, so it is handed to the
# inner daemon directly. Without this the nested host would look for it in a
# registry that has never heard of it.
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  for _ in $(seq 60); do
    docker exec "$NAME" docker info >/dev/null 2>&1 && break
    sleep 2
  done
  docker save "$IMAGE" | docker exec -i "$NAME" docker load >/dev/null 2>&1 \
    || echo "  ..    could not preload $IMAGE; the nested host will pull it"
fi

# First boot formats the XFS image and starts Quai.
for _ in $(seq 180); do
  curl -s -m 5 -H "Host: $ZONE" "http://localhost:$PORT/health" 2>/dev/null | grep -q healthy && break
  sleep 2
done

HEALTH="$(curl -s -m 15 -H "Host: $ZONE" "http://localhost:$PORT/health" 2>/dev/null)"
case "$HEALTH" in
  *'"status":"healthy"'*)
    ok "a nested Quai reports healthy isolation" ;;
  *)
    bad "nested isolation is not healthy: ${HEALTH:-no response}"
    docker logs "$NAME" 2>&1 | tail -20 | sed 's/^/      /'
    echo "  $PASS passed, $FAIL failed"
    exit 1 ;;
esac

# The point of the exercise: the host granted one container and nothing else.
sect "what the host was asked for"
grep -q ' /srv/quai/homes ' /proc/mounts 2>/dev/null \
  && bad "the host itself carries the project homes mount" \
  || ok "the host has no XFS mount of its own"

docker exec "$NAME" grep -q ' /srv/quai/homes .*prjquota' /proc/mounts \
  && ok "the quota volume lives inside the nested host" \
  || bad "the nested host has no prjquota volume"

# A private cgroup namespace is what keeps the inner cgroups from landing in
# the host's own tree, which is the whole reason this arrangement is safer.
NS="$(docker inspect "$NAME" --format '{{.HostConfig.CgroupnsMode}}')"
[ "$NS" != "host" ] \
  && ok "the nested host does not share the machine's cgroup namespace" \
  || bad "the nested host was given the machine's cgroup namespace"

# --- the guarantees themselves -------------------------------------------
# Running the whole suite inside proves the isolation survives nesting, rather
# than assuming it does because the supervisor said so.
sect "the isolation suite, nested"
docker exec "$NAME" sh -c 'apk add --no-cache bash curl tar >/dev/null 2>&1' || true
docker cp "$ROOT/test/integration.sh" "$NAME:/integration.sh" >/dev/null

if docker exec "$NAME" bash /integration.sh "$IMAGE" 2>&1 | sed 's/^/  /'; then
  ok "all isolation guarantees hold inside a nested host"
else
  bad "the isolation suite failed inside a nested host"
fi

# --- surviving a restart --------------------------------------------------
# A nested Quai keeps its state on volumes, so a restarted wrapper must find
# its XFS image rather than format a new one over the projects.
sect "restarting the nested host"
docker restart "$NAME" >/dev/null

for _ in $(seq 180); do
  curl -s -m 5 -H "Host: $ZONE" "http://localhost:$PORT/health" 2>/dev/null | grep -q healthy && break
  sleep 2
done

curl -s -m 15 -H "Host: $ZONE" "http://localhost:$PORT/health" 2>/dev/null | grep -q '"status":"healthy"' \
  && ok "the nested host comes back healthy" \
  || bad "the nested host did not come back healthy"

docker logs "$NAME" 2>&1 | grep -q 'first boot only' \
  && [ "$(docker logs "$NAME" 2>&1 | grep -c 'first boot only')" -gt 1 ] \
  && bad "the XFS image was reformatted on restart, losing every project" \
  || ok "the restart reused the existing XFS image"

sect "result"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
