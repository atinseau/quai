#!/bin/bash
# Quai network isolation probe.
# Part A shows the problem: projects on shared loopback can scan and reach
# each other. Part B tests three candidate fixes.

PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
note() { echo "  ..    $1"; }
sect() { echo; echo "== $1"; }
as()   { local u="$1"; shift; setpriv --reuid "$u" --regid "$u" --clear-groups "$@"; }

for u in quai-alpha quai-beta; do
  useradd --create-home --shell /usr/sbin/nologin "$u" 2>/dev/null
  chmod 0750 "/home/$u"
done

sect "A. the problem (these two SHOULD fail: that is the finding)"
as quai-alpha node /opt/net/tcp-server.js 3001 alpha & sleep 0.6

SCAN=$(as quai-beta node /opt/net/scan.js)
note "beta scanning 3000-3010 -> $SCAN"
case "$SCAN" in
  *3001*) bad "beta discovered alpha's port by scanning" ;;
  *)      ok  "beta found nothing" ;;
esac

HIT=$(as quai-beta node /opt/net/connect.js 3001)
case "$HIT" in
  REACHED*) bad "beta read alpha's data: $HIT" ;;
  *)        ok  "beta could not reach alpha ($HIT)" ;;
esac
pkill -f tcp-server.js 2>/dev/null; sleep 0.5

sect "B1. fix: Unix socket inside the project home"
as quai-alpha node /opt/net/uds-server.js /home/quai-alpha/app.sock alpha & sleep 0.6

HIT=$(as quai-beta node /opt/net/connect.js /home/quai-alpha/app.sock)
case "$HIT" in
  REACHED*) bad "beta reached alpha's socket: $HIT" ;;
  *)        ok  "beta blocked from alpha's socket ($HIT)" ;;
esac

HIT=$(as quai-alpha node /opt/net/connect.js /home/quai-alpha/app.sock)
case "$HIT" in
  REACHED*) ok  "alpha still reaches its own socket" ;;
  *)        bad "alpha lost its own socket ($HIT)" ;;
esac

SCAN=$(as quai-beta node /opt/net/scan.js)
case "$SCAN" in
  *none*) ok  "nothing left to scan on loopback" ;;
  *)      bad "ports still exposed: $SCAN (leftover listener?)" ;;
esac
pkill -f uds-server.js 2>/dev/null; sleep 0.3

sect "B2. fix: block outbound TCP by uid (iptables owner match)"
if ! command -v iptables >/dev/null 2>&1; then
  note "iptables not installed, skipping"
elif iptables -A OUTPUT -p tcp -m owner --uid-owner quai-beta \
       -d 127.0.0.1 -j REJECT 2>/dev/null; then
  ok "installed an egress rule scoped to beta's uid"
  as quai-alpha node /opt/net/tcp-server.js 3002 alpha & sleep 0.6
  HIT=$(as quai-beta node /opt/net/connect.js 3002)
  case "$HIT" in
    REACHED*) bad "rule did not stop beta: $HIT" ;;
    *)        ok  "beta blocked at the firewall ($HIT)" ;;
  esac
  HIT=$(as quai-alpha node /opt/net/connect.js 3002)
  case "$HIT" in
    REACHED*) ok  "alpha unaffected by the rule" ;;
    *)        bad "rule caught alpha too ($HIT)" ;;
  esac
  pkill -f tcp-server.js 2>/dev/null; sleep 0.3
  iptables -D OUTPUT -p tcp -m owner --uid-owner quai-beta -d 127.0.0.1 -j REJECT 2>/dev/null
else
  bad "cannot install iptables rules (needs NET_ADMIN)"
fi

sect "B3. fix: per-project network namespace"
if unshare --net --fork --pid --mount-proc \
     sh -c 'ip link set lo up 2>/dev/null; node /opt/net/scan.js' 2>/dev/null \
     | grep -q none; then
  ok "process in its own netns sees an empty loopback"
else
  bad "could not create a private network namespace (needs NET_ADMIN)"
fi

sect "result"
echo "  $PASS passed, $FAIL failed"
