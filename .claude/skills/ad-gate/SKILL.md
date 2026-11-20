---
name: ad-gate
description: Gate an agent-director release candidate against the shipped claude-slack-channel-bots release, on CSCB's no-model integration scripts sharded across job-scheduler jobs. Runs the gate driver in the background, then relays its verdict and exit code (0 for a release PASS).
user-invocable: true
allowed-tools: [Bash, Read]
---

# /ad-gate

The AD release gate runs a shipped CSCB release's own no-model integration
scripts, and a permission filter regression, against an agent-director (AD)
release candidate, one job-scheduler job per shard. The driver,
`scripts/ad-gate/ad-gate.ts`, does all the work: it fetches the inputs, plans
the shards, submits them, waits, collects the evidence, judges it and writes
the verdict. This skill launches the driver, waits for it and relays its
verdict. It holds no verdict rule of its own.

This is not `/ci`: `/ci` tests the CSCB tree in a worktree on local docker.
The gate tests a published CSCB release's tagged tests against an AD build,
on the scheduler. Why the kit is built this way, its resources, the verdict
rules and the job contract are in
[`docker/README.md`'s The AD release gate](../../../docker/README.md#the-ad-release-gate).

Run every command from a clean checkout of CSCB `main` that holds the release
tags (`git fetch --tags` first). The driver reads the tested release's tests
from tag `v<X.Y.Z>` in its own checkout, and `verdict.json` records the kit's
revision and whether its files differ from it (`kit.dirty`).

## Interface

```text
bun scripts/ad-gate/ad-gate.ts --candidate-dist DIR --candidate-version X.Y.Z --channel ID --out DIR [options]
```

| Option | Meaning |
|---|---|
| `--candidate-dist DIR` | The candidate AD build: `agent-director[-linux-amd64]` and `agent-director-admin[-linux-amd64]`, with optional `agent-director-<version>.tgz`, `install.sh` and the build's checksums file. With a checksums file, every file taken must match it (see [`docker/README.md`'s Provenance checks](../../../docker/README.md#provenance-checks)). Required |
| `--candidate-version X.Y.Z` | The version the candidate binary must report; the job's image build fails otherwise. Required |
| `--candidate-commit SHA` | The candidate's commit. Recorded, and the image build fails unless the binary's commit starts with it. Also the source of `install.sh` (from the AD checkout) when DIR has none |
| `--candidate-install-sh FILE` | The candidate's `install.sh`, when DIR has none and `--candidate-commit` is not given |
| `--reference-tag vX.Y.Z` | The reference AD release. Default: the host's `agent-director version`. It must be tagged in the AD checkout and differ from the candidate's version |
| `--cscb-version X.Y.Z` | A CSCB release to gate; repeatable. Default: npm's `latest`. Naming any replaces the default, so also name the latest release's version to keep it |
| `--channel ID` | The Slack channel for the scheduler's job notices. Required |
| `--shards N` | Each release's candidate shard count, 1 to 6. Default: whichever of 4–6 has the shortest estimated finish time on the scheduler's free slots at submission, shared by all releases; ties use fewer jobs. The estimate omits burst serialization (see [Shard choice](#shard-choice)). Overrides the slot reading. Reference subsets use N when given, otherwise up to 6 |
| `--out DIR` | Where the contexts, evidence and verdict go. Required. New or empty, unless `--resume`. Outside the CSCB checkout: what it holds is evidence, never tracked |
| `--durations FILE` | Measured times (`script<TAB>seconds`, the duration table's header first), overriding the tag's `tests/ci-durations.tsv`: an earlier gate's `measured-durations.tsv` |
| `--only SCRIPT` | Verification only: run this script (`test-<n>` or its file name), its prerequisites and test-1; repeatable. Never a release verdict |
| `--inject-fail SCRIPT` | Verification only: the candidate's runner records SCRIPT failed without running it; repeatable. Never a release verdict |
| `--ad-repo DIR` | The AD checkout, read only: reference tags, `install.sh` sources. Default in `--help` |
| `--jobsched PATH` | The scheduler CLI. Default in `--help` |
| `--dry-run` | Prepare and plan, print the `jobsched submit` commands and serial-burst notice, submit nothing |
| `--resume` | Continue the run recorded in `--out/state.json` |

The host needs `bun`, `git`, `npm`, `curl`, `jq` and `python3`, and public
network access to registry.npmjs.org and GitHub release downloads; nothing
reads a token. The AD checkout must hold the reference tag (and, for a
candidate with no `install.sh`, its commit). `agent-director` must be on
`PATH` only when `--reference-tag` is not given. No secret is needed: the
driver passes no `ANTHROPIC_*` or `CI_ANTHROPIC_*` variable to any child, and
every job runs with its network off. The job image's build uses the network
for apt, bun, node, cozempic and the bun installs that fill `testuser`'s bun
cache, and fails unless test-47's install of the downgrade fixture then
resolves with no network; its last line for that is `CSCB <version>
downgrade fixture: test-47's install warmed in testuser's bun cache and
proved offline (--offline, and with the network blocked)` (see
[The job image](../../../docker/README.md#the-job-image)).

A shard gets 4 GiB and either 2 CPUs and the scheduler's read-only cgroup,
or, as a burst-driver shard, `--cgroups writable` and the tag's own CI
burst-shard CPUs (`CPUS_PER_SHARD + DRIVER_CPUS` from its
`scripts/ci-run.ts`: 4 for v0.19.1, 3 for v0.19.0), recorded as the
manifest's `burst_driver`. A burst-driver shard is one holding a
burst-driver script (test-44, 45, 48 and 51–64 at v0.19.1) of a tag whose
entrypoint splits the driver's CPU (v0.19.0 on); no other shard gets
`--cgroups writable`.

At v0.19.x the burst scripts take about a third of the tag's measured time, so every planned shard holds one in practice: a full
gate's candidate shards all run as burst-driver shards (six planned shards
at v0.19.1, each with 4 CPUs, submitted serially), and so does each reference
shard holding a burst script; only an `--only` subset or a reference rerun
without them gets 2-CPU shards.

The scheduler admits jobs by slot and memory, not CPUs: `--cpus` caps each
container's CPU time and reserves nothing, so shards can contend for the
host's CPUs. The dry run's plan marks a burst-driver shard `, burst driver
(<n> CPUs, cgroups writable)`, and `report.md`'s shard table and
`verdict.json`'s `jobs` show each shard's `cpus` and `cgroups`.

`--cgroups writable` needs Docker Engine 28+ on the scheduler's host. On an
older host the scheduler rejects the job after its build
(`cgroups-unsupported`), so the gate FAILs that shard with a
`scheduler-state` reason, `job <id> ended rejected`, and `verdict.json`'s
`jobs[].reason` holds the scheduler's `writable cgroups require Docker
server 28.0+; version <v>`. A burst-driver shard run with a read-only cgroup
fails its scripts' `driver-cpu` verdict as `missing`. Either way, fix the
host; never drop the scripts. A writable cgroup would let a job rewrite its
own limits, so the scheduler's supervisor stops any job that changes its
container cgroup's own `memory.max`, `memory.swap.max`, `cpu.max` or
`pids.max`: the job ends `failed` with outcome `cgroup-limit-changed`, its
run is cut short, so the gate FAILs that shard, and `verdict.json`'s
`jobs[].reason` names the change. The tag's entrypoint sets CPU quotas
only on its child groups `shard/server` and `shard/driver`, never on the
container's own cgroup, the only one the supervisor watches; so that
outcome means a changed entrypoint or test wrote one of the container's
own limit files: fix that, never the check. The manifest's burst CPUs may
be at most 8, the scheduler's `--cpus` maximum; a tag asking more cannot
be gated on this scheduler. See
[Resources and wall time](../../../docker/README.md#resources-and-wall-time).

## What a release gate runs

- **The latest CSCB release only by default.** Repeat `--cscb-version` to
  gate several releases: ordinary candidate shards run concurrently as slots
  allow; available shards are submitted longest first across releases.
- **One burst slot across releases and roles.** Burst shards are submitted
  serially across candidate and reference roles; a queued or running burst
  job holds the slot until it ends. `--resume` keeps recorded job IDs and
  their slot ownership. This driver's submission follows the testing guide's
  [burst-storage isolation rule](../../../docs/testing-guide.md#thread-memory-performance-runs);
  it provides no host pinning or exclusion of unrelated workloads.
- **The reference only on a candidate failure.** A passing candidate never
  prepares or runs the reference. When candidate scripts fail, the driver
  prepares that release's reference as soon as its candidate is judged,
  while other releases' jobs can keep running. It submits the reference
  under the same burst-slot rule and runs just the failed scripts and their
  prerequisites; each failure must fail there too for the gate to pass.
- **`--only` and `--inject-fail` runs are never release verdicts.** Their
  pass is `NON-RELEASE PASS`, exit 3; every verdict line, `report.md` and
  `verdict.json` (`release: false`, `nonRelease`) say so, a FAIL included.
  Use them only to check the kit.

## Procedure

### 1. Dry run

```sh
bun scripts/ad-gate/ad-gate.ts --candidate-dist <dir> --candidate-version <X.Y.Z> --candidate-commit <sha> --channel <id> --out <out> --dry-run
```

It builds the candidate's context (`prepare.sh` fetches every input and
writes the manifest), checks the inputs against the manifest and the CSCB
tag, then reads `jobsched list --json --limit 1` to choose the shard count
(unless `--shards` was given). It plans all releases and prints their submit
commands together, longest shard first; nothing is submitted. `prepare.sh`
downloads every input, so give the Bash call a 10-minute `timeout`.

- Check the `ad-gate: shards:` line (see [Shard choice](#shard-choice)),
  then `ad-gate: CSCB <v> candidate: <n> scripts in <k> shard(s)` and one
  `s<k>: ~<seconds> s[, filter regression][, burst driver (<n> CPUs, cgroups writable)]: <scripts>` per shard. With
  measured durations and six free slots, CSCB 0.18.6 plans 33 scripts in six
  shards of about 28 min.
- The commands follow `ad-gate: dry run: <n> candidate submit command(s)
  across <R> release(s), longest first; nothing is submitted:` (one line).
- Check the `ad-gate: burst shards run one at a time across releases and
  candidate/reference roles (queued jobs included):` notice and its shard
  names (or `none in this candidate plan`). The printed submit commands
  include later burst shards whose submission waits for the slot.
- Exit 0: clean. Exit 1: `ad-gate: CSCB <v> manifest problem:` lines name
  inputs that differ from the manifest or the tag; fix them before any real
  run. Exit 2 or 64: see [Exit codes](#exit-codes).

### 2. Run, in the background

Run the same command with `--resume` in place of `--dry-run`. The dry run
left `--out` non-empty, so a run without `--resume` is refused; `--resume`
keeps its prepared context and the CSCB release and reference tag it
resolved. A dry run records no shard choice: the real run reads the slots
again at submission and may plan a different count. Every other option must
be exactly the dry run's. To skip the dry run, give the command without
either flag and a new, empty `--out`.

The driver blocks for the whole gate. Its slot-based shard-choice estimate
omits burst serialization; a burst-bearing gate's elapsed script time
includes the sum of its serial burst-shard durations. Build, setup, queueing
and any reference work add time.

Historically, AD 0.17.5 against CSCB 0.18.6 took 59.5 min with queueing,
with shard runs of 28.5–29.8 min; about 30 min without queueing was inferred.
See [Resources and wall time](../../../docker/README.md#resources-and-wall-time)
for that run's conditions.

Launch it as a background task (Claude Code: the Bash tool's
`run_in_background: true`), with its output in a log beside `--out`, never
inside it:

```sh
bun scripts/ad-gate/ad-gate.ts <the dry run's options, without --dry-run> --resume > <out>.log 2>&1; echo "ad-gate exit: $?" >> <out>.log
```

- Wait for the harness's notice that the task ended. Don't poll the log or
  the scheduler meanwhile.
- Never start a second driver on the same `--out` while one runs: two could
  submit a shard twice. Never cancel a gate job.
- While it runs, the log gets `submitted <job name>: <id> (<n> scripts)`,
  `waiting on <R> release(s)' candidate jobs together`,
  `job <id> ended <state>` and, after each 20-minute scheduler wait that saw
  no job end, `still waiting on <n> job(s): <id> <state> (queue position <p>)`.
  Each line has the `ad-gate:` prefix.
- If the driver stops before its verdict (the session ended, the host
  restarted, or an exit 2 after jobs were submitted), run the same command
  again with `--resume`. It submits no recorded shard again, waits for and
  collects the jobs already submitted, and judges them. Once a real run
  records its shard choice, `--resume` keeps it without rereading slots.

### Shard choice

Without `--shards`, free slots are `max(0, limit − active − queued)`; queued
jobs count because the scheduler is FIFO. The driver chooses 4–6 candidate
shards per release to minimise the estimated time for all releases sharing
those slots, with fewer jobs on a tie.

`fastestShardCount` estimates slot rounds without accounting for burst
serialization. A release with fewer scheduling units uses fewer shards;
`--durations` balances the work and sizes the estimate.

The slot-based log line is one line:

```text
ad-gate: shards: <N> candidate shards per release, from <free> free scheduler slots (<limit> slots, <active> active, <queued> queued at <ISO time>) shared by <R> release(s): an estimated <E> min (<J> jobs in <K> round(s) of <S> min; the longest release plans <W> min of scripts), the fastest of 4-6
```

With `--shards`, it is `ad-gate: shards: <N> candidate shards per release,
from --shards` (one line). Reusing a recorded choice adds
` (recorded; --resume reuses it)` to either log line. `state.json`'s
`shardChoice` holds the choice, slot reading and estimate; `report.md` carries
`- Shards: <the same choice text>`, without the log prefix or resume suffix.

### 3. Report

Read the log's last lines and `<out>/verdict.json`. Only exit 0 with
`"outcome": "pass"` and `"release": true` is a release PASS. Relay the
verdict line, each reason line under it and the wall time from
`<out>/report.md`, and hand on `<out>/report.md` and `<out>/verdict.json` as
the release evidence. Keep `--out`.

## Exit codes

| Exit | Outcome | What it prints |
|---|---|---|
| 0 | PASS, a release verdict; or a clean dry run | `ad-gate: verdict: PASS: agent-director <v> against claude-slack-channel-bots <v>; <out>/report.md` |
| 1 | FAIL; or a dry run with manifest problems | Per release, `ad-gate: verdict for CSCB <v>: FAIL (<n> reason(s)); …/report.md` and one indented line per reason; then `ad-gate: verdict: FAIL: …` |
| 2 | The gate could not run | `ad-gate: <reason>` on stderr (see [Could not run](#could-not-run-exit-2)); `ad-gate: (unexpected error)` after it marks a kit bug |
| 3 | NON-RELEASE PASS: an `--only` or `--inject-fail` run passed | `ad-gate: verdict: NON-RELEASE PASS (not a release verdict: <why>): …` |
| 64 | Bad arguments | `ad-gate: <problem>` and the usage on stderr |

## Reading the verdict

`<out>/verdict.json` is the whole gate: `outcome` (`pass`, `fail` or
`non-release-pass`), `release`, `nonRelease` (why not), `kit` (revision,
`dirty`, each kit file's SHA-256), `candidateVersion` and `versions`, one
entry per gated CSCB release with its own `outcome` and the path of its
verdict.

Each release's `<out>/cscb-<v>/verdict.json` holds the evidence:

| Field | What it holds |
|---|---|
| `verdict.outcome` | `pass` or `fail` |
| `verdict.reasons` | Why it failed, each `{kind, role, shard, script, detail}`; `[]` on a pass |
| `verdict.excused` | Candidate failures that fail on the reference too, and the scripts skipped behind them |
| `candidateVerdict` | The judgement before the reference ran: its `referenceScripts` are the scripts sent to the reference |
| `reference.ran` | Whether the reference ran |
| `candidate.manifest`, `reference.manifest` | Every input's version and SHA-256 |
| `manifestProblems` | Inputs, run.log manifests or job provenance that did not match |
| `scripts` | Each planned script's outcome line per shard, on the candidate and the reference |
| `jobs` | Per shard: job ID and name, state, exit, CPUs and cgroup setting, queue, build and run seconds, peak memory, OOM facts, context SHA-256 |
| `firstSubmitAt`, `verdictAt`, `wallSeconds` | The wall time, first submit to verdict |

A reason's `kind` names its rule: `manifest-mismatch`, `plan-coverage`,
`scheduler-state`, `setup-failed`, `no-run-log`, `log-problem`,
`missing-script`, `extra-script`, `duplicate-script`, `unfinished`, `notrun`,
`filter`, `candidate-failure` and `reference-incomplete`. What each covers,
and which failures the reference can excuse, is in
[`docker/README.md`'s The verdict](../../../docker/README.md#the-verdict).

`<out>/report.md` is the same evidence for people: the verdict line, the
inputs and kit, the shard choice, the reasons, one table row per shard and
per script, and the manifests. For several releases it joins their reports;
wall times are per release, from that release's first submit to its verdict.

## Output layout

```text
<out>/
  state.json                 options, resolved releases and reference tag, shardChoice, plans, job IDs (what --resume reads)
  verdict.json, report.md    the whole gate
  cscb-<v>/
    verdict.json, report.md  this release's verdict and evidence
    measured-durations.tsv   the candidate's per-script times, for a later --durations
    candidate/
      context/               the job context: the template's files and inputs/ (with inputs/manifest.json)
      prepare.log            prepare.sh's command and output
      plan.json, submit-commands.txt
      shard-<k>/status.json, shard-<k>/run.log
    reference/               the same, only when the reference ran
```

## Could not run (exit 2)

Each message below is printed as `ad-gate: <message>` on stderr. `<reason>`
is the system's reason, such as `no such file or directory (ENOENT)`. The
driver checks the command's inputs, `--out`, the tags and the `--only` and
`--inject-fail` names before `prepare.sh` fetches anything, so a mistake
there costs no download.

A refusal before anything was submitted changes no job. After a submission,
`state.json` holds the job IDs, and `--resume` picks them up. A message
followed by `ad-gate: (unexpected error)` is a kit bug: report it with the
`--out` directory.

### The command's inputs

These come before the driver writes anything; fix the option and rerun.

| Message | What to do |
|---|---|
| `no jobsched at <path>` | Give `--jobsched` |
| `--candidate-dist <dir> is no directory` | Give the candidate build's directory |
| `--candidate-install-sh <path> is no file` | Give the candidate's `install.sh` |
| `<dir> holds no install.sh: give --candidate-install-sh FILE or --candidate-commit SHA` | Give one of them |
| `--candidate-commit <sha>: the AD checkout <repo> has no <sha>:skills/install-agent-director/install.sh` | Fetch the AD checkout or correct the commit; or give `--ad-repo` or `--candidate-install-sh` |
| `--durations <path> cannot be read: <reason>` or `--durations <path>: its first line is not "<header>"` | Give an earlier gate's `measured-durations.tsv` as it was written |

### `--out` and `--resume`

An `--out` from the previous fixed-default kit cannot be resumed with the
same default options: it recorded a numeric shard count where this kit
records no override. Keep that evidence and use a new `--out`; the refusal
is `--resume: the options differ from the recorded run's; give the same
options` (one line).

| Message | What to do |
|---|---|
| `--out <dir> is not a directory`, `--out <dir> cannot be read: <reason>` or `--out <dir> cannot be written: <reason>` | Give a directory path you can write, not a file's |
| `--out <dir> is not empty: choose a new --out, or pass --resume to continue its run` | Continue with `--resume` and the same options, or use a new `--out` |
| `--resume: <path> does not exist` | No gate ran in that `--out`: give a new or empty one without `--resume` |
| `--resume: <path> cannot be read: <reason>`, `--resume: <path> is not JSON: <reason>`, `--resume: <path> is not a JSON object` or `--resume: <path> is not an ad-gate state file` | Check that `--out` is the gate's directory. If it is, its `state.json` is damaged: start a new `--out`, which submits every shard again |
| `--resume: the options differ from the recorded run's; give the same options` | Rerun with the options recorded in `<out>/state.json` |

### Releases, tags and script names

These come after the driver writes `state.json` and before `prepare.sh`
runs. Rerun with `--resume`, or in a new `--out` when an option must change.

| Message | What to do |
|---|---|
| `agent-director could not run: …`, `agent-director version failed …`, `agent-director version's output is not JSON: …` (or `is not a JSON object`) or `the host's agent-director reports version …` | Give `--reference-tag` |
| `the reference tag <tag> in <AD checkout> failed …` | Fetch the AD checkout's tags, or give `--ad-repo` |
| `the reference v<X> is the candidate's own version: give --reference-tag with the release before it` | Give `--reference-tag` |
| `npm view claude-slack-channel-bots@latest failed …` or `npm's latest claude-slack-channel-bots is …` | Check registry access, or give `--cscb-version` |
| `claude-slack-channel-bots <version> has no tag v<version> in the kit's checkout: fetch its tags` | `git fetch --tags` in the CSCB checkout |
| `--only <name> names no integration script of claude-slack-channel-bots <version>`, or the same for `--inject-fail` | Name a script of that release: `test-<n>` or its file name |
| `--only <name> names <file>, which cannot run in the gate: -fmk-real- scripts need a model and test-13 needs the npm registry`, or the same for `--inject-fail` | Name another script; the gate never runs these |
| `--inject-fail <name> is not a planned script` | Name a script the run plans: with `--only`, one of those scripts or their prerequisites |
| `planning claude-slack-channel-bots <version>: <reason>` | See the planning row below |

### After `prepare.sh`

| Message | What to do |
|---|---|
| `prepare.sh failed for the <role> (exit <n>): <line>; see <path>/prepare.log` | Read `prepare.log` (a download, checksum or tag failed) and fix it. Rerun with `--resume`, or in a new `--out` when an option must change. A line naming `docker/Dockerfile.test.base` is about the downgrade fixture the tag pins (see [The job image](../../../docker/README.md#the-job-image)): a SHA-256 mismatch means npm serves another tarball than the pin, so report it; a tag with no single pin (any before v0.17.0) cannot be gated. A line naming `scripts/ci-run.ts` or `docker/entrypoint.sh` means the tag's burst-driver figures (`DRIVER_CPUS`, `CPUS_PER_SHARD`, `BURST_DRIVER_SCRIPTS`, `split_driver_cpu`) are missing, repeated or disagree: that tag cannot be gated; report it |
| `planning the <role> for claude-slack-channel-bots <version>: <reason>` | For `"<name>" names no integration script of the tag` or `<file> cannot run in the gate: …`, correct `--only` in a new `--out`. For `the tag's prerequisite headers are refused: …` or `the tag has no test-1`, that release cannot be gated: report it |
| `<context> holds no inputs/cscb-src/tests/integration: prepare.sh extracted no tests from the tag`, `the manifest <path> cannot be read: <reason>`, `the manifest <path> is not JSON: <reason>`, `the manifest <path> has no <cscb\|candidate\|cscb_downgrade> block`, `the manifest <path> has no valid burst_driver (null or {cpus, pattern}); …`, `the tag script <path> cannot be read: <reason>` or `the tag duration table <path> cannot be read: <reason>` | The context is incomplete: read `prepare.log`, then start a new `--out`. A context an earlier kit prepared has no `cscb_downgrade` block or no `burst_driver` |
| `the manifest <path> asks <n> CPUs for a burst-driver shard, above the scheduler's maximum of 8: …` | The tag's `CPUS_PER_SHARD + DRIVER_CPUS` exceeds the scheduler's `--cpus` maximum, so a new `--out` would be refused the same way: that tag cannot be gated on this scheduler; report it |
| `the tag classifies burst-driver scripts by /<pattern>/, not the kit's /<pattern>/: …` | The tag's `BURST_DRIVER_SCRIPTS` differs from the kit's, so the kit cannot tell its burst-driver shards: report it; gate that tag with a kit whose pattern is the tag's |
| `shard(s) <k> would need a timeout above jobsched's 12 h: use more shards or --durations` | Use more shards, or `--durations` with measured times |

### The scheduler

| Message | What to do |
|---|---|
| `jobsched list's output has no summary with active_slots_limit, active_slots_used and queued: give --shards N` | The slot counts are missing or invalid. Fix the scheduler's answer and rerun with `--resume`, or use a new `--out` with `--shards N` |
| `jobsched list's output is not JSON: <reason>` or `jobsched list's output is not a JSON object` | Fix the scheduler's answer, then rerun with `--resume`; nothing has been submitted |
| `jobsched list failed (exit <n>): <last line>` | Fix the command's failure, then rerun with `--resume`; nothing has been submitted |
| `jobsched submit refused adg-<v>-<role>-s<k> (exit <n>): …` | Fix the scheduler's reason, then rerun with `--resume`; shards already submitted are kept |
| `jobsched status <id> failed …`, `jobsched results <id> failed …` or `jobsched wait failed …` | Rerun with `--resume` once the scheduler answers |
| `jobsched status <id>'s output is not JSON: …` (or `is not a JSON object`), the same for `jobsched results <id>'s output` and `jobsched wait's output`, `jobsched wait's output lists no jobs`, `jobsched status <id> gave no state` or `job <id>'s run.log <path> cannot be read: <reason>` | The driver could not read the scheduler's answer: rerun with `--resume`. If it repeats, report it with the scheduler's output |

### A changed kit or plan

| Message | What to do |
|---|---|
| `the <role> plan recorded in state.json differs from the one its context gives now, and jobs were submitted from it: start a new --out` | Start a new `--out` |
| `the <role> context's <files> differ from the kit's, and jobs were submitted from it: start a new --out` | The kit changed under a running gate: start a new `--out` |
