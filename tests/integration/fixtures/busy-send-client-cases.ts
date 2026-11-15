/** Worker for busy-send-client-controls.ts; all subprocesses are inert. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, AgentDirectorError, ErrUnknownErrorName, ErrSpawnNotPausable } from 'agent-director'
import { createCoveredDelivery, createCoveredReconnect, type CoveredClient } from '../../../src/covered-delivery.ts'
import { cantSendDetailsOf, classifyAdError, notPausableCauseOf } from '../../../src/ad-error-class.ts'
import { createDeliveryQueue } from '../../../src/delivery-queue.ts'

const root = process.argv[2]
assert(root, 'run through busy-send-client-controls.ts')
const binary = join(root, 'inert-ad'), envelope = join(root, 'error.json')
writeFileSync(binary, '#!/bin/bash\nif [[ "$1" == "--version" || "$1" == "version" ]]; then printf \'{"version":"0.19.0-rc.kii.e2"}\\n\'; exit 0; fi\ncat -- "${0%/*}/error.json" >&2\nexit 1\n', { mode: 0o700 })
const cliOptions = { _cliPath: binary }
const decoder = await Client.create(cliOptions as Parameters<typeof Client.create>[0])
async function decoded(name: string, details: unknown, verb: 'send-keys' | 'pause' = 'send-keys') {
  writeFileSync(envelope, JSON.stringify({ status: 'error', err_name: name, err_description: 'inert refusal', err_details: details }))
  try {
    if (verb === 'pause') await decoder.pause({ instance_id: 'own' })
    else await decoder.sendKeys({ instance_id: 'own', text: 'exact' })
    assert.fail('inert executable must refuse')
  } catch (error) {
    assert(error instanceof AgentDirectorError)
    return error
  }
}
try {
  const failures: string[] = []
  for (const reason of ['agent_not_covered', 'held_count', 'held_bytes']) {
    try {
      const facts = { class: 'cant_send', reason, resend_safe: true, retry_with: 'new_send', limit: { actual: 2, allowed: 1 } }
      const error = await decoded('ErrCantSend', facts)
      const form = error instanceof ErrUnknownErrorName ? 'legacy-envelope' : 'native'
      assert.equal(form, process.argv[3], 'the requested real client must decode this refusal')
      if (form === 'native') assert.equal(error.errName, 'ErrCantSend')
      let now = 1000, sends = 0
      const queue = createDeliveryQueue({ stateDir: join(root, reason), now: () => now })
      await queue.start()
      try {
        const accepted = await queue.accept('fixture', { source: 'interject', sender: 'fixture', text: 'exact' })
        assert.equal(accepted.status, 'accepted')
        await queue.append('fixture', { v: 1, kind: 'fixed', seq: accepted.seq, parts: ['exact'] })
        const row = { instance_id: 'own', session_id: 'session', state: 'waiting', busy_send: 'covered' } as const
        let reads = 0
        const client = { sendKeys: async () => { sends++; throw error }, getDelivery: async () => { assert.fail('refused input must not become lookup-only') } } as unknown as CoveredClient
        const adapter = createCoveredDelivery({ queue, now: () => now, log: () => {} })
        const step = () => adapter.step({ key: 'fixture', row: row as any, part: 1, item: queue.item('fixture', accepted.seq)!,
          readRow: async () => ({ ...row, busy_send: ++reads >= 3 && reason === 'agent_not_covered' ? 'not_covered' : 'covered' }) as any,
          ready: () => true, client: async () => client, call: async (_verb, run) => run(client), delivered: () => assert.fail('refusal is not delivery') })
        assert.equal(await step(), reason === 'agent_not_covered' ? 'legacy' : 'waiting')
        assert(queue.item('fixture', accepted.seq)!.records.some(r => r.kind === 'refused'))
        assert.deepEqual(cantSendDetailsOf(error), facts)
        assert.equal(classifyAdError(error).errorClass, 'STATE')
        if (reason !== 'agent_not_covered') {
          now += 4999; await step(); assert.equal(sends, 1)
          now++; await step(); assert.equal(sends, 2, 'capacity refusal must retry at five seconds')
          const intents = queue.item('fixture', accepted.seq)!.records.filter(r => r.kind === 'submitted')
          assert.equal(intents.length, 2)
          assert.notEqual(intents[0]!.delivery_request_id, intents[1]!.delivery_request_id)
        }
        console.log(`PASS ${form}: ${reason} uses safe ${reason === 'agent_not_covered' ? 'fallback' : 'capacity retry'}`)
      } finally { await queue.stop() }
    } catch (error) {
      failures.push(reason)
      console.error(`FAIL real decoder: ${reason}`)
      assert(error instanceof Error)
    }
  }
  assert.deepEqual(failures, [], 'safe refusal cases must all reach policy')
  for (const details of [null, [], { class: 'wrong', reason: 'held_count', resend_safe: true, retry_with: 'new_send' },
    { class: 'cant_send', reason: '', resend_safe: true, retry_with: 'new_send' },
    { class: 'cant_send', reason: 'held_count', resend_safe: 'true', retry_with: 'new_send' },
    { class: 'cant_send', reason: 'held_count', resend_safe: true, retry_with: null }]) {
    assert.equal(cantSendDetailsOf(await decoded('ErrCantSend', details)), undefined)
  }
  const facts = { class: 'cant_send', reason: 'held_count', resend_safe: true, retry_with: 'new_send' }
  assert.equal(cantSendDetailsOf(new AgentDirectorError('send-keys', 'ErrCantSend', 'named base', facts)), undefined)
  assert.equal(cantSendDetailsOf({ name: 'ErrCantSend', errDetails: facts }), undefined)
  const pauseError = await decoded('ErrSpawnNotPausable', { cause: 'pause_in_progress' }, 'pause')
  assert(pauseError instanceof ErrSpawnNotPausable)
  assert.equal(notPausableCauseOf(pauseError), 'pause_in_progress')
  let ended = false, resumed = false
  const row = { instance_id: 'own', session_id: 'session', busy_send: 'covered', state: 'waiting' } as const
  assert.equal(await createCoveredReconnect({ onlyIfWaiting: true })({ key: 'fixture', row: row as any,
    readRow: async () => ({ ...row, state: ended ? 'ended' : 'waiting' }) as any,
    pause: async () => { ended = true; throw pauseError }, resume: async () => { resumed = true },
    ready: () => true, log: () => {}, notify: () => assert.fail('unexpected notice') }), 'ok')
  assert(resumed)
  assert.equal(notPausableCauseOf(await decoded('ErrSpawnNotPausable', { cause: 'future_cause' }, 'pause')), undefined)
  console.log('PASS real decoder: malformed refusals rejected; native conditional-pause details retain checked resume')
} finally { decoder.close() }
