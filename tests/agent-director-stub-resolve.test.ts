/**
 * agent-director-stub-resolve.test.ts — the stub `resolveSystemBinary`
 * factory, `makeStubResolveSystemBinary` (tests/test-helpers/agent-director-stub.ts),
 * whose `outcomes` queue drives the runtime version re-check's sequences.
 *
 * Covers the no-options default, the ordered `outcomes` queue with its last
 * entry repeating, a `{ throws }` entry rejecting with that exact error, a
 * `{ never: true }` entry staying pending, the `calls` capture, the three
 * option combinations the factory refuses when the stub is built, and the
 * default path pinned to the canned install-check results' `CANNED_BINARY_PATH`.
 *
 * Every version comes from tests/test-helpers/agent-director-versions.ts.
 * No timer runs: a pending call is shown by racing it against an already
 * resolved sentinel after flushing microtasks. No module is mocked and no
 * agent-director binary or client is touched.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import {
  makeStubResolveSystemBinary,
  STUB_RESOLVE_DEFAULT_PATH,
  type StubResolveSystemBinaryOptions,
} from './test-helpers/agent-director-stub.ts'
import {
  OLD_AD_VERSION,
  PHASE1_RC_VERSION,
} from './test-helpers/agent-director-versions.ts'
import { CANNED_BINARY_PATH } from './test-helpers/install-check-fixtures.ts'

const PENDING = Symbol('pending')

/** Settle every queued microtask, so an answer that is coming has arrived. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/**
 * Whether `p` has settled, without a timer: `PENDING` if it has not. `p` is
 * raced directly (not through a `.then`, which would settle a tick after the
 * sentinel), so a settled `p` wins the race.
 */
async function settledOrPending(p: Promise<unknown>): Promise<'settled' | typeof PENDING> {
  await flushMicrotasks()
  const winner = await Promise.race([p, Promise.resolve(PENDING)]).catch(() => 'settled' as const)
  return winner === PENDING ? PENDING : 'settled'
}

describe('makeStubResolveSystemBinary', () => {
  test('with no options every call resolves with PHASE1_RC_VERSION at the default path', async () => {
    const resolve = makeStubResolveSystemBinary()

    expect(await resolve()).toEqual({ path: STUB_RESOLVE_DEFAULT_PATH, version: PHASE1_RC_VERSION })
    expect(await resolve()).toEqual({ path: STUB_RESOLVE_DEFAULT_PATH, version: PHASE1_RC_VERSION })
  })

  test("the default path is the canned install-check results' default path, so a stub run and a canned result agree", () => {
    expect(STUB_RESOLVE_DEFAULT_PATH).toBe(CANNED_BINARY_PATH)
  })

  test('outcomes answer the calls in order, then the last entry answers every later call', async () => {
    const first = new Error('first')
    const resolve = makeStubResolveSystemBinary({
      path: '/opt/ad/bin/agent-director',
      outcomes: [
        { version: OLD_AD_VERSION },
        { throws: first },
        { version: PHASE1_RC_VERSION, path: '/srv/ad/agent-director' },
      ],
    })

    expect(await resolve()).toEqual({ path: '/opt/ad/bin/agent-director', version: OLD_AD_VERSION })
    await expect(resolve()).rejects.toBe(first)
    const last = { path: '/srv/ad/agent-director', version: PHASE1_RC_VERSION }
    expect(await resolve()).toEqual(last)
    // Past the end of the list: the last entry repeats, not the first.
    expect(await resolve()).toEqual(last)
    expect(await resolve()).toEqual(last)
  })

  test('a { never: true } entry stays pending while a later entry still answers', async () => {
    const resolve = makeStubResolveSystemBinary({
      outcomes: [{ never: true }, { version: OLD_AD_VERSION }],
    })

    const hung = resolve()
    const answered = resolve()

    expect(await settledOrPending(hung)).toBe(PENDING)
    // Control: the same check reads a call that did answer as settled.
    expect(await settledOrPending(answered)).toBe('settled')
    expect(await answered).toEqual({ path: STUB_RESOLVE_DEFAULT_PATH, version: OLD_AD_VERSION })
  })

  test('calls records every call in order with its opts, a never-settling call included', async () => {
    const calls: Array<object | undefined> = []
    const resolve = makeStubResolveSystemBinary({
      calls,
      outcomes: [{ version: PHASE1_RC_VERSION }, { never: true }, { throws: new Error('x') }],
    })
    const optsA = { timeoutMs: 1 }
    const optsB = { timeoutMs: 2 }

    await resolve(optsA)
    const hung = resolve(optsB)
    await expect(resolve()).rejects.toThrow()

    expect(await settledOrPending(hung)).toBe(PENDING)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toBe(optsA)
    expect(calls[1]).toBe(optsB)
    expect(calls[2]).toBeUndefined()
  })

  test('calls also records calls made without outcomes', async () => {
    const calls: Array<object | undefined> = []
    const err = new Error('always')
    const resolve = makeStubResolveSystemBinary({ calls, throws: err })
    const opts = { timeoutMs: 3 }

    await expect(resolve(opts)).rejects.toBe(err)
    await expect(resolve()).rejects.toBe(err)

    expect(calls).toEqual([opts, undefined])
    expect(calls[0]).toBe(opts)
  })

  test.each<[string, StubResolveSystemBinaryOptions, string]>([
    ['outcomes with throws', { outcomes: [{ version: PHASE1_RC_VERSION }], throws: new Error('x') }, 'throws'],
    ['outcomes with version', { outcomes: [{ version: PHASE1_RC_VERSION }], version: OLD_AD_VERSION }, 'version'],
    ['an empty outcomes list', { outcomes: [] }, 'at least one'],
  ])('%s throws when the stub is built, before any call', (_label, opts, fragment) => {
    // Each fragment appears in its own refusal only, so each row names which one fired.
    expect(() => makeStubResolveSystemBinary(opts)).toThrow(fragment)
  })
})
