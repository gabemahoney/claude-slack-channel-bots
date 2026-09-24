/**
 * cron-bootstrap.test.ts — Tests for the crontable bootstrap I/O module.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CRONTABLE_TEMPLATE_HEADER, ensureCrontableExists } from '../src/cron-bootstrap.ts'
import { parseCrontable } from '../src/crontable.ts'

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

let tempDir: string
let cronPath: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cron-bootstrap-test-'))
  cronPath = join(tempDir, 'crontable')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Group 1 — missing file: created with exact template header
// ---------------------------------------------------------------------------

describe('ensureCrontableExists — missing file', () => {
  test('reports created', () => {
    expect(ensureCrontableExists(cronPath)).toEqual({ outcome: 'created' })
  })

  test('file exists after create', () => {
    ensureCrontableExists(cronPath)
    expect(existsSync(cronPath)).toBe(true)
  })

  test('file content equals the exported template header exactly', () => {
    ensureCrontableExists(cronPath)
    expect(readFileSync(cronPath, 'utf-8')).toBe(CRONTABLE_TEMPLATE_HEADER)
  })
})

// ---------------------------------------------------------------------------
// Group 2 — pre-existing adversarial content: untouched, already-exists
// ---------------------------------------------------------------------------

describe('ensureCrontableExists — pre-existing adversarial content', () => {
  test.each([
    ['no trailing newline', '0 9 * * * /p/a.md'],
    ['trailing whitespace', '0 9 * * * /p/a.md   \n'],
    ['CRLF line endings', '0 9 * * * /p/a.md\r\n0 * * * * /p/b.md\r\n'],
    ['non-header junk bytes', '\x00\x01not a crontable\xff\n'],
  ])('%s → already-exists, byte-for-byte untouched', (_label, content) => {
    writeFileSync(cronPath, content, 'latin1')
    const before = readFileSync(cronPath) // Buffer

    expect(ensureCrontableExists(cronPath)).toEqual({ outcome: 'already-exists' })

    const after = readFileSync(cronPath) // Buffer
    expect(after.equals(before)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Group 3 — EEXIST race (real fs): swallowed, content intact
// ---------------------------------------------------------------------------

describe('ensureCrontableExists — EEXIST race', () => {
  test('pre-created file forces wx EEXIST → already-exists, content intact', () => {
    const raced = '# a competing writer got here first\n0 * * * * /p/c.md\n'
    writeFileSync(cronPath, raced, 'utf-8')

    expect(ensureCrontableExists(cronPath)).toEqual({ outcome: 'already-exists' })
    expect(readFileSync(cronPath, 'utf-8')).toBe(raced)
  })
})

// ---------------------------------------------------------------------------
// Group 4 — non-EEXIST fs error: failed, no throw, no mkdir
// ---------------------------------------------------------------------------

describe('ensureCrontableExists — non-EEXIST fs error', () => {
  test('missing parent dir → failed with a cause; nothing thrown; no mkdir', () => {
    const missingParent = join(tempDir, 'does-not-exist')
    const target = join(missingParent, 'crontable')

    let result: ReturnType<typeof ensureCrontableExists>
    expect(() => {
      result = ensureCrontableExists(target)
    }).not.toThrow()

    expect(result!.outcome).toBe('failed')
    expect(result!.outcome === 'failed' && result!.cause.length).toBeGreaterThan(0)

    // No parent directory was created and no file was written.
    expect(existsSync(missingParent)).toBe(false)
    expect(existsSync(target)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Group 5 — header/parser integration
// ---------------------------------------------------------------------------

/** Shape of a Slack channel, group or DM ID (e.g. C0123ABC), which the header must not use as a target. */
const SLACK_ID_SHAPE = /\b[CDG][A-Z0-9]{6,}\b/

/** The header's example data lines: the line after each `# Example` line, uncommented. */
function headerExampleLines(): string[] {
  const lines = CRONTABLE_TEMPLATE_HEADER.split('\n')
  return lines.flatMap((l, i) => (l.startsWith('# Example') ? [lines[i + 1]!.replace(/^#\s*/, '')] : []))
}

describe('CRONTABLE_TEMPLATE_HEADER — parser integration', () => {
  test('parseCrontable yields zero schedules and zero errors', () => {
    const result = parseCrontable(CRONTABLE_TEMPLATE_HEADER)
    expect(result.schedules).toEqual([])
    expect(result.errors).toEqual([])
  })

  test('the uncommented examples parse: one explicit persona-target line, then the all-bots line', () => {
    const examples = headerExampleLines()
    expect(examples).toHaveLength(2)
    const { schedules, errors } = parseCrontable(examples.join('\n'))
    expect(errors).toEqual([])
    expect(schedules.map((s) => s.targets.kind)).toEqual(['explicit', 'all-bots'])
    const explicit = schedules[0]!.targets
    const targets = explicit.kind === 'explicit' ? explicit.targets : []
    expect(targets.length).toBeGreaterThan(1)
    for (const t of targets) expect(t).not.toMatch(SLACK_ID_SHAPE)
  })

  test('mentions CSCB_PERSONA for self-targeting', () => {
    expect(CRONTABLE_TEMPLATE_HEADER).toContain('CSCB_PERSONA')
  })

  test('has no Slack-channel-ID-shaped example target', () => {
    expect(CRONTABLE_TEMPLATE_HEADER).not.toMatch(SLACK_ID_SHAPE)
  })
})

// ---------------------------------------------------------------------------
// Group 6 — README / header drift guard
//
// The README embeds CRONTABLE_TEMPLATE_HEADER verbatim in a fenced code block
// and documents scheduler facts around it. These guards fail if the doc and
// the shipped constant drift, or if a mandated fact is dropped from the docs.
// README is resolved by path (repo root, relative to this test file) — never
// by line number or section ordinal — and the header constant is imported,
// never re-typed here.
// ---------------------------------------------------------------------------

// README lives at the repo root, one directory up from tests/.
const README_PATH = join(import.meta.dir, '..', 'README.md')
const README = readFileSync(README_PATH, 'utf-8')

// Scope fact assertions to the Scheduled Prompts section so an unrelated
// mention elsewhere can't mask a missing fact. Slice from the H2 heading to
// the next H2 (the Permission Relay section). Falls back to the whole file if
// the heading is ever renamed, so a rename fails on the verbatim guard rather
// than silently narrowing to nothing.
const SCHEDULED_PROMPTS_H2 = '## Scheduled Prompts (cscb_cron)'
const schedStart = README.indexOf(SCHEDULED_PROMPTS_H2)
const schedEnd = schedStart >= 0 ? README.indexOf('\n## ', schedStart + SCHEDULED_PROMPTS_H2.length) : -1
const SCHEDULED_SECTION =
  schedStart >= 0 ? README.slice(schedStart, schedEnd >= 0 ? schedEnd : undefined) : README
// The section's own prose, without the embedded header: the header already
// names CSCB_PERSONA, unknown-persona and name-or-key targets, so the new facts
// must be stated in the README's prose, not only inside the embedded block.
const SCHEDULED_PROSE = SCHEDULED_SECTION.replace(CRONTABLE_TEMPLATE_HEADER.trim(), '')

describe('README / CRONTABLE_TEMPLATE_HEADER drift guard', () => {
  test('README embeds the exported header constant verbatim', () => {
    // Primary guard: the fenced block in README must contain the shipped
    // constant byte-for-byte (trimming only surrounding whitespace). Perturbing
    // a single character inside the README header block fails this assertion.
    expect(README).toContain(CRONTABLE_TEMPLATE_HEADER.trim())
  })

  test('Scheduled Prompts H2 section is present (fact assertions are scoped to it)', () => {
    expect(schedStart).toBeGreaterThanOrEqual(0)
  })
})

describe('README — mandated crontable/scheduler facts', () => {
  test('documents the CSCB_CRONTABLE_PATH env var name', () => {
    expect(SCHEDULED_SECTION).toContain('CSCB_CRONTABLE_PATH')
  })

  test('documents the cscb-cron: sender convention', () => {
    expect(SCHEDULED_SECTION).toContain('cscb-cron:')
  })

  test('documents no-retry delivery semantics', () => {
    expect(SCHEDULED_SECTION).toContain('No retry')
  })

  test('documents append-do-not-rewrite etiquette', () => {
    expect(SCHEDULED_SECTION).toContain('append')
    expect(SCHEDULED_SECTION).toContain('never rewrite')
  })

  test('documents auto-created header on first boot', () => {
    expect(SCHEDULED_SECTION).toContain('first boot')
    expect(SCHEDULED_SECTION).toContain('auto-create')
  })

  test('documents relative-path-resolves-against-crontable-directory rule', () => {
    expect(SCHEDULED_SECTION).toContain('relative')
    expect(SCHEDULED_SECTION).toContain("crontable's own directory")
  })

  test('documents targets as persona names or keys (outside the embedded header)', () => {
    expect(SCHEDULED_PROSE).toContain('name or its key')
  })

  test('documents CSCB_PERSONA for self-scheduling (outside the embedded header)', () => {
    expect(SCHEDULED_PROSE).toContain('CSCB_PERSONA')
  })

  test('documents the unknown-persona outcome (outside the embedded header) and not the retired channel class', () => {
    expect(SCHEDULED_PROSE).toContain('unknown-persona')
    expect(SCHEDULED_SECTION).not.toContain('unknown-channel')
  })
})
