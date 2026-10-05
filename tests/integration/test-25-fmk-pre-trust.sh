#!/usr/bin/env bash
# Test 25 (HO §7 scenario 22; b.jg5 SRJ-1424, SRJ-413, SRJ-402, SRJ-1306,
# SRJ-1401; Assumption A-22; AC 10): each launch's `pre_trust` is only
# logged, through the exported builder, and no launch opts out of pre-trust,
# in legs run in this order:
# - the migrated-row leg (`leg_migrated_row`, persona A): a row seeded on
#   agent-director 0.10.0, migrated by the release's install over it, then
#   resumed by CSCB's start pass; its `pre_trust` line is logged with
#   whatever value the `resume` reports, and the approver clears the
#   folder-trust prompt if it appears;
# - the new-persona legs (`legs_new_personas`, one server run): persona B,
#   new, whose resolved `.claude.json` exists, is spawned and reports `ok`;
#   persona C, new, given a fresh `claude_config_dir` with no `.claude.json`,
#   is spawned, reports `failed`, its launch proceeds, and the approver clears
#   the folder-trust prompt;
# - the script-wide check (`check_no_pre_trust_opt_out`): no CSCB-parented
#   spawn or `resume` in the agent-director shim's log carries
#   `--no-pre-trust`.
#
# The fmk set-up (lib/scenario.sh, fmk mode: TEST_NAME carries `-fmk-`):
# - its own HOME, agent-director store and tmux server under SCENARIO_ROOT;
#   the scenario HOME starts on agent-director 0.10.0 (SCENARIO_AD_START=0.10.0:
#   0.10.0's binary behind the agent-director shim, no store, no
#   agent-director-admin); the migrated-row leg runs the release's install.sh
#   over it (`install_ad_release`), which migrates the store with the seeded
#   row in it, puts the release and agent-director-admin behind the shim
#   (`reshim_ad`) and re-checks both shims; agent-director's default settings
#   (no config.toml, so no `[tmux]` table);
# - the tmux shim first on every CSCB process's PATH, in `log` mode
#   throughout;
# - the stub as `claude`: `at-once` in A's working directory while it is
#   seeded (`seed_010_row`'s default), then `folder-trust` in every persona's
#   working directory (`stub_mode`): a stub in a folder its `.claude.json`
#   trusts reports in at once, and in one it does not, it shows the
#   folder-trust prompt (holding TRUST_DIALOG_NEEDLE) and reports in on the
#   Enter that answers it. The stub reads trust from
#   `<CLAUDE_CONFIG_DIR>/.claude.json`, or from `~/.claude.json` with no
#   CLAUDE_CONFIG_DIR, the file agent-director's pre-trust writes;
# - CSCB's config: `health_check_interval` 0 (ruling S3), `session_restart_delay`
#   5, `exit_timeout` 5;
# - the live server against the Slack stub (fixtures/slack-stub-server.ts),
#   one stub per server run, answering ok only for that run's personas' token
#   pairs;
# - each leg in its own state dir (`new_state_dir`).
#
# The migrated-row leg (`leg_migrated_row`), in run order, persona A (working
# directory `migrated`). Steps marked [harness] are the harness playing a
# human from the scenario's own shell; no CSCB process makes them.
#   1. [harness] On 0.10.0, `seed_010_row` makes A's row with 0.10.0's own
#      `spawn`: instance id `personaInstanceId`, session name
#      `personaTmuxSessionName` and the labels a spawn of A carries
#      (`personaDefaultConfigDirLabels`: `service=cscb`, `persona=<A's key>`,
#      `config_dir=<the label of the scenario HOME's ~/.claude>`), in A's
#      working directory, with a stub worker that reports in at once.
#   2. [harness] The worker ends with the stub's sentinel, sent into its pane
#      with the real tmux, and a harness `get` on 0.10.0 reads the row `ended`
#      (or `missing`) with a claude_session_id.
#   3. [harness] The release's install.sh runs over 0.10.0 (the migration).
#      Checked: the agent-director shim and the agent-director-admin shim are
#      in place (`check_ad_shim`, `check_ad_admin_shim`), the binary behind the
#      shim is the release's, the store has a store id (`ad_store_id`), and a
#      harness `get` reads A's row finished with the same claude_session_id,
#      session name and labels.
#   4. [harness] A's working directory is selected for `folder-trust`; whether
#      the scenario HOME's `~/.claude.json` exists is recorded (the set-up
#      writes none, so it is expected absent, and pre-trust then has no file
#      to write).
#   5. A live start: its start pass resumes A (the collision ladder's plain
#      spawn collides with the finished row, its `get` reads it, then one
#      `resume`). The row reads `waiting` with the same claude_session_id, and
#      the approver has stopped (no bot-server pane read of A for
#      APPROVER_QUIET_S).
#   6. Checks, over the bot server's agent-director calls (`call_table`) and
#      its log lines from the start of step 5:
#      - exactly one `pre_trust` line for A's `resume`, equal to
#        `preTrustLogLine` for A's reference, LAUNCH_VERB_RESUME and one of
#        `ok`, `skipped`, `failed` or no field (the older-binary wording); the
#        script logs which. Ruling S8 and A-22: `ok` or `failed` is expected;
#        any other is printed as a `REPORT:` line for the calling agent, not
#        failed on;
#      - no `pre_trust` line for a spawn or a reuse spawn of A;
#      - exactly one bot-server `resume` of A's row, and no reuse spawn or
#        `kill` of it;
#      - every bot-server `send-keys` of A's row with `--allow-pending`
#        follows a bot-server `read-pane` of A's row with `--allow-pending`
#        made after the `resume`;
#      - A's row reads `waiting` (step 5).
#   The server is then stopped with a plain `stop`, and [harness] A's worker
#   ends with the sentinel.
# Recorded, not asserted: the start pass's summary, the collision line, the
# bot server's calls of A's row, whether the prompt appeared (the pane holds
# TRUST_DIALOG_NEEDLE) and the approver answered it (its `send-keys` count),
# whether the server registered A's MCP session, and `~/.claude.json` after
# the resume.
#
# The new-persona legs (`legs_new_personas`), in run order, in one server run:
# persona B (working directory `spawned`) and persona C (working directory
# `configdir`, `claude_config_dir` a fresh directory under SCENARIO_ROOT).
#   1. Set-up [harness]: B's resolved `.claude.json` is the scenario HOME's
#      `~/.claude.json` (B has no `claude_config_dir`); when the earlier steps
#      left none there, the harness writes an empty JSON object (`{}`) there,
#      so agent-director's pre-trust has a file to write. Which it was is
#      recorded. C's `claude_config_dir` is a new empty directory, so it holds
#      no `.claude.json` (checked); CSCB's trust patch never creates one.
#   2. [harness] Both working directories are selected for `folder-trust`.
#   3. A live start: its start pass makes a plain spawn of each (no row
#      exists for either).
#   4. Each row reads `waiting` with a claude_session_id, the server registers
#      each stub's session, and the approver has stopped for each.
#   5. B's checks, over the bot server's calls and the log lines from the
#      start of step 3:
#      - exactly one line equal to `preTrustLogLine` for B's reference,
#        LAUNCH_VERB_SPAWN and `ok`, and no other `pre_trust` line for B;
#      - exactly one bot-server plain spawn of B's row, and no `resume`, reuse
#        spawn or `kill` of it;
#      - B's row reads `waiting` (step 4).
#   6. C's checks, over the same calls and lines:
#      - exactly one line equal to `preTrustLogLine` for C's reference,
#        LAUNCH_VERB_SPAWN and `failed`, and no other `pre_trust` line for C;
#      - the launch proceeds: exactly one bot-server plain spawn of C's row,
#        and no `resume`, reuse spawn or `kill` of it;
#      - at least one bot-server `send-keys` of C's row with
#        `--allow-pending`, the first following a bot-server `read-pane` of C's
#        row with `--allow-pending` made after the spawn; C's pane holds the
#        folder-trust prompt (TRUST_DIALOG_NEEDLE) and not the dev-channels
#        dialog, so the Enter the approver sent answered that prompt (the
#        harness sends nothing into C's pane, and the stub reports in only on
#        that Enter);
#      - C's row reads `waiting` (step 4).
#   The server is then stopped with a plain `stop`, and [harness] both workers
#   end with the sentinel.
# Recorded, not asserted: the start pass's summary, the bot server's calls of
# each row, whether B's pane showed the prompt and the approver's `send-keys`
# count for B, B's trust entry in `~/.claude.json`, and whether C's
# `claude_config_dir` holds a `.claude.json` after the launch.
#
# The script-wide check (`check_no_pre_trust_opt_out`), over the whole
# agent-director shim log: no `spawn` or `resume` call line whose parent is a
# CSCB process carries `--no-pre-trust` (with or without `=<value>`), and
# there is at least one CSCB-parented `spawn` and one `resume`. Each launch the
# legs check has exactly one `pre_trust` line from the builder: A's `resume`,
# B's spawn and C's spawn each have one (steps 6, 5 and 6 above), and the
# colliding plain spawn of A, which launches nothing, has none (A's one line
# is its `resume`'s). The plain spawns of A are not counted.
#
# Waits (seconds): START_WAIT_S bounds a start pass, REPORT_WAIT_S a row
# reporting in, CONNECT_WAIT_S the server registering a stub's session and
# APPROVER_STOP_WAIT_S the approver going quiet; APPROVER_QUIET_S is three
# laps at the approver's pace (DIALOG_POLL_INTERVAL_MS), rounded up, so that
# long with no pane read after the row read `waiting` means it has stopped.
#
# Matched values. CSCB's values are printed by fixtures/fmk-texts.ts from
# the installed package, never retyped: the `pre_trust` lines
# (`preTrustLogLine` in src/session-manager.ts, built on
# PRE_TRUST_LOG_PREFIX, with LAUNCH_VERB_SPAWN, LAUNCH_VERB_RESUME and
# LAUNCH_VERB_REUSE_SPAWN; `preTrustLogLineHead` for a line with any present
# value); TRUST_DIALOG_NEEDLE, DEV_CHANNELS_DIALOG_NEEDLE and
# DIALOG_POLL_INTERVAL_MS (src/session-manager.ts); the instance id and
# session name (src/persona-identity.ts personaInstanceId,
# personaTmuxSessionName); A's seeded labels (`personaDefaultConfigDirLabels`:
# src/persona-identity.ts SERVICE_LABEL, PERSONA_LABEL_PREFIX and
# CONFIG_DIR_LABEL_PREFIX, with src/session-manager.ts
# personaConfigDirLabelValue). Values CSCB does not define, each quoted from
# its source:
# - the `pre_trust` values `ok`, `skipped` and `failed`: agent-director
#   0.11.0's client, the `pre_trust` field of SpawnResult and ResumeResult
#   (its dist/types.d.ts);
# - `--no-pre-trust`: agent-director 0.11.0's client's argv flag for
#   `no_pre_trust` (its dist/index.js buildSpawn); CSCB defines no constant
#   for it (ruling S7);
# - `--allow-pending`: the same client's argv flag for `allow_pending`
#   (its dist/index.js, the `read-pane` and `send-keys` builders);
# - `[slack] Session connected: persona <ref>` (src/server.ts, the MCP
#   session's registration line) and `[slack] spawnForPersona: collision
#   resolved, state=` (src/session-manager.ts runPersonaLadder's collision
#   line), for recorded lines;
# - the stub's sentinel `__CSCB_TEST_EXIT__` (fixtures/stub-claude.sh);
# - the persona reference `"<name>" (key=<key>)` (lib/scenario.sh
#   persona_ref, src/persona-identity.ts renderPersonaRef).
#
# Closing: the script ends with `assert_no_server_tmux`,
# `assert_no_cscb_include_finished` and `assert_no_cscb_delete` in its own
# shell. Every count of CSCB's agent-director calls reads only shim lines
# whose parent is a CSCB process; the harness's calls (its seeding `spawn` on
# 0.10.0 and its reads) and the stub's lines never count.
set -euo pipefail

TEST_NAME="test-25-fmk-pre-trust"
SCENARIO_AD_START=0.10.0
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# The fixtures.
FMK_TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"

# fmk_text <entry> [<arg>...]: print fixtures/fmk-texts.ts's value for <entry>.
fmk_text() {
    bun --no-install "${FMK_TEXTS}" "$@"
}

# Persona A (the migrated-row leg).
A_NAME="${SCENARIO_TAG}_migrated"
A_KEY="$(persona_key "${A_NAME}")"
A_REF="$(persona_ref "${A_NAME}")"
A_CHANNEL="C0T25MIG1"
A_SUFFIX=t25a

# Persona B (the new persona whose resolved .claude.json exists).
B_NAME="${SCENARIO_TAG}_spawned"
B_KEY="$(persona_key "${B_NAME}")"
B_REF="$(persona_ref "${B_NAME}")"
B_CHANNEL="C0T25SPN1"
B_SUFFIX=t25b

# Persona C (the new persona with a fresh claude_config_dir).
C_NAME="${SCENARIO_TAG}_configdir"
C_KEY="$(persona_key "${C_NAME}")"
C_REF="$(persona_ref "${C_NAME}")"
C_CHANNEL="C0T25CFG1"
C_SUFFIX=t25c

# Bounds (seconds; see the header).
STUB_WAIT_S=20        # the Slack stub writing its ready file
START_WAIT_S=120      # a start pass
REPORT_WAIT_S=60      # after a start pass: the row reporting in
CONNECT_WAIT_S=30     # after the row reported in: the server registering the stub's session
APPROVER_STOP_WAIT_S=20  # after the row reported in: the approver stopping
ENDED_WAIT_S=20       # after the sentinel: the row reading ended or missing

# The stub's sentinel (fixtures/stub-claude.sh).
SENTINEL=__CSCB_TEST_EXIT__

# The `pre_trust` values agent-director 0.11.0's client types for a launch
# result (SpawnResult and ResumeResult in its dist/types.d.ts). CSCB defines
# no constant for them: it only logs the value.
PRE_TRUST_OK=ok
PRE_TRUST_SKIPPED=skipped
PRE_TRUST_FAILED=failed

# agent-director 0.11.0's client's argv flag for `no_pre_trust` (its
# dist/index.js buildSpawn). CSCB defines no constant for it (ruling S7).
NO_PRE_TRUST_FLAG=--no-pre-trust

# The same client's argv flag for `allow_pending` (its dist/index.js, the
# read-pane and send-keys builders).
ALLOW_PENDING_FLAG=--allow-pending

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Print the time now, epoch seconds with microseconds (the shim logs' clock).
now_s() {
    printf '%s\n' "${EPOCHREALTIME/,/.}"
}

# start_slack_stub <dir> <suffix>...: start the Slack stub in a new <dir>,
# answering ok for each token pair ending in a <suffix> and refusing any
# other; wait for its ready file; export CSCB_SLACK_API_URL; set
# SLACK_STUB_PID.
start_slack_stub() {
    local dir="$1" step="slack stub" api_url
    shift
    mkdir "${dir}" || fail "${step}: could not create ${dir}"
    python3 - "$@" << 'EOF' | write_file "${dir}/control.json"
import json, sys
print(json.dumps({
    "tokens": [{"suffix": s, "label": s, "auth": "ok", "connections": "ok"} for s in sys.argv[1:]],
    "default": {"auth": "invalid_auth", "connections": "invalid_auth"},
}))
EOF
    (cd "${dir}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${dir}/record.jsonl" \
        --control "${dir}/control.json" --ready-file "${dir}/ready.json") > "${dir}/stub.out" 2>&1 &
    SLACK_STUB_PID=$!
    track_pid "${SLACK_STUB_PID}"
    wait_for_file "${dir}/ready.json" "${STUB_WAIT_S}" "${step}: the Slack stub never wrote its ready file"
    api_url="$(jq -r '.api_url' "${dir}/ready.json")"
    [[ "${api_url}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "${step}: the stub's api_url '${api_url}' is not loopback"
    export CSCB_SLACK_API_URL="${api_url}"
}

# line_count <file>: print how many lines <file> holds (0 when there is none).
line_count() {
    if [[ ! -f "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l < "$1" | tr -d ' '
}

# persona_json <name> <credentials-file> <working-dir> <channel> [<claude-config-dir>]:
# one persona object of the config.
persona_json() {
    jq -n -c --arg n "$1" --arg c "$2" --arg w "$3" --arg ch "$4" --arg cd "${5:-}" \
        '{name: $n, credentials_file: $c, working_directory: $w, channels: [{id: $ch, delivery: "all"}], permission_prompts: $ch}
         + (if $cd == "" then {} else {claude_config_dir: $cd} end)'
}

# write_personas_config <persona-json>...: the config with those personas,
# the health check off (`health_check_interval` 0, ruling S3).
write_personas_config() {
    printf '%s\n' "$@" | jq -s --argjson port "${SCENARIO_PORT}" \
        '{personas: ., bind: "127.0.0.1", port: $port, health_check_interval: 0, session_restart_delay: 5, exit_timeout: 5}' \
        | write_config
}

# write_credentials <dir> <suffix>: a credentials file for the token pair
# ending in <suffix>, at <dir>/<suffix>.json; print its path.
write_credentials() {
    local file="$1/$2.json"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "$2")" "$(fake_token app "$2")" \
        | write_file "${file}" 600
    printf '%s\n' "${file}"
}

# poll_row_of <id> <step>: a harness `get` of row <id>. Sets ROW_STATE
# (`absent` for ErrSpawnNotFound), ROW_SID (claude_session_id), ROW_SESSION
# (tmux_session_name) and ROW_LABELS (labels, compact JSON), each empty when
# absent.
poll_row_of() {
    local id="$1" fields
    ad_capture get --claude-instance-id "${id}"
    if (( AD_RC != 0 )); then
        if grep -qF ErrSpawnNotFound "${AD_OUT}" "${AD_ERR}"; then
            ROW_STATE=absent ROW_SID="" ROW_SESSION="" ROW_LABELS=""
            return 0
        fi
        fail "$2: the harness get of ${id} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fi
    fields="$(jq -r '[.state // "", .claude_session_id // "", .tmux_session_name // "", (.labels // {} | tojson)] | join("\u001f")' "${AD_OUT}")" \
        || fail "$2: the harness get of ${id} printed no row object: $(head -c 300 "${AD_OUT}")"
    IFS=$'\x1f' read -r ROW_STATE ROW_SID ROW_SESSION ROW_LABELS <<< "${fields}"
}

# row_of_reads <id> <step> <state>...: read row <id>; true when its state is
# one of the <state>s.
row_of_reads() {
    local id="$1" step="$2" s
    shift 2
    poll_row_of "${id}" "${step}"
    for s in "$@"; do
        [[ "${ROW_STATE}" == "${s}" ]] && return 0
    done
    return 1
}

# pane_history <step> <session> <file>: the whole pane of <session> (its
# history included) on the scenario's tmux server, read with the real tmux
# from the scenario's own shell, into <file>.
pane_history() {
    "${SCENARIO_REAL_TMUX}" capture-pane -p -S - -t "=$2:" > "$3" 2> "$3.err" \
        || fail "$1: tmux could not read the pane of session $2: $(head -c 300 "$3.err")"
}

# end_worker <id> <step>: row <id>'s worker is running (a plain stop leaves
# it so); end it with the stub's sentinel, sent into its pane with the real
# tmux, and wait until the row reads ended or missing.
end_worker() {
    poll_row_of "$1" "$2"
    [[ -n "${ROW_SESSION}" ]] || fail "$2: row $1 names no tmux session"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${ROW_SESSION}:" "${SENTINEL}" Enter \
        || fail "$2: could not send the sentinel into ${ROW_SESSION}"
    wait_until "${ENDED_WAIT_S}" "$2: row $1 never read ended or missing after the sentinel" \
        row_of_reads "$1" "$2" ended missing
}

# call_table <file>: write <file>, one TAB-separated line per agent-director
# shim `call` line whose parent is a CSCB process (`cscb_ad_calls`), in log
# order: its time, its PPID (the CSCB process), its verb, the row id its
# `--claude-instance-id` names (`-` when none) and its arguments joined by
# single spaces.
call_table() {
    local out="$1" line time id i
    : > "${out}"
    while IFS= read -r line; do
        _scenario_split_line "${line}" && _scenario_decode_words || fail "call_table: a shim log line does not parse: ${line}"
        _scenario_ad_verb
        time="${line#*$'\t'}"
        time="${time%%$'\t'*}"
        id=-
        for (( i = 0; i < ${#_L_ARGS[@]}; i++ )); do
            case "${_L_ARGS[i]}" in
                --claude-instance-id) id="${_L_ARGS[i + 1]:--}" ;;
                --claude-instance-id=*) id="${_L_ARGS[i]#*=}" ;;
            esac
        done
        printf '%s\t%s\t%s\t%s\t%s\n' "${time}" "${_L_PPID}" "${_L_VERB}" "${id}" "${_L_ARGS[*]}" >> "${out}"
    done < <(cscb_ad_calls "")
}

# calls <table> <ppid> <id> <verb> <from> <to> [<word>|!<word>]...: print the
# `call_table` lines whose PPID is <ppid> (`-` for any CSCB process), whose
# row is <id> (`-` for any), whose verb is <verb> (`-` for any), whose time is
# in (<from>, <to>] (`-` for no bound), whose arguments hold every <word> as a
# whole argument and no `!<word>`.
calls() {
    local table="$1" ppid="$2" id="$3" verb="$4" from="$5" to="$6"
    shift 6
    awk -F'\t' -v p="${ppid}" -v id="${id}" -v v="${verb}" -v a="${from}" -v b="${to}" -v w="$*" '
        BEGIN { n = split(w, want, " ") }
        (p == "-" || $2 == p) && (id == "-" || $4 == id) && (v == "-" || $3 == v) \
            && (a == "-" || $1 + 0 > a + 0) && (b == "-" || $1 + 0 <= b + 0) {
            m = split($5, args, " ")
            for (k in has) delete has[k]
            for (i = 1; i <= m; i++) has[args[i]] = 1
            ok = 1
            for (i = 1; i <= n; i++) {
                x = want[i]
                if (substr(x, 1, 1) == "!") { if (substr(x, 2) in has) ok = 0 }
                else if (!(x in has)) ok = 0
            }
            if (ok) print
        }' "${table}"
}

# count_calls <table> <ppid> <id> <verb> <from> <to> [<word>|!<word>]...: how
# many lines `calls` prints.
count_calls() {
    calls "$@" | wc -l | tr -d ' '
}

# first_call_at <table> <ppid> <id> <verb> <from> <to> [<word>|!<word>]...:
# the time of the first line `calls` prints (empty when none).
first_call_at() {
    calls "$@" | head -n 1 | cut -f1
}

# calls_by_verb <table> <ppid> <id> <from>: the bot server's calls of row
# <id> after <from>, counted by verb, on one line (recorded).
calls_by_verb() {
    calls "$1" "$2" "$3" - "$4" - | cut -f3 | sort | uniq -c | awk '{ printf "%s x%s; ", $2, $1 }'
}

# server_calls_of <id> <verb>: print the agent-director shim's `call` lines
# naming row <id> whose parent is the bot server (SERVER_PID) and whose verb
# is <verb> (`cscb_ad_calls`).
server_calls_of() {
    local lines=()
    mapfile -t lines < <(cscb_ad_calls "$2" "--claude-instance-id $1")
    (( ${#lines[@]} > 0 )) || return 0
    printf '%s\n' "${lines[@]}" | awk -F'\t' -v p="${SERVER_PID}" '$4 == p'
}

# approver_quiet_of <id>: true once the bot server's last pane read of row
# <id> (if any) is at least APPROVER_QUIET_S old.
approver_quiet_of() {
    local last
    last="$(server_calls_of "$1" read-pane | tail -n 1 | cut -f2)"
    [[ -z "${last}" ]] && return 0
    awk -v t="${last}" -v n="$(now_s)" -v q="${APPROVER_QUIET_S}" 'BEGIN { exit !(n - t >= q) }'
}

# log_hits <from-line> <fragment>...: print `<line number> TAB <time> TAB
# <text>` for each line of $SLACK_STATE_DIR/server.log after line
# <from-line> that holds every fixed-string <fragment> in order, <time> being
# the line's `[<ISO time>]` head (src/logging.ts) in epoch seconds, three
# decimals.
log_hits() {
    python3 - "${SLACK_STATE_DIR}/server.log" "$@" << 'EOF'
import datetime, sys
path, start, frags = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
try:
    lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
except FileNotFoundError:
    sys.exit(0)
for n, text in enumerate(lines, 1):
    if n <= start or not text.startswith("[") or "] " not in text:
        continue
    rest, ok = text, True
    for f in frags:
        p = rest.find(f)
        if p < 0:
            ok = False
            break
        rest = rest[p + len(f):]
    if not ok:
        continue
    head = text[1:text.index("] ")]
    try:
        t = datetime.datetime.strptime(head, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc).timestamp()
    except ValueError:
        continue
    print(f"{n}\t{t:.3f}\t{text}")
EOF
}

# log_texts_after <from-line>: print each server.log line after <from-line>
# with its `[<ISO time>] ` head removed.
log_texts_after() {
    [[ -f "${SLACK_STATE_DIR}/server.log" ]] || return 0
    tail -n "+$(( $1 + 1 ))" "${SLACK_STATE_DIR}/server.log" | sed 's/^\[[^]]*\] //'
}

# log_fragment_seen <from-line> <fragment>: true once server.log holds a line
# holding <fragment> after line <from-line>.
log_fragment_seen() {
    [[ -n "$(log_hits "$1" "$2")" ]]
}

# pre_trust_lines <from-line> <ref>: print `<verb> TAB <text>` for each
# server.log line after <from-line> that is a `pre_trust` line for <ref>:
# one equal to `preTrustLogLine` for <ref> and a launch verb with no field,
# or one starting with `preTrustLogLineHead` for <ref> and that verb.
pre_trust_lines() {
    local log0="$1" ref="$2" verb head absent text
    for verb in "${VERB_SPAWN}" "${VERB_RESUME}" "${VERB_REUSE_SPAWN}"; do
        head="$(fmk_text preTrustLogLineHead "${ref}" "${verb}")" || fail "pre_trust_lines: fmk-texts.ts could not print preTrustLogLineHead"
        absent="$(fmk_text preTrustLogLine "${ref}" "${verb}")" || fail "pre_trust_lines: fmk-texts.ts could not print preTrustLogLine"
        [[ -n "${head}" && -n "${absent}" ]] || fail "pre_trust_lines: fmk-texts.ts printed an empty pre_trust line"
        while IFS= read -r text; do
            if [[ "${text}" == "${absent}" || "${text}" == "${head}"* ]]; then
                printf '%s\t%s\n' "${verb}" "${text}"
            fi
        done < <(log_texts_after "${log0}")
    done
}

# expect_one_pre_trust_line <step> <from-line> <ref> <verb> <want>: the
# persona's only `pre_trust` line after <from-line> is for <verb> and equals
# <want>.
expect_one_pre_trust_line() {
    local step="$1" log0="$2" ref="$3" verb="$4" want="$5" lines=() n
    mapfile -t lines < <(pre_trust_lines "${log0}" "${ref}")
    (( ${#lines[@]} == 1 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} pre_trust line(s) for ${ref} from the start on, not one"
    }
    [[ "${lines[0]%%$'\t'*}" == "${verb}" ]] || fail "${step}: the pre_trust line for ${ref} is for a ${lines[0]%%$'\t'*}, not a ${verb}: ${lines[0]#*$'\t'}"
    n="$(log_texts_after "${log0}" | grep -cxF -- "${want}" || true)"
    (( n == 1 )) || fail "${step}: ${n} server.log line(s) equal to '${want}', not one (the pre_trust line is: ${lines[0]#*$'\t'})"
}

# wait_live <step> <id>: the row reads `waiting` with a claude_session_id
# (LIVE_SID) within REPORT_WAIT_S, and the approver has stopped reading its
# pane.
wait_live() {
    wait_until "${REPORT_WAIT_S}" "$1: row $2 never reported in (waiting)" row_of_reads "$2" "$1" waiting
    LIVE_SID="${ROW_SID}"
    [[ -n "${LIVE_SID}" ]] || fail "$1: the live row $2 has no claude_session_id"
    wait_until "${APPROVER_STOP_WAIT_S}" "$1: the bot server still reads the pane of $2 ${APPROVER_STOP_WAIT_S}s after it reported in" \
        approver_quiet_of "$2"
}

# expect_pane_read_before_send <step> <table> <srv> <id> <from>: every
# bot-server `send-keys` of row <id> with --allow-pending after <from>
# follows a bot-server `read-pane` of row <id> with --allow-pending made after
# <from>. Prints how many such `send-keys` there were.
expect_pane_read_before_send() {
    local step="$1" table="$2" srv="$3" id="$4" from="$5" t read_at
    local sends=()
    mapfile -t sends < <(calls "${table}" "${srv}" "${id}" send-keys "${from}" - "${ALLOW_PENDING_FLAG}" | cut -f1)
    for t in ${sends[@]+"${sends[@]}"}; do
        read_at="$(calls "${table}" "${srv}" "${id}" read-pane "${from}" - "${ALLOW_PENDING_FLAG}" \
            | awk -F'\t' -v t="${t}" '$1 + 0 < t + 0 { print $1; exit }')"
        [[ -n "${read_at}" ]] \
            || fail "${step}: a bot-server send-keys of ${id} with ${ALLOW_PENDING_FLAG} follows no bot-server read-pane of it with ${ALLOW_PENDING_FLAG}"
    done
    printf '%s\n' "${#sends[@]}"
}

# expect_launch_calls <step> <table> <srv> <id> <from> <spawns> <resumes>:
# the bot server made exactly <spawns> plain spawns (`-`: any number) and
# <resumes> `resume`s of row <id> after <from>, and no CSCB process made a
# reuse spawn or a `kill` of it.
expect_launch_calls() {
    local step="$1" table="$2" srv="$3" id="$4" from="$5" n
    n="$(count_calls "${table}" "${srv}" "${id}" spawn "${from}" - '!--reuse-finished')"
    [[ "$6" == - ]] || (( n == $6 )) || fail "${step}: the bot server made ${n} plain spawn(s) of ${id}, not $6"
    n="$(count_calls "${table}" "${srv}" "${id}" resume "${from}" -)"
    (( n == $7 )) || fail "${step}: the bot server made ${n} resume(s) of ${id}, not $7"
    n="$(count_calls "${table}" - "${id}" spawn "${from}" - --reuse-finished)"
    (( n == 0 )) || fail "${step}: ${n} reuse spawn(s) of ${id} by a CSCB process"
    n="$(count_calls "${table}" - "${id}" kill "${from}" -)"
    (( n == 0 )) || fail "${step}: ${n} kill(s) of ${id} by a CSCB process"
}

# pane_holds <file> <needle>: true when <file> holds <needle>.
pane_holds() {
    grep -qF -- "$2" "$1"
}

# ---------------------------------------------------------------------------
# Values from the installed package
# ---------------------------------------------------------------------------

DEV_NEEDLE="$(fmk_text DEV_CHANNELS_DIALOG_NEEDLE)" || fail "setup: fmk-texts.ts could not print DEV_CHANNELS_DIALOG_NEEDLE"
TRUST_NEEDLE="$(fmk_text TRUST_DIALOG_NEEDLE)" || fail "setup: fmk-texts.ts could not print TRUST_DIALOG_NEEDLE"
PACE_MS="$(fmk_text DIALOG_POLL_INTERVAL_MS)" || fail "setup: fmk-texts.ts could not print DIALOG_POLL_INTERVAL_MS"
PRE_TRUST_PREFIX="$(fmk_text PRE_TRUST_LOG_PREFIX)" || fail "setup: fmk-texts.ts could not print PRE_TRUST_LOG_PREFIX"
VERB_SPAWN="$(fmk_text LAUNCH_VERB_SPAWN)" || fail "setup: fmk-texts.ts could not print LAUNCH_VERB_SPAWN"
VERB_RESUME="$(fmk_text LAUNCH_VERB_RESUME)" || fail "setup: fmk-texts.ts could not print LAUNCH_VERB_RESUME"
VERB_REUSE_SPAWN="$(fmk_text LAUNCH_VERB_REUSE_SPAWN)" || fail "setup: fmk-texts.ts could not print LAUNCH_VERB_REUSE_SPAWN"
A_ID="$(fmk_text personaInstanceId "${A_KEY}")" || fail "setup: fmk-texts.ts could not print personaInstanceId for A"
B_ID="$(fmk_text personaInstanceId "${B_KEY}")" || fail "setup: fmk-texts.ts could not print personaInstanceId for B"
C_ID="$(fmk_text personaInstanceId "${C_KEY}")" || fail "setup: fmk-texts.ts could not print personaInstanceId for C"
A_SESSION="$(fmk_text personaTmuxSessionName "${A_KEY}")" || fail "setup: fmk-texts.ts could not print personaTmuxSessionName for A"
for v in DEV_NEEDLE TRUST_NEEDLE PRE_TRUST_PREFIX VERB_SPAWN VERB_RESUME VERB_REUSE_SPAWN A_ID B_ID C_ID A_SESSION; do
    [[ -n "${!v}" ]] || fail "setup: fmk-texts.ts printed an empty ${v}"
done
[[ "${PACE_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the approver's pace '${PACE_MS}' is not a whole number of milliseconds"
# Three approver laps' worth of time, in whole seconds (at least one).
APPROVER_QUIET_S=$(( (3 * PACE_MS + 999) / 1000 ))

# Every pre_trust line starts with the prefix (a self-check of the entries).
for v in "${VERB_SPAWN}" "${VERB_RESUME}"; do
    line="$(fmk_text preTrustLogLine "${A_REF}" "${v}" "${PRE_TRUST_OK}")" || fail "setup: fmk-texts.ts could not print preTrustLogLine"
    [[ "${line}" == "${PRE_TRUST_PREFIX}"* ]] || fail "setup: preTrustLogLine '${line}' does not start with PRE_TRUST_LOG_PREFIX '${PRE_TRUST_PREFIX}'"
done

# ---------------------------------------------------------------------------
# The migrated-row leg: a row seeded on 0.10.0, migrated, then resumed
# ---------------------------------------------------------------------------

leg_migrated_row() {
    local step="migrated row" creds="${SCENARIO_ROOT}/credentials-migrated" creds_file work out labels=() labels_json
    local sid srv log0 leg_start table="${SCENARIO_ROOT}/migrated-calls.tsv" lines=() value="" v want resume_at sends
    local pane="${SCENARIO_ROOT}/pane-migrated.txt" prompt_shown

    work="$(make_workdir migrated)"
    mapfile -t labels < <(fmk_text personaDefaultConfigDirLabels "${A_KEY}" "${HOME}")
    (( ${#labels[@]} == 3 )) || fail "${step}: fmk-texts.ts printed ${#labels[@]} label(s) for A, not three"
    labels_json="$(printf '%s\n' "${labels[@]}" | jq -R -s -c 'split("\n") | map(select(length > 0) | capture("^(?<k>[^=]+)=(?<v>.*)$")) | map({(.k): .v}) | add')"

    # Step 1 [harness]: A's row, made by 0.10.0's own spawn, with a stub worker.
    out="$(seed_010_row "${A_ID}" "${A_SESSION}" "${work}" "${labels[@]}")"
    echo "${TEST_NAME}: ${step}: seeded on 0.10.0: ${out}"

    # Step 2 [harness]: the worker ends on 0.10.0; the row keeps its session id.
    end_worker "${A_ID}" "${step}: the 0.10.0 worker"
    sid="${ROW_SID}"
    [[ -n "${sid}" ]] || fail "${step}: the ${ROW_STATE} 0.10.0 row has no claude_session_id"
    echo "${TEST_NAME}: ${step}: on 0.10.0 the row reads ${ROW_STATE} with claude_session_id ${sid}"

    # Step 3 [harness]: the release's install over 0.10.0 (the migration), and the shim checks.
    install_ad_release "${step}: the release's install over 0.10.0"
    check_ad_shim "${step}: the agent-director shim after the install"
    check_ad_admin_shim "${step}: the agent-director-admin shim after the install"
    cmp -s -- "${HOME}/.agent-director/bin/agent-director.real" "${SCENARIO_RELEASE_BIN}" \
        || fail "${step}: the binary behind the shim is not the release's ${SCENARIO_RELEASE_BIN}"
    out="$(ad_store_id)"
    echo "${TEST_NAME}: ${step}: the migrated store's id ${out}"
    poll_row_of "${A_ID}" "${step}: the migrated row"
    [[ "${ROW_STATE}" == ended || "${ROW_STATE}" == missing ]] || fail "${step}: the migrated row reads ${ROW_STATE}, not ended or missing"
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the migrated row's claude_session_id is '${ROW_SID}', not ${sid}"
    [[ "${ROW_SESSION}" == "${A_SESSION}" ]] || fail "${step}: the migrated row's session name is '${ROW_SESSION}', not ${A_SESSION}"
    jq -e --argjson want "${labels_json}" '. == $want' <<< "${ROW_LABELS}" > /dev/null \
        || fail "${step}: the migrated row's labels are ${ROW_LABELS}, not ${labels_json}"
    echo "${TEST_NAME}: ${step}: after the release's install the row reads ${ROW_STATE}, claude_session_id ${ROW_SID}, labels ${ROW_LABELS}"

    # Step 4 [harness]: the folder-trust mode in A's directory.
    stub_mode "${work}" "${STUB_MODE_FOLDER_TRUST}"
    echo "${TEST_NAME}: ${step}: before the resume, ~/.claude.json (recorded): $([[ -e "${HOME}/.claude.json" ]] && echo "present: $(head -c 300 "${HOME}/.claude.json")" || echo absent)"

    # Step 5: the live start resumes A.
    new_state_dir migrated
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-migrated" "${A_SUFFIX}"
    creds_file="$(write_credentials "${creds}" "${A_SUFFIX}")"
    write_personas_config "$(persona_json "${A_NAME}" "${creds_file}" "${work}" "${A_CHANNEL}")"
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    leg_start="$(now_s)"
    start_server --live
    srv="${SERVER_PID}"
    wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "${step}: the start pass never completed"
    wait_live "${step}: the resume" "${A_ID}"
    [[ "${LIVE_SID}" == "${sid}" ]] || fail "${step}: the resumed row's claude_session_id is '${LIVE_SID}', not the kept ${sid}"
    echo "${TEST_NAME}: ${step}: the resumed row reads waiting with claude_session_id ${LIVE_SID}"

    # Step 6: the checks.
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the start pass's summary (recorded): $(log_hits "${log0}" "$(completion_match 1)" | tail -n 1 | cut -f3)"
    echo "${TEST_NAME}: ${step}: the collision line (recorded): $(log_hits "${log0}" "[slack] spawnForPersona: collision resolved, state=" "${A_REF}" | cut -f3 | cut -c1-240 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${A_ID}, by verb (recorded): $(calls_by_verb "${table}" "${srv}" "${A_ID}" "${leg_start}")"

    # Exactly one pre_trust line for A's resume, equal to the builder's for one value.
    mapfile -t lines < <(pre_trust_lines "${log0}" "${A_REF}")
    (( ${#lines[@]} == 1 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} pre_trust line(s) for A from the start on, not one"
    }
    [[ "${lines[0]%%$'\t'*}" == "${VERB_RESUME}" ]] \
        || fail "${step}: A's pre_trust line is for a ${lines[0]%%$'\t'*}, not a ${VERB_RESUME}: ${lines[0]#*$'\t'}"
    for v in "${PRE_TRUST_OK}" "${PRE_TRUST_SKIPPED}" "${PRE_TRUST_FAILED}" ""; do
        if [[ -n "${v}" ]]; then
            want="$(fmk_text preTrustLogLine "${A_REF}" "${VERB_RESUME}" "${v}")" || fail "${step}: fmk-texts.ts could not print preTrustLogLine"
        else
            want="$(fmk_text preTrustLogLine "${A_REF}" "${VERB_RESUME}")" || fail "${step}: fmk-texts.ts could not print preTrustLogLine"
        fi
        if [[ "${lines[0]#*$'\t'}" == "${want}" ]]; then
            value="${v:-absent}"
            break
        fi
    done
    [[ -n "${value}" ]] || fail "${step}: A's pre_trust line equals the builder's line for none of ${PRE_TRUST_OK}, ${PRE_TRUST_SKIPPED}, ${PRE_TRUST_FAILED} or no field: ${lines[0]#*$'\t'}"
    echo "${TEST_NAME}: ${step}: the migrated row's resume reported pre_trust ${value}: ${lines[0]#*$'\t'}"
    if [[ "${value}" != "${PRE_TRUST_OK}" && "${value}" != "${PRE_TRUST_FAILED}" ]]; then
        # Ruling S8: A-22 expects ok or failed; another value is reported, not failed on.
        echo "REPORT: ${TEST_NAME}: ${step}: the migrated row's resume reported pre_trust ${value}, not ${PRE_TRUST_OK} or ${PRE_TRUST_FAILED} (A-22)"
    fi

    # The launch calls: the one resume, no reuse spawn and no kill.
    expect_launch_calls "${step}" "${table}" "${srv}" "${A_ID}" "${leg_start}" - 1
    resume_at="$(first_call_at "${table}" "${srv}" "${A_ID}" resume "${leg_start}" -)"

    # Each approver send-keys with --allow-pending follows its read-pane with --allow-pending.
    sends="$(expect_pane_read_before_send "${step}" "${table}" "${srv}" "${A_ID}" "${resume_at}")" || exit 1
    pane_history "${step}" "${A_SESSION}" "${pane}"
    prompt_shown=no
    pane_holds "${pane}" "${TRUST_NEEDLE}" && prompt_shown=yes
    echo "${TEST_NAME}: ${step}: the folder-trust prompt on the migrated row's resume (recorded): shown ${prompt_shown}; the approver's send-keys with ${ALLOW_PENDING_FLAG}: ${sends}; bot-server read-pane with ${ALLOW_PENDING_FLAG}: $(count_calls "${table}" "${srv}" "${A_ID}" read-pane "${resume_at}" - "${ALLOW_PENDING_FLAG}")"
    echo "${TEST_NAME}: ${step}: the server registered A's MCP session (recorded): $(log_fragment_seen "${log0}" "[slack] Session connected: persona ${A_REF}" && echo yes || echo no)"
    echo "${TEST_NAME}: ${step}: after the resume, ~/.claude.json (recorded): $([[ -e "${HOME}/.claude.json" ]] && echo "present: $(head -c 300 "${HOME}/.claude.json")" || echo absent)"

    stop_server
    end_worker "${A_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

# ---------------------------------------------------------------------------
# The new-persona legs: B's spawn reports ok; C's fresh claude_config_dir
# reports failed, and the approver clears the folder-trust prompt
# ---------------------------------------------------------------------------

legs_new_personas() {
    local step="new personas" creds="${SCENARIO_ROOT}/credentials-new" b_work c_work c_config="${SCENARIO_ROOT}/claude-config-fresh"
    local b_creds c_creds srv log0 leg_start table="${SCENARIO_ROOT}/new-calls.tsv" want sends spawn_at b_sid c_sid
    local b_pane="${SCENARIO_ROOT}/pane-spawned.txt" c_pane="${SCENARIO_ROOT}/pane-configdir.txt" b_session c_session

    b_work="$(make_workdir spawned)"
    c_work="$(make_workdir configdir)"

    # Step 1 [harness]: B's resolved .claude.json exists; C's claude_config_dir is fresh.
    if [[ -e "${HOME}/.claude.json" ]]; then
        echo "${TEST_NAME}: ${step}: B's resolved ~/.claude.json was already there (recorded): $(head -c 300 "${HOME}/.claude.json")"
    else
        printf '{}\n' | write_file "${HOME}/.claude.json"
        echo "${TEST_NAME}: ${step}: B's resolved ~/.claude.json was absent; the harness wrote {} there"
    fi
    [[ -f "${HOME}/.claude.json" ]] || fail "${step}: B's resolved ${HOME}/.claude.json is not a file"
    [[ ! -e "${c_config}" ]] || fail "${step}: C's claude_config_dir ${c_config} already exists"
    mkdir -m 700 "${c_config}" || fail "${step}: could not create C's claude_config_dir ${c_config}"
    [[ ! -e "${c_config}/.claude.json" ]] || fail "${step}: C's fresh claude_config_dir holds a .claude.json"

    # Step 2 [harness]: the folder-trust mode in both directories.
    stub_mode "${b_work}" "${STUB_MODE_FOLDER_TRUST}"
    stub_mode "${c_work}" "${STUB_MODE_FOLDER_TRUST}"

    # Step 3: the live start spawns both.
    new_state_dir new
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-new" "${B_SUFFIX}" "${C_SUFFIX}"
    b_creds="$(write_credentials "${creds}" "${B_SUFFIX}")"
    c_creds="$(write_credentials "${creds}" "${C_SUFFIX}")"
    write_personas_config "$(persona_json "${B_NAME}" "${b_creds}" "${b_work}" "${B_CHANNEL}")" \
        "$(persona_json "${C_NAME}" "${c_creds}" "${c_work}" "${C_CHANNEL}" "${c_config}")"
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    leg_start="$(now_s)"
    start_server --live
    srv="${SERVER_PID}"
    wait_for_log "$(completion_match 2)" "${START_WAIT_S}" "${step}: the start pass never completed"

    # Step 4: both rows report in, the server registers both sessions, and the approver stops.
    wait_live "${step}: B's spawn" "${B_ID}"
    b_sid="${LIVE_SID}" b_session="${ROW_SESSION}"
    wait_live "${step}: C's spawn" "${C_ID}"
    c_sid="${LIVE_SID}" c_session="${ROW_SESSION}"
    [[ -n "${b_session}" && -n "${c_session}" ]] || fail "${step}: a live row names no tmux session"
    wait_until "${CONNECT_WAIT_S}" "${step}: the server never registered B's session" \
        log_fragment_seen "${log0}" "[slack] Session connected: persona ${B_REF}"
    wait_until "${CONNECT_WAIT_S}" "${step}: the server never registered C's session" \
        log_fragment_seen "${log0}" "[slack] Session connected: persona ${C_REF}"
    echo "${TEST_NAME}: ${step}: B reads waiting (claude_session_id ${b_sid}), C reads waiting (claude_session_id ${c_sid})"

    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the start pass's summary (recorded): $(log_hits "${log0}" "$(completion_match 2)" | tail -n 1 | cut -f3)"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${B_ID}, by verb (recorded): $(calls_by_verb "${table}" "${srv}" "${B_ID}" "${leg_start}")"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${C_ID}, by verb (recorded): $(calls_by_verb "${table}" "${srv}" "${C_ID}" "${leg_start}")"

    # Step 5: B's checks.
    want="$(fmk_text preTrustLogLine "${B_REF}" "${VERB_SPAWN}" "${PRE_TRUST_OK}")" || fail "${step}: fmk-texts.ts could not print preTrustLogLine for B"
    expect_one_pre_trust_line "${step}: B" "${log0}" "${B_REF}" "${VERB_SPAWN}" "${want}"
    expect_launch_calls "${step}: B" "${table}" "${srv}" "${B_ID}" "${leg_start}" 1 0
    echo "${TEST_NAME}: ${step}: B's spawn reported pre_trust ${PRE_TRUST_OK}: ${want}"
    pane_history "${step}: B" "${b_session}" "${b_pane}"
    echo "${TEST_NAME}: ${step}: B's folder-trust prompt (recorded): shown $(pane_holds "${b_pane}" "${TRUST_NEEDLE}" && echo yes || echo no); the approver's send-keys with ${ALLOW_PENDING_FLAG}: $(count_calls "${table}" "${srv}" "${B_ID}" send-keys "${leg_start}" - "${ALLOW_PENDING_FLAG}"); B's trust entry in ~/.claude.json: $(jq -c --arg d "$(realpath -e -- "${b_work}")" '.projects[$d] // "none"' "${HOME}/.claude.json" 2> /dev/null || echo unreadable)"

    # Step 6: C's checks.
    want="$(fmk_text preTrustLogLine "${C_REF}" "${VERB_SPAWN}" "${PRE_TRUST_FAILED}")" || fail "${step}: fmk-texts.ts could not print preTrustLogLine for C"
    expect_one_pre_trust_line "${step}: C" "${log0}" "${C_REF}" "${VERB_SPAWN}" "${want}"
    expect_launch_calls "${step}: C" "${table}" "${srv}" "${C_ID}" "${leg_start}" 1 0
    echo "${TEST_NAME}: ${step}: C's spawn reported pre_trust ${PRE_TRUST_FAILED}: ${want}"
    spawn_at="$(first_call_at "${table}" "${srv}" "${C_ID}" spawn "${leg_start}" -)"
    sends="$(expect_pane_read_before_send "${step}: C" "${table}" "${srv}" "${C_ID}" "${spawn_at}")" || exit 1
    (( sends >= 1 )) || fail "${step}: no bot-server send-keys of ${C_ID} with ${ALLOW_PENDING_FLAG}: the approver never answered C's folder-trust prompt"
    pane_history "${step}: C" "${c_session}" "${c_pane}"
    pane_holds "${c_pane}" "${TRUST_NEEDLE}" || fail "${step}: C's pane never showed the folder-trust prompt ('${TRUST_NEEDLE}')"
    ! pane_holds "${c_pane}" "${DEV_NEEDLE}" || fail "${step}: C's pane shows the dev-channels dialog ('${DEV_NEEDLE}')"
    echo "${TEST_NAME}: ${step}: C's folder-trust prompt was answered by the approver: ${sends} send-keys with ${ALLOW_PENDING_FLAG}, the first at +$(awk -v a="${spawn_at}" -v b="$(first_call_at "${table}" "${srv}" "${C_ID}" send-keys "${spawn_at}" - "${ALLOW_PENDING_FLAG}")" 'BEGIN { printf "%.3f", b - a }')s from the spawn"
    echo "${TEST_NAME}: ${step}: C's claude_config_dir after the launch (recorded): .claude.json $([[ -e "${c_config}/.claude.json" ]] && echo present || echo absent)"

    stop_server
    end_worker "${B_ID}" "${step}: B's end"
    end_worker "${C_ID}" "${step}: C's end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

# ---------------------------------------------------------------------------
# The script-wide check: no launch opts out of pre-trust
# ---------------------------------------------------------------------------

check_no_pre_trust_opt_out() {
    local step="no pre-trust opt-out" table="${SCENARIO_ROOT}/all-calls.tsv" n launches
    call_table "${table}"
    launches="$(awk -F'\t' '$3 == "spawn" || $3 == "resume"' "${table}")"
    n="$(grep -c . <<< "${launches}" || true)"
    (( $(count_calls "${table}" - - spawn - -) >= 1 && $(count_calls "${table}" - - resume - -) >= 1 )) \
        || fail "${step}: the shim log holds no CSCB-parented spawn and resume to check (${n} launch call(s))"
    n="$(cut -f5 <<< "${launches}" | grep -cE -- "(^| )${NO_PRE_TRUST_FLAG}(=[^ ]*)?( |$)" || true)"
    (( n == 0 )) || {
        grep -E -- "(^| )${NO_PRE_TRUST_FLAG}(=[^ ]*)?( |$)" <<< "${launches}" | sed 's/^/  | /' >&2
        fail "${step}: ${n} CSCB-parented spawn or resume call(s) carry ${NO_PRE_TRUST_FLAG}"
    }
    echo "${TEST_NAME}: ${step}: $(grep -c . <<< "${launches}") CSCB-parented spawn and resume call(s), none with ${NO_PRE_TRUST_FLAG}"
}

leg_migrated_row
legs_new_personas
check_no_pre_trust_opt_out

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "${TEST_NAME}: PASS"
