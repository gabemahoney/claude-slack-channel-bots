import { describe, expect, test } from 'bun:test'
import {
  createDeliveryPolicyState, createDeliveryReading, decideEngine,
  NO_DELIVERY_PAIR, selectDeliveryTarget,
  type DeliveryPair, type DeliveryPolicyKnowledge, type EngineAction,
} from '../src/delivery-policy'

type KnowledgeInput = Omit<Partial<DeliveryPolicyKnowledge>, 'p' | 'e' | 'r'> & {
  p?: Partial<DeliveryPolicyKnowledge['p']>
  e?: Partial<DeliveryPolicyKnowledge['e']>
  r?: Partial<DeliveryPolicyKnowledge['r']>
}

// Policy knowledge only: no queue records, Slack payloads, I/O or timers.
function knowledge({ p, e, r, ...rest }: KnowledgeInput = {}): DeliveryPolicyKnowledge {
  return {
    p: { accepted: [1, 2, 3], fixed: [], sent: [], refused: [], delivered: [], ...p },
    e: { ...createDeliveryPolicyState(), ...e },
    r: { ...createDeliveryReading(), up: true, row: 'waiting', marker: true, relay: true, mcp: true, gate: 'delivery', ...r },
    g: { owner: 'delivery', stage: 'idle', deferred: false, due: false },
    writer: { kind: 'none' }, compact: 'idle', ...rest,
  }
}

function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  Object.values(value).forEach(freeze)
  Object.freeze(value)
}

function check(k: DeliveryPolicyKnowledge, target: DeliveryPair, action: EngineAction): void {
  // Clone before freezing so a table row never freezes production defaults or
  // another row's inputs. Every case also checks both functions' purity.
  const input = structuredClone(k)
  freeze(input)
  expect(selectDeliveryTarget(input)).toEqual(target)
  expect(decideEngine(input)).toBe(action)
  expect(input).toEqual(k)
}

describe('Memory Hold delivery policy', () => {
  test.each([
    { name: 'head', held: [1], delivered: [], target: [2, 1] },
    { name: 'head after the first passed item delivers', held: [1], delivered: [[2, 1]], target: [3, 1] },
    { name: 'middle before its predecessor delivers', held: [2], delivered: [], target: [1, 1] },
    { name: 'middle after its predecessor delivers', held: [2], delivered: [[1, 1]], target: [3, 1] },
    { name: 'last with earlier work remaining', held: [3], delivered: [[1, 1]], target: [2, 1] },
    { name: 'last with all earlier work delivered', held: [3], delivered: [[1, 1], [2, 1]], target: NO_DELIVERY_PAIR },
    { name: 'several held items', held: [1, 2], delivered: [], target: [3, 1] },
    { name: 'all held', held: [1, 2, 3], delivered: [], target: NO_DELIVERY_PAIR },
    { name: 'an unrelated hold', held: [4], delivered: [], target: [1, 1] },
    // Post Holds: earlier work is selected first, nothing at or behind one.
    { name: 'nothing behind a Post Hold at the head', held: [], post: [1], delivered: [], target: NO_DELIVERY_PAIR },
    { name: 'earlier work ahead of a Post Hold in the middle', held: [], post: [2], delivered: [], target: [1, 1] },
    { name: 'nothing at or behind a Post Hold in the middle once earlier work delivers', held: [], post: [2], delivered: [[1, 1]], target: NO_DELIVERY_PAIR },
    { name: 'earlier work ahead of a last Post Hold', held: [], post: [3], delivered: [[1, 1]], target: [2, 1] },
    { name: 'nothing at a last Post Hold once earlier work delivers', held: [], post: [3], delivered: [[1, 1], [2, 1]], target: NO_DELIVERY_PAIR },
    { name: 'earlier work ahead of several Post Holds', held: [], post: [2, 3], delivered: [], target: [1, 1] },
    { name: 'nothing behind several Post Holds', held: [], post: [2, 3], delivered: [[1, 1]], target: NO_DELIVERY_PAIR },
    { name: 'nothing when every item is a Post Hold', held: [], post: [1, 2, 3], delivered: [], target: NO_DELIVERY_PAIR },
    { name: 'an unrelated Post Hold', held: [], post: [4], delivered: [], target: [1, 1] },
    { name: 'a Memory Hold ahead of a Post Hold', held: [1], post: [3], delivered: [], target: [2, 1] },
    { name: 'nothing past a Post Hold once the item between delivers', held: [1], post: [3], delivered: [[2, 1]], target: NO_DELIVERY_PAIR },
    { name: 'nothing past a Post Hold right behind a Memory Hold', held: [1], post: [2], delivered: [], target: NO_DELIVERY_PAIR },
    { name: 'earlier work ahead of a Post Hold behind a Memory Hold', held: [2], post: [3], delivered: [], target: [1, 1] },
    { name: 'nothing past a Post Hold to items behind a later Memory Hold', held: [2], post: [1], delivered: [], target: NO_DELIVERY_PAIR },
    { name: 'nothing past a Post Hold ahead of a Memory Hold', held: [3], post: [1], delivered: [], target: NO_DELIVERY_PAIR },
  ] satisfies { name: string; held: number[]; post?: number[]; delivered: DeliveryPair[]; target: DeliveryPair }[])(
    'passes $name', ({ held, post = [], delivered, target }) => {
      check(knowledge({
        p: { accepted: [3, 1, 2], delivered },
        holds: [...held.map(item => ({ item, kind: 'memory' as const })), ...post.map(item => ({ item, kind: 'post' as const }))],
      }), target, target[0] === 0 ? 'wait' : 'fixText')
    },
  )

  test('release restores the original position before unsent and newly accepted items', () => {
    const k = knowledge({ holds: [{ item: 1, kind: 'memory' }] })
    check(k, [2, 1], 'fixText')
    // Item 2 has delivered, but item 3 has no attempt in flight.
    k.p.delivered = [[2, 1]]
    check(k, [3, 1], 'fixText')
    k.p.accepted = [...k.p.accepted, 4]
    k.holds = []
    check(k, [1, 1], 'fixText')
    k.p.delivered = [...k.p.delivered, [1, 1]]
    check(k, [3, 1], 'fixText')
  })

  test.each([
    { name: 'pending durable send', p: { sent: [] }, writer: { kind: 'sent', item: 2 }, target: [2, 1], action: 'commitAppend' },
    { name: 'recorded attempt across restart', target: [2, 1], action: 'recordRecoveryEnter' },
    { name: 'between parts after the first receipt', p: { delivered: [[2, 1]] }, target: [2, 2], action: 'recordSend' },
    { name: 'last part awaiting receipt', p: { delivered: [[2, 1]], sent: [{ item: 2, part: 1, offset: 0 }, { item: 2, part: 2, offset: 1 }] }, target: [2, 2], action: 'recordRecoveryEnter' },
    { name: 'whole item delivered', p: { delivered: [[2, 1], [2, 2]] }, target: [1, 1], action: 'fixText' },
    { name: 'only attempt definitely refused', p: { refused: [1] }, target: [1, 1], action: 'fixText' },
    { name: 'refused later attempt with an earlier part delivered', p: { delivered: [[2, 1]], sent: [{ item: 2, part: 1, offset: 0 }, { item: 2, part: 2, offset: 1 }], refused: [2] }, target: [2, 2], action: 'recordSend' },
  ] satisfies (KnowledgeInput & { name: string; target: DeliveryPair; action: EngineAction })[])(
    'release preserves one whole item in flight: $name', ({ name: _name, target, action, p, ...input }) => {
      // Removing the hold may expose item 1 while item 2 is still in flight.
      // A fresh engine state models restart; durable facts retain ownership.
      check(knowledge({
        holds: [], parts: { 2: 2 },
        p: { fixed: [2], sent: [{ item: 2, part: 1, offset: 0 }], ...p },
        ...input,
      }), target, action)
    },
  )

  test('a passed multipart item keeps part order, then a released multipart hold starts at part one', () => {
    const k = knowledge({ holds: [{ item: 1, kind: 'memory' }], parts: { 1: 2, 2: 2 }, p: { fixed: [1, 2, 3] } })
    check(k, [2, 1], 'recordSend')
    k.p.sent = [{ item: 2, part: 1, offset: 0 }]
    k.p.delivered = [[2, 1]]
    check(k, [2, 2], 'recordSend')
    k.holds = []
    check(k, [2, 2], 'recordSend')
    k.p.delivered = [[2, 1], [2, 2]]
    check(k, [1, 1], 'recordSend')
    k.p.delivered = [...k.p.delivered, [1, 1]]
    check(k, [1, 2], 'recordSend')
  })

  test('withdrawn items absent from accepted cannot be selected, even with historical send facts', () => {
    const k = knowledge({
      holds: [], p: { accepted: [3, 2], fixed: [1], sent: [{ item: 1, part: 1, offset: 0 }] },
    })
    check(k, [2, 1], 'fixText')
    k.p.delivered = [[2, 1], [3, 1]]
    check(k, NO_DELIVERY_PAIR, 'wait')
  })
})

describe('Post Hold delivery policy', () => {
  test('a released Post Hold is selected at its position, then the items behind it', () => {
    const k = knowledge({ holds: [{ item: 2, kind: 'post' }], p: { delivered: [[1, 1]] } })
    check(k, NO_DELIVERY_PAIR, 'wait')
    // Newly accepted work waits behind the hold too.
    k.p.accepted = [...k.p.accepted, 4]
    check(k, NO_DELIVERY_PAIR, 'wait')
    k.holds = []
    check(k, [2, 1], 'fixText')
    k.p.delivered = [...k.p.delivered, [2, 1]]
    check(k, [3, 1], 'fixText')
  })

  test('a withdrawn Post Hold leaves accepted and holds, so the item behind it is selected', () => {
    const k = knowledge({ holds: [{ item: 2, kind: 'post' }], p: { delivered: [[1, 1]] } })
    check(k, NO_DELIVERY_PAIR, 'wait')
    k.holds = []
    k.p.accepted = [1, 3]
    check(k, [3, 1], 'fixText')
  })

  test('a parked Post Hold is passed as a Memory Hold, then selected once released', () => {
    const k = knowledge({ holds: [{ item: 2, kind: 'post' }], p: { delivered: [[1, 1]] } })
    check(k, NO_DELIVERY_PAIR, 'wait')
    k.holds = [{ item: 2, kind: 'memory' }]
    check(k, [3, 1], 'fixText')
    k.p.delivered = [...k.p.delivered, [3, 1]]
    check(k, NO_DELIVERY_PAIR, 'wait')
    k.holds = []
    check(k, [2, 1], 'fixText')
  })

  test('a released Memory Hold ahead of a Post Hold is selected before the Post Hold resolves', () => {
    const k = knowledge({ holds: [{ item: 1, kind: 'memory' }, { item: 3, kind: 'post' }] })
    check(k, [2, 1], 'fixText')
    k.p.delivered = [[2, 1]]
    check(k, NO_DELIVERY_PAIR, 'wait')
    k.holds = [{ item: 3, kind: 'post' }]
    check(k, [1, 1], 'fixText')
    k.p.delivered = [...k.p.delivered, [1, 1]]
    check(k, NO_DELIVERY_PAIR, 'wait')
    k.holds = []
    check(k, [3, 1], 'fixText')
  })

  test.each([
    { name: 'pending durable send', p: { sent: [] }, writer: { kind: 'sent', item: 2 }, target: [2, 1], action: 'commitAppend' },
    { name: 'recorded attempt across restart', target: [2, 1], action: 'recordRecoveryEnter' },
    { name: 'between parts after the first receipt', p: { delivered: [[1, 1], [2, 1]] }, target: [2, 2], action: 'recordSend' },
    { name: 'whole item delivered', p: { delivered: [[1, 1], [2, 1], [2, 2]] }, target: NO_DELIVERY_PAIR, action: 'wait' },
  ] satisfies (KnowledgeInput & { name: string; target: DeliveryPair; action: EngineAction })[])(
    'a later Post Hold keeps one whole item in flight: $name', ({ name: _name, target, action, p, ...input }) => {
      check(knowledge({
        holds: [{ item: 3, kind: 'post' }], parts: { 2: 2 },
        p: { fixed: [2], sent: [{ item: 2, part: 1, offset: 0 }], delivered: [[1, 1]], ...p },
        ...input,
      }), target, action)
    },
  )

  test('multipart items ahead of a Post Hold keep part order, and a released one starts at part one', () => {
    const k = knowledge({ holds: [{ item: 3, kind: 'post' }], parts: { 1: 2, 3: 2 }, p: { fixed: [1, 2, 3] } })
    check(k, [1, 1], 'recordSend')
    k.p.delivered = [[1, 1]]
    check(k, [1, 2], 'recordSend')
    k.p.delivered = [...k.p.delivered, [1, 2]]
    check(k, [2, 1], 'recordSend')
    k.p.delivered = [...k.p.delivered, [2, 1]]
    check(k, NO_DELIVERY_PAIR, 'wait')
    k.holds = []
    check(k, [3, 1], 'recordSend')
    k.p.delivered = [...k.p.delivered, [3, 1]]
    check(k, [3, 2], 'recordSend')
  })
})

describe('engine choices with Memory Holds', () => {
  test.each([
    { name: 'fix', input: {}, action: 'fixText' },
    { name: 'request the gate', input: { p: { fixed: [2] }, r: { gate: 'free' } }, action: 'requestGate' },
    { name: 'first send', input: { p: { fixed: [2] } }, action: 'recordSend' },
    { name: 'recover Enter', input: { p: { fixed: [2], sent: [{ item: 2, part: 1, offset: 0, attempt: 1 }] } }, action: 'recordRecoveryEnter' },
    { name: 'retype', input: { p: { fixed: [2], sent: [{ item: 2, part: 1, offset: 0, attempt: 1 }] }, e: { recoveryAttempt: 1 } }, action: 'recordSend' },
    { name: 'confirm an exact receipt', input: { p: { fixed: [2], sent: [{ item: 2, part: 1, offset: 0 }] }, r: { receipts: [1], records: [{ kind: 'take-in', text: [2, 1] }] } }, action: 'readReceipt' },
    { name: 'wait for AD waiting', input: { p: { fixed: [2] }, r: { row: 'working' } }, action: 'wait' },
  ] satisfies { name: string; input: KnowledgeInput; action: EngineAction }[])(
    'the passed item can $name; the held item cannot', ({ input, action }) => {
      check(knowledge({ ...input, p: { accepted: [2], ...input.p } }), [2, 1], action)
      const held = knowledge({ ...input, holds: [{ item: 1, kind: 'memory' }], p: { accepted: [1, 2], ...input.p } })
      check(held, [2, 1], action)
      // Keep all fixed/send/receipt facts for item 2, but hold it as well.
      // Such facts cannot make an unresolved hold fix/send/retype/confirm.
      held.holds = [{ item: 1, kind: 'memory' }, { item: 2, kind: 'memory' }]
      check(held, NO_DELIVERY_PAIR, 'wait')
      // Nor can a Post Hold, and it is never passed like a Memory Hold.
      held.holds = [{ item: 1, kind: 'memory' }, { item: 2, kind: 'post' }]
      check(held, NO_DELIVERY_PAIR, 'wait')
      // The item ahead of a Post Hold gets today's action.
      check(knowledge({ ...input, holds: [{ item: 3, kind: 'post' }], p: { accepted: [2, 3], ...input.p } }), [2, 1], action)
    },
  )

  test.each([
    { name: 'AD waiting with the gate', r: {} },
    { name: 'AD waiting with the gate free', r: { gate: 'free' } },
    { name: 'AD working', r: { row: 'working' } },
    { name: 'a take-in matching the item behind', r: { receipts: [1], records: [{ kind: 'take-in', text: [2, 1] }] } },
  ] satisfies { name: string; r: KnowledgeInput['r'] }[])(
    'nothing behind a Post Hold is fixed or sent under $name', ({ r }) => {
      check(knowledge({ holds: [{ item: 1, kind: 'post' }], p: { accepted: [1, 2, 3] }, r }), NO_DELIVERY_PAIR, 'wait')
      check(knowledge({ holds: [{ item: 1, kind: 'post' }], p: { accepted: [1, 2, 3], fixed: [2, 3] }, r }), NO_DELIVERY_PAIR, 'wait')
    },
  )

  test.each(['pending', 'waiting', 'working', 'ask_user', 'check_permission', 'ended', 'missing'])(
    'an all-held queue has no target under AD %s, even with an exact receipt', row => {
      check(knowledge({
        holds: [{ item: 1, kind: 'memory' }],
        p: { accepted: [1], fixed: [1], sent: [{ item: 1, part: 1, offset: 0 }] },
        r: { row, receipts: [1], records: [{ kind: 'take-in', text: [1, 1] }] },
      }), NO_DELIVERY_PAIR, 'wait')
      // A Post Hold with the same facts, and fixed work behind it, also waits.
      check(knowledge({
        holds: [{ item: 1, kind: 'post' }],
        p: { accepted: [1, 2], fixed: [1, 2], sent: [{ item: 1, part: 1, offset: 0 }] },
        r: { row, receipts: [1], records: [{ kind: 'take-in', text: [1, 1] }] },
      }), NO_DELIVERY_PAIR, 'wait')
    },
  )
})

describe('absent and empty holds preserve existing policy', () => {
  test.each([
    { name: 'empty queue', input: { p: { accepted: [] } }, target: NO_DELIVERY_PAIR, action: 'wait' },
    { name: 'FIFO by sequence, not input order', input: { p: { accepted: [3, 1, 2] } }, target: [1, 1], action: 'fixText' },
    { name: 'multipart next part', input: { MaxParts: 2, p: { fixed: [1], delivered: [[1, 1]] } }, target: [1, 2], action: 'recordSend' },
    { name: 'in-flight head after restart', input: { p: { fixed: [1], sent: [{ item: 1, part: 1, offset: 0 }] } }, target: [1, 1], action: 'recordRecoveryEnter' },
    { name: 'in-flight next item after the first delivered', input: { p: { fixed: [1, 2], delivered: [[1, 1]], sent: [{ item: 1, part: 1, offset: 0 }, { item: 2, part: 1, offset: 1 }] } }, target: [2, 1], action: 'recordRecoveryEnter' },
    { name: 'refused attempt', input: { p: { fixed: [1], sent: [{ item: 1, part: 1, offset: 0 }], refused: [1] } }, target: [1, 1], action: 'recordSend' },
    { name: 'all delivered', input: { p: { delivered: [[1, 1], [2, 1], [3, 1]] } }, target: NO_DELIVERY_PAIR, action: 'wait' },
  ] satisfies { name: string; input: KnowledgeInput; target: DeliveryPair; action: EngineAction }[])(
    '$name', ({ input, target, action }) => {
      check(knowledge(input), target, action)
      check(knowledge({ ...input, holds: [] }), target, action)
    },
  )
})
