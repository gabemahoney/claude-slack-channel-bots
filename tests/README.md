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
start the server in dry run. Test 4, Test 0, Tests 10 and 12 and every fmk
scenario leave dry run: Test 4 runs its driver, which spawns under a stub
`claude` and starts no server, and the others start a live server, against
the loopback Slack stub.
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

### Image marker

`/etc/cscb-ci-image` exists only in the `cscb-ci` images
(`docker/Dockerfile.test.base`, see `docker/README.md`). The following check
for it before their first other step and, when it is absent, refuse and say
why:

- `tests/runner.sh`: its first step. It prints one line to stderr and exits 2
  before it creates a directory, writes a verdict or runs a test.
- Every `test-*.sh`: a script that sources `lib/scenario.sh` gets the
  helper's check, its first step, which prints
  `FAIL: <test>: refused: /etc/cscb-ci-image is absent …` and exits 1 before
  it makes a scratch root, picks a port or sets a trap. Tests 1 to 4, which do
  not source the helper, carry the same check as their own first step.
- `fixtures/fmk-driver.ts`, `fixtures/stub-mcp-session.ts` and
  `fixtures/fmk-texts.ts`: the first statement of each checks the marker and
  exits 2 before it reads an argument or loads a module; each statically
  imports only `node:` built-ins.
  (`fixtures/phase1-client-check.ts` also refuses to run without the marker.)
- `fixtures/ad-version-stand-in.sh`: checks the marker before it reads its
  settings or runs agent-director; without it, it prints one
  `ad-version-stand-in:` line on stderr and exits 70.
- Every `scenario.sh` step that installs, moves or swaps an agent-director
  binary or the shim, every harness agent-director call (`ad`, `ad_capture`, `ad_admin`, `ad_admin_capture`),
  every harness `sqlite3` read or edit (`ad_store_edit`, `ad_store_id`,
  `ad_store_pending_no_launch`), every stub-worker helper (`stub_mode`,
  `stub_press_enter`, `stub_release`, `write_mcp_config`) and the
  agent-director settings writer (`write_ad_settings`) calls
  `require_ci_image` as its first step, which fails with
  `FAIL: <test>: <step>: refused: /etc/cscb-ci-image is absent …`.

The same helpers then call `require_scenario_home`, which refuses unless
`SCENARIO_ROOT` is a directory and HOME is under it, both as written and by
real path (a HOME that is a symlink out of `SCENARIO_ROOT` is refused). The
copy-and-rename every install and swap goes through also refuses a
destination outside `SCENARIO_ROOT`, and the settings writers
(`write_ad_settings` and the stand-in installs' settings write) resolve
their directory with `realpath -e` and refuse one outside `SCENARIO_ROOT`
before they remove, create or write anything there. No harness step touches the invoking
user's own `~/.agent-director`.

`tests/host-safety.test.ts` reads these files, and never runs them, to check
that each check comes before the first step it guards (see the
`host-safety.test.ts` row in `docs/testing-guide.md`).

### Layout

```
tests/
  integration/
    test-1-install-startup.sh      # b.j9i: install the package, then check the agent-director client it resolves, the release's from npm, changing nothing (ad-client-check.sh --package),
                                   # then run fixtures/phase1-client-check.ts on the installed package; a pre-persona config fails start; the persona config starts in dry run
    test-2-dryrun-spawn-skip.sh    # b.3hy: persona load line, per-persona dry-run spawn skip, /interject 404 and 503
    test-3-cozempic-restart.sh     # b.set: cozempic probe, stop --stop-bots per persona, clean restart
    test-4-resume-dialog.sh        # no ticket: non-dry-run fresh and resumed launches held at the dev-channels dialog, each cleared by the dialog approver through agent-director on the `pending` row
    test-5-two-personas.sh         # E3/E4, dry run: two personas (one with a derived key) each log their own persona-start and cwd; /interject by name and key
    test-6-missing-working-dir.sh  # E5 (SR-6.4), dry run: a missing working dir, and a dangling claude_config_dir symlink, hold a persona down with no repeated line; each comes up once its dir exists
    test-7-dm-settings.sh          # E6/E7 (SR-1.2, SR-1.5), dry run: DMs switch and `dm` prompt destinations load; six invalid DM settings refuse the start
    test-8-reload-confirm.sh       # E11/E12 (SR-8.3 to SR-8.5), dry run: an edit is previewed, applied only on confirmation; a stale confirmation applies nothing
    test-9-reload-destructive-and-server-wide.sh
                                   # E13 dry-run leg (SR-8.6): a working_directory change gives one DESTRUCTIVE: line and touches one persona; a port change waits for the restart
    test-10-credentials-change.sh  # E13 (SR-8.3, SR-8.6), live against the Slack stub: a credentials change reconnects one persona on confirmation; handshake failure and refused change; leak counts
    test-12-bot-hook-absoluteness.sh
                                   # b.cnu SR-8.2, b.2qu, live against the Slack stub: every hook `command` path of an agent-director-launched persona is an absolute path to an existing executable
                                   # (agent-director's exec-form `command` read verbatim, CSCB's shell-form Stop hook by its first word); agent-director's run the user's agent-director install,
                                   # the reply guard runs the installed package's script
    test-0-fmk-harness-self-check.sh
                                   # SRJ-1306, fmk mode: the harness's self-check, run after Test 4 and before every fmk scenario. Its legs show the scenario's own HOME,
                                   # TMUX_TMPDIR and PATH (no agent-director on it, the stub as `claude`, bun kept); the release behind the shim at the standard path, and its agent-director-admin behind the shim at the admin path;
                                   # a harness call logged with its argv and the scenario shell as parent; the client's version probe through the shim; a spawn on the
                                   # scenario's own tmux server; `ad_store_id` and `ad_store_edit` on the scenario's store; the shim a regular file carrying its marker
                                   # after every install, re-shim, swap and restore, with the log kept; a 0.10.0 start; every guarded helper refusing a HOME outside
                                   # SCENARIO_ROOT; the tmux shim logging argv and parent, and each of its modes (fail-kill, fail-create, slow-create, wedge) behaving
                                   # as its header says; `cscb_run` putting the shim first on a CSCB process's PATH and recording it, the scenario shell keeping the
                                   # real tmux; a live one-persona start whose dialog the approver clears through agent-director, with no tmux line whose parent is
                                   # the bot server and the three closing assertions passing, both positive controls met by that start's own lines; harness
                                   # finished-row kills (agent-director-admin's `kill-finished`) passing; each assertion, positive control and count helper failing on a violating log; the
                                   # closing enforcement; and the trap stopping the scenario's tmux server. Its stub legs show the stub's MCP session registered as
                                   # the persona's, with no reconnect or relaunch over three health ticks and the persona not connected once the stub ends; the stub
                                   # run directly (its version line, the default dev-channels dialog, `silent`, a stop line on stderr); the stub helpers refusing
                                   # and working; the SessionStart re-fire in every reporting path (at once, a folder trusted in either config, and the dev-channels,
                                   # unrecognised and folder-trust dialogs answered by `stub_press_enter`) against a row a silent worker holds `pending`, every fire
                                   # ignored as `pid_mismatch` and none after G; exactly one stop line after a failed `status` read and after a `pending` row with no
                                   # launch start; and no stub line counted as CSCB's. Its harness-only step legs (see Harness-only steps) show each seeding
                                   # helper's session, labels and @ad_pane read back from tmux (`seeding`); each human tmux step's effect read back, and its
                                   # refusals (`tmux_steps`); the store statements writing exactly their columns and refusing a live row (`store_statements`);
                                   # the finished-row kill from the scenario's shell, the `pending` row beside a leftover and the one `delete`
                                   # (`operator_actions`); the find-missing loop's runs, interval and parent (`find_missing_loop`); fmk-driver.ts's three
                                   # forced calls, each one `DRIVER: FORCED` line with its calls parented by the driver (`fmk_driver_reuse_spawn`,
                                   # `fmk_driver_read_pane`, `fmk_driver_resume`); the 0.10.0 seeders in a nested run started on 0.10.0, their rows
                                   # surviving `install_ad_release` and each seeder's refusals (`seeders_010`); and, last, the tmux server restart and socket
                                   # re-bind (`tmux_server_steps`). The re-fire legs wait out agent-director's default G (60 s); only after them does
                                   # `store_statements` write a `[tmux]` table (`starting_session_seconds = 60`, `stopping_window_seconds = 30`), so the
                                   # kill need not wait 300 s. It runs about two and a half minutes and ends with the three closing assertions
    test-20-fmk-old-binary.sh      # HO §7 scenarios 8 and 23 (b.jg5 SRJ-1410, SRJ-1425), fmk: an old binary is refused at start; a binary swapped behind the shim stops
                                   # the server; a re-check that cannot run logs once and changes nothing; an ErrInvalidFlags reuse holds or stops; the floor's
                                   # release-candidate form launches; development builds (`0.0.0-dev`, `dev`) are refused, launching nothing; CSCB judges the
                                   # binary's version, never the client's package version (see fmk scenarios below)
    test-26-fmk-timing-settings.sh # HO §7 scenario 24 (b.jg5 SRJ-1426), fmk: agent-director's timing values are logged and govern the waits: the values line at
                                   # every start; a held launch's approver pace, pending-row runs and live-row sequence runs waiting on G from its launch start;
                                   # the relaunching stuck-launch post at B; "still stopping" following the written stopping window; a changed value used from
                                   # the next read, a `[pause]`-only change logging none; refused values: one `ad-config-malformed` alert per affected
                                   # persona, nothing destroyed or counted, the last values kept, one all-clear once fixed; the call timeout: below the
                                   # need, the startup warning and a held launch ending in `ErrCallTimeout` with no launch over its row; above it, no warning
                                   # and agent-director's launch-timeout `ErrTmuxUnresponsive` (see fmk scenarios below)
    lib/
      scenario.sh                  # shared helper sourced by Test 0 and Tests 5 onwards (see Scenario helper below)
    fixtures/
      agent-director-shim.sh       # the logging agent-director shim of fmk mode: logs each call's argv and parent, then execs the real binary beside it
      tmux-shim.sh                 # the logging tmux shim of fmk mode, first on the PATH of every CSCB process: logs each call's argv and parent, then acts on its
                                   # mode (log, fail-kill, fail-create, slow-create, wedge)
      fmk-driver.ts                # the driver of the calls an fmk scenario forces, run through `cscb_run`, each through the installed package's production code
                                   # with one `DRIVER:` outcome line: a `resume` (scenario 5) and a reuse spawn (scenarios 8 and 25) through the package's
                                   # forced-launch seams, and the persona's pane read under another TMUX_TMPDIR (scenario 26); refuses to run without the image
                                   # marker /etc/cscb-ci-image and imports the installed package and its agent-director client only after that check
      fmk-texts.ts                 # the one value printer of the fmk scenarios: prints the installed package's own export (a constant, or a builder's output for
                                   # the given arguments) by entry name, so no script retypes a value src/ exports; refuses to run without the image marker
                                   # /etc/cscb-ci-image and imports the package only after that check (see The value printer)
      ad-version-stand-in.sh       # scenarios 8 and 23's agent-director version stand-in, behind the shim: reports a chosen version (or none a client parses), can turn the
                                   # reuse flag into one the release does not define, and hands every other call to the image's release binary; refuses without
                                   # the image marker or its settings file (see Scenario helper)
      driver.ts                    # Test 4 driver: builds a one-persona config, calls spawnForPersona directly, then follows the persona's dialog approver through the package's seams
                                   # (running when the launch returns, stops because the row went live, keeps the launch start); deletes no row
      stub-claude.sh               # fake `claude` (Tests 4, 10 and 12, and every fmk script): runs the mode its working directory selects (the dev-channels
                                   # dialog by default, at once, silent, an unrecognised dialog, the folder-trust prompt, at once and lingering after `pause`'s
                                   # `/exit`), reports in by firing every SessionStart
                                   # hook its `--settings` registers, and SessionEnd on its exit sentinel, as direct children of its own process (exec form:
                                   # `command` with its `args`; shell form: the command's words); re-fires SessionStart while its row reads `pending`, up to G;
                                   # holds an MCP session to the bot server (see The stub worker)
      stub-mcp-session.ts          # the stub's MCP session client, copied beside the stub in every fmk script: connects to the bot server named by the stub's
                                   # `--mcp-config` with the package's own MCP SDK and holds the session until the stub ends; refuses to run without the image
                                   # marker /etc/cscb-ci-image and imports the package only after that check
      slack-stub-server.ts         # Tests 10 and 12 loopback Slack stub: Web API, apps.connections.open, Socket Mode WebSocket, JSONL record
                                   # (each `chat.postMessage` text whole, token-redacted)
      phase1-client-check.ts       # run by Test 1 on the installed package, after the client-under-test check
                                   # against the agent-director client the installed package resolves: the client exports SRJ-103's seven classes and the package's re-exports of them are the client's own,
                                   # client-built errors classify by class, the description and predicate helpers hold; refuses to run without the image marker /etc/cscb-ci-image
                                   # (its pure checker is unit-tested in tests/phase1-client-check.test.ts)
    .shellcheckrc                  # lets shellcheck follow `source lib/scenario.sh` without -x
    bunfig.toml                    # loads the host-safety preload guard for a bun test started here
    session-leader.test.ts         # bun test, not run by runner.sh
  runner.sh                        # sequential runner (Tests 1-4, then discovery), writes /test-results/verdict.txt
  README.md
docker/
  Dockerfile.test.base             # source-independent base image (see docker/README.md)
  ad-client-check.sh               # the client-under-test check (check only), copied into the base (see docker/README.md)
  Dockerfile.test                  # top image: the tests and the packed package
  entrypoint.sh                    # sets up testuser's Claude config, then runs tests/runner.sh
```

`tests/runner.sh` runs Tests 1 to 4 first, in that order, then every other
`tests/integration/test-*.sh` it finds, in version order (`sort -V`, so
`test-5` runs before `test-10`, and `test-0-fmk-harness-self-check.sh` runs
right after Test 4 and before every fmk scenario). A new scenario script needs no runner edit,
but this layout names every `tests/integration/test-*.sh` on disk and no
other script: `tests/shipped-docs.test.ts` fails on a script it does not name
and on a `test-<n>-<name>.sh` it names that is not on disk (see Adding a new
test).

There is no Test 11. It is retired, with its driver: CSCB makes no tmux call
of its own (b.jg5 SRJ-601), and fmk scenarios 3 and 17 replace it (b.jg5
SRJ-1305).

### Testplan tickets

`testplans/b.en1` is the suite's umbrella ticket. A script with a testplan
ticket names it in its header comment; the ticket holds the canonical
specification (Setup, Verify, Pass criteria) and the script is its
deterministic transcription. If you change the testplan, update the script; if
you change the script, update the testplan. Today that is Tests 1 to 3
(`testplans/b.j9i`, `b.3hy`, `b.set`).

A script with no ticket is specified by its header comment, and by its
driver's where it has one (Test 4 and `fixtures/driver.ts`). Test 0 has no
testplan ticket: its header comment lists each leg and what it shows. Tests
5 onwards have none either: each header comment lists what it checks, and the
log fragments it expects are taken from `src/` (the function that writes
each is named in the header or in a constants block near the top), so the
transcription rule does not apply to them.
`testplans/b.efu` is a separate resume scenario for `/release-test`, not one of
these scripts. `testplans/b.yko` is the manual live acceptance plan and has no
script (see Live acceptance plan below).

### Persona dry-run configs

Every script runs against a persona config written inside the container, never
a config or credentials file from the host:

- Every `start` but the live starts of Test 0, Tests 10 and 12 and the fmk
  scenarios runs with `SLACK_DRY_RUN=1`, and every `start`
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
- Test 0 and Tests 5 onwards each write their own config into their own
  scratch state dir (see Scenario helper), never the shared one. Tests 5 to
  12 run in the container's shared HOME; Test 0 and every fmk scenario run in
  their own HOME. Test 0, Tests 10 and 12 and the fmk scenarios are the
  scenarios outside dry run (see Slack stub).

### Execution model

`docker/entrypoint.sh` runs `tests/runner.sh` as `testuser`. The runner runs
the scripts in its order (see Layout) in one container, so state one script
leaves (the installed package, the running daemon, its PID file and server
log) is consumed by the scripts after it: Test 1 installs the package, checks
the agent-director client it resolves (`ad-client-check.sh --package`, then
`fixtures/phase1-client-check.ts`) and starts the daemon, Tests 2 and 3 use that daemon, Test 4 uses the installed package. The
runner stops at the first failure and runs nothing after it.

Test 0 and Tests 5 onwards depend only on Test 1's install. Each runs any
server it starts in its own state dir on its own port, and stops it before it
exits, so their order among themselves does not matter. Tests 5 to 12 run in the
helper's shared mode: they share the container's one HOME, one agent-director
store and one tmux server, with no shim, which is why their persona names are
unique per script. Every fmk script (Test 0 and each script whose name
carries `-fmk-`) runs with its own HOME, agent-director install and store,
and tmux server, all under its `SCENARIO_ROOT` (see Scenario helper), and
shares none of them with another script.

Test 10's live start runs the server's start sweep (`reconcileOrphans`,
`src/session-manager.ts`) over the shared store. The sweep kills each live
`service=cscb` agent-director row whose persona is not in Test 10's own
config (and each live row with a foreign instance ID or another working
directory, and each live row with no persona label), deletes no row, and
records the key of every row whose persona is absent as retired. A finished
row is never killed. So every row an earlier script left behind stays in the
store after Test 10's start, and Test 12's live start does the same to Test
10's rows. The sweep reaches only the shared
store: an fmk script's rows are in its own store, which no other script's
start sees.

### Scenario helper

`tests/integration/lib/scenario.sh` is sourced by Test 0 and Tests 5
onwards; its header comment is the full function list. Its first step is the
image-marker check (see Image marker). It has two modes, chosen by the
script's name:

- fmk mode, for every script whose `TEST_NAME` carries `-fmk-` (Test 0 and
  the fmk scenarios): the script gets its own HOME, agent-director install and
  store, and tmux server, all under `SCENARIO_ROOT`, with the agent-director
  shim in front of the binary (see fmk mode below);
- shared mode, for every other script (Tests 5 to 12): HOME, PATH, the
  agent-director store and the tmux server stay the container's, as the
  scripts found them, and no shim is installed.

Sourcing it, in both modes:

- exports `CSCB_PKG_DIR`, the installed package under test
  (`$SCENARIO_REPO/node_modules/claude-slack-channel-bots`), which the value
  printer and the drivers read;
- makes a scratch root (`SCENARIO_ROOT`, `mktemp -d` under `/tmp`) and a
  first state dir under it, exported as `SLACK_STATE_DIR`, so a scenario never
  touches `~/.claude/channels/slack/` or another script's state, and its first
  `start` finds no `config.json.last-applied`;
- picks a free loopback port (`SCENARIO_PORT`, 20000 to 29999, never 3100,
  which Tests 1 to 3's server keeps) for the scenario's config to name;
- sets `SCENARIO_TAG` (`t<N>` from the script name). In shared mode, build
  persona names from it (`${SCENARIO_TAG}_alpha`), so no two shared-mode
  scripts share a persona key in the container's one agent-director store;
- installs an EXIT trap that, in fmk mode, first sets the tmux shim back to
  `log`; stops every server the scenario started (with `--stop-bots` after a
  live start), kills every process registered with `track_pid`, in fmk mode
  stops every recorded bot server still running and the scenario's tmux server
  (a kill-server on every tmux socket under `SCENARIO_ROOT`, then SIGKILL for
  any of its tmux processes left; one still running fails the run) and runs
  the closing enforcement (see Closing assertions); then runs the `on_exit`
  hooks, prints the tail of each `server.log` when the script failed, and
  removes the scratch root.

fmk mode. Sourcing also:

- exports HOME as `SCENARIO_HOME` (`$SCENARIO_ROOT/home`), so no step reads
  or writes the container user's own `~/.agent-director`;
- exports `TMUX_TMPDIR` as `$SCENARIO_ROOT/tmux` and unsets `TMUX` and
  `TMUX_PANE`, so every tmux client the scenario's processes start talks to
  the scenario's own tmux server;
- exports a PATH that starts with the scenario's bin directory
  (`SCENARIO_BIN`), where `claude` is a copy of `fixtures/stub-claude.sh`,
  with a copy of `fixtures/stub-mcp-session.ts` beside it and the stub's mode
  selections (see The stub worker), followed by the container's PATH without every directory that holds an
  `agent-director` (the image's default agent-director directory among them)
  and without relative or empty entries. bun's directory stays. No process of
  the scenario finds an agent-director on PATH: the client finds the scenario
  HOME's at its standard path, `$HOME/.agent-director/bin/agent-director`;
- installs agent-director into the scenario HOME behind the shim. By default
  that is the release: `install_ad_release` runs the release's `install.sh`
  (from agent-director's tree at the release tag, in the image) in the
  scenario HOME with `--binary <the image's release binary> --admin-binary
  <the image's release agent-director-admin> --no-symlink --no-hooks`, stdin
  from `/dev/null`, which puts the binary at the standard path, the operator
  tool agent-director-admin at the admin path
  (`$HOME/.agent-director/admin/agent-director-admin`) and makes the HOME's
  store with its store id, then re-shims both. A script that sets
  `SCENARIO_AD_START=0.10.0` before its source line starts on agent-director
  0.10.0 instead: `install_ad_010` copies 0.10.0's binary to the standard path
  behind the shim, with no `install.sh` run, no agent-director-admin and no
  store yet. `SCENARIO_AD_START` is `release` (the default) or `0.10.0`; a
  shared-mode script that sets it fails;
- writes no agent-director `config.toml`, so agent-director runs on its
  default settings. Scenarios 10 and 24 (Test 26) are the exceptions: they
  write a `[tmux]` table with `write_ad_settings` (see Harness agent-director
  calls and store helpers below). Test 0 writes one too, after its re-fire
  legs (see Layout);
- once `SCENARIO_PORT` is picked, writes `$HOME/.claude/slack-mcp.json`
  (`write_mcp_config`), naming the bot server's MCP URL on that port, the
  `mcp_config_path` a persona config defaults to, so the stub's MCP session
  reaches the scenario's server;
- installs the tmux shim for the scenario's CSCB processes, in `log` mode, and
  starts the CSCB process record (see The tmux shim and CSCB processes below).

Keep HOME, `TMUX_TMPDIR` and PATH as sourcing set them. Sourcing also sets
`SCENARIO_REAL_TMUX` (the real tmux, resolved before PATH changed, which the
trap stops the server with), `SCENARIO_AD_BIN` (the standard path, which
holds the shim), `SCENARIO_AD_SHIM_LOG` (the agent-director shim's log),
`SCENARIO_TMUX_SHIM_LOG` (the tmux shim's log), `SCENARIO_CSCB_RECORD` (the
record) and `SCENARIO_SHELL_CMDLINE` (the script's own command line).

The agent-director shim (`fixtures/agent-director-shim.sh`):

- sits at the standard path as a regular file (the client takes the standard
  path first and follows symlinks, so a symlink there would bypass it), with
  the real binary beside it as `agent-director.real`; the same file fronts
  agent-director-admin at the admin path, with its binary beside it as
  `agent-director-admin.real`;
- for each invocation appends one `call` line to its log, holding argv, the
  parent's PID and the parent's command line, then execs the real binary
  beside it, keeping the PID, argv, standard streams and exit status. When it
  cannot append the line it runs nothing and exits 70, so no call goes
  unlogged;
- reads no environment variable (the client's version probe runs it with cwd
  `/` and a scrubbed environment): it finds the real binary and its log from
  its own path;
- logs to `agent-director-shim.log` beside the real binary
  (`SCENARIO_AD_SHIM_LOG`; run as agent-director-admin it logs to that same
  file, so one log holds every call of either binary), in one line format of six TAB-separated fields,
  stated in the shim's header and nowhere else. A reader of invocations takes
  only the lines whose first field is `call`; the format's other kind, `stop`,
  is reserved for `stub-claude.sh`. Every install, re-shim, swap, hide and
  restore moves only the shim and the binary, so the log keeps every line;
- carries a marker line. `check_ad_shim` fails unless the standard path holds
  a regular, executable file (not a symlink) carrying it, with an executable
  binary beside it that is not the shim; every install, re-shim, swap and
  restore runs it after its change. `check_ad_admin_shim` makes the same
  check at the admin path.

Each change to the install goes through one helper:

- `install_ad_shim` puts the binary installed at the standard path behind the
  shim: it copies the binary to `agent-director.real`, then renames the shim
  over the standard path, so the standard path always holds the binary or the
  shim. It fails when the standard path is missing, a symlink or already the
  shim. `install_ad_admin_shim` does the same at the admin path.
- `install.sh` replaces whatever is at the standard path with its binary, so
  every `install.sh` run is followed by `reshim_ad`, which puts the shim back
  at the standard path, and at the admin path when agent-director-admin is
  installed, and re-checks it. `install_ad_release` does this itself; a
  runbook step that runs its own install command calls `reshim_ad` after it.
- `swap_ad_binary <release|0.10.0|<abs-path>>` replaces only the binary behind
  the shim at the standard path (the release's, 0.10.0's, or a stand-in
  file), checking the shim before and after; agent-director-admin stays as
  installed.
- `hide_ad_install` and `restore_ad_install` are the one exception, for
  scenario 8's not-found step: hide moves the shim and the binary aside
  together (to `$SCENARIO_ROOT/ad-aside`), leaving no file at the standard
  path; restore moves both back, the binary first, then runs `check_ad_shim`.
  A move that fails halfway is rolled back and the step fails saying so.
- `install_ad_stand_in <version|unparseable> <reject|pass> [<step>]` and
  `restore_ad_install_with_stand_in <version|unparseable> <reject|pass>
  [<step>]` are harness additions for scenario 8 (`install_ad_stand_in` for
  scenario 23 too). Each puts
  `fixtures/ad-version-stand-in.sh` behind the shim, after writing the
  stand-in's settings beside the binary path
  (`agent-director.real.settings`): what its `version` reports (`<version>`,
  or for `unparseable` a line no client parses), whether `--reuse-finished`
  is turned into a flag the release does not define (`reject`) or passed on
  (`pass`), and the image's release binary (`SCENARIO_RELEASE_BIN`, never
  found through PATH) that every other call is handed to. The settings
  write refuses a bin directory that is not under `SCENARIO_ROOT` or
  resolves (by `realpath -e`) outside it.
  `install_ad_stand_in` places the stand-in through `swap_ad_binary`.
  `restore_ad_install_with_stand_in`, after `hide_ad_install`, puts the
  stand-in at `agent-director.real`, then moves the hidden shim back and
  removes the hidden binary; when the shim cannot move, the stand-in is
  removed again and the install stays hidden. Both end with `check_ad_shim`
  and a check that the stand-in, with its settings, is behind the shim. The
  stand-in reads no environment variable; its header states the settings
  format.

Harness agent-director calls and store helpers:

- `ad <arg>...` and `ad_capture <arg>...` run the scenario HOME's standard
  path, so every harness call goes through the shim to the scenario's binary,
  from the scenario's own shell: run as a plain command, the shim logs the
  script's shell (`$$`) as the call's parent. `ad_capture` sets `AD_RC`,
  `AD_OUT` and `AD_ERR` and never fails on the call's status. `ad_admin` and
  `ad_admin_capture` do the same for agent-director-admin at the admin path,
  through its shim; a scenario makes its `kill-finished` and `delete` only
  through `ad_kill_include_finished` and `ad_delete_unusable_row`.
- `ad_store_edit <statement>` runs exactly one `sqlite3` statement on the
  scenario HOME's `.agent-director/state.db` and fails with sqlite3's error;
  `ad_store_id` opens the store read-only and prints its store id, failing,
  saying why, unless it is 16 lowercase hex characters.
  `ad_store_pending_no_launch <instance-id>` is one such edit (see The stub
  worker).
- `write_ad_settings [--pause <value>] [<key>=<value>...]` is the one writer
  of the scenario HOME's agent-director settings file (a harness addition
  for scenarios 24 and 10). The file is HOME joined with the package's
  `AD_SETTINGS_RELATIVE_PATH`, and the table and pause-key names are the
  package's too, all read through `fixtures/fmk-texts.ts`. It replaces the
  file whole by one rename (`write_file`), so neither agent-director nor
  CSCB reads half a file: a `[tmux]` table holding each `<key> = <value>`
  in the order given, then, with `--pause`, a `[pause]` table holding
  `timeout_seconds = <value>`. Each value is written as the TOML text given,
  so a value below its minimum or of the wrong type can be written on
  purpose. With no argument it removes the file, which puts agent-director
  back on its defaults. It fails on a key that is not a lowercase TOML bare
  key, a key given twice, or a value that is empty or holds a control
  character, and refuses a settings directory
  that resolves outside `SCENARIO_ROOT` (by `realpath -e`: checked, when the
  directory exists, before the file is removed or the directory created,
  and again once it is created) or a path that is not a regular
  file. It then reads the file back, fails unless it holds exactly what was
  written, and sets `AD_SETTINGS_FILE` to its path.
  `_scenario_ad_tmux_setting`, the stub's re-fire and
  `ad_store_mark_finished` read the `[tmux]` values it writes.
- Each of these, `install_ad_shim` and every other install helper above, and
  every helper under Harness-only steps below, calls `require_ci_image` and
  then `require_scenario_home` as its first two steps (see Image marker).

The tmux shim and CSCB processes (fmk mode). A CSCB process is the bot
server, or a CLI command or driver the scenario runs: every `start` run
(`run_start`, `start_server`), every `stop` run (`stop_server` and the
trap's), every bot server they leave, and every command run through
`cscb_run`. Each starts with the tmux shim's bin directory
(`SCENARIO_TMUX_SHIM_BIN`, `$SCENARIO_ROOT/tmux-shim/bin`) first on its PATH.
agent-director runs `tmux` from its caller's PATH, and the client passes its
caller's whole environment on, so every tmux call agent-director makes for
CSCB reaches the shim. The scenario's own shell keeps the real tmux and never
has the shim on its PATH.

- `cscb_run <command> [<arg>...]` runs a CLI command (of the package under
  test or another) or a driver as a CSCB process: recorded with role `run`,
  the shim first on its PATH, standard streams passed through, its status
  returned. `<command>` is a program, run directly or through `env`, never
  through `timeout`, `bash -c` or another process that would stay its parent.
  It registers `SLACK_STATE_DIR` (when it is under `SCENARIO_ROOT`), so the
  trap stops a server the command leaves there. In shared mode it runs the
  command with no shim and no record.
- `tmux_shim_mode <mode> [<delay-s>]` sets the shim's mode by an atomic write
  of its mode file (`SCENARIO_TMUX_SHIM_MODE_FILE`); the shim's next call
  reads it. Only `slow-create` and `wedge` take a delay, a whole or decimal
  number of seconds. It fails on an unknown mode, a delay for any other mode
  and in shared mode. The mode is `log` from setup on.

The tmux shim (`fixtures/tmux-shim.sh`, installed as
`$SCENARIO_ROOT/tmux-shim/bin/tmux`):

- finds its files from its own path, never from an environment variable:
  the real tmux (`tmux.real`, a link to the tmux `scenario.sh` resolved before
  it changed PATH), the mode file and its log (`tmux-shim.log`,
  `SCENARIO_TMUX_SHIM_LOG`), all in `$SCENARIO_ROOT/tmux-shim`
  (`SCENARIO_TMUX_SHIM_DIR`). It refuses, running nothing and exiting 70, when
  the real tmux is missing, is the shim's own file or carries the shim's
  marker;
- for every call, in every mode, first appends one `call` line to its log,
  holding the parent's PID, the parent's command line and argv, in the
  agent-director shim's six-field format. When it cannot append the line it
  runs nothing and exits 70, so no call goes unlogged;
- then reads its mode from the mode file: one line, `<mode>` or
  `<mode> <delay-s>`. No file reads as `log`; an unreadable file, an unknown
  mode or a delay that is not a number of seconds runs nothing and exits 70;
- reads each command of a chained call after tmux's global options, and
  matches a command name as tmux does (its full name, its alias or a prefix
  no other command shares). A call with no command, and neither `-c` nor
  `-V`, is tmux's default `new-session`.

| Mode | Acts on a call whose commands include | What it does to that call | Every other call |
|---|---|---|---|
| `log` | (none) | | runs the real tmux |
| `fail-kill` | `kill-session` or `kill-pane` | runs nothing, so kills nothing; one `tmux-shim:` line on standard error; exits 1 | runs the real tmux |
| `fail-create` | `new-session` | runs nothing, so creates nothing; nothing on standard output and one `tmux-shim:` line (which tmux never gives) on standard error; exits 1. agent-director answers `ErrTmuxSessionCreate` and a plain spawn's row stays `pending` | runs the real tmux |
| `slow-create` | `new-session` | runs the whole chained call through the real tmux (agent-director's `@ad_owner` and `@ad_pane` labels with it), then waits the delay (default 15 s, longer than agent-director's default `create_timeout_ms` of 5000) and exits with tmux's status: the launch times out with its session present | runs the real tmux |
| `wedge` | any command | waits the delay (default 60 s, longer than every agent-director call timeout at its defaults), then prints one `tmux-shim:` line on standard error and exits 1, having run no tmux | (every call is waited) |

A wait runs `sleep` with its standard streams on `/dev/null`, so a `sleep`
left behind when agent-director's call timeout kills the shim holds none of
agent-director's pipes.

The CSCB process record (`SCENARIO_CSCB_RECORD`,
`$SCENARIO_ROOT/cscb-processes`) never drops a process. Each entry holds the
process's role (`start`, `stop`, `server` or `run`), its PID, its start time
from `/proc` and the time it started, and a later `gone` time once the
harness sees it ended. A run records itself, in the subshell that then execs
the command, before the command starts. A bot server is recorded once the
harness sees its PID in a state dir's `server.pid` (after every CSCB run, in
`start_server`, before every read of the record and in the trap). A log
line's parent is a CSCB process only when its PPID is an entry's PID and its
time lies in that entry's window, so a PID the system gives to another
process later never matches. A bot server that exits before it writes its PID
file (a start the server refuses) is not recorded, so its agent-director
calls (its version probe) are not counted as CSCB's.

`SCENARIO_SHELL_CMDLINE` is the script's own command line, quoted as the
shims quote a parent's: the parent field of every call the scenario's shell,
or a subshell of it, makes.

Closing assertions (fmk mode; b.jg5 SRJ-1401, SRJ-1418). Each reads the tmux
shim's log, the agent-director shim's log and the record, takes only `call`
lines (never a stub's `stop` line) and fails on a line not in the shims'
format. It reads an agent-director call's verb as the first word after
agent-director's global flags (`--store-path`, `--home`, `--tmux-command`).
On failure it prints each offending line indented, then a FAIL line naming
itself, how many lines and their numbers.

| Assertion | Fails on | Positive control: fails unless |
|---|---|---|
| `assert_no_server_tmux` | any tmux shim line whose parent is a bot server the scenario started | some tmux line's parent is an agent-director process a CSCB process ran: its PID is that of the latest agent-director shim `call` line at or before it, that call's parent is a CSCB process, and the parent's argv[0] is `agent-director`. The harness's own spawns never meet it |
| `assert_no_cscb_include_finished` | any finished-row kill, agent-director-admin's `kill-finished` or an agent-director `kill` call carrying `--include-finished` (`-` or `--`, with or without `=<value>`), whose parent is not the scenario's own shell or a subshell of it (a command substitution or pipeline element included): a parent whose command line is `SCENARIO_SHELL_CMDLINE` and that no CSCB process held | some agent-director call's parent is a bot server the scenario started (its version probe) |
| `assert_no_cscb_delete` | any `delete` call (agent-director-admin's, or an earlier agent-director's) whose parent is a CSCB process | (no positive control) |

Every fmk script ends with all three, in its own shell, whatever the tmux
shim's mode. The positive controls keep an empty or bypassed log from passing:
both need the scenario's own CSCB lines, so every fmk script starts at least
one bot server, and has agent-director run tmux for at least one of its CSCB
processes. The trap enforces the ending, after it has set the shim back to
`log` and stopped every server (its `stop` runs are CSCB processes, logged
like any other), for every fmk script, nested harness runs included; there
is no opt-out:

- a script that exits 0 without all three having passed in its own shell,
  over the scenario's own logs and record, fails, its FAIL line naming the
  assertions not passed. An assertion run in a subshell, or pointed at other
  files, does not count;
- when all three passed, the trap runs them again over the whole logs, so a
  violating line written after them (while the trap stopped a server, for
  example) fails the run with a FAIL line starting
  `after the closing assertions:`.

Scenario 17 (b.jg5 SRJ-1418, AC 19) is `assert_no_server_tmux` across every
fmk script: the bot server runs no tmux, and answers a startup dialog only
through agent-director (SRJ-401, SRJ-601, SRJ-612). Its static half is
SRJ-716's audit, `tests/fmk-source-audit.test.ts` (AC 18). AC 16's `/ci`
half (SRJ-106) is `assert_no_cscb_include_finished` across every fmk script,
with `tests/fmk-source-audit.test.ts` as its unit half.

CSCB's agent-director calls. `cscb_ad_calls <verb> [<fragment>...]` prints
the agent-director shim's `call` lines whose parent is a CSCB process, whose
verb is `<verb>` (any verb when `<verb>` is empty) and whose arguments, joined
by single spaces, hold every fixed-string fragment in order;
`cscb_ad_count <verb> [<fragment>...]` prints how many. The harness's calls,
the stub's calls and any `stop` line never count.
`wait_for_cscb_ad_call <count-before> <timeout-s> <step> <verb>
[<fragment>...]` (a harness addition for scenarios 8 and 23, which scenario
24 uses too) waits until that count is above `<count-before>`, which the caller takes before the step it waits
on, then prints the next such line (`cscb_ad_calls`' line `<count-before>` +
1); it fails naming `<step>` when the count stays there for `<timeout-s>`.

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

Processes. `stop_server` forgets its daemon's PID once the daemon is gone
(in fmk mode the CSCB process record keeps it, with its window), and
`stop_tracked_pid <pid> [<timeout-s>] [<step>]` stops a tracked process,
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
- In fmk mode, keep HOME, `TMUX_TMPDIR` and PATH as sourcing set them; make
  every harness agent-director call with `ad` or `ad_capture` (or, for
  agent-director-admin, its two helpers below), every store
  read or edit with `ad_store_id` or `ad_store_edit`, and every change to the
  install with the helpers above, followed by `reshim_ad` after any
  `install.sh` run; run every other CSCB CLI command or driver through
  `cscb_run`; and follow Rules for every fmk scenario below.

### Rules for every fmk scenario

These hold for every fmk script (b.jg5 SRJ-1401):

- It runs on the release (binary, agent-director-admin, client, and
  `install.sh` with its migration) unless it sets `SCENARIO_AD_START=0.10.0`, and at
  agent-director's default settings, with no `config.toml`, unless it is
  scenario 10 or 24 (Test 26), which write a `[tmux]` table with
  `write_ad_settings`. Test 0, the harness's
  self-check rather than a scenario, writes one once its re-fire legs are
  done, for its finished-row kill (see Layout).
- It runs with both shims: `tmux-shim.sh` first on the PATH of its CSCB
  processes, in `log` mode unless the scenario sets `fail-kill`,
  `fail-create`, `slow-create` or `wedge` with `tmux_shim_mode`; and
  `agent-director-shim.sh` in front of the agent-director binary.
- It ends with `assert_no_server_tmux`, `assert_no_cscb_include_finished` and
  `assert_no_cscb_delete`, whatever the shim's mode, and the trap fails a
  script that skips them (see Closing assertions).
- Where a scenario has a human act, the harness plays the human from the
  scenario's own shell, never from a CSCB process: `ad` or `ad_capture` as a
  plain command, in `$( … )` or in a pipeline, never through `timeout` or
  another wrapper process (its parent would not be the shell). The harness,
  never CSCB, seeds an `@ad_owner` label, renames a session or sets
  `remain-on-exit`, and every seeded label or pane follows SRJ-1306's seeding
  rules: each `@ad_owner` label ends with the scenario store's own store id
  (`ad_store_id`) unless the step seeds another store's session, and every
  seeded leftover carries `@ad_pane` on its worker's pane.
- A check that counts or rules out CSCB's agent-director calls reads only the
  shim log lines whose parent is a CSCB process (`cscb_ad_calls`,
  `cscb_ad_count`). The stub worker's own calls, any `stop` line (the kind
  the line format reserves for `stub-claude.sh`) and the harness's calls are
  not CSCB's.
- A latched persona's row is marked `missing` by a `find-missing` loop the
  harness runs (`run_find_missing_loop`, see Harness-only steps), because
  CSCB makes no extra calls for a latched persona. For an unlatched persona,
  CSCB's own pending-row runs mark it, and the harness runs no `find-missing`
  for it.
- A check that no row was deleted reads the row afterwards: it is present, in
  any state.
- CSCB's timings are shortened only through its configuration
  (`health_check_interval`, `session_restart_delay`) and the package's
  exported seams, never by editing `src/`. agent-director's are changed only
  through the `[tmux]` table of scenarios 10 and 24, written with
  `write_ad_settings`, beside which scenario 24 also writes a `[pause]`
  table; every other scenario
  waits out agent-director's default windows (at least 300 s where it needs
  the starting-session bound, as the finished-row kill does).
- Posts are read from the Slack stub's record (`slack-stub-server.ts
  --record`).
- Shim logs are read by parent process, as above, never by scraping a pane.

### fmk scenarios

Each fmk scenario of the handoff's scenario list (HO §7) is one script. Its
header comment is its full statement: the legs, the binary behind the shim
at each step, the waits and their bounds, and each matched value with the
`src/` export or function it comes from. Test 0 is the harness's self-check,
not a scenario.

| HO §7 scenario | Script | Requirement |
|---|---|---|
| 8 | `test-20-fmk-old-binary.sh` | b.jg5 SRJ-1410 (AC 21, 22, 23) |
| 23 | `test-20-fmk-old-binary.sh` (legs 23a to 23c, after scenario 8's) | b.jg5 SRJ-1425 (AC 1, 11) |
| 24 | `test-26-fmk-timing-settings.sh` | b.jg5 SRJ-1426 (AC 80, 84) |

#### Scenario 8: test-20

Test 20 shows this build never runs against an agent-director older than
Phase 1. It runs in fmk mode on the release, with one persona, P, whose
working directory selects the stub's `at-once` mode, and the Slack stub
recording. CSCB's config sets `health_check_interval` 0 (no health tick
relaunches P), `resume_enabled` false (P's finished row comes back only by a
reuse spawn), `exit_timeout` 5 and `agent_director_poll_interval_ms` 3600000
(the permission poller's `list` calls stay out of the shim's log). These are
the only delays set, all CSCB's own, through its config. agent-director runs
at its default settings: the scenario HOME's agent-director settings file
(the package's `AD_SETTINGS_RELATIVE_PATH` under HOME) carries no table named
as the package's `AD_TMUX_TABLE`, and set-up fails if it does.

The daemon is not the script's child, so its exit status is read from the
CLI's start report (8a) or, for a re-check stop (8c, 8e), from its shutdown
line naming the re-check, the one path that exits with
`AD_VERSION_RECHECK_STOP_EXIT_CODE`. Set-up checks that the printer's
`AD_VERSION_RECHECK_STOP_EXIT_CODE` is non-zero, so that line stands for a
non-zero exit.

The harness finishes P's row (`ad_store_mark_finished <P> ended`, then
`ad_kill_include_finished`, in 8d and 8e) only once tmux reports P's session
302 s old: the longer of agent-director's default starting-session bound
(300 s) and default stopping window (90 s), both printed from
`DEFAULT_AD_SETTINGS`, plus 2 s. `ad_store_mark_finished` needs the session
older than the stopping window and agent-director-admin's `kill-finished`
needs it past the starting-session bound. That wait is bounded by 332 s
(the age plus 30 s). In 8d P's session is already older than that; in 8e,
with the server stopped, the wait lasts about 300 s for the session the 8d
reuse spawn made. Test 20 runs about 18 minutes.

The shim stays at the standard path throughout, apart from the not-found
step; every other change replaces only the binary behind it:

| Leg | Behind the shim, in order |
|---|---|
| set-up | the release (0.11.0) |
| 8a | 0.10.0 (`swap_ad_binary 0.10.0`), then the release |
| 8b | the release; nothing at the standard path (`hide_ad_install` moves the shim and the binary aside, and no `agent-director` is on the server's PATH); the stand-in reporting no parseable version (`restore_ad_install_with_stand_in unparseable pass`); the release |
| 8c | 0.10.0, then the release once the server has stopped |
| 8d | the passing wrapper (`install_ad_stand_in <floor>-rc.1 reject`), then the release |
| 8e | the release; the below-floor stand-in (`install_ad_stand_in <0.10.0's version> reject`) once the start-pass launch has failed; the release once the server has stopped |

The legs run in order, each on the state the one before left:

- 8a, refused start. With 0.10.0 behind the shim (its version read with a
  harness `version` call and kept for 8e), a live `start` fails: the CLI
  reports the daemon's non-zero exit, and exactly one
  `ad-below-phase1-floor` entry equals the startup form of the floor message
  for that version and the binary's path, with its one server-log line. The
  start makes no spawn, resume, kill, `kill-finished`, delete or pause call,
  no new tmux session and no new Slack stub record line (no Slack
  connection).
- 8b, a re-check that cannot run. P launches on the release and reports in;
  its row (state, `row_version`, pid) and session are recorded. With the
  install hidden (`ErrSystemInstallNotFound`), one could-not-run line
  appears within the re-check interval plus 10 s, and no probe runs while it
  is hidden. With the shim back and the unparseable stand-in behind it
  (`ErrSystemInstallUnreachable`; a harness `version` call through it exits
  0 and reads no `.version`), and then with the release back, each next
  bot-server probe leaves that one line the only one and the server running.
- 8c, a swap stops the server. Within the re-check interval plus 10 s of the
  swap to 0.10.0 (`health_check_interval` 0), the server exits with its
  re-check shutdown line (a non-zero exit) and exactly one new entry, equal to the runtime form
  of the floor message (it carries the runtime re-check phrase and points to
  the debug skill), with its one server-log line. No CSCB kill,
  `kill-finished`, pause, delete, spawn or resume follows the swap. With the
  release back, P's worker process and session are alive and its row's
  state, `row_version` and pid are as 8b recorded. What CSCB's calls met while
  0.10.0 sat behind the shim (`ErrSchemaMismatch` on the migrated store) is
  printed, not asserted.
- 8d, the hold. The harness finishes P's row (`ad_store_mark_finished <P>
  ended`, then `ad_kill_include_finished`, agent-director-admin's
  `kill-finished`) and puts the passing wrapper behind the shim. The server
  starts: the start pass's plain spawn collides with P's finished row
  (`ErrInstanceIdCollision`) and launches nothing (its count is printed, not
  asserted), then exactly one reuse
  spawn carrying `--reuse-finished` gets `ErrInvalidFlags` and is directly
  followed by a bot-server probe (the immediate re-check). The server keeps
  running, one post to P's channel holds the Cannot launch alert whole, and
  P's row stays finished. Over the next timed re-check there is no further
  launch and no second post. Putting the release back is the version change:
  at the next timed re-check exactly one reuse spawn for P succeeds and P
  reads `waiting`, still with one alert and no delete. While the hold lasts,
  strictly after the rejected reuse spawn (its shim line's time) and before
  the timed re-check that read the new version, CSCB makes no kill,
  `kill-finished`, pause, delete, spawn or resume call, and P has no tmux
  session.
- 8e, the stop through the triggered re-check. With the server stopped, P's
  row finished again the same way and the tmux shim in `fail-create`, the
  server starts on the release: the gate passes and the start pass's reuse
  spawn fails. The tmux shim goes back to `log` and the below-floor stand-in
  goes behind the shim. P's next attempt is a reuse spawn made before the
  first timed re-check (the script fails saying so when it is not); its
  `ErrInvalidFlags` is directly followed by a bot-server probe, and the server
  exits with its re-check shutdown line (a non-zero exit) and exactly one
  more entry, the runtime form for 0.10.0's version,
  all less than the re-check interval after the gate. No CSCB kill,
  `kill-finished`, delete or pause follows, and P's row stays finished.

Why the legs are built this way:

- The server's effects come from its own reuse spawn of P, the persona with
  `resume_enabled` false and a finished row: at the start pass under the
  passing wrapper (8d), and at P's next attempt after a `fail-create` start
  pass under the below-floor stand-in (8e).
- `fixtures/fmk-driver.ts` runs its forced reuse of P (through `cscb_run`)
  under the passing wrapper only, in 8d. It runs in its own process, behind
  CSCB's startup gate, so it cannot stop the server or post an alert; its
  one `DRIVER:` line naming `ErrInvalidFlags` and CSCB's class for it shows
  the wrapper's rejection is a real `ErrInvalidFlags` through CSCB's
  production classification.
- The below-floor binary is a stand-in reporting 0.10.0's own version (read
  in 8a): a real 0.10.0 answers `ErrSchemaMismatch` on the migrated store
  before it parses flags, so it never answers `ErrInvalidFlags`.
- The passing wrapper reports the floor with an `-rc.1` tag. CSCB compares
  only major.minor.patch against the floor (b.jg5 SRJ-202), so it passes;
  the release put back reads as a different version string, which ends the
  hold.
- With `reject`, the stand-in turns `--reuse-finished` into a flag the
  release does not define and hands the call to the release, so the release
  itself answers its `ErrInvalidFlags` envelope.
- Every re-check wait is bounded by the re-check interval plus a 10 s allowance (the
  probe, the shutdown and the script's polling), measured from the swap, and
  watches shim-log and server-log lines.

Matched values, each printed by `fixtures/fmk-texts.ts` from the installed
package (see The value printer):

| Value | Printer entry | `src/` |
|---|---|---|
| The Phase 1 floor | `PHASE1_FLOOR_VERSION` | `src/ad-version-gate.ts` |
| The entry's class label | `AD_BELOW_PHASE1_FLOOR` | `src/install-check-labels.ts` |
| The floor message, startup and runtime forms | `buildBelowPhase1FloorMessage <version> <path> <startup\|runtime>` | `src/ad-version-gate.ts` |
| The runtime re-check phrase | `RUNTIME_RECHECK_PHRASE` | `src/ad-version-gate.ts` |
| The re-check interval | `AD_VERSION_RECHECK_INTERVAL_MS` | `src/ad-version-gate.ts` |
| The re-check stop's exit status (checked non-zero) | `AD_VERSION_RECHECK_STOP_EXIT_CODE` | `src/ad-version-gate.ts` |
| The could-not-run line's prefix | `AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX` | `src/ad-version-gate.ts` |
| The settings file and its `[tmux]` table (the no-table check) | `AD_SETTINGS_RELATIVE_PATH` (under HOME), `AD_TMUX_TABLE` | `src/ad-settings.ts` |
| The Cannot launch alert's body | `INVALID_FLAGS_HOLD_ALERT_TEXT` | `src/invalid-flags-hold.ts` |
| The alert as posted for P | `formatPersonaNotice <P> INVALID_FLAGS_HOLD_ALERT_TEXT` | `src/persona-notifier.ts` |
| CSCB's class for `ErrInvalidFlags` | `classifyAdError ErrInvalidFlags` | `src/ad-error-class.ts` |
| agent-director's default starting-session bound | `DEFAULT_AD_SETTINGS tmux starting_session_seconds` | `src/ad-settings.ts` |
| agent-director's default stopping window | `DEFAULT_AD_SETTINGS tmux stopping_window_seconds` | `src/ad-settings.ts` |

Lines with no exported builder are matched by a fragment quoted from `src/`,
each with its source named beside it in the script: the start failure
(`src/cli.ts`), the re-check's shutdown reason (`src/server.ts`), and the
collision, reuse-failed and reuse-spawned lines
(`src/session-manager.ts`).

#### Scenario 23: test-20

Scenario 23's legs run in Test 20 after scenario 8's and before the three
closing assertions, on the same set-up, persona and config. They show that
CSCB launches on the floor's release-candidate form, refuses the development
builds `0.0.0-dev` and `dev` at startup, launching nothing, and judges the
binary's version (the client's `binaryVersion`), never the client's package
version (PRD AC 11). Each stand-in goes behind the shim with
`install_ad_stand_in`, whose own shim check runs after each install, and
the release goes back with `swap_ad_binary release` after each leg. The
three legs take a few seconds of Test 20's run.

| Leg | Behind the shim, in order |
|---|---|
| 23a | the stand-in reporting the floor's release-candidate form (`install_ad_stand_in <floor>-rc.1 pass`), then the release once the server has stopped |
| 23b | the stand-in reporting the client's development sentinel (`install_ad_stand_in 0.0.0-dev pass`), then the release |
| 23c | the stand-in reporting `dev` (`install_ad_stand_in dev pass`), then the release |

- 23a, the release-candidate form launches. With the server stopped and P's
  row finished (from 8e), the stand-in reporting the floor with an `-rc.1`
  tag goes behind the shim in `pass` mode, handing every call to the
  release, and a harness `version` call reads it. The server starts: the
  gate passes (the bot server's first probe; the server keeps running), at
  least one CSCB launch call (spawn or resume) follows, P reports in
  (`waiting`), and the start writes no `ad-below-phase1-floor` entry. The
  server is stopped.
- The AC 11 check, before 23b. The script reads the package version of the
  agent-director client the installed package resolves (the field the
  client's `version()` reports) from that client's `package.json`, found as
  `docker/ad-client-check.sh` finds it, with no agent-director call. The
  printer's `meetsPhase1Floor` must print `true` for it: the client's package
  version meets the floor, so a CSCB that judged it would launch in 23b and
  23c, and their refusals show it judges the binary's version.
- 23b, `0.0.0-dev` is refused. With the stand-in reporting the client's
  development sentinel behind the shim, a live `start` fails: the CLI reports
  the daemon's non-zero exit and no daemon runs; exactly one
  `ad-below-phase1-floor` entry equals the startup form of the floor message
  for `0.0.0-dev` and the binary's path, with its one server-log line; no
  `ad-system-install-unreachable` entry is written. The start makes
  `version` calls only (at least one), no new tmux session and no new Slack
  stub record line.
- 23c, `dev` is refused. With the stand-in reporting `dev` (a plain
  `go build`'s version) behind the shim, a live `start` fails as in 23b,
  launching nothing, with exactly one new `ad-system-install-unreachable`
  entry naming the `unparseable-version` reason and the binary's path (the
  client's `Client.create()` refuses a version that does not parse, b.jg5
  SRJ-202) and no new `ad-below-phase1-floor` entry.

8a, 23b and 23c share one refused-start check: the CLI's non-zero exit
report, no daemon running, only `version` calls through the shim since the
start (the shim log is read whole, since the refused daemon never wrote its
PID file), no new tmux session and no new stub record line.

The image holds the 0.11.0 release and no release candidate, so 23a runs on
the stand-in reporting `<floor>-rc.1`, the form 8d's passing wrapper
reports. `dev` is not a CSCB constant: the script quotes it, citing b.jg5
SRJ-202 and HO §7 scenario 23.

Matched values, each printed by `fixtures/fmk-texts.ts` from the installed
package, beside scenario 8's floor, floor label and floor message:

| Value | Printer entry | `src/` |
|---|---|---|
| The client's development sentinel | `CLIENT_DEV_SENTINEL_VERSION` | `src/ad-version-gate.ts` |
| The unreachable entry's class label | `AD_SYSTEM_INSTALL_UNREACHABLE` | `src/install-check-labels.ts` |
| The unparseable-version reason | `UNREACHABLE_REASON_UNPARSEABLE_VERSION` | `src/ad-version-gate.ts` |
| The AC 11 check: whether the client's package version meets the floor | `meetsPhase1Floor <version>` | `src/ad-version-gate.ts` |
| The `0.0.0-dev` floor message, startup form | `buildBelowPhase1FloorMessage 0.0.0-dev <path> startup` | `src/ad-version-gate.ts` |

#### Scenario 24: test-26

Test 26 shows agent-director's timing values are logged and govern CSCB's
waits, and that a settings file agent-director refuses is one alert per
affected persona, with nothing destroyed or counted, cleared once the file
is fixed, and that CSCB's call timeout below agent-director's slowest verb
is warned about at start and never retried over a live row, while above it
agent-director's own launch-timeout answer arrives. It runs in fmk mode on the release, with the Slack stub recording
each `chat.postMessage` text whole. Before the first start it writes the
scenario HOME's agent-director settings file with `write_ad_settings`, a
`[tmux]` table holding the scenario inputs SRJ-1426 names; scenario 24 is
one of the two scenarios that write `[tmux]` (b.jg5 SRJ-1401, SRJ-1306).
Each key is checked to be one of the package's `AD_TMUX_KEYS`, and each
value of the first table (and the change leg's 240) to be at or above its
minimum, before it is written:

| `[tmux]` key | Written | Minimum it is checked against |
|---|---|---|
| `pending_grace_seconds` | 120 (240 in the change leg; 61 in the call-timeout legs) | `pendingGraceMinimumSeconds` at the default `create_timeout_ms` and `pipe_close_wait_ms`; in the call-timeout legs the value is `pendingGraceMinimumSeconds` at 40000 and the default `pipe_close_wait_ms` |
| `stopping_window_seconds` | 30 | `AD_SETTING_MINIMUMS stopping_window_seconds` |
| `starting_session_seconds` | 120 | `AD_SETTING_MINIMUMS starting_session_seconds` |
| `create_timeout_ms` | 40000, in the call-timeout legs only | none (its key is checked, and the grace period is raised with it) |

The other `[tmux]` values stay agent-director's defaults. At the first
table's values G is 120 s, B 300 s and the alert threshold 180 s (printed,
not used: the alert timings are unit-tested). CSCB's config sets
`health_check_interval` 0 (no health tick launches anyone),
`resume_enabled` true (S's finished row comes back by a `resume`),
`exit_timeout` 5 and `agent_director_poll_interval_ms` 3600000 (the
permission poller's `list` calls stay out of the shim's log), all CSCB's
own, through its config; the refused-value legs also set
`session_restart_delay` 0, and the call-timeout legs
`agent_director_call_timeout_ms` (30000, then 61000). Test 26 runs about 39
minutes: about 17 for the legs before the refused values, most of it the
held launch's B and the change leg's three waits for the next timed probe,
about 9 for each refused-value leg, and about 4 for the two call-timeout
legs.

Each persona (`t26_<x>`, one channel each) has its stub mode selected for
its working directory with `stub_mode`:

| Persona | Working directory and stub mode | Added |
|---|---|---|
| S | `work/s`, `linger-on-exit` | in the config from the first start |
| P | `work/p`, `unrecognised-dialog`, switched to `at-once` before B so the relaunch after the abort reports in | across a plain stop and start |
| Q | `work/q_link`, a symlink to `work/q_held` (`unrecognised-dialog`), re-pointed to `work/q_ready` (`at-once`) | across a plain stop and start |
| R | `work/r`, `unrecognised-dialog`, answered by `stub_press_enter` | by a confirmed reload |
| C1 | `work/c1`, `at-once` | by a confirmed reload while the settings file is refused (refused-stopping) |
| C2 | `work/c2`, `at-once` | the same, in refused-grace |
| T1 | `work/t1`, `dev-channels` (it reports in on the approver's Enter: a launch that loses its create reply runs the stub in that mode, `scenario.sh`'s seeding rules) | across a plain stop and start, in call-timeout-30000 |
| T2 | `work/t2`, `dev-channels` | the same, in call-timeout-61000 |

A persona added across a restart is a plain stop, the config written, the
state dir's `config.json.last-applied` removed, and a start: with no
last-applied record the start applies `config.json` as it stands, with no
preview to confirm (see "Reload" in the repository's `README.md`). R's reload is confirmed by
renaming `config.json.pending` to `config.json.apply`, as Test 8 does.

The harness steps, all from the scenario's own shell: `write_ad_settings`
(set-up, the change leg, the refused-value legs and the call-timeout legs),
`stub_mode`, `stub_release` (S's lingering stub), `stub_press_enter` (R's
dialog), `tmux_shim_mode` (`slow-create` with a 50 s delay in the
call-timeout legs, then `log` again), re-pointing Q's symlinked working
directory by one rename (Q's row records the real path, so its `cwd` no
longer matches), the plain stops and starts, the `last-applied` removal and
the reload's confirmation, and harness `get` calls that read a row's
`launch_started_at`, `ended_at` or state (T1's, about once a second, in
call-timeout-30000). Every start of the script logs exactly
one values line.

The legs run in order, each on the state the one before left:

- values. The first start, with S: exactly one values line, equal to the
  printer's `buildAdSettingsValuesLine` for the written path, the three
  written values and the six defaults (it carries the nine `[tmux]` values
  only).
- stopping (scenario 13's "still stopping"). With S up, its session's
  creation time is taken, then `stop --stop-bots` (CSCB's `pause` makes S's
  row `ended` while its stub lingers) and `start` at once. S's first
  `resume`, made less than `stopping_window_seconds` after the row's
  recorded `ended_at`, gets exactly one refusal line carrying
  `STILL_STOPPING_PHRASE`. S's next `resume` (CSCB's UNAVAILABLE retry) is
  made more than the window after `ended_at`, while the old worker still
  runs and its session is younger than `starting_session_seconds`: its
  refusal carries `STILL_STARTING_PHRASE` and never `STILL_STOPPING_PHRASE`.
  After `stub_release`, a later `resume` brings S up (`waiting`). There is
  no post to S's channel, every refusal line says no spawn-failure notice,
  and there is no `spawn-failed` entry, no latch and no counted launch
  failure. S comes back by `resume`: CSCB makes no reuse spawn of S in the
  leg, and each CSCB spawn of S in it (the collision ladder's plain spawn)
  has its `ErrInstanceIdCollision` line for S (it met S's row and launched
  nothing).
- held. P, launched by this server process: its `launch_started_at` (L) is
  read. No slower approver read comes before G: P's `read-pane` calls in
  (L + 5 s, L + G) are at least two, every gap between consecutive ones is
  below the mean of the two paces (3 s), and the last lies within the slow
  pace (5 s) of L + G. Those in (L + G + 5 s, L + G + 65 s) are at most what
  a 5 s pace allows (`floor(d / 5) + 1` reads in a window of d seconds). The
  calls are timed by their shim lines' own time field, so a gap is measured
  whole, never rounded to the script's polling. There is no CSCB
  `find-missing` before the launch start plus G, and no post to P's channel
  or CSCB kill of P before the relaunching post. Exactly one relaunching
  post, compared whole: its stub record time is no earlier than B and less
  than 30 s after it, and its text is the printer's relaunching notice for
  P with B (in whole minutes). The stuck-launch line is no earlier than B.
  P's pending-row lines and the abort that follows the post are printed,
  not asserted; P then reports in.
- sequence. Q is added across a restart and held; its launch start L is
  read and its symlink re-pointed, then a plain stop and start runs before
  L + G (a restart without teardown). The restart's start sweep (b.jg5
  SRJ-714) runs first: it kills Q's live row, whose `cwd` is no longer the
  persona's working directory, and makes its one `find-missing` run at
  once. Its lines are printed, not asserted, since SRJ-1426's G rule is the
  live-row sequence's. The start pass then starts Q's live-row sequence
  (the script fails, saying so, when it does not), its start line
  matching the printer's for Q entered at step 1
  (`LIVE_ROW_SEQUENCE_ENTRY_KILL`) and ending in a launch. Its kill of Q comes
  before its step-2 wait; the wait's armed line equals the printer's for L
  and G; its first `find-missing` run comes no earlier than L + G, with no
  CSCB `find-missing` between the sequence's start and it; and the wait's
  end line is no earlier than L + G. Q is brought up by a reuse spawn. A
  run line saying a run left Q's `pending` row in neither list is followed
  by no kill of Q, and there is no post to Q's channel.
- change. A `[pause]`-only change (`timeout_seconds` 60, the `[tmux]`
  values kept) logs no values line through the next bot-server probe.
  `pending_grace_seconds` raised to 240 logs exactly one values line,
  naming 240, after the next probe and none before it. R, added by a
  confirmed reload and held at its dialog, makes more `read-pane` calls in
  (L + 130 s, L + 170 s) from its launch start L than a 5 s pace allows, so
  the raised G is in use; a harness Enter brings R up. The earlier `[tmux]`
  values are then written back with no `[pause]` table, and whether a
  values line follows the next probe is printed.
- refused-stopping. The server restarts with `session_restart_delay` 0
  (`health_check_interval` is 0 throughout) and S, P, Q and R up. The file
  is written with `stopping_window_seconds` 10, below its minimum. After the
  next bot-server probe C1 is added by a confirmed reload; its launch meets
  agent-director's `ErrConfigMalformed`, which reaches CSCB as
  `ErrUnknownErrorName`, and it is retried on its timer at least twice, with
  a bot-server probe inside the refusal. The earlier accepted file is then
  written back. The checks are `refused_values_check`'s, below.
- refused-grace. The same checks for `pending_grace_seconds = "60"` (a TOML
  string), with C2 added by a confirmed reload and C1 among the personas
  already up.
- call-timeout-30000 (b.jg5 SRJ-1426, SRJ-213, SRJ-407; AC 84). A plain
  stop; the settings file written with `create_timeout_ms` 40000,
  `pending_grace_seconds` 61 and the earlier stopping and starting values,
  with no `[pause]` table; `agent_director_call_timeout_ms` 30000 in CSCB's
  config, T1 added, the tmux shim in `slow-create` with a 50 s delay (longer
  than `create_timeout_ms`), and a start. That start logs exactly one values
  line, the printer's for these values, and exactly one call-timeout
  warning, the printer's line for 30000 and these values, before T1's spawn.
  T1's plain spawn, made by this server process, ends in `ErrCallTimeout`:
  its refusal line comes at least 30 s (less a 0.5 s allowance for the
  shim's line) and less than 40 s after the call's line in the shim's log.
  The first CSCB `get` of T1 after the spawn follows, and exactly one
  `server.log` line equals the printer's `launchUnavailableGetLine` for it:
  the plain spawn's `ErrCallTimeout` form, reading this launch's `pending`
  row with the launch start the harness last read before the get, the
  outcome `LAUNCH_UNAVAILABLE_OUTCOME_APPROVER` (the approver started). A
  CSCB `send-keys` (the approver's Enter) follows it and T1 reads
  `waiting`. The harness reads T1's row (its state and launch start) about
  once a second from the spawn until T1 is up and its retry timer has
  stopped: its full-mode retry finds nothing left to recover, and the
  printer's `unavailableRetryStoppedLine` for T1 (`full none`,
  `UNAVAILABLE_RETRY_STOP_RECOVERED`) is matched whole. Every later CSCB launch
  call of T1 (`spawn` or `resume`) must follow a harness reading of `ended`
  or `missing` (the latest before the call) and a CSCB `get` or `status` of
  the row since the call before it; with none such, the spawn is T1's only
  launch.
- call-timeout-61000 (b.jg5 SRJ-1426; AC 84). A plain stop,
  `agent_director_call_timeout_ms` 61000, T2 added, the same settings file
  and `slow-create`, and a start, which logs no call-timeout warning (the
  printer gives none for 61000). T2's plain spawn, the same launch as T1's
  under the higher setting, ends in `ErrTmuxUnresponsive` carrying
  `LAUNCH_TIMEOUT_PHRASE`, its refusal line at least 40 s and less than
  61 s after the call. Exactly one `server.log` line equals the printer's
  `launchUnavailableGetLine` for the `get` that follows: the
  `ErrTmuxUnresponsive` form, reading this launch's `pending` row with the
  launch start a harness `get` read while the held create kept it pending,
  the outcome `LAUNCH_UNAVAILABLE_OUTCOME_APPROVER`. The approver brings T2
  up (`waiting`). No `server.log` line for T2 names `ErrCallTimeout`, and no
  warning follows. The tmux shim is set
  back to `log`.

The two refused-value legs hold the suite's only deliberately refused
values (the exception b.jg5 SRJ-1401 makes; SRJ-1426, SRJ-209, SRJ-316,
SRJ-1018; AC 84). agent-director answers every store-backed call with
`ErrConfigMalformed` while the file is refused, and answers `version`. One
function, `refused_values_check`, checks both legs:

- The read. Exactly one refused-read line, at the first refused read,
  carrying the printer's fixed parts (which name the file) with the refused
  key between them; none at the next read, and no values line while the
  file is refused, so the last accepted values stay in effect.
- The alert. One onset post to the added persona's channel: the printer's
  fixed parts, naming the config file, around agent-director's description.
  One raise line for that persona and none for another; no post to any
  other persona's channel.
- Nothing done while refused. No CSCB delete, kill, `kill-finished` or
  `resume`, no stuck-launch abort, no counted launch failure and no persona
  read as dead. The one launch call is the added persona's plain spawn at
  the reload; a persona already up gets none. Each of the added persona's
  timed retries makes one `status` call, refused and read as unknown, not
  dead, launches nothing, counts nothing, and is re-armed with the reason
  `liveness-unknown`. SRJ-1426's "makes no spawn" is followed here: the
  retries do not retry the launch.
- `version` does not clear. The bot-server probe inside the refusal (its
  `version` call is answered) is followed by no all-clear and no clear line.
  The version probes inside the refusal ran: the count of could-not-run
  lines (`AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX`) is unchanged across
  the refusal.
- After the fix. The persona reads `waiting`, and its channel gets exactly one all-clear
  post, the printer's text, made after the fix, with one clear line. The
  first bot-server probe after the fix logs no values line (the values are
  unchanged) and no refused-read line.

Each refused-value leg waits for the added persona's retry timer to stop
(its pending-only retry reads the row `waiting`: the printer's
`unavailableRetryStoppedLine` for that persona, `pending-only waiting`,
`UNAVAILABLE_RETRY_STOP_ROW_LIVE`, matched whole) before it ends, so no persona
up at the next leg has a timer: a pending-only retry landing inside the
next leg's refusal would start a new episode.

The call-timeout legs' need is 60.9 s: the launch ceiling at C = 40 s,
max(Q + C + 2A + 4W, 2Q + C + 3W) = 45.9 s at agent-director's default Q, A
and W, plus `AD_CALL_TIMEOUT_NEED_MARGIN_MS` (15 s, `src/ad-settings.ts`).
`resume`, a reuse and a plain spawn share that ceiling, so there is no
separate case for the plain spawn; their equality is unit-tested
(`tests/ad-settings.test.ts`, b.jg5 SRJ-213) and only derived in the
script's header. The file holds no `[pause]` table, so `pause`'s ceiling
(9 s plus the default 30 s) is below the launch ceiling. The script takes
the need from the printer (`adCallTimeoutNeed`, whose verb must be `resume`,
the launch row's first verb) and checks before the legs that 30000 lies
below `create_timeout_ms` and at or below the need, that 61000 lies above
the need, that the delay is longer than `create_timeout_ms`, and that the
printer's warning names 30000 and the need and gives none for 61000. "The
same launch" of call-timeout-61000 is a second persona's fresh plain spawn,
under the same settings file, after a restart without teardown that picks
up 61000; T1 is up by then.

A bot-server probe is a CSCB `version` call in the agent-director shim's
log whose parent is the bot server; the server reads the settings file
again after each timed probe (`installAdSettings`, `src/ad-settings.ts`),
so each change-leg wait is bounded by the re-check interval plus 10 s.
Every time comes from the script's own polling, a shim line's time field,
a `server.log` line's ISO prefix, a stub record's `ts`, or a row's
`launch_started_at` or `ended_at`.

Matched values, each printed by `fixtures/fmk-texts.ts` from the installed
package:

| Value | Printer entry | `src/` |
|---|---|---|
| The nine `[tmux]` keys | `AD_TMUX_KEYS` | `src/ad-settings.ts` |
| The written values' minimums | `AD_SETTING_MINIMUMS <key>`, `pendingGraceMinimumSeconds` | `src/ad-settings.ts` |
| The defaults the grace minimum is taken at | `DEFAULT_AD_SETTINGS tmux <key>` | `src/ad-settings.ts` |
| The settings file's path, table names and pause key (read by `write_ad_settings`) | `AD_SETTINGS_RELATIVE_PATH`, `AD_TMUX_TABLE`, `AD_PAUSE_TABLE`, `AD_PAUSE_TIMEOUT_KEY` | `src/ad-settings.ts` |
| The values line's prefix | `AD_SETTINGS_LOG_PREFIX` | `src/ad-settings.ts` |
| The values lines | `buildAdSettingsValuesLine <path> <key>=<value>...` | `src/ad-settings.ts` |
| G, B and the alert threshold | `adGraceMs`, `adLaunchBoundMs`, `adAlertThresholdMs` | `src/ad-settings.ts` |
| B in whole minutes | `wholeMinutes <B>` | `src/ad-settings.ts` |
| The re-check interval | `AD_VERSION_RECHECK_INTERVAL_MS` | `src/ad-version-gate.ts` |
| The approver's paces before and from G, and the held leg's gap limit (their mean) | `DIALOG_POLL_INTERVAL_MS`, `DIALOG_SLOW_POLL_INTERVAL_MS` | `src/session-manager.ts` |
| The "still stopping" and "still starting" phrases | `STILL_STOPPING_PHRASE`, `STILL_STARTING_PHRASE` | `src/ad-description-phrases.ts` |
| The relaunching post for P | `formatPersonaNotice <P> stuckLaunchRelaunchingText <P's key> <B>` | `src/persona-notifier.ts`, `src/pending-row.ts` |
| The spawn-failed class | `STARTUP_ERROR_SPAWN_FAILED` | `src/session-manager.ts` |
| The stuck-launch abort's start line's fixed parts | `stuckLaunchAbortStartedLine <marker> <marker> <launch-start marker>` | `src/pending-row.ts` |
| The dead reading's fixed parts | `reprobeDeadLine <marker>` | `src/restart.ts` |
| The `reload-applied` line's class (`[slack] <class>:`) | `RELOAD_APPLIED` | `src/reload-apply.ts` |
| Q's sequence start line's fixed parts | `liveRowSequenceStartLine <Q's ref> LIVE_ROW_SEQUENCE_ENTRY_KILL <Q's id> <marker> launch <marker>` | `src/live-row-sequence.ts` |
| The step-2 wait's armed and end lines | `liveRowSequenceWaitArmedLine <Q's ref> <L> <G>`, `liveRowSequenceWaitEndedLine <Q's ref>` | `src/live-row-sequence.ts` |
| A run left in neither list | `liveRowSequenceRunLine <Q's ref> <step> <run> LIVE_ROW_RUN_NOT_JUDGED` | `src/live-row-sequence.ts` |
| The config file as the onset names it | `AD_CONFIG_FILE_DISPLAY_NAME` | `src/ad-config-file.ts` |
| The refused-read line's fixed parts | `buildAdSettingsRefusedReadLine <file> <marker> accepted` | `src/ad-settings.ts` |
| The onset's fixed parts, as posted for C | `formatPersonaNotice <C> adConfigMalformedOnset <marker>` | `src/persona-notifier.ts`, `src/outage-state.ts` |
| The all-clear, as posted for C | `formatPersonaNotice <C> ALL_CLEAR_TEMPLATE ad-config-malformed` | `src/persona-notifier.ts`, `src/outage-state.ts` |
| The raise line's fixed parts and the clear line | `adConfigMalformedRaisedLine <C's key> <marker>`, `adConfigMalformedClearedLine <C's key>` | `src/outage-state.ts` |
| The retry timer's first and longest waits | `UNAVAILABLE_RETRY_BASE_S`, `UNAVAILABLE_RETRY_CEILING_S` | `src/unavailable-retry.ts` |
| A stop's reasons: a pending-only retry read the row live; a retry found nothing left to recover | `UNAVAILABLE_RETRY_STOP_ROW_LIVE`, `UNAVAILABLE_RETRY_STOP_RECOVERED` | `src/unavailable-retry.ts` |
| The could-not-run line's prefix (none across a refusal) | `AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX` | `src/ad-version-gate.ts` |
| The re-armed reason of a retry read as unknown | `RESTART_OUTCOME_LIVENESS_UNKNOWN` | `src/restart.ts` |
| The retry timer's retry, re-armed and stop lines | `unavailableRetryRetryLine <C's key> <retry> full`, `unavailableRetryReArmedLine <C's key> <retry> full <marker> 0`, `unavailableRetryStoppedLine <C's key> pending-only waiting <UNAVAILABLE_RETRY_STOP_ROW_LIVE>`, `unavailableRetryStoppedLine <T1's key> full none <UNAVAILABLE_RETRY_STOP_RECOVERED>` | `src/unavailable-retry.ts` |
| The call-timeout legs' grace period (61) | `pendingGraceMinimumSeconds 40000 <default pipe_close_wait_ms>` | `src/ad-settings.ts` |
| The need and the verb whose ceiling sets it | `adCallTimeoutNeed <the call-timeout table>` | `src/ad-settings.ts` |
| The startup warning for 30000, and none for 61000 | `buildAdCallTimeoutWarningLine <30000\|61000> <the call-timeout table>` | `src/ad-settings.ts` |
| The launch-timeout phrase T2's answer carries | `LAUNCH_TIMEOUT_PHRASE` | `src/ad-description-phrases.ts` |
| The line of the get after a launch timeout, whole | `launchUnavailableGetLine <T's ref> spawn <ErrCallTimeout\|ErrTmuxUnresponsive> pending <the row's launch_started_at> LAUNCH_UNAVAILABLE_OUTCOME_APPROVER` | `src/session-manager.ts`, `src/ad-error-class.ts`, `src/pending-row.ts` |

C is the persona a refused-value leg adds (C1 or C2), and T is T1 or T2. A
marker the script passes in place of agent-director's description, the
reader's reason or a retry line's reason, or in place of a persona key, a
reference, a row state or an alert context (a short identifier) or a launch
start (an ISO time the lines render as given), splits a printed text into
the fixed parts around it.

Lines with no exported builder are matched by a fragment quoted from `src/`,
each with its source named beside it in the script: the refusal line and
its no-notice tail (`src/session-manager.ts` `logRefusal`), the latch line
(`src/conflict-latch.ts`), the stuck-launch line (`src/pending-row.ts`),
the relaunch-failed line and the liveness-unknown line (`src/restart.ts`),
the refused liveness read's line (`src/server.ts` `isSessionAlive`), the
collision ladder's `ErrInstanceIdCollision` line (`COLLISION_HEAD`,
`src/session-manager.ts` `spawnForPersona`), the start sweep's lines
(`src/session-manager.ts` `reconcileOrphans`) and the `ad-config-malformed`
class the all-clear lists (`src/outage-state.ts` does not export it; the
printer's `ALL_CLEAR_TEMPLATE` checks it is one of `OUTAGE_CLASS_ORDER`).
The get line's `spawn` (what that line calls a plain spawn,
`src/session-manager.ts` `spawnForPersona`) has no export and is quoted
too.

### The value printer

`tests/integration/fixtures/fmk-texts.ts` is the one value printer of the
fmk scenarios; its header comment is its full statement. A scenario script
cannot import TypeScript and never retypes a notice text, class label,
version or settings value that `src/` exports, so it asks the printer, which
prints the installed package's own export: a constant as it is, or a
builder's output for the given arguments.

- Usage: `bun "${SCENARIO_FIXTURES}/fmk-texts.ts" <entry> [<arg>...]`, run in
  the scenario's own shell (the printer is not a CSCB process, so not through
  `cscb_run`) and captured with a command substitution, the scenario failing
  when the printer fails. It prints the value byte for byte, with no trailing
  newline added.
- It reads the package from `CSCB_PKG_DIR` (default
  `/test-repo/node_modules/claude-slack-channel-bots`), which `scenario.sh`
  exports as the installed package under test
  (`$SCENARIO_REPO/node_modules/claude-slack-channel-bots`), and an entry
  that needs it, the agent-director client that package resolves.
- Failures print one `FAIL: fmk-texts: <reason>` line on stderr: exit 64 for
  no entry, an unknown one or arguments the entry does not take; exit 1 for
  a missing or mistyped export or a builder that throws. Without the image
  marker it exits 2 (see Image marker); `tests/host-safety.test.ts`'s marker
  audit covers it.
- It makes no agent-director call, starts no process or server, opens no
  socket, reads no token and writes no file.
- Its entries sit in one named map (`ENTRIES`), each named after the `src/`
  export it prints. A scenario that needs another value adds a named entry
  there; there is never a second printer.

| Entry | Prints | `src/` |
|---|---|---|
| `PHASE1_FLOOR_VERSION` | the Phase 1 floor | `src/ad-version-gate.ts` |
| `AD_BELOW_PHASE1_FLOOR` | the class label | `src/install-check-labels.ts` |
| `buildBelowPhase1FloorMessage <found-version> <binary-path> <startup\|runtime>` | the floor message in the startup or runtime form | `src/ad-version-gate.ts` |
| `RUNTIME_RECHECK_PHRASE` | the runtime re-check phrase | `src/ad-version-gate.ts` |
| `AD_VERSION_RECHECK_INTERVAL_MS` | the re-check interval, in decimal | `src/ad-version-gate.ts` |
| `AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX` | the could-not-run line's prefix | `src/ad-version-gate.ts` |
| `INVALID_FLAGS_HOLD_ALERT_TEXT` | the Cannot launch alert's body | `src/invalid-flags-hold.ts` |
| `formatPersonaNotice <persona-name> <entry> [<arg>...]` | another entry's value as posted in that persona's notice | `src/persona-notifier.ts` |
| `classifyAdError <err-name>` | CSCB's class for the installed client's error class `<err-name>`, built from an envelope | `src/ad-error-class.ts` |
| `DEFAULT_AD_SETTINGS <table> <key>` | agent-director's default for `[<table>] <key>`, in decimal; an unknown table or key exits 64 | `src/ad-settings.ts` |
| `CLIENT_DEV_SENTINEL_VERSION` | the client's development sentinel version | `src/ad-version-gate.ts` |
| `AD_SYSTEM_INSTALL_UNREACHABLE` | the class label | `src/install-check-labels.ts` |
| `UNREACHABLE_REASON_UNPARSEABLE_VERSION` | the `ErrSystemInstallUnreachable` reason of a version that does not parse | `src/ad-version-gate.ts` |
| `meetsPhase1Floor <version>` | whether `<version>` meets the Phase 1 floor: `true` or `false` | `src/ad-version-gate.ts` |
| `AD_SETTINGS_LOG_PREFIX` | the prefix of the settings reader's log lines | `src/ad-settings.ts` |
| `buildAdSettingsValuesLine <path> [<key>=<integer>...]` | the values line for the settings file `<path>`: the nine `[tmux]` values, `DEFAULT_AD_SETTINGS`' own but for each given `<key>` | `src/ad-settings.ts` |
| `AD_SETTINGS_RELATIVE_PATH` | the settings file's path relative to a HOME | `src/ad-settings.ts` |
| `AD_TMUX_TABLE` | the timing keys' table name | `src/ad-settings.ts` |
| `AD_PAUSE_TABLE` | `pause`'s table name | `src/ad-settings.ts` |
| `AD_PAUSE_TIMEOUT_KEY` | `pause`'s wait key | `src/ad-settings.ts` |
| `AD_TMUX_KEYS` | the nine `[tmux]` keys, in order, joined by single spaces | `src/ad-settings.ts` |
| `AD_SETTING_MINIMUMS <key> [<part>]` | agent-director's minimum for `[tmux] <key>`, in decimal; for a minimum with parts (`pending_grace_seconds`), the named `<part>` (`floor` or `addend`) | `src/ad-settings.ts` |
| `pendingGraceMinimumSeconds <create-timeout-ms> <pipe-close-wait-ms>` | the grace period's minimum, in decimal | `src/ad-settings.ts` |
| `adGraceMs [<key>=<integer>...]` | G, in decimal | `src/ad-settings.ts` |
| `adAlertThresholdMs [<key>=<integer>...]` | the alert threshold, in decimal | `src/ad-settings.ts` |
| `adLaunchBoundMs [<key>=<integer>...]` | B, in decimal | `src/ad-settings.ts` |
| `wholeMinutes <ms>` | `<ms>` in whole minutes, rounded down | `src/ad-settings.ts` |
| `STILL_STOPPING_PHRASE` | the phrase an `ErrTmuxUnresponsive` carries for a row that still appears to be stopping | `src/ad-description-phrases.ts` |
| `STILL_STARTING_PHRASE` | the phrase an `ErrTmuxUnresponsive` carries for a row that still appears to be starting | `src/ad-description-phrases.ts` |
| `stuckLaunchRelaunchingText <persona-key> <launch-bound-ms>` | the stuck-launch post's relaunching text for that persona key and B (posted as a persona notice: wrap it in `formatPersonaNotice`) | `src/pending-row.ts` |
| `DIALOG_POLL_INTERVAL_MS` | the dialog approver's pace before G, in decimal | `src/session-manager.ts` |
| `DIALOG_SLOW_POLL_INTERVAL_MS` | the dialog approver's slow pace from G, in decimal | `src/session-manager.ts` |
| `STARTUP_ERROR_SPAWN_FAILED` | the startup-errors class a failed start-pass launch writes | `src/session-manager.ts` |
| `liveRowSequenceWaitArmedLine <persona-ref> <launch-start-ms> <grace-ms>` | the step-2 wait's armed line for that persona ref (`"<name>" (key=<key>)`), launch start in epoch milliseconds and G | `src/live-row-sequence.ts` |
| `liveRowSequenceWaitEndedLine <persona-ref>` | the step-2 wait's end line | `src/live-row-sequence.ts` |
| `liveRowSequenceRunLine <persona-ref> <step> <run-number> <placement-export>` | the sequence's line for one `find-missing` run at step 3 or 4, with the placement the package exports as `<placement-export>` (a `LIVE_ROW_RUN_…` name) | `src/live-row-sequence.ts` |
| `AD_CONFIG_FILE_DISPLAY_NAME` | the settings file as a notice names it (`~/…`) | `src/ad-config-file.ts` |
| `adConfigMalformedOnset <description>` | the `ad-config-malformed` onset for agent-director's `ErrConfigMalformed` answer with `<description>`, built as the installed client throws it (its `ErrUnknownErrorName`; a client with a class of that name fails); posted as a persona notice: wrap it in `formatPersonaNotice` | `src/outage-state.ts` |
| `adConfigMalformedRaisedLine <persona-key> <description>` | the server-log raise line for that answer, classified by `classifyAdError` | `src/outage-state.ts`, `src/ad-error-class.ts` |
| `adConfigMalformedClearedLine <persona-key>` | the server-log clear line | `src/outage-state.ts` |
| `ALL_CLEAR_TEMPLATE <outage-class>...` | the all-clear for a bad stretch of the given classes, each one of the package's `OUTAGE_CLASS_ORDER`, given once, none with a detail; posted as a persona notice: wrap it in `formatPersonaNotice` | `src/outage-state.ts` |
| `buildAdSettingsRefusedReadLine <path> <reason> <accepted\|none>` | the line of a run of refused reads of `<path>`, `accepted` when a read was accepted before it, `none` when not | `src/ad-settings.ts` |
| `UNAVAILABLE_RETRY_BASE_S` | the retry timer's first wait (its waits double from it), in seconds, in decimal | `src/unavailable-retry.ts` |
| `unavailableRetryRetryLine <persona-key> <retry> <full\|pending-only>` | the line at the start of retry `<retry>` of the persona's retry timer, in that mode | `src/unavailable-retry.ts` |
| `unavailableRetryReArmedLine <persona-key> <retry> <full\|pending-only> <reason> <wait-ms>` | the re-armed line of that retry, answered `<reason>`, the mode unchanged, the next retry in `<wait-ms>` | `src/unavailable-retry.ts` |
| `RESTART_OUTCOME_LIVENESS_UNKNOWN` | the restart work's outcome, and a retry's again-reason, when the persona's liveness reads unknown | `src/restart.ts` |
| `unavailableRetryStoppedLine <persona-key> <full\|pending-only> <row\|none> <reason>` | the line of a stop of the persona's retry timer, in that mode, naming the row read (`none`: no row) | `src/unavailable-retry.ts` |
| `UNAVAILABLE_RETRY_CEILING_S` | the retry timer's longest wait, in seconds, in decimal | `src/unavailable-retry.ts` |
| `buildAdCallTimeoutWarningLine <call-timeout-ms> [<key>=<integer>...]` | the startup call-timeout warning for that call timeout and the values in effect; the empty text when the builder gives no line | `src/ad-settings.ts` |
| `adCallTimeoutNeed [<key>=<integer>...]` | `<need-ms> <verb>`: the call timeout's need, in decimal, and the verb whose ceiling sets it | `src/ad-settings.ts` |
| `LAUNCH_TIMEOUT_PHRASE` | the phrase an `ErrTmuxUnresponsive` carries when it ends a launch call as a launch timeout | `src/ad-description-phrases.ts` |
| `AD_VERSION_RECHECK_STOP_EXIT_CODE` | the exit status of the runtime re-check's stop, in decimal | `src/ad-version-gate.ts` |
| `launchUnavailableGetLine <persona-ref> <what> <err-name> <read> <launch-start\|no> <outcome-export>` | the line of the one get after the `<what>` of `<persona-ref>` ended in a launch timeout of the form `<err-name>` (one of the package's `LAUNCH_TIMEOUT_FORM_…` values, named as `launchUnavailableFormText` names it), the get reading `<read>`; this launch's row has the launch start `<launch-start>`, the row's `launch_started_at` as agent-director wrote it, read with `parseLaunchStart` (`no`: not this launch's row); the outcome the package exports as `<outcome-export>` (a `LAUNCH_UNAVAILABLE_OUTCOME_…` name) | `src/session-manager.ts`, `src/ad-error-class.ts`, `src/pending-row.ts` |
| `UNAVAILABLE_RETRY_STOP_ROW_LIVE` | a stop's reason when a pending-only retry reads the row live | `src/unavailable-retry.ts` |
| `UNAVAILABLE_RETRY_STOP_RECOVERED` | a stop's reason when a retry finds nothing left to recover | `src/unavailable-retry.ts` |
| `stuckLaunchAbortStartedLine <persona-key> <persona-ref> <launch-start>` | the stuck-launch abort's start line, `<launch-start>` as a row's `launch_started_at` (the line renders it) | `src/pending-row.ts` |
| `reprobeDeadLine <persona-key>` | the line of a row the re-probe reads dead | `src/restart.ts` |
| `liveRowSequenceStartLine <persona-ref> <entry-step-export> <instance-id> <last-read> <launch\|no-launch> <alert-context>` | the live-row sequence's start line, entered at the step the package exports as `<entry-step-export>` (a `LIVE_ROW_SEQUENCE_ENTRY_…` name), ending in a launch or not | `src/live-row-sequence.ts` |
| `RELOAD_APPLIED` | the class label of an applied reload's line | `src/reload-apply.ts` |

`adGraceMs`, `adAlertThresholdMs`, `adLaunchBoundMs`, `adCallTimeoutNeed`
and `buildAdCallTimeoutWarningLine` take the values in effect built from
their `<key>=<integer>` arguments: the `[tmux]` values, `DEFAULT_AD_SETTINGS`'
own but for each given `<key>`, and `DEFAULT_AD_SETTINGS_IN_EFFECT`'s
`pauseTimeout`. In every `<key>=<integer>` argument `<key>` is one of the
package's `AD_TMUX_KEYS`; an unknown key, a key given twice or a value that
is not an integer exits 64.

Given a marker in place of `<description>` or `<reason>`,
`adConfigMalformedOnset`, `adConfigMalformedRaisedLine` and
`buildAdSettingsRefusedReadLine` print a text whose parts around the marker
are its fixed parts; `unavailableRetryReArmedLine` and
`unavailableRetryStoppedLine` print one whose part before the marker is the
line's fixed head. More generally, a builder entry given a marker argument
(a key, a reference, a state or a description the scenario chooses) prints
a line whose text around the marker is the line's fixed part; the scenario
splits it there.

### Harness-only steps

The harness plays a human's acts with the helpers below (b.jg5 SRJ-1306,
SRJ-1401). Each step is test-only and runs only in fmk mode inside the
image. It is made from the scenario's own shell (a subshell of it, such as a
command substitution, counts as that shell), never by a CSCB process, and
acts only on the scenario's own tmux server and store. `scenario.sh`'s
header gives each helper's arguments and output.

Every helper runs `require_ci_image` and then `require_scenario_home`
first. The tmux steps and the seeders run the real tmux (never the tmux
shim) on the scenario's server, and refuse when `TMUX_TMPDIR` is not the
scenario's or `TMUX` is set. Each step reads its effect back (the session,
pane, option, server, row or log it changed) and fails, through `fail`,
when the effect is absent. None reads a pane's text. A `<session>` argument
is a session id (`$N`) or a session name matched exactly, never as a prefix
of another session's.

| Step (SRJ-1306) | Helper |
|---|---|
| A leftover: a session labelled with an earlier launch of an instance id | `seed_leftover` |
| A session with no label | `seed_unlabelled` |
| A session with no label whose environment holds only `AGENT_DIRECTOR_INSTANCE_ID` | `seed_env_only` |
| Another row's session holding a persona's session name | `seed_borrowed_name` |
| Another agent-director store's session (its label ends with another 16-hex store id) | `seed_other_store` |
| A persona's own session relabelled, in `@ad_owner` and its worker pane's `@ad_pane`, with an earlier launch's token | `relabel_session` |
| A grouped viewer session on a persona's session | `attach_viewer` |
| Renaming a session | `rename_session` |
| `remain-on-exit` on for one session | `set_remain_on_exit` |
| Setting and unsetting a global `@ad_owner` value (conflicting labels) | `ad_owner_global_set`, `ad_owner_global_unset` |
| Sending Enter into a stub's pane held at a startup dialog | `stub_press_enter` (see The stub worker) |
| Respawning a worker's pane with another process | `respawn_worker_pane` |
| Restarting the scenario's tmux server | `restart_tmux_server` |
| Re-binding its socket path while the old server runs | `rebind_tmux_socket` |
| Scenario 10 part B's store statement | `ad_store_mark_finished` |
| Scenario 19's `pending` row beside a leftover | `ad_store_seed_pending` |
| Scenario 25's unusable recorded name | `ad_store_unusable_name` |
| Scenarios 20 and 26's `pending` row with no launch start | `ad_store_pending_no_launch` (see The stub worker) |
| A human ending a leftover or a hand-made session by its session id | `end_session` |
| A human's finished-row kill, agent-director-admin's `kill-finished` (scenario 10) | `ad_kill_include_finished` |
| A human's agent-director-admin `delete` of the row with the unusable name (scenario 25) | `ad_delete_unusable_row` |
| The host's `find-missing` loop | `run_find_missing_loop` |

The step that set `base-index` is withdrawn: no agent-director verb depends
on pane indices, and no helper sets it.

The label builders the seeding steps use are helpers too: `ad_new_token`
(a fresh 16-hex launch token, other than the row's current one and any
given), `ad_other_store_id` (a 16-hex id other than the scenario store's),
`ad_owner_label` (`ad1 <token> <session id> <instance id> <store id>`, the
store id the scenario store's unless given) and `ad_pane_label`
(`<token> <pane id>`).

The seeding helpers (`seed_leftover`, `seed_unlabelled`, `seed_env_only`,
`seed_borrowed_name`, `seed_other_store`) each run `new-session -d` with the
given worker command, in `-c <dir>` (default `SCENARIO_ROOT`). They refuse a
name that is taken or holds `.`, `:` or a control character. Each prints
`<session id> <pane id>`, then the token and store id for a labelled
session, and sets `SEEDED_SESSION_ID`, `SEEDED_PANE_ID`, `SEEDED_TOKEN` and
`SEEDED_STORE_ID`, which a call inside `$( … )` does not keep.

#### Seeding rules

Every seeding and relabelling helper follows SRJ-1306's seeding rules
(agent-director's handoff rev 15 and rev 17):

- Every `@ad_owner` label the harness seeds or relabels ends with the
  scenario store's own store id, which `ad_store_id` reads from the store's
  `store_meta` table. The exception is `seed_other_store`, whose label ends
  with an `ad_other_store_id` id: agent-director reads a label with another
  id as another store's and never acts on it.
- Every leftover the harness seeds or relabels carries `@ad_pane` =
  `<the label's token> <the pane's id>` on its worker's pane, as a leftover
  agent-director made does. agent-director finds a leftover's pane only
  through that label; without it `read-pane` answers "the agent's pane was
  not found".
- A session seeded by hand for agent-director to adopt after a lost create
  reply would carry `@ad_pane` = `<the row's launch token> <the pane's id>`.
  No scenario seeds one, so no helper makes one.
- A scenario whose launch loses its create reply (the tmux shim's
  `slow-create`) runs the stub in a mode that waits for the approver's Enter
  before it reports in (`dev-channels`, the default): agent-director applies
  no hook to a row whose pane it has not adopted, and the approver's
  `send-keys` adopts it.

#### Store statements

Each statement is one `ad_store_edit` UPDATE that names the row by its
instance id and by its `row_version` as read just before, so an
agent-director write in between leaves the row unwritten and the step
failing. The row is read before and after, and the step fails unless the
columns below hold their new values and every other column keeps its old
one.

| Helper | Scenario | Columns it changes |
|---|---|---|
| `ad_store_mark_finished <id> <missing\|ended>` | 10 part B (SRJ-1412); 8 (SRJ-1410), in test-20's 8d and 8e | `state` to `missing` or `ended`; `ended_at` to now minus the stopping window, in whole seconds, in the store's `YYYY-MM-DD HH:MM:SS` UTC layout; `launch_started_at` NULL; `row_version` + 1. Prints the `ended_at` written |
| `ad_store_seed_pending <id> [<leftover-token>]` | 19 (SRJ-1420) | the existing row made `pending`, as a spawn whose process stopped before its create leaves it: `state` `pending`; `launch_started_at` now, in milliseconds; `launch_token` a fresh token other than the row's current one and the leftover's; `ended_at`, `pid`, `proc_starttime`, `tmux_server_pid`, `tmux_server_started`, `tmux_server_starttime`, `pane_id`, `pane_pid` and `pane_starttime` NULL; `row_version` + 1. A harness `status` read must then read `pending` with a launch start. Prints the token |
| `ad_store_unusable_name <id> <name>` | 25 (SRJ-1427) | only `tmux_session_name`, to a `<name>` holding a `.` and only letters, digits and `._-`, on an `ended` or `missing` row; `row_version` kept |
| `ad_store_pending_no_launch <id>` | 20 and 26 | `state` `pending`; `launch_started_at`, `launch_token`, `pid`, `proc_starttime`, `pane_id`, `pane_pid` and `pane_starttime` NULL; `row_version` + 1. A harness `status` read must then read `pending` with no launch start |

`ad_store_mark_finished` reads the stopping window from `[tmux]
stopping_window_seconds` in `$HOME/.agent-director/config.toml`, or uses
agent-director's default, 90 s, without one. It refuses while the worker's
session is younger than that window: the `ended_at` it writes must be later
than the session's creation.

#### The human's agent-director actions

- `end_session <session id>` ends a leftover or a hand-made session with
  `kill-session` and fails unless it is gone.
- `ad_kill_include_finished <id>` is the human's finished-row kill,
  agent-director-admin's `kill-finished` (agent-director's own `kill` takes
  no `--include-finished`), made through `ad_admin_capture` as a direct child of the shell that calls it,
  so `assert_no_cscb_include_finished` accepts it.
  It sets `AD_KILL_OUT`, `AD_KILL_ERR` and `AD_KILL_RC`, prints the output,
  and fails on a non-zero exit, on a result without `kill_sent`, or when the
  shim's log holds no new line for the call. agent-director-admin refuses this
  kill on a live row, so the row must read `ended` or `missing` first (as
  `ad_store_mark_finished` leaves it). It also refuses until the session is
  at least the starting-session bound old: `[tmux]
  starting_session_seconds`, 300 s by default and 60 s at its minimum. A
  scenario that uses it sets a smaller bound in its `[tmux]` table
  (scenario 10) or waits 300 s.
- `ad_delete_unusable_row <id>` is scenario 25's step, a human removing the
  row whose recorded name `ad_store_unusable_name` made unusable. It refuses
  unless that name holds a `.`, and fails unless agent-director-admin's
  `delete` (through `ad_admin_capture`) exits 0 reporting the id `ok` and
  the row is gone. It is the only agent-director `delete` under
  `tests/integration`: no fixture calls `delete`, and
  `tests/host-safety.test.ts` audits that statically.

#### The find-missing loop

`run_find_missing_loop [<interval-s>]` plays the host's `find-missing` loop,
for a latched persona's row only (SRJ-1401): CSCB makes no extra call for a
latched persona, so the loop marks its row `missing` or clears a
`provenance_conflict` note. An unlatched persona's row is marked by CSCB's
own pending-row runs, and the harness runs no loop for it.

- The interval defaults to `SCENARIO_FIND_MISSING_INTERVAL_S`, 30 s in
  `/ci`; the host's loop runs every 300 s.
- The loop is a background subshell of the scenario's shell, registered
  with `track_pid`. It runs `find-missing` with no arguments through `ad`,
  then sleeps the interval, until it is stopped or the trap ends it. It
  refuses to start while a loop runs.
- Each run writes `run.<n>.out` and `run.<n>.err` and one line,
  `run <n> TAB start <time> TAB end <time> TAB exit <status>`, followed by
  its output indented (`  out| `, `  err| `), to `FIND_MISSING_LOOP_LOG`
  (`$SCENARIO_ROOT/find-missing-loop/loop.log`). It sets
  `FIND_MISSING_LOOP_PID` and `FIND_MISSING_LOOP_INTERVAL_S`.
- Its calls' parent is the loop subshell, whose command line is the
  script's own, so `cscb_ad_calls` and `cscb_ad_count` count none of them.
- `stop_find_missing_loop [<timeout-s>]` stops it (default 30 s; a run in
  flight finishes first). `find_missing_loop_runs` prints how many runs the
  log holds, and `wait_find_missing_runs <n> [<timeout-s>]` waits for `<n>`
  more (default `<n>` intervals plus 60 s), failing early when the loop
  stops.

#### The 0.10.0 seeders

A script that sets `SCENARIO_AD_START=0.10.0` before sourcing starts on
agent-director 0.10.0 (`install_ad_010`) with no store; 0.10.0's first
`spawn` creates it. The seeders make 0.10.0-era rows in that store, before
the release's install (`install_ad_release`) migrates it. Both refuse
unless the binary behind the shim reports 0.10.0, no `install_ad_release` has run
in the shell, and the store, if any, has no `store_meta` table.

- `seed_010_row <id> <session-name> <dir> [<key>=<value>...]` makes one row
  with 0.10.0's own `spawn`, through `ad_capture` from the scenario's shell,
  with a `--label` per `<key>=<value>`. Its worker is the stub in the mode
  selected for `<dir>`, `at-once` unless the caller chose another with
  `stub_mode` first; 0.10.0's hooks are shell form, and the stub fires them
  from their words. In `at-once` it waits (`SCENARIO_SEED_REPORT_S`, 60 s)
  until the row reports in to a live state. Prints `<id> <session-name>
  <session id> <pane id>`.
- `seed_prepersona_fleet <config.json> <channel-id>=<slack-name>...` makes
  one `seed_010_row` per channel the pre-persona config's `routes` names, in
  its order, in that route's `cwd` (`~` expanded; it must be absolute). It
  names and labels each row as the published pre-persona package (0.10.0)
  does: instance id `cscb_<name>_<channel id>`, session
  `slack_bot_<name>_<channel id>`, labels `service=cscb` and
  `channel=<channel id>`, and no `persona` label. `<name>` is the channel's
  Slack name normalized as that package does: lowercased, each run of
  characters other than `a-z` and `0-9` turned into one `_`, leading and
  trailing `_` dropped; a name that normalizes to nothing gives
  `cscb_<channel id>` and `slack_bot_<channel id>`. The package reads the
  name from Slack, never from `config.json`, so the caller passes one per
  routed channel (ASCII only). Every route is checked before the first row
  is made. Prints one line per row, `<channel id> <instance id> <session
  name> <session id> <pane id>`.

After `install_ad_release` the rows are kept, with no `launch_started_at`, and
their workers still run; the seeders then refuse.

### The stub worker

`fixtures/stub-claude.sh` stands in for `claude` in every script that
launches through the real agent-director (Test 4, Tests 10 and 12, every fmk
script). Its header comment is the full statement; this is the part every
scenario relies on (b.jg5 SRJ-1306).

Modes. The stub's working directory, by its real path, selects its mode.
`stub_mode <dir> <mode>` adds the selection to `stub-claude-modes` beside the
stub in `SCENARIO_BIN` (fmk mode only; `<dir>` must be a directory under
`SCENARIO_ROOT`); the last selection of a directory wins, and a stub reads it
when it starts, so it holds from the next launch or resume there. The mode
names are `scenario.sh` constants:

| Mode | Constant | What the stub does |
|---|---|---|
| `dev-channels` | `STUB_MODE_DEV_CHANNELS` | Prints the dev-channels dialog, which CSCB's approver answers, and reports in on the Enter. A directory with no selection, and a stub with no selection file beside it (Tests 4, 10 and 12), runs this mode |
| `at-once` | `STUB_MODE_AT_ONCE` | Reports in at once |
| `silent` | `STUB_MODE_SILENT` | Prints nothing and never reports in; its exit sentinel fires no SessionEnd |
| `unrecognised-dialog` | `STUB_MODE_UNRECOGNISED` | Prints a startup dialog that neither of the approver's needles matches, so CSCB never answers it, and reports in once Enter reaches its pane: the harness's `stub_press_enter <target>`, a human answering (scenarios 20 and 21) |
| `folder-trust` | `STUB_MODE_FOLDER_TRUST` | Reports in at once when its folder is trusted in `<CLAUDE_CONFIG_DIR>/.claude.json`, or in `~/.claude.json` when `CLAUDE_CONFIG_DIR` is unset or empty; otherwise prints the folder-trust prompt and reports in once it is answered by Enter (scenario 22) |
| `linger-on-exit` | `STUB_MODE_LINGER_ON_EXIT` | Reports in at once. On the `/exit` line agent-director's `pause` types, it marks itself lingering, fires every SessionEnd hook (the row reads `ended`), stops its re-fire and ends its MCP session, then keeps running, its pane and session with it, as a Claude Code still shutting down does, until `stub_release` or its stdin closing. Before it has reported in, `/exit` is ignored (scenarios 24 and 13) |

`stub_press_enter <target>` sends Enter with the real tmux, from the
scenario's own shell, into a pane on the scenario's tmux server: a pane id is
used as given, and a session name is matched exactly, never as a prefix of
another session's. It fails with tmux's message when tmux refuses, and
refuses when `TMUX` is set or `TMUX_TMPDIR` is not the scenario's.

`stub_release <target> [<timeout-s>]` ends a stub lingering in
`linger-on-exit`: it reads the pane's process with the real tmux, from the
scenario's own shell (the pane named as for `stub_press_enter`), sends it
SIGUSR1 and fails unless it is gone within `<timeout-s>`
(`SCENARIO_STUB_RELEASE_S`, 10 s, by default). Before any signal it refuses
unless that process is a stub lingering in `linger-on-exit`, which a
lingering stub shows by its marker `stub-claude-lingering.<pid>` beside it
in `SCENARIO_BIN`; it refuses, as `stub_press_enter` does, when `TMUX` is
set or `TMUX_TMPDIR` is not the scenario's.

A scenario whose launch loses its create reply (`slow-create`) keeps a mode
that waits for the approver's Enter, as the default does: agent-director
applies no hook to a row whose pane it has not adopted, and the approver's
`send-keys` adopts it before the stub reports in.

Hooks. To report in, the stub fires every SessionStart hook its `--settings`
registers; its exit sentinel `__CSCB_TEST_EXIT__` fires every SessionEnd hook.
Each hook runs as a direct child of the stub's process, the pane's main
process, with its payload on standard input and no `agent_id` in it, never
through a shell. An exec-form entry runs `command` with its `args`; an entry
with no `args` (agent-director 0.10.0's shell form) runs the words of its
`command`. An entry's `timeout` is not acted on.

The SessionStart re-fire. In every mode that reports in, whatever made it
report in (at once, a trusted folder, Enter at a dialog, a resume), the stub
then reads its own row every 2 s and fires SessionStart again while the row
reads `pending`, until G has passed since the row's launch start.

- It reads the row with `status --claude-instance-id <id>`, run with the
  program its first registered SessionStart hook names. Under the release
  candidate's hooks that is the real binary, so the reads bypass the
  agent-director shim. The id is `AGENT_DIRECTOR_INSTANCE_ID`, which
  agent-director puts in the worker's environment; the hooks' `args` carry
  none.
- G is `[tmux] pending_grace_seconds` in the scenario HOME's
  `.agent-director/config.toml`, read at every tick; with no such value it is
  agent-director's default, 60 s.
- A row that reads another state, or `pending` past G, ends the re-fire with
  nothing written.
- A failed read (no instance id, a non-zero exit, output that is not a status
  object, a launch start that is not a time), or a row that reads `pending`
  with no launch start, ends the re-fire too: the stub fires nothing more and
  writes one stop line. `ad_store_pending_no_launch <instance-id>` makes such
  a row from a live one, with one store edit, and checks it reads so.

The stop line is the agent-director shim's line format with kind `stop`; its
words are `stub-claude stopped re-firing SessionStart for instance <id>:
<why>`. It is appended to `agent-director-shim.log` beside the binary the
reads run, the shim's log in an fmk HOME, or written to the stub's standard
error where no such file exists (Tests 4, 10 and 12). A reader of invocations
takes only `call` lines, so a stop line never counts as a call.

The MCP session. Once it has reported in, the stub opens an MCP session to
the bot server, as the real `claude` does, and holds it until the stub ends,
so the server registers it as the persona's session and a health tick reads
the persona connected. The session is `stub-mcp-session.ts`, run with bun as
the stub's child, which reads the stub's `--mcp-config`, connects with the
package's own MCP SDK as client `stub-claude` version `0.0.0-stub`, and
answers the server's roots request with the stub's working directory, by
which the server matches the persona. It ends with the stub (its exit, a
kill, the pane's hang-up), so a stopped persona reads not connected; when the
server ends it, a later `/mcp reconnect` in the pane opens a new one. Its
lines go to `stub-mcp-session.log` beside the stub. No session is opened in
a mode that has not reported in, without `--mcp-config`, or where the client
is not beside the stub (Tests 4, 10 and 12, which copy only the stub and run
with `health_check_interval` 0).

None of the stub's lines or calls is CSCB's: its hooks, its `status` reads
and its MCP session are children of the stub, never of a CSCB process, so
`cscb_ad_calls`, `cscb_ad_count` and the closing assertions never count them.

### Slack stub

`tests/integration/fixtures/slack-stub-server.ts` is a Bun HTTP and WebSocket
server on 127.0.0.1 that stands in for Slack, because real Slack is not
reachable in the container. Test 0, Tests 10 and 12 and the fmk scenarios
start it in the background and point the server at it through the Slack API base URL override, an environment
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
- A line's `text` has token-like text replaced by `<token>` before it is
  written. A `chat.postMessage` text is then recorded whole, so a scenario
  compares a posted notice in full (Test 20's Cannot launch alert); every
  other method's `text` is cut to at most 300 characters.
- It has no `bun test` suite of its own; Test 10 exercises it end to end,
  and Test 20's whole-text checks exercise its `chat.postMessage` record.

A live start also launches each persona through the real agent-director
under the stub `claude` (see The stub worker), and stops with `--stop-bots`.
Tests 10 and 12 put `fixtures/stub-claude.sh` first on `PATH` as `claude`
themselves, as Test 4 does; an fmk script's start finds the copy `scenario.sh`
put first on its PATH, with the stub's MCP session client beside it.

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
   A self-describing scenario with no ticket (as Test 0 and Tests 5 onwards) skips this
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
   non-zero. Follow the helper's contract (see Scenario helper). Nothing but
   the shebang, comments, `set` options and literal assignments may come
   before the source line: the helper's image-marker check must be the
   script's first step (`tests/host-safety.test.ts` checks this). A script
   that does not source the helper starts with its own marker check instead,
   as Tests 1 to 4 do.

   An fmk scenario is named `test-N-fmk-<short-name>` (`TEST_NAME` carrying
   `-fmk-`). Sourcing the helper then gives it its own HOME, agent-director
   install and store, tmux server and shim (see fmk mode under Scenario
   helper), on the release. To start on agent-director 0.10.0, set
   `SCENARIO_AD_START=0.10.0` on its own line before the source line. It
   follows Rules for every fmk scenario and ends with the three closing
   assertions, in the script's own shell, before its PASS line:
   ```bash
   # ... start_server --live, cscb_run, ad / ad_capture as the human, assertions, stop_server ...
   assert_no_server_tmux
   assert_no_cscb_include_finished
   assert_no_cscb_delete
   echo "PASS: ${TEST_NAME}"
   ```
3. Make it executable. The runner picks it up by name and runs every
   `test-*.sh` through `bash`, so the mode bit is not what makes it run;
   don't edit `tests/runner.sh`.
4. Name the script in the Layout above, in the same change, by its whole file
   name with a one-line comment on what it checks. `tests/shipped-docs.test.ts`
   (b.jg5 SRJ-1112) fails while any `tests/integration/test-*.sh` on disk is
   not named in this README. When a script is removed, record it here by its
   test number and what replaces it, never by its file name: the same check
   fails on a `test-<n>-<name>.sh` this README names that is not on disk (the
   `test-N-<short-name>.sh` template above names no script).
5. Run `shellcheck tests/integration/*.sh tests/integration/lib/*.sh tests/runner.sh`
   from the repo root. `tests/integration/.shellcheckrc` lets shellcheck follow
   the helper without `-x`. The suite must stay warning-free.

### What does NOT belong in a test script

- Anything requiring LLM judgment ("did this response look reasonable").
- Pane scraping, tmux capture, JSONL transcript parsing. Whose call a shim
  log line records is read from its parent process (the closing assertions,
  `cscb_ad_calls`, `cscb_ad_count`), never from a pane. The harness's tmux
  steps (see Harness-only steps) play the human; they are never assertions
  made by reading a pane's text.
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
