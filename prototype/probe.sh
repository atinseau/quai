#!/bin/bash
# Quai isolation probe.
# Answers one question: inside a single Coolify-managed Debian container,
# can we (a) create per-project UNIX accounts on the fly, (b) stop one
# project from reading another's home, and (c) cap a project's memory with
# cgroup v2 so a runaway process cannot take down its neighbours.

PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
note() { echo "  ..    $1"; }
sect() { echo; echo "== $1"; }

as() {
  # run a command as an unprivileged project account
  local u="$1"; shift
  setpriv --reuid "$u" --regid "$u" --clear-groups "$@"
}

sect "environment"
note "uid=$(id -u)  caps=$(grep CapBnd /proc/self/status | awk '{print $2}')"
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  note "cgroup v2 controllers: $(cat /sys/fs/cgroup/cgroup.controllers)"
else
  note "no cgroup v2 unified hierarchy at /sys/fs/cgroup"
fi

sect "1. on-the-fly account creation"
for u in quai-alpha quai-beta; do
  if useradd --create-home --shell /usr/sbin/nologin "$u" 2>/dev/null; then
    ok "created $u (uid $(id -u "$u"))"
  else
    bad "could not create $u"
  fi
done
chmod 0750 /home/quai-alpha /home/quai-beta 2>/dev/null

sect "2. cross-home isolation"
echo "alpha-secret-do-not-leak" > /home/quai-alpha/secret.txt
chown quai-alpha:quai-alpha /home/quai-alpha/secret.txt
chmod 0640 /home/quai-alpha/secret.txt

if as quai-beta cat /home/quai-alpha/secret.txt >/dev/null 2>&1; then
  bad "beta CAN read alpha's secret"
else
  ok "beta cannot read alpha's secret"
fi

if as quai-beta ls /home/quai-alpha >/dev/null 2>&1; then
  bad "beta CAN list alpha's home"
else
  ok "beta cannot list alpha's home"
fi

if as quai-beta touch /home/quai-alpha/pwned 2>/dev/null; then
  bad "beta CAN write into alpha's home"
else
  ok "beta cannot write into alpha's home"
fi

if as quai-beta cat /home/quai-beta/../quai-alpha/secret.txt >/dev/null 2>&1; then
  bad "traversal via .. reached alpha's secret"
else
  ok "traversal via .. blocked"
fi

if as quai-alpha cat /home/quai-alpha/secret.txt >/dev/null 2>&1; then
  ok "alpha can still read its own files"
else
  bad "alpha lost access to its own files"
fi

sect "3. node runs under the project account"
WHO=$(as quai-alpha node -e 'process.stdout.write(String(process.getuid()))' 2>/dev/null)
if [ "$WHO" = "$(id -u quai-alpha)" ]; then
  ok "node runs with alpha's uid ($WHO)"
else
  bad "node did not run as alpha (got '$WHO')"
fi

sect "4. cgroup v2 memory cap"
CG=/sys/fs/cgroup
# The container must see its own cgroup path and have it mounted rw.
# Requires: --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw
OWN=$(cut -d: -f3 /proc/self/cgroup 2>/dev/null)
MYCG="$CG$OWN"
note "own cgroup: $OWN"

if [ ! -w "$CG" ] || [ ! -d "$MYCG" ]; then
  bad "cgroup fs read-only or own path not visible: cannot cap memory"
  note "remedy: --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw"
else
  # A cgroup cannot both hold processes and delegate controllers
  # (no-internal-process rule), so step down into a leaf first.
  mkdir -p "$MYCG/quai-supervisor"
  if echo $$ > "$MYCG/quai-supervisor/cgroup.procs" 2>/dev/null; then
    ok "supervisor moved into its own leaf cgroup"
  else
    bad "could not move supervisor into a leaf cgroup"
  fi

  if echo "+memory" > "$MYCG/cgroup.subtree_control" 2>/dev/null; then
    ok "memory controller delegated to subtree"
  else
    bad "cannot write cgroup.subtree_control (+memory)"
  fi

  mkdir -p "$MYCG/quai-alpha"
  if echo 67108864 > "$MYCG/quai-alpha/memory.max" 2>/dev/null; then
    ok "memory.max set to 64Mi"
    echo 0 > "$MYCG/quai-alpha/memory.swap.max" 2>/dev/null
    (
      echo $BASHPID > "$MYCG/quai-alpha/cgroup.procs" || exit 97
      exec setpriv --reuid quai-alpha --regid quai-alpha --clear-groups \
           node /opt/hog.js
    ) >/dev/null 2>&1
    RC=$?
    if [ "$RC" -eq 97 ]; then
      bad "could not move the project process into the capped cgroup"
    elif [ "$RC" -ne 0 ]; then
      ok "runaway stopped by the cap (exit $RC, 137 = OOM kill)"
    else
      bad "hog allocated past the cap without being stopped"
    fi
    note "peak: $(cat "$MYCG/quai-alpha/memory.peak" 2>/dev/null) bytes"
    note "$(grep -E '^oom_kill ' "$MYCG/quai-alpha/memory.events" 2>/dev/null)"
  else
    bad "cannot write memory.max"
  fi
fi

sect "result"
echo "  $PASS passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  echo "  VERDICT: the Quai single-container model holds."
else
  echo "  VERDICT: constraints found, see failures above."
fi
