---
name: publish
description: Build, verify, and publish claude-slack-channel-bots to npm
user-invocable: true
argument-hint: "patch|minor|major"
allowed-tools: [Bash, Read, Skill]
---

# /publish

Cut a release of `claude-slack-channel-bots` end-to-end: preflight gates, version bump, smoke test of the release artifact, publish, and dev-box reinstall.

This document is structured so each phase has its own section. Phases beyond smoke test are placeholders at this point in the build-out — they will be filled in by subsequent Epics. The skill is runnable end-to-end today; on a release-ready repo it currently bumps the version, packs the tarball, scratch-installs it, runs the bin smoke check, then rolls the bump back and exits with `smoke test passed; release phases pending`. The rollback-on-success is an intentional Epic 2 design: Epic 3 will replace it with the commit + push + publish step.

## Argument Parsing

The skill requires exactly one positional argument: `patch`, `minor`, or `major`. Argument parsing runs BEFORE any state inspection — no `git`, `bun`, or `npm` invocations on the invalid-input path.

Missing or invalid input prints a usage line listing the three accepted values and exits with no other action.

```bash
set -euo pipefail

SCRATCH_DIR=""
TARBALL=""
cleanup() {
  if [ -n "${SCRATCH_DIR}" ] && [ -d "${SCRATCH_DIR}" ]; then
    rm -rf "${SCRATCH_DIR}"
  fi
  if [ -n "${TARBALL}" ] && [ -f "${TARBALL}" ]; then
    rm -f "${TARBALL}"
  fi
}
trap cleanup EXIT

rollback_working_tree() {
  git checkout -- package.json bun.lock 2>/dev/null || true
}

BUMP_KIND="${1:-}"
case "${BUMP_KIND}" in
  patch|minor|major) ;;
  *)
    echo "Usage: /publish <patch|minor|major>" >&2
    exit 1
    ;;
esac
```

## Preflight

Preflight is a sequence of fail-fast gates. The first failing sub-check aborts the skill; nothing after it runs. Each failure must emit a distinct diagnostic line so the operator knows exactly which gate tripped.

### SR-2.1 — Repository state

Three sub-checks in this order:

1. Working tree is clean — `git status --porcelain` produces empty output (no modified, staged, or untracked files in CWD).
2. HEAD branch is `main`.
3. After `git fetch origin`, local `main` equals `origin/main` exactly. This is exact equality, not fast-forwardability or ancestry: a fast-forward-pending local main (behind) or a local main that is ahead of the remote is itself a failure.

```bash
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
```

### SR-2.2 — Dependency consistency

Verify `node_modules` matches `bun.lock` and that `bun.lock` is consistent with `package.json`. Plain `bun install` would silently rewrite `bun.lock` on drift; `--frozen-lockfile` makes drift an explicit failure.

```bash
if ! bun install --frozen-lockfile; then
  echo "preflight failed: frozen-lockfile install failed" >&2
  exit 1
fi
```

### SR-2.3 — Test discovery and execution

The "tests exist" check runs BEFORE invoking the runner — an empty test directory is its own failure mode with its own diagnostic. After that, `bun test` and `bun run typecheck` must each exit zero, in that order.

```bash
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
```

### SR-2.4 — npm authentication and version availability

Two sub-checks. First, the operator must be authenticated against the default npm registry (`npm whoami` exits zero). Second, compute the next version by applying the supplied bump kind to the current `package.json` version using semver rules consistent with `npm version`:

- `major` — increment the major segment; set minor and patch to `0`.
- `minor` — increment the minor segment; set patch to `0`.
- `patch` — increment the patch segment.

Then verify the next version is not already published: `npm view claude-slack-channel-bots@<next>` must return non-zero. Returning zero means npm already knows about that version, which is itself a failure.

```bash
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
```

### SR-2.5 — Integration suite via `/ci`

Invoke the `/ci` skill via the Skill tool (not as a bash subprocess) and require it to report PASS. Any other outcome — fail, error, or non-runnable — aborts. There is no opt-out flag.

If `/ci` cannot run, surface the same diagnostic `/ci` itself would have produced. The known non-runnable conditions are:

- Docker daemon not running.
- `ANTHROPIC_API_KEY` environment variable not set.
- bees MCP server not running.

In each case the skill aborts; the message identifies that `/ci` was the failing gate and includes the upstream diagnostic so the operator can act on it without reading `/ci`'s source.

## Bump

After preflight passes, apply the bump to `package.json` using `npm version`. The semver rules match `npm version` itself: `major` increments the major segment and zeroes minor and patch; `minor` increments minor and zeroes patch; `patch` increments patch.

`--no-git-tag-version` skips commit and tag creation — the bumped `package.json` is intentionally left in the working tree (uncommitted) so the smoke test below can pack and verify it. `bun.lock` does not track the root package's own version, so it is normally unaffected by a bump; the spec still allows for it to change if a future bun version starts tracking it.

```bash
if ! npm version "${BUMP_KIND}" --no-git-tag-version > /dev/null; then
  echo "bump failed: npm version ${BUMP_KIND} did not apply" >&2
  rollback_working_tree
  exit 1
fi
```

## Smoke Test

After the bump lands, build the release artifact and exercise it in an isolated environment before any commit, push, or publish step runs. The phase has two parts: pack the tarball and verify its internal version (below), then scratch-install the tarball and smoke-check the bin (next subsection).

### SR-4.1 — Pack and verify internal version

Defensively remove any pre-existing `claude-slack-channel-bots-*.tgz` in CWD before packing. `*.tgz` is gitignored, so a leftover from a prior aborted run would not have surfaced in the preflight clean-tree check.

Pack with `bun pm pack`. The produced filename is `claude-slack-channel-bots-<bumped-version>.tgz`. Record it in `TARBALL` so the `EXIT` trap covers it on every exit path.

Verify the tarball's internal `package.json` `version` equals the bumped version. The path inside the tarball is `package/package.json` (the conventional npm-pack layout). A mismatch aborts with a named diagnostic; the `EXIT` trap removes the (possibly partial) tarball.

```bash
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
```

### SR-4.2/SR-4.3 — Scratch install and bin smoke check

Install the packed tarball into an isolated `BUN_INSTALL` prefix so the real global install at `~/.bun/install/global/` is not touched. Create the prefix via `mktemp -d` and record it in `SCRATCH_DIR` — the `EXIT` trap removes the directory on every exit path. The install command is run with `BUN_INSTALL` inlined for that single invocation; the environment of the surrounding skill is not modified.

After install, two assertions:

1. The installed `package.json`'s `version` equals the bumped version. Mismatch aborts with a named diagnostic.
2. The installed bin, invoked with no arguments, must exit non-zero AND print `Usage:` to stderr. This is the current `src/cli.ts` no-args behavior and is the smoke signal per SR-4.3. The check couples to that CLI surface: if the no-args output changes, this assertion must be revisited. The SRD documents this coupling as a known acceptable risk.

```bash
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
```

## Terminal exit

After the smoke check passes, the skill closes Epic 2 by rolling the bump back and printing the closure message. The rollback-on-success is the Epic 2 architectural decision: until Epic 3 adds commit + push + publish, every successful `/publish patch` (or `minor`/`major`) invocation must leave the working tree exactly as it was before invocation — no bump on disk, no commit, no tag, no leftover tarball, no leftover scratch directory.

The terminal message is exactly `smoke test passed; release phases pending`. The `EXIT` trap fires after this block returns and removes the tarball and scratch directory.

```bash
rollback_working_tree
echo "smoke test passed; release phases pending"
exit 0
```

## Release

Placeholder — populated by Epic 3.

## Local Sync

Placeholder — populated by Epic 4.

## Summary

Placeholder — populated by Epic 4.
