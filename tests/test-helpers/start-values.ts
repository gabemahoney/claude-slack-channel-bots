/**
 * test-helpers/start-values.ts — a persona's Start Values (`model` and
 * `effort`) as the Resume Decision suites write and read them: the Start
 * Labels a spawn writes from them, the Start Labels among a spawn's labels,
 * the Fresh-Start Lines among captured lines, and a change to them confirmed
 * while a recovery-harness stub call is out.
 *
 * Expected labels come from the `src/persona-identity.ts` derivations and
 * lines from the Fresh-Start Line's builder, never typed.
 *
 * SPDX-License-Identifier: MIT
 */

import type { EffortLevel } from '../../src/config.ts'
import { freshStartLine } from '../../src/live-row-sequence.ts'
import {
  EFFORT_LABEL_KEY,
  EFFORT_LABEL_PREFIX,
  effortLabelValue,
  MODEL_LABEL_KEY,
  MODEL_LABEL_PREFIX,
  modelLabelValue,
  type StartLabelKey,
} from '../../src/persona-identity.ts'
import { lineParts } from './line-parts.ts'
import type { RecoveryHarness, RecoveryStubVerb } from './recovery-harness.ts'

/** A persona's `model` and `effort`, or the values a row's Start Labels were written from. */
export interface StartValues {
  readonly model?: string
  readonly effort?: EffortLevel
}

/** The Start Labels a spawn with `values` writes, as a row's label map. */
export function startLabelsOf(values: StartValues): Record<string, string> {
  return {
    ...(values.model === undefined ? {} : { [MODEL_LABEL_KEY]: modelLabelValue(values.model) }),
    ...(values.effort === undefined ? {} : { [EFFORT_LABEL_KEY]: effortLabelValue(values.effort) }),
  }
}

/** The Start Labels among a spawn's labels, in order. */
export function startLabelsIn(labels: readonly string[] | undefined): string[] {
  return (labels ?? []).filter((label) => label.startsWith(MODEL_LABEL_PREFIX) || label.startsWith(EFFORT_LABEL_PREFIX))
}

/**
 * Every Fresh-Start Line for `ref` among `lines`, whatever keys it names:
 * the builder's own head, and the tail its one-key and two-key forms share.
 */
export function freshStartLinesIn(lines: readonly string[], ref: string): string[] {
  const [head, one] = lineParts((hole) => freshStartLine(ref, [hole as StartLabelKey])) as [string, string]
  const two = lineParts((hole) => freshStartLine(ref, [hole as StartLabelKey, hole as StartLabelKey])).at(-1)!
  let shared = 0
  while (shared < Math.min(one.length, two.length) && one[one.length - 1 - shared] === two[two.length - 1 - shared]) shared++
  const tail = one.slice(one.length - shared)
  return lines.filter((line) => line.startsWith(head) && line.endsWith(tail))
}

/** A change to persona `key`'s `model` and `effort` confirmed now: its applied entry swapped for a copy with `values`. */
export function confirmValues(h: RecoveryHarness, key: string, values: StartValues): void {
  const at = h.config.personas.findIndex((persona) => persona.key === key)
  const { model: _model, effort: _effort, ...rest } = h.config.personas[at]!
  h.config.personas[at] = { ...rest, ...values }
}

/** Run `act` once, as the stub's `verb` is first called, before the call goes on. */
export function onFirstCall(h: RecoveryHarness, verb: RecoveryStubVerb, act: () => void): void {
  const client = h.stub.client as unknown as Record<RecoveryStubVerb, (...args: unknown[]) => unknown>
  const call = client[verb].bind(client)
  let done = false
  client[verb] = (...args: unknown[]) => {
    if (!done) {
      done = true
      act()
    }
    return call(...args)
  }
}
