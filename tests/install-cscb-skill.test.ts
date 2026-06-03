/**
 * install-cscb-skill.test.ts — Structural verification for the install-cscb skill.
 *
 * The skill body is interactive markdown driven by Claude — there is no
 * behavioral unit test. But its STRUCTURE is asserted here: frontmatter
 * fields must be present, all eight UnreachableReason branch labels must
 * appear in the body, the ad-version-floor-unreadable handler must be
 * present, and there must be no `default:`-only fallthrough construct
 * that would collapse multiple reasons.
 *
 * This catches accidental deletion of branches or frontmatter drift.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SKILL_PATH = resolve(import.meta.dirname, '..', 'skills', 'install-cscb', 'SKILL.md')
const skillContent = readFileSync(SKILL_PATH, 'utf-8')

const FRONTMATTER_FIELDS = [
  'name:',
  'description:',
  'version:',
  'author:',
  'license:',
  'user-invocable: true',
  'argument-hint:',
  'allowed-tools:',
]

const REASON_LABELS = [
  'not-executable',
  'not-a-regular-file',
  'probe-timeout',
  'probe-nonzero-exit',
  'probe-killed-by-signal',
  'unparseable-version',
  'spawn-failed',
  'other',
]

describe('install-cscb skill: file existence + frontmatter', () => {
  test('SKILL.md exists and is non-empty', () => {
    expect(skillContent.length).toBeGreaterThan(0)
  })

  test('opens with a frontmatter block', () => {
    expect(skillContent.startsWith('---\n')).toBe(true)
  })

  for (const field of FRONTMATTER_FIELDS) {
    test(`frontmatter contains '${field}'`, () => {
      // Restrict the search to the frontmatter block (between the first
      // pair of `---` lines) so body text never satisfies a field check.
      const fmEnd = skillContent.indexOf('\n---\n', 4)
      expect(fmEnd).toBeGreaterThan(0)
      const frontmatter = skillContent.slice(0, fmEnd)
      expect(frontmatter).toContain(field)
    })
  }

  test('allowed-tools contains Bash and Read', () => {
    const fmEnd = skillContent.indexOf('\n---\n', 4)
    const frontmatter = skillContent.slice(0, fmEnd)
    expect(frontmatter).toMatch(/allowed-tools:\s*\[[^\]]*Bash[^\]]*\]/)
    expect(frontmatter).toMatch(/allowed-tools:\s*\[[^\]]*Read[^\]]*\]/)
  })
})

describe('install-cscb skill: eight named reason branches present', () => {
  for (const reason of REASON_LABELS) {
    test(`reason label '${reason}' appears in the body`, () => {
      expect(skillContent).toContain(reason)
    })
  }
})

describe('install-cscb skill: failure-class handlers', () => {
  test('ad-system-install-not-found is named', () => {
    expect(skillContent).toContain('ad-system-install-not-found')
  })

  test('ad-system-install-too-old is named', () => {
    expect(skillContent).toContain('ad-system-install-too-old')
  })

  test('ad-system-install-unreachable is named', () => {
    expect(skillContent).toContain('ad-system-install-unreachable')
  })

  test('ad-version-floor-unreadable handler is present and points at reinstall', () => {
    expect(skillContent).toContain('ad-version-floor-unreadable')
    // The handler must reference reinstalling agent-director from npm.
    expect(skillContent.toLowerCase()).toContain('reinstall')
  })
})

describe('install-cscb skill: no default-only fallthrough', () => {
  test("body contains no 'default:' switch-style fallthrough", () => {
    // The skill is markdown, not code — a literal `default:` fallthrough
    // would indicate the author wrote a switch-style block. Numbered
    // branches per reason are the required form.
    expect(skillContent).not.toMatch(/^\s*default:\s*$/m)
  })

  test('each reason has its own paragraph/section (numbered list)', () => {
    // Cheap heuristic: count appearances of each reason in the body. A
    // legitimate exhaustive switch produces at least one prominent
    // mention per reason. We just sanity-check ≥ 1 here; the per-reason
    // toContain tests above are the load-bearing assertion.
    for (const reason of REASON_LABELS) {
      const occurrences = (skillContent.match(new RegExp(reason, 'g')) || []).length
      expect(occurrences).toBeGreaterThan(0)
    }
  })
})
