#!/bin/bash
# One-command rollback for a Vercel project (instant: re-points the domain at an earlier deployment, no rebuild).
#   scripts/vercel-rollback.sh <project> list            → recent production deployments
#   scripts/vercel-rollback.sh <project>                 → roll back to the previous production deployment
#   scripts/vercel-rollback.sh <project> <deployment-url> → roll back to that exact deployment
#   scripts/vercel-rollback.sh <project> undo            → undo the rollback (promote the newest deployment again)
# Projects: aidentify-demo (live; ask the owner first), aidentify-staging, aidentify. Needs `vercel login` on this machine.
# Database changes are NOT rolled back: restore a backup for that (docs/BACKUPS.md).
set -euo pipefail
P="${1:?project name, e.g. aidentify-staging}"; WHAT="${2:-}"; SCOPE="${VERCEL_SCOPE:-aidentify}"
V="npx --yes vercel --scope $SCOPE"
list() { $V ls "$P" --prod 2>/dev/null | grep -Eo 'https://[a-z0-9.-]+\.vercel\.app' | head -${1:-10}; }
case "$WHAT" in
  list) list 10 ;;
  undo) NEW=$(list 1); echo "Promoting newest: $NEW"; $V promote "$NEW" --yes ;;
  "")   PREV=$(list 2 | sed -n 2p); [ -n "$PREV" ] || { echo "No earlier deployment found."; exit 1; }
        [ "$P" = "aidentify-demo" ] && { read -r -p "Roll back the LIVE demo to $PREV? Type yes: " A; [ "$A" = yes ] || exit 1; }
        echo "Rolling $P back to $PREV"; $V rollback "$PREV" --yes ;;
  *)    [ "$P" = "aidentify-demo" ] && { read -r -p "Roll back the LIVE demo to $WHAT? Type yes: " A; [ "$A" = yes ] || exit 1; }
        $V rollback "$WHAT" --yes ;;
esac
