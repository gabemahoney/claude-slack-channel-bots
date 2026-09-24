/**
 * persona-start.ts — The per-persona start procedure (b.av2 SR-6.1) and the
 * seams the server reads each persona's connection through (SR-3.1, SR-3.4,
 * SR-7.2).
 *
 * `bringUpPersona` brings one persona up, in order:
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
 * Steps 1–3 are also available alone (`connectPersona`), so a caller can
 * bring every persona's connection up at once and limit only the launches
 * (`startupSessionManager` does).
 *
 * A failure at steps 1–3 ends the bring-up without a launch: the result says
 * the persona was not brought up, with each failing step, its class and its
 * cause. Steps 1–2 failures are logged by E2's checks through the injected
 * logger; Slack failures are logged only by the connection manager, so this
 * module adds no line for them. Nothing here posts to Slack, records a
 * startup error or counts a failed spawn. The start launches such a persona
 * no later; neither does a restart while its connection is not serving (see
 * `createPersonaRelaunchGate`). A persona whose first Slack attempt is
 * unreachable keeps being retried by the manager on its own timer; once it
 * reports `up` the gate lets it through, so the health check's next tick
 * finds it without a live session and relaunches it after the restart delay
 * (the first launch comes through that relaunch path). E5 adds a
 * launch-on-recovery and the up/broken/retrying outcomes.
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
 * - `createPersonaRelaunchGate`: whether a persona may be relaunched (health
 *   check work list, restart launch): only while it is serving.
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
import type { PersonaSlackTokens } from './persona-credentials.ts'
import type { PersonaDiagnosticLogger } from './persona-diagnostics.ts'
import { renderPersonaRef } from './persona-identity.ts'
import type { PersonaNotifier } from './persona-notifier.ts'
import type { SlackBotIdentity } from './persona-slack-validation.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The bring-up step that failed. */
export type PersonaBringUpStep = 'credentials' | 'working-directory' | 'slack'

/** One failed bring-up step: its diagnostic class (or connection state) and its token-free cause. */
export interface PersonaBringUpFailure {
  step: PersonaBringUpStep
  /** The persona diagnostic class, or for a Slack step without one the connection state. */
  class: string
  /** Single-line cause; never a token value. */
  cause: string
}

/** Outcome of `connectPersona` (steps 1–3). */
export type PersonaConnectResult =
  /** Steps 1–3 passed: the persona is `up` and may be launched. */
  | { outcome: 'connected' }
  /** A step 1–3 failed: not to be launched. Every failing step is listed, credentials first. */
  | { outcome: 'not-brought-up'; failures: PersonaBringUpFailure[] }

/** Outcome of `bringUpPersona`. */
export type PersonaBringUpResult<L> =
  /** Steps 1–3 passed and the persona was launched; `launch` is the launch function's result. */
  | { outcome: 'launched'; launch: L }
  /** A step 1–3 failed: not launched. Every failing step is listed, credentials first. */
  | { outcome: 'not-brought-up'; failures: PersonaBringUpFailure[] }

/** Dependencies of `connectPersona` (steps 1–3). */
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

/** Dependencies of `bringUpPersona`: steps 1–3's, plus the launch. */
export interface PersonaBringUpDeps<L> extends PersonaConnectDeps {
  /** Step 4: launch the persona (the persona spawn entry point). */
  launch: (persona: Persona) => Promise<L>
}

/** What the connection seams read about the applied personas. */
export type AppliedPersonaKeysGetter = () => { personas: readonly Pick<Persona, 'key'>[] } | null | undefined

// ---------------------------------------------------------------------------
// Bring-up procedure (b.av2 SR-6.1)
// ---------------------------------------------------------------------------

/**
 * Bring one persona up: steps 1–4 above (`connectPersona`, then the launch
 * when it reports `connected`). Resolves with `launched` (and the launch
 * function's result) or `not-brought-up` (with every failing step). A throw
 * from the launch function propagates unchanged; steps 1–3 never throw
 * except through a throwing injected logger.
 */
export async function bringUpPersona<L>(
  persona: Persona,
  deps: PersonaBringUpDeps<L>,
): Promise<PersonaBringUpResult<L>> {
  const connected = await connectPersona(persona, deps)
  if (connected.outcome !== 'connected') return connected

  // Step 4.
  return { outcome: 'launched', launch: await deps.launch(persona) }
}

/**
 * Steps 1–3 for one persona, in order: the local checks, then Slack
 * validation and connection. Resolves with `connected` when the manager
 * reports the persona `up`, else `not-brought-up` with every failing step.
 * Launches nothing. Never throws except through a throwing injected logger.
 */
export async function connectPersona(
  persona: Persona,
  deps: PersonaConnectDeps,
): Promise<PersonaConnectResult> {
  const checkOptions = { others: deps.applied, fs: deps.fs, log: deps.log }
  let tokens: PersonaSlackTokens | undefined

  // Steps 1 and 2.
  if (deps.dryRun) {
    const directory = (deps.checkDirectory ?? checkPersonaWorkingDirectory)(persona, checkOptions)
    if (!directory.ok) {
      return notBroughtUp([{ step: 'working-directory', class: directory.class, cause: directory.cause }])
    }
  } else {
    const local = (deps.checkLocal ?? checkPersonaLocalBringUp)(persona, checkOptions)
    const failures: PersonaBringUpFailure[] = []
    if (!local.credentials.ok) {
      failures.push({ step: 'credentials', class: local.credentials.class, cause: local.credentials.cause })
    }
    if (!local.directory.ok) {
      failures.push({ step: 'working-directory', class: local.directory.class, cause: local.directory.cause })
    }
    if (failures.length > 0 || !local.credentials.ok) return notBroughtUp(failures)
    tokens = local.credentials.tokens
  }

  // Step 3: the manager logs every Slack outcome itself.
  let status: PersonaConnectionStatus
  try {
    status = await deps.connections.bringUp(persona, tokens)
  } catch (err) {
    const cause = `Slack bring-up threw: ${describeThrownValue(err)}`
    deps.log(`[slack] persona ${renderPersonaRef(persona.name, persona.key)} not brought up: ${cause}`)
    return notBroughtUp([{ step: 'slack', class: 'error', cause }])
  }
  if (status.state !== 'up') return notBroughtUp([slackFailure(status)])
  return { outcome: 'connected' }
}

function notBroughtUp(failures: PersonaBringUpFailure[]): { outcome: 'not-brought-up'; failures: PersonaBringUpFailure[] } {
  return { outcome: 'not-brought-up', failures }
}

/** The step-3 failure for a status other than `up`: the outcome's class and cause when it has one. */
function slackFailure(status: Exclude<PersonaConnectionStatus, { state: 'up' }>): PersonaBringUpFailure {
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
 * Not while connecting, retrying its bring-up, broken (either phase; E5 refines
 * it per SR-6.4), stopped, or unmanaged.
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
 * Build the relaunch gate: `canRelaunch(key)` is true while the persona's
 * connection is serving (`isPersonaClientServing`: `up`, `lost`, or
 * `retrying` a reopen; every brought-up persona is `up` in dry run) and false
 * otherwise, including for a persona the manager does not know (one that
 * failed its credentials or working-directory check). The health check's work
 * list and the restart launch (`launchSession`) both ask it, so a persona that
 * was not brought up, or whose connection is not serving, is never launched
 * by either; once it reports `up` it is eligible again.
 *
 * When it answers false it logs one line, once per persona per non-serving
 * state (a repeat in the same state is silent; serving again re-arms it):
 *
 *   [slack] persona=<key>: not relaunched — its Slack connection is <state>; eligible again once it is up
 *
 * `<state>` is `not brought up`, `connecting`, `retrying its bring-up`,
 * `broken` or `stopped`. The line carries only the key and the state.
 */
export function createPersonaRelaunchGate(
  connections: Pick<PersonaConnectionManager, 'status'>,
  log: PersonaDiagnosticLogger,
): (key: string) => boolean {
  const lastLogged = new Map<string, string>()
  return (key) => {
    const status = connections.status(key)
    if (isPersonaClientServing(status)) {
      lastLogged.delete(key)
      return true
    }
    const state = describeNotServing(status)
    if (lastLogged.get(key) !== state) {
      lastLogged.set(key, state)
      log(`[slack] persona=${key}: not relaunched — its Slack connection is ${state}; eligible again once it is up`)
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
