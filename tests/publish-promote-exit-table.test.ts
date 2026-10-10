/**
 * publish-promote-exit-table.test.ts — bug b.42j: `/publish`'s promote exit
 * table had no row for exit 70 (SR-7.1, `sanitize-global.sh` failed), which
 * `scripts/publish-promote.sh` exits with and `/publish promote`'s table
 * documents, so an LLM driving `/publish` had no recovery for that exit.
 *
 * Everything is read as text; nothing is run:
 * - `scripts/publish-promote.sh`: the codes its code exits with (0 on success,
 *   and each `sr_exit <n>`, comment lines dropped), and the numbered codes and
 *   the SR-7.1 entry of its exit-code header, through
 *   `tests/test-helpers/shell-header.ts`;
 * - `.claude/skills/publish-promote/SKILL.md`: the one table under
 *   `## Exit code → operator recovery`;
 * - `.claude/skills/publish/SKILL.md`: the promote table in that section, the
 *   first table after its "Promote-phase exit codes" line (the section also
 *   holds the prepare and the backstop tables).
 * The four list the same codes, and the alias's row for SR-7.1's code is
 * promote's row, word for word. A self-check runs the alias check on an
 * in-memory copy of the alias with that row removed, as it was before the fix.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { requiredSection } from './test-helpers/markdown.ts'
import { headerEntries, headerExitCodes, shellCode, shellHeader } from './test-helpers/shell-header.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const readRepo = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8')

const PROMOTE_SCRIPT = 'scripts/publish-promote.sh'
const PROMOTE_SKILL = '.claude/skills/publish-promote/SKILL.md'
const PUBLISH_SKILL = '.claude/skills/publish/SKILL.md'
const EXIT_TABLE_HEADING = '## Exit code → operator recovery'
/** The start of the line that introduces the alias's promote table. */
const PROMOTE_TABLE_INTRO = 'Promote-phase exit codes'

/** One exit-table row: its code (the first cell) and the row as written. */
type ExitRow = [code: number, row: string]

/** The rows with a numeric code of the first Markdown table in `lines`. */
function exitRows(lines: string[], where: string): ExitRow[] {
  const start = lines.findIndex((line) => line.startsWith('|'))
  if (start < 0) throw new Error(`${where}: no table`)
  const end = lines.findIndex((line, i) => i > start && !line.startsWith('|'))
  return lines.slice(start, end < 0 ? undefined : end).flatMap((row): ExitRow[] => {
    const code = /^\|\s*(\d+)\s*\|/.exec(row)?.[1]
    return code === undefined ? [] : [[Number(code), row]]
  })
}

/** `/publish promote`'s exit table: the table under its exit-code heading. */
function promoteSkillRows(text: string): ExitRow[] {
  return exitRows(requiredSection(text, EXIT_TABLE_HEADING, PROMOTE_SKILL).split('\n'), `${PROMOTE_SKILL}, under "${EXIT_TABLE_HEADING}"`)
}

/** `/publish`'s promote table: the first table after the one "Promote-phase exit codes" line under its exit-code heading. */
function publishSkillPromoteRows(text: string): ExitRow[] {
  const lines = requiredSection(text, EXIT_TABLE_HEADING, PUBLISH_SKILL).split('\n')
  const intros = lines.flatMap((line, i) => (line.startsWith(PROMOTE_TABLE_INTRO) ? [i] : []))
  if (intros.length !== 1) {
    throw new Error(`${PUBLISH_SKILL}: expected one "${PROMOTE_TABLE_INTRO}" line under "${EXIT_TABLE_HEADING}", found ${intros.length}`)
  }
  return exitRows(lines.slice(intros[0]! + 1), `${PUBLISH_SKILL}, after "${PROMOTE_TABLE_INTRO}"`)
}

/** The codes of `rows`, sorted, a repeated code kept. */
const codesOf = (rows: ExitRow[]): number[] => rows.map(([code]) => code).sort((a, b) => a - b)

/** The rows of `rows` for `code`, as written. */
const rowsFor = (rows: ExitRow[], code: number): string[] => rows.filter(([c]) => c === code).map(([, row]) => row)

const script = readRepo(PROMOTE_SCRIPT)
const header = shellHeader(script)
const promoteRows = promoteSkillRows(readRepo(PROMOTE_SKILL))
const publishSkill = readRepo(PUBLISH_SKILL)

/** The codes the script exits with: 0 on success, and each `sr_exit <n>`. */
const SCRIPT_CODES = [...new Set([0, ...[...shellCode(script).matchAll(/\bsr_exit\s+(\d+)\b/g)].map((m) => Number(m[1]))])].sort((a, b) => a - b)

/** SR-7.1's code, from the script's header (sanitize-global failed). */
const sr71Entries = headerEntries(header, 'SR-7.1')
const SR71_CODE = sr71Entries[0]?.code ?? null

/** What is wrong with the alias's promote table, against the script's codes and `/publish promote`'s SR-7.1 row. */
function aliasFindings(publishText: string): string[] {
  const findings: string[] = []
  const rows = publishSkillPromoteRows(publishText)
  const codes = codesOf(rows)
  if (codes.join() !== SCRIPT_CODES.join()) {
    findings.push(`${PUBLISH_SKILL}'s promote table lists ${codes.join(', ')}; the script exits with ${SCRIPT_CODES.join(', ')}`)
  }
  if (SR71_CODE !== null && rowsFor(rows, SR71_CODE).join('\n') !== rowsFor(promoteRows, SR71_CODE).join('\n')) {
    findings.push(`${PUBLISH_SKILL}'s ${SR71_CODE} (SR-7.1) row is not ${PROMOTE_SKILL}'s`)
  }
  return findings
}

describe('b.42j: the promote exit codes agree across the script and both skills', () => {
  test("the script's header and /publish promote's exit table list exactly the codes the script exits with, SR-7.1's once each", () => {
    expect({ header: headerExitCodes(header).sort((a, b) => a - b), promoteSkill: codesOf(promoteRows) }).toEqual({
      header: SCRIPT_CODES,
      promoteSkill: SCRIPT_CODES,
    })
    expect(sr71Entries).toHaveLength(1)
    expect(SR71_CODE).not.toBeNull()
    expect(rowsFor(promoteRows, SR71_CODE!)).toEqual([expect.stringMatching(/^\|\s*\d+\s*\|\s*SR-7\.1\s*\|/)])
  })

  test("/publish's promote table lists the same codes, and its SR-7.1 row is /publish promote's, word for word", () => {
    expect(aliasFindings(publishSkill)).toEqual([])
  })

  test("the alias check flags /publish's promote table without its SR-7.1 row, as it was before b.42j", () => {
    const [row] = rowsFor(publishSkillPromoteRows(publishSkill), SR71_CODE!)
    expect(row).toBeDefined()
    const without = publishSkill.replace(`${row}\n`, '')
    expect(without.length).toBe(publishSkill.length - row!.length - 1)
    expect(aliasFindings(without)).toEqual([
      expect.stringContaining(`${PUBLISH_SKILL}'s promote table lists`),
      expect.stringContaining(`${SR71_CODE} (SR-7.1) row`),
    ])
  })
})
