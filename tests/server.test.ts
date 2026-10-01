import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  assertSendable,
  chunkText,
  sanitizeFilename,
} from '../src/lib.ts'
import type { Client } from 'agent-director'
import {
  AD_CALL_KILL_ROW_READ_LIVE,
  CSCB_UNKNOWN_ERROR_NAME,
  describeAgentDirectorFailure,
} from '../src/ad-error-class.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_READING_DEAD,
  LIVENESS_READING_LIVE,
  LIVENESS_READING_PENDING,
  LIVENESS_READING_UNKNOWN,
  LIVENESS_PENDING,
  launchStartOfReading,
  livenessReadingForStatus,
  pendingLaunchStartOf,
  pendingLivenessReading,
  type LivenessReading,
} from '../src/liveness-reading.ts'
import type { Phase1StatusResult } from '../src/ad-phase1-types.ts'
import {
  ALL_CLEAR_TEMPLATE,
  ONSET_TEMPLATES,
  _resetOutageState,
  adConfigMalformedOnset,
  initOutageState,
  getOutageFlags,
  raiseAdConfigMalformed,
  setOutageFlag,
  tmuxServerChangedOnset,
  withOutageDetection,
  type OutageClass,
} from '../src/outage-state.ts'
import {
  getClient,
  setClientForTests,
  resetClientForTests,
} from '../src/agent-director-client.ts'
import {
  cannedErr,
  cannedGetResult,
  cannedStatusResult,
  makeCloseCountingStubClient,
  makeStubClient,
  makeStubCreateClient,
  errCallTimeout,
  errConfigMalformed,
  errGeneric,
  errInternal,
  errSchemaMismatch,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errSpawnNotResumable,
  errSystemInstallDisappeared,
  errTmuxCaptureFailed,
  errTmuxNotAvailable,
  errTmuxNotAvailableDifferentServer,
  errTmuxSendKeys,
  errTmuxUnresponsive,
  errUnknownErrorName,
  errUnusableName,
  holdSpawns,
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_START_NONE,
  SAMPLE_LAUNCH_START_WHOLE,
  type CloseCountingStubClient,
  type StubClient,
  unavailableForms,
} from './test-helpers/agent-director-stub.ts'
import {
  _buildIsSessionAliveAdapter,
  _buildKillSessionAdapter,
  _buildReconnectSessionAdapter,
  _runCallTimeoutStartStep,
  deferPendingRow,
  LAUNCH_START_LOG_RE,
} from '../src/server.ts'
import { buildPersonaClientOrExit, type PersonaClientDeps } from '../src/agent-director-startup.ts'
import {
  DEFAULT_AD_SETTINGS_IN_EFFECT,
  adCallTimeoutNeed,
  adSettingsInEffect,
  buildAdCallTimeoutWarningLine,
  installAdSettings,
  resetAdSettingsForTests,
  type AdSettingsInEffect,
} from '../src/ad-settings.ts'
import { writeAgentDirectorConfig } from './test-helpers/ad-settings.ts'
import {
  _resetFindMissingMemo,
  _setFindMissingMemoTtlMs,
  _setTmuxServerEnsurer,
  _resetTmuxServerEnsurer,
  _setTmuxSessionProber,
  _resetTmuxSessionProber,
  _setSpawnHomeDir,
  _resetSpawnHomeDir,
  _resetInFlightLaunches,
  _resetNotConnectedEpisodes,
  _resetNow,
  _setNow,
  STALE_WORKING_WINDOW_MS,
  forgetNotConnectedEpisode,
  hasPendingWorkingRowEvidence,
  isLaunchInFlight,
  setSessionNotifier,
  spawnForPersona,
} from '../src/session-manager.ts'
import type { ClientOptions, FindMissingParams, KillParams, ReadPaneParams, ResumeParams, SendKeysParams, SendKeysResult, SpawnParams, StatusParams } from 'agent-director'
import { KILL_SESSION_REFUSED, type KillSessionResult } from '../src/restart.ts'
import {
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED,
  isInsideAttempt,
  runInAttempt,
} from '../src/unavailable-retry.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import {
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MCP_SERVER_NAME,
  type Persona,
  type PersonaConfig,
} from '../src/config.ts'
import { resolveJsonlPath } from '../src/cozempic.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
import { makePersonaConfig, makeStandInPersonaConfig } from './test-helpers/persona-config.ts'
import {
  APP_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
  writeCredentialsFile,
} from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import {
  IDLE_PANE,
  PERMISSION_PANE,
  SPINNER_PANE,
  TRANSCRIPT_SESSION_ID,
  endedTurn,
  writeTranscript,
} from './test-helpers/working-row-panes.ts'

// ---------------------------------------------------------------------------
// assertSendable()
// ---------------------------------------------------------------------------

describe('assertSendable', () => {
  const stateDir = '/home/user/.claude/channels/slack'
  const inboxDir = '/home/user/.claude/channels/slack/inbox'

  test('blocks .env in state dir', () => {
    expect(() => assertSendable(`${stateDir}/.env`, stateDir, inboxDir, [])).toThrow('Blocked')
  })

  test('blocks config.json in state dir', () => {
    expect(() => assertSendable(`${stateDir}/config.json`, stateDir, inboxDir, [])).toThrow('Blocked')
  })

  test('blocks nested files in state dir', () => {
    expect(() => assertSendable(`${stateDir}/subdir/secret`, stateDir, inboxDir, [])).toThrow('Blocked')
  })

  test('allows files in inbox/', () => {
    expect(() => assertSendable(`${inboxDir}/photo.png`, stateDir, inboxDir, [])).not.toThrow()
  })

  test('allows files outside state dir entirely', () => {
    expect(() => assertSendable('/tmp/output.txt', stateDir, inboxDir, [])).not.toThrow()
  })

  test('allows home directory files', () => {
    expect(() => assertSendable('/home/user/project/file.ts', stateDir, inboxDir, [])).not.toThrow()
  })

  test('blocks traversal into state dir via ..', () => {
    // Path that traverses out of inbox/ back into the protected state dir
    expect(() => assertSendable(`${inboxDir}/../config.json`, stateDir, inboxDir, [])).toThrow()
  })

  // Directory boundaries: a prefix match counts only at a path separator.
  test.each([
    ['a sibling of inbox/ whose name starts with "inbox"', `${stateDir}/inbox-old/secret`],
    ['the state dir itself', stateDir],
    ['traversal out of inbox/ into an "inbox"-prefixed sibling', `${inboxDir}/../inbox-old/secret`],
  ])('blocks %s', (_label, filePath) => {
    expect(() => assertSendable(filePath, stateDir, inboxDir, []))
      .toThrow('cannot send files from state directory')
  })

  test('does not treat a sibling directory named after the state dir as the state dir', () => {
    expect(() => assertSendable(`${stateDir}2/secret`, stateDir, inboxDir, [])).not.toThrow()
  })

  test('tolerates a trailing separator on the state and inbox directories', () => {
    expect(() => assertSendable(`${stateDir}/config.json`, `${stateDir}/`, `${inboxDir}/`, []))
      .toThrow('cannot send files from state directory')
    expect(() => assertSendable(`${inboxDir}/photo.png`, `${stateDir}/`, `${inboxDir}/`, [])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// assertSendable(): the state-dir rule on real paths (b.av2 SR-5.2)
// ---------------------------------------------------------------------------

describe('assertSendable: state-dir rule on real paths', () => {
  // Real files under a temp dir, realpath'd because the OS temp directory may
  // itself be a symlink. Layout:
  //   <dir>/state/config.json                a state-dir file outside inbox/
  //   <dir>/state/inbox/photo.png            an inbox file
  //   <dir>/state/inbox/to-config          -> state/config.json
  //   <dir>/state/inbox-old/secret           a sibling of inbox/
  //   <dir>/state2/secret                    a sibling of the state dir
  //   <dir>/outside/to-config              -> state/config.json
  //   <dir>/outside/to-photo               -> state/inbox/photo.png
  //   <dir>/outside/state-link             -> state   (directory symlink)
  let dir: string
  let stateDir: string
  let inboxDir: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cscb-sendable-state-')))
    stateDir = join(dir, 'state')
    inboxDir = join(stateDir, 'inbox')
    mkdirSync(inboxDir, { recursive: true })
    mkdirSync(join(stateDir, 'inbox-old'))
    mkdirSync(join(dir, 'state2'))
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(stateDir, 'config.json'), '{}')
    writeFileSync(join(inboxDir, 'photo.png'), 'png')
    writeFileSync(join(stateDir, 'inbox-old', 'secret'), 'not for sending')
    writeFileSync(join(dir, 'state2', 'secret'), 'outside the state dir')
    symlinkSync(join(stateDir, 'config.json'), join(inboxDir, 'to-config'))
    symlinkSync(join(stateDir, 'config.json'), join(dir, 'outside', 'to-config'))
    symlinkSync(join(inboxDir, 'photo.png'), join(dir, 'outside', 'to-photo'))
    symlinkSync(stateDir, join(dir, 'outside', 'state-link'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The error `assertSendable` throws for `rel` (under the temp dir), or undefined when it allows it. */
  function refusal(rel: string, state = stateDir, inbox = inboxDir): Error | undefined {
    try {
      assertSendable(join(dir, rel), state, inbox, [])
      return undefined
    } catch (err) {
      return err as Error
    }
  }

  test.each([
    ['a symlink outside the state dir to a state-dir file outside inbox/', 'outside/to-config'],
    ['a state-dir file reached through a symlinked directory outside it', 'outside/state-link/config.json'],
    ['a symlink inside inbox/ to a state-dir file outside inbox/', 'state/inbox/to-config'],
    ['an existing file in a sibling of inbox/ whose name starts with "inbox"', 'state/inbox-old/secret'],
  ])('refuses %s', (_label, rel) => {
    expect(refusal(rel)?.message).toContain('cannot send files from state directory')
  })

  test.each([
    ['a symlink outside the state dir to a file inside inbox/', 'outside/to-photo'],
    ['an inbox file reached through a symlinked directory outside the state dir', 'outside/state-link/inbox/photo.png'],
    ['an existing file in a sibling directory named after the state dir', 'state2/secret'],
    ['a plain inbox file', 'state/inbox/photo.png'],
  ])('allows %s', (_label, rel) => {
    expect(refusal(rel)).toBeUndefined()
  })

  test('a state dir given through a symlink still refuses its real files outside inbox/ and allows its real inbox', () => {
    const aliasState = join(dir, 'outside', 'state-link')
    const aliasInbox = join(aliasState, 'inbox')
    expect(refusal('state/config.json', aliasState, aliasInbox)?.message)
      .toContain('cannot send files from state directory')
    expect(refusal('state/inbox/photo.png', aliasState, aliasInbox)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// assertSendable(): persona credentials files (b.av2 SR-5.2)
// ---------------------------------------------------------------------------

describe('assertSendable: credentials files', () => {
  // Real files under a temp dir. The dir is realpath'd because the OS temp
  // directory may itself be a symlink. Layout:
  //   <dir>/a/credentials.json   the listed credentials file
  //   <dir>/a/notes.txt          an unlisted sibling
  //   <dir>/a/b/                 a directory below it
  //   <dir>/alias.json         -> a/credentials.json   (file symlink)
  //   <dir>/linkdir            -> a                    (parent-directory symlink)
  let dir: string
  let credPath: string
  let stateDir: string
  let inboxDir: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cscb-sendable-')))
    credPath = writeCredentialsFile(dir, 'a/credentials.json')
    writeFileSync(join(dir, 'a', 'notes.txt'), 'not a credentials file')
    mkdirSync(join(dir, 'a', 'b'))
    symlinkSync(credPath, join(dir, 'alias.json'))
    symlinkSync(join(dir, 'a'), join(dir, 'linkdir'))
    stateDir = join(dir, 'state')
    inboxDir = join(stateDir, 'inbox')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The error `assertSendable` throws, or undefined when it allows the file. */
  function refusal(filePath: string, protectedPaths: readonly string[]): Error | undefined {
    try {
      assertSendable(filePath, stateDir, inboxDir, protectedPaths)
      return undefined
    } catch (err) {
      return err as Error
    }
  }

  test.each([
    ['its exact path', () => credPath],
    ['a symlink to it', () => join(dir, 'alias.json')],
    // `..` is collapsed lexically before the real path is taken (as the upload
    // and the loader do), so this one also crosses the symlinked parent to
    // differ lexically from the listed path.
    ['a path with .. segments', () => `${dir}/a/b/../../linkdir/credentials.json`],
    ['a symlinked parent directory', () => join(dir, 'linkdir', 'credentials.json')],
    ['a relative path', () => relative(process.cwd(), credPath)],
  ])('refuses the credentials file through %s', (_label, sendPath) => {
    const err = refusal(sendPath(), [credPath])
    expect(err?.message).toContain('persona credentials file')
    expect(err?.message).toContain(resolve(sendPath()))
    assertNoLeak(err)
  })

  test('allows an unlisted sibling in the same directory', () => {
    expect(refusal(join(dir, 'a', 'notes.txt'), [credPath])).toBeUndefined()
  })

  test('refuses a listed path that does not exist, compared lexically', () => {
    const missing = join(dir, 'gone', 'credentials.json')
    expect(refusal(join(dir, 'gone', '.', 'credentials.json'), [missing])?.message)
      .toContain('persona credentials file')
    expect(refusal(join(dir, 'gone', 'other.json'), [missing])).toBeUndefined()
  })

  test('refuses each entry of a two-entry list', () => {
    const second = writeCredentialsFile(dir, 'second/credentials.json')
    const list = [credPath, second]
    expect(refusal(credPath, list)?.message).toContain(credPath)
    expect(refusal(second, list)?.message).toContain(second)
  })

  test('the state-dir rule is checked first', () => {
    const inState = writeCredentialsFile(dir, 'state/credentials.json')
    const err = refusal(inState, [inState])
    expect(err?.message).toContain('cannot send files from state directory')
    expect(err?.message).not.toContain('persona credentials file')
  })
})

// ---------------------------------------------------------------------------
// chunkText()
// ---------------------------------------------------------------------------

describe('chunkText', () => {
  test('returns single chunk for short text', () => {
    const result = chunkText('hello', 4000, 'newline')
    expect(result).toEqual(['hello'])
  })

  test('returns single chunk at exactly the limit', () => {
    const text = 'a'.repeat(4000)
    const result = chunkText(text, 4000, 'length')
    expect(result).toEqual([text])
  })

  test('chunks by fixed length', () => {
    const text = 'a'.repeat(10)
    const result = chunkText(text, 4, 'length')
    expect(result).toEqual(['aaaa', 'aaaa', 'aa'])
  })

  test('chunks at newlines (paragraph-aware)', () => {
    const text = 'line1\nline2\nline3\nline4'
    const result = chunkText(text, 12, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // Each chunk should be <= 12 chars
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(12)
    }
  })

  test('newline mode keeps lines together when possible', () => {
    const text = 'short\nshort\nshort'
    const result = chunkText(text, 100, 'newline')
    expect(result).toEqual(['short\nshort\nshort'])
  })
})

// ---------------------------------------------------------------------------
// sanitizeFilename()
// ---------------------------------------------------------------------------

describe('sanitizeFilename', () => {
  test('strips square brackets', () => {
    expect(sanitizeFilename('file[1].txt')).toBe('file_1_.txt')
  })

  test('strips newlines', () => {
    expect(sanitizeFilename('file\nname.txt')).toBe('file_name.txt')
  })

  test('strips carriage returns', () => {
    expect(sanitizeFilename('file\rname.txt')).toBe('file_name.txt')
  })

  test('strips semicolons', () => {
    expect(sanitizeFilename('file;name.txt')).toBe('file_name.txt')
  })

  test('replaces path traversal (..)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('_/_/etc/passwd')
  })

  test('leaves clean names alone', () => {
    expect(sanitizeFilename('photo.png')).toBe('photo.png')
  })

  test('handles combined attack vector', () => {
    const result = sanitizeFilename('[../..\n;evil].txt')
    expect(result).not.toContain('[')
    expect(result).not.toContain('..')
    expect(result).not.toContain('\n')
    expect(result).not.toContain(';')
  })
})

// ---------------------------------------------------------------------------
// _buildIsSessionAliveAdapter (SRD § Liveness probe, Epic 2 Task 1; b.jg5
// SRJ-314: four readings, and a `status` error never reads dead unless it is
// ErrSpawnNotFound or ErrSystemInstallDisappeared)
// ---------------------------------------------------------------------------

/** The live states other than `pending`: each reads `live`. */
const LIVE_NOT_PENDING_STATES = [...AGENT_DIRECTOR_LIVE_STATES].filter((s) => s !== AGENT_DIRECTOR_PENDING_STATE)
/** A state string CSCB does not know (from a later binary). */
const UNRECOGNISED_STATE = 'a-state-from-a-later-binary'
/** Every state other than `pending`, with the reading it gives (b.jg5 SRJ-314). */
const NOT_PENDING_STATE_READINGS = [
  ...LIVE_NOT_PENDING_STATES.map((s) => [s, LIVENESS_READING_LIVE] as const),
  ...[...AGENT_DIRECTOR_DEAD_STATES].map((s) => [s, LIVENESS_READING_DEAD] as const),
  [UNRECOGNISED_STATE, LIVENESS_READING_UNKNOWN] as const,
]
/** The launch starts a `pending` row may show (ADSRD SR-22.2 forms). */
const LAUNCH_STARTS = [SAMPLE_LAUNCH_START_FRACTIONAL, SAMPLE_LAUNCH_START_WHOLE]
/** Launch-start field values that are no launch start. */
const NO_LAUNCH_STARTS: ReadonlyArray<readonly [string, unknown]> = [
  ['absent', SAMPLE_LAUNCH_START_NONE],
  ['null', null],
  ['empty', ''],
  ['not a string', 42],
]

// ---------------------------------------------------------------------------
// A `pending` row's launch start (b.jg5 SRJ-115, SRJ-406): the pure readers
// the liveness and reconnect adapters use. Read raw, never parsed or aged.
// ---------------------------------------------------------------------------

describe("liveness-reading: a pending row's launch start (b.jg5 SRJ-115)", () => {
  /** A `status` result whose `launch_started_at` is `value` (any type; `undefined` omits it). */
  function statusWith(state: string, value: unknown): Phase1StatusResult {
    return cannedStatusResult({ state, launch_started_at: value as string | null | undefined })
  }

  test.each(LAUNCH_STARTS)('a pending result showing launch start %s → read raw; the reading carries it (frozen) and gives it back', (start) => {
    const result = statusWith(AGENT_DIRECTOR_PENDING_STATE, start)

    expect(pendingLaunchStartOf(result)).toBe(start)
    const reading = livenessReadingForStatus(result)
    expect(reading).toEqual({ kind: LIVENESS_PENDING, launchStartedAt: start })
    expect(Object.isFrozen(reading)).toBe(true)
    expect(launchStartOfReading(reading)).toBe(start)
    expect(reading).toEqual(pendingLivenessReading(start))
  })

  test.each(NO_LAUNCH_STARTS)('a pending result whose launch start is %s → none: the plain pending reading', (_label, value) => {
    const result = statusWith(AGENT_DIRECTOR_PENDING_STATE, value)

    expect(pendingLaunchStartOf(result)).toBeUndefined()
    expect(livenessReadingForStatus(result)).toBe(LIVENESS_READING_PENDING)
  })

  test('a pending result whose launch start cannot be read (a throwing getter) → none, and no throw', () => {
    const result = Object.defineProperty({ state: AGENT_DIRECTOR_PENDING_STATE }, 'launch_started_at', {
      get() { throw new Error('boom') },
    }) as Phase1StatusResult

    expect(pendingLaunchStartOf(result)).toBeUndefined()
    expect(livenessReadingForStatus(result)).toBe(LIVENESS_READING_PENDING)
  })

  test.each(NOT_PENDING_STATE_READINGS)('a %s result carrying a launch start → the field is ignored: reads %j with no launch start', (state, expected) => {
    const result = statusWith(state, SAMPLE_LAUNCH_START_FRACTIONAL)

    expect(pendingLaunchStartOf(result)).toBeUndefined()
    const reading = livenessReadingForStatus(result)
    expect(reading).toBe(expected)
    expect(launchStartOfReading(reading)).toBeUndefined()
  })

  test('no result, or one whose state cannot be read → no launch start; reads unknown, and no throw', () => {
    const throwing = Object.defineProperty({}, 'state', { get() { throw new Error('boom') } }) as Phase1StatusResult
    for (const result of [null, undefined, throwing]) {
      expect(pendingLaunchStartOf(result)).toBeUndefined()
      expect(livenessReadingForStatus(result)).toBe(LIVENESS_READING_UNKNOWN)
    }
  })

  test('pendingLivenessReading with no launch start, or an empty one → the plain pending reading', () => {
    expect(pendingLivenessReading()).toBe(LIVENESS_READING_PENDING)
    expect(pendingLivenessReading('')).toBe(LIVENESS_READING_PENDING)
  })

  test("launchStartOfReading → only a pending reading's non-empty launch start; anything else gives none", () => {
    expect(launchStartOfReading(LIVENESS_READING_PENDING)).toBeUndefined()
    expect(launchStartOfReading({ ...LIVENESS_READING_PENDING, launchStartedAt: '' })).toBeUndefined()
    expect(launchStartOfReading({ ...LIVENESS_READING_PENDING, launchStartedAt: 42 })).toBeUndefined()
    for (const other of [LIVENESS_READING_LIVE, LIVENESS_READING_DEAD, LIVENESS_READING_UNKNOWN]) {
      expect(launchStartOfReading({ ...other, launchStartedAt: SAMPLE_LAUNCH_START_FRACTIONAL })).toBeUndefined()
    }
    for (const notAReading of [null, undefined, LIVENESS_PENDING, SAMPLE_LAUNCH_START_FRACTIONAL]) {
      expect(launchStartOfReading(notAReading)).toBeUndefined()
    }
  })
})

describe('_buildIsSessionAliveAdapter', () => {
  type Emission = { key: string; text: string }
  /** One arm of the trigger-sink spy, and whether it came from inside an attempt for its key. */
  type Trigger = { key: string; kind: string; inside: boolean }
  /** One real flag clear the cleared-flag observer saw. */
  type Cleared = { key: string; cls: OutageClass }
  /** One report to the unclassified sink: its key, the reported value, and whether it came from inside an attempt for its key. */
  type Unclassified = { key: string; error: unknown; inside: boolean }

  /** The all-clear an `ad-unreachable` raised with `binaryPath` alone posts when it clears. */
  const adUnreachableAllClear = (binaryPath: string): string =>
    ALL_CLEAR_TEMPLATE(new Map([['ad-unreachable', { detail: binaryPath }]]))

  /** A live state the harness's `status` answers by default. */
  const LIVE_STATE = LIVE_NOT_PENDING_STATES[0]!

  /** Per-test temp dir: `baseDir` for the stand-in persona fixtures. */
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'cscb-server-'))
  })

  /** One stand-in persona per key (keyed and named by its one channel's ID), in order. */
  function standIns(...keys: string[]): PersonaConfig {
    return makeStandInPersonaConfig(Object.fromEntries(keys.map((k) => [k, {}])), baseDir)
  }

  /** Build per-test emission capture + stub client + outage-state harness. */
  function makeHarness(
    statusError?: Error,
    statusState: string = LIVE_STATE,
    config: PersonaConfig | null = standIns('C1'),
    /** The result's `launch_started_at` (any type; `undefined` omits the key). */
    launchStartedAt?: unknown,
  ): {
    emissions: Emission[]
    statusCalls: StatusParams[]
    triggers: Trigger[]
    cleared: Cleared[]
    unclassified: Unclassified[]
    adapter: (key: string) => Promise<LivenessReading>
  } {
    const emissions: Emission[] = []
    const statusCalls: StatusParams[] = []
    const triggers: Trigger[] = []
    const cleared: Cleared[] = []
    const unclassified: Unclassified[] = []
    _resetOutageState()
    initOutageState({
      notify: (key, text) => { emissions.push({ key, text }) },
      getClient: () => makeStubClient() as unknown as Client,
      // Spies: every arm and every unclassified report (each with whether it
      // came from inside an attempt for the key) and every real flag clear.
      triggerSink: { arm: (key, cause) => { triggers.push({ key, kind: cause.kind, inside: isInsideAttempt(key) }); return true } },
      unclassifiedSink: { report: (key, error) => { unclassified.push({ key, error, inside: isInsideAttempt(key) }) } },
      onFlagCleared: (key, cls) => { cleared.push({ key, cls }) },
    })
    const stubOpts = statusError
      ? { statusError, statusCalls }
      : {
          statusResult: cannedStatusResult({
            state: statusState,
            launch_started_at: launchStartedAt as string | null | undefined,
          }),
          statusCalls,
        }
    setClientForTests(makeStubClient(stubOpts) as unknown as Client)
    // Default persona config: one stand-in persona keyed C1.
    return {
      emissions,
      statusCalls,
      triggers,
      cleared,
      unclassified,
      adapter: _buildIsSessionAliveAdapter(() => config),
    }
  }

  /** Probe `key` with every console.error argument list captured (kept unformatted). */
  async function probeCapturingErrors(
    adapter: (key: string) => Promise<LivenessReading>,
    key: string,
  ): Promise<{ result: LivenessReading; errArgs: unknown[][] }> {
    const errArgs: unknown[][] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
    try {
      return { result: await adapter(key), errArgs }
    } finally {
      console.error = orig
    }
  }

  afterEach(() => {
    resetClientForTests()
    _resetOutageState()
    rmSync(baseDir, { recursive: true, force: true })
  })

  // b.jg5 SRJ-312: a `status` is not tmux-touching, so a state answer clears
  // `ad-unreachable` only; `tmux-unavailable` stays raised, and with the set
  // not empty no all-clear is posted.
  test('1. alive (b.jg5 SRJ-312): status returns a live state with both flags raised → clears ad-unreachable only; tmux-unavailable stays raised, no all-clear; reads live', async () => {
    const { emissions, statusCalls, triggers, cleared, adapter } = makeHarness(undefined, LIVE_STATE)
    // Pre-raise both flags so the clear (and the flag kept) are observable
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    const before = emissions.length

    const result = await adapter('C1')

    expect(result).toEqual(LIVENESS_READING_LIVE)
    // b.av2 SR-2.2: the probe addresses the persona's cscb_<key> instance.
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0].claude_instance_id).toBe(personaInstanceId('C1'))
    expect(statusCalls[0].claude_instance_id).toBe('cscb_C1')
    expect([...getOutageFlags('C1')]).toEqual(['tmux-unavailable'])
    expect(cleared).toEqual([{ key: 'C1', cls: 'ad-unreachable' }])
    expect(emissions.slice(before)).toEqual([])
    expect(triggers).toEqual([])
  })

  // Twin of case 1 (b.jg5 SRJ-312): the `ad-unreachable` clear stays pinned.
  test('1b. alive (b.jg5 SRJ-312): status returns a live state with only ad-unreachable raised → clears it; one all-clear posted; reads live', async () => {
    const { emissions, cleared, adapter } = makeHarness(undefined, LIVE_STATE)
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    const before = emissions.length

    const result = await adapter('C1')

    expect(result).toEqual(LIVENESS_READING_LIVE)
    expect(getOutageFlags('C1').size).toBe(0)
    expect(cleared).toEqual([{ key: 'C1', cls: 'ad-unreachable' }])
    expect(emissions.slice(before)).toEqual([{ key: 'C1', text: adUnreachableAllClear('/bin/ad') }])
  })

  // b.jg5 SRJ-314: `pending` is its own reading (never `live`); the dead list
  // is closed, so a state CSCB does not know reads `unknown`, never `dead`,
  // and logs one line naming the persona; a known state logs no such line.
  // b.jg5 SRJ-312: any state answer clears `ad-unreachable` and leaves
  // `tmux-unavailable` raised (no all-clear while the set is not empty).
  /** The start of the line the probe logs for a state CSCB does not know. */
  const UNKNOWN_STATE_LINE = 'isSessionAlive: status answered a state CSCB does not know'
  test.each([
    ...NOT_PENDING_STATE_READINGS,
    [AGENT_DIRECTOR_PENDING_STATE, LIVENESS_READING_PENDING] as const,
  ])('status answers state %s → reads %j; clears ad-unreachable and leaves tmux-unavailable raised, no all-clear (b.jg5 SRJ-312); an unknown-state line only for a state CSCB does not know', async (state, reading) => {
    const { emissions, statusCalls, cleared, adapter } = makeHarness(undefined, state)
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    const before = emissions.length

    const { result, errArgs } = await probeCapturingErrors(adapter, 'C1')

    expect(result).toEqual(reading)
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    expect([...getOutageFlags('C1')]).toEqual(['tmux-unavailable'])
    expect(cleared).toEqual([{ key: 'C1', cls: 'ad-unreachable' }])
    expect(emissions.slice(before)).toEqual([])
    const unknownStateLines = errArgs.map((args) => args.map(String).join(' ')).filter((l) => l.includes(UNKNOWN_STATE_LINE))
    if (state === UNRECOGNISED_STATE) {
      expect(unknownStateLines).toHaveLength(1)
      expect(unknownStateLines[0]).toContain('persona=C1')
    } else {
      expect(unknownStateLines).toEqual([])
    }
  })

  // b.jg5 SRJ-115: a `pending` result's launch start rides on the `pending`
  // reading, raw; a result with none gives the plain reading, and another
  // state's field is ignored. One case each here: the permutations of "no
  // launch start" and of the other states are the pure readers' (above).
  test.each(LAUNCH_STARTS)('SRJ-115: a pending result showing launch start %s → a pending reading carrying it raw', async (start) => {
    const { adapter } = makeHarness(undefined, AGENT_DIRECTOR_PENDING_STATE, standIns('C1'), start)

    const result = await adapter('C1')

    expect(result).toEqual({ ...LIVENESS_READING_PENDING, launchStartedAt: start })
    expect(launchStartOfReading(result)).toBe(start)
  })

  test('SRJ-115: a pending result showing no launch start → the plain pending reading, carrying none', async () => {
    const { adapter } = makeHarness(undefined, AGENT_DIRECTOR_PENDING_STATE, standIns('C1'), SAMPLE_LAUNCH_START_NONE)

    const result = await adapter('C1')

    expect(result).toEqual(LIVENESS_READING_PENDING)
    expect(result).not.toHaveProperty('launchStartedAt')
  })

  test('SRJ-115: a live (not pending) result carrying a launch start → reads live, carrying none', async () => {
    const { adapter } = makeHarness(undefined, LIVE_STATE, standIns('C1'), SAMPLE_LAUNCH_START_FRACTIONAL)

    const result = await adapter('C1')

    expect(result).toEqual(LIVENESS_READING_LIVE)
    expect(result).not.toHaveProperty('launchStartedAt')
  })

  // b.jg5 SRJ-312: agent-director answered but tmux did not, so an
  // ErrSpawnNotFound clears `ad-unreachable` only.
  test('2. ErrSpawnNotFound (b.jg5 SRJ-312): status throws with both flags raised → clears ad-unreachable only; tmux-unavailable stays raised, no all-clear; reads dead', async () => {
    const { emissions, statusCalls, triggers, cleared, adapter } = makeHarness(errSpawnNotFound())
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    const before = emissions.length

    const result = await adapter('C1')

    expect(result).toEqual(LIVENESS_READING_DEAD)
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1'])
    expect([...getOutageFlags('C1')]).toEqual(['tmux-unavailable'])
    expect(cleared).toEqual([{ key: 'C1', cls: 'ad-unreachable' }])
    expect(emissions.slice(before)).toEqual([])
    expect(triggers).toEqual([])
  })

  // Twin of case 2 (b.jg5 SRJ-312): the `ad-unreachable` clear stays pinned.
  test('2b. ErrSpawnNotFound (b.jg5 SRJ-312): status throws with only ad-unreachable raised → clears it; one all-clear posted; reads dead', async () => {
    const { emissions, cleared, adapter } = makeHarness(errSpawnNotFound())
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    const before = emissions.length

    const result = await adapter('C1')

    expect(result).toEqual(LIVENESS_READING_DEAD)
    expect(getOutageFlags('C1').size).toBe(0)
    expect(cleared).toEqual([{ key: 'C1', cls: 'ad-unreachable' }])
    expect(emissions.slice(before)).toEqual([{ key: 'C1', text: adUnreachableAllClear('/bin/ad') }])
  })

  test('3. ErrSystemInstallDisappeared: status throws → sets ad-unreachable with binaryPath as detail; reads dead', async () => {
    const binaryPath = '/home/horde/.agent-director/bin/agent-director'
    const { emissions, statusCalls, adapter } = makeHarness(errSystemInstallDisappeared('status', binaryPath))

    const result = await adapter('C1')

    expect(result).toEqual(LIVENESS_READING_DEAD)
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1'])
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(true)
    expect(getOutageFlags('C1').has('tmux-unavailable')).toBe(false)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].key).toBe('C1')
    expect(emissions[0].text).toMatch(/agent-director unreachable/)
    expect(emissions[0].text).toContain(binaryPath)
  })

  // b.jg5 SRJ-311: the ENVIRONMENT cause arms the persona's timer from any
  // verb in any context; the probe here runs outside every attempt.
  test('4. ErrTmuxNotAvailable: status throws → sets tmux-unavailable (no detail); reads unknown, not dead; the ENVIRONMENT cause is reported once outside any attempt (b.jg5 SRJ-311)', async () => {
    const { emissions, statusCalls, triggers, adapter } = makeHarness(errTmuxNotAvailable(undefined, 'status'))

    const result = await adapter('C1')

    expect(result).toEqual(LIVENESS_READING_UNKNOWN)
    expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, inside: false }])
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1'])
    expect(getOutageFlags('C1').has('tmux-unavailable')).toBe(true)
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(false)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].key).toBe('C1')
    expect(emissions[0].text).toMatch(/tmux unavailable/)
    // ONSET_TEMPLATES['tmux-unavailable'] ignores the detail arg — nothing extra
    expect(emissions[0].text).not.toContain('undefined')
  })

  // b.jg5 SRJ-1021: the liveness adapter is a raise site of its own, so the
  // error it hands the raise entry picks the onset. The re-bound-socket form
  // (the description carries "not the tmux server the agent was launched
  // on") posts SRJ-1021's onset; plain `ErrTmuxNotAvailable` posts today's.
  // Either way the probe reads unknown, never dead.
  test.each([
    // Wiring only: today's agent-director never returns this error from `status`; the row proves the site hands its error to `raiseTmuxUnavailable`.
    ['the re-bound-socket form (errTmuxNotAvailableDifferentServer)', () => errTmuxNotAvailableDifferentServer(undefined, 'status'), tmuxServerChangedOnset],
    ['plain ErrTmuxNotAvailable', () => errTmuxNotAvailable(undefined, 'status'), () => ONSET_TEMPLATES['tmux-unavailable']()],
  ] as const)('b.jg5 SRJ-1021: status throws %s → reads unknown; tmux-unavailable raised with that form\'s onset, posted once; the ENVIRONMENT cause armed once', async (_label, build, onset) => {
    // Non-vacuity: the two onsets differ, so posting the wrong one fails.
    expect(tmuxServerChangedOnset()).not.toBe(ONSET_TEMPLATES['tmux-unavailable']())
    const { emissions, statusCalls, triggers, adapter } = makeHarness(build())

    const { result, errArgs } = await probeCapturingErrors(adapter, 'C1')

    expect(result).toEqual(LIVENESS_READING_UNKNOWN)
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    expect([...getOutageFlags('C1')]).toEqual(['tmux-unavailable'])
    expect(emissions).toEqual([{ key: 'C1', text: onset() }])
    expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, inside: false }])
    assertNoLeak({ errArgs, emissions })
  })

  // b.jg5 SRJ-1021: one onset per bad stretch, from whichever form arrives
  // first; a second probe answering either form while the flag is raised
  // posts nothing more (same-flag dedupe kept at this raise site).
  test.each([
    ['re-bound first, then plain', () => errTmuxNotAvailableDifferentServer(undefined, 'status'), () => errTmuxNotAvailable(undefined, 'status'), tmuxServerChangedOnset],
    ['plain first, then re-bound', () => errTmuxNotAvailable(undefined, 'status'), () => errTmuxNotAvailableDifferentServer(undefined, 'status'), () => ONSET_TEMPLATES['tmux-unavailable']()],
  ] as const)('b.jg5 SRJ-1021: %s → the first form\'s onset only; the second probe posts nothing and both read unknown', async (_label, first, second, onset) => {
    const { emissions, adapter } = makeHarness(first())

    expect(await adapter('C1')).toEqual(LIVENESS_READING_UNKNOWN)
    setClientForTests(makeStubClient({ statusError: second() }) as unknown as Client)
    expect(await adapter('C1')).toEqual(LIVENESS_READING_UNKNOWN)

    expect([...getOutageFlags('C1')]).toEqual(['tmux-unavailable'])
    expect(emissions).toEqual([{ key: 'C1', text: onset() }])
  })

  // b.jg5 SRJ-316, SRJ-314: a CONFIG answer (`ErrConfigMalformed`, decided by
  // name) reads `unknown`, never `dead`, and raises `ad-config-malformed` for
  // the persona with the exported onset for that error: one onset per
  // episode, so a second CONFIG probe posts nothing. The CONFIG cause arms the
  // persona's timer in any context, so each probe reports it once, inside or
  // outside an attempt for the persona. The error's description carries the
  // leak marker (inside a fake token and a `ticket=` URL), which the onset
  // shows redacted and then Slack-escaped.
  test.each([
    ['outside any attempt', false],
    ['inside a recovery attempt for the persona', true],
  ] as const)('b.jg5 SRJ-316: status throws a CONFIG answer (ErrConfigMalformed) %s → reads unknown, not dead; ad-config-malformed raised with its onset, posted once; the CONFIG cause reported once per probe; a second CONFIG posts nothing; nothing leaks', async (_label, inside) => {
    const err = errConfigMalformed('starting_session_seconds', sentinelInMessage('status-config'))
    const { emissions, statusCalls, triggers, adapter } = makeHarness(err)
    const probe = () => (inside
      ? runInAttempt('C1', 'recovery', () => probeCapturingErrors(adapter, 'C1'))
      : probeCapturingErrors(adapter, 'C1'))
    const raiseLines = (errArgs: unknown[][]) => stringLines(errArgs).filter((l) => l.includes('ad-config-malformed raised for persona=C1'))
    const statusErrorLines = (errArgs: unknown[][]) => stringLines(errArgs).filter((l) => l.startsWith('[slack] isSessionAlive: status error for persona=C1: '))

    const first = await probe()

    expect(first.result).toEqual(LIVENESS_READING_UNKNOWN)
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    expect([...getOutageFlags('C1')]).toEqual(['ad-config-malformed'])
    expect(emissions).toEqual([{ key: 'C1', text: adConfigMalformedOnset(err) }])
    // The quoted description is redacted, then Slack-escaped (b.jg5 SRJ-1018):
    // the placeholders render as text, never as a raw `<…>` Slack would parse.
    const escapedTail = escapeSlackControlCharacters(REDACTED_SENTINEL_TAIL)
    expect(escapedTail).not.toBe(REDACTED_SENTINEL_TAIL)
    expect(emissions[0]!.text).toContain(`starting_session_seconds = ${escapedTail}, below its safe minimum`)
    expect(emissions[0]!.text).not.toContain(REDACTED_SENTINEL_TAIL)
    expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_CONFIG, inside }])
    expect(raiseLines(first.errArgs)).toHaveLength(1)
    expect(statusErrorLines(first.errArgs)).toHaveLength(1)
    expect(first.errArgs).toHaveLength(2)

    const second = await probe()

    expect(second.result).toEqual(LIVENESS_READING_UNKNOWN)
    expect([...getOutageFlags('C1')]).toEqual(['ad-config-malformed'])
    expect(emissions).toHaveLength(1)
    expect(triggers).toEqual([
      { key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_CONFIG, inside },
      { key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_CONFIG, inside },
    ])
    expect(raiseLines(second.errArgs)).toEqual([])
    expect(statusErrorLines(second.errArgs)).toHaveLength(1)
    assertNoLeak({ errArgs: [...first.errArgs, ...second.errArgs], emissions })
  })

  /** Raise `ad-config-malformed` for C1 through the production raise entry (its raise line captured, not printed). */
  const raiseConfigOutage = () => capturingErrorArgs(async () => raiseAdConfigMalformed('C1', errConfigMalformed()))

  /** The all-clear the bare `ad-config-malformed` class posts when it clears alone (no detail recorded). */
  const configAllClear = (): string => ALL_CLEAR_TEMPLATE(new Map([['ad-config-malformed', {}]]))

  // b.jg5 SRJ-312: a `status` that shows agent-director loaded its config and
  // read its store clears `ad-config-malformed`: a state answer, and
  // `ErrSpawnNotFound`. With it the only raised class, one all-clear lists
  // the bare class; with `tmux-unavailable` also raised (a `status` never
  // clears that one) the clear is silent. The reading is unchanged.
  test.each([
    ['a successful status (a live state)', undefined, LIVENESS_READING_LIVE],
    ['ErrSpawnNotFound', errSpawnNotFound, LIVENESS_READING_DEAD],
  ].flatMap(([label, build, reading]) => [
    [label, build, reading, false],
    [label, build, reading, true],
  ] as const) as ReadonlyArray<readonly [string, (() => Error) | undefined, LivenessReading, boolean]>)('b.jg5 SRJ-312: with ad-config-malformed raised, status answers %s → clears it (one clear line); reads %j; tmux-unavailable also raised: %p (then it stays raised and no all-clear, else one all-clear listing the bare class)', async (_label, build, reading, withTmux) => {
    const { emissions, cleared, adapter } = makeHarness(build?.())
    await raiseConfigOutage()
    if (withTmux) setOutageFlag('C1', 'tmux-unavailable')
    const before = emissions.length

    const { result, errArgs } = await probeCapturingErrors(adapter, 'C1')

    expect(result).toEqual(reading)
    expect(cleared).toEqual([{ key: 'C1', cls: 'ad-config-malformed' }])
    expect(stringLines(errArgs).filter((l) => l.includes('ad-config-malformed cleared for persona=C1'))).toHaveLength(1)
    if (withTmux) {
      expect([...getOutageFlags('C1')]).toEqual(['tmux-unavailable'])
      expect(emissions.slice(before)).toEqual([])
    } else {
      expect(getOutageFlags('C1').size).toBe(0)
      expect(emissions.slice(before)).toEqual([{ key: 'C1', text: configAllClear() }])
    }
  })

  // b.jg5 SRJ-312: no other `status` error shows agent-director read its
  // store, so none clears `ad-config-malformed`; each keeps its own reading.
  test.each([
    ['ErrSystemInstallDisappeared', () => errSystemInstallDisappeared('status'), LIVENESS_READING_DEAD],
    ['ErrTmuxNotAvailable (ENVIRONMENT)', () => errTmuxNotAvailable(undefined, 'status'), LIVENESS_READING_UNKNOWN],
    ...unavailableForms('ErrCallTimeout', 'ErrTmuxUnresponsive', 'ErrUnknownErrorName').map(
      ([label, build]) => [`${label} (UNAVAILABLE)`, () => build('status'), LIVENESS_READING_UNKNOWN] as const,
    ),
    ['ErrInternal', () => errInternal(), LIVENESS_READING_UNKNOWN],
  ] as ReadonlyArray<readonly [string, () => Error, LivenessReading]>)('b.jg5 SRJ-312: with ad-config-malformed raised, status throws %s → ad-config-malformed stays raised: no clear, no clear line, no all-clear; reads %j', async (_label, build, reading) => {
    const { emissions, cleared, adapter } = makeHarness(build())
    await raiseConfigOutage()
    const before = emissions.length

    const { result, errArgs } = await probeCapturingErrors(adapter, 'C1')

    expect(result).toEqual(reading)
    expect(getOutageFlags('C1').has('ad-config-malformed')).toBe(true)
    expect(cleared).toEqual([])
    expect(stringLines(errArgs).filter((l) => l.includes('ad-config-malformed cleared'))).toEqual([])
    expect(emissions.slice(before).map((e) => e.text)).not.toContain(configAllClear())
  })

  // b.jg5 SRJ-314: every other `status` error reads `unknown`, never `dead`,
  // and raises no outage flag here. One log line, from the catch-all.
  test.each([
    ['ErrCallTimeout', () => errCallTimeout('status')],
    ['ErrTmuxUnresponsive (by name)', () => errTmuxUnresponsive('status')],
    ['ErrInternal (an unknown name)', () => errInternal()],
    ['a wrapped UnknownError', () => errGeneric('status', CSCB_UNKNOWN_ERROR_NAME, 'Error: boom')],
    ['a name from a later binary', () => errUnknownErrorName()],
    ['a plain Error', () => new Error('boom')],
    ['another STATE name (ErrSpawnNotInteractive)', () => errSpawnNotInteractive('status')],
    ['an UNUSABLE NAME ErrInternal', () => errUnusableName()],
    ['a store agent-director cannot open (ErrSchemaMismatch)', () => errSchemaMismatch()],
    ['a GONE name (ErrTmuxCaptureFailed)', () => errTmuxCaptureFailed(undefined, 'status')],
  ])('%s: status throws → reads unknown, not dead; no flag, nothing posted, one log line; outside any attempt nothing is armed (only ENVIRONMENT and CONFIG arm there, b.jg5 SRJ-311, SRJ-316)', async (_label, build) => {
    const { emissions, statusCalls, triggers, adapter } = makeHarness(build())

    const { result, errArgs } = await probeCapturingErrors(adapter, 'C1')

    expect(result).toEqual(LIVENESS_READING_UNKNOWN)
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    expect(getOutageFlags('C1').size).toBe(0)
    expect(emissions).toHaveLength(0)
    expect(errArgs).toHaveLength(1)
    expect(triggers).toEqual([])
  })

  // b.jg5 SRJ-313 (Task ruling: reads count toward the episode): inside a
  // restart run for the persona (a recovery attempt) an UNCLASSIFIED `status`
  // is reported once to the unclassified sink, with the value itself; the
  // reading (`unknown`, pinned above) and the read-error cause are unchanged.
  // Each description carries the leak marker, so the one line is checked.
  const UNCLASSIFIED_STATUS_ERRORS = [
    ['ErrInternal', () => errInternal(`the store could not be read (${sentinelInMessage('status-internal')})`)],
    ['a store agent-director cannot open (ErrSchemaMismatch)', () => errSchemaMismatch(`the store could not be opened (${sentinelInMessage('status-schema')})`)],
    ['a name CSCB gives no handling', () => errGeneric('status', 'ErrStatusBroken', `the status broke (${sentinelInMessage('status-generic')})`)],
  ] as const
  test.each(UNCLASSIFIED_STATUS_ERRORS)('b.jg5 SRJ-313: status throws %s inside a restart run for the persona → reported once to the unclassified sink, with the value; reads unknown; the read-error cause armed; one token-safe line', async (_label, build) => {
    const err = build()
    const { emissions, triggers, unclassified, adapter } = makeHarness(err)

    const { result, errArgs } = await runInAttempt('C1', 'recovery', () => probeCapturingErrors(adapter, 'C1'))

    expect(result).toEqual(LIVENESS_READING_UNKNOWN)
    expect(unclassified.map((u) => ({ key: u.key, inside: u.inside, same: u.error === err }))).toEqual([{ key: 'C1', inside: true, same: true }])
    expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR, inside: true }])
    expect(emissions).toEqual([])
    const lines = stringLines(errArgs)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith('[slack] isSessionAlive: status error for persona=C1: ')
    assertNoLeak({ errArgs, emissions })
  })

  // Outside a launch or recovery attempt for the persona (the health tick, or
  // a restart run for another persona) an UNCLASSIFIED answer starts no
  // episode: nothing is reported, and nothing is armed.
  test.each([
    ['outside any attempt', undefined],
    ['inside a restart run for another persona', 'C2'],
  ] as const)('b.jg5 SRJ-313: status throws ErrInternal %s → nothing reported to the unclassified sink, nothing armed; reads unknown', async (_label, attemptKey) => {
    const { triggers, unclassified, adapter } = makeHarness(errInternal(), LIVE_STATE, standIns('C1', 'C2'))

    const { result } = attemptKey === undefined
      ? await probeCapturingErrors(adapter, 'C1')
      : await runInAttempt(attemptKey, 'recovery', () => probeCapturingErrors(adapter, 'C1'))

    expect(result).toEqual(LIVENESS_READING_UNKNOWN)
    expect(unclassified).toEqual([])
    expect(triggers).toEqual([])
  })

  // b.jg5 SRJ-105, SRJ-314 (Task ruling): `ErrSystemInstallDisappeared` is
  // UNCLASSIFIED, but at the liveness adapter it keeps its `dead` reading and
  // its `ad-unreachable` raise, and is never reported to the unclassified
  // sink, inside a restart run for the persona or outside one. Its arming is
  // unchanged (a read's error inside the attempt: the read-error cause).
  test.each([
    ['inside a restart run for the persona', true],
    ['outside any attempt', false],
  ] as const)('b.jg5 SRJ-313: status throws ErrSystemInstallDisappeared %s → reads dead; ad-unreachable raised; not reported to the unclassified sink', async (_label, inside) => {
    const { triggers, unclassified, adapter } = makeHarness(errSystemInstallDisappeared('status'))

    const { result, errArgs } = inside
      ? await runInAttempt('C1', 'recovery', () => probeCapturingErrors(adapter, 'C1'))
      : await probeCapturingErrors(adapter, 'C1')

    expect(result).toEqual(LIVENESS_READING_DEAD)
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(true)
    expect(unclassified).toEqual([])
    expect(triggers).toEqual(inside ? [{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR, inside: true }] : [])
    // Any line is a string (no raw error), and none leaks.
    stringLines(errArgs)
    assertNoLeak({ errArgs })
  })

  test('5. each persona is probed by its own key: cscb_<key> for the key passed (b.av2 SR-2.2)', async () => {
    const { statusCalls, adapter } = makeHarness(undefined, LIVE_STATE, standIns('C1', 'C2'))

    expect(await adapter('C2')).toEqual(LIVENESS_READING_LIVE)
    expect(await adapter('C1')).toEqual(LIVENESS_READING_LIVE)

    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([
      personaInstanceId('C2'),
      personaInstanceId('C1'),
    ])
  })

  test('6. unknown key: reads dead without a status call and without touching outage flags', async () => {
    const { emissions, statusCalls, adapter } = makeHarness(undefined, LIVE_STATE)
    setOutageFlag('C9', 'ad-unreachable', '/bin/ad')
    const before = emissions.length

    const result = await adapter('C9')

    expect(result).toEqual(LIVENESS_READING_DEAD)
    expect(statusCalls).toHaveLength(0)
    // No probe ran, so nothing was cleared and no all-clear was posted.
    expect(getOutageFlags('C9').has('ad-unreachable')).toBe(true)
    expect(emissions.slice(before)).toHaveLength(0)
  })

  test('7. no persona config (MCP_HOST/MCP_PORT fallback): reads dead without a status call', async () => {
    const { statusCalls, adapter } = makeHarness(undefined, LIVE_STATE, null)

    expect(await adapter('C1')).toEqual(LIVENESS_READING_DEAD)
    expect(statusCalls).toHaveLength(0)
  })

  // AC 20 (b.av2 SR-10.3): the catch-all status-error line logs the error's
  // description (type, safe code, message through `redactSlackLogText`,
  // frames), never the error itself. The message carries the leak marker only
  // inside a fake token and a `ticket=` URL, both of which redaction replaces.
  // Every console.error argument is kept unformatted, so a raw error fails the check.
  test('AC 20: any other status error carrying fake tokens → one "status error" line naming its type, code and redacted message; reads unknown, no flag, nothing leaks', async () => {
    const statusError = Object.assign(new Error(`status failed (${sentinelInMessage('msg')})`), {
      code: 'EIO',
      detail: fakeToken(APP_TOKEN_PREFIX, 'detail'),
      note: LEAK_SENTINEL,
    })
    const { emissions, adapter } = makeHarness(statusError)

    const { result, errArgs } = await probeCapturingErrors(adapter, 'C1')

    expect(result).toEqual(LIVENESS_READING_UNKNOWN)
    expect(getOutageFlags('C1').size).toBe(0)
    expect(errArgs).toHaveLength(1)
    expect(errArgs[0]).toHaveLength(1)
    expect(String(errArgs[0]![0])).toStartWith(
      `[slack] isSessionAlive: status error for persona=C1: Error code=EIO message="status failed (${REDACTED_SENTINEL_TAIL})" at `,
    )
    assertNoLeak({ errArgs, emissions })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-105: the UNAVAILABLE forms the restart adapters meet (E10's five).
// Each is built by name for the verb its call uses. Where the builder takes a
// description it carries the leak marker inside a fake token and a `ticket=`
// URL (`sentinelInMessage`), which a described line redacts; `redacted` says
// the described line shows the redaction. An `ErrUnknownErrorName`'s own
// description is the client's, so its envelope's marked text is never logged.
// ---------------------------------------------------------------------------

/** This file's labels for the shared forms whose label it extends. */
const FORM_LABELS: Readonly<Record<string, string>> = {
  ErrUnknownErrorName: 'ErrUnknownErrorName (a name from a later binary)',
  ErrTmuxUnresponsive: 'ErrTmuxUnresponsive (by name)',
  ErrTmuxKillFailed: 'ErrTmuxKillFailed (by name)',
}

/** The marked builder of each shared form whose builder takes a description, and whether its described line shows the redacted marker. */
const MARKED_BUILDERS: Readonly<Record<string, { readonly build: (verb: string) => Error; readonly redacted: boolean }>> = {
  ErrUnknownErrorName: {
    build: () => errUnknownErrorName('ErrFromALaterBinary', `a later failure (${sentinelInMessage('unknown-name')})`),
    redacted: false,
  },
  'a wrapped UnknownError': {
    build: (verb) => errGeneric(verb, CSCB_UNKNOWN_ERROR_NAME, `Error: boom (${sentinelInMessage('wrapped')})`),
    redacted: true,
  },
  ErrTmuxUnresponsive: {
    build: (verb) => errTmuxUnresponsive(verb, `tmux did not answer (${sentinelInMessage('unresponsive')})`),
    redacted: true,
  },
}

/** [label, builder (by verb), described line shows the redacted marker, the retry cause kind a kill arms]. */
const UNAVAILABLE_FORMS: ReadonlyArray<readonly [string, (verb: string) => Error, boolean, string]> = unavailableForms(
  'ErrUnknownErrorName',
  'ErrCallTimeout',
  'a wrapped UnknownError',
  'ErrTmuxUnresponsive',
  'ErrTmuxKillFailed',
).map(([label, build, causeKind]) => [
  FORM_LABELS[label] ?? label,
  MARKED_BUILDERS[label]?.build ?? build,
  MARKED_BUILDERS[label]?.redacted ?? false,
  causeKind,
] as const)

/** Every `console.error` argument list `fn` writes, kept unformatted (console restored after). */
async function capturingErrorArgs<T>(fn: () => Promise<T>): Promise<{ result: T; errArgs: unknown[][] }> {
  const errArgs: unknown[][] = []
  const orig = console.error
  console.error = (...args: unknown[]) => { errArgs.push(args) }
  try {
    return { result: await fn(), errArgs }
  } finally {
    console.error = orig
  }
}

/** The lines `errArgs` holds, each argument a string (a raw error or object fails). */
function stringLines(errArgs: unknown[][]): string[] {
  return errArgs.map((args) => {
    for (const a of args) expect(typeof a).toBe('string')
    return args.join(' ')
  })
}

// ---------------------------------------------------------------------------
// _buildReconnectSessionAdapter (b.9a7 — working-state defer gate)
//
// The adapter probes AD state via withOutageDetection().status() before typing
// `/mcp reconnect`. If the row is `working` it returns 'transient' WITHOUT
// attempting the reconnect (hazard 2 / b.rmy: don't type into a session
// mid-turn). b.f2b: neither does an `ask_user` or `check_permission` row, a
// `waiting` row whose pane shows a running turn or a dialog, or a failed
// status probe (nothing is typed blind); a `working` row whose tmux session
// lives is reconnected only on the positive-idle rule (its pane's idle screen
// and its transcript's completed turn, unchanged across attempts spanning
// 60 s). b.dup: nor does a `pending` row, whose session has not started.
// Any other state falls through to the reconnectMcp send-keys
// attempt. reconnectMcp is a direct module import,
// but it drives its send-keys through the SAME withOutageDetection client the
// status probe uses, so the shared stub's `sendKeysCalls` is the observable
// seam for "was a reconnect attempted", and `sendKeysResult`/`sendKeysError`
// drive the ok→'success' / dead-session→'escalate-dead' mapping.
//
// b.d61: a `working` row whose tmux session is gone (the Claude inside it was
// killed mid-turn, so AD's row stays frozen at `working`) must not be deferred
// forever. The `working` branch probes the persona's `slack_bot_<key>` tmux
// session through the session manager's prober seam (`_setTmuxSessionProber`,
// installed by the harness so no test shells out to tmux): gone → the dead-tmux
// sweep and 'escalate-dead'; alive, or a probe that fails → the 'transient'
// defer, so a live turn is never poked (b.rmy) and a probe error never
// manufactures a false dead. While a launch for the persona is in flight the
// `working` row is deferred without a probe: the launch owns the session, and a
// tmux session it has not created yet is no proof of death.
//
// b.jdc: an `ask_user` or `check_permission` row is never typed into, but it
// is probed the same way before it is deferred or reported: a gone tmux
// session is swept and escalated with no notice, and a live one's deferrals
// sweep and read the row again from 10 min on (the b.jdc block at the end).
// ---------------------------------------------------------------------------

describe('_buildReconnectSessionAdapter', () => {
  /**
   * Build a stub client wired into BOTH outage-state (which withOutageDetection
   * calls via getClient) and setClientForTests, plus a reconnect adapter. The
   * status probe and reconnectMcp's send-keys both flow through this one client.
   * `tmux` is what the tmux-session prober reports (default alive); every name
   * it is asked about lands in `tmuxProbes`. `stub` is the shared client, for a
   * test that holds a launch's spawn open on it (`holdSpawns`).
   */
  function makeHarness(opts: {
    /** Read at each status probe, so a test may change it between attempts. */
    statusState?: string
    /** When set, each status probe rejects with it instead (read at each probe). */
    statusError?: Error
    sendKeysThrows?: Error
    /** Errors the send-keys calls answer in turn, before `sendKeysThrows` or success. */
    sendKeysErrors?: Error[]
    tmux?: 'alive' | 'gone' | 'probe-error'
    /** What every pane read shows (default: the stub's empty pane). */
    pane?: string
    /** The transcript fields of the `working` row `get` answers (default: the stub's row, which names no transcript). */
    row?: { jsonl_path?: string; claude_session_id: string; cwd?: string }
    /** The adapter's persona lookup (production: `getAppliedPersona`). */
    getPersona?: (key: string) => Persona | undefined
    /** The state every status probe reads once a findMissing sweep has run (default: `statusState`). */
    statusAfterSweep?: string
    /** The `launch_started_at` every status result shows (default: none, the key absent). */
    launchStartedAt?: string
    /** When set, every findMissing sweep rejects with it. */
    findMissingError?: Error
  }): {
    adapter: (channelId: string) => Promise<'success' | 'escalate-dead' | 'transient' | 'pending'>
    statusCalls: StatusParams[]
    sendKeysCalls: SendKeysParams[]
    findMissingCalls: FindMissingParams[]
    readPaneCalls: ReadPaneParams[]
    killCalls: KillParams[]
    spawnCalls: SpawnParams[]
    resumeCalls: ResumeParams[]
    tmuxProbes: string[]
    stub: StubClient
  } {
    const statusCalls: StatusParams[] = []
    const sendKeysCalls: SendKeysParams[] = []
    const findMissingCalls: FindMissingParams[] = []
    const readPaneCalls: ReadPaneParams[] = []
    const killCalls: KillParams[] = []
    const spawnCalls: SpawnParams[] = []
    const resumeCalls: ResumeParams[] = []
    const tmuxProbes: string[] = []
    _setTmuxSessionProber(async (name) => {
      tmuxProbes.push(name)
      if (opts.tmux === 'probe-error') throw new Error('tmux probe failed')
      return opts.tmux !== 'gone'
    })
    const stub = makeStubClient({
      statusCalls,
      statusFn: () =>
        opts.statusError ??
        cannedStatusResult({
          state: (findMissingCalls.length > 0 ? opts.statusAfterSweep : undefined) ?? opts.statusState ?? 'waiting',
          launch_started_at: opts.launchStartedAt,
        }),
      sendKeysCalls,
      sendKeysError: opts.sendKeysThrows,
      sendKeysResult: opts.sendKeysThrows ? undefined : {},
      sendKeysQueue: opts.sendKeysErrors?.map((e) => cannedErr<SendKeysResult>(e)),
      // The escalate-dead sweep (reconcileMissingSweep → client.findMissing({}))
      // flows through this SAME stub client. `findMissingCalls` is the observable
      // seam for "was the memoized sweep triggered".
      findMissingCalls,
      findMissingError: opts.findMissingError,
      readPaneCalls,
      killCalls,
      spawnCalls,
      resumeCalls,
      readPaneResults: opts.pane === undefined ? undefined : [{ pane: opts.pane }],
      getResult: opts.row === undefined ? undefined : cannedGetResult({ claude_instance_id: 'cscb_C1', state: 'working', ...opts.row }),
    })
    _resetOutageState()
    initOutageState({
      notify: () => {},
      getClient: () => stub as unknown as Client,
    })
    setClientForTests(stub as unknown as Client)
    // Seam: reconnectMcp's ErrTmuxSendKeys self-heal calls _ensureTmuxServer
    // between the two send-keys attempts. Stub it so the dead-session path
    // (double ErrTmuxSendKeys) never touches a live tmux server.
    _setTmuxServerEnsurer(async () => {})
    return {
      // The builder resolves the instance ID from the persona key alone
      // (b.av2 SR-2.2); its persona lookup only locates a `working` row's
      // transcript (b.f2b).
      adapter: _buildReconnectSessionAdapter(opts.getPersona),
      statusCalls,
      sendKeysCalls,
      findMissingCalls,
      readPaneCalls,
      killCalls,
      spawnCalls,
      resumeCalls,
      tmuxProbes,
      stub,
    }
  }

  /** Per-test temp directory (persona paths and the spawn home); removed in afterEach. */
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'server-reconnect-'))
    // The escalate-dead sweep is memoized (b.m4r, 10s TTL). Clear the memo so a
    // sweep from another test can't satisfy this test's findMissing assertion —
    // the TTL setter alone does not clear an already-populated memo entry.
    _resetFindMissingMemo()
  })

  afterEach(() => {
    resetClientForTests()
    _resetOutageState()
    _resetTmuxServerEnsurer()
    _resetTmuxSessionProber()
    _resetFindMissingMemo()
    _resetInFlightLaunches()
    _resetSpawnHomeDir()
    // b.f2b: the working-row evidence and notice latches, and the clock seam.
    _resetNotConnectedEpisodes()
    _resetNow()
    rmSync(dir, { recursive: true, force: true })
  })

  test.each(['alive', 'probe-error'] as const)("(i) AD state 'working', tmux session %s → returns 'transient' and does NOT attempt the send-keys reconnect or sweep", async (tmux) => {
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls, tmuxProbes } = makeHarness({ statusState: 'working', tmux })

    const result = await adapter('C1')

    expect(result).toBe('transient')
    // The persona's own tmux session was probed (the probe-error row: it ran
    // and threw, and the throw deferred rather than escalated).
    expect(tmuxProbes).toEqual(['slack_bot_C1'])
    // The probe ran against the persona's cscb_<key> instance...
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0].claude_instance_id).toBe(personaInstanceId('C1'))
    expect(statusCalls[0].claude_instance_id).toBe('cscb_C1')
    // ...but the working-state defer short-circuited before reconnectMcp — no
    // `/mcp reconnect` was typed into the pane (b.rmy: a live turn is never
    // poked; a failed tmux probe is no proof the session is dead).
    expect(sendKeysCalls).toHaveLength(0)
    // b.9a7: the transient path never escalates, so no sweep fires.
    expect(findMissingCalls).toHaveLength(0)
  })

  test("(i-b) b.d61: AD state 'working' but the persona's tmux session is gone → 'escalate-dead' with one findMissing sweep, and no send-keys reconnect", async () => {
    // The live Check 7 shape: `tmux kill-session -t slack_bot_<key>` mid-turn
    // leaves AD's row frozen at `working`. Deferring it as 'transient' would
    // repeat on every tick and the persona would never relaunch.
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls, tmuxProbes } = makeHarness({
      statusState: 'working',
      tmux: 'gone',
    })

    const result = await adapter('C1')

    expect(result).toBe('escalate-dead')
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1'])
    // The probe asked about the persona's own tmux session.
    expect(tmuxProbes).toEqual(['slack_bot_C1'])
    // Nothing is typed into a pane that no longer exists.
    expect(sendKeysCalls).toHaveLength(0)
    // The dead-tmux sweep reconciles the frozen row to `missing`, so the
    // restart run's liveness re-probe reads the session dead and relaunches it
    // in that same run.
    expect(findMissingCalls).toHaveLength(1)
  })

  test("(i-c) b.d61: AD state 'working' while a launch for the persona is in flight → 'transient' with no tmux probe, sweep or send-keys, even with its tmux session gone", async () => {
    // The launch resolves its unset claude_config_dir against a temp home.
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
    _setSpawnHomeDir(join(dir, 'home'))
    const config = makeStandInPersonaConfig({ C1: {} }, dir)
    // Tmux gone: with nothing in flight this row escalates (i-b).
    const { adapter, stub, statusCalls, sendKeysCalls, findMissingCalls, tmuxProbes } = makeHarness({
      statusState: 'working',
      tmux: 'gone',
    })
    // A launch whose tmux session is not created yet: its spawn is held open.
    const held = holdSpawns(stub)
    const launch = spawnForPersona(config.personas[0]!, config, false)
    try {
      await held.entered('cscb_C1')
      expect(isLaunchInFlight('C1')).toBe(true)

      const result = await adapter('C1')

      expect(result).toBe('transient')
      expect(statusCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1'])
      expect(tmuxProbes).toEqual([])
      expect(findMissingCalls).toHaveLength(0)
      expect(sendKeysCalls).toHaveLength(0)
    } finally {
      // Settle the held launch before teardown.
      held.releaseAll()
      await launch
    }
  })

  test("(ii) non-working live state ('waiting') → reconnect IS attempted, maps ok → 'success'", async () => {
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls } = makeHarness({ statusState: 'waiting' })

    const result = await adapter('C1')

    // Not deferred: the send-keys reconnect ran and succeeded (reconnectMcp 'ok').
    expect(result).toBe('success')
    expect(statusCalls).toHaveLength(1)
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toContain('/mcp reconnect')
    // Both the probe and the reconnect address cscb_<key>.
    expect(statusCalls[0].claude_instance_id).toBe('cscb_C1')
    expect(sendKeysCalls[0].claude_instance_id).toBe('cscb_C1')
    // b.9a7: the success path never escalates, so no sweep fires.
    expect(findMissingCalls).toHaveLength(0)
  })

  // b.f2b: a failed status probe says nothing about the session (it may be
  // mid-turn), so nothing is typed blind: 'transient', and the next tick
  // retries. Before b.f2b it fell through to the reconnect.
  test("(iii) status-probe error → 'transient' with no send-keys, pane read or sweep; one token-safe line; it ends the working-row evidence", async () => {
    const statusError = Object.assign(new Error(`status failed (${sentinelInMessage('reconnect')})`), { code: 'EIO', note: LEAK_SENTINEL })
    _setNow(createFakeClock().now)
    const transcript = join(dir, `${TRANSCRIPT_SESSION_ID}.jsonl`)
    writeTranscript(transcript, endedTurn())
    const opts: Parameters<typeof makeHarness>[0] = {
      statusState: 'working',
      tmux: 'alive',
      pane: IDLE_PANE,
      row: { jsonl_path: transcript, claude_session_id: TRANSCRIPT_SESSION_ID },
    }
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls, readPaneCalls } = makeHarness(opts)
    // An idle working row first: evidence a later attempt could conclude.
    expect(await adapter('C1')).toBe('transient')
    expect(hasPendingWorkingRowEvidence('C1')).toBe(true)
    opts.statusError = statusError

    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let result: string | undefined
    try {
      result = await adapter('C1')
    } finally {
      console.error = orig
    }

    expect(result).toBe('transient')
    expect(statusCalls).toHaveLength(2)
    expect(readPaneCalls).toHaveLength(1) // the first attempt's only
    expect(sendKeysCalls).toHaveLength(0)
    expect(findMissingCalls).toHaveLength(0)
    expect(hasPendingWorkingRowEvidence('C1')).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(
      `[slack] reconnectSession: persona=C1 status check failed: Error code=EIO message="status failed (${REDACTED_SENTINEL_TAIL})" at `,
    )
    expect(lines[0]).toContain('— not typing /mcp reconnect blind; deferring to a later tick')
    assertNoLeak({ lines })
  })

  // b.jg5 SRJ-115 (Task ruling): the adapter's state read keeps 'transient'
  // for every status error, ErrSpawnNotFound included (SRJ-105: it keeps each
  // site's meaning; the next liveness read reads it dead). Nothing is typed,
  // read or swept, and no error escalates to dead here.
  test.each([
    ['ErrSpawnNotFound', () => errSpawnNotFound()],
    ['ErrSystemInstallDisappeared', () => errSystemInstallDisappeared('status')],
    ['ErrCallTimeout', () => errCallTimeout('status')],
    ['ErrTmuxUnresponsive (by name)', () => errTmuxUnresponsive('status')],
    ['a plain Error', () => new Error('boom')],
  ])("SRJ-115: %s at the state read → 'transient', never 'escalate-dead'; no send-keys, pane read, tmux probe or sweep; one line", async (_label, build) => {
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls, readPaneCalls, tmuxProbes } = makeHarness({
      statusError: build(),
    })
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let result: string | undefined
    try {
      result = await adapter('C1')
    } finally {
      console.error = orig
    }

    expect(result).toBe('transient')
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    expect(sendKeysCalls).toEqual([])
    expect(readPaneCalls).toEqual([])
    expect(tmuxProbes).toEqual([])
    expect(findMissingCalls).toHaveLength(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith('[slack] reconnectSession: persona=C1 status check failed: ')
  })

  // b.jg5 SRJ-115, SRJ-316: a CONFIG answer at the state read is the same
  // 'transient' with nothing typed, read or swept; the outage wrapper also
  // raises `ad-config-malformed`, which adds its one raise line.
  test("SRJ-115, SRJ-316: a CONFIG answer (ErrConfigMalformed) at the state read → 'transient', never 'escalate-dead'; no send-keys, pane read, tmux probe or sweep; ad-config-malformed raised; the status-check line and one raise line", async () => {
    const { result, errArgs, statusCalls, sendKeysCalls, findMissingCalls, readPaneCalls, tmuxProbes, killCalls, spawnCalls, resumeCalls } = await reconnectCapturing({
      statusError: errConfigMalformed(),
    })

    expect(result).toBe('transient')
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    expect([sendKeysCalls, readPaneCalls, tmuxProbes, killCalls, spawnCalls, resumeCalls]).toEqual([[], [], [], [], [], []])
    expect(findMissingCalls).toHaveLength(0)
    expect([...getOutageFlags('C1')]).toEqual(['ad-config-malformed'])
    const lines = stringLines(errArgs)
    expect(lines.filter((l) => l.startsWith('[slack] reconnectSession: persona=C1 status check failed: '))).toHaveLength(1)
    expect(lines.filter((l) => l.includes('ad-config-malformed raised for persona=C1'))).toHaveLength(1)
    expect(lines).toHaveLength(2)
    assertNoLeak({ errArgs })
  })

  test("(iv) reconnectMcp 'dead-session' → 'escalate-dead', firing exactly one memoized findMissing sweep (b.sv7 / Epic t1.tkk.e4)", async () => {
    // Persistent ErrTmuxSendKeys: the first send-keys AND the self-heal retry
    // both fail, so reconnectMcp returns 'dead-session' (b.3ce). The status
    // probe is 'waiting' (not 'working'), so the adapter does NOT defer — it
    // falls through to reconnectMcp and the dead-session escalate branch.
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls } = makeHarness({
      statusState: 'waiting',
      sendKeysThrows: errTmuxSendKeys(),
    })

    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let result: string | undefined
    try {
      result = await adapter('C1')
    } finally {
      console.error = orig
    }

    // Mapping is byte-for-byte unchanged per b.9a7: dead-session → 'escalate-dead'.
    expect(result).toBe('escalate-dead')
    // Both keystrokes failed with ErrTmuxSendKeys: the tmux session is gone.
    expect(lines.filter((l) => l.startsWith('[slack] escalate-dead: persona='))).toEqual([
      '[slack] escalate-dead: persona=C1 verdict=dead-session — tmux session provably dead, triggering internal findMissing reconciliation (the restart relaunches it once its row reads dead; ~/startup/find-missing-loop.sh is belt-and-braces)',
    ])
    expect(statusCalls).toHaveLength(1)
    // Two send-keys attempts (original + one self-heal retry) both threw.
    expect(sendKeysCalls).toHaveLength(2)
    expect(sendKeysCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1', 'cscb_C1'])
    // The escalate-dead branch fires sweepDeadTmuxChannel → the memoized
    // reconcileMissingSweep → exactly ONE client.findMissing({}). No direct new
    // findMissing call site; the memoized helper is the only sweep mechanism.
    expect(findMissingCalls).toHaveLength(1)
  })

  // b.jg5 SRJ-105: an UNAVAILABLE `send-keys` (at the first try, or at the
  // retry after ErrTmuxSendKeys) is a refusal: 'transient', never
  // 'escalate-dead', no sweep and no spawn-failure notice. One refusal line
  // describes the error (never the raw value); nothing leaks.
  /** reconnectMcp's refusal line for persona C1, for the call `what`. */
  const sendKeysRefusedLine = (what: string, err: unknown): string =>
    `[slack] reconnectMcp: ${what} refused for persona=C1: ${describeAgentDirectorFailure(err)} — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)`

  /** Run the adapter for C1 over `opts`, capturing notices and console.error. */
  async function reconnectCapturing(opts: Parameters<typeof makeHarness>[0]) {
    const raised: string[] = []
    setSessionNotifier((key) => { raised.push(key) })
    try {
      const h = makeHarness(opts)
      const { result, errArgs } = await capturingErrorArgs(() => h.adapter('C1'))
      return { ...h, result, errArgs, raised }
    } finally {
      setSessionNotifier(undefined)
    }
  }

  test.each(UNAVAILABLE_FORMS)("SRJ-105: send-keys refused with %s → 'transient', never 'escalate-dead'; one send-keys, no sweep, no spawn-failure notice; one described refusal line, nothing leaks", async (_label, build, redacted) => {
    const err = build('send-keys')

    const { result, errArgs, raised, sendKeysCalls, findMissingCalls } = await reconnectCapturing({ statusState: 'waiting', sendKeysThrows: err })

    expect(result).toBe('transient')
    expect(sendKeysCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    expect(findMissingCalls).toHaveLength(0)
    expect(raised).toEqual([])
    const lines = stringLines(errArgs)
    expect(lines.filter((l) => l.startsWith('[slack] reconnectMcp:'))).toEqual([sendKeysRefusedLine('send-keys', err)])
    expect(lines.filter((l) => l.startsWith('[slack] escalate-dead'))).toEqual([])
    if (redacted) expect(lines.join('\n')).toContain(REDACTED_SENTINEL_TAIL)
    assertNoLeak({ errArgs })
  })

  test.each(UNAVAILABLE_FORMS)("SRJ-105: ErrTmuxSendKeys, then the retry refused with %s → 'transient', never 'escalate-dead'; two send-keys, no sweep, no spawn-failure notice; one described refusal line, nothing leaks", async (_label, build, redacted) => {
    const err = build('send-keys')

    const { result, errArgs, raised, sendKeysCalls, findMissingCalls } = await reconnectCapturing({
      statusState: 'waiting',
      sendKeysErrors: [errTmuxSendKeys(), err],
    })

    expect(result).toBe('transient')
    expect(sendKeysCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1'), personaInstanceId('C1')])
    expect(findMissingCalls).toHaveLength(0)
    expect(raised).toEqual([])
    const lines = stringLines(errArgs)
    expect(lines.filter((l) => l.includes(' refused for persona=C1'))).toEqual([
      sendKeysRefusedLine('retry send-keys after ErrTmuxSendKeys', err),
    ])
    expect(lines.filter((l) => l.startsWith('[slack] escalate-dead'))).toEqual([])
    if (redacted) expect(lines.join('\n')).toContain(REDACTED_SENTINEL_TAIL)
    assertNoLeak({ errArgs })
  })

  // b.jg5 SRJ-105, SRJ-316: a CONFIG `send-keys` (at the first try, or at the
  // retry after ErrTmuxSendKeys) is the same refusal: 'transient', never
  // 'escalate-dead', no sweep, kill or launch and no spawn-failure notice.
  // The outage wrapper raises `ad-config-malformed`.
  test.each([
    ['at the first try', 'send-keys', (err: Error) => ({ sendKeysThrows: err }), 1],
    ['at the retry after ErrTmuxSendKeys', 'retry send-keys after ErrTmuxSendKeys', (err: Error) => ({ sendKeysErrors: [errTmuxSendKeys(), err] }), 2],
  ] as const)("SRJ-105, SRJ-316: send-keys answers a CONFIG answer (ErrConfigMalformed) %s → 'transient', never 'escalate-dead'; no sweep, kill or launch, no spawn-failure notice; one described refusal line; ad-config-malformed raised; nothing leaks", async (_label, what, sendKeys, sends) => {
    const err = errConfigMalformed('starting_session_seconds', sentinelInMessage('send-keys-config'))

    const { result, errArgs, raised, sendKeysCalls, findMissingCalls, killCalls, spawnCalls, resumeCalls } = await reconnectCapturing({
      statusState: 'waiting',
      ...sendKeys(err),
    })

    expect(result).toBe('transient')
    expect(sendKeysCalls).toHaveLength(sends)
    expect(findMissingCalls).toHaveLength(0)
    expect([killCalls, spawnCalls, resumeCalls]).toEqual([[], [], []])
    expect(raised).toEqual([])
    expect([...getOutageFlags('C1')]).toEqual(['ad-config-malformed'])
    const lines = stringLines(errArgs)
    expect(lines.filter((l) => l.includes(' refused for persona=C1'))).toEqual([sendKeysRefusedLine(what, err)])
    expect(lines.filter((l) => l.startsWith('[slack] escalate-dead'))).toEqual([])
    assertNoLeak({ errArgs })
  })

  // b.jg5 SRJ-105, SRJ-313, SRJ-113: an UNCLASSIFIED `send-keys` (an
  // `ErrInternal`, a name CSCB gives no handling, or
  // `ErrSystemInstallDisappeared`, whose wrapper raises `ad-unreachable`), at
  // the first try or at the retry after ErrTmuxSendKeys, is the same refusal:
  // 'transient', never 'escalate-dead', no sweep, kill or launch and no
  // spawn-failure notice; one described refusal line, nothing leaks.
  const UNCLASSIFIED_SEND_KEYS_ERRORS: ReadonlyArray<readonly [string, () => Error]> = [
    ['ErrInternal', () => errInternal(`the store could not be read (${sentinelInMessage('send-keys-internal')})`)],
    ['a name CSCB gives no handling', () => errGeneric('send-keys', 'ErrSendKeysBroken', `the keystrokes broke (${sentinelInMessage('send-keys-generic')})`)],
    ['ErrSystemInstallDisappeared', () => errSystemInstallDisappeared('send-keys')],
  ]
  /** Where the keystrokes meet the error: the label, the refusal line's call, the harness options and the send-keys made. */
  const SEND_KEYS_POSITIONS = [
    ['at the first try', 'send-keys', (err: Error) => ({ sendKeysThrows: err }), 1],
    ['at the retry after ErrTmuxSendKeys', 'retry send-keys after ErrTmuxSendKeys', (err: Error) => ({ sendKeysErrors: [errTmuxSendKeys(), err] }), 2],
  ] as const
  test.each(UNCLASSIFIED_SEND_KEYS_ERRORS.flatMap(([label, build]) =>
    SEND_KEYS_POSITIONS.map(([where, what, sendKeys, sends]) => [label, where, what, sendKeys, sends, build] as const),
  ))("b.jg5 SRJ-313: send-keys answers %s (UNCLASSIFIED) %s → 'transient', never 'escalate-dead'; no sweep, kill or launch, no spawn-failure notice; one described refusal line; nothing leaks", async (_label, _where, what, sendKeys, sends, build) => {
    const err = build()

    const { result, errArgs, raised, sendKeysCalls, findMissingCalls, killCalls, spawnCalls, resumeCalls } = await reconnectCapturing({
      statusState: 'waiting',
      ...sendKeys(err),
    })

    expect(result).toBe('transient')
    expect(sendKeysCalls).toHaveLength(sends)
    expect(findMissingCalls).toHaveLength(0)
    expect([killCalls, spawnCalls, resumeCalls]).toEqual([[], [], []])
    expect(raised).toEqual([])
    const lines = stringLines(errArgs)
    expect(lines.filter((l) => l.includes(' refused for persona=C1'))).toEqual([sendKeysRefusedLine(what, err)])
    expect(lines.filter((l) => l.startsWith('[slack] escalate-dead'))).toEqual([])
    expect(lines.filter((l) => l.includes(' failed for persona=C1'))).toEqual([])
    assertNoLeak({ errArgs })
  })

  // A class that is no refusal still raises the spawn-failure notice: an
  // UNUSABLE NAME `ErrInternal` (its own handling, SRJ-105) answers
  // 'transient' with one notice and no refusal line (the contrast that shows
  // the notice spy above is live).
  test("SRJ-105 contrast: send-keys answering an UNUSABLE NAME ErrInternal (no refusal) → 'transient' with one spawn-failure notice and no refusal line", async () => {
    const { result, errArgs, raised, findMissingCalls } = await reconnectCapturing({ statusState: 'waiting', sendKeysThrows: errUnusableName() })

    expect(result).toBe('transient')
    expect(findMissingCalls).toHaveLength(0)
    expect(raised).toEqual(['C1'])
    const lines = stringLines(errArgs)
    expect(lines.filter((l) => l.includes(' refused for '))).toEqual([])
    expect(lines.filter((l) => l.startsWith('[slack] reconnectMcp: send-keys failed for persona=C1: '))).toHaveLength(1)
  })

  // b.dup: agent-director refuses send-keys to an `ended` or `missing` row
  // with ErrSpawnNotInteractive. A findMissing sweep can mark the row missing
  // after the adapter read it (here `waiting`, or `missing` when the sweep
  // landed between the liveness probe and the adapter's status read) and
  // before its keystrokes land. The claude process is gone: reconnectMcp
  // answers 'dead-session', so the adapter escalates, and the restart run's
  // re-probe relaunches the persona (restart.test.ts, b.dup). Before the fix:
  // 'transient' and a spawn-failure notice.
  // b.jdc (b.dup review): the escalate-dead line says why. Here the tmux
  // session may well be alive: agent-director refused the keystrokes because
  // the row is not interactive, so the line must not claim the tmux session is
  // provably dead (REPRO for the wording: the old line always did).
  test.each(['waiting', 'missing'])("REPRO (b.dup): the row reads %s and the reconnect's keystrokes are refused (ErrSpawnNotInteractive) → 'escalate-dead' with one sweep and one send-keys (no tmux-server retry); no spawn-failure notice; the escalate-dead line says the row is not interactive", async (state) => {
    const raised: string[] = []
    setSessionNotifier((key) => { raised.push(key) })
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    try {
      const { adapter, sendKeysCalls, findMissingCalls } = makeHarness({ statusState: state, sendKeysThrows: errSpawnNotInteractive('send-keys') })

      const result = await adapter('C1')

      expect(result).toBe('escalate-dead')
      expect(sendKeysCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1'])
      expect(findMissingCalls).toHaveLength(1)
      expect(raised).toEqual([])
      expect(lines.filter((l) => l.startsWith('[slack] escalate-dead: persona='))).toEqual([
        '[slack] escalate-dead: persona=C1 verdict=row-not-interactive — row not interactive (agent-director refused the /mcp reconnect keystrokes: it ended the row or marked it missing, so its claude process is gone), triggering internal findMissing reconciliation (the restart relaunches it once its row reads dead; ~/startup/find-missing-loop.sh is belt-and-braces)',
      ])
    } finally {
      console.error = orig
      setSessionNotifier(undefined)
    }
  })

  // b.dup: a `pending` row's session has not started (SessionStart has not
  // fired). agent-director refuses send-keys to it, and the session connects
  // its MCP servers once it starts, so nothing is typed, and a later tick
  // retries. Before the fix the adapter typed, the refusal raised a
  // spawn-failure notice, and it answered 'transient'. b.jg5 SRJ-303: the
  // deferral answers 'pending' (restart.ts treats it as 'transient'), so the
  // UNAVAILABLE retry timer knows the row read `pending`. b.jg5 SRJ-115: the
  // row's raw launch start, when its status result shows one, is passed to
  // `deferPendingRow`, and the deferral line names it.
  /** The deferral line for persona C1, by the launch start it names (`''`: none). */
  const deferralLine = (launch: string): string =>
    `[slack] Deferring persona=C1: its row reads pending${launch} — its session has not started (SessionStart has not fired), agent-director refuses send-keys until it does, and it connects on its own once it starts; no reconnect, kill or launch, nothing counted (b.dup)`
  const DEFERRAL_CASES: ReadonlyArray<readonly [string, string | undefined, string]> = [
    ['no launch start', SAMPLE_LAUNCH_START_NONE, ''],
    ...LAUNCH_STARTS.map((start) => [`launch start ${start}`, start, ` (launch started ${start})`] as const),
  ]

  test.each(DEFERRAL_CASES)("REPRO (b.dup), b.jg5 SRJ-303/SRJ-115: a pending row showing %s → 'pending' with no send-keys, pane read, tmux probe or sweep, no notice, and one line naming its launch start", async (_label, launchStartedAt, launch) => {
    const raised: string[] = []
    setSessionNotifier((key) => { raised.push(key) })
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    try {
      const { adapter, sendKeysCalls, findMissingCalls, readPaneCalls, tmuxProbes } = makeHarness({
        statusState: AGENT_DIRECTOR_PENDING_STATE,
        launchStartedAt,
        sendKeysThrows: errSpawnNotInteractive('send-keys'),
      })

      const result = await adapter('C1')

      expect(result).toBe('pending')
      expect(sendKeysCalls).toEqual([])
      expect(readPaneCalls).toEqual([])
      expect(tmuxProbes).toEqual([])
      expect(findMissingCalls).toHaveLength(0)
      expect(raised).toEqual([])
      expect(lines).toEqual([deferralLine(launch)])
    } finally {
      console.error = orig
      setSessionNotifier(undefined)
    }
  })

  // b.jg5 SRJ-314: the restart work calls `deferPendingRow` itself (bound in
  // main()). Called directly it makes no agent-director call (nothing typed,
  // read or swept), raises no notice, logs its line and answers 'pending'.
  test.each(DEFERRAL_CASES)("deferPendingRow called directly with %s → 'pending'; no agent-director call, no notice; one line naming its launch start", (_label, launchStartedAt, launch) => {
    const raised: string[] = []
    setSessionNotifier((key) => { raised.push(key) })
    const { statusCalls, sendKeysCalls, findMissingCalls, readPaneCalls, tmuxProbes } = makeHarness({})
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let result: string | undefined
    try {
      result = deferPendingRow('C1', launchStartedAt)
    } finally {
      console.error = orig
      setSessionNotifier(undefined)
    }

    expect(result).toBe('pending')
    expect(statusCalls).toEqual([])
    expect(sendKeysCalls).toEqual([])
    expect(readPaneCalls).toEqual([])
    expect(findMissingCalls).toHaveLength(0)
    expect(tmuxProbes).toEqual([])
    expect(raised).toEqual([])
    expect(lines).toEqual([deferralLine(launch)])
  })

  // The launch start comes from agent-director, so the deferral line names it
  // only when it passes `LAUNCH_START_LOG_RE` (timestamp characters, at most
  // 40): a line break that could fake a `[slack]` line, an over-long value or
  // other text is left out of the line, which is otherwise unchanged.
  /** Timestamp characters only, but longer than the pattern allows. */
  const OVER_LONG_LAUNCH_START = SAMPLE_LAUNCH_START_WHOLE.repeat(3)
  const UNLOGGABLE_LAUNCH_STARTS: ReadonlyArray<readonly [string, string, string]> = [
    // [label, launch start, text that must not reach the output]
    ['a line break and a fake [slack] line', `${SAMPLE_LAUNCH_START_WHOLE}\n[slack] fake`, '[slack] fake'],
    ['an over-long value', OVER_LONG_LAUNCH_START, OVER_LONG_LAUNCH_START],
    ['other characters', `${SAMPLE_LAUNCH_START_WHOLE} <@U000FAKE> hi`, '<@U000FAKE>'],
  ]

  test('LAUNCH_START_LOG_RE: every sample launch start passes; the unloggable ones fail (the over-long one on length alone)', () => {
    for (const start of LAUNCH_STARTS) expect(LAUNCH_START_LOG_RE.test(start)).toBe(true)
    for (const [, start] of UNLOGGABLE_LAUNCH_STARTS) expect(LAUNCH_START_LOG_RE.test(start)).toBe(false)
    expect(LAUNCH_START_LOG_RE.test(OVER_LONG_LAUNCH_START.slice(0, 40))).toBe(true)
  })

  test.each(UNLOGGABLE_LAUNCH_STARTS)("deferPendingRow called directly with a launch start holding %s → 'pending'; exactly one line, without the launch part or the injected text", (_label, launchStartedAt, injected) => {
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let result: string | undefined
    try {
      result = deferPendingRow('C1', launchStartedAt)
    } finally {
      console.error = orig
    }

    expect(result).toBe('pending')
    expect(lines).toEqual([deferralLine('')])
    expect(lines[0]).not.toContain('\n')
    expect(lines[0]).not.toContain('launch started')
    expect(lines[0]).not.toContain(injected)
  })

  test.each(LAUNCH_STARTS)("deferPendingRow called directly with the valid launch start %s → one line naming it", (start) => {
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    try {
      deferPendingRow('C1', start)
    } finally {
      console.error = orig
    }

    expect(lines).toEqual([deferralLine(` (launch started ${start})`)])
  })

  test('(v) the key passed selects the instance: a non-channel-form key probes and reconnects cscb_<key> (b.av2 SR-2.2)', async () => {
    const { adapter, statusCalls, sendKeysCalls } = makeHarness({ statusState: 'waiting' })

    const result = await adapter('ops_bot')

    expect(result).toBe('success')
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('ops_bot')])
    expect(sendKeysCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_ops_bot'])
  })

  // b.f2b: a `working` row can be stale (agent-director left it `working`
  // after the turn ended), and deferring on it forever stranded the persona.
  // With its tmux session alive, each attempt reads the pane once and, for an
  // idle screen, the transcript the row names; the evidence is kept across
  // attempts (a tick or more apart, here on a fake clock passed to the
  // session manager's `_setNow`), and the attempt that finds the same idle
  // screen and the same transcript, ended with a completed turn, across 60 s
  // types `/mcp reconnect`. A running turn, and a prompt or dialog
  // (`ask_user` / `check_permission`, or on a `waiting` row's pane), are
  // never typed into (b.rmy).
  describe('b.f2b: a working row\'s evidence, and rows waiting on a prompt', () => {
    let clock: FakeClock
    let raised: Array<{ key: string; text: string }>

    beforeEach(() => {
      clock = createFakeClock()
      _setNow(clock.now)
      raised = []
      setSessionNotifier((key, text) => { raised.push({ key, text }) })
    })

    afterEach(() => {
      setSessionNotifier(undefined)
    })

    /** A finished turn's transcript for C1's row, in the test's directory; the row fields that name it. */
    function endedTranscript(): { jsonl_path: string; claude_session_id: string } {
      const path = join(dir, `${TRANSCRIPT_SESSION_ID}.jsonl`)
      writeTranscript(path, endedTurn())
      return { jsonl_path: path, claude_session_id: TRANSCRIPT_SESSION_ID }
    }

    /** Attempt a reconnect of C1 `n` times, `stepMs` apart; the verdicts in order. */
    async function attempts(adapter: (key: string) => Promise<string>, n: number, stepMs: number): Promise<string[]> {
      const verdicts: string[] = []
      for (let i = 0; i < n; i++) {
        if (i > 0) await clock.advance(stepMs)
        verdicts.push(await adapter('C1'))
      }
      return verdicts
    }

    test("REPRO: a working row whose pane keeps the same idle screen and whose transcript ends with a completed turn: attempts read C1's own pane and defer with nothing typed until that has held for 60 s, then the attempt types /mcp reconnect → 'success'", async () => {
      const h = makeHarness({ statusState: 'working', tmux: 'alive', pane: IDLE_PANE, row: endedTranscript() })

      expect(await attempts(h.adapter, 2, 30_000)).toEqual(['transient', 'transient'])
      expect(h.sendKeysCalls).toEqual([])
      await clock.advance(30_000)
      expect(await h.adapter('C1')).toBe('success')

      expect(h.readPaneCalls).toEqual(Array(3).fill({ claude_instance_id: 'cscb_C1', n_lines: 40 }))
      expect(h.sendKeysCalls.map((c) => [c.claude_instance_id, c.text])).toEqual([['cscb_C1', `/mcp reconnect ${MCP_SERVER_NAME}`]])
      expect(h.findMissingCalls).toHaveLength(0)
      expect(raised).toEqual([])
    })

    test("the persona lookup locates a fresh session's transcript (no persisted path) under the persona's claude_config_dir: reconnected once the evidence has held for 60 s", async () => {
      const configDir = join(dir, 'persona-claude')
      const persona = makeStandInPersonaConfig({ C1: { claude_config_dir: configDir } }, dir).personas[0]!
      const cwd = '/work/c1'
      const composed = resolveJsonlPath(cwd, TRANSCRIPT_SESSION_ID, configDir)
      mkdirSync(join(composed, '..'), { recursive: true })
      writeTranscript(composed, endedTurn())
      const looked: string[] = []
      const h = makeHarness({
        statusState: 'working',
        tmux: 'alive',
        pane: IDLE_PANE,
        row: { claude_session_id: TRANSCRIPT_SESSION_ID, cwd },
        getPersona: (key) => (looked.push(key), persona),
      })

      expect(await attempts(h.adapter, 2, STALE_WORKING_WINDOW_MS)).toEqual(['transient', 'success'])
      expect(looked).toEqual(['C1', 'C1'])
    })

    test("b.rmy: a working row whose pane shows a running turn is never typed into, however long, though its transcript ends with a completed turn: 'transient' on every attempt", async () => {
      const h = makeHarness({ statusState: 'working', tmux: 'alive', pane: SPINNER_PANE, row: endedTranscript() })

      expect(await attempts(h.adapter, 5, 60_000)).toEqual(['transient', 'transient', 'transient', 'transient', 'transient'])
      expect(h.sendKeysCalls).toEqual([])
    })

    test('an attempt that reads the row in another state ends the evidence: the next working reading starts the 60 s over', async () => {
      const opts = { statusState: 'working', tmux: 'alive' as const, pane: IDLE_PANE, row: endedTranscript() }
      const h = makeHarness(opts)

      const verdicts = [await h.adapter('C1')]
      await clock.advance(30_000)
      opts.statusState = 'waiting'
      verdicts.push(await h.adapter('C1')) // reconnected directly
      await clock.advance(30_000) // 60 s since the first idle read
      opts.statusState = 'working'
      verdicts.push(await h.adapter('C1'))
      await clock.advance(60_000)
      verdicts.push(await h.adapter('C1'))

      expect(verdicts).toEqual(['transient', 'success', 'transient', 'success'])
      expect(h.sendKeysCalls).toHaveLength(2)
    })

    // b.jdc: each attempt first probes the persona's own tmux session (alive
    // here); a gone one is swept and escalated instead (the b.jdc block below).
    test.each(['ask_user', 'check_permission'])("REPRO: a %s row whose tmux session lives is never typed into: 'transient' on every attempt with one probe of C1's own tmux session and no pane read, send-keys or sweep, and one blocked-on-prompt notice for the episode", async (state) => {
      const h = makeHarness({ statusState: state })

      expect(await attempts(h.adapter, 3, 60_000)).toEqual(['transient', 'transient', 'transient'])
      expect(h.sendKeysCalls).toEqual([])
      expect(h.readPaneCalls).toEqual([])
      expect(h.tmuxProbes).toEqual(Array(3).fill('slack_bot_C1'))
      expect(h.findMissingCalls).toEqual([])
      expect(raised.map((n) => n.key)).toEqual(['C1'])
      expect(raised[0]!.text).toStartWith(':warning: *Waiting on a prompt*')
      expect(raised[0]!.text).toContain('`tmux attach -t =slack_bot_C1`')
    })

    // b.f2b: at a non-zero delay nothing else escalates a `working` row whose
    // idleness can't be proven, so the adapter's deferrals on it are bounded:
    // 10 min after the first, the unproven-idle notice is raised, once.
    test("REPRO: a working row the adapter can't prove idle (its row names no transcript) is reported once its deferrals have run for 10 min: a failed tmux probe counts as one, a failed status call leaves the run as it is; nothing typed", async () => {
      const opts: Parameters<typeof makeHarness>[0] = { statusState: 'working', tmux: 'alive', pane: IDLE_PANE }
      const h = makeHarness(opts)
      const verdicts = [await h.adapter('C1')] // 0 min: the run starts
      await clock.advance(4 * 60_000)
      opts.tmux = 'probe-error'
      verdicts.push(await h.adapter('C1')) // 4 min
      await clock.advance(4 * 60_000)
      opts.tmux = 'alive'
      opts.statusError = new Error('status failed')
      verdicts.push(await h.adapter('C1')) // 8 min: no state read
      const before = raised.length
      await clock.advance(2 * 60_000)
      opts.statusError = undefined
      verdicts.push(await h.adapter('C1')) // 10 min
      await clock.advance(4 * 60_000)
      verdicts.push(await h.adapter('C1')) // 14 min

      expect(verdicts).toEqual(Array(5).fill('transient'))
      expect(h.sendKeysCalls).toEqual([])
      expect(before).toBe(0)
      expect(raised.map((n) => n.key)).toEqual(['C1'])
      expect(raised[0]!.text).toStartWith(':warning: *Not connected*')
      expect(raised[0]!.text).toContain('its session reads working but CSCB can\'t prove it\'s idle, so it won\'t type into it, and has held back for 10 min')
      expect(raised[0]!.text).toContain('`tmux attach -t =slack_bot_C1`')
      expect(raised[0]!.text).not.toContain('Automatic restarts are disabled')
    })

    test('an attempt that reads the row in another state ends the run of deferrals: the next working reading starts it over', async () => {
      const opts: Parameters<typeof makeHarness>[0] = { statusState: 'working', tmux: 'alive', pane: SPINNER_PANE }
      const h = makeHarness(opts)
      const counts: number[] = []
      for (const [minute, state] of [[0, 'working'], [5, 'working'], [6, 'waiting'], [9, 'working'], [15, 'working'], [19, 'working']] as const) {
        await clock.advance(minute * 60_000 - clock.now())
        opts.statusState = state
        expect(await h.adapter('C1')).toBe('transient') // a running turn, on either row
        counts.push(raised.length)
      }

      expect(counts).toEqual([0, 0, 0, 0, 0, 1])
      expect(h.sendKeysCalls).toEqual([])
    })

    test.each<[string, string, number]>([
      ['a running turn', SPINNER_PANE, 0],
      ['a dialog', PERMISSION_PANE, 1],
    ])("a waiting row whose pane shows %s is not typed into: 'transient' after one read of C1's pane, and a dialog raises one blocked-on-prompt notice", async (_label, pane, noticeCount) => {
      const h = makeHarness({ statusState: 'waiting', pane })

      expect(await attempts(h.adapter, 2, 60_000)).toEqual(['transient', 'transient'])
      expect(h.readPaneCalls).toEqual(Array(2).fill({ claude_instance_id: 'cscb_C1', n_lines: 40 }))
      expect(h.sendKeysCalls).toEqual([])
      expect(raised.map((n) => n.key)).toEqual(Array(noticeCount).fill('C1'))
    })
  })

  // b.jdc (/ci-live run 6): when a persona's session dies while its row reads
  // `ask_user` or `check_permission`, the row keeps that state: agent-director
  // only refreshes a row at SessionEnd and leaves reaping to its findMissing
  // sweep. Deferring on the row alone kept a dead persona "blocked on a
  // prompt" for good: never relaunched, with a *Waiting on a prompt* notice
  // about a session that no longer existed. The adapter now probes the
  // persona's own tmux session first: gone → the dead-tmux sweep and
  // 'escalate-dead', with no notice; alive (or a probe that fails) → the
  // deferral and its notice as before, and once the deferrals on the row have
  // run for 10 min each one first runs the findMissing sweep and reads the row
  // again, escalating when it reads `missing` or `ended`. Nothing is ever typed
  // into the row (b.rmy). Attempts run on a fake clock passed to `_setNow`.
  // Cases marked REPRO fail on the code before the fix.
  describe('b.jdc: a row waiting on a prompt whose session may be gone', () => {
    let clock: FakeClock
    let raised: Array<{ key: string; text: string }>
    let lines: string[]
    let realError: typeof console.error

    beforeEach(() => {
      clock = createFakeClock()
      _setNow(clock.now)
      raised = []
      setSessionNotifier((key, text) => { raised.push({ key, text }) })
      lines = []
      realError = console.error
      console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    })

    afterEach(() => {
      console.error = realError
      setSessionNotifier(undefined)
    })

    /** Attempt a reconnect of C1 at each of `minutes` on the fake clock; the verdicts in order. */
    async function attemptsAt(adapter: (key: string) => Promise<string>, minutes: readonly number[]): Promise<string[]> {
      const verdicts: string[] = []
      for (const minute of minutes) {
        await clock.advance(minute * 60_000 - clock.now())
        verdicts.push(await adapter('C1'))
      }
      return verdicts
    }

    /** The adapter's own lines and the escalate-dead line, in order. */
    function adapterLines(): string[] {
      return lines.filter((l) => l.startsWith('[slack] reconnectSession: ') || l.startsWith('[slack] escalate-dead: persona='))
    }

    test.each(['ask_user', 'check_permission'])("REPRO: a %s row whose tmux session is gone → 'escalate-dead' with one probe of C1's own session and one findMissing sweep; nothing typed or read, and no Waiting on a prompt notice", async (state) => {
      const h = makeHarness({ statusState: state, tmux: 'gone' })

      expect(await h.adapter('C1')).toBe('escalate-dead')

      expect(h.tmuxProbes).toEqual(['slack_bot_C1'])
      expect(h.findMissingCalls).toHaveLength(1)
      expect(h.sendKeysCalls).toEqual([])
      expect(h.readPaneCalls).toEqual([])
      expect(raised).toEqual([])
      expect(adapterLines()).toEqual([
        `[slack] reconnectSession: persona=C1 is ${state} but its tmux session "slack_bot_C1" is gone — no prompt is waiting in it; not deferring, reconciling so the restart relaunches it (b.jdc)`,
        '[slack] escalate-dead: persona=C1 verdict=prompt-row-tmux-gone — tmux session provably dead, triggering internal findMissing reconciliation (the restart relaunches it once its row reads dead; ~/startup/find-missing-loop.sh is belt-and-braces)',
      ])
    })

    test.each([
      ['ask_user', 'missing'],
      ['check_permission', 'ended'],
    ])("REPRO: a %s row whose tmux session lives is deferred with its notice; once the deferrals have run for 10 min the next one runs the findMissing sweep and reads the row again, and %s → 'escalate-dead'; nothing is ever typed", async (state, after) => {
      const h = makeHarness({ statusState: state, tmux: 'alive', statusAfterSweep: after })

      expect(await attemptsAt(h.adapter, [0, 4, 8])).toEqual(['transient', 'transient', 'transient'])
      expect(h.findMissingCalls).toEqual([])
      expect(await attemptsAt(h.adapter, [10])).toEqual(['escalate-dead'])

      expect(h.findMissingCalls).toHaveLength(1)
      expect(h.tmuxProbes).toEqual(Array(4).fill('slack_bot_C1'))
      // Each attempt's status read, then the read after the sweep.
      expect(h.statusCalls).toHaveLength(5)
      expect(h.sendKeysCalls).toEqual([])
      expect(h.readPaneCalls).toEqual([])
      // The prompt was reported once, while its session was alive.
      expect(raised.map((n) => n.key)).toEqual(['C1'])
      expect(raised[0]!.text).toStartWith(':warning: *Waiting on a prompt*')
      expect(adapterLines().at(-1)).toBe(
        `[slack] reconnectSession: persona=C1 has read ${state} for 10 min of deferrals, and after a findMissing sweep its row reads ${after} — its claude process is gone; not deferring, the restart relaunches it (b.jdc)`,
      )
    })

    test('a check_permission row whose tmux session lives and that still reads check_permission after the sweep stays deferred: from 10 min on each deferral sweeps once; one notice for the episode; nothing typed', async () => {
      // No memo: each attempt here is a tick or more apart.
      _setFindMissingMemoTtlMs(0)
      const h = makeHarness({ statusState: 'check_permission', tmux: 'alive' })

      expect(await attemptsAt(h.adapter, [0, 9, 10, 13, 16])).toEqual(Array(5).fill('transient'))

      expect(h.findMissingCalls).toHaveLength(3)
      expect(h.sendKeysCalls).toEqual([])
      expect(h.readPaneCalls).toEqual([])
      expect(raised.map((n) => n.key)).toEqual(['C1'])
    })

    test("a check_permission row whose tmux probe fails is taken as alive (b.rmy): 'transient' with its notice, no sweep, nothing typed", async () => {
      const h = makeHarness({ statusState: 'check_permission', tmux: 'probe-error' })

      expect(await h.adapter('C1')).toBe('transient')

      expect(h.tmuxProbes).toEqual(['slack_bot_C1'])
      expect(h.findMissingCalls).toEqual([])
      expect(h.sendKeysCalls).toEqual([])
      expect(raised.map((n) => n.key)).toEqual(['C1'])
      const [probe, deferral, ...rest] = adapterLines()
      expect(rest).toEqual([])
      expect(probe).toStartWith('[slack] reconnectSession: persona=C1 is check_permission and its tmux session probe failed: Error message="tmux probe failed" at ')
      expect(probe).toEndWith(' — taking the session as alive (b.jdc/b.rmy)')
      expect(deferral).toBe(
        '[slack] reconnectSession: persona=C1 is check_permission — its session waits on a prompt or dialog; not typing /mcp reconnect into it, deferring to a later tick (b.f2b/b.rmy)',
      )
    })

    test("a check_permission row while a launch for the persona is in flight → 'transient' with no tmux probe, sweep, send-keys or notice, even with its tmux session gone: the launch owns the session", async () => {
      // The launch resolves its unset claude_config_dir against a temp home.
      mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
      _setSpawnHomeDir(join(dir, 'home'))
      const config = makeStandInPersonaConfig({ C1: {} }, dir)
      const h = makeHarness({ statusState: 'check_permission', tmux: 'gone' })
      // A launch whose tmux session is not created yet: its spawn is held open.
      const held = holdSpawns(h.stub)
      const launch = spawnForPersona(config.personas[0]!, config, false)
      try {
        await held.entered('cscb_C1')
        expect(isLaunchInFlight('C1')).toBe(true)

        expect(await h.adapter('C1')).toBe('transient')

        expect(h.tmuxProbes).toEqual([])
        expect(h.findMissingCalls).toEqual([])
        expect(h.sendKeysCalls).toEqual([])
        expect(raised).toEqual([])
        expect(adapterLines()).toEqual([
          '[slack] reconnectSession: persona=C1 is check_permission and a launch for it is in flight — deferring to a later tick (b.jdc)',
        ])
      } finally {
        // Settle the held launch before teardown.
        held.releaseAll()
        await launch
      }
    })

    // b.jg5 SRJ-303: the minute-6 attempt reads `pending`, which the adapter
    // answers 'pending' (a deferral restart.ts treats as 'transient').
    test('an attempt that reads another state ends the run of deferrals on the prompt row: the 10 min start over (its pending read answers \'pending\', b.jg5 SRJ-303)', async () => {
      const opts: Parameters<typeof makeHarness>[0] = { statusState: 'check_permission', tmux: 'alive', statusAfterSweep: 'missing' }
      const h = makeHarness(opts)
      const verdicts: string[] = []
      for (const [minute, state] of [[0, 'check_permission'], [6, 'pending'], [9, 'ask_user'], [18, 'ask_user'], [19, 'ask_user']] as const) {
        opts.statusState = state
        verdicts.push(...(await attemptsAt(h.adapter, [minute])))
      }

      expect(verdicts).toEqual(['transient', 'pending', 'transient', 'transient', 'escalate-dead'])
      expect(h.findMissingCalls).toHaveLength(1)
      expect(h.sendKeysCalls).toEqual([])
    })

    test("the persona's not-connected episode ending (its MCP session registered again) ends the run too, and a later episode is reported again", async () => {
      const h = makeHarness({ statusState: 'check_permission', tmux: 'alive', statusAfterSweep: 'missing' })

      expect(await attemptsAt(h.adapter, [0, 5])).toEqual(['transient', 'transient'])
      forgetNotConnectedEpisode('C1')
      expect(await attemptsAt(h.adapter, [6, 15, 16])).toEqual(['transient', 'transient', 'escalate-dead'])

      expect(h.findMissingCalls).toHaveLength(1)
      expect(raised.map((n) => n.key)).toEqual(['C1', 'C1'])
    })
  })

  // b.jg5 SRJ-105: a findMissing sweep on the restart path that is refused
  // (UNAVAILABLE) answers 'transient' instead of 'escalate-dead', so the
  // restart run neither re-probes nor kills nor relaunches the persona. The
  // sweep sites: the dead-session and row-not-interactive escalations after
  // the reconnect's keystrokes, a `working` or prompt row whose tmux session
  // is gone (`sweepDeadTmuxChannelWithCause`), and a live prompt row's
  // deferral from 10 min on (`checkPromptRowDeferral`, which then reads no
  // row and raises no notice). One described refusal line; nothing leaks. An
  // UNCLASSIFIED failure (b.jg5 SRJ-313) is the same refusal. A sweep failing
  // with a class that is no refusal (UNUSABLE NAME) logs one "proceeding"
  // line and keeps the verdict.
  describe('b.jg5 SRJ-105: a refused findMissing sweep on the restart path', () => {
    type SweepSite = {
      /** The harness options that lead the adapter to the sweep. */
      opts: () => Parameters<typeof makeHarness>[0]
      /** The minutes on the fake clock of each attempt; the sweep runs at the last. */
      minutes: readonly number[]
      /** The sweep's log prefix. */
      prefix: string
      /** The tmux probes, send-keys and notices the attempts make. */
      tmuxProbes: number
      sendKeys: number
      raised: string[]
    }

    const SWEEP_SITES: ReadonlyArray<readonly [string, SweepSite]> = [
      ['dead-session (ErrTmuxSendKeys twice)', { opts: () => ({ statusState: 'waiting', sendKeysThrows: errTmuxSendKeys() }), minutes: [0], prefix: 'escalate-dead', tmuxProbes: 0, sendKeys: 2, raised: [] }],
      ['row-not-interactive (ErrSpawnNotInteractive)', { opts: () => ({ statusState: 'waiting', sendKeysThrows: errSpawnNotInteractive('send-keys') }), minutes: [0], prefix: 'escalate-dead', tmuxProbes: 0, sendKeys: 1, raised: [] }],
      ['working-tmux-gone', { opts: () => ({ statusState: 'working', tmux: 'gone' }), minutes: [0], prefix: 'escalate-dead', tmuxProbes: 1, sendKeys: 0, raised: [] }],
      ['prompt-row-tmux-gone', { opts: () => ({ statusState: 'ask_user', tmux: 'gone' }), minutes: [0], prefix: 'escalate-dead', tmuxProbes: 1, sendKeys: 0, raised: [] }],
      ['a live prompt row deferred 10 min', { opts: () => ({ statusState: 'check_permission', tmux: 'alive', statusAfterSweep: 'missing' }), minutes: [0, 10], prefix: 'reconnectSession: prompt row', tmuxProbes: 2, sendKeys: 0, raised: ['C1'] }],
    ]
    const WORKING_TMUX_GONE = SWEEP_SITES.find(([label]) => label === 'working-tmux-gone')![1]

    /** The sweep's refusal line for persona C1 under `prefix`. */
    const sweepRefusedLine = (prefix: string, err: unknown): string =>
      `[slack] ${prefix}: findMissing sweep refused for persona=C1: ${describeAgentDirectorFailure(err)} — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)`

    /** Run `site`'s attempts for C1 with every sweep failing with `err`, capturing notices and console.error. */
    async function sweepFailing(site: SweepSite, err: Error) {
      const clock = createFakeClock()
      _setNow(clock.now)
      const raised: string[] = []
      setSessionNotifier((key) => { raised.push(key) })
      try {
        const h = makeHarness({ ...site.opts(), findMissingError: err })
        const { result: verdicts, errArgs } = await capturingErrorArgs(async () => {
          const out: string[] = []
          for (const minute of site.minutes) {
            await clock.advance(minute * 60_000 - clock.now())
            out.push(await h.adapter('C1'))
          }
          return out
        })
        return { ...h, verdicts, lines: stringLines(errArgs), errArgs, raised }
      } finally {
        setSessionNotifier(undefined)
      }
    }

    /** A refused sweep at `site`: 'transient' at every attempt; one sweep, no row read after it, nothing killed or launched; one refusal line, nothing leaks. */
    async function expectRefused(site: SweepSite, err: Error, redacted: boolean): Promise<void> {
      const r = await sweepFailing(site, err)

      expect(r.verdicts).toEqual(site.minutes.map(() => 'transient'))
      expect(r.findMissingCalls).toHaveLength(1)
      // One status read per attempt: the row is not read again after the sweep.
      expect(r.statusCalls).toHaveLength(site.minutes.length)
      expect(r.tmuxProbes).toHaveLength(site.tmuxProbes)
      expect(r.sendKeysCalls).toHaveLength(site.sendKeys)
      expect([r.killCalls, r.spawnCalls, r.resumeCalls]).toEqual([[], [], []])
      expect(r.raised).toEqual(site.raised)
      expect(r.lines.filter((l) => l.includes('findMissing sweep refused'))).toEqual([sweepRefusedLine(site.prefix, err)])
      expect(r.lines.filter((l) => l.includes('findMissing sweep failed'))).toEqual([])
      if (redacted) expect(r.lines.join('\n')).toContain(REDACTED_SENTINEL_TAIL)
      assertNoLeak({ errArgs: r.errArgs })
    }

    const [TMUX_LABEL, TMUX_BUILD, TMUX_REDACTED] = UNAVAILABLE_FORMS.find(([label]) => label === FORM_LABELS.ErrTmuxUnresponsive)!

    test.each(SWEEP_SITES)(`the sweep at %s refused with ${TMUX_LABEL} → 'transient', never 'escalate-dead'; no row read after it, no kill or launch; one described refusal line`, async (_label, site) => {
      await expectRefused(site, TMUX_BUILD('find-missing'), TMUX_REDACTED)
    })

    test.each(UNAVAILABLE_FORMS)("the sweep of a working row whose tmux session is gone refused with %s → 'transient'; no kill or launch; one described refusal line, nothing leaks", async (_label, build, redacted) => {
      await expectRefused(WORKING_TMUX_GONE, build('find-missing'), redacted)
    })

    // b.jg5 SRJ-313: an UNCLASSIFIED sweep failure (ErrInternal) is the same
    // refusal (find-missing is not a read verb).
    test.each(SWEEP_SITES)("b.jg5 SRJ-313: the sweep at %s refused with an UNCLASSIFIED error (ErrInternal) → 'transient', never 'escalate-dead'; no row read after it, no kill or launch; one described refusal line", async (_label, site) => {
      await expectRefused(site, errInternal(`the store could not be read (${sentinelInMessage('sweep-internal')})`), false)
    })

    test.each(SWEEP_SITES)("contrast: the sweep at %s failing with an UNUSABLE NAME ErrInternal (no refusal) → 'escalate-dead' at the swept attempt, one 'proceeding' line and no refusal line", async (_label, site) => {
      const err = errUnusableName()
      const r = await sweepFailing(site, err)

      expect(r.verdicts).toEqual([...site.minutes.slice(0, -1).map(() => 'transient'), 'escalate-dead'])
      expect(r.findMissingCalls).toHaveLength(1)
      expect([r.killCalls, r.spawnCalls, r.resumeCalls]).toEqual([[], [], []])
      expect(r.lines.filter((l) => l.includes('findMissing sweep refused'))).toEqual([])
      expect(r.lines.filter((l) => l.includes('findMissing sweep failed'))).toEqual([
        `[slack] ${site.prefix}: findMissing sweep failed for persona=C1: ${describeAgentDirectorFailure(err)} — proceeding`,
      ])
    })
  })
})

// ---------------------------------------------------------------------------
// _buildKillSessionAdapter: an UNAVAILABLE kill is a refusal (b.jg5 SRJ-105)
//
// The restart work's kill adapter, run inside a recovery attempt for the
// persona as `runRestartWork` runs it. An UNAVAILABLE kill (by name,
// `ErrTmuxKillFailed` included) answers `KILL_SESSION_REFUSED` with one
// described line, so the restart work launches nothing; so does an
// ENVIRONMENT kill (`ErrTmuxNotAvailable`, b.jg5 SRJ-311), which also raises
// `tmux-unavailable`, and a CONFIG kill (`ErrConfigMalformed`, b.jg5
// SRJ-316), which also raises `ad-config-malformed`, and an UNCLASSIFIED
// kill (b.jg5 SRJ-313: an `ErrInternal`, a store-open name, a name CSCB gives
// no handling, `ErrSystemInstallDisappeared`, which also raises
// `ad-unreachable`), which the wrapper reports to the unclassified sink;
// success and `ErrSpawnNotFound` answer nothing ("go on"), and so does every
// other class, with one error line. The kill follows a `dead`
// reading, so it is declared as not of a row read live: not tmux-touching, it
// never starts (or, on success, ends) the `tmux-unresponsive` condition. The
// outage state's trigger and condition sinks are spies.
// ---------------------------------------------------------------------------

describe('_buildKillSessionAdapter: an UNAVAILABLE kill is a refusal (b.jg5 SRJ-105)', () => {
  let dir: string
  let killCalls: KillParams[]
  let triggers: Array<{ key: string; kind: string }>
  let starts: Array<{ key: string; verb: string }>
  let ends: string[]
  let emissions: Array<{ key: string; text: string }>
  /** Every report to the unclassified sink: its key and whether it was the kill's own error. */
  let reports: Array<{ key: string; same: boolean }>
  /** The error the stub's `kill` answers, for `reports`. */
  let killErr: Error | undefined

  /** The adapter's refusal line for persona C1. */
  const refusedLine = (err: unknown): string =>
    `[slack] killSession (restart adapter): kill refused for persona=C1: ${describeAgentDirectorFailure(err)} — no relaunch follows (b.jg5 SRJ-105)`

  /** Install a stub whose `kill` answers `killError` (default: success), with spy sinks. */
  function install(killError?: Error): StubClient {
    killErr = killError
    const stub = makeStubClient({ killCalls, killError })
    _resetOutageState()
    initOutageState({
      notify: (key, text) => { emissions.push({ key, text }) },
      getClient: () => stub as unknown as Client,
      triggerSink: { arm: (key, cause) => { triggers.push({ key, kind: cause.kind }); return true } },
      conditionSink: {
        start: (key, verb) => { starts.push({ key, verb }) },
        end: (key) => { ends.push(key) },
      },
      unclassifiedSink: { report: (key, error) => { reports.push({ key, same: error === killErr }) } },
    })
    setClientForTests(stub as unknown as Client)
    return stub
  }

  /** Run the adapter for `key` inside a recovery attempt, capturing console.error. */
  function killInAttempt(
    key: string = 'C1',
    getPersona?: (key: string) => Persona | undefined,
  ): Promise<{ result: KillSessionResult; errArgs: unknown[][] }> {
    return capturingErrorArgs(() => runInAttempt(key, 'recovery', () => _buildKillSessionAdapter(getPersona)(key)))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'server-kill-'))
    killCalls = []
    triggers = []
    starts = []
    ends = []
    emissions = []
    reports = []
    killErr = undefined
  })

  afterEach(() => {
    resetClientForTests()
    _resetOutageState()
    _resetInFlightLaunches()
    _resetSpawnHomeDir()
    rmSync(dir, { recursive: true, force: true })
  })

  test.each(UNAVAILABLE_FORMS)('kill refused with %s → KILL_SESSION_REFUSED; one kill, one described refusal line; the timer is armed, no condition starts, nothing posted or leaked', async (_label, build, redacted, causeKind) => {
    const err = build('kill')
    install(err)

    const { result, errArgs } = await killInAttempt()

    expect(result).toBe(KILL_SESSION_REFUSED)
    expect(killCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    const lines = stringLines(errArgs)
    expect(lines).toEqual([refusedLine(err)])
    if (redacted) expect(lines[0]).toContain(REDACTED_SENTINEL_TAIL)
    expect(triggers).toEqual([{ key: 'C1', kind: causeKind }])
    expect(starts).toEqual([])
    expect(ends).toEqual([])
    expect(emissions).toEqual([])
    expect(getOutageFlags('C1').size).toBe(0)
    assertNoLeak({ errArgs, emissions })
  })

  // Non-vacuity for "no condition starts": the same refusal from a kill
  // declared of a row read live, in the same attempt, does start it. The
  // adapter's declaration (not read live) is what keeps it from starting.
  test('control: ErrTmuxUnresponsive from a kill declared of a row read live starts the condition; the adapter\'s kill of the same error does not', async () => {
    const err = errTmuxUnresponsive('kill')
    install(err)

    await runInAttempt('C1', 'recovery', () =>
      expect(withOutageDetection('C1', undefined, AD_CALL_KILL_ROW_READ_LIVE, () => Promise.reject(err))).rejects.toBe(err),
    )
    expect(starts).toEqual([{ key: 'C1', verb: 'kill' }])

    const { result } = await killInAttempt()
    expect(result).toBe(KILL_SESSION_REFUSED)
    expect(starts).toHaveLength(1)
  })

  test('kill succeeds → answers nothing (go on); no line, nothing armed; no condition started or ended (not tmux-touching)', async () => {
    install()

    const { result, errArgs } = await killInAttempt()

    expect(result).toBeUndefined()
    expect(killCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    expect(errArgs).toEqual([])
    expect(triggers).toEqual([])
    expect(starts).toEqual([])
    expect(ends).toEqual([])
  })

  test('kill answers ErrSpawnNotFound → answers nothing (go on); no line, nothing armed, no condition', async () => {
    install(errSpawnNotFound())

    const { result, errArgs } = await killInAttempt()

    expect(result).toBeUndefined()
    expect(killCalls).toHaveLength(1)
    expect(errArgs).toEqual([])
    expect(triggers).toEqual([])
    expect(starts).toEqual([])
  })

  // b.jg5 SRJ-311: an ENVIRONMENT kill is a refusal, never swallowed into a
  // launch. The wrapper raises `tmux-unavailable` (its one onset) and arms the
  // timer once with the ENVIRONMENT cause; ENVIRONMENT never starts the
  // `tmux-unresponsive` condition (SRJ-307).
  // b.jg5 SRJ-1021: the re-bound-socket form (the description carries "not the
  // tmux server the agent was launched on") is the same refusal, with
  // SRJ-1021's onset in place of today's.
  test.each([
    ['ErrTmuxNotAvailable', () => errTmuxNotAvailable(undefined, 'kill'), () => ONSET_TEMPLATES['tmux-unavailable']()],
    ['ErrTmuxNotAvailable, re-bound-socket form (b.jg5 SRJ-1021)', () => errTmuxNotAvailableDifferentServer(undefined, 'kill'), tmuxServerChangedOnset],
  ] as const)('b.jg5 SRJ-311: kill answers %s (ENVIRONMENT) → KILL_SESSION_REFUSED, not swallowed into a launch; one described refusal line; tmux-unavailable raised with its onset; the timer armed once with the environment cause; no condition', async (_label, build, onset) => {
    const err = build()
    install(err)

    const { result, errArgs } = await killInAttempt()

    expect(result).toBe(KILL_SESSION_REFUSED)
    expect(killCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    expect(stringLines(errArgs)).toEqual([refusedLine(err)])
    expect([...getOutageFlags('C1')]).toEqual(['tmux-unavailable'])
    expect(emissions).toEqual([{ key: 'C1', text: onset() }])
    expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT }])
    expect(starts).toEqual([])
    expect(ends).toEqual([])
    assertNoLeak({ errArgs, emissions })
  })

  // b.jg5 SRJ-316, SRJ-110, SRJ-105: a CONFIG kill is a refusal, so the
  // restart work launches nothing after it, and the kill is not repeated. The
  // wrapper raises `ad-config-malformed` (its onset, quoting the redacted
  // description) and arms the timer once with the CONFIG cause; CONFIG never
  // starts the `tmux-unresponsive` condition (SRJ-307).
  test('b.jg5 SRJ-316: kill answers a CONFIG answer (ErrConfigMalformed) → KILL_SESSION_REFUSED with no second kill; one described refusal line; ad-config-malformed raised with its onset; the timer armed once with the config cause; no condition; nothing leaks', async () => {
    const err = errConfigMalformed('starting_session_seconds', sentinelInMessage('kill-config'))
    install(err)

    const { result, errArgs } = await killInAttempt()

    expect(result).toBe(KILL_SESSION_REFUSED)
    expect(killCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    const lines = stringLines(errArgs)
    expect(lines.filter((l) => l.includes('kill refused'))).toEqual([refusedLine(err)])
    expect(lines.filter((l) => l.includes('ad-config-malformed raised for persona=C1'))).toHaveLength(1)
    expect(lines).toHaveLength(2)
    expect([...getOutageFlags('C1')]).toEqual(['ad-config-malformed'])
    expect(emissions).toEqual([{ key: 'C1', text: adConfigMalformedOnset(err) }])
    expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_CONFIG }])
    expect(starts).toEqual([])
    expect(ends).toEqual([])
    assertNoLeak({ errArgs, emissions })
  })

  // b.jg5 SRJ-105, SRJ-110, SRJ-313: an UNCLASSIFIED kill is a refusal too:
  // the adapter reports the stop to the restart work (`KILL_SESSION_REFUSED`)
  // and makes no second call, so no step follows. The wrapper arms the timer
  // once with the UNCLASSIFIED cause and, inside the attempt, reports the
  // error once to the unclassified sink; it starts no condition.
  // `ErrSystemInstallDisappeared` also raises `ad-unreachable` with its onset;
  // nothing else posts.
  test.each([
    ['ErrInternal', () => errInternal(`the store could not be read (${sentinelInMessage('kill-internal')})`), undefined],
    ['a store agent-director cannot open (ErrSchemaMismatch)', () => errSchemaMismatch(`the store could not be opened (${sentinelInMessage('kill-schema')})`), undefined],
    ['a name CSCB gives no handling', () => errGeneric('kill', 'ErrKillBroken', `the kill broke (${sentinelInMessage('kill-generic')})`), undefined],
    ['ErrSystemInstallDisappeared', () => errSystemInstallDisappeared('kill'), 'ad-unreachable'],
  ] as const)('b.jg5 SRJ-313: kill answers %s (UNCLASSIFIED) → KILL_SESSION_REFUSED with no second kill; one described refusal line; the timer armed once with the unclassified cause; reported once to the unclassified sink; no condition; nothing leaks', async (_label, build, flag) => {
    const err = build()
    install(err)

    const { result, errArgs } = await killInAttempt()

    expect(result).toBe(KILL_SESSION_REFUSED)
    expect(killCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('C1')])
    expect(stringLines(errArgs).filter((l) => l.includes('killSession (restart adapter)'))).toEqual([refusedLine(err)])
    expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED }])
    expect(reports).toEqual([{ key: 'C1', same: true }])
    expect(starts).toEqual([])
    expect(ends).toEqual([])
    expect([...getOutageFlags('C1')]).toEqual(flag === undefined ? [] : [flag])
    expect(emissions.map((e) => e.key)).toEqual(flag === undefined ? [] : ['C1'])
    assertNoLeak({ errArgs, emissions })
  })

  // Every other class is no refusal: one "error for persona" line and the
  // launch follows (nothing answered); a kill is no read, so nothing is armed
  // or reported either.
  test.each([
    ['an UNUSABLE NAME ErrInternal', () => errUnusableName()],
    ['a STATE name (ErrSpawnNotResumable)', () => errSpawnNotResumable()],
    ['a GONE name (ErrTmuxCaptureFailed)', () => errTmuxCaptureFailed(undefined, 'kill')],
  ])("kill answers %s → answers nothing (go on) with one error line; nothing armed or reported, no condition", async (_label, build) => {
    const err = build()
    install(err)

    const { result, errArgs } = await killInAttempt()

    expect(result).toBeUndefined()
    expect(killCalls).toHaveLength(1)
    expect(stringLines(errArgs)).toEqual([
      `[slack] killSession (restart adapter): error for persona=C1: ${describeThrownValue(err)}`,
    ])
    expect(triggers).toEqual([])
    expect(reports).toEqual([])
    expect(starts).toEqual([])
    assertNoLeak({ errArgs })
  })

  // The guards run first and are unchanged: with a kill that would be
  // refused, a launch in flight or an unresolvable claude_config_dir still
  // skips the kill and answers nothing.
  test('launch in flight: no kill (the skip line only) and nothing answered, even with a kill that would be refused', async () => {
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
    _setSpawnHomeDir(join(dir, 'home'))
    const config = makeStandInPersonaConfig({ C1: {} }, dir)
    const stub = install(errTmuxUnresponsive('kill'))
    const held = holdSpawns(stub)
    const launch = spawnForPersona(config.personas[0]!, config, false)
    try {
      await held.entered(personaInstanceId('C1'))
      expect(isLaunchInFlight('C1')).toBe(true)

      const { result, errArgs } = await killInAttempt()

      expect(result).toBeUndefined()
      expect(killCalls).toEqual([])
      expect(stringLines(errArgs)).toEqual([
        '[slack] killSession (restart adapter): launch already in flight for persona=C1 — not killing',
      ])
    } finally {
      held.releaseAll()
      await launch
    }
  })

  test('claude_config_dir cannot be resolved: no kill and nothing answered, even with a kill that would be refused', async () => {
    const dangling = join(dir, 'dangling-config')
    symlinkSync(join(dir, 'nowhere'), dangling)
    const persona = makeStandInPersonaConfig({ C1: { claude_config_dir: dangling } }, dir).personas[0]!
    install(errTmuxUnresponsive('kill'))

    const { result, errArgs } = await killInAttempt('C1', (k) => (k === 'C1' ? persona : undefined))

    expect(result).toBeUndefined()
    expect(killCalls).toEqual([])
    const lines = stringLines(errArgs)
    expect(lines).toContain(
      '[slack] killSession (restart adapter): persona=C1 claude_config_dir cannot be resolved to a real path — not killing; its row is kept',
    )
    expect(lines.filter((l) => l.includes('kill refused'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// _runCallTimeoutStartStep: the persona client's call timeout and the startup
// warning (b.jg5 SRJ-213)
// ---------------------------------------------------------------------------

describe('_runCallTimeoutStartStep (b.jg5 SRJ-213)', () => {
  /** The values in effect at every default, injected. */
  const atDefaults = (): AdSettingsInEffect => DEFAULT_AD_SETTINGS_IN_EFFECT

  let gate: CloseCountingStubClient
  let persona: CloseCountingStubClient
  let built: ClientOptions[]
  let logs: string[]
  let startupErrors: string[]
  let exits: number[]
  let home: string | undefined

  beforeEach(() => {
    gate = makeCloseCountingStubClient()
    persona = makeCloseCountingStubClient()
    built = []
    logs = []
    startupErrors = []
    exits = []
    // The startup gate's client, installed before the step runs.
    setClientForTests(gate.client as unknown as Client)
  })

  afterEach(() => {
    resetClientForTests()
    resetAdSettingsForTests()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  /**
   * Run the step with the production persona-client builder over a stub
   * `createClient` (recording the options it is given) and recording
   * startup-error and exit seams. `valuesInEffect` undefined keeps the
   * production default (the installed reader's values).
   */
  function runStep(config: PersonaConfig, valuesInEffect: (() => AdSettingsInEffect) | undefined): Promise<void> {
    const personaDeps: Partial<PersonaClientDeps> = {
      createClient: makeStubCreateClient({ client: persona.client, calls: built }),
      recordStartupError: (classLabel: string) => { startupErrors.push(classLabel) },
      exit: ((code: number) => { exits.push(code) }) as PersonaClientDeps['exit'],
    }
    return _runCallTimeoutStartStep(config, {
      buildPersonaClient: (callTimeoutMs) => buildPersonaClientOrExit(callTimeoutMs, personaDeps),
      log: (line) => { logs.push(line) },
      ...(valuesInEffect !== undefined ? { valuesInEffect } : {}),
    })
  }

  /** The persona client was built once with `callTimeoutMs`, installed in place of the gate's client, which was closed once, and the start went on. */
  function expectPersonaClientInstalled(callTimeoutMs: number): void {
    expect(built.map((opts) => opts.callTimeoutMs)).toEqual([callTimeoutMs])
    expect(getClient()).toBe(persona.client as unknown as Client)
    expect(gate.closes()).toBe(1)
    expect(persona.closes()).toBe(0)
    expect(startupErrors).toEqual([])
    expect(exits).toEqual([])
  }

  test.each([
    ['a configured agent_director_call_timeout_ms', { agent_director_call_timeout_ms: MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS }, MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS],
    ['the default configuration (and no warning at the default settings)', {}, DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS],
  ] as const)('with %s, the persona client carries that callTimeoutMs and replaces the gate client', async (_label, overrides, expected) => {
    await expect(runStep(makePersonaConfig(overrides), atDefaults)).resolves.toBeUndefined()

    expectPersonaClientInstalled(expected)
    expect(logs).toEqual([])
  })

  test('a setting below the need at the defaults writes exactly one warning line, and the step still builds the client with that setting and resolves with no exit and no startup error', async () => {
    const belowNeed = Number(adCallTimeoutNeed(DEFAULT_AD_SETTINGS_IN_EFFECT).needMs - 1n)
    const expectedLine = buildAdCallTimeoutWarningLine(belowNeed, DEFAULT_AD_SETTINGS_IN_EFFECT)
    expect(expectedLine).toBeDefined()

    await expect(
      runStep(makePersonaConfig({ agent_director_call_timeout_ms: belowNeed }), atDefaults),
    ).resolves.toBeUndefined()

    expect(logs).toEqual([expectedLine!])
    expectPersonaClientInstalled(belowNeed)
  })

  test("by default the check reads the values the startup read left in effect: [pause] timeout_seconds 60 puts the default setting at or below its need, so the step warns once", async () => {
    home = mkdtempSync(join(tmpdir(), 'cscb-call-timeout-step-'))
    writeAgentDirectorConfig(home, { pauseTimeout: 60n })
    const readerLogs: string[] = []
    installAdSettings({ home: () => home!, log: (line) => { readerLogs.push(line) } })
    const expectedLine = buildAdCallTimeoutWarningLine(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, adSettingsInEffect())
    expect(expectedLine).toBeDefined()

    await expect(runStep(makePersonaConfig(), undefined)).resolves.toBeUndefined()

    expect(logs).toEqual([expectedLine!])
    expectPersonaClientInstalled(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS)
  })
})
