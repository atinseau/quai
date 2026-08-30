#!/bin/bash
# Multi-tenant hardening probe: what does hostile-tenant containment cost?
# Checks pids.max (fork bombs), cpu.max (noisy neighbours), seccomp
# availability, and whether the filesystem can carry disk quotas.

useradd --create-home --shell /usr/sbin/nologin quai-alpha 2>/dev/null

CG=/sys/fs/cgroup
MYCG="$CG$(cut -d: -f3 /proc/self/cgroup)"
mkdir -p "$MYCG/sup"
echo $$ > "$MYCG/sup/cgroup.procs" 2>/dev/null
echo "+pids +memory +cpu" > "$MYCG/cgroup.subtree_control" 2>/dev/null \
  || echo "subtree_control: partial or failed"
mkdir -p "$MYCG/qa"

echo "== pids.max (anti fork-bomb)"
if echo 20 > "$MYCG/qa/pids.max" 2>/dev/null; then
  echo "  set to $(cat "$MYCG/qa/pids.max")"
else
  echo "  UNAVAILABLE"
fi

echo "== cpu.max (anti noisy-neighbour)"
if echo "50000 100000" > "$MYCG/qa/cpu.max" 2>/dev/null; then
  echo "  set to $(cat "$MYCG/qa/cpu.max")  (= 50% of one core)"
else
  echo "  UNAVAILABLE"
fi

echo "== fork bomb vs pids.max"
(
  echo $BASHPID > "$MYCG/qa/cgroup.procs" || exit 97
  exec setpriv --reuid quai-alpha --regid quai-alpha --clear-groups \
    bash -c 'n=0; while [ $n -lt 300 ]; do sleep 5 & n=$((n+1)); done; echo "spawned $n"'
) >/dev/null 2>&1
echo "  fork loop exit: $?  (non-zero = contained)"
echo "  pids.current=$(cat "$MYCG/qa/pids.current" 2>/dev/null) / max=$(cat "$MYCG/qa/pids.max" 2>/dev/null)"
pkill -u quai-alpha 2>/dev/null

echo "== seccomp"
grep '^Seccomp' /proc/self/status | head -1
command -v nsjail >/dev/null 2>&1 && echo "  nsjail present" || echo "  nsjail absent (would need install)"

echo "== filesystem behind /home (disk quotas)"
echo "  fstype: $(stat -f -c '%T' /home)"
echo "  note: project quotas need XFS/ext4 with quota support on the host volume"
