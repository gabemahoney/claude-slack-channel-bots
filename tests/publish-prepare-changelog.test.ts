/**
 * publish-prepare-changelog.test.ts — bug b.689: `/publish prepare` versions
 * CHANGELOG.md's unreleased entry.
 *
 * Before the fix, `scripts/publish-prepare.sh` bumped package.json but never
 * touched CHANGELOG.md, so the release commit, its tag and the tarball still
 * titled the release's notes `## Unreleased`. Now, after the SR-3.1 bump and
 * before the SR-4.1 pack, the file's first `## Unreleased` heading (bare, or
 * with a trailing note) becomes `## <next version> (<UTC date>)` under a fresh
 * empty `## Unreleased`; the release commit stages CHANGELOG.md with
 * package.json and bun.lock, and the rollback restores it on every failure.
 * With no `## Unreleased` heading, or when the rewrite fails, prepare stops at
 * SR-3.1 (exit 20).
 *
 * Each case runs a copy of the real script in its own throwaway git repo (the
 * canonical setup of docs/testing-guide.md, Throwaway Git Repos), beside a
 * stub `preflight.sh` and `smoke-check.sh` that pass, with stub `npm`, `bun`
 * and `date` first on a host-safe PATH:
 * - `npm` (`npm version minor --no-git-tag-version`) writes the bumped package.json;
 * - `bun` (`bun pm pack`) copies the CHANGELOG.md in the tree when the pack
 *   runs into the fixture's record directory, outside the repo, then packs
 *   package.json (or fails, for the pack-failure case);
 * - `date` is the real `date` at a fixed instant (or fails).
 * The repo has no remote and the script pushes nothing: nothing reaches npm,
 * a registry or origin.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { hostSafeChildEnv, resolveToolDir } from './test-helpers/host-safe-env.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
/** The script under test, copied into each fixture repo's `scripts/`, where it finds the stub preflight and smoke check. */
const PREPARE_SCRIPT = join(REPO_ROOT, 'scripts', 'publish-prepare.sh')

const BUMP = 'minor'
const FROM_VERSION = '0.13.0'
const NEXT_VERSION = '0.14.0'

/** The stub `date`'s instant: 2026-01-02 in UTC, already 2026-01-03 in the fixture's time zone. */
const INSTANT = '2026-01-02T23:30:00Z'
const RELEASE_DATE = '2026-01-02'
/** UTC+9 as a POSIX TZ (no zoneinfo needed), so a heading dated from local time would read 2026-01-03. */
const FIXTURE_TZ = 'JST-9'

/** What the script and the stubs run by name, besides the stubs themselves. */
const PREPARE_TOOLS = ['bash', 'git', 'node', 'jq', 'tar', 'sha1sum', 'awk', 'dirname', 'basename', 'rm', 'cp', 'mkdir', 'cat']

/** The fixture's fake, repo-local commit identity (never a real person). */
const FIXTURE_USER_NAME = 'Fixture'
const FIXTURE_USER_EMAIL = 'test@example.invalid'

/** Keeps the host's system git configuration out, as the temp HOME keeps the global one out. */
const FIXTURE_GIT_EXTRAS: Readonly<Record<string, string>> = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1' })

const RUN_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// CHANGELOG.md fixtures, built from blocks of lines
// ---------------------------------------------------------------------------

const TITLE = ['# Changelog', '', 'Release notes for the fixture. The version number and date of each release are set when it is published.', '']
const RULE = ['---', '']
const NOTES = ['### A new thing', '', 'The notes of the release being prepared.', '']
const LAST_RELEASE = [`## ${FROM_VERSION} (2025-12-01)`, '', '- The last published release.', '']

const changelog = (...blocks: string[][]): string => blocks.flat().join('\n')

/** CHANGELOG.md before prepare: the release's notes under the unreleased `heading`. */
const unreleasedChangelog = (heading: string): string => changelog(TITLE, RULE, [heading, ''], NOTES, RULE, LAST_RELEASE)

/** CHANGELOG.md as the release commit carries it: a fresh empty unreleased entry, then the notes under the release's heading. */
const RELEASED_CHANGELOG = changelog(TITLE, RULE, ['## Unreleased', ''], RULE, [`## ${NEXT_VERSION} (${RELEASE_DATE})`, ''], NOTES, RULE, LAST_RELEASE)

/** CHANGELOG.md with no unreleased entry. */
const NO_UNRELEASED_CHANGELOG = changelog(TITLE, RULE, LAST_RELEASE)

const packageJson = (version: string): string => `${JSON.stringify({ name: 'claude-slack-channel-bots', version }, null, 2)}\n`

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** One case's fixture, every path under its own `mkdtempSync` root (removed in `afterEach`). */
interface Fixture {
  /** The empty temp HOME every child runs under. */
  home: string
  /** The throwaway git repo the script runs in. */
  repo: string
  /** The stub directory, first on the script's PATH. */
  bin: string
  /** Where the stub `bun` records CHANGELOG.md as it was when the pack ran. */
  changelogAtPack: string
}

interface FixtureOptions {
  changelog: string
  pack?: 'ok' | 'fail'
  date?: 'ok' | 'fail'
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Run git in the fixture repo under the fixture's temp HOME; returns stdout. */
function git(fx: Fixture, ...args: string[]): string {
  return execFileSync('git', ['-C', fx.repo, ...args], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: hostSafeChildEnv(fx.home, { tools: ['git'], extras: FIXTURE_GIT_EXTRAS }),
  })
}

function writeExec(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`)
  chmodSync(path, 0o755)
}

/** The real `date`, run by the stub at the fixed instant. */
function realDate(): string {
  const dir = resolveToolDir('date')
  if (dir === undefined) throw new Error('date is not on PATH')
  return join(dir, 'date')
}

/**
 * A repo holding a copy of the script, the passing stub preflight and smoke
 * check, package.json at `FROM_VERSION`, bun.lock, `opts.changelog` as
 * CHANGELOG.md and a .gitignore for the tarball and the manifest (as the real
 * repo's), all in one commit; and the stubs.
 */
function makeFixture(opts: FixtureOptions): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'b689-'))
  roots.push(root)
  const fx: Fixture = {
    home: join(root, 'home'),
    repo: join(root, 'repo'),
    bin: join(root, 'bin'),
    changelogAtPack: join(root, 'record', 'changelog-at-pack.md'),
  }
  for (const dir of [fx.home, join(fx.repo, 'scripts'), fx.bin, join(root, 'record'), join(root, 'pack', 'package')]) {
    mkdirSync(dir, { recursive: true })
  }

  copyFileSync(PREPARE_SCRIPT, join(fx.repo, 'scripts', 'publish-prepare.sh'))
  writeExec(join(fx.repo, 'scripts', 'preflight.sh'), ['#!/usr/bin/env bash', 'exit 0'])
  writeExec(join(fx.repo, 'scripts', 'smoke-check.sh'), ['#!/usr/bin/env bash', 'exit 0'])
  writeFileSync(join(fx.repo, 'package.json'), packageJson(FROM_VERSION))
  writeFileSync(join(fx.repo, 'bun.lock'), 'LOCK v1\n')
  writeFileSync(join(fx.repo, 'CHANGELOG.md'), opts.changelog)
  writeFileSync(join(fx.repo, '.gitignore'), '*.tgz\n.publish-state.json\n')

  writeExec(join(fx.bin, 'npm'), [
    '#!/usr/bin/env bash',
    `[ "$*" = "version ${BUMP} --no-git-tag-version" ] || exit 1`,
    "cat > package.json <<'EOF'",
    `${packageJson(NEXT_VERSION)}EOF`,
  ])
  writeExec(join(fx.bin, 'bun'), [
    '#!/usr/bin/env bash',
    '[ "$*" = "pm pack" ] || exit 1',
    `cp CHANGELOG.md ${JSON.stringify(fx.changelogAtPack)}`,
    ...(opts.pack === 'fail'
      ? ['echo "stub bun: pack failed" >&2', 'exit 1']
      : [
          `cp package.json ${JSON.stringify(join(root, 'pack', 'package'))}/`,
          `tar -czf claude-slack-channel-bots-${NEXT_VERSION}.tgz -C ${JSON.stringify(join(root, 'pack'))} package`,
        ]),
  ])
  writeExec(join(fx.bin, 'date'), [
    '#!/usr/bin/env bash',
    opts.date === 'fail' ? 'exit 1' : `exec ${JSON.stringify(realDate())} -d ${INSTANT} "$@"`,
  ])

  git(fx, 'init', '-q')
  git(fx, 'config', 'user.name', FIXTURE_USER_NAME)
  git(fx, 'config', 'user.email', FIXTURE_USER_EMAIL)
  git(fx, 'config', 'commit.gpgsign', 'false')
  git(fx, 'add', '-A')
  git(fx, 'commit', '-q', '-m', 'init')
  return fx
}

/** Run the fixture's copy of the script with the stubs first on PATH. */
function runPrepare(fx: Fixture): { code: number; stderr: string } {
  const r = spawnSync('bash', [join(fx.repo, 'scripts', 'publish-prepare.sh'), BUMP], {
    cwd: fx.repo,
    encoding: 'utf-8',
    timeout: RUN_TIMEOUT_MS,
    env: hostSafeChildEnv(fx.home, { tools: PREPARE_TOOLS, pathDirs: [fx.bin], extras: { ...FIXTURE_GIT_EXTRAS, TZ: FIXTURE_TZ } }),
  })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

/**
 * The repo is back where it started: no commit or tag added, and nothing
 * changed, untracked or ignored left behind (package.json, bun.lock and
 * CHANGELOG.md restored; no tarball, no manifest).
 */
function expectRolledBack(fx: Fixture, head: string): void {
  expect(git(fx, 'status', '--porcelain', '--ignored')).toBe('')
  expect(git(fx, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(fx, 'tag', '--list')).toBe('')
}

// ---------------------------------------------------------------------------
// Success: the release commit carries the versioned CHANGELOG.md
// ---------------------------------------------------------------------------

describe('b.689: prepare turns the unreleased entry into the release entry', () => {
  test.each(['## Unreleased', '## Unreleased (next minor version)'])(
    'from "%s": the tagged release commit carries a fresh unreleased entry above the dated release entry, written before the pack',
    (heading) => {
      const fx = makeFixture({ changelog: unreleasedChangelog(heading) })
      expect(runPrepare(fx)).toEqual({ code: 0, stderr: '' })

      expect(git(fx, 'log', '-1', '--format=%s').trim()).toBe(`Release v${NEXT_VERSION}`)
      expect(git(fx, 'show', 'HEAD:CHANGELOG.md')).toBe(RELEASED_CHANGELOG)
      expect(git(fx, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean)).toEqual(['CHANGELOG.md', 'package.json'])
      expect(git(fx, 'rev-parse', `v${NEXT_VERSION}^{commit}`)).toBe(git(fx, 'rev-parse', 'HEAD'))
      // Rewritten before SR-4.1, so every failure from the pack on rolls it back.
      expect(readFileSync(fx.changelogAtPack, 'utf-8')).toBe(RELEASED_CHANGELOG)
      // The tarball and the manifest are ignored, as in the real repo.
      expect(git(fx, 'status', '--porcelain')).toBe('')
    },
    TEST_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// Failures: every one leaves the repo as it was
// ---------------------------------------------------------------------------

describe('b.689: a failure at or after the CHANGELOG.md rewrite rolls it back', () => {
  const STOPS_AT_SR31: [string, FixtureOptions][] = [
    ['CHANGELOG.md has no "## Unreleased" heading', { changelog: NO_UNRELEASED_CHANGELOG }],
    ['the release date cannot be read', { changelog: unreleasedChangelog('## Unreleased'), date: 'fail' }],
  ]

  test.each(STOPS_AT_SR31)(
    '%s: exit 20 with the SR-3.1 changelog diagnostic, before the pack, package.json rolled back',
    (_, opts) => {
      const fx = makeFixture(opts)
      const head = git(fx, 'rev-parse', 'HEAD')
      const { code, stderr } = runPrepare(fx)
      expect(code).toBe(20)
      expect(stderr).toContain('SR-3.1 (changelog)')
      expect(stderr).not.toContain('SR-99.0')
      expect(existsSync(fx.changelogAtPack)).toBe(false)
      expectRolledBack(fx, head)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a pack failure after the rewrite: exit 21, and CHANGELOG.md is restored with package.json',
    () => {
      const fx = makeFixture({ changelog: unreleasedChangelog('## Unreleased'), pack: 'fail' })
      const head = git(fx, 'rev-parse', 'HEAD')
      const { code, stderr } = runPrepare(fx)
      expect(code).toBe(21)
      expect(stderr).toContain('SR-4.1 (pack)')
      // The file was rewritten when the pack ran, so the clean tree below is the rollback's doing.
      expect(readFileSync(fx.changelogAtPack, 'utf-8')).toBe(RELEASED_CHANGELOG)
      expectRolledBack(fx, head)
    },
    TEST_TIMEOUT_MS,
  )
})
