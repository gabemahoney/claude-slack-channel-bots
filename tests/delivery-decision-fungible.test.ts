/**
 * delivery-decision-fungible.test.ts — The decision table of b.deo SRI-1301:
 * `decideDelivery` in both channel modes, called directly with the rows of
 * `tests/test-helpers/fungible-decision.ts`, one `test.each` per SRI-1301
 * group, plus the completeness case and the purity cases.
 *
 * Test lines carried: b.deo SRI-202's decision rows (with b.av2 SR-1.2),
 * SRI-303 (with b.av2 SR-4.2 and SR-4.3), SRI-305, SRI-306 (with b.av2
 * SR-4.2 and SR-4.4), SRI-308 (with b.av2 SR-4.2 to SR-4.4) and SRI-309
 * (with b.av2 SR-13.1). SRI-605's share: the decision takes no Slack client
 * and this suite uses no stub, so the purity audit shows it adds no Slack
 * call.
 *
 * Every row's outcome is compared whole with strict equality, so a key the
 * row does not expect (a `fungible` field set to undefined included) fails
 * it. Declarative mode's own rules are tested in
 * `tests/delivery-decision.test.ts`; this suite shows only that the fungible
 * inputs change none of them. The routing's lines, dispatch and call logs are
 * tested in `tests/persona-routing.test.ts`.
 *
 * Pure: no server, no `mock.module`, no timer; the only file read is the
 * decision's source, for the purity audit.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { channelDeliveryFor, decideDelivery, FUNGIBLE_REFUSALS, type DeliveryDecision, type FungiblePath } from '../src/delivery-decision.ts'
import {
  CHANNEL_TYPE_FORMS,
  FLAG_FORMS,
  FUNGIBLE_DECISION_GROUPS,
  SWITCH_FORMS,
  channelDeliveryArgsOf,
  channelTypeFormOf,
  decisionArgsOf,
  flagFormOf,
  switchFormOf,
  type ChannelDeliveryRow,
  type FungibleDecisionGroup,
  type FungibleDecisionRow,
} from './test-helpers/fungible-decision.ts'
import { importedSpecifiers, maskLiterals, runtimeSpecifiers, stripComments } from './test-helpers/source-audit.ts'

/** The module under audit. */
const DECISION_SOURCE = join(import.meta.dir, '..', 'src', 'delivery-decision.ts')

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** The `fungible` report of an outcome, when it has one. */
function pathOf(outcome: DeliveryDecision): FungiblePath | undefined {
  return 'fungible' in outcome ? outcome.fungible : undefined
}

/** A row's expected outcome in words, from the row's own data. */
function outcomeText(outcome: DeliveryDecision): string {
  const path = pathOf(outcome)
  const onPath = path === undefined ? '' : ` [fungible path: ${path.channelType}, at ${path.channelDelivery}]`
  if (outcome.action === 'deliver') return `delivered via ${outcome.via}${onPath}`
  if ('refusal' in outcome) return `not delivered: ${outcome.reason} (${outcome.refusal})`
  if ('unclaimed' in outcome) return `not delivered: ${outcome.reason} (${outcome.unclaimed ? 'unclaimed' : 'claimed'})`
  return `not delivered: ${outcome.reason}${onPath}`
}

/** `test.each` cases for a group's rows: the title (scenario and outcome) and the row. */
function cases<R extends FungibleDecisionRow>(group: FungibleDecisionGroup<R>): [string, R][] {
  return group.rows.map((row) => [`${row.label} → ${outcomeText(row.expected)}`, row])
}

/** The one assertion of every row: the whole outcome, by strict equality. */
function expectOutcome(row: FungibleDecisionRow): void {
  expect(decideDelivery(...decisionArgsOf(row))).toStrictEqual(row.expected)
}

/**
 * The row's outcome, and `channelDeliveryFor` for P and the row's channel:
 * its result is the row's, and its delivery is the outcome's channel delivery.
 */
function expectOutcomeAndChannelDelivery(row: ChannelDeliveryRow): void {
  expectOutcome(row)
  const result = channelDeliveryFor(...channelDeliveryArgsOf(row))
  expect<unknown[]>([result, result.delivery]).toStrictEqual([row.channelDelivery, pathOf(row.expected)?.channelDelivery])
}

/** Every row of every group. */
function allRows(): FungibleDecisionRow[] {
  return Object.values(FUNGIBLE_DECISION_GROUPS).flatMap((group): FungibleDecisionRow[] => [...group.rows])
}

const G = FUNGIBLE_DECISION_GROUPS

// ---------------------------------------------------------------------------
// The decision table (b.deo SRI-1301)
// ---------------------------------------------------------------------------

describe('b.deo SRI-1301 group 1: declarative mode (switch absent or false) is unchanged by every fungible input (b.deo SRI-308, SRI-202, SRI-309; b.av2 SR-4.2 to SR-4.4)', () => {
  test.each(cases(G.declarative))('%s', (_title, row) => expectOutcome(row))
})

describe('b.deo SRI-1301 group 2: fungible mode, no stored choice, flag false (b.deo SRI-306; b.av2 SR-4.2, SR-4.4)', () => {
  test.each(cases(G.noStoredChoice))('%s', (_title, row) => expectOutcome(row))
})

describe('b.deo SRI-1301 group 3: fungible mode, P\'s stored all (b.deo SRI-306, SRI-305; b.av2 SR-4.4)', () => {
  test.each(cases(G.storedAll))('%s', (_title, row) => expectOutcome(row))
})

describe('b.deo SRI-1301 group 4: fungible mode ignores every declarative section, listed, malformed or absent (b.deo SRI-305, SRI-202; b.av2 SR-1.2)', () => {
  test.each(cases(G.ignoresChannels))('%s; channelDeliveryFor agrees', (_title, row) => expectOutcomeAndChannelDelivery(row))
})

describe('b.deo SRI-1301 group 5: the fungible path\'s five conditions, first failure decides, and the same events listed in declarative mode (b.deo SRI-303, SRI-308; b.av2 SR-4.2)', () => {
  test.each(cases(G.conditions))('%s', (_title, row) => expectOutcome(row))
})

describe('b.deo SRI-1301 group 6: group DMs in fungible mode (b.deo SRI-303; b.av2 SR-4.3)', () => {
  test.each(cases(G.groupDms))('%s', (_title, row) => expectOutcome(row))
})

describe('b.deo SRI-1301 group 7: the loop guard under P\'s stored all (b.deo SRI-305)', () => {
  test.each(cases(G.loopGuard))('%s; channelDeliveryFor agrees', (_title, row) => expectOutcomeAndChannelDelivery(row))
})

describe('b.deo SRI-1301 group 8: in fungible mode non-message, no-author and own run before the fungible conditions (b.deo SRI-303; b.av2 SR-4.2)', () => {
  test.each(cases(G.firstSteps))('%s', (_title, row) => expectOutcome(row))
})

describe('b.deo SRI-1301 group 9: an unreadable store applies no stored choice (b.deo SRI-305)', () => {
  test.each(cases(G.unreadableStore))('%s; channelDeliveryFor agrees', (_title, row) => expectOutcomeAndChannelDelivery(row))
})

describe('b.deo SRI-1301 group 10: a DM in fungible mode is decided by dm.enabled (b.deo SRI-303; b.av2 SR-4.3)', () => {
  test.each(cases(G.dmInFungibleMode))('%s', (_title, row) => expectOutcome(row))
})

// ---------------------------------------------------------------------------
// Completeness (b.deo SRI-1301)
// ---------------------------------------------------------------------------

/** A row's switch × channel_type × flag combination, classified from its inputs; undefined for a channel_type outside the five. */
function combinationOf(row: FungibleDecisionRow): string | undefined {
  const channelType = channelTypeFormOf(row.event)
  if (channelType === undefined) return undefined
  if (row.omitFungibleInputs) return `switch absent × ${channelType} × flag absent`
  return `switch ${switchFormOf(row.config)} × ${channelType} × flag ${flagFormOf(row.flag)}`
}

describe('b.deo SRI-1301 completeness', () => {
  test('every switch form × channel_type × flag form (60 combinations) appears in at least one row', () => {
    const seen = new Set(allRows().map(combinationOf))
    const all = SWITCH_FORMS.flatMap((s) => CHANNEL_TYPE_FORMS.flatMap((c) => FLAG_FORMS.map((f) => `switch ${s} × ${c} × flag ${f}`)))
    expect(all.length).toBe(60)
    expect(all.filter((combination) => !seen.has(combination))).toEqual([])
  })

  test('every refusal of FUNGIBLE_REFUSALS is the expected outcome of at least one row (b.deo SRI-303)', () => {
    const expected = new Set(allRows().map((row) => ('refusal' in row.expected ? row.expected.refusal : undefined)))
    expect(FUNGIBLE_REFUSALS.filter((refusal) => !expected.has(refusal))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Purity (b.deo SRI-309, b.av2 SR-13.1; b.deo SRI-605's share)
// ---------------------------------------------------------------------------

/** Names whose use means I/O, logging, time, randomness, the environment or global state. */
const AMBIENT_REFERENCE =
  /(?<![\w$.])(?:console|process|Bun|Deno|globalThis|window|self|global|Date|Math\s*\.\s*random|crypto|performance|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate|queueMicrotask|fetch|XMLHttpRequest|WebSocket|require|eval|Function|import\s*\.\s*meta)\b/g

/** Methods that change a Set, Map, array or regex in place. */
const MUTATORS = 'add|delete|clear|set|push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|lastIndex'

/** Compound and plain assignment operators. */
const ASSIGNMENT = '(?:[-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?![=>])'

/** A property or element access chain after a name. */
const ACCESS_CHAIN = '(?:\\.\\s*[\\w$]+\\s*|\\[[^\\]]*\\]\\s*)*'

/** The bracket depth at each offset of `masked` (literals already blanked). */
function depthsOf(masked: string): number[] {
  const depths: number[] = []
  let depth = 0
  for (const ch of masked) {
    if (ch === '}' || ch === ')' || ch === ']') depth--
    depths.push(depth)
    if (ch === '{' || ch === '(' || ch === '[') depth++
  }
  return depths
}

/** Import findings: anything loaded at run time, any import that is not a relative module, any dynamic import or `require`. */
function importFindings(code: string): string[] {
  const masked = maskLiterals(code)
  return [
    ...runtimeSpecifiers(code).map((spec) => `loads ${spec} at run time`),
    ...importedSpecifiers(code).filter((spec) => !spec.startsWith('./')).map((spec) => `imports ${spec}`),
    ...(/\bimport\s*\(/.test(masked) ? ['has a dynamic import'] : []),
  ]
}

/** Ambient findings: every reference to I/O, logging, time, randomness, the environment or global state. */
function ambientFindings(code: string): string[] {
  return [...maskLiterals(code).matchAll(AMBIENT_REFERENCE)].map((m) => `refers to ${m[0].replace(/\s+/g, '')}`)
}

/** State findings: a module-scope `let` or `var`, a write to a module-scope value, or a module-scope regex with state (`g`, `y`). */
function stateFindings(code: string): string[] {
  const masked = maskLiterals(code)
  const depths = depthsOf(masked)
  const findings = [...masked.matchAll(/\b(?:let|var)\s+([\w$]+)/g)]
    .filter((m) => depths[m.index] === 0)
    .map((m) => `module-scope ${m[0].replace(/\s+/g, ' ')}`)
  for (const m of masked.matchAll(/\bconst\s+([\w$]+)/g)) {
    if (depths[m.index] !== 0) continue
    const name = m[1]!
    const writes = new RegExp(
      [
        `(?<![\\w$.])(?<!const\\s+)${name}\\s*${ACCESS_CHAIN}${ASSIGNMENT}`,
        `(?:\\+\\+|--)\\s*${name}\\b`,
        `(?<![\\w$.])${name}\\s*${ACCESS_CHAIN}(?:\\+\\+|--)`,
        `(?<![\\w$.])${name}\\s*\\.\\s*(?:${MUTATORS})\\b`,
        `\\bObject\\s*\\.\\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\\s*\\(\\s*${name}\\b`,
      ].join('|'),
    )
    if (writes.test(masked)) findings.push(`writes module-scope ${name}`)
    const regexFlags = /^[^=]*=\s*\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/([a-z]*)/.exec(code.slice(m.index))?.[1]
    if (regexFlags !== undefined && /[gy]/.test(regexFlags)) findings.push(`module-scope regex ${name} keeps state (flags ${regexFlags})`)
  }
  return findings
}

/** A deep copy of `value` with every object and array frozen. Accessors are copied, never read; functions and regexes are kept as they are. */
function frozenCopy<T>(value: T): T {
  if (typeof value !== 'object' || value === null || value instanceof RegExp) return value
  const copy: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    Object.defineProperty(copy, key, 'value' in descriptor ? { ...descriptor, value: frozenCopy(descriptor.value) } : descriptor)
  }
  return Object.freeze(copy) as T
}

/** The rows forwards, then in reverse. */
function forwardsThenReversed<R>(rows: readonly R[]): R[] {
  return [...rows, ...[...rows].reverse()]
}

/** The decision's comment-stripped source, read when a case runs. */
function decisionCode(): string {
  return stripComments(readFileSync(DECISION_SOURCE, 'utf-8'))
}

describe('b.deo SRI-309: the decision stays pure (b.av2 SR-13.1)', () => {
  test('src/delivery-decision.ts imports types only: no value, node: or package import, no dynamic import', () => {
    expect(importFindings(decisionCode())).toEqual([])
  })

  test('src/delivery-decision.ts refers to no console, process, environment, file system, network, Bun, timer, Date, random number or globalThis', () => {
    expect(ambientFindings(decisionCode())).toEqual([])
  })

  test('src/delivery-decision.ts keeps no module-scope let or var, writes no module-scope value and holds no stateful regex', () => {
    expect(stateFindings(decisionCode())).toEqual([])
  })

  test('decideDelivery gives every row its outcome with deep-frozen arguments, forwards then in reverse', () => {
    const mismatches = forwardsThenReversed(allRows()).filter(
      (row) => !Bun.deepEquals(decideDelivery(...frozenCopy(decisionArgsOf(row))), row.expected, true),
    )
    expect(mismatches.map((row) => row.label)).toEqual([])
  })

  test('channelDeliveryFor gives every channel-delivery row its result with deep-frozen arguments, forwards then in reverse', () => {
    const rows: ChannelDeliveryRow[] = [...G.ignoresChannels.rows, ...G.loopGuard.rows, ...G.unreadableStore.rows]
    const mismatches = forwardsThenReversed(rows).filter(
      (row) => !Bun.deepEquals(channelDeliveryFor(...frozenCopy(channelDeliveryArgsOf(row))), row.channelDelivery, true),
    )
    expect(mismatches.map((row) => row.label)).toEqual([])
  })
})
