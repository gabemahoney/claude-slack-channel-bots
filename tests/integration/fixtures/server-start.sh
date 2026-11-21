#!/bin/bash
# Fixed-command start broker. The entrypoint births --serve in shard/server;
# callers and their helpers remain in shard/harness. No PID migrates.
set -uo pipefail
[[ -f /etc/cscb-ci-image ]] || { echo 'server-start requires the CI image' >&2; exit 70; }
SPOOL=/run/cscb-burst-driver-server
BUN=/usr/local/bin/bun
CLI=/test-repo/node_modules/claude-slack-channel-bots/src/cli.ts
REPO=/test-repo
TRUSTED_UID=0
TRUSTED_GID=0
SELF="${BASH_SOURCE[0]}"
trusted() {
    [[ ! -L $1 && -n $(find "$1" -maxdepth 0 -user "${TRUSTED_UID}" ! -perm -o+w \( -group "${TRUSTED_GID}" -o ! -perm -g+w \) 2>/dev/null) ]]
}
start_exec() {
    local root="$1" state="$2" dry="$3" api="$4" diagnostics="$5" profile="$6" stat rest words line
    local fields=() fixed=(PATH="${1}/tmux-shim/bin:${1}/bin:/usr/local/bin:/usr/bin:/bin" HOME="${1}/home"
        TMUX_TMPDIR="${1}/tmux" SCENARIO_ROOT="$1" SLACK_STATE_DIR="$2" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
        CSCB_SLACK_API_URL="$4" CSCB_TEST_DIAGNOSTICS="$5")
    [[ ${dry} == 1 ]] && fixed+=(SLACK_DRY_RUN=1)
    if [[ -n ${profile} ]]; then
        trusted /tests/integration/fixtures/cpu-profile-preload.ts || exit 70
        fixed+=(BUN_OPTIONS='--preload /tests/integration/fixtures/cpu-profile-preload.ts' CSCB_TEST_CPU_PROFILE_DIR="${profile}")
    fi
    read -r stat < "/proc/${BASHPID}/stat" || exit 70
    rest="${stat##*) }"; read -r -a fields <<< "${rest}"
    printf -v words '%q ' "${BUN}" "${CLI}" start
    printf -v line 'proc\tstart\t%s\t%s\t%s\t%s' "${BASHPID}" "${fields[19]}" "${EPOCHREALTIME/,/.}" "${words% }"
    { flock -x 9 && printf '%s\n' "${line}" >&9; } 9>> "${root}/cscb-processes" || exit 70
    cd "${REPO}" || exit 70
    exec env -i -- "${fixed[@]}" "${BUN}" "${CLI}" start
}
serve_request() {
    local request="$1" status=0 pid watcher root state dry api diagnostics profile path
    local spec=()
    for path in spec out err status signals; do [[ -p ${request}/${path} && ! -L ${request}/${path} ]] || return; done
    exec 6<> "${request}/signals"
    mapfile -d '' spec < "${request}/spec"
    exec 5> "${request}/status"
    if (( ${#spec[@]} != 7 )) || [[ ${spec[0]} != start ]]; then echo 'exit 64' >&5; return; fi
    root="${spec[1]}"; state="${spec[2]}"; dry="${spec[3]}"; api="${spec[4]}"; diagnostics="${spec[5]}"; profile="${spec[6]}"
    if ! [[ ${root} =~ ^/tmp/test-[A-Za-z0-9._-]+$ && ${state} == "${root}"/* && ${dry} =~ ^[01]$ && ${diagnostics} =~ ^[01]$ \
        && ${api} =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] \
        || [[ $(realpath -e -- "${root}" 2>/dev/null) != "${root}" || $(realpath -e -- "${state}" 2>/dev/null) != "${state}" ]] \
        || [[ -n ${profile} && ( ${profile} != "${root}"/* || $(realpath -e -- "${profile}" 2>/dev/null) != "${profile}" ) ]]; then
        echo 'exit 64' >&5; return
    fi
    ( start_exec "${root}" "${state}" "${dry}" "${api}" "${diagnostics}" "${profile}" ) > "${request}/out" 2> "${request}/err" &
    pid=$!
    # The signal FIFO exists before request submission: a signal received
    # before the client learns pid is queued, not translated or discarded.
    watch_signals "${pid}" & watcher=$!
    echo "pid ${pid}" >&5
    wait "${pid}" || status=$?
    kill -TERM "${watcher}" 2>/dev/null || :
    wait "${watcher}" 2>/dev/null || :
    echo "exit ${status}" >&5
}
watch_signals() {
    local pid="$1" signal deadline=''
    while kill -0 "${pid}" 2>/dev/null; do
        if IFS= read -r -t 0.05 signal <&6; then
            case "${signal}" in
                TERM|INT|HUP) kill -s "${signal}" "${pid}" 2>/dev/null || :
                    [[ -n ${deadline} ]] || deadline=$((SECONDS + 5)) ;;
            esac
        fi
        if [[ -n ${deadline} ]] && (( SECONDS >= deadline )); then
            kill -KILL "${pid}" 2>/dev/null || :
            return
        fi
    done
}
serve() {
    local spool="$1" name path
    for path in "${BUN}" "${SELF}" "${SELF%/*}" "${spool}"; do
        trusted "${path}" || { echo 'server-start: untrusted launcher path' >&2; exit 70; }
    done
    exec 3<> "${spool}/requests" || exit 70
    while read -r name <&3; do
        [[ ${name} =~ ^request\.[A-Za-z0-9]+$ && -d ${spool}/jobs/${name} && ! -L ${spool}/jobs/${name} ]] || continue
        serve_request "${spool}/jobs/${name}" &
    done
}
run_through_launcher() {
    local request out err writer spec remote='' word value status='' rc profile='' signal_rc='' deadline=''
    if [[ -n ${BUN_OPTIONS:-} ]]; then
        [[ ${BUN_OPTIONS} == '--preload /tests/integration/fixtures/cpu-profile-preload.ts' ]] || exit 64
        profile="${CSCB_TEST_CPU_PROFILE_DIR:-}"
        [[ -n ${profile} ]] || exit 64
    fi
    request="$(mktemp -d "${SPOOL}/jobs/request.XXXXXX")" || exit 70
    mkfifo -m 0600 "${request}/spec" "${request}/out" "${request}/err" "${request}/status" "${request}/signals" || exit 70
    exec 7<> "${request}/signals"
    exec 4<> "${request}/status"
    cat "${request}/out" & out=$!
    cat "${request}/err" >&2 & err=$!
    relay_signal() {
        printf '%s\n' "$1" >&7
        if [[ -z ${deadline} ]]; then signal_rc="$2"; deadline=$((SECONDS + 6)); fi
    }
    trap 'relay_signal TERM 143' TERM
    trap 'relay_signal INT 130' INT
    trap 'relay_signal HUP 129' HUP
    timeout 30 bash -c 'printf "%s\n" "$1" > "$2"' server-start "${request##*/}" "${SPOOL}/requests" & writer=$!
    printf '%s\0' start "${SCENARIO_ROOT:-}" "${SLACK_STATE_DIR:-}" "${SLACK_DRY_RUN:-0}" \
        "${CSCB_SLACK_API_URL:-}" "${CSCB_TEST_DIAGNOSTICS:-0}" "${profile}" > "${request}/spec" & spec=$!
    while :; do
        if read -r -t 0.05 word value <&4; then
            case "${word}" in pid) remote="${value}" ;; exit) status="${value}" ;; esac
        fi
        [[ -z ${status} ]] || break
        if [[ -n ${deadline} ]] && (( SECONDS >= deadline )); then
            [[ -z ${remote} ]] || kill -KILL "${remote}" 2>/dev/null || :
            status="${signal_rc}"; break
        fi
        # No reader/broker: retain the existing bounded enqueue refusal.
        if ! kill -0 "${writer}" 2>/dev/null; then
            wait "${writer}"; rc=$?
            (( rc == 0 )) || { status=70; break; }
        fi
    done
    kill -TERM "${writer}" "${spec}" 2>/dev/null || :
    wait "${writer}" "${spec}" 2>/dev/null || :
    for rc in "${out}" "${err}"; do
        if [[ -n ${deadline} ]]; then
            while kill -0 "${rc}" 2>/dev/null && (( SECONDS < deadline )); do sleep 0.05; done
            kill -KILL "${rc}" 2>/dev/null || :
        elif [[ -z ${remote} ]]; then kill -TERM "${rc}" 2>/dev/null || :; fi
        wait "${rc}" 2>/dev/null || :
    done
    exec 4>&- 7>&-
    rm -rf -- "${request}"
    [[ ${status} =~ ^[0-9]+$ ]] || exit 70
    exit "${status}"
}
if [[ ${1:-} == --serve && $# == 2 ]]; then serve "$2"; exit 70; fi
[[ $# == 1 && $1 == start ]] || { echo 'usage: server-start.sh start | --serve <spool>' >&2; exit 64; }
if [[ -p ${SPOOL}/requests ]]; then run_through_launcher; fi
# Ordinary shards keep the caller's original command, environment and cwd.
exec "${SCENARIO_CLI:-${CLI}}" start
