/**
 * participation-recovery.ts — Startup and idle recovery of pending thread
 * participation: storage repair, root-author lookups, file roots, channel
 * evidence and own-post enrollment retries, each persona separately.
 *
 * Protection is the participation owner's and is restored synchronously at
 * its `start()`, before intake; this owner only does the network and storage
 * repair afterwards, never from an acknowledgement handler: `kick` schedules
 * a pass on the injected clock and returns. A pass runs only while the
 * persona is up on a current applied connection, and every attempt is bound
 * to that connection, its identity, the evidence's lifetime and the evidence
 * still being pending (`MetadataAttempts.run`'s guard, re-checked after each
 * await). Each request goes through the bounded metadata facility
 * (`participation-metadata.ts`), so a hung request ends by
 * `ENROLLMENT_METADATA_DEADLINE_MS`.
 *
 * Spacing: one pass runs at a time per persona. A pass ends early at its
 * first expired deadline or transient failure (the dependency looks down);
 * a request Slack rejected for a reason of its own ends only that item. A
 * pass that failed (a metadata or storage failure) sets the persona's
 * `notBefore` from the bounded retry spacing, or a greater Retry-After;
 * every later pass, whether from the timer, a kick or a kick that arrived
 * while a pass ran, starts no earlier than that. An unresolved pass re-arms
 * its timer at that spacing, or sooner for a kick that arrived meanwhile.
 * Outcomes of an own post or held reply the running pass is working on do
 * not kick it again. A gap (a deleted root, lost access, an unavailable
 * file) and anything only a new event can change (no current connection,
 * channel eligibility waiting on membership, an own root decided only
 * locally) block the recovery report but arm no timer: gaps are looked up
 * again only after the connection comes up again (`connected`) or a new
 * lifetime (`revoke`), and lost access also after a new event of that
 * channel (`channelEvent`), no sooner than `ENROLLMENT_RETRY_MIN_MS` after
 * the gap was found.
 *
 * Capability: only a gap that holds root lookups (`capabilityGapHoldsLookups`)
 * holds or re-checks anything; a missing `im:history` alone holds none and
 * ends at the next connection. While a holding gap is open and a held reply
 * waits on a lookup, the gap is re-checked at most once per
 * `ENROLLMENT_RETRY_MAX_MS`: a missing scope by re-reading the token's
 * granted scopes (`refreshScopes`, an authenticated `auth.test`), a refused
 * method by one real lookup for a held reply. Either clears the gap through
 * the capability owner when it shows the gap is gone; lookups the gap held
 * back earlier in that pass get their requests in a follow-up pass.
 *
 * Results are applied only through the owner's entries, which recheck the
 * lifetime before and after their own writes. An own root releases only its
 * own thread: the owner's settle hook re-evaluates the held replies there
 * through routing's ordinary intake path. Nothing here posts, reposts,
 * acknowledges or accepts. This owner alone decides that a persona
 * recovered: `report.recovered` is called only after a pass with nothing
 * unresolved or blocked, once its re-evaluations have finished.
 *
 * Revocation (Task 8k's contract): `revoke(key)` aborts the persona's
 * in-flight attempts and scheduled pass and invalidates every result still
 * on its way; durable pending evidence stays for the next pass, and a kick
 * after it runs once the revoked pass has ended. A lifetime superseded by a
 * leave or reset makes the owner reject that lifetime's results by itself;
 * `revoke` additionally stops the old work at once. `forget(key)`
 * (teardown) and `stop()` (shutdown) do the same and drop the persona's or
 * every persona's scheduling state.
 *
 * Importing this module starts nothing.
 *
 * SPDX-License-Identifier: MIT
 */

import type { ChannelMode, DeliveryMode } from './config.ts'
import type { DeliveryQueue } from './delivery-queue.ts'
import type { PersonaConnectionClock, PersonaEventProvenance } from './persona-connections.ts'
import { createMetadataAttempts, metadataRetryDelay, type EnrollmentMetadataMethod, type MetadataAttempts, type MetadataFailure } from './participation-metadata.ts'
import { capabilityGapHoldsLookups, resolveChannelEvidence, type MetadataCaller } from './participation-channel-evidence.ts'
import { resolveRootAuthor, rootLookupVerdict } from './participation-root-evidence.ts'
import { resolveFileRoot } from './participation-file-evidence.ts'
import type { RootLookupCapability } from './participation-capability.ts'
import {
  ELIGIBILITY_MISSING, isRootLookupIssuer, rootLookupObservationId,
  type OwnPostChannelEvidence, type OwnPostOutcome, type RootLookupVerdict, type ThreadObservation, type ThreadParticipation,
} from './thread-participation.ts'
import type { ThreadCandidate } from './persona-routing.ts'
import { ENROLLMENT_RETRY_MAX_MS, ENROLLMENT_RETRY_MIN_MS, ENROLLMENT_TIMER_MAX_MS } from './delivery-constants.ts'

/**
 * Why recovery could not settle something yet, or (`root-outside-lifetime`)
 * why a thread an own root started is not followed. Identifiers only; never
 * a body, token or raw error.
 */
export const PARTICIPATION_RECOVERY_CAUSES = [
  'storage', 'metadata', 'capability', 'root-deleted', 'access-lost', 'file-unavailable', 'root-outside-lifetime', 'root-unmatched',
] as const
export type ParticipationRecoveryCause = typeof PARTICIPATION_RECOVERY_CAUSES[number]
export interface ParticipationRecoveryFinding {
  cause: ParticipationRecoveryCause
  channel?: string
  root?: string
  file?: string
  /** A safe Slack error code or failure kind. */
  code?: string
}

export interface ParticipationRecoveryDeps {
  participation(): ThreadParticipation | undefined
  queue(): Pick<DeliveryQueue, 'threadReadable' | 'threadRepairable' | 'threadRecords' | 'compact'> | undefined
  /** Routing's held undecidable replies. */
  candidates(): ThreadCandidate[]
  /** Routing's re-evaluation entry: the ordinary receive/dedupe/fanout path; repeated calls share one run. */
  reevaluate(id: string): Promise<void>
  /** The persona's current applied connection, when it has one. */
  provenance(key: string): PersonaEventProvenance | undefined
  isUp(key: string): boolean
  /** One request on that connection (`PersonaConnectionManager.metadataCall`). */
  metadataCall(key: string, connectionId: string, method: EnrollmentMetadataMethod, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  capability: Pick<RootLookupCapability, 'gap' | 'lookupSucceeded' | 'lookupRefused' | 'recheckScopes'>
  /**
   * Re-read the granted scopes of the persona's held bot token on that
   * connection (`PersonaConnectionManager.refreshGrantedScopes`). Absent: a
   * missing scope is re-checked only at the next connection.
   */
  refreshScopes?(key: string, connectionId: string, signal: AbortSignal): Promise<unknown>
  /** The channel's applied mode and stored choice, recorded with a lookup request. */
  policy(key: string, channel: string): { mode: ChannelMode; delivery: DeliveryMode } | undefined
  report: {
    finding(key: string, finding: ParticipationRecoveryFinding): void
    /** A pass found nothing unresolved or blocked for the persona: everything recoverable is resolved and durable. */
    recovered(key: string): void
  }
  clock: PersonaConnectionClock
  /** Defaults to a fresh owner on `clock`. */
  attempts?: MetadataAttempts
}

export interface ParticipationRecovery {
  /**
   * Schedule a pass for `key` (startup, new pending evidence, a held reply),
   * no earlier than the persona's next permitted attempt. `id` names the own
   * post or held reply that asked: one the running pass is working on adds
   * nothing. Never awaits.
   */
  kick(key: string, id?: string): void
  /** The persona's connection came up: remembered gaps may have changed, so forget them, then kick. */
  connected(key: string): void
  /**
   * A new event (not a redelivery) of `channel` reached the persona: it can
   * read that channel again, so forget its lost-access gaps (one found less
   * than `ENROLLMENT_RETRY_MIN_MS` ago, once that long has passed) and kick.
   * Never awaits.
   */
  channelEvent(key: string, channel: string): void
  /** Abort the persona's attempts and scheduled pass; late results are inert. Durable evidence stays. */
  revoke(key: string): void
  /** Teardown: revoke and drop the persona's scheduling state. */
  forget(key: string): void
  /** Shutdown: abort everything; nothing runs afterwards. */
  stop(): void
  /** Resolves when the persona's running pass (if any) ends; for tests. */
  idle(key: string): Promise<void>
}

interface PersonaState {
  generation: number
  timer?: unknown
  running?: Promise<void>
  again: boolean
  failures: number
  /** The earliest clock time the next pass may start: retry spacing or Retry-After. */
  notBefore: number
  /**
   * Evidence whose lookup ended in a gap, with its channel and when it was
   * found: looked up again only after `connected` or `revoke`, or (lost
   * access) `channelEvent`, which releases it at `retryAt` when it was found
   * less than `ENROLLMENT_RETRY_MIN_MS` before.
   */
  gaps: Map<string, { channel: string; accessLost: boolean; at: number; retryAt?: number }>
  /** Own-root verdicts of lookups that decided nothing yet: applied again locally, never fetched again. */
  verdicts: Map<string, RootLookupVerdict>
  /** Own posts and held replies the running pass is working on. */
  busy: Set<string>
  /** The generation of the running pass: only its own `busy` ids ignore a kick. */
  runGeneration?: number
  /** When the open capability gap was found or last re-checked. */
  capabilityCheckedAt?: number
}

/**
 * One pass's tally. `unresolved`: what a later pass may settle (arms the
 * timer). `blocked`: what waits for a new event (blocks the recovery report
 * only). `halted`: a deadline or transient failure ended the pass early.
 * `recheckAt`: when the next capability re-check, or a released gap, is due
 * (arms the timer).
 */
interface Tally { unresolved: number; blocked: number; progressed: boolean; failed: boolean; halted: boolean; retryAfter?: number; recheckAt?: number }
const emptyTally = (): Tally => ({ unresolved: 0, blocked: 0, progressed: false, failed: false, halted: false })
/**
 * Which lookups may make a request while a capability gap is open: `remaining` of the held replies' lookups `held`.
 * `skipped`: the gate held back a lookup this pass.
 */
interface CapabilityGate { remaining: number; held: ReadonlySet<string>; skipped: boolean }

export function createParticipationRecovery(deps: ParticipationRecoveryDeps): ParticipationRecovery {
  const attempts = deps.attempts ?? createMetadataAttempts(deps.clock)
  const states = new Map<string, PersonaState>()
  let stopped = false
  const stateOf = (key: string): PersonaState => {
    let state = states.get(key)
    if (!state) {
      state = { generation: 0, again: false, failures: 0, notBefore: 0, gaps: new Map(), verdicts: new Map(), busy: new Set() }
      states.set(key, state)
    }
    return state
  }
  const protect = (run: () => void) => { try { run() } catch { /* reporting cannot change recovery */ } }
  const wait = (state: PersonaState) => Math.max(0, state.notBefore - deps.clock.now())
  /** The persona's open capability gap, when it holds root lookups. */
  const holdingGap = (key: string) => { const gap = deps.capability.gap(key); return capabilityGapHoldsLookups(gap) ? gap : undefined }
  /** Whether `id`'s gap still holds it; a released gap holds until its `retryAt`, which arms the pass's timer. */
  function gapHolds(state: PersonaState, id: string, tally: Tally): boolean {
    const gap = state.gaps.get(id)
    if (!gap) return false
    if (gap.retryAt === undefined) return true
    if (gap.retryAt <= deps.clock.now()) { state.gaps.delete(id); return false }
    tally.recheckAt = Math.min(tally.recheckAt ?? Infinity, gap.retryAt)
    return true
  }

  function clearTimer(state: PersonaState): void {
    if (state.timer !== undefined) deps.clock.clearTimeout(state.timer)
    state.timer = undefined
  }
  /** Arm the next pass after `delayMs`, in chunks no longer than one timer can hold. */
  function schedule(key: string, delayMs: number): void {
    const state = stateOf(key)
    clearTimer(state)
    const until = deps.clock.now() + Math.max(0, delayMs)
    const arm = () => {
      const remaining = until - deps.clock.now()
      if (remaining > 0) { state.timer = deps.clock.setTimeout(arm, Math.min(remaining, ENROLLMENT_TIMER_MAX_MS)); return }
      state.timer = undefined
      start(key)
    }
    state.timer = deps.clock.setTimeout(arm, Math.min(Math.max(0, delayMs), ENROLLMENT_TIMER_MAX_MS))
  }
  function start(key: string): void {
    const state = stateOf(key)
    if (stopped || states.get(key) !== state) return
    if (state.running) { state.again = true; return }
    state.again = false
    const generation = state.generation
    state.runGeneration = generation
    const run: Promise<void> = pass(key, state, generation)
      .catch((): Tally => ({ ...emptyTally(), unresolved: 1, failed: true }))
      .then(tally => {
        if (state.running === run) { state.running = undefined; state.runGeneration = undefined }
        state.busy.clear()
        if (stopped || states.get(key) !== state) return
        // A kick after a revoke (Task 8k's revoke-then-kick) waited for this revoked pass to end.
        if (state.generation !== generation) {
          if (state.again) { state.again = false; schedule(key, wait(state)) }
          return
        }
        protect(() => after(key, state, tally))
      })
    state.running = run
  }
  function after(key: string, state: PersonaState, tally: Tally): void {
    if (tally.progressed) state.failures = 0
    if (tally.unresolved > 0) {
      if (tally.failed || !tally.progressed) state.failures++
      const delay = metadataRetryDelay(Math.max(1, state.failures), tally.retryAfter)
      // Only a failure (or Retry-After) holds back every later pass; a pass that merely waits only re-arms its timer.
      if (tally.failed) state.notBefore = Math.max(state.notBefore, deps.clock.now() + delay)
      // A kick during a pass that did not fail is a new obligation: it runs as soon as permitted.
      const again = state.again
      state.again = false
      let next = again && !tally.failed ? wait(state) : Math.max(delay, wait(state))
      if (tally.recheckAt !== undefined) next = Math.min(next, Math.max(tally.recheckAt - deps.clock.now(), wait(state)))
      schedule(key, next)
      return
    }
    state.failures = 0
    if (state.again) { state.again = false; schedule(key, wait(state)); return }
    if (tally.recheckAt !== undefined) { schedule(key, Math.max(tally.recheckAt - deps.clock.now(), wait(state))); return }
    if (tally.blocked === 0) protect(() => deps.report.recovered(key))
  }

  // -------------------------------------------------------------------------
  // One pass
  // -------------------------------------------------------------------------

  async function pass(key: string, state: PersonaState, generation: number): Promise<Tally> {
    const tally = emptyTally()
    const threads = deps.participation()
    if (!threads) return { ...tally, blocked: 1 }
    const queue = deps.queue()
    // A journal not read yet is read, never rewritten; a failed read makes it repairable below.
    if (queue && !queue.threadReadable(key) && !queue.threadRepairable?.(key)) {
      try { queue.threadRecords(key) } catch { /* reported below while still unreadable */ }
    }
    // Storage first: an unreadable journal decides nothing below.
    if (queue?.threadRepairable?.(key)) {
      try { await queue.compact(key) } catch { /* reported below while still unreadable */ }
      if (stopped || state.generation !== generation) return tally
      if (queue.threadReadable(key)) tally.progressed = true
      else { tally.unresolved++; tally.failed = true; protect(() => deps.report.finding(key, { cause: 'storage' })) }
    }
    const provenance = deps.provenance(key)
    const usable = !!provenance && provenance.applied && !provenance.candidate && provenance.isCurrent() && deps.isUp(key)
    // Without a current connection nothing below can be fetched; the next connection kicks a pass.
    if (!usable) return { ...tally, blocked: tally.blocked + pendingCount(key, threads) }
    const live = () => !stopped && state.generation === generation && provenance.isCurrent() && deps.isUp(key)
    const call: MetadataCaller = (method, args, signal) => deps.metadataCall(key, provenance.connectionId, method, args, signal)
    await candidatesPass(key, threads, state, provenance, live, tally)
    const gate = await capabilityPass(key, threads, state, provenance, live, tally)
    for (const lookup of threads.rootLookups(key)) {
      if (!live()) { tally.blocked++; return tally }
      if (tally.halted) { tally.unresolved++; continue }
      await lookupPass(key, threads, state, lookup, provenance, live, call, gate, tally)
    }
    // A lookup the gate held back before a later lookup cleared the gap gets its request in the next pass.
    if (gate.skipped && !holdingGap(key)) state.again = true
    for (const finding of threads.ownPostFindings(key)) {
      if (!live()) { tally.blocked++; return tally }
      if (tally.halted) { tally.unresolved++; continue }
      await ownPostPass(key, threads, state, finding, live, call, tally)
    }
    // Threads settled during the pass re-evaluate their held replies; recovery is decided only once those ended.
    await heldPass(key, threads, state, live, tally)
    return tally
  }

  function pendingCount(key: string, threads: ThreadParticipation): number {
    return threads.rootLookups(key).length + threads.ownPostFindings(key).length + deps.candidates().filter(c => c.key === key).length
  }
  function noteFailure(tally: Tally, failure: MetadataFailure): void {
    tally.unresolved++
    if (failure.kind === 'cancelled') return
    tally.failed = true
    // Only a dependency that looks down or slow ends the pass, rather than wait one deadline per item; a
    // request rejected for its own reason leaves the later items their requests.
    if (failure.kind === 'deadline' || failure.kind === 'transient') tally.halted = true
    if (failure.kind === 'transient' && failure.retryAfter !== undefined) tally.retryAfter = Math.max(tally.retryAfter ?? 0, failure.retryAfter)
  }
  function reportFailure(key: string, failure: MetadataFailure, where: Omit<ParticipationRecoveryFinding, 'cause' | 'code'>): void {
    if (failure.kind === 'cancelled') return
    const cause: ParticipationRecoveryCause = failure.kind === 'capability' || failure.kind === 'credentials' ? 'capability' : 'metadata'
    const code = ('slackError' in failure ? failure.slackError : undefined) ?? failure.kind
    protect(() => deps.report.finding(key, { cause, ...where, code }))
  }

  /**
   * While a capability gap that holds lookups is open, which lookups may make a request this
   * pass. Only a held reply waiting on a lookup makes a re-check worth a
   * request, at most once per `ENROLLMENT_RETRY_MAX_MS` from when the gap
   * was found: a missing scope re-reads the token's granted scopes, which
   * clears the gap when they now include every required scope; a refused
   * method lets one held reply's lookup be tried again for real.
   */
  async function capabilityPass(key: string, threads: ThreadParticipation, state: PersonaState, provenance: PersonaEventProvenance,
    live: () => boolean, tally: Tally): Promise<CapabilityGate> {
    const gap = holdingGap(key)
    if (!gap) { state.capabilityCheckedAt = undefined; return { remaining: Infinity, held: new Set(), skipped: false } }
    const held = new Set(deps.candidates().filter(c => c.key === key && threads.lifetimeStatus(c.lifetime) === 'current')
      .map(c => rootLookupObservationId(c.lifetime, c.root)))
    const waiting = new Set(threads.rootLookups(key).filter(l => held.has(l.id) && !gapHolds(state, l.id, tally) && !state.verdicts.has(l.id)).map(l => l.id))
    const closed: CapabilityGate = { remaining: 0, held: waiting, skipped: false }
    if (!waiting.size || (gap.kind === 'missing-scope' && !deps.refreshScopes)) return closed
    const now = deps.clock.now()
    state.capabilityCheckedAt ??= now
    const due = state.capabilityCheckedAt + ENROLLMENT_RETRY_MAX_MS
    if (now < due) { tally.recheckAt = Math.min(tally.recheckAt ?? Infinity, due); return closed }
    state.capabilityCheckedAt = now
    if (gap.kind === 'method-refused') return { remaining: 1, held: waiting, skipped: false }
    const result = await attempts.run(key, live, signal => deps.refreshScopes!(key, provenance.connectionId, signal))
    if (!live()) return closed
    if (result.kind === 'ok') protect(() => deps.capability.recheckScopes(key))
    else { reportFailure(key, result, {}); noteFailure(tally, result) }
    if (holdingGap(key)) { tally.recheckAt = Math.min(tally.recheckAt ?? Infinity, now + ENROLLMENT_RETRY_MAX_MS); return closed }
    return { remaining: Infinity, held: waiting, skipped: false }
  }

  /**
   * Re-evaluate held replies local records now decide and wait for each: a
   * reply routing still holds afterwards is unresolved, never counted as
   * settled. It failed only if it is still decidable (its acceptance
   * failed); one routing held again because it now waits on a root lookup
   * is a new obligation, so another pass follows as soon as permitted.
   */
  async function reevaluateDecided(key: string, threads: ThreadParticipation, state: PersonaState, ids: string[], tally: Tally): Promise<void> {
    if (!ids.length) return
    for (const id of ids) state.busy.add(id)
    await Promise.all(ids.map(id => deps.reevaluate(id).catch(() => { /* the held reply stays unacknowledged for redelivery */ })))
    const still = new Map(deps.candidates().filter(c => c.key === key).map(c => [c.id, c]))
    for (const id of ids) {
      const held = still.get(id)
      if (!held) { tally.progressed = true; continue }
      tally.unresolved++
      const reading = threads.read(key, held.channel, held.root)
      if (reading.kind !== 'unresolved' || reading.failure) tally.failed = true
      else if (threads.rootLookupNeeded(key, held.channel, held.root)) state.again = true
    }
  }

  /**
   * Held replies: re-evaluate those local records now decide; request
   * lookups for those only a root lookup can decide. The replies still held
   * are counted at the end of the pass (`heldPass`), after the lookups.
   */
  async function candidatesPass(key: string, threads: ThreadParticipation, state: PersonaState, provenance: PersonaEventProvenance,
    live: () => boolean, tally: Tally): Promise<void> {
    const decided: string[] = []
    for (const held of deps.candidates()) {
      if (held.key !== key || threads.lifetimeStatus(held.lifetime) !== 'current') continue
      if (!live()) break
      const reading = threads.read(key, held.channel, held.root)
      if (reading.kind !== 'unresolved') { decided.push(held.id); continue }
      // Its thread's lookup ended in a gap: it waits for a new connection or lifetime.
      if (gapHolds(state, rootLookupObservationId(held.lifetime, held.root), tally)) continue
      // A storage fault or a pending local obligation decides this reply; no lookup can.
      if (reading.failure || !threads.rootLookupNeeded(key, held.channel, held.root)) continue
      const policy = deps.policy(key, held.channel)
      if (!policy) continue
      const issuer = { botUserId: provenance.identity.botUserId, botId: provenance.identity.botId }
      if (!isRootLookupIssuer(issuer)) {
        protect(() => deps.report.finding(key, { cause: 'metadata', channel: held.channel, root: held.root, code: 'identity-unresolved' }))
        continue
      }
      const requested = await threads.requestRootLookup(key, held.channel, held.root, issuer, policy)
      if (!requested) { tally.failed = true; protect(() => deps.report.finding(key, { cause: 'storage', channel: held.channel, root: held.root })) }
    }
    await reevaluateDecided(key, threads, state, decided, tally)
  }

  /**
   * The persona's held replies at the end of a pass, other than those it
   * already re-evaluated: ones a thread settled during the pass are
   * re-evaluated and awaited; a reply behind a gap is blocked; the rest stay
   * unresolved.
   */
  async function heldPass(key: string, threads: ThreadParticipation, state: PersonaState, live: () => boolean, tally: Tally): Promise<void> {
    const decided: string[] = []
    for (const held of deps.candidates()) {
      if (held.key !== key || state.busy.has(held.id)) continue
      if (!live()) { tally.blocked++; return }
      if (threads.lifetimeStatus(held.lifetime) !== 'current') { tally.unresolved++; continue }
      const reading = threads.read(key, held.channel, held.root)
      if (reading.kind !== 'unresolved') decided.push(held.id)
      else if (gapHolds(state, rootLookupObservationId(held.lifetime, held.root), tally)) tally.blocked++
      else tally.unresolved++
    }
    await reevaluateDecided(key, threads, state, decided, tally)
  }

  async function lookupPass(key: string, threads: ThreadParticipation, state: PersonaState, lookup: ThreadObservation,
    provenance: PersonaEventProvenance, live: () => boolean, call: MetadataCaller, gate: CapabilityGate, tally: Tally): Promise<void> {
    const channel = lookup.lifetime.channel, root = lookup.root!
    if (gapHolds(state, lookup.id, tally)) { tally.blocked++; return }
    let issuer = lookup.lookup!.issuer
    // The lookup belongs to the identity it was requested for; another identity's result proves nothing, so it is requested again for this one.
    if (issuer.botUserId !== provenance.identity.botUserId || issuer.botId !== provenance.identity.botId) {
      const current = { botUserId: provenance.identity.botUserId, botId: provenance.identity.botId }
      if (!isRootLookupIssuer(current)) {
        tally.blocked++
        protect(() => deps.report.finding(key, { cause: 'metadata', channel, root, code: 'identity-unresolved' }))
        return
      }
      state.verdicts.delete(lookup.id)
      const reissued = await threads.requestRootLookup(key, channel, root, current, { mode: lookup.policy.mode, delivery: lookup.policy.delivery! })
      if (!live()) { tally.blocked++; return }
      if (!reissued) {
        if (!threads.rootLookupOpen(key, lookup.id)) { tally.progressed = true; return }
        tally.unresolved++; tally.failed = true
        protect(() => deps.report.finding(key, { cause: 'storage', channel, root }))
        return
      }
      issuer = reissued.lookup!.issuer
    }
    const bound = () => live() && threads.rootLookupOpen(key, lookup.id)
    let verdict = state.verdicts.get(lookup.id)
    if (!verdict) {
      // An open capability gap holds only the dependent selections (reporting already named it); a re-check may let one through.
      if (holdingGap(key)) {
        if (gate.remaining <= 0 || !gate.held.has(lookup.id)) { gate.skipped = true; tally.blocked++; return }
        gate.remaining--
      }
      const evidence = await resolveRootAuthor(attempts, key, channel, root, issuer, bound, call)
      if (!bound()) { if (!live()) tally.blocked++; return }
      if (evidence.kind === 'gap' || evidence.kind === 'unresolved' || evidence.kind === 'own' || evidence.kind === 'foreign') {
        // Slack answered the method, whatever the answer shows.
        protect(() => deps.capability.lookupSucceeded(key))
      }
      if (evidence.kind === 'gap') {
        state.gaps.set(lookup.id, { channel, accessLost: evidence.reason !== 'deleted', at: deps.clock.now() })
        tally.blocked++
        protect(() => deps.report.finding(key, { cause: evidence.reason === 'deleted' ? 'root-deleted' : 'access-lost', channel, root }))
        return
      }
      if (evidence.kind === 'unresolved') { tally.unresolved++; tally.failed = true; protect(() => deps.report.finding(key, { cause: 'metadata', channel, root, code: evidence.reason })); return }
      if (evidence.kind !== 'own' && evidence.kind !== 'foreign') {
        if (evidence.kind === 'capability') {
          state.capabilityCheckedAt = deps.clock.now()
          protect(() => deps.capability.lookupRefused(key, evidence.slackError))
          // The refusal opened a gap: no other lookup this pass is let through.
          gate.remaining = 0
        } else reportFailure(key, evidence, { channel, root })
        noteFailure(tally, evidence)
        return
      }
      verdict = rootLookupVerdict(evidence)!
    }
    let outcome = await threads.resolveRootLookup(key, lookup.id, verdict)
    // Open mode's missing channel type or sharing: one authenticated channel lookup may settle it.
    const channelSettles = (o: typeof outcome) => o.kind === 'pending' && o.mode === 'open' && o.reason === ELIGIBILITY_MISSING
    if (channelSettles(outcome) && live()) {
      const channelEvidence = await channelEvidenceFor(key, channel, bound, call, tally)
      if (channelEvidence) outcome = await threads.resolveRootLookup(key, lookup.id, verdict, channelEvidence)
    }
    switch (outcome.kind) {
      // `ineligible`: replies there are re-evaluated under current eligibility; a reply once it is eligible asks afresh.
      case 'enrolled': case 'not-own': case 'followed': case 'ineligible': case 'superseded': case 'absent':
        state.verdicts.delete(lookup.id)
        tally.progressed = true
        return
      case 'outside-lifetime':
        state.verdicts.delete(lookup.id)
        tally.progressed = true
        protect(() => deps.report.finding(key, { cause: 'root-outside-lifetime', channel, root }))
        return
      case 'unmatched':
        state.verdicts.set(lookup.id, verdict)
        tally.blocked++
        protect(() => deps.report.finding(key, { cause: 'root-unmatched', channel, root }))
        return
      case 'deferred':
        // Local facts decide this; any later pass applies the verdict again without a request.
        state.verdicts.set(lookup.id, verdict)
        tally.blocked++
        return
      case 'storage':
        state.verdicts.set(lookup.id, verdict)
        tally.unresolved++
        tally.failed = true
        protect(() => deps.report.finding(key, { cause: 'storage', channel, root }))
        return
      case 'pending':
        state.verdicts.set(lookup.id, verdict)
        // Other unresolved eligibility waits on membership; no request here can settle it.
        if (channelSettles(outcome)) tally.unresolved++
        else tally.blocked++
        return
      case 'unresolved':
        tally.unresolved++
        return
    }
  }

  /** Authenticated channel evidence, only when open mode lacks exactly that. */
  async function channelEvidenceFor(key: string, channel: string, bound: () => boolean,
    call: MetadataCaller, tally: Tally): Promise<OwnPostChannelEvidence | undefined> {
    const evidence = await resolveChannelEvidence(attempts, key, channel, bound, call)
    if (evidence.kind === 'evidence') return bound() ? { channel: evidence.channel, channelType: evidence.channelType, externallyShared: evidence.externallyShared } : undefined
    if (evidence.kind === 'unresolved') { tally.failed = true; protect(() => deps.report.finding(key, { cause: 'metadata', channel, code: evidence.reason })); return undefined }
    reportFailure(key, evidence, { channel })
    if (evidence.kind !== 'cancelled') tally.failed = true
    if (evidence.kind === 'deadline' || evidence.kind === 'transient') tally.halted = true
    if (evidence.kind === 'transient' && evidence.retryAfter !== undefined) tally.retryAfter = Math.max(tally.retryAfter ?? 0, evidence.retryAfter)
    return undefined
  }

  async function ownPostPass(key: string, threads: ThreadParticipation, state: PersonaState, finding: OwnPostOutcome,
    live: () => boolean, call: MetadataCaller, tally: Tally): Promise<void> {
    const id = finding.id
    if (!id) return
    const settledKinds = (outcome: OwnPostOutcome | undefined) => outcome !== undefined && outcome.kind !== 'pending' && outcome.kind !== 'gap'
    const bound = () => live() && threads.ownPostOpen(key, id)
    let outcome: OwnPostOutcome | undefined
    if (finding.kind === 'pending' && finding.missing.includes('root')) {
      // Only a parentless file upload's share can name its root; other unknown roots wait for root lookups of their replies.
      if (!finding.file || finding.parent !== undefined || gapHolds(state, id, tally)) { tally.blocked++; return }
      state.busy.add(id)
      const evidence = await resolveFileRoot(attempts, key, finding.file, finding.channel, bound, call)
      if (!bound()) { if (!live()) tally.blocked++; return }
      if (evidence.kind === 'root') outcome = await threads.resolveOwnPostRoot(key, id, evidence.root)
      else if (evidence.kind === 'gap') {
        state.gaps.set(id, { channel: finding.channel, accessLost: evidence.reason === 'access-lost', at: deps.clock.now() })
        tally.blocked++
        const code = evidence.reason === 'unavailable' ? evidence.code : undefined
        protect(() => deps.report.finding(key, { cause: evidence.reason === 'access-lost' ? 'access-lost' : 'file-unavailable', channel: finding.channel, file: finding.file, ...(code ? { code } : {}) }))
        return
      } else if (evidence.kind === 'unresolved') {
        // No share yet, or an ambiguous one: keep the evidence pending and look again.
        tally.failed = true
      } else {
        reportFailure(key, evidence, { channel: finding.channel, file: finding.file })
        noteFailure(tally, evidence)
        return
      }
    } else if (finding.kind === 'pending' && finding.reason === ELIGIBILITY_MISSING) {
      state.busy.add(id)
      const evidence = await channelEvidenceFor(key, finding.channel, bound, call, tally)
      outcome = evidence ? await threads.retryOwnPost(key, id, evidence) : undefined
    } else {
      // A storage gap is saved again; other pending evidence re-reads current eligibility.
      state.busy.add(id)
      outcome = await threads.retryOwnPost(key, id)
    }
    if (settledKinds(outcome)) { tally.progressed = true; return }
    tally.unresolved++
    if (outcome?.kind === 'gap' || outcome?.reason === 'storage') { tally.failed = true; protect(() => deps.report.finding(key, { cause: 'storage', channel: finding.channel })) }
  }

  const api: ParticipationRecovery = {
    kick(key, id) {
      if (stopped) return
      const state = stateOf(key)
      // The running pass's own work on that post or reply reports through its tally; a revoked pass's does not.
      if (id !== undefined && state.busy.has(id) && state.runGeneration === state.generation) return
      if (state.running) { state.again = true; return }
      schedule(key, wait(state))
    },
    connected(key) {
      if (stopped) return
      stateOf(key).gaps.clear()
      api.kick(key)
    },
    channelEvent(key, channel) {
      if (stopped) return
      const gaps = states.get(key)?.gaps
      if (!gaps) return
      let cleared = false
      const now = deps.clock.now()
      // A gap is looked up again no sooner than ENROLLMENT_RETRY_MIN_MS after it was found, however many events arrive.
      for (const [id, gap] of gaps) {
        if (!gap.accessLost || gap.channel !== channel) continue
        const due = gap.at + ENROLLMENT_RETRY_MIN_MS
        if (due <= now) gaps.delete(id)
        else gap.retryAt ??= due
        cleared = true
      }
      if (cleared) api.kick(key)
    },
    revoke(key) {
      const state = states.get(key)
      attempts.revoke(key)
      if (!state) return
      state.generation++
      state.again = false
      state.gaps.clear()
      state.verdicts.clear()
      state.busy.clear()
      clearTimer(state)
    },
    forget(key) {
      api.revoke(key)
      states.delete(key)
    },
    stop() {
      stopped = true
      attempts.stop()
      for (const state of states.values()) { state.generation++; clearTimer(state) }
      states.clear()
    },
    idle: key => states.get(key)?.running ?? Promise.resolve(),
  }
  return api
}
