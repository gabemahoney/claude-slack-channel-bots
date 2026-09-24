# Integration tests

Bash integration tests for `claude-slack-channel-bots`, run inside the
`cscb-ci` Docker image by `/ci`.

## Layout

```
tests/
  integration/
    test-1-install-startup.sh      # b.j9i — install package; a routes config fails start; persona config starts dry-run
    test-2-dryrun-spawn-skip.sh    # b.3hy — persona load line, per-persona dry-run spawn skip, /interject 404/503
    test-3-cozempic-restart.sh     # b.set — cozempic probe, stop --stop-bots, clean restart
    test-4-resume-dialog.sh        # no ticket — non-dry-run spawn → resume past the dev-channels dialog (b.vub)
    fixtures/
      driver.ts                    # Test 4 driver: builds a one-persona config, calls spawnForPersona directly
      stub-claude.sh               # Test 4 fake `claude`: prints the dev-channels dialog, fires SessionStart
    session-leader.test.ts         # bun test, not run by runner.sh
  runner.sh                        # sequential runner, writes /test-results/verdict.txt
  README.md
```

The canonical specification of Tests 1–3 (Setup + Verify + Pass criteria) lives
in `testplans/b.{j9i,3hy,set}/*.md`. The bash scripts under `integration/` are
deterministic transcriptions. If you change the testplan, update the script;
if you change the script, update the testplan. Test 4 has no testplan ticket:
its specification is the header comment of `test-4-resume-dialog.sh` and of
`fixtures/driver.ts`. `testplans/b.efu` is a separate resume scenario, not one
of these scripts.

## Test config

Tests 1–3 share one dry-run persona config, written by Test 1 to
`~/.claude/channels/slack/config.json` inside the container:

- `alpha` — channels `C0TEST1` and `C0TEST2`, both `delivery: all`, prompts to `C0TEST1`, working directory `/tmp/test-repo-a`.
- `bravo` — no channels, DMs on with contact `U0TEST1`, prompts to `dm`, working directory `/tmp/test-repo-b`.

Every `start` runs with `SLACK_DRY_RUN=1` and with `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN` unset. Dry run reads no credentials file, so the credentials
files the config names are never created. Test 1 also starts once against a
`routes` config in its own temp `SLACK_STATE_DIR` and expects the conversion
error. Test 4 runs without dry run but opens no Slack connection: its driver
builds the one-persona config `resume_test` (channel `C0RESUME1`, instance
`cscb_resume_test`) in memory.

## Execution model

`docker/entrypoint.sh` invokes `tests/runner.sh` as `testuser`. The runner runs
the scripts in order — Test 1, 2, 3, then 4 — in the same container, so daemon
state written by Test 1 (PID file, server log) is consumed by Tests 2 and 3,
and Test 4 uses the package Test 1 installed. The runner short-circuits on the
first failure — subsequent tests are not run.

The scripts run only in the docker CI container, never on a host with a real
CSCB install: they write to `~/.claude/channels/slack/` and start a server.

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
