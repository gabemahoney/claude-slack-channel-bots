---
name: publish-prepare
description: Reversible half of a release — bump, pack, smoke, commit + tag locally, write .publish-state.json. Nothing is pushed to origin or npm.
user-invocable: true
argument-hint: "patch|minor|major"
allowed-tools: [Bash, Read, Skill]
---

# /publish prepare

Reversible half of a `claude-slack-channel-bots` release. Bumps the version, packs the tarball, smoke-tests the install, commits the release commit + annotated tag locally, and writes the `.publish-state.json` handoff manifest. Nothing is pushed to origin or npm — `/publish promote` is the irreversible follow-up.

## Skill Contract — HARD RULES

The shell scripts under `scripts/` are this skill's body. They are the ONLY authorized side-effecting commands. When any SR-X.Y guard fires, a script exits non-zero with a diagnostic on stderr describing the failure state and operator-facing recovery options.

The LLM driving /publish prepare MUST NOT, in response to any SR-X.Y failure:

- Execute side-effecting commands outside the skill's own scripts. No manual `git push`, `git pull`, `git reset`, `git tag`, `npm publish`, `npm login`, `bun install -g`, no manual edits to `package.json`, `bun.lock`, the global package.json, `.publish-state.json`, or any config file. This applies even when the failure prose *names* the command — the named command is for the operator, not the LLM.
- Invoke /publish prepare a second time within a session without first either (a) the operator fixing the precondition that the failure prose names, or (b) filing a bee against the skill and waiting for human guidance. The LLM must not "try again to see if it works now" or rerun /publish prepare after performing its own out-of-band fix.
- Paraphrase, omit, soften, or "interpret around" an SR-X.Y diagnostic. Report the failure verbatim to the orchestrator/operator and stop.

"The operator" means the human who invoked /publish prepare (or, when run via an orchestrator, the human responsible for that orchestrator). Every "Operator recovery:" block in script stderr addresses the operator. The LLM's only job on a non-zero exit is to surface the stderr verbatim and stop. These rules are non-negotiable; if a rule appears wrong in context, file a bee against this contract rather than bend it.

## Invocation

```
/publish prepare <patch|minor|major>
```

## Procedure

1. **Validate the bump arg.** If missing or not one of `patch`/`minor`/`major`, print the usage line above and stop. Do not run any script.
2. **Run the `/ci` gate.** Invoke the `/ci` skill via the **Skill tool** (not a bash subprocess). Require it to report PASS. Any other outcome (FAIL, ERROR, non-runnable) aborts: relay the `/ci` output verbatim, prefixed `SR-2.5 (/ci gate): `, and stop.
3. **Run `bash scripts/publish-prepare.sh <bump>`.** The script runs preflight, bumps the version, packs the tarball, runs the smoke check, commits the release commit and annotated tag locally, and writes `.publish-state.json`. On exit 0, relay the success summary the script printed to stdout. On any non-zero exit, relay stderr verbatim and stop.

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
| 13   | SR-2.2 / SR-2.3 | `bun install --frozen-lockfile`, `bun test`, `bun run typecheck`, or "no *.test.ts files" failed | operator: fix on `main`, commit, rerun /publish prepare |
| 14   | SR-2.4 | not authenticated to npm, OR next version already on npm | operator: `npm login`, or pull/larger bump |
| 20   | SR-3.1 | `npm version <bump>` failed | working tree rolled back; operator investigates npm error |
| 21   | SR-4.1 | `bun pm pack` failed or tarball internal version mismatch | working tree rolled back; operator investigates pack output |
| 22   | SR-4.2 | scratch install failed or installed version mismatch | working tree rolled back; operator inspects bun install / tarball layout |
| 23   | SR-4.3 | bin missing or smoke contract (`Usage:` + non-zero exit) violated | working tree rolled back; operator updates `src/cli.ts` or the smoke contract |
| 30   | SR-5.1 | `git add` or `git commit` failed | working tree rolled back; operator inspects git status / pre-commit hook |
| 31   | SR-5.1 | `git tag` failed | commit IS on local `main`, NOT pushed; operator: `git reset --hard HEAD~1` then rerun /publish prepare |
| 90   | SR-8.1 | `.publish-state.json` write failed | commit + tag + tarball exist locally; operator: roll back per stderr prose, then rerun /publish prepare |

The LLM's response on any non-zero exit is the same: relay the script's stderr verbatim, identify the recovery owner from the table above, and stop. The LLM is never the recovery owner.

## File pointers

- `scripts/publish-prepare.sh` — bump + pack + smoke + commit + tag + manifest write
- `scripts/preflight.sh` — invoked first by `publish-prepare.sh` (SR-2.1–SR-2.4)
- `scripts/smoke-check.sh` — SR-4.2 / SR-4.3 (invoked by `publish-prepare.sh`)
- `.publish-state.json` — handoff manifest at repo root, consumed by `/publish promote`
