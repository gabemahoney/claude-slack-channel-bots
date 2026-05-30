---
name: publish-promote
description: Irreversible half of a release — read .publish-state.json, push commit, npm publish, push tag, poll registry, sanitize globals, reinstall, verify. Idempotent on retry.
user-invocable: true
allowed-tools: [Bash, Read]
---

# /publish promote

Irreversible-but-short half of a `claude-slack-channel-bots` release. Reads `.publish-state.json` (written by `/publish prepare`), verifies the local state still matches what prepare produced, then pushes the commit, publishes the tarball to npm, pushes the tag, polls the registry, sanitizes the global package.json, reinstalls, and verifies.

Idempotent where possible: an already-pushed commit, an already-published version (with matching `dist.shasum`), and an already-pushed tag are all treated as successful skips. The post-install + verify always runs.

## Skill Contract — HARD RULES

The shell script `scripts/publish-promote.sh` is this skill's body. It is the ONLY authorized side-effecting command. When any precondition or SR-X.Y guard fires, the script exits non-zero with a diagnostic on stderr describing the failure state and operator-facing recovery options.

The LLM driving /publish promote MUST NOT, in response to any failure:

- Execute side-effecting commands outside the skill's own script. No manual `git push`, `git pull`, `git reset`, `git tag`, `npm publish`, `npm login`, `bun install -g`, no manual edits to `package.json`, `bun.lock`, the global package.json, `.publish-state.json`, or any config file. This applies even when the failure prose *names* the command — the named command is for the operator, not the LLM.
- Invoke /publish promote a second time within a session without first either (a) the operator fixing the precondition that the failure prose names, or (b) filing a bee against the skill and waiting for human guidance. The LLM must not "try again to see if it works now" or rerun /publish promote after performing its own out-of-band fix. Note: /publish promote IS designed to be safely rerun by the operator after they resolve a transient failure (push/publish/tag are idempotent), but that decision belongs to the operator, not the LLM.
- Paraphrase, omit, soften, or "interpret around" an SR-X.Y diagnostic. Report the failure verbatim to the orchestrator/operator and stop.

"The operator" means the human who invoked /publish promote (or, when run via an orchestrator, the human responsible for that orchestrator). Every "Operator recovery:" block in script stderr addresses the operator. The LLM's only job on a non-zero exit is to surface the stderr verbatim and stop. These rules are non-negotiable; if a rule appears wrong in context, file a bee against this contract rather than bend it.

## Invocation

```
/publish promote
```

No arguments. The bump kind, target version, commit SHA, tag, and tarball path are all read from `.publish-state.json`. If the manifest is missing, the script refuses with an explicit "run /publish prepare first" message.

## Procedure

1. **Run `bash scripts/publish-promote.sh`.** The script reads `.publish-state.json`, verifies every precondition (manifest present and well-formed, HEAD matches, tag exists locally, package.json version matches, tarball file exists on disk with matching sha1), then idempotently pushes the commit, publishes the tarball, pushes the tag, polls the registry, sanitizes the global package.json, removes any prior global install, reinstalls from npm, and verifies. On exit 0, relay the success summary the script printed to stdout (the manifest has been deleted — the release is complete). On any non-zero exit, relay stderr verbatim and stop.

The LLM driving /publish promote MUST NOT execute any bash command outside of `bash scripts/publish-promote.sh`. Recovery commands named in stderr are for the operator.

## Exit code → operator recovery

| Code | SR | Failure | Recovery owner |
|------|----|---------|----------------|
| 0    | SR-9.1 | release complete; manifest deleted | — |
| 1    | precondition | manifest missing, manifest corrupted, HEAD ≠ manifest commit, tag missing/wrong, package.json drift, tarball missing/sha1 mismatch, or smoke_passed=false | operator: follow the specific prose in stderr — usually delete `.publish-state.json` and rerun `/publish prepare <bump>` |
| 50   | SR-5.2 | `git push origin main` failed | commit + tag local; nothing pushed/published; manifest preserved; operator resolves push and reruns /publish promote (idempotent), OR rolls back per stderr |
| 51   | SR-5.3 | `npm publish` failed, OR version exists on npm with mismatched dist.shasum | commit IS on origin/main; npm state depends on subcase (see stderr); manifest preserved; operator fixes and reruns /publish promote, OR follows the content-drift recovery in stderr |
| 52   | SR-5.4 | `git push origin <tag>` failed | npm has the release; commit on origin/main; only the tag is missing; operator pushes the tag manually then deletes the manifest. Do NOT rerun /publish promote unless the tag is still confirmed missing on origin. |
| 60   | SR-6.1 | registry did not surface new version within 60s | release succeeded; propagation lag only; operator confirms with `npm view`, runs `bun install -g` + `clean_restart` manually, then deletes the manifest. Do NOT rerun /publish promote. |
| 71   | SR-7.3 | post-publish `bun install -g` failed | release IS published; dev box has no global install; manifest preserved; operator reruns `bun install -g` manually, then deletes the manifest. Do NOT rerun /publish promote. |
| 72   | SR-7.4 | post-publish verification failed (bin missing on PATH, resolved outside global prefix, package.json missing, or installed version stale) | release IS published; manifest preserved; operator follows the recovery in stderr; do NOT rerun /publish promote. |

The LLM's response on any non-zero exit is the same: relay the script's stderr verbatim, identify the recovery owner from the table above, and stop. The LLM is never the recovery owner.

## File pointers

- `scripts/publish-promote.sh` — push commit + publish + push tag + poll + sanitize + reinstall + verify
- `scripts/sanitize-global.sh` — SR-7.1 / SR-7.2 (invoked by `publish-promote.sh`; sunsets when bun ≥ 1.3.14 is universal)
- `.publish-state.json` — handoff manifest at repo root, consumed and deleted by this skill
