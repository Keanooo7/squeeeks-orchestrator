#!/bin/sh
# node-wrapper.sh — make `node` resolvable however Claude Code was launched.
#
# WHY THIS EXISTS (2026-08-27)
#
# Every hook in .claude/settings.json runs as `sh -c 'exec node …'`. `sh -c` is a
# non-login, non-interactive shell: it never sources ~/.zshrc, so it never runs
# nvm's init. On this machine node lives ONLY under nvm
# (~/.nvm/versions/node/v24.0.2/bin/node) and is absent from a minimal PATH:
#
#   $ env -i PATH=/usr/bin:/bin sh -c 'exec node --version'
#   sh: line 0: exec: node: not found
#
# Started from an nvm-initialised Terminal the hooks work. Started ANY other way
# — Desktop app, GUI launcher, launchd, a scheduled run — all eleven hooks plus
# the statusline die with exit 127, and the vault silently loses session restore,
# the auto-memory import, the pre-commit path lock and the Stop return gate.
# Nothing reports this: a failing hook is not a failing session.
#
# 🔑 It only intervenes when bare `node` does not resolve, so an already-correct
# environment is untouched, and it picks the highest installed nvm version rather
# than hardcoding one — a version bump must not silently re-break the hooks.
if ! command -v node >/dev/null 2>&1; then
  for d in $(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -Vr) \
           "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin /usr/bin; do
    if [ -x "$d/node" ]; then
      PATH="$d:$PATH"; export PATH; break
    fi
  done
fi
exec node "$@"
