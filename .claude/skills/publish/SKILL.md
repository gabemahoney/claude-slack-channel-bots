---
name: publish
description: Build, verify, and publish claude-slack-channel-bots to npm
user-invocable: true
argument-hint: "patch|minor|major"
allowed-tools: [Bash, Read, Skill]
---

# /publish

Cut a release of `claude-slack-channel-bots` end-to-end. The release flow lives in `scripts/`; this skill is the contract + invocation layer.

## Skill Contract — HARD RULES

The shell scripts under `scripts/` are this skill's body. They are the ONLY authorized side-effecting commands in a release. When any SR-X.Y guard fires, a script exits non-zero with a diagnostic on stderr describing the failure state and operator-facing recovery options.

The LLM driving /publish MUST NOT, in response to any SR-X.Y failure:

- Execute side-effecting commands outside the skill's own scripts. No manual `git push`, `git pull`, `git reset`, `git tag`, `npm publish`, `npm login`, `bun install -g`, no manual edits to `package.json`, `bun.lock`, the global package.json, or any config file. This applies even when the failure prose *names* the command — the named command is for the operator, not the LLM.
- Invoke /publish a second time within a session without first either (a) the operator fixing the precondition that the failure prose names, or (b) filing a bee against the skill and waiting for human guidance. The LLM must not "try again to see if it works now" or rerun /publish after performing its own out-of-band fix.
- Paraphrase, omit, soften, or "interpret around" an SR-X.Y diagnostic. Report the failure verbatim to the orchestrator/operator and stop.

Throughout this skill, "the operator" means the human who invoked /publish (or, when /publish is run via an orchestrator, the human responsible for that orchestrator). Every "Operator recovery:" block in script stderr addresses the operator. The LLM's only job on a non-zero exit is to surface the stderr verbatim and stop.

These rules are non-negotiable. The skill is the source of truth on what a release is; any LLM-driven bypass is a release-integrity violation. If a rule appears wrong in context, file a bee against this contract rather than bend it.

## Invocation

```
/publish <patch|minor|major>
```

## Procedure

1. **Validate the bump arg.** If missing or not one of `patch`/`minor`/`major`, print the usage line above and stop. Do not run any script.
2. **Run Phase 1 preflight.** Invoke `bash scripts/preflight.sh <bump>`. On exit 0 continue. On any non-zero exit, relay the script's stderr verbatim to the operator and stop.
3. **Run Phase 2 (`/ci` gate).** Invoke the `/ci` skill via the **Skill tool** (not a bash subprocess). Require it to report PASS. Any other outcome (FAIL, ERROR, non-runnable) aborts: relay the `/ci` output verbatim, prefixed `SR-2.5 (/ci gate): `, and stop.
4. **Run Phase 3 release.** Invoke `bash scripts/publish.sh <bump>`. On exit 0, the release is complete — relay the success summary the script printed to stdout. On any non-zero exit, relay stderr verbatim and stop.

The LLM driving /publish MUST NOT execute any bash command outside of `bash scripts/preflight.sh <bump>` and `bash scripts/publish.sh <bump>`. Recovery commands named in stderr are for the operator.

## Exit code → operator recovery

| Code | Origin script | SR | Failure | Recovery owner |
|------|---------------|----|---------|----------------|
| 0    | either        | —      | success | — |
| 2    | preflight / publish | SR-1.2 | missing/invalid bump arg | LLM: print usage; do not rerun |
| 3    | preflight / publish | SR-10.1 | not inside a git working tree | operator: rerun from a clone of the repo |
| 10   | preflight     | SR-2.1 | working tree dirty OR not on `main` | operator: commit/stash or `git checkout main` |
| 11   | preflight     | SR-2.1 | `git fetch origin` failed | operator: fix network/auth; rerun /publish |
| 12   | preflight     | SR-2.1 | local `main` is behind or diverged from origin/main | operator: `git pull --ff-only` (behind) or resolve manually (diverged); LLM must NOT push/pull/reset |
| 13   | preflight     | SR-2.2 / SR-2.3 | `bun install --frozen-lockfile`, `bun test`, `bun run typecheck`, or "no *.test.ts files" failed | operator: fix on `main`, commit, rerun /publish |
| 14   | preflight     | SR-2.4 | not authenticated to npm, OR next version already on npm | operator: `npm login`, or pull/larger bump |
| 20   | publish       | SR-3.1 | `npm version <bump>` failed | working tree rolled back; operator investigates npm error |
| 21   | publish       | SR-4.1 | `bun pm pack` failed or tarball internal version mismatch | working tree rolled back; operator investigates pack output |
| 22   | publish (smoke-check) | SR-4.2 | scratch install failed or installed version mismatch | working tree rolled back; operator inspects bun install / tarball layout |
| 23   | publish (smoke-check) | SR-4.3 | bin missing or smoke contract (`Usage:` + non-zero exit) violated | working tree rolled back; operator updates `src/cli.ts` or the smoke contract |
| 30   | publish       | SR-5.1 | `git add` or `git commit` failed | working tree rolled back; operator inspects git status / pre-commit hook |
| 31   | publish       | SR-5.1 | `git tag` failed | commit IS on local `main`, NOT pushed; operator: `git reset --hard HEAD~1` then rerun /publish |
| 50   | publish       | SR-5.2 | `git push origin main` failed | commit + tag local only; tarball preserved at `claude-slack-channel-bots-<version>.tgz`; operator resolves push and finishes manually OR resets and reruns. LLM must NOT push. |
| 51   | publish       | SR-5.3 | `npm publish` failed | commit IS on origin/main; npm has nothing; tarball preserved; operator: `npm login` + `npm publish <tarball>` + push tag, OR revert remote and rerun. LLM must NOT publish. |
| 52   | publish       | SR-5.4 | `git push origin v<version>` failed | npm has the release; only the tag is missing; operator pushes the tag manually. Do NOT rerun /publish. |
| 60   | publish       | SR-6.1 | registry did not surface new version within 60s | release succeeded; propagation lag only; operator confirms with `npm view` then `bun install -g` + `clean_restart`. Do NOT rerun /publish. |
| 71   | publish       | SR-7.3 | post-publish `bun install -g` failed | release IS published; dev box has no global install; operator reruns `bun install -g` manually. Do NOT rerun /publish. |
| 72   | publish       | SR-7.4 | post-publish verification failed (bin missing on PATH, resolved outside global prefix, package.json missing, or installed version stale) | release IS published; operator follows the recovery in stderr; do NOT rerun /publish. |

The LLM's response on any non-zero exit is the same: relay the script's stderr verbatim, identify the recovery owner from the table above, and stop. The LLM is never the recovery owner.

## File pointers

- `scripts/preflight.sh` — Phase 1 (SR-1.2, SR-10.1, SR-2.1–SR-2.4)
- `scripts/publish.sh` — Phase 3 (SR-3.1, SR-4.1, SR-5.1–SR-5.4, SR-6.1, SR-7.3, SR-7.4, SR-9.1)
- `scripts/smoke-check.sh` — SR-4.2 / SR-4.3 (invoked by publish.sh)
- `scripts/sanitize-global.sh` — SR-7.1 / SR-7.2 (invoked by publish.sh; sunsets when bun ≥ 1.3.14 is universal)
