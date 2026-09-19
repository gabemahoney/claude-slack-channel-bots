# CSCB docker test images

The `/ci` integration-test image is split into two stages so the slow,
source-independent layers (apt deps, bun, nodejs, cozempic, agent-director)
cache as a separate image and don't get invalidated on every CSCB source edit.

## Images

- **`cscb-ci-base:v3`** (built from `docker/Dockerfile.test.base`) — slow base
  layers (apt deps incl. tmux, bun, nodejs, cozempic, agent-director). Built
  lazily once per host. ~1+ GB. No CSCB source inside.
- **`cscb-ci:latest`** (built from `docker/Dockerfile.test`, `FROM cscb-ci-base:v3`)
  — adds `docker/entrypoint.sh`, `tests/`, `testplans/`, the `testuser` account,
  and the `ENTRYPOINT`. Built on every `/ci` run; should complete in under 10 s
  on a warm base.

`/ci` detects whether `cscb-ci-base:v3` exists locally; if absent, it builds the
base first, then builds `cscb-ci`. The base build is a one-time per-host cost
per version tag.

The base build fetches bun and the agent-director binary from GitHub, and `/ci`
runs it with `docker build --network=host`. On some hosts the default docker
bridge network intermittently fails those fetches with SSL/timeout errors even
when the host itself reaches the same URLs fine; host networking sidesteps that.
It affects only the one-time base build, so the blast radius is minimal. If you
invoke the base build by hand (e.g. the cold-cache path below), pass
`--network=host` too if you hit a fetch failure.

## Credential env vars passed to the container

`/ci`'s `docker run` step forwards `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and
`ANTHROPIC_MODEL` from the host environment (each via the no-value `--env VAR`
pass-through form). The bot Claudes spawned by the daemon-under-test consume
these. A raw `sk-ant-api…` key needs only `ANTHROPIC_API_KEY` — Claude Code
defaults to `api.anthropic.com` when `ANTHROPIC_BASE_URL` is absent. A gateway
credential (e.g. NVIDIA InferenceHub) additionally requires `ANTHROPIC_BASE_URL`
and `ANTHROPIC_MODEL` so the bot Claudes hit the gateway rather than
`api.anthropic.com`; if only the key were forwarded, the gateway key would 401
against Anthropic's direct endpoint.

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
docker rmi cscb-ci-base:v3 cscb-ci:latest 2>/dev/null
/ci   # or invoke the build sequence from the skill manually
```

The first build should take minutes (apt + bun + nodejs + pip + bun-add). Time
it; if it exceeds the Claude Code Bash tool's 10-minute timeout, raise an
issue.

## Verifying warm-cache parity

After a `/ci` run, confirm the base layers are intact:

```bash
docker history cscb-ci-base:v3
```

Then edit a comment in (e.g.) `tests/integration/test-1-install-startup.sh`
and re-run the build:

```bash
docker build -f docker/Dockerfile.test -t cscb-ci .
```

This should complete in seconds. `docker history cscb-ci-base:v3` should show
the same layer IDs as before — proof the source edit didn't invalidate the
base.

## Out of scope (future work)

Publishing `cscb-ci-base` to a registry (GHCR or similar) so fresh hosts pull
instead of build — tracked under DR-3 of b.nfg.
