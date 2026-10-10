---
name: publish-prepare
description: Reversible half of a release — bump, version CHANGELOG.md, pack, smoke, commit + tag locally, write .publish-state.json. Nothing is pushed to origin or npm.
user-invocable: true
argument-hint: "patch|minor|major"
allowed-tools: [Bash, Read, Skill]
---

# /publish prepare

Reversible half of a `claude-slack-channel-bots` release. Bumps the version, turns `CHANGELOG.md`'s first `## Unreleased` heading into `## <version> (<UTC date>)` under a fresh empty `## Unreleased` entry, packs the tarball, smoke-tests the install, commits the release commit + annotated tag locally, and writes the `.publish-state.json` handoff manifest. Nothing is pushed to origin or npm — `/publish promote` is the irreversible follow-up.

## Skill Contract — HARD RULES

The shell scripts under `scripts/` are this skill's body. They are the ONLY authorized side-effecting commands. When any SR-X.Y guard fires, a script exits non-zero with a diagnostic on stderr describing the failure state and operator-facing recovery options.

The LLM driving /publish prepare MUST NOT, in response to any SR-X.Y failure:

- Execute side-effecting commands outside the skill's own scripts. No manual `git push`, `git pull`, `git reset`, `git tag`, `npm publish`, `npm login`, `bun install -g`, no manual edits to `package.json`, `bun.lock`, `CHANGELOG.md`, the global package.json, `.publish-state.json`, or any config file. This applies even when the failure prose *names* the command — the named command is for the operator, not the LLM.
- Invoke /publish prepare a second time within a session without first either (a) the operator fixing the precondition that the failure prose names, or (b) filing a bee against the skill and waiting for human guidance. The LLM must not "try again to see if it works now" or rerun /publish prepare after performing its own out-of-band fix.
- Paraphrase, omit, soften, or "interpret around" an SR-X.Y diagnostic. Report the failure verbatim to the orchestrator/operator and stop.

"The operator" means the human who invoked /publish prepare (or, when run via an orchestrator, the human responsible for that orchestrator). Every "Operator recovery:" block in script stderr addresses the operator. The LLM's only job on a non-zero exit is to surface the stderr verbatim and stop. These rules are non-negotiable; if a rule appears wrong in context, file a bee against this contract rather than bend it.

**SR-2.5 passing with a note.** A host agent-director binary at or above the installed agent-director client's minimum but below CSCB's Phase 1 floor passes SR-2.5 (preflight) and prints an `SR-2.5 (preflight) NOTE` block on stderr: this CSCB release needs agent-director Phase 1 on the host, by the README section "Switching over to agent-director Phase 1". SR-2.5 has not failed and the script keeps running. The LLM relays the note verbatim and continues to the script's exit status (on exit 0, relay the success summary too); it does not abort, does not describe the run as failed, and performs no remediation. The note is never licence for the LLM to install, change or replace agent-director, or to edit any file; the switch-over is the operator's, by that runbook section.

## Invocation

```
/publish prepare <patch|minor|major>
```

## Procedure

1. **Validate the bump arg.** If missing or not one of `patch`/`minor`/`major`, print the usage line above and stop. Do not run any script.
2. **Run the `/ci` gate.** Invoke the `/ci` skill via the **Skill tool** (not a bash subprocess). Require it to report PASS. Any other outcome (FAIL, ERROR, non-runnable) aborts: relay the `/ci` output verbatim, prefixed `SR-2.7 (/ci gate): `, and stop.
3. **Run `bash scripts/publish-prepare.sh <bump>`.** The script runs preflight, bumps the version, versions `CHANGELOG.md`, packs the tarball, runs the smoke check, commits the release commit and annotated tag locally, and writes `.publish-state.json`. On exit 0, relay the success summary the script printed to stdout. On any non-zero exit, relay stderr verbatim and stop.

The LLM driving /publish prepare MUST NOT execute any bash command outside of `bash scripts/publish-prepare.sh <bump>`. Recovery commands named in stderr are for the operator.

## Exit code → operator recovery

| Code | SR | Failure | Recovery owner |
|------|----|---------|----------------|
| 0    | —      | success — manifest written, next step is `/publish promote` | — |
| 2    | SR-1.2 | missing/invalid bump arg | LLM: print usage; do not rerun |
| 3    | SR-10.1 | not inside a git working tree | operator: rerun from a clone of the repo |
| 10   | SR-2.1 | working tree dirty OR not on `main` | operator: commit/stash or `git checkout main` |
| 11   | SR-2.1 | `git fetch origin` failed | operator: fix network/auth; rerun /publish prepare |
| 12   | SR-2.1 | local `main` is behind or diverged from origin/main | operator: `git pull --ff-only` (behind) or resolve manually (diverged); LLM must NOT push/pull/reset |
| 13   | SR-2.2 / SR-2.3 | `bun install --frozen-lockfile`, `bun test` (run under a `mktemp -d` scratch HOME), `bun run typecheck`, or "no *.test.ts files" failed, OR `mktemp -d` could not make the suite's scratch HOME, OR the test preload guard refused to start `bun test` (its exit 78, with a `host-safety preload: refusing to start` line on stderr; commonly a `TMPDIR` inside the home directory) | operator: fix on `main`, commit, rerun /publish prepare; for `mktemp -d`, make the temp directory (`TMPDIR`, else `/tmp`) exist and be writable, then rerun /publish prepare; for the guard's refusal, point `TMPDIR` at a directory outside the home (or unset it to use `/tmp`), then rerun /publish prepare |
| 14   | SR-2.4 / SR-2.4a / SR-2.4b | not authenticated to npm, OR next version already on npm, OR npm registry is non-canonical (SR-2.4a), OR `bun pm whoami` did not succeed (SR-2.4b) | operator: `npm login` / `npm config set registry https://registry.npmjs.org/` / `bun pm login`, or pull/larger bump |
| 15   | SR-2.5 | host's agent-director check failed: no binary found, OR its version cannot be read, OR it is below the installed agent-director client's minimum, OR that minimum cannot be read, OR `scripts/ad-version-check.ts` did not run to completion. Every SR-2.5 diagnostic names the README section "Switching over to agent-director Phase 1". A binary at or above the client's minimum but below CSCB's Phase 1 floor does not fail: it passes with an `SR-2.5 (preflight) NOTE` | operator: follow the diagnostic's operator recovery; the host's agent-director is changed only by the README section "Switching over to agent-director Phase 1"; then rerun /publish prepare. When the client's minimum cannot be read or the check did not run to completion, the operator assesses before any rerun |
| 16   | SR-2.6 | stranded finished work: a finished ticket's fix is neither on `main` nor explicitly closed, OR an unmerged branch references a finished ticket (audit exit 1) | operator: land the fix or explicitly close the ticket (stated reason — no-repro/won't-fix/not-a-bug/by design/works as intended/superseded/abandoned/satisfied-by-other-work, with a pointer — or an anchored `## +closed:out-of-repo <path>` / `## +closed:docs-only` heading); merge or delete the branch; then rerun /publish prepare |
| 17   | SR-2.6 | the finished-work audit could not run — it could not locate the hives / a git repo / a `main` ref from this checkout (audit exit 2 or other). NOT stranded work; a setup failure. Release still blocked (fail closed). | operator: rerun /publish prepare from the canonical checkout that sits beside the Bugs/Plans/Ideas hives (the main working clone), not a throwaway/`/tmp` clone |
| 20   | SR-3.1 | `npm version <bump>` failed, OR `CHANGELOG.md` has no `## Unreleased` heading, OR its rewrite to the release's heading failed (`date -u` or `node` failed); the two `CHANGELOG.md` failures print `SR-3.1 (changelog)` | working tree rolled back (`package.json`, `bun.lock` and `CHANGELOG.md`); operator investigates npm or rewrite error, then reruns /publish prepare; with no `## Unreleased` heading, operator puts this release's notes under an `## Unreleased` heading as `CHANGELOG.md`'s first `##` entry, commits that to main, then reruns /publish prepare |
| 21   | SR-4.1 | `bun pm pack` failed or tarball internal version mismatch | working tree rolled back; operator investigates pack output |
| 22   | SR-4.2 | scratch install failed or installed version mismatch | working tree rolled back; operator inspects bun install / tarball layout |
| 23   | SR-4.3 | bin missing or smoke contract (`Usage:` + non-zero exit) violated | working tree rolled back; operator updates `src/cli.ts` or the smoke contract |
| 30   | SR-5.1 | `git add` or `git commit` failed | working tree rolled back; operator inspects git status / pre-commit hook |
| 31   | SR-5.1 | `git tag` failed | commit IS on local `main`, NOT pushed; operator: `git reset --hard HEAD~1` then rerun /publish prepare |
| 90   | SR-8.1 | `.publish-state.json` write failed | commit + tag + tarball exist locally; operator: roll back per stderr prose, then rerun /publish prepare |

SR-3.2 (rollback) has no exit code of its own. On the 20, 21, 22, 23 and 30 failures (and any other non-zero exit from `smoke-check.sh`), the script runs `git checkout -- package.json bun.lock CHANGELOG.md` before it exits. That restores the three files from the index: HEAD's copies, except after a failed `git commit` (30), where `git add` has already staged the bump and the checkout changes nothing. It never runs on a preflight code, 31 or 90. If the checkout itself fails, stderr carries an `SR-3.2 (rollback)` line after the failing step's own diagnostic, and the exit code is still the failing step's: the working tree may still hold the bumped version or the rewritten `CHANGELOG.md` heading, even though the step's own line says it was rolled back. Recovery owner is the operator: run `git status`, then `git checkout -- package.json bun.lock CHANGELOG.md` by hand, then follow the failing step's row above. The LLM relays both lines verbatim and stops; it runs neither command.

Backstop: `publish-prepare.sh` (and the `preflight.sh` / `smoke-check.sh` it invokes) also carries an EXIT trap that prints `SR-99.0 (uncaught)` when the script dies at an **unguarded** site — a `set -e` failure with no SR wrapper. It keeps the failing command's exit code rather than inventing one, and it never fires for the guarded exits in the table above, since every deliberate exit raises a one-way guard flag first. SR-99.0 and a per-step SR-X.Y diagnostic therefore never appear together. Recovery owner is the operator: relay the trap output verbatim so the unguarded site can be wrapped, and do not rerun.

The LLM's response on any non-zero exit is the same: relay the script's stderr verbatim, identify the recovery owner from the table above, and stop. The LLM is never the recovery owner.

## File pointers

- `scripts/publish-prepare.sh` — bump + `CHANGELOG.md` heading + pack + smoke + commit + tag + manifest write
- `scripts/preflight.sh` — invoked first by `publish-prepare.sh` (SR-2.1–SR-2.6)
- `scripts/ad-version-check.ts` — the host agent-director check that `preflight.sh` runs for SR-2.5 (pass, pass with the `SR-2.5 (preflight) NOTE`, or exit 15)
- `scripts/smoke-check.sh` — SR-4.2 / SR-4.3 (invoked by `publish-prepare.sh`)
- `.publish-state.json` — handoff manifest at repo root, consumed by `/publish promote`
