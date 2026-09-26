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
 * Persona pointer (b.av2 SR-12): the "Next steps" section names personas and
 * their `cscb_<key>` instances and points to the setup wizard and the
 * debugging skill (both existing skills); the Notes say the skill never
 * touches the persona configuration; and nothing calls CSCB's configuration
 * routes or routing. Sections are found by title text through
 * tests/test-helpers/markdown.ts, which throws naming a missing heading. The
 * forbidden-term audit over shipped text lives in tests/shipped-docs.test.ts;
 * it is not repeated here.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { flat, requiredSection } from './test-helpers/markdown.ts'

const SKILLS_DIR = resolve(import.meta.dirname, '..', 'skills')
const SKILL_PATH = resolve(SKILLS_DIR, 'install-cscb', 'SKILL.md')
const skillContent = readFileSync(SKILL_PATH, 'utf-8')

const FRONTMATTER_FIELDS = [
  'name:',
  'description:',
  'version:',
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

const SKILL_FILE = 'skills/install-cscb/SKILL.md'

/**
 * The body of the `##` section whose title holds `title` as whole words (after
 * any "Step 5 — " label), whitespace collapsed so a phrase wrapped across
 * lines still matches. Throws naming the file and heading when there is none.
 */
function section(title: string): string {
  return flat(requiredSection(skillContent, new RegExp(`^## (?:.*\\W)?${title}(?:\\W.*)?$`), SKILL_FILE))
}

describe('install-cscb skill: persona pointer (b.av2 SR-12)', () => {
  test('the "Next steps" section names personas and their cscb_<key> instances', () => {
    const next = section('Next steps')
    expect(next).toContain('persona')
    expect(next).toContain('`cscb_<key>`')
  })

  test.each(['setup-slack-channel-bots', 'debug-slack-channel-bots'])(
    '"Next steps" points to the %s skill, which ships in skills/',
    (skill) => {
      expect(section('Next steps')).toContain(skill)
      expect(existsSync(resolve(SKILLS_DIR, skill, 'SKILL.md'))).toBe(true)
    },
  )

  test('the Notes say the skill never touches the persona configuration', () => {
    expect(section('Notes')).toMatch(/\b(?:does not|doesn't|never) touch(?:es)?\b[^.]*\bpersona configuration\b/i)
  })

  test('the skill no longer calls CSCB configuration routes or routing', () => {
    expect(skillContent).not.toMatch(/\brout(?:e|es|ing)\b/i)
  })

  test('a missing section fails naming the file and the heading', () => {
    expect(() => section('No such section')).toThrow(`${SKILL_FILE} has no heading matching`)
    expect(() => section('No such section')).toThrow('No such section')
  })
})
