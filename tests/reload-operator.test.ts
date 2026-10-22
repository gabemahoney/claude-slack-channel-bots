import { makeDeferredWebApiCall, stubOpenedDmId } from './test-helpers/slack-stub.ts'
import { consumeAck } from '../src/ack-tracker.ts'
/** wc: the public request / review / rename gesture over the real authority. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PERSONA_CONFIG_FS, DELIVERY_MODES, type DeliveryMode, type PersonaInput } from '../src/config.ts'
import { buildOperatorAssignment, buildReviewRequest, composeReviewRequest, parseReviewRequestBytes, reviewIntentLine } from '../src/reload-request.ts'
import { reviewLedger, reviewOutcomeLine, reviewRecoveredBringUpFailedLine, reviewRecoveredLifecycleFailedLine } from '../src/reload-review.ts'
import { parseSharedChannelState, serializeSharedChannelState, reviewedReplacementIncarnation } from '../src/shared-channels.ts'
import { REVIEW_OMISSION_CLAUSE, REVIEW_RETENTION_CLAUSE, REVIEW_RESET_CLAUSE } from '../src/reload-preview-clauses.ts'
import { makeReloadHarness, type ReloadHarness, type ReloadRun, type ReloadRunOptions } from './test-helpers/reload-harness.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { membershipPage, SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { stubCallCount } from './test-helpers/agent-director-stub.ts'

const { primary: A, secondary: B, private: C } = SHARED_CHANNEL_IDS
let h: ReloadHarness
let runs: ReloadRun[]
let allowedPosts: Map<ReloadRun, unknown[]>
beforeEach(() => { h = makeReloadHarness(); runs = []; allowedPosts = new Map() })
afterEach(async () => {
  try { for (const run of runs) {
    expect(run.slackPosts().map(call => call.args)).toEqual(allowedPosts.get(run) ?? [])
    assertNoLeak(run.captured())
  } }
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
function automatic(run: ReloadRun, delivery: DeliveryMode, channel: string = A, name = 'alpha') {
  const store = authority(run), key = h.key(name)
  expect(store.assign(key, store.incarnation(key)!, channel, delivery, store.revision).kind).toBe('applied')
}
async function confirm(run: ReloadRun) { assertNoLeak(run.captured()); h.confirm(); await tick(run) }
async function reopen(run: ReloadRun, opts: ReloadRunOptions = {}) { await run.stop(); return start(opts) }

// Changed values as well as unchanged values are declarations. Automatic writes
// here use nb's authority seam; these are not ei's logical MCP retry acceptance.
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
  h.writeApplyBytes(oldReview); await tick(run)
  expect(choice(run)).toBe('all'); expect(order(run)).toBe(originalOrder)
  expect(reviewLedger(disk())!.outcomes[oldFingerprint]!.status).toBe('superseded')
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
  automatic(run, 'off')
  const replacement = { ...beta, working_directory: h.persona('new-beta').working_directory }; h.materialize(replacement)
  const bytes = h.writeConfig({ channel_mode: 'open', stop_hook_bootstrap: false, personas: [alpha, replacement] })
  run.request('request', [assignment(run, alpha, 'all')]); await tick(run)
  const oldReview = h.readPending()!
  automatic(run, 'thread_hybrid', B)
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
  automatic(run, 'off'); automatic(run, 'thread_hybrid', B)
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
  automatic(run, 'mentions'); const writtenOrder = order(run)
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
  automatic(run, 'all'); const cp = run.checkpoint()
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
  expect(authority(run).isCurrentLifetime(oldLife)).toBe(false)
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
  automatic(run, 'off'); const life = authority(run).lifetime('alpha', A), beforeOrder = order(run)
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
  expect(authority(run).assign('beta', authority(run).incarnation('beta')!, A, 'off', authority(run).revision).kind).toBe('unresolved')
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
      interleave: store.assign('beta', store.incarnation('beta')!, A, 'off', store.revision).kind })
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
  automatic(run, 'mentions')
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
