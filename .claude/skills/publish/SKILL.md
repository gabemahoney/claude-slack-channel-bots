---
name: publish
description: Build, verify, and publish claude-slack-channel-bots to npm
user-invocable: true
argument-hint: "patch|minor|major"
allowed-tools: [Bash, Read, Skill]
---

# /publish

Cut a release of `claude-slack-channel-bots` end-to-end: preflight gates, version bump, smoke test of the release artifact, publish, and dev-box reinstall.

On a release-ready repo, the skill bumps the version, packs the tarball, scratch-installs it, runs the bin smoke check, commits + tags `Release v<version>` locally, pushes the commit to `origin/main`, publishes the smoke-tested tarball to npm, pushes the tag, polls the registry until the new version is visible, sanitizes the bun-1.3.13 poison from the global package.json, removes any pre-existing global install, reinstalls the just-published version from npm (the exact command an end user runs), verifies the install resolves under the global prefix at the published version, and prints a success summary identifying the published version, npm URL, GitHub tag URL, local install path, and the `clean_restart` instruction for the operator.

## Structural note for the LLM running this skill

The bash is split into TWO blocks because the `/ci` integration suite is invoked via the Skill tool (not as bash), and it sits between cheap-local preflight and the bump/smoke phases. Each bash block is a separate Bash tool invocation — no variables persist between them. Each block is therefore self-contained and re-derives the bump kind and next version from the skill argument.

Replace `<BUMP_KIND>` in both bash blocks with the operator's argument (`patch`, `minor`, or `major`) before running. If the argument is missing or not one of those three, print the usage line below and exit without running anything.

```
Usage: /publish <patch|minor|major>
```

## Phase 1 — Argument validation and preflight (local)

Five fail-fast gates: SR-2.1 (clean tree, on `main`, exact equality with `origin/main`), SR-2.2 (frozen-lockfile install), SR-2.3 (at least one test file, `bun test` passes, `bun run typecheck` passes), SR-2.4 (`npm whoami` succeeds, next version is not already on npm).

```bash
set -euo pipefail

# Cleanup variables (extended by Phase 3 block below; empty here is a no-op trap)
SCRATCH_DIR=""
TARBALL=""
cleanup() {
  if [ -n "${SCRATCH_DIR}" ] && [ -d "${SCRATCH_DIR}" ]; then rm -rf "${SCRATCH_DIR}"; fi
  if [ -n "${TARBALL}" ] && [ -f "${TARBALL}" ]; then rm -f "${TARBALL}"; fi
}
trap cleanup EXIT

# Argument validation (no side effects on the invalid path)
BUMP_KIND="<BUMP_KIND>"
case "${BUMP_KIND}" in
  patch|minor|major) ;;
  *)
    echo "SR-1.2 (argument): missing or invalid bump kind '${BUMP_KIND}'. Rerun: /publish <patch|minor|major>" >&2
    exit 1
    ;;
esac

# SR-10.1 — operate from the repo root regardless of the invocation CWD.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "${REPO_ROOT}" ]; then
  echo "SR-10.1 (location): not inside a git working tree. Rerun '/publish ${BUMP_KIND}' from any directory inside a clone or worktree of claude-slack-channel-bots." >&2
  exit 1
fi
cd "${REPO_ROOT}"

# SR-2.1 — repository state
if [ -n "$(git status --porcelain)" ]; then
  echo "SR-2.1 (preflight): working tree not clean. Commit or stash your changes, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "${CURRENT_BRANCH}" != "main" ]; then
  echo "SR-2.1 (preflight): not on main (HEAD branch is '${CURRENT_BRANCH}'). Run 'git checkout main' (or invoke /publish from a worktree whose HEAD is main and in sync with origin/main), then rerun '/publish ${BUMP_KIND}'." >&2
  exit 1
fi

if ! git fetch origin; then
  echo "SR-2.1 (preflight): 'git fetch origin' failed (network down, auth problem, or remote unavailable). Verify the remote is reachable, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 1
fi
LOCAL_SHA="$(git rev-parse main)"
REMOTE_SHA="$(git rev-parse origin/main)"
if [ "${LOCAL_SHA}" != "${REMOTE_SHA}" ]; then
  echo "SR-2.1 (preflight): local main (${LOCAL_SHA}) is not exactly equal to origin/main (${REMOTE_SHA}). Run 'git pull --ff-only origin main' (or 'git push origin main' if you have unpushed local commits) until the two SHAs match, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 1
fi

# SR-2.2 — dependency consistency
if ! bun install --frozen-lockfile; then
  echo "SR-2.2 (preflight): 'bun install --frozen-lockfile' failed — bun.lock is out of sync with package.json. Run 'bun install' to regenerate the lockfile, commit the updated bun.lock to main, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 1
fi

# SR-2.3 — test discovery and execution
TEST_FILES=$(find tests -name '*.test.ts' -type f 2>/dev/null | head -n 1)
if [ -z "${TEST_FILES}" ]; then
  echo "SR-2.3 (preflight): no *.test.ts files found under tests/. Add at least one test file under tests/, commit it to main, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 1
fi

if ! bun test; then
  echo "SR-2.3 (preflight): 'bun test' did not pass. Fix the failing tests, commit to main, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 1
fi

if ! bun run typecheck; then
  echo "SR-2.3 (preflight): 'bun run typecheck' did not pass. Fix the type errors, commit to main, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 1
fi

# SR-2.4 — npm authentication and version availability
if ! npm whoami > /dev/null 2>&1; then
  echo "SR-2.4 (preflight): not authenticated to npm. Run 'npm login' as a claude-slack-channel-bots maintainer, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 1
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
  exit 1
fi

echo "Phase 1 (local preflight) passed. Next version will be: ${NEXT_VERSION}"
```

## Phase 2 — Integration suite gate (SR-2.5, /ci)

Invoke the `/ci` skill via the **Skill tool** (not a bash subprocess). Require it to report PASS. Any other outcome — fail, error, or non-runnable — aborts. There is no opt-out flag.

If `/ci` cannot run or does not return PASS, the skill aborts with a message of the form `SR-2.5 (/ci gate): <upstream diagnostic>. Resolve the /ci failure, then rerun '/publish <bump_kind>'.` — preserving the upstream `/ci` text so the operator does not need to consult the skill source. The known non-runnable conditions, all surfaced by `/ci` itself, are:

- Docker daemon not running. **Recovery**: start Docker, then rerun `/publish`.
- `ANTHROPIC_API_KEY` environment variable not set. **Recovery**: export the key, then rerun `/publish`.
- bees MCP server not running. **Recovery**: start the bees MCP server, then rerun `/publish`.

For a `/ci` run that returns FAIL or ERROR, the recovery is the standard one: fix the integration regression on `main` (commit + push), then rerun `/publish`.

## Phase 3 — Bump, smoke test, release, verify

After Phase 1 + Phase 2 pass, this single bash block:

1. Applies the bump (SR-3.1), packs the tarball, scratch-installs it, and runs the bin smoke check (SR-4.1–SR-4.3). Any failure here triggers a working-tree rollback (`git checkout -- package.json bun.lock`) and abort — no commit, no push, no publish.
2. Commits `Release v<version>` staging exactly `package.json` and `bun.lock`, and creates an annotated tag `v<version>` (SR-5.1).
3. Pushes the commit to `origin/main` (SR-5.2). The tag is intentionally held back.
4. Publishes the smoke-tested tarball with `npm publish <tarball-path>` — NOT `bun publish`, which would repack from CWD (SR-5.3).
5. Pushes the tag to `origin` (SR-5.4), bringing github and npm into agreement.
6. Polls `npm view claude-slack-channel-bots@<version> version` every 5 seconds for up to 60 seconds until the registry surfaces the new version (SR-6.1).
7. Sanitizes the bun-1.3.13 empty-string-dependency-key poison from `${BUN_INSTALL:-$HOME/.bun}/install/global/package.json` (SR-7.1), removes any pre-existing global install of `claude-slack-channel-bots` (SR-7.2), runs `bun install -g claude-slack-channel-bots@<version>` (SR-7.3), and verifies the bin resolves under the global prefix at the published version (SR-7.4).
8. Prints the success summary (SR-9.1) — published version, npm URL, GitHub tag URL, resolved local install path, `clean_restart` instruction — and exits zero.

The SR-5.1 → SR-5.4 ordering is load-bearing: if `npm publish` fails after the commit is pushed, the tag is NOT pushed, so the git remote and npm never disagree about whether the version exists.

This bash block re-derives `BUMP_KIND` and `NEXT_VERSION` (it runs in a fresh shell from Phase 1) and uses the same `cleanup` / `trap` pattern so its scratch dir and tarball are removed on every exit path. On `npm publish` failure, `TARBALL` is cleared before exit so the trap preserves the tarball for the operator's manual re-publish.

Bin smoke check assumes the current `src/cli.ts` no-args behavior: non-zero exit + `Usage:` in stderr. If the CLI surface changes, this check must be revisited. The SRD documents this coupling.

```bash
set -euo pipefail

# Cleanup wired before any state-mutating step
SCRATCH_DIR=""
TARBALL=""
cleanup() {
  if [ -n "${SCRATCH_DIR}" ] && [ -d "${SCRATCH_DIR}" ]; then rm -rf "${SCRATCH_DIR}"; fi
  if [ -n "${TARBALL}" ] && [ -f "${TARBALL}" ]; then rm -f "${TARBALL}"; fi
}
trap cleanup EXIT

rollback_working_tree() {
  # SR-3.2: restore package.json and bun.lock to HEAD state. If git checkout itself
  # errors (e.g. ref lookup failed), surface that — silently swallowing it would
  # leave the working tree in a half-bumped state with no diagnostic.
  if ! git checkout -- package.json bun.lock; then
    echo "SR-3.2 (rollback): 'git checkout -- package.json bun.lock' failed. Working tree may still contain the bumped version. Run 'git status' to inspect, then 'git checkout -- package.json bun.lock' manually." >&2
  fi
}

# Re-derive BUMP_KIND and NEXT_VERSION from a fresh shell.
BUMP_KIND="<BUMP_KIND>"
case "${BUMP_KIND}" in
  patch|minor|major) ;;
  *)
    echo "SR-1.2 (argument): missing or invalid bump kind '${BUMP_KIND}'. Rerun: /publish <patch|minor|major>" >&2
    exit 1
    ;;
esac

# SR-10.1 — operate from the repo root regardless of invocation CWD.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "${REPO_ROOT}" ]; then
  echo "SR-10.1 (location): not inside a git working tree. Rerun '/publish ${BUMP_KIND}' from any directory inside a clone or worktree of claude-slack-channel-bots." >&2
  exit 1
fi
cd "${REPO_ROOT}"

CURRENT_VERSION="$(node -p "require('./package.json').version")"
IFS='.' read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION}"
case "${BUMP_KIND}" in
  major) NEXT_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEXT_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  patch) NEXT_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
esac

# SR-3.1 — bump (no commit; npm version --no-git-tag-version)
if ! npm version "${BUMP_KIND}" --no-git-tag-version > /dev/null; then
  echo "SR-3.1 (bump): 'npm version ${BUMP_KIND} --no-git-tag-version' did not apply. Working tree has been rolled back (package.json + bun.lock restored). Investigate the npm error above, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

# SR-4.1 — pack tarball + verify internal version
rm -f claude-slack-channel-bots-*.tgz

if ! bun pm pack > /dev/null; then
  echo "SR-4.1 (pack): 'bun pm pack' did not produce a tarball. Working tree has been rolled back. Investigate the bun error above, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

TARBALL="claude-slack-channel-bots-${NEXT_VERSION}.tgz"
if [ ! -f "${TARBALL}" ]; then
  echo "SR-4.1 (pack): expected tarball '${TARBALL}' not found in CWD after 'bun pm pack'. Working tree has been rolled back. Inspect the CWD for stray *.tgz files, resolve the cause, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

TARBALL_VERSION="$(tar -xzOf "${TARBALL}" package/package.json | jq -r .version)"
if [ "${TARBALL_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "SR-4.1 (pack): tarball internal version '${TARBALL_VERSION}' != bumped ${NEXT_VERSION}. Working tree has been rolled back. This indicates a packing bug — investigate 'bun pm pack' output and package.json contents, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

# SR-4.2 / SR-4.3 — scratch install + bin smoke check
SCRATCH_DIR="$(mktemp -d)"
TARBALL_ABS="$(pwd)/${TARBALL}"

if ! BUN_INSTALL="${SCRATCH_DIR}" bun install -g "${TARBALL_ABS}" > /dev/null 2>&1; then
  echo "SR-4.2 (scratch install): 'bun install -g ${TARBALL}' into scratch BUN_INSTALL did not succeed. Working tree has been rolled back. Rerun the failing command manually to inspect the bun output, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

INSTALLED_PKG="${SCRATCH_DIR}/install/global/node_modules/claude-slack-channel-bots/package.json"
if [ ! -f "${INSTALLED_PKG}" ]; then
  echo "SR-4.2 (scratch install): installed package.json not found at ${INSTALLED_PKG}. Working tree has been rolled back. The tarball layout may be malformed — inspect the tarball with 'tar -tzf ${TARBALL_ABS}', then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

INSTALLED_VERSION="$(jq -r .version "${INSTALLED_PKG}")"
if [ "${INSTALLED_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "SR-4.2 (scratch install): installed version '${INSTALLED_VERSION}' != bumped ${NEXT_VERSION}. Working tree has been rolled back. This indicates a tarball/install inconsistency — investigate, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

INSTALLED_BIN="${SCRATCH_DIR}/bin/claude-slack-channel-bots"
if [ ! -x "${INSTALLED_BIN}" ]; then
  echo "SR-4.3 (smoke check): installed bin not found or not executable at ${INSTALLED_BIN}. Working tree has been rolled back. Inspect package.json's 'bin' field and the tarball contents, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

SMOKE_EXIT=0
SMOKE_STDERR="$("${INSTALLED_BIN}" 2>&1 >/dev/null)" || SMOKE_EXIT=$?

if [ "${SMOKE_EXIT}" = "0" ]; then
  echo "SR-4.3 (smoke check): bin exited zero with no arguments (expected non-zero). Working tree has been rolled back. The CLI's no-args behavior has changed — update src/cli.ts to exit non-zero on missing arguments (the smoke check assumes this contract; see the SRD), then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

if ! grep -q "Usage:" <<< "${SMOKE_STDERR}"; then
  echo "SR-4.3 (smoke check): bin stderr did not contain 'Usage:' (the smoke contract). Working tree has been rolled back. Update src/cli.ts to emit a 'Usage:' line on no-args (or update this skill to match the new CLI contract — see the SRD), then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

# SR-5.1 — release commit + annotated tag (no push yet)
if ! git add package.json bun.lock; then
  echo "SR-5.1 (release commit): 'git add package.json bun.lock' did not succeed. Working tree has been rolled back. Inspect git status, then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

if ! git commit -m "Release v${NEXT_VERSION}" > /dev/null; then
  echo "SR-5.1 (release commit): 'git commit -m \"Release v${NEXT_VERSION}\"' did not succeed. Working tree has been rolled back (nothing is committed). Inspect git status (a pre-commit hook may have failed), then rerun '/publish ${BUMP_KIND}'." >&2
  rollback_working_tree
  exit 1
fi

if ! git tag -a "v${NEXT_VERSION}" -m "Release v${NEXT_VERSION}"; then
  echo "SR-5.1 (release tag): 'git tag -a v${NEXT_VERSION}' did not succeed. State: the release commit IS on the local main branch but has NOT been pushed. Recovery: run 'git reset --hard HEAD~1' to revert the local release commit, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 1
fi

# SR-5.2 — push release commit to origin/main (tag is held back until after npm publish)
if ! git push origin main; then
  echo "SR-5.2 (push commit): 'git push origin main' failed. State: release commit + annotated tag exist locally; nothing has been pushed or published. Recovery: resolve the push failure (auth, non-fast-forward, etc.) and either (a) re-run 'git push origin main' followed by 'npm publish ${TARBALL_ABS}' and 'git push origin v${NEXT_VERSION}' manually, or (b) abandon and restart by running 'git reset --hard HEAD~1 && git tag -d v${NEXT_VERSION}' then rerun '/publish ${BUMP_KIND}'." >&2
  exit 1
fi

# SR-5.3 — publish the smoke-tested tarball to npm (explicit path; NOT 'bun publish' which repacks)
if ! npm publish "${TARBALL_ABS}"; then
  echo "SR-5.3 (npm publish): 'npm publish ${TARBALL_ABS}' did not succeed. State: release commit IS on origin/main; npm does NOT have v${NEXT_VERSION}; tag is NOT pushed. Recovery options: (a) fix the publish issue (e.g., 'npm login') and re-run 'npm publish ${TARBALL_ABS}' manually, then 'git push origin v${NEXT_VERSION}'; (b) revert the remote with 'git push origin +HEAD~1:main', delete the local tag 'git tag -d v${NEXT_VERSION}', then rerun '/publish ${BUMP_KIND}'. The smoke-tested tarball at ${TARBALL_ABS} has been preserved on disk for option (a)." >&2
  TARBALL=""  # preserve tarball so the operator can re-run npm publish against it
  exit 1
fi

# SR-5.4 — push the version tag to origin (final write to the git remote; brings github + npm into agreement)
if ! git push origin "v${NEXT_VERSION}"; then
  echo "SR-5.4 (push tag): 'git push origin v${NEXT_VERSION}' failed. State: npm HAS v${NEXT_VERSION} and origin/main HAS the release commit; only the git tag is missing. Recovery: resolve the push issue, then run 'git push origin v${NEXT_VERSION}' manually. Do NOT rerun /publish — the release is otherwise complete." >&2
  exit 1
fi

# SR-6.1 — poll npm registry until v${NEXT_VERSION} is visible (5s cadence, up to 12 attempts = 60s)
VERIFIED=0
for ATTEMPT in 1 2 3 4 5 6 7 8 9 10 11 12; do
  REGISTRY_VERSION="$(npm view "claude-slack-channel-bots@${NEXT_VERSION}" version 2>/dev/null | tr -d '[:space:]')"
  if [ "${REGISTRY_VERSION}" = "${NEXT_VERSION}" ]; then
    VERIFIED=1
    break
  fi
  sleep 5
done

if [ "${VERIFIED}" != "1" ]; then
  echo "SR-6.1 (registry verification): claude-slack-channel-bots@${NEXT_VERSION} was not visible within the 60-second polling window. The release succeeded (commit, publish, and tag all pushed) — this is a propagation-verification failure only, not a release failure. Recovery: re-confirm with 'npm view claude-slack-channel-bots@${NEXT_VERSION} version'. Once visible, proceed with 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually and then run 'claude-slack-channel-bots clean_restart' — do NOT rerun /publish." >&2
  exit 1
fi

# SR-7.1 — sanitize the bun-1.3.13 empty-string-dependency-key poison from the global package.json
# (mirror of scripts/install-local.sh; do not invent a new sanitizer)
GLOBAL_DIR="${BUN_INSTALL:-$HOME/.bun}/install/global"
GLOBAL_PKG="${GLOBAL_DIR}/package.json"
if [ -f "${GLOBAL_PKG}" ]; then
  GLOBAL_PKG="${GLOBAL_PKG}" PKG_NAME="claude-slack-channel-bots" bun -e '
    const fs = require("node:fs");
    const p = process.env.GLOBAL_PKG;
    const name = process.env.PKG_NAME;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const changed = [];
    if (j.dependencies) {
      if (Object.prototype.hasOwnProperty.call(j.dependencies, "")) {
        delete j.dependencies[""];
        changed.push("empty-string entry");
      }
      if (name && Object.prototype.hasOwnProperty.call(j.dependencies, name)) {
        delete j.dependencies[name];
        changed.push("pre-existing " + name + " entry");
      }
    }
    if (changed.length) {
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
      console.log("[publish] sanitized: " + changed.join(", ") + " in " + p);
    }
  '
fi

# SR-7.2 — remove any existing global install (tolerate non-zero exit; nothing may be installed).
# Then defensively rm the leftover node_modules entry to clean up dangling files or symlinks the
# remove step may not have cleared (e.g. a prior `install-local.sh` symlink farm).
bun remove -g claude-slack-channel-bots > /dev/null 2>&1 || true
rm -rf "${GLOBAL_DIR}/node_modules/claude-slack-channel-bots"

# SR-7.3 — install the just-published version from npm (the exact command an end user would run)
if ! bun install -g "claude-slack-channel-bots@${NEXT_VERSION}"; then
  echo "SR-7.3 (post-publish install): 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' did not succeed. State: the release IS published (v${NEXT_VERSION} is on npm, commit + tag are on origin) but the dev box has NO global install at this point. Recovery: re-run 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually until it succeeds, then run 'claude-slack-channel-bots clean_restart'. Do NOT rerun /publish." >&2
  exit 1
fi

# SR-7.4 — verify the install: bin resolves under the global install prefix, and installed version matches
INSTALLED_BIN_PATH="$(command -v claude-slack-channel-bots || true)"
if [ -z "${INSTALLED_BIN_PATH}" ]; then
  echo "SR-7.4 (post-publish verification): 'claude-slack-channel-bots' not found on PATH after install. State: the release IS published. Recovery: confirm '${GLOBAL_DIR}/bin' is on your PATH, then run 'claude-slack-channel-bots clean_restart' manually. Do NOT rerun /publish." >&2
  exit 1
fi

RESOLVED_BIN="$(readlink -f "${INSTALLED_BIN_PATH}")"
case "${RESOLVED_BIN}" in
  "${GLOBAL_DIR}"/*) ;;
  *)
    echo "SR-7.4 (post-publish verification): resolved bin '${RESOLVED_BIN}' is not under '${GLOBAL_DIR}/' — a worktree-pointing symlink farm would resolve outside this prefix and fail this check. State: the release IS published. Recovery: run 'bun remove -g claude-slack-channel-bots' followed by 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' to replace the symlink farm with a real-copy install, then run 'claude-slack-channel-bots clean_restart'. Do NOT rerun /publish." >&2
    exit 1
    ;;
esac

INSTALLED_PKG_JSON="${GLOBAL_DIR}/node_modules/claude-slack-channel-bots/package.json"
if [ ! -f "${INSTALLED_PKG_JSON}" ]; then
  echo "SR-7.4 (post-publish verification): installed package.json not found at ${INSTALLED_PKG_JSON}. State: the release IS published but the global install layout is malformed. Recovery: run 'bun remove -g claude-slack-channel-bots' and then 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually. Do NOT rerun /publish." >&2
  exit 1
fi

INSTALLED_VERSION="$(jq -r .version "${INSTALLED_PKG_JSON}")"
if [ "${INSTALLED_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "SR-7.4 (post-publish verification): installed version '${INSTALLED_VERSION}' != published ${NEXT_VERSION}. State: the release IS published but the local install resolved to a stale version. Recovery: run 'bun remove -g claude-slack-channel-bots' followed by 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually until the installed version matches, then run 'claude-slack-channel-bots clean_restart'. Do NOT rerun /publish." >&2
  exit 1
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
```

## Local Sync

After registry verification, the same Phase 3 bash block resets the dev box to a clean real-copy install of the just-published version, so the operator's installed CSCB matches the published artifact byte-for-byte. The steps:

1. Sanitize `${BUN_INSTALL:-$HOME/.bun}/install/global/package.json` against the bun-1.3.13 empty-string-dependency-key poison. The sanitize logic mirrors `scripts/install-local.sh` (do not invent a separate sanitizer).
2. `bun remove -g claude-slack-channel-bots` (non-zero exit tolerated — nothing may have been installed) and a defensive `rm -rf` of the leftover `node_modules/claude-slack-channel-bots` entry to clear any residual files or symlinks from a prior real-copy install OR a prior `install-local.sh` symlink farm.
3. `bun install -g claude-slack-channel-bots@<version>` — the exact command an end user would run. No flags, no path tricks, no `--global` substitute. Failure aborts with explicit manual recovery instructions (`bun install -g claude-slack-channel-bots@<version>`); the skill does not retry automatically.
4. Verify the install: `command -v claude-slack-channel-bots` finds the bin, `readlink -f` resolves it under `${BUN_INSTALL:-$HOME/.bun}/install/global/`, and the installed `package.json` version equals `<version>`. `readlink -f` resolves all symlinks, so a worktree-pointing symlink farm would resolve outside the global prefix and fail the check — no separate worktree-pattern check is needed.

## Summary

On a fully successful run, the skill prints a final summary identifying the published version, the npm package URL, the GitHub release tag URL, the resolved local install path, and the explicit next-operator-action instruction `claude-slack-channel-bots clean_restart`. The summary printing is unconditional on success — every successful release ends with these five items shown. The skill exits zero immediately after printing.
