#!/usr/bin/env bash
# Test 19 (HO §7 scenarios 7, 12 and 18; b.jg5 SRJ-1409, SRJ-1414, SRJ-1419;
# AC 1, AC 49): reuse replaces delete, and a re-added persona starts fresh.
#
# Scenario 7 (SRJ-1409): with `resume_enabled=false`, and separately with a
# missing transcript, a
# persona whose row is finished is brought up by a reuse spawn of its own id
# (`spawn --reuse-finished`), never a delete: the row reads `pending` with a
# `launch_started_at`, then `waiting`; `get`'s `prior_sessions` does not list
# the earlier life's session; the launch's `pre_trust` line says `ok`; and a
# `resume` of the new life before it is messaged answers
# ErrJsonlNeverWritten. In the missing-transcript leg the lost-transcript
# diagnosis runs before the reuse spawn (b.jg5 SRJ-707, SRJ-708, SRJ-711,
# SRJ-712, SRJ-413, SRJ-716, SRJ-1306, SRJ-1401, SRJ-1418; E22's hatch note:
# no CSCB `delete`).
#
# Scenario 12 (SRJ-1414): a `missing` row with no session id while a session
# with the persona's exact name and label runs, and an `ended` row with a
# stale `config_dir` label while its own session still runs. CSCB deletes
# nothing: the first gets ErrNoSessionId from its `resume`, the second is
# never resumed; each reuse spawn of the persona's id is refused (UNAVAILABLE
# or CONFLICT) while the session runs; once the harness has ended the session
# a reuse succeeds and the persona starts fresh (b.jg5 SRJ-1414, SRJ-707,
# SRJ-709, SRJ-410, SRJ-501, SRJ-505, SRJ-716, SRJ-1401, SRJ-1418; E22's hatch
# note: no CSCB `delete`).
#
# Scenario 18 (SRJ-1419): a persona that was messaged, removed and applied,
# then, after a server restart, added back with the same key, working
# directory and config directory, comes back by a reuse spawn of its id and
# is never resumed: the first CSCB spawn after the re-add carries
# `--reuse-finished`, no CSCB `resume` of its id is made from the removal on,
# and a harness `get` shows the old session neither as current nor in
# `prior_sessions`. The same holds for a messaged persona whose
# `credentials_file` path changes, a destructive modify (AC 49). A removal
# records the key `removed`, the old half of a destructive modify
# `destructive-modify`, and while a key is recorded every launch is a reuse
# (b.jg5 SRJ-1419, SRJ-803, SRJ-805, SRJ-806, SRJ-807, SRJ-715, SRJ-711,
# SRJ-1401, SRJ-1418; E25's hatch note: a re-added persona starts fresh by
# reuse, never resumed).
#
# fmk setup (lib/scenario.sh fmk mode; b.jg5 SRJ-1306, SRJ-1401):
# - its own HOME, agent-director store and tmux server, all under
#   SCENARIO_ROOT, with the agent-director shim in front of the binary and the
#   tmux shim first on the PATH of every CSCB process (the bot server, `start`
#   and `stop` runs), which agent-director inherits;
# - the release start (SCENARIO_AD_START unset: the 0.11.0 release, installed
#   by its install.sh at sourcing), at agent-director's default settings (no
#   config.toml);
# - CSCB's configuration: `health_check_interval` 0, so no health tick
#   reconnects or relaunches a persona, and `session_restart_delay` 0, so the
#   MCP session a stub's exit closes schedules no restart (SRJ-1401: CSCB's
#   timings are changed only through its configuration); `resume_enabled`
#   false for leg E, true (the default, written out) for legs F, G, H, J and
#   K;
# - every start is live (`start_server --live`), against the loopback Slack
#   stub (fixtures/slack-stub-server.ts, one for the script, every persona's
#   token pair answered ok);
# - each leg has its own persona (key, credentials, channel, directories):
#   E (`resume_enabled=false` leg), F (missing-transcript leg), G (missing-row
#   leg), H (stale `config_dir` leg), J (removed-and-re-added leg) and K
#   (`credentials_file` leg); each is a Slack destination (its channel takes
#   its permission prompts). K has a second credentials file, its own fake
#   token pair under its own label, written like every persona's (the Slack
#   stub answers it ok too). J's and K's claude_config_dir is the scenario
#   HOME's `.claude`, the directory the stub writes every transcript under, so
#   a messaged life's transcript is where agent-director's `resume` looks for
#   its session (`<CLAUDE_CONFIG_DIR>/projects/<slug of the cwd>/<session
#   id>.jsonl`, the path it tries when the row records no `jsonl_path`;
#   working default). H's claude_config_dir is a symlink
#   under SCENARIO_ROOT to one directory, re-pointed to another by
#   `repoint_symlink` (ruling S5's working default: CSCB writes the
#   `config_dir` label by real path and compares the persona's directory by
#   real path, so the re-point makes the row's label stale with no config
#   edit). Each persona's claude_config_dir (both of H's directories) holds
#   a `.claude.json` (`{}`), as a user's
#   Claude config does, so agent-director's pre-trust has a file to write
#   (`pre_trust` `ok`; with no file it reports `failed`). Between legs the
#   harness plays the operator while the server is stopped: config.json is
#   rewritten to the next leg's persona and settings and the last-applied
#   record moved aside, so the next start applies config.json as it stands
#   (README "Reload"). In scenario 18 the operator also edits config.json on
#   the running server and confirms the change by renaming the pending file
#   the reload tick writes to the apply file;
# - checks read only their own leg's ids and window: server.log and
#   startup-errors.log from the leg's mark line, CSCB's agent-director calls
#   (`cscb_ad_calls`: only the agent-director shim's lines whose parent is a
#   CSCB process) from the mark's time; rows by a harness `get` or `status`;
#   posts from the Slack stub's record from the mark's line;
# - the harness runs no `find-missing` (b.jg5 SRJ-1401): every row is marked
#   by agent-director's own hooks or by CSCB's own runs.
#
# Stub modes (fixtures/stub-claude.sh): each persona's first life runs
# `dev-channels` (the reporting stub: the approver's Enter makes it report in,
# and it writes its transcript before SessionStart). Its new life runs
# `transcript-on-first-message` (a harness addition): the same dialog and report-in, but no transcript until a message is
# typed, so the new life's SessionStart finds no transcript, as a real
# never-messaged life's does. Each life is ended by the harness typing the
# stub's exit sentinel into the persona's pane (`stub_type_line`, a harness
# addition): the stub fires SessionEnd and
# exits, and the row reads `ended`. In scenario 12's legs, G's first life
# and its leftover run `silent` (no dialog and no hook: the row keeps no
# session id, and a read of the leftover's pane shows no dialog for CSCB to
# answer) and G's new life `dev-channels`; H's lives run `dev-channels`. In
# scenario 18 every life of J and K runs `transcript-on-first-message`, and
# the harness types a first message into each first life (`stub_type_line`),
# which writes its transcript.
#
# Harness check, first: the two harness additions on a stub the harness
# starts itself (`seed_unlabelled`, no agent-director and no CSCB process): in
# `transcript-on-first-message` no transcript exists at its dialog, nor after
# the human's Enter reports it in, nor for SLASH_HOLD_S after a typed slash
# command (`/exit`, as CSCB's `pause` types it) shows in the pane; one exists
# once a line has been typed (`stub_type_line`), and the typed sentinel ends
# it; `stub_type_line` aimed
# at a pane that does not exist fails with its FAIL line.
#
# Legs, in run order (one scenario HOME, store, tmux server and Slack stub):
# scenario 7's legs E and F, then scenario 12's legs G and H, then scenario
# 18's legs J and K.
#
# Scenario 7's legs (E, F); each:
#   1. the persona's first life: config.json with the persona, a start, its
#      row `waiting`; the harness reads the life's session id (`get`'s
#      `claude_session_id`);
#   2. the harness ends that life with the exit sentinel, so the row reads
#      `ended` and its session is gone; leg F also deletes the life's
#      transcript, the file the row's `jsonl_path` names (working default:
#      the harness deletes it under SCENARIO_ROOT, a filesystem step);
#   3. `transcript-on-first-message` selected for the persona's directory; a
#      plain `stop`, the leg's mark, and a start. CSCB's first spawn of the
#      persona collides with the finished row, its collision `get` reads it
#      `ended`, and:
#        E (`resume_enabled=false`): the reuse spawn, with no `resume`;
#        F: CSCB's `resume` meets ErrJsonlMissing, the lost-transcript
#        diagnosis runs, then the reuse spawn;
#   4. a background harness `get` of the row (a subshell of the scenario's
#      own shell), started before the start and stopped once the row reads
#      `waiting` (through a stop file it checks at the top of its loop, then
#      reaped, so its reads are whole before they are read), records each
#      read; checked: a read of `pending` with a
#      `launch_started_at`, then one of `waiting`, and no `waiting` before it;
#   5. checked after `waiting`:
#        - exactly one CSCB-parented `spawn` naming the persona's id with
#          `--reuse-finished` (agent-director shim's argv) after the mark;
#        - E: no CSCB `resume` of its id after the mark; F: at least one, and
#          exactly one diagnosis log line for F after the mark, its time no later
#          than the reuse spawn's call;
#        - a harness `get`: `prior_sessions` is an array that does not hold
#          the first life's session id;
#        - exactly one server.log line after the mark that is the launch's
#          `pre_trust` line for a reuse spawn with value `ok`, as the printer
#          renders it;
#        - no CSCB `delete` after the mark, and the row present;
#   6. working default (the SRD names no caller): the harness's own `resume`,
#      with no CSCB process able to act on the row: a plain `stop`, the
#      harness ends the unmessaged new life with the exit sentinel (the row
#      reads `ended`), then one `resume` of the persona's id through the
#      harness agent-director call (`ad_capture`), which must exit non-zero
#      answering ErrJsonlNeverWritten; the row is present afterwards.
#
# Scenario 12's legs (G, H), each with a background harness `get` of the row
# (a subshell of the scenario's own shell, every WATCH_PERIOD_S) from the
# row's first read until it reads `waiting` again, and the leg's mark before
# its start:
#   G (a `missing` row with no session id beside a leftover holding its name;
#     working default: the silent stub ended by its sentinel before G, then
#     the leftover seeded):
#     1. `silent` selected for G's directory; config.json with G, the mark
#        and a start: CSCB's plain spawn; the row reads `pending` with a
#        launch start and no `claude_session_id`;
#     2. before G has passed from the launch start (checked against
#        `adGraceMs.default`), the harness types the exit sentinel into G's
#        pane (the silent stub exits with no hook, and its session closes
#        with it), seeds a leftover (`seed_leftover`) named G's session name
#        whose `@ad_owner` names an earlier launch of G's id with the store's
#        own id (`ad_store_id`, `ad_owner_label`) and whose pane carries
#        `@ad_pane` (`ad_pane_label`), its worker the `silent` stub in G's
#        directory, and then selects `dev-channels` for G's directory;
#     3. CSCB's own pending-row runs mark the row `missing` past G; its
#        `resume` answers ErrNoSessionId and the reuse spawn follows, refused
#        while the leftover runs; the harness waits for at least two refused
#        reuse spawns (the first, and a retry at the latch re-check's or the
#        retry timer's cadence), with none in flight, then ends the leftover
#        by its session id (`end_session`);
#     4. the next reuse spawn succeeds and the row reads `waiting`;
#     5. checked: a background read of `missing`, with a CSCB-parented
#        `find-missing` after the mark no later than it, and no
#        `find-missing` from any other process after the mark; at least one
#        CSCB `resume` of G's id after the mark, and a server.log line
#        naming ErrNoSessionId on a `resume` of G no later than the first
#        CSCB reuse spawn of G's id; every CSCB-parented `spawn` of G's id
#        carrying `--reuse-finished` made before the harness began ending
#        the leftover (the time taken just before `end_session`) has its
#        refusal line before then, each UNAVAILABLE or CONFLICT (the class
#        `classifyAdError` gives the error name it names), at least two,
#        apart from at most one in flight across that time, whose outcome
#        is accepted either way; no reuse spawn succeeded before then;
#        exactly one succeeded after the mark; the row
#        reads `waiting` with a session id; no CSCB `delete` after the mark;
#        at least one background read answered and none ErrSpawnNotFound
#        (another failed read is logged);
#     6. a plain `stop`, and the harness ends G's new life with the exit
#        sentinel (the row reads `ended`).
#   H (an `ended` row with a stale `config_dir` label beside its remaining
#     session; working default: `remain-on-exit` and the symlink re-point):
#     1. config.json with H (its claude_config_dir the symlink), a start; the
#        row reads `waiting`; the harness reads its session id;
#     2. `set_remain_on_exit` on H's session, then the exit sentinel: the
#        stub fires SessionEnd and exits, the row reads `ended`, and the
#        session stays with its pane dead;
#     3. the symlink re-pointed (`repoint_symlink`), a plain `stop`, the mark
#        and a start: CSCB's collision `get` reads the row `ended` with a
#        `config_dir` label that is not the persona's, so it makes a reuse
#        spawn and no `resume` (SRJ-707's pre-resume guard), refused while
#        the session remains; the harness waits for at least two refused
#        reuse spawns, with none in flight, then ends the remaining session
#        by its session id (`end_session`);
#     4. the next reuse spawn succeeds and the row reads `waiting`;
#     5. checked: every CSCB-parented `spawn` of H's id after the mark
#        carries `--reuse-finished`, apart from the collision ladder's first
#        spawn of each attempt, which answers ErrInstanceIdCollision and
#        writes nothing (its collision line; SRJ-111, SRJ-114); the reuse
#        spawns made before the harness began ending the session each have
#        their refusal line, UNAVAILABLE or CONFLICT, as for G (one in
#        flight across that time accepted either way), and none succeeded
#        before then; exactly one succeeded after the mark; no CSCB
#        `resume` of H's id after the mark; the row reads `waiting` with a
#        session id other than the first life's; no CSCB `delete` after the
#        mark; at least one background read answered and none
#        ErrSpawnNotFound (another failed read is logged);
#     6. a plain `stop`, and the harness ends H's new life with the exit
#        sentinel.
#
# Scenario 18's legs (J, K), each with the tmux shim in `log`, so a
# teardown's kill succeeds. "Messaged" (each first life): the harness reads
# the life's session id and `cwd` (`get`), checks that no transcript is at
# the path agent-director's `resume` looks for that session under the
# persona's claude_config_dir, types a first message into the pane, and waits
# for the transcript there; the row's `jsonl_path` and `transcript_status`
# after it are logged.
#   J (removed and re-added):
#     1. config.json with J, a start; the row reads `waiting`; the human
#        messages it;
#     2. the removal mark; the operator removes J from config.json (no persona
#        left) and confirms the apply: no pending file before the edit, the
#        pending file renamed to the apply file, then the apply's
#        `reload-applied` line (one removed); J's session is gone, the
#        retired-key record gives J's key the cause `removed`, and J's row is
#        kept (its state logged);
#     3. a plain `stop` and a start (no persona);
#     4. the re-add mark; the operator adds J back, with the same key,
#        working directory and claude_config_dir, and confirms the apply (one
#        added); the row reads `waiting` with a session other than the old
#        one;
#     5. checked: the first CSCB-parented `spawn` naming J's id after the
#        re-add mark carries `--reuse-finished`; a harness `get` reads the row
#        `waiting` with a session other than the old one, and `prior_sessions`
#        is an array that does not hold the old session; from the removal
#        mark on, no CSCB `resume` of J's id and no CSCB `delete`;
#     6. a plain `stop`, and the harness ends J's new life with the exit
#        sentinel.
#   K (`credentials_file` changed):
#     1. config.json with K (its first credentials file), a start; the row
#        reads `waiting`; the human messages it;
#     2. the change mark; the operator points K's `credentials_file` at its
#        second file and confirms the apply (one destructively modified); the
#        row reads `waiting` with a session other than the old one; the
#        retired-key record's cause for K's key, when it still has an entry,
#        is `destructive-modify` (working default: by then the new life may
#        have begun and the entry been cleared, SRJ-806, SRJ-807; no entry is
#        logged);
#     3. checked, from the change mark on, as J's step 5;
#     4. a plain `stop`, and the harness ends K's new life with the exit
#        sentinel.
#
# Waits: rows reporting in at ROW_WAIT_S; start passes at START_WAIT_S; a
# row reading `ended` after the sentinel, and its session going, at
# ENDED_WAIT_S; the harness check's transcript at TRANSCRIPT_WAIT_S; in
# scenario 12, the first refused reuse spawn at FIRST_REFUSAL_WAIT_S (G
# past the launch start, then the retry timer's next run), a second at
# REFUSAL_WAIT_S (the latch re-check's 120 s, or the retry timer's wait of
# at most 300 s), and the reuse after the session is ended at
# REUSE_WAIT_S; in scenario 18, the pending file after an edit at
# RELOAD_WAIT_S and the apply's line at APPLY_WAIT_S. The
# pending window is read by the background `get` (POLL_PERIOD_S between
# reads), with no delay added to the stub: the window lasts from the reuse
# spawn's reset of the row until the approver's Enter reaches the stub and
# its SessionStart is applied.
#
# Matched values (every one printed by fixtures/fmk-texts.ts from the
# installed package, never typed here): instance ids and session names
# (`personaInstanceId`, `personaTmuxSessionName`, src/persona-identity.ts);
# the `pre_trust` line (`preTrustLogLine` with LAUNCH_VERB_REUSE_SPAWN,
# src/session-manager.ts, b.jg5 SRJ-413); the diagnosis's fixed fragment
# (JSONL_DIAGNOSIS_REUSE_WORDING) and its startup-errors classes
# (JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS, JSONL_TRANSCRIPT_LOST_ENTRY_CLASS,
# src/session-manager.ts); the error names ErrJsonlNeverWritten and
# ErrJsonlMissing, and ErrNoSessionId, ErrSpawnNotFound and
# ErrInstanceIdCollision (`adErrorName`,
# src/agent-director-errors.ts); the class labels UNAVAILABLE and CONFLICT
# (`adErrorClass`, src/ad-error-class.ts) and the class of each refusal's
# error name (`classifyAdError`, a printer entry of scenario 12); G
# at agent-director's default settings (`adGraceMs.default`,
# src/ad-settings.ts); the last-applied record's suffix
# (LAST_APPLIED_FILE_SUFFIX, src/reload.ts); in scenario 18, the pending and
# apply files' suffixes (PENDING_FILE_SUFFIX, APPLY_FILE_SUFFIX,
# src/reload.ts), the apply's line (`reloadAppliedLogLine`,
# src/reload-apply.ts renderAppliedLogLine), the retired-key record's path
# and causes (`retiredKeysPath`, RETIRED_KEY_CAUSE_REMOVED,
# RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, src/retired-keys.ts; its `keys` and
# `cause` fields are the record format's, SRJ-802, which exports no field
# name).
# Quoted, with no exported builder: the diagnosis's log line head
# `[slack] ErrJsonlMissing diagnostic: ` (src/session-manager.ts
# diagnoseJsonlMissing, reportInconclusiveDiagnosis); the reuse spawn's
# refusal line head `[slack] reuseSpawnForPersona: reuse spawn refused for `
# and success line head `[slack] reuseSpawnForPersona: reuse-spawned `
# (src/session-manager.ts logRefusal, logConflict and reuseSpawnForPersona,
# with REUSE_SPAWN_SITE and REUSE_SPAWN_WHAT); the collision ladder's line
# `[slack] spawnForPersona: <ErrInstanceIdCollision> for <ref> — fetching
# current state` (src/session-manager.ts runPersonaLadder); the
# no-transcript line's
# words ` resume ` and `nothing is deleted` (src/session-manager.ts, the
# `noTranscript` rows of resumeOrFreshSpawn, the live-row sequence and the
# latch re-check).
#
# Outcomes the SRD leaves open are logged as `NOTE:` lines, not asserted:
# each leg's CSCB calls of its id by verb, the new life's session id and
# `transcript_status`, the diagnosis's verdict (its startup-errors entries),
# and the pending reads' launch starts; in scenario 12, each refusal's error
# name and description, the background reads' states in order, the posts at
# the persona's channel, the `pre_trust` value of the reuse, and
# agent-director's trail records naming G's id, by event; in scenario 18, the
# messaged row's `jsonl_path` and `transcript_status`, the persona's CSCB
# spawns after the mark (how many carry `--reuse-finished`), its CSCB calls
# by verb, the row's state after the removal, the new life's
# `transcript_status` and `prior_sessions`, and a destructive modify's
# retired-key entry already cleared.
#
# The script ends with the closing assertions, `assert_no_server_tmux`,
# `assert_no_cscb_include_finished` and `assert_no_cscb_delete` (b.jg5
# SRJ-1418), in its own shell; their counts read only the shims' lines whose
# parent is a CSCB process. Later legs of test-19 go before them.
set -euo pipefail

TEST_NAME="test-19-fmk-reuse"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# ---------------------------------------------------------------------------
# Values from the installed package (fixtures/fmk-texts.ts)
# ---------------------------------------------------------------------------

T19_PRINTER="${SCENARIO_FIXTURES}/fmk-texts.ts"

# t19_value <var> <entry> [<arg>...]: set <var> to the printer's value; fail
# naming the entry when the printer fails.
t19_value() {
    local -n t19_value_out="$1"
    shift
    t19_value_out="$(bun "${T19_PRINTER}" "$@")" || fail "the value printer failed for $*"
}

t19_value NEVER_WRITTEN adErrorName ErrJsonlNeverWritten
t19_value JSONL_MISSING adErrorName ErrJsonlMissing
t19_value REUSE_WORDING JSONL_DIAGNOSIS_REUSE_WORDING
t19_value INCONCLUSIVE_CLASS JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS
t19_value LOST_CLASS JSONL_TRANSCRIPT_LOST_ENTRY_CLASS
t19_value LAST_APPLIED_SUFFIX LAST_APPLIED_FILE_SUFFIX

# The lost-transcript diagnosis's log line head (src/session-manager.ts
# diagnoseJsonlMissing and reportInconclusiveDiagnosis, which have no
# exported builder): `[slack] ErrJsonlMissing diagnostic: <ref> instance=<id>`.
DIAGNOSIS_HEAD='[slack] ErrJsonlMissing diagnostic: '

# Scenario 12's values.
t19_value NO_SESSION_ID adErrorName ErrNoSessionId
t19_value NOT_FOUND adErrorName ErrSpawnNotFound
t19_value INSTANCE_ID_COLLISION adErrorName ErrInstanceIdCollision
t19_value CLASS_UNAVAILABLE adErrorClass AD_ERROR_CLASS_UNAVAILABLE
t19_value CLASS_CONFLICT adErrorClass AD_ERROR_CLASS_CONFLICT
t19_value T19_GRACE_MS adGraceMs.default
[[ "${T19_GRACE_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: adGraceMs.default printed '${T19_GRACE_MS}', not a whole number of milliseconds"
GRACE_S="$(awk -v ms="${T19_GRACE_MS}" 'BEGIN { printf "%.3f", ms / 1000 }')"

# Scenario 18's values.
t19_value CAUSE_REMOVED RETIRED_KEY_CAUSE_REMOVED
t19_value CAUSE_DESTRUCTIVE RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY
t19_value PENDING_SUFFIX PENDING_FILE_SUFFIX
t19_value APPLY_SUFFIX APPLY_FILE_SUFFIX

# The reuse spawn's refusal line head and success line head
# (src/session-manager.ts: logRefusal for an UNAVAILABLE refusal and
# logConflict for a CONFLICT, and reuseSpawnForPersona's success line, each
# with REUSE_SPAWN_SITE and REUSE_SPAWN_WHAT; no exported builder):
#   `[slack] reuseSpawnForPersona: reuse spawn refused for <ref>: <error name> …`
#   `[slack] reuseSpawnForPersona: reuse-spawned <ref> instanceId=<id> — …`
REUSE_REFUSED_HEAD='[slack] reuseSpawnForPersona: reuse spawn refused for '
REUSE_SPAWNED_HEAD='[slack] reuseSpawnForPersona: reuse-spawned '
# The words every no-transcript line holds after the error's description
# (src/session-manager.ts, the `noTranscript` rows of resumeOrFreshSpawn,
# the live-row sequence and the latch re-check; no exported builder):
#   `<error name> … on resume for <ref> — … nothing is deleted …`, or
#   `… on the re-check's resume of <ref> — … nothing is deleted …`.
NO_TRANSCRIPT_RESUME_WORD=' resume '
NO_TRANSCRIPT_NOTHING_DELETED='nothing is deleted'
# The collision ladder's line after its first spawn collided
# (src/session-manager.ts runPersonaLadder; no exported builder):
#   `[slack] spawnForPersona: ErrInstanceIdCollision for <ref> — fetching current state`.
LADDER_COLLISION_HEAD='[slack] spawnForPersona: '
LADDER_COLLISION_FOR=' for '
LADDER_COLLISION_TAIL=' — fetching current state'

# ---------------------------------------------------------------------------
# Bounds (seconds)
# ---------------------------------------------------------------------------

# A live start's start pass completing.
START_WAIT_S=120
# A launched persona's row reporting in (`waiting`).
ROW_WAIT_S=120
# The Slack stub writing its ready file.
STUB_WAIT_S=30
# A row reading `ended`, and its session gone, after the exit sentinel.
ENDED_WAIT_S=30
# The harness check's transcript appearing after the typed line, and its
# stub's report-in banner.
TRANSCRIPT_WAIT_S=15
# The harness check's hold after a typed slash command, in which no
# transcript may be written (the stub reads a line at once).
SLASH_HOLD_S=2
# The background `get`'s pause between reads.
POLL_PERIOD_S=0.05
# Scenario 12: the first refused reuse spawn, from the launch: G (60 s at
# agent-director's default settings) past the launch start, then the retry
# timer's next run and the restart path's decision.
FIRST_REFUSAL_WAIT_S=420
# A further refused reuse spawn: the latch re-check's interval (120 s) after
# a CONFLICT, or the retry timer's next wait (at most 300 s) after an
# UNAVAILABLE refusal, with room for a loaded host.
REFUSAL_WAIT_S=480
# The reuse spawn that succeeds once the session is ended: the same
# cadences.
REUSE_WAIT_S=480
# The scenario 12 background `get`'s pause between reads.
WATCH_PERIOD_S=1
# A background `get` ending at its stop file: the read in progress (a
# harness `get`) and its pause.
BG_STOP_WAIT_S=30
# Scenario 18: a reload's preview reaching the pending file after a
# config.json edit (the reload tick runs 5 s after the previous pass).
RELOAD_WAIT_S=60
# Scenario 18: a confirmed apply logging its line once all its steps ran (a
# teardown's kill, and a bring-up's launch through to its answer).
APPLY_WAIT_S=300

# ---------------------------------------------------------------------------
# Personas: each with its own key, credentials, channel and directories
# ---------------------------------------------------------------------------

CREDS_DIR="${SCENARIO_ROOT}/credentials"
CFG_ROOT="${SCENARIO_ROOT}/claude-config"
mkdir -m 700 "${CREDS_DIR}"
mkdir -p "${CFG_ROOT}"

# t19_persona <prefix> <short> <channel>: set <prefix>_NAME, _LABEL, _CREDS,
# _CHANNEL, _WORK, _CFG, _KEY, _ID and _SESSION for one persona, write its
# credentials file and its Claude config's `.claude.json`, and select
# `dev-channels` for its working directory.
t19_persona() {
    local p="$1" short="$2" channel="$3" key value work cfg
    printf -v "${p}_NAME" '%s' "${SCENARIO_TAG}${short}"
    printf -v "${p}_LABEL" '%s' "${SCENARIO_TAG}${short}1"
    printf -v "${p}_CREDS" '%s' "${CREDS_DIR}/${SCENARIO_TAG}${short}1.json"
    printf -v "${p}_CHANNEL" '%s' "${channel}"
    work="$(make_workdir "${SCENARIO_TAG}${short}_work")"
    printf -v "${p}_WORK" '%s' "${work}"
    cfg="${CFG_ROOT}/${SCENARIO_TAG}${short}_cfg"
    printf -v "${p}_CFG" '%s' "${cfg}"
    mkdir -p "${cfg}"
    printf '{}\n' | write_file "${cfg}/.claude.json" 600
    key="$(persona_key "${SCENARIO_TAG}${short}")"
    printf -v "${p}_KEY" '%s' "${key}"
    t19_value value personaInstanceId "${key}"
    printf -v "${p}_ID" '%s' "${value}"
    t19_value value personaTmuxSessionName "${key}"
    printf -v "${p}_SESSION" '%s' "${value}"
    stub_mode "${work}" "${STUB_MODE_DEV_CHANNELS}"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' \
        "$(fake_token bot "${SCENARIO_TAG}${short}1")" "$(fake_token app "${SCENARIO_TAG}${short}1")" \
        | write_file "${CREDS_DIR}/${SCENARIO_TAG}${short}1.json" 600
}

t19_persona E reusee C0T19RSE1
t19_persona F reusef C0T19RSF1
t19_persona G reuseg C0T19RSG1
t19_persona H reuseh C0T19RSH1
t19_persona J reusej C0T19RSJ1
t19_persona K reusek C0T19RSK1
ALL_PERSONAS=(E F G H J K)

# H's claude_config_dir: a symlink under SCENARIO_ROOT to its first directory
# (t19_persona's, holding `.claude.json`), re-pointed in leg H to a second
# one, which holds its own `.claude.json`.
H_CFG_ONE="${H_CFG}"
H_CFG_TWO="${CFG_ROOT}/${SCENARIO_TAG}reuseh_cfg_two"
H_CFG_LINK="${CFG_ROOT}/${SCENARIO_TAG}reuseh_cfg_link"
mkdir -p "${H_CFG_TWO}"
printf '{}\n' | write_file "${H_CFG_TWO}/.claude.json" 600
ln -s -- "${H_CFG_ONE}" "${H_CFG_LINK}" || fail "setup: could not link ${H_CFG_LINK} to ${H_CFG_ONE}"
H_CFG="${H_CFG_LINK}"

# J's and K's claude_config_dir: the scenario HOME's `.claude`, the directory
# the stub writes every transcript under (fixtures/stub-claude.sh), so a
# messaged life's transcript is where agent-director's `resume` looks for its
# session, `<CLAUDE_CONFIG_DIR>/projects/<slug of the row's cwd>/<session
# id>.jsonl`, the path it tries when the row records no `jsonl_path` (working
# default: in `transcript-on-first-message` the life's SessionStart found no
# transcript, so agent-director recorded none). It holds a `.claude.json`
# (`{}`), as every persona's directory does.
T19_HOME_CFG="${HOME}/.claude"
mkdir -p "${T19_HOME_CFG}"
if [[ ! -e "${T19_HOME_CFG}/.claude.json" ]]; then
    printf '{}\n' | write_file "${T19_HOME_CFG}/.claude.json" 600
fi
J_CFG="${T19_HOME_CFG}"
K_CFG="${T19_HOME_CFG}"

# K's second credentials file: its own fake token pair under its own label,
# which the Slack stub answers ok as it does every persona's.
K_LABEL_TWO="${SCENARIO_TAG}reusek2"
K_CREDS_ONE="${K_CREDS}"
K_CREDS_TWO="${CREDS_DIR}/${K_LABEL_TWO}.json"
printf '{"bot_token": "%s", "app_token": "%s"}\n' \
    "$(fake_token bot "${K_LABEL_TWO}")" "$(fake_token app "${K_LABEL_TWO}")" \
    | write_file "${K_CREDS_TWO}" 600

# t19_persona_json <prefix>: one persona entry: its credentials file, working
# directory, claude_config_dir and one channel, which also takes its
# permission prompts (its destination).
t19_persona_json() {
    local n="$1_NAME" cr="$1_CREDS" w="$1_WORK" c="$1_CFG" ch="$1_CHANNEL"
    printf '{"name": "%s", "credentials_file": "%s", "working_directory": "%s", "claude_config_dir": "%s", "channels": [{"id": "%s", "delivery": "all"}], "permission_prompts": "%s"}' \
        "${!n}" "${!cr}" "${!w}" "${!c}" "${!ch}" "${!ch}"
}

T19_RECORD_ASIDE=0

# t19_config <resume-enabled> [<prefix>...]: the operator's edit of
# config.json: it holds these personas (none with no prefix;
# `health_check_interval` 0, `session_restart_delay` 0, `resume_enabled` as
# given). On a running server the next reload tick previews it.
t19_config() {
    local resume="$1" joined="" p
    shift
    for p in "$@"; do
        joined+="${joined:+, }$(t19_persona_json "${p}")"
    done
    write_config << EOF
{
  "personas": [${joined}],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "session_restart_delay": 0,
  "resume_enabled": ${resume}
}
EOF
}

# t19_config_for_next_start <resume-enabled> <prefix>...: the operator's edit
# while the server is stopped: config.json as `t19_config` writes it, and the
# last-applied record moved aside, so the next start applies config.json as
# it stands.
t19_config_for_next_start() {
    local record
    t19_config "$@"
    record="${SLACK_STATE_DIR}/config.json${LAST_APPLIED_SUFFIX}"
    if [[ -e "${record}" ]]; then
        T19_RECORD_ASIDE=$(( T19_RECORD_ASIDE + 1 ))
        mv -- "${record}" "${record}.aside-${T19_RECORD_ASIDE}" || fail "could not move ${record} aside"
    fi
}

# ---------------------------------------------------------------------------
# The Slack stub (one for the script)
# ---------------------------------------------------------------------------

STUB_DIR="${SCENARIO_ROOT}/slack-stub"
STUB_RECORD="${STUB_DIR}/record.jsonl"
mkdir "${STUB_DIR}"
t19_labels=()
for t19_p in "${ALL_PERSONAS[@]}"; do
    t19_label_var="${t19_p}_LABEL"
    t19_labels+=("${!t19_label_var}")
done
t19_labels+=("${K_LABEL_TWO}")
python3 - "${t19_labels[@]}" << 'EOF' | write_file "${STUB_DIR}/control.json"
import json, sys
print(json.dumps({
    "tokens": [{"suffix": s, "label": s, "auth": "ok", "connections": "ok"} for s in sys.argv[1:]],
    "default": {"auth": "invalid_auth", "connections": "invalid_auth"},
}))
EOF
(cd "${STUB_DIR}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${STUB_RECORD}" \
    --control "${STUB_DIR}/control.json" --ready-file "${STUB_DIR}/ready.json") > "${STUB_DIR}/stub.out" 2>&1 &
SLACK_STUB_PID=$!
track_pid "${SLACK_STUB_PID}"
wait_for_file "${STUB_DIR}/ready.json" "${STUB_WAIT_S}" "setup: the Slack stub never wrote its ready file"
CSCB_SLACK_API_URL="$(jq -r '.api_url' "${STUB_DIR}/ready.json")"
[[ "${CSCB_SLACK_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] \
    || fail "setup: the Slack stub's api_url '${CSCB_SLACK_API_URL}' is not loopback"
export CSCB_SLACK_API_URL

# ---------------------------------------------------------------------------
# Reading the rows, the logs and CSCB's calls
# ---------------------------------------------------------------------------

# t19_row_state <id>: print the row's state (a harness `status`), or nothing
# when the read fails.
t19_row_state() {
    ad_capture status --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || return 0
    jq -r '.state // empty' "${AD_OUT}" 2> /dev/null || true
}

t19_row_is() {
    [[ "$(t19_row_state "$1")" == "$2" ]]
}

# t19_row_get <id> <step>: a harness `get` of the row (AD_OUT holds it); fail
# when it fails.
t19_row_get() {
    ad_capture get --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || fail "$2: harness get of $1 exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
}

# t19_lines <file>: how many lines <file> has (0 when missing).
t19_lines() {
    if [[ -f "$1" ]]; then
        wc -l < "$1" | tr -d ' '
    else
        echo 0
    fi
}

# t19_after <file> <line>: <file>'s lines after line <line>.
t19_after() {
    [[ -f "$1" ]] || return 0
    tail -n "+$(( $2 + 1 ))" "$1"
}

# t19_count_after <file> <line> <matcher>: lines after <line> that match.
t19_count_after() {
    local tmp="${SCENARIO_ROOT}/count-after.tmp"
    t19_after "$1" "$2" > "${tmp}"
    count_in "${tmp}" "$3"
}

# t19_log_after <matcher>: server.log's lines after the mark that match.
t19_log_after() {
    local tmp="${SCENARIO_ROOT}/log-after.tmp"
    t19_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" > "${tmp}"
    LC_ALL=C awk -v sep="${SCENARIO_SEP}" -v m="$1" '
        BEGIN { n = split(m, frags, sep) }
        {
            rest = $0
            for (i = 1; i <= n; i++) {
                if (frags[i] == "") continue
                p = index(rest, frags[i])
                if (p == 0) next
                rest = substr(rest, p + length(frags[i]))
            }
            print
        }' "${tmp}"
}

# t19_line_time <line>: the time a server.log line carries (its leading
# `[<ISO>] `, src/logging.ts), in seconds since the epoch.
t19_line_time() {
    local iso="${1#\[}"
    iso="${iso%%\]*}"
    date -u -d "${iso}" +%s.%3N || fail "could not read the time '${iso}'"
}

# t19_mark: the leg's mark: the time, and the lines server.log and
# startup-errors.log hold.
t19_mark() {
    MARK_TIME="${EPOCHREALTIME/,/.}"
    MARK_LOG="$(t19_lines "${SLACK_STATE_DIR}/server.log")"
    MARK_ERRORS="$(t19_lines "${SLACK_STATE_DIR}/startup-errors.log")"
}

# t19_cscb_calls_since <time> <verb> [<fragment>...]: CSCB's agent-director
# calls of <verb> holding every fragment, made at or after <time>.
t19_cscb_calls_since() {
    local since="$1" out
    shift
    out="$(cscb_ad_calls "$@")" || exit 1
    [[ -n "${out}" ]] || return 0
    awk -F'\t' -v t="${since}" '$2 + 0 >= t + 0' <<< "${out}"
}

# t19_cscb_count_since <time> <verb> [<fragment>...]
t19_cscb_count_since() {
    local out
    out="$(t19_cscb_calls_since "$@")" || exit 1
    if [[ -z "${out}" ]]; then
        echo 0
    else
        wc -l <<< "${out}" | tr -d ' '
    fi
}

# t19_reuse_spawns_since <time> <id>: CSCB's `spawn` calls naming <id> with
# `--reuse-finished` at or after <time>.
t19_reuse_spawns_since() {
    local out
    out="$(t19_cscb_calls_since "$1" spawn "$2")" || exit 1
    [[ -n "${out}" ]] || return 0
    grep -F -- '--reuse-finished' <<< "${out}" || true
}

# t19_note_calls <time> <id> <step>: log how many CSCB calls of each verb
# named <id> at or after <time>.
t19_note_calls() {
    local out summary
    out="$(t19_cscb_calls_since "$1" "" "$2")" || exit 1
    summary="$(awk -F'\t' '
        {
            n = split($6, w, " ")
            for (i = 1; i <= n; i++) {
                if (w[i] == "--store-path" || w[i] == "--home" || w[i] == "--tmux-command") { i++; continue }
                c[w[i]]++
                break
            }
        }
        END { for (v in c) printf "%s=%d\n", v, c[v] }' <<< "${out}" | sort | tr '\n' ' ')"
    echo "${TEST_NAME}: NOTE: ${3}: CSCB calls naming $2 after the mark: ${summary:-none}"
}

# t19_start_and_wait <persona-count>: a live start, and its start pass
# completing (its own completion line: server.log is appended across starts).
t19_start_and_wait() {
    local m before
    m="$(completion_match "$1")" || exit 1
    before="$(count_log "${m}")"
    start_server --live
    wait_for_count "${m}" "$(( before + 1 ))" "${START_WAIT_S}" "the start pass never completed"
}

# t19_has_session <session>: true when the scenario's tmux server holds it.
t19_has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

t19_no_session() {
    ! t19_has_session "$1"
}

# t19_end_life <prefix> <step>: the human ends the persona's live life by
# typing the stub's exit sentinel into its pane; the row reads `ended` and the
# session is gone.
t19_end_life() {
    local p="$1" step="$2" id_var="$1_ID" session_var="$1_SESSION"
    stub_type_line "${!session_var}" "${STUB_EXIT_SENTINEL}"
    wait_until "${ENDED_WAIT_S}" "${step}: ${!id_var} does not read ended after the exit sentinel" t19_row_is "${!id_var}" ended
    wait_until "${ENDED_WAIT_S}" "${step}: ${!session_var} is still there after the exit sentinel" t19_no_session "${!session_var}"
}

# ---------------------------------------------------------------------------
# The background harness `get` (the pending window)
# ---------------------------------------------------------------------------

# t19_bg_stop <pid> <stop-file> <step>: stop a background reader
# (`t19_poller_start`, `t19_watch_start`): create its stop file, which it
# checks at the top of its loop, wait for it to end (bounded at
# BG_STOP_WAIT_S), then reap it (`wait`), so the reads it appended are whole
# before its file is read. It is never signalled, so no read is cut short.
t19_bg_stop() {
    local pid="$1" stop="$2" step="$3"
    : > "${stop}" || fail "${step}: could not create the stop file ${stop}"
    wait_until "${BG_STOP_WAIT_S}" "${step}: the background reader ${pid} did not stop at its stop file" t19_pid_gone "${pid}"
    # Gone (a zombie until reaped): drop it from the tracked PIDs, then reap it.
    stop_tracked_pid "${pid}" 1 "${step}"
    wait "${pid}" 2> /dev/null || true
}

t19_pid_gone() {
    ! pid_alive "$1"
}

# t19_poller_start <id> <file>: from now on, a subshell of the scenario's own
# shell (`track_pid`) reads the row with the harness `get`, every
# POLL_PERIOD_S, and appends one JSON line per answered read to <file>:
# {t, state, launch_started_at, claude_session_id}. It ends at the top of its
# loop once <file>.stop exists (`t19_bg_stop`).
t19_poller_start() {
    local id="$1" file="$2"
    : > "${file}"
    rm -f -- "${file}.stop"
    (
        set +e
        tmp="${file}.read"
        while :; do
            [[ -e "${file}.stop" ]] && exit 0
            if ad get --claude-instance-id "${id}" > "${tmp}" 2> /dev/null; then
                jq -c --arg t "${EPOCHREALTIME/,/.}" \
                    '{t: $t, state: .state, launch_started_at: (.launch_started_at // ""), claude_session_id: (.claude_session_id // "")}' \
                    "${tmp}" >> "${file}" 2> /dev/null
            fi
            sleep "${POLL_PERIOD_S}"
        done
    ) &
    T19_POLLER_PID=$!
    track_pid "${T19_POLLER_PID}"
}

# t19_poll_has_waiting <file>: true when a read in <file> is `waiting`.
t19_poll_has_waiting() {
    jq -e -s 'any(.[]; .state == "waiting")' "$1" > /dev/null 2>&1
}

# t19_check_pending_then_waiting <file> <id> <step>: the reads hold one of
# `pending` with a launch start, then one of `waiting`, and no `waiting`
# before that `pending`.
t19_check_pending_then_waiting() {
    local file="$1" id="$2" step="$3" verdict launches
    verdict="$(jq -r -s '
        (map(.state == "pending" and .launch_started_at != "") | index(true)) as $p
        | if $p == null then "no-pending"
          else ((.[$p:] | map(.state == "waiting") | index(true)) as $w
                | if $w == null then "no-waiting-after"
                  elif (.[:$p] | any(.state == "waiting")) then "waiting-before"
                  else "ok \(.[$p].t) \(.[$p].launch_started_at) \(.[$p + $w].t)" end)
          end' "${file}")" || fail "${step}: could not read the background get's reads of ${id}"
    case "${verdict}" in
        ok\ *)
            read -r _ T19_PENDING_T T19_LAUNCH_START T19_WAITING_T <<< "${verdict}"
            echo "${TEST_NAME}: ${step}: the harness get read ${id} pending at ${T19_PENDING_T} (launch start ${T19_LAUNCH_START}), then waiting at ${T19_WAITING_T}"
            ;;
        *)
            jq -c . "${file}" | sed 's/^/  | /' >&2 || true
            case "${verdict}" in
                no-pending) fail "${step}: the harness get never read ${id} pending with a launch start ($(t19_lines "${file}") reads, ${POLL_PERIOD_S} s apart): the pending window was too short to read" ;;
                no-waiting-after) fail "${step}: the harness get read ${id} pending with a launch start but never waiting after it" ;;
                waiting-before) fail "${step}: the harness get read ${id} waiting before the pending launch" ;;
                *) fail "${step}: the background get's reads of ${id} gave '${verdict}'" ;;
            esac
            ;;
    esac
    launches="$(jq -r -s '[.[] | select(.state == "pending") | .launch_started_at] | "\(length) read(s), launch start(s): \(unique | join(" "))"' "${file}")"
    echo "${TEST_NAME}: NOTE: ${step}: the pending reads of ${id}: ${launches}"
}

# ---------------------------------------------------------------------------
# Harness check: the transcript-on-first-message mode and stub_type_line
# (harness additions)
# ---------------------------------------------------------------------------

# t19_transcripts: how many transcript files the scenario HOME's Claude
# project directories hold.
t19_transcripts() {
    if [[ -d "${HOME}/.claude/projects" ]]; then
        find "${HOME}/.claude/projects" -type f -name '*.jsonl' | wc -l | tr -d ' '
    else
        echo 0
    fi
}

t19_transcripts_are() {
    [[ "$(t19_transcripts)" == "$1" ]]
}

# t19_pane_shows <pane> <text>: true when the pane's visible text holds <text>
# (the harness reading its own stub's pane).
t19_pane_shows() {
    "${SCENARIO_REAL_TMUX}" capture-pane -p -t "$1" 2> /dev/null | grep -qF -- "$2"
}

# t19_transcripts_hold <count> <hold-s> <step>: for <hold-s> seconds the
# transcripts stay <count>.
t19_transcripts_hold() {
    local deadline=$(( SECONDS + $2 ))
    while :; do
        [[ "$(t19_transcripts)" == "$1" ]] || fail "$3: $(t19_transcripts) transcript(s), not $1"
        (( SECONDS < deadline )) || return 0
        sleep 0.2
    done
}

t19_harness_check() {
    local step="harness check" dir pane before out
    dir="$(make_workdir "${SCENARIO_TAG}selfcheck_work")"
    stub_mode "${dir}" "${STUB_MODE_TRANSCRIPT_ON_FIRST_MESSAGE}"
    before="$(t19_transcripts)"
    seed_unlabelled -c "${dir}" "${SCENARIO_TAG}_selfcheck" "${SCENARIO_BIN}/claude" > /dev/null
    pane="${SEEDED_PANE_ID}"
    # The stub's own texts (fixtures/stub-claude.sh): its dialog's first line,
    # and the banner it prints on reporting in.
    wait_until "${TRANSCRIPT_WAIT_S}" "${step}: the stub never showed its dialog" t19_pane_shows "${pane}" 'WARNING: Loading development channels'
    [[ "$(t19_transcripts)" == "${before}" ]] || fail "${step}: a transcript was written at the dialog"
    stub_press_enter "${pane}"
    wait_until "${TRANSCRIPT_WAIT_S}" "${step}: the stub never reported in after Enter" t19_pane_shows "${pane}" 'Listening for channel messages from:'
    [[ "$(t19_transcripts)" == "${before}" ]] || fail "${step}: a transcript was written at report-in"
    # A slash command typed into the pane (CSCB's `pause` types `/exit`) is no
    # message: once the pane shows it, no transcript follows for the hold.
    stub_type_line "${pane}" "/exit"
    wait_until "${TRANSCRIPT_WAIT_S}" "${step}: the pane never showed the typed /exit" t19_pane_shows "${pane}" "/exit"
    t19_transcripts_hold "${before}" "${SLASH_HOLD_S}" "${step}: after a typed /exit"
    stub_type_line "${pane}" "a first message"
    wait_until "${TRANSCRIPT_WAIT_S}" "${step}: no transcript after a typed line" t19_transcripts_are "$(( before + 1 ))"
    stub_type_line "${pane}" "${STUB_EXIT_SENTINEL}"
    wait_until "${TRANSCRIPT_WAIT_S}" "${step}: the stub's session is still there after the typed sentinel" t19_no_session "${SCENARIO_TAG}_selfcheck"
    # A refusal through `fail`: a pane that does not exist.
    out="${SCENARIO_ROOT}/type-line-refused.out"
    if (stub_type_line '%999999' "a line") > "${out}" 2>&1; then
        fail "${step}: stub_type_line did not fail for a pane that does not exist"
    fi
    grep -q "^FAIL: ${TEST_NAME}: stub_type_line %999999: tmux send-keys of the line exited" "${out}" \
        || { sed 's/^/  | /' "${out}" >&2; fail "${step}: stub_type_line's refusal of a pane that does not exist is not its FAIL line"; }
    echo "${TEST_NAME}: ${step}: transcript-on-first-message wrote no transcript until a line was typed, and stub_type_line typed it"
}

# ---------------------------------------------------------------------------
# The legs (b.jg5 SRJ-1409)
# ---------------------------------------------------------------------------

# t19_leg <prefix> <step> <resume-enabled> <disabled|missing>
t19_leg() {
    local p="$1" step="$2" resume="$3" kind="$4"
    local id_var="$1_ID" name_var="$1_NAME" work_var="$1_WORK" session_var="$1_SESSION"
    local id="${!id_var}" name="${!name_var}" old_sid jsonl real_root real_jsonl poll n reuse reuse_t
    local ref m diag diag_t line rc

    # 1. The first life.
    t19_config_for_next_start "${resume}" "${p}"
    t19_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${id}'s first life never reported in (waiting)" t19_row_is "${id}" waiting
    t19_row_get "${id}" "${step}: the first life"
    old_sid="$(jq -r '.claude_session_id // empty' "${AD_OUT}")"
    [[ -n "${old_sid}" ]] || fail "${step}: ${id}'s first life has no claude_session_id"
    jsonl="$(jq -r '.jsonl_path // empty' "${AD_OUT}")"
    echo "${TEST_NAME}: ${step}: ${id}'s first life: session ${old_sid}, transcript ${jsonl:-none}"

    # 2. The human ends it; leg F also deletes its transcript.
    t19_end_life "${p}" "${step}: the first life"
    if [[ "${kind}" == missing ]]; then
        [[ -n "${jsonl}" ]] || fail "${step}: ${id}'s first life recorded no jsonl_path"
        [[ -f "${jsonl}" ]] || fail "${step}: ${id}'s transcript ${jsonl} is not a file"
        real_root="$(realpath -e -- "${SCENARIO_ROOT}")" || fail "${step}: cannot resolve SCENARIO_ROOT"
        real_jsonl="$(realpath -e -- "${jsonl}")" || fail "${step}: cannot resolve ${jsonl}"
        [[ "${real_jsonl}" == "${real_root}"/* ]] \
            || fail "${step}: refused: the transcript ${real_jsonl} is not under SCENARIO_ROOT ${real_root}"
        rm -f -- "${real_jsonl}"
        [[ ! -e "${real_jsonl}" ]] || fail "${step}: ${real_jsonl} is still there after its removal"
        echo "${TEST_NAME}: ${step}: the harness deleted ${id}'s transcript ${real_jsonl}"
    fi

    # 3. The new life's mode, a plain stop, the mark and a start, with the
    #    background get reading from before it.
    stub_mode "${!work_var}" "${STUB_MODE_TRANSCRIPT_ON_FIRST_MESSAGE}"
    stop_server
    t19_mark
    poll="${SCENARIO_ROOT}/poll-${p}.jsonl"
    t19_poller_start "${id}" "${poll}"
    t19_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${id}'s new life never reported in (waiting)" t19_row_is "${id}" waiting
    wait_until 10 "${step}: the background get never read ${id} waiting" t19_poll_has_waiting "${poll}"
    t19_bg_stop "${T19_POLLER_PID}" "${poll}.stop" "${step}: stop the background get"

    # 4. pending with a launch start, then waiting.
    t19_check_pending_then_waiting "${poll}" "${id}" "${step}"

    # 5. The reuse spawn, the resume (or none), the diagnosis.
    reuse="$(t19_reuse_spawns_since "${MARK_TIME}" "${id}")" || exit 1
    n="$(grep -c . <<< "${reuse}" || true)"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} CSCB-parented spawn(s) of ${id} carrying --reuse-finished after the mark, not 1"
    reuse_t="$(awk -F'\t' '{ print $2 }' <<< "${reuse}")"
    echo "${TEST_NAME}: ${step}: CSCB's reuse spawn of ${id} at ${reuse_t}"
    n="$(t19_cscb_count_since "${MARK_TIME}" resume "${id}")"
    ref="$(persona_ref "${name}")" || exit 1
    if [[ "${kind}" == disabled ]]; then
        [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB resume call(s) of ${id} after the mark with resume_enabled false"
    else
        (( n >= 1 )) || fail "${step}: no CSCB resume of ${id} after the mark (its ErrJsonlMissing comes from one)"
        m="$(matcher "${DIAGNOSIS_HEAD}${ref} instance=${id}" "${REUSE_WORDING}")"
        diag="$(t19_log_after "${m}")"
        n="$(grep -c . <<< "${diag}" || true)"
        if [[ "${n}" != 1 ]]; then
            t19_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" | sed 's/^/  | /' >&2
            fail "${step}: ${n} lost-transcript diagnosis line(s) for ${id} after the mark, not 1 ($(matcher_text "${m}"))"
        fi
        diag_t="$(t19_line_time "${diag}")"
        awk -v a="${diag_t}" -v b="${reuse_t}" 'BEGIN { exit !(a + 0 <= b + 0) }' \
            || fail "${step}: the lost-transcript diagnosis for ${id} (${diag_t}) is logged after the reuse spawn's call (${reuse_t})"
        echo "${TEST_NAME}: ${step}: the lost-transcript diagnosis for ${id} at ${diag_t}, before the reuse spawn"
        echo "${TEST_NAME}: NOTE: ${step}: the diagnosis's startup-errors entries after the mark: ${INCONCLUSIVE_CLASS}=$(t19_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "] [${INCONCLUSIVE_CLASS}] ") ${LOST_CLASS}=$(t19_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "] [${LOST_CLASS}] ")"
    fi

    # prior_sessions does not list the first life's session.
    t19_row_get "${id}" "${step}: the new life"
    jq -e '(.prior_sessions | type) == "array"' "${AD_OUT}" > /dev/null 2>&1 \
        || { sed 's/^/  | /' "${AD_OUT}" >&2; fail "${step}: the harness get of ${id} carries no prior_sessions array"; }
    if jq -e --arg sid "${old_sid}" '.prior_sessions | tostring | contains($sid)' "${AD_OUT}" > /dev/null 2>&1; then
        sed 's/^/  | /' "${AD_OUT}" >&2
        fail "${step}: the harness get of ${id}'s new life lists the first life's session ${old_sid} in prior_sessions"
    fi
    echo "${TEST_NAME}: NOTE: ${step}: ${id}'s new life: session '$(jq -r '.claude_session_id // ""' "${AD_OUT}")', transcript_status '$(jq -r '.transcript_status // ""' "${AD_OUT}")', prior_sessions $(jq -c '.prior_sessions' "${AD_OUT}")"

    # The pre_trust line: ok, for the reuse spawn.
    t19_value line personaPreTrustLogLine "${name}" LAUNCH_VERB_REUSE_SPAWN ok
    n="$(t19_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "] ${line}")"
    if [[ "${n}" != 1 ]]; then
        t19_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" | grep -F -- 'pre_trust' | sed 's/^/  | /' >&2 || true
        echo "  | expected: ${line}" >&2
        fail "${step}: ${n} server.log line(s) of ${id}'s reuse spawn pre_trust ok after the mark, not 1"
    fi

    # No CSCB delete; the row present.
    n="$(t19_cscb_count_since "${MARK_TIME}" delete)"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB delete call(s) after the mark"
    t19_note_calls "${MARK_TIME}" "${id}" "${step}"

    # 6. The harness's resume of the unmessaged new life, with the server
    #    stopped and the life ended.
    stop_server
    t19_end_life "${p}" "${step}: the new life"
    ad_capture resume --claude-instance-id "${id}"
    rc="${AD_RC}"
    if [[ "${rc}" == 0 ]] || ! jq -e -s --arg n "${NEVER_WRITTEN}" 'any(.[]; type == "object" and .err_name == $n)' "${AD_OUT}" "${AD_ERR}" > /dev/null 2>&1; then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: the harness resume of ${id}'s unmessaged new life exited ${rc}, not answering ${NEVER_WRITTEN}"
    fi
    echo "${TEST_NAME}: ${step}: the harness resume of ${id} answered ${NEVER_WRITTEN}"
    t19_row_get "${id}" "${step}: after the harness resume"
    echo "${TEST_NAME}: ${step}: ${id}'s row is kept, reading $(jq -r '.state' "${AD_OUT}")"
    if t19_has_session "${!session_var}"; then
        fail "${step}: ${!session_var} is there after the refused resume"
    fi
}

# ---------------------------------------------------------------------------
# Scenario 12 (b.jg5 SRJ-1414): helpers
# ---------------------------------------------------------------------------

# t19_poll <timeout-s> <command> [<arg>...]: run the command every second
# until it succeeds (0) or the timeout passes (1).
t19_poll() {
    local timeout_s="$1" deadline
    shift
    deadline=$(( SECONDS + timeout_s ))
    while :; do
        "$@" && return 0
        (( SECONDS < deadline )) || return 1
        sleep 1
    done
}

# t19_watch_start <id> <file>: from now on, a subshell of the scenario's own
# shell (`track_pid`) reads the row with the harness `get` every
# WATCH_PERIOD_S and appends one JSON line per read to <file>: {t, rc, state,
# claude_session_id} for an answered read, {t, rc, err} (its output and
# error, on one line) for a failed one. It ends at the top of its loop once
# <file>.stop exists (`t19_bg_stop`).
t19_watch_start() {
    local id="$1" file="$2"
    : > "${file}"
    rm -f -- "${file}.stop"
    (
        set +e
        tmp="${file}.read"
        while :; do
            [[ -e "${file}.stop" ]] && exit 0
            t="${EPOCHREALTIME/,/.}"
            ad get --claude-instance-id "${id}" > "${tmp}" 2> "${tmp}.err"
            rc=$?
            if (( rc == 0 )); then
                jq -c --arg t "${t}" '{t: $t, rc: 0, state: .state, claude_session_id: (.claude_session_id // "")}' \
                    "${tmp}" >> "${file}" 2> /dev/null
            else
                jq -cn --arg t "${t}" --argjson rc "${rc}" --rawfile o "${tmp}" --rawfile e "${tmp}.err" \
                    '{t: $t, rc: $rc, err: (($o + " " + $e) | gsub("\n"; " ") | .[0:400])}' >> "${file}" 2> /dev/null
            fi
            sleep "${WATCH_PERIOD_S}"
        done
    ) &
    T19_WATCH_PID=$!
    track_pid "${T19_WATCH_PID}"
}

# t19_watch_first <file> <state>: the time of the first answered read of
# <state> in <file>, or nothing.
t19_watch_first() {
    jq -r -s --arg s "$2" '[.[] | select(.rc == 0 and .state == $s)] | if length == 0 then "" else .[0].t end' "$1"
}

# t19_watch_check <file> <id> <step>: the row was present at every read:
# at least one answered read, and none answered ErrSpawnNotFound; logs any
# other failed read (no reading of the row either way) and the states read,
# in order.
t19_watch_check() {
    local file="$1" id="$2" step="$3" n answered failed states
    n="$(t19_lines "${file}")"
    answered="$(jq -s '[.[] | select(.rc == 0)] | length' "${file}")"
    (( answered > 0 )) || fail "${step}: no background get of ${id} answered (${n} read(s))"
    if jq -e -s --arg nf "${NOT_FOUND}" 'any(.[]; .rc != 0 and (.err | contains($nf)))' "${file}" > /dev/null; then
        jq -c 'select(.rc != 0)' "${file}" | sed 's/^/  | /' >&2
        fail "${step}: a background get of ${id} answered ${NOT_FOUND}: the row was gone"
    fi
    failed="$(( n - answered ))"
    if [[ "${failed}" != 0 ]]; then
        echo "${TEST_NAME}: NOTE: ${step}: ${failed} of ${n} background gets of ${id} failed other than ${NOT_FOUND}:"
        jq -c 'select(.rc != 0)' "${file}" | sed "s/^/${TEST_NAME}: NOTE: ${step}:   /"
    fi
    states="$(jq -r -s '[.[] | select(.rc == 0) | .state] | reduce .[] as $s ([]; if length > 0 and .[-1] == $s then . else . + [$s] end) | join(" -> ")' "${file}")"
    echo "${TEST_NAME}: ${step}: ${id}'s row was read present by ${answered} of ${n} background gets, and none answered ${NOT_FOUND}"
    echo "${TEST_NAME}: NOTE: ${step}: the states read of ${id}, in order: ${states}"
}

# t19_count_lines <text>: how many non-empty lines <text> holds.
t19_count_lines() {
    grep -c . <<< "$1" || true
}

# t19_at_or_before <time> <limit>: true when <time> is at or before <limit>.
t19_at_or_before() {
    awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 <= b + 0) }'
}

declare -A T19_CLASS_OF=()

# t19_error_class <error-name> <step>: set T19_CLASS to the class
# `classifyAdError` gives an error of that agent-director error class
# (printed once, then kept).
t19_error_class() {
    local name="$1" value
    if [[ -z "${T19_CLASS_OF[${name}]+set}" ]]; then
        [[ "${name}" =~ ^Err[A-Za-z]+$ ]] || fail "$2: the refusal names '${name}', not an agent-director error name"
        t19_value value classifyAdError "${name}"
        T19_CLASS_OF["${name}"]="${value}"
    fi
    T19_CLASS="${T19_CLASS_OF[${name}]}"
}

# t19_reuse_lines <head> <ref>: server.log's lines after the mark holding
# <head><ref> (a reuse spawn's refusal or success line for <ref>).
t19_reuse_lines() {
    t19_log_after "$(matcher "$1$2")"
}

# t19_refusals_settled <id> <ref> <min> <step>: true once at least <min>
# reuse spawns of <ref> were refused after the mark and every CSCB reuse
# spawn of <id> after the mark has its refusal line (none in flight); fails
# at once when a reuse spawn succeeded.
t19_refusals_settled() {
    local id="$1" ref="$2" min="$3" step="$4" refused calls n
    n="$(t19_count_lines "$(t19_reuse_lines "${REUSE_SPAWNED_HEAD}" "${ref} ")")"
    [[ "${n}" == 0 ]] || fail "${step}: a reuse spawn of ${id} succeeded while the session holding its name still ran"
    refused="$(t19_count_lines "$(t19_reuse_lines "${REUSE_REFUSED_HEAD}" "${ref}: ")")"
    (( refused >= min )) || return 1
    calls="$(t19_reuse_spawns_since "${MARK_TIME}" "${id}")" || exit 1
    [[ "$(t19_count_lines "${calls}")" == "${refused}" ]]
}

# t19_dump_reuse <id> <ref>: print the leg's reuse lines for <ref> and CSCB's
# calls naming <id> since the mark, for a failure.
t19_dump_reuse() {
    {
        echo "  | server.log after the mark, lines naming $2:"
        t19_log_after "$(matcher "$2")" | sed 's/^/  |   /'
        echo "  | CSCB's agent-director calls naming $1 since the mark:"
        t19_cscb_calls_since "${MARK_TIME}" "" "$1" | awk -F'\t' '{ print "  |   " $2 " " $6 }'
    } >&2 || true
}

# t19_wait_refusals <id> <ref> <min> <timeout-s> <step>
t19_wait_refusals() {
    if ! t19_poll "$4" t19_refusals_settled "$1" "$2" "$3" "$5"; then
        t19_dump_reuse "$1" "$2"
        fail "$5: fewer than $3 refused reuse spawn(s) of $1 with none in flight (not within $4s)"
    fi
}

# t19_reuse_succeeded <ref>: true once a reuse spawn of <ref> succeeded
# after the mark.
t19_reuse_succeeded() {
    [[ "$(t19_count_lines "$(t19_reuse_lines "${REUSE_SPAWNED_HEAD}" "$1 ")")" != 0 ]]
}

# t19_check_refusals <id> <ref> <t-begin> <step>: <t-begin> is the time taken
# just before the harness began ending the session (`end_session`). Every
# CSCB-parented `spawn` of <id> carrying `--reuse-finished` made after the
# mark and before <t-begin> was refused, each UNAVAILABLE or CONFLICT, at
# least 2 of them, and no reuse spawn succeeded before <t-begin>; exactly one
# succeeded after the mark. A reuse spawn in flight while the session was
# being ended (made before <t-begin>, its line logged after it) is accepted
# either way: refused (logged) or the one success. Logs each refusal's error
# name and description.
t19_check_refusals() {
    local id="$1" ref="$2" t_begin="$3" step="$4" calls n_calls lines line t rest name cls n_refused=0 n_after=0 success in_flight
    calls="$(t19_reuse_spawns_since "${MARK_TIME}" "${id}")" || exit 1
    n_calls="$(t19_count_lines "$(awk -F'\t' -v e="${t_begin}" '$2 + 0 < e + 0' <<< "${calls}")")"
    lines="$(t19_reuse_lines "${REUSE_REFUSED_HEAD}" "${ref}: ")"
    while IFS= read -r line; do
        [[ -n "${line}" ]] || continue
        t="$(t19_line_time "${line}")"
        rest="${line#*"${REUSE_REFUSED_HEAD}${ref}: "}"
        name="${rest%% *}"
        if ! t19_at_or_before "${t}" "${t_begin}"; then
            n_after=$(( n_after + 1 ))
            echo "${TEST_NAME}: NOTE: ${step}: a reuse spawn of ${id} refused after the harness began ending the session, at ${t}: ${rest:0:300}"
            continue
        fi
        n_refused=$(( n_refused + 1 ))
        t19_error_class "${name}" "${step}"
        cls="${T19_CLASS}"
        [[ "${cls}" == "${CLASS_UNAVAILABLE}" || "${cls}" == "${CLASS_CONFLICT}" ]] \
            || fail "${step}: a reuse spawn of ${id} was answered ${name} (${cls}), neither ${CLASS_UNAVAILABLE} nor ${CLASS_CONFLICT}: ${rest:0:300}"
        echo "${TEST_NAME}: ${step}: CSCB's reuse spawn of ${id} refused at ${t}, ${cls}: ${rest:0:300}"
    done <<< "${lines}"
    (( n_refused >= 2 )) || { t19_dump_reuse "${id}" "${ref}"; fail "${step}: ${n_refused} CSCB reuse spawn(s) of ${id} refused before the harness began ending the session, not at least 2"; }
    # Each call made before <t-begin> is refused before it, or (at most one,
    # a reuse spawn runs alone) is in flight across it.
    in_flight=$(( n_calls - n_refused ))
    (( in_flight == 0 || in_flight == 1 )) \
        || { t19_dump_reuse "${id}" "${ref}"; fail "${step}: ${n_calls} CSCB reuse spawn(s) of ${id} before the harness began ending the session, ${n_refused} refusal line(s) before it"; }
    if (( in_flight == 1 )); then
        echo "${TEST_NAME}: NOTE: ${step}: one CSCB reuse spawn of ${id} was in flight when the harness began ending the session; its outcome is accepted either way"
    fi
    success="$(t19_reuse_lines "${REUSE_SPAWNED_HEAD}" "${ref} ")"
    [[ "$(t19_count_lines "${success}")" == 1 ]] \
        || { t19_dump_reuse "${id}" "${ref}"; fail "${step}: $(t19_count_lines "${success}") successful reuse spawn(s) of ${id} after the mark, not 1"; }
    t="$(t19_line_time "${success}")"
    t19_at_or_before "${t_begin}" "${t}" || fail "${step}: the reuse spawn of ${id} succeeded at ${t}, before the harness began ending the session (${t_begin})"
    echo "${TEST_NAME}: ${step}: ${n_refused} reuse spawn(s) of ${id} refused while the session ran; the reuse spawn at ${t}, after the harness began ending it at ${t_begin}, succeeded"
}

# t19_note_posts <channel> <record-line> <step>: log the posts at <channel>
# in the Slack stub's record after <record-line>.
t19_note_posts() {
    local texts
    # A torn last line (the stub may be writing it) does not parse and is
    # skipped.
    texts="$(t19_after "${STUB_RECORD}" "$2" \
        | jq -R -r --arg c "$1" 'fromjson? // empty | select(.event == "api" and .method == "chat.postMessage" and .channel == $c) | .text | gsub("\n"; " ") | .[0:200]')" || true
    echo "${TEST_NAME}: NOTE: $3: $(t19_count_lines "${texts}") post(s) at $1 after the mark"
    if [[ -n "${texts}" ]]; then
        sed "s/^/${TEST_NAME}: NOTE: $3:   post: /" <<< "${texts}"
    fi
}

# t19_note_pre_trust <name> <step>: log the reuse spawn's `pre_trust` lines
# after the mark, by value.
t19_note_pre_trust() {
    local value line n summary=""
    for value in ok skipped failed; do
        t19_value line personaPreTrustLogLine "$1" LAUNCH_VERB_REUSE_SPAWN "${value}"
        n="$(t19_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "] ${line}")"
        summary+="${value}=${n} "
    done
    echo "${TEST_NAME}: NOTE: $2: the reuse spawn's pre_trust lines after the mark: ${summary}"
}

# t19_all_find_missing_since <time>: how many agent-director calls of
# `find-missing` the shim logged at or after <time>, whoever made them.
t19_all_find_missing_since() {
    [[ -f "${SCENARIO_AD_SHIM_LOG}" ]] || { echo 0; return 0; }
    awk -F'\t' -v t="$1" '$1 == "call" && $2 + 0 >= t + 0 && (" " $6 " ") ~ / find-missing / { n++ } END { print n + 0 }' "${SCENARIO_AD_SHIM_LOG}"
}

t19_row_pending_launched() {
    ad_capture status --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || return 1
    jq -e '.state == "pending" and ((.launch_started_at // "") != "")' "${AD_OUT}" > /dev/null 2>&1
}

# t19_pane_dead <session>: true when the session's pane reads dead.
t19_pane_dead() {
    [[ "$("${SCENARIO_REAL_TMUX}" display-message -p -t "=$1:" '#{pane_dead}' 2> /dev/null)" == 1 ]]
}

# ---------------------------------------------------------------------------
# Scenario 12, leg G: a missing row with no session id beside a leftover
# ---------------------------------------------------------------------------

t19_leg_missing_row() {
    local step="missing row, no session id" id="${G_ID}" name="${G_NAME}" session="${G_SESSION}" work="${G_WORK}"
    local ref launch_start launch_s watch leftover_sid elapsed t_begin missing_t fm_t first_reuse_t diag diag_t n all_fm sid mark_record

    ref="$(persona_ref "${name}")" || exit 1

    # 1. G's first life, silent: pending with a launch start, no session id.
    stub_mode "${work}" "${STUB_MODE_SILENT}"
    t19_config_for_next_start true G
    t19_mark
    mark_record="$(t19_lines "${STUB_RECORD}")"
    t19_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${id} never read pending with a launch start" t19_row_pending_launched "${id}"
    t19_row_get "${id}" "${step}: the launch"
    launch_start="$(jq -r '.launch_started_at // empty' "${AD_OUT}")"
    [[ -z "$(jq -r '.claude_session_id // empty' "${AD_OUT}")" ]] \
        || fail "${step}: ${id}'s silent launch has a claude_session_id: $(jq -c . "${AD_OUT}")"
    launch_s="$(date -u -d "${launch_start}" +%s.%3N)" || fail "${step}: could not read the launch start '${launch_start}'"
    watch="${SCENARIO_ROOT}/watch-G.jsonl"
    t19_watch_start "${id}" "${watch}"

    # 2. Before G: the sentinel ends the silent worker (no hook) and its
    #    session; the leftover is seeded; `dev-channels` is selected.
    stub_type_line "${session}" "${STUB_EXIT_SENTINEL}"
    wait_until "${ENDED_WAIT_S}" "${step}: ${session} is still there after the exit sentinel" t19_no_session "${session}"
    seed_leftover -c "${work}" "${session}" "${id}" "${SCENARIO_BIN}/claude" > "${SCENARIO_ROOT}/seed-G.out"
    leftover_sid="${SEEDED_SESSION_ID}"
    elapsed="$(awk -v a="${EPOCHREALTIME/,/.}" -v b="${launch_s}" 'BEGIN { printf "%.3f", a - b }')"
    awk -v e="${elapsed}" -v g="${GRACE_S}" 'BEGIN { exit !(e + 0 < g + 0) }' \
        || fail "${step}: the leftover was seeded ${elapsed} s after ${id}'s launch start, not before G (${GRACE_S} s)"
    t19_row_is "${id}" pending || fail "${step}: ${id} reads '$(t19_row_state "${id}")' after the leftover was seeded, not pending"
    stub_mode "${work}" "${STUB_MODE_DEV_CHANNELS}"
    echo "${TEST_NAME}: ${step}: the silent worker ended and the leftover ${leftover_sid} (pane ${SEEDED_PANE_ID}, token ${SEEDED_TOKEN}, store ${SEEDED_STORE_ID}) seeded ${elapsed} s after ${id}'s launch start (G ${GRACE_S} s)"

    # 3. CSCB's own runs mark the row missing; its resume and reuse follow,
    #    refused while the leftover runs; then the harness ends it.
    t19_wait_refusals "${id}" "${ref}" 1 "${FIRST_REFUSAL_WAIT_S}" "${step}: the first refused reuse spawn"
    t19_wait_refusals "${id}" "${ref}" 2 "${REFUSAL_WAIT_S}" "${step}: a refused retry of the reuse spawn"
    t_begin="${EPOCHREALTIME/,/.}"
    end_session "${leftover_sid}"
    echo "${TEST_NAME}: ${step}: the harness began ending the leftover ${leftover_sid} at ${t_begin}"

    # 4. The next reuse spawn succeeds; the row reads waiting.
    if ! t19_poll "${REUSE_WAIT_S}" t19_reuse_succeeded "${ref}"; then
        t19_dump_reuse "${id}" "${ref}"
        fail "${step}: no reuse spawn of ${id} succeeded after the leftover was ended (not within ${REUSE_WAIT_S}s)"
    fi
    wait_until "${ROW_WAIT_S}" "${step}: ${id}'s new life never reported in (waiting)" t19_row_is "${id}" waiting
    t19_bg_stop "${T19_WATCH_PID}" "${watch}.stop" "${step}: stop the background get"

    # 5. The checks.
    # The row read missing, marked by CSCB's own run: a CSCB find-missing
    # after the mark no later than the first read of missing, and none
    # from any other process.
    missing_t="$(t19_watch_first "${watch}" missing)"
    [[ -n "${missing_t}" ]] || { jq -c . "${watch}" | sed 's/^/  | /' >&2; fail "${step}: the background get never read ${id} missing"; }
    fm_t="$(t19_cscb_calls_since "${MARK_TIME}" find-missing | awk -F'\t' 'NR == 1 { print $2 }')" || exit 1
    [[ -n "${fm_t}" ]] || fail "${step}: no CSCB find-missing after the mark"
    t19_at_or_before "${fm_t}" "${missing_t}" \
        || fail "${step}: ${id} read missing at ${missing_t}, before CSCB's first find-missing after the mark (${fm_t})"
    all_fm="$(t19_all_find_missing_since "${MARK_TIME}")"
    n="$(t19_cscb_count_since "${MARK_TIME}" find-missing)"
    [[ "${all_fm}" == "${n}" ]] || fail "${step}: ${all_fm} find-missing call(s) after the mark, of which ${n} CSCB's: another process ran find-missing"
    echo "${TEST_NAME}: ${step}: CSCB's own find-missing (first at ${fm_t}; ${n} after the mark, no other) marked ${id} missing (first read ${missing_t})"

    # The resume answered ErrNoSessionId, before the first reuse spawn.
    n="$(t19_cscb_count_since "${MARK_TIME}" resume "${id}")"
    (( n >= 1 )) || fail "${step}: no CSCB resume of ${id} after the mark"
    first_reuse_t="$(t19_reuse_spawns_since "${MARK_TIME}" "${id}" | awk -F'\t' 'NR == 1 { print $2 }')"
    diag="$(t19_log_after "$(matcher "${NO_SESSION_ID}" "${NO_TRANSCRIPT_RESUME_WORD}" "${ref}" "${NO_TRANSCRIPT_NOTHING_DELETED}")" | head -n 1)"
    [[ -n "${diag}" ]] || { t19_dump_reuse "${id}" "${ref}"; fail "${step}: no server.log line after the mark naming ${NO_SESSION_ID} on a resume of ${ref}"; }
    diag_t="$(t19_line_time "${diag}")"
    t19_at_or_before "${diag_t}" "${first_reuse_t}" \
        || fail "${step}: the ${NO_SESSION_ID} line (${diag_t}) is logged after CSCB's first reuse spawn of ${id} (${first_reuse_t})"
    echo "${TEST_NAME}: ${step}: CSCB's resume of ${id} answered ${NO_SESSION_ID} at ${diag_t}; ${n} CSCB resume call(s) after the mark"

    # Each reuse spawn refused while the leftover ran; one succeeded after.
    t19_check_refusals "${id}" "${ref}" "${t_begin}" "${step}"

    # The new life; no delete; the row present throughout.
    t19_row_get "${id}" "${step}: the new life"
    sid="$(jq -r '.claude_session_id // empty' "${AD_OUT}")"
    [[ -n "${sid}" ]] || fail "${step}: ${id}'s new life reads waiting with no claude_session_id"
    echo "${TEST_NAME}: ${step}: ${id}'s new life reads waiting with session ${sid}"
    n="$(t19_cscb_count_since "${MARK_TIME}" delete)"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB delete call(s) after the mark"
    t19_watch_check "${watch}" "${id}" "${step}"

    # Outcomes the SRD leaves open.
    t19_note_calls "${MARK_TIME}" "${id}" "${step}"
    t19_note_posts "${G_CHANNEL}" "${mark_record}" "${step}"
    t19_note_pre_trust "${name}" "${step}"
    echo "${TEST_NAME}: NOTE: ${step}: agent-director's trail records naming ${id}, by event: $(jq -r --arg id "${id}" 'select(.claude_instance_id == $id) | .event // "?"' "${HOME}/.agent-director/ad-trail.jsonl" 2> /dev/null | sort | uniq -c | awk '{ printf "%s=%s ", $2, $1 }')"

    # 6. A plain stop; the harness ends the new life.
    stop_server
    t19_end_life G "${step}: the new life"
}

# ---------------------------------------------------------------------------
# Scenario 12, leg H: an ended row with a stale config_dir label beside its
# remaining session
# ---------------------------------------------------------------------------

t19_leg_stale_config_dir() {
    local step="ended row, stale config_dir" id="${H_ID}" name="${H_NAME}" session="${H_SESSION}"
    local ref old_sid ids sid dead watch t_begin n all collided new_sid mark_record

    ref="$(persona_ref "${name}")" || exit 1

    # 1. H's first life, reporting in.
    t19_config_for_next_start true H
    t19_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${id}'s first life never reported in (waiting)" t19_row_is "${id}" waiting
    t19_row_get "${id}" "${step}: the first life"
    old_sid="$(jq -r '.claude_session_id // empty' "${AD_OUT}")"
    [[ -n "${old_sid}" ]] || fail "${step}: ${id}'s first life has no claude_session_id"
    echo "${TEST_NAME}: ${step}: ${id}'s first life: session ${old_sid}, labels $(jq -c '.labels // null' "${AD_OUT}")"

    # 2. remain-on-exit, then the sentinel: ended, the session stays.
    set_remain_on_exit "${session}"
    stub_type_line "${session}" "${STUB_EXIT_SENTINEL}"
    wait_until "${ENDED_WAIT_S}" "${step}: ${id} does not read ended after the exit sentinel" t19_row_is "${id}" ended
    wait_until "${ENDED_WAIT_S}" "${step}: ${session}'s pane never read dead after the exit sentinel" t19_pane_dead "${session}"
    ids="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{session_id} #{pane_dead}' 2> /dev/null)" \
        || fail "${step}: ${session} is gone after the exit sentinel, with remain-on-exit on"
    read -r sid dead <<< "${ids}"
    [[ "${sid}" =~ ^\$[0-9]+$ && "${dead}" == 1 ]] || fail "${step}: ${session} reads '${ids}', not a session id and a dead pane"
    echo "${TEST_NAME}: ${step}: ${id} reads ended; its session ${sid} remains with its pane dead"

    # 3. The re-point, a plain stop, the mark and a start.
    repoint_symlink "${H_CFG_LINK}" "${H_CFG_TWO}"
    stop_server
    t19_mark
    mark_record="$(t19_lines "${STUB_RECORD}")"
    watch="${SCENARIO_ROOT}/watch-H.jsonl"
    t19_watch_start "${id}" "${watch}"
    t19_start_and_wait 1
    t19_wait_refusals "${id}" "${ref}" 2 "${REFUSAL_WAIT_S}" "${step}: a refused retry of the reuse spawn"
    t_begin="${EPOCHREALTIME/,/.}"
    end_session "${sid}"
    echo "${TEST_NAME}: ${step}: the harness began ending ${id}'s remaining session ${sid} at ${t_begin}"

    # 4. The next reuse spawn succeeds; the row reads waiting.
    if ! t19_poll "${REUSE_WAIT_S}" t19_reuse_succeeded "${ref}"; then
        t19_dump_reuse "${id}" "${ref}"
        fail "${step}: no reuse spawn of ${id} succeeded after its session was ended (not within ${REUSE_WAIT_S}s)"
    fi
    wait_until "${ROW_WAIT_S}" "${step}: ${id}'s new life never reported in (waiting)" t19_row_is "${id}" waiting
    t19_bg_stop "${T19_WATCH_PID}" "${watch}.stop" "${step}: stop the background get"

    # 5. The checks.
    # Every CSCB spawn of H's id after the mark that carries no
    # `--reuse-finished` is the collision ladder's first spawn, answered
    # ErrInstanceIdCollision (nothing written; SRJ-111, SRJ-114: the SRD's
    # ladder makes it before its collision `get`); no resume.
    all="$(t19_cscb_count_since "${MARK_TIME}" spawn "${id}")"
    n="$(t19_count_lines "$(t19_reuse_spawns_since "${MARK_TIME}" "${id}")")"
    collided="$(t19_count_lines "$(t19_log_after "$(matcher "${LADDER_COLLISION_HEAD}${INSTANCE_ID_COLLISION}${LADDER_COLLISION_FOR}${ref}${LADDER_COLLISION_TAIL}")")")"
    [[ "$(( all - n ))" == "${collided}" ]] \
        || { t19_dump_reuse "${id}" "${ref}"; fail "${step}: ${all} CSCB spawn(s) of ${id} after the mark, ${n} carrying --reuse-finished, but ${collided} collision line(s) for the others"; }
    n="$(t19_cscb_count_since "${MARK_TIME}" resume "${id}")"
    [[ "${n}" == 0 ]] || { t19_dump_reuse "${id}" "${ref}"; fail "${step}: ${n} CSCB resume call(s) of ${id} after the mark: an ended row with a stale config_dir label is never resumed"; }
    echo "${TEST_NAME}: ${step}: of ${all} CSCB spawn(s) of ${id} after the mark, every one without --reuse-finished (${collided}) was the collision ladder's first spawn, answered ${INSTANCE_ID_COLLISION}; no CSCB resume of it was made"
    t19_check_refusals "${id}" "${ref}" "${t_begin}" "${step}"

    # The new life; no delete; the row present throughout.
    t19_row_get "${id}" "${step}: the new life"
    new_sid="$(jq -r '.claude_session_id // empty' "${AD_OUT}")"
    [[ -n "${new_sid}" && "${new_sid}" != "${old_sid}" ]] \
        || fail "${step}: ${id}'s new life reads session '${new_sid}', not a new session id (the first life's was ${old_sid})"
    echo "${TEST_NAME}: ${step}: ${id}'s new life reads waiting with session ${new_sid} (the first life's was ${old_sid}), labels $(jq -c '.labels // null' "${AD_OUT}")"
    n="$(t19_cscb_count_since "${MARK_TIME}" delete)"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB delete call(s) after the mark"
    t19_watch_check "${watch}" "${id}" "${step}"

    # Outcomes the SRD leaves open.
    t19_note_calls "${MARK_TIME}" "${id}" "${step}"
    t19_note_posts "${H_CHANNEL}" "${mark_record}" "${step}"
    t19_note_pre_trust "${name}" "${step}"

    # 6. A plain stop; the harness ends the new life.
    stop_server
    t19_end_life H "${step}: the new life"
}

# ---------------------------------------------------------------------------
# Scenario 18 (b.jg5 SRJ-1419): helpers
# ---------------------------------------------------------------------------

# t19_retired_cause <key>: print the cause the retired-key record holds for
# <key> (nothing when the record or the key's entry is missing). The record's
# `keys` and `cause` fields are its format's (b.jg5 SRJ-802;
# src/retired-keys.ts serializeRetiredKeys, which exports no field name).
t19_retired_cause() {
    local path
    t19_value path retiredKeysPath "${SLACK_STATE_DIR}"
    [[ -f "${path}" ]] || return 0
    jq -r --arg k "$1" '.keys[$k].cause // empty' "${path}"
}

# t19_applied_logged <line>: true once server.log holds <line> after the mark.
t19_applied_logged() {
    [[ "$(t19_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "] $1")" != 0 ]]
}

# t19_apply_config <step> <added> <removed> <destructive> [<prefix>...]: the
# operator's edit and confirmation on the running server: no pending file
# before the edit; config.json holds these personas (`t19_config`, resume
# enabled); the pending file the reload tick writes is renamed to the apply
# file; then the apply's own line after the mark, for a change of those
# counts, logged once every step of the apply ran.
t19_apply_config() {
    local step="$1" added="$2" removed="$3" destructive="$4" pending apply line
    shift 4
    pending="${SLACK_STATE_DIR}/config.json${PENDING_SUFFIX}"
    apply="${SLACK_STATE_DIR}/config.json${APPLY_SUFFIX}"
    [[ ! -e "${pending}" ]] || fail "${step}: ${pending} exists before the edit"
    t19_config true "$@"
    wait_for_file "${pending}" "${RELOAD_WAIT_S}" "${step}: no pending file after the config.json edit"
    mv -f -- "${pending}" "${apply}" || fail "${step}: could not rename ${pending} to ${apply}"
    t19_value line reloadAppliedLogLine "${added}" "${removed}" "${destructive}" 0 0 0 "${SLACK_STATE_DIR}/config.json"
    if ! t19_poll "${APPLY_WAIT_S}" t19_applied_logged "${line}"; then
        t19_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" | grep -F -- 'reload' | sed 's/^/  | /' >&2 || true
        echo "  | expected: ${line}" >&2
        fail "${step}: the apply never logged its line (not within ${APPLY_WAIT_S}s)"
    fi
    echo "${TEST_NAME}: ${step}: the operator confirmed the apply; it logged its line (${added} added, ${removed} removed, ${destructive} destructively modified)"
}

# t19_message_life <prefix> <step>: the human messages the persona's live life
# (`stub_type_line`, a line that is not the sentinel), so its transcript
# exists. Checked: before the message no transcript is at the path
# agent-director's `resume` looks for the life's session under the row's
# CLAUDE_CONFIG_DIR (the persona's claude_config_dir), and after it one is.
# Logged: the row's `jsonl_path` and `transcript_status` after the message.
# Sets T19_OLD_SID to the life's session id.
t19_message_life() {
    local p="$1" step="$2" id_var="$1_ID" session_var="$1_SESSION" cfg_var="$1_CFG" id sid cwd path
    id="${!id_var}"
    t19_row_get "${id}" "${step}"
    sid="$(jq -r '.claude_session_id // empty' "${AD_OUT}")"
    cwd="$(jq -r '.cwd // empty' "${AD_OUT}")"
    [[ -n "${sid}" && -n "${cwd}" ]] || fail "${step}: ${id}'s row reads session '${sid}' and cwd '${cwd}'"
    # agent-director's transcript path for a session under a config directory
    # (its slug of the cwd: every character outside [A-Za-z0-9-] becomes `-`).
    path="${!cfg_var}/projects/$(LC_ALL=C sed 's/[^A-Za-z0-9-]/-/g' <<< "${cwd}")/${sid}.jsonl"
    [[ ! -e "${path}" ]] || fail "${step}: ${id}'s life has a transcript at ${path} before it was messaged"
    stub_type_line "${!session_var}" "a first message"
    wait_until "${TRANSCRIPT_WAIT_S}" "${step}: no transcript at ${path} after the message" test -f "${path}"
    t19_row_get "${id}" "${step}: after the message"
    echo "${TEST_NAME}: ${step}: the human messaged ${id}'s life (session ${sid}); its transcript is at ${path}, where agent-director's resume looks for that session"
    echo "${TEST_NAME}: NOTE: ${step}: ${id}'s row after the message: state '$(jq -r '.state // ""' "${AD_OUT}")', jsonl_path '$(jq -r '.jsonl_path // ""' "${AD_OUT}")', transcript_status '$(jq -r '.transcript_status // ""' "${AD_OUT}")'"
    T19_OLD_SID="${sid}"
}

# t19_row_waiting_new <id> <old-sid>: true when a harness `get` reads the row
# `waiting` with a session id other than <old-sid>.
t19_row_waiting_new() {
    ad_capture get --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || return 1
    jq -e --arg old "$2" '.state == "waiting" and ((.claude_session_id // "") != "") and .claude_session_id != $old' "${AD_OUT}" > /dev/null 2>&1
}

# t19_check_first_spawn_reuse <id> <ref> <since> <step>: the first
# CSCB-parented `spawn` naming <id> at or after <since> carries
# `--reuse-finished`; logs every CSCB spawn of it since then.
t19_check_first_spawn_reuse() {
    local id="$1" ref="$2" since="$3" step="$4" calls first n reuse
    calls="$(t19_cscb_calls_since "${since}" spawn "${id}")" || exit 1
    if [[ -z "${calls}" ]]; then
        t19_dump_reuse "${id}" "${ref}"
        fail "${step}: no CSCB spawn of ${id} after the mark"
    fi
    first="$(head -n 1 <<< "${calls}")"
    if ! grep -qF -- '--reuse-finished' <<< "${first}"; then
        t19_dump_reuse "${id}" "${ref}"
        fail "${step}: the first CSCB spawn of ${id} after the mark carries no --reuse-finished: $(awk -F'\t' '{ print $6 }' <<< "${first}")"
    fi
    n="$(t19_count_lines "${calls}")"
    reuse="$(t19_count_lines "$(grep -F -- '--reuse-finished' <<< "${calls}" || true)")"
    echo "${TEST_NAME}: ${step}: CSCB's first spawn of ${id} after the mark, at $(awk -F'\t' '{ print $2 }' <<< "${first}"), carries --reuse-finished"
    echo "${TEST_NAME}: NOTE: ${step}: ${n} CSCB spawn(s) of ${id} after the mark, ${reuse} carrying --reuse-finished"
}

# t19_check_fresh <id> <old-sid> <since> <step>: the persona came back fresh
# and its old session is gone from its row: a harness `get` reads the row
# (present) `waiting` with a session other than <old-sid>, and its
# `prior_sessions` is an array that does not hold <old-sid>; no CSCB `resume`
# of <id> and no CSCB `delete` at or after <since>.
t19_check_fresh() {
    local id="$1" old_sid="$2" since="$3" step="$4" sid n
    t19_row_get "${id}" "${step}: the new life"
    sid="$(jq -r '.claude_session_id // empty' "${AD_OUT}")"
    [[ "$(jq -r '.state // empty' "${AD_OUT}")" == waiting && -n "${sid}" && "${sid}" != "${old_sid}" ]] \
        || { sed 's/^/  | /' "${AD_OUT}" >&2; fail "${step}: the harness get of ${id} does not read waiting with a session other than the old one (${old_sid})"; }
    jq -e '(.prior_sessions | type) == "array"' "${AD_OUT}" > /dev/null 2>&1 \
        || { sed 's/^/  | /' "${AD_OUT}" >&2; fail "${step}: the harness get of ${id} carries no prior_sessions array"; }
    if jq -e --arg sid "${old_sid}" '.prior_sessions | tostring | contains($sid)' "${AD_OUT}" > /dev/null 2>&1; then
        sed 's/^/  | /' "${AD_OUT}" >&2
        fail "${step}: the harness get of ${id}'s new life lists the old session ${old_sid} in prior_sessions"
    fi
    echo "${TEST_NAME}: ${step}: the harness get reads ${id} waiting with session ${sid}; the old session ${old_sid} is neither current nor in prior_sessions"
    echo "${TEST_NAME}: NOTE: ${step}: ${id}'s new life: transcript_status '$(jq -r '.transcript_status // ""' "${AD_OUT}")', prior_sessions $(jq -c '.prior_sessions' "${AD_OUT}")"
    n="$(t19_cscb_count_since "${since}" resume "${id}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB resume call(s) of ${id} after the mark: a retired key is never resumed"
    n="$(t19_cscb_count_since "${since}" delete)"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB delete call(s) after the mark"
    echo "${TEST_NAME}: ${step}: no CSCB resume of ${id} and no CSCB delete after the mark"
}

# ---------------------------------------------------------------------------
# Scenario 18, leg J: a persona messaged, removed, applied, restarted and
# re-added with the same key, working directory and config directory
# ---------------------------------------------------------------------------

t19_leg_removed_readded() {
    local step="removed and re-added" id="${J_ID}" name="${J_NAME}" session="${J_SESSION}"
    local ref old_sid removal_t cause state

    ref="$(persona_ref "${name}")" || exit 1

    # 1. J's first life, in `transcript-on-first-message`, reporting in; the
    #    human messages it.
    stub_mode "${J_WORK}" "${STUB_MODE_TRANSCRIPT_ON_FIRST_MESSAGE}"
    tmux_shim_mode log
    t19_config_for_next_start true J
    t19_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${id}'s first life never reported in (waiting)" t19_row_is "${id}" waiting
    t19_message_life J "${step}: the first life"
    old_sid="${T19_OLD_SID}"

    # 2. The operator removes J and confirms the apply: the teardown's kill
    #    (the tmux shim in `log`) ends J's session; J's key is recorded
    #    `removed`; its row is kept.
    t19_mark
    removal_t="${MARK_TIME}"
    t19_apply_config "${step}: the removal" 0 1 0
    wait_until "${ENDED_WAIT_S}" "${step}: ${session} is still there after the removal's apply" t19_no_session "${session}"
    cause="$(t19_retired_cause "${J_KEY}")"
    [[ "${cause}" == "${CAUSE_REMOVED}" ]] || fail "${step}: the retired-key record gives ${J_KEY} the cause '${cause}' after the removal, not ${CAUSE_REMOVED}"
    state="$(t19_row_state "${id}")"
    [[ -n "${state}" ]] || fail "${step}: ${id}'s row is gone after the removal: $(tr '\n' ' ' < "${AD_ERR}")"
    echo "${TEST_NAME}: ${step}: the removal's teardown ended ${session}; ${J_KEY} is recorded ${CAUSE_REMOVED}; ${id}'s row is kept, reading ${state}"

    # 3. A plain stop and a start, with no persona configured.
    stop_server
    t19_start_and_wait 0

    # 4. The operator adds J back, with the same key, working directory and
    #    claude_config_dir, and confirms the apply; J reports in.
    t19_mark
    t19_apply_config "${step}: the re-add" 1 0 0 J
    wait_until "${ROW_WAIT_S}" "${step}: ${id} never read waiting with a new session after the re-add" t19_row_waiting_new "${id}" "${old_sid}"

    # 5. The checks: the re-add's first spawn is a reuse; from the removal on,
    #    no resume and no delete; the old session is gone from the row.
    t19_check_first_spawn_reuse "${id}" "${ref}" "${MARK_TIME}" "${step}"
    t19_check_fresh "${id}" "${old_sid}" "${removal_t}" "${step}"
    t19_note_calls "${removal_t}" "${id}" "${step}"

    # 6. A plain stop; the harness ends the new life.
    stop_server
    t19_end_life J "${step}: the new life"
}

# ---------------------------------------------------------------------------
# Scenario 18, leg K: a messaged persona whose credentials_file path changes
# ---------------------------------------------------------------------------

t19_leg_credentials_changed() {
    local step="credentials_file changed" id="${K_ID}" name="${K_NAME}" session="${K_SESSION}"
    local ref old_sid change_t cause

    ref="$(persona_ref "${name}")" || exit 1

    # 1. K's first life, in `transcript-on-first-message`, reporting in; the
    #    human messages it.
    stub_mode "${K_WORK}" "${STUB_MODE_TRANSCRIPT_ON_FIRST_MESSAGE}"
    tmux_shim_mode log
    K_CREDS="${K_CREDS_ONE}"
    t19_config_for_next_start true K
    t19_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${id}'s first life never reported in (waiting)" t19_row_is "${id}" waiting
    t19_message_life K "${step}: the first life"
    old_sid="${T19_OLD_SID}"

    # 2. The operator points K's credentials_file at the second file and
    #    confirms the apply: a destructive modify, whose old half's teardown
    #    ends K's session and whose new half brings K up.
    t19_mark
    change_t="${MARK_TIME}"
    K_CREDS="${K_CREDS_TWO}"
    t19_apply_config "${step}: the change" 0 0 1 K
    wait_until "${ROW_WAIT_S}" "${step}: ${id} never read waiting with a new session after the change" t19_row_waiting_new "${id}" "${old_sid}"
    # Working default: by now the new life may have begun and its entry been
    # cleared (b.jg5 SRJ-806, SRJ-807), so only a cause other than the
    # destructive modify's fails.
    cause="$(t19_retired_cause "${K_KEY}")"
    if [[ -n "${cause}" ]]; then
        [[ "${cause}" == "${CAUSE_DESTRUCTIVE}" ]] || fail "${step}: the retired-key record gives ${K_KEY} the cause '${cause}', not ${CAUSE_DESTRUCTIVE}"
        echo "${TEST_NAME}: ${step}: ${K_KEY} is recorded ${CAUSE_DESTRUCTIVE}"
    else
        echo "${TEST_NAME}: NOTE: ${step}: ${K_KEY} has no entry in the retired-key record once its new life reads waiting"
    fi

    # 3. The checks: the change's first spawn is a reuse; from the change on,
    #    no resume and no delete; the old session is gone from the row.
    t19_check_first_spawn_reuse "${id}" "${ref}" "${change_t}" "${step}"
    t19_check_fresh "${id}" "${old_sid}" "${change_t}" "${step}"
    t19_note_calls "${change_t}" "${id}" "${step}"

    # 4. A plain stop; the harness ends the new life.
    stop_server
    t19_end_life K "${step}: the new life"
}

t19_harness_check
# S3: resume_enabled=false (SRJ-707's `resumeOrFreshSpawn` site).
t19_leg E "resume_enabled=false" false disabled
# S4: a missing transcript (SRJ-707, SRJ-712).
t19_leg F "missing transcript" true missing
# E48 T2 S1: a missing row with no session id beside a leftover (SRJ-1414).
t19_leg_missing_row
# E48 T2 S2: an ended row with a stale config_dir label beside its remaining
# session (SRJ-1414, SRJ-707's config_dir site).
t19_leg_stale_config_dir
# E48 T3 S1: a persona messaged, removed, applied, restarted and re-added
# (SRJ-1419, SRJ-805).
t19_leg_removed_readded
# E48 T3 S2: a messaged persona whose credentials_file path changes
# (SRJ-1419, SRJ-803, SRJ-805; AC 49).
t19_leg_credentials_changed

# The closing assertions (b.jg5 SRJ-1401, SRJ-1418).
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "${TEST_NAME}: PASS"
