# Tests

`claude-slack-channel-bots` has three kinds of tests:

| Kind | Where | Run by |
|---|---|---|
| Unit suite | `tests/*.test.ts`, `tests/integration/session-leader.test.ts` | `bun test`, on a dev box |
| Docker integration suite | `tests/integration/test-*.sh`, `tests/runner.sh`, `docker/` | `/ci`, inside the `cscb-ci` image |
| Live acceptance plan | `testplans/b.yko/b.yko.md` | an operator, by hand, on a test host and test Slack workspace |

Conventions for unit tests are in `docs/testing-guide.md`; this file covers how
to run each kind safely and how the integration suite is laid out.

## Running the unit suite

Run `bun test` with a scratch HOME and state directory, and with the token
environment variables and `CSCB_PERSONA` unset, so nothing can fall back to the
real config or credentials:

```sh
S=$(mktemp -d) && env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u CSCB_PERSONA \
  HOME=$S SLACK_STATE_DIR=$S/state bun test <files>
```

Omit `<files>` to run the whole suite. The tests build their own temp homes
and fake credentials (see Isolation in `docs/testing-guide.md`); the scratch
environment is a second guard, so a regression that reaches for the home
directory lands in `$S` and never in the real `~/.claude/channels/slack/`.
`bun test` does not run the bash scripts under `tests/integration/`.

## Docker integration suite

Bash scripts that install the packed package, write a dry-run persona config
and start the server. `/ci` packs the package, builds the image from
`docker/Dockerfile.test` (on the base in `docker/Dockerfile.test.base`, see
`docker/README.md`) and runs `tests/runner.sh` inside it. The verdict is
`PASS` or `FAIL`.

The scripts run only in that container, never on a dev box or a host with a
real CSCB install: they write to `~/.claude/channels/slack/`, start a server
and spawn instances. If docker is not available, report the integration run
as not done rather than running a script directly.

### Layout

```
tests/
  integration/
    test-1-install-startup.sh      # b.j9i: install the package; a pre-persona config fails start; the persona config starts in dry run
    test-2-dryrun-spawn-skip.sh    # b.3hy: persona load line, per-persona dry-run spawn skip, /interject 404 and 503
    test-3-cozempic-restart.sh     # b.set: cozempic probe, stop --stop-bots per persona, clean restart
    test-4-resume-dialog.sh        # no ticket: non-dry-run spawn, then resume past the dev-channels dialog (b.vub)
    fixtures/
      driver.ts                    # Test 4 driver: builds a one-persona config, calls spawnForPersona directly
      stub-claude.sh               # Test 4 fake `claude`: prints the dev-channels dialog, fires SessionStart
    session-leader.test.ts         # bun test, not run by runner.sh
  runner.sh                        # sequential runner, writes /test-results/verdict.txt
  README.md
docker/
  Dockerfile.test.base             # source-independent base image (see docker/README.md)
  Dockerfile.test                  # top image: the tests and the packed package
  entrypoint.sh                    # sets up testuser's Claude config, then runs tests/runner.sh
```

The `TESTS=(...)` array in `tests/runner.sh` is the list of scripts the suite
runs, in order. New scenario scripts are added there; this layout shows the
suite's shape, not a fixed list.

### Testplan tickets

`testplans/b.en1` is the suite's umbrella ticket. A script with a testplan
ticket names it in its header comment; the ticket holds the canonical
specification (Setup, Verify, Pass criteria) and the script is its
deterministic transcription. If you change the testplan, update the script; if
you change the script, update the testplan. Today that is Tests 1 to 3
(`testplans/b.j9i`, `b.3hy`, `b.set`).

A script with no ticket is specified by its header comment, and by its
driver's where it has one (Test 4 and `fixtures/driver.ts`).
`testplans/b.efu` is a separate resume scenario for `/release-test`, not one of
these scripts. `testplans/b.yko` is the manual live acceptance plan and has no
script (see Live acceptance plan below).

### Persona dry-run configs

Every script runs against a persona config written inside the container, never
a config or credentials file from the host:

- Every `start` runs with `SLACK_DRY_RUN=1` and with the token environment
  variables unset. Dry run reads no credentials file, so the credentials files
  the config names are never created, and it skips each persona's spawn with a
  persona-keyed log line (`dry-run: skipping spawn for "<name>" (key=<key>)`).
- Instances are persona-keyed (`cscb_<key>`); `stop --stop-bots` names each
  persona it tears down.
- Tests 1 to 3 share one config, written by Test 1 to
  `~/.claude/channels/slack/config.json`: `alpha` (two channels, both
  `delivery: all`, prompts to the first) and `bravo` (no channels, DMs on,
  prompts to `dm`). Test 2 checks the loaded persona count and the
  per-persona spawn skips against it.
- A leg that needs a different config writes it to its own temp
  `SLACK_STATE_DIR`, so the shared config stays as later scripts expect. Test 1
  does this to check that a pre-persona config stops `start` with the
  conversion error.
- Test 4 runs without dry run but opens no Slack connection: its driver builds
  a one-persona config in memory and spawns under a stub `claude`.

### Execution model

`docker/entrypoint.sh` runs `tests/runner.sh` as `testuser`. The runner runs
the scripts in array order in one container, so state one script leaves (the
installed package, the running daemon, its PID file and server log) is
consumed by the scripts after it: Test 1 installs the package and starts the
daemon, Tests 2 and 3 use that daemon, Test 4 uses the installed package. The
runner stops at the first failure and runs nothing after it.

### Verdict file format

`tests/runner.sh` writes exactly one line to `/test-results/verdict.txt`:

- `PASS` — every test exited 0.
- `FAIL: <test-script>: <description>` — first failed test's first `FAIL:` line.

`/ci` reads only the first line of this file. It is not JSON, has no
decoration, and never contains embedded newlines. Multi-line diagnostics go to
stdout/stderr where `docker logs` can capture them — never into `verdict.txt`.

### Adding a new test

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

### What does NOT belong in a test script

- Anything requiring LLM judgment ("did this response look reasonable").
- Pane scraping, tmux capture, JSONL transcript parsing.
- Retries, fix-it-yourself logic, or self-healing. A test is a strict assertion.

### Escape hatch: tests that genuinely need LLM judgment

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

## Live acceptance plan

`testplans/b.yko/b.yko.md` ("Live acceptance: multi-persona CSCB on a test
workspace") is the manual acceptance run for personas. It is not part of
either suite above:

- **Manual, never in CI.** An operator runs it by hand. Neither `/ci` nor
  `/release-test` runs it: `/release-test` selects only `testplans` tickets
  whose title starts with "Test ", and this title deliberately does not. Keep
  it that way.
- **Test host and test workspace only.** It runs on a test host against a test
  Slack workspace with three persona apps, never in docker and never on the
  production install.
- **One ordered run.** A single setup, done only from the README, the setup
  wizard and `config.json`, then numbered checks in a fixed order (one
  crash-and-recover cycle, one reboot, a closing secrecy check) and a final
  teardown. Ordering constraints are expressed by position, so a new check
  goes where its prerequisites hold, not at the end.
- **AC coverage table.** The table at the top maps every live-verified
  acceptance criterion, and the extra live evidence, to the check and step
  that verifies it. A change that adds, moves or renumbers a check updates the
  table in the same edit.
- **No script.** The transcription rule above doesn't apply: the plan has no
  integration-script counterpart, and it must not be turned into one. A
  behaviour the docker suite can check in dry run belongs in a script there
  instead.
