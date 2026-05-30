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
3. `docker build -f docker/Dockerfile.test -t cscb-ci .`
4. `mkdir -p ${PWD}/test-results`
5. ```bash
   docker run --rm --name cscb-ci-${RUN_ID} \
     -v ${PWD}/test-results:/test-results \
     -v ${PWD}/<TARBALL>:/tmp/package.tgz:ro \
     --env ANTHROPIC_API_KEY \
     cscb-ci
   ```
6. Container exits when `/tests/runner.sh` exits.
7. Read first line of `${PWD}/test-results/verdict.txt`:
   - `PASS` → exit 0, report `✓ Integration tests passed.`
   - `FAIL: …` → relay the verdict line verbatim, exit 1.
   - File missing or first line is neither → exit 1 with
     `test container did not write verdict.txt` and include
     `docker logs cscb-ci-${RUN_ID}` tail in the report.
8. Cleanup: `docker rm cscb-ci-${RUN_ID} 2>/dev/null || true`

## Non-runnable conditions

- Docker is not running (`docker info` fails) — instruct operator to start
  Docker and re-run `/ci`.
- `ANTHROPIC_API_KEY` is not set in the environment — instruct operator to
  export it and re-run. The bot Claudes spawned by the daemon-under-test need
  it to authenticate.
- `npm pack` fails — instruct operator to run `npm install` and re-run `/ci`.
