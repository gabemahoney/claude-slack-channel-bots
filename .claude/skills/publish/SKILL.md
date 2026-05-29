---
name: publish
description: Build, verify, and publish claude-slack-channel-bots to npm
user-invocable: true
argument-hint: "patch|minor|major"
allowed-tools: [Bash, Read, Skill]
---

# /publish

Cut a release of `claude-slack-channel-bots` end-to-end: preflight gates, version bump, smoke test of the release artifact, publish, and dev-box reinstall.

On a release-ready repo, the skill bumps the version, packs the tarball, scratch-installs it, runs the bin smoke check, commits + tags `Release v<version>` locally, pushes the commit to `origin/main`, publishes the smoke-tested tarball to npm, pushes the tag, polls the registry until the new version is visible, then exits with `release complete; local sync pending`. Epic 4 will replace that terminal message with the dev-box reinstall + final summary.

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
    echo "Usage: /publish <patch|minor|major>" >&2
    exit 1
    ;;
esac

# SR-2.1 — repository state
if [ -n "$(git status --porcelain)" ]; then
  echo "preflight failed: working tree not clean" >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "${CURRENT_BRANCH}" != "main" ]; then
  echo "preflight failed: not on main (HEAD branch is '${CURRENT_BRANCH}')" >&2
  exit 1
fi

git fetch origin
LOCAL_SHA="$(git rev-parse main)"
REMOTE_SHA="$(git rev-parse origin/main)"
if [ "${LOCAL_SHA}" != "${REMOTE_SHA}" ]; then
  echo "preflight failed: local main is not exactly equal to origin/main" >&2
  exit 1
fi

# SR-2.2 — dependency consistency
if ! bun install --frozen-lockfile; then
  echo "preflight failed: frozen-lockfile install failed" >&2
  exit 1
fi

# SR-2.3 — test discovery and execution
TEST_FILES=$(find tests -name '*.test.ts' -type f 2>/dev/null | head -n 1)
if [ -z "${TEST_FILES}" ]; then
  echo "preflight failed: no *.test.ts files found under tests/" >&2
  exit 1
fi

if ! bun test; then
  echo "preflight failed: bun test did not pass" >&2
  exit 1
fi

if ! bun run typecheck; then
  echo "preflight failed: bun run typecheck did not pass" >&2
  exit 1
fi

# SR-2.4 — npm authentication and version availability
if ! npm whoami > /dev/null 2>&1; then
  echo "preflight failed: not authenticated to npm (run 'npm login')" >&2
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
  echo "preflight failed: claude-slack-channel-bots@${NEXT_VERSION} is already published" >&2
  exit 1
fi

echo "Phase 1 (local preflight) passed. Next version will be: ${NEXT_VERSION}"
```

## Phase 2 — Integration suite gate (SR-2.5, /ci)

Invoke the `/ci` skill via the **Skill tool** (not a bash subprocess). Require it to report PASS. Any other outcome — fail, error, or non-runnable — aborts. There is no opt-out flag.

If `/ci` cannot run, surface the same diagnostic `/ci` itself would have produced. The known non-runnable conditions are:

- Docker daemon not running.
- `ANTHROPIC_API_KEY` environment variable not set.
- bees MCP server not running.

In each case the skill aborts; the message identifies that `/ci` was the failing gate and includes the upstream diagnostic.

## Phase 3 — Bump, smoke test, release, verify

After Phase 1 + Phase 2 pass, this single bash block:

1. Applies the bump (SR-3.1), packs the tarball, scratch-installs it, and runs the bin smoke check (SR-4.1–SR-4.3). Any failure here triggers a working-tree rollback (`git checkout -- package.json bun.lock`) and abort — no commit, no push, no publish.
2. Commits `Release v<version>` staging exactly `package.json` and `bun.lock`, and creates an annotated tag `v<version>` (SR-5.1).
3. Pushes the commit to `origin/main` (SR-5.2). The tag is intentionally held back.
4. Publishes the smoke-tested tarball with `npm publish <tarball-path>` — NOT `bun publish`, which would repack from CWD (SR-5.3).
5. Pushes the tag to `origin` (SR-5.4), bringing github and npm into agreement.
6. Polls `npm view claude-slack-channel-bots@<version> version` every 5 seconds for up to 60 seconds until the registry surfaces the new version (SR-6.1), then exits with `release complete; local sync pending`.

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
  git checkout -- package.json bun.lock 2>/dev/null || true
}

# Re-derive BUMP_KIND and NEXT_VERSION from a fresh shell.
BUMP_KIND="<BUMP_KIND>"
case "${BUMP_KIND}" in
  patch|minor|major) ;;
  *)
    echo "Usage: /publish <patch|minor|major>" >&2
    exit 1
    ;;
esac

CURRENT_VERSION="$(node -p "require('./package.json').version")"
IFS='.' read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION}"
case "${BUMP_KIND}" in
  major) NEXT_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEXT_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  patch) NEXT_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
esac

# SR-3.1 — bump (no commit; npm version --no-git-tag-version)
if ! npm version "${BUMP_KIND}" --no-git-tag-version > /dev/null; then
  echo "bump failed: npm version ${BUMP_KIND} did not apply" >&2
  rollback_working_tree
  exit 1
fi

# SR-4.1 — pack tarball + verify internal version
rm -f claude-slack-channel-bots-*.tgz

if ! bun pm pack > /dev/null; then
  echo "pack failed: bun pm pack did not produce a tarball" >&2
  rollback_working_tree
  exit 1
fi

TARBALL="claude-slack-channel-bots-${NEXT_VERSION}.tgz"
if [ ! -f "${TARBALL}" ]; then
  echo "pack failed: expected tarball ${TARBALL} not found" >&2
  rollback_working_tree
  exit 1
fi

TARBALL_VERSION="$(tar -xzOf "${TARBALL}" package/package.json | jq -r .version)"
if [ "${TARBALL_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "pack failed: tarball internal version '${TARBALL_VERSION}' != bumped ${NEXT_VERSION}" >&2
  rollback_working_tree
  exit 1
fi

# SR-4.2 / SR-4.3 — scratch install + bin smoke check
SCRATCH_DIR="$(mktemp -d)"
TARBALL_ABS="$(pwd)/${TARBALL}"

if ! BUN_INSTALL="${SCRATCH_DIR}" bun install -g "${TARBALL_ABS}" > /dev/null 2>&1; then
  echo "scratch install failed: bun install -g ${TARBALL} did not succeed" >&2
  rollback_working_tree
  exit 1
fi

INSTALLED_PKG="${SCRATCH_DIR}/install/global/node_modules/claude-slack-channel-bots/package.json"
if [ ! -f "${INSTALLED_PKG}" ]; then
  echo "scratch install failed: installed package.json not found at ${INSTALLED_PKG}" >&2
  rollback_working_tree
  exit 1
fi

INSTALLED_VERSION="$(jq -r .version "${INSTALLED_PKG}")"
if [ "${INSTALLED_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "scratch install failed: installed version '${INSTALLED_VERSION}' != bumped ${NEXT_VERSION}" >&2
  rollback_working_tree
  exit 1
fi

INSTALLED_BIN="${SCRATCH_DIR}/bin/claude-slack-channel-bots"
if [ ! -x "${INSTALLED_BIN}" ]; then
  echo "smoke check failed: installed bin not found or not executable at ${INSTALLED_BIN}" >&2
  rollback_working_tree
  exit 1
fi

SMOKE_EXIT=0
SMOKE_STDERR="$("${INSTALLED_BIN}" 2>&1 >/dev/null)" || SMOKE_EXIT=$?

if [ "${SMOKE_EXIT}" = "0" ]; then
  echo "smoke check failed: bin exited zero with no arguments (expected non-zero)" >&2
  rollback_working_tree
  exit 1
fi

if ! grep -q "Usage:" <<< "${SMOKE_STDERR}"; then
  echo "smoke check failed: bin stderr did not contain 'Usage:'" >&2
  rollback_working_tree
  exit 1
fi

# SR-5.1 — release commit + annotated tag (no push yet)
if ! git add package.json bun.lock; then
  echo "release commit failed: git add package.json bun.lock did not succeed" >&2
  rollback_working_tree
  exit 1
fi

if ! git commit -m "Release v${NEXT_VERSION}" > /dev/null; then
  echo "release commit failed: git commit -m \"Release v${NEXT_VERSION}\" did not succeed" >&2
  rollback_working_tree
  exit 1
fi

if ! git tag -a "v${NEXT_VERSION}" -m "Release v${NEXT_VERSION}"; then
  echo "release tag failed: git tag -a v${NEXT_VERSION} did not succeed; release commit remains on disk (run 'git reset --hard HEAD~1' to revert)" >&2
  exit 1
fi

# SR-5.2 — push release commit to origin/main (tag is held back until after npm publish)
if ! git push origin main; then
  echo "git push origin main failed: release commit + tag remain on disk; resolve the push issue (auth, non-fast-forward, etc.) and either re-run 'git push origin main' followed by manual 'npm publish' + 'git push origin v${NEXT_VERSION}', or run 'git reset --hard HEAD~1 && git tag -d v${NEXT_VERSION}' to abandon and restart" >&2
  exit 1
fi

# SR-5.3 — publish the smoke-tested tarball to npm (explicit path; NOT 'bun publish' which repacks)
if ! npm publish "${TARBALL_ABS}"; then
  echo "npm publish failed: 'npm publish ${TARBALL_ABS}' did not succeed. State: release commit IS on origin/main; npm does NOT have v${NEXT_VERSION}; tag is NOT pushed. Recovery options: (a) fix the publish issue (e.g., 'npm login') and re-run 'npm publish ${TARBALL_ABS}' manually, then 'git push origin v${NEXT_VERSION}'; (b) revert the remote with 'git push origin +HEAD~1:main', delete the local tag 'git tag -d v${NEXT_VERSION}', then restart /publish" >&2
  TARBALL=""  # preserve tarball so the operator can re-run npm publish against it
  exit 1
fi

# SR-5.4 — push the version tag to origin (final write to the git remote; brings github + npm into agreement)
if ! git push origin "v${NEXT_VERSION}"; then
  echo "git push origin v${NEXT_VERSION} failed: npm HAS v${NEXT_VERSION} and origin HAS the release commit; only the tag is missing. Recovery: run 'git push origin v${NEXT_VERSION}' manually once the push issue is resolved" >&2
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
  echo "registry verification failed: claude-slack-channel-bots@${NEXT_VERSION} was not visible within 60s. The release succeeded (commit, publish, and tag all pushed) — this is a propagation verification failure only. Re-confirm with 'npm view claude-slack-channel-bots@${NEXT_VERSION} version'" >&2
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
  echo "post-publish install failed: 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' did not succeed. The dev box now has no install; re-run 'bun install -g claude-slack-channel-bots@${NEXT_VERSION}' manually to recover. Do NOT retry automatically." >&2
  exit 1
fi

# SR-7.4 — verify the install: bin resolves under the global install prefix, and installed version matches
INSTALLED_BIN_PATH="$(command -v claude-slack-channel-bots || true)"
if [ -z "${INSTALLED_BIN_PATH}" ]; then
  echo "post-publish verification failed: 'claude-slack-channel-bots' not found on PATH after install" >&2
  exit 1
fi

RESOLVED_BIN="$(readlink -f "${INSTALLED_BIN_PATH}")"
case "${RESOLVED_BIN}" in
  "${GLOBAL_DIR}"/*) ;;
  *)
    echo "post-publish verification failed: resolved bin '${RESOLVED_BIN}' is not under '${GLOBAL_DIR}/' (a worktree-pointing symlink farm would resolve outside this prefix and fail this check)" >&2
    exit 1
    ;;
esac

INSTALLED_PKG_JSON="${GLOBAL_DIR}/node_modules/claude-slack-channel-bots/package.json"
if [ ! -f "${INSTALLED_PKG_JSON}" ]; then
  echo "post-publish verification failed: installed package.json not found at ${INSTALLED_PKG_JSON}" >&2
  exit 1
fi

INSTALLED_VERSION="$(jq -r .version "${INSTALLED_PKG_JSON}")"
if [ "${INSTALLED_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "post-publish verification failed: installed version '${INSTALLED_VERSION}' != published ${NEXT_VERSION}" >&2
  exit 1
fi

echo "release complete; local sync pending"
exit 0
```

## Local Sync

Placeholder — populated by Epic 4.

## Summary

Placeholder — populated by Epic 4.
