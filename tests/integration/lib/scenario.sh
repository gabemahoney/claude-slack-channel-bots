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
#   (fixtures/agent-director-shim.sh): by default the release, through its
#   install.sh (`install_ad_release`), which creates the HOME's store with its
#   store id and installs agent-director-admin, behind the same shim, at
#   $HOME/.agent-director/admin/agent-director-admin; or, for a script that
#   sets SCENARIO_AD_START=0.10.0 before sourcing, agent-director 0.10.0's
#   binary (`install_ad_010`), with no release install, no agent-director-admin
#   and no store yet (SCENARIO_AD_START is `release` or `0.10.0`; a
#   shared-mode script that sets it fails);
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
# swaps an agent-director binary or the shim, reads or edits the store with
# sqlite3, or plays a human's tmux step, seeds a session or label, or runs the
# find-missing loop calls `require_ci_image` and then `require_scenario_home`
# as its first two steps, before any copy, move, install, sqlite3 or tmux step.
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
#   admin path = $HOME/.agent-director/admin/agent-director-admin, the real binary beside
#   either = <path>.real; each runs both guards first, and each that changes the install
#   checks the shim after its change, apart from `hide_ad_install`, which leaves no file at
#   the standard path to check)
#   install_ad_shim [<step>]           put the binary installed at the standard path behind the shim:
#                                      it is copied to <standard path>.real, then the shim is renamed
#                                      over the standard path (which so always holds the binary or
#                                      the shim); fails when the standard path is missing, a symlink
#                                      or already the shim
#   install_ad_admin_shim [<step>]     the same for the agent-director-admin installed at the admin
#                                      path
#   reshim_ad [<step>]                 the re-shim after any install.sh run (the harness's or a
#                                      runbook's own install command): `install_ad_shim`, then
#                                      `install_ad_admin_shim` when a file is at the admin path
#   install_ad_release [<step>]        run the release's install.sh in the scenario HOME
#                                      (`--binary <release binary> --admin-binary <release
#                                      agent-director-admin> --no-symlink --no-hooks`, stdin from
#                                      /dev/null, cwd HOME; output in AD_INSTALL_OUT), then `reshim_ad`
#                                      and `check_ad_admin_shim`; a failed run fails the step with
#                                      install.sh's output
#   install_ad_010 [<step>]            copy agent-director 0.10.0's binary to the standard path, then
#                                      `install_ad_shim` (no install.sh run, no store made)
#   swap_ad_binary <release|0.10.0|<abs-path>> [<step>]
#                                      replace only the binary behind the shim at the standard path
#                                      (the release's, 0.10.0's, or a stand-in or wrapper file);
#                                      agent-director-admin stays as installed
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
#   check_ad_admin_shim [<step>]       the same check at the admin path
#
#   Harness agent-director calls (fmk mode; both guards first; run the standard path, the shim)
#   ad <arg>...                        run agent-director with <arg>...; status and output pass
#                                      through. As a plain command (not in `$( … )` or a pipeline)
#                                      its parent is the scenario's own shell ($$), as the shim logs
#   ad_capture <arg>...                the same, as a direct child of the shell; set AD_RC, AD_OUT
#                                      (stdout file) and AD_ERR (stderr file); never fails on the
#                                      call's status
#   ad_admin <arg>...                  `ad` for agent-director-admin at the admin path (its shim):
#   ad_admin_capture <arg>...          and `ad_capture` for it. agent-director-admin is the
#                                      operator tool that holds `kill-finished` and `delete`; a
#                                      scenario makes those only through `ad_kill_include_finished`
#                                      and `ad_delete_unusable_row`
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
#   Labels and seeding (fmk mode; b.jg5 SRJ-1306's seeding steps, under the "Seeding rules"
#   below; each runs both guards first)
#   ad_new_token [<instance-id> [<token>...]]
#                                      print a fresh launch token (16 lowercase hex characters, from
#                                      /dev/urandom) other than <instance-id>'s current launch token
#                                      in the store (when it has a row holding one) and other than
#                                      each <token>
#   ad_other_store_id                  print a 16-lowercase-hex store id other than the scenario
#                                      store's (`ad_store_id`): another agent-director store's id
#   ad_owner_label <token> <session-id> <instance-id> [<store-id>]
#                                      print the @ad_owner value agent-director writes,
#                                      `ad1 <token> <session-id> <instance-id> <store-id>`, where
#                                      <session-id> is the labelled session's own tmux id ($N) and
#                                      <store-id> is the scenario store's id unless given
#   ad_pane_label <token> <pane-id>    print the @ad_pane value, `<token> <pane-id>` (%N)
#   seed_leftover [-c <dir>] <name> <instance-id> <worker> [<arg>...]
#                                      a leftover: session <name>, labelled with an earlier launch of
#                                      <instance-id> (`ad_new_token <instance-id>`) and the store's
#                                      id; its worker pane carries @ad_pane `<that token> <pane id>`
#   seed_unlabelled [-c <dir>] <name> <worker> [<arg>...]
#                                      a session with no label and no @ad_pane
#   seed_env_only [-c <dir>] <name> <instance-id> <worker> [<arg>...]
#                                      a session with no label whose tmux environment holds only
#                                      the AGENT_DIRECTOR_INSTANCE_ID=<instance-id> it is given
#   seed_borrowed_name [-c <dir>] <name> <instance-id> <worker> [<arg>...]
#                                      another row's session holding <name> (a persona's session
#                                      name): labelled as `seed_leftover` labels, naming
#                                      <instance-id>, the other row's id, and the store's id
#   seed_other_store [-c <dir>] <name> <instance-id> <worker> [<arg>...]
#                                      another agent-director store's session: as `seed_leftover`,
#                                      but its label ends with an `ad_other_store_id` id
#                                      Each seed_* runs tmux new-session -d on the scenario's own
#                                      tmux server from the scenario's own shell (working directory
#                                      <dir>, default SCENARIO_ROOT; the pane runs <worker> with its
#                                      <arg>s), refuses a <name> that is taken or holds `.`, `:` or a
#                                      control character, reads the session's name, labels and
#                                      environment back through tmux, fails when one is not as made,
#                                      and prints `<session id> <pane id>`, then the token and the
#                                      store id for a labelled session; it also sets
#                                      SEEDED_SESSION_ID, SEEDED_PANE_ID, SEEDED_TOKEN and
#                                      SEEDED_STORE_ID (empty when none), which a call inside
#                                      `$( … )` does not keep
#
#   The human's tmux steps (fmk mode; b.jg5 SRJ-1306, SRJ-1401). Each runs both guards first,
#   then the real tmux on the scenario's own tmux server, from the scenario's own shell, never
#   a CSCB process (it refuses when TMUX_TMPDIR is not the scenario's or TMUX is set); it reads
#   back the session, pane, option or server it changed and fails when the change is absent; none
#   reads a pane's text, and none sets base-index. <session> is a session id ($N) or a session
#   name, matched exactly (never as a prefix of another session's). Sending Enter into a held
#   stub's pane is `stub_press_enter` (above).
#   relabel_session <session> [<token>]
#                                      relabel a persona's own session with an earlier launch's
#                                      token: its @ad_owner keeps its instance id and ends with the
#                                      store's id, with <token> (default: `ad_new_token`, other than
#                                      the label's token and the row's current launch token; a given
#                                      <token> may be neither), and its worker pane (the pane whose
#                                      @ad_pane names it with the label's token) takes
#                                      `<token> <pane id>`; fails unless the session carries a valid
#                                      label of this store; prints `<session id> <pane id> <token>`
#                                      (and sets the SEEDED_* variables)
#   attach_viewer <session> [<viewer-name>]
#                                      a grouped viewer session on <session> (new-session -t; default
#                                      name <SCENARIO_TAG>_viewer_<n>, the first free <n>); prints its
#                                      session id
#   rename_session <session> <new-name>
#                                      rename the session (a <new-name> that is taken or holds `.`,
#                                      `:` or a control character is refused); prints its session id
#   set_remain_on_exit <session>       remain-on-exit on, as a window option, on every window of
#                                      <session>
#   ad_owner_global_set [<value>]      set the global @ad_owner value (`set-option -g`, one of the
#                                      three scopes agent-director's lookup reads: global, server,
#                                      global-window), which makes the lookup answer conflicting
#                                      labels; default <value>: `ad_owner_label <fresh token> $0
#                                      <SCENARIO_TAG>_global`; prints the value
#   ad_owner_global_unset              unset it (`set-option -gu`); fails unless the global, server
#                                      and global-window scopes then hold no @ad_owner value
#   respawn_worker_pane <pane-id|session> <command> [<arg>...]
#                                      `respawn-pane -k`: the pane (for a <session>, its worker pane,
#                                      the one whose @ad_pane names it, or its only pane) runs
#                                      <command> instead; fails unless the pane keeps its id, runs a
#                                      new process and the old one is gone within 10 s; prints
#                                      `<pane id> <new pane pid>`
#   restart_tmux_server [<session-name>]
#                                      kill-server on the scenario's tmux server, wait until its
#                                      process is gone, then start a new server with one detached
#                                      session (default name <SCENARIO_TAG>_restart) running tmux's
#                                      default command; prints `<new server pid> <session id>`
#   rebind_tmux_socket [<session-name>]
#                                      re-bind the scenario's socket path while the old server runs:
#                                      the old server's socket is moved to `<socket>.rebound-<n>`
#                                      (where it still answers), and a new server is started at the
#                                      socket path with one detached session (default name
#                                      <SCENARIO_TAG>_rebound_<n>); prints `<new server pid>
#                                      <session id> <moved socket path>` (the path also in
#                                      REBOUND_SOCKET). The trap stops both servers
#   end_session <session-id>           a human ending a leftover or a hand-made session by its
#                                      session id ($N): kill-session; fails unless it is gone
#
#   Store statements and the human's agent-director actions (fmk mode; b.jg5 SRJ-1306; both
#   guards first). Each statement is one `ad_store_edit` UPDATE that names the row by
#   <instance-id> (letters, digits and `._:@-` only) and its row_version as read just before,
#   so an agent-director write in between leaves the row unwritten and the step failing; the
#   row is read before and after (a read-only sqlite3 query) and the step fails unless the
#   named columns hold their new values and every other column its old one. The pending row
#   with no launch start is `ad_store_pending_no_launch` (above).
#   ad_store_mark_finished <instance-id> <missing|ended>
#                                      b.jg5 SRJ-1412 (scenario 10 part B): state <missing|ended>;
#                                      ended_at = now minus the stopping window, in whole seconds, in
#                                      the store's `YYYY-MM-DD HH:MM:SS` UTC layout; launch_started_at
#                                      NULL; row_version + 1. The window is [tmux]
#                                      stopping_window_seconds from $HOME/.agent-director/config.toml,
#                                      or agent-director's default (90) without one. Refuses unless
#                                      that ended_at is later, in whole seconds, than the creation of
#                                      the worker's session (read on the row's socket, under
#                                      SCENARIO_ROOT, by its recorded pane), so while the session is
#                                      younger than the window; prints the ended_at written
#   ad_store_seed_pending <instance-id> [<leftover-token>]
#                                      b.jg5 SRJ-1420 (scenario 19): the persona's row made a `pending`
#                                      row beside a leftover, as a spawn whose process stopped before
#                                      its create leaves it: state `pending`; launch_started_at now (in
#                                      milliseconds); launch_token a fresh token other than the row's
#                                      current one and <leftover-token>; ended_at, pid,
#                                      proc_starttime, the server identity (tmux_server_pid,
#                                      tmux_server_started, tmux_server_starttime) and the pane
#                                      identity (pane_id, pane_pid, pane_starttime) NULL; row_version
#                                      + 1. A harness `status` read must then read `pending` with a
#                                      launch start; prints the token
#   ad_store_unusable_name <instance-id> <name>
#                                      b.jg5 SRJ-1427 (scenario 25): a finished row's (`ended` or
#                                      `missing`) tmux_session_name set to <name>, which holds a `.`
#                                      and only letters, digits and `._-`; nothing else changes
#                                      (row_version included)
#   ad_kill_include_finished <instance-id>
#                                      a human's finished-row kill, agent-director-admin's
#                                      `kill-finished --claude-instance-id <id>` (agent-director's own
#                                      `kill` takes no --include-finished), through
#                                      `ad_admin_capture`, as a direct child of the shell that calls
#                                      it: the scenario's own shell, or a subshell of it, which
#                                      `assert_no_cscb_include_finished` accepts. Sets AD_KILL_OUT (its
#                                      output, a file under SCENARIO_ROOT), AD_KILL_ERR and AD_KILL_RC
#                                      and prints the output; fails unless it exits 0 with a result
#                                      holding kill_sent and its invocation is in the shim's log.
#                                      agent-director-admin makes this kill
#                                      only for a finished row (`ended` or `missing`, as
#                                      `ad_store_mark_finished` leaves it) whose session is past the
#                                      starting-session bound ([tmux] starting_session_seconds in
#                                      $HOME/.agent-director/config.toml: 300 s by default, 60 s at
#                                      its safe minimum); before that it answers ErrSpawnNotResumable
#                                      (a live row) or ErrTmuxUnresponsive (a younger session), and
#                                      the step fails on that non-zero exit; a scenario that uses it
#                                      lowers that bound in its [tmux] table or waits the 300 s
#   ad_delete_unusable_row <instance-id>
#                                      scenario 25's step, the only agent-director `delete` the
#                                      harness makes (b.jg5 SRJ-1306), through agent-director-admin
#                                      (`ad_admin_capture`): a human removing the row with the
#                                      unusable name; refuses unless the row's recorded session name
#                                      holds the `.` `ad_store_unusable_name` wrote; fails unless
#                                      `delete` exits 0 reporting the id `ok` and the row is gone
#
#   The find-missing loop (fmk mode; b.jg5 SRJ-1401: only for a latched persona's row, which CSCB
#   makes no extra call for, as the host's find-missing loop marks it; an unlatched persona's
#   row is CSCB's own pending-row runs' to mark; both guards first)
#   run_find_missing_loop [<interval-s>]
#                                      start the loop in the background, a subshell of the scenario's
#                                      shell registered with `track_pid`: `find-missing`, with no
#                                      arguments, through the harness call (`ad`, the scenario HOME's
#                                      binary behind the shim), then a sleep of <interval-s> (default
#                                      SCENARIO_FIND_MISSING_INTERVAL_S, 30), and again, until it is
#                                      stopped or the trap ends it. Refuses when TMUX_TMPDIR is not
#                                      the scenario's or TMUX is set, and while a loop runs. Each run
#                                      writes run.<n>.out and run.<n>.err and one log line,
#                                      `run <n> TAB start <time> TAB end <time> TAB exit <status>`,
#                                      followed by its output's lines, indented (`  out| `,
#                                      `  err| `), to FIND_MISSING_LOOP_LOG
#                                      ($SCENARIO_ROOT/find-missing-loop/loop.log). Its calls'
#                                      parent is that subshell (the script's own command line, no
#                                      CSCB process), so CSCB's filters count none of them. Sets
#                                      FIND_MISSING_LOOP_PID and FIND_MISSING_LOOP_INTERVAL_S
#   stop_find_missing_loop [<timeout-s>]
#                                      SIGTERM the loop (a run in flight finishes first); fail unless
#                                      it is gone within <timeout-s> (default 30)
#   find_missing_loop_runs             print how many runs the loop's log holds (0 when none)
#   wait_find_missing_runs <n> [<timeout-s>]
#                                      wait for <n> more runs than the log holds now; fails when the
#                                      loop is not running, stops, or is not that far within
#                                      <timeout-s> (default <n> intervals plus 60 s)
#
#   0.10.0 start and seeders (fmk mode; b.jg5 SRJ-1306, SRJ-1402, SRJ-1424). The 0.10.0 start is
#   setup's: a script that sets SCENARIO_AD_START=0.10.0 before sourcing gets 0.10.0's binary
#   behind the shim (`install_ad_010`) and no store, which 0.10.0's first `spawn` creates.
#   `install_ad_release` later runs the release's install.sh over it (the migration), then
#   re-shims and re-checks. Both seeders run both guards first, and refuse unless the binary
#   behind the shim, run by its own name, reports 0.10.0, no `install_ad_release` has run in
#   this shell and the store, if any, has no store_meta table (the release's install has
#   not run in this HOME).
#   seed_010_row <instance-id> <session-name> <dir> [<key>=<value>...]
#                                      one row made with 0.10.0's own `spawn` through the harness call
#                                      (`ad_capture`, from the scenario's shell): --cwd <dir>,
#                                      --claude-instance-id, --tmux-session-name and a --label per
#                                      <key>=<value>; refuses a <session-name> that is taken, longer
#                                      than 64 bytes or holds `.`, `:`, `#` or a control character, and
#                                      a <dir> that is not an absolute path to a directory. Its worker
#                                      is the stub (`claude`), in the mode selected for <dir>:
#                                      `at-once` (selected here) unless the caller selected
#                                      another (`stub_mode`) first. 0.10.0's hooks
#                                      are shell form, and the stub fires them from their words.
#                                      Fails unless the session runs the stub; in `at-once` it then
#                                      waits (SCENARIO_SEED_REPORT_S, 60 s) until the row has
#                                      reported in (a live state other than `pending`). Prints
#                                      `<instance id> <session name> <session id> <pane id>` (and
#                                      sets SEEDED_SESSION_ID and SEEDED_PANE_ID)
#   seed_prepersona_fleet <config.json> <channel-id>=<channel-name>...
#                                      the pre-persona fleet: one `seed_010_row` per channel the
#                                      pre-persona config's `routes` names, in its order, with that
#                                      route's cwd (`~` and `~/` expanded against HOME; it must be
#                                      absolute), named and labelled as the published pre-persona
#                                      package (0.10.0) names and labels it: instance id
#                                      `cscb_<name>_<channel id>`, session
#                                      `slack_bot_<name>_<channel id>`, labels `service=cscb` and
#                                      `channel=<channel id>`, no `persona` label. <name> is the
#                                      package's normalizeChannelName of the channel's Slack name,
#                                      which it reads from Slack (conversations.info) and never from
#                                      config.json, so the caller gives it for every routed channel:
#                                      lowercased, each run of characters other than a-z and 0-9
#                                      turned into one `_`, leading and trailing `_` dropped; a name
#                                      that normalizes to nothing gives the package's bare forms,
#                                      `cscb_<channel id>` and `slack_bot_<channel id>`. ASCII names
#                                      only. Every route, its name and its directory are checked
#                                      before the first row is made. Prints one line per row,
#                                      `<channel id> <instance id> <session name> <session id>
#                                      <pane id>`
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
#   assert_no_cscb_include_finished    fail on any finished-row kill, agent-director-admin's
#                                      `kill-finished` or a `kill` carrying --include-finished (`-` or
#                                      `--`, with or without `=<value>`), whose parent is not the
#                                      scenario's own shell or a subshell of it (a command
#                                      substitution or pipeline element included): a parent whose
#                                      command line is the script's own (SCENARIO_SHELL_CMDLINE, quoted
#                                      as the shims quote it) and that no CSCB process held; positive
#                                      control: fail unless some invocation's parent is a bot server
#                                      the scenario started (its version probe)
#   assert_no_cscb_delete              fail on any `delete` invocation (agent-director-admin's, or an
#                                      earlier agent-director's) whose parent is a CSCB process
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
#   Scenario 10's harness additions (fmk mode; b.jg5 SRJ-1412, SRJ-1306, SRJ-1401). Each is a
#   harness addition, confirm at the reconcile pass; each runs `require_ci_image` first, and
#   `write_ad_tmux_table` and `start_second_tmux_server` also `require_scenario_home`, before
#   any step. A harness
#   agent-director call under another tmux environment needs no helper: a prefix assignment
#   on the call (`TMUX_TMPDIR=<dir> ad_capture …`, `TMUX=<value> ad_capture …`) holds for
#   that one call only, from the scenario's own shell, and reaches the binary behind the shim.
#   write_ad_tmux_table [<key>=<toml-value>...]
#                                      (harness addition, confirm at the reconcile pass) write
#                                      the scenario HOME's agent-director config file, at
#                                      $HOME/<AD_SETTINGS_RELATIVE_PATH>, as one `[<AD_TMUX_TABLE>]`
#                                      table (path and table name printed by fixtures/fmk-texts.ts
#                                      from src/ad-settings.ts) of the given pairs, in order, each
#                                      `<key> = <toml-value>` with the value text as given (so a
#                                      string or a below-minimum value is written as given; the
#                                      caller picks values at or above their minimums); the file
#                                      is replaced whole (`write_file`), then read back; with no
#                                      pair the file is removed. Refuses a path that leaves HOME
#                                      or resolves outside SCENARIO_ROOT, and a pair that is not
#                                      `<key>=<value>` on one line
#   start_second_tmux_server [<session-name>]
#                                      (harness addition, confirm at the reconcile pass) start
#                                      another tmux server, with the real tmux from the scenario's
#                                      own shell, on its own socket
#                                      `$SCENARIO_ROOT/tmux-second/tmux-<uid>/default`, with one
#                                      detached session (default name <SCENARIO_TAG>_second); it
#                                      names that socket with -S on every call, so the scenario's
#                                      own server is never touched, and the trap stops it with
#                                      every other tmux socket under SCENARIO_ROOT. Refuses when
#                                      TMUX_TMPDIR is not the scenario's or TMUX is set, and once
#                                      one was started; fails unless the socket then answers with
#                                      the new server's PID. Sets SECOND_TMUX_SOCKET and
#                                      SECOND_TMUX, the TMUX value that points at it
#                                      (`<socket>,<server pid>,<session number>`), and prints
#                                      SECOND_TMUX
#   ad_shim_mark                       (harness addition, confirm at the reconcile pass) print
#                                      how many lines the agent-director shim's log holds now (0
#                                      when none): a mark for the two helpers below
#   cscb_ad_calls_between <from-mark> <to-mark|-> <verb> [<fragment>...]
#   cscb_ad_count_between <from-mark> <to-mark|-> <verb> [<fragment>...]
#                                      (harness addition, confirm at the reconcile pass)
#                                      `cscb_ad_calls` and `cscb_ad_count` over only the shim
#                                      log's lines after <from-mark> up to <to-mark> (`-`: up to
#                                      the log's end now), read from a copy of those lines under
#                                      SCENARIO_ROOT with the same CSCB process record
#   slack_record_mark <record>         (harness addition, confirm at the reconcile pass) print
#                                      the last `seq` of the Slack stub's record <record> (a file
#                                      under SCENARIO_ROOT; 0 when it holds none)
#   slack_posts <record> <label> [<after-seq>]
#                                      (harness addition, confirm at the reconcile pass) print the
#                                      text of each `chat.postMessage` the Slack stub recorded for
#                                      the token label <label> with a `seq` above <after-seq>
#                                      (default 0), in record order, one JSON string per line
#                                      (`jq -r` gives a post's text back)
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
# Seeding rules (fmk mode; b.jg5 SRJ-1306, agent-director's handoff rev 15 and
# rev 17). The harness seeds and relabels sessions from the scenario's own
# shell, never through a CSCB process, and:
# - every @ad_owner label it seeds or relabels ends with the scenario store's
#   own store id (`ad_store_id`), unless the step seeds another store's
#   session (`seed_other_store`): agent-director reads a label with another id
#   as another agent-director store's and never acts on it;
# - every leftover it seeds or relabels carries @ad_pane = `<the label's token>
#   <the pane's id>` on its worker's pane, as a leftover agent-director made
#   does: agent-director finds a leftover's pane only through that label;
# - a session seeded by hand for agent-director to adopt after a lost create
#   reply would carry @ad_pane = `<the row's launch token> <the pane's id>`;
#   no scenario seeds one, so no helper makes one;
# - a scenario whose launch loses its create reply (the tmux shim's
#   `slow-create`) runs the stub in a mode that waits for the approver's Enter
#   before it reports in (`dev-channels`): agent-director applies no hook to a
#   row whose pane it has not adopted, and the approver's send-keys adopts it;
# - no helper sets base-index: no agent-director verb depends on pane indices.
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

# The image's agent-director files (docker/Dockerfile.test.base): the
# release's binary, its operator tool agent-director-admin and its install.sh
# (from agent-director's tree at the release tag), and agent-director
# 0.10.0's binary.
SCENARIO_RELEASE_BIN=/opt/agent-director/bin/agent-director
SCENARIO_RELEASE_ADMIN=/opt/agent-director/admin/agent-director-admin
SCENARIO_RELEASE_INSTALL_SH=/opt/agent-director/install/install.sh
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

# agent-director's default stopping window, in seconds (DefaultStoppingWindowSeconds
# in its internal/config/tmux.go), used when the scenario HOME's config.toml
# sets none.
SCENARIO_AD_DEFAULT_STOPPING_WINDOW_S=90

# run_find_missing_loop's default interval in /ci, in seconds (the host's loop
# runs every 300 s).
SCENARIO_FIND_MISSING_INTERVAL_S=30

# Bound on a seed_010_row worker that reports in at once doing so, in seconds.
SCENARIO_SEED_REPORT_S=60

# The agent-director version the 0.10.0 seeders run on.
SCENARIO_AD_010_VERSION=0.10.0

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
_SCENARIO_SEED_COUNT=0    # sessions the harness named by default (viewers, restarts, re-binds)
_SCENARIO_FM_LOOP_PID=""  # the find-missing loop's PID while it runs

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

# _scenario_check_shim_at <path> <step>: fail unless <path> holds a regular
# file, not a symlink, carrying the shim's marker and executable, with an
# executable regular file that is not the shim at <path>.real.
_scenario_check_shim_at() {
    local path="$1" step="$2"
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

check_ad_shim() {
    local step="${1:-the agent-director shim check}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_check_shim_at "${HOME}/.agent-director/bin/agent-director" "${step}"
}

check_ad_admin_shim() {
    local step="${1:-the agent-director-admin shim check}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_check_shim_at "${HOME}/.agent-director/admin/agent-director-admin" "${step}"
}

# _scenario_shim_over <path> <step>: put the binary installed at <path>
# behind the shim. The caller has run both guards.
_scenario_shim_over() {
    local path="$1" step="$2"
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
    _scenario_check_shim_at "${path}" "${step}"
}

install_ad_shim() {
    local step="${1:-install the agent-director shim}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_shim_over "${HOME}/.agent-director/bin/agent-director" "${step}"
}

install_ad_admin_shim() {
    local step="${1:-install the agent-director-admin shim}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_shim_over "${HOME}/.agent-director/admin/agent-director-admin" "${step}"
}

reshim_ad() {
    local step="${1:-re-shim after install.sh}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    install_ad_shim "${step}"
    # install.sh installs agent-director-admin too; 0.10.0 had none.
    if [[ -e "${HOME}/.agent-director/admin/agent-director-admin" ]]; then
        install_ad_admin_shim "${step}: agent-director-admin"
    fi
}

install_ad_release() {
    local step="${1:-install the release with its install.sh}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    local rc=0 last
    [[ -f "${SCENARIO_RELEASE_INSTALL_SH}" && -x "${SCENARIO_RELEASE_INSTALL_SH}" ]] \
        || fail "${step}: the release's install.sh is missing from the image (${SCENARIO_RELEASE_INSTALL_SH})"
    [[ -f "${SCENARIO_RELEASE_BIN}" && -x "${SCENARIO_RELEASE_BIN}" ]] \
        || fail "${step}: the release's binary is missing from the image (${SCENARIO_RELEASE_BIN})"
    [[ -f "${SCENARIO_RELEASE_ADMIN}" && -x "${SCENARIO_RELEASE_ADMIN}" ]] \
        || fail "${step}: the release's agent-director-admin is missing from the image (${SCENARIO_RELEASE_ADMIN})"
    _SCENARIO_INSTALL_COUNT=$(( _SCENARIO_INSTALL_COUNT + 1 ))
    AD_INSTALL_OUT="${SCENARIO_ROOT}/install-sh.${_SCENARIO_INSTALL_COUNT}.out"
    (cd "${HOME}" && "${SCENARIO_RELEASE_INSTALL_SH}" --binary "${SCENARIO_RELEASE_BIN}" \
        --admin-binary "${SCENARIO_RELEASE_ADMIN}" --no-symlink --no-hooks) \
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
    check_ad_admin_shim "${step}: agent-director-admin"
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
        release) src="${SCENARIO_RELEASE_BIN}" ;;
        0.10.0) src="${SCENARIO_AD_010_BIN}" ;;
        /*) src="${what}" ;;
        *) fail "${step}: '${what}' is not release, 0.10.0 or an absolute path" ;;
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

ad_admin() {
    require_ci_image "ad_admin $*"
    require_scenario_home "ad_admin $*"
    "${HOME}/.agent-director/admin/agent-director-admin" "$@"
}

ad_admin_capture() {
    require_ci_image "ad_admin_capture $*"
    require_scenario_home "ad_admin_capture $*"
    _SCENARIO_AD_COUNT=$(( _SCENARIO_AD_COUNT + 1 ))
    AD_OUT="${SCENARIO_ROOT}/ad.${_SCENARIO_AD_COUNT}.out"
    AD_ERR="${SCENARIO_ROOT}/ad.${_SCENARIO_AD_COUNT}.err"
    AD_RC=0
    "${HOME}/.agent-director/admin/agent-director-admin" "$@" > "${AD_OUT}" 2> "${AD_ERR}" || AD_RC=$?
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
# The harness's tmux, store reads and labels (fmk mode)
# ---------------------------------------------------------------------------

# _scenario_tmux_check <step>: refuse outside fmk mode, and unless the
# scenario's shell talks to the scenario's own tmux server (TMUX_TMPDIR the
# scenario's, TMUX unset).
_scenario_tmux_check() {
    [[ "${SCENARIO_FMK}" == 1 ]] || fail "$1: the scenario's tmux server is for fmk scripts only"
    [[ "${TMUX_TMPDIR:-}" == "${SCENARIO_ROOT}/tmux" ]] \
        || fail "$1: refused: TMUX_TMPDIR '${TMUX_TMPDIR:-}' is not the scenario's ${SCENARIO_ROOT}/tmux"
    [[ -z "${TMUX:-}" ]] || fail "$1: refused: TMUX is set, naming another tmux server"
}

# _scenario_tmux <arg>...: the real tmux on the scenario's own server (found
# by TMUX_TMPDIR), from the scenario's own shell. Its standard error goes to
# a file that `_scenario_tmux_err` prints on one line.
_scenario_tmux() {
    "${SCENARIO_REAL_TMUX}" "$@" 2> "${SCENARIO_ROOT}/harness-tmux.err"
}

_scenario_tmux_err() {
    tr '\n' ' ' < "${SCENARIO_ROOT}/harness-tmux.err" 2> /dev/null || true
}

# _scenario_session_target <session>: tmux's exact target for a session id
# ($N, as it is) or a session name (=<name>, never a prefix of another's).
_scenario_session_target() {
    if [[ "$1" =~ ^\$[0-9]+$ ]]; then
        printf '%s\n' "$1"
    else
        printf '=%s\n' "$1"
    fi
}

# _scenario_session_id <step> <session>: print the session id ($N) of
# <session> on the scenario's tmux server; fail when there is none.
_scenario_session_id() {
    local step="$1" session="${2:-}" out
    [[ -n "${session}" ]] || fail "${step}: no session named"
    out="$(_scenario_tmux display-message -p -t "$(_scenario_session_target "${session}"):" '#{session_id}')" \
        || fail "${step}: no session '${session}' on the scenario's tmux server: $(_scenario_tmux_err)"
    [[ "${out}" =~ ^\$[0-9]+$ ]] || fail "${step}: tmux gave session id '${out}' for '${session}'"
    printf '%s\n' "${out}"
}

# _scenario_check_session_name <step> <name>: refuse a name tmux would not
# keep as given (it turns `.` and `:` into `_`) or that holds a control
# character.
_scenario_check_session_name() {
    [[ -n "$2" && "$2" != *[.:[:cntrl:]]* ]] \
        || fail "$1: session name '$2' is empty or holds '.', ':' or a control character"
}

# _scenario_free_session_name <prefix>: print <prefix>_<n> for the first <n>
# from 1 that no session on the scenario's tmux server holds.
_scenario_free_session_name() {
    local n=1
    while _scenario_tmux has-session -t "=$1_${n}"; do
        n=$(( n + 1 ))
    done
    printf '%s_%s\n' "$1" "${n}"
}

# _scenario_worker_pane <step> <session-id> [<token>]: print the worker pane
# of the session: the one pane whose @ad_pane is `<token> <its own pane id>`
# (any 16-hex token when <token> is empty). Without <token>, a session with
# no such pane and exactly one pane gives that pane. Fails otherwise.
_scenario_worker_pane() {
    local step="$1" sid="$2" token="${3:-}" out line p v found=() all=()
    out="$(_scenario_tmux list-panes -s -t "${sid}" -F '#{pane_id} #{@ad_pane}')" \
        || fail "${step}: could not list the panes of ${sid}: $(_scenario_tmux_err)"
    while IFS= read -r line; do
        [[ -n "${line}" ]] || continue
        p="${line%% *}"
        v="${line#* }"
        all+=("${p}")
        if [[ -n "${token}" ]]; then
            [[ "${v}" == "${token} ${p}" ]] && found+=("${p}")
        elif [[ "${v}" =~ ^[0-9a-f]{16}\ (%[0-9]+)$ && "${BASH_REMATCH[1]}" == "${p}" ]]; then
            found+=("${p}")
        fi
    done <<< "${out}"
    if (( ${#found[@]} == 0 )) && [[ -z "${token}" ]] && (( ${#all[@]} == 1 )); then
        found=("${all[0]}")
    fi
    (( ${#found[@]} == 1 )) \
        || fail "${step}: ${sid} has ${#found[@]} worker pane(s) carrying @ad_pane '${token:-<token>} <its pane id>', not one"
    printf '%s\n' "${found[0]}"
}

# _scenario_check_labels <step> <session-id> <pane-id> <name|-> <owner> <pane-label>:
# fail unless tmux reads the session's name (unless `-`), its own @ad_owner
# and the pane's own @ad_pane (each empty when unset) as given.
_scenario_check_labels() {
    local step="$1" sid="$2" pane="$3" name="$4" owner="$5" pane_label="$6" got
    if [[ "${name}" != - ]]; then
        got="$(_scenario_tmux display-message -p -t "${sid}:" '#{session_name}')" \
            || fail "${step}: could not read the name of ${sid}: $(_scenario_tmux_err)"
        [[ "${got}" == "${name}" ]] || fail "${step}: session ${sid} is named '${got}', not '${name}'"
    fi
    got="$(_scenario_tmux show-options -qv -t "${sid}" @ad_owner)" \
        || fail "${step}: could not read @ad_owner of ${sid}: $(_scenario_tmux_err)"
    [[ "${got}" == "${owner}" ]] || fail "${step}: session ${sid}'s @ad_owner reads '${got}', not '${owner}'"
    got="$(_scenario_tmux show-options -p -qv -t "${pane}" @ad_pane)" \
        || fail "${step}: could not read @ad_pane of ${pane}: $(_scenario_tmux_err)"
    [[ "${got}" == "${pane_label}" ]] || fail "${step}: pane ${pane}'s @ad_pane reads '${got}', not '${pane_label}'"
}

# _scenario_set_labels <step> <session-id> <pane-id> <owner> <pane-label>:
# set the session's @ad_owner and the pane's @ad_pane, then read them back.
_scenario_set_labels() {
    local step="$1" sid="$2" pane="$3" owner="$4" pane_label="$5"
    _scenario_tmux set-option -t "${sid}" @ad_owner "${owner}" \
        || fail "${step}: could not set @ad_owner on ${sid}: $(_scenario_tmux_err)"
    _scenario_tmux set-option -p -t "${pane}" @ad_pane "${pane_label}" \
        || fail "${step}: could not set @ad_pane on ${pane}: $(_scenario_tmux_err)"
    _scenario_check_labels "${step}" "${sid}" "${pane}" - "${owner}" "${pane_label}"
}

_scenario_check_instance_id() {
    [[ "$2" =~ ^[A-Za-z0-9._:@-]+$ ]] \
        || fail "$1: instance id '$2' is empty or holds a character other than letters, digits and ._:@-"
}

# _scenario_store_read <step> <query> [json]: one read-only sqlite3 query of
# the scenario store (both guards first); print its output (rows as a JSON
# array with `json`, nothing for no row); fail with sqlite3's error.
_scenario_store_read() {
    require_ci_image "$1"
    require_scenario_home "$1"
    local step="$1" query="$2" db="${HOME}/.agent-director/state.db" out mode=()
    if [[ "${3:-}" == json ]]; then
        mode=(-json)
    fi
    [[ -f "${db}" ]] || fail "${step}: no store at ${db}"
    out="$(sqlite3 -batch -bail -readonly ${mode[@]+"${mode[@]}"} -cmd ".timeout ${SCENARIO_STORE_BUSY_MS}" "${db}" "${query};" 2>&1)" \
        || fail "${step}: sqlite3 failed on '${query}': ${out//$'\n'/ }"
    if [[ -n "${out}" ]]; then
        printf '%s\n' "${out}"
    fi
}

# _scenario_row_json <step> <instance-id>: print the row as a one-element
# JSON array; fail when no row has the id.
_scenario_row_json() {
    local out
    out="$(_scenario_store_read "$1" "SELECT * FROM spawns WHERE claude_instance_id = '$2'" json)" || exit 1
    [[ -n "${out}" ]] || fail "$1: no row has instance id $2"
    printf '%s\n' "${out}"
}

# _scenario_row_diff_check <step> <before> <after> <want>: fail unless the row
# after an edit (a one-element JSON array, as `_scenario_row_json` prints)
# holds <want>'s values (a JSON object) in <want>'s columns and its value
# before the edit in every other column.
_scenario_row_diff_check() {
    local step="$1" bad
    bad="$(jq -rn --argjson b "$2" --argjson a "$3" --argjson w "$4" '
        ($b[0]) as $b | ($a[0]) as $a
        | [ ($a | keys_unsorted[]) as $k | select(($w | has($k)) | not) | select($a[$k] != $b[$k])
            | "\($k) changed from \($b[$k] | tojson) to \($a[$k] | tojson)" ]
          + [ ($w | keys_unsorted[]) as $k | select($a[$k] != $w[$k])
            | "\($k) reads \($a[$k] | tojson), not \($w[$k] | tojson)" ]
          + (if ($a | keys) != ($b | keys) then ["the row'\''s columns changed"] else [] end)
        | join("; ")')" || fail "${step}: could not compare the row before and after the edit"
    [[ -z "${bad}" ]] || fail "${step}: after the edit, ${bad}"
}

ad_new_token() {
    local id="${1:-}" step="ad_new_token${1:+ $1}" current="" token t i
    require_ci_image "${step}"
    require_scenario_home "${step}"
    if (( $# > 0 )); then
        shift
    fi
    if [[ -n "${id}" ]]; then
        _scenario_check_instance_id "${step}" "${id}"
        if [[ -f "${HOME}/.agent-director/state.db" ]]; then
            current="$(_scenario_store_read "${step}" "SELECT COALESCE(launch_token, '') FROM spawns WHERE claude_instance_id = '${id}'")" \
                || exit 1
        fi
    fi
    for i in 1 2 3 4 5 6 7 8; do
        token="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
        [[ "${token}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: could not read 8 random bytes (draw ${i})"
        [[ "${token}" != "${current}" ]] || continue
        for t in "$@"; do
            [[ "${token}" != "${t}" ]] || continue 2
        done
        printf '%s\n' "${token}"
        return 0
    done
    fail "${step}: no fresh token in 8 draws"
}

ad_other_store_id() {
    local step=ad_other_store_id own id i
    require_ci_image "${step}"
    require_scenario_home "${step}"
    own="$(ad_store_id)" || exit 1
    for i in 1 2 3 4 5 6 7 8; do
        id="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
        [[ "${id}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: could not read 8 random bytes (draw ${i})"
        if [[ "${id}" != "${own}" ]]; then
            printf '%s\n' "${id}"
            return 0
        fi
    done
    fail "${step}: no other store id in 8 draws"
}

ad_owner_label() {
    local token="${1:-}" sid="${2:-}" id="${3:-}" store="${4:-}" step="ad_owner_label"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    [[ "${token}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: token '${token}' is not 16 lowercase hex characters"
    [[ "${sid}" =~ ^\$[0-9]+$ ]] || fail "${step}: '${sid}' is not a tmux session id (\$N)"
    [[ -n "${id}" && "${id}" != *[[:cntrl:]]* ]] \
        || fail "${step}: instance id '${id}' is empty or holds a control character"
    if [[ -z "${store}" ]]; then
        store="$(ad_store_id)" || exit 1
    fi
    [[ "${store}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: store id '${store}' is not 16 lowercase hex characters"
    printf 'ad1 %s %s %s %s\n' "${token}" "${sid}" "${id}" "${store}"
}

ad_pane_label() {
    local token="${1:-}" pane="${2:-}" step="ad_pane_label"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    [[ "${token}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: token '${token}' is not 16 lowercase hex characters"
    [[ "${pane}" =~ ^%[0-9]+$ ]] || fail "${step}: '${pane}' is not a tmux pane id (%N)"
    printf '%s %s\n' "${token}" "${pane}"
}

# ---------------------------------------------------------------------------
# Seeding (fmk mode; b.jg5 SRJ-1306's seeding steps and rules)
# ---------------------------------------------------------------------------

# _scenario_seed <step> <kind> [-c <dir>] <name> [<instance-id>] <worker> [<arg>...]:
# the seeding helpers' one body. <kind> is leftover, unlabelled, env-only,
# borrowed or other-store; every kind but unlabelled takes <instance-id>.
_scenario_seed() {
    local step="$1" kind="$2" cwd name id="" out sid pane token="" store="" owner="" pane_label="" got
    shift 2
    _scenario_tmux_check "${step}"
    cwd="${SCENARIO_ROOT}"
    if [[ "${1:-}" == -c ]]; then
        (( $# >= 2 )) || fail "${step}: -c takes a directory"
        cwd="$2"
        shift 2
    fi
    name="${1:-}"
    (( $# > 0 )) || fail "${step}: no session name given"
    shift
    if [[ "${kind}" != unlabelled ]]; then
        id="${1:-}"
        (( $# > 0 )) || fail "${step}: no instance id given"
        shift
        _scenario_check_instance_id "${step}" "${id}"
    fi
    (( $# > 0 )) || fail "${step}: no worker command given"
    _scenario_check_session_name "${step}" "${name}"
    [[ -d "${cwd}" ]] || fail "${step}: working directory '${cwd}' is not a directory"
    if _scenario_tmux has-session -t "=${name}"; then
        fail "${step}: a session named ${name} already exists"
    fi
    local args=(new-session -d -P -F '#{session_id} #{pane_id}' -s "${name}" -c "${cwd}")
    if [[ "${kind}" == env-only ]]; then
        args+=(-e "AGENT_DIRECTOR_INSTANCE_ID=${id}")
    fi
    out="$(_scenario_tmux "${args[@]}" -- "$@")" \
        || fail "${step}: tmux new-session failed: $(_scenario_tmux_err)"
    read -r sid pane <<< "${out}"
    [[ "${sid}" =~ ^\$[0-9]+$ && "${pane}" =~ ^%[0-9]+$ ]] \
        || fail "${step}: tmux new-session printed '${out}', not a session id and a pane id"
    case "${kind}" in
        leftover | borrowed | other-store)
            token="$(ad_new_token "${id}")" || exit 1
            if [[ "${kind}" == other-store ]]; then
                store="$(ad_other_store_id)" || exit 1
            else
                store="$(ad_store_id)" || exit 1
            fi
            owner="$(ad_owner_label "${token}" "${sid}" "${id}" "${store}")" || exit 1
            pane_label="$(ad_pane_label "${token}" "${pane}")" || exit 1
            _scenario_set_labels "${step}" "${sid}" "${pane}" "${owner}" "${pane_label}"
            ;;
    esac
    _scenario_check_labels "${step}" "${sid}" "${pane}" "${name}" "${owner}" "${pane_label}"
    if [[ "${kind}" == env-only ]]; then
        got="$(_scenario_tmux show-environment -t "${sid}" AGENT_DIRECTOR_INSTANCE_ID)" \
            || fail "${step}: session ${sid} has no AGENT_DIRECTOR_INSTANCE_ID in its environment: $(_scenario_tmux_err)"
        [[ "${got}" == "AGENT_DIRECTOR_INSTANCE_ID=${id}" ]] \
            || fail "${step}: session ${sid}'s environment holds '${got}', not AGENT_DIRECTOR_INSTANCE_ID=${id}"
    fi
    SEEDED_SESSION_ID="${sid}"
    SEEDED_PANE_ID="${pane}"
    SEEDED_TOKEN="${token}"
    SEEDED_STORE_ID="${store}"
    printf '%s\n' "${sid} ${pane}${token:+ ${token}}${store:+ ${store}}"
}

seed_leftover() {
    require_ci_image "seed_leftover $*"
    require_scenario_home "seed_leftover $*"
    _scenario_seed "seed_leftover $*" leftover "$@"
}

seed_unlabelled() {
    require_ci_image "seed_unlabelled $*"
    require_scenario_home "seed_unlabelled $*"
    _scenario_seed "seed_unlabelled $*" unlabelled "$@"
}

seed_env_only() {
    require_ci_image "seed_env_only $*"
    require_scenario_home "seed_env_only $*"
    _scenario_seed "seed_env_only $*" env-only "$@"
}

seed_borrowed_name() {
    require_ci_image "seed_borrowed_name $*"
    require_scenario_home "seed_borrowed_name $*"
    _scenario_seed "seed_borrowed_name $*" borrowed "$@"
}

seed_other_store() {
    require_ci_image "seed_other_store $*"
    require_scenario_home "seed_other_store $*"
    _scenario_seed "seed_other_store $*" other-store "$@"
}

# ---------------------------------------------------------------------------
# The human's tmux steps (fmk mode; b.jg5 SRJ-1306, SRJ-1401)
# ---------------------------------------------------------------------------

relabel_session() {
    local session="${1:-}" given="${2:-}" step sid cur store old id current pane token owner pane_label
    step="relabel_session ${session}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    sid="$(_scenario_session_id "${step}" "${session}")" || exit 1
    cur="$(_scenario_tmux show-options -qv -t "${sid}" @ad_owner)" \
        || fail "${step}: could not read @ad_owner of ${sid}: $(_scenario_tmux_err)"
    store="$(ad_store_id)" || exit 1
    [[ "${cur}" =~ ^ad1\ ([0-9a-f]{16})\ (\$[0-9]+)\ (.+)\ ([0-9a-f]{16})$ \
        && "${BASH_REMATCH[2]}" == "${sid}" && "${BASH_REMATCH[4]}" == "${store}" ]] \
        || fail "${step}: session ${sid} carries no valid label of this store (its @ad_owner reads '${cur}')"
    old="${BASH_REMATCH[1]}"
    id="${BASH_REMATCH[3]}"
    _scenario_check_instance_id "${step}" "${id}"
    pane="$(_scenario_worker_pane "${step}" "${sid}" "${old}")" || exit 1
    if [[ -n "${given}" ]]; then
        [[ "${given}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: token '${given}' is not 16 lowercase hex characters"
        current="$(_scenario_store_read "${step}" "SELECT COALESCE(launch_token, '') FROM spawns WHERE claude_instance_id = '${id}'")" \
            || exit 1
        [[ "${given}" != "${old}" && "${given}" != "${current}" ]] \
            || fail "${step}: token ${given} is the label's or the row's current launch token, not an earlier launch's"
        token="${given}"
    else
        token="$(ad_new_token "${id}" "${old}")" || exit 1
    fi
    owner="$(ad_owner_label "${token}" "${sid}" "${id}" "${store}")" || exit 1
    pane_label="$(ad_pane_label "${token}" "${pane}")" || exit 1
    _scenario_set_labels "${step}" "${sid}" "${pane}" "${owner}" "${pane_label}"
    SEEDED_SESSION_ID="${sid}"
    SEEDED_PANE_ID="${pane}"
    SEEDED_TOKEN="${token}"
    SEEDED_STORE_ID="${store}"
    printf '%s %s %s\n' "${sid}" "${pane}" "${token}"
}

attach_viewer() {
    local session="${1:-}" viewer="${2:-}" step sid vid group vgroup got
    step="attach_viewer ${session}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    sid="$(_scenario_session_id "${step}" "${session}")" || exit 1
    if [[ -z "${viewer}" ]]; then
        viewer="$(_scenario_free_session_name "${SCENARIO_TAG}_viewer")"
    fi
    _scenario_check_session_name "${step}" "${viewer}"
    if _scenario_tmux has-session -t "=${viewer}"; then
        fail "${step}: a session named ${viewer} already exists"
    fi
    vid="$(_scenario_tmux new-session -d -P -F '#{session_id}' -t "${sid}" -s "${viewer}")" \
        || fail "${step}: tmux new-session -t ${sid} failed: $(_scenario_tmux_err)"
    [[ "${vid}" =~ ^\$[0-9]+$ ]] || fail "${step}: tmux new-session printed '${vid}', not a session id"
    group="$(_scenario_tmux display-message -p -t "${sid}:" '#{session_group}')" \
        || fail "${step}: could not read the group of ${sid}: $(_scenario_tmux_err)"
    vgroup="$(_scenario_tmux display-message -p -t "${vid}:" '#{session_group}')" \
        || fail "${step}: could not read the group of ${vid}: $(_scenario_tmux_err)"
    [[ -n "${group}" && "${group}" == "${vgroup}" ]] \
        || fail "${step}: viewer ${vid} is in group '${vgroup}', not ${sid}'s group '${group}'"
    got="$(_scenario_tmux display-message -p -t "${vid}:" '#{session_name}')" || got=""
    [[ "${got}" == "${viewer}" ]] || fail "${step}: viewer ${vid} is named '${got}', not '${viewer}'"
    SEEDED_SESSION_ID="${vid}"
    printf '%s\n' "${vid}"
}

rename_session() {
    local session="${1:-}" new="${2:-}" step sid got
    step="rename_session ${session} ${new}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    sid="$(_scenario_session_id "${step}" "${session}")" || exit 1
    _scenario_check_session_name "${step}" "${new}"
    if _scenario_tmux has-session -t "=${new}"; then
        fail "${step}: a session named ${new} already exists"
    fi
    _scenario_tmux rename-session -t "${sid}" "${new}" \
        || fail "${step}: tmux rename-session failed: $(_scenario_tmux_err)"
    got="$(_scenario_tmux display-message -p -t "${sid}:" '#{session_name}')" \
        || fail "${step}: could not read the name of ${sid}: $(_scenario_tmux_err)"
    [[ "${got}" == "${new}" ]] || fail "${step}: session ${sid} is named '${got}', not '${new}'"
    printf '%s\n' "${sid}"
}

set_remain_on_exit() {
    local session="${1:-}" step sid out w got n=0
    step="set_remain_on_exit ${session}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    sid="$(_scenario_session_id "${step}" "${session}")" || exit 1
    out="$(_scenario_tmux list-windows -t "${sid}" -F '#{window_id}')" \
        || fail "${step}: could not list the windows of ${sid}: $(_scenario_tmux_err)"
    while IFS= read -r w; do
        [[ "${w}" =~ ^@[0-9]+$ ]] || continue
        _scenario_tmux set-option -w -t "${w}" remain-on-exit on \
            || fail "${step}: could not set remain-on-exit on window ${w}: $(_scenario_tmux_err)"
        got="$(_scenario_tmux show-options -w -qv -t "${w}" remain-on-exit)" || got=""
        [[ "${got}" == on ]] || fail "${step}: window ${w}'s remain-on-exit reads '${got}', not on"
        n=$(( n + 1 ))
    done <<< "${out}"
    (( n > 0 )) || fail "${step}: session ${sid} has no window"
}

ad_owner_global_set() {
    local value="${1:-}" step="ad_owner_global_set" token got
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    if [[ -z "${value}" ]]; then
        token="$(ad_new_token)" || exit 1
        # shellcheck disable=SC2016 # $0 is a literal tmux session id
        value="$(ad_owner_label "${token}" '$0' "${SCENARIO_TAG}_global")" || exit 1
    fi
    _scenario_tmux set-option -g @ad_owner "${value}" \
        || fail "${step}: tmux set-option -g @ad_owner failed: $(_scenario_tmux_err)"
    got="$(_scenario_tmux show-options -gqv @ad_owner)" \
        || fail "${step}: could not read the global @ad_owner: $(_scenario_tmux_err)"
    [[ "${got}" == "${value}" ]] || fail "${step}: the global @ad_owner reads '${got}', not '${value}'"
    printf '%s\n' "${value}"
}

ad_owner_global_unset() {
    local step="ad_owner_global_unset" scope got
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    _scenario_tmux set-option -gu @ad_owner \
        || fail "${step}: tmux set-option -gu @ad_owner failed: $(_scenario_tmux_err)"
    # The three scopes agent-director's lookup reads: global, server, global-window.
    for scope in -gqv -sqv -gwqv; do
        got="$(_scenario_tmux show-options "${scope}" @ad_owner)" \
            || fail "${step}: tmux show-options ${scope} @ad_owner failed: $(_scenario_tmux_err)"
        [[ -z "${got}" ]] || fail "${step}: tmux show-options ${scope} @ad_owner still reads '${got}'"
    done
}

respawn_worker_pane() {
    local target="${1:-}" step sid pane old_pid new_pid dead
    step="respawn_worker_pane ${target}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    (( $# >= 2 )) || fail "${step}: takes <pane-id|session> <command> [<arg>...]"
    shift
    if [[ "${target}" =~ ^%[0-9]+$ ]]; then
        pane="${target}"
    else
        sid="$(_scenario_session_id "${step}" "${target}")" || exit 1
        pane="$(_scenario_worker_pane "${step}" "${sid}")" || exit 1
    fi
    old_pid="$(_scenario_tmux display-message -p -t "${pane}" '#{pane_pid}')" \
        || fail "${step}: no pane ${pane} on the scenario's tmux server: $(_scenario_tmux_err)"
    _scenario_tmux respawn-pane -k -t "${pane}" -- "$@" \
        || fail "${step}: tmux respawn-pane failed: $(_scenario_tmux_err)"
    read -r new_pid dead <<< "$(_scenario_tmux display-message -p -t "${pane}" '#{pane_pid} #{pane_dead}')"
    [[ "${new_pid}" =~ ^[0-9]+$ && "${new_pid}" != "${old_pid}" && "${dead}" == 0 ]] \
        || fail "${step}: after the respawn pane ${pane} reads pid '${new_pid}' (was ${old_pid}), dead '${dead}': no new process runs in it"
    _scenario_poll_until 10 _scenario_pid_gone "${old_pid}" \
        || fail "${step}: the pane's old process ${old_pid} still runs 10 s after the respawn"
    printf '%s %s\n' "${pane}" "${new_pid}"
}

restart_tmux_server() {
    local name="${1:-${SCENARIO_TAG}_restart}" step out old_pid new_pid sid
    step="restart_tmux_server"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    _scenario_check_session_name "${step}" "${name}"
    out="$(_scenario_tmux list-sessions -F '#{pid}')" \
        || fail "${step}: no tmux server runs for the scenario: $(_scenario_tmux_err)"
    old_pid="${out%%$'\n'*}"
    [[ "${old_pid}" =~ ^[0-9]+$ ]] || fail "${step}: tmux gave server pid '${old_pid}'"
    _scenario_tmux kill-server || fail "${step}: tmux kill-server failed: $(_scenario_tmux_err)"
    _scenario_poll_until "${SCENARIO_TMUX_STOP_S}" _scenario_pid_gone "${old_pid}" \
        || fail "${step}: the old tmux server ${old_pid} still runs ${SCENARIO_TMUX_STOP_S} s after kill-server"
    out="$(_scenario_tmux new-session -d -P -F '#{pid} #{session_id}' -s "${name}")" \
        || fail "${step}: tmux new-session on the new server failed: $(_scenario_tmux_err)"
    read -r new_pid sid <<< "${out}"
    [[ "${new_pid}" =~ ^[0-9]+$ && "${new_pid}" != "${old_pid}" && "${sid}" =~ ^\$[0-9]+$ ]] \
        || fail "${step}: tmux new-session printed '${out}', not a new server's pid and a session id"
    pid_alive "${new_pid}" || fail "${step}: the new tmux server ${new_pid} is not running"
    printf '%s %s\n' "${new_pid}" "${sid}"
}

rebind_tmux_socket() {
    local name="${1:-}" step out line old_pid sock moved n=1 new_pid sid got
    step="rebind_tmux_socket"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    out="$(_scenario_tmux list-sessions -F '#{pid} #{socket_path}')" \
        || fail "${step}: no tmux server runs for the scenario: $(_scenario_tmux_err)"
    line="${out%%$'\n'*}"
    old_pid="${line%% *}"
    sock="${line#* }"
    [[ "${old_pid}" =~ ^[0-9]+$ ]] || fail "${step}: tmux gave server pid '${old_pid}'"
    [[ "${sock}" == "${SCENARIO_ROOT}/tmux/"* && -S "${sock}" ]] \
        || fail "${step}: refused: the server's socket '${sock}' is not a socket under ${SCENARIO_ROOT}/tmux"
    while [[ -e "${sock}.rebound-${n}" || -L "${sock}.rebound-${n}" ]]; do
        n=$(( n + 1 ))
    done
    moved="${sock}.rebound-${n}"
    if [[ -z "${name}" ]]; then
        name="${SCENARIO_TAG}_rebound_${n}"
    fi
    _scenario_check_session_name "${step}" "${name}"
    # The old server keeps its listening socket, now at the moved path.
    mv -- "${sock}" "${moved}" || fail "${step}: could not move ${sock} to ${moved}"
    out="$(_scenario_tmux new-session -d -P -F '#{pid} #{session_id}' -s "${name}")" \
        || fail "${step}: tmux new-session at ${sock} failed: $(_scenario_tmux_err)"
    read -r new_pid sid <<< "${out}"
    [[ "${new_pid}" =~ ^[0-9]+$ && "${new_pid}" != "${old_pid}" && "${sid}" =~ ^\$[0-9]+$ ]] \
        || fail "${step}: tmux new-session printed '${out}', not a new server's pid and a session id"
    [[ -S "${sock}" ]] || fail "${step}: no socket at ${sock} after the new server started"
    pid_alive "${old_pid}" || fail "${step}: the old tmux server ${old_pid} is gone"
    got="$("${SCENARIO_REAL_TMUX}" -S "${moved}" list-sessions -F '#{pid}' 2> /dev/null)" || got=""
    [[ "${got%%$'\n'*}" == "${old_pid}" ]] \
        || fail "${step}: the moved socket ${moved} answers with server pid '${got%%$'\n'*}', not the old server's ${old_pid}"
    REBOUND_SOCKET="${moved}"
    printf '%s %s %s\n' "${new_pid}" "${sid}" "${moved}"
}

end_session() {
    local sid="${1:-}" step
    step="end_session ${sid}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    [[ "${sid}" =~ ^\$[0-9]+$ ]] || fail "${step}: '${sid}' is not a session id (\$N)"
    _scenario_tmux has-session -t "${sid}" \
        || fail "${step}: no session ${sid} on the scenario's tmux server: $(_scenario_tmux_err)"
    _scenario_tmux kill-session -t "${sid}" \
        || fail "${step}: tmux kill-session failed: $(_scenario_tmux_err)"
    if _scenario_tmux has-session -t "${sid}"; then
        fail "${step}: session ${sid} still exists after kill-session"
    fi
}

# ---------------------------------------------------------------------------
# Store statements and the human's agent-director actions (fmk mode)
# ---------------------------------------------------------------------------

# _scenario_ad_tmux_setting <step> <key> <default>: print the scenario HOME's
# agent-director `[tmux] <key>` from $HOME/.agent-director/config.toml, or
# <default> when the file or the key is absent; fail when it is not a whole
# number.
_scenario_ad_tmux_setting() {
    local step="$1" key="$2" def="$3" file="${HOME}/.agent-director/config.toml" v=""
    if [[ -f "${file}" ]]; then
        v="$(awk -v key="${key}" '
            /^[[:space:]]*\[/ {
                t = $0
                sub(/#.*/, "", t)
                gsub(/[[:space:]]/, "", t)
                intmux = (t == "[tmux]")
                next
            }
            intmux {
                line = $0
                sub(/^[[:space:]]+/, "", line)
                if (index(line, key) != 1) next
                rest = substr(line, length(key) + 1)
                if (rest !~ /^[[:space:]]*=/) next
                sub(/^[[:space:]]*=[[:space:]]*/, "", rest)
                sub(/[[:space:]]*(#.*)?$/, "", rest)
                print rest
                exit
            }
        ' "${file}")" || fail "${step}: could not read ${file}"
    fi
    if [[ -z "${v}" ]]; then
        printf '%s\n' "${def}"
        return 0
    fi
    [[ "${v}" =~ ^[0-9]+$ ]] || fail "${step}: ${file} sets [tmux] ${key} = ${v}, not a whole number"
    printf '%s\n' "$(( 10#${v} ))"
}

ad_store_mark_finished() {
    local id="${1:-}" state="${2:-}" step window before after sock pane created now ended ended_at rv out
    step="ad_store_mark_finished ${id} ${state}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    _scenario_check_instance_id "${step}" "${id}"
    [[ "${state}" == missing || "${state}" == ended ]] || fail "${step}: state '${state}' is neither missing nor ended"
    window="$(_scenario_ad_tmux_setting "${step}" stopping_window_seconds "${SCENARIO_AD_DEFAULT_STOPPING_WINDOW_S}")" \
        || exit 1
    before="$(_scenario_row_json "${step}" "${id}")" || exit 1
    sock="$(jq -r '.[0].tmux_socket // empty' <<< "${before}")"
    pane="$(jq -r '.[0].pane_id // empty' <<< "${before}")"
    rv="$(jq -r '.[0].row_version' <<< "${before}")"
    [[ "${rv}" =~ ^[0-9]+$ ]] || fail "${step}: the row's row_version reads '${rv}'"
    [[ "${pane}" =~ ^%[0-9]+$ ]] || fail "${step}: the row records no pane ('${pane}'), so its worker's session cannot be found"
    [[ "${sock}" == "${SCENARIO_ROOT}"/* ]] \
        || fail "${step}: refused: the row's tmux socket '${sock}' is not under SCENARIO_ROOT"
    created="$("${SCENARIO_REAL_TMUX}" -S "${sock}" display-message -p -t "${pane}" '#{session_created}' 2> "${SCENARIO_ROOT}/harness-tmux.err")" \
        || fail "${step}: could not read the creation of pane ${pane}'s session on ${sock}: $(_scenario_tmux_err)"
    [[ "${created}" =~ ^[0-9]+$ ]] || fail "${step}: tmux gave session creation '${created}'"
    now="$(date +%s)"
    ended=$(( now - window ))
    (( ended > created )) \
        || fail "${step}: refused: the worker's session was created $(( now - created )) s ago, not more than the stopping window (${window} s): ended_at must lie at least the window ago and later, in whole seconds, than the session's creation"
    ended_at="$(date -u -d "@${ended}" '+%Y-%m-%d %H:%M:%S')" || fail "${step}: date could not format ${ended}"
    out="$(ad_store_edit "UPDATE spawns SET state = '${state}', ended_at = '${ended_at}', launch_started_at = NULL, row_version = row_version + 1 WHERE claude_instance_id = '${id}' AND row_version = ${rv} RETURNING claude_instance_id")" \
        || exit 1
    [[ "${out}" == "${id}" ]] || fail "${step}: the row's row_version is no longer ${rv}: agent-director wrote it in between, and the edit wrote nothing"
    after="$(_scenario_row_json "${step}" "${id}")" || exit 1
    _scenario_row_diff_check "${step}" "${before}" "${after}" \
        "{\"state\": \"${state}\", \"ended_at\": \"${ended_at}\", \"launch_started_at\": null, \"row_version\": $(( rv + 1 ))}"
    printf '%s\n' "${ended_at}"
}

ad_store_seed_pending() {
    local id="${1:-}" leftover="${2:-}" step before after rv token started out
    step="ad_store_seed_pending ${id}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_check_instance_id "${step}" "${id}"
    if [[ -n "${leftover}" ]]; then
        [[ "${leftover}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: leftover token '${leftover}' is not 16 lowercase hex characters"
    fi
    before="$(_scenario_row_json "${step}" "${id}")" || exit 1
    rv="$(jq -r '.[0].row_version' <<< "${before}")"
    [[ "${rv}" =~ ^[0-9]+$ ]] || fail "${step}: the row's row_version reads '${rv}'"
    token="$(ad_new_token "${id}" ${leftover:+"${leftover}"})" || exit 1
    started="$(date +%s%3N)"
    [[ "${started}" =~ ^[0-9]+$ ]] || fail "${step}: date gave '${started}' milliseconds"
    out="$(ad_store_edit "UPDATE spawns SET state = 'pending', launch_started_at = ${started}, launch_token = '${token}', ended_at = NULL, pid = NULL, proc_starttime = NULL, tmux_server_pid = NULL, tmux_server_started = NULL, tmux_server_starttime = NULL, pane_id = NULL, pane_pid = NULL, pane_starttime = NULL, row_version = row_version + 1 WHERE claude_instance_id = '${id}' AND row_version = ${rv} RETURNING claude_instance_id")" \
        || exit 1
    [[ "${out}" == "${id}" ]] || fail "${step}: the row's row_version is no longer ${rv}: agent-director wrote it in between, and the edit wrote nothing"
    after="$(_scenario_row_json "${step}" "${id}")" || exit 1
    _scenario_row_diff_check "${step}" "${before}" "${after}" \
        "{\"state\": \"pending\", \"launch_started_at\": ${started}, \"launch_token\": \"${token}\", \"ended_at\": null, \"pid\": null, \"proc_starttime\": null, \"tmux_server_pid\": null, \"tmux_server_started\": null, \"tmux_server_starttime\": null, \"pane_id\": null, \"pane_pid\": null, \"pane_starttime\": null, \"row_version\": $(( rv + 1 ))}"
    ad_capture status --claude-instance-id "${id}"
    [[ "${AD_RC}" == 0 ]] \
        || fail "${step}: the harness status read exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
    jq -e 'type == "object" and .state == "pending" and has("launch_started_at")' "${AD_OUT}" > /dev/null 2>&1 \
        || fail "${step}: after the edit the row does not read pending with a launch start: $(tr '\n' ' ' < "${AD_OUT}")"
    printf '%s\n' "${token}"
}

ad_store_unusable_name() {
    local id="${1:-}" name="${2:-}" step before after state rv out
    step="ad_store_unusable_name ${id} ${name}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_check_instance_id "${step}" "${id}"
    [[ "${name}" == *.* && "${name}" =~ ^[A-Za-z0-9._-]+$ ]] \
        || fail "${step}: name '${name}' holds no '.', or a character other than letters, digits and ._-"
    before="$(_scenario_row_json "${step}" "${id}")" || exit 1
    state="$(jq -r '.[0].state' <<< "${before}")"
    rv="$(jq -r '.[0].row_version' <<< "${before}")"
    [[ "${state}" == ended || "${state}" == missing ]] \
        || fail "${step}: refused: the row reads ${state}, not a finished state (ended or missing)"
    [[ "${rv}" =~ ^[0-9]+$ ]] || fail "${step}: the row's row_version reads '${rv}'"
    out="$(ad_store_edit "UPDATE spawns SET tmux_session_name = '${name}' WHERE claude_instance_id = '${id}' AND state IN ('ended', 'missing') AND row_version = ${rv} RETURNING claude_instance_id")" \
        || exit 1
    [[ "${out}" == "${id}" ]] || fail "${step}: the row changed under the edit (no longer finished at row_version ${rv}), and the edit wrote nothing"
    after="$(_scenario_row_json "${step}" "${id}")" || exit 1
    _scenario_row_diff_check "${step}" "${before}" "${after}" "{\"tmux_session_name\": \"${name}\"}"
}

# _scenario_finished_kill_words: succeed when _L_WORDS is a finished-row
# kill: agent-director-admin's `kill-finished`, or a `kill` carrying
# --include-finished (`-` or `--`, with or without `=<value>`), the flag's
# spelling before agent-director moved that kill to agent-director-admin.
_scenario_finished_kill_words() {
    local a
    _scenario_ad_verb
    [[ "${_L_VERB}" == kill-finished ]] && return 0
    [[ "${_L_VERB}" == kill ]] || return 1
    for a in ${_L_ARGS[@]+"${_L_ARGS[@]}"}; do
        [[ "${a}" =~ ^--?include-finished(=.*)?$ ]] && return 0
    done
    return 1
}

# _scenario_finished_kill_lines: print how many `call` lines of the
# agent-director shim's log are a finished-row kill.
_scenario_finished_kill_lines() {
    local lines=() i n=0
    _scenario_read_log "_scenario_finished_kill_lines" "${SCENARIO_AD_SHIM_LOG}" lines
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        _scenario_decode_words
        _scenario_finished_kill_words && n=$(( n + 1 ))
    done
    printf '%s\n' "${n}"
}

ad_kill_include_finished() {
    local id="${1:-}" step before
    step="ad_kill_include_finished ${id}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_check_instance_id "${step}" "${id}"
    check_ad_admin_shim "${step}"
    before="$(_scenario_finished_kill_lines)"
    # ad_admin_capture runs agent-director-admin as a direct child of this
    # shell: the scenario's own shell, or the subshell of it this is called in.
    ad_admin_capture kill-finished --claude-instance-id "${id}"
    AD_KILL_OUT="${AD_OUT}"
    AD_KILL_ERR="${AD_ERR}"
    AD_KILL_RC="${AD_RC}"
    if (( AD_KILL_RC != 0 )); then
        sed 's/^/  | /' "${AD_KILL_OUT}" "${AD_KILL_ERR}" >&2
        fail "${step}: agent-director-admin kill-finished exited ${AD_KILL_RC}"
    fi
    jq -e 'type == "object" and has("kill_sent")' "${AD_KILL_OUT}" > /dev/null 2>&1 \
        || fail "${step}: agent-director-admin kill-finished printed no result holding kill_sent: $(tr '\n' ' ' < "${AD_KILL_OUT}")"
    (( $(_scenario_finished_kill_lines) > before )) \
        || fail "${step}: the agent-director shim's log holds no new kill-finished call line"
    cat -- "${AD_KILL_OUT}"
}

ad_delete_unusable_row() {
    local id="${1:-}" step name n
    step="ad_delete_unusable_row ${id}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_check_instance_id "${step}" "${id}"
    name="$(_scenario_store_read "${step}" "SELECT tmux_session_name FROM spawns WHERE claude_instance_id = '${id}'")" \
        || exit 1
    [[ -n "${name}" ]] || fail "${step}: no row has instance id ${id}"
    # The one delete the harness makes: scenario 25's removal of the row
    # whose recorded name ad_store_unusable_name made unusable.
    [[ "${name}" == *.* ]] \
        || fail "${step}: refused: the row's recorded session name '${name}' holds no '.'; this step removes only the row scenario 25 made unusable"
    check_ad_admin_shim "${step}"
    ad_admin_capture delete --claude-instance-id "${id}"
    if (( AD_RC != 0 )); then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: agent-director-admin delete exited ${AD_RC}"
    fi
    jq -e --arg id "${id}" '.results[$id] == "ok"' "${AD_OUT}" > /dev/null 2>&1 \
        || fail "${step}: agent-director-admin delete did not report ${id} ok: $(tr '\n' ' ' < "${AD_OUT}")"
    n="$(_scenario_store_read "${step}" "SELECT count(*) FROM spawns WHERE claude_instance_id = '${id}'")" || exit 1
    [[ "${n}" == 0 ]] || fail "${step}: the row is still in the store after delete: $(tr '\n' ' ' < "${AD_OUT}")"
}

# ---------------------------------------------------------------------------
# The find-missing loop (fmk mode; b.jg5 SRJ-1401)
# ---------------------------------------------------------------------------

# _scenario_find_missing_loop <dir> <interval-s>: the loop's body, run in a
# background subshell of the scenario's shell: `find-missing` through the
# harness call, its log line and output, then the interval, until SIGTERM.
_scenario_find_missing_loop() {
    local dir="$1" interval="$2" n rc start end sleeper=""
    trap '[[ -z "${sleeper}" ]] || kill "${sleeper}" 2> /dev/null; exit 0' TERM
    n="$(grep -c '^run ' "${dir}/loop.log" 2> /dev/null)" || true
    n="${n:-0}"
    while :; do
        n=$(( n + 1 ))
        rc=0
        start="${EPOCHREALTIME/,/.}"
        ad find-missing > "${dir}/run.${n}.out" 2> "${dir}/run.${n}.err" || rc=$?
        end="${EPOCHREALTIME/,/.}"
        {
            printf 'run %d\tstart %s\tend %s\texit %d\n' "${n}" "${start}" "${end}" "${rc}"
            sed 's/^/  out| /' "${dir}/run.${n}.out"
            sed 's/^/  err| /' "${dir}/run.${n}.err"
        } >> "${dir}/loop.log"
        sleep "${interval}" &
        sleeper=$!
        wait "${sleeper}" || true
        sleeper=""
    done
}

run_find_missing_loop() {
    local interval="${1:-${SCENARIO_FIND_MISSING_INTERVAL_S}}" step dir
    step="run_find_missing_loop ${interval}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    [[ "${interval}" =~ ^[1-9][0-9]*$ ]] || fail "${step}: interval '${interval}' is not a whole number of seconds above 0"
    if [[ -n "${_SCENARIO_FM_LOOP_PID}" ]] && pid_alive "${_SCENARIO_FM_LOOP_PID}"; then
        fail "${step}: the find-missing loop already runs (PID ${_SCENARIO_FM_LOOP_PID})"
    fi
    dir="${SCENARIO_ROOT}/find-missing-loop"
    mkdir -p "${dir}" || fail "${step}: could not create ${dir}"
    FIND_MISSING_LOOP_LOG="${dir}/loop.log"
    : >> "${FIND_MISSING_LOOP_LOG}" || fail "${step}: could not create ${FIND_MISSING_LOOP_LOG}"
    FIND_MISSING_LOOP_INTERVAL_S="${interval}"
    ( _scenario_find_missing_loop "${dir}" "${interval}" ) < /dev/null &
    _SCENARIO_FM_LOOP_PID=$!
    FIND_MISSING_LOOP_PID="${_SCENARIO_FM_LOOP_PID}"
    track_pid "${_SCENARIO_FM_LOOP_PID}"
}

stop_find_missing_loop() {
    local timeout_s="${1:-30}" step="stop_find_missing_loop" pid
    require_ci_image "${step}"
    require_scenario_home "${step}"
    pid="${_SCENARIO_FM_LOOP_PID}"
    [[ -n "${pid}" ]] || fail "${step}: no find-missing loop was started"
    stop_tracked_pid "${pid}" "${timeout_s}" "${step}: the loop (PID ${pid}) did not end on SIGTERM"
    wait "${pid}" 2> /dev/null || true
    _SCENARIO_FM_LOOP_PID=""
}

find_missing_loop_runs() {
    local n
    require_ci_image "find_missing_loop_runs"
    require_scenario_home "find_missing_loop_runs"
    n="$(grep -c '^run ' "${SCENARIO_ROOT}/find-missing-loop/loop.log" 2> /dev/null)" || true
    printf '%s\n' "${n:-0}"
}

# True once the loop's log holds <want> runs, or the loop no longer runs.
_scenario_fm_progress() {
    (( $(find_missing_loop_runs) >= $1 )) || ! pid_alive "${_SCENARIO_FM_LOOP_PID}"
}

wait_find_missing_runs() {
    local more="${1:-}" timeout_s="${2:-}" step base want got
    step="wait_find_missing_runs ${more}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    [[ "${more}" =~ ^[1-9][0-9]*$ ]] || fail "${step}: '${more}' is not a whole number of runs above 0"
    [[ -n "${_SCENARIO_FM_LOOP_PID}" ]] && pid_alive "${_SCENARIO_FM_LOOP_PID}" \
        || fail "${step}: the find-missing loop is not running"
    timeout_s="${timeout_s:-$(( more * FIND_MISSING_LOOP_INTERVAL_S + 60 ))}"
    _scenario_check_timeout "${timeout_s}" "${step}"
    base="$(find_missing_loop_runs)"
    want=$(( base + more ))
    _scenario_poll_until "${timeout_s}" _scenario_fm_progress "${want}" || true
    got="$(find_missing_loop_runs)"
    (( got >= want )) && return 0
    pid_alive "${_SCENARIO_FM_LOOP_PID}" \
        || fail "${step}: the find-missing loop stopped after ${got} run(s), before ${want}"
    fail "${step}: the loop's log holds ${got} run(s), not ${want}, after ${timeout_s}s"
}

# ---------------------------------------------------------------------------
# The 0.10.0 seeders (fmk mode; b.jg5 SRJ-1306, SRJ-1402, SRJ-1424)
# ---------------------------------------------------------------------------

# _scenario_require_010 <step>: refuse unless the binary behind the shim,
# run by its own name (no shim line), reports 0.10.0, no install_ad_release
# has run in this shell, and the store, if any, has no store_meta table (the
# release's install has not migrated it).
_scenario_require_010() {
    local step="$1" real="${HOME}/.agent-director/bin/agent-director.real" out ver n
    (( _SCENARIO_INSTALL_COUNT == 0 )) \
        || fail "${step}: refused: the release's install.sh has run in this HOME (${_SCENARIO_INSTALL_COUNT} run(s)); the 0.10.0 seeders run before it"
    check_ad_shim "${step}"
    out="$("${real}" version 2>&1)" || fail "${step}: the binary behind the shim (${real}) failed its version call: ${out//$'\n'/ }"
    ver="$(jq -r '.version // empty' <<< "${out}" 2> /dev/null)" || ver=""
    [[ "${ver}" == "${SCENARIO_AD_010_VERSION}" ]] \
        || fail "${step}: refused: the binary behind the shim reports version '${ver}', not ${SCENARIO_AD_010_VERSION}"
    if [[ -f "${HOME}/.agent-director/state.db" ]]; then
        n="$(_scenario_store_read "${step}" "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'store_meta'")" \
            || exit 1
        [[ "${n}" == 0 ]] \
            || fail "${step}: refused: the store has a store_meta table, so the release's install has migrated it"
    fi
}

# _scenario_stub_mode_of <dir>: print the stub mode last selected for <dir>
# (by its real path), or nothing when none was.
_scenario_stub_mode_of() {
    local real file="${SCENARIO_BIN}/${SCENARIO_STUB_MODES_NAME}" mode path last=""
    real="$(realpath -e -- "$1" 2> /dev/null)" || return 0
    [[ -f "${file}" ]] || return 0
    while IFS=$'\t' read -r mode path; do
        [[ "${path}" == "${real}" ]] && last="${mode}"
    done < "${file}"
    printf '%s\n' "${last}"
}

# True once the row's state is one other than `pending`.
_scenario_row_left_pending() {
    local state
    state="$(_scenario_store_read "$1" "SELECT state FROM spawns WHERE claude_instance_id = '$2'")" || exit 1
    [[ -n "${state}" && "${state}" != pending ]]
}

seed_010_row() {
    local id="${1:-}" name="${2:-}" dir="${3:-}" step mode label args=() out sid pane ppid argv=() a found=0 state
    step="seed_010_row ${id}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    _scenario_require_010 "${step}"
    (( $# >= 3 )) || fail "${step}: takes <instance-id> <session-name> <dir> [<key>=<value>...]"
    shift 3
    _scenario_check_instance_id "${step}" "${id}"
    [[ -n "${name}" && "${name}" != *[.:#[:cntrl:]]* && ${#name} -le 64 ]] \
        || fail "${step}: session name '${name}' is empty, longer than 64 bytes or holds '.', ':', '#' or a control character"
    [[ "${dir}" == /* && -d "${dir}" ]] || fail "${step}: working directory '${dir}' is not an absolute path to a directory"
    for label in "$@"; do
        [[ "${label}" =~ ^[^=]+= ]] || fail "${step}: label '${label}' is not <key>=<value>"
        args+=(--label "${label}")
    done
    if _scenario_tmux has-session -t "=${name}"; then
        fail "${step}: a session named ${name} already exists"
    fi
    mode="$(_scenario_stub_mode_of "${dir}")"
    if [[ -z "${mode}" ]]; then
        stub_mode "${dir}" "${STUB_MODE_AT_ONCE}"
        mode="${STUB_MODE_AT_ONCE}"
    fi
    ad_capture spawn --cwd "${dir}" --claude-instance-id "${id}" --tmux-session-name "${name}" \
        ${args[@]+"${args[@]}"}
    if (( AD_RC != 0 )); then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: 0.10.0's spawn exited ${AD_RC}"
    fi
    out="$(_scenario_tmux display-message -p -t "=${name}:" '#{session_id} #{pane_id} #{pane_pid}')" \
        || fail "${step}: no session ${name} on the scenario's tmux server after the spawn: $(_scenario_tmux_err)"
    read -r sid pane ppid <<< "${out}"
    [[ "${sid}" =~ ^\$[0-9]+$ && "${pane}" =~ ^%[0-9]+$ && "${ppid}" =~ ^[0-9]+$ ]] \
        || fail "${step}: tmux read '${out}' for session ${name}"
    mapfile -d '' -t argv 2> /dev/null < "/proc/${ppid}/cmdline" || true
    for a in ${argv[@]+"${argv[@]}"}; do
        [[ "${a}" == "${SCENARIO_BIN}/claude" ]] && found=1
    done
    (( found )) || fail "${step}: the session's pane process ${ppid} is not the stub ${SCENARIO_BIN}/claude"
    if [[ "${mode}" == "${STUB_MODE_AT_ONCE}" ]]; then
        wait_until "${SCENARIO_SEED_REPORT_S}" "${step}: the row never reported in" \
            _scenario_row_left_pending "${step}" "${id}"
        state="$(_scenario_store_read "${step}" "SELECT state FROM spawns WHERE claude_instance_id = '${id}'")" || exit 1
        case "${state}" in
            waiting | working | ask_user | check_permission) ;;
            *) fail "${step}: the row reads ${state} after its worker reported in, not a live state" ;;
        esac
    fi
    SEEDED_SESSION_ID="${sid}"
    SEEDED_PANE_ID="${pane}"
    printf '%s %s %s %s\n' "${id}" "${name}" "${sid}" "${pane}"
}

# _scenario_normalize_channel_name <step> <name>: the published pre-persona
# package's normalizeChannelName (its src/config.ts): lowercased, every run
# of characters other than a-z and 0-9 one `_`, leading and trailing `_`
# dropped. ASCII names only.
_scenario_normalize_channel_name() {
    if [[ "$2" == *$'\n'* ]] || LC_ALL=C grep -q '[^ -~]' <<< "$2"; then
        fail "$1: channel name '$2' is not printable ASCII"
    fi
    printf '%s' "$2" | LC_ALL=C tr '[:upper:]' '[:lower:]' \
        | LC_ALL=C sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//'
    echo
}

seed_prepersona_fleet() {
    local config="${1:-}" step spec cid norm cwd out i ids=() insts=() sesss=() cwds=() lines=()
    local -A names=()
    step="seed_prepersona_fleet ${config}"
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    _scenario_require_010 "${step}"
    (( $# >= 1 )) || fail "${step}: takes <config.json> <channel-id>=<channel-name>..."
    shift
    [[ -f "${config}" ]] || fail "${step}: no file at '${config}'"
    jq -e '.routes | type == "object" and length > 0' "${config}" > /dev/null 2>&1 \
        || fail "${step}: ${config} has no non-empty routes object (not a pre-persona config)"
    for spec in "$@"; do
        [[ "${spec}" == ?*=* ]] || fail "${step}: '${spec}' is not <channel-id>=<channel-name>"
        names["${spec%%=*}"]="${spec#*=}"
    done
    out="$(jq -r '.routes | keys_unsorted[]' "${config}")" || fail "${step}: could not read the routes of ${config}"
    mapfile -t ids <<< "${out}"
    for cid in "${!names[@]}"; do
        jq -e --arg c "${cid}" '.routes | has($c)' "${config}" > /dev/null 2>&1 \
            || fail "${step}: channel ${cid} has a name given but no route in ${config}"
    done
    # Every route is checked and named before the first row is made.
    for cid in "${ids[@]}"; do
        [[ "${cid}" =~ ^[A-Za-z0-9]+$ ]] || fail "${step}: routed channel id '${cid}' is not letters and digits"
        [[ -n "${names[${cid}]+set}" ]] \
            || fail "${step}: no Slack channel name given for routed channel ${cid} (the package reads it from Slack, never from config.json)"
        norm="$(_scenario_normalize_channel_name "${step}" "${names[${cid}]}")" || exit 1
        if [[ -n "${norm}" ]]; then
            insts+=("cscb_${norm}_${cid}")
            sesss+=("slack_bot_${norm}_${cid}")
        else
            insts+=("cscb_${cid}")
            sesss+=("slack_bot_${cid}")
        fi
        cwd="$(jq -r --arg c "${cid}" '.routes[$c].cwd // empty' "${config}")" \
            || fail "${step}: could not read routes[${cid}].cwd"
        if [[ "${cwd}" == "~" ]]; then
            cwd="${HOME}"
        elif [[ "${cwd}" == "~/"* ]]; then
            cwd="${HOME}${cwd:1}"
        fi
        [[ "${cwd}" == /* ]] || fail "${step}: routes[${cid}].cwd '${cwd}' is not absolute after ~ expansion"
        cwd="$(realpath -m -s -- "${cwd}")" || fail "${step}: could not normalize ${cwd}"
        [[ -d "${cwd}" ]] || fail "${step}: routes[${cid}].cwd ${cwd} is not a directory"
        cwds+=("${cwd}")
    done
    for i in "${!ids[@]}"; do
        seed_010_row "${insts[i]}" "${sesss[i]}" "${cwds[i]}" service=cscb "channel=${ids[i]}" > /dev/null
        lines+=("${ids[i]} ${insts[i]} ${sesss[i]} ${SEEDED_SESSION_ID} ${SEEDED_PANE_ID}")
    done
    printf '%s\n' "${lines[@]}"
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
    local step=assert_no_cscb_include_finished lines=() bad=() i control=0
    _scenario_query_prep "${step}"
    _scenario_read_log "${step}" "${SCENARIO_AD_SHIM_LOG}" lines
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        if _scenario_role_at "${_L_PPID}" "${_L_US}" && [[ "${_SCENARIO_ROLE}" == server ]]; then
            control=1
        fi
        _scenario_decode_words
        _scenario_finished_kill_words || continue
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
        || _scenario_offending "${step}" "${SCENARIO_AD_SHIM_LOG}" "run a finished-row kill (kill-finished, or kill with --include-finished) from a parent other than the scenario's own shell or a subshell of it" "${bad[@]}"
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
# Scenario 10's harness additions (fmk mode; each a harness addition, confirm
# at the reconcile pass)
# ---------------------------------------------------------------------------

# _scenario_printed <step> <entry> [<arg>...]: print fixtures/fmk-texts.ts's
# value for <entry>; fail when the printer fails.
_scenario_printed() {
    local step="$1" entry="$2" out
    shift 2
    out="$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" "${entry}" "$@")" \
        || fail "${step}: fmk-texts could not print ${entry}"
    printf '%s\n' "${out}"
}

write_ad_tmux_table() {
    local step="write_ad_tmux_table $*" rel table path dir real_root real_dir pair key value body got
    require_ci_image "${step}"
    require_scenario_home "${step}"
    [[ "${SCENARIO_FMK}" == 1 ]] || fail "${step}: the scenario HOME's agent-director config is for fmk scripts only"
    rel="$(_scenario_printed "${step}" AD_SETTINGS_RELATIVE_PATH)" || exit 1
    [[ -n "${rel}" && "${rel}" != /* && "/${rel}/" != */../* && "${rel}" != *[[:cntrl:]]* ]] \
        || fail "${step}: refused: the settings path '${rel}' is not a relative path inside HOME"
    path="${HOME}/${rel}"
    dir="$(dirname -- "${path}")"
    real_root="$(realpath -e -- "${SCENARIO_ROOT}" 2> /dev/null)" \
        || fail "${step}: refused: cannot resolve SCENARIO_ROOT ${SCENARIO_ROOT}"
    real_dir="$(realpath -m -- "${dir}" 2> /dev/null)" || fail "${step}: cannot resolve ${dir}"
    [[ "${real_dir}" == "${real_root}"/* ]] \
        || fail "${step}: refused: ${dir} resolves to ${real_dir}, which is not under SCENARIO_ROOT ${real_root}"
    if (( $# == 0 )); then
        rm -f -- "${path}" || fail "${step}: could not remove ${path}"
        [[ ! -e "${path}" ]] || fail "${step}: ${path} is still there after its removal"
        return 0
    fi
    table="$(_scenario_printed "${step}" AD_TMUX_TABLE)" || exit 1
    [[ "${table}" =~ ^[A-Za-z0-9_]+$ ]] || fail "${step}: the printed table name '${table}' is not a bare TOML key"
    body="[${table}]"$'\n'
    for pair in "$@"; do
        key="${pair%%=*}"
        value="${pair#*=}"
        [[ "${pair}" == *=* && "${key}" =~ ^[A-Za-z0-9_]+$ && -n "${value}" && "${value}" != *[$'\n\r']* ]] \
            || fail "${step}: '${pair}' is not <key>=<TOML value> on one line"
        body+="${key} = ${value}"$'\n'
    done
    mkdir -p -- "${dir}" || fail "${step}: could not create ${dir}"
    write_file "${path}" < <(printf '%s' "${body}")
    got="$(cat -- "${path}" && printf x)" || fail "${step}: could not read ${path} back"
    [[ "${got%x}" == "${body}" ]] || fail "${step}: ${path} does not hold the table as written"
}

start_second_tmux_server() {
    local name="${1:-${SCENARIO_TAG}_second}" step="start_second_tmux_server" dir sock out pid sid got
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    _scenario_check_session_name "${step}" "${name}"
    [[ -z "${SECOND_TMUX_SOCKET:-}" ]] \
        || fail "${step}: a second tmux server was already started (${SECOND_TMUX_SOCKET})"
    dir="${SCENARIO_ROOT}/tmux-second/tmux-$(id -u)"
    sock="${dir}/default"
    [[ "${sock}" != "${TMUX_TMPDIR}"/* ]] || fail "${step}: refused: ${sock} is under the scenario's own TMUX_TMPDIR"
    mkdir -p -- "${dir}" || fail "${step}: could not create ${dir}"
    chmod 00700 "${SCENARIO_ROOT}/tmux-second" "${dir}" || fail "${step}: could not set the modes of ${dir}"
    [[ ! -e "${sock}" ]] || fail "${step}: ${sock} already exists"
    out="$("${SCENARIO_REAL_TMUX}" -S "${sock}" new-session -d -P -F '#{pid} #{session_id}' -s "${name}" 2> "${SCENARIO_ROOT}/harness-tmux.err")" \
        || fail "${step}: tmux new-session on ${sock} failed: $(_scenario_tmux_err)"
    read -r pid sid <<< "${out}"
    [[ "${pid}" =~ ^[0-9]+$ && "${sid}" =~ ^\$[0-9]+$ ]] \
        || fail "${step}: tmux new-session printed '${out}', not a server pid and a session id"
    got="$("${SCENARIO_REAL_TMUX}" -S "${sock}" list-sessions -F '#{pid}' 2> "${SCENARIO_ROOT}/harness-tmux.err")" \
        || fail "${step}: ${sock} does not answer: $(_scenario_tmux_err)"
    [[ "${got%%$'\n'*}" == "${pid}" && -S "${sock}" ]] \
        || fail "${step}: ${sock} answers with server pid '${got%%$'\n'*}', not the new server's ${pid}"
    pid_alive "${pid}" || fail "${step}: the new tmux server ${pid} is not running"
    SECOND_TMUX_SOCKET="${sock}"
    SECOND_TMUX="${sock},${pid},${sid#\$}"
    printf '%s\n' "${SECOND_TMUX}"
}

ad_shim_mark() {
    require_ci_image "ad_shim_mark"
    [[ "${SCENARIO_FMK}" == 1 ]] || fail "ad_shim_mark: the shim log is for fmk scripts only"
    if [[ -f "${SCENARIO_AD_SHIM_LOG}" ]]; then
        wc -l < "${SCENARIO_AD_SHIM_LOG}" | tr -d ' '
    else
        echo 0
    fi
}

# _scenario_ad_window <step> <from-mark> <to-mark|->: copy the shim log's
# lines after <from-mark> up to <to-mark> to a new file under SCENARIO_ROOT
# and print its path.
_scenario_ad_window() {
    local step="$1" from="$2" to="$3" file
    require_ci_image "${step}"
    [[ "${from}" =~ ^[0-9]+$ ]] || fail "${step}: mark '${from}' is not a line count"
    if [[ "${to}" == - ]]; then
        to="$(ad_shim_mark)"
    fi
    [[ "${to}" =~ ^[0-9]+$ ]] || fail "${step}: mark '${to}' is not a line count"
    mkdir -p -- "${SCENARIO_ROOT}/ad-windows" || fail "${step}: could not create ${SCENARIO_ROOT}/ad-windows"
    file="$(mktemp "${SCENARIO_ROOT}/ad-windows/window.XXXXXX")" || fail "${step}: could not create a window file"
    if (( to > from )); then
        sed -n "$(( from + 1 )),${to}p" "${SCENARIO_AD_SHIM_LOG}" > "${file}" \
            || fail "${step}: could not copy lines $(( from + 1 )) to ${to} of ${SCENARIO_AD_SHIM_LOG}"
    fi
    printf '%s\n' "${file}"
}

cscb_ad_calls_between() {
    local file
    file="$(_scenario_ad_window "cscb_ad_calls_between" "${1-}" "${2-}")" || exit 1
    ( SCENARIO_AD_SHIM_LOG="${file}"; cscb_ad_calls "${3-}" "${@:4}" )
}

cscb_ad_count_between() {
    local file
    file="$(_scenario_ad_window "cscb_ad_count_between" "${1-}" "${2-}")" || exit 1
    ( SCENARIO_AD_SHIM_LOG="${file}"; cscb_ad_count "${3-}" "${@:4}" )
}

# _scenario_slack_record <step> <record>: fail unless <record> is a file under
# SCENARIO_ROOT.
_scenario_slack_record() {
    require_ci_image "$1"
    [[ -n "$2" && "$2" == "${SCENARIO_ROOT}"/* && -f "$2" ]] \
        || fail "$1: '$2' is not a Slack stub record under SCENARIO_ROOT"
}

slack_record_mark() {
    local record="${1:-}" out
    _scenario_slack_record "slack_record_mark" "${record}"
    out="$(jq -s 'map(.seq // 0) | max // 0' "${record}")" \
        || fail "slack_record_mark: jq could not read ${record}"
    printf '%s\n' "${out}"
}

slack_posts() {
    local record="${1:-}" label="${2:-}" after="${3:-0}" step="slack_posts ${2:-}"
    _scenario_slack_record "${step}" "${record}"
    [[ -n "${label}" ]] || fail "${step}: no label given"
    [[ "${after}" =~ ^[0-9]+$ ]] || fail "${step}: '${after}' is not a seq"
    jq -c --arg l "${label}" --argjson a "${after}" \
        'select(.event == "api" and .method == "chat.postMessage" and .label == $l and (.seq // 0) > $a) | .text' \
        "${record}" || fail "${step}: jq could not read ${record}"
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
    case "${SCENARIO_AD_START:=release}" in
        release | 0.10.0) ;;
        *) fail "SCENARIO_AD_START '${SCENARIO_AD_START}' is neither release nor 0.10.0" ;;
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
        install_ad_release "fmk setup: install the release"
        [[ -f "${HOME}/.agent-director/state.db" ]] \
            || fail "fmk setup: the release's install.sh made no store at ${HOME}/.agent-director/state.db"
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
