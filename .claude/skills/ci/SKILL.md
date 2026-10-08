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
/ci [--shards N] [--shard-timeout MINUTES] [--inject FAULT]... [SCRIPT]...
```

| Argument | Meaning |
|---|---|
| `--shards N` | Run exactly the effective N shards (see [How N is chosen](#how-n-is-chosen)), or be refused. N is a whole number from 1 to 6 |
| `--shard-timeout MINUTES` | Every shard's wall-time limit, in place of the computed one. A whole number from 1 to 720 |
| `--inject FAULT` | Turn on one fault (see [Fault injection](#fault-injection)). May be repeated; an identical fault given twice counts once |
| `SCRIPT` | Select a script: its number form `test-<n>` or its whole file name, such as `test-3` or `test-3-cozempic-restart.sh`. Any SCRIPT makes the run selective |

Argument rules:

- Arguments may come in any order, options and SCRIPT names mixed. The order
  changes nothing but the order of faults in the `INJECTED (<faults>)` wrapper.
- Each option takes the next argument as its value (`--shards 3`).
  `--shards=3`, an option given last with no value, an unknown option and any
  other argument beginning `-` are bad arguments.
- A whole number is decimal digits with no sign, no decimal point and no
  leading zero.
- `--shards` and `--shard-timeout` may each appear once. A second appearance
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
  `--shards` or `--shard-timeout`, whatever N admission picks.
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
| `FAIL: memory watchdog: pod working set <x> GiB reached the <y> GiB stop line (<ceiling source>; <per-shard detail>)` | The pod working set reached the stop line (see [Admission](#admission)) |
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

A runner killed this way is a dead owner, so the next `/ci` run's sweep
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

A run of m minutes takes about m × 60 ÷ 90 wait calls, plus one per phase
change (at most two), besides the launch, the report and, after the grace,
the stop. With the current duration table:

| Run | Wait calls |
|---|---|
| A default full run of about 45 min | about 32 |
| A default full run that runs to its 138 min deadline and the 10 min grace | about 101 |
| A `--shards 1` run of about 210 min | about 142 |
| A `--shards 1` run that runs to its 473 min deadline and the grace | up to about 324 |

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

- **Shards.** Up to 6 shard containers run at once, every one from the one
  test image the run builds and pins by its image ID. test-1 runs first in
  every shard, then the shard's other scripts in canonical order: test-1,
  then test-2, test-3 and test-4, then every other script by ascending number.
- **Scheduling units.** test-1 is in no unit. The other scripts form units,
  joined by their `# ci-requires:` lines; a script with no link is a unit of
  its own. A unit goes whole into one shard. On the current tree test-2 and
  test-3 form one unit, so 29 scripts give 27 units.
- **Balance.** Units are placed longest first, each into the shard with the
  smallest expected total, from `tests/ci-durations.tsv` (2400 s for a script
  with no entry). The same tree, table, selection and N always give the same
  assignment.
- **Limits.** Each shard's wall-time limit is 2 × its expected total + 15 min,
  at least 30 min, from its container's start. `--shard-timeout MINUTES`
  sets every shard's limit instead.
- **Deadline.** The run's deadline is 30 min from its start until the shards
  are scheduled (plus 60 min when the base image must be built), then that
  plus the largest shard limit plus 15 min: 138 min for a 6-shard run with the
  current table.
- **Failures.** A shard stops at its own first failing script; the other
  shards run on. With `--shards 1` the run keeps the serial order and stops at
  its first failure.

Detail: [`tests/README.md`'s Script names, prerequisites and canonical order](../../../tests/README.md#script-names-prerequisites-and-canonical-order),
[The duration table](../../../tests/README.md#the-duration-table) and
[`docker/README.md`'s /ci: the sharded run](../../../docker/README.md#ci-the-sharded-run).

## How N is chosen

- The requested N is the `--shards` value, else 6. The effective N is the
  smaller of the requested N and the number of scheduling units, at least 1,
  so `/ci test-1` runs one shard.
- With no `--shards` and no `--inject`, the run takes the largest N, from the
  effective N down to 1, that passes the memory and CPU fits (see
  [Admission](#admission)), and stays gate-eligible.
- With `--shards` or any `--inject`, the run takes exactly the effective N,
  or is refused.

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
| Memory per shard | The per-shard memory cap, 2 GiB to start (see [The cap line](#the-cap-line)) |
| Admission margin | 1 GiB |
| Ceiling C | 85% of the pod memory limit (54.4 GiB on the 64 GiB pod), matching the sysadmin monitor's warn line; while a `/ci-live` run is active, 40 GiB, `/ci-live`'s working-set stop line |
| Memory fit | pod working set W + other runs' commitments + N × the cap + 1 GiB ≤ C |
| Stop line | C less 0.5 GiB (53.9 GiB, or 39.5 GiB while `/ci-live` runs). The memory watchdog checks W every 30 s and stops the run there |
| Disk line | 85%: (used + 1 GiB) ÷ (used + available) must stay under it on the volume holding the run directory |
| Observed idle W | 33 to 43 GiB, mostly active page cache; about 42.3 GiB gives a default run 5 shards, 33.1 GiB gives 6 |

An active `/ci-live` run counts 13 GiB. Each other live `/ci` run counts its
reserved memory less what its shards use now. Docker's storage on
`/var/lib/docker` is not checked.

Detail: [`docker/README.md`'s Admission: memory, disk and CPU](../../../docker/README.md#admission-memory-disk-and-cpu)
and [The admission lock, reservations and the sweep](../../../docker/README.md#the-admission-lock-reservations-and-the-sweep).

## Refusals and what to do

A refused run is not runnable: exit 2, `NOT RUN: <reason>`, then its detail
lines. The runner checks, in order: the arguments, scripts and credentials,
docker, the base image's prerequisites, packing, the admission lock, the sweep
and readings, the fits, then the writing of the run's reservation. Only the
image read-back refuses after the build.

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
| `NOT RUN: docker does not answer: <error>` | Start Docker, check that `docker info` answers, then re-run |
| A base-image prerequisite missing | See [The base image](#the-base-image) |
| `npm pack failed (exit <code>): …` | Run `npm install` in the worktree, then re-run |
| The admission lock busy: `NOT RUN: the admission lock stayed busy for 30 s: run <RUN_ID> (PID <PID>) holds it` | Another run is being admitted; re-run once its admission is done |
| `NOT RUN: the admission lock <path> could not be taken: <error>` | Fix what the error names (the lock file's directory under the account's home, its permissions, the volume), then re-run |
| A reading that fails: `NOT RUN: memory: could not read <what>: <error>` or `NOT RUN: disk: could not read <what>: <error>`, an unreadable reservation of a live run included | Fix what the line names (a cgroup file, the volume, docker, the reservation), then re-run |
| The account's home not found in `/etc/passwd` | Fix the account's password-file entry; the lock lives under that home |
| `NOT RUN: memory: <n> shard(s) need <x> GiB; <f> GiB fits under the <C> GiB ceiling` | Finish or kill idle agent-director workers and confirm their tmux sessions are gone; stop the other CI runs or builds listed; re-run once the sysadmin monitor's reading is back below its 85% warn line, or W is back below the ceiling. Page cache cannot be dropped in this pod. A smaller `--shards` value, when the refusal names one, may fit now |
| A blocking container: `blocking every run: container <name>, an uncapped cscb-ci* container; /ci never removes it` | An uncapped `cscb-ci…` container, such as a run of the old serial `/ci`, blocks every run. Wait for it to finish, or stop and remove it by hand once it is not needed, then re-run |
| A labelled blocking container: `blocking every run: container <name>, an uncapped container labelled cscb-ci=1 with no live reservation (owner <RUN_ID>-<PID>); a later /ci run's sweep removes it once its owner is dead` | Wait for its owner to end; the next run's sweep removes it. If the owner stays alive, cancel it by signalling its runner PID, then re-run |
| `NOT RUN: disk: <volume> is <p>% used; this run's 1 GiB would take it to <q>%, at or over /ci's 85% disk line` | Remove kept results directories (the refusal lists them, largest first) and other large files on that volume, then re-run |
| `NOT RUN: cpu: <n> shard(s) need <c> CPUs; active /ci runs hold <h> of the 12 CI CPUs` | Wait for or cancel a listed run (signal its runner PID), or re-run with a `--shards` value that fits |
| `NOT RUN: the run's reservation could not be written: <error>` | Fix what the error names (the reservation directory under the account's home, the volume), then re-run |
| An image that differs from the worktree (the script list or a prerequisite line), or `NOT RUN: test image read-back failed: <error>` | The tree changed during the build, or Docker failed: re-run once the tree is settled and Docker answers |

When several of memory, disk and CPU fail, each is given, in that order. A run
that may choose its N is judged at 1 shard for these messages.

### Credentials

The runner reads credentials from its own environment, which the launch
passes on unchanged.

- `ANTHROPIC_API_KEY` must be set and not empty. The bot Claudes the daemon
  under test spawns need an API key, not Claude Code's OAuth; in the image
  they run a stub `claude`, so the key serves no model call.
- A key that does not begin `sk-ant-` is a gateway credential, not a raw
  Anthropic key, and needs `ANTHROPIC_BASE_URL` (and `ANTHROPIC_MODEL`) set
  too. An empty `ANTHROPIC_BASE_URL` counts as unset.
- Every secret credential that is set and not empty must be at least 8
  characters long. The secret credentials are `ANTHROPIC_API_KEY`,
  `GH_TOKEN` when set, and the base-build token (`gh auth token`) when the
  base image must be built. `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` are not
  secret.
- No secret value is written to any file of the run; the reader prints
  `<redacted>` in its place.

To find a raw key, read Claude Code's own stored key:

```sh
export ANTHROPIC_API_KEY="$(jq -r .primaryApiKey ~/.claude.json)"
```

If `primaryApiKey` is null or absent and no gateway credential is exported,
no API key has been provisioned; provision one before re-running `/ci`.

A worker spawned through agent-director does not inherit the orchestrator's
environment. Pass the credentials on the spawn command:

```sh
--extra-env ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}"
```

For a gateway credential, add
`--extra-env ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL}" --extra-env ANTHROPIC_MODEL="${ANTHROPIC_MODEL}"`.

### The base image

The test image is built `FROM` the base image `cscb-ci-base:v6`, the one
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
- It ends with a suffix: none for a passing default full run with every anon
  peak complete; `; source after out-of-memory kill in <shards>` for a default
  full run with any kill; otherwise `; not a valid cap source: <reasons>`,
  each reason that applies, in this order: `not a default run` (a `--shards`,
  `--shard-timeout` or `--inject` full run), `run did not pass`,
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
