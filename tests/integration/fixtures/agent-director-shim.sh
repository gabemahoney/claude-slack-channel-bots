#!/bin/bash -p
# CSCB_CI_AGENT_DIRECTOR_SHIM_MARKER
#
# agent-director-shim.sh — the logging agent-director wrapper of the fmk
# scenarios (b.jg5 SRJ-1306). Runs only in a cscb-ci image, where
# tests/integration/lib/scenario.sh installs it; never run it on a dev box.
#
# `install_ad_shim` (scenario.sh) puts this file at the path a scenario
# HOME's agent-director client resolves first, the standard path
# $HOME/.agent-director/bin/agent-director, as a regular file (the client
# follows symlinks, so a symlink there would bypass the shim), and moves the
# binary that was installed there beside it, as
# $HOME/.agent-director/bin/agent-director.real. The line above is the shim's
# marker; scenario.sh's `check_ad_shim` checks for it after every install,
# re-shim, swap and restore.
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
# shim and the real binary ($HOME/.agent-director/bin under the scenario
# HOME). agent-director registers hook commands that name the real binary, so
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
real="${dir}/agent-director.real"
log="${dir}/agent-director-shim.log"

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

exec -a "$0" "${real}" "$@"
