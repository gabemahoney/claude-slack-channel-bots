/**
 * test-helpers/recovery-harness.ts — `makeRecoveryHarness`, the recovery
 * harness (b.jg5 SRJ-1304): the UNAVAILABLE retry timer and the recovery
 * paths around it, wired over one fake clock and one stub client.
 *
 * API
 * ---
 * `makeRecoveryHarness(options?)` builds, over one `createFakeClock`:
 *
 * - `controller`: the server's UNAVAILABLE retry controller
 *   (`createUnavailableRetryController`) on the harness clock. Its log lines
 *   go to `lines`. Its retry action is a delegate: every retry is recorded in
 *   `attempts` (persona key, retry number, cause kinds and the clock time),
 *   then answered by the current action. The current action is
 *   `options.action`, or else the scripted action: it answers each persona's
 *   queued outcomes (`answer(key, ...outcomes)`) in order and, once they run
 *   out, a refusal (`{ kind: 'again', cause: { kind: 'unavailable' } }`).
 *   `setAction(action)` swaps the current action; `setAction(undefined)`
 *   goes back to the scripted one.
 * - `stub`: one stub client (`makeStubClient`) with its call log
 *   (`stub.calls`), installed through `installStubSpawnPath` with the spawn
 *   home under the harness's temporary HOME, and handed to the outage state
 *   (`initOutageState`) as its client. The tmux session killer and server
 *   ensurer the launch path can reach are inert, so no tmux runs.
 *   `script(knobs)` sets the stub's answers (`StubClientOptions` knobs such
 *   as `spawnError` or `getQueue`), read at each call.
 * - `triggers`: the outage state's trigger sink (b.jg5 SRJ-301) is the
 *   controller, behind a recorder: every trigger an agent-director error
 *   inside a launch or recovery attempt sends (`{ key, kind }`, the cause
 *   kind) is recorded here, then armed on the controller. With
 *   `options.triggerSink: false` no sink is installed: nothing is recorded or
 *   armed.
 * - `launch(key)`: a start-pass launch of the configured persona `key`
 *   through the real `spawnForPersona` (`isStartup` true) over the stub,
 *   resolving with its `SpawnPersonaResult`. Each persona's working directory
 *   exists, so a row the stub answers in it is the persona's own.
 * - `settle()`: awaits every configured persona's launch in flight
 *   (`whenLaunchSettled`). The spawn path polls in real time (the dialog
 *   approver's 1 ms steps; it takes no fake clock), so this is the one
 *   real-time wait: 1 ms steps, bounded by `options.settleMs`, and it throws
 *   when a launch is still in flight at the bound.
 * - `outageNotices`: the outage state's notices, `{ key, text }`, in order.
 * - `notices`: the session manager's notices (`setSessionNotifier`),
 *   `{ key, text }`, in order.
 * - `stateDir` and `startupErrors()`: `SLACK_STATE_DIR` points at a
 *   temporary directory while the harness is live; `startupErrors()` answers
 *   the entries written to its `startup-errors.log`, one per line.
 * - `home` and `settings()`: agent-director's settings in effect, through
 *   the settings install (`installAdSettings`) over the temporary HOME.
 *   `options.adSettings`, when given, is written there first
 *   (`writeAgentDirectorConfig`); otherwise no file exists and the defaults
 *   are in effect. The reader's lines go to `lines`.
 * - `config` and `keys`: a resolved configuration of `options.personas`
 *   (two personas by default) with `session_restart_delay` and
 *   `health_check_interval` from the options, both 0 by default (SRJ-304).
 *   The restart module is initialised over it (`initRestart`): its delay is
 *   the configuration's, its relaunch gate admits the configured keys, and
 *   every other dependency is an inert stand-in unless `options.restartDeps`
 *   replaces it.
 * - `advance(ms)`: moves the clock `ms` forward one due time at a time.
 *   Before and after each firing it awaits every in-flight retry run
 *   (`whenRunSettled`), bounded by `options.settleFlushes` clock flushes, so
 *   a re-arm measured from a run's end lands exactly and a run the test holds
 *   open does not stall the step. Resolves with the number of timers fired.
 * - `captured()`: everything captured, for `assertNoLeak`: the lines, both
 *   notice lists, the startup-errors entries, the attempts, the triggers and
 *   the state directory as a written file.
 * - `cleanup()`: stops every retry timer (`stopAll`), then undoes every
 *   install and reset the harness made (the restart module and the failure
 *   counter, the outage state and its trigger sink, the session notifier,
 *   the stub spawn path and client with every launch still in flight, the
 *   findMissing memo, the tmux seams, the settings install,
 *   `SLACK_STATE_DIR`) and removes the temporary directory. It throws, after
 *   undoing everything, when a timer is still pending on the clock or a
 *   persona is still armed.
 *
 * Later work extends this harness in place (the real restart entry as the
 * default action, and the pending-row rule, the latch and the episodes).
 *
 * Isolation: no top-level `mock.module()`, no real HOME, `~/.agent-director`,
 * tmux or child process. The retry timer runs on the fake clock only; the one
 * real-time wait is `settle()`'s bounded poll for the spawn path. Every file
 * sits under one `mkdtempSync` directory.
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Client } from 'agent-director'

import { adSettingsInEffect, installAdSettings, resetAdSettingsForTests, type AdSettingsInEffect } from '../../src/ad-settings.ts'
import { _resetBackoffState } from '../../src/backoff.ts'
import type { PersonaConfig } from '../../src/config.ts'
import { _resetOutageState, initOutageState } from '../../src/outage-state.ts'
import { _resetRestartState, initRestart, type RestartDeps } from '../../src/restart.ts'
import {
  _resetFindMissingMemo,
  _resetTmuxServerEnsurer,
  _resetTmuxSessionKiller,
  _setTmuxServerEnsurer,
  _setTmuxSessionKiller,
  setSessionNotifier,
  spawnForPersona,
  whenLaunchSettled,
  type SpawnPersonaResult,
} from '../../src/session-manager.ts'
import {
  createUnavailableRetryController,
  type UnavailableRetryAction,
  type UnavailableRetryTriggerSink,
  type UnavailableRetryController,
  type UnavailableRetryOutcome,
} from '../../src/unavailable-retry.ts'
import { writeAgentDirectorConfig, type AdConfigInput } from './ad-settings.ts'
import {
  installStubSpawnPath,
  resetStubSpawnPath,
  type StubCallLog,
  type StubClientOptions,
  type StubSpawnPath,
} from './agent-director-stub.ts'
import { writtenFile } from './credentials.ts'
import { createFakeClock, type FakeClock } from './fake-clock.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './persona-config.ts'

/** Clock flushes `advance` waits at most for the in-flight retry runs, before and after each firing. */
const DEFAULT_SETTLE_FLUSHES = 20

/** How long `settle` waits at most for the launches in flight, in real ms (1 ms steps). */
const DEFAULT_SETTLE_MS = 2000

/** What the scripted action answers once a persona's queued outcomes run out: a refusal. */
const SCRIPTED_REFUSAL: UnavailableRetryOutcome = Object.freeze({ kind: 'again', cause: Object.freeze({ kind: 'unavailable' }) })

/** Options of `makeRecoveryHarness`; every one is optional. */
export interface RecoveryHarnessOptions {
  /** The retry action; the scripted action when unset. */
  action?: UnavailableRetryAction
  /** The personas (`makeMultiPersonaConfig` specs); two default personas when unset. */
  personas?: PersonaSpec[]
  /** `session_restart_delay` in seconds; 0 by default. */
  sessionRestartDelay?: number
  /** `health_check_interval` in seconds; 0 by default. */
  healthCheckInterval?: number
  /** agent-director's settings file, written under the temporary HOME; none (the defaults) when unset. */
  adSettings?: AdConfigInput
  /** Restart dependencies that replace the harness's stand-ins. */
  restartDeps?: Partial<RestartDeps>
  /** Clock flushes `advance` waits at most for in-flight runs; `DEFAULT_SETTLE_FLUSHES` when unset. */
  settleFlushes?: number
  /** Install the controller as the outage state's trigger sink (b.jg5 SRJ-301); true when unset. */
  triggerSink?: boolean
  /** Real ms `settle` waits at most for the launches in flight; `DEFAULT_SETTLE_MS` when unset. */
  settleMs?: number
}

/** The stub's answer knobs: every `StubClientOptions` field but the capture lists. */
export type RecoveryStubScript = Omit<StubClientOptions, keyof StubCallLog | 'callLog'>

/** One trigger the outage state sent to the sink: the persona key and the cause kind. */
export interface RecoveryTrigger {
  readonly key: string
  readonly kind: string
}

/** One retry the controller ran, as the action delegate saw it. */
export interface RecoveryAttempt {
  readonly key: string
  readonly retry: number
  readonly causes: readonly string[]
  /** The clock time the retry ran at, in ms. */
  readonly at: number
}

/** One notice, in the order it was sent. */
export interface RecoveryNotice {
  readonly key: string
  readonly text: string
}

/** What `makeRecoveryHarness` returns; see the module comment. */
export interface RecoveryHarness {
  readonly clock: FakeClock
  readonly controller: UnavailableRetryController
  readonly config: PersonaConfig
  readonly keys: readonly string[]
  readonly home: string
  readonly stateDir: string
  readonly stub: StubSpawnPath
  readonly lines: string[]
  readonly attempts: RecoveryAttempt[]
  readonly notices: RecoveryNotice[]
  readonly outageNotices: RecoveryNotice[]
  readonly triggers: RecoveryTrigger[]
  script(knobs: RecoveryStubScript): void
  launch(key: string): Promise<SpawnPersonaResult>
  settle(): Promise<void>
  answer(key: string, ...outcomes: UnavailableRetryOutcome[]): void
  setAction(action: UnavailableRetryAction | undefined): void
  startupErrors(): string[]
  settings(): AdSettingsInEffect
  advance(ms: number): Promise<number>
  captured(): Record<string, unknown>
  cleanup(): void
}

/** Build a recovery harness; see the module comment. Call `cleanup()` in `afterEach`. */
export function makeRecoveryHarness(options: RecoveryHarnessOptions = {}): RecoveryHarness {
  const root = mkdtempSync(join(tmpdir(), 'cscb-recovery-harness-'))
  const home = join(root, 'home')
  const stateDir = join(root, 'state')
  mkdirSync(home)
  mkdirSync(stateDir)

  const clock = createFakeClock()
  const lines: string[] = []
  const attempts: RecoveryAttempt[] = []
  const notices: RecoveryNotice[] = []
  const outageNotices: RecoveryNotice[] = []
  const triggers: RecoveryTrigger[] = []
  const settleFlushes = options.settleFlushes ?? DEFAULT_SETTLE_FLUSHES
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const log = (line: string): void => {
    lines.push(line)
  }

  const config = makeMultiPersonaConfig(options.personas ?? [{}, {}], root, {
    session_restart_delay: options.sessionRestartDelay ?? 0,
    health_check_interval: options.healthCheckInterval ?? 0,
  })
  const keys = config.personas.map((persona) => persona.key)
  for (const persona of config.personas) mkdirSync(persona.working_directory, { recursive: true })

  const queued = new Map<string, UnavailableRetryOutcome[]>()
  const scripted: UnavailableRetryAction = (key) => queued.get(key)?.shift() ?? SCRIPTED_REFUSAL
  let current: UnavailableRetryAction = options.action ?? scripted
  const controller = createUnavailableRetryController({
    log,
    clock,
    action: (key, attempt) => {
      attempts.push({ key, retry: attempt.retry, causes: attempt.causes, at: clock.now() })
      return current(key, attempt)
    },
  })

  const savedStateDir = process.env['SLACK_STATE_DIR']
  process.env['SLACK_STATE_DIR'] = stateDir

  const stub = installStubSpawnPath(home)
  _setTmuxSessionKiller(async () => {})
  _setTmuxServerEnsurer(async () => {})
  _resetFindMissingMemo()
  const triggerSink: UnavailableRetryTriggerSink = {
    arm(key, cause) {
      triggers.push({ key, kind: cause.kind })
      controller.arm(key, cause)
    },
  }
  _resetOutageState()
  initOutageState({
    notify: (key, text) => {
      outageNotices.push({ key, text })
    },
    getClient: () => stub.client as unknown as Client,
    ...(options.triggerSink === false ? {} : { triggerSink }),
  })
  setSessionNotifier((key, text) => {
    notices.push({ key, text })
  })

  resetAdSettingsForTests()
  if (options.adSettings !== undefined) writeAgentDirectorConfig(home, options.adSettings)
  installAdSettings({ home: () => home, log })

  _resetRestartState()
  _resetBackoffState()
  const configured = new Set(keys)
  initRestart({
    canRestart: (key) => configured.has(key),
    isSessionAlive: async () => false,
    isSessionConnected: () => false,
    hasSessionStream: () => false,
    reconnectSession: async () => 'transient',
    killSession: async () => {},
    launchSession: async () => 'skipped',
    getRestartDelay: () => config.session_restart_delay,
    isShuttingDown: () => false,
    onCapReached: () => {},
    ...options.restartDeps,
  })

  /** Every key a run may be in flight for: the configured, the armed and those a retry ran for. */
  function runKeys(): string[] {
    return [...new Set([...keys, ...controller.armedKeys(), ...attempts.map((a) => a.key)])]
  }

  /** Await every in-flight retry run, for at most `settleFlushes` clock flushes. */
  async function settleRuns(): Promise<void> {
    let settled = false
    const all = Promise.all(runKeys().map((key) => controller.whenRunSettled(key))).then(() => {
      settled = true
    })
    for (let flushes = 0; flushes < settleFlushes && !settled; flushes++) await clock.flush()
    void all
  }

  /** Await every configured persona's launch in flight, in 1 ms real-time steps, for at most `settleMs`. */
  async function settleLaunches(): Promise<void> {
    let settled = false
    const all = Promise.all(keys.map((key) => whenLaunchSettled(key))).then(() => {
      settled = true
    })
    for (let waited = 0; waited < settleMs && !settled; waited++) {
      await Promise.race([all, new Promise((resolve) => setTimeout(resolve, 1))])
    }
    if (!settled) throw new Error(`recovery harness: a launch was still in flight after ${settleMs} ms`)
  }

  function startupErrors(): string[] {
    const path = join(stateDir, 'startup-errors.log')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8').split('\n').filter((line) => line !== '')
  }

  return {
    clock,
    controller,
    config,
    keys,
    home,
    stateDir,
    stub,
    lines,
    attempts,
    notices,
    outageNotices,
    triggers,

    script(knobs) {
      // The installed stub reads its knobs, at each call, from the object it
      // records its calls in. Non-enumerable, so `callCount` and a comparison
      // of `stub.calls` still see only the capture lists.
      for (const [name, value] of Object.entries(knobs)) {
        Object.defineProperty(stub.calls, name, { value, writable: true, configurable: true, enumerable: false })
      }
    },

    launch(key) {
      const persona = config.personas.find((p) => p.key === key)
      if (persona === undefined) throw new Error(`recovery harness: no configured persona ${JSON.stringify(key)}`)
      return spawnForPersona(persona, config, true)
    },

    settle: settleLaunches,

    answer(key, ...outcomes) {
      queued.set(key, [...(queued.get(key) ?? []), ...outcomes])
    },

    setAction(action) {
      current = action ?? scripted
    },

    startupErrors,

    settings: () => adSettingsInEffect(),

    async advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`recovery harness: advance needs a finite, non-negative ms, got ${ms}`)
      const target = clock.now() + ms
      let fired = 0
      await settleRuns()
      for (let next = clock.pending()[0]; next !== undefined && next.dueAt <= target; next = clock.pending()[0]) {
        fired += await clock.advanceTo(next.dueAt)
        await settleRuns()
      }
      await clock.advanceTo(target)
      return fired
    },

    captured: () => ({
      lines: [...lines],
      notices: [...notices],
      outageNotices: [...outageNotices],
      startupErrors: startupErrors(),
      attempts: [...attempts],
      triggers: [...triggers],
      stateDir: writtenFile(stateDir),
    }),

    cleanup() {
      controller.stopAll('the recovery harness is cleaned up')
      const pendingTimers = clock.pendingCount()
      const armed = controller.armedKeys()
      _resetRestartState()
      _resetBackoffState()
      _resetOutageState()
      setSessionNotifier(undefined)
      resetStubSpawnPath()
      _resetTmuxSessionKiller()
      _resetTmuxServerEnsurer()
      _resetFindMissingMemo()
      resetAdSettingsForTests()
      if (savedStateDir === undefined) delete process.env['SLACK_STATE_DIR']
      else process.env['SLACK_STATE_DIR'] = savedStateDir
      rmSync(root, { recursive: true, force: true })
      if (pendingTimers !== 0 || armed.length !== 0) {
        throw new Error(
          `recovery harness: ${pendingTimers} timer(s) still pending and ${armed.length} persona(s) still armed after stopAll`,
        )
      }
    },
  }
}
