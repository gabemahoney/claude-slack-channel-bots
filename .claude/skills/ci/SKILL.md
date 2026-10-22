---
name: ci
description: Run the CSCB integration scripts in parallel docker shards. Launches the host runner detached, polls it with the verdict reader, and relays the reader's report and exit code (0 for a full PASS).
user-invocable: true
allowed-tools: [Bash]
---

# /ci

This suite never connects to Slack. The live Slack acceptance run against the
test workspace is `/ci-live` (`.claude/skills/ci-live/SKILL.md`).

`/ci` runs every integration script in `tests/integration` in up to 6 capped,
isolated docker shards. The host runner, `scripts/ci-run.ts`, does all the
work. The verdict reader, `scripts/ci-verdict.ts`, decides the outcome. This
skill only launches the runner, polls it, stops it if it outlives its
deadline, and relays the reader's report. It holds no verdict mapping of its
own.

Run every command below from the worktree root, the directory that holds
`scripts/ci-run.ts`.

## Interface

```text
/ci [--keep-going] [--shards N] [--shard-timeout MINUTES] [--inject FAULT]... [SCRIPT]...
```

| Argument | Meaning |
|---|---|
| `--keep-going` | Continue independent scripts after verified cleanup, retaining every failure. Default: fail-fast within each shard |
| `--shards N` | Run exactly the effective N shards (see [How N is chosen](#how-n-is-chosen)), or be refused. N is a whole number from 1 to 6 |
| `--shard-timeout MINUTES` | Every shard's wall-time limit, in place of the computed one. A whole number from 1 to 720 |
| `--inject FAULT` | Turn on one fault (see [Fault injection](#fault-injection)). May be repeated; an identical fault given twice counts once |
| `SCRIPT` | Select a script: its number form `test-<n>` or its whole file name, such as `test-3` or `test-3-cozempic-restart.sh`. Any SCRIPT makes the run selective |

Argument rules:

- Arguments may come in any order, options and SCRIPT names mixed. The order
  changes nothing but the order of faults in the `INJECTED (<faults>)` wrapper.
- Except `--keep-going`, each option takes the next argument as its value (`--shards 3`).
  `--shards=3`, an option given last with no value, an unknown option and any
  other argument beginning `-` are bad arguments.
- A whole number is decimal digits with no sign, no decimal point and no
  leading zero.
- `--keep-going`, `--shards` and `--shard-timeout` may each appear once. A second appearance
  is a bad argument, even with the same value.
- A number form matches only the script with exactly that number, so `test-2`
  never matches `test-20`. A script named more than once, in either form,
  runs once.
- Run options come only from these arguments. No environment variable or
  file sets one.

Run kinds:

- `/ci` with no arguments is the default full run: every script, as many
  shards as admission allows up to 6, default limits, no faults. It is what
  `/publish` and `/publish-prepare` run.
- A full run (no SCRIPT) without `--inject` is gate-eligible, with or without
  `--keep-going`, `--shards` or `--shard-timeout`, whatever N admission picks.
  Keep-going passes only with zero failures, complete coverage from both
  tracks, and all integrity and cleanup checks passing.
- A selective run (any SCRIPT) or an injected run (any `--inject`) is never a
  gate result.

## Outcomes and exit codes

The verdict reader produces every row but the last, in this precedence. The
last row, verdict reader failed, is this skill's own. This table is
documentation only: the reader, not the skill, applies the mapping.

| Outcome | Exit | Report |
|---|---|---|
| Not runnable | 2 | `NOT RUN: <reason>`, then its detail lines. No verdict is written |
| Runner died, or verdict missing or invalid | 1 | `test runner did not write a valid verdict.txt`; then `results: <run dir>` when the directory exists; then the last 40 lines of the runner log when it exists; then, when the skill signalled the runner at grace expiry, `runner <PID> still alive after the <m> min deadline plus grace: sent SIGTERM`, ending `, then SIGKILL after 30 s` for `kill:<m>` |
| Any run with `--inject` | 4 | `INJECTED (not a gate result): <verdict line>`, then `results: <run dir>` |
| Selective PASS | 3 | `SELECTIVE (not a gate result): PASS: <scripts>`, then the timing summary |
| Selective FAIL | 1 | `SELECTIVE (not a gate result): <FAIL line>`, then `results: <run dir>` |
| Full PASS | 0 | `✓ Integration tests passed.`, then the timing summary |
| Full FAIL | 1 | `<verdict line>`, then `results: <run dir>` |
| Verdict reader failed (the skill's own) | 1 | One of the two `verdict reader failed:` lines in [Unknown exits](#unknown-exits). No verdict is read |

- `<verdict line>` is the first line of the run's `verdict.txt`, wrapper
  included. `<FAIL line>` is a selective verdict line without its leading
  `SELECTIVE (<scripts>): `.
- `<scripts>` is the run's scripts as number forms in canonical order,
  separated by single spaces, test-1 included.
- A selective or injected invocation never gets `✓ Integration tests passed.`.
- Only exit 0 with `✓ Integration tests passed.` is a gate PASS.
- When a PASS's timing summary cannot be read, the report prints the PASS
  line, then `timing summary could not be read from <run dir>/results.json`,
  keeps the run directory and keeps the PASS exit code.

Run-level stops and image build failures are FAIL lines like any other. They
appear inside the `SELECTIVE` prefix or the `INJECTED` wrapper where those
apply:

| Line | Cause |
|---|---|
| `FAIL: interrupted: <signal>` | The runner got `SIGINT`, `SIGTERM` or `SIGHUP` (see [Cancelling a run](#cancelling-a-run)) |
| `FAIL: run deadline: <phase> still running at the <m> min deadline` | The run passed its deadline; phase is `build`, `shards` or `merge`, and m is the deadline's minutes from the runner's start |
| `FAIL: memory watchdog: pod non-reclaimable memory <x> GiB reached the <y> GiB stop line (<ceiling source>; <per-shard detail>; reclaimable page cache excluded)` | The pod non-reclaimable memory reached the stop line (see [Admission](#admission)) |
| `FAIL: image build: base image build failed (exit <code>)` | `scripts/ci-base-build.sh` failed (see [The base image](#the-base-image)) |
| `FAIL: image build: test image build failed (exit <code>)` | The run's test image build failed; its output is in `runner.log` |
| `FAIL: ci-run: internal error: <error>` | The runner met an error of its own after the run started. The run directory and `runner.log` are kept; report it as a runner bug |

Every other verdict line (script lines, shard end lines, out-of-memory lines,
integrity failures) and which one wins are in
[`tests/README.md`'s Verdict file format](../../../tests/README.md#verdict-file-format).

## Procedure

The procedure has exactly four kinds of Bash call: the launch, a wait, a stop
and a report. Shell variables do not survive from one Bash call to the next,
so carry the printed RUN_ID and PID into each later command as literal text.
The runner and every reader call inherit the same `CI_ANTHROPIC_*`
environment directly; see [Credentials](#credentials). No host remapping is needed.

### 1. Launch

Make the RUN_ID, then launch the runner detached, in one Bash call. Put each
`/ci` argument in place of `<the /ci arguments>` as its own single-quoted
word, unchanged and in the order given; with no arguments, put nothing there.

```sh
RUN_ID="$(date -u +%Y%m%dt%H%M%Sz)-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8)"
TMP_ROOT="${TMPDIR:-/tmp}"
RUN_DIR="${TMP_ROOT%/}/cscb-ci-${RUN_ID}"
set +m
setsid bun scripts/ci-run.ts "${RUN_ID}" <the /ci arguments> </dev/null >/dev/null 2>&1 &
RUNNER_PID=$!
echo "RUN_ID: ${RUN_ID}"
echo "runner PID: ${RUNNER_PID:--}"
echo "run directory: ${RUN_DIR}"
```

- **The RUN_ID** is `<YYYYMMDD>t<HHMMSS>z-<suffix>`: the UTC date and time at
  launch, then 8 random lowercase letters or digits.
- **The run directory** is `cscb-ci-<RUN_ID>` in `$TMPDIR` when it is set and
  not empty, else `/tmp`, a trailing slash ignored. The runner and the reader
  derive it the same way.
- **Detached.** `setsid` puts the runner in its own session, and its standard
  input, output and error are on none of the Bash call's streams, so the call
  returns at once. Ending the calling session sends the runner no signal.
- **The PID.** The printed PID is the runner process's own, never a
  wrapper's or a shell's. The Bash tool's shell runs with job control on,
  which makes a background job its own process-group leader, and `setsid`
  forks when started as one, so `$!` would name a parent that exits at once.
  `set +m` turns job control off for this call, so the background `setsid` is
  no process-group leader and execs `bun` in place without forking. When the launch yields no PID, the launch prints `-`
  in its place; use `-` wherever `<PID>` appears below. The reader always
  prefers the PID the runner records in its status file.
- The runner writes everything it reports to `runner.log` in the run
  directory, starting with `ci-run: run <RUN_ID> pid <PID>: /ci <args>`. A
  refused run prints nothing on the terminal; the reader reports it.

### 2. Poll

Run one wait per Bash call, substituting the printed RUN_ID and PID:

```sh
bun scripts/ci-verdict.ts wait <RUN_ID> <PID>; echo "wait exit: $?"
```

Act on its exit code:

| Wait exit | Next step |
|---|---|
| 0 | Run the wait again |
| 10, 11 or 12 | The grace is `none`; go to step 4 |
| 13 | Go to step 3 |
| any other, or no exit code | An unknown exit (see [Unknown exits](#unknown-exits)) |

The wait verb, not the skill, applies the run's deadline and the 10 min of
grace. The skill keeps no clock or deadline count across calls.

### 3. Stop at grace expiry

Only after a wait exit of 13, run:

```sh
bun scripts/ci-verdict.ts stop <RUN_ID> <PID>; echo "stop exit: $?"
```

Take the grace from the stop line's `grace <grace>`: `none` after exit 0,
`term:<m>` after 20, `kill:<m>` after 21. Then go to step 4. An exit other
than 0, 20 or 21 is an unknown stop exit (see [Unknown exits](#unknown-exits)).

A runner killed this way is a dead runner, so the next `/ci` run's sweep
removes its containers, reservation and tags.

### 4. Report

Run the report once, with the grace from step 2 or 3 and the same `/ci`
arguments as the launch, each its own single-quoted word:

```sh
bun scripts/ci-verdict.ts report <RUN_ID> <PID> <grace> <the /ci arguments>; echo "report exit: $?"
```

Relay the report's output unchanged, every line before the `report exit:`
line this call adds, and end `/ci` with the exit code that line shows. Add
nothing, drop nothing and map nothing: the report is `/ci`'s result.

### Unknown exits

- **Wait.** An unknown exit is a wait exit other than 0, 10, 11, 12 and 13,
  or a wait call that the Bash tool stopped or moved to the background before
  the verb exited. After one, run the wait again; the verb holds no state, so
  this is safe. After 3 unknown exits in a row, stop polling, run neither the
  stop nor the report, and end `/ci` with exit code 1 and this one line:

  ```text
  verdict reader failed: wait exited <code> 3 times in a row; runner <PID> may still be running; finish the run as "Finishing a run by hand" says
  ```

- **Stop.** An unknown stop exit is a stop exit other than 0, 20 and 21, or a
  stop call that the Bash tool stopped or moved to the background before the
  verb exited. After one, run the stop again; it signals only a live `/ci`
  runner with this RUN_ID. Make at most 3 stop calls in all, and take the
  grace from the first known exit. When all 3 exits are unknown, run no
  report, and end `/ci` with exit code 1 and this one line:

  ```text
  verdict reader failed: stop exited <code> 3 times in a row; runner <PID> may still be running; finish the run as "Finishing a run by hand" says
  ```

In both lines, `<code>` is the last exit code (`none` for a call that gave
none) and `<PID>` is the printed runner PID or `-`. Neither case ever gives
the runner-died report, and the skill sends the runner no further signal.

### No timeout, no sleep

No Bash call in this procedure sets a `timeout` parameter, runs `sleep` or
uses the Bash tool's background mode; the launch's own `&` detaches only the
runner, and the call itself returns at once. Each call ends well within the
Bash tool's 120 s default timeout:

- the launch and the report return within seconds;
- a wait returns within 90 s plus its start-up;
- a stop returns within 30 s plus its start-up.

None comes near the Bash tool's 10 min limit. The wait's 90 s bound assumes
that default timeout of 120 s, which holds while `BASH_DEFAULT_TIMEOUT_MS` is
unset. A lower default ends waits early; each such call counts as an unknown
exit, so polling fails visibly and never gives a wrong outcome.

### What polling costs

Each wait is one Bash call, and so one model turn of the calling session,
`/publish` and `/publish-prepare` included. That cost is accepted.

A run of m minutes takes about m × 60 ÷ 90 wait calls, plus one per
phase change (at most two), besides launch, report and, after grace,
stop. Use the reader's actual deadline; the dedicated Codex shard and
its login wait change the full-run estimate. A mixed full run cannot
use `--shards 1`.

## The verdict reader's verbs

```text
bun scripts/ci-verdict.ts report <RUN_ID> <PID> <grace> [<the /ci arguments>]
bun scripts/ci-verdict.ts wait <RUN_ID> <PID>
bun scripts/ci-verdict.ts stop <RUN_ID> <PID>
```

- `<PID>` is the runner PID the launch printed, or `-` when it printed none.
  For every verb, the runner's PID is the status file's `pid` when that file
  can be read, else `<PID>` when it is a number, else there is none.
- `<grace>` says what the skill did at grace expiry: `none`; `term:<m>`,
  SIGTERM only; or `kill:<m>`, SIGTERM then SIGKILL. m is the deadline's
  minutes, as the stop line names it.
- Malformed reader arguments exit 64 with one `usage: ` line on standard
  error, and nothing is read or changed. The skill counts a wait or stop
  exit of 64 as unknown.

**`report`** prints the outcome (see
[Outcomes and exit codes](#outcomes-and-exit-codes)) and exits with its code:
0, 1, 2, 3 or 4. After it, the skill relays the report and ends.

**`wait`** waits at most 90 s for the run to move on, checking every 1 s. It
counts the deadline itself: the status file's deadline, or, while no status
file can be read, the RUN_ID's time plus 90 min. The grace ends 10 min after
the deadline. It returns at the first check at which a state holds, in this
order:

| State | Exit | When | The skill then |
|---|---|---|---|
| `verdict` | 10 | `verdict.txt` exists | runs the report with grace `none` |
| `refused` | 11 | the status file records a refusal | runs the report with grace `none` |
| `gone` | 12 | the runner is gone | runs the report with grace `none` |
| `grace` | 13 | the grace has ended and the runner is alive | runs the stop |
| `running` | 0 | the phase changed since its first check, or the 90 s bound is reached | runs the wait again |

Before it exits it prints one line:

```text
wait: <state> phase=<phase> pid=<pid> runner=<alive|gone> deadline=<UTC time> minutes=<m> grace-ends=<UTC time>
```

phase is the status file's phase (`build`, `shards`, `merge` or `refused`), or
`none` while no status file can be read; pid is the runner's PID or `-`; m is
the deadline's minutes from the runner's start (90 while no status file can
be read).

**`stop`** sends nothing unless the runner is alive. When it is, it sends
SIGTERM, and SIGKILL when the runner is still alive 30 s later. It signals the
PID only, never a process group. It prints one line, `stop: <what it did>;
grace <grace>`:

| What it did | Exit | `<grace>` |
|---|---|---|
| `runner <pid> not alive, no signal sent` | 0 | `none` |
| `sent SIGTERM to runner <pid>` | 20 | `term:<m>` |
| `sent SIGTERM to runner <pid>, then SIGKILL after 30 s` | 21 | `kill:<m>` |

pid is the runner's PID, or `-` when there is none. m is the deadline's
minutes as the wait line prints them: the status file's `deadline.minutes`
(138, say, for a 6-shard run with the current table), or 90 while no status file can be
read.

After any of these, the skill runs the report with that grace. Neither `wait`
nor `stop` writes, renames or removes anything.

## Finishing a run by hand

Use this when the launching session ended, or its polling stopped (a
`verdict reader failed:` line, say). It finishes the run exactly as the skill
would. Run each step from the worktree:

1. Run `bun scripts/ci-verdict.ts wait <RUN_ID> <PID>`, with the printed
   runner PID or `-`, until it exits 10, 11, 12 or 13. Run it again after an
   exit of 0 or an unknown exit.
2. When it exited 13, run `bun scripts/ci-verdict.ts stop <RUN_ID> <PID>`.
   Run it again after an unknown exit.
3. Run `bun scripts/ci-verdict.ts report <RUN_ID> <PID> <grace> <the /ci arguments>`,
   with the grace the stop line names, or `none` when no stop ran. Take the
   `/ci` arguments from the first line of `runner.log` in the run directory,
   `ci-run: run <RUN_ID> pid <PID>: /ci <args>`. The arguments there are
   already shell-quoted, so copy them as written.

The report then prints the outcome and exits with its code. It removes a
PASS's or a refusal's run directory as usual.

The RUN_ID is the run directory's name without `cscb-ci-`. When the PID was
lost, use `-`: the reader takes the PID from the run's status file.

## Cancelling a run

Signal the printed runner PID (when the launch printed `-`, the `pid` in the
run directory's `status.json`):

```sh
kill -TERM <PID>
```

The runner traps `SIGINT`, `SIGTERM` and `SIGHUP`, stops its shards, runs its
checks and cleanup, and writes `FAIL: interrupted: <signal>`, such as
`FAIL: interrupted: SIGTERM`. A selective run carries it inside its
`SELECTIVE` prefix and an injected run inside its `INJECTED` wrapper. The
polling session then gets wait exit 10 and reports it; otherwise finish the
run by hand. Signal the runner's PID only: never its process group or a
shard container.

## The parallel run

- **Independent tracks.** Track A contains ordinary scripts and takes no
  Codex login lease. Track B contains only login-bearing scripts (test-41
  today), each with test-1 in its dedicated shard. After shared packing,
  admission and image preparation, A starts while B waits for login. B
  releases the lease after its containers retire and its postchecks and
  scans run, even while A continues. Neither track alone is a full gate.
- **Shards.** Up to 6 shard containers run at once from the one test image
  the run builds and pins by image ID. Every shard starts with test-1.
  Each Codex login script gets its own shard containing exactly test-1
  and that script. Other scripts run on the ordinary shards in canonical
  order: test-2, test-3 and test-4, then ascending script number.
- **Scheduling units.** test-1 is in no unit. Other scripts form units
  joined by their `# ci-requires:` lines; an unlinked script is its own
  unit. A unit goes whole into one shard. A Codex login script must be
  its own unit with no prerequisites beyond test-1.
- **Balance.** Ordinary units are placed longest first into the ordinary
  shard with the smallest expected total, using `tests/ci-durations.tsv`
  (2400 s for a script with no entry). Dedicated Codex units occupy the
  remaining shards. The same tree, table, selection and N give the same
  assignment.
- **Limits.** Each shard's wall-time limit is 2 × its expected total +
  15 min, at least 30 min, from its container's start.
  `--shard-timeout MINUTES` sets every shard's limit instead.
- **Deadline.** Before scheduling, the run allows 30 min for builds,
  plus 60 min when the base image is missing and the separate Codex
  login-admission wait. Once scheduled it also allows the largest shard
  limit plus 15 min. Codex runs initially reserve the full 30-minute
  login-wait allowance; after login admission it becomes the actual
  elapsed wait. Use the deadline the reader reports.
- **Failures.** By default each shard stops at its first failing script;
  other shards run on. With `--keep-going`, independent scripts continue
  only after verified process cleanup. Failed or skipped prerequisites
  block dependents; test-1 is every script's prerequisite. Skips record
  `fail-fast`, `dependency:<file name>` or `unsafe-cleanup`. No failure is
  retried or waived. A permitted one-shard selection keeps serial order;
  a mixed full run cannot use `--shards 1`.
- **Measurement guard.** Packing/builds and shard work outside test-32 share an
  account-local performance lock. Test-32 first clears its baseline daemon
  and verifies cleanup, then takes the lock exclusively for its native
  measurement script. This coordinates participating `/ci` runs;
  resource admission, deadlines and the 20-sample 2 s/10 s p95 limits remain.
- **Final cleanup.** Uncertain final cleanup emits no `done`, even if all
  script END records passed. The container retains its performance lock
  until the host retires it at the existing shard limit or run stop. The
  retained Docker log says `FAIL: runner.sh: unsafe-cleanup`; the reader
  reports the resulting shard/run failure through the normal procedure.

Detail: [`tests/README.md`'s Script names, prerequisites and canonical order](../../../tests/README.md#script-names-prerequisites-and-canonical-order),
[The duration table](../../../tests/README.md#the-duration-table) and
[`docker/README.md`'s /ci: the sharded run](../../../docker/README.md#ci-the-sharded-run).

## How N is chosen

- The requested N is `--shards`, otherwise 6. The effective N is the
  smaller of requested N and the number of scheduling units, at least 1.
  `/ci test-1` therefore runs one shard.
- Each Codex login script needs one dedicated shard. If ordinary units
  are selected too, they need at least one additional shard. With the
  current single Codex entry, a mixed run, including a full run, needs
  at least 2 shards. `--shards 1` for that selection is refused before
  admission; selecting only the Codex entry and test-1 may use one shard.
- With neither `--shards` nor `--inject`, admission chooses the largest
  fitting N down to that isolation minimum, rather than always down to
  1. It refuses if the minimum cannot fit. This choice does not change
  gate eligibility. With `--shards` or any `--inject`, it takes exactly
  the effective N or refuses.

The timing summary and the run's summary start with the shard-count line,
`shards: <n> of <r>`, n being the run's N and r the requested N. When n is
less than r, the reasons follow in brackets, separated by a comma and a
space: `<u> scheduling unit(s)`, `memory: <f> GiB free under the <C> GiB ceiling`
and `cpu: <h> of 12 CI CPUs in use`. For example:

```text
shards: 6 of 6
shards: 2 of 4 (2 scheduling unit(s))
shards: 5 of 6 (memory: 11.1 GiB free under the 54.4 GiB ceiling)
shards: 0 of 6 (ended before admission)
```

## Selective mode

Any SCRIPT argument makes the run selective. The run's scripts are the
selected scripts, their declared prerequisites (added transitively) and
test-1, in canonical order. `/ci test-3` runs test-1, test-2 and test-3 in one
shard.

- Every script's `# ci-requires:` line is still checked, not only the run's.
- The verdict is `SELECTIVE (<scripts>): PASS` or
  `SELECTIVE (<scripts>): <FAIL line>`.
- A selective PASS reports `SELECTIVE (not a gate result): PASS: <scripts>`
  and exits 3; a selective FAIL exits 1. A selective run is never a gate
  result, and it has no cap line.

Detail: [`tests/README.md`'s Selective runs](../../../tests/README.md#selective-runs).

## Fault injection

`--inject FAULT` makes a run fail on purpose, to prove the runner catches it.
A fault's `<script>` is a number form or a file name, shown in its number
form; k and j are shard numbers.

| Fault | What it does |
|---|---|
| `fail:<script>` | The script is not run and is recorded failed with `FAIL: <file name>: injected failure` |
| `timeout:<script>` | When the script is first seen in progress, its shard is stopped as at its wall-time limit |
| `leak:<k>,<j>` | Shard j also gets shard k's subdirectory, read-only, at `/leak-shard-<k>` |
| `image-drift:<k>` | Shard k starts from a drift image: the pinned image plus a label, so another image ID |
| `kill:<k>` | When a script is first seen in progress in shard k, the shard's container is killed |
| `retag` | Once every shard's start was tried, the run's `-test` tag moves to a retag image |

- An injected run's verdict is `INJECTED (<faults>): ` followed by the line it
  would otherwise write. The report is
  `INJECTED (not a gate result): <verdict line>`, exit 4, whatever the line.
- A fault that never fires fails the run with
  `FAIL: integrity: fault-fired: <fault> did not fire (<why>)`.
- Bad arguments: an unknown fault name, a malformed fault, `leak:<k>,<k>`, and
  `fail:` and `timeout:` naming the same script.
- Not runnable: a `fail:` or `timeout:` naming a script that does not exist
  or is not one of the run's scripts; a `leak`, `image-drift` or `kill` shard
  number outside 1 to the effective N.
- Gate runs never inject: `/ci` with no arguments activates no fault, and no
  environment variable or file turns one on.

Detail: [`tests/README.md`'s Fault injection](../../../tests/README.md#fault-injection).

## Admission

A run is admitted under one admission lock that every worktree and session
of the account shares. Under it the runner sweeps dead runs' leftovers, reads
the host and fits the run. Every figure below is a runner constant.

| Figure | Value |
|---|---|
| CPUs | 2 per shard; all live `/ci` runs together hold at most 12 CI CPUs |
| Memory per shard | Ordinary cap: 2 GiB. Each dedicated Codex shard adds 2 GiB (currently 4 GiB), for both memory and memory-swap |
| Admission margin | 1 GiB |
| Ceiling C | 85% of the pod memory limit (54.4 GiB on the 64 GiB pod); while a `/ci-live` run is active, the lower of that and 40 GiB, `/ci-live`'s working-set stop line |
| Memory fit | pod non-reclaimable memory U + other runs' commitments + N × the ordinary cap + 2 GiB per Codex shard + 1 GiB margin ≤ C |
| Stop line | C less 0.5 GiB (53.9 GiB, or 39.5 GiB while `/ci-live` runs). The memory watchdog checks U every 30 s and stops the run there |
| Disk line | 85%: (used + 1 GiB) ÷ (used + available) must stay under it on the volume holding the run directory |
| U | The larger of `anon + shmem` and `active_anon + inactive_anon + unevictable` from the pod's `memory.stat`; reclaimable file cache is excluded, locked pages accounted without double-counting |

Missing or malformed required memory counters refuse admission. The working
set remains diagnostic in readings and results; high reclaimable page cache
alone does not block admission or stop the run. The sysadmin monitor's
working-set reading can differ from U.

An active `/ci-live` run counts 13 GiB. Each other live `/ci` run counts its reserved memory, including the
additional 2 GiB for each Codex shard, less what its shards use now. Docker's storage on
`/var/lib/docker` is not checked. The disk gate uses actual allocated blocks
plus the 1 GiB allowance, after packing the tarball under the run directory's
`package` directory. It does not discount temporary usage, and there is no
disk watchdog.

The Codex shard still counts as one shard and reserves 2 CPUs. Its
extra memory is included both when choosing N and when writing the
reservation; reducing ordinary shards does not remove that extra cost.
The full reservation stays held while Track B waits and after either track
finishes; early login release does not release or overbook reserved capacity.

Detail: [`docker/README.md`'s Admission: memory, disk and CPU](../../../docker/README.md#admission-memory-disk-and-cpu)
and [The admission lock, reservations and the sweep](../../../docker/README.md#the-admission-lock-reservations-and-the-sweep).

## Refusals and what to do

A refused run is not runnable: exit 2, `NOT RUN: <reason>`, then its
detail lines. The runner validates arguments, scripts, isolation shard
count and Claude credentials first, then performs Docker/build/admission
checks and image read-back. Track B acquires and validates its login/model,
checks survivors and checks the image testuser UID before its own shards
start; Track A can already be running. A Track B admission error is then a
run failure, not an early `NOT RUN`. Relay the reader's actual outcome;
runtime postcheck and cleanup failures are failures too.

| Refusal | What to do |
|---|---|
| A bad argument, such as `NOT RUN: --shards 7 is out of range: N must be a whole number from 1 to 6` | Fix the arguments as the reason says, then re-run |
| A script file not named `test-<n>-<slug>.sh` (such as `test-5.sh` or `test-x-y.sh`), or a `test-*.sh` entry that is not a regular file | Rename or remove the named entry in `tests/integration` |
| Two scripts with one number | Renumber one of the named files |
| test-1 is missing | Restore `tests/integration`'s test-1 script |
| A SCRIPT that matches no script | Use an existing number form or file name |
| A `# ci-requires:` refusal: an unknown name, a line naming no script, a cycle, a prerequisite that sorts after its dependent, a second line, or a line outside the header comment block | Fix the named script's header as [`tests/README.md`](../../../tests/README.md#script-names-prerequisites-and-canonical-order) says |
| A fault refusal: an unknown or out-of-run script, or a shard number outside 1 to the effective N | Name a script of the run, or a shard from 1 to the effective N |
| A missing or bad credential | See [Credentials](#credentials) |
| `NOT RUN: Codex login isolation requires at least <n> shards; requested --shards <r>` | Use at least the printed minimum, or choose a smaller script selection. A mixed ordinary/Codex run needs at least 2 shards on the current tree |
| `Codex login scripts must have no prerequisites beyond test-1` | Correct the Codex script's prerequisite unit; do not combine another script with its login-bearing shard |
| A missing or invalid Codex model, config-key projection or login | Relay the reason. Provision the existing host login and a valid top-level model through the supported host setup; never print the login, edit the host config, or change permissions yourself |
| `Another run holds the Codex login; lock stayed busy for 30 minutes` | Wait for that run to retire its container and release the lease, then rerun; do not delete the lock |
| `An earlier Codex login container remains; retire it before starting another run` or `Could not verify retirement of Codex login containers; admission refused` | Resolve the prior run's cleanup or the failed Docker check first. Inspect only through `bun scripts/safe-docker-inspect.ts docker container inspect NAME`; wrapper failure is final, with no raw inspection fallback |
| `Codex image testuser UID does not match the runner UID` | Correct the test image/user mismatch before retrying; do not chmod or chown the login |
| `NOT RUN: docker does not answer: <error>` | Start Docker, check that `docker info` answers, then re-run |
| `NOT RUN: docker/Dockerfile.test could not be read (<error>): the base image is the one its FROM instruction names` | Restore `docker/Dockerfile.test`, or fix what the error names (its permissions, the volume), then re-run |
| `NOT RUN: docker/Dockerfile.test has no FROM instruction: …` or `NOT RUN: docker/Dockerfile.test has <n> FROM instructions: …` | Give `docker/Dockerfile.test` exactly one `FROM` instruction, naming the base image, then re-run |
| `NOT RUN: docker/Dockerfile.test's FROM instruction names no base image by a fixed name: <instruction>` | Make the `FROM` instruction name the base image by a fixed name: no `$` variable, and nothing after the name but an optional `AS <stage>`. Then re-run |
| `NOT RUN: checking whether the base image <image> exists failed: <error>` | Docker did not answer the image query: check that `docker info` answers and fix what the error names, then re-run |
| A base-image prerequisite missing | See [The base image](#the-base-image) |
| `NOT RUN: packing failed: creating <path> failed: <error>` | Fix what the error names (the run directory's volume, its free space or permissions), then re-run |
| `npm pack failed (exit <code>): …` | Run `npm install` in the worktree, then re-run |
| `NOT RUN: npm pack failed: its output named no tarball that it wrote into <path>` | Run `npm pack --dry-run` in the worktree and check that it ends with a `.tgz` file name; run `npm install`, then re-run |
| `NOT RUN: packing failed: making <path> read-only and hashing it failed: <error>` | Fix what the error names (the run directory's volume, its free space or permissions), then re-run |
| The admission lock busy: `NOT RUN: the admission lock stayed busy for 30 s: run <RUN_ID> (PID <PID>) holds it` | Another run is being admitted; re-run once its admission is done |
| `NOT RUN: the admission lock <path> could not be taken: <error>` | Fix what the error names (the lock file's directory under the account's home, its permissions, the volume), then re-run |
| A reading that fails: `NOT RUN: memory: could not read <what>: <error>` or `NOT RUN: disk: could not read <what>: <error>`, an unreadable reservation of a live run included | Fix what the line names (a cgroup file, the volume, docker, the reservation), then re-run |
| The account's home not found in `/etc/passwd` | Fix the account's password-file entry; the lock lives under that home |
| `NOT RUN: memory: <n> shard(s) need <x> GiB; <f> GiB fits under the <C> GiB ceiling` | Finish or kill idle agent-director workers and confirm their tmux sessions are gone; stop the other CI runs or builds listed; re-run once the printed non-reclaimable memory and commitments leave room for the shards and margin. Reclaimable page cache is excluded from the gate. A smaller `--shards` value, when the refusal names one, may fit now |
| A blocking container: `blocking every run: container <name>, an uncapped cscb-ci* container; /ci never removes it` | An uncapped `cscb-ci…` container, such as a run of the old serial `/ci`, blocks every run. Wait for it to finish, or stop and remove it by hand once it is not needed, then re-run |
| A labelled blocking container: `blocking every run: container <name>, an uncapped container labelled cscb-ci=1 with no live reservation (owner <RUN_ID>-<PID>); a later /ci run's sweep removes it once its owner is dead` | Wait for its owner to end; the next run's sweep removes it. If the owner stays alive, cancel it by signalling its runner PID, then re-run |
| `NOT RUN: disk: <volume> is <p>% used; this run's 1 GiB would take it to <q>%, at or over /ci's 85% disk line` | Remove kept results directories (the refusal lists them, largest first) and other large files on that volume, then re-run |
| `NOT RUN: cpu: <n> shard(s) need <c> CPUs; active /ci runs hold <h> of the 12 CI CPUs` | Wait for or cancel a listed run (signal its runner PID), or re-run with a `--shards` value that fits |
| `NOT RUN: the run's reservation could not be written: <error>` | Fix what the error names (the reservation directory under the account's home, the volume), then re-run |
| An image that differs from the worktree (the script list or a prerequisite line), or `NOT RUN: test image read-back failed: <error>` | The tree changed during the build, or Docker failed: re-run once the tree is settled and Docker answers |

When several of memory, disk and CPU fail, each is given, in that order. A run that may choose its N is judged at its isolation minimum for
these messages: at least 1, one dedicated shard per Codex login script,
and another shard when ordinary units are selected too. A mixed run
on the current tree is judged at 2 shards.

### Credentials

The runner reads credentials from its own environment, which the launch
passes on unchanged.

- Every full `/ci` run and every release makes real model calls for both
  Claude Code and Codex. `CI_ANTHROPIC_API_KEY` must be set and not empty
  for the Claude real-agent scripts. Other scripts use stub `claude`;
  the bots do not use Claude Code OAuth. Codex uses the existing host
  login described below, without an additional API credential.
- A key that does not begin `sk-ant-` is a gateway credential, not a raw
  Anthropic key, and needs `CI_ANTHROPIC_BASE_URL` set too; provide
  `CI_ANTHROPIC_MODEL` to select the test model. An empty base URL counts as unset.
- Every secret credential that is set and not empty must be at least 8
  characters long. The secret credentials include `CI_ANTHROPIC_API_KEY`,
  `GH_TOKEN` when set, and the base-build token (`gh auth token`) when the
  base image must be built. `CI_ANTHROPIC_BASE_URL` and `CI_ANTHROPIC_MODEL` are not
  secret.
- No secret value is written to any file of the run; the reader prints
  `<redacted>` in its place.

When the selected scripts include a file matching
`-fmk-real-codex.sh` or `-fmk-real-codex-<suffix>.sh`, the runner also
requires the existing host Codex login and model. It uses non-empty
`CODEX_HOME`, otherwise `$HOME/.codex`, and reads the top-level `model`
from that directory's `config.toml`. The model must be a non-empty string
matching `[A-Za-z0-9._:/-]+`; a missing, unreadable, malformed or invalid
model fails Track B before a login-bearing shard starts. The runner supplies this
value as `CODEX_TEST_MODEL`; it is a plain, non-secret shard variable,
not an independent model override. `results.json` records `codexModel`
(null when no Codex login was admitted), and `summary.txt` records
`recorded: codex-model <name>` when a model was admitted. The model is
read from the host config for each run, not hard-coded in this skill.
The bounded scanner decodes only the top-level model value and lexically
skips every other value. It also sends bounded key paths only as plain
`CODEX_HOST_CONFIG_KEYS`, at most 128 KiB, by bare `--env` name alongside
`CODEX_TEST_MODEL`. This projection is validated before launch and inside
the container; missing, malformed or over-limit projection refuses the run.
The TOML scan is bounded to 1 MiB, 2,048 paths, depth 32 and 256-byte key
segments. Never print host config or environment values.

The host `auth.json` must be a regular, non-symlink JSON file owned by
the runner with mode 0600. The image's `testuser` UID must match the
runner UID. The runner reads the login privately for validation,
redaction and secret scanning; never display, copy, hash, archive,
chmod or chown it, copy its scratch home, put either in an image or
repository, or use `docker cp` or `docker commit` on them. Never edit
the host Codex config. If login provisioning is required, relay the
runner’s instruction that host `codex login` provisioning is required;
do not launch host Codex yourself. The read-write mount is intentional:
Codex 0.159.2 refreshes by truncating/writing in place, so the host sees
rotated tokens through the symlink. The read-write mount preserves token refresh in place; a copy or read-only
mount can leave the host with a consumed token.
Recheck native save semantics before changing the Codex version.

Only the dedicated Codex shard gets one additional read-write bind
mount: the validated host login file at `/run/codex-login/auth.json`.
Its other mounts are the read-only package tarball and performance guard,
and that shard's own results directory. Ordinary shards get no login mount. The scratch
Codex home uses an `auth.json` symlink to that exact mounted path;
replacing the symlink fails the scenario. Its home is private mode 0700.
The harness creates no Codex `config.toml`, copies no host settings and
requires the file absent before first spawn. Later preparation/recovery
admits native-written config only with durable successful-spawn provenance
bound to that private home's device/inode. Only the fixed native leaf
`tui.screen_reader_detection_done` and genuine parent tables with only
allowed descendants are permitted. The scratch-config policy permits those native
key/parent names to overlap host keys, without decoding or copying their
host values. Every other host key and all model, reasoning, profile/profiles,
provider/auth and unknown keys fail. Checks record key names and unknown-key
counts only. Native CLI `tui.show_tooltips=false` prevents the optional
startup counter without broadening the file allowlist. Codex runs only
in disposable local CI containers; never send the login or the Codex leg to a job scheduler.

The runner and local heavy coordinator share the exclusive
`codex-login.lock` in the selected host Codex directory. They wait at
most 30 minutes for it, separately from the ordinary admission lock's
30-second wait. Track A takes no login lease and proceeds during that wait.
A surviving container labelled `cscb.codex-login=true`,
including a stopped container, refuses another login-bearing run;
failure to verify retirement also refuses admission. If retirement
cannot be confirmed, the runner holds the login lease until it exits,
and subsequent runs still refuse the survivor. Do not bypass either
check by deleting the lock or starting an unguarded container.

Codex containers disable core dumps with `--ulimit core=0`. Before
starting the shard and after retirement, the runner revalidates that
the host login still parses as JSON and has the same device, inode,
owner and mode 0600. Token strings read before and after the run stay
in memory for redaction and secret scanning, including refreshed
tokens. Relay a postcheck or secret-scan failure as a failure; do not
print credentials or environment values while diagnosing it.

Once all login containers are verified retired, Track B completes its login
postcheck and scans its retired evidence and runner log before releasing
the lease. Failures remain run failures. The runner keeps original and
refreshed token values in memory to mask and scan late Track A output at
the whole-run end; it never rereads a released login.

Test 41 now implements native observations and the final receipt-only
D1 gate, including fault/FIFO/fidelity and actual child SIGKILL/recovery
checks. Gate delivery assertions do not require model prose or completed
answers. The separate field-readback, command-prefix, multipart, sender-identity
and duplicate-DM scenarios require exact completed native answers on the
admitted model, three independent trials each; no stop or fallback counts as
acceptance. All 15 field-readback cases run in every trial. Multipart delivery
uses the deterministic 5,000-byte body, and duplicate-DM acceptance requires
two actual identical DM take-ins before counting one.
Report actual verdicts; completed native observation and synthetic controls
are not final gate, full CI or heavy acceptance.

The heavy leg's AI criteria run on the model set by CI_ANTHROPIC_AI_MODEL (azure/openai/gpt-6-astra for release runs); gate and other scripts use CI_ANTHROPIC_MODEL.

Provision `CI_ANTHROPIC_API_KEY`, optional `CI_ANTHROPIC_BASE_URL` and
`CI_ANTHROPIC_MODEL` in the runner and reader environment through the existing
credential provisioning route. Keep those names on the host, including when
finishing a run by hand. Never extract a personal key, put credential values
in command arguments, or assign/export host `ANTHROPIC_*` for CI.

The runner validates and forwards the CI family directly by bare environment
name. Setting any CI-family input selects that whole family, even if empty;
an incomplete CI configuration never borrows a personal key or base URL.
Unused native credential variables are omitted from the Docker child's
environment. Only `docker/entrypoint.sh` inside the disposable container
translates the CI family to the native names its tools require.

The reader also recognizes CI secrets directly. Give it the same environment
as the runner so its report can redact them; wait and stop read no credential.
The launch/wait/stop/report commands above need no credential prefix or
remapping. Legacy native-family callers remain source-compatible when no CI
input is set; this project's host invocation uses the CI family.

### The base image

The test image is built `FROM` the base image `cscb-ci-base:v8`, the one
`docker/Dockerfile.test`'s `FROM` line names. It is built once per host. When
it is missing, the runner checks its build prerequisites before the
admission lock, without changing anything, and refuses when one fails:

- `docker/Dockerfile.test.base` sets a non-empty `ARG AD_VERSION`;
- `CSCB_AD_SRC_DIR` is set to a checkout of agent-director's source tree that
  holds the release tag `v<AD_VERSION>`; nothing is fetched into it;
- `skills/install-agent-director/install.sh` can be read at that tag;
- the base-build token, when one is found, is at least 8 characters.

To fix one, set `CSCB_AD_SRC_DIR` to such a checkout (or fix the base
Dockerfile), then re-run. These prerequisites are read only when the base
image is missing. The runner then builds the base through
`scripts/ci-base-build.sh`. A failed base build gives
`FAIL: image build: base image build failed (exit <code>)`; rerun it by hand
with `--progress=plain` as
[`docker/README.md`](../../../docker/README.md#when-an-image-build-fails) says.
A base tag bump follows `docker/README.md`'s bump procedure, which also
updates this file.

## The timing summary and the duration table

After a full or selective PASS, the report prints the timing summary:

1. the shard-count line;
2. the build time with its base-build part, each shard's time and the total:
   `build: <s> s (base build <b> s)`, `shard-<k>: <s> s`, `total: <s> s`;
3. each script's time, `shard-<k> <file name>: <s> s (pass|fail)`;
4. the duration-table block under its introducing line, any
   `slow: <file name> took <s> s, estimate <e> s` lines and any table notes;
5. for a full run, the cap line.

Other outcomes print no timing summary; the same items are in the run's
`summary.txt` whenever the runner writes a verdict.

To refresh `tests/ci-durations.tsv`, paste the block's lines (not the
introducing line) over the whole file and commit it as an ordinary change.
The runner never writes the table. A `slow:` line does not fail the run; it
means the table is stale. Detail:
[`tests/README.md`'s Refreshing the table](../../../tests/README.md#refreshing-the-table).

## The cap line

Every full run's summary, and a full PASS's timing summary, holds the cap
line:

```text
cap from measured anon peak: <peak> GiB in shard-<k> (page cache <f> GiB) + 1 GiB margin → <cap> GiB; current cap <c> GiB
```

- It is informational. The runner never changes the cap.
- The ordinary shard cap and the Codex shard cap differ by 2 GiB. The
  reported current cap follows the source shard's actual cap when a
  source exists; without a source it uses the largest scheduled cap.
  An out-of-memory kill on a Codex shard is counted at its actual cap,
  not the smaller ordinary cap. The line does not change either cap.
- It ends with a suffix: none for a passing default full run with every anon
  peak complete; `; source after out-of-memory kill in <shards>` for a default
  full run with any kill; otherwise `; not a valid cap source: <reasons>`,
  each reason that applies, in this order: `not a default run` (a `--shards`,
  `--shard-timeout`, `--keep-going` or `--inject` full run), `run did not pass`,
  `partial anon peak (<shards>)` and `unknown anon peak (<shards>)`. A line
  with that suffix is never a reason to change the cap.
- After a kill, `(page cache <f> GiB)` reads
  `(killed for out of memory at the cap)`; when the peak reading's page cache
  could not be read, it reads `(page cache unknown)`. When no anon memory was
  read and no shard was killed, the line is
  `cap from measured anon peak: unknown, no shard's anon memory was read; current cap <c> GiB`,
  then its suffix. A selective run has no cap line.
- The cap (`SHARD_MEMORY_CAP_BYTES` in `scripts/ci-run.ts`) starts at 2 GiB,
  which is also its minimum. It is set by hand once, at delivery, in one
  committed change, to the higher of the cap the delivery verification run's
  line gives and any cap raised after a kill earlier in verification.
  Afterwards it is raised by hand only to the cap given by the line of a
  default full run with an out-of-memory kill, each time as an ordinary
  committed change.
- An out-of-memory kill in any other run fails that run, naming the shard,
  and leaves the cap as it is.

Detail: [`docker/README.md`'s The per-shard memory cap and out-of-memory kills](../../../docker/README.md#the-per-shard-memory-cap-and-out-of-memory-kills).

## Cleanup and retention

- **Every outcome**, a refusal included, releases the run's reservation and
  removes its shard containers, its run-private image tags and its own
  untagged images. No image is removed by its ID, and no removal is forced.
- **The run directory** is removed by the reader only after it prints a full
  or selective PASS with its timing summary, or a refusal. Every other run
  directory is kept: a FAIL, an injected run, a stopped run, a missing or
  invalid verdict. The `results:` line names it.
- **Kept directories** are removed by the operator, by hand, once inspected.
  The disk refusal lists them.
- **A dead runner**, such as one killed at grace expiry or lost at a reboot,
  needs no clean-up by hand: the next `/ci` run's sweep removes its
  containers, reservation and tags, and its untagged images. The sweep keeps
  its run directory.

Detail: [`docker/README.md`'s The run's images and tags](../../../docker/README.md#the-runs-images-and-tags).
