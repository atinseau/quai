#!/bin/sh
# Quai SSH forced command.
#
# Every deploy key is pinned to this script, so whatever the client asks for,
# only a deploy or a listed administrative action can happen. No shell is ever
# granted.
case "$SSH_ORIGINAL_COMMAND" in
  quai-admin*) exec bun run /opt/quai/src/ingest/admin-command.ts ;;
  *)           exec bun run /opt/quai/src/ingest/forced-command.ts ;;
esac

