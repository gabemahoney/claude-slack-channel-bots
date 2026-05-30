# Integration tests

Bash integration tests for `claude-slack-channel-bots`, run inside the
`cscb-ci` Docker image by `/ci`.

## Layout

```
tests/
  integration/
    test-1-install-startup.sh      # b.j9i — install package, start daemon dry-run, verify
    test-2-dryrun-spawn-skip.sh    # b.3hy — startupSessionManager + dry-run skip
    test-3-cozempic-restart.sh     # b.set — cozempic probe + clean stop/restart
  runner.sh                        # sequential runner, writes /test-results/verdict.txt
  README.md
```

The canonical specification of each test (Setup + Verify + Pass criteria) lives
in `testplans/b.{j9i,3hy,set}/*.md`. The bash scripts under `integration/` are
deterministic transcriptions. If you change the testplan, update the script;
if you change the script, update the testplan.

## Execution model

`docker/entrypoint.sh` invokes `tests/runner.sh` as `testuser`. The runner runs
each script in dependency order in the same container, so daemon state written
by Test 1 (PID file, server log) is consumed by Tests 2 and 3. The runner
short-circuits on the first failure — subsequent tests are not run.

## Verdict file format

`tests/runner.sh` writes exactly one line to `/test-results/verdict.txt`:

- `PASS` — every test exited 0.
- `FAIL: <test-script>: <description>` — first failed test's first `FAIL:` line.

`/ci` reads only the first line of this file. It is not JSON, has no
decoration, and never contains embedded newlines. Multi-line diagnostics go to
stdout/stderr where `docker logs` can capture them — never into `verdict.txt`.

## Adding a new test

1. Write the testplan ticket in `testplans/` (the source of truth — describes
   what is being tested and why, in human prose).
2. Add `tests/integration/test-N-<short-name>.sh`. Required shape:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   TEST_NAME="test-N-<short-name>"
   fail() { echo "FAIL: ${TEST_NAME}: $1" >&2; exit 1; }
   # ... setup + assertions ...
   echo "PASS: ${TEST_NAME}"
   ```
   Every pass criterion must be an explicit bash assertion that exits non-zero
   on failure with a `FAIL: <test-name>: <step>` line to stderr.
3. Append the script filename to the `TESTS=(...)` array in `tests/runner.sh`,
   in the dependency order it expects.
4. Run `shellcheck tests/integration/*.sh tests/runner.sh`. The suite must
   stay warning-free.

## What does NOT belong in a test script

- Anything requiring LLM judgment ("did this response look reasonable").
- Pane scraping, tmux capture, JSONL transcript parsing.
- Retries, fix-it-yourself logic, or self-healing. A test is a strict assertion.

## Escape hatch: tests that genuinely need LLM judgment

If a future test cannot be expressed as a deterministic bash assertion (e.g.
"did the bot's reply on Slack actually answer the question"), do NOT
reintroduce an in-container orchestrator Claude. Instead:

1. Have the in-container bash test write the artifact to inspect (a transcript,
   a generated file) under `/test-results/`.
2. Let the test exit `PASS` after the artifact is produced.
3. In `.claude/skills/ci/SKILL.md`, after the container exits and the verdict
   is read, add a host-side step that shells out to `claude -p "<judgment
   prompt referencing the artifact>"` and parses its single-line reply.

The container stays a deterministic bash harness; LLM judgment runs on the
host, once, with no tmux, no orchestrator session, and no permission prompts.
