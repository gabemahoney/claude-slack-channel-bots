---
name: install-cscb
description: Interactive walkthrough that diagnoses the system-installed `agent-director` so claude-slack-channel-bots can boot. Runs bun run install-check, relays its note when the binary is below CSCB's Phase 1 floor, and walks the operator through the diagnosis of each failure class; for a missing or too-old install it names the README switch-over runbook and runs nothing. Names the agent-director client CSCB pins and the coupled install and rollback of this release with agent-director Phase 1.
version: 1.0.0
license: MIT
user-invocable: true
argument-hint: "(no arguments)"
allowed-tools: [Bash, Read]
---

# /install-cscb

Diagnose a broken or missing `agent-director` system install so
`claude-slack-channel-bots` (CSCB) can boot. This skill is the interactive
counterpart to the diagnostic `bun run install-check` script — same shared
check module, but with a guided diagnosis for each failure class. For an
install that is missing or too old, or below CSCB's Phase 1 floor, the skill
names the README's switch-over runbook instead of running anything.

## When to invoke

Invoke this skill when CSCB's startup gate emits one of these class labels
in `~/.claude/channels/slack/startup-errors.log`:

- `ad-system-install-not-found`
- `ad-system-install-too-old`
- `ad-system-install-unreachable`

The gate appends a pointer to this skill on those three classes. Other
failure classes (`ad-below-phase1-floor`, `ad-bun-version-too-old`,
`ad-shim-*`, `ad-same-user`, `ad-version-floor-unreadable`) are NOT
remediated by this skill — see the README's Startup-errors section for
those.

## This release and agent-director Phase 1

This CSCB release and agent-director Phase 1 are installed, and rolled
back, together. Every agent on the host, with every long-running
agent-director process, is stopped before either binary change and
started again after it.

Tell the user this before Step 1. The two are installed together by the
README section "Switching over to agent-director Phase 1", and rolled
back together by the README section "Rolling back the switch-over". This
skill points to those sections by title and does not repeat their steps.

The agent-director client CSCB pins is `agent-director@0.11.0`. It comes
installed with CSCB as its npm dependency. This skill runs no client
install and names no package-manager command for it: the client changes
only with CSCB itself.

## Step 1 — Run the shared check

From the CSCB project root, run:

```sh
bun run install-check
```

This is the same command you can run directly from the shell. It calls
the shared check module (`src/install-check.ts`) which is also what this
skill drives internally on every iteration.

Read the output carefully:

- **Exit 0 + "OK", with no `note:` line**: agent-director is satisfied.
  Print the resolved binary path, the detected version and the client's
  minimum (the `floor:` line) from the success output, then go to Step 5.
  This skill has nothing more to fix.

- **Exit 0 + "OK", with a `note:` line**: the binary meets the client's
  minimum but is below CSCB's Phase 1 floor. Print the success output as
  above, then:
  1. Relay the note to the user exactly as printed after the `note:`
     label.
  2. Tell the user that the server refuses to start on that binary until
     the switch-over: agent-director Phase 1 comes onto the host only
     through the README section "Switching over to agent-director Phase 1".
  3. Offer no command and run nothing for it. Go to Step 5.

- **Exit non-zero**: identify the class label on stderr (one of
  `ad-system-install-not-found`, `ad-system-install-too-old`,
  `ad-system-install-unreachable`, `ad-version-floor-unreadable`) and
  branch on it as documented below.

## Step 2 — Identify the user's platform

Detect the platform via `uname -sm`. CSCB supports two platforms:

- **linux-x64** — `Linux x86_64`
- **darwin-arm64** — `Darwin arm64` (Apple Silicon Mac)

Any other platform is unsupported by `agent-director` itself and the
skill cannot proceed; surface the platform mismatch to the user and
exit non-zero.

## Step 3 — Branch on the class label

### `ad-system-install-not-found` — agent-director missing

Show the user the locations the stderr block says were checked. Then tell
the user:

> No agent-director binary was found on PATH or at the standard install
> path. See the block "The publishing host" of the README section
> "Switching over to agent-director Phase 1", which covers a host with no
> agent-director.

If the user came here from the server's startup refusal on a bot host,
the binary may only be missing from the bot server's launcher HOME or
PATH while agent-director's store and workers are live; that block is
not for this host. Tell the user instead:

> The startup gate did not find agent-director. See step 1 of the README
> section "Switching over to agent-director Phase 1": its version check
> of agent-director, as the workers' user in the bot server's
> launcher environment, shows whether the launcher's HOME or PATH differs
> from the workers'.

Offer no command and run nothing for this class: agent-director comes onto
the host only as that README section says. Exit without returning to
Step 1; the user re-invokes the skill after following the section.

### `ad-system-install-too-old` — agent-director below the client's minimum

Show the user the detected version and the required version from the
stderr block, and the binary path.

Then tell the user:

> agent-director is installed but at version `<detected>`, below the
> required version `<required>`. agent-director comes onto this host with
> this CSCB release by following the README section
> "Switching over to agent-director Phase 1".

Offer no command and run nothing for this class, and do not ask whether
to run one: the runbook's `state.db` backup and its `serve` restarts must
come with the install, so agent-director changes on this host only
through that runbook. Exit without returning to Step 1; the user
re-invokes the skill after completing the runbook.

### `ad-system-install-unreachable` — exhaustive reason switch

The stderr block carries an `err.reason` value verbatim. Branch on it
explicitly — every reason has a named branch, no `default:`-only
fallthrough. Each branch below starts with a read-only diagnosis. Past
that, the skill changes nothing on the host except the executable bit in
reason 1: every other fix to the host's agent-director goes through the
README section "Switching over to agent-director Phase 1".

1. **`not-executable`** — the agent-director file exists but lacks the
   executable bit. Show the user the binary path from the stderr block
   and suggest:
   ```sh
   chmod +x <binary_path>
   ```
   Re-run Step 1. If the bit cannot be set, point the user to the README
   section "Switching over to agent-director Phase 1" and exit.

2. **`not-a-regular-file`** — the path resolved by `resolveSystemBinary()`
   is a directory, broken symlink, or other non-file. Recommend
   inspection (`ls -la <binary_path>`), then point the user to the README
   section "Switching over to agent-director Phase 1" and exit.

3. **`probe-timeout`** — `agent-director version` did not return within
   the probe window. Likely the binary is hanging on startup
   (corrupted, mismatched architecture, missing shared library).
   Recommend a manual `<binary_path> version` invocation to confirm,
   then point the user to the README section "Switching over to
   agent-director Phase 1" and exit.

4. **`probe-nonzero-exit`** — `agent-director version` exited with a
   non-zero code. The stderr block surfaces `exitCode` and any
   `diagnostic` from AD. Show the user the values and recommend a
   manual reproduction (`<binary_path> version`), then point the user to
   the README section "Switching over to agent-director Phase 1" and
   exit.

5. **`probe-killed-by-signal`** — `agent-director version` was killed
   by a signal (SIGSEGV, SIGBUS, etc.). The stderr block surfaces
   `signal`. The binary is likely corrupted or built for a different
   architecture. Show the user the signal and the platform from Step 2,
   then point the user to the README section "Switching over to
   agent-director Phase 1" and exit.

6. **`unparseable-version`** — `agent-director version` returned but
   the output could not be parsed as semver. The stderr's `diagnostic`
   field carries the raw output. Likely the installed binary is a
   development build that reports a version such as `dev`. Show the user
   the raw output, then point the user to the README section "Switching
   over to agent-director Phase 1" and exit.

7. **`spawn-failed`** — the OS rejected the spawn before the subprocess
   ran (ENOENT after stat succeeded, EACCES, EPERM, etc.). The stderr's
   `diagnostic` field carries the underlying OS error. Recommend
   checking filesystem permissions (`ls -la <binary_path>`), then point
   the user to the README section "Switching over to agent-director
   Phase 1" and exit.

8. **`other`** — an unexpected failure mode AD's `resolveSystemBinary()`
   could not classify. Print the raw underlying error message from
   `detail.underlying` (or `diagnostic`), point the user to the README
   section "Switching over to agent-director Phase 1", and direct the
   user to file a bug against `agent-director`:
   <https://github.com/gabemahoney/agent-director/issues>

   This is the only branch that recommends bug-filing.

### `ad-version-floor-unreadable` — corrupt agent-director npm package

This class is NOT a system-install problem — it indicates the
`node_modules/agent-director/dist/version-floor.json` file is missing,
malformed, or lacks `.min_binary_version`. The skill cannot walk the
user through fixing the agent-director npm package.

Tell the user:

> The agent-director npm package installed with CSCB, the client CSCB
> pins at `agent-director@0.11.0`, could not be read.
> Check the agent-director npm package installed with CSCB; see the README
> section "Switching over to agent-director Phase 1".

Then exit. Do NOT loop on this class — the user must manually verify
the AD package is intact before re-invoking the skill.

## Step 4 — Loop or exit

The skill loops only after reason 1 of `ad-system-install-unreachable`
(`not-executable`): once the user has set the executable bit, re-run
Step 1. It keeps looping until the check passes (print the success output,
relay its note if it carries one as Step 1 says, and go to Step 5) or the
user declines to proceed (exit non-zero with a one-line summary).

A pass whose output carries a `note:` line ends the loop too: relay the
note as printed, tell the user the server refuses to start on that binary
until the switch-over, point to the README section "Switching over to
agent-director Phase 1", and run nothing for it.

All other failures end the skill instead of looping:
`ad-system-install-not-found` and `ad-system-install-too-old` (the user
follows the README runbook, then re-invokes the skill), reasons 2 to 8 of
`ad-system-install-unreachable` (the user follows the README runbook or
files the bug, then re-invokes the skill) and
`ad-version-floor-unreadable` (the user checks the npm package, then
re-invokes the skill).

## Step 5 — Next steps

On a pass whose output carries a `note:` line, agent-director is not
ready for this CSCB release: the server refuses to start on that binary
until the switch-over by the README section "Switching over to
agent-director Phase 1", and no persona comes up before it. The rest of
this step applies once the server can start.

On a pass with no `note:` line, agent-director is ready to run the
personas. CSCB launches one agent-director instance per persona, named
`cscb_<key>` after the persona's key; `agent-director list --label
service=cscb` lists them once the server is running.

- To add or change personas, run the setup wizard
  (`/setup-slack-channel-bots`).
- If a persona still does not come up after the server starts, the
  cause is in the server log, not in the agent-director install. Use
  the `debug-slack-channel-bots` skill.

## Notes

- This skill runs nothing on the host's agent-director but `chmod +x`
  (reason 1 of `ad-system-install-unreachable`) and offers no command
  that changes it: agent-director comes onto the host, or changes there,
  only as the README section "Switching over to agent-director Phase 1"
  says, and goes back only as the README section "Rolling back the
  switch-over" says.
- This skill runs no install of the agent-director client. The client,
  `agent-director@0.11.0`, comes installed with CSCB.
- This skill does not touch the persona configuration
  (`~/.claude/channels/slack/config.json`), the persona credentials
  files or the reload files beside the configuration. It only acts on
  the system-wide `agent-director` install.
- The skill is callable repeatedly; each invocation re-runs Step 1
  from a clean state.
