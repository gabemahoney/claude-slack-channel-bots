/**
 * persona-lifecycle.test.ts — The persona teardown, the apply bring-up (and
 * the recovery bring-up of a credentials-broken persona), the credentials
 * change and the in-place update (`createPersonaLifecycle`,
 * src/persona-lifecycle.ts; b.av2 SR-6.1, SR-6.2, SR-6.4, SR-6.5, SR-6.6,
 * SR-8.6).
 *
 * Every lifecycle here runs through a real `createPersonaSerializer`. The
 * dependencies are recorders by default (each call appends `<dep>:<arg>` to
 * one shared trail, so order and the key are both asserted), replaced by the
 * real module where the case is about that module:
 * - the notice window (b.jg5 SRJ-1003, SRJ-1002): the recorders trail the
 *   notifier's submit, window open and close and submit end too, so the
 *   window is shown open before the turn's first step and closed after its
 *   last;
 * - the agent-director kill (b.jg5 SRJ-715, SRJ-110, SRJ-702) and AC 65: the
 *   real teardown kill entry (`killPersonaInstanceForTeardown`, the bounded
 *   retry on a fake clock whose waits the case drives) over `makeStubClient`,
 *   with the real outage state (`resetAllToHealthy`), the real notifier with
 *   its teardown window, destination resolver and destination hold
 *   (`makeNotifierHarness`, fake clock), and the real kill-failure alerts and
 *   unclassified-error episodes over real notice episodes whose sink is that
 *   notifier, bound as `main()` binds them (context 'persona teardown'). The
 *   notifier's startup-errors entries and the alerts' log-only entries are
 *   read back from the test's temp `logDir`; their class and text come from
 *   `src/`'s constant and builders. There is no delete: the row is kept
 *   whatever the kill answers;
 * - the teardown end to end (b.jg5 SRJ-715): the recovery harness's
 *   `teardownDeps()` (the real approver and live-row sequence stops, retry
 *   controller, latch, hold, notice episodes, outage state and bounded-retry
 *   kill, bound as `main()` binds them), what P holds set through the
 *   harness's real routes, each left-over read through its module's query;
 * - the ack-reaction entries: the real ack tracker's `forgetPersonaAcks`;
 * - the notice episodes (b.jg5 SRJ-1016): a real `createPersonaEpisodes`
 *   instance on a fake clock, its `forget` as `forgetNoticeEpisodes`;
 * - the latch (b.jg5 SRJ-504): a real `createConflictLatch` with the CONFLICT
 *   notice bound to real notice episodes over a recording sink (handing each
 *   notice on to the real notifier where the case is about the window), its
 *   `forget` as `forgetConflictLatch`;
 * - the `ErrInvalidFlags` hold (b.jg5 SRJ-207, SRJ-715): a real
 *   `createInvalidFlagsHold` with its set reaction bound to real notice
 *   episodes over a recording sink (on to the real notifier as above), its
 *   `forget` as `forgetInvalidFlagsHold`;
 * - serialization behind a restart: the real restart module
 *   (`initRestart` with `serialize`, real `cancelRestartTimer`). Its timer is
 *   a real `setTimeout` (1 ms here; it takes no fake clock), waited for by a
 *   1 ms-step poll. Beside it, the real UNAVAILABLE retry controller on a
 *   fake clock (its `stop` with the torn-down reason as `stopRetryTimer`,
 *   recorded in the trail), with A's and B's timers armed and never fired;
 * - serialization behind a bring-up retry, the recovery bring-up of a
 *   persona broken by its credentials, and confirmed credentials changes
 *   (the controller's `changeCredentials` called directly, and through the
 *   lifecycle): the real bring-up controller over the real connection manager
 *   (`makeControllerStack` over `makeConnectionHarness`, fake clock), each
 *   rewritten credentials file registered as its own stub credential set.
 *
 * Isolation (b.av2 SR-13.2): persona paths under a per-test `mkdtempSync`
 * directory, fake tokens only, no real agent-director, no Slack post.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { MakeTemplateParams } from 'agent-director'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import type { Persona, PersonaConfig } from '../src/config.ts'
import { resetClientForTests, setClientForTests, getClient } from '../src/agent-director-client.ts'
import { ErrSystemInstallDisappeared } from '../src/agent-director-errors.ts'
import { _resetAckTracker, consumeAck, forgetPersonaAcks, trackAck } from '../src/ack-tracker.ts'
import { _resetBackoffState } from '../src/backoff.ts'
import {
  bindConflictNotice,
  CONFLICT_LATCH_SET_LATCHED,
  CONFLICT_LATCH_SET_SAME_CASE,
  conflictNoticeText,
  createConflictLatch,
  LATCH_CASE_LEFTOVER,
  LATCH_CASE_OWN_ID,
  LATCH_ROW_STATE_NO_ROW,
  latchRowStateRead,
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_RESUME,
  type ConflictLatch,
  type ConflictLatchRecord,
  type ConflictLatchSetInput,
} from '../src/conflict-latch.ts'
import {
  _resetOutageState,
  clearOutageFlag,
  type OutageClass,
  getOutageFlags,
  initOutageState,
  resetAllToHealthy,
  setOutageFlag,
  withOutageDetection,
} from '../src/outage-state.ts'
import {
  createPersonaBringUpController,
  type CredentialsChangeConnections,
  type CredentialsChangeHooks,
  type CredentialsSwap,
  type PersonaBringUpController,
  type PersonaBringUpResultSummary,
  type PersonaBringUpState,
  type PersonaCredentialsChangeResult,
} from '../src/persona-bringup-controller.ts'
import { checkPersonaConfigDir } from '../src/persona-bringup.ts'
import { credentialsDigest, readCredentialsFile } from '../src/persona-credentials.ts'
import {
  createKillFailureAlerts,
  createPersonaEpisodes,
  createUnclassifiedErrorEpisodes,
  PERSONA_UNCLASSIFIED_ERROR_LABEL,
  unclassifiedErrorAlertText,
  type UnclassifiedErrorEpisodes,
  PERSONA_EPISODE_KIND_CONFLICT,
  PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD,
  PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE,
  PERSONA_EPISODE_KINDS,
  type PersonaEpisodes,
} from '../src/persona-episodes.ts'
import {
  bindInvalidFlagsHoldSetReaction,
  createInvalidFlagsHold,
  INVALID_FLAGS_HOLD_ALERT_TEXT,
  invalidFlagsHoldForgetLine,
  type InvalidFlagsHold,
} from '../src/invalid-flags-hold.ts'
import {
  PERSONA_CONFIG_DIR_UNRESOLVABLE,
  PERSONA_CREDENTIALS_CHANGE_FAILED,
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_CREDENTIALS_MISSING,
  PERSONA_CREDENTIALS_REFUSED,
  PERSONA_DIRECTORY_MISSING,
  PERSONA_SLACK_UNREACHABLE,
} from '../src/persona-diagnostics.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import {
  createPersonaLifecycle,
  LIVE_ROW_SEQUENCE_STOP_AGAIN_STEP,
  LIVE_ROW_SEQUENCE_STOP_STEP,
  OLD_LIFE_WAITS_STEP,
  TEARDOWN_RETRY_TIMER_STOP_AFTER_KILL_STEP,
  type PersonaLifecycle,
  type PersonaLifecycleDeps,
} from '../src/persona-lifecycle.ts'
import { createPersonaSerializer, type PersonaSerializer } from '../src/persona-serializer.ts'
import type { PersonaBringUpStep } from '../src/persona-start.ts'
import type { InPlaceApplyInput } from '../src/reload-apply.ts'
import type { InPlaceSetting } from '../src/reload-plan.ts'
import {
  _resetRestartState,
  cancelAllRestartTimers,
  cancelRestartTimer,
  initRestart,
  isRestartPendingOrActive,
  RESTART_OUTCOME_LAUNCHED,
  runRestartRetry,
  scheduleRestart,
} from '../src/restart.ts'
import { LIVENESS_READING_DEAD } from '../src/liveness-reading.ts'
import {
  APPROVER_LOG_PREFIX,
  APPROVER_STOP_TEARDOWN,
  _resetConfiguredPersonaQuery,
  _whenDialogApproverStopped,
  approverLogLine,
  approverNotStartedMessage,
  killPersonaInstanceForTeardown,
  oldLifeWaitTeardownLine,
  setConfiguredPersonaQuery,
  setConflictLatch,
  stopLiveRowSequence,
  whenLaunchSettled,
  type PersonaTeardownKillRefusal,
  type PersonaTeardownKillResult,
} from '../src/session-manager.ts'
import { LIVE_ROW_OUTCOME_STOPPED, LIVE_ROW_STOP_HOLD_ENDED, LIVE_ROW_STOP_TEARDOWN } from '../src/live-row-sequence.ts'
import { UNAVAILABLE_RETRY_ROW_ABSENT } from '../src/unavailable-retry.ts'
import {
  callCounts,
  callCountsSince,
  holdThroughReuse,
  makeRecoveryHarness,
  ordinaryAlertContent,
  personaOf,
  rowReadsUntilSpawn,
  scriptLiveRowElsewhere,
  survivorAlertContent,
  type RecoveryHarness,
} from './test-helpers/recovery-harness.ts'
import { PRE_PERSONA_ID, holdOldAt } from './test-helpers/old-life.ts'
import { conflictForPersona } from './test-helpers/conflict-cases.ts'
import {
  KILL_RETRY_ALERT_NONE,
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_ALERT_SURVIVOR,
  KILL_RETRY_END_EXHAUSTED,
  KILL_RETRY_END_SETTLED,
  KILL_RETRY_SPACING_MS,
  KILL_RETRY_TRIES,
  type KillRetryAlert,
} from '../src/kill-retry.ts'
import {
  KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN,
  KILL_FAILURE_VERSION_ORDINARY,
  PERSONA_KILL_FAILED_LABEL,
  PERSONA_KILL_SURVIVOR_LABEL,
  killFailureAlertText,
  selectKillFailureAlertRoute,
  type KillFailureAlertContent,
} from '../src/kill-failure-alert.ts'
import {
  PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER,
  PERSONA_TEARDOWN_NOTICE_LABEL,
  PERSONA_TEARDOWN_NOTICE_RAISED,
  formatPersonaNotice,
} from '../src/persona-notifier.ts'
import { recordStartupError } from '../src/startup-errors.ts'
import {
  KILL_OUTCOME_KILLED,
  KILL_OUTCOME_NOT_KILLED,
  KILL_OUTCOME_ROW_GONE,
  KILL_OUTCOME_SESSION_GONE,
  KILL_REFUSAL_AT_KILL,
  KILL_REFUSAL_AT_READ,
  describeKillOutcome,
  killOutcomeOf,
  teardownKillNotSucceededNoticeText,
  teardownKillRefusalNoticeText,
  type KillFailure,
  type KillOutcome,
} from '../src/checked-kill.ts'
import {
  RECHECK_OUTCOME_PASS,
  RECHECK_OUTCOME_STOP,
  installAdVersionRecheck,
  resetAdVersionRecheckForTests,
} from '../src/ad-version-gate.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  classifyAdError,
  killFailedDescriptionOf,
} from '../src/ad-error-class.ts'
import type { Phase1KillResult, Phase1StatusResult } from '../src/ad-phase1-types.ts'
import {
  createUnavailableRetryController,
  runInAttempt,
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_PENDING_ROW,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_STOP_SHUTDOWN,
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  type UnavailableRetryController,
} from '../src/unavailable-retry.ts'
import {
  cannedErr,
  cannedKillResult,
  cannedOk,
  cannedStatusResult,
  errCallTimeout,
  errConfigMalformed,
  errGeneric,
  errInternal,
  errInstanceIdCollision,
  errInvalidFlags,
  errSpawnNotFound,
  errSpawnNotResumable,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSendKeys,
  errTmuxSessionConflict,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  makeStubResolveSystemBinary,
  type StubResolveSystemBinaryOutcome,
  errUnknownErrorName,
  errUnusableName,
  cannedFindMissing,
  cannedGetResult,
  holdFindMissing,
  holdSpawns,
  makeStubCallLog,
  makeStubClient,
  SAMPLE_LAUNCH_START_NONE,
  stubCallCount,
  type CannedResponse,
} from './test-helpers/agent-director-stub.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, LEAK_SENTINEL, assertNoLeak, fakeToken, sentinelInMessage, writeCredentialsFile } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeConnectionHarness, type ConnectionHarness, type ConnectionHarnessOptions } from './test-helpers/persona-connection-harness.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import {
  makeNotifierHarness,
  readStartupEntries,
  teardownNoticeEntry,
  teardownNoticeLine,
  type NotifierHarness,
  type StartupEntry,
} from './test-helpers/persona-notifier.ts'
import { INITIAL_CREDENTIALS, makeDeferredWebApiCall, type WebApiOutcome } from './test-helpers/slack-stub.ts'


/** The kill's success the fixture's `killInstance` answers: `kill_sent: true` (b.jg5 SRJ-701). */
const KILL_SUCCEEDED: KillOutcome = { kind: KILL_OUTCOME_KILLED, killSent: true }

/** The teardown kill's result the fixture's `killInstance` answers: one try, `KILL_SUCCEEDED`, no alert. */
const KILL_RESULT_SUCCEEDED: PersonaTeardownKillResult = {
  outcome: KILL_SUCCEEDED,
  end: KILL_RETRY_END_SETTLED,
  tries: 1,
  reads: 0,
  alert: { kind: KILL_RETRY_ALERT_NONE },
  refusals: [],
}

// ---------------------------------------------------------------------------
// Temp directory, console capture and module state
// ---------------------------------------------------------------------------

let dir: string
/** Silences console.error (the restart module logs there). */
let consoleSpy: ReturnType<typeof spyOn> | undefined
/** Controllers and harnesses built in the running test: cancelled and stopped after it. */
const cleanups: Array<() => void | Promise<void>> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cscb-lifecycle-'))
  consoleSpy = spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  cancelAllRestartTimers()
  _resetRestartState()
  _resetBackoffState()
  _resetOutageState()
  _resetAckTracker()
  resetClientForTests()
  consoleSpy?.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

/** Every line logged to console.error in the running test (the teardown kill's tries and reads are logged there), as text. */
function consoleLines(): string[] {
  return (consoleSpy?.mock.calls ?? []).map((call: unknown[]) => String(call[0]))
}

/** Let pending promise continuations run (no timer involved). */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/** Whether `p` settled (either way) once pending continuations ran. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  await flush()
  return done
}

/** Poll in 1 ms steps (2 s cap) until `cond` holds: only for the restart module's real timer. */
async function until(cond: () => boolean): Promise<void> {
  for (let waited = 0; !cond(); waited++) {
    if (waited > 2_000) throw new Error('until: condition not reached in 2 s')
    await Bun.sleep(1)
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const NAME_A = 'Alpha Desk'
const NAME_B = 'Beta Ops'

/** Two personas under the test dir; B has its own claude_config_dir (the launch pass re-evaluates it). */
function makeConfig(): PersonaConfig {
  return makeMultiPersonaConfig(
    [{ name: NAME_A }, { name: NAME_B, claude_config_dir: join(dir, 'beta-claude') }],
    dir,
  )
}

/** Dependency names the recorder fixture can make fail. */
type DepName =
  | 'bringUps.cancel' | 'bringUps.bringUp' | 'bringUps.state' | 'bringUps.changeCredentials' | 'cancelRestartTimer' | 'stopRetryTimer' | 'cancelLaunchWait'
  | 'stopApprover' | 'stopLiveRowSequence' | 'whenLaunchSettled' | 'connections.stop'
  | 'routing.forget' | 'forgetAcks' | 'destinations.forget' | 'destinationHold.cancel' | 'notifier.forget' | 'forgetPersonaPrompts'
  | 'notifier.notify' | 'notifier.submitTeardown' | 'notifier.settleTeardown' | 'notifier.openTeardownWindow' | 'notifier.closeTeardownWindow'
  | 'dropSession' | 'resetOutageState' | 'killInstance' | 'raiseKillFailureAlert' | 'forgetFailures'
  | 'forgetDisconnectedStreak' | 'forgetNotConnectedEpisode' | 'forgetConflictLatch' | 'forgetInvalidFlagsHold' | 'forgetNoticeEpisodes' | 'replyGuard.launchedWithDir' | 'replyGuard.teardown' | 'replyGuard.launchPass'
  | 'storageCheck' | 'launch' | 'connections.reconnectCredentials' | 'connections.replaceRetryTokens'

/** Dependencies whose production form returns a promise: their failure is a rejection, the others' a throw. */
const ASYNC_DEPS = new Set<DepName>([
  'bringUps.bringUp', 'bringUps.changeCredentials', 'stopApprover', 'stopLiveRowSequence', 'whenLaunchSettled', 'connections.stop', 'connections.reconnectCredentials',
  'dropSession', 'killInstance', 'launch', 'notifier.notify',
])

/** A thrown value whose message carries a fake token: the log line must not show it. */
function failure(): Error {
  return new Error(`step exploded with ${fakeToken(BOT_TOKEN_PREFIX, 'lifecycle')}`)
}

interface FixtureOptions {
  dryRun?: boolean
  /** Dependencies that fail (async ones reject, the others throw) with `failure()`. */
  fail?: readonly DepName[]
  /** With `fail`: every failing dependency returns a rejected promise, a synchronous one included (a step run without awaiting). */
  rejectFailures?: boolean
  /** What the recording `launchedWithDir` returns. */
  launchedWith?: string
  /** What the recording `whenLaunchSettled` returns for a key (default: resolved). */
  launchInFlight?: (key: string) => Promise<void>
  /** What the recording `bringUps.bringUp` resolves with. */
  bringUpResult?: PersonaBringUpResultSummary
  /** What the recording `bringUps.state` returns, read at each call (default: undefined, an unknown persona). */
  state?: () => PersonaBringUpState | undefined
  /** What the recording `bringUps.changeCredentials` resolves with (default: `swapped`). It never calls the hook itself. */
  changeResult?: PersonaCredentialsChangeResult
  /** What the recording `killInstance` resolves with (default: `KILL_RESULT_SUCCEEDED`). */
  killResult?: PersonaTeardownKillResult
  /** Replace any dependency (real modules); the trail then records only the recorders left. */
  overrides?: Partial<PersonaLifecycleDeps>
}

interface Fixture {
  lifecycle: PersonaLifecycle
  serializer: PersonaSerializer
  config: PersonaConfig
  a: Persona
  b: Persona
  /** The applied persona set `appliedPersonas` returns; starts as [A] (B's removal applied). */
  applied: Persona[]
  /** Every recorder call, in order: `<dep>:<argument>`. */
  trail: string[]
  /** Every lifecycle log line. */
  lines: string[]
  /** Keys submitted to the serializer through the lifecycle. */
  submitted: string[]
  /** The connections the lifecycle was given (its `deps.connections`). */
  connections: PersonaLifecycleDeps['connections']
  /** Every recording `bringUps.changeCredentials` call's connections and hooks, in order. */
  changeCalls: Array<{ connections: CredentialsChangeConnections; hooks: CredentialsChangeHooks | undefined }>
  /** Every `makeTemplate` call the template refresh made on its stub agent-director client, in order. */
  templateCalls: MakeTemplateParams[]
}

/**
 * What the boot install wrote (the template refresh's `installed`): every
 * field but `allow` must reach the refresh unchanged. Its fields differ from
 * what `buildTemplateParams` would give, so a refresh built from anything
 * else shows.
 */
const INSTALLED_TEMPLATE: MakeTemplateParams = {
  name: 'slack-channel-bot',
  label: ['app=cscb'],
  relay_mode: 'on',
  claude_args: ['--dangerously-load-development-channels', 'server:slack-channel-router', '--mcp-config', '/start/mcp.json'],
  allow: ['Read(//start/claude/projects/*/memory/**)'],
  deny: ['Read(//start/secret/**)'],
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const config = makeConfig()
  const [a, b] = config.personas as [Persona, Persona]
  const trail: string[] = []
  const lines: string[] = []
  const submitted: string[] = []
  const changeCalls: Fixture['changeCalls'] = []
  const templateCalls: MakeTemplateParams[] = []
  const applied: Persona[] = [a]
  const serializer = createPersonaSerializer()
  const fails = new Set(opts.fail ?? [])

  /** A recorder for `name`: appends `<name>:<describe(args)>`, then fails if asked, else returns `value()`. */
  function rec<A extends unknown[], R>(name: DepName, describe: (...args: A) => string, value: (...args: A) => R) {
    return (...args: A): R => {
      trail.push(`${name}:${describe(...args)}`)
      if (fails.has(name)) {
        if (ASYNC_DEPS.has(name) || opts.rejectFailures === true) return Promise.reject(failure()) as R
        throw failure()
      }
      return value(...args)
    }
  }
  const byKey = (key: string) => key
  const byPersona = (p: Persona) => p.key

  const deps: PersonaLifecycleDeps = {
    serialize: (key, op) => {
      submitted.push(key)
      return serializer.run(key, op)
    },
    bringUps: {
      cancel: rec('bringUps.cancel', byKey, () => undefined),
      bringUp: rec(
        'bringUps.bringUp',
        (p: Persona, set: readonly Persona[]) => `${p.key}:[${set.map((x) => x.key).join(',')}]`,
        async () => opts.bringUpResult ?? { outcome: 'up' as const, failures: [] },
      ),
      state: rec('bringUps.state', byKey, () => opts.state?.()),
      changeCredentials: rec(
        'bringUps.changeCredentials',
        (p: Persona, set: readonly Persona[], _connections: CredentialsChangeConnections, _hooks?: CredentialsChangeHooks) =>
          `${p.key}:[${set.map((x) => x.key).join(',')}]`,
        async (_p: Persona, _set: readonly Persona[], connections: CredentialsChangeConnections, hooks?: CredentialsChangeHooks) => {
          changeCalls.push({ connections, hooks })
          return opts.changeResult ?? { kind: 'swapped' as const }
        },
      ),
    },
    connections: {
      stop: rec('connections.stop', byKey, async () => undefined),
      // Handed to the controller's changeCredentials only: the lifecycle never calls them itself.
      reconnectCredentials: rec('connections.reconnectCredentials', byKey, async () => ({ kind: 'cancelled' as const })),
      replaceRetryTokens: rec('connections.replaceRetryTokens', byKey, () => false),
    },
    routing: { forget: rec('routing.forget', byKey, () => undefined) },
    forgetAcks: rec('forgetAcks', byKey, () => undefined),
    destinations: { forget: rec('destinations.forget', byKey, () => undefined) },
    destinationHold: { cancel: rec('destinationHold.cancel', byKey, () => undefined) },
    notifier: {
      forget: rec('notifier.forget', byKey, () => undefined),
      notify: rec('notifier.notify', (key: string, text: string) => `${key}:${text}`, async () => undefined),
      submitTeardown: rec('notifier.submitTeardown', byKey, () => undefined),
      settleTeardown: rec('notifier.settleTeardown', byKey, () => undefined),
      openTeardownWindow: rec('notifier.openTeardownWindow', (p: Pick<Persona, 'name' | 'key'>) => p.key, () => undefined),
      closeTeardownWindow: rec('notifier.closeTeardownWindow', byKey, () => undefined),
    },
    appliedPersonas: () => [...applied], // a fresh array per read, as the server's getter over a swapped config
    dryRun: opts.dryRun ?? false,
    isShuttingDown: () => false,
    log: (line) => void lines.push(line),
    stopApprover: rec('stopApprover', byKey, async () => false),
    stopLiveRowSequence: rec('stopLiveRowSequence', byKey, async () => false),
    whenLaunchSettled: rec('whenLaunchSettled', byKey, (key: string) => opts.launchInFlight?.(key) ?? Promise.resolve()),
    cancelRestartTimer: rec('cancelRestartTimer', byKey, () => false),
    stopRetryTimer: rec('stopRetryTimer', byKey, () => undefined),
    cancelLaunchWait: rec('cancelLaunchWait', byKey, () => false),
    forgetFailures: rec('forgetFailures', byKey, () => undefined),
    forgetDisconnectedStreak: rec('forgetDisconnectedStreak', byKey, () => undefined),
    forgetNotConnectedEpisode: rec('forgetNotConnectedEpisode', byKey, () => undefined),
    forgetConflictLatch: rec('forgetConflictLatch', byKey, () => false),
    forgetInvalidFlagsHold: rec('forgetInvalidFlagsHold', byKey, () => false),
    forgetNoticeEpisodes: rec('forgetNoticeEpisodes', byKey, () => undefined),
    resetOutageState: rec('resetOutageState', (keys: string[]) => keys.join(','), () => undefined),
    forgetPersonaPrompts: rec('forgetPersonaPrompts', byKey, () => 0),
    dropSession: rec('dropSession', byKey, async () => false),
    killInstance: rec('killInstance', byKey, async (): Promise<PersonaTeardownKillResult> => opts.killResult ?? KILL_RESULT_SUCCEEDED),
    raiseKillFailureAlert: rec('raiseKillFailureAlert', (key: string, decision: KillRetryAlert) => `${key}:${decision.kind}`, () => undefined),
    replyGuard: {
      launchedWithDir: rec('replyGuard.launchedWithDir', byKey, () => opts.launchedWith),
      teardown: rec('replyGuard.teardown', byKey, () => undefined),
      launchPass: rec(
        'replyGuard.launchPass',
        (dirs: readonly (string | undefined)[], personas: readonly Persona[]) =>
          `${JSON.stringify(dirs)}:[${personas.map((p) => p.key).join(',')}]`,
        () => undefined,
      ),
    },
    storageCheck: rec('storageCheck', byPersona, () => undefined),
    launch: rec('launch', byPersona, async () => ({ key: 'x', action: 'spawned' })),
    templateRefresh: {
      installed: INSTALLED_TEMPLATE,
      getClient: () => makeStubClient({ makeTemplateCalls: templateCalls }),
    },
    ...opts.overrides,
  }
  return {
    lifecycle: createPersonaLifecycle(deps), serializer, config, a, b, applied, trail, lines, submitted,
    connections: deps.connections, changeCalls, templateCalls,
  }
}

/** The teardown line prefix for `p`. */
function teardownPrefix(p: Persona): string {
  return `[slack] persona teardown of ${renderPersonaRef(p.name, p.key)}`
}

/**
 * The teardown's line naming its kill's outcome for `p` after `tries`
 * kill(s), the row kept (b.jg5 SRJ-715, SRJ-701, SRJ-1014), logged when the
 * kill succeeded: `outcome` is the fixture's `KILL_SUCCEEDED` unless given
 * (the real kill over the stub's default result answers `kill_sent` absent).
 */
function killOutcomeLine(p: Persona, outcome: KillOutcome = KILL_SUCCEEDED, tries = 1): string {
  return `${teardownPrefix(p)}: agent-director kill of ${personaInstanceId(p.key)}: ${describeKillOutcome(outcome)} after ${tries} kill(s); the row is kept (b.jg5 SRJ-715)`
}

/**
 * The teardown's kill-step failure line for `p` whose kill's standing
 * outcome is `outcome` after `tries` kill(s): the row is kept, nothing
 * latches and no retry timer is armed (b.jg5 SRJ-715, SRJ-110).
 */
function killFailedLine(p: Persona, outcome: KillOutcome, tries: number): string {
  return (
    `${teardownPrefix(p)}: agent-director kill of ${personaInstanceId(p.key)} failed: ${describeKillOutcome(outcome)} after ${tries} kill(s) — ` +
    'the row is kept; nothing latches and no retry timer is armed (b.jg5 SRJ-715, SRJ-110)'
  )
}

/** The teardown's one line for `p` when its kill answered a malformed kill-failure alert decision: nothing is raised (b.jg5 SRJ-704). */
function malformedAlertLine(p: Persona): string {
  return (
    `${teardownPrefix(p)}: agent-director kill of ${personaInstanceId(p.key)}: it answered a malformed kill-failure alert decision — ` +
    'no kill-failure alert is raised (b.jg5 SRJ-704)'
  )
}

/** A teardown's lines when every step succeeds: starting, its kill's outcome line, complete. */
function cleanTeardownLines(p: Persona, outcome: KillOutcome = KILL_SUCCEEDED, tries = 1): string[] {
  return [`${teardownPrefix(p)}: starting`, killOutcomeLine(p, outcome, tries), `${teardownPrefix(p)}: complete`]
}

/**
 * The start of the teardown's turn for `p`, before its first step (b.jg5
 * SRJ-1002, SRJ-1003): its outage state forgotten silently, then its notice
 * window opened.
 */
function turnStart(p: Persona): string[] {
  return [`resetOutageState:${p.key}`, `notifier.openTeardownWindow:${p.key}`]
}

/**
 * The end of the teardown's turn for `p`, after its last step, whatever a
 * step threw (b.jg5 SRJ-1003): its notice window closed, then its submit
 * ended.
 */
function turnEnd(p: Persona): string[] {
  return [`notifier.closeTeardownWindow:${p.key}`, `notifier.settleTeardown:${p.key}`]
}

/**
 * The teardown's own steps for `p` (its serializer turn), outside dry run,
 * with the recorders' defaults (b.jg5 SRJ-715): its outage state forgotten
 * and its notice window opened (`turnStart`); then, first, before the wait
 * for its launch in flight, its dialog approver, its live-row sequence and
 * its UNAVAILABLE retry timer are stopped and its latch, `ErrInvalidFlags`
 * hold and notice episodes forgotten, in that order (b.jg5 SRJ-404, SRJ-706,
 * SRJ-305, SRJ-504, SRJ-207, SRJ-1016); then its bring-up retries and
 * restart timer are cancelled and the launch's wait for a `working` row
 * cancelled again (b.f2b) right before the teardown waits for the launch;
 * once that launch settled, the sequence, the retry timer, the latch, the
 * hold and the episodes go again (the launch can have started a sequence at
 * a collision ladder replacement site, b.jg5 SRJ-707, armed the timer, set a
 * latch or a hold, or opened an episode); then the Slack connection and the
 * session state, its held notices dropped once (`notifier.forget`); the kill
 * made (no delete: the row is kept) and, after it, the retry timer stopped
 * once more (the kill arms none, b.jg5 SRJ-110), the failure count, health
 * streak and not-connected episode forgotten and the latch forgotten once
 * more; then the reply guard; then the window closed and the submit ended
 * (`turnEnd`). The outage state is not forgotten after the kill, and no
 * notice is dropped after it (b.jg5 SRJ-1002, SRJ-1003). No alert is raised
 * for the fixture's default kill (its decision is `none`).
 */
function teardownTurnTrail(p: Persona, launchPass: string): string[] {
  const k = p.key
  return [
    ...turnStart(p),
    `stopApprover:${k}`, `stopLiveRowSequence:${k}`, `stopRetryTimer:${k}`,
    `forgetConflictLatch:${k}`, `forgetInvalidFlagsHold:${k}`, `forgetNoticeEpisodes:${k}`,
    `bringUps.cancel:${k}`, `cancelRestartTimer:${k}`, `cancelLaunchWait:${k}`, `whenLaunchSettled:${k}`,
    `stopLiveRowSequence:${k}`, `stopRetryTimer:${k}`, `forgetConflictLatch:${k}`, `forgetInvalidFlagsHold:${k}`, `forgetNoticeEpisodes:${k}`,
    `connections.stop:${k}`, `routing.forget:${k}`, `forgetAcks:${k}`, `destinations.forget:${k}`, `destinationHold.cancel:${k}`,
    `notifier.forget:${k}`, `forgetPersonaPrompts:${k}`, `dropSession:${k}`,
    `killInstance:${k}`, `stopRetryTimer:${k}`,
    `forgetFailures:${k}`, `forgetDisconnectedStreak:${k}`, `forgetNotConnectedEpisode:${k}`, `forgetConflictLatch:${k}`,
    `replyGuard.launchedWithDir:${k}`, `replyGuard.teardown:${k}`, `replyGuard.launchPass:${launchPass}`,
    ...turnEnd(p),
  ]
}

/**
 * What every teardown runs at submit, before its turn: its submit registered
 * with the notifier (b.jg5 SRJ-1003: from here the key's notice episodes
 * post nothing), then its dialog approver stopped (b.jg5 SRJ-404, SRJ-715),
 * its live-row sequence right after (b.jg5 SRJ-706), then its launch's wait
 * for a `working` row cancelled (b.f2b).
 */
function submitCancels(p: Persona): string[] {
  return [`notifier.submitTeardown:${p.key}`, `stopApprover:${p.key}`, `stopLiveRowSequence:${p.key}`, `cancelLaunchWait:${p.key}`]
}

/**
 * The full teardown trail for `p`, a key no longer applied: its submit-time
 * cancels (every teardown), then its turn.
 */
function fullTeardownTrail(p: Persona, launchPass: string): string[] {
  return [...submitCancels(p), ...teardownTurnTrail(p, launchPass)]
}

/**
 * The teardown trail for a key still applied when it is submitted (the old
 * half of a destructive modify): its submit registered, its dialog approver
 * stopped, its launch's wait, bring-up retries and restart timer cancelled
 * and its UNAVAILABLE retry timer stopped at submit, before its turn, then
 * its turn, the same as a removed key's: its held notices are dropped once,
 * with the connection drops, and never again after the kill (b.jg5
 * SRJ-1003: a notice raised in the window is written, never held).
 */
function stillAppliedTeardownTrail(p: Persona, launchPass: string): string[] {
  return [
    ...submitCancels(p), `bringUps.cancel:${p.key}`, `cancelRestartTimer:${p.key}`, `stopRetryTimer:${p.key}`,
    ...teardownTurnTrail(p, launchPass),
  ]
}

/** `trail` up to and including the teardown's wait for `p`'s launch in flight. */
function untilLaunchSettled(trail: string[], p: Persona): string[] {
  return trail.slice(0, trail.indexOf(`whenLaunchSettled:${p.key}`) + 1)
}

/** The launch-pass record for B's config dir and `launchedWith`, against the applied set [A]. */
function launchPassOf(f: Fixture, launchedWith: string | undefined): string {
  return `${JSON.stringify([f.b.claude_config_dir, launchedWith])}:[${f.a.key}]`
}

/** The real bring-up controller over the real connection manager, and a lifecycle over them. */
interface ControllerStack {
  h: ConnectionHarness
  controller: PersonaBringUpController
  /** The lifecycle fixture: its `bringUps` is the controller, its `connections` the manager; the rest are recorders. */
  f: Fixture
  a: Persona
  b: Persona
  /** Keys the controller launched itself (after a retry, or once a credentials swap brought a refused persona back up). */
  launches: string[]
}

/**
 * The bring-up controller's claude_config_dir check against a scratch home
 * `<base>/home` holding a real `.claude`, so no bring-up here depends on the
 * process home (a dangling `$HOME/.claude` would hold every persona).
 */
function configDirCheckUnder(base: string): (persona: Persona) => ReturnType<typeof checkPersonaConfigDir> {
  const home = join(base, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  return (persona) => checkPersonaConfigDir(persona, { home })
}

/**
 * A and B on the connection harness with their files (not brought up yet).
 * The controller reads the harness's applied set, runs its retry work
 * through `f`'s serializer and logs into `h.lines`; teardown cancels it,
 * stops the manager and asserts no fake-clock timer is left.
 */
function makeControllerStack(opts: {
  stubOptions?: ConnectionHarnessOptions['stubOptions']
  /** What the controller's launch does after recording the key. */
  launch?: (p: Persona) => Promise<unknown>
  /** Further lifecycle dependency overrides. */
  overrides?: Partial<PersonaLifecycleDeps>
} = {}): ControllerStack {
  const h = makeConnectionHarness([{ name: NAME_A }, { name: NAME_B }], dir, { files: true, stubOptions: opts.stubOptions })
  const [a, b] = h.personas as [Persona, Persona]
  const launches: string[] = []
  let controller!: PersonaBringUpController
  const f = makeFixture({
    overrides: {
      bringUps: {
        bringUp: (p, set) => controller.bringUp(p, set),
        cancel: (k) => controller.cancel(k),
        state: (k) => controller.state(k),
        changeCredentials: (...args) => controller.changeCredentials(...args),
      },
      connections: h.manager,
      ...opts.overrides,
    },
  })
  controller = createPersonaBringUpController({
    // The recording bringUp, and the real manager's status and stop (a
    // claude_config_dir hold closes the persona's connection with it).
    connections: { bringUp: h.connections.bringUp, status: (key) => h.manager.status(key), stop: (key) => h.manager.stop(key) },
    clock: h.clock,
    dryRun: false,
    log: (line) => void h.lines.push(line),
    appliedPersonas: () => h.config?.personas ?? [],
    serialize: f.serializer.run,
    checkConfigDir: configDirCheckUnder(dir),
    launch: async (p) => {
      launches.push(p.key)
      return opts.launch?.(p)
    },
  })
  h.onStatus = (key, status) => controller.onConnectionStatus(key, status)
  cleanups.push(async () => {
    controller.cancelAll()
    await h.manager.stopAll()
    expect(h.clock.pendingCount()).toBe(0)
  })
  return { h, controller, f, a, b, launches }
}

// ---------------------------------------------------------------------------
// Persona teardown (SR-6.5): order, failures, dry run
// ---------------------------------------------------------------------------

describe('persona teardown (SR-6.5): every step for the removed key only, in order', () => {
  test('AC 57: tearing B down runs every step for B alone, in the documented order, then the launch pass with B\'s config and launched-with dirs against the personas still applied; starting and complete lines only', async () => {
    const launchedWith = join(dir, 'beta-launched-with')
    const f = makeFixture({ launchedWith })

    await f.lifecycle.teardown(f.b)

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, launchedWith)))
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
    expect(f.trail.join('\n')).not.toContain(f.a.key + ':')
    expect(f.submitted).toEqual([f.b.key])
  })

  // b.jg5 SRJ-811: the optional old-life member (production: the session
  // manager's forgetOldLifeWaits) runs right after each stop of B's retry
  // timer before the kill; the fixture's other teardowns, built without it,
  // keep the trail above.
  test('b.jg5 SRJ-811: with the optional old-life member, B\'s old-life waits are forgotten right after each retry-timer stop before the kill (in the first group, and again once its launch in flight settled), for B only; none after the kill', async () => {
    const f = makeFixture({
      overrides: {
        forgetOldLifeWaits: (key: string) => {
          f.trail.push(`forgetOldLifeWaits:${key}`)
        },
      },
    })

    await f.lifecycle.teardown(f.b)

    const k = f.b.key
    const want: string[] = []
    let timerStops = 0
    for (const step of fullTeardownTrail(f.b, launchPassOf(f, undefined))) {
      want.push(step)
      if (step === `stopRetryTimer:${k}` && ++timerStops <= 2) want.push(`forgetOldLifeWaits:${k}`)
    }
    expect(f.trail).toEqual(want)
    expect(f.trail.filter((c) => c.startsWith('forgetOldLifeWaits:'))).toEqual([`forgetOldLifeWaits:${k}`, `forgetOldLifeWaits:${k}`])
    expect(f.trail.lastIndexOf(`forgetOldLifeWaits:${k}`)).toBeLessThan(f.trail.indexOf(`killInstance:${k}`))
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
  })

  test.each<['throws' | 'rejects']>([['throws'], ['rejects']])('b.jg5 SRJ-811: the old-life member failing (it %s) is one token-safe line per step naming B, and every later step still runs', async (how) => {
    const f = makeFixture({
      overrides: {
        forgetOldLifeWaits: (key: string) => {
          f.trail.push(`forgetOldLifeWaits:${key}`)
          if (how === 'rejects') return Promise.reject(failure())
          throw failure()
        },
      },
    })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail.filter((c) => c.startsWith('killInstance:') || c.startsWith('replyGuard.launchPass:'))).toHaveLength(2)
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: ${OLD_LIFE_WAITS_STEP} failed: Error`)}( |$)`)),
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: ${OLD_LIFE_WAITS_STEP} again, after its launch in flight settled failed: Error`)}( |$)`)),
      killOutcomeLine(f.b),
      `${teardownPrefix(f.b)}: complete, with 2 failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
  })

  test('the launch pass reads the applied set when it runs, not when the teardown started', async () => {
    let applied: Persona[] = []
    const f = makeFixture({
      launchInFlight: async () => {
        applied.length = 0 // the applied set changes while the teardown runs
      },
    })
    applied = f.applied

    await f.lifecycle.teardown(f.b)

    expect(f.trail.filter((c) => c.startsWith('replyGuard.launchPass:'))).toEqual([`replyGuard.launchPass:${JSON.stringify([f.b.claude_config_dir, undefined])}:[]`])
  })

  test('b.f2b: a launch in flight that settles only once its wait for a working row is cancelled (up to 10 minutes otherwise) does not hold the teardown: the wait is cancelled at submit, before the teardown waits for the launch', async () => {
    const waitCancelled = Promise.withResolvers<void>()
    const f = makeFixture({
      launchInFlight: () => waitCancelled.promise,
      overrides: {
        cancelLaunchWait: (key) => {
          f.trail.push(`cancelLaunchWait:${key}`)
          waitCancelled.resolve()
          return true
        },
      },
    })

    await f.lifecycle.teardown(f.b)

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
  })

  // b.jg5 SRJ-404, SRJ-715: the approver is stopped first at submit and first
  // in the turn, and the turn awaits that stop before any other step and
  // before it waits for the launch in flight.
  test('b.jg5 SRJ-715: B\'s dialog approver is stopped first, at submit and as the turn\'s first step, and the turn awaits that stop before any other step and before it waits for B\'s launch in flight', async () => {
    const launchInFlight = Promise.withResolvers<void>()
    const turnStop = Promise.withResolvers<void>()
    let stops = 0
    const f = makeFixture({
      launchInFlight: () => launchInFlight.promise,
      overrides: {
        stopApprover: (key) => {
          f.trail.push(`stopApprover:${key}`)
          return ++stops === 1 ? Promise.resolve(true) : turnStop.promise
        },
      },
    })
    const full = fullTeardownTrail(f.b, launchPassOf(f, undefined))

    const done = f.lifecycle.teardown(f.b)
    await flush()
    // The turn's stop has not settled: nothing after it ran.
    expect(f.trail).toEqual([...submitCancels(f.b), ...turnStart(f.b), `stopApprover:${f.b.key}`])
    expect(f.lines).toEqual([`${teardownPrefix(f.b)}: starting`])

    turnStop.resolve()
    await flush()
    // The stop settled; the turn now waits for the launch in flight.
    expect(f.trail).toEqual(untilLaunchSettled(full, f.b))
    expect(await settled(done)).toBe(false)

    launchInFlight.resolve()
    await done
    expect(f.trail).toEqual(full)
    expect(f.trail.filter((c) => c.startsWith('stopApprover:'))).toEqual([`stopApprover:${f.b.key}`, `stopApprover:${f.b.key}`])
    // AC 35's part: the approver stops before the wait for the launch in flight and before the kill.
    expect(f.trail.lastIndexOf(`stopApprover:${f.b.key}`)).toBeLessThan(f.trail.indexOf(`whenLaunchSettled:${f.b.key}`))
    expect(f.trail.lastIndexOf(`stopApprover:${f.b.key}`)).toBeLessThan(f.trail.indexOf(`killInstance:${f.b.key}`))
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
  })

  // Rows: how the turn's stop fails (the submit-time stop succeeds).
  test.each<['throws' | 'rejects']>([['throws'], ['rejects']])('b.jg5 SRJ-715: the approver\'s stop failing in the turn (it %s): one token-safe line naming B by its step, every later step still runs (the wait for the launch included) and the teardown completes with one failed step', async (how) => {
    let stops = 0
    const f = makeFixture({
      overrides: {
        stopApprover: (key) => {
          f.trail.push(`stopApprover:${key}`)
          if (++stops === 1) return Promise.resolve(true)
          if (how === 'rejects') return Promise.reject(failure())
          throw failure()
        },
      },
    })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: stopping its dialog approver failed: Error`)}( |$)`)),
      killOutcomeLine(f.b),
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
  })

  test('a deps object without the optional approver stop (a hand-built fixture) still tears B down: every other step runs, in order', async () => {
    const f = makeFixture({ overrides: { stopApprover: undefined } })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)).filter((c) => !c.startsWith('stopApprover:')))
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
  })

  // b.jg5 SRJ-706, SRJ-715: the live-row sequence is stopped right after the
  // approver, at submit and as the turn's second step, and the turn awaits
  // that stop (the sequence's call in flight) before any other step and
  // before it waits for the launch in flight.
  test('b.jg5 SRJ-706, SRJ-715: B\'s live-row sequence is stopped right after its approver, at submit and as the turn\'s second step, for B only, and the turn awaits that stop before any other step and before it waits for B\'s launch in flight', async () => {
    const launchInFlight = Promise.withResolvers<void>()
    const turnStop = Promise.withResolvers<boolean>()
    let stops = 0
    const f = makeFixture({
      launchInFlight: () => launchInFlight.promise,
      overrides: {
        stopLiveRowSequence: (key) => {
          f.trail.push(`stopLiveRowSequence:${key}`)
          return ++stops === 1 ? Promise.resolve(true) : turnStop.promise
        },
      },
    })
    const full = fullTeardownTrail(f.b, launchPassOf(f, undefined))

    const done = f.lifecycle.teardown(f.b)
    await flush()
    // The turn's sequence stop has not settled: nothing after it ran.
    expect(f.trail).toEqual([...submitCancels(f.b), ...turnStart(f.b), `stopApprover:${f.b.key}`, `stopLiveRowSequence:${f.b.key}`])

    turnStop.resolve(true)
    await flush()
    expect(f.trail).toEqual(untilLaunchSettled(full, f.b))
    expect(await settled(done)).toBe(false)

    launchInFlight.resolve()
    await done
    expect(f.trail).toEqual(full)
    expect(f.trail.filter((c) => c.startsWith('stopLiveRowSequence:'))).toEqual([
      `stopLiveRowSequence:${f.b.key}`,
      `stopLiveRowSequence:${f.b.key}`,
      `stopLiveRowSequence:${f.b.key}`,
    ])
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
  })

  // b.jg5 SRJ-715, SRJ-706, SRJ-707: B's launch in flight can start B's
  // sequence at a collision ladder replacement site after the turn's first
  // sequence stop. Once that launch settled, the turn stops the sequence
  // again and awaits that stop (the sequence's call in flight) before its
  // second retry-timer stop and every later step, the kill included.
  test('b.jg5 SRJ-715, SRJ-706: once B\'s launch in flight settled, B\'s live-row sequence is stopped again and the turn awaits that stop, then stops B\'s retry timer again and forgets its latch, hold and notice episodes again, before its Slack connection stops and before its kill', async () => {
    const againStop = Promise.withResolvers<boolean>()
    let stops = 0
    const f = makeFixture({
      overrides: {
        stopLiveRowSequence: (key) => {
          f.trail.push(`stopLiveRowSequence:${key}`)
          return ++stops === 3 ? againStop.promise : Promise.resolve(true)
        },
      },
    })
    const full = fullTeardownTrail(f.b, launchPassOf(f, undefined))

    const done = f.lifecycle.teardown(f.b)
    await flush()
    // Held at the second stop: nothing after it ran.
    expect(f.trail).toEqual([...untilLaunchSettled(full, f.b), `stopLiveRowSequence:${f.b.key}`])
    expect(await settled(done)).toBe(false)

    againStop.resolve(true)
    await done
    const k = f.b.key
    const settledAt = f.trail.indexOf(`whenLaunchSettled:${k}`)
    expect(f.trail.slice(settledAt, settledAt + 7)).toEqual([
      `whenLaunchSettled:${k}`, `stopLiveRowSequence:${k}`, `stopRetryTimer:${k}`,
      `forgetConflictLatch:${k}`, `forgetInvalidFlagsHold:${k}`, `forgetNoticeEpisodes:${k}`, `connections.stop:${k}`,
    ])
    expect(f.trail).toEqual(full)
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
  })

  // Rows: which of the turn's sequence stops fails (the turn's second step, or the stop once its launch in flight
  // settled) and how; every other sequence stop, the submit-time one included, succeeds.
  test.each<[number, string, 'throws' | 'rejects']>([
    [2, LIVE_ROW_SEQUENCE_STOP_STEP, 'throws'],
    [2, LIVE_ROW_SEQUENCE_STOP_STEP, 'rejects'],
    [3, LIVE_ROW_SEQUENCE_STOP_AGAIN_STEP, 'throws'],
    [3, LIVE_ROW_SEQUENCE_STOP_AGAIN_STEP, 'rejects'],
  ])('b.jg5 SRJ-706: the live-row sequence\'s stop number %i failing in the turn (%s; it %s): one token-safe line naming B by its step, every later step still runs and the teardown completes with one failed step', async (failing, phrase, how) => {
    let stops = 0
    const f = makeFixture({
      overrides: {
        stopLiveRowSequence: (key) => {
          f.trail.push(`stopLiveRowSequence:${key}`)
          if (++stops !== failing) return Promise.resolve(true)
          if (how === 'rejects') return Promise.reject(failure())
          throw failure()
        },
      },
    })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: ${phrase} failed: Error`)}( |$)`)),
      killOutcomeLine(f.b),
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
  })

  test('a deps object without the optional live-row sequence stop (a hand-built fixture) still tears B down: every other step runs, in order', async () => {
    const f = makeFixture({ overrides: { stopLiveRowSequence: undefined } })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)).filter((c) => !c.startsWith('stopLiveRowSequence:')))
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
  })

  // b.jg5 SRJ-706, SRJ-715 (E21 T1's reconcile note): a kill try already in
  // flight when the sequence is stopped can still arm P's retry timer from
  // inside the try (a CONFIG answer through the outage state's detection).
  // The teardown's sequence stop waits for that call, so its later stops of
  // P's retry timer clear the arm. Composed over the recovery harness: its
  // registry, retry controller and sequence dependencies, with the
  // teardown's sequence stop and retry-timer stop bound as main() binds them.
  test('b.jg5 SRJ-706, SRJ-715: a teardown of P during its sequence\'s held step-1 kill, which then answers CONFIG: the turn waits for the kill, the CONFIG answer arms P\'s retry timer, and the teardown\'s later timer stops leave none armed', async () => {
    const h = makeRecoveryHarness()
    cleanups.push(() => {
      try {
        assertNoLeak(h.captured())
      } finally {
        h.cleanup()
      }
    })
    const [p, q] = h.keys as [string, string]
    const killEntered = Promise.withResolvers<void>()
    const killAnswer = Promise.withResolvers<void>()
    h.stub.client.kill = async () => {
      killEntered.resolve()
      await killAnswer.promise
      throw errConfigMalformed()
    }
    const run = h.startSequence(p, { lastReadState: cannedStatusResult().state })
    await killEntered.promise
    h.controller.arm(q, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
    const f = makeFixture({
      overrides: {
        stopLiveRowSequence: (key) => {
          f.trail.push(`stopLiveRowSequence:${key}`)
          return stopLiveRowSequence(key, LIVE_ROW_STOP_TEARDOWN)
        },
        stopRetryTimer: (key) => {
          f.trail.push(`stopRetryTimer:${key}`)
          h.controller.stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
        },
      },
    })

    const done = f.lifecycle.teardown(personaOf(h, p))
    await flush()
    expect(await settled(done)).toBe(false)
    expect(f.trail.at(-1)).toBe(`stopLiveRowSequence:${p}`)

    killAnswer.resolve()
    await h.driveSequence(done)

    expect(await run.outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN })
    // The CONFIG answer armed P's timer from inside the kill try, after the stop was set.
    expect(h.triggers).toContainEqual({ key: p, kind: UNAVAILABLE_RETRY_CAUSE_CONFIG })
    expect(f.trail.lastIndexOf(`stopRetryTimer:${p}`)).toBeGreaterThan(f.trail.lastIndexOf(`stopLiveRowSequence:${p}`))
    expect(h.controller.isArmed(p)).toBe(false)
    expect(h.controller.armedKeys()).toEqual([q])
    expect(h.stub.calls.getCalls).toEqual([])
    h.controller.stop(q, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
  })

  // b.jg5 SRJ-715, SRJ-706, SRJ-707 (E21 T2's reconcile note): a launch of P
  // in flight at the teardown's first sequence stop can start P's sequence at
  // a collision ladder replacement site after that stop. Once the launch has
  // settled, the turn's second, awaited stop stops it: its step-1 kill, in
  // flight, is waited for, and no get, run or launch follows. Composed over
  // the recovery harness as above, the turn waiting for the real launch in
  // flight (`whenLaunchSettled`).
  test('b.jg5 SRJ-715, SRJ-706: P\'s launch in flight at the teardown starts P\'s sequence after the turn\'s first stop; the stop once the launch settled stops that sequence before the teardown goes on: its kill in flight is waited for, and no get, run or reuse spawn follows', async () => {
    const h = makeRecoveryHarness()
    cleanups.push(() => {
      try {
        assertNoLeak(h.captured())
      } finally {
        h.cleanup()
      }
    })
    const [p] = h.keys as [string]
    scriptLiveRowElsewhere(h, p)
    // P's launch is held at its collision get, and the sequence's step-1 kill at its call.
    const getEntered = Promise.withResolvers<void>()
    const getRelease = Promise.withResolvers<void>()
    const get = h.stub.client.get.bind(h.stub.client)
    let gets = 0
    h.stub.client.get = async (params) => {
      if (gets++ === 0) {
        getEntered.resolve()
        await getRelease.promise
      }
      return get(params)
    }
    const killEntered = Promise.withResolvers<void>()
    const killRelease = Promise.withResolvers<void>()
    const kill = h.stub.client.kill.bind(h.stub.client)
    h.stub.client.kill = async (params) => {
      killEntered.resolve()
      await killRelease.promise
      return kill(params)
    }
    const launch = h.launch(p)
    await getEntered.promise
    const f = makeFixture({
      overrides: {
        stopLiveRowSequence: (key) => {
          f.trail.push(`stopLiveRowSequence:${key}`)
          return stopLiveRowSequence(key, LIVE_ROW_STOP_TEARDOWN)
        },
        whenLaunchSettled: (key) => {
          f.trail.push(`whenLaunchSettled:${key}`)
          return whenLaunchSettled(key)
        },
      },
    })

    const done = f.lifecycle.teardown(personaOf(h, p))
    await flush()
    // The turn waits for the launch in flight; no sequence runs yet.
    expect(f.trail.at(-1)).toBe(`whenLaunchSettled:${p}`)
    expect(h.sequenceRunning(p)).toBe(false)

    getRelease.resolve()
    expect(await launch).toStrictEqual({ key: p, action: 'sequence-waiting' })
    await killEntered.promise
    await flush()
    // The second stop is asked, and waits for the sequence's kill in flight.
    expect(f.trail.at(-1)).toBe(`stopLiveRowSequence:${p}`)
    expect(await settled(done)).toBe(false)

    killRelease.resolve()
    await h.driveSequence(done)

    expect(await h.sequenceSettled(p)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN })
    expect(h.sequenceRunning(p)).toBe(false)
    expect([h.stub.calls.killCalls.length, h.stub.calls.getCalls.length, h.stub.calls.findMissingCalls, h.reuseSpawns()]).toEqual([1, 1, [], []])
    const settledAt = f.trail.indexOf(`whenLaunchSettled:${p}`)
    expect(f.trail.slice(settledAt, settledAt + 3)).toEqual([`whenLaunchSettled:${p}`, `stopLiveRowSequence:${p}`, `stopRetryTimer:${p}`])
    expect(h.controller.isArmed(p)).toBe(false)
  })

  // b.jg5 SRJ-715, SRJ-305, SRJ-301: P's launch in flight
  // (the start pass's, outside the serializer) can arm P's retry timer after
  // the teardown's first-group stop. Composed over the recovery harness: the
  // real retry controller on its fake clock and the real launch, its spawn
  // held, then answering UNAVAILABLE inside its attempt; the teardown's
  // retry-timer stop and its wait for the launch bound as main() binds them.
  test.each<[string, (spawns: ReturnType<typeof holdSpawns>, id: string) => void, string]>([
    ['meets UNAVAILABLE', (spawns, id) => spawns.fail(id, errTmuxUnresponsive('spawn')), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    // b.jg5 SRJ-301, SRJ-409: a launch that returned success arms P's pending-only watch.
    ['succeeds (its pending-only watch)', (spawns, id) => spawns.release(id), UNAVAILABLE_RETRY_CAUSE_PENDING_ROW],
  ])('b.jg5 SRJ-715: P\'s launch in flight %s after the teardown\'s first retry-timer stop and arms P\'s timer; the stop once that launch settled clears it, so no timer is armed for P when the teardown completes; Q\'s timer stays armed', async (_label, settle, cause) => {
    const h = makeRecoveryHarness()
    cleanups.push(() => {
      try {
        assertNoLeak(h.captured())
      } finally {
        h.cleanup()
      }
    })
    const [p, q] = h.keys as [string, string]
    const spawns = holdSpawns(h.stub.client)
    const launch = h.launch(p)
    await spawns.entered(personaInstanceId(p))
    h.controller.arm(q, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
    const qDue = h.controller.view(q)!.dueAt
    const f = makeFixture({
      overrides: {
        whenLaunchSettled: (key) => {
          f.trail.push(`whenLaunchSettled:${key}`)
          return whenLaunchSettled(key)
        },
        // As server.ts binds it, recording whether the key had a timer when this stop ran.
        stopRetryTimer: (key) => {
          f.trail.push(`stopRetryTimer:${key}:${h.controller.isArmed(key) ? 'armed' : 'none'}`)
          h.controller.stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
        },
      },
    })
    f.applied.push(personaOf(h, p)) // a destructive modify's old half: P's key stays applied

    const done = f.lifecycle.teardown(personaOf(h, p))
    await flush()
    // The first group ran (P had no timer then); the turn waits for P's launch in flight.
    expect(f.trail.at(-1)).toBe(`whenLaunchSettled:${p}`)
    expect(h.controller.isArmed(p)).toBe(false)

    settle(spawns, personaInstanceId(p))
    await launch
    await done
    await h.settle()

    // The launch armed P's timer as it settled; the stop right after the wait found it armed and stopped it.
    expect(h.triggers).toContainEqual({ key: p, kind: cause })
    const settledAt = f.trail.indexOf(`whenLaunchSettled:${p}`)
    const stops = f.trail.filter((c) => c.startsWith(`stopRetryTimer:${p}:`))
    expect(stops.filter((c) => c.endsWith(':armed'))).toEqual([`stopRetryTimer:${p}:armed`])
    expect(f.trail.indexOf(`stopRetryTimer:${p}:armed`)).toBeGreaterThan(settledAt)
    expect(f.trail.slice(settledAt + 1, settledAt + 3)).toEqual([`stopLiveRowSequence:${p}`, `stopRetryTimer:${p}:armed`])
    expect(stops.at(-1)).toBe(`stopRetryTimer:${p}:none`)
    expect(h.controller.isArmed(p)).toBe(false)
    expect(h.controller.armedKeys()).toEqual([q])
    expect(h.controller.view(q)!.dueAt).toBe(qDue)
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(personaOf(h, p))}: complete`)
    h.controller.stop(q, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
  })

  // Rows: the dependency that fails and the step phrase of each line it fails, in order. Some deps run more than once
  // in the turn, so each of their steps fails: stopRetryTimer (in the first group, again once the launch in flight
  // settled and once more after the kill), the latch forget (in the first group, again once the launch settled and
  // once more after the kill), and the hold and episodes forgets (in the first group and again once the launch
  // settled) (b.jg5 SRJ-715). The outage state is forgotten once, at the turn's start, and the held notices dropped
  // once; the notice window's open and close are steps of their own (b.jg5 SRJ-1002, SRJ-1003).
  test.each<[DepName, string[]]>([
    ['notifier.openTeardownWindow', ['opening its notice window']],
    ['notifier.closeTeardownWindow', ['closing its notice window']],
    ['bringUps.cancel', ['cancelling its bring-up retries']],
    ['cancelRestartTimer', ['cancelling its restart timer']],
    ['stopRetryTimer', ['stopping its UNAVAILABLE retry timer', 'stopping its UNAVAILABLE retry timer again, after its launch in flight settled', TEARDOWN_RETRY_TIMER_STOP_AFTER_KILL_STEP]],
    ['whenLaunchSettled', ['waiting for its launch in flight']],
    ['connections.stop', ['stopping its Slack connection']],
    ['routing.forget', ['forgetting its inbound dedupe store']],
    ['forgetAcks', ['forgetting its ack-reaction entries']],
    ['destinations.forget', ['forgetting its DM destination']],
    ['destinationHold.cancel', ['cancelling its held destination notices']],
    ['notifier.forget', ['dropping its held notices']],
    ['forgetPersonaPrompts', ['dropping its tracked permission prompts']],
    ['dropSession', ['dropping its MCP session']],
    ['resetOutageState', ['forgetting its outage state']],
    ['forgetFailures', ['forgetting its restart failure count']],
    ['forgetDisconnectedStreak', ['forgetting its health-check streak']],
    ['forgetNotConnectedEpisode', ['forgetting its not-connected episode']],
    ['forgetConflictLatch', ['forgetting its latch', 'forgetting its latch again, after its launch in flight settled', 'forgetting its latch once more, after the kill']],
    ['forgetInvalidFlagsHold', ['forgetting its ErrInvalidFlags hold', 'forgetting its ErrInvalidFlags hold again, after its launch in flight settled']],
    ['forgetNoticeEpisodes', ['forgetting its notice episodes', 'forgetting its notice episodes again, after its launch in flight settled']],
    ['replyGuard.launchedWithDir', ['reading its launched-with directory']],
    ['replyGuard.teardown', ['deleting its reply-guard record']],
    ['replyGuard.launchPass', ['re-evaluating the Stop hook in its config directories']],
  ])('%s failing: its step is logged token-safely, every other step still runs, and the completion line counts the failed steps', async (dep, phrases) => {
    const launchedWith = join(dir, 'beta-launched-with')
    const f = makeFixture({ fail: [dep], launchedWith })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    // A failed launched-with read leaves the launch pass without that dir.
    const expectedWith = dep === 'replyGuard.launchedWithDir' ? undefined : launchedWith
    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, expectedWith)))
    const failedLine = (phrase: string) =>
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: ${phrase.replace('cscb_<key>', personaInstanceId(f.b.key))} failed: Error`)}( |$)`))
    expect(f.lines[0]).toBe(`${teardownPrefix(f.b)}: starting`)
    // The kill succeeded, so its outcome line is logged once among the failed steps' lines.
    const middle = f.lines.slice(1, -1)
    expect(middle.filter((line) => line === killOutcomeLine(f.b))).toHaveLength(1)
    expect(middle.filter((line) => line !== killOutcomeLine(f.b))).toEqual(phrases.map(failedLine))
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with ${phrases.length} failed step(s)`)
    assertNoLeak({ lines: f.lines })
  })

  // b.jg5 SRJ-715, SRJ-110: a kill step that throws shows no outcome: the
  // step fails, nothing is raised and the row is kept (there is no delete);
  // every other step still runs.
  test('b.jg5 SRJ-715: killInstance failing (it throws): its step is logged token-safely, no alert is raised, every other step still runs, and the completion line counts one failed step', async () => {
    const launchedWith = join(dir, 'beta-launched-with')
    const f = makeFixture({ fail: ['killInstance'], launchedWith })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, launchedWith)))
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: agent-director kill of ${personaInstanceId(f.b.key)} failed: Error`)}( |$)`)),
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
  })

  test('b.jg5 SRJ-715: a kill answering no kill outcome fails the kill step with its own line; nothing is raised and every other step still runs', async () => {
    const f = makeFixture({ killResult: { refusals: [] } as unknown as PersonaTeardownKillResult })

    await f.lifecycle.teardown(f.b)

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      `${teardownPrefix(f.b)}: agent-director kill of ${personaInstanceId(f.b.key)} failed: it answered no kill outcome — the row is kept (b.jg5 SRJ-715)`,
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
    ])
  })

  // b.jg5 SRJ-704, SRJ-715: the kill's retry decision is raised right after
  // the kill step, for B, with the decision as the kill answered it, before
  // the outage state is forgotten again; a `none` decision raises nothing
  // (every other case here). A failing raise is one failed step.
  test.each<[string, PersonaTeardownKillResult, boolean]>([
    [
      'ordinary decision, after a kill failing at every try',
      {
        outcome: killOutcomeOf({ thrown: errTmuxKillFailed() }),
        end: KILL_RETRY_END_EXHAUSTED,
        tries: KILL_RETRY_TRIES,
        reads: KILL_RETRY_TRIES - 1,
        alert: { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: killFailedDescriptionOf(errTmuxKillFailed())! },
        refusals: [],
      },
      false,
    ],
    [
      'survivor decision, after a success that followed a survivor-naming failure',
      {
        outcome: KILL_SUCCEEDED,
        end: KILL_RETRY_END_SETTLED,
        tries: 2,
        reads: 1,
        alert: { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: killFailedDescriptionOf(errTmuxKillFailed(undefined, 'pane-process-survived'))! },
        refusals: [],
      },
      true,
    ],
  ])('b.jg5 SRJ-704: the kill\'s %s is raised once for B, right after the kill step; a raise that throws is logged as its own failed step and every other step still runs', async (_label, killResult, succeeded) => {
    for (const raiseFails of [false, true]) {
      const f = makeFixture({ killResult, ...(raiseFails ? { fail: ['raiseKillFailureAlert' as const] } : {}) })
      const k = f.b.key

      await f.lifecycle.teardown(f.b)

      const expected = fullTeardownTrail(f.b, launchPassOf(f, undefined))
      const afterKill = expected.indexOf(`killInstance:${k}`) + 1
      expect(f.trail).toEqual([...expected.slice(0, afterKill), `raiseKillFailureAlert:${k}:${killResult.alert.kind}`, ...expected.slice(afterKill)])
      const failedSteps = (succeeded ? 0 : 1) + (raiseFails ? 1 : 0)
      expect(f.lines).toEqual([
        `${teardownPrefix(f.b)}: starting`,
        succeeded ? killOutcomeLine(f.b, killResult.outcome, killResult.tries) : killFailedLine(f.b, killResult.outcome, killResult.tries),
        ...(raiseFails ? [expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: raising the kill-failure alert failed: Error`)}( |$)`))] : []),
        failedSteps === 0 ? `${teardownPrefix(f.b)}: complete` : `${teardownPrefix(f.b)}: complete, with ${failedSteps} failed step(s)`,
      ])
      assertNoLeak({ lines: f.lines })
    }
  })

  // b.jg5 SRJ-704: only an ordinary decision, or a survivor one carrying a
  // string description, is raised. A malformed decision (or one whose read
  // throws) raises nothing and is said once, inside the kill step: the kill
  // succeeded, so no step fails.
  test.each<[string, unknown]>([
    ['null', null],
    ['an unknown kind', { kind: 'catastrophic', lastKillFailedDescription: 'tmux kill failed' }],
    ['survivor without a description', { kind: KILL_RETRY_ALERT_SURVIVOR }],
    ['survivor with a non-string description', { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: 42 }],
    ['a decision without a kind', {}],
    ['a decision that is not an object', KILL_RETRY_ALERT_ORDINARY],
  ])('b.jg5 SRJ-704: a malformed kill-failure alert decision (%s) raises nothing, logs its one line, counts no failed step, and the teardown resolves', async (_label, alert) => {
    const killResult = { ...KILL_RESULT_SUCCEEDED, alert } as unknown as PersonaTeardownKillResult
    const f = makeFixture({ killResult })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
    expect(f.trail.filter((c) => c.startsWith('raiseKillFailureAlert:'))).toEqual([])
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      malformedAlertLine(f.b),
      killOutcomeLine(f.b),
      `${teardownPrefix(f.b)}: complete`,
    ])
  })

  test('b.jg5 SRJ-704: a kill-failure alert decision whose read throws raises nothing, logs the malformed-decision line, counts no failed step, and the teardown resolves', async () => {
    const killResult = { ...KILL_RESULT_SUCCEEDED } as Record<string, unknown>
    Object.defineProperty(killResult, 'alert', { get: () => { throw failure() }, enumerable: true })
    const f = makeFixture({ killResult: killResult as unknown as PersonaTeardownKillResult })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      malformedAlertLine(f.b),
      killOutcomeLine(f.b),
      `${teardownPrefix(f.b)}: complete`,
    ])
    assertNoLeak({ lines: f.lines })
  })

  // b.jg5 SRJ-110: with no alert raised, the standing ErrTmuxKillFailed is
  // recorded by the not-succeeded notice, right after the kill step.
  test('b.jg5 SRJ-704, SRJ-110: a malformed decision after a failing kill raises no alert and logs its line; the standing outcome is one not-succeeded notice right after the kill step; only the kill step counts as failed', async () => {
    const outcome = killOutcomeOf({ thrown: errTmuxKillFailed() })
    const killResult = {
      outcome,
      end: KILL_RETRY_END_EXHAUSTED,
      tries: KILL_RETRY_TRIES,
      reads: KILL_RETRY_TRIES - 1,
      alert: { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: null },
      refusals: [],
    } as unknown as PersonaTeardownKillResult
    const f = makeFixture({ killResult })
    const k = f.b.key

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    const expected = fullTeardownTrail(f.b, launchPassOf(f, undefined))
    const afterKill = expected.indexOf(`killInstance:${k}`) + 1
    const notice = teardownKillNotSucceededNoticeText(personaInstanceId(k), outcome as KillFailure, KILL_RETRY_TRIES)
    expect(f.trail).toEqual([...expected.slice(0, afterKill), `notifier.notify:${k}:${notice}`, ...expected.slice(afterKill)])
    expect(f.trail.filter((c) => c.startsWith('raiseKillFailureAlert:'))).toEqual([])
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      malformedAlertLine(f.b),
      killFailedLine(f.b, outcome, KILL_RETRY_TRIES),
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
    ])
  })

  /**
   * The teardown kill's result for a standing non-success `err` after
   * `tries` kill(s), with no alert and the given refusals.
   */
  function failedKillResult(err: Error, tries = 1, refusals: PersonaTeardownKillRefusal[] = []): PersonaTeardownKillResult {
    return {
      outcome: killOutcomeOf({ thrown: err }),
      end: tries > 1 ? KILL_RETRY_END_EXHAUSTED : KILL_RETRY_END_SETTLED,
      tries,
      reads: tries - 1,
      alert: { kind: KILL_RETRY_ALERT_NONE },
      refusals,
    }
  }

  /** The not-succeeded notice's text for B's kill answering `killResult`. */
  const notSucceededText = (f: Fixture, killResult: PersonaTeardownKillResult): string =>
    teardownKillNotSucceededNoticeText(personaInstanceId(f.b.key), killResult.outcome as KillFailure, killResult.tries)

  /** The notifier's `notify` calls in `f`'s trail. */
  const notifyCalls = (f: Fixture): string[] => f.trail.filter((c) => c.startsWith('notifier.notify:'))

  // b.jg5 SRJ-110, SRJ-1003: a standing non-success that no other notice
  // records is raised as one notice through the notifier, right after the
  // kill step. An ENVIRONMENT or CONFIG outcome (and ErrSystemInstallDisappeared,
  // by name) is recorded by its outage's onset when that outage is raised:
  // with the outage reader (production: getOutageFlags) when it reads the
  // class raised now; without one, the kill's own rule (ENVIRONMENT and
  // CONFIG while the key is applied, ErrSystemInstallDisappeared always).
  // Rows: the outcome, its tries, whether B is still applied, the outage
  // reader (none, the classes it answers, or a throw), and whether the
  // not-succeeded notice is raised.
  const throwingReader = (): ReadonlySet<string> => {
    throw failure()
  }
  test.each<[string, () => Error, number, boolean, ((key: string) => ReadonlySet<string>) | undefined, boolean]>([
    ['UNAVAILABLE (ErrTmuxUnresponsive) after the tries, B removed', () => errTmuxUnresponsive('kill'), KILL_RETRY_TRIES, false, undefined, true],
    ['UNAVAILABLE (ErrTmuxUnresponsive) after the tries, B still applied, the reader seeing every class', () => errTmuxUnresponsive('kill'), KILL_RETRY_TRIES, true, () => new Set(['tmux-unavailable', 'ad-config-malformed', 'ad-unreachable']), true],
    ['UNCLASSIFIED (ErrInternal), B removed', () => errInternal(), 1, false, undefined, true],
    ['ENVIRONMENT, B removed, no reader', () => errTmuxNotAvailable(undefined, 'kill'), 1, false, undefined, true],
    ['ENVIRONMENT, B still applied, no reader (the kill\'s own rule: covered)', () => errTmuxNotAvailable(undefined, 'kill'), 1, true, undefined, false],
    ['CONFIG, B removed, no reader', () => errConfigMalformed(), 1, false, undefined, true],
    ['CONFIG, B still applied, no reader (the kill\'s own rule: covered)', () => errConfigMalformed(), 1, true, undefined, false],
    ['ErrSystemInstallDisappeared, B removed, no reader (covered whatever the configuration)', () => new ErrSystemInstallDisappeared('kill', '/opt/ad/bin'), 1, false, undefined, false],
    ['ENVIRONMENT, B removed, the reader seeing tmux-unavailable raised', () => errTmuxNotAvailable(undefined, 'kill'), 1, false, () => new Set(['tmux-unavailable']), false],
    ['ENVIRONMENT, B still applied, the reader seeing no class raised', () => errTmuxNotAvailable(undefined, 'kill'), 1, true, () => new Set<string>(), true],
    ['CONFIG, B still applied, the reader seeing only another class raised', () => errConfigMalformed(), 1, true, () => new Set(['tmux-unavailable']), true],
    ['CONFIG, B still applied, the reader seeing ad-config-malformed raised', () => errConfigMalformed(), 1, true, () => new Set(['ad-config-malformed']), false],
    ['ErrSystemInstallDisappeared, B removed, the reader seeing no class raised', () => new ErrSystemInstallDisappeared('kill', '/opt/ad/bin'), 1, false, () => new Set<string>(), true],
    ['ErrSystemInstallDisappeared, B removed, the reader seeing ad-unreachable raised', () => new ErrSystemInstallDisappeared('kill', '/opt/ad/bin'), 1, false, () => new Set(['ad-unreachable']), false],
    ['ENVIRONMENT, B still applied, a reader that throws (counts as none raised)', () => errTmuxNotAvailable(undefined, 'kill'), 1, true, throwingReader, true],
  ])('b.jg5 SRJ-110, SRJ-1003: the kill\'s outcome %s: the not-succeeded notice is raised for B right after the kill step only when no onset records it (%p); only the kill step counts as failed', async (_label, make, tries, stillApplied, outageFlags, raised) => {
    const killResult = failedKillResult(make(), tries)
    const f = makeFixture({ killResult, overrides: outageFlags === undefined ? {} : { outageFlags } })
    if (stillApplied) f.applied.push(f.b)
    const k = f.b.key

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(notifyCalls(f)).toEqual(raised ? [`notifier.notify:${k}:${notSucceededText(f, killResult)}`] : [])
    if (raised) expect(f.trail.indexOf(`killInstance:${k}`) + 1).toBe(f.trail.indexOf(notifyCalls(f)[0]!))
    expect(f.trail.filter((c) => c.startsWith('raiseKillFailureAlert:'))).toEqual([])
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      killFailedLine(f.b, killResult.outcome, tries),
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
  })

  // b.jg5 SRJ-1003, SRJ-110: a CONFLICT or UNUSABLE NAME met at a try is the
  // outcome's own record (its refusal notice); one met at a status read
  // between the tries is not, so the outcome standing after them gets the
  // not-succeeded notice too, after the refusal's.
  test.each<[string, () => PersonaTeardownKillResult, (f: Fixture, r: PersonaTeardownKillResult) => string[]]>([
    [
      'a CONFLICT at its try: the refusal notice only',
      () => failedKillResult(errTmuxSessionConflict('kill', 'not-this-launch'), 1, [{ at: KILL_REFUSAL_AT_KILL, errorClass: AD_ERROR_CLASS_CONFLICT, error: errTmuxSessionConflict('kill', 'not-this-launch') }]),
      (f, r) => [teardownKillRefusalNoticeText(personaInstanceId(f.b.key), r.refusals[0]!)],
    ],
    [
      'an UNUSABLE NAME at a status read, then ErrTmuxUnresponsive standing: the refusal notice, then the not-succeeded notice',
      () => failedKillResult(errTmuxUnresponsive('kill'), KILL_RETRY_TRIES, [{ at: KILL_REFUSAL_AT_READ, errorClass: AD_ERROR_CLASS_UNUSABLE_NAME, error: errUnusableName() }]),
      (f, r) => [teardownKillRefusalNoticeText(personaInstanceId(f.b.key), r.refusals[0]!), notSucceededText(f, r)],
    ],
  ])('b.jg5 SRJ-1003, SRJ-110: %s', async (_label, build, texts) => {
    const killResult = build()
    const f = makeFixture({ killResult })
    const k = f.b.key

    await f.lifecycle.teardown(f.b)

    const notices = texts(f, killResult).map((text) => `notifier.notify:${k}:${text}`)
    const afterKill = f.trail.indexOf(`killInstance:${k}`) + 1
    expect(f.trail.slice(afterKill, afterKill + notices.length)).toEqual(notices)
    expect(notifyCalls(f)).toEqual(notices)
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with 1 failed step(s)`)
  })

  // b.jg5 SRJ-110: the notice's own failure is one failed step; a notifier
  // with no `notify` (a hand-built fixture) logs the notice's text in one line
  // instead, counting no failed step.
  test.each<[string, 'fails' | 'absent']>([['the notifier\'s notify rejecting', 'fails'], ['no notify installed', 'absent']])('b.jg5 SRJ-110: the not-succeeded notice with %s: one token-safe line, every later step still runs', async (_label, how) => {
    const killResult = failedKillResult(errTmuxUnresponsive('kill'), KILL_RETRY_TRIES)
    const f = how === 'fails'
      ? makeFixture({ killResult, fail: ['notifier.notify'] })
      : makeFixture({ killResult, overrides: { notifier: { forget: () => undefined } } })
    const k = f.b.key

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    // Every later step still ran: the timer stop after the kill, the forgets and the reply guard.
    const afterKill = f.trail.slice(f.trail.indexOf(`killInstance:${k}`) + 1).filter((c) => !c.startsWith('notifier.'))
    expect(afterKill).toEqual([
      `stopRetryTimer:${k}`, `forgetFailures:${k}`, `forgetDisconnectedStreak:${k}`, `forgetNotConnectedEpisode:${k}`, `forgetConflictLatch:${k}`,
      `replyGuard.launchedWithDir:${k}`, `replyGuard.teardown:${k}`, `replyGuard.launchPass:${launchPassOf(f, undefined)}`,
    ])
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      killFailedLine(f.b, killResult.outcome, KILL_RETRY_TRIES),
      how === 'fails'
        ? expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: raising the notice for its kill's outcome failed: Error`)}( |$)`))
        : `${teardownPrefix(f.b)}: no notifier route is installed for the notice: ${notSucceededText(f, killResult)}`,
      `${teardownPrefix(f.b)}: complete, with ${how === 'fails' ? 2 : 1} failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
  })

  // A `none` decision, or none at all, is no alert to raise: nothing raised, no line.
  test.each<[string, Partial<PersonaTeardownKillResult>]>([
    ['a none decision', { alert: { kind: KILL_RETRY_ALERT_NONE } }],
    ['no decision', { alert: undefined }],
  ])('b.jg5 SRJ-704: %s raises nothing and logs no malformed-decision line', async (_label, alertPart) => {
    const f = makeFixture({ killResult: { ...KILL_RESULT_SUCCEEDED, ...alertPart } as PersonaTeardownKillResult })

    await f.lifecycle.teardown(f.b)

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
  })

  test('every step failing: the teardown still resolves, runs each step once and reports every one of them; there is no delete step', async () => {
    const all: DepName[] = [
      'stopApprover', 'stopLiveRowSequence', 'bringUps.cancel', 'cancelRestartTimer', 'stopRetryTimer', 'cancelLaunchWait', 'whenLaunchSettled', 'connections.stop', 'routing.forget',
      'forgetAcks', 'destinations.forget', 'destinationHold.cancel', 'notifier.forget', 'forgetPersonaPrompts', 'dropSession',
      'resetOutageState', 'killInstance', 'forgetFailures', 'forgetDisconnectedStreak', 'forgetNotConnectedEpisode',
      'forgetConflictLatch', 'forgetInvalidFlagsHold', 'forgetNoticeEpisodes', 'replyGuard.launchedWithDir', 'replyGuard.teardown', 'replyGuard.launchPass',
      'notifier.openTeardownWindow', 'notifier.closeTeardownWindow',
    ]
    const f = makeFixture({ fail: all })

    await f.lifecycle.teardown(f.b)

    const turn = teardownTurnTrail(f.b, launchPassOf(f, undefined))
    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
    // Every step of the turn failed once (the repeated stops and forgets each count), the window's open and close
    // included: 35; the submit's end, the turn's last call, is no step (its own case below).
    expect(turn).toHaveLength(36)
    expect(turn.at(-1)).toBe(`notifier.settleTeardown:${f.b.key}`)
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with ${turn.length - 1} failed step(s)`)
    expect(f.lines.filter((line) => line.includes(' delete '))).toEqual([])
    assertNoLeak({ lines: f.lines })
  })

  // b.jg5 SRJ-1003: the window opens at the turn's start and closes after its last step, whatever a step throws.
  test('b.jg5 SRJ-1003: the notice window opens right after the outage reset, before the turn\'s first step, and closes after its last step, then the submit ends; a throwing step and a throwing launch pass still leave it closed', async () => {
    const f = makeFixture({ fail: ['connections.stop', 'killInstance', 'replyGuard.launchPass'] })
    const k = f.b.key

    await f.lifecycle.teardown(f.b)

    const opened = f.trail.indexOf(`notifier.openTeardownWindow:${k}`)
    expect(f.trail.slice(opened - 1, opened + 2)).toEqual([`resetOutageState:${k}`, `notifier.openTeardownWindow:${k}`, `stopApprover:${k}`])
    expect(f.trail.slice(-3)).toEqual([expect.stringMatching(/^replyGuard\.launchPass:/), ...turnEnd(f.b)])
    expect(f.trail.filter((c) => c.startsWith('notifier.') && c !== `notifier.forget:${k}`)).toEqual([
      `notifier.submitTeardown:${k}`, `notifier.openTeardownWindow:${k}`, `notifier.closeTeardownWindow:${k}`, `notifier.settleTeardown:${k}`,
    ])
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with 3 failed step(s)`)
  })

  // Rows: the notifier call that fails (the submit's registration, at submit; its end, after the window closed), and
  // the trail and line it leaves. The registration, made before the teardown starts, is not counted; the submit's
  // end, made in the teardown, is counted as a failed step, its line before the complete line, which is last.
  test.each<['notifier.submitTeardown' | 'notifier.settleTeardown', string]>([
    ['notifier.submitTeardown', 'registering its submit'],
    ['notifier.settleTeardown', 'ending its submit'],
  ])('b.jg5 SRJ-1003: %s throwing: one token-safe line naming B (%s failed), every step still runs, the window still opens and closes; only the submit\'s end is counted, and the complete line is last', async (dep, phrase) => {
    const f = makeFixture({ fail: [dep] })
    const k = f.b.key

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    // A failed registration leaves no submit to end.
    const full = fullTeardownTrail(f.b, launchPassOf(f, undefined))
    expect(f.trail).toEqual(dep === 'notifier.submitTeardown' ? full.filter((c) => c !== `notifier.settleTeardown:${k}`) : full)
    const failedLine = expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: ${phrase} failed: Error`)}( |$)`))
    const [starting, killLine, complete] = cleanTeardownLines(f.b)
    expect(f.lines).toEqual(
      dep === 'notifier.submitTeardown'
        ? [failedLine, starting, killLine, complete]
        : [starting, killLine, failedLine, `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`],
    )
    assertNoLeak({ lines: f.lines })
  })

  // b.jg5 SRJ-1003: the steps run without awaiting (the outage reset, the window's open and close) count a returned
  // promise that rejects too: it is settled before the complete line, its line logged and counted, the complete line
  // last. Rows: the step, its phrase, and whether its rejection settles after the kill (the window's close runs last).
  test.each<['resetOutageState' | 'notifier.openTeardownWindow' | 'notifier.closeTeardownWindow', string, boolean]>([
    ['resetOutageState', 'forgetting its outage state', false],
    ['notifier.openTeardownWindow', 'opening its notice window', false],
    ['notifier.closeTeardownWindow', 'closing its notice window', true],
  ])('b.jg5 SRJ-1003: %s returning a rejected promise: one token-safe line (%s failed) before the complete line, which counts it; every step still runs', async (dep, phrase, afterKill) => {
    const f = makeFixture({ fail: [dep], rejectFailures: true })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
    const failedLine = expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: ${phrase} failed: Error`)}( |$)`))
    const [starting, killLine] = cleanTeardownLines(f.b)
    expect(f.lines).toEqual([
      starting,
      ...(afterKill ? [killLine, failedLine] : [failedLine, killLine]),
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
  })

  // b.jg5 SRJ-1003: a teardown whose turn never runs (its serializer turn rejected before it) still ends its submit.
  test('b.jg5 SRJ-1003: a teardown whose serializer rejects without running its turn still ends its submit once, and opens no window', async () => {
    const f = makeFixture({ overrides: { serialize: () => Promise.reject(failure()) } })
    const k = f.b.key

    await expect(f.lifecycle.teardown(f.b)).rejects.toThrow()

    expect(f.trail).toEqual([...submitCancels(f.b), `notifier.settleTeardown:${k}`])
    expect(f.lines).toEqual([])
  })

  test('dry run: no agent-director kill (its outage state is still forgotten and its notice window opened and closed), one dry-run line naming cscb_<key> and saying the row is kept; every other step still runs', async () => {
    const f = makeFixture({ dryRun: true })

    await f.lifecycle.teardown(f.b)

    const k = f.b.key
    const full = fullTeardownTrail(f.b, launchPassOf(f, undefined))
    expect(f.trail).toEqual(full.filter((c) => c !== `killInstance:${k}`))
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      `[slack] dry-run: persona teardown of ${renderPersonaRef(f.b.name, k)}: skipping the agent-director kill of ${personaInstanceId(k)}; the row is kept`,
      `${teardownPrefix(f.b)}: complete`,
    ])
  })

  test('a throwing logger does not stop the teardown', async () => {
    const f = makeFixture({ overrides: { log: () => { throw new Error('log sink exploded') } } })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()
    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
  })

  test('over the real ack tracker: tearing B down drops every ack-reaction entry of B\'s, so B added again starts clean, and leaves A\'s entries, even on the same message, untouched', async () => {
    const f = makeFixture({ overrides: { forgetAcks: forgetPersonaAcks } })
    const [a, b] = [f.a.key, f.b.key]
    trackAck(a, 'C0SHARED01', '1700000000.000100')
    trackAck(b, 'C0SHARED01', '1700000000.000100')
    trackAck(b, 'D0BETADM01', '1700000000.000200')
    trackAck(a, 'C0ALPHA001', '1700000000.000300')

    await f.lifecycle.teardown(f.b)

    // Every other step still ran, in order (the real forget records no trail entry).
    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)).filter((c) => c !== `forgetAcks:${b}`))
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
    expect(consumeAck(b, 'C0SHARED01', '1700000000.000100')).toBe(false)
    expect(consumeAck(b, 'D0BETADM01', '1700000000.000200')).toBe(false)
    expect(consumeAck(a, 'C0SHARED01', '1700000000.000100')).toBe(true)
    expect(consumeAck(a, 'C0ALPHA001', '1700000000.000300')).toBe(true)
  })

  // Rows: the forget that fails (b.jg5 SRJ-1016's notice episodes, SRJ-504's latch, SRJ-207's
  // ErrInvalidFlags hold), its step phrase, and how (no production form returns a promise, but a
  // rejection is awaited too). Each runs in the first group and again once the launch in flight
  // settled; the latch once more after the kill (b.jg5 SRJ-715).
  test.each<['forgetNoticeEpisodes' | 'forgetConflictLatch' | 'forgetInvalidFlagsHold', string, 'throws' | 'rejects']>([
    ['forgetNoticeEpisodes', 'forgetting its notice episodes', 'throws'],
    ['forgetNoticeEpisodes', 'forgetting its notice episodes', 'rejects'],
    ['forgetConflictLatch', 'forgetting its latch', 'throws'],
    ['forgetConflictLatch', 'forgetting its latch', 'rejects'],
    ['forgetInvalidFlagsHold', 'forgetting its ErrInvalidFlags hold', 'throws'],
    ['forgetInvalidFlagsHold', 'forgetting its ErrInvalidFlags hold', 'rejects'],
  ])('b.jg5: %s failing (%s; it %s): each of its steps is logged token-safely by its own phrase, every other step still runs, and the teardown completes counting each', async (dep, phrase, how) => {
    const f = makeFixture({
      overrides: {
        [dep]: (key: string) => {
          f.trail.push(`${dep}:${key}`)
          if (how === 'rejects') return Promise.reject(failure())
          throw failure()
        },
      },
    })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)))
    const failedLine = (step: string) => expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: ${step} failed: Error`)}( |$)`))
    const beforeKill = [failedLine(phrase), failedLine(`${phrase} again, after its launch in flight settled`)]
    const afterKill = dep === 'forgetConflictLatch' ? [failedLine(`${phrase} once more, after the kill`)] : []
    expect(f.lines.slice(1)).toEqual([
      ...beforeKill,
      killOutcomeLine(f.b),
      ...afterKill,
      `${teardownPrefix(f.b)}: complete, with ${beforeKill.length + afterKill.length} failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
  })

  test('b.jg5 SRJ-1016: over the real notice episodes, tearing B down ends every kind\'s episode of B silently (nothing posted or logged), so B added again begins afresh, and leaves A\'s episodes and posted marks untouched', async () => {
    const clock = createFakeClock()
    const posts: Array<{ key: string; text: string }> = []
    const episodeLogs: string[] = []
    const episodes = createPersonaEpisodes({
      sink: (key, text) => void posts.push({ key, text }),
      log: (line) => void episodeLogs.push(line),
      clock,
    })
    const f = makeFixture({ overrides: { forgetNoticeEpisodes: (key) => episodes.forget(key) } })
    const [a, b] = [f.a.key, f.b.key]
    for (const kind of PERSONA_EPISODE_KINDS) {
      episodes.begin(a, kind, 'case-1')
      episodes.begin(b, kind, 'case-1')
    }
    expect(episodes.post(a, PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE, 'alpha notice')).toBe(true)
    expect(episodes.post(b, PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE, 'beta notice')).toBe(true)
    const aViews = PERSONA_EPISODE_KINDS.map((kind) => episodes.view(a, kind))
    const postsBefore = posts.length

    await f.lifecycle.teardown(f.b)
    await flush()

    // Every other step still ran, in order (the real forget records no trail entry).
    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)).filter((c) => c !== `forgetNoticeEpisodes:${b}`))
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
    expect(posts.length).toBe(postsBefore)
    expect(episodeLogs).toEqual([])
    for (const kind of PERSONA_EPISODE_KINDS) expect(episodes.isOpen(b, kind)).toBe(false)
    expect(PERSONA_EPISODE_KINDS.map((kind) => episodes.view(a, kind))).toEqual(aViews)
    expect(episodes.hasPosted(a, PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE)).toBe(true)
    expect(episodes.post(a, PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE, 'alpha notice')).toBe(false)

    // B added again: its first episode of the kind begins afresh and posts again.
    expect(episodes.begin(b, PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE, 'case-1')).toBe('begun')
    expect(episodes.post(b, PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE, 'beta notice')).toBe(true)
    expect(posts.slice(postsBefore)).toEqual([{ key: b, text: 'beta notice' }])
    expect(clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Persona teardown end to end over the recovery harness (b.jg5 SRJ-715,
// SRJ-404, SRJ-706, SRJ-305, SRJ-504, SRJ-207, SRJ-1016): the lifecycle's
// teardown dependencies that act on what the harness owns are its
// `teardownDeps()`, bound as main() binds them (the real approver and
// sequence stops, retry controller, latch, hold, notice episodes, outage
// state and the bounded-retry kill on the harness's kill-retry clock); the
// rest are the fixture's recorders. Apply step 1 has already dropped P from
// the applied set (`h.remove`), as for a removed persona.
// ---------------------------------------------------------------------------

describe('persona teardown end to end over the recovery harness (b.jg5 SRJ-715): nothing the server runs for the key is left, the row is kept, and the other persona keeps its own', () => {
  /** A recovery harness for one case, checked for leaks and cleaned up after it. */
  function harness(): RecoveryHarness {
    const h = makeRecoveryHarness()
    cleanups.push(() => {
      try {
        assertNoLeak(h.captured())
      } finally {
        h.cleanup()
      }
    })
    return h
  }

  /** What is left for `key`, each read through its own module's query. */
  function leftFor(h: RecoveryHarness, key: string) {
    return {
      approver: h.approverRunning(key),
      sequence: h.sequenceRunning(key),
      retryTimer: h.controller.isArmed(key),
      latched: h.latch.isLatched(key),
      held: h.invalidFlagsHold.isHeld(key),
      openEpisodes: PERSONA_EPISODE_KINDS.filter((kind) => h.episodes.isOpen(key, kind)),
    }
  }

  const NOTHING_LEFT: ReturnType<typeof leftFor> = { approver: false, sequence: false, retryTimer: false, latched: false, held: false, openEpisodes: [] }

  // Rows: what P holds when its teardown is submitted, set through the real
  // route where one exists (a launch, the sequence's start entry, a CONFLICT
  // at P's spawn, an ErrInvalidFlags at P's reuse), and what that leaves
  // standing for P just before the teardown.
  test.each<[string, (h: RecoveryHarness, p: string) => Promise<void>, Partial<ReturnType<typeof leftFor>>]>([
    [
      'its dialog approver between laps after a launch, an armed retry timer and an open episode of every kind',
      async (h, p) => {
        // A row read pending: the approver's first lap finds no dialog and it sleeps until its next lap.
        h.script({ statusResult: cannedStatusResult({ state: 'pending' }) })
        expect(await h.launch(p)).toStrictEqual({ key: p, action: 'spawned' })
        await h.settle()
        h.controller.arm(p, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
        for (const kind of PERSONA_EPISODE_KINDS) h.episodes.begin(p, kind, 'case-1')
      },
      { approver: true, retryTimer: true, openEpisodes: [...PERSONA_EPISODE_KINDS] },
    ],
    [
      'a live-row sequence running and an armed retry timer',
      async (h, p) => {
        h.startSequence(p, { lastReadState: cannedStatusResult().state })
        await flush()
        h.controller.arm(p, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
      },
      { sequence: true, retryTimer: true },
    ],
    [
      'a latch set by a CONFLICT at its spawn, with its CONFLICT episode open',
      async (h, p) => {
        h.script({ spawnError: conflictForPersona(p) })
        expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })
        await h.settle()
        h.script({ spawnError: undefined })
      },
      { latched: true, openEpisodes: [PERSONA_EPISODE_KIND_CONFLICT] },
    ],
    [
      'an ErrInvalidFlags hold set by its reuse, with its hold episode open',
      async (h, p) => {
        await holdThroughReuse(h, p)
        await h.settle()
      },
      { held: true, openEpisodes: [PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD] },
    ],
  ])('P holding %s: once its teardown completes, no approver, live-row sequence, retry timer, latch, hold or notice episode is left for P; its row was killed once by the teardown and never deleted; Q\'s armed timer and open episode stay', async (_label, setUp, before) => {
    const h = harness()
    const [p, q] = h.keys as [string, string]
    await setUp(h, p)
    expect(leftFor(h, p)).toEqual({ ...NOTHING_LEFT, ...before })
    h.controller.arm(q, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
    h.episodes.begin(q, PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE, 'case-1')
    const qDue = h.controller.view(q)!.dueAt
    const killsBefore = h.stub.calls.killCalls.length
    h.remove(p) // apply step 1
    const f = makeFixture({ overrides: h.teardownDeps() })

    await h.driveSequence(h.drive(f.lifecycle.teardown(personaOf(h, p))))
    await h.settle()

    expect(leftFor(h, p)).toEqual(NOTHING_LEFT)
    // The row is kept: the teardown's one kill of P's row, and no delete at all.
    expect(h.stub.calls.killCalls.slice(killsBefore)).toEqual([{ claude_instance_id: personaInstanceId(p) }])
    expect(h.stub.calls.deleteCalls).toEqual([])
    const ref = personaOf(h, p)
    expect(f.lines[0]).toBe(`${teardownPrefix(ref)}: starting`)
    expect(f.lines.filter((line) => line.startsWith(`${teardownPrefix(ref)}: agent-director kill of ${personaInstanceId(p)}`))).toEqual([
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(ref)}: agent-director kill of ${personaInstanceId(p)}: `)}.* after 1 kill\\(s\\); the row is kept \\(b\\.jg5 SRJ-715\\)$`)),
    ])
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(ref)}: complete`)
    // Q keeps its own.
    expect(h.controller.armedKeys()).toEqual([q])
    expect(h.controller.view(q)!.dueAt).toBe(qDue)
    expect(h.episodes.isOpen(q, PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE)).toBe(true)
    h.controller.stop(q, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
  })

  // b.jg5 SRJ-404, SRJ-715: the stop made when the teardown is submitted,
  // before its serializer turn, cancels the approver P's launch in flight
  // would start. The turn is held behind work already queued for P, so only
  // the submit-time stop has run when the held spawn succeeds.
  test('the stop at submit cancels the approver P\'s launch in flight would start: with the turn held behind work queued for P, the held spawn succeeds, the launch answers spawned and no approver starts (one not-started line, no approver call); the turn then completes', async () => {
    const h = harness()
    const [p] = h.keys as [string]
    const spawns = holdSpawns(h.stub.client)
    const launch = h.launch(p)
    await spawns.entered(personaInstanceId(p))
    h.remove(p) // apply step 1
    const f = makeFixture({ overrides: h.teardownDeps() })
    const ahead = Promise.withResolvers<void>()
    const queued = f.serializer.run(p, () => ahead.promise)

    const done = f.lifecycle.teardown(personaOf(h, p))
    await flush()
    // Only the submit-time stops ran: the turn has not started.
    expect(f.lines).toEqual([])
    const before = callCounts(h)

    spawns.release(personaInstanceId(p))
    expect(await launch).toStrictEqual({ key: p, action: 'spawned' })
    await h.settle()

    expect(h.approverRunning(p)).toBe(false)
    expect(await _whenDialogApproverStopped(p)).toBeUndefined()
    // No approver call followed the spawn.
    expect(callCountsSince(callCounts(h), before)).toEqual({})
    expect(h.errors.filter((line) => line.startsWith(APPROVER_LOG_PREFIX))).toEqual([
      approverLogLine(approverNotStartedMessage(renderPersonaRef(personaOf(h, p).name, p), APPROVER_STOP_TEARDOWN)),
    ])
    expect(await settled(done)).toBe(false)

    ahead.resolve()
    await queued
    await h.drive(done)
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(personaOf(h, p))}: complete`)
    expect(h.approverRunning(p)).toBe(false)
  })
  // b.jg5 SRJ-811 (hatch A3): the teardown's old-life step (the session
  // manager's forgetOldLifeWaits, through `teardownDeps()`) forgets P as
  // waiting and stops the hold's wait only when no persona left in the
  // applied configuration waits on it. P waits on a pre-persona row held in
  // its working directory (its launch held back by the gate, the wait's first
  // run held); with Q in the same directory, Q waits too. Configuration
  // validation refuses two personas in one working directory (src/config.ts),
  // so the shared row is a unit case of the teardown's other-waiter rule only;
  // the multi-waiter setup production reaches (B's own row swept into P's
  // directory, B waiting on its own row, its teardown as the last waiter
  // stopping the wait) is tests/old-life-wait.test.ts's.
  test.each<[string, boolean]>([
    ['P the only waiting persona: the wait is stopped (teardown), and the hold goes on with no one waiting', false],
    ['Q in P\'s directory waiting too: the wait goes on, Q still waiting, and once the hold ends Q, not P, is retried at once', true],
  ])('%s', async (_label, shared) => {
    const workDir = join(dir, 'shared-work')
    mkdirSync(workDir)
    const h = makeRecoveryHarness(shared ? { personas: [{ working_directory: workDir }, { working_directory: workDir }] } : {})
    cleanups.push(() => {
      try {
        h.controller.stopAll('the case is over')
        assertNoLeak(h.captured())
      } finally {
        h.cleanup()
      }
    })
    const [p, q] = h.keys as [string, string]
    const oldId = PRE_PERSONA_ID
    const held = personaOf(h, p).working_directory
    holdOldAt(h, oldId, oldId, p)
    h.script({ getResult: cannedGetResult({ claude_instance_id: oldId, cwd: held }) })
    rowReadsUntilSpawn(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const hold = holdFindMissing(h.stub.client)
    expect((await h.launch(p)).action).toBe('sequence-waiting')
    await h.driveSequence(hold.entered(1))
    if (shared) expect((await h.launch(q)).action).toBe('sequence-waiting')
    h.remove(p) // apply step 1
    const f = makeFixture({ overrides: h.teardownDeps() })
    const others = shared ? [q] : []
    const line = oldLifeWaitTeardownLine(p, oldId, others, true)

    const done = f.lifecycle.teardown(personaOf(h, p))
    for (let turn = 0; turn < 100 && !h.errors.includes(line); turn++) await flush()
    expect(h.errors.filter((l) => l === line)).toHaveLength(1)
    // The wait's held run returns: a stopped wait makes no further call, a running one goes on to its next step.
    hold.release(shared ? cannedFindMissing({ rows: { [oldId]: 'ids' } }) : cannedFindMissing())
    await h.driveSequence(h.drive(done))
    await h.settle()

    expect(f.lines.at(-1)).toBe(`${teardownPrefix(personaOf(h, p))}: complete`)
    expect(await h.oldLifeWaitSettled(oldId)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: shared ? LIVE_ROW_STOP_HOLD_ENDED : LIVE_ROW_STOP_TEARDOWN })
    expect(h.oldLifeWaitRunning(oldId)).toBe(false)
    if (shared) {
      expect(h.oldLifeHolds.holdOf(oldId)).toBeUndefined()
      expect(h.holdEndRetries.map((r) => r.key)).toEqual([q])
      expect(h.stub.calls.spawnCalls.map((params) => params.claude_instance_id)).toEqual([personaInstanceId(q)])
      await h.runApproverToStop(q)
    } else {
      expect(h.oldLifeHolds.holdOf(oldId)?.waiting).toEqual([])
      // No run after the stopped one.
      expect([h.holdEndRetries, hold.calls.length, h.stub.calls.getCalls.length]).toEqual([[], 1, 1])
    }
  })
})

// ---------------------------------------------------------------------------
// Persona teardown of a key still applied: the old half of a destructive
// modify (b.av2 SR-8.6, a credentials_file path or working_directory change).
// ---------------------------------------------------------------------------

describe('persona teardown of a key still applied (the old half of a destructive modify, SR-8.6)', () => {
  // Rows: whether B is still applied when its teardown is submitted, what ran
  // at submit while B's turn was held, and the whole trail once it ran.
  test.each<[string, boolean, (f: Fixture) => string[], (f: Fixture, launchPass: string) => string[]]>([
    [
      'B still applied (a destructive modify\'s old half): its submit registered and its dialog approver stopped first, then its launch\'s wait, bring-up retries and restart timer are cancelled and its UNAVAILABLE retry timer stopped at submit, before its turn; its turn is a removed key\'s, its held notices dropped once and never again after the kill',
      true,
      (f) => [...submitCancels(f.b), `bringUps.cancel:${f.b.key}`, `cancelRestartTimer:${f.b.key}`, `stopRetryTimer:${f.b.key}`],
      (f, launchPass) => stillAppliedTeardownTrail(f.b, launchPass),
    ],
    [
      'B removed (it left the applied set at step 1): only its submit is registered, its dialog approver and live-row sequence stopped and its launch\'s wait for a working row cancelled before its turn, and its notices are dropped once',
      false,
      (f) => submitCancels(f.b),
      (f, launchPass) => fullTeardownTrail(f.b, launchPass),
    ],
  ])('%s', async (_label, stillApplied, atSubmit, whole) => {
    const f = makeFixture()
    if (stillApplied) f.applied.push(f.b)
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const done = f.lifecycle.teardown(f.b)
    await flush()
    expect(f.trail).toEqual(atSubmit(f))
    expect(f.lines).toEqual([])

    blocker.resolve()
    await held
    await done
    const launchPass = `${JSON.stringify([f.b.claude_config_dir, undefined])}:[${f.applied.map((p) => p.key).join(',')}]`
    expect(f.trail).toEqual(whole(f, launchPass))
    expect(f.lines).toEqual(cleanTeardownLines(f.b))
    expect(f.trail.join('\n')).not.toContain(f.a.key + ':')
    expect(f.submitted).toEqual([f.b.key])
  })

  test('dry run, B still applied: the early cancels and the notice window still run; only the kill is skipped', async () => {
    const f = makeFixture({ dryRun: true })
    f.applied.push(f.b)

    await f.lifecycle.teardown(f.b)

    const k = f.b.key
    const launchPass = `${JSON.stringify([f.b.claude_config_dir, undefined])}:[${f.a.key},${k}]`
    expect(f.trail).toEqual(stillAppliedTeardownTrail(f.b, launchPass).filter((c) => c !== `killInstance:${k}`))
  })

  // Rows: the early cancel that fails, its step phrase, and whether it throws or returns a rejected promise.
  test.each<[DepName, string, 'throws' | 'rejects']>([
    ['bringUps.cancel', 'cancelling its bring-up retries', 'throws'],
    ['cancelRestartTimer', 'cancelling its restart timer', 'throws'],
    ['cancelRestartTimer', 'cancelling its restart timer', 'rejects'],
    ['stopRetryTimer', 'stopping its UNAVAILABLE retry timer', 'throws'],
    ['stopRetryTimer', 'stopping its UNAVAILABLE retry timer', 'rejects'],
    ['cancelLaunchWait', 'cancelling its launch\'s wait for a working row', 'throws'],
    // b.jg5 SRJ-404, SRJ-715: the approver's stop, first at submit.
    ['stopApprover', 'stopping its dialog approver', 'throws'],
    ['stopApprover', 'stopping its dialog approver', 'rejects'],
    // b.jg5 SRJ-706, SRJ-715: the live-row sequence's stop, right after it.
    ['stopLiveRowSequence', LIVE_ROW_SEQUENCE_STOP_STEP, 'throws'],
    ['stopLiveRowSequence', LIVE_ROW_SEQUENCE_STOP_STEP, 'rejects'],
  ])('%s failing at submit (%s; it %s): one token-safe "before its turn failed" line, the other early cancels still run, and the whole teardown still runs', async (dep, phrase, how) => {
    // A throw also fails the same step in the teardown's turn; a rejection is overridden for the early call only.
    let calls = 0
    const rejectFirst = (key: string) => {
      f.trail.push(`${dep}:${key}`)
      return calls++ === 0 ? Promise.reject(failure()) : false
    }
    // The approver's and the sequence's stops return a promise in production (the recorder rejects), so their throw is an override.
    const throwEvery = (key: string): never => {
      f.trail.push(`${dep}:${key}`)
      throw failure()
    }
    const f = makeFixture(
      dep === 'stopApprover' || dep === 'stopLiveRowSequence'
        ? { overrides: { [dep]: how === 'throws' ? throwEvery : rejectFirst } }
        : how === 'throws'
          ? { fail: [dep] }
          : { overrides: dep === 'stopRetryTimer' ? { stopRetryTimer: rejectFirst } : { cancelRestartTimer: rejectFirst } },
    )
    f.applied.push(f.b)

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()
    await flush()

    const launchPass = `${JSON.stringify([f.b.claude_config_dir, undefined])}:[${f.a.key},${f.b.key}]`
    expect(f.trail).toEqual(stillAppliedTeardownTrail(f.b, launchPass))
    const beforeTurn = f.lines.filter((l) => l.includes(' before its turn failed: '))
    expect(beforeTurn).toHaveLength(1)
    expect(beforeTurn[0]).toMatch(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: ${phrase} before its turn failed: Error`)}( |$)`))
    expect(f.lines).toContain(`${teardownPrefix(f.b)}: starting`)
    // A throwing stopRetryTimer fails the turn's three stops (with the early timers, once its launch in flight settled,
    // and after the agent-director calls; b.jg5 SRJ-311, SRJ-715); a throwing sequence stop fails both of the turn's
    // sequence stops (its second step, and again once its launch in flight settled).
    const turnFailures = how === 'rejects' ? 0 : dep === 'stopRetryTimer' ? 3 : dep === 'stopLiveRowSequence' ? 2 : 1
    expect(f.lines.at(-1)).toBe(turnFailures === 0 ? `${teardownPrefix(f.b)}: complete` : `${teardownPrefix(f.b)}: complete, with ${turnFailures} failed step(s)`)
    assertNoLeak({ lines: f.lines })
  })

  test('every early cancel failing: one line each, in order, before the teardown starts', async () => {
    const f = makeFixture({ fail: ['bringUps.cancel', 'cancelRestartTimer', 'stopRetryTimer'] })
    f.applied.push(f.b)

    await f.lifecycle.teardown(f.b)

    expect(f.lines.slice(0, 4)).toEqual([
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: cancelling its bring-up retries before its turn failed: Error`)}( |$)`)),
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: cancelling its restart timer before its turn failed: Error`)}( |$)`)),
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: stopping its UNAVAILABLE retry timer before its turn failed: Error`)}( |$)`)),
      `${teardownPrefix(f.b)}: starting`,
    ])
    // In the turn: the bring-up cancel, the restart-timer cancel and the three retry-timer stops (with the early
    // timers, once its launch in flight settled, and after the agent-director calls; b.jg5 SRJ-311, SRJ-715).
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with 5 failed step(s)`)
    assertNoLeak({ lines: f.lines })
  })

  test('B still applied and dropping its notices failing: its one drop is logged token-safely, there is no second drop after the kill (b.jg5 SRJ-1003), and every other step still runs', async () => {
    const f = makeFixture({ fail: ['notifier.forget'] })
    f.applied.push(f.b)

    await f.lifecycle.teardown(f.b)

    const launchPass = `${JSON.stringify([f.b.claude_config_dir, undefined])}:[${f.a.key},${f.b.key}]`
    expect(f.trail).toEqual(stillAppliedTeardownTrail(f.b, launchPass))
    expect(f.trail.filter((c) => c.startsWith('notifier.forget:'))).toEqual([`notifier.forget:${f.b.key}`])
    expect(f.lines.slice(1, -1)).toEqual([
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: dropping its held notices failed: Error`)}( |$)`)),
      killOutcomeLine(f.b),
    ])
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with 1 failed step(s)`)
    assertNoLeak({ lines: f.lines })
  })

  test('the applied set cannot be read: B counts as not applied (none of the still-applied cancels at submit), and the launch pass\'s failed read is its one failed step', async () => {
    const f = makeFixture({ overrides: { appliedPersonas: () => { throw failure() } } })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, '').filter((c) => !c.startsWith('replyGuard.launchPass:')))
    expect(f.lines.slice(1)).toEqual([
      killOutcomeLine(f.b),
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: re-evaluating the Stop hook in its config directories failed: Error`)}( |$)`)),
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
  })
})

/** The channel a destructive modify's new half of B sends its notices to, unlike the old half's. */
const NEW_HALF_CHANNEL = 'C0BETANEW1'

/**
 * Step 1 of a destructive modify of `old` (SR-8.6): its key stays applied, its
 * new half's declaration sending notices to `NEW_HALF_CHANNEL` (its own
 * channel and prompt target), put in `old`'s place in the notifier harness's
 * persona list and added to `applied`. Answers the new half.
 */
function applyNewHalfOf(h: NotifierHarness, applied: Persona[], old: Persona): Persona {
  const newHalf: Persona = { ...old, channels: [{ id: NEW_HALF_CHANNEL, delivery: 'all' }], permission_prompts: NEW_HALF_CHANNEL }
  expect(newHalf.permission_prompts).not.toBe(old.permission_prompts)
  h.personas.splice(h.personas.findIndex((p) => p.key === old.key), 1, newHalf)
  applied.push(newHalf)
  return newHalf
}

// ---------------------------------------------------------------------------
// Persona teardown over the real latch (b.jg5 SRJ-504, SRJ-1002): the latch
// ends silently with its persona, a latch its launch in flight set included.
// ---------------------------------------------------------------------------

describe('persona teardown over the real latch (b.jg5 SRJ-504, SRJ-1002): the key\'s latch and CONFLICT episode end silently, for that key only', () => {
  interface LatchFixture {
    f: Fixture
    latch: ConflictLatch
    episodes: PersonaEpisodes
    /** Every notice the episodes' sink received (the persona notifier in production), in order. */
    posts: Array<{ key: string; text: string }>
    /** The latch's and the episodes' log lines. */
    latchLines: string[]
    /** With `notifier`: the real notifier the episodes' sink and the lifecycle's notifier are (b.jg5 SRJ-1003). */
    h?: NotifierHarness
  }

  /**
   * A real latch with the CONFLICT notice bound to real notice episodes (fake
   * clock, recording sink), as `main()` binds them; the lifecycle's latch and
   * episodes forgets are theirs, each recorded in the trail first so the
   * order is asserted with the other steps. `launchInFlight` is B's launch in
   * flight, given the latch. With `notifier` (b.jg5 SRJ-1003), as `main()`
   * binds them: the sink hands each notice to the real notifier (recorded
   * first), the episodes read its teardown window, and the lifecycle's
   * notifier is that notifier, so its window routes what the teardown raises.
   */
  function makeLatched(opts: { launchInFlight?: (latch: ConflictLatch) => Promise<void>; dryRun?: boolean; notifier?: boolean } = {}): LatchFixture {
    const clock = createFakeClock()
    const posts: LatchFixture['posts'] = []
    const latchLines: string[] = []
    const h = opts.notifier === true ? makeNotifierHarness(makeConfig(), { leakMarker: LEAK_SENTINEL }) : undefined
    const episodes = createPersonaEpisodes({
      sink: (key, text, options) => {
        posts.push({ key, text })
        return h?.notifier.notify(key, text, options)
      },
      log: (line) => void latchLines.push(line),
      clock,
      ...(h !== undefined ? { teardownWindow: (key: string) => h.notifier.teardownWindowState(key) } : {}),
    })
    const latch = createConflictLatch({ log: (line) => void latchLines.push(line) })
    bindConflictNotice(latch, episodes)
    const f: Fixture = makeFixture({
      dryRun: opts.dryRun ?? false,
      ...(opts.launchInFlight !== undefined ? { launchInFlight: () => opts.launchInFlight!(latch) } : {}),
      overrides: {
        forgetConflictLatch: (key) => {
          f.trail.push(`forgetConflictLatch:${key}`)
          return latch.forget(key)
        },
        forgetNoticeEpisodes: (key) => {
          f.trail.push(`forgetNoticeEpisodes:${key}`)
          episodes.forget(key)
        },
        ...(h !== undefined ? { notifier: h.notifier } : {}),
      },
    })
    cleanups.push(() => {
      try {
        expect(clock.pendingCount()).toBe(0)
        assertNoLeak({ lines: f.lines, latchLines, posts, ...(h !== undefined ? { logs: h.logs, slack: h.allPosts(), entries: h.startupEntries() } : {}) })
      } finally {
        h?.hold.cancelAll()
        h?.cleanup()
      }
    })
    return { f, latch, episodes, posts, latchLines, ...(h !== undefined ? { h } : {}) }
  }

  /** B's plain spawn refused by the pre-spawn scan ("left over from an earlier life", no row; HO §7 scenario 19). */
  const LEFTOVER: ConflictLatchSetInput = { latchCase: LATCH_CASE_LEFTOVER, refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: LATCH_ROW_STATE_NO_ROW }
  /** A's `resume` refused with "own id", its row read `ended`. */
  const OWN_ID: ConflictLatchSetInput = { latchCase: LATCH_CASE_OWN_ID, refusedOperation: REFUSED_OPERATION_RESUME, rowState: latchRowStateRead('ended') }

  /** The CONFLICT notice B's leftover latch posts. */
  function leftoverNotice(r: LatchFixture): { key: string; text: string } {
    const record = r.latch.record(r.f.b.key)!
    return { key: r.f.b.key, text: conflictNoticeText({ sessionName: record.sessionName, latchCase: LATCH_CASE_LEFTOVER, description: record.description }) }
  }

  test('tearing latched B down leaves B unlatched with no CONFLICT episode open, posts nothing (no recovery notice) and logs no clear; A\'s latch, record and posted episode stay; B added again latches with exactly one new post', async () => {
    const r = makeLatched()
    const [a, b] = [r.f.a.key, r.f.b.key]
    r.latch.set(a, OWN_ID)
    r.latch.set(b, LEFTOVER)
    const bNotice = leftoverNotice(r)
    expect(r.posts.map((p) => p.key)).toEqual([a, b])
    const aRecord = r.latch.record(a)
    const aEpisode = r.episodes.view(a, PERSONA_EPISODE_KIND_CONFLICT)
    const postsBefore = [...r.posts]
    const linesBefore = [...r.latchLines]

    await r.f.lifecycle.teardown(r.f.b)
    await flush()

    expect(r.f.trail).toEqual(fullTeardownTrail(r.f.b, launchPassOf(r.f, undefined)))
    expect(r.f.lines).toEqual(cleanTeardownLines(r.f.b))
    expect(r.latch.isLatched(b)).toBe(false)
    expect(r.latch.record(b)).toBeUndefined()
    expect(r.episodes.isOpen(b, PERSONA_EPISODE_KIND_CONFLICT)).toBe(false)
    expect(r.posts).toEqual(postsBefore)
    expect(r.latchLines).toEqual(linesBefore)
    expect(r.latch.isLatched(a)).toBe(true)
    expect(r.latch.record(a)).toBe(aRecord)
    expect(r.episodes.view(a, PERSONA_EPISODE_KIND_CONFLICT)).toEqual(aEpisode)

    // B added again: its next attempt meeting the same case latches it afresh, with one post.
    expect(r.latch.set(b, LEFTOVER)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(r.posts.slice(postsBefore.length)).toEqual([bNotice])
  })

  // b.jg5 SRJ-1002, SRJ-1003 (hatch A3): the latch B's launch in
  // flight sets during the teardown raises its CONFLICT notice at the set,
  // inside the window: the window writes it (one log line and one
  // persona-teardown-notice entry naming B), it reaches no destination and is
  // never dropped; the latch is then forgotten, so the teardown latches
  // nothing. Over the real notifier, as main() binds it.
  test('SRJ-1002, SRJ-1003: a latch B\'s launch in flight sets as it settles during the teardown is forgotten too (the forget waits for the launch); its CONFLICT notice is written by the window (one log line, one persona-teardown-notice entry), never posted or dropped, and its episode is not left open: B added again and latched posts to its destination', async () => {
    const release = Promise.withResolvers<void>()
    let bRecordAtSettle: ConflictLatchRecord | undefined
    const r = makeLatched({
      notifier: true,
      // B's held launch: once released, its plain spawn is refused by the pre-spawn scan, latching B.
      launchInFlight: (latch) =>
        release.promise.then(() => {
          latch.set(r.f.b.key, LEFTOVER)
          bRecordAtSettle = latch.record(r.f.b.key)
        }),
    })
    const h = r.h!
    const [a, b] = [r.f.a.key, r.f.b.key]
    h.personas.splice(h.personas.findIndex((p) => p.key === b), 1) // apply step 1: B removed
    r.latch.set(a, OWN_ID)
    const aRecord = r.latch.record(a)!
    const aText = conflictNoticeText({ sessionName: aRecord.sessionName, latchCase: LATCH_CASE_OWN_ID, description: aRecord.description })
    await flush()
    expect(h.posts(a)).toEqual([{ channel: r.f.a.permission_prompts, text: formatPersonaNotice(r.f.a, aText) }])
    // The real notifier records no trail entry.
    const full = fullTeardownTrail(r.f.b, launchPassOf(r.f, undefined)).filter((c) => !c.startsWith('notifier.'))

    const done = r.f.lifecycle.teardown(r.f.b)
    await flush()
    // The teardown waits for the launch: nothing after the wait has run.
    expect(r.f.trail).toEqual(untilLaunchSettled(full, r.f.b))
    expect(r.latch.isLatched(b)).toBe(false)
    expect(h.notifier.teardownWindowState(b)).toBe('open')

    release.resolve()
    await done
    await flush()

    expect(r.latch.isLatched(b)).toBe(false)
    expect(r.episodes.isOpen(b, PERSONA_EPISODE_KIND_CONFLICT)).toBe(false)
    expect(h.notifier.teardownWindowState(b)).toBe('none')
    expect(r.f.trail).toEqual(full)
    expect(r.f.lines).toEqual(cleanTeardownLines(r.f.b))
    expect(bRecordAtSettle!.latchCase).toBe(LATCH_CASE_LEFTOVER)
    const bText = conflictNoticeText({ sessionName: bRecordAtSettle!.sessionName, latchCase: LATCH_CASE_LEFTOVER, description: bRecordAtSettle!.description })
    // The in-flight latch's notice reached the notifier, which wrote it: one entry, one line, no Slack call for B.
    expect(r.posts).toEqual([{ key: a, text: aText }, { key: b, text: bText }])
    expect(h.startupEntries()).toEqual([teardownNoticeEntry(r.f.b, bText)])
    expect(h.logs).toEqual([teardownNoticeLine(r.f.b, bText)])
    expect(h.stub(b).callLog).toEqual([])
    expect(h.posts(a)).toHaveLength(1)
    expect(r.latch.isLatched(a)).toBe(true)

    // B added again, meeting the same case: a new episode, so exactly one new post, at its destination.
    h.personas.push(r.f.b)
    expect(r.latch.set(b, LEFTOVER)).toBe(CONFLICT_LATCH_SET_LATCHED)
    await flush()
    expect(h.posts(b)).toEqual([{ channel: r.f.b.permission_prompts, text: formatPersonaNotice(r.f.b, leftoverNotice(r).text) }])
    expect(h.startupEntries()).toHaveLength(1)
  })

  test('the old half of a destructive modify (B still applied) forgets B\'s latch too: the new half starts unlatched and, meeting the same CONFLICT itself, latches with exactly one post for B', async () => {
    const r = makeLatched()
    const b = r.f.b
    r.f.applied.push(b) // B keeps its key applied until step 6 brings its new declaration up
    r.latch.set(r.f.a.key, OWN_ID)
    r.latch.set(b.key, LEFTOVER)
    const bNotice = leftoverNotice(r)
    const postsBefore = r.posts.length

    await r.f.lifecycle.teardown(b)
    await flush()

    const launchPass = `${JSON.stringify([b.claude_config_dir, undefined])}:[${r.f.a.key},${b.key}]`
    expect(r.f.trail).toEqual(stillAppliedTeardownTrail(b, launchPass))
    expect(r.latch.isLatched(b.key)).toBe(false)
    expect(r.episodes.isOpen(b.key, PERSONA_EPISODE_KIND_CONFLICT)).toBe(false)
    expect(r.posts).toHaveLength(postsBefore)
    expect(r.latch.isLatched(r.f.a.key)).toBe(true)

    // The new half's own launch meets the same CONFLICT (twice): one latch, one post.
    expect(r.latch.set(b.key, LEFTOVER)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(r.latch.set(b.key, LEFTOVER)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(r.posts.slice(postsBefore)).toEqual([bNotice])
  })

  test('dry run: B\'s latch and CONFLICT episode are still forgotten silently (only the agent-director kill is skipped)', async () => {
    const r = makeLatched({ dryRun: true })
    r.latch.set(r.f.b.key, LEFTOVER)
    const postsBefore = r.posts.length

    await r.f.lifecycle.teardown(r.f.b)
    await flush()

    expect(r.f.trail).not.toContain(`killInstance:${r.f.b.key}`)
    expect(r.latch.isLatched(r.f.b.key)).toBe(false)
    expect(r.episodes.isOpen(r.f.b.key, PERSONA_EPISODE_KIND_CONFLICT)).toBe(false)
    expect(r.posts).toHaveLength(postsBefore)
  })
})

// ---------------------------------------------------------------------------
// Persona teardown over the real ErrInvalidFlags hold (b.jg5 SRJ-207,
// SRJ-715): the hold ends silently with its persona, a hold its launch in
// flight set included.
// ---------------------------------------------------------------------------

describe('persona teardown over the real ErrInvalidFlags hold (b.jg5 SRJ-207, SRJ-715): the key\'s hold and hold episode end silently, for that key only', () => {
  interface HoldFixture {
    f: Fixture
    hold: InvalidFlagsHold
    episodes: PersonaEpisodes
    /** Every alert the episodes' sink received (the persona notifier in production), in order. */
    posts: Array<{ key: string; text: string }>
    /** The hold's and the episodes' log lines. */
    holdLines: string[]
    /** Every retry-timer stop the set reaction asked for, by key. */
    timerStops: string[]
    /** With `notifier`: the real notifier the episodes' sink and the lifecycle's notifier are (b.jg5 SRJ-1003). */
    h?: NotifierHarness
  }

  /**
   * A real hold with its set reaction bound to real notice episodes (fake
   * clock, recording sink), as `main()` binds it; the lifecycle's hold and
   * episodes forgets are theirs, each recorded in the trail first so the
   * order is asserted with the other steps. `launchInFlight` is B's launch in
   * flight, given the hold. With `notifier` (b.jg5 SRJ-1003), as `main()`
   * binds them: the sink hands each alert to the real notifier (recorded
   * first), the episodes read its teardown window, and the lifecycle's
   * notifier is that notifier.
   */
  function makeHeld(opts: { launchInFlight?: (hold: InvalidFlagsHold) => Promise<void>; notifier?: boolean } = {}): HoldFixture {
    const clock = createFakeClock()
    const posts: HoldFixture['posts'] = []
    const holdLines: string[] = []
    const timerStops: string[] = []
    const h = opts.notifier === true ? makeNotifierHarness(makeConfig(), { leakMarker: LEAK_SENTINEL }) : undefined
    const episodes = createPersonaEpisodes({
      sink: (key, text, options) => {
        posts.push({ key, text })
        return h?.notifier.notify(key, text, options)
      },
      log: (line) => void holdLines.push(line),
      clock,
      ...(h !== undefined ? { teardownWindow: (key: string) => h.notifier.teardownWindowState(key) } : {}),
    })
    const hold = createInvalidFlagsHold({ log: (line) => void holdLines.push(line) })
    bindInvalidFlagsHoldSetReaction(hold, { stopRetryTimer: (key) => void timerStops.push(key), episodes, log: (line) => void holdLines.push(line) })
    const f: Fixture = makeFixture({
      ...(opts.launchInFlight !== undefined ? { launchInFlight: () => opts.launchInFlight!(hold) } : {}),
      overrides: {
        forgetInvalidFlagsHold: (key) => {
          f.trail.push(`forgetInvalidFlagsHold:${key}`)
          return hold.forget(key)
        },
        forgetNoticeEpisodes: (key) => {
          f.trail.push(`forgetNoticeEpisodes:${key}`)
          episodes.forget(key)
        },
        ...(h !== undefined ? { notifier: h.notifier } : {}),
      },
    })
    cleanups.push(() => {
      try {
        expect(clock.pendingCount()).toBe(0)
        assertNoLeak({ lines: f.lines, holdLines, posts, ...(h !== undefined ? { logs: h.logs, slack: h.allPosts(), entries: h.startupEntries() } : {}) })
      } finally {
        h?.hold.cancelAll()
        h?.cleanup()
      }
    })
    return { f, hold, episodes, posts, holdLines, timerStops, ...(h !== undefined ? { h } : {}) }
  }

  /** The alert as the episodes' sink receives it for persona `key`. */
  const alertFor = (key: string): { key: string; text: string } => ({ key, text: INVALID_FLAGS_HOLD_ALERT_TEXT })

  test('tearing held B down leaves B unheld with no hold episode open, posts nothing and retries nothing (one forget line); A\'s hold and posted episode stay; B added again and held anew posts exactly one new alert', async () => {
    const r = makeHeld()
    const [a, b] = [r.f.a.key, r.f.b.key]
    expect(r.hold.set(a, PHASE1_RC_VERSION)).toBe(true)
    expect(r.hold.set(b, PHASE1_RC_VERSION)).toBe(true)
    await flush()
    expect(r.posts).toEqual([alertFor(a), alertFor(b)])
    const aEpisode = r.episodes.view(a, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD)
    const postsBefore = [...r.posts]
    const linesBefore = [...r.holdLines]
    const stopsBefore = [...r.timerStops]

    await r.f.lifecycle.teardown(r.f.b)
    await flush()

    expect(r.f.trail).toEqual(fullTeardownTrail(r.f.b, launchPassOf(r.f, undefined)))
    expect(r.f.lines).toEqual(cleanTeardownLines(r.f.b))
    expect(r.hold.isHeld(b)).toBe(false)
    expect(r.hold.heldKeys()).toEqual([a])
    expect(r.episodes.isOpen(b, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD)).toBe(false)
    expect(r.posts).toEqual(postsBefore)
    expect(r.timerStops).toEqual(stopsBefore)
    // The forget's one line; no end, retry or post line.
    expect(r.holdLines.slice(linesBefore.length)).toEqual([invalidFlagsHoldForgetLine(b, PHASE1_RC_VERSION)])
    expect(r.hold.isHeld(a)).toBe(true)
    expect(r.hold.beganUnder(a)).toBe(PHASE1_RC_VERSION)
    expect(r.episodes.view(a, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD)).toEqual(aEpisode)

    // B added again starts unheld; a new ErrInvalidFlags holds it afresh, with one post.
    expect(r.hold.set(b, PHASE1_RC_VERSION)).toBe(true)
    expect(r.hold.set(b, PHASE1_RC_VERSION)).toBe(false)
    await flush()
    expect(r.posts.slice(postsBefore.length)).toEqual([alertFor(b)])
  })

  test('a hold B\'s launch in flight sets as it settles during the teardown is forgotten too (the forget waits for the launch), and its hold episode is not left open: a later hold of B posts again', async () => {
    const release = Promise.withResolvers<void>()
    let postsAtSettle = -1
    const r = makeHeld({
      // B's held launch: once released, its reuse spawn answers ErrInvalidFlags and holds B.
      launchInFlight: (hold) =>
        release.promise.then(async () => {
          hold.set(r.f.b.key, PHASE1_RC_VERSION)
          await flush()
          postsAtSettle = r.posts.length
        }),
    })
    const b = r.f.b.key
    const full = fullTeardownTrail(r.f.b, launchPassOf(r.f, undefined))

    const done = r.f.lifecycle.teardown(r.f.b)
    await flush()
    // The teardown waits for the launch: nothing after the wait has run.
    expect(r.f.trail).toEqual(untilLaunchSettled(full, r.f.b))
    expect(r.hold.isHeld(b)).toBe(false)

    release.resolve()
    await done
    await flush()

    expect(r.f.trail).toEqual(full)
    expect(r.hold.isHeld(b)).toBe(false)
    expect(r.episodes.isOpen(b, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD)).toBe(false)
    // The one alert is the set's own, posted as the launch settled; the teardown posted nothing.
    expect(postsAtSettle).toBe(1)
    expect(r.posts).toEqual([alertFor(b)])

    // B added again and held anew: a new episode, so exactly one new post.
    expect(r.hold.set(b, PHASE1_RC_VERSION)).toBe(true)
    await flush()
    expect(r.posts).toEqual([alertFor(b), alertFor(b)])
  })

  // b.jg5 SRJ-1003, SRJ-207 (hatch A3): a reuse spawn still running
  // while a destructive modify tears B down meets ErrInvalidFlags and sets
  // the hold; its set reaction's Cannot launch alert, raised in the window,
  // is written (one log line, one persona-teardown-notice entry naming B),
  // reaches neither the old half's nor the new half's destination and is
  // never dropped; the teardown then forgets the hold. Once the new half is
  // up, a hold it meets itself posts its alert to its own destination.
  test('a hold B\'s launch in flight sets during a destructive modify\'s teardown: its Cannot launch alert is written by the window (one log line, one persona-teardown-notice entry), posted to neither half\'s destination, and the hold is forgotten; the new half held anew posts to its own destination', async () => {
    const release = Promise.withResolvers<void>()
    const r = makeHeld({
      notifier: true,
      // B's held reuse spawn: once released, it answers ErrInvalidFlags and holds B.
      launchInFlight: (hold) =>
        release.promise.then(async () => {
          hold.set(r.f.b.key, PHASE1_RC_VERSION)
          await flush()
        }),
    })
    const h = r.h!
    const b = r.f.b
    // A destructive modify: B's key stays applied, its new half sending notices to another channel.
    const newHalf = applyNewHalfOf(h, r.f.applied, b)
    const full = stillAppliedTeardownTrail(b, `${JSON.stringify([b.claude_config_dir, undefined])}:[${r.f.a.key},${b.key}]`)
      .filter((c) => !c.startsWith('notifier.'))

    const done = r.f.lifecycle.teardown(b)
    await flush()
    expect(r.f.trail).toEqual(untilLaunchSettled(full, b))

    release.resolve()
    await done
    await flush()

    expect(r.f.trail).toEqual(full)
    expect(r.f.lines).toEqual(cleanTeardownLines(b))
    expect(r.hold.isHeld(b.key)).toBe(false)
    expect(r.episodes.isOpen(b.key, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD)).toBe(false)
    // The set's alert reached the notifier, which wrote it; nothing was posted by any persona's client.
    expect(r.posts).toEqual([alertFor(b.key)])
    expect(h.startupEntries()).toEqual([teardownNoticeEntry(b, INVALID_FLAGS_HOLD_ALERT_TEXT)])
    expect(h.logs).toEqual([teardownNoticeLine(b, INVALID_FLAGS_HOLD_ALERT_TEXT)])
    expect(h.totalPosts()).toBe(0)

    // The new half, up, meets ErrInvalidFlags itself: a new episode, its alert at its own destination.
    expect(r.hold.set(b.key, PHASE1_RC_VERSION)).toBe(true)
    await flush()
    expect(h.posts(b.key)).toEqual([{ channel: newHalf.permission_prompts, text: formatPersonaNotice(newHalf, INVALID_FLAGS_HOLD_ALERT_TEXT) }])
    expect(h.startupEntries()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Persona teardown with the real agent-director kill, outage state, notifier,
// destination hold and kill-failure alerts (b.jg5 SRJ-715, SRJ-110, SRJ-702,
// SRJ-704): no wind-down, no delete (the row is kept, HO C16), no flag, no
// latch, no retry timer and no Slack post left.
// ---------------------------------------------------------------------------

describe('persona teardown (b.jg5 SRJ-715, SR-6.5) over the real bounded-retry kill, outage state, notifier, destination hold and kill-failure alerts: no delete, the row kept', () => {
  interface RealFixture {
    f: Fixture
    h: NotifierHarness
    calls: ReturnType<typeof makeStubCallLog>
    /** Agent-director verbs in call order, with the instance they name (`kill`, `status`, `delete`). */
    adOrder: string[]
    /** Every outage notify call (onsets and all-clears), by key. */
    emissions: Array<{ key: string; text: string }>
    /** The kill retry's clock: its waits between tries, driven by `tearDown`. */
    killClock: FakeClock
    /** Every wait between tries the kill retry asked for, in ms, in order. */
    killWaits: number[]
    /** Every call of the kill-failure alerts' log-only route, in order. */
    logOnly: Array<{ classLabel: string; entry: string }>
    /** The kill-failure alerts' and the unclassified-error episodes' own lines. */
    alertLines: string[]
    /** The real unclassified-error episodes over the same episodes (threshold 0), as `main()` binds them. */
    unclassified: UnclassifiedErrorEpisodes
    /** The episodes' clock. */
    episodesClock: FakeClock
    /** Every retry arm and every unclassified report the outage state sent, and every tmux-unresponsive start, by key. */
    arms: string[]
    reports: string[]
    conditionStarts: string[]
    /** The startup-errors.log entries written under the test's temp directory, each as its class and text. */
    startupEntries(): StartupEntry[]
  }

  /**
   * B already left the applied set (apply step 1): the notifier harness's
   * persona list no longer has it (`removeB`). As `main()` binds them (b.jg5
   * SRJ-1003): the lifecycle's notifier is the real notifier (its teardown
   * window included), whose startup-errors recorder and the kill-failure
   * alerts' log-only route both write `startup-errors.log` in the test's temp
   * directory; outage notices go to the notifier with their phase and
   * classes; the notice episodes' sink is the notifier's `notify` and their
   * teardown query its `teardownWindowState`; the teardown's kill is
   * `killPersonaInstanceForTeardown` (here on `killClock`, a fake clock), and
   * its alert raiser the real kill-failure alerts over those episodes with
   * the context 'persona teardown', and its outage reader the real
   * `getOutageFlags` (b.jg5 SRJ-110: a standing outcome whose onset was not
   * written gets the not-succeeded notice). `kill*` and `status*` script the stub;
   * the outage state's trigger, unclassified and condition sinks record;
   * `overrides` replace further lifecycle dependencies.
   */
  function makeReal(opts: {
    killError?: Error
    killResult?: Phase1KillResult
    killQueue?: CannedResponse<Phase1KillResult>[]
    statusResult?: Phase1StatusResult
    statusQueue?: CannedResponse<Phase1StatusResult>[]
    post?: Record<string, readonly WebApiOutcome[]>
    triggerSink?: UnavailableRetryController
    overrides?: (f: () => Fixture) => Partial<PersonaLifecycleDeps>
  } = {}): RealFixture {
    const config = makeConfig()
    const logDir = join(dir, 'state')
    const h = makeNotifierHarness(config, {
      post: opts.post,
      recordStartupError: (classLabel, message) => recordStartupError(classLabel, message, undefined, { logDir }),
    })
    cleanups.push(() => {
      h.hold.cancelAll()
      h.cleanup()
    })
    const calls = makeStubCallLog()
    const adOrder: string[] = []
    const stub = makeStubClient({
      ...calls,
      killError: opts.killError,
      killResult: opts.killResult,
      killQueue: opts.killQueue,
      statusResult: opts.statusResult,
      statusQueue: opts.statusQueue,
    })
    const kill = stub.kill.bind(stub)
    const status = stub.status.bind(stub)
    const del = stub.delete.bind(stub)
    stub.kill = (p) => { adOrder.push(`kill:${p.claude_instance_id}`); return kill(p) }
    stub.status = (p) => { adOrder.push(`status:${p.claude_instance_id}`); return status(p) }
    stub.delete = (p) => { adOrder.push(`delete:${p.claude_instance_id.join(',')}`); return del(p) }
    setClientForTests(stub as unknown as Parameters<typeof setClientForTests>[0])
    const emissions: Array<{ key: string; text: string }> = []
    const arms: string[] = []
    const reports: string[] = []
    const conditionStarts: string[] = []
    initOutageState({
      getClient,
      notify: (key, text, options) => {
        emissions.push({ key, text })
        void h.notifier.notify(key, text, options)
      },
      triggerSink: opts.triggerSink ?? ({ arm: (key: string) => { arms.push(key); return true } } as unknown as UnavailableRetryController),
      unclassifiedSink: { report: (key) => void reports.push(key) },
      conditionSink: { start: (key) => void conditionStarts.push(key), end: () => undefined },
    })
    const killClock = createFakeClock()
    const killWaits: number[] = []
    const logOnly: RealFixture['logOnly'] = []
    const alertLines: string[] = []
    const episodesClock = createFakeClock()
    const episodes = createPersonaEpisodes({
      sink: (key, text, options) => h.notifier.notify(key, text, options),
      log: (line) => void alertLines.push(line),
      clock: episodesClock,
      teardownWindow: (key) => h.notifier.teardownWindowState(key),
    })
    const unclassified = createUnclassifiedErrorEpisodes({
      episodes,
      log: (line) => void alertLines.push(line),
      alertThresholdMs: () => 0,
      isConfigured: (key) => f.applied.some((p) => p.key === key),
      logOnly: (key, text) => recordStartupError(PERSONA_UNCLASSIFIED_ERROR_LABEL, `persona=${key}: ${text}`, undefined, { logDir }),
    })
    const alerts = createKillFailureAlerts({
      episodes,
      log: (line) => void alertLines.push(line),
      isConfigured: (key) => f.applied.some((p) => p.key === key),
      logOnly: (classLabel, entry) => {
        logOnly.push({ classLabel, entry })
        recordStartupError(classLabel, entry, undefined, { logDir })
      },
    })
    cleanups.push(() => {
      expect(killClock.pendingCount()).toBe(0)
      expect(episodesClock.pendingCount()).toBe(0)
    })
    const f: Fixture = makeFixture({
      overrides: {
        killInstance: (key) => killPersonaInstanceForTeardown(key, { clock: killClock }),
        raiseKillFailureAlert: (key, decision) =>
          alerts.raise({ key, decision, latched: false, context: KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN }),
        resetOutageState: resetAllToHealthy,
        outageFlags: getOutageFlags,
        notifier: h.notifier,
        destinations: h.destinations,
        destinationHold: h.hold,
        ...opts.overrides?.(() => f),
      },
    })
    const startupEntries = (): StartupEntry[] => readStartupEntries(logDir)
    return { f, h, calls, adOrder, emissions, killClock, killWaits, logOnly, alertLines, unclassified, episodesClock, arms, reports, conditionStarts, startupEntries }
  }

  /**
   * Step 1 of a destructive modify: B's key stays applied, its new half's
   * declaration sending notices to another channel than the old half's, its
   * client validated (the new half is up once step 6 ran). Returns the new
   * half.
   */
  function newHalfOfB(r: RealFixture): Persona {
    return applyNewHalfOf(r.h, r.f.applied, r.f.b)
  }

  /** Step 1 of the apply: B leaves the applied set the notifier reads. */
  function removeB(r: RealFixture): void {
    const i = r.h.personas.findIndex((p) => p.key === r.f.b.key)
    r.h.personas.splice(i, 1)
  }

  /**
   * Tear `p` down and drive the kill's tries on `r.killClock` to the
   * teardown's end: each wait between tries is recorded in `r.killWaits` and
   * fired as it is set; no wait is left pending.
   */
  async function tearDown(r: RealFixture, p: Persona): Promise<void> {
    const done = r.f.lifecycle.teardown(p)
    let finished = false
    void done.then(() => {
      finished = true
    })
    for (let steps = 0; !finished; steps++) {
      if (steps > 1_000) throw new Error('the teardown did not settle')
      await r.killClock.flush()
      if (finished || r.killClock.pendingCount() === 0) continue
      r.killWaits.push(...r.killClock.pending().map((timer) => timer.delayMs))
      await r.killClock.runNext()
    }
    await done
    expect(r.killClock.pendingCount()).toBe(0)
  }

  /** The kills the teardown's bounded retry makes for `err` answered at every try: `KILL_RETRY_TRIES` for UNAVAILABLE, else one (b.jg5 SRJ-702). */
  function triesFor(err: Error): number {
    const outcome = killOutcomeOf({ thrown: err })
    return outcome.kind === KILL_OUTCOME_NOT_KILLED && outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE ? KILL_RETRY_TRIES : 1
  }

  /** `tries` kills of `id`, with one `status` read of it before each further try. */
  function killsAndReads(id: string, tries: number): string[] {
    return Array.from({ length: tries }, (_, i) => (i === 0 ? [`kill:${id}`] : [`status:${id}`, `kill:${id}`])).flat()
  }

  /** The recorded steps after the kill for `p`, a removed key (the real resets and notifier drop record nothing). */
  function stepsAfterKill(f: Fixture, p: Persona): string[] {
    const k = p.key
    return [
      `stopRetryTimer:${k}`, `forgetFailures:${k}`, `forgetDisconnectedStreak:${k}`, `forgetNotConnectedEpisode:${k}`, `forgetConflictLatch:${k}`,
      `replyGuard.launchedWithDir:${k}`, `replyGuard.teardown:${k}`, `replyGuard.launchPass:${launchPassOf(f, undefined)}`,
    ]
  }

  /**
   * The server's latch installed for the case, with `configured` as the
   * configured-persona query (b.jg5 SRJ-114), both put back in `cleanups`.
   * Returns the latch, so a case can show the teardown's kill latched nothing.
   */
  function installLatch(configured: (key: string) => boolean): ConflictLatch {
    const latch = createConflictLatch({ log: () => {} })
    setConflictLatch(latch)
    setConfiguredPersonaQuery(configured)
    cleanups.push(() => {
      setConflictLatch(undefined)
      _resetConfiguredPersonaQuery()
    })
    return latch
  }

  /** The class of the persona-teardown route's ordinary entry, from the kill-failure alert's route selection (b.jg5 SRJ-704, SRJ-1013). */
  function teardownNoticeClass(): string {
    return selectKillFailureAlertRoute({
      version: KILL_FAILURE_VERSION_ORDINARY,
      context: KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN,
      configured: false,
      latched: false,
    }).classLabel!
  }

  /** Nothing was armed, reported or started for the teardown's kill, no Slack call was made by any persona's client, and no delete was made. */
  function expectNothingArmedOrDeleted(r: RealFixture): void {
    expect(r.calls.deleteCalls).toEqual([])
    expect(r.adOrder.filter((call) => call.startsWith('delete:'))).toEqual([])
    expect(r.arms).toEqual([])
    expect(r.reports).toEqual([])
    expect(r.conditionStarts).toEqual([])
    expect(r.h.totalPosts()).toBe(0)
    for (const p of r.h.personas) expect(r.h.stub(p.key).callLog).toEqual([])
  }

  test('AC 57: B\'s row is killed, cscb_B only, and no other agent-director verb is called (no graceful wind-down, no delete: the row is kept); A\'s outage flag is untouched', async () => {
    const r = makeReal()
    setOutageFlag(r.f.a.key, 'ad-unreachable', '/bin/ad')
    removeB(r)
    const before = r.emissions.length

    await tearDown(r, r.f.b)

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual([`kill:${id}`])
    expect(stubCallCount(r.calls)).toBe(1)
    expect(r.killWaits).toEqual([])
    expect([...getOutageFlags(r.f.a.key)]).toEqual(['ad-unreachable'])
    expect(r.emissions.slice(before)).toEqual([])
    expect(r.f.lines).toEqual(cleanTeardownLines(r.f.b, { kind: KILL_OUTCOME_KILLED }))
    expect(r.h.totalPosts()).toBe(1) // A's onset, posted before the teardown
    expect(r.h.posts(r.f.b.key)).toEqual([])
    expect(r.logOnly).toEqual([])
  })

  test('B held an ad-unreachable flag and the kill succeeds: no all-clear is raised or posted, and B holds no flag afterwards', async () => {
    const r = makeReal()
    setOutageFlag(r.f.b.key, 'ad-unreachable', '/bin/ad')
    await flush()
    const postsBefore = r.h.posts(r.f.b.key).length
    removeB(r)
    const before = r.emissions.length

    await tearDown(r, r.f.b)
    await flush()

    expect(r.emissions.slice(before)).toEqual([])
    expect([...getOutageFlags(r.f.b.key)]).toEqual([])
    expect(r.h.posts(r.f.b.key)).toHaveLength(postsBefore)
  })

  // b.jg5 SRJ-1003, SRJ-1002 (AC 65): the onset the kill's call raises for
  // a removed key, inside the window, is written, not dropped by the rule for
  // a key no longer applied; its flag outlives the teardown.
  test('b.jg5 SRJ-715, SRJ-1003: agent-director unreachable, B removed: the kill fails (one try: not UNAVAILABLE) and is logged, no delete is made, the other steps run; the onset raised for B is written to the log and a persona-teardown-notice entry, never posted, held or dropped, and its flag is kept', async () => {
    const unreachable = new ErrSystemInstallDisappeared('kill', `/opt/ad/${fakeToken(BOT_TOKEN_PREFIX, 'bin')}`)
    const r = makeReal({ killError: unreachable })
    removeB(r)

    await tearDown(r, r.f.b)
    await flush()

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual(killsAndReads(id, triesFor(unreachable)))
    expect(r.f.trail.slice(-8)).toEqual(stepsAfterKill(r.f, r.f.b))
    expect(r.f.lines.slice(1)).toEqual([
      killFailedLine(r.f.b, killOutcomeOf({ thrown: unreachable }), triesFor(unreachable)),
      `${teardownPrefix(r.f.b)}: complete, with 1 failed step(s)`,
    ])
    expect(r.f.lines[1]).toContain(`class=${AD_ERROR_CLASS_UNCLASSIFIED}`)
    // The wrapper raises ad-unreachable for B (b.jg5 SRJ-110); the window writes its onset, and the flag stays.
    expect(r.emissions.map((e) => e.key)).toEqual([r.f.b.key])
    const [onsetNotice] = r.emissions
    expect(r.startupEntries()).toEqual([teardownNoticeEntry(r.f.b, onsetNotice!.text)])
    expect(r.h.logs).toEqual([teardownNoticeLine(r.f.b, onsetNotice!.text)])
    expect([...getOutageFlags(r.f.b.key)]).toEqual(['ad-unreachable'])
    expect(r.h.hold.view(r.f.b.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expectNothingArmedOrDeleted(r)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs, killLines: consoleLines() })
    // The onset quotes the binary path as the outage state was given it (the same text it posts outside a
    // teardown); with that path masked, the entry carries nothing token-like.
    assertNoLeak({ entries: r.startupEntries().map((entry) => entry.text.replaceAll(unreachable.binaryPath, '<binary path>')) })
  })

  // b.jg5 SRJ-715, SRJ-701, SRJ-703, SRJ-104: a success (`kill_sent` true,
  // false or absent), `ErrSpawnNotFound` and GONE end the kill step at the
  // first try with its outcome line; no delete follows, nothing is raised.
  test.each<[string, { killResult?: Phase1KillResult; killError?: Error }, KillOutcome]>([
    ['kill_sent true', { killResult: cannedKillResult(true) }, { kind: KILL_OUTCOME_KILLED, killSent: true }],
    ['kill_sent false', { killResult: cannedKillResult(false) }, { kind: KILL_OUTCOME_KILLED, killSent: false }],
    ['ErrSpawnNotFound (the row already gone)', { killError: errSpawnNotFound() }, { kind: KILL_OUTCOME_ROW_GONE }],
    // b.jg5 SRJ-104, SRJ-110: for `kill`, gone is success.
    ['GONE (ErrTmuxCaptureFailed), the session-gone success', { killError: errTmuxCaptureFailed(undefined, 'kill') }, { kind: KILL_OUTCOME_SESSION_GONE, name: errTmuxCaptureFailed().errName }],
    ['GONE (ErrTmuxSendKeys), the session-gone success', { killError: errTmuxSendKeys() }, { kind: KILL_OUTCOME_SESSION_GONE, name: errTmuxSendKeys().errName }],
  ])('b.jg5 SRJ-715, SRJ-701, SRJ-104: the kill succeeds with %s: one try, the kill step passes with its outcome line, no delete is made, nothing is raised or posted', async (_label, kill, outcome) => {
    const r = makeReal(kill)
    removeB(r)

    await tearDown(r, r.f.b)
    await flush()

    expect(r.adOrder).toEqual([`kill:${personaInstanceId(r.f.b.key)}`])
    expect(r.f.lines).toEqual(cleanTeardownLines(r.f.b, outcome))
    expect(r.emissions).toEqual([])
    expect(r.logOnly).toEqual([])
    expectNothingArmedOrDeleted(r)
  })

  // b.jg5 SRJ-715 (HO C16 Verify, AC 77), SRJ-110, SRJ-702, SRJ-1002: each
  // of HO C2's non-success classes at every try of the teardown's kill, over
  // the real kill on the fake clock: UNAVAILABLE gets KILL_RETRY_TRIES tries
  // KILL_RETRY_SPACING_MS apart with one `status` read of the row before
  // each further try, every other class one try (a CONFLICT is never tried
  // again). The kill step fails with its line; no delete is made, so the row
  // is kept; nothing latches, even with the server's latch installed and B
  // configured; no retry timer is armed, nothing is reported and no
  // tmux-unresponsive condition starts, even with the teardown run inside a
  // recovery attempt for B (an attempt-context kill would arm); the later
  // steps still run. The standing outcome is recorded by exactly one
  // persona-teardown-notice entry, and nothing reaches Slack: ErrTmuxKillFailed
  // by its alert (the ordinary version, on the persona-teardown route,
  // below), a CONFLICT or an UNUSABLE NAME by its refusal notice (b.jg5
  // SRJ-1003, below), an ENVIRONMENT answer by its outage's onset (B counts
  // as configured here, through the installed query, so it raises
  // tmux-unavailable, and the outage reader sees it raised), and every other
  // non-success (an UNAVAILABLE value other than ErrTmuxKillFailed after its
  // tries, an UNCLASSIFIED value) by the not-succeeded notice (b.jg5
  // SRJ-110), which no other notice duplicates.
  /** What records the standing outcome: the entry's text, from the case's fixture, the thrown value and the tries made. */
  type RecordedBy = (r: RealFixture, err: Error, tries: number) => string
  const BY_ALERT: RecordedBy = (r, err) => teardownAlertText(ordinaryAlertContent(r.f.b.key, { last: err }), false)
  const BY_REFUSAL: RecordedBy = (r, err) =>
    teardownKillRefusalNoticeText(personaInstanceId(r.f.b.key), {
      at: KILL_REFUSAL_AT_KILL,
      errorClass: classifyAdError(err).errorClass as PersonaTeardownKillRefusal['errorClass'],
      error: err,
    })
  const BY_ONSET: RecordedBy = (r) => r.emissions[0]!.text
  const BY_NOT_SUCCEEDED: RecordedBy = (r, err, tries) =>
    teardownKillNotSucceededNoticeText(personaInstanceId(r.f.b.key), killOutcomeOf({ thrown: err }) as KillFailure, tries)
  test.each<[string, () => Error, RecordedBy]>([
    ['ErrTmuxKillFailed', () => errTmuxKillFailed(), BY_ALERT],
    ['ErrTmuxUnresponsive', () => errTmuxUnresponsive('kill'), BY_NOT_SUCCEEDED],
    ['ErrTmuxSessionConflict (not this launch\'s session)', () => errTmuxSessionConflict('kill', 'not-this-launch'), BY_REFUSAL],
    ['ErrTmuxNotAvailable', () => errTmuxNotAvailable(undefined, 'kill'), BY_ONSET],
    ['ErrInternal', () => errInternal(), BY_NOT_SUCCEEDED],
    ['ErrUnknownErrorName', () => errUnknownErrorName(), BY_NOT_SUCCEEDED],
    ['ErrCallTimeout', () => errCallTimeout('kill'), BY_NOT_SUCCEEDED],
    ['an UNUSABLE NAME ErrInternal', () => errUnusableName(), BY_REFUSAL],
    ['an unreachable error (a plain Error)', () => new Error(`agent-director went away (${sentinelInMessage('teardown-kill')})`), BY_NOT_SUCCEEDED],
    ['another error (ErrKillBroken)', () => errGeneric('kill', 'ErrKillBroken'), BY_NOT_SUCCEEDED],
  ])('b.jg5 SRJ-715, SRJ-110: the kill answers %s at every try: its tries are made on the fake clock, the kill step fails with its line, no delete is made (the row is kept), nothing latches, arms, starts or posts, and every other step still runs; the standing outcome is recorded by exactly one persona-teardown-notice entry', async (_label, make, recordedBy) => {
    const err = make()
    const latch = installLatch(() => true)
    const r = makeReal({ killError: err })
    removeB(r)

    await runInAttempt(r.f.b.key, 'recovery', () => tearDown(r, r.f.b))
    await flush()

    const id = personaInstanceId(r.f.b.key)
    const tries = triesFor(err)
    expect(r.adOrder).toEqual(killsAndReads(id, tries))
    expect(stubCallCount(r.calls)).toBe(2 * tries - 1)
    expect(r.killWaits).toEqual(Array.from({ length: tries - 1 }, () => KILL_RETRY_SPACING_MS))
    expect(r.f.trail.slice(-8)).toEqual(stepsAfterKill(r.f, r.f.b))
    expect(r.f.lines.slice(1)).toEqual([
      killFailedLine(r.f.b, killOutcomeOf({ thrown: err }), tries),
      `${teardownPrefix(r.f.b)}: complete, with 1 failed step(s)`,
    ])
    expect(latch.isLatched(r.f.b.key)).toBe(false)
    expect(r.logOnly).toEqual([])
    const text = recordedBy(r, err, tries)
    expect(r.startupEntries()).toEqual([teardownNoticeEntry(r.f.b, text)])
    expect(r.h.logs).toEqual([teardownNoticeLine(r.f.b, text)])
    expectNothingArmedOrDeleted(r)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs, alertLines: r.alertLines, entries: r.startupEntries(), killLines: consoleLines() })
  })

  // b.jg5 SRJ-513 bullet 2, SRJ-715, SRJ-1002: a destructive
  // modify's old half whose row reads `pending` with no launch start still
  // gets the ordinary checked kill (SRJ-316's no-kill-of-a-pending-row rule
  // does not hold it back), and the reads between its tries latch nothing.
  test('b.jg5 SRJ-513, SRJ-715: B still applied, its row read pending with no launch start: the kill is made, an UNAVAILABLE first try is tried again after a read of that row, the second try\'s success ends the step; nothing latches, nothing is armed and no delete is made', async () => {
    const latch = installLatch(() => true)
    const r = makeReal({
      killQueue: [cannedErr(errTmuxUnresponsive('kill')), cannedOk(cannedKillResult(true))],
      statusResult: cannedStatusResult({ state: 'pending', launch_started_at: SAMPLE_LAUNCH_START_NONE }),
    })
    r.f.applied.push(r.f.b) // B keeps its key applied until step 6 brings its new declaration up

    await tearDown(r, r.f.b)
    await flush()

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual(killsAndReads(id, 2))
    expect(r.killWaits).toEqual([KILL_RETRY_SPACING_MS])
    expect(r.f.lines).toEqual(cleanTeardownLines(r.f.b, { kind: KILL_OUTCOME_KILLED, killSent: true }, 2))
    expect(latch.isLatched(r.f.b.key)).toBe(false)
    expect(latch.record(r.f.b.key)).toBeUndefined()
    expect(r.logOnly).toEqual([])
    expectNothingArmedOrDeleted(r)
  })

  /** The kill-failure alert's text as the teardown window writes it: the persona-teardown route's closing, no Slack escaping (b.jg5 SRJ-704, SRJ-1007). */
  function teardownAlertText(content: KillFailureAlertContent, configured: boolean): string {
    const route = selectKillFailureAlertRoute({ version: content.version, context: KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN, configured, latched: false })
    return killFailureAlertText(content, route.closing, false)
  }

  // b.jg5 SRJ-704, SRJ-702, SRJ-1007, SRJ-1013, SRJ-1003: the kill's alert,
  // raised in the teardown's window, for a removed B and for the old half of
  // a destructive modify (B still applied, its new half sending notices to
  // another channel, which would otherwise take B's destination route): the
  // window writes the server-log line and one persona-teardown-notice entry
  // naming the persona and "raised during its teardown" (the notifier's
  // builder), its text the persona-teardown route's alert text; the alerts'
  // own log-only route is not used, and nothing reaches Slack.
  test.each<[string, boolean]>([['removed', false], ['still applied (a destructive modify\'s old half)', true]])(
    'b.jg5 SRJ-704, SRJ-1003: ErrTmuxKillFailed at every try, B %s: one ordinary alert, one log line and one persona-teardown-notice entry naming B and "raised during its teardown", its text the ordinary version quoting the last description; nothing posted to Slack',
    async (_label, stillApplied) => {
      const err = errTmuxKillFailed()
      const r = makeReal({ killError: err })
      if (stillApplied) newHalfOfB(r)
      else removeB(r)
      const b = r.f.b.key

      await tearDown(r, r.f.b)
      await flush()

      expect(teardownNoticeClass()).toBe(PERSONA_TEARDOWN_NOTICE_LABEL)
      expect(PERSONA_TEARDOWN_NOTICE_LABEL).not.toBe(PERSONA_KILL_FAILED_LABEL)
      const text = teardownAlertText(ordinaryAlertContent(b, { last: err }), stillApplied)
      const entry = teardownNoticeEntry(r.f.b, text)
      expect(entry.text).toContain(PERSONA_TEARDOWN_NOTICE_RAISED)
      expect(r.logOnly).toEqual([])
      expect(r.startupEntries()).toEqual([entry])
      expect(r.h.logs).toEqual([teardownNoticeLine(r.f.b, text)])
      expect(r.alertLines.filter((line) => line.includes(`persona=${b} `))).toHaveLength(1)
      expect(r.adOrder).toEqual(killsAndReads(personaInstanceId(b), KILL_RETRY_TRIES))
      expect(r.f.lines.slice(1)).toEqual([
        killFailedLine(r.f.b, killOutcomeOf({ thrown: err }), KILL_RETRY_TRIES),
        `${teardownPrefix(r.f.b)}: complete, with 1 failed step(s)`,
      ])
      expectNothingArmedOrDeleted(r)
      assertNoLeak({ lines: r.f.lines, alertLines: r.alertLines, entries: r.startupEntries() })
    },
  )

  test.each<[string, boolean]>([['removed', false], ['still applied (a destructive modify\'s old half)', true]])(
    'b.jg5 SRJ-704, SRJ-1013, SRJ-1003 (AC 65): a survivor-naming ErrTmuxKillFailed, then a success, B %s: one survivor alert, one log line and one persona-kill-survivor entry naming B, and no persona-teardown-notice entry; nothing posted to Slack; the kill step passes',
    async (_label, stillApplied) => {
      const survivor = errTmuxKillFailed(undefined, 'pane-process-survived')
      const r = makeReal({ killQueue: [cannedErr(survivor), cannedOk(cannedKillResult(true))] })
      if (stillApplied) newHalfOfB(r)
      else removeB(r)
      const b = r.f.b.key

      await tearDown(r, r.f.b)
      await flush()

      const text = teardownAlertText(survivorAlertContent(b, survivor), stillApplied)
      expect(r.logOnly).toEqual([])
      expect(r.startupEntries()).toEqual([teardownNoticeEntry(r.f.b, text, PERSONA_TEARDOWN_NOTICE_RAISED, PERSONA_KILL_SURVIVOR_LABEL)])
      expect(r.startupEntries().filter((entry) => entry.classLabel === PERSONA_TEARDOWN_NOTICE_LABEL)).toEqual([])
      expect(r.h.logs).toEqual([teardownNoticeLine(r.f.b, text, PERSONA_TEARDOWN_NOTICE_RAISED, PERSONA_KILL_SURVIVOR_LABEL)])
      expect(r.adOrder).toEqual(killsAndReads(personaInstanceId(b), 2))
      expect(r.killWaits).toEqual([KILL_RETRY_SPACING_MS])
      expect(r.f.lines).toEqual(cleanTeardownLines(r.f.b, { kind: KILL_OUTCOME_KILLED, killSent: true }, 2))
      expectNothingArmedOrDeleted(r)
      assertNoLeak({ lines: r.f.lines, alertLines: r.alertLines, entries: r.startupEntries() })
    },
  )

  // b.jg5 SRJ-1003, SRJ-1002 (AC 65; hatch A3): the onset the old half's
  // kill raises in the window is written, never held for the new half (the
  // old case held it and dropped it after the kill); its flag is kept, and
  // its all-clear, coming after the teardown completed and the new half is
  // up, is written the same way, never posted to the new half's destination.
  // The new half's own notices then reach its destination as usual.
  test('b.jg5 SRJ-715, SRJ-1003: the old half of a destructive modify (its connection stopped, its new half sending notices elsewhere) with agent-director unreachable: the onset its failing kill raises is written, never held or dropped; once the new half is up nothing is flushed to it, the outage\'s later all-clear is written too, and the new half\'s own notice posts to its destination', async () => {
    const unreachable = new ErrSystemInstallDisappeared('kill', '/opt/ad/bin')
    const r = makeReal({ killError: unreachable })
    const b = r.f.b
    const newHalf = newHalfOfB(r) // B keeps its key applied until step 6 brings its new declaration up
    r.h.validated.delete(b.key) // its connection is stopped: no validated client, so a notice outside the window would be held

    await tearDown(r, b)
    await flush()
    expect(r.emissions.map((e) => e.key)).toEqual([b.key]) // the onset was raised for B
    expect(r.adOrder).toEqual(killsAndReads(personaInstanceId(b.key), triesFor(unreachable)))
    const [onsetNotice] = r.emissions
    expect(r.startupEntries()).toEqual([teardownNoticeEntry(b, onsetNotice!.text)])
    expect([...getOutageFlags(b.key)]).toEqual(['ad-unreachable'])

    // Step 6: B's new half comes up and its held notices are flushed: none was held.
    r.h.validate(b.key)
    await r.h.notifier.flush(b.key)
    expect(r.h.posts(b.key)).toEqual([])
    expect(r.h.hold.view(b.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })

    // The outage clears after the teardown: its all-clear is written as its onset was.
    clearOutageFlag(b.key, 'ad-unreachable')
    await flush()
    const allClearNotice = r.emissions[1]!
    expect(r.startupEntries()).toEqual([
      teardownNoticeEntry(b, onsetNotice!.text),
      teardownNoticeEntry(b, allClearNotice.text, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER),
    ])
    expect(r.h.logs).toEqual([teardownNoticeLine(b, onsetNotice!.text), teardownNoticeLine(b, allClearNotice.text, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER)])
    expect(r.f.lines.at(-1)).toBe(`${teardownPrefix(b)}: complete, with 1 failed step(s)`)
    expectNothingArmedOrDeleted(r)

    // The new half's own notice reaches its destination.
    await r.h.notifier.notify(b.key, 'the new half is up')
    expect(r.h.posts(b.key)).toEqual([{ channel: newHalf.permission_prompts, text: formatPersonaNotice(newHalf, 'the new half is up') }])
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs, entries: r.startupEntries() })
  })

  /**
   * The real UNAVAILABLE retry controller on a fake clock, as the trigger
   * sink; closed after the case with no timer left and its lines leak-checked.
   */
  function makeRetryController(): { controller: UnavailableRetryController; clock: FakeClock; lines: string[] } {
    const clock = createFakeClock()
    const lines: string[] = []
    const controller = createUnavailableRetryController({
      log: (line) => void lines.push(line),
      action: () => {
        throw new Error('no retry falls due in this case')
      },
      clock,
    })
    cleanups.push(() => {
      controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
      expect(clock.pendingCount()).toBe(0)
      assertNoLeak({ lines })
    })
    return { controller, clock, lines }
  }

  // Rows: the answer, its class, the outage it raises, and whether B is configured (the configured-persona query).
  const OUTAGE_ANSWERS: Array<[string, () => Error, string, OutageClass, boolean]> = [
    ['ENVIRONMENT (ErrTmuxNotAvailable)', () => errTmuxNotAvailable(undefined, 'kill'), AD_ERROR_CLASS_ENVIRONMENT, 'tmux-unavailable', true],
    ['ENVIRONMENT (ErrTmuxNotAvailable)', () => errTmuxNotAvailable(undefined, 'kill'), AD_ERROR_CLASS_ENVIRONMENT, 'tmux-unavailable', false],
    ['CONFIG (ErrConfigMalformed)', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG, 'ad-config-malformed', true],
    ['CONFIG (ErrConfigMalformed)', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG, 'ad-config-malformed', false],
  ]

  // b.jg5 SRJ-110, SRJ-301, SRJ-1002, SRJ-1003 (hatch A3): the teardown's
  // kill is no launch or recovery attempt, so an ENVIRONMENT or CONFIG answer
  // there arms no retry timer and makes no delete; it raises its outage only
  // while B is in the applied configuration (the configured-persona query).
  // The onset, raised in the window, is written as a server-log line and a
  // persona-teardown-notice entry; the flag outlives the teardown, and the
  // outage's all-clear, when it clears after the teardown completed, is
  // written the same way: neither reaches the new half's destination. With
  // no onset written (B not configured), the outage reader sees no flag, so
  // the standing outcome is the not-succeeded notice instead (b.jg5 SRJ-110).
  test.each(OUTAGE_ANSWERS)('b.jg5 SRJ-110, SRJ-1002, SRJ-1003 (hatch A3): the old half of a destructive modify whose kill answers %s (class %s, outage %s; B configured: %p): no retry timer is armed for B and no delete is made; the onset and its later all-clear (a configured B), or the not-succeeded notice (B not configured), are each a log line and a persona-teardown-notice entry, never posted to the new half\'s destination; A\'s timer stays armed', async (_label, make, errorClass, outage, configured) => {
    const { controller, clock, lines: retryLines } = makeRetryController()
    const err = make()
    const r = makeReal({
      killError: err,
      triggerSink: controller,
      overrides: (f) => ({
        // As server.ts binds it, recording whether the key had a timer when this stop ran.
        stopRetryTimer: (key) => {
          f().trail.push(`stopRetryTimer:${key}:${controller.isArmed(key) ? 'armed' : 'none'}`)
          controller.stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
        },
      }),
    })
    const b = r.f.b
    const k = b.key
    const latch = installLatch((key) => configured && key === k)
    newHalfOfB(r) // B keeps its key applied until step 6 brings its new declaration up
    controller.arm(r.f.a.key, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })

    await tearDown(r, b)
    await flush()

    const id = personaInstanceId(k)
    expect(r.adOrder).toEqual([`kill:${id}`])
    // Every stop (at submit, in the first group, after its launch in flight settled, after the kill) finds no timer: the kill armed none.
    const stops = r.f.trail.filter((c) => c.startsWith('stopRetryTimer:'))
    expect(stops).toEqual([`stopRetryTimer:${k}:none`, `stopRetryTimer:${k}:none`, `stopRetryTimer:${k}:none`, `stopRetryTimer:${k}:none`])
    expect(retryLines.filter((l) => l.startsWith(`[slack] unavailable-retry: persona=${k} armed`))).toEqual([])
    expect(controller.isArmed(k)).toBe(false)
    expect(controller.armedKeys()).toEqual([r.f.a.key])
    expect(clock.pendingCount()).toBe(1) // A's timer only
    expect(latch.isLatched(k)).toBe(false)
    expect(r.f.lines.slice(1)).toEqual([
      killFailedLine(b, killOutcomeOf({ thrown: err }), 1),
      `${teardownPrefix(b)}: complete, with 1 failed step(s)`,
    ])
    expect(r.f.lines[1]).toContain(`class=${errorClass}`)
    // The outage's onset for B only while B is configured, written by the window; the flag is kept.
    expect(r.emissions.map((e) => e.key)).toEqual(configured ? [k] : [])
    expect([...getOutageFlags(k)]).toEqual(configured ? [outage] : [])
    const onsetEntries = r.emissions.map((e) => teardownNoticeEntry(b, e.text))
    const notSucceeded = teardownKillNotSucceededNoticeText(id, killOutcomeOf({ thrown: err }) as KillFailure, 1)
    expect(r.startupEntries()).toEqual(configured ? onsetEntries : [teardownNoticeEntry(b, notSucceeded)])

    // The outage clears after the teardown, the new half up: its all-clear is written, not posted.
    clearOutageFlag(k, outage)
    await flush()
    expect(r.emissions.map((e) => e.key)).toEqual(configured ? [k, k] : [])
    expect(r.startupEntries()).toEqual(
      configured
        ? [...onsetEntries, teardownNoticeEntry(b, r.emissions[1]!.text, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER)]
        : [teardownNoticeEntry(b, notSucceeded)],
    )
    expect(r.h.logs).toEqual(
      configured ? [teardownNoticeLine(b, r.emissions[0]!.text), teardownNoticeLine(b, r.emissions[1]!.text, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER)] : [teardownNoticeLine(b, notSucceeded)],
    )
    expect(r.calls.deleteCalls).toEqual([])
    expect(r.h.totalPosts()).toBe(0)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs, entries: r.startupEntries() })
  })

  // b.jg5 SRJ-1002, SRJ-1003 (AC 65; hatch A3): an ENVIRONMENT or CONFIG
  // answer met by the launch in flight the teardown waits for (its spawn,
  // through the outage wrapper) raises its outage in the window: the onset is
  // written, the timer the launch armed is stopped once it settled, and the
  // outage's all-clear after the teardown is written too. The kill meets the
  // same answer, so the flag stands past the teardown (raised once).
  test.each(OUTAGE_ANSWERS.filter(([, , , , configured]) => configured))('b.jg5 SRJ-1002, SRJ-1003 (hatch A3): a destructive modify whose launch in flight meets %s (class %s, outage %s) while the teardown waits for it: the onset is a log line and a persona-teardown-notice entry, the timer that launch armed is stopped, and the all-clear after the teardown is written the same way; nothing reaches the new half\'s destination', async (_label, make, _errorClass, outage) => {
    const { controller } = makeRetryController()
    const r = makeReal({
      killError: make(),
      triggerSink: controller,
      overrides: (f) => ({
        whenLaunchSettled: async (key) => {
          f().trail.push(`whenLaunchSettled:${key}`)
          await withOutageDetection(key, f().b.working_directory, 'spawn', async () => {
            throw make()
          }).catch(() => undefined)
          f().trail.push(`launchSettled:${key}:${controller.isArmed(key) ? 'armed' : 'none'}`)
        },
        stopRetryTimer: (key) => {
          f().trail.push(`stopRetryTimer:${key}:${controller.isArmed(key) ? 'armed' : 'none'}`)
          controller.stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
        },
      }),
    })
    const b = r.f.b
    const k = b.key
    installLatch((key) => key === k)
    newHalfOfB(r)

    await tearDown(r, b)
    await flush()

    // The launch's answer armed B's timer as it settled; the stop right after cleared it.
    const settledAt = r.f.trail.indexOf(`launchSettled:${k}:armed`)
    expect(settledAt).toBeGreaterThan(-1)
    expect(r.f.trail.slice(settledAt + 1, settledAt + 3)).toEqual([`stopLiveRowSequence:${k}`, `stopRetryTimer:${k}:armed`])
    expect(controller.isArmed(k)).toBe(false)
    // One onset, raised by the launch in the window and written; the kill's same answer raised none.
    expect(r.emissions.map((e) => e.key)).toEqual([k])
    expect(r.startupEntries()).toEqual([teardownNoticeEntry(b, r.emissions[0]!.text)])
    expect([...getOutageFlags(k)]).toEqual([outage])

    clearOutageFlag(k, outage)
    await flush()
    expect(r.startupEntries()).toEqual([
      teardownNoticeEntry(b, r.emissions[0]!.text),
      teardownNoticeEntry(b, r.emissions[1]!.text, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER),
    ])
    expect(r.h.logs).toEqual([teardownNoticeLine(b, r.emissions[0]!.text), teardownNoticeLine(b, r.emissions[1]!.text, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER)])
    expect(r.h.totalPosts()).toBe(0)
    expect(r.calls.deleteCalls).toEqual([])
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs, entries: r.startupEntries() })
  })

  // b.jg5 SRJ-1003, SRJ-1002, SRJ-715 (AC 65): a CONFLICT or an UNUSABLE
  // NAME answer the teardown's kill meets, at a try or at the `status` read
  // between its tries, latches nothing (the server's latch installed, B
  // configured) and is one notice, written by the window: one server-log line
  // and one persona-teardown-notice entry naming B and "raised during its
  // teardown", its text the exported builder's one-line kill outcome (no hold
  // sentence); no Slack call by any persona's client, so neither the old
  // half's nor the new half's destination hears of it. For a removal and for
  // a destructive modify's old half (its new half sending notices elsewhere).
  test.each<[string, PersonaTeardownKillRefusal['at'], PersonaTeardownKillRefusal['errorClass'], () => Error, boolean]>([
    ['a CONFLICT at its try, B removed', KILL_REFUSAL_AT_KILL, AD_ERROR_CLASS_CONFLICT, () => errTmuxSessionConflict('kill', 'not-this-launch'), false],
    ['a CONFLICT at its try, a destructive modify\'s old half', KILL_REFUSAL_AT_KILL, AD_ERROR_CLASS_CONFLICT, () => errTmuxSessionConflict('kill', 'not-this-launch'), true],
    ['an UNUSABLE NAME at its try, B removed', KILL_REFUSAL_AT_KILL, AD_ERROR_CLASS_UNUSABLE_NAME, () => errUnusableName(), false],
    ['an UNUSABLE NAME at its try, a destructive modify\'s old half', KILL_REFUSAL_AT_KILL, AD_ERROR_CLASS_UNUSABLE_NAME, () => errUnusableName(), true],
    ['a CONFLICT at the status read between its tries, B removed', KILL_REFUSAL_AT_READ, AD_ERROR_CLASS_CONFLICT, () => errTmuxSessionConflict('status', 'not-this-launch'), false],
    ['a CONFLICT at the status read between its tries, a destructive modify\'s old half', KILL_REFUSAL_AT_READ, AD_ERROR_CLASS_CONFLICT, () => errTmuxSessionConflict('status', 'not-this-launch'), true],
    ['an UNUSABLE NAME at the status read between its tries, B removed', KILL_REFUSAL_AT_READ, AD_ERROR_CLASS_UNUSABLE_NAME, () => errUnusableName(), false],
    ['an UNUSABLE NAME at the status read between its tries, a destructive modify\'s old half', KILL_REFUSAL_AT_READ, AD_ERROR_CLASS_UNUSABLE_NAME, () => errUnusableName(), true],
  ])('AC 65: %s: one log line and one persona-teardown-notice entry with the kill outcome\'s one-line rendering, nothing latched, nothing posted to either half\'s destination', async (_label, at, errorClass, make, destructive) => {
    const refused = make()
    expect(classifyAdError(refused).errorClass).toBe(errorClass)
    const latch = installLatch(() => true)
    // At a read: the first try answers UNAVAILABLE, the read between the tries the refusal, the second try succeeds.
    const r = at === KILL_REFUSAL_AT_KILL
      ? makeReal({ killError: refused })
      : makeReal({ killQueue: [cannedErr(errTmuxUnresponsive('kill')), cannedOk(cannedKillResult(true))], statusQueue: [cannedErr(refused)] })
    const b = r.f.b
    if (destructive) newHalfOfB(r)
    else removeB(r)

    await tearDown(r, b)
    await flush()

    const id = personaInstanceId(b.key)
    expect(r.adOrder).toEqual(at === KILL_REFUSAL_AT_KILL ? [`kill:${id}`] : killsAndReads(id, 2))
    const text = teardownKillRefusalNoticeText(id, { at, errorClass, error: refused })
    expect(text).not.toContain('Held')
    const entry = teardownNoticeEntry(b, text)
    expect(r.startupEntries()).toEqual([entry])
    expect(entry.text).toContain(`${PERSONA_TEARDOWN_NOTICE_RAISED}: `)
    expect(r.h.logs).toEqual([teardownNoticeLine(b, text)])
    expect(latch.isLatched(b.key)).toBe(false)
    expect(latch.record(b.key)).toBeUndefined()
    expect(r.logOnly).toEqual([])
    expectNothingArmedOrDeleted(r)
    expect(r.f.lines.at(-1)).toBe(
      at === KILL_REFUSAL_AT_KILL ? `${teardownPrefix(b)}: complete, with 1 failed step(s)` : `${teardownPrefix(b)}: complete`,
    )
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs, entries: r.startupEntries(), killLines: consoleLines() })
  })

  // b.jg5 SRJ-715, SRJ-1003: in dry run the teardown makes no kill, so its
  // kill-refusal path never runs: a kill that would answer CONFLICT is never
  // made, and no refusal notice is written, posted or latched.
  test('dry run: no kill is made, so the CONFLICT the kill would meet raises no refusal notice: no agent-director call, no entry, no notifier line, nothing posted or latched; the dry-run line names the kept row', async () => {
    const latch = installLatch(() => true)
    const r = makeReal({ killError: errTmuxSessionConflict('kill', 'not-this-launch'), overrides: () => ({ dryRun: true }) })
    const b = r.f.b
    removeB(r)

    await tearDown(r, b)
    await flush()

    expect(r.adOrder).toEqual([])
    expect(stubCallCount(r.calls)).toBe(0)
    expect(r.startupEntries()).toEqual([])
    expect(r.h.logs).toEqual([])
    expect(r.logOnly).toEqual([])
    expect(r.alertLines).toEqual([])
    expect(latch.isLatched(b.key)).toBe(false)
    expect(r.f.lines).toEqual([
      `${teardownPrefix(b)}: starting`,
      `[slack] dry-run: persona teardown of ${renderPersonaRef(b.name, b.key)}: skipping the agent-director kill of ${personaInstanceId(b.key)}; the row is kept`,
      `${teardownPrefix(b)}: complete`,
    ])
    expectNothingArmedOrDeleted(r)
  })

  // b.jg5 SRJ-702, SRJ-1003 (hatch A3): a CONFIG answer at the status read
  // between the kill's tries raises ad-config-malformed for a configured B,
  // written by the window, never posted; the tries go on, and the next read's
  // success clears it, its all-clear raised in the window and written too.
  // The ErrTmuxUnresponsive that stands after the tries calls for no alert
  // and raises no outage, so it is the not-succeeded notice, written last
  // (b.jg5 SRJ-110).
  test('b.jg5 SRJ-702, SRJ-1003, SRJ-110: a CONFIG answer at the status read between the kill\'s tries, B a destructive modify\'s old half: ad-config-malformed\'s onset, the all-clear the next read raises and the not-succeeded notice of the UNAVAILABLE outcome standing after the tries are each a log line and a persona-teardown-notice entry, posted to neither half\'s destination; nothing latches or arms', async () => {
    const latch = installLatch((key) => key === r.f.b.key)
    const unavailable = errTmuxUnresponsive('kill')
    const r = makeReal({
      killQueue: Array.from({ length: KILL_RETRY_TRIES }, () => cannedErr(unavailable)),
      statusQueue: [cannedErr(errConfigMalformed())],
    })
    const b = r.f.b
    newHalfOfB(r)

    await tearDown(r, b)
    await flush()

    expect(r.adOrder).toEqual(killsAndReads(personaInstanceId(b.key), KILL_RETRY_TRIES))
    expect(r.emissions.map((e) => e.key)).toEqual([b.key, b.key])
    const [onsetNotice, allClearNotice] = r.emissions
    const notSucceeded = teardownKillNotSucceededNoticeText(personaInstanceId(b.key), killOutcomeOf({ thrown: unavailable }) as KillFailure, KILL_RETRY_TRIES)
    expect(r.startupEntries()).toEqual([
      teardownNoticeEntry(b, onsetNotice!.text),
      teardownNoticeEntry(b, allClearNotice!.text),
      teardownNoticeEntry(b, notSucceeded),
    ])
    expect(r.h.logs).toEqual([teardownNoticeLine(b, onsetNotice!.text), teardownNoticeLine(b, allClearNotice!.text), teardownNoticeLine(b, notSucceeded)])
    expect([...getOutageFlags(b.key)]).toEqual([])
    expect(latch.isLatched(b.key)).toBe(false)
    expectNothingArmedOrDeleted(r)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs, entries: r.startupEntries(), killLines: consoleLines() })
  })

  // b.jg5 SRJ-110, SRJ-1003: a removed B (apply step 1 took it out of the
  // applied configuration, so the configured-persona query answers false):
  // an ENVIRONMENT or CONFIG answer at its kill raises no outage, so no onset
  // records it; the standing outcome is the not-succeeded notice, one log
  // line and one persona-teardown-notice entry, never posted, and no flag.
  test.each(OUTAGE_ANSWERS.filter(([, , , , configured]) => !configured))('b.jg5 SRJ-110, SRJ-1003: B removed, its kill answers %s (class %s, outage %s): no onset and no flag; the standing outcome is one not-succeeded notice, a log line and a persona-teardown-notice entry naming the kill count; nothing posted, armed or deleted', async (_label, make, errorClass) => {
    const err = make()
    installLatch(() => false)
    const r = makeReal({ killError: err })
    const b = r.f.b
    removeB(r)

    await tearDown(r, b)
    await flush()

    const id = personaInstanceId(b.key)
    expect(r.adOrder).toEqual([`kill:${id}`])
    expect(r.emissions).toEqual([])
    expect([...getOutageFlags(b.key)]).toEqual([])
    const outcome = killOutcomeOf({ thrown: err }) as KillFailure
    expect<string>(outcome.errorClass).toBe(errorClass)
    const text = teardownKillNotSucceededNoticeText(id, outcome, 1)
    expect(r.startupEntries()).toEqual([teardownNoticeEntry(b, text)])
    expect(r.h.logs).toEqual([teardownNoticeLine(b, text)])
    expect(r.f.lines.slice(1)).toEqual([killFailedLine(b, outcome, 1), `${teardownPrefix(b)}: complete, with 1 failed step(s)`])
    expectNothingArmedOrDeleted(r)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs, entries: r.startupEntries() })
  })

  // b.jg5 SRJ-1003, SRJ-110: a CONFLICT met at the status read between the
  // tries is no answer of a try, so its refusal notice does not record the
  // outcome that stands after them: an UNAVAILABLE value other than
  // ErrTmuxKillFailed (no alert, no outage) also gets the not-succeeded
  // notice. Two entries, the refusal's first.
  test('b.jg5 SRJ-1003, SRJ-110: a CONFLICT at the status read between the tries, then ErrTmuxUnresponsive standing after the last try, B removed: two persona-teardown-notice entries, the read-time refusal notice and then the not-succeeded notice; nothing latched or posted', async () => {
    const latch = installLatch(() => true)
    const unavailable = errTmuxUnresponsive('kill')
    const refused = errTmuxSessionConflict('status', 'not-this-launch')
    const r = makeReal({
      killQueue: Array.from({ length: KILL_RETRY_TRIES }, () => cannedErr(unavailable)),
      statusQueue: [cannedErr(refused)],
    })
    const b = r.f.b
    removeB(r)

    await tearDown(r, b)
    await flush()

    const id = personaInstanceId(b.key)
    expect(r.adOrder).toEqual(killsAndReads(id, KILL_RETRY_TRIES))
    const refusal = teardownKillRefusalNoticeText(id, { at: KILL_REFUSAL_AT_READ, errorClass: AD_ERROR_CLASS_CONFLICT, error: refused })
    const notSucceeded = teardownKillNotSucceededNoticeText(id, killOutcomeOf({ thrown: unavailable }) as KillFailure, KILL_RETRY_TRIES)
    expect(r.startupEntries()).toEqual([teardownNoticeEntry(b, refusal), teardownNoticeEntry(b, notSucceeded)])
    expect(r.h.logs).toEqual([teardownNoticeLine(b, refusal), teardownNoticeLine(b, notSucceeded)])
    expect(latch.isLatched(b.key)).toBe(false)
    expect(r.logOnly).toEqual([])
    expectNothingArmedOrDeleted(r)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs, entries: r.startupEntries(), killLines: consoleLines() })
  })

  // b.jg5 SRJ-313, SRJ-1003 (hatch A3): an UNCLASSIFIED outcome met past
  // the alert threshold by the launch in flight the teardown waits for raises
  // the unclassified-error alert in the window: one persona-teardown-notice
  // entry with the unescaped alert text, never the persona-unclassified-error
  // entry a key no longer applied would get outside the window, and no post.
  test('b.jg5 SRJ-313, SRJ-1003: B removed, its launch in flight meets UNCLASSIFIED outcomes past the alert threshold while the teardown waits for it: the alert is a log line and a persona-teardown-notice entry, no persona-unclassified-error entry, nothing posted', async () => {
    const unclassifiedErr = errInstanceIdCollision()
    const r = makeReal({
      overrides: (f) => ({
        whenLaunchSettled: async (key) => {
          f().trail.push(`whenLaunchSettled:${key}`)
          r.unclassified.report(key, unclassifiedErr)
          await r.episodesClock.advance(1)
          r.unclassified.report(key, unclassifiedErr)
        },
      }),
    })
    const b = r.f.b
    removeB(r)

    await tearDown(r, b)
    await flush()

    const text = unclassifiedErrorAlertText(classifyAdError(unclassifiedErr), { escapeForSlack: false })
    expect(r.startupEntries()).toEqual([teardownNoticeEntry(b, text)])
    expect(r.startupEntries().filter((entry) => entry.classLabel === PERSONA_UNCLASSIFIED_ERROR_LABEL)).toEqual([])
    expect(r.h.logs).toEqual([teardownNoticeLine(b, text)])
    expect(r.h.totalPosts()).toBe(0)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs, alertLines: r.alertLines, entries: r.startupEntries() })
  })

  // b.jg5 SRJ-110 (hatch A3): the teardown's kill is no launch or recovery
  // attempt, so a class the kill has no row for (UNCLASSIFIED) arms nothing
  // and feeds no unclassified-error episode, even when the teardown runs
  // inside a recovery attempt for B (an attempt-context kill would arm); the
  // kill step fails and no delete is made.
  test.each<[string, () => Error]>([
    ['a STATE name (ErrInstanceIdCollision)', () => errInstanceIdCollision()],
    ['a STATE name (ErrSpawnNotResumable)', () => errSpawnNotResumable()],
    ['a LAUNCH FAILURE name (ErrTmuxSessionCreate)', () => errTmuxSessionCreate('kill')],
  ])('b.jg5 SRJ-110: the kill answers %s (a class it has no row for, UNCLASSIFIED), the teardown run inside a recovery attempt for B: nothing armed or reported; the kill step fails with its line, no delete is made, nothing latches', async (_label, make) => {
    const err = make()
    const latch = installLatch(() => true)
    const r = makeReal({ killError: err })
    removeB(r)

    await runInAttempt(r.f.b.key, 'recovery', () => tearDown(r, r.f.b))
    await flush()

    expect(r.adOrder).toEqual([`kill:${personaInstanceId(r.f.b.key)}`])
    expect(r.f.lines.slice(1)).toEqual([
      killFailedLine(r.f.b, killOutcomeOf({ thrown: err }), 1),
      `${teardownPrefix(r.f.b)}: complete, with 1 failed step(s)`,
    ])
    expect(r.f.lines[1]).toContain(`class=${AD_ERROR_CLASS_UNCLASSIFIED}`)
    expect(latch.isLatched(r.f.b.key)).toBe(false)
    expectNothingArmedOrDeleted(r)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs })
  })

  // b.jg5 SRJ-104, SRJ-204, SRJ-205: an ErrInvalidFlags at the teardown's
  // kill gets exactly one immediate version re-check; either way the kill
  // step fails after its one try and no delete is made, and nothing is armed
  // or reported.
  describe('an ErrInvalidFlags at the teardown\'s kill', () => {
    let resolveCalls: Array<object | undefined>
    let stops: number[]

    beforeEach(() => {
      resolveCalls = []
      stops = []
    })

    afterEach(() => {
      resetAdVersionRecheckForTests()
    })

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

    test.each([
      ['passes (then UNCLASSIFIED)', { version: PHASE1_RC_VERSION }, RECHECK_OUTCOME_PASS, 0],
      ['decides that the server stops', { version: OLD_AD_VERSION }, RECHECK_OUTCOME_STOP, 1],
    ] as const)('the re-check %s → exactly one re-check; the kill step fails with its line naming the re-check, no delete is made; nothing armed or reported', async (_label, outcome, recheck, stopCount) => {
      installRecheck(outcome)
      const err = errInvalidFlags('kill')
      const r = makeReal({ killError: err })
      removeB(r)

      await tearDown(r, r.f.b)
      await flush()

      expect(resolveCalls).toHaveLength(1)
      expect(stops).toHaveLength(stopCount)
      expect(r.adOrder).toEqual([`kill:${personaInstanceId(r.f.b.key)}`])
      const outcomeWithRecheck = { ...killOutcomeOf({ thrown: err }), recheck } as KillOutcome
      expect(describeKillOutcome(outcomeWithRecheck)).toContain(`recheck=${recheck}`)
      expect(r.f.lines.slice(1)).toEqual([
        killFailedLine(r.f.b, outcomeWithRecheck, 1),
        `${teardownPrefix(r.f.b)}: complete, with 1 failed step(s)`,
      ])
      expectNothingArmedOrDeleted(r)
      assertNoLeak({ lines: r.f.lines, logs: r.h.logs })
    })
  })

  test('a notice held for B by the destination hold is cancelled: its retry timer is gone and it is never posted, even once its retry would have come due', async () => {
    const r = makeReal()
    const b = r.f.b
    r.h.stub(b.key).script.post.push(...Array<WebApiOutcome>(1000).fill({ kind: 'platform', error: 'not_in_channel' }))
    await r.h.notifier.notify(b.key, 'a notice for B')
    expect(r.h.hold.view(b.key)).toMatchObject({ held: true, heldNotices: 1 })
    expect(r.h.clock.pendingCount()).toBe(1)
    const attempts = r.h.stub(b.key).calls.postMessage.length
    r.h.stub(b.key).script.post.length = 0
    removeB(r)

    await tearDown(r, b)
    await r.h.clock.advance(3_600_000)

    expect(r.h.hold.view(b.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(r.h.clock.pendingCount()).toBe(0)
    expect(r.h.stub(b.key).calls.postMessage).toHaveLength(attempts)
    expect(r.h.posts(r.f.a.key)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Apply bring-up (SR-6.1, SR-6.2)
// ---------------------------------------------------------------------------

describe('apply bring-up (SR-6.1, SR-6.2): storage check, bring-up, then a launch only when up', () => {
  /** An applied config holding A and the added persona B. */
  function appliedOf(f: Fixture): PersonaConfig {
    return { ...f.config, personas: [f.a, f.b] }
  }

  test('an added persona that comes up: its storage check, its bring-up against the applied set, then its launch; the result is the bring-up\'s', async () => {
    const result: PersonaBringUpResultSummary = { outcome: 'up', failures: [] }
    const f = makeFixture({ bringUpResult: result })

    const got = await f.lifecycle.bringUp(f.b, appliedOf(f))

    expect(got).toBe(result)
    expect(f.trail).toEqual([`storageCheck:${f.b.key}`, `bringUps.bringUp:${f.b.key}:[${f.a.key},${f.b.key}]`, `launch:${f.b.key}`])
    expect(f.lines).toEqual([`[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: up at apply — launching`])
    expect(f.submitted).toEqual([f.b.key])
  })

  test.each<['retrying' | 'broken']>([['retrying'], ['broken']])('an added persona whose outcome is %s is not launched and returns at once with its outcome, no line of the lifecycle\'s own', async (outcome) => {
    const result: PersonaBringUpResultSummary = { outcome, failures: [{ step: 'slack', class: 'network', cause: 'unreachable' }] }
    const f = makeFixture({ bringUpResult: result })

    expect(await f.lifecycle.bringUp(f.b, appliedOf(f))).toBe(result)
    expect(f.trail).toEqual([`storageCheck:${f.b.key}`, `bringUps.bringUp:${f.b.key}:[${f.a.key},${f.b.key}]`])
    expect(f.lines).toEqual([])
  })

  test('the bring-up resolves only once the up persona\'s launch settled', async () => {
    const gate = Promise.withResolvers<unknown>()
    const f = makeFixture({ overrides: { launch: () => gate.promise } })

    const done = f.lifecycle.bringUp(f.b, appliedOf(f))
    expect(await settled(done)).toBe(false)
    gate.resolve(undefined)
    expect(await done).toEqual({ outcome: 'up', failures: [] })
  })

  test('a failing launch is logged token-safely and the bring-up still resolves with its outcome', async () => {
    const f = makeFixture({ fail: ['launch'] })

    expect(await f.lifecycle.bringUp(f.b, appliedOf(f))).toEqual({ outcome: 'up', failures: [] })
    const ref = renderPersonaRef(f.b.name, f.b.key)
    expect(f.lines).toEqual([
      `[slack] persona ${ref}: up at apply — launching`,
      expect.stringMatching(new RegExp(`^${RegExp.escape(`[slack] persona ${ref}: launch at apply failed: Error`)}( |$)`)),
    ])
    assertNoLeak({ lines: f.lines })
  })

  test('a throwing storage check is logged token-safely and the bring-up and launch still run', async () => {
    const f = makeFixture({ fail: ['storageCheck'] })

    expect(await f.lifecycle.bringUp(f.b, appliedOf(f))).toEqual({ outcome: 'up', failures: [] })
    expect(f.trail).toEqual([`storageCheck:${f.b.key}`, `bringUps.bringUp:${f.b.key}:[${f.a.key},${f.b.key}]`, `launch:${f.b.key}`])
    const ref = renderPersonaRef(f.b.name, f.b.key)
    expect(f.lines[0]).toMatch(new RegExp(`^${RegExp.escape(`[slack] persona ${ref}: storage check at apply failed: Error`)}( |$)`))
    expect(f.lines.slice(1)).toEqual([`[slack] persona ${ref}: up at apply — launching`])
    assertNoLeak({ lines: f.lines })
  })

  test('a failing bring-up rejects the apply bring-up (the controller\'s fan-out reports it) and launches nothing', async () => {
    const f = makeFixture({ fail: ['bringUps.bringUp'] })

    // The injected failure itself, not any error (a broken fixture would throw a TypeError).
    await expect(f.lifecycle.bringUp(f.b, appliedOf(f))).rejects.toThrow(/^step exploded with /)
    expect(f.trail).toEqual([`storageCheck:${f.b.key}`, `bringUps.bringUp:${f.b.key}:[${f.a.key},${f.b.key}]`])
  })

  test('shutting down when the operation starts (the flag set while it waited for B\'s turn): no storage check, no bring-up, no launch; one line; it resolves broken with no failures', async () => {
    let shuttingDown = false
    const f = makeFixture({ overrides: { isShuttingDown: () => shuttingDown } })
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const done = f.lifecycle.bringUp(f.b, appliedOf(f))
    shuttingDown = true
    blocker.resolve()
    await held

    expect(await done).toEqual({ outcome: 'broken', failures: [] })
    expect(f.trail).toEqual([])
    expect(f.lines).toEqual([`[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: not brought up — the server is shutting down`])
    expect(f.submitted).toEqual([f.b.key])
  })

  test('shutdown beginning during the bring-up (the flag set before it resolves up): the bring-up ran, no launch; one line; it resolves with the bring-up\'s up result', async () => {
    let shuttingDown = false
    const result: PersonaBringUpResultSummary = { outcome: 'up', failures: [] }
    const gate = Promise.withResolvers<PersonaBringUpResultSummary>()
    const bringUpCalls: string[] = []
    const f = makeFixture({
      overrides: {
        isShuttingDown: () => shuttingDown,
        bringUps: {
          cancel: () => undefined,
          bringUp: (p) => { bringUpCalls.push(p.key); return gate.promise },
          state: () => undefined,
          changeCredentials: async () => ({ kind: 'skipped' }),
        },
      },
    })

    const done = f.lifecycle.bringUp(f.b, appliedOf(f))
    await flush()
    expect(bringUpCalls).toEqual([f.b.key])
    shuttingDown = true
    gate.resolve(result)

    expect(await done).toBe(result)
    expect(f.trail).toEqual([`storageCheck:${f.b.key}`])
    expect(f.lines).toEqual([`[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: not brought up — the server is shutting down`])
  })

  test('serialized per key: B\'s bring-up waits behind an operation running for B; A\'s bring-up does not', async () => {
    const f = makeFixture()
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const forB = f.lifecycle.bringUp(f.b, appliedOf(f))
    await f.lifecycle.bringUp(f.a, appliedOf(f))
    expect(await settled(forB)).toBe(false)
    expect(f.trail).toEqual([`storageCheck:${f.a.key}`, `bringUps.bringUp:${f.a.key}:[${f.a.key},${f.b.key}]`, `launch:${f.a.key}`])

    blocker.resolve()
    await held
    await forB
    expect(f.trail.filter((c) => c.startsWith('launch:'))).toEqual([`launch:${f.a.key}`, `launch:${f.b.key}`])
  })
})

// ---------------------------------------------------------------------------
// Recovery bring-up (SR-6.4, SR-8.6 step 6): a persona broken by its
// credentials whose credentials file changed. Decided when it runs.
// ---------------------------------------------------------------------------

/** An applied config holding A and B. */
function appliedAB(f: Fixture): PersonaConfig {
  return { ...f.config, personas: [f.a, f.b] }
}

/** One cause of `step` and `cls` (the cause text is not read by the lifecycle). */
const causeOf = (step: PersonaBringUpStep, cls: string) => ({ step, class: cls, cause: 'x' })

/** Bring-up states B can be in when its recovery runs. */
const STATES = {
  brokenMissing: { outcome: 'broken', causes: { credentials: causeOf('credentials', PERSONA_CREDENTIALS_MISSING) } },
  brokenInvalid: { outcome: 'broken', causes: { credentials: causeOf('credentials', PERSONA_CREDENTIALS_INVALID) } },
  brokenRefused: { outcome: 'broken', causes: { slack: causeOf('slack', PERSONA_CREDENTIALS_REFUSED) } },
  brokenOther: { outcome: 'broken', causes: { slack: causeOf('slack', 'error') } },
  retryingSlack: { outcome: 'retrying', causes: { slack: causeOf('slack', PERSONA_SLACK_UNREACHABLE) } },
  retryingDirectory: { outcome: 'retrying', causes: { directory: causeOf('working-directory', PERSONA_DIRECTORY_MISSING) } },
  /** Held for an unresolvable claude_config_dir (bug b.g57): no Slack connection, its launch waits. */
  heldConfigDir: { outcome: 'retrying', causes: { configDir: causeOf('claude-config-dir', PERSONA_CONFIG_DIR_UNRESOLVABLE) } },
  firstAttempt: { outcome: undefined, causes: {} },
  up: { outcome: 'up', causes: {} },
} satisfies Record<string, PersonaBringUpState>

describe('recovery bring-up (SR-6.4, SR-8.6 step 6): a credentials-broken persona is cleared, then brought up afresh', () => {
  const recovery = { recovery: true } as const

  /** B's recovery-specific steps, then the apply bring-up's, for an `up` result. */
  const recoveredTrail = (f: Fixture) => {
    const k = f.b.key
    return [
      `bringUps.state:${k}`, `bringUps.cancel:${k}`, `connections.stop:${k}`, `destinations.forget:${k}`,
      `storageCheck:${k}`, `bringUps.bringUp:${k}:[${f.a.key},${k}]`, `launch:${k}`,
    ]
  }

  test.each<[string, PersonaBringUpState]>([
    ['its credentials file missing', STATES.brokenMissing],
    ['its credentials file locally invalid', STATES.brokenInvalid],
    ['Slack refusing its token', STATES.brokenRefused],
  ])('B broken by %s: its bring-up state cancelled, its connection stopped and its cached DM forgotten, in that order, then storage check, bring-up and launch; B alone, through the serializer', async (_label, state) => {
    const result: PersonaBringUpResultSummary = { outcome: 'up', failures: [] }
    const f = makeFixture({ state: () => state, bringUpResult: result })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toBe(result)

    expect(f.trail).toEqual(recoveredTrail(f))
    const ref = renderPersonaRef(f.b.name, f.b.key)
    expect(f.lines).toEqual([
      `[slack] persona ${ref}: broken by its credentials and its credentials file changed — bringing it up again`,
      `[slack] persona ${ref}: up at apply — launching`,
    ])
    expect(f.submitted).toEqual([f.b.key])
  })

  /** The recovery's line for a persona no longer broken by its credentials (finding 4's fallback). */
  const notBrokenLine = (f: Fixture) =>
    `[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: not brought up again — it is not broken by its credentials now, so its changed credentials are applied as a credentials change`
  /**
   * The recovery's trail when it applies the change instead: the state read,
   * the change, B's cached DM forgotten when the change leaves it with no
   * connection (`none`), then the state read for its result.
   */
  const appliedAsChangeTrail = (f: Fixture, forgotDm = false) => [
    `bringUps.state:${f.b.key}`, `bringUps.changeCredentials:${f.b.key}:[${f.a.key},${f.b.key}]`,
    ...(forgotDm ? [`destinations.forget:${f.b.key}`] : []), `bringUps.state:${f.b.key}`,
  ]

  // Rows: B's state when the recovery runs, what the controller's change resolves, and the change's own line after the prefix.
  test.each<[string, PersonaBringUpState | undefined, PersonaCredentialsChangeResult, string | undefined]>([
    ['up', STATES.up, { kind: 'swapped' }, 'reconnected with its changed credentials; its instance and MCP session are kept'],
    ['retrying: Slack unreachable', STATES.retryingSlack, { kind: 'retrying', connection: 'none' }, 'it retries its bring-up with its changed credentials'],
    ['retrying: working directory missing', STATES.retryingDirectory, { kind: 'retrying', connection: 'none' }, 'it retries its bring-up with its changed credentials'],
    ['in its first Slack attempt (no outcome yet)', STATES.firstAttempt, { kind: 'retrying', connection: 'none' }, 'it retries its bring-up with its changed credentials'],
    ['held for its claude_config_dir (bug b.g57)', STATES.heldConfigDir, { kind: 'retrying', connection: 'none' }, 'it retries its bring-up with its changed credentials'],
    ['broken by another Slack error', STATES.brokenOther, { kind: 'skipped' }, undefined],
    ['unknown to the controller', undefined, { kind: 'skipped' }, undefined],
  ])('B %s when the recovery runs: not cleared or brought up; its changed credentials are applied as a credentials change in the same serializer turn, and it resolves with its outcome then and no failures', async (_label, state, changeResult, changeLine) => {
    const f = makeFixture({ state: () => state, changeResult })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toEqual({ outcome: state?.outcome ?? 'broken', failures: [] })

    // No cancel, stop, storage check, bring-up or launch; B's cached DM is
    // forgotten only when the change leaves it with no connection.
    const noConnection = changeResult.kind === 'retrying' && changeResult.connection === 'none'
    expect(f.trail).toEqual(appliedAsChangeTrail(f, noConnection))
    expect(f.changeCalls).toHaveLength(1)
    expect(f.changeCalls[0]!.connections).toBe(f.connections)
    const ref = renderPersonaRef(f.b.name, f.b.key)
    expect(f.lines).toEqual([notBrokenLine(f), ...(changeLine === undefined ? [] : [`[slack] persona ${ref}: ${changeLine}`])])
    // Called directly inside the recovery's turn, never submitted again (which would wait for itself).
    expect(f.submitted).toEqual([f.b.key])
  })

  test('the state is read when the recovery runs, not when it was submitted: B coming up while it waits for B\'s turn gets its change applied, not a fresh bring-up', async () => {
    let state: PersonaBringUpState = STATES.brokenRefused
    const f = makeFixture({ state: () => state })
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const done = f.lifecycle.bringUp(f.b, appliedAB(f), recovery)
    expect(await settled(done)).toBe(false)
    expect(f.trail).toEqual([])
    state = STATES.up
    blocker.resolve()
    await held

    expect(await done).toEqual({ outcome: 'up', failures: [] })
    expect(f.trail).toEqual(appliedAsChangeTrail(f))
  })

  test('the change finds B broken by its credentials again: the recovery goes ahead (cleared, then brought up and launched)', async () => {
    const f = makeFixture({ state: () => STATES.up, changeResult: { kind: 'credentials-broken' } })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toEqual({ outcome: 'up', failures: [] })

    const k = f.b.key
    expect(f.trail).toEqual([
      `bringUps.state:${k}`, `bringUps.changeCredentials:${k}:[${f.a.key},${k}]`,
      `bringUps.cancel:${k}`, `connections.stop:${k}`, `destinations.forget:${k}`,
      `storageCheck:${k}`, `bringUps.bringUp:${k}:[${f.a.key},${k}]`, `launch:${k}`,
    ])
    const ref = renderPersonaRef(f.b.name, k)
    expect(f.lines).toEqual([
      notBrokenLine(f),
      `[slack] persona ${ref}: broken by its credentials now, so it is brought up again rather than reconnected`,
      `[slack] persona ${ref}: broken by its credentials and its credentials file changed — bringing it up again`,
      `[slack] persona ${ref}: up at apply — launching`,
    ])
    expect(f.submitted).toEqual([k])
  })

  test('shutdown beginning while B\'s leftover state is cleared: nothing new is connected or launched (no storage check, bring-up or launch); the shutdown line; it resolves broken with no failures', async () => {
    let f!: Fixture
    // Shutdown begins while B's connection is being stopped.
    f = makeFixture({
      state: () => STATES.brokenRefused,
      overrides: { isShuttingDown: () => f.trail.includes(`connections.stop:${f.b.key}`) },
    })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toEqual({ outcome: 'broken', failures: [] })

    const k = f.b.key
    expect(f.trail).toEqual([`bringUps.state:${k}`, `bringUps.cancel:${k}`, `connections.stop:${k}`, `destinations.forget:${k}`])
    const ref = renderPersonaRef(f.b.name, k)
    expect(f.lines).toEqual([
      `[slack] persona ${ref}: broken by its credentials and its credentials file changed — bringing it up again`,
      `[slack] persona ${ref}: not brought up — the server is shutting down`,
    ])
  })

  test.each<[DepName, string]>([
    ['bringUps.cancel', 'cancelling its bring-up state'],
    ['connections.stop', 'stopping its Slack connection'],
    ['destinations.forget', 'forgetting its DM destination'],
  ])('%s failing: logged token-safely, the other clearing steps and the bring-up still run', async (dep, phrase) => {
    const f = makeFixture({ state: () => STATES.brokenMissing, fail: [dep] })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toEqual({ outcome: 'up', failures: [] })

    expect(f.trail).toEqual(recoveredTrail(f))
    const ref = renderPersonaRef(f.b.name, f.b.key)
    expect(f.lines).toHaveLength(3)
    expect(f.lines[1]).toMatch(new RegExp(`^${RegExp.escape(`[slack] persona ${ref}: ${phrase} before bringing it up again failed: Error`)}( |$)`))
    expect(f.lines[2]).toBe(`[slack] persona ${ref}: up at apply — launching`)
    assertNoLeak({ lines: f.lines })
  })

  test('shutting down when the recovery starts: no state read, nothing cleared or brought up; the shutdown line; it resolves broken with no failures', async () => {
    const f = makeFixture({ state: () => STATES.brokenMissing, overrides: { isShuttingDown: () => true } })

    expect(await f.lifecycle.bringUp(f.b, appliedAB(f), recovery)).toEqual({ outcome: 'broken', failures: [] })

    expect(f.trail).toEqual([])
    expect(f.lines).toEqual([`[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: not brought up — the server is shutting down`])
  })

  test('without the recovery option a credentials-broken persona is not cleared: no state read, no cancel, stop or forget', async () => {
    const f = makeFixture({ state: () => STATES.brokenMissing })

    await f.lifecycle.bringUp(f.b, appliedAB(f))

    expect(f.trail).toEqual([`storageCheck:${f.b.key}`, `bringUps.bringUp:${f.b.key}:[${f.a.key},${f.b.key}]`, `launch:${f.b.key}`])
  })

  // Rows: how B is broken by its credentials at start, and its credentials cause class.
  test.each<[string, boolean, string]>([
    ['its credentials file missing (then written)', true, PERSONA_CREDENTIALS_MISSING],
    ['Slack refusing its token at auth.test (then accepted)', false, PERSONA_CREDENTIALS_REFUSED],
  ])('over the real bring-up controller and connection manager: B broken by %s comes up at its recovery with its file\'s tokens and is launched; A is untouched', async (_label, missing, cls) => {
    const { h, controller, f, a, b } = makeControllerStack({
      stubOptions: missing ? {} : { [NAME_B]: { authTest: [{ kind: 'platform', error: 'invalid_auth' }] } },
    })
    if (missing) unlinkSync(b.credentials_file)
    for (const p of [a, b]) await controller.bringUp(p, h.personas)
    const brokenBy = missing ? { credentials: { class: cls } } : { slack: { class: cls } }
    expect(controller.state(b.key)).toMatchObject({ outcome: 'broken', causes: brokenBy })
    const aSockets = h.stub(a).sockets.length

    writeCredentialsFile(dir, relative(dir, b.credentials_file), { bot_token: h.tokens(b).botToken, app_token: h.tokens(b).appToken })
    const got = await f.lifecycle.bringUp(b, { ...h.config!, personas: [a, b] }, recovery)

    expect(got).toEqual({ outcome: 'up', failures: [] })
    expect(controller.state(b.key)?.outcome).toBe('up')
    expect(h.manager.status(b.key)).toMatchObject({ state: 'up' })
    expect(f.trail.filter((c) => c.startsWith('launch:'))).toEqual([`launch:${b.key}`])
    const ownCall = { key: b.key, gotTokens: true, ownTokens: true }
    expect(h.bringUpCalls.filter((c) => c.key === b.key)).toEqual(missing ? [ownCall] : [ownCall, ownCall])
    expect(h.stub(a).sockets).toHaveLength(aSockets)
    expect(h.manager.status(a.key)).toMatchObject({ state: 'up' })
    assertNoLeak({ lines: h.lines, lifecycle: f.lines })
  })
})

// ---------------------------------------------------------------------------
// Credentials change (SR-8.6 step 4, credentials row): the controller's
// changeCredentials over the lifecycle's connections, under the serializer.
// ---------------------------------------------------------------------------

describe('credentials change (SR-8.6 step 4): the controller\'s change over the connection manager, one line per outcome', () => {
  const lineOf = (f: Fixture, rest: string) => `[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: ${rest}`

  // Rows: the controller's result, and the lifecycle's line after the persona prefix (none for failed and skipped).
  test.each<[string, PersonaCredentialsChangeResult, string | undefined]>([
    ['swapped', { kind: 'swapped' }, 'reconnected with its changed credentials; its instance and MCP session are kept'],
    [
      'swapped, up again (its current connection was refused during the attempt)',
      { kind: 'swapped', cameBackUp: true },
      'reconnected with its changed credentials and up again; its instance is kept',
    ],
    [
      'retrying, the current connection kept',
      { kind: 'retrying', connection: 'kept' },
      'its changed credentials cannot reach Slack yet; the new connection retries and the current one stays in use',
    ],
    [
      'retrying, its current connection refused during the attempt',
      { kind: 'retrying', connection: 'broken' },
      'its changed credentials cannot reach Slack yet; the new connection retries, and it stays broken by its credentials until that connection is in use',
    ],
    [
      'retrying with no connection (Slack unreachable, directory-broken or held for its claude_config_dir)',
      { kind: 'retrying', connection: 'none' },
      'it retries its bring-up with its changed credentials',
    ],
    ['credentials-broken now', { kind: 'credentials-broken' }, 'broken by its credentials now, so it is brought up again rather than reconnected'],
    ['failed (the controller logged it)', { kind: 'failed', cause: 'credentials file does not exist' }, undefined],
    ['skipped', { kind: 'skipped' }, undefined],
  ])('%s: B\'s change against the applied set over the lifecycle\'s own connections, its result returned as is, and its line; nothing else done by the lifecycle', async (_label, result, rest) => {
    const f = makeFixture({ changeResult: result })

    expect(await f.lifecycle.reconnectCredentials(f.b, appliedAB(f))).toBe(result)

    // With a connection (or none taken), the DM cache is forgotten only through
    // the swap hook. With no connection, the lifecycle forgets it itself once
    // the change resolves, so a held notice never goes to the old app's DM.
    const noConnection = result.kind === 'retrying' && result.connection === 'none'
    expect(f.trail).toEqual([
      `bringUps.changeCredentials:${f.b.key}:[${f.a.key},${f.b.key}]`,
      ...(noConnection ? [`destinations.forget:${f.b.key}`] : []),
    ])
    expect(f.changeCalls).toHaveLength(1)
    expect(f.changeCalls[0]!.connections).toBe(f.connections)
    expect(f.lines).toEqual(rest === undefined ? [] : [lineOf(f, rest)])
    expect(f.submitted).toEqual([f.b.key])
  })

  test('its before-swap hook forgets B\'s cached DM conversation (only B\'s) when the controller calls it, and not before; the swapped hook forgets nothing', async () => {
    const f = makeFixture({ changeResult: { kind: 'retrying', connection: 'kept' } })

    await f.lifecycle.reconnectCredentials(f.b, appliedAB(f))
    const hooks = f.changeCalls[0]!.hooks!
    expect(f.trail.filter((c) => c.startsWith('destinations.'))).toEqual([])

    hooks.onSwapped!({ late: true, wasUp: true })
    expect(f.trail.filter((c) => c.startsWith('destinations.'))).toEqual([])

    hooks.beforeSwap!() // the new connection is about to come into use
    expect(f.trail.filter((c) => c.startsWith('destinations.'))).toEqual([`destinations.forget:${f.b.key}`])
  })

  // Rows: the swap the controller reports, and the line it logs after the persona prefix (none for the operation's own swap).
  test.each<[string, CredentialsSwap, string | undefined]>([
    ['at once, up before it', { late: false, wasUp: true }, undefined],
    ['at once, refused before it', { late: false, wasUp: false }, undefined],
    ['later, up before it', { late: true, wasUp: true }, 'reconnected with its changed credentials; its instance and MCP session are kept'],
    ['later, refused before it', { late: true, wasUp: false }, 'reconnected with its changed credentials and up again; its instance is kept'],
  ])('a swap %s: the swapped hook logs the reconnected line only for a late swap, worded by whether it was up before it', async (_label, swap, rest) => {
    const f = makeFixture({ changeResult: { kind: 'retrying', connection: 'kept' } })
    await f.lifecycle.reconnectCredentials(f.b, appliedAB(f))
    const before = f.lines.length

    f.changeCalls[0]!.hooks!.onSwapped!(swap)

    expect(f.lines.slice(before)).toEqual(rest === undefined ? [] : [lineOf(f, rest)])
  })

  test('forgetting the cached DM throws after a change that leaves B with no connection: one token-safe line, the retry line still logged, and the change still resolves', async () => {
    const f = makeFixture({ changeResult: { kind: 'retrying', connection: 'none' }, fail: ['destinations.forget'] })

    expect(await f.lifecycle.reconnectCredentials(f.b, appliedAB(f))).toEqual({ kind: 'retrying', connection: 'none' })

    expect(f.lines).toHaveLength(2)
    expect(f.lines[0]).toMatch(
      new RegExp(`^${RegExp.escape(lineOf(f, 'forgetting its cached DM conversation failed: Error'))}( |$)`),
    )
    expect(f.lines[1]).toBe(lineOf(f, 'it retries its bring-up with its changed credentials'))
    assertNoLeak({ lines: f.lines })
  })

  test('forgetting the cached DM throws in the before-swap hook: one token-safe line, and the hook does not throw', async () => {
    const f = makeFixture({ fail: ['destinations.forget'] })

    await f.lifecycle.reconnectCredentials(f.b, appliedAB(f))
    expect(() => f.changeCalls[0]!.hooks!.beforeSwap!()).not.toThrow()

    expect(f.trail.at(-1)).toBe(`destinations.forget:${f.b.key}`)
    expect(f.lines.at(-1)).toMatch(
      new RegExp(`^${RegExp.escape(lineOf(f, 'forgetting its cached DM conversation failed: Error'))}( |$)`),
    )
    assertNoLeak({ lines: f.lines })
  })

  test('shutting down when the change starts (the flag set while it waited for B\'s turn): no change asked for; one line; it resolves skipped', async () => {
    let shuttingDown = false
    const f = makeFixture({ overrides: { isShuttingDown: () => shuttingDown } })
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const done = f.lifecycle.reconnectCredentials(f.b, appliedAB(f))
    shuttingDown = true
    blocker.resolve()
    await held

    expect(await done).toEqual({ kind: 'skipped' })
    expect(f.trail).toEqual([])
    expect(f.lines).toEqual([lineOf(f, 'credentials change not applied — the server is shutting down')])
  })

  test('serialized per key: B\'s change waits behind an operation running for B; A\'s change does not', async () => {
    const f = makeFixture()
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const forB = f.lifecycle.reconnectCredentials(f.b, appliedAB(f))
    await f.lifecycle.reconnectCredentials(f.a, appliedAB(f))
    expect(await settled(forB)).toBe(false)
    expect(f.trail).toEqual([`bringUps.changeCredentials:${f.a.key}:[${f.a.key},${f.b.key}]`])

    blocker.resolve()
    await held
    expect(await forB).toEqual({ kind: 'swapped' })
    expect(f.trail).toEqual([
      `bringUps.changeCredentials:${f.a.key}:[${f.a.key},${f.b.key}]`,
      `bringUps.changeCredentials:${f.b.key}:[${f.a.key},${f.b.key}]`,
    ])
    expect(f.submitted).toEqual([f.b.key, f.a.key])
  })

  test('a rejecting change rejects the operation (the apply\'s fan-out reports it) with no line of the lifecycle\'s own', async () => {
    const f = makeFixture({ fail: ['bringUps.changeCredentials'] })

    await expect(f.lifecycle.reconnectCredentials(f.b, appliedAB(f))).rejects.toThrow(/^step exploded with /)
    expect(f.lines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Confirmed credentials changes over the real bring-up controller and
// connection manager (b.av2 SR-8.3, SR-8.6 step 4): the content held after
// superseded and late reconnects, the failed line's "kept" wording, and the
// results worded from B's state after the attempt. B is up on its original
// file (O); each rotation writes B's file with a new token pair registered
// as its own credential set, so each set's auth.test is scripted apart.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000
/** A reconnect left retrying tries again after 5 s (the SR-3.2 schedule's first step). */
const FIRST_RETRY_MS = 5_000

interface CredentialsStack extends ControllerStack {
  /** Every hook call of the changes made through `change`, in order. */
  hookCalls: Array<'beforeSwap' | CredentialsSwap>
  /**
   * Write B's credentials file with a new token pair, registered as the
   * credential set `label` whose auth.test answers `authTest` in turn (then
   * ok); returns the digest of the file as written.
   */
  rotate(label: string, authTest?: WebApiOutcome[]): string
  /** The digest the controller holds for B (what detection compares the file with). */
  held(): string | undefined
  /** The controller's change of B, against the applied set, over the manager, with recording hooks. */
  change(): Promise<PersonaCredentialsChangeResult>
  /** A Web API call on B's current client refused with token_revoked: the manager marks B broken at once. */
  revokeCurrent(): Promise<void>
  /** The credential set B's own connection uses now (`INITIAL_CREDENTIALS` for O). */
  connectedWith(): string | undefined
  /** The controller's persona-credentials-change-failed lines. */
  changeFailedLines(): string[]
}

/**
 * `makeControllerStack` with A and B brought up on their original files: up,
 * unless `stubOptions` script B's original set otherwise.
 */
async function makeCredentialsStack(stubOptions?: ConnectionHarnessOptions['stubOptions']): Promise<CredentialsStack> {
  const stack = makeControllerStack({ stubOptions })
  const { h, controller, b } = stack
  for (const p of [stack.a, b]) await controller.bringUp(p, h.personas)
  expect(controller.state(b.key)?.outcome).toBe(stubOptions === undefined ? 'up' : 'retrying')
  const labels = [INITIAL_CREDENTIALS]
  const hookCalls: CredentialsStack['hookCalls'] = []
  const connectedWith = () =>
    labels.find((l) => h.slack.credentials(b.key, l).identity.botUserId === h.manager.identity(b.key)?.botUserId)
  return {
    ...stack,
    hookCalls,
    rotate(label, authTest = []) {
      const botToken = fakeToken(BOT_TOKEN_PREFIX, `${b.key}-${label}-bot`)
      const appToken = fakeToken(APP_TOKEN_PREFIX, `${b.key}-${label}-app`)
      h.slack.addCredentials(b.key, label, { botToken, appToken }, { leakMarker: LEAK_SENTINEL, authTest })
      writeCredentialsFile(dir, relative(dir, b.credentials_file), { bot_token: botToken, app_token: appToken })
      labels.push(label)
      return credentialsDigest(readCredentialsFile(b.credentials_file))
    },
    held: () => controller.credentialsDigest(b.key),
    change: () =>
      controller.changeCredentials(b, h.personas, h.manager, {
        beforeSwap: () => void hookCalls.push('beforeSwap'),
        onSwapped: (swap) => void hookCalls.push(swap),
      }),
    async revokeCurrent() {
      h.slack.credentials(b.key, connectedWith()!).script.reactionsAdd.push({ kind: 'platform', error: 'token_revoked' })
      await h.manager.webClient(b.key)!.reactions.add({ channel: b.channels[0]!.id, timestamp: '1700000000.000100', name: 'eyes' })
        .catch(() => undefined)
      expect(h.manager.status(b.key)).toMatchObject({ state: 'broken', phase: 'running' })
    },
    connectedWith,
    changeFailedLines: () => h.lines.filter((l) => l.includes(`${PERSONA_CREDENTIALS_CHANGE_FAILED}:`)),
  }
}

describe('the controller\'s credentials change (SR-8.3, SR-8.6 step 4): any refusal holds the content B\'s own connection uses', () => {
  const KEPT_CONNECTION = '; the current connection stays in use, and the change stays pending'
  const KEPT_BROKEN = '; it stays broken by its credentials, and the change stays pending'

  test('change A left retrying, then change B refused at once: B holds O again (not A), A\'s superseded reconnect never swaps, and one failed line says the current connection stays in use', async () => {
    const s = await makeCredentialsStack()
    const o = s.held()
    const a = s.rotate('A', [{ kind: 'network' }])
    expect(await s.change()).toEqual({ kind: 'retrying', connection: 'kept' })
    expect(s.held()).toBe(a)

    s.rotate('B', [{ kind: 'platform', error: 'invalid_auth' }])
    const got = await s.change()

    expect(got).toMatchObject({ kind: 'failed' })
    expect(s.held()).toBe(o)
    await s.h.clock.advance(HOUR_MS)
    expect(s.held()).toBe(o)
    expect(s.connectedWith()).toBe(INITIAL_CREDENTIALS)
    expect(s.h.slack.credentials(s.b.key, 'A').calls.authTest).toHaveLength(1)
    expect(s.hookCalls).toEqual([])
    expect(s.changeFailedLines()).toEqual([expect.stringContaining(KEPT_CONNECTION)])
    expect(s.controller.state(s.b.key)?.outcome).toBe('up')
    assertNoLeak({ lines: s.h.lines, got })
  })

  test('change A left retrying, then change B left retrying and refused later: B holds B while it retries, then O again, with one failed line; A never swaps', async () => {
    const s = await makeCredentialsStack()
    const o = s.held()
    s.rotate('A', [{ kind: 'network' }])
    await s.change()
    const b = s.rotate('B', [{ kind: 'network' }, { kind: 'platform', error: 'invalid_auth' }])
    expect(await s.change()).toEqual({ kind: 'retrying', connection: 'kept' })
    expect(s.held()).toBe(b)
    expect(s.changeFailedLines()).toEqual([])

    await s.h.clock.advance(FIRST_RETRY_MS)

    expect(s.held()).toBe(o)
    expect(s.changeFailedLines()).toEqual([expect.stringContaining(KEPT_CONNECTION)])
    await s.h.clock.advance(HOUR_MS)
    expect(s.held()).toBe(o)
    expect(s.connectedWith()).toBe(INITIAL_CREDENTIALS)
    expect(s.hookCalls).toEqual([])
    assertNoLeak({ lines: s.h.lines })
  })

  test('change A left retrying swaps later, then change C refused at once: B holds A (what its connection now uses), not O', async () => {
    const s = await makeCredentialsStack()
    const a = s.rotate('A', [{ kind: 'network' }])
    await s.change()
    await s.h.clock.advance(FIRST_RETRY_MS)
    expect(s.connectedWith()).toBe('A')
    expect(s.hookCalls).toEqual(['beforeSwap', { late: true, wasUp: true }])

    s.rotate('C', [{ kind: 'platform', error: 'invalid_auth' }])
    expect(await s.change()).toMatchObject({ kind: 'failed' })

    expect(s.held()).toBe(a)
    expect(s.connectedWith()).toBe('A')
    expect(s.changeFailedLines()).toEqual([expect.stringContaining(KEPT_CONNECTION)])
    assertNoLeak({ lines: s.h.lines })
  })

  test('B retrying its bring-up takes change A, comes up on it, then change C is refused at once: B holds A (what its connection uses), not O', async () => {
    const s = await makeCredentialsStack({ [NAME_B]: { authTest: [{ kind: 'network' }] } })
    const a = s.rotate('A')
    expect(await s.change()).toEqual({ kind: 'retrying', connection: 'none' })
    expect(s.held()).toBe(a)
    await s.h.clock.advance(FIRST_RETRY_MS)
    await flush()
    expect(s.controller.state(s.b.key)?.outcome).toBe('up')
    expect(s.connectedWith()).toBe('A')

    s.rotate('C', [{ kind: 'platform', error: 'invalid_auth' }])
    expect(await s.change()).toMatchObject({ kind: 'failed' })

    expect(s.held()).toBe(a)
    expect(s.changeFailedLines()).toEqual([expect.stringContaining(KEPT_CONNECTION)])
    assertNoLeak({ lines: s.h.lines })
  })

  test('B\'s current connection refused while change A\'s first attempt runs, then A refused: the failed line says B stays broken by its credentials (not that its connection stays in use), and B holds O', async () => {
    const s = await makeCredentialsStack()
    const o = s.held()
    const deferred = makeDeferredWebApiCall()
    s.rotate('A', [deferred.outcome])
    const pending = s.change()
    await flush()
    await s.revokeCurrent()

    deferred.settle({ kind: 'platform', error: 'invalid_auth' })
    const got = await pending

    expect(got).toMatchObject({ kind: 'failed' })
    expect(s.changeFailedLines()).toEqual([expect.stringContaining(KEPT_BROKEN)])
    expect(s.changeFailedLines()[0]).not.toContain('the current connection stays in use')
    expect(s.held()).toBe(o)
    expect(s.controller.state(s.b.key)).toMatchObject({ outcome: 'broken', causes: { slack: { class: PERSONA_CREDENTIALS_REFUSED } } })
    assertNoLeak({ lines: s.h.lines, got })
  })

  test('B\'s current connection refused while change A\'s first attempt runs, then A unreachable: retrying with connection \'broken\' and A held; A\'s later swap brings B up again (a late swap, not up before it) and the controller launches it', async () => {
    const s = await makeCredentialsStack()
    const deferred = makeDeferredWebApiCall()
    const a = s.rotate('A', [deferred.outcome])
    const pending = s.change()
    await flush()
    await s.revokeCurrent()

    deferred.settle({ kind: 'network' })
    expect(await pending).toEqual({ kind: 'retrying', connection: 'broken' })
    expect(s.held()).toBe(a)
    expect(s.controller.state(s.b.key)?.outcome).toBe('broken')
    expect(s.launches).toEqual([])

    await s.h.clock.advance(FIRST_RETRY_MS)

    expect(s.hookCalls).toEqual(['beforeSwap', { late: true, wasUp: false }])
    expect(s.controller.state(s.b.key)?.outcome).toBe('up')
    expect(s.connectedWith()).toBe('A')
    expect(s.held()).toBe(a)
    expect(s.launches).toEqual([s.b.key])
    expect(s.changeFailedLines()).toEqual([])
    assertNoLeak({ lines: s.h.lines })
  })

  test('B\'s current connection refused while change A\'s first attempt runs, then A swaps: swapped with cameBackUp, the swap reported as not up before it, A held, and the controller launches B', async () => {
    const s = await makeCredentialsStack()
    const deferred = makeDeferredWebApiCall()
    const a = s.rotate('A', [deferred.outcome])
    const pending = s.change()
    await flush()
    await s.revokeCurrent()

    deferred.settle()
    expect(await pending).toEqual({ kind: 'swapped', cameBackUp: true })
    await flush()

    expect(s.hookCalls).toEqual(['beforeSwap', { late: false, wasUp: false }])
    expect(s.controller.state(s.b.key)?.outcome).toBe('up')
    expect(s.connectedWith()).toBe('A')
    expect(s.held()).toBe(a)
    expect(s.launches).toEqual([s.b.key])
    assertNoLeak({ lines: s.h.lines })
  })

  test('a plain swap reports up before it and no cameBackUp: swapped, and nothing launched', async () => {
    const s = await makeCredentialsStack()
    const a = s.rotate('A')

    expect(await s.change()).toEqual({ kind: 'swapped' })
    await flush()

    expect(s.hookCalls).toEqual(['beforeSwap', { late: false, wasUp: true }])
    expect(s.held()).toBe(a)
    expect(s.launches).toEqual([])
    assertNoLeak({ lines: s.h.lines })
  })

  test('change A left retrying, B\'s current connection then refused, and A refused later: B stays broken by its credentials with A held (nothing pending), logged as its refusal, not as a failed change', async () => {
    const s = await makeCredentialsStack()
    const a = s.rotate('A', [{ kind: 'network' }, { kind: 'platform', error: 'invalid_auth' }])
    expect(await s.change()).toEqual({ kind: 'retrying', connection: 'kept' })
    await s.revokeCurrent()
    const refusedBefore = s.h.lines.filter((l) => l.includes(`${PERSONA_CREDENTIALS_REFUSED}:`)).length

    await s.h.clock.advance(FIRST_RETRY_MS)

    expect(s.held()).toBe(a)
    expect(s.changeFailedLines()).toEqual([])
    expect(s.h.lines.filter((l) => l.includes(`${PERSONA_CREDENTIALS_REFUSED}:`))).toHaveLength(refusedBefore + 1)
    expect(s.controller.state(s.b.key)?.outcome).toBe('broken')
    assertNoLeak({ lines: s.h.lines })
  })
})

describe('credentials change over the real controller and manager: the DM forget before the swap, and the lines worded after the attempt', () => {
  /**
   * B up on O, with the manager's status reports for B recorded on the
   * lifecycle trail (`status:<state>`) beside the recorders, so the DM
   * forget's order against the swap's `up` report shows.
   */
  async function makeStatusStack(): Promise<CredentialsStack> {
    const s = await makeCredentialsStack()
    s.h.onStatus = (key, status) => {
      if (key === s.b.key) s.f.trail.push(`status:${status.state}`)
      s.controller.onConnectionStatus(key, status)
    }
    return s
  }
  const lineOf = (s: ControllerStack, rest: string) => `[slack] persona ${renderPersonaRef(s.b.name, s.b.key)}: ${rest}`

  // Rows: A's auth.test script, whether B's current connection is refused before A's retry, the lifecycle's line for the
  // operation's result and for a late swap (fragments after the persona prefix), and whether the controller launches B.
  test.each<[string, WebApiOutcome[], boolean, string, string | undefined, boolean]>([
    ['A swaps at once', [], false, 'reconnected with its changed credentials; its instance and MCP session are kept', undefined, false],
    ['A swaps later, B up meanwhile', [{ kind: 'network' }], false, 'the current one stays in use', 'reconnected with its changed credentials; its instance and MCP session are kept', false],
    ['A swaps later, B refused meanwhile', [{ kind: 'network' }], true, 'the current one stays in use', 'reconnected with its changed credentials and up again; its instance is kept', true],
  ])('%s: B\'s cached DM is forgotten right before the swap\'s up report (never at the operation\'s result), and the lines are worded by B\'s state then', async (_label, authTest, revoke, resultLine, lateLine, launched) => {
    const s = await makeStatusStack()
    s.rotate('A', authTest)

    await s.f.lifecycle.reconnectCredentials(s.b, { ...s.h.config!, personas: [s.a, s.b] })
    if (revoke) await s.revokeCurrent()
    await s.h.clock.advance(FIRST_RETRY_MS)
    await flush()

    const k = s.b.key
    // The forget comes right before the up report of the swap, and only once.
    expect(s.f.trail.filter((c) => c.startsWith('destinations.') || c === 'status:up')).toEqual([`destinations.forget:${k}`, 'status:up'])
    expect(s.connectedWith()).toBe('A')
    expect(s.f.lines).toHaveLength(lateLine === undefined ? 1 : 2)
    expect(s.f.lines[0]!.startsWith(lineOf(s, ''))).toBe(true)
    expect(s.f.lines[0]).toContain(resultLine)
    if (lateLine !== undefined) expect(s.f.lines[1]).toBe(lineOf(s, lateLine))
    expect(s.launches).toEqual(launched ? [k] : [])
    assertNoLeak({ lines: s.h.lines, lifecycle: s.f.lines })
  })

  test('step 6\'s recovery of B, broken by its credentials when step 4 ran, finds it up again (an earlier change\'s pending reconnect swapped meanwhile): the confirmed change C is applied as a credentials change, so B ends on C with no fresh bring-up', async () => {
    const s = await makeStatusStack()
    const applied = { ...s.h.config!, personas: [s.a, s.b] }
    // An earlier confirmed change A is left retrying; then B's own connection is refused.
    s.rotate('A', [{ kind: 'network' }])
    await s.f.lifecycle.reconnectCredentials(s.b, applied)
    await s.revokeCurrent()

    // A later confirmed change C: step 4 leaves B to step 6 ...
    const c = s.rotate('C')
    expect(await s.f.lifecycle.reconnectCredentials(s.b, applied)).toEqual({ kind: 'credentials-broken' })
    // ... and A's reconnect swaps before step 6 runs.
    await s.h.clock.advance(FIRST_RETRY_MS)
    expect(s.connectedWith()).toBe('A')
    await flush()
    const linesBefore = s.f.lines.length

    expect(await s.f.lifecycle.bringUp(s.b, applied, { recovery: true })).toEqual({ outcome: 'up', failures: [] })

    expect(s.connectedWith()).toBe('C')
    expect(s.held()).toBe(c)
    expect(s.f.lines.slice(linesBefore)).toEqual([
      expect.stringContaining('not brought up again — it is not broken by its credentials now, so its changed credentials are applied as a credentials change'),
      lineOf(s, 'reconnected with its changed credentials; its instance and MCP session are kept'),
    ])
    // Not cleared or brought up afresh: no storage check or apply launch, and no second Slack bring-up of B.
    expect(s.f.trail.filter((entry) => /^(storageCheck|launch):/.test(entry))).toEqual([])
    expect(s.h.bringUpCalls.filter((call) => call.key === s.b.key)).toHaveLength(1)
    expect(s.controller.state(s.b.key)?.outcome).toBe('up')
    assertNoLeak({ lines: s.h.lines, lifecycle: s.f.lines })
  })
})

// ---------------------------------------------------------------------------
// In-place update (SR-8.6, AC 58, apply step 3): the DM-cache forget and one
// line, under the serializer; nothing else about the persona is touched.
// ---------------------------------------------------------------------------

describe('in-place update (SR-8.6, AC 58): forget the cached DM when its destination settings changed, one line, nothing else', () => {
  /** The step-3 input for `p` with `settings` changed (`previous` is not read by the operation). */
  function change(p: Persona, settings: InPlaceSetting[]): InPlaceApplyInput {
    return { persona: p, previous: p, settings }
  }

  /** The exact update line for `p`, with the optional DM-cache suffix. */
  function updatedLine(p: Persona, settings: readonly InPlaceSetting[], suffix = ''): string {
    return (
      `[slack] persona ${renderPersonaRef(p.name, p.key)}: updated in place (${settings.join(', ')}); ` +
      `its instance, Slack connection and MCP session are kept${suffix}`
    )
  }

  const FORGOTTEN = '; its cached DM conversation is forgotten'

  /** A fixture with B still applied (an in-place update leaves it in the set). */
  function makeInPlaceFixture(opts: FixtureOptions = {}): Fixture {
    const f = makeFixture(opts)
    f.applied.push(f.b)
    return f
  }

  // Rows: the changed settings, and whether B's cached DM is forgotten (Director decision 11).
  test.each<[InPlaceSetting[], boolean]>([
    [['channels'], false],
    [['delivery'], false],
    [['channels', 'delivery'], false],
    [['permission_prompts'], true],
    [['dm.enabled'], true],
    [['dm.contact'], true],
    [['delivery', 'dm.contact'], true],
    [['channels', 'delivery', 'permission_prompts', 'dm.enabled', 'dm.contact'], true],
  ])('AC 58: %j changed: forgets B\'s cached DM only when a DM destination setting changed, logs one line, and touches no other state of B (no bring-up, retry, restart, connection, session, prompts, held notice or reply guard), live and in dry run alike', async (settings, forgets) => {
    for (const dryRun of [false, true]) {
      const f = makeInPlaceFixture({ dryRun })

      await expect(f.lifecycle.updateInPlace(change(f.b, settings))).resolves.toBeUndefined()

      expect(f.trail).toEqual(forgets ? [`destinations.forget:${f.b.key}`] : [])
      expect(f.lines).toEqual([updatedLine(f.b, settings, forgets ? FORGOTTEN : '')])
      expect(f.submitted).toEqual([f.b.key])
    }
  })

  test('forgetting the cached DM throws: the line carries the token-safe failure suffix instead, and the update still resolves', async () => {
    const f = makeInPlaceFixture({ fail: ['destinations.forget'] })

    await expect(f.lifecycle.updateInPlace(change(f.b, ['dm.contact']))).resolves.toBeUndefined()

    expect(f.trail).toEqual([`destinations.forget:${f.b.key}`])
    expect(f.lines).toHaveLength(1)
    expect(f.lines[0]).toMatch(
      new RegExp(`^${RegExp.escape(updatedLine(f.b, ['dm.contact'], '; forgetting its cached DM conversation failed: Error'))}( |$)`),
    )
    expect(f.lines[0]).not.toContain(FORGOTTEN)
    assertNoLeak({ lines: f.lines })
  })

  test('a key no longer applied when the update runs (removed by a later apply): nothing is forgotten and no line is logged', async () => {
    const f = makeFixture() // applied: [A]

    await expect(f.lifecycle.updateInPlace(change(f.b, ['dm.contact']))).resolves.toBeUndefined()

    expect(f.trail).toEqual([])
    expect(f.lines).toEqual([])
    expect(f.submitted).toEqual([f.b.key])
  })

  test('the applied set is read when the update runs, not when it was submitted: B leaving it while the update waits for B\'s turn gets nothing', async () => {
    const f = makeInPlaceFixture()
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const done = f.lifecycle.updateInPlace(change(f.b, ['dm.contact']))
    f.applied.splice(f.applied.indexOf(f.b), 1)
    blocker.resolve()
    await held
    await done

    expect(f.trail).toEqual([])
    expect(f.lines).toEqual([])
  })

  test('reading the applied set throws: one token-safe failure line, nothing forgotten, and the update resolves (no rejection)', async () => {
    const f = makeInPlaceFixture({ overrides: { appliedPersonas: () => { throw failure() } } })

    await expect(f.lifecycle.updateInPlace(change(f.b, ['dm.contact']))).resolves.toBeUndefined()

    expect(f.trail).toEqual([])
    expect(f.lines).toHaveLength(1)
    expect(f.lines[0]).toMatch(
      new RegExp(`^${RegExp.escape(`[slack] persona ${renderPersonaRef(f.b.name, f.b.key)}: in-place update failed: Error`)}( |$)`),
    )
    assertNoLeak({ lines: f.lines })
  })

  test('serialized per key: B\'s update waits behind an operation running for B; A\'s update does not', async () => {
    const f = makeInPlaceFixture()
    const blocker = Promise.withResolvers<void>()
    const held = f.serializer.run(f.b.key, () => blocker.promise)

    const forB = f.lifecycle.updateInPlace(change(f.b, ['dm.contact']))
    await f.lifecycle.updateInPlace(change(f.a, ['dm.enabled']))
    expect(await settled(forB)).toBe(false)
    expect(f.trail).toEqual([`destinations.forget:${f.a.key}`])
    expect(f.lines).toEqual([updatedLine(f.a, ['dm.enabled'], FORGOTTEN)])

    blocker.resolve()
    await held
    await forB
    expect(f.trail).toEqual([`destinations.forget:${f.a.key}`, `destinations.forget:${f.b.key}`])
    expect(f.lines).toEqual([updatedLine(f.a, ['dm.enabled'], FORGOTTEN), updatedLine(f.b, ['dm.contact'], FORGOTTEN)])
    expect(f.submitted).toEqual([f.b.key, f.a.key])
  })

  describe('over the real destination resolver (makeNotifierHarness): the next DM notice after the update', () => {
    // Rows: the changed settings (B's DM contact itself unchanged), and how many opens B's two notices make.
    test.each<[InPlaceSetting[], number]>([
      [['channels', 'delivery'], 1],
      [['dm.enabled'], 2],
      [['permission_prompts'], 2],
    ])('%j changed: B\'s next DM notice makes %i conversations.open in all, and both notices post to the opened DM through B\'s own client', async (settings, opens) => {
      const config = makeConfig()
      const [a, b0] = config.personas as [Persona, Persona]
      const b: Persona = { ...b0, dm: { enabled: true, contact: 'U0BETA001' }, permission_prompts: 'dm' }
      const h = makeNotifierHarness({ personas: [a, b] })
      cleanups.push(() => h.hold.cancelAll())
      const f = makeFixture({ overrides: { destinations: h.destinations } })
      f.applied.splice(0, f.applied.length, a, b)

      await h.notifier.notify(b.key, 'first notice')
      await f.lifecycle.updateInPlace(change(b, settings))
      await h.notifier.notify(b.key, 'second notice')

      const stubB = h.stub(b.key)
      expect(stubB.calls.conversationsOpen).toHaveLength(opens)
      for (const args of stubB.calls.conversationsOpen) expect(args).toMatchObject({ users: 'U0BETA001' })
      const posts = h.posts(b.key)
      expect(posts).toHaveLength(2)
      expect(posts[0]!.channel).toMatch(/^D/)
      expect(posts[1]!.channel).toBe(posts[0]!.channel)
      expect(h.posts(a.key)).toEqual([])
      expect(h.clock.pendingCount()).toBe(0)
      assertNoLeak({ lines: f.lines, logs: h.logs, posts: h.allPosts() })
    })
  })
})

// ---------------------------------------------------------------------------
// Template refresh (SR-8.6 step 5) through the lifecycle: its dependencies
// passed through, not serialized. The refresh itself (the `allow`
// replacement, the exact lines, token safety, a rejection) is pinned in
// agent-director-template.test.ts.
// ---------------------------------------------------------------------------

describe('template refresh (SR-8.6 step 5) through the lifecycle: the start-time template and client passed through; not serialized', () => {
  /** The applied config: B alone, whose own config dir gives the only rule (no default dir, so no home is read). */
  const appliedOf = (f: Fixture): PersonaConfig => ({ ...f.config, personas: [f.b] })

  test.each<[string, boolean]>([['live', false], ['dry run', true]])('%s: one makeTemplate call through templateRefresh.getClient with templateRefresh.installed\'s fields; its line goes to deps.log; no persona operation', async (_label, dryRun) => {
    const f = makeFixture({ dryRun })

    const result = await f.lifecycle.refreshTemplate(appliedOf(f))

    expect(result).toEqual({ kind: 'refreshed', path: expect.stringMatching(/slack-channel-bot\.toml$/) })
    expect(f.templateCalls).toEqual([{ ...INSTALLED_TEMPLATE, allow: expect.any(Array), overwrite: true }])
    expect(f.lines).toEqual([expect.stringMatching(/^\[slack\] template refresh: rewrote /)])
    expect(f.trail).toEqual([])
    expect(f.submitted).toEqual([])
  })

  test('not serialized: it resolves while an operation holds A\'s and B\'s turns', async () => {
    const f = makeFixture()
    const blocker = Promise.withResolvers<void>()
    const held = [f.serializer.run(f.a.key, () => blocker.promise), f.serializer.run(f.b.key, () => blocker.promise)]

    const done = f.lifecycle.refreshTemplate(appliedOf(f))
    expect(await settled(done)).toBe(true)
    expect(f.templateCalls).toHaveLength(1)

    blocker.resolve()
    await Promise.all(held)
  })
})

// ---------------------------------------------------------------------------
// Serialization (SR-6.6): a teardown waits behind the key's restart, retry
// launch and in-flight start-pass launch; never behind another key's work.
// ---------------------------------------------------------------------------

describe('persona teardown serialization (SR-6.6)', () => {
  test('a teardown for B waits at its launch-in-flight step (the start pass\'s launch) and holds B\'s turn meanwhile; A\'s teardown and bring-up complete in the meantime', async () => {
    const launchInFlight = Promise.withResolvers<void>()
    let bKey = ''
    const f = makeFixture({ launchInFlight: (key) => (key === bKey ? launchInFlight.promise : Promise.resolve()) })
    bKey = f.b.key
    const applied = { ...f.config, personas: [f.a, f.b] }

    const forB = f.lifecycle.teardown(f.b)
    await flush()
    expect(f.trail).toEqual(untilLaunchSettled(fullTeardownTrail(f.b, ''), f.b))

    // B's turn is held: a bring-up for B submitted now waits. A is independent.
    const bringUpB = f.lifecycle.bringUp(f.b, applied)
    await f.lifecycle.teardown(f.a)
    await f.lifecycle.bringUp(f.a, applied)
    expect(await settled(forB)).toBe(false)
    expect(await settled(bringUpB)).toBe(false)
    expect(f.trail.filter((c) => c.endsWith(`:${f.b.key}`))).toEqual(untilLaunchSettled(fullTeardownTrail(f.b, ''), f.b))
    expect(f.lines.filter((l) => l.startsWith(teardownPrefix(f.a)))).toEqual([
      ...cleanTeardownLines(f.a),
    ])

    launchInFlight.resolve()
    await forB
    await bringUpB
    const bTeardown = fullTeardownTrail(f.b, launchPassOf(f, undefined))
    const bUntilLaunch = untilLaunchSettled(bTeardown, f.b)
    const bringUpOf = (p: Persona) => [`storageCheck:${p.key}`, `bringUps.bringUp:${p.key}:[${f.a.key},${f.b.key}]`, `launch:${p.key}`]
    expect(f.trail).toEqual([
      ...bUntilLaunch,
      // A is still applied (the old half of a destructive modify): its early cancels at submit.
      ...stillAppliedTeardownTrail(f.a, `${JSON.stringify([f.a.claude_config_dir, undefined])}:[${f.a.key}]`),
      ...bringUpOf(f.a),
      ...bTeardown.slice(bUntilLaunch.length),
      ...bringUpOf(f.b),
    ])
  })

  describe('behind the restart module (real initRestart with the serializer, real cancelRestartTimer, real UNAVAILABLE retry timers)', () => {
    /**
     * Init the real restart module over `f`'s serializer, recording into
     * `f.trail`: `restart.canRestart:<key>` (the relaunch gate: at scheduling,
     * then twice in the work), `restart.submitted:<key>` (the fired timer
     * submits its work) and `restart.launchSession:<key>`.
     */
    function initRestartFor(f: Fixture, launch: () => Promise<boolean>, up: () => boolean = () => true, delaySeconds = 0.001): void {
      initRestart({
        canRestart: (key) => { f.trail.push(`restart.canRestart:${key}`); return up() },
        isSessionAlive: async () => LIVENESS_READING_DEAD,
        isSessionConnected: () => false,
        hasSessionStream: () => true,
        reconnectSession: async () => undefined,
        killSession: async (): Promise<KillOutcome> => KILL_SUCCEEDED,
        launchSession: async (key) => { f.trail.push(`restart.launchSession:${key}`); return launch() },
        getRestartDelay: () => delaySeconds,
        isShuttingDown: () => false,
        onCapReached: () => undefined,
        serialize: (key, op) => { f.trail.push(`restart.submitted:${key}`); return f.serializer.run(key, op) },
      })
    }

    interface RetryTimers {
      controller: UnavailableRetryController
      clock: FakeClock
      /** Every line the controller logged. */
      lines: string[]
    }

    /**
     * `makeFixture` with the real `cancelRestartTimer` and the real UNAVAILABLE
     * retry controller on a fake clock, as server.ts binds it: `stopRetryTimer`
     * records `stopRetryTimer:<key>` in the trail, then stops the key's timer
     * with the torn-down reason. A's and B's timers are armed (their first
     * retry 30 s away on the fake clock, never reached). Afterwards the
     * controller is closed and no fake-clock timer is left.
     */
    function makeRestartFixture(): { f: Fixture; retry: RetryTimers } {
      const clock = createFakeClock()
      const lines: string[] = []
      const controller = createUnavailableRetryController({
        log: (line) => void lines.push(line),
        action: () => {
          throw new Error('no retry falls due in these cases')
        },
        clock,
      })
      const f = makeFixture({
        overrides: {
          cancelRestartTimer,
          stopRetryTimer: (key) => {
            f.trail.push(`stopRetryTimer:${key}`)
            controller.stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
          },
        },
      })
      for (const p of [f.a, f.b]) controller.arm(p.key, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
      cleanups.push(() => {
        controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
        expect(clock.pendingCount()).toBe(0)
        assertNoLeak({ lines })
      })
      return { f, retry: { controller, clock, lines } }
    }

    /** After B's teardown: B's retry timer is gone (stopped once, as torn down) and A's is still armed, its timer the only one pending. */
    function expectOnlyBRetryStopped(f: Fixture, retry: RetryTimers): void {
      expect(retry.controller.isArmed(f.b.key)).toBe(false)
      expect(retry.controller.armedKeys()).toEqual([f.a.key])
      expect(retry.clock.pendingCount()).toBe(1)
      const stopped = retry.lines.filter((l) => l.includes(' stopped — '))
      expect(stopped).toEqual([`[slack] unavailable-retry: persona=${f.b.key} stopped — ${UNAVAILABLE_RETRY_STOP_TORN_DOWN}`])
    }

    const teardownOnly = (f: Fixture) => f.trail.filter((c) => !c.startsWith('restart.'))
    /** The full teardown trail without the recorder for `cancelRestartTimer` (the real one runs here). */
    const expectedTeardown = (f: Fixture) =>
      fullTeardownTrail(f.b, launchPassOf(f, undefined)).filter((c) => !c.startsWith('cancelRestartTimer:'))
    const restartOnly = (f: Fixture) => f.trail.filter((c) => c.startsWith('restart.'))

    test('a teardown for B submitted while B\'s restart work is running (its launch in progress) starts only once that work settled', async () => {
      const launchGate = Promise.withResolvers<boolean>()
      const { f, retry } = makeRestartFixture()
      initRestartFor(f, () => launchGate.promise)
      scheduleRestart(f.b.key, '/cwd/b')
      await until(() => f.trail.includes(`restart.launchSession:${f.b.key}`))

      const done = f.lifecycle.teardown(f.b)
      expect(await settled(done)).toBe(false)
      expect(f.lines).toEqual([])
      // Only the submit's registration, the submit-time stops and the cancel of a launch's wait for a working row (b.f2b), so the restart's launch is not held by one.
      expect(teardownOnly(f)).toEqual(submitCancels(f.b))

      launchGate.resolve(true)
      await done
      const launched = f.trail.indexOf(`restart.launchSession:${f.b.key}`)
      expect(f.trail.slice(launched + 1, launched + 10)).toEqual([
        ...submitCancels(f.b), ...turnStart(f.b), `stopApprover:${f.b.key}`, `stopLiveRowSequence:${f.b.key}`, `stopRetryTimer:${f.b.key}`,
      ])
      expect(teardownOnly(f)).toEqual(expectedTeardown(f))
      expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete`)
      expect(isRestartPendingOrActive(f.b.key)).toBe(false)
      expectOnlyBRetryStopped(f, retry)
    })

    // SRJ-305 / SRJ-715: the submit-time stop cannot see an arm that the
    // in-flight retry's own launch makes afterwards; the turn's stop, which
    // runs only after that work settled, must catch it.
    test('a still-applied teardown for B submitted while B\'s runRestartRetry is running (its launch in progress) starts only once that work settled; the launch arms B during the run, and B ends with no retry timer while A stays armed', async () => {
      const launchGate = Promise.withResolvers<boolean>()
      const { f, retry } = makeRestartFixture()
      const k = f.b.key
      f.applied.push(f.b) // the old half of a destructive modify
      initRestartFor(f, async () => {
        const launched = await launchGate.promise
        // The launch meets an agent-director refusal after the teardown was submitted.
        f.trail.push(`restart.retryArmed:${k}`)
        retry.controller.arm(k, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
        return launched
      })
      const run = runRestartRetry(k, '/cwd/b', () => false)
      await until(() => f.trail.includes(`restart.launchSession:${k}`))

      const done = f.lifecycle.teardown(f.b)
      expect(await settled(done)).toBe(false)
      expect(await settled(run)).toBe(false)
      expect(f.lines).toEqual([])
      // Only the submit-time cancels and stop; the turn waits behind the retry's work.
      expect(teardownOnly(f)).toEqual([...submitCancels(f.b), `bringUps.cancel:${k}`, `stopRetryTimer:${k}`])
      expect(retry.controller.isArmed(k)).toBe(false)

      launchGate.resolve(true)
      await done
      expect(await settled(run)).toBe(true)
      expect(await run).toBe(RESTART_OUTCOME_LAUNCHED)

      // The turn's first step comes right after the retry's work ended (its launch, then the arm).
      const armed = f.trail.indexOf(`restart.retryArmed:${k}`)
      expect(f.trail.indexOf(`restart.launchSession:${k}`)).toBeLessThan(armed)
      expect(f.trail.slice(armed + 1, armed + 6)).toEqual([...turnStart(f.b), `stopApprover:${k}`, `stopLiveRowSequence:${k}`, `stopRetryTimer:${k}`])
      expect(teardownOnly(f)).toEqual(
        stillAppliedTeardownTrail(f.b, `${JSON.stringify([f.b.claude_config_dir, undefined])}:[${f.a.key},${k}]`)
          .filter((c) => !c.startsWith('cancelRestartTimer:')),
      )
      expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete`)
      expect(isRestartPendingOrActive(k)).toBe(false)

      // B's timer: stopped at submit, re-armed by the launch, stopped again at the turn.
      expect(retry.controller.isArmed(k)).toBe(false)
      expect(retry.controller.armedKeys()).toEqual([f.a.key])
      expect(retry.clock.pendingCount()).toBe(1)
      const stoppedB = `[slack] unavailable-retry: persona=${k} stopped — ${UNAVAILABLE_RETRY_STOP_TORN_DOWN}`
      expect(retry.lines.filter((l) => l.includes(' stopped — '))).toEqual([stoppedB, stoppedB])
      expect(retry.lines.filter((l) => l.startsWith(`[slack] unavailable-retry: persona=${k} armed `))).toHaveLength(2)
    })

    test('a teardown for B queued behind B\'s fired restart runs after it; the restart work, starting after B left the applied set, is refused by the gate and launches nothing', async () => {
      let bApplied = true
      const { f, retry } = makeRestartFixture()
      initRestartFor(f, async () => true, () => bApplied)
      const blocker = Promise.withResolvers<void>()
      const held = f.serializer.run(f.b.key, () => blocker.promise)
      scheduleRestart(f.b.key, '/cwd/b')
      // The timer fires and its work is queued behind the blocker.
      await until(() => f.trail.includes(`restart.submitted:${f.b.key}`))

      bApplied = false // apply step 1
      const done = f.lifecycle.teardown(f.b)
      blocker.resolve()
      await held
      await done

      const k = f.b.key
      expect(restartOnly(f)).toEqual([`restart.canRestart:${k}`, `restart.submitted:${k}`, `restart.canRestart:${k}`])
      // The submit's registration, its stops and cancel of a launch's wait (b.f2b), then the refused restart work, then B's turn.
      expect(f.trail.slice(0, 12)).toEqual([
        `restart.canRestart:${k}`, `restart.submitted:${k}`, ...submitCancels(f.b), `restart.canRestart:${k}`,
        ...turnStart(f.b), `stopApprover:${k}`, `stopLiveRowSequence:${k}`, `stopRetryTimer:${k}`,
      ])
      expect(teardownOnly(f)).toEqual(expectedTeardown(f))
      expect(isRestartPendingOrActive(k)).toBe(false)
      expectOnlyBRetryStopped(f, retry)
    })
    // Rows: whether B is still applied (a destructive modify's old half) or removed, and whether its
    // restart timer is still pending, and its UNAVAILABLE retry timer still armed, once the teardown
    // is submitted and before its turn.
    test.each<[string, boolean, boolean]>([
      ['still applied: cancelled and stopped at submit, before its turn', true, false],
      ['removed: left for its turn (the relaunch gate refuses its work anyway)', false, true],
    ])('B\'s pending restart timer and armed UNAVAILABLE retry timer, with B %s', async (_label, stillApplied, pendingBeforeTurn) => {
      const { f, retry } = makeRestartFixture()
      if (stillApplied) f.applied.push(f.b)
      initRestartFor(f, async () => true, () => true, 60) // a timer that never fires in the test
      scheduleRestart(f.b.key, '/cwd/b')
      expect(isRestartPendingOrActive(f.b.key)).toBe(true)
      const blocker = Promise.withResolvers<void>()
      const held = f.serializer.run(f.b.key, () => blocker.promise)

      const done = f.lifecycle.teardown(f.b)
      await flush()
      expect(isRestartPendingOrActive(f.b.key)).toBe(pendingBeforeTurn)
      expect(retry.controller.isArmed(f.b.key)).toBe(pendingBeforeTurn)
      expect(retry.controller.isArmed(f.a.key)).toBe(true)
      expect(f.lines).toEqual([])

      blocker.resolve()
      await held
      await done
      expect(isRestartPendingOrActive(f.b.key)).toBe(false)
      expect(restartOnly(f)).toEqual([`restart.canRestart:${f.b.key}`])
      expectOnlyBRetryStopped(f, retry)
    })
  })

  describe('behind a bring-up retry (real bring-up controller over the real connection manager)', () => {
    /**
     * `makeControllerStack` with both brought up; B's first auth.test fails
     * (network), so B is retrying its Slack bring-up.
     */
    async function makeRetry(opts: { launch?: (p: Persona) => Promise<unknown>; whenLaunchSettled?: PersonaLifecycleDeps['whenLaunchSettled'] } = {}): Promise<ControllerStack> {
      const stack = makeControllerStack({
        stubOptions: { [NAME_B]: { authTest: [{ kind: 'network' }] } },
        launch: opts.launch,
        overrides: opts.whenLaunchSettled ? { whenLaunchSettled: opts.whenLaunchSettled } : {},
      })
      for (const p of [stack.a, stack.b]) await stack.controller.bringUp(p, stack.h.personas)
      expect(stack.controller.state(stack.b.key)?.outcome).toBe('retrying')
      return stack
    }

    test('a teardown for B submitted while B\'s launch after its Slack retry is running waits for it; then B has no bring-up state, no connection and no pending timer', async () => {
      const launchGate = Promise.withResolvers<void>()
      const r = await makeRetry({ launch: (p) => (p.name === NAME_B ? launchGate.promise : Promise.resolve()) })
      await r.h.clock.advance(5_000)
      expect(r.launches).toEqual([r.b.key])

      r.h.config = { ...r.h.config!, personas: [r.a] } // apply step 1
      const done = r.f.lifecycle.teardown(r.b)
      expect(await settled(done)).toBe(false)
      expect(r.f.lines).toEqual([])
      expect(r.h.manager.status(r.b.key)).toMatchObject({ state: 'up' })

      launchGate.resolve()
      await done

      expect(r.f.lines.at(-1)).toBe(`${teardownPrefix(r.b)}: complete`)
      expect(r.controller.state(r.b.key)).toBeUndefined()
      expect(r.h.manager.status(r.b.key)).toBeUndefined()
      expect(r.h.clock.pendingCount()).toBe(0)
      expect(r.h.manager.status(r.a.key)).toMatchObject({ state: 'up' })
      assertNoLeak({ lines: r.h.lines, teardown: r.f.lines })
    })

    test('the old half of a destructive modify (B still applied): B\'s Slack retry comes up while B\'s turn is held, and its launch, queued ahead of the teardown, launches nothing, since the teardown cancelled B\'s bring-up at submit', async () => {
      const r = await makeRetry()
      const blocker = Promise.withResolvers<void>()
      const held = r.f.serializer.run(r.b.key, () => blocker.promise)
      await r.h.clock.advance(5_000) // B's retry comes up: its launch waits behind the blocker
      expect(r.h.manager.status(r.b.key)).toMatchObject({ state: 'up' })
      expect(r.launches).toEqual([])

      r.f.applied.push(r.b) // B's key stays applied (its new declaration is brought up at step 6)
      const done = r.f.lifecycle.teardown(r.b)
      await flush()
      expect(r.controller.state(r.b.key)).toBeUndefined()

      blocker.resolve()
      await held
      await done
      await r.h.clock.advance(3_600_000)

      expect(r.launches).toEqual([])
      expect(r.h.manager.status(r.b.key)).toBeUndefined()
      expect(r.h.manager.status(r.a.key)).toMatchObject({ state: 'up' })
      expect(r.h.clock.pendingCount()).toBe(0)
      assertNoLeak({ lines: r.h.lines, teardown: r.f.lines })
    })

    test('B\'s Slack retry coming up while B\'s teardown is running (waiting on a launch in flight) launches nothing: the teardown cancelled B\'s bring-up first', async () => {
      const launchInFlight = Promise.withResolvers<void>()
      const r = await makeRetry({ whenLaunchSettled: () => launchInFlight.promise })
      r.h.config = { ...r.h.config!, personas: [r.a] } // apply step 1

      const done = r.f.lifecycle.teardown(r.b)
      await flush()
      await r.h.clock.advance(5_000)
      launchInFlight.resolve()
      await done
      await r.h.clock.advance(3_600_000)

      expect(r.launches).toEqual([])
      expect(r.controller.state(r.b.key)).toBeUndefined()
      expect(r.h.manager.status(r.b.key)).toBeUndefined()
      expect(r.h.clock.pendingCount()).toBe(0)
      assertNoLeak({ lines: r.h.lines, teardown: r.f.lines })
    })
  })
})
