---
name: publish
description: Build, verify, and publish claude-slack-channel-bots to npm
user-invocable: true
argument-hint: "patch|minor|major"
allowed-tools: [Bash, Read, Skill]
---

# /publish

Cut a release of `claude-slack-channel-bots` end-to-end: preflight gates, version bump, smoke test of the release artifact, publish, and dev-box reinstall.

The skill is runnable end-to-end today; on a release-ready repo it currently bumps the version, packs the tarball, scratch-installs it, runs the bin smoke check, then rolls the bump back and exits with `smoke test passed; release phases pending`. The rollback-on-success is an intentional Epic 2 design: Epic 3 will replace it with the commit + push + publish step.

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

## Phase 3 — Bump, smoke test, and rollback (Epic 2 closure)

After Phase 1 + Phase 2 pass, apply the bump, pack the artifact, install it in an isolated `BUN_INSTALL` prefix, exercise the bin's no-args smoke signal, then **roll the bump back** and exit. The rollback-on-success is the Epic 2 architectural decision — Epic 3 will replace it with commit + push + publish.

This bash block re-derives `BUMP_KIND` and `NEXT_VERSION` (it runs in a fresh shell from Phase 1) and uses the same `cleanup` / `trap` pattern so its scratch dir and tarball are removed on every exit path.

Bin smoke check assumes the current `src/cli.ts` no-args behavior: non-zero exit + `Usage:` in stderr. If the CLI surface changes, this check must be revisited. The SRD documents this coupling.

The terminal exit string is exactly `smoke test passed; release phases pending`.

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

echo "smoke test passed; release phases pending"
exit 0
```

## Release

Placeholder — populated by Epic 3.

## Local Sync

Placeholder — populated by Epic 4.

## Summary

Placeholder — populated by Epic 4.
