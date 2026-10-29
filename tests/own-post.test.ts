/**
 * own-post.test.ts — The bot's own posts (src/own-post.ts): own-post channel
 * eligibility, the observer that keeps a post's success apart from the
 * bookkeeping after it, and the reading of upload completions.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { completionFiles, createOwnPostObserver, decideOwnPostEligibility, fileShareRoot, ownPostEligibility,
  type OwnPostIssue, type OwnPostOwner, type OwnPostPosted } from '../src/own-post.ts'
import { SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { assertNoLeak, LEAK_SENTINEL, sentinelInMessage } from './test-helpers/credentials.ts'

const C = SHARED_CHANNEL_IDS.primary, C2 = SHARED_CHANNEL_IDS.secondary
const ROOT = '1700000000.000100', ROOT2 = '1700000000.000200'

describe('own-post eligibility', () => {
  test.each([
    ['unreadable choices, even over a negative membership reading', { listed: true, choiceReadable: false, choice: undefined, membership: { kind: 'ineligible', reason: 'absent' } },
      { kind: 'unresolved', mode: 'strict', reason: 'state-unavailable' }],
    ['a listed strict channel with a stored choice but no membership reading', { listed: true, choiceReadable: true, choice: 'thread_hybrid', membership: undefined },
      { kind: 'unresolved', mode: 'strict', delivery: 'thread_hybrid', reason: 'current-membership-missing' }],
  ] as const)('%s leaves own-post eligibility unresolved, never eligible or ineligible', (_name, inputs, expected) => {
    expect(decideOwnPostEligibility({ channel: C, mode: 'strict', ...inputs })).toEqual(expected)
  })

  const ELIGIBLE = { kind: 'eligible', lifetime: { incarnation: 'inc-1', boundary: 1, leaveBoundary: 0 }, identity: 'U0ALPHABOT', generation: 'g-1' } as const
  const READY = { listed: true, choiceReadable: true, choice: 'thread_hybrid', membership: ELIGIBLE } as const
  test.each([
    ['a DM channel', { ...READY, channel: 'D0ALPHADM1', mode: 'strict' }, { kind: 'ineligible', mode: 'strict', reason: 'dm' }],
    ['a malformed channel', { ...READY, channel: 'not-a-channel', mode: 'open' }, { kind: 'ineligible', mode: 'open', reason: 'invalid-channel' }],
    ['a strict unlisted channel with no stored choice', { ...READY, channel: C, mode: 'strict', listed: false, choice: undefined },
      { kind: 'ineligible', mode: 'strict', reason: 'unlisted' }],
    ['an open channel with no stored choice', { ...READY, channel: C, mode: 'open', listed: false, choice: undefined },
      { kind: 'unresolved', mode: 'open', reason: 'choice-missing' }],
    ['membership absent', { ...READY, channel: C, mode: 'open', membership: { kind: 'ineligible', reason: 'absent' } },
      { kind: 'ineligible', mode: 'open', reason: 'absent' }],
    ['membership externally shared', { ...READY, channel: C, mode: 'strict', membership: { kind: 'ineligible', reason: 'external-sharing' } },
      { kind: 'ineligible', mode: 'strict', reason: 'external-sharing' }],
    ['membership unresolved', { ...READY, channel: C, mode: 'open', choice: 'mentions', membership: { kind: 'unresolved', reason: 'event-order-conflict' } },
      { kind: 'unresolved', mode: 'open', delivery: 'mentions', reason: 'event-order-conflict' }],
    ['eligible membership with a stored choice', { ...READY, channel: C, mode: 'strict', choice: 'off' }, { kind: 'eligible', mode: 'strict', delivery: 'off' }],
  ] as const)('%s decides own-post eligibility from the channel, choice and membership alone', (_name, inputs, expected) => {
    expect(decideOwnPostEligibility(inputs)).toEqual(expected)
  })

  test('open mode reads no persona channel entries for own-post eligibility; strict mode reads the posting persona\'s', () => {
    const personaReads: string[] = [], membershipModes: string[] = []
    const eligibility = (mode: 'strict' | 'open', stored?: 'mentions') => ownPostEligibility({
      config: () => ({ channel_mode: mode }),
      persona: key => { personaReads.push(key); return { channels: [] } },
      choices: () => ({ readableFor: () => true, storedChoice: () => stored }),
      membership: (_key, _channel, m) => { membershipModes.push(m); return { kind: 'ineligible', reason: 'external-sharing' } },
    })
    expect(eligibility('open')('alpha', C)).toMatchObject({ kind: 'unresolved', mode: 'open', reason: 'choice-missing' })
    expect(eligibility('open', 'mentions')('alpha', C)).toMatchObject({ kind: 'ineligible', mode: 'open', reason: 'external-sharing' })
    expect(personaReads).toEqual([])
    expect(eligibility('strict')('alpha', C)).toMatchObject({ kind: 'ineligible', mode: 'strict', reason: 'unlisted' })
    expect(personaReads).toEqual(['alpha'])
    expect(membershipModes).toEqual(['open', 'open', 'strict'])
  })
})

describe('the own-post observer', () => {
  const ISSUE: OwnPostIssue = { key: 'alpha', surface: 'text', operation: 'op-observed', issuer: { botUserId: 'U0ALPHABOT', botId: 'B0ALPHABOT' } }
  const POSTED: OwnPostPosted = { channel: C, ts: ROOT, part: 2 }
  /** An owner recording each call in order; `confirm` answers its confirmations. */
  function recordingOwner(confirm: () => unknown = () => undefined) {
    const calls: unknown[][] = []
    const owner: OwnPostOwner = {
      issueOwnPost(key, surface, channel) { calls.push(['issue', key, surface, channel]); return { ...ISSUE, key, surface, ...(channel ? { channel } : {}) } },
      confirmOwnPost(issue, posted) { calls.push(['confirm', issue, posted]); return confirm() },
    }
    return { calls, owner }
  }
  /** Lets every settled promise's handlers, and any unhandled rejection they cause, run before the case ends. */
  const turn = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)) }
  const PATHS = [
    ['a synchronous throw', (error: Error) => () => { throw error }],
    ['an async rejection', (error: Error) => () => Promise.reject(error)],
  ] as const

  test('issue hands back the current owner\'s issue, and undefined when no owner is current or it throws', () => {
    const o = recordingOwner()
    expect(createOwnPostObserver(() => o.owner).issue('alpha', 'prompt', C)).toEqual({ ...ISSUE, surface: 'prompt', channel: C })
    expect(o.calls).toEqual([['issue', 'alpha', 'prompt', C]])
    expect(createOwnPostObserver(() => undefined).issue('alpha', 'text')).toBeUndefined()
    const throwing: OwnPostOwner = { issueOwnPost() { throw new Error('injected issue fault') }, confirmOwnPost() {} }
    expect(createOwnPostObserver(() => throwing).issue('alpha', 'text')).toBeUndefined()
  })

  test('confirm with no issue reads no owner and reports nothing; with no current owner it reports nothing', async () => {
    let reads = 0
    const o = recordingOwner(), faults: unknown[] = []
    expect(createOwnPostObserver(() => { reads++; return o.owner }, (...fault) => { faults.push(fault) }).confirm(undefined, POSTED)).toBeUndefined()
    expect(createOwnPostObserver(() => undefined, (...fault) => { faults.push(fault) }).confirm(ISSUE, POSTED)).toBeUndefined()
    await turn()
    expect([reads, o.calls, faults]).toEqual([0, [], []])
  })

  test('confirm hands the issue and posted values to the owner synchronously and returns before the owner\'s promise settles', async () => {
    let settle!: () => void
    const answer = new Promise<void>(resolve => { settle = resolve })
    const o = recordingOwner(() => answer), faults: unknown[] = []
    const observer = createOwnPostObserver(() => o.owner, (...fault) => { faults.push(fault) })
    // Not a promise: the post never waits on its bookkeeping.
    expect(observer.confirm(ISSUE, POSTED)).toBeUndefined()
    expect(o.calls).toEqual([['confirm', ISSUE, POSTED]])
    expect(o.calls[0]![1]).toBe(ISSUE)
    settle(); await turn()
    expect(faults).toEqual([])
  })

  test.each(PATHS)('%s of confirmOwnPost reaches onFault once, with the issue, the posted values and the error', async (_path, fails) => {
    const error = new Error('injected confirmation fault')
    const faults: Array<[OwnPostIssue, OwnPostPosted, unknown]> = []
    const observer = createOwnPostObserver(() => recordingOwner(fails(error)).owner, (...fault) => { faults.push(fault) })
    expect(observer.confirm(ISSUE, POSTED)).toBeUndefined()
    await turn()
    expect(faults).toEqual([[ISSUE, POSTED, error]])
    expect(faults[0]![2]).toBe(error)
  })

  test.each(PATHS)('a throw from onFault itself after %s of confirmOwnPost is swallowed', async (_path, fails) => {
    let reported = 0
    const observer = createOwnPostObserver(() => recordingOwner(fails(new Error('injected confirmation fault'))).owner,
      () => { reported++; throw new Error('injected reporting fault') })
    // A synchronous escape throws here; an async one is an unhandled rejection, which fails this file's run.
    expect(observer.confirm(ISSUE, POSTED)).toBeUndefined()
    await turn()
    expect(reported).toBe(1)
  })
})

describe('upload completions', () => {
  const F = 'F0UPLOAD1'
  const file = (shares: Array<{ ts: string; thread_ts?: string }>, channel: string = C, visibility: 'public' | 'private' = 'public') =>
    ({ id: F, created: 1_700_000_000, shares: { [visibility]: { [channel]: shares } } })

  test('a new upload root is its file\'s earliest share in the exact channel; IDs, creation times, other channels and re-shares name nothing', () => {
    expect(fileShareRoot(file([{ ts: ROOT2 }, { ts: ROOT }]), C)).toEqual({ kind: 'root', root: ROOT })
    expect(fileShareRoot(file([{ ts: ROOT }], C, 'private'), C)).toEqual({ kind: 'root', root: ROOT })
    expect(fileShareRoot(file([{ ts: ROOT }], C2), C)).toEqual({ kind: 'unresolved', reason: 'no-share' })
    expect(fileShareRoot(file([{ ts: ROOT2, thread_ts: ROOT }]), C)).toEqual({ kind: 'unresolved', reason: 'ambiguous' })
    expect(fileShareRoot({ id: F, created: 1_700_000_000, timestamp: 1_700_000_000 }, C)).toEqual({ kind: 'unresolved', reason: 'no-share' })
    expect(fileShareRoot({ id: F, shares: { public: { [C]: 'not-a-list' } } }, C)).toEqual({ kind: 'unresolved', reason: 'malformed' })
    expect(completionFiles({ ok: true, files: [file([{ ts: ROOT }]), { id: 'not-a-file-id' }] }, C)).toEqual([{ id: F, root: ROOT }])
    // A parent upload needs no share; an aggregate that is not ok confirms nothing.
    expect(completionFiles({ ok: true, files: [file([{ ts: ROOT }])] }, C, ROOT2)).toEqual([{ id: F }])
    expect(completionFiles({ ok: false, files: [file([{ ts: ROOT }])] }, C)).toEqual([])
    expect(completionFiles({ ok: true, files: [{ id: F, created: 1_700_000_000 }] }, C)).toEqual([{ id: F }])
  })

  test('a completion carrying the sentinel in its other fields gives back only file IDs and roots', () => {
    const response = { ok: true, warning: LEAK_SENTINEL, response_metadata: { messages: [sentinelInMessage('completion')] },
      files: [{ ...file([{ ts: ROOT, text: LEAK_SENTINEL } as { ts: string }]), name: LEAK_SENTINEL, url_private: sentinelInMessage('file') }] }
    const read = { files: completionFiles(response, C), root: fileShareRoot(response.files[0], C) }
    expect(read).toEqual({ files: [{ id: F, root: ROOT }], root: { kind: 'root', root: ROOT } })
    assertNoLeak(read)
  })
})
