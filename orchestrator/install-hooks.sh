#!/bin/bash
# install-hooks.sh — install the path-lock pre-commit hook into both repos.
#
# Idempotent. Refuses to clobber an unrelated existing hook: neither repo had a
# pre-commit hook as of 2026-08-11 (the vault's .claude/helpers/pre-commit is
# claude-flow boilerplate that runs `npm test` on the vault and was never
# installed), but that will not stay true forever.
#
#   ./install-hooks.sh          install
#   ./install-hooks.sh --status show what is installed
#   ./install-hooks.sh --remove uninstall

set -euo pipefail

ORCH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ORCH/hooks/pre-commit-claim"
MARKER="pre-commit-claim"

# Portable-core rule: nothing here names a project. The adapter does.
PROJECT="${ORCH_PROJECT:-cleaning}"
ADAPTER="$ORCH/projects/$PROJECT.json"
[ -f "$ADAPTER" ] || { echo "install-hooks: no adapter at $ADAPTER"; exit 2; }
VAULT="$(node -e "console.log(require(process.argv[1]).vault)" "$ADAPTER")"
REPO="$(node -e "console.log(require(process.argv[1]).repo)" "$ADAPTER")"

# A worktree's .git is a FILE pointing at the real gitdir; hooks live in the
# common dir, so installing once covers every worktree. Resolve it rather than
# assuming <repo>/.git/hooks.
hooks_dir() {
  git -C "$1" rev-parse --git-common-dir 2>/dev/null | while read -r d; do
    case "$d" in /*) echo "$d/hooks" ;; *) echo "$1/$d/hooks" ;; esac
  done
}

action="${1:-install}"
STALE_FOUND=0

for r in "$VAULT" "$REPO"; do
  [ -d "$r" ] || { echo "skip (missing): $r"; continue; }
  hd="$(hooks_dir "$r")"
  [ -n "$hd" ] || { echo "skip (not a git repo): $r"; continue; }
  mkdir -p "$hd"
  dest="$hd/pre-commit"

  case "$action" in
    --status)
      # Compare CONTENT, not just presence. D11 (2026-08-11): this used to
      # report INSTALLED whenever the marker string was present, so a hook whose
      # source had been edited but never re-installed read as healthy. It did —
      # for the whole session, while every window ran the pre-D2 copy and the
      # lock refused windows their own claims. A status check that cannot see
      # drift is a false green on the deployment itself.
      # CRITICAL: 2026-08-20: REACHABILITY, not just content. This reported CURRENT for
      # the VAULT while core.hooksPath pointed at a directory that did not exist
      # (a path from before the vault was moved), so git never ran the hook at
      # all. Every vault commit had been running with NO lock, and a commit the
      # lock exists to refuse went through while three windows trusted it.
      # D11 taught this check to see content drift; this is the layer beneath —
      # the file can be present AND current AND never executed. Found by W4.
      hp="$(git -C "$r" config core.hooksPath 2>/dev/null || true)"
      if [ -n "$hp" ]; then
        case "$hp" in /*) hpr="$hp" ;; *) hpr="$r/$hp" ;; esac
        if [ ! -x "$hpr/pre-commit" ]; then
          echo "CRITICAL: UNREACHABLE  $r"
          echo "           core.hooksPath = $hp"
          echo "           git runs THAT, not $dest, and there is no executable pre-commit there."
          echo "           every commit in this repo is running with NO path lock."
          echo "           fix: git -C \"$r\" config --unset core.hooksPath"
          STALE_FOUND=1
        fi
      fi

      if [ ! -f "$dest" ]; then
        echo "ABSENT     $dest"
      elif ! grep -q "$MARKER" "$dest" 2>/dev/null; then
        echo "FOREIGN    $dest  (another hook — not ours)"
      elif [ "$(shasum -a 256 "$dest" | cut -d' ' -f1)" = "$(shasum -a 256 "$SRC" | cut -d' ' -f1)" ]; then
        echo "CURRENT    $dest"
      else
        echo "WARNING:  STALE  $dest"
        echo "           installed copy differs from $SRC — re-run: install-hooks.sh"
        STALE_FOUND=1
      fi
      ;;
    --remove)
      if [ -f "$dest" ] && grep -q "$MARKER" "$dest" 2>/dev/null; then
        rm -f "$dest"; echo "removed    $dest"
      else
        echo "not ours   $dest"
      fi
      ;;
    install)
      # Credential hygiene, per clone. W3 raised this while refusing a bind:
      # `.orchestrator/window` carries a token in plaintext inside the code
      # repo, and `.git/info/exclude` is per-clone and unversioned — so a fresh
      # clone on another machine (the Mac Studio) has no such rule and the first
      # marker written there would be stageable. A credential committed to a
      # branch is "the fact that travels with the branch" with a worse payload.
      #
      # Installed here rather than in .gitignore on purpose: these are
      # machine-local runtime paths, and a tracked .gitignore edit would dirty
      # the integration tree.
      exdir="$(dirname "$hd")/info"
      mkdir -p "$exdir"
      for pat in ".orchestrator/" ".claude/claims/"; do
        if ! grep -qx -- "$pat" "$exdir/exclude" 2>/dev/null; then
          printf '\n# W0 orchestrator — machine-local runtime state. Contains tokens. NEVER commit.\n%s\n' "$pat" >> "$exdir/exclude"
          echo "excluded   $pat  in $(dirname "$(dirname "$hd")")"
        fi
      done

      if [ -f "$dest" ] && ! grep -q "$MARKER" "$dest" 2>/dev/null; then
        echo "REFUSED    $dest already exists and is not ours."
        echo "           Merge it by hand — clobbering someone's hook is exactly the"
        echo "           class of silent overwrite this system exists to prevent."
        continue
      fi
      cp "$SRC" "$dest"
      chmod +x "$dest"
      echo "installed  $dest"
      ;;
    *)
      echo "usage: install-hooks.sh [install|--status|--remove]"; exit 2 ;;
  esac
done

# Exit non-zero when a stale install was found, so a caller can gate on it.
if [ "${STALE_FOUND:-0}" = "1" ]; then
  echo ""
  echo "One or more hooks are STALE or UNREACHABLE — see above. A stale hook was edited and never deployed; an unreachable one is deployed and never RUN."
  exit 1
fi
