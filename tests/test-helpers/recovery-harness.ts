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
 *   (`initOutageState`) as its client.
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
 *   notice lists, the startup-errors entries, the attempts and the state
 *   directory as a written file.
 * - `cleanup()`: stops every retry timer (`stopAll`), then undoes every
 *   install and reset the harness made (the restart module and the failure
 *   counter, the outage state, the session notifier, the stub spawn path and
 *   client, the settings install, `SLACK_STATE_DIR`) and removes the
 *   temporary directory. It throws, after undoing everything, when a timer
 *   is still pending on the clock or a persona is still armed.
 *
 * Later work extends this harness in place (a trigger-sink install and a
 * launch driver, the real restart entry as the default action, and the
 * pending-row rule, the latch and the episodes).
 *
 * Isolation: no top-level `mock.module()`, no real HOME, `~/.agent-director`,
 * tmux or child process, and no real timer. Every file sits under one
 * `mkdtempSync` directory.
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
import { setSessionNotifier } from '../../src/session-manager.ts'
import {
  createUnavailableRetryController,
  type UnavailableRetryAction,
  type UnavailableRetryController,
  type UnavailableRetryOutcome,
} from '../../src/unavailable-retry.ts'
import { writeAgentDirectorConfig, type AdConfigInput } from './ad-settings.ts'
import { installStubSpawnPath, resetStubSpawnPath, type StubSpawnPath } from './agent-director-stub.ts'
import { writtenFile } from './credentials.ts'
import { createFakeClock, type FakeClock } from './fake-clock.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './persona-config.ts'

/** Clock flushes `advance` waits at most for the in-flight retry runs, before and after each firing. */
const DEFAULT_SETTLE_FLUSHES = 20

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
  const settleFlushes = options.settleFlushes ?? DEFAULT_SETTLE_FLUSHES
  const log = (line: string): void => {
    lines.push(line)
  }

  const config = makeMultiPersonaConfig(options.personas ?? [{}, {}], root, {
    session_restart_delay: options.sessionRestartDelay ?? 0,
    health_check_interval: options.healthCheckInterval ?? 0,
  })
  const keys = config.personas.map((persona) => persona.key)

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
  _resetOutageState()
  initOutageState({
    notify: (key, text) => {
      outageNotices.push({ key, text })
    },
    getClient: () => stub.client as unknown as Client,
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
