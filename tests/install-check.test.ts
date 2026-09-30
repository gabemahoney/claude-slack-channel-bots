/**
 * install-check.test.ts — `runInstallCheck` (src/install-check.ts) over an
 * injected resolver (b.jg5 SRJ-212, SRJ-121; AC 81).
 *
 * Cases, each through `runInstallCheck`:
 *   - `PHASE1_RC_VERSION` passes with no note, echoing the path and version;
 *   - `OLD_AD_VERSION`, `DEV_PLACEHOLDER_VERSION` and `CLIENT_MIN_VERSION`
 *     pass with the Phase 1 note (the note builder's output, naming the found
 *     version and the switch-over runbook section);
 *   - a resolved version below the client's minimum, and
 *     `ErrSystemInstallTooOld`, fail too old; the message names the found and
 *     required versions, the path and the runbook section;
 *   - `ErrSystemInstallNotFound` fails not found;
 *   - `ErrSystemInstallUnreachable`, all eight reasons, fails unreachable
 *     with the reason in `detail`;
 *   - a resolved version that does not parse (a leading `v` included) fails
 *     unreachable with reason `unparseable-version`;
 *   - any other throw (an `Error`, a non-error, a synchronous throw) fails
 *     unreachable with reason `other`, carrying none of the thrown text;
 *   - a value carrying only the matching `errName` maps as the class-built
 *     error does (errors are recognised by name);
 *   - a client minimum that is not a version fails floor unreadable;
 *   - a malformed floor file or a missing field (seeded failures) is returned
 *     unchanged, without calling the resolver;
 *   - one sweep: no message and no note carries an upgrade instruction or
 *     command (`UPGRADE_FORMS`, and "Upgrade agent-director" in any case).
 *
 * The resolver is always injected (`makeStubResolveSystemBinary`); no module
 * is mocked. The client minimum comes from the floor-cache seam: seeded with
 * `CLIENT_MIN_VERSION` before each case and reset after it. Every version,
 * label and title comes from `src/` or `tests/test-helpers/`.
 *
 * SPDX-License-Identifier: MIT
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import semver from 'semver'
import type { UnreachableReason } from 'agent-director'

import {
  buildInstallCheckPhase1Note,
  buildSystemInstallTooOldMessage,
  INSTALL_CHECK_PHASE1_NOTE_PHRASE,
  meetsPhase1Floor,
  PHASE1_RUNBOOK_SECTION_TITLE,
} from '../src/ad-version-gate.ts'
import {
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
  AD_VERSION_FLOOR_UNREADABLE,
  type InstallCheckFailure,
  type InstallCheckResolveSystemBinary,
  type InstallCheckResult,
  resetCacheForTests,
  runInstallCheck,
  setFloorForTests,
} from '../src/install-check.ts'
import {
  errSystemInstallNotFound,
  errSystemInstallTooOld,
  errSystemInstallUnreachable,
  makeStubResolveSystemBinary,
  type StubResolveSystemBinaryOptions,
} from './test-helpers/agent-director-stub.ts'
import {
  CLIENT_MIN_VERSION,
  DEV_PLACEHOLDER_VERSION,
  DEV_UNPARSEABLE_VERSION,
  OLD_AD_VERSION,
  PHASE1_RC_VERSION,
} from './test-helpers/agent-director-versions.ts'
import { flat } from './test-helpers/markdown.ts'
import { UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A distinct host binary path per case, so a result shows the path it was given is passed through. */
const binaryPath = (label: string): string => join(tmpdir(), 'cscb-install-check', label, 'agent-director')

/** A plain release one step below `version`'s core. */
function releaseBelow(version: string): string {
  const [major, minor, patch] = [semver.major(version), semver.minor(version), semver.patch(version)]
  if (patch > 0) return `${major}.${minor}.${patch - 1}`
  if (minor > 0) return `${major}.${minor - 1}.${Number.MAX_SAFE_INTEGER}`
  return `${major - 1}.${Number.MAX_SAFE_INTEGER}.${Number.MAX_SAFE_INTEGER}`
}

/** A release below the client's minimum. */
const BELOW_CLIENT_MIN = releaseBelow(CLIENT_MIN_VERSION)

/** Every `ErrSystemInstallUnreachable` reason; the `Record` makes the compiler hold the list complete. */
const REASON_SET: Record<UnreachableReason, true> = {
  'not-executable': true,
  'not-a-regular-file': true,
  'probe-timeout': true,
  'probe-nonzero-exit': true,
  'probe-killed-by-signal': true,
  'unparseable-version': true,
  'spawn-failed': true,
  other: true,
}
const REASONS = Object.keys(REASON_SET) as UnreachableReason[]

/** The reason a resolved version that does not parse is reported with. */
const UNPARSEABLE_VERSION_REASON: UnreachableReason = 'unparseable-version'

/** The reason any other failure is reported with. */
const OTHER_REASON: UnreachableReason = 'other'

/** Resolved versions the client's strict rule cannot parse. */
const UNPARSEABLE_VERSIONS: ReadonlyArray<[label: string, version: string]> = [
  ['leading v on the client minimum', `v${CLIENT_MIN_VERSION}`],
  ['leading v on the Phase 1 release candidate', `v${PHASE1_RC_VERSION}`],
  ['a non-SemVer development version', DEV_UNPARSEABLE_VERSION],
]

/** Text a thrown value carries that no result may repeat. */
const RAW_THROWN_TEXT = 'raw-thrown-text-install-check-must-not-echo'

/**
 * A plain object carrying `error`'s `errName` and structural fields but no
 * `name` and no class: recognised only by `errName`.
 */
function errNameOnly(error: Error): Record<string, unknown> {
  const { name: _name, ...fields } = { ...error } as Record<string, unknown>
  return fields
}

/** Run the check with a stub resolver built from `opts`; returns the result and the stub's calls. */
async function check(
  opts: StubResolveSystemBinaryOptions = {},
): Promise<{ result: InstallCheckResult; calls: Array<object | undefined> }> {
  const calls: Array<object | undefined> = []
  const result = await runInstallCheck({ resolveSystemBinary: makeStubResolveSystemBinary({ ...opts, calls }) })
  return { result, calls }
}

/** The failure arm of `result`; fails the test on success. */
function failureOf(result: InstallCheckResult): InstallCheckFailure {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error(`expected a failure, got success at ${result.binaryVersion}`)
  return result
}

/** A seeded `ad-version-floor-unreadable` failure, as `readClientMinVersion` caches one. */
function seededFloorFailure(detail: Record<string, unknown>): InstallCheckFailure {
  return { ok: false, classLabel: AD_VERSION_FLOOR_UNREADABLE, message: 'seeded floor failure', detail }
}

beforeEach(() => {
  resetCacheForTests()
  setFloorForTests(CLIENT_MIN_VERSION)
})

afterEach(() => {
  resetCacheForTests()
})

describe('fixtures', () => {
  test('the helper versions sit where the cases need them', () => {
    expect(semver.lt(BELOW_CLIENT_MIN, CLIENT_MIN_VERSION)).toBe(true)
    expect(meetsPhase1Floor(PHASE1_RC_VERSION)).toBe(true)
    for (const version of [OLD_AD_VERSION, DEV_PLACEHOLDER_VERSION, CLIENT_MIN_VERSION]) {
      expect(meetsPhase1Floor(version)).toBe(false)
    }
    expect(REASONS).toHaveLength(8)
  })
})

// ---------------------------------------------------------------------------
// Passing binaries
// ---------------------------------------------------------------------------

describe('runInstallCheck: a binary at the Phase 1 floor passes with no note (SRJ-212)', () => {
  test('PHASE1_RC_VERSION: success, path and version echoed, floor is the client minimum, no note', async () => {
    const path = binaryPath('phase1-rc')
    const { result, calls } = await check({ version: PHASE1_RC_VERSION, path })
    expect(result).toEqual({ ok: true, binaryPath: path, binaryVersion: PHASE1_RC_VERSION, floor: CLIENT_MIN_VERSION })
    if (result.ok) expect('note' in result).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe('runInstallCheck: a binary below the Phase 1 floor passes with the note (SRJ-212, AC 81)', () => {
  test.each([
    ['OLD_AD_VERSION', OLD_AD_VERSION],
    ['DEV_PLACEHOLDER_VERSION', DEV_PLACEHOLDER_VERSION],
    ['CLIENT_MIN_VERSION', CLIENT_MIN_VERSION],
  ])('%s (%s): success carrying the builder\'s note, naming the runbook section and the version', async (label, version) => {
    const path = binaryPath(`below-floor-${label}`)
    const { result, calls } = await check({ version, path })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.binaryPath).toBe(path)
    expect(result.binaryVersion).toBe(version)
    expect(result.floor).toBe(CLIENT_MIN_VERSION)
    expect(result.note).toBe(buildInstallCheckPhase1Note(version))
    expect(result.note).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    expect(result.note).toContain(version)
    expect(result.note).toContain(INSTALL_CHECK_PHASE1_NOTE_PHRASE)
    expect(calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Failing binaries
// ---------------------------------------------------------------------------

describe('runInstallCheck: below the client minimum fails too old, naming the runbook (SRJ-212)', () => {
  test.each([
    ['a resolved version below the client minimum', 'resolved', { version: BELOW_CLIENT_MIN, path: binaryPath('resolved-too-old') }],
    [
      'ErrSystemInstallTooOld',
      'thrown',
      { throws: errSystemInstallTooOld(BELOW_CLIENT_MIN, CLIENT_MIN_VERSION, binaryPath('thrown-too-old')) },
    ],
  ] as const)('%s: too-old label; message names found, required, path and the runbook section', async (_label, kind, opts) => {
    const path = binaryPath(`${kind}-too-old`)
    const failure = failureOf((await check(opts)).result)
    expect(failure.classLabel).toBe(AD_SYSTEM_INSTALL_TOO_OLD)
    expect(failure.detail).toEqual({ detected: BELOW_CLIENT_MIN, required: CLIENT_MIN_VERSION, binaryPath: path })
    expect(failure.message).toBe(
      buildSystemInstallTooOldMessage({ foundVersion: BELOW_CLIENT_MIN, requiredVersion: CLIENT_MIN_VERSION, binaryPath: path }),
    )
    for (const part of [BELOW_CLIENT_MIN, CLIENT_MIN_VERSION, path, PHASE1_RUNBOOK_SECTION_TITLE]) {
      expect(failure.message).toContain(part)
    }
  })
})

describe('runInstallCheck: ErrSystemInstallNotFound fails not found (SRJ-212)', () => {
  test('not-found label; detail carries the checked locations', async () => {
    const checkedLocations = [{ kind: 'path-lookup' as const, detail: null }]
    const failure = failureOf((await check({ throws: errSystemInstallNotFound(checkedLocations) })).result)
    expect(failure.classLabel).toBe(AD_SYSTEM_INSTALL_NOT_FOUND)
    expect(failure.detail).toEqual({ checkedLocations })
  })
})

describe('runInstallCheck: ErrSystemInstallUnreachable, all eight reasons, fails unreachable (SRJ-212)', () => {
  test.each(REASONS)('reason %s: unreachable label, reason in detail and message', async (reason) => {
    const path = binaryPath(`unreachable-${reason}`)
    const failure = failureOf((await check({ throws: errSystemInstallUnreachable(reason, null, path) })).result)
    expect(failure.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
    expect(failure.detail.reason).toBe(reason)
    expect(failure.detail.binaryPath).toBe(path)
    expect(failure.message).toContain(reason)
    expect(failure.message).toContain(path)
  })
})

describe('runInstallCheck: a resolved version that does not parse fails, never passes (SRJ-212)', () => {
  test.each(UNPARSEABLE_VERSIONS)('%s (%s): unreachable label, reason unparseable-version', async (label, version) => {
    const path = binaryPath(`unparseable-${label.replaceAll(' ', '-')}`)
    const failure = failureOf((await check({ version, path })).result)
    expect(failure.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
    expect(failure.detail.reason).toBe(UNPARSEABLE_VERSION_REASON)
    expect(failure.detail.binaryPath).toBe(path)
    expect(failure.detail.exitCode).toBeNull()
    expect(failure.detail.signal).toBeNull()
    expect(String(failure.detail.diagnostic)).toContain(version)
  })
})

describe('runInstallCheck: any other throw fails unreachable with none of its text (SRJ-212)', () => {
  /** Resolvers that fail in a way the decision classes as other. */
  const OTHER_RESOLVERS: ReadonlyArray<[label: string, resolve: InstallCheckResolveSystemBinary]> = [
    ['a plain Error rejection', makeStubResolveSystemBinary({ throws: new Error(RAW_THROWN_TEXT) })],
    [
      'a plain Error thrown synchronously',
      () => {
        throw new Error(RAW_THROWN_TEXT)
      },
    ],
    ['a thrown string', () => Promise.reject(RAW_THROWN_TEXT)],
    ['a thrown object with no name', () => Promise.reject({ message: RAW_THROWN_TEXT })],
  ]

  test.each(OTHER_RESOLVERS)('%s: failure, reason other; message and detail omit the thrown text', async (_label, resolve) => {
    const failure = failureOf(await runInstallCheck({ resolveSystemBinary: resolve }))
    expect(failure.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
    expect(failure.detail.reason).toBe(OTHER_REASON)
    expect(failure.message).not.toContain(RAW_THROWN_TEXT)
    expect(JSON.stringify(failure.detail)).not.toContain(RAW_THROWN_TEXT)
  })

  test("a plain Error: the message and detail name the error's name", async () => {
    const error = new Error(RAW_THROWN_TEXT)
    const failure = failureOf((await check({ throws: error })).result)
    expect(failure.message).toContain(error.name)
    expect(failure.detail.underlying).toBe(error.name)
  })
})

describe('runInstallCheck: errors are recognised by errName, not class (SRJ-212)', () => {
  test.each([
    ['ErrSystemInstallNotFound', errSystemInstallNotFound([{ kind: 'standard-install-path', detail: null }])],
    ['ErrSystemInstallTooOld', errSystemInstallTooOld(BELOW_CLIENT_MIN, CLIENT_MIN_VERSION, binaryPath('by-name-too-old'))],
    ['ErrSystemInstallUnreachable', errSystemInstallUnreachable(REASONS[0], null, binaryPath('by-name-unreachable'))],
  ])('%s: a value carrying only its errName maps as the class-built error does', async (_label, error) => {
    const lookalike = errNameOnly(error)
    expect(lookalike.errName).toBe((error as { errName?: unknown }).errName)
    expect('name' in lookalike).toBe(false)
    expect(lookalike instanceof Error).toBe(false)

    const fromClass = await runInstallCheck({ resolveSystemBinary: () => Promise.reject(error) })
    const fromName = await runInstallCheck({ resolveSystemBinary: () => Promise.reject(lookalike) })
    expect(fromClass.ok).toBe(false)
    expect(fromName).toEqual(fromClass)
  })
})

// ---------------------------------------------------------------------------
// The client minimum
// ---------------------------------------------------------------------------

describe('runInstallCheck: a client minimum that cannot be used fails floor unreadable (SRJ-212)', () => {
  test.each([
    ['a non-SemVer minimum', DEV_UNPARSEABLE_VERSION],
    ['a leading-v minimum', `v${CLIENT_MIN_VERSION}`],
  ])('%s (%s): floor-unreadable label; detail carries the minimum', async (_label, minimum) => {
    setFloorForTests(minimum)
    const failure = failureOf((await check({ version: PHASE1_RC_VERSION })).result)
    expect(failure.classLabel).toBe(AD_VERSION_FLOOR_UNREADABLE)
    expect(failure.detail).toEqual({ minBinaryVersion: minimum })
    expect(failure.message).toContain(minimum)
  })

  test.each([
    ['a malformed floor file', seededFloorFailure({ underlying: 'simulated JSON parse failure' })],
    ['a missing min_binary_version field', seededFloorFailure({ parsed: { unrelated_field: true } })],
  ])('%s: the floor-unreadable failure is returned unchanged; the resolver is never called', async (_label, seeded) => {
    setFloorForTests(seeded)
    const { result, calls } = await check()
    expect(result).toBe(seeded)
    expect(failureOf(result).classLabel).toBe(AD_VERSION_FLOOR_UNREADABLE)
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// No upgrade instruction anywhere (AC 81)
// ---------------------------------------------------------------------------

describe('runInstallCheck: no message and no note advises upgrading agent-director (SRJ-212, AC 81)', () => {
  /** Every case above, as a (floor seed, resolver) pair. */
  const SWEEP: ReadonlyArray<[label: string, floor: string | InstallCheckFailure, resolve: InstallCheckResolveSystemBinary]> = [
    ...[PHASE1_RC_VERSION, OLD_AD_VERSION, DEV_PLACEHOLDER_VERSION, CLIENT_MIN_VERSION, BELOW_CLIENT_MIN].map(
      (version): [string, string, InstallCheckResolveSystemBinary] => [
        `resolved ${version}`,
        CLIENT_MIN_VERSION,
        makeStubResolveSystemBinary({ version }),
      ],
    ),
    ...UNPARSEABLE_VERSIONS.map(([label, version]): [string, string, InstallCheckResolveSystemBinary] => [
      label,
      CLIENT_MIN_VERSION,
      makeStubResolveSystemBinary({ version }),
    ]),
    ['ErrSystemInstallTooOld', CLIENT_MIN_VERSION, makeStubResolveSystemBinary({ throws: errSystemInstallTooOld(BELOW_CLIENT_MIN, CLIENT_MIN_VERSION) })],
    ['ErrSystemInstallNotFound', CLIENT_MIN_VERSION, makeStubResolveSystemBinary({ throws: errSystemInstallNotFound() })],
    ...REASONS.map((reason): [string, string, InstallCheckResolveSystemBinary] => [
      `ErrSystemInstallUnreachable ${reason}`,
      CLIENT_MIN_VERSION,
      makeStubResolveSystemBinary({ throws: errSystemInstallUnreachable(reason) }),
    ]),
    ['a plain Error', CLIENT_MIN_VERSION, makeStubResolveSystemBinary({ throws: new Error(RAW_THROWN_TEXT) })],
    ['a minimum that is not a version', DEV_UNPARSEABLE_VERSION, makeStubResolveSystemBinary()],
    ['a seeded floor failure', seededFloorFailure({}), makeStubResolveSystemBinary()],
  ]

  test('every case: no message and no note carries an upgrade form or "Upgrade agent-director"', async () => {
    const texts: string[] = []
    for (const [label, floor, resolve] of SWEEP) {
      resetCacheForTests()
      setFloorForTests(floor)
      const result = await runInstallCheck({ resolveSystemBinary: resolve })
      const text = result.ok ? result.note : result.message
      if (text === undefined) continue
      texts.push(text)
      expect({ label, upgradeAgentDirector: /upgrade\s+agent-director/i.test(text) }).toEqual({
        label,
        upgradeAgentDirector: false,
      })
      for (const [form, pattern] of UPGRADE_FORMS) {
        expect({ label, form, matches: pattern.test(flat(text)) }).toEqual({ label, form, matches: false })
      }
    }
    // Every case but the one passing with no note produced a text to check.
    expect(texts).toHaveLength(SWEEP.length - 1)
  })
})
