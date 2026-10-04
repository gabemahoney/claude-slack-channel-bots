#!/usr/bin/env bash
# Test 10 (t3.ob2.5e.u7.bp; E13, E14 director decisions 1, 13 and 14): a
# credentials-file change is previewed and applied on confirmation, against
# the loopback Slack stub, outside dry run.
#
# Dry run compares no credentials digest (src/reload-plan.ts), so this is a
# live start (`start_server --live`). Real Slack is unreachable in the
# container: the Slack stub (fixtures/slack-stub-server.ts) answers instead,
# through CSCB_SLACK_API_URL (src/persona-slack-clients.ts, honoured only for
# a literal loopback URL; the server logs only its origin). A live start also
# launches each persona through the real agent-director:
# fixtures/stub-claude.sh is first on PATH as `claude` (as Test 4 arranges),
# the working dirs come from `make_workdir` (the start's trust patch covers
# them), the health check is off (`health_check_interval: 0`, so no restart
# chases the stub's missing MCP session) and `exit_timeout` is 5 s
# (stub-claude ignores the `/exit` that `stop --stop-bots` sends, so the stop
# escalates to a kill after 5 s).
#
# Steps:
# 1. Start with two personas, each with its own credentials file (mode 0600,
#    fake tokens built at runtime). Both are brought up: one `persona-start`
#    line each, no unreachable/refused/credentials line, the start pass ends
#    with `0 not brought up`, and the stub recorded each persona's own
#    auth.test and apps.connections.open (by token hash) and a WebSocket.
#    The dialog approver runs after the launch returns, so the start pass
#    does not wait for the launched claude's SessionStart: within
#    TRANSCRIPT_WAIT_S of the start pass's end each working dir gets a
#    transcript, and every transcript in it carries stub-claude's session
#    marker, so the launched `claude` was the stub.
# 2. Rewrite alpha's credentials file with a new token pair. The preview
#    (config.json.pending and `reload-preview` lines) names alpha's
#    credentials file only; for a full tick nothing connects with the new
#    pair and the record is kept. Renaming the pending file to
#    config.json.apply confirms it: `reload-applied`, alpha's reconnect line,
#    exactly one new auth.test and apps.connections.open with the new pair,
#    the old socket closed, bravo untouched, no persona brought up afresh,
#    and config.json.last-applied rewritten.
# 3. Handshake failure (decision 13): the stub's control maps a third alpha
#    pair to `closed-port` (a wss:// URL whose ticket holds a marker built
#    here, to a loopback port nothing listens on). Rotating to it and
#    confirming gives a real Bun WebSocket handshake failure: one
#    `persona-slack-unreachable` line and the "current one stays in use"
#    line; the reconnect retries twice more, failing the same way, with no
#    second unreachable line; server.log never shows the marker, `ticket=` or
#    `wss://`. Any `[slack] persona Socket Mode:` line is one of the
#    allowlisted health lines.
# 4. Refused change: the stub refuses a new bravo bot token (`invalid_auth`).
#    Confirming logs `persona-credentials-change-failed`, bravo keeps its
#    connection, and the change is pending again.
# Leak checks throughout: no token-like text and no issued token in
# server.log, the pending and last-applied files, the stub's record and
# output, or the CLI's output; and no Slack API call sent token-like text in
# an argument other than its token (the stub's `args_token_like`, since the
# stub redacts `text` before recording it).
#
# Lines are matched by class prefix, persona ref and distinguishing fragments
# (E14 decision 14; lib/scenario.sh "Matchers"), each quoted from src/ (see
# the "Expected text" block). Waits are bounded: the reload tick runs 5 s
# after the previous pass (src/reload-timer.ts), a reconnect retries after
# 5 s (doubling). An exit hook (on pass and on failure) kills the personas'
# tmux sessions and removes stub-claude's transcripts; agent-director rows
# are left to the ephemeral container (decision 14). The helper's EXIT trap
# stops the server (with --stop-bots) and the stub and removes the scratch
# root. Expected runtime: about 2 minutes (the two launches and their dialog
# approvals dominate; every bound together allows ~17).
set -euo pipefail

TEST_NAME="test-10-credentials-change"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

FIXTURES="$(realpath "$(dirname "$0")")/fixtures"

# --- Bounds (seconds) ------------------------------------------------------
STUB_WAIT_S=20     # the stub writing its ready file
START_WAIT_S=150   # the start pass: two bring-ups and two launches
TRANSCRIPT_WAIT_S=60  # after the start pass: a persona's dialog approval and SessionStart
TICK_WAIT_S=30    # a change showing up in config.json.pending
APPLY_WAIT_S=45    # a confirmation applied (tick + reconnect bounds)
RECORD_WAIT_S=15   # a line reaching the stub's record
RETRY_WAIT_S=30    # a failed reconnect's next retry (5 s, then 10 s, after a failure)
HOLD_S=7           # an unconfirmed change watched for more than one tick

# --- Prerequisites ---------------------------------------------------------
for tool in bun tmux agent-director jq sha256sum realpath; do
    command -v "${tool}" > /dev/null 2>&1 || fail "${tool} not on PATH (base image prerequisite)"
done
for fixture in slack-stub-server.ts stub-claude.sh; do
    [[ -f "${FIXTURES}/${fixture}" ]] || fail "fixture ${FIXTURES}/${fixture} missing"
done

# --- Stub `claude` first on PATH (the daemon's launches inherit it) --------
STUB_BIN="${SCENARIO_ROOT}/bin"
mkdir -p "${STUB_BIN}"
cp "${FIXTURES}/stub-claude.sh" "${STUB_BIN}/claude"
chmod +x "${STUB_BIN}/claude"
export PATH="${STUB_BIN}:${PATH}"
[[ "$(command -v claude)" == "${STUB_BIN}/claude" ]] \
    || fail "PATH does not resolve claude to the stub ${STUB_BIN}/claude"

# --- Names and paths -------------------------------------------------------
CONFIG="${SLACK_STATE_DIR}/config.json"
PENDING="${CONFIG}.pending"
APPLY="${CONFIG}.apply"
LAST="${CONFIG}.last-applied"

ALPHA="${SCENARIO_TAG}_alpha"
BRAVO="${SCENARIO_TAG}_bravo"
ALPHA_KEY="$(persona_key "${ALPHA}")"
BRAVO_KEY="$(persona_key "${BRAVO}")"
ALPHA_REF="$(persona_ref "${ALPHA}")"
BRAVO_REF="$(persona_ref "${BRAVO}")"

CH_TAG="${SCENARIO_TAG^^}"
A1="C0${CH_TAG}A1"
B1="C0${CH_TAG}B1"

ALPHA_DIR="$(make_workdir alpha)"
BRAVO_DIR="$(make_workdir bravo)"

CREDS_DIR="${SCENARIO_ROOT}/credentials"
mkdir -m 700 "${CREDS_DIR}"
ALPHA_CREDS="${CREDS_DIR}/alpha.json"
BRAVO_CREDS="${CREDS_DIR}/bravo.json"

STUB_DIR="${SCENARIO_ROOT}/stub"
mkdir -p "${STUB_DIR}"
STUB_RECORD="${STUB_DIR}/record.jsonl"
STUB_CONTROL="${STUB_DIR}/control.json"
STUB_READY="${STUB_DIR}/ready.json"
STUB_OUT="${STUB_DIR}/stub.out"

# The handshake-failure leg's ticket marker: built here, at runtime, and
# found nowhere in the repo.
MARKER="${SCENARIO_TAG}tkt$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
[[ "${MARKER}" =~ ^${SCENARIO_TAG}tkt[0-9a-f]{16}$ ]] || fail "could not build the ticket marker"

# stub-claude's transcripts: ~/.claude/projects/<real working dir with / . _
# as -> (fixtures/stub-claude.sh). Both working dirs are under the scratch
# root, so the names are this run's own.
transcript_dir() {
    printf '%s/.claude/projects/%s\n' "${HOME:?}" "$(realpath "$1" | sed 's#[/._]#-#g')"
}
ROOT_KEY="$(realpath "${SCENARIO_ROOT}" | sed 's#[/._]#-#g')"
ALPHA_TRANSCRIPTS="$(transcript_dir "${ALPHA_DIR}")"
BRAVO_TRANSCRIPTS="$(transcript_dir "${BRAVO_DIR}")"
for dir in "${ALPHA_TRANSCRIPTS}" "${BRAVO_TRANSCRIPTS}"; do
    [[ -n "${ROOT_KEY}" && "$(basename "${dir}")" == "${ROOT_KEY}"-work-* ]] \
        || fail "transcript directory name ${dir} is not under the scratch root's"
done
# The summary line stub-claude writes into every transcript it creates
# (fixtures/stub-claude.sh ensure_transcript).
STUB_SESSION_MARKER='"summary":"stub-claude session"'

# --- Expected text (fragments quoted from src/) ----------------------------
# src/persona-slack-clients.ts resolveSlackApiUrlOverride: the origin only.
OVERRIDE_CLASS='[slack] Slack API base URL override in use: '
OVERRIDE_IGNORED='[slack] Warning: CSCB_SLACK_API_URL ignored'
# src/session-manager.ts startupSessionManager
STARTUP_COMPLETE="$(completion_match 2)"
# src/persona-bringup-controller.ts bringUp through
# src/persona-diagnostics.ts formatPersonaDiagnostic
ALPHA_START="$(persona_start_match 0 "${ALPHA}")"
BRAVO_START="$(persona_start_match 1 "${BRAVO}")"
# src/persona-diagnostics.ts class labels; any of these at start means a
# persona did not come up with its credentials.
BAD_START_CLASSES=(
    persona-slack-unreachable
    persona-credentials-refused
    persona-credentials-missing
    persona-credentials-unreadable
    persona-credentials-invalid
)
# src/reload-plan.ts renderPreviewLines (modifiedLine, credentialsEffect) /
# renderPreviewLogLines: a persona's credentials line names the persona and
# the file; the header carries the counts and the pending file's path.
PREVIEW='[slack] reload-preview: '
credentials_body() {
    local ref
    ref="$(persona_ref "$1")" || exit 1
    matcher "persona ${ref}:" "credentials file \"$2\" changed"
}
ALPHA_BODY="$(credentials_body "${ALPHA}" "${ALPHA_CREDS}")"
BRAVO_BODY="$(credentials_body "${BRAVO}" "${BRAVO_CREDS}")"
ALPHA_BODY_LOG="$(matcher "${PREVIEW}" "${ALPHA_BODY}")"
header_m="$(preview_header_match credentials=1)"
PREVIEW_HEADER_LOG="$(matcher "${header_m}" "\"${PENDING}\"")"
DESTRUCTIVE='DESTRUCTIVE:'
# src/reload-apply.ts renderAppliedLogLine
APPLIED_CLASS='[slack] reload-applied:'
APPLIED_CREDENTIALS="$(applied_match credentials=1)"
# src/persona-lifecycle.ts runReconnectCredentials
ALPHA_RECONNECTED="$(matcher "[slack] persona ${ALPHA_REF}:" 'reconnected with its changed credentials')"
BRAVO_RECONNECTED="$(matcher "[slack] persona ${BRAVO_REF}:" 'reconnected with its changed credentials')"
ALPHA_KEPT="$(matcher "[slack] persona ${ALPHA_REF}:" 'cannot reach Slack yet' 'current one stays in use')"
# src/persona-slack-validation.ts unreachable() (check socket-mode) through
# src/persona-slack-episodes.ts
ALPHA_UNREACHABLE="$(matcher "[slack] persona-slack-unreachable: personas[0] ${ALPHA_REF}" \
    "path=\"${ALPHA_CREDS}\"" 'app_token' 'the Socket Mode open')"
# src/persona-diagnostics.ts formatCredentialsChangeFailed, with the refused
# cause of src/persona-slack-validation.ts refused() (auth.test)
BRAVO_CHANGE_FAILED="$(matcher "[slack] persona-credentials-change-failed: personas[1] ${BRAVO_REF}" \
    "path=\"${BRAVO_CREDS}\"" 'bot_token' 'auth.test' 'invalid_auth')"
# src/persona-slack-clients.ts socketModeSlackLogger (prefix) and
# SOCKET_HEALTH_LINES (the only texts it forwards): a negative check, so any
# other library text reaching server.log fails it.
SOCKET_MODE_PREFIX='[slack] persona Socket Mode: '
SOCKET_MODE_ALLOWED="\\[slack\\] persona Socket Mode: personas\\[[0-9]+\\] \"[^\"]*\" \\(key=[a-z0-9_]+\\): (A (ping|pong) wasn't received from the server before the timeout of [0-9]+ms!|Failed to send ping to Slack)$"

# --- Helpers ---------------------------------------------------------------

# Every token this script wrote into a credentials file, for the exact-value
# leak check. Never printed.
ISSUED_TOKENS=()
# "<bot|app>:<suffix>" -> the first 12 hex digits of the token's SHA-256,
# which is what the stub records instead of the token.
declare -A TOKEN_HASH=()

sha12() {
    sha256sum | cut -c1-12
}

# Write <path> with a fresh bot/app pair whose values end in <suffix> (the
# stub's control maps the suffix to a label), mode 0600, atomically.
write_credentials() {
    local path="$1" suffix="$2" bot app
    bot="$(fake_token bot "${suffix}")"
    app="$(fake_token app "${suffix}")"
    ISSUED_TOKENS+=("${bot}" "${app}")
    TOKEN_HASH["bot:${suffix}"]="$(printf '%s' "${bot}" | sha12)"
    TOKEN_HASH["app:${suffix}"]="$(printf '%s' "${app}" | sha12)"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "${bot}" "${app}" | write_file "${path}" 600
    [[ "$(stat -c '%a' "${path}")" == "600" ]] || fail "credentials file ${path} is not mode 0600"
}

# The stub's control file from entries "<suffix>|<label>|<auth>|<connections>|<ticket>"
# (empty fields omitted). An unmatched token is refused, so a stray token
# shows up as a failure, never as a silent success.
write_control() {
    python3 - "$@" << 'EOF' | write_file "${STUB_CONTROL}"
import json, sys
tokens = []
for spec in sys.argv[1:]:
    suffix, label, auth, connections, ticket = spec.split("|")
    entry = {"suffix": suffix, "label": label}
    for key, value in (("auth", auth), ("connections", connections), ("ticket", ticket)):
        if value:
            entry[key] = value
    tokens.append(entry)
print(json.dumps({"tokens": tokens, "default": {"auth": "invalid_auth", "connections": "invalid_auth"}}))
EOF
}

# The labels of the control the stub has in force (GET /_control re-reads the
# file first), one per line.
stub_labels() {
    curl -s --max-time 5 "http://127.0.0.1:${STUB_PORT}/_control" \
        | python3 -c 'import json, sys; print("\n".join(json.load(sys.stdin).get("labels", [])))' 2> /dev/null || true
}

stub_has_label() {
    stub_labels | grep -qxF -- "$1"
}

# Count the stub's record lines whose fields match every <field>=<value>
# (string compare; a JSON true/false reads True/False) or <field>^=<prefix>.
RECORD_QUERY="${SCENARIO_ROOT}/record-query.py"
cat > "${RECORD_QUERY}" << 'EOF'
import json, sys
path, *specs = sys.argv[1:]
checks = []
for spec in specs:
    if "^=" in spec:
        key, value = spec.split("^=", 1)
        checks.append((key, value, True))
    else:
        key, value = spec.split("=", 1)
        checks.append((key, value, False))
count = 0
try:
    with open(path) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            ok = True
            for key, value, prefix in checks:
                field = rec.get(key)
                text = "" if field is None else str(field)
                if (prefix and not text.startswith(value)) or (not prefix and (field is None or text != value)):
                    ok = False
                    break
            if ok:
                count += 1
except FileNotFoundError:
    pass
print(count)
EOF

rec_count() {
    python3 "${RECORD_QUERY}" "${STUB_RECORD}" "$@"
}

rec_at_least() {
    local min="$1"; shift
    (( $(rec_count "$@") >= min ))
}

rec_none() {
    (( $(rec_count "$@") == 0 ))
}

# Wait until the record holds at least <min> lines matching the filters.
wait_for_record() {
    local min="$1" step="$2"; shift 2
    wait_until "${RECORD_WAIT_S}" "${step}" rec_at_least "${min}" "$@"
}

expect_record_count() {
    local want="$1" step="$2" got; shift 2
    got="$(rec_count "$@")"
    [[ "${got}" == "${want}" ]] || fail "${step} (stub record: ${got} matching line(s), expected ${want})"
}

inode_of() {
    stat -c '%i' "$1"
}

# Every file the leak checks read: the state dir (server.log and its
# rotations, the reload files, startup-errors.log, ...), the stub's record
# and output, and the CLI's output. Not the credentials files.
leak_files() {
    find "${SLACK_STATE_DIR}" "${STUB_DIR}" -type f -print
    find "${SCENARIO_ROOT}" -maxdepth 1 -type f \( -name 'start.*.out' -o -name 'stop.out' \) -print
}

# How many lines of <file>... hold an issued token (never prints one).
count_issued_tokens() {
    local file total=0 n
    (( ${#ISSUED_TOKENS[@]} > 0 )) || { echo 0; return 0; }
    for file in "$@"; do
        [[ -f "${file}" ]] || continue
        n="$(grep -cF -f <(printf '%s\n' "${ISSUED_TOKENS[@]}") -- "${file}" || true)"
        total=$(( total + n ))
    done
    echo "${total}"
}

check_no_leak() {
    local step="$1" files=() n api clean
    mapfile -t files < <(leak_files)
    n="$(count_token_like "${files[@]}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} token-like match(es) in the server log, reload files, stub record or CLI output"
    n="$(count_issued_tokens "${files[@]}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} line(s) holding an issued token in the server log, reload files, stub record or CLI output"
    # The stub redacts `text` before recording it, so the counts above cannot
    # see a token sent to Slack: every recorded call must say it sent none
    # outside its token (and carry the flag at all).
    api="$(rec_count event=api)"
    clean="$(rec_count event=api args_token_like=False)"
    [[ "${api}" == "${clean}" ]] \
        || fail "${step}: $(( api - clean )) of ${api} Slack API call(s) in the stub record sent token-like text outside the token (or lack args_token_like)"
}

# server.log (and rotations) lines holding <fixed-string>.
count_server_log() {
    local log total=0 n
    for log in "${SLACK_STATE_DIR}"/server.log*; do
        [[ -f "${log}" ]] || continue
        n="$(grep -cF -- "$1" "${log}" || true)"
        total=$(( total + n ))
    done
    echo "${total}"
}

# Any Socket Mode library line that reached server.log is an allowlisted
# health line (src/persona-slack-clients.ts SOCKET_HEALTH_LINES).
check_socket_mode_lines() {
    local step="$1" log n
    for log in "${SLACK_STATE_DIR}"/server.log*; do
        [[ -f "${log}" ]] || continue
        n="$({ grep -F -- "${SOCKET_MODE_PREFIX}" "${log}" || true; } | { grep -cvE -- "${SOCKET_MODE_ALLOWED}" || true; })"
        [[ "${n}" == 0 ]] || fail "${step}: ${n} Socket Mode library line(s) in server.log outside the allowlisted health lines"
    done
}

# The start's persona set, unchanged by a credentials change: one
# persona-start line each, no destructive line.
check_no_fresh_bringup() {
    local step="$1"
    expect_count "${ALPHA_START}" 1 "${step}: persona-start lines for ${ALPHA}"
    expect_count "${BRAVO_START}" 1 "${step}: persona-start lines for ${BRAVO}"
    expect_count "${DESTRUCTIVE}" 0 "${step}: DESTRUCTIVE lines"
}

# Bravo keeps its one connection: its first pair's calls only, no close.
check_bravo_untouched() {
    local step="$1"
    expect_record_count 1 "${step}: bravo's auth.test count changed" \
        event=api method=auth.test label=bravo-v1
    expect_record_count 1 "${step}: bravo's apps.connections.open count changed" \
        event=api method=apps.connections.open label=bravo-v1
    expect_record_count 0 "${step}: bravo's WebSocket was closed" event=ws-close label=bravo-v1
    expect_count "${BRAVO_RECONNECTED}" 0 "${step}: reconnect lines for ${BRAVO}"
}

no_new_alpha_pair_seen() {
    rec_none 'label^=alpha-v2'
}

# True when <dir> holds a non-empty transcript (stub-claude writes its one
# line in a single write, so a non-empty file is a whole one).
has_transcript() {
    local f
    for f in "$1"/*.jsonl; do
        [[ -s "${f}" ]] && return 0
    done
    return 1
}

# True when <dir> holds at least one transcript and every transcript in it
# carries stub-claude's session marker.
stub_transcripts_only() {
    local dir="$1" f n=0
    for f in "${dir}"/*.jsonl; do
        [[ -f "${f}" ]] || continue
        n=$(( n + 1 ))
        grep -qF -- "${STUB_SESSION_MARKER}" "${f}" || return 1
    done
    (( n > 0 ))
}

# Exit hook (on pass and on failure, after the trap's stop --stop-bots): kill
# each persona's tmux session by name (src/persona-identity.ts
# personaTmuxSessionName: slack_bot_<key>; agent-director's kill does not
# always reap it, b.vub), and remove the stub-claude transcript dirs. A dir
# holding anything but stub-claude's transcripts is left in place and fails
# the hook. No agent-director row is deleted (decision 14).
cleanup_launches() {
    local key dir rc=0
    for key in "${ALPHA_KEY}" "${BRAVO_KEY}"; do
        tmux kill-session -t "=slack_bot_${key}" > /dev/null 2>&1 || true
        if tmux has-session -t "=slack_bot_${key}" > /dev/null 2>&1; then
            echo "  | cleanup: tmux session slack_bot_${key} is still running" >&2
            rc=1
        fi
    done
    for dir in "${ALPHA_TRANSCRIPTS}" "${BRAVO_TRANSCRIPTS}"; do
        [[ -e "${dir}" ]] || continue
        if stub_transcripts_only "${dir}"; then
            rm -rf -- "${dir}"
        else
            echo "  | cleanup: ${dir} holds no stub-claude transcript or another one; left in place" >&2
            rc=1
        fi
    done
    return "${rc}"
}
on_exit cleanup_launches

# --- Stub ------------------------------------------------------------------
write_control \
    "alphav1|alpha-v1|ok|ok|" \
    "bravov1|bravo-v1|ok|ok|" \
    "alphav2|alpha-v2|ok|ok|"

(cd "${STUB_DIR}" && exec bun "${FIXTURES}/slack-stub-server.ts" \
    --record "${STUB_RECORD}" --control "${STUB_CONTROL}" --ready-file "${STUB_READY}") \
    > "${STUB_OUT}" 2>&1 &
STUB_PID=$!
track_pid "${STUB_PID}"

wait_for_file "${STUB_READY}" "${STUB_WAIT_S}" "the Slack stub never wrote its ready file"
ready_field() {
    python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "${STUB_READY}" "$1"
}
STUB_API_URL="$(ready_field api_url)"
STUB_PORT="$(ready_field port)"
[[ "$(ready_field pid)" == "${STUB_PID}" ]] || fail "the stub's ready file names another PID"
STUB_ORIGIN="http://127.0.0.1:${STUB_PORT}"
[[ "${STUB_PORT}" =~ ^[0-9]+$ && "${STUB_API_URL}" == "${STUB_ORIGIN}/api/" ]] \
    || fail "the stub's api_url is not http://127.0.0.1:<port>/api/"
wait_until 10 "the stub never loaded the control file's labels" stub_has_label alpha-v1

export CSCB_SLACK_API_URL="${STUB_API_URL}"

# --- 1. Start: both personas up with their own credentials ----------------
write_credentials "${ALPHA_CREDS}" alphav1
write_credentials "${BRAVO_CREDS}" bravov1

write_config << EOF
{
  "personas": [
    {
      "name": "${ALPHA}",
      "credentials_file": "${ALPHA_CREDS}",
      "working_directory": "${ALPHA_DIR}",
      "channels": [{ "id": "${A1}", "delivery": "all" }],
      "permission_prompts": "${A1}"
    },
    {
      "name": "${BRAVO}",
      "credentials_file": "${BRAVO_CREDS}",
      "working_directory": "${BRAVO_DIR}",
      "channels": [{ "id": "${B1}", "delivery": "all" }],
      "permission_prompts": "${B1}"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "exit_timeout": 5
}
EOF

start_server --live
# The override line names the stub's origin (a space follows it), never the
# /api/ path.
wait_for_log "$(matcher "${OVERRIDE_CLASS}" "${STUB_ORIGIN} " 'CSCB_SLACK_API_URL')" 30 \
    "start: the Slack API base URL override line was not logged with the stub's origin"
expect_count "$(matcher "${OVERRIDE_CLASS}" "${STUB_ORIGIN}/")" 0 \
    "start: override lines showing more than the URL's origin"
expect_count "${OVERRIDE_IGNORED}" 0 "start: lines ignoring the Slack API base URL override"
wait_for_log "${STARTUP_COMPLETE}" "${START_WAIT_S}" "start: the start pass never completed"
expect_completion 2 "start" "0 not brought up"
expect_count "${ALPHA_START}" 1 "start: persona-start lines for ${ALPHA}"
expect_count "${BRAVO_START}" 1 "start: persona-start lines for ${BRAVO}"
for class in "${BAD_START_CLASSES[@]}"; do
    expect_count "[slack] ${class}:" 0 "start: ${class} lines"
done

# Each persona validated and connected with its own pair (E3/E4 identity).
for who in alpha bravo; do
    wait_for_record 1 "start: no ok auth.test with ${who}'s bot token" \
        event=api method=auth.test label="${who}-v1" answer=ok token_kind=bot \
        token_hash="${TOKEN_HASH[bot:${who}v1]}"
    wait_for_record 1 "start: no ok apps.connections.open with ${who}'s app token" \
        event=api method=apps.connections.open label="${who}-v1" answer=ok token_kind=app \
        token_hash="${TOKEN_HASH[app:${who}v1]}"
    wait_for_record 1 "start: no WebSocket opened for ${who}" event=ws-open label="${who}-v1"
    expect_record_count 1 "start: ${who} called auth.test more than once" \
        event=api method=auth.test label="${who}-v1"
done
expect_record_count 0 "start: a call with an unlabelled token" event=api 'label^=unlabelled-'
expect_record_count 0 "start: a call without a token" event=api label=no-token

# The launched `claude` was stub-claude: each working dir gets its transcript
# once the dialog approver's Enter fires SessionStart. The approver runs
# after the launch returns, so the start pass does not wait for it: wait here.
for dir in "${ALPHA_TRANSCRIPTS}" "${BRAVO_TRANSCRIPTS}"; do
    wait_until "${TRANSCRIPT_WAIT_S}" \
        "start: no transcript in ${dir}: the launched claude did not write one" \
        has_transcript "${dir}"
    stub_transcripts_only "${dir}" \
        || fail "start: ${dir} holds no transcript with stub-claude's session marker: the launched claude was not the stub"
done

[[ -f "${LAST}" ]] || fail "start: config.json.last-applied was not written"
cmp -s "${CONFIG}" "${LAST}" || fail "start: config.json.last-applied does not hold config.json's bytes"
[[ ! -e "${PENDING}" ]] || fail "start: config.json.pending exists with no change made"
check_no_leak "start"

# --- 2. Alpha's credentials change: previewed, held, confirmed -------------
last_inode="$(inode_of "${LAST}")"
applied_before="$(count_log "${APPLIED_CLASS}")"

write_credentials "${ALPHA_CREDS}" alphav2

wait_for_file "${PENDING}" "${TICK_WAIT_S}" "alpha rotation: config.json.pending never appeared"
wait_until 10 "alpha rotation: the pending file never named alpha's credentials change" \
    pending_has_line "${ALPHA_BODY}"
check_pending_layout "alpha rotation" credentials=1
if grep -qF -- "${BRAVO_REF}" "${PENDING}"; then
    fail "alpha rotation: the pending file names persona ${BRAVO}"
fi
wait_for_log "${PREVIEW_HEADER_LOG}" 10 "alpha rotation: the reload-preview header was not logged"
wait_for_log "${ALPHA_BODY_LOG}" 10 "alpha rotation: the reload-preview line for ${ALPHA} was not logged"
expect_count "${PREVIEW}persona ${BRAVO_REF}" 0 "alpha rotation: reload-preview lines naming ${BRAVO}"
check_no_leak "alpha rotation preview"

# Unconfirmed, for more than a full tick: the record keeps its inode and
# bytes, no reload-applied line, and the stub sees nothing of the new pair.
hold_not_applied "${HOLD_S}" "alpha rotation unconfirmed" no_new_alpha_pair_seen

mv -f -- "${PENDING}" "${APPLY}"
wait_for_count "${APPLIED_CLASS}" $(( applied_before + 1 )) "${APPLY_WAIT_S}" \
    "alpha rotation: the confirmation was never applied"
wait_for_log "${APPLIED_CREDENTIALS}" 5 "alpha rotation: the reload-applied line lacks '$(counts credentials=1)' or the record path"
wait_for_log "${ALPHA_RECONNECTED}" 10 "alpha rotation: persona ${ALPHA} never reconnected"

wait_for_record 1 "alpha rotation: no ok auth.test with alpha's new bot token" \
    event=api method=auth.test label=alpha-v2 answer=ok token_kind=bot \
    token_hash="${TOKEN_HASH[bot:alphav2]}"
wait_for_record 1 "alpha rotation: no ok apps.connections.open with alpha's new app token" \
    event=api method=apps.connections.open label=alpha-v2 answer=ok token_kind=app \
    token_hash="${TOKEN_HASH[app:alphav2]}"
wait_for_record 1 "alpha rotation: no WebSocket opened with alpha's new pair" event=ws-open label=alpha-v2
wait_for_record 1 "alpha rotation: alpha's old WebSocket was never closed" event=ws-close label=alpha-v1
expect_record_count 1 "alpha rotation: more than one auth.test with alpha's new pair" \
    event=api method=auth.test label=alpha-v2
expect_record_count 1 "alpha rotation: more than one apps.connections.open with alpha's new pair" \
    event=api method=apps.connections.open label=alpha-v2
check_bravo_untouched "alpha rotation"
check_no_fresh_bringup "alpha rotation"
expect_count "[slack] persona-slack-unreachable:" 0 "alpha rotation: persona-slack-unreachable lines"
expect_count "[slack] persona-credentials-change-failed:" 0 "alpha rotation: persona-credentials-change-failed lines"

[[ "$(inode_of "${LAST}")" != "${last_inode}" ]] \
    || fail "alpha rotation: config.json.last-applied was not rewritten by the apply"
cmp -s "${CONFIG}" "${LAST}" || fail "alpha rotation: config.json.last-applied does not hold config.json's bytes"
[[ ! -e "${APPLY}" ]] || fail "alpha rotation: config.json.apply was not removed"
[[ ! -e "${PENDING}" ]] || fail "alpha rotation: config.json.pending is still there after the apply"
check_no_leak "alpha rotation applied"

# --- 3. Handshake failure (decision 13) ------------------------------------
write_control \
    "alphav1|alpha-v1|ok|ok|" \
    "bravov1|bravo-v1|ok|ok|" \
    "alphav2|alpha-v2|ok|ok|" \
    "alphav3|alpha-v3|ok|closed-port|${MARKER}" \
    "bravov2|bravo-v2|invalid_auth|ok|"
wait_until 10 "handshake leg: the stub never loaded the closed-port control" stub_has_label alpha-v3

applied_before="$(count_log "${APPLIED_CLASS}")"
unreachable_before="$(count_log "${ALPHA_UNREACHABLE}")"

write_credentials "${ALPHA_CREDS}" alphav3
wait_for_file "${PENDING}" "${TICK_WAIT_S}" "handshake leg: config.json.pending never appeared"
wait_until 10 "handshake leg: the pending file never named alpha's credentials change" \
    pending_has_line "${ALPHA_BODY}"
check_pending_layout "handshake leg" credentials=1

mv -f -- "${PENDING}" "${APPLY}"
wait_for_count "${APPLIED_CLASS}" $(( applied_before + 1 )) "${APPLY_WAIT_S}" \
    "handshake leg: the confirmation was never applied"
wait_for_count "${ALPHA_UNREACHABLE}" $(( unreachable_before + 1 )) 20 \
    "handshake leg: no persona-slack-unreachable line for ${ALPHA}'s failed handshake"
wait_for_log "${ALPHA_KEPT}" 10 "handshake leg: the 'current one stays in use' line for ${ALPHA} was not logged"

# The stub handed out the marker-bearing wss:// URL and no WebSocket opened.
wait_for_record 1 "handshake leg: no closed-port apps.connections.open with alpha's third pair" \
    event=api method=apps.connections.open label=alpha-v3 answer=closed-port \
    token_hash="${TOKEN_HASH[app:alphav3]}" "ticket^=${MARKER}"
# The reconnect retries 5 s after the failure, then 10 s after that retry
# fails. The third attempt is scheduled only once the second failed, so by
# the time the stub records it the second attempt's failure was handled: the
# unreachable count read then covers that retry.
wait_until "${RETRY_WAIT_S}" "handshake leg: the failed reconnect never retried" \
    rec_at_least 2 event=api method=apps.connections.open label=alpha-v3 answer=closed-port
wait_until "${RETRY_WAIT_S}" "handshake leg: the failed reconnect never retried a second time" \
    rec_at_least 3 event=api method=apps.connections.open label=alpha-v3 answer=closed-port
expect_record_count 0 "handshake leg: a WebSocket opened for alpha's third pair" event=ws-open label=alpha-v3
expect_record_count 0 "handshake leg: alpha's current WebSocket was closed" event=ws-close label=alpha-v2
expect_count "${ALPHA_UNREACHABLE}" $(( unreachable_before + 1 )) \
    "handshake leg: persona-slack-unreachable lines for ${ALPHA} after its retries (one per episode)"
expect_count "[slack] persona-credentials-refused:" 0 "handshake leg: persona-credentials-refused lines"
expect_count "[slack] persona-connection-lost:" 0 "handshake leg: persona-connection-lost lines"
check_bravo_untouched "handshake leg"
check_no_fresh_bringup "handshake leg"

for needle in "${MARKER}" 'ticket=' 'wss://'; do
    n="$(count_server_log "${needle}")"
    [[ "${n}" == 0 ]] || fail "handshake leg: server.log shows '${needle}' (${n} line(s)): a connection URL leaked"
done
check_socket_mode_lines "handshake leg"
check_no_leak "handshake leg"

# --- 4. A change Slack refuses stays pending --------------------------------
applied_before="$(count_log "${APPLIED_CLASS}")"

write_credentials "${BRAVO_CREDS}" bravov2
wait_for_file "${PENDING}" "${TICK_WAIT_S}" "refused change: config.json.pending never appeared"
wait_until 10 "refused change: the pending file never named bravo's credentials change" \
    pending_has_line "${BRAVO_BODY}"
check_pending_layout "refused change" credentials=1
if grep -qF -- "${ALPHA_REF}" "${PENDING}"; then
    fail "refused change: the pending file names persona ${ALPHA}, whose retrying change was already applied"
fi

mv -f -- "${PENDING}" "${APPLY}"
wait_for_log "${BRAVO_CHANGE_FAILED}" "${APPLY_WAIT_S}" \
    "refused change: the persona-credentials-change-failed line for ${BRAVO} was not logged"
wait_for_count "${APPLIED_CLASS}" $(( applied_before + 1 )) 10 "refused change: the confirmation pass never ended"
wait_for_file "${PENDING}" "${TICK_WAIT_S}" "refused change: the change is not pending again"
wait_until 10 "refused change: the renewed pending file does not name bravo's change" \
    pending_has_line "${BRAVO_BODY}"

expect_record_count 1 "refused change: no refused auth.test with bravo's new bot token" \
    event=api method=auth.test label=bravo-v2 answer=invalid_auth token_hash="${TOKEN_HASH[bot:bravov2]}"
expect_record_count 0 "refused change: bravo's new app token was used" \
    event=api method=apps.connections.open label=bravo-v2
check_bravo_untouched "refused change"
check_no_fresh_bringup "refused change"
check_no_leak "refused change"

# --- Stop ------------------------------------------------------------------
stop_server --stop-bots

stop_tracked_pid "${STUB_PID}" 10 "the Slack stub did not exit on SIGTERM"
expect_record_count 1 "the Slack stub did not record its stop" event=stop

for needle in "${MARKER}" 'ticket=' 'wss://'; do
    n="$(count_server_log "${needle}")"
    [[ "${n}" == 0 ]] || fail "after stop: server.log shows '${needle}' (${n} line(s))"
done
check_socket_mode_lines "after stop"
check_no_leak "after stop"

# The tmux sessions and stub-claude's transcripts go in the exit hook
# (cleanup_launches), which runs on a failure too.
echo "PASS: ${TEST_NAME}"
