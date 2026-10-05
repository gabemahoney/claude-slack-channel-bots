#!/bin/bash -p
# CSCB_CI_AD_VERSION_STAND_IN_MARKER
#
# ad-version-stand-in.sh — an agent-director binary that reports a chosen
# version (harness addition, scenario 8: test-20-fmk-old-binary.sh; b.jg5
# SRJ-1410). Runs only in a cscb-ci image, where
# tests/integration/lib/scenario.sh installs it; never run it on a dev box.
#
# scenario.sh puts it behind the agent-director shim, at
# $HOME/.agent-director/bin/agent-director.real: `install_ad_stand_in`
# through the swap (`swap_ad_binary`), and `restore_ad_install_with_stand_in`
# when it brings back the shim that `hide_ad_install` moved aside. The line
# above is its marker; both helpers check for it after the install.
#
# What it does:
# - `version` (the client's version probe runs `version --json`): it runs the
#   release binary with the same arguments and prints its output with the
#   `version` field replaced by the configured version, the release's own
#   commit and every other field kept, in the release's output shape (one
#   compact JSON object). With `report=unparseable` it prints, and exits 0
#   with, one line that is no JSON, which no agent-director client parses
#   (`ErrSystemInstallUnreachable`, reason `unparseable-version`).
# - Every other call: it execs the release binary with the same argv
#   (argv[0] apart), standard input, output and error, and exit status.
# - With `reuse_finished=reject`, before that exec every argument
#   `--reuse-finished` or `-reuse-finished`, with or without `=<value>`,
#   becomes `--reuse-finished-rejected-by-stand-in` (its `=<value>` kept): a
#   flag the release does not define, whose name holds `reuse-finished`, so
#   the release itself answers its own `ErrInvalidFlags` envelope naming it.
#   No other argument changes.
# The verb is the first argument after agent-director's global flags
# (--store-path, --home, --tmux-command, as `--flag value` or `--flag=value`).
#
# Settings. Fixed when it is installed, in the file found from its own path:
# `<its own path>.settings` (agent-director.real.settings, beside it). One
# `key=value` per line (the value is everything after the first `=`); blank
# lines and lines starting with `#` are skipped:
#   report=version | unparseable   what `version` prints
#   version=<string>               the version to report (report=version
#                                  only; any string: a release, a
#                                  pre-release such as <floor>-rc.1,
#                                  0.0.0-dev, dev)
#   reuse_finished=reject | pass   whether the reuse flag is rejected
#   release_bin=<absolute path>    the release binary every call is handed
#                                  to (the image's fixed release path, never
#                                  found through PATH)
# A missing, unreadable or invalid settings file, a missing key or an
# unknown one runs nothing: one `ad-version-stand-in:` line on standard error
# and exit 70.
#
# It reads no environment variable, since the client's version probe runs it
# with cwd / and a scrubbed environment: it finds its settings from its own
# path ($0, which the kernel sets to the script's own path whatever argv[0]
# the shim passes), refuses outside the image by the marker file, calls its
# external tools by absolute path, runs jq with an empty environment, and
# runs under `bash -p`, so bash itself skips BASH_ENV, ENV and exported
# functions. The environment it was given passes, untouched, to the release
# binary it execs.

self="$0"
[[ "${self}" == /* ]] || self="$(pwd -P)/${self}"

refuse() {
    printf 'ad-version-stand-in: %s; agent-director was not run\n' "$1" >&2
    exit 70
}

[[ -e /etc/cscb-ci-image ]] || refuse "/etc/cscb-ci-image is absent: this stand-in runs only in a cscb-ci image"

settings="${self}.settings"
[[ -f "${settings}" && -r "${settings}" ]] || refuse "no readable settings file at ${settings}"

report=""
version=""
version_set=0
reuse=""
release=""
while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" || "${line}" == '#'* ]] && continue
    [[ "${line}" == *=* ]] || refuse "settings line '${line}' is not key=value"
    key="${line%%=*}"
    value="${line#*=}"
    case "${key}" in
        report) report="${value}" ;;
        version) version="${value}"; version_set=1 ;;
        reuse_finished) reuse="${value}" ;;
        release_bin) release="${value}" ;;
        *) refuse "unknown settings key '${key}' in ${settings}" ;;
    esac
done < "${settings}"

case "${report}" in
    version) [[ "${version_set}" == 1 && -n "${version}" ]] || refuse "report=version with no version in ${settings}" ;;
    unparseable) ;;
    *) refuse "report '${report}' is neither version nor unparseable in ${settings}" ;;
esac
[[ "${reuse}" == reject || "${reuse}" == pass ]] \
    || refuse "reuse_finished '${reuse}' is neither reject nor pass in ${settings}"
[[ "${release}" == /* && -f "${release}" && -x "${release}" ]] \
    || refuse "release_bin '${release}' is not an absolute path to an executable file"
[[ "${release}" != "${self}" ]] || refuse "release_bin names the stand-in itself"

# The verb: the first argument after agent-director's global flags.
verb=""
skip=0
for arg in "$@"; do
    if (( skip )); then
        skip=0
        continue
    fi
    case "${arg}" in
        --store-path | --home | --tmux-command) skip=1; continue ;;
        --store-path=* | --home=* | --tmux-command=*) continue ;;
    esac
    verb="${arg}"
    break
done

if [[ "${verb}" == version ]]; then
    if [[ "${report}" == unparseable ]]; then
        printf 'ad-version-stand-in: this binary reports no version\n'
        exit 0
    fi
    out="$("${release}" "$@")"
    rc=$?
    if (( rc != 0 )); then
        printf '%s\n' "${out}"
        exit "${rc}"
    fi
    rewritten="$(printf '%s\n' "${out}" | /usr/bin/env -i /usr/bin/jq -c --arg v "${version}" \
        'if type == "object" and has("version") then .version = $v else error("no version field") end')" \
        || refuse "the release's version output is not a JSON object with a version field"
    printf '%s\n' "${rewritten}"
    exit 0
fi

args=()
for arg in "$@"; do
    if [[ "${reuse}" == reject && "${arg}" =~ ^--?reuse-finished(=.*)?$ ]]; then
        args+=("--reuse-finished-rejected-by-stand-in${BASH_REMATCH[1]}")
    else
        args+=("${arg}")
    fi
done

exec "${release}" ${args[@]+"${args[@]}"}
