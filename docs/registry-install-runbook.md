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

There is no changelog file in this repo; the release-notes surface is the
`Release v<version>` commit plus the annotated `v<version>` tag that `/publish
prepare` creates.

> **Version note.** This branch bumps the in-tree `package.json` to `0.9.0` as
> this ticket's release prep (cron is a new backward-compatible feature → at
> least a minor). `/publish prepare` does **not** publish that `0.9.0` — it runs
> `npm version <kind>` against the current `0.9.0`, so `prepare patch` releases
> `0.9.1` and `prepare minor` releases `0.10.0`. The owner picks the bump;
> skipping `0.9.0` on the registry is harmless. Every phase below uses whatever
> version prepare reports (shown as `<version>` in the commands and expected
> outputs) — not a hardcoded `0.9.0`.

Run the two-step path so you get a checkpoint between "ready" and "published":

```
/publish prepare minor
/publish promote
```

Or the one-shot alias:

```
/publish minor
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

1. **Sanitize + drop the `file:` entry from the global manifest.** The global
   manifest at `~/.cache/.bun/install/global/package.json` currently pins the
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
   the package is trusted. On this box `trustedDependencies` already lists
   `claude-slack-channel-bots` in the global manifest, which is what satisfies
   the trust gate for a global install here. If a fresh install reports the
   package as untrusted:

   ```sh
   bun pm -g untrusted        # confirm claude-slack-channel-bots is listed
   bun pm -g trust claude-slack-channel-bots
   ```

   The `-g` flag targets the global install; run from an arbitrary directory the
   non-`-g` form errors with `No package.json was found`. `bun pm -g trust` adds
   the package to `trustedDependencies` in the global
   manifest and runs the blocked postinstall, which scaffolds
   `~/.claude/channels/slack/{config.json,access.json}` and
   `~/.claude/slack-mcp.json`. Without this step, a later `start` fails with the
   cryptic `missing prerequisite: config.json`.

---

## Phase 3 — Verify the installed tree is real

Run all three checks. The install is only "real" if every one passes.

1. **No symlinks pointing into the repo.** The installed package's `src/` must
   be real files, not symlinks back into the working tree:

   ```sh
   find ~/.cache/.bun/install/global/node_modules/claude-slack-channel-bots -type l
   ```

   Expected output: **nothing**. Any line printed is a symlink — the install is
   still a symlink farm, not a registry copy. (You can further confirm none
   resolve into `/home/horde/projects/...` with
   `find ... -type l -lname '*claude-slack-channel-bots-project*'`.)

2. **Installed version matches the published version.** The binary has no
   `--version` flag, so read the version from the installed package's
   `package.json`:

   ```sh
   grep '"version"' ~/.cache/.bun/install/global/node_modules/claude-slack-channel-bots/package.json
   ```

   Expected: the `<version>` that `/publish prepare` reported. Confirm the binary
   itself resolves from PATH:

   ```sh
   command -v claude-slack-channel-bots
   ```

3. **Cron files are present on disk** (the whole point of the release):

   ```sh
   ls ~/.cache/.bun/install/global/node_modules/claude-slack-channel-bots/src/ \
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
- Tokens are sourced from `~/xoxb` / `~/xapp` (files, referenced by name — never
  echo their contents).

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

   You can confirm the global manifest is back to the `file:` shape by checking
   that `~/.cache/.bun/install/global/package.json` pins
   `"claude-slack-channel-bots": "file:/home/horde/projects/claude-slack-channel-bots-project/claude-slack-channel-bots-main"`
   and still carries `"trustedDependencies": ["claude-slack-channel-bots"]`.

3. **Re-verify the binary resolves** back to the `file:` build:

   ```sh
   command -v claude-slack-channel-bots
   find ~/.cache/.bun/install/global/node_modules/claude-slack-channel-bots/src -type l | head
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
