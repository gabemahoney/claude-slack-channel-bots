#!/usr/bin/env bash
#
# /publish prepare — the reversible half of a release.
#
# Runs preflight, bumps the version, turns CHANGELOG.md's "## Unreleased" entry
# into the release's "## <version> (<UTC date>)" entry under a fresh empty
# "## Unreleased" one, packs the tarball, runs the smoke check, commits the
# release commit (package.json, bun.lock, CHANGELOG.md) and annotated tag
# locally, and writes a manifest file at .publish-state.json that
# publish-promote.sh consumes.
#
# Nothing here pushes to origin or publishes to npm. A failure before the bump
# (argument, location, preflight) leaves the working tree untouched. Every
# failure from the SR-3.1 bump up to and including a failed SR-5.1 'git add'
# or 'git commit' rolls package.json, bun.lock and CHANGELOG.md back to HEAD in
# both the working tree and the index (SR-3.2), so nothing is left staged or
# committed. A failure after the commit landed (SR-5.1 tag, SR-8.1 manifest)
# leaves the local commit (and, at SR-8.1, the tag and the tarball) in place
# with explicit operator-recovery prose on stderr. Every failure before the tag
# landed, the SR-5.1 tag failure included, removes the tarball.
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
#   14  SR-2.4  preflight: npm not authenticated, OR next version already on npm,
#                OR npm registry is non-canonical (SR-2.4a),
#                OR 'bun pm whoami' did not succeed (SR-2.4b)
#   15  SR-2.5  preflight: host agent-director missing, its version unreadable, or
#                below the installed agent-director client's minimum (or that
#                minimum unreadable); names the switch-over runbook section
#   16  SR-2.6  preflight: stranded finished work (finished ticket not on main and
#                not explicitly closed, or unmerged branch references a finished ticket)
#   17  SR-2.6  preflight: the finished-work audit could not run (could not locate the
#                hives / a git repo / a 'main' ref from this checkout) — a setup
#                failure, NOT stranded work. FAIL CLOSED: release still blocked.
#                Recovery: rerun from the canonical checkout beside the hives.
#   20  SR-3.1  npm version bump failed, OR CHANGELOG.md has no '## Unreleased'
#                heading, OR its rewrite to the release's heading failed
#   --  SR-3.2  rollback, no exit code of its own. Runs on the 20, 21, 22, 23
#                and 30 failures (and any other non-zero smoke-check.sh exit):
#                'git checkout HEAD -- package.json bun.lock CHANGELOG.md'
#                restores those files to HEAD's copies in the working tree and
#                the index alike, so after a failed 'git add' or 'git commit'
#                it also unstages whatever of the bump 'git add' had staged.
#                If that checkout itself fails it prints its own SR-3.2
#                diagnostic; the exit code is still the failing step's
#   21  SR-4.1  bun pm pack failed or tarball internal version mismatch
#   22  SR-4.2  scratch install failed (from smoke-check.sh)
#   23  SR-4.3  bin smoke contract failed (from smoke-check.sh)
#   30  SR-5.1  git add / git commit failed
#   31  SR-5.1  git tag failed (commit is on local main, NOT pushed)
#   90  SR-8.1  manifest write failed

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BUMP_KIND="${1:-}"
case "${BUMP_KIND}" in
  patch|minor|major) ;;
  *)
    echo "SR-1.2 (argument): missing or invalid bump kind '${BUMP_KIND}'. Rerun: /publish prepare <patch|minor|major>" >&2
    sr_exit 2
    ;;
esac

# SR-10.1 — operate from the repo root regardless of invocation CWD.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${REPO_ROOT}" ]; then
  echo "SR-10.1 (location): not inside a git working tree. Rerun '/publish prepare ${BUMP_KIND}' from any directory inside a clone or worktree of claude-slack-channel-bots." >&2
  sr_exit 3
fi
cd "${REPO_ROOT}"

# Cleanup wired before any state-mutating step.
# On any failure before the release tag lands (exit 31 included), the trap
# removes the tarball as part of returning to a clean state. Once the release
# commit and tag exist, TARBALL is cleared, so the tarball is preserved from
# there on: on exit 90 (SR-8.1), whose recovery prose points the operator at
# it, and on a successful prepare, for publish-promote.sh to consume.
TARBALL=""
cleanup() {
  if [ -n "${TARBALL}" ] && [ -f "${TARBALL}" ]; then
    rm -f "${TARBALL}"
  fi
}
# Composite EXIT trap: capture rc + BASH_COMMAND before cleanup mutates them,
# run cleanup (drop the tarball while TARBALL is still set), then fire the
# SR-99.0 backstop if the script is exiting non-zero. Replaces the top-of-script
# SR-99-only trap so the backstop coverage persists past this point.
# shellcheck disable=SC2154
trap '_rc=$?; _cmd="${BASH_COMMAND}"; cleanup; if [ $_rc -ne 0 ] && [ "${SR_GUARDED_EXIT:-0}" != "1" ]; then echo "SR-99.0 (uncaught): scripts/$(basename "${BASH_SOURCE[0]}") exited with code $_rc at command: $_cmd. The b.1wi contract requires an SR-X.Y diagnostic for every non-zero exit; that diagnostic is missing because the failing command was not wrapped. Operator recovery: report this trap output verbatim — it identifies the unguarded site so the next /publish run can add the missing wrapper. State of the release is indeterminate; do NOT rerun /publish until the operator has assessed." >&2; fi' EXIT

rollback_working_tree() {
  # SR-3.2: restore package.json, bun.lock and CHANGELOG.md to HEAD, in the
  # working tree and the index. Checking out from HEAD, not from the index,
  # matters on the exit-30 paths: there 'git add' has already staged all or
  # part of the bump, so a checkout from the index would restore nothing. If
  # git checkout itself errors, surface that — silently swallowing it would
  # leave the working tree or the index in a half-bumped state with no
  # diagnostic.
  if ! git checkout HEAD -- package.json bun.lock CHANGELOG.md; then
    echo "SR-3.2 (rollback): 'git checkout HEAD -- package.json bun.lock CHANGELOG.md' failed. Working tree may still contain the bumped version or the rewritten CHANGELOG.md heading, and after a failed 'git add' or 'git commit' the index may still have them staged. Run 'git status' to inspect, then 'git checkout HEAD -- package.json bun.lock CHANGELOG.md' manually." >&2
  fi
}

# Phase 1 — preflight. Delegate to scripts/preflight.sh and propagate its
# exit code verbatim. The preflight script writes its own SR-2.x diagnostics
# to stderr; no rollback is needed here because no working-tree mutation has
# happened yet.
PREFLIGHT_EXIT=0
bash "${SCRIPT_DIR}/preflight.sh" "${BUMP_KIND}" || PREFLIGHT_EXIT=$?
if [ "${PREFLIGHT_EXIT}" != "0" ]; then
  sr_exit "${PREFLIGHT_EXIT}"
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
  echo "SR-3.1 (bump): 'npm version ${BUMP_KIND} --no-git-tag-version' did not apply. Working tree has been rolled back (package.json, bun.lock and CHANGELOG.md restored). Investigate the npm error above, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  sr_exit 20
fi

# SR-3.1 — CHANGELOG.md. The first "## Unreleased" heading (bare, or with a
# trailing note such as "## Unreleased (next patch version)") becomes
# "## <next_version> (<date>)", so the notes under it are now this release's
# entry, and a fresh empty "## Unreleased" entry goes above it, set off by the
# file's "---" rule. The date is today's UTC date, as the manifest's
# prepared_at is UTC. This runs before SR-4.1, so every later failure rolls it
# back with package.json, and the release commit and tag carry the new heading.
# The node step sets exit code 64 when the file has no "## Unreleased" heading.
CHANGELOG_EXIT=0
if ! RELEASE_DATE="$(date -u +%Y-%m-%d)" || [ -z "${RELEASE_DATE}" ]; then
  CHANGELOG_EXIT=1
else
  node -e '
    const fs = require("fs");
    const [version, date] = process.argv.slice(1);
    const text = fs.readFileSync("CHANGELOG.md", "utf8");
    const unreleased = /^## Unreleased(?:[ \t].*)?$/m;
    if (!unreleased.test(text)) {
      process.exitCode = 64;
    } else {
      fs.writeFileSync("CHANGELOG.md", text.replace(unreleased, () => "## Unreleased\n\n---\n\n## " + version + " (" + date + ")"));
    }
  ' "${NEXT_VERSION}" "${RELEASE_DATE}" || CHANGELOG_EXIT=$?
fi

if [ "${CHANGELOG_EXIT}" = "64" ]; then
  echo "SR-3.1 (changelog): CHANGELOG.md has no '## Unreleased' heading, so there is no entry to turn into the ${NEXT_VERSION} release notes. Working tree has been rolled back (package.json, bun.lock and CHANGELOG.md restored). Put this release's notes under an '## Unreleased' heading as the file's first '##' entry, commit that to main, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  sr_exit 20
fi
if [ "${CHANGELOG_EXIT}" != "0" ]; then
  echo "SR-3.1 (changelog): could not rewrite CHANGELOG.md's '## Unreleased' heading to '## ${NEXT_VERSION} (${RELEASE_DATE:-<UTC date>})' ('date -u' or node failed). Working tree has been rolled back (package.json, bun.lock and CHANGELOG.md restored). Investigate the error above, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  sr_exit 20
fi

# SR-4.1 — pack tarball + verify internal version
rm -f claude-slack-channel-bots-*.tgz || true

if ! bun pm pack > /dev/null; then
  echo "SR-4.1 (pack): 'bun pm pack' did not produce a tarball. Working tree has been rolled back. Investigate the bun error above, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  sr_exit 21
fi

TARBALL="claude-slack-channel-bots-${NEXT_VERSION}.tgz"
if [ ! -f "${TARBALL}" ]; then
  echo "SR-4.1 (pack): expected tarball '${TARBALL}' not found in CWD after 'bun pm pack'. Working tree has been rolled back. Inspect the CWD for stray *.tgz files, resolve the cause, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  sr_exit 21
fi

if ! TARBALL_VERSION="$(tar -xzOf "${TARBALL}" package/package.json | jq -r .version)"; then
  echo "SR-4.1 (pack): could not read package/package.json from ${TARBALL} (tar or jq failed). Working tree has been rolled back. The tarball is malformed or jq could not parse the embedded package.json. Operator recovery: inspect 'tar -tzf ${TARBALL}' to confirm the layout and 'tar -xzOf ${TARBALL} package/package.json' to view the embedded manifest, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  sr_exit 21
fi
if [ "${TARBALL_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "SR-4.1 (pack): tarball internal version '${TARBALL_VERSION}' != bumped ${NEXT_VERSION}. Working tree has been rolled back. This indicates a packing bug — investigate 'bun pm pack' output and package.json contents, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  sr_exit 21
fi

# SR-4.2 / SR-4.3 — delegate to smoke-check.sh. On failure, roll back the
# working tree and propagate the script's exit code (22 or 23).
TARBALL_ABS="$(pwd)/${TARBALL}"

SMOKE_EXIT=0
TARBALL_ABS="${TARBALL_ABS}" NEXT_VERSION="${NEXT_VERSION}" BUMP_KIND="${BUMP_KIND}" \
  bash "${SCRIPT_DIR}/smoke-check.sh" || SMOKE_EXIT=$?

if [ "${SMOKE_EXIT}" != "0" ]; then
  rollback_working_tree
  sr_exit "${SMOKE_EXIT}"
fi

# SR-5.1 — release commit + annotated tag (no push yet)
if ! git add package.json bun.lock CHANGELOG.md; then
  echo "SR-5.1 (release commit): 'git add package.json bun.lock CHANGELOG.md' did not succeed. Working tree and index have been rolled back to HEAD (package.json, bun.lock and CHANGELOG.md restored, and anything 'git add' staged unstaged; nothing is committed). Inspect git status, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  sr_exit 30
fi

if ! git commit -m "Release v${NEXT_VERSION}" > /dev/null; then
  echo "SR-5.1 (release commit): 'git commit -m \"Release v${NEXT_VERSION}\"' did not succeed. Working tree and index have been rolled back to HEAD (package.json, bun.lock and CHANGELOG.md restored and unstaged; nothing is committed). Inspect git status (a pre-commit hook may have failed), then rerun '/publish prepare ${BUMP_KIND}'." >&2
  rollback_working_tree
  sr_exit 30
fi

TAG_NAME="v${NEXT_VERSION}"
if ! git tag -a "${TAG_NAME}" -m "Release v${NEXT_VERSION}"; then
  echo "SR-5.1 (release tag): 'git tag -a ${TAG_NAME}' did not succeed. State: the release commit IS on the local main branch but has NOT been pushed; no tarball is preserved on disk (cleanup removed it); no manifest was written. Operator recovery (the LLM driving /publish prepare MUST NOT execute these commands itself): have the operator run 'git reset --hard HEAD~1' to revert the local release commit, then rerun '/publish prepare ${BUMP_KIND}'." >&2
  sr_exit 31
fi

# The release commit and tag exist — preserve the tarball with them from here
# on, so an SR-8.1 failure (exit 90) leaves it on disk as its recovery prose says.
TARBALL=""

COMMIT_SHA="$(git rev-parse HEAD)"
if ! TARBALL_SHA1="$(sha1sum "${TARBALL_ABS}" | awk '{print $1}')" || [ -z "${TARBALL_SHA1}" ]; then
  echo "SR-8.1 (manifest write): could not compute sha1 of ${TARBALL_ABS} (sha1sum or awk failed, or produced no output). State: the release commit + annotated tag are on the local main branch; the tarball is on disk at ${TARBALL_ABS}; nothing has been pushed; .publish-state.json was NOT written. Operator recovery (the LLM driving /publish prepare MUST NOT execute these commands itself): have the operator inspect the tarball ('ls -l ${TARBALL_ABS}' and 'file ${TARBALL_ABS}') and confirm sha1sum is functional, then roll back with 'git reset --hard origin/main && git tag -d ${TAG_NAME} && rm -f ${TARBALL_ABS}' and rerun '/publish prepare ${BUMP_KIND}'." >&2
  sr_exit 90
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
  sr_exit 90
fi

# Successful prepare — the tarball (preserved since the tag landed) is left for
# publish-promote.sh.

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
