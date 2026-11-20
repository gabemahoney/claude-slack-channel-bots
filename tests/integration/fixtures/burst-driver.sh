#!/bin/bash
# burst-driver.sh <record> bun <fixtures>/sr8-evidence.ts burst|fault-burst|fault-recover|member-cpu <arguments>...
#   Runs an SR-8 burst driver off the measured server's CPU quota and exits
#   with its status. <record> is an absolute path. In a burst-driver shard,
#   docker/entrypoint.sh starts this script's launcher (--serve) in
#   shard/driver, the driver's CPU group; the launcher starts each driver
#   there, so no process ever migrates and the server's UID needs no cgroup
#   write. This side passes the request, relays the driver's output and
#   status, and passes SIGTERM, SIGINT and SIGHUP on. Elsewhere (no launcher)
#   the driver runs in place, as the caller. Either way one line, the cgroup
#   the driver runs in, is appended to <record> for sr8-evidence.ts
#   driver-cpu, which judges that placement.
# burst-driver.sh --serve <spool>
#   The launcher: reads request names from <spool>/requests, one per line. It
#   serves only while BUN, this directory and its sr8-evidence.ts are owned
#   by root and writable by no one else. A request names no program, loader,
#   directory or search path: the launcher runs BUN itself on this
#   directory's sr8-evidence.ts with one of the four commands and the
#   request's arguments, unevaluated, from /, with DRIVER_FIXED_ENV and only
#   the request's DRIVER_ENV fields. Any other request starts nothing and
#   answers 64.
# A request is a directory of FIFOs: spec (record, argc, argv, then the
# DRIVER_ENV assignments, NUL-separated), out, err and status ("pid <n>" once
# the driver starts, then "exit <status>"). Nothing is written to disk but
# the record.
set -uo pipefail
[[ -f /etc/cscb-ci-image ]] || { echo 'burst-driver requires the CI image' >&2; exit 70; }
SPOOL=/run/cscb-burst-driver
MEMBERSHIP=/proc/self/cgroup
# The launcher's Bun, never one a request's PATH would find.
BUN=/usr/local/bin/bun
# The owner and group trusted() requires of what the launcher runs: root.
TRUSTED_UID=0
TRUSTED_GID=0
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The caller's environment a driver gets: the scenario root (the value
# printer's scratch fence), profiling fields and the two member sampler gates.
DRIVER_ENV=(SCENARIO_ROOT SR8_PHASE_CPU_FILE SR8_PHASE_CPU_PIDS SR8_PROFILE_DIR CSCB_TEST_DIAGNOSTICS SR8_MEMBER_CPU)
# The rest of a driver's environment, the launcher's own: no Bun options,
# preload, config or .env file can come from the caller.
DRIVER_FIXED_ENV=(PATH=/usr/local/bin:/usr/bin:/bin HOME=/ BUN_RUNTIME_TRANSPILER_CACHE_PATH=0)

usage() {
    echo 'usage: burst-driver.sh <record> bun <fixtures>/sr8-evidence.ts burst|fault-burst|fault-recover|member-cpu <arguments>... | --serve <spool>' >&2
    exit 64
}
# Only the SR-8 driver commands may run in the driver's group.
driver_command() {
    (( $# >= 3 )) && [[ $1 == bun && $2 == "${FIXTURES}/sr8-evidence.ts" && $3 =~ ^(burst|fault-burst|fault-recover|member-cpu)$ ]]
}
# One forwarded assignment: a DRIVER_ENV name, then =.
driver_assignment() {
    local name
    for name in "${DRIVER_ENV[@]}"; do [[ $1 == "${name}="* ]] && return 0; done
    return 1
}
# Owned by the trusted owner, not writable by others, and group-writable only for the trusted group.
trusted() {
    [[ -n $(find "$1" -maxdepth 0 -user "${TRUSTED_UID}" ! -perm -o+w \( -group "${TRUSTED_GID}" -o ! -perm -g+w \) 2> /dev/null) ]]
}
record_cgroup() {
    local line
    read -r line < "${MEMBERSHIP}" && printf '%s\n' "${line#0::}" >> "$1"
}

serve_request() {
    local request="$1" status=0 pid argc entry
    local -a spec argv env
    mapfile -d '' spec < "${request}/spec"
    exec 5> "${request}/status"
    argc="${spec[1]:-}"
    if [[ ${spec[0]:-} != /* ]] || ! [[ ${argc} =~ ^[0-9]+$ ]] || (( ${#spec[@]} < 2 + argc )); then echo 'exit 64' >&5; return; fi
    argv=("${spec[@]:2:argc}")
    env=("${spec[@]:2+argc}")
    if ! driver_command "${argv[@]}"; then echo 'exit 64' >&5; return; fi
    for entry in "${env[@]}"; do
        if ! driver_assignment "${entry}"; then echo 'exit 64' >&5; return; fi
    done
    ( cd / && record_cgroup "${spec[0]}" && exec env -i -- "${DRIVER_FIXED_ENV[@]}" "${env[@]}" "${BUN}" "${argv[@]:1}" ) \
        > "${request}/out" 2> "${request}/err" &
    pid=$!
    echo "pid ${pid}" >&5
    wait "${pid}" || status=$?
    echo "exit ${status}" >&5
}
serve() {
    local spool="$1" name path
    for path in "${BUN}" "${FIXTURES}" "${FIXTURES}/sr8-evidence.ts"; do
        if [[ -L ${path} ]] || ! trusted "${path}"; then
            echo "burst-driver: ${path} is not root-owned and closed to others; the launcher does not serve" >&2
            exit 70
        fi
    done
    exec 3<> "${spool}/requests" || exit 70
    while read -r name <&3; do
        [[ ${name} =~ ^request\.[A-Za-z0-9]+$ && -d ${spool}/${name} && ! -L ${spool}/${name} ]] || continue
        serve_request "${spool}/${name}" &
    done
}

run_through_launcher() {
    local record="$1" request out err remote='' word value status='' rc name
    shift
    request="$(mktemp -d "${SPOOL}/request.XXXXXX")" || exit 70
    mkfifo -m 0600 "${request}/spec" "${request}/out" "${request}/err" "${request}/status" || exit 70
    cat "${request}/out" &
    out=$!
    cat "${request}/err" >&2 &
    err=$!
    trap 'if [[ -n ${remote} ]]; then kill -TERM "${remote}" 2> /dev/null; else kill "${out}" "${err}" 2> /dev/null; exit 143; fi' TERM INT HUP
    if ! timeout 30 bash -c 'printf "%s\n" "$1" > "$2"' burst-driver "${request##*/}" "${SPOOL}/requests"; then
        echo 'burst-driver: the driver launcher did not take the request' >&2
        exit 70
    fi
    {
        printf '%s\0' "${record}" "$#" "$@"
        for name in "${DRIVER_ENV[@]}"; do
            [[ -v ${name} ]] && printf '%s=%s\0' "${name}" "${!name}"
        done
    } > "${request}/spec"
    exec 4< "${request}/status"
    while :; do
        if read -r word value <&4; then
            case "${word}" in
                pid) remote="${value}" ;;
                exit) status="${value}" ;;
            esac
        else
            rc=$?
            (( rc > 128 )) || break
        fi
    done
    # A refused request starts no driver, so nothing opens its output.
    [[ -n ${remote} ]] || kill "${out}" "${err}" 2> /dev/null
    wait "${out}" "${err}" 2> /dev/null
    rm -rf -- "${request}"
    [[ ${status} =~ ^[0-9]+$ ]] || { echo 'burst-driver: the driver launcher gave no exit status' >&2; exit 70; }
    exit "${status}"
}

if [[ ${1:-} == --serve ]]; then
    (( $# == 2 )) || usage
    serve "$2"
    exit 70
fi
(( $# >= 4 )) || usage
record="$1"
shift
[[ ${record} == /* ]] && driver_command "$@" || usage
if [[ -p ${SPOOL}/requests ]]; then
    run_through_launcher "${record}" "$@"
fi
record_cgroup "${record}" || exit 70
exec "$@"
