#!/usr/bin/env bash
# L-11: add origin remote (and optionally push main). Does not force-push.
#
# Usage:
#   export PGOS_GIT_ORIGIN='https://github.com/org/repo.git'
#   bash scripts/configure-git-remote.sh
#   PGOS_GIT_PUSH=1 bash scripts/configure-git-remote.sh   # also git push -u origin main
#
# Env:
#   PGOS_GIT_ORIGIN       Required HTTPS or SSH remote URL
#   PGOS_GIT_FORCE_REMOTE  Set to 1 to replace existing origin URL
#   PGOS_GIT_PUSH          Set to 1 to run git push -u origin main (needs network + creds)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ORIGIN="${PGOS_GIT_ORIGIN:-}"
if [[ -z "$ORIGIN" ]]; then
  echo "ERROR: set PGOS_GIT_ORIGIN to your empty repo URL" >&2
  echo "  example: export PGOS_GIT_ORIGIN='https://github.com/org/vmcp.git'" >&2
  exit 1
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: not a git repository" >&2
  exit 1
fi

if git remote get-url origin >/dev/null 2>&1; then
  current="$(git remote get-url origin)"
  if [[ "$current" == "$ORIGIN" ]]; then
    echo "origin already set to ${ORIGIN}"
  elif [[ "${PGOS_GIT_FORCE_REMOTE:-0}" == "1" ]]; then
    echo "Updating origin: ${current} → ${ORIGIN}"
    git remote set-url origin "$ORIGIN"
  else
    echo "ERROR: origin already exists (${current})." >&2
    echo "  Re-run with PGOS_GIT_FORCE_REMOTE=1 to replace, or unset and use a different remote name." >&2
    exit 1
  fi
else
  echo "Adding origin → ${ORIGIN}"
  git remote add origin "$ORIGIN"
fi

git remote -v

if [[ "${PGOS_GIT_PUSH:-0}" == "1" ]]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" != "main" && "$branch" != "master" ]]; then
    echo "WARN: current branch is ${branch} (expected main/master); pushing this branch" >&2
  fi
  echo "Pushing ${branch} → origin (no force)"
  git push -u origin "$branch"
  echo "Done. Configure branch protection: docs/deploy/git-hosting.md"
else
  echo "Remote configured. To push: PGOS_GIT_PUSH=1 bash scripts/configure-git-remote.sh"
  echo "Branch protection steps: docs/deploy/git-hosting.md"
fi
