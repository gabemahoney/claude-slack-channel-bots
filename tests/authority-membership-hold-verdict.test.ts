/** Ordinary synthetic checks of decision 5; no clocks, writers or opt-in switch. */
import { expect, test } from 'bun:test'
import { AUTHORITY_POPULATIONS } from './test-helpers/authority-cost.ts'
import { MEMBERSHIP_OPERATIONS, MEMBERSHIP_HOLD_METRICS, MEMBERSHIP_HOLD_SAMPLES,
  membershipHoldMedian, membershipHoldVerdict, type MembershipHoldSample, type MembershipOperation } from './test-helpers/authority-membership.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

const limits = { page: 15, inventory: 12 } as const satisfies Record<MembershipOperation, number>
function samples(): MembershipHoldSample[] {
  return MEMBERSHIP_OPERATIONS.flatMap(operation => AUTHORITY_POPULATIONS.flatMap(population =>
    Array.from({ length: MEMBERSHIP_HOLD_SAMPLES }, (_, sample) => ({ operation, population, sample,
      callMs: limits[operation], timerMs: 25, fsyncMs: 25 }))))
}
function verdict(input: MembershipHoldSample[]) {
  const before = structuredClone(input), result = membershipHoldVerdict(input)
  expect(input).toEqual(before)
  assertNoLeak({ samples: input, result })
  return result
}
const cells = MEMBERSHIP_OPERATIONS.flatMap(operation => AUTHORITY_POPULATIONS.map(population => ({ operation, population })))

test('membership hold metrics include every independently required ceiling metric', () => {
  expect(MEMBERSHIP_HOLD_METRICS).toEqual(['callMs', 'timerMs', 'fsyncMs'])
})

test('membership hold verdict ignores reported gcMs even at 100 ms', () => {
  const baseline = verdict(samples()), reported = samples().map(sample => ({ ...sample, gcMs: 100 }))
  const result = verdict(reported)
  expect(result.passed).toBe(true); expect(result).toEqual(baseline)
})

test('membership hold verdict passes exactly-at-limit metrics and all four even medians', () => {
  const input = samples()
  for (const { operation, population } of cells) {
    const values = operation === 'page' ? [25, 1, 24, 2, 20, 3, 16, 14] : [25, 1, 24, 2, 20, 3, 13, 11]
    input.filter(s => s.operation === operation && s.population === population).forEach((s, i) => { s.callMs = values[i]! })
  }
  const result = verdict(input)
  expect(input).toHaveLength(32)
  expect(result).toEqual({ passed: true, countFailures: [], ceilingFailures: [], medianFailures: [],
    cells: cells.map(({ operation, population }) => ({ operation, population, sampleCount: 8,
      medianCallMs: limits[operation], limitMs: limits[operation] })) })
})

for (const { operation, population } of cells) test.each([...MEMBERSHIP_HOLD_METRICS])(
  `membership hold verdict rejects one ${operation}/${population} sample at 25.01 on %s`, metric => {
    const input = samples(), target = input.find(s => s.operation === operation && s.population === population && s.sample === 3)!
    target[metric] = 25.01
    const result = verdict(input)
    expect(result.passed).toBe(false); expect(result.countFailures).toEqual([]); expect(result.medianFailures).toEqual([])
    expect(result.ceilingFailures).toEqual([{ operation, population, sample: 3, metric, valueMs: 25.01, limitMs: 25 }])
  })

test.each([...(['callMs', 'timerMs', 'fsyncMs'] as const)])('membership hold verdict rejects a NaN %s observation', metric => {
  const input = samples(), target = input[0]!
  target[metric] = Number.NaN
  const result = verdict(input)
  expect(result.passed).toBe(false); expect(result.countFailures).toEqual([])
  expect(result.ceilingFailures).toEqual([{ operation: target.operation, population: target.population,
    sample: target.sample, metric, valueMs: Number.NaN, limitMs: 25 }])
})

test.each(cells)('membership hold verdict rejects $operation/$population median 0.01 above its limit below the ceiling', ({ operation, population }) => {
  const input = samples(), median = limits[operation] + 0.01
  for (const s of input) if (s.operation === operation && s.population === population) s.callMs = median
  const result = verdict(input)
  expect(result.passed).toBe(false); expect(result.countFailures).toEqual([]); expect(result.ceilingFailures).toEqual([])
  expect(result.medianFailures).toEqual([{ operation, population, sampleCount: 8, medianCallMs: median, limitMs: limits[operation] }])
})

test.each(cells)('membership hold verdict keeps an under-ceiling $operation/$population outlier with a passing median', ({ operation, population }) => {
  const input = samples()
  input.find(s => s.operation === operation && s.population === population)!.callMs = 24.99
  const result = verdict(input)
  expect(result.passed).toBe(true); expect(result.ceilingFailures).toEqual([]); expect(result.medianFailures).toEqual([])
  expect(result.cells.find(cell => cell.operation === operation && cell.population === population)!.medianCallMs).toBe(limits[operation])
})

test('membership hold verdict rejects 31 samples and reports the incomplete cell', () => {
  const input = samples(), removed = input.pop()!, result = verdict(input)
  expect(result.passed).toBe(false)
  expect(result.countFailures).toEqual([{ expected: 32, actual: 31 },
    { operation: removed.operation, population: removed.population, expected: 8, actual: 7 }])
  expect(result.ceilingFailures).toEqual([]); expect(result.medianFailures).toEqual([])
})

test('membership hold verdict rejects empty input with every count and null-median failure', () => {
  const result = verdict([])
  const emptyCells = cells.map(({ operation, population }) => ({ operation, population, sampleCount: 0,
    medianCallMs: null, limitMs: limits[operation] }))
  expect(result).toEqual({ passed: false, cells: emptyCells, ceilingFailures: [],
    countFailures: [{ expected: 32, actual: 0 }, ...cells.map(({ operation, population }) => ({
      operation, population, expected: 8, actual: 0,
    }))], medianFailures: emptyCells })
})

test('membership hold verdict still requires eight samples per cell when the total is 32', () => {
  const input = samples()
  input.find(s => s.operation === 'page' && s.population === AUTHORITY_POPULATIONS[0])!.population = AUTHORITY_POPULATIONS[1]
  const result = verdict(input)
  expect(input).toHaveLength(32); expect(result.passed).toBe(false)
  expect(result.countFailures).toEqual([
    { operation: 'page', population: AUTHORITY_POPULATIONS[0], expected: 8, actual: 7 },
    { operation: 'page', population: AUTHORITY_POPULATIONS[1], expected: 8, actual: 9 },
  ])
  expect(result.ceilingFailures).toEqual([]); expect(result.medianFailures).toEqual([])
})

test('membership hold verdict reports ceiling and median failures together even with a bad count', () => {
  const input = samples(); input.pop()
  const target = input.find(s => s.operation === 'page' && s.population === AUTHORITY_POPULATIONS[0])!
  target.callMs = 25.01; target.timerMs = 25.01; target.fsyncMs = 25.01
  for (const s of input) if (s.operation === 'inventory' && s.population === AUTHORITY_POPULATIONS[0]) s.callMs = 12.01
  const result = verdict(input)
  expect(result.passed).toBe(false); expect(result.countFailures).toHaveLength(2)
  expect(result.ceilingFailures).toEqual(MEMBERSHIP_HOLD_METRICS.map(metric => ({ operation: target.operation,
    population: target.population, sample: target.sample, metric, valueMs: 25.01, limitMs: 25 })))
  expect(result.medianFailures).toEqual([{ operation: 'inventory', population: AUTHORITY_POPULATIONS[0],
    sampleCount: 8, medianCallMs: 12.01, limitMs: 12 }])
})

test.each([
  { values: [9, 1, 5], expected: 5 },
  { values: [8, 1, 3, 5], expected: 4 },
  { values: [21, 4, 1, 10, 3, 8, 2, 7], expected: 5.5 },
  { values: [7], expected: 7 },
  { values: [] as number[], expected: null },
])('membership hold median computes $expected without reordering caller values', ({ values, expected }) => {
  const before = [...values]
  expect(membershipHoldMedian(values)).toBe(expected); expect(values).toEqual(before)
})
