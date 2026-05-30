#!/usr/bin/env bash
#
# /publish Phase 1 — local preflight.
#
# Gates SR-2.1 through SR-2.4 plus the SR-10.1 location check and the SR-1.2
# argument check. Exits 0 on full pass; exits with a stable non-zero code on
# the first failed gate after writing a verbatim operator-facing diagnostic
# (preserving the SR-X.Y identifier) to stderr.
#
# Usage:  bash scripts/preflight.sh <patch|minor|major>
#
# Exit codes (must match the operator-recovery table in SKILL.md):
#   0   all preflight gates passed
#   2   SR-1.2  missing/invalid bump argument
#   3   SR-10.1 not inside a git working tree
#   10  SR-2.1  working tree dirty OR not on main
#   11  SR-2.1  git fetch origin failed
#   12  SR-2.1  local main is not a fast-forward of origin/main
#   13  SR-2.2/SR-2.3  install/test/typecheck failed (incl. zero test files)
#   14  SR-2.4  npm not authenticated, OR next version already on npm
#   15  SR-2.5  host's agent-director binary missing/broken, OR its version
#                does not satisfy package.json's declared range

set -euo pipefail

BUMP_KIND="${1:-}"
case "${BUMP_KIND}" in
  patch|minor|major) ;;
  *)
    echo "SR-1.2 (argument): missing or invalid bump kind '${BUMP_KIND}'. Rerun: /publish <patch|minor|major>" >&2
    exit 2
    ;;
esac

# SR-10.1 — operate from the repo root regardless of the invocation CWD.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${REPO_ROOT}" ]; then
  echo "SR-10.1 (location): not inside a git working tree. Rerun '/publish ${BUMP_KIND}' from any directory inside a clone or worktree of claude-slack-channel-bots." >&2
  exit 3
fi
cd "${REPO_ROOT}"

# SR-2.1 — repository state
if [ -n "$(git status --porcelain)" ]; then
  echo "SR-2.1 (preflight): working tree not clean. Commit or stash your changes, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 10
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "${CURRENT_BRANCH}" != "main" ]; then
  echo "SR-2.1 (preflight): not on main (HEAD branch is '${CURRENT_BRANCH}'). Run 'git checkout main' (or invoke /publish from a worktree whose HEAD is main and in sync with origin/main), then rerun '/publish ${BUMP_KIND}'." >&2
  exit 10
fi

if ! git fetch origin; then
  echo "SR-2.1 (preflight): 'git fetch origin' failed (network down, auth problem, or remote unavailable). Verify the remote is reachable, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 11
fi

LOCAL_SHA="$(git rev-parse main)"
REMOTE_SHA="$(git rev-parse origin/main)"
# Acceptable: local equals remote, OR local is fast-forward ahead of remote (the release-cutting case).
# Unacceptable: local is behind remote, OR local and remote have diverged.
if ! git merge-base --is-ancestor "${REMOTE_SHA}" HEAD; then
  echo "SR-2.1 (preflight): local main (${LOCAL_SHA}) is not a fast-forward of origin/main (${REMOTE_SHA}) — local is behind or diverged. Operator recovery: if behind, have the operator run 'git pull --ff-only origin main'; if diverged, have the operator resolve manually (do NOT use /publish or any LLM-driven workaround as a recovery tool). Then have the operator rerun '/publish ${BUMP_KIND}'. The LLM driving /publish must NOT push, pull, reset, or otherwise mutate this repo in response to this failure." >&2
  exit 12
fi

# SR-2.2 — dependency consistency
if ! bun install --frozen-lockfile; then
  echo "SR-2.2 (preflight): 'bun install --frozen-lockfile' failed — bun.lock is out of sync with package.json. Run 'bun install' to regenerate the lockfile, commit the updated bun.lock to main, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 13
fi

# SR-2.3 — test discovery and execution
TEST_FILES="$(find tests -name '*.test.ts' -type f -print -quit 2>/dev/null || true)"
if [ -z "${TEST_FILES}" ]; then
  echo "SR-2.3 (preflight): no *.test.ts files found under tests/. Add at least one test file under tests/, commit it to main, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 13
fi

if ! bun test; then
  echo "SR-2.3 (preflight): 'bun test' did not pass. Fix the failing tests, commit to main, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 13
fi

if ! bun run typecheck; then
  echo "SR-2.3 (preflight): 'bun run typecheck' did not pass. Fix the type errors, commit to main, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 13
fi

# SR-2.4 — npm authentication and version availability
if ! npm whoami > /dev/null 2>&1; then
  echo "SR-2.4 (preflight): not authenticated to npm. Run 'npm login' as a claude-slack-channel-bots maintainer, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 14
fi

CURRENT_VERSION="$(node -p "require('./package.json').version")"
IFS='.' read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION}"
case "${BUMP_KIND}" in
  major) NEXT_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEXT_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  patch) NEXT_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
esac

if npm view "claude-slack-channel-bots@${NEXT_VERSION}" version > /dev/null 2>&1; then
  echo "SR-2.4 (preflight): claude-slack-channel-bots@${NEXT_VERSION} is already published on npm. Local package.json is at ${CURRENT_VERSION}; the published version is ahead. Run 'git pull --ff-only origin main' to sync (or pick a larger bump kind), then rerun /publish." >&2
  exit 14
fi

# SR-2.5 — host's agent-director binary version satisfies package.json's declared range.
# Skipped when no agent-director dependency is declared (preserves portability for forks).
AD_RANGE="$(jq -r '.dependencies["agent-director"] // empty' package.json)"
if [ -n "${AD_RANGE}" ]; then
  AD_VERSION="$(agent-director version 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)"
  if [ -z "${AD_VERSION}" ]; then
    echo "SR-2.5 (preflight): 'agent-director version' did not return a parseable version. The host's agent-director binary is missing or broken. Operator recovery: install agent-director matching '${AD_RANGE}' on this host (see ~/.agent-director/ install instructions or run ~/.agent-director/install.sh), then rerun '/publish ${BUMP_KIND}'." >&2
    exit 15
  fi
  if ! AD_VERSION="${AD_VERSION}" AD_RANGE="${AD_RANGE}" node -e "process.exit(require('semver').satisfies(process.env.AD_VERSION, process.env.AD_RANGE) ? 0 : 1)" 2>/dev/null; then
    echo "SR-2.5 (preflight): host's agent-director ${AD_VERSION} does not satisfy package.json's declared range '${AD_RANGE}'. Releasing now would ship a package that fails on the publisher's own machine. Operator recovery: either (a) upgrade the host's agent-director to a version satisfying '${AD_RANGE}', or (b) edit package.json's declared range to include ${AD_VERSION} and commit before rerunning '/publish ${BUMP_KIND}'." >&2
    exit 15
  fi
fi

echo "Phase 1 (local preflight) passed. Next version will be: ${NEXT_VERSION}"
