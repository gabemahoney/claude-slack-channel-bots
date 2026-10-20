#!/usr/bin/env bash
# AD pre-trust diagnostics for migrated resume, fresh spawn and custom config dir.
# Keep pre_trust logging and no-opt-out coverage; startup UI is never answered.

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
# (`absent` for ErrSpawnNotFound), ROW_SID (session_id), ROW_SESSION
# (tmux_session_name) and ROW_LABELS (labels, compact JSON), each empty when
# absent.
# Deliberate pre-0.12 result contract: this reader straddles the install migration.
poll_row_of() {
    local id="$1" fields
    ad_capture get "${SCENARIO_AD_ID_FLAG}" "${id}"
    if (( AD_RC != 0 )); then
        if grep -qF ErrSpawnNotFound "${AD_OUT}" "${AD_ERR}"; then
            ROW_STATE=absent ROW_SID="" ROW_SESSION="" ROW_LABELS=""
            return 0
        fi
        fail "$2: the harness get of ${id} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fi
    fields="$(jq -r --arg key "${SCENARIO_AD_SESSION_KEY}" '[.state // "", .[$key] // "", .tmux_session_name // "", (.labels // {} | tojson)] | join("\u001f")' "${AD_OUT}")" \
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
# `--instance-id` names (`-` when none) and its arguments joined by
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
                --instance-id) id="${_L_ARGS[i + 1]:--}" ;;
                --instance-id=*) id="${_L_ARGS[i]#*=}" ;;
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
# the time of the first line `calls` prints (empty when none). `sed -n 1p`
# reads all its input, so `calls` never meets a closed pipe under pipefail.
first_call_at() {
    calls "$@" | sed -n 1p | cut -f1
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
    mapfile -t lines < <(cscb_ad_calls "$2" "--instance-id $1")
    (( ${#lines[@]} > 0 )) || return 0
    printf '%s\n' "${lines[@]}" | awk -F'\t' -v p="${SERVER_PID}" '$4 == p'
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

wait_live() {
    wait_until "${REPORT_WAIT_S}" "$1: row $2 never reported in (waiting)" row_of_reads "$2" "$1" waiting
    LIVE_SID="${ROW_SID}"
    [[ -n "${LIVE_SID}" ]] || fail "$1: the live row $2 has no session_id"

}

# expect_pane_read_before_send <step> <table> <srv> <id> <from>: every
# bot-server `send-keys` of row <id> with --allow-pending after <from>
# follows a bot-server `read-pane` of row <id> with --allow-pending made after
# <from>. Prints how many such `send-keys` there were.

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

# A pre-trust result is diagnostic only: CSCB neither reads nor answers startup UI.
expect_no_startup_keys() {
    local step="$1" table="$2" srv="$3" id="$4" from="$5" n verb
    for verb in read-pane send-keys; do
        n="$(count_calls "${table}" "${srv}" "${id}" "${verb}" "${from}" -)"
        (( n == 0 )) || fail "${step}: ${n} automatic startup ${verb} call(s) of ${id}"
    done
}

# ---------------------------------------------------------------------------
# Values from the installed package
# ---------------------------------------------------------------------------

VERB_SPAWN="$(fmk_text LAUNCH_VERB_SPAWN)" || fail "setup: fmk-texts.ts could not print LAUNCH_VERB_SPAWN"
VERB_RESUME="$(fmk_text LAUNCH_VERB_RESUME)" || fail "setup: fmk-texts.ts could not print LAUNCH_VERB_RESUME"
VERB_REUSE_SPAWN="$(fmk_text LAUNCH_VERB_REUSE_SPAWN)" || fail "setup: fmk-texts.ts could not print LAUNCH_VERB_REUSE_SPAWN"
A_ID="$(fmk_text personaInstanceId "${A_KEY}")" || fail "setup: fmk-texts.ts could not print personaInstanceId for A"
B_ID="$(fmk_text personaInstanceId "${B_KEY}")" || fail "setup: fmk-texts.ts could not print personaInstanceId for B"
C_ID="$(fmk_text personaInstanceId "${C_KEY}")" || fail "setup: fmk-texts.ts could not print personaInstanceId for C"
A_SESSION="$(fmk_text personaTmuxSessionName "${A_KEY}")" || fail "setup: fmk-texts.ts could not print personaTmuxSessionName for A"
for v in VERB_SPAWN VERB_RESUME VERB_REUSE_SPAWN A_ID B_ID C_ID A_SESSION; do
    [[ -n "${!v}" ]] || fail "setup: fmk-texts.ts printed an empty ${v}"
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
    (( ${#labels[@]} == 4 )) || fail "${step}: fmk-texts.ts printed ${#labels[@]} label(s) for A, not four"
    labels_json="$(printf '%s\n' "${labels[@]}" | jq -R -s -c 'split("\n") | map(select(length > 0) | capture("^(?<k>[^=]+)=(?<v>.*)$")) | map({(.k): .v}) | add')"

    # Step 1 [harness]: A's row, made by 0.10.0's own spawn, with a stub worker.
    out="$(seed_010_row "${A_ID}" "${A_SESSION}" "${work}" "${labels[@]}")"
    echo "${TEST_NAME}: ${step}: seeded on 0.10.0: ${out}"

    # Step 2 [harness]: the worker ends on 0.10.0; the row keeps its session id.
    end_worker "${A_ID}" "${step}: the 0.10.0 worker"
    sid="${ROW_SID}"
    [[ -n "${sid}" ]] || fail "${step}: the ${ROW_STATE} 0.10.0 row has no session_id"
    echo "${TEST_NAME}: ${step}: on 0.10.0 the row reads ${ROW_STATE} with session_id ${sid}"

    # Step 3 [harness]: the release's install over 0.10.0 (the migration), and the shim checks.
    install_ad_release "${step}: the release's install over 0.10.0"
    check_ad_shim "${step}: the agent-director shim after the install"
    check_ad_admin_shim "${step}: the agent-director-admin shim after the install"
    cmp -s -- "${SCENARIO_AD_ROOT}/bin/agent-director.real" "${SCENARIO_RELEASE_BIN}" \
        || fail "${step}: the binary behind the shim is not the release's ${SCENARIO_RELEASE_BIN}"
    out="$(ad_store_id)"
    echo "${TEST_NAME}: ${step}: the migrated store's id ${out}"
    poll_row_of "${A_ID}" "${step}: the migrated row"
    [[ "${ROW_STATE}" == ended || "${ROW_STATE}" == missing ]] || fail "${step}: the migrated row reads ${ROW_STATE}, not ended or missing"
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the migrated row's session_id is '${ROW_SID}', not ${sid}"
    [[ "${ROW_SESSION}" == "${A_SESSION}" ]] || fail "${step}: the migrated row's session name is '${ROW_SESSION}', not ${A_SESSION}"
    jq -e --argjson want "${labels_json}" '. == $want' <<< "${ROW_LABELS}" > /dev/null \
        || fail "${step}: the migrated row's labels are ${ROW_LABELS}, not ${labels_json}"
    echo "${TEST_NAME}: ${step}: after the release's install the row reads ${ROW_STATE}, session_id ${ROW_SID}, labels ${ROW_LABELS}"

    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"
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
    [[ "${LIVE_SID}" == "${sid}" ]] || fail "${step}: the resumed row's session_id is '${LIVE_SID}', not the kept ${sid}"
    echo "${TEST_NAME}: ${step}: the resumed row reads waiting with session_id ${LIVE_SID}"

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

    expect_no_startup_keys "${step}" "${table}" "${srv}" "${A_ID}" "${resume_at}"
    echo "${TEST_NAME}: ${step}: the server registered A's MCP session (recorded): $(log_fragment_seen "${log0}" "[slack] Session connected: persona ${A_REF}" && echo yes || echo no)"
    echo "${TEST_NAME}: ${step}: after the resume, ~/.claude.json (recorded): $([[ -e "${HOME}/.claude.json" ]] && echo "present: $(head -c 300 "${HOME}/.claude.json")" || echo absent)"

    stop_server
    end_worker "${A_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}


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
        require_scenario_home "${step}"
        printf '{}\n' | write_file "${HOME}/.claude.json"
        echo "${TEST_NAME}: ${step}: B's resolved ~/.claude.json was absent; the harness wrote {} there"
    fi
    [[ -f "${HOME}/.claude.json" ]] || fail "${step}: B's resolved ${HOME}/.claude.json is not a file"
    [[ ! -e "${c_config}" ]] || fail "${step}: C's claude_config_dir ${c_config} already exists"
    mkdir -m 700 "${c_config}" || fail "${step}: could not create C's claude_config_dir ${c_config}"
    [[ ! -e "${c_config}/.claude.json" ]] || fail "${step}: C's fresh claude_config_dir holds a .claude.json"

    stub_mode "${b_work}" "${STUB_MODE_AT_ONCE}"
    stub_mode "${c_work}" "${STUB_MODE_AT_ONCE}"

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

    wait_live "${step}: B's spawn" "${B_ID}"
    b_sid="${LIVE_SID}" b_session="${ROW_SESSION}"
    wait_live "${step}: C's spawn" "${C_ID}"
    c_sid="${LIVE_SID}" c_session="${ROW_SESSION}"
    [[ -n "${b_session}" && -n "${c_session}" ]] || fail "${step}: a live row names no tmux session"
    wait_until "${CONNECT_WAIT_S}" "${step}: the server never registered B's session" \
        log_fragment_seen "${log0}" "[slack] Session connected: persona ${B_REF}"
    wait_until "${CONNECT_WAIT_S}" "${step}: the server never registered C's session" \
        log_fragment_seen "${log0}" "[slack] Session connected: persona ${C_REF}"
    echo "${TEST_NAME}: ${step}: B reads waiting (session_id ${b_sid}), C reads waiting (session_id ${c_sid})"

    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the start pass's summary (recorded): $(log_hits "${log0}" "$(completion_match 2)" | tail -n 1 | cut -f3)"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${B_ID}, by verb (recorded): $(calls_by_verb "${table}" "${srv}" "${B_ID}" "${leg_start}")"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${C_ID}, by verb (recorded): $(calls_by_verb "${table}" "${srv}" "${C_ID}" "${leg_start}")"

    # Step 5: B's checks.
    want="$(fmk_text preTrustLogLine "${B_REF}" "${VERB_SPAWN}" "${PRE_TRUST_OK}")" || fail "${step}: fmk-texts.ts could not print preTrustLogLine for B"
    expect_one_pre_trust_line "${step}: B" "${log0}" "${B_REF}" "${VERB_SPAWN}" "${want}"
    expect_launch_calls "${step}: B" "${table}" "${srv}" "${B_ID}" "${leg_start}" 1 0
    echo "${TEST_NAME}: ${step}: B's spawn reported pre_trust ${PRE_TRUST_OK}: ${want}"
    expect_no_startup_keys "${step}: B" "${table}" "${srv}" "${B_ID}" "${leg_start}"

    # Step 6: C's checks.
    want="$(fmk_text preTrustLogLine "${C_REF}" "${VERB_SPAWN}" "${PRE_TRUST_FAILED}")" || fail "${step}: fmk-texts.ts could not print preTrustLogLine for C"
    expect_one_pre_trust_line "${step}: C" "${log0}" "${C_REF}" "${VERB_SPAWN}" "${want}"
    expect_launch_calls "${step}: C" "${table}" "${srv}" "${C_ID}" "${leg_start}" 1 0
    echo "${TEST_NAME}: ${step}: C's spawn reported pre_trust ${PRE_TRUST_FAILED}: ${want}"
    spawn_at="$(first_call_at "${table}" "${srv}" "${C_ID}" spawn "${leg_start}" -)"
    expect_no_startup_keys "${step}: C" "${table}" "${srv}" "${C_ID}" "${spawn_at}"
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
