/**
 * packaging-completeness.test.ts — b.q9t regression guard.
 *
 * The bug: the declared package version (0.8.2) was one whose PUBLISHED npm
 * artifact shipped none of the cron code, while the working tree already
 * carried the five cron source files (src/cron-bootstrap.ts, cron-dispatch.ts,
 * cron-log.ts, cron-scheduler.ts, crontable.ts). A customer running
 * `npm i -g claude-slack-channel-bots` got a binary that could not run cron.
 * The fix bumped the version 0.8.2 → 0.9.0 (the first version whose artifact
 * contains cron).
 *
 * Two guards, both of which fail against the pre-fix state and pass after:
 *
 *   1. VERSION GATE — when the cron source files are present in src/, the
 *      declared package.json version must be >= 0.9.0. This fails-before: at the
 *      pre-fix 0.8.2 (with cron already in the tree) the assertion would fail.
 *
 *   2. PACKAGING COMPLETENESS — the set of files `npm pack` would ship must
 *      include every runtime src/*.ts file in the repo. This is the general
 *      guard against the whole class of bug: a future new src file silently
 *      excluded by the package.json `files` globs would ship a broken tarball
 *      without anyone noticing. Hermetic where possible; shells out to npm for
 *      the authoritative file list and skips cleanly if npm is unavailable.
 *
 * b.av2 AC 27 guard (SR-12, SR-13.5): the shipped debugging skill
 * `skills/debug-slack-channel-bots/SKILL.md` must be in the npm pack list
 * (same probe and skip/error contract as guard 2), with a hermetic companion
 * that needs no npm (the file exists with a `name` matching its directory and
 * a `description`, and package.json `files` covers the skill's path with no
 * `!` entry excluding it), and a class-coverage check: every label in
 * PERSONA_DIAGNOSTIC_CLASSES (imported, side-effect free) names a `##`–`####`
 * heading in the skill (the skill gives each class a `###` heading naming it),
 * so a class added without a skill entry, or an entry cut down to a passing
 * mention, fails here. RELOAD_DIAGNOSTIC_CLASSES (src/reload.ts, imported,
 * side-effect free) gets the same heading check in its own `test.each`, plus
 * a non-empty, duplicate-free check on the list. Content audits of shipped text (forbidden terms, the
 * SR-1.7 exception) are later Epics' work (E6/E14), not this file's.
 *
 * b.av2 SR-12: the setup wizard's credentials script,
 * `scripts/write-credentials.sh` (which `claude-slack-channel-bots
 * credentials` runs), is in the npm pack list, with the same hermetic
 * companion (the file exists and package.json `files` covers it).
 *
 * Every npm-backed test shares one memoised pack probe per file load. The npm
 * child gets a throwaway cache and user config inside the probe's temp dir,
 * so it never reads or writes the real HOME (b.av2 SR-13.2).
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import semver from 'semver'
import { PERSONA_DIAGNOSTIC_CLASSES } from '../src/persona-diagnostics.ts'
import { RELOAD_DIAGNOSTIC_CLASSES } from '../src/reload.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')

/** The first published version whose artifact contains the cron feature. */
const CRON_FLOOR = '0.9.0'

/** The five cron source files that must ship for cron to work at all. */
const CRON_SRC_FILES = [
  'src/cron-bootstrap.ts',
  'src/cron-dispatch.ts',
  'src/cron-log.ts',
  'src/cron-scheduler.ts',
  'src/crontable.ts',
]

function readPkg(): { version: string; files?: string[] } {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'))
}

/**
 * Pure comparator under test. Returns true when the declared version is new
 * enough to carry cron.
 */
function versionCarriesConfiguredCron(declaredVersion: string): boolean {
  return semver.gte(declaredVersion, CRON_FLOOR)
}

// ---------------------------------------------------------------------------
// 1. Version gate — cron in the tree ⇒ version must be >= 0.9.0
// ---------------------------------------------------------------------------

describe('b.q9t: version gate for the cron feature', () => {
  test('with cron in the tree, declared version is >= 0.9.0 (FAILS-BEFORE-FIX at 0.8.2)', () => {
    // Precondition: the guard is only meaningful while the tree actually ships
    // cron. If a future change removes cron, this documents why the assertion
    // holds and stops the version gate from silently becoming vacuous.
    const cronPresent = CRON_SRC_FILES.every((rel) =>
      existsSync(resolve(REPO_ROOT, rel)),
    )
    expect(cronPresent).toBe(true)

    // The real fails-before assertion: with cron present, the declared version
    // must be >= 0.9.0. At the pre-fix 0.8.2 this fails, so any regression of
    // package.json below the cron floor is caught here.
    const { version } = readPkg()
    expect(versionCarriesConfiguredCron(version)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Packaging completeness — npm pack must ship every runtime src/*.ts
// ---------------------------------------------------------------------------

/**
 * Result of probing npm for the file list it would pack.
 *
 * The skip/fail distinction is deliberate and load-bearing (a skipped test must
 * never mask a real failure): ONLY an absent npm toolchain yields `skip`. Once
 * npm is present, every downstream problem — a non-zero `npm pack`, or a stdout
 * we cannot parse into a file list — is a genuine packaging failure and is
 * reported as `error` so the test fails loudly with the captured stderr.
 */
type PackProbe =
  | { kind: 'skip' } // npm toolchain unavailable — nothing to assert against
  | { kind: 'error'; message: string } // npm present but pack/parse failed
  | { kind: 'ok'; files: string[] }

/**
 * Ask npm for the authoritative list of files it would pack, evaluated against
 * the real package.json `files` globs. npm writes progress noise to stderr, so
 * we key strictly off stdout + exit status for the file list.
 */
function npmPackProbe(): PackProbe {
  // npm writes its cache, debug logs and update-notifier stamp under ~/.npm
  // and reads ~/.npmrc by default. Point every npm child at a throwaway dir
  // for all of these so the test never touches the real HOME.
  const probeDir = mkdtempSync(join(tmpdir(), 'cscb-npm-probe-'))
  try {
    return npmPackProbeIn(probeDir)
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

function npmPackProbeIn(probeDir: string): PackProbe {
  const env = {
    ...process.env,
    HOME: probeDir,
    // Never created: npm treats a missing user config as empty.
    npm_config_userconfig: join(probeDir, 'npmrc'),
    npm_config_cache: join(probeDir, 'cache'),
    npm_config_update_notifier: 'false',
  }
  const probe = spawnSync('npm', ['--version'], { encoding: 'utf-8', env })
  if (probe.error || probe.status !== 0) return { kind: 'skip' }

  // npm is present from here on — any failure below is a real packaging fault,
  // not a reason to skip.
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env,
    // No packfile is written in --dry-run mode; only the JSON manifest matters.
  })
  if (res.error || res.status !== 0) {
    return {
      kind: 'error',
      message: `npm pack --dry-run failed (status ${res.status}): ${
        res.error?.message ?? res.stderr ?? '(no stderr)'
      }`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(res.stdout)
  } catch (e) {
    return {
      kind: 'error',
      message: `npm pack JSON was unparseable (${
        (e as Error).message
      }); stderr: ${res.stderr ?? '(no stderr)'}`,
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      kind: 'error',
      message: `npm pack JSON was not a non-empty array; stderr: ${
        res.stderr ?? '(no stderr)'
      }`,
    }
  }
  const files = (parsed[0] as { files?: { path: string }[] }).files
  if (!Array.isArray(files)) {
    return {
      kind: 'error',
      message: `npm pack JSON had no files[] array; stderr: ${
        res.stderr ?? '(no stderr)'
      }`,
    }
  }
  return { kind: 'ok', files: files.map((f) => f.path) }
}

let sharedProbe: PackProbe | undefined

/** One npm pack probe per file load, shared by every npm-backed test. */
function packProbe(): PackProbe {
  sharedProbe ??= npmPackProbe()
  return sharedProbe
}

/** Every runtime src/*.ts file the repo would need to ship (tests excluded). */
function runtimeSrcFiles(): string[] {
  return readdirSync(resolve(REPO_ROOT, 'src'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `src/${name}`)
    .sort()
}

describe('b.q9t: npm pack ships every runtime src file', () => {
  const probe = packProbe()

  // Skip ONLY when the npm toolchain is absent. With npm present, a pack or
  // parse failure is surfaced as a hard failure below — a skip must never hide
  // a real packaging fault.
  test.skipIf(probe.kind === 'skip')(
    // Superset over ALL runtime src/*.ts, so the five cron files that motivated
    // b.q9t (cron-bootstrap, cron-dispatch, cron-log, cron-scheduler, crontable)
    // are covered as a special case, along with any future new src file.
    'the packed file set is a superset of the repo runtime src/*.ts files',
    () => {
      if (probe.kind === 'error') throw new Error(probe.message)
      const packedSet = new Set(probe.kind === 'ok' ? probe.files : [])
      const missing = runtimeSrcFiles().filter((rel) => !packedSet.has(rel))
      expect(missing).toEqual([])
    },
  )
})

// ---------------------------------------------------------------------------
// 3. b.av2 AC 27 — the debugging skill ships
// ---------------------------------------------------------------------------

const SKILL_NAME = 'debug-slack-channel-bots'
const SKILL_REL = `skills/${SKILL_NAME}/SKILL.md`

/** The `key: value` lines of a leading `---` frontmatter block, or null. */
function skillFrontmatter(text: string): Record<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    // An empty quoted value (`""`) counts as empty.
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  }
  return fields
}

/**
 * True when `pattern` (a package.json `files` glob, `!` already stripped)
 * matches `rel` or one of its ancestor directories. As in npm, an entry that
 * names a directory (`skills`, `skills/`) covers everything under it.
 */
function filesEntryMatches(pattern: string, rel: string): boolean {
  const glob = new Bun.Glob(pattern.replace(/^\.?\//, '').replace(/\/+$/, ''))
  const parts = rel.split('/')
  for (let n = parts.length; n > 0; n--) {
    if (glob.match(parts.slice(0, n).join('/'))) return true
  }
  return false
}

/**
 * True when package.json `files` would ship `rel`: some positive entry covers
 * it and no `!` entry excludes it. Stricter than npm on ordering (any matching
 * `!` entry excludes, wherever it sits), which is enough for a guard.
 */
function filesCover(files: string[], rel: string): boolean {
  const excluded = files.some(
    (f) => f.startsWith('!') && filesEntryMatches(f.slice(1), rel),
  )
  const included = files.some(
    (f) => !f.startsWith('!') && filesEntryMatches(f, rel),
  )
  return included && !excluded
}

/** A string matched literally inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('b.av2 AC 27: the debugging skill ships in the package', () => {
  const probe = packProbe()

  // Same contract as guard 2: skip only when npm is absent; a pack or parse
  // error is a hard failure.
  test.skipIf(probe.kind === 'skip')(
    `AC 27: the npm pack file list includes ${SKILL_REL}`,
    () => {
      if (probe.kind === 'error') throw new Error(probe.message)
      expect(probe.kind === 'ok' ? probe.files : []).toContain(SKILL_REL)
    },
  )

  // Hermetic companion: guards AC 27 where npm is unavailable.
  test('AC 27 (hermetic): the skill file exists, is non-empty and has name and description frontmatter', () => {
    const path = resolve(REPO_ROOT, SKILL_REL)
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf-8')
    expect(text.trim().length).toBeGreaterThan(0)
    const fm = skillFrontmatter(text)
    expect(fm).not.toBeNull()
    expect(fm?.name).toBe(SKILL_NAME)
    expect(fm?.description ?? '').not.toBe('')
  })

  test(`AC 27 (hermetic): package.json files covers ${SKILL_REL} and no ! entry excludes it`, () => {
    expect(filesCover(readPkg().files ?? [], SKILL_REL)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3b. The setup wizard's credentials script ships (b.av2 SR-12)
// ---------------------------------------------------------------------------

/** The script `claude-slack-channel-bots credentials` runs, from the package root. */
const CREDENTIALS_SCRIPT_REL = 'scripts/write-credentials.sh'

describe('b.av2 SR-12: the credentials script ships in the package', () => {
  const probe = packProbe()

  // Same contract as guard 2: skip only when npm is absent; a pack or parse
  // error is a hard failure.
  test.skipIf(probe.kind === 'skip')(
    `the npm pack file list includes ${CREDENTIALS_SCRIPT_REL}`,
    () => {
      if (probe.kind === 'error') throw new Error(probe.message)
      expect(probe.kind === 'ok' ? probe.files : []).toContain(CREDENTIALS_SCRIPT_REL)
    },
  )

  // Hermetic companion: guards the script where npm is unavailable.
  test(`(hermetic) ${CREDENTIALS_SCRIPT_REL} exists and package.json files covers it with no ! entry excluding it`, () => {
    expect(existsSync(resolve(REPO_ROOT, CREDENTIALS_SCRIPT_REL))).toBe(true)
    expect(filesCover(readPkg().files ?? [], CREDENTIALS_SCRIPT_REL)).toBe(true)
  })
})

/**
 * True when the skill has a `##`–`####` heading naming the whole label (not a
 * prefix or suffix of a longer hyphenated word): a passing mention in body
 * text is not an entry for the class.
 */
function skillHasClassHeading(label: string): boolean {
  const text = readFileSync(resolve(REPO_ROOT, SKILL_REL), 'utf-8')
  const re = new RegExp(
    `^#{2,4} [^\\n]*(?<![\\w-])${escapeRegExp(label)}(?![\\w-])`,
    'm',
  )
  return re.test(text)
}

describe('b.av2 AC 27: the debugging skill covers every persona diagnostic class', () => {
  // Labels come from the exported closed set, never a hand-copied list, so a
  // class added later without a skill entry fails here (b.av2 SR-12).
  test.each([...PERSONA_DIAGNOSTIC_CLASSES])(
    'AC 27: the skill has a heading for class %s',
    (label) => {
      expect(skillHasClassHeading(label)).toBe(true)
    },
  )
})

describe('b.av2 SR-12: the debugging skill covers every reload diagnostic class', () => {
  // The reload classes are their own exported closed set, kept apart from the
  // persona classes (E11 Director decision 3). Imported, never hand-copied, so
  // a reload class added without a skill entry fails here.
  test('RELOAD_DIAGNOSTIC_CLASSES is non-empty and has no duplicates', () => {
    expect(RELOAD_DIAGNOSTIC_CLASSES.length).toBeGreaterThan(0)
    expect(new Set(RELOAD_DIAGNOSTIC_CLASSES).size).toBe(
      RELOAD_DIAGNOSTIC_CLASSES.length,
    )
  })

  test.each([...RELOAD_DIAGNOSTIC_CLASSES])(
    'SR-12: the skill has a heading for class %s',
    (label) => {
      expect(skillHasClassHeading(label)).toBe(true)
    },
  )
})
