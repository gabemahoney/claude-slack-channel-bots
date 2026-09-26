# CSCB docker test images

The `/ci` integration-test image is split into two stages so the slow,
source-independent layers (apt deps, bun, nodejs, cozempic, agent-director)
cache as a separate image and don't get invalidated on every CSCB source edit.

## Images

- **`cscb-ci-base:v3`** (built from `docker/Dockerfile.test.base`) — slow base
  layers (apt deps incl. tmux, bun, nodejs, cozempic, agent-director). Built
  lazily once per host. ~1+ GB. No CSCB source inside.
- **`cscb-ci:latest`** (built from `docker/Dockerfile.test`, `FROM cscb-ci-base:v3`)
  — adds `docker/entrypoint.sh`, `tests/`, `testplans/`, the `testuser` account,
  and the `ENTRYPOINT`. Built on every `/ci` run; should complete in under 10 s
  on a warm base.
- **`cscb-ci-live:latest`** (built from `docker/Dockerfile.live`, `FROM cscb-ci-base:v3`)
  — the `/ci-live` image (see [/ci-live](#ci-live-the-live-slack-acceptance-run)
  below). It adds Claude Code at a pinned version with auto-update off, the
  agent-director the production host runs (see
  [The live image's agent-director](#the-live-images-agent-director)), a
  `testuser` with the host's uid and gid, and `docker/live/`: the entrypoint,
  and the testplan's shell helpers and pre-flight adapted to the container.
  The package under test is not in the image; the runner mounts its tarball.
  Built on every `/ci-live` run.

`/ci` detects whether `cscb-ci-base:v3` exists locally; if absent, it builds the
base first, then builds `cscb-ci`. The base build is a one-time per-host cost
per version tag. `/ci-live` does not build the base: it stops (exit 2) and asks
for one `/ci` run when the base is missing.

The base build fetches bun and the agent-director binary from GitHub, and `/ci`
runs it with `docker build --network=host`. On some hosts the default docker
bridge network intermittently fails those fetches with SSL/timeout errors even
when the host itself reaches the same URLs fine; host networking sidesteps that.
It affects only the one-time base build, so the blast radius is minimal. If you
invoke the base build by hand (e.g. the cold-cache path below), pass
`--network=host` too if you hit a fetch failure.

## Credential env vars passed to the container

`/ci`'s `docker run` step forwards `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and
`ANTHROPIC_MODEL` from the host environment (each via the no-value `--env VAR`
pass-through form). The bot Claudes spawned by the daemon-under-test consume
these. A raw `sk-ant-api…` key needs only `ANTHROPIC_API_KEY` — Claude Code
defaults to `api.anthropic.com` when `ANTHROPIC_BASE_URL` is absent. A gateway
credential (e.g. NVIDIA InferenceHub) additionally requires `ANTHROPIC_BASE_URL`
and `ANTHROPIC_MODEL` so the bot Claudes hit the gateway rather than
`api.anthropic.com`; if only the key were forwarded, the gateway key would 401
against Anthropic's direct endpoint.

`/ci-live` never reads the host's `ANTHROPIC_*`: its container gets them from
`CI_ANTHROPIC_*` (see [Secrets](#secrets) below).

## When to bump the base image version

Bump `cscb-ci-base`'s version tag (e.g. `v1` → `v2`) whenever you change
`docker/Dockerfile.test.base`. There is **no** automatic version derivation —
bump it manually in every place that names it:

1. The `FROM` line in `docker/Dockerfile.test`.
2. The `BASE_TAG` variable in `.claude/skills/ci/SKILL.md`.
3. The `FROM` line in `docker/Dockerfile.live`.
4. `BASE_IMAGE` in `ci-live/lib/docker.ts`.
5. The tag in `.claude/skills/ci-live/SKILL.md` (twice) and in
   `ci-live/README.md`'s "Where you start".
6. This file: the image list above, the `/ci` paragraph after it, and the
   commands under the two "Verifying" sections below.

Common reasons to bump: bumping the bun installer, changing the nodejs major,
adding/removing an apt package, changing the cozempic install, or changing the
`agent-director` range in `package.json` (the base reads it at build time).
The live image needs no bump of its own for a range change: it reads the
range at every build (see
[The live image's agent-director](#the-live-images-agent-director)).

After bumping, the next `/ci` on every host will rebuild the base.

## Verifying the cold-cache path

To simulate a fresh host:

```bash
docker rmi cscb-ci-base:v3 cscb-ci:latest 2>/dev/null
/ci   # or invoke the build sequence from the skill manually
```

The first build should take minutes (apt + bun + nodejs + pip + bun-add). Time
it; if it exceeds the Claude Code Bash tool's 10-minute timeout, raise an
issue.

## Verifying warm-cache parity

After a `/ci` run, confirm the base layers are intact:

```bash
docker history cscb-ci-base:v3
```

Then edit a comment in (e.g.) `tests/integration/test-1-install-startup.sh`
and re-run the build:

```bash
docker build -f docker/Dockerfile.test -t cscb-ci .
```

This should complete in seconds. `docker history cscb-ci-base:v3` should show
the same layer IDs as before — proof the source edit didn't invalidate the
base.

## /ci-live: the live Slack acceptance run

`/ci-live` (`bun ci-live/run.ts`) runs the `testplans/b.yko` live acceptance
checks against real Slack, in the test workspace `cscb-ci-test` only, never a
production workspace. It is the pre-deploy check for a release. `/ci` never
connects to Slack; `/ci-live` installs the packed package in a throwaway
container the way a customer does, runs it as four test personas, and drives
each check as the test human in headless Chrome.

First-time setup (the secrets, the one-time sign-in, the test mailbox, the
run command) is in `ci-live/README.md`. The skill is `.claude/skills/ci-live/SKILL.md`. The
runner lives in `ci-live/` and is not part of the npm package.

### What a run does

1. Prints `RESULTS_DIR=<dir>` as its first line (see [Outputs](#outputs)).
2. Takes the run lock (see [One run at a time](#one-run-at-a-time)).
3. Checks its preconditions: docker, the base image, the host's
   agent-director binary, the Claude credentials, the modes of the secret
   files, and a password or saved session for the test human. It stops with
   exit 2 if one fails.
4. Starts the memory watchdog, which samples until the results are written
   (see [Memory bounds](#memory-bounds)).
5. Takes the HOST snapshot (see [Isolation](#isolation-from-the-production-bots)).
6. Removes containers an earlier run left behind (label `cscb-live=1`, and
   only those), never one whose run is still in progress.
7. Provisions the test workspace. Each stage re-verifies what exists and skips
   what is already right, so a rerun changes nothing:

   | Stage | What it does | Skipped when |
   |---|---|---|
   | apps | Creates the four apps "CSCB Test A" to "CSCB Test D" from `slack-app-manifest.yml` through the manifest API, with the app configuration token. Before each create it records the intent (`pending_create`) in `apps.json`, and replaces it with the new app ID the moment Slack returns it. A drifted manifest is updated and the app re-installed | the app in `apps.json` exists and matches the manifest |
   | sign-in | Signs the test human in, in headless Chrome, reading an emailed new-device code from the test mailbox (see [The test mailbox](#the-test-mailbox)) | the saved session is still signed in |
   | install | Installs each app as the test human and reads its bot token from the app's OAuth & Permissions page into the persona's credentials file. A new bot token drops the file's old app-level token, so a file never mixes two apps' tokens | the saved bot token passes `auth.test` for the right app |
   | tokens | Generates an app-level token `cscb-live-<RUN_ID>` (`connections:write`) on each app's Basic Information page and records its name in `apps.json` | the saved app token passes `apps.connections.open` |
   | channels | Ensures public channels `a-home`, `coordination` and `d-home` (the plan's A-home and D-home: Slack channel names are lowercase), with A in `a-home` and `coordination`, B in `coordination`, D in `d-home` and C in none | — |
   | validate | Checks every credentials file and reports `ok` or `failed` per persona | — |

   The stages guard what already works:

   - **No apps.json, no apps.** A real run with no `apps.json` creates no app
     and stops (exit 2): the four apps may already exist, created from
     another VM. Copy `apps.json` from that VM, or pass `--create-apps` to
     create new ones.
   - **A malformed apps.json is never read as empty.** One that doesn't
     parse, or isn't a JSON object, stops every command that reads it (exit
     2), since every app it records would otherwise look unrecorded: one to
     create again, or a stray to delete. Only a missing file counts as
     recording nothing.
   - **A create is never retried blindly.** When `apps.manifest.create` gets
     no answer (a network error, a timeout, a 5xx), Slack may have created
     the app anyway: the run stops (exit 2) and `apps.json` keeps the
     intent. A 4xx answer, or `ok: false`, means no app was created: the
     intent is cleared.
   - **An unfinished create is resolved, never repeated.** A persona whose
     `apps.json` entry holds only the intent (a run stopped between the
     intent and the app ID, or the create got no answer) is looked up on the
     test human's apps list (<https://api.slack.com/apps>, read in the
     browser). A candidate is an app of the persona's exact name that
     `apps.json` doesn't record and that the configuration token exports
     under that name. One candidate is adopted: recorded, then checked like
     any recorded app. None means the create made no app: the intent is
     cleared and the app created. More than one stops the run (exit 2),
     naming them: delete them with `apps --delete-strays` (see
     [Maintenance commands](#maintenance-commands)), then rerun. Only an
     export answer that the app is missing, or a manifest naming another
     app, rules an unrecorded app of the name out. One whose export proves
     nothing (another Slack error, no answer, no manifest name) may be the
     app the create made, so it stops the stage, as does an apps list that
     can't be read: `apps.json` keeps the intent, nothing is created, and
     the reason says to rerun.
   - **The configuration token is optional once the apps exist.** When
     `apps.json` records all four app IDs and the token is missing, empty or
     refused (expired with no refresh token, or a refused rotation), the
     stage logs a `WARNING` (never the value) and reuses the recorded apps
     without their export, drift check or update. Each is logged as
     `reused … (unchecked: no usable configuration token)`. Creating an app
     or resolving an unfinished create still needs the token (exit 2
     without it).
   - **A token is replaced only when Slack refuses it.** The install and
     tokens stages re-install an app or generate a new app-level token only
     when Slack refuses the saved token (or it belongs to another app). A
     transient failure (a network error, a timeout, a 5xx, a 429 after the
     retries, `internal_error` and the like) stops the stage with
     "(transient: rerun later)" and replaces nothing.

8. Opens the test human's session (and the second account's, when
   configured).
9. Packs the working tree (`npm pack --ignore-scripts`), builds
   `cscb-ci-live` and starts the container with its memory and PID caps.
10. Runs the plan's checks in the plan's order, then Teardown and HOST.
11. Writes the results, with the watchdog's peaks, and runs the closing
    secrecy scan.

A failure of provisioning, the session, the image build or the container
start, other than an exit-2 stop, is a FAIL row of its own (`provision`,
`session` or `container`). The plan's checks then don't run, but the HOST
check, the results and the closing secrecy scan still do.

### Isolation from the production bots

The host that runs `/ci-live` may also run the production bots, so the test
install shares nothing with them:

- **Its own container.** `cscb-live-<RUN_ID>-<PID>`, the runner's PID
  making the name unique even for two runs started in the same second (the
  hostname is the same), has
  its own HOME (`/home/testuser`), state directory, tmux server,
  agent-director store and port 3100.
- **Default docker network.** Never `--network=host`, no published port,
  never privileged.
- **Capped.** `--memory 8g`, `--memory-swap 8g` and `--pids-limit 2048` (see
  [Memory bounds](#memory-bounds)).
- **Two mounts only, both read-only.** The tarball (`/tmp/package.tgz`) and
  `~/.config/cscb-test/credentials/` (as the test user's `~/.config/cscb`).
  The host's `~/.claude` is never mounted, nor any directory that holds it.
  A guard checks every `docker run` argument list before it is spawned: it
  accepts only the flags the runner uses, in any spelling, and refuses
  `--network`, a published port, a host namespace, `--privileged`,
  `--volumes-from`, a mount other than a bind mount, and a secret variable
  passed with its value. It also requires the three caps.
- **Commands run inside it.** Every command that starts, stops or changes
  CSCB, tmux or agent-director goes through one `docker exec` helper that
  accepts only `cscb-live-<RUN_ID>-<PID>` names. Inside, the plan's `guard` passes only
  on the container's hostname, as `testuser`, with no token variable and no
  `SLACK_STATE_DIR`.
- **Removed after each run.** The runner removes the container at the end,
  on SIGINT (Ctrl-C), SIGTERM or SIGHUP (see
  [One run at a time](#one-run-at-a-time)), and at the next run's start if a
  run died. It removes only a container whose `cscb-live-owner` label names
  its own PID, so one run never removes another's. `--keep-container` keeps
  it for inspection (`docker rm -f cscb-live-<RUN_ID>-<PID>` removes it); a
  memory watchdog stop still stops it (see [Memory bounds](#memory-bounds)).
- **The HOST check.** Before the run and after it, the runner reads, and only
  reads: the host's `service=cscb` agent-director rows (from the store CSCB
  uses, `~/.agent-director/state.db`), its `slack_bot_*` and `cscb_*` tmux
  sessions (with the host's `TMUX_TMPDIR`, so it reads the production bots'
  tmux server), the PID listening on host port 3100 (from `/proc`, nothing
  connects) and the sha256 of the host's
  `~/.claude/channels/slack/config.json`. Any difference fails the run, and
  so does a probe that fails before or after (`probe failed: …`), since two
  failures would otherwise compare equal. It runs even when provisioning or
  an earlier check failed.

A change the production side makes on its own during the run also fails the
HOST check. Leave the production install, its config and its tmux sessions
alone while a run is going.

### One run at a time

- **The run lock.** A real-mode command (a run, `--provision-only`,
  `login`, `config-token --rotate` or `apps`) holds the lock file `run.lock`
  (its PID) in the config directory. A second one exits 2 and names the PID
  that holds the lock. A dry run holds a lock of its own in the temp
  directory (`cscb-ci-live-dry-run-<uid>.lock`), so a dry run and a real run
  can go side by side. The `mailbox` command takes no lock.
- **A stale lock.** A lock whose PID is not running, or runs something
  other than a `/ci-live` runner (the PID was reused, as after a VM reboot),
  is stale. The runner removes it with a warning that names the path, the
  PID and why, such as
  `WARNING: removed the stale run lock <path>: its PID <pid> is not running`,
  then takes the lock. A run writes the warning to its output and
  `run.log`, the maintenance commands to stderr.
- **Leftover containers.** Each container carries its runner's PID in the
  label `cscb-live-owner`. A run removes a leftover `cscb-live=1` container
  only when its runner is gone, so a dry run never removes a real run's
  container, nor the reverse. A container with no owner label (from an older
  runner) is removed only when no run of the other mode holds its lock.
- **Stopping a run.** SIGINT (Ctrl-C), SIGTERM and SIGHUP (a closed terminal
  or a killed tmux session) stop a run the same way: no new container
  starts, the test container is removed (unless `--keep-container`), D's
  credentials file goes back to `credentials-staged/`, the browser closes,
  and the results so far are written with a `runner` FAIL row and the
  verdict `FAIL: runner: interrupted by <signal>`. Then the runner releases
  the lock and exits 1. A second signal during that cleanup is ignored. The
  memory watchdog stops a run the same way, with the differences in
  [Memory bounds](#memory-bounds).
- **What the cleanup did.** A stopped run's note (the Notes of the results
  row, and `notes` in `results.json`) says what stopped it, then what its
  cleanup actually did with the container (below) and the browser (closed,
  or `may still be open` when its close did not finish).
- **A lost terminal.** Output to a terminal or pipe that has gone away (a
  `tee` that exited) never stops the run or its cleanup: `run.log` keeps
  every line.

The note's container part:

| The container | The note says |
|---|---|
| None started yet | `no test container had been started` |
| Removed | `the test container was removed (or was already gone)` |
| Its removal failed | `… could not be removed (see run.log): remove it with docker rm -f <name>` |
| `--keep-container` | `… was kept running (--keep-container)` |
| `--keep-container`, a memory watchdog stop | `… was stopped with docker stop (its memory freed) and kept for inspection (--keep-container)`, or, when `docker stop` failed, `… may still be running; stop it with docker stop <name>` |
| The cleanup did not finish | `… may still exist (the cleanup did not finish)` |

### Memory bounds

An uncapped run once froze the whole VM, the pod (64 GiB) that the
production bots share. The cause is unknown, so a run bounds its memory three
ways: caps on the container, one bounded Chrome, and a watchdog that stops
the run.

**The container's caps.** Every `docker run` sets:

| Flag | Value | Why |
|---|---|---|
| `--memory` | `8g` | Four persona Claude Code sessions (about 0.5 to 1 GiB each, with their MCP servers and tools), the server, agent-director, tmux and the checks' `docker exec` shells peak at about 4 GiB. 8 GiB is twice that, and an eighth of the pod |
| `--memory-swap` | `8g`, the same as `--memory` | No swap on top of the cap: past 8 GiB the kernel OOM-kills a process inside the container instead of the host thrashing |
| `--pids-limit` | `2048` | A healthy run stays in the low hundreds of processes. 2048 stops a fork or spawn loop long before it reaches the host |

The `docker run` guard refuses an argument list without all three, with one
of them twice, with `-1` or `0` (no limit), or with `--memory-swap` other
than `--memory`. The run log shows
`container: starting cscb-live-<RUN_ID>-<PID> with --memory 8g (--memory-swap the same) and --pids-limit 2048`.

**One bounded Chrome.** A command launches one Chrome, on first use:

- **One context per account.** The test human's, and the second account's
  (a context of its own) when `live.json` configures one: 2 at most.
- **One page per context.** Every flow reuses it, so 2 pages at most. A page
  a site opens on its own (a popup) is closed at once.
- **Idle on `about:blank`.** After each flow the page goes to `about:blank`,
  so no Slack page, and above all not the web client, stays live between
  checks.
- **Memory flags.** `--js-flags=--max-old-space-size=1024` (a 1 GiB V8 heap
  per renderer: a runaway page crashes its own tab),
  `--renderer-process-limit=2`, `--disable-dev-shm-usage` (shared memory in
  `/tmp`, since `/dev/shm` is small in a pod) and `--disable-extensions`.
- **A crashed page is replaced.** When a page's renderer dies (past its heap
  cap, say), the run logs `browser: the page crashed …`, and the next flow
  closes that page and opens a fresh one in its place.

`login` launches a Chrome of its own with the same flags.

**The memory watchdog.** A run, `--provision-only` and a dry run included,
samples memory every 30 s from just after its preconditions to its results,
and writes one `watchdog:` line to `run.log` per sample:

| Part of the line | What it reads |
|---|---|
| `host` | The host (pod) cgroup: the working set (`ws`), which is `memory.current` minus `inactive_file` from `memory.stat` (page cache the kernel can drop is not use, as the kubelet counts it), then `memory.current` and `memory.max` |
| `container` | The test container's `docker stats`: memory use and limit, and its PIDs. `container not running` before it starts and after it is removed; `container not read (the watchdog stopped)` in a sample that ends after the watchdog stopped, which skips `docker stats` |
| `chrome` | Chrome's process tree (the runner's descendants that are Chrome): its summed PSS (`pss=`, which counts pages shared between Chrome's processes once), its process count, and the browser's open pages (how many idle on `about:blank`) and contexts. A process whose `smaps_rollup` can't be read counts its RSS instead, and the line says how many did (`rss fallback for <n>`) |
| `runner` | The runner's own RSS |

It stops the run when the host working set passes 40 GiB (well below the
pod's 64 GiB, leaving room for the production bots) or Chrome's tree PSS
passes 4 GiB (a healthy run stays well under it). Each limit is checked as
soon as its reading arrives, the host's first, then Chrome's, before the
slower `docker stats` and before the sample's line is written, so neither a
slow reading nor a line that can't be written delays the stop. A reading
that fails (`docker stats` erroring, no cgroup v2 files) is noted in its
line and never stops the run.

It stops the run the way a signal does (see
[One run at a time](#one-run-at-a-time)), with two differences:

- **Chrome closes at once**, alongside the container's removal, never after
  it, and without waiting for a flow or a sign-in in progress.
- **A kept container is stopped.** With `--keep-container`, the container
  is stopped with `docker stop` (its memory freed) and kept for inspection
  (`docker start` restarts it, `docker rm -f` removes it), not left running.

The results so far are written with a `memory watchdog` FAIL row, and the
run exits 1. The verdict names what crossed its limit, its value and the
limit, such as
`FAIL: memory watchdog: host working set 41.2 GiB is over the 40.0 GiB limit (…)`.
The run's note says what the cleanup actually did (see
[One run at a time](#one-run-at-a-time)).

A full run (a dry run included) that ends on its own takes a last sample
(after any sample still in flight), then stops the watchdog. The
`watchdog peaks:` lines in the run's output and `run.log` come after the
last `watchdog:` line and give the peak of each reading and when it was
sampled. `results.json` has them under
`memory` (with the sample count, the limits and any stop reason), and
`results.md` under "Memory (the watchdog's peaks)".

### The live image's agent-director

The live image pairs CSCB with the agent-director the host's production bots
run, not the base image's older one:

- It installs the npm package `agent-director` at the range in
  `package.json`, as a customer's install resolves it.
- The runner copies the host's `agent-director` binary
  (`~/.agent-director/bin/agent-director`, else the first one on `PATH`) into
  a temporary directory that the build sees as the named context
  `agent-director-bin`. The image puts it first on `PATH`.
- The build fails when the binary's version is not the npm package's, or is
  below the package's version floor (`dist/version-floor.json`). The run then
  reports a `container` FAIL row saying the host binary does not match the
  npm package; `run.log` has the build's message. Upgrade the host binary to
  the npm package's version (the `install-agent-director` skill), then rerun.
- With no agent-director binary on the host, a run, a dry run included,
  stops with exit 2.

### Secrets

The runner keeps its secrets and state in `~/.config/cscb-test/`
(`CSCB_LIVE_CONFIG_DIR` overrides it), outside the repo:

| File | Holds | Secret | Written by |
|---|---|---|---|
| `live.json` | `workspace_domain`, `test_email`, optional `second_user` | no (the email is config, never logged) | the operator |
| `slack_config_token`, `slack_config_refresh_token` (optional) | the app configuration token and its refresh token. The configuration token is optional too once `apps.json` records all four apps | yes | the operator; the runner rewrites both after a rotation |
| `test_password` (or env `CSCB_LIVE_TEST_PASSWORD`) | the test human's password | yes | the operator |
| the file or variable `live.json`'s `second_user` names (`password_file`, `password_env`) | the second account's password | yes | the operator |
| `playwright-state.json`, `playwright-state-second.json` | the browser sessions (cookies) | yes | the runner, or `login` / `login --second` |
| `apps.json` | app, bot, team, channel and user IDs, each app's app-level token name, and a persona's `pending_create` intent while its create is unfinished | no | the runner |
| `mailbox.json` (optional) | the test mailbox's mail.tm account: `provider`, `api`, `address`, `password`, `account_id`, `token` | yes (the password and the token; the address is not) | the operator; the runner rewrites the token |
| `run.lock` | the PID of the real-mode command in progress | no | the runner |
| `credentials/persona_{a,b,c}-credentials.json` | `bot_token` and `app_token` per persona | yes | the runner |
| `credentials-staged/persona_d-credentials.json` | D's tokens, until Check 25 moves them into `credentials/` | yes | the runner |

How they are handled:

- **Private files only.** Neither the directory, nor a secret file
  (`mailbox.json` and the personas' credentials files included), nor
  `live.json` may be group- or other-accessible (use 700 and 600).
  Otherwise every command that reads them refuses (exit 2), naming the path,
  its mode and the `chmod 600` or `chmod 700` that fixes it. A run,
  `--provision-only`, `login`, `config-token` and `apps` check the whole
  layout first, in one message that names each loose path, its mode, and
  the `chmod` command(s) that fix them all: `chmod 700` for the directories
  and `chmod 600` for the files, each only when one of its kind is loose.
  The runner never changes a mode itself.
- **A reboot can loosen modes.** At boot the pod's `fsGroup` re-applies its
  group to the files, leaving modes such as `660` or `2770`. The refusal says
  so; after a VM reboot, check the modes (see `ci-live/README.md`).
- **Written privately.** The runner writes a secret only to a mode-600 temp
  file, fsynced, that it renames into place.
- **No environment passes through.** Every child process (docker, npm,
  Chrome, the host probes) gets an allowlisted environment: paths, user,
  locale, `TMPDIR`, `TMUX_TMPDIR`, `XDG_RUNTIME_DIR` and docker's own
  variables. The host's `SLACK_BOT_TOKEN`,
  `SLACK_APP_TOKEN` and its own `ANTHROPIC_*` never reach the container.
- **Claude credentials by name only.** The host's `CI_ANTHROPIC_API_KEY`,
  `CI_ANTHROPIC_BASE_URL` and `CI_ANTHROPIC_MODEL` become the container's
  `ANTHROPIC_*`. The values are set in the `docker run` process's environment
  and passed as bare `--env NAME`, so no value is in any argument list. A raw
  `sk-ant-` key needs only the key; a gateway key also needs the base URL and
  model. A real run stops (exit 2) without them; a dry run needs none.
- **The configuration token** is used only for the manifest API calls on the
  four test apps (and the deletes of `apps --delete-strays`), sent in the
  request and never on a command line. The credentials block of the create
  response (client and signing secrets) is never read or stored.
- **Its rotation.** When Slack refuses the token as expired and there is a
  refresh token, the runner rotates the pair once with
  `tooling.tokens.rotate` and retries. A rotation spends the old refresh
  token, so the new pair is saved before anything uses it: both files, mode
  600, each written atomically (temp file, fsync, rename), the refresh token
  first. The log says
  `config token: rotated with tooling.tokens.rotate; both token files rewritten (mode 600)`.
  If the new pair can't be saved, the run stops (exit 2): generate a new
  pair. `config-token --rotate` forces one rotation (see
  [Maintenance commands](#maintenance-commands)).
- **One redactor.** Every progress line, log line and result passes through
  it, before it is written as JSON or Markdown. It masks every secret value
  the run knows of 4 characters or more (the passwords, the configuration
  tokens, the generated tokens, the web session token and cookie, the Claude
  key, the test emails, the test mailbox's password and token, an emailed
  sign-in code), as it is and in its JSON-
  and Markdown-escaped forms, and any token-shaped text (`xox?-…`, `xapp-…`,
  `xoxe…`).
- **No browser recordings.** No tracing, video or screenshots.
- **Closing secrecy scan.** After the results are written, the runner counts
  token-shaped strings and known secret values (escaped forms included) in
  every file of the results directory and in the container's docker logs.
  The run fails unless the count is 0, and unless a planted string is found
  (a positive control). Check 29a runs the plan's own leak counts inside the
  container.

### The test mailbox

Slack emails the test human a sign-in code when it sees a new device. The
test mailbox, a mail.tm account in `mailbox.json`, receives that email
through a Gmail filter (setup in `ci-live/README.md`), so a run answers the
code itself:

- **The order.** At Slack's code prompt for the test human, the run first
  reads the code from the mailbox. Only when that gives none does it stop
  (exit 2, "Slack asked for an emailed sign-in code"); the operator then runs
  `login`, which asks on the terminal.
- **The wait.** Every 5 seconds, for up to 2 minutes, it looks for a code
  email from Slack (slack.com or slack-mail.com, a subject naming a code)
  received after the sign-in started, newest first, and reads each message
  once. A message that names two different codes gives none. If Slack
  refuses a code, the run looks for a newer one, 3 codes at most. Before
  typing, it clears the code field, and a refusal still showing from an
  earlier code doesn't count against the new one.
- **Only the test human's code.** The filter forwards from a Gmail inbox that
  may hold other accounts' mail, so a code email counts only when it was sent
  to the test email exactly (case-insensitive; the address without its `+`
  tag does not count). The run checks the recipients mail.tm lists (`to`,
  `cc`) and, when those show only the mailbox, the original message's `To`,
  `Cc`, `Delivered-To` and `X-Original-To` headers (read from mail.tm's
  message source). Forward from the inbox that receives the test email.
- **Failures.** A failed poll (a network error, a timeout, an HTTP error, a
  rate limit after the retries) costs only that poll. mail.tm refusing the
  mailbox's address and password ends the wait. A failure of the code prompt
  itself (it expired or redirected) also ends it, with the same exit 2 and
  `login` advice.
- **The log.** `sign-in code: Slack emailed a code; waiting up to 2 min for
  it in the mailbox`, then `sign-in code: read from the mailbox`. Otherwise
  one of `sign-in code: no mailbox configured (mailbox.json)`,
  `sign-in code: the mailbox is unusable (…)`,
  `sign-in code: not received within 2 min` or, after refused codes,
  `sign-in code: Slack accepted no code from the mailbox within 2 min`. A
  failed poll is a `run.log` line (`sign-in code: a mailbox poll failed (…);
  polling on`). The code joins the redactor before the "read" line, so no
  output shows it.
- **The mail.tm calls.** The token travels only in the `Authorization`
  header. A 401 gets a fresh token from `POST /token` once; the runner
  registers it with the redactor, then rewrites `mailbox.json` (a mode-600
  temp file, renamed). A 429 is retried after its `Retry-After`, else after
  1, 2, 4 … seconds (30 at most, 4 retries). An error names the call and the
  HTTP status, never a token, the password or a body.
- **The second account.** Its mail is not forwarded: its code still needs
  `login --second`.

The `mailbox` command reads the mailbox for the operator. It takes one of
`--latest` and `--forwarding`, never both. It holds no lock, so it runs beside
a run, and writes no results directory or `run.log`:

| Command | Prints |
|---|---|
| `bun ci-live/run.ts mailbox --latest` | The newest message: the mailbox's address, when the message came, its sender and subject, and a Gmail forwarding code found in it, else `no confirmation code found in it`. A Slack sign-in code is never printed without `--show-body`: the subject shows `<code>` in its place and a line says a code is in it |
| `bun ci-live/run.ts mailbox --forwarding` | The same for the newest Gmail forwarding confirmation (from google.com, subject "Forwarding Confirmation"), even when newer mail came after it, plus `confirm link: <url>` on a line of its own |
| `--show-body` (with either) | The message's body too, unfiltered, and a Slack sign-in code in the clear: for the forwarding email the body also holds Gmail's cancel link |

- **Senders and addresses.** A Slack or Google sender is shown as it is, any
  other only as `an address at <domain>`. Every other address in the output
  is `<email>`, except the mailbox's own; the test human's address is masked
  with and without its `+` tag.
- **The confirm link.** `--forwarding` prints Gmail's confirm link on
  purpose: opening it approves the forwarding. It takes only an https link on
  mail-settings.google.com (or google.com) that the message marks as the
  confirm link, never one it marks as the cancel link, and prints none when
  there are two.
- **Exit codes.** `0` when it printed a message. `2` when there is no
  `mailbox.json`, no message (or no forwarding confirmation), the file is
  open to group or others or is not a usable mailbox, or mail.tm refuses its
  password. `1` on any other failure (`ERROR: …`).

### Maintenance commands

Three commands look after the configuration token and the test apps. Each
takes the real run lock, so none runs beside a run, `--provision-only` or
`login`. None writes a results directory or `run.log`: each prints its own
lines on stdout, or one error on stderr (`not runnable: …` with exit 2, or
`ERROR: …` with exit 1), every line through the redactor. A signal closes
the browser, releases the lock and exits 1. One that comes while a rotated
pair is being saved waits for the save.

| Command | Does |
|---|---|
| `bun ci-live/run.ts config-token --rotate` | Rotates the configuration token pair once with `tooling.tokens.rotate`, saves both files as a run's rotation does (see [Secrets](#secrets)) and prints `config token: rotated with tooling.tokens.rotate; both token files rewritten (mode 600)`. Exit 2 with no refresh token, or when Slack refuses it: generate a new pair |
| `bun ci-live/run.ts apps --list` | Lists every app the test human sees at <https://api.slack.com/apps>, read in headless Chrome as the test human (the saved session, else a sign-in as a run does). One line per app: its ID, its name, and `in apps.json (persona A)`, `NOT in apps.json: a stray test app` or `not in apps.json`, with `test workspace` or `not shown in the test workspace` when the test workspace's name is known. It names any unfinished create in `apps.json` and ends with the count of stray test apps. Needs no configuration token |
| `bun ci-live/run.ts apps --delete-strays` | The same list, then deletes the stray test apps with `apps.manifest.delete` (below). Needs the configuration token |

Both `apps` commands stop (exit 2) on an `apps.json` that doesn't parse or
isn't a JSON object.

A stray test app is one named exactly "CSCB Test A", "CSCB Test B", "CSCB
Test C" or "CSCB Test D" whose ID `apps.json` doesn't record: left by a
create whose answer was lost, or by an earlier `apps.json`.
`--delete-strays` runs only when `apps.json` exists and records at least one
app ID. Otherwise every test app, the live ones another VM records
included, would look like a stray: it stops (exit 2) before it starts
Chrome, and deletes nothing. It deletes a stray only when all of these hold:

- its name is exactly one of the four;
- `apps.json`, read again just before the delete, doesn't record its ID;
- one cell of its row on the apps list, less the app's own name, is exactly
  the test workspace's name (from the test human's `auth.test`), so a
  workspace whose name only contains it doesn't count;
- `apps.manifest.export` with the configuration token, which is the test
  workspace's, answers for it under the same name.

It never deletes an app `apps.json` records, and ignores every app of
another name. When `apps.json`, read again before a delete, no longer
records an app ID or no longer parses, it stops there (exit 2). A stray that
fails a condition, or whose delete Slack refuses, is kept and named with the
reason: not shown in the test workspace, the test workspace's name unknown,
recorded in `apps.json` by then, the export failed, got no answer, gave no
manifest name or names another app, or the delete failed. The last line is
`apps: deleted <n> stray test app(s), kept <m>`. The exit code is 0 when it
kept none, 1 when it kept any.

### Dry run

`bun ci-live/run.ts --dry-run` checks the harness without the workspace. It
reads no secret: its config directory is a fresh temp directory, and the
secret store refuses any path under the real one.

- A local stub stands in for Slack's Web and manifest APIs, and local fixture
  pages for the sign-in, install, OAuth & Permissions and app-level token
  pages. Headless Chrome drives the real browser flows through them, plus a
  permission-button click and a token revoke.
- The stub sign-in always asks for an emailed code, and a stub mail.tm
  mailbox holds it. The dry run fails unless it refreshes the stub's stale
  token after a 401 (rewriting its `mailbox.json` mode 600), backs off a 429,
  skips an older code, a look-alike sender and a newer decoy code sent to
  another address of the same inbox (decided from the message source's
  headers), gets its first code refused and then types the newer right one
  into a cleared field past the stale refusal, and picks the Gmail forwarding confirmation past newer mail with its confirm
  link, not its cancel link. It never reads the real `mailbox.json`.
- Its provisioning row also proves the new safeguards on the stub:
  - **An unfinished create.** `apps.json` holds only the intent for "CSCB
    Test C", and the fixture apps list shows two such apps, one of another
    workspace. The run adopts the test workspace's, leaves the other alone
    and creates only the other three apps.
  - **The rotation.** The configuration token rotates twice, forced (as
    `config-token --rotate` does) and on a `token_expired` manifest call,
    which is retried with the new token. Each time both files are rewritten
    with the new pair, mode 600.
  - **The strays.** `apps --delete-strays` deletes a stray "CSCB Test B"
    and keeps the four recorded apps and the other workspace's "CSCB Test
    C".
  - **The bounded browser.** After its flows the browser is one Chrome with
    one context and one page, on `about:blank`.
- The memory watchdog runs as in a real run.
- It builds the image and starts the container with no Claude credentials.
  The pre-flight, the install, the setup, S2, S3, 29a, Teardown and HOST run
  for real. Every check that needs the workspace reports
  `SKIPPED (no workspace secrets)`.
- The verdict is PASS when every check is PASS or SKIPPED. The closing scan
  must also find none of the stub's fake tokens in the outputs.

It needs docker, the base image, the host's agent-director binary, Google
Chrome and the runner's dependency (`bun install --ignore-scripts` in
`ci-live/`). It takes about a minute on a warm image cache, and holds its own
lock, never the real one. The `/ci-live` skill runs it first, as a gate.

### What runs per check

The checks run in the plan's order. A FAIL of the pre-flight, the install, the
setup or Check 1 skips every later check (`SKIPPED (blocked by <id>)`) except
29a, Teardown and HOST.

A check waits for a persona's answer with a deadline. It polls only the
conversation it watches, from the check's own start, and reads a thread only
when it has a new reply. A transient Slack failure during a wait (a network
error, a timeout, a 5xx, a rate limit, `internal_error` and the like) counts
as "not yet", not as a FAIL.

| Check | In `/ci-live` |
|---|---|
| Provisioning | A result row of its own (the stages above) |
| Pre-flight, Part 1.4 install | Automated in the container. The install is `bun install -g --ignore-scripts` of the tarball, then `bun pm -g trust` |
| Part 1.5 setup | The runner writes `config.json` and the system prompt as the wizard's answers would (a deviation noted in the results) |
| S1 | `SKIPPED (manual only: the wizard chat)` |
| S2, S3 | Automated, also in a dry run |
| 1 to 6, 8 to 11, 13 | Automated |
| 7 | Automated. The crash is a guarded `tmux kill-session` of A's session in the container |
| 12 | Automated. If the personas keep posting after the stop message, the runner stops them in their tmux sessions (Escape, then a message) |
| 14, 16, 20 | Need a second workspace account (`second_user` in `live.json`); `SKIPPED (no second account)` without one, and `SKIPPED (second account needs a sign-in code: run login --second)` when Slack asks it for an emailed code (its mail doesn't go to the test mailbox). In Checks 16 and 20 the runner asks A for the reply-tool call at most twice: if A never answers, the check fails; if A answers twice without making the call, Check 16 is `SKIPPED (not run: …)`, as the plan says, and Check 20 fails |
| 15, 17, 19, 21 to 23 | Automated. "Turn A's DMs on" is a confirmed config edit |
| 18 | Automated. C's prompt is started by typing into C's tmux session |
| 24, with its setup and teardown | Automated |
| 25 | Automated. D is added by a `config.json` edit, not the wizard, and D's credentials file is moved from `credentials-staged/` into the mounted directory while the server runs |
| 26 | `SKIPPED (optional)` |
| 27 | Automated, with step 2's optional prompt |
| 28 | Automated; the reboot is a container restart (see below) |
| 29a | Automated. Always runs, also in a dry run and after a blocking failure; adds a host-side scan of the results. It requires a transcript only for each persona this run brought up (A to C in Check 1, D in Check 25) and sent a message to |
| 29b | `SKIPPED (optional: needs host sudo/iptables)` |
| Teardown | The container is removed. The apps and channels stay for the next run |
| HOST | The host is unchanged (see [Isolation](#isolation-from-the-production-bots)) |
| Closing secrecy scan | Every output is free of tokens and secrets (see [Secrets](#secrets)) |

### Check 28: the reboot is a container restart

The plan reboots the test host and relies on a crontab `@reboot` line to start
the server. The container has no cron, so the runner stands in for both:

- **The boot mechanism.** At the start of Check 28, the runner creates
  `~/cscb-live/.start-at-boot` in the container. The entrypoint runs at every
  container start. When the marker exists, it starts
  `claude-slack-channel-bots start` as `testuser`, with no token variable and
  no `SLACK_STATE_DIR`, and logs to `~/cscb-live/boot-start.log`. The adapted
  pre-flight doesn't require `crontab`.
- **The reboot.** `docker restart`, with a 20-second grace period. Every process
  in the container ends (the server, tmux and the bot Claudes) with no
  `stop --stop-bots` first. The container's disk survives, as a host's would:
  the state directory, the record, the pending file, the agent-director store
  and the installed package.
- **Which boot.** The entrypoint numbers every container start (boot 1 at the
  first start, one more per restart) and records `<boot> ok` when that
  start's work is done. After the restart, the runner waits for the new boot
  number, so it never mistakes the previous boot's record for this one.
- **B's pending credentials change.** In the plan's step 2, before the
  reboot, the runner generates a new app-level token for B
  (`cscb-live-rotated-<RUN_ID>`) in the browser, rewrites B's credentials file
  on the host, and records the new token's name in `apps.json` at once. The
  container sees the change through the mount. In step 7, after the reboot
  and the personas' answers, the runner revokes B's older token, by the name
  `apps.json` recorded for it before step 2. Each run so rotates from the
  token the last one left.

After the restart, the runner allows up to 10 minutes for the start summary,
then checks the plan's steps 5 to 8.

### Outputs

Each run writes to `$TMPDIR/cscb-ci-live-<RUN_ID>-XXXXXX` (`/tmp` when
`TMPDIR` is unset), outside the repo. The directory is mode 700 and its files
mode 600.

| File | Contents |
|---|---|
| `verdict.txt` | One line: `PASS`, `FAIL: <check>: <reason>` (`FAIL: memory watchdog: <reason>` when the watchdog stopped the run) or `NOT RUNNABLE: <reason>` |
| `results.json` | Every check with its status, reason, evidence, notes and duration, and the memory watchdog's report under `memory`: the sample count, the limits, the peaks and any stop reason |
| `results.md` | A per-check table with evidence, then one row in the testplan's Results-table format, ready to paste, then the watchdog's peaks under "Memory (the watchdog's peaks)" |
| `run.log` | Every progress and detail line, redacted |
| `container.log` | The container's docker logs, redacted |

Evidence is message timestamps, conversation IDs and redacted server-log
lines, never a token. The run's first line is `RESULTS_DIR=<dir>`, so an
agent that runs it detached can find `verdict.txt`; the path is printed again
at the end. The run keeps the directory, unless it passed and `--clean` was
given.

Exit codes: `0` PASS, `1` FAIL (an interrupted run included), `2` not
runnable. A not-runnable run prints one line that names the file or variable
to fix, never a value. The reasons include: another run holding the lock,
docker not running, a missing base image, no agent-director binary on the
host, missing Claude credentials, a secret file or the config directory open
to group or others, a missing `workspace_domain` or `test_email`, no password
and no saved session, a missing, refused or expired configuration token (no
refresh token, or a refused rotation) while `apps.json` doesn't record all
four apps, a rotated token pair that could not be saved, a real run with no
`apps.json` and no `--create-apps`, an `apps.json` that doesn't parse or
isn't a JSON object, an `apps.manifest.create` that got no
answer, an unfinished create with more than one candidate app, and Slack
asking the test human for an emailed sign-in code that the test mailbox did
not answer (see [The test mailbox](#the-test-mailbox)).

### Command line

| Command | Does |
|---|---|
| `bun ci-live/run.ts` | The full live run (about 2 to 3 hours; an agent runs it detached, as `.claude/skills/ci-live/SKILL.md` describes) |
| `bun ci-live/run.ts --dry-run` | The dry run |
| `bun ci-live/run.ts login` | Signs the test human in, asking on the terminal for an emailed code if Slack wants one (interactive terminal only) |
| `bun ci-live/run.ts login --second` | The same for the second account (`second_user` in `live.json`) |
| `bun ci-live/run.ts mailbox --latest\|--forwarding [--show-body]` | Shows the test mailbox's newest message, or its newest Gmail forwarding confirmation with the confirm link (see [The test mailbox](#the-test-mailbox)) |
| `bun ci-live/run.ts config-token --rotate` | Rotates the configuration token pair once (see [Maintenance commands](#maintenance-commands)) |
| `bun ci-live/run.ts apps --list` | Lists the test human's apps and which `apps.json` records |
| `bun ci-live/run.ts apps --delete-strays` | Deletes the stray test apps: named "CSCB Test A" to "D", not in `apps.json`, in the test workspace |
| `--provision-only` | Provisioning only (all stages, then validation) |
| `--stage apps\|install\|tokens\|channels` | One provisioning stage only (not with `--dry-run`) |
| `--only 5,12` | Only these checks; the pre-flight, install, setup, Check 1, 29a, Teardown and HOST still run, the rest report `SKIPPED (not selected)` |
| `--keep-container` | Leaves the container for inspection (after a memory watchdog stop, stopped with `docker stop`) |
| `--clean` | Removes the results directory when the run passes |
| `--create-apps` | Lets a real run create the four apps although no `apps.json` exists (only when the apps are really gone) |

### Reruns

- **A fresh container every run.** Nothing carries over inside it. If a run
  died after Check 25, D's credentials file is moved back to
  `credentials-staged/` at the next start.
- **Workspace state is reused.** The apps in `apps.json` are reused (re-created
  only when deleted), installs and app-level tokens are kept until Slack
  refuses them, and channel membership is re-checked. Each rerun rotates B's
  app-level token once more in Check 28, under a name with the run's ID.
- **An unfinished create is picked up.** A rerun after a run that stopped
  mid-create adopts the app that create made, or creates it when there is
  none (see [What a run does](#what-a-run-does)).
- **The plan's rerun branches.** Check 18 finds C's DM from an earlier run and
  records "rerun". Checks 14, 16 and 20 need an account new to the personas:
  after one run with a second account, they report
  `SKIPPED (not verified: … a rerun)` until `live.json` names a fresh one.

## Out of scope (future work)

Publishing `cscb-ci-base` to a registry (GHCR or similar) so fresh hosts pull
instead of build — tracked under DR-3 of b.nfg.
