import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cannedReadPaneResult } from './test-helpers/ad-results.ts'
import { createDeliveryLifecycle } from '../src/delivery-lifecycle.ts'
import { _setDeliveryLifecycle } from '../src/server.ts'
import { recoverDeliveryGone, setDeliveryPersonaLookup } from '../src/session-manager.ts'

import type { Client, ClientOptions, FindMissingParams, FindMissingResult, GetParams, KillParams, ReadPaneParams, ReadPaneResult, ResumeParams, SendKeysParams, SendKeysResult, SpawnParams, StatusParams, StatusResult } from 'agent-director'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  AD_CALL_KILL_ROW_READ_LIVE,
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_DIRECTORY,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_LAUNCH_FAILURE,
  AD_ERROR_CLASS_STATE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  CSCB_UNKNOWN_ERROR_NAME,
  describeAdFailureForLog,
  describeAgentDirectorFailure,
  killFailedDescriptionOf,
  type AdErrorClass
} from '../src/ad-error-class.ts'
import {
  DEFAULT_AD_SETTINGS_IN_EFFECT,
  adCallTimeoutNeed,
  adSettingsInEffect,
  buildAdCallTimeoutWarningLine,
  installAdSettings,
  resetAdSettingsForTests,
  type AdSettingsInEffect,
} from '../src/ad-settings.ts'
import {
  RECHECK_OUTCOME_PASS,
  RECHECK_OUTCOME_STOP,
  installAdVersionRecheck,
  resetAdVersionRecheckForTests,
} from '../src/ad-version-gate.ts'
import {
  getClient,
  resetClientForTests,
  setClientForTests,
} from '../src/agent-director-client.ts'
import { ErrCwdNotFound } from '../src/agent-director-errors.ts'
import { buildPersonaClientOrExit, type PersonaClientDeps } from '../src/agent-director-startup.ts'
import { getFailureCount } from '../src/backoff.ts'
import {
  KILL_OUTCOME_KILLED,
  KILL_OUTCOME_NOT_KILLED,
  KILL_OUTCOME_ROW_GONE,
  KILL_OUTCOME_SESSION_GONE,
  describeKillOutcome,
  killLetsNextStepRun,
  killOutcomeStopsServer,
  type KillFailure,
  type KillOutcome,
} from '../src/checked-kill.ts'
import {
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MCP_SERVER_NAME,
  type Persona,
  type PersonaConfig,
} from '../src/config.ts'
import {
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  LATCH_ROW_STATE_NO_ROW,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
  REFUSED_OPERATION_NONE,
  REFUSED_OPERATION_PLAIN_SPAWN,
  bindConflictNotice,
  createConflictLatch,
  latchNoticeEpisodeKindOf,
  latchRowStateRead,
  launchStartNotRecordedNoticeText,
  type ConflictLatch,
  type ConflictLatchRecord,
  type LatchRowState,
} from '../src/conflict-latch.ts'
import { KILL_FAILURE_CONTEXT_RECOVERY } from '../src/kill-failure-alert.ts'
import {
  KILL_RETRY_ALERT_NONE,
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_END_SETTLED,
  KILL_RETRY_NEXT_NOT_LIVE,
  KILL_RETRY_NEXT_NOT_RETRIED,
  KILL_RETRY_NEXT_SUCCESS,
  killRetryEndLine,
  killRetryTryLine,
} from '../src/kill-retry.ts'
import {
  assertSendable,
  chunkText,
  sanitizeFilename,
} from '../src/lib.ts'
import {
  LIVE_ROW_LAUNCH_REASON_RETIRED_KEY,
  LIVE_ROW_LAUNCH_REUSE,
  LIVE_ROW_OUTCOME_LAUNCHED,
  LIVE_ROW_SEQUENCE_ENTRY_KILL,
  LIVE_ROW_START_STARTED,
  type LiveRowSequenceRequest
} from '../src/live-row-sequence.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_ENDED,
  LIVENESS_DEAD_ROW_MISSING,
  LIVENESS_DEAD_ROW_NO_ROW,
  LIVENESS_PENDING,
  LIVENESS_READING_DEAD,
  LIVENESS_READING_DEAD_ENDED,
  LIVENESS_READING_DEAD_INSTALL_GONE,
  LIVENESS_DEAD_SOURCE_INSTALL_GONE,
  LIVENESS_READING_DEAD_MISSING,
  LIVENESS_READING_DEAD_NO_ROW,
  LIVENESS_READING_LIVE,
  LIVENESS_READING_PENDING,
  LIVENESS_READING_UNKNOWN,
  deadLivenessReading,
  deadRowReadOf,
  isInstallGoneDeadReading,
  launchStartOfReading,
  livenessKindOf,
  livenessReadingForStatus,
  pendingLaunchStartOf,
  pendingLivenessReading,
  type DeadLivenessReading,
  type DeadRowRead,
  type LivenessReading,
} from '../src/liveness-reading.ts'
import {
  ALL_CLEAR_TEMPLATE,
  ONSET_TEMPLATES,
  _resetOutageState,
  adConfigMalformedOnset,
  getOutageFlags,
  initOutageState,
  raiseAdConfigMalformed,
  setOutageFlag,
  tmuxServerChangedOnset,
  withOutageDetection,
  type OutageClass,
} from '../src/outage-state.ts'
import { PROBE_PANE_READ_LINES } from '../src/pane-read.ts'
import {
  PENDING_ROW_RULE_LOG_HEAD,
  PENDING_ROW_RULE_ORIGIN_RETRY,
  STUCK_LAUNCH_POSTED,
  postStuckLaunchHeld,
  stuckLaunchEndRowLiveReason,
  stuckLaunchEpisodeEndedLine
} from '../src/pending-row.ts'
import { describeThrownValue, renderLogMessageText } from '../src/persona-connection-errors.ts'
import {
  KILL_FAILURE_END_ROW_FINISHED,
  KILL_FAILURE_END_ROW_GONE,
  PERSONA_EPISODE_KIND_STUCK_LAUNCH,
  createKillFailureAlerts,
  createPersonaEpisodes,
  type KillFailureAlerts,
  type PersonaEpisodes,
} from '../src/persona-episodes.ts'
import { personaInstanceId, personaTmuxSessionName, renderPersonaRef } from '../src/persona-identity.ts'
import { KILL_SESSION_NOT_KILLED_GUARD, type KillSessionResult, type ReconnectEscalateDead } from '../src/restart.ts'
import {
  OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1,
  OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL,
  OLD_LIFE_HOLD_END_READ_ENDED,
  OLD_LIFE_HOLD_END_READ_MISSING,
  OLD_LIFE_HOLD_LOG_PREFIX,
  RETIRED_KEY_CAUSE_REMOVED,
  createOldLifeHoldSet,
  loadRetiredKeyStore,
  oldLifeHoldEndedLine,
  retiredKeysPath,
  type OldLifeHold,
  type OldLifeHoldEndReason,
  type OldLifeHoldSet,
  type RetiredKeyStore,
} from '../src/retired-keys.ts'
import { RETIRED_ENTRY_CLEARING_STATES } from '../src/row-read-rules.ts'
import { LAUNCH_START_LOG_RE, LIVENESS_STATUS_SITE, RECONNECT_STATUS_SITE, _buildIsSessionAliveAdapter, _buildKillSessionAdapter, _buildReconnectSessionAdapter, _runCallTimeoutStartStep, deferPendingRow, deferralNotPendingLine, deferringPendingRowGoneLine, deferringPendingRowLine, reconnectHeldOwnRowLine, reconnectLatchedGateLine, reconnectRetiredOldLifeLine, reconnectStatusCheckFailedLine, type DeferPendingRowAnswer, type DeferPendingRowOptions } from '../src/server.ts'
import { DEAD_SESSION_CAUSE_ROW_READ_FINISHED, ESCALATE_DEAD_EVIDENCE, ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ, PERSONA_KILL_STOP_CAUSE_RECHECK, PROMPT_ROW_SWEEP_AFTER_MS, SPAWN_ACTION_FRESH_RETIRED, _resetConfiguredPersonaQuery, _resetFindMissingMemo, _resetInFlightLaunches, _resetNotConnectedEpisodes, _resetNow, _resetOldLifeHolds, _resetRetiredKeyStore, _resetSpawnHomeDir, _setFindMissingMemoTtlMs, _setNow, _setSpawnHomeDir, carriedDeadEvidenceOf, escalateDeadSweepLine, forgetNotConnectedEpisode, isLaunchInFlight, pendingRowRuleAlreadyRanLine, pendingRowRuleNotInstalledLine, personaKillStoppedNoAlertsLine, promptRowSweepFinishedLine, reconnectTransientLine, setConfiguredPersonaQuery, setConflictLatch, setKillFailureAlerts, setOldLifeHolds, setRetiredKeyStore, setSessionNotifier, setStuckLaunchEpisodes, spawnForPersona, type DeadEvidenceSource, type EscalateDeadVerdict } from '../src/session-manager.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import {
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_CAUSE_KILL_FAILED,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED,
  isInsideAttempt,
  runInAttempt,
  runInTimerRetry
} from '../src/unavailable-retry.ts'
import { writeAgentDirectorConfig } from './test-helpers/ad-settings.ts'
import type { StubKillResult } from './test-helpers/agent-director-stub.ts'
import {
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_START_NONE,
  SAMPLE_LAUNCH_START_WHOLE,
  cannedErr,
  cannedFindMissing,
  cannedGetResult,
  cannedKillResult,
  cannedStatusResult,
  errCallTimeout,
  errConfigMalformed,
  errGeneric,
  errInstanceIdCollision,
  errInternal,
  errInvalidFlags,
  errSchemaMismatch,
  errSendKeysWhileRelayed,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errSpawnNotResumable,
  errSystemInstallDisappeared,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxNotAvailableDifferentServer,
  errTmuxSendKeys,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  errUnknownErrorName,
  errUnusableName,
  holdFindMissing,
  holdSpawns,
  makeCloseCountingStubClient,
  makeStubCallLog,
  makeStubClient,
  makeStubCreateClient,
  makeStubResolveSystemBinary,
  nonLatchingNotes,
  provenanceNote,
  stubCallCount,
  unavailableForms,
  type CannedResponse,
  type CloseCountingStubClient,
  type StubCallLog,
  type StubClient,
  type StubResolveSystemBinaryOutcome
} from './test-helpers/agent-director-stub.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import {
  NO_LAUNCH_START_FORMS,
  NO_LAUNCH_START_FORM_NAMES,
  RESTART_KILL_CONFLICT_CASE_ROWS,
  RESTART_KILL_UNUSABLE_NAME_CASE_ROWS,
  UNUSABLE_NAME_CASE_ROWS,
  conflictForPersona,
  conflictNoticeForPersona,
  expectedLatchRecord,
  launchStartRecord,
  tmuxTouchingCallsIn
} from './test-helpers/conflict-cases.ts'
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
import { useImmediateTypingLifecycle } from './test-helpers/legacy-typing.ts'
import { PENDING_ROW_MODEL_NO_ROW, judgeMissingFromG, makePendingRowModel, type PendingRowModelOptions } from './test-helpers/pending-row-model.ts'
import { makePersonaConfig, makeStandInPersonaConfig } from './test-helpers/persona-config.ts'
import {
  expectPendingOnlyWatch,
  killFailureEndedLine,
  makeRecoveryHarness,
  ownRowsLiveThenMissing,
  pastSampleGrace,
  personaOf,
  personaRow,
  recordSequenceStarts,
  retiredEntryClearedLine,
  retiredKeyLinesIn,
  type RecoveryHarness
} from './test-helpers/recovery-harness.ts'
import { readRetiredKeysRecord, retiredKeysRecordOf, writeRetiredKeysRecord, type RetiredKeySeed } from './test-helpers/retired-keys.ts'
import {
  IDLE_PANE
} from './test-helpers/working-row-panes.ts'
useImmediateTypingLifecycle()

// ---------------------------------------------------------------------------
// assertSendable()
// ---------------------------------------------------------------------------

describe('assertSendable', () => {
  const stateDir = '/home/user/.config/claude-slack-channel-bots'
  const inboxDir = '/home/user/.config/claude-slack-channel-bots/inbox'

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
// ErrSpawnNotFound)
// ---------------------------------------------------------------------------

/** The live states other than `pending`: each reads `live`. */
const LIVE_NOT_PENDING_STATES = [...AGENT_DIRECTOR_LIVE_STATES].filter((s) => s !== AGENT_DIRECTOR_PENDING_STATE)
/** A state string CSCB does not know (from a later binary). */
const UNRECOGNISED_STATE = 'a-state-from-a-later-binary'
/**
 * The `dead` reading each dead state gives: it carries the state it read
 * (b.jg5 SRJ-501: the state the path last read). A dead state missing here
 * gives `undefined`, so its case fails.
 */
const DEAD_STATE_READING: Readonly<Record<string, DeadLivenessReading>> = {
  [LIVENESS_DEAD_ROW_ENDED]: LIVENESS_READING_DEAD_ENDED,
  [LIVENESS_DEAD_ROW_MISSING]: LIVENESS_READING_DEAD_MISSING,
}
/** Every state other than `pending`, with the reading it gives (b.jg5 SRJ-314, SRJ-501). */
const NOT_PENDING_STATE_READINGS = [
  ...LIVE_NOT_PENDING_STATES.map((s) => [s, LIVENESS_READING_LIVE] as const),
  ...[...AGENT_DIRECTOR_DEAD_STATES].map((s) => [s, DEAD_STATE_READING[s]!] as const),
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
  function statusWith(state: string, value: unknown): StatusResult {
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
    }) as StatusResult

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
    const throwing = Object.defineProperty({}, 'state', { get() { throw new Error('boom') } }) as StatusResult
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

// ---------------------------------------------------------------------------
// The `dead` reading's source (b.jg5 SRJ-314, SRJ-610, SRJ-1016): the `dead`
// reading from `ErrSystemInstallDisappeared` reads no row, so it is told apart
// from a row read's `dead`; only a row read of `ended` or `missing` ends a
// slow-recovery episode.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The `dead` reading's row read (b.jg5 SRJ-501): a row read's `dead` reading
// carries what it read (`ended`, `missing`, or no row for `ErrSpawnNotFound`),
// so the restart path's kill can record the state its path last read.
// ---------------------------------------------------------------------------

describe("liveness-reading: the dead reading's row read (b.jg5 SRJ-501)", () => {
  /** Each row read with its frozen reading. */
  const ROW_READS: ReadonlyArray<readonly [DeadRowRead, DeadLivenessReading]> = [
    [LIVENESS_DEAD_ROW_ENDED, LIVENESS_READING_DEAD_ENDED],
    [LIVENESS_DEAD_ROW_MISSING, LIVENESS_READING_DEAD_MISSING],
    [LIVENESS_DEAD_ROW_NO_ROW, LIVENESS_READING_DEAD_NO_ROW],
  ]

  test.each(ROW_READS)('row read %s: deadLivenessReading gives its frozen dead reading, and deadRowReadOf reads it back', (rowRead, reading) => {
    expect(deadLivenessReading(rowRead)).toBe(reading)
    expect(Object.isFrozen(reading)).toBe(true)
    expect(livenessKindOf(reading)).toBe(livenessKindOf(LIVENESS_READING_DEAD))
    expect(deadRowReadOf(reading)).toBe(rowRead)
    expect(isInstallGoneDeadReading(reading)).toBe(false)
  })

  test('no row read: deadLivenessReading gives the plain dead reading, which carries no row read', () => {
    expect(deadLivenessReading()).toBe(LIVENESS_READING_DEAD)
    expect(deadRowReadOf(LIVENESS_READING_DEAD)).toBeUndefined()
  })

  test.each<[string, unknown]>([
    ['the legacy install-gone alias (unknown)', LIVENESS_READING_DEAD_INSTALL_GONE],
    ['a live reading carrying a row read', { ...LIVENESS_READING_LIVE, rowRead: LIVENESS_DEAD_ROW_ENDED }],
    ['an unknown reading carrying a row read', { ...LIVENESS_READING_UNKNOWN, rowRead: LIVENESS_DEAD_ROW_MISSING }],
    ['a dead reading carrying a row read CSCB does not know', { ...LIVENESS_READING_DEAD, rowRead: 'a-later-state' }],
    ['a dead reading whose rowRead getter throws', Object.defineProperty({ kind: LIVENESS_READING_DEAD.kind }, 'rowRead', { get(): never { throw new Error('boom') } })],
    ['null', null],
    ['the row read as a bare string', LIVENESS_DEAD_ROW_ENDED],
  ])('deadRowReadOf(%s) → none, and nothing throws', (_label, value) => {
    expect(() => deadRowReadOf(value)).not.toThrow()
    expect(deadRowReadOf(value)).toBeUndefined()
  })
})

describe("liveness-reading: the dead reading's install-gone source", () => {
  test('b.jpf: the legacy install-gone export aliases frozen unknown', () => {
    expect(Object.isFrozen(LIVENESS_READING_DEAD_INSTALL_GONE)).toBe(true)
    expect(LIVENESS_READING_DEAD_INSTALL_GONE).toBe(LIVENESS_READING_UNKNOWN)
    expect(LIVENESS_READING_DEAD_INSTALL_GONE).not.toEqual(LIVENESS_READING_DEAD)
    expect(isInstallGoneDeadReading(LIVENESS_READING_DEAD_INSTALL_GONE)).toBe(false)
  })

  test.each([
    ['legacy dead shape', { kind: LIVENESS_READING_DEAD.kind, source: LIVENESS_DEAD_SOURCE_INSTALL_GONE }],
    ['legacy shape carrying a stale terminal row', { ...LIVENESS_READING_DEAD_ENDED, source: LIVENESS_DEAD_SOURCE_INSTALL_GONE }],
    ['dead shape whose source getter throws', Object.defineProperty({ kind: LIVENESS_READING_DEAD.kind }, 'source', { get() { throw new Error('unreadable source') } })],
  ])('b.jpf: %s normalizes to unknown and supplies no dead-row evidence', (_label, reading) => {
    expect(livenessKindOf(reading)).toBe(livenessKindOf(LIVENESS_READING_UNKNOWN))
    expect(deadRowReadOf(reading)).toBeUndefined()
  })

  test('isInstallGoneDeadReading → false for every other reading, a row read\'s dead included, for a non-dead reading carrying the source, and for a value that is not a reading; never throws', () => {
    for (const other of [LIVENESS_READING_LIVE, LIVENESS_READING_PENDING, LIVENESS_READING_DEAD, LIVENESS_READING_UNKNOWN]) {
      expect(isInstallGoneDeadReading(other)).toBe(false)
    }
    for (const other of [LIVENESS_READING_LIVE, LIVENESS_READING_PENDING, LIVENESS_READING_UNKNOWN]) {
      expect(isInstallGoneDeadReading({ ...other, source: LIVENESS_DEAD_SOURCE_INSTALL_GONE })).toBe(false)
    }
    expect(isInstallGoneDeadReading({ ...LIVENESS_READING_DEAD, source: 'another-source' })).toBe(false)
    const throwingSource = Object.defineProperty({ kind: LIVENESS_READING_DEAD.kind }, 'source', {
      get(): never {
        throw new Error('boom')
      },
    })
    expect(isInstallGoneDeadReading(throwingSource)).toBe(false)
    for (const notAReading of [null, undefined, LIVENESS_READING_DEAD.kind, LIVENESS_DEAD_SOURCE_INSTALL_GONE]) {
      expect(isInstallGoneDeadReading(notAReading)).toBe(false)
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
    expect(statusCalls[0].instance_id).toBe(personaInstanceId('C1'))
    expect(statusCalls[0].instance_id).toBe('cscb_C1')
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
    expect(isInstallGoneDeadReading(result)).toBe(false)
    expect(statusCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
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

  // b.jg5 SRJ-513: under a configured persona's key such a row latches the
  // persona instead (the SRJ-513 describe below); here the configured-persona
  // query counts no key, so the row latches nothing (SRJ-408).
  test('SRJ-115, SRJ-408: a pending result showing no launch start under a key no configured persona uses → the plain pending reading, carrying none', async () => {
    setConfiguredPersonaQuery(() => false)
    try {
      const { adapter } = makeHarness(undefined, AGENT_DIRECTOR_PENDING_STATE, standIns('C1'), SAMPLE_LAUNCH_START_NONE)

      const result = await adapter('C1')

      expect(result).toEqual(LIVENESS_READING_PENDING)
      expect(result).not.toHaveProperty('launchStartedAt')
    } finally {
      _resetConfiguredPersonaQuery()
    }
  })

  test('SRJ-115: a live (not pending) result carrying a launch start → reads live, carrying none', async () => {
    const { adapter } = makeHarness(undefined, LIVE_STATE, standIns('C1'), SAMPLE_LAUNCH_START_FRACTIONAL)

    const result = await adapter('C1')

    expect(result).toEqual(LIVENESS_READING_LIVE)
    expect(result).not.toHaveProperty('launchStartedAt')
  })

  // b.jg5 SRJ-312: agent-director answered but tmux did not, so an
  // ErrSpawnNotFound clears `ad-unreachable` only.
  test('2. ErrSpawnNotFound (b.jg5 SRJ-312, SRJ-501): status throws with both flags raised → clears ad-unreachable only; tmux-unavailable stays raised, no all-clear; reads dead, carrying no row as what it read', async () => {
    const { emissions, statusCalls, triggers, cleared, adapter } = makeHarness(errSpawnNotFound())
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    const before = emissions.length

    const result = await adapter('C1')

    expect(result).toEqual(LIVENESS_READING_DEAD_NO_ROW)
    expect(isInstallGoneDeadReading(result)).toBe(false)
    expect(statusCalls.map((c) => c.instance_id)).toEqual(['cscb_C1'])
    expect([...getOutageFlags('C1')]).toEqual(['tmux-unavailable'])
    expect(cleared).toEqual([{ key: 'C1', cls: 'ad-unreachable' }])
    expect(emissions.slice(before)).toEqual([])
    expect(triggers).toEqual([])
  })

  // Twin of case 2 (b.jg5 SRJ-312): the `ad-unreachable` clear stays pinned.
  test('2b. ErrSpawnNotFound (b.jg5 SRJ-312, SRJ-501): status throws with only ad-unreachable raised → clears it; one all-clear posted; reads dead, carrying no row', async () => {
    const { emissions, cleared, adapter } = makeHarness(errSpawnNotFound())
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    const before = emissions.length

    const result = await adapter('C1')

    expect(result).toEqual(LIVENESS_READING_DEAD_NO_ROW)
    expect(getOutageFlags('C1').size).toBe(0)
    expect(cleared).toEqual([{ key: 'C1', cls: 'ad-unreachable' }])
    expect(emissions.slice(before)).toEqual([{ key: 'C1', text: adUnreachableAllClear('/bin/ad') }])
  })

  // b.jpf: executable discovery supplies no observation of the agent.
  test('3. ErrSystemInstallDisappeared: status throws → sets ad-unreachable with binaryPath as detail; reads unknown without an agent observation', async () => {
    const binaryPath = '/home/horde/.config/agent-director/bin/agent-director'
    const { emissions, statusCalls, adapter } = makeHarness(errSystemInstallDisappeared('status', binaryPath))

    const result = await adapter('C1')

    expect(result).toBe(LIVENESS_READING_UNKNOWN)
    expect(livenessKindOf(result)).toBe(livenessKindOf(LIVENESS_READING_UNKNOWN))
    expect(isInstallGoneDeadReading(result)).toBe(false)
    expect(statusCalls.map((c) => c.instance_id)).toEqual(['cscb_C1'])
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
    expect(statusCalls.map((c) => c.instance_id)).toEqual(['cscb_C1'])
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
    expect(statusCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
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
    expect(statusCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
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
    ['ErrSpawnNotFound', errSpawnNotFound, LIVENESS_READING_DEAD_NO_ROW],
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
    expect(isInstallGoneDeadReading(result)).toBe(false)
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
  // The only post is the onset of a class the error itself raises (never an
  // all-clear).
  /** The binary path the ErrSystemInstallDisappeared row names (its `ad-unreachable` onset carries it). */
  const disappearedBinaryPath = '/home/horde/.config/agent-director/bin/agent-director'
  test.each([
    ['ErrSystemInstallDisappeared', () => errSystemInstallDisappeared('status', disappearedBinaryPath), LIVENESS_READING_UNKNOWN, [ONSET_TEMPLATES['ad-unreachable'](disappearedBinaryPath)]],
    ['ErrTmuxNotAvailable (ENVIRONMENT)', () => errTmuxNotAvailable(undefined, 'status'), LIVENESS_READING_UNKNOWN, [ONSET_TEMPLATES['tmux-unavailable']()]],
    ...unavailableForms('ErrCallTimeout', 'ErrTmuxUnresponsive', 'ErrUnknownErrorName').map(
      ([label, build]) => [`${label} (UNAVAILABLE)`, () => build('status'), LIVENESS_READING_UNKNOWN, []] as const,
    ),
    ['ErrInternal', () => errInternal(), LIVENESS_READING_UNKNOWN, []],
  ] as ReadonlyArray<readonly [string, () => Error, LivenessReading, readonly string[]]>)('b.jg5 SRJ-312: with ad-config-malformed raised, status throws %s → ad-config-malformed stays raised: no clear, no clear line, no all-clear; reads %j; posts exactly %j', async (_label, build, reading, posts) => {
    const { emissions, cleared, adapter } = makeHarness(build())
    await raiseConfigOutage()
    const before = emissions.length

    const { result, errArgs } = await probeCapturingErrors(adapter, 'C1')

    expect(result).toEqual(reading)
    expect(getOutageFlags('C1').has('ad-config-malformed')).toBe(true)
    expect(cleared).toEqual([])
    expect(stringLines(errArgs).filter((l) => l.includes('ad-config-malformed cleared'))).toEqual([])
    expect(emissions.slice(before)).toEqual(posts.map((text) => ({ key: 'C1', text })))
  })

  // b.jg5 SRJ-314: every other `status` error reads `unknown`, never `dead`,
  // and raises no outage flag here. One log line, from the catch-all.
  test.each([
    ['ErrCallTimeout', () => errCallTimeout('status')],
    ['ErrTmuxUnresponsive', () => errTmuxUnresponsive('status')],
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
    expect(statusCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
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
  // UNCLASSIFIED, but the liveness adapter reports unknown and preserves
  // its `ad-unreachable` raise, and is never reported to the unclassified
  // sink, inside a restart run for the persona or outside one. Its arming is
  // unchanged (a read's error inside the attempt: the read-error cause).
  test.each([
    ['inside a restart run for the persona', true],
    ['outside any attempt', false],
  ] as const)('b.jg5 SRJ-313: status throws ErrSystemInstallDisappeared %s → reads unknown without an agent observation; ad-unreachable raised; not reported to the unclassified sink', async (_label, inside) => {
    const { triggers, unclassified, adapter } = makeHarness(errSystemInstallDisappeared('status'))

    const { result, errArgs } = inside
      ? await runInAttempt('C1', 'recovery', () => probeCapturingErrors(adapter, 'C1'))
      : await probeCapturingErrors(adapter, 'C1')

    expect(result).toBe(LIVENESS_READING_UNKNOWN)
    expect(isInstallGoneDeadReading(result)).toBe(false)
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

    expect(statusCalls.map((c) => c.instance_id)).toEqual([
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
    expect(isInstallGoneDeadReading(result)).toBe(false)
    // b.jg5 SRJ-501: no status call, so the reading carries no row read.
    expect(deadRowReadOf(result)).toBeUndefined()
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
// Each is built from its class for the verb its call uses. Where the builder takes a
// description it carries the leak marker inside a fake token and a `ticket=`
// URL (`sentinelInMessage`), which a described line redacts; `redacted` says
// the described line shows the redaction. An `ErrUnknownErrorName`'s own
// description is the client's, so its envelope's marked text is never logged.
// ---------------------------------------------------------------------------

/** This file's labels for the shared forms whose label it extends. */
const FORM_LABELS: Readonly<Record<string, string>> = {
  ErrUnknownErrorName: 'ErrUnknownErrorName (a name from a later binary)',
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

/** Every answer the reconnect adapter (`_buildReconnectSessionAdapter`) gives. */
type AdapterAnswer = Awaited<ReturnType<ReturnType<typeof _buildReconnectSessionAdapter>>>

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
// drive the mapping (b.jg5 SRJ-118, SRJ-609): ok → 'success'; dead-session
// → one sweep with its cause's verdict, then an escalate-dead answer carrying
// that verdict (b.jg5 SRJ-611); transient →
// 'transient' with no sweep. The reconnect is one `send-keys`, never retried.
//
// b.d61, b.jg5 SRJ-603: a `working` row whose session is gone (the Claude
// inside it was killed mid-turn, so AD's row stays frozen at `working`) must
// not be deferred forever. The `working` branch makes one `read-pane` of the
// persona's own row (`FULL_PANE_READ_LINES`): a pane goes to the
// positive-idle fold, GONE (and the row absent) to the dead-tmux sweep and
// 'escalate-dead', and every other class defers ('transient'), so a live
// turn is never poked (b.rmy) and a read that could not run never
// manufactures a false dead. While a launch for the persona is in flight the
// `working` row is deferred with no agent-director call: the launch owns the
// session. b.jg5 SRJ-604: a `waiting` row's one `read-pane` is classed the same
// way before `/mcp reconnect` is typed.
//
// b.jdc, b.jg5 SRJ-606: an `ask_user` or `check_permission` row is never
// typed into, but its own row is read first with one one-line `read-pane`
// (`PROBE_PANE_READ_LINES`) before it is deferred or reported: GONE (or the
// row absent) is swept and escalated with no notice, a pane or a read that
// could not run is taken as alive and deferred, and the deferrals sweep and
// read the row again from 10 min on (the per-cell block and the b.jdc block
// below).
// ---------------------------------------------------------------------------

describe('_buildReconnectSessionAdapter', () => {
  /**
   * Build a stub client wired into BOTH outage-state (which withOutageDetection
   * calls via getClient) and setClientForTests, plus a reconnect adapter. The
   * status probe and reconnectMcp's send-keys both flow through this one client.
   * The pane reads answer `paneQueue`, then `paneError`, then `pane` (the last
   * two read at each read, so a test may change them between attempts). `stub` is the shared client, for a test
   * that holds a launch's spawn open on it (`holdSpawns`).
   */
  function makeHarness(opts: {
    /** Read at each status probe, so a test may change it between attempts. */
    statusState?: string
    /** When set, each status probe rejects with it instead (read at each probe). */
    statusError?: Error
    /** Suppress notices while retaining the reconnect's ordinary liveness checks. */
    noNotice?: boolean
    sendKeysThrows?: Error
    /** Errors the send-keys calls answer in turn, before `sendKeysThrows` or success. */
    sendKeysErrors?: Error[]
    /** What every pane read shows unless `paneQueue` or `paneError` answers it (default: the stub's empty pane). */
    pane?: string
  pane_sha256?: string
    /** When set, every pane read rejects with it unless `paneQueue` answers it. */
    paneError?: Error
    /** Pane-read answers in order, one per read, ahead of `paneError` and `pane`. */
    paneQueue?: CannedResponse<ReadPaneResult>[]
    /** The transcript fields of the `working` row `get` answers (default: the stub's row, which names no transcript). */
    row?: { jsonl_path?: string; session_id: string; cwd?: string }
    /** The adapter's persona lookup (production: `getAppliedPersona`). */
    getPersona?: (key: string) => Persona | undefined
    /** The state every status probe reads once a findMissing sweep has run (default: `statusState`). */
    statusAfterSweep?: string
    /**
     * The `launch_started_at` every status result shows. Without the key, a
     * `pending` result shows the stub's default launch start and any other
     * none; given as `undefined` (`SAMPLE_LAUNCH_START_NONE`) the field is
     * left out.
     */
    launchStartedAt?: string
    /** When set, every findMissing sweep rejects with it. */
    findMissingError?: Error
    /** What every findMissing sweep answers (default: the stub's empty sweep). */
    findMissingResult?: FindMissingResult
    /** The row every `get` answers; takes precedence over `row`. */
    getRow?: ReturnType<typeof cannedGetResult>
    /** The adapter's latched query (production: the one latch's `isLatched`, b.jg5 SRJ-502); absent, none is passed. */
    isLatched?: (key: string) => boolean
    /** When set, the outage state's trigger sink records every retry it is asked to arm here. */
    triggers?: Array<{ key: string; kind: string }>
  }): {
    adapter: ReturnType<typeof _buildReconnectSessionAdapter>
    statusCalls: StatusParams[]
    sendKeysCalls: SendKeysParams[]
    findMissingCalls: FindMissingParams[]
    readPaneCalls: ReadPaneParams[]
    killCalls: KillParams[]
    spawnCalls: SpawnParams[]
    resumeCalls: ResumeParams[]
    getCalls: GetParams[]
    stub: StubClient
  } {
    const statusCalls: StatusParams[] = []
    const sendKeysCalls: SendKeysParams[] = []
    const findMissingCalls: FindMissingParams[] = []
    const readPaneCalls: ReadPaneParams[] = []
    const killCalls: KillParams[] = []
    const spawnCalls: SpawnParams[] = []
    const resumeCalls: ResumeParams[] = []
    const getCalls: GetParams[] = []
    const stub = makeStubClient({
      statusCalls,
      statusFn: () =>
        opts.statusError ??
        cannedStatusResult({
          state: (findMissingCalls.length > 0 ? opts.statusAfterSweep : undefined) ?? opts.statusState ?? 'waiting',
          ...('launchStartedAt' in opts ? { launch_started_at: opts.launchStartedAt } : {}),
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
      findMissingResult: opts.findMissingResult,
      readPaneCalls,
      killCalls,
      spawnCalls,
      resumeCalls,
      // Read at each pane read, so a test may change them between attempts.
      get readPaneResults() { return [cannedReadPaneResult(opts.pane ?? IDLE_PANE)] },
      get readPaneError() { return opts.paneError },
      readPaneQueue: opts.paneQueue,
      getCalls,
      get getResult() { return opts.getRow && findMissingCalls.length === 0 ? { ...opts.getRow, liveness_note: undefined } : opts.getRow ?? cannedGetResult({ instance_id: 'cscb_C1', state: opts.statusState ?? 'waiting', ...opts.row, ...('launchStartedAt' in opts ? { launch_started_at: opts.launchStartedAt } : {}) }) },
    })
    _resetOutageState()
    const triggers = opts.triggers
    initOutageState({
      notify: () => {},
      getClient: () => stub as unknown as Client,
      ...(triggers === undefined ? {} : { triggerSink: { arm: (key: string, cause: { kind: string }) => { triggers.push({ key, kind: cause.kind }); return true } } }),
    })
    setClientForTests(stub as unknown as Client)
    return {
      // The builder resolves the instance ID from the persona key alone
      // (b.av2 SR-2.2); its persona lookup only locates a `working` row's
      // transcript (b.f2b). Its latched query is asked right before
      // `/mcp reconnect` is typed (b.jg5 SRJ-502).
      adapter: _buildReconnectSessionAdapter(opts.getPersona, opts.isLatched, undefined, { noNotice: opts.noNotice }),
      statusCalls,
      sendKeysCalls,
      findMissingCalls,
      readPaneCalls,
      killCalls,
      spawnCalls,
      resumeCalls,
      getCalls,
      stub,
    }
  }

  /** `n` full reads of C1's own row's pane. */

  /** `n` one-line probe reads of C1's own row's pane (b.jdc's prompt rows, b.jg5 SRJ-606). */
  const probePaneReads = (n: number): ReadPaneParams[] =>
    Array(n).fill({ instance_id: personaInstanceId('C1'), n_lines: PROBE_PANE_READ_LINES })

  /** The escalate-dead sweep line for persona C1 with `verdict`, from the imported builder. */
  const escalateDeadLine = (verdict: EscalateDeadVerdict): string => escalateDeadSweepLine('C1', verdict)

  /**
   * The adapter's escalate-dead answer carrying `verdict`, the verdict it
   * swept with, decided by the session manager's own builder (b.jg5 SRJ-611).
   */
  const escalatedWith = (verdict: DeadEvidenceSource): ReconnectEscalateDead => ({ outcome: 'escalate-dead', deadEvidence: carriedDeadEvidenceOf(verdict) })

  /** C1's `read-pane` answering GONE: agent-director found no pane of its launch. */
  const paneGone = (): Error => errTmuxCaptureFailed(personaTmuxSessionName('C1'))

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
    _resetFindMissingMemo()
    _resetInFlightLaunches()
    _resetSpawnHomeDir()
    // b.f2b: the working-row evidence and notice latches, and the clock seam.
    _resetNotConnectedEpisodes()
    _resetNow()
    rmSync(dir, { recursive: true, force: true })
  })

  // b.omv SR-5.5: the timer caller suppresses notices, never pane checks or
  // the existing prompt-row sweep. No health-check tick drives these retries.

  test("(i-c) b.d61: AD state 'working' while a launch for the persona is in flight → 'transient' with no read-pane, sweep or send-keys, even with a read-pane that would answer GONE", async () => {
    // The launch resolves its unset claude_config_dir against a temp home.
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
    _setSpawnHomeDir(join(dir, 'home'))
    const config = makeStandInPersonaConfig({ C1: {} }, dir)
    // GONE: with nothing in flight this row escalates (i-b).
    const { adapter, stub, statusCalls, sendKeysCalls, findMissingCalls, readPaneCalls } = makeHarness({
      statusState: 'working',
      paneError: paneGone(),
    })
    // A launch whose session is not created yet: its spawn is held open.
    const held = holdSpawns(stub)
    const launch = spawnForPersona(config.personas[0]!, config, false)
    try {
      await held.entered('cscb_C1')
      expect(isLaunchInFlight('C1')).toBe(true)

      const result = await adapter('C1')

      expect(result).toBe('transient')
      expect(statusCalls).toEqual([])
      expect(readPaneCalls).toEqual([])
      expect(findMissingCalls).toHaveLength(0)
      expect(sendKeysCalls).toHaveLength(0)
    } finally {
      // Settle the held launch before teardown.
      held.releaseAll()
      await launch
    }
  })

  // b.f2b: a failed status probe says nothing about the session (it may be
  // mid-turn), so nothing is typed blind: 'transient', and the next tick
  // retries. Before b.f2b it fell through to the reconnect.

  // b.jg5 SRJ-115 (Task ruling): the adapter's state read keeps 'transient'
  // for every status error, ErrSpawnNotFound included (SRJ-105: it keeps each
  // site's meaning; the next liveness read reads it dead). Nothing is typed,
  // read or swept, and no error escalates to dead here.
  test.each([
    ['ErrSpawnNotFound', () => errSpawnNotFound()],
    ['ErrSystemInstallDisappeared', () => errSystemInstallDisappeared('status')],
    ['ErrCallTimeout', () => errCallTimeout('status')],
    ['ErrTmuxUnresponsive', () => errTmuxUnresponsive('status')],
    ['a plain Error', () => new Error('boom')],
  ])("SRJ-115: %s at the state read → 'transient', never 'escalate-dead'; no send-keys, pane read or sweep; one line", async (_label, build) => {
    const statusError = build()
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls, readPaneCalls } = makeHarness({ statusError })
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let result: AdapterAnswer | undefined
    try {
      result = await adapter('C1')
    } finally {
      console.error = orig
    }

    expect(result).toBe('transient')
    expect(statusCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
    expect(sendKeysCalls).toEqual([])
    expect(readPaneCalls).toEqual([])
    expect(findMissingCalls).toHaveLength(0)
    expect(lines).toEqual([reconnectStatusCheckFailedLine('C1', describeAdFailureForLog(statusError))])
  })

  // b.jg5 SRJ-115, SRJ-316: a CONFIG answer at the state read is the same
  // 'transient' with nothing typed, read or swept; the outage wrapper also
  // raises `ad-config-malformed`, which adds its one raise line.
  test("SRJ-115, SRJ-316: a CONFIG answer (ErrConfigMalformed) at the state read → 'transient', never 'escalate-dead'; no send-keys, pane read or sweep; ad-config-malformed raised; the status-check line and one raise line", async () => {
    const statusError = errConfigMalformed()
    const { result, errArgs, statusCalls, sendKeysCalls, findMissingCalls, readPaneCalls, killCalls, spawnCalls, resumeCalls } = await reconnectCapturing({ statusError })

    expect(result).toBe('transient')
    expect(statusCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
    expect([sendKeysCalls, readPaneCalls, killCalls, spawnCalls, resumeCalls]).toEqual([[], [], [], [], []])
    expect(findMissingCalls).toHaveLength(0)
    expect([...getOutageFlags('C1')]).toEqual(['ad-config-malformed'])
    const lines = stringLines(errArgs)
    expect(lines.filter((l) => l === reconnectStatusCheckFailedLine('C1', describeAdFailureForLog(statusError)))).toHaveLength(1)
    expect(lines.filter((l) => l.includes('ad-config-malformed raised for persona=C1'))).toHaveLength(1)
    expect(lines).toHaveLength(2)
    assertNoLeak({ errArgs })
  })

  // b.jg5 SRJ-118, SRJ-609: the reconnect is one `send-keys`, never retried.
  // Each case below runs the adapter for C1 on a `waiting` row whose
  // `read-pane` shows an idle pane (so the reconnect goes ahead), capturing
  // every spawn-failure notice and console.error line; nothing leaks. The CONFLICT and UNUSABLE NAME
  // cells, which need the latch, are in the per-cell describe below.
  /** Run the adapter for C1 on a `waiting` row with an idle pane over `opts`, capturing notices and console.error. */
  async function reconnectCapturing(opts: Parameters<typeof makeHarness>[0]) {
    const raised: string[] = []
    setSessionNotifier((key) => { raised.push(key) })
    try {
      const h = makeHarness({ statusState: 'waiting', pane: IDLE_PANE, ...opts })
      const { result, errArgs } = await capturingErrorArgs(() => h.adapter('C1'))
      return { ...h, result, errArgs, raised }
    } finally {
      setSessionNotifier(undefined)
    }
  }

  /** The escalate-dead sweep lines among `lines`. */
  const escalateDeadLines = (lines: readonly string[]): string[] => lines.filter((l) => l.startsWith('[slack] escalate-dead: persona='))

  test("ok: one send-keys → 'success', with no sweep or notice", async () => {
    const h = await reconnectCapturing({})

    expect(h.result).toBe('success')
    expect(h.sendKeysCalls).toEqual([{ instance_id: personaInstanceId('C1'), text: `/mcp reconnect ${MCP_SERVER_NAME}`, no_enter: true }, { instance_id: personaInstanceId('C1'), key: 'Enter' }])
    expect(h.findMissingCalls).toEqual([])
    expect(h.raised).toEqual([])
    assertNoLeak({ errArgs: h.errArgs })
  })

  test("(iv) GONE (ErrTmuxSendKeys) → dead-session → 'escalate-dead' after exactly one send-keys (no second try), firing exactly one memoized findMissing sweep (b.sv7 / Epic t1.tkk.e4) whose line carries the dead-session verdict's text; no notice", async () => {
    // The status probe is 'waiting' (not 'working'), so the adapter does NOT
    // defer — it falls through to the reconnect and the dead-session escalate
    // branch.
    const h = await reconnectCapturing({ sendKeysThrows: errTmuxSendKeys() })

    expect(h.result).toEqual(escalatedWith('dead-session'))
    // The one keystroke answered GONE; the line says what was observed, not
    // that the tmux session is provably dead.
    const lines = stringLines(h.errArgs)
    expect(escalateDeadLines(lines)).toEqual([escalateDeadLine('dead-session')])
    expect(escalateDeadLines(lines)[0]).toContain(ESCALATE_DEAD_EVIDENCE['dead-session'])
    expect(h.statusCalls).toHaveLength(1)
    expect(h.sendKeysCalls.map((c) => c.instance_id)).toEqual(['cscb_C1'])
    // The escalate-dead branch fires sweepDeadTmuxChannel → the memoized
    // reconcileMissingSweep → exactly ONE client.findMissing({}). No direct new
    // findMissing call site; the memoized helper is the only sweep mechanism.
    expect(h.findMissingCalls).toHaveLength(1)
    expect(h.raised).toEqual([])
    assertNoLeak({ errArgs: h.errArgs })
  })

  test("ErrSpawnNotFound at the send-keys (no row) → dead-session (row-absent) → 'escalate-dead' with one sweep whose verdict is the row-absent one, never the GONE one; one send-keys; no notice", async () => {
    const h = await reconnectCapturing({ sendKeysThrows: errSpawnNotFound() })

    expect(h.result).toEqual(escalatedWith(ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ))
    const lines = stringLines(h.errArgs)
    expect(escalateDeadLines(lines)).toEqual([escalateDeadLine(ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ)])
    expect(escalateDeadLines(lines)[0]).not.toContain(ESCALATE_DEAD_EVIDENCE['dead-session'])
    expect(h.sendKeysCalls.map((c) => c.instance_id)).toEqual(['cscb_C1'])
    expect(h.findMissingCalls).toHaveLength(1)
    expect(h.raised).toEqual([])
    assertNoLeak({ errArgs: h.errArgs })
  })

  // b.jg5 SRJ-105, SRJ-118: an UNAVAILABLE `send-keys` is `transient`: never
  // 'escalate-dead', no sweep and no spawn-failure notice. The reconnect's
  // one line describes the error (never the raw value); nothing leaks.
  /** The reconnect's transient line for persona C1. */
  const sendKeysTransientLine = (err: unknown, errorClass: AdErrorClass): string =>
    reconnectTransientLine('persona=C1', describeAdFailureForLog(err), errorClass)

  test.each(UNAVAILABLE_FORMS)("SRJ-105, SRJ-118: send-keys refused with %s → 'transient', never 'escalate-dead'; one send-keys, no sweep, no spawn-failure notice; one described line, nothing leaks", async (_label, build, redacted) => {
    const err = build('send-keys')

    const { result, errArgs, raised, sendKeysCalls, findMissingCalls } = await reconnectCapturing({ sendKeysThrows: err })

    expect(result).toBe('transient')
    expect(sendKeysCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
    expect(findMissingCalls).toHaveLength(0)
    expect(raised).toEqual([])
    const lines = stringLines(errArgs)
    expect(lines.filter((l) => l.startsWith('[slack] reconnectMcp:'))).toEqual([sendKeysTransientLine(err, AD_ERROR_CLASS_UNAVAILABLE)])
    expect(lines.filter((l) => l.startsWith('[slack] escalate-dead'))).toEqual([])
    if (redacted) expect(lines.join('\n')).toContain(REDACTED_SENTINEL_TAIL)
    assertNoLeak({ errArgs })
  })

  // b.jg5 SRJ-105, SRJ-311, SRJ-316, SRJ-313, SRJ-118: an ENVIRONMENT
  // `send-keys` (ErrTmuxNotAvailable, whose wrapper raises
  // `tmux-unavailable`), a CONFIG one (ErrConfigMalformed, whose wrapper
  // raises `ad-config-malformed`) or an UNCLASSIFIED one (an `ErrInternal`, a
  // name CSCB gives no handling, `ErrSendKeysWhileRelayed`, or
  // `ErrSystemInstallDisappeared`, whose wrapper raises `ad-unreachable`) is
  // `transient` too: never 'escalate-dead', no sweep, kill or launch and no
  // spawn-failure notice; one described line, nothing leaks. Each row raises
  // exactly its expected outage flags.
  /** [label, builder, the outage flags it leaves raised for C1, its class]. */
  const TRANSIENT_SEND_KEYS_ERRORS: ReadonlyArray<readonly [string, () => Error, readonly OutageClass[], AdErrorClass]> = [
    ['ErrTmuxNotAvailable (ENVIRONMENT)', () => errTmuxNotAvailable(undefined, 'send-keys'), ['tmux-unavailable'], AD_ERROR_CLASS_ENVIRONMENT],
    ['a CONFIG answer (ErrConfigMalformed)', () => errConfigMalformed('starting_session_seconds', sentinelInMessage('send-keys-config')), ['ad-config-malformed'], AD_ERROR_CLASS_CONFIG],
    ['ErrInternal (UNCLASSIFIED)', () => errInternal(`the store could not be read (${sentinelInMessage('send-keys-internal')})`), [], AD_ERROR_CLASS_UNCLASSIFIED],
    ['a name CSCB gives no handling (UNCLASSIFIED)', () => errGeneric('send-keys', 'ErrSendKeysBroken', `the keystrokes broke (${sentinelInMessage('send-keys-generic')})`), [], AD_ERROR_CLASS_UNCLASSIFIED],
    ['ErrSendKeysWhileRelayed (UNCLASSIFIED)', () => errSendKeysWhileRelayed(), [], AD_ERROR_CLASS_UNCLASSIFIED],
    ['ErrSystemInstallDisappeared (UNCLASSIFIED)', () => errSystemInstallDisappeared('send-keys'), ['ad-unreachable'], AD_ERROR_CLASS_UNCLASSIFIED],
  ]
  test.each(TRANSIENT_SEND_KEYS_ERRORS)("b.jg5 SRJ-105, SRJ-118: send-keys answers %s → 'transient', never 'escalate-dead'; one send-keys, no sweep, kill or launch, no spawn-failure notice; one described line; outage flags exactly %j; nothing leaks", async (_label, build, flags, errorClass) => {
    const err = build()

    const { result, errArgs, raised, sendKeysCalls, findMissingCalls, killCalls, spawnCalls, resumeCalls } = await reconnectCapturing({ sendKeysThrows: err })

    expect(result).toBe('transient')
    expect(sendKeysCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
    expect(findMissingCalls).toHaveLength(0)
    expect([killCalls, spawnCalls, resumeCalls]).toEqual([[], [], []])
    expect(raised).toEqual([])
    expect([...getOutageFlags('C1')]).toEqual([...flags])
    const lines = stringLines(errArgs)
    expect(lines.filter((l) => l.startsWith('[slack] reconnectMcp:'))).toEqual([sendKeysTransientLine(err, errorClass)])
    expect(lines.filter((l) => l.startsWith('[slack] escalate-dead'))).toEqual([])
    assertNoLeak({ errArgs })
  })

  // b.dup: agent-director refuses send-keys to an `ended` or `missing` row
  // with ErrSpawnNotInteractive. A findMissing sweep can mark the row missing
  // after the adapter read it (here `waiting`, or `missing` when the sweep
  // landed between the liveness probe and the adapter's status read) and
  // before its keystrokes land. The reconnect answers 'dead-session' (cause
  // `row-not-interactive`), so the adapter sweeps and escalates carrying the
  // `row-not-interactive` verdict, which is not dead evidence: a route into
  // the restart run's decision only, whose `dead` re-probe relaunches the
  // persona with no kill (restart.test.ts, b.dup; b.jg5 SRJ-609, SRJ-611).
  // Before the fix: 'transient' and a spawn-failure notice.
  // b.jdc (b.dup review): the escalate-dead line says why. Here the tmux
  // session may well be alive: agent-director refused the keystrokes because
  // the row is not interactive, so the line must not claim the tmux session is
  // provably dead (REPRO for the wording: the old line always did).
  test.each(['waiting', 'missing'])("REPRO (b.dup): the row reads %s and the reconnect's keystrokes are refused (ErrSpawnNotInteractive) → the escalate-dead answer carrying the row-not-interactive verdict with one sweep and one send-keys (no second try); no spawn-failure notice; the escalate-dead line carries the row-not-interactive verdict's text", async (state) => {
    const h = await reconnectCapturing({ statusState: state, sendKeysThrows: errSpawnNotInteractive('send-keys') })

    expect(h.result).toEqual(escalatedWith('row-not-interactive'))
    expect(h.sendKeysCalls.map((c) => c.instance_id)).toEqual(state === 'missing' ? [] : ['cscb_C1'])
    expect(h.findMissingCalls).toHaveLength(1)
    expect(h.raised).toEqual([])
    const lines = escalateDeadLines(stringLines(h.errArgs))
    expect(lines).toEqual([escalateDeadLine('row-not-interactive')])
    expect(lines[0]).toContain(ESCALATE_DEAD_EVIDENCE['row-not-interactive'])
    assertNoLeak({ errArgs: h.errArgs })
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
  /**
   * Asserts `lines` is exactly the one deferral line for persona C1, naming
   * the launch start `logged` (`undefined`: the line with no launch part).
   * The expected line is built with no launch start when none may be named,
   * so the builder's own filtering is not what the case relies on.
   */
  const expectOneDeferralLine = (lines: string[], logged: string | undefined): void => {
    expect(lines).toEqual([deferringPendingRowLine('C1', logged)])
    if (logged === undefined) expect(lines[0]).not.toContain('launch started')
    else expect(lines[0]).toContain(`its row reads pending (launch started ${logged}) — `)
  }
  // [label, launch start passed, launch start the line names]
  const DEFERRAL_CASES: ReadonlyArray<readonly [string, string | undefined, string | undefined]> = [
    ['no launch start', SAMPLE_LAUNCH_START_NONE, undefined],
    ...LAUNCH_STARTS.map((start) => [`launch start ${start}`, start, start] as const),
  ]

  // b.jg5 SRJ-408, SRJ-513: the configured-persona query counts no key here,
  // so the row with no launch start latches nothing and is deferred; under a
  // configured persona's key it latches instead (the SRJ-513 describe below).
  test.each(DEFERRAL_CASES)("REPRO (b.dup), b.jg5 SRJ-303/SRJ-115: a pending row showing %s, under a key no configured persona uses → 'pending' with no send-keys, pane read or sweep, no notice, and one line naming its launch start", async (_label, launchStartedAt, logged) => {
    const raised: string[] = []
    setSessionNotifier((key) => { raised.push(key) })
    setConfiguredPersonaQuery(() => false)
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    try {
      const { adapter, sendKeysCalls, findMissingCalls, readPaneCalls } = makeHarness({
        statusState: AGENT_DIRECTOR_PENDING_STATE,
        launchStartedAt,
        sendKeysThrows: errSpawnNotInteractive('send-keys'),
      })

      const result = await adapter('C1')

      expect(result).toBe('pending')
      expect(sendKeysCalls).toEqual([])
      expect(readPaneCalls).toEqual([])
      expect(findMissingCalls).toHaveLength(0)
      expect(raised).toEqual([])
      expectOneDeferralLine(lines, logged)
    } finally {
      console.error = orig
      setSessionNotifier(undefined)
      _resetConfiguredPersonaQuery()
    }
  })

  // b.jg5 SRJ-314: the restart work calls `deferPendingRow` itself (bound in
  // main()), awaiting it. Called directly for a key that is not applied (no
  // applied config here), it reads nothing more (b.jg5 SRJ-409: only an
  // applied persona's row is read again and decided): no agent-director call
  // (nothing read, typed or swept), no notice, its line, and 'pending'. An
  // applied persona's decision is the SRJ-409 describe's below.
  test.each(DEFERRAL_CASES)("deferPendingRow called directly for a key that is not applied, with %s → 'pending'; no agent-director call, no notice; one line naming its launch start", async (_label, launchStartedAt, logged) => {
    const raised: string[] = []
    setSessionNotifier((key) => { raised.push(key) })
    const { statusCalls, getCalls, sendKeysCalls, findMissingCalls, readPaneCalls } = makeHarness({})
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let result: string | undefined
    try {
      result = await deferPendingRow('C1', launchStartedAt)
    } finally {
      console.error = orig
      setSessionNotifier(undefined)
    }

    expect(result).toBe('pending')
    expect(statusCalls).toEqual([])
    expect(getCalls).toEqual([])
    expect(sendKeysCalls).toEqual([])
    expect(readPaneCalls).toEqual([])
    expect(findMissingCalls).toHaveLength(0)
    expect(raised).toEqual([])
    expectOneDeferralLine(lines, logged)
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

  test.each(UNLOGGABLE_LAUNCH_STARTS)("deferPendingRow called directly with a launch start holding %s → 'pending'; exactly one line, without the launch part or the injected text", async (_label, launchStartedAt, injected) => {
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let result: string | undefined
    try {
      result = await deferPendingRow('C1', launchStartedAt)
    } finally {
      console.error = orig
    }

    expect(result).toBe('pending')
    expectOneDeferralLine(lines, undefined)
    expect(lines[0]).not.toContain('\n')
    expect(lines[0]).not.toContain(injected)
  })

  test.each(LAUNCH_STARTS)("deferPendingRow called directly with the valid launch start %s → one line naming it", async (start) => {
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    try {
      await deferPendingRow('C1', start)
    } finally {
      console.error = orig
    }

    expectOneDeferralLine(lines, start)
  })

  test('(v) the key passed selects the instance: a non-channel-form key probes and reconnects cscb_<key> (b.av2 SR-2.2)', async () => {
    const { adapter, statusCalls, sendKeysCalls } = makeHarness({ statusState: 'waiting' })

    const result = await adapter('ops_bot')

    expect(result).toBe('success')
    expect(statusCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('ops_bot')])
    expect(sendKeysCalls.map((c) => c.instance_id)).toEqual(['cscb_ops_bot', 'cscb_ops_bot'])
  })

  // b.f2b: a `working` row can be stale (agent-director left it `working`
  // after the turn ended), and deferring on it forever stranded the persona.
  // b.jg5 SRJ-603: each attempt makes one `read-pane` of the row (no tmux
  // call) and, for an idle screen, reads the transcript the row names; the
  // evidence is kept across attempts (a tick or more apart, here on a fake
  // clock passed to the session manager's `_setNow`), and the attempt that
  // finds the same idle screen and the same transcript, ended with a
  // completed turn, across 60 s types `/mcp reconnect`. A running turn, and a
  // prompt or dialog (`ask_user` / `check_permission`, or on a `working` or
  // `waiting` row's pane), are never typed into (b.rmy).

  // b.jg5 SRJ-117, SRJ-603, SRJ-604: a `working` or `waiting` row's one
  // `read-pane`, one case per cell of SRJ-117's two columns. The server's
  // latch (`createConflictLatch`, its lines recorded) is installed through
  // the session manager's installer (`setConflictLatch`) and its query passed
  // to the adapter, as `main()` does; attempts run on a fake clock passed to
  // `_setNow`, and every not-connected notice is recorded.
  //   - A `working` row (its panes are the b.f2b cases above): GONE and the
  //     row absent sweep once and escalate with their verdicts; UNAVAILABLE
  //     and CONFIG (its outage raised) defer with one deferral noted;
  //     ENVIRONMENT (its outage raised) and UNCLASSIFIED defer with none, and
  //     leave the run of deferrals as it is; CONFLICT and UNUSABLE NAME latch
  //     P with the state `working` and defer with none. Whether a deferral
  //     was noted shows on the run of deferrals: the case's attempt comes
  //     `UNPROVEN_IDLE_NOTICE_AFTER_MS` after an idle pane's attempt started

  //     forgets), so a noted deferral raises the unproven-idle notice and one
  //     not noted raises none.
  //   - A `waiting` row (its running turn and dialog are the b.f2b cases
  //     above): an idle pane reconnects; GONE and the row absent sweep and
  //     escalate with nothing typed; CONFLICT and UNUSABLE NAME latch P with
  //     the state `waiting` and type nothing; ENVIRONMENT types nothing;
  //     UNAVAILABLE, CONFIG and UNCLASSIFIED let the reconnect go ahead on
  //     the row alone.
  //   - On either row, a latching answer, read inside P's recovery attempt,
  //     posts the latch's one notice (the latch's notice bound to recorded
  //     episodes), counts nothing and arms no retry (the outage state's
  //     trigger sink recorded); an `ErrInvalidFlags` whose one version
  //     re-check (the real one, over a stub `resolveSystemBinary`) decides
  //     that the server stops types nothing and makes no call after the
  //     re-check (b.jg5 SRJ-205), while one whose re-check passes is any
  //     other UNCLASSIFIED.
  //   - A persona latched elsewhere while the `read-pane` is awaited gets no
  //     not-connected notice (b.jg5 SRJ-502).
  //   - b.jg5 SRJ-118, SRJ-501, SRJ-512: on a `waiting` row whose pane is
  //     idle, the reconnect's one `send-keys` answering CONFLICT (the case
  //     table's reconnect rows for `waiting`) or UNUSABLE NAME latches P with
  //     the state `waiting` and posts once; the next attempt types nothing.
  //   - An `ask_user` or `check_permission` row (b.jdc's reconnect verdict,
  //     b.jg5 SRJ-606), each prompt state, one one-line `read-pane`
  //     (`PROBE_PANE_READ_LINES`) per attempt and nothing typed: a pane
  //     defers with the blocked-on-prompt notice once per episode; GONE and
  //     the row absent sweep once and escalate with their verdicts, with no
  //     notice; UNAVAILABLE, CONFIG (its outage raised) and UNCLASSIFIED are
  //     taken as alive: the deferral and its notice, the read counted in the
  //     run of deferrals (a read `PROMPT_ROW_SWEEP_AFTER_MS` later sweeps);
  //     ENVIRONMENT (its outage raised) defers with no deferral noted and no
  //     notice; CONFLICT (the case table's prompt-row reconnect-verdict rows)
  //     and UNUSABLE NAME latch P with the prompt state; a stop-marked
  //     UNCLASSIFIED calls nothing more; a persona latched elsewhere during
  //     the read gets no notice.
  //   - b.jg5 SRJ-613 (AC 44), in the nested describe at the end: the named
  //     sequences across paths whose reconnect `send-keys` answers CONFLICT
  //     "not this launch's session" (a `waiting` row's pane, its read with
  //     no pane, a stale `working` row's fold, a prompt row's pane leading
  //     only to the deferral until the row reads `waiting`).
  // Every line, notice and latch line is leak-checked.

  // b.jdc (/ci-live run 6): when a persona's session dies while its row reads
  // `ask_user` or `check_permission`, the row keeps that state: agent-director
  // only refreshes a row at SessionEnd and leaves reaping to its findMissing
  // sweep. Deferring on the row alone kept a dead persona "blocked on a
  // prompt" for good: never relaunched, with a *Waiting on a prompt* notice
  // about a session that no longer existed. The adapter now reads the
  // persona's own row first with one one-line `read-pane` (b.jg5 SRJ-606;
  // each answer's cell is in the per-cell block above): GONE → the dead-tmux
  // sweep and 'escalate-dead', with no notice; a pane (or a read taken as
  // alive) → the deferral and its notice as before, and once the deferrals on
  // the row have run for `PROMPT_ROW_SWEEP_AFTER_MS` each one first runs the
  // findMissing sweep and reads the row again, escalating when it reads
  // `missing` or `ended`. The cases here run on the stub's pane (its default
  // answer). Nothing is ever typed into the row (b.rmy). Attempts run on a
  // fake clock passed to `_setNow`. Cases marked REPRO fail on the code
  // before the fix.
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
      assertNoLeak({ lines, raised })
    })

    /** Attempt a reconnect of C1 at each of `minutes` on the fake clock; the verdicts in order. */
    async function attemptsAt(adapter: (key: string) => Promise<AdapterAnswer>, minutes: readonly number[]): Promise<AdapterAnswer[]> {
      const verdicts: AdapterAnswer[] = []
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

    /** The minute on the fake clock at which the run of deferrals has lasted `PROMPT_ROW_SWEEP_AFTER_MS`. */
    const SWEEP_MINUTE = PROMPT_ROW_SWEEP_AFTER_MS / 60_000

    test.each([
      ['ask_user', 'missing'],
      ['check_permission', 'ended'],
    ])("REPRO: a %s row whose read-pane answers a pane is deferred with its notice; once the deferrals have run for PROMPT_ROW_SWEEP_AFTER_MS the next one runs the findMissing sweep and reads the row again, and %s → 'escalate-dead'; one one-line read-pane per attempt; nothing is ever typed", async (state, after) => {
      const h = makeHarness({ statusState: state, statusAfterSweep: after })

      expect(await attemptsAt(h.adapter, [0, 4, 8])).toEqual(['transient', 'transient', 'transient'])
      expect(h.findMissingCalls).toEqual([])
      expect(await attemptsAt(h.adapter, [SWEEP_MINUTE])).toEqual([escalatedWith(DEAD_SESSION_CAUSE_ROW_READ_FINISHED)])

      expect(h.findMissingCalls).toHaveLength(1)
      expect(h.readPaneCalls).toEqual(probePaneReads(4))
      // Each attempt's status read, then the read after the sweep.
      expect(h.statusCalls).toHaveLength(5)
      expect(h.sendKeysCalls).toEqual([])
      // The prompt was reported once, while its session was alive.
      expect(raised.map((n) => n.key)).toEqual(['C1'])
      expect(raised[0]!.text).toStartWith(':warning: *Waiting on a prompt*')
      expect(adapterLines().at(-1)).toBe(promptRowSweepFinishedLine('persona=C1', state, PROMPT_ROW_SWEEP_AFTER_MS, after))
      // The builder's one literal pin (b.jg5 SRJ-611): it says what was read, a
      // row read and not dead evidence, and that the re-probe decides.
      expect(adapterLines().at(-1)).toBe(
        `[slack] reconnectSession: persona=C1 has read ${state} for ${SWEEP_MINUTE} min of deferrals, and after a findMissing sweep its row reads ${after} — not deferring; escalating (escalate-dead), the restart path's re-probe decides (cause=row-read-finished: not dead evidence; b.jdc, b.jg5 SRJ-611)`,
      )
    })

    test('a check_permission row whose read-pane answers a pane and that still reads check_permission after the sweep stays deferred: from PROMPT_ROW_SWEEP_AFTER_MS on each deferral sweeps once; one notice for the episode; nothing typed', async () => {
      // No memo: each attempt here is a tick or more apart.
      _setFindMissingMemoTtlMs(0)
      const h = makeHarness({ statusState: 'check_permission' })

      expect(await attemptsAt(h.adapter, [0, SWEEP_MINUTE - 1, SWEEP_MINUTE, SWEEP_MINUTE + 3, SWEEP_MINUTE + 6])).toEqual(Array(5).fill('transient'))

      expect(h.findMissingCalls).toHaveLength(3)
      expect(h.sendKeysCalls).toEqual([])
      expect(h.readPaneCalls).toEqual(probePaneReads(5))
      expect(raised.map((n) => n.key)).toEqual(['C1'])
    })

    test("a check_permission row while a launch for the persona is in flight → 'transient' with no read-pane, sweep, send-keys or notice, even with a read-pane that would answer GONE: the launch owns the session", async () => {
      // The launch resolves its unset claude_config_dir against a temp home.
      mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
      _setSpawnHomeDir(join(dir, 'home'))
      const config = makeStandInPersonaConfig({ C1: {} }, dir)
      const h = makeHarness({ statusState: 'check_permission', paneError: paneGone() })
      // A launch whose tmux session is not created yet: its spawn is held open.
      const held = holdSpawns(h.stub)
      const launch = spawnForPersona(config.personas[0]!, config, false)
      try {
        await held.entered('cscb_C1')
        expect(isLaunchInFlight('C1')).toBe(true)

        expect(await h.adapter('C1')).toBe('transient')

        expect(h.readPaneCalls).toEqual([])
        expect(h.findMissingCalls).toEqual([])
        expect(h.sendKeysCalls).toEqual([])
        expect(raised).toEqual([])
        expect(adapterLines()).toEqual([])
      } finally {
        // Settle the held launch before teardown.
        held.releaseAll()
        await launch
      }
    })

    // b.jg5 SRJ-303: the minute-6 attempt reads `pending`, which the adapter
    // answers 'pending' (a deferral restart.ts treats as 'transient').
    test('an attempt that reads another state ends the run of deferrals on the prompt row: the 10 min start over (its pending read answers \'pending\', b.jg5 SRJ-303)', async () => {
      const opts: Parameters<typeof makeHarness>[0] = { statusState: 'check_permission', statusAfterSweep: 'missing' }
      const h = makeHarness(opts)
      const verdicts: AdapterAnswer[] = []
      for (const [minute, state] of [[0, 'check_permission'], [6, 'pending'], [9, 'ask_user'], [18, 'ask_user'], [19, 'ask_user']] as const) {
        opts.statusState = state
        verdicts.push(...(await attemptsAt(h.adapter, [minute])))
      }

      expect(verdicts).toEqual(['transient', 'pending', 'transient', 'transient', escalatedWith(DEAD_SESSION_CAUSE_ROW_READ_FINISHED)])
      expect(h.findMissingCalls).toHaveLength(1)
      expect(h.sendKeysCalls).toEqual([])
    })

    test("the persona's not-connected episode ending (its MCP session registered again) ends the run too, and a later episode is reported again", async () => {
      const h = makeHarness({ statusState: 'check_permission', statusAfterSweep: 'missing' })

      expect(await attemptsAt(h.adapter, [0, 5])).toEqual(['transient', 'transient'])
      forgetNotConnectedEpisode('C1')
      expect(await attemptsAt(h.adapter, [6, 15, 16])).toEqual(['transient', 'transient', escalatedWith(DEAD_SESSION_CAUSE_ROW_READ_FINISHED)])

      expect(h.findMissingCalls).toHaveLength(1)
      expect(raised.map((n) => n.key)).toEqual(['C1', 'C1'])
    })

    // b.jg5 SRJ-120, SRJ-502: the sweep from 10 min on lists C1's own row in
    // `unverified_ids`, so the run reads that row with one `get`. A
    // `provenance_conflict` note there latches C1: the deferral check answers
    // `latched` and the adapter 'transient', with no row read after the
    // sweep, nothing escalated and no deferral (no deferral line, no
    // blocked-on-prompt notice, since the persona is held (b.jg5 SRJ-502) and
    // its latch's own notice already tells the human (SRJ-508)). Any other
    // row latches no one, and the attempt defers, or escalates, as before.
    // The episode's notice is raised at minute 0, so a deferral at minute 10
    // shows as a second copy of minute 0's deferral line.
    describe('b.jg5 SRJ-502: the post-run get of the sweep from 10 min on, and the status read after it', () => {
      let latch: ConflictLatch

      beforeEach(() => {
        latch = createConflictLatch({ log: (line) => { lines.push(line) } })
        setConflictLatch(latch)
        setConfiguredPersonaQuery((key) => key === 'C1')
      })

      afterEach(() => {
        setConflictLatch(undefined)
        _resetConfiguredPersonaQuery()
      })

      test.each<[string, string | undefined, string, boolean, AdapterAnswer, number]>([
        ['a provenance_conflict note latches C1; the row would still read check_permission', provenanceNote, 'check_permission', true, 'transient', 1],
        ['a provenance_conflict note latches C1; the row would read missing', provenanceNote, 'missing', true, 'transient', 1],
        ['regression: no note, the row still reads check_permission → deferred again', undefined, 'check_permission', false, 'transient', 2],
        ['regression: a note that latches no one, the row still reads check_permission → deferred again', nonLatchingNotes[0], 'check_permission', false, 'transient', 2],
        ['regression: no note, the row reads missing → escalated', undefined, 'missing', false, escalatedWith(DEAD_SESSION_CAUSE_ROW_READ_FINISHED), 1],
      ])('%s: one sweep, one get of cscb_C1, nothing typed, killed or launched', async (_label, note, after, latched, verdict, deferrals) => {
        const h = makeHarness({
          statusState: 'check_permission',
          statusAfterSweep: after,
          findMissingResult: cannedFindMissing({ rows: { [personaInstanceId('C1')]: 'unverified_ids' } }),
          getRow: cannedGetResult({ instance_id: personaInstanceId('C1'), state: 'check_permission', liveness_note: note }),
        })

        expect(await attemptsAt(h.adapter, [0])).toEqual(['transient'])
        const minuteZero = adapterLines()
        expect(minuteZero).toHaveLength(1)
        expect(await attemptsAt(h.adapter, [SWEEP_MINUTE])).toEqual([verdict])

        expect(latch.isLatched('C1')).toBe(latched)
        expect(h.findMissingCalls).toHaveLength(1)
        expect(h.getCalls.map((c) => c.instance_id)).toEqual(Array(3).fill(personaInstanceId('C1')))
        // One status read per attempt, and one more after the sweep unless C1 latched.
        expect(h.statusCalls).toHaveLength(latched ? 2 : 3)
        expect(h.sendKeysCalls).toEqual([])
        expect(h.readPaneCalls).toEqual(probePaneReads(2))
        expect([h.killCalls, h.spawnCalls, h.resumeCalls]).toEqual([[], [], []])
        expect(adapterLines().filter((l) => l === minuteZero[0])).toHaveLength(deferrals)
        // The minute-0 notice only.
        expect(raised.map((n) => n.key)).toEqual(['C1'])
      })

      // b.jg5 SRJ-502: the sweep latches no one, but C1 is latched elsewhere
      // (here a launch's CONFLICT) while the status read after it is awaited.
      // The deferral check asks the latch after that read and answers
      // `latched`, so the adapter answers 'transient' with no deferral (no
      // second deferral line, no blocked-on-prompt notice) and no escalation,
      // and logs one line naming the read.
      test.each(['ask_user', 'check_permission'])("a %s row whose persona is latched during the status read after the sweep from 10 min on → 'transient': no deferral, nothing typed, killed or launched; one latched-after-read line", async (state) => {
        const h = makeHarness({ statusState: state, statusAfterSweep: 'missing', isLatched: (key) => latch.isLatched(key) })
        const stub = h.stub as unknown as { status: (params: StatusParams) => Promise<unknown> }
        const realStatus = stub.status.bind(h.stub)
        stub.status = async (params) => {
          if (h.findMissingCalls.length > 0) {
            latch.setFromConflict('C1', conflictForPersona('C1'), { refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: LATCH_ROW_STATE_NO_ROW })
          }
          return realStatus(params)
        }

        expect(await attemptsAt(h.adapter, [0])).toEqual(['transient'])
        const minuteZero = adapterLines()
        expect(minuteZero).toHaveLength(1)
        expect(await attemptsAt(h.adapter, [SWEEP_MINUTE])).toEqual(['transient'])

        expect(latch.isLatched('C1')).toBe(true)
        expect(h.findMissingCalls).toHaveLength(1)
        // One status read per attempt, and the read after the sweep.
        expect(h.statusCalls).toHaveLength(3)
        expect(h.sendKeysCalls).toEqual([])
        expect(h.readPaneCalls).toEqual(probePaneReads(2))
        expect([h.killCalls, h.spawnCalls, h.resumeCalls]).toEqual([[], [], []])
        // Minute 10: the sweep's summary, then the latched line; no deferral or escalation line.
        const [sweep, ...minuteTen] = adapterLines().slice(minuteZero.length)
        expect(sweep).toStartWith('[slack] reconnectSession: prompt row: findMissing sweep for persona=C1 — ')
        expect(minuteTen).toEqual([
          '[slack] reconnectSession: prompt row: persona=C1 is latched after its status read after the findMissing sweep — nothing more is called for it (b.jg5 SRJ-502)',
        ])
        // The minute-0 notice only.
        expect(raised.map((n) => n.key)).toEqual(['C1'])
      })
    })
  })

  // b.jg5 SRJ-105: a findMissing sweep on the restart path that is refused
  // (UNAVAILABLE) answers 'transient' instead of 'escalate-dead', so the
  // restart run neither re-probes nor kills nor relaunches the persona. The
  // sweep sites: the dead-session and row-not-interactive escalations after
  // the reconnect's keystrokes, a `working`, `waiting` or prompt row whose
  // `read-pane` answers GONE or finds the row absent
  // (`sweepDeadTmuxChannelWithCause`), and a live prompt row's
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
      /** The pane reads, send-keys and notices the attempts make. */
      paneReads: number
      sendKeys: number
      raised: string[]
      /** The verdict the swept attempt's escalate-dead answer carries when the sweep is not refused (b.jg5 SRJ-611). */
      verdict: DeadEvidenceSource
    }

    const SWEEP_SITES: ReadonlyArray<readonly [string, SweepSite]> = [
      ['dead-session (one ErrTmuxSendKeys)', { opts: () => ({ statusState: 'waiting', sendKeysThrows: errTmuxSendKeys() }), minutes: [0], prefix: 'escalate-dead', paneReads: 0, sendKeys: 1, raised: [], verdict: 'dead-session' }],
      ['row-not-interactive (ErrSpawnNotInteractive)', { opts: () => ({ statusState: 'waiting', sendKeysThrows: errSpawnNotInteractive('send-keys') }), minutes: [0], prefix: 'escalate-dead', paneReads: 0, sendKeys: 1, raised: [], verdict: 'row-not-interactive' }],

      ['prompt-row-tmux-gone (read-pane GONE)', { opts: () => ({ statusState: 'ask_user', paneError: paneGone() }), minutes: [0], prefix: 'escalate-dead', paneReads: 1, sendKeys: 0, raised: [], verdict: 'prompt-row-tmux-gone' }],
      ['a live prompt row deferred 10 min', { opts: () => ({ statusState: 'check_permission', statusAfterSweep: 'missing' }), minutes: [0, PROMPT_ROW_SWEEP_AFTER_MS / 60_000], prefix: 'reconnectSession: prompt row', paneReads: 2, sendKeys: 0, raised: ['C1'], verdict: DEAD_SESSION_CAUSE_ROW_READ_FINISHED }],
    ]

    /** The sweep's refusal line for persona C1 under `prefix`. */
    const sweepRefusedLine = (prefix: string, err: unknown): string =>
      `[slack] ${prefix}: findMissing sweep refused for persona=C1: ${describeAdFailureForLog(err)} — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)`

    /** Run `site`'s attempts for C1 with every sweep failing with `err`, capturing notices and console.error. */
    async function sweepFailing(site: SweepSite, err: Error) {
      const clock = createFakeClock()
      _setNow(clock.now)
      const raised: string[] = []
      setSessionNotifier((key) => { raised.push(key) })
      try {
        const h = makeHarness({ ...site.opts(), findMissingError: err })
        const { result: verdicts, errArgs } = await capturingErrorArgs(async () => {
          const out: AdapterAnswer[] = []
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
      expect(r.readPaneCalls).toHaveLength(site.paneReads)
      expect(r.sendKeysCalls).toHaveLength(site.sendKeys)
      expect([r.killCalls, r.spawnCalls, r.resumeCalls]).toEqual([[], [], []])
      expect(r.raised).toEqual(site.raised)
      expect(r.lines.filter((l) => l.includes('findMissing sweep refused'))).toEqual([sweepRefusedLine(site.prefix, err)])
      expect(r.lines.filter((l) => l.includes('findMissing sweep failed'))).toEqual([])
      if (redacted) expect(r.lines.join('\n')).toContain(REDACTED_SENTINEL_TAIL)
      assertNoLeak({ errArgs: r.errArgs })
    }

    const [TMUX_LABEL, TMUX_BUILD, TMUX_REDACTED] = UNAVAILABLE_FORMS.find(([label]) => label === 'ErrTmuxUnresponsive')!

    test.each(SWEEP_SITES)(`the sweep at %s refused with ${TMUX_LABEL} → 'transient', never 'escalate-dead'; no row read after it, no kill or launch; one described refusal line`, async (_label, site) => {
      await expectRefused(site, TMUX_BUILD('find-missing'), TMUX_REDACTED)
    })

    // b.jg5 SRJ-313: an UNCLASSIFIED sweep failure (ErrInternal) is the same
    // refusal (find-missing is not a read verb).
    test.each(SWEEP_SITES)("b.jg5 SRJ-313: the sweep at %s refused with an UNCLASSIFIED error (ErrInternal) → 'transient', never 'escalate-dead'; no row read after it, no kill or launch; one described refusal line", async (_label, site) => {
      await expectRefused(site, errInternal(`the store could not be read (${sentinelInMessage('sweep-internal')})`), false)
    })

    test.each(SWEEP_SITES)("contrast: the sweep at %s failing with an UNUSABLE NAME ErrInternal (no refusal) → an escalate-dead answer at the swept attempt, one 'proceeding' line and no refusal line", async (_label, site) => {
      const err = errUnusableName()
      const r = await sweepFailing(site, err)

      expect(r.verdicts).toEqual([...site.minutes.slice(0, -1).map((): AdapterAnswer => 'transient'), escalatedWith(site.verdict)])
      expect(r.findMissingCalls).toHaveLength(1)
      expect([r.killCalls, r.spawnCalls, r.resumeCalls]).toEqual([[], [], []])
      expect(r.lines.filter((l) => l.includes('findMissing sweep refused'))).toEqual([])
      expect(r.lines.filter((l) => l.includes('findMissing sweep failed'))).toEqual([
        `[slack] ${site.prefix}: findMissing sweep failed for persona=C1: ${describeAgentDirectorFailure(err)} — proceeding`,
      ])
    })
  })

  // b.jg5 SRJ-502: the adapter's reads are awaited, and a launch outside the
  // restart serializer can latch the persona while they run, after the
  // restart work's own latched check. So the latch is asked again after each
  // awaited step that a further call follows: right after the state read
  // (before any branch on the state), right after a `working` row's
  // `read-pane` and after a `waiting` row's `read-pane` that answered GONE
  // or found the row absent (before the fold or the sweep), right after a
  // prompt row's `read-pane` (before the sweep or the deferral), right
  // before each not-connected notice of the `working`, `waiting` and prompt
  // rows' checks (the `unproven-idle` notice a noted deferral can raise, and
  // the blocked-on-prompt notice), and right before `/mcp reconnect` is
  // typed. A latched persona, or a query that throws (fail safe), gets
  // nothing more done (no pane read, sweep, deferral, notice or typing), one
  // line naming it, and 'transient'. An
  // unlatched one, or no query passed, is reconnected as before. Attempts
  // run on a fake clock passed to `_setNow`.
  describe('b.jg5 SRJ-502: a persona latched by the time /mcp reconnect would be typed', () => {
    let clock: FakeClock
    /** Every not-connected notice the attempts raise (the blocked-on-prompt one among them). */
    let raised: string[]

    beforeEach(() => {
      clock = createFakeClock()
      _setNow(clock.now)
      raised = []
      setSessionNotifier((key) => { raised.push(key) })
    })

    afterEach(() => {
      setSessionNotifier(undefined)
    })

    /** The adapter's latched line for persona C1; `queryFailure` is the failed query's description (none: the query answered). */
    const latchedLine = (queryFailure?: string): string => reconnectLatchedGateLine('C1', queryFailure)

    /** The adapter's latched lines for persona C1 among the lines `errArgs` holds. */
    const latchedLines = (errArgs: unknown[][]): string[] =>
      stringLines(errArgs).filter((l) => l.startsWith('[slack] reconnectSession: persona=C1 is latched'))

    /** The latched line's description of a query that threw `err`. */
    const queryFailed = (err: unknown): string => describeThrownValue(err)

    /** A latch for the adapter: `latched` read at each query, every query's key in `asked`, and each query noted in `events`. */
    function makeLatch(events: string[] = []): { latched: boolean; asked: string[]; isLatched: (key: string) => boolean } {
      const latch = {
        latched: false,
        asked: [] as string[],
        isLatched: (key: string) => {
          latch.asked.push(key)
          events.push('isLatched')
          return latch.latched
        },
      }
      return latch
    }

    test("a latched query that throws is taken as latched (fail safe) → 'transient', nothing typed or swept; one line naming what it threw, described and token-safe", async () => {
      const err = Object.assign(new Error(`latched query broke (${sentinelInMessage('latched-query')})`), { code: 'EIO', note: LEAK_SENTINEL })
      const asked: string[] = []
      const h = makeHarness({ statusState: 'waiting', isLatched: (key) => { asked.push(key); throw err } })

      const { result, errArgs } = await capturingErrorArgs(() => h.adapter('C1'))

      expect(result).toBe('transient')
      expect(asked).toEqual(['C1'])
      expect(h.sendKeysCalls).toEqual([])
      expect(h.findMissingCalls).toHaveLength(0)
      const lines = stringLines(errArgs)
      expect(lines).toEqual([latchedLine(queryFailed(err))])
      expect(lines[0]).toContain(`(the latched query failed: Error code=EIO message="latched query broke (${REDACTED_SENTINEL_TAIL})" at `)
      expect(lines[0]).not.toContain(LEAK_SENTINEL)
      assertNoLeak({ errArgs })
    })

    /** Where a latch can land: a client verb's call. */
    type LatchLanding = 'status' | 'readPane' | 'get' | 'findMissing'

    /**
     * Note in `events` each call the next attempt makes (the client verbs by
     * name); the latch is set inside `landing`'s call, before it resolves.
     */
    function noteCalls(
      h: ReturnType<typeof makeHarness>,
      latch: { latched: boolean },
      events: string[],
      landing: LatchLanding | undefined,
    ): void {
      const stub = h.stub as unknown as Record<string, (params: unknown) => Promise<unknown>>
      for (const name of ['status', 'readPane', 'get', 'findMissing', 'sendKeys']) {
        const real = stub[name]!.bind(h.stub)
        let reads = 0
        stub[name] = async (params) => {
          events.push(name)
          if (name === landing && (name !== 'get' || ++reads === 2)) latch.latched = true
          return real(params)
        }
      }
    }

    /** An attempt's calls up to the query right after its status read, and right after its pane read. */
    const AFTER_READ = ['get', 'status', 'isLatched'] as const
    const AFTER_PANE_READ = [...AFTER_READ, 'readPane', 'isLatched'] as const

    test("a check_permission row whose persona latched during its read-pane notes no deferral: unlatched, the next attempt PROMPT_ROW_SWEEP_AFTER_MS later starts the run of deferrals (its notice, no sweep) rather than sweeping", async () => {
      const latch = makeLatch()
      const h = makeHarness({ statusState: 'check_permission', isLatched: latch.isLatched })
      // The latch lands during the first attempt's read-pane.
      const stub = h.stub as unknown as { readPane: (params: ReadPaneParams) => Promise<ReadPaneResult> }
      const realReadPane = stub.readPane.bind(h.stub)
      stub.readPane = async (params) => {
        if (h.readPaneCalls.length === 0) latch.latched = true
        return realReadPane(params)
      }

      expect(await h.adapter('C1')).toBe('transient')
      expect(latch.asked).toEqual(['C1', 'C1'])
      expect(raised).toEqual([])
      latch.latched = false
      await clock.advance(PROMPT_ROW_SWEEP_AFTER_MS)
      expect(await h.adapter('C1')).toBe('transient')

      expect(h.readPaneCalls).toEqual(probePaneReads(2))
      expect(h.findMissingCalls).toHaveLength(0)
      expect(h.sendKeysCalls).toEqual([])
      expect(raised).toEqual(['C1'])
    })

    // The query right before the prompt row's deferral (the E14 hatch note):
    // the deferral check's sweep from `PROMPT_ROW_SWEEP_AFTER_MS` on is
    // awaited, and a persona latched meanwhile (here only through the
    // adapter's query, so the sweep itself latches no one and the row still
    // reads check_permission after it) gets no deferral: no deferral line, no
    // notice and no escalation.
    test.each([
      ['C1 latched during the sweep', true],
      ['control: C1 not latched', false],
    ] as const)("a check_permission row deferred for PROMPT_ROW_SWEEP_AFTER_MS, its row still check_permission after the sweep: %s → 'transient'; the query asked after the status read, after the read-pane and right before the deferral; the deferral line only when not latched; nothing typed or escalated", async (_label, latched) => {
      const events: string[] = []
      const latch = makeLatch(events)
      const h = makeHarness({ statusState: 'check_permission', isLatched: latch.isLatched })
      expect(await h.adapter('C1')).toBe('transient') // the run of deferrals starts
      await clock.advance(PROMPT_ROW_SWEEP_AFTER_MS)
      events.length = 0
      noteCalls(h, latch, events, latched ? 'findMissing' : undefined)

      const { result, errArgs } = await capturingErrorArgs(() => h.adapter('C1'))

      expect(result).toBe('transient')
      expect(events).toEqual([...AFTER_PANE_READ, 'findMissing', 'status', 'isLatched'])
      expect(latchedLines(errArgs)).toEqual(latched ? [latchedLine()] : [])
      const deferrals = stringLines(errArgs).filter((l) => l.startsWith('[slack] reconnectSession: persona=C1 is check_permission — '))
      expect(deferrals).toHaveLength(latched ? 0 : 1)
      expect(h.findMissingCalls).toHaveLength(1)
      expect(h.sendKeysCalls).toEqual([])
      // The minute-0 notice only (one per episode).
      expect(raised).toEqual(['C1'])
    })

    test("an unlatched persona is reconnected as before: the query is asked for C1 after the status read and again right before /mcp reconnect is typed → 'success'; no latched line", async () => {
      const events: string[] = []
      const latch = makeLatch(events)
      const h = makeHarness({ statusState: 'waiting', isLatched: latch.isLatched })
      noteCalls(h, latch, events, undefined)

      const { result, errArgs } = await capturingErrorArgs(() => h.adapter('C1'))

      expect(result).toBe('success')
      expect(events).toEqual([...AFTER_READ, 'isLatched', 'get', 'get', 'sendKeys', 'get', 'sendKeys'])
      expect(latch.asked).toEqual(['C1', 'C1'])
      expect(h.sendKeysCalls).toEqual([{ instance_id: 'cscb_C1', text: `/mcp reconnect ${MCP_SERVER_NAME}`, no_enter: true }, { instance_id: 'cscb_C1', key: 'Enter' }])
      expect(latchedLines(errArgs)).toEqual([])
    })

    test("no latched query passed: a waiting row is reconnected as before → 'success', with no latched line", async () => {
      // The harness's stub and seams, with the adapter built without the query.
      const h = makeHarness({ statusState: 'waiting' })
      const adapter = _buildReconnectSessionAdapter(undefined)

      const { result, errArgs } = await capturingErrorArgs(() => adapter('C1'))

      expect(result).toBe('success')
      expect(h.sendKeysCalls).toEqual([{ instance_id: 'cscb_C1', text: `/mcp reconnect ${MCP_SERVER_NAME}`, no_enter: true }, { instance_id: 'cscb_C1', key: 'Enter' }])
      expect(stringLines(errArgs)).toEqual([`[slack] reconnecting MCP server "${MCP_SERVER_NAME}": persona=C1`])
    })

    // A pending row asks once (after the status read, before `deferPendingRow`);
    // a working row mid-turn asks after the read, after its read-pane and
    // before its deferral is noted, and defers before typing. Latched, either
    // stops right after the status read.

    // b.jg5 SRJ-805: the store is asked again right before typing, after the
    // awaited pane read, as the latch is: C1, not recorded when its attempt
    // read the row, recorded with no mark (an apply's step 1) while the pane
    // read is out, is an old life: nothing is typed, the live-row sequence
    // starts for it (read from a recording registry, which runs nothing) and
    // the attempt answers transient. The store is loaded over the case's own
    // temp state directory and installed as main() installs it.

  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-115, SRJ-512, SRJ-513: a latching own-row `status` at the
// liveness and reconnect adapters
//
// Both adapters apply the session manager's own-row `status` step to their
// own client call, with the configured-persona query installed as `main()`
// installs it (here: C1 and C2 count). Two answers from C1's row latch C1
// once with refused operation "none", through the installed latch, whose
// notice reaction (bound as `main()` binds it, over a real episodes
// instance) posts once per episode:
//   - UNUSABLE NAME (each fault): "unusable recorded name", the state
//     unreadable, SRJ-1019 (SRJ-512);
//   - its own row reading `pending` with no launch start (absent, `null`, or
//     one that does not parse): "launch start not recorded", the state
//     `pending`, SRJ-1020 (SRJ-513).
// The liveness adapter reads `unknown` (never `dead` or `pending`, so no
// restart run hands the row to `deferPendingRow`), raises no outage flag,
// arms nothing, reports nothing unclassified and starts no
// `tmux-unresponsive` condition, outside an attempt or (UNUSABLE NAME)
// inside a restart run for C1; the reconnect adapter answers 'transient'
// with nothing typed, read, probed or swept, no deferral and no
// escalate-dead. A later read meets the same case and posts nothing more. A
// C1 latched with the other case relatches: the record is replaced, the old
// episode ends and the new one posts once (SRJ-501). Controls: a phrase-less
// `ErrInternal` latches no one and keeps E9's handling; a `pending` row with
// a launch start, or under a key the query does not count, latches no one
// and is read and deferred as E9 left it. C2, beside C1 on the same stub,
// reads a live row and is never latched. Every line and post is leak-checked.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-115, SRJ-512, SRJ-513: a latching own-row status at the liveness and reconnect adapters', () => {
  /** C1's own row `pending` with the launch start `start` (the key left out for `undefined`). */
  const pendingRow = (start: string | null | undefined): StatusResult =>
    cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: start })

  const LIVENESS_SITE = `${LIVENESS_STATUS_SITE.site}: ${LIVENESS_STATUS_SITE.what}`
  const RECONNECT_SITE = `${RECONNECT_STATUS_SITE.site}: ${RECONNECT_STATUS_SITE.what}`
  /** The reconnect adapter's `pending` deferral line for C1 begins with this. */
  const DEFERRAL_HEAD = '[slack] Deferring persona=C1: its row reads pending'

  /** One answer from C1's `status` that latches C1, and what the latch then holds, posts and logs. */
  interface LatchingStatus {
    readonly name: string
    /** C1's `status` answer: thrown when an error, else the result. */
    readonly answer: () => Error | StatusResult
    readonly record: (key: string) => ConflictLatchRecord
    readonly notice: (key: string) => string
    /** The own-row `status` step's line for C1 at `site`'s read of `answer`, with `outcome` (what became of the latch). */
    readonly stepLine: (site: string, answer: unknown, outcome: string) => string
  }

  /** UNUSABLE NAME: one per fault, from the unusable-name table's `status` rows. */
  const UNUSABLE_NAME_STATUSES: readonly LatchingStatus[] = UNUSABLE_NAME_CASE_ROWS.filter((row) => row.site === 'status').map((row) => ({
    name: `UNUSABLE NAME (${row.name})`,
    answer: row.build,
    record: row.record,
    notice: row.notice,
    stepLine: (site, err, outcome) =>
      `[slack] ${site} for persona=C1: ${describeAdFailureForLog(err)} — UNUSABLE NAME: ${outcome}; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)`,
  }))

  /** C1's own row `pending` with no launch start: one per form (b.jg5 SRJ-408). */
  const LAUNCH_START_STATUSES: readonly LatchingStatus[] = NO_LAUNCH_START_FORM_NAMES.map((form) => ({
    name: `own row pending, launch start ${form}`,
    answer: () => pendingRow(NO_LAUNCH_START_FORMS[form]),
    record: launchStartRecord,
    notice: launchStartNotRecordedNoticeText,
    stepLine: (site, _answer, outcome) =>
      `[slack] ${site} for persona=C1: its row read latches the persona (case=${LATCH_CASE_LAUNCH_START_NOT_RECORDED}, state=${AGENT_DIRECTOR_PENDING_STATE}) — ${outcome}; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)`,
  }))

  let dir: string
  let latch: ConflictLatch
  let episodes: PersonaEpisodes
  let unbindNotice: () => void
  /** The keys the configured-persona query counts (default: C1 and C2). */
  let configured: Set<string>
  /** The latch's and the episodes' own lines. */
  let latchLines: string[]
  /** Every notice the episodes' sink received: the key and the body. */
  let posts: Array<{ key: string; text: string }>
  let emissions: Array<{ key: string; text: string }>
  let triggers: Array<{ key: string; kind: string }>
  let unclassified: string[]
  let conditionStarts: string[]
  /** Every not-connected notice the session manager raised. */
  let raised: string[]
  /** Every `console.error` argument list the case captured, for the leak check. */
  let captured: unknown[][]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'server-latching-status-'))
    configured = new Set(['C1', 'C2'])
    latchLines = []
    posts = []
    emissions = []
    triggers = []
    unclassified = []
    conditionStarts = []
    raised = []
    captured = []
    latch = createConflictLatch({ log: (line) => { latchLines.push(line) } })
    episodes = createPersonaEpisodes({
      sink: (key, text) => { posts.push({ key, text }) },
      log: (line) => { latchLines.push(line) },
      clock: createFakeClock(),
    })
    unbindNotice = bindConflictNotice(latch, episodes)
    setConflictLatch(latch)
    setConfiguredPersonaQuery((key) => configured.has(key))
    setSessionNotifier((key) => { raised.push(key) })
  })

  afterEach(() => {
    unbindNotice()
    setConflictLatch(undefined)
    _resetConfiguredPersonaQuery()
    setSessionNotifier(undefined)
    resetClientForTests()
    _resetOutageState()
    _resetFindMissingMemo()
    _resetNotConnectedEpisodes()
    rmSync(dir, { recursive: true, force: true })
    assertNoLeak({ captured, latchLines, posts, emissions })
  })

  /**
   * One stub over the outage state and the client seam: C1's `status`
   * answers `c1Status` (the same value each call: thrown when an error),
   * every other persona's row reads `waiting`; every send-keys succeeds.
   * Spies on every sink.
   */
  function install(c1Status: Error | StatusResult): StubCallLog {
    const log = makeStubCallLog()
    const stub = makeStubClient({
      readPaneResults: [cannedReadPaneResult(IDLE_PANE)],
      ...log,
      getFn: ({ instance_id }) => cannedGetResult({ instance_id }),
      statusFn: ({ instance_id }) =>
        instance_id === personaInstanceId('C1') ? c1Status : cannedStatusResult({ state: 'waiting' }),
      sendKeysResult: {},
    })
    _resetOutageState()
    initOutageState({
      notify: (key, text) => { emissions.push({ key, text }) },
      getClient: () => stub as unknown as Client,
      triggerSink: { arm: (key, cause) => { triggers.push({ key, kind: cause.kind }); return true } },
      unclassifiedSink: { report: (key) => { unclassified.push(key) } },
      conditionSink: { start: (key) => { conditionStarts.push(key) }, end: () => {} },
    })
    setClientForTests(stub as unknown as Client)
    return log
  }

  /** Run `fn`, keeping its `console.error` argument lists for the case and the leak check. */
  async function run<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
    const { result, errArgs } = await capturingErrorArgs(fn)
    captured.push(...errArgs)
    return { result, lines: stringLines(errArgs) }
  }

  /** The liveness adapter over C1 and C2. */
  const livenessAdapter = () => {
    const config = makeStandInPersonaConfig({ C1: {}, C2: {} }, dir)
    return _buildIsSessionAliveAdapter(() => config)
  }
  /** The reconnect adapter with the installed latch's latched query, as `main()` builds it. */
  const reconnectAdapter = () => _buildReconnectSessionAdapter(undefined, (key) => latch.isLatched(key))

  /** C1 latched once with `c`'s record and its one post; C2 not latched; nothing flagged, armed, reported or started. */
  function expectLatchedOnce(c: LatchingStatus): void {
    expect(latch.record('C1')).toEqual(c.record('C1'))
    expect(latchLines.filter((line) => line.startsWith('[slack] conflict-latch: persona=C1 latched'))).toHaveLength(1)
    expect(posts).toEqual([{ key: 'C1', text: c.notice('C1') }])
    expect(latch.isLatched('C2')).toBe(false)
    expect(getOutageFlags('C1').size).toBe(0)
    expect(emissions).toEqual([])
    expect(triggers).toEqual([])
    expect(unclassified).toEqual([])
    expect(conditionStarts).toEqual([])
  }

  const CONTEXTS = [
    ['outside any attempt (the health tick, the lost-message read)', false],
    ['inside a restart run for C1 (a recovery attempt)', true],
  ] as const

  test.each([
    ...UNUSABLE_NAME_STATUSES.flatMap((c) => CONTEXTS.map(([context, inside]) => [c.name, context, c, inside] as const)),
    ...LAUNCH_START_STATUSES.map((c) => [c.name, CONTEXTS[0][0], c, CONTEXTS[0][1]] as const),
  ])(
    'liveness adapter, %s, %s: three probes of C1 each read unknown, never pending; C1 latched once and its notice posted once; no deferral, flag, arm, unclassified report or condition; one step line per probe; C2 beside it reads live, unlatched',
    async (_name, _context, c, inside) => {
      const answer = c.answer()
      const log = install(answer)
      const adapter = livenessAdapter()
      const probe = (key: string) => run(() => (inside ? runInAttempt(key, 'recovery', () => adapter(key)) : adapter(key)))

      const first = await probe('C1')
      const other = await probe('C2')
      const later = [await probe('C1'), await probe('C1')]

      expect([first, ...later].map((p) => p.result)).toEqual([LIVENESS_READING_UNKNOWN, LIVENESS_READING_UNKNOWN, LIVENESS_READING_UNKNOWN])
      expect(other.result).toEqual(LIVENESS_READING_LIVE)
      expect(log.statusCalls.map((c) => c.instance_id)).toEqual(['cscb_C1', 'cscb_C2', 'cscb_C1', 'cscb_C1'])
      expect(stubCallCount(log)).toBe(4)
      expectLatchedOnce(c)
      expect(first.lines).toEqual([c.stepLine(LIVENESS_SITE, answer, 'the persona latched')])
      for (const p of later) {
        expect(p.lines).toEqual([c.stepLine(LIVENESS_SITE, answer, 'the persona was already latched with this case')])
      }
      expect(other.lines).toEqual([])
      expect(tmuxTouchingCallsIn(log)).toEqual([])
    },
  )

  test.each([...UNUSABLE_NAME_STATUSES, ...LAUNCH_START_STATUSES].map((c) => [c.name, c] as const))(
    "reconnect adapter, %s: C1's state read latches C1 once and posts its notice once → 'transient' with nothing typed, read, probed or swept, no deferral and no escalate-dead; a second attempt posts nothing more; C2 beside it is reconnected as before",
    async (_name, c) => {
      const answer = c.answer()
      const log = install(answer)
      const adapter = reconnectAdapter()

      const c1 = await run(() => runInAttempt('C1', 'recovery', () => adapter('C1')))
      const again = await run(() => runInAttempt('C1', 'recovery', () => adapter('C1')))

      expect([c1.result, again.result]).toEqual(['transient', 'transient'])
      expect(log.statusCalls.map((c) => c.instance_id)).toEqual(['cscb_C1'])
      expect(log.getCalls.map((c) => c.instance_id)).toEqual(['cscb_C1'])
      expect(stubCallCount(log)).toBe(2)
      expect(tmuxTouchingCallsIn(log)).toEqual([])
      expectLatchedOnce(c)
      expect(c1.lines).toEqual([c.stepLine(RECONNECT_SITE, answer, 'the persona latched')])
      expect(again.lines).toEqual([])
      expect(raised).toEqual([])

      // C2's waiting row: `/mcp reconnect` is typed into C2 alone.
      const c2 = await run(() => runInAttempt('C2', 'recovery', () => adapter('C2')))

      expect(c2.result).toBe('success')
      expect(log.sendKeysCalls.map((c) => c.instance_id)).toEqual(['cscb_C2', 'cscb_C2'])
      expect(latch.isLatched('C2')).toBe(false)
      expect(posts).toHaveLength(1)
    },
  )

  // b.jg5 SRJ-501, SRJ-512, SRJ-513: C1 already latched with another case
  // relatches with the answer's case: the record is replaced whole, the old
  // case's episode ends (silently), the new case's opens and posts once, and
  // the step logs the relatched outcome; a later read meets the new case and
  // posts nothing more.
  const conflict = conflictForPersona('C1')
  const RELATCHES: ReadonlyArray<readonly [string, () => void, () => string, LatchingStatus]> = [
    [
      'latched with a CONFLICT (leftover), then its own row reads pending with no launch start',
      () => { latch.setFromConflict('C1', conflict, { refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: LATCH_ROW_STATE_NO_ROW }) },
      () => conflictNoticeForPersona('C1', conflict).text,
      LAUNCH_START_STATUSES[0]!,
    ],
    [
      'latched with "launch start not recorded", then its status answers UNUSABLE NAME',
      () => { latch.setLaunchStartNotRecorded('C1', latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE)) },
      () => launchStartNotRecordedNoticeText('C1'),
      UNUSABLE_NAME_STATUSES[0]!,
    ],
  ]
  const RELATCH_ADAPTERS = [
    ['liveness adapter', LIVENESS_SITE, livenessAdapter, LIVENESS_READING_UNKNOWN],
    ['reconnect adapter', RECONNECT_SITE, reconnectAdapter, 'transient'],
  ] as const

  test.each(RELATCHES.flatMap(([label, preLatch, preNotice, c]) => RELATCH_ADAPTERS.map(([adapterName, site, build, verdict]) => [adapterName, label, preLatch, preNotice, c, site, build, verdict] as const)))(
    '%s, C1 %s: the read relatches C1 (record replaced, old episode ended) and posts the new notice once; the step logs the relatched line; nothing typed',
    async (_adapterName, _label, preLatch, preNotice, c, site, build, verdict) => {
      const answer = c.answer()
      const log = install(answer)
      preLatch()
      const oldKind = latchNoticeEpisodeKindOf(latch.record('C1')!.latchCase)
      const newKind = latchNoticeEpisodeKindOf(c.record('C1').latchCase)
      expect(posts).toEqual([{ key: 'C1', text: preNotice() }])
      expect(episodes.isOpen('C1', oldKind)).toBe(true)
      const adapter = build() as (key: string) => Promise<unknown>

      const first = await run(() => runInAttempt('C1', 'recovery', () => adapter('C1')))
      const again = await run(() => runInAttempt('C1', 'recovery', () => adapter('C1')))

      expect([first.result, again.result]).toEqual([verdict, verdict])
      if (_adapterName === 'reconnect adapter') {
        // An existing latch now stops the reconnect before any AD read.
        expect(latch.record('C1')?.latchCase).not.toBe(c.record('C1').latchCase)
        expect(episodes.isOpen('C1', oldKind)).toBe(true)
        expect(posts).toEqual([{ key: 'C1', text: preNotice() }])
        expect([first.lines, again.lines]).toEqual([[], []])
        expect(stubCallCount(log)).toBe(0)
        expect(raised).toEqual([])
        return
      }
      expect(latch.record('C1')).toEqual(c.record('C1'))
      expect(episodes.isOpen('C1', oldKind)).toBe(false)
      expect(episodes.isOpen('C1', newKind)).toBe(true)
      expect(posts).toEqual([{ key: 'C1', text: preNotice() }, { key: 'C1', text: c.notice('C1') }])
      expect(latchLines.filter((line) => line.startsWith('[slack] conflict-latch: persona=C1 relatched'))).toHaveLength(1)
      expect(first.lines).toEqual([c.stepLine(site, answer, 'the persona relatched')])
      expect(again.lines).toEqual([c.stepLine(site, answer, 'the persona was already latched with this case')])
      expect(log.statusCalls.map((s) => s.instance_id)).toEqual(['cscb_C1', 'cscb_C1'])
      expect(stubCallCount(log)).toBe(2)
      expect(tmuxTouchingCallsIn(log)).toEqual([])
      expect(raised).toEqual([])
    },
  )

  // Control (b.jg5 SRJ-313): an `ErrInternal` without the phrase is not
  // UNUSABLE NAME. It latches no one and posts nothing: the liveness adapter
  // keeps E9's `unknown` reading and its one catch-all line; the reconnect
  // adapter keeps b.f2b's 'transient' with nothing typed.
  test('control: a phrase-less ErrInternal from C1\'s status latches no one and posts nothing: the liveness adapter reads unknown with its one status-error line; the reconnect adapter answers transient with nothing typed', async () => {
    const log = install(errInternal())

    const alive = await run(() => livenessAdapter()('C1'))
    const reconnect = await run(() => runInAttempt('C1', 'recovery', () => reconnectAdapter()('C1')))

    expect(alive.result).toEqual(LIVENESS_READING_UNKNOWN)
    expect(alive.lines).toHaveLength(1)
    expect(alive.lines[0]).toStartWith('[slack] isSessionAlive: status error for persona=C1: ')
    expect(reconnect.result).toBe('transient')
    expect(log.sendKeysCalls).toEqual([])
    expect([...alive.lines, ...reconnect.lines].filter((line) => line.includes('UNUSABLE NAME'))).toEqual([])
    expect(latch.isLatched('C1')).toBe(false)
    expect(latchLines).toEqual([])
    expect(posts).toEqual([])
  })

  // Controls (b.jg5 SRJ-408, SRJ-513): a valid launch start, or a key the
  // configured-persona query does not count, latches no one and posts
  // nothing: the liveness adapter reads `pending` (carrying the launch start
  // raw) and the reconnect adapter defers as E9 left it, with its one line.
  test.each<[string, string | null | undefined, boolean, LivenessReading, string]>([
    ...LAUNCH_STARTS.map((start) => [`configured, launch start ${start}`, start, true, { ...LIVENESS_READING_PENDING, launchStartedAt: start }, ` (launch started ${start})`] as [string, string, boolean, LivenessReading, string]),
    ['a key no configured persona uses, no launch start', NO_LAUNCH_START_FORMS.absent, false, LIVENESS_READING_PENDING, ''],
    ['a key no configured persona uses, a null launch start', NO_LAUNCH_START_FORMS.null, false, LIVENESS_READING_PENDING, ''],
  ])("control, %s: no latch, no post; the liveness adapter reads pending and the reconnect adapter answers 'pending' with its one deferral line, nothing typed", async (_label, launchStartedAt, isConfigured, reading, launchPart) => {
    if (!isConfigured) configured.delete('C1')
    const log = install(pendingRow(launchStartedAt))

    const alive = await run(() => livenessAdapter()('C1'))
    const reconnect = await run(() => runInAttempt('C1', 'recovery', () => reconnectAdapter()('C1')))

    expect(alive.result).toEqual(reading)
    expect(alive.lines).toEqual([])
    expect(reconnect.result).toBe('pending')
    expect(reconnect.lines).toHaveLength(1)
    expect(reconnect.lines[0]).toStartWith(`${DEFERRAL_HEAD}${launchPart} — `)
    expect(log.sendKeysCalls).toEqual([])
    expect(latch.isLatched('C1')).toBe(false)
    expect(latchLines).toEqual([])
    expect(posts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-704, SRJ-1016 (E20 T3): the liveness and reconnect adapters'
// own-row step ends the kill-failure episode
//
// The episode runs from the ordinary alert until P's own row reads `ended` or
// `missing`, or is gone (`ErrSpawnNotFound`). Both adapters read the row
// through the session manager's own-row `status` step, so either one's read
// of `ended`, `missing` or `ErrSpawnNotFound` ends P's open episode silently
// (one ended line, no post); a live reading, any other failed read and a
// reading of another persona's row leave it open. The kill-failure alerts are
// built over a recording episodes instance and installed in the session
// manager (`setKillFailureAlerts`), as main() does; C1's episode is opened by
// raising the ordinary version for it. The shared reads themselves are
// covered in tests/session-manager.test.ts.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-704, SRJ-1016: the liveness and reconnect adapters\' own-row step ends the kill-failure episode', () => {
  let dir: string
  let alerts: KillFailureAlerts
  /** The episodes' posts and the alerts' lines. */
  let posts: Array<{ key: string; text: string }>
  let lines: string[]
  let captured: unknown[][]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'server-kill-failure-episode-'))
    posts = []
    lines = []
    captured = []
    const episodes = createPersonaEpisodes({ sink: (key, text) => { posts.push({ key, text }) }, log: (line) => { lines.push(line) }, clock: createFakeClock() })
    alerts = createKillFailureAlerts({ episodes, log: (line) => { lines.push(line) } })
    setKillFailureAlerts(alerts)
    setConfiguredPersonaQuery((key) => key === 'C1' || key === 'C2')
    // C1's ordinary alert opens its episode.
    const description = killFailedDescriptionOf(errTmuxKillFailed(sentinelInMessage('server-episode')))!
    expect(alerts.raise({ key: 'C1', decision: { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: description }, latched: false, context: KILL_FAILURE_CONTEXT_RECOVERY })).toBe('posted')
  })

  afterEach(() => {
    setKillFailureAlerts(undefined)
    _resetConfiguredPersonaQuery()
    resetClientForTests()
    _resetOutageState()
    _resetFindMissingMemo()
    _resetNotConnectedEpisodes()
    setSessionNotifier(undefined)
    rmSync(dir, { recursive: true, force: true })
    assertNoLeak({ captured, posts, lines })
  })

  /** A stub whose `status` answers `answer` for `key`'s row (thrown when an error) and `waiting` for every other row; every send-keys succeeds. */
  function install(key: string, answer: Error | StatusResult): void {
    const stub = makeStubClient({
      readPaneResults: [cannedReadPaneResult(IDLE_PANE)],
      getFn: ({ instance_id }) => cannedGetResult({ instance_id, ...(instance_id === personaInstanceId(key) ? answer : {}) }),
      statusFn: ({ instance_id }) => (instance_id === personaInstanceId(key) ? answer : cannedStatusResult({ state: 'waiting' })),
      sendKeysResult: {},
    })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    setSessionNotifier(() => {})
  }

  /** The two adapters' reads of `key`'s row, each outside any attempt. */
  const ADAPTERS: ReadonlyArray<readonly [string, (key: string) => Promise<unknown>]> = [
    ['the liveness adapter', (key) => {
      const config = makeStandInPersonaConfig({ C1: {}, C2: {} }, dir)
      return _buildIsSessionAliveAdapter(() => config)(key)
    }],
    ['the reconnect adapter', (key) => _buildReconnectSessionAdapter(undefined, () => false)(key)],
  ]

  async function read(adapter: (key: string) => Promise<unknown>, key: string): Promise<void> {
    const { errArgs } = await capturingErrorArgs(() => adapter(key))
    captured.push(...errArgs)
  }

  test.each(ADAPTERS.flatMap(([name, adapter]) => [
    [name, 'ended', adapter, () => cannedStatusResult({ state: 'ended' }), KILL_FAILURE_END_ROW_FINISHED],
    [name, 'missing', adapter, () => cannedStatusResult({ state: 'missing' }), KILL_FAILURE_END_ROW_FINISHED],
    [name, 'ErrSpawnNotFound', adapter, () => errSpawnNotFound(), KILL_FAILURE_END_ROW_GONE],
  ] as const))('%s reading C1\'s row %s ends C1\'s episode silently: one ended line, nothing posted', async (_name, _answer, adapter, answer, reason) => {
    install('C1', answer())

    await read(adapter, 'C1')

    expect(alerts.isOpen('C1')).toBe(false)
    expect(posts).toHaveLength(1)
    expect(lines.at(-1)).toBe(killFailureEndedLine('C1', reason))
    expect(lines.filter((line) => line.includes(' ended — '))).toHaveLength(1)
  })

  test.each(ADAPTERS.flatMap(([name, adapter]) => [
    [name, 'a live reading (waiting)', adapter, () => cannedStatusResult({ state: 'waiting' })],
    [name, 'a failed read (ErrTmuxUnresponsive)', adapter, () => errTmuxUnresponsive('status')],
  ] as const))('%s with %s for C1 leaves C1\'s episode open', async (_name, _label, adapter, answer) => {
    install('C1', answer())

    await read(adapter, 'C1')

    expect(alerts.isOpen('C1')).toBe(true)
    expect(lines.filter((line) => line.includes(' ended — '))).toEqual([])
  })

  test.each(ADAPTERS.map(([name, adapter]) => [name, adapter] as const))('%s reading C2\'s row ended leaves C1\'s episode open', async (_name, adapter) => {
    install('C2', cannedStatusResult({ state: 'ended' }))

    await read(adapter, 'C2')

    expect(alerts.isOpen('C1')).toBe(true)
    expect(lines.filter((line) => line.includes(' ended — '))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-1016, SRJ-1017: the liveness and reconnect adapters' own-row step
// ends the stuck-launch episode
//
// The episode runs from the first stuck-launch post until P's own row reads
// live out of `pending` (`waiting`, `working`, `ask_user` or
// `check_permission`), P latches or P is torn down. Both adapters read the row
// through the session manager's own-row `status` step, so either one's live
// reading out of `pending` ends P's open episode silently (one ended line on
// the server log, nothing posted); a `pending` reading keeps it, and a read of
// one persona's row never ends another's. The episodes are a real
// `createPersonaEpisodes` on a fake clock, installed in the session manager
// (`setStuckLaunchEpisodes`) as main() installs its notice episodes; C1's and
// C2's episodes are opened by posting the held text for each through the real
// poster. Which reads end it at the shared reads themselves is covered in
// tests/session-manager.test.ts.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-1016, SRJ-1017: the liveness and reconnect adapters\' own-row step ends the stuck-launch episode on a live reading out of pending', () => {
  let dir: string
  let episodes: PersonaEpisodes
  /** The episodes' posts. */
  let posts: Array<{ key: string; text: string }>
  /** The episodes' and the poster's lines. */
  let lines: string[]
  let captured: unknown[][]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'server-stuck-launch-episode-'))
    posts = []
    lines = []
    captured = []
    episodes = createPersonaEpisodes({ sink: (key, text) => { posts.push({ key, text }) }, log: (line) => { lines.push(line) }, clock: createFakeClock() })
    setStuckLaunchEpisodes(episodes)
    setConfiguredPersonaQuery((key) => key === 'C1' || key === 'C2')
    const poster = { episodes, tmuxUnavailableRaised: () => false, log: (line: string) => { lines.push(line) } }
    for (const key of ['C1', 'C2']) expect(postStuckLaunchHeld(poster, key, SAMPLE_LAUNCH_START_WHOLE, false)).toBe(STUCK_LAUNCH_POSTED)
    expect(posts.map((post) => post.key)).toEqual(['C1', 'C2'])
  })

  afterEach(() => {
    setStuckLaunchEpisodes(undefined)
    episodes.close()
    _resetConfiguredPersonaQuery()
    resetClientForTests()
    _resetOutageState()
    _resetFindMissingMemo()
    _resetNotConnectedEpisodes()
    setSessionNotifier(undefined)
    rmSync(dir, { recursive: true, force: true })
    assertNoLeak({ captured, posts, lines })
  })

  /** A stub whose `status` answers `answer` for `key`'s row and `waiting` for every other row; every send-keys succeeds. */
  function install(key: string, answer: StatusResult): void {
    const stub = makeStubClient({
      readPaneResults: [cannedReadPaneResult(IDLE_PANE)],
      getFn: ({ instance_id }) => cannedGetResult({ instance_id, ...(instance_id === personaInstanceId(key) ? answer : {}) }),
      statusFn: ({ instance_id }) => (instance_id === personaInstanceId(key) ? answer : cannedStatusResult({ state: 'waiting' })),
      sendKeysResult: {},
    })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    setSessionNotifier(() => {})
  }

  /** The two adapters' reads of `key`'s row, each outside any attempt. */
  const ADAPTERS: ReadonlyArray<readonly [string, (key: string) => Promise<unknown>]> = [
    ['the liveness adapter', (key) => {
      const config = makeStandInPersonaConfig({ C1: {}, C2: {} }, dir)
      return _buildIsSessionAliveAdapter(() => config)(key)
    }],
    ['the reconnect adapter', (key) => _buildReconnectSessionAdapter(undefined, () => false)(key)],
  ]

  async function read(adapter: (key: string) => Promise<unknown>, key: string): Promise<void> {
    const { errArgs } = await capturingErrorArgs(() => adapter(key))
    captured.push(...errArgs)
  }

  /** The server log's stuck-launch episode-ended lines for `key`. */
  function endedLines(key: string): unknown[] {
    return captured.map((args) => args[0]).filter((line) => typeof line === 'string' && line.startsWith(stuckLaunchEpisodeEndedLine(key, '')))
  }

  const isOpen = (key: string) => episodes.isOpen(key, PERSONA_EPISODE_KIND_STUCK_LAUNCH)

  test.each(ADAPTERS.flatMap(([name, adapter]) => LIVE_NOT_PENDING_STATES.map((state) => [name, state, adapter] as const)))('%s reading C1\'s row %s ends C1\'s episode silently, one ended line and nothing posted; C2\'s episode stays open', async (_name, state, adapter) => {
    install('C1', cannedStatusResult({ state }))

    await read(adapter, 'C1')

    expect([isOpen('C1'), isOpen('C2')]).toEqual([false, true])
    expect(endedLines('C1')).toEqual([stuckLaunchEpisodeEndedLine('C1', stuckLaunchEndRowLiveReason(state))])
    expect(endedLines('C2')).toEqual([])
    expect(posts).toHaveLength(2)
  })

  test.each(ADAPTERS.map(([name, adapter]) => [name, adapter] as const))('%s reading C1\'s row pending (a launch start recorded) leaves C1\'s episode open', async (_name, adapter) => {
    install('C1', cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_WHOLE }))

    await read(adapter, 'C1')

    expect([isOpen('C1'), isOpen('C2')]).toEqual([true, true])
    expect([endedLines('C1'), endedLines('C2')]).toEqual([[], []])
    expect(posts).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-807 at SRJ-115's adapter sites: the liveness and reconnect
// adapters clear a retired key's entry through their own-row step
//
// Both adapters apply the session manager's own-row `status` step after their
// own call, so C1's own row read `waiting`, `working`, `ask_user` or
// `check_permission` while C1 is recorded with its mark set clears C1's entry
// from the retired-key record, durably, with the store's one line naming the
// adapter's read; the reading (the health tick's, the restart path's, the
// re-probe's and the lost-message read's) and the reconnect's answer are the
// ones the same row gives today. `pending`, `ended`, `missing`, a failed read
// and `ErrSpawnNotFound` clear nothing and keep their readings. The store is
// loaded over the case's own `mkdtempSync` state directory, its record
// seeded with C1 and C2 both marked (so C2's entry shows a read of C1's row
// clears no other key's), and installed with `setRetiredKeyStore` as main()
// installs it, removed in `afterEach`. The lost-message read through the real
// routing is tests/inbound-recovery-drop-branch.test.ts's; the shared reads
// themselves are tests/session-manager.test.ts's.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-807, SRJ-115: the liveness and reconnect adapters clear a retired key\'s entry on its own row read live other than pending with its mark set, and read and answer as before', () => {
  const SEED: RetiredKeySeed = { cause: RETIRED_KEY_CAUSE_REMOVED, mark: true }
  const LIVENESS_SITE = LIVENESS_STATUS_SITE
  const RECONNECT_SITE = RECONNECT_STATUS_SITE

  let dir: string
  let store: RetiredKeyStore
  /** The record file's bytes as seeded. */
  let seeded: Buffer
  /** The store's own lines. */
  let storeLines: string[]
  let captured: unknown[][]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'server-retired-clear-'))
    storeLines = []
    captured = []
    writeRetiredKeysRecord(dir, { C1: SEED, C2: SEED })
    seeded = readFileSync(retiredKeysPath(dir))
    const loaded = loadRetiredKeyStore(dir, { log: (line) => { storeLines.push(line) } })
    if (loaded.kind !== 'loaded') throw new Error(loaded.message)
    store = loaded.store
    setRetiredKeyStore(store)
    setConfiguredPersonaQuery((key) => key === 'C1' || key === 'C2')
  })

  afterEach(() => {
    _resetRetiredKeyStore()
    _resetConfiguredPersonaQuery()
    resetClientForTests()
    _resetOutageState()
    _resetFindMissingMemo()
    _resetNotConnectedEpisodes()
    setSessionNotifier(undefined)
    rmSync(dir, { recursive: true, force: true })
    assertNoLeak({ captured, storeLines })
  })

  /** A stub whose `status` answers `answer` for C1's row (thrown when an error) and `waiting` for every other row; every send-keys succeeds. */
  function install(answer: Error | StatusResult): StubCallLog {
    const log = makeStubCallLog()
    const stub = makeStubClient({
      readPaneResults: [cannedReadPaneResult(IDLE_PANE)],
      ...log,
      getFn: ({ instance_id }) => instance_id === personaInstanceId('C1') && answer instanceof Error ? answer : cannedGetResult({ instance_id, ...(instance_id === personaInstanceId('C1') ? answer : {}) }),
      statusFn: ({ instance_id }) => (instance_id === personaInstanceId('C1') ? answer : cannedStatusResult({ state: 'waiting' })),
      sendKeysResult: {},
    })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    setSessionNotifier(() => {})
    return log
  }

  /** `fn`'s result, its `console.error` lines kept for the leak check. */
  async function run<T>(fn: () => Promise<T>): Promise<T> {
    const { result, errArgs } = await capturingErrorArgs(fn)
    captured.push(...errArgs)
    return result
  }

  const livenessRead = (key: string) => {
    const config = makeStandInPersonaConfig({ C1: {}, C2: {} }, dir)
    return run(() => _buildIsSessionAliveAdapter(() => config)(key))
  }
  const reconnectRead = (key: string) => run(() => _buildReconnectSessionAdapter(undefined, () => false)(key))

  /** C1's entry was cleared once, at `site`'s read of `state`: the file holds C2's alone, C2 still marked, one line. */
  function expectC1Cleared(state: string, site: { site: string; what: string }): void {
    expect(readRetiredKeysRecord(dir)).toEqual(retiredKeysRecordOf({ C2: SEED }))
    expect([store.isRecorded('C1'), store.isMarked('C2')]).toEqual([false, true])
    expect(retiredKeyLinesIn(storeLines)).toEqual([retiredEntryClearedLine(store.path, 'C1', state, site)])
  }

  /** Nothing cleared: the file as seeded, no line, C1 still marked. */
  function expectNothingCleared(): void {
    expect(readFileSync(store.path).equals(seeded)).toBe(true)
    expect(storeLines).toEqual([])
    expect(store.isMarked('C1')).toBe(true)
  }

  test.each([...RETIRED_ENTRY_CLEARING_STATES].map((state) => [state] as const))('liveness adapter, C1\'s row reading %s with C1\'s mark set: reads live, and C1\'s entry is cleared with one line naming the read; C2\'s entry stays', async (state) => {
    const log = install(cannedStatusResult({ state }))

    expect(await livenessRead('C1')).toEqual(LIVENESS_READING_LIVE)

    expect(log.statusCalls.map((c) => c.instance_id)).toEqual(['cscb_C1'])
    expect(stubCallCount(log)).toBe(1)
    expectC1Cleared(state, LIVENESS_SITE)
  })

  test.each<[string, () => Error | StatusResult, LivenessReading]>([
    ['pending (a launch start recorded)', () => cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_WHOLE }), { ...LIVENESS_READING_PENDING, launchStartedAt: SAMPLE_LAUNCH_START_WHOLE }],
    ['ended', () => cannedStatusResult({ state: 'ended' }), LIVENESS_READING_DEAD_ENDED],
    ['missing', () => cannedStatusResult({ state: 'missing' }), LIVENESS_READING_DEAD_MISSING],
    ['a failed read (ErrTmuxUnresponsive)', () => errTmuxUnresponsive('status'), LIVENESS_READING_UNKNOWN],
    ['ErrSpawnNotFound', () => errSpawnNotFound(), LIVENESS_READING_DEAD_NO_ROW],
  ])('liveness adapter, C1\'s status answering %s with C1\'s mark set: the reading is unchanged and nothing is cleared', async (_label, answer, reading) => {
    install(answer())

    expect(await livenessRead('C1')).toEqual(reading)

    expectNothingCleared()
  })

  test('reconnect adapter, C1\'s row reading waiting with C1\'s mark set: success, /mcp reconnect typed into C1 once as today, and C1\'s entry is cleared with one line naming the read; C2\'s entry stays', async () => {
    const log = install(cannedStatusResult({ state: 'waiting' }))

    expect(await reconnectRead('C1')).toBe('success')

    expect(log.sendKeysCalls.map((c) => c.instance_id)).toEqual(['cscb_C1', 'cscb_C1'])
    expectC1Cleared('waiting', { site: 'tag upgrade', what: 'fresh get' })
  })

  test.each<[string, () => Error | StatusResult, AdapterAnswer]>([
    ['pending (a launch start recorded)', () => cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_WHOLE }), 'pending'],
    ['a failed read (ErrTmuxUnresponsive)', () => errTmuxUnresponsive('status'), 'transient'],
  ])('reconnect adapter, C1\'s status answering %s with C1\'s mark set: the answer is unchanged, nothing is typed and nothing is cleared', async (_label, answer, expected) => {
    const log = install(answer())

    expect(await reconnectRead('C1')).toEqual(expected)

    expect(log.sendKeysCalls).toEqual([])
    expectNothingCleared()
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-809 at SRJ-115's adapter sites: the liveness and reconnect
// adapters' own-row step ends an old-life hold on the persona's own row
//
// A same-key old life's row is P's own row, so P's liveness and reconnect
// adapters read it; their reads are "a read by any call". Both apply the
// session manager's own-row `status` step after their own call, so C1's own
// row read `ended` or `missing`, or answering `ErrSpawnNotFound`, ends the
// hold on `cscb_C1`, with the hold set's one end line naming the adapter's
// read, and leaves C2's hold alone; a live reading (`waiting`, `pending`
// with a launch start) or a failed read keeps it. The hold set is built over
// a recording log and installed with `setOldLifeHolds` as main() installs
// it, removed in `afterEach`; each hold is begun as apply step 1 begins it.
// With no set installed the readings and answers are the ones the same rows
// give today (every other adapter case in this file). The shared reads
// themselves are tests/session-manager.test.ts's.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809, SRJ-115: the liveness and reconnect adapters\' own-row step ends an old-life hold on the persona\'s own row read ended, missing or gone, and keeps it on a live or failed read', () => {
  let dir: string
  let config: PersonaConfig
  let holds: OldLifeHoldSet
  /** The hold set's lines. */
  let holdLines: string[]
  let captured: unknown[][]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'server-old-life-hold-'))
    holdLines = []
    captured = []
    config = makeStandInPersonaConfig({ C1: {}, C2: {} }, dir)
    holds = createOldLifeHoldSet({ log: (line) => { holdLines.push(line) } })
    setOldLifeHolds(holds)
    setConfiguredPersonaQuery((key) => key === 'C1' || key === 'C2')
    for (const persona of config.personas) {
      holds.begin({ instanceId: personaInstanceId(persona.key), oldKey: persona.key, directory: persona.working_directory, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    }
  })

  afterEach(() => {
    _resetOldLifeHolds()
    _resetConfiguredPersonaQuery()
    resetClientForTests()
    _resetOutageState()
    _resetFindMissingMemo()
    _resetNotConnectedEpisodes()
    setSessionNotifier(undefined)
    rmSync(dir, { recursive: true, force: true })
    assertNoLeak({ captured, holdLines })
  })

  /** A stub whose `status` answers `answer` for C1's row (thrown when an error) and `waiting` for every other row; every send-keys succeeds. */
  function install(answer: Error | StatusResult): void {
    const stub = makeStubClient({
      readPaneResults: [cannedReadPaneResult(IDLE_PANE)],
      getFn: ({ instance_id }) => instance_id === personaInstanceId('C1') && answer instanceof Error ? answer : cannedGetResult({ instance_id, cwd: config.personas.find((p) => personaInstanceId(p.key) === instance_id)?.working_directory, ...(instance_id === personaInstanceId('C1') ? answer : {}) }),
      statusFn: ({ instance_id }) => (instance_id === personaInstanceId('C1') ? answer : cannedStatusResult({ state: 'waiting' })),
      sendKeysResult: {},
    })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    setSessionNotifier(() => {})
  }

  /** The two adapters, each with the read name its own-row step gives, reading `key`'s row outside any attempt. */
  const ADAPTERS: ReadonlyArray<readonly [string, string, (key: string) => Promise<unknown>]> = [
    ['the liveness adapter', `${LIVENESS_STATUS_SITE.site}: ${LIVENESS_STATUS_SITE.what}`, (key) => _buildIsSessionAliveAdapter(() => config)(key)],
    ['the reconnect adapter', 'tag upgrade: fresh get', (key) => _buildReconnectSessionAdapter(undefined, () => false)(key)],
  ]

  async function read(adapter: (key: string) => Promise<unknown>, key: string): Promise<void> {
    const { errArgs } = await capturingErrorArgs(() => adapter(key))
    captured.push(...errArgs)
  }

  /** The holds' end lines. */
  const endLines = (): string[] => holdLines.filter((line) => line.startsWith(`${OLD_LIFE_HOLD_LOG_PREFIX} ended on `))

  test.each(ADAPTERS.flatMap(([name, readName, adapter]) => [
    [name, 'ended', adapter, () => cannedStatusResult({ state: 'ended' }), OLD_LIFE_HOLD_END_READ_ENDED, readName],
    [name, 'missing', adapter, () => cannedStatusResult({ state: 'missing' }), OLD_LIFE_HOLD_END_READ_MISSING, readName],
    [name, 'ErrSpawnNotFound', adapter, () => errSpawnNotFound(), OLD_LIFE_HOLD_END_READ_MISSING, `${readName}: no row`],
  ] as const))('%s reading C1\'s row %s ends the hold on cscb_C1 with one end line naming the read; C2\'s hold stays', async (_name, _answer, adapter, answer, reason: OldLifeHoldEndReason, named) => {
    install(answer())
    const c1: OldLifeHold = holds.holdOf(personaInstanceId('C1'))!
    const c2 = holds.holdOf(personaInstanceId('C2'))

    await read(adapter, 'C1')

    expect(holds.snapshot()).toEqual([c2!])
    expect(endLines()).toEqual([oldLifeHoldEndedLine(c1, reason, named)])
  })

  test.each(ADAPTERS.flatMap(([name, , adapter]) => [
    [name, 'a live reading (waiting)', adapter, () => cannedStatusResult({ state: 'waiting' })],
    [name, 'a pending reading with a launch start', adapter, () => cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_WHOLE })],
    [name, 'a failed read (ErrTmuxUnresponsive)', adapter, () => errTmuxUnresponsive('status')],
  ] as const))('%s with %s for C1 keeps both holds, with no end line', async (_name, _label, adapter, answer) => {
    install(answer())
    const before = holds.snapshot()

    await read(adapter, 'C1')

    expect(holds.snapshot()).toEqual(before)
    expect(endLines()).toEqual([])
  })

  test.each(ADAPTERS.map(([name, , adapter]) => [name, adapter] as const))('with no hold set installed, %s reading C1\'s row ended ends nothing, and answers as it does with the set installed', async (_name, adapter) => {
    install(cannedStatusResult({ state: 'ended' }))
    const answerOf = async (): Promise<unknown> => {
      const { result, errArgs } = await capturingErrorArgs(() => adapter('C1'))
      captured.push(...errArgs)
      return result
    }

    _resetOldLifeHolds()
    const without = await answerOf()
    expect(holds.snapshot()).toHaveLength(2)
    expect(endLines()).toEqual([])

    setOldLifeHolds(holds)
    expect(await answerOf()).toEqual(without)
    expect(endLines()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-805: the reconnect adapter never types `/mcp reconnect` into a
// retired key's old life. For a key recorded with no "new life has begun"
// mark whose row reads live other than `pending` (a state CSCB does not know
// included), it reads no pane, types nothing, starts the live-row sequence
// (the retired-key flag, alert context `recovery`, seeded with the state
// read) and answers 'transient'; a second call while that sequence runs starts
// no second one (one sequence per persona). With the mark set the row is the
// new life and is reconnected as any other; a key not recorded is unchanged;
// a `pending` reading answers 'pending', and the deferral's one `get` sends
// the old life through the live-row sequence (b.jg5 SRJ-411; given the
// applied-persona lookup as main() gives it).
//
// On `makeRecoveryHarness`, whose store is installed through the session
// manager's installer and whose registry is installed as `main()` installs
// it; the adapter is called directly. P's own row reads live at the
// sequence's first `get` and `missing` after (`ownRowsLiveThenMissing`), so
// a sequence started through that registry runs to its final launch, a reuse
// of the id, whose outcome shows the retired-key flag. The cases that read
// the whole start request install a recording registry in its place
// (`recordSequenceStarts`), which runs nothing. The sequence's own steps are
// tests/live-row-sequence.test.ts's.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-805: the reconnect adapter starts the live-row sequence for a retired key\'s old life and answers transient, never typing into it', () => {
  let harness: RecoveryHarness | undefined

  afterEach(() => {
    const h = harness
    harness = undefined
    if (h === undefined) return
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
  })

  /** A harness over P and Q, P recorded (its mark set when `mark`), each row's `status` reading `state`, every `get` live then missing. */
  function retiredReconnect(state: string, mark = false): { h: RecoveryHarness; p: string; q: string } {
    const h = (harness = makeRecoveryHarness())
    const [p, q] = h.keys as [string, string]
    h.retireKey(p, { mark })
    ownRowsLiveThenMissing(h)
    h.script({ statusResult: cannedStatusResult({ state }) })
    return { h, p, q }
  }

  /** The adapter as the harness's restart path builds it, with the harness's latch. */
  const reconnect = (h: RecoveryHarness, key: string) => _buildReconnectSessionAdapter(undefined, (k) => h.latch.isLatched(k))(key)

  /** The adapter's lines for a retired key's old life, logged by the case. */
  const oldLifeLinesIn = (h: RecoveryHarness): string[] =>
    h.errors.filter((line) => line.startsWith('[slack] reconnectSession: ') && line.includes(' and its key is retired with no new life begun'))

  /** The adapter's one line for persona `key`'s old life read `state`, the start entry answering `startAnswer`. */
  const oldLifeLine = reconnectRetiredOldLifeLine

  /** P's sequence driven to its end: its final launch the reuse the retired-key flag decides, answering fresh-retired. */
  async function expectRetiredSequenceEnds(h: RecoveryHarness, p: string): Promise<void> {
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({
      kind: LIVE_ROW_OUTCOME_LAUNCHED,
      launchKind: LIVE_ROW_LAUNCH_REUSE,
      reason: LIVE_ROW_LAUNCH_REASON_RETIRED_KEY,
      result: { key: p, action: SPAWN_ACTION_FRESH_RETIRED },
    })
    expect(h.stub.calls.resumeCalls).toEqual([])

  }

  // The start request is read whole from a recording registry installed in
  // the harness's place (`recordSequenceStarts`), so no sequence runs; the
  // run to its reuse is the second call's case below.
  test.each(['waiting', 'working', 'ask_user', 'check_permission', 'hibernating'])('P recorded with no mark, its row reading %s: transient, with no pane read and nothing typed, and one adapter line naming the state and the start\'s answer; exactly one start request: seeded with the state read, entry at step 1, the retired-key flag, the conversation not kept, ending in a launch, context recovery', async (state) => {
    const { h, p, q } = retiredReconnect(state)
    const starts = recordSequenceStarts()

    expect(await reconnect(h, p)).toBe('transient')

    expect([h.stub.calls.sendKeysCalls, h.stub.calls.readPaneCalls]).toEqual([[], []])
    expect(oldLifeLinesIn(h)).toEqual([oldLifeLine(p, state, LIVE_ROW_START_STARTED)])
    expect(starts).toEqual([
      {
        key: p,
        ref: `persona=${p}`,
        instanceId: personaInstanceId(p),
        lastReadState: state,
        entryStep: LIVE_ROW_SEQUENCE_ENTRY_KILL,
        keepsConversation: false,
        retiredKey: true,
        // The start entry's reading of P when the request came: recorded once, no mark (b.jg5 SRJ-806).
        retiredAtStart: { recorded: true, marked: false, generation: 1 },
        // And its reading that P is below the restart cap (b.4q8).
        belowCapAtStart: true,
        launches: true,
        alertContext: KILL_FAILURE_CONTEXT_RECOVERY,
      },
    ])
    expect(h.retiredEntry(q).recorded).toBe(false)
  })

  test('a second call while P\'s sequence runs (its first run held): transient again, with nothing typed and no second sequence; the new inspection stops before another start request', async () => {
    const { h, p } = retiredReconnect('waiting')
    const hold = holdFindMissing(h.stub.client)

    expect(await reconnect(h, p)).toBe('transient')
    await h.driveSequence(hold.entered(1))
    expect(await reconnect(h, p)).toBe('transient')

    expect(oldLifeLinesIn(h)).toEqual([oldLifeLine(p, 'waiting', LIVE_ROW_START_STARTED)])
    expect(h.stub.calls.sendKeysCalls).toEqual([])
    expect([h.stub.calls.killCalls.length, h.sequenceRunning(p)]).toEqual([1, true])
    hold.release(cannedFindMissing({ rows: { [personaInstanceId(p)]: 'ids' } }))
    await expectRetiredSequenceEnds(h, p)
    expect(h.stub.calls.killCalls).toHaveLength(1)
  })

  // The waiting read's clear (b.jg5 SRJ-807) is refused, so P is still
  // recorded and marked when the adapter decides.
  test.each([
    ['P recorded with its mark set (its clear\'s write refused)', true],
    ['Q, not recorded', false],
  ] as const)('%s, its row reading waiting: the ordinary reconnect, success with one send-keys, and no sequence', async (_label, marked) => {
    const { h, p, q } = retiredReconnect('waiting', true)
    const key = marked ? p : q
    h.script({ getFn: ({ instance_id }) => personaRow(h, instance_id === personaInstanceId(p) ? p : q, { state: 'waiting' }) })
    if (marked) h.failRetiredKeyWrites(5)

    expect(await reconnect(h, key)).toBe('success')

    expect(h.stub.calls.sendKeysCalls.map((call) => call.instance_id)).toEqual([personaInstanceId(key), personaInstanceId(key)])
    expect([h.sequenceRunning(key), oldLifeLinesIn(h)]).toEqual([false, []])
    if (marked) expect(h.retiredEntry(p)).toMatchObject({ recorded: true, marked: true })
  })

  // b.jg5 SRJ-411 (the E25 hatch note): the `pending` reading goes to the
  // deferral, which, given the applied-persona lookup as main() gives it,
  // reads the row once and finds the unmarked key's old life not covered.
  test('P recorded with no mark, its row reading pending with a launch start: pending, with nothing typed and no adapter old-life line; the deferral\'s one get finds the old life not covered and makes exactly one start request: seeded pending, entry at step 1, the retired-key flag, the conversation not kept, ending in a launch, context recovery; nothing armed', async () => {
    const { h, p } = retiredReconnect(AGENT_DIRECTOR_PENDING_STATE)
    h.script({ getFn: undefined, getResult: personaRow(h, p, { state: AGENT_DIRECTOR_PENDING_STATE }) })
    const starts = recordSequenceStarts()
    const applied = appliedLookupOf(h)

    expect(await _buildReconnectSessionAdapter(undefined, (k) => h.latch.isLatched(k), applied)(p)).toBe('pending')

    expect([h.stub.calls.sendKeysCalls, h.stub.calls.readPaneCalls, oldLifeLinesIn(h)]).toEqual([[], [], []])
    expect(h.stub.calls.getCalls).toEqual(Array(2).fill({ instance_id: personaInstanceId(p) }))
    expect(starts).toEqual([pendingRowStartRequest(h, p, { retiredKey: true, retiredAtStart: { recorded: true, marked: false, generation: 1 } })])
    expect([h.triggers, h.controller.isArmed(p), getFailureCount(p)]).toEqual([[], false, 0])
  })
})

/** The harness's applied-persona lookup, as `main()` gives the deferral the server's applied config. */
function appliedLookupOf(h: RecoveryHarness): (key: string) => Persona | undefined {
  return (key) => h.config.personas.find((persona) => persona.key === key)
}

/**
 * The one start request the pending-row step makes for persona `key`'s row
 * read `pending` and not covered (b.jg5 SRJ-411): seeded `pending`, entry at
 * step 1, the conversation not kept, ending in a launch, alert context
 * `recovery`, with `fields`' retired-key flag and the start entry's reading,
 * and the start entry's reading that the persona is below the restart cap
 * (b.4q8; no case here records a failure).
 */
function pendingRowStartRequest(
  h: RecoveryHarness,
  key: string,
  fields: Pick<LiveRowSequenceRequest, 'retiredKey' | 'retiredAtStart'>,
): LiveRowSequenceRequest {
  return {
    key,
    ref: renderPersonaRef(h.config.personas.find((persona) => persona.key === key)!.name, key),
    instanceId: personaInstanceId(key),
    lastReadState: AGENT_DIRECTOR_PENDING_STATE,
    entryStep: LIVE_ROW_SEQUENCE_ENTRY_KILL,
    keepsConversation: false,
    tagUpgrade: false,
    ...fields,
    belowCapAtStart: true,
    launches: true,
    alertContext: KILL_FAILURE_CONTEXT_RECOVERY,
  }
}

// ---------------------------------------------------------------------------
// b.jg5 SRJ-410, SRJ-303 (E29): where deferPendingRow runs the pending-row
// rule. Only inside a retry of the persona's own timer (`runInTimerRetry`,
// which the retry action wraps its runs in) and unless its caller says it
// may not (`mayRunRule: false`, the reconnect adapter's deferral), a covered
// `pending` row gets the rule's one run of that retry on the row the step's
// `get` read: 'pending', unless the rule reads the row gone, which answers
// its `DeadRowRead` after one gone line; the step's own `get` reading the
// row `ended`, `missing` or gone answers gone too (ruling R15). Reached from
// any other origin the deferral only arms, as E28 built it, and an
// uncovered, an undecided or an own no-launch-start row never reaches the
// rule. P's row is the pending-row model's (P's own covered `pending` row),
// with the harness clock at G past its launch start, so a rule run shows as

// rule's own answers are tests/pending-row.test.ts's; what the restart run
// does with a gone answer is tests/restart.test.ts's.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-410: deferPendingRow runs the pending-row rule only at a retry of the persona\'s timer, and answers gone only there', () => {
  let harness: RecoveryHarness | undefined

  afterEach(() => {
    const h = harness
    harness = undefined
    if (h === undefined) return
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
  })

  /** A harness over P and Q (`options` for the harness), P's row the pending-row model's with `model(h)`, the clock at G past the row's launch start. */
  async function rowAtG(
    model: (h: RecoveryHarness) => PendingRowModelOptions = () => ({}),
    options: { pendingRowRule?: boolean } = {},
  ): Promise<{ h: RecoveryHarness; p: string; q: string }> {
    const h = (harness = makeRecoveryHarness(options))
    const [p, q] = h.keys as [string, string]
    makePendingRowModel(h, p, model(h))
    await pastSampleGrace(h)
    return { h, p, q }
  }

  /** The deferral for persona `key` as the restart path calls it, inside a retry of `key`'s timer when `atRetry`. */
  function defer(h: RecoveryHarness, key: string, atRetry: boolean, options?: DeferPendingRowOptions): Promise<DeferPendingRowAnswer> {
    const call = (): Promise<DeferPendingRowAnswer> => deferPendingRow(key, SAMPLE_LAUNCH_START_FRACTIONAL, appliedLookupOf(h), options)
    return atRetry ? runInTimerRetry(key, call) : call()
  }

  const ORIGINS = [['inside a retry of P\'s timer', true], ['outside every retry', false]] as const

  /** The pending-row rule's lines for persona `key` at a retry. */
  const ruleLinesOf = (h: RecoveryHarness, key: string): string[] =>
    h.errors.filter((line) => line.startsWith(`${PENDING_ROW_RULE_LOG_HEAD} ${renderPersonaRef(personaOf(h, key).name, key)} rule (${PENDING_ROW_RULE_ORIGIN_RETRY})`))

  /** The deferral's gone lines for persona `key`, over every gone answer. */
  const goneLinesOf = (h: RecoveryHarness, key: string): string[] => {
    const states: readonly DeadRowRead[] = [LIVENESS_DEAD_ROW_ENDED, LIVENESS_DEAD_ROW_MISSING, LIVENESS_DEAD_ROW_NO_ROW]
    const gone = states.map((state) => deferringPendingRowGoneLine(key, state))
    return h.errors.filter((line) => gone.includes(line))
  }

  /** Persona `key`'s stub calls of the rule's verbs: [read-pane, find-missing, get]. */
  const ruleVerbCalls = (h: RecoveryHarness, key: string): number[] => {
    const id = personaInstanceId(key)
    const { readPaneCalls, findMissingCalls, getCalls } = h.stub.calls
    return [readPaneCalls.filter((c) => c.instance_id === id).length, findMissingCalls.length, getCalls.filter((c) => c.instance_id === id).length]
  }

  test.each(ORIGINS)('a covered pending row the run leaves unjudged, %s: pending, P\'s timer armed pending-only; the rule\'s one run (lap, find-missing, get) and its line only at the retry; no gone line, kill or launch', async (_origin, atRetry) => {
    const { h, p, q } = await rowAtG()

    expect(await defer(h, p, atRetry)).toBe('pending')

    expect(ruleVerbCalls(h, p)).toEqual(atRetry ? [0, 1, 2] : [0, 0, 1])
    expect(ruleLinesOf(h, p)).toHaveLength(atRetry ? 1 : 0)
    expect(goneLinesOf(h, p)).toEqual([])
    expectPendingOnlyWatch(h, p)
    expect([h.stub.calls.killCalls, h.stub.calls.spawnCalls, h.stub.calls.resumeCalls]).toEqual([[], [], []])
    expect(h.controller.isArmed(q)).toBe(false)
  })

  test.each(ORIGINS)('a covered pending row a run would mark missing, %s: at the retry the rule\'s run marks it and the deferral answers missing after one gone line; outside, pending with no run', async (_origin, atRetry) => {
    const { h, p } = await rowAtG(() => ({ judgment: judgeMissingFromG() }))

    expect(await defer(h, p, atRetry)).toBe(atRetry ? LIVENESS_DEAD_ROW_MISSING : 'pending')

    expect(ruleVerbCalls(h, p)).toEqual(atRetry ? [0, 1, 2] : [0, 0, 1])
    expect(goneLinesOf(h, p)).toEqual(atRetry ? [deferringPendingRowGoneLine(p, LIVENESS_DEAD_ROW_MISSING)] : [])
    expect([h.stub.calls.killCalls, h.stub.calls.spawnCalls, h.stub.calls.resumeCalls]).toEqual([[], [], []])
  })

  // Ruling R15: the read-and-step get's own `ended`, `missing` or no row is
  // gone at a retry; a live state is not.
  test.each(ORIGINS.flatMap(([origin, atRetry]) => ([
    [LIVENESS_DEAD_ROW_ENDED, LIVENESS_DEAD_ROW_ENDED],
    [LIVENESS_DEAD_ROW_MISSING, LIVENESS_DEAD_ROW_MISSING],
    [PENDING_ROW_MODEL_NO_ROW, LIVENESS_DEAD_ROW_NO_ROW],
    ['waiting', undefined],
  ] as const).map(([state, gone]) => [state, origin, atRetry, gone] as const)))('the step\'s own get reading %s, %s: gone only at the retry, with one gone line; no rule run either way', async (state, _origin, atRetry, gone) => {
    const { h, p } = await rowAtG(() => ({ state }))

    expect(await defer(h, p, atRetry)).toBe(atRetry && gone !== undefined ? gone : 'pending')

    expect(ruleVerbCalls(h, p)).toEqual([0, 0, 1])
    expect(goneLinesOf(h, p)).toEqual(atRetry && gone !== undefined ? [deferringPendingRowGoneLine(p, gone)] : [])
    expect(h.controller.isArmed(p)).toBe(false)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<string>]>([
    ['deferPendingRow told it may not run the rule', (h, key) => defer(h, key, true, { mayRunRule: false })],
    ['the reconnect adapter\'s pending branch', (h, key) => runInTimerRetry(key, () => _buildReconnectSessionAdapter(undefined, (k) => h.latch.isLatched(k), appliedLookupOf(h))(key) as Promise<string>)],
  ])('%s, inside a retry of P\'s timer, a covered pending row a run would mark missing: pending, P\'s timer armed pending-only; no rule run and no gone answer', async (_label, call) => {
    const { h, p } = await rowAtG(() => ({ judgment: judgeMissingFromG() }))

    expect(await call(h, p)).toBe('pending')

    expect(ruleVerbCalls(h, p).slice(0, 2)).toEqual([0, 0])
    expect(ruleLinesOf(h, p)).toEqual([])
    expect(goneLinesOf(h, p)).toEqual([])
    expectPendingOnlyWatch(h, p)
  })

  test('deferPendingRow told it may not run the rule, inside a retry of P\'s timer, its get reading the row ended: pending, with the next-run-decides line and no gone line', async () => {
    const { h, p } = await rowAtG(() => ({ state: LIVENESS_DEAD_ROW_ENDED }))

    expect(await defer(h, p, true, { mayRunRule: false })).toBe('pending')

    expect(goneLinesOf(h, p)).toEqual([])
    expect(h.errors.filter((line) => line === deferralNotPendingLine(p, LIVENESS_DEAD_ROW_ENDED))).toHaveLength(1)
  })

  // E28's answers kept: none of these rows is handed to the rule.
  test.each<[string, (h: RecoveryHarness, key: string) => PendingRowModelOptions, (h: RecoveryHarness, key: string) => void, (h: RecoveryHarness, key: string, starts: LiveRowSequenceRequest[]) => void]>([
    ['not covered (its cwd another existing directory)', (h) => ({ row: { cwd: h.home } }), () => {}, (h, key, starts) => {
      expect(starts).toEqual([pendingRowStartRequest(h, key, { retiredKey: false, retiredAtStart: { recorded: false, marked: false, generation: undefined } })])
      expect(h.controller.isArmed(key)).toBe(false)
    }],
    ['undecided (P\'s working directory gone)', () => ({}), (h, key) => rmSync(personaOf(h, key).working_directory, { recursive: true, force: true }), (h, key, starts) => {
      expect(starts).toEqual([])
      expectPendingOnlyWatch(h, key)
    }],
    ['P\'s own row with no launch start', () => ({ launchStartedAt: SAMPLE_LAUNCH_START_NONE }), () => {}, (h, key, starts) => {
      expect(starts).toEqual([])
      expect([h.latch.isLatched(key), h.controller.isArmed(key)]).toEqual([true, false])
    }],
  ])('inside a retry of P\'s timer, a pending row %s keeps E28\'s answer (pending) and never reaches the rule, though a run would mark it missing', async (_label, model, prepare, check) => {
    const { h, p } = await rowAtG((hh) => ({ judgment: judgeMissingFromG(), ...model(hh, hh.keys[0]!) }))
    prepare(h, p)
    const starts = recordSequenceStarts()

    expect(await defer(h, p, true)).toBe('pending')

    expect(ruleVerbCalls(h, p)).toEqual([0, 0, 1])
    expect(ruleLinesOf(h, p)).toEqual([])
    expect(goneLinesOf(h, p)).toEqual([])
    check(h, p, starts)
  })

  test('two deferrals in one retry of P\'s timer: the rule runs once, at the first; the second makes only its get and logs that the rule already ran', async () => {
    const { h, p } = await rowAtG()
    const ref = renderPersonaRef(personaOf(h, p).name, p)

    expect(await runInTimerRetry(p, async () => [
      await deferPendingRow(p, SAMPLE_LAUNCH_START_FRACTIONAL, appliedLookupOf(h)),
      await deferPendingRow(p, SAMPLE_LAUNCH_START_FRACTIONAL, appliedLookupOf(h)),
    ])).toEqual(['pending', 'pending'])

    expect(ruleVerbCalls(h, p)).toEqual([0, 1, 3])
    expect(ruleLinesOf(h, p)).toHaveLength(1)
    expect(h.errors.filter((line) => line === pendingRowRuleAlreadyRanLine(ref))).toHaveLength(1)
  })

  test('with no rule installed, inside a retry of P\'s timer: pending, P\'s timer armed pending-only, one line saying no rule is installed, and no lap or run', async () => {
    const { h, p } = await rowAtG(() => ({ judgment: judgeMissingFromG() }), { pendingRowRule: false })

    expect(await defer(h, p, true)).toBe('pending')

    expect(ruleVerbCalls(h, p)).toEqual([0, 0, 1])
    expect(h.errors.filter((line) => line === pendingRowRuleNotInstalledLine(renderPersonaRef(personaOf(h, p).name, p)))).toHaveLength(1)
    expectPendingOnlyWatch(h, p)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-810 (hatch A3), SRJ-805, SRJ-811: the reconnect adapter's
// held-own-row branch. A persona's own row `cscb_<key>` held for an old life
// while its key is not recorded (a row the start sweep swept for its `cwd`,
// its kill failed: held at the row's `cwd`), read live other than `pending`,
// takes the retired key's path: no pane read, nothing typed, one live-row
// sequence started with no retired-key flag, 'transient', nothing counted,
// one line naming the start's answer. While the old-life wait runs on that
// row the start answers already-running, no sequence starts and the start
// entry arms P's timer with the old-life cause. A row that is not held is
// reconnected as before. The recorded-key branch is the describe above's.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-810: the reconnect adapter starts the live-row sequence for a held own row of a key not recorded and answers transient, never typing into it', () => {
  let harness: RecoveryHarness | undefined

  afterEach(() => {
    const h = harness
    harness = undefined
    if (h === undefined) return
    try {
      h.controller.stopAll('the case is over')
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
  })

  /** A harness over P and Q, P's own row held at the harness home (swept for its cwd, its kill failed), each row's status reading `state`. */
  function heldOwnRow(state: string): { h: RecoveryHarness; p: string; q: string } {
    const h = (harness = makeRecoveryHarness())
    const [p, q] = h.keys as [string, string]
    h.beginOldLifeHold({ instanceId: personaInstanceId(p), oldKey: p, directory: h.home, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })
    h.script({ statusResult: cannedStatusResult({ state }) })
    return { h, p, q }
  }

  /** The adapter as the harness's restart path builds it, with the harness's latch. */
  const reconnect = (h: RecoveryHarness, key: string) => _buildReconnectSessionAdapter(undefined, (k) => h.latch.isLatched(k))(key)

  /** The adapter's held-own-row lines, logged by the case. */
  const heldLinesIn = (h: RecoveryHarness): string[] => h.errors.filter((line) => line.startsWith('[slack] reconnectSession: ') && line.includes(' and its own row is held for an old life '))

  test.each(['waiting', 'working', 'ask_user'])('P\'s held own row reading %s: transient, with no pane read and nothing typed, nothing counted or armed; one line naming the start\'s answer; exactly one start request, with no retired-key flag, ending in a launch; Q, not held, is reconnected with its one send-keys', async (state) => {
    const { h, p, q } = heldOwnRow(state)
    const starts = recordSequenceStarts()

    expect(await reconnect(h, p)).toBe('transient')

    expect([h.stub.calls.sendKeysCalls, h.stub.calls.readPaneCalls]).toEqual([[], []])
    expect(heldLinesIn(h)).toEqual([reconnectHeldOwnRowLine(p, state, LIVE_ROW_START_STARTED)])
    expect(starts).toEqual([
      {
        key: p,
        ref: `persona=${p}`,
        instanceId: personaInstanceId(p),
        lastReadState: state,
        entryStep: LIVE_ROW_SEQUENCE_ENTRY_KILL,
        keepsConversation: false,
        retiredKey: false,
        // The start entry's reading of P when the request came: not recorded (b.jg5 SRJ-806).
        retiredAtStart: { recorded: false, marked: false, generation: undefined },
        // And its reading that P is below the restart cap (b.4q8).
        belowCapAtStart: true,
        launches: true,
        alertContext: KILL_FAILURE_CONTEXT_RECOVERY,
      },
    ])
    expect([getFailureCount(p), h.triggers, h.controller.isArmed(p)]).toEqual([0, [], false])

    h.script({ statusResult: cannedStatusResult({ state: 'waiting' }) })
    expect(await reconnect(h, q)).toBe('success')
    expect(h.stub.calls.sendKeysCalls.map((call) => call.instance_id)).toEqual([personaInstanceId(q), personaInstanceId(q)])
  })

  test('a second call while P\'s sequence runs (its first run held): transient again, no second sequence and nothing typed; once the run lists the row in its ids the hold ends and the sequence ends in its launch', async () => {
    const { h, p } = heldOwnRow('waiting')
    ownRowsLiveThenMissing(h)
    const hold = holdFindMissing(h.stub.client)

    expect(await reconnect(h, p)).toBe('transient')
    await h.driveSequence(hold.entered(1))
    expect(await reconnect(h, p)).toBe('transient')

    expect(heldLinesIn(h)).toEqual([reconnectHeldOwnRowLine(p, 'waiting', LIVE_ROW_START_STARTED)])
    expect([h.stub.calls.sendKeysCalls, h.stub.calls.killCalls.length, h.sequenceRunning(p)]).toEqual([[], 1, true])
    hold.release(cannedFindMissing({ rows: { [personaInstanceId(p)]: 'ids' } }))
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED })
    expect([h.oldLifeHolds.holdOf(personaInstanceId(p)), h.stub.calls.killCalls.length, h.stub.calls.sendKeysCalls]).toEqual([undefined, 1, []])

  })

  test('while the old-life wait runs on P\'s own row (its first run held): transient, no sequence starts, no additional retry is armed and nothing is typed; the existing wait keeps exclusive ownership', async () => {
    const { h, p } = heldOwnRow('waiting')
    h.script({ getResult: cannedGetResult({ instance_id: personaInstanceId(p), cwd: h.home }) })
    const hold = holdFindMissing(h.stub.client)
    const wait = h.startOldLifeWait(personaInstanceId(p))
    await h.driveSequence(hold.entered(1))
    const kills = h.stub.calls.killCalls.length

    expect(await reconnect(h, p)).toBe('transient')

    expect(heldLinesIn(h)).toEqual([])
    // The wait is still the one thing running on the id: no kill or call beyond its own.
    expect([h.oldLifeWaitRunning(personaInstanceId(p)), h.stub.calls.sendKeysCalls, h.stub.calls.killCalls.length]).toEqual([true, [], kills])
    expect([h.triggers, h.controller.isArmed(p), getFailureCount(p)]).toEqual([[], false, 0])
    hold.release(cannedFindMissing({ rows: { [personaInstanceId(p)]: 'ids' } }))
    await h.driveSequence(wait)
    expect(h.oldLifeHolds.holdOf(personaInstanceId(p))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// _buildKillSessionAdapter: the checked kill's outcome (b.jg5 SRJ-110, SRJ-701,
// SRJ-702)
//
// The restart work's kill adapter, run inside a recovery attempt for the
// persona as `runRestartWork` runs it, built with a fake clock. Its kill goes
// through the bounded retry (`retryPersonaKill`, b.jg5 SRJ-702) seeded with
// the run's `dead` reading: not a row read live, so one try whose outcome
// stands at once, with no `status` read and no wait on the clock (the tries,
// the reads and the survivor rule are proved at the live-row sequence's kill
// of a row read live, in tests/session-manager.test.ts and
// tests/live-row-sequence.test.ts, and in
// tests/kill-retry.test.ts). The retry logs its one try line (`kill try 1 of
// 1`, and, for an `ErrTmuxKillFailed`, its end line naming the ordinary
// decision), then the adapter answers the outcome, `kill_sent` included, with
// one line naming it, and raises the decision (b.jg5 SRJ-704): no kill-failure
// alerts are installed here, so an `ErrTmuxKillFailed`'s ordinary decision is
// one line saying it is not raised (the routes are proved on the recovery
// harness, in tests/restart.test.ts); nothing is swallowed. A success (`kill_sent` true, false or absent) and
// `ErrSpawnNotFound` arm nothing. An UNAVAILABLE kill (by class,
// `ErrTmuxKillFailed` included, told apart) arms the timer (b.jg5 SRJ-105); an
// ENVIRONMENT kill (`ErrTmuxNotAvailable`, b.jg5 SRJ-311) also raises
// `tmux-unavailable`, a CONFIG kill (`ErrConfigMalformed`, b.jg5 SRJ-316)
// `ad-config-malformed`; an UNCLASSIFIED kill (b.jg5 SRJ-313:
// `ErrSystemInstallDisappeared`, which also raises `ad-unreachable`,
// included) is reported to the unclassified sink. GONE is the session-gone
// success (b.jg5 SRJ-104: for `kill`, gone is success). A class SRJ-110 has
// no row for (a STATE name other than `ErrSpawnNotFound`, LAUNCH FAILURE,
// DIRECTORY) is the UNCLASSIFIED non-success, reported as UNCLASSIFIED: the
// timer armed with the UNCLASSIFIED cause and the unclassified sink fed once
// (b.jg5 SRJ-105, SRJ-313). An `ErrInvalidFlags` gets one immediate version
// re-check first (b.jg5 SRJ-104, SRJ-204); a stop it decides is answered with
// nothing armed, reported or latched (b.jg5 SRJ-205). A CONFLICT (the case
// table's restart-kill rows) latches the persona through the latch's CONFLICT
// entry with the refused operation "P's next check or recovery", and an
// UNUSABLE NAME through E16's entry, each recording the state the run's
// `dead` reading carries (the adapter's `lastRead`: `ended`, `missing` or no
// row), with no further `status` read; only the install-gone reading, which
// carries none, leads to the one latch-time `status` read (b.jg5 SRJ-501;
// E13, E16 hatch notes). The kill follows a `dead` reading, so
// it is declared as not of a row read live: not tmux-touching, it never
// starts (or, on success, ends) the `tmux-unresponsive` condition. The guards
// (a launch in flight, an unresolvable `claude_config_dir`) make no call and
// answer the guard result. The outage state's sinks are spies; the server's
// latch is installed with C1 configured, its notice bound to recorded
// episodes.
// ---------------------------------------------------------------------------

describe('_buildKillSessionAdapter: the checked kill\'s outcome (b.jg5 SRJ-110, SRJ-701)', () => {
  let dir: string
  let killCalls: KillParams[]
  let statusCalls: StatusParams[]
  let triggers: Array<{ key: string; kind: string }>
  let starts: Array<{ key: string; verb: string }>
  let ends: string[]
  let emissions: Array<{ key: string; text: string }>
  /** Every report to the unclassified sink: its key and whether it was the kill's own error. */
  let reports: Array<{ key: string; same: boolean }>
  /** The error the stub's `kill` answers, for `reports`. */
  let killErr: Error | undefined
  let latch: ConflictLatch
  let latchLines: string[]
  /** Every latch notice the episodes' sink received. */
  let posts: Array<{ key: string; text: string }>
  let unbindNotice: () => void
  /** Every `console.error` argument list the case captured, for the leak check. */
  let captured: unknown[][]
  /** The adapter's kill-retry clock: its kill is one try, so no wait is ever asked of it. */
  let clock: FakeClock

  /** The adapter's one line naming C1's kill outcome. */
  const killLine = (outcome: KillOutcome): string =>
    `[slack] killSession (restart adapter): kill for persona=C1: ${describeKillOutcome(outcome)}`

  /**
   * The bounded retry's lines for the adapter's one try of C1's kill (b.jg5
   * SRJ-702: a dead seed, so one try): the try line, then, for an
   * `ErrTmuxKillFailed`, the end line naming the ordinary decision quoting it.
   */
  const retryLines = (outcome: KillOutcome): string[] => {
    const prefix = '[slack] killSession (restart adapter)'
    const id = personaInstanceId('C1')
    const unavailable = outcome.kind === KILL_OUTCOME_NOT_KILLED && outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE
    const next = killLetsNextStepRun(outcome) ? KILL_RETRY_NEXT_SUCCESS : unavailable ? KILL_RETRY_NEXT_NOT_LIVE : KILL_RETRY_NEXT_NOT_RETRIED
    const lines = [killRetryTryLine(prefix, id, 1, 1, outcome, next)]
    if (unavailable && outcome.killFailed && typeof outcome.killFailedDescription === 'string') {
      const alert = { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: outcome.killFailedDescription } as const
      lines.push(killRetryEndLine(prefix, id, { outcome, end: KILL_RETRY_END_SETTLED, tries: 1, reads: 0, alert }))
    }
    return lines
  }

  /**
   * The adapter's line for an `ErrTmuxKillFailed`'s ordinary decision with no
   * kill-failure alerts installed (b.jg5 SRJ-704): the alert is not raised,
   * and the line names its description, redacted on one line.
   */
  const alertNotRaisedLines = (outcome: KillOutcome): string[] =>
    outcome.kind === KILL_OUTCOME_NOT_KILLED && outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE && outcome.killFailed && typeof outcome.killFailedDescription === 'string'
      ? [
          `[slack] killSession (restart adapter): kill for persona=C1: the kill-failure alert's ${KILL_RETRY_ALERT_ORDINARY} version is not raised — no kill-failure alerts are installed; last=${JSON.stringify(renderLogMessageText(outcome.killFailedDescription))} (b.jg5 SRJ-704)`,
        ]
      : []

  /** Every line the adapter's kill of C1 logs for `outcome`: the retry's, the adapter's own, then the alert's when one is decided. */
  const killLines = (outcome: KillOutcome): string[] => [...retryLines(outcome), killLine(outcome), ...alertNotRaisedLines(outcome)]

  /**
   * Install a stub whose `kill` answers `killError` (else `killResult`), whose
   * `status` throws `statusError` (else reads C1's row `ended`; the
   * latch-time read, made only after an install-gone reading), with spy
   * sinks.
   */
  function install(
    killError?: Error,
    killResult: StubKillResult = cannedKillResult(true),
    statusError?: Error,
    killQueue?: CannedResponse<StubKillResult>[],
  ): StubClient {
    killErr = killError
    const stub = makeStubClient({
      readPaneResults: [cannedReadPaneResult(IDLE_PANE)],
      killCalls,
      statusCalls,
      killError,
      killResult,
      ...(killQueue === undefined ? {} : { killQueue }),
      ...(statusError === undefined ? { statusResult: cannedStatusResult({ state: LIVENESS_DEAD_ROW_ENDED }) } : { statusError }),
    })
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

  /**
   * Run the adapter for `key` inside a recovery attempt, handing it the run's
   * `dead` reading `lastRead` (default: a row read `ended`), capturing
   * console.error.
   */
  async function killInAttempt(
    key: string = 'C1',
    getPersona?: (key: string) => Persona | undefined,
    lastRead: DeadLivenessReading = LIVENESS_READING_DEAD_ENDED,
  ): Promise<{ result: KillSessionResult; errArgs: unknown[][] }> {
    const run = await capturingErrorArgs(() => runInAttempt(key, 'recovery', () => _buildKillSessionAdapter(getPersona, clock)(key, lastRead)))
    captured.push(...run.errArgs)
    return run
  }

  /** The non-success `result` is, narrowed; fails the case for any other answer. */
  function notKilled(result: KillSessionResult): KillFailure {
    expect(result).toMatchObject({ kind: KILL_OUTCOME_NOT_KILLED })
    return result as KillFailure
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'server-kill-'))
    killCalls = []
    statusCalls = []
    triggers = []
    starts = []
    ends = []
    emissions = []
    reports = []
    killErr = undefined
    latchLines = []
    posts = []
    captured = []
    clock = createFakeClock()
    latch = createConflictLatch({ log: (line) => { latchLines.push(line) } })
    unbindNotice = bindConflictNotice(
      latch,
      createPersonaEpisodes({ sink: (key, text) => { posts.push({ key, text }) }, log: (line) => { latchLines.push(line) }, clock: createFakeClock() }),
    )
    setConflictLatch(latch)
    setConfiguredPersonaQuery((key) => key === 'C1')
  })

  afterEach(() => {
    unbindNotice()
    setConflictLatch(undefined)
    _resetConfiguredPersonaQuery()
    resetClientForTests()
    _resetOutageState()
    _resetInFlightLaunches()
    _resetSpawnHomeDir()
    rmSync(dir, { recursive: true, force: true })
    assertNoLeak({ captured, emissions, latchLines, posts })
    // b.jg5 SRJ-702: a kill after a dead reading is one try: no wait asked.
    expect(clock.pendingCount()).toBe(0)
    expect(clock.firedCount()).toBe(0)
  })

  test.each([
    ['true', true],
    ['false', false],
    ['absent', undefined],
  ] as const)('b.jg5 SRJ-701, SRJ-703: kill succeeds with kill_sent %s → the killed outcome carrying it; one kill, one outcome line; nothing armed, latched or posted; no condition started or ended (not tmux-touching)', async (_label, killSent) => {
    install(undefined, cannedKillResult(killSent))

    const { result, errArgs } = await killInAttempt()

    expect(result).toEqual(killSent === undefined ? { kind: KILL_OUTCOME_KILLED } : { kind: KILL_OUTCOME_KILLED, killSent })
    expect(killCalls).toEqual([{ instance_id: personaInstanceId('C1') }])
    expect(stringLines(errArgs)).toEqual(killLines(result as KillOutcome))
    expect(triggers).toEqual([])
    expect(starts).toEqual([])
    expect(ends).toEqual([])
    expect(emissions).toEqual([])
    expect(latch.isLatched('C1')).toBe(false)
    expect(statusCalls).toEqual([])
  })

  test('b.jg5 SRJ-701: kill answers ErrSpawnNotFound → the row-gone success; one outcome line; nothing armed or latched, no condition', async () => {
    install(errSpawnNotFound())

    const { result, errArgs } = await killInAttempt()

    expect(result).toEqual({ kind: KILL_OUTCOME_ROW_GONE })
    expect(killCalls).toHaveLength(1)
    expect(stringLines(errArgs)).toEqual(killLines({ kind: KILL_OUTCOME_ROW_GONE }))
    expect(triggers).toEqual([])
    expect(starts).toEqual([])
    expect(latch.isLatched('C1')).toBe(false)
  })

  test.each(UNAVAILABLE_FORMS)('b.jg5 SRJ-110, SRJ-105, SRJ-702: kill answers %s → the UNAVAILABLE non-success, not swallowed; one kill (one try: the run read the row dead), no status read, the try line and one described outcome line; the timer is armed once, no condition starts, nothing latched, posted or leaked', async (_label, build, redacted, causeKind) => {
    const err = build('kill')
    install(err)

    const { result, errArgs } = await killInAttempt()

    const outcome = notKilled(result)
    expect(outcome.errorClass).toBe(AD_ERROR_CLASS_UNAVAILABLE)
    expect(outcome.error).toBe(err)
    expect(outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE && outcome.killFailed).toBe(causeKind === UNAVAILABLE_RETRY_CAUSE_KILL_FAILED)
    expect(killCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
    const lines = stringLines(errArgs)
    expect(lines).toEqual(killLines(outcome))
    if (redacted) for (const line of lines) expect(line).toContain(REDACTED_SENTINEL_TAIL)
    expect(triggers).toEqual([{ key: 'C1', kind: causeKind }])
    expect(starts).toEqual([])
    expect(ends).toEqual([])
    expect(emissions).toEqual([])
    expect(getOutageFlags('C1').size).toBe(0)
    expect(latch.isLatched('C1')).toBe(false)
    expect(statusCalls).toEqual([])
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
    expect(notKilled(result).errorClass).toBe(AD_ERROR_CLASS_UNAVAILABLE)
    expect(starts).toHaveLength(1)
  })

  // b.jg5 SRJ-311: an ENVIRONMENT kill is a non-success, never swallowed into
  // a launch. The wrapper raises `tmux-unavailable` (its one onset) and arms
  // the timer once with the ENVIRONMENT cause; ENVIRONMENT never starts the
  // `tmux-unresponsive` condition (SRJ-307).
  // b.jg5 SRJ-1021: the re-bound-socket form (the description carries "not the
  // tmux server the agent was launched on") is the same, with SRJ-1021's onset.
  test.each([
    ['ErrTmuxNotAvailable', () => errTmuxNotAvailable(undefined, 'kill'), () => ONSET_TEMPLATES['tmux-unavailable']()],
    ['ErrTmuxNotAvailable, re-bound-socket form (b.jg5 SRJ-1021)', () => errTmuxNotAvailableDifferentServer(undefined, 'kill'), tmuxServerChangedOnset],
  ] as const)('b.jg5 SRJ-110, SRJ-311: kill answers %s → the ENVIRONMENT non-success, not swallowed into a launch; one described outcome line; tmux-unavailable raised with its onset; the timer armed once with the environment cause; no condition', async (_label, build, onset) => {
    const err = build()
    install(err)

    const { result, errArgs } = await killInAttempt()

    const outcome = notKilled(result)
    expect(outcome.errorClass).toBe(AD_ERROR_CLASS_ENVIRONMENT)
    expect(outcome.error).toBe(err)
    expect(killCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
    expect(stringLines(errArgs)).toEqual(killLines(outcome))
    expect([...getOutageFlags('C1')]).toEqual(['tmux-unavailable'])
    expect(emissions).toEqual([{ key: 'C1', text: onset() }])
    expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT }])
    expect(starts).toEqual([])
    expect(ends).toEqual([])
  })

  // b.jg5 SRJ-316, SRJ-110: a CONFIG kill is a non-success, so the restart
  // work launches nothing after it, and the kill is not repeated. The wrapper
  // raises `ad-config-malformed` (its onset, quoting the redacted
  // description) and arms the timer once with the CONFIG cause.
  test('b.jg5 SRJ-110, SRJ-316: kill answers a CONFIG answer (ErrConfigMalformed) → the CONFIG non-success with no second kill; one described outcome line; ad-config-malformed raised with its onset; the timer armed once with the config cause; no condition; nothing leaks', async () => {
    const err = errConfigMalformed('starting_session_seconds', sentinelInMessage('kill-config'))
    install(err)

    const { result, errArgs } = await killInAttempt()

    const outcome = notKilled(result)
    expect(outcome.errorClass).toBe(AD_ERROR_CLASS_CONFIG)
    expect(killCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
    const lines = stringLines(errArgs)
    expect(lines.filter((l) => l.includes('killSession (restart adapter)'))).toEqual(killLines(outcome))
    expect(lines.filter((l) => l.includes('ad-config-malformed raised for persona=C1'))).toHaveLength(1)
    expect(lines).toHaveLength(killLines(outcome).length + 1)
    expect(lines.join('\n')).toContain(REDACTED_SENTINEL_TAIL)
    expect([...getOutageFlags('C1')]).toEqual(['ad-config-malformed'])
    expect(emissions).toEqual([{ key: 'C1', text: adConfigMalformedOnset(err) }])
    expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_CONFIG }])
    expect(starts).toEqual([])
    expect(ends).toEqual([])
  })

  // b.jg5 SRJ-110, SRJ-313: an UNCLASSIFIED kill is a non-success: the
  // adapter answers it to the restart work and makes no second call, so no
  // step follows. The wrapper arms the timer once with the UNCLASSIFIED cause
  // and, inside the attempt, reports the error once to the unclassified sink.
  // `ErrSystemInstallDisappeared` also raises `ad-unreachable` with its onset.
  test.each([
    ['ErrInternal', () => errInternal(`the store could not be read (${sentinelInMessage('kill-internal')})`), undefined],
    ['a store agent-director cannot open (ErrSchemaMismatch)', () => errSchemaMismatch(`the store could not be opened (${sentinelInMessage('kill-schema')})`), undefined],
    ['a name CSCB gives no handling', () => errGeneric('kill', 'ErrKillBroken', `the kill broke (${sentinelInMessage('kill-generic')})`), undefined],
    ['ErrSystemInstallDisappeared', () => errSystemInstallDisappeared('kill'), 'ad-unreachable'],
  ] as const)('b.jg5 SRJ-110, SRJ-313: kill answers %s → the UNCLASSIFIED non-success with no second kill; one described outcome line; the timer armed once with the unclassified cause; reported once to the unclassified sink; no condition; nothing leaks', async (_label, build, flag) => {
    const err = build()
    install(err)

    const { result, errArgs } = await killInAttempt()

    const outcome = notKilled(result)
    expect(outcome.errorClass).toBe(AD_ERROR_CLASS_UNCLASSIFIED)
    expect(outcome.error).toBe(err)
    expect(killCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
    expect(stringLines(errArgs).filter((l) => l.includes('killSession (restart adapter)'))).toEqual(killLines(outcome))
    expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED }])
    expect(reports).toEqual([{ key: 'C1', same: true }])
    expect(starts).toEqual([])
    expect(ends).toEqual([])
    expect([...getOutageFlags('C1')]).toEqual(flag === undefined ? [] : [flag])
    expect(emissions.map((e) => e.key)).toEqual(flag === undefined ? [] : ['C1'])
    expect(latch.isLatched('C1')).toBe(false)
  })

  // b.jg5 SRJ-104, SRJ-110: for `kill`, gone is success. A GONE answer is the
  // session-gone success carrying its name: nothing armed, reported or
  // latched, and the restart work's relaunch follows it.
  test.each([
    ['ErrTmuxCaptureFailed', () => errTmuxCaptureFailed(undefined, 'kill')],
    ['ErrTmuxSendKeys', () => errTmuxSendKeys()],
  ] as const)('b.jg5 SRJ-104, SRJ-110: kill answers GONE (%s) → the session-gone success carrying its name (for kill, gone is success); one kill, one outcome line rendering session-gone; nothing armed, reported or latched, no condition, no status read', async (_label, build) => {
    const err = build()
    install(err)

    const { result, errArgs } = await killInAttempt()

    expect(result).toEqual({ kind: KILL_OUTCOME_SESSION_GONE, name: err.errName })
    expect(killCalls).toEqual([{ instance_id: personaInstanceId('C1') }])
    expect(stringLines(errArgs)).toEqual(killLines(result as KillOutcome))
    expect(killLine(result as KillOutcome)).toContain(`outcome=${KILL_OUTCOME_SESSION_GONE} (${err.errName})`)
    expect(triggers).toEqual([])
    expect(reports).toEqual([])
    expect(starts).toEqual([])
    expect(ends).toEqual([])
    expect(emissions).toEqual([])
    expect(latch.isLatched('C1')).toBe(false)
    expect(statusCalls).toEqual([])
  })

  // b.jg5 SRJ-110, SRJ-105, SRJ-313: a class SRJ-110 gives no kill row (a
  // STATE name other than ErrSpawnNotFound, LAUNCH FAILURE, DIRECTORY) is the
  // UNCLASSIFIED non-success, never swallowed into a launch; inside the
  // attempt it is reported as UNCLASSIFIED: the timer armed once with the
  // UNCLASSIFIED cause and the unclassified sink fed once. Never latched.
  test.each([
    ['a STATE name (ErrSpawnNotResumable)', () => errSpawnNotResumable(), AD_ERROR_CLASS_STATE],
    ['a STATE name (ErrInstanceIdCollision)', () => errInstanceIdCollision(), AD_ERROR_CLASS_STATE],
    ['a LAUNCH FAILURE name (ErrTmuxSessionCreate)', () => errTmuxSessionCreate('kill'), AD_ERROR_CLASS_LAUNCH_FAILURE],
    ['a DIRECTORY name (ErrCwdNotFound)', () => new ErrCwdNotFound('kill', ErrCwdNotFound.name, 'the working directory is gone'), AD_ERROR_CLASS_DIRECTORY],
  ] as const)('b.jg5 SRJ-110, SRJ-313: kill answers %s → the UNCLASSIFIED non-success carrying unlistedClass %s, not swallowed into a launch; one kill, one outcome line; the timer armed once with the UNCLASSIFIED cause; reported once to the unclassified sink; nothing latched, no condition, no status read', async (_label, build, unlistedClass) => {
    const err = build()
    install(err)

    const { result, errArgs } = await killInAttempt()

    expect(result).toEqual({ kind: KILL_OUTCOME_NOT_KILLED, errorClass: AD_ERROR_CLASS_UNCLASSIFIED, error: err, unlistedClass })
    expect(killCalls).toHaveLength(1)
    expect(stringLines(errArgs).filter((l) => l.includes('killSession (restart adapter)'))).toEqual(killLines(result as KillOutcome))
    expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED }])
    expect(reports).toEqual([{ key: 'C1', same: true }])
    expect(starts).toEqual([])
    expect(latch.isLatched('C1')).toBe(false)
    expect(statusCalls).toEqual([])
  })

  // b.jg5 SRJ-104, SRJ-204, SRJ-205: an ErrInvalidFlags at the kill gets
  // exactly one immediate version re-check. When it passes, the outcome is
  // the UNCLASSIFIED non-success reported as UNCLASSIFIED; when it decides
  // that the server stops, the outcome carries the stop and nothing more is
  // done: nothing armed, reported or latched.
  describe('an ErrInvalidFlags at the kill (b.jg5 SRJ-104, SRJ-204, SRJ-205)', () => {
    let resolveCalls: Array<object | undefined>
    let stops: number[]

    /** Install the real re-check, its `resolveSystemBinary` answering `outcome`. */
    function installRecheck(outcome: StubResolveSystemBinaryOutcome): void {
      resetAdVersionRecheckForTests()
      installAdVersionRecheck({
        resolveSystemBinary: makeStubResolveSystemBinary({ calls: resolveCalls, outcomes: [outcome] }),
        baselineVersion: PHASE1_RC_VERSION,
        recordStartupError: () => {},
        stop: (exitCode) => { stops.push(exitCode) },
        log: () => {},
        clock: createFakeClock(),
      })
    }

    beforeEach(() => {
      resolveCalls = []
      stops = []
    })

    afterEach(() => {
      resetAdVersionRecheckForTests()
    })

    test('the re-check passes → exactly one re-check and no stop; the UNCLASSIFIED non-success (from STATE, recheck pass); the timer armed once with the UNCLASSIFIED cause; reported once; nothing latched, no status read', async () => {
      installRecheck({ version: PHASE1_RC_VERSION })
      const err = errInvalidFlags('kill')
      install(err)

      const { result, errArgs } = await killInAttempt()

      expect(resolveCalls).toHaveLength(1)
      expect(stops).toEqual([])
      expect(result).toEqual({
        kind: KILL_OUTCOME_NOT_KILLED,
        errorClass: AD_ERROR_CLASS_UNCLASSIFIED,
        error: err,
        unlistedClass: AD_ERROR_CLASS_STATE,
        recheck: RECHECK_OUTCOME_PASS,
      })
      expect(killOutcomeStopsServer(result)).toBe(false)
      expect(killCalls).toHaveLength(1)
      expect(stringLines(errArgs).filter((l) => l.includes('killSession (restart adapter)'))).toEqual(killLines(result as KillOutcome))
      expect(triggers).toEqual([{ key: 'C1', kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED }])
      expect(reports).toEqual([{ key: 'C1', same: true }])
      expect(latch.isLatched('C1')).toBe(false)
      expect(statusCalls).toEqual([])
    })

    test('the re-check decides that the server stops → exactly one re-check and one stop; the outcome carries the stop; nothing armed, reported or latched; one kill, one outcome line, then the stopped retry\'s no-alerts line; no status read', async () => {
      installRecheck({ version: OLD_AD_VERSION })
      const err = errInvalidFlags('kill')
      install(err)

      const { result, errArgs } = await killInAttempt()

      expect(resolveCalls).toHaveLength(1)
      expect(stops).toHaveLength(1)
      expect(killOutcomeStopsServer(result)).toBe(true)
      expect(notKilled(result)).toMatchObject({ errorClass: AD_ERROR_CLASS_UNCLASSIFIED, error: err, recheck: RECHECK_OUTCOME_STOP })
      expect(killCalls).toHaveLength(1)
      // b.jg5 SRJ-702, SRJ-704: no alerts are installed, so the stopped retry's
      // `none` decision is recorded by its one stop line.
      expect(stringLines(errArgs).filter((l) => l.includes('killSession (restart adapter)'))).toEqual([
        ...killLines(result as KillOutcome),
        personaKillStoppedNoAlertsLine(
          'killSession (restart adapter)',
          'persona=C1',
          { kind: KILL_RETRY_ALERT_NONE },
          AD_ERROR_CLASS_UNCLASSIFIED,
          PERSONA_KILL_STOP_CAUSE_RECHECK,
        ),
      ])
      assertNoLeak({ errArgs })
      expect(triggers).toEqual([])
      expect(reports).toEqual([])
      expect(latch.isLatched('C1')).toBe(false)
      expect(posts).toEqual([])
      expect(statusCalls).toEqual([])
    })
  })

  // b.jg5 SRJ-110, SRJ-501, SRJ-505 (E13 hatch note): a CONFLICT at the
  // restart path's kill latches C1 once through the latch's CONFLICT entry
  // with the row's case, "P's next check or recovery" and the state the
  // run's `dead` reading carries, with no `status` read; the outcome says
  // latched (CONFLICT), and the kill is made once.
  test.each(RESTART_KILL_CONFLICT_CASE_ROWS.map((row) => [row.name, row] as const))('b.jg5 SRJ-110, SRJ-501: CONFLICT at the kill (%s) → the CONFLICT non-success; C1 latched once with its case, "P\'s next check or recovery" and the state the run\'s dead reading carries, with no status read; one notice; one kill; nothing armed', async (_name, row) => {
    const err = row.build()
    install(err)

    const { result, errArgs } = await killInAttempt()

    const outcome = notKilled(result)
    expect(outcome.errorClass).toBe(AD_ERROR_CLASS_CONFLICT)
    expect(outcome.error).toBe(err)
    expect(killCalls).toHaveLength(1)
    expect(statusCalls).toEqual([])
    expect(latch.record('C1')).toStrictEqual(expectedLatchRecord('C1', {
      latchCase: row.latchCase,
      refusedOperation: REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
      rowState: row.rowState,
      sessionName: row.sessionName,
      description: err.errDescription,
    }))
    expect(posts).toEqual([{ key: 'C1', text: row.notice.text }])
    const lines = stringLines(errArgs)
    expect(lines.slice(0, killLines(outcome).length)).toEqual(killLines(outcome))
    expect(lines.filter((l) => l.startsWith('[slack] killSession (restart adapter): kill refused for persona=C1: ') && l.includes(' — CONFLICT: the persona latched; '))).toHaveLength(1)
    expect(triggers).toEqual([])
    expect(starts).toEqual([])
  })

  // b.jg5 SRJ-110, SRJ-512 (E16 hatch note): an UNUSABLE NAME at the restart
  // path's kill latches C1 through E16's entry (refused operation none), with
  // the state the run's `dead` reading carries and no `status` read; one
  // SRJ-1019 notice.
  test.each(RESTART_KILL_UNUSABLE_NAME_CASE_ROWS.map((row) => [row.name, row] as const))('b.jg5 SRJ-110, SRJ-512, SRJ-501: UNUSABLE NAME at the kill (%s) → the UNUSABLE NAME non-success; C1 latched once through E16\'s entry, refused operation none, with the state the run\'s dead reading carries and no status read; one notice; one kill; nothing armed', async (_name, row) => {
    const err = row.build()
    install(err)

    const { result, errArgs } = await killInAttempt()

    const outcome = notKilled(result)
    expect(outcome.errorClass).toBe(AD_ERROR_CLASS_UNUSABLE_NAME)
    expect(outcome.error).toBe(err)
    expect(killCalls).toHaveLength(1)
    expect(statusCalls).toEqual([])
    expect(latch.record('C1')).toStrictEqual({ ...row.record('C1'), refusedOperation: REFUSED_OPERATION_NONE })
    expect(posts).toEqual([{ key: 'C1', text: row.notice('C1') }])
    const lines = stringLines(errArgs)
    expect(lines.slice(0, killLines(outcome).length)).toEqual(killLines(outcome))
    expect(lines.filter((l) => l.startsWith('[slack] killSession (restart adapter): kill refused for persona=C1: ') && l.includes(' — UNUSABLE NAME: '))).toHaveLength(1)
    expect(triggers).toEqual([])
  })

  // b.jg5 SRJ-501: the restart path's kill latch records the state its run
  // last read, carried by the `dead` reading the work hands the adapter
  // (`ended`, `missing`, or no row for ErrSpawnNotFound), with no extra
  // `status` call.
  describe('the latch records the state the run\'s dead reading carries (b.jg5 SRJ-501)', () => {
    const [conflictRow] = RESTART_KILL_CONFLICT_CASE_ROWS
    const [unusableRow] = RESTART_KILL_UNUSABLE_NAME_CASE_ROWS
    const READINGS: ReadonlyArray<readonly [string, DeadLivenessReading, LatchRowState]> = [
      ['ended', LIVENESS_READING_DEAD_ENDED, latchRowStateRead(LIVENESS_DEAD_ROW_ENDED)],
      ['missing', LIVENESS_READING_DEAD_MISSING, latchRowStateRead(LIVENESS_DEAD_ROW_MISSING)],
      ['no row (ErrSpawnNotFound)', LIVENESS_READING_DEAD_NO_ROW, LATCH_ROW_STATE_NO_ROW],
    ]

    test.each(READINGS)('CONFLICT at the kill after a dead reading of %s → C1 latched with that state; no status call', async (_label, lastRead, rowState) => {
      const err = conflictRow!.build()
      install(err)

      await killInAttempt('C1', undefined, lastRead)

      expect(statusCalls).toEqual([])
      expect(latch.record('C1')).toStrictEqual(expectedLatchRecord('C1', {
        latchCase: conflictRow!.latchCase,
        refusedOperation: REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
        rowState,
        sessionName: conflictRow!.sessionName,
        description: err.errDescription,
      }))
    })

    test.each(READINGS)('UNUSABLE NAME at the kill after a dead reading of %s → C1 latched with that state; no status call', async (_label, lastRead, rowState) => {
      install(unusableRow!.build())

      await killInAttempt('C1', undefined, lastRead)

      expect(statusCalls).toEqual([])
      expect(latch.record('C1')).toStrictEqual({ ...unusableRow!.record('C1'), rowState })
    })

    // The install-gone reading reads no row, so it carries no state: the one
    // latch-time `status` read gives it, its lines prefixed with the
    // adapter's site.
    test('CONFLICT at the kill after the install-gone dead reading → one latch-time status read, its state recorded', async () => {
      const err = conflictRow!.build()
      install(err)

      await killInAttempt('C1', undefined, { kind: LIVENESS_READING_DEAD.kind, source: LIVENESS_DEAD_SOURCE_INSTALL_GONE })

      expect(statusCalls.map((c) => c.instance_id)).toEqual([personaInstanceId('C1')])
      expect(latch.record('C1')?.rowState).toEqual(latchRowStateRead(LIVENESS_DEAD_ROW_ENDED))
    })

    test('CONFLICT at the kill after the install-gone dead reading, the latch-time status read answering UNUSABLE NAME → that read latches C1 (state unreadable), its line prefixed killSession (restart adapter); the CONFLICT sets nothing on top', async () => {
      const readErr = unusableRow!.build()
      install(conflictRow!.build(), cannedKillResult(true), readErr)

      const { errArgs } = await killInAttempt('C1', undefined, { kind: LIVENESS_READING_DEAD.kind, source: LIVENESS_DEAD_SOURCE_INSTALL_GONE })

      expect(statusCalls).toHaveLength(1)
      expect(latch.record('C1')).toStrictEqual({ ...unusableRow!.record('C1'), rowState: LATCH_ROW_STATE_UNREADABLE })
      const readLines = stringLines(errArgs).filter((l) => l.includes(' — UNUSABLE NAME: '))
      expect(readLines).toHaveLength(1)
      expect(readLines[0]).toStartWith('[slack] killSession (restart adapter): latch-time status read for ')
      expect(posts).toHaveLength(1)
    })
  })

  // b.jg5 SRJ-110 ("its guards stay"): the guards run first and are
  // unchanged; with a kill that would be refused, a launch in flight or an
  // unresolvable claude_config_dir still makes no kill, with the same line,
  // and answers the guard result.
  test('b.jg5 SRJ-110: launch in flight: no kill (the skip line only); answers the guard result, even with a kill that would be refused', async () => {
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

      expect(result).toBe(KILL_SESSION_NOT_KILLED_GUARD)
      expect(killCalls).toEqual([])
      expect(statusCalls).toEqual([])
      expect(stringLines(errArgs)).toEqual([
        '[slack] killSession (restart adapter): launch already in flight for persona=C1 — not killing',
      ])
    } finally {
      held.releaseAll()
      await launch
    }
  })

  test('b.jg5 SRJ-110: claude_config_dir cannot be resolved: no kill; answers the guard result, even with a kill that would be refused', async () => {
    const dangling = join(dir, 'dangling-config')
    symlinkSync(join(dir, 'nowhere'), dangling)
    const persona = makeStandInPersonaConfig({ C1: { claude_config_dir: dangling } }, dir).personas[0]!
    install(errTmuxUnresponsive('kill'))

    const { result, errArgs } = await killInAttempt('C1', (k) => (k === 'C1' ? persona : undefined))

    expect(result).toBe(KILL_SESSION_NOT_KILLED_GUARD)
    expect(killCalls).toEqual([])
    expect(statusCalls).toEqual([])
    const lines = stringLines(errArgs)
    expect(lines).toContain(
      '[slack] killSession (restart adapter): persona=C1 claude_config_dir cannot be resolved to a real path — not killing; its row is kept',
    )
    expect(lines.filter((l) => l.includes('kill for persona=C1'))).toEqual([])
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

describe('b.acu: reconnect adapter respects the checked delivery GONE recovery owner', () => {
  test.each([false, true])('delivery recovery starts a sequence=%s: only an unowned wait arms deferred reconnect', async startSequence => {
    const h = makeRecoveryHarness({ harnessNow: true })
    const key = h.keys[0]!
    const life = createDeliveryLifecycle({ startId: 'gone-adapter', clock: h.clock })
    _setDeliveryLifecycle(life)
    setDeliveryPersonaLookup(appliedLookupOf(h))
    let row = personaRow(h, key, { state: 'waiting' })
    h.script({ getFn: () => row, killFn: () => { row = { ...row, state: 'missing' }; return {} } })
    const hold = holdFindMissing(h.stub.client)
    const handedOff: boolean[] = []
    life.setRecovery(async () => {
      if (startSequence) handedOff.push(recoverDeliveryGone(key, row, life.launchId(key)))
      return false
    })
    try {
      const reconnect = _buildReconnectSessionAdapter(undefined, k => h.latch.isLatched(k), appliedLookupOf(h))
      expect(await reconnect(key)).toBe('transient')
      if (startSequence) {
        await h.driveSequence(hold.entered(1))
        expect(handedOff).toEqual([true])
        expect(h.sequenceRunning(key)).toBe(true)
        expect(life.deferred(key)).toBeUndefined()
        // An overlapping reconnect sees the sequence during upgrade
        // inspection and must still leave it as the only recovery owner.
        expect(await reconnect(key)).toBe('transient')
        expect(life.deferred(key)).toBeUndefined()
        expect(h.stub.calls.killCalls).toHaveLength(1)
      } else {
        expect(life.deferred(key)).toEqual({ due: false })
        expect(h.stub.calls.killCalls).toEqual([])
      }
      expect(h.stub.calls.sendKeysCalls).toEqual([])
      expect(h.stub.calls.readPaneCalls).toEqual([])
      expect(h.stub.calls.resumeCalls).toEqual([])
      expect(h.stub.calls.deleteCalls).toEqual([])
      assertNoLeak(h.captured())
    } finally {
      h.shutdown()
      hold.releaseAll()
      await h.driveSequence(h.sequenceSettled(key))
      await life.stop()
      _setDeliveryLifecycle(undefined)
      setDeliveryPersonaLookup(() => undefined)
      h.cleanup()
    }
  })
})
