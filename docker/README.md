# CSCB docker test images

The `/ci` integration-test image is split into two stages so the slow,
source-independent layers (apt deps, bun, nodejs, cozempic, agent-director)
cache as a separate image and don't get invalidated on every CSCB source edit.

## Images

- **`cscb-ci-base:v1`** (built from `docker/Dockerfile.test.base`) — slow base
  layers. Built lazily once per host. ~1+ GB. No CSCB source inside.
- **`cscb-ci:latest`** (built from `docker/Dockerfile.test`, `FROM cscb-ci-base:v1`)
  — adds `docker/entrypoint.sh`, `tests/`, `testplans/`, the `testuser` account,
  and the `ENTRYPOINT`. Built on every `/ci` run; should complete in under 10 s
  on a warm base.

`/ci` detects whether `cscb-ci-base:v1` exists locally; if absent, it builds the
base first, then builds `cscb-ci`. The base build is a one-time per-host cost
per version tag.

## When to bump the base image version

Bump `cscb-ci-base`'s version tag (e.g. `v1` → `v2`) whenever you change
`docker/Dockerfile.test.base`. There is **no** automatic version derivation —
bump it manually in two places:

1. The `FROM` line in `docker/Dockerfile.test`.
2. The `BASE_TAG` variable in `.claude/skills/ci/SKILL.md`.

Common reasons to bump: bumping the bun installer, changing the nodejs major,
adding/removing an apt package, changing the cozempic install, or changing the
`agent-director` range in `package.json` (the base reads it at build time).

After bumping, the next `/ci` on every host will rebuild the base.

## Verifying the cold-cache path

To simulate a fresh host:

```bash
docker rmi cscb-ci-base:v1 cscb-ci:latest 2>/dev/null
/ci   # or invoke the build sequence from the skill manually
```

The first build should take minutes (apt + bun + nodejs + pip + bun-add). Time
it; if it exceeds the Claude Code Bash tool's 10-minute timeout, raise an
issue.

## Verifying warm-cache parity

After a `/ci` run, confirm the base layers are intact:

```bash
docker history cscb-ci-base:v1
```

Then edit a comment in (e.g.) `tests/integration/test-1-install-startup.sh`
and re-run the build:

```bash
docker build -f docker/Dockerfile.test -t cscb-ci .
```

This should complete in seconds. `docker history cscb-ci-base:v1` should show
the same layer IDs as before — proof the source edit didn't invalidate the
base.

## Out of scope (future work)

Publishing `cscb-ci-base` to a registry (GHCR or similar) so fresh hosts pull
instead of build — tracked under DR-3 of b.nfg.
