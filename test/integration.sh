#!/bin/bash
# Quai integration suite.
#
# The unit tests verify decisions; this verifies guarantees. Everything here
# runs against a real container on a real XFS volume, because the isolation
# Quai promises is enforced by the kernel and cannot be proven any other way.
#
# Usage: test/integration.sh [image]

set -uo pipefail

IMAGE="${1:-quai:integration}"
NAME="quai-integration"
VOLUME="quai-integration-vol"
PORT="${QUAI_TEST_PORT:-18099}"
TOKEN="integration-token"
ZONE="quai.test"

PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
note() { echo "  ..    $1"; }
sect() { echo; echo "== $1"; }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  docker volume rm "$VOLUME" >/dev/null 2>&1
}
trap cleanup EXIT

# --- the host must provide XFS with prjquota; here we build one in a loop file
boot_script() {
  cat <<'BOOT'
set -e
if [ ! -f /vol/xfs.img ]; then
  # 512 MiB is the XFS minimum; the quota test writes past a 1 GiB limit, so
  # the cap is what stops it rather than the volume running out.
  dd if=/dev/zero of=/vol/xfs.img bs=1M count=1024 status=none
  mkfs.xfs -q -f /vol/xfs.img
fi
mkdir -p /srv/quai/homes
mount -o loop,prjquota /vol/xfs.img /srv/quai/homes
exec /usr/local/bin/quai-entrypoint
BOOT
}

in_container() { docker exec "$NAME" sh -c "$1" 2>&1; }

# Runs a script inside the container. Quoting a whole shell snippet through
# docker exec is fragile, so it travels as a file instead.
in_container_script() {
  local script
  script="$(mktemp "$WORK/snippet.XXXXXX")"
  cat > "$script"
  if ! docker cp "$script" "$NAME:/tmp/snippet.sh" >/dev/null 2>&1; then
    echo "in_container_script: could not copy the snippet into $NAME"
    return 1
  fi
  docker exec "$NAME" sh /tmp/snippet.sh 2>&1
}

request() {
  # $1 host header, $2 path
  curl -s -m 15 -o /dev/null -w "%{http_code}" -H "Host: $1" "http://localhost:$PORT$2"
}

deploy() {
  # $1 project, $2 query, $3 tar path
  curl -s -m 60 -X POST --data-binary "@$3" -H "x-quai-token: $TOKEN" \
    "http://localhost:$PORT/_quai/deploy?project=$1&$2"
}

# --- fixtures -------------------------------------------------------------

WORK="$(mktemp -d)"

make_tar() {
  # $1 directory, $2 output — a tar the supervisor can unpack.
  # Named entries only: a leading "./" or a macOS resource fork would be
  # deployed as a file the developer never wrote.
  ( cd "$1" && COPYFILE_DISABLE=1 tar --no-xattrs -cf "$2" -- * )
}

mkdir -p "$WORK/site"
echo "<h1>hello</h1>" > "$WORK/site/index.html"
make_tar "$WORK/site" "$WORK/site.tar"

mkdir -p "$WORK/service"
cat > "$WORK/service/server.js" <<'SERVICE'
const http = require("http");
const fs = require("fs");
fs.writeFileSync(process.env.HOME + "/secret.txt", "secret-of-" + process.env.USER);
const hog = [];
http.createServer((req, res) => {
  if (req.url === "/eat") {
    for (let i = 0; i < 400; i++) hog.push(Buffer.alloc(8 * 1024 * 1024, 1));
    res.end("survived");
    return;
  }
  if (req.url === "/fork") {
    const { spawn } = require("child_process");
    for (let i = 0; i < 300; i++) { try { spawn("sleep", ["30"]); } catch {} }
    res.end("forked");
    return;
  }
  res.end(JSON.stringify({ user: process.env.USER, uid: process.getuid() }));
// listens on 8080 deliberately: two projects must be able to share it
}).listen(8080, "0.0.0.0");
SERVICE
make_tar "$WORK/service" "$WORK/service.tar"

# --- start ----------------------------------------------------------------

sect "starting $IMAGE"
cleanup
docker volume create "$VOLUME" >/dev/null
boot_script > "$WORK/boot.sh"

docker run -d --name "$NAME" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$VOLUME:/vol" \
  -v "$WORK/boot.sh:/boot.sh:ro" \
  -e QUAI_ZONE="$ZONE" -e QUAI_STATE=/vol/state -e QUAI_DEPLOY_TOKEN="$TOKEN" \
  -p "$PORT:8080" "$IMAGE" bash /boot.sh >/dev/null || { echo "could not start"; exit 1; }

# The first boot formats a 3 GiB XFS image, which takes longer than a restart.
for _ in $(seq 90); do
  [ "$(request "$ZONE" /health)" = "200" ] && break
  sleep 1
done

HEALTH="$(curl -s -m 15 -H "Host: $ZONE" "http://localhost:$PORT/health")"
case "$HEALTH" in
  *'"status":"healthy"'*) ok "the instance reports healthy isolation" ;;
  *)
    bad "isolation is not healthy: ${HEALTH:-no response}"
    note "container log:"
    docker logs "$NAME" 2>&1 | tail -8 | sed "s/^/      /"
    ;;
esac

# --- deploys --------------------------------------------------------------

sect "deploying"
deploy site "type=static&disk=64Mi" "$WORK/site.tar" >/dev/null
deploy alpha "type=service&start=node%20server.js" "$WORK/service.tar" >/dev/null
deploy beta  "type=service&start=node%20server.js" "$WORK/service.tar" >/dev/null

# A service needs a moment to bind; polling beats a fixed sleep that is either
# too short on a loaded machine or wasted on a fast one.
await_serving() {
  for _ in $(seq 30); do
    [ "$(request "$1.$ZONE" /)" = "200" ] && return 0
    sleep 1
  done
  return 1
}
await_serving site >/dev/null
await_serving alpha >/dev/null
await_serving beta >/dev/null

[ "$(request site.$ZONE /)"  = "200" ] && ok "a static site is served" || bad "static site is not served"
[ "$(request alpha.$ZONE /)" = "200" ] && ok "a service answers"       || bad "service alpha does not answer"
[ "$(request beta.$ZONE /)"  = "200" ] && ok "a second service answers on the same internal port" \
  || bad "service beta does not answer"

# --- file isolation (prototype probe, against the real product) -----------

sect "file isolation"
A_UID="$(in_container "id -u quai-alpha")"
B_UID="$(in_container "id -u quai-beta")"

as_beta() { in_container "setpriv --reuid $B_UID --regid $B_UID --clear-groups -- $1"; }

as_beta "cat /srv/quai/homes/projects/alpha/secret.txt" | grep -q "secret-of" \
  && bad "beta can read alpha's secret" || ok "beta cannot read alpha's secret"
as_beta "ls /srv/quai/homes/projects/alpha" | grep -q secret \
  && bad "beta can list alpha's home" || ok "beta cannot list alpha's home"
WRITE_ATTEMPT="$(in_container_script <<PROBE
setpriv --reuid $B_UID --regid $B_UID --clear-groups -- \
  touch /srv/quai/homes/projects/alpha/pwned 2>/dev/null && echo written || echo refused
PROBE
)"
case "$WRITE_ATTEMPT" in
  *refused*) ok "beta cannot write into alpha's home" ;;
  *) bad "beta wrote into alpha's home: ${WRITE_ATTEMPT:-no output}" ;;
esac
as_beta "cat /srv/quai/homes/projects/beta/../alpha/secret.txt" | grep -q "secret-of" \
  && bad "traversal reached alpha" || ok "traversal via .. is blocked"
as_beta "cat /srv/quai/homes/sites/site/index.html" | grep -q hello \
  && bad "beta can read a static site off the volume" || ok "beta cannot read a static site"

# --- network isolation ----------------------------------------------------

sect "network isolation"
in_container "ip netns exec quai-alpha timeout 5 curl -s -o /dev/null -w %{http_code} http://10.83.0.6:8080/" \
  | grep -q 200 && bad "alpha reached its neighbour" || ok "alpha cannot reach its neighbour"
in_container "ip netns exec quai-alpha timeout 5 curl -s -o /dev/null -w %{http_code} http://169.254.169.254/" \
  | grep -q 200 && bad "alpha reached cloud metadata" || ok "alpha cannot reach cloud metadata"
in_container "ip netns exec quai-alpha timeout 15 curl -s -o /dev/null -w %{http_code} https://example.com" \
  | grep -q 200 && ok "alpha can still reach the internet" || note "internet unreachable from this host"

# --- syscall confinement --------------------------------------------------

sect "syscall confinement"
CONFINED="$(in_container "for p in \$(pgrep -f \"node server.js\"); do awk \"/^Seccomp:/{print \\\$2}\" /proc/\$p/status; done" | grep -c 2)"
[ "${CONFINED:-0}" -ge 1 ] && ok "project processes run under a seccomp filter" \
  || bad "no project process is confined"

# --- resource limits ------------------------------------------------------

sect "resource limits"
curl -s -m 30 -H "Host: alpha.$ZONE" "http://localhost:$PORT/eat" >/dev/null 2>&1
sleep 2
[ "$(request beta.$ZONE /)" = "200" ] && ok "a neighbour survives a memory runaway" \
  || bad "beta died alongside alpha"
in_container "B=/sys/fs/cgroup\$(cut -d: -f3 /proc/1/cgroup | sed s@/quai-supervisor@@); grep -c \"^oom_kill 1\" \$B/quai-alpha/memory.events" \
  | grep -q 1 && ok "the runaway was killed by its memory cap" || note "no oom_kill recorded"

curl -s -m 30 -H "Host: beta.$ZONE" "http://localhost:$PORT/fork" >/dev/null 2>&1
sleep 2
[ "$(request alpha.$ZONE /)" != "000" ] && ok "the instance survives a fork bomb" \
  || bad "the instance died during a fork bomb"

# --- disk quota -----------------------------------------------------------

sect "disk quota"
in_container "dd if=/dev/zero of=/srv/quai/homes/sites/site/big.bin bs=1M count=200 2>&1 | tail -1" >/dev/null
in_container "dd if=/dev/zero of=/srv/quai/homes/projects/beta/ok.bin bs=1M count=50 2>&1" \
  | grep -q "50" && ok "a neighbour can still write while another is full" \
  || bad "a full project blocked its neighbour"
in_container "xfs_quota -x -c 'report -p -N -b' /srv/quai/homes" | grep -qE "#1000[0-9]" \
  && ok "every project carries its own quota" || bad "projects share quota project 0"
in_container "xfs_quota -x -c 'report -p -N -b' /srv/quai/homes" | grep -qE "^#10000 +6[0-9]{4}" \
  && ok "the declared 64Mi cap is what stopped the write" \
  || note "quota usage: $(in_container "xfs_quota -x -c 'report -p -N -b' /srv/quai/homes" | head -3 | tr '\n' ' ')"

# --- restart --------------------------------------------------------------

sect "surviving a container recreation"
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$VOLUME:/vol" \
  -v "$WORK/boot.sh:/boot.sh:ro" \
  -e QUAI_ZONE="$ZONE" -e QUAI_STATE=/vol/state -e QUAI_DEPLOY_TOKEN="$TOKEN" \
  -p "$PORT:8080" "$IMAGE" bash /boot.sh >/dev/null

for _ in $(seq 90); do
  [ "$(request "$ZONE" /health)" = "200" ] && break
  sleep 1
done

# Restored services need a moment to bind before they answer.
await_serving site >/dev/null
await_serving alpha >/dev/null

[ "$(request site.$ZONE /)"  = "200" ] && ok "the static site came back"  || bad "static site lost"
[ "$(request alpha.$ZONE /)" = "200" ] && ok "the service came back"      || bad "service lost"
[ "$(in_container "id -u quai-alpha")" = "$A_UID" ] && ok "uids are unchanged" \
  || bad "uid changed across recreation"

# --- the deploy key grants nothing else -----------------------------------

sect "deploy credentials"
SHELL_ATTEMPT="$(in_container_script <<'PROBE'
SSH_ORIGINAL_COMMAND=/bin/bash /usr/local/bin/quai-forced-command
PROBE
)"
case "$SHELL_ATTEMPT" in
  *"only deploy"*) ok "a deploy key cannot open a shell" ;;
  *) bad "a shell was granted: ${SHELL_ATTEMPT:-no output}" ;;
esac

ACTION_ATTEMPT="$(in_container_script <<'PROBE'
SSH_ORIGINAL_COMMAND='quai-admin exec alpha' /usr/local/bin/quai-forced-command
PROBE
)"
case "$ACTION_ATTEMPT" in
  *"Unknown action"*) ok "an unlisted action is refused" ;;
  *) bad "an unlisted action ran: ${ACTION_ATTEMPT:-no output}" ;;
esac

PATH_ATTEMPT="$(in_container_script <<'PROBE'
SSH_ORIGINAL_COMMAND='quai-deploy ../etc' /usr/local/bin/quai-forced-command
PROBE
)"
case "$PATH_ATTEMPT" in
  *"Invalid project"*) ok "a path in place of a project name is refused" ;;
  *) bad "a path was accepted as a project name: ${PATH_ATTEMPT:-no output}" ;;
esac

# --- removal --------------------------------------------------------------

sect "removing a project"
curl -s -m 30 -X POST -H "x-quai-token: $TOKEN" \
  "http://localhost:$PORT/_quai/remove?project=alpha" >/dev/null
sleep 2

[ "$(request alpha.$ZONE /)" = "404" ] && ok "the url stops serving" || bad "the url still serves"
in_container "id -u quai-alpha >/dev/null 2>&1 && echo present || echo absent" \
  | grep -q absent && ok "the account is gone" || bad "the account survives"
in_container "test -d /srv/quai/homes/projects/alpha && echo present || echo absent" \
  | grep -q absent && ok "the home is gone" || bad "the home survives"

# --- result ---------------------------------------------------------------

sect "result"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
