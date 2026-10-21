# Contributing

For working on CSCB itself. The engineering, testing and documentation guides are in [docs/](docs/); `CLAUDE.md` lists them.

## Installing from a local worktree

To install the version of CSCB sitting in your working copy (so the globally-linked `claude-slack-channel-bots` binary runs your local sources), use the helper script rather than `bun install -g .`:

```sh
./scripts/install-local.sh
```

`bun install -g .` (and the equivalent `bun install -g <local-path>`) is broken on Bun 1.3.13 — it inserts an invalid empty-string dependency key into `~/.bun/install/global/package.json` and then any subsequent global op fails with `error: Package "@" has a dependency loop` (upstream: [oven-sh/bun#24207](https://github.com/oven-sh/bun/issues/24207)). The script uses `bun add -g file:<abs-path>` instead, and pre-emptively strips any empty-string entry a prior `bun install -g .` may have already left behind.

Bun runs this install's postinstall in the worktree itself, a git checkout, so the postinstall writes the skeleton config files but leaves `~/.claude/skills/` alone: it makes no new link into the worktree, and a link already there keeps pointing where it did. While this install is in place, though, the global package `~/.bun/install/global/node_modules/claude-slack-channel-bots` resolves into your worktree, so a `debug-slack-channel-bots` link into it, as an install of the published package makes, reads the worktree's copy of the skill until you reinstall the published package ([Quick Start](README.md#quick-start)).

## Direct invocation for development

Skip the CLI and run the server directly with Bun for development or debugging:

```sh
bun src/server.ts
```

It follows the same [start rules](docs/reload.md#start-rules) as `start`. With no last-applied record, a missing `config.json` stops it with `[slack] Fatal: configuration error — The configuration file "<path>" does not exist. The server requires the configuration file to start.` On startup the server prints the persona count, the MCP endpoint and example config:

```
[slack] Loaded persona config: 2 persona(s)
[slack] MCP server listening on http://127.0.0.1:3100/mcp

Save this to ~/.claude/slack-mcp.json:
{
  "mcpServers": {
    "slack-channel-router": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}

Then launch Claude from a project directory with:
  claude --mcp-config ~/.claude/slack-mcp.json
```

With `SLACK_DRY_RUN=1`, `[slack] Running in dry-run mode — Slack disabled` follows the persona count.

---

## Release process

Follow `guide:release-guide.md` for authority and host restrictions before running release commands. On a switch-over host where promotion or restart is delegated, use prepare and the authorized remote steps; do not run promote or restart locally. The steps below describe the tooling, not permission to run it.

CSCB releases are cut with the `/publish` skill from a clean checkout of `main` on a dev box that has `npm login` against the publishing account. The skill bumps the version, packs and smoke-tests the release tarball, commits and tags the release, pushes to GitHub, publishes to npm, polls the registry until the new version is visible, reinstalls the just-published version on the dev box, and prints a final summary.

### Invocation

```
/publish <patch|minor|major>
```

The bump kind is **required** — there is no default. The skill exits with a usage line if the argument is missing or not one of `patch`, `minor`, `major`.

### Preflight gates

Before preparing release artifacts, `/publish` enforces eight fail-fast gates. Any failure aborts before the version is bumped, the tarball is packed, or anything is committed:

1. **Clean working tree on `main` in sync with origin/main.** No uncommitted changes; HEAD branch is `main`; `main` is exactly equal to `origin/main` after `git fetch origin`.
2. **Tests exist and pass.** At least one `*.test.ts` file under `tests/`, and `bun test`, run with a fresh scratch HOME, exits zero.
3. **Typecheck passes.** `bun run typecheck` exits zero.
4. **npm authenticated.** `npm whoami` exits zero (run `npm login` first if not).
5. **Next version not already published.** `npm view claude-slack-channel-bots@<next-version> version` must report nothing.
6. **The host's agent-director is one the client accepts (SR-2.5).** `scripts/ad-version-check.ts` finds the host's agent-director binary, reads its version and compares it with the installed agent-director client's minimum (`min_binary_version` in its `dist/version-floor.json`), the same decision as `bun run install-check` (see [Checking your agent-director install](docs/agent-director.md#checking-your-agent-director-install)). A missing binary, a version that cannot be read, a binary below the client's minimum or a minimum that cannot be read stops the release with preflight exit 15 (`AD_VERSION_CHECK_FAIL_EXIT_CODE`) and one `SR-2.5 (preflight)` line naming the docs/migration.md section "Switching over to agent-director Phase 1"; for a missing binary or one below the client's minimum it names that section's block ["The publishing host"](docs/migration.md#the-publishing-host). A binary at or above the client's minimum but below CSCB's Phase 1 floor passes, with an `SR-2.5 (preflight) NOTE` on stderr that the server will not start on it until agent-director Phase 1 is installed.
7. **No stranded work under the audit contract.** `scripts/audit-finished-tickets.sh` must exit zero before `/ci` runs. Audit exit 1 blocks preflight with exit 16; setup failure (exit 2 or another error) blocks with exit 17. Run from the canonical checkout beside the ticket stores. The [audit contract](#stranded-work-audit) explains its literal status filter and Apiary limitation; a pass does not establish that `done` work is on main. Investigate every finding; do not assume a standing clean baseline.
8. **`/ci` integration suite passes.** The full Docker-based integration test suite is run via the `/ci` skill and must report PASS. **`/ci` is mandatory and has no opt-out flag** — release without an unbroken integration run is not possible through this skill.

### Additional release checks

Run the frozen-lockfile install, unit suite with the scratch HOME described in [tests/README.md](tests/README.md#running-the-unit-suite), and typecheck. Docker must be available for `/ci`; a host without the pinned base image also needs `CSCB_AD_SRC_DIR` as [docker/README.md](docker/README.md) describes. Supply integration credentials through `CI_ANTHROPIC_*` as the `/ci` skill specifies, never raw host credentials.

For a change to delivery, tag description or tested agent versions, the [heavy leg](tests/README.md#heavy-inventory-and-invocation) must pass on the final build. Check that result separately: successful publish preflight does not establish it.

Release notes follow [the documentation guide](docs/doc-writing-guide.md#release-notes-changelogmd). Record user-visible/breaking changes in the change that makes them. Keep one first `## Unreleased`; prepare versions it. The maintained migration runbooks and frozen CHANGELOG copies follow that guide's distinct rules.

### What happens during a release

After all gates pass, the skill, in this order:

1. Bumps `package.json` and `bun.lock` to `<next-version>` (no commit, no tag yet), and turns `CHANGELOG.md`'s `## Unreleased` heading into `## <next-version> (<UTC date>)` under a fresh empty `## Unreleased` entry. With no `## Unreleased` heading, the release stops here and the working tree is rolled back.
2. Packs the release tarball with `bun pm pack` and verifies its internal version matches.
3. Scratch-installs the tarball into a temp `BUN_INSTALL` and runs the bin smoke check (non-zero exit + `Usage:` in stderr). Any failure here rolls back the working tree and aborts — no commit, no push, no publish.
4. Creates the `Release v<version>` commit (`package.json`, `bun.lock` and `CHANGELOG.md`) and the annotated `v<version>` tag locally.
5. Pushes the release commit to `origin/main`.
6. Publishes the smoke-tested tarball with `npm publish <tarball-path>` (the smoke-tested artifact bytes — not a repack from CWD).
7. Pushes the `v<version>` tag to `origin`, bringing GitHub and npm into agreement.
8. Polls the npm registry every 5 seconds for up to 10 minutes until the new version is visible, printing a progress line every ~30 seconds. npm propagation commonly takes a few minutes, so a multi-minute wait here is normal.
9. Sanitizes the bun-1.3.13 empty-string-dependency-key poison from the global `package.json` (see [Installing from a local worktree](#installing-from-a-local-worktree)), removes any pre-existing global install, then runs `bun install -g claude-slack-channel-bots@<version>` — the exact command an end user would run — and verifies the installed bin resolves under `~/.bun/install/global/` at the published version. If the `claude-slack-channel-bots` on PATH resolves somewhere else (an install in another bun prefix shadowing this one), the diagnostic names the shadowing path, the symlink chain, and the manual fix.
10. Trusts the package if the global manifest does not already (`bun pm -g trust`) and checks that the postinstall's `config.json` in the state directory and `~/.claude/slack-mcp.json` exist. The state directory is `SLACK_STATE_DIR` when it is set, else `~/.config/claude-slack-channel-bots`, except that until the server's first start on the new default has moved the old directories the check looks in the old one that matters, `~/.config/cscb` first, then `~/.claude/channels/slack`: while a live server's `server.pid` is there, or while it holds the real `config.json` (or a `server.pid`) and `~/.config/claude-slack-channel-bots` holds none. A missing file is a warning, not a release failure.
11. Prints a success summary identifying the published version, npm URL, GitHub release tag URL, resolved local install path, and the next-operator-action command.

### After the skill exits

The dev box now has the freshly-published version installed globally as a real copy, but the running CSCB daemon is still on the prior version. Where `guide:release-guide.md` authorizes a local restart, swap the daemon over; otherwise hand installation and restart to its designated operator:

```sh
claude-slack-channel-bots clean_restart
```

This gracefully exits the managed Claude Code sessions, stops and restarts the server on the new binary, and brings each session back up. See [`clean_restart`](docs/cli.md#claude-slack-channel-bots-clean_restart) for full behavior.

### Stranded-work audit

The read-only `scripts/audit-finished-tickets.sh` reads ticket Markdown in `Bugs/`, `Ideas/Plans/` and top-level `Ideas/` (excluding `Plans/` there), relative to the script's checkout. A repo argument changes the git history inspected, not where stores are located. It requires those stores, a git repo and `main`; missing setup exits 2. Findings exit 1; no findings exits 0. It fetches nothing and mutates neither tickets nor git.

**Apiary limitation:** ticket selection and ticket-linked branch checks compare status with the literal `finished`. They do not check `done` or `invalid`. Apiary v4.0.3 uses `draft`, `defined`, `active`, `done` and Bug-only `invalid`, and the orchestrator accepts Ideas/Bugs as `done` before `teardown-worktree` merges them. The script's closure-after-merge assumption cannot define Apiary acceptance. Its pass leaves accepted `done` work unaudited; reconcile accepted work against main separately before release and report this tooling mismatch. Do not use `finished` as an Apiary status or falsify a closure note to appease the gate.

For a selected ticket, the script first accepts a genuine ID-referencing main commit (excluding its disclaimer patterns) or a four-significant-word title match in a main commit subject. Otherwise it requires a recognized closure marker/reason. Record actual landing SHAs, or the truthful artifact/reason and a pointer to superseding work; these heuristics are not substitutes for that evidence.

| Resolution | Marker or accepted phrases |
|---|---|
| Change outside this repository | `## +closed:out-of-repo <path>`; the operand is required and names the changed artifact, not a path the script checks on disk |
| Documents outside every git repository | `## +closed:docs-only`; loose prose does not qualify |
| Could not be observed | `no-repro`, `no repro`, `not reproducible`, `cannot reproduce` |
| Observed, fix declined | `won't fix`, `won't-fix`, `wont fix`, `wont-fix` (straight or typographic apostrophe) |
| Observed, behavior is correct | `not a bug`, `not-a-bug`, `by design`, `works as intended` |
| Covered elsewhere | `closed as superseded`, `closed as abandoned`, `superseded by`, `fully satisfied by`, `already satisfied`; point to that work |

Reason phrases match case-insensitively as word-bounded body text, even incidentally. The explicit markers are anchored headings (the implementation accepts one or more `#`); a bare `Closed` heading is insufficient. Its anti-marker pattern (`pending[ -]?(merge|release)`, `fixed on branch`, `on branch b.`) disqualifies all closure markers, but is tested only after main-commit/title evidence has failed. Pick the true verdict: inability to reproduce, declined fix and correct behavior are different claims.

The branch pass flags unmerged heads associated with literal `finished` tickets, and unmerged names containing no recognized ticket-ID token. A syntactically recognized ID with no matching ticket is not flagged by that branch; neither is a branch for a `done` ticket. Check the actual output, not its broader “no known ticket” wording. Resolve stranded branches by merging, or by an authorized owner publishing an `archive/<name>` tag at the head before removing the remote ref and pruning. Publishing tags/deleting remote refs require the release guide's authority.

### Release rollback and install boundaries

Prepare rolls `package.json`, `bun.lock` and `CHANGELOG.md` back from HEAD on bump/pack/smoke failures and failed release add/commit (exit 30), restoring the index too. It does not roll back preflight, tag (31) or manifest (90) failures. A failed rollback emits its own diagnostic and retains the original failure's exit code. Inspect the state and follow the recovery below; do not assume the rollback succeeded.

Push the release commit, publish the exact smoke-tested tarball, then push the tag. Never repack for publication or push the tag before npm succeeds, so the remote tag does not promise an unpublished version.

Promote's expected global prefix is `${BUN_INSTALL:-$HOME/.bun}/install/global`; it need not be the only prefix. Its shared shadow report warns before install (SR-7.0) and fails verification with exit 72 if another prefix still wins afterward (SR-7.4). That failure does not undo an already published release. Promote reports another prefix; it never deletes it. Remediation must preserve every `install/cache` and repoint the PATH shim rather than delete it. `sanitize-global.sh` is best-effort, canonical-prefix-only and always exits zero.

Postinstall trust verification is non-fatal: trust when needed, then check the config and MCP scaffolds using the CLI-compatible state-directory resolver. Missing config prevents start; missing MCP config prevents default persona connections. Skill-link convenience is not a server prerequisite. Follow host-specific release guidance before any global reinstall or restart.

### Diagnostic contract in the release scripts

Every non-zero exit from a release script must carry an `SR-X.Y` diagnostic on stderr naming the failing step and the operator's recovery action. The driving LLM relays that stderr verbatim and stops, so the stderr is the whole artifact the human gets — it must be unambiguous.

Two mechanisms enforce this in `publish-prepare.sh`, `publish-promote.sh`, `preflight.sh`, `smoke-check.sh`, and `install-local.sh`; new code in those scripts must honor both:

- **Guarded exits.** Print the `SR-X.Y` line, then exit via `sr_exit <code>` rather than a bare `exit <code>`. `sr_exit` raises a one-way `SR_GUARDED_EXIT` flag before exiting, which tells the backstop this failure is already described.
- **The SR-99.0 backstop.** Each script installs an EXIT trap that prints `SR-99.0 (uncaught)` when it exits non-zero *with the flag unset* — i.e. a `set -e` death at a site nobody wrapped. It preserves the failing command's exit code and reports the command text, so the unguarded site can be found and wrapped.

Consequences worth knowing before editing these scripts:

- Do not use a list of accepted exit codes instead of the flag. Such a list silently rots the moment a new SR code is added; the flag needs no bookkeeping.
- `sr_exit` must run in the script's own shell. Inside a subshell or command substitution the flag would be set in the child only, and the backstop would fire anyway. A helper that must fail from a subshell should `return 1` and let its call site do `|| sr_exit <code>`.
- A correct run therefore produces exactly one SR block per failure (a failed SR-3.2 rollback is a second failure, with its own block after the failing step's). Seeing `SR-99.0` alongside a per-step `SR-X.Y` means the guard was bypassed, not that two things failed.

`scripts/sanitize-global.sh` is exempt: all of its deliberate exits are 0 (it is belt-and-suspenders by design), so it has nothing to guard. `scripts/install-local.sh` is a developer helper outside the release path, so its one guarded failure prints an `[install-local]` diagnostic rather than an `SR-X.Y` one — but it still routes that exit through `sr_exit`, for the same reason.

### Recovery actions by failure mode

Every failure path in `/publish` emits a diagnostic identifying the failing SR sub-step and the operator's recovery action — the operator should not need to read the skill source. Common modes:

| Failure | Diagnostic prefix | Recovery |
|---|---|---|
| Dirty tree / wrong branch / diverged main | `SR-2.1 (preflight)` | Commit/stash, checkout main, or sync with `git pull --ff-only origin main`; rerun `/publish`. |
| Lockfile out of sync | `SR-2.2 (preflight)` | Run `bun install`, commit the updated `bun.lock` to main, rerun. |
| No tests / failing tests / failing typecheck | `SR-2.3 (preflight)` | Add or fix tests / types, commit to main, rerun. |
| `mktemp -d` could not make the suite's scratch HOME | `SR-2.3 (preflight)` | Make sure the temp directory (`TMPDIR`, else `/tmp`) exists and is writable, rerun. |
| The test preload guard refused to start `bun test` (its exit 78; the guard's `host-safety preload: refusing to start` line above names the rule and the home; commonly a `TMPDIR` inside the home directory) | `SR-2.3 (preflight)` | Point `TMPDIR` at a directory outside the home (or unset it to use `/tmp`), rerun. |
| `npm whoami` fails | `SR-2.4 (preflight)` | `npm login`, rerun. |
| Version already on npm | `SR-2.4 (preflight)` | Pull latest main (or pick a larger bump), rerun. |
| npm registry is non-canonical (would publish to the wrong registry) | `SR-2.4a (preflight)` | `npm config set registry https://registry.npmjs.org/` (or confirm intent — e.g., this is deliberately a fork), rerun. |
| `bun pm whoami` fails (no bun identity for the post-publish `bun install -g`, SR-7.3) | `SR-2.4b (preflight)` | `bun pm login` (note: bun's auth is separate from npm's; both must be in place), rerun. |
| Host's agent-director binary not found, its version cannot be read (no version, a version the client's strict rule cannot parse, or the client could not reach the binary), or it is below the installed agent-director client's minimum; or that minimum cannot be read (no client installed, or its `version-floor.json` missing or unparseable); or `scripts/ad-version-check.ts` did not run to completion | `SR-2.5 (preflight)` (exit 15) | Follow the diagnostic's operator recovery. The host's agent-director is changed only by the docs/migration.md section "Switching over to agent-director Phase 1"; after that change, rerun. An unreadable client minimum names `min_binary_version` in `agent-director/dist/version-floor.json` and what was found; SR-2.2 has already installed what `bun.lock` pins, so rerunning as is will not change it: report the output verbatim and assess the installed agent-director client before any rerun. When the check did not run to completion, report its output verbatim; the check's state is indeterminate, so do not rerun until the operator has assessed. |
| `/ci` not runnable or non-PASS | `SR-2.7 (/ci gate)` | Start Docker / supply `CI_ANTHROPIC_*` as the `/ci` skill requires / on a host without `cscb-ci-base:v8`, export `CSCB_AD_SRC_DIR` (see `docker/README.md`'s "How the base gets the release"), or fix the integration regression, then rerun. |
| Stranded work under the audit's literal `finished` filter (see [audit contract](#stranded-work-audit)) — audit exit 1 | `SR-2.6 (preflight)` (exit 16) | For each flagged ticket, land its fix on main or explicitly close it (a stated reason — no-repro / won't-fix / not-a-bug / by design / works as intended / superseded / abandoned / satisfied-by-other-work, with a pointer to where the work lives — or an anchored `## +closed:out-of-repo <path>` / `## +closed:docs-only` heading); for each flagged branch, merge it, or abandon it by pushing an `archive/<name>` tag at its head **before** deleting the remote ref. Record the truthful resolution under the owning workflow, then rerun; do not change Apiary statuses to satisfy the audit. The gate is read-only — it never mutates tickets or git. |
| Audit could not run — the hives (Bugs, Plans, Ideas), a git repo, or a `main` ref were not locatable from this checkout (e.g. a throwaway `/tmp` clone with no hives beside it) — audit exit 2 or other. This is a **setup failure, not stranded work**; the release is still blocked (fail closed). | `SR-2.6 (preflight)` (exit 17) | Rerun `/publish` from the canonical checkout that sits beside the hives (the main working clone), not a throwaway/`/tmp` clone. |
| Bump / pack / scratch-install / smoke failure | `SR-3.1` or `SR-4.x` | Working tree is rolled back automatically. Investigate the upstream error, then rerun. |
| `CHANGELOG.md` has no `## Unreleased` heading, or its rewrite to the release's heading failed (`date -u` or `node` failed) | `SR-3.1 (changelog)` (exit 20) | Working tree is rolled back automatically (`package.json`, `bun.lock` and `CHANGELOG.md`). With no heading, put this release's notes under an `## Unreleased` heading as the file's first `##` entry, commit that to main, then rerun. Otherwise investigate the error above, then rerun. |
| The rollback after a prepare failure itself failed (its `git checkout HEAD -- package.json bun.lock CHANGELOG.md` errored) | `SR-3.2 (rollback)`, after the failing step's own diagnostic; no exit code of its own, so the exit code is that step's | The working tree may still hold the bumped version or the rewritten `CHANGELOG.md` heading, and after a failed `git add` or `git commit` the index may still have them staged, even though the step's own line says they were rolled back. Run `git status` to inspect, then `git checkout HEAD -- package.json bun.lock CHANGELOG.md` by hand, then follow the failing step's recovery. |
| The release commit's `git add` or `git commit` failed (e.g. a pre-commit hook) | `SR-5.1 (release commit)` (exit 30) | Working tree and index are rolled back to HEAD automatically (`package.json`, `bun.lock` and `CHANGELOG.md` restored and unstaged); nothing is committed. Inspect `git status` and fix the cause, then rerun. |
| The release tag's `git tag -a` failed | `SR-5.1 (release tag)` (exit 31) | The release commit is on local `main`, not pushed; no manifest was written, and cleanup removed the packed tarball. `git reset --hard HEAD~1`, then rerun. |
| `.publish-state.json` could not be written, or the tarball's sha1 could not be computed | `SR-8.1 (manifest write)` (exit 90) | The release commit and tag are on local `main`, nothing is pushed, and the smoke-tested tarball is kept on disk at the path the diagnostic names (cleanup removes it only on a failure before the tag lands, exit 31 included). Follow the diagnostic: roll back with `git reset --hard origin/main && git tag -d v<version> && rm -f <tarball>`, then rerun; after a failed write the diagnostic also allows writing `.publish-state.json` by hand instead. |
| `git push origin main` failure | `SR-5.2 (push commit)` | The release commit + tag are local-only; resolve the push issue and re-run `git push origin main` manually + `npm publish <tarball>` + `git push origin v<version>`, OR `git reset --hard HEAD~1 && git tag -d v<version>` to abandon and rerun `/publish`. |
| `npm publish` failure | `SR-5.3 (npm publish)` | Commit is on origin; npm does not have the version. Fix the publish issue (e.g., `npm login`) and re-run `npm publish <tarball>` manually, then `git push origin v<version>`. The smoke-tested tarball is preserved in CWD for the manual re-publish. |
| `git push origin v<version>` failure | `SR-5.4 (push tag)` | The release is otherwise complete — only the tag is missing. Resolve the push issue and re-run `git push origin v<version>` manually. Do not rerun `/publish`. |
| Registry not visible within 10 minutes | `SR-6.1 (registry verification)` | Propagation lag only; the release succeeded. Re-confirm with `npm view claude-slack-channel-bots@<version> version`, then proceed manually with `bun install -g` and `clean_restart`. |
| Post-publish install failure | `SR-7.3 (post-publish install)` | Dev box has no global install. Re-run `bun install -g claude-slack-channel-bots@<version>` manually until it succeeds, then `clean_restart`. |
| Post-publish verification failure — wrong version, or bin not on PATH | `SR-7.4 (post-publish verification)` | The release is published; only the local install is wrong. `bun remove -g claude-slack-channel-bots && bun install -g claude-slack-channel-bots@<version>`, then `clean_restart`. |
| Post-publish verification failure — the bin on PATH resolves **outside** `${BUN_INSTALL:-$HOME/.bun}/install/global/` (an install in another bun prefix, or a worktree symlink farm, shadowing this one) | `SR-7.4 (post-publish verification)`, exit 72 — preceded by an `SR-7.0` warning at the top of Phase 7 | The release is published **and correctly installed**; only PATH resolution is wrong, so reinstalling changes nothing. Follow the shadow report in the diagnostic verbatim: it names the shadowing path, the symlink chain, and the exact `rm -rf <stale-prefix>/install/global` + `ln -sfn` repoint + `bun pm -g trust` sequence. Never touch any `install/cache` directory; repoint the PATH shim rather than deleting it. Then `clean_restart` and delete the manifest. Do not rerun `/publish promote`. |
| Postinstall did not run — `config.json` / `slack-mcp.json` still missing after install (fresh global prefix with no `trustedDependencies` entry) | `SR-7.4b (postinstall trust)` — **warning only, exit code unchanged** | The release is fully delivered. Run `bun pm -g trust claude-slack-channel-bots` and confirm a `✓ [postinstall]` line, then re-check the listed paths. `trust` swallows the postinstall's stdout, so the files existing on disk is the observable proof — not the script's log. |
| A release script died at a site with no SR wrapper (backstop) | `SR-99.0 (uncaught)` | State of the release is indeterminate. Relay the trap output verbatim — it names the script and the failing command — and do not rerun `/publish` until a human has assessed. Wrap the identified site with a real SR-X.Y diagnostic before the next release. |
