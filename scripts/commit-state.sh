#!/usr/bin/env bash
# commit-state.sh <state-file> <branch> — commit a sync run's state file onto
# the branch tip, replaying it rather than merging it.
#
# This run's state file is authoritative: it records exactly the pages this
# run wrote and read back. Never three-way-merge it with another run's copy —
# `git pull --rebase` conflicted on it every time the branch moved while the
# sync was writing, failing the job after the pages were already correct
# (Manifest, 2026-09-16: three runs in ninety seconds during a merge train).
# So: save it, reset to the current tip, put it back, commit, push; if someone
# pushed underneath us, do it again — three attempts, then fail loudly.
set -uo pipefail

state="${1:?usage: commit-state.sh <state-file> <branch>}"
branch="${2:?usage: commit-state.sh <state-file> <branch>}"
saved="${RUNNER_TEMP:-$(mktemp -d)}/notion-state.json"

if git diff --quiet -- "$state" && [ -z "$(git ls-files --others -- "$state")" ]; then
  echo "state unchanged — nothing to commit"
  exit 0
fi
git config user.name >/dev/null || git config user.name "notion-sync"
git config user.email >/dev/null || git config user.email "noreply@github.com"
cp "$state" "$saved"

for attempt in 1 2 3; do
  git fetch -q origin "$branch" && git reset -q --hard "origin/$branch" || { echo "fetch failed — retrying"; continue; }
  mkdir -p "$(dirname "$state")"
  cp "$saved" "$state"
  if git diff --quiet -- "$state" && git ls-files --error-unmatch -- "$state" >/dev/null 2>&1; then
    echo "state already current on $branch — nothing to commit"
    exit 0
  fi
  git add -- "$state"
  git commit -q -m "Notion sync state [skip ci]"
  if git push -q origin "HEAD:$branch"; then
    echo "state committed on attempt $attempt"
    exit 0
  fi
  echo "push raced with another commit — retrying"
done
echo "could not commit sync state after 3 attempts" >&2
exit 1
