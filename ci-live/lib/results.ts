/**
 * results.ts — the run's outputs in the results dir:
 * - `verdict.txt`: first line `PASS` or `FAIL: <check>: <reason>`;
 * - `results.json`: every check with status, reason, evidence and notes;
 * - `results.md`: a per-check table with evidence, then one row in the
 *   testplan's Results-table format (testplans/b.yko "Results"), ready to
 *   paste: pass, fail or "not run" per column, never a token or a log excerpt;
 *   then what the prompt guard denied (`promptGuard` in results.json: the
 *   count, and each denial's check, persona and command), when the run had
 *   one; then the memory watchdog's peaks (`memory` in results.json), when
 *   the run had a watchdog.
 *
 * Rendering is pure. Every string of the summary passes through the redactor
 * before it is serialised (JSON escaping or a Markdown cell's `\|` would
 * otherwise hide a secret from it), and the serialised text passes through it
 * again.
 */

import type { RecordedResult } from '../checks/framework.ts'
import type { PromptGuardReport } from '../checks/prompt-guard.ts'
import type { WatchdogReport } from './memory-watchdog.ts'
import type { Redactor } from './redact.ts'

/** The testplan Results table's check columns, in the plan's run order (Part 11's 30–34 before the closing 29a and 29b). */
export const RESULTS_COLUMNS = [
  'S1', 'S2', 'S3', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17',
  '18', '19', '20', '21', '22', '23', '24', '25', '26 (optional)', '27', '28 (reboot)', '30', '31', '32', '33', '34',
  '29a', '29b (optional)',
] as const

export interface RunSummary {
  runId: string
  mode: 'real' | 'dry-run'
  date: string
  /** "<version>, <commit>" of the build under test. */
  build: string
  /** "<container hostname> / testuser". */
  hostUser: string
  verdict: string
  results: RecordedResult[]
  notes: string[]
  /** What the prompt guard saw and denied (absent when the run had no guard: no container, or no plan checks). */
  promptGuard?: PromptGuardReport
  /** The memory watchdog's samples, peaks and any abort (absent when the run had no watchdog). */
  memory?: WatchdogReport
}

/** results.md's prompt guard section: the count, then one line per denial (its check, persona and command). */
export function renderPromptGuard(report: PromptGuardReport): string[] {
  const lines = [
    `${report.seen} permission prompt(s) seen; ${report.denied} denied, ${report.notDenied} could not be denied. A denial is a note, never a FAIL.`,
  ]
  if (report.entries.length > 0) lines.push('')
  for (const e of report.entries) lines.push(`- ${e.check}, ${e.persona}, ${e.why}: ${e.command} (${e.how})`)
  return lines
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
}

/** The plan's per-column word: pass, fail or not run. */
export function columnValue(results: readonly RecordedResult[], column: string): string {
  const r = results.find((x) => x.row === column)
  if (!r) return 'not run'
  return r.status === 'PASS' ? 'pass' : r.status === 'FAIL' ? 'fail' : 'not run'
}

export function renderResultsRow(summary: RunSummary): string {
  const columns = RESULTS_COLUMNS.map((c) => columnValue(summary.results, c))
  const notes = summary.notes.join('; ')
  return `| ${[summary.date, summary.build, summary.hostUser, ...columns, notes].map(cell).join(' | ')} |`
}

export function renderResultsMarkdown(summary: RunSummary): string {
  const lines: string[] = []
  lines.push(`# /ci-live run ${summary.runId} (${summary.mode})`)
  lines.push('')
  lines.push(`Verdict: ${summary.verdict}`)
  lines.push('')
  lines.push('| Check | Title | Status | Reason | Evidence | Notes |')
  lines.push('|---|---|---|---|---|---|')
  for (const r of summary.results) {
    lines.push(
      `| ${cell(r.id)} | ${cell(r.title)} | ${r.status} | ${cell(r.reason ?? '')} | ${cell(r.evidence.join('<br>'))} | ${cell((r.notes ?? []).join('<br>'))} |`,
    )
  }
  lines.push('')
  lines.push('## Row for the testplan Results table (testplans/b.yko)')
  lines.push('')
  lines.push(
    `| Date | Build (version, commit) | Host / user | ${RESULTS_COLUMNS.join(' | ')} | Notes |`,
  )
  lines.push(`|${' --- |'.repeat(RESULTS_COLUMNS.length + 4)}`)
  lines.push(renderResultsRow(summary))
  lines.push('')
  if (summary.promptGuard) {
    lines.push('## Prompt guard (prompts no check expected, and prompts a check left open)')
    lines.push('')
    lines.push(...renderPromptGuard(summary.promptGuard))
    lines.push('')
  }
  if (summary.memory) {
    lines.push('## Memory (the watchdog\'s peaks)')
    lines.push('')
    for (const line of summary.memory.lines) lines.push(`- ${line}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function renderResultsJson(summary: RunSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`
}

/** `value` with every string in it (at any depth) passed through the redactor. */
export function redactDeep<T>(value: T, redactor: Redactor): T {
  if (typeof value === 'string') return redactor.redact(value) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redactor)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, redactor)])) as T
  }
  return value
}

export interface ResultsWriter {
  write(name: string, content: string): void
}

/** Write verdict.txt, results.json and results.md, each redacted before and after it is serialised. */
export function writeResults(summary: RunSummary, writer: ResultsWriter, redactor: Redactor): void {
  const safe = redactDeep(summary, redactor)
  writer.write('results.json', redactor.redact(renderResultsJson(safe)))
  writer.write('results.md', redactor.redact(renderResultsMarkdown(safe)))
  writer.write('verdict.txt', `${redactor.redact(safe.verdict.split('\n')[0] ?? 'FAIL: runner: no verdict')}\n`)
}
