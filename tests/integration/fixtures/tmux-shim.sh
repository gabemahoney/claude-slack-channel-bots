#!/bin/bash -p
# CSCB_CI_TMUX_SHIM_MARKER
#
# tmux-shim.sh — the logging tmux wrapper of the fmk scenarios (b.jg5
# SRJ-1306, SRJ-1401). Runs only in a cscb-ci image, where
# tests/integration/lib/scenario.sh installs it; never run it on a dev box.
#
# scenario.sh copies this file to $SCENARIO_ROOT/tmux-shim/bin/tmux and puts
# that bin directory first on the PATH of every CSCB process an fmk scenario
# starts (the bot server, start and stop runs, and CLI commands and drivers
# run through `cscb_run`). agent-director runs `tmux` from its caller's PATH
# and passes its caller's environment on, so every tmux call a CSCB-run
# agent-director makes reaches this shim. The scenario's own shell keeps the
# real tmux. The line above is the shim's marker.
#
# For each call the shim first appends one `call` line to its log, then acts
# on its mode. When it cannot append the line it runs nothing, prints one
# line to standard error and exits 70, so no call goes unlogged.
#
# FILES (found from the shim's own path, $0, never from an environment
# variable, which agent-director or tmux may not pass on)
# -----
# With <root> the directory above the shim's bin directory
# ($SCENARIO_ROOT/tmux-shim):
#   <root>/tmux.real      the real tmux: a symlink scenario.sh makes to the
#                         tmux it resolved before it changed any PATH. The
#                         shim runs only this file, and refuses (exit 70,
#                         running nothing) when it is missing, is the shim's
#                         own file or carries the shim's marker, so it never
#                         runs itself.
#   <root>/mode           the mode file, read on every call: one line,
#                         `<mode>` or `<mode> <delay-s>`, written by
#                         scenario.sh's `tmux_shim_mode` (atomically). No file
#                         reads as `log`. An unreadable file or an unknown mode
#                         runs nothing and exits 70. For `fail-kill` only,
#                         the lines after the first, when there are any, are
#                         its target list, one target per line (see
#                         "fail-kill's target list"); a list with any other
#                         mode runs nothing and exits 70. The file is opened
#                         once per call, so the mode and its list are read
#                         from one version of it.
#   <root>/tmux-shim.log  the log.
#
# MODES
# -----
#   log           run the real tmux.
#   fail-kill     a call whose commands include `kill-session` or `kill-pane`
#                 runs nothing (so kills nothing), prints one line to standard
#                 error and exits 1; every other call runs the real tmux.
#                 With a target list, only a call holding a `kill-session` or
#                 `kill-pane` aimed at a listed target does so; every other
#                 call, a kill aimed elsewhere included, runs the real tmux.
#   fail-create   a call whose commands include `new-session` runs nothing (so
#                 creates nothing), writes nothing to standard output, writes
#                 one line that tmux never gives (it starts `tmux-shim:`) to
#                 standard error and exits 1; every other call runs the real
#                 tmux.
#   slow-create   a call whose commands include `new-session` runs the whole
#                 call, every chained command with it (agent-director's
#                 `@ad_owner` and `@ad_pane` labels among them), through the
#                 real tmux, then waits <delay-s> (default 15, longer than
#                 agent-director's default create_timeout_ms of 5000) and
#                 exits with tmux's status; every other call runs the real
#                 tmux.
#   wedge         every call waits <delay-s> (default 60, longer than every
#                 call timeout at agent-director's defaults), then prints one
#                 line to standard error and exits 1, having run no tmux.
# <delay-s> is a whole or decimal number of seconds; a mode other than
# slow-create and wedge ignores it. A wait runs /usr/bin/sleep with its
# standard streams on /dev/null, so when agent-director's call timeout kills
# the shim, the sleep left behind holds none of agent-director's pipes.
#
# Commands. The shim reads the tmux command, and each command of a chained
# call, after tmux's global options (tmux 3.2a / 3.3a: -c, -f, -L, -S and -T
# take an argument, in the same word or the next; `--` ends the options). An
# argument that ends in `;` ends a command (its text before the `;`, if any,
# is that command's last argument); one that ends in `\;` does not. A command
# name is matched as tmux matches it: the full name, its alias (`new`,
# `killp`) or a prefix no other tmux command shares (`new-s…`, `kill-ses…`,
# `kill-p…`). A call with no command and neither -c nor -V is tmux's default
# `new-session`.
#
# fail-kill's target list (a harness addition, confirm at the reconcile
# pass). Each listed target is a session name, a session id (`$N`) or a pane
# id (`%N`). A kill command's target is its `-t` value (`-t <t>`, `-t<t>`, or
# `t` last in a flag cluster such as `-at <t>`), read up to `--` or its first
# word that is not a flag; a kill with no `-t` is aimed at no listed target.
# A target and a listed one are compared after a leading `=` and everything
# from the first `:` on are dropped from each, so `=name`, `name:`, `$N` and
# `%N` (agent-director's own forms: `kill-pane -t %N`, `kill-session -t $N`)
# all match the listed `name`, `$N` or `%N`. A chained call holding one
# such kill fails whole, running none of its commands. Blank lines in the
# list are skipped.
#
# LINE FORMAT (the agent-director shim's format, fixtures/agent-director-shim.sh)
# -----------
#   <kind> TAB <time> TAB <pid> TAB <ppid> TAB <parent> TAB <words>
#
#   kind    `call`: one tmux invocation (the shim writes no other kind).
#   time    the shim's clock when it wrote the line: seconds since the epoch
#           with six decimals (bash's EPOCHREALTIME, `.` as the point).
#   pid     the shim's PID; in modes that run tmux by `exec`, tmux's own.
#   ppid    the process that ran tmux: an agent-director process, for the
#           calls agent-director makes.
#   parent  the parent's command line: the elements of /proc/<ppid>/cmdline,
#           each `printf %q`-quoted, joined by single spaces; a lone `?` when
#           it could not be read.
#   words   argv[1] onwards, each `printf %q`-quoted, joined by single spaces
#           (empty for a call with no argument).
#
# `printf %q` never writes a TAB or a newline, so every line is one record of
# six fields, and `eval "words=(${field})"` gives back each word exactly. The
# shim appends its line while it holds an exclusive lock on the log
# (`/usr/bin/flock -x`), so concurrent calls never interleave their lines.

self="$0"
[[ "${self}" == /* ]] || self="$(pwd -P)/${self}"
bin_dir="${self%/*}"
root="${bin_dir%/*}"
real="${root}/tmux.real"
mode_file="${root}/mode"
log="${root}/tmux-shim.log"
marker='# CSCB_CI_TMUX_SHIM_MARKER'

# ---------------------------------------------------------------------------
# The log line, before anything else.
# ---------------------------------------------------------------------------

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
    printf 'tmux-shim: could not append to %s; tmux was not run\n' "${log}" >&2
    exit 70
fi

# ---------------------------------------------------------------------------
# The mode.
# ---------------------------------------------------------------------------

mode=log
delay=""
# fail-kill's target list: the mode file's lines after the first (a harness
# addition, confirm at the reconcile pass).
target_lines=()
if [[ -e "${mode_file}" ]]; then
    mode=""
    if ! { { IFS=$' \t' read -r mode delay _ || [[ -n "${mode}" ]]; } && mapfile -t target_lines; } < "${mode_file}" 2> /dev/null; then
        printf 'tmux-shim: could not read the mode file %s; tmux was not run\n' "${mode_file}" >&2
        exit 70
    fi
fi
targets=()
for t in ${target_lines[@]+"${target_lines[@]}"}; do
    [[ -n "${t}" ]] && targets+=("${t}")
done
if (( ${#targets[@]} > 0 )) && [[ "${mode}" != fail-kill ]]; then
    printf 'tmux-shim: the mode file %s lists targets for mode %q; only fail-kill takes them; tmux was not run\n' "${mode_file}" "${mode}" >&2
    exit 70
fi
case "${mode}" in
    log | fail-kill | fail-create) ;;
    slow-create) : "${delay:=15}" ;;
    wedge) : "${delay:=60}" ;;
    *)
        printf 'tmux-shim: unknown mode %q in %s; tmux was not run\n' "${mode}" "${mode_file}" >&2
        exit 70
        ;;
esac
if [[ -n "${delay}" && ! "${delay}" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    printf 'tmux-shim: delay %q in %s is not a number of seconds; tmux was not run\n' "${delay}" "${mode_file}" >&2
    exit 70
fi

# wait_delay: sleep <delay> seconds with no standard stream of the caller's.
wait_delay() {
    # shellcheck disable=SC2217 # drops the caller's stdin, so a killed shim's sleep holds none of agent-director's pipes
    /usr/bin/sleep "${delay}" < /dev/null > /dev/null 2>&1
}

if [[ "${mode}" == wedge ]]; then
    wait_delay
    printf 'tmux-shim: wedge: waited %ss; tmux was not run\n' "${delay}" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# The real tmux: never the shim itself.
# ---------------------------------------------------------------------------

if [[ ! -f "${real}" || ! -x "${real}" ]]; then
    printf 'tmux-shim: no executable real tmux at %s; tmux was not run\n' "${real}" >&2
    exit 70
fi
if [[ "${real}" -ef "${self}" ]] || /usr/bin/grep -qxF -- "${marker}" "${real}" 2> /dev/null; then
    printf 'tmux-shim: %s is the shim itself, not the real tmux; tmux was not run\n' "${real}" >&2
    exit 70
fi

# ---------------------------------------------------------------------------
# The call's commands, after tmux's global options.
# ---------------------------------------------------------------------------

args=("$@")
n=$#
i=0
no_default=0
while (( i < n )); do
    a="${args[i]}"
    case "${a}" in
        --)
            i=$(( i + 1 ))
            break
            ;;
        -?*)
            # A cluster of flag letters; the first letter that takes an
            # argument takes the rest of the word, or the next word.
            next=0
            for (( j = 1; j < ${#a}; j++ )); do
                c="${a:j:1}"
                case "${c}" in
                    c | V) no_default=1 ;;
                esac
                case "${c}" in
                    c | f | L | S | T)
                        (( j + 1 == ${#a} )) && next=1
                        break
                        ;;
                esac
            done
            i=$(( i + 1 + next ))
            ;;
        *) break ;;
    esac
done

cmd_start="${i}"
commands=()
want_name=1
for (( ; i < n; i++ )); do
    a="${args[i]}"
    ends=0
    if [[ "${a}" == *';' && "${a}" != *'\;' ]]; then
        ends=1
        a="${a%;}"
    fi
    if (( want_name )) && [[ -n "${a}" ]]; then
        commands+=("${a}")
        want_name=0
    fi
    (( ends )) && want_name=1
done
if (( ${#commands[@]} == 0 && ! no_default )); then
    commands=(new-session)
fi

# is_command <word> <full-name> <alias> <shortest-unique-prefix-length>
is_command() {
    local word="$1" name="$2" alias="$3" min="$4"
    [[ "${word}" == "${name}" ]] && return 0
    [[ -n "${alias}" && "${word}" == "${alias}" ]] && return 0
    (( ${#word} >= min )) && [[ "${name}" == "${word}"* ]]
}

has_new_session=0
has_kill=0
for c in ${commands[@]+"${commands[@]}"}; do
    is_command "${c}" new-session new 5 && has_new_session=1
    is_command "${c}" kill-session "" 8 && has_kill=1
    is_command "${c}" kill-pane killp 6 && has_kill=1
done

# ---------------------------------------------------------------------------
# fail-kill's target list (a harness addition, confirm at the reconcile pass):
# whether a kill command of the call is aimed at a listed target.
# ---------------------------------------------------------------------------

# target_key <target>: print <target> without a leading `=` and without
# everything from its first `:` on.
target_key() {
    local t="${1#=}"
    printf '%s' "${t%%:*}"
}

# is_listed <target>: true when <target> matches a listed target.
is_listed() {
    local want got
    want="$(target_key "$1")"
    [[ -n "${want}" ]] || return 1
    for got in "${targets[@]}"; do
        [[ "$(target_key "${got}")" == "${want}" ]] && return 0
    done
    return 1
}

# kill_aimed_at_listed: true when a kill-session or kill-pane command of the
# call has a `-t` value that is a listed target. Each command's words run
# from its name to the argument that ends it with `;`.
kill_aimed_at_listed() {
    local k word name="" is_kill=0 flags_done=0 want_target=0 ends letters x
    for (( k = cmd_start; k < n; k++ )); do
        word="${args[k]}"
        ends=0
        if [[ "${word}" == *';' && "${word}" != *'\;' ]]; then
            ends=1
            word="${word%;}"
        fi
        if [[ -z "${name}" ]]; then
            if [[ -n "${word}" ]]; then
                name="${word}"
                is_kill=0
                flags_done=0
                want_target=0
                if is_command "${name}" kill-session "" 8 || is_command "${name}" kill-pane killp 6; then
                    is_kill=1
                fi
            fi
        elif (( is_kill )); then
            if (( want_target )); then
                is_listed "${word}" && return 0
                want_target=0
                flags_done=1
            elif (( ! flags_done )); then
                if [[ "${word}" == -- ]]; then
                    flags_done=1
                elif [[ "${word}" == -?* ]]; then
                    letters="${word:1}"
                    for (( x = 0; x < ${#letters}; x++ )); do
                        if [[ "${letters:x:1}" == t ]]; then
                            if (( x + 1 < ${#letters} )); then
                                is_listed "${letters:x+1}" && return 0
                                flags_done=1
                            else
                                want_target=1
                            fi
                            break
                        fi
                    done
                else
                    flags_done=1
                fi
            fi
        fi
        (( ends )) && name=""
    done
    return 1
}

# ---------------------------------------------------------------------------
# Act.
# ---------------------------------------------------------------------------

case "${mode}" in
    fail-kill)
        if (( has_kill )) && (( ${#targets[@]} > 0 )); then
            if kill_aimed_at_listed; then
                printf 'tmux-shim: fail-kill: a kill-session or kill-pane call aimed at a listed target fails in this mode; nothing was killed\n' >&2
                exit 1
            fi
        elif (( has_kill )); then
            printf 'tmux-shim: fail-kill: a kill-session or kill-pane call fails in this mode; nothing was killed\n' >&2
            exit 1
        fi
        ;;
    fail-create)
        if (( has_new_session )); then
            printf 'tmux-shim: fail-create: new-session fails in this mode; no session was created\n' >&2
            exit 1
        fi
        ;;
    slow-create)
        if (( has_new_session )); then
            status=0
            ( exec -a "$0" "${real}" "$@" ) || status=$?
            wait_delay
            exit "${status}"
        fi
        ;;
esac

exec -a "$0" "${real}" "$@"
