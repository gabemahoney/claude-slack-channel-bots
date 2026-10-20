#!/bin/bash -p
# CSCB_CI_AGENT_DIRECTOR_SHIM_MARKER
#
# agent-director-shim.sh — the logging agent-director wrapper of the fmk
# scenarios (b.jg5 SRJ-1306). Runs only in a cscb-ci image, where
# tests/integration/lib/scenario.sh installs it; never run it on a dev box.
#
# `install_ad_shim` (scenario.sh) puts this file at the path a scenario
# HOME's agent-director client resolves first, the standard path
# $HOME/.config/agent-director/bin/agent-director, as a regular file (the client
# follows symlinks, so a symlink there would bypass the shim): it copies the
# binary that was installed there beside it, as
# $HOME/.config/agent-director/bin/agent-director.real, then renames the shim over
# the standard path, so that path always holds the binary or the shim. The
# line above is the shim's marker; scenario.sh's `check_ad_shim` checks for
# it after every install, re-shim, swap and restore.
#
# The same file fronts agent-director-admin, the operator tool that holds
# `kill-finished` and `delete` (agent-director 0.11.0 on):
# `install_ad_admin_shim` puts it at $HOME/.config/agent-director/admin/agent-director-admin
# with the binary beside it as agent-director-admin.real, and
# `check_ad_admin_shim` checks it. Run by that name, the shim execs
# agent-director-admin.real and logs to the one log below.
#
# For each invocation the shim appends one `call` line to its log, then
# replaces itself with the real binary beside it (`exec`): the same process
# (PID), argv (argv[0] included), standard input, output and error, and exit
# status. When it cannot append the line it runs nothing, prints one line to
# standard error and exits 70, so no invocation goes unlogged.
#
# It reads no environment variable, since the client's version probe runs it
# with cwd / and a scrubbed environment: it finds the real binary and its log
# from its own path ($0) alone, calls its one external tool by absolute path,
# and runs under `bash -p`, so bash itself skips BASH_ENV, ENV and exported
# functions.
#
# THE LOG
# -------
# <dir>/agent-director-shim.log, where <dir> is the directory holding the
# shim and the real binary ($HOME/.config/agent-director/bin under the scenario
# HOME); run as agent-director-admin, the shim writes to that same file, in
# the bin directory beside its own admin directory, so one log holds every
# invocation of either binary. agent-director registers hook commands that name the real binary, so
# a process run as a hook, or one reading such a command (stub-claude.sh),
# derives the log from that command's directory. Installs, re-shims, swaps
# and scenario 8's hide and restore move only the shim and the binary: the
# log stays where it is and keeps every line.
#
# LINE FORMAT (the one format of every line of the log)
# -----------
#   <kind> TAB <time> TAB <pid> TAB <ppid> TAB <parent> TAB <words>
#
#   kind    `call`: one agent-director invocation; written only by this shim.
#           `stop`: stub-claude.sh's line saying it stopped re-firing
#           SessionStart, and why; written only by stub-claude.sh.
#           A reader that counts or checks invocations takes only the lines
#           whose first field is exactly `call`, so a `stop` line is never
#           read as an invocation.
#   time    the writer's clock when it wrote the line: seconds since the
#           epoch with six decimals (bash's EPOCHREALTIME, `.` as the point).
#   pid     the writer's PID. For `call` it is the agent-director process
#           itself, since the exec keeps the PID.
#   ppid    the writer's parent PID. For `call` it is the process that ran
#           agent-director: the bot server, a CLI command, a driver, the
#           scenario's own shell ($$ of the script) for a harness call, or a
#           process run as a hook.
#   parent  the parent's command line: the elements of /proc/<ppid>/cmdline,
#           each `printf %q`-quoted, joined by single spaces; a lone `?` when
#           it could not be read (the parent had already exited, say).
#   words   `printf %q`-quoted words joined by single spaces. For `call`:
#           argv[1] onwards, the field empty when agent-director ran with no
#           argument. For `stop`: `stub-claude`, then the reason's words.
#
# `printf %q` never writes a TAB or a newline (it spells them $'\t' and
# $'\n'), so no field holds a TAB and every line is one record. A field of
# quoted words gives back each word exactly, spaces kept, through bash:
# `eval "words=(${field})"`.
#
# Every writer appends its line while it holds an exclusive lock on the log
# (`/usr/bin/flock -x` on the open log file), so lines that concurrent
# processes write never interleave.

self="$0"
[[ "${self}" == /* ]] || self="$(pwd -P)/${self}"
dir="${self%/*}"
if [[ "${self##*/}" == agent-director-admin ]]; then
    real="${dir}/agent-director-admin.real"
    log="${dir%/*}/bin/agent-director-shim.log"
else
    real="${dir}/agent-director.real"
    log="${dir}/agent-director-shim.log"
fi

words=""
if (( $# > 0 )); then
    printf -v words '%q ' "$@"
    words="${words% }"
fi

parent='?'
parent_argv=()
if mapfile -d '' -t parent_argv 2> /dev/null < "/proc/${PPID}/cmdline" \
    && (( ${#parent_argv[@]} > 0 )); then
    printf -v parent '%q ' "${parent_argv[@]}"
    parent="${parent% }"
fi

printf -v line 'call\t%s\t%s\t%s\t%s\t%s' \
    "${EPOCHREALTIME/,/.}" "$$" "${PPID}" "${parent}" "${words}"

if ! { /usr/bin/flock -x 9 && printf '%s\n' "${line}" >&9; } 9>> "${log}"; then
    printf 'agent-director-shim: could not append to %s; agent-director was not run\n' "${log}" >&2
    exit 70
fi

# b.omv SR-14.1: adjacent counted faults, with a stable lock inode while
# the data file is replaced atomically. No fault configuration comes from
# the environment, including the client's scrubbed version-probe calls.
faults="${log%.log}.faults"
action=''
argv=("$@")
verb_index=0
# The pinned client prefixes verbs with --store-path and its value. Keep
# those global arguments in the real invocation and in the call log.
while (( verb_index < ${#argv[@]} )); do
    case "${argv[verb_index]}" in
        --store-path|--home|--tmux-command|--create-if-missing) verb_index=$((verb_index + 2)) ;;
        --store-path=*|--home=*|--tmux-command=*|--create-if-missing=*) verb_index=$((verb_index + 1)) ;;
        *) break ;;
    esac
done
call_verb="${argv[verb_index]:-}"
# Launch-response loss consumes a rule only after a successful real launch.
# Keep its lock through that call so a collision cannot steal the fault
# intended for the following reuse/resume, or race a concurrent invocation.
consume_fault() {
    rules[i]="${verb} ${match} ${candidate} $((10#${count} - 1))"
    printf '%s\n' "${rules[@]}" > "${faults}.$$" || exit 70
    /usr/bin/mv -f "${faults}.$$" "${faults}" || exit 70
    printf -v fault_words '%q %q %q %q' "${verb}" "${match}" "${candidate}" "${count}"
    printf -v fault_line 'fault\t%s\t%s\t%s\t%s\t%s' "${EPOCHREALTIME/,/.}" "$$" "${PPID}" "${parent}" "${fault_words}"
    { /usr/bin/flock -x 9 && printf '%s\n' "${fault_line}" >&9; } 9>> "${log}" || exit 70
}
if [[ -f "${faults}" ]]; then
    exec 8> "${faults}.lock" || exit 70
    /usr/bin/flock -x 8 || exit 70
    rules=()
    mapfile -t rules < "${faults}" || exit 70
    for i in "${!rules[@]}"; do
        [[ -z "${rules[i]}" || "${rules[i]}" == \#* ]] && continue
        read -r verb match candidate count extra <<< "${rules[i]}"
        if [[ -n "${extra}" || ! "${count}" =~ ^[0-9]+$ || ${#count} -gt 6 ]]; then
            printf 'agent-director-shim: invalid fault rule\n' >&2
            exit 70
        fi
        case "${candidate}" in
            swallow|unknown-typed|unknown-untyped|launch-reply-timeout) ;;
            delay=*) [[ "${candidate#delay=}" =~ ^[0-9]{1,6}$ ]] || exit 70 ;;
            *) exit 70 ;;
        esac
        if [[ "${candidate}" == launch-reply-timeout ]]; then
            [[ "${verb}" == spawn || "${verb}" == resume ]] && [[ "${match}" == instance=?* ]] || exit 70
        fi
        [[ "${verb}" == "${call_verb}" && "${count}" -gt 0 ]] || continue
        matches=0
        case "${match}" in
            '*') matches=1 ;;
            no_enter) for arg in "$@"; do [[ "${arg}" == --no-enter ]] && matches=1; done ;;
            key=*) previous=''; for arg in "$@"; do
                [[ "${previous}" == --key && "${arg}" == "${match#key=}" ]] && matches=1
                previous="${arg}"
            done ;;
            instance=*) previous=''; for arg in "$@"; do
                if [[ "${previous}" == --instance-id && "${arg}" == "${match#instance=}" \
                    || "${arg}" == "--instance-id=${match#instance=}" ]]; then matches=1; fi
                previous="${arg}"
            done ;;
            *) printf 'agent-director-shim: invalid fault matcher\n' >&2; exit 70 ;;
        esac
        (( matches )) || continue
        action="${candidate}"
        [[ "${action}" == launch-reply-timeout ]] || consume_fault
        break
    done
    if [[ "${action}" != launch-reply-timeout ]]; then
        /usr/bin/flock -u 8
        exec 8>&-
    fi
fi
case "${action}" in
    launch-reply-timeout)
        reply="${faults}.reply.$$"
        rc=0
        "${real}" "$@" 8>&- > "${reply}.out" 2> "${reply}.err" || rc=$?
        if (( rc == 0 )); then consume_fault; fi
        /usr/bin/flock -u 8
        exec 8>&-
        if (( rc == 0 )); then
            # LaunchTimeoutError's envelope (internal/spawn/launch_errors.go),
            # distinct from the send-keys uncertainty used by unknown-typed.
            printf '{"err_name":"ErrTmuxUnresponsive","err_description":"tmux: unresponsive: %s of instance launch-reply-timeout: tmux session creation failed: no answer within 5 s; the session may have been created; the row stays pending; do not retry until get shows the row ended or missing"}\n' "${call_verb}" >&2 || exit 70
            rc=1
        else
            /usr/bin/cat "${reply}.out" || exit 70
            /usr/bin/cat "${reply}.err" >&2 || exit 70
        fi
        /usr/bin/rm -f "${reply}.out" "${reply}.err" || exit 70
        exit "${rc}" ;;
    swallow) printf '{}\n'; exit 0 ;;
    delay=*) ms="${action#delay=}"; printf -v seconds '%d.%03d' "$((10#${ms}/1000))" "$((10#${ms}%1000))"; /usr/bin/sleep "${seconds}" ;;
    unknown-typed) "${real}" "$@" >/dev/null 2>/dev/null || true ;;
esac
if [[ "${action}" == unknown-typed || "${action}" == unknown-untyped ]]; then
    /usr/bin/cat "${log%/*}/agent-director-unresponsive.json" >&2 || exit 70
    exit 1
fi
exec -a "$0" "${real}" "$@"
