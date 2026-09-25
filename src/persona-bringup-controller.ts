/**
 * persona-bringup-controller.ts — Per-persona bring-up outcomes and retries
 * (b.av2 SR-6.1 outcomes, SR-6.4, SR-7.2 part, SR-10.3 part, SR-13.1).
 *
 * `createPersonaBringUpController(deps)` runs the SR-6.1 procedure of
 * `persona-start.ts` (steps 1–2 `checkPersonaLocalSteps`, step 3
 * `connectPersonaSlack`) for each applied persona and keeps, per persona, a
 * definite outcome:
 *
 * - `up`: steps 1–3 passed (credentials check, working-directory check, Slack
 *   validation and connection). The launch (step 4) is the caller's at start
 *   (the start pass's worker pool); after a retry succeeds the controller
 *   launches the persona itself through the injected `launch`, which joins a
 *   launch already in flight for the persona (`spawnForPersona`). A launch
 *   failure is not a new outcome: it takes today's spawn-failure path.
 * - `broken` (credentials-broken): the credentials file is missing,
 *   unreadable or locally invalid, or Slack refused a token (at bring-up, or
 *   on a reopen of a running persona, whose instance is left running). Not
 *   retried: recovery through a confirmed change is E13's.
 * - `retrying`: Slack-unreachable (retried by the connection manager on its
 *   own per-persona timer, the SR-3.2 schedule) or directory-broken.
 *
 * Causes are kept apart (credentials, directory, Slack). A persona with both
 * a credentials cause and a directory cause is `broken`; its directory is
 * still re-checked on its own timer and logs its start and cleared lines, but
 * nothing moves on to Slack or the launch while the credentials cause holds.
 *
 * Directory-broken (SR-6.4): no Slack connection is opened. The directory is
 * re-checked on the persona's own timer on the SR-3.2 schedule
 * (`createPersonaRetrySchedule`: 5 s doubling to 300 s, no cap), outside the
 * restart failure counter and cap. Once it is usable the bring-up continues
 * with no confirmation: Slack validation with the held credentials, then the
 * launch. If Slack is then unreachable the persona is Slack-unreachable
 * retrying.
 *
 * Held credentials (SR-6.1): the tokens read at the persona's first bring-up
 * are kept in the persona's entry and handed to the manager when a directory
 * retry reaches Slack; the credentials file is never read again by a retry,
 * so an edit made meanwhile is not used (it is E11's pending change). The
 * manager itself keeps the same tokens for its own retries and reopens. The
 * tokens are never logged, returned or written, and no query exposes them.
 * Beside them the entry holds the digest of the bytes that first read
 * produced, or a missing/unreadable marker (b.av2 SR-8.3); the read-only
 * `credentialsDigest(key)` query exposes only that, for the reload
 * detection tick. A persona broken by a shared credentials file holds the
 * digest of its own file too (read only to be hashed, never parsed), so once
 * the collision is gone a re-save of that file makes a change pending.
 *
 * Launch on recovery: a persona launches from its own retry path, never
 * waiting for the health check: after a directory retry whose Slack step
 * reports `up`, or when the manager reports `up` right after `retrying` a
 * bring-up (`onConnectionStatus`, the manager's status listener). An `up`
 * after `lost` or after `retrying` a reopen launches nothing: the instance is
 * already running. At most one such launch per persona.
 *
 * Leaving up (SR-6.3, SR-6.4): each time a persona's outcome changes from
 * `up` to `broken` or `retrying` (today only a refused reopen of a running
 * persona), the injected `onLeftUp` is told once. A lost connection being
 * reopened (`lost`, `retrying` a reopen) stays `up`. Production wires
 * `createNotUpSessionDropper`, which drops the persona's registered MCP
 * session; its instance and agent-director row are kept.
 * `describePersonaNotUp` renders a state's outcome and cause for the not-up
 * refusal and drop lines.
 *
 * Logging (SR-10.3): one `persona-start` line per persona when its bring-up
 * starts, before its outcome lines:
 *
 *   [slack] persona-start: personas[<i>] "<name>" (key=<key>): bring-up starting
 *
 * A credentials cause is logged once, when it starts (its check's line). A
 * directory cause is logged once when it starts (its check's line, class
 * `persona-directory-missing` / `-unusable`) and once when it clears, with
 * the class that opened it:
 *
 *   [slack] persona-directory-missing: personas[<i>] "<name>" (key=<key>) path="<dir>": cleared: working directory is usable again; continuing the bring-up
 *
 * (`…; the persona stays broken until its credentials are fixed and the server is restarted` while a
 * credentials cause holds). A change of class between attempts is the same
 * episode and logs nothing. Slack-unreachable start and clear lines come from
 * the connection manager only. A launch after a retry logs:
 *
 *   [slack] persona "<name>" (key=<key>): up after its bring-up retry (<directory|Slack>) — launching
 *
 * Lines go through the injected logger only (the `[slack]` server log), never
 * `startup-errors.log`, and nothing here posts to Slack.
 *
 * Dry run (SR-3.4): no credentials file is read and no Slack call is made
 * (the manager reports every persona up); the directory check and its retry
 * run as in a real start.
 *
 * Isolation (SR-3.3, SR-6.6): each persona's state, timer and in-flight flag
 * live in its own entry; nothing spans two personas, and a directory retry is
 * scheduled only once the previous one has finished, so attempts never
 * overlap.
 *
 * Pure module (b.av2 SR-13.1): nothing is created, read or scheduled at
 * import or at `createPersonaBringUpController`. The clock, logger, checks,
 * file-system seam, connection manager, launch and leaving-up listener are
 * injected.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Persona } from './config.ts'
import { checkPersonaWorkingDirectory } from './persona-bringup.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import {
  SYSTEM_PERSONA_CONNECTION_CLOCK,
  type PersonaConnectionClock,
  type PersonaConnectionManager,
  type PersonaConnectionStatus,
} from './persona-connections.ts'
import type { CredentialsDigest, PersonaSlackTokens } from './persona-credentials.ts'
import {
  PERSONA_START,
  formatPersonaDiagnostic,
  type PersonaCheckFailure,
  type PersonaDiagnosticLogger,
} from './persona-diagnostics.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { createPersonaRetrySchedule, type PersonaRetrySchedule } from './persona-retry-schedule.ts'
import {
  checkPersonaLocalSteps,
  connectPersonaSlack,
  personaSlackStatusFailure,
  type PersonaBringUpFailure,
  type PersonaConnectDeps,
} from './persona-start.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A bring-up outcome (b.av2 SR-6.1). */
export type PersonaBringUpOutcome = 'up' | 'broken' | 'retrying'

/** A persona's current causes, one per kind; absent when that kind has none. */
export interface PersonaBringUpCauses {
  credentials?: PersonaBringUpFailure
  directory?: PersonaBringUpFailure
  slack?: PersonaBringUpFailure
}

/** A persona's bring-up state, as the controller reports it. Never holds a token. */
export interface PersonaBringUpState {
  /** The outcome; undefined while the first Slack attempt is in flight. */
  outcome: PersonaBringUpOutcome | undefined
  causes: PersonaBringUpCauses
}

/** What one bring-up resolves with: its outcome and every current cause, credentials first. */
export interface PersonaBringUpResultSummary {
  outcome: PersonaBringUpOutcome
  failures: PersonaBringUpFailure[]
}

/** Dependencies of `createPersonaBringUpController`. */
export interface PersonaBringUpControllerDeps
  extends Pick<PersonaConnectDeps, 'dryRun' | 'log' | 'checkLocal' | 'checkDirectory' | 'fs'> {
  /** The connection manager: step 3, and the Slack side of each persona's outcome. */
  connections: Pick<PersonaConnectionManager, 'bringUp' | 'status'>
  /**
   * Launch a persona that reached `up` through a retry: the persona launch
   * path, which joins a launch already in flight for it. Its result is not
   * inspected; a throw or rejection is logged.
   */
  launch: (persona: Persona) => Promise<unknown>
  /**
   * Told once each time a persona's outcome changes from `up` to `broken` or
   * `retrying` (b.av2 SR-6.3, SR-6.4), with the persona and its new state.
   * A persona that was never up is never reported; a lost connection being
   * reopened stays `up` and is not reported. A throw or rejection is logged.
   * Production drops the persona's registered MCP session
   * (`createNotUpSessionDropper`).
   */
  onLeftUp?: (persona: Persona, state: PersonaBringUpState) => unknown
  /** Clock and timers for the directory re-checks; default the real clock. */
  clock?: PersonaConnectionClock
}

/** The controller handle. */
export interface PersonaBringUpController {
  /**
   * Bring one persona up (steps 1–3): log its `persona-start` line, run the
   * local checks, then Slack when both pass. Resolves once the persona has an
   * outcome; retries continue on the persona's own timers. Launches nothing
   * (the caller launches an `up` persona). A persona already known is left as
   * it is and its current result returned.
   */
  bringUp(persona: Persona, applied: readonly Persona[]): Promise<PersonaBringUpResultSummary>
  /** The connection manager's status listener: launches a persona that reached `up` from `retrying` its bring-up. */
  onConnectionStatus(key: string, status: PersonaConnectionStatus): void
  /** Whether the persona's outcome is `up`. False for an unknown or cancelled persona. */
  isUp(key: string): boolean
  /** The persona's outcome and causes, or undefined for an unknown or cancelled persona. */
  state(key: string): PersonaBringUpState | undefined
  /**
   * The digest or marker of the credentials bytes the persona's bring-up read
   * (b.av2 SR-8.3): what it connected with, is retrying with or broke with.
   * `sha256:<hex>`, or `CREDENTIALS_MISSING_MARKER` /
   * `CREDENTIALS_UNREADABLE_MARKER`. A persona broken by a credentials file
   * another applied persona shares holds the digest of its own file (hashed,
   * never parsed). Undefined when nothing is held: dry run (no file is read)
   * and an unknown or cancelled persona. Retries never re-read the file, so
   * it never changes. Read-only; never logged.
   */
  credentialsDigest(key: string): CredentialsDigest | undefined
  /** Stop one persona's retries and forget it; a retry already running does nothing more. Idempotent. */
  cancel(key: string): void
  /** Cancel every persona. */
  cancelAll(): void
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** A timer handle, boxed so any value the clock returns (even `undefined`) is a handle. */
interface TimerBox {
  handle: unknown
}

/** An open directory episode: the cause that opened it (for its cleared line) and the latest one. */
interface DirectoryEpisode {
  readonly opened: PersonaCheckFailure
  latest: PersonaCheckFailure
}

/** Everything the controller holds for one persona. Nothing here is shared with another persona. */
interface BringUpEntry {
  readonly persona: Persona
  /** The applied personas at bring-up, for the directory collision rule on re-checks. */
  readonly applied: readonly Persona[]
  /** Step 1's tokens from the first read; undefined in dry run or when step 1 failed. Never logged. */
  readonly tokens: PersonaSlackTokens | undefined
  /** Step 1's failure; cleared only by E13's confirmed change. */
  readonly credentials: PersonaCheckFailure | undefined
  /** The digest or marker of the bytes step 1 read (a collision included); undefined in dry run, where none are read. Never logged. */
  readonly credentialsDigest: CredentialsDigest | undefined
  directory: DirectoryEpisode | undefined
  readonly directorySchedule: PersonaRetrySchedule
  directoryTimer: TimerBox | undefined
  /** Set once step 3 was handed to the manager: the Slack side is then the manager's status. */
  slackStarted: boolean
  /** Step 3 threw (a programming error): broken, not retried. */
  slackError: PersonaBringUpFailure | undefined
  /** The last status the manager reported, for the retrying → up transition. */
  lastStatus: PersonaConnectionStatus | undefined
  /** Set once a launch after a retry was started. */
  retryLaunched: boolean
  /** Whether the outcome was `up` when last observed, for the up → not-up notification. */
  wasUp: boolean
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cause of the `persona-start` line. */
const PERSONA_START_CAUSE = 'bring-up starting'

/** Cause of a directory cleared line, by whether the credentials cause still holds. */
const DIRECTORY_CLEARED_CONTINUING = 'cleared: working directory is usable again; continuing the bring-up'
const DIRECTORY_CLEARED_STILL_BROKEN =
  'cleared: working directory is usable again; the persona stays broken until its credentials are fixed and the server is restarted'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create the bring-up controller. Creates, reads and schedules nothing until `bringUp`. */
export function createPersonaBringUpController(deps: PersonaBringUpControllerDeps): PersonaBringUpController {
  const { connections } = deps
  const clock = deps.clock ?? SYSTEM_PERSONA_CONNECTION_CLOCK
  const checkDirectory = deps.checkDirectory ?? checkPersonaWorkingDirectory
  const entries = new Map<string, BringUpEntry>()

  function log(line: string): void {
    try {
      deps.log(line)
    } catch {
      /* a failing logger must not stop a persona's bring-up */
    }
  }

  function ref(entry: BringUpEntry): string {
    return renderPersonaRef(entry.persona.name, entry.persona.key)
  }

  // -------------------------------------------------------------------------
  // Outcome
  // -------------------------------------------------------------------------

  /** The Slack side of an outcome, from the manager's status. */
  function slackOutcome(status: PersonaConnectionStatus | undefined): PersonaBringUpOutcome | undefined {
    if (status === undefined) return undefined
    switch (status.state) {
      case 'up':
      case 'lost':
        return 'up'
      case 'retrying':
        return status.phase === 'reopen' ? 'up' : 'retrying'
      case 'broken':
        return 'broken'
      default:
        return undefined
    }
  }

  function outcomeOf(entry: BringUpEntry): PersonaBringUpOutcome | undefined {
    if (entry.credentials) return 'broken'
    if (entry.directory) return 'retrying'
    if (entry.slackError) return 'broken'
    if (!entry.slackStarted) return undefined
    return slackOutcome(connections.status(entry.persona.key))
  }

  function causesOf(entry: BringUpEntry): PersonaBringUpCauses {
    const causes: PersonaBringUpCauses = {}
    if (entry.credentials) {
      causes.credentials = { step: 'credentials', class: entry.credentials.class, cause: entry.credentials.cause }
    }
    if (entry.directory) {
      const { latest } = entry.directory
      causes.directory = { step: 'working-directory', class: latest.class, cause: latest.cause }
    }
    if (entry.slackError) {
      causes.slack = entry.slackError
    } else if (entry.slackStarted) {
      // Retrying its bring-up, broken or stopped: the manager's outcome is the cause.
      const status = connections.status(entry.persona.key)
      if (status !== undefined && status.state !== 'up' && status.state !== 'connecting' && slackOutcome(status) !== 'up') {
        causes.slack = personaSlackStatusFailure(status)
      }
    }
    return causes
  }

  function summary(entry: BringUpEntry): PersonaBringUpResultSummary {
    const causes = causesOf(entry)
    const failures = [causes.credentials, causes.directory, causes.slack].filter(
      (f): f is PersonaBringUpFailure => f !== undefined,
    )
    // A persona the manager stopped during its bring-up is not up and is not retried.
    return { outcome: outcomeOf(entry) ?? 'broken', failures }
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /** Step 3 with the held tokens. The manager logs every Slack outcome itself. */
  async function connectSlack(entry: BringUpEntry): Promise<void> {
    entry.slackStarted = true
    const result = await connectPersonaSlack(entry.persona, entry.tokens, { connections, log })
    if ('failure' in result) entry.slackError = result.failure
    observeOutcome(entry)
  }

  // -------------------------------------------------------------------------
  // Leaving up (b.av2 SR-6.3, SR-6.4)
  // -------------------------------------------------------------------------

  /**
   * Record whether the persona is up now; on a change from `up` to `broken`
   * or `retrying`, tell `onLeftUp` once. Any other change out of `up` (the
   * manager stopped the persona) only re-arms the record.
   */
  function observeOutcome(entry: BringUpEntry): void {
    if (entry.cancelled) return
    const outcome = outcomeOf(entry)
    if (outcome === 'up') {
      entry.wasUp = true
      return
    }
    if (!entry.wasUp) return
    entry.wasUp = false
    if (outcome === 'broken' || outcome === 'retrying') notifyLeftUp(entry, outcome)
  }

  function notifyLeftUp(entry: BringUpEntry, outcome: PersonaBringUpOutcome): void {
    const listener = deps.onLeftUp
    if (listener === undefined) return
    const failed = (err: unknown) =>
      log(`[slack] persona ${ref(entry)}: handling its change from up to ${outcome} failed: ${describeThrownValue(err)}`)
    try {
      Promise.resolve(listener(entry.persona, { outcome, causes: causesOf(entry) })).catch(failed)
    } catch (err) {
      failed(err)
    }
  }

  /** Launch after a retry, at most once per persona; a throw is logged, never posted. */
  function launchAfterRetry(entry: BringUpEntry, via: 'directory' | 'Slack'): void {
    if (entry.cancelled || entry.retryLaunched) return
    entry.retryLaunched = true
    log(`[slack] persona ${ref(entry)}: up after its bring-up retry (${via}) — launching`)
    void (async () => {
      try {
        await deps.launch(entry.persona)
      } catch (err) {
        log(`[slack] persona ${ref(entry)}: launch after its bring-up retry failed: ${describeThrownValue(err)}`)
      }
    })()
  }

  // -------------------------------------------------------------------------
  // Directory retry (SR-6.4)
  // -------------------------------------------------------------------------

  function scheduleDirectoryRecheck(entry: BringUpEntry): void {
    if (entry.cancelled) return
    clearDirectoryTimer(entry)
    const timer: TimerBox = { handle: undefined }
    entry.directoryTimer = timer
    timer.handle = clock.setTimeout(() => {
      if (entry.directoryTimer !== timer) return
      entry.directoryTimer = undefined
      recheckDirectory(entry).catch((err) =>
        log(`[slack] persona ${ref(entry)}: working-directory retry failed: ${describeThrownValue(err)}`),
      )
    }, entry.directorySchedule.nextDelayMs())
  }

  function clearDirectoryTimer(entry: BringUpEntry): void {
    const timer = entry.directoryTimer
    if (timer === undefined) return
    entry.directoryTimer = undefined
    clock.clearTimeout(timer.handle)
  }

  /** One re-check: still broken → the next one on the schedule; usable → cleared line, then Slack and the launch. */
  async function recheckDirectory(entry: BringUpEntry): Promise<void> {
    const episode = entry.directory
    if (entry.cancelled || episode === undefined) return
    const result = checkDirectory(entry.persona, { others: entry.applied, fs: deps.fs })
    if (!result.ok) {
      episode.latest = result
      scheduleDirectoryRecheck(entry)
      return
    }

    entry.directory = undefined
    const { opened } = episode
    log(formatPersonaDiagnostic({
      class: opened.class,
      name: entry.persona.name,
      key: entry.persona.key,
      index: entry.persona.index,
      path: opened.path,
      cause: entry.credentials ? DIRECTORY_CLEARED_STILL_BROKEN : DIRECTORY_CLEARED_CONTINUING,
    }))
    if (entry.credentials) return

    await connectSlack(entry)
    if (entry.cancelled) return
    // The same mapping as the outcome: `lost` or `retrying` a reopen right
    // after the manager reported up still counts as up.
    if (outcomeOf(entry) === 'up') launchAfterRetry(entry, 'directory')
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  async function bringUp(persona: Persona, applied: readonly Persona[]): Promise<PersonaBringUpResultSummary> {
    const existing = entries.get(persona.key)
    if (existing !== undefined) return summary(existing)

    log(formatPersonaDiagnostic({
      class: PERSONA_START,
      name: persona.name,
      key: persona.key,
      index: persona.index,
      cause: PERSONA_START_CAUSE,
    }))

    // Steps 1 and 2 without a logger: each cause's line is logged once, here.
    const local = checkPersonaLocalSteps(persona, {
      applied,
      dryRun: deps.dryRun,
      checkLocal: deps.checkLocal,
      checkDirectory: deps.checkDirectory,
      fs: deps.fs,
    })
    const entry: BringUpEntry = {
      persona,
      applied,
      tokens: local.tokens,
      credentials: local.credentials,
      credentialsDigest: local.credentialsDigest,
      directory: local.directory ? { opened: local.directory, latest: local.directory } : undefined,
      directorySchedule: createPersonaRetrySchedule(),
      directoryTimer: undefined,
      slackStarted: false,
      slackError: undefined,
      lastStatus: undefined,
      retryLaunched: false,
      wasUp: false,
      cancelled: false,
    }
    entries.set(persona.key, entry)

    if (local.credentials) log(local.credentials.line)
    if (local.directory) {
      log(local.directory.line)
      scheduleDirectoryRecheck(entry)
    }
    if (local.credentials || local.directory) return summary(entry)

    await connectSlack(entry)
    return summary(entry)
  }

  function onConnectionStatus(key: string, status: PersonaConnectionStatus): void {
    const entry = entries.get(key)
    if (entry === undefined) return
    const previous = entry.lastStatus
    entry.lastStatus = status
    if (status.state === 'up' && previous?.state === 'retrying' && previous.phase === 'bring-up') {
      launchAfterRetry(entry, 'Slack')
    }
    observeOutcome(entry)
  }

  function cancel(key: string): void {
    const entry = entries.get(key)
    if (entry === undefined) return
    entries.delete(key)
    entry.cancelled = true
    clearDirectoryTimer(entry)
  }

  return {
    bringUp,
    onConnectionStatus,
    isUp: (key) => {
      const entry = entries.get(key)
      return entry !== undefined && outcomeOf(entry) === 'up'
    },
    state: (key) => {
      const entry = entries.get(key)
      return entry === undefined ? undefined : { outcome: outcomeOf(entry), causes: causesOf(entry) }
    },
    credentialsDigest: (key) => entries.get(key)?.credentialsDigest,
    cancel,
    cancelAll: () => {
      for (const key of [...entries.keys()]) cancel(key)
    },
  }
}

// ---------------------------------------------------------------------------
// Not-up descriptions and the session drop (b.av2 SR-6.3, SR-6.4)
// ---------------------------------------------------------------------------

/**
 * Why a persona is not up, for a log line: its outcome and its first cause
 * (credentials, then directory, then Slack), e.g. `broken: <cause>`. Uses the
 * token-free cause text only, never a diagnostic class label. Pure.
 */
export function describePersonaNotUp(state: PersonaBringUpState | undefined): string {
  if (state === undefined) return 'its bring-up has not run'
  if (state.outcome === undefined || state.outcome === 'up') return 'its Slack connection is not serving'
  const cause = state.causes.credentials ?? state.causes.directory ?? state.causes.slack
  return cause === undefined ? state.outcome : `${state.outcome}: ${cause.cause}`
}

/** Dependencies of `createNotUpSessionDropper`. */
export interface NotUpSessionDropperDeps {
  /**
   * Drop the MCP session registered for a persona key (`dropPersonaSession`
   * in `registry.ts`); resolves whether one was registered.
   */
  drop: (key: string) => Promise<boolean>
  log: PersonaDiagnosticLogger
}

/**
 * Build the controller's `onLeftUp` listener: drop the MCP session registered
 * for the persona that stopped being up (b.av2 SR-6.3: a session is
 * registered only while its persona is up) and log one line when a session
 * was dropped:
 *
 *   [slack] persona "<name>" (key=<key>): MCP session dropped — the persona is not up (<outcome>: <cause>); its instance and agent-director row are kept
 *
 * Makes no agent-director call, schedules no restart and posts nothing to
 * Slack; the instance registers again once the persona is up.
 */
export function createNotUpSessionDropper(
  deps: NotUpSessionDropperDeps,
): (persona: Pick<Persona, 'name' | 'key'>, state: PersonaBringUpState) => Promise<void> {
  return async (persona, state) => {
    if (!(await deps.drop(persona.key))) return
    deps.log(
      `[slack] persona ${renderPersonaRef(persona.name, persona.key)}: MCP session dropped — ` +
        `the persona is not up (${describePersonaNotUp(state)}); its instance and agent-director row are kept`,
    )
  }
}
