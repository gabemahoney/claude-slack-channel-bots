---
name: publish
description: Build, verify, and publish claude-slack-channel-bots to npm
user-invocable: true
argument-hint: "patch|minor|major"
allowed-tools: [Bash, Read, Skill]
---

# /publish

Cut a release of `claude-slack-channel-bots` end-to-end: preflight gates, version bump, smoke test of the release artifact, publish, and dev-box reinstall.

This document is structured so each phase has its own section. Phases beyond preflight are placeholders at this point in the build-out — they will be filled in by subsequent Epics. The skill is runnable end-to-end today; on a release-ready repo it currently exits after preflight with `preflight complete; further phases pending`.

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

## Terminal exit

Once SR-2.5 reports PASS, preflight is complete. The release-cutting phases (Bump, Smoke Test, Release, Local Sync, Summary) are not yet implemented in this Epic. Print exactly:

```
preflight complete; further phases pending
```

and exit zero. No version bump, commit, tag, tarball, or scratch directory is created at this point.

## Bump

After preflight passes, apply the bump to `package.json` using `npm version`. The semver rules match `npm version` itself: `major` increments the major segment and zeroes minor and patch; `minor` increments minor and zeroes patch; `patch` increments patch.

`--no-git-tag-version` skips commit and tag creation — the bumped `package.json` is intentionally left in the working tree (uncommitted) so the smoke test below can pack and verify it. `bun.lock` does not track the root package's own version, so it is normally unaffected by a bump; the spec still allows for it to change if a future bun version starts tracking it.

```bash
if ! npm version "${BUMP_KIND}" --no-git-tag-version > /dev/null; then
  echo "bump failed: npm version ${BUMP_KIND} did not apply" >&2
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
  exit 1
fi

TARBALL="claude-slack-channel-bots-${NEXT_VERSION}.tgz"
if [ ! -f "${TARBALL}" ]; then
  echo "pack failed: expected tarball ${TARBALL} not found" >&2
  exit 1
fi

TARBALL_VERSION="$(tar -xzOf "${TARBALL}" package/package.json | jq -r .version)"
if [ "${TARBALL_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "pack failed: tarball internal version '${TARBALL_VERSION}' != bumped ${NEXT_VERSION}" >&2
  exit 1
fi
```

## Release

Placeholder — populated by Epic 3.

## Local Sync

Placeholder — populated by Epic 4.

## Summary

Placeholder — populated by Epic 4.
