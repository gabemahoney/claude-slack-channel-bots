/**
 * runbooks.ts — the titles and block headings of the README's two runbooks,
 * the form of their step headings, and the one reader of a runbook's steps
 * (b.jg5 SRJ-1108, SRJ-1109; the E2-gate and E5 hatch notes; ruling Q13).
 * Tests take every one of them from here.
 *
 * Ruling (values in tests): the rollback section's title and the switch-over
 * runbook's refusal-block heading are defined here, not in `src/`, because no
 * refusal, note or other `src/` code reads them. Two are defined in
 * `src/ad-version-gate.ts`, because `src/` and `scripts/` texts name them, and
 * tests import them from there:
 *   - the switch-over section's own title, `PHASE1_RUNBOOK_SECTION_TITLE`,
 *     which every refusal and note reads;
 *   - the publishing-host block heading, `PUBLISHING_HOST_BLOCK_HEADING`,
 *     which the install check's and the startup gate's not-found messages and
 *     SR-2.5's not-found and below-client-minimum diagnostics name (b.jg5
 *     SRJ-211, SRJ-212; E36 T2 ruling).
 *
 * Load path: this file imports only `tests/test-helpers/markdown.ts`, which
 * imports nothing, so it loads where `tests/` is copied without `src/` or the
 * repo's `node_modules` (the `/ci` image's `/tests`). Nothing from `src/` or
 * `agent-director` is imported here.
 *
 * Runbook Markdown contract: each runbook is a `###` section under
 * `## Migration`, its blocks and steps are headings one level below it, and
 * each step heading's title starts `Step <n>: `. `stepHeadingPrefix` builds
 * that start and `stepNumberOf` reads it back, so no reader re-types the form.
 * A heading title is the text after the `#` marks (`headings()`' `title` in
 * `tests/test-helpers/markdown.ts`). `runbookSteps` reads a section's steps
 * through both.
 *
 * Pure: reads nothing, writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

import { headings } from './markdown.ts'

/** The rollback runbook's section title (b.jg5 SRJ-1109). */
export const ROLLBACK_RUNBOOK_SECTION_TITLE = 'Rolling back the switch-over'

/** The switch-over runbook's first block: the entry from a startup refusal (E2-gate hatch note; SRJ-1108). */
export const REFUSAL_BLOCK_HEADING = 'Arrived here from a startup refusal?'

/** The start of step `n`'s heading title: `Step <n>: `. */
export function stepHeadingPrefix(n: number): string {
  return `Step ${n}: `
}

/** The step number a heading title starts with (`Step 3: Stop …` gives 3), or `undefined` for a title that is not a step's. */
export function stepNumberOf(title: string): number | undefined {
  const m = /^Step (\d+): \S/.exec(title)
  if (m === null) return undefined
  const n = Number(m[1])
  return title.startsWith(stepHeadingPrefix(n)) ? n : undefined
}

/** One runbook step as `runbookSteps` reads it. */
export interface RunbookStep {
  /** The step's number: `n` in its `Step <n>: ` heading title. */
  number: number
  /** The step heading's title as written, `#` marks excluded (`Step 3: Stop …`). */
  title: string
  /** The step heading's 0-based line index in the section text given to `runbookSteps`. */
  line: number
  /** The step's lines as written, heading line excluded, up to the next heading of its level or higher (or the section's end), joined by newlines. */
  text: string
}

/** What `runbookSteps` checks the section against. */
export interface RunbookStepsOptions {
  /** The step count the section must hold (steps 1 to `count`). When omitted, the section's highest step number is taken as the count. */
  count?: number
  /** The step headings' level. When omitted, the shallowest heading level in the section: its blocks' and steps' level by the contract above. */
  level?: number
  /** Where the section came from (`README.md "### …"`), put before every failure as `<name>: `. */
  name?: string
}

/**
 * The step reader: the steps of a runbook section's body (its heading line
 * excluded, as `findSection` and `requiredSection` return it), in order.
 * Steps are the headings at the step level whose title starts with
 * `stepHeadingPrefix(n)`, found by `stepNumberOf`; a step is found by its
 * number, never its title, because the SRD's contract is "steps 1 to n in
 * order". Headings outside fenced code only (`headings`).
 *
 * Throws, naming the step, when a step is missing, appears more than once or
 * is out of order, or when the count differs from `count` (a missing step for
 * too few; a step beyond the count for too many). A section with no step at
 * all fails as step 1 missing. Pure.
 */
export function runbookSteps(section: string, options: RunbookStepsOptions = {}): RunbookStep[] {
  const fail = (problem: string): never => {
    throw new Error(options.name === undefined ? problem : `${options.name}: ${problem}`)
  }
  const lines = section.split('\n')
  const hs = headings(section)
  const level = options.level ?? (hs.length === 0 ? undefined : Math.min(...hs.map((h) => h.level)))
  const found = hs.flatMap((h, i) => {
    const n = h.level === level ? stepNumberOf(h.title) : undefined
    return n === undefined ? [] : [{ n, i }]
  })
  const count = options.count ?? Math.max(1, ...found.map((s) => s.n))
  const marks = level === undefined ? '' : `${'#'.repeat(level)} `
  for (let n = 1; n <= count; n++) {
    const times = found.filter((s) => s.n === n).length
    if (times === 0) fail(`step ${n} is missing (no "${marks}${stepHeadingPrefix(n)}…" heading)`)
    if (times > 1) fail(`step ${n} appears ${times} times`)
  }
  const outside = found.find((s) => s.n < 1 || s.n > count)
  if (outside !== undefined) {
    fail(outside.n < 1 ? `step ${outside.n} is not a step number (steps start at 1)` : `step ${outside.n} is beyond the expected ${count} steps`)
  }
  found.forEach((s, k) => {
    if (s.n !== k + 1) fail(`step ${s.n} is out of order (found where step ${k + 1} belongs)`)
  })
  return found.map(({ n, i }) => {
    const h = hs[i]
    const next = hs.slice(i + 1).find((later) => later.level <= h.level)
    return { number: n, title: h.title, line: h.line, text: lines.slice(h.line + 1, next === undefined ? lines.length : next.line).join('\n') }
  })
}
