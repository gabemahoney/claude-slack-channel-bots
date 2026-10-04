/**
 * runbooks.ts — the titles and block headings of the README's two runbooks,
 * and the form of their step headings (b.jg5 SRJ-1108, SRJ-1109; the E2-gate
 * and E5 hatch notes). Tests take every one of them from here.
 *
 * Ruling (values in tests): the rollback section's title and the switch-over
 * runbook's refusal-block heading are defined here, not in `src/`, because no
 * refusal, note or other `src/` code reads them. Two are defined in
 * `src/ad-version-gate.ts`, because `src/` and `scripts/` texts name them:
 *   - the switch-over section's own title, `PHASE1_RUNBOOK_SECTION_TITLE`,
 *     which every refusal and note reads; it is not repeated here;
 *   - the publishing-host block heading, `PUBLISHING_HOST_BLOCK_HEADING`,
 *     which the install check's and the startup gate's not-found messages and
 *     SR-2.5's not-found and below-client-minimum diagnostics name (b.jg5
 *     SRJ-211, SRJ-212; E36 T2 ruling). It is re-exported here under the same
 *     name, so a test takes it from one place and no `tests/` file defines it.
 *
 * Runbook Markdown contract: each runbook is a `###` section under
 * `## Migration`, its blocks and steps are headings one level below it, and
 * each step heading's title starts `Step <n>: `. `stepHeadingPrefix` builds
 * that start and `stepNumberOf` reads it back, so no reader re-types the form.
 * A heading title is the text after the `#` marks (`headings()`' `title` in
 * `tests/test-helpers/markdown.ts`).
 *
 * Pure: reads nothing, writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

/** The switch-over runbook's block on the host that publishes the release (E5 hatch note; SRJ-1108), defined in `src/`. */
export { PUBLISHING_HOST_BLOCK_HEADING } from '../../src/ad-version-gate.ts'

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
