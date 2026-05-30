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
   BASE_TAG=cscb-ci-base:v1  # bump when docker/Dockerfile.test.base changes
   if ! docker image inspect "${BASE_TAG}" >/dev/null 2>&1; then
     docker build -f docker/Dockerfile.test.base -t "${BASE_TAG}" .
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
- `ANTHROPIC_API_KEY` is not set in the environment — instruct operator to
  export it and re-run. The bot Claudes spawned by the daemon-under-test need
  it to authenticate.
- `npm pack` fails — instruct operator to run `npm install` and re-run `/ci`.
