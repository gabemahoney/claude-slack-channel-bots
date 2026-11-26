import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFLICT_NOTICE_HUMAN_ONLY_LINE } from '../src/conflict-latch.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { createPersonaEpisodes } from '../src/persona-episodes.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness } from './test-helpers/persona-notifier.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { buildAdDeliveryRefusalLine, buildAdInputOutcomeLine } from '../src/ad-input-notices.ts'
import { submissionUnconfirmedFactsOf } from '../src/ad-error-class.ts'
import { errSubmissionUnconfirmed } from './test-helpers/agent-director-stub.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test.each([
  ['not-interactive', 'read-before-retry', 'STATE', 'ErrSpawnNotInteractive', ' for existing row recheck and guarded retry'],
  ['row-absent', 'read-before-retry', 'STATE', 'ErrSpawnNotFound', ' for existing row recheck and guarded retry'],
  ['invalid-flags', 'version-recheck', 'UNCLASSIFIED', 'ErrInvalidFlags', '; existing version recheck and retry handling follow'],
] as const)('%s delivery refusal has one literal metadata-only line', (kind, next, cls, name, ending) => {
  const line = buildAdDeliveryRefusalLine('alpha', kind)
  expect(line).toBe(`[slack] delivery: alpha outcome=refused step=text next=${next} class=${cls} name=${name} — AD refused this text call; delivery retained${ending}`)
  expect(line).not.toMatch(/no input attempted|dead session|item=|part=/)
  assertNoLeak(line)
})

test('validated not_started retains the existing outcome builder wording without stale state', () => {
  const facts = submissionUnconfirmedFactsOf(errSubmissionUnconfirmed({ outcome: 'not_started', keys_sent: false, submission_confirmed: false, enter_may_have_been_sent: false }), 'text')!
  const line = buildAdInputOutcomeLine({ personaRef: 'alpha', site: 'delivery', facts })
  expect(line).toBe('[slack] delivery: alpha outcome=not_started step=text next=read-before-retry — no input attempted for this call; read AD before retry')
  assertNoLeak(line)
})

test('hold notice pins the human release procedure and delivery-only review procedure', async () => {
  const n = await import('../src/ad-input-notices.ts')
  const persona = { key: 'alpha', name: 'Alpha' }, path = '/scratch/ad-input-holds/reviewed.json'
  const ref = escapeSlackControlCharacters(renderPersonaRef(persona.name, persona.key))
  expect(n.buildAdInputHoldNotice(persona, path)).toBe(`:warning: Automatic input to persona ${ref} is paused because a previous input may have reached the agent. Queued messages are kept and will not be resent automatically. A human must follow "Unresolved ordinary input" in the "Operator actions" section of agent-director's README and resolve the input. To release the hold, create a new persona launch that CSCB observes, or stop CSCB, remove the reviewed hold record ${path}, and start CSCB again. ${CONFLICT_NOTICE_HUMAN_ONLY_LINE}`)
  expect(n.buildAdDeliveryUnconfirmedNotice(persona)).toBe(`:warning: Delivery to persona ${ref} is unconfirmed. CSCB has kept the queued message and paused automatic resend. A human must follow "Unresolved ordinary input" in the "Operator actions" section of agent-director's README, resolve the input, and review the retained delivery before allowing it to be sent again. ${CONFLICT_NOTICE_HUMAN_ONLY_LINE}`)
})

test('input and delivery hold episodes deduplicate and route through the affected persona notifier', async () => {
  const n = await import('../src/ad-input-notices.ts')
  const root = mkdtempSync(join(tmpdir(), 'ad-input-notices-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const config = makeMultiPersonaConfig([{ key: 'alpha', name: 'Alpha', channels: [{ id: 'C0ALPHA', delivery: 'all' }] }, { key: 'beta', name: 'Beta', channels: [{ id: 'C0BETA', delivery: 'all' }] }], root)
  const h = makeNotifierHarness(config); cleanups.push(() => h.cleanup())
  const pending: Promise<unknown>[] = []
  const episodes = createPersonaEpisodes({ clock: h.clock, log: line => h.logs.push(line),
    sink(key, text, options) { const work = h.notifier.notify(key, text, options); pending.push(work); return work.then(() => {}) },
  })
  cleanups.push(() => episodes.close())
  const persona = config.personas[0]!, hold = n.buildAdInputHoldNotice(persona, join(root, 'reviewed.json'))
  const delivery = n.buildAdDeliveryUnconfirmedNotice(persona)
  for (let i = 0; i < 2; i++) {
    episodes.begin(persona.key, 'ad-input-unconfirmed'); episodes.post(persona.key, 'ad-input-unconfirmed', hold)
    episodes.begin(persona.key, 'ad-delivery-unconfirmed'); episodes.post(persona.key, 'ad-delivery-unconfirmed', delivery)
  }
  await Promise.all(pending)
  expect(h.posts('alpha').map(p => ({ channel: p.channel, text: p.text }))).toEqual([
    { channel: 'C0ALPHA', text: formatPersonaNotice(persona, hold) },
    { channel: 'C0ALPHA', text: formatPersonaNotice(persona, delivery) },
  ])
  expect(h.posts('beta')).toEqual([])
  assertNoLeak([h.allPosts(), h.logs])
})

test('uncertain outcome logs use validated facts and cannot claim that nothing was typed', async () => {
  const n = await import('../src/ad-input-notices.ts')
  const { submissionUnconfirmedFactsOf } = await import('../src/ad-error-class.ts')
  const { errSubmissionUnconfirmed } = await import('./test-helpers/agent-director-stub.ts')
  const rawReason = 'private-message-body-must-not-be-diagnostic'
  const facts = submissionUnconfirmedFactsOf(errSubmissionUnconfirmed({ outcome: 'submission_unconfirmed', keys_sent: true, submission_confirmed: false, enter_may_have_been_sent: true, reason: rawReason }), 'enter')!
  const line = n.buildAdInputOutcomeLine({ personaRef: 'persona=alpha', site: 'reconnect', facts, state: 'waiting' })
  expect(line).toContain(facts.kind)
  expect(line).not.toContain('nothing was typed')
  expect(line).not.toContain(rawReason)
  expect(line).not.toContain('\n')
  assertNoLeak(line)
})
