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

- **`/publish prepare <bump>`** — reversible half: bump, pack, smoke, commit + tag locally, write `.publish-state.json`. Nothing reaches origin or npm. Free to rerun until prepare feels right.
- **`/publish promote`** — irreversible-but-short half: read manifest, verify state, push commit, npm publish, push tag, poll registry, sanitize globals, reinstall, verify. Idempotent on retry where possible.

Use the two-step path when you want a checkpoint between "this release is ready" and "this release is published." Use `/publish <bump>` for the happy-path one-shot.

## Skill Contract — HARD RULES

The shell scripts under `scripts/` are this skill's body. They are the ONLY authorized side-effecting commands in a release. When any SR-X.Y guard fires, a script exits non-zero with a diagnostic on stderr describing the failure state and operator-facing recovery options.

The LLM driving /publish MUST NOT, in response to any SR-X.Y failure:

- Execute side-effecting commands outside the skill's own scripts. No manual `git push`, `git pull`, `git reset`, `git tag`, `npm publish`, `npm login`, `bun install -g`, no manual edits to `package.json`, `bun.lock`, the global package.json, `.publish-state.json`, or any config file. This applies even when the failure prose *names* the command — the named command is for the operator, not the LLM.
- Invoke /publish (or /publish prepare, or /publish promote) a second time within a session without first either (a) the operator fixing the precondition that the failure prose names, or (b) filing a bee against the skill and waiting for human guidance. The LLM must not "try again to see if it works now" or rerun any /publish variant after performing its own out-of-band fix.
- Paraphrase, omit, soften, or "interpret around" an SR-X.Y diagnostic. Report the failure verbatim to the orchestrator/operator and stop.

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
2. **Run the `/ci` gate.** Invoke the `/ci` skill via the **Skill tool** (not a bash subprocess). Require it to report PASS. Any other outcome aborts: relay the `/ci` output verbatim, prefixed `SR-2.5 (/ci gate): `, and stop.
3. **Run `bash scripts/publish-prepare.sh <bump>`.** On exit 0 continue. On any non-zero exit, relay the script's stderr verbatim and stop — do NOT run promote. Prepare failures are fully reversible per the script's stderr.
4. **Run `bash scripts/publish-promote.sh`.** On exit 0, the release is complete — relay the success summary the script printed to stdout. On any non-zero exit, relay stderr verbatim and stop. The operator decides whether to rerun `/publish promote` (idempotent on transient failures) or follow the explicit recovery in stderr.

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
| 13   | SR-2.2 / SR-2.3 | install/test/typecheck/no-test-files failed | operator: fix on `main`, commit, rerun /publish |
| 14   | SR-2.4 | not authenticated to npm, OR next version already on npm | operator: `npm login`, or pull/larger bump |
| 15   | SR-2.5 | host's agent-director binary missing/broken, OR its version does not satisfy package.json's declared range | operator: upgrade agent-director to match the declared range, or edit the range in package.json |
| 20   | SR-3.1 | `npm version <bump>` failed | working tree rolled back; operator investigates |
| 21   | SR-4.1 | `bun pm pack` failed or tarball internal version mismatch | working tree rolled back; operator investigates |
| 22   | SR-4.2 | scratch install failed or installed version mismatch | working tree rolled back; operator inspects bun install / tarball layout |
| 23   | SR-4.3 | smoke contract violated | working tree rolled back; operator updates `src/cli.ts` or the smoke contract |
| 30   | SR-5.1 | `git add` / `git commit` failed | working tree rolled back; operator inspects git status / pre-commit hook |
| 31   | SR-5.1 | `git tag` failed | commit IS on local `main`, NOT pushed; operator: `git reset --hard HEAD~1` then rerun /publish |
| 90   | SR-8.1 | `.publish-state.json` write failed | commit + tag + tarball exist locally; operator: roll back per stderr prose, then rerun /publish |

Promote-phase exit codes (script: `scripts/publish-promote.sh`):

| Code | SR | Failure | Recovery owner |
|------|----|---------|----------------|
| 0    | SR-9.1 | release complete; manifest deleted | — |
| 1    | precondition | manifest missing/corrupt, HEAD ≠ manifest commit, tag missing/wrong, package.json drift, tarball missing/sha1 mismatch, or smoke_passed=false | operator: per stderr; usually delete `.publish-state.json` and rerun `/publish prepare <bump>` |
| 50   | SR-5.2 | `git push origin main` failed | commit + tag local only; manifest preserved; operator resolves and reruns /publish promote (idempotent), OR rolls back per stderr |
| 51   | SR-5.3 | `npm publish` failed, OR version exists on npm with mismatched dist.shasum | commit IS on origin/main; manifest preserved; operator fixes and reruns /publish promote, OR follows content-drift recovery in stderr |
| 52   | SR-5.4 | `git push origin <tag>` failed | npm has release; only tag missing; operator pushes tag manually + deletes manifest. Do NOT rerun /publish promote unless tag still confirmed missing. |
| 60   | SR-6.1 | registry did not surface new version within 60s | release succeeded; propagation lag; operator confirms + reinstalls manually + deletes manifest. Do NOT rerun /publish promote. |
| 71   | SR-7.3 | post-publish `bun install -g` failed | release IS published; manifest preserved; operator reruns install manually + deletes manifest. Do NOT rerun /publish promote. |
| 72   | SR-7.4 | post-publish verification failed | release IS published; manifest preserved; operator follows stderr recovery. Do NOT rerun /publish promote. |

Any script — backstop:

| Code | SR | Failure | Recovery owner |
|------|----|---------|----------------|
| 99   | SR-99.0 (uncaught) | script terminated with no per-step SR-X.Y diagnostic. State indeterminate; report and pause. | operator: report the SR-99.0 trap output verbatim so the unguarded site can be wrapped; do NOT rerun /publish |

The LLM's response on any non-zero exit is the same: relay the script's stderr verbatim, identify the recovery owner from the table above, and stop. The LLM is never the recovery owner.

## File pointers

- `scripts/publish-prepare.sh` — reversible half (preflight + bump + pack + smoke + commit + tag + manifest)
- `scripts/publish-promote.sh` — irreversible half (push commit + publish + push tag + poll + sanitize + reinstall + verify)
- `scripts/preflight.sh` — invoked by `publish-prepare.sh` (SR-2.1–SR-2.4)
- `scripts/smoke-check.sh` — invoked by `publish-prepare.sh` (SR-4.2 / SR-4.3)
- `scripts/sanitize-global.sh` — invoked by `publish-promote.sh` (SR-7.1 / SR-7.2; sunsets when bun ≥ 1.3.14 is universal)
- `.publish-state.json` — handoff manifest, written by prepare and consumed/deleted by promote
- `.claude/skills/publish-prepare/SKILL.md`, `.claude/skills/publish-promote/SKILL.md` — sibling skills for the two-step path
