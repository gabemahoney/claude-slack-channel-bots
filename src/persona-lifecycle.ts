/**
 * persona-lifecycle.ts — The per-persona lifecycle operations a confirmed
 * apply runs (b.av2 SR-6.1, SR-6.2, SR-6.5, SR-6.6, SR-8.6).
 *
 * `createPersonaLifecycle(deps)` composes, over injected dependencies, the
 * operations the reload controller's apply steps fan out to
 * (`ReloadLifecycleOps.teardown`, `.bringUp`, `.reconnectCredentials`,
 * `.updateInPlace` and `.refreshTemplate`, `reload.ts`):
 *
 * - **persona teardown** (b.av2 SR-6.5 as amended by b.jg5 SRJ-1507, apply
 *   step 2; b.jg5 SRJ-715): the server stops everything it runs for one
 *   persona key, with no graceful wind-down, kills its agent-director row
 *   with the result checked, and keeps the row: there is no delete. The
 *   key was recorded as retired in apply step 1 (b.jg5 SRJ-803), which also
 *   stopped its dialog approver (SRJ-808), so the row is the key's old life
 *   and is never resumed. It serves a removed persona and the old half of a
 *   destructive modify alike. When it is submitted, before its serializer
 *   turn, it registers with the notifier (`submitTeardown`): from then until
 *   it completes the key's notice episodes post nothing to Slack (b.jg5
 *   SRJ-1003), so an old half's `tmux-unresponsive` onset, alert or recovery
 *   never reaches its new half's destination. At the start of its turn, with
 *   nothing awaited before them, its outage flags are forgotten silently (a
 *   flag raised before the teardown posts no all-clear) and its notice
 *   window opens (`openTeardownWindow`, b.jg5 SRJ-1003): from there until it
 *   completes, every notice raised for its key (an outage onset from its
 *   calls or from the launch in flight it waits for, a latch's or an
 *   `ErrInvalidFlags` hold's notice that launch raises, an unclassified
 *   alert, a kill-failure alert, a CONFLICT or UNUSABLE NAME met by its
 *   kill) is a server-log line and a startup-errors entry naming the persona
 *   and "raised during its teardown" (`persona-teardown-notice`, or
 *   `persona-kill-survivor` for the kill-failure alert's survivor version),
 *   never a Slack post to the old or the new half's destination, and is never
 *   dropped. A flag raised in the window is kept past the teardown, and its
 *   all-clear, whenever it comes, is written the same way (b.jg5 SRJ-1002).
 *   The window closes, and the submit ends, when the teardown completes,
 *   whatever a step throws. In order, inside the window:
 *   1. first, before the wait for its launch in flight (b.jg5 SRJ-715): its
 *      dialog approver is stopped (b.jg5 SRJ-404), when the teardown is
 *      submitted and again as its first step; the stop also cancels the
 *      approver a launch in flight would start, so no Enter reaches the old
 *      life after this point. Right after it, its running live-row sequence
 *      is stopped (b.jg5 SRJ-706), when the teardown is submitted and again
 *      as its second step, which waits for the sequence's call in flight (a
 *      step-6 launch it had started included), so the sequence makes no
 *      further call and the retry-timer stop that follows clears an arm it
 *      made. Then its UNAVAILABLE retry timer is stopped (b.jg5 SRJ-305), its
 *      old-life waits forgotten (b.jg5 SRJ-811: no hold's end retries it, and
 *      the wait of a hold it waited on is stopped only when no persona left
 *      in the applied configuration waits on that hold), its
 *      latch forgotten silently (b.jg5 SRJ-504: no post, no line claiming a
 *      clear), its `ErrInvalidFlags` hold forgotten (b.jg5 SRJ-207: no post
 *      and no retry) and its notice episodes of every kind ended silently
 *      (b.jg5 SRJ-1016);
 *   2. its bring-up retries are cancelled and its bring-up state forgotten,
 *      and its pending restart timer is cancelled (a retry already running
 *      finishes first, since the teardown waits its serializer turn, and its
 *      answer is dropped);
 *   3. a launch still in flight for it (the start pass's, which runs outside
 *      the serializer) is waited for, so the kill below never races a launch
 *      that is bringing the row up. A launch waiting for a `working` row to
 *      settle (up to 10 minutes) has that wait cancelled first (b.f2b: when
 *      the teardown is submitted, and again here), so it types nothing and
 *      settles promptly, and the apply is not held up by it (SR-8.6);
 *   4. once that launch has settled (b.jg5 SRJ-715): its live-row sequence
 *      is stopped again, awaited, its UNAVAILABLE retry timer stopped again,
 *      its old-life waits forgotten again (that launch can have recorded it
 *      as waiting), its latch forgotten silently again, and its `ErrInvalidFlags` hold
 *      and its notice episodes ended again, since that launch can have
 *      started a sequence at a collision ladder replacement site (b.jg5
 *      SRJ-707), armed the timer, set a latch or a hold, or opened an
 *      episode after the first group. The teardown latches nothing (b.jg5
 *      SRJ-1002), so a destructive modify's new half starts unlatched and
 *      unheld;
 *   5. its Slack connection is stopped (so no further event arrives for it),
 *      then its inbound dedupe store and its ack-tracker entries are dropped;
 *   6. its cached DM destination is forgotten, its held destination notices
 *      are cancelled, and its pre-validation held notices dropped
 *      (`notifier.forget`, with its one line): only notices held before the
 *      window opened, since a notice raised in it is written, never held;
 *   7. its tracked permission prompts and wedge state are dropped (their
 *      Slack messages stay as posted);
 *   8. its registered MCP session is dropped, the registry entry before the
 *      transport closes, so the closing stream schedules no restart;
 *   9. agent-director: `cscb_<key>` is killed with the bounded retry and the
 *      result checked (b.jg5 SRJ-715, SRJ-110, SRJ-702; the injected
 *      `killInstance`): a live row it has not read, so UNAVAILABLE gets up
 *      to 3 tries 2 s apart, its `status` read between tries latches
 *      nothing, a CONFLICT is never tried again, and a `pending` row with no
 *      launch start or a latched persona's row is killed too. The outcome
 *      that stands is logged (`describeKillOutcome`, `kill_sent` included);
 *      a non-success fails the kill step, and nothing latches. The kill is
 *      no launch or recovery attempt: it arms no retry timer and starts no
 *      `tmux-unresponsive` condition, and an ENVIRONMENT or CONFIG answer
 *      raises its outage only while the persona is in the applied
 *      configuration. The retry's kill-failure alert decision (the ordinary
 *      version for `ErrTmuxKillFailed` after the tries or any failure after
 *      a survivor-naming one, the survivor version for a success after a
 *      survivor-naming failure) is raised with the context 'persona
 *      teardown' (b.jg5 SRJ-704: the server log and a startup-errors entry,
 *      never Slack). Each CONFLICT or UNUSABLE NAME answer the kill met, at
 *      a try or at a `status` read between its tries, latches nothing and is
 *      raised as one notice through the notifier, which the window writes:
 *      the kill outcome's one-line rendering with the instance id
 *      (`teardownKillRefusalNoticeText`), with no hold sentence (b.jg5
 *      SRJ-1003, SRJ-1002). A standing non-success that no other notice
 *      records (no kill-failure alert, no CONFLICT or UNUSABLE NAME notice
 *      from a try, no outage onset written for it: `outageFlags`) is raised
 *      as one notice too (`teardownKillNotSucceededNoticeText`), so the
 *      window writes it (b.jg5 SRJ-110). Either way the row is kept: a destructive
 *      modify's new half replaces it only through the live-row sequence once
 *      a later kill succeeds (b.jg5 SRJ-805). An outage flag the kill raises
 *      is kept (its onset was written in the window; b.jg5 SRJ-1002). Then
 *      its UNAVAILABLE retry timer is stopped once more, and its restart
 *      failure count, health-check streak and not-connected episode (b.f2b:
 *      its notice latch and the restart path's idle evidence) are forgotten,
 *      and its latch once more, silently (b.jg5 SRJ-715). No recovery
 *      notice is posted, no clear is logged, and nothing is retried;
 *   10. its reply-guard record is deleted and its launched-with directory
 *      forgotten (read first), then the Stop-hook launch pass re-evaluates
 *      the persona's configured and launched-with directories against the
 *      personas still applied.
 *   A removed persona has already left the applied set (apply step 1), so
 *   every launch, restart and retry path refuses it; a notice raised for it
 *   between apply step 1 and the teardown's turn is dropped by the
 *   notifier's rule for a key no longer applied, and one raised in the
 *   window is written as above. The old half of a destructive
 *   modify (SR-8.6: a `credentials_file` path or `working_directory` change)
 *   keeps its key applied until step 6 brings its new declaration up, so the
 *   applied-set guard does not refuse it. Instead:
 *   - its bring-up state and restart timer are cancelled, and its
 *     UNAVAILABLE retry timer stopped, as soon as the teardown is submitted,
 *     before its serializer turn: work already queued
 *     ahead of the teardown for the key (a restart timer's work, a bring-up
 *     retry and its launch) then finds it not up or cancelled and launches
 *     nothing, rather than launching the new declaration only for the
 *     teardown to kill it; from then until step 6 the relaunch gate and
 *     the up predicate answer not up for it, so no restart, retry or launch
 *     path starts it;
 *   - a notice raised for it between the submit and the turn routes as any
 *     configured persona's, its notice episodes' posts excepted (muted from
 *     the submit); one raised in the window is written, never posted, so
 *     none reaches its new half's destination.
 *   Each step's failure is logged and the remaining steps still run. Nothing
 *   is posted to Slack; every notice raised in the window, the kill-failure
 *   alert included, is written to the server log and a startup-errors entry.
 *   Dry run: every step runs but the kill, which is skipped with one line,
 *   so no agent-director call is made; the window routes as in a live run.
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
 *   [slack] persona teardown of "<name>" (key=<key>): agent-director kill of cscb_<key>: <outcome> after <n> kill(s); the row is kept (b.jg5 SRJ-715)
 *   [slack] persona teardown of "<name>" (key=<key>): agent-director kill of cscb_<key> failed: <outcome> after <n> kill(s) — the row is kept; nothing latches and no retry timer is armed (b.jg5 SRJ-715, SRJ-110)
 *   [slack] persona teardown of "<name>" (key=<key>): agent-director kill of cscb_<key> failed: it answered no kill outcome — the row is kept (b.jg5 SRJ-715)
 *   [slack] persona teardown of "<name>" (key=<key>): no notifier route is installed for the notice: <notice text>
 *   [slack] persona teardown of "<name>" (key=<key>): registering its submit failed: <thrown value>
 *   [slack] persona teardown of "<name>" (key=<key>): ending its submit failed: <thrown value>
 *   [slack] dry-run: persona teardown of "<name>" (key=<key>): skipping the agent-director kill of cscb_<key>; the row is kept
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
 * `<outcome>` is the outcome that stands, through `describeKillOutcome`
 * (`src/checked-kill.ts`); each try and each read between tries is logged by
 * the injected kill itself. A credentials change that cannot be used is
 * logged by the bring-up controller (`persona-credentials-change-failed`);
 * the template refresh's one line is `refreshSlackChannelBotTemplate`'s.
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
import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  isAdErrorInstance,
} from './ad-error-class.ts'
import { ErrSystemInstallDisappeared } from './agent-director-errors.ts'
import {
  KILL_REFUSAL_AT_KILL,
  KILL_REFUSAL_AT_READ,
  describeKillOutcome,
  isKillOutcome,
  killLetsNextStepRun,
  teardownKillNotSucceededNoticeText,
  teardownKillRefusalNoticeText,
  type KillFailure,
} from './checked-kill.ts'
import type { Persona, PersonaConfig } from './config.ts'
import {
  KILL_RETRY_ALERT_NONE,
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_ALERT_SURVIVOR,
  type KillRetryAlert,
} from './kill-retry.ts'
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
import type { PersonaTeardownKillRefusal, PersonaTeardownKillResult } from './session-manager.ts'

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
  /**
   * The notifier: a torn-down persona's pre-validation held notices are
   * dropped (`forget`), and its teardown window (b.jg5 SRJ-1003) is
   * registered at the submit (`submitTeardown`, ended by `settleTeardown`),
   * opened at the start of its serializer turn (`openTeardownWindow`) and
   * closed when it completes (`closeTeardownWindow`), whatever a step throws.
   * A CONFLICT or UNUSABLE NAME met by its kill, and a standing non-success
   * of its kill that no other notice records, is raised through `notify`,
   * which the open window writes. The window entries and `notify` are
   * optional, so hand-built fixtures stay valid; production passes the one
   * notifier.
   */
  notifier: Pick<PersonaNotifier, 'forget'> &
    Partial<Pick<PersonaNotifier, 'notify' | 'submitTeardown' | 'settleTeardown' | 'openTeardownWindow' | 'closeTeardownWindow'>>
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
  /**
   * Stop the key's dialog approver (b.jg5 SRJ-404, SRJ-715: production
   * `stopDialogApprover` with the teardown reason): a running one makes no
   * further call and the returned promise settles once it has stopped; the
   * approver a launch in flight would start does not start. Called first,
   * for every teardown: when the teardown is submitted, and awaited as its
   * first step, before the wait for the launch in flight, so it stops before
   * the kill. Optional, so hand-built fixtures stay valid; production always
   * passes it.
   */
  stopApprover?: (key: string) => unknown
  /**
   * Stop the key's running live-row sequence (b.jg5 SRJ-706, SRJ-715:
   * production `stopLiveRowSequence` with the teardown reason): it makes no
   * further call, and the returned promise settles once the sequence has
   * settled, its call in flight returned (a step-6 launch it had already
   * started included), so the retry-timer stop that follows clears an arm
   * that call made. Called right after `stopApprover`: when the teardown is
   * submitted, and awaited as its second step, before the wait for the
   * launch in flight; and awaited again once that launch has settled, since
   * the launch can have started a sequence at a collision ladder replacement
   * site after the first stop (b.jg5 SRJ-715, SRJ-707). Optional, so
   * hand-built fixtures stay valid; production always passes it.
   */
  stopLiveRowSequence?: (key: string) => unknown
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
   * controller's `stop` with the torn-down reason): in the teardown's first
   * group, right after the live-row sequence stop; again right after the
   * second sequence stop once the launch in flight settled (b.jg5 SRJ-715:
   * that launch can have armed it); and once more after the kill, which
   * arms none, so no timer is left armed for the key (a destructive modify's
   * key stays applied, and a timer left armed would retry against the new
   * half). For a destructive modify's old half it is also stopped when the
   * teardown is submitted. Other personas' timers stay armed. In production
   * the stop also cancels the key's `tmux-unresponsive` alert check (b.jg5
   * SRJ-309: its text says CSCB keeps retrying), its episode ended by
   * `forgetNoticeEpisodes`.
   */
  stopRetryTimer: (key: string) => unknown
  /**
   * Forget the key's old-life waits (b.jg5 SRJ-811, SRJ-810; production the
   * session manager's `forgetOldLifeWaits`): the key is forgotten from every
   * old-life hold's waiting record, so no hold's end retries it, and the wait
   * of a hold it waited on is stopped only when no persona left in the
   * applied configuration waits on that hold. The returned promise settles
   * once each wait it stopped has settled. Right after each stop of the
   * key's UNAVAILABLE retry timer before the kill: in the teardown's first
   * group, and again once its launch in flight settled, since that launch
   * can have recorded the key as waiting again. Optional, so hand-built
   * fixtures stay valid; production always passes it.
   */
  forgetOldLifeWaits?: (key: string) => unknown
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
   * End the key's notice episodes of every kind silently (b.jg5 SRJ-1016,
   * SRJ-715: the episodes instance's `forget`): in the teardown's first
   * group, right after `forgetInvalidFlagsHold`, and again once its launch
   * in flight settled, since that launch can have opened one (the CONFLICT
   * episode a latch it set began, the hold's episode included); other
   * personas' episodes stay open.
   */
  forgetNoticeEpisodes: (key: string) => unknown
  /**
   * Forget the key's latch silently (b.jg5 SRJ-504, SRJ-715: the latch
   * instance's `forget`): no post, no set observer call, no line claiming a
   * clear. In the teardown's first group, right after the retry-timer stop;
   * again once its launch in flight settled, so a latch that launch set
   * during the teardown goes too (SRJ-1002); and once more after the kill.
   * The teardown latches nothing. Other personas' latches stay.
   */
  forgetConflictLatch: (key: string) => unknown
  /**
   * Forget the key's `ErrInvalidFlags` hold silently (b.jg5 SRJ-207,
   * SRJ-715: the hold instance's `forget`): no post and no retry, so a
   * persona that is gone is never relaunched by its hold's end. Right after
   * `forgetConflictLatch` in the teardown's first group, and again once its
   * launch in flight settled, so a hold that launch set during the teardown
   * goes too; each time right before `forgetNoticeEpisodes`, which ends the
   * hold's episode. Other personas' holds stay. A key added again starts
   * unheld.
   */
  forgetInvalidFlagsHold: (key: string) => unknown
  /**
   * Forget the keys' outage flags silently (`resetAllToHealthy`): once per
   * teardown, right before its notice window opens, so a flag raised before
   * the teardown posts no all-clear and every flag raised in the window
   * survives it, its all-clear routed as its onset was (b.jg5 SRJ-1002).
   */
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
  /**
   * The teardown's kill of `cscb_<key>` (b.jg5 SRJ-715, SRJ-110, SRJ-702;
   * production `killPersonaInstanceForTeardown` on the real clock): the
   * checked kill inside the bounded retry, seeded as a live row the
   * teardown has not read, its between-try `status` read latching nothing;
   * neither arms a retry timer nor starts `tmux-unresponsive`, and a
   * CONFLICT is never tried again. Answers the retry's result (the outcome
   * that stands, `kill_sent` included, and the kill-failure alert decision)
   * and every CONFLICT or UNUSABLE NAME answer met; never throws. A success
   * (`killLetsNextStepRun`: any `kill_sent`, `ErrSpawnNotFound`, GONE, or a
   * read of the row finished) is logged; any other outcome, an answer that
   * is not an outcome, and a throw fail the kill step. Either way the row is
   * kept: nothing deletes it.
   */
  killInstance: (key: string) => Promise<PersonaTeardownKillResult>
  /**
   * Raise the kill-failure alert the teardown kill's retry decided (b.jg5
   * SRJ-704, SRJ-702, SRJ-715: production the kill-failure alerts' `raise`,
   * over the server's one episodes instance, with the context 'persona
   * teardown', so the ordinary version goes to the server log and a
   * `persona-teardown-notice` entry and the survivor version to the log and
   * a `persona-kill-survivor` entry, never to Slack). Called after the kill
   * step, only for an `ordinary` or `survivor` decision. A throw fails the
   * step and is logged.
   */
  raiseKillFailureAlert: (key: string, decision: KillRetryAlert) => unknown
  /**
   * The key's raised outage classes now (production: `getOutageFlags`,
   * `src/outage-state.ts`), read once after the teardown's kill: the outage
   * state was reset right before the window opened, so a class raised now
   * had its onset written in the window, and a standing ENVIRONMENT, CONFIG
   * or `ErrSystemInstallDisappeared` outcome whose outage is raised needs no
   * notice of its own (b.jg5 SRJ-110, SRJ-1003). Optional, so hand-built
   * fixtures stay valid: absent, an ENVIRONMENT or CONFIG outcome counts as
   * raised while the key is applied (the kill's own rule), and
   * `ErrSystemInstallDisappeared` always. A throw counts as none raised.
   */
  outageFlags?: (key: string) => ReadonlySet<string>
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

/** The teardown step that stops the persona's live-row sequence: its log label. */
export const LIVE_ROW_SEQUENCE_STOP_STEP = 'stopping its live-row sequence'

/** The teardown's second stop of the persona's live-row sequence, once its launch in flight settled: its log label. */
export const LIVE_ROW_SEQUENCE_STOP_AGAIN_STEP = 'stopping its live-row sequence again, after its launch in flight settled'

/** The suffix of each teardown step repeated once its launch in flight settled (b.jg5 SRJ-715). */
const AGAIN_AFTER_LAUNCH = 'again, after its launch in flight settled'

/**
 * The teardown step that forgets the persona's old-life waits (b.jg5
 * SRJ-811; `PersonaLifecycleDeps.forgetOldLifeWaits`): its log label. Its
 * repeat once the launch in flight settled carries the usual suffix.
 */
export const OLD_LIFE_WAITS_STEP = 'forgetting its old-life waits'

/** The teardown's last stop of the persona's UNAVAILABLE retry timer, after its kill: its log label. */
export const TEARDOWN_RETRY_TIMER_STOP_AFTER_KILL_STEP = 'stopping its UNAVAILABLE retry timer once more, after the kill'

/**
 * The kill-failure alert decision the teardown's kill answered (`killed`'s
 * `alert`, b.jg5 SRJ-704, SRJ-702), when it is one to raise: a survivor
 * decision with a string description, or an ordinary one. `none`, or no
 * decision, answers undefined; a malformed decision (or a throwing read of
 * it) answers undefined too, after one call of `malformed` saying so. Never
 * throws.
 */
function raisableKillFailureAlertOf(killed: unknown, malformed: (what: string) => void): KillRetryAlert | undefined {
  let alert: unknown
  try {
    alert = (killed as { alert?: unknown } | null | undefined)?.alert
    if (alert === undefined) return undefined
    if (typeof alert === 'object' && alert !== null) {
      const { kind } = alert as { kind?: unknown }
      if (kind === KILL_RETRY_ALERT_NONE) return undefined
      if (kind === KILL_RETRY_ALERT_ORDINARY) return alert as KillRetryAlert
      if (kind === KILL_RETRY_ALERT_SURVIVOR && typeof (alert as { survivorDescription?: unknown }).survivorDescription === 'string') {
        return alert as KillRetryAlert
      }
    }
  } catch {
    /* a throwing read is a malformed decision */
  }
  try {
    malformed('it answered a malformed kill-failure alert decision')
  } catch {
    /* a failing logger changes nothing */
  }
  return undefined
}

/**
 * The outage a teardown kill's standing non-success raises when its persona
 * is in the applied configuration (b.jg5 SRJ-110, SRJ-311, SRJ-316): an
 * ENVIRONMENT answer `tmux-unavailable`, a CONFIG answer
 * `ad-config-malformed`; `ErrSystemInstallDisappeared` (by class) raises
 * `ad-unreachable` whatever the configuration. Undefined for every other
 * outcome, which raises no outage. Never throws.
 */
function teardownKillOutageClassOf(outcome: KillFailure): string | undefined {
  try {
    if (outcome.errorClass === AD_ERROR_CLASS_ENVIRONMENT) return 'tmux-unavailable'
    if (outcome.errorClass === AD_ERROR_CLASS_CONFIG) return 'ad-config-malformed'
    if (isAdErrorInstance(outcome.error, ErrSystemInstallDisappeared)) return 'ad-unreachable'
  } catch {
    /* an unreadable value raises no outage */
  }
  return undefined
}

/**
 * The CONFLICT and UNUSABLE NAME answers the teardown's kill reported
 * (`PersonaTeardownKillResult.refusals`), each well formed; an answer with no
 * list, or entries of another shape, gives none of those. Never throws.
 */
function teardownKillRefusalsOf(killed: unknown): PersonaTeardownKillRefusal[] {
  try {
    const refusals: unknown = (killed as { refusals?: unknown } | null | undefined)?.refusals
    if (!Array.isArray(refusals)) return []
    return refusals.filter(
      (refusal): refusal is PersonaTeardownKillRefusal =>
        typeof refusal === 'object' &&
        refusal !== null &&
        (refusal.errorClass === AD_ERROR_CLASS_CONFLICT || refusal.errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) &&
        (refusal.at === KILL_REFUSAL_AT_KILL || refusal.at === KILL_REFUSAL_AT_READ),
    )
  } catch {
    return []
  }
}

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

  /**
   * Whether the teardown kill's standing non-success `outcome` had its
   * outage's onset written in the window (b.jg5 SRJ-110, SRJ-1002): its
   * outage class (`teardownKillOutageClassOf`) is raised for the key now
   * (`outageFlags`), or, with no reader, would be by the kill's own rule.
   * Never throws.
   */
  function teardownKillOutageWritten(key: string, outcome: KillFailure): boolean {
    const cls = teardownKillOutageClassOf(outcome)
    if (cls === undefined) return false
    if (deps.outageFlags === undefined) return cls === 'ad-unreachable' || isApplied(key)
    try {
      return deps.outageFlags(key).has(cls)
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Persona teardown (b.av2 SR-6.5)
  // -------------------------------------------------------------------------

  /**
   * Register the teardown's submit with the notifier (b.jg5 SRJ-1003), so
   * from now until the teardown completes the key's notice episodes post
   * nothing to Slack. Answers its end, which acts once however often it is
   * called (the teardown's completion, and the serializer's settling for a
   * turn that never ran) and answers false only when that one act failed
   * (logged), so the teardown can count it as a failed step. Never throws.
   */
  function submitTeardown(persona: Persona): () => boolean {
    const { key } = persona
    const prefix = `[slack] persona teardown of ${renderPersonaRef(persona.name, key)}`
    try {
      deps.notifier.submitTeardown?.(key)
    } catch (err) {
      log(`${prefix}: registering its submit failed: ${describeThrownValue(err)}`)
      return () => true
    }
    let settled = false
    return () => {
      if (settled) return true
      settled = true
      try {
        deps.notifier.settleTeardown?.(key)
        return true
      } catch (err) {
        log(`${prefix}: ending its submit failed: ${describeThrownValue(err)}`)
        return false
      }
    }
  }

  /**
   * Run when a teardown is submitted, before its serializer turn. For every
   * teardown, first (b.jg5 SRJ-404, SRJ-715): stop its dialog approver, and
   * the one its launch in flight would start; second, its running live-row
   * sequence (b.jg5 SRJ-706). Then (b.f2b): cancel its
   * launch's wait for a `working` row, if one is
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
   * read the applied set) only for the teardown to kill it. Every call acts
   * synchronously (the approver's and the sequence's stops are not awaited
   * here: their teardown steps await them) and runs again in the teardown's
   * own steps. A failure,
   * thrown or rejected, is logged.
   */
  function cancelBeforeTurn(persona: Persona): void {
    const { key } = persona
    const prefix = `[slack] persona teardown of ${renderPersonaRef(persona.name, key)}`
    const cancels: [string, () => unknown][] = [
      ['stopping its dialog approver', () => deps.stopApprover?.(key)],
      [LIVE_ROW_SEQUENCE_STOP_STEP, () => deps.stopLiveRowSequence?.(key)],
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

  async function runTeardown(persona: Persona, settle: () => boolean): Promise<void> {
    const { key } = persona
    const prefix = `[slack] persona teardown of ${renderPersonaRef(persona.name, key)}`
    let failed = 0
    /** A synchronous step's returned promise, settled (its rejection counted) before the complete line. */
    const pendingSteps: Promise<void>[] = []

    /** Run one step; a throw or rejection is logged and the next step still runs. */
    async function step(what: string, body: () => unknown): Promise<void> {
      try {
        await body()
      } catch (err) {
        failed++
        log(`${prefix}: ${what} failed: ${describeThrownValue(err)}`)
      }
    }

    /**
     * Run one step synchronously, awaiting nothing before the next step; a
     * throw is logged and the next step still runs. A returned promise is
     * not waited for here: it is settled before the complete line, and its
     * rejection is logged and counted then.
     */
    function syncStep(what: string, body: () => unknown): void {
      const fail = (err: unknown): void => {
        failed++
        log(`${prefix}: ${what} failed: ${describeThrownValue(err)}`)
      }
      try {
        const pending = body()
        if (pending instanceof Promise) pendingSteps.push(pending.then(() => undefined, fail))
      } catch (err) {
        fail(err)
      }
    }

    log(`${prefix}: starting`)

    // b.jg5 SRJ-1002, SRJ-1003: a clean outage slate, then the notice window,
    // with nothing awaited between them or before them: a flag raised before
    // the teardown goes silently (no all-clear), and every notice raised from
    // here until the teardown completes is written, never posted or dropped;
    // the window keeps an onset's outage marked, so its flag is not reset
    // again and its all-clear, whenever it comes, is written as the onset was.
    syncStep('forgetting its outage state', () => deps.resetOutageState([key]))
    syncStep('opening its notice window', () => deps.notifier.openTeardownWindow?.(persona))
    try {
      await runTeardownSteps(persona, prefix, step, () => {
        failed++
      })
    } finally {
      syncStep('closing its notice window', () => deps.notifier.closeTeardownWindow?.(key))
      // Its end logs its own failure; counted here as a failed step.
      if (!settle()) failed++
    }

    // Every failed step is counted before the complete line, which is last.
    if (pendingSteps.length > 0) await Promise.all(pendingSteps)
    log(failed === 0 ? `${prefix}: complete` : `${prefix}: complete, with ${failed} failed step(s)`)
  }

  /**
   * The teardown's steps inside its notice window (b.jg5 SRJ-715 order).
   * `step` runs one step, counting and logging its failure; `fail` counts a
   * failure a step's body logged itself.
   */
  async function runTeardownSteps(
    persona: Persona,
    prefix: string,
    step: (what: string, body: () => unknown) => Promise<void>,
    fail: () => void,
  ): Promise<void> {
    const { key } = persona

    // b.jg5 SRJ-715, first group, before the wait for its launch in flight.
    // b.jg5 SRJ-404: its dialog approver first, so no Enter reaches the old
    // life (the approver that launch would start does not start).
    await step('stopping its dialog approver', () => deps.stopApprover?.(key))
    // b.jg5 SRJ-706: its live-row sequence second: it makes no further call,
    // and this step waits for its call in flight, so the retry-timer stop
    // right after clears an arm that call made.
    await step(LIVE_ROW_SEQUENCE_STOP_STEP, () => deps.stopLiveRowSequence?.(key))
    await step('stopping its UNAVAILABLE retry timer', () => deps.stopRetryTimer(key))
    // b.jg5 SRJ-811: no hold's end retries a persona that is going, and a
    // wait no persona left waits on stops.
    await step(OLD_LIFE_WAITS_STEP, () => deps.forgetOldLifeWaits?.(key))
    // b.jg5 SRJ-504, SRJ-207, SRJ-1016: silently, its latch, then its
    // ErrInvalidFlags hold (no post, no retry), then its notice episodes, the
    // CONFLICT and hold episodes included, so none is left open.
    await step('forgetting its latch', () => deps.forgetConflictLatch(key))
    await step('forgetting its ErrInvalidFlags hold', () => deps.forgetInvalidFlagsHold(key))
    await step('forgetting its notice episodes', () => deps.forgetNoticeEpisodes(key))
    // Then its bring-up retries and restart timer, so nothing for the key is
    // started while the teardown waits below.
    await step('cancelling its bring-up retries', () => deps.bringUps.cancel(key))
    await step('cancelling its restart timer', () => deps.cancelRestartTimer(key))
    // b.f2b: again here, for a wait that started after the teardown was
    // submitted; the launch then settles promptly.
    await step("cancelling its launch's wait for a working row", () => deps.cancelLaunchWait?.(key))
    await step('waiting for its launch in flight', () => deps.whenLaunchSettled(key))
    // b.jg5 SRJ-715, SRJ-1002: once that launch has settled, everything it
    // can have started, armed, set or opened since the first group goes
    // again: a sequence at a collision ladder replacement site (b.jg5
    // SRJ-707, awaited, so its call in flight has returned before the kill),
    // the retry timer, a latch, an ErrInvalidFlags hold and a notice
    // episode. The teardown latches nothing.
    await step(LIVE_ROW_SEQUENCE_STOP_AGAIN_STEP, () => deps.stopLiveRowSequence?.(key))
    await step(`stopping its UNAVAILABLE retry timer ${AGAIN_AFTER_LAUNCH}`, () => deps.stopRetryTimer(key))
    await step(`${OLD_LIFE_WAITS_STEP} ${AGAIN_AFTER_LAUNCH}`, () => deps.forgetOldLifeWaits?.(key))
    await step(`forgetting its latch ${AGAIN_AFTER_LAUNCH}`, () => deps.forgetConflictLatch(key))
    await step(`forgetting its ErrInvalidFlags hold ${AGAIN_AFTER_LAUNCH}`, () => deps.forgetInvalidFlagsHold(key))
    await step(`forgetting its notice episodes ${AGAIN_AFTER_LAUNCH}`, () => deps.forgetNoticeEpisodes(key))

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

    // The outage state was reset right before the window opened, so a flag
    // raised before the teardown posts no all-clear at a successful kill; a
    // flag raised in the window (by the launch in flight or by the kill) is
    // kept, its all-clear written as its onset was (b.jg5 SRJ-1002).
    const instanceId = personaInstanceId(key)
    if (deps.dryRun) {
      log(`[slack] dry-run: persona teardown of ${renderPersonaRef(persona.name, key)}: skipping the agent-director kill of ${instanceId}; the row is kept`)
    } else {
      // b.jg5 SRJ-715, SRJ-110, SRJ-702: the kill with the bounded retry, its
      // result checked. A non-success fails this step; nothing latches and no
      // retry timer is armed. Either way the row is kept: nothing deletes it.
      const decided: {
        alert?: KillRetryAlert
        refusals: PersonaTeardownKillRefusal[]
        failure?: { outcome: KillFailure; tries: number }
      } = { refusals: [] }
      await step(`agent-director kill of ${instanceId}`, async () => {
        const killed = await deps.killInstance(key)
        decided.refusals = teardownKillRefusalsOf(killed)
        const outcome: unknown = (killed as Partial<PersonaTeardownKillResult> | undefined)?.outcome
        if (!isKillOutcome(outcome)) {
          fail()
          log(`${prefix}: agent-director kill of ${instanceId} failed: it answered no kill outcome — the row is kept (b.jg5 SRJ-715)`)
          return
        }
        decided.alert = raisableKillFailureAlertOf(killed, (what) =>
          log(`${prefix}: agent-director kill of ${instanceId}: ${what} — no kill-failure alert is raised (b.jg5 SRJ-704)`),
        )
        const tries = `after ${killed.tries} kill(s)`
        if (killLetsNextStepRun(outcome)) {
          log(`${prefix}: agent-director kill of ${instanceId}: ${describeKillOutcome(outcome)} ${tries}; the row is kept (b.jg5 SRJ-715)`)
          return
        }
        fail()
        decided.failure = { outcome, tries: killed.tries }
        log(
          `${prefix}: agent-director kill of ${instanceId} failed: ${describeKillOutcome(outcome)} ${tries} — ` +
            'the row is kept; nothing latches and no retry timer is armed (b.jg5 SRJ-715, SRJ-110)',
        )
      })
      // b.jg5 SRJ-704, SRJ-702: the retry's kill-failure alert decision, on
      // the persona-teardown route (the server log and a startup-errors
      // entry, never Slack). Only a well-formed survivor or ordinary decision
      // gets here (`raisableKillFailureAlertOf`), so nothing outside a step
      // can throw.
      // b.jg5 SRJ-1003, SRJ-1002, SRJ-715: each CONFLICT or UNUSABLE NAME
      // answer the kill met, at a try or at a status read between its tries,
      // is one notice for the key, which the open window writes (a server-log
      // line and a persona-teardown-notice entry, never Slack). Nothing
      // latched on it.
      for (const refusal of decided.refusals) {
        await step(`raising the notice for the ${refusal.errorClass} its kill met`, () => {
          const text = teardownKillRefusalNoticeText(instanceId, refusal)
          if (deps.notifier.notify === undefined) {
            log(`${prefix}: no notifier route is installed for the notice: ${text}`)
            return undefined
          }
          return deps.notifier.notify(key, text)
        })
      }
      // b.jg5 SRJ-110, SRJ-1003: a standing non-success is recorded. When no
      // other notice of the window records it (no kill-failure alert, no
      // refusal notice from a try, no outage onset written for it: an
      // ENVIRONMENT or CONFIG answer for a removed persona, an UNAVAILABLE
      // value other than ErrTmuxKillFailed, an UNCLASSIFIED value), it is
      // raised as one notice, which the open window writes. Nothing latches
      // and nothing is armed on it.
      const failure = decided.failure
      if (
        failure !== undefined &&
        decided.alert === undefined &&
        !decided.refusals.some((refusal) => refusal.at === KILL_REFUSAL_AT_KILL) &&
        !teardownKillOutageWritten(key, failure.outcome)
      ) {
        await step("raising the notice for its kill's outcome", () => {
          const text = teardownKillNotSucceededNoticeText(instanceId, failure.outcome, failure.tries)
          if (deps.notifier.notify === undefined) {
            log(`${prefix}: no notifier route is installed for the notice: ${text}`)
            return undefined
          }
          return deps.notifier.notify(key, text)
        })
      }
      const decision = decided.alert
      if (decision !== undefined) {
        await step('raising the kill-failure alert', () => deps.raiseKillFailureAlert(key, decision))
      }
    }
    // The kill arms no retry timer (b.jg5 SRJ-110); a destructive modify's
    // key stays applied, so a timer left armed would retry against the new
    // half: stopping it once more leaves none.
    await step(TEARDOWN_RETRY_TIMER_STOP_AFTER_KILL_STEP, () => deps.stopRetryTimer(key))
    await step('forgetting its restart failure count', () => deps.forgetFailures(key))
    await step('forgetting its health-check streak', () => deps.forgetDisconnectedStreak(key))
    await step('forgetting its not-connected episode', () => deps.forgetNotConnectedEpisode?.(key))
    // b.jg5 SRJ-715, SRJ-504: its latch once more, silently, after the kill.
    await step('forgetting its latch once more, after the kill', () => deps.forgetConflictLatch(key))

    // Read the launched-with dir before the teardown forgets it.
    let launchedWith: string | undefined
    await step('reading its launched-with directory', () => {
      launchedWith = deps.replyGuard.launchedWithDir(key)
    })
    await step('deleting its reply-guard record', () => deps.replyGuard.teardown(key))
    await step('re-evaluating the Stop hook in its config directories', () =>
      deps.replyGuard.launchPass([persona.claude_config_dir, launchedWith], deps.appliedPersonas()),
    )
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
      const settle = submitTeardown(persona)
      cancelBeforeTurn(persona)
      return deps.serialize(persona.key, () => runTeardown(persona, settle)).finally(settle)
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
