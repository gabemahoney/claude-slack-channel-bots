#!/usr/bin/env bash
#
# /publish prepare — the reversible half of a release.
#
# Runs preflight, bumps the version, packs the tarball, runs the smoke check,
# commits the release commit and annotated tag locally, and writes a manifest
# file at .publish-state.json that publish-promote.sh consumes.
#
# Nothing here pushes to origin or publishes to npm. Every failure path either
# rolls the working tree back to HEAD (when the failure is before SR-5.1
# commit) or leaves the local commit in place with explicit operator-recovery
# prose on stderr (when the failure is at SR-5.1 tag, after the commit landed).
#
# Operator-side rollback after a successful prepare (e.g. if smoke looks fine
# but the operator changes their mind before promote):
#
#   git reset --hard origin/main
#   git tag -d v<next_version>
#   rm -f <tarball>
#   rm -f .publish-state.json
#
# Usage:  bash scripts/publish-prepare.sh <patch|minor|major>
#
# Exit codes (must match the operator-recovery table in publish-prepare's SKILL.md):
#   0   prepare complete, manifest written
#   2   SR-1.2  missing/invalid bump argument
#   3   SR-10.1 not inside a git working tree
#   10  SR-2.1  preflight: working tree dirty OR not on main
#   11  SR-2.1  preflight: git fetch origin failed
#   12  SR-2.1  preflight: local main behind/diverged from origin/main
#   13  SR-2.2/2.3  preflight: install/test/typecheck failed
#   14  SR-2.4  preflight: npm not authenticated, or next version already on npm
#   20  SR-3.1  npm version bump failed
#   21  SR-4.1  bun pm pack failed or tarball internal version mismatch
#   22  SR-4.2  scratch install failed (from smoke-check.sh)
#   23  SR-4.3  bin smoke contract failed (from smoke-check.sh)
#   30  SR-5.1  git add / git commit failed
#   31  SR-5.1  git tag failed (commit is on local main, NOT pushed)
#   90  SR-8.1  manifest write failed

set -euo pipefail

# shellcheck disable=SC2154
trap 'rc=$?; if [ $rc -ne 0 ]; then echo "SR-99.0 (uncaught): scripts/$(basename "${BASH_SOURCE[0]}") exited with code $rc at command: ${BASH_COMMAND}. The b.1wi contract requires an SR-X.Y diagnostic for every non-zero exit; that diagnostic is missing because the failing command was not wrapped. Operator recovery: report this trap output verbatim — it identifies the unguarded site so the next /publish run can add the missing wrapper. State of the release is indeterminate; do NOT rerun /publish until the operator has assessed." >&2; fi' EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BUMP_KIND="${1:-}"
case "${BUMP_KIND}" in
  patch|minor|major) ;;
  *)
    echo "SR-1.2 (argument): missing or invalid bump kind '${BUMP_KIND}'. Rerun: /publish prepare <patch|minor|major>" >&2
    exit 2
    ;;
esac

# SR-10.1 — operate from the repo root regardless of invocation CWD.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${REPO_ROOT}" ]; then
  echo "SR-10.1 (location): not inside a git working tree. Rerun '/publish prepare ${BUMP_KIND}' from any directory inside a clone or worktree of claude-slack-channel-bots." >&2
  exit 3
fi
cd "${REPO_ROOT}"

# Cleanup wired before any state-mutating step.
# On successful prepare, TARBALL is cleared so the tarball is preserved for
# publish-promote.sh to consume. On any failure path, the trap removes the
# tarball as part of returning to a clean state.
TARBALL=""
cleanup() {
  if [ -n "${TARBALL}" ] && [ -f "${TARBALL}" ]; then
    rm -f "${TARBALL}"
  fi
}
# Composite EXIT trap: capture rc + BASH_COMMAND before cleanup mutates them,
# run cleanup (drop any preserved tarball on failure paths), then fire the
# SR-99.0 backstop if the script is exiting non-zero. Replaces the top-of-script
# SR-99-only trap so the backstop coverage persists past this point.
# shellcheck disable=SC2154
trap '_rc=$?; _cmd="${BASH_COMMAND}"; cleanup; if [ $_rc -ne 0 ]; then echo "SR-99.0 (uncaught): scripts/$(basename "${BASH_SOURCE[0]}") exited with code $_rc at command: $_cmd. The b.1wi contract requires an SR-X.Y diagnostic for every non-zero exit; that diagnostic is missing because the failing command was not wrapped. Operator recovery: report this trap output verbatim — it identifies the unguarded site so the next /publish run can add the missing wrapper. State of the release is indeterminate; do NOT rerun /publish until the operator has assessed." >&2; fi' EXIT

rollback_working_tree() {
  # SR-3.2: restore package.json and bun.lock to HEAD. If git checkout itself
  # errors, surface that — silently swallowing it would leave the working tree
  # in a half-bumped state with no diagnostic.
  if ! git checkout -- package.json bun.lock; then
    echo "SR-3.2 (rollback): 'git checkout -- package.json bun.lock' failed. Working tree may still contain the bumped version. Run 'git status' to inspect, then 'git checkout -- package.json bun.lock' manually." >&2
  fi
}

# Phase 1 — preflight. Delegate to scripts/preflight.sh and propagate its
# exit code verbatim. The preflight script writes its own SR-2.x diagnostics
# to stderr; no rollback is needed here because no working-tree mutation has
# happened yet.
PREFLIGHT_EXIT=0
bash "${SCRIPT_DIR}/preflight.sh" "${BUMP_KIND}" || PREFLIGHT_EXIT=$?
if [ "${PREFLIGHT_EXIT}" != "0" ]; then
  exit "${PREFLIGHT_EXIT}"
fi

FROM_VERSION="$(node -p "require('./package.json').version")"
IFS='.' read -r MAJOR MINOR PATCH <<< "${FROM_VERSION}"
case "${BUMP_KIND}" in
  major) NEXT_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEXT_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  patch) NEXT_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
esac

# SR-3.1 — bump (no commit; npm version --no-git-tag-version)
if ! npm version "${BUMP_KIND}" --no-git-tag-version > /dev/null; then
  echo "SR-3.1 (bump): 'npm version ${BUMP_KIND} --no-git-tag-version' did not apply. Working tree has been rolled back (package.json + bun.lock restored). Investigate the npm error above, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 20
fi

# SR-4.1 — pack tarball + verify internal version
rm -f claude-slack-channel-bots-*.tgz || true

if ! bun pm pack > /dev/null; then
  echo "SR-4.1 (pack): 'bun pm pack' did not produce a tarball. Working tree has been rolled back. Investigate the bun error above, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 21
fi

TARBALL="claude-slack-channel-bots-${NEXT_VERSION}.tgz"
if [ ! -f "${TARBALL}" ]; then
  echo "SR-4.1 (pack): expected tarball '${TARBALL}' not found in CWD after 'bun pm pack'. Working tree has been rolled back. Inspect the CWD for stray *.tgz files, resolve the cause, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 21
fi

if ! TARBALL_VERSION="$(tar -xzOf "${TARBALL}" package/package.json | jq -r .version)"; then
  echo "SR-4.1 (pack): could not read package/package.json from ${TARBALL} (tar or jq failed). Working tree has been rolled back. The tarball is malformed or jq could not parse the embedded package.json. Operator recovery: inspect 'tar -tzf ${TARBALL}' to confirm the layout and 'tar -xzOf ${TARBALL} package/package.json' to view the embedded manifest, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 21
fi
if [ "${TARBALL_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "SR-4.1 (pack): tarball internal version '${TARBALL_VERSION}' != bumped ${NEXT_VERSION}. Working tree has been rolled back. This indicates a packing bug — investigate 'bun pm pack' output and package.json contents, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 21
fi

# SR-4.2 / SR-4.3 — delegate to smoke-check.sh. On failure, roll back the
# working tree and propagate the script's exit code (22 or 23).
TARBALL_ABS="$(pwd)/${TARBALL}"

SMOKE_EXIT=0
TARBALL_ABS="${TARBALL_ABS}" NEXT_VERSION="${NEXT_VERSION}" BUMP_KIND="${BUMP_KIND}" \
  bash "${SCRIPT_DIR}/smoke-check.sh" || SMOKE_EXIT=$?

if [ "${SMOKE_EXIT}" != "0" ]; then
  rollback_working_tree
  exit "${SMOKE_EXIT}"
fi

# SR-5.1 — release commit + annotated tag (no push yet)
if ! git add package.json bun.lock; then
  echo "SR-5.1 (release commit): 'git add package.json bun.lock' did not succeed. Working tree has been rolled back. Inspect git status, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 30
fi

if ! git commit -m "Release v${NEXT_VERSION}" > /dev/null; then
  echo "SR-5.1 (release commit): 'git commit -m \"Release v${NEXT_VERSION}\"' did not succeed. Working tree has been rolled back (nothing is committed). Inspect git status (a pre-commit hook may have failed), then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 30
fi

TAG_NAME="v${NEXT_VERSION}"
if ! git tag -a "${TAG_NAME}" -m "Release v${NEXT_VERSION}"; then
  echo "SR-5.1 (release tag): 'git tag -a ${TAG_NAME}' did not succeed. State: the release commit IS on the local main branch but has NOT been pushed; no tarball is preserved on disk (cleanup removed it); no manifest was written. Operator recovery (the LLM driving /publish prepare MUST NOT execute these commands itself): have the operator run 'git reset --hard HEAD~1' to revert the local release commit, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  exit 31
fi

COMMIT_SHA="$(git rev-parse HEAD)"
if ! TARBALL_SHA1="$(sha1sum "${TARBALL_ABS}" | awk '{print $1}')" || [ -z "${TARBALL_SHA1}" ]; then
  echo "SR-8.1 (manifest write): could not compute sha1 of ${TARBALL_ABS} (sha1sum or awk failed, or produced no output). State: the release commit + annotated tag are on the local main branch; the tarball is on disk at ${TARBALL_ABS}; nothing has been pushed; .publish-state.json was NOT written. Operator recovery (the LLM driving /publish prepare MUST NOT execute these commands itself): have the operator inspect the tarball ('ls -l ${TARBALL_ABS}' and 'file ${TARBALL_ABS}') and confirm sha1sum is functional, then roll back with 'git reset --hard origin/main && git tag -d ${TAG_NAME} && rm -f ${TARBALL_ABS}' and rerun '/publish prepare ${BUMP_KIND}'." >&2
  exit 90
fi
PREPARED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# SR-8.1 — write the handoff manifest. publish-promote.sh reads this as its
# source of truth for "what prepare produced" and refuses to run if the local
# state has drifted from the manifest.
if ! jq -n \
  --arg bump_kind "${BUMP_KIND}" \
  --arg from_version "${FROM_VERSION}" \
  --arg next_version "${NEXT_VERSION}" \
  --arg commit_sha "${COMMIT_SHA}" \
  --arg tag_name "${TAG_NAME}" \
  --arg tarball_path "${TARBALL_ABS}" \
  --arg tarball_sha1 "${TARBALL_SHA1}" \
  --argjson smoke_passed true \
  --arg prepared_at "${PREPARED_AT}" \
  '{
    bump_kind: $bump_kind,
    from_version: $from_version,
    next_version: $next_version,
    commit_sha: $commit_sha,
    tag_name: $tag_name,
    tarball_path: $tarball_path,
    tarball_sha1: $tarball_sha1,
    smoke_passed: $smoke_passed,
    prepared_at: $prepared_at
  }' > .publish-state.json; then
  echo "SR-8.1 (manifest write): could not write .publish-state.json. State: the release commit + tag are on the local main branch; the tarball is on disk at ${TARBALL_ABS}; nothing has been pushed. Operator recovery (the LLM driving /publish prepare MUST NOT execute these commands itself): have the operator investigate the jq / filesystem error, then either (a) write .publish-state.json by hand using the fields the script intended to write, or (b) roll back with 'git reset --hard origin/main && git tag -d ${TAG_NAME} && rm -f ${TARBALL_ABS}' and rerun '/publish prepare ${BUMP_KIND}'." >&2
  exit 90
fi

# Successful prepare — preserve the tarball for publish-promote.sh.
TARBALL=""

cat <<EOF

Prepare complete: claude-slack-channel-bots@${NEXT_VERSION}

  From version:      ${FROM_VERSION}
  Next version:      ${NEXT_VERSION}
  Release commit:    ${COMMIT_SHA}
  Release tag:       ${TAG_NAME} (local only)
  Tarball:           ${TARBALL_ABS}
  Tarball sha1:      ${TARBALL_SHA1}
  Manifest:          ${REPO_ROOT}/.publish-state.json

Nothing has been pushed to origin or npm yet. Next step: /publish promote

To abandon this prepare and roll back to a clean state:

  git reset --hard origin/main
  git tag -d ${TAG_NAME}
  rm -f ${TARBALL_ABS}
  rm -f .publish-state.json
EOF
exit 0
