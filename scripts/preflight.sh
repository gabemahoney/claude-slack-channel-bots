#!/usr/bin/env bash
#
# /publish Phase 1 — local preflight.
#
# Gates SR-2.1 through SR-2.6 plus the SR-10.1 location check and the SR-1.2
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
#   14  SR-2.4  npm not authenticated, OR next version already on npm,
#                OR npm registry is non-canonical (SR-2.4a),
#                OR 'bun pm whoami' did not succeed (SR-2.4b)
#   15  SR-2.5  host's agent-director binary missing/broken, OR its version
#                does not satisfy package.json's declared range
#   16  SR-2.6  stranded finished work: a finished bee's fix is neither on main
#                nor explicitly closed, OR an unmerged branch references a
#                finished ticket (scripts/audit-finished-tickets.sh exit 1)
#   17  SR-2.6  the finished-work audit could not run — it could not locate the
#                hives / a git repo / a 'main' ref from this checkout (audit
#                exit 2 or any other unexpected code). NOT stranded work; a
#                setup failure. FAIL CLOSED: the gate is required, so the
#                release is still blocked. Recovery: rerun from the canonical
#                checkout beside the hives.

set -euo pipefail

# shellcheck disable=SC2154
trap 'rc=$?; if [ $rc -ne 0 ]; then echo "SR-99.0 (uncaught): scripts/$(basename "${BASH_SOURCE[0]}") exited with code $rc at command: ${BASH_COMMAND}. The b.1wi contract requires an SR-X.Y diagnostic for every non-zero exit; that diagnostic is missing because the failing command was not wrapped. Operator recovery: report this trap output verbatim — it identifies the unguarded site so the next /publish run can add the missing wrapper. State of the release is indeterminate; do NOT rerun /publish until the operator has assessed." >&2; fi' EXIT

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

if ! CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"; then
  echo "SR-2.1 (preflight): 'git rev-parse --abbrev-ref HEAD' failed inside ${REPO_ROOT}. The repo is in an unusual state (e.g., HEAD points at a missing ref or .git is corrupt). Operator recovery: have the operator run 'git status' to inspect, resolve the underlying repo issue, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 10
fi
if [ "${CURRENT_BRANCH}" != "main" ]; then
  echo "SR-2.1 (preflight): not on main (HEAD branch is '${CURRENT_BRANCH}'). Run 'git checkout main' (or invoke /publish from a worktree whose HEAD is main and in sync with origin/main), then rerun '/publish ${BUMP_KIND}'." >&2
  exit 10
fi

if ! git fetch origin; then
  echo "SR-2.1 (preflight): 'git fetch origin' failed (network down, auth problem, or remote unavailable). Verify the remote is reachable, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 11
fi

if ! LOCAL_SHA="$(git rev-parse main)"; then
  echo "SR-2.1 (preflight): 'git rev-parse main' failed — the local 'main' ref is missing or corrupt. Operator recovery: have the operator run 'git branch' to confirm a 'main' branch exists locally and 'git status' to inspect; resolve the underlying ref issue, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 10
fi
if ! REMOTE_SHA="$(git rev-parse origin/main)"; then
  echo "SR-2.1 (preflight): 'git rev-parse origin/main' failed — the 'origin/main' remote-tracking ref is missing despite 'git fetch origin' having just succeeded. Operator recovery: have the operator run 'git remote -v' to confirm origin is configured and 'git fetch origin' to refresh; resolve the underlying ref issue, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 10
fi
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

# SR-2.4a — registry config sanity
NPM_REGISTRY="$(npm config get registry 2>/dev/null | tr -d '[:space:]' || true)"
case "${NPM_REGISTRY}" in
  https://registry.npmjs.org/|https://registry.npmjs.org)
    : # canonical, pass
    ;;
  *)
    echo "SR-2.4a (preflight): npm registry is '${NPM_REGISTRY}', not https://registry.npmjs.org/. The release would publish to a non-canonical registry. Operator recovery: 'npm config set registry https://registry.npmjs.org/' (or confirm intent — e.g., this is deliberately a fork). Rerun '/publish ${BUMP_KIND}' after." >&2
    exit 14
    ;;
esac

# SR-2.4b — bun identity for the post-publish reinstall step
if ! bun pm whoami >/dev/null 2>&1; then
  echo "SR-2.4b (preflight): 'bun pm whoami' did not succeed. The post-publish 'bun install -g' step (SR-7.3) would run with no bun identity. Operator recovery: 'bun pm login' (note: bun's auth is separate from npm's; both must be in place). Rerun '/publish ${BUMP_KIND}' after." >&2
  exit 14
fi

if ! CURRENT_VERSION="$(node -p "require('./package.json').version")"; then
  echo "SR-2.1 (preflight): 'node -p \"require('./package.json').version\"' failed — package.json is missing, malformed, or has no .version field. Operator recovery: have the operator run 'cat package.json | jq .version' to inspect; fix the package.json defect on main, commit, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 10
fi
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
if ! AD_RANGE="$(jq -r '.dependencies["agent-director"] // empty' package.json)"; then
  echo "SR-2.5 (preflight): 'jq -r .dependencies[\"agent-director\"]' on package.json failed — package.json is malformed JSON or jq is broken. Operator recovery: have the operator run 'jq . package.json' to verify the file parses; fix the JSON defect on main, commit, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 15
fi
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

# SR-2.6 — no stranded finished work. A bee must not sit in `finished` while its
# fix is neither on main nor explicitly closed (out-of-repo / no-repro /
# superseded), and no unmerged branch may reference a finished ticket. Shipping
# with stranded work silently strands fixes on dead branches (see bug b.qps /
# guardrail b.jaa). The audit is READ-ONLY.
AUDIT_EXIT=0
bash "${REPO_ROOT}/scripts/audit-finished-tickets.sh" "${REPO_ROOT}" || AUDIT_EXIT=$?
case "${AUDIT_EXIT}" in
  0)
    : # clean — no stranded work
    ;;
  1)
    # Genuine stranded finished work found. FAIL CLOSED.
    echo "SR-2.6 (preflight): scripts/audit-finished-tickets.sh reported stranded finished work — one or more bees are 'finished' while their fix is neither on main nor explicitly closed, or an unmerged branch references a finished ticket (see the audit report above). Releasing now would ship with work silently stranded on dead branches. Operator recovery: for each flagged ticket, either land its fix on main, or explicitly close it (no-repro / superseded / abandoned / satisfied-by-other-work, with a pointer to where the work actually lives); for each flagged branch, merge or delete it. Re-close the tickets as appropriate, then rerun '/publish ${BUMP_KIND}'. This gate is READ-ONLY and never mutates tickets or git." >&2
    exit 16
    ;;
  *)
    # Exit 2 (or any other unexpected code): the audit could NOT run — it could
    # not locate the hives / a git repo / a 'main' ref from this checkout. This
    # is a setup/configuration failure, NOT stranded work, so it does NOT get
    # the SR-2.6 stranded-work recovery (which would be wrong). FAIL CLOSED — the
    # audit is a required gate and must never be silently skipped, so we still
    # block the release. Distinct exit code 17 keeps the recovery unambiguous.
    echo "SR-2.6 (preflight): scripts/audit-finished-tickets.sh could not run (exit ${AUDIT_EXIT}) — it could not locate the Bugs/Plans/Ideas hives, a git repo, or a 'main' ref from this checkout (see the audit's own diagnostic above). This is NOT a report of stranded work; the required stranded-finished-work gate simply could not be evaluated, so the release is BLOCKED. This typically means /publish was run from a throwaway/detached checkout (e.g. a /tmp clone) that does not sit beside the hives. Operator recovery: rerun '/publish ${BUMP_KIND}' from the canonical claude-slack-channel-bots checkout that lives beside the Bugs/Plans/Ideas hives (the main working clone), where the audit can reconcile finished tickets against main. This gate is READ-ONLY and never mutates tickets or git." >&2
    exit 17
    ;;
esac

echo "Phase 1 (local preflight) passed. Next version will be: ${NEXT_VERSION}"
