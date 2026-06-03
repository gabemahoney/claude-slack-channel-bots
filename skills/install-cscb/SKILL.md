---
name: install-cscb
description: Interactive walkthrough that installs or upgrades the system-installed `agent-director` so claude-slack-channel-bots can boot. Drives Epic 2's bun run install-check and per-reason remediation.
version: 1.0.0
author: Gabe Mahoney
license: MIT
user-invocable: true
argument-hint: "(no arguments)"
allowed-tools: [Bash, Read]
---

# /install-cscb

Diagnose and fix a broken or missing `agent-director` system install so
`claude-slack-channel-bots` (CSCB) can boot. This skill is the interactive
counterpart to the diagnostic `bun run install-check` script — same shared
check module, but with a guided remediation loop for each failure class.

## When to invoke

Invoke this skill when CSCB's startup gate emits one of these class labels
in `~/.claude/channels/slack/startup-errors.log`:

- `ad-system-install-not-found`
- `ad-system-install-too-old`
- `ad-system-install-unreachable`

The gate appends a pointer to this skill on those three classes. Other
failure classes (`ad-bun-version-too-old`, `ad-shim-*`, `ad-same-user`,
`ad-version-floor-unreadable`) are NOT remediated by this skill — see
the README's Startup-errors section for those.

## Step 1 — Run the shared check

From the CSCB project root, run:

```sh
bun run install-check
```

This is the same command you can run directly from the shell. It calls
the shared check module (`src/install-check.ts`) which is also what this
skill drives internally on every iteration.

Read the output carefully:

- **Exit 0 + "OK"**: agent-director is satisfied. Print the resolved
  binary path, detected version, and floor from the success output, then
  exit cleanly. No further action required.

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

Surface the install command published by `agent-director` verbatim for
the detected platform. Do NOT invent or maintain a CSCB-owned command —
consult agent-director's documentation
(<https://github.com/gabemahoney/agent-director>) for the canonical
install procedure. The current installer is `install.sh` from
agent-director's repo; recommend running it.

Prompt the user (using AskUserQuestion or an equivalent) — the literal
command must be visible:

> agent-director is not installed system-wide. Run the AD-published install
> command? `<command>`
>
> - **Yes** — run the command via Bash and continue.
> - **No** — install manually then continue.

- **Yes**: run the command via Bash. Capture stdout/stderr for the user
  to see. Return to Step 1.
- **No**: instruct the user to install manually. Wait for confirmation.
  Return to Step 1.

If the user declines to proceed at any point, exit non-zero with a
one-line summary: "Aborted by user — agent-director still not installed."

### `ad-system-install-too-old` — agent-director below floor

Same flow as `ad-system-install-not-found` but with the upgrade command
instead of the install command. Surface the detected version and the
required floor from the stderr block so the user understands what they
are upgrading from and to.

Prompt:

> agent-director is installed but at version `<detected>`, below the
> required floor `<required>`. Run the AD-published upgrade command?
> `<command>`
>
> - **Yes** — run the command via Bash and continue.
> - **No** — upgrade manually then continue.

- **Yes**: run via Bash. Return to Step 1.
- **No**: wait for manual upgrade. Return to Step 1.

### `ad-system-install-unreachable` — exhaustive reason switch

The stderr block carries an `err.reason` value verbatim. Branch on it
explicitly — every reason has a named branch, no `default:`-only
fallthrough.

1. **`not-executable`** — the agent-director file exists but lacks the
   executable bit. Show the user the binary path from the stderr block
   and suggest:
   ```sh
   chmod +x <binary_path>
   ```
   Re-run Step 1.

2. **`not-a-regular-file`** — the path resolved by `resolveSystemBinary()`
   is a directory, broken symlink, or other non-file. Recommend
   inspection (`ls -la <binary_path>`) and removal of the bad entry,
   then re-installation via the AD install command. Re-run Step 1.

3. **`probe-timeout`** — `agent-director --version` did not return within
   the probe window. Likely the binary is hanging on startup
   (corrupted, mismatched architecture, missing shared library).
   Recommend a manual `<binary_path> --version` invocation to confirm,
   then reinstall via the AD install command. Re-run Step 1.

4. **`probe-nonzero-exit`** — `agent-director --version` exited with a
   non-zero code. The stderr block surfaces `exitCode` and any
   `diagnostic` from AD. Show the user the values and recommend a
   manual reproduction (`<binary_path> --version`), then reinstall.
   Re-run Step 1.

5. **`probe-killed-by-signal`** — `agent-director --version` was killed
   by a signal (SIGSEGV, SIGBUS, etc.). The stderr block surfaces
   `signal`. The binary is likely corrupted or built for a different
   architecture. Recommend a full reinstall via the AD install command.
   Re-run Step 1.

6. **`unparseable-version`** — `agent-director --version` returned but
   the output could not be parsed as semver. The stderr's `diagnostic`
   field carries the raw output. Likely the installed binary is from
   a pre-release line that uses non-semver tags (e.g. `v0.6.3-dev`
   without sentinel handling). Recommend upgrading to a release AD
   version via the AD install command. Re-run Step 1.

7. **`spawn-failed`** — the OS rejected the spawn before the subprocess
   ran (ENOENT after stat succeeded, EACCES, EPERM, etc.). The stderr's
   `diagnostic` field carries the underlying OS error. Recommend
   checking filesystem permissions, then reinstalling. Re-run Step 1.

8. **`other`** — an unexpected failure mode AD's `resolveSystemBinary()`
   could not classify. Print the raw underlying error message from
   `detail.underlying` (or `diagnostic`) and direct the user to file
   a bug against `agent-director`:
   <https://github.com/gabemahoney/agent-director/issues>

   This is the only branch that recommends bug-filing rather than a
   local remediation step.

After rendering the per-reason remediation, ask the user to confirm
they have applied it, then return to Step 1.

### `ad-version-floor-unreadable` — corrupt agent-director npm package

This class is NOT a system-install problem — it indicates the
`node_modules/agent-director/dist/version-floor.json` file is missing,
malformed, or lacks `.min_binary_version`. The skill cannot walk the
user through fixing a corrupt AD npm package.

Print the reinstall guidance:

> The agent-director npm package appears corrupted. Reinstall it from
> npm in CSCB's project root:
>
> ```sh
> bun add agent-director@latest
> ```

Then exit. Do NOT loop on this class — the user must manually verify
the AD package is intact before re-invoking the skill.

## Step 4 — Loop or exit

After each remediation step, re-run Step 1. The skill keeps looping
until the check passes (exit cleanly with the success output) or the
user declines to proceed (exit non-zero with the abort summary).

## Notes

- This skill does not maintain its own list of agent-director install
  commands. AD's documentation is the source of truth; the skill
  surfaces AD's published command verbatim.
- This skill does not touch `~/.claude/channels/slack/` or CSCB's
  routing configuration. It only acts on the system-wide
  `agent-director` install.
- The skill is callable repeatedly; each invocation re-runs Step 1
  from a clean state.
