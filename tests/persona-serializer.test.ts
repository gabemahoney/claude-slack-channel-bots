/**
 * persona-serializer.test.ts — per-persona lifecycle serialization (b.av2 SR-6.6).
 *
 * Drives `createPersonaSerializer` with controllable operations only (each
 * one a `Promise.withResolvers` gate the test settles); no timer, no real
 * delay. The bring-up controller's use of the serializer is tested in
 * tests/persona-connections.test.ts (`bring-up retries are serialized per
 * persona`).
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { createPersonaSerializer, type PersonaSerializer } from '../src/persona-serializer.ts'

/** Let every pending promise continuation run (no timer is involved anywhere here). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/**
 * One controllable operation per label: `run` submits it for `key`; it logs
 * `start:<label>` when it starts and stays pending until `resolve(label)` or
 * `reject(label)`, then logs `end:<label>`. `results` holds what each
 * submitter's promise settled with.
 */
function makeOps(s: PersonaSerializer) {
  const log: string[] = []
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>()
  const results = new Map<string, { ok: string } | { err: unknown }>()
  return {
    log,
    results,
    run(key: string, label: string): Promise<string> {
      const gate = Promise.withResolvers<string>()
      gates.set(label, gate)
      const p = s.run(key, () => {
        log.push(`start:${label}`)
        return gate.promise.finally(() => log.push(`end:${label}`))
      })
      p.then(ok => void results.set(label, { ok }), err => void results.set(label, { err }))
      return p
    },
    resolve: (label: string) => gates.get(label)!.resolve(`${label}-value`),
    reject: (label: string, err: unknown) => gates.get(label)!.reject(err),
  }
}

/** Whether `p` has settled, after pending continuations ran. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  await flush()
  return done
}

describe('createPersonaSerializer: one persona (SR-6.6)', () => {
  test.each<['resolves' | 'rejects']>([['resolves'], ['rejects']])(
    'the second operation for a persona starts only after the first %s, and each submitter gets its own operation\'s result',
    async (how) => {
      const s = createPersonaSerializer()
      const ops = makeOps(s)
      const failure = new Error('first failed')
      void ops.run('alpha', 'one')
      void ops.run('alpha', 'two')
      await flush()
      expect(ops.log).toEqual(['start:one'])

      if (how === 'resolves') ops.resolve('one')
      else ops.reject('one', failure)
      await flush()

      expect(ops.log).toEqual(['start:one', 'end:one', 'start:two'])
      expect(ops.results.get('one')).toEqual(how === 'resolves' ? { ok: 'one-value' } : { err: failure })
      expect(ops.results.has('two')).toBe(false)
      ops.resolve('two')
      await flush()
      expect(ops.results.get('two')).toEqual({ ok: 'two-value' })
    },
  )

  test('operations run in submission order, one at a time, including one submitted after an earlier one settled while another is still queued', async () => {
    const s = createPersonaSerializer()
    const ops = makeOps(s)
    void ops.run('alpha', 'one')
    void ops.run('alpha', 'two')
    ops.resolve('one')
    await flush()
    // One settled with two still running: a third submitted now waits for two.
    void ops.run('alpha', 'three')
    void ops.run('alpha', 'four')
    await flush()
    expect(ops.log).toEqual(['start:one', 'end:one', 'start:two'])

    for (const label of ['two', 'three', 'four']) {
      ops.resolve(label)
      await flush()
    }
    expect(ops.log).toEqual([
      'start:one', 'end:one', 'start:two', 'end:two', 'start:three', 'end:three', 'start:four', 'end:four',
    ])
  })

  test('a rejected, a synchronously throwing and a synchronously returning operation do not wedge the persona: each result reaches its own submitter and the next operation runs', async () => {
    const s = createPersonaSerializer()
    const rejection = new Error('async failure')
    const thrown = new Error('sync throw')
    const order: string[] = []

    const rejected = s.run('alpha', async () => { order.push('rejects'); throw rejection })
    const threw = s.run('alpha', () => { order.push('throws'); throw thrown })
    const returned = s.run('alpha', () => { order.push('returns'); return 42 })
    const after = s.run('alpha', async () => { order.push('after'); return 'still runs' })

    await expect(rejected).rejects.toBe(rejection)
    await expect(threw).rejects.toBe(thrown)
    expect(await returned).toBe(42)
    expect(await after).toBe('still runs')
    expect(order).toEqual(['rejects', 'throws', 'returns', 'after'])
  })
})

describe('createPersonaSerializer: personas are independent (SR-3.3, SR-6.6)', () => {
  test('persona B\'s operation starts and completes while persona A\'s is still pending, and A\'s later operation still waits for A only', async () => {
    const s = createPersonaSerializer()
    const ops = makeOps(s)
    void ops.run('alpha', 'a1')
    void ops.run('alpha', 'a2')
    const b1 = ops.run('beta', 'b1')
    await flush()
    expect(ops.log).toEqual(['start:a1', 'start:b1'])

    ops.resolve('b1')
    expect(await b1).toBe('b1-value')
    const b2 = ops.run('beta', 'b2')
    ops.resolve('b2')
    expect(await b2).toBe('b2-value')
    expect(await settled(s.whenIdle('beta'))).toBe(true)

    // A is still blocked on a1 throughout.
    expect(ops.log.filter(l => l.includes(':a'))).toEqual(['start:a1'])
    expect(await settled(s.whenIdle('alpha'))).toBe(false)
    ops.resolve('a1')
    await flush()
    expect(ops.log.filter(l => l.includes(':a'))).toEqual(['start:a1', 'end:a1', 'start:a2'])
  })
})

describe('createPersonaSerializer: whenIdle', () => {
  test('resolves at once for a persona with nothing submitted, and for one whose operations all settled', async () => {
    const s = createPersonaSerializer()
    expect(await settled(s.whenIdle('alpha'))).toBe(true)
    await s.run('alpha', () => 'done')
    expect(await settled(s.whenIdle('alpha'))).toBe(true)
  })

  test('waits for every operation submitted before the call (queued ones included), not for one submitted after it, and never rejects when they reject', async () => {
    const s = createPersonaSerializer()
    const ops = makeOps(s)
    void ops.run('alpha', 'one')
    void ops.run('alpha', 'two')
    const idle = s.whenIdle('alpha')
    void ops.run('alpha', 'three')
    let idleOutcome: string | undefined
    idle.then(() => { idleOutcome = 'resolved' }, () => { idleOutcome = 'rejected' })

    ops.reject('one', new Error('one failed'))
    await flush()
    expect(idleOutcome).toBeUndefined()
    ops.reject('two', new Error('two failed'))
    await flush()

    expect(idleOutcome).toBe('resolved')
    // Three was submitted after the call and is still running.
    expect(ops.log.at(-1)).toBe('start:three')
    expect(ops.results.has('three')).toBe(false)
  })
})
