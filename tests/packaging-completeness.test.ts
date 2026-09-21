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
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import semver from 'semver'

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
  const probe = spawnSync('npm', ['--version'], { encoding: 'utf-8' })
  if (probe.error || probe.status !== 0) return { kind: 'skip' }

  // npm is present from here on — any failure below is a real packaging fault,
  // not a reason to skip.
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
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

/** Every runtime src/*.ts file the repo would need to ship (tests excluded). */
function runtimeSrcFiles(): string[] {
  return readdirSync(resolve(REPO_ROOT, 'src'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `src/${name}`)
    .sort()
}

describe('b.q9t: npm pack ships every runtime src file', () => {
  const probe = npmPackProbe()

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
