/**
 * persona-lifecycle.ts — The per-persona lifecycle operations a confirmed
 * apply runs (b.av2 SR-6.1, SR-6.2, SR-6.5, SR-6.6, SR-8.6).
 *
 * `createPersonaLifecycle(deps)` composes, over injected dependencies, the
 * operations the reload controller's apply steps fan out to
 * (`ReloadLifecycleOps.teardown`, `.bringUp`, `.reconnectCredentials`,
 * `.updateInPlace` and `.refreshTemplate`, `reload.ts`):
 *
 * - **persona teardown** (SR-6.5, apply step 2): everything the server holds
 *   for one persona key goes, with no graceful wind-down. It serves a
 *   removed persona and the old half of a destructive modify alike. In
 *   order:
 *   1. its bring-up retries are cancelled and its bring-up state forgotten,
 *      its pending restart timer is cancelled and its UNAVAILABLE retry timer
 *      stopped (b.jg5 SRJ-305; a retry already running finishes first, since
 *      the teardown waits its serializer turn, and its answer is dropped);
 *   2. a launch still in flight for it (the start pass's, which runs outside
 *      the serializer) is waited for, so the kill below never races a launch
 *      that is bringing the row up. A launch waiting for a `working` row to
 *      settle (up to 10 minutes) has that wait cancelled first (b.f2b: when
 *      the teardown is submitted, and again here), so it types nothing and
 *      settles promptly, and the apply is not held up by it (SR-8.6);
 *   3. its Slack connection is stopped (so no further event arrives for it),
 *      then its inbound dedupe store and its ack-tracker entries are dropped;
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
 *      not survive). Its restart failure count, health-check streak,
 *      not-connected episode (b.f2b: its notice latch and the restart path's
 *      idle evidence), its latch (b.jg5 SRJ-504) and then its notice episodes
 *      of every kind (b.jg5 SRJ-1016) are forgotten, silently. The latch and
 *      the episodes go after the launch in flight settled (step 2), so a latch
 *      that launch set during the teardown, and the CONFLICT episode it began,
 *      go too (SRJ-1002) (that latch's CONFLICT notice was raised at the set,
 *      while the connection still served: the notifier drops it for a removed
 *      persona and, for a destructive modify's old half, posts it to the
 *      destination of the declaration now applied, the new half's; routing it
 *      to the teardown's log-only entry is not built yet): the key is left
 *      neither latched nor with a CONFLICT episode open, so a destructive
 *      modify's new half starts unlatched and, if its own launch meets the
 *      same CONFLICT, latches with one post. No recovery notice is posted and
 *      no clear is logged;
 *   8. its reply-guard record is deleted and its launched-with directory
 *      forgotten (read first), then the Stop-hook launch pass re-evaluates
 *      the persona's configured and launched-with directories against the
 *      personas still applied.
 *   A removed persona has already left the applied set (apply step 1), so
 *   every launch, restart and retry path refuses it, and a notice raised for
 *   it during the teardown (an outage onset from a failing kill) is dropped
 *   by the notifier, never posted or held. The old half of a destructive
 *   modify (SR-8.6: a `credentials_file` path or `working_directory` change)
 *   keeps its key applied until step 6 brings its new declaration up, so the
 *   applied-set guard does not refuse it. Instead:
 *   - its bring-up state and restart timer are cancelled, and its
 *     UNAVAILABLE retry timer stopped, as soon as the teardown is submitted,
 *     before its serializer turn: work already queued
 *     ahead of the teardown for the key (a restart timer's work, a bring-up
 *     retry and its launch) then finds it not up or cancelled and launches
 *     nothing, rather than launching the new declaration only for the
 *     teardown to destroy it; from then until step 6 the relaunch gate and
 *     the up predicate answer not up for it, so no restart, retry or launch
 *     path starts it;
 *   - notices raised during its teardown are held for a persona with no
 *     client, so they are dropped again once its agent-director calls are
 *     done, and none reaches its new half's destination.
 *   Each step's failure is logged and the
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
 *   With `{ recovery: true }` it is the recovery bring-up of a persona
 *   broken by its credentials whose credentials file changed (SR-6.4, SR-8.6
 *   step 6, with or without an instance): decided when it runs, a persona
 *   still broken by its credentials first has its bring-up state cancelled,
 *   its connection stopped (a fresh connection and episode latch follow) and
 *   its cached DM conversation forgotten, then goes through the same
 *   procedure; its instance and row are kept, so the launch reaches them
 *   through the collision ladder. Shutdown is checked again once that
 *   clearing is done, before anything new connects. One that is not broken
 *   by its credentials by then (step 4 left it here because it was, and a
 *   pending reconnect of an earlier change brought it up since) gets the
 *   confirmed change as step 4 would have applied it, the credentials change
 *   below run directly in the same serializer turn, so the confirmed content
 *   is applied rather than skipped.
 *
 * - **credentials change** (SR-8.6 step 4, credentials row): the bring-up
 *   controller's `changeCredentials` over the connection manager, for a
 *   persona that is up (reconnected: the new connection opens, then the old
 *   one closes; its instance and MCP session are kept) or retrying (it
 *   retries with the new content; a persona held for its claude_config_dir
 *   is retrying with no connection, opens none, and connects with the new
 *   content once the directory resolves). Its cached DM conversation is
 *   forgotten right before the new connection comes into use (the
 *   controller's `beforeSwap`, ahead of the notifier's flush at up), whether
 *   that swap happens at once or later, or, for a persona with no connection,
 *   when it takes the new content; a later swap logs the reconnected line
 *   too.
 *   Each line is worded from the persona's state after the attempt (a
 *   persona whose current connection was refused meanwhile is not said to
 *   keep it). A persona broken by its credentials by then is left to step
 *   6's recovery bring-up. Nothing touches another persona; no
 *   agent-director call.
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
 * - **template refresh** (SR-8.6 step 5): the agent-director template's
 *   memory-read rules rewritten for the applied persona set, its other
 *   arguments kept as the boot install wrote them
 *   (`refreshSlackChannelBotTemplate`, `agent-director-template.ts`). It
 *   belongs to no persona, so it does not go through the serializer. A
 *   failure is logged there and is not fatal; never rejects. Dry run: the
 *   same call, as the boot install makes it in dry run.
 *
 * The four per-persona operations run through the per-persona lifecycle
 * serializer (SR-6.6), so each starts only after every operation already
 * submitted for the persona (a restart timer's work, a bring-up retry) has
 * settled. None submits to the serializer again from inside its own
 * operation (the re-entrancy rule in `persona-serializer.ts`). None touches
 * another persona.
 *
 * A persona with only next-launch changes (`claude_config_dir`,
 * `stop_hook_bootstrap`, own or inherited) gets no operation: step 1's swap
 * of the applied set is what its next launch reads (the spawn environment and
 * `config_dir` label, the SR-6.2 label check before a resume, the trust patch,
 * the reply-guard record and hook install, the transcript diagnosis), and its
 * running instance keeps what it launched with.
 *
 * Logging: plain `[slack]` lines through the injected logger, token-free; a
 * thrown value is rendered only through `describeThrownValue`:
 *
 *   [slack] persona teardown of "<name>" (key=<key>): starting
 *   [slack] persona teardown of "<name>" (key=<key>): <step> failed: <thrown value>
 *   [slack] persona teardown of "<name>" (key=<key>): <step> before its turn failed: <thrown value>
 *   [slack] persona teardown of "<name>" (key=<key>): complete
 *   [slack] persona teardown of "<name>" (key=<key>): complete, with <n> failed step(s)
 *   [slack] dry-run: persona teardown of "<name>" (key=<key>): skipping the agent-director kill and delete of cscb_<key>
 *   [slack] persona "<name>" (key=<key>): up at apply — launching
 *   [slack] persona "<name>" (key=<key>): launch at apply failed: <thrown value>
 *   [slack] persona "<name>" (key=<key>): storage check at apply failed: <thrown value>
 *   [slack] persona "<name>" (key=<key>): not brought up — the server is shutting down
 *   [slack] persona "<name>" (key=<key>): updated in place (<settings>); its instance, Slack connection and MCP session are kept[; its cached DM conversation is forgotten | ; forgetting its cached DM conversation failed: <thrown value>]
 *   [slack] persona "<name>" (key=<key>): in-place update failed: <thrown value>
 *   [slack] persona "<name>" (key=<key>): broken by its credentials and its credentials file changed — bringing it up again
 *   [slack] persona "<name>" (key=<key>): not brought up again — it is not broken by its credentials now, so its changed credentials are applied as a credentials change
 *   [slack] persona "<name>" (key=<key>): <step> before bringing it up again failed: <thrown value>
 *   [slack] persona "<name>" (key=<key>): reconnected with its changed credentials; its instance and MCP session are kept
 *   [slack] persona "<name>" (key=<key>): reconnected with its changed credentials and up again; its instance is kept
 *   [slack] persona "<name>" (key=<key>): its changed credentials cannot reach Slack yet; the new connection retries and the current one stays in use
 *   [slack] persona "<name>" (key=<key>): its changed credentials cannot reach Slack yet; the new connection retries, and it stays broken by its credentials until that connection is in use
 *   [slack] persona "<name>" (key=<key>): it retries its bring-up with its changed credentials
 *   [slack] persona "<name>" (key=<key>): broken by its credentials now, so it is brought up again rather than reconnected
 *   [slack] persona "<name>" (key=<key>): credentials change not applied — the server is shutting down
 *   [slack] persona "<name>" (key=<key>): forgetting its cached DM conversation failed: <thrown value>
 *
 * A credentials change that cannot be used is logged by the bring-up
 * controller (`persona-credentials-change-failed`); the template refresh's
 * one line is `refreshSlackChannelBotTemplate`'s.
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

import type { MakeTemplateParams } from 'agent-director'
import { refreshSlackChannelBotTemplate, type TemplateRefreshResult } from './agent-director-template.ts'
import type { Persona, PersonaConfig } from './config.ts'
import {
  isCredentialsBroken,
  type CredentialsChangeHooks,
  type PersonaBringUpController,
  type PersonaBringUpResultSummary,
  type PersonaCredentialsChangeResult,
} from './persona-bringup-controller.ts'
import type { PersonaConnectionManager } from './persona-connections.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import type { PersonaDestinations } from './persona-destination.ts'
import type { PersonaDestinationHold } from './persona-destination-hold.ts'
import { personaInstanceId, renderPersonaRef } from './persona-identity.ts'
import type { PersonaNotifier } from './persona-notifier.ts'
import type { PersonaRouting } from './persona-routing.ts'
import type { PersonaSerialize } from './persona-serializer.ts'
import type { ApplyBringUpOptions, InPlaceApplyInput } from './reload-apply.ts'
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
  /**
   * The bring-up controller: an added persona's bring-up; a removed
   * persona's cancel; a credentials change (`changeCredentials`); and, for a
   * recovery, the persona's state now and its cancel.
   */
  bringUps: Pick<PersonaBringUpController, 'bringUp' | 'cancel' | 'state' | 'changeCredentials'>
  /**
   * The connection manager: a removed or recovered persona's connection is
   * stopped and forgotten; a credentials change reconnects an up persona
   * (`reconnectCredentials`) or hands a Slack-retrying one its new tokens
   * (`replaceRetryTokens`).
   */
  connections: Pick<PersonaConnectionManager, 'stop' | 'reconnectCredentials' | 'replaceRetryTokens'>
  /** The inbound routing: a removed persona's dedupe store is dropped. */
  routing: Pick<PersonaRouting, 'forget'>
  /**
   * The shared destination resolver: a removed persona's cached DM is
   * forgotten, an in-place updated one's when its DM destination settings
   * changed, and one whose credentials changed when its new connection comes
   * into use or it is brought up again (the new app may have another DM).
   */
  destinations: Pick<PersonaDestinations, 'forget'>
  /** The shared destination hold: a removed persona's held notices and retry are cancelled. */
  destinationHold: Pick<PersonaDestinationHold, 'cancel'>
  /** The notifier: a removed persona's pre-validation held notices are dropped. */
  notifier: Pick<PersonaNotifier, 'forget'>
  /**
   * The persona set applied now (the server's `personaConfig`), read at each
   * use: the teardown's Stop-hook pass, whether a teardown's key is still
   * applied (the old half of a destructive modify), and whether an in-place
   * update's key is still applied.
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
  /**
   * Cancel the key's launch wait for a `working` row, if one is running
   * (b.f2b, `cancelWorkingRowWait`): the wait types nothing and its launch
   * settles promptly, instead of holding the teardown for up to 10 minutes.
   * Production always passes it.
   */
  cancelLaunchWait?: (key: string) => unknown
  /** Cancel the key's pending restart timer (`cancelRestartTimer`). */
  cancelRestartTimer: (key: string) => unknown
  /**
   * Stop the key's UNAVAILABLE retry timer (b.jg5 SRJ-305: the retry
   * controller's `stop` with the torn-down reason), called beside
   * `cancelRestartTimer`, and again after the teardown's agent-director calls
   * (a failing kill's ENVIRONMENT answer arms the key's timer); other
   * personas' timers stay armed. In production
   * the stop also cancels the key's `tmux-unresponsive` alert check through
   * the controller's stop observer (b.jg5 SRJ-309: its text says CSCB keeps
   * retrying), its episode kept until `forgetNoticeEpisodes`.
   */
  stopRetryTimer: (key: string) => unknown
  /** Forget the key's restart failure count and cap latch (`forgetFailures`). */
  forgetFailures: (key: string) => void
  /** Forget the key's health-check disconnected streak (`forgetDisconnectedStreak`). */
  forgetDisconnectedStreak: (key: string) => void
  /**
   * End the key's not-connected episode (b.f2b, `forgetNotConnectedEpisode`:
   * its notice latch and the restart path's idle evidence), so a key added
   * again starts afresh. Production always passes it.
   */
  forgetNotConnectedEpisode?: (key: string) => void
  /**
   * End the key's notice episodes of every kind silently (b.jg5 SRJ-1016:
   * the episodes instance's `forget`), run beside `forgetNotConnectedEpisode`
   * after its launch in flight settled; other personas' episodes stay open.
   */
  forgetNoticeEpisodes: (key: string) => unknown
  /**
   * Forget the key's latch silently (b.jg5 SRJ-504: the latch instance's
   * `forget`): no post, no set observer call, no line claiming a clear. Run
   * after its launch in flight settled and after the teardown's
   * agent-director calls, so a latch that launch set during the teardown
   * goes too (SRJ-1002), and right before `forgetNoticeEpisodes`, which ends
   * the CONFLICT episode that latch began; other personas' latches stay.
   */
  forgetConflictLatch: (key: string) => unknown
  /** Forget the keys' outage flags silently (`resetAllToHealthy`). */
  resetOutageState: (keys: string[]) => void
  /** Drop the key's tracked permission prompts and wedge state (`forgetPersonaPrompts`). */
  forgetPersonaPrompts: (key: string) => unknown
  /** Drop the key's ack-tracker entries silently (`forgetPersonaAcks`). */
  forgetAcks: (key: string) => void
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

  // --- template refresh (apply step 5) ---
  /** What the template refresh keeps from the start, and the client it calls. */
  templateRefresh: {
    /**
     * The params the boot install wrote (`installSlackChannelBotTemplate`'s
     * `params`): the refresh keeps every field but the memory-read rules, so
     * the start-time server-wide arguments stay until the next start.
     */
    installed: MakeTemplateParams
    /** The agent-director client (production: the singleton `getClient`). */
    getClient: () => unknown
  }
}

/** The lifecycle operations the reload controller's apply steps fan out to. */
export interface PersonaLifecycle {
  /**
   * Persona teardown of one removed persona, or of the old half of a
   * destructive modify (apply step 2), declared as before the change.
   * Resolves once every step ran; never rejects.
   */
  teardown(persona: Persona): Promise<void>
  /**
   * Apply bring-up of one added persona (apply step 6), with `applied` the
   * configuration apply step 1 made current. Resolves with the bring-up
   * outcome once an `up` persona's launch settled. With `options.recovery`,
   * the recovery bring-up of a persona broken by its credentials whose
   * credentials file changed (b.av2 SR-6.4): when it is still broken by its
   * credentials, its leftover state is cleared first; otherwise its changed
   * credentials are applied as `reconnectCredentials` would, in the same
   * serializer turn.
   */
  bringUp(persona: Persona, applied: PersonaConfig, options?: ApplyBringUpOptions): Promise<PersonaBringUpResultSummary>
  /**
   * Credentials change of one persona whose credentials file changed (apply
   * step 4), declared as in `applied`: the bring-up controller's
   * `changeCredentials` over the connection manager, its cached DM
   * conversation forgotten right before the new connection comes into use.
   * Resolves once
   * its first attempt settled, with `{ kind: 'credentials-broken' }` when it
   * is broken by its credentials by then (step 6 brings it up instead).
   */
  reconnectCredentials(persona: Persona, applied: PersonaConfig): Promise<PersonaCredentialsChangeResult>
  /**
   * In-place update of one persona modified in place (apply step 3):
   * `change.persona` is its entry in the configuration step 1 made current,
   * `change.previous` its entry before, `change.settings` what changed.
   * Resolves once done; never rejects.
   */
  updateInPlace(change: InPlaceApplyInput): Promise<void>
  /**
   * Template refresh (apply step 5): the agent-director template's
   * memory-read rules for `applied`'s personas, its other arguments as the
   * boot install wrote them. Not serialized (it belongs to no persona).
   * Resolves once the call settled, successful or not; never rejects.
   */
  refreshTemplate(applied: PersonaConfig): Promise<TemplateRefreshResult>
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

/** Compose the persona teardown, the apply bring-up (and recovery), the credentials change and the in-place update. Creates, reads and schedules nothing. */
export function createPersonaLifecycle(deps: PersonaLifecycleDeps): PersonaLifecycle {
  function log(line: string): void {
    try {
      deps.log(line)
    } catch {
      /* a failing logger must not stop a lifecycle operation */
    }
  }

  /** Whether `key` is in the applied set now; false when the set cannot be read. */
  function isApplied(key: string): boolean {
    try {
      return deps.appliedPersonas().some((p) => p.key === key)
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Persona teardown (b.av2 SR-6.5)
  // -------------------------------------------------------------------------

  /**
   * Run when a teardown is submitted, before its serializer turn. For every
   * teardown (b.f2b): cancel its launch's wait for a `working` row, if one is
   * running, so neither the teardown nor work queued ahead of it for the key
   * (a restart that joined that launch) waits it out, up to 10 minutes. For
   * the old half of a destructive modify (its key still applied after step
   * 1; a removed persona needs nothing more here, the applied-set guard
   * refuses it): cancel its bring-up state and retries and its pending
   * restart timer, and stop its UNAVAILABLE retry timer, now. Work already
   * queued ahead of the teardown for the key then does nothing: a restart
   * timer's or a retry's work finds it not up (the relaunch gate), and a
   * bring-up retry or its launch finds its entry cancelled.
   * Otherwise that work would launch the new declaration (the launch paths
   * read the applied set) only for the teardown to kill it. Every call is
   * synchronous and runs again, as a no-op, in the teardown's own steps. A
   * failure is logged.
   */
  function cancelBeforeTurn(persona: Persona): void {
    const { key } = persona
    const prefix = `[slack] persona teardown of ${renderPersonaRef(persona.name, key)}`
    const cancels: [string, () => unknown][] = [
      ["cancelling its launch's wait for a working row", () => deps.cancelLaunchWait?.(key)],
    ]
    if (isApplied(key)) {
      cancels.push(
        ['cancelling its bring-up retries', () => deps.bringUps.cancel(key)],
        ['cancelling its restart timer', () => deps.cancelRestartTimer(key)],
        ['stopping its UNAVAILABLE retry timer', () => deps.stopRetryTimer(key)],
      )
    }
    for (const [what, cancel] of cancels) {
      const failed = (err: unknown) => log(`${prefix}: ${what} before its turn failed: ${describeThrownValue(err)}`)
      try {
        void Promise.resolve(cancel()).catch(failed)
      } catch (err) {
        failed(err)
      }
    }
  }

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
    await step('stopping its UNAVAILABLE retry timer', () => deps.stopRetryTimer(key))
    // b.f2b: again here, for a wait that started after the teardown was
    // submitted; the launch then settles promptly.
    await step("cancelling its launch's wait for a working row", () => deps.cancelLaunchWait?.(key))
    await step('waiting for its launch in flight', () => deps.whenLaunchSettled(key))

    // The connection before the routing: an event for the key would create
    // a new dedupe store.
    await step('stopping its Slack connection', () => deps.connections.stop(key))
    await step('forgetting its inbound dedupe store', () => deps.routing.forget(key))
    await step('forgetting its ack-reaction entries', () => deps.forgetAcks(key))
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
    // After the agent-director calls: a flag a failing call raised goes too,
    // and so does a retry timer it armed (an ENVIRONMENT answer arms one in
    // any context, b.jg5 SRJ-311). Its key stays applied for a destructive
    // modify, so a timer left armed would retry against the new half 30 s
    // later with agent-director calls; stopping it here leaves none.
    await step('forgetting its outage state', () => deps.resetOutageState([key]))
    await step('stopping its UNAVAILABLE retry timer', () => deps.stopRetryTimer(key))
    // The old half of a destructive modify is still applied, so a notice
    // raised during this teardown (an outage onset from a failing kill) was
    // held for it rather than dropped: drop it again, so it never reaches the
    // destination of its new half once that is up.
    if (isApplied(key)) await step('dropping the notices held during its teardown', () => deps.notifier.forget(key))
    await step('forgetting its restart failure count', () => deps.forgetFailures(key))
    await step('forgetting its health-check streak', () => deps.forgetDisconnectedStreak(key))
    await step('forgetting its not-connected episode', () => deps.forgetNotConnectedEpisode?.(key))
    // b.jg5 SRJ-504, SRJ-1002: silently, after its launch in flight settled
    // and after the agent-director calls, so a latch that launch set during
    // the teardown goes too; then its notice episodes, the CONFLICT episode
    // that latch began included, so neither is left open: a CONFLICT episode
    // left open would keep a later same-case latch from posting.
    await step('forgetting its latch', () => deps.forgetConflictLatch(key))
    await step('forgetting its notice episodes', () => deps.forgetNoticeEpisodes(key))

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

  async function runBringUp(
    persona: Persona,
    applied: PersonaConfig,
    options: ApplyBringUpOptions = {},
  ): Promise<PersonaBringUpResultSummary> {
    const ref = renderPersonaRef(persona.name, persona.key)
    const skipLine = `[slack] persona ${ref}: not brought up — the server is shutting down`
    // Shutdown has cancelled every bring-up and stopped every connection:
    // nothing started from here would be released before the exit.
    if (deps.isShuttingDown()) {
      log(skipLine)
      return { outcome: 'broken', failures: [] }
    }
    if (options.recovery === true) {
      const notNeeded = await prepareRecovery(persona, applied)
      if (notNeeded !== undefined) return notNeeded
      // Shutdown may have begun while its connection was being stopped:
      // nothing new is connected or launched.
      if (deps.isShuttingDown()) {
        log(skipLine)
        return { outcome: 'broken', failures: [] }
      }
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

  /**
   * The recovery-specific preparation (b.av2 SR-6.4): decided when the
   * operation runs, not at the preview. A persona still broken by its
   * credentials has its bring-up state and timers cancelled, its connection
   * stopped (a fresh connection gets a fresh episode latch, so a new refusal
   * is logged) and its cached DM conversation forgotten; its instance and
   * agent-director row are kept, for the launch's collision ladder. Resolves
   * undefined then, so the bring-up runs. A persona that is not broken by
   * its credentials any more (step 4 left it to this step because it was,
   * and a pending reconnect of an earlier change has brought it up since)
   * gets the confirmed change as step 4 would have applied it, through the
   * credentials change body called directly (this already runs in its
   * serializer turn), so the confirmed content is never left unapplied; it
   * resolves the persona's outcome after that, unless the change found it
   * broken by its credentials again, when the preparation goes ahead. A
   * failed step is logged and the rest still run.
   */
  async function prepareRecovery(persona: Persona, applied: PersonaConfig): Promise<PersonaBringUpResultSummary | undefined> {
    const { key } = persona
    const prefix = `[slack] persona ${renderPersonaRef(persona.name, key)}`
    if (!isCredentialsBroken(deps.bringUps.state(key))) {
      log(`${prefix}: not brought up again — it is not broken by its credentials now, so its changed credentials are applied as a credentials change`)
      const change = await runReconnectCredentials(persona, applied)
      if (change.kind !== 'credentials-broken') {
        return { outcome: deps.bringUps.state(key)?.outcome ?? 'broken', failures: [] }
      }
    }
    log(`${prefix}: broken by its credentials and its credentials file changed — bringing it up again`)
    const step = async (what: string, body: () => unknown): Promise<void> => {
      try {
        await body()
      } catch (err) {
        log(`${prefix}: ${what} before bringing it up again failed: ${describeThrownValue(err)}`)
      }
    }
    await step('cancelling its bring-up state', () => deps.bringUps.cancel(key))
    await step('stopping its Slack connection', () => deps.connections.stop(key))
    await step('forgetting its DM destination', () => deps.destinations.forget(key))
    return undefined
  }

  // -------------------------------------------------------------------------
  // Credentials change (b.av2 SR-8.6 step 4, credentials row)
  // -------------------------------------------------------------------------

  /**
   * The credentials change body. Runs inside the persona's serializer turn:
   * submitted by `reconnectCredentials`, or called directly by a recovery
   * bring-up that found the persona no longer broken by its credentials
   * (never through the serializer again: the re-entrancy rule).
   */
  async function runReconnectCredentials(persona: Persona, applied: PersonaConfig): Promise<PersonaCredentialsChangeResult> {
    const { key } = persona
    const prefix = `[slack] persona ${renderPersonaRef(persona.name, key)}`
    if (deps.isShuttingDown()) {
      log(`${prefix}: credentials change not applied — the server is shutting down`)
      return { kind: 'skipped' }
    }
    const reconnectedLine = (wasUp: boolean): string =>
      wasUp
        ? `${prefix}: reconnected with its changed credentials; its instance and MCP session are kept`
        : `${prefix}: reconnected with its changed credentials and up again; its instance is kept`
    const forgetDm = (): void => {
      try {
        deps.destinations.forget(key)
      } catch (err) {
        log(`${prefix}: forgetting its cached DM conversation failed: ${describeThrownValue(err)}`)
      }
    }
    const hooks: CredentialsChangeHooks = {
      // Before the swap, so the notifier's flush at up never posts held
      // notices to the old app's DM (the new app may have another DM).
      beforeSwap: forgetDm,
      // A reconnect left retrying took over after this operation resolved.
      onSwapped: (swap) => {
        if (swap.late) log(reconnectedLine(swap.wasUp))
      },
    }
    const result = await deps.bringUps.changeCredentials(persona, applied.personas, deps.connections, hooks)
    switch (result.kind) {
      case 'swapped':
        log(reconnectedLine(result.cameBackUp !== true))
        break
      case 'retrying':
        // No connection: it comes up on the new content later (a persona held
        // for its claude_config_dir may have a DM cached from the old app).
        if (result.connection === 'none') forgetDm()
        log(
          result.connection === 'kept'
            ? `${prefix}: its changed credentials cannot reach Slack yet; the new connection retries and the current one stays in use`
            : result.connection === 'broken'
              ? `${prefix}: its changed credentials cannot reach Slack yet; the new connection retries, and it stays broken by its credentials until that connection is in use`
              : `${prefix}: it retries its bring-up with its changed credentials`,
        )
        break
      case 'credentials-broken':
        log(`${prefix}: broken by its credentials now, so it is brought up again rather than reconnected`)
        break
      case 'failed':
      case 'skipped':
        // A failed change logged its persona-credentials-change-failed line.
        break
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
    teardown: (persona) => {
      cancelBeforeTurn(persona)
      return deps.serialize(persona.key, () => runTeardown(persona))
    },
    bringUp: (persona, applied, options) => deps.serialize(persona.key, () => runBringUp(persona, applied, options)),
    reconnectCredentials: (persona, applied) => deps.serialize(persona.key, () => runReconnectCredentials(persona, applied)),
    updateInPlace: (change) => deps.serialize(change.persona.key, () => runUpdateInPlace(change)),
    refreshTemplate: (applied) =>
      refreshSlackChannelBotTemplate(applied, deps.templateRefresh.installed, {
        getClient: deps.templateRefresh.getClient,
        log,
      }),
  }
}
