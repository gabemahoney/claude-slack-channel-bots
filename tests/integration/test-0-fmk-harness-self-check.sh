#!/usr/bin/env bash
# Test 0 (b.jg5 SRJ-1306, SRJ-1401, SRJ-1418): the fmk harness's self-check.
# It runs the parts of lib/scenario.sh, fixtures/agent-director-shim.sh and
# fixtures/tmux-shim.sh that every fmk scenario (test-13 to test-28) stands
# on, and checks their effect. tests/runner.sh
# finds it by name and, in version order, runs it right after Tests 1 to 4
# and before every fmk scenario. Its TEST_NAME carries `-fmk-`, so sourcing
# lib/scenario.sh gives it its own HOME, agent-director install (the release
# candidate, through its install.sh, behind the shim), store and tmux server,
# all under SCENARIO_ROOT.
#
# The release candidate's version and commit come from the image's recorded
# release identity (/opt/agent-director-rc/client/release.json), never from a
# literal. The shim log is read as the shim's header states its line format:
# only lines whose first field is `call` are invocations, and a quoted field
# gives back its words through `eval`.
#
# Legs (each a function `leg_<name>`, run in the order LEGS lists them; a
# failing leg prints one FAIL line naming the leg and what it saw):
#   isolation        HOME and TMUX_TMPDIR are under SCENARIO_ROOT and are not
#                    the container user's; TMUX and TMUX_PANE are unset; every
#                    PATH entry is absolute, the scenario's bin directory is
#                    first, no entry holds an `agent-director` (the image's
#                    default binary's directory is gone) and the shell finds
#                    none; `claude` is the stub; bun is still found; the shim
#                    and its log are at the scenario HOME's standard path, and
#                    the container user's own ~/.agent-director/bin holds no
#                    shim log and no `.real` binary.
#   real_binary      the binary behind the shim, run by its own name, reports
#                    the recorded version and commit, and adds no log line.
#   setup_install    after the setup's install the standard path holds the
#                    shim (a regular file, the fixture byte for byte, with its
#                    marker), the release candidate's binary is behind it, a
#                    call through it reports the recorded version, and the
#                    install made the HOME's store.
#   harness_call_log a harness call (`ad_capture`, an argument holding a
#                    space) adds one `call` line: its time is the call's, its
#                    parent is the scenario's own shell ($$) with that shell's
#                    command line, and its words give back the argv exactly.
#   version_probe    bun runs under the scenario HOME: the installed package's
#                    agent-director client resolves the shim at the standard
#                    path, and its version probe (cwd /, scrubbed environment)
#                    gets the recorded version and is logged, its parent bun.
#   tmux_and_store   a harness spawn (the stub as `claude`) runs on the
#                    scenario's own tmux server: the row's socket is under
#                    TMUX_TMPDIR, the scenario shell's tmux reaches the session
#                    on that socket, and the server's environment carries this
#                    SCENARIO_ROOT. `ad_store_id` prints 16 lowercase hex
#                    characters, and an `ad_store_edit` of the spawned row's
#                    labels is what a later harness `get` returns.
#   swap             after a swap to 0.10.0 the shim is in place with 0.10.0
#                    behind it and a call through it reports 0.10.0; after the
#                    swap back, the release candidate again.
#   reinstall        after a second run of the release candidate's install.sh
#                    and its re-shim, the shim is in place with the release
#                    candidate behind it, and the store id is unchanged.
#   hide_restore     hide leaves no file at the standard path and none behind
#                    it, and keeps the log; restore puts the shim back with the
#                    release candidate behind it.
#   log_kept         the harness call's line is still in the log after every
#                    install, swap, hide and restore, and every line of the log
#                    has the format's six fields and a known kind.
#   start_on_010     a nested fmk run written into SCENARIO_ROOT, set to start
#                    on 0.10.0 (SCENARIO_AD_START=0.10.0), holds 0.10.0 behind
#                    the shim, no release-candidate binary anywhere in its HOME
#                    and no store; `install_ad_rc` then puts the release
#                    candidate behind the shim and makes a store with a store
#                    id. The nested run prints a `CHECK:` marker for each of
#                    these checks and then exits 0 without the closing
#                    assertions (it starts no bot server, so it could not meet
#                    their positive controls): the trap fails it with the
#                    closing enforcement's line and no other FAIL line. The
#                    nested run cleans up its own SCENARIO_ROOT.
#   store_rows       two harness spawns (the stub at once) that the store and
#                    operator legs use once their sessions are old enough:
#                    both report in (`waiting`); `ad_new_token` prints 16
#                    lowercase hex characters other than the row's launch
#                    token and a given token; `ad_store_mark_finished` refuses
#                    while the session is younger than the stopping window
#                    and leaves the row as it was.
#   guard_refusals   in subshells, with HOME outside SCENARIO_ROOT (a scratch
#                    directory under /tmp holding a decoy install and store,
#                    and a symlink under SCENARIO_ROOT that resolves to it),
#                    every install, re-shim, swap, hide and restore helper,
#                    `ad`, `ad_store_edit`, `ad_store_id`,
#                    `ad_store_pending_no_launch`, `stub_mode`,
#                    `stub_press_enter`, `write_mcp_config` and every label,
#                    seeding, tmux-step, store-statement, operator-action,
#                    find-missing-loop and 0.10.0-seeder helper fails with the
#                    guard's reason, and the decoy is left exactly as it was.
#   shim_check       `check_ad_shim` passes a correct layout and fails, with
#                    its reason, on a symlink to the shim and on a copy of the
#                    shim without its marker line.
#
# The tmux shim's legs call it by its path from the scenario's own shell,
# whose PATH never holds it, or run a harness agent-director spawn with the
# shim's bin directory put first on that one call's PATH. Its delays are kept
# short through `tmux_shim_mode`'s delay, each still longer than the
# agent-director timeout the leg relies on: its create timeout
# (create_timeout_ms, 5000 at its defaults, the longest of its tmux call
# timeouts).
#   tmux_shim_log    in `log` mode a call runs the real tmux (its session
#                    exists, its -P output and an -e value holding a space
#                    reach the caller and the session), and adds one `call`
#                    line: its time is the call's, its pid is not the shell's,
#                    its parent is the scenario's shell ($$) with that shell's
#                    command line, and its words give back the argv exactly.
#                    `tmux_shim_mode` writes `<mode> <delay>` to the mode file
#                    and refuses an unknown mode, a delay for a mode that
#                    takes none and a delay that is not a number.
#   fail_kill        `kill-session`, `kill-pane`, the alias `killp`, the
#                    prefix `kill-ses`, a kill after a global option and a
#                    chained call holding one each exit 1 with one `tmux-shim:`
#                    line on standard error, run nothing (the chained call's
#                    other command prints nothing) and leave the session; other
#                    commands run. After a change to `log`, the next call
#                    kills the session.
#   fail_create      at the shim: `new-session`, its alias `new` and a call
#                    with no command (tmux's default new-session) each exit 1
#                    with no standard output and one `tmux-shim:` line on
#                    standard error, and leave no session; other commands
#                    run. A real agent-director spawn with the shim first on
#                    its PATH reaches the shim (a new-session line whose parent
#                    is that agent-director process), answers
#                    ErrTmuxSessionCreate, makes no session and leaves its row
#                    pending.
#   slow_create      a real spawn's session carries @ad_owner (naming the
#                    spawn's instance) and @ad_pane before the shim's delay
#                    ends (read before its new-session line's time plus the
#                    delay); the spawn answers ErrTmuxUnresponsive with its
#                    session present and its row pending.
#   wedge            a call's line is logged (its pid the call's) while the
#                    call still sleeps; the call then exits 1 no sooner than
#                    the delay (longer than the create timeout), with one
#                    `tmux-shim:` line on standard error, no standard output
#                    and no session made: it ran no tmux.
#   mode_spawns_not_cscb
#                    the tmux log holds lines whose parent is an
#                    agent-director process (the mode legs' harness spawns),
#                    yet `assert_no_server_tmux` fails its positive control:
#                    an agent-director process the harness ran is not one a
#                    CSCB process ran.
#   path_wiring      a command run through `cscb_run` has the tmux shim's bin
#                    directory first on its PATH, then the scenario's PATH; it
#                    is recorded with role `run`, its words, and a `gone`
#                    entry once it ended; `cscb_run` returns its status. The
#                    scenario's shell has no shim on PATH and finds the real
#                    tmux.
#   live_start       (the E17 hatch note) a live one-persona start against the
#                    Slack stub, with the stub as `claude` held at the
#                    dev-channels dialog: the start pass brings it up, the
#                    bot server (recorded with role `server`) has the shim
#                    first on its PATH, its dialog approver sends the keys
#                    through agent-director (a `send-keys` call whose parent
#                    is the bot server) and the row reports in (`waiting`).
#                    No tmux line has the bot server as its parent. The three
#                    closing assertions pass over this start's own lines (the
#                    lines it added, the whole record), and over the lines
#                    from before it both positive controls fail, so both are
#                    met by this start's own lines. `cscb_ad_calls` prints no
#                    harness call. The start is stopped with --stop-bots.
#   mcp_session      a live one-persona start in a state directory of its own,
#                    with health ticks every MCP_TICK_S: once the stub (held
#                    at the dev-channels dialog until the approver's Enter)
#                    reports in, the server registers its MCP session as the
#                    persona's (`Session connected`); the session client is a
#                    child of the stub. Over at least MCP_TICKS more health
#                    ticks (the bot server's `status` reads of the row) the
#                    server logs no reconnect, relaunch, restart or
#                    not-connected line, no CSCB process runs send-keys,
#                    spawn, resume or kill for the row, the row reads
#                    `waiting` and /interject answers 200. After the sentinel
#                    ends the stub, the server logs the session's end, the
#                    client is gone and /interject answers 503: the persona
#                    reads not connected. The start is stopped with
#                    --stop-bots.
#   harness_include_finished
#                    a harness `kill --include-finished` from the scenario's
#                    shell, from a command substitution and from a pipeline
#                    each add a line whose parent has the shell's command
#                    line (the shell itself, then subshells of it), and
#                    `assert_no_cscb_include_finished` passes.
#   stub_direct      the stub run from the scenario's shell, its hooks each
#                    touching a marker file: `claude --version` prints
#                    `2.1.280 (Claude Code)`; in a directory with no selection
#                    it prints the dev-channels dialog, byte for byte
#                    tests/fixtures/dev-channels-pane-2.1.120.txt; `silent`
#                    prints nothing, fires no hook, and on the sentinel fires
#                    no SessionEnd; `at-once` with no
#                    AGENT_DIRECTOR_INSTANCE_ID prints its banner, fires
#                    SessionStart, writes one stop line (reason
#                    `AGENT_DIRECTOR_INSTANCE_ID is unset or empty`, id `-`)
#                    to standard error, as no shim log is beside its hooks'
#                    binary, and on the sentinel fires SessionEnd.
#   stub_helpers     `stub_mode` refuses an unknown mode, a directory outside
#                    SCENARIO_ROOT (as written and by real path) and a path
#                    that is no directory, and a directory's last selection
#                    wins (the stub then runs it); `stub_press_enter` fails
#                    with tmux's answer for no such pane and for a prefix of a
#                    session's name (which gets no Enter), delivers Enter by
#                    the full session name and by pane id, and refuses with
#                    TMUX set or another TMUX_TMPDIR; `ad_store_pending_no_launch`
#                    refuses an id with other characters and an id with no
#                    row; `write_mcp_config` refuses a value that is not a
#                    port, and the setup's MCP config names the server
#                    `slack-channel-router` at the scenario's port over http.
#
# The re-fire legs read SessionStart records in the scenario HOME's
# ~/.agent-director/ad-trail.jsonl: `ad.hook.fired` (by instance id) and
# `ad.hook.ignored` (by instance id, and by the hook's parent PID, which is the
# stub's own process). G is agent-director's default pending grace period
# (REFIRE_GRACE_S): the self-check writes no config.toml before the
# store_statements leg, which runs after them.
#   refire_hold      a harness spawn of row REFIRE_ID, its working directory
#                    selected for the silent mode: the row reads `pending` with
#                    a launch start; its worker's --settings hooks are exec
#                    form and name the binary beside the shim's log; for longer
#                    than a re-fire period the worker's pane shows nothing and
#                    the trail holds no SessionStart record for the row.
#   refire_at_once, refire_trusted_config_dir, refire_trusted_home,
#   refire_dev_channels, refire_unrecognised, refire_folder_trust
#                    one reporting stub per path, each the process of its own
#                    tmux pane on the scenario's server, given the held row's
#                    AGENT_DIRECTOR_INSTANCE_ID and its worker's --settings,
#                    and a working directory selected for the path's mode:
#                    `at-once`; `folder-trust` in a folder trusted in
#                    <CLAUDE_CONFIG_DIR>/.claude.json, and in one trusted in
#                    ~/.claude.json with no CLAUDE_CONFIG_DIR (both report in
#                    with no dialog); and the dev-channels dialog, the
#                    unrecognised dialog (which holds neither approver
#                    needle) and the folder-trust prompt, each shown in its
#                    pane and answered by `stub_press_enter`: before the Enter,
#                    for longer than a period, the stub fires no SessionStart
#                    and shows no banner.
#   stop_status_failure
#                    a reporting stub given an instance id with no row: its
#                    report-in fires SessionStart once, then nothing, and the
#                    shim's log holds exactly one stop line naming the id,
#                    written by the stub, reason `the status read exited <n>`.
#   stop_no_launch_start
#                    a second row held the same way, and a reporting stub for
#                    it: once it has re-fired, `ad_store_pending_no_launch`
#                    leaves the row `pending` with no launch start; then
#                    exactly one stop line names the id, written by the stub,
#                    reason `the row reads pending with no launch start`, and
#                    no SessionStart record from the stub comes after it.
#   refire_grace     after G (plus REFIRE_SETTLE_S): each path's stub's
#                    records start at its report-in (within REFIRE_FIRST_S of
#                    its start or its Enter), come about every REFIRE_PERIOD_S
#                    (each gap within REFIRE_GAP_MIN_S..REFIRE_GAP_MAX_S),
#                    run until G (the last within REFIRE_GAP_MAX_S of it) and
#                    none after (REFIRE_HOOK_S allowed for a hook's own run),
#                    with none added over REFIRE_QUIET_S more; each is
#                    ignored as `pid_mismatch` against the silent worker's
#                    pane, and the stub still runs. The silent worker fired
#                    nothing (every SessionStart fired for the row was
#                    ignored); the row still reads `pending` with its launch
#                    start; no stop line names it (the stop past G is
#                    silent).
#   stub_lines_not_cscb
#                    the shim log's lines since the hold are the two stop
#                    lines and the harness's own calls (their parent the
#                    scenario's shell), all in its format; over them
#                    `cscb_ad_count` counts nothing and `cscb_ad_calls`
#                    prints nothing, and CSCB's whole count is unchanged; the
#                    three closing assertions pass over a copy of the whole
#                    record, stop lines included.
#   synthetic_server_tmux, synthetic_include_finished, synthetic_delete
#                    in subshells pointed at synthetic logs and records under
#                    SCENARIO_ROOT: each assertion passes a clean log and
#                    fails, naming itself and the reason, on each violating
#                    log (and each positive control on a log that lacks it);
#                    a line whose parent PID a recorded process held only
#                    outside that line's time never counts, nor a stop line;
#                    a line not in the shims' format fails.
#   count_helpers    on a synthetic log, `cscb_ad_count` and `cscb_ad_calls`
#                    count only the calls a CSCB process made in its window:
#                    never a harness call or a stop line; the verb is read past
#                    agent-director's global flags and fragments match in
#                    order.
#   closing_enforcement
#                    nested fmk runs written into SCENARIO_ROOT, each with a
#                    stand-in bot server (a process of the run, recorded as a
#                    bot server, whose agent-director and tmux lines it writes
#                    into its own logs): one that ends with the three closing
#                    assertions passes; one that writes a violating line after
#                    them fails with `after the closing assertions:` and the
#                    assertion's reason; one whose assertions ran over copies
#                    of its logs or in a subshell fails naming exactly those
#                    as not passed; one that fails on its own prints only its
#                    own FAIL line.
#
# The harness-only steps (b.jg5 SRJ-1306, SRJ-1401). Each helper runs once
# from the scenario's own shell, and each leg reads the effect back itself,
# with the real tmux on the scenario's server, the store (through
# `ad_store_edit`) or a harness `get`.
#   seeding          each seed_* helper once (worker `sleep`): the session's
#                    name, id, pane and working directory are as printed;
#                    every label holds its five fields (`ad1`, a 16-hex token,
#                    the session's own id, the instance id, a store id) and
#                    ends with the scenario store's id, or with another
#                    16-hex id for `seed_other_store`; every labelled session's
#                    pane carries @ad_pane `<that token> <its pane id>`; the
#                    unlabelled and env-only sessions carry neither, and the
#                    env-only worker's environment holds its instance id. A
#                    taken name and a name holding `.` are refused, and the
#                    refused name makes no session.
#   tmux_steps       `relabel_session` gives the leftover a new token in both
#                    labels and refuses the label's own token, an unlabelled
#                    session and another store's; `attach_viewer` makes a
#                    session in the leftover's group showing its windows;
#                    `rename_session`, `set_remain_on_exit`, the global
#                    @ad_owner set (five fields, `$0`, the store's id) and unset
#                    (no value in any of the three scopes), `respawn_worker_pane`
#                    (same pane, a new process, the old one gone) and
#                    `end_session` each read back from the server; a step
#                    with TMUX set is refused.
#   store_statements writes the scenario HOME's agent-director config.toml
#                    (the starting-session bound and the stopping window at
#                    their safe minimums; the re-fire legs are done by now);
#                    once the finished row's session is older than that
#                    window, `ad_store_mark_finished` writes exactly the
#                    state, ended_at (the file's window ago), no launch start
#                    and the next row_version, every other column kept;
#                    `ad_delete_unusable_row` and `ad_store_unusable_name`
#                    refuse the live row, unchanged; `ad_store_unusable_name`
#                    changes only the finished row's session name.
#   operator_actions once the other row's session is past the starting-session
#                    bound: `ad_store_mark_finished` marks it `ended`, every
#                    other column kept, its session still running; then
#                    `ad_kill_include_finished` gets kill_sent from a call
#                    whose parent is the scenario's shell, the session ends,
#                    and `assert_no_cscb_include_finished` still passes;
#                    `ad_store_seed_pending` then makes that row `pending`
#                    with a launch start and a fresh token (not the leftover's),
#                    its pane and server identity NULL, every other column
#                    kept, and a harness `status` reads it so;
#                    `ad_delete_unusable_row` removes the finished row whose
#                    name the statement made unusable, from the scenario's
#                    shell, and `assert_no_cscb_delete` still passes.
#   find_missing_loop
#                    `run_find_missing_loop` at a short interval refuses a
#                    second loop, runs `find-missing` twice (each run logged
#                    with exit 0, the next starting no sooner than the
#                    interval after it), its calls' parent the loop subshell
#                    with the shell's command line and none counted as
#                    CSCB's; once stopped, the loop is gone and
#                    `wait_find_missing_runs` refuses.
#   fmk_driver_reuse_spawn, fmk_driver_read_pane, fmk_driver_resume
#                    fixtures/fmk-driver.ts, run through `cscb_run` once per
#                    forced call against a self-check persona: it exits 0
#                    with exactly one outcome line, `DRIVER: FORCED <call>`
#                    and its fields; every agent-director call in the shim's
#                    log during the run has the driver (bun) as its parent,
#                    and CSCB's count rises by exactly those; the forced
#                    call's verb is among them; no delete.
#   seeders_010      a nested fmk run started on 0.10.0: `seed_prepersona_fleet`
#                    refuses a routed channel with no name before any row or
#                    store exists; `seed_010_row` and `seed_prepersona_fleet`
#                    make rows named and labelled as the pre-persona package
#                    names them, live, in their routes' directories; after
#                    `install_ad_rc` (the release candidate's install.sh, then
#                    the re-shim) the shim check passes, the store has a store
#                    id, every row is still present with its name and labels
#                    and its worker still runs; then each seeder refuses for
#                    each of its three reasons. The nested run ends with the
#                    closing assertions over a stand-in bot server and passes.
#   tmux_server_steps
#                    last, as it ends every session: `restart_tmux_server`
#                    leaves a new server with only its one session and the
#                    old server gone; `rebind_tmux_socket` leaves the old
#                    server answering on the moved socket and a new one on
#                    the socket path. The exit hook confirms the trap stopped
#                    both.
# The script then ends with the three closing assertions in its own shell,
# met by the live start's own lines, with the stub's stop lines in the shim's
# log.
# Teardown: an exit hook confirms that the trap stopped the scenario's tmux
# server (its PID gone, no socket under SCENARIO_ROOT answering).
set -euo pipefail

TEST_NAME="test-0-fmk-harness-self-check"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

SCENARIO_LIB="$(cd "$(dirname "$0")" && pwd)/lib/scenario.sh"

# The release candidate's identity, recorded in the image
# (docker/Dockerfile.test.base).
RC_RELEASE_JSON=/opt/agent-director-rc/client/release.json
[[ -f "${RC_RELEASE_JSON}" ]] || fail "setup: the release candidate's identity ${RC_RELEASE_JSON} is missing"
RC_VERSION="$(jq -r '.version // empty' "${RC_RELEASE_JSON}")" \
    || fail "setup: could not read .version from ${RC_RELEASE_JSON}"
RC_COMMIT="$(jq -r '.commit // empty' "${RC_RELEASE_JSON}")" \
    || fail "setup: could not read .commit from ${RC_RELEASE_JSON}"
[[ -n "${RC_VERSION}" && -n "${RC_COMMIT}" ]] \
    || fail "setup: ${RC_RELEASE_JSON} names no version or no commit"

# The row and tmux session the tmux_and_store leg spawns.
T0_ROW_ID="t0-self-check"
T0_SESSION="t0-self-check"

# Set by the legs: the harness call's log line, the store id, and the
# scenario's tmux server PID.
HARNESS_CALL_LINE=""
T0_STORE_ID=""
T0_TMUX_PID=""
OUTSIDE_HOME=""

# agent-director's create timeout at its defaults (create_timeout_ms 5000;
# src/ad-settings.ts DEFAULT_AD_SETTINGS), the longest of its tmux call
# timeouts, in seconds; and the tmux shim's delays the mode legs set, each
# longer than it.
AD_CREATE_TIMEOUT_S=5
SLOW_CREATE_DELAY_S=10
WEDGE_DELAY_S=7

# The live start: its persona, and bounds in seconds.
LIVE_NAME="${SCENARIO_TAG}_live"
LIVE_KEY="$(persona_key "${LIVE_NAME}")"
# src/persona-identity.ts personaInstanceId.
LIVE_INSTANCE_ID="cscb_${LIVE_KEY}"
LIVE_STUB_WAIT_S=20    # the Slack stub writing its ready file
LIVE_START_WAIT_S=120  # the start pass: one bring-up and one launch
LIVE_REPORT_WAIT_S=60  # after the start pass: the approver's Enter and the row reporting in

# The mcp_session leg's persona, its health-check interval, how many ticks it
# watches, and a restart delay longer than the leg's run after the stub ends
# (so no relaunch connects the persona again while the leg reads it).
MCP_NAME="${SCENARIO_TAG}_mcp"
MCP_INSTANCE_ID="cscb_$(persona_key "${MCP_NAME}")"
MCP_TICK_S=3
MCP_TICKS=3
MCP_TICKS_WAIT_S=30    # for MCP_TICKS ticks after the session connected
MCP_RESTART_DELAY_S=120
MCP_CONNECT_WAIT_S=30  # after the row reported in: the server registering the stub's session
MCP_END_WAIT_S=20      # after the sentinel: the server seeing the session end
# A server log line about a reconnect, relaunch, restart or not-connected
# persona (case-insensitive ERE).
MCP_TROUBLE='reconnect|relaunch|restart|not[- ]connected|disconnected'

# The re-fire legs. A row held `pending` by a silent worker; reporting stubs
# for it (one per path), whose SessionStart hooks agent-director ignores with
# `pid_mismatch`; and the two stop legs' instance ids (a row with no launch
# start, and an id with no row).
REFIRE_ID="t0-refire"
NOLS_ID="t0-refire-nols"
NOROW_ID="t0-refire-no-row"
REFIRE_PATHS=(at-once trusted-config-dir trusted-home dev-channels unrecognised folder-trust)
# G: agent-director's default pending_grace_seconds (the self-check writes no
# ~/.agent-director/config.toml before the re-fire legs end; the hold leg
# checks there is none).
REFIRE_GRACE_S=60
# The re-fire's period, and the gap allowed between two of one stub's records
# (the period, plus its status read and hooks).
REFIRE_PERIOD_S=2
REFIRE_GAP_MIN_S=1.5
REFIRE_GAP_MAX_S=4.5
# How long a fired hook may take to write its record: a record of a fire
# made before G can be stamped up to this long after G.
REFIRE_HOOK_S=1
# Read after G plus REFIRE_SETTLE_S (every stub has read its row past G by
# then), and again REFIRE_QUIET_S later (three periods): no new record.
REFIRE_SETTLE_S=3
REFIRE_QUIET_S=6
# A reporting stub's first record comes within this long of its start (or
# its Enter).
REFIRE_FIRST_S=3
REFIRE_TRAIL="${HOME}/.agent-director/ad-trail.jsonl"

# Set by the re-fire legs: the held row's worker PID, its launch start
# (epoch seconds with milliseconds, and as status printed it) and the
# --settings its worker was given; per path, the reporting stub's PID and the
# time from which its records may come; the shim log's length before the
# legs, and CSCB's call count then.
REFIRE_SILENT_PID=""
REFIRE_LS=""
REFIRE_LAUNCH=""
REFIRE_SETTINGS=""
declare -A REFIRE_PID=()
declare -A REFIRE_FROM=()
REFIRE_AD_BEFORE=0
REFIRE_CSCB_BEFORE=0

# The harness-only step legs. Two rows the harness spawns early (the store
# and operator legs need their sessions older than a bound); ids no row
# holds for the seeded sessions; the name the scenario-25 statement writes.
T4_FIN_ID="t0-t4-finished"
T4_KILL_ID="t0-t4-kill"
T4_UNUSABLE_NAME="t0.t4.unusable"
T4_LEFTOVER_ID="t0-t4-leftover-id"
T4_ENV_ID="t0-t4-env-id"
T4_OTHER_ID="t0-t4-other-id"
T4_BORROWED_ID="cscb_t0_borrowed_other"
T4_LEFTOVER="t0-t4-leftover"
T4_UNLABELLED="t0-t4-unlabelled"
T4_ENV_ONLY="t0-t4-env-only"
T4_BORROWED="slack_bot_t0_borrowed"
T4_OTHER_STORE="t0-t4-other-store"
# The [tmux] settings the store leg writes to the scenario HOME's
# agent-director config.toml once the re-fire legs are done (they need
# agent-director's defaults): the starting-session bound and the stopping
# window at their safe minimums, in seconds. At the defaults (300 s, 90 s)
# agent-director makes the include-finished kill only of a session at least
# 300 s old.
T4_STARTING_BOUND_S=60
T4_STOPPING_WINDOW_S=30
# Bound on a row reporting in, and on a killed session ending, in seconds.
T4_REPORT_WAIT_S=30
T4_END_WAIT_S=15
# The find-missing loop's interval in its leg, in seconds.
T4_FM_INTERVAL_S=2
# Set by the legs: the leftover's session id, pane id and token, and the
# unlabelled and env-only sessions' ids.
T4_LEFTOVER_SID=""
T4_LEFTOVER_PANE=""
T4_LEFTOVER_TOKEN=""
T4_ENV_SID=""

# The fmk-driver legs' persona, its one channel and its working directory
# (made by the first driver leg).
DRV_NAME="${SCENARIO_TAG}_drv"
DRV_CHANNEL="C0T0DRV01"
DRV_WORK=""

# The closing enforcement's FAIL line, after `FAIL: <test>: `, up to its list
# of the assertions not passed.
ENFORCEMENT_LINE='the script exited 0 without the closing assertions ('

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# call_count [<log>]: print the number of `call` lines in <log> (the
# agent-director shim's log by default; 0 when there is none).
call_count() {
    local log="${1:-${SCENARIO_AD_SHIM_LOG}}"
    if [[ ! -f "${log}" ]]; then
        echo 0
        return 0
    fi
    awk -F'\t' '$1 == "call" { n++ } END { print n + 0 }' "${log}"
}

# last_call_line [<log>]: print <log>'s last `call` line (the agent-director
# shim's log by default).
last_call_line() {
    awk -F'\t' '$1 == "call" { l = $0 } END { print l }' "${1:-${SCENARIO_AD_SHIM_LOG}}"
}

# line_count <file>: print how many lines <file> holds (0 when there is none).
line_count() {
    if [[ ! -f "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l < "$1" | tr -d ' '
}

# True when <a> < <b>, both seconds with decimals.
time_before() {
    awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'
}

# Print the seconds from <a> to <b>, both seconds with decimals.
seconds_between() {
    awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f\n", b - a }'
}

# read_call <step> <line>: split one `call` line into CALL_TIME, CALL_PID,
# CALL_PPID, CALL_PARENT (the parent's command line, an array) and CALL_WORDS
# (the argv after argv[0], an array); fail unless it has the format's six
# fields and its quoted fields parse (through scenario.sh's
# `_scenario_eval_words`).
read_call() {
    local step="$1" line="$2" nf kind parent words
    nf="$(awk -F'\t' '{ print NF }' <<< "${line}")"
    [[ "${nf}" == 6 ]] || fail "${step}: shim log line has ${nf} field(s), not 6: ${line}"
    IFS=$'\t' read -r kind CALL_TIME CALL_PID CALL_PPID parent words <<< "${line}"
    [[ "${kind}" == call ]] || fail "${step}: shim log line's kind is '${kind}', not call"
    [[ "${CALL_TIME}" =~ ^[0-9]+\.[0-9]{6}$ ]] \
        || fail "${step}: shim log line's time '${CALL_TIME}' is not seconds with six decimals"
    [[ "${CALL_PID}" =~ ^[0-9]+$ && "${CALL_PPID}" =~ ^[0-9]+$ ]] \
        || fail "${step}: shim log line's pid '${CALL_PID}' or ppid '${CALL_PPID}' is not a number"
    CALL_PARENT=()
    if [[ "${parent}" != '?' ]]; then
        _scenario_eval_words CALL_PARENT "${parent}" || fail "${step}: shim log line's parent field does not parse: ${parent}"
    fi
    _scenario_eval_words CALL_WORDS "${words}" || fail "${step}: shim log line's words field does not parse: ${words}"
}

# same_words <array-name> <array-name>: true when both arrays hold the same
# elements in the same order.
same_words() {
    local -n same_a="$1" same_b="$2"
    local i
    (( ${#same_a[@]} == ${#same_b[@]} )) || return 1
    for i in "${!same_a[@]}"; do
        [[ "${same_a[i]}" == "${same_b[i]}" ]] || return 1
    done
}

# Print the words, each `printf %q`-quoted, so a failure shows where they differ.
quoted() {
    local q
    printf -v q '%q ' "$@"
    printf '%s\n' "${q% }"
}

# expect_shim_in_place <step> <binary>: the standard path holds the shim (a
# regular executable file, not a symlink, the fixture byte for byte, carrying
# its marker line) and the file behind it is <binary>, byte for byte.
expect_shim_in_place() {
    local step="$1" binary="$2" path="${SCENARIO_AD_BIN}"
    [[ -f "${path}" && ! -L "${path}" ]] || fail "${step}: ${path} is not a regular file"
    grep -qxF -- "${SCENARIO_AD_SHIM_MARKER}" "${path}" || fail "${step}: ${path} does not carry the shim's marker"
    cmp -s -- "${SCENARIO_AD_SHIM_SRC}" "${path}" || fail "${step}: ${path} is not the shim ${SCENARIO_AD_SHIM_SRC}"
    [[ -x "${path}" ]] || fail "${step}: the shim at ${path} is not executable"
    [[ -f "${path}.real" && ! -L "${path}.real" && -x "${path}.real" ]] \
        || fail "${step}: no executable regular file behind the shim at ${path}.real"
    cmp -s -- "${binary}" "${path}.real" || fail "${step}: the binary behind the shim is not ${binary}"
}

# expect_ad_version <step> <version> [<commit>]: a harness call of `version`
# through the shim answers <version> (and <commit>, when given).
expect_ad_version() {
    local step="$1" want="$2" want_commit="${3:-}" got got_commit
    ad_capture version
    (( AD_RC == 0 )) || fail "${step}: agent-director version exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    got="$(jq -r '.version // empty' "${AD_OUT}")" || fail "${step}: version printed no JSON: $(head -c 300 "${AD_OUT}")"
    [[ "${got}" == "${want}" ]] || fail "${step}: a call through the shim reports version '${got}', not ${want}"
    if [[ -n "${want_commit}" ]]; then
        got_commit="$(jq -r '.commit // empty' "${AD_OUT}")"
        [[ "${got_commit}" == "${want_commit}" ]] \
            || fail "${step}: a call through the shim reports commit '${got_commit}', not ${want_commit}"
    fi
}

# expect_fails_in_home <step> <home> <reason> <command> [<arg>...]: run the
# command in a subshell with HOME=<home>; fail unless it exits non-zero with
# a FAIL line of this test carrying <reason>. Either failure of it names
# <reason>.
expect_fails_in_home() {
    local step="$1" home="$2" reason="$3"
    shift 3
    local out="${SCENARIO_ROOT}/expect-fails.out" rc=0 line
    ( export HOME="${home}"; "$@" ) > "${out}" 2>&1 || rc=$?
    if (( rc == 0 )); then
        sed 's/^/  | /' "${out}" >&2
        fail "${step}: '$*' with HOME ${home} succeeded, not failing with '${reason}'"
    fi
    line="$(grep -m1 '^FAIL:' "${out}" || true)"
    if [[ "${line}" != "FAIL: ${TEST_NAME}: "*"${reason}"* ]]; then
        sed 's/^/  | /' "${out}" >&2
        fail "${step}: '$*' with HOME ${home} failed without '${reason}'"
    fi
}

# Print a digest of everything under <dir>: each entry's path, type, size,
# mode and modification time, and each file's SHA-256.
tree_digest() {
    (
        cd "$1" || exit 1
        find . -printf '%p %y %s %m %T@\n' | LC_ALL=C sort
        find . -type f -exec sha256sum {} + | LC_ALL=C sort
    )
}

# shim_call <name> <arg>...: run the tmux shim by its path from the scenario's
# shell, standard input from /dev/null; set SHIM_RC, SHIM_OUT and SHIM_ERR
# (its standard output and error, in files named after <name>).
shim_call() {
    local name="$1"
    shift
    SHIM_OUT="${SCENARIO_ROOT}/shim-${name}.out"
    SHIM_ERR="${SCENARIO_ROOT}/shim-${name}.err"
    SHIM_RC=0
    "${SCENARIO_TMUX_SHIM_BIN}/tmux" "$@" < /dev/null > "${SHIM_OUT}" 2> "${SHIM_ERR}" || SHIM_RC=$?
}

# expect_shim_refused <step>: the last shim_call exited 1, wrote nothing to
# standard output and one line to standard error, the shim's own (`tmux-shim:`),
# not tmux's.
expect_shim_refused() {
    local step="$1" n
    if (( SHIM_RC != 1 )) || [[ -s "${SHIM_OUT}" ]]; then
        sed 's/^/  | /' "${SHIM_OUT}" "${SHIM_ERR}" >&2
        fail "${step}: the call exited ${SHIM_RC} (not 1) or wrote to standard output"
    fi
    n="$(line_count "${SHIM_ERR}")"
    if [[ "${n}" != 1 ]] || ! grep -q '^tmux-shim: ' "${SHIM_ERR}"; then
        sed 's/^/  | /' "${SHIM_ERR}" >&2
        fail "${step}: standard error holds ${n} line(s), not the shim's one tmux-shim: line"
    fi
}

# True when the scenario's tmux server holds a session named exactly <name>
# (asked with the real tmux).
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# expect_ad_error <step> <err_name>: the last ad_capture failed with <err_name>.
expect_ad_error() {
    local step="$1" want="$2"
    if (( AD_RC == 0 )) || ! grep -qF "\"err_name\":\"${want}\"" "${AD_OUT}" "${AD_ERR}"; then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: agent-director exited ${AD_RC} without ${want}"
    fi
}

# expect_row_state <step> <instance-id> <state>: a harness get of the row
# shows <state>.
expect_row_state() {
    local step="$1" id="$2" want="$3" got
    ad_capture get --claude-instance-id "${id}"
    (( AD_RC == 0 )) || fail "${step}: harness get of ${id} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    got="$(jq -r '.state // empty' "${AD_OUT}")"
    [[ "${got}" == "${want}" ]] || fail "${step}: row ${id} is '${got}', not ${want}"
}

# True when a harness get of row <instance-id> shows <state>.
row_state_is() {
    ad_capture get --claude-instance-id "$1"
    (( AD_RC == 0 )) && [[ "$(jq -r '.state // empty' "${AD_OUT}")" == "$2" ]]
}

# last_tmux_line_with <after> <fragment>...: print the last tmux shim log line
# after line <after> that holds every fixed-string <fragment>.
last_tmux_line_with() {
    local after="$1" line frag found=""
    shift
    while IFS= read -r line; do
        for frag in "$@"; do
            [[ "${line}" == *"${frag}"* ]] || continue 2
        done
        found="${line}"
    done < <(tail -n "+$(( after + 1 ))" "${SCENARIO_TMUX_SHIM_LOG}")
    printf '%s\n' "${found}"
}

# True when the tmux shim log holds more than <n> lines.
tmux_log_longer_than() {
    (( $(line_count "${SCENARIO_TMUX_SHIM_LOG}") > $1 ))
}

# Print how many `call` lines of the tmux shim log have as their parent an
# agent-director process (its argv[0] the agent-director shim's path).
tmux_lines_from_ad() {
    local line n=0
    while IFS= read -r line; do
        read_call "tmux lines from agent-director" "${line}"
        [[ "${CALL_PARENT[0]:-}" == */agent-director ]] && n=$(( n + 1 ))
    done < <(awk -F'\t' '$1 == "call"' "${SCENARIO_TMUX_SHIM_LOG}")
    echo "${n}"
}

# window_copy <dir> <tmux-from> <tmux-to> <ad-from> <ad-to>: write into <dir>
# lines <tmux-from>..<tmux-to> of the tmux shim log, lines <ad-from>..<ad-to>
# of the agent-director shim log (none when from > to) and the whole CSCB
# process record as it stands, under the real files' names.
window_copy() {
    local dir="$1"
    mkdir -p "${dir}"
    _scenario_cscb_after || fail "window copy: could not update the CSCB process record"
    awk -v a="$2" -v b="$3" 'NR >= a && NR <= b' "${SCENARIO_TMUX_SHIM_LOG}" > "${dir}/tmux-shim.log"
    awk -v a="$4" -v b="$5" 'NR >= a && NR <= b' "${SCENARIO_AD_SHIM_LOG}" > "${dir}/agent-director-shim.log"
    cp -- "${SCENARIO_CSCB_RECORD}" "${dir}/cscb-processes"
}

# on_files <dir> <command> [<arg>...]: run <command> in a subshell with the
# assertions and count helpers pointed at <dir>'s tmux-shim.log,
# agent-director-shim.log and cscb-processes; its status passes through. A
# closing assertion run so never counts toward the closing enforcement.
on_files() {
    local dir="$1"
    shift
    (
        SCENARIO_TMUX_SHIM_LOG="${dir}/tmux-shim.log"
        SCENARIO_AD_SHIM_LOG="${dir}/agent-director-shim.log"
        SCENARIO_CSCB_RECORD="${dir}/cscb-processes"
        "$@"
    )
}

# expect_on_files <step> <dir> <pass | fail> <assertion> [<reason>]: run
# <assertion> on <dir>'s files; fail unless it passes (pass) or fails with
# its FAIL line `FAIL: <test>: <assertion>: …<reason>…` (fail).
expect_on_files() {
    local step="$1" dir="$2" want="$3" assertion="$4" reason="${5:-}" out rc=0 line
    out="${dir}/${assertion}.out"
    on_files "${dir}" "${assertion}" > "${out}" 2>&1 || rc=$?
    if [[ "${want}" == pass ]]; then
        if (( rc != 0 )); then
            sed 's/^/  | /' "${out}" >&2
            fail "${step}: ${assertion} failed on ${dir##*/}: $(grep -m1 '^FAIL:' "${out}" || true)"
        fi
        return 0
    fi
    if (( rc == 0 )); then
        sed 's/^/  | /' "${dir}/tmux-shim.log" "${dir}/agent-director-shim.log" >&2
        fail "${step}: ${assertion} passed on ${dir##*/}"
    fi
    line="$(grep -m1 '^FAIL:' "${out}" || true)"
    if [[ "${line}" != "FAIL: ${TEST_NAME}: ${assertion}: "*"${reason}"* ]]; then
        sed 's/^/  | /' "${out}" >&2
        fail "${step}: ${assertion} failed on ${dir##*/} without '${reason}'"
    fi
}

# ---------------------------------------------------------------------------
# Synthetic logs and records (the synthetic_* and count_helpers legs)
# ---------------------------------------------------------------------------

# A synthetic record: a bot server (PID SYN_SERVER) whose window is 1000 to
# 2000 s, a CSCB CLI run (SYN_RUN) from 1100 to 1200 s; SYN_SHELL is a PID no
# entry holds, with the scenario shell's command line, as a harness call's
# parent is. PIDs above any pid_max, so none is a live process's.
SYN_SERVER=5000001
SYN_RUN=5000002
SYN_SHELL=5000003
SYN_OTHER=5000004
SYN_SERVER_CMD='bun /test-repo/node_modules/claude-slack-channel-bots/src/server.ts'
SYN_RUN_CMD='bun /test-repo/node_modules/.bin/claude-slack-channel-bots list'
SYN_AD_CMD=""  # the agent-director shim's path, quoted as a parent is (set by syn_base)

# syn_line <file> <kind> <time> <pid> <ppid> <parent> <word>...: append one
# line in the shims' format: <parent> as given (already quoted), each <word>
# `printf %q`-quoted.
syn_line() {
    local file="$1" kind="$2" time="$3" pid="$4" ppid="$5" parent="$6" words=""
    shift 6
    if (( $# > 0 )); then
        printf -v words '%q ' "$@"
        words="${words% }"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${kind}" "${time}" "${pid}" "${ppid}" "${parent}" "${words}" >> "${file}"
}

# syn_base <dir>: write the clean base case into <dir>: the record; an
# agent-director log with the bot server's version probe and its spawn; a
# tmux log with that spawn's new-session, its parent the spawn's
# agent-director process. Every closing assertion passes it.
syn_base() {
    local dir="$1"
    printf -v SYN_AD_CMD '%q spawn' "${SCENARIO_AD_BIN}"
    rm -rf -- "${dir}"
    mkdir -p "${dir}"
    printf 'proc\tserver\t%s\t11\t1000.000000\t%s\n' "${SYN_SERVER}" "${SYN_SERVER_CMD}" > "${dir}/cscb-processes"
    printf 'proc\trun\t%s\t12\t1100.000000\t%s\n' "${SYN_RUN}" "${SYN_RUN_CMD}" >> "${dir}/cscb-processes"
    printf 'gone\t%s\t12\t1200.000000\n' "${SYN_RUN}" >> "${dir}/cscb-processes"
    printf 'gone\t%s\t11\t2000.000000\n' "${SYN_SERVER}" >> "${dir}/cscb-processes"
    : > "${dir}/agent-director-shim.log"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/agent-director-shim.log" call 1001.000000 6000001 "${SYN_SERVER}" "${SYN_SERVER_CMD}" version
    syn_line "${dir}/agent-director-shim.log" call 1002.000000 6000002 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        spawn --claude-instance-id cscb_alpha
    syn_line "${dir}/tmux-shim.log" call 1002.100000 7000001 6000002 "${SYN_AD_CMD}" \
        -u new-session -d -s slack_bot_alpha
}

# syn_case <name>: a fresh copy of the base case; print its directory.
syn_case() {
    local dir="${SCENARIO_ROOT}/synthetic/$1"
    syn_base "${dir}"
    printf '%s\n' "${dir}"
}

# ---------------------------------------------------------------------------
# Nested fmk runs (the start_on_010 and closing_enforcement legs)
# ---------------------------------------------------------------------------

# run_nested <name> <ad-start> <body> [<function>...]: write a nested fmk run
# into SCENARIO_ROOT (TEST_NAME <name>, SCENARIO_AD_START <ad-start>, sourcing
# lib/scenario.sh, then RC_VERSION and RC_COMMIT, the <function>s and <body>,
# and a call of <body>), run it, and set NESTED_RC and NESTED_OUT (its output).
run_nested() {
    local name="$1" ad_start="$2" body="$3" script
    shift 3
    script="${SCENARIO_ROOT}/${name}.sh"
    NESTED_OUT="${SCENARIO_ROOT}/${name}.out"
    NESTED_RC=0
    {
        printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
        printf 'TEST_NAME=%q\n' "${name}"
        printf 'SCENARIO_AD_START=%q\n' "${ad_start}"
        printf 'source %q\n' "${SCENARIO_LIB}"
        printf 'RC_VERSION=%q\nRC_COMMIT=%q\n' "${RC_VERSION}" "${RC_COMMIT}"
        declare -f "$@" "${body}"
        printf '%s\n' "${body}"
    } > "${script}"
    bash "${script}" > "${NESTED_OUT}" 2>&1 || NESTED_RC=$?
}

# expect_nested_markers <step> <marker>...: the nested run printed each
# `CHECK: <marker>` line.
expect_nested_markers() {
    local step="$1" m
    shift
    for m in "$@"; do
        if ! grep -qxF "CHECK: ${m}" "${NESTED_OUT}"; then
            sed 's/^/  | /' "${NESTED_OUT}" >&2
            fail "${step}: the nested run did not get past its check '${m}'"
        fi
    done
}

# expect_nested_only_fail <step> <name> <text>: the nested run exited
# non-zero, and its one FAIL line is `FAIL: <name>: <text>…`.
expect_nested_only_fail() {
    local step="$1" name="$2" want="$3" fails=()
    mapfile -t fails < <(grep '^FAIL:' "${NESTED_OUT}" || true)
    if (( NESTED_RC == 0 || ${#fails[@]} != 1 )) || [[ "${fails[0]}" != "FAIL: ${name}: ${want}"* ]]; then
        sed 's/^/  | /' "${NESTED_OUT}" >&2
        fail "${step}: the nested run exited ${NESTED_RC} with ${#fails[@]} FAIL line(s) (first: ${fails[0]:-none}), not exactly one 'FAIL: ${name}: ${want}…'"
    fi
}

# A stand-in bot server for a nested run (written into its script with
# `declare -f`): a background process of the run, recorded as a bot server
# from now; one agent-director `call` line whose parent it is (a version
# probe) and one tmux `call` line whose parent is that agent-director process,
# both written into the run's own logs at NESTED_T, inside its window, so
# every closing assertion and positive control passes. Sets
# NESTED_SERVER_PID and NESTED_T.
nested_stand_in() {
    local st ad_cmd
    sleep 300 &
    NESTED_SERVER_PID=$!
    st="$(_scenario_proc_starttime "${NESTED_SERVER_PID}")"
    [[ -n "${st}" ]] || fail "stand-in: no start time for ${NESTED_SERVER_PID}"
    NESTED_T="${EPOCHREALTIME/,/.}"
    _scenario_record_proc server "${NESTED_SERVER_PID}" "${st}" "${NESTED_T}" sleep 300
    printf -v ad_cmd '%q version' "${SCENARIO_AD_BIN}"
    printf 'call\t%s\t%s\t%s\t%s\t%s\n' "${NESTED_T}" 6000001 "${NESTED_SERVER_PID}" 'sleep 300' version \
        >> "${SCENARIO_AD_SHIM_LOG}"
    printf 'call\t%s\t%s\t%s\t%s\t%s\n' "${NESTED_T}" 7000001 6000001 "${ad_cmd}" list-sessions \
        >> "${SCENARIO_TMUX_SHIM_LOG}"
}

# The three closing assertions in the run's own shell, each followed by its
# marker.
nested_closing() {
    assert_no_server_tmux
    echo "CHECK: assert_no_server_tmux"
    assert_no_cscb_include_finished
    echo "CHECK: assert_no_cscb_include_finished"
    assert_no_cscb_delete
    echo "CHECK: assert_no_cscb_delete"
}

nested_closing_pass() {
    nested_stand_in
    nested_closing
    echo "PASS: ${TEST_NAME}"
}

nested_violation_after() {
    nested_stand_in
    nested_closing
    # A delete whose parent is the stand-in server, inside its window,
    # written after the closing assertions passed.
    printf 'call\t%s\t%s\t%s\t%s\t%s\n' "${NESTED_T}" 6000002 "${NESTED_SERVER_PID}" 'sleep 300' \
        'delete --claude-instance-id cscb_x' >> "${SCENARIO_AD_SHIM_LOG}"
    echo "CHECK: violating line written"
    echo "PASS: ${TEST_NAME}"
}

nested_closing_elsewhere() {
    local copies="${SCENARIO_ROOT}/copies" keep_tmux keep_ad keep_record
    nested_stand_in
    assert_no_server_tmux
    echo "CHECK: assert_no_server_tmux"
    # In the run's own shell, but over copies of its logs and record.
    mkdir -p "${copies}"
    cp -- "${SCENARIO_TMUX_SHIM_LOG}" "${SCENARIO_AD_SHIM_LOG}" "${SCENARIO_CSCB_RECORD}" "${copies}/"
    keep_tmux="${SCENARIO_TMUX_SHIM_LOG}"
    keep_ad="${SCENARIO_AD_SHIM_LOG}"
    keep_record="${SCENARIO_CSCB_RECORD}"
    SCENARIO_TMUX_SHIM_LOG="${copies}/${keep_tmux##*/}"
    SCENARIO_AD_SHIM_LOG="${copies}/${keep_ad##*/}"
    SCENARIO_CSCB_RECORD="${copies}/${keep_record##*/}"
    assert_no_cscb_include_finished
    echo "CHECK: assert_no_cscb_include_finished over copies"
    SCENARIO_TMUX_SHIM_LOG="${keep_tmux}"
    SCENARIO_AD_SHIM_LOG="${keep_ad}"
    SCENARIO_CSCB_RECORD="${keep_record}"
    # Over the run's own files, but in a subshell.
    ( assert_no_cscb_delete )
    echo "CHECK: assert_no_cscb_delete in a subshell"
    echo "PASS: ${TEST_NAME}"
}

nested_own_failure() {
    nested_stand_in
    echo "CHECK: stand-in"
    fail "planted failure before the closing assertions"
}

# ---------------------------------------------------------------------------
# Live starts (the live_start and mcp_session legs)
# ---------------------------------------------------------------------------

# start_slack_stub <dir> <suffix>: start the Slack stub in a new <dir>,
# answering ok for the token pair with <suffix> and refusing any other; wait
# for its ready file; export CSCB_SLACK_API_URL; set SLACK_STUB_PID.
start_slack_stub() {
    local dir="$1" suffix="$2" step="slack stub ${1##*/}" api_url
    mkdir "${dir}" || fail "${step}: could not create ${dir}"
    python3 - "${suffix}" << 'EOF' | write_file "${dir}/control.json"
import json, sys
print(json.dumps({
    "tokens": [{"suffix": sys.argv[1], "label": sys.argv[1], "auth": "ok", "connections": "ok"}],
    "default": {"auth": "invalid_auth", "connections": "invalid_auth"},
}))
EOF
    (cd "${dir}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${dir}/record.jsonl" \
        --control "${dir}/control.json" --ready-file "${dir}/ready.json") > "${dir}/stub.out" 2>&1 &
    SLACK_STUB_PID=$!
    track_pid "${SLACK_STUB_PID}"
    wait_for_file "${dir}/ready.json" "${LIVE_STUB_WAIT_S}" "${step}: the Slack stub never wrote its ready file"
    api_url="$(jq -r '.api_url' "${dir}/ready.json")"
    [[ "${api_url}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "${step}: the stub's api_url '${api_url}' is not loopback"
    export CSCB_SLACK_API_URL="${api_url}"
}

# ---------------------------------------------------------------------------
# Stub workers (the re-fire legs)
# ---------------------------------------------------------------------------

# jq: a trail record's time (`ts`, UTC with milliseconds) as epoch seconds
# with its milliseconds, as text.
TRAIL_EPOCH_JQ='def epoch: (.ts[0:19] + "Z" | fromdateiso8601 | tostring) + "." + .ts[20:23];'
# The trail records a re-fire leg reads: SessionStart ignored with the hook's
# parent $p; SessionStart fired, or ignored, for instance $id; and SessionStart
# ignored with parent $p for any reason but pid_mismatch, or naming a recorded
# pane process other than $pane.
TRAIL_IGNORED_FROM='.event == "ad.hook.ignored" and .hook_event == "SessionStart" and .parent_pid == $p'
TRAIL_FIRED_FOR='.event == "ad.hook.fired" and .event_name == "SessionStart" and .claude_instance_id == $id'
TRAIL_IGNORED_FOR='.event == "ad.hook.ignored" and .hook_event == "SessionStart" and .claude_instance_id == $id'
TRAIL_NOT_MISMATCH='.event == "ad.hook.ignored" and .hook_event == "SessionStart" and .parent_pid == $p and (.reason != "pid_mismatch" or .row_pane_pid != $pane)'

# trail_read <array-name> <jq-condition> [<jq-option>...]: set the array to
# the times of the trail's records that <jq-condition> keeps, in trail order
# (none when there is no trail yet). The options bind its variables.
trail_read() {
    local -n trail_read_out="$1"
    local cond="$2" out="${SCENARIO_ROOT}/trail-read.out"
    shift 2
    trail_read_out=()
    [[ -f "${REFIRE_TRAIL}" ]] || return 0
    jq -r "$@" "${TRAIL_EPOCH_JQ} select(${cond}) | epoch" "${REFIRE_TRAIL}" > "${out}" \
        || fail "trail: jq could not read ${REFIRE_TRAIL}"
    mapfile -t trail_read_out < "${out}"
}

# Print the number of SessionStart records ignored with parent <pid>.
records_from() {
    local times=()
    trail_read times "${TRAIL_IGNORED_FROM}" --argjson p "$1"
    echo "${#times[@]}"
}

# True when at least <n> SessionStart records were ignored with parent <pid>.
records_from_at_least() {
    (( $(records_from "$1") >= $2 ))
}

# Print the time now, epoch seconds with microseconds.
now_s() {
    printf '%s\n' "${EPOCHREALTIME/,/.}"
}

# Print <a> + <b>, both seconds with decimals.
seconds_plus() {
    awk -v a="$1" -v b="$2" 'BEGIN { printf "%.6f\n", a + b }'
}

# Sleep until the time <t> (epoch seconds); return at once when it has passed.
sleep_until() {
    sleep "$(awk -v t="$1" -v n="$(now_s)" 'BEGIN { d = t - n; printf "%.3f\n", (d > 0 ? d : 0) }')"
}

# True when <pid> runs the scenario's stub `claude`.
stub_running() {
    grep -qzxF -- "${SCENARIO_BIN}/claude" "/proc/$1/cmdline" 2> /dev/null
}

# True when tmux pane <target> on the scenario's server shows <text>.
pane_shows() {
    "${SCENARIO_REAL_TMUX}" capture-pane -p -t "$1" 2> /dev/null | grep -F -- "$2" > /dev/null
}

# hold_row <step> <instance-id> <dir-name>: a harness spawn, from the
# scenario's own shell, of row <instance-id> in a working directory selected
# for the silent mode, so its worker never reports in and the row stays
# `pending`. Sets HELD_PID (the worker, the pane's process), HELD_LS (the
# launch start, epoch seconds with milliseconds), HELD_LAUNCH (as status
# printed it) and HELD_SETTINGS (the --settings the worker was given).
hold_row() {
    local step="$1" id="$2" dir argv=() i launch
    dir="$(make_workdir "$3")"
    stub_mode "${dir}" "${STUB_MODE_SILENT}"
    ad_capture spawn --cwd "${dir}" --claude-instance-id "${id}" --tmux-session-name "${id}" --no-pre-trust
    if (( AD_RC != 0 )); then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: harness spawn of ${id} exited ${AD_RC}"
    fi
    HELD_PID="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${id}" '#{pane_pid}')" \
        || fail "${step}: no pane for session ${id}"
    wait_until 10 "${step}: ${id}'s pane process ${HELD_PID} never became the stub" stub_running "${HELD_PID}"
    mapfile -d '' -t argv < "/proc/${HELD_PID}/cmdline"
    HELD_SETTINGS=""
    for i in "${!argv[@]}"; do
        [[ "${argv[i]}" == --settings ]] && HELD_SETTINGS="${argv[i + 1]:-}"
    done
    [[ -n "${HELD_SETTINGS}" ]] || fail "${step}: ${id}'s worker was given no --settings"
    ad_capture status --claude-instance-id "${id}"
    (( AD_RC == 0 )) || fail "${step}: harness status of ${id} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    [[ "$(jq -r '.state // empty' "${AD_OUT}")" == pending ]] \
        || fail "${step}: ${id} reads '$(jq -r '.state // empty' "${AD_OUT}")', not pending"
    launch="$(jq -r '.launch_started_at // empty' "${AD_OUT}")"
    [[ -n "${launch}" ]] || fail "${step}: ${id} reads pending with no launch start"
    HELD_LAUNCH="${launch}"
    HELD_LS="$(date -u -d "${launch}" +%s.%3N)" || fail "${step}: ${id}'s launch start '${launch}' is not a time"
}

# refire_stub <step> <session> <dir> <instance-id> <settings> [<VAR>=<value>...]:
# start a stub worker (the scenario's `claude`) in its own tmux session on
# the scenario's server, as the pane's process, with working directory <dir>,
# AGENT_DIRECTOR_INSTANCE_ID <instance-id>, `--settings <settings>`, no
# CLAUDE_CONFIG_DIR and the given variables. Sets STUB_PID.
refire_stub() {
    local step="$1" session="$2" dir="$3" id="$4" settings="$5"
    shift 5
    "${SCENARIO_REAL_TMUX}" new-session -d -s "${session}" -x 200 -y 50 -c "${dir}" -- \
        env -u CLAUDE_CONFIG_DIR "AGENT_DIRECTOR_INSTANCE_ID=${id}" "$@" "${SCENARIO_BIN}/claude" --settings "${settings}" \
        || fail "${step}: could not start a stub in tmux session ${session}"
    STUB_PID="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${session}" '#{pane_pid}')" \
        || fail "${step}: no pane for session ${session}"
    wait_until 10 "${step}: ${session}'s pane process ${STUB_PID} never became the stub" stub_running "${STUB_PID}"
}

# refire_start <path> [<VAR>=<value>...]: a reporting stub for the held row
# in REFIRE_DIR (made by refire_dir); records its PID and its start time for
# <path>.
refire_start() {
    local path="$1" t
    shift
    t="$(now_s)"
    refire_stub "re-fire ${path}" "t0-refire-${path}" "${REFIRE_DIR}" "${REFIRE_ID}" "${REFIRE_SETTINGS}" "$@"
    REFIRE_PID["${path}"]="${STUB_PID}"
    REFIRE_FROM["${path}"]="${t}"
}

# refire_dir <path> <mode>: make the working directory of <path>'s stub and
# select <mode> for it; sets REFIRE_DIR (its real path).
refire_dir() {
    REFIRE_DIR="$(make_workdir "refire-$1")"
    REFIRE_DIR="$(realpath -e -- "${REFIRE_DIR}")"
    stub_mode "${REFIRE_DIR}" "$2"
}

# expect_reported_at_once <path>: <path>'s stub reported in with no Enter:
# its pane shows the live-session banner and no dialog.
expect_reported_at_once() {
    local step="re-fire $1" session="t0-refire-$1"
    wait_until 10 "${step}: the stub never reported in (no banner in its pane)" \
        pane_shows "${session}" "Listening for channel messages"
    ! pane_shows "${session}" "Enter to confirm" || fail "${step}: the stub's pane shows a dialog"
}

# refire_enter_leg <path> <mode> <dialog-line>: <path>'s stub, held at its
# dialog (whose pane shows <dialog-line>) for longer than a period, fires no
# SessionStart and shows no banner; the harness's Enter makes it report in.
refire_enter_leg() {
    local path="$1" mode="$2" text="$3" step="re-fire $1" session="t0-refire-$1" t
    refire_dir "${path}" "${mode}"
    refire_start "${path}"
    wait_until 10 "${step}: the pane never showed the dialog line '${text}'" pane_shows "${session}" "${text}"
    sleep "$(seconds_plus "${REFIRE_PERIOD_S}" 0.5)"
    [[ "$(records_from "${REFIRE_PID[${path}]}")" == 0 ]] \
        || fail "${step}: the stub fired SessionStart before the Enter"
    ! pane_shows "${session}" "Listening for channel messages" || fail "${step}: the stub reported in before the Enter"
    pid_alive "${REFIRE_PID[${path}]}" || fail "${step}: the stub ended at its dialog"
    t="$(now_s)"
    stub_press_enter "${session}"
    REFIRE_FROM["${path}"]="${t}"
    wait_until 10 "${step}: the stub never reported in after the Enter" \
        pane_shows "${session}" "Listening for channel messages"
}

# stop_lines_for <instance-id>: print the shim log's stop lines whose words
# name instance <instance-id> (`… for instance <id>: …`).
stop_lines_for() {
    local id="$1" line words=()
    [[ -f "${SCENARIO_AD_SHIM_LOG}" ]] || return 0
    while IFS= read -r line; do
        _scenario_split_line "${line}" || continue
        _scenario_eval_words words "${_L_RAW_WORDS}" || continue
        [[ "${words[0]:-}" == stub-claude && "${words[6]:-}" == "${id}:" ]] && printf '%s\n' "${line}"
    done < <(awk -F'\t' '$1 == "stop"' "${SCENARIO_AD_SHIM_LOG}")
    return 0
}

# True when a stop line names instance <instance-id>.
has_stop_line() {
    [[ -n "$(stop_lines_for "$1")" ]]
}

# expect_one_stop_line <step> <instance-id> <pid>: exactly one stop line names
# <instance-id>; it is the shim log's format, kind `stop`, written by <pid>,
# and its words are `stub-claude stopped re-firing SessionStart for instance
# <id>:` and a reason. Sets STOP_WHY (the reason's words) and STOP_T (its
# time, epoch seconds).
expect_one_stop_line() {
    local step="$1" id="$2" pid="$3" lines=() words=() head=() want=()
    mapfile -t lines < <(stop_lines_for "${id}")
    if (( ${#lines[@]} != 1 )); then
        printf '  | %s\n' ${lines[@]+"${lines[@]}"} >&2
        fail "${step}: ${#lines[@]} stop line(s) name instance ${id}, not exactly one"
    fi
    _scenario_split_line "${lines[0]}" || fail "${step}: the stop line is not in the shim log's format: ${lines[0]}"
    [[ "${_L_KIND}" == stop ]] || fail "${step}: the stop line's kind is '${_L_KIND}'"
    [[ "${_L_PID}" == "${pid}" ]] || fail "${step}: the stop line's pid is ${_L_PID}, not the stub's ${pid}"
    _scenario_eval_words words "${_L_RAW_WORDS}" || fail "${step}: the stop line's words do not parse: ${_L_RAW_WORDS}"
    head=("${words[@]:0:7}")
    want=(stub-claude stopped re-firing SessionStart for instance "${id}:")
    same_words head want || fail "${step}: the stop line's words begin $(quoted "${head[@]}"), not $(quoted "${want[@]}")"
    STOP_WHY=("${words[@]:7}")
    STOP_T="$(awk -v us="${_L_US}" 'BEGIN { printf "%.6f\n", us / 1000000 }')"
}

# expect_none_after <step> <what> <time> <record-time>...: no record time is
# at or after <time>.
expect_none_after() {
    local step="$1" what="$2" t="$3" r
    shift 3
    for r in "$@"; do
        time_before "${r}" "${t}" || fail "${step}: ${what} at ${r}, after ${t}"
    done
}

# refire_gap_out <time>...: print the first two consecutive times whose gap is
# outside REFIRE_GAP_MIN_S..REFIRE_GAP_MAX_S, and the gap; nothing when none.
refire_gap_out() {
    printf '%s\n' "$@" | awk -v lo="${REFIRE_GAP_MIN_S}" -v hi="${REFIRE_GAP_MAX_S}" '
        NR > 1 { g = $1 - prev; if (g < lo || g > hi) { printf "%s then %s (%.3fs)\n", prev, $1, g; exit } }
        { prev = $1 }'
}

# ---------------------------------------------------------------------------
# Exit hooks
# ---------------------------------------------------------------------------

# The trap stopped the scenario's tmux server: the PID the tmux_and_store leg
# saw is gone and no tmux server answers on any socket under SCENARIO_ROOT.
tmux_server_gone() {
    local sock
    if [[ -n "${T0_TMUX_PID}" ]] && pid_alive "${T0_TMUX_PID}"; then
        fail "teardown: the scenario's tmux server (PID ${T0_TMUX_PID}) is still running after the trap"
    fi
    while IFS= read -r -d '' sock; do
        if timeout 5 "${SCENARIO_REAL_TMUX}" -S "${sock}" list-sessions > /dev/null 2>&1; then
            fail "teardown: a tmux server still answers on ${sock} after the trap"
        fi
    done < <(find "${SCENARIO_ROOT}" -type s -print0 2> /dev/null)
}

remove_outside_home() {
    if [[ -n "${OUTSIDE_HOME}" && "${OUTSIDE_HOME}" == /tmp/test-0-outside-home.* ]]; then
        rm -rf -- "${OUTSIDE_HOME}"
    fi
}

on_exit tmux_server_gone
on_exit remove_outside_home

# ---------------------------------------------------------------------------
# Legs
# ---------------------------------------------------------------------------

leg_isolation() {
    local step="isolation" passwd_home real_root real_home rc_dir dir found entries=()
    [[ "${HOME}" == "${SCENARIO_ROOT}/home" && "${HOME}" == "${SCENARIO_HOME}" && -d "${HOME}" ]] \
        || fail "${step}: HOME '${HOME}' is not the scenario HOME ${SCENARIO_ROOT}/home"
    real_root="$(realpath -e -- "${SCENARIO_ROOT}")"
    real_home="$(realpath -e -- "${HOME}")"
    [[ "${real_home}" == "${real_root}"/* ]] \
        || fail "${step}: HOME resolves to ${real_home}, outside SCENARIO_ROOT ${real_root}"
    passwd_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
    [[ -n "${passwd_home}" && "${real_home}" != "${passwd_home}" ]] \
        || fail "${step}: HOME is the container user's own home '${passwd_home}'"
    [[ "${TMUX_TMPDIR:-}" == "${SCENARIO_ROOT}/tmux" && -d "${TMUX_TMPDIR}" ]] \
        || fail "${step}: TMUX_TMPDIR '${TMUX_TMPDIR:-}' is not ${SCENARIO_ROOT}/tmux"
    [[ -z "${TMUX+set}" && -z "${TMUX_PANE+set}" ]] || fail "${step}: TMUX or TMUX_PANE is set"

    rc_dir="${SCENARIO_RC_BIN%/*}"
    IFS=: read -r -a entries <<< "${PATH}"
    [[ "${entries[0]:-}" == "${SCENARIO_BIN}" ]] \
        || fail "${step}: PATH starts with '${entries[0]:-}', not the scenario's bin ${SCENARIO_BIN}"
    for dir in "${entries[@]}"; do
        [[ "${dir}" == /* ]] || fail "${step}: PATH holds the relative or empty entry '${dir}'"
        [[ "${dir}" != "${rc_dir}" ]] || fail "${step}: PATH holds the image's default agent-director directory ${rc_dir}"
        [[ ! -e "${dir}/agent-director" && ! -L "${dir}/agent-director" ]] \
            || fail "${step}: PATH entry ${dir} holds an agent-director"
    done
    found="$(type -a -P agent-director || true)"
    [[ -z "${found}" ]] || fail "${step}: the scenario shell finds an agent-director: ${found}"
    [[ "$(type -P claude || true)" == "${SCENARIO_BIN}/claude" ]] \
        || fail "${step}: claude resolves to '$(type -P claude || true)', not ${SCENARIO_BIN}/claude"
    cmp -s -- "${SCENARIO_FIXTURES}/stub-claude.sh" "${SCENARIO_BIN}/claude" \
        || fail "${step}: ${SCENARIO_BIN}/claude is not the stub"
    [[ "$(type -P bun || true)" == /* ]] || fail "${step}: bun is not found on the scenario's PATH"

    [[ "${SCENARIO_AD_BIN}" == "${HOME}/.agent-director/bin/agent-director" ]] \
        || fail "${step}: SCENARIO_AD_BIN ${SCENARIO_AD_BIN} is not the scenario HOME's standard path"
    [[ "${SCENARIO_AD_SHIM_LOG}" == "${HOME}/.agent-director/bin/agent-director-shim.log" ]] \
        || fail "${step}: SCENARIO_AD_SHIM_LOG ${SCENARIO_AD_SHIM_LOG} is not beside the standard path"
    for found in agent-director-shim.log agent-director.real; do
        [[ ! -e "${passwd_home}/.agent-director/bin/${found}" ]] \
            || fail "${step}: the container user's own ${passwd_home}/.agent-director/bin holds ${found}"
    done
}

leg_real_binary() {
    local step="real binary" before out got got_commit
    before="$(call_count)"
    out="$("${SCENARIO_AD_BIN}.real" version)" || fail "${step}: ${SCENARIO_AD_BIN}.real version failed"
    got="$(jq -r '.version // empty' <<< "${out}")"
    got_commit="$(jq -r '.commit // empty' <<< "${out}")"
    [[ "${got}" == "${RC_VERSION}" && "${got_commit}" == "${RC_COMMIT}" ]] \
        || fail "${step}: the binary behind the shim reports ${got} ${got_commit}, not the recorded ${RC_VERSION} ${RC_COMMIT}"
    [[ "$(call_count)" == "${before}" ]] || fail "${step}: running the real binary by its own name added a shim log line"
}

leg_setup_install() {
    local step="setup install"
    expect_shim_in_place "${step}: after the setup's install" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}" "${RC_VERSION}" "${RC_COMMIT}"
    [[ -f "${HOME}/.agent-director/state.db" ]] || fail "${step}: no store at ${HOME}/.agent-director/state.db"
}

leg_harness_call_log() {
    local step="harness call log" before t_before t_after mine=()
    local want=(get --claude-instance-id "t0 no such row")
    before="$(call_count)"
    t_before="${EPOCHREALTIME/,/.}"
    ad_capture "${want[@]}"
    t_after="${EPOCHREALTIME/,/.}"
    grep -qF '"err_name"' "${AD_OUT}" "${AD_ERR}" \
        || fail "${step}: the call got no answer from agent-director (exit ${AD_RC})"
    [[ "$(call_count)" == "$(( before + 1 ))" ]] || fail "${step}: the call did not add exactly one call line"
    HARNESS_CALL_LINE="$(last_call_line)"
    read_call "${step}" "${HARNESS_CALL_LINE}"
    awk -v a="${t_before}" -v t="${CALL_TIME}" -v b="${t_after}" 'BEGIN { exit !(a <= t && t <= b) }' \
        || fail "${step}: the line's time ${CALL_TIME} is not between ${t_before} and ${t_after}"
    [[ "${CALL_PPID}" == "$$" ]] || fail "${step}: the line's parent is ${CALL_PPID}, not the scenario's shell $$"
    [[ "${CALL_PID}" != "$$" ]] || fail "${step}: the line's pid is the scenario's shell"
    mapfile -d '' -t mine < "/proc/$$/cmdline"
    same_words CALL_PARENT mine \
        || fail "${step}: the line's parent command line $(quoted "${CALL_PARENT[@]}") is not the shell's $(quoted "${mine[@]}")"
    same_words CALL_WORDS want || fail "${step}: the line's words $(quoted "${CALL_WORDS[@]}") are not the argv $(quoted "${want[@]}")"
}

leg_version_probe() {
    local step="version probe" probe="${SCENARIO_ROOT}/version-probe.ts" out err before rc=0 got
    out="${SCENARIO_ROOT}/version-probe.out"
    err="${SCENARIO_ROOT}/version-probe.err"
    cat > "${probe}" << 'EOF'
// The installed package's agent-director client, resolved from its src/:
// discovery and the version probe, as a CSCB process makes them.
import { homedir } from 'node:os'
const [pkgSrc] = process.argv.slice(2)
const client = await import(Bun.resolveSync('agent-director', pkgSrc))
const found = await client.resolveSystemBinary()
console.log(JSON.stringify({ home: homedir(), path: found.path, version: found.version }))
EOF
    before="$(call_count)"
    bun --no-install "${probe}" "${SCENARIO_REPO}/node_modules/claude-slack-channel-bots/src" > "${out}" 2> "${err}" || rc=$?
    if (( rc != 0 )); then
        sed 's/^/  | /' "${out}" "${err}" >&2
        fail "${step}: bun exited ${rc}"
    fi
    got="$(jq -r '.home' "${out}")"
    [[ "${got}" == "${HOME}" ]] || fail "${step}: bun's home is '${got}', not the scenario HOME ${HOME}"
    got="$(jq -r '.path' "${out}")"
    [[ "${got}" == "${SCENARIO_AD_BIN}" ]] || fail "${step}: the client resolved '${got}', not the shim at ${SCENARIO_AD_BIN}"
    got="$(jq -r '.version' "${out}")"
    [[ "${got}" == "${RC_VERSION}" ]] || fail "${step}: the probe got version '${got}', not the recorded ${RC_VERSION}"
    [[ "$(call_count)" == "$(( before + 1 ))" ]] || fail "${step}: the probe did not add exactly one call line"
    read_call "${step}" "$(last_call_line)"
    [[ "${CALL_WORDS[0]:-}" == version ]] || fail "${step}: the probe's line has words $(quoted "${CALL_WORDS[@]}"), not version …"
    [[ "${CALL_PPID}" != "$$" && ( "${CALL_PARENT[0]:-}" == */bun || "${CALL_PARENT[0]:-}" == bun ) ]] \
        || fail "${step}: the probe's line has parent $(quoted "${CALL_PARENT[@]}") (${CALL_PPID}), not bun"
}

leg_tmux_and_store() {
    local step="tmux and store" work row_socket info sock_path store_id got
    work="$(make_workdir self-check)"
    ad_capture spawn --cwd "${work}" --claude-instance-id "${T0_ROW_ID}" \
        --tmux-session-name "${T0_SESSION}" --no-pre-trust --label "t0=spawned"
    if (( AD_RC != 0 )); then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: harness spawn exited ${AD_RC}"
    fi
    ad_capture get --claude-instance-id "${T0_ROW_ID}"
    (( AD_RC == 0 )) || fail "${step}: harness get exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    row_socket="$(jq -r '.tmux_socket // empty' "${AD_OUT}")"
    [[ "${row_socket}" == "${TMUX_TMPDIR}"/* && -S "${row_socket}" ]] \
        || fail "${step}: the row's tmux socket '${row_socket}' is not a socket under ${TMUX_TMPDIR}"
    got="$(jq -r '.labels.t0 // empty' "${AD_OUT}")"
    [[ "${got}" == spawned ]] || fail "${step}: the spawned row's label t0 is '${got}', not spawned"

    # The scenario shell's tmux (by TMUX_TMPDIR) reaches the session, on the
    # row's socket, and the server is this scenario's.
    info="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${T0_SESSION}" '#{socket_path} #{pid}')" \
        || fail "${step}: the scenario shell's tmux does not reach session ${T0_SESSION}"
    sock_path="${info% *}"
    T0_TMUX_PID="${info##* }"
    [[ "${sock_path}" == "${row_socket}" ]] \
        || fail "${step}: the scenario shell's tmux talks to ${sock_path}, not the row's ${row_socket}"
    [[ "${T0_TMUX_PID}" =~ ^[0-9]+$ ]] || fail "${step}: tmux reported server PID '${T0_TMUX_PID}'"
    grep -qzxF -- "SCENARIO_ROOT=${SCENARIO_ROOT}" "/proc/${T0_TMUX_PID}/environ" \
        || fail "${step}: tmux server ${T0_TMUX_PID} does not carry this scenario's SCENARIO_ROOT"

    store_id="$(ad_store_id)"
    [[ "${store_id}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: ad_store_id printed '${store_id}'"
    T0_STORE_ID="${store_id}"
    ad_store_edit "UPDATE spawns SET labels = '{\"t0\":\"edited\"}' WHERE claude_instance_id = '${T0_ROW_ID}'"
    ad_capture get --claude-instance-id "${T0_ROW_ID}"
    (( AD_RC == 0 )) || fail "${step}: harness get after the edit exited ${AD_RC}"
    got="$(jq -r '.labels.t0 // empty' "${AD_OUT}")"
    [[ "${got}" == edited ]] || fail "${step}: harness get after ad_store_edit shows label t0 '${got}', not edited"
}

leg_swap() {
    local step="swap" got_commit
    swap_ad_binary 0.10.0 "${step}: to 0.10.0"
    expect_shim_in_place "${step}: after the swap to 0.10.0" "${SCENARIO_AD_010_BIN}"
    expect_ad_version "${step}: after the swap to 0.10.0" 0.10.0
    got_commit="$(jq -r '.commit // empty' "${AD_OUT}")"
    [[ "${got_commit}" != "${RC_COMMIT}" ]] || fail "${step}: 0.10.0 reports the release candidate's commit"
    swap_ad_binary rc "${step}: back to the release candidate"
    expect_shim_in_place "${step}: after the swap back" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}: after the swap back" "${RC_VERSION}" "${RC_COMMIT}"
}

leg_reinstall() {
    local step="reinstall" store_id
    install_ad_rc "${step}: install.sh again"
    expect_shim_in_place "${step}: after install.sh and its re-shim" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}" "${RC_VERSION}" "${RC_COMMIT}"
    store_id="$(ad_store_id)"
    [[ "${store_id}" == "${T0_STORE_ID}" ]] || fail "${step}: the store id changed from ${T0_STORE_ID} to ${store_id}"
}

leg_hide_restore() {
    local step="hide and restore"
    hide_ad_install "${step}: hide"
    [[ ! -e "${SCENARIO_AD_BIN}" && ! -L "${SCENARIO_AD_BIN}" ]] || fail "${step}: a file is at ${SCENARIO_AD_BIN} after the hide"
    [[ ! -e "${SCENARIO_AD_BIN}.real" && ! -L "${SCENARIO_AD_BIN}.real" ]] \
        || fail "${step}: a file is at ${SCENARIO_AD_BIN}.real after the hide"
    [[ -f "${SCENARIO_AD_SHIM_LOG}" ]] || fail "${step}: the shim log went with the hide"
    restore_ad_install "${step}: restore"
    expect_shim_in_place "${step}: after the restore" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}: after the restore" "${RC_VERSION}" "${RC_COMMIT}"
}

leg_log_kept() {
    local step="log kept" bad
    grep -qxF -- "${HARNESS_CALL_LINE}" "${SCENARIO_AD_SHIM_LOG}" \
        || fail "${step}: the harness call's line is gone from the shim log"
    bad="$(awk -F'\t' 'NF != 6 || ($1 != "call" && $1 != "stop") { print NR; exit }' "${SCENARIO_AD_SHIM_LOG}")"
    [[ -z "${bad}" ]] || fail "${step}: shim log line ${bad} does not have the format's six fields and a known kind"
}

# The body of the nested fmk run of leg_start_on_010 (written into its script
# with `declare -f`, after it sourced lib/scenario.sh with
# SCENARIO_AD_START=0.10.0). Each check prints its marker once it passed.
nested_start_on_010() {
    local step="0.10.0 start" file store_id
    expect_shim_in_place "${step}: after the setup's install" "${SCENARIO_AD_010_BIN}"
    echo "CHECK: 0.10.0 behind the shim"
    while IFS= read -r -d '' file; do
        ! cmp -s -- "${SCENARIO_RC_BIN}" "${file}" || fail "${step}: ${file} is the release candidate's binary"
    done < <(find "${HOME}" -type f -print0)
    echo "CHECK: no release-candidate binary"
    [[ ! -e "${HOME}/.agent-director/state.db" ]] || fail "${step}: a store exists before the release candidate's install"
    echo "CHECK: no store"
    expect_ad_version "${step}: a call through the shim" 0.10.0
    echo "CHECK: 0.10.0 answers"
    install_ad_rc "${step}: install_ad_rc"
    expect_shim_in_place "${step}: after install_ad_rc" "${SCENARIO_RC_BIN}"
    echo "CHECK: release candidate behind the shim"
    expect_ad_version "${step}: after install_ad_rc" "${RC_VERSION}" "${RC_COMMIT}"
    echo "CHECK: release candidate answers"
    store_id="$(ad_store_id)"
    [[ "${store_id}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: ad_store_id printed '${store_id}'"
    echo "CHECK: store id"
    echo "PASS: ${TEST_NAME}"
}

leg_start_on_010() {
    local step="0.10.0 start" name="test-0-fmk-nested-start-on-010"
    run_nested "${name}" 0.10.0 nested_start_on_010 expect_shim_in_place expect_ad_version
    expect_nested_markers "${step}" "0.10.0 behind the shim" "no release-candidate binary" "no store" \
        "0.10.0 answers" "release candidate behind the shim" "release candidate answers" "store id"
    # It started no bot server, so it cannot meet the closing assertions'
    # positive controls: it exits 0 without them, and the trap fails it.
    expect_nested_only_fail "${step}" "${name}" \
        "${ENFORCEMENT_LINE}assert_no_server_tmux, assert_no_cscb_include_finished, assert_no_cscb_delete: not passed in its own shell)"
}

leg_guard_refusals() {
    local step="guard refusals" link real_outside before home reason
    OUTSIDE_HOME="$(mktemp -d /tmp/test-0-outside-home.XXXXXX)" || fail "${step}: could not make a HOME outside SCENARIO_ROOT"
    # A decoy install and store each helper would act on, were it not refused.
    mkdir -p "${OUTSIDE_HOME}/.agent-director/bin"
    cp -- "${SCENARIO_AD_010_BIN}" "${OUTSIDE_HOME}/.agent-director/bin/agent-director"
    sqlite3 "${OUTSIDE_HOME}/.agent-director/state.db" \
        "CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO store_meta VALUES ('store_id', '0123456789abcdef'); CREATE TABLE spawns (claude_instance_id TEXT PRIMARY KEY, labels TEXT NOT NULL DEFAULT '{}');" \
        || fail "${step}: could not make the decoy store"
    link="${SCENARIO_ROOT}/home-link-outside"
    ln -s -- "${OUTSIDE_HOME}" "${link}"
    real_outside="$(realpath -e -- "${OUTSIDE_HOME}")"
    before="$(tree_digest "${OUTSIDE_HOME}")"

    for home in "${OUTSIDE_HOME}" "${link}"; do
        if [[ "${home}" == "${link}" ]]; then
            reason="refused: HOME ${link} resolves to ${real_outside}, which is not under SCENARIO_ROOT"
        else
            reason="refused: HOME '${OUTSIDE_HOME}' is not under SCENARIO_ROOT"
        fi
        expect_fails_in_home "${step}" "${home}" "${reason}" install_ad_shim
        expect_fails_in_home "${step}" "${home}" "${reason}" reshim_ad
        expect_fails_in_home "${step}" "${home}" "${reason}" install_ad_rc
        expect_fails_in_home "${step}" "${home}" "${reason}" install_ad_010
        expect_fails_in_home "${step}" "${home}" "${reason}" swap_ad_binary rc
        expect_fails_in_home "${step}" "${home}" "${reason}" hide_ad_install
        expect_fails_in_home "${step}" "${home}" "${reason}" restore_ad_install
        expect_fails_in_home "${step}" "${home}" "${reason}" ad version
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_store_edit "UPDATE spawns SET labels = '{}'"
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_store_id
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_store_pending_no_launch "${T0_ROW_ID}"
        expect_fails_in_home "${step}" "${home}" "${reason}" stub_mode "${SCENARIO_ROOT}/work" "${STUB_MODE_AT_ONCE}"
        expect_fails_in_home "${step}" "${home}" "${reason}" stub_press_enter "${T0_SESSION}"
        expect_fails_in_home "${step}" "${home}" "${reason}" write_mcp_config "${SCENARIO_PORT}"
        # The labels, seeding, the human's tmux steps, the store statements,
        # the operator's actions, the find-missing loop and the 0.10.0
        # seeders. Each would act on the scenario's own tmux server or
        # store were its guard not first.
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_new_token "${T0_ROW_ID}"
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_other_store_id
        # shellcheck disable=SC2016 # $1 is a literal tmux session id
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_owner_label 0123456789abcdef '$1' "${T0_ROW_ID}"
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_pane_label 0123456789abcdef %1
        expect_fails_in_home "${step}" "${home}" "${reason}" seed_leftover t0-guard "${T0_ROW_ID}" sleep 1
        expect_fails_in_home "${step}" "${home}" "${reason}" seed_unlabelled t0-guard sleep 1
        expect_fails_in_home "${step}" "${home}" "${reason}" seed_env_only t0-guard "${T0_ROW_ID}" sleep 1
        expect_fails_in_home "${step}" "${home}" "${reason}" seed_borrowed_name t0-guard "${T0_ROW_ID}" sleep 1
        expect_fails_in_home "${step}" "${home}" "${reason}" seed_other_store t0-guard "${T0_ROW_ID}" sleep 1
        expect_fails_in_home "${step}" "${home}" "${reason}" relabel_session "${T0_SESSION}"
        expect_fails_in_home "${step}" "${home}" "${reason}" attach_viewer "${T0_SESSION}"
        expect_fails_in_home "${step}" "${home}" "${reason}" rename_session "${T0_SESSION}" t0-guard
        expect_fails_in_home "${step}" "${home}" "${reason}" set_remain_on_exit "${T0_SESSION}"
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_owner_global_set
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_owner_global_unset
        expect_fails_in_home "${step}" "${home}" "${reason}" respawn_worker_pane "${T0_SESSION}" sleep 1
        expect_fails_in_home "${step}" "${home}" "${reason}" restart_tmux_server
        expect_fails_in_home "${step}" "${home}" "${reason}" rebind_tmux_socket
        # shellcheck disable=SC2016 # $0 is a literal tmux session id
        expect_fails_in_home "${step}" "${home}" "${reason}" end_session '$0'
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_store_mark_finished "${T0_ROW_ID}" missing
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_store_seed_pending "${T0_ROW_ID}"
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_store_unusable_name "${T0_ROW_ID}" t0.guard
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_kill_include_finished "${T0_ROW_ID}"
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_delete_unusable_row "${T0_ROW_ID}"
        expect_fails_in_home "${step}" "${home}" "${reason}" run_find_missing_loop 1
        expect_fails_in_home "${step}" "${home}" "${reason}" stop_find_missing_loop
        expect_fails_in_home "${step}" "${home}" "${reason}" find_missing_loop_runs
        expect_fails_in_home "${step}" "${home}" "${reason}" wait_find_missing_runs 1
        expect_fails_in_home "${step}" "${home}" "${reason}" seed_010_row t0-guard t0-guard "${SCENARIO_ROOT}"
        expect_fails_in_home "${step}" "${home}" "${reason}" seed_prepersona_fleet "${SCENARIO_ROOT}/none.json" C0T0GUARD=guard
    done
    [[ "$(tree_digest "${OUTSIDE_HOME}")" == "${before}" ]] \
        || fail "${step}: the HOME outside SCENARIO_ROOT changed under the refused helpers"
}

leg_shim_check() {
    local step="shim check" home="${SCENARIO_ROOT}/home-shim-check" bin
    bin="${home}/.agent-director/bin"
    mkdir -p "${bin}"
    cp -- "${SCENARIO_RC_BIN}" "${bin}/agent-director.real"
    cp -- "${SCENARIO_AD_SHIM_SRC}" "${bin}/agent-director"
    chmod 0755 "${bin}/agent-director.real" "${bin}/agent-director"
    ( export HOME="${home}"; check_ad_shim "${step}: a correct layout" ) \
        || fail "${step}: check_ad_shim refused a correct layout"

    rm -f -- "${bin}/agent-director"
    ln -s -- "${SCENARIO_AD_SHIM_SRC}" "${bin}/agent-director"
    expect_fails_in_home "${step}" "${home}" "is a symlink, not the shim" check_ad_shim

    rm -f -- "${bin}/agent-director"
    grep -vxF -- "${SCENARIO_AD_SHIM_MARKER}" "${SCENARIO_AD_SHIM_SRC}" > "${bin}/agent-director"
    chmod 0755 "${bin}/agent-director"
    expect_fails_in_home "${step}" "${home}" "does not carry the shim's marker" check_ad_shim
}

leg_tmux_shim_log() {
    local step="tmux shim log" session="t0-shim-log" before t_before t_after got mine=()
    local want=(new-session -d -P -F '#{session_name}' -s "${session}" -e "T0_SHIM_WORDS=a b" -- sleep 600)
    [[ "$(cat "${SCENARIO_TMUX_SHIM_MODE_FILE}")" == log ]] || fail "${step}: the shim's mode is not log after setup"
    before="$(call_count "${SCENARIO_TMUX_SHIM_LOG}")"
    t_before="${EPOCHREALTIME/,/.}"
    shim_call log "${want[@]}"
    t_after="${EPOCHREALTIME/,/.}"
    if (( SHIM_RC != 0 )); then
        sed 's/^/  | /' "${SHIM_OUT}" "${SHIM_ERR}" >&2
        fail "${step}: the call exited ${SHIM_RC}"
    fi
    # The real tmux ran: the session exists, its -P output reached the
    # caller, and the -e value (with its space) reached the session.
    has_session "${session}" || fail "${step}: no session ${session} after the call"
    [[ "$(cat "${SHIM_OUT}")" == "${session}" ]] || fail "${step}: the call printed '$(cat "${SHIM_OUT}")', not ${session}"
    got="$("${SCENARIO_REAL_TMUX}" show-environment -t "=${session}" T0_SHIM_WORDS)"
    [[ "${got}" == "T0_SHIM_WORDS=a b" ]] || fail "${step}: the session's T0_SHIM_WORDS is '${got}', not 'a b'"

    [[ "$(call_count "${SCENARIO_TMUX_SHIM_LOG}")" == "$(( before + 1 ))" ]] \
        || fail "${step}: the call did not add exactly one call line"
    read_call "${step}" "$(last_call_line "${SCENARIO_TMUX_SHIM_LOG}")"
    awk -v a="${t_before}" -v t="${CALL_TIME}" -v b="${t_after}" 'BEGIN { exit !(a <= t && t <= b) }' \
        || fail "${step}: the line's time ${CALL_TIME} is not between ${t_before} and ${t_after}"
    [[ "${CALL_PPID}" == "$$" ]] || fail "${step}: the line's parent is ${CALL_PPID}, not the scenario's shell $$"
    [[ "${CALL_PID}" != "$$" ]] || fail "${step}: the line's pid is the scenario's shell"
    mapfile -d '' -t mine < "/proc/$$/cmdline"
    same_words CALL_PARENT mine \
        || fail "${step}: the line's parent command line $(quoted "${CALL_PARENT[@]}") is not the shell's $(quoted "${mine[@]}")"
    same_words CALL_WORDS want || fail "${step}: the line's words $(quoted "${CALL_WORDS[@]}") are not the argv $(quoted "${want[@]}")"
    "${SCENARIO_REAL_TMUX}" kill-session -t "=${session}" || fail "${step}: could not kill ${session}"

    # The mode setter.
    tmux_shim_mode wedge 2.5
    [[ "$(cat "${SCENARIO_TMUX_SHIM_MODE_FILE}")" == "wedge 2.5" ]] \
        || fail "${step}: tmux_shim_mode wedge 2.5 wrote '$(cat "${SCENARIO_TMUX_SHIM_MODE_FILE}")'"
    tmux_shim_mode log
    expect_fails_in_home "${step}" "${HOME}" "tmux_shim_mode: unknown mode 'bogus'" tmux_shim_mode bogus
    expect_fails_in_home "${step}" "${HOME}" "tmux_shim_mode: mode fail-kill takes no delay" tmux_shim_mode fail-kill 3
    expect_fails_in_home "${step}" "${HOME}" "tmux_shim_mode: delay '3s' is not a number of seconds" tmux_shim_mode wedge 3s
    [[ "$(cat "${SCENARIO_TMUX_SHIM_MODE_FILE}")" == log ]] || fail "${step}: a refused tmux_shim_mode changed the mode"
}

leg_fail_kill() {
    local step="fail-kill" session="t0-fail-kill"
    "${SCENARIO_REAL_TMUX}" new-session -d -s "${session}" -- sleep 600 || fail "${step}: could not make ${session}"
    tmux_shim_mode fail-kill
    shim_call fk-session kill-session -t "=${session}"
    expect_shim_refused "${step}: kill-session"
    has_session "${session}" || fail "${step}: kill-session killed the session"
    shim_call fk-pane kill-pane -t "=${session}"
    expect_shim_refused "${step}: kill-pane"
    has_session "${session}" || fail "${step}: kill-pane killed the session"
    shim_call fk-alias killp -t "=${session}"
    expect_shim_refused "${step}: killp"
    has_session "${session}" || fail "${step}: killp killed the session"
    shim_call fk-prefix kill-ses -t "=${session}"
    expect_shim_refused "${step}: kill-ses"
    has_session "${session}" || fail "${step}: kill-ses killed the session"
    shim_call fk-global -L default kill-session -t "=${session}"
    expect_shim_refused "${step}: -L default kill-session"
    has_session "${session}" || fail "${step}: -L default kill-session killed the session"
    # A chained call: its first command prints the name were it run.
    shim_call fk-chained display-message -p -t "${session}" '#{session_name}' ';' kill-session -t "=${session}"
    expect_shim_refused "${step}: a chained call holding kill-session"
    has_session "${session}" || fail "${step}: the chained call killed the session"
    # Other commands run.
    shim_call fk-other display-message -p -t "${session}" '#{session_name}'
    (( SHIM_RC == 0 )) && [[ "$(cat "${SHIM_OUT}")" == "${session}" ]] \
        || fail "${step}: display-message exited ${SHIM_RC} printing '$(cat "${SHIM_OUT}")', not ${session}"
    # The next call after a mode change reads the new mode.
    tmux_shim_mode log
    shim_call fk-log kill-session -t "=${session}"
    (( SHIM_RC == 0 )) || fail "${step}: kill-session in log mode, right after the change, exited ${SHIM_RC}"
    ! has_session "${session}" || fail "${step}: kill-session in log mode left the session"
}

leg_fail_create() {
    local step="fail-create" shim_session="t0-fail-create-shim" id="t0-fail-create" work line ad_pid
    tmux_shim_mode fail-create
    shim_call fc-new-session new-session -d -s "${shim_session}" -- sleep 600
    expect_shim_refused "${step}: new-session"
    shim_call fc-alias new -d -s "${shim_session}" -- sleep 600
    expect_shim_refused "${step}: new"
    shim_call fc-default
    expect_shim_refused "${step}: a call with no command"
    ! has_session "${shim_session}" || fail "${step}: a refused new-session made ${shim_session}"
    shim_call fc-other list-sessions -F '#{session_name}'
    (( SHIM_RC == 0 )) && grep -qxF -- "${T0_SESSION}" "${SHIM_OUT}" \
        || fail "${step}: list-sessions exited ${SHIM_RC} without ${T0_SESSION}"

    # A real agent-director spawn with the shim first on its PATH.
    work="$(make_workdir fail-create)"
    PATH="${SCENARIO_TMUX_SHIM_BIN}:${PATH}" ad_capture spawn --cwd "${work}" --claude-instance-id "${id}" \
        --tmux-session-name "${id}" --no-pre-trust
    expect_ad_error "${step}: the spawn" ErrTmuxSessionCreate
    read_call "${step}" "$(last_call_line)"
    ad_pid="${CALL_PID}"
    line="$(last_tmux_line_with 0 new-session "${id}")"
    [[ -n "${line}" ]] || fail "${step}: the tmux shim logged no new-session for ${id}"
    read_call "${step}" "${line}"
    [[ "${CALL_PPID}" == "${ad_pid}" ]] \
        || fail "${step}: the new-session line's parent is ${CALL_PPID}, not the spawn's agent-director process ${ad_pid}"
    ! has_session "${id}" || fail "${step}: the failed spawn left a session ${id}"
    tmux_shim_mode log
    expect_row_state "${step}" "${id}" pending
}

leg_slow_create() {
    local step="slow-create" id="t0-slow-create" work before line info t_read owner pane deadline
    tmux_shim_mode slow-create "${SLOW_CREATE_DELAY_S}"
    before="$(line_count "${SCENARIO_TMUX_SHIM_LOG}")"
    work="$(make_workdir slow-create)"
    PATH="${SCENARIO_TMUX_SHIM_BIN}:${PATH}" ad_capture spawn --cwd "${work}" --claude-instance-id "${id}" \
        --tmux-session-name "${id}" --no-pre-trust
    info="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${id}" '#{@ad_owner}|#{@ad_pane}' 2> /dev/null || true)"
    t_read="${EPOCHREALTIME/,/.}"
    tmux_shim_mode log
    line="$(last_tmux_line_with "${before}" new-session "${id}")"
    [[ -n "${line}" ]] || fail "${step}: the tmux shim logged no new-session for ${id}"
    read_call "${step}" "${line}"
    deadline="$(awk -v t="${CALL_TIME}" -v d="${SLOW_CREATE_DELAY_S}" 'BEGIN { printf "%.6f\n", t + d }')"
    time_before "${t_read}" "${deadline}" \
        || fail "${step}: the session was read at ${t_read}, after the shim's delay ended (${deadline}); raise SLOW_CREATE_DELAY_S"
    owner="${info%%|*}"
    pane="${info#*|}"
    [[ " ${owner} " == *" ${id} "* ]] || fail "${step}: session ${id}'s @ad_owner is '${owner}', not naming ${id}, before the delay ended"
    [[ -n "${pane}" && "${info}" == *'|'* ]] || fail "${step}: session ${id} has no @ad_pane before the delay ended"
    expect_ad_error "${step}: the spawn" ErrTmuxUnresponsive
    has_session "${id}" || fail "${step}: the timed-out spawn's session ${id} is gone"
    expect_row_state "${step}" "${id}" pending
}

leg_wedge() {
    local step="wedge" session="t0-wedge" before pid rc=0 t_start t_end elapsed out err
    local want=(new-session -d -s "${session}" -- sleep 600)
    (( WEDGE_DELAY_S > AD_CREATE_TIMEOUT_S )) || fail "${step}: WEDGE_DELAY_S is not longer than the create timeout"
    out="${SCENARIO_ROOT}/shim-wedge.out"
    err="${SCENARIO_ROOT}/shim-wedge.err"
    tmux_shim_mode wedge "${WEDGE_DELAY_S}"
    before="$(line_count "${SCENARIO_TMUX_SHIM_LOG}")"
    t_start="${EPOCHREALTIME/,/.}"
    "${SCENARIO_TMUX_SHIM_BIN}/tmux" "${want[@]}" < /dev/null > "${out}" 2> "${err}" &
    pid=$!
    wait_until 5 "${step}: the call's line was not logged" tmux_log_longer_than "${before}"
    pid_alive "${pid}" || fail "${step}: the call had ended when its line was seen"
    read_call "${step}" "$(last_call_line "${SCENARIO_TMUX_SHIM_LOG}")"
    [[ "${CALL_PID}" == "${pid}" ]] || fail "${step}: the logged line's pid is ${CALL_PID}, not the call's ${pid}"
    same_words CALL_WORDS want || fail "${step}: the line's words $(quoted "${CALL_WORDS[@]}") are not the argv"
    wait "${pid}" || rc=$?
    t_end="${EPOCHREALTIME/,/.}"
    tmux_shim_mode log
    elapsed="$(seconds_between "${t_start}" "${t_end}")"
    (( rc == 1 )) || fail "${step}: the call exited ${rc}, not 1"
    ! time_before "${elapsed}" "${WEDGE_DELAY_S}" || fail "${step}: the call ended after ${elapsed}s, before its ${WEDGE_DELAY_S}s delay"
    [[ ! -s "${out}" ]] || fail "${step}: the call wrote to standard output"
    [[ "$(line_count "${err}")" == 1 ]] && grep -q '^tmux-shim: wedge: ' "${err}" \
        || fail "${step}: standard error is not the shim's one wedge line: $(head -c 300 "${err}")"
    ! has_session "${session}" || fail "${step}: the wedged call made ${session}: it ran tmux"
    [[ "$(line_count "${SCENARIO_TMUX_SHIM_LOG}")" == "$(( before + 1 ))" ]] \
        || fail "${step}: the wedged call logged more than its one line"
}

leg_mode_spawns_not_cscb() {
    local step="mode spawns not CSCB's" n
    n="$(tmux_lines_from_ad)"
    (( n >= 2 )) || fail "${step}: only ${n} tmux line(s) have an agent-director process as their parent, not the fail-create and slow-create spawns'"
    expect_fails_in_home "${step}" "${HOME}" "assert_no_server_tmux: positive control" assert_no_server_tmux
}

leg_path_wiring() {
    local step="path wiring" out="${SCENARIO_ROOT}/path-wiring.out" got rc=0 entries=() dir needle pid st
    cscb_run printenv PATH > "${out}"
    got="$(cat "${out}")"
    [[ "${got}" == "${SCENARIO_TMUX_SHIM_BIN}:${PATH}" ]] \
        || fail "${step}: a cscb_run command's PATH is '${got}', not the shim's bin directory, then the scenario's PATH"
    needle="$(awk -F'\t' 'NF == 6 && $1 == "proc" && $2 == "run" && $6 == "printenv PATH"' "${SCENARIO_CSCB_RECORD}")"
    [[ -n "${needle}" && "$(wc -l <<< "${needle}")" == 1 ]] \
        || fail "${step}: the record holds no single run entry for 'printenv PATH'"
    IFS=$'\t' read -r _ _ pid st _ <<< "${needle}"
    [[ "${pid}" =~ ^[0-9]+$ && "${st}" =~ ^[0-9]+$ ]] || fail "${step}: the run entry's PID '${pid}' or start time '${st}' is not a number"
    [[ -n "$(awk -F'\t' -v p="${pid}" -v s="${st}" '$1 == "gone" && $2 == p && $3 == s && $4 ~ /^[0-9]+\.[0-9][0-9][0-9][0-9][0-9][0-9]$/' \
        "${SCENARIO_CSCB_RECORD}")" ]] || fail "${step}: the record has no gone entry for the ended run ${pid}"
    cscb_run false || rc=$?
    (( rc == 1 )) || fail "${step}: cscb_run false returned ${rc}, not 1"

    IFS=: read -r -a entries <<< "${PATH}"
    for dir in "${entries[@]}"; do
        [[ "${dir}" != "${SCENARIO_TMUX_SHIM_BIN}" ]] || fail "${step}: the scenario's shell has the tmux shim on its PATH"
    done
    [[ "$(type -P tmux)" == "${SCENARIO_REAL_TMUX}" ]] \
        || fail "${step}: the scenario's shell finds tmux at '$(type -P tmux)', not the real ${SCENARIO_REAL_TMUX}"
}

leg_live_start() {
    local step="live start" creds work config_dir tmux_before ad_before
    local tmux_after ad_after server_path line n lines=()
    creds="${SCENARIO_ROOT}/credentials"
    mkdir -m 700 "${creds}"
    config_dir="${SCENARIO_ROOT}/claude-config"
    mkdir -p "${config_dir}"
    work="$(make_workdir live)"

    # The Slack stub: one token pair, answered ok; any other refused.
    start_slack_stub "${SCENARIO_ROOT}/slack-stub" livev1

    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot livev1)" "$(fake_token app livev1)" \
        | write_file "${creds}/live.json" 600
    write_config << EOF
{
  "personas": [
    {
      "name": "${LIVE_NAME}",
      "credentials_file": "${creds}/live.json",
      "working_directory": "${work}",
      "claude_config_dir": "${config_dir}",
      "channels": [{ "id": "C0T0LIVE1", "delivery": "all" }],
      "permission_prompts": "C0T0LIVE1"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "exit_timeout": 5
}
EOF

    tmux_before="$(line_count "${SCENARIO_TMUX_SHIM_LOG}")"
    ad_before="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
    start_server --live
    wait_for_log "$(completion_match 1)" "${LIVE_START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    # The stub prints the dev-channels dialog and fires SessionStart only on
    # the Enter the approver sends: the row reports in once it is cleared.
    wait_until "${LIVE_REPORT_WAIT_S}" "${step}: row ${LIVE_INSTANCE_ID} never reported in (waiting)" \
        row_state_is "${LIVE_INSTANCE_ID}" waiting
    tmux_after="$(line_count "${SCENARIO_TMUX_SHIM_LOG}")"
    ad_after="$(line_count "${SCENARIO_AD_SHIM_LOG}")"

    # The bot server is a recorded CSCB process with the shim first on PATH.
    server_path="$(tr '\0' '\n' < "/proc/${SERVER_PID}/environ" | sed -n 's/^PATH=//p')"
    [[ "${server_path}" == "${SCENARIO_TMUX_SHIM_BIN}":* ]] \
        || fail "${step}: the bot server's PATH '${server_path}' does not start with the tmux shim's ${SCENARIO_TMUX_SHIM_BIN}"
    [[ -n "$(awk -F'\t' -v p="${SERVER_PID}" '$1 == "proc" && $2 == "server" && $3 == p' "${SCENARIO_CSCB_RECORD}")" ]] \
        || fail "${step}: the record holds no server entry for the bot server ${SERVER_PID}"

    # The approver answered the dialog through agent-director: a send-keys
    # whose parent is the bot server.
    mapfile -t lines < <(cscb_ad_calls send-keys "${LIVE_INSTANCE_ID}")
    (( ${#lines[@]} >= 1 )) || fail "${step}: no send-keys for ${LIVE_INSTANCE_ID} whose parent is a CSCB process"
    for line in "${lines[@]}"; do
        read_call "${step}" "${line}"
        [[ "${CALL_PPID}" == "${SERVER_PID}" ]] || fail "${step}: a send-keys for ${LIVE_INSTANCE_ID} has parent ${CALL_PPID}, not the bot server ${SERVER_PID}"
    done
    # No harness call is counted as CSCB's.
    mapfile -t lines < <(cscb_ad_calls "")
    (( ${#lines[@]} >= 1 )) || fail "${step}: cscb_ad_calls printed no call of the bot server"
    for line in "${lines[@]}"; do
        read_call "${step}" "${line}"
        [[ "${CALL_PPID}" != "$$" ]] || fail "${step}: cscb_ad_calls printed a harness call: ${line}"
    done

    # No tmux line has the bot server as its parent.
    n="$(awk -F'\t' -v p="${SERVER_PID}" '$1 == "call" && $4 == p { n++ } END { print n + 0 }' "${SCENARIO_TMUX_SHIM_LOG}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} tmux line(s) have the bot server ${SERVER_PID} as their parent"

    # The closing assertions pass over this start's own lines, and both
    # positive controls fail over the lines from before it.
    window_copy "${SCENARIO_ROOT}/window-live" "$(( tmux_before + 1 ))" "${tmux_after}" "$(( ad_before + 1 ))" "${ad_after}"
    expect_on_files "${step}: its own lines" "${SCENARIO_ROOT}/window-live" pass assert_no_server_tmux
    expect_on_files "${step}: its own lines" "${SCENARIO_ROOT}/window-live" pass assert_no_cscb_include_finished
    expect_on_files "${step}: its own lines" "${SCENARIO_ROOT}/window-live" pass assert_no_cscb_delete
    window_copy "${SCENARIO_ROOT}/window-before" 1 "${tmux_before}" 1 "${ad_before}"
    expect_on_files "${step}: the lines before it" "${SCENARIO_ROOT}/window-before" fail assert_no_server_tmux "positive control"
    expect_on_files "${step}: the lines before it" "${SCENARIO_ROOT}/window-before" fail assert_no_cscb_include_finished "positive control"

    stop_server --stop-bots
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

leg_mcp_session() {
    local step="MCP session" creds work config_dir ref connected session stub_pid client_pid s0 verb t_conn conn_line
    local disconnected window="${SCENARIO_ROOT}/mcp-session-window.log" hits
    local -A before=()
    creds="${SCENARIO_ROOT}/credentials-mcp"
    mkdir -m 700 "${creds}"
    config_dir="${SCENARIO_ROOT}/claude-config-mcp"
    mkdir -p "${config_dir}"
    work="$(make_workdir mcp)"
    ref="$(persona_ref "${MCP_NAME}")"
    connected="$(matcher "[slack] Session connected: persona ${ref}")"
    disconnected="$(matcher "[slack] Session disconnected" ": persona ${ref}")"

    # A state directory of its own: a start runs the last-applied record of
    # its state directory, so the live start's settings would hold there.
    new_state_dir mcp-session
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-mcp" mcpv1
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot mcpv1)" "$(fake_token app mcpv1)" \
        | write_file "${creds}/mcp.json" 600
    write_config << EOF
{
  "personas": [
    {
      "name": "${MCP_NAME}",
      "credentials_file": "${creds}/mcp.json",
      "working_directory": "${work}",
      "claude_config_dir": "${config_dir}",
      "channels": [{ "id": "C0T0MCP01", "delivery": "all" }],
      "permission_prompts": "C0T0MCP01"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": ${MCP_TICK_S},
  "session_restart_delay": ${MCP_RESTART_DELAY_S},
  "exit_timeout": 5
}
EOF

    start_server --live
    wait_for_log "$(completion_match 1)" "${LIVE_START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    wait_until "${LIVE_REPORT_WAIT_S}" "${step}: row ${MCP_INSTANCE_ID} never reported in (waiting)" \
        row_state_is "${MCP_INSTANCE_ID}" waiting
    # The stub opened its session once it reported in, and the server
    # registered it as the persona's.
    wait_for_log "${connected}" "${MCP_CONNECT_WAIT_S}" "${step}: the server never registered the stub's session as ${ref}'s"
    ad_capture get --claude-instance-id "${MCP_INSTANCE_ID}"
    session="$(jq -r '.tmux_session_name // empty' "${AD_OUT}")"
    [[ -n "${session}" ]] || fail "${step}: row ${MCP_INSTANCE_ID} names no tmux session"
    stub_pid="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${session}" '#{pane_pid}')" \
        || fail "${step}: no pane for session ${session}"
    stub_running "${stub_pid}" || fail "${step}: the pane's process ${stub_pid} is not the stub"
    client_pid="$(pgrep -P "${stub_pid}" -f stub-mcp-session.ts || true)"
    [[ "${client_pid}" =~ ^[0-9]+$ ]] || fail "${step}: the stub ${stub_pid} has no single MCP session client child ('${client_pid}')"

    # Health ticks: at least MCP_TICKS more liveness reads of the row by the
    # bot server, over at least MCP_TICKS tick intervals, with the persona
    # connected throughout: no reconnect, relaunch or not-connected line in
    # the server's log, and no send-keys, spawn, resume or kill of the row by
    # a CSCB process.
    t_conn="$(now_s)"
    s0="$(cscb_ad_count status "${MCP_INSTANCE_ID}")"
    for verb in send-keys spawn resume kill; do
        before["${verb}"]="$(cscb_ad_count "${verb}" "${MCP_INSTANCE_ID}")"
    done
    conn_line="$(first_log_line "${connected}")"
    wait_until "${MCP_TICKS_WAIT_S}" "${step}: fewer than ${MCP_TICKS} health ticks read ${MCP_INSTANCE_ID} after it connected" \
        mcp_ticks_or_trouble "${MCP_INSTANCE_ID}" "$(( s0 + MCP_TICKS ))" "${conn_line}"
    sleep_until "$(seconds_plus "${t_conn}" "$(( MCP_TICKS * MCP_TICK_S ))")"
    echo "${TEST_NAME}: ${step}: $(( $(cscb_ad_count status "${MCP_INSTANCE_ID}") - s0 )) status read(s) of ${MCP_INSTANCE_ID} by the server in $(seconds_between "${t_conn}" "$(now_s)")s after it connected"
    tail -n "+$(( conn_line + 1 ))" "${SLACK_STATE_DIR}/server.log" > "${window}"
    hits="$(grep -iE "${MCP_TROUBLE}" "${window}" || true)"
    if [[ -n "${hits}" ]]; then
        sed 's/^/  | /' <<< "${hits}" >&2
        fail "${step}: the server logged a reconnect, relaunch or not-connected line for a connected persona"
    fi
    for verb in send-keys spawn resume kill; do
        [[ "$(cscb_ad_count "${verb}" "${MCP_INSTANCE_ID}")" == "${before[${verb}]}" ]] \
            || fail "${step}: a CSCB process ran ${verb} for ${MCP_INSTANCE_ID} while it was connected"
    done
    expect_row_state "${step}" "${MCP_INSTANCE_ID}" waiting
    expect_interject "${MCP_NAME}" 200 "${step}: with the stub's session held"

    # The stub ends (the sentinel): its session ends with it, and the
    # persona reads not connected.
    "${SCENARIO_REAL_TMUX}" send-keys -t "${session}" __CSCB_TEST_EXIT__ Enter \
        || fail "${step}: could not send the sentinel into ${session}"
    wait_for_log "${disconnected}" "${MCP_END_WAIT_S}" "${step}: the server never saw ${ref}'s session end"
    wait_until 10 "${step}: the stub ${stub_pid} still runs after the sentinel" _scenario_pid_gone "${stub_pid}"
    wait_until 10 "${step}: the MCP session client ${client_pid} outlived the stub" _scenario_pid_gone "${client_pid}"
    expect_interject "${MCP_NAME}" 503 "${step}: after the stub ended"

    stop_server --stop-bots
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

# True when CSCB processes made at least <n> <verb> calls naming <instance-id>.
cscb_count_at_least() {
    (( $(cscb_ad_count "$1" "$2") >= $3 ))
}

# mcp_ticks_or_trouble <instance-id> <n> <line>: true when CSCB processes made
# at least <n> status calls naming <instance-id>, or when the server's log
# holds, after its line <line>, a line MCP_TROUBLE matches (so the leg names
# that line rather than the ticks it waited for).
mcp_ticks_or_trouble() {
    tail -n "+$(( $3 + 1 ))" "${SLACK_STATE_DIR}/server.log" | grep -iE "${MCP_TROUBLE}" > /dev/null \
        || cscb_count_at_least status "$1" "$2"
}

# The stub run directly from the scenario's shell (no tmux, no
# agent-director), with hooks that each touch a marker file.
leg_stub_direct() {
    local step="stub direct" dir out="${SCENARIO_ROOT}/stub-direct.out" err="${SCENARIO_ROOT}/stub-direct.err"
    local mark="${SCENARIO_ROOT}/stub-direct-mark" settings got rc=0 before words=() want=()
    local fixture="${SCENARIO_FIXTURES}/../../fixtures/dev-channels-pane-2.1.120.txt"
    settings="$(jq -nc --arg m "${mark}" '{hooks: {
        SessionStart: [{hooks: [{type: "command", command: "/usr/bin/touch", args: [($m + ".start")]}]}],
        SessionEnd: [{hooks: [{type: "command", command: "/usr/bin/touch", args: [($m + ".end")]}]}]}}')"

    got="$("${SCENARIO_BIN}/claude" --version)" || fail "${step}: claude --version exited non-zero"
    [[ "${got}" == "2.1.280 (Claude Code)" ]] || fail "${step}: claude --version printed '${got}'"

    # A directory with no selection: the dev-channels dialog, byte for byte.
    dir="$(make_workdir stub-default)"
    (cd "${dir}" && "${SCENARIO_BIN}/claude" < /dev/null) > "${out}" 2> "${err}" || rc=$?
    (( rc == 0 )) || fail "${step}: the stub in a directory with no selection exited ${rc}"
    cmp -s -- "${fixture}" "${out}" || fail "${step}: with no selection the stub's output is not ${fixture##*/}, byte for byte"
    [[ ! -s "${err}" ]] || fail "${step}: with no selection the stub wrote to standard error: $(head -c 300 "${err}")"

    # Silent: no output, no SessionStart, and the sentinel fires no SessionEnd.
    dir="$(make_workdir stub-silent)"
    stub_mode "${dir}" "${STUB_MODE_SILENT}"
    (cd "${dir}" && printf 'hello\n__CSCB_TEST_EXIT__\n' | "${SCENARIO_BIN}/claude" --settings "${settings}") \
        > "${out}" 2> "${err}" || rc=$?
    (( rc == 0 )) || fail "${step}: the silent stub exited ${rc}"
    [[ ! -s "${out}" && ! -s "${err}" ]] || fail "${step}: the silent stub printed: $(head -c 300 "${out}" "${err}")"
    [[ ! -e "${mark}.start" && ! -e "${mark}.end" ]] || fail "${step}: the silent stub fired a hook"

    # At once, with no AGENT_DIRECTOR_INSTANCE_ID and hooks naming a binary
    # with no shim log beside it: it reports in and fires SessionStart, its
    # first tick writes the one stop line to standard error, and the sentinel
    # fires SessionEnd.
    dir="$(make_workdir stub-no-id)"
    stub_mode "${dir}" "${STUB_MODE_AT_ONCE}"
    before="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
    (cd "${dir}" && { sleep "$(seconds_plus "${REFIRE_PERIOD_S}" 1.5)"; echo __CSCB_TEST_EXIT__; } \
        | env -u AGENT_DIRECTOR_INSTANCE_ID "${SCENARIO_BIN}/claude" --settings "${settings}") > "${out}" 2> "${err}" || rc=$?
    (( rc == 0 )) || fail "${step}: the at-once stub exited ${rc}"
    grep -qxF "Listening for channel messages from: server:slack-channel-router" "${out}" \
        || fail "${step}: the at-once stub printed no banner: $(head -c 300 "${out}")"
    [[ -e "${mark}.start" && -e "${mark}.end" ]] || fail "${step}: the at-once stub did not fire SessionStart and SessionEnd"
    [[ "$(line_count "${err}")" == 1 ]] || fail "${step}: standard error holds $(line_count "${err}") line(s), not one stop line"
    _scenario_split_line "$(cat "${err}")" && [[ "${_L_KIND}" == stop ]] \
        || fail "${step}: standard error's line is not a stop line in the shim log's format: $(head -c 300 "${err}")"
    _scenario_eval_words words "${_L_RAW_WORDS}" || fail "${step}: the stop line's words do not parse"
    want=(stub-claude stopped re-firing SessionStart for instance -: AGENT_DIRECTOR_INSTANCE_ID is unset or empty)
    same_words words want || fail "${step}: the stop line's words are $(quoted "${words[@]}"), not $(quoted "${want[@]}")"
    [[ "$(line_count "${SCENARIO_AD_SHIM_LOG}")" == "${before}" ]] || fail "${step}: the stub wrote to the shim log"
}

# The stub helpers' own refusals, the mode selection file and the MCP config.
leg_stub_helpers() {
    local step="stub helpers" dir link file got
    dir="$(make_workdir stub-select)"
    expect_fails_in_home "${step}" "${HOME}" "unknown mode 'bogus'" stub_mode "${dir}" bogus
    expect_fails_in_home "${step}" "${HOME}" "refused: /tmp is not under SCENARIO_ROOT" stub_mode /tmp "${STUB_MODE_AT_ONCE}"
    link="${SCENARIO_ROOT}/work/stub-select-outside"
    ln -s /tmp "${link}"
    expect_fails_in_home "${step}" "${HOME}" "refused: ${link} resolves to" stub_mode "${link}" "${STUB_MODE_AT_ONCE}"
    expect_fails_in_home "${step}" "${HOME}" "is not a directory" stub_mode "${dir}/none" "${STUB_MODE_AT_ONCE}"
    # The last selection of a directory wins.
    stub_mode "${dir}" "${STUB_MODE_SILENT}"
    stub_mode "${dir}" "${STUB_MODE_AT_ONCE}"
    file="${SCENARIO_BIN}/stub-claude-modes"
    [[ "$(tail -n 1 "${file}")" == "${STUB_MODE_AT_ONCE}"$'\t'"$(realpath -e -- "${dir}")" ]] \
        || fail "${step}: the selection file's last line is '$(tail -n 1 "${file}")'"
    got="$(cd "${dir}" && printf '__CSCB_TEST_EXIT__\n' | "${SCENARIO_BIN}/claude")" \
        || fail "${step}: the stub in ${dir} exited non-zero"
    [[ "${got}" == "Listening for channel messages from: server:slack-channel-router" ]] \
        || fail "${step}: after silent then at-once, the stub printed '${got}', not the at-once banner"

    expect_fails_in_home "${step}" "${HOME}" "tmux send-keys exited" stub_press_enter t0-no-such-pane
    expect_fails_in_home "${step}" "${HOME}" "refused: TMUX is set" with_tmux_set stub_press_enter "${T0_SESSION}"
    expect_fails_in_home "${step}" "${HOME}" "refused: TMUX_TMPDIR '/tmp' is not the scenario's" \
        with_tmux_tmpdir /tmp stub_press_enter "${T0_SESSION}"
    press_enter_exact "${step}"

    expect_fails_in_home "${step}" "${HOME}" "holds a character other than letters, digits and ._:@-" \
        ad_store_pending_no_launch "t0 bad'id"
    expect_fails_in_home "${step}" "${HOME}" "no row has instance id t0-no-such-row" \
        ad_store_pending_no_launch t0-no-such-row

    expect_fails_in_home "${step}" "${HOME}" "'0' is not a port" write_mcp_config 0
    file="${HOME}/.claude/slack-mcp.json"
    got="$(jq -r --arg n "${SCENARIO_MCP_SERVER_NAME}" '.mcpServers[$n] | "\(.type) \(.url)"' "${file}")" \
        || fail "${step}: ${file} is not JSON"
    [[ "${got}" == "http http://127.0.0.1:${SCENARIO_PORT}/mcp" ]] \
        || fail "${step}: ${file} names '${got}', not the scenario's port ${SCENARIO_PORT}"
}

# press_enter_exact <step>: `stub_press_enter` matches a session name exactly.
# A session whose name only starts with the target (as written, or with a
# window part) gets no Enter, and the call fails with tmux's answer; the full
# name, the full name with a window part and the pane id each deliver one.
press_enter_exact() {
    local step="$1: exact target" session="t0-press-exact-long" prefix="t0-press-exact" pane n target
    ! has_session "${prefix}" || fail "${step}: a session named ${prefix} already exists"
    "${SCENARIO_REAL_TMUX}" new-session -d -s "${session}" -x 200 -y 50 -- \
        bash -c 'n=0; while read -r _; do n=$((n + 1)); echo "pressed ${n}"; done; sleep 600' \
        || fail "${step}: could not make ${session}"
    pane="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{pane_id}')" \
        || fail "${step}: no pane for ${session}"
    expect_fails_in_home "${step}" "${HOME}" "tmux send-keys exited" stub_press_enter "${prefix}"
    expect_fails_in_home "${step}" "${HOME}" "tmux send-keys exited" stub_press_enter "${prefix}:"
    sleep 0.5
    ! pane_shows "=${session}:" "pressed" || fail "${step}: a prefix of ${session} sent it an Enter"
    n=0
    for target in "${session}" "${session}:" "${pane}"; do
        n=$((n + 1))
        stub_press_enter "${target}"
        wait_until 5 "${step}: '${target}' sent ${session} no Enter" pane_shows "=${session}:" "pressed ${n}"
    done
    "${SCENARIO_REAL_TMUX}" kill-session -t "=${session}" || fail "${step}: could not end ${session}"
}

# with_tmux_set <command> [<arg>...]: run <command> with TMUX set (in the
# caller's subshell).
with_tmux_set() {
    export TMUX=/tmp/t0-other-tmux,1,0
    "$@"
}

# with_tmux_tmpdir <dir> <command> [<arg>...]: run <command> with TMUX_TMPDIR
# <dir> (in the caller's subshell).
with_tmux_tmpdir() {
    export TMUX_TMPDIR="$1"
    shift
    "$@"
}

leg_refire_hold() {
    local step="re-fire hold" times=() bin
    [[ ! -e "${HOME}/.agent-director/config.toml" ]] \
        || fail "${step}: ${HOME}/.agent-director/config.toml exists, so G may not be the default ${REFIRE_GRACE_S}s"
    REFIRE_AD_BEFORE="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
    REFIRE_CSCB_BEFORE="$(cscb_ad_count "")"
    hold_row "${step}" "${REFIRE_ID}" refire-held
    REFIRE_SILENT_PID="${HELD_PID}"
    REFIRE_LS="${HELD_LS}"
    REFIRE_LAUNCH="${HELD_LAUNCH}"
    REFIRE_SETTINGS="${HELD_SETTINGS}"
    # The worker's hooks are exec form and name the real binary, beside the
    # shim's log, where the stub writes its stop lines.
    bin="$(jq -r '.hooks.SessionStart[0].hooks[0].command // empty' <<< "${REFIRE_SETTINGS}")"
    jq -e '.hooks.SessionStart[0].hooks[0].args | type == "array"' <<< "${REFIRE_SETTINGS}" > /dev/null \
        || fail "${step}: the worker's SessionStart hook is not exec form (no args)"
    [[ "${bin%/*}" == "${SCENARIO_AD_SHIM_LOG%/*}" ]] \
        || fail "${step}: the SessionStart hook names ${bin}, not a binary beside the shim log ${SCENARIO_AD_SHIM_LOG}"

    # The silent worker prints nothing and fires nothing, for longer than a
    # period.
    sleep "$(seconds_plus "${REFIRE_PERIOD_S}" 0.5)"
    [[ -z "$("${SCENARIO_REAL_TMUX}" capture-pane -p -t "${REFIRE_ID}" | tr -d '[:space:]')" ]] \
        || fail "${step}: the silent worker's pane shows output"
    trail_read times "${TRAIL_FIRED_FOR} or ${TRAIL_IGNORED_FOR}" --arg id "${REFIRE_ID}"
    (( ${#times[@]} == 0 )) || fail "${step}: the trail holds ${#times[@]} SessionStart record(s) for ${REFIRE_ID} before any reporting stub"
    expect_row_state "${step}" "${REFIRE_ID}" pending
}

leg_refire_at_once() {
    refire_dir at-once "${STUB_MODE_AT_ONCE}"
    refire_start at-once
    expect_reported_at_once at-once
}

leg_refire_trusted_config_dir() {
    local cfg="${SCENARIO_ROOT}/refire-claude-config"
    refire_dir trusted-config-dir "${STUB_MODE_FOLDER_TRUST}"
    mkdir -p "${cfg}"
    jq -n --arg d "${REFIRE_DIR}" '{projects: {($d): {hasTrustDialogAccepted: true}}}' | write_file "${cfg}/.claude.json"
    refire_start trusted-config-dir "CLAUDE_CONFIG_DIR=${cfg}"
    expect_reported_at_once trusted-config-dir
}

leg_refire_trusted_home() {
    local step="re-fire trusted-home" file="${HOME}/.claude.json" pid
    refire_dir trusted-home "${STUB_MODE_FOLDER_TRUST}"
    if [[ -f "${file}" ]]; then
        jq --arg d "${REFIRE_DIR}" '.projects[$d].hasTrustDialogAccepted = true' "${file}" | write_file "${file}"
    else
        jq -n --arg d "${REFIRE_DIR}" '{projects: {($d): {hasTrustDialogAccepted: true}}}' | write_file "${file}"
    fi
    refire_start trusted-home
    pid="${REFIRE_PID[trusted-home]}"
    ! tr '\0' '\n' < "/proc/${pid}/environ" | grep '^CLAUDE_CONFIG_DIR=' > /dev/null \
        || fail "${step}: the stub ${pid} has CLAUDE_CONFIG_DIR in its environment"
    expect_reported_at_once trusted-home
}

leg_refire_dev_channels() {
    refire_enter_leg dev-channels "${STUB_MODE_DEV_CHANNELS}" "I am using this for local development"
}

leg_refire_unrecognised() {
    local step="re-fire unrecognised" session="t0-refire-unrecognised"
    refire_enter_leg unrecognised "${STUB_MODE_UNRECOGNISED}" "Choose the text style that looks best with your terminal"
    ! pane_shows "${session}" "I am using this for local development" && ! pane_shows "${session}" "Yes, I trust this folder" \
        || fail "${step}: the unrecognised dialog holds an approver's needle"
}

leg_refire_folder_trust() {
    refire_enter_leg folder-trust "${STUB_MODE_FOLDER_TRUST}" "Yes, I trust this folder"
}

leg_stop_status_failure() {
    local step="stop: the status read fails" dir pid times=()
    ad_capture status --claude-instance-id "${NOROW_ID}"
    (( AD_RC != 0 )) || fail "${step}: a harness status read of ${NOROW_ID} succeeded: a row has that id"
    dir="$(make_workdir refire-no-row)"
    stub_mode "${dir}" "${STUB_MODE_AT_ONCE}"
    refire_stub "${step}" t0-stop-no-row "${dir}" "${NOROW_ID}" "${REFIRE_SETTINGS}"
    pid="${STUB_PID}"
    wait_until 15 "${step}: no stop line names ${NOROW_ID}" has_stop_line "${NOROW_ID}"
    sleep "${REFIRE_QUIET_S}"
    expect_one_stop_line "${step}" "${NOROW_ID}" "${pid}"
    (( ${#STOP_WHY[@]} == 5 )) && [[ "${STOP_WHY[*]:0:4}" == "the status read exited" && "${STOP_WHY[4]}" =~ ^[1-9][0-9]*$ ]] \
        || fail "${step}: the stop line's reason is $(quoted "${STOP_WHY[@]}"), not 'the status read exited <n>'"
    # Its report-in fired SessionStart once; nothing after.
    trail_read times "${TRAIL_FIRED_FOR}" --arg id "${NOROW_ID}"
    (( ${#times[@]} == 1 )) || fail "${step}: ${#times[@]} SessionStart record(s) for ${NOROW_ID}, not the report-in's one"
    expect_none_after "${step}" "a SessionStart record for ${NOROW_ID}" "${STOP_T}" "${times[@]}"
    pid_alive "${pid}" || fail "${step}: the stub ended: it did not stop re-firing on its own"
}

leg_stop_no_launch_start() {
    local step="stop: no launch start" dir pid times=() n
    hold_row "${step}" "${NOLS_ID}" refire-nols-held
    dir="$(make_workdir refire-nols)"
    stub_mode "${dir}" "${STUB_MODE_AT_ONCE}"
    refire_stub "${step}" t0-stop-nols "${dir}" "${NOLS_ID}" "${HELD_SETTINGS}"
    pid="${STUB_PID}"
    # It re-fires while the row reads pending with its launch start.
    wait_until 15 "${step}: the stub never re-fired for ${NOLS_ID}" records_from_at_least "${pid}" 2
    ! has_stop_line "${NOLS_ID}" || fail "${step}: a stop line names ${NOLS_ID} before the edit"
    ad_store_pending_no_launch "${NOLS_ID}"
    wait_until 10 "${step}: no stop line names ${NOLS_ID} after the edit" has_stop_line "${NOLS_ID}"
    sleep "${REFIRE_QUIET_S}"
    expect_one_stop_line "${step}" "${NOLS_ID}" "${pid}"
    [[ "${STOP_WHY[*]}" == "the row reads pending with no launch start" ]] \
        || fail "${step}: the stop line's reason is $(quoted "${STOP_WHY[@]}"), not 'the row reads pending with no launch start'"
    trail_read times "${TRAIL_IGNORED_FROM}" --argjson p "${pid}"
    n="${#times[@]}"
    (( n >= 2 )) || fail "${step}: ${n} SessionStart record(s) from the stub, not its report-in and a re-fire"
    expect_none_after "${step}" "a SessionStart record from the stub ${pid}" "${STOP_T}" "${times[@]}"
    trail_read times "${TRAIL_FIRED_FOR}" --arg id "${NOLS_ID}"
    (( ${#times[@]} == n )) || fail "${step}: ${#times[@]} SessionStart record(s) for ${NOLS_ID}, not the stub's ${n}"
    pid_alive "${pid}" || fail "${step}: the stub ended: it did not stop re-firing on its own"
}

leg_refire_grace() {
    local step="re-fire until G" path pid times=() fired=() n first last g_end gap at_settle
    local -A settled=()
    g_end="$(seconds_plus "${REFIRE_LS}" "${REFIRE_GRACE_S}")"
    sleep_until "$(seconds_plus "${g_end}" "${REFIRE_SETTLE_S}")"
    for path in "${REFIRE_PATHS[@]}"; do
        settled["${path}"]="$(records_from "${REFIRE_PID[${path}]}")"
    done
    sleep "${REFIRE_QUIET_S}"

    for path in "${REFIRE_PATHS[@]}"; do
        pid="${REFIRE_PID[${path}]}"
        trail_read times "${TRAIL_IGNORED_FROM}" --argjson p "${pid}"
        n="${#times[@]}"
        (( n >= 3 )) || fail "${step}: ${path}: ${n} SessionStart record(s) from the stub ${pid}"
        first="${times[0]}"
        last="${times[n - 1]}"
        # Its first record at its report-in: after its start (or Enter), soon.
        ! time_before "${first}" "$(seconds_plus "${REFIRE_FROM[${path}]}" -0.01)" \
            && time_before "${first}" "$(seconds_plus "${REFIRE_FROM[${path}]}" "${REFIRE_FIRST_S}")" \
            || fail "${step}: ${path}: its first record at ${first} is not within ${REFIRE_FIRST_S}s after ${REFIRE_FROM[${path}]}"
        # Then one about every REFIRE_PERIOD_S, up to G and not after.
        gap="$(refire_gap_out "${times[@]}")"
        [[ -z "${gap}" ]] || fail "${step}: ${path}: two records ${gap} apart, not about ${REFIRE_PERIOD_S}s"
        ! time_before "${last}" "$(seconds_plus "${g_end}" "-${REFIRE_GAP_MAX_S}")" \
            || fail "${step}: ${path}: its last record at ${last} is more than ${REFIRE_GAP_MAX_S}s before G (${g_end})"
        expect_none_after "${step}" "${path}: a record" "$(seconds_plus "${g_end}" "${REFIRE_HOOK_S}")" "${times[@]}"
        [[ "${n}" == "${settled[${path}]}" ]] \
            || fail "${step}: ${path}: ${settled[${path}]} record(s) ${REFIRE_SETTLE_S}s after G, ${n} ${REFIRE_QUIET_S}s later"
        # Every one ignored as pid_mismatch against the silent worker's pane.
        trail_read times "${TRAIL_NOT_MISMATCH}" --argjson p "${pid}" --argjson pane "${REFIRE_SILENT_PID}"
        (( ${#times[@]} == 0 )) \
            || fail "${step}: ${path}: ${#times[@]} record(s) not pid_mismatch against the worker ${REFIRE_SILENT_PID}"
        pid_alive "${pid}" || fail "${step}: ${path}: the stub ${pid} ended before G"
        echo "${TEST_NAME}: ${step}: ${path}: ${n} records from ${first} to ${last} (G ends ${g_end})"
    done

    # The silent worker fired nothing: every SessionStart for the row was a
    # reporting stub's, ignored; and the row still reads pending, its launch
    # start unchanged, with no stop line for it.
    trail_read times "${TRAIL_IGNORED_FROM}" --argjson p "${REFIRE_SILENT_PID}"
    (( ${#times[@]} == 0 )) || fail "${step}: the silent worker ${REFIRE_SILENT_PID} fired SessionStart"
    trail_read fired "${TRAIL_FIRED_FOR}" --arg id "${REFIRE_ID}"
    trail_read times "${TRAIL_IGNORED_FOR}" --arg id "${REFIRE_ID}"
    (( ${#fired[@]} == ${#times[@]} )) \
        || fail "${step}: ${#fired[@]} SessionStart fired for ${REFIRE_ID}, but ${#times[@]} ignored: one was applied"
    ad_capture status --claude-instance-id "${REFIRE_ID}"
    [[ "$(jq -r '.state // empty' "${AD_OUT}")" == pending && "$(jq -r '.launch_started_at // empty' "${AD_OUT}")" == "${REFIRE_LAUNCH}" ]] \
        || fail "${step}: ${REFIRE_ID} reads $(tr '\n' ' ' < "${AD_OUT}"), not pending with launch start ${REFIRE_LAUNCH}"
    [[ -z "$(stop_lines_for "${REFIRE_ID}")" ]] || fail "${step}: a stop line names ${REFIRE_ID}: the stop past G wrote one"
    pid_alive "${REFIRE_SILENT_PID}" || fail "${step}: the silent worker ${REFIRE_SILENT_PID} ended"

    for path in "${REFIRE_PATHS[@]/#/t0-refire-}" t0-stop-no-row t0-stop-nols; do
        "${SCENARIO_REAL_TMUX}" kill-session -t "=${path}" || fail "${step}: could not kill ${path}"
    done
}

leg_stub_lines_not_cscb() {
    local step="stub lines not CSCB's" dir="${SCENARIO_ROOT}/window-stubs" ad_after line n stops=0 mine=() got
    ad_after="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
    window_copy "${dir}" 1 0 "$(( REFIRE_AD_BEFORE + 1 ))" "${ad_after}"
    # The window holds the two stop legs' stop lines and the harness's own
    # calls, all in the shim log's format.
    mapfile -d '' -t mine < "/proc/$$/cmdline"
    while IFS= read -r line; do
        _scenario_split_line "${line}" || fail "${step}: a shim log line is not in its format: ${line}"
        case "${_L_KIND}" in
            stop) stops=$(( stops + 1 )) ;;
            call)
                read_call "${step}" "${line}"
                same_words CALL_PARENT mine || fail "${step}: a call line whose parent is not the scenario's shell: ${line:0:200}…"
                ;;
            *) fail "${step}: a shim log line of kind '${_L_KIND}': ${line}" ;;
        esac
    done < "${dir}/agent-director-shim.log"
    (( stops == 2 )) || fail "${step}: ${stops} stop line(s) since the hold, not the two stop legs'"
    # No count helper counts a stub's line.
    n="$(on_files "${dir}" cscb_ad_count "")" || fail "${step}: cscb_ad_count failed on the window"
    [[ "${n}" == 0 ]] || fail "${step}: cscb_ad_count counts ${n} line(s) of the window"
    got="$(on_files "${dir}" cscb_ad_calls "")" || fail "${step}: cscb_ad_calls failed on the window"
    [[ -z "${got}" ]] || fail "${step}: cscb_ad_calls prints a line of the window: ${got}"
    [[ "$(cscb_ad_count "")" == "${REFIRE_CSCB_BEFORE}" ]] \
        || fail "${step}: cscb_ad_count changed from ${REFIRE_CSCB_BEFORE} to $(cscb_ad_count "") with no CSCB process running"
    # The closing assertions pass over the whole record, stop lines included.
    window_copy "${dir}-all" 1 "$(line_count "${SCENARIO_TMUX_SHIM_LOG}")" 1 "${ad_after}"
    expect_on_files "${step}" "${dir}-all" pass assert_no_server_tmux
    expect_on_files "${step}" "${dir}-all" pass assert_no_cscb_include_finished
    expect_on_files "${step}" "${dir}-all" pass assert_no_cscb_delete
}

leg_harness_include_finished() {
    local step="harness include-finished" before i mine=() lines=()
    before="$(call_count)"
    ad kill --claude-instance-id "${T0_ROW_ID}" --include-finished > /dev/null 2>&1 || true
    : "$(ad kill --claude-instance-id "${T0_ROW_ID}" --include-finished 2>&1)"
    ad kill --claude-instance-id "${T0_ROW_ID}" --include-finished 2>&1 | cat > /dev/null || true
    mapfile -t lines < <(awk -F'\t' '$1 == "call"' "${SCENARIO_AD_SHIM_LOG}" | tail -n "+$(( before + 1 ))")
    (( ${#lines[@]} == 3 )) || fail "${step}: the three calls added ${#lines[@]} call line(s)"
    mapfile -d '' -t mine < "/proc/$$/cmdline"
    for i in 0 1 2; do
        read_call "${step}" "${lines[i]}"
        [[ "${CALL_WORDS[0]:-}" == kill && " ${CALL_WORDS[*]} " == *" --include-finished "* ]] \
            || fail "${step}: call $(( i + 1 ))'s words are $(quoted "${CALL_WORDS[@]}")"
        same_words CALL_PARENT mine \
            || fail "${step}: call $(( i + 1 ))'s parent $(quoted "${CALL_PARENT[@]}") does not have the shell's command line"
        if (( i == 0 )); then
            [[ "${CALL_PPID}" == "$$" ]] || fail "${step}: the plain call's parent is ${CALL_PPID}, not the shell $$"
        else
            [[ "${CALL_PPID}" != "$$" ]] || fail "${step}: call $(( i + 1 )) (a subshell's) has the shell $$ itself as its parent"
        fi
    done
    ( assert_no_cscb_include_finished ) > "${SCENARIO_ROOT}/harness-include-finished.out" 2>&1 || {
        sed 's/^/  | /' "${SCENARIO_ROOT}/harness-include-finished.out" >&2
        fail "${step}: assert_no_cscb_include_finished failed with the harness's calls in the log"
    }
}

leg_synthetic_server_tmux() {
    local step="synthetic assert_no_server_tmux" dir a="assert_no_server_tmux"
    dir="$(syn_case server-tmux-clean)"
    expect_on_files "${step}: clean" "${dir}" pass "${a}"

    dir="$(syn_case server-tmux-violation)"
    syn_line "${dir}/tmux-shim.log" call 1500.000000 7000002 "${SYN_SERVER}" "${SYN_SERVER_CMD}" list-sessions
    expect_on_files "${step}: a bot server's tmux call" "${dir}" fail "${a}" \
        "1 tmux-shim.log line(s) have a bot server the scenario started as their parent (line 2)"

    # The server's PID, given to another process after the server was gone.
    dir="$(syn_case server-tmux-reused-pid)"
    syn_line "${dir}/tmux-shim.log" call 3000.000000 7000002 "${SYN_SERVER}" "${SYN_SERVER_CMD}" list-sessions
    expect_on_files "${step}: the server's PID reused after it was gone" "${dir}" pass "${a}"

    dir="$(syn_case server-tmux-empty)"
    : > "${dir}/tmux-shim.log"
    expect_on_files "${step}: an empty tmux log" "${dir}" fail "${a}" "positive control"

    # Only a harness spawn's tmux call: its agent-director's parent is no CSCB process.
    dir="$(syn_case server-tmux-harness-only)"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/agent-director-shim.log" call 1300.000000 6000010 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" \
        spawn --claude-instance-id t0-h
    syn_line "${dir}/tmux-shim.log" call 1300.100000 7000003 6000010 "${SYN_AD_CMD}" new-session -d -s t0-h
    expect_on_files "${step}: only the harness's agent-director" "${dir}" fail "${a}" "positive control"

    # The CSCB-run agent-director's PID, but the parent is not agent-director.
    dir="$(syn_case server-tmux-parent-not-ad)"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/tmux-shim.log" call 1002.100000 7000001 6000002 'bash -c x' new-session -d -s slack_bot_alpha
    expect_on_files "${step}: a parent whose argv[0] is not agent-director" "${dir}" fail "${a}" "positive control"

    # A parent field that does not parse never counts, and (in this subshell)
    # still ends in the assertion's own FAIL line.
    dir="$(syn_case server-tmux-parent-unparsed)"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/tmux-shim.log" call 1002.100000 7000001 6000002 "'unterminated" new-session -d -s slack_bot_alpha
    expect_on_files "${step}: a parent field that does not parse" "${dir}" fail "${a}" "positive control"

    # The parent PID's latest call at or before the tmux line was the
    # harness's (the PID reused), and a tmux line before any call of its PID.
    dir="$(syn_case server-tmux-latest-call)"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/agent-director-shim.log" call 1003.000000 6000020 "${SYN_SERVER}" "${SYN_SERVER_CMD}" list
    syn_line "${dir}/agent-director-shim.log" call 1004.000000 6000020 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" list
    syn_line "${dir}/tmux-shim.log" call 1004.500000 7000004 6000020 "${SYN_AD_CMD}" list-sessions
    syn_line "${dir}/tmux-shim.log" call 1001.500000 7000005 6000002 "${SYN_AD_CMD}" list-sessions
    expect_on_files "${step}: the latest call of the parent PID was the harness's" "${dir}" fail "${a}" "positive control"

    # The agent-director call's parent PID is the server's, outside its window.
    dir="$(syn_case server-tmux-outside-window)"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/agent-director-shim.log" call 3000.000000 6000030 "${SYN_SERVER}" "${SYN_SERVER_CMD}" list
    syn_line "${dir}/tmux-shim.log" call 3000.100000 7000006 6000030 "${SYN_AD_CMD}" list-sessions
    expect_on_files "${step}: a call by the server's PID outside its window" "${dir}" fail "${a}" "positive control"

    dir="$(syn_case server-tmux-format)"
    printf 'call\t1500.000000\t7000007\t6000002\tbash\n' >> "${dir}/tmux-shim.log"
    expect_on_files "${step}: a five-field line" "${dir}" fail "${a}" "tmux-shim.log line 2 is not in the shims' line format"
}

leg_synthetic_include_finished() {
    local step="synthetic assert_no_cscb_include_finished" dir got a="assert_no_cscb_include_finished"
    local why="run kill with --include-finished from a parent other than the scenario's own shell or a subshell of it"
    dir="$(syn_case finished-clean)"
    expect_on_files "${step}: clean" "${dir}" pass "${a}"

    dir="$(syn_case finished-server)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000040 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        kill --claude-instance-id cscb_alpha --include-finished
    expect_on_files "${step}: from the bot server" "${dir}" fail "${a}" "1 agent-director-shim.log line(s) ${why} (line 3)"

    dir="$(syn_case finished-run)"
    syn_line "${dir}/agent-director-shim.log" call 1150.000000 6000041 "${SYN_RUN}" "${SYN_RUN_CMD}" \
        kill --claude-instance-id cscb_alpha --include-finished
    expect_on_files "${step}: from a CSCB CLI run" "${dir}" fail "${a}" "1 agent-director-shim.log line(s) ${why} (line 3)"

    dir="$(syn_case finished-wrapper)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000042 "${SYN_OTHER}" 'timeout 10 agent-director' \
        kill --claude-instance-id cscb_alpha --include-finished
    expect_on_files "${step}: from a wrapper process" "${dir}" fail "${a}" "1 agent-director-shim.log line(s) ${why} (line 3)"

    # The shell's command line, but a PID a CSCB process held at that time.
    dir="$(syn_case finished-shell-text-cscb-pid)"
    syn_line "${dir}/agent-director-shim.log" call 1150.000000 6000043 "${SYN_RUN}" "${SCENARIO_SHELL_CMDLINE}" \
        kill --claude-instance-id cscb_alpha --include-finished
    expect_on_files "${step}: the shell's command line on a CSCB process's PID" "${dir}" fail "${a}" \
        "1 agent-director-shim.log line(s) ${why} (line 3)"

    # The flag's other spellings, and a verb after a global flag.
    dir="$(syn_case finished-spellings)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000044 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        kill -include-finished --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" call 1500.100000 6000045 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        kill --claude-instance-id cscb_alpha --include-finished=true
    syn_line "${dir}/agent-director-shim.log" call 1500.200000 6000046 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        --home /h kill --claude-instance-id cscb_alpha --include-finished
    expect_on_files "${step}: -include-finished, =true and --home before the verb" "${dir}" fail "${a}" \
        "3 agent-director-shim.log line(s) ${why} (line 3, 4, 5)"

    # Not violations: the harness from its shell, a kill without the flag, the
    # flag on another verb, the server's PID outside its window from the
    # shell's text, and a stop line.
    dir="$(syn_case finished-allowed)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000050 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" \
        kill --claude-instance-id cscb_alpha --include-finished
    syn_line "${dir}/agent-director-shim.log" call 1500.100000 6000051 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        kill --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" call 1500.200000 6000052 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        get --claude-instance-id cscb_alpha --include-finished
    syn_line "${dir}/agent-director-shim.log" call 3000.000000 6000053 "${SYN_SERVER}" "${SCENARIO_SHELL_CMDLINE}" \
        kill --claude-instance-id cscb_alpha --include-finished
    syn_line "${dir}/agent-director-shim.log" stop 1500.300000 6000054 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        stub-claude kill --include-finished
    expect_on_files "${step}: the harness, no flag, another verb, a reused PID, a stop line" "${dir}" pass "${a}"

    # No call has a bot server as its parent: the harness's, a CLI run's, and
    # the server's PID outside its window.
    dir="$(syn_case finished-no-control)"
    : > "${dir}/agent-director-shim.log"
    syn_line "${dir}/agent-director-shim.log" call 1150.000000 6000060 "${SYN_RUN}" "${SYN_RUN_CMD}" version
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000061 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" version
    syn_line "${dir}/agent-director-shim.log" call 3000.000000 6000062 "${SYN_SERVER}" "${SYN_SERVER_CMD}" version
    syn_line "${dir}/agent-director-shim.log" stop 1500.000000 6000063 "${SYN_SERVER}" "${SYN_SERVER_CMD}" stub-claude reason
    expect_on_files "${step}: no call of a bot server" "${dir}" fail "${a}" "positive control"

    dir="$(syn_case finished-format)"
    printf 'call\t1500.000000\t6000064\t%s\t%s\t%s\n' "${SYN_SERVER}" "${SYN_SERVER_CMD}" "kill 'unterminated" \
        >> "${dir}/agent-director-shim.log"
    expect_on_files "${step}: words that do not decode" "${dir}" fail "${a}" \
        "agent-director-shim.log line 3 is not in the shims' line format"
    # The same in a command substitution, as a count helper is called: its
    # FAIL line still comes out.
    got="$(on_files "${dir}" cscb_ad_count kill 2>&1)" && fail "${step}: cscb_ad_count passed words that do not decode"
    [[ "${got}" == *"FAIL: ${TEST_NAME}: cscb_ad_count: "*"agent-director-shim.log line 3 is not in the shims' line format"* ]] \
        || fail "${step}: cscb_ad_count in a command substitution failed without its FAIL line: ${got}"
}

leg_synthetic_delete() {
    local step="synthetic assert_no_cscb_delete" dir a="assert_no_cscb_delete" why="run delete from a CSCB process"
    dir="$(syn_case delete-clean)"
    expect_on_files "${step}: clean" "${dir}" pass "${a}"

    dir="$(syn_case delete-server)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000070 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        delete --claude-instance-id cscb_alpha
    expect_on_files "${step}: from the bot server" "${dir}" fail "${a}" "1 agent-director-shim.log line(s) ${why} (line 3)"

    dir="$(syn_case delete-run-and-global-flag)"
    syn_line "${dir}/agent-director-shim.log" call 1150.000000 6000071 "${SYN_RUN}" "${SYN_RUN_CMD}" \
        delete --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000072 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        --store-path=/s delete --claude-instance-id cscb_alpha
    expect_on_files "${step}: from a CLI run, and after --store-path=" "${dir}" fail "${a}" \
        "2 agent-director-shim.log line(s) ${why} (line 3, 4)"

    dir="$(syn_case delete-allowed)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000073 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" \
        delete --claude-instance-id t0-h
    syn_line "${dir}/agent-director-shim.log" call 3000.000000 6000074 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        delete --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" stop 1500.100000 6000075 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        stub-claude delete
    expect_on_files "${step}: the harness, a reused PID, a stop line" "${dir}" pass "${a}"

    dir="$(syn_case delete-format)"
    printf 'call\t1500.000000\tx\t%s\t%s\tdelete\n' "${SYN_SERVER}" "${SYN_SERVER_CMD}" >> "${dir}/agent-director-shim.log"
    expect_on_files "${step}: a PID that is not a number" "${dir}" fail "${a}" \
        "agent-director-shim.log line 3 is not in the shims' line format"
}

leg_count_helpers() {
    local step="count helpers" dir got want=()
    dir="$(syn_case counts)"
    # Base: the server's version (line 1) and spawn (line 2). Then a CLI run's
    # list (3), the harness's spawn (4), a stop line (5), the server's spawn
    # after a global flag (6), the server's PID outside its window (7).
    syn_line "${dir}/agent-director-shim.log" call 1150.000000 6000080 "${SYN_RUN}" "${SYN_RUN_CMD}" list
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000081 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" \
        spawn --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" stop 1500.100000 6000082 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        stub-claude spawn --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" call 1500.200000 6000083 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        --home /h spawn --tmux-session-name s --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" call 3000.000000 6000084 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        spawn --claude-instance-id cscb_alpha
    expect_count_on "${step}" "${dir}" 4 ""
    expect_count_on "${step}" "${dir}" 2 spawn
    expect_count_on "${step}" "${dir}" 2 spawn cscb_alpha
    expect_count_on "${step}" "${dir}" 2 spawn --claude-instance-id cscb_alpha
    expect_count_on "${step}" "${dir}" 0 spawn cscb_alpha --claude-instance-id
    expect_count_on "${step}" "${dir}" 1 list
    expect_count_on "${step}" "${dir}" 1 version
    expect_count_on "${step}" "${dir}" 0 --home
    expect_count_on "${step}" "${dir}" 0 delete
    got="$(on_files "${dir}" cscb_ad_calls spawn)" || fail "${step}: cscb_ad_calls spawn failed"
    want=("$(sed -n 2p "${dir}/agent-director-shim.log")" "$(sed -n 6p "${dir}/agent-director-shim.log")")
    [[ "${got}" == "$(printf '%s\n' "${want[@]}")" ]] \
        || fail "${step}: cscb_ad_calls spawn printed '${got}', not lines 2 and 6"
}

# expect_count_on <step> <dir> <want> <verb> [<fragment>...]: cscb_ad_count on
# <dir>'s files prints <want>.
expect_count_on() {
    local step="$1" dir="$2" want="$3" got
    shift 3
    got="$(on_files "${dir}" cscb_ad_count "$@")" || fail "${step}: cscb_ad_count $* failed"
    [[ "${got}" == "${want}" ]] || fail "${step}: cscb_ad_count $(quoted "$@") printed ${got}, not ${want}"
}

leg_closing_enforcement() {
    local step="closing enforcement" name
    name="test-0-fmk-nested-closing-pass"
    run_nested "${name}" rc nested_closing_pass nested_stand_in nested_closing
    if (( NESTED_RC != 0 )) || grep -q '^FAIL:' "${NESTED_OUT}" || ! grep -qxF "PASS: ${name}" "${NESTED_OUT}"; then
        sed 's/^/  | /' "${NESTED_OUT}" >&2
        fail "${step}: a run that ends with the closing assertions exited ${NESTED_RC}: $(grep -m1 '^FAIL:' "${NESTED_OUT}" || true)"
    fi

    name="test-0-fmk-nested-violation-after"
    run_nested "${name}" rc nested_violation_after nested_stand_in nested_closing
    expect_nested_markers "${step}: a violating line after the assertions" \
        assert_no_server_tmux assert_no_cscb_include_finished assert_no_cscb_delete "violating line written"
    expect_nested_only_fail "${step}: a violating line after the assertions" "${name}" \
        "after the closing assertions: assert_no_cscb_delete: 1 agent-director-shim.log line(s) run delete from a CSCB process (line 2)"

    name="test-0-fmk-nested-closing-elsewhere"
    run_nested "${name}" rc nested_closing_elsewhere nested_stand_in
    expect_nested_markers "${step}: assertions over copies and in a subshell" assert_no_server_tmux \
        "assert_no_cscb_include_finished over copies" "assert_no_cscb_delete in a subshell"
    expect_nested_only_fail "${step}: assertions over copies and in a subshell" "${name}" \
        "${ENFORCEMENT_LINE}assert_no_cscb_include_finished, assert_no_cscb_delete: not passed in its own shell)"

    name="test-0-fmk-nested-own-failure"
    run_nested "${name}" rc nested_own_failure nested_stand_in
    expect_nested_markers "${step}: a run that fails on its own" stand-in
    expect_nested_only_fail "${step}: a run that fails on its own" "${name}" "planted failure before the closing assertions"
}

# ---------------------------------------------------------------------------
# The harness-only steps: helpers
# ---------------------------------------------------------------------------

# row_snapshot <instance-id>: print the row as one JSON object of every
# column of `spawns`, read through `ad_store_edit` (nothing when no row has
# the id).
row_snapshot() {
    local cols
    cols="$(ad_store_edit "SELECT group_concat(quote(name) || ', \"' || name || '\"', ', ') FROM pragma_table_info('spawns')")"
    [[ -n "${cols}" ]] || fail "row snapshot: the store has no spawns columns"
    ad_store_edit "SELECT json_object(${cols}) FROM spawns WHERE claude_instance_id = '$1'"
}

# expect_row_change <step> <before> <after> <want>: the row after an edit
# holds <want>'s values (a JSON object) in <want>'s columns and its value
# before the edit in every other column.
expect_row_change() {
    local step="$1" before="$2" after="$3" want="$4" bad
    [[ -n "${before}" && -n "${after}" ]] || fail "${step}: no row before or after the edit"
    bad="$(jq -rn --argjson b "${before}" --argjson a "${after}" --argjson w "${want}" '
        ([$a | keys[] as $k | select(($w | has($k)) | not) | select($a[$k] != $b[$k]) | "\($k) \($b[$k] | tojson) -> \($a[$k] | tojson)"]
         + [$w | keys[] as $k | select($a[$k] != $w[$k]) | "\($k) is \($a[$k] | tojson), not \($w[$k] | tojson)"]
         + (if ($a | keys) == ($b | keys) then [] else ["the columns changed"] end))
        | join("; ")')" || fail "${step}: could not compare the row before and after"
    [[ -z "${bad}" ]] || fail "${step}: ${bad}"
}

# session_age_at_least <step> <session> <seconds>: sleep until the tmux
# session <session> is more than <seconds> old (at once when it already is).
session_age_at_least() {
    local step="$1" session="$2" s="$3" created wait_s
    created="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{session_created}')" \
        || fail "${step}: no session ${session}"
    wait_s=$(( created + s + 1 - $(date +%s) ))
    if (( wait_s > 0 )); then
        echo "${TEST_NAME}: ${step}: waiting ${wait_s}s until session ${session} is more than ${s}s old"
        sleep "${wait_s}"
    fi
}

# spawn_at_once <step> <instance-id>: a harness spawn of <instance-id> in a
# working directory of its own selected for the at-once mode, session name
# the id.
spawn_at_once() {
    local step="$1" id="$2" dir
    dir="$(make_workdir "${id}")"
    stub_mode "${dir}" "${STUB_MODE_AT_ONCE}"
    ad_capture spawn --cwd "${dir}" --claude-instance-id "${id}" --tmux-session-name "${id}" --no-pre-trust
    if (( AD_RC != 0 )); then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: harness spawn of ${id} exited ${AD_RC}"
    fi
}

# tmux_read <format> <target>: the real tmux's display-message of <format>
# for <target> on the scenario's server.
tmux_read() {
    "${SCENARIO_REAL_TMUX}" display-message -p -t "$2" "$1"
}

# True when the scenario's tmux server holds no session named exactly <name>.
no_session() {
    ! has_session "$1"
}

# expect_seeded <step> <session> <dir> <instance-id|-> <own|other|none>: the
# last seed_* call (run through `seed`) made session <session>
# (SEEDED_SESSION_ID, its one pane SEEDED_PANE_ID) in <dir>, and printed
# `<session id> <pane id>` and, for a labelled session, its token and store
# id (in SEEDED_OUT). A labelled one
# (own or other) carries a five-field @ad_owner naming its own session id and
# <instance-id>, with the token and store id printed (the scenario store's,
# or another 16-hex one), and its pane carries @ad_pane `<token> <pane id>`;
# `none` carries neither.
expect_seeded() {
    local step="$1" session="$2" dir="$3" id="$4" which="$5" sid pane path owner pane_label f=() want
    read -r sid pane path <<< "$(tmux_read '#{session_id} #{pane_id} #{pane_current_path}' "=${session}:")"
    [[ "${sid}" == "${SEEDED_SESSION_ID}" && "${pane}" == "${SEEDED_PANE_ID}" ]] \
        || fail "${step}: session ${session} is ${sid} ${pane}, not the seeded ${SEEDED_SESSION_ID} ${SEEDED_PANE_ID}"
    [[ "$(tmux_read '#{session_windows} #{window_panes}' "=${session}:")" == "1 1" ]] \
        || fail "${step}: session ${session} has more than one window or pane"
    [[ "${path}" == "$(realpath -e -- "${dir}")" ]] || fail "${step}: the worker runs in ${path}, not ${dir}"
    owner="$("${SCENARIO_REAL_TMUX}" show-options -qv -t "${sid}" @ad_owner)"
    pane_label="$("${SCENARIO_REAL_TMUX}" show-options -p -qv -t "${pane}" @ad_pane)"
    if [[ "${which}" == none ]]; then
        [[ -z "${owner}" && -z "${pane_label}" ]] \
            || fail "${step}: the unlabelled session carries @ad_owner '${owner}' or @ad_pane '${pane_label}'"
        [[ -z "${SEEDED_TOKEN}" && -z "${SEEDED_STORE_ID}" ]] || fail "${step}: the helper set a token or a store id"
        want="${sid} ${pane}"
    else
        read -r -a f <<< "${owner}"
        (( ${#f[@]} == 5 )) && [[ "${f[0]}" == ad1 && "${f[1]}" =~ ^[0-9a-f]{16}$ && "${f[2]}" == "${sid}" && "${f[3]}" == "${id}" ]] \
            || fail "${step}: @ad_owner '${owner}' is not 'ad1 <16-hex token> ${sid} ${id} <store id>'"
        if [[ "${which}" == own ]]; then
            [[ "${f[4]}" == "${T0_STORE_ID}" ]] || fail "${step}: the label ends with ${f[4]}, not the store's id ${T0_STORE_ID}"
        else
            [[ "${f[4]}" =~ ^[0-9a-f]{16}$ && "${f[4]}" != "${T0_STORE_ID}" ]] \
                || fail "${step}: the label ends with '${f[4]}', not another store's 16-hex id"
        fi
        [[ "${f[1]}" == "${SEEDED_TOKEN}" && "${f[4]}" == "${SEEDED_STORE_ID}" ]] \
            || fail "${step}: the label's token and store id are not the helper's ${SEEDED_TOKEN} ${SEEDED_STORE_ID}"
        [[ "${pane_label}" == "${f[1]} ${pane}" ]] \
            || fail "${step}: pane ${pane}'s @ad_pane is '${pane_label}', not '${f[1]} ${pane}'"
        want="${sid} ${pane} ${f[1]} ${f[4]}"
    fi
    [[ "$(cat "${SEEDED_OUT}")" == "${want}" ]] || fail "${step}: the helper printed '$(cat "${SEEDED_OUT}")', not '${want}'"
}

# seed <helper> <arg>...: run a seed_* (or relabel) helper as a plain command,
# so the SEEDED_* variables it sets stay, its output in SEEDED_OUT.
SEEDED_OUT=""
seed() {
    SEEDED_OUT="${SCENARIO_ROOT}/seeded.out"
    "$@" > "${SEEDED_OUT}"
}

# expect_last_call <step> <want-array-name>: the agent-director shim log's
# last `call` line has the words <want> and the scenario's own shell ($$, with
# its command line) as its parent.
expect_last_call() {
    local step="$1" mine=()
    local -n expect_last_call_want="$2"
    read_call "${step}" "$(last_call_line)"
    same_words CALL_WORDS expect_last_call_want \
        || fail "${step}: the last call's words are $(quoted "${CALL_WORDS[@]}"), not $(quoted "${expect_last_call_want[@]}")"
    mapfile -d '' -t mine < "/proc/$$/cmdline"
    [[ "${CALL_PPID}" == "$$" ]] && same_words CALL_PARENT mine \
        || fail "${step}: the call's parent is ${CALL_PPID} $(quoted "${CALL_PARENT[@]}"), not the scenario's shell $$"
}

# ---------------------------------------------------------------------------
# The harness-only steps: legs
# ---------------------------------------------------------------------------

leg_store_rows() {
    local step="store rows" id current token before
    for id in "${T4_FIN_ID}" "${T4_KILL_ID}"; do
        spawn_at_once "${step}" "${id}"
    done
    for id in "${T4_FIN_ID}" "${T4_KILL_ID}"; do
        wait_until "${T4_REPORT_WAIT_S}" "${step}: ${id} never reported in (waiting)" row_state_is "${id}" waiting
    done
    current="$(ad_store_edit "SELECT launch_token FROM spawns WHERE claude_instance_id = '${T4_KILL_ID}'")"
    [[ "${current}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: ${T4_KILL_ID}'s launch token is '${current}'"
    token="$(ad_new_token "${T4_KILL_ID}" 0123456789abcdef)"
    [[ "${token}" =~ ^[0-9a-f]{16}$ && "${token}" != "${current}" && "${token}" != 0123456789abcdef ]] \
        || fail "${step}: ad_new_token printed '${token}' (the row's token ${current}, the given 0123456789abcdef)"
    # A session younger than the stopping window: refused, the row unchanged.
    before="$(row_snapshot "${T4_FIN_ID}")"
    expect_fails_in_home "${step}" "${HOME}" "refused: the worker's session was created" \
        ad_store_mark_finished "${T4_FIN_ID}" missing
    [[ "$(row_snapshot "${T4_FIN_ID}")" == "${before}" ]] || fail "${step}: the refused ad_store_mark_finished changed the row"
}

leg_seeding() {
    local step="seeding" dir
    dir="$(make_workdir seeding)"
    seed seed_leftover -c "${dir}" "${T4_LEFTOVER}" "${T4_LEFTOVER_ID}" sleep 600
    expect_seeded "${step}: seed_leftover" "${T4_LEFTOVER}" "${dir}" "${T4_LEFTOVER_ID}" own
    T4_LEFTOVER_SID="${SEEDED_SESSION_ID}"
    T4_LEFTOVER_PANE="${SEEDED_PANE_ID}"
    T4_LEFTOVER_TOKEN="${SEEDED_TOKEN}"

    seed seed_borrowed_name -c "${dir}" "${T4_BORROWED}" "${T4_BORROWED_ID}" sleep 600
    expect_seeded "${step}: seed_borrowed_name" "${T4_BORROWED}" "${dir}" "${T4_BORROWED_ID}" own

    seed seed_other_store -c "${dir}" "${T4_OTHER_STORE}" "${T4_OTHER_ID}" sleep 600
    expect_seeded "${step}: seed_other_store" "${T4_OTHER_STORE}" "${dir}" "${T4_OTHER_ID}" other

    # The default working directory is SCENARIO_ROOT.
    seed seed_unlabelled "${T4_UNLABELLED}" sleep 600
    expect_seeded "${step}: seed_unlabelled" "${T4_UNLABELLED}" "${SCENARIO_ROOT}" - none

    seed seed_env_only -c "${dir}" "${T4_ENV_ONLY}" "${T4_ENV_ID}" sleep 600
    expect_seeded "${step}: seed_env_only" "${T4_ENV_ONLY}" "${dir}" - none
    T4_ENV_SID="${SEEDED_SESSION_ID}"
    [[ "$("${SCENARIO_REAL_TMUX}" show-environment -t "${T4_ENV_SID}" AGENT_DIRECTOR_INSTANCE_ID)" == "AGENT_DIRECTOR_INSTANCE_ID=${T4_ENV_ID}" ]] \
        || fail "${step}: seed_env_only: the session's environment does not hold AGENT_DIRECTOR_INSTANCE_ID=${T4_ENV_ID}"
    tr '\0' '\n' < "/proc/$(tmux_read '#{pane_pid}' "${SEEDED_PANE_ID}")/environ" | grep -xF "AGENT_DIRECTOR_INSTANCE_ID=${T4_ENV_ID}" > /dev/null \
        || fail "${step}: seed_env_only: the worker's environment does not hold AGENT_DIRECTOR_INSTANCE_ID=${T4_ENV_ID}"

    expect_fails_in_home "${step}" "${HOME}" "a session named ${T4_LEFTOVER} already exists" \
        seed_unlabelled "${T4_LEFTOVER}" sleep 600
    expect_fails_in_home "${step}" "${HOME}" "session name 't0.t4.dot' is empty or holds '.'" \
        seed_leftover t0.t4.dot "${T4_LEFTOVER_ID}" sleep 600
    ! has_session t0.t4.dot && ! has_session t0_t4_dot || fail "${step}: a refused name made a session"
}

leg_tmux_steps() {
    local step="tmux steps" sid pane token old vid value f=() w n=0 old_pid new_pid out scope
    out="${SCENARIO_ROOT}/tmux-steps.out"

    # relabel_session: a new token in both labels, the store's id kept.
    old="${T4_LEFTOVER_TOKEN}"
    relabel_session "${T4_LEFTOVER}" > "${out}"
    read -r sid pane token < "${out}"
    [[ "${sid}" == "${T4_LEFTOVER_SID}" && "${pane}" == "${T4_LEFTOVER_PANE}" && "${token}" =~ ^[0-9a-f]{16}$ && "${token}" != "${old}" ]] \
        || fail "${step}: relabel_session printed '$(cat "${out}")' (the leftover ${T4_LEFTOVER_SID} ${T4_LEFTOVER_PANE}, old token ${old})"
    [[ "$("${SCENARIO_REAL_TMUX}" show-options -qv -t "${sid}" @ad_owner)" == "ad1 ${token} ${sid} ${T4_LEFTOVER_ID} ${T0_STORE_ID}" ]] \
        || fail "${step}: after relabel_session the @ad_owner is '$("${SCENARIO_REAL_TMUX}" show-options -qv -t "${sid}" @ad_owner)'"
    [[ "$("${SCENARIO_REAL_TMUX}" show-options -p -qv -t "${pane}" @ad_pane)" == "${token} ${pane}" ]] \
        || fail "${step}: after relabel_session the worker pane's @ad_pane is not '${token} ${pane}'"
    T4_LEFTOVER_TOKEN="${token}"
    expect_fails_in_home "${step}" "${HOME}" "is the label's or the row's current launch token" \
        relabel_session "${T4_LEFTOVER}" "${token}"
    expect_fails_in_home "${step}" "${HOME}" "carries no valid label of this store" relabel_session "${T4_UNLABELLED}"
    expect_fails_in_home "${step}" "${HOME}" "carries no valid label of this store" relabel_session "${T4_OTHER_STORE}"

    # attach_viewer: a grouped session showing the leftover's windows.
    attach_viewer "${T4_LEFTOVER}" > "${out}"
    vid="$(cat "${out}")"
    [[ "${vid}" =~ ^\$[0-9]+$ && "${vid}" != "${sid}" ]] || fail "${step}: attach_viewer printed '${vid}'"
    [[ "$(tmux_read '#{session_name}' "${vid}:")" == "${SCENARIO_TAG}_viewer_1" ]] \
        || fail "${step}: the viewer is named '$(tmux_read '#{session_name}' "${vid}:")', not ${SCENARIO_TAG}_viewer_1"
    [[ "$(tmux_read '#{session_group}' "${vid}:")" == "$(tmux_read '#{session_group}' "${sid}:")" \
        && -n "$(tmux_read '#{session_group}' "${sid}:")" ]] || fail "${step}: the viewer is not in the leftover's group"
    [[ "$("${SCENARIO_REAL_TMUX}" list-windows -t "${vid}" -F '#{window_id}')" == "$("${SCENARIO_REAL_TMUX}" list-windows -t "${sid}" -F '#{window_id}')" ]] \
        || fail "${step}: the viewer does not show the leftover's windows"

    # rename_session, then set_remain_on_exit on every window.
    rename_session "${T4_UNLABELLED}" t0-t4-renamed > "${out}"
    sid="$(cat "${out}")"
    [[ "$(tmux_read '#{session_name}' "${sid}:")" == t0-t4-renamed ]] && ! has_session "${T4_UNLABELLED}" \
        || fail "${step}: after rename_session ${sid} is named '$(tmux_read '#{session_name}' "${sid}:")'"
    set_remain_on_exit t0-t4-renamed
    while IFS= read -r w; do
        n=$(( n + 1 ))
        [[ "$("${SCENARIO_REAL_TMUX}" show-options -w -qv -t "${w}" remain-on-exit)" == on ]] \
            || fail "${step}: window ${w} of t0-t4-renamed does not have remain-on-exit on"
    done < <("${SCENARIO_REAL_TMUX}" list-windows -t "${sid}" -F '#{window_id}')
    (( n > 0 )) || fail "${step}: t0-t4-renamed has no window"

    # The global @ad_owner: set (five fields, $0, the store's id), then unset
    # in all three scopes agent-director's lookup reads.
    value="$(ad_owner_global_set)"
    read -r -a f <<< "${value}"
    (( ${#f[@]} == 5 )) && [[ "${f[0]}" == ad1 && "${f[1]}" =~ ^[0-9a-f]{16}$ && "${f[2]}" == "\$0" \
        && "${f[3]}" == "${SCENARIO_TAG}_global" && "${f[4]}" == "${T0_STORE_ID}" ]] \
        || fail "${step}: ad_owner_global_set printed '${value}'"
    [[ "$("${SCENARIO_REAL_TMUX}" show-options -gqv @ad_owner)" == "${value}" ]] || fail "${step}: the global @ad_owner is not '${value}'"
    ad_owner_global_unset
    for scope in -gqv -sqv -gwqv; do
        [[ -z "$("${SCENARIO_REAL_TMUX}" show-options "${scope}" @ad_owner)" ]] \
            || fail "${step}: after ad_owner_global_unset, show-options ${scope} @ad_owner holds a value"
    done

    # respawn_worker_pane: the leftover's worker pane runs a new process.
    old_pid="$(tmux_read '#{pane_pid}' "${T4_LEFTOVER_PANE}")"
    respawn_worker_pane "${T4_LEFTOVER}" sleep 601 > "${out}"
    read -r pane new_pid < "${out}"
    [[ "${pane}" == "${T4_LEFTOVER_PANE}" && "${new_pid}" == "$(tmux_read '#{pane_pid}' "${T4_LEFTOVER_PANE}")" && "${new_pid}" != "${old_pid}" ]] \
        || fail "${step}: respawn_worker_pane printed '$(cat "${out}")' (pane ${T4_LEFTOVER_PANE}, old pid ${old_pid})"
    [[ "$(tr '\0' ' ' < "/proc/${new_pid}/cmdline")" == "sleep 601 " ]] || fail "${step}: the respawned pane does not run 'sleep 601'"
    ! pid_alive "${old_pid}" || fail "${step}: the pane's old process ${old_pid} still runs"

    # end_session: by session id only.
    expect_fails_in_home "${step}" "${HOME}" "is not a session id" end_session "${T4_ENV_ONLY}"
    end_session "${T4_ENV_SID}"
    ! "${SCENARIO_REAL_TMUX}" has-session -t "${T4_ENV_SID}" 2> /dev/null || fail "${step}: ${T4_ENV_SID} still exists after end_session"

    expect_fails_in_home "${step}" "${HOME}" "refused: TMUX is set" with_tmux_set attach_viewer "${T4_LEFTOVER}"
}

leg_store_statements() {
    local step="store statements" before after rv ended_at e now
    # The safe minimums, so the operator leg's kill need not wait out the
    # default starting-session bound; `ad_store_mark_finished` reads the
    # window from this file.
    printf '[tmux]\nstarting_session_seconds = %s\nstopping_window_seconds = %s\n' \
        "${T4_STARTING_BOUND_S}" "${T4_STOPPING_WINDOW_S}" | write_file "${HOME}/.agent-director/config.toml"
    session_age_at_least "${step}" "${T4_FIN_ID}" "${T4_STOPPING_WINDOW_S}"
    before="$(row_snapshot "${T4_FIN_ID}")"
    rv="$(jq -r '.row_version' <<< "${before}")"
    ended_at="$(ad_store_mark_finished "${T4_FIN_ID}" missing)"
    now="$(date +%s)"
    after="$(row_snapshot "${T4_FIN_ID}")"
    expect_row_change "${step}: ad_store_mark_finished" "${before}" "${after}" \
        "$(jq -nc --arg e "${ended_at}" --argjson rv "$(( rv + 1 ))" '{state: "missing", ended_at: $e, launch_started_at: null, row_version: $rv}')"
    e="$(date -u -d "${ended_at}" +%s)" || fail "${step}: ended_at '${ended_at}' is not a time"
    [[ "${ended_at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] \
        && (( e <= now - T4_STOPPING_WINDOW_S && e >= now - T4_STOPPING_WINDOW_S - 5 )) \
        || fail "${step}: ended_at '${ended_at}' is not config.toml's stopping window (${T4_STOPPING_WINDOW_S}s) before ${now}"
    expect_row_state "${step}: after ad_store_mark_finished" "${T4_FIN_ID}" missing

    # The live row: no unusable name, no delete; unchanged.
    before="$(row_snapshot "${T4_KILL_ID}")"
    expect_fails_in_home "${step}" "${HOME}" "refused: the row reads waiting, not a finished state" \
        ad_store_unusable_name "${T4_KILL_ID}" "${T4_UNUSABLE_NAME}"
    expect_fails_in_home "${step}" "${HOME}" "refused: the row's recorded session name '${T4_KILL_ID}' holds no '.'" \
        ad_delete_unusable_row "${T4_KILL_ID}"
    [[ "$(row_snapshot "${T4_KILL_ID}")" == "${before}" ]] || fail "${step}: a refused statement changed ${T4_KILL_ID}'s row"

    before="${after}"
    ad_store_unusable_name "${T4_FIN_ID}" "${T4_UNUSABLE_NAME}"
    after="$(row_snapshot "${T4_FIN_ID}")"
    expect_row_change "${step}: ad_store_unusable_name" "${before}" "${after}" \
        "$(jq -nc --arg n "${T4_UNUSABLE_NAME}" '{tmux_session_name: $n}')"
}

leg_operator_actions() {
    local step="operator actions" before after rv old token t0 t1 want=() ended_at
    # Scenario 10 part B: the row marked ended while its session still runs
    # (the `ended` statement, every other column kept), then the human's
    # include-finished kill, which agent-director makes only for a finished
    # row whose session is past its starting-session bound.
    session_age_at_least "${step}" "${T4_KILL_ID}" "${T4_STARTING_BOUND_S}"
    before="$(row_snapshot "${T4_KILL_ID}")"
    rv="$(jq -r '.row_version' <<< "${before}")"
    ended_at="$(ad_store_mark_finished "${T4_KILL_ID}" ended)"
    expect_row_change "${step}: ad_store_mark_finished ended" "${before}" "$(row_snapshot "${T4_KILL_ID}")" \
        "$(jq -nc --arg e "${ended_at}" --argjson rv "$(( rv + 1 ))" '{state: "ended", ended_at: $e, launch_started_at: null, row_version: $rv}')"
    has_session "${T4_KILL_ID}" || fail "${step}: session ${T4_KILL_ID} ended before the kill"
    ad_kill_include_finished "${T4_KILL_ID}" > /dev/null
    (( AD_KILL_RC == 0 )) && [[ "$(jq -r '.kill_sent' "${AD_KILL_OUT}")" == true ]] \
        || fail "${step}: the include-finished kill answered $(tr '\n' ' ' < "${AD_KILL_OUT}") (exit ${AD_KILL_RC})"
    want=(kill --include-finished --claude-instance-id "${T4_KILL_ID}")
    expect_last_call "${step}: the include-finished kill" want
    ( assert_no_cscb_include_finished ) > "${SCENARIO_ROOT}/operator-include-finished.out" 2>&1 || {
        sed 's/^/  | /' "${SCENARIO_ROOT}/operator-include-finished.out" >&2
        fail "${step}: assert_no_cscb_include_finished failed after the harness's include-finished kill"
    }
    wait_until "${T4_END_WAIT_S}" "${step}: session ${T4_KILL_ID} outlived the kill" no_session "${T4_KILL_ID}"
    ad_capture get --claude-instance-id "${T4_KILL_ID}"
    echo "${TEST_NAME}: ${step}: after the kill ${T4_KILL_ID} reads $(jq -r '.state // empty' "${AD_OUT}")"

    # The pending row beside a leftover: a fresh token, its pane and server
    # identity cleared, everything else kept; status reads it pending with a
    # launch start.
    before="$(row_snapshot "${T4_KILL_ID}")"
    rv="$(jq -r '.row_version' <<< "${before}")"
    old="$(jq -r '.launch_token // empty' <<< "${before}")"
    t0="$(date +%s%3N)"
    token="$(ad_store_seed_pending "${T4_KILL_ID}" "${T4_LEFTOVER_TOKEN}")"
    t1="$(date +%s%3N)"
    after="$(row_snapshot "${T4_KILL_ID}")"
    [[ "${token}" =~ ^[0-9a-f]{16}$ && "${token}" != "${old}" && "${token}" != "${T4_LEFTOVER_TOKEN}" ]] \
        || fail "${step}: ad_store_seed_pending printed '${token}' (old ${old}, leftover ${T4_LEFTOVER_TOKEN})"
    jq -e --argjson lo "${t0}" --argjson hi "${t1}" '.launch_started_at | type == "number" and . >= $lo and . <= $hi' <<< "${after}" > /dev/null \
        || fail "${step}: launch_started_at is $(jq -c '.launch_started_at' <<< "${after}"), not between ${t0} and ${t1}"
    expect_row_change "${step}: ad_store_seed_pending" "${before}" "${after}" \
        "$(jq -nc --arg t "${token}" --argjson rv "$(( rv + 1 ))" --argjson ls "$(jq '.launch_started_at' <<< "${after}")" '{
            state: "pending", launch_started_at: $ls, launch_token: $t, ended_at: null, pid: null, proc_starttime: null,
            tmux_server_pid: null, tmux_server_started: null, tmux_server_starttime: null,
            pane_id: null, pane_pid: null, pane_starttime: null, row_version: $rv}')"
    ad_capture status --claude-instance-id "${T4_KILL_ID}"
    (( AD_RC == 0 )) && jq -e '.state == "pending" and (.launch_started_at | type == "string")' "${AD_OUT}" > /dev/null \
        || fail "${step}: a harness status read of ${T4_KILL_ID} answered $(tr '\n' ' ' < "${AD_OUT}")"

    # Scenario 25's delete: the row the statement made unusable, from the
    # scenario's shell.
    ad_delete_unusable_row "${T4_FIN_ID}"
    want=(delete --claude-instance-id "${T4_FIN_ID}")
    expect_last_call "${step}: the delete" want
    [[ -z "$(row_snapshot "${T4_FIN_ID}")" ]] || fail "${step}: ${T4_FIN_ID}'s row is still in the store"
    ad_capture get --claude-instance-id "${T4_FIN_ID}"
    (( AD_RC != 0 )) || fail "${step}: a harness get of the deleted ${T4_FIN_ID} succeeded"
    [[ "$(cscb_ad_count delete)" == 0 ]] || fail "${step}: a CSCB process made a delete"
    ( assert_no_cscb_delete ) > "${SCENARIO_ROOT}/operator-delete.out" 2>&1 || {
        sed 's/^/  | /' "${SCENARIO_ROOT}/operator-delete.out" >&2
        fail "${step}: assert_no_cscb_delete failed after the harness's delete"
    }
}

leg_find_missing_loop() {
    local step="find-missing loop" lines_before cscb_before runs line n=0 prev_end="" start end lines=() mine=() pid
    cscb_before="$(cscb_ad_count find-missing)"
    lines_before="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
    run_find_missing_loop "${T4_FM_INTERVAL_S}"
    pid="${FIND_MISSING_LOOP_PID}"
    [[ "${FIND_MISSING_LOOP_INTERVAL_S}" == "${T4_FM_INTERVAL_S}" ]] && pid_alive "${pid}" \
        || fail "${step}: the loop is not running at interval ${T4_FM_INTERVAL_S}"
    expect_fails_in_home "${step}" "${HOME}" "the find-missing loop already runs" run_find_missing_loop "${T4_FM_INTERVAL_S}"
    wait_find_missing_runs 2
    stop_find_missing_loop
    ! pid_alive "${pid}" || fail "${step}: the loop ${pid} still runs after stop_find_missing_loop"
    expect_fails_in_home "${step}" "${HOME}" "the find-missing loop is not running" wait_find_missing_runs 1

    # Its log: every run exited 0, each started at least the interval after
    # the one before ended.
    runs="$(find_missing_loop_runs)"
    (( runs >= 2 )) || fail "${step}: the loop's log holds ${runs} run(s)"
    while IFS= read -r line; do
        n=$(( n + 1 ))
        [[ "${line}" =~ ^run\ ${n}$'\t'start\ ([0-9]+\.[0-9]+)$'\t'end\ ([0-9]+\.[0-9]+)$'\t'exit\ 0$ ]] \
            || fail "${step}: the loop's log line '${line}' is not run ${n} with exit 0"
        start="${BASH_REMATCH[1]}"
        end="${BASH_REMATCH[2]}"
        if [[ -n "${prev_end}" ]]; then
            ! time_before "${start}" "$(seconds_plus "${prev_end}" "${T4_FM_INTERVAL_S}")" \
                || fail "${step}: run ${n} started at ${start}, less than ${T4_FM_INTERVAL_S}s after run $(( n - 1 )) ended (${prev_end})"
        fi
        prev_end="${end}"
    done < <(grep '^run ' "${FIND_MISSING_LOOP_LOG}")

    # Its calls: one find-missing per run, the loop subshell their parent,
    # with the shell's command line; none is CSCB's.
    mapfile -t lines < <(tail -n "+$(( lines_before + 1 ))" "${SCENARIO_AD_SHIM_LOG}" | awk -F'\t' '$1 == "call"')
    (( ${#lines[@]} == runs )) || fail "${step}: ${#lines[@]} call line(s) during the loop, not its ${runs} run(s)"
    mapfile -d '' -t mine < "/proc/$$/cmdline"
    for line in "${lines[@]}"; do
        read_call "${step}" "${line}"
        [[ "${CALL_WORDS[*]}" == find-missing && "${CALL_PPID}" == "${pid}" ]] && same_words CALL_PARENT mine \
            || fail "${step}: a call during the loop is $(quoted "${CALL_WORDS[@]}") from ${CALL_PPID}, not find-missing from the loop ${pid} with the shell's command line"
    done
    [[ "$(cscb_ad_count find-missing)" == "${cscb_before}" ]] || fail "${step}: CSCB's find-missing count changed"
}

# run_driver <step> <call> [<VAR>=<value>...]: fixtures/fmk-driver.ts with
# <call>, through `cscb_run`, for the driver persona, with the variables
# given. Fails unless it exits 0 with exactly one outcome line on standard
# output, `DRIVER: FORCED <call> …` (DRIVER_LINE), and every agent-director
# call in the shim's log during it has the driver as its parent (the run's
# recorded PID; its command line bun's, or unknown for a call the driver left
# in flight as it exited), CSCB's count rising by exactly those, none a
# delete.
# Sets DRIVER_LINE and DRIVER_VERBS.
run_driver() {
    local step="$1" call="$2" out err rc=0 before cscb_before outcome=() lines=() line pid parent unknown=0
    shift 2
    out="${SCENARIO_ROOT}/fmk-driver-${call}.out"
    err="${SCENARIO_ROOT}/fmk-driver-${call}.err"
    before="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
    cscb_before="$(cscb_ad_count "")"
    cscb_run env "CSCB_PKG_DIR=${SCENARIO_REPO}/node_modules/claude-slack-channel-bots" \
        "DRIVER_PERSONA=${DRV_NAME}" "DRIVER_PERSONA_CHANNEL=${DRV_CHANNEL}" "DRIVER_WORKING_DIRECTORY=${DRV_WORK}" "$@" \
        bun --no-install "${SCENARIO_FIXTURES}/fmk-driver.ts" "${call}" < /dev/null > "${out}" 2> "${err}" || rc=$?
    mapfile -t outcome < <(grep -E '^DRIVER(_FAIL)?:' "${out}" || true)
    if (( rc != 0 || ${#outcome[@]} != 1 )) || [[ "${outcome[0]}" != "DRIVER: FORCED ${call} "* || "$(line_count "${out}")" != 1 ]]; then
        sed 's/^/  | /' "${out}" >&2
        tail -n 20 "${err}" | sed 's/^/  | /' >&2
        fail "${step}: the driver exited ${rc} with ${#outcome[@]} outcome line(s) (first: ${outcome[0]:-none}), not one 'DRIVER: FORCED ${call} …' line"
    fi
    DRIVER_LINE="${outcome[0]}"
    echo "${TEST_NAME}: ${step}: ${DRIVER_LINE:0:400}"

    # The driver's record entry (role run), whose PID is the driver's own.
    line="$(awk -F'\t' -v w="fmk-driver.ts ${call}" '$1 == "proc" && $2 == "run" && index($6, w) { l = $0 } END { print l }' "${SCENARIO_CSCB_RECORD}")"
    pid="$(cut -f3 <<< "${line}")"
    [[ "${pid}" =~ ^[0-9]+$ ]] || fail "${step}: the record holds no run entry for the driver"
    mapfile -t lines < <(tail -n "+$(( before + 1 ))" "${SCENARIO_AD_SHIM_LOG}" | awk -F'\t' '$1 == "call"')
    (( ${#lines[@]} >= 1 )) || fail "${step}: the driver's run added no agent-director call line"
    DRIVER_VERBS=()
    for line in "${lines[@]}"; do
        read_call "${step}" "${line}"
        # The parent's command line is bun's, or unknown (`?`) for a call
        # the driver left in flight when it exited, before the shim read it;
        # its PID is the driver's either way.
        parent="${CALL_PARENT[0]:-?}"
        if [[ "${CALL_PPID}" != "${pid}" || ( "${parent}" != */bun && "${parent}" != bun && "${parent}" != '?' ) ]]; then
            echo "  | ${line}" >&2
            fail "${step}: a call during the driver's run has parent ${CALL_PPID} '${CALL_PARENT[*]:-?}', not the driver ${pid} (bun)"
        fi
        [[ "${parent}" != '?' ]] || unknown=$(( unknown + 1 ))
        _L_WORDS=("${CALL_WORDS[@]}")
        _scenario_ad_verb
        DRIVER_VERBS+=("${_L_VERB}")
        [[ "${_L_VERB}" != delete ]] || fail "${step}: the driver's run made a delete"
    done
    echo "${TEST_NAME}: ${step}: agent-director calls: ${DRIVER_VERBS[*]} (${unknown} left in flight at the driver's exit)"
    [[ "$(cscb_ad_count "")" == "$(( cscb_before + ${#lines[@]} ))" ]] \
        || fail "${step}: CSCB's call count went from ${cscb_before} to $(cscb_ad_count ""), not up by the driver's ${#lines[@]}"
    [[ "$(cscb_ad_count delete)" == 0 ]] || fail "${step}: a CSCB process made a delete"
}

# expect_driver_verb <step> <verb>: the last driver run made a <verb> call.
expect_driver_verb() {
    local v
    for v in "${DRIVER_VERBS[@]}"; do
        [[ "${v}" == "$2" ]] && return 0
    done
    fail "$1: the driver made no $2 call (${DRIVER_VERBS[*]})"
}

leg_fmk_driver_reuse_spawn() {
    local step="fmk-driver reuse-spawn"
    DRV_WORK="$(make_workdir drv)"
    stub_mode "${DRV_WORK}" "${STUB_MODE_AT_ONCE}"
    run_driver "${step}" reuse-spawn
    [[ "${DRIVER_LINE}" == *" called=true "* && "${DRIVER_LINE}" == *" result={"* ]] \
        || fail "${step}: the outcome line has no called=true or no result: ${DRIVER_LINE}"
    expect_driver_verb "${step}" spawn
}

leg_fmk_driver_read_pane() {
    local step="fmk-driver read-pane-other-tmux-tmpdir" other="${SCENARIO_ROOT}/other-tmux"
    mkdir -m 700 "${other}"
    run_driver "${step}" read-pane-other-tmux-tmpdir "DRIVER_OTHER_TMUX_TMPDIR=${other}"
    [[ "${DRIVER_LINE}" == *" tmux_tmpdir=\"${other}\" restored=true outcome="* ]] \
        || fail "${step}: the outcome line does not name the other TMUX_TMPDIR, restored: ${DRIVER_LINE}"
    expect_driver_verb "${step}" read-pane
}

leg_fmk_driver_resume() {
    local step="fmk-driver resume"
    run_driver "${step}" resume
    [[ "${DRIVER_LINE}" == *" called=true "* && "${DRIVER_LINE}" == *" result={"* ]] \
        || fail "${step}: the outcome line has no called=true or no result: ${DRIVER_LINE}"
    expect_driver_verb "${step}" resume
}

# nested_expect_refused <reason> <command> [<arg>...]: in the nested run, the
# command fails in a subshell, its first FAIL line holding <reason>.
nested_expect_refused() {
    local reason="$1" out="${SCENARIO_ROOT}/refused.out" rc=0 line
    shift
    ( "$@" ) > "${out}" 2>&1 || rc=$?
    line="$(grep -m1 '^FAIL:' "${out}" || true)"
    if (( rc == 0 )) || [[ "${line}" != *"${reason}"* ]]; then
        sed 's/^/  | /' "${out}" >&2
        fail "'$*' exited ${rc} without '${reason}'"
    fi
}

# nested_expect_row <instance-id> <session> <labels-json>: in the nested run,
# a harness get finds the row live or waiting, recording <session> and exactly
# <labels-json>, and the session runs on the run's tmux server.
nested_expect_row() {
    local id="$1" session="$2" labels="$3"
    ad_capture get --claude-instance-id "${id}"
    (( AD_RC == 0 )) || fail "harness get of ${id} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    jq -e --arg s "${session}" --argjson l "${labels}" '.tmux_session_name == $s and .labels == $l' "${AD_OUT}" > /dev/null \
        || fail "row ${id} reads $(tr '\n' ' ' < "${AD_OUT}" | head -c 600), not session ${session} with labels ${labels}"
    "${SCENARIO_REAL_TMUX}" has-session -t "=${session}" 2> /dev/null || fail "no session ${session} for row ${id}"
}

# The body of leg_seeders_010's nested fmk run (started on 0.10.0).
nested_seed_010() {
    local step="0.10.0 seeders" dir_row dir_a dir_b config out lines=() want=() id session sid pane pids=() i n
    expect_shim_in_place "${step}" "${SCENARIO_AD_010_BIN}"
    dir_row="$(make_workdir row)"
    dir_a="${HOME}/t0-route-a"
    mkdir -p "${dir_a}"
    dir_b="$(make_workdir route-b)"
    config="${SCENARIO_ROOT}/prepersona-config.json"
    jq -n --arg b "${dir_b}" '{routes: {C0T0AAA01: {cwd: "~/t0-route-a"}, C0T0BBB02: {cwd: $b}}, bind: "127.0.0.1", port: 3100}' > "${config}"

    # Every route is named and checked before the first row (and before
    # 0.10.0's first spawn makes the store).
    nested_expect_refused "no Slack channel name given for routed channel C0T0BBB02" \
        seed_prepersona_fleet "${config}" "C0T0AAA01=Ops Team!"
    [[ ! -e "${HOME}/.agent-director/state.db" ]] || fail "a refused fleet made a store"
    echo "CHECK: fleet refused before its first row"

    out="$(seed_010_row t0-010-row t0_010_row "${dir_row}" team=t0)"
    read -r id session sid pane <<< "${out}"
    [[ "${id}" == t0-010-row && "${session}" == t0_010_row && "${sid}" =~ ^\$[0-9]+$ && "${pane}" =~ ^%[0-9]+$ ]] \
        || fail "seed_010_row printed '${out}'"
    nested_expect_row t0-010-row t0_010_row '{"team":"t0"}'
    echo "CHECK: seed_010_row"

    out="$(seed_prepersona_fleet "${config}" "C0T0AAA01=Ops Team!" "C0T0BBB02=__")"
    mapfile -t lines <<< "${out}"
    want=(
        "C0T0AAA01 cscb_ops_team_C0T0AAA01 slack_bot_ops_team_C0T0AAA01"
        "C0T0BBB02 cscb_C0T0BBB02 slack_bot_C0T0BBB02"
    )
    (( ${#lines[@]} == 2 )) || fail "seed_prepersona_fleet printed ${#lines[@]} line(s): ${out}"
    for i in 0 1; do
        [[ "${lines[i]}" =~ ^${want[i]}\ \$[0-9]+\ %[0-9]+$ ]] || fail "seed_prepersona_fleet line $(( i + 1 )) is '${lines[i]}', not '${want[i]} <session id> <pane id>'"
    done
    nested_expect_row cscb_ops_team_C0T0AAA01 slack_bot_ops_team_C0T0AAA01 '{"service":"cscb","channel":"C0T0AAA01"}'
    nested_expect_row cscb_C0T0BBB02 slack_bot_C0T0BBB02 '{"service":"cscb","channel":"C0T0BBB02"}'
    [[ "$("${SCENARIO_REAL_TMUX}" display-message -p -t "=slack_bot_ops_team_C0T0AAA01:" '#{pane_current_path}')" == "$(realpath -e -- "${dir_a}")" ]] \
        || fail "the first route's worker does not run in its ~ route directory ${dir_a}"
    [[ "$("${SCENARIO_REAL_TMUX}" display-message -p -t "=slack_bot_C0T0BBB02:" '#{pane_current_path}')" == "$(realpath -e -- "${dir_b}")" ]] \
        || fail "the second route's worker does not run in ${dir_b}"
    echo "CHECK: seed_prepersona_fleet"

    # The release candidate's install over the 0.10.0 rows.
    for session in t0_010_row slack_bot_ops_team_C0T0AAA01 slack_bot_C0T0BBB02; do
        pids+=("$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{pane_pid}')")
    done
    install_ad_rc "${step}: install_ad_rc over the seeded rows"
    check_ad_shim "${step}: after install_ad_rc"
    expect_shim_in_place "${step}: after install_ad_rc" "${SCENARIO_RC_BIN}"
    [[ "$(ad_store_id)" =~ ^[0-9a-f]{16}$ ]] || fail "no store id after install_ad_rc"
    nested_expect_row t0-010-row t0_010_row '{"team":"t0"}'
    nested_expect_row cscb_ops_team_C0T0AAA01 slack_bot_ops_team_C0T0AAA01 '{"service":"cscb","channel":"C0T0AAA01"}'
    nested_expect_row cscb_C0T0BBB02 slack_bot_C0T0BBB02 '{"service":"cscb","channel":"C0T0BBB02"}'
    n=0
    for session in t0_010_row slack_bot_ops_team_C0T0AAA01 slack_bot_C0T0BBB02; do
        [[ "$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{pane_pid}')" == "${pids[n]}" ]] && pid_alive "${pids[n]}" \
            || fail "the worker of ${session} (${pids[n]}) did not survive install_ad_rc"
        n=$(( n + 1 ))
    done
    echo "CHECK: rows survive the release candidate's install"

    # Each seeder now refuses, for each of its reasons: install.sh has run;
    # the binary behind the shim is not 0.10.0; the store has a store_meta.
    nested_expect_refused "refused: the release candidate's install.sh has run" seed_010_row t0-010-late t0_010_late "${dir_row}"
    nested_expect_refused "refused: the release candidate's install.sh has run" \
        seed_prepersona_fleet "${config}" "C0T0AAA01=Ops Team!" "C0T0BBB02=__"
    nested_expect_refused "refused: the binary behind the shim reports version" nested_with_no_install seed_010_row t0-010-late t0_010_late "${dir_row}"
    swap_ad_binary 0.10.0 "${step}: 0.10.0 behind the shim over the migrated store"
    nested_expect_refused "refused: the store has a store_meta table" nested_with_no_install seed_010_row t0-010-late t0_010_late "${dir_row}"
    nested_expect_refused "refused: the store has a store_meta table" nested_with_no_install \
        seed_prepersona_fleet "${config}" "C0T0AAA01=Ops Team!" "C0T0BBB02=__"
    swap_ad_binary rc "${step}: the release candidate back behind the shim"
    "${SCENARIO_REAL_TMUX}" has-session -t "=t0_010_late" 2> /dev/null && fail "a refused seeder made a session"
    echo "CHECK: seeders refuse after the install"

    nested_stand_in
    nested_closing
    echo "PASS: ${TEST_NAME}"
}

# nested_with_no_install <command> [<arg>...]: run <command> as though no
# install.sh had run in this shell (in the caller's subshell).
nested_with_no_install() {
    _SCENARIO_INSTALL_COUNT=0
    "$@"
}

leg_seeders_010() {
    local step="0.10.0 seeders" name="test-0-fmk-nested-seeders-010"
    run_nested "${name}" 0.10.0 nested_seed_010 nested_expect_refused nested_expect_row nested_with_no_install \
        expect_shim_in_place nested_stand_in nested_closing
    expect_nested_markers "${step}" "fleet refused before its first row" seed_010_row seed_prepersona_fleet \
        "rows survive the release candidate's install" "seeders refuse after the install" \
        assert_no_server_tmux assert_no_cscb_include_finished assert_no_cscb_delete
    if (( NESTED_RC != 0 )) || grep -q '^FAIL:' "${NESTED_OUT}" || ! grep -qxF "PASS: ${name}" "${NESTED_OUT}"; then
        sed 's/^/  | /' "${NESTED_OUT}" >&2
        fail "${step}: the nested run exited ${NESTED_RC}: $(grep -m1 '^FAIL:' "${NESTED_OUT}" || true)"
    fi
}

leg_tmux_server_steps() {
    local step="tmux server steps" out old_pid new_pid sid sock moved rb_pid rb_sid got
    out="${SCENARIO_ROOT}/tmux-server-steps.out"
    got="$("${SCENARIO_REAL_TMUX}" list-sessions -F '#{pid}')" || fail "${step}: no tmux server runs for the scenario"
    old_pid="${got%%$'\n'*}"
    restart_tmux_server > "${out}"
    read -r new_pid sid < "${out}"
    [[ "${new_pid}" != "${old_pid}" ]] && pid_alive "${new_pid}" && ! pid_alive "${old_pid}" \
        || fail "${step}: restart_tmux_server printed '$(cat "${out}")' (old server ${old_pid})"
    [[ "$("${SCENARIO_REAL_TMUX}" list-sessions -F '#{pid} #{session_id} #{session_name}')" == "${new_pid} ${sid} ${SCENARIO_TAG}_restart" ]] \
        || fail "${step}: after the restart the server lists $("${SCENARIO_REAL_TMUX}" list-sessions -F '#{pid} #{session_id} #{session_name}' | tr '\n' ';')"

    sock="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${sid}:" '#{socket_path}')"
    expect_fails_in_home "${step}" "${HOME}" "refused: TMUX is set" with_tmux_set rebind_tmux_socket
    rebind_tmux_socket > "${out}"
    read -r rb_pid rb_sid moved < "${out}"
    [[ "${moved}" == "${sock}.rebound-1" && "${moved}" == "${REBOUND_SOCKET:-}" && "${rb_pid}" != "${new_pid}" ]] \
        || fail "${step}: rebind_tmux_socket printed '$(cat "${out}")' (socket ${sock}, old server ${new_pid})"
    got="$("${SCENARIO_REAL_TMUX}" -S "${moved}" list-sessions -F '#{pid} #{session_name}')"
    [[ "${got}" == "${new_pid} ${SCENARIO_TAG}_restart" ]] || fail "${step}: the moved socket answers '${got}', not the old server"
    got="$("${SCENARIO_REAL_TMUX}" list-sessions -F '#{pid} #{session_id} #{session_name}')"
    [[ "${got}" == "${rb_pid} ${rb_sid} ${SCENARIO_TAG}_rebound_1" ]] || fail "${step}: the socket path answers '${got}', not the new server"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

LEGS=(
    isolation
    real_binary
    setup_install
    harness_call_log
    version_probe
    tmux_and_store
    swap
    reinstall
    hide_restore
    log_kept
    start_on_010
    store_rows
    guard_refusals
    shim_check
    tmux_shim_log
    fail_kill
    fail_create
    slow_create
    wedge
    mode_spawns_not_cscb
    path_wiring
    live_start
    mcp_session
    harness_include_finished
    stub_direct
    stub_helpers
    refire_hold
    refire_at_once
    refire_trusted_config_dir
    refire_trusted_home
    refire_dev_channels
    refire_unrecognised
    refire_folder_trust
    stop_status_failure
    stop_no_launch_start
    refire_grace
    stub_lines_not_cscb
    synthetic_server_tmux
    synthetic_include_finished
    synthetic_delete
    count_helpers
    closing_enforcement
    seeding
    tmux_steps
    store_statements
    operator_actions
    find_missing_loop
    fmk_driver_reuse_spawn
    fmk_driver_read_pane
    fmk_driver_resume
    seeders_010
    tmux_server_steps
)

for leg in "${LEGS[@]}"; do
    echo "${TEST_NAME}: leg ${leg} (at ${SECONDS}s)"
    "leg_${leg}"
done

# The closing assertions (b.jg5 SRJ-1401), met by the live start's own lines.
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "PASS: ${TEST_NAME}"
