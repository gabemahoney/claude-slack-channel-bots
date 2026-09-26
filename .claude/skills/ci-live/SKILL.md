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

## Prerequisites (operator, once)

Step-by-step setup (the files, the Claude credentials, the one-time `login`,
the `hgx` secrets for a new VM) is in `ci-live/README.md`; what a run does
and what it checks is in `docker/README.md` under "/ci-live".

All under `~/.config/cscb-test/` (dir mode 700, files mode 600;
`CSCB_LIVE_CONFIG_DIR` overrides the dir). The run refuses (exit 2) when a
secret file or the dir is group- or other-accessible.

| File | What | Written by |
|---|---|---|
| `live.json` | `{"workspace_domain": "<domain>", "test_email": "<TEST_EMAIL>"}`, optional `second_user` (`email`, `password_file` or `password_env`) for Checks 14, 16, 20. Env overrides: `CSCB_LIVE_WORKSPACE`, `CSCB_LIVE_TEST_EMAIL` | operator |
| `slack_config_token` (+ optional `slack_config_refresh_token`) | the workspace's app configuration token (manifest API only); rotated with the refresh token when expired | operator |
| `test_password` (or env `CSCB_LIVE_TEST_PASSWORD`) | the test human's password (email + password login, no 2FA) | operator |
| `playwright-state.json`, `playwright-state-second.json` | the test human's and the second account's browser sessions | the runner / `login`, `login --second` |
| `apps.json` | app, bot, team, channel and user IDs and app-level token names (no secret). A real run without it creates no app and exits 2, unless given `--create-apps` | the runner |
| `credentials/`, `credentials-staged/` | the personas' credentials files (A–C mounted read-only into the container; D staged until Check 25) | the runner |
| `run.lock` | the PID of the real-mode command (a run, `--provision-only` or `login`) in progress | the runner |
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
   plan's order in a fresh container, then removes it.
   - `--provision-only [--stage apps|install|tokens|channels]`: provisioning only.
   - `--only 1,2,5`: run only these checks. The pre-flight, install, setup and
     Check 1 always run, as later checks need their state, and so do 29a,
     Teardown and HOST; every other check reports `SKIPPED (not selected)`.
   - `--create-apps`: let a real run create the four apps when there is no
     `apps.json` (only when the apps are really gone from the workspace).
   - `--keep-container`: leave the container for inspection (remove it with
     `docker rm -f cscb-live-<RUN_ID>-<PID>`).
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
   (`tail -n 5 "$LOG"`):

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
   command (a run, `--provision-only` or `login`) and one dry run can run at
   a time: a second one exits 2 naming the PID that holds the lock.
4. If it exits 2 with "Slack asked for an emailed sign-in code" (no test
   mailbox, or no code reached it within 2 minutes), the operator
   runs `bun ci-live/run.ts login` once in an interactive terminal (it asks
   for the code without echoing it and saves the session), then reruns.
5. Read the first line of `<RESULTS_DIR>/verdict.txt`:
   - `PASS` → exit 0, report `✓ Live acceptance passed.` and the results dir.
   - `FAIL: <check>: <reason>` → relay it verbatim with the results dir path.
   - `NOT RUNNABLE: …` → relay the reason (it names the file or variable to fix).

## Output

`RESULTS_DIR` (`$TMPDIR/cscb-ci-live-<RUN_ID>-XXXXXX`, outside the repo):
`verdict.txt`, `results.json`, `results.md` (per-check status, reason and
evidence — message timestamps, conversation IDs and redacted log lines, never
a token — plus one row in the testplan's Results-table format, ready to
paste), `run.log` (redacted) and `container.log`. Kept on FAIL; on PASS kept
unless `--clean`.

Exit codes: 0 PASS, 1 FAIL, 2 not runnable.

## What stays manual

S1 (the wizard chat), 26 and 29b (optional) are reported `SKIPPED`; 14, 16 and
20 are `SKIPPED (no second account)` unless `live.json` configures
`second_user`. Part 1.5 and Check 25 are done by the runner with config edits
instead of the wizard (noted in the results). The run leaves the apps and
channels in place for the next run.
