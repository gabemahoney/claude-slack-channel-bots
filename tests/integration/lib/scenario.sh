# shellcheck shell=bash
# tests/integration/lib/scenario.sh — shared helper for the docker integration
# scenario scripts (test-5 onwards, and test-0-fmk-harness-self-check).
# Sourced, never run:
#
#   #!/usr/bin/env bash
#   set -euo pipefail
#   TEST_NAME="test-N-<short-name>"
#   # shellcheck source=lib/scenario.sh
#   source "$(dirname "$0")/lib/scenario.sh"
#
# (tests/integration/.shellcheckrc lets `shellcheck` follow that directive
# without -x, so the helper's globals count as used.)
#
# Runs only inside the cscb-ci container (tests/runner.sh, via /ci), after
# Test 1 installed the package into /test-repo. Never source it on a dev box:
# its first step checks for the image marker /etc/cscb-ci-image and, when it
# is absent, prints `FAIL: <test>: refused: /etc/cscb-ci-image is absent …`
# and exits 1, before it makes a scratch root, picks a port or sets a trap.
#
# Two modes, chosen by the script's name:
# - fmk mode, for every script whose TEST_NAME carries `-fmk-` (test-13 to
#   test-28, and test-0-fmk-harness-self-check): the scenario gets its own
#   HOME, agent-director install and store, and tmux server, all under
#   SCENARIO_ROOT, with the agent-director shim in front of the binary (see
#   "fmk mode" below);
# - shared mode, for every other script (test-5 to test-12): HOME, PATH, the
#   agent-director store and the tmux server stay the container's, as the
#   scripts found them, and no shim is installed (test-12 checks where the
#   hook commands resolve).
#
# What sourcing does, in both modes:
# - refuses outside a cscb-ci image (above);
# - sets TEST_NAME from the script's file name when the script did not;
# - makes the scenario's scratch root (SCENARIO_ROOT, `mktemp -d` under /tmp,
#   exported, so every process the scenario starts carries it in its
#   environment) and a first state dir under it, exported as SLACK_STATE_DIR,
#   so the scenario never touches ~/.claude/channels/slack or another
#   script's state (a fresh state dir has no config.json.last-applied);
# - in fmk mode, sets up the scenario's HOME, tmux, PATH and agent-director
#   install (see "fmk mode");
# - picks a free port (SCENARIO_PORT; never 3100, which Tests 1-3's server
#   keeps) for the scenario's config to name;
# - sets SCENARIO_TAG ("t<N>" from TEST_NAME). Persona names in the
#   shared-mode scripts must be unique across those scripts, since every
#   shared-mode script shares one HOME and one agent-director store: build
#   them from the tag (for example "${SCENARIO_TAG}_alpha");
# - installs an EXIT trap that stops every server the scenario started, kills
#   every process it registered with `track_pid`, in fmk mode stops the
#   scenario's tmux server and runs the closing enforcement (see "Closing
#   assertions"), runs the `on_exit` hooks, prints the tail of each state
#   dir's server.log when the script failed, and removes SCENARIO_ROOT. The
#   trap signals only a process that is still the scenario's own (see "PIDs"
#   below).
#
# fmk mode. Sourcing also:
# - exports HOME as SCENARIO_HOME, `$SCENARIO_ROOT/home`, so no step reads or
#   writes the container user's own ~/.agent-director;
# - exports TMUX_TMPDIR as `$SCENARIO_ROOT/tmux` and unsets TMUX and
#   TMUX_PANE, so every tmux client the scenario's processes start talks to
#   the scenario's own tmux server;
# - exports a PATH that starts with the scenario's bin directory
#   (SCENARIO_BIN, `$SCENARIO_ROOT/bin`), in which `claude` is a copy of
#   fixtures/stub-claude.sh, with a copy of its MCP session client
#   fixtures/stub-mcp-session.ts beside it (see "Stub workers"), and in which
#   the stub's mode selections are kept (`stub_mode`), followed by the
#   container's PATH without every
#   directory that holds an `agent-director` (the image's default binary's
#   own directory among them) and without relative or empty entries. bun's
#   directory stays. No process of the scenario finds an agent-director on
#   PATH: the client finds the scenario HOME's at its standard path;
# - installs agent-director into the scenario HOME behind the shim
#   (fixtures/agent-director-shim.sh): by default the release candidate,
#   through its install.sh (`install_ad_rc`), which creates the HOME's store
#   with its store id; or, for a script that sets SCENARIO_AD_START=0.10.0
#   before sourcing, agent-director 0.10.0's binary (`install_ad_010`), with
#   no release-candidate install and no store yet (SCENARIO_AD_START is `rc`
#   or `0.10.0`; a shared-mode script that sets it fails);
# - writes no agent-director config.toml: agent-director's default settings;
# - once SCENARIO_PORT is picked, writes the MCP config the stub's session
#   reads, $HOME/.claude/slack-mcp.json naming that port (`write_mcp_config`),
#   which is the `mcp_config_path` a persona config defaults to;
# - installs the tmux shim (fixtures/tmux-shim.sh) for the scenario's CSCB
#   processes, in `log` mode, and starts the CSCB process record (see "CSCB
#   processes and the tmux shim").
# Keep HOME, TMUX_TMPDIR and PATH as sourcing set them. Sourcing also sets
# SCENARIO_REAL_TMUX (the real tmux, resolved before PATH changed; the trap
# stops the scenario's tmux server with it), SCENARIO_AD_BIN (the standard
# path, which holds the shim) and SCENARIO_AD_SHIM_LOG (the shim's log; its
# one line format is stated in the shim's header, and nowhere else).
#
# CSCB processes and the tmux shim (fmk mode). A CSCB process is the bot
# server, or a CLI command or driver the scenario runs (b.jg5 SRJ-1401):
# every `start` run (`run_start`, `start_server`), every `stop` run
# (`stop_server` and the trap's), every bot server they leave, and every
# command run through `cscb_run`. Each starts with the tmux shim's bin
# directory first on its PATH; agent-director inherits that PATH (the client
# passes its caller's whole environment), so every tmux call agent-director
# makes for CSCB reaches the shim. The scenario's own shell keeps the real
# tmux and never has the shim on its PATH: the harness plays the human there,
# so its agent-director calls and their tmux calls are never CSCB's.
# - The shim lives at SCENARIO_TMUX_SHIM_BIN/tmux (SCENARIO_TMUX_SHIM_BIN is
#   `$SCENARIO_ROOT/tmux-shim/bin`), with its real tmux, its mode file
#   (SCENARIO_TMUX_SHIM_MODE_FILE) and its log (SCENARIO_TMUX_SHIM_LOG) in
#   the directory above (SCENARIO_TMUX_SHIM_DIR). Its modes, mode file and
#   line format (the agent-director shim's) are stated in its header.
# - The record (SCENARIO_CSCB_RECORD, `$SCENARIO_ROOT/cscb-processes`) never
#   drops a process. One line per entry, TAB-separated:
#     proc TAB <role> TAB <pid> TAB <starttime> TAB <from> TAB <words>
#     gone TAB <pid> TAB <starttime> TAB <time>
#   <role> is `start`, `stop`, `server` or `run`; <starttime> the process's
#   start time in clock ticks since boot (/proc/<pid>/stat field 22, which
#   no later process given the same PID shares; `-` when unknown); <from>
#   and <time> are in the logs' layout (seconds, six decimals); <words> the
#   command, `printf %q`-quoted. A run records itself, in the subshell that
#   then execs the command (so the PID is the command's own), before the
#   command starts; <from> is then. A bot server is recorded once the harness
#   sees its PID in a state dir's server.pid (after every CSCB run, in
#   `start_server`, before every read of the record and in the trap); <from>
#   is its start time from /proc (never later than the true one). A `gone`
#   entry is added, with the time then, once the harness sees the process
#   ended (after each run, after `stop_server`, before every read and in the
#   trap). A log line's parent is a recorded process only when its PPID is
#   the entry's PID and its time lies in the entry's window, from <from> to
#   the earliest `gone` time (open while it runs), so a PID the system gives
#   to another process later never matches. A bot server that exits before
#   it writes its PID file (a start the server refuses) is not recorded.
# - SCENARIO_SHELL_CMDLINE is the script's own command line (/proc/$$/cmdline),
#   quoted as the shims quote a parent's: the parent field of every call the
#   scenario's shell or a subshell of it makes.
#
# Guards. Every helper below that runs agent-director, installs, moves or
# swaps an agent-director binary or the shim, or reads or edits the store
# with sqlite3 calls `require_ci_image` and then `require_scenario_home` as
# its first two steps, before any copy, move, install or sqlite3 step.
#
# Matchers (E14 decision 14). Scenario scripts assert a line's class prefix,
# persona ref and distinguishing fragments, never a whole sentence the unit
# tests own. A matcher is one or more fixed-string fragments; a line matches
# when it holds every fragment, in the given order (anything may sit between
# two fragments). A plain string is a one-fragment matcher, so every function
# below that takes a <matcher> also takes a plain fixed string. Build a
# multi-fragment matcher with `matcher`; the `*_match` builders return one.
# Fragments are fixed strings (no regex), matched unanchored: a `cwd=<dir>`
# fragment also matches a longer directory, so give no working dir a name
# that is a prefix of another's.
#
# Functions (every step that can fail calls `fail`, which prints the runner's
# `FAIL: <test>: <step>` line and exits 1; the trap then cleans up):
#
#   Steps and cleanup
#   fail <step>                        print the FAIL line and exit 1
#   on_exit <function>                 run <function> in the EXIT trap (see "Exit hooks")
#   track_pid <pid>                    kill <pid> in the EXIT trap (a background stub, for example)
#   stop_tracked_pid <pid> [<timeout-s>] [<step>]
#                                      SIGTERM <pid>, fail unless it is gone within <timeout-s>
#                                      (default 10), then stop tracking it
#
#   State dirs, ports, files
#   new_state_dir [<label>]            fresh state dir under SCENARIO_ROOT, exported as SLACK_STATE_DIR
#   free_port                          print a free loopback port (20000-29999)
#   make_workdir <name>                create and `git init` SCENARIO_ROOT/work/<name>; print its path
#   write_config                       stdin -> $SLACK_STATE_DIR/config.json, written atomically
#   write_file <path> [<mode>]         stdin -> <path>, written atomically (mode applied before the rename)
#
#   Server
#   run_start [--live]                 run `start`; set START_RC and START_OUT; never fails
#   start_server [--live]              run `start`, fail unless it exits 0 and the daemon is running; set SERVER_PID
#   stop_server [--stop-bots]          run `stop` (bounded at 90 s; 124 when it is not done by then) for
#                                      $SLACK_STATE_DIR (output in STOP_OUT); fail unless its daemon is
#                                      gone, then forget its PID
#   server_pid                         print the PID in $SLACK_STATE_DIR/server.pid (empty when none)
#   pid_alive <pid>                    true when <pid> is a live process (a zombie counts as gone)
#   port_listening <port>              true when an HTTP server answers on 127.0.0.1:<port>
#   port_closed <port>                 true when nothing answers on 127.0.0.1:<port>
#
#   Matching and counting (server.log is $SLACK_STATE_DIR/server.log)
#   matcher <fragment>...              print a matcher of the fragments, in order
#   matcher_text <matcher>             print a matcher readably (fragments joined by " … ")
#   count_in <file> <matcher>          print how many lines of <file> match (0 when no file)
#   count_log <matcher>                print how many server.log lines match (0 when no log)
#   first_log_line <matcher>           print the line number of the first matching server.log line (empty when none)
#   last_log_line <matcher>            print the line number of the last matching server.log line (empty when none)
#   expect_count <matcher> <want> <step>
#                                      fail unless exactly <want> server.log lines match
#   wait_for_log <matcher> <timeout-s> [<step>]
#   wait_for_count <matcher> <min> <timeout-s> [<step>]
#   wait_for_file <path> <timeout-s> [<step>]
#   wait_until <timeout-s> <step> <command> [<arg>...]
#
#   Line builders (each prints a matcher; see "Line builders" for the fragments)
#   persona_ref <name>                 print `"<name>" (key=<key>)` (text, not a matcher)
#   persona_start_match <index> <name>
#   skip_match <name> [<cwd>]
#   completion_match <persona-count>
#   counts [<field>=<n>]...            print the reload counts field (text, not a matcher)
#   preview_header_match [<field>=<n>]...
#   applied_match [<field>=<n>]...
#   destructive_match <name> <setting>
#   expect_completion <persona-count> <step> <part>...
#                                      fail unless the last completion line holds every "<n> <what>" part
#
#   Reload files ($SLACK_STATE_DIR/config.json.pending, .last-applied)
#   PENDING_HEADER                     line 1 of every pending file (src/reload-fingerprint.ts PENDING_FILE_HEADER)
#   pending_has_line <matcher>         true when a line of the pending file matches
#   check_pending_layout <step> [<field>=<n>]...
#                                      fail unless the pending file has the header, a sha256
#                                      fingerprint line and (with counts) a line holding `counts <field>=<n>...`
#   hold_not_applied <hold-s> <step> [<command> [<arg>...]]
#                                      for <hold-s> seconds: the record keeps its inode and bytes, no new
#                                      `[slack] reload-applied:` line, <command> stays true; then the
#                                      pending file still exists
#
#   HTTP
#   interject_status <persona> [<port>] [<body-file>]
#                                      print the HTTP status of POST /interject (000 when nothing
#                                      answers); the response body goes to <body-file> when given
#   expect_interject <persona> <status> <step> [<body-fragment>] [<port>]
#                                      fail unless POST /interject answers <status> and (when given)
#                                      its body holds <body-fragment>
#
#   Personas and tokens
#   persona_key <name>                 print the persona key the server derives from an ASCII <name>
#   fake_token <bot|app> <label>       print a fake token, built at runtime
#   count_token_like <file>...         print the number of token-like matches (never the text)
#
#   Guards (each fails with its reason, the FAIL line naming <step>)
#   require_ci_image <step>            fail unless the image marker /etc/cscb-ci-image exists
#   require_scenario_home <step>       fail unless SCENARIO_ROOT is a directory and HOME is under it,
#                                      both as written and by real path
#
#   agent-director install (fmk mode; standard path = $HOME/.agent-director/bin/agent-director,
#   the real binary beside it = <standard path>.real; each runs both guards first, and
#   each that changes the install runs `check_ad_shim` after its change, apart from
#   `hide_ad_install`, which leaves no file at the standard path to check)
#   install_ad_shim [<step>]           put the binary installed at the standard path behind the shim:
#                                      it is copied to <standard path>.real, then the shim is renamed
#                                      over the standard path (which so always holds the binary or
#                                      the shim); fails when the standard path is missing, a symlink
#                                      or already the shim
#   reshim_ad [<step>]                 the re-shim after any install.sh run (the harness's or a
#                                      runbook's own install command): `install_ad_shim`
#   install_ad_rc [<step>]             run the release candidate's install.sh in the scenario HOME
#                                      (`--binary <RC binary> --no-symlink --no-hooks`, stdin from
#                                      /dev/null, cwd HOME; output in AD_INSTALL_OUT), then `reshim_ad`;
#                                      a failed run fails the step with install.sh's output
#   install_ad_010 [<step>]            copy agent-director 0.10.0's binary to the standard path, then
#                                      `install_ad_shim` (no install.sh run, no store made)
#   swap_ad_binary <rc|0.10.0|<abs-path>> [<step>]
#                                      replace only the binary behind the shim (the release
#                                      candidate, 0.10.0, or a stand-in or wrapper file)
#   hide_ad_install [<step>]           scenario 8's not-found step: move the shim and the binary
#                                      aside together (to $SCENARIO_ROOT/ad-aside), leaving no file
#                                      at the standard path; when the binary cannot move, the shim
#                                      goes back before the step fails
#   restore_ad_install [<step>]        move both back, the binary first, then `check_ad_shim`; when
#                                      the shim cannot move, the binary goes aside again before the
#                                      step fails
#   check_ad_shim [<step>]             fail unless the standard path holds a regular file, not a
#                                      symlink, executable and carrying the shim's marker, with an
#                                      executable binary beside it that is not the shim
#
#   Harness agent-director calls (fmk mode; both guards first; run the standard path, the shim)
#   ad <arg>...                        run agent-director with <arg>...; status and output pass
#                                      through. As a plain command (not in `$( … )` or a pipeline)
#                                      its parent is the scenario's own shell ($$), as the shim logs
#   ad_capture <arg>...                the same, as a direct child of the shell; set AD_RC, AD_OUT
#                                      (stdout file) and AD_ERR (stderr file); never fails on the
#                                      call's status
#
#   The scenario store ($HOME/.agent-director/state.db; both guards first; no other store)
#   ad_store_edit <statement>          run exactly one sqlite3 statement (no `;` but one at its end);
#                                      print its output; fail with sqlite3's error
#   ad_store_id                        open the store read-only and print its store id (store_meta
#                                      key store_id); fail, saying why, unless it is 16 lowercase hex
#                                      characters (a 0.10.0 store has none)
#   ad_store_pending_no_launch <instance-id>
#                                      b.jg5 SRJ-1306's `pending` row with no launch start, made from
#                                      the row (the persona's live row) with one `ad_store_edit`
#                                      UPDATE: state `pending`; launch_started_at, launch_token, pid,
#                                      proc_starttime, pane_id, pane_pid and pane_starttime NULL;
#                                      row_version advanced by one; every other column kept. Fails
#                                      when no row has <instance-id> (the UPDATE returns none) or the
#                                      id holds a character other than letters, digits and `._:@-`;
#                                      then a harness `status` read (`ad_capture`) must read `pending`
#                                      with no launch_started_at, or it fails
#
#   Stub workers (fmk mode; fixtures/stub-claude.sh's header states the modes, the
#   SessionStart re-fire, its stop line and the MCP session; each runs both guards first)
#   STUB_MODE_DEV_CHANNELS STUB_MODE_AT_ONCE STUB_MODE_SILENT STUB_MODE_UNRECOGNISED
#   STUB_MODE_FOLDER_TRUST             the five modes' names (`dev-channels`, the default of a
#                                      directory with no selection; `at-once`; `silent`;
#                                      `unrecognised-dialog`; `folder-trust`)
#   stub_mode <dir> <mode>             select <mode> for every stub worker whose working directory is
#                                      <dir>: one `<mode> TAB <real path of dir>` line added to
#                                      $SCENARIO_BIN/stub-claude-modes (by an atomic rewrite), which
#                                      the stub reads at start-up, so it holds from the next launch or
#                                      resume in <dir> on; the last selection of a directory wins;
#                                      fails for an unknown mode, or a <dir> that is not a directory
#                                      under SCENARIO_ROOT (as written and by real path)
#   stub_press_enter <target>          a human answering a stub held at a startup dialog: send Enter
#                                      into the tmux pane <target> (a pane id such as %3, or
#                                      session[:window[.pane]], the session name matched exactly, never
#                                      as a prefix of another session's) on the scenario's own tmux server, with
#                                      the real tmux, from the scenario's own shell (never a CSCB
#                                      process); fails, with tmux's message, when tmux refuses (no
#                                      such pane, say), and refuses when TMUX_TMPDIR is not the
#                                      scenario's or TMUX is set; it does not read the pane to check
#                                      the effect
#   write_mcp_config [<port>]          write $HOME/.claude/slack-mcp.json, the MCP config the stub's
#                                      session reads, naming http://127.0.0.1:<port>/mcp under the
#                                      server name slack-channel-router, as the package's install
#                                      writes it (default <port>: SCENARIO_PORT; setup writes it so)
#
#   CSCB processes and the tmux shim (see "CSCB processes and the tmux shim")
#   cscb_run <command> [<arg>...]      run <command> as a CSCB process (a CLI command of the package
#                                      under test or another, such as scenario 1's pre-persona CLI, or
#                                      a driver): recorded (role `run`), the tmux shim first on its
#                                      PATH; standard input, output and error pass through; return its
#                                      status. <command> is a program (not a function) and is itself
#                                      the CSCB process: run it directly or through `env`, never
#                                      through `timeout`, `bash -c` or another process that would
#                                      stay its parent. Registers SLACK_STATE_DIR (when under
#                                      SCENARIO_ROOT), so the trap stops a server it leaves there.
#                                      Works in shared mode too (no shim, no record)
#   tmux_shim_mode <mode> [<delay-s>]  set the tmux shim's mode (log, fail-kill, fail-create,
#                                      slow-create, wedge; `log` from setup on), and for slow-create
#                                      or wedge its delay in seconds (the shim's defaults: 15, 60),
#                                      by an atomic write of the mode file; the next call reads it
#
#   Closing assertions and CSCB's agent-director calls (fmk mode; see "Closing assertions").
#   Each reads SCENARIO_TMUX_SHIM_LOG, SCENARIO_AD_SHIM_LOG and SCENARIO_CSCB_RECORD (a
#   subshell may point them at other files), takes only `call` lines (never a stub's `stop`
#   line), fails on a line not in the shims' format, and on failure prints each offending
#   line indented, then fails naming itself, how many lines and their numbers.
#   assert_no_server_tmux              fail on any tmux shim log line whose parent is a bot server
#                                      the scenario started; positive control: fail unless some line's
#                                      parent is an agent-director process that a CSCB process ran
#                                      (its PID that of an agent-director shim `call` line whose own
#                                      parent is a CSCB process, the latest such line at or before it,
#                                      and its argv[0] agent-director)
#   assert_no_cscb_include_finished    fail on any `kill` invocation carrying --include-finished
#                                      (`-` or `--`, with or without `=<value>`) whose parent is not the
#                                      scenario's own shell or a subshell of it (a command
#                                      substitution or pipeline element included): a parent whose
#                                      command line is the script's own (SCENARIO_SHELL_CMDLINE, quoted
#                                      as the shims quote it) and that no CSCB process held; positive
#                                      control: fail unless some invocation's parent is a bot server
#                                      the scenario started (its version probe)
#   assert_no_cscb_delete              fail on any `delete` invocation whose parent is a CSCB process
#   cscb_ad_calls <verb> [<fragment>...]
#                                      print the agent-director shim's `call` lines whose parent is a
#                                      CSCB process, whose verb is <verb> (any verb when <verb> is
#                                      empty) and whose arguments, joined by single spaces, hold every
#                                      fixed-string <fragment> in order. The verb is the first word
#                                      after agent-director's global flags (--store-path, --home,
#                                      --tmux-command, taken from anywhere in the argv); the harness's
#                                      calls, the stub's lines and its stop line never count
#   cscb_ad_count <verb> [<fragment>...]
#                                      print how many lines `cscb_ad_calls` would print
#
# Line builders (every fragment is quoted from src/; <ref> is `persona_ref`):
#   persona_start_match   `[slack] persona-start: personas[<index>] <ref>`
#                         (src/persona-bringup-controller.ts bringUp, format
#                         src/persona-diagnostics.ts formatPersonaDiagnostic)
#   skip_match            `[slack] dry-run: skipping spawn for <ref>`, then ` cwd=<cwd>` when given
#                         (src/session-manager.ts spawnForPersona)
#   completion_match      `[slack] startupSessionManager: complete — <n> persona(s):`
#                         (src/session-manager.ts startupSessionManager)
#   counts                `personas: <added> added, <removed> removed, <destructive> destructively
#                         modified, <in_place> modified in place, <credentials> with changed
#                         credentials; server-wide settings: <settings> changed`; fields
#                         added, removed, destructive, in_place, credentials, settings, each 0
#                         unless given (src/reload-plan.ts renderChangePlanCounts)
#   preview_header_match  `[slack] reload-preview: `, then the counts field
#                         (src/reload-plan.ts renderPreviewLogLines; only the header holds the counts)
#   applied_match         `[slack] reload-applied:`, then `(<counts>)`, then the record path quoted,
#                         `"<state dir>/config.json.last-applied"` (src/reload-apply.ts renderAppliedLogLine)
#   destructive_match     `DESTRUCTIVE: persona <ref>`, then ` <setting> changed` (src/reload-plan.ts
#                         destructiveLine; matches the pending-file line and its reload-preview log line)
#
# `start` runs with SLACK_BOT_TOKEN, SLACK_APP_TOKEN and CSCB_PERSONA unset,
# and with SLACK_DRY_RUN=1 unless `--live` is passed (then SLACK_DRY_RUN is
# unset). Any other variable the scenario exports reaches the daemon.
#
# Waiting: the reload tick runs 5 s after the previous pass and is not
# overridable, so wait with `wait_for_*` / `wait_until` and a stated bound,
# never with a fixed sleep. server.log is appended across starts in one state
# dir: to see a start's own lines, take `count_log` before it and
# `wait_for_count` for one more after it.
#
# PIDs: `stop_server` forgets its daemon's PID once the daemon is gone, and
# `stop_tracked_pid` forgets a tracked PID once it is gone (the CSCB process
# record keeps every CSCB process, with its window). Before the trap stops or
# kills any PID it confirms the process is still the scenario's: a child of
# this shell, or a process whose environment holds this scenario's
# SCENARIO_ROOT. A PID the system reused for another process is left alone.
#
# Closing assertions (fmk mode; b.jg5 SRJ-1401, SRJ-1418). Every fmk script
# ends with `assert_no_server_tmux`, `assert_no_cscb_include_finished` and
# `assert_no_cscb_delete`, in its own shell, whatever the tmux shim's mode.
# The trap enforces it, after it has set the shim back to `log` and stopped
# every server (its `stop` runs are CSCB processes, logged like any other):
# - a script that exits 0 without all three having passed in its own shell
#   over the scenario's own logs and record fails;
# - when all three passed, the trap runs them again over the whole logs, so a
#   violating line written after them (while the trap stopped a server, for
#   example) fails the run, its FAIL line saying it came after the closing
#   assertions.
# Shared-mode scripts (test-5 to test-12) have no closing assertions, no tmux
# shim and no record.
#
# Exit hooks: `on_exit <function>` registers extra cleanup (removing files
# outside SCENARIO_ROOT, for example). The trap runs the hooks in registration
# order, each in a subshell, after every server and tracked process is
# stopped (and, in fmk mode, the scenario's tmux server: a kill-server on
# every tmux socket under SCENARIO_ROOT, then SIGKILL for any of its tmux
# processes left; one still running fails the run) and before SCENARIO_ROOT
# is removed; on success and on failure alike. A hook that exits non-zero (or calls `fail`) turns a passing run
# into a failed one; a hook's failure never stops the rest of the cleanup.
#
# Don't call a function that can fail inside `$( … )` unless the assignment
# stands alone (`dir="$(make_workdir a)"`): `set -e` then ends the script on
# its non-zero status, and the FAIL line it printed still reaches the runner.
#
# No token literal anywhere under tests/ (tests/secrecy-audit.test.ts): fake
# tokens come only from `fake_token`, which builds them at runtime.
#
# Don't replace the EXIT trap; register a background process with
# `track_pid` and extra cleanup with `on_exit` instead.

# The image marker, before any other step: no scratch root, port or trap
# outside a cscb-ci image.
if [[ ! -e /etc/cscb-ci-image ]]; then
    echo "FAIL: ${TEST_NAME:-$(basename "$0" .sh)}: refused: /etc/cscb-ci-image is absent; scenario.sh runs only in a cscb-ci image (/ci)" >&2
    exit 1
fi

set -euo pipefail

if [[ -z "${TEST_NAME:-}" ]]; then
    TEST_NAME="$(basename "$0" .sh)"
fi

# The installed CLI (Test 1 installs the package into /test-repo).
SCENARIO_REPO="${SCENARIO_REPO:-/test-repo}"
SCENARIO_CLI="${SCENARIO_CLI:-${SCENARIO_REPO}/node_modules/.bin/claude-slack-channel-bots}"

# Poll interval of every wait, in seconds.
SCENARIO_POLL_S="0.2"

# Bound on the daemon exiting after `stop` reports success, in seconds.
SCENARIO_STOP_WAIT_S=15

# Bound on the CLI's `stop` itself, in seconds (as the trap's stop).
SCENARIO_STOP_CLI_S=90

# Lines of each server.log the trap prints when the script failed.
SCENARIO_LOG_TAIL_LINES=40

# The separator between a matcher's fragments (ASCII unit separator).
SCENARIO_SEP=$'\x1f'

# src/reload-fingerprint.ts PENDING_FILE_HEADER.
PENDING_HEADER='claude-slack-channel-bots: pending configuration change (written by the server)'

# The integration fixtures (stub-claude.sh, agent-director-shim.sh, drivers).
SCENARIO_FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fixtures" && pwd)"

# The image's agent-director files (docker/Dockerfile.test.base): the release
# candidate's binary and its install.sh (from agent-director's tree at the
# release candidate's commit), and agent-director 0.10.0's binary.
SCENARIO_RC_BIN=/opt/agent-director-rc/bin/agent-director
SCENARIO_RC_INSTALL_SH=/opt/agent-director-rc/install/install.sh
SCENARIO_AD_010_BIN=/opt/agent-director-0.10.0/bin/agent-director

# The agent-director shim and the whole line that marks it.
SCENARIO_AD_SHIM_SRC="${SCENARIO_FIXTURES}/agent-director-shim.sh"
SCENARIO_AD_SHIM_MARKER='# CSCB_CI_AGENT_DIRECTOR_SHIM_MARKER'

# Bound on each tmux kill-server the trap sends, and on the scenario's tmux
# processes exiting after it, in seconds.
SCENARIO_TMUX_STOP_S=10

# The tmux shim, the whole line that marks it, and its modes
# (fixtures/tmux-shim.sh states what each does).
SCENARIO_TMUX_SHIM_SRC="${SCENARIO_FIXTURES}/tmux-shim.sh"
SCENARIO_TMUX_SHIM_MARKER='# CSCB_CI_TMUX_SHIM_MARKER'
SCENARIO_TMUX_SHIM_MODES=(log fail-kill fail-create slow-create wedge)

# The stub worker's modes (fixtures/stub-claude.sh states what each does),
# its MCP session client, and the file of its mode selections beside it.
STUB_MODE_DEV_CHANNELS=dev-channels
STUB_MODE_AT_ONCE=at-once
STUB_MODE_SILENT=silent
STUB_MODE_UNRECOGNISED=unrecognised-dialog
STUB_MODE_FOLDER_TRUST=folder-trust
SCENARIO_STUB_MODES=("${STUB_MODE_DEV_CHANNELS}" "${STUB_MODE_AT_ONCE}" "${STUB_MODE_SILENT}"
    "${STUB_MODE_UNRECOGNISED}" "${STUB_MODE_FOLDER_TRUST}")
SCENARIO_STUB_MCP_SRC="${SCENARIO_FIXTURES}/stub-mcp-session.ts"
SCENARIO_STUB_MODES_NAME=stub-claude-modes

# The MCP server name the package's install writes into slack-mcp.json
# (src/config.ts MCP_SERVER_NAME).
SCENARIO_MCP_SERVER_NAME=slack-channel-router

# The closing assertions every fmk script ends with.
SCENARIO_CLOSING_ASSERTIONS=(assert_no_server_tmux assert_no_cscb_include_finished assert_no_cscb_delete)

# fmk mode: 1 when TEST_NAME carries `-fmk-` (set on source).
SCENARIO_FMK=0

_SCENARIO_STATE_DIRS=()   # every state dir a `start` ran in
_SCENARIO_SERVER_PIDS=()  # daemon PIDs a start reported and no stop_server saw gone
_SCENARIO_TRACKED_PIDS=() # background processes registered with track_pid
_SCENARIO_EXIT_HOOKS=()   # functions registered with on_exit
_SCENARIO_LIVE=0          # 1 once a start ran with --live
_SCENARIO_STATE_COUNT=0
_SCENARIO_START_COUNT=0
_SCENARIO_INSTALL_COUNT=0 # install.sh runs
_SCENARIO_AD_COUNT=0      # ad_capture calls
_SCENARIO_CLOSED=()       # closing assertions that passed in the script's own shell

fail() {
    echo "FAIL: ${TEST_NAME}: $1" >&2
    exit 1
}

# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

require_ci_image() {
    [[ -e /etc/cscb-ci-image ]] \
        || fail "${1:-require_ci_image}: refused: /etc/cscb-ci-image is absent; this step runs only in a cscb-ci image"
}

require_scenario_home() {
    local step="${1:-require_scenario_home}" real_root real_home
    [[ -n "${SCENARIO_ROOT:-}" && -d "${SCENARIO_ROOT}" ]] \
        || fail "${step}: refused: SCENARIO_ROOT '${SCENARIO_ROOT:-}' is not a directory"
    [[ "${HOME:-}" == "${SCENARIO_ROOT}"/* ]] \
        || fail "${step}: refused: HOME '${HOME:-}' is not under SCENARIO_ROOT ${SCENARIO_ROOT}"
    real_root="$(realpath -e -- "${SCENARIO_ROOT}" 2> /dev/null)" \
        || fail "${step}: refused: cannot resolve SCENARIO_ROOT ${SCENARIO_ROOT}"
    real_home="$(realpath -e -- "${HOME}" 2> /dev/null)" \
        || fail "${step}: refused: HOME ${HOME} does not exist"
    [[ "${real_home}" == "${real_root}"/* ]] \
        || fail "${step}: refused: HOME ${HOME} resolves to ${real_home}, which is not under SCENARIO_ROOT ${real_root}"
}

# ---------------------------------------------------------------------------
# PIDs
# ---------------------------------------------------------------------------

pid_alive() {
    local pid="$1" state
    [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
    kill -0 "${pid}" 2>/dev/null || return 1
    # A zombie is dead but still answers kill -0 until it is reaped. The
    # state is the field after the parenthesised command name.
    state="$(sed -E 's/^.*\) ([A-Za-z]).*$/\1/' "/proc/${pid}/stat" 2>/dev/null || true)"
    [[ "${state}" != "Z" ]]
}

_scenario_pid_gone() {
    ! pid_alive "$1"
}

# True when <pid> is gone or is no longer the scenario's (reused).
_scenario_pid_not_ours() {
    ! _scenario_pid_ours "$1"
}

# True when <pid> is live and still the scenario's own: a child of this
# shell, or a process whose environment names this SCENARIO_ROOT (the
# variable is exported before any process is started, so the daemons and
# every exec'd background process inherit it). A reused PID is neither.
_scenario_pid_ours() {
    local pid="$1" ppid
    pid_alive "${pid}" || return 1
    ppid="$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/${pid}/status" 2>/dev/null || true)"
    [[ "${ppid}" == "$$" ]] && return 0
    [[ -n "${SCENARIO_ROOT:-}" ]] || return 1
    { tr '\0' '\n' < "/proc/${pid}/environ"; } 2>/dev/null \
        | grep -qxF -- "SCENARIO_ROOT=${SCENARIO_ROOT}"
}

# _scenario_drop <array-name> <pid>: remove every copy of <pid> from the array.
_scenario_drop() {
    local -n _scenario_drop_list="$1"
    local keep=() p
    for p in ${_scenario_drop_list[@]+"${_scenario_drop_list[@]}"}; do
        [[ "${p}" == "$2" ]] || keep+=("${p}")
    done
    _scenario_drop_list=(${keep[@]+"${keep[@]}"})
}

# _scenario_add <array-name> <pid>: append <pid> unless the array holds it.
_scenario_add() {
    local -n _scenario_add_list="$1"
    local p
    for p in ${_scenario_add_list[@]+"${_scenario_add_list[@]}"}; do
        [[ "${p}" == "$2" ]] && return 0
    done
    _scenario_add_list+=("$2")
}

track_pid() {
    [[ "${1:-}" =~ ^[0-9]+$ ]] || fail "track_pid: '${1:-}' is not a PID"
    _scenario_add _SCENARIO_TRACKED_PIDS "$1"
}

stop_tracked_pid() {
    local pid="${1:-}" timeout_s="${2:-10}"
    local step="${3:-tracked process ${pid} did not exit on SIGTERM}"
    [[ "${pid}" =~ ^[0-9]+$ ]] || fail "stop_tracked_pid: '${pid}' is not a PID"
    _scenario_check_timeout "${timeout_s}" "${step}"
    if _scenario_pid_ours "${pid}"; then
        kill -TERM "${pid}" 2>/dev/null || true
    fi
    _scenario_poll_until "${timeout_s}" _scenario_pid_not_ours "${pid}" \
        || fail "${step} (not within ${timeout_s}s)"
    _scenario_drop _SCENARIO_TRACKED_PIDS "${pid}"
}

on_exit() {
    declare -F -- "${1:-}" > /dev/null || fail "on_exit: '${1:-}' is not a function"
    _SCENARIO_EXIT_HOOKS+=("$1")
}

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

# Stop the daemon of one state dir, if its PID file names a live process
# that is still the scenario's: the CLI `stop` first (with --stop-bots once a
# live start ran), bounded, as a CSCB process (`_scenario_cscb_bounded`),
# then SIGKILL. Never fails.
_scenario_stop_dir() {
    local dir="$1" pid
    [[ -f "${dir}/server.pid" ]] || return 0
    pid="$(tr -d '[:space:]' < "${dir}/server.pid" 2>/dev/null || true)"
    [[ "${pid}" =~ ^[0-9]+$ ]] || return 0
    _scenario_pid_ours "${pid}" || return 0
    local args=(stop)
    [[ "${_SCENARIO_LIVE}" == 1 ]] && args+=(--stop-bots)
    local -x SLACK_STATE_DIR="${dir}"
    _scenario_cscb_bounded "${SCENARIO_STOP_CLI_S}" /dev/null stop "${SCENARIO_CLI}" "${args[@]}"
    _scenario_pid_ours "${pid}" && kill -KILL "${pid}" 2>/dev/null
    return 0
}

# The trap's stop of every recorded bot server still running and still the
# scenario's (a daemon a `cscb_run` left in a state dir no start ran in, for
# example): SIGTERM, then SIGKILL after 5 s. Never fails.
_scenario_stop_recorded_servers() {
    local lines=() line kind role pid st
    [[ -f "${_SCENARIO_REAL_CSCB_RECORD:-}" ]] || return 0
    mapfile -t lines < "${_SCENARIO_REAL_CSCB_RECORD}"
    for line in ${lines[@]+"${lines[@]}"}; do
        IFS=$'\t' read -r kind role pid st _ <<< "${line}"
        [[ "${kind}" == proc && "${role}" == server ]] || continue
        [[ "$(_scenario_proc_starttime "${pid}")" == "${st}" ]] || continue
        _scenario_pid_ours "${pid}" || continue
        kill -TERM "${pid}" 2> /dev/null
        _scenario_poll_until 5 _scenario_pid_gone "${pid}" \
            || { _scenario_pid_ours "${pid}" && kill -KILL "${pid}" 2> /dev/null; }
    done
    return 0
}

# The trap's closing enforcement (fmk mode). Prints the FAIL line (or, when
# the run already failed, an indented note) and returns 1 when the script
# exited 0 without every closing assertion having passed in its own shell, or
# when a closing assertion, run again over the logs after the trap stopped
# every server, now fails. <rc> is the run's status so far.
_scenario_closing_check() {
    local rc="$1" missing=() name out recheck_rc=0 line list all
    for name in "${SCENARIO_CLOSING_ASSERTIONS[@]}"; do
        _scenario_closing_passed "${name}" || missing+=("${name}")
    done
    if (( ${#missing[@]} > 0 )); then
        (( rc == 0 )) || return 0
        printf -v list '%s, ' "${missing[@]}"
        printf -v all '%s, ' "${SCENARIO_CLOSING_ASSERTIONS[@]}"
        echo "FAIL: ${TEST_NAME}: the script exited 0 without the closing assertions (${list%, }: not passed in its own shell); every fmk script ends with ${all%, }" >&2
        return 1
    fi
    out="$( (set -e; _scenario_closing_recheck) 2>&1 )" || recheck_rc=$?
    (( recheck_rc == 0 )) && return 0
    line="$(grep -m1 '^FAIL:' <<< "${out}" || true)"
    line="${line#"FAIL: ${TEST_NAME}: "}"
    # Indented, so no line of it can pass for the runner's FAIL line.
    grep -v '^FAIL:' <<< "${out}" | sed 's/^/  | /' >&2
    if (( rc == 0 )); then
        echo "FAIL: ${TEST_NAME}: after the closing assertions: ${line:-their re-check exited ${recheck_rc}}" >&2
    else
        echo "  | after the closing assertions, also: ${line:-their re-check exited ${recheck_rc}}" >&2
    fi
    return 1
}

# The closing assertions again, over the scenario's own logs and record.
_scenario_closing_recheck() {
    SCENARIO_TMUX_SHIM_LOG="${_SCENARIO_REAL_TMUX_SHIM_LOG}"
    SCENARIO_AD_SHIM_LOG="${_SCENARIO_REAL_AD_SHIM_LOG}"
    SCENARIO_CSCB_RECORD="${_SCENARIO_REAL_CSCB_RECORD}"
    local name
    for name in "${SCENARIO_CLOSING_ASSERTIONS[@]}"; do
        "${name}"
    done
}

# Print the PID of every live process of the real tmux binary that is still
# the scenario's own (fmk mode): its tmux server and any client left running.
_scenario_tmux_pids() {
    local proc
    for proc in /proc/[0-9]*; do
        [[ "${proc}/exe" -ef "${SCENARIO_REAL_TMUX}" ]] || continue
        _scenario_pid_ours "${proc#/proc/}" && printf '%s\n' "${proc#/proc/}"
    done
    return 0
}

_scenario_tmux_gone() {
    [[ -z "$(_scenario_tmux_pids)" ]]
}

# Stop the scenario's tmux server (fmk mode), with the real tmux: a bounded
# kill-server on every tmux socket under SCENARIO_ROOT, then SIGKILL for any
# of the scenario's tmux processes still running (a server whose socket was
# moved or re-bound, say). True once none is left.
_scenario_stop_tmux() {
    local sock pid
    [[ -n "${SCENARIO_REAL_TMUX:-}" ]] || return 0
    if [[ -n "${SCENARIO_ROOT:-}" && -d "${SCENARIO_ROOT}" ]]; then
        while IFS= read -r -d '' sock; do
            timeout "${SCENARIO_TMUX_STOP_S}" "${SCENARIO_REAL_TMUX}" -S "${sock}" kill-server > /dev/null 2>&1
        done < <(find "${SCENARIO_ROOT}" -type s -path '*/tmux-[0-9]*/*' -print0 2> /dev/null)
    fi
    _scenario_poll_until "${SCENARIO_TMUX_STOP_S}" _scenario_tmux_gone && return 0
    for pid in $(_scenario_tmux_pids); do
        kill -KILL "${pid}" 2> /dev/null
    done
    _scenario_poll_until 5 _scenario_tmux_gone
}

_scenario_cleanup() {
    local rc=$? dir pid hook hook_rc
    set +e
    trap - EXIT
    if [[ "${SCENARIO_FMK}" == 1 ]]; then
        # The stops below run in `log` mode, whatever mode the script left.
        _scenario_tmux_shim_reset
        _scenario_cscb_after
    fi
    for dir in ${_SCENARIO_STATE_DIRS[@]+"${_SCENARIO_STATE_DIRS[@]}"}; do
        _scenario_stop_dir "${dir}"
    done
    for pid in ${_SCENARIO_SERVER_PIDS[@]+"${_SCENARIO_SERVER_PIDS[@]}"} \
               ${_SCENARIO_TRACKED_PIDS[@]+"${_SCENARIO_TRACKED_PIDS[@]}"}; do
        if _scenario_pid_ours "${pid}"; then
            kill -TERM "${pid}" 2>/dev/null
            _scenario_poll_until 5 _scenario_pid_gone "${pid}" \
                || { _scenario_pid_ours "${pid}" && kill -KILL "${pid}" 2>/dev/null; }
        fi
    done
    if [[ "${SCENARIO_FMK}" == 1 ]]; then
        _scenario_stop_recorded_servers
        _scenario_cscb_after
    fi
    if [[ "${SCENARIO_FMK}" == 1 ]] && ! _scenario_stop_tmux; then
        if [[ "${rc}" -eq 0 ]]; then
            echo "FAIL: ${TEST_NAME}: the scenario's tmux server outlived the trap's kill-server and SIGKILL" >&2
            rc=1
        else
            echo "  | the scenario's tmux server also outlived the trap's kill-server and SIGKILL" >&2
        fi
    fi
    if [[ "${SCENARIO_FMK}" == 1 ]] && ! _scenario_closing_check "${rc}"; then
        rc=1
    fi
    for hook in ${_SCENARIO_EXIT_HOOKS[@]+"${_SCENARIO_EXIT_HOOKS[@]}"}; do
        ( "${hook}" )
        hook_rc=$?
        if [[ "${hook_rc}" -ne 0 ]]; then
            if [[ "${rc}" -eq 0 ]]; then
                echo "FAIL: ${TEST_NAME}: exit hook ${hook} failed (exit ${hook_rc})" >&2
                rc=1
            else
                echo "  | exit hook ${hook} also failed (exit ${hook_rc})" >&2
            fi
        fi
    done
    if [[ "${rc}" -ne 0 ]]; then
        for dir in ${_SCENARIO_STATE_DIRS[@]+"${_SCENARIO_STATE_DIRS[@]}"}; do
            [[ -f "${dir}/server.log" ]] || continue
            echo "--- ${TEST_NAME}: last ${SCENARIO_LOG_TAIL_LINES} lines of ${dir}/server.log ---" >&2
            # Indented, so no dumped line can pass for the runner's FAIL line.
            tail -n "${SCENARIO_LOG_TAIL_LINES}" "${dir}/server.log" | sed 's/^/  | /' >&2
        done
    fi
    if [[ -n "${SCENARIO_ROOT:-}" && -d "${SCENARIO_ROOT}" ]]; then
        rm -rf "${SCENARIO_ROOT}"
    fi
    exit "${rc}"
}

# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------

_scenario_now_ms() {
    echo $(( $(date +%s%N) / 1000000 ))
}

# Run `<command> [<arg>...]` every SCENARIO_POLL_S until it succeeds (0) or
# <timeout-s> passes (1). The command runs once more at the deadline.
_scenario_poll_until() {
    local timeout_s="$1"; shift
    local deadline=$(( $(_scenario_now_ms) + timeout_s * 1000 ))
    while :; do
        if "$@"; then return 0; fi
        if (( $(_scenario_now_ms) >= deadline )); then
            "$@" && return 0
            return 1
        fi
        sleep "${SCENARIO_POLL_S}"
    done
}

_scenario_check_timeout() {
    [[ "$1" =~ ^[0-9]+$ ]] || fail "$2: timeout '$1' is not a whole number of seconds"
}

wait_until() {
    local timeout_s="$1" step="$2"; shift 2
    _scenario_check_timeout "${timeout_s}" "${step}"
    _scenario_poll_until "${timeout_s}" "$@" || fail "${step} (not within ${timeout_s}s)"
}

# ---------------------------------------------------------------------------
# Matchers
# ---------------------------------------------------------------------------

matcher() {
    local IFS="${SCENARIO_SEP}"
    printf '%s\n' "$*"
}

matcher_text() {
    printf '%s\n' "${1//${SCENARIO_SEP}/ … }"
}

# _scenario_scan <mode> <file> <matcher>: over the lines of <file> that hold
# every fragment of <matcher> in order, print by <mode>: `count` (how many;
# 0 when <file> is missing), `first` / `last` (the line number, empty when
# none) or `lastline` (the last such line's text). Byte-wise (LC_ALL=C), the
# fragments passed as operands, so no escape in them is interpreted.
_scenario_scan() {
    local mode="$1" file="$2" m="$3"
    if [[ ! -f "${file}" ]]; then
        [[ "${mode}" == count ]] && echo 0
        return 0
    fi
    LC_ALL=C awk '
        BEGIN {
            mode = ARGV[2]; n = split(ARGV[4], frags, ARGV[3])
            ARGV[2] = ""; ARGV[3] = ""; ARGV[4] = ""
            count = 0; first = ""; last = ""; lastline = ""
        }
        {
            rest = $0
            for (i = 1; i <= n; i++) {
                if (frags[i] == "") continue
                p = index(rest, frags[i])
                if (p == 0) next
                rest = substr(rest, p + length(frags[i]))
            }
            count++
            if (first == "") first = NR
            last = NR
            lastline = $0
        }
        END {
            if (mode == "count") print count
            else if (mode == "first") { if (first != "") print first }
            else if (mode == "last") { if (last != "") print last }
            else if (count > 0) print lastline
        }
    ' "${file}" "${mode}" "${SCENARIO_SEP}" "${m}"
}

count_in() {
    _scenario_scan count "$1" "$2"
}

count_log() {
    _scenario_scan count "${SLACK_STATE_DIR}/server.log" "$1"
}

first_log_line() {
    _scenario_scan first "${SLACK_STATE_DIR}/server.log" "$1"
}

last_log_line() {
    _scenario_scan last "${SLACK_STATE_DIR}/server.log" "$1"
}

expect_count() {
    local m="$1" want="$2" step="$3" n
    [[ "${want}" =~ ^[0-9]+$ ]] || fail "${step}: count '${want}' is not a whole number"
    n="$(count_log "${m}")"
    [[ "${n}" == "${want}" ]] \
        || fail "${step}: expected ${want} server.log line(s) matching '$(matcher_text "${m}")', found ${n}"
}

_scenario_log_has() {
    (( $(count_log "$1") > 0 ))
}

_scenario_log_count_at_least() {
    (( $(count_log "$1") >= $2 ))
}

wait_for_log() {
    local m="$1" timeout_s="$2"
    # shellcheck disable=SC2016 # the quotes are literal text in the step
    local step="${3:-server.log never showed '$(matcher_text "${m}")'}"
    _scenario_check_timeout "${timeout_s}" "${step}"
    _scenario_poll_until "${timeout_s}" _scenario_log_has "${m}" \
        || fail "${step} (not within ${timeout_s}s)"
}

wait_for_count() {
    local m="$1" min="$2" timeout_s="$3"
    # shellcheck disable=SC2016 # the quotes are literal text in the step
    local step="${4:-server.log never held ${min} line(s) matching '$(matcher_text "${m}")'}"
    [[ "${min}" =~ ^[0-9]+$ ]] || fail "${step}: count '${min}' is not a whole number"
    _scenario_check_timeout "${timeout_s}" "${step}"
    _scenario_poll_until "${timeout_s}" _scenario_log_count_at_least "${m}" "${min}" \
        || fail "${step} (not within ${timeout_s}s; found $(count_log "${m}"))"
}

wait_for_file() {
    local path="$1" timeout_s="$2"
    local step="${3:-${path} never appeared}"
    _scenario_check_timeout "${timeout_s}" "${step}"
    _scenario_poll_until "${timeout_s}" test -e "${path}" \
        || fail "${step} (not within ${timeout_s}s)"
}

# ---------------------------------------------------------------------------
# Line builders
# ---------------------------------------------------------------------------

# src/persona-identity.ts renderPersonaRef: the JSON-quoted name and the key.
# Names here hold no `"` or `\`, so the JSON quoting is plain quotes.
persona_ref() {
    local name="$1" key
    [[ "${name}" != *[\"\\]* ]] || fail "persona_ref: '${name}' holds a quote or a backslash"
    key="$(persona_key "${name}")" || exit 1
    printf '"%s" (key=%s)\n' "${name}" "${key}"
}

persona_start_match() {
    local ref
    [[ "${1:-}" =~ ^[0-9]+$ ]] || fail "persona_start_match: index '${1:-}' is not a whole number"
    ref="$(persona_ref "$2")" || exit 1
    matcher "[slack] persona-start: personas[$1] ${ref}"
}

skip_match() {
    local ref
    ref="$(persona_ref "$1")" || exit 1
    if [[ -n "${2:-}" ]]; then
        matcher "[slack] dry-run: skipping spawn for ${ref}" " cwd=$2"
    else
        matcher "[slack] dry-run: skipping spawn for ${ref}"
    fi
}

completion_match() {
    [[ "${1:-}" =~ ^[0-9]+$ ]] || fail "completion_match: persona count '${1:-}' is not a whole number"
    matcher "[slack] startupSessionManager: complete — $1 persona(s):"
}

expect_completion() {
    local n="$1" step="$2" m line part
    shift 2
    m="$(completion_match "${n}")" || exit 1
    line="$(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${m}")"
    [[ -n "${line}" ]] || fail "${step}: server.log has no line matching '$(matcher_text "${m}")'"
    # Each part is one whole "<n> <what>" field of the line, so a count
    # added to the line later does not break a scenario.
    for part in "$@"; do
        case "${line}" in
            *[:,]" ${part},"* | *[:,]" ${part}") ;;
            *) fail "${step}: completion line lacks '${part}': ${line#*\] }" ;;
        esac
    done
}

counts() {
    local added=0 removed=0 destructive=0 in_place=0 credentials=0 settings=0 spec field value
    for spec in "$@"; do
        field="${spec%%=*}"
        value="${spec#*=}"
        [[ "${spec}" == *=* && "${value}" =~ ^[0-9]+$ ]] \
            || fail "counts: '${spec}' is not <field>=<whole number>"
        case "${field}" in
            added) added="${value}" ;;
            removed) removed="${value}" ;;
            destructive) destructive="${value}" ;;
            in_place) in_place="${value}" ;;
            credentials) credentials="${value}" ;;
            settings) settings="${value}" ;;
            *) fail "counts: unknown field '${field}'" ;;
        esac
    done
    printf 'personas: %s added, %s removed, %s destructively modified, %s modified in place, %s with changed credentials; server-wide settings: %s changed\n' \
        "${added}" "${removed}" "${destructive}" "${in_place}" "${credentials}" "${settings}"
}

preview_header_match() {
    local c
    c="$(counts "$@")" || exit 1
    matcher '[slack] reload-preview: ' "${c}"
}

applied_match() {
    local c
    c="$(counts "$@")" || exit 1
    matcher '[slack] reload-applied:' "(${c})" "\"${SLACK_STATE_DIR}/config.json.last-applied\""
}

destructive_match() {
    local ref
    [[ -n "${2:-}" ]] || fail "destructive_match: no setting given"
    ref="$(persona_ref "$1")" || exit 1
    matcher "DESTRUCTIVE: persona ${ref}" " $2 changed"
}

# ---------------------------------------------------------------------------
# Reload files
# ---------------------------------------------------------------------------

pending_has_line() {
    (( $(count_in "${SLACK_STATE_DIR}/config.json.pending" "$1") > 0 ))
}

check_pending_layout() {
    local step="$1" pending="${SLACK_STATE_DIR}/config.json.pending" c
    shift
    [[ -f "${pending}" ]] || fail "${step}: ${pending} is missing"
    [[ "$(sed -n '1p' "${pending}")" == "${PENDING_HEADER}" ]] \
        || fail "${step}: pending file line 1 is not the server's header"
    [[ "$(sed -n '2p' "${pending}")" =~ ^fingerprint:\ sha256:[0-9a-f]{64}$ ]] \
        || fail "${step}: pending file line 2 is not 'fingerprint: sha256:<64 hex>'"
    if (( $# > 0 )); then
        c="$(counts "$@")" || exit 1
        pending_has_line "${c}" || fail "${step}: pending file lacks the counts '${c}'"
    fi
}

# One poll of hold_not_applied (0 while nothing is applied): the record
# keeps the inode and bytes it had when the hold began, the reload-applied
# count is unchanged, and the extra command, if any, holds.
_scenario_hold_ok() {
    local record="$1" snapshot="$2" inode="$3" applied="$4"; shift 4
    [[ "$(stat -c '%i' "${record}" 2>/dev/null || true)" == "${inode}" ]] || {
        _SCENARIO_HOLD_WHY="config.json.last-applied was rewritten"; return 1; }
    cmp -s -- "${snapshot}" "${record}" || {
        _SCENARIO_HOLD_WHY="config.json.last-applied changed"; return 1; }
    (( $(count_log '[slack] reload-applied:') == applied )) || {
        _SCENARIO_HOLD_WHY="a reload-applied line was logged"; return 1; }
    if (( $# > 0 )) && ! "$@"; then
        _SCENARIO_HOLD_WHY="'$*' stopped holding"; return 1
    fi
    return 0
}

hold_not_applied() {
    local hold_s="$1" step="$2"; shift 2
    local record="${SLACK_STATE_DIR}/config.json.last-applied"
    local pending="${SLACK_STATE_DIR}/config.json.pending"
    local snapshot="${SCENARIO_ROOT}/hold.last-applied" inode applied deadline
    _scenario_check_timeout "${hold_s}" "${step}"
    [[ -f "${record}" ]] || fail "${step}: ${record} is missing at the start of the hold"
    cp -- "${record}" "${snapshot}" || fail "${step}: could not snapshot ${record}"
    inode="$(stat -c '%i' "${record}")" || fail "${step}: could not stat ${record}"
    applied="$(count_log '[slack] reload-applied:')"
    _SCENARIO_HOLD_WHY=""
    deadline=$(( $(_scenario_now_ms) + hold_s * 1000 ))
    while (( $(_scenario_now_ms) < deadline )); do
        _scenario_hold_ok "${record}" "${snapshot}" "${inode}" "${applied}" "$@" \
            || fail "${step}: ${_SCENARIO_HOLD_WHY} before a confirmation"
        sleep "${SCENARIO_POLL_S}"
    done
    _scenario_hold_ok "${record}" "${snapshot}" "${inode}" "${applied}" "$@" \
        || fail "${step}: ${_SCENARIO_HOLD_WHY} before a confirmation"
    [[ -e "${pending}" ]] || fail "${step}: config.json.pending vanished before a confirmation"
}

# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------

server_pid() {
    local file="${SLACK_STATE_DIR}/server.pid"
    [[ -f "${file}" ]] || return 0
    # The file can vanish under a stop between the test and the read.
    tr -d '[:space:]' < "${file}" 2> /dev/null || true
    echo
}

_scenario_pid_file_live() {
    local pid
    pid="$(server_pid)"
    [[ -n "${pid}" ]] && pid_alive "${pid}"
}

_scenario_register_state_dir() {
    local dir
    for dir in ${_SCENARIO_STATE_DIRS[@]+"${_SCENARIO_STATE_DIRS[@]}"}; do
        [[ "${dir}" == "$1" ]] && return 0
    done
    _SCENARIO_STATE_DIRS+=("$1")
}

run_start() {
    local live=0
    case "${1:-}" in
        --live) live=1 ;;
        "") ;;
        *) fail "run_start: unknown option '$1'" ;;
    esac
    [[ "${SLACK_STATE_DIR}" == "${SCENARIO_ROOT}"/* ]] \
        || fail "run_start: SLACK_STATE_DIR ${SLACK_STATE_DIR} is not under ${SCENARIO_ROOT}"
    _SCENARIO_START_COUNT=$(( _SCENARIO_START_COUNT + 1 ))
    START_OUT="${SCENARIO_ROOT}/start.${_SCENARIO_START_COUNT}.out"
    # Registered before the start: a start that reports failure may still
    # leave a daemon behind, and the trap stops it.
    _scenario_register_state_dir "${SLACK_STATE_DIR}"
    local env_args=(-u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u CSCB_PERSONA -u SLACK_DRY_RUN)
    if [[ "${live}" == 1 ]]; then
        _SCENARIO_LIVE=1
    else
        env_args+=(SLACK_DRY_RUN=1)
    fi
    set +e
    (cd "${SCENARIO_REPO}" && _scenario_cscb_exec start env "${env_args[@]}" "${SCENARIO_CLI}" start) > "${START_OUT}" 2>&1
    START_RC=$?
    set -e
    local pid
    pid="$(server_pid)"
    if [[ -n "${pid}" ]]; then
        _scenario_add _SCENARIO_SERVER_PIDS "${pid}"
    fi
    _scenario_cscb_after || fail "run_start: could not update the CSCB process record"
    return 0
}

start_server() {
    run_start "$@"
    if [[ "${START_RC}" -ne 0 ]]; then
        cat "${START_OUT}" >&2
        fail "start in ${SLACK_STATE_DIR} exited ${START_RC}"
    fi
    # `start` returns once the daemon wrote its PID file (it is then
    # listening), or after 30 s with the daemon still starting.
    _scenario_poll_until 30 _scenario_pid_file_live || {
        cat "${START_OUT}" >&2
        fail "no live daemon in ${SLACK_STATE_DIR}/server.pid after start"
    }
    SERVER_PID="$(server_pid)"
    _scenario_add _SCENARIO_SERVER_PIDS "${SERVER_PID}"
    # The trap signals only the scenario's own processes: a daemon it could
    # not recognise would outlive the script.
    _scenario_pid_ours "${SERVER_PID}" \
        || fail "daemon PID ${SERVER_PID} does not carry this scenario's SCENARIO_ROOT"
    _scenario_cscb_after || fail "start_server: could not update the CSCB process record"
}

stop_server() {
    local args=(stop) rc
    case "${1:-}" in
        --stop-bots) args+=(--stop-bots) ;;
        "") ;;
        *) fail "stop_server: unknown option '$1'" ;;
    esac
    [[ "${SLACK_STATE_DIR}" == "${SCENARIO_ROOT}"/* ]] \
        || fail "stop_server: SLACK_STATE_DIR ${SLACK_STATE_DIR} is not under ${SCENARIO_ROOT}"
    local pid
    STOP_OUT="${SCENARIO_ROOT}/stop.out"
    pid="$(server_pid)"
    [[ -n "${pid}" ]] || fail "stop: no server.pid in ${SLACK_STATE_DIR}"
    _scenario_cscb_after || fail "stop_server: could not update the CSCB process record"
    _scenario_cscb_bounded "${SCENARIO_STOP_CLI_S}" "${STOP_OUT}" stop "${SCENARIO_CLI}" "${args[@]}"
    rc="${_SCENARIO_BOUNDED_RC}"
    if [[ "${rc}" -ne 0 ]]; then
        cat "${STOP_OUT}" >&2
        if [[ "${rc}" -eq 124 ]]; then
            fail "${args[*]} in ${SLACK_STATE_DIR} did not finish within ${SCENARIO_STOP_CLI_S}s"
        fi
        fail "${args[*]} in ${SLACK_STATE_DIR} exited ${rc}"
    fi
    _scenario_poll_until "${SCENARIO_STOP_WAIT_S}" _scenario_pid_gone "${pid}" \
        || fail "server PID ${pid} still running ${SCENARIO_STOP_WAIT_S}s after ${args[*]}"
    # Gone: the trap must never signal this PID, which the system may reuse.
    # The CSCB process record keeps it, with the time it was seen gone.
    _scenario_drop _SCENARIO_SERVER_PIDS "${pid}"
    _scenario_cscb_after || fail "stop_server: could not update the CSCB process record"
}

# ---------------------------------------------------------------------------
# CSCB processes: the tmux shim on their PATH, and their record (fmk mode)
# ---------------------------------------------------------------------------

# Print the start time of <pid> (field 22 of /proc/<pid>/stat, clock ticks
# since boot; it survives exec and differs for any later process given the
# same PID); nothing when there is no such process.
_scenario_proc_starttime() {
    local stat rest fields=()
    { read -r stat < "/proc/$1/stat"; } 2> /dev/null || return 0
    # The fields after the parenthesised command name start at field 3.
    rest="${stat##*) }"
    read -r -a fields <<< "${rest}"
    [[ "${fields[19]:-}" =~ ^[0-9]+$ ]] && printf '%s\n' "${fields[19]}"
    return 0
}

# Print the wall-clock time a process with start time <ticks> started, in
# the log lines' layout (seconds, six decimals), rounded down: /proc/stat's
# btime is whole seconds, so this is never later than the true start.
_scenario_start_epoch() {
    local us=$(( _SCENARIO_BTIME * 1000000 + $1 * 1000000 / _SCENARIO_CLK_TCK ))
    printf '%d.%06d\n' $(( us / 1000000 )) $(( us % 1000000 ))
}

# Append one line to the CSCB process record, under its lock.
_scenario_record_append() {
    { flock -x 9 && printf '%s\n' "$1" >&9; } 9>> "${_SCENARIO_REAL_CSCB_RECORD}"
}

# _scenario_record_proc <role> <pid> <starttime> <from> [<word>...]: record
# one CSCB process.
_scenario_record_proc() {
    local role="$1" pid="$2" st="$3" from="$4" words="" line
    shift 4
    if (( $# > 0 )); then
        printf -v words '%q ' "$@"
        words="${words% }"
    fi
    printf -v line 'proc\t%s\t%s\t%s\t%s\t%s' "${role}" "${pid}" "${st}" "${from}" "${words}"
    _scenario_record_append "${line}"
}

# True when the record holds a <role> entry for <pid> with <starttime>.
_scenario_record_has() {
    local needle
    printf -v needle 'proc\t%s\t%s\t%s\t' "$1" "$2" "$3"
    grep -qF -- "${needle}" "${_SCENARIO_REAL_CSCB_RECORD}" 2> /dev/null
}

# _scenario_cscb_exec <role> <command> [<arg>...]: become a CSCB process. Run
# only in a subshell of its own, `( _scenario_cscb_exec … )`, which it
# replaces: in fmk mode it records the subshell (its PID, start time, and the
# time now) under <role>, puts the tmux shim's bin directory first on PATH
# and execs <command>, which keeps that PID; in shared mode it only execs.
# <command> must be a program (not a function), and is itself the CSCB
# process: run it directly, or through `env`, which execs it in turn.
_scenario_cscb_exec() {
    local role="$1"
    shift
    if [[ "${SCENARIO_FMK}" == 1 ]]; then
        local me="${BASHPID}" st
        st="$(_scenario_proc_starttime "${me}")"
        if ! _scenario_record_proc "${role}" "${me}" "${st:--}" "${EPOCHREALTIME/,/.}" "$@"; then
            echo "FAIL: ${TEST_NAME}: could not record the ${role} run in ${_SCENARIO_REAL_CSCB_RECORD}; it did not run" >&2
            exit 70
        fi
        PATH="${SCENARIO_TMUX_SHIM_BIN}:${PATH}"
        export PATH
    fi
    exec "$@"
}

# Record every bot server a state dir's server.pid names (the registered
# dirs and SLACK_STATE_DIR) that is live, still the scenario's and not yet
# recorded, as role `server`, from its own start time. False when the record
# cannot be written.
_scenario_note_servers() {
    [[ "${SCENARIO_FMK}" == 1 && -n "${_SCENARIO_REAL_CSCB_RECORD:-}" ]] || return 0
    local dirs=(${_SCENARIO_STATE_DIRS[@]+"${_SCENARIO_STATE_DIRS[@]}"}) dir pid st argv=()
    [[ -n "${SLACK_STATE_DIR:-}" ]] && dirs+=("${SLACK_STATE_DIR}")
    for dir in ${dirs[@]+"${dirs[@]}"}; do
        [[ -f "${dir}/server.pid" ]] || continue
        pid="$(tr -d '[:space:]' < "${dir}/server.pid" 2> /dev/null || true)"
        [[ "${pid}" =~ ^[0-9]+$ ]] || continue
        _scenario_pid_ours "${pid}" || continue
        st="$(_scenario_proc_starttime "${pid}")"
        [[ -n "${st}" ]] || continue
        _scenario_record_has server "${pid}" "${st}" && continue
        argv=()
        mapfile -d '' -t argv 2> /dev/null < "/proc/${pid}/cmdline" || true
        _scenario_record_proc server "${pid}" "${st}" "$(_scenario_start_epoch "${st}")" \
            ${argv[@]+"${argv[@]}"} || return 1
    done
    return 0
}

# For every recorded process with no `gone` entry that is no longer running
# as the same process (gone, or its PID now another process's), append one
# with the time now. False when the record cannot be written.
_scenario_record_sweep() {
    [[ "${SCENARIO_FMK}" == 1 && -f "${_SCENARIO_REAL_CSCB_RECORD:-}" ]] || return 0
    local lines=() line kind a b c key pid st
    local -A open=() gone=()
    mapfile -t lines < "${_SCENARIO_REAL_CSCB_RECORD}"
    for line in ${lines[@]+"${lines[@]}"}; do
        IFS=$'\t' read -r kind a b c _ <<< "${line}"
        case "${kind}" in
            proc) open["${b}:${c}"]=1 ;;
            gone) gone["${a}:${b}"]=1 ;;
        esac
    done
    for key in "${!open[@]}"; do
        [[ -z "${gone[${key}]:-}" ]] || continue
        pid="${key%%:*}"
        st="${key#*:}"
        if [[ "${st}" == - || "$(_scenario_proc_starttime "${pid}")" != "${st}" ]]; then
            printf -v line 'gone\t%s\t%s\t%s' "${pid}" "${st}" "${EPOCHREALTIME/,/.}"
            _scenario_record_append "${line}" || return 1
        fi
    done
    return 0
}

# After any CSCB run, and before any read of the record: note new bot
# servers, then close the entries of processes that ended.
_scenario_cscb_after() {
    _scenario_note_servers && _scenario_record_sweep
}

# _scenario_cscb_bounded <timeout-s> <out-file> <role> <command> [<arg>...]:
# run <command> as a CSCB process (`_scenario_cscb_exec`), standard input
# from /dev/null and output to <out-file>; SIGTERM it after <timeout-s>, and
# SIGKILL 5 s later. Sets _SCENARIO_BOUNDED_RC (124 when it timed out, as
# `timeout` does). In shared mode it runs `timeout <timeout-s> <command>`, as
# the helpers always did. Never fails.
_scenario_cscb_bounded() {
    local timeout_s="$1" out="$2" role="$3" pid
    shift 3
    _SCENARIO_BOUNDED_RC=0
    if [[ "${SCENARIO_FMK}" != 1 ]]; then
        timeout "${timeout_s}" "$@" > "${out}" 2>&1 || _SCENARIO_BOUNDED_RC=$?
        return 0
    fi
    # `timeout` would itself be the process the record holds, not the CSCB
    # command, so the bound is kept here.
    ( _scenario_cscb_exec "${role}" "$@" ) < /dev/null > "${out}" 2>&1 &
    pid=$!
    if _scenario_poll_until "${timeout_s}" _scenario_pid_gone "${pid}"; then
        wait "${pid}" || _SCENARIO_BOUNDED_RC=$?
    else
        kill -TERM "${pid}" 2> /dev/null || true
        _scenario_poll_until 5 _scenario_pid_gone "${pid}" || kill -KILL "${pid}" 2> /dev/null || true
        wait "${pid}" 2> /dev/null || true
        _SCENARIO_BOUNDED_RC=124
    fi
    return 0
}

cscb_run() {
    (( $# > 0 )) || fail "cscb_run: no command given"
    local rc=0
    # The trap stops a daemon the command leaves in this state dir.
    if [[ -n "${SLACK_STATE_DIR:-}" && "${SLACK_STATE_DIR}" == "${SCENARIO_ROOT}"/* ]]; then
        _scenario_register_state_dir "${SLACK_STATE_DIR}"
    fi
    ( _scenario_cscb_exec run "$@" ) || rc=$?
    _scenario_cscb_after || fail "cscb_run: could not update the CSCB process record"
    return "${rc}"
}

tmux_shim_mode() {
    local mode="${1:-}" delay="${2:-}" m known=0
    [[ "${SCENARIO_FMK}" == 1 ]] || fail "tmux_shim_mode: the tmux shim is for fmk scripts only"
    for m in "${SCENARIO_TMUX_SHIM_MODES[@]}"; do
        [[ "${m}" == "${mode}" ]] && known=1
    done
    (( known )) || fail "tmux_shim_mode: unknown mode '${mode}' (${SCENARIO_TMUX_SHIM_MODES[*]})"
    if [[ -n "${delay}" ]]; then
        [[ "${mode}" == slow-create || "${mode}" == wedge ]] \
            || fail "tmux_shim_mode: mode ${mode} takes no delay"
        [[ "${delay}" =~ ^[0-9]+(\.[0-9]+)?$ ]] \
            || fail "tmux_shim_mode: delay '${delay}' is not a number of seconds"
    fi
    write_file "${SCENARIO_TMUX_SHIM_MODE_FILE}" <<< "${mode}${delay:+ ${delay}}"
}

# The trap's reset of the tmux shim to `log`. Never fails.
_scenario_tmux_shim_reset() {
    local file="${SCENARIO_TMUX_SHIM_MODE_FILE:-}"
    [[ -n "${file}" && -d "${file%/*}" ]] || return 0
    { printf 'log\n' > "${file}.trap" && mv -f -- "${file}.trap" "${file}"; } 2> /dev/null
    return 0
}

# ---------------------------------------------------------------------------
# State dirs, ports, files
# ---------------------------------------------------------------------------

new_state_dir() {
    _SCENARIO_STATE_COUNT=$(( _SCENARIO_STATE_COUNT + 1 ))
    local dir="${SCENARIO_ROOT}/state-${1:-${_SCENARIO_STATE_COUNT}}"
    [[ ! -e "${dir}" ]] || fail "new_state_dir: ${dir} already exists"
    mkdir -p "${dir}" || fail "new_state_dir: could not create ${dir}"
    export SLACK_STATE_DIR="${dir}"
}

free_port() {
    python3 - << 'EOF' || fail "free_port: no free port found in 20000-29999"
import random, socket, sys
# Outside the ephemeral range, so an outgoing connection can't take it later.
for port in random.sample(range(20000, 30000), 200):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
    except OSError:
        continue
    finally:
        s.close()
    print(port)
    sys.exit(0)
sys.exit(1)
EOF
}

make_workdir() {
    local dir="${SCENARIO_ROOT}/work/$1"
    mkdir -p "${dir}" || fail "make_workdir: could not create ${dir}"
    git -C "${dir}" init -q || fail "make_workdir: git init failed in ${dir}"
    printf '%s\n' "${dir}"
}

write_file() {
    local path="$1" mode="${2:-}"
    local tmp
    tmp="$(mktemp "$(dirname "${path}")/.scenario-write.XXXXXX")" \
        || fail "write_file: could not create a temp file beside ${path}"
    cat > "${tmp}" || fail "write_file: could not write ${path}"
    if [[ -n "${mode}" ]]; then
        chmod "${mode}" "${tmp}" || fail "write_file: chmod ${mode} failed for ${path}"
    fi
    # One rename, so a reload tick never reads a half-written file.
    mv -f "${tmp}" "${path}" || fail "write_file: could not rename into ${path}"
}

write_config() {
    write_file "${SLACK_STATE_DIR}/config.json"
}

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

interject_status() {
    local persona="$1" port="${2:-${SCENARIO_PORT}}" out="${3:-/dev/null}" body
    body="$(python3 -c 'import json, sys; print(json.dumps({"persona": sys.argv[1], "message": sys.argv[2]}))' \
        "${persona}" "${TEST_NAME} interject")"
    curl -s --max-time 10 -o "${out}" -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' -d "${body}" \
        "http://127.0.0.1:${port}/interject" || true
}

expect_interject() {
    local persona="$1" want="$2" step="$3" fragment="${4:-}" port="${5:-${SCENARIO_PORT}}"
    local out="${SCENARIO_ROOT}/interject.out" code
    rm -f -- "${out}"
    code="$(interject_status "${persona}" "${port}" "${out}")"
    [[ "${code}" == "${want}" ]] \
        || fail "${step}: /interject for ${persona} returned ${code}, expected ${want}"
    if [[ -n "${fragment}" ]] && ! grep -qF -- "${fragment}" "${out}" 2>/dev/null; then
        fail "${step}: /interject for ${persona} answered ${code} without '${fragment}'"
    fi
}

port_listening() {
    local code
    code="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/" || true)"
    [[ -n "${code}" && "${code}" != "000" ]]
}

port_closed() {
    ! port_listening "$1"
}

# ---------------------------------------------------------------------------
# Personas and tokens
# ---------------------------------------------------------------------------

# The key rule of src/persona-identity.ts personaKey (b.av2 SR-2.1), written
# out independently so the scenarios check the server against the rule, not
# against its own code. ASCII names only.
persona_key() {
    local name="$1" stem suffix
    if [[ "${name}" == *$'\n'* ]] || LC_ALL=C grep -q '[^ -~]' <<< "${name}"; then
        fail "persona_key: '${name}' is not printable ASCII"
    fi
    if [[ "${name}" =~ ^[a-z0-9_]{1,40}$ ]]; then
        printf '%s\n' "${name}"
        return 0
    fi
    suffix="$(printf '%s' "${name}" | sha256sum | cut -c1-8)"
    stem="$(printf '%s' "${name}" | LC_ALL=C tr '[:upper:]' '[:lower:]' \
        | LC_ALL=C sed -E 's/[^a-z0-9_]+/_/g; s/^_+//; s/_+$//')"
    stem="${stem:0:40}"
    if [[ -z "${stem}" ]]; then
        printf '%s\n' "${suffix}"
    else
        printf '%s_%s\n' "${stem}" "${suffix}"
    fi
}

# A fake token of a real token's shape: the prefix, a dash, the digit 1, the
# marker SCENARIOFAKE, then a dash and <label>. The prefix and the dash are
# joined only at runtime, so this file holds no token-like literal.
fake_token() {
    local prefix
    case "$1" in
        bot) prefix='xoxb' ;;
        app) prefix='xapp' ;;
        *) fail "fake_token: kind must be bot or app, not '$1'" ;;
    esac
    [[ "${2:-}" =~ ^[A-Za-z0-9]+$ ]] || fail "fake_token: label must be letters and digits"
    printf '%s-1SCENARIOFAKE-%s\n' "${prefix}" "$2"
}

# tests/test-helpers/credentials.ts TOKEN_LIKE, as an ERE (no look-behind):
# a Slack prefix not glued to a preceding letter or digit, a dash, then a
# letter or digit. Prints the count only, never the matched text. A missing
# file counts 0.
count_token_like() {
    local file total=0 n
    for file in "$@"; do
        [[ -f "${file}" ]] || continue
        n="$({ grep -oE '(^|[^A-Za-z0-9])(xox[a-z]|xapp)-[A-Za-z0-9]' "${file}" || true; } | wc -l)"
        total=$(( total + n ))
    done
    echo "${total}"
}

# ---------------------------------------------------------------------------
# agent-director install, shim and harness calls (fmk mode)
# ---------------------------------------------------------------------------

# True when <file> carries the shim's marker line.
_scenario_is_shim() {
    grep -qxF -- "${SCENARIO_AD_SHIM_MARKER}" "$1" 2> /dev/null
}

# _scenario_place <src> <dest> <step>: copy <src> beside <dest>, make it
# 0755 and rename it over <dest>, so <dest> is never half written. Refuses
# outside the image and for a <dest> outside SCENARIO_ROOT.
_scenario_place() {
    local src="$1" dest="$2" step="$3" tmp
    require_ci_image "${step}"
    [[ -n "${SCENARIO_ROOT:-}" && "${dest}" == "${SCENARIO_ROOT}"/* ]] \
        || fail "${step}: refused: ${dest} is not under SCENARIO_ROOT ${SCENARIO_ROOT:-}"
    tmp="$(mktemp "$(dirname "${dest}")/.scenario-place.XXXXXX")" \
        || fail "${step}: could not create a temp file beside ${dest}"
    cp -- "${src}" "${tmp}" || fail "${step}: could not copy ${src} beside ${dest}"
    chmod 0755 "${tmp}" || fail "${step}: chmod 0755 failed beside ${dest}"
    mv -f -- "${tmp}" "${dest}" || fail "${step}: could not rename into ${dest}"
}

check_ad_shim() {
    local step="${1:-the agent-director shim check}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    local path="${HOME}/.agent-director/bin/agent-director"
    local real="${path}.real"
    [[ -e "${path}" || -L "${path}" ]] || fail "${step}: no file at ${path}"
    [[ ! -L "${path}" ]] || fail "${step}: ${path} is a symlink, not the shim"
    [[ -f "${path}" ]] || fail "${step}: ${path} is not a regular file"
    _scenario_is_shim "${path}" || fail "${step}: ${path} does not carry the shim's marker"
    [[ -x "${path}" ]] || fail "${step}: the shim at ${path} is not executable"
    [[ -f "${real}" && ! -L "${real}" && -x "${real}" ]] \
        || fail "${step}: no executable regular file behind the shim at ${real}"
    ! _scenario_is_shim "${real}" || fail "${step}: the file behind the shim at ${real} is the shim itself"
}

install_ad_shim() {
    local step="${1:-install the agent-director shim}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    local path="${HOME}/.agent-director/bin/agent-director"
    [[ -f "${SCENARIO_AD_SHIM_SRC}" ]] && _scenario_is_shim "${SCENARIO_AD_SHIM_SRC}" \
        || fail "${step}: the shim ${SCENARIO_AD_SHIM_SRC} is missing or carries no marker"
    [[ -e "${path}" || -L "${path}" ]] || fail "${step}: no binary installed at ${path}"
    [[ ! -L "${path}" ]] || fail "${step}: ${path} is a symlink, not an installed binary"
    [[ -f "${path}" ]] || fail "${step}: ${path} is not a regular file"
    ! _scenario_is_shim "${path}" || fail "${step}: ${path} is already the shim; no binary to put behind it"
    # Copy the binary to .real, then rename the shim over the standard path:
    # each is a copy-and-rename, so the standard path always holds the binary
    # or the shim, and a failure at either leaves the binary in place.
    _scenario_place "${path}" "${path}.real" "${step}"
    _scenario_place "${SCENARIO_AD_SHIM_SRC}" "${path}" "${step}"
    check_ad_shim "${step}"
}

reshim_ad() {
    local step="${1:-re-shim after install.sh}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    install_ad_shim "${step}"
}

install_ad_rc() {
    local step="${1:-install the release candidate with its install.sh}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    local rc=0 last
    [[ -f "${SCENARIO_RC_INSTALL_SH}" && -x "${SCENARIO_RC_INSTALL_SH}" ]] \
        || fail "${step}: the release candidate's install.sh is missing from the image (${SCENARIO_RC_INSTALL_SH})"
    [[ -f "${SCENARIO_RC_BIN}" && -x "${SCENARIO_RC_BIN}" ]] \
        || fail "${step}: the release candidate's binary is missing from the image (${SCENARIO_RC_BIN})"
    _SCENARIO_INSTALL_COUNT=$(( _SCENARIO_INSTALL_COUNT + 1 ))
    AD_INSTALL_OUT="${SCENARIO_ROOT}/install-sh.${_SCENARIO_INSTALL_COUNT}.out"
    (cd "${HOME}" && "${SCENARIO_RC_INSTALL_SH}" --binary "${SCENARIO_RC_BIN}" --no-symlink --no-hooks) \
        < /dev/null > "${AD_INSTALL_OUT}" 2>&1 || rc=$?
    if [[ "${rc}" -ne 0 ]]; then
        # Indented, so no line of it can pass for the runner's FAIL line.
        sed 's/^/  | /' "${AD_INSTALL_OUT}" >&2
        # install.sh starts its own error lines with `install.sh:`.
        last="$(grep '^install\.sh:' "${AD_INSTALL_OUT}" | tail -n 1 || true)"
        [[ -n "${last}" ]] || last="$(grep -v '^[[:space:]]*$' "${AD_INSTALL_OUT}" | tail -n 1 || true)"
        fail "${step}: install.sh exited ${rc}: ${last:-no output}"
    fi
    reshim_ad "${step}: re-shim"
}

install_ad_010() {
    local step="${1:-install agent-director 0.10.0}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    local root="${HOME}/.agent-director"
    [[ -f "${SCENARIO_AD_010_BIN}" && -x "${SCENARIO_AD_010_BIN}" ]] \
        || fail "${step}: agent-director 0.10.0's binary is missing from the image (${SCENARIO_AD_010_BIN})"
    mkdir -p "${root}/bin" || fail "${step}: could not create ${root}/bin"
    # Five-digit modes, as install.sh sets them: they also clear a setgid bit
    # inherited from /tmp.
    chmod 00700 "${root}" && chmod 00755 "${root}/bin" || fail "${step}: could not set the modes of ${root}"
    _scenario_place "${SCENARIO_AD_010_BIN}" "${root}/bin/agent-director" "${step}"
    install_ad_shim "${step}"
}

swap_ad_binary() {
    local what="${1:-}"
    local step="${2:-swap the binary behind the agent-director shim to ${1:-}}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    local src
    case "${what}" in
        rc) src="${SCENARIO_RC_BIN}" ;;
        0.10.0) src="${SCENARIO_AD_010_BIN}" ;;
        /*) src="${what}" ;;
        *) fail "${step}: '${what}' is not rc, 0.10.0 or an absolute path" ;;
    esac
    [[ -f "${src}" && -x "${src}" ]] || fail "${step}: ${src} is not an executable file"
    ! _scenario_is_shim "${src}" || fail "${step}: ${src} is the shim, not a binary"
    check_ad_shim "${step}: the shim before the swap"
    _scenario_place "${src}" "${HOME}/.agent-director/bin/agent-director.real" "${step}"
    check_ad_shim "${step}"
}

hide_ad_install() {
    local step="${1:-move the agent-director shim and binary aside}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    local path="${HOME}/.agent-director/bin/agent-director"
    local aside="${SCENARIO_ROOT}/ad-aside"
    [[ ! -e "${aside}" ]] || fail "${step}: ${aside} already exists (hidden twice?)"
    check_ad_shim "${step}: the shim before hiding"
    mkdir -p "${aside}" || fail "${step}: could not create ${aside}"
    # The shim first, so the client never finds the standard path without it.
    mv -- "${path}" "${aside}/agent-director" || fail "${step}: could not move ${path} aside"
    if ! mv -- "${path}.real" "${aside}/agent-director.real"; then
        # Put the shim back, so a failed hide leaves the install as it was.
        mv -- "${aside}/agent-director" "${path}" && rmdir -- "${aside}" \
            || fail "${step}: could not move ${path}.real aside, nor put the shim back from ${aside}: the install is half hidden"
        fail "${step}: could not move ${path}.real aside (the shim is back at ${path})"
    fi
    [[ ! -e "${path}" && ! -L "${path}" ]] || fail "${step}: a file is still at ${path}"
}

restore_ad_install() {
    local step="${1:-restore the agent-director shim and binary}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    local path="${HOME}/.agent-director/bin/agent-director"
    local aside="${SCENARIO_ROOT}/ad-aside"
    [[ -f "${aside}/agent-director" && -f "${aside}/agent-director.real" ]] \
        || fail "${step}: nothing hidden in ${aside}"
    [[ ! -e "${path}" && ! -L "${path}" ]] || fail "${step}: a file is already at ${path}"
    # The binary first, so the shim never runs without one behind it.
    mv -- "${aside}/agent-director.real" "${path}.real" || fail "${step}: could not restore ${path}.real"
    if ! mv -- "${aside}/agent-director" "${path}"; then
        # Move the binary aside again, so a failed restore leaves the install hidden.
        mv -- "${path}.real" "${aside}/agent-director.real" \
            || fail "${step}: could not restore ${path}, nor move ${path}.real back to ${aside}: the install is half restored"
        fail "${step}: could not restore ${path} (the install is still hidden in ${aside})"
    fi
    rmdir -- "${aside}" || fail "${step}: could not remove ${aside}"
    check_ad_shim "${step}"
}

ad() {
    require_ci_image "ad $*"
    require_scenario_home "ad $*"
    "${HOME}/.agent-director/bin/agent-director" "$@"
}

ad_capture() {
    require_ci_image "ad_capture $*"
    require_scenario_home "ad_capture $*"
    _SCENARIO_AD_COUNT=$(( _SCENARIO_AD_COUNT + 1 ))
    AD_OUT="${SCENARIO_ROOT}/ad.${_SCENARIO_AD_COUNT}.out"
    AD_ERR="${SCENARIO_ROOT}/ad.${_SCENARIO_AD_COUNT}.err"
    AD_RC=0
    "${HOME}/.agent-director/bin/agent-director" "$@" > "${AD_OUT}" 2> "${AD_ERR}" || AD_RC=$?
}

# ---------------------------------------------------------------------------
# The scenario store
# ---------------------------------------------------------------------------

# Bound on waiting for agent-director's lock on the store, in milliseconds.
SCENARIO_STORE_BUSY_MS=5000

ad_store_edit() {
    require_ci_image "ad_store_edit"
    require_scenario_home "ad_store_edit"
    local db="${HOME}/.agent-director/state.db" statement out
    (( $# == 1 )) || fail "ad_store_edit: takes one statement, not $# arguments"
    statement="$1"
    # One statement: no `;` but an optional one at its end.
    statement="${statement%"${statement##*[![:space:]]}"}"
    statement="${statement%;}"
    [[ "${statement}" =~ [^[:space:]] ]] || fail "ad_store_edit: the statement is empty"
    [[ "${statement}" != *';'* ]] \
        || fail "ad_store_edit: '$1' is more than one statement (a ';' before its end)"
    [[ -f "${db}" ]] || fail "ad_store_edit: no store at ${db}"
    out="$(sqlite3 -batch -bail -cmd ".timeout ${SCENARIO_STORE_BUSY_MS}" "${db}" "${statement};" 2>&1)" \
        || fail "ad_store_edit: sqlite3 failed on '${statement}': ${out//$'\n'/ }"
    if [[ -n "${out}" ]]; then
        printf '%s\n' "${out}"
    fi
}

ad_store_id() {
    require_ci_image "ad_store_id"
    require_scenario_home "ad_store_id"
    local db="${HOME}/.agent-director/state.db" out
    [[ -f "${db}" ]] || fail "ad_store_id: no store at ${db}"
    out="$(sqlite3 -batch -bail -readonly -cmd ".timeout ${SCENARIO_STORE_BUSY_MS}" "${db}" \
        "SELECT value FROM store_meta WHERE key = 'store_id';" 2>&1)" \
        || fail "ad_store_id: ${db} has no readable store id (a store from before store ids, such as 0.10.0's, has no store_meta table): ${out//$'\n'/ }"
    [[ -n "${out}" ]] || fail "ad_store_id: ${db}'s store_meta has no store_id row"
    [[ "${out}" =~ ^[0-9a-f]{16}$ ]] \
        || fail "ad_store_id: ${db}'s store id '${out//$'\n'/ }' is not 16 lowercase hex characters"
    printf '%s\n' "${out}"
}

ad_store_pending_no_launch() {
    require_ci_image "ad_store_pending_no_launch"
    require_scenario_home "ad_store_pending_no_launch"
    local id="${1:-}" step out
    step="ad_store_pending_no_launch ${id}"
    [[ "${id}" =~ ^[A-Za-z0-9._:@-]+$ ]] \
        || fail "${step}: instance id '${id}' is empty or holds a character other than letters, digits and ._:@-"
    # One statement; RETURNING names the row it changed, so no row is seen.
    out="$(ad_store_edit "UPDATE spawns SET state = 'pending', launch_started_at = NULL, launch_token = NULL, pid = NULL, proc_starttime = NULL, pane_id = NULL, pane_pid = NULL, pane_starttime = NULL, row_version = row_version + 1 WHERE claude_instance_id = '${id}' RETURNING claude_instance_id")" \
        || exit 1
    [[ "${out}" == "${id}" ]] || fail "${step}: no row has instance id ${id}"
    ad_capture status --claude-instance-id "${id}"
    [[ "${AD_RC}" == 0 ]] \
        || fail "${step}: the harness status read exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
    jq -e 'type == "object" and .state == "pending" and (has("launch_started_at") | not)' "${AD_OUT}" > /dev/null 2>&1 \
        || fail "${step}: after the edit the row does not read pending with no launch start: $(tr '\n' ' ' < "${AD_OUT}")"
}

# ---------------------------------------------------------------------------
# Stub workers (fmk mode)
# ---------------------------------------------------------------------------

stub_mode() {
    local dir="${1:-}" mode="${2:-}" step m known=0 real_root real_dir file tmp
    step="stub_mode ${dir} ${mode}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    [[ "${SCENARIO_FMK}" == 1 ]] || fail "${step}: stub modes are for fmk scripts only"
    for m in "${SCENARIO_STUB_MODES[@]}"; do
        [[ "${m}" == "${mode}" ]] && known=1
    done
    (( known )) || fail "${step}: unknown mode '${mode}' (${SCENARIO_STUB_MODES[*]})"
    [[ "${dir}" == "${SCENARIO_ROOT}"/* ]] \
        || fail "${step}: refused: ${dir} is not under SCENARIO_ROOT ${SCENARIO_ROOT}"
    [[ -d "${dir}" ]] || fail "${step}: ${dir} is not a directory"
    real_root="$(realpath -e -- "${SCENARIO_ROOT}" 2> /dev/null)" \
        || fail "${step}: cannot resolve SCENARIO_ROOT ${SCENARIO_ROOT}"
    real_dir="$(realpath -e -- "${dir}" 2> /dev/null)" || fail "${step}: cannot resolve ${dir}"
    [[ "${real_dir}" == "${real_root}"/* ]] \
        || fail "${step}: refused: ${dir} resolves to ${real_dir}, which is not under SCENARIO_ROOT ${real_root}"
    [[ "${real_dir}" != *[$'\t\n']* ]] || fail "${step}: ${real_dir} holds a TAB or a newline"
    file="${SCENARIO_BIN}/${SCENARIO_STUB_MODES_NAME}"
    tmp="$(mktemp "${SCENARIO_BIN}/.scenario-stub-modes.XXXXXX")" \
        || fail "${step}: could not create a temp file beside ${file}"
    {
        if [[ -f "${file}" ]]; then
            cat -- "${file}"
        fi
        printf '%s\t%s\n' "${mode}" "${real_dir}"
    } > "${tmp}" || fail "${step}: could not write ${tmp}"
    # One rename, so a starting stub never reads a half-written file.
    mv -f -- "${tmp}" "${file}" || fail "${step}: could not rename into ${file}"
}

stub_press_enter() {
    local target="${1:-}" step err exact rc=0
    step="stub_press_enter ${target}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    [[ "${SCENARIO_FMK}" == 1 ]] || fail "${step}: the scenario's tmux server is for fmk scripts only"
    [[ -n "${target}" ]] || fail "${step}: no pane named"
    [[ "${TMUX_TMPDIR:-}" == "${SCENARIO_ROOT}/tmux" ]] \
        || fail "${step}: refused: TMUX_TMPDIR '${TMUX_TMPDIR:-}' is not the scenario's ${SCENARIO_ROOT}/tmux"
    [[ -z "${TMUX:-}" ]] || fail "${step}: refused: TMUX is set, naming another tmux server"
    # A pane id is exact; a session name is matched exactly (tmux's `=`, and a
    # `:` so it is read as a session, never as a window or a name prefix).
    case "${target}" in
        %*) exact="${target}" ;;
        *:*) exact="=${target}" ;;
        *) exact="=${target}:" ;;
    esac
    err="${SCENARIO_ROOT}/stub-press-enter.err"
    "${SCENARIO_REAL_TMUX}" send-keys -t "${exact}" Enter 2> "${err}" || rc=$?
    (( rc == 0 )) || fail "${step}: tmux send-keys exited ${rc}: $(tr '\n' ' ' < "${err}")"
}

write_mcp_config() {
    local port="${1:-${SCENARIO_PORT:-}}" step dir
    step="write_mcp_config ${port}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    [[ "${port}" =~ ^[1-9][0-9]*$ ]] && (( port <= 65535 )) || fail "${step}: '${port}' is not a port"
    dir="${HOME}/.claude"
    mkdir -p "${dir}" || fail "${step}: could not create ${dir}"
    write_file "${dir}/slack-mcp.json" << EOF
{
  "mcpServers": {
    "${SCENARIO_MCP_SERVER_NAME}": {
      "type": "http",
      "url": "http://127.0.0.1:${port}/mcp"
    }
  }
}
EOF
}

# ---------------------------------------------------------------------------
# Reading the shim logs against the CSCB process record (fmk mode)
# ---------------------------------------------------------------------------

# _scenario_to_us <time>: set _SCENARIO_US to <time> (seconds with exactly six
# decimals) in whole microseconds; false for any other text.
_scenario_to_us() {
    [[ "$1" =~ ^([0-9]+)\.([0-9]{6})$ ]] || return 1
    _SCENARIO_US=$(( 10#${BASH_REMATCH[1]} * 1000000 + 10#${BASH_REMATCH[2]} ))
}

# _scenario_record_load <record>: load <record> into _SR_ROLE, _SR_FROM and
# _SR_UNTIL (microseconds; _SR_UNTIL empty while the process runs), one
# element per `proc` entry, and _SR_BY_PID (PID -> its entries' indices).
# An entry's window runs from its `from` time to the earliest `gone` time of
# the same PID and start time.
_scenario_record_load() {
    local file="$1" lines=() line kind a b c d key i=0
    local -A gone=()
    _SR_ROLE=()
    _SR_FROM=()
    _SR_UNTIL=()
    declare -gA _SR_BY_PID=()
    [[ -f "${file}" ]] || return 0
    mapfile -t lines < "${file}"
    for line in ${lines[@]+"${lines[@]}"}; do
        IFS=$'\t' read -r kind a b c _ <<< "${line}"
        [[ "${kind}" == gone ]] && _scenario_to_us "${c}" || continue
        key="${a}:${b}"
        if [[ -z "${gone[${key}]:-}" ]] || (( _SCENARIO_US < gone[${key}] )); then
            gone["${key}"]="${_SCENARIO_US}"
        fi
    done
    for line in ${lines[@]+"${lines[@]}"}; do
        IFS=$'\t' read -r kind a b c d _ <<< "${line}"
        [[ "${kind}" == proc && "${b}" =~ ^[0-9]+$ ]] && _scenario_to_us "${d}" || continue
        _SR_ROLE[i]="${a}"
        _SR_FROM[i]="${_SCENARIO_US}"
        _SR_UNTIL[i]="${gone[${b}:${c}]:-}"
        _SR_BY_PID["${b}"]+=" ${i}"
        i=$(( i + 1 ))
    done
}

# _scenario_role_at <pid> <us>: set _SCENARIO_ROLE to the role of the
# recorded CSCB process that held <pid> at <us> (`server` first); false, and
# empty, when none did. A PID matches only inside its entry's window, so a
# later process given the same PID never matches.
_scenario_role_at() {
    local pid="$1" us="$2" i
    _SCENARIO_ROLE=""
    for i in ${_SR_BY_PID[${pid}]:-}; do
        (( us >= _SR_FROM[i] )) || continue
        [[ -z "${_SR_UNTIL[i]}" ]] || (( us <= _SR_UNTIL[i] )) || continue
        _SCENARIO_ROLE="${_SR_ROLE[i]}"
        [[ "${_SCENARIO_ROLE}" == server ]] && return 0
    done
    [[ -n "${_SCENARIO_ROLE}" ]]
}

# _scenario_split_line <line>: split a shim log line into _L_KIND, _L_US
# (its time in microseconds), _L_PID, _L_PPID, _L_PARENT and _L_RAW_WORDS
# (the quoted fields); false unless it has the format's six fields with a
# time, PID and PPID of the format's shape.
_scenario_split_line() {
    local rest="$1" f=()
    while [[ "${rest}" == *$'\t'* ]]; do
        f+=("${rest%%$'\t'*}")
        rest="${rest#*$'\t'}"
    done
    f+=("${rest}")
    (( ${#f[@]} == 6 )) || return 1
    [[ "${f[2]}" =~ ^[0-9]+$ && "${f[3]}" =~ ^[0-9]+$ ]] || return 1
    _scenario_to_us "${f[1]}" || return 1
    _L_KIND="${f[0]}"
    _L_US="${_SCENARIO_US}"
    _L_PID="${f[2]}"
    _L_PPID="${f[3]}"
    _L_PARENT="${f[4]}"
    _L_RAW_WORDS="${f[5]}"
}

# _scenario_eval_words <array-name> <field>: set the array to the words a
# quoted field gives back, as the shims' headers say (`eval`); false, the
# array empty, when the field does not parse. The field is parsed first in a
# subshell of its own: a parse error in `eval` ends the subshell it runs in,
# so in the caller's own subshell (a command substitution, or the trap's
# re-check) it would end that one with no FAIL line.
_scenario_eval_words() {
    local -n _scenario_eval_words_out="$1"
    _scenario_eval_words_out=()
    ( eval "_scenario_eval_words_probe=($2)" ) > /dev/null 2>&1 || return 1
    eval "_scenario_eval_words_out=($2)" 2> /dev/null
}

# Decode _L_RAW_WORDS into _L_WORDS; false when the field does not decode.
_scenario_decode_words() {
    _scenario_eval_words _L_WORDS "${_L_RAW_WORDS}"
}

# Set _L_VERB and _L_ARGS from _L_WORDS: agent-director's global flags
# (--store-path, --home, --tmux-command, each `--flag value` or
# `--flag=value`, which agent-director takes from anywhere in its argv) are
# dropped; the first word left is the verb, the rest its arguments.
_scenario_ad_verb() {
    local w skip=0 rest=()
    for w in ${_L_WORDS[@]+"${_L_WORDS[@]}"}; do
        if (( skip )); then
            skip=0
            continue
        fi
        case "${w}" in
            --store-path | --home | --tmux-command) skip=1; continue ;;
            --store-path=* | --home=* | --tmux-command=*) continue ;;
        esac
        rest+=("${w}")
    done
    _L_VERB="${rest[0]:-}"
    _L_ARGS=("${rest[@]:1}")
}

# _scenario_read_log <step> <log> <array-name>: read <log>'s lines into the
# array (none when the log is missing); fail, naming <step> and the line,
# when a line is not in the shims' format.
_scenario_read_log() {
    local step="$1" log="$2" i
    local -n _scenario_read_log_lines="$3"
    _scenario_read_log_lines=()
    [[ -f "${log}" ]] || return 0
    mapfile -t _scenario_read_log_lines < "${log}"
    for i in "${!_scenario_read_log_lines[@]}"; do
        if ! _scenario_split_line "${_scenario_read_log_lines[i]}" \
            || { [[ "${_L_KIND}" == call ]] && ! _scenario_decode_words; }; then
            echo "  | ${log##*/}:$(( i + 1 )): ${_scenario_read_log_lines[i]}" >&2
            fail "${step}: ${log} line $(( i + 1 )) is not in the shims' line format"
        fi
    done
}

# _scenario_query_prep <step>: refuse outside fmk mode; on the scenario's own
# record, note new bot servers and close ended entries first; then load the
# record in SCENARIO_CSCB_RECORD.
_scenario_query_prep() {
    [[ "${SCENARIO_FMK}" == 1 ]] || fail "$1: the shim logs and the CSCB process record are for fmk scripts only"
    if [[ "${SCENARIO_CSCB_RECORD}" == "${_SCENARIO_REAL_CSCB_RECORD}" ]]; then
        _scenario_cscb_after || fail "$1: could not update the CSCB process record"
    fi
    _scenario_record_load "${SCENARIO_CSCB_RECORD}"
}

# _scenario_offending <step> <log> <what> <line-number>...: print each
# offending line of <log>, indented, then fail naming <step>, how many and
# their line numbers.
_scenario_offending() {
    local step="$1" log="$2" what="$3" nr list=""
    shift 3
    for nr in "$@"; do
        echo "  | ${log##*/}:${nr}: $(sed -n "${nr}p" "${log}")" >&2
        list+="${list:+, }${nr}"
    done
    fail "${step}: $# ${log##*/} line(s) ${what} (line ${list})"
}

# Mark <name> as a closing assertion that passed, when it ran in the
# script's own shell over the scenario's own logs and record.
_scenario_closing_ran() {
    [[ "${BASHPID}" == "$$" ]] || return 0
    [[ "${SCENARIO_TMUX_SHIM_LOG}" == "${_SCENARIO_REAL_TMUX_SHIM_LOG}" \
        && "${SCENARIO_AD_SHIM_LOG}" == "${_SCENARIO_REAL_AD_SHIM_LOG}" \
        && "${SCENARIO_CSCB_RECORD}" == "${_SCENARIO_REAL_CSCB_RECORD}" ]] || return 0
    _scenario_add _SCENARIO_CLOSED "$1"
}

_scenario_closing_passed() {
    local name
    for name in ${_SCENARIO_CLOSED[@]+"${_SCENARIO_CLOSED[@]}"}; do
        [[ "${name}" == "$1" ]] && return 0
    done
    return 1
}

assert_no_server_tmux() {
    local step=assert_no_server_tmux ad_lines=() tmux_lines=() bad=() i j best entry control=0 parent=()
    # Each agent-director call line by its PID: "<us>:<1 when a CSCB process ran it, else 0>".
    local -A ad_calls=()
    _scenario_query_prep "${step}"
    _scenario_read_log "${step}" "${SCENARIO_AD_SHIM_LOG}" ad_lines
    _scenario_read_log "${step}" "${SCENARIO_TMUX_SHIM_LOG}" tmux_lines
    for i in "${!ad_lines[@]}"; do
        _scenario_split_line "${ad_lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        if _scenario_role_at "${_L_PPID}" "${_L_US}"; then
            ad_calls["${_L_PID}"]+=" ${_L_US}:1"
        else
            ad_calls["${_L_PID}"]+=" ${_L_US}:0"
        fi
    done
    for i in "${!tmux_lines[@]}"; do
        _scenario_split_line "${tmux_lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        if _scenario_role_at "${_L_PPID}" "${_L_US}" && [[ "${_SCENARIO_ROLE}" == server ]]; then
            bad+=("$(( i + 1 ))")
            continue
        fi
        (( control )) && continue
        # The positive control: the parent is the agent-director process of
        # the latest call line with its PID at or before this line, that call
        # was a CSCB process's, and the parent's argv[0] is agent-director.
        best=""
        for entry in ${ad_calls[${_L_PPID}]:-}; do
            (( ${entry%:*} <= _L_US )) || continue
            if [[ -z "${best}" ]] || (( ${entry%:*} >= ${best%:*} )); then
                best="${entry}"
            fi
        done
        [[ "${best}" == *:1 && "${_L_PARENT}" != '?' ]] || continue
        _scenario_eval_words parent "${_L_PARENT}" || continue
        j="${parent[0]:-}"
        if [[ "${j##*/}" == agent-director || "${j##*/}" == agent-director.real ]]; then
            control=1
        fi
    done
    (( ${#bad[@]} == 0 )) \
        || _scenario_offending "${step}" "${SCENARIO_TMUX_SHIM_LOG}" "have a bot server the scenario started as their parent" "${bad[@]}"
    (( control )) \
        || fail "${step}: positive control: no line of ${SCENARIO_TMUX_SHIM_LOG} (${#tmux_lines[@]} line(s)) has as its parent an agent-director process that a CSCB process ran, so the tmux shim's log shows no tmux call agent-director made for CSCB"
    _scenario_closing_ran "${step}"
}

assert_no_cscb_include_finished() {
    local step=assert_no_cscb_include_finished lines=() bad=() i a control=0 finished
    _scenario_query_prep "${step}"
    _scenario_read_log "${step}" "${SCENARIO_AD_SHIM_LOG}" lines
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        if _scenario_role_at "${_L_PPID}" "${_L_US}" && [[ "${_SCENARIO_ROLE}" == server ]]; then
            control=1
        fi
        _scenario_decode_words
        _scenario_ad_verb
        [[ "${_L_VERB}" == kill ]] || continue
        finished=0
        for a in ${_L_ARGS[@]+"${_L_ARGS[@]}"}; do
            [[ "${a}" =~ ^--?include-finished(=.*)?$ ]] && finished=1
        done
        (( finished )) || continue
        # The scenario's own shell, or a subshell of it (a command
        # substitution or a pipeline element included): a parent with the
        # script's own command line that no CSCB process held.
        if [[ "${_L_PARENT}" == "${SCENARIO_SHELL_CMDLINE}" ]] \
            && ! _scenario_role_at "${_L_PPID}" "${_L_US}"; then
            continue
        fi
        bad+=("$(( i + 1 ))")
    done
    (( ${#bad[@]} == 0 )) \
        || _scenario_offending "${step}" "${SCENARIO_AD_SHIM_LOG}" "run kill with --include-finished from a parent other than the scenario's own shell or a subshell of it" "${bad[@]}"
    (( control )) \
        || fail "${step}: positive control: no invocation in ${SCENARIO_AD_SHIM_LOG} (${#lines[@]} line(s)) has a bot server the scenario started as its parent (its version probe), so the shim's log shows no call CSCB made"
    _scenario_closing_ran "${step}"
}

assert_no_cscb_delete() {
    local step=assert_no_cscb_delete lines=() bad=() i
    _scenario_query_prep "${step}"
    _scenario_read_log "${step}" "${SCENARIO_AD_SHIM_LOG}" lines
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        _scenario_role_at "${_L_PPID}" "${_L_US}" || continue
        _scenario_decode_words
        _scenario_ad_verb
        if [[ "${_L_VERB}" == delete ]]; then
            bad+=("$(( i + 1 ))")
        fi
    done
    (( ${#bad[@]} == 0 )) \
        || _scenario_offending "${step}" "${SCENARIO_AD_SHIM_LOG}" "run delete from a CSCB process" "${bad[@]}"
    _scenario_closing_ran "${step}"
}

# _scenario_cscb_ad_scan <step> <print|count> <verb> [<fragment>...]: over the
# agent-director shim's `call` lines whose parent is a CSCB process, the ones
# whose verb is <verb> (any verb when empty) and whose arguments, joined by
# single spaces, hold every fragment in order: print them, or how many.
_scenario_cscb_ad_scan() {
    local step="$1" mode="$2" verb="$3" lines=() i n=0 rest frag ok
    shift 3
    _scenario_query_prep "${step}"
    _scenario_read_log "${step}" "${SCENARIO_AD_SHIM_LOG}" lines
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        _scenario_role_at "${_L_PPID}" "${_L_US}" || continue
        _scenario_decode_words
        _scenario_ad_verb
        [[ -z "${verb}" || "${_L_VERB}" == "${verb}" ]] || continue
        printf -v rest '%s ' ${_L_ARGS[@]+"${_L_ARGS[@]}"}
        rest="${rest% }"
        ok=1
        for frag in "$@"; do
            if [[ "${rest}" != *"${frag}"* ]]; then
                ok=0
                break
            fi
            rest="${rest#*"${frag}"}"
        done
        (( ok )) || continue
        n=$(( n + 1 ))
        if [[ "${mode}" == print ]]; then
            printf '%s\n' "${lines[i]}"
        fi
    done
    if [[ "${mode}" == count ]]; then
        echo "${n}"
    fi
}

cscb_ad_calls() {
    _scenario_cscb_ad_scan "cscb_ad_calls" print "${1-}" "${@:2}"
}

cscb_ad_count() {
    _scenario_cscb_ad_scan "cscb_ad_count" count "${1-}" "${@:2}"
}

# ---------------------------------------------------------------------------
# fmk mode setup
# ---------------------------------------------------------------------------

# Print PATH without relative or empty entries and without every directory
# that holds an `agent-director`.
_scenario_path_without_ad() {
    local dirs=() keep=() dir
    IFS=: read -r -a dirs <<< "${PATH}"
    for dir in ${dirs[@]+"${dirs[@]}"}; do
        [[ "${dir}" == /* ]] || continue
        [[ -e "${dir}/agent-director" || -L "${dir}/agent-director" ]] && continue
        keep+=("${dir}")
    done
    local IFS=:
    printf '%s\n' "${keep[*]}"
}

_scenario_fmk_setup() {
    case "${SCENARIO_AD_START:=rc}" in
        rc | 0.10.0) ;;
        *) fail "SCENARIO_AD_START '${SCENARIO_AD_START}' is neither rc nor 0.10.0" ;;
    esac
    SCENARIO_REAL_TMUX="$(command -v tmux || true)"
    [[ "${SCENARIO_REAL_TMUX}" == /* ]] || fail "tmux not on PATH (base image prerequisite)"
    command -v bun > /dev/null 2>&1 || fail "bun not on PATH (base image prerequisite)"
    [[ -f "${SCENARIO_FIXTURES}/stub-claude.sh" ]] \
        || fail "stub-claude fixture missing at ${SCENARIO_FIXTURES}/stub-claude.sh"

    SCENARIO_HOME="${SCENARIO_ROOT}/home"
    SCENARIO_BIN="${SCENARIO_ROOT}/bin"
    mkdir -p "${SCENARIO_HOME}" "${SCENARIO_BIN}" "${SCENARIO_ROOT}/tmux" \
        || fail "could not create the scenario's HOME, bin and tmux directories"
    chmod 00700 "${SCENARIO_ROOT}/tmux" || fail "could not set the mode of ${SCENARIO_ROOT}/tmux"
    _scenario_place "${SCENARIO_FIXTURES}/stub-claude.sh" "${SCENARIO_BIN}/claude" "the stub claude"
    [[ -f "${SCENARIO_STUB_MCP_SRC}" ]] \
        || fail "stub MCP session client missing at ${SCENARIO_STUB_MCP_SRC}"
    _scenario_place "${SCENARIO_STUB_MCP_SRC}" "${SCENARIO_BIN}/${SCENARIO_STUB_MCP_SRC##*/}" "the stub's MCP session client"

    # The tmux shim, its real tmux, its mode (`log`) and its log, for the
    # CSCB processes' PATH only; the scenario's own shell keeps the real tmux.
    SCENARIO_TMUX_SHIM_DIR="${SCENARIO_ROOT}/tmux-shim"
    SCENARIO_TMUX_SHIM_BIN="${SCENARIO_TMUX_SHIM_DIR}/bin"
    SCENARIO_TMUX_SHIM_MODE_FILE="${SCENARIO_TMUX_SHIM_DIR}/mode"
    SCENARIO_TMUX_SHIM_LOG="${SCENARIO_TMUX_SHIM_DIR}/tmux-shim.log"
    [[ -f "${SCENARIO_TMUX_SHIM_SRC}" ]] && grep -qxF -- "${SCENARIO_TMUX_SHIM_MARKER}" "${SCENARIO_TMUX_SHIM_SRC}" \
        || fail "fmk setup: the tmux shim ${SCENARIO_TMUX_SHIM_SRC} is missing or carries no marker"
    mkdir -p "${SCENARIO_TMUX_SHIM_BIN}" || fail "fmk setup: could not create ${SCENARIO_TMUX_SHIM_BIN}"
    _scenario_place "${SCENARIO_TMUX_SHIM_SRC}" "${SCENARIO_TMUX_SHIM_BIN}/tmux" "fmk setup: the tmux shim"
    ln -s -- "${SCENARIO_REAL_TMUX}" "${SCENARIO_TMUX_SHIM_DIR}/tmux.real" \
        || fail "fmk setup: could not link the real tmux beside the tmux shim"
    tmux_shim_mode log

    # The CSCB process record, and what reading it needs: the script's own
    # command line (as the shims quote a parent's) and the clock of /proc.
    SCENARIO_CSCB_RECORD="${SCENARIO_ROOT}/cscb-processes"
    : > "${SCENARIO_CSCB_RECORD}" || fail "fmk setup: could not create ${SCENARIO_CSCB_RECORD}"
    local shell_argv=()
    mapfile -d '' -t shell_argv < "/proc/$$/cmdline" && (( ${#shell_argv[@]} > 0 )) \
        || fail "fmk setup: could not read the script's own command line"
    printf -v SCENARIO_SHELL_CMDLINE '%q ' "${shell_argv[@]}"
    SCENARIO_SHELL_CMDLINE="${SCENARIO_SHELL_CMDLINE% }"
    _SCENARIO_BTIME="$(sed -n 's/^btime //p' /proc/stat)"
    _SCENARIO_CLK_TCK="$(getconf CLK_TCK)"
    [[ "${_SCENARIO_BTIME}" =~ ^[0-9]+$ && "${_SCENARIO_CLK_TCK}" =~ ^[1-9][0-9]*$ ]] \
        || fail "fmk setup: could not read the boot time and clock tick from /proc/stat and getconf"

    export HOME="${SCENARIO_HOME}"
    export TMUX_TMPDIR="${SCENARIO_ROOT}/tmux"
    unset TMUX TMUX_PANE
    PATH="${SCENARIO_BIN}:$(_scenario_path_without_ad)"
    export PATH
    hash -r

    ! command -v agent-director > /dev/null 2>&1 \
        || fail "an agent-director is still on the scenario's PATH: $(command -v agent-director)"
    command -v bun > /dev/null 2>&1 || fail "bun dropped from the scenario's PATH"
    [[ "$(command -v claude || true)" == "${SCENARIO_BIN}/claude" ]] \
        || fail "claude resolves to '$(command -v claude || true)', not the stub ${SCENARIO_BIN}/claude"

    SCENARIO_AD_BIN="${HOME}/.agent-director/bin/agent-director"
    SCENARIO_AD_SHIM_LOG="${HOME}/.agent-director/bin/agent-director-shim.log"
    # The files the closing enforcement reads, whatever a script later sets
    # SCENARIO_TMUX_SHIM_LOG, SCENARIO_AD_SHIM_LOG or SCENARIO_CSCB_RECORD to.
    _SCENARIO_REAL_TMUX_SHIM_LOG="${SCENARIO_TMUX_SHIM_LOG}"
    _SCENARIO_REAL_AD_SHIM_LOG="${SCENARIO_AD_SHIM_LOG}"
    _SCENARIO_REAL_CSCB_RECORD="${SCENARIO_CSCB_RECORD}"
    if [[ "${SCENARIO_AD_START}" == 0.10.0 ]]; then
        install_ad_010 "fmk setup: install agent-director 0.10.0"
    else
        install_ad_rc "fmk setup: install the release candidate"
        [[ -f "${HOME}/.agent-director/state.db" ]] \
            || fail "fmk setup: the release candidate's install.sh made no store at ${HOME}/.agent-director/state.db"
    fi
}

# ---------------------------------------------------------------------------
# Setup (runs on source)
# ---------------------------------------------------------------------------

[[ "${TEST_NAME}" =~ ^test-([0-9]+)- ]] \
    || fail "TEST_NAME '${TEST_NAME}' is not test-<N>-<name>"
SCENARIO_TAG="t${BASH_REMATCH[1]}"
export SCENARIO_TAG

command -v python3 > /dev/null 2>&1 || fail "python3 not on PATH (base image prerequisite)"
command -v curl > /dev/null 2>&1 || fail "curl not on PATH (base image prerequisite)"
[[ -x "${SCENARIO_CLI}" ]] \
    || fail "installed CLI ${SCENARIO_CLI} missing or not executable (Test 1 prerequisite)"

SCENARIO_ROOT="$(mktemp -d "/tmp/${TEST_NAME}.XXXXXX")" \
    || fail "could not create the scenario's scratch root"
export SCENARIO_ROOT
trap _scenario_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "${TEST_NAME}" == *-fmk-* ]]; then
    SCENARIO_FMK=1
    _scenario_fmk_setup
elif [[ -n "${SCENARIO_AD_START:-}" ]]; then
    fail "SCENARIO_AD_START is for fmk scripts only (a TEST_NAME carrying -fmk-)"
fi

new_state_dir main
SCENARIO_PORT="$(free_port)"
export SCENARIO_PORT
if [[ "${SCENARIO_FMK}" == 1 ]]; then
    write_mcp_config "${SCENARIO_PORT}"
fi
