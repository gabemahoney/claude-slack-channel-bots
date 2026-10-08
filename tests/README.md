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
start the server in dry run. Test 4, Test 0, Tests 10, 12 and 29 and every
fmk scenario leave dry run: Test 4 runs its driver, which spawns under a stub
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
  `fixtures/switch-over.ts` does the same: it checks the marker first and
  exits 2 without it, and loads the package and the step reader only after
  that check. (`fixtures/phase1-client-check.ts` also refuses to run without
  the marker.)
- `fixtures/fmk-texts.ts`: the same first statement, exiting 2 before it
  reads an argument or loads a module; it statically imports only `node:`
  built-ins and loads the installed package only after the check.
- `fixtures/agent-director-list-refusing.sh`: its first step. It prints one
  line to stderr and exits 70 before it reads an argument or runs a binary.
- `fixtures/ad-version-stand-in.sh`: checks the marker before it reads its
  settings or runs agent-director; without it, it prints one
  `ad-version-stand-in:` line on stderr and exits 70.
- Every `scenario.sh` step that installs, moves or swaps an agent-director
  binary or the shim, every harness agent-director call (`ad`, `ad_capture`,
  `ad_admin`, `ad_admin_capture`), every harness `sqlite3` read, edit or copy
  (`ad_store_edit`, `ad_store_id`, `ad_store_row`, `ad_store_backup`,
  `ad_store_pending_no_launch`), the trail reader `ad_trail_events`, every
  stub-worker helper (`stub_mode`, `stub_dialog_delay`, `stub_release`,
  `stub_press_enter`, `stub_type_exit`, `write_mcp_config`) and the
  agent-director settings writer (`write_ad_settings`) calls
  `require_ci_image` as its first step, which fails with
  `FAIL: <test>: <step>: refused: /etc/cscb-ci-image is absent …`.
- The Slack push and stub session helpers (`slack_stub_push`,
  `stub_session_deliveries`, `stub_session_call`; b.deo SRI-1404) call
  `require_ci_image` as their first step after their declarations, with the
  same FAIL line.

The `scenario.sh` helpers named before the Slack push and stub session
helpers then call `require_scenario_home`, which refuses unless
`SCENARIO_ROOT` is a directory and HOME is under it, both as written and by
real path (a HOME that is a symlink out of `SCENARIO_ROOT` is refused). The
copy-and-rename every install and swap goes through also refuses a
destination outside `SCENARIO_ROOT`, and the settings writers
(`write_ad_settings` and the stand-in installs' settings write) resolve
their directory with `realpath -e` and refuse one outside `SCENARIO_ROOT`
before they remove, create or write anything there. No harness step touches the invoking
user's own `~/.agent-director`.

The Slack push and stub session helpers do not run `require_scenario_home`:
they work in shared mode, which has no scenario HOME. The image check is
their guard, with their own `SCENARIO_ROOT` checks: each refuses a
`SCENARIO_STUB_DIR` or working directory outside `SCENARIO_ROOT`, as written
and by real path, and none touches HOME (see Scenario helper).

`tests/host-safety.test.ts` reads these files, and never runs them, to check
that each check comes before the first step it guards (see the
`host-safety.test.ts` row in `docs/testing-guide.md`). It finds the
`scenario.sh` functions to hold from the file: every function with a step,
less the ones its commented `HOME_CHECK_EXEMPT` and `HOME_CHECKED_BY_CALLERS`
lists name with why; a function in the second list may run only after an
audited helper's `require_scenario_home`. The Slack push and stub session
helpers make no step in that audit's sense (no `sqlite3`, copy, move,
install or agent-director run), so it does not hold them and neither list
names them; a separate pin (`IMAGE_GUARDED_STUB_HELPERS`) checks that each
runs `require_ci_image` first, outside any `if`, `||`, pipeline, background
or subshell, and that none runs `require_scenario_home`, nor any function it
calls.

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
    test-7-dm-settings.sh          # E6/E7 (SR-1.2 as amended by b.deo SRI-102, SRI-202; SR-1.5 as amended by b.deo SRI-103), dry run: DMs switch and `dm` prompt destinations load; six invalid DM settings refuse the start
    test-8-reload-confirm.sh       # E11/E12 (SR-8.3 to SR-8.5; SR-8.4 as amended by b.deo SRI-803, SRI-804), dry run: an edit is previewed, applied only on confirmation; a stale confirmation applies nothing
    test-9-reload-destructive-and-server-wide.sh
                                   # E13 dry-run leg (SR-8.6 as amended by b.deo SRI-201, SRI-406): a working_directory change gives one DESTRUCTIVE: line and touches one persona; a port change waits for the restart
    test-10-credentials-change.sh  # E13 (SR-8.3; SR-8.6 as amended by b.deo SRI-805), live against the Slack stub: a credentials change reconnects one persona on confirmation; handshake failure and refused change; leak counts
    test-12-bot-hook-absoluteness.sh
                                   # b.cnu SR-8.2, b.2qu, live against the Slack stub: every hook `command` path of an agent-director-launched persona is an absolute path to an existing executable
                                   # (agent-director's exec-form `command` read verbatim, CSCB's shell-form Stop hook by its first word); agent-director's run the user's agent-director install,
                                   # the reply guard runs the installed package's script
    test-0-fmk-harness-self-check.sh
                                   # SRJ-1306 (as amended by b.deo SRI-1402 to SRI-1404), fmk mode: the harness's self-check, run after Test 4 and before every fmk scenario. Its legs show the scenario's own HOME,
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
                                   # closing enforcement; and the trap stopping the scenario's tmux server. Its synthetic reader leg (`synthetic_readers`) runs
                                   # the latch scenarios' readers on synthetic logs: `tmux_shim_targets` (each -t form, alias, prefix and option position it must
                                   # match, and the near misses it must not: `%12` for `%1`, `@12` for `@1`, `$30` for `$3`, a longer name), `ad_cscb_calls`
                                   # (the instance id exactly, in both flag forms, never a harness call or a stop line) and `ad_cscb_verb_between`, each kept to
                                   # its marks. Its stub legs show the stub's MCP session registered as
                                   # the persona's, with no reconnect or relaunch over three health ticks; `/mcp reconnect` typed into the pane in both
                                   # forms (`/mcp reconnect slack-channel-router`, as CSCB types it, then bare), each ending the old session client and
                                   # connecting a new one the server registers as the persona's, the stub still running; then the stub's exit sentinel,
                                   # sent through `stub_type_exit`, and the persona not connected once the stub ends; the
                                   # Slack stub's record (`slack_stub_record`: a `chat.postMessage` text over 300 characters recorded whole with `<token>` in the
                                   # token's place, the same text to `chat.update` cut to 300 characters, and no token-like text in the record); the stub
                                   # run directly (its version line, the default dev-channels dialog, `silent`, a stop line on stderr, and with a dialog delay a starting
                                   # screen holding neither approver needle, then the same dialog byte for byte; the linger on exit: a `/exit` line ignored in `at-once`,
                                   # and in `linger-on-exit` SessionEnd fired once from the stub's own process on `/exit`, its lingering marker written, the stub
                                   # lingering and ignoring further lines (still running `STUB_LINGER_HOLD_S` after them), then exiting 0 on SIGUSR1); the
                                   # stub helpers refusing and working (`stub_dialog_delay`, `stub_release` and `stub_type_line` among them); `repoint_symlink`'s
                                   # real-path refusals and a re-point (`repoint_refusals`);
                                   # the SessionStart re-fire in every reporting path (at once, a folder trusted in either config, and the dev-channels,
                                   # unrecognised and folder-trust dialogs answered by `stub_press_enter`; the unrecognised dialog, read before the Enter, holds
                                   # neither approver needle, and once the banner shows no answered dialog's line is left in the pane or its scrollback) against
                                   # a row a silent worker holds `pending`, every fire
                                   # ignored as `pid_mismatch` and none after G; exactly one stop line after a failed `status` read and after a `pending` row with no
                                   # launch start; and no stub line counted as CSCB's. Its harness-only step legs (see Harness-only steps) show each seeding
                                   # helper's session, labels and @ad_pane read back from tmux (`seeding`); each human tmux step's effect read back, and its
                                   # refusals (`tmux_steps`); the store statements writing exactly their columns and refusing a live row (`store_statements`);
                                   # the finished-row kill from the scenario's shell, the `pending` row beside a leftover and the one `delete`
                                   # (`operator_actions`); the find-missing loop's runs, interval and parent (`find_missing_loop`); fmk-driver.ts's three
                                   # forced calls, each one `DRIVER: FORCED` line with every call during its run parented by the driver (`fmk_driver_reuse_spawn`,
                                   # `fmk_driver_read_pane`, `fmk_driver_resume`); the 0.10.0 seeders in a nested run started on 0.10.0, their rows
                                   # surviving `install_ad_release` and each seeder's refusals (`seeders_010`); and, last, the tmux server restart and socket
                                   # re-bind (`tmux_server_steps`). The re-fire legs wait out agent-director's default G (60 s); only after them does
                                   # `store_statements` write a `[tmux]` table (`starting_session_seconds = 60`, `stopping_window_seconds = 30`), so the
                                   # kill need not wait 300 s. It runs about two and a half minutes and ends with the three closing assertions
    test-13-fmk-switch-over.sh     # SRJ-1402 legs A, B and C, SRJ-1108, SRJ-1401, SRJ-1418, SRJ-203, SRJ-1013, fmk mode on agent-director 0.10.0: fmk scenario 1, the switch-over. From a
                                   # pre-persona 0.10.0 fleet (the published CSCB 0.10.0 on agent-director's 0.10.0 client, two channels seeded by
                                   # `seed_prepersona_fleet`, no server started), it follows the README's switch-over runbook, steps 1 to 11 once each, read from the
                                   # package's README through `switch-over.ts steps`, with only SRJ-1402's declared substitutions; leg A's checks follow step 10's live
                                   # start. After step 11, leg B runs the new CLI's `clean_restart` on Phase 1 (each persona back through a collision then `resume`,
                                   # its conversation kept, its row `pending` until it reports in) and leg C puts 0.10.0 behind the shim and checks that `start --live`
                                   # refuses it once (one `ad-below-phase1-floor` entry, nothing at the Slack stub, only `version` calls), then puts the release
                                   # back (see Scenario 1: the switch-over (Test 13)).
                                   # Its host files sit under SCENARIO_ROOT/host: the switch-over log (holding the operator's go-ahead), the staged persona
                                   # configuration, the crontable's prompt files, the `/interject` caller file, the token variables file, the store backup
                                   # and the rollback copies; the crontable is in the state directory
    test-14-fmk-kill-fails.sh      # HO §7 scenarios 16, 2 and 15, in that order (b.jg5 SRJ-1403, SRJ-1417), fmk: a kill that really fails deletes and launches
                                   # nothing; with the tmux shim in fail-kill, for a pre-persona row seeded on 0.10.0 met at an upgrade's first start, a persona
                                   # removed from the config at a start, a config_dir mismatch, a cwd mismatch and a persona removed while the server runs, each kill
                                   # answers ErrTmuxKillFailed, the row is kept and one alert is routed per SRJ-704 (see fmk scenario list)
    test-15-fmk-prefix-neighbour.sh  # HO §7 scenario 3 (b.jg5 SRJ-1404), fmk: a hand-made prefix neighbour is never read or typed into
                                   # Set-up: one persona `dev`; with the server stopped, the harness spawns the neighbour from the scenario's own shell
                                   # (`ad_capture spawn`; CSCB rejects persona keys that prefix each other, so it is made by hand): a real agent-director
                                   # row of another instance id (`<SCENARIO_TAG>_neighbour`, outside `cscb_`) with no label, so no `service=cscb`,
                                   # session `slack_bot_dev_x`, its stub held at the dev-channels dialog. Checks: `dev` resumes with its own
                                   # claude_session_id and reconnects on a plain restart; the approver, `resume` and the restart path never touch the
                                   # neighbour (no CSCB agent-director call names its id or session name, no tmux shim command reads from, types into,
                                   # kills or respawns its session, window or pane (by name, session id, window id or pane id), its row still reads
                                   # `pending` on the same session, window and pane with the same stub alive and no hook fired);
                                   # no latch notice or latch line for `dev`; `dev`'s row present at the end. The first life's `stop --stop-bots` may
                                   # leave `dev`'s row `waiting` (the stub ignores `pause`'s `/exit`, and no `find-missing` runs for an unlatched
                                   # persona). Modes: tmux shim `log`, the stub's dev-channels hold, agent-director's defaults (no config.toml). It runs
                                   # about 90 s and ends with the three closing assertions
    test-16-fmk-conflict.sh  # HO §7 scenarios 4 and 19 (b.jg5 SRJ-1405, SRJ-1420), fmk: a session holding a persona's name latches it; re-checks retry until the harness removes it
                                   # Built in five phases, one function each, so scenario 19's legs join the same phases: 1. the first life; 2. `stop
                                   # --stop-bots`; 3. harness seeding with the server stopped; 4. the second life; 5. the restart leg. It holds
                                   # scenario 4's leg (persona `nolabel`). Set-up: in the first life the persona reaches `waiting`; the harness then types the
                                   # stub's exit sentinel into its pane (a human quitting Claude Code), so the stub fires SessionEnd, agent-director marks the
                                   # row `ended` and the session ends; then `stop --stop-bots`. With the server stopped, the harness makes a session with no
                                   # label named as the row records (`slack_bot_<key>`, `seed_unlabelled`), so it holds the finished row's name. Checks in
                                   # the second life: the bring-up's `resume` gets CONFLICT "no valid instance id"; exactly one CONFLICT post, its lines in
                                   # SRJ-1004's order (persona prefix, first line, description line, the pointer line to "Operator actions", list line,
                                   # human-only line), naming no command; no CSCB `kill`, `kill-finished` or `delete` of the row. Scenario 4's leg runs
                                   # through the same latch, round, end and clear steps as scenario 19's legs. Its rounds: at least two, then every round
                                   # since the latch, each one `status` read (`ended` or `missing`) then the `resume` retry at the 120 s cadence, with no
                                   # probe and no post, still latched, the row's state and `row_version` unchanged; right before the harness ends the
                                   # session by its session id, the rounds are read again, so the clear is checked on the first round after the end. That
                                   # round's `resume` launches with no `find-missing` between its `status` and `resume`, the persona reaches `waiting` with
                                   # its first-life claude_session_id, and exactly one recovery post follows ("a retry of the refused operation was not
                                   # refused"); no tmux command CSCB caused touches the seeded session (by its name, session id, window id or pane id), with
                                   # a positive control on the resumed session; the row present at the end.
                                   # Scenario 19's legs (personas `scanleft`, `envonly`, `otherstore`, `pendleft`): the second life runs in a state dir of
                                   # its own (each start replays its state dir's `config.json.last-applied`, and this life adds these personas). Each
                                   # seeded session is named as the package names the persona's launches (`slack_bot_<key>`), its pane running `sleep`;
                                   # every `@ad_owner` label ends with the scenario store's id (`ad_store_id`) except the other-store variant's, and every
                                   # seeded leftover's pane carries `@ad_pane`. In run order: (1) a leftover labelled with an earlier launch (`scanleft`,
                                   # `seed_leftover`, no row): the bring-up's plain spawn is refused by agent-director's pre-spawn scan ("left over from an
                                   # earlier life"), which writes no row; the harness reads one `ad.launch.name_held` trail record with `row_result`
                                   # `not_inserted` per refused plain spawn, naming the leftover's session and tmux id (read from the trail, never from the
                                   # post, whose description is capped); one CONFLICT post; rounds are `status` (no row) then the plain spawn; never
                                   # `kill`; it stays latched through phase 4. (2) An environment-only session (`envonly`, `seed_env_only`): "no valid
                                   # instance id" at "duplicate session", the new row `ended`; rounds are `status` then a spawn with `--reuse-finished`,
                                   # the row's state and `row_version` unchanged. (3) Another store's label (`otherstore`, `seed_other_store`, a different
                                   # 16-hex store id): "another agent-director store" at "duplicate session", the row `ended`; the post's lines in
                                   # SRJ-1004's order (the must-not-be-ended line, the pointer line to "Operator actions", the list line, the human-only
                                   # line); reuse rounds. (4) A `pending` row beside a leftover (`pendleft`): its first-life row is seeded `pending` beside
                                   # a `seed_leftover` leftover (`ad_store_seed_pending`), then one `ad_store_edit` statement clears its
                                   # claude_session_id (a launch stopped before its create recorded no Claude session); CSCB's own pending-row runs mark
                                   # it `missing` (reason `tmux_name_held`, one `ad.launch.name_held` record from `ad_find_missing`) no earlier than G and
                                   # by B plus the settle after its launch start; never `kill`ed; the restart path's reuse spawn is refused as "left over from an earlier
                                   # life" with one post; rounds are `status` then the reuse spawn. The harness ends the seeded sessions of (2) to (4) by
                                   # their session ids, and each clears at its next round (`pendleft` on a fresh Claude session). (5) Phase 5, the
                                   # restart leg: a plain `stop`, then a start; the bring-up's plain spawn relatches `scanleft` with exactly one new post,
                                   # and no other persona posts or latches; once the harness ends the leftover by its session id, it clears. Each clear:
                                   # the round's `status` then its retry, with no CSCB `find-missing` between them, and one recovery post ("a retry of the
                                   # refused operation was not refused"). No CSCB `kill`, `kill-finished` or `delete` names a scenario 19 persona's id.
                                   # Each variant's rounds: at least N (two, one for `pendleft`), then, once none is in progress, every round since the
                                   # latch, each still latched; re-read right before each end, so each clear is checked on the first round after it.
                                   # Both scenarios: each start pass's completion line counts `0 failed`; no counted launch-failure line of a latching
                                   # persona at each clear or at the end (its fragments are first found in the installed package's `src/restart.ts`, so
                                   # a rewording fails the script); the restart leg's count of conflict-latch lines has a positive control (every persona
                                   # has such lines before the restart, and `scanleft`'s grow by its relatch and clear).
                                   # Before the closing `stop --stop-bots` the harness types the stub's exit line into every worker's pane, so no
                                   # `pause` waits out its 30 s timeout. The harness runs no `find-missing`. Modes: tmux shim `log`, the stub's
                                   # dev-channels hold, `health_check_interval` 0, agent-director's defaults (no config.toml). It runs about 9 minutes and
                                   # ends with the three closing assertions
    test-17-fmk-launch-pending.sh  # HO §7 scenarios 5 (b.jg5 SRJ-1406, AC 3, AC 29, AC 32), 11 (b.jg5 SRJ-1413, AC 6) and 13 (b.jg5 SRJ-1415), fmk mode, live against the Slack stub, in five legs, in this order: a resume held at the dev-channels dialog
                                   # (the stub's dialog delay) reads `pending` with its claude_session_id and a launch start; health ticks and a `resume` forced
                                   # through fixtures/fmk-driver.ts (ErrSpawnNotResumable, not counted, not posted) launch, kill, count or post nothing; the approver
                                   # clears the dialog through the bot server's `read-pane` and `send-keys` with `--allow-pending`, the row reaches `waiting`;
                                   # then (`leg_launch_timeouts`, AC 29) a plain spawn, a reuse and a `resume` under the tmux shim's `slow-create` each end in a
                                   # launch timeout, one `get` and the approver's `send-keys` with `--allow-pending`, which adopts the pane, with no launch, kill
                                   # or post over the row; then (`leg_restart_mid_launch`, AC 32) a launch held at its starting screen across a plain `stop` and
                                   # a start, cleared by the new server's pending-row lap from G; then (`leg_fail_create`, scenario 11) a plain spawn under the tmux
                                   # shim's `fail-create` ends in `ErrTmuxSessionCreate` and leaves a `pending` row, never killed or launched over; CSCB's own
                                   # pending-row run from G marks it `missing` (the harness runs no `find-missing`) and the persona is brought up, with no
                                   # "dispatcher bug" post and no escalation; then (`leg_still_stopping`, scenario 13) a bot the harness pauses reads `ended` while
                                   # its worker (the stub's `linger-on-exit`) still runs, the bot server's immediate `resume` is refused once as still stopping
                                   # (`STILL_STOPPING_PHRASE`), followed by one `get`, with no post, and once the harness releases the worker (`stub_release`) a
                                   # retry of the retry timer resumes it, before the next health tick, with the same claude_session_id; health ticks on in the
                                   # first and last legs, `health_check_interval` 0 in the three between. It runs about seven and a half minutes and ends with
                                   # the three closing assertions (see fmk scenarios)
    test-18-fmk-wedged.sh          # HO §7 scenario 6 (b.jg5 SRJ-1408), fmk: a wedged tmux causes no destructive action, one alert per persona and one recovery;
                                   # with the tmux shim in wedge, the wedged start is delayed by at most one row's retries and one try per later row (AC 56), and each kept persona gets at
                                   # most one onset, one alert past the threshold, no cap and one recovery once tmux answers again (see fmk scenario list)
    test-19-fmk-reuse.sh           # HO §7 scenarios 7, 12 and 18, in that order (b.jg5 SRJ-1409, SRJ-1414, SRJ-1419), fmk: reuse replaces delete, and a
                                   # re-added persona starts fresh. With resume_enabled=false, and separately with a
                                   # missing transcript, a finished row is brought up by a reuse spawn of its own id and CSCB makes no `delete`; a resume of the
                                   # never-messaged new life answers ErrJsonlNeverWritten; a `missing` row with no session id beside a leftover holding its name,
                                   # and an `ended` row with a stale config_dir label beside its remaining session, each have their reuse refused while that
                                   # session runs and succeed once the harness has ended it, and CSCB makes no `delete`; a messaged persona removed, applied,
                                   # restarted and re-added with the same key, working directory and config directory, and a messaged persona whose
                                   # credentials_file changes, each come back by a reuse spawn with no `resume`, the old session absent from `get`, and CSCB
                                   # makes no `delete` (see fmk scenario list)
    test-20-fmk-old-binary.sh      # HO §7 scenarios 8 and 23 (b.jg5 SRJ-1410, SRJ-1425), fmk: an old binary is refused at start; a binary swapped behind the shim stops
                                   # the server; a re-check that cannot run logs once and changes nothing; an ErrInvalidFlags reuse holds or stops; the floor's
                                   # release-candidate form launches; development builds (`0.0.0-dev`, `dev`) are refused, launching nothing; CSCB judges the
                                   # binary's version, never the client's package version (see fmk scenarios below)
    test-21-fmk-teardown.sh        # HO §7 scenario 9 (b.jg5 SRJ-1411), fmk: teardowns that meet a conflict stop nothing; a pending persona's teardown escalates to a kill;
                                   # after a passing precheck a teardown whose kills fail restarts the server under clean_restart and leaves it stopped under
                                   # stop --stop-bots, and with agent-director refusing `list` at the fallback clean_restart starts nothing (see fmk scenario list)
    test-22-fmk-wrong-server.sh
                                   # HO §7 scenario 10 (b.jg5 SRJ-1412), fmk: a find-missing from another tmux environment marks nothing; the own-id conflict latches
                                   # and clears (see fmk scenario list). It writes the scenario HOME's `[tmux]` table and runs about ten minutes
    test-23-fmk-latch-recheck.sh  # HO §7 scenario 20 (b.jg5 SRJ-1422), fmk: each latch case is re-checked with exactly its call
                                   # Part 1 runs first, before any Part 2 persona exists: a global `@ad_owner` value is per tmux server, so it would
                                   # affect every persona on it (a check fails if a Part 2 persona's row or session exists while the harness sets it).
                                   # Part 1's personas stay configured through Part 2's lives, each life in a state dir of its own. The note persona
                                   # (`labelnote`), its stub reporting in at once (so its pane shows no answered dialog, which the restart path's
                                   # reconnect would read as a prompt): its first life alone reaches `waiting`; a plain `stop`. The note set-up, with
                                   # the server stopped, all the harness's: one guarded `ad_store_edit` statement sets the live row's `proc_starttime`
                                   # NULL (agent-director 0.11.0's `find-missing` writes a `provenance_conflict` note only on a live row whose agent
                                   # process it cannot check; this statement is a working default, a Hatch gap); the harness sets the global
                                   # `@ad_owner` value (`ad_owner_global_set`), runs one `find-missing`, confirms the note with a harness `get`
                                   # (`liveness_note` equal to `LATCHING_LIVENESS_NOTE`), unsets the value (`ad_owner_global_unset`) and puts
                                   # `proc_starttime` back; the note stays. The latch life: the start pass's first `list` latches the note persona
                                   # "conflicting labels" on its `waiting` row before any call of its id, with one post that has no `agent-director
                                   # said` line, its session `"slack_bot_labelnote"`; the held-dialog persona (`helddialog`), its stub in the
                                   # unrecognised-dialog mode, is launched by one plain spawn and its row reads `pending`; right after the approver's
                                   # first `read-pane` of it, the harness sets the global value, and the approver's next `read-pane` answers CONFLICT
                                   # and latches it on its `pending` row with one post. A latch on a live row stays latched while the row reads live:
                                   # each of the note persona's rounds while the note shows is one `get` alone, with no post (at least two), and each
                                   # of the held-dialog persona's rounds is one `get` then a one-line `read-pane` with `--allow-pending`, answering
                                   # the same CONFLICT, with no post. AC 43: right after the held-dialog persona's round k (k is two; the round is seen
                                   # in the agent-director shim's log) and within one re-check interval of its `get`, the harness unsets the global
                                   # value, then sends Enter into the stub's pane (`stub_press_enter`); the row reports in and a harness read shows
                                   # `waiting`; round k+1's `get` alone, with no `read-pane`, clears the latch with exactly one recovery post, reason
                                   # `its agent-director row reads waiting`, and no relatch line or post follows; shim-log marks prove the order, with
                                   # no call of its id between round k and the Enter. The answer of the retry after that clear is logged, not asserted.
                                   # Then the harness starts its find-missing loop; once a harness `get` shows no note, the note persona's next round
                                   # is its `get`, then one run of the restart path's decision on the live row (no `resume` or `kill`; in practice the
                                   # reconnect), with no CSCB `find-missing` between them, which clears the latch with one recovery post ("a retry of
                                   # the refused operation was not refused") and no relatch post. Which run removed the note (the store-wide
                                   # `find-missing` after AC 43's clear, or the harness's loop) is logged, not asserted. The harness stops its loop;
                                   # each Part 1 persona has one latch, exactly two posts and no CSCB `kill`, `kill-finished` or `delete` of its id; a
                                   # plain `stop`; the harness ends the held-dialog persona's worker by its exit line (its stub then reporting in at
                                   # once), so Part 2's first life resumes it with no dialog.
                                   # Then Part 2's cases, one persona each: no valid instance id, a different instance id, another agent-director store,
                                   # left over from an earlier life, the scan's refusal with no row, "duplicate session" with the row `ended`, this
                                   # row's own id, the agent's pane was not found, the unusable recorded name, "not this launch's session" (two legs,
                                   # personas `relabelone` and `relabeltwo`) and "launch start not recorded" (persona `nostart`). The script header
                                   # holds the per-case table (each case's set-up step, round call and clear), the lives, the waits and the runtime. Checks: with
                                   # `health_check_interval` 0, each re-check, 120 s apart, is one `status` read of the row plus exactly SRJ-505's
                                   # call for its case and nothing else, counted from the agent-director shim's log (CSCB-parented lines only); at
                                   # least two still-latched rounds per case; a same-case re-refusal posts nothing; each case latches with exactly one
                                   # post; the cadence retries clear with no CSCB `find-missing` before them; each probe clear makes exactly one
                                   # `find-missing` and one retry; each clear makes one recovery post; the unusable recorded name is re-checked by
                                   # `status` alone and stays latched to the end (its rounds checked to the end); no CSCB `find-missing` comes from
                                   # the last latch to the batched clear, a window holding only still-latched rounds. Finished rows come from the stub's exit (`stub_type_exit`: the
                                   # worker's SessionEnd hooks make agent-director mark the row `ended`); no step passes `--include-finished`.
                                   # Then, in run order, the cases cleared only once their row reads `missing`. "Launch start not recorded": the
                                   # set-up stop seeds the persona's live row `pending` with no launch start (`ad_store_pending_no_launch`; it
                                   # never reports in by itself, as it records no pane, and the harness never ends its session); the start pass's
                                   # first `list` latches it before any bring-up call, with one launch-start-not-recorded notice; each round is `status`
                                   # alone; once a store-wide `find-missing` marks the row `missing` (whichever runs first: in practice CSCB's own,
                                   # in the own-id probe round's clear; the script accepts either and logs whose it was), the next round clears it
                                   # with one "Hold cleared" post ("its agent-director row reads missing") and one bring-up retry by the restart
                                   # path's decision, with no CSCB `find-missing` between that `status` and the retry. What the retry meets beside
                                   # the still-running session is logged, not asserted. "Not this launch's session": the set-up stop relabels each
                                   # leg's own session with an earlier launch's token (`relabel_session`: `@ad_owner` with that token and the
                                   # store's id, the worker pane's `@ad_pane` with the same token); the latch life's bring-up reconnect `send-keys`
                                   # on the `waiting` row is refused with nothing typed into the pane (AC 44, from the tmux shim's log), and
                                   # latches with one post; each round is `status` alone: the refused call is never retried, and a live reading
                                   # never clears the latch (the row's state and row_version unchanged). After the last clearing round above, right
                                   # after one more round of each leg, the harness respawns leg 1's worker pane with `sleep` (the relabelled
                                   # session stays) and ends leg 2's session by its id, then starts its find-missing loop (`run_find_missing_loop`,
                                   # every 30 s), which marks each leg's row `missing` (no CSCB `find-missing` from the legs' events to the harness
                                   # read showing it; whose `find-missing` it was is logged). Leg 1: the next round is one `status`, one `get` and one
                                   # `resume`, refused with "left over from an earlier life": it relatches with one new post and no recovery post,
                                   # each following round is `status` then `resume`, and it stays latched to the end. Leg 2: the same round's
                                   # `resume` launches, and it clears with one recovery post ("its row finished and a relaunch was not refused"),
                                   # nothing posted between the latch's notice and it. The harness runs no `find-missing` in Part 2 before its loop, which
                                   # serves the latched personas' rows; the loop's calls are the harness's, never counted as CSCB's. Modes: tmux
                                   # shim `log`, the stub's dev-channels hold (report-in at once for the note persona and the pane-not-found persona's relaunch; the unrecognised-dialog mode for the held-dialog persona's latch life, then report-in at once),
                                   # `health_check_interval` 0 (so the waiting-row `read-pane` a health tick makes is not shown; the reconnect
                                   # comes from a server restart), agent-director's defaults (no config.toml). It runs about 33 minutes (Part 1 about 8.5, Part 2 about 25) and ends
                                   # with the loop stopped, a plain `stop`, the personas still latched (the unusable recorded name, leg 1, and
                                   # "launch start not recorded" when its retry left it latched) keeping their rows and sessions, then the three
                                   # closing assertions
    test-24-fmk-stuck-launch.sh    # HO §7 scenario 21 (b.jg5 SRJ-1423, AC 9), fmk mode, live against the Slack stub, in four legs, in this order: CSCB's own resumed launch,
                                   # held at the stub's unrecognised dialog, gets no `find-missing` before G and unjudged pending-row runs at most one per retry
                                   # interval after it; at B the approver writes its log line only, and the rule posts one relaunching notice, makes one `kill` with
                                   # `kill_sent` true, then `find-missing` marks the row `missing` and a `resume` of the same session id brings it to `waiting`, nothing
                                   # counted; then a `pending` row the harness's own `resume` launched (a harness call playing another process) gets one held post
                                   # with the attach remedy, no second at a later retry, and no kill or launch from CSCB; then, in one server run, two more of CSCB's
                                   # own resumed launches held the same way: R's session, relabelled before B to an earlier launch of `cscb_<R>` (`relabel_session`'s labels, in one tmux invocation,
                                   # under the seeding rules of b.jg5 SRJ-1306 (as amended by b.deo SRI-1402 to SRI-1404): its `@ad_owner` label ends with the scenario store's own id from `ad_store_id`, and
                                   # the worker pane's `@ad_pane` carries the earlier token), gets one relaunching post and one `kill` answered CONFLICT "not this
                                   # launch's session", latches with one CONFLICT post, and the `kill` is never retried through a later latch re-check (120 s); and V's
                                   # session, with a grouped viewer attached (`attach_viewer`), gets one relaunching post and one `kill` with `kill_sent` true, after
                                   # which V's worker is gone. agent-director at its defaults (waits of at least 300 s), `health_check_interval` 0. It runs about
                                   # 25 minutes
    test-25-fmk-pre-trust.sh       # HO §7 scenario 22 (b.jg5 SRJ-1424, AC 10), fmk mode, live against the Slack stub, started on agent-director 0.10.0: each
                                   # launch's `pre_trust` is only logged, one line from `preTrustLogLine` (src/session-manager.ts), and no launch passes
                                   # `no_pre_trust`, in this order: a row `seed_010_row` makes on 0.10.0, migrated by `install_ad_release`, is resumed by
                                   # CSCB's start pass and its `resume` logs whatever value it reports (`ok`, `skipped`, `failed` or no field, the value
                                   # logged); a new persona whose resolved `.claude.json` exists is spawned and logs `ok`; a new persona with a fresh
                                   # `claude_config_dir` logs `failed`, its launch proceeds and the approver clears the folder-trust prompt; and no
                                   # CSCB-parented `spawn` or `resume` in the agent-director shim log carries `--no-pre-trust`. agent-director at its
                                   # defaults, `health_check_interval` 0
    test-26-fmk-timing-settings.sh # HO §7 scenario 24 (b.jg5 SRJ-1426), fmk: agent-director's timing values are logged and govern the waits: the values line at
                                   # every start; a held launch's approver pace, pending-row runs and live-row sequence runs waiting on G from its launch start;
                                   # the relaunching stuck-launch post at B; "still stopping" following the written stopping window; a changed value used from
                                   # the next read, a `[pause]`-only change logging none; refused values: one `ad-config-malformed` alert per affected
                                   # persona, nothing destroyed or counted, the last values kept, one all-clear once fixed; the call timeout: below the
                                   # need, the startup warning and a held launch ending in `ErrCallTimeout` with no launch over its row; above it, no warning
                                   # and agent-director's launch-timeout `ErrTmuxUnresponsive` (see fmk scenarios below)
    test-27-fmk-unusable-name.sh  # HO §7 scenario 25 (b.jg5 SRJ-1427), fmk: an unusable recorded name latches with no tmux call; after the harness's delete it clears and comes up fresh
                                   # Set-up: in the first life persona `unusable` (U) reaches `waiting`; the harness types the stub's exit sentinel into its
                                   # pane (a human quitting Claude Code), so the row ends; then `stop --stop-bots`. With the server stopped, E39's scenario
                                   # 25 statement (`ad_store_unusable_name`, an `ad_store_edit`) puts a `.` in U's recorded name (`<U's session name>.x`),
                                   # and the harness makes another caller's row: a harness `spawn` of instance id `<SCENARIO_TAG>_other` (outside `cscb_`,
                                   # no labels, its stub `silent`) in session `<SCENARIO_TAG>_stranger`, then one script-local `ad_store_edit` statement
                                   # making it live `waiting` with no recorded process and the recorded name `<SCENARIO_TAG>_stranger.x`. Checks in the
                                   # second life: the bring-up's calls of U's row hold exactly
                                   # one `resume` and no reuse spawn, `kill`, `kill-finished` or `delete` (the plain spawn the existing row refuses as a
                                   # collision, and its `get`, are recorded, not asserted); that `resume` gets `ErrUnknownErrorName` (`unknownName` "ErrInternal", the description holding the
                                   # unusable-name phrase and the name); U latches once (case "unusable recorded name", refused operation none) and the
                                   # start pass counts `0 failed` and `1 latched`; exactly one post, the persona prefix then `unusableNameNoticeText`
                                   # around agent-director's quoted description, pointing to "Operator actions" and naming no command. A reuse spawn
                                   # forced through fixtures/fmk-driver.ts gets the same `ErrUnknownErrorName`/`ErrInternal` with the phrase, CSCB's
                                   # unusable-name class and `counted=false`, U's row unchanged. At least two re-check rounds, each one bot-server
                                   # `status` at the 120 s cadence and nothing else for U (no `delete`, `kill`, spawn, `resume` or pane verb), still
                                   # latched, no new post; no tmux shim line at all from the latch to the harness's `delete`; nothing counted: no counted
                                   # launch-failure line (its fragments first found in the installed package's `src/restart.ts`, so a rewording fails the
                                   # script), and no spawn-failure post, which U's channel holding exactly the expected posts, each matched whole and in
                                   # order, rules out. Then the harness plays the human's last procedure step,
                                   # `ad_delete_unusable_row` (agent-director-admin's `delete`, from the scenario's own shell): the next round's `status`
                                   # gets `ErrSpawnNotFound`, the latch clears with one "Hold cleared" post (`holdRecoveryText`, reason "its
                                   # agent-director row is gone"), then exactly one bypassing CSCB `find-missing` and one plain spawn, and U reaches
                                   # `waiting` on a new claude_session_id; from the second life on, U's channel holds exactly the notice and the recovery
                                   # post, in that order, each matched whole. The other caller's row: after a CSCB `find-missing`, a harness `get` shows
                                   # agent-director's `tmux_session_name_rewritten` note; no CSCB call, latch line or post names its id or session name;
                                   # and no tmux command a CSCB process causes reads from, types into, kills or respawns its session name, session id,
                                   # window id or pane id (`tmux_shim_targets`, with a positive control on U's fresh session). At the end the agent-director
                                   # shim's log holds exactly one `delete`, the harness's, parented by the scenario's shell: this is the one fmk script
                                   # whose log holds a `delete`, and `assert_no_cscb_delete` still holds because it counts only CSCB-parented lines.
                                   # The harness runs no `find-missing`. Modes: tmux shim `log`, the stub's dev-channels hold for U,
                                   # `health_check_interval` 0, agent-director's defaults (no config.toml). It runs about 8 minutes and ends with the
                                   # three closing assertions
    test-28-fmk-provenance.sh
                                   # HO §7 scenario 26 (b.jg5 SRJ-1428), fmk: CSCB never touches @ad_owner/@ad_pane; renamed, re-bound and restarted tmux
                                   # servers (see fmk scenario list). Its legs: a renamed session, another TMUX_TMPDIR, a re-bound socket, a restarted tmux
                                   # server (health ticks for that leg only), remain-on-exit, a `pending` row with no launch start, and no CSCB-parented
                                   # tmux line. It runs at agent-director's default settings, holds past the outage's third retry and runs about 22 minutes
    test-29-invited-channels.sh    # b.deo SRI-1401 to SRI-1410, AC 45, shared mode, live against the Slack stub: a 0.11.x configuration; fungible mode switched on and exercised; the stored choice across a restart; fungible mode switched off
    lib/
      scenario.sh                  # shared helper sourced by Test 0 and Tests 5 onwards (see Scenario helper below)
    fixtures/
      agent-director-shim.sh       # the logging agent-director shim of fmk mode: logs each call's argv and parent, then execs the real binary beside it
      agent-director-list-refusing.sh
                                   # scenario 9's agent-director stand-in (a harness addition), swapped in behind the shim with
                                   # `swap_ad_binary <path>`: refuses `list` (no output, exit 1) and execs the release for every other verb; refuses to run
                                   # without the image marker /etc/cscb-ci-image (see Scenario helper)
      tmux-shim.sh                 # the logging tmux shim of fmk mode, first on the PATH of every CSCB process: logs each call's argv and parent, then acts on its
                                   # mode (log, fail-kill, fail-create, slow-create, wedge); fail-kill may be limited to a target list
      fmk-driver.ts                # the driver of the calls an fmk scenario forces, run through `cscb_run`, each through the installed package's production code
                                   # with one `DRIVER:` outcome line: a `resume` (scenario 5) and a reuse spawn (scenarios 8 and 25) through the package's
                                   # forced-launch seams, and the persona's pane read under another TMUX_TMPDIR (scenario 26); after a forced launch it waits
                                   # for the dialog approvers to stop (`stopAllDialogApprovers`) before it prints its outcome and exits, so no agent-director
                                   # call it caused is in flight; refuses to run without the image marker /etc/cscb-ci-image and imports the installed package
                                   # only after that check
      fmk-texts.ts                 # the one value printer of the fmk scenarios and Test 29: prints the installed package's own export (a constant, or a builder's output for
                                   # the given arguments) by entry name, so no script retypes a value src/ exports; refuses to run without the image marker
                                   # /etc/cscb-ci-image and imports the package only after that check (see The value printer)
      ad-version-stand-in.sh       # scenarios 8 and 23's agent-director version stand-in, behind the shim: reports a chosen version (or none a client parses), can turn the
                                   # reuse flag into one the release does not define, and hands every other call to the image's release binary; refuses without
                                   # the image marker or its settings file (see Scenario helper)
      driver.ts                    # Test 4 driver: builds a one-persona config, calls spawnForPersona directly, then follows the persona's dialog approver through the package's seams
                                   # (running when the launch returns, stops because the row went live, keeps the launch start); deletes no row
      stub-claude.sh               # fake `claude` (Tests 4, 10, 12 and 29, and every fmk script): runs the mode its working directory selects (the dev-channels
                                   # dialog by default, at once, silent, an unrecognised dialog, the folder-trust prompt, the dev-channels dialog with the
                                   # transcript written only at the first message, at once and lingering after `pause`'s `/exit`), reports in by firing every SessionStart
                                   # hook its `--settings` registers, and SessionEnd on its exit sentinel, as direct children of its own process (exec form:
                                   # `command` with its `args`; shell form: the command's words); re-fires SessionStart while its row reads `pending`, up to G;
                                   # holds an MCP session to the bot server (see The stub worker); clears its screen and scrollback when a dialog is answered,
                                   # before it reports in (see Stub worker modes); in `dev-channels`, an optional per-directory delay before the dialog
                                   # (`stub_dialog_delay`); in `linger-on-exit`, SessionEnd on the `/exit` line `pause` types, then a linger until `stub_release`
      stub-mcp-session.ts          # the stub's MCP session client, copied beside the stub in every fmk script and Test 29: connects to the bot server named by the stub's
                                   # `--mcp-config` with the package's own MCP SDK and holds the session until the stub ends; records every channel notification
                                   # in a per-directory delivery record and calls the tools the harness writes to a per-directory request file, one result line
                                   # each (see The stub worker; b.deo SRI-1403); refuses to run without the image marker /etc/cscb-ci-image and imports the
                                   # package only after that check
      slack-stub-server.ts         # the loopback Slack stub of Test 0, Tests 10, 12 and 29 and the fmk scenarios: Web API, apps.connections.open, Socket Mode WebSocket, JSONL record
                                   # (each `chat.postMessage` text whole, token-redacted); the push control `POST /_push`, which sends one Socket Mode
                                   # `events_api` envelope over a label's newest open WebSocket (see Slack stub; b.deo SRI-1402)
      phase1-client-check.ts       # run by Test 1 on the installed package, after the client-under-test check
                                   # against the agent-director client the installed package resolves: the client exports SRJ-103's seven classes and the package's re-exports of them are the client's own,
                                   # client-built errors classify by class, the description and predicate helpers hold; refuses to run without the image marker /etc/cscb-ci-image
                                   # (its pure checker is unit-tested in tests/phase1-client-check.test.ts)
      switch-over.ts               # Test 13's reader of a package directory: `steps <pkg>` prints the README switch-over section's title and each step's
                                   # heading title (through `runbookSteps`, tests/test-helpers/runbooks.ts); `settings <pkg>` prints agent-director's settings in
                                   # effect as that package reads them, with each window's minimum, the call-timeout need, G and B; writes nothing; refuses to run
                                   # without the image marker /etc/cscb-ci-image and loads the package and the step reader only after that check
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
SRJ-1305). Scenario 3 is Test 15 (`test-15-fmk-prefix-neighbour.sh`);
scenario 17 is `assert_no_server_tmux` across every fmk script (see Closing
assertions).

### fmk scenarios

Each fmk scenario of agent-director's handoff to CSCB, §7 (b.jg5 SRJ-14xx),
is one script, named here; scenario 14 has no script, and scenario 17 is a
closing assertion of every fmk script. Test 0 is the harness's
self-check, not a scenario.

| Scenario | Script | What it covers |
|---|---|---|
| 1 | `test-13-fmk-switch-over.sh` | The switch-over from a pre-persona 0.10.0 fleet to this build on agent-director Phase 1, by the README's runbook (leg A), then a `clean_restart` on Phase 1 that resumes every persona (leg B) and this build's refusal of agent-director 0.10.0 (leg C) (SRJ-1402, SRJ-203, SRJ-1013) |
| 2 | `test-14-fmk-kill-fails.sh` | A kill that really fails launches nothing, keeps the row and routes one alert (SRJ-1403); see fmk scenario list |
| 3 | `test-15-fmk-prefix-neighbour.sh` | A hand-made prefix neighbour is never read, typed into or killed (SRJ-1404) |
| 4 | `test-16-fmk-conflict.sh` | A session holding a finished row's name latches the persona until it ends (SRJ-1405) |
| 5 | `test-17-fmk-launch-pending.sh` | A resume held at the dev-channels dialog reads `pending` and is never forced (SRJ-1406); see fmk scenario list |
| 6 | `test-18-fmk-wedged.sh` | A wedged tmux gets no destructive action and one alert per persona (SRJ-1408); see fmk scenario list |
| 7 | `test-19-fmk-reuse.sh` | A reuse spawn brings a finished row up when no resume can (SRJ-1409); see fmk scenario list |
| 8 | `test-20-fmk-old-binary.sh` | Old binaries are refused and a swap to one stops the server (SRJ-1410); see Scenarios 8, 23 and 24 |
| 9 | `test-21-fmk-teardown.sh` | Teardowns that meet a conflict stop nothing (SRJ-1411); see fmk scenario list |
| 10 | `test-22-fmk-wrong-server.sh` | A `find-missing` from another tmux environment marks nothing, and the own-id latch clears (SRJ-1412); see fmk scenario list |
| 11 | `test-17-fmk-launch-pending.sh` | A failed fresh spawn waits out G and is brought up once `missing` (SRJ-1413); see fmk scenario list |
| 12 | `test-19-fmk-reuse.sh` | A `missing` row beside a leftover, and an `ended` row with a stale label, come up by reuse once the session is gone (SRJ-1414) |
| 13 | `test-17-fmk-launch-pending.sh` | A paused bot's immediate resume meets "still stopping" once and succeeds later (SRJ-1415) |
| 14 | none | A stale `serve` after the install. It tests agent-director's own `serve` process, so it is agent-director's to verify: CSCB has no script and runs no check for it (SRJ-1416) |
| 15 | `test-14-fmk-kill-fails.sh` | A persona removal whose kill fails keeps the row (SRJ-1417) |
| 16 | `test-14-fmk-kill-fails.sh` | An upgrade's first start with a failing kill keeps every row (SRJ-1417) |
| 17 | every fmk script | `assert_no_server_tmux`: no bot server makes a tmux call of its own (see Closing assertions) |
| 18 | `test-19-fmk-reuse.sh` | A persona removed and re-added comes back fresh by reuse, never resumed (SRJ-1419) |
| 19 | `test-16-fmk-conflict.sh` | Each kind of leftover session latches its persona, and each clears once it ends (SRJ-1420) |
| 20 | `test-23-fmk-latch-recheck.sh` | Every latch case is re-checked every 120 s with exactly its call (SRJ-1422) |
| 21 | `test-24-fmk-stuck-launch.sh` | A launch stuck at an unrecognised prompt is aborted once at B and resumed (SRJ-1423) |
| 22 | `test-25-fmk-pre-trust.sh` | Each launch's `pre_trust` is only logged (SRJ-1424) |
| 23 | `test-20-fmk-old-binary.sh` | A `<P1>-rc.N` binary launches and development builds are refused (SRJ-1425); see Scenarios 8, 23 and 24 |
| 24 | `test-26-fmk-timing-settings.sh` | agent-director's timing settings are logged and govern CSCB's waits (SRJ-1426); see Scenarios 8, 23 and 24 |
| 25 | `test-27-fmk-unusable-name.sh` | An unusable recorded name latches with no tmux call and clears once the row is gone (SRJ-1427) |
| 26 | `test-28-fmk-provenance.sh` | CSCB never touches `@ad_owner`/`@ad_pane`, whatever the tmux server's state (SRJ-1428); see fmk scenario list |

Scenario 14 has no script by decision, not as a gap: the `/ci` suite covers
every §7 scenario except scenario 14.

### Scenario 1: the switch-over (Test 13)

`test-13-fmk-switch-over.sh` runs the README's switch-over runbook
("Switching over to agent-director Phase 1") in the container, as an
operator would, and replaces only the host-only parts SRJ-1402 lists. Its
header comment is the full statement; this is the outline.

The starting point. The script sets `SCENARIO_AD_START=0.10.0` before
sourcing `scenario.sh`, so its HOME runs agent-director 0.10.0 behind the
shim, with no store until 0.10.0's first `spawn`. Setup then:

- installs the published CSCB 0.10.0 tarball as a bun global install under
  `SCENARIO_ROOT`, its agent-director dependency pinned to the image's 0.10.0
  client (checked file for file). Its CLI there is the old CLI, and the build
  under test later takes the same install path;
- writes the pre-persona `config.json` (two routed channels) to
  `$HOME/.claude/channels/slack`, with the host's other files the runbook
  names: a crontable targeting channels, an `/interject` caller file naming
  channels, `access.json` and the Slack token variables (fake tokens, in a
  file never sourced);
- seeds the fleet with `seed_prepersona_fleet`, one row per routed channel
  named and labelled as 0.10.0 does, each with a running stub worker, and
  starts no pre-persona server;
- starts the loopback Slack stub with `--record`, records the operator's
  dated go-ahead for this container as an entry in the switch-over log (the
  harness plays the operator; the go-ahead is the operator's own) and unpacks
  the build under test into a staging directory.

Following the runbook. Each step is entered once, in order, through
`runbook_step <n>`, which reads the step titles from the package's own README
through `switch-over.ts steps` (the staged build up to step 7, the installed
build from step 8) and prints the title. It fails unless `<n>` is the next
step and, on entering steps 4 to 10, fails if a bot server of the scenario
runs (a live `server.pid`, or the port answering). Each host-only part is replaced only
through `runbook_substitute <n> <kind> <reason>`, inside step `<n>`'s
section. Every record a step asks for goes to the switch-over log.

| Step | Substitutions declared |
|---|---|
| 1 | `operator-go-ahead`, `one-socket`, `claude-code-check-skipped`, `staging-build-under-test`, `container-settings`, `slack-fixtures`, `prompt-wording-skipped` |
| 2 | `autostart-skipped` |
| 3 to 6 | none |
| 7 | `staging-build-under-test`, `slack-fixtures` |
| 8 | `operator-go-ahead`, `harness-stops-agents`, `release-install-script`, `container-settings` |
| 9 | `no-agents-restarted` |
| 10 | `prompt-wording-skipped`, `autostart-skipped`, `container-list` |
| 11 | `expire-skipped`, `prompt-wording-skipped` |

Points where the script meets the runbook:

- Steps 1 and 8 confirm the go-ahead (`operator-go-ahead`): each fails the
  run unless the switch-over log still holds the go-ahead entry the harness
  recorded before step 1 ("no go"), then records the confirmation there.
- Step 3 runs the old package's own `stop --stop-bots` through the old CLI
  (`cscb_run`), against the seeded fleet on 0.10.0.
- Step 7 points the global install's agent-director override at the
  image's release client tarball, installs the build under test over the
  same install path, checks the release's client it resolves with the
  image's `ad-client-check.sh --package`, then exports `SCENARIO_CLI`
  as that path's CLI, so later starts and the trap's stop use the new build.
  Each persona's credentials file is written by the new CLI's `credentials`
  command, run with a generated `curl` wrapper first on its PATH that sends
  its Slack API calls to the stub (declared as `slack-fixtures`).
- Step 8 takes the store's online backup with `ad_store_backup`, then runs
  the release's `install.sh` in the scenario HOME and re-shims
  (`install_ad_release`). It reads the settings again through
  `switch-over.ts settings` on the installed build and checks that a `get` of
  each seeded row shows no `launch_started_at`.
- Step 10 starts the new CSCB live through the CLI at the install path, each
  persona's working directory in the stub's dev-channels mode, and waits for
  each persona's row to read `waiting` within B, CSCB's launch bound from
  step 8's settings.
- Step 10's launch-start check (`container-list`) samples
  `agent-director list --state pending` back to back, through the harness
  call from a subshell of the scenario's shell, from before `start_server`
  until every persona row reads `waiting`. Every sample must exit 0, and
  every row a sample shows must be `pending` with a `launch_started_at`.
  For each persona, agent-director's trail (the scenario HOME's
  `~/.agent-director/ad-trail.jsonl`, the records after its length noted
  before the start) must prove the row read `pending` until its
  SessionStart: the row's first `ad.spawn.state_transition` moves it from
  `pending` to `waiting` by SessionStart, and an `ad.send_keys.called`
  record has `row_state` `pending` (the trail records no launch start; the
  samples show it). Every sample taken wholly inside the stretch the row
  provably read `pending`, from the bot server's first `read-pane` of it
  after its spawn to the server's first `send-keys` of it (by their shim
  lines), must show the row. The post-install check, recorded in the
  switch-over log as the runbook says and nowhere else, states how many
  samples showed each row `pending` and how many fell inside that stretch.

Health ticks run through config: the persona configuration sets
`health_check_interval` (shorter than leg A's wait) and
`session_restart_delay`. The stub's MCP session keeps each persona connected,
so a tick does not reconnect it. Once every persona's session is connected,
the script waits until the bot server has read each persona's row on three
more ticks, and fails, naming it as a harness defect, if a tick reconnected
or relaunched a persona.

Leg A's checks, each its own `fail` naming the persona or row. CSCB's calls
are the agent-director shim's lines from step 10's start on whose parent is a
CSCB process:

- after the migration, a `get` of each seeded row shows no
  `launch_started_at` (step 8);
- every persona starts fresh once: one plain spawn of its instance id by the
  bot server, with no `--reuse-finished` and no resume, and the start pass
  counts every persona fresh-spawned and none resumed;
- pre-persona rows are kept and never resumed: no CSCB call names a seeded
  instance id, and each seeded row is still present;
- each persona's dev-channels dialog is cleared through agent-director: the
  bot server's `read-pane` and `send-keys` on its own row, before the row
  read `waiting`;
- no unknown or UNAVAILABLE error leads to a delete, kill or respawn: CSCB
  makes no `kill` or `delete` call, and exactly one launch per persona;
- no persona reaches the restart cap: no restart-cap line in `server.log` and
  no cap notice in the Slack stub's record;
- no post repeats: no two `chat.postMessage` requests in the stub's record
  share a channel and text. The check logs how many posts it compared, and
  fails unless there are exactly 0, since nothing in the scenario posts;
- the stub's record captures the personas' Slack traffic: its lines from
  step 10's start on hold, for each persona's label, at least one
  `apps.connections.open` request and one `ws-open`.

Leg B: a `clean_restart` on Phase 1, after step 11. The script reads each
persona's `claude_session_id` with `get`, then runs the new CLI's
`clean_restart` from the install path through `cscb_run`, so it and the
server it leaves are recorded CSCB processes. It runs in the background while
the harness reads each persona's row with `status` from the scenario's shell.
Each persona's working directory stays in the stub's dev-channels mode, so the
resumed worker shows the dialog again, and the stub re-fires SessionStart
while its row reads `pending`. Two bounds apply:

- `clean_restart` must end within the installed package's precheck and
  teardown bounds (`precheckBoundMs` and `teardownBoundMs` from
  `src/cli-teardown.ts`, at `config.json`'s call timeout and `exit_timeout`),
  plus the harness's bound on the CLI's `stop` (`SCENARIO_STOP_CLI_S`) and the
  CLI's daemon startup wait;
- each row must read `waiting` within B_R of `clean_restart` ending: the
  stopping window and G as step 1 recorded them, plus one health tick.

Leg B's checks, each its own `fail` naming the persona or row. The bot
server's calls are its shim lines after the restart:

- `clean_restart` exits 0, leg A's bot server is gone, and a new one runs and
  answers on the port;
- the restarted server's start pass completes, each persona's session
  connects again, and the server reads each row on three more health ticks
  with no reconnect;
- at most one still-stopping refusal per persona (a `server.log` line naming
  it with the still-stopping phrase), with no restart scheduled beyond one
  per refusal;
- each persona comes back through a collision then a resume: a plain spawn of
  its instance id (no `--reuse-finished`) and then a resume of that id, one
  more resume per refusal (and at most one more spawn). The restarted server
  logs its `ErrInstanceIdCollision` line for the persona, one per spawn with
  no refusal (at most one per spawn with one), the first between the first
  spawn and the first resume;
- the row reads `pending` with a launch start until it reports in, from the
  harness's reads: every read that starts after the bot server's resumed line
  reads `pending` with a launch start until one reads `waiting`, within B_R;
- the same from agent-director's trail (`ad-trail.jsonl` in the scenario
  HOME's `~/.agent-director/`, the records after the length noted before
  `clean_restart`). For each row, the script takes, in trail order, the
  first SessionStart `pending`-to-`waiting` state transition and the last
  `ad.resume.moved_to_pending` before it; and, by `ts`, the row's
  SessionStart `ad.hook.fired` record nearest the transition: the latest at
  or before it, else the first after it, whatever the records' order in the
  trail. It orders them against the bot server's last
  resume call and the harness's reads. Both the move to `pending` and the
  SessionStart hook come after that resume, and the hook comes no later than
  the end of the first read of `waiting`. No read between that resume and
  the transition reads `waiting`, and each such read that starts after the
  move to `pending` reads `pending` with a launch start;
- the dialog is cleared through agent-director: `read-pane` and `send-keys`
  naming the row, by the bot server, after its last resume and before the row
  read `waiting`;
- the conversation is kept: the row keeps the `claude_session_id` read
  before, and the worker in its session's pane was started with
  `--resume <id>`;
- with no refusal, the start pass counts every persona resumed, none
  fresh-spawned and none not brought up (with one, none fresh-spawned);
- no CSCB `delete`, no `kill` by the restarted server, and every persona row
  and pre-persona row is still present;
- the stub's record lines from before `clean_restart` on hold no post
  (exactly 0) and, for each persona's label, at least one
  `apps.connections.open` request and one `ws-open`.

Leg C: this build refuses agent-director 0.10.0. The script stops leg B's
server with its bots through the new CLI (`stop --stop-bots`), fails unless
the stub's record holds at least one `ws-open`, waits until it holds as many
`ws-close` records as `ws-open` (every Slack socket the stub opened closed),
and checks that no tmux session
is left. It then notes the lengths of the shim log, the stub's record,
`startup-errors.log` and `server.log`. `swap_ad_binary 0.10.0` replaces only
the binary behind the shim and checks the shim. The script compares the
binary with the image's 0.10.0 and never runs it against the migrated store.
It then starts the new CSCB with `start --live`. The version required is the
installed package's `PHASE1_FLOOR_VERSION`. Each check is its own `fail`:

- `start` exits non-zero, with its server-failed line;
- it alerts once: exactly one new `startup-errors.log` entry, the
  `ad-below-phase1-floor` entry naming 0.10.0 and the Phase 1 floor, and
  exactly one new `server.log` line carrying that label and matching it;
- the stub's record has no new line: no `auth.test`, no
  `apps.connections.open`, no WebSocket and no post;
- no server runs, nothing answers on the port, and no tmux session exists;
- every agent-director call in the window is a `version` call. The refused
  server exits before it writes its PID file, so it is not in the CSCB
  process record. The leg therefore reads every shim `call` line added in the
  window, not only the CSCB-parented ones. It fails on any launch, kill or
  delete from any parent and on any harness call, and needs at least one
  `version` probe.

`swap_ad_binary release` then puts the release back behind the shim,
checked against the image's binary. The `version` probes of leg A's and leg
B's servers are `assert_no_cscb_include_finished`'s positive control.

The script closes by checking that steps 1 to 11 were each entered once, and
runs the no-repeated-posts check again over the stub's whole record, logging
how many posts it compared (none: nothing in the scenario posts). It prints
the switch-over log and ends with `assert_no_server_tmux`,
`assert_no_cscb_include_finished` and `assert_no_cscb_delete`.

The host check. `tests/fmk-switch-over-runbook.test.ts`, run by plain
`bun test`, reads the README's switch-over section through the shared step
reader (`runbookSteps`, `tests/test-helpers/runbooks.ts`) and the script's
marker calls. It fails unless the script enters steps 1 to N of the README
once each, in order, and declares exactly the substitution table above, each
inside its step's section, with every marker a top-level line with a literal
step and kind. So a change to the runbook's steps fails until Test 13
follows it.

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

- Every `start` but the live starts of Test 0, Tests 10, 12 and 29 and the
  fmk scenarios runs with `SLACK_DRY_RUN=1`, and every `start`
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
  12 and Test 29 run in the container's shared HOME; Test 0 and every fmk
  scenario run in their own HOME. Test 0, Tests 10, 12 and 29 and the fmk
  scenarios are the scenarios outside dry run (see Slack stub).

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
exits, so their order among themselves does not matter. Tests 5 to 12 and
Test 29 run in the helper's shared mode: they share the container's one HOME, one agent-director
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
10's rows. Test 29's first live start does the same to the rows of Tests 10
and 12 and every earlier shared-mode script, so those rows stay too; its
second live start, after a plain `stop` with both workers running, keeps
Test 29's own two rows, whose persona, instance ID and working directory
match its config, and the start pass reconnects both personas. The sweep reaches only the shared
store: an fmk script's rows are in its own store, which no other script's
start sees.

### Script names, prerequisites and canonical order

`/ci` finds its scripts afresh in every run: they are the regular files in
`tests/integration` whose names match `test-*.sh`. A new script that follows
the naming rule runs with no other edit.

Each is named `test-<n>-<slug>.sh`: n a whole number in decimal digits (`0`
included, with no leading zero) and slug one or more lowercase letters, digits
and hyphens. `test-<n>` is the script's number form; the whole name is its
file name. Each of these makes every run `NOT RUN`, and no entry is skipped
silently:

| Problem | The refusal names |
|---|---|
| A `test-*.sh` file that breaks the naming rule, such as `test-5.sh`, `test-x-y.sh` or a number written with a leading zero | the file |
| A `test-*.sh` entry that is not a regular file: a symbolic link (judged as the link itself, never followed), a directory or any other type | the entry |
| Two or more scripts with one number | every file with that number |
| No script numbered 1, a missing `tests/integration` included | test-1 |

A script names the scripts it needs on one prerequisite line: `#`, optional
spaces or tabs, then `ci-requires:` in lowercase, then the names, separated by
spaces or tabs, each a number form or a whole file name. Any other spelling,
such as `# CI-Requires:`, is an ordinary comment that declares nothing:

```bash
# ci-requires: <script> [<script>]...
```

The line counts only when its `#` is the line's first character and it sits in
the header comment block. That block is the consecutive lines whose first
character is `#` after the first line (the shebang), up to the first line
whose first character is not `#`, such as a blank line or an indented comment.
Anywhere else the line is refused (see the table below).

A script with no prerequisite line needs only test-1. Naming test-1 is allowed
and ignored, in any script's line. Today only
`tests/integration/test-3-cozempic-restart.sh` has one:
`# ci-requires: test-2`.

Every script's header is checked in every run, full or selective. Each of
these makes the run `NOT RUN`:

| Header refusal | The refusal names |
|---|---|
| A word that names no script | the declaring script and the word |
| A prerequisite line with nothing after the colon | the script |
| A cycle | the scripts in it |
| A prerequisite that sorts after its dependent in canonical order | both scripts |
| A second prerequisite line, or one outside the header comment block (indented, below the block, or on the first line) | the script |

A cycle is a group of two or more scripts each reachable from every other
through prerequisite links, or a script other than test-1 that names itself.
Each cycle is one refusal, and the links inside it give no ordering refusal.
test-1's place first in every shard is no link, so a test-1 line naming
another script is the ordering refusal, naming both, never a cycle.

Canonical order is test-1; then test-2, test-3 and test-4, each when present;
then every other script by ascending number, so test-0 follows test-4 and
test-9 comes before test-12. In a shard, test-1 runs first and the shard's
other scripts follow in canonical order, so every prerequisite runs before
its dependents.

Shards are filled with scheduling units. test-1 is in no unit, since it runs
first in every shard. The units are the connected groups of the run's other
scripts, joined by their prerequisite links; a script with no link is a unit
of its own.

A unit goes whole into one shard, and each of its scripts runs once there. On
the current tree test-2 and test-3 form one unit, so the 29 scripts give 27
units.

The requested N is the `--shards` value, else 6. The effective N is the
smaller of the requested N and the number of units, but at least 1, so
`/ci test-1` runs one shard. The run uses the effective N, or the smaller N
admission picks for a run with neither `--shards` nor `--inject`.

These checks run in the worktree, before the docker check, the base-image
check, packing, the admission lock or any build, in this order: the
arguments, the script names, duplicate numbers, a missing test-1, the
selection (see Selective runs), the prerequisite lines, the faults and the
credentials.

The first stage that finds a failure ends validation: its first failure is
the refusal's `NOT RUN: <reason>` line, and each other failure of that stage
follows as one detail line. Within a stage the failures come in this order:

- arguments, selection and faults: argument order
- script names: bytewise file-name order
- duplicate numbers: ascending number
- header refusals: the declaring script's canonical order, then the header
  refusal table's order; a cycle counts as declared by its first script in
  canonical order
- credentials: `ANTHROPIC_API_KEY` before `GH_TOKEN`

### Selective runs

Any SCRIPT argument makes the run selective; with none, it is a full run.
A SCRIPT is a number form (`test-3`) or a whole file name
(`test-3-cozempic-restart.sh`).

A number form matches only the script with
exactly that number, so `test-2` never matches `test-20`. A script named more
than once, in either form or both, runs once.

A SCRIPT that matches no script, such as `test-999`, makes the run `NOT RUN`
naming it, before the admission lock or any build. When several match
nothing, the first is the refusal and the others follow as detail lines, in
argument order.

The run's scripts are the selected scripts, their declared prerequisites
(added automatically, and transitively), and test-1, which is always added.
They run in canonical order. `/ci test-3` runs test-1, test-2 and test-3, in
that order, in one shard: test-2 and test-3 are one unit.

A selective run uses the same validation, units and effective N as a full
run, counted over the run's scripts, so `/ci test-1` (no unit) and
`/ci test-2` (one unit) each run one shard. Every script's prerequisite line
is still checked, not only those of the run's scripts. See Script names,
prerequisites and canonical order above for the prerequisite line and
canonical order.

A `fail:` or `timeout:` fault must name an existing script (a number form, or
some script's whole file name) that is one of the run's scripts. Otherwise the
run is refused, naming the fault and the script:
`/ci --inject fail:test-5 test-3` is refused, since test-5 is not one of the
run's scripts. A `leak`, `image-drift` or `kill` shard number must lie from 1
to the effective N, so `/ci --inject kill:2 test-3` is refused too.

A selective run is never a gate result. Its verdict shape is in Verdict file
format below.

### Scenario helper

`tests/integration/lib/scenario.sh` is sourced by Test 0 and Tests 5
onwards; its header comment is the full function list. Its first step is the
image-marker check (see Image marker). It has two modes, chosen by the
script's name:

- fmk mode, for every script whose `TEST_NAME` carries `-fmk-` (Test 0 and
  the fmk scenarios): the script gets its own HOME, agent-director install and
  store, and tmux server, all under `SCENARIO_ROOT`, with the agent-director
  shim in front of the binary (see fmk mode below);
- shared mode, for every other script (Tests 5 to 12 and Test 29): HOME, PATH, the
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
  selections and dialog delay settings, and a lingering stub's marker (see The stub worker), followed by the container's PATH without every directory that holds an
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
- for each invocation appends one `call` line to its log, holding the time it
  was written (seconds since the epoch, six decimals), argv, the
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

The list-refusing stand-in (`fixtures/agent-director-list-refusing.sh`; a
harness addition) is the stand-in file
scenario 9 swaps in with `swap_ad_binary <its path>` and replaces with
`swap_ad_binary release`, each swap checking the shim. It makes
`clean_restart`'s answer check after a failed teardown fail while every
other call still reaches the release:

- its first step checks the image marker and, without it, prints one line to
  stderr and exits 70, running nothing;
- the verb is the first argument after agent-director's global flags
  (`--store-path`, `--home`, `--tmux-command`, with their values);
- for `list` it prints nothing on standard output, one line on standard
  error, and exits 1;
- for every other verb it execs the release binary at the path
  `SCENARIO_RELEASE_BIN` names, with the same argv, standard streams and exit
  status;
- the shim logs every call before it runs the stand-in, so a refused `list`
  is in the shim's log like any other call. Like the shim, it reads no
  environment variable and runs under `bash -p`.

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
  saying why, unless it is 16 lowercase hex characters. `ad_store_row
  <instance-id>` opens it read-only and prints that id's row as a
  one-element JSON array, failing when no row has it.
  `ad_store_pending_no_launch <instance-id>` is one such edit (see The stub
  worker).
- `ad_store_backup <dest>` is the switch-over runbook's online backup of the
  store (step 8): sqlite3's `.backup`, the store opened read-only, into
  `<dest>`, a new file under `SCENARIO_ROOT` (as written and by the real path
  of its directory) whose path holds no `'` or control character. It then
  fails unless the copy's `PRAGMA integrity_check` reads `ok`.
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
- `tmux_shim_mode fail-kill --targets <target>...` (a harness addition) sets `fail-kill` limited to the targets
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

fail-kill's target list (a harness addition). With no list, `fail-kill` fails every kill, as the table says. With
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
| `assert_no_cscb_delete` | any `delete` call (agent-director-admin's, or an earlier agent-director's) whose parent is not the scenario's own shell or a subshell of it, told apart as for `assert_no_cscb_include_finished`. Any other parent fails, a CSCB process the record does not hold included (a server refused before it wrote its PID file). The harness's own `ad_delete_unusable_row` passes. The failure text is "run delete from a parent other than the scenario's own shell or a subshell of it" | (no positive control) |

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

Readers for the latch scenarios (fmk mode; harness additions, b.jg5
SRJ-1306 as amended by b.deo SRI-1402 to SRI-1404). Test 15 and the latch scenarios read the logs through these;
`scenario.sh`'s header gives each one's arguments and output.

- Marks. `ad_shim_mark` and `tmux_shim_mark` print a shim log's position
  now (how many lines it holds, 0 with no log). A reader taking
  `<from-mark>` and `<to-mark>` reads the lines after the first and up to
  the second; `-` is no bound.
- `ad_cscb_calls <instance-id|*> [<from-mark> [<to-mark>]]` prints one row
  per CSCB-parented agent-director call (the same filter as `cscb_ad_calls`)
  whose `--claude-instance-id` is exactly `<instance-id>`, never one it is a
  prefix of; `*` takes every call that carries an instance id. A row is
  `<position> TAB <time> TAB <ppid> TAB <verb> TAB <instance id, or -> TAB
  <arguments>`: the line number in the shim's log, the line's time field,
  the CSCB process that ran the call, and the words after the verb.
- `wait_for_ad_cscb_call <instance-id> <verb> <min-count> <timeout-s>
  [<step>]` waits until that instance id has at least `<min-count>` such
  calls of `<verb>`, and fails naming the count found.
- `ad_cscb_verb_between <verb> <from-mark> <to-mark>` prints the same rows
  for a verb that carries no instance id (`find-missing`, `list`,
  `version`).
- `tmux_shim_targets <session-name|session-id|window-id|pane-id>
  [<from-mark> [<to-mark>]]` prints one row per tmux command, chained
  commands included, that reads from (`capture-pane`, `pipe-pane`), types
  into (`send-keys`, `send-prefix`, `paste-buffer`), kills or respawns a `-t`
  target naming the one given: the pane id exactly; a window id (`@N`)
  exactly, as the `-t` value's window part (`@N`, `@N.0`, `<session>:@N`),
  so `@1` never matches `@12`; for a session, its id, `=<name>` or
  `<name>`, or a session part written without `=` that is a prefix of the
  name (which tmux resolves to that session when no session has the exact
  name). Each command's options are read as tmux reads them, so an option
  that takes an argument (`send-keys`' `-c <client>`) never hides the `-t`
  after it.
- `slack_posts <channel> [<record>]` prints the text of each
  `chat.postMessage` to `<channel>` in the Slack stub's record (default
  `SCENARIO_SLACK_RECORD`), whole and followed by a NUL byte, in record
  order (see Slack stub).
- `ad_trail_events <event> [<instance-id>]` runs `require_ci_image` and
  `require_scenario_home` first, then prints the scenario HOME's
  agent-director trail records (`.agent-director/ad-trail.jsonl`) of that
  event, and of that instance id when given, one JSON object per line. It
  only reads.

Call windows (fmk mode; scenario 10; each a harness addition). The marks are `ad_shim_mark`'s (above).
`cscb_ad_calls_between <from-mark> <to-mark|-> <verb> [<fragment>...]` and
`cscb_ad_count_between` with the same arguments are `cscb_ad_calls` and
`cscb_ad_count` over only the log's lines after `<from-mark>` up to
`<to-mark>` (`-`: the log's end now), read from a copy of those lines under
`SCENARIO_ROOT` with the same CSCB process record, so a script counts one
re-check round's calls. Each runs `require_ci_image` and then
`require_scenario_home` first, before it copies a line.

Slack posts (scenario 10; each a harness addition). `slack_record_mark <record>` prints the last `seq` of a Slack stub
record under `SCENARIO_ROOT` (0 when it holds none).
`slack_label_posts <record> <label> [<after-seq>]` prints the text of each
`chat.postMessage` the stub recorded for the token label `<label>` with a
`seq` above `<after-seq>` (default 0), in record order, one JSON string per
line (`jq -r` gives a post's text back). Each runs `require_ci_image` first
and refuses a record that is not a file under `SCENARIO_ROOT`.

Slack pushes and the stub session's records (both modes; harness additions,
b.deo SRI-1404). These three helpers drive an event into CSCB through the
Slack stub and read what reached the stub worker's MCP session. `scenario.sh`'s
header gives each one's arguments and output; the formats are under Slack
stub (the push control) and The stub worker (the session's records and tool
calls). Two settings feed them:

- `SCENARIO_STUB_DIR`, the directory holding the scenario's stub worker and
  its copy of `fixtures/stub-mcp-session.ts`, where the client keeps its
  records. Fmk setup sets it to `SCENARIO_BIN`; a shared-mode script sets it
  to the directory it copied the stub and the client into. It must be a
  directory under `SCENARIO_ROOT`, as written and by real path, holding the
  client as a regular file, not a symlink.
- `SCENARIO_SLACK_STUB_URL`, the Slack stub's base URL, exactly
  `http://127.0.0.1:<port>` (no path, no trailing `/`, never port 3100). The
  script sets it once the stub's ready file exists.

A setting that is unset or bad fails the step at once, with its reason.

- `slack_stub_push [--expect-refused] <label> <event-json> [<flag>]` pushes
  one `events_api` envelope carrying `<event-json>` (the inner event, a JSON
  object) over the WebSocket the token label `<label>` opened last, bounded
  at 10 s (`SCENARIO_SLACK_PUSH_S`). `<flag>` sets the payload's
  `is_ext_shared_channel`: not given or empty, `false`; `omit`, left out;
  any other JSON value (`true`, `false`, `"yes"`, `null`, `1`), sent as
  given; anything else fails. It prints the envelope ID of a sent push, and
  fails the scenario, naming `<label>` and the stub's reason, when the stub
  refuses the push or does not answer in time. With `--expect-refused` (a
  positive control, such as a push to a label with no open WebSocket) it
  succeeds only on a refusal, printing the stub's reason (`no-open-socket`
  for that label), and fails when the push is sent or the stub does not
  answer or gives no reason.
- `stub_session_deliveries <dir>` prints the delivery record of the working
  directory `<dir>` (a directory under `SCENARIO_ROOT`, as written and by real
  path): one JSON object per line, as recorded, in record order, complete
  lines only. It prints nothing before the first delivery, and only reads.
- `stub_session_call <dir> <tool> <json-args>` calls the MCP tool `<tool>` (1
  to 128 letters, digits, `_`, `-` or `.`) with `<json-args>` (a JSON object)
  over the session of the stub working in `<dir>`. It appends one request
  line with an ID unique in the scenario to the directory's request file, in
  one write (at most 4000 bytes, `SCENARIO_STUB_REQUEST_MAX_BYTES`), then
  polls the results record for that ID for at most 30 s
  (`SCENARIO_STUB_CALL_S`) and prints the result line as recorded. It fails,
  naming `<tool>`, the request ID and `<dir>`, when no result line arrives in
  time; an `isError: true` result is the scenario's to judge, not a failure.

Each refuses outside the `cscb-ci` image (`require_ci_image` is its first
step; see Image marker) and works in both modes. Each reads and writes only
under `SCENARIO_ROOT`: `stub_session_call` writes only the request file in
`SCENARIO_STUB_DIR`, and the other two write nothing.

CSCB's tmux calls (fmk mode; scenario 26; each a harness addition). `cscb_tmux_calls [<fragment>...]` prints the tmux
shim's `call` lines whose parent is any CSCB process the record holds at the
line's time (a bot server, a `start` or `stop` run, or a CLI command or
driver run through `cscb_run`), and whose words, joined by single spaces,
hold every fixed-string fragment in order; `cscb_tmux_count` with the same
arguments prints how many. A line whose parent is agent-director, the
scenario's own shell or a stub is never one. `assert_no_server_tmux` reads
bot-server parents only.

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
  read or edit with `ad_store_id` or `ad_store_edit`, every copy of the store
  with `ad_store_backup`, and every change to the
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
  rules (b.jg5 SRJ-1306 as amended by b.deo SRI-1402 to SRI-1404): each `@ad_owner` label ends with the scenario store's own store id
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
  for it. The exception is scenario 26's decision D2 (see The find-missing
  loop).
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
  --record`), with `slack_posts` (by channel) or `slack_label_posts` (by
  token label).
- Shim logs are read by parent process, as above, never by scraping a pane.
- A value CSCB defines (a needle, a log prefix, a pace, a default setting) is
  printed from the installed package by `fixtures/fmk-texts.ts`, never
  retyped. A scenario that needs another value adds a named entry there;
  there is no second printer.

### fmk scenario list

Each HO §7 scenario's script, what it drives and what it checks. The
script's header comment is its full specification.

| Scenario | Script | Sites | Outcomes checked | Modes, helpers and settings |
|---|---|---|---|---|
| 16 (b.jg5 SRJ-1417, SRJ-714; AC 1, AC 64) | `test-14-fmk-kill-fails.sh` (leg 0, its first) | An upgrade's first start sweep (`reconcileOrphans`) over rows seeded on 0.10.0 before `install_ad_release`: two pre-persona rows A and B (a `channel` label, no `persona` label, named as the pre-persona package names them, workers reporting in at once); persona P's own row (`cscb_<P key>`, its `persona` label, a working directory other than P's configured one, a worker that never reports in), which after the migration reads `pending` with no launch start (SRJ-513, SRJ-1020); and absent persona Q's live row. `config.json` names P (a Slack destination) and not Q | CSCB makes no `delete`, and every seeded row is present afterwards (harness `get`). The pass's retry budget, with A, B and Q in the order CSCB first killed them (not `list` order): the first whose kill failed makes exactly `KILL_RETRY_TRIES` kills and each later one exactly 1. A's kill: each of its tries answers `ErrTmuxKillFailed`, its session still runs, and exactly one `orphan-cleanup` startup-errors entry names A's row, state, session and class (the pre-persona row's head, then the alert's ordinary version in its start-sweep form), with one server-log line of it and nothing about A in the Slack stub's record. B's and Q's outcomes are logged as `NOTE:` lines, not asserted: the release answers `ErrTmuxKillFailed`, with no kill sent, for a session a 0.10.0 launch made, which carries no label the release reads; each either succeeded (the sweep's per-row line, no entry, its session gone) or did not (exactly one entry, its session still running). Every running stub worker is in a session a row of the harness's `list` records, and at least A's and P's workers are found running. P latches from its own listed row, with exactly one launch-start-not-recorded post at P's destination and no CSCB kill of P's row. Q's key is in the retired-key record with cause `absent-at-start`. The sweep's summary line gives its counts. After the leg the harness plays the operator acting on the alerts: it ends each old worker's session by its session id and runs `find-missing` until A's, B's, Q's and P's rows read finished, so no later start sweeps them live | tmux-shim `fail-kill` limited to A's session name, session id and pane id (`tmux_shim_mode fail-kill --targets`) (a guard: the release sends no kill for a 0.10.0-launched session; kills aimed at A's targets are logged), `log` once the sweep's summary line is logged; the seeders `seed_prepersona_fleet` (A, B) and `seed_010_row` (P, Q) on 0.10.0 (`SCENARIO_AD_START=0.10.0`) before `install_ad_release`; stub modes `at-once` (A, B and Q) and `silent` (P); agent-director's default settings; `health_check_interval` 0; values from `fixtures/fmk-texts.ts`; posts from the Slack stub's record |
| 2 (b.jg5 SRJ-1403; AC 24, AC 64) | `test-14-fmk-kill-fails.sh` | The start sweep (a persona removed while its worker runs); a `config_dir` mismatch, met at the collision ladder's `pending` branch (SRJ-411) by a start; a `cwd` mismatch, met by a running server's first pending-only retry. `resume_enabled=false` is not driven here: SRJ-1403 leaves it, with `ErrSpawnNotResumable` with dead evidence, to SRJ-110's unit test (dead evidence means the session is gone, so agent-director's kill sends no kill for the shim to fail) | Every kill try answers `ErrTmuxKillFailed`, `KILL_RETRY_TRIES` tries; no CSCB delete or launch (spawn or resume) of the leg's id follows; the row is kept (read afterwards, present). One alert is routed per SRJ-704: at the start sweep, one `orphan-cleanup` startup-errors entry and one server-log line, nothing to Slack; at a `config_dir` or `cwd` mismatch, one ordinary alert at the persona's destination, quoting agent-director's description, and no second alert through one further retry (no post of any text at the destination for a hold of at least 5 s and at least twice the first alert's latency plus 5 s, and the same count just before the leg's stop). No `tmux-unresponsive` post and no `tmux-unresponsive` started line (for the start sweep, for any persona) (SRJ-307) | tmux-shim `fail-kill` for the kills checked (`log` while a leg launches); stub modes `dev-channels` (reporting, the start sweep's persona) and `silent` (the mismatch personas, whose rows stay `pending`); the mismatch made by re-pointing a symlinked directory (`repoint_symlink`); agent-director's default settings, no `config.toml`, so `kill_exit_wait_ms` is its default, 5000 ms, measured (slowest exit 603 ms), and the retry makes 3 tries 2 s apart; `health_check_interval` 0; starts on 0.10.0 (`SCENARIO_AD_START=0.10.0`), with scenario 16's seeding before `install_ad_release`, so legs 1 to 3 run on the release; values from `fixtures/fmk-texts.ts`; posts from the Slack stub's record |
| 15 (b.jg5 SRJ-1417, SRJ-715; AC 1, AC 64) | `test-14-fmk-kill-fails.sh` (leg 4, after scenario 2's legs) | A persona removal's teardown: persona R (a Slack destination, its worker reporting in) is up and its row `waiting`; the operator removes R from `config.json` and confirms the apply by renaming the pending file to the apply file (README "Reload") | R's teardown kill: each of its `KILL_RETRY_TRIES` tries answers `ErrTmuxKillFailed`, its tries ending exhausted; exactly one `persona-teardown-notice` startup-errors entry naming R, carrying the alert's ordinary version with the log-only closing sentence, and one server-log line of it; no CSCB delete; R's row present; R's key in the retired-key record with cause `removed`; nothing about R in the Slack stub's record after the edit, no `tmux-unresponsive` post and no `tmux-unresponsive` started line for R's key | tmux-shim `fail-kill` limited to R's session name, session id and pane id (`tmux_shim_mode fail-kill --targets`), `log` at the leg's end; stub mode `dev-channels`; agent-director's default settings; `health_check_interval` 0; values from `fixtures/fmk-texts.ts`; posts from the Slack stub's record |
| 6 (b.jg5 SRJ-1408, SRJ-702; AC 1, AC 56) | `test-18-fmk-wedged.sh` | Personas A and B (kept) and X1, X2 and X3, each with its own key, credentials, channel (its Slack destination) and directories, launched in `log` until each row reads `waiting`. The harness plays the operator: a plain `stop` (every worker keeps running and every row stays live), X1 to X3 removed from `config.json`, the last-applied record moved aside (so the next start applies `config.json` as it stands), `wedge`, then a live start. Section 1 is that start's sweep (`reconcileOrphans`): the release's `list` is a store read with no tmux call, so it lists all five rows and reaches the kills of X1 to X3's live rows. Section 2 is A's and B's condition: their rows are kept, the start pass's plain spawns collide and route to `get`, and the start pass and each retry run the reconnect (a pane read, then `/mcp reconnect`), whose tmux verbs are refused; the first refusal starts the persona's `tmux-unresponsive` condition and arms its retry timer, whose retries fall at 30, 90, 210, 450 and 750 s after it. The onset falls due at the first retry at least `TMUX_UNRESPONSIVE_ONSET_FLOOR_MS` after the first refusal and the alert once the threshold has passed; `wedge` is kept until both alerts have posted, so the retry at 450 s is the first after the unwedge | Section 1: the sweep's summary line reads 5 listed, none killed, 5 kept with 3 kills failed, 3 keys recorded as retired and none left for a latch; the first swept row gets exactly `KILL_RETRY_TRIES` (3) CSCB `kill` calls, its per-try lines (`killRetryTryLine`) ending `KILL_RETRY_NEXT_AGAIN` and then, on the last, `KILL_RETRY_NEXT_EXHAUSTED`, and each later row exactly 1, its one per-try line ending `KILL_RETRY_NEXT_BUDGET_SPENT` (the pass's retries are spent); the sweep's duration, from its CSCB `list` carrying the `service` label (read from the agent-director shim's log, as the sweep logs no start line) to its summary line, is at most (3 + the later rows) × CSCB's agent-director call timeout + 2 × `KILL_RETRY_SPACING_MS`, 304 s at the defaults (the measured duration is logged); CSCB makes no `delete`, and every X row is present (harness `get`). Section 2, for each of A and B: exactly one `tmux-unresponsive` started line; at most one onset post and none after its alert; exactly one alert, posted more than the alert threshold (360 s at agent-director's defaults) after the first refusal, and exactly one recovery, posted after the unwedge, each at the persona's destination as the persona notifier's prefix and then the printer's body; no restart-cap notice, cap-reached line, retry entry's cap-skip line or retry timer stopped at the cap (SRJ-305); CSCB calls naming its id continue after its alert; no CSCB `kill`, `delete`, `resume` or reuse spawn naming its id, and the start pass's one plain spawn is the only `spawn` naming it (no relaunch); its row is present. Logged as `NOTE:` lines, not asserted: each persona's CSCB calls by verb, whether its onset posted, every post at its destination (after the recovery the stub's answered dev-channels dialog is still on its screen, so CSCB posts its *Waiting on a prompt* notice, a limit of the stub that the SRD leaves open) and the status reads between the first swept row's tries. Ends with the three closing assertions | tmux-shim `log` while the personas launch, `wedge` (its default 60 s delay, longer than every tmux call timeout at agent-director's defaults) from just before the wedged start until both alerts have posted, then `log`; stub mode `dev-channels`; agent-director's default settings, no `config.toml` (alert threshold `adAlertThresholdMs` of the defaults); CSCB's agent-director call timeout at its default (`DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS`); `health_check_interval` 0 in `config.json`, so no health tick runs; the release start (`SCENARIO_AD_START` unset); live starts against the Slack stub; values from `fixtures/fmk-texts.ts`; posts from the Slack stub's record |
| 7 (b.jg5 SRJ-1409, SRJ-707, SRJ-708, SRJ-711, SRJ-712, SRJ-413, SRJ-716; AC 1) | `test-19-fmk-reuse.sh` | First a harness check of the two harness additions on a stub the harness starts itself (`seed_unlabelled`, no agent-director and no CSCB process): in `transcript-on-first-message` no transcript exists at its dialog, nor after Enter reports it in, nor for 2 s after a typed `/exit`; one exists once a line is typed, the typed exit sentinel ends it, and `stub_type_line` aimed at a missing pane fails. Then two legs, each with its own persona: E with `resume_enabled=false`, and F with a missing transcript (`resume_enabled` true). Each persona's first life comes up (`waiting`); the harness types the exit sentinel, so the row reads `ended`; in leg F the harness unlinks the transcript file, the path under `SCENARIO_ROOT` that the row's `jsonl_path` names. The persona's directory is switched to `transcript-on-first-message`, then a plain `stop` and a start: CSCB's spawn collides with the finished row and, in E, reuses it with no `resume`; in F, CSCB's `resume` meets `ErrJsonlMissing`, the lost-transcript diagnosis runs, then the reuse spawn | A background harness `get`, started before the start, reads `pending` with a `launch_started_at`, then `waiting`, and no `waiting` before it. Exactly one CSCB-parented `spawn` of the persona's id carrying `--reuse-finished` (the agent-director shim's argv) after the leg's mark. E: no CSCB `resume`. F: a CSCB `resume`, and exactly one lost-transcript diagnosis line for the id, logged no later than the reuse spawn's call. A harness `get`'s `prior_sessions` does not hold the first life's session id. Exactly one server-log `pre_trust` line for the reuse spawn, with value `ok`. CSCB makes no `delete`, and the row is present. Then, with the server stopped by a plain `stop` and the new life ended by the exit sentinel before any message, the harness's own `resume` of the id (`ad_capture`) exits non-zero answering `ErrJsonlNeverWritten`, and the row is present. Logged as `NOTE:` lines, not asserted: each leg's CSCB calls of its id by verb, the new life's session id and `transcript_status`, the diagnosis's verdict (its startup-errors entries) and how many reads saw `pending`. Scenario 12's legs follow (next row), then scenario 18's, then the three closing assertions | Stub modes `dev-channels` (each first life) and `transcript-on-first-message` (each new life; a harness addition); `stub_type_line` with `STUB_EXIT_SENTINEL` (harness additions); each persona's `claude_config_dir` holding a `.claude.json` of `{}`, so agent-director's pre-trust answers `ok`; agent-director's default settings, no `config.toml`; `health_check_interval` 0 and `session_restart_delay` 0 in `config.json`; between legs `config.json` rewritten and the last-applied record moved aside while the server is stopped; the release start (`SCENARIO_AD_START` unset); live starts against the Slack stub; values from `fixtures/fmk-texts.ts` |
| 12 (b.jg5 SRJ-1414, SRJ-707, SRJ-709, SRJ-410, SRJ-501, SRJ-505, SRJ-716, SRJ-1401, SRJ-1418; AC 1) | `test-19-fmk-reuse.sh` (legs G and H, after scenario 7's legs) | Two legs, each with its own persona and a background harness `get` of its row until it reads `waiting` again. G, a `missing` row with no session id beside a leftover holding its name: G launches with the `silent` stub, so its row reads `pending` with a launch start and no `claude_session_id`; before G (agent-director's pending grace) has passed from the launch start, the harness types the exit sentinel into G's pane (no hook fires, and the session closes with the stub), seeds a leftover (`seed_leftover`) named G's session name, labelled as an earlier launch of G's id with the store's own id (`ad_store_id`, `ad_owner_label`) and its pane carrying `ad_pane_label`'s label, running the `silent` stub, and switches G's directory to `dev-channels`. CSCB's own pending-row runs mark the row `missing` past G; its `resume` answers `ErrNoSessionId`, and the reuse spawn follows, refused while the leftover runs; after at least two refusals the harness ends the leftover by its session id (`end_session`). H, an `ended` row with a stale `config_dir` label beside its remaining session: H comes up (`waiting`); the harness sets `remain-on-exit` on its session and types the exit sentinel, so the row reads `ended` and the session stays with its pane dead; `repoint_symlink` re-points H's `claude_config_dir` symlink, then a plain `stop` and a start: CSCB's collision `get` reads the row `ended` with a `config_dir` label that is not the persona's, so it makes a reuse spawn and no `resume`, refused while the session remains; after at least two refusals the harness ends that session by its session id | G: a background read of `missing`, with a CSCB-parented `find-missing` after the leg's mark no later than it, and no `find-missing` from any other process; at least one CSCB `resume` of G's id, and a server-log line naming `ErrNoSessionId` on a resume of G no later than the first CSCB reuse spawn. H: no CSCB `resume` of its id; every CSCB-parented `spawn` of its id without `--reuse-finished` is the collision ladder's first spawn of an attempt (SRJ-111), with its `ErrInstanceIdCollision` line. Each leg: every CSCB reuse spawn made before the harness began ending the session (at least two) has its refusal line before then, each UNAVAILABLE or CONFLICT (the class `classifyAdError` gives the error name the line names), apart from at most one in flight across that time, accepted either way; none succeeded before then; exactly one reuse spawn succeeded once the harness had ended the session; the row reads `waiting` with a session id (H's other than its first life's); CSCB makes no `delete`; at least one background read answered and none answered `ErrSpawnNotFound`, so the row was present throughout. Logged as `NOTE:` lines, not asserted: each refusal's error name and description (G's leftover met as CONFLICT, the retry at the latch re-check; H's session met as UNAVAILABLE while still stopping, the retry at the retry timer), the background reads' states in order, the posts at the persona's channel (for G, the held and cleared notices), the reuse's `pre_trust` value, each leg's CSCB calls of its id by verb, and agent-director's trail records naming G's id. Each leg ends with a plain `stop` and the harness ending the new life; scenario 18's legs follow (next row), then the three closing assertions | Stub modes `silent` (G's first life and its leftover) and `dev-channels` (G's new life, H's lives); `stub_type_line` with `STUB_EXIT_SENTINEL`; `seed_leftover`, `ad_store_id`, `ad_owner_label`, `ad_pane_label`, `set_remain_on_exit`, `repoint_symlink` and `end_session`; H's `claude_config_dir` a symlink under `SCENARIO_ROOT` to one of two directories, each holding a `.claude.json` of `{}`; agent-director's default settings, no `config.toml` (G from `adGraceMs` of the defaults); `health_check_interval` 0, `session_restart_delay` 0 and `resume_enabled` true in `config.json`, rewritten with the last-applied record moved aside before each leg; the release start (`SCENARIO_AD_START` unset); live starts against the Slack stub; the harness runs no `find-missing`; values from `fixtures/fmk-texts.ts` |
| 18 (b.jg5 SRJ-1419; b.jg5 SRJ-803 as amended by b.deo SRI-408; b.jg5 SRJ-805; b.jg5 SRJ-806 as amended by b.deo SRI-407; b.jg5 SRJ-807, SRJ-715, SRJ-711, SRJ-1401, SRJ-1418; AC 1, AC 49) | `test-19-fmk-reuse.sh` (legs J and K, after scenario 12's legs) | Two legs, each with its own persona, whose first life comes up (`waiting`) and is messaged: the harness reads the life's session id and `cwd` (`get`), checks that no transcript is at the path agent-director's `resume` looks for that session under the persona's `claude_config_dir` (`<CLAUDE_CONFIG_DIR>/projects/<slug of the cwd>/<session id>.jsonl`), types a first message (`stub_type_line`) and waits for the transcript there, so the old session would be resumable if CSCB resumed it. J, removed and re-added: the operator removes J from `config.json` (no persona left) and confirms the apply by renaming the pending file to the apply file (README "Reload"), checked to be absent before the edit; then a plain `stop`, a start with no persona, and the operator adds J back with the same key, working directory and `claude_config_dir` and confirms the apply. K, `credentials_file` changed: the operator points K's `credentials_file` at a second credentials file and confirms the apply, a destructive modify | Each apply's `reload-applied` line after the leg's mark, for its counts (J's removal 1 removed, J's re-add 1 added, K's change 1 destructively modified). J after the removal: J's session ended (the teardown's kill, the tmux shim in `log`), the retired-key record gives J's key the cause `removed`, and J's row is present. K after the change: the retired-key record's cause for K's key, when it still has an entry, is `destructive-modify` (by then the new life may have begun and the entry been cleared, SRJ-806 as amended by b.deo SRI-407; SRJ-807). Each leg: the row reads `waiting` with a session other than the old one; the first CSCB-parented `spawn` of the persona's id after the re-add's or change's mark carries `--reuse-finished`; a harness `get` shows the old session neither as current nor in `prior_sessions` (an array); from the removal's or change's mark on, no CSCB `resume` of the id, and CSCB makes no `delete`. Logged as `NOTE:` lines, not asserted: the messaged row's `jsonl_path` and `transcript_status`, the persona's CSCB spawns after the mark (how many carry `--reuse-finished`), its CSCB calls by verb, the new life's `transcript_status` and `prior_sessions`, and a destructive modify's retired-key entry already cleared. Each leg ends with a plain `stop` and the harness ending the new life with the exit sentinel; the three closing assertions follow | Stub mode `transcript-on-first-message` for every life of J and K; `stub_type_line` (the message, and `STUB_EXIT_SENTINEL`); tmux-shim `log`, so a teardown's kill succeeds; J's and K's `claude_config_dir` the scenario HOME's `.claude`, the directory the stub writes every transcript under, holding a `.claude.json` of `{}` (agent-director records no `jsonl_path` for a transcript written after SessionStart, and its `resume` then looks under `<CLAUDE_CONFIG_DIR>/projects`); K's second credentials file written at run time with its own fake token pair under its own label, which the Slack stub answers ok; agent-director's default settings, no `config.toml`; `health_check_interval` 0, `session_restart_delay` 0 and `resume_enabled` true in `config.json`, the first life's config written with the last-applied record moved aside while the server is stopped, later edits made on the running server and confirmed by the apply file; the release start (`SCENARIO_AD_START` unset); live starts against the Slack stub; values from `fixtures/fmk-texts.ts` (the pending and apply files' suffixes, `reloadAppliedLogLine`, `retiredKeysPath`, `RETIRED_KEY_CAUSE_REMOVED`, `RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY`) |
| 9 (b.jg5 SRJ-1411, SRJ-901, SRJ-903 to SRJ-907, SRJ-909; AC 1, AC 4, AC 73, AC 75) | `test-21-fmk-teardown.sh` | `clean_restart` and `stop --stop-bots`, each run as a CLI command through `cscb_run` (so its calls count as CSCB's), every leg with its own personas, put in `config.json` while the server is stopped with the last-applied record moved aside. Precheck legs: A and B up (`waiting`); the harness respawns A's worker pane with a `sleep` (`respawn_worker_pane`), so the release's one-line `read-pane` of A answers CONFLICT ("the agent's pane was not found") while A's row stays live and B is untouched. Changing A's `launch_token` is not used: it makes `read-pane` read a leftover's pane, so the precheck would pass. Teardown-failure legs: C and E up; tmux-shim `fail-kill` (no target list) set just before the command; the stub ignores `pause`'s `/exit`, so each pause times out (30 s) and escalates to the kill, whose `KILL_RETRY_TRIES` tries each answer `ErrTmuxKillFailed`. Not-restarted leg: F and G up; the list-refusing stand-in swapped in behind the shim; `fail-kill`; `clean_restart`, whose answer check's `list` tries are refused. Pending-persona leg: D under `unrecognised-dialog`, its row `pending` with a launch start at a dialog CSCB never answers; `stop --stop-bots` (run before G has passed since D's launch start; the script fails otherwise); then D's directory switched to `dev-channels` and a start | Precheck legs, for each command: it exits non-zero; its output holds one precheck failure line naming A, its key, its session and CONFLICT, the description holding `CONFLICT_PANE_NOT_FOUND_PHRASE`, no such line for B, and "nothing was stopped" once, as its last line; A's failure line in neither `server.log` nor `startup-errors.log`; the bot server's PID unchanged and running; at least one CLI-parented `read-pane` of A and no CLI-parented `pause` or `kill`. A's and B's rows are unchanged (a harness `get` before and after). Then the harness ends A's session by its session id (`end_session`), and a harness `read-pane` of A answers `ErrTmuxCaptureFailed` (GONE). Teardown-failure legs, for each of C and E under each command: each kill try's per-try line answers `ErrTmuxKillFailed`, with exactly `KILL_RETRY_TRIES` CLI-parented kills of its id; its failure line printed once, followed by the ordinary alert for the CLI-teardown route, each appended once to `server.log` (and, under `clean_restart`, to `clean_restart.log`), and one `persona-kill-failed` entry holding both; two such entries per command; the last line counting 2; exit non-zero; no CSCB `delete`, both rows present and both sessions still there. After `clean_restart` the bot server runs with a new PID; after `stop --stop-bots` it is gone, with no `server.pid` and no server started after the command's mark. Not-restarted leg: a harness `list` is refused and a harness `version` and `get` answer through the stand-in; no precheck line; F's and G's UNAVAILABLE teardown failure lines; exactly 3 CLI-parented `list` calls carrying the `service` label, with one failed answer-check line per try in `clean_restart.log`; no bot server running and none started after the mark; exactly one not-restarted alert naming F and G, in the command's output, once in `clean_restart.log` and once in `server.log`, recorded as one `clean-restart-not-restarted` entry with the same text; the last line counting 2; exit non-zero; no CSCB `delete`; both rows present. Pending-persona leg: `stop --stop-bots` exits 0, its output holding one escalation line for D carrying `ErrSpawnNotPausable`, with one CLI-parented `pause` and one `kill` of D; the server and D's session are gone. After the next start D's row reads `waiting` within G + `UNAVAILABLE_RETRY_CEILING_S` + 120 s (at least 300 s); no CSCB `kill` of D after that start; no harness `find-missing` in the whole run; exactly one `ad.find_missing.tick` in agent-director's trail marking D's row `missing` from `pending`, with a CSCB `find-missing` at or before it; exactly one launch record for D after the start's mark (`ad.spawn.reused` or `ad.resume.moved_to_pending`), not before that tick. Logged as `NOTE:` lines, not asserted: each leg's CSCB calls of its ids by verb, D's row state after the kill and the restarted server's PID. Ends with the three closing assertions | tmux-shim `log` while personas launch, `fail-kill` (no target list) for the teardown-failure and not-restarted legs' commands, `log` again before the pending-persona leg; stub modes `dev-channels` (A, B, C, E, F, G, and D's recovery) and `unrecognised-dialog` (D); `respawn_worker_pane` and `end_session`; the list-refusing stand-in (`swap_ad_binary <path>`, then `swap_ad_binary release`); agent-director's default settings, no `config.toml` (`[pause] timeout_seconds` 30; G from `adGraceMs` of the defaults); `health_check_interval` 0, `session_restart_delay` 0 and `exit_timeout` 5 in `config.json`; the release start (`SCENARIO_AD_START` unset); live starts against the Slack stub, and the CLI commands with `SLACK_DRY_RUN` unset; values from `fixtures/fmk-texts.ts`; agent-director's trail (`ad-trail.jsonl`) for its marks and launch records |
| 5 (b.jg5 SRJ-1406, AC 3, AC 29, AC 32) | `test-17-fmk-launch-pending.sh` | test-17's first leg (`leg_launch_pending`) | A launch in progress: a resume held at the dev-channels dialog reads `pending` with its kept `claude_session_id` and a launch start. While it is held, health ticks and a `resume` forced through `fmk-driver.ts` change nothing: the forced call gets `ErrSpawnNotResumable`, not counted and not posted (no notice line for the persona on the driver's standard error: neither the no-notifier line nor the driver's outage-notice line), and the bot server makes no other launch, no kill and no post, and writes no reconnect, relaunch or restart line for the persona. The health ticks are counted: over the hold of D seconds, at least ⌊D / tick interval⌋ − 1 bot-server `status` reads of the persona are not followed by a `read-pane` (a tick reads status only; an approver lap reads status, then the pane). After the delay, the approver clears the dialog only through the bot server's `read-pane` and `send-keys` with `--allow-pending` on the `pending` row (no `send-keys` before the delay ends, no approver log line for the persona), the row reaches `waiting` with the same `claude_session_id`, and the bot server starts no tmux process (`assert_no_server_tmux`). Then the launch-timeout legs (`leg_launch_timeouts`, AC 29): a plain spawn (no row), a reuse (a finished row whose `cwd` differs from the persona's working directory, replaced with `spawn --reuse-finished`) and a `resume` (a finished row with its `claude_session_id`) each end in a launch timeout (`LAUNCH_TIMEOUT_PHRASE`, or the `ErrCallTimeout` form) and one post-timeout get line that starts the approver. Per persona: the launch is of its kind; one bot-server `get` of the row, after which a harness read finds it `pending`; then the bot server's `read-pane` and `send-keys` with `--allow-pending`, whose `send-keys` adopts the pane after the lost reply; the stub reports in only after that `send-keys`; a tmux-unresponsive ended line comes no later than the first read out of `pending`; every retry line of the retry timer (matched whole, so never the re-armed line) is followed by a bot-server read of the row, with no launch (how many retries each persona had is recorded, not asserted); no spawn, reuse or `resume` after the launch, no kill, no conflict-latch line, and no post (no spawn-failure or CONFLICT notice); the row reaches `waiting`, the `resume` keeping its `claude_session_id`. The reuse and `resume` personas' own plain spawn, the ladder's first step, collides first (recorded, not asserted). Then the restart leg (`leg_restart_mid_launch`, AC 32): a launch held at its starting screen across a plain `stop` (no `--stop-bots`) and a start is found `pending` by the new server, whose one plain spawn collides with the row and launches nothing; it runs no approver of its own, its first `read-pane` of the row comes at or after G past the launch start, and its pending-row lap's `send-keys` with `--allow-pending` clears the dialog, the only `send-keys` of the row before it leaves `pending`; the row reaches `waiting` with no reuse, `resume`, kill or post; the old server's approver, stopped at shutdown (its one shutdown stop line for the persona in the old server's log), arms nothing for the row: no armed or not-armed retry-timer line for the persona follows that stop line | Scenario 5's leg: the tmux shim in `log` throughout. The stub in `dev-channels` with a dialog delay (`stub_dialog_delay`) of 30 s, set in the persona's working directory before the resume: one health tick, the forced `resume`'s 20 s bound and 7 s slack, checked to be shorter than agent-director's default G (60 s) less the approver's clear. The worker ended with the stub's sentinel; the bot server's restart path makes the resume. `fmk-driver.ts`'s forced `resume` through `cscb_run`. Health ticks on through config: `health_check_interval` 3 s, `session_restart_delay` 5 s. The launch-timeout legs: `health_check_interval` 0 (no tick is needed). The reuse and `resume` personas are brought up in one state dir, stopped with a plain `stop` and their workers ended with the sentinel; the three launches start in a second state dir, with the reuse persona in another working directory. The tmux shim in `slow-create` for that start, its delay one whole create timeout (`create_timeout_ms`) plus 10 s, checked to be above agent-director's create timeout and below CSCB's agent-director call timeout, so the session is created and the launch call times out; the shim is set back to `log` once every persona's post-timeout get line is in `server.log`. Each persona's working directory has a dialog delay of one create timeout per persona plus 8 s (agent-director makes one session-creating call at a time), so a harness read after each `get` still finds the row `pending`; the stub then holds at the dev-channels dialog until the approver's Enter and reports in with its SessionStart re-fire. The restart leg: `health_check_interval` 0, one persona with a dialog delay of 30 s (longer than the stop and the start, checked; shorter than G, checked); the harness reads the row until it leaves `pending`, bounded at G + `UNAVAILABLE_RETRY_CEILING_S` + 10 s from the launch start. Each leg in its own state dir, each with its own Slack stub. agent-director at its defaults (no `config.toml`). Posts read from the Slack stub's record. The create timeout, the call timeout, G, the launch-timeout phrase, the retry timer's base and ceiling, the pending-row rule's log head, the tmux-unresponsive ended lines, the retry-timer line heads (`unavailableRetryLineHead`, `unavailableRetryArmedHead`, `unavailableRetryStoppedHead`, `unavailableRetryNotArmedHead`), the retry line's parts (`unavailableRetryRetryLineParts`), the post-UNAVAILABLE get line's parts and form texts (`launchUnavailableGetLineParts`, `launchUnavailableFormText`), the tmux-unresponsive line head (`tmuxUnresponsiveLineHead`) and the approver's shutdown stop line (`approverShutdownStopLine`) printed by `fmk-texts.ts` |
| 11 (b.jg5 SRJ-1413, AC 6) | `test-17-fmk-launch-pending.sh` | test-17's fourth leg (`leg_fail_create`) | A failed fresh spawn, test-17's fourth leg (`leg_fail_create`): a persona with no row, whose plain spawn under the tmux shim's `fail-create` ends in `ErrTmuxSessionCreate`, leaving a `pending` row with a launch start, the only `pending` row before G. The bot server's one launch call while the shim is in `fail-create` is that plain spawn (no `--reuse-finished`). It runs no `find-missing` between the launch start and G; its own pending-row run from G marks the row `missing` (one pending-row rule round line naming the run `PENDING_ROW_RUN_MARKED_MISSING` and its get `missing`, no later than the next launch), and the persona's next launch comes only after that `find-missing` and a bot-server `get` of the row between the two; a harness read of `missing`, when one catches it, comes after that run. No `kill` of the row from any CSCB process, and no `find-missing` in the leg from any process but the bot server. No post holds "dispatcher bug" (the whole recorded post, case-insensitively); at most one post holds the spawn-failure notice's first line, and that one holds the notice's head for `ErrTmuxSessionCreate`; no other post (no cap, alert or stuck-launch post). The row reaches `waiting` and the persona's session is registered. Whether the counted failure posted a spawn-failure notice is recorded, not asserted | `health_check_interval` 0 (the failure arms the retry timer at once, so no tick is needed). Its own state dir and Slack stub; one persona with no row and no dialog delay. The tmux shim set to `fail-create` before the start, and set back to `log` by the harness once `server.log` holds the plain spawn's `ErrTmuxSessionCreate` line for the persona; at least one `new-session` call reaches the shim in `fail-create`. The harness runs no `find-missing`: the persona is not latched, so CSCB's own pending-row runs mark its row. The harness reads the row every 1 s until it is live, bounded at G + `UNAVAILABLE_RETRY_CEILING_S` + 40 s from the launch start, and before G follows each `pending` read with `list --state pending`. agent-director at its defaults (no `config.toml`). Posts read from the Slack stub's record. G, the retry timer's ceiling, the pending-row rule's log head, `PENDING_ROW_RUN_MARKED_MISSING`, the spawn-failure notice's head for `ErrTmuxSessionCreate` (entry `spawnFailureNoticeHead`, from `spawnFailureNoticeText`) and the persona's retry-timer line head (entry `unavailableRetryLineHead`, for the recorded lines) printed by `fmk-texts.ts` |
| 13 (b.jg5 SRJ-1415) | `test-17-fmk-launch-pending.sh` | test-17's fifth leg (`leg_still_stopping`) | A paused bot's immediate `resume` meets a worker still stopping, test-17's fifth leg (`leg_still_stopping`). After a health tick's read of persona S, the harness pauses S: the `pause` returns within its bound of that read, the row reads `ended` with its `claude_session_id`, and the worker's tmux session and pane process still run. The bot server then resumes S inside the stopping window from the pause (what scheduled the resume is recorded, not asserted), and agent-director refuses it: exactly one server.log refusal of S's `resume` carries `STILL_STOPPING_PHRASE` (UNAVAILABLE), followed by exactly one post-UNAVAILABLE get line and exactly one bot-server `get` of the row between the refused `resume` and that line. Once the harness releases the worker, its session ends, and the retry timer's first retry after the refusal comes after the release and the session's end; the second `resume` follows that retry within its slack, before the next tick's read and before the row reads `waiting` again: the success is a retry's, not a tick's. Exactly two bot-server `resume`s of S after the pause; no reuse spawn or `kill` of S from any CSCB process (each `resume` follows its ladder's plain spawn, which collides with the row: recorded, not asserted). The row reads `waiting` with the same `claude_session_id` and the resumed stub's session is registered. No post from the pause on: none holds S's tmux-unresponsive onset or the spawn-failure notice's first line, and there is no alert or other post (a single refusal that clears by the next tick posts nothing); these record checks run again once the server has stopped (shutdown ends every episode silently, so any post the next tick's onset check made is in the record by then). No server.log line after the second `resume` names S with a reconnect, relaunch, restart scheduling or not-connected text | Its own state dir (`paused`) and Slack stub; one persona whose working directory is selected for the stub's `linger-on-exit` (`stub_mode`). Health ticks on through config: `health_check_interval` 58 s, derived as the pause's bound (5 s), the restart delay, a launch slack (10 s), `UNAVAILABLE_RETRY_BASE_S` and a launch slack again, checked longer than the retry base; `session_restart_delay` 3 s. The refused `resume` is due within the pause's bound, the restart delay and a launch slack of the tick's read, checked shorter than agent-director's default stopping window (90 s). Before the pause the bring-up's approver and its retry timer have stopped, so only a tick reads S's status and the refusal arms a fresh timer. The harness plays a human's `pause` from the scenario's own shell, through the agent-director shim, and calls `stub_release` once server.log holds the refusal. The next tick's read is checked within 2 s of the interval. agent-director at its defaults (no `config.toml`). Posts read from the Slack stub's record. `STILL_STOPPING_PHRASE`, the stopping window (`DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds`), the retry timer's base, the spawn-failure notice's head, S's tmux-unresponsive onset body (entry `tmuxUnresponsiveOnsetText`), the retry-timer line heads (`unavailableRetryLineHead`, `unavailableRetryArmedHead`, `unavailableRetryStoppedHead`), the retry line's parts (`unavailableRetryRetryLineParts`), the post-UNAVAILABLE get line's parts (`launchUnavailableGetLineParts`) and its plain UNAVAILABLE form head (`launchUnavailableFormText none`), and the tmux-unresponsive line head (`tmuxUnresponsiveLineHead`) printed by `fmk-texts.ts` |
| 21 (b.jg5 SRJ-1423, AC 9) | `test-24-fmk-stuck-launch.sh` | test-24 (`leg_own_stuck_launch`, then `leg_other_process`) | A launch stuck at a startup prompt the approver does not recognise, in four legs, in this order. The own-launch leg (`leg_own_stuck_launch`, persona P): CSCB's start pass resumes P's finished row, and the launch, held at the stub's unrecognised dialog, reads `pending` with the same `claude_session_id` and a launch start. The bot server runs no `find-missing` from the launch start to G; from G its pending-row runs read the row not judged, at least one a retry's, consecutive runs at least 2 × `UNAVAILABLE_RETRY_BASE_S` (60 s) apart, the gap ending at the approver's stop's run excepted. At B: exactly one `server.log` line equal to the approver's line at B, and no post from the approver; the rule's run at that stop makes exactly one relaunching post and exactly one bot-server `kill --claude-instance-id cscb_<P>` (no `--include-finished`) whose abort line carries `kill_sent` true, after which P's worker is gone; a bot-server `find-missing` then marks the row `missing`, and a bot-server `resume` of the same session id brings it to `waiting`. Exactly two bot-server `resume`s of P's row (the start pass's and the relaunch), no reuse spawn, no counted failure, and no post but the relaunching one (no spawn-failure or held post). The other-process leg (`leg_other_process`, persona Q): the harness's own `resume` of Q's finished row, a harness call through the shim from the scenario's shell playing another process, holds Q at the unrecognised dialog; the server started after it finds the row `pending` and makes exactly one held post, equal to the held notice for Q's session and launch start with the attach remedy, and no second held post at a later retry. The harness's `resume` is the only one of Q's row; no CSCB process kills, resumes or reuse-spawns it. The relabelled-session leg (`legs_relabelled_session_and_grouped_viewer`, persona R): CSCB's start pass resumes R's finished row, held at the unrecognised dialog as in the own-launch leg; after the approver's first `status` lap of R's row and before B, the harness relabels R's own session to name an earlier launch of `cscb_<R>`, so the session is a leftover to agent-director while its worker still runs. At B: exactly one relaunching post for R, then exactly one bot-server `kill --claude-instance-id cscb_<R>` (no `--include-finished`), answered CONFLICT with a description carrying `CONFLICT_NOT_THIS_LAUNCH_PHRASE` ("not this launch's session") and no abort line with `kill_sent` true; R latches with exactly one latch-set line and no relatch, and R's posts are exactly the relaunching post and then one CONFLICT post (`conflictNoticeText`); no second `kill` of R's row through the first latch re-check round (`LATCH_RECHECK_INTERVAL_MS`, 120 s, after the latch), exactly one bot-server `resume` of R's row (the start pass's) and no counted failure. The grouped-viewer leg (the same function and server run, persona V): CSCB's own resumed launch held the same way, with a grouped viewer session the harness attaches to V's session (`attach_viewer`, playing a human watching); at B exactly one relaunching post for V and exactly one bot-server `kill --claude-instance-id cscb_<V>` whose abort line carries `kill_sent` true, after which V's worker is gone and V's relaunch reads `waiting` | Each leg in its own state dir with one persona and its own Slack stub (posts read from its record), except the relabelled-session and grouped-viewer legs, which share one state dir, server run and stub with R and V (a `find-missing` run judges both rows, so no check of these legs counts `find-missing` runs, and every check is attributed to one persona). The stub in `dev-channels` for each bring-up; a plain `stop` (no `--stop-bots`), then the worker ended with the stub's sentinel, so the row is finished with its `claude_session_id`; the persona's working directory then selected for `unrecognised-dialog`. Own-launch leg: a live start makes the held resume; the directory is then selected for `at-once`, so the relaunch reports in at once. Other-process leg: the harness's `resume`, then a live start timed so its retries reach B; cleanup is the harness's Enter into Q's pane (`stub_press_enter`, playing a human), after which the row reads `waiting`. Relabelled-session and grouped-viewer legs: a live start makes both held resumes; V's directory is then selected for `at-once` and the viewer attached (`new-session -t`, in the same session group); R's relabel (its labels drawn as `relabel_session` draws them, a fresh token other than the label's and the row's current launch token, and written in one tmux invocation, both `set-option`s one command list, so no agent-director read sees one label new and the other old) follows the seeding rules of b.jg5 SRJ-1306 as amended by b.deo SRI-1402 to SRI-1404 (agent-director's handoff rev 15 and rev 17): the `@ad_owner` label keeps R's instance id and ends with the scenario store's own id (`ad_store_id`), and R's worker pane carries `@ad_pane` = `<token> <pane id>`, so the approver's laps' `read-pane` returns that pane; the relabel lands after the approver's first lap, once a later pane read of R is answered and while the next lap is due at least 0.5 s later (else on the next lap's pane read), and before B. `health_check_interval` 0 (the retry timer drives every pending-row run), `session_restart_delay` 5, `exit_timeout` 5. agent-director at its defaults (no `config.toml`, no `[tmux]` table), so the waits derive from G (60 s) and B (300 s) and run at least 300 s from each launch start. The tmux shim in `log` throughout. G, B, the retry timer's base and ceiling, the approver's line at B, the pending-row rule's lines, the relaunching and held posts, the poster's lines, the abort kill line's head and the live-row sequence's marked-missing lines printed by `fmk-texts.ts`, as are the CONFLICT abort kill line's head, `CONFLICT_NOT_THIS_LAUNCH_PHRASE`, the latch-set line, the CONFLICT post, the latch re-check round line's head and `LATCH_RECHECK_INTERVAL_MS` |
| 22 (b.jg5 SRJ-1424, AC 10) | `test-25-fmk-pre-trust.sh` | test-25 | Each launch's `pre_trust` is only logged, through the exported builder (`preTrustLogLine` in `src/session-manager.ts`), and no launch opts out of pre-trust, in three legs, in this order. The migrated-row leg (`leg_migrated_row`, persona A): A's row, seeded on 0.10.0 and migrated by `install_ad_release`, reads finished with the same `claude_session_id`, session name and labels, the release behind the shim and both shims re-checked; CSCB's start pass then resumes it. Exactly one `pre_trust` line for A, for its `resume`, equal to `preTrustLogLine` for one of `ok`, `skipped`, `failed` or no field (the older-binary wording); the script logs which, and a value other than `ok` or `failed` is printed as a `REPORT:` line, not failed on. Exactly one bot-server `resume` of A's row, no reuse spawn or `kill` of it; every bot-server `send-keys --allow-pending` of A's row follows a bot-server `read-pane --allow-pending` of it made after the `resume` (the approver clears the folder-trust prompt if it appears); A reads `waiting` with the same `claude_session_id`. The new-persona legs (`legs_new_personas`, one server run): persona B, new, whose resolved `.claude.json` exists, gets one plain spawn and exactly one `pre_trust` line, `preTrustLogLine` for `ok`, and reads `waiting`; persona C, new, with a fresh `claude_config_dir` holding no `.claude.json`, gets one plain spawn and exactly one `pre_trust` line, `preTrustLogLine` for `failed`, and its launch proceeds: at least one bot-server `send-keys --allow-pending` of C's row, the first after a bot-server `read-pane --allow-pending` of it, C's pane holding the folder-trust prompt and not the dev-channels dialog, and C reads `waiting`. Neither gets a `resume`, reuse spawn or `kill`. The script-wide check (`check_no_pre_trust_opt_out`): no CSCB-parented `spawn` or `resume` in the agent-director shim log's argv carries `--no-pre-trust` (the 0.11.0 client's flag for `no_pre_trust`), with at least one of each to check | The scenario HOME starts on agent-director 0.10.0 (`SCENARIO_AD_START=0.10.0`, no store); `seed_010_row` makes A's row with 0.10.0's own `spawn` (`cscb_<A>`, A's session name and the labels a spawn of A carries) and a stub worker in `at-once`, which then ends with the stub's sentinel so the row has a `claude_session_id`, before `install_ad_release` runs the release's `install.sh` and its migration over it. Each leg in its own state dir with its own Slack stub. Every persona's working directory selected for `folder-trust` before its launch. The harness writes no `~/.claude.json` in the scenario HOME before A's resume (whether one is there is recorded); before the new-persona legs the harness writes `{}` there if it is absent, as B's resolved `.claude.json`; C's `claude_config_dir` is a new empty directory under the scenario root. `health_check_interval` 0, `session_restart_delay` 5, `exit_timeout` 5. agent-director at its defaults (no `config.toml`, no `[tmux]` table). The tmux shim in `log` throughout. The `pre_trust` lines and their head, the launch verbs, `TRUST_DIALOG_NEEDLE`, `DEV_CHANNELS_DIALOG_NEEDLE`, `DIALOG_POLL_INTERVAL_MS`, the instance id, session name and A's labels printed by `fmk-texts.ts`; the values `ok`, `skipped`, `failed` and the flags `--no-pre-trust` and `--allow-pending` quoted from the 0.11.0 client |
| 10 (b.jg5 SRJ-1412; AC 1, AC 5) | `test-22-fmk-wrong-server.sh` | Part A: two harness `find-missing` runs (`ad_capture`) while the persona's worker runs, one with `TMUX_TMPDIR` set for that call only to an empty directory under `SCENARIO_ROOT`, one with `TMUX` set for that call only to a second tmux server (`start_second_tmux_server`). Part B: the harness's one store statement (`ad_store_mark_finished <id> missing`, scenario 10 part B's), made once the session is older than the larger `[tmux]` minimum; then the bot server restarted without teardown (a plain `stop`, then `start`), whose bring-up makes a plain `spawn` (agent-director answers `ErrInstanceIdCollision`) and then a `resume`; the latch re-check's probe; the human's finished-row kill, `ad_kill_include_finished` (agent-director-admin's `kill-finished`) from the scenario's own shell; the re-check after it | Part A: each run exits 0 with an `ids` array that does not hold the persona's instance id, logged with the scenario's shell as parent, and the prefix assignment does not outlive the call; the script does not check that each run saw the other environment (the shim logs arguments and parent, not environment). Then the row still reads `waiting` and the worker runs, and over one re-check interval and 5 s more no CSCB process makes a `resume`, `spawn`, `kill`, `read-pane` or `send-keys` for the persona, nor any `find-missing`; no post and no latch or relatch line (`conflictLatchSetLineHead <key> latched` and `relatched`). That hold is a no-trigger window: nothing in it would make CSCB call for the persona (no health tick, no latch, no restart), so its no-call checks cannot fail on their own; SRJ-1412 A's "CSCB does nothing" rests on the two runs' `ids` checks and on the row still reading `waiting` with the worker running after them, and the hold only shows that nothing follows. Part B, the latch: the new bot server's `resume` meets the own-id CONFLICT (`CONFLICT_OWN_ID_PHRASE`); an UNAVAILABLE line carrying `STILL_STOPPING_PHRASE` or `STILL_STARTING_PHRASE` may come before it, and none after (the wait past the starting-session bound means none is expected); the persona latches with `LATCH_CASE_OWN_ID` (its latch line: the printed `conflictLatchSetLineHead <key> latched`, the case, then agent-director's description carrying `CONFLICT_OWN_ID_PHRASE`); exactly one post, carrying in order the persona prefix with `CONFLICT_NOTICE_FIRST_LINE_HEAD` and the quoted session name, `conflictCaseSentence`, `CONFLICT_NOTICE_POINTER_LINE` and `CONFLICT_NOTICE_HUMAN_ONLY_LINE` (`src/conflict-latch.ts`), with no session-ending command form in its CSCB-authored lines (`sessionEndingCommandsIn`). The held latch, over two re-checks: each window holds exactly one `status` and then one `read-pane --n-lines` `PROBE_PANE_READ_LINES` by the bot server (`version` left out), each round logs its round line, printed whole by `latchRecheckRoundLine` with `RECHECK_STEP_TABLE`, `RECHECK_CALL_PROBE` and the answer `still-latched (pane)` (composed inline by src/session-manager.ts runLatchRecheckRound from `RECHECK_VERDICT_STILL_LATCHED` and `PANE_READ_PANE`), no further post, the worker runs and the row reads `missing`. The kill: `kill_sent` true, the session and worker gone, and the row unchanged: every column after the kill holds its value from before it (`_scenario_row_diff_check`, whose failure names each changed column with its values before and after). The clear: from the second re-check to the first `resume` after it, exactly `status`, the one-line `read-pane`, `find-missing` and `resume`, once each; the round logs its round line, printed by `latchRecheckRoundLine` with the call `<probe>+find-missing+<resume>` (`RECHECK_CALL_PROBE`, `RECHECK_CALL_RESUME`) and matched up to the answer's `probe-cleared (gone);` (composed inline by src/session-manager.ts from `PANE_READ_GONE`, agent-director's `ErrTmuxCaptureFailed`); the row reads `waiting` again; the second and last post of part B is exactly `formatPersonaNotice` of `conflictRecoveryText` with `LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED`; once that post has settled, the whole window from the second re-check holds exactly one CSCB `resume` of the instance id and exactly one CSCB `find-missing`. Close: one finished-row kill in the shim log, the harness's, parented by the scenario's shell; no CSCB `kill`, and no CSCB `spawn` from the latch on | tmux-shim `log`; the stub's `dev-channels` hold (`STUB_MODE_DEV_CHANNELS`); `health_check_interval` 0; `agent_director_poll_interval_ms` at its allowed maximum (`MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS`, src/config.ts), so the permission poller's `list` calls do not fall in the counted re-check windows; the `[tmux]` table (`write_ad_settings`) with `stopping_window_seconds` 30 and `starting_session_seconds` 60, each at its minimum from `AD_SETTING_MINIMUMS <key>` (src/ad-settings.ts). Every text, phrase, label, interval, line count, latch line head and round line from `fixtures/fmk-texts.ts`; calls read with `cscb_ad_calls_between` / `cscb_ad_count_between` between `ad_shim_mark` marks, posts with `slack_record_mark` and `slack_label_posts`. Runs about ten minutes |
| 26 (b.jg5 SRJ-1428; AC 1, AC 19, AC 86) | `test-28-fmk-provenance.sh` | Two personas, A and B. Renamed session: the harness renames A's session (`rename_session`) and turns ticks on with the confirmed config edit (`apply_personas_config`, as in the restarted-tmux-server leg: `health_check_interval` 10, `session_restart_delay` 5), then the bot server restarted without teardown (a plain `stop`, then `start`), which for A's live `waiting` row makes `get`, a plain `spawn` (agent-director answers `ErrInstanceIdCollision`), `get` and a `send-keys` of `/mcp reconnect …` (its reconnect of the stub, whose MCP session ended with the old bot server), and no pane read; then the harness ends A's stub MCP client (`end_stub_mcp_session` on A's pane; the stub runs on): the stream close (`Session disconnected (SSE abort)`) schedules the restart path's restart of A after `session_restart_delay` (src/server.ts `_buildRestartDisconnectedPersona`), and its reconnect of A's live `waiting` row runs the waiting-row check (src/session-manager.ts `checkWaitingRowPane`), the same check a tick's restart runs (a health tick skips a persona with a restart pending, src/health-check.ts), which reads the pane, finds no prompt and types `/mcp reconnect …`; the same edit then turns ticks off again (`health_check_interval` 0 and the default restart delay), taking effect at the start after the teardown; `fmk-driver.ts`'s `read-pane-other-tmux-tmpdir` for A through `cscb_run`; then `stop --stop-bots` (`stop_server --stop-bots`), whose teardown's pause times out (the stub never answers `/exit`), and a start again. Another `TMUX_TMPDIR`: `fmk-driver.ts`'s `read-pane-other-tmux-tmpdir` for A and for B, with `TMUX_TMPDIR` set for that one call to an empty directory under `SCENARIO_ROOT`. Re-bound socket: the harness re-binds the scenario's socket path while the recorded server runs (`rebind_tmux_socket`), then the bot server restarted without teardown, whose reconnect is the tmux-touching call; the retry timer's waiting-row checks; then the harness restores the socket (`restore_tmux_socket`). Restarted tmux server: the harness's confirmed config edit (the script's `apply_personas_config`: `config.json` rewritten with `health_check_interval` 10 and `session_restart_delay` 5, the previewed `config.json.pending` renamed to `config.json.apply`, and the apply of two server-wide settings logged), then the bot server restarted without teardown, since a changed server-wide setting takes effect at the next start; the harness restarts the scenario's tmux server (`restart_tmux_server`: `kill-server`, then a new server with one session) and runs the find-missing loop (`run_find_missing_loop`, 10 s interval; decision D2) until each row is marked `missing` (it reads `missing`, the `ids` of a loop run started in the leg, read from its `run.<n>.out`, hold its instance id, or it records another launch), then stops it; the restart path brings each persona up again; then the same confirmed edit sets `health_check_interval` 0 (and the default restart delay) and the bot server is restarted without teardown. Remain-on-exit: once A's session is older than the starting-session bound (`DEFAULT_AD_SETTINGS <AD_TMUX_TABLE> starting_session_seconds`, 300 s), the harness turns `remain-on-exit` on for it (`set_remain_on_exit`) and ends A's worker with no SessionEnd (`end_worker_without_session_end`); the loop (D2) runs until A's row reads `missing`; the bot server restarted without teardown makes A's `resume`; the latch re-check; then the harness removes the dead session by its id (`end_session`). Pending row with no launch start: the harness's store statement (`ad_store_pending_no_launch`) on B's live row, its session and worker left in place; the bot server restarted without teardown makes the row's first read; the latch's status-only re-check; the find-missing loop until B's row reads `missing` (the loop's latched-row use); the clearing re-check and its one bring-up retry; then, if B's session name still holds the old session, the harness ends it (`end_session`). Close: `stop --stop-bots`, then a scan of the tmux shim's log | Renamed session: a bot-server-parented `send-keys` of A follows the rename and reaches the renamed session's pane (A's stub opens a new MCP session); server.log holds no waiting-row GONE, reconnect GONE or escalate-dead line for A since the restart (`waitingRowPaneGoneLineHead`, `reconnectGoneLineHead`, `escalateDeadSweepLineHead`, src/session-manager.ts); no CSCB `resume` or `kill` of A, CSCB makes no `delete` of A, and the restart's one refused `spawn` launched nothing (worker, pane process and launch token as before); A's row reads `waiting`. The health check's pane read (decision D4): after A's MCP client ended, exactly one CSCB `read-pane` of A, by the bot server, with `--n-lines` `FULL_PANE_READ_LINES` (src/pane-read.ts, 40, printed), followed by a bot-server `send-keys` of A (`/mcp reconnect …`), and A's stub opens a new MCP session; no CSCB `spawn`, `resume` or `kill` of A, and CSCB makes no `delete` of A; no waiting-row GONE, reconnect GONE or escalate-dead line for A; A's worker, pane process, launch token, `waiting` row and renamed session unchanged; B untouched (no CSCB `read-pane`, `send-keys`, `spawn`, `resume` or `kill` of B, and CSCB makes no `delete` of B, the same MCP client, worker and launch token, its row `waiting`). The restart's `send-keys`, the driver's pane read and the teardown's precheck `read-pane` below stand beside it as further evidence. The driver's pane read of A answers `outcome=` `PANE_READ_PANE` with a driver-parented `read-pane`. The teardown's one-line `read-pane` (`PROBE_PANE_READ_LINES`) and plain `kill` of A (no `--include-finished`) both have the `stop` run as parent, and A's worker and renamed session are gone; the positive control of leg 6's no-kill scan: over the teardown, between two tmux shim marks, at least one tmux shim line matching `kill-session` or `kill-pane` as a word has an agent-director process as its parent (agent-director's own kill of the session); after the start both rows read `waiting`. Another `TMUX_TMPDIR`: per persona one `DRIVER:` line with that `tmux_tmpdir`, `restored=true` and `outcome=` `PANE_READ_PANE`, a driver-parented `read-pane`; both rows read `waiting`, both workers as before, and no CSCB `spawn`, `resume` or `kill`, and CSCB makes no `delete`. Re-bound socket: each persona's first post is exactly `formatPersonaNotice` of `tmuxServerChangedOnset` (src/outage-state.ts, SRJ-1021); held until the third retry falls due (`unavailableRetryDueS 3`: src/backoff.ts doublingBackoffDelay summed over src/unavailable-retry.ts's `UNAVAILABLE_RETRY_BASE_S` and `UNAVAILABLE_RETRY_CEILING_S`, 210 s in this build) and 30 s more, each persona's posts run onset, then any number of all-clear (`ALL_CLEAR_TEMPLATE` `tmux-unavailable`) and onset pairs, never the generic `ONSET_TEMPLATES` `tmux-unavailable` onset; server.log carries `DIFFERENT_TMUX_SERVER_PHRASE` (src/ad-description-phrases.ts); at least three bot-server `read-pane` calls per row; no CSCB `kill`, `resume` or launching `spawn`, and CSCB makes no `delete`; both rows read `waiting` with the same workers. After the restore each persona's last post is its all-clear (waited for until the fourth retry, `unavailableRetryDueS 4`, 450 s after the onset in this build, and 30 s more), the sequence still fits, each stub opens a new MCP session, and both rows read `waiting` with the same workers. Restarted tmux server: Q12's control, over two tick intervals once the ticks are on, finds at least one `status` of each persona and no `send-keys`, `spawn`, `resume` or `kill`, the server makes no `delete`, with nothing launched; after the tmux restart each row reads `waiting` with a new launch token; per persona exactly one `resume`, by the bot server, at most one plain `spawn` before it and no `--reuse-finished` spawn, no CSCB `kill`, and CSCB makes no `delete`; server.log holds exactly one `relaunchWithoutKillLine` (`RELAUNCH_NO_KILL_ROW_READ`, `LIVENESS_READING_DEAD_MISSING`) and one `relaunchAfterKillLine` (`RELAUNCH_KILL_NONE`) per persona (src/restart.ts), and no counted-failure or cap line (`[slack] Session relaunch failed for persona=<key>`, `[slack] Cap reached for persona=<key> `, inline literals in src/restart.ts quoted as fragments); no post holds the spawn-failure notice's first line (`restartCapReachedNoticeText`'s). Remain-on-exit: right after the worker ends, A's row still reads `waiting` and its session remains; once the loop marks it, the session still remains and B's row reads `waiting` with its worker running; after the restart A latches on `CONFLICT_OWN_ID_PHRASE` with `LATCH_CASE_OWN_ID` (its latch line: the printed `conflictLatchSetLineHead <key> latched`, the case, then agent-director's description), and server.log holds at least one UNAVAILABLE line carrying `STILL_STOPPING_PHRASE` or `STILL_STARTING_PHRASE`, every one before the first CONFLICT line; A's posts in the leg end with one latch post carrying scenario 10's CONFLICT notice parts in order with no session-ending command form, and before it only the tmux-unresponsive onset and alert (`tmuxUnresponsiveOnsetText`, `tmuxUnresponsiveAlertText <key>`, the alert at agent-director's default settings, src/persona-episodes.ts; SRJ-308, SRJ-309), each at most once; no kill sent (decision D3): no CSCB `kill` or `delete` of A, no tmux shim line, whatever its parent, matching `kill-session` or `kill-pane` as a word since the leg began (leg 2's teardown is its positive control), and the dead session still holds A's name; at least one bot-server `resume`, no `--reuse-finished` spawn, and the row reads `missing` with its launch token. After `end_session`: up to the next `resume`, the bot server's calls of A (and any `find-missing`) are exactly `status`, the one-line `read-pane`, `find-missing` and `resume`; the round logs its round line, printed by `latchRecheckRoundLine` and matched up to the answer's `probe-cleared (gone);`; A's row reads `waiting`; A's posts in the leg end with the latch post and exactly one recovery post, `formatPersonaNotice` of `conflictRecoveryText` with `LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED`; once that post has settled, the whole window since the dead session's removal holds exactly one CSCB `resume` of A and exactly one CSCB `find-missing`. Pending row with no launch start: B latches with `LATCH_CASE_LAUNCH_START_NOT_RECORDED` (its latch line's printed head and the case) and its one post is exactly `formatPersonaNotice` of `launchStartNotRecordedNoticeText`; the first re-check makes one bot-server `status` of B and nothing else, its round line, printed whole by `latchRecheckRoundLine`, carrying `RECHECK_STEP_TABLE`, `RECHECK_CALL_NONE` and `RECHECK_VERDICT_STILL_LATCHED`; no CSCB `send-keys` or `kill` of B while it is latched; the worker runs and the row reads `pending`. Once the loop marks the row `missing`, a re-check's round line (printed whole by `latchRecheckRoundLine`) logs `cleared (` `RECHECK_STEP_TABLE` `)` and the after-clear retry's answer line follows (`latchClearRetryAtOnceLineHead`, exactly one); from the held re-check to that line, `status` first, no `find-missing`, no `send-keys` or `kill`, and exactly one bot-server `resume` (at most one plain `spawn` before it); server.log holds one `relaunchWithoutKillLine` (row read missing) and one `relaunchAfterKillLine` (no kill) for B; B's second post is exactly `formatPersonaNotice` of `holdRecoveryText` for `latchRecoveryReasonRowReads` `missing`, the only such post. What that retry meets beside the still-running old session (ruling S8) is logged, not asserted: its answer line, B's server.log lines, B's posts and its row. Close: `cscb_tmux_count` finds no tmux shim line whose parent is a CSCB process (bot server, `start` or `stop` run, driver run), so none carries `SCENARIO_AD_OWNER_OPTION` or `SCENARIO_AD_PANE_OPTION`; the filter's control counts exactly the bot-server, `stop`-run and driver-parented lines added to a copy of the log, not the scenario shell's or an unrecorded process's; the positive control finds lines carrying each option with an agent-director parent; then the three closing assertions. SRJ-716's static half is `tests/fmk-source-audit.test.ts` | tmux-shim `log`; the stub's `dev-channels` mode (`STUB_MODE_DEV_CHANNELS`); agent-director's default settings (no `[tmux]` table: a 90 s stopping window and a 300 s starting-session bound, printed from `DEFAULT_AD_SETTINGS`); `health_check_interval` 0 in every leg but the renamed-session and restarted-tmux-server ones (ruling S3, the Q12 Hatch gap), each of which sets 10 with `session_restart_delay` 5 through the confirmed config edit and sets 0 again before it ends; `agent_director_poll_interval_ms` at its allowed maximum (`MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS`, src/config.ts); the latch re-checks waited for one `LATCH_RECHECK_INTERVAL_MS` (120 s) and 60 s more. Decision D4: the SRD's "a health check's pane read" of the renamed session is the restart path's waiting-row check after A's MCP client ends, with ticks on. Ruling S4: the bot-server restart without teardown is the trigger of the re-bound socket leg's call, the `remain-on-exit` leg's `resume` and the `pending` row's first read. Decisions D2 (the find-missing loop for the restarted-server and `remain-on-exit` legs' unlatched rows) and D3 ("no kill" means no kill sent); ruling S8: the retry's outcome is recorded, not asserted. Every text, phrase, interval, line head and round line from `fixtures/fmk-texts.ts`; calls read with `cscb_ad_calls_between` / `cscb_ad_count_between` between `ad_shim_mark` marks, tmux calls with `cscb_tmux_calls` / `cscb_tmux_count`, posts with `slack_record_mark` and `slack_label_posts`. Holds about eight minutes in the re-bound leg and runs about 22 minutes |

### Scenarios 8, 23 and 24 (Tests 20 and 26)

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
one of the two scenarios that write `[tmux]` (b.jg5 SRJ-1401; b.jg5 SRJ-1306 as amended by b.deo SRI-1402 to SRI-1404).
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
fmk scenarios and of Test 29, which runs it in shared mode; its header
comment is its full statement. A scenario script
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
  export it prints; `ENTRIES` joins the shared table with the fixed-argument
  and one-function tables (`ARGS_ENTRIES`, `FN_ENTRIES`) some scenarios'
  entries were built in, and a name in two tables fails every run. A
  scenario that needs another value adds a named entry there; there is never
  a second printer. The table below lists scenarios 8, 23 and 24's entries;
  the printer's header lists every entry.

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

The harness plays a human's acts with the helpers below (b.jg5 SRJ-1306 as amended by b.deo SRI-1402 to SRI-1404;
b.jg5 SRJ-1401). Each step is test-only and runs only in fmk mode inside the
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

| Step (SRJ-1306 as amended by b.deo SRI-1402 to SRI-1404) | Helper |
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
| Typing a line, then Enter, into a stub's pane: a message, or the exit sentinel `STUB_EXIT_SENTINEL` (scenario 7; a harness addition) | `stub_type_line` (see The stub worker) |
| Ending a stub worker, as a human quits Claude Code | `stub_type_exit` (see The stub worker) |
| Respawning a worker's pane with another process | `respawn_worker_pane` |
| Restarting the scenario's tmux server | `restart_tmux_server` |
| Re-binding its socket path while the old server runs | `rebind_tmux_socket` |
| Restoring a re-bound socket path to the recorded server, scenario 26 (harness addition) | `restore_tmux_socket` |
| Scenario 10 part B's store statement | `ad_store_mark_finished` |
| Scenario 19's `pending` row beside a leftover | `ad_store_seed_pending` |
| Scenario 25's unusable recorded name | `ad_store_unusable_name` |
| Scenarios 20 and 26's `pending` row with no launch start | `ad_store_pending_no_launch` (see The stub worker) |
| The switch-over runbook's online backup of the store (scenario 1, step 8) | `ad_store_backup` (see the store helpers under Scenario helper) |
| A human ending a leftover or a hand-made session by its session id | `end_session` |
| A worker whose process ends with no SessionEnd, scenario 26 (harness addition) | `end_worker_without_session_end` |
| A stub worker's MCP session ended from the client's side, scenario 26 (harness addition) | `end_stub_mcp_session` |
| A human's finished-row kill, agent-director-admin's `kill-finished` (scenario 10) | `ad_kill_include_finished` |
| A human's agent-director-admin `delete` of the row with the unusable name (scenario 25) | `ad_delete_unusable_row` |
| The host's `find-missing` loop | `run_find_missing_loop` |
| Re-pointing a persona's symlinked `working_directory` or `claude_config_dir` (scenario 2) | `repoint_symlink` (see The human's filesystem steps) |
| Another tmux server on its own socket, for scenario 10 part A's `TMUX` run (harness addition) | `start_second_tmux_server` |

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

#### Scenario 10's harness additions

Each is a harness addition.

- Scenario 10 writes its `[tmux]` table with `write_ad_settings` (see
  Harness agent-director calls and store helpers), each value at its
  minimum.
- `start_second_tmux_server [<session-name>]` starts another tmux server,
  with the real tmux from the scenario's own shell, on its own socket
  `$SCENARIO_ROOT/tmux-second/tmux-<uid>/default`, with one detached session
  (default `<SCENARIO_TAG>_second`). It names that socket with `-S` on every
  call, so the scenario's own server is never touched, and the trap stops it
  with every other tmux socket under `SCENARIO_ROOT`. It refuses as the tmux
  steps do, and once a second server was started, and fails unless the
  socket answers with the new server's PID. It sets `SECOND_TMUX_SOCKET` and
  `SECOND_TMUX` (`<socket>,<server pid>,<session number>`, the `TMUX` value
  that points at it) and prints `SECOND_TMUX`.
- A harness agent-director call under another tmux environment needs no
  helper: a bash prefix assignment on `ad_capture`
  (`TMUX_TMPDIR=<dir> ad_capture find-missing`,
  `TMUX="${SECOND_TMUX}" ad_capture find-missing`) holds for that one call
  only, is made from the scenario's own shell and reaches the binary behind
  the shim. The shim logs the call's arguments and parent, not its
  environment.

#### Scenario 26's harness additions

Each is a harness addition.

- `restore_tmux_socket <moved-socket>` undoes `rebind_tmux_socket`, from the
  scenario's own shell with the real tmux, refusing as the tmux steps do.
  `<moved-socket>` is the `<socket>.rebound-<n>` socket under
  `SCENARIO_ROOT/tmux` that `rebind_tmux_socket` moved the recorded server's
  socket to (`REBOUND_SOCKET`). It reads the recorded server there, with its
  sessions and panes, ends the other server at `<socket>` (`kill-server`,
  then waits until its process is gone), moves `<moved-socket>` back to
  `<socket>`, and fails unless `<socket>` then answers with the recorded
  server's PID and the same sessions, panes and pane processes, each pane
  process still running. Every tmux call names its socket with `-S`, and the
  server at `<socket>` is ended only when its PID is not the recorded
  server's, so the recorded server is never the one ended; the step fails if
  the recorded server is gone before the move. It prints the recorded
  server's PID and clears `REBOUND_SOCKET`.
- `end_worker_without_session_end <pane-id>` ends a worker's process with no
  SessionEnd, from the scenario's own shell with the real tmux, refusing as
  the tmux steps do. It reads the pane's main process (`#{pane_pid}`, the
  stub) and sends only that process SIGKILL, so it runs none of its own code
  again and fires no hook; nothing else is signalled. It fails unless
  `<pane-id>` (`%N`) is a live pane and its process is gone within 10 s
  (`SCENARIO_WORKER_END_S`). agent-director's row is not touched: it reads
  live until a `find-missing` marks it, and with `remain-on-exit` on the pane
  and its session remain. It prints `<pane id> <ended pid>`.
- `end_stub_mcp_session <pane-id>` ends a stub worker's MCP session from the
  client's side, from the scenario's own shell with the real tmux, refusing
  as the tmux steps do; it runs `require_ci_image`, then
  `require_scenario_home`, before anything else. It reads the pane's main
  process (`#{pane_pid}`) and refuses unless that process is the scenario's
  stub (`$SCENARIO_BIN/claude`); it then finds the stub's one child running
  the scenario's copy of the MCP session client
  (`$SCENARIO_BIN/stub-mcp-session.ts`) and sends exactly that child
  SIGTERM. The stub itself is never signalled. It fails unless `<pane-id>`
  (`%N`) is a live pane, the stub runs exactly one such client, the client
  is gone within 10 s (`SCENARIO_MCP_CLIENT_END_S`) and the stub still runs.
  The bot server sees the session close; agent-director's row is not
  touched. It prints `<pane id> <stub pid> <ended client pid>`.
- `SCENARIO_AD_OWNER_OPTION` and `SCENARIO_AD_PANE_OPTION` are the two tmux
  option names agent-director labels a session and its worker pane with,
  `@ad_owner` and `@ad_pane`, as the seeding helpers set them. `src/` names
  neither (SRJ-716).

#### Seeding rules

Every seeding and relabelling helper follows SRJ-1306's seeding rules
(b.jg5 SRJ-1306 as amended by b.deo SRI-1402 to SRI-1404; agent-director's handoff rev 15 and rev 17):

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
| `ad_store_pending_no_launch <id>` | 20 and 26 | `state` `pending`; `launch_started_at`, `launch_token`, `pid`, `proc_starttime`, `pane_id`, `pane_pid` and `pane_starttime` NULL; `row_version` + 1. It reads the row first and guards the UPDATE on the `row_version` it read, failing when the UPDATE changes no row (agent-director wrote the row in between); it then reads the row again and fails unless only these columns changed, each as named. A harness `status` read must then read `pending` with no launch start |

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
  `tests/host-safety.test.ts` audits that statically over every shell and
  TypeScript file there. It runs from the scenario's own shell, as
  `assert_no_cscb_delete` requires.

#### The find-missing loop

`run_find_missing_loop [<interval-s>]` plays the host's `find-missing` loop,
for a latched persona's row only (SRJ-1401): CSCB makes no extra call for a
latched persona, so the loop marks its row `missing` or clears a
`provenance_conflict` note. An unlatched persona's row is marked by CSCB's
own pending-row runs, and the harness runs no loop for it.

Decision D2: the loop also plays the
host's `find-missing` cron for scenario 26's unlatched rows, in
`test-28-fmk-provenance.sh`'s restarted-tmux-server and `remain-on-exit`
legs, because SRJ-1428 names `find-missing`, not CSCB, as what marks those
rows `missing`. Each of those legs starts the loop after its harness step,
waits until the row is marked, then stops it. The `pending`-row leg's use is
the latched one above.

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
- `stop_find_missing_loop [<timeout-s>]` stops it with SIGTERM (default
  30 s). A run in flight finishes and writes its `run <n>` line, then the
  loop leaves, so no run's line is lost and a later loop numbers its runs
  after it. `find_missing_loop_runs` prints how many runs the
  log holds, and `wait_find_missing_runs <n> [<timeout-s>]` waits for `<n>`
  more (default `<n>` intervals plus 60 s), failing early when the loop
  stops.

#### The human's filesystem steps

`repoint_symlink <link> <target>` is a harness addition. It plays a human re-pointing a persona's symlinked
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
launches through the real agent-director (Test 4, Tests 10, 12 and 29, every
fmk script). Its header comment is the full statement; this is the part every
scenario relies on (b.jg5 SRJ-1306 as amended by b.deo SRI-1402 to SRI-1404).

Modes. The stub's working directory, by its real path, selects its mode.
`stub_mode <dir> <mode>` adds the selection to `stub-claude-modes` beside the
stub in `SCENARIO_BIN` (fmk mode only; `<dir>` must be a directory under
`SCENARIO_ROOT`); the last selection of a directory wins, and a stub reads it
when it starts, so it holds from the next launch or resume there. The mode
names are `scenario.sh` constants:

| Mode | Constant | What the stub does |
|---|---|---|
| `dev-channels` | `STUB_MODE_DEV_CHANNELS` | Prints the dev-channels dialog, which CSCB's approver answers, and on the Enter clears the answered dialog (below) and reports in. A directory with no selection, and a stub with no selection file beside it (Tests 4, 10, 12 and 29), runs this mode |
| `at-once` | `STUB_MODE_AT_ONCE` | Reports in at once |
| `silent` | `STUB_MODE_SILENT` | Prints nothing and never reports in; its exit sentinel fires no SessionEnd |
| `unrecognised-dialog` | `STUB_MODE_UNRECOGNISED` | Prints a startup dialog that neither of the approver's needles matches, so CSCB never answers it, and once Enter reaches its pane clears the answered dialog (below) and reports in: the harness's `stub_press_enter <target>`, a human answering (scenarios 20 and 21) |
| `folder-trust` | `STUB_MODE_FOLDER_TRUST` | Reports in at once when its folder is trusted in `<CLAUDE_CONFIG_DIR>/.claude.json`, or in `~/.claude.json` when `CLAUDE_CONFIG_DIR` is unset or empty; otherwise prints the folder-trust prompt and, once it is answered by Enter, clears the answered dialog (below) and reports in (scenario 22) |
| `transcript-on-first-message` | `STUB_MODE_TRANSCRIPT_ON_FIRST_MESSAGE` | A harness addition. As `dev-channels` (the same dialog, reporting in on the Enter), except that reporting in writes no transcript: until the first message, every SessionStart (the report-in's and the re-fire's) names a `transcript_path` with no file at it, so agent-director's SessionStart finds none, as for a real life never messaged. The transcript is written at the first message after reporting in: the first line that is not the exit sentinel, does not start with `/` (a slash command, such as `/exit` or `/mcp reconnect`) and is not empty or blank, typed by the harness's `stub_type_line`. Once written it stays: later SessionStarts, and a resumed launch of that session, find it (scenario 7) |
| `linger-on-exit` | `STUB_MODE_LINGER_ON_EXIT` | Reports in at once. On the `/exit` line agent-director's `pause` types, it marks itself lingering, fires every SessionEnd hook (the row reads `ended`), stops its re-fire and ends its MCP session, then keeps running, its pane and session with it, as a Claude Code still shutting down does, until `stub_release` or its stdin closing. Before it has reported in, `/exit` is ignored (scenarios 24 and 13) |

An answered dialog is cleared. The line that answers a dialog first makes
the stub clear its screen and its scrollback (`ESC[H ESC[2J ESC[3J`), as
Claude Code redraws its screen once a dialog is answered, and then the stub
reports in. The scrollback is cleared too because agent-director's pane read
takes history lines (`capture-pane -p -S -<n>`): CSCB's waiting-row check
(src/session-manager.ts `checkWaitingRowPane`) reads `FULL_PANE_READ_LINES`
(src/pane-read.ts, 40) lines and would otherwise find the answered dialog's
text and read it as a prompt. Output before the answer, and a dialog left
unanswered (stdin closed, or the exit sentinel), is left as it is.
Each dialog the stub prints is also appended, byte for byte, to its record
`stub-claude-shown-dialogs.<stub pid>` beside it in `SCENARIO_BIN`
(`SCENARIO_STUB_SHOWN_DIALOGS_PREFIX`). `stub_shown_dialogs <target>` (the
pane named as for `stub_press_enter`) prints the record of the stub in that
pane, so a scenario can check which dialog its pane showed after the answer
has cleared it (test-25 checks C's folder-trust prompt this way).

`stub_press_enter <target>` sends Enter with the real tmux, from the
scenario's own shell, into a pane on the scenario's tmux server: a pane id is
used as given, and a session name is matched exactly, never as a prefix of
another session's. It fails with tmux's message when tmux refuses, and
refuses when `TMUX` is set or `TMUX_TMPDIR` is not the scenario's.

`stub_type_line <target> <line>` (a harness addition) plays a human typing `<line>` into a stub's pane and pressing
Enter: two `send-keys` of the real tmux on the scenario's own tmux server,
from the scenario's own shell, never a CSCB process, the line sent as literal
keys (`-l`), then Enter. It takes the same targets as `stub_press_enter`,
runs `require_ci_image` and then `require_scenario_home` first, fails with
tmux's message when tmux refuses, refuses when `TMUX` is set or `TMUX_TMPDIR`
is not the scenario's, and refuses an empty or blank line (Enter alone is
`stub_press_enter`) or one holding a control character. It never reads the
pane. Typed into a `transcript-on-first-message` stub, a line that does not
start with `/` writes its transcript; `STUB_EXIT_SENTINEL` (`__CSCB_TEST_EXIT__`, also a harness
addition) typed into a stub ends it, firing its SessionEnd hooks in every
mode but `silent`.

`stub_type_exit <target>` ends a stub worker as a human quits Claude Code:
one `send-keys` of the stub's exit sentinel (`STUB_EXIT_SENTINEL`,
`__CSCB_TEST_EXIT__`) and
Enter, with the real tmux, from the scenario's own shell. The target is a
pane id (`%N`) used as given, or a session id (`$N`) or session name matched
exactly. Like the other helpers it runs `require_ci_image` and
`require_scenario_home` first, and it refuses when `TMUX` is set or
`TMUX_TMPDIR` is not the scenario's. The stub then fires its SessionEnd
hooks and exits; the helper does not wait for it to end.

`stub_release <target> [<timeout-s>]` ends a stub lingering in
`linger-on-exit`: it reads the pane's process with the real tmux, from the
scenario's own shell (the pane named as for `stub_press_enter`), sends it
SIGUSR1 and fails unless it is gone within `<timeout-s>`
(`SCENARIO_STUB_RELEASE_S`, 10 s, by default). Before any signal it refuses
unless that process is a stub lingering in `linger-on-exit`, which a
lingering stub shows by its marker `stub-claude-lingering.<pid>` beside it
in `SCENARIO_BIN`; it refuses, as `stub_press_enter` does, when `TMUX` is
set or `TMUX_TMPDIR` is not the scenario's.

The dialog delay, a harness addition (b.jg5 SRJ-1306 as amended by b.deo SRI-1402 to SRI-1404), holds a launch `pending` at the dev-channels dialog long
enough for a scenario to act on it before the approver can answer (scenario
5). `stub_dialog_delay <dir> <seconds>` adds one `<seconds> TAB <real path>`
line to `stub-claude-dialog-delays` beside the stub in `SCENARIO_BIN`
(`SCENARIO_STUB_DELAYS_NAME`), by an atomic rewrite. Like `stub_mode`, it is
for fmk mode only, refuses a `<dir>` that is not a directory under
`SCENARIO_ROOT` (as written and by real path), and the last setting of a
directory wins from the next launch or resume there; it also refuses a
`<seconds>` that is not a whole number, and 0 means no delay.

- The delay acts only in `dev-channels`. For the set seconds the stub shows
  a starting screen (`Starting Claude Code...`) that holds neither approver
  needle, then clears the screen, prints the dev-channels dialog, the same
  bytes as with no delay, and waits for Enter as the mode does.
- During the delay the exit sentinel ends the stub and every other line is
  ignored.
- A setting the stub reads that is not a whole number is reported on its
  standard error and read as no delay.
- With no setting, or with no settings file beside the stub (Tests 4, 10, 12
  and 29), the stub behaves exactly as the mode table states.

A scenario whose launch loses its create reply (`slow-create`) keeps a mode
that waits for the approver's Enter, as the default does: agent-director
applies no hook to a row whose pane it has not adopted, and the approver's
`send-keys` adopts it before the stub reports in.

Hooks. To report in, the stub fires every SessionStart hook its `--settings`
registers; its exit sentinel `__CSCB_TEST_EXIT__` fires every SessionEnd hook
(in `linger-on-exit`, the `/exit` line does too).
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
  program its first registered SessionStart hook names. Under the release's
  hooks that is the real binary, so the reads bypass the
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
error where no such file exists (Tests 4, 10, 12 and 29). A reader of invocations
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
server ends it, a later `/mcp reconnect` in the pane (bare, or followed by
the server name as CSCB types it, `/mcp reconnect slack-channel-router`)
opens a new one. A session client still running then is ended first:
SIGTERM, then SIGKILL if it still runs 3 s later, and reaped. In
`linger-on-exit` the `/exit` line ends it and the lingering stub opens none. Its
lines go to `stub-mcp-session.log` beside the stub. No session is opened in
a mode that has not reported in, without `--mcp-config`, or where the client
is not beside the stub (Tests 4, 10 and 12, which copy only the stub and run
with `health_check_interval` 0).

The session's records and tool calls (b.deo SRI-1403). The client's header
is the full statement; this is the part scenarios rely on. The client keeps
three files per working directory in the directory holding the client file,
which for the copy beside the stub is the stub's directory
(`SCENARIO_STUB_DIR`, `SCENARIO_BIN` in fmk mode). The copy must be a regular
file, not a symlink: Bun runs a symlinked client from its target's
directory, and the records would land there.

| File | Written by | One line per |
|---|---|---|
| `stub-mcp-deliveries.<key>.jsonl` | the client | `notifications/claude/channel` notification received |
| `stub-mcp-requests.<key>.jsonl` | the harness (`stub_session_call`) | tool call asked for |
| `stub-mcp-results.<key>.jsonl` | the client | request answered |

- `<key>` is the lowercase hex SHA-256, all 64 characters, of the working
  directory's real path, hashed with no trailing newline:
  `printf '%s' "$(realpath -e -- "${dir}")" | sha256sum | cut -d ' ' -f 1`.
  Distinct directories get distinct records.
- A delivery line is `{"content":…,"meta":{…}}`: the notification's params
  as received, `meta` holding every attribute the server sent (`chat_id`,
  `message_id`, `user`, `user_id` or `bot_id`, `ts`, `via`, `thread_ts`,
  whichever are present), in the order received. A key absent from the
  params is absent from the line; other notifications are not recorded.
- A request line is `{"id":"<id>","tool":"<tool name>","arguments":{…}}`:
  `id` and `tool` non-empty strings, `arguments` a JSON object. Request IDs
  are unique in a scenario, which the harness keeps so; it only appends to
  the request file, each line in one write.
- A result line is `{"id":"<id>","isError":<true|false>,"text":"<text>"}`:
  the tool result's `isError` (`false` when absent) and the `text` of its
  `text` content items, joined with `\n`. A call that ends without a tool
  result (an error answer, the SDK's request timeout, a transport failure, or
  the session ending mid-call) still gets one line,
  `{"id":"<id>","isError":true,"text":"","error":"<why>"}`, so its ID is
  answered. The client never retries a request.
- Once connected, the client reads the request file every 250 ms (a missing
  file is no requests yet), and only complete lines: an incomplete last line
  is read again, whole, at a later poll. It calls each request over its
  session, whatever tool it names, in file order and one at a time: the next
  call starts only once the previous result line is written.
- The skip rule. Before it runs any request, the client reads the results
  record and takes every ID with a result line there as answered; a request
  whose ID is answered, there or by this client, is not run. So a client
  started by `/mcp reconnect` never repeats a call an earlier client made.
- The delivery and results records are only ever appended to, by every
  client of the working directory, each line in one write. The client writes
  nothing before it connects, so there is no record for a working directory
  where no session was opened. Polling ends with the session.

Besides its exit line, the client writes these lines to its log (each
prefixed `stub-mcp-session[<pid>]:`), and the session keeps running after
each:

- `could not append a line to <path>: <why>`, for a failed record write;
- `line <n> of the request file <path> is not a valid request (<why>); skipped`,
  once per such line, never its text;
- `request <id> has a result line; not run`, for a skipped request;
- `could not read the results record <path>; no request runs until it is read`,
  once, when the results record exists but cannot be read;
- `could not read the request file <path>: <why>`, when the request file
  exists but cannot be read, once until a later poll reads it;
- `the request file <path> is shorter than the part already read; reading it from its start`;
- `request poll failed: <why>`.

None of the stub's lines or calls is CSCB's: its hooks, its `status` reads
and its MCP session are children of the stub, never of a CSCB process, so
`cscb_ad_calls`, `cscb_ad_count` and the closing assertions never count them.

### Slack stub

`tests/integration/fixtures/slack-stub-server.ts` is a Bun HTTP and WebSocket
server on 127.0.0.1 that stands in for Slack, because real Slack is not
reachable in the container. Test 0, Tests 10, 12 and 29 and the fmk
scenarios start it in the background and point the server at it through the Slack API base URL override, an environment
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
  the scenario assigned to the token and a token hash, never the token. A
  `chat.postMessage` line keeps its `text` whole, with token-like text
  redacted (`slack_posts` reads them); every other method's `text` is cut at
  300 characters.
- It is self-contained: it loads only Bun and `node:` built-ins, never `src/`
  or a test helper, as the container copies `tests/` without `src/`
  (`tests/host-safety.test.ts` pins its static imports). It holds no token:
  its source has no token-like literal, and it never writes or prints a token
  value (only the token's kind and the first 12 hex digits of its SHA-256) or
  a control `suffix`.
- It has no `bun test` suite of its own; Test 10 exercises it end to end,
  Test 29 exercises its push control end to end (see below), Test 0's `slack_stub_record` leg checks the record's text cut and token
  replacement, and Test 20's whole-text checks exercise its
  `chat.postMessage` record.

The push control (b.deo SRI-1402). `POST /_push` sends one Socket Mode
`events_api` envelope, shaped as Slack's, to a persona's open WebSocket, so a
scenario can deliver an event to CSCB as Slack would. The stub's header is
the full statement; `slack_stub_push` (see Scenario helper) is how a scenario
calls it. The body is one JSON object:

```json
{"label": "alpha", "event": {"type": "message", "channel": "C…", "channel_type": "channel"}, "envelope": {"is_ext_shared_channel": true}}
```

- `label` (required, a non-empty string) is a token label of the control in
  force, matched against the label each WebSocket opened under.
- `event` (required, a JSON object) is the inner event, sent unchanged as the
  payload's `event`.
- `envelope` (optional, an object) may set only the payload's
  `is_ext_shared_channel`. Every other envelope and payload field is fixed or
  generated by the stub: `type` `events_api`, `accepts_response_payload`
  `false`, `retry_attempt` 0, `retry_reason` empty, payload `type`
  `event_callback`, the stub's own `team_id` and `api_app_id`, `event_time`
  the push's time in seconds, and an `envelope_id` and `event_id` unique per
  push.
- The flag has four cases. No `envelope`, or `{}`, sends it as `false`.
  `{"is_ext_shared_channel": <value>}` sends the value as given: `true`,
  `false`, or any non-boolean JSON value (`null`, a string, a number, an
  object). `{"omit": ["is_ext_shared_channel"]}` leaves it out of the payload.
- The envelope goes to the label's newest open WebSocket: the one opened last
  among its sockets open now. A closed or closing socket is never chosen.
- A push carries no token, and `/_push` reads none.

The answers. A refused push sends nothing.

| Status | Body | When |
|---|---|---|
| 200 | `{"ok":true,"envelope_id":"<uuid>","event_id":"Ev…"}` | sent |
| 400 | `{"ok":false,"error":"<reason>"}` | malformed: `not-json`, `not-an-object`, `unknown-field` (a top-level key other than `label`, `event` and `envelope`), `no-label`, `event-not-object`, `envelope-not-object`, `envelope-field-fixed` (an envelope key other than `is_ext_shared_channel` and `omit`), `omit-invalid` (`omit` not a non-empty list naming only `is_ext_shared_channel`, or given beside it) |
| 409 | `{"ok":false,"error":"no-open-socket"}` | the label has no open WebSocket |
| 503 | `{"ok":false,"error":"send-failed"}` | the socket did not accept the send |

Any other method on `/_push` answers 404, as an unknown path does.

The record gains two line kinds:

- `{"event":"push","label","envelope_id","event_type","channel","channel_type","flag","flag_value"}`,
  once per sent push, written right after the send and so before CSCB's
  ack. `event_type`, `channel`
  and `channel_type` are the event's `type`, `channel` and `channel_type`
  (null when not a string). `flag` is `false`, `true`, `non-boolean` or
  `absent`, and `flag_value` the JSON text of the flag as sent (`"true"`,
  `"\"yes\""`, `"null"`, …), null when the flag is left out. The line
  carries no `event_id`. CSCB's ack is not a `push` line: it is the existing
  `ws-message` line carrying the push's `envelope_id`.
- `{"event":"push-refused","label","reason"}`, once per refused push, its
  `reason` the answer's `error` and its `label` null when the push named
  none.

Neither line carries the event's text. Every value either copies from a push
has token-like text replaced by `<token>` and is cut to at most 100
characters.

A live start also launches each persona through the real agent-director
under the stub `claude` (see The stub worker), and stops with `--stop-bots`.
Tests 10 and 12 put `fixtures/stub-claude.sh` first on `PATH` as `claude`
themselves, as Test 4 does, with no session client beside it. Test 29 does
the same with a regular-file copy of `fixtures/stub-mcp-session.ts` beside
the stub (`SCENARIO_STUB_DIR`, under `SCENARIO_ROOT`), so each persona's stub
opens an MCP session. An fmk script's start finds the copy `scenario.sh` put
first on its PATH, with the stub's MCP session client beside it.

Test 29 starts the stub with `--record` and `--control`, as Tests 10 and 12
do, and is the scenario that exercises the push control, the session's
delivery record and its tool calls end to end: `slack_stub_push` sends each
event, `stub_session_deliveries` shows what reached the persona, and
`stub_session_call` calls `set_channel_delivery`.

### Verdict file format

`tests/runner.sh` writes exactly one line to `/test-results/verdict.txt`:

- `PASS` — every test exited 0.
- `FAIL: <test-script>: <description>` — first failed test's first `FAIL:` line.

`/ci` reads only the first line of this file. It is not JSON, has no
decoration, and never contains embedded newlines. Multi-line diagnostics go to
stdout/stderr where `docker logs` can capture them — never into `verdict.txt`.

### Adding a new test

A script that follows the naming rule (see
[Script names, prerequisites and canonical order](#script-names-prerequisites-and-canonical-order))
runs with no other edit: `/ci` finds it in every run, and it runs in whichever
shard the assignment gives its scheduling unit. Make no runner edit: leave
`tests/runner.sh`, `scripts/ci-run.ts`, `docker/entrypoint.sh` and the `/ci`
skill as they are.

There are exactly two optional steps, 4 and 5 below: a prerequisite line and a
duration-table entry.

1. Write the testplan ticket in `testplans/` (the source of truth — describes
   what is being tested and why, in human prose).
   A self-describing scenario with no ticket (as Test 0 and Tests 5 onwards) skips this
   step: its header comment lists what it checks, and its expected log
   fragments are taken from `src/` in the header or a constants block.
2. Add `tests/integration/test-N-<short-name>.sh`, with `N` the next unused
   number, with no leading zero. Required shape:
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
   `test-*.sh` through `bash`, so the mode bit is not what makes it run.
4. Optional: when the script depends on state another script leaves, add a
   `# ci-requires:` line to its header comment block, the `#` lines right
   after the shebang. Its form, place and refusals are in
   [Script names, prerequisites and canonical order](#script-names-prerequisites-and-canonical-order).
5. Optional: add the script's duration-table entry. A script with no entry
   still runs, with the default estimate of 2400 s; add its entry from the
   block a later run prints (see [The duration table](#the-duration-table)).
6. Name the script in the Layout above, in the same change, by its whole file
   name with a one-line comment on what it checks. `tests/shipped-docs.test.ts`
   (b.jg5 SRJ-1112) fails while any `tests/integration/test-*.sh` on disk is
   not named in this README. When a script is removed, record it here by its
   test number and what replaces it, never by its file name: the same check
   fails on a `test-<n>-<name>.sh` this README names that is not on disk (the
   `test-N-<short-name>.sh` template above names no script). Delete its line
   from `tests/ci-durations.tsv` in the same change: the unit suite fails while
   the table lists a script not on disk.
7. Run `shellcheck tests/integration/*.sh tests/integration/lib/*.sh tests/runner.sh`
   from the repo root. `tests/integration/.shellcheckrc` lets shellcheck follow
   the helper without `-x`. The suite must stay warning-free.

### The duration table

`tests/ci-durations.tsv` holds each script's expected wall time in seconds.
The runner uses it to balance the run's scheduling units across shards and to
set each shard's wall-time limit. Scheduling reads the copy in the run's pinned
test image.

Every shard starts with test-1's estimate, since test-1 runs first in each,
and a unit's estimate is the sum of its scripts' estimates. Units are placed
longest first, each into the shard with the smallest expected total so far.
Ties between units go by the canonical order of each unit's first script and
ties between shards to the lowest shard number, so one table, one set of
scripts and one N always give one assignment.

A shard's limit is 2 × its expected total + 15 min, and at least 30 min,
counted from its container's start.
`--shard-timeout <minutes>` sets every shard's limit to its value instead,
with no floor.

#### Format

The first line is the header `script<TAB>seconds`. Every other line is
`test-<n><TAB><seconds>`: a script's number form, one tab, then a whole number
above 0 and at most 9007199254740991, keyed by number form so renaming a
script's slug keeps its entry. The lines follow canonical order (see
[Script names, prerequisites and canonical order](#script-names-prerequisites-and-canonical-order)).

Lines are split at LF, and the final LF is optional. A line holding a CR
matches no form. The file's first lines (the gaps are tabs):

```text
script	seconds
test-1	23
test-2	1
test-3	21
```

#### Defaults and notes

No table content ever skips a script. A bad line is ignored and noted, a
script with no entry gets the default estimate, and an unreadable table gives
every script the default. Every note begins
`duration table tests/ci-durations.tsv`, and a note about one line gives its
line number.

| Case | Effect |
|---|---|
| The table is missing or cannot be read, or its first line is not exactly the header (an empty file included) | Every script gets the default estimate, 2400 s, with one note |
| A malformed line: empty, holding a CR, with no tab, with no number form before the first tab, or with seconds that are not a whole number above 0 or are above the bound | Ignored and noted |
| A line for a script an earlier well-formed line already lists | Ignored and noted; the first is used |
| A line for a script not in the test image's script list, such as a removed script | Ignored and noted, and left out of the block |
| A line whose script sorts before the script of an earlier used line | Used and noted |
| A script with no entry | The default estimate, 2400 s, with no note |

#### Refreshing the table

Every run that got the pinned test image's script list holds the duration-table
block in its `summary.txt` and its timing summary. The `/ci` report prints the
timing summary after a full or selective PASS. A run that never got that list
has no block, no `slow:` lines and no table notes.

The block follows one introducing line, where `<k>` is the number of block
lines:

```text
duration table block, the next <k> lines: paste them as tests/ci-durations.tsv to refresh the table
```

The block is the header, then at most one line per script in the pinned list,
in canonical order:

- A script that passed gets this run's time, rounded up to whole seconds and
  at least 1. test-1 runs in every shard, so it gets its highest time, and
  only when it passed in every shard.
- Every other script keeps the entry the run read from the table and used, or
  has no line when there is none. An ignored line's entry is not carried, nor
  is any entry of an unreadable table.
- An entry for a script not in the list is left out.

A selective run's block is therefore safe to paste: the scripts it did not run
keep their entries.

To refresh, paste the block's lines (not the introducing line) over the whole
of `tests/ci-durations.tsv` and commit it as an ordinary change; the runner
never writes the table. `tests/ci-run-schedule.test.ts` checks that the
committed file parses with no note, so a paste that lost its tabs fails the
unit suite; it does not check the seconds.

A `slow: <file> took <s> s, estimate <e> s` line names a script whose time was
more than 1.5 × its estimate (the default for a script with no entry), its
time rounded up to whole seconds. test-1 is judged once, with its highest
time. A `slow:` line does not fail the run; only reaching the shard's limit
does. It means the table is stale: the balance across shards gets worse and
the limits get tighter, so refresh it.

### What does NOT belong in a test script

- Anything requiring LLM judgment ("did this response look reasonable").
- Pane scraping, tmux capture, JSONL transcript parsing. Whose call a shim
  log line records is read from its parent process (the closing assertions,
  `cscb_ad_calls`, `cscb_ad_count`), never from a pane. The harness's tmux
  steps (see Harness-only steps) play the human; they are never assertions
  made by reading a pane's text.
- Retries, fix-it-yourself logic, or self-healing. A test is a strict assertion.

### Fault injection

A fault makes a run fail on purpose, to prove that the runner catches the
failure. The fault controller is in `scripts/ci-run.ts`, section 16 (Faults).
Faults are written here in their normalized form: a script is given by its
number form (`test-23`), and k and j are shard numbers.

**Activation.** Faults come only from `/ci --inject <fault>` arguments. No
environment variable or file turns one on. `/ci` with no arguments is the gate
run and never injects, so `/publish` and `/publish-prepare` never see an
injected result.

Each shard is given, as `--fail <file name>` arguments to `tests/runner.sh`,
only the `fail:` faults it acts on. No other fault reaches a shard. An injected
run's verdict carries the `INJECTED (<faults>): …` wrapper, and the verdict
reader exits 4 for it; see Verdict file format for the wrapper.

Which faults are refused, as bad arguments or as not runnable, is part of
`/ci`'s argument checks; this subsection covers only faults that were accepted.

**Each fault.** A fault is due until it fires. Its target shard and its
firing moment are:

| Fault | Target shard | Fires when |
|---|---|---|
| `fail:<script>` | The shard the assignment gives the script; shard 1 for test-1 | That shard reaches the script. The script is not run: it is recorded failed with `FAIL: <file name>: injected failure`, its result-file lines being `start <file name>` and `end <file name> fail 0.000`. |
| `leak:<k>,<j>` | j | Shard j starts with shard k's subdirectory mounted read-only at `/leak-shard-<k>`. |
| `image-drift:<k>` | k | Shard k starts from the drift image: the pinned image plus a label, so another ID with the same content. Shard k then runs normally, so only the `image-drift` integrity check should fail. |
| `retag` | None | The run's `-test` tag moves to the retag image, once every shard's start has been attempted. No other tag changes. |
| `timeout:<script>` | The shard the assignment gives the script; shard 1 for test-1 | The runner first sees the script in progress. It stops that shard as at its limit, with `FAIL: <file name>: wall-time limit of <m> min exceeded in shard-<k>`, m being the elapsed time since the shard's container started, rounded up to whole minutes (at least 1). |
| `kill:<k>` | k | The runner first sees any script in progress in shard k, test-1 included. It takes that shard's final reading, then stops its container with SIGKILL, and the script fails with the cause `killed`. |

A script is in progress when the shard's result file has its complete `start`
line, no `end` line for it and no end marker. When a `timeout:` and a `kill:`
on one shard are first seen at the same reading, the `kill:` fires, whatever
the order of the `--inject` arguments.

**Polling.** While a `timeout:` or `kill:` aimed at a started shard is still
due, the runner reads that shard's result file every 1 s
(`FAULT_POLL_INTERVAL_MS`). That is how even test-1, about 21 s long, is seen
in progress. The runner never polls for faults otherwise: not in a run without
them, and not once the shard has ended or the fault has fired.

**A fault that never fires.** Every fault must fire. One that does not fails
the run with this line, from `fault-fired`, the first integrity check:

```text
FAIL: integrity: fault-fired: <fault> did not fire (<why>)
```

`<why>` is one of nine reasons. In them, k is the shard the fault acts on (j
for `leak:<k>,<j>`):

| Reason | When it applies |
|---|---|
| `drift image build failed (exit <code>)` | `image-drift:<k>`: the drift image's build failed, so shard k started from the pinned image. |
| `retag image build failed (exit <code>)` | `retag`: the retag image's build failed, so no tag moved. |
| `tag move failed (exit <code>)` | `retag`: the `-test` tag's move failed. |
| `shard-<k> never started` | The shard's start was attempted and its container did not start. |
| `shard-<k> started without it` | `leak:` or `image-drift:`: the shard started without the mount or the drift image, with no build having failed. |
| `shard-<k> ended first` | The shard ended before the fault's moment came: for example, a `kill:` whose shard ended before any script was seen in progress, or a `fail:` whose script the shard never reached. |
| `shard-<k> reached its wall-time limit first` | The shard reached its wall-time limit before the fault's moment. |
| `the run was stopped first` | A run-level stop came first, or the run stopped before the shard's start or the tag move was attempted. |
| `<fault> stopped shard-<k> first` | Another fault stopped the shard first, named in its normalized form: a `timeout:` or `kill:` that fired there, or a `fail:` whose injected failure ended the shard before this fault's moment. |

For example, `kill:2` with `timeout:test-23`, test-23 being in shard 2, kills
shard 2 while test-1 runs. `timeout:test-23` does not fire, and its line ends
`(kill:2 stopped shard-2 first)`.

`fault-fired` is skipped on an image build failure, and on a run-level stop
that comes before the end-of-run sequence starts. The summary names it as
skipped. A stop during that sequence skips no check.

**Where to look.** The unit cases for each fault, the tie rule, the polls and
every reason are in the E12 region of `tests/ci-run-results.test.ts`. The live
proof is the final gate's injected `/ci --inject` runs on the development host.

### Escape hatch: tests that genuinely need LLM judgment

If a future test cannot be expressed as a deterministic bash assertion (e.g.
"did the bot's reply on Slack actually answer the question"), do NOT
reintroduce an in-container orchestrator Claude. The container stays a
deterministic bash harness.

Until a runner change gives it an owned place, a test must not write its
artifact (a transcript, a generated file) under `/test-results/`. That path is
the shard's own subdirectory of the run directory, and the artifact is not one
of the files `results-ownership` allows there, so the run fails with a
`FAIL: integrity: results-ownership: …` line.

Do not add a judgment step to `.claude/skills/ci/SKILL.md` either. The `/ci`
skill holds no logic.

Such a test first needs a runner change in `scripts/ci-run.ts`. That change
gives the artifact an owned place in the shard subdirectory, so
`results-ownership` accepts it. The same change runs the judgment step in the
host runner, once, with no tmux, no orchestrator session and no permission
prompts. The judgment step never goes in the skill.

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
