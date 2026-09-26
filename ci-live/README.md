# ci-live: operator setup

This directory is the runner for `/ci-live`, the live Slack acceptance run of
`testplans/b.yko` in a throwaway docker container. What a run does, how it
keeps the production bots and the secrets safe, and what it checks are in
`docker/README.md` under "/ci-live". This page takes the operator from the
state below to a full run, then covers setting up a new VM.

Type every secret only at a hidden prompt in your own terminal. Never paste
one into a chat, an agent session, a ticket or a command line. The one
exception is `hgx`, which takes a value only as an argument (see
[A new VM](#a-new-vm)).

## Where you start

- The test workspace `cscb-ci-test`: a free Slack workspace signed up with a
  non-SSO email, never a production workspace. It has one human account, the
  test human, with email and password login and no 2FA.
- In `~/.config/cscb-test/` (mode 700; `CSCB_LIVE_CONFIG_DIR` overrides it),
  each file mode 600:
  - `slack_config_token`: the workspace's app configuration token (optional
    once `apps.json` records the four apps, as it does here: see step 1);
  - `live.json`: the workspace and the test human's email;
  - `test_password`: the test human's password;
  - `apps.json`: the IDs of the four apps "CSCB Test A" to "CSCB Test D",
    which already exist in the workspace;
  - `mailbox.json`: the test mailbox, a mail.tm account for the test human's
    forwarded mail (see [The test mailbox](#the-test-mailbox)). It was
    created on the current VM through mail.tm's API, and its address is also
    in `/tmp/cscb-test-mailbox-address.txt`.
- On the VM: docker, the `/ci` base image (if
  `docker image inspect cscb-ci-base:v3` fails, run `/ci` once), Google
  Chrome (`google-chrome --version`), bun, and agent-director
  (`agent-director version`). The live image pairs CSCB with this host's
  agent-director binary, so its version must be the one that `package.json`'s
  `agent-director` range installs from npm.

Not there yet: the refresh token (step 1), the Claude credentials if your
shell lacks them (step 2), the test human's browser session (step 4), and the
Gmail filter that forwards the test human's mail to the test mailbox, if you
have not set it up (step 4). The
first run installs the four apps, generates their app-level tokens, writes the
personas' credentials files, and creates the public channels `a-home`,
`coordination` and `d-home` (the plan's A-home and D-home: Slack channel names
are lowercase). You create no app, token or channel by hand.

See what is there (mode, size and name, never the contents), the personas'
credentials files included:

```sh
stat -c '%a %s %n' ~/.config/cscb-test ~/.config/cscb-test/* ~/.config/cscb-test/credentials*/*
```

The runner stops (exit 2) when the directory, a secret file or a persona's
credentials file is open to group or others. Its message names each such
path, its mode, and the `chmod` command(s) that fix them all (`chmod 700` for
a directory, `chmod 600` for a file): run them, then rerun. The runner never
changes a mode itself.

A VM reboot can loosen these modes: at boot the pod's `fsGroup` re-applies
its group to the files. After a reboot, check the modes with the `stat`
above before a run.

## 1. The files

Each snippet reads the value at a prompt and writes it with the shell's
built-in `printf`, so the value is never on a command line, in the history or
in a process list. `umask 077` makes each new file mode 600; a file that
already existed keeps its old mode.

The configuration token and its refresh token. A run uses the configuration
token to check the apps against `slack-app-manifest.yml` through the manifest
API, and to update a drifted app or create a missing one. Once `apps.json`
records all four apps, the token is optional: without a usable one, a run
logs a `WARNING` and reuses the recorded apps unchecked. A configuration
token lasts 12 hours. With the refresh token, the runner rotates the pair
when the token has expired and saves both files (mode 600). Write the
refresh token issued with the token in `slack_config_token` (the same
**Generate Token** click shows both). If you no longer have it, generate a
new pair at <https://api.slack.com/apps> under **Your App Configuration
Tokens**, for the workspace `cscb-ci-test`, and write both:

```sh
( umask 077; IFS= read -rs -p 'App configuration token (not shown): ' v \
  && printf '%s\n' "$v" > ~/.config/cscb-test/slack_config_token; echo )
( umask 077; IFS= read -rs -p 'Refresh token (not shown): ' v \
  && printf '%s\n' "$v" > ~/.config/cscb-test/slack_config_refresh_token; echo )
```

When a run exits 2 naming `slack_config_token`, write a fresh pair the same
way.

To check that the pair rotates, rotate it once:

```sh
bun ci-live/run.ts config-token --rotate
```

It prints
`config token: rotated with tooling.tokens.rotate; both token files rewritten (mode 600)`.
It exits 2 when there is no refresh token or Slack refuses it: write a fresh
pair. It takes the run lock (see step 6), so it doesn't run beside a run.
Each rotation replaces both tokens, so the `hgx` copies go stale (see
[A new VM](#a-new-vm)).

To replace `live.json` (the workspace and the test human's email):

```sh
( umask 077; IFS= read -r -p 'Test human email: ' e \
  && printf '{"workspace_domain": "cscb-ci-test", "test_email": "%s"}\n' "$e" > ~/.config/cscb-test/live.json )
```

To replace the test human's password:

```sh
( umask 077; IFS= read -rs -p 'Test human password (not shown): ' v \
  && printf '%s\n' "$v" > ~/.config/cscb-test/test_password; echo )
```

## 2. Claude credentials

The bot Claudes in the container need an API key. The runner takes it only
from `CI_ANTHROPIC_API_KEY`, `CI_ANTHROPIC_BASE_URL` and `CI_ANTHROPIC_MODEL`,
never from the host's own `ANTHROPIC_*`. A raw `sk-ant-` key needs only
`CI_ANTHROPIC_API_KEY`; a gateway key needs all three. Check which are set
(names only):

```sh
env | cut -d= -f1 | grep '^CI_ANTHROPIC_'
```

If they are missing, set them in the shell that will run `/ci-live`:

```sh
IFS= read -rs -p 'Claude API key (not shown): ' CI_ANTHROPIC_API_KEY && export CI_ANTHROPIC_API_KEY; echo
export CI_ANTHROPIC_BASE_URL='<GATEWAY_BASE_URL>' CI_ANTHROPIC_MODEL='<GATEWAY_MODEL>'   # gateway key only
```

## 3. Install the runner's dependency (once per checkout)

From the repo root:

```sh
(cd ci-live && bun install --ignore-scripts)
```

This installs `playwright-core` only. It drives the installed Google Chrome
and downloads no browser. Always pass `--ignore-scripts`.

## 4. Sign the test human in (once)

Run this in your own interactive terminal, from the repo root. It asks on the
terminal, which an agent's shell doesn't have:

```sh
bun ci-live/run.ts login
```

It signs the test human in to `cscb-ci-test.slack.com` with the email and
password, in headless Chrome. The first time Slack sees a new device, it
emails the test human a sign-in code, and the command asks:
`Slack emailed the test human a sign-in code. Type it (not shown):`. Type the
code from the test human's inbox (with the test mailbox below, another
terminal's `bun ci-live/run.ts mailbox --latest --show-body` shows it too). It saves the
session to
`~/.config/cscb-test/playwright-state.json` (mode 600) and prints
`login: the test human signed in; session saved to <path> (mode 600)`.

Later runs reuse that session and read the password only when Slack needs a
fresh sign-in. When Slack emails a new-device code during a run, the run reads
it from the test mailbox (below) and types it. With no mailbox, or no code
within 2 minutes, it exits 2 with "Slack asked for an emailed sign-in code":
run `login` again. `login` itself asks on the terminal and doesn't read the
mailbox. It takes the same lock as a run (see step 6): while a run is going,
it exits 2.

### The test mailbox

The test mailbox is a [mail.tm](https://mail.tm) account that receives the
test human's mail through a Gmail filter, so a run can read Slack's sign-in
code itself. `~/.config/cscb-test/mailbox.json` (mode 600) holds its
`provider`, `api`, `address`, `password`, `account_id` and `token`. The runner
rewrites the file when mail.tm wants a fresh token. Print the address
(`<MAILBOX_ADDRESS>` below; it is not a secret):

```sh
jq -r .address ~/.config/cscb-test/mailbox.json
```

The test human's email, `<TEST_EMAIL>`, is a `+cscbtest` address of your
Gmail account. In that account's Gmail settings, once:

1. Under **Forwarding and POP/IMAP**, **Add a forwarding address**:
   `<MAILBOX_ADDRESS>`. Gmail emails the mailbox a confirmation, with a link
   and no code.
2. Print its confirm link, then open the link in a browser and confirm:

   ```sh
   bun ci-live/run.ts mailbox --forwarding
   ```

   It prints `confirm link: https://mail-settings.google.com/…` on a line of
   its own, on purpose, and never the cancel link.
3. Keep **Disable forwarding** selected on that page, so only the filter
   forwards.
4. Under **Filters and Blocked Addresses**, **Create a new filter** with
   **To** `<TEST_EMAIL>`, then tick **Forward it to** `<MAILBOX_ADDRESS>` and
   **Create filter**.
5. Check it: email `<TEST_EMAIL>` from another account, then run
   `bun ci-live/run.ts mailbox --latest`. It shows the newest message's
   time, sender (as `an address at <domain>`) and subject.

With the forwarding in place, a run that meets Slack's code prompt for the
test human waits up to 2 minutes for the code in the mailbox, types it and
goes on; otherwise it exits 2 and you run `login`. `docker/README.md` under
"The test mailbox" has the run's log lines and the `mailbox` command's
output.

If the mailbox is lost (no `mailbox.json`, or `mailbox` exits 2 because
mail.tm refuses its password), remove any old `mailbox.json` and create a new
one. This creates a mail.tm account with a random address and password
through mail.tm's API and writes `mailbox.json` (mode 600), with no value on a
command line. The runner fetches the token itself:

```sh
( umask 077; set -eo pipefail; cd ~/.config/cscb-test
  [ ! -e mailbox.json ] || { echo 'mailbox.json exists: remove it first'; exit 1; }
  api=https://api.mail.tm
  domain=$(curl -fsS "$api/domains" | jq -r '(."hydra:member"? // .) | map(select(.isActive)) | .[0].domain')
  A="cscb-$(openssl rand -hex 6)@$domain"; P=$(openssl rand -hex 24); export A P
  id=$(jq -n '{address: env.A, password: env.P}' \
    | curl -fsS -H 'Content-Type: application/json' --data-binary @- "$api/accounts" | jq -r .id)
  jq -n --arg api "$api" --arg id "$id" \
    '{provider: "mail.tm", api: $api, address: env.A, password: env.P, account_id: $id}' > mailbox.json
  echo "new mailbox: $A" )
```

Then repeat the Gmail steps with the new address: add it as a forwarding
address, confirm it with `mailbox --forwarding`, and point the filter's
**Forward it to** at it.

## 5. Check the harness (optional)

```sh
bun ci-live/run.ts --dry-run
```

It reads no secret, needs no Claude credentials, takes about a minute (a few
when the image is rebuilt) and must end with `VERDICT: PASS`. It has a lock of
its own, so it can run beside a real run.

## 6. Run

From the repo root of the checkout you want to test, in a tmux session (a run
takes about 2 to 3 hours):

```sh
bun ci-live/run.ts
```

The first line is `RESULTS_DIR=<dir>`, the run's results directory. The run
packs the working tree as it is on disk (the Build column marks uncommitted
changes with `+uncommitted`), provisions the workspace, runs every check, and
removes the container. It ends with one line per check,
`VERDICT: PASS` or `VERDICT: FAIL: <check>: <reason>`, and the results
directory's path. There, `verdict.txt` holds the verdict and `results.md` the
row to paste into the testplan's Results table. Before the container goes,
the run copies, redacted, into `container-logs/`: first each persona's tmux
pane (`pane-persona_a.txt` …, `tmux capture-pane -p -J -S -200`, while its
session lives; tmux gets 5 s, and a stuck one gets no more captures), at
most its last 2 MiB; then the container's own logs: the server log (with
its rotated generations), `startup-errors.log`, `cron.log`, the permission
trail, Check 28's `boot-start.log`, and agent-director's errors log and
trail, each at most its last 20 MiB; then the last 200 lines of each
persona's newest Claude transcript (`transcript-persona_a.jsonl` …), at
most its last 2 MiB. A pane and a transcript are also redacted across the
lines Claude Code hard-wraps itself, which `-J` doesn't join: every piece
of a known secret or a token split across rows is masked, and so is every
10-character fragment of a known secret. All are whole lines only (an
unterminated last line, perhaps still being written, is left out), with
`index.txt` saying what was copied, cut or not there. They are the place to
trace a failed check
(`docker/README.md` under "Outputs"): a pane showing a permission prompt
and a transcript whose last tool call has no result mean a prompt nobody
answered; with no prompt on the pane, the call was let through and never
finished.

The first run installs the four apps and generates their app-level tokens. To
see provisioning pass on its own first, run
`bun ci-live/run.ts --provision-only`.

From Claude Code, `/ci-live` runs the dry run, then starts the full run in a
detached tmux session on a tmux server of its own (`tmux -L cscb-live`), takes
the results directory from the first line, and polls `verdict.txt` in
foreground calls of at most 9 minutes each, never with a background timer.

While a run is going:

- **One at a time.** A run, `--provision-only`, `login`,
  `config-token --rotate` and `apps` share one lock, `run.lock` in
  `~/.config/cscb-test/`. A second one exits 2 and names the PID that holds
  the lock. A lock left by a command that died (its PID not running, or
  reused after a VM reboot) is removed with a
  `WARNING: removed the stale run lock …` line, and the new command goes on.
- **Stopping it.** Ctrl-C, closing its terminal or killing its tmux session
  stops the run cleanly: it copies the personas' panes, the container's own
  logs and the personas' transcript tails into `container-logs/`, removes the test
  container, writes the results so
  far with the verdict `FAIL: runner: interrupted by <signal>`, releases the
  lock and exits 1. The Notes of the results row say what the cleanup
  actually did, such as a container it could not remove.
- **Memory.** The container is capped at 8 GiB with no swap and 2048
  processes, and the run keeps one Chrome with a page per account, idle on
  `about:blank` between flows. Every 30 s a `watchdog:` line in `run.log`
  gives the host's working set, the container's memory, Chrome's (PSS) and
  the runner's (RSS). When the host's working set passes 40 GiB or Chrome
  passes 4 GiB, the watchdog stops the run the way Ctrl-C does, closing
  Chrome at once, with the verdict
  `FAIL: memory watchdog: <what, its value and the limit>`. The peaks are at
  the end of `results.md`. `docker/README.md` under "Memory bounds" has the
  details.
- **Leave the production install alone.** The HOST check fails on any change
  to the host's CSCB (its config, its tmux sessions, its agent-director rows,
  its port 3100), including one you make.

A provisioning stage that meets a transient Slack failure (a timeout, a 5xx,
a rate limit) stops with "transient: rerun later" and replaces no working
token: rerun later. An app create that got no answer stops the run (exit 2)
too: rerun, and the run finds the app it may have made (see
[Stray and unfinished apps](#stray-and-unfinished-apps)). In a full run, a
failed stage (provisioning, the browser
session, the image build, the container start) is a FAIL row of its own, and
the run still writes its results and runs the HOST check and the closing
secrecy scan.

## Optional: a second account (Checks 14, 16 and 20)

Without a second account, Checks 14, 16 and 20 report
`SKIPPED (no second account)`. To run them:

1. Invite a second account to `cscb-ci-test` (another non-SSO email, email
   and password login, no 2FA). It must be new to the personas: no post in
   `a-home`, and no DM with a "CSCB Test" app. It plays both the plan's
   first-time user (Check 14) and its second test user (Checks 16 and 20).
2. Write its password to a file:

   ```sh
   ( umask 077; IFS= read -rs -p 'Second account password (not shown): ' v \
     && printf '%s\n' "$v" > ~/.config/cscb-test/second_password; echo )
   ```

3. Rewrite `live.json` with a `second_user` block:

   ```sh
   ( umask 077; IFS= read -r -p 'Test human email: ' e && IFS= read -r -p 'Second account email: ' e2 \
     && printf '{"workspace_domain": "cscb-ci-test", "test_email": "%s", "second_user": {"email": "%s", "password_env": "CSCB_LIVE_SECOND_PASSWORD", "password_file": "%s/.config/cscb-test/second_password"}}\n' \
       "$e" "$e2" "$HOME" > ~/.config/cscb-test/live.json )
   ```

   The runner uses the `password_env` variable when it is set, else
   `password_file`. The file path must be absolute (`~` is not expanded) and
   the file mode 600.

4. Sign it in once, in your own interactive terminal:

   ```sh
   bun ci-live/run.ts login --second
   ```

   It works like `login`, for the second account, and saves its session to
   `~/.config/cscb-test/playwright-state-second.json`.

The second account's mail doesn't go to the test mailbox. If Slack asks it
for an emailed code during a run, the run goes on and reports Checks 14, 16
and 20 as
`SKIPPED (second account needs a sign-in code: run login --second)`.

After one run, the account is no longer new to the personas. On a rerun,
Checks 14, 16 and 20 report `SKIPPED (not verified: … a rerun)` until
`live.json` names a fresh account.

## A new VM

`hgx` injects each stored secret into every VM created afterwards, as an
environment variable named after its key in upper case. Store the values once,
from the files of step 1 and the key of step 2. Run these where `hgx` is
installed and those files exist:

```sh
hgx secrets add --key cscb_live_workspace --value cscb-ci-test --type generic
hgx secrets add --key cscb_live_test_email --value "$(jq -r .test_email ~/.config/cscb-test/live.json)" --type generic
hgx secrets add --key cscb_live_test_password --value "$(< ~/.config/cscb-test/test_password)" --type generic
hgx secrets add --key cscb_live_slack_config_token --value "$(< ~/.config/cscb-test/slack_config_token)" --type generic
hgx secrets add --key cscb_live_slack_config_refresh_token --value "$(< ~/.config/cscb-test/slack_config_refresh_token)" --type generic
hgx secrets add --key cscb_live_second_password --value "$(< ~/.config/cscb-test/second_password)" --type generic   # a second account only
hgx secrets add --key ci_anthropic_api_key --value "$CI_ANTHROPIC_API_KEY" --type generic
hgx secrets add --key ci_anthropic_base_url --value "$CI_ANTHROPIC_BASE_URL" --type generic   # gateway key only
hgx secrets add --key ci_anthropic_model --value "$CI_ANTHROPIC_MODEL" --type generic         # gateway key only
```

The values come from the files and the variable, so none is typed and the
shell history keeps only the `$(< …)` text. `hgx` takes a value only as an
argument, though, so each value is in `hgx`'s process arguments while it
runs.

| hgx key | Variable on a new VM | The runner |
|---|---|---|
| `cscb_live_workspace` | `CSCB_LIVE_WORKSPACE` | reads it (overrides `live.json`'s `workspace_domain`) |
| `cscb_live_test_email` | `CSCB_LIVE_TEST_EMAIL` | reads it (overrides `live.json`'s `test_email`) |
| `cscb_live_test_password` | `CSCB_LIVE_TEST_PASSWORD` | reads it (instead of the `test_password` file) |
| `cscb_live_slack_config_token` | `CSCB_LIVE_SLACK_CONFIG_TOKEN` | doesn't read it: copy it into `slack_config_token` (below) |
| `cscb_live_slack_config_refresh_token` | `CSCB_LIVE_SLACK_CONFIG_REFRESH_TOKEN` | doesn't read it: copy it into `slack_config_refresh_token` (below) |
| `cscb_live_second_password` | `CSCB_LIVE_SECOND_PASSWORD` | reads it when `live.json`'s `second_user` names it as `password_env` |
| `ci_anthropic_api_key`, `ci_anthropic_base_url`, `ci_anthropic_model` | `CI_ANTHROPIC_API_KEY`, `CI_ANTHROPIC_BASE_URL`, `CI_ANTHROPIC_MODEL` | reads them (step 2) |

On the new VM:

1. Check that the variables arrived (names only):
   `env | cut -d= -f1 | grep -E '^(CSCB_LIVE_|CI_ANTHROPIC_)'`.
2. Copy the two token variables into their files:

   ```sh
   ( umask 077; mkdir -p ~/.config/cscb-test && chmod 700 ~/.config/cscb-test && cd ~/.config/cscb-test || exit
     [ -n "${CSCB_LIVE_SLACK_CONFIG_TOKEN:-}" ] && printenv CSCB_LIVE_SLACK_CONFIG_TOKEN > slack_config_token
     [ -n "${CSCB_LIVE_SLACK_CONFIG_REFRESH_TOKEN:-}" ] && printenv CSCB_LIVE_SLACK_CONFIG_REFRESH_TOKEN > slack_config_refresh_token )
   ```

3. Copy `~/.config/cscb-test/apps.json` from the VM that has it to the same
   path (mode 600; it holds IDs, no secret). Without it, a real run creates
   no app and stops (exit 2): the four apps already exist in the workspace,
   and creating them again would make four more with the same names. Pass
   `--create-apps` only when the apps are really gone (see
   [Retiring the test apps](#retiring-the-test-apps)). A copy that doesn't
   parse, or isn't a JSON object, stops every command that reads it (exit
   2): copy it again.
4. Copy `~/.config/cscb-test/mailbox.json` the same way, mode 600 (it holds
   the mailbox's password). The Gmail filter forwards to that mailbox
   whichever VM reads it.
5. For a second account, write `live.json` with its `second_user` block
   (step 3 of the second account's steps).
6. Go on with steps 3 to 6 above. Sign in on the new VM too (step 4, and
   `login --second` for a second account): the browser sessions stay on the
   VM that saved them.

Each rotation of the configuration token also replaces the refresh token, so
the `hgx` copies are stale after the first one. After writing a fresh pair,
replace both copies (`hgx secrets delete --key …`, then their `add` lines
above again).

## Stray and unfinished apps

A stray is an app named exactly "CSCB Test A" to "CSCB Test D" whose ID
`apps.json` doesn't record: left by a create whose answer was lost, or by an
older `apps.json`. See every app the test human has at
<https://api.slack.com/apps>:

```sh
bun ci-live/run.ts apps --list
```

It prints one line per app: its ID, its name, and `in apps.json (persona A)`,
`NOT in apps.json: a stray test app` or `not in apps.json`, with whether its
row shows the test workspace. It also names any unfinished create in
`apps.json` (below), and ends with the number of strays. To delete the
strays:

```sh
bun ci-live/run.ts apps --delete-strays
```

It deletes an app (with `apps.manifest.delete` and the configuration token)
only when all of these hold:

- its name is exactly "CSCB Test A", "CSCB Test B", "CSCB Test C" or "CSCB
  Test D";
- `apps.json`, read again just before the delete, doesn't record its ID;
- one cell of its row on the apps list, less the app's name, is exactly the
  test workspace's name;
- the configuration token exports it under that name, which proves it is the
  test workspace's.

It keeps every app `apps.json` records, every app of another name, and any
stray that fails a condition or whose delete Slack refuses, and prints each
kept stray with the reason. A stray whose export fails, gets no answer or
gives no manifest name is kept too: nothing proves it is the test
workspace's. It ends with
`apps: deleted <n> stray test app(s), kept <m>`, and exits 1 when it kept a
stray. Both commands take the run lock and read the page in headless Chrome
with the test human's session.

`apps --delete-strays` deletes nothing, and stops (exit 2) before it starts
Chrome, when `apps.json` is missing or records no app ID: every test app,
the ones another VM records included, would then look like a stray. Copy
`apps.json` from the VM that made the apps first. If `apps.json`, read again
before a delete, no longer records an app ID, it stops there (exit 2).

An unfinished create: before each app create, a run records the intent
(`pending_create`, with the time) in the persona's `apps.json` entry, and
replaces it with the app ID the moment Slack returns it. If a run stops
between the two, or the create got no answer, the next run looks on the
apps list for an app of that exact name that `apps.json` doesn't record and
that the configuration token exports under that name:

| Candidates | The run |
|---|---|
| One | Adopts it: records its ID in `apps.json` and checks it like any recorded app |
| None | Creates the app: the create made none |
| More than one | Stops (exit 2), naming their IDs. Run `apps --delete-strays`, then rerun: it creates the app anew |

An unrecorded app of that name whose export proves nothing (a Slack error
other than "no such app", no answer, no manifest name) may be the one the
create made. Such an app, or an apps list the run can't read, stops
provisioning: `apps.json` keeps the intent and nothing is created. Rerun.

## Retiring the test apps

Runs leave the four apps and the three channels in place for the next run. To
retire them, delete each app (its **Basic Information** page, **Delete App**)
and archive the channels. Then remove `~/.config/cscb-test/apps.json`,
`~/.config/cscb-test/credentials/` and
`~/.config/cscb-test/credentials-staged/`. The next run creates everything
again when given `--create-apps` (`bun ci-live/run.ts --create-apps`).
