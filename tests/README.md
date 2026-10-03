# Tests

`claude-slack-channel-bots` has three kinds of tests:

| Kind | Where | Run by |
|---|---|---|
| Unit suite | `tests/*.test.ts`, `tests/integration/session-leader.test.ts` | `bun test`, on a dev box |
| Docker integration suite | `tests/integration/test-*.sh`, `tests/runner.sh`, `docker/` | `/ci`, inside the `cscb-ci` image |
| Live acceptance plan | `testplans/b.yko/b.yko.md` | an operator, by hand, on a test host and test Slack workspace; or `/ci-live` (`ci-live/`), in a throwaway container against the test workspace |

Conventions for unit tests are in `docs/testing-guide.md`; this file covers how
to run each kind safely and how the integration suite is laid out.

## Running the unit suite

Run `bun test` with a scratch HOME and state directory, and with the token
environment variables, `CSCB_PERSONA` and `CLAUDE_CONFIG_DIR` unset, so nothing
can fall back to the real config or credentials:

```sh
S=$(mktemp -d) && env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u CSCB_PERSONA \
  -u CLAUDE_CONFIG_DIR HOME=$S SLACK_STATE_DIR=$S/state bun test <files>; rm -rf "$S"
```

Omit `<files>` to run the whole suite. `bun test` does not run the bash
scripts under `tests/integration/`.

The `env … HOME=$S` prefix covers one command only. Give every `bun test`
its own prefix and scratch directory; a second `bun test` chained after the
first (`… bun test a; bun test b`) starts with your own HOME, and the guard
refuses it.

Run `bun test` only from a directory with a `bunfig.toml` that loads the
host-safety preload guard (`tests/test-helpers/host-safety-preload.ts`): the
repository root, `tests/` or `tests/integration/`. Bun reads only the
`bunfig.toml` in the directory `bun test` starts in (it does not search
upward). The repository root and every directory holding a `*.test.ts` file
have one, and `tests/host-safety.test.ts` fails when a directory of test files
lacks it. Started in a directory with no `bunfig.toml` (outside the
repository, or `src/`, say), the run has no guard. Bun resolves a relative
preload path against the directory the run starts in, so each file names the
guard relative to its own directory, with an entry starting `./`, `../` or
`/`. The guard is the first `[test]` preload entry in every file, so no other
preload runs before it.

The guard loads before any test file. It first checks the home the run was
launched with (see When the guard refuses to start, below). It then points
HOME and `SLACK_STATE_DIR` at a fresh temp directory, drops every PATH
directory that holds an `agent-director` binary and unsets `TMUX` and
`CLAUDE_CONFIG_DIR`. The rules tests follow on top of it are in
`docs/testing-guide.md`. The tests also build their own temp homes and fake
credentials (see Isolation in that guide).

Install a development tree's dependencies with lifecycle scripts disabled:

```sh
bun install --ignore-scripts
```

CSCB's own `postinstall` is for an operator's install: it links the
debugging skill into `~/.claude/skills/` under the real HOME and may write
skeleton files under `~/.claude/channels/slack/`. With scripts disabled,
`scripts/fixup-bun-cache.ts` (the other half of `postinstall`, which restores
files bun's extraction dropped from `node_modules/`) does not run either; run
`bun scripts/fixup-bun-cache.ts` by hand from the repo root when a dependency
is missing files.

### When the guard refuses to start

Bun fixes `os.homedir()` to the HOME `bun test` was launched with, and the
guard cannot change it. `src/` code that calls `homedir()` directly (the state
directory default, the Claude config directory, the default transcript root,
`~` expansion, the start gate's `state.db` path) resolves against that
launch-time home for the whole run. So the guard refuses to start when that
home could reach your real Claude, Slack or agent-director state. It prints
one line and exits with code 78, before any test file loads and before it
creates anything:

```text
host-safety preload: refusing to start: <reason> (launch-time home "<path>"). Start bun test with a scratch HOME and SLACK_STATE_DIR, as tests/README.md shows.
```

A failing test exits 1, so 78 always means the run never started. The reason
says what was wrong with the launch-time home. The guard checks the rules in
this order and reports the first that applies:

| Reason | The launch-time home |
|---|---|
| `launch-home-not-absolute` | is empty or a relative path |
| `launch-home-in-real-home` | is your home directory (your `/etc/passwd` entry) or lies under it, symlinks resolved |
| `launch-home-temp-dir-is-root` | with no `/etc/passwd` entry for your account, is checked against a temp directory (`TMPDIR`, else `/tmp`) that is `/`, symlinks resolved: every path lies under `/`, so the temp-directory rules below would accept any home |
| `launch-home-not-under-temp-dir` | with no `/etc/passwd` entry for your account, does not lie strictly under the temp directory (`TMPDIR`, else `/tmp`), symlinks resolved; the temp directory itself is refused |
| `launch-home-holds-slack-state` | has anything at `.claude/channels/slack` |
| `launch-home-derived-path-in-real-home` | has a path the code derives from the home (`.claude`, `.claude/channels/slack`, `.claude/projects`, `.claude/skills`, `.claude/slack-mcp.json`, `.agent-director` or a file under it) that leads into your home directory through a symlink, a dangling one included |
| `launch-home-derived-path-not-under-temp-dir` | with no `/etc/passwd` entry for your account, has one of those paths leading out of the temp directory |
| `launch-home-holds-agent-director` | has `.agent-director` or the standard agent-director install path |

The guard reads your home from the first `/etc/passwd` line whose user ID
field is exactly yours. "No `/etc/passwd` entry" covers a file it cannot
read, no line for your user ID, and a first line for it that is malformed
(fewer than seven fields, or an empty or relative home); a later line for the
same user ID is never used. The guard then cannot tell where your home is, so
it fails closed: the temp directory must not be `/`, and the launch-time home,
and every path the code derives from it, must lie strictly under it.

The temp-directory rules cannot tell your home from a scratch one when the
temp directory is another ancestor of your home (`TMPDIR=/home`, say). Your
home then passes them and is refused only when it holds Slack state or an
agent-director install. With no `/etc/passwd` entry, leave `TMPDIR` unset or
point it at a directory that holds no home.

To fix any of them, launch again with a new, empty scratch HOME, as the
command above shows. `mktemp -d` makes it under `TMPDIR` (else `/tmp`). When
`TMPDIR` lies under your home directory (or is a symlink into it), that HOME
is refused as `launch-home-in-real-home`: point `TMPDIR` at a directory
outside your home, or unset it to use `/tmp`, then launch again. Do the same
for `launch-home-temp-dir-is-root`, when `TMPDIR` resolves to `/`. Never reuse a
real or long-lived home, and never work around the guard. Started with a new
scratch HOME, every `homedir()` path lands in `$S`, never in the real
`~/.claude/`, `~/.claude/channels/slack/` or `~/.agent-director/`.

## Docker integration suite

Bash scripts that install the packed package, write a persona config and
start the server in dry run. Four scripts leave dry run: Test 4 runs its
driver, which spawns under a stub `claude` and starts no server, Tests 10
and 12 start a live server, against the loopback Slack stub, and Test 11
runs its driver against real tmux, starting no server.
`/ci` packs
the package, builds the image from `docker/Dockerfile.test` (on the base in
`docker/Dockerfile.test.base`, see `docker/README.md`) and runs `tests/runner.sh` inside it. The verdict is
`PASS` or `FAIL`.

The scripts run only in that container, never on a dev box or a host with a
real CSCB install: they write to `~/.claude/channels/slack/`, start a server
and spawn instances. If docker is not available, report the integration run
as not done rather than running a script directly.

A check that needs a real agent-director spawn belongs here, never in the
unit suite, which spawns no real Claude process: Test 12 checks the hook
paths a launched persona runs (b.cnu SR-8.2), which the unit suite could
only skip.

### Layout

```
tests/
  integration/
    test-1-install-startup.sh      # b.j9i: install the package; a pre-persona config fails start; the persona config starts in dry run
    test-2-dryrun-spawn-skip.sh    # b.3hy: persona load line, per-persona dry-run spawn skip, /interject 404 and 503
    test-3-cozempic-restart.sh     # b.set: cozempic probe, stop --stop-bots per persona, clean restart
    test-4-resume-dialog.sh        # no ticket: non-dry-run spawn, then resume past the dev-channels dialog (b.vub)
    test-5-two-personas.sh         # E3/E4, dry run: two personas (one with a derived key) each log their own persona-start and cwd; /interject by name and key
    test-6-missing-working-dir.sh  # E5 (SR-6.4), dry run: a missing working dir, and a dangling claude_config_dir symlink, hold a persona down with no repeated line; each comes up once its dir exists
    test-7-dm-settings.sh          # E6/E7 (SR-1.2, SR-1.5), dry run: DMs switch and `dm` prompt destinations load; six invalid DM settings refuse the start
    test-8-reload-confirm.sh       # E11/E12 (SR-8.3 to SR-8.5), dry run: an edit is previewed, applied only on confirmation; a stale confirmation applies nothing
    test-9-reload-destructive-and-server-wide.sh
                                   # E13 dry-run leg (SR-8.6): a working_directory change gives one DESTRUCTIVE: line and touches one persona; a port change waits for the restart
    test-10-credentials-change.sh  # E13 (SR-8.3, SR-8.6), live against the Slack stub: a credentials change reconnects one persona on confirmation; handshake failure and refused change; leak counts
    test-11-exact-tmux-targets.sh  # b.1ix: persona dev's raw tmux calls (probe, b.vub kill) touch slack_bot_dev only, never its prefix neighbour slack_bot_dev_2; its approver leg is stale (drives the removed raw approver path) and fails until retired
    test-12-bot-hook-absoluteness.sh
                                   # b.cnu SR-8.2, b.2qu, live against the Slack stub: every hook command of an agent-director-launched persona is an absolute path to an existing executable; agent-director's run the user's agent-director install, the reply guard runs the installed package's script
    lib/
      scenario.sh                  # shared helper sourced by Tests 5 onwards (see Scenario helper below)
    fixtures/
      driver.ts                    # Test 4 driver: builds a one-persona config, calls spawnForPersona directly
      exact-tmux-driver.ts         # Test 11 driver: runs one raw-tmux persona path against real tmux, with a stand-in agent-director
      stub-claude.sh               # fake `claude` (Tests 4, 10 and 12): prints the dev-channels dialog, fires SessionStart
      slack-stub-server.ts         # Tests 10 and 12 loopback Slack stub: Web API, apps.connections.open, Socket Mode WebSocket, JSONL record
    .shellcheckrc                  # lets shellcheck follow `source lib/scenario.sh` without -x
    session-leader.test.ts         # bun test, not run by runner.sh
  runner.sh                        # sequential runner (Tests 1-4, then discovery), writes /test-results/verdict.txt
  README.md
docker/
  Dockerfile.test.base             # source-independent base image (see docker/README.md)
  Dockerfile.test                  # top image: the tests and the packed package
  entrypoint.sh                    # sets up testuser's Claude config, then runs tests/runner.sh
```

`tests/runner.sh` runs Tests 1 to 4 first, in that order, then every other
`tests/integration/test-*.sh` it finds, in version order (`sort -V`, so
`test-5` runs before `test-10`). A new scenario script needs no runner edit;
this layout shows the suite's shape, not a fixed list.

### Testplan tickets

`testplans/b.en1` is the suite's umbrella ticket. A script with a testplan
ticket names it in its header comment; the ticket holds the canonical
specification (Setup, Verify, Pass criteria) and the script is its
deterministic transcription. If you change the testplan, update the script; if
you change the script, update the testplan. Today that is Tests 1 to 3
(`testplans/b.j9i`, `b.3hy`, `b.set`).

A script with no ticket is specified by its header comment, and by its
driver's where it has one (Test 4 and `fixtures/driver.ts`, Test 11 and
`fixtures/exact-tmux-driver.ts`). Tests 5 to 12
have no testplan ticket: each header comment lists what it checks, and the
log fragments it expects are taken from `src/` (the function that writes
each is named in the header or in a constants block near the top), so the
transcription rule does not apply to them.
`testplans/b.efu` is a separate resume scenario for `/release-test`, not one of
these scripts. `testplans/b.yko` is the manual live acceptance plan and has no
script (see Live acceptance plan below).

### Persona dry-run configs

Every script runs against a persona config written inside the container, never
a config or credentials file from the host:

- Every `start` but those of Tests 10 and 12 runs with `SLACK_DRY_RUN=1`, and every `start`
  runs with the token environment variables unset. Dry run reads no
  credentials file, so a dry-run script never creates the credentials files
  its config names, and it skips each persona's spawn with a persona-keyed
  log line (`dry-run: skipping spawn for "<name>" (key=<key>)`).
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
- Tests 5 to 10 and Test 12 each write their own config into their own
  scratch state dir (see Scenario helper), never the shared one. Tests 10 and
  12 are the scenarios outside dry run (see Slack stub).

### Execution model

`docker/entrypoint.sh` runs `tests/runner.sh` as `testuser`. The runner runs
the scripts in its order (see Layout) in one container, so state one script
leaves (the installed package, the running daemon, its PID file and server
log) is consumed by the scripts after it: Test 1 installs the package and starts the
daemon, Tests 2 and 3 use that daemon, Test 4 uses the installed package. The
runner stops at the first failure and runs nothing after it.

Tests 5 onwards depend only on Test 1's install. Each runs its own server in
its own state dir on its own port, and stops it before it exits, so their
order among themselves does not matter. They still share the container's one
HOME and one agent-director store, which is why their persona names are
unique per script.

Test 10's live start runs the server's start sweep (`reconcileOrphans`,
`src/session-manager.ts`), which kills and deletes every `service=cscb`
agent-director row whose persona is not in Test 10's own config (and any row
with a foreign instance ID or another working directory; a row with no
persona label is killed when live and kept). Every persona row an earlier
script left behind is gone after Test 10's start, and Test 12's live start
does the same to Test 10's rows; that is acceptable only because the
container is ephemeral and the scripts run one at a time.

Test 11 starts no server and makes no agent-director row: its driver's
agent-director is a stand-in, and each case runs its own tmux server (its own
`TMUX_TMPDIR` under the scenario's scratch root), so no other script's
sessions are in its reach.

### Scenario helper

`tests/integration/lib/scenario.sh` is sourced by Tests 5 onwards; its header
comment is the full function list. Sourcing it:

- makes a scratch root (`SCENARIO_ROOT`, `mktemp -d` under `/tmp`) and a
  first state dir under it, exported as `SLACK_STATE_DIR`, so a scenario never
  touches `~/.claude/channels/slack/` or another script's state, and its first
  `start` finds no `config.json.last-applied`;
- picks a free loopback port (`SCENARIO_PORT`, 20000 to 29999, never 3100,
  which Tests 1 to 3's server keeps) for the scenario's config to name;
- sets `SCENARIO_TAG` (`t<N>` from the script name). Build persona names from
  it (`${SCENARIO_TAG}_alpha`), so no two scripts share a persona key in the
  one agent-director store;
- installs an EXIT trap that stops every server the scenario started (with
  `--stop-bots` after a live start), kills every process registered with
  `track_pid`, runs the `on_exit` hooks, prints the tail of each `server.log`
  when the script failed, and removes the scratch root.

Matchers (E14 director decision 14). A matcher is one or more fixed-string
fragments that must appear on one line in the given order, with anything
between them; there is no regex. A plain string is a one-fragment matcher, so
`count_log`, `expect_count`, `wait_for_log`, `wait_for_count`, `count_in`,
`first_log_line`, `last_log_line` and `pending_has_line` take either. Build a
multi-fragment matcher with `matcher <fragment>...`. A scenario asserts a
line's class prefix, persona ref and one distinguishing fragment, never a
whole sentence: the full wording is owned by the unit tests, and a script that
quotes it breaks on every rewording.

The line builders return such matchers, each fragment taken from `src/` (the
helper's header names the function behind each):

| Builder | Matches |
|---|---|
| `persona_ref <name>` | the text `"<name>" (key=<key>)` (not a matcher) |
| `persona_start_match <index> <name>` | the `persona-start` line for that entry |
| `skip_match <name> [<cwd>]` | the dry-run spawn skip, optionally with its `cwd=` |
| `completion_match <n>` | the start pass's completion line for `<n>` personas |
| `counts [<field>=<n>]...` | the reload counts text (not a matcher); unnamed fields are 0 |
| `preview_header_match [<field>=<n>]...` | the `reload-preview` header with those counts |
| `applied_match [<field>=<n>]...` | the `reload-applied` line with those counts and the record path |
| `destructive_match <name> <setting>` | the `DESTRUCTIVE:` line for that persona and setting |

`expect_completion <n> <step> <part>...` checks the last completion line holds
each `<n> <what>` part. `check_pending_layout` checks the pending file's
header (`PENDING_HEADER`), fingerprint line and counts.
`hold_not_applied <hold-s> <step> [<command>...]` proves a change is held:
for `<hold-s>` seconds the last-applied record keeps its inode and bytes, no
new `reload-applied` line appears and `<command>` stays true, and the pending
file still exists afterwards.

Processes. `stop_server` forgets its daemon's PID once the daemon is gone,
and `stop_tracked_pid <pid> [<timeout-s>] [<step>]` stops a tracked process,
fails unless it is gone in time, and forgets it. Before the trap signals any
PID it checks the process is still the scenario's (a child of the script's
shell, or a process whose environment holds this `SCENARIO_ROOT`), so a PID
the system reused is left alone; `start_server` fails if its daemon does not
carry `SCENARIO_ROOT`. `on_exit <function>` registers extra cleanup: the trap
runs the hooks in registration order, each in a subshell, after every process
is stopped and before the scratch root is removed, on success and failure
alike. A failing hook turns a pass into a FAIL.

The contract for a scenario:

- Start and stop only through `start_server` / `stop_server` (or `run_start`
  for a start expected to fail). `start` runs with the token environment
  variables and `CSCB_PERSONA` unset, and with `SLACK_DRY_RUN=1` unless
  `--live` is passed.
- Wait with `wait_for_log`, `wait_for_count`, `wait_for_file` or
  `wait_until`, each with a stated bound, never a fixed `sleep`. The reload
  tick runs 5 s after the previous pass and cannot be shortened.
- Write config and credentials with `write_config` / `write_file`, which
  write atomically so a reload tick never reads a half-written file.
- Build fake tokens only with `fake_token`, and check for leaks with
  `count_token_like`, which prints a count and never the matched text. No
  token literal may appear under `tests/` (`tests/secrecy-audit.test.ts`).
- Assert with matchers built from fragments (see above), never a whole
  sentence copied from `src/`.
- Never replace the EXIT trap. Register a background process with
  `track_pid` and extra cleanup with `on_exit` instead.

### Slack stub

`tests/integration/fixtures/slack-stub-server.ts` is a Bun HTTP and WebSocket
server on 127.0.0.1 that stands in for Slack, because real Slack is not
reachable in the container. Tests 10 and 12 start it in the background and
point the server at it through the Slack API base URL override, an environment
variable for the integration suite only (see Environment Variables in
`docs/architecture.md`). The server honours it only for an
`http://127.0.0.1…` or `http://[::1]…` URL, and the stub listens on
127.0.0.1.

- It answers `auth.test` with an identity per token, `apps.connections.open`
  with a WebSocket URL on itself that sends `hello`, and every other Web API
  method with an `ok: true` shape CSCB reads.
- A control file (or `POST /_control`) sets each token's answers by token
  suffix: refused auth, a handshake to a closed port, and so on. The scenario
  rewrites it to switch answers mid-run.
- Every request is one JSONL line in a record file, labelled with the persona
  the scenario assigned to the token and a token hash, never the token.
- It has no `bun test` suite of its own; Test 10 exercises it end to end.

A live start (Tests 10 and 12) also launches each persona through the real
agent-director, so the script puts `fixtures/stub-claude.sh` first on `PATH`
as `claude` (as Test 4 does) and stops with `--stop-bots`.

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
   A self-describing scenario with no ticket (as Tests 5 to 12) skips this
   step: its header comment lists what it checks, and its expected log
   fragments are taken from `src/` in the header or a constants block.
2. Add `tests/integration/test-N-<short-name>.sh`, with `N` the next unused
   number. Required shape:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   TEST_NAME="test-N-<short-name>"
   # shellcheck source=lib/scenario.sh
   source "$(dirname "$0")/lib/scenario.sh"
   # ... write_config, start_server, wait_for_* assertions, stop_server ...
   echo "PASS: ${TEST_NAME}"
   ```
   Every pass criterion must be an explicit bash assertion that calls
   `fail <step>`, which prints `FAIL: <test-name>: <step>` to stderr and exits
   non-zero. Follow the helper's contract (see Scenario helper).
3. Make it executable. The runner picks it up by name and runs every
   `test-*.sh` through `bash`, so the mode bit is not what makes it run;
   don't edit `tests/runner.sh`.
4. Run `shellcheck tests/integration/*.sh tests/integration/lib/*.sh tests/runner.sh`
   from the repo root. `tests/integration/.shellcheckrc` lets shellcheck follow
   the helper without `-x`. The suite must stay warning-free.

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

- **Never in `/ci` or `/release-test`.** Neither runs it: `/release-test`
  selects only `testplans` tickets whose title starts with "Test ", and this
  title deliberately does not. Keep it that way.
- **Two ways to run it.** An operator runs it by hand, or `/ci-live`
  (`bun ci-live/run.ts`) runs it against real Slack in a throwaway container
  that serves as the test host. `/ci-live` leaves S1, 26 and 29b to the
  operator (and 14, 16 and 20 when no second account is configured);
  `docker/README.md` under "/ci-live" lists what it automates and
  how, and `ci-live/README.md` has its setup.
- **Test host and test workspace only.** It runs against a test Slack
  workspace with three persona apps (and a fourth, D, for Part 9), on a test
  host or in `/ci-live`'s container, never on the production install.
- **One ordered run.** A single setup, done only from the README, the setup
  wizard and `config.json`, then numbered checks in a fixed order (one
  crash-and-recover cycle, one reboot, a closing secrecy check) and a final
  teardown. Ordering constraints are expressed by position, so a new check
  goes where its prerequisites hold, not at the end.
- **AC coverage table.** The table at the top maps every live-verified
  acceptance criterion, and the extra live evidence, to the check and step
  that verifies it. A change that adds, moves or renumbers a check updates the
  table in the same edit.
- **No integration script.** The transcription rule above doesn't apply: the
  plan has no `tests/integration/` counterpart, and it must not be turned into
  one. A behaviour the docker suite can check in dry run belongs in a script
  there instead.
- **The plan is `/ci-live`'s oracle.** Each check in `ci-live/checks/` asserts
  its check's Expected list. A change to a check's Steps or Expected, or to
  the run order, updates the matching check in `ci-live/checks/` in the same
  edit.
