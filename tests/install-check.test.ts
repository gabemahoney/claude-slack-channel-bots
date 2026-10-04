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
 *     with the reason in `detail`; a reason that is absent or not a short
 *     safe word is reported as `UNREACHABLE_REASON_UNKNOWN`;
 *   - a resolved version that does not parse (a leading `v` included) fails
 *     unreachable with reason `UNREACHABLE_REASON_UNPARSEABLE_VERSION`;
 *   - any other throw (an `Error`, a non-error, a synchronous throw) fails
 *     unreachable with reason `HOST_VERSION_FAIL_OTHER`, carrying none of the
 *     thrown text;
 *   - every text a failure copies from a thrown error (an unreachable error's
 *     diagnostic and signal, a not-found error's checked locations) or from a
 *     failed floor read (`underlying`) is one line with its fake token and
 *     URL redacted; a field of the wrong type is `null` (a non-list of
 *     checked locations is empty);
 *   - a value carrying only the matching `errName` maps as the class-built
 *     error does (errors are recognised by name);
 *   - a client minimum that is not a version fails floor unreadable;
 *   - a malformed floor file or a missing field (seeded failures) is returned
 *     unchanged, without calling the resolver;
 *   - the remedies (b.jg5 SRJ-208, SRJ-212; the E2-gate, E5 and E35 hatch
 *     notes): the shared pointer texts name the runbook section's title, the
 *     publishing-host block's heading (`PUBLISHING_HOST_BLOCK_HEADING`, from
 *     `tests/test-helpers/runbooks.ts`) and the client-package check; each of
 *     the five floor-unreadable failures carries the client-package remedy
 *     and the section title; the unreachable failure the section title and
 *     the install-cscb skill; the "other" failure the section title and "file
 *     a bug"; the not-found failure the publishing-host block and the section
 *     title. One case per failure, named;
 *   - one sweep: no message and no note carries an upgrade or re-install
 *     instruction or command (`UPGRADE_FORMS`, its re-install row included,
 *     and "Upgrade agent-director" in any case), an instruction to install
 *     agent-director or a file removal (`INSTALL_OR_REMOVAL_FORMS`); each
 *     finding names its case. Self-checks: each `INSTALL_OR_REMOVAL_FORMS`
 *     sample is flagged by its own row, and that list does not flag the
 *     remedies' own wording. The re-install row's self-checks live with
 *     `UPGRADE_FORMS`' others in shipped-docs.test.ts.
 *
 * `readClientMinVersion` over its injected resolver and reader:
 *   - a readable floor file gives its `min_binary_version` (a string that is
 *     not a version included), read once from the resolved path;
 *   - a throwing reader gives the canned floor-unreadable (read) failure; a
 *     throwing resolver the resolve failure, without reading; a non-`file:`
 *     URL the read failure, without reading; malformed JSON the parse
 *     failure; a missing, empty or non-string field (or a non-object
 *     document) the missing-field failure, with the parsed document; the
 *     four modes carry four distinct messages. A thrown `Error`'s message is
 *     `underlying`, one line with its fake token and URL redacted; a thrown
 *     string's is `null`;
 *   - a call with any dep injected neither returns nor stores the cached
 *     floor; an empty deps object uses the cache.
 *
 * No module is mocked. The resolver is always injected
 * (`makeStubResolveSystemBinary`). The client minimum comes from the
 * floor-cache seam: seeded with `CLIENT_MIN_VERSION` before each case and
 * reset after it. The not-found, unreachable and floor-read failures are compared whole with
 * `cannedFailureResult`, so the canned texts stay the source's. Every
 * version, label, reason word and title comes from `src/` or
 * `tests/test-helpers/`; every token is a fake from the credentials helper,
 * and every case that plants one runs `assertNoLeak` over its result.
 *
 * SPDX-License-Identifier: MIT
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  buildInstallCheckPhase1Note,
  buildSystemInstallTooOldMessage,
  HOST_VERSION_FAIL_OTHER,
  INSTALL_CHECK_PHASE1_NOTE_PHRASE,
  PHASE1_RUNBOOK_SECTION_TITLE,
  UNREACHABLE_REASON_UNKNOWN,
  UNREACHABLE_REASON_UNPARSEABLE_VERSION,
} from '../src/ad-version-gate.ts'
import {
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
  AD_VERSION_FLOOR_UNREADABLE,
  CLIENT_PACKAGE_REMEDY,
  PUBLISHING_HOST_BLOCK_POINTER,
  RUNBOOK_SECTION_POINTER,
  type InstallCheckFailure,
  type InstallCheckResolveSystemBinary,
  type InstallCheckResult,
  readClientMinVersion,
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
  BELOW_CLIENT_MIN_VERSION,
  CLIENT_MIN_VERSION,
  DEV_PLACEHOLDER_VERSION,
  DEV_UNPARSEABLE_VERSION,
  FLOOR_SUBPATH,
  OLD_AD_VERSION,
  PHASE1_RC_VERSION,
} from './test-helpers/agent-director-versions.ts'
import {
  assertNoLeak,
  BOT_TOKEN_PREFIX,
  fakeToken,
  REDACTED_SENTINEL_TAIL,
  sentinelInMessage,
  sentinelTicketUrl,
} from './test-helpers/credentials.ts'
import {
  cannedFailureResult,
  makeMalformedFloorJson,
  makeMissingFieldFloorJson,
  makeVersionFloorJson,
  UNREACHABLE_REASONS,
} from './test-helpers/install-check-fixtures.ts'
import { flat } from './test-helpers/markdown.ts'
import { PUBLISHING_HOST_BLOCK_HEADING } from './test-helpers/runbooks.ts'
import { INSTALL_OR_REMOVAL_FORMS, UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A distinct host binary path per case, so a result shows the path it was given is passed through. */
const binaryPath = (label: string): string => join(tmpdir(), 'cscb-install-check', label, 'agent-director')

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

/** The `errName` agent-director's `ErrSystemInstallUnreachable` and `ErrSystemInstallNotFound` carry. */
const UNREACHABLE_ERR_NAME = errSystemInstallUnreachable().errName
const NOT_FOUND_ERR_NAME = errSystemInstallNotFound().errName

/** An unreachable failure's detail with no diagnostic, exit code or signal. */
const unreachableDetail = (reason: string, path: string): Record<string, unknown> => ({
  reason,
  binaryPath: path,
  diagnostic: null,
  exitCode: null,
  signal: null,
})

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

/** A floor file URL an injected resolver returns, and the path the reader is then given. */
const FLOOR_PATH = join(tmpdir(), 'cscb-install-check', 'floor', 'version-floor.json')
const FLOOR_URL = pathToFileURL(FLOOR_PATH).href

/** A reader answering `text` and recording the paths it was given. */
function readerOf(text: string): { readFile: (path: string) => string; paths: string[] } {
  const paths: string[] = []
  return {
    readFile: (path) => {
      paths.push(path)
      return text
    },
    paths,
  }
}

/** A reader throwing `thrown` and recording the paths it was given. */
function throwingReader(thrown: unknown): { readFile: (path: string) => string; paths: string[] } {
  const paths: string[] = []
  return {
    readFile: (path) => {
      paths.push(path)
      throw thrown
    },
    paths,
  }
}

/** The floor-unreadable failure of a floor read; throws on a version or another label. */
function floorFailureOf(result: string | InstallCheckFailure): InstallCheckFailure {
  if (typeof result === 'string') throw new Error(`expected a floor failure, got the version ${result}`)
  if (result.classLabel !== AD_VERSION_FLOOR_UNREADABLE) throw new Error(`expected a floor failure, got ${result.classLabel}`)
  return result
}

/**
 * One real `readClientMinVersion` failure per failure mode, each built
 * through the injected resolver and reader (uncached).
 */
const FLOOR_READ_FAILURES: ReadonlyArray<[mode: string, failure: InstallCheckFailure]> = [
  [
    'resolve',
    floorFailureOf(
      readClientMinVersion({
        resolveFloorUrl: () => {
          throw new Error(RAW_THROWN_TEXT)
        },
      }),
    ),
  ],
  ['read', floorFailureOf(readClientMinVersion({ resolveFloorUrl: () => FLOOR_URL, readFile: throwingReader(new Error(RAW_THROWN_TEXT)).readFile }))],
  ['parse', floorFailureOf(readClientMinVersion({ resolveFloorUrl: () => FLOOR_URL, readFile: readerOf(makeMalformedFloorJson()).readFile }))],
  ['missing-field', floorFailureOf(readClientMinVersion({ resolveFloorUrl: () => FLOOR_URL, readFile: readerOf(makeMissingFieldFloorJson()).readFile }))],
]

beforeEach(() => {
  resetCacheForTests()
  setFloorForTests(CLIENT_MIN_VERSION)
})

afterEach(() => {
  resetCacheForTests()
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
    ['a resolved version below the client minimum', 'resolved', { version: BELOW_CLIENT_MIN_VERSION, path: binaryPath('resolved-too-old') }],
    [
      'ErrSystemInstallTooOld',
      'thrown',
      { throws: errSystemInstallTooOld(BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION, binaryPath('thrown-too-old')) },
    ],
  ] as const)('%s: too-old label; message names found, required, path and the runbook section', async (_label, kind, opts) => {
    const path = binaryPath(`${kind}-too-old`)
    const failure = failureOf((await check(opts)).result)
    expect(failure.classLabel).toBe(AD_SYSTEM_INSTALL_TOO_OLD)
    expect(failure.detail).toEqual({ detected: BELOW_CLIENT_MIN_VERSION, required: CLIENT_MIN_VERSION, binaryPath: path })
    expect(failure.message).toBe(
      buildSystemInstallTooOldMessage({ foundVersion: BELOW_CLIENT_MIN_VERSION, requiredVersion: CLIENT_MIN_VERSION, binaryPath: path }),
    )
    for (const part of [BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION, path, PHASE1_RUNBOOK_SECTION_TITLE]) {
      expect(failure.message).toContain(part)
    }
  })
})

describe('runInstallCheck: ErrSystemInstallNotFound fails not found (SRJ-212)', () => {
  test('not-found label; detail carries the checked locations; the whole result is the canned not-found failure', async () => {
    const checkedLocations = [{ kind: 'path-lookup' as const, detail: null }]
    const failure = failureOf((await check({ throws: errSystemInstallNotFound(checkedLocations) })).result)
    expect(failure).toEqual(cannedFailureResult(AD_SYSTEM_INSTALL_NOT_FOUND, { detail: { checkedLocations } }))
  })
})

describe('runInstallCheck: ErrSystemInstallUnreachable, all eight reasons, fails unreachable (SRJ-212)', () => {
  test.each([...UNREACHABLE_REASONS])('reason %s: the whole result is the canned unreachable failure, naming the reason and path', async (reason) => {
    const path = binaryPath(`unreachable-${reason}`)
    const failure = failureOf((await check({ throws: errSystemInstallUnreachable(reason, null, path) })).result)
    expect(failure).toEqual(cannedFailureResult(AD_SYSTEM_INSTALL_UNREACHABLE, { detail: unreachableDetail(reason, path) }))
    expect(failure.message).toContain(reason)
    expect(failure.message).toContain(path)
  })

  test.each([
    ['no reason', {}],
    ['a token-bearing reason', { reason: fakeToken(BOT_TOKEN_PREFIX, 'reason') }],
    ['a reason with a line break', { reason: `${UNREACHABLE_REASONS[0]}\n${UNREACHABLE_REASONS[1]}` }],
  ])('%s: reported as UNREACHABLE_REASON_UNKNOWN, in detail and message, with no credential', async (label, fields) => {
    const path = binaryPath(`unreachable-unknown-${label.replaceAll(' ', '-')}`)
    const thrown = { errName: UNREACHABLE_ERR_NAME, binaryPath: path, ...fields }
    const failure = failureOf(await runInstallCheck({ resolveSystemBinary: () => Promise.reject(thrown) }))
    expect(failure).toEqual(
      cannedFailureResult(AD_SYSTEM_INSTALL_UNREACHABLE, { detail: unreachableDetail(UNREACHABLE_REASON_UNKNOWN, path) }),
    )
    assertNoLeak(failure, label)
  })
})

describe('runInstallCheck: text copied from a thrown error is one token-free line', () => {
  test("ErrSystemInstallUnreachable: the diagnostic and signal are redacted to one line; the exit code is kept", async () => {
    const path = binaryPath('unreachable-redacted')
    const [reason] = UNREACHABLE_REASONS
    const error = Object.assign(
      errSystemInstallUnreachable(reason, `probe said (${sentinelInMessage('diagnostic')})\r\nsecond line\n\nthird line`, path),
      { exitCode: 3, signal: `(${sentinelInMessage('signal')})\u2028after` },
    )
    const failure = failureOf((await check({ throws: error })).result)
    expect(failure).toEqual(
      cannedFailureResult(AD_SYSTEM_INSTALL_UNREACHABLE, {
        detail: {
          reason,
          binaryPath: path,
          diagnostic: `probe said (${REDACTED_SENTINEL_TAIL}) second line third line`,
          exitCode: 3,
          signal: `(${REDACTED_SENTINEL_TAIL}) after`,
        },
      }),
    )
    assertNoLeak(failure, 'unreachable')
  })

  test('ErrSystemInstallUnreachable: a diagnostic or signal that is not a string, or an exit code that is not a number, is null', async () => {
    const path = binaryPath('unreachable-wrong-types')
    const [reason] = UNREACHABLE_REASONS
    const thrown = { errName: UNREACHABLE_ERR_NAME, binaryPath: path, reason, diagnostic: 7, exitCode: '3', signal: { name: 'SIGKILL' } }
    const failure = failureOf(await runInstallCheck({ resolveSystemBinary: () => Promise.reject(thrown) }))
    expect(failure).toEqual(cannedFailureResult(AD_SYSTEM_INSTALL_UNREACHABLE, { detail: unreachableDetail(reason, path) }))
  })

  test("ErrSystemInstallNotFound: each checked location's detail is redacted to one line; its kind is kept", async () => {
    const error = errSystemInstallNotFound([
      { kind: 'path-lookup', detail: `/opt/bin:${sentinelInMessage('path')}\n/usr/bin` },
      { kind: 'standard-install-path', detail: null },
    ])
    const failure = failureOf((await check({ throws: error })).result)
    expect(failure).toEqual(
      cannedFailureResult(AD_SYSTEM_INSTALL_NOT_FOUND, {
        detail: {
          checkedLocations: [
            { kind: 'path-lookup', detail: `/opt/bin:${REDACTED_SENTINEL_TAIL} /usr/bin` },
            { kind: 'standard-install-path', detail: null },
          ],
        },
      }),
    )
    assertNoLeak(failure, 'not-found')
  })

  test.each([
    ['a string', sentinelInMessage('locations')],
    ['an object', { detail: sentinelInMessage('locations') }],
    ['missing', undefined],
  ])('ErrSystemInstallNotFound whose checked locations are %s: an empty list, with no credential', async (label, checkedLocations) => {
    const thrown = { errName: NOT_FOUND_ERR_NAME, checkedLocations }
    const failure = failureOf(await runInstallCheck({ resolveSystemBinary: () => Promise.reject(thrown) }))
    expect(failure).toEqual(cannedFailureResult(AD_SYSTEM_INSTALL_NOT_FOUND, { detail: { checkedLocations: [] } }))
    assertNoLeak(failure, label)
  })
})

describe('runInstallCheck: a resolved version that does not parse fails, never passes (SRJ-212)', () => {
  test.each(UNPARSEABLE_VERSIONS)('%s (%s): unreachable label, reason unparseable-version', async (label, version) => {
    const path = binaryPath(`unparseable-${label.replaceAll(' ', '-')}`)
    const failure = failureOf((await check({ version, path })).result)
    expect(failure.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
    expect(failure.detail.reason).toBe(UNREACHABLE_REASON_UNPARSEABLE_VERSION)
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
    expect(failure.detail.reason).toBe(HOST_VERSION_FAIL_OTHER)
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
    ['ErrSystemInstallTooOld', errSystemInstallTooOld(BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION, binaryPath('by-name-too-old'))],
    ['ErrSystemInstallUnreachable', errSystemInstallUnreachable(UNREACHABLE_REASONS[0], null, binaryPath('by-name-unreachable'))],
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

describe('readClientMinVersion: each failed floor read, over the injected resolver and reader (SRJ-212)', () => {
  /** The canned read failure's message: the text every other failure mode must differ from. */
  const READ_FAILURE_MESSAGE = cannedFailureResult(AD_VERSION_FLOOR_UNREADABLE).message

  test('a readable floor file: its min_binary_version, read once from the resolved path', () => {
    const { readFile, paths } = readerOf(makeVersionFloorJson(OLD_AD_VERSION))
    expect(readClientMinVersion({ resolveFloorUrl: () => FLOOR_URL, readFile })).toBe(OLD_AD_VERSION)
    expect(paths).toEqual([FLOOR_PATH])
  })

  test('a minimum that is a string but not a version: returned as is (runInstallCheck refuses it)', () => {
    const { readFile } = readerOf(makeVersionFloorJson(DEV_UNPARSEABLE_VERSION))
    expect(readClientMinVersion({ resolveFloorUrl: () => FLOOR_URL, readFile })).toBe(DEV_UNPARSEABLE_VERSION)
  })

  test.each([
    [
      'an Error whose message holds a fake token, a URL and line breaks',
      new Error(`read failed (${sentinelInMessage('floor')})\r\nsecond line\n\nthird line`),
      `read failed (${REDACTED_SENTINEL_TAIL}) second line third line`,
    ],
    ['a thrown string (no message)', sentinelInMessage('floor-string'), null],
  ])('the reader throws %s: the canned floor-unreadable failure, its underlying redacted to one line', (label, thrown, underlying) => {
    const { readFile, paths } = throwingReader(thrown)
    const result = readClientMinVersion({ resolveFloorUrl: () => FLOOR_URL, readFile })
    expect(paths).toEqual([FLOOR_PATH])
    expect(result).toEqual(cannedFailureResult(AD_VERSION_FLOOR_UNREADABLE, { detail: { underlying } }))
    assertNoLeak(result, label)
  })

  test('the default resolver with a throwing reader: the reader is given the installed floor file, and fails as a read', () => {
    const { readFile, paths } = throwingReader(new Error(sentinelInMessage('floor-default-resolver')))
    const result = readClientMinVersion({ readFile })
    expect(paths).toEqual([fileURLToPath(import.meta.resolve(FLOOR_SUBPATH))])
    expect(result).toEqual(cannedFailureResult(AD_VERSION_FLOOR_UNREADABLE, { detail: { underlying: REDACTED_SENTINEL_TAIL } }))
    assertNoLeak(result, 'default resolver')
  })

  test('a resolved URL that is not a file: URL: the canned read failure; the reader is never called', () => {
    const { readFile, paths } = readerOf(makeVersionFloorJson(CLIENT_MIN_VERSION))
    const result = readClientMinVersion({ resolveFloorUrl: () => sentinelTicketUrl(), readFile })
    expect(paths).toHaveLength(0)
    expect(result).toEqual(cannedFailureResult(AD_VERSION_FLOOR_UNREADABLE, { detail: { underlying: expect.any(String) } }))
    assertNoLeak(result, 'non-file URL')
  })

  test.each([
    [
      'an Error whose message holds a fake token, a URL and line breaks',
      new Error(`resolve failed (${sentinelInMessage('resolve')})\nsecond line`),
      `resolve failed (${REDACTED_SENTINEL_TAIL}) second line`,
    ],
    ['a thrown string (no message)', sentinelInMessage('resolve-string'), null],
  ])('the resolver throws %s: the resolve failure, its underlying redacted to one line; the reader is never called', (label, thrown, underlying) => {
    const { readFile, paths } = readerOf(makeVersionFloorJson(CLIENT_MIN_VERSION))
    const failure = floorFailureOf(
      readClientMinVersion({
        resolveFloorUrl: () => {
          throw thrown
        },
        readFile,
      }),
    )
    expect(paths).toHaveLength(0)
    expect(failure.detail).toEqual({ underlying })
    expect(failure.message).not.toBe(READ_FAILURE_MESSAGE)
    assertNoLeak(failure, label)
  })

  test('malformed JSON: the parse failure, its underlying one line; distinct from the read failure', () => {
    const { readFile } = readerOf(makeMalformedFloorJson())
    const failure = floorFailureOf(readClientMinVersion({ resolveFloorUrl: () => FLOOR_URL, readFile }))
    expect(Object.keys(failure.detail)).toEqual(['underlying'])
    expect(typeof failure.detail.underlying).toBe('string')
    expect(String(failure.detail.underlying)).not.toMatch(/[\r\n\u2028\u2029]/)
    expect(failure.message).not.toBe(READ_FAILURE_MESSAGE)
  })

  test('malformed JSON holding a fake token: the parse failure carries no credential', () => {
    const { readFile } = readerOf(`{ "min_binary_version": ${sentinelInMessage('parse')}`)
    const failure = floorFailureOf(readClientMinVersion({ resolveFloorUrl: () => FLOOR_URL, readFile }))
    assertNoLeak(failure, 'parse')
  })

  /** Parsed floor documents with no usable `.min_binary_version`. */
  const UNUSABLE_FLOORS: ReadonlyArray<[label: string, parsed: unknown]> = [
    ['a missing field', JSON.parse(makeMissingFieldFloorJson())],
    ['an empty string', { min_binary_version: '' }],
    ['a number', { min_binary_version: 7 }],
    ['null', { min_binary_version: null }],
    ['a JSON null document', null],
    ['a JSON array document', [CLIENT_MIN_VERSION]],
  ]

  test.each(UNUSABLE_FLOORS)('%s: the missing-field failure, its detail the parsed document', (_label, parsed) => {
    const { readFile } = readerOf(JSON.stringify(parsed))
    const failure = floorFailureOf(readClientMinVersion({ resolveFloorUrl: () => FLOOR_URL, readFile }))
    expect(failure.detail).toEqual({ parsed })
    expect(failure.message).not.toBe(READ_FAILURE_MESSAGE)
  })

  test('the four failure modes (resolve, read, parse, missing field) carry four distinct messages', () => {
    const messages = FLOOR_READ_FAILURES.map(([, failure]) => failure.message)
    expect(FLOOR_READ_FAILURES.map(([mode]) => mode)).toEqual(['resolve', 'read', 'parse', 'missing-field'])
    expect(new Set(messages).size).toBe(messages.length)
    expect(messages[1]).toBe(READ_FAILURE_MESSAGE)
  })
})

describe('readClientMinVersion: a call with an injected dep bypasses the floor cache', () => {
  /** An injected reader answering `version`'s floor document. */
  const readFloor = (version: string) => (): string => makeVersionFloorJson(version)

  test('a seeded cache is neither returned nor replaced by a call with an injected reader', () => {
    // The file-level beforeEach seeds CLIENT_MIN_VERSION.
    expect(readClientMinVersion({ readFile: readFloor(OLD_AD_VERSION) })).toBe(OLD_AD_VERSION)
    expect(readClientMinVersion()).toBe(CLIENT_MIN_VERSION)
  })

  test('a seeded cache is neither returned nor replaced by a call with only an injected resolver', () => {
    const failure = readClientMinVersion({
      resolveFloorUrl: () => {
        throw new Error(RAW_THROWN_TEXT)
      },
    })
    expect(typeof failure).not.toBe('string')
    expect(readClientMinVersion()).toBe(CLIENT_MIN_VERSION)
  })

  test('a seeded failure is not returned to a call with an injected reader', () => {
    const seeded = seededFloorFailure({ underlying: RAW_THROWN_TEXT })
    setFloorForTests(seeded)
    expect(readClientMinVersion({ readFile: readFloor(OLD_AD_VERSION) })).toBe(OLD_AD_VERSION)
    expect(readClientMinVersion()).toBe(seeded)
  })

  test('after a reset, a failed injected read is not cached: the next no-arg call reads the installed floor file', () => {
    resetCacheForTests()
    const failure = readClientMinVersion({ readFile: () => {
        throw new Error(RAW_THROWN_TEXT)
      }, })
    expect(typeof failure).not.toBe('string')
    expect(readClientMinVersion()).toBe(CLIENT_MIN_VERSION)
  })

  test('after a reset, a successful injected read is not cached: the next no-arg call reads the installed floor file', () => {
    resetCacheForTests()
    expect(readClientMinVersion({ readFile: readFloor(OLD_AD_VERSION) })).toBe(OLD_AD_VERSION)
    expect(readClientMinVersion()).toBe(CLIENT_MIN_VERSION)
  })

  test('an empty deps object uses the cache as a no-arg call does', () => {
    expect(readClientMinVersion({})).toBe(CLIENT_MIN_VERSION)
    const seeded = seededFloorFailure({})
    setFloorForTests(seeded)
    expect(readClientMinVersion({})).toBe(seeded)
  })
})

// ---------------------------------------------------------------------------
// The remedies: the runbook section, no install, re-install or removal
// (b.jg5 SRJ-208, SRJ-212; E2-gate, E5 and E35 hatch notes)
// ---------------------------------------------------------------------------

/** SRJ-208's client-package check, in the SRD's words. */
const CLIENT_PACKAGE_CHECK = 'Check the agent-director npm package installed with CSCB'

describe('runInstallCheck: each failure points to the switch-over runbook and names no install (SRJ-208, SRJ-212)', () => {
  test('the shared texts: the section by its title, its publishing-host block by its heading, the client-package check with the section', () => {
    expect(RUNBOOK_SECTION_POINTER).toContain(`"${PHASE1_RUNBOOK_SECTION_TITLE}"`)
    expect(PUBLISHING_HOST_BLOCK_POINTER).toContain(`"${PUBLISHING_HOST_BLOCK_HEADING}"`)
    expect(PUBLISHING_HOST_BLOCK_POINTER).toContain(RUNBOOK_SECTION_POINTER)
    expect(CLIENT_PACKAGE_REMEDY.startsWith(CLIENT_PACKAGE_CHECK)).toBe(true)
    expect(CLIENT_PACKAGE_REMEDY).toContain(RUNBOOK_SECTION_POINTER)
    expect(CLIENT_PACKAGE_REMEDY).not.toContain('@latest')
  })

  /** The floor-unreadable failure a minimum that is not a version gives. */
  async function notAVersionFailure(): Promise<InstallCheckFailure> {
    setFloorForTests(DEV_UNPARSEABLE_VERSION)
    return failureOf((await check({ version: PHASE1_RC_VERSION })).result)
  }

  /** The five floor-unreadable failures: the four failed reads and a minimum that is not a version. */
  const FLOOR_UNREADABLE_CASES: ReadonlyArray<[mode: string, failure: () => InstallCheckFailure | Promise<InstallCheckFailure>]> = [
    ...FLOOR_READ_FAILURES.map(([mode, failure]): [string, () => InstallCheckFailure] => [mode, () => failure]),
    ['a minimum that is not a version', notAVersionFailure],
  ]

  test.each(FLOOR_UNREADABLE_CASES)('floor unreadable (%s): the client-package remedy naming the section title, no @latest', async (_mode, failureFor) => {
    const failure = await failureFor()
    expect(failure.classLabel).toBe(AD_VERSION_FLOOR_UNREADABLE)
    expect(failure.message).toContain(CLIENT_PACKAGE_REMEDY)
    expect(failure.message).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    expect(failure.message).not.toContain('@latest')
  })

  test('unreachable: the section title, and the install-cscb skill kept', async () => {
    const failure = failureOf((await check({ throws: errSystemInstallUnreachable(UNREACHABLE_REASONS[0]) })).result)
    expect(failure.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
    expect(failure.message).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    expect(failure.message).toContain('install-cscb skill')
  })

  test('other: the section title, and "file a bug" kept', async () => {
    const failure = failureOf((await check({ throws: new Error(RAW_THROWN_TEXT) })).result)
    expect(failure.detail.reason).toBe(HOST_VERSION_FAIL_OTHER)
    expect(failure.message).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    expect(failure.message).toContain('file a bug')
  })

  test('not found: the publishing-host block by its heading, in the section by its title', async () => {
    const failure = failureOf((await check({ throws: errSystemInstallNotFound() })).result)
    expect(failure.classLabel).toBe(AD_SYSTEM_INSTALL_NOT_FOUND)
    expect(failure.message).toContain(`"${PUBLISHING_HOST_BLOCK_HEADING}"`)
    expect(failure.message).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
  })
})

// ---------------------------------------------------------------------------
// No upgrade, re-install, install or removal instruction anywhere (AC 81)
// ---------------------------------------------------------------------------

describe('the forbidden forms the sweep adds: self-checks', () => {
  test.each(INSTALL_OR_REMOVAL_FORMS)('the %s row flags its own sample', (_label, pattern, sample) => {
    expect(pattern.test(flat(sample))).toBe(true)
  })

  // The re-install row's self-checks sit with UPGRADE_FORMS' other
  // self-checks, in shipped-docs.test.ts.
  test.each([
    ['the client-package remedy', CLIENT_PACKAGE_REMEDY],
    ['the publishing-host pointer', PUBLISHING_HOST_BLOCK_POINTER],
    ['the install-cscb skill', 'Diagnose with the install-cscb skill.'],
    ['the too-old message', buildSystemInstallTooOldMessage({ foundVersion: BELOW_CLIENT_MIN_VERSION, requiredVersion: CLIENT_MIN_VERSION, binaryPath: binaryPath('self-check') })],
  ])('the install-or-removal rows do not flag %s', (_name, text) => {
    expect(INSTALL_OR_REMOVAL_FORMS.filter(([, pattern]) => pattern.test(flat(text))).map(([label]) => label)).toEqual([])
  })

  test.each([
    'Install agent-director system-wide and retry.',
    'Operator recovery: install agent-director, then rerun.',
    'install agent-director by following your own notes',
  ])('the install row flags an install instruction that does not follow the switch-over runbook: %s', (text) => {
    expect(INSTALL_OR_REMOVAL_FORMS[0]![1].test(flat(text))).toBe(true)
  })
})

describe('runInstallCheck: no message and no note advises upgrading, re-installing or installing agent-director, or removing a file (SRJ-208, SRJ-212, AC 81)', () => {
  /** Every case above, as a (floor seed, resolver) pair. */
  const SWEEP: ReadonlyArray<[label: string, floor: string | InstallCheckFailure, resolve: InstallCheckResolveSystemBinary]> = [
    ...[PHASE1_RC_VERSION, OLD_AD_VERSION, DEV_PLACEHOLDER_VERSION, CLIENT_MIN_VERSION, BELOW_CLIENT_MIN_VERSION].map(
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
    ['ErrSystemInstallTooOld', CLIENT_MIN_VERSION, makeStubResolveSystemBinary({ throws: errSystemInstallTooOld(BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION) })],
    ['ErrSystemInstallNotFound', CLIENT_MIN_VERSION, makeStubResolveSystemBinary({ throws: errSystemInstallNotFound() })],
    ...UNREACHABLE_REASONS.map((reason): [string, string, InstallCheckResolveSystemBinary] => [
      `ErrSystemInstallUnreachable ${reason}`,
      CLIENT_MIN_VERSION,
      makeStubResolveSystemBinary({ throws: errSystemInstallUnreachable(reason) }),
    ]),
    ['a plain Error', CLIENT_MIN_VERSION, makeStubResolveSystemBinary({ throws: new Error(RAW_THROWN_TEXT) })],
    ['a minimum that is not a version', DEV_UNPARSEABLE_VERSION, makeStubResolveSystemBinary()],
    ['a seeded floor failure', seededFloorFailure({}), makeStubResolveSystemBinary()],
    ...FLOOR_READ_FAILURES.map(([label, failure]): [string, InstallCheckFailure, InstallCheckResolveSystemBinary] => [
      `a floor ${label} failure`,
      failure,
      makeStubResolveSystemBinary(),
    ]),
  ]

  test('every case: no message and no note carries an upgrade, re-install, install or removal form, or "Upgrade agent-director"', async () => {
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
      for (const [form, pattern] of [...UPGRADE_FORMS, ...INSTALL_OR_REMOVAL_FORMS]) {
        expect({ label, form, matches: pattern.test(flat(text)) }).toEqual({ label, form, matches: false })
      }
    }
    // Every case but the one passing with no note produced a text to check.
    expect(texts).toHaveLength(SWEEP.length - 1)
  })
})
