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
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

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

let tmpRepo: string

/** Initialise a temp git repo with committed package.json + bun.lock. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr75-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  // Host-specific: hosts with git identity enforcement (a global pre-commit
  // hook) refuse `git commit` in a no-remote repo because it resolves to
  // neither allow-listed identity. Declaring identity.account is the sanctioned
  // route (repo-local declaration wins first in the resolution order; see
  // ~/.claude/skills/github-config/SKILL.md), NOT a hook bypass — the hook
  // still runs and passes. A neutral placeholder email is used so no real
  // person's address is baked into a checked-in fixture; the hook self-corrects
  // it (see the retry below). Do not "simplify" either line away or the commit
  // is refused and beforeAll throws on such hosts.
  git('config', 'identity.account', 'work')
  git('config', 'user.email', 'fixture@example.com')
  writeFileSync(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}\n')
  writeFileSync(join(dir, 'bun.lock'), 'LOCK v1\n')
  writeFileSync(join(dir, 'README.md'), 'clean\n')
  git('add', '-A')
  // Retry-once: on identity-enforcing hosts the pre-commit hook sees the
  // placeholder user.email mismatch a config value, not an env/CLI override,
  // so per github-config SKILL.md outcome #2 it writes the resolved email into
  // the repo config and blocks exactly once ("Re-run the commit; it will
  // pass."). The identical retry then succeeds. On hosts without enforcement
  // the first commit succeeds and the retry never runs. Do not simplify this
  // away.
  try {
    git('commit', '-q', '-m', 'init')
  } catch {
    git('commit', '-q', '-m', 'init')
  }
  return dir
}

/**
 * Run the extracted SR-7.5 logic inside `repoDir`.
 *
 * `dirtyBeforeStart` names files to dirty BEFORE the START snapshot runs
 * (simulating pre-existing operator dirt); `dirtyAfterStart` names files to
 * dirty AFTER the snapshot but before SR-7.5 (simulating promote-induced dirt).
 * Returns the harness exit code and the post-run `git diff --name-only`.
 */
function runSr75(
  repoDir: string,
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
    `cd ${JSON.stringify(repoDir)}`,
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

  let code = 0
  try {
    execFileSync('bash', ['-c', harness], { stdio: 'pipe' })
  } catch (e: any) {
    code = typeof e.status === 'number' ? e.status : 1
  }
  const out = execFileSync('git', ['-C', repoDir, 'diff', '--name-only'], {
    encoding: 'utf-8',
  })
  return { code, dirty: out.split('\n').filter(Boolean).sort() }
}

describe('b.bpp: SR-7.5 post-verify snapshot reverts promote-induced pkg/lock dirt only', () => {
  beforeAll(() => {
    tmpRepo = initRepo()
  })
  afterAll(() => {
    // Guard against undefined: if beforeAll's initRepo() ever throws, tmpRepo
    // stays undefined and an unguarded rmSync(undefined, …) would throw a second,
    // misleading cascade failure that masks the real setup error.
    if (tmpRepo) rmSync(tmpRepo, { recursive: true, force: true })
  })

  test('promote-induced package.json + bun.lock dirt is reverted; exit 0', () => {
    const { code, dirty } = runSr75(tmpRepo, [], ['package.json', 'bun.lock'])
    expect(code).toBe(0)
    expect(dirty).toEqual([]) // both reverted, tree clean
  })

  test('pre-existing (dirty-at-start) package.json dirt is NOT reverted; exit 0', () => {
    const { code, dirty } = runSr75(tmpRepo, ['package.json'], [])
    expect(code).toBe(0)
    expect(dirty).toEqual(['package.json']) // operator dirt survives
  })

  test('other-file dirt survives the revert; exit 0', () => {
    const { code, dirty } = runSr75(tmpRepo, [], ['README.md'])
    expect(code).toBe(0)
    expect(dirty).toEqual(['README.md']) // non-pkg/lock stray untouched
  })

  test('mixed: induced lock reverted, pre-existing pkg + other file survive; exit 0', () => {
    const { code, dirty } = runSr75(
      tmpRepo,
      ['package.json'],
      ['bun.lock', 'README.md'],
    )
    expect(code).toBe(0)
    // bun.lock was clean-at-start + dirty-now → reverted.
    // package.json dirty-at-start → left; README.md non-pkg/lock → left.
    expect(dirty).toEqual(['README.md', 'package.json'])
  })
})
