#!/bin/bash -p
# agent-director-list-refusing.sh — the fmk scenarios' agent-director stand-in
# that refuses `list` (b.jg5 SRJ-1306, SRJ-906, SRJ-1411). A harness addition. Runs only in a cscb-ci image; never run it on
# a dev box: its first step checks for the image marker /etc/cscb-ci-image
# and, when it is absent, prints one line to standard error and exits 70,
# running nothing.
#
# Scenario 9 (tests/integration/test-21-fmk-teardown.sh) needs
# `clean_restart`'s answer check after a failed teardown (one `list` of
# `service=cscb` rows, tried 3 times 2 s apart) to fail while the precheck's
# `get` and `read-pane` and the teardown's `status`, `pause` and `kill` still
# answer. The scenario places this file behind the agent-director shim with
# `swap_ad_binary <path of this file>` (lib/scenario.sh), which copies it to
# $HOME/.agent-director/bin/agent-director.real and runs the shim check, and
# puts the release back with `swap_ad_binary release`, which runs the shim
# check again. The shim logs every call before it execs this file, so a
# refused `list` is in the shim's log like any other call.
#
# What it does, for each invocation:
#   - the verb is the first argument after agent-director's global flags
#     (--store-path, --home and --tmux-command, each `--flag value` or
#     `--flag=value`, which agent-director takes from anywhere in its argv);
#   - verb `list`: it prints no result (nothing on standard output), one line
#     on standard error, and exits 1;
#   - every other verb (`version`, `get`, `read-pane`, `status`, `pause`,
#     `kill`, a hook's verbs, and a call with no verb): it replaces itself
#     with the release's binary (`exec`), with the same argv (argv[0]
#     included), standard input, output and error, so the call's output and
#     exit status are the release's.
#
# The release's binary is the image's, at the path scenario.sh's
# SCENARIO_RELEASE_BIN names (docker/Dockerfile.test.base). Like the shim it
# reads no environment variable (the client's version probe runs it with a
# scrubbed environment), and it runs under `bash -p`, so bash itself skips
# BASH_ENV, ENV and exported functions.

if [[ ! -e /etc/cscb-ci-image ]]; then
    printf '%s\n' 'agent-director-list-refusing: refused: /etc/cscb-ci-image is absent; this stand-in runs only in a cscb-ci image (/ci)' >&2
    exit 70
fi

release=/opt/agent-director/bin/agent-director
if [[ ! -f "${release}" || ! -x "${release}" ]]; then
    printf 'agent-director-list-refusing: the release binary %s is missing or not executable; nothing was run\n' "${release}" >&2
    exit 70
fi

verb=""
skip=0
for word in "$@"; do
    if (( skip )); then
        skip=0
        continue
    fi
    case "${word}" in
        --store-path | --home | --tmux-command) skip=1; continue ;;
        --store-path=* | --home=* | --tmux-command=*) continue ;;
    esac
    verb="${word}"
    break
done

if [[ "${verb}" == list ]]; then
    printf '%s\n' 'agent-director-list-refusing: list refused by the harness stand-in; no result' >&2
    exit 1
fi

exec -a "$0" "${release}" "$@"
