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

CSCB releases are cut with the `/publish` skill from a clean checkout of `main` on a dev box that has `npm login` against the publishing account. The skill bumps the version, packs and smoke-tests the release tarball, commits and tags the release, pushes to GitHub, publishes to npm, polls the registry until the new version is visible, reinstalls the just-published version on the dev box, and prints a final summary.

### Invocation

```
/publish <patch|minor|major>
```

The bump kind is **required** — there is no default. The skill exits with a usage line if the argument is missing or not one of `patch`, `minor`, `major`.

### Preflight gates

Before any side-effecting step runs, `/publish` enforces eight fail-fast gates. Any failure aborts before the version is bumped, the tarball is packed, or anything is committed:

1. **Clean working tree on `main` in sync with origin/main.** No uncommitted changes; HEAD branch is `main`; `main` is exactly equal to `origin/main` after `git fetch origin`.
2. **Tests exist and pass.** At least one `*.test.ts` file under `tests/`, and `bun test`, run with a fresh scratch HOME, exits zero.
3. **Typecheck passes.** `bun run typecheck` exits zero.
4. **npm authenticated.** `npm whoami` exits zero (run `npm login` first if not).
5. **Next version not already published.** `npm view claude-slack-channel-bots@<next-version> version` must report nothing.
6. **The host's agent-director is one the client accepts (SR-2.5).** `scripts/ad-version-check.ts` finds the host's agent-director binary, reads its version and compares it with the installed agent-director client's minimum (`min_binary_version` in its `dist/version-floor.json`), the same decision as `bun run install-check` (see [Checking your agent-director install](docs/agent-director.md#checking-your-agent-director-install)). A missing binary, a version that cannot be read, a binary below the client's minimum or a minimum that cannot be read stops the release with preflight exit 15 (`AD_VERSION_CHECK_FAIL_EXIT_CODE`) and one `SR-2.5 (preflight)` line naming the docs/migration.md section "Switching over to agent-director Phase 1"; for a missing binary or one below the client's minimum it names that section's block ["The publishing host"](docs/migration.md#the-publishing-host). A binary at or above the client's minimum but below CSCB's Phase 1 floor passes, with an `SR-2.5 (preflight) NOTE` on stderr that the server will not start on it until agent-director Phase 1 is installed.
7. **No stranded finished work.** `scripts/audit-finished-tickets.sh` must exit zero. It flags any `finished` ticket whose fix is neither on `main` nor explicitly closed — closure means either a stated reason (no-repro / won't-fix / not-a-bug / by design / works as intended / superseded / abandoned / satisfied by other work) or one of the anchored headings `## +closed:out-of-repo <path>` (fix landed outside this repo; the path names the artifact) and `## +closed:docs-only` (product lives outside any git repo) — any unmerged branch tied to a finished ticket, and any unmerged branch that references no known ticket at all. A release cannot ship while a fix is silently stranded on a dead branch. The gate is read-only — it never mutates tickets or git. This gate runs in Phase 1 preflight, **before** the `/ci` gate below, so a stranded-work failure aborts the release before the Docker suite ever runs. The gate splits its failure by the audit's exit code: audit exit 1 (stranded work) → preflight exit 16; audit exit 2 (setup failure — the Bugs/Plans/Ideas hives, a git repo, or a `main` ref were not locatable from this checkout, e.g. a throwaway `/tmp` clone) → preflight exit 17, whose fix is to rerun `/publish` from the canonical checkout that sits beside the hives. **This gate is green today — it exits zero with no findings.** There is no known expected debt in either class, so a non-zero result is a new, real finding to investigate before releasing. Do not re-list findings here — the audit's own output is the inventory.
8. **`/ci` integration suite passes.** The full Docker-based integration test suite is run via the `/ci` skill and must report PASS. **`/ci` is mandatory and has no opt-out flag** — release without an unbroken integration run is not possible through this skill.

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

The dev box now has the freshly-published version installed globally as a real copy, but the running CSCB daemon is still on the prior version. Swap the daemon over:

```sh
claude-slack-channel-bots clean_restart
```

This gracefully exits the managed Claude Code sessions, stops and restarts the server on the new binary, and brings each session back up. See [`clean_restart`](docs/cli.md#claude-slack-channel-bots-clean_restart) for full behavior.
