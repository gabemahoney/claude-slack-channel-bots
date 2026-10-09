# Registry install switchover runbook

Operator runbook for switching this dev box from a `file:` global install (a
symlink farm pointing back into the working tree) to a real registry install
of `claude-slack-channel-bots`, the way a customer runs it.

This is a **dogfooding** runbook for this box. It is owner-only: the steps
publish to npm, mutate the global install, and rely on an authorized reboot to
take effect. Do not run it as part of ordinary worker/orchestrator flows. See
the constraints at the end.

Audience: the repo owner. Everything here is run by hand, in order, and each
phase is verifiable before the next.

**Scope.** This runbook applies only between CSCB releases on the same
agent-director. It does not apply to the release that requires agent-director
Phase 1, or to any later move from a CSCB that ran before Phase 1: that
switch-over stops the fleet and changes both binaries together, and its
rollback restores agent-director too. For those, the README sections
[Switching over to agent-director Phase 1](../README.md#switching-over-to-agent-director-phase-1)
and [Rolling back the switch-over](../README.md#rolling-back-the-switch-over)
govern, not this runbook.

---

## Why

The global install here is a `file:` dependency:

```json
"claude-slack-channel-bots": "file:/home/horde/projects/claude-slack-channel-bots-project/claude-slack-channel-bots-main"
```

Every file under the installed package's `src/` is a symlink back into the
working tree, so "installed" and "the editor buffer" are the same bytes.
Worse, the symlink farm was materialized before the cron feature landed, so the
5 cron files (`cron-bootstrap.ts`, `cron-dispatch.ts`, `cron-log.ts`,
`cron-scheduler.ts`, `crontable.ts`) and four other newer runtime files are
absent from the installed tree on disk. Published npm `0.8.2` (`latest`) has no
cron code at all. A customer running `bun install -g claude-slack-channel-bots`
today gets a build with no cron.

The fix is to publish a real release and reinstall this box from the registry,
so it matches what customers run.

---

## Phase 1 — Publish

Publishing is owned by the `/publish` skill, backed by `scripts/publish-prepare.sh`
and `scripts/publish-promote.sh`. **Do not run raw `npm publish` or `bun pm pack`
by hand** — the scripts are the only authorized release path and they enforce
every SR-X.Y release gate (clean tree, tests, typecheck, npm auth, next-version
availability, finished-work audit, and the `/ci` Docker suite).

Release notes live in `CHANGELOG.md` at the repo root, under an "Unreleased"
heading until the release is cut. `/publish` does not read that file: the
release commit and the annotated `v<version>` tag `/publish prepare` creates
both stay `Release v<version>`. Once the release is published, rename its
"Unreleased" heading to the version and publish date by hand, as in
`## 0.11.0 (2026-10-06)`. `CHANGELOG.md` is not in `package.json`'s `files`,
so the npm tarball does not carry it.

> **Version note.** `/publish prepare` does **not** publish the in-tree
> `package.json` version as it stands — it runs `npm version <kind>` against it,
> so the released version is one bump above it. The owner picks the bump kind
> (`patch`, `minor` or `major`); `CHANGELOG.md`'s "Unreleased" notes say whether
> the release is breaking. Every phase below uses whatever version prepare
> reports (shown as `<version>` in the commands and expected outputs).

Run the two-step path so you get a checkpoint between "ready" and "published":

```
/publish prepare <kind>
/publish promote
```

Or the one-shot alias:

```
/publish <kind>
```

`/publish prepare` bumps, packs, smoke-tests the tarball, and commits + tags
locally — nothing reaches origin or npm, so it is free to rerun. `/publish
promote` pushes the commit, runs `npm publish`, pushes the tag, polls the
registry until `<version>` is visible, then sanitizes the global manifest and
reinstalls (see Phase 2 — promote already does the registry reinstall for you).

On any non-zero exit, the scripts print an `SR-X.Y` diagnostic with an
`Operator recovery:` block. Follow that block verbatim; do not work around it.

---

## Phase 2 — Remove the `file:` install and install from the registry

`/publish promote` already performs this switchover as its final steps
(sanitize globals → remove any pre-existing install → `bun install -g
claude-slack-channel-bots@<version>` → verify). Prefer letting promote do it.

The manual equivalent is documented here so you understand what promote does and
can reproduce it if promote's post-publish install step (SR-7.3) fails and tells
you to reinstall by hand.

> **Which global prefix.** The canonical bun global prefix is
> `${BUN_INSTALL:-$HOME/.bun}/install/global` — with `BUN_INSTALL` unset that is
> `~/.bun/install/global`, and every path below uses it. A prefix somewhere else
> (this box once carried a `~/.cache/.bun` farm from an install run with
> `BUN_INSTALL` pointed there) is a **stale shadowing install**: it can still win
> `command -v` via a shim such as `~/.local/bin/claude-slack-channel-bots`, which
> makes a perfectly good new install look broken. `/publish promote` detects that
> at SR-7.0 / SR-7.4 and prints the remediation; remove the stale
> `<prefix>/install/global` tree and repoint the shim with `ln -sfn`. Never
> delete the shim outright (`~/.bun/bin` is often not on the interactive PATH),
> and never touch any `install/cache` directory — that is bun's shared package
> download cache for the whole box.

1. **Sanitize + drop the `file:` entry from the global manifest.** The global
   manifest at `~/.bun/install/global/package.json` pins the
   `file:` path and lists `claude-slack-channel-bots` in `trustedDependencies`.
   `scripts/sanitize-global.sh` removes the stale `claude-slack-channel-bots`
   dependency entry (and any bun-1.3.13 empty-string poison key):

   ```sh
   bash scripts/sanitize-global.sh
   ```

2. **Install from the registry:**

   ```sh
   bun install -g claude-slack-channel-bots@<version>
   ```

3. **Trust the package so postinstall runs.** Bun blocks lifecycle scripts of
   untrusted packages, so the postinstall config scaffolding does not run until
   the package is trusted. A **fresh** global prefix has no `trustedDependencies`
   entry at all, so this step is required there; a prefix that has carried the
   package before usually already lists it.

   Snapshot the two files the postinstall scaffolds **before** trusting, so you
   can prove afterwards whether it created them and whether it left existing ones
   untouched:

   ```sh
   stat -c '%n %s %Y' ~/.claude/channels/slack/config.json \
                      ~/.claude/slack-mcp.json 2>&1 | tee /tmp/cscb-postinstall-before
   sha256sum ~/.claude/channels/slack/config.json \
             ~/.claude/slack-mcp.json 2>&1 | tee -a /tmp/cscb-postinstall-before
   ```

   Then trust:

   ```sh
   bun pm -g untrusted        # confirm claude-slack-channel-bots is listed
   bun pm -g trust claude-slack-channel-bots
   ```

   The `-g` flag targets the global install; run from an arbitrary directory the
   non-`-g` form errors with `No package.json was found`. `bun pm -g trust` adds
   the package to `trustedDependencies` in the global manifest and runs the
   blocked postinstall, which scaffolds `~/.claude/channels/slack/config.json`
   and `~/.claude/slack-mcp.json` and links the `debug-slack-channel-bots`
   skill into `~/.claude/skills/`. Without this step, a later `start` fails
   with the cryptic `missing prerequisite: config.json`.

   Re-run the same two commands into a second file and diff:

   ```sh
   stat -c '%n %s %Y' ~/.claude/channels/slack/config.json \
                      ~/.claude/slack-mcp.json 2>&1 | tee /tmp/cscb-postinstall-after
   sha256sum ~/.claude/channels/slack/config.json \
             ~/.claude/slack-mcp.json 2>&1 | tee -a /tmp/cscb-postinstall-after
   diff /tmp/cscb-postinstall-before /tmp/cscb-postinstall-after
   ```

   How to read the result:

   | Before → after | Meaning |
   |---|---|
   | File absent → present | The postinstall ran and scaffolded it. Expected on a fresh prefix. |
   | Hash and mtime unchanged | The postinstall ran and correctly left existing config alone — this is the idempotency proof. |
   | Hash or mtime changed | The postinstall **overwrote** live config. Stop and investigate before `start`. |
   | Still absent afterwards | The postinstall did not run (trust did not take). Re-run the trust command; a later `start` will fail with `missing prerequisite: config.json`. |

   Do not try to judge any of this from the command's output. `bun pm -g trust`
   **swallows the postinstall's stdout** — it prints only a `✓ [postinstall]`
   summary line, so the script's own `skipped:` / `created:` lines are never
   visible. The files on disk are the only observable evidence.

   `/publish promote` performs this same trust-and-verify automatically at
   SR-7.4b, warning (non-fatally) if either of the two files is still missing
   after the install.

---

## Phase 3 — Verify the installed tree is real

Run all three checks. The install is only "real" if every one passes.

1. **No symlinks pointing into the repo.** The installed package's `src/` must
   be real files, not symlinks back into the working tree:

   ```sh
   find ~/.bun/install/global/node_modules/claude-slack-channel-bots -type l
   ```

   Expected output: **nothing**. Any line printed is a symlink — the install is
   still a symlink farm, not a registry copy. (You can further confirm none
   resolve into `/home/horde/projects/...` with
   `find ... -type l -lname '*claude-slack-channel-bots-project*'`.)

2. **Installed version matches the published version.** The binary has no
   `--version` flag, so read the version from the installed package's
   `package.json`:

   ```sh
   grep '"version"' ~/.bun/install/global/node_modules/claude-slack-channel-bots/package.json
   ```

   Expected: the `<version>` that `/publish prepare` reported. Then confirm the
   binary on PATH is *that* install and not another copy shadowing it — follow
   the symlinks all the way down, because a shim can point anywhere:

   ```sh
   command -v claude-slack-channel-bots
   readlink -f "$(command -v claude-slack-channel-bots)"
   ```

   Expected: the resolved path is under `~/.bun/install/global/`. Anything else
   (another bun prefix, or a path inside the repo checkout) means a stale install
   is winning on PATH — see the global-prefix note in Phase 2. This is the same
   check `/publish promote` makes at SR-7.4, where a mismatch is exit 72.

3. **Cron files are present on disk** (the whole point of the release):

   ```sh
   ls ~/.bun/install/global/node_modules/claude-slack-channel-bots/src/ \
     | grep -E 'cron-bootstrap|cron-dispatch|cron-log|cron-scheduler|crontable'
   ```

   Expected: all five filenames listed as real files.

---

## Autostart / when the switchover takes effect

The box's autostart script `~/startup/start-all.sh` (`start_cscb`) now boots
CSCB via the **installed binary** (`env -u _CLI_DAEMON_CHILD
claude-slack-channel-bots start`, resolved from PATH) instead of `bun
src/cli.ts start` from the repo — customer-shaped boot.

- The launch is **idempotent**, using an **identity-first** guard. The primary
  "already running" signal is `pgrep -f 'cli\.ts start'` on the daemon child's
  argv — the daemon always execs `bun <…>/src/cli.ts start` regardless of launch
  path, and that `cli.ts start` substring matches neither launcher shell (not the
  old `bun src/cli.ts start` nor the new `claude-slack-channel-bots start`), so
  there is no self-match false positive. This is reboot-proof: the pidfile can
  survive a reboot while PIDs reset and get reused, so a bare `kill -0` on the
  pidfile PID could falsely match an unrelated reused-PID process.
- The pidfile (`~/.claude/channels/slack/server.pid`) is additive, not primary.
  When a daemon is live, the pidfile PID is trusted only after
  `ps -p <pid> -o args=` confirms that PID's argv is that daemon; otherwise the
  stale pidfile is removed with a logged warning so a later `stop` can't act on a
  wrong PID. When no daemon is live, any residual pidfile is removed before
  launch.
- Slack tokens do not come from the wrapper. `start` reads no token, and the
  server reads each persona's tokens only from the credentials file its
  `config.json` entry names. Any token export `start_cscb` still makes from
  `~/xoxb` / `~/xapp` is ignored and can be dropped. Reference those files by
  name only — never echo their contents.
- `config.json` must be in the persona format. A pre-persona file (top-level
  `routes`, `default_route` or `default_dm_session`) is rejected: the server
  stops with the conversion error, and `start` exits 1 after repeating that
  error from `server.log`.

**This change takes effect only on the next reboot or an authorized restart.**
The running CSCB daemon (launched earlier by absolute path from the tree) keeps
running with zero open FDs under the global install dir, so replacing the global
install does not disturb the live fleet. **Do not restart CSCB now** — this box
is shared server infra; boot-time changes wait for an authorized operator's
reboot.

---

## Rollback (mandatory)

If the registry install is broken — cron files missing, version wrong, binary
does not resolve, or `start` fails — return to the `file:` install. This
restores the exact pre-switchover state and is safe to run at any time (it does
not touch the running daemon).

1. **Sanitize, then reinstall the `file:` build:**

   ```sh
   bash scripts/sanitize-global.sh
   bun install -g file:/home/horde/projects/claude-slack-channel-bots-project/claude-slack-channel-bots-main
   ```

2. **Restore trust** so the `file:` postinstall runs (the global manifest must
   list the package in `trustedDependencies`):

   ```sh
   bun pm -g untrusted        # if claude-slack-channel-bots is listed:
   bun pm -g trust claude-slack-channel-bots
   ```

   (The `-g` flag targets the global install; the non-`-g` form errors with
   `No package.json was found` when run from an arbitrary directory.)

   The `file:` postinstall runs in the checkout itself, so it scaffolds only
   missing config files and leaves `~/.claude/skills/` alone (b.669): the
   `debug-slack-channel-bots` link keeps pointing into
   `~/.bun/install/global/node_modules/claude-slack-channel-bots/`, where the
   registry install linked it. Under the `file:` install that global package
   resolves into the checkout, so the link reads the checkout's copy of the
   skill until the registry install is back; delete or move the checkout in
   the meantime and the skill breaks along with the binary.

   You can confirm the global manifest is back to the `file:` shape by checking
   that `~/.bun/install/global/package.json` pins
   `"claude-slack-channel-bots": "file:/home/horde/projects/claude-slack-channel-bots-project/claude-slack-channel-bots-main"`
   and still carries `"trustedDependencies": ["claude-slack-channel-bots"]`.

3. **Re-verify the binary resolves** back to the `file:` build:

   ```sh
   command -v claude-slack-channel-bots
   find ~/.bun/install/global/node_modules/claude-slack-channel-bots/src -type l | head
   ```

   Under the `file:` install the second command prints symlinks (that is the
   expected `file:` shape — the opposite of the Phase 3 registry check).

The `file:` build is the last-known-good state for this box; roll back to it
whenever the registry install cannot be verified, then diagnose the release
separately.

---

## Constraints

- Owner-only. Never run this as a worker/orchestrator task.
- Never restart, stop, or `clean_restart` the CSCB fleet as part of this
  runbook — the autostart change takes effect on the next authorized reboot.
- Never echo the contents of `~/xoxb` / `~/xapp`; reference them by name only.
- Publishing goes through `/publish` only — no raw `npm publish`.
