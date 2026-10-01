#!/usr/bin/env bash
# Install the committed hooks from .githooks/ into .git/hooks/.
#
# Why not core.hooksPath=.githooks: that value is resolved relative to the working
# tree, so every hook silently disappears on any branch whose tree does not
# contain .githooks/. Copies inside .git/hooks are branch-independent.
#
# Cost of this choice: the copies do not update themselves. Re-run this script
# after editing anything in .githooks/. `--check` reports drift without writing.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
GIT_COMMON_DIR="$(git rev-parse --git-common-dir)"
GIT_DIR_ABS="$(cd "$GIT_COMMON_DIR" && pwd)"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

status=0
for src in .githooks/*; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  dst="$GIT_DIR_ABS/hooks/$name"
  if [ "$CHECK" -eq 1 ]; then
    if [ ! -f "$dst" ]; then
      echo "MISSING  $name"; status=1
    elif ! cmp -s "$src" "$dst"; then
      echo "DRIFTED  $name"; status=1
    else
      echo "OK       $name"
    fi
  else
    install -m 0755 "$src" "$dst"
    echo "installed $name -> $dst"
  fi
done

if [ "$CHECK" -eq 1 ] && [ "$status" -ne 0 ]; then
  echo "Run scripts/install-hooks.sh to synchronize." >&2
fi
exit "$status"
