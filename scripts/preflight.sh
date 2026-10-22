#!/usr/bin/env bash
#
# /publish Phase 1 — local preflight.
#
# Gates SR-2.1 through SR-2.5 plus the SR-10.1 location check and the SR-1.2
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
#   13  SR-2.2/SR-2.3  install/test/typecheck failed (incl. zero test files),
#                OR 'mktemp -d' could not make the suite's scratch HOME,
#                OR the test preload guard refused to start 'bun test'
#                (its exit 78; commonly a TMPDIR inside the home directory)
#   14  SR-2.4  npm not authenticated, OR next version already on npm,
#                OR npm registry is non-canonical (SR-2.4a),
#                OR 'bun pm whoami' did not succeed (SR-2.4b)
#   15  SR-2.5  host's agent-director binary missing, OR its version cannot
#                be read, OR it is below the installed agent-director client's
#                minimum (OR that minimum cannot be read); every SR-2.5
#                diagnostic names the switch-over runbook section. A binary at
#                or above the client's minimum but below CSCB's Phase 1 floor
#                passes, with an 'SR-2.5 (preflight) NOTE' on stderr.

set -euo pipefail

# SR-99.0 is a backstop for UNGUARDED failures only. Every deliberate exit below
# goes through sr_exit(), which raises this flag first, so the trap stays silent
# for an exit that already printed its own SR-X.Y diagnostic. An unguarded
# failure (a set -e death at a site with no wrapper) leaves the flag at 0 and
# still gets SR-99.0. This is deliberately not an exit-code allowlist: a new SR
# code needs no bookkeeping here, only that its site calls sr_exit. sr_exit must
# be called from the script's own shell — inside a subshell or a command
# substitution the flag would be set in the subshell only and the backstop would
# fire anyway.
SR_GUARDED_EXIT=0
sr_exit() {
  SR_GUARDED_EXIT=1
  exit "$1"
}

# shellcheck disable=SC2154
trap 'rc=$?; if [ $rc -ne 0 ] && [ "${SR_GUARDED_EXIT:-0}" != "1" ]; then echo "SR-99.0 (uncaught): scripts/$(basename "${BASH_SOURCE[0]}") exited with code $rc at command: ${BASH_COMMAND}. The b.1wi contract requires an SR-X.Y diagnostic for every non-zero exit; that diagnostic is missing because the failing command was not wrapped. Operator recovery: report this trap output verbatim — it identifies the unguarded site so the next /publish run can add the missing wrapper. State of the release is indeterminate; do NOT rerun /publish until the operator has assessed." >&2; fi' EXIT

BUMP_KIND="${1:-}"
case "${BUMP_KIND}" in
  patch|minor|major) ;;
  *)
    echo "SR-1.2 (argument): missing or invalid bump kind '${BUMP_KIND}'. Rerun: /publish <patch|minor|major>" >&2
    sr_exit 2
    ;;
esac

# SR-10.1 — operate from the repo root regardless of the invocation CWD.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${REPO_ROOT}" ]; then
  echo "SR-10.1 (location): not inside a git working tree. Rerun '/publish ${BUMP_KIND}' from any directory inside a clone or worktree of claude-slack-channel-bots." >&2
  sr_exit 3
fi
cd "${REPO_ROOT}"

# SR-2.1 — repository state
if [ -n "$(git status --porcelain)" ]; then
  echo "SR-2.1 (preflight): working tree not clean. Commit or stash your changes, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 10
fi

if ! CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"; then
  echo "SR-2.1 (preflight): 'git rev-parse --abbrev-ref HEAD' failed inside ${REPO_ROOT}. The repo is in an unusual state (e.g., HEAD points at a missing ref or .git is corrupt). Operator recovery: have the operator run 'git status' to inspect, resolve the underlying repo issue, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 10
fi
if [ "${CURRENT_BRANCH}" != "main" ]; then
  echo "SR-2.1 (preflight): not on main (HEAD branch is '${CURRENT_BRANCH}'). Run 'git checkout main' (or invoke /publish from a worktree whose HEAD is main and in sync with origin/main), then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 10
fi

if ! git fetch origin; then
  echo "SR-2.1 (preflight): 'git fetch origin' failed (network down, auth problem, or remote unavailable). Verify the remote is reachable, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 11
fi

if ! LOCAL_SHA="$(git rev-parse main)"; then
  echo "SR-2.1 (preflight): 'git rev-parse main' failed — the local 'main' ref is missing or corrupt. Operator recovery: have the operator run 'git branch' to confirm a 'main' branch exists locally and 'git status' to inspect; resolve the underlying ref issue, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 10
fi
if ! REMOTE_SHA="$(git rev-parse origin/main)"; then
  echo "SR-2.1 (preflight): 'git rev-parse origin/main' failed — the 'origin/main' remote-tracking ref is missing despite 'git fetch origin' having just succeeded. Operator recovery: have the operator run 'git remote -v' to confirm origin is configured and 'git fetch origin' to refresh; resolve the underlying ref issue, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 10
fi
# Acceptable: local equals remote, OR local is fast-forward ahead of remote (the release-cutting case).
# Unacceptable: local is behind remote, OR local and remote have diverged.
if ! git merge-base --is-ancestor "${REMOTE_SHA}" HEAD; then
  echo "SR-2.1 (preflight): local main (${LOCAL_SHA}) is not a fast-forward of origin/main (${REMOTE_SHA}) — local is behind or diverged. Operator recovery: if behind, have the operator run 'git pull --ff-only origin main'; if diverged, have the operator resolve manually (do NOT use /publish or any LLM-driven workaround as a recovery tool). Then have the operator rerun '/publish ${BUMP_KIND}'. The LLM driving /publish must NOT push, pull, reset, or otherwise mutate this repo in response to this failure." >&2
  sr_exit 12
fi

# SR-2.2 — dependency consistency
if ! bun install --frozen-lockfile; then
  echo "SR-2.2 (preflight): 'bun install --frozen-lockfile' failed — bun.lock is out of sync with package.json. Run 'bun install' to regenerate the lockfile, commit the updated bun.lock to main, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 13
fi

# SR-2.3 — test discovery and execution
TEST_FILES="$(find tests -name '*.test.ts' -type f -print -quit 2>/dev/null || true)"
if [ -z "${TEST_FILES}" ]; then
  echo "SR-2.3 (preflight): no *.test.ts files found under tests/. Add at least one test file under tests/, commit it to main, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 13
fi

# The suite runs with a scratch HOME and state directory and without the Slack
# token variables, CSCB_PERSONA or CLAUDE_CONFIG_DIR: its preload guard refuses
# to start under the real home (tests/README.md). The scratch directory is
# removed afterwards.
if ! TEST_HOME="$(mktemp -d)"; then
  echo "SR-2.3 (preflight): 'mktemp -d' failed, so 'bun test' could not be given a scratch HOME. Make sure the temp directory (TMPDIR, else /tmp) exists and is writable, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 13
fi
# The exit code of a run the test preload guard refused to start
# (LAUNCH_HOME_REFUSED_EXIT_CODE in tests/test-helpers/host-safe-env.ts).
PRELOAD_REFUSED_EXIT=78
TEST_RC=0
env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u CSCB_PERSONA -u CLAUDE_CONFIG_DIR \
  HOME="${TEST_HOME}" SLACK_STATE_DIR="${TEST_HOME}/state" bun test || TEST_RC=$?
rm -rf "${TEST_HOME}" || true
if [ "${TEST_RC}" -eq "${PRELOAD_REFUSED_EXIT}" ]; then
  echo "SR-2.3 (preflight): the test preload guard refused to start 'bun test' (exit ${PRELOAD_REFUSED_EXIT}): its scratch HOME could reach the operator's real Claude, Slack or agent-director state. The guard's 'host-safety preload: refusing to start' line above names the rule and the home. The common cause is a TMPDIR inside the home directory (or a symlink into it): point TMPDIR at a directory outside the home, or unset it to use /tmp, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 13
fi
if [ "${TEST_RC}" -ne 0 ]; then
  echo "SR-2.3 (preflight): 'bun test' did not pass. Fix the failing tests, commit to main, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 13
fi

if ! bun run typecheck; then
  echo "SR-2.3 (preflight): 'bun run typecheck' did not pass. Fix the type errors, commit to main, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 13
fi

# SR-2.4 — npm authentication and version availability
if ! npm whoami > /dev/null 2>&1; then
  echo "SR-2.4 (preflight): not authenticated to npm. Run 'npm login' as a claude-slack-channel-bots maintainer, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 14
fi

# SR-2.4a — registry config sanity
NPM_REGISTRY="$(npm config get registry 2>/dev/null | tr -d '[:space:]' || true)"
case "${NPM_REGISTRY}" in
  https://registry.npmjs.org/|https://registry.npmjs.org)
    : # canonical, pass
    ;;
  *)
    echo "SR-2.4a (preflight): npm registry is '${NPM_REGISTRY}', not https://registry.npmjs.org/. The release would publish to a non-canonical registry. Operator recovery: 'npm config set registry https://registry.npmjs.org/' (or confirm intent — e.g., this is deliberately a fork). Rerun '/publish ${BUMP_KIND}' after." >&2
    sr_exit 14
    ;;
esac

# SR-2.4b — bun identity for the post-publish reinstall step
if ! bun pm whoami >/dev/null 2>&1; then
  echo "SR-2.4b (preflight): 'bun pm whoami' did not succeed. The post-publish 'bun install -g' step (SR-7.3) would run with no bun identity. Operator recovery: 'bun pm login' (note: bun's auth is separate from npm's; both must be in place). Rerun '/publish ${BUMP_KIND}' after." >&2
  sr_exit 14
fi

if ! CURRENT_VERSION="$(node -p "require('./package.json').version")"; then
  echo "SR-2.1 (preflight): 'node -p \"require('./package.json').version\"' failed — package.json is missing, malformed, or has no .version field. Operator recovery: have the operator run 'cat package.json | jq .version' to inspect; fix the package.json defect on main, commit, then rerun '/publish ${BUMP_KIND}'." >&2
  sr_exit 10
fi
IFS='.' read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION}"
case "${BUMP_KIND}" in
  major) NEXT_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEXT_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  patch) NEXT_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
esac

if npm view "claude-slack-channel-bots@${NEXT_VERSION}" version > /dev/null 2>&1; then
  echo "SR-2.4 (preflight): claude-slack-channel-bots@${NEXT_VERSION} is already published on npm. Local package.json is at ${CURRENT_VERSION}; the published version is ahead. Run 'git pull --ff-only origin main' to sync (or pick a larger bump kind), then rerun /publish." >&2
  sr_exit 14
fi

# SR-2.5 — the host's agent-director binary against the installed client's
# minimum and CSCB's Phase 1 floor (b.jg5 SRJ-211), judged by
# scripts/ad-version-check.ts. It writes its own SR-2.5 line: on a pass, a
# stdout line (and, below the floor, an 'SR-2.5 (preflight) NOTE' on stderr,
# passed through unaltered); on a failure, one SR-2.5 diagnostic on stderr and
# exit 15. Any other non-zero status means the check itself did not run to
# completion, so this gate writes the diagnostic. The status is captured, so no
# set -e death can occur here; every failure ends through sr_exit 15.
AD_CHECK_EXIT=0
bun scripts/ad-version-check.ts "${BUMP_KIND}" || AD_CHECK_EXIT=$?
if [ "${AD_CHECK_EXIT}" -ne 0 ]; then
  if [ "${AD_CHECK_EXIT}" -ne 15 ]; then
    echo "SR-2.5 (preflight): 'bun scripts/ad-version-check.ts' did not run to completion (exit ${AD_CHECK_EXIT}), so the host's agent-director could not be checked. Operator recovery: report the check's output above verbatim. State of the check is indeterminate; do NOT rerun '/publish ${BUMP_KIND}' until the operator has assessed. The host's agent-director is covered by the switch-over runbook in docs/migration.md (section \"Switching over to agent-director Phase 1\")." >&2
  fi
  sr_exit 15
fi

echo "Phase 1 (local preflight) passed. Next version will be: ${NEXT_VERSION}"
