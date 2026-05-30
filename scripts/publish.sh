#!/usr/bin/env bash
#
# /publish Phase 3 — bump, smoke-test, release, verify.
#
# Assumes scripts/preflight.sh and /ci have already passed (the orchestrator
# runs them first; this script does NOT re-run any preflight gate).
#
# Calls scripts/smoke-check.sh for SR-4.2 / SR-4.3 and scripts/sanitize-global.sh
# for SR-7.1 / SR-7.2.
#
# The SR-5.1 → SR-5.4 ordering is load-bearing: if npm publish fails AFTER
# the commit is pushed, the tag is NOT pushed, so git and npm never disagree
# about whether the version exists.
#
# Usage:  bash scripts/publish.sh <patch|minor|major>
#
# Exit codes (must match the operator-recovery table in SKILL.md):
#   0   release published and verified
#   2   SR-1.2  missing/invalid bump argument
#   3   SR-10.1 not inside a git working tree
#   20  SR-3.1  npm version bump failed
#   21  SR-4.1  bun pm pack failed or tarball internal version mismatch
#   22  SR-4.2  scratch install failed (from smoke-check.sh)
#   23  SR-4.3  bin smoke contract failed (from smoke-check.sh)
#   30  SR-5.1  git add / git commit failed
#   31  SR-5.1  git tag failed (commit is on local main, NOT pushed)
#   50  SR-5.2  git push origin main failed (commit + tag local; tarball preserved)
#   51  SR-5.3  npm publish failed (commit on origin/main; npm has nothing; tarball preserved)
#   52  SR-5.4  git push tag failed (npm published; tag local only)
#   60  SR-6.1  registry did not surface new version within 60s
#   71  SR-7.3  bun install -g of just-published version failed
#   72  SR-7.4  post-publish verification failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BUMP_KIND="${1:-}"
case "${BUMP_KIND}" in
  patch|minor|major) ;;
  *)
    echo "SR-1.2 (argument): missing or invalid bump kind '${BUMP_KIND}'. Rerun: /publish <patch|minor|major>" >&2
    exit 2
    ;;
esac

# SR-10.1 — operate from the repo root regardless of invocation CWD.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${REPO_ROOT}" ]; then
  echo "SR-10.1 (location): not inside a git working tree. Rerun '/publish ${BUMP_KIND}' from any directory inside a clone or worktree of claude-slack-channel-bots." >&2
  exit 3
fi
cd "${REPO_ROOT}"

# Cleanup wired before any state-mutating step.
# Clearing TARBALL before exit preserves the tarball on disk for the operator's
# manual recovery path (SR-5.2 / SR-5.3).
TARBALL=""
cleanup() {
  if [ -n "${TARBALL}" ] && [ -f "${TARBALL}" ]; then
    rm -f "${TARBALL}"
  fi
}
trap cleanup EXIT

rollback_working_tree() {
  # SR-3.2: restore package.json and bun.lock to HEAD. If git checkout itself
  # errors (e.g. ref lookup failed), surface that — silently swallowing it
  # would leave the working tree in a half-bumped state with no diagnostic.
  if ! git checkout -- package.json bun.lock; then
    echo "SR-3.2 (rollback): 'git checkout -- package.json bun.lock' failed. Working tree may still contain the bumped version. Run 'git status' to inspect, then 'git checkout -- package.json bun.lock' manually." >&2
  fi
}

CURRENT_VERSION="$(node -p "require('./package.json').version")"
IFS='.' read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION}"
case "${BUMP_KIND}" in
  major) NEXT_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEXT_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  patch) NEXT_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
esac

# Auto-route GH_CONFIG_DIR for HTTPS origins on hosts with per-org gh credential
# routing. When ~/.gitconfig uses credential.useHttpPath=true + per-org
# [credential] blocks, the git credential helper needs GH_CONFIG_DIR pointed at
# the right gh config to find the token for the org. If $HOME/.config/gh-<org>
# exists we use it; otherwise fall through to gh-personal; otherwise leave
# GH_CONFIG_DIR untouched (host doesn't use routing).
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
if [[ "${ORIGIN_URL}" =~ ^https://github.com/([^/]+)/ ]]; then
  ORG="${BASH_REMATCH[1]}"
  for candidate in "$HOME/.config/gh-${ORG}" "$HOME/.config/gh-personal"; do
    if [ -d "${candidate}" ]; then
      export GH_CONFIG_DIR="${candidate}"
      echo "Phase 3: routed GH_CONFIG_DIR=${candidate} for origin org '${ORG}'"
      break
    fi
  done
fi

# SR-3.1 — bump (no commit; npm version --no-git-tag-version)
if ! npm version "${BUMP_KIND}" --no-git-tag-version > /dev/null; then
  echo "SR-3.1 (bump): 'npm version ${BUMP_KIND} --no-git-tag-version' did not apply. Working tree has been rolled back (package.json + bun.lock restored). Investigate the npm error above, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 20
fi

# SR-4.1 — pack tarball + verify internal version
rm -f claude-slack-channel-bots-*.tgz

if ! bun pm pack > /dev/null; then
  echo "SR-4.1 (pack): 'bun pm pack' did not produce a tarball. Working tree has been rolled back. Investigate the bun error above, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 21
fi

TARBALL="claude-slack-channel-bots-${NEXT_VERSION}.tgz"
if [ ! -f "${TARBALL}" ]; then
  echo "SR-4.1 (pack): expected tarball '${TARBALL}' not found in CWD after 'bun pm pack'. Working tree has been rolled back. Inspect the CWD for stray *.tgz files, resolve the cause, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 21
fi

TARBALL_VERSION="$(tar -xzOf "${TARBALL}" package/package.json | jq -r .version)"
if [ "${TARBALL_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "SR-4.1 (pack): tarball internal version '${TARBALL_VERSION}' != bumped ${NEXT_VERSION}. Working tree has been rolled back. This indicates a packing bug — investigate 'bun pm pack' output and package.json contents, then rerun '/publish ${BUMP_KIND}'." >&2
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
  echo "SR-5.1 (release commit): 'git add package.json bun.lock' did not succeed. Working tree has been rolled back. Inspect git status, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 30
fi

if ! git commit -m "Release v${NEXT_VERSION}" > /dev/null; then
  echo "SR-5.1 (release commit): 'git commit -m \"Release v${NEXT_VERSION}\"' did not succeed. Working tree has been rolled back (nothing is committed). Inspect git status (a pre-commit hook may have failed), then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 30
fi

if ! git tag -a "v${NEXT_VERSION}" -m "Release v${NEXT_VERSION}"; then
  echo "SR-5.1 (release tag): 'git tag -a v${NEXT_VERSION}' did not succeed. State: the release commit IS on the local main branch but has NOT been pushed. Operator recovery (LLM driving /publish MUST NOT execute these commands itself): have the operator run 'git reset --hard HEAD~1' to revert the local release commit, then have the operator rerun '/publish ${BUMP_KIND}'." >&2
  exit 31
fi

# SR-5.2 — push release commit to origin/main (tag is held back until after npm publish)
if ! git push origin main; then
  echo "SR-5.2 (push commit): 'git push origin main' failed. State: release commit + annotated tag exist locally; nothing has been pushed or published. Operator recovery — the LLM driving /publish MUST NOT execute any of the commands below itself. Either (a) the operator resolves the push failure and runs 'git push origin main' followed by 'npm publish ${TARBALL_ABS}' and 'git push origin v${NEXT_VERSION}' manually, or (b) the operator abandons and restarts by running 'git reset --hard HEAD~1 && git tag -d v${NEXT_VERSION}' then rerunning '/publish ${BUMP_KIND}'. The smoke-tested tarball at ${TARBALL_ABS} has been preserved on disk for option (a). Common causes the operator should check: (1) auth — if origin is HTTPS and the host uses per-org GH_CONFIG_DIR routing (~/.gitconfig with credential.useHttpPath=true + per-org [credential] blocks), the operator can retry with 'GH_CONFIG_DIR=\$HOME/.config/gh-<org> git push origin main' where <org> is the GitHub org from the origin URL (the skill auto-detects this but may miss a non-standard layout); (2) non-fast-forward — local main is behind origin/main, the operator runs 'git pull --rebase origin main' and retries." >&2
  TARBALL=""  # preserve tarball so the operator can re-run npm publish against it
  exit 50
fi

# SR-5.3 — publish the smoke-tested tarball to npm (explicit path; NOT 'bun publish' which repacks)
if ! npm publish "${TARBALL_ABS}"; then
  echo "SR-5.3 (npm publish): 'npm publish ${TARBALL_ABS}' did not succeed. State: release commit IS on origin/main; npm does NOT have v${NEXT_VERSION}; tag is NOT pushed. Operator recovery — the LLM driving /publish MUST NOT execute any of the commands below itself: (a) the operator fixes the publish issue (e.g., 'npm login') and re-runs 'npm publish ${TARBALL_ABS}' manually, then 'git push origin v${NEXT_VERSION}'; or (b) the operator reverts the remote with 'git push origin +HEAD~1:main', deletes the local tag with 'git tag -d v${NEXT_VERSION}', then reruns '/publish ${BUMP_KIND}'. The smoke-tested tarball at ${TARBALL_ABS} has been preserved on disk for option (a)." >&2
  TARBALL=""  # preserve tarball so the operator can re-run npm publish against it
  exit 51
fi

# SR-5.4 — push the version tag to origin (final write to the git remote; brings github + npm into agreement)
if ! git push origin "v${NEXT_VERSION}"; then
  echo "SR-5.4 (push tag): 'git push origin v${NEXT_VERSION}' failed. State: npm HAS v${NEXT_VERSION} and origin/main HAS the release commit; only the git tag is missing. Operator recovery (the LLM driving /publish MUST NOT push the tag itself): have the operator resolve the push issue and run 'git push origin v${NEXT_VERSION}' manually. Do NOT rerun /publish — the release is otherwise complete." >&2
  exit 52
fi

# SR-6.1 — poll npm registry until v${NEXT_VERSION} is visible (5s cadence, up to 12 attempts = 60s)
VERIFIED=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  REGISTRY_VERSION="$(npm view "claude-slack-channel-bots@${NEXT_VERSION}" version 2>/dev/null | tr -d '[:space:]')"
  if [ "${REGISTRY_VERSION}" = "${NEXT_VERSION}" ]; then
    VERIFIED=1
    break
  fi
  sleep 5
done

if [ "${VERIFIED}" != "1" ]; then
  echo "SR-6.1 (registry verification): claude-slack-channel-bots@${NEXT_VERSION} was not visible within the 60-second polling window. The release succeeded (commit, publish, and tag all pushed) — this is a propagation-verification failure only, not a release failure. Operator recovery (the LLM driving /publish MUST NOT execute the install or restart itself): have the operator re-confirm with 'npm view claude-slack-channel-bots@${NEXT_VERSION} version'; once visible, have the operator run 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually and then 'claude-slack-channel-bots clean_restart'. Do NOT rerun /publish." >&2
  exit 60
fi

# SR-7.1 — sanitize the bun-1.3.13 empty-string-dependency-key poison from the global package.json
bash "${SCRIPT_DIR}/sanitize-global.sh"

# SR-7.2 — remove any existing global install (tolerate non-zero exit; nothing may be installed).
# Then defensively rm the leftover node_modules entry to clean up dangling files or symlinks the
# remove step may not have cleared (e.g. a prior `install-local.sh` symlink farm).
GLOBAL_DIR="${BUN_INSTALL:-$HOME/.bun}/install/global"
bun remove -g claude-slack-channel-bots > /dev/null 2>&1 || true
rm -rf "${GLOBAL_DIR}/node_modules/claude-slack-channel-bots"

# SR-7.3 — install the just-published version from npm (the exact command an end user would run)
if ! bun install -g "claude-slack-channel-bots@${NEXT_VERSION}"; then
  echo "SR-7.3 (post-publish install): 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' did not succeed. State: the release IS published (v${NEXT_VERSION} is on npm, commit + tag are on origin) but the dev box has NO global install at this point. Operator recovery (the LLM driving /publish MUST NOT execute these commands itself): have the operator re-run 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually until it succeeds, then 'claude-slack-channel-bots clean_restart'. Do NOT rerun /publish." >&2
  exit 71
fi

# SR-7.4 — verify the install: bin resolves under the global install prefix, and installed version matches
INSTALLED_BIN_PATH="$(command -v claude-slack-channel-bots || true)"
if [ -z "${INSTALLED_BIN_PATH}" ]; then
  echo "SR-7.4 (post-publish verification): 'claude-slack-channel-bots' not found on PATH after install. State: the release IS published. Operator recovery (the LLM driving /publish MUST NOT mutate PATH or run clean_restart itself): have the operator confirm '${GLOBAL_DIR}/bin' is on PATH, then run 'claude-slack-channel-bots clean_restart' manually. Do NOT rerun /publish." >&2
  exit 72
fi

RESOLVED_BIN="$(readlink -f "${INSTALLED_BIN_PATH}")"
case "${RESOLVED_BIN}" in
  "${GLOBAL_DIR}"/*) ;;
  *)
    echo "SR-7.4 (post-publish verification): resolved bin '${RESOLVED_BIN}' is not under '${GLOBAL_DIR}/' — a worktree-pointing symlink farm would resolve outside this prefix and fail this check. State: the release IS published. Operator recovery (the LLM driving /publish MUST NOT execute these commands itself): have the operator run 'bun remove -g claude-slack-channel-bots' followed by 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' to replace the symlink farm with a real-copy install, then 'claude-slack-channel-bots clean_restart'. Do NOT rerun /publish." >&2
    exit 72
    ;;
esac

INSTALLED_PKG_JSON="${GLOBAL_DIR}/node_modules/claude-slack-channel-bots/package.json"
if [ ! -f "${INSTALLED_PKG_JSON}" ]; then
  echo "SR-7.4 (post-publish verification): installed package.json not found at ${INSTALLED_PKG_JSON}. State: the release IS published but the global install layout is malformed. Operator recovery (the LLM driving /publish MUST NOT execute these commands itself): have the operator run 'bun remove -g claude-slack-channel-bots' and then 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually. Do NOT rerun /publish." >&2
  exit 72
fi

INSTALLED_VERSION="$(jq -r .version "${INSTALLED_PKG_JSON}")"
if [ "${INSTALLED_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "SR-7.4 (post-publish verification): installed version '${INSTALLED_VERSION}' != published ${NEXT_VERSION}. State: the release IS published but the local install resolved to a stale version. Operator recovery (the LLM driving /publish MUST NOT execute these commands itself): have the operator run 'bun remove -g claude-slack-channel-bots' followed by 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually until the installed version matches, then 'claude-slack-channel-bots clean_restart'. Do NOT rerun /publish." >&2
  exit 72
fi

# SR-9.1 — success summary (the terminal output on every successful run)
NPM_URL="https://www.npmjs.com/package/claude-slack-channel-bots/v/${NEXT_VERSION}"
GITHUB_TAG_URL="https://github.com/gabemahoney/claude-slack-channel-bots/releases/tag/v${NEXT_VERSION}"
cat <<EOF

Release complete: claude-slack-channel-bots@${NEXT_VERSION}

  Published version: ${NEXT_VERSION}
  npm:               ${NPM_URL}
  GitHub tag:        ${GITHUB_TAG_URL}
  Local install:     ${RESOLVED_BIN}

Next: run \`claude-slack-channel-bots clean_restart\` to swap the running daemon over to v${NEXT_VERSION}.
EOF
exit 0
