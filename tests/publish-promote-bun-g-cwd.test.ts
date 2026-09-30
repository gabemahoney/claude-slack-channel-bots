/**
 * publish-promote-bun-g-cwd.test.ts — guard + behavioral tests for bug b.bpp.
 *
 * Bug b.bpp: `scripts/publish-promote.sh` does `cd "${REPO_ROOT}"` at the top,
 * so the post-publish `bun remove -g` / `bun install -g` calls ran with the
 * CSCB project as CWD. Bun, invoked from a directory whose package.json is
 * named "claude-slack-channel-bots", resolves the LOCAL dependency graph
 * during a global install and writes newer matching transitive-dep ranges back
 * into the local package.json + bun.lock — leaving the working tree dirty after
 * every release.
 *
 * The primary fix wraps every EXECUTED `bun -g` site in a `(cd "$HOME" && bun … -g …)`
 * subshell so bun has no local package.json to side-effect. SR-7.5 is a
 * belt-and-suspenders net: after verify, promote-INDUCED package.json/bun.lock
 * dirt (dirty now but clean at script start) is reverted; pre-existing operator
 * dirt and any other-file dirt are left alone with a loud stderr warning; every
 * arm keeps exit 0.
 *
 * Two kinds of test live here:
 *   - Static parser guard for the $HOME-subshell wrap (parses script text, never
 *     executes the publish script or any real `bun -g`).
 *   - A behavioral test of the SR-7.5 revert logic, extracted into a small bash
 *     harness and exercised against a real temp git repo. It asserts the revert
 *     EFFECT on files (what survives vs. gets reverted), never exact log phrasing.
 *
 * Every child process (git and the bash harness) gets its environment from
 * `hostSafeChildEnv` with the fixture's own temp HOME and
 * `GIT_CONFIG_NOSYSTEM=1`, so no host git configuration (global or system),
 * credential or agent-director install reaches it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const SCRIPT_REL = 'scripts/publish-promote.sh'
const SCRIPT_ABS = join(REPO_ROOT, SCRIPT_REL)

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Find every EXECUTED `bun … -g …` site in a shell script, one per line.
 *
 * Strips `#` comments, then blanks out the contents of double- and single-
 * quoted strings before matching. Blanking string bodies is what removes the
 * `bun install -g …` text embedded in `echo "… 'bun install -g …' …"` recovery
 * messages, so only real command invocations survive.
 *
 * Returns the trimmed original (pre-blanking) source lines that contain an
 * executed `bun -g`, so callers can assert on the real syntax (e.g. the
 * `(cd "$HOME" && …)` wrap, which itself lives partly inside a "$HOME" string).
 */
function findExecutedBunGSites(script: string): string[] {
  const sites: string[] = []
  for (const raw of script.split('\n')) {
    const noComment = raw.replace(/#.*$/, '')
    const noDouble = noComment.replace(/"(?:[^"\\]|\\.)*"/g, '""')
    const stripped = noDouble.replace(/'(?:[^'\\]|\\.)*'/g, "''")
    if (/\bbun\b[^\n]*?\s-g\b/.test(stripped)) {
      sites.push(raw.trim())
    }
  }
  return sites
}

/** True iff the line wraps its executed `bun -g` in a `(cd "$HOME" && …)` subshell. */
function isHomeWrapped(line: string): boolean {
  return /\(\s*cd\s+"\$HOME"\s+&&\s+bun\b[^)]*?\s-g\b/.test(line)
}

function readFixedScript(): string {
  return readFileSync(SCRIPT_ABS, 'utf-8')
}

// ---------------------------------------------------------------------------
// Static parser guard — the $HOME-subshell wrap (primary fix)
// ---------------------------------------------------------------------------

describe('b.bpp: publish-promote.sh isolates every executed `bun -g` in a $HOME subshell', () => {
  test('at least one executed `bun -g` site exists (parser sanity)', () => {
    const sites = findExecutedBunGSites(readFixedScript())
    expect(sites.length).toBeGreaterThanOrEqual(2)
  })

  test('every executed `bun -g` site is wrapped in `(cd "$HOME" && bun … -g …)`', () => {
    const sites = findExecutedBunGSites(readFixedScript())
    const unwrapped = sites.filter((line) => !isHomeWrapped(line))
    expect(unwrapped).toEqual([])
  })

  test('guard has teeth: matcher flags naked pre-fix `bun -g` sites and excludes echo strings', () => {
    // Self-contained pre-fix fixture: two representative EXECUTED sites (naked,
    // unwrapped) plus one echo string that merely mentions `bun install -g`.
    // The matcher must flag exactly the two executed sites, not the echo.
    const removeLine =
      'bun remove -g claude-slack-channel-bots > /dev/null 2>&1 || true'
    const installLine =
      'if ! bun install -g "claude-slack-channel-bots@${NEXT_VERSION}"; then'
    const echoLine =
      `  echo "if this fails, run 'bun install -g claude-slack-channel-bots' by hand" >&2`
    const preFixFixture = [removeLine, installLine, echoLine].join('\n')

    const preSites = findExecutedBunGSites(preFixFixture)
    // Exactly the two executed sites are flagged; the echo mention is excluded.
    expect(preSites).toEqual([removeLine, installLine])
    // And both flagged sites are unwrapped (proving the matcher has teeth).
    const preUnwrapped = preSites.filter((line) => !isHomeWrapped(line))
    expect(preUnwrapped).toEqual([removeLine, installLine])
  })
})

// ---------------------------------------------------------------------------
// SR-7.5 behavioral test — the post-verify snapshot/revert net
// ---------------------------------------------------------------------------
//
// Rather than run the full publish script (which needs a manifest, npm, a real
// registry, etc.), we extract the two load-bearing fragments verbatim from the
// script — the START snapshot (lines ~51-59) and the SR-7.5 block (lines
// ~303-344) — and splice them into a tiny harness. The harness runs against a
// real temp git repo, so the `git diff --name-only` / `git checkout --` calls
// exercise genuine git semantics. Each scenario asserts the observable EFFECT
// on the working tree (which files ended up reverted vs. surviving) and the
// exit code, never any log phrasing.

/**
 * Extract the inclusive source range [startMatch .. lastEnd] from the script,
 * where lastEnd is the LAST line matching `endMatch` that still falls before
 * `boundaryMatch` (the first line of the next section). Using the last matching
 * `fi` before the boundary captures the block's real top-level close even when
 * it contains sibling `if`/`fi` pairs at column 0.
 */
function extractBlock(
  script: string,
  startMatch: RegExp,
  endMatch: RegExp,
  boundaryMatch: RegExp,
): string {
  const lines = script.split('\n')
  const start = lines.findIndex((l) => startMatch.test(l))
  if (start < 0) throw new Error(`start marker not found: ${startMatch}`)
  const boundary = lines.findIndex((l, i) => i > start && boundaryMatch.test(l))
  if (boundary < 0) throw new Error(`boundary marker not found: ${boundaryMatch}`)
  let end = -1
  for (let i = start + 1; i < boundary; i++) {
    if (endMatch.test(lines[i]!)) end = i
  }
  if (end < 0) throw new Error(`end marker not found: ${endMatch}`)
  return lines.slice(start, end + 1).join('\n')
}

let SNAPSHOT_BLOCK: string
let SR75_BLOCK: string

beforeAll(() => {
  const script = readFixedScript()
  // START snapshot: `START_DIRTY=` through the last column-0 `fi` before the
  // `MANIFEST=` line that begins the next section (closes the bun.lock-flag if).
  SNAPSHOT_BLOCK = extractBlock(script, /^START_DIRTY=/, /^fi$/, /^MANIFEST=/)
  // SR-7.5: `POST_VERIFY_DIRTY=` through its column-0 `fi`, before the SR-8.1
  // daemon-bounce comment that begins the next section.
  SR75_BLOCK = extractBlock(
    script,
    /^POST_VERIFY_DIRTY=/,
    /^fi$/,
    /^# SR-8\.1/,
  )
  // Sanity: we captured balanced, load-bearing pieces.
  expect(SNAPSHOT_BLOCK).toContain('START_PKG_JSON_DIRTY')
  expect(SNAPSHOT_BLOCK).toContain('START_BUN_LOCK_DIRTY')
  expect(SR75_BLOCK).toContain('git checkout -- ')
})

/**
 * A throwaway git repo and the temp HOME its child processes run under, both
 * inside one `mkdtempSync` root the test owns and removes.
 */
interface GitFixture {
  root: string
  home: string
  repo: string
}

/** The fixture's fake, repo-local commit identity (never a real person). */
const FIXTURE_USER_NAME = 'Fixture'
const FIXTURE_USER_EMAIL = 'test@example.invalid'

/**
 * Extras for every fixture child that runs git: `GIT_CONFIG_NOSYSTEM=1` keeps
 * the host's system git configuration out, as the temp HOME keeps the global
 * one out.
 */
const FIXTURE_GIT_EXTRAS: Readonly<Record<string, string>> = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1' })

/** Run git in the fixture repo under the fixture's temp HOME; returns stdout. */
function git(fx: GitFixture, ...args: string[]): string {
  return execFileSync('git', ['-C', fx.repo, ...args], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: hostSafeChildEnv(fx.home, { tools: ['git'], extras: FIXTURE_GIT_EXTRAS }),
  })
}

/**
 * Create a temp git repo with committed package.json + bun.lock + README.md.
 *
 * git runs under the fixture's empty temp HOME with `GIT_CONFIG_NOSYSTEM=1`,
 * so no global, per-user or system git configuration loads (no identity, no
 * hooks path, no signing key). The repo therefore declares its own fake
 * identity in its local config, and turns signing off explicitly. The one
 * commit succeeds on the first attempt on any host.
 */
function initRepo(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), 'sr75-'))
  const fx: GitFixture = { root, home: join(root, 'home'), repo: join(root, 'repo') }
  mkdirSync(fx.home)
  mkdirSync(fx.repo)
  git(fx, 'init', '-q')
  git(fx, 'config', 'user.name', FIXTURE_USER_NAME)
  git(fx, 'config', 'user.email', FIXTURE_USER_EMAIL)
  git(fx, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(fx.repo, 'package.json'), '{"name":"x","version":"1.0.0"}\n')
  writeFileSync(join(fx.repo, 'bun.lock'), 'LOCK v1\n')
  writeFileSync(join(fx.repo, 'README.md'), 'clean\n')
  git(fx, 'add', '-A')
  git(fx, 'commit', '-q', '-m', 'init')
  return fx
}

let fixture: GitFixture

/**
 * Run the extracted SR-7.5 logic inside the fixture repo.
 *
 * `dirtyBeforeStart` names files to dirty BEFORE the START snapshot runs
 * (simulating pre-existing operator dirt); `dirtyAfterStart` names files to
 * dirty AFTER the snapshot but before SR-7.5 (simulating promote-induced dirt).
 * Returns the harness exit code and the post-run `git diff --name-only`.
 */
function runSr75(
  fx: GitFixture,
  dirtyBeforeStart: string[],
  dirtyAfterStart: string[],
): { code: number; dirty: string[] } {
  // NEXT_VERSION is referenced by the SR-7.5 warning prose; define it so the
  // spliced block doesn't trip `set -u`.
  const dirty = (files: string[]) =>
    files
      .map((f) => `printf 'dirtied by %s\\n' "$RANDOM" >> ${JSON.stringify(f)}`)
      .join('\n')

  const harness = [
    'set -euo pipefail',
    'NEXT_VERSION=9.9.9',
    `cd ${JSON.stringify(fx.repo)}`,
    // Start each scenario from a pristine tree (the repo is reused across tests).
    'git checkout -- . 2>/dev/null; git clean -fdq',
    // Pre-existing operator dirt lands BEFORE the START snapshot.
    dirty(dirtyBeforeStart),
    SNAPSHOT_BLOCK,
    // Promote-induced dirt lands AFTER the snapshot, before SR-7.5.
    dirty(dirtyAfterStart),
    SR75_BLOCK,
    'exit 0',
  ].join('\n')

  // The spliced blocks run git, grep and (in the warning arm) sed by name. git
  // must be on PATH: the blocks swallow a failed `git diff` (`|| true`).
  let code = 0
  try {
    execFileSync('bash', ['-c', harness], {
      stdio: 'pipe',
      env: hostSafeChildEnv(fx.home, { tools: ['bash', 'git', 'grep', 'sed'], extras: FIXTURE_GIT_EXTRAS }),
    })
  } catch (e: any) {
    code = typeof e.status === 'number' ? e.status : 1
  }
  const out = git(fx, 'diff', '--name-only')
  return { code, dirty: out.split('\n').filter(Boolean).sort() }
}

describe('b.bpp: SR-7.5 post-verify snapshot reverts promote-induced pkg/lock dirt only', () => {
  beforeAll(() => {
    fixture = initRepo()
  })
  afterAll(() => {
    // Guard against undefined: if beforeAll's initRepo() ever throws, fixture
    // stays undefined and an unguarded rmSync on it would throw a second,
    // misleading cascade failure that masks the real setup error.
    if (fixture) rmSync(fixture.root, { recursive: true, force: true })
  })

  // Proves the fixture commit was authored by the repo-local fake identity —
  // nothing rewrote or overrode it (e.g. a commit hook or a GIT_AUTHOR_* /
  // GIT_COMMITTER_* env override). It does NOT prove that no host git
  // configuration loaded: repo-local user.* takes precedence over global and
  // system values, so those would not show here.
  test('fixture commit carries the repo-local fake identity (not rewritten or overridden)', () => {
    expect(git(fixture, 'log', '-1', '--format=%an <%ae>').trim()).toBe(
      `${FIXTURE_USER_NAME} <${FIXTURE_USER_EMAIL}>`,
    )
  })

  test('promote-induced package.json + bun.lock dirt is reverted; exit 0', () => {
    const { code, dirty } = runSr75(fixture, [], ['package.json', 'bun.lock'])
    expect(code).toBe(0)
    expect(dirty).toEqual([]) // both reverted, tree clean
  })

  test('pre-existing (dirty-at-start) package.json dirt is NOT reverted; exit 0', () => {
    const { code, dirty } = runSr75(fixture, ['package.json'], [])
    expect(code).toBe(0)
    expect(dirty).toEqual(['package.json']) // operator dirt survives
  })

  test('other-file dirt survives the revert; exit 0', () => {
    const { code, dirty } = runSr75(fixture, [], ['README.md'])
    expect(code).toBe(0)
    expect(dirty).toEqual(['README.md']) // non-pkg/lock stray untouched
  })

  test('mixed: induced lock reverted, pre-existing pkg + other file survive; exit 0', () => {
    const { code, dirty } = runSr75(
      fixture,
      ['package.json'],
      ['bun.lock', 'README.md'],
    )
    expect(code).toBe(0)
    // bun.lock was clean-at-start + dirty-now → reverted.
    // package.json dirty-at-start → left; README.md non-pkg/lock → left.
    expect(dirty).toEqual(['README.md', 'package.json'])
  })
})
