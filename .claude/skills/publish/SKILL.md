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

Placeholder — populated by later Subtasks in this Epic.

## Bump

Placeholder — populated by Epic 2.

## Smoke Test

Placeholder — populated by Epic 2.

## Release

Placeholder — populated by Epic 3.

## Local Sync

Placeholder — populated by Epic 4.

## Summary

Placeholder — populated by Epic 4.
