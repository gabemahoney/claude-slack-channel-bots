#!/usr/bin/env bash
# The per-shard in-container runner (b.uqm SR-11). The host runner,
# scripts/ci-run.ts, starts one shard container per shard; docker/entrypoint.sh
# passes this runner the container's arguments unchanged. It runs only the
# scripts it is given, in the given order, and leaves its evidence in fixed
# formats in its shard subdirectory, mounted at /test-results, for the host
# runner to merge and check.
#
# Arguments, in this order (b.uqm SR-11.2):
#   <shard number>          a whole number of at least 1, with no leading zero
#   <canary>                32 lowercase hexadecimal characters
#   --fail <file name>      zero or more pairs: an assigned script to record
#                           failed, without running it (the `fail:` fault)
#   <file name>...          the assigned scripts, test-<n>-<slug>.sh, in run
#                           order, test-1 first, each named once
# Malformed arguments print one line on stderr beginning `usage: ` and exit 64,
# writing nothing.
#
# What it writes in /test-results, and nothing else (b.uqm SR-11.3):
#   canary.txt              the canary and one LF, before any script runs
#   package.sha256          the SHA-256 of /tmp/package.tgz, 64 lowercase
#                           hexadecimal characters and one LF, before any
#                           script runs
#   result.txt              one line per event, each written whole in one
#                           write: `start <file name>` before each script;
#                           `end <file name> pass|fail <s.mmm>` after it;
#                           `notrun <file name>` for each script not reached;
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
# At its first failing script it runs nothing more: it writes the `notrun`
# lines, then `done`, and then stays running, idle, until the host runner
# kills its container (b.uqm SR-11.4). As the container's PID 1 it ignores
# SIGTERM; after `done` it ignores it explicitly too.
#
# The canary goes only into canary.txt: this runner exports nothing, so no
# script's environment changes (b.uqm SR-13.1).
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
# exactly as the export of the same name: the single source (b.uqm SR-11.5).
USAGE_PREFIX='usage: '
USAGE_EXIT_STATUS=64
RUNNER_FAIL_OPTION='--fail'
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
# directory within one (b.uqm SR-11.3).
NODE_MODULES_DIR='/test-repo/node_modules'
PACKAGE_JSON_PATH_PATTERN='.*/node_modules/(@[^/]+/)?[^/]+/package\.json'

# --- Helpers ---

# Prints one `usage: ` line on stderr, ending in the fixed reason $1 (it
# holds no argument's value, so the line is always one line), and exits 64.
usage() {
    printf '%s%s\n' "${USAGE_PREFIX}" "runner.sh <shard number> <canary> [${RUNNER_FAIL_OPTION} <file name>]... <file name>...: $1" >&2
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
# bytewise under the C locale with repeats removed (b.uqm SR-11.3).
dependency_fingerprint() {
    package_lines | LC_ALL=C sort -u | sha256_hex
}

# --- The arguments (b.uqm SR-11.2): checked whole before anything is written ---

(( $# >= 1 )) || usage "the shard number is missing"
[[ $1 =~ ${SHARD_NUMBER_PATTERN} ]] || usage "argument 1 is not a shard number: a whole number of at least 1, with no leading zero"
(( $# >= 2 )) || usage "the canary is missing"
[[ $2 =~ ${CANARY_PATTERN} ]] || usage "argument 2 is not a canary: ${CANARY_LENGTH} lowercase hexadecimal characters"
canary=$2
shift 2

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

# --- The early files (b.uqm SR-11.3): before any script runs ---

tests_dir="$(cd "$(dirname "$0")" && pwd)"

write_file "${CANARY_FILE_NAME}" "${canary}"
if package_sha256=$(sha256_hex < "${INTEGRITY_TARBALL_MOUNT_TARGET}"); then
    write_file "${PACKAGE_SHA256_FILE_NAME}" "${package_sha256}"
else
    echo "runner.sh: the SHA-256 of ${INTEGRITY_TARBALL_MOUNT_TARGET} could not be taken; ${PACKAGE_SHA256_FILE_NAME} is not written" >&2
fi

# --- The assigned scripts, in order (b.uqm SR-11.3, SR-11.4) ---

failed=0
for (( index = 0; index < ${#assigned[@]}; index++ )); do
    name=${assigned[index]}
    if (( failed )); then
        write_result_line "${RESULT_WORD_NOTRUN} ${name}"
        continue
    fi

    write_result_line "${RESULT_WORD_START} ${name}"

    if is_in "${name}" "${fail_names[@]}"; then
        # The `fail:` fault: the script is not run (b.uqm SR-14.2).
        write_file "${name}${SCRIPT_LOG_SUFFIX}" "${FAIL_PREFIX}${name}: ${INJECTED_FAILURE_TEXT}"
        write_result_line "${RESULT_WORD_END} ${name} ${RESULT_WORD_FAIL} 0.000"
        failed=1
        continue
    fi

    # The script's log is created before the run, so a log that cannot be
    # opened ends the runner instead of being recorded as the script's failure.
    : > "${INTEGRITY_RESULTS_MOUNT_TARGET}/${name}${SCRIPT_LOG_SUFFIX}" || exit 1

    started_us=$(now_us)
    bash "${tests_dir}/integration/${name}" > "${INTEGRITY_RESULTS_MOUNT_TARGET}/${name}${SCRIPT_LOG_SUFFIX}" 2>&1
    script_status=$?
    ended_us=$(now_us)
    seconds=$(script_seconds "${started_us}" "${ended_us}")

    if (( script_status != 0 )); then
        write_result_line "${RESULT_WORD_END} ${name} ${RESULT_WORD_FAIL} ${seconds}"
        failed=1
        continue
    fi
    write_result_line "${RESULT_WORD_END} ${name} ${RESULT_WORD_PASS} ${seconds}"

    # test-1 is always the first assigned script.
    if (( index == 0 )); then
        if fingerprint=$(dependency_fingerprint); then
            write_file "${DEPENDENCY_FINGERPRINT_FILE_NAME}" "${fingerprint}"
        else
            echo "runner.sh: the dependency fingerprint of ${NODE_MODULES_DIR} could not be taken; ${DEPENDENCY_FINGERPRINT_FILE_NAME} is not written" >&2
        fi
    fi
done

write_result_line "${RESULT_WORD_DONE}"

# --- After the end marker: idle until the host runner kills the container ---

trap '' TERM
while :; do
    sleep 3600
done
