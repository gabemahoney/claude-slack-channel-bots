---
name: ci
description: Run CSCB integration tests inside docker. Returns PASS or FAIL.
user-invocable: true
allowed-tools: [Bash]
---

# /ci

This suite never connects to Slack. The live Slack acceptance run against the
test workspace is `/ci-live` (`.claude/skills/ci-live/SKILL.md`).

## Procedure

1. `RUN_ID=$(date +%s)`
2. `npm pack` from repo root; capture tarball filename.
3. Lazy-build the base image, then build the top image:
   ```bash
   BASE_TAG=cscb-ci-base:v4  # bump when docker/Dockerfile.test.base or package.json's agent-director range changes
   if ! docker image inspect "${BASE_TAG}" >/dev/null 2>&1; then
     # The base layer fetches the agent-director Go binary from a private GitHub
     # release; supply a token at build time. Prefer the operator's gh CLI token.
     # The token goes in as the BuildKit secret gh_token, read from GH_TOKEN,
     # which is set only in this one command's environment. Never pass it with
     # --build-arg: a build-arg's value is recorded in the image history of the
     # base and of every image built on it, and the build log prints it.
     # --network=host: the base layer fetches bun and the agent-director binary
     # from GitHub; on some hosts the default docker bridge network intermittently
     # fails these fetches with SSL/timeout errors even when the host reaches the
     # same URLs fine. Host networking sidesteps that. It only affects this
     # one-time base build, so the blast radius is minimal.
     GH_TOKEN="$(GH_CONFIG_DIR=$HOME/.config/gh-personal gh auth token 2>/dev/null || gh auth token 2>/dev/null || echo "")" \
       docker build --network=host --secret id=gh_token,env=GH_TOKEN --progress=quiet \
       -f docker/Dockerfile.test.base -t "${BASE_TAG}" .
   fi
   docker build -f docker/Dockerfile.test -t cscb-ci .
   ```
   The base image holds source-independent layers (apt, bun, nodejs, cozempic,
   agent-director) and is built once per host. `docker/Dockerfile.test`'s
   `FROM` line pins the same tag — keep them in sync. The base installs
   agent-director (the npm package and the matching Go binary) at the range
   `package.json` declares, read at build time only: an existing base keeps
   the version it was built with, so a range change needs a tag bump too, or
   `/ci` keeps testing the old agent-director. See `docker/README.md` for the
   base-image bump procedure.

   The base build needs BuildKit (docker's default builder since 23.0; check
   with `docker buildx version`) for the `--secret` flag and the Dockerfile's
   secret mount. `--progress=quiet` hides the build's step output; if the base
   build fails, rerun the same command with `--progress=plain` in its place to
   see which step failed and why (the token is a secret mount, so it is never
   in that output). Never echo `GH_TOKEN` or print the build's environment.
4. `RESULTS_DIR=$(mktemp -d -t cscb-ci-${RUN_ID}-XXXXXX)` — outside the repo working tree so `/publish prepare`'s SR-2.1 cleanliness check stays happy. Respects `$TMPDIR`; falls back to `/tmp`.
5. ```bash
   docker run --rm --name cscb-ci-${RUN_ID} \
     -v ${RESULTS_DIR}:/test-results \
     -v ${PWD}/<TARBALL>:/tmp/package.tgz:ro \
     --env ANTHROPIC_API_KEY \
     --env ANTHROPIC_BASE_URL \
     --env ANTHROPIC_MODEL \
     cscb-ci
   ```
6. Container exits when `/tests/runner.sh` exits.
7. Read first line of `${RESULTS_DIR}/verdict.txt`:
   - `PASS` → exit 0, report `✓ Integration tests passed.`
   - `FAIL: …` → relay the verdict line verbatim, **and echo the path** `${RESULTS_DIR}` so the operator can inspect the verdict + docker logs after the fact. Exit 1.
   - File missing or first line is neither → exit 1 with
     `test container did not write verdict.txt` and include
     `docker logs cscb-ci-${RUN_ID}` tail in the report. Echo `${RESULTS_DIR}` path so the operator can inspect.
8. Cleanup: `docker rm cscb-ci-${RUN_ID} 2>/dev/null || true`. On `PASS`, also `rm -rf "${RESULTS_DIR}"`. On `FAIL` or missing-verdict, **leave `${RESULTS_DIR}` for operator inspection** — the operator removes it once they're done debugging.

## Non-runnable conditions

- Docker is not running (`docker info` fails) — instruct operator to start
  Docker and re-run `/ci`.
- `ANTHROPIC_API_KEY` is not set in the environment. The bot Claudes
  spawned by the daemon-under-test cannot use Claude Code's OAuth and need
  an API key. This can be either a raw `sk-ant-api…` key (which authenticates
  directly against `api.anthropic.com`) or a gateway credential (e.g. NVIDIA
  InferenceHub), in which case `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL`
  must also be set so the bot Claudes hit the gateway rather than
  `api.anthropic.com`. The `docker run` step passes all three through when
  present; when `ANTHROPIC_BASE_URL` is absent, Claude Code defaults to
  `api.anthropic.com`, preserving raw-key behavior. To find a raw key, read
  Claude Code's own stored key:
  ```bash
  export ANTHROPIC_API_KEY="$(jq -r .primaryApiKey ~/.claude.json)"
  ```
  If `primaryApiKey` is null/absent and no gateway credential is exported, the
  operator has not provisioned an API key — instruct them to do so before
  re-running `/ci`. When invoking `/ci` from a worker spawned via
  `agent-director`, pass the credential through on the spawn command — the
  worker session does not inherit the orchestrator's env — with
  `--extra-env ANTHROPIC_API_KEY="$KEY"`, and for a gateway credential also
  `--extra-env ANTHROPIC_BASE_URL="$BASE_URL" --extra-env ANTHROPIC_MODEL="$MODEL"`.
- `ANTHROPIC_API_KEY` is set to a gateway credential but `ANTHROPIC_BASE_URL`
  is unset. A key that does not start with `sk-ant-` (e.g. an NVIDIA
  InferenceHub credential) is not a raw Anthropic key and cannot authenticate
  against `api.anthropic.com`; without `ANTHROPIC_BASE_URL` the bot Claudes
  default to that host and fail mid-run with opaque 401s. This is non-runnable:
  instruct the operator to also export `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL`
  for the gateway (passing all three through on the `agent-director` spawn as
  above) before re-running `/ci`.
- `npm pack` fails — instruct operator to run `npm install` and re-run `/ci`.
