---
name: ci-live
description: Run the testplans/b.yko live Slack acceptance checks against the test workspace in a throwaway docker container. Returns PASS or FAIL per check.
user-invocable: true
allowed-tools: [Bash]
---

# /ci-live

The live, pre-deploy acceptance run of CSCB: every `testplans/b.yko` check that can
be automated, against the **test workspace** only (never a production workspace),
in a fresh container built from the `/ci` base (`cscb-ci-base:v3`), with the
package under test installed the way a customer installs it. The production
bots on this host are never touched: the container has its own HOME, config,
tmux, agent-director store and port, runs on the default docker network (no
`--network=host`, no published port), and never mounts the host's `~/.claude`.

## Never

- Never start, stop or restart the host's CSCB, its `slack_bot_*` / `cscb_*`
  tmux sessions or its agent-director rows, never touch host port 3100, never
  POST to the host's `/interject`. The runner does all of that only inside the
  test container (`docker exec`).
- Never print, paste, `cat` or pass on a command line a token, the
  configuration token or the test human's password. Check secret files by
  mode and size only (`stat -c '%a %s'`).
- Never export `ANTHROPIC_*` for this. The container's Claude credentials come
  from `CI_ANTHROPIC_API_KEY`, `CI_ANTHROPIC_BASE_URL`, `CI_ANTHROPIC_MODEL`.
- Never `bun install` in `ci-live/` without `--ignore-scripts`.
- Never run `bun ci-live/run.ts apps --delete-strays` or
  `bun ci-live/run.ts config-token --rotate` unless the operator asks: the
  first deletes apps in the test workspace, the second spends the refresh
  token (and leaves the `hgx` copies stale). `apps --list` only reads.

## Prerequisites (operator, once)

Step-by-step setup (the files, the Claude credentials, the one-time `login`,
the `hgx` secrets for a new VM) is in `ci-live/README.md`; what a run does
and what it checks is in `docker/README.md` under "/ci-live".

All under `~/.config/cscb-test/` (dir mode 700, files mode 600;
`CSCB_LIVE_CONFIG_DIR` overrides the dir). The run refuses (exit 2) when a
secret file, a persona's credentials file or the dir is group- or
other-accessible: the message names each loose path, its mode, and the
`chmod` command(s) that fix them all (`chmod 600` for a file, `chmod 700` for
a directory). A VM reboot can loosen
these modes (the pod's `fsGroup` re-applies its group at boot), so after a
reboot check them by mode only:
`stat -c '%a %n' ~/.config/cscb-test ~/.config/cscb-test/* ~/.config/cscb-test/credentials*/*`.

| File | What | Written by |
|---|---|---|
| `live.json` | `{"workspace_domain": "<domain>", "test_email": "<TEST_EMAIL>"}`, optional `second_user` (`email`, `password_file` or `password_env`) for Checks 14, 16, 20. Env overrides: `CSCB_LIVE_WORKSPACE`, `CSCB_LIVE_TEST_EMAIL` | operator |
| `slack_config_token` (+ optional `slack_config_refresh_token`) | the workspace's app configuration token (manifest API only). Optional once `apps.json` records all four apps: without a usable one the run logs a `WARNING` and reuses the recorded apps unchecked (no drift check or update); still needed to create an app, resolve an unfinished create or delete strays. Rotated with the refresh token when expired, both files saved mode 600 before the new token is used; `bun ci-live/run.ts config-token --rotate` rotates once on demand | operator; the runner rewrites both after a rotation |
| `test_password` (or env `CSCB_LIVE_TEST_PASSWORD`) | the test human's password (email + password login, no 2FA) | operator |
| `playwright-state.json`, `playwright-state-second.json` | the test human's and the second account's browser sessions | the runner / `login`, `login --second` |
| `apps.json` | app, bot, team, channel and user IDs and app-level token names (no secret). A real run without it creates no app and exits 2, unless given `--create-apps`. One that doesn't parse or isn't a JSON object stops every command that reads it (exit 2); it is never read as empty. A persona entry holding only `pending_create` is an unfinished create: the next run adopts the one matching app on the apps list, creates it when there is none, and exits 2 naming them when there are several. An unrecorded app of that name it can't check, or an apps list it can't read, stops provisioning with the intent kept and nothing created: rerun | the runner |
| `credentials/`, `credentials-staged/` | the personas' credentials files (A–C mounted read-only into the container; D staged until Check 25) | the runner |
| `run.lock` | the PID of the real-mode command (a run, `--provision-only`, `login`, `config-token` or `apps`) in progress. A stale one (its PID not running, or not a runner) is removed with a `WARNING: removed the stale run lock …` line | the runner |
| `mailbox.json` (optional) | the mail.tm test mailbox (`provider`, `api`, `address`, `password`, `account_id`, `token`) that receives the test human's forwarded mail; the run reads Slack's emailed sign-in code from it (up to 2 min). `bun ci-live/run.ts mailbox --latest\|--forwarding [--show-body]` shows its newest message or Gmail's forwarding confirm link, and takes no lock | operator; the runner rewrites the token |

Install the runner's own dependency once (Playwright core; it drives the
installed Google Chrome, headless; no browser download):

```bash
(cd ci-live && bun install --ignore-scripts)
```

## Procedure

1. Check docker (`docker info`) and the `/ci` base image (`docker image inspect
   cscb-ci-base:v3`; if missing, run `/ci` once).
2. Gate first: `bun ci-live/run.ts --dry-run`. It reads no secret: a local stub
   stands in for Slack and fixture pages for the sign-in, install and token
   pages. It builds the live image (with the host's agent-director binary; a
   version mismatch with the npm package fails the build, and the reason
   names the fix), runs the pre-flight, the install, the setup, S2, S3 and
   29a in a real container, then Teardown, the HOST check, and a secrecy
   scan of every output. Must print `VERDICT: PASS`. It takes about a minute
   (a few when the image is rebuilt), so run it in the foreground (one Bash
   call, timeout 600000). It has its own lock, so it can run beside a real
   run.
3. The live run: `bun ci-live/run.ts` (about 2–3 hours: most checks wait for
   bot Claudes to answer). It provisions idempotently (the four apps "CSCB
   Test A"–"D" from `slack-app-manifest.yml`, installs, app-level tokens, the
   channels `a-home`, `coordination`, `d-home`), then runs every check in the
   plan's order in a fresh container, then removes it. The run is
   memory-bounded: the container gets `--memory 8g`, `--memory-swap 8g` and
   `--pids-limit 2048` (the `docker run` guard refuses a run without them),
   Chrome is one browser with one context and one page per account, idle on
   `about:blank` between flows, and a watchdog writes a `watchdog:` line to
   `run.log` every 30 s. It stops the run when the host's working set passes
   40 GiB or Chrome's process tree PSS passes 4 GiB.
   - `--provision-only [--stage apps|install|tokens|channels]`: provisioning only.
   - `--only 1,2,5`: run only these checks. The pre-flight, install, setup and
     Check 1 always run, as later checks need their state, and so do 29a,
     Teardown and HOST; every other check reports `SKIPPED (not selected)`.
   - `--create-apps`: let a real run create the four apps when there is no
     `apps.json` (only when the apps are really gone from the workspace).
   - `--keep-container`: leave the container for inspection (remove it with
     `docker rm -f cscb-live-<RUN_ID>-<PID>`). A memory watchdog stop still
     stops it (`docker stop`, freeing its memory) and keeps it.
   - `--clean`: remove the results dir on PASS.

   A Bash call ends after 10 minutes, so never run a real run in the
   foreground, and never wait for it with a background timer or a background
   process: you would go idle with nothing to wake you. Start it in a
   detached tmux session on its own tmux server (`-L cscb-live`, so nothing
   touches the tmux server that holds the production `slack_bot_*` sessions;
   never name a session `slack_bot_*` or `cscb_*`), with its output tee'd to
   a log. Shell variables don't survive from one Bash call to the next: note
   the session name, the log path and the results dir these commands print,
   and write them literally into the later calls.

   ```bash
   ID=$(date +%s); LOG="/tmp/cscb-live-run-$ID.log"
   tmux -L cscb-live new-session -d -s "cscb-live-run-$ID" \
     "cd '$PWD' && bun ci-live/run.ts 2>&1 | tee '$LOG'"
   echo "session cscb-live-run-$ID, log $LOG"
   ```

   Take the results dir from the runner's first line, `RESULTS_DIR=<dir>`
   (wait for it with a bounded loop; it appears within seconds):

   ```bash
   timeout 60 bash -c 'until grep -q "^RESULTS_DIR=" "$0" 2>/dev/null; do sleep 2; done' "$LOG"
   RESULTS_DIR=$(sed -n 's/^RESULTS_DIR=//p' "$LOG" | head -n 1); echo "$RESULTS_DIR"
   ```

   Then poll `verdict.txt` with bounded foreground loops, each one Bash call
   of at most 9 minutes (timeout 600000). Repeat the call until the verdict
   is there; between calls, report progress from the log's last lines
   (`tail -n 5 "$LOG"`) and, for memory, the last watchdog sample
   (`grep 'watchdog: host' "$RESULTS_DIR/run.log" | tail -n 1`):

   ```bash
   timeout 540 bash -c 'until [ -s "$0/verdict.txt" ]; do sleep 20; done' "$RESULTS_DIR"; \
     echo "exit=$? (124: not yet; poll again)"; \
     tmux -L cscb-live has-session -t "cscb-live-run-$ID" 2>/dev/null && echo "run: still going" || echo "run: ended"
   ```

   If the session has ended and `verdict.txt` is still missing, report the
   last lines of `$LOG` as the failure. To stop a run early, kill its session
   (`tmux -L cscb-live kill-session -t cscb-live-run-$ID`): the runner
   handles the hang-up (and SIGINT and SIGTERM) like an interrupt, removes
   the test container, writes the results so far with
   `FAIL: runner: interrupted by SIGHUP` and exits 1 (`$LOG` stops there;
   `$RESULTS_DIR/run.log` has every line). Only one real-mode
   command (a run, `--provision-only`, `login`, `config-token` or `apps`) and
   one dry run can run at a time: a second one exits 2 naming the PID that
   holds the lock. A stale lock is removed with a `WARNING` and the run goes
   on.
4. If it exits 2, relay the reason, which names the fix:
   - "Slack asked for an emailed sign-in code" (no test mailbox, or no code
     reached it within 2 minutes): the operator runs
     `bun ci-live/run.ts login` once in an interactive terminal (it asks for
     the code without echoing it and saves the session), then reruns.
   - Secret paths "group- or other-accessible" (typically after a VM
     reboot): relay the message. It names each loose path, its mode, and the
     `chmod` command(s) that fix them all.
   - `apps.json` "does not parse as JSON" or "is not a JSON object": relay
     it. The operator fixes the file or copies it again from the VM that
     made the apps; the runner never reads it as empty.
   - An unfinished create with several unrecorded apps of one name: run
     `bun ci-live/run.ts apps --list` (foreground, read-only) and relay what
     it shows. The operator decides on `apps --delete-strays`; rerun after.
   - `apps.manifest.create … got no answer`: rerun; the next run finds the
     app that create may have made.
5. Read the first line of `<RESULTS_DIR>/verdict.txt`:
   - `PASS` → exit 0, report `✓ Live acceptance passed.` and the results dir.
   - `FAIL: <check>: <reason>` → relay it verbatim with the results dir path.
   - `FAIL: memory watchdog: <reason>` → the watchdog stopped the run: it
     closed Chrome at once and removed the container (with
     `--keep-container`, stopped it with `docker stop` and kept it). Relay it
     verbatim with the peaks from `results.md`'s "Memory (the watchdog's
     peaks)" section and the results row's Notes, which say what the cleanup
     actually did.
   - `NOT RUNNABLE: …` → relay the reason (it names the file or variable to fix).

## Maintenance commands

Each takes the real run lock (never while a run is going), runs in the
foreground (one Bash call; a sign-in may wait up to 2 minutes for an emailed
code), and prints its own lines only, with no results dir:

| Command | Does |
|---|---|
| `bun ci-live/run.ts apps --list` | Lists every app the test human sees at api.slack.com/apps: ID, name, and whether `apps.json` records it (`NOT in apps.json: a stray test app` for an unrecorded "CSCB Test A"–"D"). Read-only |
| `bun ci-live/run.ts apps --delete-strays` | Deletes (`apps.manifest.delete`) only the apps named exactly "CSCB Test A"–"D" that `apps.json` doesn't record (read again before each delete), one of whose row cells on the apps list is exactly the test workspace's name, and that the configuration token exports under that name. Keeps every recorded app, every other app, and every stray it can't verify (an export error, no answer, no manifest name), naming each kept stray with the reason. Exit 1 when it kept one. Exit 2, before Chrome starts, when `apps.json` is missing or records no app ID. Operator's request only |
| `bun ci-live/run.ts config-token --rotate` | Rotates the configuration token pair once and prints `config token: rotated with tooling.tokens.rotate; both token files rewritten (mode 600)`. Operator's request only |

## Output

`RESULTS_DIR` (`$TMPDIR/cscb-ci-live-<RUN_ID>-XXXXXX`, outside the repo):
`verdict.txt`, `results.json`, `results.md` (per-check status, reason and
evidence — message timestamps, conversation IDs and redacted log lines, never
a token — plus one row in the testplan's Results-table format, ready to
paste, and the memory watchdog's peaks; `results.json` has them under
`memory`), `run.log` (redacted, with the `watchdog:` samples),
`container.log`, and `container-logs/`: copied before the container is
removed or stopped on every run (a signal, a memory watchdog stop and
`--keep-container` included), each redacted, whole lines only (an
unterminated last line left out): first, for each persona A–D with a tmux
session, `pane-persona_<x>.txt` (`tmux capture-pane -p -J -S -200`, at most
its last 2 MiB); then the container's own logs, each at most its last
20 MiB: CSCB's `server.log` (with `server.log.1` …), `startup-errors.log`,
`cron.log` and `permission-trail.jsonl`, Check 28's `boot-start.log`,
agent-director's `agent-director-errors.log` and
`agent-director-ad-trail.jsonl`; then for each persona
`transcript-persona_<x>.jsonl` (the last 200 lines of its newest Claude
transcript, at most its last 2 MiB); and `index.txt`, which says which were
copied, cut, not there, skipped or not copied (a pane tmux didn't capture
within 5 s included). A pane and a transcript are also masked across
Claude Code's own hard wraps (every piece of a split secret or token, every
10-character fragment of a secret), at the price of some over-masking. To
trace a failed check, read them there (`grep`, never `cat` a whole file into
the chat). A permission prompt on a persona's pane, with no tool result after
the last tool call in its transcript, is a prompt nobody answered; with no
prompt on the pane, the call was let through and never finished. Kept on FAIL; on PASS kept unless `--clean`.

Exit codes: 0 PASS, 1 FAIL, 2 not runnable.

## What stays manual

S1 (the wizard chat), 26 and 29b (optional) are reported `SKIPPED`; 14, 16 and
20 are `SKIPPED (no second account)` unless `live.json` configures
`second_user`. Part 1.5 and Check 25 are done by the runner with config edits
instead of the wizard (noted in the results). The run leaves the apps and
channels in place for the next run.
