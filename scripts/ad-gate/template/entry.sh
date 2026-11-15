#!/usr/bin/env bash
# entry.sh — the ad-gate job's container entry point (PID 1). One container
# is one shard of the gate (scripts/ad-gate/ad-gate.ts submits one job per
# shard).
#
# First runs the permission filter regression (filter-regression.ts, with
# perm-stub-claude.sh as `claude`) against the candidate agent-director
# installed at /opt/agent-director, unless GATE_FILTER=0. Then runs CSCB's own
# in-container runner (tests/runner.sh, through CSCB's docker/entrypoint.sh,
# as testuser) on the no-model integration scripts, one shard, against the
# same candidate; with --keep-going when the packed runner takes it (v0.18.x),
# else fail-fast unless GATE_KEEP_GOING=1. Then prints each failed script's
# log tail and ends with one verdict line; PASS needs the regression (or its
# skip) and every script to pass:
#   AD-GATE PASS: claude-slack-channel-bots <v> vs agent-director <v> (<commit>): <n>/<n> no-model integration scripts passed; permission filter regression passed|skipped
#   AD-GATE FAIL: claude-slack-channel-bots <v> vs agent-director <v> (<commit>): <why>
# Exit 0 on PASS, 1 on FAIL, 2 when the job could not start (its verdict line
# is then `AD-GATE FAIL: setup: <why>`).
#
# The scheduler returns only stdout (run.log), so the driver reads these
# machine-readable lines, each at the start of its line:
#   AD-GATE-EXPECT <file>        one per script this shard runs, before the runner starts
#   AD-GATE-SCRIPT <file> <pass|fail|notrun|unfinished> <seconds|-> [<reason>]
#                                one per expected script, after the runner; the
#                                reason is the runner's notrun reason
#                                (dependency:<file>, fail-fast, unsafe-cleanup)
#   AD-GATE-RUNNER <done|deadline|exited>
#                                exactly once: how the wait for the runner
#                                ended (its done marker, so its final cleanup
#                                was verified; GATE_DEADLINE_S with the runner
#                                still going; or the runner ending without the
#                                marker)
#   AD-GATE-FILTER <pass|fail|skipped>
#                                exactly once, before the verdict line
#
# Arguments: optional script names (test-<n> or the file name) to run instead
# of the default set; test-1 is always added, and test-2 when test-3 is.
# Default set: every tests/integration/test-*.sh except the -fmk-real-
# scripts (native Claude/Codex, need a model key) and test-13 (its switch-over
# installs from an empty bun cache, so it needs the npm registry).
# GATE_DEADLINE_S (default 16200) stops the run early with a FAIL verdict,
# so the verdict is still printed before the scheduler's own timeout.
# GATE_KEEP_GOING=1 (default 0) runs every script even with an older runner
# that has no --keep-going (it patches the image's copy of tests/runner.sh).
# GATE_FILTER=0 (default 1) skips the permission filter regression, so only
# one shard of a gate runs it.
# GATE_INJECT_FAIL="<file> ..." (default empty) passes the runner's own
# `--fail <file>` for each: the script is recorded failed without running.
# A fault-injection seam for verifying the gate, never for a release.
set -uo pipefail

TESTS=/tests/integration
RESULTS=/test-results
MANIFEST=/opt/ad-gate/inputs/manifest.json
DEADLINE_S="${GATE_DEADLINE_S:-16200}"

say() { printf 'ad-gate: %s\n' "$*"; }
setup_fail() { say "setup failed: $*"; printf 'AD-GATE FAIL: setup: %s\n' "$*"; exit 2; }

[[ "${DEADLINE_S}" =~ ^[1-9][0-9]*$ ]] || setup_fail "GATE_DEADLINE_S '${DEADLINE_S}' is not a whole number"
GATE_FILTER="${GATE_FILTER:-1}"
[[ "${GATE_FILTER}" =~ ^[01]$ ]] || setup_fail "GATE_FILTER '${GATE_FILTER}' is not 0 or 1"
CSCB_VERSION="$(jq -r '.cscb.version' "${MANIFEST}")" || setup_fail "no manifest"
AD_JSON="$(agent-director version)" || setup_fail "agent-director version failed"
AD_VERSION="$(jq -r '.version' <<< "${AD_JSON}")"
AD_COMMIT="$(jq -r '.commit' <<< "${AD_JSON}")"
SUBJECT="claude-slack-channel-bots ${CSCB_VERSION} vs agent-director ${AD_VERSION} (${AD_COMMIT:0:12})"

say "subject: ${SUBJECT}"
say "manifest: $(jq -c . "${MANIFEST}")"
say "release record: $(jq -c . /opt/agent-director/client/release.json)"
say "network: $(ls /sys/class/net | tr '\n' ' ')"
say "bun $(bun --version), node $(node --version), tmux $(tmux -V)"

# --- Informational: the candidate's own npm client against its binary ------
if [[ -d /opt/ad-gate/candidate-client ]]; then
    probe_home="$(mktemp -d)"
    chown testuser "${probe_home}"
    if out="$(cd / && gosu testuser env HOME="${probe_home}" bun --no-install -e '
const { Client } = await import("/opt/ad-gate/candidate-client/dist/index.js")
const c = await Client.create()
try { process.stdout.write(String(c.binaryVersion)) } finally { c.close() }
' 2>&1)"; then
        floor="$(jq -r '.min_binary_version' /opt/ad-gate/candidate-client/dist/version-floor.json)"
        say "candidate client $(jq -r .version /opt/ad-gate/candidate-client/package.json) (floor ${floor}): Client.create() reports binary ${out} (informational; shipped CSCB uses its pinned client)"
    else
        say "candidate client: Client.create() failed (informational): ${out%%$'\n'*}"
    fi
    rm -rf "${probe_home}"
fi

# --- The permission filter regression ------------------------------------
# A real candidate row, at the candidate's default [state] timeouts, held in a
# fallen-back permission request for more than 30 s, must still be found by
# shipped CSCB's own prompt query (filter-regression.ts states the steps). Its
# own scratch HOME and tmux server; everything it starts ends before the
# runner starts. Sets FILTER_LINE.
run_filter_regression() {
    FILTER_ROOT="$(mktemp -d /tmp/ad-gate-filter.XXXXXX)" || setup_fail "mktemp for the filter regression"
    mkdir -p "${FILTER_ROOT}/home" "${FILTER_ROOT}/bin" "${FILTER_ROOT}/tmux" "${FILTER_ROOT}/work"
    install -m 0755 /opt/ad-gate/perm-stub-claude.sh "${FILTER_ROOT}/bin/claude"
    chmod 0700 "${FILTER_ROOT}/tmux"
    chown -R testuser:testuser "${FILTER_ROOT}"
    filter_env=(env -i HOME="${FILTER_ROOT}/home" USER=testuser LOGNAME=testuser TMUX_TMPDIR="${FILTER_ROOT}/tmux"
        PATH="${FILTER_ROOT}/bin:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8)
    FILTER_LINE=''
    if ! out="$(cd "${FILTER_ROOT}/home" && gosu testuser "${filter_env[@]}" /opt/agent-director/install/install.sh \
            --binary /opt/agent-director/bin/agent-director --admin-binary /opt/agent-director/admin/agent-director-admin \
            --no-symlink --no-hooks < /dev/null 2>&1)"; then
        printf '%s\n' "${out}" | tail -n 20 | sed 's/^/ad-gate: install.sh | /'
        FILTER_LINE='FILTER-REGRESSION FAIL: setup: the candidate install.sh failed in the scratch HOME'
    elif grep -Eq '^[[:space:]]*(needs_intelligence_timeout_seconds|idle_screen_timeout_seconds|settle_ms)[[:space:]]*=' \
            "${FILTER_ROOT}/home/.config/agent-director/config.toml" 2> /dev/null; then
        FILTER_LINE='FILTER-REGRESSION FAIL: setup: the scratch config.toml sets a [state] key; the regression needs the defaults'
    else
        say "filter regression: candidate installed in ${FILTER_ROOT}/home with default [state] settings"
        while IFS= read -r line; do
            printf 'ad-gate: %s\n' "${line}"
            [[ "${line}" == FILTER-REGRESSION* ]] && FILTER_LINE="${line}"
        done < <(cd /test-repo && timeout -k 10 300 gosu testuser "${filter_env[@]}" \
            bun /opt/ad-gate/filter-regression.ts "${FILTER_ROOT}/bin" "${FILTER_ROOT}/work" 2>&1)
        [[ -n "${FILTER_LINE}" ]] || FILTER_LINE='FILTER-REGRESSION FAIL: the regression printed no verdict (crashed or timed out)'
    fi
    if [[ -f "${FILTER_ROOT}/bin/perm-stub.log" ]]; then
        sed 's/^/ad-gate: perm-stub | /' "${FILTER_ROOT}/bin/perm-stub.log"
    fi
    gosu testuser env TMUX_TMPDIR="${FILTER_ROOT}/tmux" tmux kill-server > /dev/null 2>&1 || true
    pkill -KILL -u testuser > /dev/null 2>&1 || true
}
if (( GATE_FILTER )); then
    run_filter_regression
else
    FILTER_LINE='FILTER-REGRESSION SKIPPED: GATE_FILTER=0, another shard of this gate runs it'
fi
say "filter regression: ${FILTER_LINE}"
# FILTER_OUTCOME is the AD-GATE-FILTER word; FILTER_PASS lets the verdict pass.
FILTER_OUTCOME=fail
[[ "${FILTER_LINE}" == 'FILTER-REGRESSION PASS:'* ]] && FILTER_OUTCOME=pass
(( GATE_FILTER )) || FILTER_OUTCOME=skipped
FILTER_PASS=0
[[ "${FILTER_OUTCOME}" != fail ]] && FILTER_PASS=1

# --- The scripts ------------------------------------------------------------
number_of() { local n="${1#test-}"; printf '%s' "${n%%-*}"; }
declare -A chosen=()
if (( $# )); then
    for want in "$@"; do
        [[ "${want}" =~ ^test-(0|[1-9][0-9]*)(-[a-z0-9-]+\.sh)?$ ]] || setup_fail "'${want}' is not test-<n> or a script file name"
        match=''
        for f in "${TESTS}"/test-"${BASH_REMATCH[1]}"-*.sh; do
            [[ -f "${f}" ]] || continue
            name="${f##*/}"
            [[ "${want}" == "test-${BASH_REMATCH[1]}" || "${want}" == "${name}" ]] && match="${name}"
        done
        [[ -n "${match}" ]] || setup_fail "no script matches '${want}'"
        chosen[${match}]=1
    done
else
    for f in "${TESTS}"/test-*.sh; do
        name="${f##*/}"
        [[ "${name}" == *-fmk-real-* || "${name}" == test-13-* ]] && continue
        chosen[${name}]=1
    done
fi
for f in "${TESTS}"/test-1-*.sh; do chosen[${f##*/}]=1; done
for name in "${!chosen[@]}"; do
    if [[ "${name}" == test-3-* ]]; then for f in "${TESTS}"/test-2-*.sh; do chosen[${f##*/}]=1; done; fi
done
# Canonical order: test-1, test-2, test-3, test-4, then ascending number.
scripts=()
for n in 1 2 3 4; do
    for name in "${!chosen[@]}"; do [[ "$(number_of "${name}")" == "${n}" ]] && scripts+=("${name}"); done
done
while IFS= read -r name; do scripts+=("${name}"); done < <(
    for name in "${!chosen[@]}"; do
        n="$(number_of "${name}")"
        (( n >= 1 && n <= 4 )) || printf '%s %s\n' "${n}" "${name}"
    done | sort -n | cut -d' ' -f2)
say "scripts (${#scripts[@]}): ${scripts[*]}"

# GATE_INJECT_FAIL: each name must be a file name this shard runs.
inject_flags=()
read -r -a inject_names <<< "${GATE_INJECT_FAIL:-}"
for name in "${inject_names[@]}"; do
    [[ -n "${chosen[${name}]:-}" ]] || setup_fail "GATE_INJECT_FAIL names '${name}', which is not a script file name this shard runs"
    inject_flags+=(--fail "${name}")
done
if (( ${#inject_flags[@]} )); then
    grep -qF "RUNNER_FAIL_OPTION='--fail'" /tests/runner.sh || setup_fail "GATE_INJECT_FAIL: this runner has no --fail option"
    say "GATE_INJECT_FAIL: the runner records ${GATE_INJECT_FAIL} failed without running them"
fi

for name in "${scripts[@]}"; do printf 'AD-GATE-EXPECT %s\n' "${name}"; done

# --- Run CSCB's runner -------------------------------------------------------
touch /run/cscb-ci-performance.lock
canary="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
mkdir -p /tmp/ad-gate
TICK=/tmp/ad-gate/tick
mkfifo "${TICK}" || setup_fail "mkfifo"
exec 3<> "${TICK}"

# The packed tests' runner decides the flags: v0.18.x takes --keep-going;
# older runners (v0.17.x) have no such flag and stop at the first failure.
# GATE_KEEP_GOING=1 makes an older runner keep going too: its one fail-fast
# guard, `if (( failed )); then` before each script, is disabled in the
# image's copy of the runner, so every script runs and reports.
[[ "${GATE_KEEP_GOING:-0}" =~ ^[01]$ ]] || setup_fail "GATE_KEEP_GOING '${GATE_KEEP_GOING}' is not 0 or 1"
runner_flags=()
KEEP_GOING=0
if grep -q -- '\[--keep-going\]' /tests/runner.sh; then
    runner_flags=(--keep-going)
    KEEP_GOING=1
    say "runner interface: --keep-going supported"
elif [[ "${GATE_KEEP_GOING:-0}" == 1 ]]; then
    guard='^    if \(\( failed \)\); then$'
    [[ "$(grep -cE "${guard}" /tests/runner.sh)" == 1 ]] \
        || setup_fail "GATE_KEEP_GOING=1: /tests/runner.sh has no single fail-fast guard to disable"
    sed -i -E "s/${guard}/    if (( 0 )); then  # ad-gate GATE_KEEP_GOING=1/" /tests/runner.sh \
        || setup_fail "GATE_KEEP_GOING=1: could not patch /tests/runner.sh"
    grep -qF 'if (( 0 )); then  # ad-gate GATE_KEEP_GOING=1' /tests/runner.sh \
        || setup_fail "GATE_KEEP_GOING=1: the runner patch did not take"
    KEEP_GOING=1
    say "runner interface: no --keep-going; GATE_KEEP_GOING=1 disabled the runner's fail-fast guard, so every script runs"
else
    say "runner interface: no --keep-going; the runner stops at its first failure"
fi

/usr/local/bin/entrypoint.sh 1 "${canary}" "${runner_flags[@]}" "${inject_flags[@]}" "${scripts[@]}" &
runner=$!
say "runner pid ${runner}; deadline ${DEADLINE_S} s"

# Builtins only from here until the runner is stopped: the runner kills every
# process born after it, so this loop forks nothing.
shown=0
finished=0
SECONDS=0
while :; do
    read -r -t 15 -u 3 _
    count=0
    if [[ -f "${RESULTS}/result.txt" ]]; then
        while IFS= read -r line; do
            count=$(( count + 1 ))
            if (( count > shown )); then
                printf 'ad-gate: [%5d s] %s\n' "${SECONDS}" "${line}"
                shown=${count}
            fi
            [[ "${line}" == done ]] && finished=1
        done < "${RESULTS}/result.txt"
    fi
    (( finished )) && break
    kill -0 "${runner}" 2>/dev/null || break
    (( SECONDS >= DEADLINE_S )) && break
done
elapsed=${SECONDS}
runner_alive=0
kill -0 "${runner}" 2>/dev/null && runner_alive=1
kill -KILL "${runner}" 2>/dev/null
wait "${runner}" 2>/dev/null

# --- Summary -----------------------------------------------------------------
declare -A outcome=() seconds=() notrun_reason=()
passed=(); failed=(); notrun=()
if [[ -f "${RESULTS}/result.txt" ]]; then
    while read -r word name rest; do
        case "${word}" in
            end) outcome[${name}]="${rest%% *}"
                 secs="${rest#"${rest%% *}"}"; seconds[${name}]="${secs# }"
                 if [[ "${rest%% *}" == pass ]]; then passed+=("${name}"); else failed+=("${name}"); fi ;;
            notrun) outcome[${name}]=notrun
                    notrun_reason[${name}]="${rest:-fail-fast}"
                    if [[ -n "${rest}" ]]; then notrun+=("${name} (${rest})")
                    else notrun+=("${name} (fail-fast)")
                    fi ;;
        esac
    done < "${RESULTS}/result.txt"
fi
unfinished=()
for name in "${scripts[@]}"; do [[ -n "${outcome[${name}]:-}" ]] || unfinished+=("${name}"); done

# ad-gate-0172: the scheduler retrieves only stdout, so print each failed or
# unfinished script's whole log, with begin/end markers and its line count.
for name in "${failed[@]}" "${unfinished[@]}"; do
    log="${RESULTS}/${name}.log"
    if [[ ! -s "${log}" ]]; then say "----- ${name}.log: missing or empty -----"; continue; fi
    say "----- BEGIN full ${name}.log ($(wc -l < "${log}") lines, $(wc -c < "${log}") bytes) -----"
    cat "${log}"
    say "----- END full ${name}.log -----"
done

# Also keep per-script evidence in the scheduler output volume.
mkdir -p /out/test-results && cp -a /test-results/. /out/test-results/ || say "could not copy /test-results to /out"
cp /opt/ad-gate/inputs/manifest.json /out/manifest.json || say "could not copy the manifest to /out"
printf '%s\n' "${FILTER_LINE}" > /out/filter-verdict.txt
printf '%s\n' "${scripts[@]}" > /out/expected-scripts.txt
printf '%s\n' "${AD_JSON}" > /out/ad-version.json
say "----- summary after ${elapsed} s -----"
for name in "${scripts[@]}"; do
    secs="$(awk -v n="${name}" '$1 == "end" && $2 == n {print $4}' "${RESULTS}/result.txt" 2>/dev/null)"
    say "$(printf '%-8s %-45s %s' "${outcome[${name}]:-unfinished}" "${name}" "${secs:+${secs} s}")"
done

say "filter regression: ${FILTER_LINE}"

# The machine-readable outcome lines, one per expected script, then the filter's.
for name in "${scripts[@]}"; do
    case "${outcome[${name}]:-unfinished}" in
        notrun) printf 'AD-GATE-SCRIPT %s notrun - %s\n' "${name}" "${notrun_reason[${name}]%% *}" ;;
        unfinished) printf 'AD-GATE-SCRIPT %s unfinished -\n' "${name}" ;;
        *) printf 'AD-GATE-SCRIPT %s %s %s\n' "${name}" "${outcome[${name}]}" "${seconds[${name}]:--}" ;;
    esac
done
runner_end=exited
if (( finished )); then runner_end=done
elif (( runner_alive )); then runner_end=deadline
fi
printf 'AD-GATE-RUNNER %s\n' "${runner_end}"
printf 'AD-GATE-FILTER %s\n' "${FILTER_OUTCOME}"

total=${#scripts[@]}
if (( FILTER_PASS && finished )) && (( ${#failed[@]} == 0 && ${#notrun[@]} == 0 && ${#unfinished[@]} == 0 && ${#passed[@]} == total )); then
    filter_word=passed
    (( GATE_FILTER )) || filter_word='skipped (another shard runs it)'
    printf 'AD-GATE PASS: %s: %d/%d no-model integration scripts passed; permission filter regression %s\n' "${SUBJECT}" "${#passed[@]}" "${total}" "${filter_word}"
    exit 0
fi
why=''
(( FILTER_PASS )) || why="permission filter regression failed (${FILTER_LINE#FILTER-REGRESSION FAIL: }); "
why+="${#passed[@]}/${total} scripts passed"
(( ${#failed[@]} )) && why+="; failed: ${failed[*]}"
(( ${#notrun[@]} )) && why+="; not run: ${notrun[*]}"
if (( ! finished )); then
    if (( runner_alive )); then why+="; stopped at the ${DEADLINE_S} s deadline, unfinished: ${unfinished[*]:-none}"
    else why+="; the runner ended without its done marker (cleanup not verified), unfinished: ${unfinished[*]:-none}"
    fi
fi
printf 'AD-GATE FAIL: %s: %s\n' "${SUBJECT}" "${why}"
exit 1
