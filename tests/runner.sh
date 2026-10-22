#!/usr/bin/env bash
# The per-shard in-container runner. The host runner,
# scripts/ci-run.ts, starts one shard container per shard; docker/entrypoint.sh
# passes this runner the container's arguments unchanged. It runs only the
# scripts it is given, in the given order, and leaves its evidence in fixed
# formats in its shard subdirectory, mounted at /test-results, for the host
# runner to merge and check.
#
# Arguments, in this order:
#   <shard number>          a whole number of at least 1, with no leading zero
#   <canary>                32 lowercase hexadecimal characters
#   --keep-going           optional: continue independent scripts after cleanup
#   --fail <file name>      zero or more pairs: an assigned script to record
#                           failed, without running it (the `fail:` fault)
#   <file name>...          the assigned scripts, test-<n>-<slug>.sh, in run
#                           order, test-1 first, each named once
# Malformed arguments print one line on stderr beginning `usage: ` and exit 64,
# writing nothing.
#
# What it writes in /test-results, and nothing else:
#   canary.txt              the canary and one LF, before any script runs
#   package.sha256          the SHA-256 of /tmp/package.tgz, 64 lowercase
#                           hexadecimal characters and one LF, before any
#                           script runs
#   result.txt              one line per event, each written whole in one
#                           write: `start <file name>` before each script;
#                           `end <file name> pass|fail <s.mmm>` after it;
#                           `notrun <file name> <reason>` for each skipped script;
#                           then the end marker `done`
#   <file name>.log         each run script's combined stdout and stderr, as
#                           it runs; a `--fail` script's log holds only
#                           `FAIL: <file name>: injected failure`
#   dependency-fingerprint.txt
#                           after test-1 passes: the SHA-256 of one
#                           `<name>@<version>` line per installed package
#                           directory under /test-repo/node_modules, sorted
#                           bytewise with repeats removed
# It never writes verdict.txt: the host runner writes the verdict.
#
# By default its first failure stops this shard. With --keep-going, failed
# prerequisites and unsafe cleanup block continuation explicitly. It writes
# `done`, then stays running, idle, until the host runner
# kills its container. As the container's PID 1 it ignores
# SIGTERM; after `done` it ignores it explicitly too.
#
# The canary goes only into canary.txt: this runner exports nothing, so no
# script's environment changes.
#
# Runs only in a cscb-ci image: its first step checks for the image marker
# /etc/cscb-ci-image (docker/Dockerfile.test.base) and, when it is absent,
# prints one line to stderr and exits 2 before it reads its arguments, writes
# a file or runs a script.
set -uo pipefail

if [[ ! -e /etc/cscb-ci-image ]]; then
    echo "runner.sh: /etc/cscb-ci-image is absent: this runner runs only in a cscb-ci image (/ci); refusing to run" >&2
    exit 2
fi

# The host runner's exported names and texts (scripts/ci-run.ts), each spelled
# exactly as the export of the same name: the single source.
USAGE_PREFIX='usage: '
USAGE_EXIT_STATUS=64
RUNNER_FAIL_OPTION='--fail'
PERFORMANCE_LOCK_TARGET='/run/cscb-ci-performance.lock'
CANARY_LENGTH=32
SHA256_HEX_LENGTH=64
SCRIPT_FILE_NAME_PATTERN='^test-(0|[1-9][0-9]*)-[a-z0-9-]+\.sh$'
INTEGRITY_TARBALL_MOUNT_TARGET='/tmp/package.tgz'
INTEGRITY_RESULTS_MOUNT_TARGET='/test-results'
CANARY_FILE_NAME='canary.txt'
PACKAGE_SHA256_FILE_NAME='package.sha256'
RESULT_FILE_NAME='result.txt'
DEPENDENCY_FINGERPRINT_FILE_NAME='dependency-fingerprint.txt'
SCRIPT_LOG_SUFFIX='.log'
RESULT_WORD_START='start'
RESULT_WORD_END='end'
RESULT_WORD_PASS='pass'
RESULT_WORD_FAIL='fail'
RESULT_WORD_NOTRUN='notrun'
RESULT_WORD_DONE='done'
FAIL_PREFIX='FAIL: '
INJECTED_FAILURE_TEXT='injected failure'

# This runner's own forms, built from the names above.
SHARD_NUMBER_PATTERN='^[1-9][0-9]*$'
CANARY_PATTERN="^[0-9a-f]{${CANARY_LENGTH}}\$"
SHA256_HEX_PATTERN="^[0-9a-f]{${SHA256_HEX_LENGTH}}\$"
# The installed packages' directory, and a package.json that sits in a package
# directory directly in a node_modules directory, or directly in an @<scope>
# directory within one.
NODE_MODULES_DIR='/test-repo/node_modules'
PACKAGE_JSON_PATH_PATTERN='.*/node_modules/(@[^/]+/)?[^/]+/package\.json'

# --- Helpers ---

# Prints one `usage: ` line on stderr, ending in the fixed reason $1 (it
# holds no argument's value, so the line is always one line), and exits 64.
usage() {
    printf '%s%s\n' "${USAGE_PREFIX}" "runner.sh <shard number> <canary> [--keep-going] [${RUNNER_FAIL_OPTION} <file name>]... <file name>...: $1" >&2
    exit "${USAGE_EXIT_STATUS}"
}

# Whether the word $1 is one of the words after it.
is_in() {
    local word=$1 item
    shift
    for item in "$@"; do
        [[ ${item} == "${word}" ]] && return 0
    done
    return 1
}

# Writes the in-shard file $1 whole: the text $2 and one LF, in one write. A
# failed write ends the runner.
write_file() {
    printf '%s\n' "$2" > "${INTEGRITY_RESULTS_MOUNT_TARGET}/$1" || exit 1
}

# Appends the line $1 and its LF to result.txt in one write, so a partial last
# line is the only in-progress state a reader can see. A failed write ends the
# runner.
write_result_line() {
    printf '%s\n' "$1" >> "${INTEGRITY_RESULTS_MOUNT_TARGET}/${RESULT_FILE_NAME}" || exit 1
}

# Prints the SHA-256 of standard input as 64 lowercase hexadecimal characters;
# fails, printing nothing, when it cannot.
sha256_hex() {
    local sum
    sum=$(sha256sum) || return 1
    sum=${sum%% *}
    [[ ${sum} =~ ${SHA256_HEX_PATTERN} ]] || return 1
    printf '%s\n' "${sum}"
}

# The wall clock in microseconds, from bash's EPOCHREALTIME with its decimal
# point removed (always six digits after it).
now_us() {
    printf '%s\n' "${EPOCHREALTIME//[!0-9]/}"
}

# Prints the time from $1 to $2 (microseconds) as a script's seconds: digits
# with no leading zero other than a lone 0, a point, exactly three digits.
script_seconds() {
    local elapsed_ms=$(( (10#$2 - 10#$1) / 1000 ))
    (( elapsed_ms >= 0 )) || elapsed_ms=0
    printf '%d.%03d\n' "$(( elapsed_ms / 1000 ))" "$(( elapsed_ms % 1000 ))"
}

# Prints one `<name>@<version>` line per installed package directory under
# /test-repo/node_modules, at any depth, skipping directories whose names
# begin with `.`; an absent field, or a package.json jq cannot read, gives an
# empty field. Fails when the walk fails.
package_lines() {
    local package_json
    find "${NODE_MODULES_DIR}" -regextype posix-extended -name '.*' -prune -o -type f -regex "${PACKAGE_JSON_PATH_PATTERN}" -print0 |
        while IFS= read -r -d '' package_json; do
            jq -r '"\(.name // "")@\(.version // "")"' "${package_json}" 2> /dev/null || printf '@\n'
        done
}

# Prints the dependency fingerprint: the SHA-256 of package_lines, sorted
# bytewise under the C locale with repeats removed.
dependency_fingerprint() {
    package_lines | LC_ALL=C sort -u | sha256_hex
}

# Process cleanup is scoped to this disposable container's PID namespace.
# Read identity only, never argv, environment, auth files or terminal output.
# The runner's initial infrastructure and test-1's intentional daemon survive
# ordinary scripts. All other processes must be gone before continuation.
read_process() {
    local raw
    [[ -e /proc/$1/stat ]] || return 1
    IFS= read -r raw < "/proc/$1/stat" || return 2
    raw=${raw##*) }
    read -r -a process_fields <<< "${raw}"
    (( ${#process_fields[@]} >= 20 )) || return 2
    process_state=${process_fields[0]}
    process_start=${process_fields[19]}
    [[ ${process_start} =~ ^[0-9]+$ ]] || return 2
}

capture_infrastructure() {
    local path pid rc
    for path in /proc/[0-9]*/stat; do
        pid=${path#/proc/}; pid=${pid%/stat}
        read_process "${pid}"; rc=$?
        if (( rc == 0 )); then infrastructure[${pid}]=${process_start}
        elif (( rc != 1 )) && [[ -e ${path} ]]; then return 1
        fi
    done
}

remember_daemon() {
    local pid
    # Some synthetic/installation-only scripts legitimately start no daemon.
    [[ -e /home/testuser/.config/claude-slack-channel-bots/server.pid ]] || return 0
    IFS= read -r pid < "/home/testuser/.config/claude-slack-channel-bots/server.pid" || return 1
    [[ ${pid} =~ ^[1-9][0-9]*$ ]] || return 1
    read_process "${pid}" || return 1
    daemon_pid=${pid}; daemon_start=${process_start}
}

collect_survivors() {
    local path pid rc
    survivors=()
    for path in /proc/[0-9]*/stat; do
        pid=${path#/proc/}; pid=${pid%/stat}
        read_process "${pid}"; rc=$?
        if (( rc != 0 )); then
            (( rc == 1 )) || [[ ! -e ${path} ]] || return 1
            continue
        fi
        [[ ${process_state} == Z || ${process_state} == X ]] && continue
        [[ ${infrastructure[${pid}]:-} == "${process_start}" ]] && continue
        [[ ${pid} == "${daemon_pid}" && ${process_start} == "${daemon_start}" ]] && continue
        survivors+=("${pid}:${process_start}")
    done
}

verified_cleanup() {
    local attempt identity pid birth signal rc
    for (( attempt = 0; attempt < 50; attempt++ )); do
        collect_survivors || return 1
        if (( ${#survivors[@]} == 0 )); then
            printf 'cleanup: verified\n'
            return 0
        fi
        signal=TERM
        (( attempt >= 20 )) && signal=KILL
        for identity in "${survivors[@]}"; do
            pid=${identity%%:*}; birth=${identity#*:}
            read_process "${pid}"; rc=$?
            if (( rc == 0 )) && [[ ${process_start} == "${birth}" && ${process_state} != Z && ${process_state} != X ]]; then
                kill -"${signal}" "${pid}" 2>/dev/null || true
            elif (( rc != 0 && rc != 1 )) && [[ -e /proc/${pid}/stat ]]; then return 1
            fi
        done
        sleep 0.1
    done
    collect_survivors && (( ${#survivors[@]} == 0 ))
}

# Read the same initial comment block used by the host prerequisite parser.
# Already validated against the pinned image, but fail closed on disagreement.
read_dependencies() {
    local script line header_seen word candidate found count
    for script in "${assigned[@]}"; do
        [[ -f ${tests_dir}/integration/${script} && ! -L ${tests_dir}/integration/${script} ]] || usage 'assigned script missing or not regular'
        dependencies[${script}]=''
        header_seen=0; count=0
        while IFS= read -r line; do
            (( count += 1 ))
            (( count == 1 )) && continue
            [[ ${line} == \#* ]] || break
            if [[ ${line} =~ ^#[[:blank:]]*ci-requires:[[:blank:]]*(.*)$ ]]; then
                (( header_seen == 0 )) || usage 'repeated prerequisite header'
                header_seen=1
                for word in ${BASH_REMATCH[1]}; do
                    found=''
                    for candidate in "${assigned[@]}"; do
                        [[ ${candidate} == "${script}" ]] && break
                        if [[ ${candidate} == "${word}" || ${candidate} == "${word}-"*.sh ]]; then
                            [[ -z ${found} ]] || usage 'ambiguous prerequisite'
                            found=${candidate}
                        fi
                    done
                    [[ -n ${found} ]] || usage 'prerequisite is absent or not earlier in this shard'
                    dependencies[${script}]+="${found} "
                done
            fi
        done < "${tests_dir}/integration/${script}"
    done
}

# --- The arguments: checked whole before anything is written ---

(( $# >= 1 )) || usage "the shard number is missing"
[[ $1 =~ ${SHARD_NUMBER_PATTERN} ]] || usage "argument 1 is not a shard number: a whole number of at least 1, with no leading zero"
(( $# >= 2 )) || usage "the canary is missing"
[[ $2 =~ ${CANARY_PATTERN} ]] || usage "argument 2 is not a canary: ${CANARY_LENGTH} lowercase hexadecimal characters"
canary=$2
shift 2

keep_going=0
if (( $# >= 1 )) && [[ $1 == --keep-going ]]; then
    keep_going=1
    shift
fi

fail_names=()
while (( $# >= 1 )) && [[ $1 == "${RUNNER_FAIL_OPTION}" ]]; do
    (( $# >= 2 )) || usage "argument $(( 3 + 2 * ${#fail_names[@]} )): ${RUNNER_FAIL_OPTION} has no file name after it"
    fail_names+=("$2")
    shift 2
done

(( $# >= 1 )) || usage "no assigned script is given"
assigned=("$@")
first_script_position=$(( 3 + 2 * ${#fail_names[@]} ))

for (( index = 0; index < ${#assigned[@]}; index++ )); do
    name=${assigned[index]}
    position=$(( first_script_position + index ))
    [[ ${name} =~ ${SCRIPT_FILE_NAME_PATTERN} ]] || usage "argument ${position} is not a script file name, test-<n>-<slug>.sh"
    if (( index == 0 )) && [[ ${BASH_REMATCH[1]} != '1' ]]; then
        usage "argument ${position}, the first assigned script, is not test-1"
    fi
    is_in "${name}" "${assigned[@]:0:index}" && usage "argument ${position} names an assigned script a second time"
done

for (( index = 0; index < ${#fail_names[@]}; index++ )); do
    name=${fail_names[index]}
    position=$(( 4 + 2 * index ))
    is_in "${name}" "${assigned[@]}" || usage "argument ${position}: ${RUNNER_FAIL_OPTION} names a file that is not an assigned script"
    is_in "${name}" "${fail_names[@]:0:index}" && usage "argument ${position}: ${RUNNER_FAIL_OPTION} names a file a second time"
done

# --- The early files: before any script runs ---

tests_dir="$(cd "$(dirname "$0")" && pwd)"
declare -A dependencies=() outcomes=() infrastructure=()
daemon_pid=''; daemon_start=''
read_dependencies
[[ -f ${PERFORMANCE_LOCK_TARGET} && ! -L ${PERFORMANCE_LOCK_TARGET} ]] || {
    echo 'runner.sh: performance guard mount missing or invalid' >&2
    exit 2
}
exec 9< "${PERFORMANCE_LOCK_TARGET}" || exit 2
flock -s 9 || exit 2
capture_infrastructure || exit 2

write_file "${CANARY_FILE_NAME}" "${canary}"
if package_sha256=$(sha256_hex < "${INTEGRITY_TARBALL_MOUNT_TARGET}"); then
    write_file "${PACKAGE_SHA256_FILE_NAME}" "${package_sha256}"
else
    echo "runner.sh: the SHA-256 of ${INTEGRITY_TARBALL_MOUNT_TARGET} could not be taken; ${PACKAGE_SHA256_FILE_NAME} is not written" >&2
fi

# --- The assigned scripts, in order ---

failed=0
unsafe_cleanup=0
for (( index = 0; index < ${#assigned[@]}; index++ )); do
    name=${assigned[index]}
    reason=''
    if (( unsafe_cleanup )); then
        reason=unsafe-cleanup
    elif (( failed && ! keep_going )); then
        reason=fail-fast
    elif (( index > 0 )) && [[ ${outcomes[${assigned[0]}]:-} != pass ]]; then
        reason="dependency:${assigned[0]}"
    else
        for prerequisite in ${dependencies[${name}]}; do
            if [[ ${outcomes[${prerequisite}]:-} != pass ]]; then
                reason="dependency:${prerequisite}"
                break
            fi
        done
    fi
    if [[ -n ${reason} ]]; then
        outcomes[${name}]=notrun
        write_result_line "${RESULT_WORD_NOTRUN} ${name} ${reason}"
        continue
    fi

    : > "${INTEGRITY_RESULTS_MOUNT_TARGET}/${name}${SCRIPT_LOG_SUFFIX}" || exit 1
    # Keep all ordinary work shared; measure with no other managed
    # script/build running. Stop the intentional dry-run baseline first.
    if [[ ${name} == test-32-* ]]; then
        daemon_pid=''; daemon_start=''
        if ! verified_cleanup >> "${INTEGRITY_RESULTS_MOUNT_TARGET}/${name}${SCRIPT_LOG_SUFFIX}" 2>&1; then
            unsafe_cleanup=1
            outcomes[${name}]=notrun
            write_result_line "${RESULT_WORD_NOTRUN} ${name} unsafe-cleanup"
            continue
        fi
        flock -u 9 || exit 1
        flock -x 9 || exit 1
    fi

    write_result_line "${RESULT_WORD_START} ${name}"
    started_us=$(now_us)
    script_status=0
    if is_in "${name}" "${fail_names[@]}"; then
        write_file "${name}${SCRIPT_LOG_SUFFIX}" "${FAIL_PREFIX}${name}: ${INJECTED_FAILURE_TEXT}"
        script_status=1
    else
        bash "${tests_dir}/integration/${name}" >> "${INTEGRITY_RESULTS_MOUNT_TARGET}/${name}${SCRIPT_LOG_SUFFIX}" 2>&1
        script_status=$?
    fi
    ended_us=$(now_us)
    seconds=$(script_seconds "${started_us}" "${ended_us}")
    is_in "${name}" "${fail_names[@]}" && seconds=0.000

    if (( script_status == 0 )) && [[ ${name} == test-1-* || ${name} == test-3-* ]]; then
        remember_daemon || script_status=1
    fi
    if (( index == ${#assigned[@]} - 1 )); then daemon_pid=''; daemon_start=''; fi
    if ! verified_cleanup >> "${INTEGRITY_RESULTS_MOUNT_TARGET}/${name}${SCRIPT_LOG_SUFFIX}" 2>&1; then
        printf '%s%s: unsafe-cleanup\n' "${FAIL_PREFIX}" "${name}" >> "${INTEGRITY_RESULTS_MOUNT_TARGET}/${name}${SCRIPT_LOG_SUFFIX}"
        unsafe_cleanup=1
        script_status=1
    fi
    if (( script_status != 0 )); then
        outcomes[${name}]=fail
        write_result_line "${RESULT_WORD_END} ${name} ${RESULT_WORD_FAIL} ${seconds}"
        failed=1
    else
        outcomes[${name}]=pass
        write_result_line "${RESULT_WORD_END} ${name} ${RESULT_WORD_PASS} ${seconds}"
        if (( index == 0 )); then
            if fingerprint=$(dependency_fingerprint); then
                write_file "${DEPENDENCY_FINGERPRINT_FILE_NAME}" "${fingerprint}"
            else
                echo "runner.sh: dependency fingerprint could not be taken" >&2
            fi
        fi
    fi
    if [[ ${name} == test-32-* ]] && (( ! unsafe_cleanup )); then
        flock -u 9 || exit 1
        flock -s 9 || exit 1
    fi
done

# Release the performance guard only once even the baseline daemon is gone.
# On uncertainty retain it until the host kills and verifies this container.
daemon_pid=''; daemon_start=''
if verified_cleanup; then
    flock -u 9 || exit 1
    write_result_line "${RESULT_WORD_DONE}"
else
    # No normal end marker: the host's existing limit/stop retires this shard
    # as failed, even when every script END already records a pass.
    printf '%srunner.sh: unsafe-cleanup\n' "${FAIL_PREFIX}" >&2
fi

# --- Idle until the host runner kills the container ---

trap '' TERM
while :; do
    sleep 3600
done
