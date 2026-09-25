/**
 * persona-start.ts — The per-persona start procedure (b.av2 SR-6.1) and the
 * seams the server reads each persona's connection through (SR-3.1, SR-3.4,
 * SR-7.2).
 *
 * The start procedure brings one persona up, in order:
 *
 *   1. the local credentials check (`checkPersonaCredentials`), skipped in dry
 *      run, where no credentials file is read (SR-3.4);
 *   2. the working-directory check (`checkPersonaWorkingDirectory`), in dry run
 *      and in a real start alike. Steps 1 and 2 are both evaluated before
 *      either stops the bring-up, so both causes are reported;
 *   3. Slack validation and connection: the connection manager's `bringUp`,
 *      handed the tokens from step 1 (none in dry run);
 *   4. launch, only when step 3 reports the persona `up`.
 *
 * This module exports each step on its own (`checkPersonaLocalSteps` for
 * steps 1–2, `connectPersonaSlack` for step 3, `personaSlackStatusFailure`
 * for a step-3 status other than `up`). The server's start runs them through
 * the bring-up controller (`persona-bringup-controller.ts`), which orders
 * them, gives every persona an outcome (up, broken or retrying), holds the
 * credentials read at the first bring-up for the persona's retries,
 * re-checks a broken working directory on its own timer and launches a
 * persona that is up, including one that reaches up through a retry.
 *
 * A failure at steps 1–3 ends the bring-up without a launch. Steps 1–2
 * failures are logged by E2's checks through the injected logger; Slack
 * failures are logged only by the connection manager, so this module adds no
 * line for them. Nothing here posts to Slack, records a
 * startup error or counts a failed spawn. Neither the health check nor a
 * restart touches a persona whose connection is not serving or whose
 * outcome is not up (see `createPersonaRelaunchGate`).
 *
 * A launch failure (step 4) is the launch function's own: today's
 * spawn-failure path, unchanged.
 *
 * The persona's tokens exist only in memory for the call and in the manager
 * (for its retries). They are never logged, returned or written.
 *
 * Connection seams, built over the manager and the applied-config getter:
 * - `createPersonaClientLookup` (`clientFor`): the persona's long-lived Web
 *   API client while it is serving (`isPersonaClientServing`: `up`, `lost`,
 *   and `retrying` a reopen; the Web API does not need the socket); nothing
 *   while it is connecting, retrying its bring-up, broken or stopped, for an
 *   unknown key, and always in dry run (the manager builds no client there).
 * - `createPersonaIdentityLookup`: the persona's bot identity while it is
 *   serving; the placeholder identity (`U000DRY_<key>`) in dry run.
 * - `createPersonaUpFlushListener`: the manager's status listener; each time
 *   a persona reports `up` (after bring-up or a reopen) the notifier flushes
 *   that persona's held notices, and no other persona's (SR-7.2).
 * - `composePersonaStatusListeners`: several status listeners as the
 *   manager's one (the up-flush listener and the bring-up controller's).
 * - `createPersonaUpPredicate`: whether a persona is up (serving, and its
 *   bring-up outcome is `up`); the one check behind the relaunch gate (which
 *   decides through the same check over its single status read) and every
 *   not-up refusal (MCP session admission, the permission poller's skip,
 *   `/interject`'s 503). Logs nothing.
 * - `createPersonaRelaunchGate`: whether a persona may be relaunched (health
 *   check work list, restart, restart launch): only while it is serving and,
 *   given the bring-up controller, up.
 *
 * Side-effect free (b.av2 SR-13.1): importing this module creates no client,
 * reads no file, environment variable or token and starts no timer. Every
 * dependency is injected.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'

import type { Persona } from './config.ts'
import {
  checkPersonaLocalBringUp,
  checkPersonaWorkingDirectory,
  type PersonaBringUpFs,
} from './persona-bringup.ts'
import type {
  PersonaConnectionManager,
  PersonaConnectionStatus,
  PersonaStatusListener,
} from './persona-connections.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import type { CredentialsDigest, PersonaSlackTokens } from './persona-credentials.ts'
import type { PersonaCheckFailure, PersonaDiagnosticLogger } from './persona-diagnostics.ts'
import { renderPersonaRef } from './persona-identity.ts'
import type { PersonaNotifier } from './persona-notifier.ts'
import type { SlackBotIdentity } from './persona-slack-validation.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The bring-up step that failed. `claude-config-dir` is the check of the
 * persona's claude_config_dir (bug b.g57), right before step 3 and before
 * every launch, which holds the persona `retrying`, with no Slack
 * connection, until the directory resolves.
 */
export type PersonaBringUpStep = 'credentials' | 'working-directory' | 'slack' | 'claude-config-dir'

/** One failed bring-up step: its diagnostic class (or connection state) and its token-free cause. */
export interface PersonaBringUpFailure {
  step: PersonaBringUpStep
  /** The persona diagnostic class, or for a Slack step without one the connection state. */
  class: string
  /** Single-line cause; never a token value. */
  cause: string
}

/** Dependencies of steps 1–3 (`checkPersonaLocalSteps`, `connectPersonaSlack`). */
export interface PersonaConnectDeps {
  /** Every applied persona, for the credentials and working-directory collision rules (the persona's own entry is skipped). */
  applied: readonly Persona[]
  /** Dry run (b.av2 SR-3.4): step 1 is skipped and step 3 is handed no tokens. */
  dryRun: boolean
  /** Receives step 1–2 failure lines (and a line if step 3 throws). */
  log: PersonaDiagnosticLogger
  /** The connection manager: step 3. */
  connections: Pick<PersonaConnectionManager, 'bringUp'>
  /** Steps 1 and 2 together; defaults to `checkPersonaLocalBringUp`. */
  checkLocal?: typeof checkPersonaLocalBringUp
  /** Step 2 alone, in dry run; defaults to `checkPersonaWorkingDirectory`. */
  checkDirectory?: typeof checkPersonaWorkingDirectory
  /** File-system overrides for steps 1 and 2; unset operations use the real file system. */
  fs?: Partial<PersonaBringUpFs>
}

/** What the connection seams read about the applied personas. */
export type AppliedPersonaKeysGetter = () => { personas: readonly Pick<Persona, 'key'>[] } | null | undefined

// ---------------------------------------------------------------------------
// Bring-up procedure (b.av2 SR-6.1)
// ---------------------------------------------------------------------------

/** Steps 1 and 2 of one bring-up, as `checkPersonaLocalSteps` reports them. */
export interface PersonaLocalStepsResult {
  /** Step 1's failure; never set in dry run, where step 1 is skipped. */
  credentials: PersonaCheckFailure | undefined
  /** Step 2's failure. */
  directory: PersonaCheckFailure | undefined
  /** Step 1's tokens when it passed; never in dry run. Held in memory only, never logged. */
  tokens: PersonaSlackTokens | undefined
  /**
   * The digest or marker of the credentials bytes step 1 read, whatever its
   * outcome (b.av2 SR-8.3), a real-path collision included (the file is then
   * only hashed, never parsed); undefined in dry run (nothing is read) and
   * when an injected `checkLocal` returns none. Held in memory only, never
   * logged.
   */
  credentialsDigest: CredentialsDigest | undefined
}

/**
 * Steps 1 and 2 for one persona: the local credentials check (skipped in dry
 * run, where no credentials file is read) and the working-directory check,
 * both evaluated. With `deps.log` each failure's line is emitted once; without
 * it nothing is emitted and each line is only returned on its failure. Makes
 * no Slack call. Never throws for string paths.
 */
export function checkPersonaLocalSteps(
  persona: Persona,
  deps: Pick<PersonaConnectDeps, 'applied' | 'dryRun' | 'checkLocal' | 'checkDirectory' | 'fs'> & {
    log?: PersonaDiagnosticLogger
  },
): PersonaLocalStepsResult {
  const checkOptions = { others: deps.applied, fs: deps.fs, log: deps.log }
  if (deps.dryRun) {
    const directory = (deps.checkDirectory ?? checkPersonaWorkingDirectory)(persona, checkOptions)
    return {
      credentials: undefined,
      directory: directory.ok ? undefined : directory,
      tokens: undefined,
      credentialsDigest: undefined,
    }
  }
  const local = (deps.checkLocal ?? checkPersonaLocalBringUp)(persona, checkOptions)
  return {
    credentials: local.credentials.ok ? undefined : local.credentials,
    directory: local.directory.ok ? undefined : local.directory,
    tokens: local.credentials.ok ? local.credentials.tokens : undefined,
    credentialsDigest: local.credentialsDigest,
  }
}

/**
 * Step 3 alone: hand the persona and its tokens (none in dry run) to the
 * connection manager's `bringUp`. Resolves with the status the manager
 * reports; the manager logs every Slack outcome itself. When `bringUp`
 * throws, one token-safe line is logged through `deps.log` and the result is
 * a `slack` failure of class `error`. Never throws except through a throwing
 * injected logger.
 */
export async function connectPersonaSlack(
  persona: Persona,
  tokens: PersonaSlackTokens | undefined,
  deps: Pick<PersonaConnectDeps, 'connections' | 'log'>,
): Promise<{ status: PersonaConnectionStatus } | { failure: PersonaBringUpFailure }> {
  try {
    return { status: await deps.connections.bringUp(persona, tokens) }
  } catch (err) {
    const cause = `Slack bring-up threw: ${describeThrownValue(err)}`
    deps.log(`[slack] persona ${renderPersonaRef(persona.name, persona.key)} not brought up: ${cause}`)
    return { failure: { step: 'slack', class: 'error', cause } }
  }
}

/** The step-3 failure for a status other than `up`: the outcome's class and cause when it has one. */
export function personaSlackStatusFailure(status: Exclude<PersonaConnectionStatus, { state: 'up' }>): PersonaBringUpFailure {
  switch (status.state) {
    case 'retrying':
    case 'broken':
      return { step: 'slack', class: status.outcome.class, cause: status.outcome.cause }
    case 'stopped':
      return { step: 'slack', class: 'stopped', cause: 'the persona was stopped during its bring-up' }
    default:
      return { step: 'slack', class: status.state, cause: `the connection is ${status.state}` }
  }
}

// ---------------------------------------------------------------------------
// Connection seams (b.av2 SR-3.1, SR-3.4, SR-7.2)
// ---------------------------------------------------------------------------

/**
 * Whether a persona in this connection status serves Web API calls: `up`,
 * `lost`, or `retrying` a reopen (a dropped socket does not stop the Web API).
 * Not while connecting, retrying its bring-up, broken (at bring-up, on a
 * reopen, or by a Web API call refused for its bot token), stopped,
 * or unmanaged. Whether a persona may be relaunched also needs its bring-up
 * outcome to be `up` (b.av2 SR-6.4; `createPersonaRelaunchGate`).
 */
export function isPersonaClientServing(status: PersonaConnectionStatus | undefined): boolean {
  if (status === undefined) return false
  switch (status.state) {
    case 'up':
    case 'lost':
      return true
    case 'retrying':
      return status.phase === 'reopen'
    default:
      return false
  }
}

/** Whether `key` is an applied persona's key right now. */
function isApplied(getPersonaConfig: AppliedPersonaKeysGetter, key: string): boolean {
  return getPersonaConfig()?.personas.some((p) => p.key === key) ?? false
}

/**
 * Build `clientFor(key)`: the persona's long-lived Web API client (the one the
 * manager built with `longLivedWebClientOptions()`) for an applied persona
 * that is serving (`isPersonaClientServing`); undefined otherwise, for an
 * unknown key, and always in dry run (the manager builds no client there).
 */
export function createPersonaClientLookup(
  connections: Pick<PersonaConnectionManager, 'status' | 'webClient'>,
  getPersonaConfig: AppliedPersonaKeysGetter,
): (key: string) => WebClient | undefined {
  return (key) => {
    if (!isApplied(getPersonaConfig, key)) return undefined
    if (!isPersonaClientServing(connections.status(key))) return undefined
    return connections.webClient(key)
  }
}

/**
 * Build the bot-identity lookup: the persona's bot user ID and bot ID for an
 * applied persona that is serving; the placeholder identity (`U000DRY_<key>` /
 * `B000DRY_<key>`) in dry run, where every brought-up persona is `up`;
 * undefined for a persona that is not serving and for an unknown key.
 */
export function createPersonaIdentityLookup(
  connections: Pick<PersonaConnectionManager, 'status' | 'identity'>,
  getPersonaConfig: AppliedPersonaKeysGetter,
): (key: string) => SlackBotIdentity | undefined {
  return (key) => {
    if (!isApplied(getPersonaConfig, key)) return undefined
    if (!isPersonaClientServing(connections.status(key))) return undefined
    return connections.identity(key)
  }
}

/**
 * Build the connection manager's status listener: on every transition of a
 * persona to `up` (its bring-up or a reopen) flush exactly that persona's held
 * notices (b.av2 SR-7.2); a no-op when none are held. Other statuses do
 * nothing. Returns the flush promise, which never rejects.
 */
export function createPersonaUpFlushListener(notifier: Pick<PersonaNotifier, 'flush'>): PersonaStatusListener {
  return (key, status) => (status.state === 'up' ? notifier.flush(key) : undefined)
}

/**
 * One status listener that hands every status change to each of `listeners`,
 * in order. Every listener is called, synchronously and in order, even when an
 * earlier one throws synchronously or returns a rejecting promise; the composed
 * call itself never throws. The returned promise waits until every listener's
 * result has settled, then rejects with the failure of the first listener (in
 * listener order, not in time) that threw or rejected, or resolves undefined
 * when none did (the connection manager logs a rejection token-safely).
 */
export function composePersonaStatusListeners(...listeners: PersonaStatusListener[]): PersonaStatusListener {
  return (key, status) => {
    const results = listeners.map((listener) => {
      try {
        return Promise.resolve(listener(key, status))
      } catch (err) {
        return Promise.reject(err)
      }
    })
    return Promise.allSettled(results).then((settled) => {
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failure) throw failure.reason
    })
  }
}

/** Whether a persona's bring-up outcome is `up`, and whether it is applied (the bring-up controller's queries). */
export interface PersonaUpQuery {
  isUp(key: string): boolean
  /**
   * Whether the key is in the applied persona set now (b.av2 SR-8.6: from a
   * confirmed apply's step 1 on, a key outside it is never launched or
   * restarted). Read live, never a snapshot. Production binds the bring-up
   * controller's `isApplied`; a query without it counts every key as applied.
   */
  isApplied?(key: string): boolean
}

/**
 * Build the "is this persona up" predicate (b.av2 SR-6.4): true while the
 * persona's connection is serving (`isPersonaClientServing`: `up`, `lost`, or
 * `retrying` a reopen; every brought-up persona is `up` in dry run), its
 * bring-up outcome is `up` and its key is applied (b.av2 SR-8.6); false
 * otherwise, including for a persona the manager or the controller does not
 * know. The single source for every
 * refusal of a persona that is not up: the relaunch gate, MCP session
 * admission (`decideSessionAdmission`), the permission poller's skip and
 * `/interject`'s 503. Logs nothing.
 */
export function createPersonaUpPredicate(
  connections: Pick<PersonaConnectionManager, 'status'>,
  outcomes: PersonaUpQuery,
): (key: string) => boolean {
  return (key) => isPersonaUpGiven(key, connections.status(key), outcomes)
}

/**
 * The up check itself, over a status already read: serving and, when
 * `outcomes` is given, bring-up outcome `up` and the key applied
 * (`isPersonaApplied`). `createPersonaUpPredicate` and
 * `createPersonaRelaunchGate` both decide through it, so the two cannot
 * drift; the gate reads the status once and reuses it to word its line.
 * The outcome and the applied set are asked only when the connection is
 * serving.
 */
function isPersonaUpGiven(
  key: string,
  status: PersonaConnectionStatus | undefined,
  outcomes: PersonaUpQuery | undefined,
): boolean {
  return (
    isPersonaClientServing(status) &&
    (outcomes === undefined || (outcomes.isUp(key) && isPersonaApplied(key, outcomes)))
  )
}

/** Whether `key` is in the applied set per `outcomes.isApplied`; every key is, without the query. */
function isPersonaApplied(key: string, outcomes: PersonaUpQuery | undefined): boolean {
  return outcomes?.isApplied === undefined || outcomes.isApplied(key)
}

/**
 * Build the relaunch gate: `canRelaunch(key)` is true while the persona's
 * connection is serving (`isPersonaClientServing`: `up`, `lost`, or
 * `retrying` a reopen; every brought-up persona is `up` in dry run) and, when
 * `outcomes` is given, its bring-up outcome is `up` (b.av2 SR-6.1, SR-6.4)
 * and its key is in the applied set (b.av2 SR-8.6: from a confirmed apply's
 * step 1 on, a removed persona is never launched or restarted, even while its
 * connection still serves until its teardown); false otherwise, including for
 * a persona the manager does not know (one that failed its credentials or
 * working-directory check). The health
 * check's work list, the restart module (`RestartDeps.canRestart`, before any
 * kill, reconnect or launch) and the restart launch (`launchSession`) all ask
 * it, so a persona that is broken or retrying, or whose connection is not
 * serving, is never touched by any of them; once it is up it is eligible
 * again.
 *
 * When it answers false it logs one line, once per persona per reason (a
 * repeat for the same reason is silent; being eligible again re-arms it).
 * While the connection is not serving:
 *
 *   [slack] persona=<key>: not relaunched — its Slack connection is <state>; eligible again once it is up
 *
 * `<state>` is `not brought up` (the manager does not know the persona),
 * `connecting`, `retrying its bring-up`, `broken` or `stopped`. While the
 * connection is serving but the bring-up outcome is not `up`:
 *
 *   [slack] persona=<key>: not relaunched — its bring-up has not succeeded; eligible again once it is up
 *
 * A key outside the applied set is refused first, whatever its status:
 *
 *   [slack] persona=<key>: not relaunched — it is no longer in the applied configuration
 *
 * The line carries only the key and the reason.
 */
export function createPersonaRelaunchGate(
  connections: Pick<PersonaConnectionManager, 'status'>,
  log: PersonaDiagnosticLogger,
  outcomes?: PersonaUpQuery,
): (key: string) => boolean {
  const lastLogged = new Map<string, string>()
  return (key) => {
    // The up predicate's check, over the one status read; the status is
    // reused below only to word the refusal line.
    const status = connections.status(key)
    if (isPersonaUpGiven(key, status, outcomes)) {
      lastLogged.delete(key)
      return true
    }
    // A removed persona: nothing more to wait for, so the line says so.
    if (!isPersonaApplied(key, outcomes)) {
      const reason = 'it is no longer in the applied configuration'
      if (lastLogged.get(key) !== reason) {
        lastLogged.set(key, reason)
        log(`[slack] persona=${key}: not relaunched — ${reason}`)
      }
      return false
    }
    // Serving, but the bring-up outcome is not `up` (unknown to the
    // controller, cancelled, broken or retrying there): the connection is
    // fine, so the line names the bring-up instead.
    const reason = isPersonaClientServing(status)
      ? 'its bring-up has not succeeded'
      : `its Slack connection is ${describeNotServing(status)}`
    if (lastLogged.get(key) !== reason) {
      lastLogged.set(key, reason)
      log(`[slack] persona=${key}: not relaunched — ${reason}; eligible again once it is up`)
    }
    return false
  }
}

/** A short, token-free name for a connection status that is not serving. */
function describeNotServing(status: PersonaConnectionStatus | undefined): string {
  if (status === undefined) return 'not brought up'
  switch (status.state) {
    case 'retrying':
      return status.phase === 'bring-up' ? 'retrying its bring-up' : 'retrying'
    case 'broken':
      return 'broken'
    default:
      return status.state
  }
}
