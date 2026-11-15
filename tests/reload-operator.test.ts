import { _assignFixture, fixtureThreadHybridSince } from './test-helpers/shared-channels.ts'
import { makeDeferredConnect, makeDeferredWebApiCall, stubOpenedDmId } from './test-helpers/slack-stub.ts'
import { consumeAck } from '../src/ack-tracker.ts'
/** wc: the public request / review / rename gesture over the real authority. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PERSONA_CONFIG_FS, DELIVERY_MODES, type DeliveryMode, type PersonaInput } from '../src/config.ts'
import { buildOperatorAssignment, buildReviewRequest, composeReviewRequest, parseReviewRequestBytes, reviewIntentLine } from '../src/reload-request.ts'
import { RELOAD_REVIEW_OUTCOME, RELOAD_REVIEW_RECOVERY, reviewLedger, reviewOutcomeLine, reviewRecoveredBringUpFailedLine, reviewRecoveredLifecycleFailedLine, reviewRecoveryLine, sharedReviewDependency, type ReviewOutcome } from '../src/reload-review.ts'
import { RELOAD_STALE_CONFIRMATION, renderStaleConfirmationLogLine } from '../src/reload-apply.ts'
import { parseSharedChannelState, serializeSharedChannelState, reviewedReplacementIncarnation, type SharedChannelState, type SharedPersona } from '../src/shared-channels.ts'
import { REVIEW_OMISSION_CLAUSE, REVIEW_RETENTION_CLAUSE, REVIEW_RESET_CLAUSE } from '../src/reload-preview-clauses.ts'
import { makeReloadHarness, NO_RUN_ACTIVITY, type ReloadHarness, type ReloadRun, type ReloadRunOptions } from './test-helpers/reload-harness.ts'
import { activationOf, activationRecord, applicationState, botApplications, botAttemptAtReviewOutcome, configBytes, deliveryAttempt, sharedRecoveryRequest, withPreRuleReviewOutcomes } from './test-helpers/shared-channels.ts'
import { sharedRecoveryLine } from '../src/reload-recovery.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { membershipPage, SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { stubCallCount } from './test-helpers/agent-director-stub.ts'

const { primary: A, secondary: B, private: C } = SHARED_CHANNEL_IDS
let h: ReloadHarness
let runs: ReloadRun[]
let allowedPosts: Map<ReloadRun, unknown[]>
/** Each authority version `authorityWrites()` saw attempted, as text. Checked
 * here, outside the authority writer's catch, so a failed, unsynced, stopped
 * or later-replaced version still fails the test if it leaks. */
let attemptedAuthorities: string[]
beforeEach(() => { h = makeReloadHarness(); runs = []; allowedPosts = new Map(); attemptedAuthorities = [] })
afterEach(async () => {
  try {
    for (const run of runs) {
      expect(run.slackPosts().map(call => call.args)).toEqual(allowedPosts.get(run) ?? [])
      assertNoLeak(run.captured())
    }
    assertNoLeak({ attemptedAuthorities })
  }
  finally { for (const run of runs) await run.stop(); await h.cleanup() }
})
function persona(name = 'alpha', delivery: DeliveryMode = 'all') {
  return h.persona(name, { channels: [{ id: A, delivery }], permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' } })
}
async function start(opts: ReloadRunOptions = {}) {
  const run = await h.startDetecting({ dryRun: true, realLifecycle: true, ...opts }); runs.push(run)
  expect(run.outcome.kind).toBe('applied')
  await tick(run)
  return run
}
// Check every intermediate preview before a later tick can replace it.
async function tick(run: ReloadRun) { await run.ticks.tick(); assertNoLeak(run.captured()) }
function replyPost(channel: string, text: string, thread_ts?: string) {
  return { channel, text, thread_ts, unfurl_links: false, unfurl_media: false }
}
function authority(run: ReloadRun) { return run.controller.sharedChannels()! }
function disk() { return parseSharedChannelState(readFileSync(h.paths.lastApplied), h.paths.lastApplied)! }
function assignment(run: ReloadRun, target: PersonaInput, delivery: DeliveryMode, channel: string = A) {
  const key = h.key(target.name)
  return buildOperatorAssignment({ ...target, key }, authority(run).incarnation(key) ?? null, channel, delivery)
}
function choice(run: ReloadRun, channel: string = A, name = 'alpha') { return authority(run).choice(h.key(name), channel) }
function order(run: ReloadRun, channel: string = A, name = 'alpha') { return authority(run).snapshot().personas[h.key(name)]!.assignments[channel]?.order }
function _fixtureChoice(run: ReloadRun, delivery: DeliveryMode, channel: string = A, name = 'alpha') {
  const store = authority(run), key = h.key(name)
  expect(_assignFixture(store, key, store.incarnation(key)!, channel, delivery, store.revision, fixtureThreadHybridSince(store.snapshot())).kind).toBe('applied')
}
async function confirm(run: ReloadRun) { assertNoLeak(run.captured()); h.confirm(); await tick(run) }
async function reopen(run: ReloadRun, opts: ReloadRunOptions = {}) { await run.stop(); return start(opts) }
/** The production line for a confirmation that matches no current review. */
function staleLine() { return renderStaleConfirmationLogLine(h.paths.apply, { kind: 'mismatch' }) }

// Changed and unchanged values are declarations. Fixture choices use hk's
// one-position transaction; logical MCP retries are tested separately.
test.each(DELIVERY_MODES.flatMap(from => DELIVERY_MODES.map(to => [from, to] as const)))('declared %s → %s applies once at its durable position with byte-identical input', async (from, to) => {
  const alpha = persona('alpha', from), beta = persona('beta', 'mentions'); h.materialize(alpha, beta)
  const bytes = h.writeConfig({ personas: [alpha, beta] }), run = await start()
  const before = authority(run).snapshot(), cp = run.checkpoint()
  const request = run.request('request', [assignment(run, alpha, to)])
  await tick(run)
  expect(choice(run)).toBe(from); expect(h.readConfig()).toEqual(bytes)
  expect(order(run)).toBe(before.personas.alpha!.assignments[A]!.order)
  expect(run.since(cp).lifecycle).toEqual([])
  expect(h.pendingBody()).toContain(reviewIntentLine(1, 1))
  expect(run.lastPreviewText()).toEqual(h.pendingLines())
  const fingerprint = h.pendingFingerprint()!
  await confirm(run)
  const outcome = reviewLedger(disk())!.outcomes[fingerprint]!
  expect(outcome.status).toBe('consumed')
  expect(choice(run)).toBe(to); expect(order(run)).toBe(outcome.revision)
  expect(order(run)!).toBeGreaterThan(before.personas.alpha!.assignments[A]!.order)
  expect(authority(run).snapshot().personas.beta).toEqual(before.personas.beta)
  expect(authority(run).sourceBytes()).toEqual(bytes); expect(h.readConfig()).toEqual(bytes)
  expect(authority(run).operatorIntent()).toMatchObject({ generation: 2, requested: false, assignments: [] })
  expect(run.appliedConfigs).toHaveLength(1)
  const appliedOrder = order(run)
  h.writeRequest(request); await tick(run)
  expect(order(run)).toBe(appliedOrder); expect(run.appliedConfigs).toHaveLength(1)
  expect(h.pendingExists()).toBe(false)
  const restarted = await reopen(run)
  expect(choice(restarted)).toBe(to); expect(order(restarted)).toBe(appliedOrder)
  expect(authority(restarted).operatorIntent().requested).toBe(false)
})

test.each(['cancel', 'revise'] as const)('%s replaces durable intent, invalidates its old review and survives refresh/replay/reopen', async action => {
  const alpha = persona(); h.materialize(alpha); const bytes = h.writeConfig({ personas: [alpha] })
  let run = await start()
  const original = run.request('request', [assignment(run, alpha, 'off')]); await tick(run)
  const oldReview = h.readPending()!, oldFingerprint = h.pendingFingerprint()!, originalOrder = order(run)
  run.request(action, action === 'revise' ? [assignment(run, alpha, 'thread_hybrid')] : [])
  await tick(run)
  expect(choice(run)).toBe('all'); expect(order(run)).toBe(originalOrder)
  const requested = action === 'revise'
  expect(authority(run).operatorIntent()).toMatchObject({ generation: 2, requested })
  h.writeRequest(original); await tick(run)
  expect(authority(run).operatorIntent()).toMatchObject({ generation: 2, requested })
  run = await reopen(run)
  const replayed = run.checkpoint()
  h.writeApplyBytes(oldReview); await tick(run)
  expect(choice(run)).toBe('all'); expect(order(run)).toBe(originalOrder)
  // Cancel leaves nothing pending, so its supersession stays the outcome
  // recorded last. Reopen supersedes the revised review, which drops it.
  if (requested) expect(reviewLedger(disk())!.outcomes[oldFingerprint]).toBeUndefined()
  else expect(reviewLedger(disk())!.outcomes[oldFingerprint]!.status).toBe('superseded')
  expect(run.since(replayed).logs).toEqual([requested ? staleLine() : reviewOutcomeLine('superseded')])
  run.request('refresh'); await tick(run)
  expect(authority(run).operatorIntent().assignments.map(a => a.delivery)).toEqual(requested ? ['thread_hybrid'] : [])
  await confirm(run)
  expect(choice(run)).toBe(requested ? 'thread_hybrid' : 'all')
  expect(h.readConfig()).toEqual(bytes)
})

test.each(['stale-generation', 'duplicate-target', 'unknown-field', 'wrong-life', 'wrong-declaration', 'reused-id', 'second-request'] as const)('%s request changes no intent, choice or lifecycle', async variant => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] }); const run = await start()
  const initial = run.request('request', [assignment(run, alpha, 'off')], 'first'); await tick(run)
  const before = authority(run).snapshot(), cp = run.checkpoint()
  const valid = buildReviewRequest('second', authority(run).operatorIntent().generation, 'revise', [assignment(run, alpha, 'mentions')])
  const bad = JSON.parse(composeReviewRequest(valid))
  switch (variant) {
    case 'stale-generation': bad.intent_generation--; break
    case 'duplicate-target': bad.assignments.push(bad.assignments[0]); break
    case 'unknown-field': bad.unrecognized = true; break
    case 'wrong-life': bad.assignments[0].incarnation = 'obsolete-life'; break
    case 'wrong-declaration': bad.assignments[0].declaration.name = 'obsolete'; break
    case 'reused-id': bad.request_id = initial.request_id; break
    case 'second-request': bad.action = 'request'; break
  }
  h.writeRequestBytes(JSON.stringify(bad)); await tick(run)
  expect(authority(run).snapshot()).toEqual(before)
  expect(run.since(cp).lifecycle).toEqual([])
  expect(run.since(cp).writes).toEqual([])
  expect(run.appliedConfigs).toEqual([])
})

test('pending overwrite, automatic additions and unrelated source edits remain distinct through refresh and exact activation', async () => {
  const alpha = persona(), beta = persona('beta'); h.materialize(alpha, beta)
  h.writeConfig({ personas: [alpha, beta] }); const run = await start()
  _fixtureChoice(run, 'off')
  const replacement = { ...beta, working_directory: h.persona('new-beta').working_directory }; h.materialize(replacement)
  const bytes = h.writeConfig({ channel_mode: 'open', stop_hook_bootstrap: false, personas: [alpha, replacement] })
  run.request('request', [assignment(run, alpha, 'all')]); await tick(run)
  const oldReview = h.readPending()!
  _fixtureChoice(run, 'thread_hybrid', B)
  expect(h.readConfig()).toEqual(bytes)
  run.request('refresh'); await tick(run)
  expect(h.pendingBody()).toContain('saved=off; reviewed=all')
  expect(h.pendingBody()).toContain('saved=thread_hybrid; reviewed=thread_hybrid')
  expect(choice(run)).toBe('off'); expect(authority(run).config().channel_mode).toBe('strict')
  h.writeApplyBytes(oldReview); await tick(run); expect(choice(run)).toBe('off')
  await confirm(run)
  expect(choice(run)).toBe('all'); expect(choice(run, B)).toBe('thread_hybrid')
  expect(authority(run).sourceBytes()).toEqual(bytes); expect(h.readConfig()).toEqual(bytes)
  expect(authority(run).config()).toMatchObject({ channel_mode: 'open', stop_hook_bootstrap: false })
  expect(authority(run).config().personas.find(p => p.name === 'beta')!.working_directory).toBe(replacement.working_directory)
})

test.each(['whitespace', 'default', 'mode', 'setting', 'omitted'] as const)('%s-only confirmation takes no assignment position and preserves automatic choices', async edit => {
  const alpha = persona(); h.materialize(alpha); const original = h.writeConfig({ personas: [alpha] }); const run = await start()
  _fixtureChoice(run, 'off'); _fixtureChoice(run, 'thread_hybrid', B)
  const beforeOrders = authority(run).snapshot().personas.alpha!.assignments
  if (edit === 'whitespace') h.writeConfigBytes(Buffer.concat([original, Buffer.from('\n')]))
  else h.writeConfig({ ...(edit === 'default' ? { channel_mode: 'strict' } : edit === 'mode' ? { channel_mode: 'open' } : {}),
    personas: [{ ...alpha, ...(edit === 'setting' ? { stop_hook_bootstrap: false } : {}), ...(edit === 'omitted' ? { channels: [] } : {}) }] })
  await tick(run)
  if (edit === 'omitted') expect(h.pendingBody()).toContain(REVIEW_OMISSION_CLAUSE)
  await confirm(run)
  expect(authority(run).snapshot().personas.alpha!.assignments).toEqual(beforeOrders)
  expect(choice(run)).toBe('off'); expect(choice(run, B)).toBe('thread_hybrid')
})

test.each(['config', 'credentials'] as const)('observed %s change/revert cannot resurrect an old review in-process or after reopen', async changed => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  let run = await start({ dryRun: false })
  run.request('request', [assignment(run, alpha, 'off')]); await tick(run)
  const old = h.readPending()!, oldFp = h.pendingFingerprint()!
  const saved = h.readConfig()!, restoreCredentials = h.saveCredentials(alpha)
  if (changed === 'config') h.writeConfigBytes(Buffer.concat([saved, Buffer.from('\n')]))
  else h.rotateCredentials(alpha)
  await tick(run)
  h.writeConfigBytes(saved); restoreCredentials(); await tick(run)
  expect(h.pendingFingerprint()).not.toBe(oldFp)
  h.writeApplyBytes(old); await tick(run); expect(choice(run)).toBe('all')
  run = await reopen(run, { dryRun: false })
  h.writeApplyBytes(old); await tick(run); expect(choice(run)).toBe('all')
  expect(authority(run).operatorIntent().requested).toBe(true)
  await confirm(run); expect(choice(run)).toBe('off')
})

test('consumed-file replay after cleanup failure, automatic write and reopen never repeats the assignment', async () => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] }); let run = await start()
  run.request('request', [assignment(run, alpha, 'off')]); await tick(run)
  const old = h.readPending()!, fingerprint = h.pendingFingerprint()!
  h.failRemoves(); await confirm(run)
  expect(choice(run)).toBe('off'); expect(h.applyExists()).toBe(true)
  _fixtureChoice(run, 'mentions'); const writtenOrder = order(run)
  h.clearRemoveFailure(); run = await reopen(run)
  h.writeApplyBytes(old); await tick(run)
  expect(choice(run)).toBe('mentions'); expect(order(run)).toBe(writtenOrder)
  expect(reviewLedger(disk())!.outcomes[fingerprint]!.status).toBe('consumed')
  expect(run.logs).toContain(reviewOutcomeLine('consumed'))
})

test('same-value automatic write invalidates a dependent review without retiring a replacement', async () => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] }); const run = await start()
  const replacement = { ...alpha, working_directory: h.persona('replacement').working_directory }; h.materialize(replacement)
  h.writeConfig({ personas: [replacement] }); run.request('request', [assignment(run, replacement, 'all')]); await tick(run)
  const old = h.readPending()!, before = authority(run).incarnation('alpha')
  _fixtureChoice(run, 'all'); const cp = run.checkpoint()
  h.writeApplyBytes(old); await tick(run)
  expect(authority(run).incarnation('alpha')).toBe(before)
  expect(run.retiredKeys.keys()).toEqual([]); expect(run.since(cp).lifecycle).toEqual([])
  expect(authority(run).operatorIntent().requested).toBe(true)
})

test.each(['copied', 'retained', 'different'] as const)('stable replacement %s choices use the exact reviewed target without publishing a preview lifetime', async declaration => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] }); let run = await start()
  const oldLife = authority(run).lifetime('alpha', A)!, replacement = { ...alpha, working_directory: h.persona('replacement').working_directory }
  h.materialize(replacement); const bytes = h.writeConfig({ channel_mode: 'open', personas: [replacement] })
  if (declaration !== 'copied') run.request('request', [assignment(run, replacement, declaration === 'retained' ? 'all' : 'off')])
  await tick(run)
  const planned = authority(run).planReviewed(bytes, authority(run).declaredAssignments(bytes))
  const intents = authority(run).declaredAssignments(bytes)
  for (let n = 0; n < 3; n++) { await tick(run); expect(authority(run).planReviewed(bytes, intents)).toEqual(planned) }
  expect(authority(run).lifetime('alpha', A)).toEqual(oldLife)
  expect(h.pendingBody()).toContain(declaration === 'copied' ? REVIEW_RESET_CLAUSE : REVIEW_RETENTION_CLAUSE)
  const target = reviewedReplacementIncarnation(authority(run).snapshot(), authority(run).path, planned.config.personas[0]!)
  await confirm(run)
  expect(authority(run).incarnation('alpha')).not.toBe(oldLife.incarnation)
  expect(authority(run).incarnation('alpha')).toBe(target)
  expect(choice(run)).toBe(declaration === 'copied' ? undefined : declaration === 'retained' ? 'all' : 'off')
  expect(authority(run).readableFor('alpha', A)).toBe(true)
  expect(authority(run).lifetime('alpha', A)).not.toEqual(oldLife)
  expect(disk().personas.alpha).toMatchObject({ membership: {}, leaves: {}, removedDestinations: {}, membershipEvents: {} })
  const life = authority(run).lifetime('alpha', A)
  run = await reopen(run)
  expect(authority(run).lifetime('alpha', A)).toEqual(life)
  expect(authority(run).sourceBytes()).toEqual(bytes)
})

test.each(['working_directory', 'credentials_file', 'same-key-name', 'rename-back', 'remove-readd'] as const)('%s establishes fresh lifetimes even when the original declaration returns', async change => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] }); const run = await start()
  const original = authority(run).incarnation('alpha')
  const changed = change === 'same-key-name' ? { ...alpha, name: 'Alpha' } : change === 'rename-back' ? { ...alpha, name: 'renamed' } :
    change === 'remove-readd' ? undefined : { ...alpha, [change]: h.persona('replacement')[change] }
  if (changed) h.materialize(changed)
  h.writeConfig({ personas: changed ? [changed] : [] }); await tick(run); await confirm(run)
  expect(authority(run).incarnation('alpha')).not.toBe(original)
  h.writeConfig({ personas: [alpha] }); await tick(run); await confirm(run)
  expect(authority(run).incarnation('alpha')).not.toBe(original); expect(choice(run)).toBeUndefined()
})

test.each(['real-path', 'credential-content'] as const)('%s preserves life and automatic choice through confirmation', async kind => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] }); const run = await start({ dryRun: false })
  _fixtureChoice(run, 'off'); const life = authority(run).lifetime('alpha', A), beforeOrder = order(run)
  if (kind === 'credential-content') h.rotateCredentials(alpha)
  else {
    const alias = join(h.root, 'work-alias'); symlinkSync(alpha.working_directory, alias)
    h.writeConfig({ personas: [{ ...alpha, working_directory: alias }] })
  }
  await tick(run); await confirm(run)
  expect(authority(run).lifetime('alpha', A)).toEqual(life)
  expect(choice(run)).toBe('off'); expect(order(run)).toBe(beforeOrder)
})

test('startup confirmation requires fresh authenticated membership; later membership observation invalidates that fresh review', async () => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ channel_mode: 'open', personas: [alpha] })
  const opts: ReloadRunOptions = { dryRun: false, slack: { alpha: { inventory: [membershipPage([A])] } } }
  let run = await start(opts)
  await run.membershipClock.runNext(); await run.membershipClock.flush()
  expect(run.membership.read('alpha', A, 'open').kind).toBe('eligible')
  run.request('request', [assignment(run, alpha, 'off')]); await tick(run)
  const stoppedReview = h.readPending()!
  run = await reopen(run, opts)
  h.writeApplyBytes(stoppedReview); await tick(run); expect(choice(run)).toBe('all')
  const beforeScan = h.readPending()!
  await run.membershipClock.runNext(); await run.membershipClock.flush()
  expect(run.membership.read('alpha', A, 'open').kind).toBe('eligible')
  h.writeApplyBytes(beforeScan); await tick(run); expect(choice(run)).toBe('all')
  await confirm(run); expect(choice(run)).toBe('off')
})

test.each(['before-request', 'before-review', 'before-attempt', 'before-activation', 'after-activation'] as const)('interruption %s reopens durable intent or exactly one complete outcome', async phase => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  let armed = false
  const run = await start({ stopBeforeWrite: (path, bytes) => {
    if (!armed || path !== h.paths.lastApplied) return false
    const state = parseSharedChannelState(bytes, path)!, ledger = reviewLedger(state)
    const pending = state.pendingIntent.operator as { generation?: number } | undefined
    const status = Object.values(ledger?.outcomes ?? {}).at(-1)?.status
    return phase === 'before-request' ? pending?.generation === 1 :
      phase === 'before-review' ? !!ledger?.active && !status :
      phase === 'before-attempt' ? status === 'attempted' :
      phase === 'before-activation' ? status === 'consumed' : status === 'consumed' && !ledger?.active
  } })
  // For the last case snapshot the first write after the activation, retaining
  // the consumed transaction itself and simulating loss of result/cleanup.
  const store = authority(run)
  const original = store.snapshot()
  const input = h.writeConfig({ channel_mode: 'open', personas: [{ ...alpha, stop_hook_bootstrap: false }] })
  run.request('request', [assignment(run, alpha, 'off')]); armed = phase === 'before-request' || phase === 'before-review'
  await tick(run)
  if (phase !== 'before-request' && phase !== 'before-review') {
    armed = phase !== 'after-activation'
    h.confirm()
    if (phase === 'after-activation') {
      const unsubscribe = store.subscribe(() => { if (choice(run) === 'off') { armed = true; unsubscribe() } })
    }
    await tick(run)
  }
  expect(run.stoppedBeforeWrite).toBe(true)
  await run.stop()
  // The request file itself survives a crash; remove it to distinguish its
  // saved intent from processing a still-unrecorded operation on restart.
  h.remove(h.requestPath)
  const reopened = await start()
  const committed = phase === 'after-activation'
  expect(choice(reopened)).toBe(committed ? 'off' : 'all')
  expect(authority(reopened).config().channel_mode).toBe(committed ? 'open' : 'strict')
  expect(authority(reopened).config().personas[0]!.stop_hook_bootstrap).toBe(!committed)
  expect(authority(reopened).sourceBytes()).toEqual(committed ? input : Buffer.from(original.sourceBytesBase64, 'base64'))
  expect(h.readConfig()).toEqual(input)
  expect(authority(reopened).operatorIntent().requested).toBe(!committed && phase !== 'before-request')
  const beforeOrder = order(reopened)
  await reopened.ticks.tick(); expect(order(reopened)).toBe(beforeOrder)
})

test.each(['unchanged', 'changed'] as const)('post-rename uncertainty recovers only the exact prepared transaction with %s evidence', async evidence => {
  const alpha = persona(), beta = persona('beta'); h.materialize(alpha, beta); h.writeConfig({ personas: [alpha, beta] })
  let armed = false, activated = false
  const run = await start({ beforeWrite(path, bytes) {
    if (!armed || path !== h.paths.lastApplied) return
    const state = parseSharedChannelState(bytes, path)!
    if (Object.values(reviewLedger(state)?.outcomes ?? {}).some(o => o.status === 'consumed')) {
      activated = true; armed = false; h.failWrites({ step: 'fsyncSync', call: 2 })
    }
  } })
  run.request('request', [assignment(run, alpha, 'off')]); await tick(run)
  const fp = h.pendingFingerprint()!, oldOrder = order(run), oldBeta = authority(run).snapshot().personas.beta
  const cp = run.checkpoint(); armed = true; await confirm(run)
  expect(activated).toBe(true); expect(authority(run).readable).toBe(false)
  expect(choice(run)).toBe('all'); expect(order(run)).toBe(oldOrder)
  const preparedBytes = readFileSync(h.paths.lastApplied), prepared = disk()
  const committedOrder = prepared.personas.alpha!.assignments[A]!.order
  expect(reviewLedger(prepared)!.outcomes[fp]).toMatchObject({ status: 'consumed', revision: committedOrder })
  expect(run.since(cp).lifecycle).toEqual([])
  expect(authority(run).readableFor('alpha', A)).toBe(false)
  expect(authority(run).readableFor('beta', A)).toBe(true)
  expect(authority(run).snapshot().personas.beta).toEqual(oldBeta)
  expect(_assignFixture(authority(run), 'beta', authority(run).incarnation('beta')!, A, 'off', authority(run).revision, fixtureThreadHybridSince(authority(run).snapshot())).kind).toBe('unresolved')
  if (evidence === 'changed') writeFileSync(h.paths.lastApplied, Buffer.concat([preparedBytes, Buffer.from('\n')]))
  h.clearWriteFailure()
  await tick(run)
  if (evidence === 'changed') {
    expect(authority(run).readable).toBe(false); expect(choice(run)).toBe('all')
    expect(run.since(cp).lifecycle).toEqual([])
    // Restoring the exact bytes is explicit operator evidence restoration,
    // never an inferred rollback by the controller.
    writeFileSync(h.paths.lastApplied, preparedBytes); await tick(run)
  }
  expect(authority(run).readable).toBe(true); expect(choice(run)).toBe('off'); expect(order(run)).toBe(committedOrder)
  expect(reviewLedger(disk())!.outcomes[fp]).toEqual(reviewLedger(prepared)!.outcomes[fp])
  expect(run.since(cp).lifecycle).toEqual([{ op: 'update-in-place', key: 'alpha', via: 'apply', settings: ['delivery'] }])
  expect(run.appliedConfigs).toHaveLength(1)
  await tick(run); expect(order(run)).toBe(committedOrder); expect(run.appliedConfigs).toHaveLength(1)
  const reopened = await reopen(run)
  expect(choice(reopened)).toBe('off'); expect(order(reopened)).toBe(committedOrder)
})

test('definite activation failure spends the review, preserves unrelated retirement and pending intent, then accepts a fresh confirmation', async () => {
  const alpha = persona(), beta = persona('beta'); h.materialize(alpha, beta); h.writeConfig({ personas: [alpha, beta] })
  let armed = false
  const run = await start({ beforeWrite(path, bytes) {
    if (!armed || path !== h.paths.lastApplied) return
    const next = parseSharedChannelState(bytes, path)!
    if (Object.values(reviewLedger(next)?.outcomes ?? {}).some(o => o.status === 'consumed')) {
      armed = false; h.failWrites({ step: 'renameSync', call: 1 })
    }
  } })
  run.retiredKeys.record([{ key: 'unrelated', cause: 'removed' }])
  const oldLife = authority(run).lifetime('alpha', A), replacement = { ...alpha, working_directory: h.persona('replacement').working_directory }
  h.materialize(replacement); const bytes = h.writeConfig({ channel_mode: 'open', personas: [replacement, beta] })
  run.request('request', [assignment(run, replacement, 'all')]); await tick(run)
  const old = h.readPending()!, fingerprint = h.pendingFingerprint()!, cp = run.checkpoint()
  armed = true; await confirm(run)
  expect(authority(run).lifetime('alpha', A)).toEqual(oldLife)
  expect(run.retiredKeys.keys()).toEqual(['unrelated']); expect(run.since(cp).lifecycle).toEqual([])
  expect(reviewLedger(disk())!.outcomes[fingerprint]!.status).toBe('rejected')
  expect(authority(run).operatorIntent().requested).toBe(true); expect(h.readConfig()).toEqual(bytes)
  h.clearWriteFailure()
  const restarted = await reopen(run)
  h.writeApplyBytes(old); await restarted.ticks.tick()
  expect(authority(restarted).lifetime('alpha', A)).toEqual(oldLife)
  await confirm(restarted)
  expect(authority(restarted).incarnation('alpha')).not.toBe(oldLife!.incarnation)
  expect(choice(restarted)).toBe('all'); expect(authority(restarted).config().channel_mode).toBe('open')
})

test('publication observers see complete mode, settings, choices and lifetime, and cannot interleave an automatic write', async () => {
  const alpha = persona(), beta = persona('beta'); h.materialize(alpha, beta); h.writeConfig({ personas: [alpha, beta] }); const run = await start()
  const store = authority(run), oldLife = store.incarnation('alpha')
  const replacement = { ...alpha, working_directory: h.persona('replacement').working_directory, stop_hook_bootstrap: false }; h.materialize(replacement)
  const bytes = h.writeConfig({ channel_mode: 'open', personas: [replacement, beta] })
  run.request('request', [assignment(run, replacement, 'thread_hybrid')]); await tick(run)
  const observed: unknown[] = []
  const unsubscribe = store.subscribe(config => {
    observed.push({ mode: config.channel_mode, delivery: choice(run), life: store.incarnation('alpha'), stop: config.personas[0]!.stop_hook_bootstrap,
      consumer: run.serverConfig()!.personas[0]!.channels, source: store.sourceBytes().equals(bytes),
      interleave: _assignFixture(store, 'beta', store.incarnation('beta')!, A, 'off', store.revision, fixtureThreadHybridSince(store.snapshot())).kind })
  })
  await confirm(run); unsubscribe()
  expect(observed).toEqual([{ mode: 'open', delivery: 'thread_hybrid', life: store.incarnation('alpha'), stop: false,
    consumer: [{ id: A, delivery: 'thread_hybrid' }], source: true, interleave: 'stale' }])
  expect(store.incarnation('alpha')).not.toBe(oldLife)
})

test('observed change with failed review persistence cannot revive an old confirmation after byte reversion', async () => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] }); const run = await start()
  const candidate = h.writeConfig({ personas: [{ ...alpha, stop_hook_bootstrap: false }] })
  await tick(run); const old = h.readPending()!, fingerprint = h.pendingFingerprint()!
  h.failWrites({ step: 'renameSync' })
  h.writeConfigBytes(Buffer.concat([candidate, Buffer.from('\n')]))
  await tick(run)
  h.clearWriteFailure(); h.writeConfigBytes(candidate); h.writeApplyBytes(old)
  const cp = run.checkpoint(); await tick(run)
  expect(authority(run).config().personas[0]!.stop_hook_bootstrap).toBe(true)
  expect(run.since(cp).lifecycle).toEqual([])
  expect(reviewLedger(disk())!.outcomes[fingerprint]?.status).not.toBe('consumed')
  expect(h.pendingFingerprint()).not.toBe(fingerprint)
  await confirm(run); expect(authority(run).config().personas[0]!.stop_hook_bootstrap).toBe(false)
})

test('exact recovery of a post-rename rejected startup attempt releases its withheld persona after the retirement journal is gone', async () => {
  const alpha = persona(), beta = persona('beta'); h.materialize(alpha, beta); h.writeConfig({ personas: [alpha, beta] })
  let armed = false
  const run = await start({ stopBeforeWrite(path, bytes) {
    return armed && path === h.paths.lastApplied && Object.values(reviewLedger(parseSharedChannelState(bytes, path)!)?.outcomes ?? {}).some(o => o.status === 'consumed')
  } })
  const replacement = { ...alpha, working_directory: h.persona('replacement').working_directory }; h.materialize(replacement)
  h.writeConfig({ personas: [replacement, beta] }); await tick(run); armed = true; await confirm(run)
  expect(run.stoppedBeforeWrite).toBe(true); await run.stop()
  let failedRejection = false
  const reopened = await h.start({ dryRun: true, realLifecycle: true, beforeWrite(path, bytes) {
    if (failedRejection || path !== h.paths.lastApplied) return
    if (Object.values(reviewLedger(parseSharedChannelState(bytes, path)!)?.outcomes ?? {}).some(o => o.status === 'rejected')) {
      failedRejection = true; h.failWrites({ step: 'fsyncSync', call: 2 })
    }
  } }); runs.push(reopened)
  expect(failedRejection).toBe(true)
  expect(authority(reopened).readable).toBe(false)
  expect(reviewLedger(disk())!.retirement).toBeUndefined()
  expect(reopened.lifecycle.keys('bring-up')).toEqual(['beta'])
  h.clearWriteFailure(); reopened.startDetection(); await reopened.ticks.tick()
  expect(authority(reopened).readable).toBe(true)
  expect(reopened.lifecycle.keys('bring-up')).toEqual(['beta', 'alpha'])
  await reopened.ticks.tick()
  expect(reopened.lifecycle.keys('bring-up')).toEqual(['beta', 'alpha'])
  expect(authority(reopened).config().personas[0]!.working_directory).toBe(alpha.working_directory)
})

test.each(['strict', 'open'].flatMap(mode => [false, true].map(retained => [mode, retained] as const)))('DM-disabled %s workdir replacement resets copied preferences, explicit retention=%s', async (mode, retained) => {
  const alpha = h.persona('alpha'); h.materialize(alpha); h.writeConfig({ channel_mode: mode, personas: [alpha] }); const run = await start()
  const replacement = { ...alpha, working_directory: h.persona('replacement').working_directory }; h.materialize(replacement)
  const oldLife = authority(run).incarnation('alpha'), channel = alpha.channels![0]!.id
  h.writeConfig({ channel_mode: mode, personas: [replacement] })
  if (retained) run.request('request', [assignment(run, replacement, 'all', channel)])
  await tick(run)
  expect(h.pendingHeader()).not.toStartWith('INVALID:')
  await confirm(run)
  expect(authority(run).incarnation('alpha')).not.toBe(oldLife)
  expect(choice(run, channel)).toBe(retained ? 'all' : undefined)
  const restarted = await reopen(run)
  expect(authority(restarted).config().personas[0]!.dm.enabled).toBe(false)
  expect(choice(restarted, channel)).toBe(retained ? 'all' : undefined)
})


test.each(['old-incarnation', 'wrong-order', 'missing-created-at', 'extra-field', 'wrong-channel', 'source-omitted', 'source-destination', 'wrong-declaration'] as const)('replacement reset-destination proof refuses %s persisted evidence', async variant => {
  const alpha = h.persona('alpha'); h.materialize(alpha); h.writeConfig({ personas: [alpha] }); const run = await start()
  const oldLife = authority(run).incarnation('alpha')!
  const replacement = { ...alpha, working_directory: h.persona('replacement').working_directory }; h.materialize(replacement)
  h.writeConfig({ personas: [replacement] }); await tick(run); await confirm(run)
  const state = disk(), life = state.personas.alpha!, current = authority(run).config().personas[0]!
  expect(life.resetDestination).toMatchObject({ incarnation: life.incarnation, channel: alpha.permission_prompts, order: life.resetOrder })
  expect(authority(run).validatesRemovedDestination(current)).toBe(false)
  expect(life.leaves).toEqual({}); expect(life.membership).toEqual({}); expect(life.removedDestinations).toEqual({})
  const proof = life.resetDestination!
  switch (variant) {
    case 'old-incarnation': proof.incarnation = oldLife; break
    case 'wrong-order': proof.order--; break
    case 'missing-created-at': delete life.createdAt; break
    case 'extra-field': Object.assign(proof, { inherited: true }); break
    case 'wrong-channel': proof.channel = B; break
    case 'wrong-declaration': life.declaration.working_directory = alpha.working_directory; break
    case 'source-omitted': (state.source.personas as Record<string, unknown>[])[0]!.channels = []; break
    case 'source-destination': (state.source.personas as Record<string, unknown>[])[0]!.permission_prompts = B; break
  }
  if (variant.startsWith('source-')) state.sourceBytesBase64 = Buffer.from(JSON.stringify(state.source)).toString('base64')
  expect(() => parseSharedChannelState(serializeSharedChannelState(state), h.paths.lastApplied)).toThrow()
  expect(authority(run).config().personas[0]).toEqual(current)
})

test.each([reviewRecoveredBringUpFailedLine, reviewRecoveredLifecycleFailedLine])('exported recovery diagnostic redacts a secret-bearing failure', build => {
  const err = new Error(sentinelInMessage('recovered operation failed'))
  const line = build(err)
  expect(line).toStartWith('[slack] reload: recovered ')
  expect(line).toContain('failed:')
  assertNoLeak(line)
})


async function until(predicate: () => boolean) {
  for (let n = 0; n < 500 && !predicate(); n++) await new Promise(resolve => setImmediate(resolve))
  expect(predicate()).toBe(true)
}

test('exact recovered removal holds its acquired retiring guard through teardown, then re-addition admits the new session', async () => {
  const alpha = persona(), beta = persona('beta'); h.materialize(alpha, beta); h.writeConfig({ personas: [alpha, beta] })
  let armed = false
  const run = await start({ dryRun: false, beforeWrite(path, bytes) {
    if (armed && path === h.paths.lastApplied && Object.values(reviewLedger(parseSharedChannelState(bytes, path)!)?.outcomes ?? {}).some(o => o.status === 'consumed')) {
      armed = false; h.failWrites({ step: 'fsyncSync', call: 2 })
    }
  } })
  const old = run.registerSession('alpha')
  h.writeConfig({ personas: [beta] }); await tick(run); armed = true; await confirm(run)
  expect(run.channelDelivery.isRetiring('alpha')).toBe(true)
  expect(authority(run).readableFor('beta', A)).toBe(true)
  const gate = run.lifecycle.hold('teardown', 'alpha')
  h.clearWriteFailure(); const recovering = run.ticks.tick(); await gate.entered
  expect(run.channelDelivery.isRetiring('alpha')).toBe(true)
  gate.release(); await recovering
  expect(run.channelDelivery.isRetiring('alpha')).toBe(false)
  h.writeConfig({ personas: [alpha, beta] }); await tick(run); await confirm(run)
  expect(run.channelDelivery.isRetiring('alpha')).toBe(false)
  expect(run.slackPosts()).toEqual([])
  expect((await run.callTool('alpha', 'reply', { chat_id: 'U0OPERATOR', text: 'old life' }, old)).isError).toBe(true)
  run.registerSession('alpha')
  allowedPosts.set(run, [replyPost(stubOpenedDmId('U0OPERATOR'), 'current life')])
  expect((await run.callTool('alpha', 'reply', { chat_id: 'U0OPERATOR', text: 'current life' })).isError).toBe(false)
})

test.each(['off', 'replacement', 'unchanged'] as const)('reply callback await refreshes authority after %s and retains the invocation fact', async change => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const calls: string[] = []
  const run = await start({ dryRun: false, onReplyCall: async key => { calls.push(key); entered(); await held } })
  const original = run.registerSession('alpha'), life = authority(run).incarnation('alpha')
  const replying = run.callTool('alpha', 'reply', { chat_id: A, text: '  original reply 😀\n' }, original)
  await started
  expect(run.stub('alpha').calls.postMessage).toEqual([])
  if (change === 'off') {
    run.request('request', [assignment(run, alpha, 'off')]); await tick(run); await confirm(run)
    expect(authority(run).incarnation('alpha')).toBe(life)
  } else if (change === 'replacement') {
    const replacement = { ...alpha, working_directory: h.persona('replacement').working_directory }; h.materialize(replacement)
    h.writeConfig({ personas: [replacement] }); await tick(run); await confirm(run)
  }
  if (change === 'unchanged') allowedPosts.set(run, [replyPost(A, '  original reply 😀\n')])
  release(); const result = await replying
  expect(result.isError).toBe(change !== 'unchanged')
  expect(calls).toEqual(['alpha'])
  expect(run.stub('alpha').calls.postMessage).toHaveLength(change === 'unchanged' ? 1 : 0)
  assertNoLeak(result)
})

test.each(['dm-open', 'dm-disabled', 'successful-post'] as const)('replacement during %s refuses unsent work while retaining successful-post cleanup', async boundary => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  const consumed: unknown[][] = []
  const run = await start({ dryRun: false, consumeAck: (key, channel, timestamp, remove) => {
    consumed.push([key, channel, timestamp]); return remove ? consumeAck(key, channel, timestamp, remove) : consumeAck(key, channel, timestamp)
  } })
  run.registerSession('alpha')
  const deferred = makeDeferredWebApiCall(), stub = run.stub('alpha')
  if (boundary !== 'successful-post') stub.script.open.push(deferred.outcome)
  else stub.script.post.push(deferred.outcome)
  const target = boundary !== 'successful-post' ? 'U0OPERATOR' : A
  if (boundary === 'successful-post') allowedPosts.set(run, [replyPost(A, '  preserved reply 😀\n')])
  const replying = run.callTool('alpha', 'reply', { chat_id: target, text: '  preserved reply 😀\n', message_id: '1700000000.000001' })
  await until(() => (boundary !== 'successful-post' ? stub.calls.conversationsOpen : stub.calls.postMessage).length === 1)
  const life = authority(run).incarnation('alpha')
  const replacement = boundary === 'dm-disabled' ? { ...alpha, dm: { enabled: false, contact: 'U0OPERATOR' }, permission_prompts: A } :
    { ...alpha, working_directory: h.persona('replacement').working_directory }; h.materialize(replacement)
  h.writeConfig({ personas: [replacement] }); await tick(run); await confirm(run)
  if (boundary === 'dm-disabled') expect(authority(run).incarnation('alpha')).toBe(life)
  deferred.settle({ kind: 'ok', result: boundary !== 'successful-post' ? { channel: { id: 'D0OPENED1' } } : { ts: '1700000000.000002' } })
  const result = await replying
  expect(stub.calls.postMessage).toHaveLength(boundary !== 'successful-post' ? 0 : 1)
  expect(consumed).toEqual(boundary !== 'successful-post' ? [] : [['alpha', A, '1700000000.000001']])
  if (boundary !== 'successful-post') expect(result.isError).toBe(true)
  else expect(stub.calls.postMessage[0]).toMatchObject({ text: '  preserved reply 😀\n' })
  assertNoLeak(result)
})

test.each(['changed', 'observation-write-fails', 'unchanged'] as const)('confirmation revalidation cannot revive observed input after %s and immediate reversion', async variant => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  let armed = false, reads = 0, changedFd: number | undefined, candidate: Buffer
  const run = await start({ configFs: {
    openFile(path) {
      const change = armed && path === h.paths.config && ++reads === 2 && variant !== 'unchanged'
      if (change) h.writeConfigBytes(Buffer.concat([candidate, Buffer.from('\n')]))
      const fd = DEFAULT_PERSONA_CONFIG_FS.openFile(path)
      if (change) changedFd = fd
      return fd
    },
    closeFile(fd) {
      DEFAULT_PERSONA_CONFIG_FS.closeFile(fd)
      if (fd !== changedFd) return
      changedFd = undefined
      // Revalidation has read B. Restore A before the same tick refreshes;
      // the normal detection observer never sees B's bytes on disk.
      h.writeConfigBytes(candidate)
      if (variant === 'observation-write-fails') h.failWrites({ path: h.paths.lastApplied, step: 'renameSync' })
    },
  } })
  candidate = h.writeConfig({ personas: [{ ...alpha, stop_hook_bootstrap: false }] })
  await tick(run)
  const confirmation = h.readPending()!, fingerprint = h.pendingFingerprint()!, cp = run.checkpoint()
  armed = true; await confirm(run); armed = false
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(h.readConfig()).toEqual(candidate)
  if (variant === 'unchanged') {
    expect(authority(run).config().personas[0]!.stop_hook_bootstrap).toBe(false)
    expect(reviewLedger(disk())!.outcomes[fingerprint]!.status).toBe('consumed')
    expect(run.since(cp).lifecycle).toEqual([{ op: 'update-in-place', key: 'alpha', via: 'apply', settings: ['stop_hook_bootstrap'] }])
    return
  }
  expect(authority(run).config().personas[0]!.stop_hook_bootstrap).toBe(true)
  expect(run.since(cp).lifecycle).toEqual([])
  h.clearWriteFailure()
  h.writeApplyBytes(confirmation); await tick(run)
  expect(authority(run).config().personas[0]!.stop_hook_bootstrap).toBe(true)
  expect(reviewLedger(disk())!.outcomes[fingerprint]?.status).not.toBe('consumed')
  expect(run.since(cp).lifecycle).toEqual([])
  expect(h.pendingFingerprint()).not.toBe(fingerprint)
  if (variant === 'observation-write-fails') expect(run.since(cp).writes.some(write => !write.ok)).toBe(true)
  await confirm(run)
  expect(authority(run).config().personas[0]!.stop_hook_bootstrap).toBe(false)
})

import { absenceReplacementBinding } from '../src/shared-channels.ts'
import { REVIEW_ABSENCE_REPLACEMENT } from '../src/reload-preview-clauses.ts'

test('reviewed absence replacement preserves the exact conflict and unrelated channel while requiring fresh current evidence', async () => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ personas: [alpha], channel_mode: 'open' })
  const run = await start({ dryRun: false })
  run.stub('alpha').script.inventory.push(membershipPage([A, B])); await run.membershipClock.runNext()
  const owner = authority(run), generation = run.membership.generation('alpha')!, baseline = owner.snapshot()
  expect(run.membership.read('alpha', A, 'open').kind).toBe('eligible')
  _fixtureChoice(run, 'mentions')
  expect(run.membership.commitInventory(generation, { scanId: 'absence-assignment-race',
    observedThrough: ((run.membershipClock.now() + 1) / 1000).toFixed(3), observedRevision: baseline.revision,
    absent: new Map([[A, baseline.personas.alpha!.membership[A]!.boundary]]),
  }).kind).toBe('unresolved')
  const conflict = owner.snapshot().personas.alpha!.membershipAbsenceConflicts![A]!
  const binding = absenceReplacementBinding(owner.snapshot(), 'alpha', A)!
  expect(binding).toMatch(/^[a-f0-9]{64}$/)
  const sibling = owner.snapshot().personas.alpha!.assignments[B]
  const request = buildOperatorAssignment(owner.config().personas[0]!, owner.incarnation('alpha')!, A, 'all', binding)
  const session = run.registerSession('alpha'), client = run.connections.clientFor('alpha'), socket = run.stub('alpha').socket
  const cp = run.checkpoint(), timeline = run.lifecycle.timeline.length
  const composition = run.composition!, calls = composition.calls.length, adCalls = stubCallCount(composition.agentDirector)
  const sockets = () => run.stub('alpha').sockets.map(s => ({ starts: s.startCalls, disconnects: s.disconnectCalls }))
  const beforeSockets = sockets()
  const expectKeptConnections = () => {
    expect(run.composition!.calls.slice(calls)).toEqual([])
    expect(stubCallCount(composition.agentDirector)).toBe(adCalls)
    expect(run.since(cp).slackBuilds).toBe(0); expect(run.since(cp).slackCalls).toEqual([])
    expect(run.session('alpha')).toBe(session); expect(session.connected).toBe(true)
    expect(run.connections.clientFor('alpha')).toBe(client); expect(run.stub('alpha').socket).toBe(socket)
    expect(sockets()).toEqual(beforeSockets)
  }
  run.request('request', [request], 'replace-absence'); await tick(run)
  expect(h.pendingBody()).toContain(REVIEW_ABSENCE_REPLACEMENT)
  expect(choice(run)).toBe('mentions')
  expect(run.since(cp).lifecycle).toEqual([])
  expect(run.lifecycle.timeline.slice(timeline)).toEqual([])
  expectKeptConnections()
  await confirm(run)
  expect(run.since(cp).lifecycle).toEqual([{ op: 'update-in-place', key: h.key('alpha'), via: 'apply', settings: ['delivery'] }])
  expect(run.lifecycle.timeline.slice(timeline)).toEqual([
    { op: 'update-in-place', key: h.key('alpha'), phase: 'start' },
    { op: 'update-in-place', key: h.key('alpha'), phase: 'settled' },
  ])
  expectKeptConnections()
  const repaired = owner.snapshot().personas.alpha!
  expect(repaired.membershipAbsenceConflicts![A]).toBeUndefined()
  expect(repaired.replacedAbsences![binding]!.conflict).toEqual(conflict)
  expect(repaired.assignments[A]!.delivery).toBe('all')
  expect(repaired.assignments[A]!.order).toBe(repaired.leaves[A]!.boundary + 1)
  expect(repaired.assignments[B]).toEqual(sibling)
  expect(run.membership.read('alpha', A, 'open').kind).toBe('unresolved')
  expect(run.membership.read('alpha', B, 'open').kind).toBe('eligible')
  run.stub('alpha').script.inventory.push(membershipPage([A, B])); await run.membershipClock.runNext()
  expect(run.membership.read('alpha', A, 'open').kind).toBe('eligible')
  expect(choice(run)).toBe('all'); expect(absenceReplacementBinding(owner.snapshot(), 'alpha', A)).toBeUndefined()
})

// --- Review outcome retention (SR-3.5, SR-8.10) ---
// "Latest" is the greatest saved outcome revision: each expected outcome names
// the application that recorded it, never insertion order or generation.

/** Every successful authority write, parsed, in order. Before the writer runs,
 * each attempted write's bytes are copied into `attemptedAuthorities` (failed,
 * unsynced, stopped and later-replaced versions included); the callback
 * asserts nothing, so it cannot change the write's result. */
function authorityWrites(): { written: SharedChannelState[]; beforeWrite: ReloadRunOptions['beforeWrite']; afterWrite: ReloadRunOptions['afterWrite'] } {
  const written: SharedChannelState[] = []
  return {
    written,
    beforeWrite: (path, bytes) => { if (path === h.paths.lastApplied) attemptedAuthorities.push(Buffer.from(bytes).toString('utf8')) },
    afterWrite: (path, bytes) => { if (path === h.paths.lastApplied) written.push(parseSharedChannelState(bytes, path)!) },
  }
}
/** The saved outcomes, once the published authority is shown to hold the same. */
function retainedOutcomes(run: ReloadRun) {
  const saved = reviewLedger(disk())!.outcomes
  expect(reviewLedger(authority(run).snapshot())!.outcomes).toEqual(saved)
  return saved
}
function outcomeOf(review: { fingerprint: string; generation: number }, status: ReviewOutcome['status'], revision: number) {
  return { [review.fingerprint]: { generation: review.generation, revision, status } }
}
/** The pending review: its saved file, fingerprint and durable generation. */
function pendingReview() {
  const fingerprint = h.pendingFingerprint()!, active = reviewLedger(disk())!.active!
  expect(active.fingerprint).toBe(fingerprint)
  return { file: h.readPending()!, fingerprint, generation: active.generation }
}
function applyRemoved() { return { path: h.paths.apply, ok: true, removed: true, unsynced: false } }
/** A saved confirmation is processed once and changes nothing: no write,
 * lifecycle, assignment, applied/source/identity fact or pending intent. */
async function expectRefused(run: ReloadRun, file: Buffer, line: string) {
  const before = applicationState(disk()), intent = authority(run).operatorIntent(), pending = h.pendingFingerprint()
  h.writeApplyBytes(file); const cp = run.checkpoint(); await tick(run)
  expect(run.since(cp)).toEqual({ ...NO_RUN_ACTIVITY, logs: [line], removes: [applyRemoved()] })
  expect(applicationState(disk())).toEqual(before); expect(applicationState(authority(run).snapshot())).toEqual(before)
  expect(authority(run).operatorIntent()).toEqual(intent); expect(h.pendingFingerprint()).toBe(pending)
}

test('the review history keeps only its last outcome through supersessions and consumption; a dropped review is stale, the last keeps its line, and a consumed replay never assigns again', async () => {
  const alpha = persona(), beta = persona('beta'); h.materialize(alpha, beta); const bytes = h.writeConfig({ personas: [alpha, beta] })
  const writes = authorityWrites()
  let run = await start(writes)
  const betaLife = () => authority(run).snapshot().personas.beta
  const sibling = betaLife()
  run.request('request', [assignment(run, alpha, 'off')]); await tick(run)
  const first = pendingReview()
  expect(retainedOutcomes(run)).toEqual({})
  // Each revision supersedes the active review in the observation that
  // installs the next one, the last write of that check.
  run.request('revise', [assignment(run, alpha, 'mentions')]); await tick(run)
  const second = pendingReview()
  expect(retainedOutcomes(run)).toEqual(outcomeOf(first, 'superseded', authority(run).revision))
  run.request('revise', [assignment(run, alpha, 'thread_hybrid')]); await tick(run)
  const third = pendingReview(), secondAt = authority(run).revision
  expect(retainedOutcomes(run)).toEqual(outcomeOf(second, 'superseded', secondAt))
  await expectRefused(run, first.file, staleLine())
  await expectRefused(run, second.file, reviewOutcomeLine('superseded'))
  expect(choice(run)).toBe('all')

  // A consumed confirmation whose cleanup fails stays at the apply path.
  const confirming = writes.written.length
  h.failRemoves(); await confirm(run)
  expect(choice(run)).toBe('thread_hybrid'); expect(h.applyExists()).toBe(true)
  const consumedAt = order(run)!
  expect(writes.written.slice(confirming).map(state => [state.revision, reviewLedger(state)!.outcomes])).toEqual([
    [consumedAt - 1, outcomeOf(third, 'attempted', consumedAt - 1)],
    [consumedAt, outcomeOf(third, 'consumed', consumedAt)],
    [consumedAt + 1, outcomeOf(third, 'consumed', consumedAt)],
  ])
  expect(retainedOutcomes(run)).toEqual(outcomeOf(third, 'consumed', consumedAt))
  expect(betaLife()).toEqual(sibling)
  const consumedFile = h.readApply()!

  // Restarted, the leftover still has the outcome recorded last.
  run = await reopen(run, writes)
  expect(run.logsOf(RELOAD_REVIEW_OUTCOME)).toEqual([reviewOutcomeLine('consumed')])
  expect(choice(run)).toBe('thread_hybrid'); expect(order(run)).toBe(consumedAt)
  expect(retainedOutcomes(run)).toEqual(outcomeOf(third, 'consumed', consumedAt))
  // Newer outcomes drop it: after the next restart the leftover is stale.
  run.request('request', [assignment(run, alpha, 'all')]); await tick(run)
  const fourth = pendingReview()
  run.request('revise', [assignment(run, alpha, 'off')]); await tick(run)
  const fifth = pendingReview()
  expect(retainedOutcomes(run)).toEqual(outcomeOf(fourth, 'superseded', authority(run).revision))
  run = await reopen(run, writes)
  expect(run.logsOf(RELOAD_REVIEW_OUTCOME)).toEqual([])
  expect(run.logsOf(RELOAD_STALE_CONFIRMATION)).toEqual([staleLine()])
  expect(choice(run)).toBe('thread_hybrid'); expect(order(run)).toBe(consumedAt); expect(h.applyExists()).toBe(true)
  // Reopen superseded the fifth review in its first observation.
  const sixth = pendingReview()
  expect(retainedOutcomes(run)).toEqual(outcomeOf(fifth, 'superseded', authority(run).revision))
  expect(sixth.generation).toBeGreaterThan(fifth.generation)
  h.clearRemoveFailure(); await tick(run); expect(h.applyExists()).toBe(false)
  await expectRefused(run, consumedFile, staleLine())
  await expectRefused(run, fourth.file, staleLine())
  await expectRefused(run, fifth.file, reviewOutcomeLine('superseded'))
  expect(choice(run)).toBe('thread_hybrid'); expect(order(run)).toBe(consumedAt)
  expect(authority(run).operatorIntent()).toMatchObject({ requested: true, assignments: [{ delivery: 'off' }] })
  await confirm(run)
  expect(choice(run)).toBe('off'); expect(order(run)).toBeGreaterThan(consumedAt)
  expect(retainedOutcomes(run)).toEqual(outcomeOf(sixth, 'consumed', order(run)!))
  expect(betaLife()).toEqual(sibling); expect(h.readConfig()).toEqual(bytes)
})

test('a bot attempt recorded after outcomes were dropped reopens readable; its derived variant at a kept outcome position is refused', async () => {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ channel_mode: 'open', personas: [alpha] })
  const opts: ReloadRunOptions = { dryRun: false, slack: { alpha: { inventory: [membershipPage([A])] } }, ...authorityWrites() }
  let run = await start(opts)
  await run.membershipClock.runNext(); await run.membershipClock.flush()
  expect(run.membership.read('alpha', A, 'open').kind).toBe('eligible')
  run.request('request', [assignment(run, alpha, 'off')]); await tick(run)
  const first = pendingReview()
  run.request('revise', [assignment(run, alpha, 'mentions')]); await tick(run)
  const second = pendingReview()
  run.request('revise', [assignment(run, alpha, 'thread_hybrid')]); await tick(run)
  const kept = outcomeOf(second, 'superseded', authority(run).revision)
  expect(retainedOutcomes(run)).toEqual(kept)
  expect(reviewLedger(disk())!.outcomes[first.fingerprint]).toBeUndefined()
  run.registerSession('alpha')
  expect((await run.callTool('alpha', 'set_channel_delivery', deliveryAttempt('after-pruning', A, 'all'))).isError).toBe(false)
  const seed = disk(), [application] = botApplications(seed)
  expect(application).toMatchObject({ key: 'alpha', channel: A, delivery: 'all', resolvedOrder: order(run) })
  expect(application!.startedOrder).toBeGreaterThan(kept[second.fingerprint]!.revision)
  // A bot application writes no review history.
  expect(retainedOutcomes(run)).toEqual(kept)
  run = await reopen(run, opts)
  expect(authority(run).readable).toBe(true); expect(authority(run).readableFor('alpha', A)).toBe(true)
  expect(choice(run)).toBe('all'); expect(botApplications(disk())).toEqual([application])
  expect(() => parseSharedChannelState(serializeSharedChannelState(botAttemptAtReviewOutcome(seed, second.fingerprint)), h.paths.lastApplied))
    .toThrow('Inconsistent durable bot attempt effect.')
})

// --- Review binding (SR-4.3): reviewed membership facts, not scan bookkeeping ---

/** An open-mode alpha whose authenticated inventory lists A and B, with a pending review. */
async function reviewedMembership() {
  const alpha = persona(); h.materialize(alpha); h.writeConfig({ channel_mode: 'open', personas: [alpha] })
  const run = await start({ dryRun: false, slack: { alpha: { inventory: [membershipPage([A, B])] } }, ...authorityWrites() })
  await run.membershipClock.runNext(); await run.membershipClock.flush()
  expect(run.membershipScanner.status('alpha').state).toBe('complete')
  expect(run.membership.read('alpha', B, 'open').kind).toBe('eligible')
  run.request('request', [assignment(run, alpha, 'off')]); await tick(run)
  return { run, review: pendingReview() }
}
/** One complete production reconciliation listing `channels` in this order. */
async function reconcile(run: ReloadRun, channels: string[]) {
  run.currentStub('alpha').script.inventory.push(membershipPage(channels))
  if (run.membershipScanner.status('alpha').nextAttemptAt === undefined) run.membershipScanner.request('alpha')
  await run.membershipClock.advanceTo(run.membershipScanner.status('alpha').nextAttemptAt!); await run.membershipClock.flush()
  expect(run.membershipScanner.status('alpha').state).toBe('complete')
}
/** Slack closes alpha's socket; the returned settle lets its reconnect open. */
async function dropConnection(run: ReloadRun) {
  const reconnect = makeDeferredConnect()
  run.currentStub('alpha').script.connect.push(reconnect.outcome)
  run.currentStub('alpha').socket.drop(); await run.clock.flush()
  expect(run.membership.read('alpha', A, 'open').kind).toBe('unresolved')
  return async () => { reconnect.settle({ kind: 'ok' }); await run.clock.flush() }
}

test.each(['a rescan', 'a reordered rescan', 'a reconnect'] as const)('%s that finds the same reviewed membership keeps the pending review, its generation and outcomes', async change => {
  const { run, review } = await reviewedMembership()
  const before = disk(), ledger = reviewLedger(before), generation = run.membership.generation('alpha')!.generation
  if (change === 'a reconnect') { const reconnect = await dropConnection(run); await reconnect() }
  await reconcile(run, change === 'a reordered rescan' ? [B, A] : [A, B])
  // The scan writes its own records and watermarks, never review metadata.
  const scanned = disk()
  expect(scanned.revision).toBeGreaterThan(before.revision)
  expect(scanned.personas.alpha!.membershipInventory).not.toEqual(before.personas.alpha!.membershipInventory)
  expect(scanned.personas.alpha!.membershipEvents).not.toEqual(before.personas.alpha!.membershipEvents)
  if (change === 'a reconnect') expect(run.membership.generation('alpha')!.generation).not.toBe(generation)
  expect(reviewLedger(scanned)).toEqual(ledger)
  const cp = run.checkpoint(); await tick(run)
  expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)
  expect(pendingReview()).toEqual(review); expect(reviewLedger(disk())).toEqual(ledger)
  await confirm(run)
  expect(choice(run)).toBe('off'); expect(retainedOutcomes(run)).toEqual(outcomeOf(review, 'consumed', order(run)!))
})

test.each(['an observed unverified reconnect', 'a leave', 'a join'] as const)('%s supersedes the pending review; its confirmation applies nothing', async change => {
  const { run, review } = await reviewedMembership()
  if (change === 'an observed unverified reconnect') {
    const reconnect = await dropConnection(run)
    await tick(run)
    expect(h.pendingFingerprint()).not.toBe(review.fingerprint)
    await reconnect()
    await reconcile(run, [A, B])
  } else await reconcile(run, change === 'a leave' ? [A] : [A, B, C])
  await tick(run)
  expect(h.pendingFingerprint()).not.toBe(review.fingerprint)
  // A reconnect that is observed both ways supersedes twice, dropping the outcome.
  await expectRefused(run, review.file, change === 'an observed unverified reconnect' ? staleLine() : reviewOutcomeLine('superseded'))
  expect(choice(run)).toBe('all')
  await confirm(run); expect(choice(run)).toBe('off')
})

// The same authenticated connection keeps its generation; a failed rescan
// changes only that generation's current evidence, never the saved facts.
test.each([
  ['a hold for missing eligibility metadata', [A, { id: B }], 'eligibility-missing', [[B, 'eligibility-missing']]],
  ['contradictory page metadata', [A, B, { id: A }], 'malformed-page', []],
] as const)('%s leaves the current generation incomplete and supersedes the pending review with saved membership unchanged; reconciling the same facts keeps it revoked', async (_change, channels, problem, holds) => {
  const { run, review } = await reviewedMembership()
  const generation = run.membership.generation('alpha')!, dependency = sharedReviewDependency(disk())
  expect([generation.complete, [...generation.holds]]).toEqual([true, []])
  run.currentStub('alpha').script.inventory.push(membershipPage([...channels]))
  run.membershipScanner.request('alpha')
  await run.membershipClock.advanceTo(run.membershipScanner.status('alpha').nextAttemptAt!); await run.membershipClock.flush()
  expect(run.membershipScanner.status('alpha')).toMatchObject({ state: 'incomplete', problem })
  expect(run.membership.generation('alpha')).toBe(generation); expect(run.membership.isCurrent(generation)).toBe(true)
  expect([generation.complete, Object.fromEntries(generation.holds)]).toEqual([false, Object.fromEntries(holds)])
  expect(sharedReviewDependency(disk())).toBe(dependency)
  await tick(run)
  const incomplete = pendingReview()
  expect(incomplete.fingerprint).not.toBe(review.fingerprint)
  expect(retainedOutcomes(run)).toEqual(outcomeOf(review, 'superseded', authority(run).revision))
  await expectRefused(run, review.file, reviewOutcomeLine('superseded'))
  // The same facts again: the generation is complete with the reviewed
  // evidence, but its reversion revokes the incomplete review too.
  await reconcile(run, [A, B])
  expect(run.membership.generation('alpha')).toBe(generation)
  expect([generation.complete, [...generation.holds]]).toEqual([true, []])
  expect(sharedReviewDependency(disk())).toBe(dependency)
  await tick(run)
  expect(h.pendingFingerprint()).not.toBe(incomplete.fingerprint); expect(h.pendingFingerprint()).not.toBe(review.fingerprint)
  await expectRefused(run, review.file, staleLine())
  await expectRefused(run, incomplete.file, reviewOutcomeLine('superseded'))
  expect(choice(run)).toBe('all')
  await confirm(run); expect(choice(run)).toBe('off')
})

test('the review dependency binds each reviewed membership, leave, life and choice fact, and leaves out scan bookkeeping and enumeration order', async () => {
  const { run } = await reviewedMembership()
  await reconcile(run, [A])
  const base = authority(run).snapshot(), dependency = sharedReviewDependency(base)
  expect(base.personas.alpha!.membership[A]).toMatchObject({ member: true, isExtSharedChannel: false, channelType: 'channel' })
  expect(base.personas.alpha!.membership[B]!.isExtSharedChannel).toBeUndefined()
  const after = (change: (life: SharedPersona, state: SharedChannelState) => void) => {
    const next = structuredClone(base); change(next.personas.alpha!, next); return sharedReviewDependency(next)
  }
  const reversed = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).reverse())
  const reviewed: Record<string, (life: SharedPersona, state: SharedChannelState) => void> = {
    'membership': life => { life.membership[A]!.member = false },
    'issuing identity': life => { life.membership[A]!.identity += '-rotated' },
    'membership boundary': life => { life.membership[A]!.boundary++ },
    'external sharing, false to missing': life => { delete life.membership[A]!.isExtSharedChannel },
    'external sharing, missing to false': life => { life.membership[B]!.isExtSharedChannel = false },
    'channel type': life => { life.membership[A]!.channelType = 'group' },
    'same-value ordered choice': life => { life.assignments[A]!.order++ },
    'leave boundary': life => { life.leaves[B]!.boundary++ },
    'leave life': life => { life.leaves[B]!.incarnation += '-replaced' },
    'life incarnation': life => { life.incarnation += '-replaced' },
    'reset order': life => { life.resetOrder = base.revision },
  }
  const bookkeeping: Record<string, (life: SharedPersona, state: SharedChannelState) => void> = {
    'membership watermark': life => { life.membership[A]!.observedThrough = life.membershipInventory!.observedThrough + '1' },
    'scan records and their IDs': life => { life.membershipEvents = Object.fromEntries(Object.entries(life.membershipEvents).slice(1).map(([id, event]) => [id + '-rescan', event])) },
    'inventory watermark': life => { life.membershipInventory = { ...life.membershipInventory!, observedThrough: life.membershipInventory!.observedThrough + '1', observedRevision: base.revision, recordedOrder: base.revision } },
    'leave event ID': life => { life.leaves[B]!.event += '-rescan' },
    'enumeration order': (life, state) => { life.membership = reversed(life.membership); life.membershipEvents = reversed(life.membershipEvents); state.personas = reversed(state.personas) },
    'review metadata and revision': (_life, state) => { state.revision++; delete state.outcomes.operatorReviews },
    'Thread Memory marker': (_life, state) => { state.threadMemoryCreated = { alpha: true } },
  }
  for (const [fact, change] of Object.entries(reviewed)) expect([fact, after(change)]).not.toEqual([fact, dependency])
  for (const [record, change] of Object.entries(bookkeeping)) expect([record, after(change)]).toEqual([record, dependency])
})

// --- Pinned outcomes: retirement recovery and repair activation (SR-3.5, SR-5.2) ---

/** A refused start that staged or reviewed recovery. Its preview is
 * leak-checked now, while it exists: a later start replaces it and a direct
 * confirmation renames it. */
async function startRefused(opts: ReloadRunOptions = {}) {
  const run = await h.start({ dryRun: true, ...opts }); runs.push(run)
  expect(run.outcome.kind).toBe('refused')
  expect(h.pendingExists()).toBe(true)
  assertNoLeak({ ...run.captured(), pending: h.readPendingText() })
  return run
}
/** Each authority write from `from` on: its revision, saved outcomes and retirement pin. */
function historyWrites(written: SharedChannelState[], from: number) {
  return written.slice(from).map(state => ({ revision: state.revision, outcomes: reviewLedger(state)?.outcomes, retirement: reviewLedger(state)?.retirement?.fingerprint }))
}
/** A damaged authority replaced through reviewed recovery: the staged review
 * is revised (supersedeReview), then confirmed at a start whose attempt
 * (beginReviewAttempt, retiring every replaced life) and activation (activate)
 * apply it. Returns the running server and the activation's review. */
async function activatedReplacement(personas: PersonaInput[], writes: ReturnType<typeof authorityWrites>) {
  const input = h.writeConfig({ personas }), damage = h.writeRecordBytes('damaged authority evidence')
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('replace-staged', damage, input)))
  let run = await startRefused(writes)
  const staged = pendingReview()
  await run.stop()
  let from = writes.written.length
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('replace-revised', damage, input)))
  run = await startRefused(writes)
  const revised = pendingReview(), revision = writes.written[from]!.revision
  expect(historyWrites(writes.written, from)).toEqual([revision, revision + 1].map(at => ({ revision: at, outcomes: outcomeOf(staged, 'superseded', revision), retirement: undefined })))
  await run.stop(); h.confirm(); from = writes.written.length
  run = await start(writes)
  const { order, fingerprint } = activationOf(disk())
  expect(fingerprint).toBe(revised.fingerprint)
  expect(historyWrites(writes.written, from)).toEqual([
    { revision: order - 1, outcomes: outcomeOf(revised, 'attempted', order - 1), retirement: revised.fingerprint },
    { revision: order, outcomes: outcomeOf(revised, 'consumed', order), retirement: undefined },
    { revision: order + 1, outcomes: outcomeOf(revised, 'consumed', order), retirement: undefined },
  ])
  return { run, activation: { ...revised, order } }
}
function retainedActivationLines(run: ReloadRun) { return run.logs.filter(line => line.startsWith(sharedRecoveryLine('retained repair activation'))) }
/** The seed keeps `saved`'s outcomes first, then older ones, so the outcome
 * recorded last is never the one inserted last. */
function expectPreRuleSeed(seed: SharedChannelState, saved: SharedChannelState) {
  const own = reviewLedger(saved)!.outcomes, seeded = reviewLedger(seed)!.outcomes
  expect(Object.keys(seeded).slice(0, Object.keys(own).length)).toEqual(Object.keys(own))
  expect(Object.keys(seeded).length).toBeGreaterThan(Object.keys(own).length)
  expect(seeded).toMatchObject(own)
}

test('a repair activation keeps its consumed outcome beside the last outcome through later reviews and restarts, until a later repair stages and replaces it', async () => {
  const alpha = persona(); h.materialize(alpha)
  const writes = authorityWrites()
  let { run, activation } = await activatedReplacement([alpha], writes)
  const pin = outcomeOf(activation, 'consumed', activation.order)
  expect(retainedOutcomes(run)).toEqual(pin)
  run.request('request', [assignment(run, alpha, 'off')]); await tick(run)
  const first = pendingReview()
  expect(retainedOutcomes(run)).toEqual(pin)
  run.request('revise', [assignment(run, alpha, 'mentions')]); await tick(run)
  const second = pendingReview()
  expect(retainedOutcomes(run)).toEqual({ ...pin, ...outcomeOf(first, 'superseded', authority(run).revision) })
  run = await reopen(run, writes)
  expect(retainedActivationLines(run)).toHaveLength(1); expect(retainedActivationLines(run)[0]).toContain(`order=${activation.order}`)
  const third = pendingReview()
  expect(retainedOutcomes(run)).toEqual({ ...pin, ...outcomeOf(second, 'superseded', authority(run).revision) })
  await expectRefused(run, first.file, staleLine())
  await expectRefused(run, second.file, reviewOutcomeLine('superseded'))

  // An owned restoration stages this state. Its review phase pins nothing, so
  // the stage's first history write keeps only the outcome recorded last.
  const owned = authority(run).snapshot()
  const damage = h.writeRecordBytes('damaged while the owner keeps its validated state')
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('owned-restoration', damage)))
  await tick(run); expect(authority(run).readable).toBe(false)
  await run.stop()
  run = await startRefused(writes)
  const restoring = pendingReview()
  expect(disk().recovery!.phase).toBe('review')
  expect(reviewLedger(disk())!.outcomes).toEqual(outcomeOf(third, 'superseded', disk().revision))
  await run.stop(); h.confirm()
  run = await start(writes)
  const replaced = activationOf(disk())
  expect(replaced.fingerprint).toBe(restoring.fingerprint)
  expect(retainedOutcomes(run)).toEqual(outcomeOf(restoring, 'consumed', replaced.order))
  // The same reviewed facts under the restoration's new boundary bind another dependency.
  const restored = authority(run).snapshot(), facts = (state: SharedChannelState) => [state.sourceBytesBase64, state.applied, state.personas, state.retiredIdentities]
  expect(facts(restored)).toEqual(facts(owned)); expect(restored.recovery!.boundary).not.toBe(owned.recovery!.boundary)
  expect(sharedReviewDependency(restored)).not.toBe(sharedReviewDependency(owned))
  expect(authority(run).operatorIntent()).toMatchObject({ requested: true, assignments: [{ delivery: 'mentions' }] })
  const fourth = pendingReview()
  expect(fourth.fingerprint).not.toBe(third.fingerprint)
  await confirm(run); expect(choice(run)).toBe('mentions')
  expect(retainedOutcomes(run)).toEqual({ ...outcomeOf(restoring, 'consumed', replaced.order), ...outcomeOf(fourth, 'consumed', order(run)!) })
})

test('an interrupted retirement keeps its attempted outcome beside the activation through a failed recovery and restart; its rejection prunes a pre-rule history, releases the pin and a later outcome drops it', async () => {
  const alpha = persona(), beta = persona('beta'); h.materialize(alpha, beta)
  const writes = authorityWrites()
  let { run, activation } = await activatedReplacement([alpha, beta], writes)
  const pin = outcomeOf(activation, 'consumed', activation.order)
  run.request('request', [assignment(run, alpha, 'off')]); await tick(run)
  // A reviewed destructive change retires beta's life; the server stops after its attempt.
  let armed = false
  run = await reopen(run, { ...writes, stopBeforeWrite: (path, bytes) => armed && path === h.paths.lastApplied && activationRecord(bytes, path) })
  const moved = { ...beta, working_directory: h.persona('beta-moved').working_directory }; h.materialize(moved)
  const input = h.writeConfig({ personas: [alpha, moved] }); await tick(run)
  const retiring = pendingReview()
  armed = true; await confirm(run)
  expect(run.stoppedBeforeWrite).toBe(true); await run.stop()
  const interrupted = disk(), attempt = outcomeOf(retiring, 'attempted', interrupted.revision)
  expect(reviewLedger(interrupted)!.outcomes).toEqual({ ...pin, ...attempt })
  expect(reviewLedger(interrupted)!.retirement!.fingerprint).toBe(retiring.fingerprint)
  // The same interruption as a CSCB before SR-3.5 saved it, with every older outcome.
  const seed = withPreRuleReviewOutcomes(interrupted, writes.written)
  expectPreRuleSeed(seed, interrupted)
  const seedBytes = h.writeChannelDeliveryBytes(serializeSharedChannelState(seed))

  // A start whose rejection cannot be saved keeps the whole history and both pins.
  h.failWrites({ step: 'renameSync', path: h.paths.lastApplied })
  run = await start(writes)
  expect(h.readRecord()).toEqual(seedBytes)
  expect(reviewLedger(authority(run).snapshot())).toEqual(reviewLedger(seed))
  expect(run.logs.filter(line => line === reviewRecoveryLine('unresolved'))).toHaveLength(1)
  expect(run.lifecycle.keys('bring-up')).toEqual(['alpha'])
  await run.stop()
  run = await start(writes)
  expect(h.readRecord()).toEqual(seedBytes)
  // Its recovery, once storage works, is the next history write.
  h.clearWriteFailure(); const from = writes.written.length
  await tick(run)
  const rejection = writes.written[from]!, rejected = { ...pin, ...outcomeOf(retiring, 'rejected', rejection.revision) }
  expect(historyWrites(writes.written, from)[0]).toEqual({ revision: rejection.revision, outcomes: rejected, retirement: undefined })
  expect(retainedOutcomes(run)).toEqual(rejected)
  expect(run.logs).toContain(reviewRecoveryLine('recovered'))
  expect(run.lifecycle.keys('bring-up')).toEqual(['alpha', 'beta'])
  await until(() => run.lifecycle.keys('launch').includes('beta'))
  const reviewed = pendingReview()
  await expectRefused(run, retiring.file, reviewOutcomeLine('rejected'))
  // Reopen supersedes the pending review, which drops the rejected outcome.
  run = await reopen(run, writes)
  expect(retainedOutcomes(run)).toEqual({ ...pin, ...outcomeOf(reviewed, 'superseded', authority(run).revision) })
  await expectRefused(run, retiring.file, staleLine())
  const fresh = pendingReview()
  await confirm(run)
  const replacedAt = authority(run).snapshot().personas.beta!.resetOrder!
  expect(retainedOutcomes(run)).toEqual({ ...pin, ...outcomeOf(fresh, 'consumed', replacedAt) })
  expect(authority(run).config().personas.find(p => p.name === 'beta')!.working_directory).toBe(moved.working_directory)
  expect(choice(run)).toBe('off'); expect(h.readConfig()).toEqual(input)
})

test.each(['written', 'refused before the rename', 'installed but unsynced', 'stopped before the write'] as const)('a pre-rule oversized review history reads as saved; its next history write, an observation adding no outcome, keeps only the last outcome and the activation (%s)', async boundary => {
  const alpha = persona(), beta = persona('beta'); h.materialize(alpha, beta)
  const writes = authorityWrites()
  let { run, activation } = await activatedReplacement([alpha, beta], writes)
  run.request('request', [assignment(run, alpha, 'off')]); await tick(run)
  run.request('revise', [assignment(run, alpha, 'mentions')]); await tick(run)
  const cancelled = pendingReview()
  run.request('cancel', []); await tick(run)
  expect(h.pendingExists()).toBe(false)
  const kept = { ...outcomeOf(activation, 'consumed', activation.order), ...outcomeOf(cancelled, 'superseded', authority(run).revision) }
  expect(retainedOutcomes(run)).toEqual(kept)
  await run.stop()
  const saved = disk(), seed = withPreRuleReviewOutcomes(saved, writes.written)
  expectPreRuleSeed(seed, saved)
  const seedBytes = h.writeChannelDeliveryBytes(serializeSharedChannelState(seed))
  const oldOutcomes = reviewLedger(seed)!.outcomes, betaChoice = () => [authority(run).readableFor('beta', A), choice(run, A, 'beta')]

  // Opening and reading alone neither convert nor report it.
  let armed = false
  run = await h.start({ dryRun: true, realLifecycle: true, ...writes, stopBeforeWrite: path => armed && path === h.paths.lastApplied }); runs.push(run)
  expect(run.outcome.kind).toBe('applied')
  expect(h.readRecord()).toEqual(seedBytes)
  expect(run.writes.filter(write => write.path === h.paths.lastApplied)).toEqual([])
  expect([RELOAD_REVIEW_OUTCOME, RELOAD_REVIEW_RECOVERY].flatMap(label => run.logsOf(label))).toEqual([])
  expect(retainedActivationLines(run)).toHaveLength(1)
  expect(reviewLedger(authority(run).snapshot())!.outcomes).toEqual(oldOutcomes)
  const betaBefore = betaChoice()

  if (boundary === 'refused before the rename') h.failWrites({ step: 'renameSync', path: h.paths.lastApplied })
  if (boundary === 'installed but unsynced') h.failWrites({ step: 'fsyncSync', call: 2, path: h.paths.lastApplied })
  armed = boundary === 'stopped before the write'
  const from = writes.written.length, attempts = attemptedAuthorities.length
  run.startDetection(); await tick(run)
  expect(h.pendingExists()).toBe(false)
  // The pruning attempt is retained for the closing leak check whatever its result.
  expect(attemptedAuthorities.slice(attempts).map(text => reviewLedger(parseSharedChannelState(Buffer.from(text), h.paths.lastApplied)!)!.outcomes)).toEqual([kept])
  if (boundary === 'written') {
    expect(historyWrites(writes.written, from).map(write => write.outcomes)).toEqual([kept])
    expect(retainedOutcomes(run)).toEqual(kept)
  } else if (boundary === 'refused before the rename') {
    // A definite failure publishes nothing and leaves the authority readable.
    expect(h.readRecord()).toEqual(seedBytes)
    expect(authority(run).readable).toBe(true); expect(reviewLedger(authority(run).snapshot())!.outcomes).toEqual(oldOutcomes)
    expect(betaChoice()).toEqual(betaBefore)
  } else if (boundary === 'installed but unsynced') {
    // The new bytes are installed but unconfirmed: unresolved, never published.
    // The disk holds the whole new history, the published authority the old
    // one with its activation pin.
    expect(reviewLedger(disk())!.outcomes).toEqual(kept)
    expect(authority(run).readable).toBe(false)
    expect(reviewLedger(authority(run).snapshot())!.outcomes).toEqual(oldOutcomes)
    expect(activationOf(authority(run).snapshot()).fingerprint).toBe(activation.fingerprint)
  } else expect(run.stoppedBeforeWrite).toBe(true)
  await run.stop(); h.clearWriteFailure()

  // Reopened: the whole old or new history with the activation, never part of one.
  const installed = boundary === 'written' || boundary === 'installed but unsynced'
  expect(h.readRecord()!.equals(seedBytes)).toBe(!installed)
  run = await h.start({ dryRun: true, realLifecycle: true, ...writes }); runs.push(run)
  expect(run.outcome.kind).toBe('applied')
  expect(reviewLedger(authority(run).snapshot())!.outcomes).toEqual(installed ? kept : oldOutcomes)
  run.startDetection(); await tick(run)
  expect(retainedOutcomes(run)).toEqual(kept)
  expect(betaChoice()).toEqual(betaBefore)
})
