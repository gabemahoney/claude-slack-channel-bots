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
 * - the agent-director kill and delete: the real `killPersonaInstance` /
 *   `deletePersonaInstance` over `makeStubClient`, with the real outage state
 *   (`resetAllToHealthy`) and the real notifier, destination resolver and
 *   destination hold (`makeNotifierHarness`, fake clock);
 * - the ack-reaction entries: the real ack tracker's `forgetPersonaAcks`;
 * - the notice episodes (b.jg5 SRJ-1016): a real `createPersonaEpisodes`
 *   instance on a fake clock, its `forget` as `forgetNoticeEpisodes`;
 * - the latch (b.jg5 SRJ-504): a real `createConflictLatch` with the CONFLICT
 *   notice bound to real notice episodes over a recording sink, its `forget`
 *   as `forgetConflictLatch`;
 * - the `ErrInvalidFlags` hold (b.jg5 SRJ-207, SRJ-715): a real
 *   `createInvalidFlagsHold` with its set reaction bound to real notice
 *   episodes over a recording sink, its `forget` as `forgetInvalidFlagsHold`;
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
import { _resetOutageState, getOutageFlags, initOutageState, resetAllToHealthy, setOutageFlag } from '../src/outage-state.ts'
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
  createPersonaEpisodes,
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
import { createPersonaLifecycle, LIVE_ROW_SEQUENCE_STOP_AGAIN_STEP, LIVE_ROW_SEQUENCE_STOP_STEP, type PersonaLifecycle, type PersonaLifecycleDeps } from '../src/persona-lifecycle.ts'
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
  _resetConfiguredPersonaQuery,
  deletePersonaInstance,
  KILL_CONTEXT_TEARDOWN,
  killPersonaInstance,
  setConfiguredPersonaQuery,
  setConflictLatch,
  stopLiveRowSequence,
  whenLaunchSettled,
} from '../src/session-manager.ts'
import { LIVE_ROW_OUTCOME_STOPPED, LIVE_ROW_STOP_TEARDOWN } from '../src/live-row-sequence.ts'
import { makeRecoveryHarness, personaOf, scriptLiveRowElsewhere } from './test-helpers/recovery-harness.ts'
import {
  KILL_OUTCOME_KILLED,
  KILL_OUTCOME_ROW_GONE,
  KILL_OUTCOME_SESSION_GONE,
  describeKillOutcome,
  killOutcomeOf,
  type KillOutcome,
} from '../src/checked-kill.ts'
import {
  RECHECK_OUTCOME_PASS,
  RECHECK_OUTCOME_STOP,
  installAdVersionRecheck,
  resetAdVersionRecheckForTests,
} from '../src/ad-version-gate.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import { AD_ERROR_CLASS_CONFIG, AD_ERROR_CLASS_ENVIRONMENT, AD_ERROR_CLASS_UNCLASSIFIED } from '../src/ad-error-class.ts'
import type { Phase1KillResult } from '../src/ad-phase1-types.ts'
import {
  createUnavailableRetryController,
  runInAttempt,
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_STOP_SHUTDOWN,
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  type UnavailableRetryController,
} from '../src/unavailable-retry.ts'
import {
  cannedKillResult,
  cannedStatusResult,
  errConfigMalformed,
  errGeneric,
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
  errUnusableName,
  makeStubCallLog,
  makeStubClient,
  stubCallCount,
} from './test-helpers/agent-director-stub.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, LEAK_SENTINEL, assertNoLeak, fakeToken, sentinelInMessage, writeCredentialsFile } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeConnectionHarness, type ConnectionHarness, type ConnectionHarnessOptions } from './test-helpers/persona-connection-harness.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness, type NotifierHarness } from './test-helpers/persona-notifier.ts'
import { INITIAL_CREDENTIALS, makeDeferredWebApiCall, type WebApiOutcome } from './test-helpers/slack-stub.ts'


/** The kill's success the fixture's `killInstance` answers: `kill_sent: true` (b.jg5 SRJ-701: only a success lets the delete follow). */
const KILL_SUCCEEDED: KillOutcome = { kind: KILL_OUTCOME_KILLED, killSent: true }

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
  | 'dropSession' | 'resetOutageState' | 'killInstance' | 'deleteInstance' | 'forgetFailures'
  | 'forgetDisconnectedStreak' | 'forgetNotConnectedEpisode' | 'forgetConflictLatch' | 'forgetInvalidFlagsHold' | 'forgetNoticeEpisodes' | 'replyGuard.launchedWithDir' | 'replyGuard.teardown' | 'replyGuard.launchPass'
  | 'storageCheck' | 'launch' | 'connections.reconnectCredentials' | 'connections.replaceRetryTokens'

/** Dependencies whose production form returns a promise: their failure is a rejection, the others' a throw. */
const ASYNC_DEPS = new Set<DepName>([
  'bringUps.bringUp', 'bringUps.changeCredentials', 'stopApprover', 'stopLiveRowSequence', 'whenLaunchSettled', 'connections.stop', 'connections.reconnectCredentials',
  'dropSession', 'killInstance', 'deleteInstance', 'launch',
])

/** A thrown value whose message carries a fake token: the log line must not show it. */
function failure(): Error {
  return new Error(`step exploded with ${fakeToken(BOT_TOKEN_PREFIX, 'lifecycle')}`)
}

interface FixtureOptions {
  dryRun?: boolean
  /** Dependencies that fail (async ones reject, the others throw) with `failure()`. */
  fail?: readonly DepName[]
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
        if (ASYNC_DEPS.has(name)) return Promise.reject(failure()) as R
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
    notifier: { forget: rec('notifier.forget', byKey, () => undefined) },
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
    killInstance: rec('killInstance', byKey, async (): Promise<KillOutcome> => KILL_SUCCEEDED),
    deleteInstance: rec('deleteInstance', byKey, async () => true),
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
 * The teardown's line naming its kill's outcome for `p` (b.jg5 SRJ-701,
 * SRJ-1014), logged when the kill succeeded: `outcome` is the fixture's
 * `KILL_SUCCEEDED` unless given (the real kill over the stub's default
 * result answers `kill_sent` absent).
 */
function killOutcomeLine(p: Persona, outcome: KillOutcome = KILL_SUCCEEDED): string {
  return `${teardownPrefix(p)}: agent-director kill of ${personaInstanceId(p.key)}: ${describeKillOutcome(outcome)}`
}

/** The teardown's line saying no delete was made after a kill that did not succeed (b.jg5 SRJ-701). */
function deleteNotMadeLine(p: Persona): string {
  return `${teardownPrefix(p)}: agent-director delete of ${personaInstanceId(p.key)} not made — its kill did not succeed, so the row is kept (b.jg5 SRJ-701)`
}

/** A teardown's lines when every step succeeds: starting, its kill's outcome line, complete. */
function cleanTeardownLines(p: Persona, outcome: KillOutcome = KILL_SUCCEEDED): string[] {
  return [`${teardownPrefix(p)}: starting`, killOutcomeLine(p, outcome), `${teardownPrefix(p)}: complete`]
}

/**
 * The teardown's own steps for `p` (its serializer turn), outside dry run,
 * with the recorders' defaults: its dialog approver is stopped first and its
 * live-row sequence right after, before every other step and before the
 * wait for its launch in flight (b.jg5 SRJ-404, SRJ-706, SRJ-715); the
 * launch's wait for a `working` row is
 * cancelled again (b.f2b) right before the teardown waits for the launch;
 * once that launch settled, its live-row sequence is stopped again and its
 * UNAVAILABLE retry timer with it (b.jg5 SRJ-715, SRJ-706: the launch can
 * have started a sequence at a collision ladder replacement site, b.jg5
 * SRJ-707, or armed the timer); after the agent-director calls the outage
 * state is forgotten and the
 * UNAVAILABLE retry timer stopped again (b.jg5 SRJ-311: a failing delete's
 * ENVIRONMENT answer arms one; the kill arms none, b.jg5 SRJ-110, hatch A3).
 */
function teardownTurnTrail(p: Persona, launchPass: string): string[] {
  const k = p.key
  return [
    `stopApprover:${k}`, `stopLiveRowSequence:${k}`,
    `bringUps.cancel:${k}`, `cancelRestartTimer:${k}`, `stopRetryTimer:${k}`, `cancelLaunchWait:${k}`, `whenLaunchSettled:${k}`,
    `stopLiveRowSequence:${k}`, `stopRetryTimer:${k}`,
    `connections.stop:${k}`, `routing.forget:${k}`, `forgetAcks:${k}`, `destinations.forget:${k}`, `destinationHold.cancel:${k}`,
    `notifier.forget:${k}`, `forgetPersonaPrompts:${k}`, `dropSession:${k}`,
    `resetOutageState:${k}`, `killInstance:${k}`, `deleteInstance:${k}`, `resetOutageState:${k}`, `stopRetryTimer:${k}`,
    `forgetFailures:${k}`, `forgetDisconnectedStreak:${k}`, `forgetNotConnectedEpisode:${k}`, `forgetConflictLatch:${k}`,
    `forgetInvalidFlagsHold:${k}`, `forgetNoticeEpisodes:${k}`, `replyGuard.launchedWithDir:${k}`, `replyGuard.teardown:${k}`, `replyGuard.launchPass:${launchPass}`,
  ]
}

/**
 * What every teardown runs at submit, before its turn: its dialog approver
 * stopped first (b.jg5 SRJ-404, SRJ-715), its live-row sequence right after
 * (b.jg5 SRJ-706), then its launch's wait for a `working` row cancelled
 * (b.f2b).
 */
function submitCancels(p: Persona): string[] {
  return [`stopApprover:${p.key}`, `stopLiveRowSequence:${p.key}`, `cancelLaunchWait:${p.key}`]
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
 * half of a destructive modify): its dialog approver stopped, its launch's
 * wait, bring-up retries and
 * restart timer cancelled and its UNAVAILABLE retry timer stopped at submit,
 * before its turn, then its turn with its
 * held notices dropped again right after the agent-director calls (and the
 * outage-state reset and retry-timer stop that follow them).
 */
function stillAppliedTeardownTrail(p: Persona, launchPass: string): string[] {
  const turn = teardownTurnTrail(p, launchPass)
  const afterAd = turn.lastIndexOf(`stopRetryTimer:${p.key}`) + 1
  return [
    ...submitCancels(p), `bringUps.cancel:${p.key}`, `cancelRestartTimer:${p.key}`, `stopRetryTimer:${p.key}`,
    ...turn.slice(0, afterAd), `notifier.forget:${p.key}`, ...turn.slice(afterAd),
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

  test('the launch pass reads the applied set when it runs, not when the teardown started', async () => {
    let applied: Persona[] = []
    const f = makeFixture({
      launchInFlight: async () => {
        applied.length = 0 // the applied set changes while the teardown runs
      },
    })
    applied = f.applied

    await f.lifecycle.teardown(f.b)

    expect(f.trail.at(-1)).toBe(`replyGuard.launchPass:${JSON.stringify([f.b.claude_config_dir, undefined])}:[]`)
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
    expect(f.trail).toEqual([...submitCancels(f.b), `stopApprover:${f.b.key}`])
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
    expect(f.trail).toEqual([...submitCancels(f.b), `stopApprover:${f.b.key}`, `stopLiveRowSequence:${f.b.key}`])

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
  test('b.jg5 SRJ-715, SRJ-706: once B\'s launch in flight settled, B\'s live-row sequence is stopped again and the turn awaits that stop, then stops B\'s retry timer again, before its Slack connection stops and before its kill', async () => {
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
    expect(f.trail.slice(settledAt, settledAt + 4)).toEqual([`whenLaunchSettled:${k}`, `stopLiveRowSequence:${k}`, `stopRetryTimer:${k}`, `connections.stop:${k}`])
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

  // Rows: the dependency that fails and the step phrase of each line it fails, in order. Two deps run more than once
  // in the turn, so each of their steps fails: resetOutageState (before and after the agent-director calls) and
  // stopRetryTimer (with the early timers, again once the launch in flight settled, b.jg5 SRJ-715, and again after
  // the post-call reset, b.jg5 SRJ-311).
  test.each<[DepName, string[]]>([
    ['bringUps.cancel', ['cancelling its bring-up retries']],
    ['cancelRestartTimer', ['cancelling its restart timer']],
    ['stopRetryTimer', ['stopping its UNAVAILABLE retry timer', 'stopping its UNAVAILABLE retry timer again, after its launch in flight settled', 'stopping its UNAVAILABLE retry timer']],
    ['whenLaunchSettled', ['waiting for its launch in flight']],
    ['connections.stop', ['stopping its Slack connection']],
    ['routing.forget', ['forgetting its inbound dedupe store']],
    ['forgetAcks', ['forgetting its ack-reaction entries']],
    ['destinations.forget', ['forgetting its DM destination']],
    ['destinationHold.cancel', ['cancelling its held destination notices']],
    ['notifier.forget', ['dropping its held notices']],
    ['forgetPersonaPrompts', ['dropping its tracked permission prompts']],
    ['dropSession', ['dropping its MCP session']],
    ['resetOutageState', ['forgetting its outage state', 'forgetting its outage state']],
    ['deleteInstance', ['agent-director delete of cscb_<key>']],
    ['forgetFailures', ['forgetting its restart failure count']],
    ['forgetDisconnectedStreak', ['forgetting its health-check streak']],
    ['forgetNotConnectedEpisode', ['forgetting its not-connected episode']],
    ['forgetConflictLatch', ['forgetting its latch']],
    ['forgetInvalidFlagsHold', ['forgetting its ErrInvalidFlags hold']],
    ['forgetNoticeEpisodes', ['forgetting its notice episodes']],
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

  // b.jg5 SRJ-110, SRJ-701: a kill step that throws shows no success, so the
  // delete is not made (the row is kept); every other step still runs.
  test('b.jg5 SRJ-701: killInstance failing (it throws): its step is logged token-safely, no delete is made (one line says so), every other step still runs, and the completion line counts one failed step', async () => {
    const launchedWith = join(dir, 'beta-launched-with')
    const f = makeFixture({ fail: ['killInstance'], launchedWith })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, launchedWith)).filter((c) => c !== `deleteInstance:${f.b.key}`))
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: agent-director kill of ${personaInstanceId(f.b.key)} failed: Error`)}( |$)`)),
      deleteNotMadeLine(f.b),
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
  })

  test('every step failing: the teardown still resolves, runs each step once but the delete (b.jg5 SRJ-701: the kill did not succeed) and reports all of them', async () => {
    const all: DepName[] = [
      'stopApprover', 'stopLiveRowSequence', 'bringUps.cancel', 'cancelRestartTimer', 'stopRetryTimer', 'cancelLaunchWait', 'whenLaunchSettled', 'connections.stop', 'routing.forget',
      'forgetAcks', 'destinations.forget', 'destinationHold.cancel', 'notifier.forget', 'forgetPersonaPrompts', 'dropSession',
      'resetOutageState', 'killInstance', 'deleteInstance', 'forgetFailures', 'forgetDisconnectedStreak', 'forgetNotConnectedEpisode',
      'forgetConflictLatch', 'forgetInvalidFlagsHold', 'forgetNoticeEpisodes', 'replyGuard.launchedWithDir', 'replyGuard.teardown', 'replyGuard.launchPass',
    ]
    const f = makeFixture({ fail: all })

    await f.lifecycle.teardown(f.b)

    expect(f.trail).toEqual(fullTeardownTrail(f.b, launchPassOf(f, undefined)).filter((c) => c !== `deleteInstance:${f.b.key}`))
    // 27 dependencies, the delete not run after the failed kill (b.jg5 SRJ-701);
    // resetOutageState and stopLiveRowSequence each run (and fail) twice in the turn, stopRetryTimer three times.
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with 30 failed step(s)`)
    expect(f.lines).toContain(deleteNotMadeLine(f.b))
    assertNoLeak({ lines: f.lines })
  })

  test('dry run: no agent-director kill or delete (and no clean slate before them), one dry-run line naming cscb_<key>; every other step still runs', async () => {
    const f = makeFixture({ dryRun: true })

    await f.lifecycle.teardown(f.b)

    const k = f.b.key
    const full = fullTeardownTrail(f.b, launchPassOf(f, undefined))
    const firstReset = full.indexOf(`resetOutageState:${k}`)
    expect(f.trail).toEqual(
      full.filter((c, i) => c !== `killInstance:${k}` && c !== `deleteInstance:${k}` && i !== firstReset),
    )
    expect(f.lines).toEqual([
      `${teardownPrefix(f.b)}: starting`,
      `[slack] dry-run: persona teardown of ${renderPersonaRef(f.b.name, k)}: skipping the agent-director kill and delete of ${personaInstanceId(k)}`,
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
  // rejection is awaited too).
  test.each<['forgetNoticeEpisodes' | 'forgetConflictLatch' | 'forgetInvalidFlagsHold', string, 'throws' | 'rejects']>([
    ['forgetNoticeEpisodes', 'forgetting its notice episodes', 'throws'],
    ['forgetNoticeEpisodes', 'forgetting its notice episodes', 'rejects'],
    ['forgetConflictLatch', 'forgetting its latch', 'throws'],
    ['forgetConflictLatch', 'forgetting its latch', 'rejects'],
    ['forgetInvalidFlagsHold', 'forgetting its ErrInvalidFlags hold', 'throws'],
    ['forgetInvalidFlagsHold', 'forgetting its ErrInvalidFlags hold', 'rejects'],
  ])('b.jg5: %s failing (%s; it %s): its step is logged token-safely by its own phrase, every other step still runs, and the teardown completes with one failed step', async (dep, phrase, how) => {
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
    expect(f.lines.slice(1)).toEqual([
      killOutcomeLine(f.b),
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: ${phrase} failed: Error`)}( |$)`)),
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
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
// Persona teardown of a key still applied: the old half of a destructive
// modify (b.av2 SR-8.6, a credentials_file path or working_directory change).
// ---------------------------------------------------------------------------

describe('persona teardown of a key still applied (the old half of a destructive modify, SR-8.6)', () => {
  // Rows: whether B is still applied when its teardown is submitted, what ran
  // at submit while B's turn was held, and the whole trail once it ran.
  test.each<[string, boolean, (f: Fixture) => string[], (f: Fixture, launchPass: string) => string[]]>([
    [
      'B still applied (a destructive modify\'s old half): its dialog approver stopped first, then its launch\'s wait, bring-up retries and restart timer are cancelled and its UNAVAILABLE retry timer stopped at submit, before its turn; its held notices are dropped again after the agent-director calls',
      true,
      (f) => [...submitCancels(f.b), `bringUps.cancel:${f.b.key}`, `cancelRestartTimer:${f.b.key}`, `stopRetryTimer:${f.b.key}`],
      (f, launchPass) => stillAppliedTeardownTrail(f.b, launchPass),
    ],
    [
      'B removed (it left the applied set at step 1): only its dialog approver is stopped and its launch\'s wait for a working row cancelled before its turn, and its notices are dropped once',
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

  test('dry run, B still applied: the early cancels and the second notice drop still run; only the kill and delete (and the clean slate before them) are skipped', async () => {
    const f = makeFixture({ dryRun: true })
    f.applied.push(f.b)

    await f.lifecycle.teardown(f.b)

    const k = f.b.key
    const launchPass = `${JSON.stringify([f.b.claude_config_dir, undefined])}:[${f.a.key},${k}]`
    const trail = stillAppliedTeardownTrail(f.b, launchPass)
    const firstReset = trail.indexOf(`resetOutageState:${k}`)
    expect(f.trail).toEqual(
      trail.filter((c, i) => c !== `killInstance:${k}` && c !== `deleteInstance:${k}` && i !== firstReset),
    )
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

  test('B still applied and dropping its notices failing: both drops are logged token-safely, the second by its own phrase, and every other step still runs', async () => {
    const f = makeFixture({ fail: ['notifier.forget'] })
    f.applied.push(f.b)

    await f.lifecycle.teardown(f.b)

    const launchPass = `${JSON.stringify([f.b.claude_config_dir, undefined])}:[${f.a.key},${f.b.key}]`
    expect(f.trail).toEqual(stillAppliedTeardownTrail(f.b, launchPass))
    expect(f.lines.slice(1, -1)).toEqual([
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: dropping its held notices failed: Error`)}( |$)`)),
      killOutcomeLine(f.b),
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: dropping the notices held during its teardown failed: Error`)}( |$)`)),
    ])
    expect(f.lines.at(-1)).toBe(`${teardownPrefix(f.b)}: complete, with 2 failed step(s)`)
    assertNoLeak({ lines: f.lines })
  })

  test('the applied set cannot be read: B counts as not applied (only its launch\'s wait cancelled early, no second notice drop), and the launch pass\'s failed read is its one failed step', async () => {
    const f = makeFixture({ overrides: { appliedPersonas: () => { throw failure() } } })

    await expect(f.lifecycle.teardown(f.b)).resolves.toBeUndefined()

    expect(f.trail).toEqual(fullTeardownTrail(f.b, '').slice(0, -1))
    expect(f.lines.slice(1)).toEqual([
      killOutcomeLine(f.b),
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(f.b)}: re-evaluating the Stop hook in its config directories failed: Error`)}( |$)`)),
      `${teardownPrefix(f.b)}: complete, with 1 failed step(s)`,
    ])
    assertNoLeak({ lines: f.lines })
  })
})

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
  }

  /**
   * A real latch with the CONFLICT notice bound to real notice episodes (fake
   * clock, recording sink), as `main()` binds them; the lifecycle's latch and
   * episodes forgets are theirs, each recorded in the trail first so the
   * order is asserted with the other steps. `launchInFlight` is B's launch in
   * flight, given the latch.
   */
  function makeLatched(opts: { launchInFlight?: (latch: ConflictLatch) => Promise<void>; dryRun?: boolean } = {}): LatchFixture {
    const clock = createFakeClock()
    const posts: LatchFixture['posts'] = []
    const latchLines: string[] = []
    const episodes = createPersonaEpisodes({ sink: (key, text) => void posts.push({ key, text }), log: (line) => void latchLines.push(line), clock })
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
      },
    })
    cleanups.push(() => {
      expect(clock.pendingCount()).toBe(0)
      assertNoLeak({ lines: f.lines, latchLines, posts })
    })
    return { f, latch, episodes, posts, latchLines }
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

  test('SRJ-1002: a latch B\'s launch in flight sets as it settles during the teardown is forgotten too (the forget waits for the launch), and its CONFLICT episode is not left open: a later same-case latch posts again', async () => {
    const release = Promise.withResolvers<void>()
    let postsAtSettle = -1
    let bRecordAtSettle: ConflictLatchRecord | undefined
    const r = makeLatched({
      // B's held launch: once released, its plain spawn is refused by the pre-spawn scan, latching B.
      launchInFlight: (latch) =>
        release.promise.then(() => {
          latch.set(r.f.b.key, LEFTOVER)
          bRecordAtSettle = latch.record(r.f.b.key)
          postsAtSettle = r.posts.length
        }),
    })
    const [a, b] = [r.f.a.key, r.f.b.key]
    r.latch.set(a, OWN_ID)
    const aRecord = r.latch.record(a)!
    const aNotice = { key: a, text: conflictNoticeText({ sessionName: aRecord.sessionName, latchCase: LATCH_CASE_OWN_ID, description: aRecord.description }) }
    const full = fullTeardownTrail(r.f.b, launchPassOf(r.f, undefined))

    const done = r.f.lifecycle.teardown(r.f.b)
    await flush()
    // The teardown waits for the launch: nothing after the wait has run.
    expect(r.f.trail).toEqual(untilLaunchSettled(full, r.f.b))
    expect(r.latch.isLatched(b)).toBe(false)

    release.resolve()
    await done
    await flush()

    expect(r.latch.isLatched(b)).toBe(false)
    expect(r.episodes.isOpen(b, PERSONA_EPISODE_KIND_CONFLICT)).toBe(false)
    expect(r.f.trail).toEqual(full)
    expect(r.f.lines).toEqual(cleanTeardownLines(r.f.b))
    // The posts are A's own notice, then the one B's in-flight latch posted as
    // the launch settled (pinned as today's behaviour: a later Epic routes an
    // in-flight latch's notice to the log only, and this pin changes then).
    // The teardown itself posted nothing after the launch settled.
    expect(bRecordAtSettle).toBeDefined()
    expect(bRecordAtSettle!.latchCase).toBe(LATCH_CASE_LEFTOVER)
    const bNoticeAtSettle = { key: b, text: conflictNoticeText({ sessionName: bRecordAtSettle!.sessionName, latchCase: LATCH_CASE_LEFTOVER, description: bRecordAtSettle!.description }) }
    expect(postsAtSettle).toBe(2)
    expect(r.posts).toEqual([aNotice, bNoticeAtSettle])
    expect(r.latch.isLatched(a)).toBe(true)

    // B added again, meeting the same case: a new episode, so exactly one new post.
    expect(r.latch.set(b, LEFTOVER)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(r.posts.slice(postsAtSettle)).toEqual([leftoverNotice(r)])
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

  test('dry run: B\'s latch and CONFLICT episode are still forgotten silently (only the agent-director kill and delete are skipped)', async () => {
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
  }

  /**
   * A real hold with its set reaction bound to real notice episodes (fake
   * clock, recording sink), as `main()` binds it; the lifecycle's hold and
   * episodes forgets are theirs, each recorded in the trail first so the
   * order is asserted with the other steps. `launchInFlight` is B's launch in
   * flight, given the hold.
   */
  function makeHeld(opts: { launchInFlight?: (hold: InvalidFlagsHold) => Promise<void> } = {}): HoldFixture {
    const clock = createFakeClock()
    const posts: HoldFixture['posts'] = []
    const holdLines: string[] = []
    const timerStops: string[] = []
    const episodes = createPersonaEpisodes({ sink: (key, text) => void posts.push({ key, text }), log: (line) => void holdLines.push(line), clock })
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
      },
    })
    cleanups.push(() => {
      expect(clock.pendingCount()).toBe(0)
      assertNoLeak({ lines: f.lines, holdLines, posts })
    })
    return { f, hold, episodes, posts, holdLines, timerStops }
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
})

// ---------------------------------------------------------------------------
// Persona teardown with the real agent-director calls, outage state,
// notifier and destination hold: no wind-down, no flag and no notice left.
// ---------------------------------------------------------------------------

describe('persona teardown (SR-6.5) over the real kill and delete, outage state, notifier and destination hold', () => {
  interface RealFixture {
    f: Fixture
    h: NotifierHarness
    calls: ReturnType<typeof makeStubCallLog>
    /** Agent-director verbs in call order, with the instance they name. */
    adOrder: string[]
    /** Every outage notify call (onsets and all-clears), by key. */
    emissions: Array<{ key: string; text: string }>
  }

  /**
   * B already left the applied set (apply step 1): the notifier harness's
   * persona list no longer has it. Outage notices go through the real
   * notifier. `kill` / `delete` script the stub's errors; `triggerSink` is
   * the outage state's retry trigger sink (none by default) and `overrides`
   * replace further lifecycle dependencies.
   */
  function makeReal(opts: {
    killError?: Error
    killResult?: Phase1KillResult
    deleteError?: Error
    post?: Record<string, readonly WebApiOutcome[]>
    triggerSink?: UnavailableRetryController
    /** The outage state's unclassified-error sink (none by default). */
    unclassifiedSink?: { report: (key: string, error: unknown) => void }
    overrides?: (f: () => Fixture) => Partial<PersonaLifecycleDeps>
  } = {}): RealFixture {
    const config = makeConfig()
    const h = makeNotifierHarness(config, { post: opts.post })
    cleanups.push(() => h.hold.cancelAll())
    const calls = makeStubCallLog()
    const adOrder: string[] = []
    const stub = makeStubClient({ ...calls, killError: opts.killError, killResult: opts.killResult, deleteError: opts.deleteError })
    const kill = stub.kill.bind(stub)
    const del = stub.delete.bind(stub)
    stub.kill = (p) => { adOrder.push(`kill:${p.claude_instance_id}`); return kill(p) }
    stub.delete = (p) => { adOrder.push(`delete:${p.claude_instance_id.join(',')}`); return del(p) }
    setClientForTests(stub as unknown as Parameters<typeof setClientForTests>[0])
    const emissions: Array<{ key: string; text: string }> = []
    initOutageState({
      getClient,
      notify: (key, text) => {
        emissions.push({ key, text })
        void h.notifier.notify(key, text)
      },
      ...(opts.triggerSink !== undefined ? { triggerSink: opts.triggerSink } : {}),
      ...(opts.unclassifiedSink !== undefined ? { unclassifiedSink: opts.unclassifiedSink } : {}),
    })
    const f: Fixture = makeFixture({
      overrides: {
        // As server.ts binds it: the teardown's kill context (b.jg5 SRJ-110).
        killInstance: (key) => killPersonaInstance(key, { context: KILL_CONTEXT_TEARDOWN }),
        deleteInstance: deletePersonaInstance,
        resetOutageState: resetAllToHealthy,
        notifier: h.notifier,
        destinations: h.destinations,
        destinationHold: h.hold,
        ...opts.overrides?.(() => f),
      },
    })
    return { f, h, calls, adOrder, emissions }
  }

  /** Step 1 of the apply: B leaves the applied set the notifier reads. */
  function removeB(r: RealFixture): void {
    const i = r.h.personas.findIndex((p) => p.key === r.f.b.key)
    r.h.personas.splice(i, 1)
  }

  test('AC 57: B\'s row is killed then deleted, cscb_B only, and no other agent-director verb is called (no graceful wind-down); A\'s outage flag is untouched', async () => {
    const r = makeReal()
    setOutageFlag(r.f.a.key, 'ad-unreachable', '/bin/ad')
    removeB(r)
    const before = r.emissions.length

    await r.f.lifecycle.teardown(r.f.b)

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual([`kill:${id}`, `delete:${id}`])
    expect(stubCallCount(r.calls)).toBe(2)
    expect([...getOutageFlags(r.f.a.key)]).toEqual(['ad-unreachable'])
    expect(r.emissions.slice(before)).toEqual([])
    expect(r.f.lines).toEqual(cleanTeardownLines(r.f.b, { kind: KILL_OUTCOME_KILLED }))
    expect(r.h.totalPosts()).toBe(1) // A's onset, posted before the teardown
    expect(r.h.posts(r.f.b.key)).toEqual([])
  })

  test('B held an ad-unreachable flag and the kill and delete succeed: no all-clear is raised or posted, and B holds no flag afterwards', async () => {
    const r = makeReal()
    setOutageFlag(r.f.b.key, 'ad-unreachable', '/bin/ad')
    await flush()
    const postsBefore = r.h.posts(r.f.b.key).length
    removeB(r)
    const before = r.emissions.length

    await r.f.lifecycle.teardown(r.f.b)
    await flush()

    expect(r.emissions.slice(before)).toEqual([])
    expect([...getOutageFlags(r.f.b.key)]).toEqual([])
    expect(r.h.posts(r.f.b.key)).toHaveLength(postsBefore)
  })

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

  /** The teardown's kill-step failure line for `p` whose kill answered `err`, from its outcome (b.jg5 SRJ-701). */
  function killFailedLine(p: Persona, err: Error): string {
    return `${teardownPrefix(p)}: agent-director kill of ${personaInstanceId(p.key)} failed: ${describeKillOutcome(killOutcomeOf({ thrown: err }))}`
  }

  test('b.jg5 SRJ-701: agent-director unreachable: the kill fails and is logged, no delete is made, the other steps run, B holds no flag afterwards, and the onset raised for B is never posted or held', async () => {
    const unreachable = new ErrSystemInstallDisappeared('kill', `/opt/ad/${fakeToken(BOT_TOKEN_PREFIX, 'bin')}`)
    const r = makeReal({ killError: unreachable, deleteError: unreachable })
    removeB(r)

    await r.f.lifecycle.teardown(r.f.b)
    await flush()

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual([`kill:${id}`])
    expect(r.f.trail.slice(-9)).toEqual([
      `forgetFailures:${r.f.b.key}`, `forgetDisconnectedStreak:${r.f.b.key}`, `forgetNotConnectedEpisode:${r.f.b.key}`,
      `forgetConflictLatch:${r.f.b.key}`, `forgetInvalidFlagsHold:${r.f.b.key}`, `forgetNoticeEpisodes:${r.f.b.key}`,
      `replyGuard.launchedWithDir:${r.f.b.key}`, `replyGuard.teardown:${r.f.b.key}`,
      `replyGuard.launchPass:${launchPassOf(r.f, undefined)}`,
    ])
    expect(r.f.lines.slice(1)).toEqual([
      killFailedLine(r.f.b, unreachable),
      deleteNotMadeLine(r.f.b),
      `${teardownPrefix(r.f.b)}: complete, with 1 failed step(s)`,
    ])
    expect(r.f.lines[1]).toContain(`class=${AD_ERROR_CLASS_UNCLASSIFIED}`)
    expect([...getOutageFlags(r.f.b.key)]).toEqual([])
    // The wrapper still raises ad-unreachable for B (b.jg5 SRJ-110), dropped with B's state.
    expect(r.emissions.map((e) => e.key)).toEqual([r.f.b.key])
    expect(r.h.totalPosts()).toBe(0)
    expect(r.h.hold.view(r.f.b.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs })
  })

  // b.jg5 SRJ-701, SRJ-703: a success (`kill_sent` true, false or absent) and
  // `ErrSpawnNotFound` pass the kill step, and the delete runs; `kill_sent:
  // false` raises nothing.
  test.each<[string, { killResult?: Phase1KillResult; killError?: Error }, KillOutcome]>([
    ['kill_sent true', { killResult: cannedKillResult(true) }, { kind: KILL_OUTCOME_KILLED, killSent: true }],
    ['kill_sent false', { killResult: cannedKillResult(false) }, { kind: KILL_OUTCOME_KILLED, killSent: false }],
    ['ErrSpawnNotFound (the row already gone)', { killError: errSpawnNotFound() }, { kind: KILL_OUTCOME_ROW_GONE }],
    // b.jg5 SRJ-104, SRJ-110: for `kill`, gone is success.
    ['GONE (ErrTmuxCaptureFailed), the session-gone success', { killError: errTmuxCaptureFailed(undefined, 'kill') }, { kind: KILL_OUTCOME_SESSION_GONE, name: errTmuxCaptureFailed().errName }],
    ['GONE (ErrTmuxSendKeys), the session-gone success', { killError: errTmuxSendKeys() }, { kind: KILL_OUTCOME_SESSION_GONE, name: errTmuxSendKeys().errName }],
  ])('b.jg5 SRJ-701, SRJ-703, SRJ-104: the kill succeeds with %s: the kill step passes with its outcome line, the delete runs, nothing is raised or posted', async (_label, kill, outcome) => {
    const r = makeReal(kill)
    removeB(r)

    await r.f.lifecycle.teardown(r.f.b)
    await flush()

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual([`kill:${id}`, `delete:${id}`])
    expect(r.f.lines).toEqual(cleanTeardownLines(r.f.b, outcome))
    expect(r.emissions).toEqual([])
    expect(r.h.totalPosts()).toBe(0)
  })

  test('the row is already gone (ErrSpawnNotFound on both): success, no failed step', async () => {
    const r = makeReal({ killError: errSpawnNotFound(), deleteError: errSpawnNotFound() })
    removeB(r)

    await r.f.lifecycle.teardown(r.f.b)

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual([`kill:${id}`, `delete:${id}`])
    expect(r.f.lines).toEqual(cleanTeardownLines(r.f.b, { kind: KILL_OUTCOME_ROW_GONE }))
    expect(r.emissions).toEqual([])
    expect(r.h.totalPosts()).toBe(0)
  })

  test('the delete fails with another error: logged after the kill\'s outcome line', async () => {
    const r = makeReal({ deleteError: errGeneric('delete', 'ErrDeleteBroken') })
    removeB(r)

    await r.f.lifecycle.teardown(r.f.b)

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual([`kill:${id}`, `delete:${id}`])
    expect(r.f.lines.slice(1)).toEqual([
      killOutcomeLine(r.f.b, { kind: KILL_OUTCOME_KILLED }),
      expect.stringMatching(new RegExp(`^${RegExp.escape(`${teardownPrefix(r.f.b)}: agent-director delete of ${id} failed: AgentDirectorError`)}`)),
      `${teardownPrefix(r.f.b)}: complete, with 1 failed step(s)`,
    ])
    expect(r.emissions).toEqual([])
    expect(r.h.totalPosts()).toBe(0)
  })

  // b.jg5 SRJ-110, SRJ-701: a kill that does not succeed fails the kill
  // step with the teardown's failure line naming the outcome, makes no
  // delete (the row is kept) and latches nothing, even with the server's
  // latch installed and B configured (SRJ-1002 routes it; E25 owns the
  // route); the teardown's other steps still run. Reverses "the kill fails
  // with another error: logged, and the delete still runs".
  test.each<[string, () => Error]>([
    ['ErrTmuxKillFailed', () => errTmuxKillFailed()],
    ['ErrTmuxUnresponsive', () => errTmuxUnresponsive('kill')],
    ['ErrTmuxSessionConflict (not this launch\'s session)', () => errTmuxSessionConflict('kill', 'not-this-launch')],
    ['an UNUSABLE NAME ErrInternal', () => errUnusableName()],
    ['an unreachable error (a plain Error)', () => new Error(`agent-director went away (${sentinelInMessage('teardown-kill')})`)],
    ['another error (ErrKillBroken)', () => errGeneric('kill', 'ErrKillBroken')],
  ])('b.jg5 SRJ-110, SRJ-701: the kill answers %s: the kill step fails with its line, no delete is made, nothing latches, every other step still runs', async (_label, make) => {
    const err = make()
    const latch = installLatch(() => true)
    const r = makeReal({ killError: err })
    removeB(r)

    await r.f.lifecycle.teardown(r.f.b)
    await flush()

    const id = personaInstanceId(r.f.b.key)
    expect(r.adOrder).toEqual([`kill:${id}`])
    expect(stubCallCount(r.calls)).toBe(1)
    // The steps after the agent-director calls still ran.
    expect(r.f.trail.slice(-9)).toEqual([
      `forgetFailures:${r.f.b.key}`, `forgetDisconnectedStreak:${r.f.b.key}`, `forgetNotConnectedEpisode:${r.f.b.key}`,
      `forgetConflictLatch:${r.f.b.key}`, `forgetInvalidFlagsHold:${r.f.b.key}`, `forgetNoticeEpisodes:${r.f.b.key}`,
      `replyGuard.launchedWithDir:${r.f.b.key}`, `replyGuard.teardown:${r.f.b.key}`,
      `replyGuard.launchPass:${launchPassOf(r.f, undefined)}`,
    ])
    expect(r.f.lines.slice(1)).toEqual([
      killFailedLine(r.f.b, err),
      deleteNotMadeLine(r.f.b),
      `${teardownPrefix(r.f.b)}: complete, with 1 failed step(s)`,
    ])
    expect(latch.isLatched(r.f.b.key)).toBe(false)
    expect(r.h.totalPosts()).toBe(0)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs })
  })

  test('b.jg5 SRJ-701: the old half of a destructive modify (B still applied, its connection stopped) with agent-director unreachable: the onset its failing kill raises is held for B, then dropped after the agent-director call, so B\'s new half, once validated and flushed, posts nothing; no delete is made', async () => {
    const unreachable = new ErrSystemInstallDisappeared('kill', '/opt/ad/bin')
    const r = makeReal({ killError: unreachable, deleteError: unreachable })
    const b = r.f.b
    r.f.applied.push(b) // B keeps its key applied until step 6 brings its new declaration up
    r.h.validated.delete(b.key) // its connection is stopped: no validated client, so a notice for it is held

    await r.f.lifecycle.teardown(b)
    await flush()
    expect(r.emissions.map((e) => e.key)).toEqual([b.key]) // the onset was raised for B
    expect(r.adOrder).toEqual([`kill:${personaInstanceId(b.key)}`])

    // Step 6: B's new half comes up and its held notices are flushed.
    r.h.validate(b.key)
    await r.h.notifier.flush(b.key)

    expect(r.h.posts(b.key)).toEqual([])
    expect(r.h.totalPosts()).toBe(0)
    expect([...getOutageFlags(b.key)]).toEqual([])
    expect(r.h.hold.view(b.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(r.f.lines.at(-1)).toBe(`${teardownPrefix(b)}: complete, with 1 failed step(s)`)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs })
  })

  // b.jg5 SRJ-110, SRJ-301 (hatch A3): the teardown's kill is no launch or
  // recovery attempt, so an ENVIRONMENT or CONFIG answer there arms no retry
  // timer and makes no delete; it raises its outage only while B is in the
  // applied configuration (the configured-persona query), and the
  // teardown's reset after the agent-director call drops it. Replaces E11's
  // case in which the kill's ENVIRONMENT answer armed B's timer and the
  // teardown's second stop stopped it.
  test.each<[string, () => Error, string, boolean]>([
    ['ENVIRONMENT (ErrTmuxNotAvailable)', () => errTmuxNotAvailable(undefined, 'kill'), AD_ERROR_CLASS_ENVIRONMENT, true],
    ['ENVIRONMENT (ErrTmuxNotAvailable)', () => errTmuxNotAvailable(undefined, 'kill'), AD_ERROR_CLASS_ENVIRONMENT, false],
    ['CONFIG (ErrConfigMalformed)', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG, true],
    ['CONFIG (ErrConfigMalformed)', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG, false],
  ])('b.jg5 SRJ-110, SRJ-301 (hatch A3): the old half of a destructive modify (B still applied) whose kill answers %s (%s; B configured: %p): no retry timer is armed for B and no delete is made; the outage is raised only for a configured B; A\'s timer stays armed', async (_label, make, errorClass, configured) => {
    const clock = createFakeClock()
    const retryLines: string[] = []
    const controller = createUnavailableRetryController({
      log: (line) => void retryLines.push(line),
      action: () => {
        throw new Error('no retry falls due in this case')
      },
      clock,
    })
    cleanups.push(() => {
      controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
      expect(clock.pendingCount()).toBe(0)
      assertNoLeak({ lines: retryLines })
    })
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
    r.f.applied.push(b) // B keeps its key applied until step 6 brings its new declaration up
    controller.arm(r.f.a.key, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })

    await r.f.lifecycle.teardown(b)
    await flush()

    const id = personaInstanceId(k)
    expect(r.adOrder).toEqual([`kill:${id}`])
    // Every stop (at submit, in the turn, after its launch in flight settled, after the kill) finds no timer: the kill armed none.
    const stops = r.f.trail.filter((c) => c.startsWith('stopRetryTimer:'))
    expect(stops).toEqual([`stopRetryTimer:${k}:none`, `stopRetryTimer:${k}:none`, `stopRetryTimer:${k}:none`, `stopRetryTimer:${k}:none`])
    expect(retryLines.filter((l) => l.startsWith(`[slack] unavailable-retry: persona=${k} armed`))).toEqual([])
    expect(controller.isArmed(k)).toBe(false)
    expect(controller.armedKeys()).toEqual([r.f.a.key])
    expect(clock.pendingCount()).toBe(1) // A's timer only
    // The outage's onset for B only while B is configured; the teardown's reset drops the flag.
    expect(r.emissions.map((e) => e.key)).toEqual(configured ? [k] : [])
    expect([...getOutageFlags(k)]).toEqual([])
    expect(latch.isLatched(k)).toBe(false)
    expect(r.f.lines.slice(1)).toEqual([
      killFailedLine(b, err),
      deleteNotMadeLine(b),
      `${teardownPrefix(b)}: complete, with 1 failed step(s)`,
    ])
    expect(r.f.lines[1]).toContain(`class=${errorClass}`)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs })
  })

  /**
   * A recording trigger sink and unclassified sink: every arm and every
   * unclassified report the outage state sends, by key.
   */
  function recordingSinks(): {
    arms: string[]
    reports: string[]
    triggerSink: UnavailableRetryController
    unclassifiedSink: { report: (key: string) => void }
  } {
    const arms: string[] = []
    const reports: string[] = []
    const triggerSink = { arm: (key: string) => { arms.push(key); return true } } as unknown as UnavailableRetryController
    return { arms, reports, triggerSink, unclassifiedSink: { report: (key) => { reports.push(key) } } }
  }

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
    const sinks = recordingSinks()
    const r = makeReal({ killError: err, triggerSink: sinks.triggerSink, unclassifiedSink: sinks.unclassifiedSink })
    removeB(r)

    await runInAttempt(r.f.b.key, 'recovery', () => r.f.lifecycle.teardown(r.f.b))
    await flush()

    expect(r.adOrder).toEqual([`kill:${personaInstanceId(r.f.b.key)}`])
    expect(sinks.arms).toEqual([])
    expect(sinks.reports).toEqual([])
    expect(r.f.lines.slice(1)).toEqual([
      killFailedLine(r.f.b, err),
      deleteNotMadeLine(r.f.b),
      `${teardownPrefix(r.f.b)}: complete, with 1 failed step(s)`,
    ])
    expect(r.f.lines[1]).toContain(`class=${AD_ERROR_CLASS_UNCLASSIFIED}`)
    expect(latch.isLatched(r.f.b.key)).toBe(false)
    assertNoLeak({ lines: r.f.lines, logs: r.h.logs })
  })

  // b.jg5 SRJ-104, SRJ-204, SRJ-205: an ErrInvalidFlags at the teardown's
  // kill gets exactly one immediate version re-check; either way the kill
  // step fails and no delete is made, and nothing is armed or reported.
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
      const sinks = recordingSinks()
      const r = makeReal({ killError: err, triggerSink: sinks.triggerSink, unclassifiedSink: sinks.unclassifiedSink })
      removeB(r)

      await r.f.lifecycle.teardown(r.f.b)
      await flush()

      expect(resolveCalls).toHaveLength(1)
      expect(stops).toHaveLength(stopCount)
      expect(r.adOrder).toEqual([`kill:${personaInstanceId(r.f.b.key)}`])
      expect(sinks.arms).toEqual([])
      expect(sinks.reports).toEqual([])
      const described = describeKillOutcome({ ...killOutcomeOf({ thrown: err }), recheck } as KillOutcome)
      expect(described).toContain(`recheck=${recheck}`)
      expect(r.f.lines.slice(1)).toEqual([
        `${teardownPrefix(r.f.b)}: agent-director kill of ${personaInstanceId(r.f.b.key)} failed: ${described}`,
        deleteNotMadeLine(r.f.b),
        `${teardownPrefix(r.f.b)}: complete, with 1 failed step(s)`,
      ])
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

    await r.f.lifecycle.teardown(b)
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
      // A is still applied (the old half of a destructive modify): its early cancels and second notice drop.
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
      // Only the submit-time approver stop and cancel of a launch's wait for a working row (b.f2b), so the restart's launch is not held by one.
      expect(teardownOnly(f)).toEqual(submitCancels(f.b))

      launchGate.resolve(true)
      await done
      const launched = f.trail.indexOf(`restart.launchSession:${f.b.key}`)
      expect(f.trail.slice(launched + 1, launched + 7)).toEqual([
        ...submitCancels(f.b), `stopApprover:${f.b.key}`, `stopLiveRowSequence:${f.b.key}`, `bringUps.cancel:${f.b.key}`,
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
      expect(f.trail.slice(armed + 1, armed + 5)).toEqual([`stopApprover:${k}`, `stopLiveRowSequence:${k}`, `bringUps.cancel:${k}`, `stopRetryTimer:${k}`])
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
      // The submit-time approver stop and cancel of a launch's wait (b.f2b), then the refused restart work, then B's turn.
      expect(f.trail.slice(0, 9)).toEqual([
        `restart.canRestart:${k}`, `restart.submitted:${k}`, ...submitCancels(f.b), `restart.canRestart:${k}`,
        `stopApprover:${k}`, `stopLiveRowSequence:${k}`, `bringUps.cancel:${k}`,
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
