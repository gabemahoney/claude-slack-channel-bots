#!/usr/bin/env bash
#
# /publish promote — the irreversible-but-short half of a release.
#
# Reads .publish-state.json (written by publish-prepare.sh), verifies the
# repo's local state still matches what prepare produced, then executes the
# remote-side-effect half of the release: push commit → npm publish → push
# tag → poll registry → sanitize globals → reinstall → verify.
#
# Idempotent where possible: if the commit is already on origin/main, the
# push is skipped; if the version is already on npm AND its dist.shasum
# matches the manifest's tarball_sha1, the publish is skipped; if the tag is
# already pushed, the tag push is skipped. The post-install + verify always
# runs (operator may have run promote from a different machine where the
# global install isn't current).
#
# Usage:  bash scripts/publish-promote.sh
#
# Exit codes (must match the operator-recovery table in publish-promote's SKILL.md):
#   0   release complete
#   1   precondition failure (manifest missing, drift, etc.) — see stderr
#   50  SR-5.2  git push origin main failed
#   51  SR-5.3  npm publish failed (or version exists with mismatched content)
#   52  SR-5.4  git push tag failed
#   60  SR-6.1  registry did not surface new version within 60s
#   70  SR-7.1  sanitize-global.sh failed
#   71  SR-7.3  post-publish bun install -g failed
#   72  SR-7.4  post-publish verification failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${REPO_ROOT}" ]; then
  echo "promote (precondition): not inside a git working tree. Run /publish promote from a clone or worktree of claude-slack-channel-bots that has a valid .publish-state.json manifest at its root." >&2
  exit 1
fi
cd "${REPO_ROOT}"

MANIFEST="${REPO_ROOT}/.publish-state.json"
if [ ! -f "${MANIFEST}" ]; then
  echo "promote (precondition): no .publish-state.json at ${MANIFEST}. /publish promote runs only after /publish prepare has succeeded. Operator recovery: run '/publish prepare <patch|minor|major>' first, or — if you intended to run a release end-to-end without the split — run '/publish <bump>' which invokes prepare then promote in one shot." >&2
  exit 1
fi

# Parse manifest. jq returns null for missing fields, which we treat as
# corruption; refuse to run rather than guess.
BUMP_KIND="$(jq -r '.bump_kind // empty' "${MANIFEST}")"
NEXT_VERSION="$(jq -r '.next_version // empty' "${MANIFEST}")"
COMMIT_SHA="$(jq -r '.commit_sha // empty' "${MANIFEST}")"
TAG_NAME="$(jq -r '.tag_name // empty' "${MANIFEST}")"
TARBALL_ABS="$(jq -r '.tarball_path // empty' "${MANIFEST}")"
TARBALL_SHA1_MANIFEST="$(jq -r '.tarball_sha1 // empty' "${MANIFEST}")"
SMOKE_PASSED="$(jq -r '.smoke_passed // false' "${MANIFEST}")"

for var in BUMP_KIND NEXT_VERSION COMMIT_SHA TAG_NAME TARBALL_ABS TARBALL_SHA1_MANIFEST; do
  if [ -z "${!var}" ]; then
    echo "promote (precondition): .publish-state.json is missing required field '${var,,}' (file: ${MANIFEST}). The manifest is corrupted or from an older prepare version. Operator recovery: delete .publish-state.json and rerun '/publish prepare <bump>'." >&2
    exit 1
  fi
done

if [ "${SMOKE_PASSED}" != "true" ]; then
  echo "promote (precondition): .publish-state.json reports smoke_passed=${SMOKE_PASSED}. Promote refuses to ship a release that did not pass the prepare-phase smoke check. Operator recovery: delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}' until smoke passes." >&2
  exit 1
fi

# Verify HEAD matches the manifest's commit_sha — refuse to push the wrong commit.
HEAD_SHA="$(git rev-parse HEAD)"
if [ "${HEAD_SHA}" != "${COMMIT_SHA}" ]; then
  echo "promote (precondition): manifest commit_sha is ${COMMIT_SHA} but HEAD is ${HEAD_SHA}. The repo has drifted since /publish prepare ran. Operator recovery (the LLM driving /publish promote MUST NOT mutate the repo): have the operator inspect 'git log --oneline ${COMMIT_SHA}..HEAD' to understand the drift, then either (a) 'git reset --hard ${COMMIT_SHA}' to return to the prepared state and rerun '/publish promote', or (b) delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}' from scratch." >&2
  exit 1
fi

# Verify tag exists locally and points at the same commit.
# Use ^{commit} to dereference annotated tags to the underlying commit SHA;
# bare 'git rev-parse refs/tags/<tag>' returns the tag-object SHA for annotated
# tags, which never matches a commit SHA. /publish prepare creates annotated tags.
if ! TAG_SHA="$(git rev-parse --verify "refs/tags/${TAG_NAME}^{commit}" 2>/dev/null)"; then
  echo "promote (precondition): manifest expects local tag ${TAG_NAME} but it does not exist. Operator recovery (the LLM driving /publish promote MUST NOT create the tag): delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}'." >&2
  exit 1
fi
if [ "${TAG_SHA}" != "${COMMIT_SHA}" ]; then
  echo "promote (precondition): manifest tag ${TAG_NAME} points to commit ${TAG_SHA}, not the manifest commit ${COMMIT_SHA}. The tag has been moved or the manifest is stale. Operator recovery (the LLM driving /publish promote MUST NOT move the tag): have the operator inspect 'git show ${TAG_NAME}' to understand the drift, then run 'git tag -d ${TAG_NAME} && rm -f .publish-state.json' to clear the prepared state, then rerun '/publish prepare ${BUMP_KIND}' to produce a fresh consistent set." >&2
  exit 1
fi

# Verify package.json version matches manifest's next_version.
PKG_VERSION="$(node -p "require('./package.json').version")"
if [ "${PKG_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "promote (precondition): manifest next_version is ${NEXT_VERSION} but package.json on disk is at ${PKG_VERSION}. The working tree drifted from the prepared state. Operator recovery (the LLM driving /publish promote MUST NOT edit package.json): delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}'." >&2
  exit 1
fi

# Verify tarball exists at recorded path.
if [ ! -f "${TARBALL_ABS}" ]; then
  echo "promote (precondition): manifest tarball_path is ${TARBALL_ABS} but no file exists there. The smoke-tested tarball is gone. Operator recovery (the LLM driving /publish promote MUST NOT regenerate the tarball): delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}' to produce a fresh smoke-tested tarball." >&2
  exit 1
fi

# Verify tarball content hasn't drifted since prepare.
TARBALL_SHA1_DISK="$(sha1sum "${TARBALL_ABS}" | awk '{print $1}')"
if [ "${TARBALL_SHA1_DISK}" != "${TARBALL_SHA1_MANIFEST}" ]; then
  echo "promote (precondition): tarball at ${TARBALL_ABS} has sha1 ${TARBALL_SHA1_DISK} but manifest recorded ${TARBALL_SHA1_MANIFEST}. The tarball has been modified or replaced since prepare. Operator recovery (the LLM driving /publish promote MUST NOT repack): delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}'." >&2
  exit 1
fi

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
      echo "promote: routed GH_CONFIG_DIR=${candidate} for origin org '${ORG}'"
      break
    fi
  done
fi

# SR-5.2 — push release commit to origin/main, idempotent.
# Idempotency: if origin/main is already at our commit, skip the push.
# Conservative: if remote main is a different SHA (including a descendant we
# weren't expecting), we still attempt the push — a non-fast-forward push will
# fail loudly with the operator-recovery prose below.
REMOTE_MAIN_SHA="$(git ls-remote origin refs/heads/main 2>/dev/null | awk '{print $1}')"
if [ "${REMOTE_MAIN_SHA}" = "${COMMIT_SHA}" ]; then
  echo "SR-5.2 (push commit): origin/main is already at ${COMMIT_SHA} — skipping push (idempotent)."
else
  if ! git push origin main; then
    echo "SR-5.2 (push commit): 'git push origin main' failed. State: release commit + annotated tag exist locally; nothing has been pushed or published. The manifest at ${MANIFEST} is preserved so /publish promote can be retried after the operator resolves the push failure. Operator recovery — the LLM driving /publish promote MUST NOT execute any of the commands below itself. Either (a) the operator resolves the push failure and reruns '/publish promote' (the push is idempotent — already-pushed is a no-op), or (b) the operator abandons and restarts by running 'git reset --hard origin/main && git tag -d ${TAG_NAME} && rm -f ${TARBALL_ABS} && rm -f ${MANIFEST}' then rerunning '/publish prepare ${BUMP_KIND}'. Common causes the operator should check: (1) auth — if origin is HTTPS and the host uses per-org GH_CONFIG_DIR routing (~/.gitconfig with credential.useHttpPath=true + per-org [credential] blocks), the operator can retry with 'GH_CONFIG_DIR=\$HOME/.config/gh-<org> git push origin main' where <org> is the GitHub org from the origin URL (this script auto-detects this but may miss a non-standard layout); (2) non-fast-forward — local main is behind origin/main, the operator runs 'git pull --rebase origin main' and retries — though if origin/main diverged from the prepared commit, abandon path (b) is safer." >&2
    exit 50
  fi
fi

# SR-5.3 — npm publish the smoke-tested tarball, idempotent.
# Idempotency: if `npm view <pkg>@<next> version` returns the version AND the
# published dist.shasum matches the manifest's tarball_sha1, treat as success.
# If the version exists with a different shasum, refuse — that's content drift,
# never silently re-skip.
PUBLISHED_VERSION="$(npm view "claude-slack-channel-bots@${NEXT_VERSION}" version 2>/dev/null | tr -d '[:space:]' || true)"
if [ "${PUBLISHED_VERSION}" = "${NEXT_VERSION}" ]; then
  PUBLISHED_SHASUM="$(npm view "claude-slack-channel-bots@${NEXT_VERSION}" dist.shasum 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "${PUBLISHED_SHASUM}" = "${TARBALL_SHA1_MANIFEST}" ]; then
    echo "SR-5.3 (npm publish): claude-slack-channel-bots@${NEXT_VERSION} is already on npm with matching dist.shasum (${PUBLISHED_SHASUM}) — skipping publish (idempotent)."
  else
    echo "SR-5.3 (npm publish): claude-slack-channel-bots@${NEXT_VERSION} is already on npm but its dist.shasum (${PUBLISHED_SHASUM}) does NOT match the prepared tarball's sha1 (${TARBALL_SHA1_MANIFEST}). This means the version on npm has different content than this prepare produced — content drift, not an idempotent skip. State: the commit IS on origin/main (or was already there); npm has a DIFFERENT tarball under v${NEXT_VERSION}; this machine still has the prepared tag + tarball + manifest. Operator recovery (the LLM driving /publish promote MUST NOT publish or modify the registry): have the operator decide whether the npm-side or the local-side is canonical. If npm-side is canonical: have the operator delete this prepare ('git reset --hard origin/main && git tag -d ${TAG_NAME} && rm -f ${TARBALL_ABS} && rm -f ${MANIFEST}'). If local-side is canonical: have the operator pick a fresh next version (deprecate v${NEXT_VERSION} on npm separately) and rerun '/publish prepare <bump>' targeting a higher number." >&2
    exit 51
  fi
else
  if ! npm publish "${TARBALL_ABS}"; then
    echo "SR-5.3 (npm publish): 'npm publish ${TARBALL_ABS}' did not succeed. State: release commit IS on origin/main; npm does NOT have v${NEXT_VERSION}; tag is NOT pushed. The manifest at ${MANIFEST} is preserved so /publish promote can be retried after the operator resolves the publish failure. Operator recovery — the LLM driving /publish promote MUST NOT execute any of the commands below itself: (a) the operator fixes the publish issue (e.g., 'npm login') and reruns '/publish promote' (publish is idempotent on retry — if the version is already published with matching content, the script will skip and continue); or (b) the operator reverts the remote with 'git push origin +HEAD~1:main', deletes the local tag with 'git tag -d ${TAG_NAME}', removes ${MANIFEST}, then reruns '/publish prepare ${BUMP_KIND}'." >&2
    exit 51
  fi
fi

# SR-5.4 — push the version tag to origin, idempotent.
REMOTE_TAG_SHA="$(git ls-remote origin "refs/tags/${TAG_NAME}" 2>/dev/null | awk '{print $1}')"
if [ -n "${REMOTE_TAG_SHA}" ]; then
  echo "SR-5.4 (push tag): origin already has tag ${TAG_NAME} — skipping push (idempotent)."
else
  if ! git push origin "${TAG_NAME}"; then
    echo "SR-5.4 (push tag): 'git push origin ${TAG_NAME}' failed. State: npm HAS v${NEXT_VERSION} and origin/main HAS the release commit; only the git tag is missing. Operator recovery (the LLM driving /publish promote MUST NOT push the tag itself): have the operator resolve the push issue and run 'git push origin ${TAG_NAME}' manually, then delete ${MANIFEST}. Do NOT rerun /publish promote unless the operator has confirmed the tag is still missing on origin — the release is otherwise complete." >&2
    exit 52
  fi
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
  echo "SR-6.1 (registry verification): claude-slack-channel-bots@${NEXT_VERSION} was not visible within the 60-second polling window. The release succeeded (commit, publish, and tag all pushed) — this is a propagation-verification failure only, not a release failure. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute the install or restart itself): have the operator re-confirm with 'npm view claude-slack-channel-bots@${NEXT_VERSION} version'; once visible, have the operator run 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually and then 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  exit 60
fi

# SR-7.1 — sanitize the bun-1.3.13 empty-string-dependency-key poison from the global package.json
if ! bash "${SCRIPT_DIR}/sanitize-global.sh"; then
  echo "SR-7.1 (sanitize global): 'scripts/sanitize-global.sh' exited non-zero. State: the release IS published (v${NEXT_VERSION} is on npm, commit + tag are on origin) but the local global package.json may contain bun-1.3.13 poison. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator inspect '\${BUN_INSTALL:-\$HOME/.bun}/install/global/package.json', remove any empty-string-key entry and any pre-existing claude-slack-channel-bots entry manually, then run 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' and 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  exit 70
fi

# SR-7.2 — remove any existing global install (tolerate non-zero exit; nothing may be installed).
# Then defensively rm the leftover node_modules entry to clean up dangling files or symlinks the
# remove step may not have cleared (e.g. a prior `install-local.sh` symlink farm).
GLOBAL_DIR="${BUN_INSTALL:-$HOME/.bun}/install/global"
bun remove -g claude-slack-channel-bots > /dev/null 2>&1 || true
rm -rf "${GLOBAL_DIR}/node_modules/claude-slack-channel-bots"

# SR-7.3 — install the just-published version from npm (the exact command an end user would run)
if ! bun install -g "claude-slack-channel-bots@${NEXT_VERSION}"; then
  echo "SR-7.3 (post-publish install): 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' did not succeed. State: the release IS published (v${NEXT_VERSION} is on npm, commit + tag are on origin) but the dev box has NO global install at this point. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator rerun 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually until it succeeds, then 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  exit 71
fi

# SR-7.4 — verify the install: bin resolves under the global install prefix, and installed version matches
INSTALLED_BIN_PATH="$(command -v claude-slack-channel-bots || true)"
if [ -z "${INSTALLED_BIN_PATH}" ]; then
  echo "SR-7.4 (post-publish verification): 'claude-slack-channel-bots' not found on PATH after install. State: the release IS published. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT mutate PATH or run clean_restart itself): have the operator confirm '${GLOBAL_DIR}/bin' is on PATH, then run 'claude-slack-channel-bots clean_restart' manually, then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  exit 72
fi

RESOLVED_BIN="$(readlink -f "${INSTALLED_BIN_PATH}")"
case "${RESOLVED_BIN}" in
  "${GLOBAL_DIR}"/*) ;;
  *)
    echo "SR-7.4 (post-publish verification): resolved bin '${RESOLVED_BIN}' is not under '${GLOBAL_DIR}/' — a worktree-pointing symlink farm would resolve outside this prefix and fail this check. State: the release IS published. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator run 'bun remove -g claude-slack-channel-bots' followed by 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' to replace the symlink farm with a real-copy install, then 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
    exit 72
    ;;
esac

INSTALLED_PKG_JSON="${GLOBAL_DIR}/node_modules/claude-slack-channel-bots/package.json"
if [ ! -f "${INSTALLED_PKG_JSON}" ]; then
  echo "SR-7.4 (post-publish verification): installed package.json not found at ${INSTALLED_PKG_JSON}. State: the release IS published but the global install layout is malformed. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator run 'bun remove -g claude-slack-channel-bots' and then 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually, then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  exit 72
fi

INSTALLED_VERSION="$(jq -r .version "${INSTALLED_PKG_JSON}")"
if [ "${INSTALLED_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "SR-7.4 (post-publish verification): installed version '${INSTALLED_VERSION}' != published ${NEXT_VERSION}. State: the release IS published but the local install resolved to a stale version. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator run 'bun remove -g claude-slack-channel-bots' followed by 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually until the installed version matches, then 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  exit 72
fi

# SR-8.1 — daemon-bounce handoff.
# Addressed to the orchestrating LLM, NOT the operator. The skill itself does
# not execute the bounce (clean_restart is operator-state-mutating; the b.1wi
# contract forbids the LLM from running such commands without explicit operator
# confirmation). The orchestrator's job on seeing this message: ask the
# operator, and run clean_restart only on confirmation.
DAEMON_PID_FILE="${HOME}/.claude/channels/slack/server.pid"
DAEMON_PID=""
DAEMON_ALIVE=0
if [ -f "${DAEMON_PID_FILE}" ]; then
  DAEMON_PID="$(cat "${DAEMON_PID_FILE}" 2>/dev/null || true)"
  if [ -n "${DAEMON_PID}" ] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
    DAEMON_ALIVE=1
  fi
fi
if [ "${DAEMON_ALIVE}" = "1" ]; then
  cat <<EOF >&2

SR-8.1 (daemon-bounce handoff): /publish promote complete. Release v${NEXT_VERSION} is on npm + GitHub + your global install.

DAEMON STATE: the daemon at PID ${DAEMON_PID} is still running the previous version. It MUST be bounced to pick up v${NEXT_VERSION}.

ORCHESTRATOR INSTRUCTION: confirm with the operator that they want the daemon bounced now. On confirmation, run:

    claude-slack-channel-bots clean_restart

Side effects of clean_restart: per-channel bot Claude sessions are killed and respawned. If a slack conversation is mid-flight, the bot will restart fresh.

If the operator declines, leave the daemon on the previous version. The release is fully delivered; only the local dev box is one bounce behind.
EOF
else
  cat <<EOF >&2

SR-8.1 (daemon-bounce handoff): /publish promote complete. Release v${NEXT_VERSION} is on npm + GitHub + your global install.

DAEMON STATE: no daemon currently running (PID file ${DAEMON_PID_FILE} is missing or its PID is dead). No bounce needed; the next 'claude-slack-channel-bots start' will pick up v${NEXT_VERSION} automatically.
EOF
fi

# SR-9.1 — success summary (the terminal output on every successful run)
NPM_URL="https://www.npmjs.com/package/claude-slack-channel-bots/v/${NEXT_VERSION}"
GITHUB_TAG_URL="https://github.com/gabemahoney/claude-slack-channel-bots/releases/tag/${TAG_NAME}"

# Manifest cleanup: the release is committed to the world; the manifest's
# job is done. If anything post-success fails later (e.g. operator interrupts
# the clean_restart they're supposed to run), the manifest staying around
# would falsely suggest "there's a release in flight that needs promoting."
rm -f "${MANIFEST}"

cat <<EOF

Release complete: claude-slack-channel-bots@${NEXT_VERSION}

  Published version: ${NEXT_VERSION}
  npm:               ${NPM_URL}
  GitHub tag:        ${GITHUB_TAG_URL}
  Local install:     ${RESOLVED_BIN}

Next: run \`claude-slack-channel-bots clean_restart\` to swap the running daemon over to v${NEXT_VERSION}.
EOF

# Success-only tarball cleanup. The smoke-tested tarball's job is done once
# the release is on npm + verified locally. Failure paths above all 'exit'
# without reaching here, preserving the tarball for operator recovery.
if [ -n "${TARBALL_ABS:-}" ] && [ -f "${TARBALL_ABS}" ]; then
  rm -f "${TARBALL_ABS}"
fi

exit 0
