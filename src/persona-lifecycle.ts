/**
 * persona-lifecycle.ts — The per-persona lifecycle operations a confirmed
 * apply runs (b.av2 SR-6.1, SR-6.2, SR-6.5, SR-6.6, SR-8.6).
 *
 * `createPersonaLifecycle(deps)` composes, over injected dependencies, the
 * three operations the reload controller's apply steps fan out to
 * (`ReloadLifecycleOps.teardown`, `.bringUp` and `.updateInPlace`, `reload.ts`):
 *
 * - **persona teardown** (SR-6.5, apply step 2): everything the server holds
 *   for one persona key goes, with no graceful wind-down. In order:
 *   1. its bring-up retries are cancelled and its bring-up state forgotten,
 *      and its pending restart timer is cancelled;
 *   2. a launch still in flight for it (the start pass's, which runs outside
 *      the serializer) is waited for, so the kill below never races a launch
 *      that is bringing the row up;
 *   3. its Slack connection is stopped (so no further event arrives for it),
 *      then its inbound dedupe store is dropped;
 *   4. its cached DM destination is forgotten, its held destination notices
 *      are cancelled, and its pre-validation held notices dropped;
 *   5. its tracked permission prompts and wedge state are dropped (their
 *      Slack messages stay as posted);
 *   6. its registered MCP session is dropped, the registry entry before the
 *      transport closes, so the closing stream schedules no restart;
 *   7. agent-director: `cscb_<key>` is killed, then its row deleted, each
 *      through `withOutageDetection`; a row already gone is success. Its
 *      outage flags are forgotten before these calls (so a success posts no
 *      all-clear) and again after them (so a flag a failing call raised does
 *      not survive). Its restart failure count and health-check streak are
 *      forgotten;
 *   8. its reply-guard record is deleted and its launched-with directory
 *      forgotten (read first), then the Stop-hook launch pass re-evaluates
 *      the persona's configured and launched-with directories against the
 *      personas still applied.
 *   The persona has already left the applied set (apply step 1), so every
 *   launch, restart and retry path refuses it, and a notice raised for it
 *   during the teardown (an outage onset from a failing kill) is dropped by
 *   the notifier, never posted or held. Each step's failure is logged and the
 *   remaining steps still run. Nothing is posted to Slack and nothing is
 *   recorded in `startup-errors.log`; a row a failed delete leaves behind is
 *   swept at the next start (SR-6.3). Dry run: no agent-director call.
 *
 * - **apply bring-up** (SR-6.1, SR-6.2, apply step 6): the start procedure
 *   for one added persona: the non-persistent-storage check for its
 *   effective config directory only (its warning goes to this persona
 *   alone, held until its client is validated), then the bring-up
 *   controller's `bringUp` (its `persona-start` line, the credentials check
 *   from the file, the working-directory check against the applied set,
 *   Slack validation and connection), then, when `up`, its launch. Resolves
 *   once the persona has an outcome and an `up` persona's launch settled; a
 *   `retrying` persona returns at once and retries on its own timers. A
 *   `broken` or `retrying` persona is logged by the controller and the
 *   manager, never posted about. Once the server is shutting down it brings
 *   nothing up: checked when the operation starts (no storage check, no
 *   bring-up, no launch; it resolves `broken` with no failures) and again
 *   right before the launch (the persona is not launched); either way one
 *   line is logged. Shutdown has already cancelled every bring-up and
 *   stopped every connection, so nothing started here would be released.
 *
 * - **in-place update** (SR-8.6, AC 58, apply step 3): a persona whose
 *   `channels`, `delivery`, `permission_prompts` or `dm.*` changed keeps its
 *   instance, Slack connection, Web API client, MCP session, restart,
 *   backoff, health, outage and retry state, reply-guard record, tracked
 *   prompts and held notices. The new values already took effect at apply
 *   step 1: every consumer (tool scope, delivery decision, destination, DM
 *   switch, archive evidence) reads the persona's entry from the applied
 *   configuration at each use. What is left is the persona's cached DM
 *   conversation, forgotten when `dm.contact`, `dm.enabled` or
 *   `permission_prompts` changed, so the next DM-destination post opens the
 *   DM for the current contact; then one line naming what changed. A key no
 *   longer applied when the operation runs gets nothing. Makes no Slack or
 *   agent-director call; never rejects. Dry run: the same.
 *
 * All three run through the per-persona lifecycle serializer (SR-6.6), so
 * each starts only after every operation already submitted for the persona
 * (a restart timer's work, a bring-up retry) has settled. None submits to the
 * serializer again from inside its own operation (the re-entrancy rule in
 * `persona-serializer.ts`). None touches another persona.
 *
 * Logging: plain `[slack]` lines through the injected logger, token-free; a
 * thrown value is rendered only through `describeThrownValue`:
 *
 *   [slack] persona teardown of "<name>" (key=<key>): starting
 *   [slack] persona teardown of "<name>" (key=<key>): <step> failed: <thrown value>
 *   [slack] persona teardown of "<name>" (key=<key>): complete
 *   [slack] persona teardown of "<name>" (key=<key>): complete, with <n> failed step(s)
 *   [slack] dry-run: persona teardown of "<name>" (key=<key>): skipping the agent-director kill and delete of cscb_<key>
 *   [slack] persona "<name>" (key=<key>): up at apply — launching
 *   [slack] persona "<name>" (key=<key>): launch at apply failed: <thrown value>
 *   [slack] persona "<name>" (key=<key>): storage check at apply failed: <thrown value>
 *   [slack] persona "<name>" (key=<key>): not brought up — the server is shutting down
 *   [slack] persona "<name>" (key=<key>): updated in place (<settings>); its instance, Slack connection and MCP session are kept[; its cached DM conversation is forgotten | ; forgetting its cached DM conversation failed: <thrown value>]
 *   [slack] persona "<name>" (key=<key>): in-place update failed: <thrown value>
 *
 * `<settings>` lists the changed setting groups, comma-separated, in the
 * change plan's order (`channels`, `delivery`, `permission_prompts`,
 * `dm.enabled`, `dm.contact`).
 *
 * Pure module (b.av2 SR-13.1): nothing is created, read or scheduled at
 * import or at `createPersonaLifecycle`; every dependency is injected, so
 * tests build it without importing `server.ts`.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Persona, PersonaConfig } from './config.ts'
import type { PersonaBringUpController, PersonaBringUpResultSummary } from './persona-bringup-controller.ts'
import type { PersonaConnectionManager } from './persona-connections.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import type { PersonaDestinations } from './persona-destination.ts'
import type { PersonaDestinationHold } from './persona-destination-hold.ts'
import { personaInstanceId, renderPersonaRef } from './persona-identity.ts'
import type { PersonaNotifier } from './persona-notifier.ts'
import type { PersonaRouting } from './persona-routing.ts'
import type { PersonaSerialize } from './persona-serializer.ts'
import type { InPlaceApplyInput } from './reload-apply.ts'
import type { InPlaceSetting } from './reload-plan.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The reply-guard helpers of `stop-hook-bootstrap.ts`, with the server's state directory bound. */
export interface PersonaTeardownReplyGuard {
  /** The directory the persona's running instance launched with (`getLaunchedWithDir`). */
  launchedWithDir(key: string): string | undefined
  /** Delete the persona's record and forget its launched-with dir (`teardownPersonaReplyGuard`). Never throws. */
  teardown(key: string): void
  /** Re-evaluate the managed Stop hook in `dirs` against `personas` (`stopHookLaunchPass`). Never throws. */
  launchPass(dirs: readonly (string | undefined)[], personas: readonly Persona[]): void
}

/** Dependencies of `createPersonaLifecycle`. */
export interface PersonaLifecycleDeps {
  /** The per-persona lifecycle serializer's `run` (the server's one shared instance). */
  serialize: PersonaSerialize
  /** The bring-up controller: an added persona's bring-up; a removed persona's cancel. */
  bringUps: Pick<PersonaBringUpController, 'bringUp' | 'cancel'>
  /** The connection manager: a removed persona's connection is stopped and forgotten. */
  connections: Pick<PersonaConnectionManager, 'stop'>
  /** The inbound routing: a removed persona's dedupe store is dropped. */
  routing: Pick<PersonaRouting, 'forget'>
  /**
   * The shared destination resolver: a removed persona's cached DM is
   * forgotten, and an in-place updated one's when its DM destination settings
   * changed.
   */
  destinations: Pick<PersonaDestinations, 'forget'>
  /** The shared destination hold: a removed persona's held notices and retry are cancelled. */
  destinationHold: Pick<PersonaDestinationHold, 'cancel'>
  /** The notifier: a removed persona's pre-validation held notices are dropped. */
  notifier: Pick<PersonaNotifier, 'forget'>
  /**
   * The persona set applied now (the server's `personaConfig`), read at each
   * use: the teardown's Stop-hook pass, and whether an in-place update's key
   * is still applied.
   */
  appliedPersonas: () => readonly Persona[]
  /** Dry run (b.av2 SR-3.4): the teardown makes no agent-director call. */
  dryRun: boolean
  /**
   * Whether the server is shutting down (server.ts: the shutdown flag the
   * restart module reads), read at each use: the apply bring-up then brings
   * nothing up. The teardown still runs; it only releases.
   */
  isShuttingDown: () => boolean
  /** Receives each `[slack]` line (the server log). */
  log: (line: string) => void

  // --- persona teardown ---
  /** Resolves once the launch in flight for the key (if any) settled; never rejects (`whenLaunchSettled`). */
  whenLaunchSettled: (key: string) => Promise<void>
  /** Cancel the key's pending restart timer (`cancelRestartTimer`). */
  cancelRestartTimer: (key: string) => unknown
  /** Forget the key's restart failure count and cap latch (`forgetFailures`). */
  forgetFailures: (key: string) => void
  /** Forget the key's health-check disconnected streak (`forgetDisconnectedStreak`). */
  forgetDisconnectedStreak: (key: string) => void
  /** Forget the keys' outage flags silently (`resetAllToHealthy`). */
  resetOutageState: (keys: string[]) => void
  /** Drop the key's tracked permission prompts and wedge state (`forgetPersonaPrompts`). */
  forgetPersonaPrompts: (key: string) => unknown
  /**
   * Drop the MCP session registered for the key, its registry entry before
   * its transport closes (server.ts: `dropPersonaSessionAndKeepAlive`).
   */
  dropSession: (key: string) => Promise<unknown>
  /** Kill `cscb_<key>` through `withOutageDetection`; not-found resolves (`killPersonaInstance`). */
  killInstance: (key: string) => Promise<unknown>
  /** Delete the `cscb_<key>` row through `withOutageDetection`; not-found resolves (`deletePersonaInstance`). */
  deleteInstance: (key: string) => Promise<unknown>
  /** The reply-guard helpers, the state directory bound. */
  replyGuard: PersonaTeardownReplyGuard

  // --- apply bring-up ---
  /**
   * The non-persistent-storage check for one persona's effective config
   * directory (`runPersonaStorageCheck` with the notifier). Never throws.
   */
  storageCheck: (persona: Persona) => void
  /**
   * Launch a persona that came up at apply: the persona launch path
   * (`spawnForPersona`, not at startup, with the start-time server-wide
   * values), which joins a launch already in flight for it.
   */
  launch: (persona: Persona) => Promise<unknown>
}

/** The lifecycle operations the reload controller's apply steps fan out to. */
export interface PersonaLifecycle {
  /** Persona teardown of one removed persona (apply step 2). Resolves once every step ran; never rejects. */
  teardown(persona: Persona): Promise<void>
  /**
   * Apply bring-up of one added persona (apply step 6), with `applied` the
   * configuration apply step 1 made current. Resolves with the bring-up
   * outcome once an `up` persona's launch settled.
   */
  bringUp(persona: Persona, applied: PersonaConfig): Promise<PersonaBringUpResultSummary>
  /**
   * In-place update of one persona modified in place (apply step 3):
   * `change.persona` is its entry in the configuration step 1 made current,
   * `change.previous` its entry before, `change.settings` what changed.
   * Resolves once done; never rejects.
   */
  updateInPlace(change: InPlaceApplyInput): Promise<void>
}

/**
 * The in-place settings whose change can move the persona's DM destination
 * (b.av2 SR-7.1): its cached DM conversation is forgotten when one changed
 * (Director decision 11; the cache also re-checks the contact on each use).
 */
const DM_DESTINATION_SETTINGS: ReadonlySet<InPlaceSetting> = new Set<InPlaceSetting>([
  'permission_prompts',
  'dm.enabled',
  'dm.contact',
])

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Compose the persona teardown, the apply bring-up and the in-place update. Creates, reads and schedules nothing. */
export function createPersonaLifecycle(deps: PersonaLifecycleDeps): PersonaLifecycle {
  function log(line: string): void {
    try {
      deps.log(line)
    } catch {
      /* a failing logger must not stop a lifecycle operation */
    }
  }

  // -------------------------------------------------------------------------
  // Persona teardown (b.av2 SR-6.5)
  // -------------------------------------------------------------------------

  async function runTeardown(persona: Persona): Promise<void> {
    const { key } = persona
    const prefix = `[slack] persona teardown of ${renderPersonaRef(persona.name, key)}`
    let failed = 0

    /** Run one step; a throw or rejection is logged and the next step still runs. */
    async function step(what: string, body: () => unknown): Promise<void> {
      try {
        await body()
      } catch (err) {
        failed++
        log(`${prefix}: ${what} failed: ${describeThrownValue(err)}`)
      }
    }

    log(`${prefix}: starting`)

    // Retries and timers first, so nothing for the key is started while the
    // teardown waits below.
    await step('cancelling its bring-up retries', () => deps.bringUps.cancel(key))
    await step('cancelling its restart timer', () => deps.cancelRestartTimer(key))
    await step('waiting for its launch in flight', () => deps.whenLaunchSettled(key))

    // The connection before the routing: an event for the key would create
    // a new dedupe store.
    await step('stopping its Slack connection', () => deps.connections.stop(key))
    await step('forgetting its inbound dedupe store', () => deps.routing.forget(key))
    await step('forgetting its DM destination', () => deps.destinations.forget(key))
    await step('cancelling its held destination notices', () => deps.destinationHold.cancel(key))
    await step('dropping its held notices', () => deps.notifier.forget(key))
    await step('dropping its tracked permission prompts', () => deps.forgetPersonaPrompts(key))
    // Before the kill: the closing stream then finds no session and
    // schedules no restart.
    await step('dropping its MCP session', () => deps.dropSession(key))

    const instanceId = personaInstanceId(key)
    if (deps.dryRun) {
      log(`[slack] dry-run: persona teardown of ${renderPersonaRef(persona.name, key)}: skipping the agent-director kill and delete of ${instanceId}`)
    } else {
      // A clean slate first, so a successful call clears no flag and posts no all-clear.
      await step('forgetting its outage state', () => deps.resetOutageState([key]))
      await step(`agent-director kill of ${instanceId}`, () => deps.killInstance(key))
      await step(`agent-director delete of ${instanceId}`, () => deps.deleteInstance(key))
    }
    // After the agent-director calls: a flag a failing call raised goes too.
    await step('forgetting its outage state', () => deps.resetOutageState([key]))
    await step('forgetting its restart failure count', () => deps.forgetFailures(key))
    await step('forgetting its health-check streak', () => deps.forgetDisconnectedStreak(key))

    // Read the launched-with dir before the teardown forgets it.
    let launchedWith: string | undefined
    await step('reading its launched-with directory', () => {
      launchedWith = deps.replyGuard.launchedWithDir(key)
    })
    await step('deleting its reply-guard record', () => deps.replyGuard.teardown(key))
    await step('re-evaluating the Stop hook in its config directories', () =>
      deps.replyGuard.launchPass([persona.claude_config_dir, launchedWith], deps.appliedPersonas()),
    )

    log(failed === 0 ? `${prefix}: complete` : `${prefix}: complete, with ${failed} failed step(s)`)
  }

  // -------------------------------------------------------------------------
  // Apply bring-up (b.av2 SR-6.1, SR-6.2)
  // -------------------------------------------------------------------------

  async function runBringUp(persona: Persona, applied: PersonaConfig): Promise<PersonaBringUpResultSummary> {
    const ref = renderPersonaRef(persona.name, persona.key)
    const skipLine = `[slack] persona ${ref}: not brought up — the server is shutting down`
    // Shutdown has cancelled every bring-up and stopped every connection:
    // nothing started from here would be released before the exit.
    if (deps.isShuttingDown()) {
      log(skipLine)
      return { outcome: 'broken', failures: [] }
    }
    try {
      deps.storageCheck(persona)
    } catch (err) {
      log(`[slack] persona ${ref}: storage check at apply failed: ${describeThrownValue(err)}`)
    }
    const result = await deps.bringUps.bringUp(persona, applied.personas)
    if (result.outcome !== 'up') return result
    // Shutdown may have begun during the bring-up: no instance is launched.
    if (deps.isShuttingDown()) {
      log(skipLine)
      return result
    }
    log(`[slack] persona ${ref}: up at apply — launching`)
    try {
      await deps.launch(persona)
    } catch (err) {
      log(`[slack] persona ${ref}: launch at apply failed: ${describeThrownValue(err)}`)
    }
    return result
  }

  // -------------------------------------------------------------------------
  // In-place update (b.av2 SR-8.6, AC 58)
  // -------------------------------------------------------------------------

  async function runUpdateInPlace(change: InPlaceApplyInput): Promise<void> {
    const { persona, settings } = change
    const { key } = persona
    try {
      // Removed by a later apply before this ran: its teardown owns it.
      if (!deps.appliedPersonas().some((p) => p.key === key)) return
    } catch (err) {
      log(`[slack] persona ${renderPersonaRef(persona.name, key)}: in-place update failed: ${describeThrownValue(err)}`)
      return
    }
    const changed = settings.length > 0 ? settings.join(', ') : 'no setting'
    let line =
      `[slack] persona ${renderPersonaRef(persona.name, key)}: updated in place (${changed}); ` +
      'its instance, Slack connection and MCP session are kept'
    if (settings.some((setting) => DM_DESTINATION_SETTINGS.has(setting))) {
      try {
        deps.destinations.forget(key)
        line += '; its cached DM conversation is forgotten'
      } catch (err) {
        line += `; forgetting its cached DM conversation failed: ${describeThrownValue(err)}`
      }
    }
    log(line)
  }

  return {
    teardown: (persona) => deps.serialize(persona.key, () => runTeardown(persona)),
    bringUp: (persona, applied) => deps.serialize(persona.key, () => runBringUp(persona, applied)),
    updateInPlace: (change) => deps.serialize(change.persona.key, () => runUpdateInPlace(change)),
  }
}
