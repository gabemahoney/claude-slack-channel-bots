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
#   60  SR-6.1  registry did not surface new version within 10 minutes
#   70  SR-7.1  sanitize-global.sh failed
#   71  SR-7.3  post-publish bun install -g failed
#   72  SR-7.4  post-publish verification failed (includes an install in another
#               bun prefix shadowing this one on PATH — see SR-7.0, which warns
#               about the same condition before the install, and SR-7.4b, which
#               warns about a blocked postinstall; neither of those exits)

set -euo pipefail

# SR-99.0 is a backstop for UNGUARDED failures only. Every deliberate exit below
# goes through sr_exit(), which raises this flag first, so the trap stays silent
# for an exit that already printed its own SR-X.Y diagnostic. An unguarded
# failure (a set -e death at a site with no wrapper) leaves the flag at 0 and
# still gets SR-99.0. This is deliberately not an exit-code allowlist: a new SR
# code needs no bookkeeping here, only that its site calls sr_exit.
#
# sr_exit must be called from the script's own shell — a call inside a subshell
# (including a command substitution) would set the flag in the subshell only and
# the backstop would fire anyway. Helpers that run under $(...) return non-zero
# instead and let their caller sr_exit.
SR_GUARDED_EXIT=0
sr_exit() {
  SR_GUARDED_EXIT=1
  exit "$1"
}

# shellcheck disable=SC2154
trap 'rc=$?; if [ $rc -ne 0 ] && [ "${SR_GUARDED_EXIT:-0}" != "1" ]; then echo "SR-99.0 (uncaught): scripts/$(basename "${BASH_SOURCE[0]}") exited with code $rc at command: ${BASH_COMMAND}. The b.1wi contract requires an SR-X.Y diagnostic for every non-zero exit; that diagnostic is missing because the failing command was not wrapped. Operator recovery: report this trap output verbatim — it identifies the unguarded site so the next /publish run can add the missing wrapper. State of the release is indeterminate; do NOT rerun /publish until the operator has assessed." >&2; fi' EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${REPO_ROOT}" ]; then
  echo "promote (precondition): not inside a git working tree. Run /publish promote from a clone or worktree of claude-slack-channel-bots that has a valid .publish-state.json manifest at its root." >&2
  sr_exit 1
fi
cd "${REPO_ROOT}"

# Snapshot the working-tree dirt at script start so SR-7.5 (below) can tell
# promote-INDUCED package.json/bun.lock dirt (safe to revert) apart from
# dirt an operator deliberately staged BEFORE promote ran (must NOT be
# clobbered — that is exactly the load-bearing-dirt scenario b.bpp warns of).
# `|| true` keeps a git failure here from killing the script under set -e;
# an empty snapshot just means "treat everything as promote-induced", which
# is the safe default for a clean start.
START_DIRTY="$(git diff --name-only 2>/dev/null || true)"
START_PKG_JSON_DIRTY=0
START_BUN_LOCK_DIRTY=0
if printf '%s\n' "${START_DIRTY}" | grep -qxF 'package.json'; then
  START_PKG_JSON_DIRTY=1
fi
if printf '%s\n' "${START_DIRTY}" | grep -qxF 'bun.lock'; then
  START_BUN_LOCK_DIRTY=1
fi

MANIFEST="${REPO_ROOT}/.publish-state.json"
if [ ! -f "${MANIFEST}" ]; then
  echo "promote (precondition): no .publish-state.json at ${MANIFEST}. /publish promote runs only after /publish prepare has succeeded. Operator recovery: run '/publish prepare <patch|minor|major>' first, or — if you intended to run a release end-to-end without the split — run '/publish <bump>' which invokes prepare then promote in one shot." >&2
  sr_exit 1
fi

# Parse manifest. jq returns null for missing fields, which we treat as
# corruption; refuse to run rather than guess. Each read is wrapped so a
# malformed-JSON jq crash surfaces an SR-precondition diagnostic instead of
# silently exiting under set -e. The helper runs inside a command substitution,
# so it returns 1 rather than exiting; each call site turns that into sr_exit 1
# in the script's own shell (same exit code, and the SR-99.0 guard flag sticks).
_jq_manifest() {
  local field="$1"
  local default="${2-empty}"
  local val
  if ! val="$(jq -r ".${field} // ${default}" "${MANIFEST}")"; then
    echo "promote (precondition): jq failed to read '.${field}' from ${MANIFEST}. The manifest is malformed JSON or jq is broken. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator run 'jq . ${MANIFEST}' to inspect; if corrupt, delete it and rerun '/publish prepare <patch|minor|major>'." >&2
    return 1
  fi
  printf '%s' "${val}"
}
BUMP_KIND="$(_jq_manifest bump_kind)" || sr_exit 1
NEXT_VERSION="$(_jq_manifest next_version)" || sr_exit 1
COMMIT_SHA="$(_jq_manifest commit_sha)" || sr_exit 1
TAG_NAME="$(_jq_manifest tag_name)" || sr_exit 1
TARBALL_ABS="$(_jq_manifest tarball_path)" || sr_exit 1
TARBALL_SHA1_MANIFEST="$(_jq_manifest tarball_sha1)" || sr_exit 1
SMOKE_PASSED="$(_jq_manifest smoke_passed false)" || sr_exit 1

for var in BUMP_KIND NEXT_VERSION COMMIT_SHA TAG_NAME TARBALL_ABS TARBALL_SHA1_MANIFEST; do
  if [ -z "${!var}" ]; then
    echo "promote (precondition): .publish-state.json is missing required field '${var,,}' (file: ${MANIFEST}). The manifest is corrupted or from an older prepare version. Operator recovery: delete .publish-state.json and rerun '/publish prepare <bump>'." >&2
    sr_exit 1
  fi
done

if [ "${SMOKE_PASSED}" != "true" ]; then
  echo "promote (precondition): .publish-state.json reports smoke_passed=${SMOKE_PASSED}. Promote refuses to ship a release that did not pass the prepare-phase smoke check. Operator recovery: delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}' until smoke passes." >&2
  sr_exit 1
fi

# Verify HEAD matches the manifest's commit_sha — refuse to push the wrong commit.
if ! HEAD_SHA="$(git rev-parse HEAD)"; then
  echo "promote (precondition): 'git rev-parse HEAD' failed inside ${REPO_ROOT}. The repo is in an unusual state (detached/missing HEAD, corrupt .git). Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator run 'git status' to inspect the repo, resolve the underlying issue, then rerun '/publish promote'." >&2
  sr_exit 1
fi
if [ "${HEAD_SHA}" != "${COMMIT_SHA}" ]; then
  echo "promote (precondition): manifest commit_sha is ${COMMIT_SHA} but HEAD is ${HEAD_SHA}. The repo has drifted since /publish prepare ran. Operator recovery (the LLM driving /publish promote MUST NOT mutate the repo): have the operator inspect 'git log --oneline ${COMMIT_SHA}..HEAD' to understand the drift, then either (a) 'git reset --hard ${COMMIT_SHA}' to return to the prepared state and rerun '/publish promote', or (b) delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}' from scratch." >&2
  sr_exit 1
fi

# Verify tag exists locally and points at the same commit.
# Use ^{commit} to dereference annotated tags to the underlying commit SHA;
# bare 'git rev-parse refs/tags/<tag>' returns the tag-object SHA for annotated
# tags, which never matches a commit SHA. /publish prepare creates annotated tags.
if ! TAG_SHA="$(git rev-parse --verify "refs/tags/${TAG_NAME}^{commit}" 2>/dev/null)"; then
  echo "promote (precondition): manifest expects local tag ${TAG_NAME} but it does not exist. Operator recovery (the LLM driving /publish promote MUST NOT create the tag): delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}'." >&2
  sr_exit 1
fi
if [ "${TAG_SHA}" != "${COMMIT_SHA}" ]; then
  echo "promote (precondition): manifest tag ${TAG_NAME} points to commit ${TAG_SHA}, not the manifest commit ${COMMIT_SHA}. The tag has been moved or the manifest is stale. Operator recovery (the LLM driving /publish promote MUST NOT move the tag): have the operator inspect 'git show ${TAG_NAME}' to understand the drift, then run 'git tag -d ${TAG_NAME} && rm -f .publish-state.json' to clear the prepared state, then rerun '/publish prepare ${BUMP_KIND}' to produce a fresh consistent set." >&2
  sr_exit 1
fi

# Verify package.json version matches manifest's next_version.
if ! PKG_VERSION="$(node -p "require('./package.json').version")"; then
  echo "promote (precondition): 'node -p \"require('./package.json').version\"' failed reading ${REPO_ROOT}/package.json. The file is missing, malformed, or has no .version field. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator run 'cat ${REPO_ROOT}/package.json | jq .version' to inspect; if the working tree has drifted, delete ${MANIFEST} and rerun '/publish prepare ${BUMP_KIND}'." >&2
  sr_exit 1
fi
if [ "${PKG_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "promote (precondition): manifest next_version is ${NEXT_VERSION} but package.json on disk is at ${PKG_VERSION}. The working tree drifted from the prepared state. Operator recovery (the LLM driving /publish promote MUST NOT edit package.json): delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}'." >&2
  sr_exit 1
fi

# Verify tarball exists at recorded path.
if [ ! -f "${TARBALL_ABS}" ]; then
  echo "promote (precondition): manifest tarball_path is ${TARBALL_ABS} but no file exists there. The smoke-tested tarball is gone. Operator recovery (the LLM driving /publish promote MUST NOT regenerate the tarball): delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}' to produce a fresh smoke-tested tarball." >&2
  sr_exit 1
fi

# Verify tarball content hasn't drifted since prepare. The `|| true` keeps a
# sha1sum/awk pipeline failure from silently exiting under set -e + pipefail;
# the next comparison treats an empty result as a mismatch and fires its own
# precondition diagnostic.
TARBALL_SHA1_DISK="$(sha1sum "${TARBALL_ABS}" | awk '{print $1}' || true)"
if [ "${TARBALL_SHA1_DISK}" != "${TARBALL_SHA1_MANIFEST}" ]; then
  echo "promote (precondition): tarball at ${TARBALL_ABS} has sha1 ${TARBALL_SHA1_DISK} but manifest recorded ${TARBALL_SHA1_MANIFEST}. The tarball has been modified or replaced since prepare. Operator recovery (the LLM driving /publish promote MUST NOT repack): delete .publish-state.json and rerun '/publish prepare ${BUMP_KIND}'." >&2
  sr_exit 1
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
REMOTE_MAIN_SHA="$(git ls-remote origin refs/heads/main 2>/dev/null | awk '{print $1}' || true)"
if [ "${REMOTE_MAIN_SHA}" = "${COMMIT_SHA}" ]; then
  echo "SR-5.2 (push commit): origin/main is already at ${COMMIT_SHA} — skipping push (idempotent)."
else
  if ! git push origin main; then
    echo "SR-5.2 (push commit): 'git push origin main' failed. State: release commit + annotated tag exist locally; nothing has been pushed or published. The manifest at ${MANIFEST} is preserved so /publish promote can be retried after the operator resolves the push failure. Operator recovery — the LLM driving /publish promote MUST NOT execute any of the commands below itself. Either (a) the operator resolves the push failure and reruns '/publish promote' (the push is idempotent — already-pushed is a no-op), or (b) the operator abandons and restarts by running 'git reset --hard origin/main && git tag -d ${TAG_NAME} && rm -f ${TARBALL_ABS} && rm -f ${MANIFEST}' then rerunning '/publish prepare ${BUMP_KIND}'. Common causes the operator should check: (1) auth — if origin is HTTPS and the host uses per-org GH_CONFIG_DIR routing (~/.gitconfig with credential.useHttpPath=true + per-org [credential] blocks), the operator can retry with 'GH_CONFIG_DIR=\$HOME/.config/gh-<org> git push origin main' where <org> is the GitHub org from the origin URL (this script auto-detects this but may miss a non-standard layout); (2) non-fast-forward — local main is behind origin/main, the operator runs 'git pull --rebase origin main' and retries — though if origin/main diverged from the prepared commit, abandon path (b) is safer." >&2
    sr_exit 50
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
    sr_exit 51
  fi
else
  if ! npm publish "${TARBALL_ABS}"; then
    echo "SR-5.3 (npm publish): 'npm publish ${TARBALL_ABS}' did not succeed. State: release commit IS on origin/main; npm does NOT have v${NEXT_VERSION}; tag is NOT pushed. The manifest at ${MANIFEST} is preserved so /publish promote can be retried after the operator resolves the publish failure. Operator recovery — the LLM driving /publish promote MUST NOT execute any of the commands below itself: (a) the operator fixes the publish issue (e.g., 'npm login') and reruns '/publish promote' (publish is idempotent on retry — if the version is already published with matching content, the script will skip and continue); or (b) the operator reverts the remote with 'git push origin +HEAD~1:main', deletes the local tag with 'git tag -d ${TAG_NAME}', removes ${MANIFEST}, then reruns '/publish prepare ${BUMP_KIND}'." >&2
    sr_exit 51
  fi
fi

# SR-5.4 — push the version tag to origin, idempotent.
REMOTE_TAG_SHA="$(git ls-remote origin "refs/tags/${TAG_NAME}" 2>/dev/null | awk '{print $1}' || true)"
if [ -n "${REMOTE_TAG_SHA}" ]; then
  echo "SR-5.4 (push tag): origin already has tag ${TAG_NAME} — skipping push (idempotent)."
else
  if ! git push origin "${TAG_NAME}"; then
    echo "SR-5.4 (push tag): 'git push origin ${TAG_NAME}' failed. State: npm HAS v${NEXT_VERSION} and origin/main HAS the release commit; only the git tag is missing. Operator recovery (the LLM driving /publish promote MUST NOT push the tag itself): have the operator resolve the push issue and run 'git push origin ${TAG_NAME}' manually, then delete ${MANIFEST}. Do NOT rerun /publish promote unless the operator has confirmed the tag is still missing on origin — the release is otherwise complete." >&2
    sr_exit 52
  fi
fi

# SR-6.1 — poll npm registry until v${NEXT_VERSION} is visible.
#
# Window: 10 minutes (120 attempts at a 5-second cadence = 600s).
#
# Why 10 minutes and not 5: the only measured propagation lag we have is 210s
# (the 0.10.0 release, 2026-09-21), and npm's own publish output warns that a
# new version's visibility "may take a few minutes". A 5-minute window would
# leave only ~90s of margin over a single thin observation. 10 minutes gives
# roughly 3× margin over that measurement, and the only thing a longer window
# costs is wall-clock time during a release that is already in progress —
# whereas the alternative (timing out into exit 60) costs a full manual Phase 7.
SR61_POLL_ATTEMPTS=120
SR61_POLL_INTERVAL=5
SR61_PROGRESS_EVERY=6   # one progress line every 6 attempts ≈ every 30s

echo "SR-6.1 (registry verification): polling npm for claude-slack-channel-bots@${NEXT_VERSION}. npm propagation commonly takes several minutes; the polling window is 10 minutes (${SR61_POLL_ATTEMPTS} attempts at ${SR61_POLL_INTERVAL}s)."

VERIFIED=0
for ATTEMPT in $(seq 1 "${SR61_POLL_ATTEMPTS}"); do
  # `|| true` is load-bearing: when npm registry hasn't yet propagated v${NEXT_VERSION},
  # `npm view` exits non-zero (E404), and under set -e + pipefail the bare pipeline-
  # assignment kills the script with no SR-X.Y diagnostic. The empty-result case
  # is the intended retry path, so we tolerate it explicitly here.
  REGISTRY_VERSION="$(npm view "claude-slack-channel-bots@${NEXT_VERSION}" version 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "${REGISTRY_VERSION}" = "${NEXT_VERSION}" ]; then
    VERIFIED=1
    break
  fi
  if [ $(( ATTEMPT % SR61_PROGRESS_EVERY )) -eq 0 ]; then
    echo "SR-6.1 (registry verification): still waiting for claude-slack-channel-bots@${NEXT_VERSION} to appear on the registry (attempt ${ATTEMPT}/${SR61_POLL_ATTEMPTS}, ~$(( ATTEMPT * SR61_POLL_INTERVAL ))s elapsed)…"
  fi
  sleep "${SR61_POLL_INTERVAL}"
done

if [ "${VERIFIED}" != "1" ]; then
  echo "SR-6.1 (registry verification): claude-slack-channel-bots@${NEXT_VERSION} was not visible within the 10-minute polling window. The release succeeded (commit, publish, and tag all pushed) — this is a propagation-verification failure only, not a release failure. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute the install or restart itself): have the operator re-confirm with 'npm view claude-slack-channel-bots@${NEXT_VERSION} version'; once visible, have the operator run 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually and then 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  sr_exit 60
fi

# SR-7.1 — sanitize the bun-1.3.13 empty-string-dependency-key poison from the global package.json
if ! bash "${SCRIPT_DIR}/sanitize-global.sh"; then
  echo "SR-7.1 (sanitize global): 'scripts/sanitize-global.sh' exited non-zero. State: the release IS published (v${NEXT_VERSION} is on npm, commit + tag are on origin) but the local global package.json may contain bun-1.3.13 poison. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator inspect '\${BUN_INSTALL:-\$HOME/.bun}/install/global/package.json', remove any empty-string-key entry and any pre-existing claude-slack-channel-bots entry manually, then run 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' and 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  sr_exit 70
fi

# ---------------------------------------------------------------------------
# Phase 7 prefix resolution + shadowing-install helpers (b.r6x)
# ---------------------------------------------------------------------------
#
# BUN_PREFIX is bun's global prefix. `${BUN_INSTALL:-$HOME/.bun}` is the CORRECT
# expansion (verified with bun 1.4.0: with BUN_INSTALL unset, ~/.bun is bun's
# default global prefix) — do not "fix" it. What b.r6x is about is that an
# install can also exist in some OTHER prefix (e.g. a stale ~/.cache/.bun farm
# left by an install run with BUN_INSTALL pointed there), and that stale copy can
# win on PATH via a shim in ~/.local/bin. Phase 7 used to be blind to that: it
# installed correctly here, then failed SR-7.4 with a diagnostic blaming this
# prefix's layout instead of naming the shadowing install.
#
# Every helper below is a pure function over its arguments plus BUN_PREFIX /
# GLOBAL_DIR, and both of those derive from the environment (BUN_INSTALL, HOME)
# while resolution itself goes through PATH. A test can therefore drive all of
# this against fake prefixes under a mktemp -d with no real install in sight.
BUN_PREFIX="${BUN_INSTALL:-$HOME/.bun}"
GLOBAL_DIR="${BUN_PREFIX}/install/global"

# Where does `claude-slack-channel-bots` resolve from on PATH right now?
# Prints "<path-on-PATH>\t<readlink -f target>", or nothing when the command is
# not on PATH at all. Never exits: it is meant to be called inside $( ), where an
# sr_exit would set the guard flag in a subshell only (see the SR-99.0 note).
cscb_resolve_on_path() {
  local on_path target
  on_path="$(command -v claude-slack-channel-bots 2>/dev/null || true)"
  [ -n "${on_path}" ] || return 0
  target="$(readlink -f "${on_path}" 2>/dev/null || true)"
  printf '%s\t%s' "${on_path}" "${target}"
}

# 0 (true) when ${resolved} is NOT under "${prefix}/". An empty/unresolvable
# path counts as outside — an unresolvable bin is never a healthy install here.
cscb_is_outside_prefix() {
  local resolved="$1" prefix="$2"
  [ -n "${resolved}" ] || return 0
  case "${resolved}" in
    "${prefix}"/*) return 1 ;;
    *) return 0 ;;
  esac
}
# Render the symlink chain starting at $1 as "a -> b -> c", one hop per link, so
# the diagnostic shows the shim that is actually doing the shadowing rather than
# only `readlink -f`'s final answer. Hop-capped to survive a symlink cycle.
cscb_symlink_chain() {
  local p="$1" chain="$1" next hops=0
  while [ -L "${p}" ] && [ "${hops}" -lt 16 ]; do
    next="$(readlink "${p}" 2>/dev/null || true)"
    [ -n "${next}" ] || break
    case "${next}" in
      /*) ;;
      *) next="$(dirname "${p}")/${next}" ;;
    esac
    chain="${chain} -> ${next}"
    p="${next}"
    hops=$(( hops + 1 ))
  done
  printf '%s' "${chain}"
}

# Best-effort: the bun prefix owning a single path, recognizing both shapes a
# shadowing install takes — the install tree (<prefix>/install/global/...) and
# the prefix's own bin symlink (<prefix>/bin/claude-slack-channel-bots). Prints
# nothing for anything else (e.g. a farm symlink pointing straight into a repo).
cscb_bun_prefix_of() {
  case "$1" in
    */install/global/*) printf '%s' "${1%%/install/global/*}" ;;
    */bin/claude-slack-channel-bots) printf '%s' "$(dirname "$(dirname "$1")")" ;;
  esac
}

# Walk the symlink chain from $1 and print the first bun prefix found that is NOT
# the canonical ${BUN_PREFIX} — i.e. the stale prefix to clean up. Prints nothing
# when the chain never passes through another prefix.
#
# The `-d <candidate>/install/global` test is load-bearing, not belt-and-braces:
# a plain PATH shim such as ~/.local/bin/claude-slack-channel-bots matches the
# <prefix>/bin/<pkg> shape by accident, and calling ~/.local a bun prefix would
# make the report tell the operator to delete the very shim that AC-4 says must
# be repointed instead. Only a directory that really holds an install/global
# tree counts.
cscb_shadow_prefix() {
  local start="$1" chain hop candidate raw canonical
  chain="$(cscb_symlink_chain "${start}")"
  # Compare normalized paths, not spellings: a hop can reach the canonical
  # prefix through a symlinked directory or an unnormalized relative target, and
  # a literal string test would call that a second prefix and tell the operator
  # to delete the tree we just installed.
  canonical="$(readlink -f "${BUN_PREFIX}" 2>/dev/null || true)"
  canonical="${canonical:-${BUN_PREFIX}}"
  # The chain is " -> "-separated; no path in it can contain that separator.
  local IFS=$'\n'
  for hop in $(printf '%s' "${chain}" | sed 's/ -> /\n/g'); do
    raw="$(cscb_bun_prefix_of "${hop}")"
    # Fall back to the raw spelling when readlink -f cannot resolve it, so an
    # unresolvable path is still reported rather than silently dropped.
    candidate="$(readlink -f "${raw}" 2>/dev/null || true)"
    candidate="${candidate:-${raw}}"
    if [ -n "${candidate}" ] && [ "${candidate}" != "${canonical}" ] && [ -d "${candidate}/install/global" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
}

# The shared shadowing-install report: names the resolved path, the shim chain,
# the expected prefix, and the exact manual remediation. Used by BOTH the
# SR-7.0 pre-install warning and the SR-7.4 exit-72 diagnostic so the two can
# never drift. Deliberately reports instead of deleting: promote does not own
# other prefixes on the host, and a wrong `rm -rf` there is unrecoverable.
cscb_shadow_report() {
  local on_path="$1" resolved="$2" stale
  stale="$(cscb_shadow_prefix "${on_path}")"
  printf 'On PATH:           %s\n' "${on_path}"
  printf 'Symlink chain:     %s\n' "$(cscb_symlink_chain "${on_path}")"
  printf 'Resolves to:       %s\n' "${resolved:-<unresolvable>}"
  printf 'Expected under:    %s/\n' "${GLOBAL_DIR}"
  printf '\n'
  if [ -n "${stale}" ]; then
    printf 'A second bun global prefix at %s is shadowing the canonical one. Manual remediation (the LLM driving /publish promote MUST NOT execute these commands itself):\n' "${stale}"
    printf '    rm -rf %s/install/global\n' "${stale}"
    # Never emit an `rm -f` for the PATH shim itself — the ln -sfn below repoints
    # it, and deleting it can make the command unresolvable (AC-4).
    if [ "${stale}/bin/claude-slack-channel-bots" != "${on_path}" ]; then
      printf '    rm -f  %s/bin/claude-slack-channel-bots\n' "${stale}"
    fi
  else
    printf 'The resolved path is outside the canonical prefix but does not look like another bun global prefix (a symlink farm pointing into a repo checkout does this). Manual remediation (the LLM driving /publish promote MUST NOT execute these commands itself) — remove whatever owns the path above, then:\n'
  fi
  printf '    ln -sfn %s/bin/claude-slack-channel-bots %s\n' "${BUN_PREFIX}" "${on_path}"
  printf '    bun pm -g trust claude-slack-channel-bots\n'
  printf '    command -v claude-slack-channel-bots   # must now resolve under %s/\n' "${GLOBAL_DIR}"
  printf '\n'
  printf 'Two constraints on that cleanup: (1) NEVER touch any install/cache directory under a bun prefix — that is bun'"'"'s shared package download cache, used by every package on the box, not part of this install; (2) REPOINT the PATH shim with ln -sfn, do not delete it — %s/bin is commonly not on the interactive PATH, so deleting the shim makes the command unresolvable in a normal shell.\n' "${BUN_PREFIX}"
}

# SR-7.0 — pre-install shadowing check (b.r6x AC-1).
# Runs BEFORE the remove/install below, so the state it reports is the state that
# existed when promote started rather than a post-install mixture. It only warns
# here: aborting before the install would leave the host with the stale copy AND
# no new install, which is strictly worse. If the shadow still wins after the
# install, SR-7.4 below fails with the same report.
SR70_PATH_INFO="$(cscb_resolve_on_path)"
SR70_ON_PATH="${SR70_PATH_INFO%%$'\t'*}"
SR70_RESOLVED="${SR70_PATH_INFO#*$'\t'}"
if [ -z "${SR70_PATH_INFO}" ]; then
  SR70_ON_PATH=""
  SR70_RESOLVED=""
fi
if [ -n "${SR70_ON_PATH}" ] && cscb_is_outside_prefix "${SR70_RESOLVED}" "${GLOBAL_DIR}"; then
  {
    echo ""
    echo "SR-7.0 (pre-install shadow check): WARNING — 'claude-slack-channel-bots' currently resolves from OUTSIDE the prefix promote is about to install into. The new install will land correctly, but this stale copy will keep winning on PATH until it is removed, and SR-7.4 below will fail the release because of it."
    cscb_shadow_report "${SR70_ON_PATH}" "${SR70_RESOLVED}"
  } >&2
fi

# SR-7.2 — remove any existing global install (tolerate non-zero exit; nothing may be installed).
# Then defensively rm the leftover node_modules entry to clean up dangling files or symlinks the
# remove step may not have cleared (e.g. a prior `install-local.sh` symlink farm).
# Scope note (b.r6x): this cleanup is deliberately confined to ${GLOBAL_DIR}. A
# shadowing install in another prefix is REPORTED (SR-7.0 / SR-7.4), never
# deleted here — see cscb_shadow_report.
(cd "$HOME" && bun remove -g claude-slack-channel-bots) > /dev/null 2>&1 || true
rm -rf "${GLOBAL_DIR}/node_modules/claude-slack-channel-bots" || true

# SR-7.3 — install the just-published version from npm (the exact command an end user would run)
if ! (cd "$HOME" && bun install -g "claude-slack-channel-bots@${NEXT_VERSION}"); then
  echo "SR-7.3 (post-publish install): 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' did not succeed. State: the release IS published (v${NEXT_VERSION} is on npm, commit + tag are on origin) but the dev box has NO global install at this point. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator rerun 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually until it succeeds, then 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  sr_exit 71
fi

# SR-7.4 — verify the install: bin resolves under the global install prefix, and installed version matches
INSTALLED_BIN_PATH="$(command -v claude-slack-channel-bots || true)"
if [ -z "${INSTALLED_BIN_PATH}" ]; then
  echo "SR-7.4 (post-publish verification): 'claude-slack-channel-bots' not found on PATH after install. State: the release IS published. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT mutate PATH or run clean_restart itself): have the operator confirm '${GLOBAL_DIR}/bin' is on PATH, then run 'claude-slack-channel-bots clean_restart' manually, then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  sr_exit 72
fi

if ! RESOLVED_BIN="$(readlink -f "${INSTALLED_BIN_PATH}")"; then
  echo "SR-7.4 (post-publish verification): 'readlink -f ${INSTALLED_BIN_PATH}' failed — the bin path on PATH does not resolve. State: the release IS published (v${NEXT_VERSION} is on npm + tag is on origin) but the local global install layout is broken. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator run 'bun remove -g claude-slack-channel-bots' and then 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually, then 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  sr_exit 72
fi
case "${RESOLVED_BIN}" in
  "${GLOBAL_DIR}"/*) ;;
  *)
    # b.r6x AC-6: this used to blame "the global install layout" and send the
    # operator to re-run remove/install in THIS prefix — which cannot help when
    # the winner on PATH lives in a different prefix entirely. Name what was
    # actually found, what was expected, and the shim in between.
    {
      echo "SR-7.4 (post-publish verification): the 'claude-slack-channel-bots' on PATH does not come from the prefix this release installed into. The install itself is fine — something else is shadowing it on PATH."
      cscb_shadow_report "${INSTALLED_BIN_PATH}" "${RESOLVED_BIN}"
      echo "State: the release IS published (v${NEXT_VERSION} is on npm + tag is on origin) and installed at ${GLOBAL_DIR}/node_modules/claude-slack-channel-bots; only PATH resolution is wrong. ${MANIFEST} is preserved. After the remediation above resolves the command under ${GLOBAL_DIR}/, have the operator run 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote — rerunning reinstalls the same correct copy and changes nothing about the shadowing path."
    } >&2
    sr_exit 72
    ;;
esac

INSTALLED_PKG_JSON="${GLOBAL_DIR}/node_modules/claude-slack-channel-bots/package.json"
if [ ! -f "${INSTALLED_PKG_JSON}" ]; then
  echo "SR-7.4 (post-publish verification): installed package.json not found at ${INSTALLED_PKG_JSON}. State: the release IS published but the global install layout is malformed. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator run 'bun remove -g claude-slack-channel-bots' and then 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually, then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  sr_exit 72
fi

if ! INSTALLED_VERSION="$(jq -r .version "${INSTALLED_PKG_JSON}")"; then
  echo "SR-7.4 (post-publish verification): 'jq -r .version ${INSTALLED_PKG_JSON}' failed — installed package.json is malformed JSON. State: the release IS published but the local install is broken. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator run 'bun remove -g claude-slack-channel-bots' and then 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually, then 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  sr_exit 72
fi
if [ "${INSTALLED_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "SR-7.4 (post-publish verification): installed version '${INSTALLED_VERSION}' != published ${NEXT_VERSION}. State: the release IS published but the local install resolved to a stale version. ${MANIFEST} is preserved. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator run 'bun remove -g claude-slack-channel-bots' followed by 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually until the installed version matches, then 'claude-slack-channel-bots clean_restart', then delete ${MANIFEST}. Do NOT rerun /publish promote." >&2
  sr_exit 72
fi

# SR-7.4b — postinstall trust gap (b.r6x AC-7).
#
# Bun blocks a package's postinstall unless the global manifest lists it in
# trustedDependencies. A FRESH global prefix has no such entry, so the install
# above succeeds while src/postinstall.ts never runs — and the failure only
# surfaces much later, as `start` dying with "missing prerequisite: config.json".
# So: trust the package if the manifest does not already, then verify the
# artifacts postinstall is responsible for actually exist.
#
# Non-fatal by design, like SR-7.5: the release is published, tagged and verified
# by this point, and the artifacts are scaffolded skeletons an operator can
# create in one command. Failing the release here would tell the operator the
# release broke when it did not. Paths honor SLACK_STATE_DIR (the same override
# src/postinstall.ts reads), so this block is drivable against a temp state dir.
SR74B_STATE_DIR="${SLACK_STATE_DIR:-${HOME}/.claude/channels/slack}"
SR74B_MCP_CONFIG="${HOME}/.claude/slack-mcp.json"
SR74B_GLOBAL_PKG="${GLOBAL_DIR}/package.json"

SR74B_TRUSTED=0
if [ -f "${SR74B_GLOBAL_PKG}" ]; then
  if jq -e '(.trustedDependencies // []) | index("claude-slack-channel-bots")' "${SR74B_GLOBAL_PKG}" > /dev/null 2>&1; then
    SR74B_TRUSTED=1
  fi
fi

if [ "${SR74B_TRUSTED}" != "1" ]; then
  echo "SR-7.4b (postinstall trust): ${SR74B_GLOBAL_PKG} does not list claude-slack-channel-bots in trustedDependencies, so bun blocked its postinstall. Running 'bun pm -g trust claude-slack-channel-bots' to execute it."
  # $HOME subshell for the same reason every other `bun -g` site has one (b.bpp):
  # bun must not resolve the repo's package.json during a global operation.
  (cd "$HOME" && bun pm -g trust claude-slack-channel-bots) || \
    echo "SR-7.4b (postinstall trust): 'bun pm -g trust claude-slack-channel-bots' did not succeed. Continuing — the artifact check below reports whether that actually left anything missing." >&2
fi

SR74B_MISSING=()
for sr74b_artifact in "${SR74B_STATE_DIR}/config.json" "${SR74B_STATE_DIR}/access.json" "${SR74B_MCP_CONFIG}"; do
  if [ ! -f "${sr74b_artifact}" ]; then
    SR74B_MISSING+=("${sr74b_artifact}")
  fi
done

if [ "${#SR74B_MISSING[@]}" -gt 0 ]; then
  {
    echo "SR-7.4b (postinstall trust): WARNING — these files the postinstall scaffolds are still missing after the install:"
    printf '  %s\n' "${SR74B_MISSING[@]}"
    echo "Without them 'claude-slack-channel-bots start' fails with 'missing prerequisite: config.json'. The release IS fully delivered (v${NEXT_VERSION} is on npm + tag on origin + verified locally), so this is NOT a release failure and the script does not exit non-zero here. Operator recovery (the LLM driving /publish promote MUST NOT execute these commands itself): have the operator run 'bun pm -g trust claude-slack-channel-bots' and confirm it prints a '✓ [postinstall]' line, then re-check the paths above. Note that trust SWALLOWS the postinstall's own stdout — the paths existing on disk is the observable proof, not the script's log."
  } >&2
fi

# SR-7.5 — belt-and-suspenders: post-verify working-tree snapshot.
# The CWD-isolation fix above ($HOME subshells around every `bun -g`) is the
# primary defense against this script dirtying the local package.json / bun.lock.
# This block is a complementary safety net: if a future change re-introduces the
# escape, catch it here.
#
# We revert ONLY package.json / bun.lock, and ONLY those of the two that were
# CLEAN at script start (START_*_DIRTY==0) — because dirt that appeared during
# promote is necessarily promote-induced (owned by the prepare-phase commit,
# never by promote), whereas dirt already present at start is deliberate
# operator work and must NOT be clobbered (the load-bearing-dirt scenario
# b.bpp guards against). Anything the revert leaves behind — a file dirty at
# start, a non-pkg/lock file, or a checkout that failed to clean — takes the
# loud-stderr-warning path instead. Either arm keeps exit 0: the release is
# already published, tagged, and verified, so this late stage never fails it.
POST_VERIFY_DIRTY="$(git diff --name-only 2>/dev/null || true)"
if [ -n "${POST_VERIFY_DIRTY}" ]; then
  # Build the list of pkg/lock files that are promote-INDUCED (dirty now but
  # clean at start) and therefore safe to revert.
  REVERTABLE=()
  if [ "${START_PKG_JSON_DIRTY}" = "0" ] && printf '%s\n' "${POST_VERIFY_DIRTY}" | grep -qxF 'package.json'; then
    REVERTABLE+=("package.json")
  fi
  if [ "${START_BUN_LOCK_DIRTY}" = "0" ] && printf '%s\n' "${POST_VERIFY_DIRTY}" | grep -qxF 'bun.lock'; then
    REVERTABLE+=("bun.lock")
  fi

  REVERT_OK=1
  REVERTED_NOTE=""
  if [ "${#REVERTABLE[@]}" -gt 0 ]; then
    if git checkout -- "${REVERTABLE[@]}" 2>/dev/null; then
      REVERTED_NOTE="$(printf '%s ' "${REVERTABLE[@]}")"
      REVERTED_NOTE="${REVERTED_NOTE% }"
    else
      REVERT_OK=0
    fi
  fi

  # Recompute what is still dirty after the (attempted) revert. Whatever remains
  # is either operator dirt from before promote, a non-pkg/lock stray, or a
  # revert that failed — all of which warrant the loud warning, not a success line.
  REMAINING_DIRTY="$(git diff --name-only 2>/dev/null || true)"

  if [ "${REVERT_OK}" = "1" ] && [ -z "${REMAINING_DIRTY}" ] && [ -n "${REVERTED_NOTE}" ]; then
    echo "SR-7.5 (post-verify snapshot): reverted promote-induced dirt in ${REVERTED_NOTE} (transitive-dep range drift from the post-publish 'bun install -g'). These files are owned by the prepare-phase commit; promote must leave the working tree clean."
  else
    echo "SR-7.5 (post-verify snapshot): WARNING — the working tree is still dirty after a completed release:" >&2
    printf '%s\n' "${REMAINING_DIRTY}" | sed 's/^/  /' >&2
    if [ "${REVERT_OK}" != "1" ]; then
      echo "(A 'git checkout -- ${REVERTED_NOTE:-package.json bun.lock}' to discard promote-induced dirt FAILED — the files above were NOT reverted.)" >&2
    fi
    if [ "${START_PKG_JSON_DIRTY}" = "1" ] || [ "${START_BUN_LOCK_DIRTY}" = "1" ]; then
      echo "(NOTE: package.json and/or bun.lock were already dirty BEFORE promote ran, so they were left untouched — that pre-existing operator dirt is deliberate and load-bearing; promote will not discard it.)" >&2
    fi
    echo "The release IS fully delivered (v${NEXT_VERSION} is on npm + tag on origin + verified locally); this is NOT a release failure, so the script does not exit non-zero here. Operator recovery: inspect these changes with 'git status' / 'git diff' and decide whether they are load-bearing (commit them) or stray promote side-effects (discard). Do NOT rerun /publish promote." >&2
  fi
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
rm -f "${MANIFEST}" || true

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
