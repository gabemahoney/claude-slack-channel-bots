/**
 * fmk-launch-pending-dialog-wait.test.ts — test-17 waits for the dev-channels
 * dialog through the stub's record of the dialogs it printed, never through
 * the pane alone (b.fyq).
 *
 * The stub clears an answered dialog from its pane and scrollback
 * (tests/integration/fixtures/stub-claude.sh `clear_answered_dialog`) and
 * appends every dialog it prints to a record that `stub_shown_dialogs` reads
 * (tests/README.md, the stub's entry). A wait that polls only the pane can
 * miss a dialog shown and answered between two reads: test-17's scenario 5
 * did under parallel /ci load, failing with "P's pane never showed the
 * dev-channels dialog" though the approver had answered it.
 *
 * Reads the script and runs nothing (it runs only in /ci). The rule: every
 * loop of the script that breaks on the dev-channels needle (`${DEV_NEEDLE}`)
 * reads the pane (`pane_capture`) and then writes `stub_shown_dialogs`'s
 * output to a file, and each of its breaks stops on a condition that ORs in a
 * plain (not negated) grep of that file for the needle; and the script has at
 * least one such loop (scenario 5's step 6), so the check never passes for
 * want of a loop to read. The pane comes first because the record can lag
 * the pane (the stub's `show_dialog` tees the dialog to both) but is written
 * before the stub reads the Enter that clears it: a record read and then a
 * pane read can both miss a dialog printed before them, and the loop's last
 * clear read (`last_clear`) would then not be a time before the dialog. The
 * self-checks run the audit over planted loops.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')

const SCRIPT_FILE = 'tests/integration/test-17-fmk-launch-pending.sh'

/** The dev-channels needle as the script names it (fixtures/fmk-texts.ts prints its value at run time). */
const NEEDLE = '${DEV_NEEDLE}'

/** A line that ends a loop's head: `while …; do`, `for …; do` or a lone `do`. */
const LOOP_OPEN = /(?:^|[\s;])do\s*$/

/** A line that closes a loop: `done`, `done < <(…)`. */
const LOOP_CLOSE = /^\s*done\b/

/** A `stub_shown_dialogs` call whose output goes to a file; group 2 is the file's word (`${shown}`). */
const RECORD_READ = /\bstub_shown_dialogs\b[^>|;&]*>\s*("?)([^\s"]+)\1/

/** The script's read of P's pane. */
const PANE_READ_CALL = /\bpane_capture\b/

/** `<condition> && break`, the whole line; group 1 is the condition. */
const AND_BREAK = /^\s*(.+?)\s*&&\s*break\s*$/

/** A `break` alone on its line, which stops the loop from inside an `if`. */
const LONE_BREAK = /^\s*break\s*$/

/** An `if <condition>; then` (or `elif`) line; group 1 is the condition. */
const IF_HEAD = /^\s*(?:el)?if\s+(.+?)\s*;\s*then\s*$/

/** An `else` or `fi` line: a lone `break` below one is not in the branch an `if` head above it opens. */
const BLOCK_EDGE = /^\s*(?:else|fi)\b/

/** One loop of the script: the 1-based line of its head and its body's lines (head and `done` excluded). */
interface Loop {
  line: number
  body: string[]
}

/** The script's loops, paired by nesting, comment lines skipped; `unpaired` names a `done` or a head the pairing left over. */
function scriptLoops(script: string): { loops: Loop[]; unpaired: number[] } {
  const lines = script.split('\n').map((text) => (text.trimStart().startsWith('#') ? '' : text))
  const open: number[] = []
  const loops: Loop[] = []
  const unpaired: number[] = []
  lines.forEach((text, i) => {
    if (LOOP_CLOSE.test(text)) {
      const head = open.pop()
      if (head === undefined) unpaired.push(i + 1)
      else loops.push({ line: head + 1, body: lines.slice(head + 1, i) })
    }
    if (LOOP_OPEN.test(text)) open.push(i)
  })
  return { loops, unpaired: [...unpaired, ...open.map((i) => i + 1)] }
}

/**
 * The condition that stops the loop at each `break` of `body`: the text
 * before `&& break`, or, for a lone `break`, the condition of the nearest
 * `if …; then` above it with no `else` or `fi` between; undefined where the
 * audit cannot read one. Pure.
 */
function stopConditions(body: string[]): (string | undefined)[] {
  return body.flatMap((text, i) => {
    if (!/\bbreak\b/.test(text)) return []
    const andBreak = AND_BREAK.exec(text)
    if (andBreak !== null) return [andBreak[1]]
    if (!LONE_BREAK.test(text)) return [undefined]
    const edge = body.slice(0, i).reverse().find((above) => IF_HEAD.test(above) || BLOCK_EDGE.test(above))
    return [edge === undefined ? undefined : IF_HEAD.exec(edge)?.[1]]
  })
}

/** Whether `condition` holds whenever a plain grep of one of `records` finds the needle: one of its `||` alternatives is that grep, and it has no `&&`. Pure. */
function stopsOnRecord(condition: string, records: string[]): boolean {
  return !condition.includes('&&') && condition.split('||').some((alt) => /^\s*grep\b/.test(alt) && alt.includes(NEEDLE) && records.some((file) => alt.includes(file)))
}

/**
 * What keeps `script`'s waits for the dev-channels dialog (its loops whose
 * body names the needle and breaks) from reading the stub's record: empty
 * when each wait reads the pane, then writes `stub_shown_dialogs`'s output
 * to a file, and stops only on a condition that ORs in a plain grep of that
 * file for the needle, and there is at least one wait. Pure.
 */
function dialogWaitFindings(script: string): string[] {
  const { loops, unpaired } = scriptLoops(script)
  if (unpaired.length > 0) return [`unpaired loop line(s) ${unpaired.join(', ')}: the audit cannot pair each loop head with its done`]
  const waits = loops.filter(({ body }) => body.some((text) => text.includes(NEEDLE)) && body.some((text) => /\bbreak\b/.test(text)))
  if (waits.length === 0) return ['no loop breaks on the dev-channels needle: the audit found no wait for the dialog to read']
  return waits.flatMap(({ line, body }) => {
    const records = body.flatMap((text) => {
      const read = RECORD_READ.exec(text)
      return read === null ? [] : [read[2]!]
    })
    if (records.length === 0) {
      return [`line ${line}: the wait for the dev-channels dialog reads no stub record (stub_shown_dialogs), so it misses a dialog shown and answered between two pane reads`]
    }
    const findings: string[] = []
    const paneAt = body.findIndex((text) => PANE_READ_CALL.test(text))
    if (paneAt === -1 || paneAt > body.findIndex((text) => RECORD_READ.test(text))) {
      findings.push(`line ${line}: the wait for the dev-channels dialog does not read the pane (pane_capture) before the stub's record, so a read clear in both is no proof the dialog had not shown at its time (last_clear)`)
    }
    for (const condition of stopConditions(body)) {
      if (condition === undefined) {
        findings.push(`line ${line}: the audit cannot read the condition of a break in the wait for the dev-channels dialog (write \`if <condition>; then … break\` or \`<condition> && break\`)`)
      } else if (!stopsOnRecord(condition, records)) {
        findings.push(`line ${line}: the wait for the dev-channels dialog stops on \`${condition}\`, which does not OR in a plain grep of the stub's record (${records.join(', ')}) for the needle`)
      }
    }
    return findings
  })
}

const lines = (...text: string[]): string => text.join('\n')

const PANE_READ = '    pane_capture "${step}" "${session}" "${pane}"'
const RECORD_LINE = '    stub_shown_dialogs "${session}" > "${shown}" || fail "${step}: could not read the record"'

describe("test-17 waits for the dev-channels dialog through the stub's record, not the pane alone (b.fyq)", () => {
  test(`${SCRIPT_FILE}: every loop that breaks on the dev-channels needle reads the pane, then stub_shown_dialogs, and stops on a grep of the record for the needle`, () => {
    expect(dialogWaitFindings(readFileSync(resolve(REPO_ROOT, SCRIPT_FILE), 'utf-8'))).toEqual([])
  })

  const planted: [label: string, script: string, expected: RegExp][] = [
    [
      'a wait that reads only the pane (step 6 before b.fyq)',
      lines(
        'while :; do',
        '    line="$(now_s)"',
        PANE_READ,
        '    if grep -qF -- "${DEV_NEEDLE}" "${pane}"; then',
        '        dialog_at="${line}"',
        '        break',
        '    fi',
        '    expect_no_needle "${step}: before the dialog" "${pane}"',
        '    last_clear="${line}"',
        '    sleep "${SCENARIO_POLL_S}"',
        'done',
      ),
      /^line 1: the wait for the dev-channels dialog reads no stub record \(stub_shown_dialogs\)/,
    ],
    [
      'a wait that reads the record but tests only the pane',
      lines('while :; do', PANE_READ, RECORD_LINE, '    if grep -qF -- "${DEV_NEEDLE}" "${pane}"; then', '        break', '    fi', 'done'),
      /^line 1: .* stops on `grep -qF -- "\$\{DEV_NEEDLE\}" "\$\{pane\}"`, which does not OR in a plain grep of the stub's record \(\$\{shown\}\)/,
    ],
    [
      'a stop that needs the needle in both the pane and the record',
      lines('while :; do', PANE_READ, RECORD_LINE, '    grep -qF -- "${DEV_NEEDLE}" "${pane}" && grep -qF -- "${DEV_NEEDLE}" "${shown}" && break', 'done'),
      /^line 1: .* stops on `grep [^`]*"\$\{pane\}" && grep [^`]*"\$\{shown\}"`, which does not OR in/,
    ],
    [
      'a negated record check beside a stop that tests only the pane',
      lines(
        'while :; do',
        PANE_READ,
        RECORD_LINE,
        '    ! grep -qF -- "${DEV_NEEDLE}" "${shown}" || fail "${step}: the record holds a dialog the pane missed"',
        '    if grep -qF -- "${DEV_NEEDLE}" "${pane}"; then',
        '        break',
        '    fi',
        'done',
      ),
      /^line 1: .* stops on `grep -qF -- "\$\{DEV_NEEDLE\}" "\$\{pane\}"`, which does not OR in/,
    ],
    [
      'a break in the else branch of the record test (it stops on a clear read)',
      lines(
        'while :; do',
        PANE_READ,
        RECORD_LINE,
        '    if grep -qF -- "${DEV_NEEDLE}" "${pane}" "${shown}"; then',
        '        sleep "${SCENARIO_POLL_S}"',
        '    else',
        '        break',
        '    fi',
        'done',
      ),
      /^line 1: the audit cannot read the condition of a break in the wait for the dev-channels dialog/,
    ],
    [
      'a wait that reads the record before the pane',
      lines(
        'while :; do',
        '    line="$(now_s)"',
        RECORD_LINE,
        PANE_READ,
        '    if grep -qF -- "${DEV_NEEDLE}" "${pane}" "${shown}"; then',
        '        break',
        '    fi',
        '    last_clear="${line}"',
        'done',
      ),
      /^line 1: the wait for the dev-channels dialog does not read the pane \(pane_capture\) before the stub's record/,
    ],
    [
      'a record read only before the wait',
      lines(RECORD_LINE.trimStart(), 'while :; do', PANE_READ, '    if grep -qF -- "${DEV_NEEDLE}" "${pane}" "${shown}"; then', '        break', '    fi', 'done'),
      /^line 2: the wait for the dev-channels dialog reads no stub record/,
    ],
    [
      'a script whose only wait is a pane predicate under wait_until',
      lines('wait_until 40 "the dialog never showed" pane_shows_dev_dialog', 'for needle in "${DEV_NEEDLE}" "${TRUST_NEEDLE}"; do', '    grep -qF -- "${needle}" "${pane}"', 'done'),
      /^no loop breaks on the dev-channels needle/,
    ],
    [
      'a loop left open',
      lines('while :; do', PANE_READ, RECORD_LINE, '    grep -qF -- "${DEV_NEEDLE}" "${pane}" "${shown}" && break'),
      /^unpaired loop line\(s\) 1: the audit cannot pair each loop head with its done$/,
    ],
  ]

  test.each(planted)('self-check: %s is a finding', (_label, script, expected) => {
    expect(dialogWaitFindings(script)).toEqual([expect.stringMatching(expected)])
  })
})
