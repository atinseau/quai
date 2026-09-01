#!/bin/bash
# Quai behind a real reverse proxy.
#
# The overlay in deploy/overlays/ claims that a request for a project's
# subdomain reaches that project, and that the Host header survives the trip.
# Both are claims about a proxy Quai does not control, so they are worth
# nothing until a real one has forwarded a real request.
#
# Usage: test/proxy.sh [image]

set -uo pipefail

IMAGE="${1:-ghcr.io/atinseau/quai:latest}"
NETWORK="quai-proxy-test-net"
PROXY="quai-proxy-test-traefik"
QUAI="quai-proxy-test"
VOLUME="quai-proxy-test-vol"
PORT="${QUAI_PROXY_TEST_PORT:-18130}"
TOKEN="proxy-token"
ZONE="quai.test"

PASS=0
FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
sect() { echo; echo "== $1"; }

WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$PROXY" "$QUAI" >/dev/null 2>&1
  docker volume rm "$VOLUME" >/dev/null 2>&1
  docker network rm "$NETWORK" >/dev/null 2>&1
}
trap cleanup EXIT

# --- a Quai instance, reachable only through the proxy --------------------
sect "starting Quai behind Traefik"
cleanup
docker network create "$NETWORK" >/dev/null
docker volume create "$VOLUME" >/dev/null

cat > "$WORK/boot.sh" <<'BOOT'
set -e
if [ ! -f /vol/xfs.img ]; then
  dd if=/dev/zero of=/vol/xfs.img bs=1M count=1024 status=none
  mkfs.xfs -q -f /vol/xfs.img
fi
mkdir -p /srv/quai/homes
mount -t xfs -o loop,prjquota /vol/xfs.img /srv/quai/homes
exec /usr/local/bin/quai-entrypoint
BOOT

# No published port: the proxy reaches it over the network, which is the
# arrangement the overlay describes.
docker run -d --name "$QUAI" --privileged --cgroupns=host \
  --network "$NETWORK" \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$VOLUME:/vol" \
  -v "$WORK/boot.sh:/boot.sh:ro" \
  -e QUAI_ZONE="$ZONE" -e QUAI_STATE=/vol/state -e QUAI_DEPLOY_TOKEN="$TOKEN" \
  --label traefik.enable=true \
  --label "traefik.http.routers.quai.rule=HostRegexp(\`^.+\\.$ZONE\$\`)" \
  --label traefik.http.routers.quai.entrypoints=web \
  --label traefik.http.services.quai.loadbalancer.server.port=8080 \
  "$IMAGE" bash /boot.sh >/dev/null || { echo "could not start Quai"; exit 1; }

docker run -d --name "$PROXY" \
  --network "$NETWORK" \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -p "$PORT:80" \
  traefik:v3.6 \
  --providers.docker=true \
  --providers.docker.exposedbydefault=false \
  --providers.docker.network="$NETWORK" \
  --entrypoints.web.address=:80 >/dev/null || { echo "could not start Traefik"; exit 1; }

through_proxy() {
  # $1 host header, $2 path
  curl -s -m 15 -o /dev/null -w "%{http_code}" -H "Host: $1" "http://localhost:$PORT$2"
}

# The overlay's rule matches a project subdomain, not the bare zone: health is
# an operator endpoint and is not meant to be published. Readiness is therefore
# asked of the instance directly, and everything after it goes through Traefik.
for _ in $(seq 120); do
  docker exec "$QUAI" curl -fsS -m 5 -H "Host: $ZONE" http://localhost:8080/health 2>/dev/null \
    | grep -q healthy && break
  sleep 1
done

docker exec "$QUAI" curl -fsS -m 5 -H "Host: $ZONE" http://localhost:8080/health 2>/dev/null \
  | grep -q healthy \
  && ok "the instance is healthy behind the proxy" \
  || {
    bad "the instance never became healthy"
    docker logs "$PROXY" 2>&1 | tail -10 | sed 's/^/      /'
    docker logs "$QUAI" 2>&1 | tail -10 | sed 's/^/      /'
    echo "  $PASS passed, $FAIL failed"
    exit 1
  }

# --- a project, reached by its own subdomain ------------------------------
sect "routing a project"
mkdir -p "$WORK/site"
echo "<h1>through the proxy</h1>" > "$WORK/site/index.html"
( cd "$WORK/site" && COPYFILE_DISABLE=1 tar --no-xattrs -cf "$WORK/site.tar" -- * )

# Copied rather than piped: a redirection into 'docker exec' without -i leaves
# the archive empty, and the deploy then fails for a reason that has nothing to
# do with what this test is checking.
docker cp "$WORK/site.tar" "$QUAI:/tmp/site.tar" >/dev/null
docker exec "$QUAI" sh -c \
  "curl -s -m 60 -X POST --data-binary @/tmp/site.tar -H 'x-quai-token: $TOKEN' \
   'http://localhost:8080/_quai/deploy?project=site&type=static'" >/dev/null

for _ in $(seq 30); do
  [ "$(through_proxy "site.$ZONE" /)" = "200" ] && break
  sleep 1
done

[ "$(through_proxy "site.$ZONE" /)" = "200" ] \
  && ok "a project is reached at its own subdomain, through the proxy" \
  || bad "the project was not reachable through the proxy"

# The whole routing model rests on this: a proxy that rewrites Host sends
# every project to the same place, and the failure looks like a plain 404.
BODY="$(curl -s -m 15 -H "Host: site.$ZONE" "http://localhost:$PORT/")"
case "$BODY" in
  *"through the proxy"*) ok "the Host header survived the proxy, so the right project answered" ;;
  *) bad "the wrong content came back: ${BODY:-nothing}" ;;
esac

# A deployed project must be routable without touching the proxy again.
docker exec "$QUAI" sh -c \
  "curl -s -m 60 -X POST --data-binary @/tmp/site.tar -H 'x-quai-token: $TOKEN' \
   'http://localhost:8080/_quai/deploy?project=second&type=static'" >/dev/null

for _ in $(seq 30); do
  [ "$(through_proxy "second.$ZONE" /)" = "200" ] && break
  sleep 1
done

[ "$(through_proxy "second.$ZONE" /)" = "200" ] \
  && ok "a newly deployed project is routed without reconfiguring the proxy" \
  || bad "a new project needed the proxy reconfigured"

# An unknown project must not be served by a neighbour.
[ "$(through_proxy "absent.$ZONE" /)" = "404" ] \
  && ok "an unknown project is a 404, not somebody else's site" \
  || bad "an unknown project did not answer 404"

sect "result"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
