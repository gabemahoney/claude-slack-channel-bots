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
 *
 * Bug b.42j: the rollback (SR-3.2) had no entry in the script's exit-code
 * header. The header cases read the real script as text, through
 * `tests/test-helpers/shell-header.ts`, and check the entry against the
 * rollback's code; one fixture case makes the rollback's own `git checkout`
 * fail and checks the SR-3.2 diagnostic, its place after the failing step's,
 * and the exit code the entry describes.
 *
 * Bug b.1ba: the rollback ran `git checkout -- …`, which restores from the
 * index. When the SR-5.1 release commit failed (exit 30) after `git add` had
 * staged the bump, it restored nothing, though the diagnostic said the tree
 * was rolled back. It now checks out from HEAD, restoring the tree and the
 * index. Two fixture cases fail SR-5.1 with the bump staged (a repo-local
 * pre-commit hook that fails, and a stub `git` whose `add` stages the files,
 * then fails), record what was staged when the step failed, and check exit 30
 * and a repo back at HEAD; the header case pins the rollback's command.
 *
 * Bug b.pwg: both SR-8.1 (exit 90) diagnostics say the tarball is still on
 * disk, but the exit cleanup deleted it. It is now kept once the release tag
 * lands. Two fixture cases fail SR-8.1 after the tag (a stub `sha1sum` that
 * fails, and a directory where `.publish-state.json` would be written) and
 * check exit 90 and the tarball at the path the diagnostic names; one fails
 * the SR-5.1 tag (it already exists) and checks exit 31 and the tarball gone,
 * as that diagnostic says. The success case checks the tarball is kept for
 * promote.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { hostSafeChildEnv, resolveToolDir } from './test-helpers/host-safe-env.ts'
import { headerEntries, headerExitCodes, joinCommentLines, shellCode, shellHeader } from './test-helpers/shell-header.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
/** The script under test, copied into each fixture repo's `scripts/`, where it finds the stub preflight and smoke check. */
const PREPARE_SCRIPT = join(REPO_ROOT, 'scripts', 'publish-prepare.sh')

const BUMP = 'minor'
const FROM_VERSION = '0.13.0'
const NEXT_VERSION = '0.14.0'
const TARBALL_NAME = `claude-slack-channel-bots-${NEXT_VERSION}.tgz`

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

/** The SR-3.2 rollback's command: from HEAD, so it restores the index as well as the tree (b.1ba). */
const ROLLBACK_CHECKOUT = 'git checkout HEAD -- package.json bun.lock CHANGELOG.md'

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
  /** Where a failing SR-5.1 step records the paths staged when it failed. */
  stagedAtFailure: string
}

interface FixtureOptions {
  changelog: string
  /** `fail-locked` also leaves a `.git/index.lock`, so the rollback's `git checkout` fails too. */
  pack?: 'ok' | 'fail' | 'fail-locked'
  date?: 'ok' | 'fail'
  /**
   * `commit-fails` installs a repo-local pre-commit hook that fails;
   * `add-fails` puts a stub `git` first on PATH whose `add` stages the files,
   * then fails. Both record the staged paths first. `tag-fails` tags the
   * fixture's commit `v<next version>`, so the release tag already exists.
   */
  release?: 'ok' | 'add-fails' | 'commit-fails' | 'tag-fails'
  /**
   * SR-8.1, after the release tag: `sha1-fails` puts a failing stub `sha1sum`
   * first on PATH; `write-fails` leaves a directory where `.publish-state.json`
   * is written.
   */
  manifest?: 'ok' | 'sha1-fails' | 'write-fails'
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

/** A system tool's real path, for a stub that runs it (`date` at the fixed instant, `git` around a failing `add`). */
function realTool(name: string): string {
  const dir = resolveToolDir(name)
  if (dir === undefined) throw new Error(`${name} is not on PATH`)
  return join(dir, name)
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
    stagedAtFailure: join(root, 'record', 'staged-at-failure.txt'),
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
    ...(opts.pack === 'fail' || opts.pack === 'fail-locked'
      ? [...(opts.pack === 'fail-locked' ? [': > .git/index.lock'] : []), 'echo "stub bun: pack failed" >&2', 'exit 1']
      : [
          `cp package.json ${JSON.stringify(join(root, 'pack', 'package'))}/`,
          `tar -czf ${TARBALL_NAME} -C ${JSON.stringify(join(root, 'pack'))} package`,
        ]),
  ])
  writeExec(join(fx.bin, 'date'), [
    '#!/usr/bin/env bash',
    opts.date === 'fail' ? 'exit 1' : `exec ${JSON.stringify(realTool('date'))} -d ${INSTANT} "$@"`,
  ])
  /** git's arguments that record the staged paths. */
  const recordStaged = `diff --cached --name-only > ${JSON.stringify(fx.stagedAtFailure)}`
  if (opts.release === 'add-fails') {
    const realGit = JSON.stringify(realTool('git'))
    writeExec(join(fx.bin, 'git'), [
      '#!/usr/bin/env bash',
      `[ "$1" = add ] || exec ${realGit} "$@"`,
      `${realGit} "$@" || exit 1`,
      `${realGit} ${recordStaged}`,
      'echo "stub git: add failed" >&2',
      'exit 1',
    ])
  }
  if (opts.manifest === 'sha1-fails') {
    writeExec(join(fx.bin, 'sha1sum'), ['#!/usr/bin/env bash', 'echo "stub sha1sum: failed" >&2', 'exit 1'])
  }
  if (opts.manifest === 'write-fails') {
    // Ignored, as the manifest is, so nothing else in the run sees it.
    mkdirSync(join(fx.repo, '.publish-state.json'))
  }

  git(fx, 'init', '-q')
  git(fx, 'config', 'user.name', FIXTURE_USER_NAME)
  git(fx, 'config', 'user.email', FIXTURE_USER_EMAIL)
  git(fx, 'config', 'commit.gpgsign', 'false')
  git(fx, 'add', '-A')
  git(fx, 'commit', '-q', '-m', 'init')
  if (opts.release === 'commit-fails') {
    // After the fixture's own commit, so only the release commit meets it.
    mkdirSync(join(fx.repo, '.git', 'hooks'), { recursive: true })
    writeExec(join(fx.repo, '.git', 'hooks', 'pre-commit'), ['#!/usr/bin/env bash', `git ${recordStaged}`, 'echo "stub hook: pre-commit failed" >&2', 'exit 1'])
  }
  if (opts.release === 'tag-fails') git(fx, 'tag', `v${NEXT_VERSION}`)
  return fx
}

/** The tarball's path as the script names it: under the repo's real path, which `git rev-parse --show-toplevel` gives. */
const tarballPath = (fx: Fixture): string => join(realpathSync(fx.repo), TARBALL_NAME)

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
      // The tarball is kept for promote (b.pwg); it and the manifest are ignored, as in the real repo.
      expect(existsSync(tarballPath(fx))).toBe(true)
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

// ---------------------------------------------------------------------------
// A failed release commit, with the bump staged (b.1ba)
// ---------------------------------------------------------------------------

describe('b.1ba: a failed SR-5.1 release commit rolls the bump back out of the tree and the index', () => {
  const CASES: [string, FixtureOptions['release'], string][] = [
    ["'git commit' (its pre-commit hook fails)", 'commit-fails', `SR-5.1 (release commit): 'git commit -m "Release v${NEXT_VERSION}"' did not succeed`],
    ["'git add' (it stages the files, then fails)", 'add-fails', "SR-5.1 (release commit): 'git add package.json bun.lock CHANGELOG.md' did not succeed"],
  ]

  test.each(CASES)(
    '%s: exit 30, and the repo is back at HEAD with nothing staged, as the diagnostic says',
    (_, release, diagnostic) => {
      const fx = makeFixture({ changelog: unreleasedChangelog('## Unreleased'), release })
      const head = git(fx, 'rev-parse', 'HEAD')
      const { code, stderr } = runPrepare(fx)
      expect(code).toBe(30)
      expect(stderr).toContain(diagnostic)
      expect(stderr).toContain('Working tree and index have been rolled back to HEAD')
      expect(stderr).not.toContain('SR-3.2 (rollback)')
      expect(stderr).not.toContain('SR-99.0')
      // The step failed with the bump staged, so the clean index below is the rollback's doing.
      expect(readFileSync(fx.stagedAtFailure, 'utf-8').split('\n').filter(Boolean)).toEqual(['CHANGELOG.md', 'package.json'])
      expectRolledBack(fx, head)
    },
    TEST_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// The tarball after a failure once the release commit landed (b.pwg)
// ---------------------------------------------------------------------------

describe('b.pwg: after a failure past the release commit, the tarball is on disk exactly when the diagnostic says so', () => {
  const MANIFEST_FAILURES: [string, FixtureOptions['manifest'], string][] = [
    ['sha1sum fails', 'sha1-fails', 'SR-8.1 (manifest write): could not compute sha1 of'],
    ['.publish-state.json cannot be written', 'write-fails', 'SR-8.1 (manifest write): could not write .publish-state.json.'],
  ]

  test.each(MANIFEST_FAILURES)(
    'SR-8.1, %s: exit 90, and the tarball is on disk at the path the diagnostic names',
    (_, manifest, diagnostic) => {
      const fx = makeFixture({ changelog: unreleasedChangelog('## Unreleased'), manifest })
      const { code, stderr } = runPrepare(fx)
      expect(code).toBe(90)
      expect(stderr).toContain(diagnostic)
      expect(stderr).toContain(`the tarball is on disk at ${tarballPath(fx)};`)
      expect(stderr).not.toContain('SR-99.0')
      expect(existsSync(tarballPath(fx))).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'the SR-5.1 tag fails (it already exists): exit 31, and cleanup removed the packed tarball, as the diagnostic says',
    () => {
      const fx = makeFixture({ changelog: unreleasedChangelog('## Unreleased'), release: 'tag-fails' })
      const { code, stderr } = runPrepare(fx)
      // Exit 31 comes after the pack and the tarball check, so the tarball existed.
      expect(code).toBe(31)
      expect(stderr).toContain(`SR-5.1 (release tag): 'git tag -a v${NEXT_VERSION}' did not succeed`)
      expect(stderr).toContain('no tarball is preserved on disk (cleanup removed it)')
      expect(stderr).not.toContain('SR-99.0')
      expect(existsSync(tarballPath(fx))).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// The SR-3.2 rollback's own failure (b.42j)
// ---------------------------------------------------------------------------

describe("b.42j: the SR-3.2 rollback's own checkout fails", () => {
  test(
    "after a pack failure: the SR-3.2 diagnostic follows the pack's, and the exit code is still the pack's 21",
    () => {
      const fx = makeFixture({ changelog: unreleasedChangelog('## Unreleased'), pack: 'fail-locked' })
      const { code, stderr } = runPrepare(fx)
      expect(code).toBe(21)
      expect(stderr).toContain('SR-4.1 (pack)')
      expect(stderr).toContain(`SR-3.2 (rollback): '${ROLLBACK_CHECKOUT}' failed`)
      // The failing step's own line first, then the rollback's.
      expect(stderr.indexOf('SR-4.1 (pack)')).toBeLessThan(stderr.indexOf('SR-3.2 (rollback)'))
      expect(stderr).not.toContain('SR-99.0')
      // Nothing was restored, as the diagnostic warns.
      expect(readFileSync(join(fx.repo, 'package.json'), 'utf-8')).toBe(packageJson(NEXT_VERSION))
      expect(readFileSync(join(fx.repo, 'CHANGELOG.md'), 'utf-8')).toBe(RELEASED_CHANGELOG)
    },
    TEST_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// The exit-code header documents the SR-3.2 rollback (b.42j)
// ---------------------------------------------------------------------------

describe("b.42j: publish-prepare.sh's exit-code header documents the SR-3.2 rollback", () => {
  const script = readFileSync(PREPARE_SCRIPT, 'utf-8')
  const entries = headerEntries(shellHeader(script), 'SR-3.2')
  /** The `git checkout` the rollback runs. */
  const checkout = /^rollback_working_tree\(\) \{\n[\s\S]*?\bif ! (git checkout [^;\n]+); then/m.exec(script)?.[1]

  test('one SR-3.2 entry, with no exit code of its own, naming the checkout of all three files from HEAD', () => {
    expect(entries.map((entry) => entry.code)).toEqual([null])
    expect(checkout).toBe(ROLLBACK_CHECKOUT)
    expect(joinCommentLines(entries[0]!.text)).toContain(`'${checkout}'`)
  })

  test('the failures the entry says SR-3.2 runs on are exactly the exits that call the rollback', () => {
    expect(entries).toHaveLength(1)
    const smokeCodes = headerExitCodes(shellHeader(readFileSync(join(REPO_ROOT, 'scripts', 'smoke-check.sh'), 'utf-8'))).filter((c) => c !== 0)
    const code = shellCode(script).split('\n').filter((line) => line.trim() !== '')
    const rolledBack = new Set<number>()
    code.forEach((line, i) => {
      const exit = /^\s*sr_exit\s+(\S+)/.exec(line)?.[1]
      if (exit === undefined || code[i - 1]?.trim() !== 'rollback_working_tree') return
      // The smoke check's own exit code is passed through.
      for (const c of exit === '"${SMOKE_EXIT}"' ? smokeCodes : [Number(exit)]) rolledBack.add(c)
    })
    const named = new Set([...joinCommentLines(entries[0]!.text).matchAll(/\b\d{2}\b/g)].map((m) => Number(m[0])))
    const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b)
    expect(sorted(rolledBack)).toEqual([20, 21, 22, 23, 30])
    expect(sorted(named)).toEqual(sorted(rolledBack))
  })
})
