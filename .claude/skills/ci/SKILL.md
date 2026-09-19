---
name: ci
description: Run CSCB integration tests inside docker. Returns PASS or FAIL.
user-invocable: true
allowed-tools: [Bash]
---

# /ci

## Procedure

1. `RUN_ID=$(date +%s)`
2. `npm pack` from repo root; capture tarball filename.
3. Lazy-build the base image, then build the top image:
   ```bash
   BASE_TAG=cscb-ci-base:v3  # bump when docker/Dockerfile.test.base changes
   if ! docker image inspect "${BASE_TAG}" >/dev/null 2>&1; then
     # The base layer fetches the agent-director Go binary from a private GitHub
     # release; supply a token at build time. Prefer the operator's gh CLI token.
     # --network=host: the base layer fetches bun and the agent-director binary
     # from GitHub; on some hosts the default docker bridge network intermittently
     # fails these fetches with SSL/timeout errors even when the host reaches the
     # same URLs fine. Host networking sidesteps that. It only affects this
     # one-time base build, so the blast radius is minimal.
     docker build --network=host -f docker/Dockerfile.test.base \
       --build-arg GH_TOKEN="$(GH_CONFIG_DIR=$HOME/.config/gh-personal gh auth token 2>/dev/null || gh auth token 2>/dev/null || echo "")" \
       -t "${BASE_TAG}" .
   fi
   docker build -f docker/Dockerfile.test -t cscb-ci .
   ```
   The base image holds source-independent layers (apt, bun, nodejs, cozempic,
   agent-director) and is built once per host. `docker/Dockerfile.test`'s
   `FROM` line pins the same tag — keep them in sync. See `docker/README.md`
   for the base-image bump procedure.
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
- `npm pack` fails — instruct operator to run `npm install` and re-run `/ci`.
