#!/usr/bin/env bash
# perm-stub-claude.sh — the filter regression's fake `claude` (installed as
# bin/claude in its scratch HOME; filter-regression.ts drives it).
#
# It runs agent-director's own hooks from the --settings agent-director gave
# it, each as a direct child, so the candidate's process identity checks hold:
#   1. at launch: SessionStart (the row reports in and reads waiting);
#   2. once <stub dir>/fire-permission exists: PermissionRequest, in the
#      background, so the relay hook records the request and polls for a
#      verdict (the row reads check_permission);
#   3. once <stub dir>/kill-hook exists: SIGKILL to that relay hook, reaped,
#      then <stub dir>/hook-killed holds the time in epoch milliseconds. No
#      answer reached the agent, so the request falls back, as when Claude
#      Code ends a relay hook; the agent's own prompt stays unanswered.
# It then fires no other hook (nothing proves the dialog gone) and holds the
# pane until stdin closes. It draws no dialog and nothing reads its pane.
set -uo pipefail

if [[ "${1:-}" == --version || "${1:-}" == -v ]]; then
    printf '%s\n' '2.1.280 (Claude Code)'
    exit 0
fi

SETTINGS_JSON=""
RESUME_SID=""
prev=""
for arg in "$@"; do
    case "${prev}" in
        --settings) SETTINGS_JSON="${arg}" ;;
        --resume) RESUME_SID="${arg}" ;;
    esac
    prev="${arg}"
done

STUB_DIR="${BASH_SOURCE[0]%/*}"
[[ "${STUB_DIR}" == "${BASH_SOURCE[0]}" ]] && STUB_DIR=.
LOG="${STUB_DIR}/perm-stub.log"
log() { printf '%s [%s] %s\n' "$(date -u +%H:%M:%S.%3N)" "$$" "$*" >> "${LOG}"; }

SESSION_ID="${RESUME_SID:-$(cat /proc/sys/kernel/random/uuid)}"
REALCWD="$(pwd -P)"
PROJ_DIR="${HOME}/.claude/projects/$(printf '%s' "${REALCWD}" | sed 's#[/._]#-#g')"
TRANSCRIPT="${PROJ_DIR}/${SESSION_ID}.jsonl"
mkdir -p "${PROJ_DIR}"
[[ -f "${TRANSCRIPT}" ]] || printf '{"type":"summary","summary":"ad-gate permission stub","leafUuid":"%s"}\n' \
    "${SESSION_ID}" > "${TRANSCRIPT}"

# hook_argv <event>: the first "command" entry registered for the event, as
# NUL-terminated argv elements.
# shellcheck disable=SC2016 # $s and $ev are jq variables.
HOOK_ARGV_JQ='
  first($s | .hooks? | objects | .[$ev] | arrays | .[] | objects | .hooks | arrays | .[]
        | objects | select(.type == "command" and (.command | type) == "string")
        | if (.args | type) == "array" then [.command] + [.args[] | tostring]
          else [.command | splits("[ \t\n]+") | select(length > 0)] end
        | select(length > 0))
  | map(. + "\u0000") | join("")
'
hook_argv() {
    jq -nj --argjson s "${SETTINGS_JSON:-null}" --arg ev "$1" "${HOOK_ARGV_JQ}" 2>> "${LOG}"
}
START_HOOK=()
PERM_HOOK=()
mapfile -d '' -t START_HOOK < <(hook_argv SessionStart)
mapfile -d '' -t PERM_HOOK < <(hook_argv PermissionRequest)
log "launched in ${REALCWD}, session ${SESSION_ID}, instance ${AGENT_DIRECTOR_INSTANCE_ID:-unset}, relay ${AGENT_DIRECTOR_RELAY_MODE:-unset}"
log "SessionStart hook: ${START_HOOK[*]:-none}; PermissionRequest hook: ${PERM_HOOK[*]:-none}"

PAYLOAD_DIR="${STUB_DIR}/payloads.$$"
mkdir -p "${PAYLOAD_DIR}"

if (( ${#START_HOOK[@]} )); then
    printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","transcript_path":"%s","source":"startup"}\n' \
        "${SESSION_ID}" "${REALCWD}" "${TRANSCRIPT}" > "${PAYLOAD_DIR}/start.json"
    "${START_HOOK[@]}" < "${PAYLOAD_DIR}/start.json" > /dev/null 2>> "${LOG}"
    log "SessionStart hook exited $?"
fi
printf 'ad-gate permission stub: session %s\n' "${SESSION_ID}"

HOOK_PID=""
FIRED=0
KILLED=0
while :; do
    if (( ! FIRED )) && [[ -f "${STUB_DIR}/fire-permission" ]]; then
        FIRED=1
        if (( ${#PERM_HOOK[@]} )); then
            jq -nc --arg sid "${SESSION_ID}" --arg cwd "${REALCWD}" --arg tp "${TRANSCRIPT}" \
                '{hook_event_name: "PermissionRequest", session_id: $sid, cwd: $cwd, transcript_path: $tp,
                  permission_mode: "default", tool_name: "Bash",
                  tool_input: {command: "echo ad-gate-permission-probe", description: "ad-gate filter regression probe"},
                  tool_use_id: "toolu_adgate_filter_regression"}' > "${PAYLOAD_DIR}/permission.json"
            "${PERM_HOOK[@]}" < "${PAYLOAD_DIR}/permission.json" > "${STUB_DIR}/permission-hook.out" 2>> "${LOG}" &
            HOOK_PID=$!
            log "PermissionRequest hook started, pid ${HOOK_PID}"
        else
            log "no PermissionRequest hook registered; nothing fired"
        fi
    fi
    if (( FIRED && ! KILLED )) && [[ -f "${STUB_DIR}/kill-hook" ]]; then
        KILLED=1
        if [[ -n "${HOOK_PID}" ]]; then
            if kill -0 "${HOOK_PID}" 2> /dev/null; then
                kill -KILL "${HOOK_PID}" 2> /dev/null
                wait "${HOOK_PID}" 2> /dev/null
                log "PermissionRequest hook ${HOOK_PID} killed and reaped"
            else
                wait "${HOOK_PID}" 2> /dev/null
                log "PermissionRequest hook ${HOOK_PID} had already exited ($?); output: $(head -c 300 "${STUB_DIR}/permission-hook.out")"
            fi
        fi
        us="${EPOCHREALTIME//[!0-9]/}"
        printf '%s\n' "$(( 10#${us} / 1000 ))" > "${STUB_DIR}/hook-killed.tmp" \
            && mv -f "${STUB_DIR}/hook-killed.tmp" "${STUB_DIR}/hook-killed"
    fi
    IFS= read -r -t 0.5 _
    rc=$?
    (( rc == 0 || rc > 128 )) || break
done
log "stdin closed; exiting"
exit 0
