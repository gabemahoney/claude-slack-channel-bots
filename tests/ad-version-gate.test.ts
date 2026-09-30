/**
 * ad-version-gate.test.ts — CSCB's Phase 1 floor (b.jg5 SRJ-201), its
 * comparison (b.jg5 SRJ-202) and the shared test versions (b.jg5 SRJ-1304).
 *
 * Every version is built from the floor constant's parts or imported from
 * `tests/test-helpers/agent-director-versions.ts`, so a change to
 * `PHASE1_FLOOR_VERSION` moves every case with it.
 *
 * No process, no real HOME, no top-level mock.module(), no value import of
 * `Client` or `resolveSystemBinary`.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import semver from 'semver'

import { meetsPhase1Floor, PHASE1_FLOOR_VERSION } from '../src/ad-version-gate.ts'
import {
  CLIENT_MIN_VERSION,
  DEV_PLACEHOLDER_VERSION,
  DEV_UNPARSEABLE_VERSION,
  OLD_AD_VERSION,
  PHASE1_RC_VERSION,
} from './test-helpers/agent-director-versions.ts'
import { makeStubClient } from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Versions built from the floor's parts
// ---------------------------------------------------------------------------

const FLOOR = PHASE1_FLOOR_VERSION.split('.').map(Number) as [number, number, number]
const [MAJOR, MINOR, PATCH] = FLOOR

/** The pre-release suffix the helper's release candidate carries. */
const RC = PHASE1_RC_VERSION.slice(PHASE1_FLOOR_VERSION.length)

const v = (major: number, minor: number, patch: number): string => `${major}.${minor}.${patch}`

/** A patch number high enough to sit above any real release in its minor. */
const HIGH = 999

/** The version just below the floor: one patch below, or the previous minor's (major's) highest-looking release. */
const JUST_BELOW = PATCH > 0
  ? v(MAJOR, MINOR, PATCH - 1)
  : MINOR > 0
    ? v(MAJOR, MINOR - 1, HIGH)
    : v(MAJOR - 1, HIGH, HIGH)

const LATER_PATCH = v(MAJOR, MINOR, PATCH + 1)
const LATER_MINOR = v(MAJOR, MINOR + 1, 0)
const LATER_MAJOR = v(MAJOR + 1, 0, 0)

/** Replace floor part `i` with `value` and zero the parts after it. */
function withPart(i: number, value: number): string {
  return FLOOR.map((n, j) => (j < i ? n : j === i ? value : 0)).join('.')
}

/**
 * Versions whose string order is the opposite of their numeric order against
 * the floor, each with the numeric answer:
 *   - a multi-digit part not starting with 9, replaced by 9: numerically
 *     lower, but sorts after the floor as a string (refused);
 *   - a part starting with 2-9, replaced by the next power of ten: numerically
 *     higher, but sorts before the floor as a string (passes).
 */
const LEXICAL_TRAPS: Array<[string, boolean]> = FLOOR.flatMap((n, i): Array<[string, boolean]> => {
  const s = String(n)
  const traps: Array<[string, boolean]> = []
  if (s.length > 1 && s[0] !== '9') traps.push([withPart(i, 9), false])
  if (s[0] >= '2') traps.push([withPart(i, 10 ** s.length), true])
  return traps
})

// ---------------------------------------------------------------------------
// The floor constant (SRJ-201)
// ---------------------------------------------------------------------------

describe('PHASE1_FLOOR_VERSION', () => {
  test('is strict major.minor.patch with no pre-release suffix', () => {
    expect(PHASE1_FLOOR_VERSION).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  })

  test("is above the client's own minimum, so CSCB's check never sits below the client's", () => {
    expect(semver.gt(PHASE1_FLOOR_VERSION, CLIENT_MIN_VERSION)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The comparison (SRJ-202)
// ---------------------------------------------------------------------------

describe('meetsPhase1Floor', () => {
  test.each([
    ['the floor', PHASE1_FLOOR_VERSION],
    ["the floor's release candidate", PHASE1_RC_VERSION],
    ['a later patch release', LATER_PATCH],
    ['a later patch release candidate', `${LATER_PATCH}${RC}`],
    ['a later minor release', LATER_MINOR],
    ['a later minor release candidate', `${LATER_MINOR}${RC}`],
    ['a later major release', LATER_MAJOR],
    ['a later major release candidate', `${LATER_MAJOR}${RC}`],
  ])('passes %s (%s)', (_label, version) => {
    expect(meetsPhase1Floor(version)).toBe(true)
  })

  test.each([
    ['the release before Phase 1', OLD_AD_VERSION],
    ["the client's dev sentinel (the client's own rule ranks it above every floor, and CSCB refuses it)", DEV_PLACEHOLDER_VERSION],
    ['a release candidate of a version below the floor', `${JUST_BELOW}${RC}`],
    ['the version just below the floor', JUST_BELOW],
  ])('refuses %s (%s)', (_label, version) => {
    expect(meetsPhase1Floor(version)).toBe(false)
  })

  test('the floor has a version whose string order disagrees with its numeric order', () => {
    expect(LEXICAL_TRAPS.length).toBeGreaterThan(0)
  })

  test.each(LEXICAL_TRAPS)('compares %s numerically, not as a string (passes: %p)', (version, passes) => {
    expect(version < PHASE1_FLOOR_VERSION).toBe(passes)
    expect(meetsPhase1Floor(version)).toBe(passes)
  })

  test.each([
    ['a leading-v form of the floor', `v${PHASE1_FLOOR_VERSION}`],
    ['a +build form of the floor', `${PHASE1_FLOOR_VERSION}+build.1`],
    ['the floor with a trailing newline', `${PHASE1_FLOOR_VERSION}\n`],
    ['an unparseable dev version', DEV_UNPARSEABLE_VERSION],
    ['the empty string', ''],
  ])('fails closed on %s', (_label, version) => {
    expect(meetsPhase1Floor(version)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The shared test versions (SRJ-1304)
// ---------------------------------------------------------------------------

describe('agent-director-versions helper', () => {
  test("PHASE1_RC_VERSION is a pre-release of the floor and passes it", () => {
    expect(PHASE1_RC_VERSION).not.toBe(PHASE1_FLOOR_VERSION)
    expect(PHASE1_RC_VERSION.split('-')[0]).toBe(PHASE1_FLOOR_VERSION)
    expect(meetsPhase1Floor(PHASE1_RC_VERSION)).toBe(true)
  })

  test('OLD_AD_VERSION is at or above the client minimum: the client admits it, only CSCB refuses it', () => {
    expect(semver.gte(OLD_AD_VERSION, CLIENT_MIN_VERSION)).toBe(true)
    expect(meetsPhase1Floor(OLD_AD_VERSION)).toBe(false)
  })

  test("CLIENT_MIN_VERSION is the installed client's version-floor.json value", async () => {
    const floorPath = Bun.resolveSync('agent-director/dist/version-floor.json', import.meta.dir)
    const floorJson = (await Bun.file(floorPath).json()) as { min_binary_version: unknown }
    expect(CLIENT_MIN_VERSION).toBe(floorJson.min_binary_version as string)
  })

  test("a default stub client reports PHASE1_RC_VERSION, which passes the floor", () => {
    const { binaryVersion } = makeStubClient()
    expect(binaryVersion).toBe(PHASE1_RC_VERSION)
    expect(meetsPhase1Floor(binaryVersion)).toBe(true)
  })
})
