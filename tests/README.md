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
- `fixtures/fmk-driver.ts` and `fixtures/stub-mcp-session.ts`: the first
  statement of each checks the marker and exits 2 before it reads an argument
  or loads a module; each statically imports only `node:` built-ins.
  (`fixtures/phase1-client-check.ts` also refuses to run without the marker.)
- `fixtures/fmk-texts.ts`: the same first statement, exiting 2 before it
  reads an argument or loads a module; it statically imports only `node:`
  built-ins and loads the installed package only after the check.
- Every `scenario.sh` step that installs, moves or swaps an agent-director
  binary or the shim, every harness agent-director call (`ad`, `ad_capture`, `ad_admin`, `ad_admin_capture`),
  every harness `sqlite3` read or edit (`ad_store_edit`, `ad_store_id`,
  `ad_store_pending_no_launch`) and every stub-worker helper (`stub_mode`,
  `stub_press_enter`, `write_mcp_config`) calls `require_ci_image` as its
  first step, which fails with
  `FAIL: <test>: <step>: refused: /etc/cscb-ci-image is absent …`.

The same helpers then call `require_scenario_home`, which refuses unless
`SCENARIO_ROOT` is a directory and HOME is under it, both as written and by
real path (a HOME that is a symlink out of `SCENARIO_ROOT` is refused). The
copy-and-rename every install and swap goes through also refuses a
destination outside `SCENARIO_ROOT`. No harness step touches the invoking
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
                                   # real tmux; fail-kill limited to a target list failing only the kills aimed at a listed target, and the setter's refusals
                                   # (`fail_kill_targets`); a live one-persona start whose dialog the approver clears through agent-director, with no tmux line whose parent is
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
    test-14-fmk-kill-fails.sh      # HO §7 scenarios 16, 2 and 15, in that order (b.jg5 SRJ-1403, SRJ-1417), fmk: a kill that really fails deletes and launches
                                   # nothing; with the tmux shim in fail-kill, for pre-persona rows seeded on 0.10.0 met at an upgrade's first start, a persona
                                   # removed from the config at a start, a config_dir mismatch, a cwd mismatch and a persona removed while the server runs, each kill
                                   # answers ErrTmuxKillFailed, the row is kept and one alert is routed per SRJ-704 (see fmk scenario list)
    test-18-fmk-wedged.sh          # HO §7 scenario 6 (b.jg5 SRJ-1408), fmk: a wedged tmux causes no destructive action, one alert per persona and one recovery;
                                   # with the tmux shim in wedge, the wedged start is delayed by at most one row's retries (AC 56), and each kept persona gets at
                                   # most one onset, one alert past the threshold, no cap and one recovery once tmux answers again (see fmk scenario list)
    lib/
      scenario.sh                  # shared helper sourced by Test 0 and Tests 5 onwards (see Scenario helper below)
    fixtures/
      agent-director-shim.sh       # the logging agent-director shim of fmk mode: logs each call's argv and parent, then execs the real binary beside it
      tmux-shim.sh                 # the logging tmux shim of fmk mode, first on the PATH of every CSCB process: logs each call's argv and parent, then acts on its
                                   # mode (log, fail-kill, fail-create, slow-create, wedge); fail-kill may be limited to a target list
      fmk-driver.ts                # the driver of the calls an fmk scenario forces, run through `cscb_run`, each through the installed package's production code
                                   # with one `DRIVER:` outcome line: a `resume` (scenario 5) and a reuse spawn (scenarios 8 and 25) through the package's
                                   # forced-launch seams, and the persona's pane read under another TMUX_TMPDIR (scenario 26); refuses to run without the image
                                   # marker /etc/cscb-ci-image and imports the installed package and its agent-director client only after that check
      fmk-texts.ts                 # the fmk scenarios' one value printer: prints a CSCB-defined text, class label, log fragment or setting value from the
                                   # installed package, through the export that builds or holds it, so no scenario retypes one; its header lists each entry and
                                   # its `src/` export. Run from the scenario's own shell, never as a CSCB process; refuses to run without the image marker
                                   # /etc/cscb-ci-image and imports the installed package only after that check
      driver.ts                    # Test 4 driver: builds a one-persona config, calls spawnForPersona directly, then follows the persona's dialog approver through the package's seams
                                   # (running when the launch returns, stops because the row went live, keeps the launch start); deletes no row
      stub-claude.sh               # fake `claude` (Tests 4, 10 and 12, and every fmk script): runs the mode its working directory selects (the dev-channels
                                   # dialog by default, at once, silent, an unrecognised dialog, the folder-trust prompt), reports in by firing every SessionStart
                                   # hook its `--settings` registers, and SessionEnd on its exit sentinel, as direct children of its own process (exec form:
                                   # `command` with its `args`; shell form: the command's words); re-fires SessionStart while its row reads `pending`, up to G;
                                   # holds an MCP session to the bot server (see The stub worker)
      stub-mcp-session.ts          # the stub's MCP session client, copied beside the stub in every fmk script: connects to the bot server named by the stub's
                                   # `--mcp-config` with the package's own MCP SDK and holds the session until the stub ends; refuses to run without the image
                                   # marker /etc/cscb-ci-image and imports the package only after that check
      slack-stub-server.ts         # Tests 10 and 12 loopback Slack stub: Web API, apps.connections.open, Socket Mode WebSocket, JSONL record
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
  default settings. Scenarios 10 and 24 are the exceptions: they write a
  `[tmux]` table. Test 0 writes one too, after its re-fire legs (see
  Layout);
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
- `tmux_shim_mode fail-kill --targets <target>...` (a harness addition, to
  confirm at the reconcile pass) sets `fail-kill` limited to the targets
  given, each a session name, a session id (`$N`) or a pane id (`%N`): the
  mode file holds the mode line, then one target per line, written
  atomically. It fails on `--targets` after any other mode, on no target and
  on an empty target or one holding a control character. A later
  `tmux_shim_mode` call replaces the list.

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
  mode or a delay that is not a number of seconds runs nothing and exits 70.
  For `fail-kill` only, the lines after the first are its target list (see
  fail-kill's target list below); a list beside any other mode runs nothing
  and exits 70. The file is opened once per call, so the mode and its list
  come from one version of it;
- reads each command of a chained call after tmux's global options, and
  matches a command name as tmux does (its full name, its alias or a prefix
  no other command shares). A call with no command, and neither `-c` nor
  `-V`, is tmux's default `new-session`.

| Mode | Acts on a call whose commands include | What it does to that call | Every other call |
|---|---|---|---|
| `log` | (none) | | runs the real tmux |
| `fail-kill` | `kill-session` or `kill-pane` (with a target list, one aimed at a listed target) | runs nothing, so kills nothing; one `tmux-shim:` line on standard error; exits 1 | runs the real tmux (with a target list, a kill aimed elsewhere included) |
| `fail-create` | `new-session` | runs nothing, so creates nothing; nothing on standard output and one `tmux-shim:` line (which tmux never gives) on standard error; exits 1. agent-director answers `ErrTmuxSessionCreate` and a plain spawn's row stays `pending` | runs the real tmux |
| `slow-create` | `new-session` | runs the whole chained call through the real tmux (agent-director's `@ad_owner` and `@ad_pane` labels with it), then waits the delay (default 15 s, longer than agent-director's default `create_timeout_ms` of 5000) and exits with tmux's status: the launch times out with its session present | runs the real tmux |
| `wedge` | any command | waits the delay (default 60 s, longer than every agent-director call timeout at its defaults), then prints one `tmux-shim:` line on standard error and exits 1, having run no tmux | (every call is waited) |

A wait runs `sleep` with its standard streams on `/dev/null`, so a `sleep`
left behind when agent-director's call timeout kills the shim holds none of
agent-director's pipes.

fail-kill's target list (a harness addition, to confirm at the reconcile
pass). With no list, `fail-kill` fails every kill, as the table says. With
one, only a call holding a `kill-session` or `kill-pane` aimed at a listed
target fails, and fails whole, running none of its commands; every other
call runs the real tmux. A kill's target is its `-t` value (`-t <t>`,
`-t<t>`, or `t` last in a flag cluster such as `-at <t>`), read up to `--`
or its first word that is not a flag; a kill with no `-t` is aimed at no
listed target. A target and a listed one are compared after a leading `=`
and everything from the first `:` on are dropped from each, so `=name`,
`name:`, `$N` and `%N` (agent-director's own forms, `kill-session -t $N` and
`kill-pane -t %N`) match the listed `name`, `$N` or `%N`. Blank lines in the
list are skipped. A scenario that limits one row's kill lists that row's
session name, session id and pane id.

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
  scenario 10 or 24, which write a `[tmux]` table. Test 0, the harness's
  self-check rather than a scenario, writes one once its re-fire legs are
  done, for its finished-row kill (see Layout).
- It runs with both shims: `tmux-shim.sh` first on the PATH of its CSCB
  processes, in `log` mode unless the scenario sets `fail-kill` (whole, or
  limited to a target list), `fail-create`, `slow-create` or `wedge` with
  `tmux_shim_mode`; and
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
  through the `[tmux]` table of scenarios 10 and 24; every other scenario
  waits out agent-director's default windows (at least 300 s where it needs
  the starting-session bound, as the finished-row kill does).
- Posts are read from the Slack stub's record (`slack-stub-server.ts
  --record`).
- Shim logs are read by parent process, as above, never by scraping a pane.

### fmk scenario list

Each HO §7 scenario's script, what it drives and what it checks. The
script's header comment is its full specification.

| Scenario | Script | Sites | Outcomes checked | Modes, helpers and settings |
|---|---|---|---|---|
| 16 (b.jg5 SRJ-1417, SRJ-714; AC 1, AC 64) | `test-14-fmk-kill-fails.sh` (leg 0, its first) | An upgrade's first start sweep (`reconcileOrphans`) over rows seeded on 0.10.0 before `install_ad_release`: two pre-persona rows A and B (a `channel` label, no `persona` label, named as the pre-persona package names them, workers reporting in at once); persona P's own row (`cscb_<P key>`, its `persona` label, a working directory other than P's configured one, a worker that never reports in), which after the migration reads `pending` with no launch start (SRJ-513, SRJ-1020); and absent persona Q's live row. `config.json` names P (a Slack destination) and not Q | CSCB makes no `delete`, and every seeded row is present afterwards (harness `get`). A's kill: each of its `KILL_RETRY_TRIES` tries answers `ErrTmuxKillFailed`, its session still runs, and exactly one `orphan-cleanup` startup-errors entry names A's row, state, session and class (the pre-persona row's head, then the alert's ordinary version in its start-sweep form), with one server-log line of it and nothing about A in the Slack stub's record. B's and Q's outcomes are logged as `NOTE:` lines, not asserted: the release answers `ErrTmuxKillFailed`, with no kill sent, for a session a 0.10.0 launch made, which carries no label the release reads, and the pass's retry budget gives a later row one try; so each either succeeded (the sweep's per-row line, no entry, its session gone) or did not (exactly one entry, its session still running). Every running stub worker is in a session a row of the harness's `list` records. P latches from its own listed row, with exactly one launch-start-not-recorded post at P's destination and no CSCB kill of P's row. Q's key is in the retired-key record with cause `absent-at-start`. The sweep's summary line gives its counts. After the leg the harness plays the operator acting on the alerts: it ends each old worker's session by its session id and runs `find-missing` until A's, B's and Q's rows read finished, so no later start sweeps them live | tmux-shim `fail-kill` limited to A's session name, session id and pane id (`tmux_shim_mode fail-kill --targets`), `log` once the sweep's summary line is logged; the seeders `seed_prepersona_fleet` (A, B) and `seed_010_row` (P, Q) on 0.10.0 (`SCENARIO_AD_START=0.10.0`) before `install_ad_release`; stub modes `at-once` (A, B and Q) and `silent` (P); agent-director's default settings; `health_check_interval` 0; values from `fixtures/fmk-texts.ts`; posts from the Slack stub's record |
| 2 (b.jg5 SRJ-1403; AC 24, AC 64) | `test-14-fmk-kill-fails.sh` | The start sweep (a persona removed while its worker runs); a `config_dir` mismatch, met at the collision ladder's `pending` branch (SRJ-411) by a start; a `cwd` mismatch, met by a running server's first pending-only retry. `resume_enabled=false` is not driven here: SRJ-1403 leaves it, with `ErrSpawnNotResumable` with dead evidence, to SRJ-110's unit test (dead evidence means the session is gone, so agent-director's kill sends no kill for the shim to fail) | Every kill try answers `ErrTmuxKillFailed`, `KILL_RETRY_TRIES` tries; no CSCB delete or launch (spawn or resume) of the leg's id follows; the row is kept (read afterwards, present). One alert is routed per SRJ-704: at the start sweep, one `orphan-cleanup` startup-errors entry and one server-log line, nothing to Slack; at a `config_dir` or `cwd` mismatch, one ordinary alert at the persona's destination, quoting agent-director's description, and no second alert through one further retry. No `tmux-unresponsive` post (SRJ-307) | tmux-shim `fail-kill` for the kills checked (`log` while a leg launches); stub modes `dev-channels` (reporting, the start sweep's persona) and `silent` (the mismatch personas, whose rows stay `pending`); the mismatch made by re-pointing a symlinked directory (`repoint_symlink`); agent-director's default settings, no `config.toml`, so `kill_exit_wait_ms` is its default, 5000 ms, measured (slowest exit 603 ms), and the retry makes 3 tries 2 s apart; `health_check_interval` 0; starts on 0.10.0 (`SCENARIO_AD_START=0.10.0`), with scenario 16's seeding before `install_ad_release`, so legs 1 to 3 run on the release; values from `fixtures/fmk-texts.ts`; posts from the Slack stub's record |
| 15 (b.jg5 SRJ-1417, SRJ-715; AC 1, AC 64) | `test-14-fmk-kill-fails.sh` (leg 4, after scenario 2's legs) | A persona removal's teardown: persona R (a Slack destination, its worker reporting in) is up and its row `waiting`; the operator removes R from `config.json` and confirms the apply by renaming the pending file to the apply file (README "Reload") | R's teardown kill: each of its `KILL_RETRY_TRIES` tries answers `ErrTmuxKillFailed`, its tries ending exhausted; exactly one `persona-teardown-notice` startup-errors entry naming R, carrying the alert's ordinary version with the log-only closing sentence, and one server-log line of it; no CSCB delete; R's row present; R's key in the retired-key record with cause `removed`; nothing about R in the Slack stub's record after the edit, and no `tmux-unresponsive` post | tmux-shim `fail-kill` limited to R's session name, session id and pane id (`tmux_shim_mode fail-kill --targets`), `log` at the leg's end; stub mode `dev-channels`; agent-director's default settings; `health_check_interval` 0; values from `fixtures/fmk-texts.ts`; posts from the Slack stub's record |
| 6 (b.jg5 SRJ-1408, SRJ-702; AC 1, AC 56) | `test-18-fmk-wedged.sh` | Personas A and B (kept) and X1, X2 and X3, each with its own key, credentials, channel (its Slack destination) and directories, launched in `log` until each row reads `waiting`. The harness plays the operator: a plain `stop` (every worker keeps running and every row stays live), X1 to X3 removed from `config.json`, the last-applied record moved aside (so the next start applies `config.json` as it stands), `wedge`, then a live start. Section 1 is that start's sweep (`reconcileOrphans`): the release's `list` is a store read with no tmux call, so it lists all five rows and reaches the kills of X1 to X3's live rows. Section 2 is A's and B's condition: their rows are kept, the start pass's plain spawns collide and route to `get`, and the start pass and each retry run the reconnect (a pane read, then `/mcp reconnect`), whose tmux verbs are refused; the first refusal starts the persona's `tmux-unresponsive` condition and arms its retry timer, whose retries fall at 30, 90, 210, 450 and 750 s after it. The onset falls due at the first retry at least `TMUX_UNRESPONSIVE_ONSET_FLOOR_MS` after the first refusal and the alert once the threshold has passed; `wedge` is kept until both alerts have posted, so the retry at 450 s is the first after the unwedge | Section 1: the sweep's summary line reads 5 listed, none killed, 5 kept with 3 kills failed, 3 keys recorded as retired and none left for a latch; the first swept row gets exactly `KILL_RETRY_TRIES` (3) CSCB `kill` calls, its per-try lines (`killRetryTryLine`) ending `KILL_RETRY_NEXT_AGAIN` and then, on the last, `KILL_RETRY_NEXT_EXHAUSTED`, and each later row exactly 1, its one per-try line ending `KILL_RETRY_NEXT_BUDGET_SPENT` (the pass's retries are spent); the sweep's duration, from its CSCB `list` carrying the `service` label (read from the agent-director shim's log, as the sweep logs no start line) to its summary line, is at most (3 + the later rows) × CSCB's agent-director call timeout + 2 × `KILL_RETRY_SPACING_MS`, 304 s at the defaults (the measured duration is logged); CSCB makes no `delete`, and every X row is present (harness `get`). Section 2, for each of A and B: exactly one `tmux-unresponsive` started line; at most one onset post and none after its alert; exactly one alert, posted more than the alert threshold (360 s at agent-director's defaults) after the first refusal, and exactly one recovery, posted after the unwedge, each at the persona's destination as the persona notifier's prefix and then the printer's body; no restart-cap notice, cap-reached line, retry entry's cap-skip line or retry timer stopped at the cap (SRJ-305); CSCB calls naming its id continue after its alert; no CSCB `kill`, `delete`, `resume` or reuse spawn naming its id, and the start pass's one plain spawn is the only `spawn` naming it (no relaunch); its row is present. Logged as `NOTE:` lines, not asserted: each persona's CSCB calls by verb, whether its onset posted, every post at its destination (after the recovery the stub's answered dev-channels dialog is still on its screen, so CSCB posts its *Waiting on a prompt* notice, a limit of the stub that the SRD leaves open) and the status reads between the first swept row's tries. Ends with the three closing assertions | tmux-shim `log` while the personas launch, `wedge` (its default 60 s delay, longer than every tmux call timeout at agent-director's defaults) from just before the wedged start until both alerts have posted, then `log`; stub mode `dev-channels`; agent-director's default settings, no `config.toml` (alert threshold `adAlertThresholdMs` of the defaults); CSCB's agent-director call timeout at its default (`DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS`); `health_check_interval` 0 in `config.json`, so no health tick runs; the release start (`SCENARIO_AD_START` unset); live starts against the Slack stub; values from `fixtures/fmk-texts.ts`; posts from the Slack stub's record |

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
| Re-pointing a persona's symlinked `working_directory` or `claude_config_dir` (scenario 2) | `repoint_symlink` (see The human's filesystem steps) |

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
| `ad_store_mark_finished <id> <missing\|ended>` | 10 part B (SRJ-1412) | `state` to `missing` or `ended`; `ended_at` to now minus the stopping window, in whole seconds, in the store's `YYYY-MM-DD HH:MM:SS` UTC layout; `launch_started_at` NULL; `row_version` + 1. Prints the `ended_at` written |
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

#### The human's filesystem steps

`repoint_symlink <link> <target>` is a harness addition, to confirm at the
reconcile pass. It plays a human re-pointing a persona's symlinked
`working_directory` or `claude_config_dir` while the persona's row stays in
the store. agent-director's `spawn` records the real `cwd`, CSCB writes the
`config_dir` label by real path, and `compareRowToPersona` resolves the
persona's directories by real path at every comparison. So after the
re-point the persona compares unequal to the row its last launch recorded:
a real `cwd` or `config_dir` mismatch, with no config edit.

- `<link>` must be an existing symlink and `<target>` an existing
  directory, both under `SCENARIO_ROOT` as written and by real path
  (`<link>`'s directory by real path, the link itself not followed). It
  refuses anything else, leaving the link as it was.
- It makes a new link to `<target>`'s real path beside `<link>` and renames
  it over `<link>`, so a reader never finds the link missing, then fails
  unless `<link>` resolves to `<target>`'s real path.
- It makes no tmux or agent-director call. Like every helper here it runs
  `require_ci_image` and then `require_scenario_home` first, and only in fmk
  mode; `tests/host-safety.test.ts` audits that the home check comes before
  its first move.

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

`stub_press_enter <target>` sends Enter with the real tmux, from the
scenario's own shell, into a pane on the scenario's tmux server: a pane id is
used as given, and a session name is matched exactly, never as a prefix of
another session's. It fails with tmux's message when tmux refuses, and
refuses when `TMUX` is set or `TMUX_TMPDIR` is not the scenario's.

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
- A request's `text` is recorded with token-like text replaced by `<token>`:
  whole for `chat.postMessage`, so a scenario reads each post's full text,
  and cut to 300 characters for every other method.
- It has no `bun test` suite of its own; Test 10 exercises it end to end.

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
