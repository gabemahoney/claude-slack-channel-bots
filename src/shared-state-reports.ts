/** Shared-state operator reports. All inputs are identifiers and reporting facts. */
import { SHARED_STATE_NOTICE_MAX_CHANNELS } from './delivery-constants.ts'
import { escapeSlackControlCharacters } from './slack-text-escape.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'
import {
  SHARED_STATE_SLACK_RETRY_WARNING, SHARED_STATE_STAGED_SLACK_RETRY_WARNING, SHARED_STATE_UNRESOLVED, MEMBERSHIP_EVIDENCE_UNRESOLVED,
  buildSharedStateUnresolvedLine, buildMembershipEvidenceUnresolvedLine, buildSharedStateRecoveredLine,
  type SharedStateCause, type SharedStateClosing, type SharedStateReportScope,
  type MembershipReportEvidence, type MembershipReportProblem,
} from './persona-diagnostics.ts'
import type { ChannelMode } from './config.ts'
import type { ChannelMembership, MembershipFault } from './channel-membership.ts'
import type { MembershipScanStatus } from './channel-membership-scan.ts'
import { sharedPersonaChannels, type SharedChannelAuthority, type SharedUnresolvedScope } from './shared-channels.ts'
import type { PersonaEpisodes } from './persona-episodes.ts'
import { renderPersonaRef } from './persona-identity.ts'
import type { ReloadApplyFailure } from './reload.ts'

export { SHARED_STATE_NOTICE_MAX_CHANNELS } from './delivery-constants.ts'
export { SHARED_STATE_DIAGNOSTIC_CLASSES, SHARED_STATE_SLACK_RETRY_WARNING,
  buildSharedStateDiagnostic, buildSharedStateUnresolvedLine, buildMembershipEvidenceUnresolvedLine,
  buildSharedStateRecoveredLine } from './persona-diagnostics.ts'
export type { SharedStateCause, SharedStateClosing, SharedStateReportScope,
  MembershipReportEvidence, MembershipReportProblem, MembershipHistoryEvidence } from './persona-diagnostics.ts'

const slack = (text: string): string => escapeSlackControlCharacters(redactSlackLogText(text).replace(/[\r\n\u2028\u2029]/g, ' '))
// Persona references are already JSON-quoted; configured paths are quoted at
// the call site. Neither configured field is an untrusted failure description.
const configuredSlack = (text: string): string => escapeSlackControlCharacters(text.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'))
function channelsText(channels: readonly string[]): string {
  const shown = channels.slice(0, SHARED_STATE_NOTICE_MAX_CHANNELS)
  return (shown.map(slack).join(', ') || '(none)') + (channels.length > shown.length ? ` and ${channels.length - shown.length} more` : '')
}
function scopeText(scope: SharedStateReportScope, inventory = false): string {
  return `${inventory ? 'membership inventory incomplete; known channels' : scope.all ? 'all its channels' : 'channels'}: ${channelsText(scope.channels)}${scope.dm ? '; DMs also affected' : ''}`
}
const continuing = 'Other channels and personas, and already accepted queues, keep working.'
function stagedScopeText(scope: SharedStateReportScope): string {
  const pending = scope.repairPending
  if (!pending) return `Messages in the affected channels stay held. ${continuing}`
  // Use one shared budget across both lists, so a mixed stage never doubles it.
  const held = pending.held.slice(0, SHARED_STATE_NOTICE_MAX_CHANNELS)
  const usable = pending.usable.slice(0, SHARED_STATE_NOTICE_MAX_CHANNELS - held.length)
  const list = (all: readonly string[], shown: readonly string[]) =>
    (shown.map(slack).join(', ') || '(none shown)') + (all.length > shown.length ? ` and ${all.length - shown.length} more` : '')
  return `Repair is pending for this persona. Membership decided: ${pending.usable.length ? list(pending.usable, usable) : 'none'}. ` +
    `Membership unresolved (intake held): ${pending.held.length ? list(pending.held, held) : 'none'}${scope.dm ? '; DMs are held too' : ''}. ` +
    `These lists describe membership readiness only. Thread-dependent replies in thread_hybrid channels stay held and unacknowledged while Channel Stamps are undecided. ` +
    `Otherwise eligible @mentions, Broadcasts and other intake independent of Channel Stamps continue. ${continuing}`
}
export function buildSharedStateUnresolvedNotice(persona: string, scope: SharedStateReportScope, cause: SharedStateCause, path: string, failure = ''): string {
  // The all-channel storage fallback names the inventory, not held projections.
  const inventory = cause === 'not-saved' && scope.all === true
  const problem: Record<SharedStateCause, string> = {
    unsynced: "A shared-state write was renamed but not synced. CSCB finishes it at its next configuration checks once the state directory can be synced. Check the disk and filesystem. If the file changes meanwhile, existing recovery can still finish when the exact pending bytes return and synchronization succeeds. If that recovery cannot finish, use reviewed restoration, or explicit replacement when restoration is impossible, as the debugging skill's reload-shared-recovery entry describes, then restart.",
    'evidence-changed': "The file no longer holds what CSCB wrote, so CSCB won't guess. Preserve the evidence. Existing recovery can still finish without restarting when the exact pending bytes return and synchronization succeeds. If that recovery cannot finish, use reviewed restoration, or explicit replacement when restoration is impossible, as the debugging skill's reload-shared-recovery entry describes, then restart. Choices that cannot be restored are lost and must be set again.",
    'restoration-staged': 'A reviewed restoration is staged. Restart CSCB to review and confirm it; staging alone does not complete the repair.',
    'retirement-unresolved': "A confirmed change's persona retirement could not be finished or undone. CSCB retries at each configuration check. Check the state directory's disk; the retirement must be recovered before affected intake resumes.",
    'not-saved': (inventory ? 'CSCB could not save a complete membership inventory.' : 'CSCB could not save membership evidence for these channels.') +
      " It retries reconciliation in the background. Check the state directory's disk; retries cannot restore events Slack no longer sends.",
  }
  const status = cause === 'restoration-staged' ? stagedScopeText(scope) : inventory ?
    `Verified usable channels keep working. Only intake depending on missing membership evidence stays held and unacknowledged. Recovery requires a complete membership inventory. ${continuing}` :
    `Messages there stay held. ${continuing}`
  const scopeLabel = cause === 'restoration-staged' && scope.repairPending ? 'all its channels; repair pending' : scopeText(scope, inventory)
  return `:warning: *Channel state unresolved* — ${configuredSlack(persona)}; ${scopeLabel}. Shared channel authority: ${configuredSlack(JSON.stringify(path))}${failure ? ` (${slack(failure)})` : ''}. ${problem[cause]} ${status} ${cause === 'restoration-staged' ? SHARED_STATE_STAGED_SLACK_RETRY_WARNING : SHARED_STATE_SLACK_RETRY_WARNING}`
}
export function buildMembershipEvidenceUnresolvedNotice(persona: string, scope: SharedStateReportScope, evidence: MembershipReportEvidence): string {
  const history = evidence.history ?? []
  const problems: Record<MembershipReportProblem, string> = {
    deadline: "Slack's membership list could not be read in time. CSCB retries; if this continues, check Slack's status and the workspace size.",
    access: 'The bot lacks a scope or channel access needed to read membership. Add the scope named in the debugging skill and reinstall; retries alone cannot fix it.',
    authentication: "Slack refused the bot's credentials. Fix the bot token through a confirmed configuration change; retries alone cannot fix it.",
    'installation-unverified': 'CSCB could not verify the app installation. Check the installation and its credentials; retries alone cannot fix it.',
    'malformed-page': 'Slack returned a membership page CSCB cannot read. CSCB retries; the incomplete page establishes no missing fact.',
    'current-membership-missing': "A complete scan still left current membership undecided for these channels. CSCB retries; check the debugging skill's current-membership-missing entry.",
    'eligibility-missing': "A complete scan still left channel eligibility undecided. CSCB retries; check the debugging skill's eligibility-missing entry.",
    'event-order-conflict': "A complete scan still left membership event order undecided. CSCB retries; check the debugging skill's event-order-conflict entry.",
  }
  const shownChannels = new Set(scope.channels.slice(0, SHARED_STATE_NOTICE_MAX_CHANNELS))
  const shownHistory = history.filter(item => shownChannels.has(item.channel)).slice(0, SHARED_STATE_NOTICE_MAX_CHANNELS)
  const facts = history.length ? shownHistory.map(item =>
    `${slack(item.channel)}: ${item.evidence === 'absence-order' ? 'the bot was seen absent, but CSCB cannot tell whether that leave came before or after a choice confirmed meanwhile' : 'a membership event conflicts with recorded history'}.`).join(' ') +
      (history.length > shownHistory.length ? ` And ${history.length - shownHistory.length} more channel evidence gaps; see the server log.` : '') +
      ' Retries, reconciliation and time cannot settle this history; only reviewed recovery can, through an explicit absence replacement for the channel or reviewed restoration.' : ''
  return `:warning: *Channel membership evidence unresolved* — ${configuredSlack(persona)}; ${scopeText(scope)}. ${facts}${evidence.problem ? ` ${problems[evidence.problem]}` : ''}` +
    (evidence.slackError ? ` Slack reason: ${slack(evidence.slackError)}.` : '') +
    (evidence.nextAttemptAt === undefined ? '' : ` Next attempt at: ${evidence.nextAttemptAt}.`) +
    ` Messages whose eligibility depends on this missing evidence stay held. ${continuing} Elapsed time does not establish missing evidence. ${SHARED_STATE_SLACK_RETRY_WARNING}`
}
export function buildSharedStateRecoveredNotice(persona: string, scope: SharedStateReportScope, closing: SharedStateClosing): string {
  return `:white_check_mark: *Channel state recovered* — ${configuredSlack(persona)}; ${scopeText(scope)}. ` +
    (closing === 'repair' ? "The reviewed restoration or replacement is applied and this persona's current membership is verified. " : '') +
    "The channel state and current membership for these channels are trustworthy again; held messages there are decided now. Slack retries are finite. Messages Slack stopped retrying meanwhile are not recovered; send missing messages again."
}
export function buildReloadApplyFailedNotice(persona: string, failure: Pick<ReloadApplyFailure, 'record' | 'failure'> & { path: string }): string {
  const record = failure.record === 'authority' ? `the shared channel authority at ${configuredSlack(JSON.stringify(failure.path))}` : 'the retired-key record'
  return `:warning: *Configuration change not applied* — ${configuredSlack(persona)}; could not write ${record}${failure.failure ? ` (${slack(failure.failure)})` : ''}. ` +
    'Nothing in the confirmed change was applied. This persona and every other persona keep running as before, and the change stays pending. ' +
    'Fix the cause, for example disk space or permissions, then review the pending change again and confirm it afresh; a failed confirmation is not reused.'
}

export interface SharedStateReportingDeps {
  episodes: PersonaEpisodes
  log(line: string): void
  persona(key: string): { name: string; key: string } | undefined
  authority: Pick<SharedChannelAuthority, 'readable' | 'unreadableCause' | 'unresolvedScope' | 'snapshot' | 'path' | 'failure'>
  membership: Pick<ChannelMembership, 'generation' | 'read' | 'unresolvedChannels'>
  mode(): ChannelMode
  scanStatus(key: string): MembershipScanStatus
  scanEnded(key: string): boolean
}
type SharedReportKind = typeof SHARED_STATE_UNRESOLVED | typeof MEMBERSHIP_EVIDENCE_UNRESOLVED
interface RememberedScope { channels: Set<string>; all: boolean; dm: boolean }
interface SharedReportCycle extends RememberedScope {
  scopes: Partial<Record<SharedReportKind, RememberedScope>>
  onset: boolean
  repair: boolean
  inventoryRequired: boolean
}
const stateSeverity: Record<SharedStateCause | 'repair', number> = {
  repair: -1, 'not-saved': 0, 'retirement-unresolved': 1, unsynced: 2, 'evidence-changed': 3, 'restoration-staged': 4,
}
const evidenceSeverity = (cause: string): number =>
  cause === 'event-history' || cause === 'absence-order' ? 3 :
    ['authentication', 'access', 'installation-unverified'].includes(cause) ? 2 : 1
const reportedScanProblem = (problem: MembershipScanStatus['problem']): problem is MembershipReportProblem =>
  problem !== undefined && !['transport', 'superseded', 'storage', 'history-unresolved'].includes(problem)
const emptyScope = (): RememberedScope => ({ channels: new Set(), all: false, dm: false })
const scopeOf = (scope: RememberedScope): SharedStateReportScope => ({ channels: [...scope.channels].sort(), all: scope.all, dm: scope.dm })
function remember(target: RememberedScope, scope: SharedStateReportScope): void {
  for (const channel of scope.channels) target.channels.add(channel)
  target.all ||= scope.all === true
  target.dm ||= scope.dm === true
}

/** Observes state only. All notice latches live in PersonaEpisodes; remembered
 * scopes keep a later, narrower fault from ending an earlier report too soon. */
export function createSharedStateReporting(deps: SharedStateReportingDeps) {
  const { episodes, authority, membership } = deps
  const cycles = new Map<string, SharedReportCycle>()
  let stopped = false
  const protect = (work: () => unknown): void => {
    if (stopped) return
    try { void Promise.resolve(work()).catch(() => {}) } catch { /* reporting cannot change outcomes */ }
  }
  const log = (line: string): void => protect(() => deps.log(line))
  const ref = (key: string): string => {
    const persona = deps.persona(key)
    return persona ? renderPersonaRef(persona.name, key) : `persona=${key}`
  }
  function cycleFor(key: string): SharedReportCycle {
    let cycle = cycles.get(key)
    if (!cycle) {
      cycle = { ...emptyScope(), scopes: {}, onset: false, repair: false, inventoryRequired: false }
      cycles.set(key, cycle)
    }
    return cycle
  }
  function allChannels(key: string): string[] {
    const generation = membership.generation(key)
    return [...new Set([...sharedPersonaChannels(authority.snapshot(), key),
      ...(generation?.positives.keys() ?? []), ...(generation?.absent ?? []), ...(generation?.holds.keys() ?? [])])].sort()
  }
  function onset(key: string, kind: SharedReportKind, cause: string, scope: SharedStateReportScope,
    notice: () => string, line: () => string): void {
    const cycle = cycleFor(key)
    const remembered = cycle.scopes[kind] ??= emptyScope()
    remember(remembered, scope)
    remember(cycle, scope)
    const previous = episodes.view(key, kind)
    const severity = kind === SHARED_STATE_UNRESOLVED ? (label: string) => stateSeverity[label as SharedStateCause | 'repair'] : evidenceSeverity
    if (previous && severity(cause) <= severity(previous.caseLabel ?? '')) return
    const stagingInsideEpisode = cause === 'restoration-staged' &&
      (episodes.isOpen(key, SHARED_STATE_UNRESOLVED) || episodes.isOpen(key, MEMBERSHIP_EVIDENCE_UNRESOLVED))
    if (episodes.begin(key, kind, cause) === 'closed') return
    log(line())
    if (!stagingInsideEpisode && !episodes.hasPosted(key, kind)) {
      cycle.onset = episodes.post(key, kind, notice()) || cycle.onset
    }
  }
  function reportState(key: string, scope: SharedUnresolvedScope | undefined, holds: ReadonlyMap<string, MembershipFault> | undefined,
    scan: MembershipScanStatus, endedIncomplete: boolean): boolean {
    const unsaved = [...(holds ?? [])].filter(([, fault]) => fault === 'event-not-durable').map(([channel]) => channel)
    const staged = authority.unreadableCause === 'restoration-staged'
    const storageScan = endedIncomplete && scan.problem === 'storage' && authority.readable
    const stateAffected = scope !== undefined || unsaved.length > 0 || storageScan || staged
    if (stateAffected) {
      const channels = new Set([...(scope?.channels ?? []), ...unsaved])
      let all = scope?.all ?? false
      if (storageScan) {
        const unresolved = membership.unresolvedChannels(key)
        for (const channel of unresolved) channels.add(channel)
        if (!unresolved.length) {
          all = true
          // A failed discovery write can leave a channel outside every known
          // set. Keep the inventory obligation through retries and new causes.
          cycleFor(key).inventoryRequired = true
        }
      }
      if (all || staged) for (const channel of allChannels(key)) channels.add(channel)
      const reportScope: SharedStateReportScope = { channels: [...channels].sort(), all: all || staged, dm: scope?.dm ?? false }
      if (staged) {
        const mode = deps.mode()
        const usable: string[] = [], held: string[] = []
        for (const channel of reportScope.channels) {
          const target = membership.read(key, channel, mode).kind === 'unresolved' ? held : usable
          target.push(channel)
        }
        reportScope.repairPending = { usable, held }
      }
      const cause = authority.unreadableCause ?? (scope?.all && authority.readable ? 'retirement-unresolved' : 'not-saved')
      onset(key, SHARED_STATE_UNRESOLVED, cause, reportScope,
        () => buildSharedStateUnresolvedNotice(ref(key), reportScope, cause, authority.path, authority.failure),
        () => buildSharedStateUnresolvedLine(key, reportScope, cause, authority.path, authority.failure))
    }
    return stateAffected
  }
  function reportEvidence(key: string, holds: ReadonlyMap<string, MembershipFault> | undefined,
    scan: MembershipScanStatus, endedIncomplete: boolean): boolean {
    const historyChannels = [...(holds ?? [])].filter(([, fault]) => fault === 'history-unresolved').map(([channel]) => channel)
    const scanProblem = endedIncomplete && reportedScanProblem(scan.problem) ? scan.problem : undefined
    const evidenceAffected = historyChannels.length > 0 || scanProblem !== undefined
    // History holds still keep an existing episode affected during a retry,
    // but neither onset nor escalation is justified before that scan ends.
    const scanEnded = endedIncomplete || (scan.state === 'complete' && deps.scanEnded(key))
    if (evidenceAffected && scanEnded) {
      // The conflict snapshot is needed only for history holds. Full-scope
      // reports separately read the inventory to name the persona's channels.
      const conflicts = historyChannels.length ? authority.snapshot().personas[key]?.membershipAbsenceConflicts : undefined
      const history = historyChannels.map(channel => ({ channel, evidence: Object.hasOwn(conflicts ?? {}, channel) ? 'absence-order' as const : 'event-history' as const }))
      const channels = new Set(historyChannels)
      let all = false
      if (scanProblem) {
        const unresolved = membership.unresolvedChannels(key)
        all = unresolved.length === 0
        for (const channel of all ? allChannels(key) : unresolved) channels.add(channel)
      }
      const reportScope = { channels: [...channels].sort(), all }
      const evidence: MembershipReportEvidence = { history, problem: scanProblem, slackError: scan.slackError, nextAttemptAt: scan.nextAttemptAt }
      const cause = history.some(item => item.evidence === 'event-history') ? 'event-history' : history.length ? 'absence-order' : scanProblem!
      onset(key, MEMBERSHIP_EVIDENCE_UNRESOLVED, cause, reportScope,
        () => buildMembershipEvidenceUnresolvedNotice(ref(key), reportScope, evidence),
        () => buildMembershipEvidenceUnresolvedLine(key, reportScope, evidence, authority.path, authority.failure))
    }
    return evidenceAffected
  }
  function closeReady(key: string, scope: SharedUnresolvedScope | undefined, scan: MembershipScanStatus,
    stateAffected: boolean, evidenceAffected: boolean): void {
    const cycle = cycles.get(key)
    if (!cycle) return
    const mode = deps.mode()
    const decided = (remembered: RememberedScope): boolean => {
      if ((remembered.dm && scope?.dm) || (remembered.all && scope?.all)) return false
      if (remembered.all) {
        for (const channel of allChannels(key)) remembered.channels.add(channel)
        if (membership.unresolvedChannels(key).length) return false
      }
      return [...remembered.channels].every(channel => membership.read(key, channel, mode).kind !== 'unresolved')
    }
    const open = ([SHARED_STATE_UNRESOLVED, MEMBERSHIP_EVIDENCE_UNRESOLVED] as const).filter(kind => episodes.isOpen(key, kind))
    const closing = open.filter(kind => {
      if (kind === SHARED_STATE_UNRESOLVED ? stateAffected : evidenceAffected) return false
      if ((kind === MEMBERSHIP_EVIDENCE_UNRESOLVED || cycle.repair || cycle.inventoryRequired) && scan.state !== 'complete') return false
      const remembered = cycle.scopes[kind]
      return remembered !== undefined && decided(remembered)
    })
    if (!closing.length) return
    const last = closing[closing.length - 1]!
    const finished = closing.length === open.length && decided(cycle)
    if (closing.length === open.length && !finished) return
    if (finished && (cycle.onset || cycle.repair)) {
      const closed: SharedStateClosing = cycle.repair ? 'repair' : last === SHARED_STATE_UNRESOLVED ? 'state' : 'evidence'
      if (!episodes.hasPosted(key, last, 'recovered')) {
        log(buildSharedStateRecoveredLine(key, scopeOf(cycle), closed, authority.path, authority.failure))
        episodes.post(key, last, buildSharedStateRecoveredNotice(ref(key), scopeOf(cycle), closed), 'recovered')
      }
    }
    for (const kind of closing) { episodes.end(key, kind); delete cycle.scopes[kind] }
    if (finished) cycles.delete(key)
  }
  function check(key: string): void {
    if (episodes.isClosed()) return
    const scope = authority.unresolvedScope(key)
    const holds = membership.generation(key)?.holds
    const scan = deps.scanStatus(key)
    const endedIncomplete = scan.state === 'incomplete' && deps.scanEnded(key)
    const stateOpen = episodes.isOpen(key, SHARED_STATE_UNRESOLVED)
    const evidenceOpen = episodes.isOpen(key, MEMBERSHIP_EVIDENCE_UNRESOLVED)
    if (authority.readable && scope === undefined && !holds?.size && !endedIncomplete && !stateOpen && !evidenceOpen) return

    const stateAffected = reportState(key, scope, holds, scan, endedIncomplete)
    const evidenceAffected = reportEvidence(key, holds, scan, endedIncomplete)
    closeReady(key, scope, scan, stateAffected, evidenceAffected)
  }
  return {
    check: (key: string): void => protect(() => check(key)),
    checkAll: (keys: Iterable<string>): void => protect(() => { for (const key of keys) protect(() => check(key)) }),
    repairActivated: (keys: Iterable<string>): void => protect(() => {
      for (const key of keys) protect(() => {
        if (episodes.isClosed()) return
        const cycle = cycleFor(key)
        cycle.repair = true
        const scope = { channels: allChannels(key), all: true }
        remember(cycle, scope)
        const remembered = cycle.scopes[SHARED_STATE_UNRESOLVED] ??= emptyScope()
        remember(remembered, scope)
        if (!episodes.isOpen(key, SHARED_STATE_UNRESOLVED)) episodes.begin(key, SHARED_STATE_UNRESOLVED, 'repair')
      })
    }),
    reloadApplyFailed: (failure: ReloadApplyFailure): void => protect(() => {
      for (const key of failure.personas) protect(() => {
        if (episodes.begin(key, 'reload-apply-failed', failure.fingerprint) === 'closed') return
        if (!episodes.hasPosted(key, 'reload-apply-failed')) {
          episodes.post(key, 'reload-apply-failed', buildReloadApplyFailedNotice(ref(key), { ...failure, path: authority.path }))
        }
      })
    }),
    reloadApplied: (): void => protect(() => {
      for (const key of episodes.openKeys('reload-apply-failed')) protect(() => episodes.end(key, 'reload-apply-failed'))
    }),
    forget: (key: string): void => protect(() => { cycles.delete(key) }),
    stop(): void { stopped = true; cycles.clear() },
  }
}
