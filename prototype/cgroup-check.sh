#!/bin/bash
# Focused check: can a process inside the container be moved into a
# memory-capped child cgroup, and does the cap actually stop a runaway?
# Run with: --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw

useradd --create-home --shell /usr/sbin/nologin quai-alpha 2>/dev/null

CG=/sys/fs/cgroup
OWN=$(cut -d: -f3 /proc/self/cgroup)
MYCG="$CG$OWN"
echo "own cgroup path : $OWN"
echo "resolved        : $MYCG"
[ -d "$MYCG" ] || { echo "resolved path does not exist; wrong cgroupns?"; exit 1; }

# A cgroup may not hold processes and enable controllers for children at the
# same time (no-internal-process rule), so move ourselves into a leaf first.
mkdir -p "$MYCG/quai-supervisor"
echo $$ > "$MYCG/quai-supervisor/cgroup.procs" 2>/dev/null \
  && echo "supervisor moved to leaf" \
  || echo "could not move supervisor"

echo "+memory" > "$MYCG/cgroup.subtree_control" 2>/dev/null \
  && echo "subtree_control: +memory OK" \
  || echo "subtree_control: +memory FAILED"

mkdir -p "$MYCG/quai-alpha"
echo 67108864 > "$MYCG/quai-alpha/memory.max" 2>/dev/null \
  && echo "memory.max      : $(cat "$MYCG/quai-alpha/memory.max")" \
  || { echo "cannot set memory.max"; exit 1; }
echo 0 > "$MYCG/quai-alpha/memory.swap.max" 2>/dev/null

(
  echo $BASHPID > "$MYCG/quai-alpha/cgroup.procs" || exit 97
  exec setpriv --reuid quai-alpha --regid quai-alpha --clear-groups \
       node /opt/hog.js
)
RC=$?

echo "hog exit code   : $RC"
echo "peak            : $(cat "$MYCG/quai-alpha/memory.peak" 2>/dev/null) bytes"
grep -E '^(max|oom|oom_kill) ' "$MYCG/quai-alpha/memory.events"

if [ "$RC" -eq 97 ]; then
  echo "VERDICT: could not move the process into the capped cgroup."
elif [ "$RC" -ne 0 ]; then
  echo "VERDICT: cap works, runaway was stopped."
else
  echo "VERDICT: cap did NOT stop the runaway."
fi
