---
name: publish
description: Build, verify, and publish claude-slack-channel-bots to npm — convenience alias for /publish prepare <bump> followed by /publish promote
user-invocable: true
argument-hint: "patch|minor|major"
allowed-tools: [Bash, Read, Skill]
---

# /publish

Cut a release of `claude-slack-channel-bots` end-to-end. This skill is the **convenience alias** for the two-step path; it invokes prepare then promote in sequence. The release flow lives in `scripts/`; this skill is the contract + invocation layer.

The two halves are also individually invocable:

- **`/publish prepare <bump>`** — reversible half: bump, version `CHANGELOG.md`, pack, smoke, commit + tag locally, write `.publish-state.json`. Nothing reaches origin or npm. Free to rerun until prepare feels right.
- **`/publish promote`** — irreversible-but-short half: read manifest, verify state, push commit, npm publish, push tag, poll registry, sanitize globals, reinstall, verify. Idempotent on retry where possible.

Use the two-step path when you want a checkpoint between "this release is ready" and "this release is published." Use `/publish <bump>` for the happy-path one-shot.

## Skill Contract — HARD RULES

The shell scripts under `scripts/` are this skill's body. They are the ONLY authorized side-effecting commands in a release. Most SR-X.Y guards are **fatal**: when one fires, the script exits non-zero with a diagnostic on stderr describing the failure state and operator-facing recovery options.

Three guards are **warn-only** and have never had exit codes of their own — **SR-7.0** (pre-install shadow check), **SR-7.4b** (postinstall trust), and **SR-7.5** (post-verify working-tree snapshot). Each prints an `SR-X.Y … WARNING` (or NOTE) block on stderr and lets the release continue; all three run after the release is already published and tagged, so failing there would misreport a delivered release as broken. SR-7.4b and SR-7.5 also run after the install has been verified; SR-7.0 runs before the remove/install step, and warns rather than aborts because aborting there would leave the host with the stale copy *and* no new install — strictly worse. A run that prints one of these blocks and still exits 0 **is a successful release**. `.claude/skills/publish-promote/SKILL.md` describes what each one checks and what the operator should do about it.

**SR-2.5 passing with a note.** A host agent-director binary at or above the installed agent-director client's minimum but below CSCB's Phase 1 floor passes SR-2.5 (preflight) and prints an `SR-2.5 (preflight) NOTE` block on stderr: this CSCB release needs agent-director Phase 1 on the host, by the README section "Switching over to agent-director Phase 1". SR-2.5 has not failed and the script keeps running. The LLM relays the note verbatim and continues the procedure; it does not abort, does not describe the run as failed, and performs no remediation. The note is never licence for the LLM to install, change or replace agent-director, or to edit any file; the switch-over is the operator's, by that runbook section. Of the MUST-NOTs below, the warn-only rules (report verbatim **and continue**) apply to this note exactly as they apply to SR-7.0, SR-7.4b and SR-7.5.

The LLM driving /publish MUST NOT, in response to any SR-X.Y diagnostic:

- Execute side-effecting commands outside the skill's own scripts. No manual `git push`, `git pull`, `git reset`, `git tag`, `npm publish`, `npm login`, `bun install -g`, no manual edits to `package.json`, `bun.lock`, `CHANGELOG.md`, the global package.json, `.publish-state.json`, or any config file. This applies even when the failure prose *names* the command — the named command is for the operator, not the LLM.
- Invoke /publish (or /publish prepare, or /publish promote) a second time within a session without first either (a) the operator fixing the precondition that the failure prose names, or (b) filing a bee against the skill and waiting for human guidance. The LLM must not "try again to see if it works now" or rerun any /publish variant after performing its own out-of-band fix.
- Paraphrase, omit, soften, or "interpret around" an SR-X.Y diagnostic. Report it verbatim to the orchestrator/operator. On a **fatal** guard (the script exited non-zero) that means report verbatim **and stop**. On a **warn-only** guard (SR-7.0, SR-7.4b, SR-7.5, with the script still running or exited 0) it means report verbatim **and continue** — do not abort the procedure, do not describe the release as failed, and still relay the success summary if the script exits 0. Either way the LLM performs none of the remediation the diagnostic names.

The first two MUST-NOTs above apply to warn-only guards too: a warning is never license to run a recovery command or to rerun /publish.

"The operator" means the human who invoked /publish (or, when /publish is run via an orchestrator, the human responsible for that orchestrator). Every "Operator recovery:" block in script stderr addresses the operator. The LLM's only job on a non-zero exit is to surface the stderr verbatim and stop. These rules are non-negotiable; if a rule appears wrong in context, file a bee against this contract rather than bend it.

## Invocation

```
/publish <patch|minor|major>
```

Equivalent two-step path:

```
/publish prepare <patch|minor|major>
/publish promote
```

## Procedure

1. **Validate the bump arg.** If missing or not one of `patch`/`minor`/`major`, print the usage line above and stop. Do not run any script.
2. **Run the `/ci` gate.** Invoke the `/ci` skill via the **Skill tool** (not a bash subprocess). Require it to report PASS. Any other outcome aborts: relay the `/ci` output verbatim, prefixed `SR-2.7 (/ci gate): `, and stop.
3. **Run `bash scripts/publish-prepare.sh <bump>`.** On exit 0 continue. On any non-zero exit, relay the script's stderr verbatim and stop — do NOT run promote. Prepare failures are fully reversible per the script's stderr.
4. **Run `bash scripts/publish-promote.sh` with the Bash tool's maximum timeout (`timeout: 600000`, i.e. 600s).** The default 120s tool timeout is shorter than the SR-6.1 registry poll alone (a 10-minute window). On exit 0, the release is complete — relay the success summary the script printed to stdout. On any non-zero exit, relay stderr verbatim and stop. The operator decides whether to rerun `/publish promote` (idempotent on transient failures) or follow the explicit recovery in stderr.

The LLM driving /publish MUST NOT execute any bash command outside of `bash scripts/publish-prepare.sh <bump>` and `bash scripts/publish-promote.sh`. Recovery commands named in stderr are for the operator.

## Exit code → operator recovery

Prepare-phase exit codes (script: `scripts/publish-prepare.sh`):

| Code | SR | Failure | Recovery owner |
|------|----|---------|----------------|
| 0    | —      | prepare complete, manifest written | — |
| 2    | SR-1.2 | missing/invalid bump arg | LLM: print usage; do not rerun |
| 3    | SR-10.1 | not inside a git working tree | operator: rerun from a clone of the repo |
| 10   | SR-2.1 | working tree dirty OR not on `main` | operator: commit/stash or `git checkout main` |
| 11   | SR-2.1 | `git fetch origin` failed | operator: fix network/auth; rerun /publish |
| 12   | SR-2.1 | local `main` behind/diverged from origin/main | operator: `git pull --ff-only` (behind) or resolve manually (diverged); LLM must NOT push/pull/reset |
| 13   | SR-2.2 / SR-2.3 | install/test/typecheck/no-test-files failed, OR `mktemp -d` could not make the suite's scratch HOME, OR the test preload guard refused to start `bun test` (its exit 78, with a `host-safety preload: refusing to start` line on stderr; commonly a `TMPDIR` inside the home directory) | operator: fix on `main`, commit, rerun /publish; for `mktemp -d`, make the temp directory (`TMPDIR`, else `/tmp`) exist and be writable, then rerun /publish; for the guard's refusal, point `TMPDIR` at a directory outside the home (or unset it to use `/tmp`), then rerun /publish |
| 14   | SR-2.4 / SR-2.4a / SR-2.4b | not authenticated to npm, OR next version already on npm, OR npm registry is non-canonical (SR-2.4a), OR `bun pm whoami` did not succeed (SR-2.4b) | operator: `npm login` / `npm config set registry https://registry.npmjs.org/` / `bun pm login`, or pull/larger bump |
| 15   | SR-2.5 | host's agent-director check failed: no binary found, OR its version cannot be read, OR it is below the installed agent-director client's minimum, OR that minimum cannot be read, OR `scripts/ad-version-check.ts` did not run to completion. Every SR-2.5 diagnostic names the README section "Switching over to agent-director Phase 1". A binary at or above the client's minimum but below CSCB's Phase 1 floor does not fail: it passes with an `SR-2.5 (preflight) NOTE` | operator: follow the diagnostic's operator recovery; the host's agent-director is changed only by the README section "Switching over to agent-director Phase 1"; then rerun /publish. When the client's minimum cannot be read or the check did not run to completion, the operator assesses before any rerun |
| 16   | SR-2.6 | stranded finished work: a finished ticket's fix is neither on `main` nor explicitly closed, OR an unmerged branch references a finished ticket (audit exit 1) | operator: land the fix or explicitly close the ticket (stated reason — no-repro/won't-fix/not-a-bug/by design/works as intended/superseded/abandoned/satisfied-by-other-work, with a pointer — or an anchored `## +closed:out-of-repo <path>` / `## +closed:docs-only` heading); merge or delete the branch; then rerun /publish |
| 17   | SR-2.6 | the finished-work audit could not run — it could not locate the hives / a git repo / a `main` ref from this checkout (audit exit 2 or other). NOT stranded work; a setup failure. Release still blocked (fail closed). | operator: rerun /publish from the canonical checkout that sits beside the Bugs/Plans/Ideas hives (the main working clone), not a throwaway/`/tmp` clone |
| 20   | SR-3.1 | `npm version <bump>` failed, OR `CHANGELOG.md` has no `## Unreleased` heading, OR its rewrite to the release's heading failed (`date -u` or `node` failed); the two `CHANGELOG.md` failures print `SR-3.1 (changelog)` | working tree rolled back (`package.json`, `bun.lock` and `CHANGELOG.md`); operator investigates, then reruns /publish; with no `## Unreleased` heading, operator puts this release's notes under an `## Unreleased` heading as `CHANGELOG.md`'s first `##` entry, commits that to main, then reruns /publish |
| 21   | SR-4.1 | `bun pm pack` failed or tarball internal version mismatch | working tree rolled back; operator investigates |
| 22   | SR-4.2 | scratch install failed or installed version mismatch | working tree rolled back; operator inspects bun install / tarball layout |
| 23   | SR-4.3 | smoke contract violated | working tree rolled back; operator updates `src/cli.ts` or the smoke contract |
| 30   | SR-5.1 | `git add` / `git commit` failed | working tree and index rolled back to HEAD (`package.json`, `bun.lock` and `CHANGELOG.md` restored and unstaged; nothing committed); operator inspects git status / pre-commit hook, then reruns /publish |
| 31   | SR-5.1 | `git tag` failed | commit IS on local `main`, NOT pushed; operator: `git reset --hard HEAD~1` then rerun /publish |
| 90   | SR-8.1 | `.publish-state.json` write failed | commit + tag + tarball exist locally; operator: roll back per stderr prose, then rerun /publish |

SR-3.2 (rollback) has no exit code of its own. On the 20, 21, 22, 23 and 30 failures (and any other non-zero exit from `smoke-check.sh`), prepare runs `git checkout HEAD -- package.json bun.lock CHANGELOG.md` before it exits. That restores the three files to HEAD's copies in the working tree and the index alike, so after a failed `git add` or `git commit` (30) it also unstages whatever of the bump `git add` had staged. It never runs on a preflight code, 31 or 90. If the checkout itself fails, stderr carries an `SR-3.2 (rollback)` line after the failing step's own diagnostic, and the exit code is still the failing step's: the working tree may still hold the bumped version or the rewritten `CHANGELOG.md` heading, and after a failed `git add` or `git commit` the index may still have them staged, even though the step's own line says they were rolled back. Recovery owner is the operator: run `git status`, then `git checkout HEAD -- package.json bun.lock CHANGELOG.md` by hand, then follow the failing step's row above. The LLM relays both lines verbatim and stops; it runs neither command.

Promote-phase exit codes (script: `scripts/publish-promote.sh`):

| Code | SR | Failure | Recovery owner |
|------|----|---------|----------------|
| 0    | SR-9.1 | release complete; manifest deleted | — |
| 1    | precondition | manifest missing/corrupt, HEAD ≠ manifest commit, tag missing/wrong, package.json drift, tarball missing/sha1 mismatch, or smoke_passed=false | operator: per stderr; usually delete `.publish-state.json` and rerun `/publish prepare <bump>` |
| 50   | SR-5.2 | `git push origin main` failed | commit + tag local only; manifest preserved; operator resolves and reruns /publish promote (idempotent), OR rolls back per stderr |
| 51   | SR-5.3 | `npm publish` failed, OR version exists on npm with mismatched dist.shasum | commit IS on origin/main; manifest preserved; operator fixes and reruns /publish promote, OR follows content-drift recovery in stderr |
| 52   | SR-5.4 | `git push origin <tag>` failed | npm has release; only tag missing; operator pushes tag manually + deletes manifest. Do NOT rerun /publish promote unless tag still confirmed missing. |
| 60   | SR-6.1 | registry did not surface new version within 10 minutes | release succeeded; propagation lag; operator confirms + reinstalls manually + deletes manifest. Do NOT rerun /publish promote. |
| 70   | SR-7.1 | `scripts/sanitize-global.sh` exited non-zero (belt-and-suspenders — sanitize itself also enforces exit 0 always) | release IS published; local global `package.json` may still contain bun-1.3.13 poison; manifest preserved; operator inspects `${BUN_INSTALL:-$HOME/.bun}/install/global/package.json`, removes empty-string and pre-existing `claude-slack-channel-bots` entries manually, then reruns `bun install -g` + `clean_restart`, then deletes the manifest. Do NOT rerun /publish promote. |
| 71   | SR-7.3 | post-publish `bun install -g` failed | release IS published; manifest preserved; operator reruns install manually + deletes manifest. Do NOT rerun /publish promote. |
| 72   | SR-7.4 | post-publish verification failed | release IS published; manifest preserved; operator follows stderr recovery. Do NOT rerun /publish promote. |

A Bash *tool* timeout during promote (raw timeout, no SR-X.Y block) is almost always the SR-6.1 poll overrunning even the 600s maximum. Treat it as exit 60 with the stderr missing: push, publish, and tag already succeeded, and the manifest is preserved. Operator recovery is exit 60's — confirm with `npm view claude-slack-channel-bots@<version> version`, run `bun install -g` + `clean_restart` manually, then delete the manifest. Do NOT rerun /publish promote blindly.

Any script — backstop:

| Code | SR | Failure | Recovery owner |
|------|----|---------|----------------|
| any (inherited from the failing command) | SR-99.0 (uncaught) | script died at an **unguarded** site — a `set -e` failure with no SR wrapper — so no per-step SR-X.Y diagnostic was printed. State indeterminate; report and pause. | operator: report the SR-99.0 trap output verbatim so the unguarded site can be wrapped; do NOT rerun /publish |

SR-99.0 is a backstop, not an exit code of its own: the EXIT trap keeps whatever code the failing command produced and only fires when the exit did *not* come from a guarded SR path. Each script raises a one-way flag (`sr_exit`) immediately before every deliberate `exit`, so a guarded failure prints exactly one SR-X.Y block (a failed SR-3.2 rollback is a second failure, with its own block after the failing step's). **SR-99.0 and a per-step SR-X.Y diagnostic never appear together** — if you see SR-99.0, the site genuinely had no wrapper.

The LLM's response on any non-zero exit is the same: relay the script's stderr verbatim, identify the recovery owner from the table above, and stop. The LLM is never the recovery owner.

## File pointers

- `scripts/publish-prepare.sh` — reversible half (preflight + bump + `CHANGELOG.md` heading + pack + smoke + commit + tag + manifest)
- `scripts/publish-promote.sh` — irreversible half (push commit + publish + push tag + poll + sanitize + reinstall + verify)
- `scripts/preflight.sh` — invoked by `publish-prepare.sh` (SR-2.1–SR-2.6)
- `scripts/ad-version-check.ts` — the host agent-director check that `preflight.sh` runs for SR-2.5 (pass, pass with the `SR-2.5 (preflight) NOTE`, or exit 15)
- `scripts/smoke-check.sh` — invoked by `publish-prepare.sh` (SR-4.2 / SR-4.3)
- `scripts/sanitize-global.sh` — invoked by `publish-promote.sh` (SR-7.1 / SR-7.2; sunsets when bun ≥ 1.3.14 is universal)
- `.publish-state.json` — handoff manifest, written by prepare and consumed/deleted by promote
- `.claude/skills/publish-prepare/SKILL.md`, `.claude/skills/publish-promote/SKILL.md` — sibling skills for the two-step path
