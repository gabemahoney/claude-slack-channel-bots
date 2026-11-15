/** Startup continuation of the existing operator request/pending/apply owner.
 * The last-applied file also holds an inert recovery stage. It is never a
 * second authority, and no staged configuration is returned to runtime. */
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseConfigJsonBytes, parsePersonaConfigBytes, readPersonaConfigBytes, referencedCredentialsPaths, resolveRealPath, type PersonaConfigFs } from './config.ts'
import { errnoSuffix, readCredentialsFile, type CredentialsFs } from './persona-credentials.ts'
import { composePendingFile, parsePendingFingerprint, reloadFingerprint, reloadReviewBinding } from './reload-fingerprint.ts'
import { parseReviewRequestBytes, REVIEW_REQUEST_SUFFIX, REVIEW_ID_RE, type OperatorIntent } from './reload-request.ts'
import { beginReviewAttempt, createReviewObserver, rejectReviewAttempt, retainReviewOutcomes, reviewLedger, reviewMatches, sharedReviewDependency, supersedeReview } from './reload-review.ts'
import { createSharedChannelAuthority, initialSharedChannelState, parseSharedChannelState, restartThreadHybridSince, serializeSharedChannelState, validThreadMemoryMarker, type SharedChannelAuthority, type SharedChannelState, type SharedMutationResult } from './shared-channels.ts'
import { readSharedRecoveryRequest, recoveryBytes, recoveryHash, recoveryIdentity, type SharedRecoveryRequest } from './shared-recovery.ts'
import { RETIRED_KEYS_WRITE_FAILED, RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY, retiredReviewRecovery, restoreReviewedRetirement, type RetiredKeyStore } from './retired-keys.ts'
import { DurableWriteUnsyncedError } from './atomic-write.ts'
import { RECOVERY_CURRENT_MEMBERSHIP, RECOVERY_LOSS, RECOVERY_PRESERVATION, RECOVERY_RESTORE, RECOVERY_THREADS_FORGOTTEN } from './reload-preview-clauses.ts'

export const RELOAD_SHARED_RECOVERY = 'reload-shared-recovery'
export interface ReloadRecoveryDeps {
  paths: { config: string; lastApplied: string; pending: string; apply: string }
  configFs?: Partial<PersonaConfigFs>
  credentialsFs?: Partial<CredentialsFs>
  home?: string
  dryRun?: boolean
  now?: () => number
  boundary?: () => string
  threadHybridSince?: () => string
  write(path: string, bytes: Uint8Array): void
  remove(path: string): unknown
  retiredKeys: RetiredKeyStore
  log(line: string): void
}
export function sharedRecoveryLine(status: string, detail = ''): string {
  return `[slack] ${RELOAD_SHARED_RECOVERY}: ${status}.${detail ? ' ' + detail : ''}`
}
/** Pure, finite preview. No credential content or damaged bytes are rendered. */
export function renderSharedRecovery(state: SharedChannelState): string {
  const recovery = state.recovery!
  if (recovery.phase === 'review' && recovery.cancelled) return `Recovery proposal cancelled. No confirmation can activate it; submit a replacement with a fresh request ID for a new review. ${RECOVERY_PRESERVATION}`
  const lines = [
    `Reviewed ${recovery.request.action}; boundary=${recovery.boundary}; local revision=${state.revision}; intent generation=${(state.pendingIntent.operator as OperatorIntent | undefined)?.generation ?? 0}.`,
    recovery.request.action === 'replace' ? RECOVERY_LOSS : RECOVERY_RESTORE,
    RECOVERY_CURRENT_MEMBERSHIP, RECOVERY_PRESERVATION,
  ]
  for (const [key, life] of Object.entries(state.personas)) {
    lines.push(`persona=${key}; ${recovery.request.action === 'replace' ? 'new' : 'retained'} incarnation=${REVIEW_ID_RE.test(life.incarnation) ? life.incarnation : '(not renderable)'}; choices=${Object.keys(life.assignments).length}.`)
    for (const [channel, assignment] of Object.entries(life.assignments)) {
      lines.push(`persona=${key}; channel=${channel}; ${recovery.request.action === 'replace' ? 'new choice' : 'restored choice'}=${assignment.delivery}` +
        (assignment.delivery === 'thread_hybrid' ? `; ${RECOVERY_THREADS_FORGOTTEN}` : '.'))
    }
  }
  lines.push('Rename this reviewed pending file to the apply name, then start again. Prepared config input is retained separately for ordinary review.')
  return lines.join('\n')
}
function read(path: string, deps: ReloadRecoveryDeps): Buffer | undefined {
  try { return readPersonaConfigBytes(path, deps.configFs) } catch { return undefined }
}
function stateFrom(bytes: Uint8Array, deps: ReloadRecoveryDeps): SharedChannelState | undefined {
  try { return parseSharedChannelState(bytes, deps.paths.lastApplied, { home: deps.home }) } catch { return undefined }
}
function fingerprint(deps: ReloadRecoveryDeps, authority: SharedChannelAuthority, input: Buffer, request: Buffer): string {
  const credentials = deps.dryRun ? [] : referencedCredentialsPaths(authority.sourceBytes(), deps.home).map(path => {
    const result = readCredentialsFile(path, deps.credentialsFs)
    return { path, content: result.ok ? result.bytes : result.missing ? 'missing' as const : 'unreadable' as const }
  })
  return reloadReviewBinding(reloadFingerprint(input, credentials), sharedReviewDependency(authority.snapshot()),
    authority.snapshot().recovery!.boundary, authority.operatorIntent().generation, [recoveryHash(request),
      authority.config().personas.map(p => [p.key, resolveRealPath(p.credentials_file), resolveRealPath(p.working_directory), p.permission_prompts])])
}
/** A marker readable from unreadable evidence is kept: losing it would hide a
 * `threads/` directory deleted at the same time. Otherwise there is none. */
function evidenceThreadMemoryMarker(evidence: Buffer): Record<string, true> | undefined {
  let value: unknown
  try { value = parseConfigJsonBytes(evidence, 'recovery evidence') } catch { return undefined }
  const marker = typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, 'threadMemoryCreated')
    ? (value as Record<string, unknown>)['threadMemoryCreated'] : undefined
  return validThreadMemoryMarker(marker) && Object.keys(marker).length ? marker : undefined
}
function prepareReplacement(request: SharedRecoveryRequest, evidence: Buffer, input: Buffer, deps: ReloadRecoveryDeps): SharedChannelState {
  if (request.action !== 'replace') throw new Error('Restoration requires a retained owner anchor.')
  const bytes = recoveryBytes(request.replacement_source_base64)!
  const config = parsePersonaConfigBytes(bytes, deps.paths.config, dirname(deps.paths.config), { home: deps.home })
  const boundary = (deps.boundary ?? randomUUID)()
  const state = initialSharedChannelState(bytes, config, () => boundary + '-' + randomUUID(), deps.threadHybridSince)
  const marker = evidenceThreadMemoryMarker(evidence)
  if (marker) state.threadMemoryCreated = marker
  state.recovery = { boundary, phase: 'review', request, evidenceBase64: evidence.toString('base64'), preparedBase64: input.toString('base64') }
  // This position records only the stage. Choices become applied on confirmation.
  state.revision++
  if (!stateFrom(serializeSharedChannelState(state), deps)) throw new Error('Invalid replacement stage.')
  return state
}
function reviseReplacement(authority: SharedChannelAuthority, request: SharedRecoveryRequest, deps: ReloadRecoveryDeps): SharedMutationResult {
  const current = authority.snapshot().recovery!
  if (current.phase !== 'review' || current.request.action !== 'replace' || request.action !== 'replace' ||
      request.evidence_sha256 !== current.request.evidence_sha256 || request.request_id === current.request.request_id ||
      current.supersededRequestIds?.includes(request.request_id) || Object.hasOwn(authority.operatorIntent().requests, request.request_id)) {
    return { kind: 'stale', revision: authority.revision }
  }
  let replacement: SharedChannelState
  try { replacement = prepareReplacement(request, recoveryBytes(current.evidenceBase64)!, recoveryBytes(current.preparedBase64)!, deps) }
  catch { return { kind: 'stale', revision: authority.revision } }
  return authority.transact(authority.revision, (next, order) => {
    // Only an unactivated cold proposal can be replaced. Preserve the original
    // evidence/input and all review/intent history in this same authority.
    next.source = replacement.source
    next.sourceBytesBase64 = replacement.sourceBytesBase64
    next.applied = replacement.applied
    next.personas = replacement.personas
    for (const life of Object.values(next.personas)) {
      life.resetOrder = order
      for (const assignment of Object.values(life.assignments)) assignment.order = order
    }
    // The snapshot's stage at this same revision, revised and no longer cancelled.
    next.recovery = { boundary: current.boundary, phase: 'review', request,
      evidenceBase64: current.evidenceBase64, preparedBase64: current.preparedBase64,
      supersededRequestIds: [...(current.supersededRequestIds ?? []), current.request.request_id] }
    supersedeReview(next, order)
  })
}
function restoreInterruptedRetirement(authority: SharedChannelAuthority, deps: ReloadRecoveryDeps): boolean {
  const interrupted = reviewLedger(authority.snapshot())?.retirement
  if (!interrupted) return true
  return restoreReviewedRetirement(deps.retiredKeys, interrupted.recovery) !== RETIRED_KEYS_WRITE_FAILED &&
    rejectReviewAttempt(authority, interrupted.fingerprint).kind === 'applied'
}
function activate(authority: SharedChannelAuthority, deps: ReloadRecoveryDeps, binding: string, input: Buffer, request: Buffer): SharedMutationResult {
  const review = reviewLedger(authority.snapshot())?.active
  const stale = (): SharedMutationResult => ({ kind: 'stale', revision: authority.revision })
  if (!review || !reviewMatches(authority.snapshot(), review) || fingerprint(deps, authority, input, request) !== binding) return stale()
  const unchanged = () => read(deps.paths.config, deps)?.equals(input) === true &&
    read(deps.paths.config + REVIEW_REQUEST_SUFFIX, deps)?.equals(request) === true && fingerprint(deps, authority, input, request) === binding
  if (!unchanged()) return stale()
  const replacement = authority.snapshot().recovery!.request.action === 'replace'
  const keys = replacement ? Object.keys(authority.snapshot().personas) : []
  const retirement = keys.length ? retiredReviewRecovery(deps.retiredKeys, keys) : undefined
  const attempt = beginReviewAttempt(authority, review, retirement)
  if (attempt.kind !== 'applied') return attempt
  const fail = (kind: 'failed' | 'stale'): SharedMutationResult => {
    if (retirement && restoreReviewedRetirement(deps.retiredKeys, retirement) === RETIRED_KEYS_WRITE_FAILED) return { kind: 'unresolved', revision: authority.revision }
    const rejected = rejectReviewAttempt(authority, review.fingerprint)
    return rejected.kind === 'applied' ? { kind, revision: authority.revision } : { kind: 'unresolved', revision: authority.revision }
  }
  if (keys.length && deps.retiredKeys.record(keys.map(key => ({ key, cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY }))).outcome === RETIRED_KEYS_WRITE_FAILED) return fail('failed')
  if (!unchanged()) return fail('stale')
  const result = authority.transact(authority.revision, (next, order) => {
    if (!reviewMatches(next, review, true) || next.recovery?.phase !== 'review' || next.recovery.cancelled) throw new Error('Obsolete recovery confirmation.')
    // Only the identity outlives activation: nothing later reads the stage's
    // bytes or request history, and keeping them would rewrite them in every
    // later application and nest them in a later stage's anchor.
    next.recovery = { boundary: next.recovery.boundary, phase: 'active', request: recoveryIdentity(next.recovery.request),
      activation: { fingerprint: review.fingerprint, order } }
    if (replacement) for (const life of Object.values(next.personas)) {
      life.resetOrder = order
      life.createdAt = (deps.now ?? Date.now)()
      for (const choice of Object.values(life.assignments)) choice.order = order
    }
    restartThreadHybridSince(next, deps.threadHybridSince)
    const ledger = reviewLedger(next)!
    ledger.outcomes[review.fingerprint] = { generation: review.generation, revision: order, status: 'consumed' }
    delete ledger.active
    delete ledger.retirement
    // The activation now pins this consumed outcome; the same application drops the rest.
    retainReviewOutcomes(next)
    // Repair consumes its gesture, never the separately pending operator intent.
  })
  if (result.kind === 'failed' || result.kind === 'stale') return fail(result.kind)
  return result
}
function unresolvedRecovery(deps: ReloadRecoveryDeps): 'unresolved' {
  deps.log(sharedRecoveryLine('durability unresolved',
    'The recovery operation may be installed. Preserve authority, retirement evidence, request, confirmation and prepared input; restart to recover the retained outcome before any new review.'))
  return 'unresolved'
}
function processRecoveryRequest(authority: SharedChannelAuthority, deps: ReloadRecoveryDeps, input: Buffer | undefined,
  requestBytes: Buffer | undefined, observe: ReturnType<typeof createReviewObserver>): 'ready' | 'pending' | 'unresolved' {
  const request = requestBytes && readSharedRecoveryRequest(requestBytes)
  if (!restoreInterruptedRetirement(authority, deps)) return unresolvedRecovery(deps)
  const cancellation = requestBytes && parseReviewRequestBytes(requestBytes)
  if (cancellation?.action === 'cancel' && authority.snapshot().recovery!.request.action === 'replace') {
    const result = authority.requestReview(cancellation, authority.sourceBytes())
    if (result.kind === 'unresolved') return unresolvedRecovery(deps)
    if (result.kind === 'failed') {
      deps.log(sharedRecoveryLine('cancellation not recorded', 'Preserve the request and evidence; retry cancellation when storage is trustworthy.'))
      return 'pending'
    }
  }
  if (input && request && !isDeepStrictEqual(request, authority.snapshot().recovery!.request)) {
    const result = reviseReplacement(authority, request, deps)
    if (result.kind === 'unresolved') return unresolvedRecovery(deps)
    if (result.kind === 'failed') {
      deps.log(sharedRecoveryLine('revision not recorded', 'The prior proposal remains inert. Preserve the request and evidence; retry revision when storage is trustworthy.'))
      return 'pending'
    }
  }
  const recovery = authority.snapshot().recovery!
  if (recovery.phase === 'review' && recovery.cancelled) {
    deps.log(sharedRecoveryLine('proposal cancelled', `No configuration is activated. Intent generation=${authority.operatorIntent().generation}; prior confirmations remain invalid. Submit a replacement with a fresh request ID for a new review. ${RECOVERY_PRESERVATION}`))
    return 'pending'
  }
  // An invalid/changed request or unreadable input revokes an old confirmation
  // durably, including change-then-revert observations across refused starts.
  if (!input || !requestBytes || !request || !isDeepStrictEqual(request, authority.snapshot().recovery!.request)) {
    const observed = observe(authority, recoveryHash(Buffer.from(JSON.stringify(['invalid-recovery-input', input && recoveryHash(input), requestBytes && recoveryHash(requestBytes)]))), false,
      authority.operatorIntent().generation, recoveryHash(input ?? Buffer.alloc(0)))
    if (observed.result?.kind === 'unresolved') return unresolvedRecovery(deps)
    deps.log(sharedRecoveryLine('request unresolved', 'The staged request and evidence remain preserved. Use the bound request or a fresh replacement request ID and review the new pending file.'))
    return 'pending'
  }
  return 'ready'
}
function reviewRecovery(authority: SharedChannelAuthority, deps: ReloadRecoveryDeps, input: Buffer,
  requestBytes: Buffer, observe: ReturnType<typeof createReviewObserver>): 'pending' | 'activated' | 'unresolved' {
  const { paths } = deps
  const binding = fingerprint(deps, authority, input, requestBytes)
  const observation = observe(authority, binding, true, authority.operatorIntent().generation, reloadFingerprint(authority.sourceBytes(), []))
  if (observation.result?.kind === 'unresolved') return unresolvedRecovery(deps)
  let review = observation.review
  if (!review) return 'pending'
  const confirmation = read(paths.apply, deps)
  if (confirmation && parsePendingFingerprint(confirmation.toString('utf8')) === review.fingerprint) {
    const result = activate(authority, deps, binding, input, requestBytes)
    if (result.kind === 'unresolved') return unresolvedRecovery(deps)
    if (result.kind === 'applied') {
      try { deps.remove(paths.apply) } catch { /* durable consumed outcome rejects replay */ }
      deps.log(sharedRecoveryLine('durable repair activated', RECOVERY_CURRENT_MEMBERSHIP))
      return 'activated'
    }
    // A definite failure spent its gesture. Review again only from the
    // retained stage after the retirement journal has been resolved.
    const refreshed = observe(authority, fingerprint(deps, authority, input, requestBytes), true,
      authority.operatorIntent().generation, reloadFingerprint(authority.sourceBytes(), []))
    if (refreshed.result?.kind === 'unresolved') return unresolvedRecovery(deps)
    review = refreshed.review
    if (!review) return 'pending'
  }
  if (confirmation) deps.log(sharedRecoveryLine('confirmation not activated', 'A fresh reviewed pending file is required; the old gesture cannot supply authority.'))
  const pending = Buffer.from(composePendingFile(review.fingerprint, renderSharedRecovery(authority.snapshot())))
  if (!read(paths.pending, deps)?.equals(pending)) deps.write(paths.pending, pending)
  deps.log(sharedRecoveryLine('review pending', `Review "${paths.pending}" before confirming. ${RECOVERY_CURRENT_MEMBERSHIP}`))
  return 'pending'
}
/** Called only before normal startup selection can expose configuration. A
 * refused start can stage/review repair without starting Slack or AD work. */
export function runStartupRecovery(deps: ReloadRecoveryDeps): 'pending' | 'activated' | 'unresolved' | 'none' {
  const { paths } = deps
  const evidence = read(paths.lastApplied, deps)
  if (!evidence) return 'none'
  let expected = evidence
  let state = stateFrom(evidence, deps)
  if (state && state.recovery?.phase !== 'review') return 'none'
  const input = read(paths.config, deps)
  const requestBytes = read(paths.config + REVIEW_REQUEST_SUFFIX, deps)
  const request = requestBytes && readSharedRecoveryRequest(requestBytes)
  if (!state) {
    if (!input || !request || request.action !== 'replace' || request.evidence_sha256 !== recoveryHash(evidence)) {
      deps.log(sharedRecoveryLine('unresolved', `No trustworthy authority anchor; evidence sha256=${recoveryHash(evidence)}. An explicit replacement request and review are required. ${RECOVERY_PRESERVATION}`))
      return 'pending'
    }
    try {
      state = prepareReplacement(request, evidence, input, deps)
      if (!read(paths.lastApplied, deps)?.equals(evidence) || !read(paths.config, deps)?.equals(input) || !read(paths.config + REVIEW_REQUEST_SUFFIX, deps)?.equals(requestBytes!)) return 'pending'
      const staged = serializeSharedChannelState(state)
      deps.write(paths.lastApplied, staged)
      expected = Buffer.from(staged)
    } catch (err) {
      deps.log(sharedRecoveryLine(err instanceof DurableWriteUnsyncedError ? 'durability unresolved' : 'stage unresolved', `Preserve evidence and input${errnoSuffix(err)}; restart to verify the retained stage before reviewing.`))
      return err instanceof DurableWriteUnsyncedError ? 'unresolved' : 'pending'
    }
  }
  const write = (path: string, bytes: Uint8Array) => {
    if (!read(path, deps)?.equals(expected) || !isDeepStrictEqual(read(paths.config, deps), input) ||
        !isDeepStrictEqual(read(paths.config + REVIEW_REQUEST_SUFFIX, deps), requestBytes)) throw new Error('Recovery authority or prepared input changed.')
    deps.write(path, bytes)
    expected = Buffer.from(bytes)
  }
  const authority = createSharedChannelAuthority(paths.lastApplied, state, { write, home: deps.home, readFs: deps.configFs, sourcePath: paths.config, now: deps.now, threadHybridSince: deps.threadHybridSince })
  const observe = createReviewObserver()
  try {
    const processed = processRecoveryRequest(authority, deps, input, requestBytes, observe)
    if (processed !== 'ready') return processed
    return reviewRecovery(authority, deps, input!, requestBytes!, observe)
  } catch (err) {
    deps.log(sharedRecoveryLine(err instanceof DurableWriteUnsyncedError ? 'durability unresolved' : 'repair unresolved', `Preserve the staged evidence and prepared input${errnoSuffix(err)}.`))
    if (err instanceof DurableWriteUnsyncedError) return 'unresolved'
  }
  return 'pending'
}
