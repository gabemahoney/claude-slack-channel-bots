---
name: publish-promote
description: Irreversible half of a release — read .publish-state.json, push commit, npm publish, push tag, poll registry, sanitize globals, reinstall, verify. Idempotent on retry.
user-invocable: true
allowed-tools: [Bash, Read]
---

# /publish promote

Irreversible-but-short half of a `claude-slack-channel-bots` release. Reads `.publish-state.json` (written by `/publish prepare`), verifies the local state still matches what prepare produced, then pushes the commit, publishes the tarball to npm, pushes the tag, polls the registry, sanitizes the global package.json, reinstalls, and verifies.

Idempotent where possible: an already-pushed commit, an already-published version (with matching `dist.shasum`), and an already-pushed tag are all treated as successful skips. The post-install + verify always runs.

On success the working tree is left free of promote-induced `package.json` / `bun.lock` drift: the post-publish `bun -g` calls run from `$HOME` (a directory with no `package.json`) so bun cannot rewrite the local `package.json` / `bun.lock` during the global install, and a post-verify snapshot (SR-7.5) reverts any residual `package.json` / `bun.lock` drift the global install did induce, as a belt-and-suspenders safety net. Dirt in other files, or `package.json` / `bun.lock` dirt that pre-existed the release, is left untouched (SR-7.5 warns but still exits 0).

## Skill Contract — HARD RULES

The shell script `scripts/publish-promote.sh` is this skill's body. It is the ONLY authorized side-effecting command. When a precondition or a fatal SR-X.Y guard fires, the script exits non-zero with a diagnostic on stderr describing the failure state and operator-facing recovery options. SR-7.0, SR-7.4b and SR-7.5 are warn-only — they print an `SR-X.Y … WARNING` block on stderr and the release continues (see their paragraphs below the exit-code table).

The LLM driving /publish promote MUST NOT, in response to any failure:

- Execute side-effecting commands outside the skill's own script. No manual `git push`, `git pull`, `git reset`, `git tag`, `npm publish`, `npm login`, `bun install -g`, no manual edits to `package.json`, `bun.lock`, the global package.json, `.publish-state.json`, or any config file. This applies even when the failure prose *names* the command — the named command is for the operator, not the LLM.
- Invoke /publish promote a second time within a session without first either (a) the operator fixing the precondition that the failure prose names, or (b) filing a bee against the skill and waiting for human guidance. The LLM must not "try again to see if it works now" or rerun /publish promote after performing its own out-of-band fix. Note: /publish promote IS designed to be safely rerun by the operator after they resolve a transient failure (push/publish/tag are idempotent), but that decision belongs to the operator, not the LLM.
- Paraphrase, omit, soften, or "interpret around" an SR-X.Y diagnostic. Report it verbatim to the orchestrator/operator. For a fatal guard (non-zero exit) that means report verbatim **and stop**; for a warn-only guard (SR-7.0, SR-7.4b, SR-7.5) it means report verbatim **and continue** — an exit 0 that carried one of those warnings is still a completed release. The ban on executing the named remediation commands applies to warnings exactly as it does to failures.

"The operator" means the human who invoked /publish promote (or, when run via an orchestrator, the human responsible for that orchestrator). Every "Operator recovery:" block in script stderr addresses the operator. The LLM's only job on a non-zero exit is to surface the stderr verbatim and stop. These rules are non-negotiable; if a rule appears wrong in context, file a bee against this contract rather than bend it.

## Invocation

```
/publish promote
```

No arguments. The bump kind, target version, commit SHA, tag, and tarball path are all read from `.publish-state.json`. If the manifest is missing, the script refuses with an explicit "run /publish prepare first" message.

## Procedure

1. **Run `bash scripts/publish-promote.sh` with the Bash tool's maximum timeout (`timeout: 600000`, i.e. 600s).** The default 120s tool timeout is shorter than the SR-6.1 registry poll alone (a 10-minute window), so the default would kill the script mid-poll — after publish has already happened. The script reads `.publish-state.json`, verifies every precondition (manifest present and well-formed, HEAD matches, tag exists locally, package.json version matches, tarball file exists on disk with matching sha1), then idempotently pushes the commit, publishes the tarball, pushes the tag, polls the registry, sanitizes the global package.json, checks for a shadowing install (SR-7.0), removes any prior global install, reinstalls from npm, verifies, closes the postinstall trust gap (SR-7.4b), and snapshots the working tree (SR-7.5). On exit 0, relay the success summary the script printed to stdout (the manifest has been deleted — the release is complete). On any non-zero exit, relay stderr verbatim and stop.

The LLM driving /publish promote MUST NOT execute any bash command outside of `bash scripts/publish-promote.sh`. Recovery commands named in stderr are for the operator.

## Exit code → operator recovery

| Code | SR | Failure | Recovery owner |
|------|----|---------|----------------|
| 0    | SR-9.1 | release complete; manifest deleted | — |
| 1    | precondition | manifest missing, manifest corrupted, HEAD ≠ manifest commit, tag missing/wrong, package.json drift, tarball missing/sha1 mismatch, or smoke_passed=false | operator: follow the specific prose in stderr — usually delete `.publish-state.json` and rerun `/publish prepare <bump>` |
| 50   | SR-5.2 | `git push origin main` failed | commit + tag local; nothing pushed/published; manifest preserved; operator resolves push and reruns /publish promote (idempotent), OR rolls back per stderr |
| 51   | SR-5.3 | `npm publish` failed, OR version exists on npm with mismatched dist.shasum | commit IS on origin/main; npm state depends on subcase (see stderr); manifest preserved; operator fixes and reruns /publish promote, OR follows the content-drift recovery in stderr |
| 52   | SR-5.4 | `git push origin <tag>` failed | npm has the release; commit on origin/main; only the tag is missing; operator pushes the tag manually then deletes the manifest. Do NOT rerun /publish promote unless the tag is still confirmed missing on origin. |
| 60   | SR-6.1 | registry did not surface new version within 10 minutes | release succeeded; propagation lag only; operator confirms with `npm view`, runs `bun install -g` + `clean_restart` manually, then deletes the manifest. Do NOT rerun /publish promote. |
| 70   | SR-7.1 | `scripts/sanitize-global.sh` exited non-zero (belt-and-suspenders — sanitize itself also enforces exit 0 always) | release IS published; local global `package.json` may still contain bun-1.3.13 poison; manifest preserved; operator inspects `${BUN_INSTALL:-$HOME/.bun}/install/global/package.json`, removes empty-string and pre-existing `claude-slack-channel-bots` entries manually, then reruns `bun install -g` + `clean_restart`, then deletes the manifest. Do NOT rerun /publish promote. |
| 71   | SR-7.3 | post-publish `bun install -g` failed | release IS published; dev box has no global install; manifest preserved; operator reruns `bun install -g` manually, then deletes the manifest. Do NOT rerun /publish promote. |
| 72   | SR-7.4 | post-publish verification failed (bin missing on PATH, resolved outside global prefix, package.json missing, or installed version stale) | release IS published; manifest preserved; operator follows the recovery in stderr; do NOT rerun /publish promote. |

Tool timeout during the poll (no exit code, no SR-X.Y block): even at 600s, a slow propagation can consume the whole Bash tool budget, and the tool kills the script mid-SR-6.1 with a raw timeout instead of the exit-60 diagnostic. Read it as exit 60 with the stderr missing: the commit, `npm publish`, and the tag all already succeeded (SR-5.2–SR-5.4 run before the poll), and `.publish-state.json` is preserved. Recovery owner is the operator, and the recovery is exit 60's: confirm visibility with `npm view claude-slack-channel-bots@<version> version`, then run `bun install -g claude-slack-channel-bots@<version>` + `claude-slack-channel-bots clean_restart` manually, then delete `.publish-state.json`. Do NOT rerun /publish promote blindly — report the timeout and the state above, and stop.

SR-7.0 (pre-install shadow check) has no exit code of its own — it runs before the remove/install step and never fails the release. It resolves `claude-slack-channel-bots` on PATH as promote found it, and warns on stderr when that resolves outside the prefix promote is about to install into (a second bun global prefix, or a symlink farm pointing at a repo checkout). The warning carries the shared shadow report: the PATH entry, the symlink chain, the resolved path, the expected prefix, and the exact manual remediation. It only warns because aborting before the install would leave the host with the stale copy *and* no new install — strictly worse. Operator action: clear the shadowing install per the report's commands. If the shadow still wins after the install, SR-7.4 fails the release with the same report and exit 72, so an SR-7.0 warning on an otherwise-green run means the new version did land and won PATH. The LLM relays the warning verbatim and keeps going; it must not run any of the remediation commands itself.

SR-7.4b (postinstall trust) has no exit code of its own — it runs after SR-7.4 verification succeeds and never fails the release. Bun blocks a package's postinstall unless the global manifest lists it in `trustedDependencies`, so on a fresh global prefix the install succeeds while `src/postinstall.ts` never runs. The block adds the trust entry when it is missing (`bun pm -g trust claude-slack-channel-bots`), then checks that the two files postinstall scaffolds that the server and its persona sessions need exist: `config.json` under the state dir (`$SLACK_STATE_DIR`, default `~/.claude/channels/slack`), which `start` requires, and `~/.claude/slack-mcp.json`, the default MCP config persona sessions are launched with. The debugging-skill link postinstall also creates is a convenience and is not checked. If either file is still missing it prints a stderr WARNING naming the missing ones, with one consequence sentence per missing file, and exits 0 anyway — the release is published, tagged and verified, and the artifacts are skeletons an operator recreates in one command. Operator action: rerun `bun pm -g trust claude-slack-channel-bots`, confirm it prints a `✓ [postinstall]` line, and re-check the paths (trust swallows the postinstall's stdout, so the files on disk are the proof). Left without `config.json`, `claude-slack-channel-bots start` later dies with "missing prerequisite: config.json"; left without `slack-mcp.json`, persona sessions launched with the default `mcp_config_path` cannot reach the server's MCP endpoint. The LLM relays the warning verbatim and keeps going.

SR-7.5 (post-verify working-tree snapshot) has no exit code of its own — it runs after verification succeeds and never fails the release. The script snapshots which files are dirty at start, so it can distinguish promote-induced dirt from operator dirt. It reverts `package.json` / `bun.lock` only when they were clean at start and dirty after (promote-induced transitive-dep range drift), printing the success line only if that `git checkout` actually succeeded. `package.json` / `bun.lock` dirt that pre-existed promote is deliberately left untouched with a stderr NOTE, protecting intentional operator edits. Any other dirty file, or a revert that failed, gets a loud stderr warning. Every path still exits 0 (the release is already published, tagged, and verified); the operator decides whether the remaining dirt is load-bearing.

Backstop: `publish-promote.sh` also carries an EXIT trap that prints `SR-99.0 (uncaught)` when the script dies at an **unguarded** site — a `set -e` failure with no SR wrapper. It keeps the failing command's exit code rather than inventing one, and it never fires for the guarded exits in the table above, since every deliberate exit raises a one-way guard flag first. SR-99.0 and a per-step SR-X.Y diagnostic therefore never appear together, so an SR-99.0 on a partially-complete release (50–52, 60, 70–72) is not something you will see contradicting the specific recovery those codes describe. Recovery owner is the operator: relay the trap output verbatim so the unguarded site can be wrapped, and do not rerun.

The LLM's response on any non-zero exit is the same: relay the script's stderr verbatim, identify the recovery owner from the table above, and stop. The LLM is never the recovery owner.

## File pointers

- `scripts/publish-promote.sh` — push commit + publish + push tag + poll + sanitize + reinstall + verify
- `scripts/sanitize-global.sh` — SR-7.1 / SR-7.2 (invoked by `publish-promote.sh`; sunsets when bun ≥ 1.3.14 is universal)
- `.publish-state.json` — handoff manifest at repo root, consumed and deleted by this skill
