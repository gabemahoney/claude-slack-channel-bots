/**
 * install-check-script.test.ts — `scripts/install-check.ts`'s rendering
 * (SR-6, b.jg5 SRJ-212, AC 81).
 *
 * The script's exported `renderSuccess` and `renderFailure` run over the
 * canned results of `tests/test-helpers/install-check-fixtures.ts`, which
 * have the shapes and texts `runInstallCheck` returns. `main()` is never
 * called: it runs the real install check and `process.exit`s. Its one
 * branch — append the install-skill block to every failure except
 * ad-version-floor-unreadable — is mirrored by {@link scriptFailureBody}.
 * No child process.
 *
 * Cases:
 *   - Success with the Phase 1 note (a version below CSCB's floor): the OK
 *     block as without a note, then the note (the builder's text, naming the
 *     runbook section) once, after it, on the one line that begins, after its
 *     indent, with `INSTALL_CHECK_NOTE_LABEL` followed by the note's text.
 *   - Success without a note (a version that meets the floor): the OK block
 *     alone, with no note text and no line beginning with the label.
 *   - Idempotency: identical output across two calls.
 *   - not-found / too-old / unreachable (each reason): the class label, the
 *     message, and the install-skill block at the end. Too-old names the
 *     runbook section title and the client's minimum.
 *   - ad-version-floor-unreadable: the class label and message, no skill block.
 *   - No rendered line of any case carries an upgrade form (`UPGRADE_FORMS`)
 *     or "Upgrade agent-director" in any case.
 *
 * Every version, label, title and note text is imported from `src/`,
 * `scripts/install-check.ts` (the note label) or `tests/test-helpers/`.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import type { UnreachableReason } from 'agent-director'

import { INSTALL_CHECK_NOTE_LABEL, renderFailure, renderSuccess } from '../scripts/install-check.ts'
import {
  buildInstallCheckPhase1Note,
  buildSystemInstallTooOldMessage,
  INSTALL_CHECK_PHASE1_NOTE_PHRASE,
  PHASE1_FLOOR_VERSION,
  PHASE1_RUNBOOK_SECTION_TITLE,
} from '../src/ad-version-gate.ts'
import {
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
  AD_VERSION_FLOOR_UNREADABLE,
} from '../src/install-check-labels.ts'
import { renderInstallSkillInstructions } from '../src/install-skill-pointer.ts'
import {
  CLIENT_MIN_VERSION,
  DEV_PLACEHOLDER_VERSION,
  OLD_AD_VERSION,
  PHASE1_RC_VERSION,
} from './test-helpers/agent-director-versions.ts'
import {
  CANNED_BINARY_PATH,
  cannedFailureResult,
  cannedSuccessResult,
  SATISFYING_VERSION,
  STALE_VERSION,
  UNREACHABLE_REASONS,
  type InstallCheckFailure,
  type InstallCheckSuccess,
} from './test-helpers/install-check-fixtures.ts'
import { flat } from './test-helpers/markdown.ts'
import { UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'

/** The install-skill block the script appends to a failure. */
const SKILL_BLOCK = renderInstallSkillInstructions()

/** What `main()` writes to stderr for a failure (its append rule, SR-6.3). */
function scriptFailureBody(result: InstallCheckFailure): string {
  const body = renderFailure(result)
  return result.classLabel === AD_VERSION_FLOOR_UNREADABLE ? body : body + SKILL_BLOCK
}

/** The lines of `out` that begin, after their indent, with the note label. */
function linesBeginningWithLabel(out: string): string[] {
  return out.split('\n').filter((line) => line.trimStart().startsWith(INSTALL_CHECK_NOTE_LABEL))
}

/** Number of non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** An unreachable failure of the given reason, message built from the detail. */
function unreachableResult(reason: UnreachableReason): InstallCheckFailure {
  return cannedFailureResult(AD_SYSTEM_INSTALL_UNREACHABLE, {
    detail: { reason, binaryPath: CANNED_BINARY_PATH, diagnostic: null, exitCode: null, signal: null },
  })
}

/** Versions the install check passes below CSCB's floor (with the note). */
const BELOW_FLOOR_PASSING: ReadonlyArray<[string, string]> = [
  ['OLD_AD_VERSION', OLD_AD_VERSION],
  ['DEV_PLACEHOLDER_VERSION', DEV_PLACEHOLDER_VERSION],
  ['SATISFYING_VERSION', SATISFYING_VERSION],
]

/** Versions that meet CSCB's floor (no note). */
const MEETS_FLOOR: ReadonlyArray<[string, string]> = [
  ['PHASE1_RC_VERSION', PHASE1_RC_VERSION],
  ['PHASE1_FLOOR_VERSION', PHASE1_FLOOR_VERSION],
]

describe('SR-6 / SRJ-212: install-check script — success with the Phase 1 note', () => {
  test.each(BELOW_FLOOR_PASSING)('%s: the note follows the OK block, once', (_name, version) => {
    const result = cannedSuccessResult({ binaryVersion: version })
    const note = buildInstallCheckPhase1Note(version)
    expect(result.note).toBe(note)

    const bare = renderSuccess(cannedSuccessResult({ binaryVersion: version, phase1Note: false }))
    const out = renderSuccess(result)

    // The OK block is unchanged, and the note is one line after it.
    expect(out.startsWith(bare + '\n')).toBe(true)
    const tail = out.slice(bare.length + 1)
    expect(tail.split('\n')).toHaveLength(1)
    expect(tail).toContain(note)
    expect(count(out, note)).toBe(1)
    expect(count(bare, INSTALL_CHECK_PHASE1_NOTE_PHRASE)).toBe(0)

    // The note names the found version, the floor phrase and the runbook section.
    expect(tail).toContain(version)
    expect(tail).toContain(INSTALL_CHECK_PHASE1_NOTE_PHRASE)
    expect(tail).toContain(PHASE1_RUNBOOK_SECTION_TITLE)

    // The note line begins, after its indent, with the exported label, then
    // the note's text (SRJ-212, SRJ-1110); no line of the OK block does.
    const noteLine = tail.trimStart()
    expect(noteLine.startsWith(INSTALL_CHECK_NOTE_LABEL)).toBe(true)
    const afterLabel = noteLine.slice(INSTALL_CHECK_NOTE_LABEL.length)
    expect(afterLabel).toMatch(/^\s+\S/)
    expect(afterLabel.trim()).toBe(note)
    expect(linesBeginningWithLabel(out)).toEqual([tail])
  })
})

describe('SR-6: install-check script — success without a note', () => {
  test.each(MEETS_FLOOR)('%s: the OK block alone, no note text', (_name, version) => {
    const result = cannedSuccessResult({ binaryVersion: version })
    expect(result.note).toBeUndefined()
    const out = renderSuccess(result)
    const lines = out.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[1]).toContain(CANNED_BINARY_PATH)
    expect(lines[2]).toContain(version)
    expect(lines[3]).toContain(CLIENT_MIN_VERSION)
    expect(out).not.toContain(INSTALL_CHECK_PHASE1_NOTE_PHRASE)
    expect(out).not.toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    expect(out).not.toContain(buildInstallCheckPhase1Note(version))
    expect(linesBeginningWithLabel(out)).toEqual([])
  })

  test('re-run idempotency: identical output across two calls, with and without a note', () => {
    for (const result of [cannedSuccessResult(), cannedSuccessResult({ binaryVersion: OLD_AD_VERSION })]) {
      expect(renderSuccess(result)).toBe(renderSuccess(result))
    }
  })
})

describe('SR-6: install-check script — failures that end with the install-skill block', () => {
  test(`${AD_SYSTEM_INSTALL_NOT_FOUND}: class label, message, then the skill block`, () => {
    const result = cannedFailureResult(AD_SYSTEM_INSTALL_NOT_FOUND)
    const body = scriptFailureBody(result)
    expect(body).toContain(AD_SYSTEM_INSTALL_NOT_FOUND)
    expect(body).toContain(result.message)
    expect(body.endsWith(SKILL_BLOCK)).toBe(true)
  })

  test(`${AD_SYSTEM_INSTALL_TOO_OLD}: the builder's message naming the runbook, then the skill block`, () => {
    const result = cannedFailureResult(AD_SYSTEM_INSTALL_TOO_OLD)
    const message = buildSystemInstallTooOldMessage({
      foundVersion: STALE_VERSION,
      requiredVersion: CLIENT_MIN_VERSION,
      binaryPath: CANNED_BINARY_PATH,
    })
    expect(result.message).toBe(message)

    const body = scriptFailureBody(result)
    expect(body).toContain(AD_SYSTEM_INSTALL_TOO_OLD)
    expect(count(body, message)).toBe(1)
    expect(body).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    expect(body).toContain(STALE_VERSION)
    expect(body).toContain(CLIENT_MIN_VERSION)
    expect(body.endsWith(SKILL_BLOCK)).toBe(true)
  })

  test.each([...UNREACHABLE_REASONS])(`${AD_SYSTEM_INSTALL_UNREACHABLE} reason='%s': reason verbatim, then the skill block`, (reason) => {
    const result = unreachableResult(reason)
    const body = scriptFailureBody(result)
    expect(body).toContain(AD_SYSTEM_INSTALL_UNREACHABLE)
    expect(body).toContain(result.message)
    expect(body).toContain(reason)
    expect(body.endsWith(SKILL_BLOCK)).toBe(true)
  })
})

describe('SR-6.3: ad-version-floor-unreadable does NOT get the install-skill block', () => {
  test('class label and message present, no skill block', () => {
    const result = cannedFailureResult(AD_VERSION_FLOOR_UNREADABLE)
    const body = scriptFailureBody(result)
    expect(body).toBe(renderFailure(result))
    expect(body).toContain(AD_VERSION_FLOOR_UNREADABLE)
    expect(body).toContain(result.message)
    expect(body).not.toContain(SKILL_BLOCK.trim())
  })
})

describe('AC 81: no rendered line advises upgrading agent-director', () => {
  const successes: Array<[string, InstallCheckSuccess]> = [
    ...BELOW_FLOOR_PASSING.map(([name, v]): [string, InstallCheckSuccess] => [`success ${name} (note)`, cannedSuccessResult({ binaryVersion: v })]),
    ...MEETS_FLOOR.map(([name, v]): [string, InstallCheckSuccess] => [`success ${name} (no note)`, cannedSuccessResult({ binaryVersion: v })]),
  ]
  const failures: Array<[string, InstallCheckFailure]> = [
    [AD_SYSTEM_INSTALL_NOT_FOUND, cannedFailureResult(AD_SYSTEM_INSTALL_NOT_FOUND)],
    [AD_SYSTEM_INSTALL_TOO_OLD, cannedFailureResult(AD_SYSTEM_INSTALL_TOO_OLD)],
    ...UNREACHABLE_REASONS.map((reason): [string, InstallCheckFailure] => [`${AD_SYSTEM_INSTALL_UNREACHABLE} ${reason}`, unreachableResult(reason)]),
    [AD_VERSION_FLOOR_UNREADABLE, cannedFailureResult(AD_VERSION_FLOOR_UNREADABLE)],
  ]
  const rendered: Array<[string, string]> = [
    ...successes.map(([name, r]): [string, string] => [name, renderSuccess(r)]),
    ...failures.map(([name, r]): [string, string] => [name, scriptFailureBody(r)]),
  ]

  test.each(rendered)('%s: no line carries an upgrade form', (_name, out) => {
    for (const line of out.split('\n')) {
      expect(line.toLowerCase()).not.toContain('upgrade agent-director')
      for (const [, pattern] of UPGRADE_FORMS) expect(flat(line)).not.toMatch(pattern)
    }
    // Across line breaks too.
    for (const [, pattern] of UPGRADE_FORMS) expect(flat(out)).not.toMatch(pattern)
  })

  test('self-check: the audit flags the old too-old advice', () => {
    const old = cannedFailureResult(AD_SYSTEM_INSTALL_TOO_OLD, { message: UPGRADE_FORMS[0]![2] })
    const out = scriptFailureBody(old)
    expect(out.toLowerCase()).toContain('upgrade agent-director')
    expect(UPGRADE_FORMS.some(([, pattern]) => pattern.test(flat(out)))).toBe(true)
  })
})
