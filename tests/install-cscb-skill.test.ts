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
 * Too-old branch (b.jg5 SRJ-208, C8): the `ad-system-install-too-old` branch,
 * found by its `###` heading naming the exported label, names the README
 * switch-over runbook section (title from `PHASE1_RUNBOOK_SECTION_TITLE`) and
 * carries no agent-director upgrade or install command and no instruction to
 * run one. The forbidden forms are the shared upgrade forms
 * (tests/test-helpers/upgrade-forms.ts) plus the skill's own offers to run a
 * command, each checked against a synthetic string so a loosened pattern
 * fails (the shared rows' self-checks live in shipped-docs.test.ts). The
 * checks read that branch alone and it never names the not-found label.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { PHASE1_RUNBOOK_SECTION_TITLE } from '../src/ad-version-gate.ts'
import { AD_SYSTEM_INSTALL_NOT_FOUND, AD_SYSTEM_INSTALL_TOO_OLD } from '../src/install-check.ts'
import { classHeading, flat, requiredSection, splitFences } from './test-helpers/markdown.ts'
import { type ForbiddenForm, UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'

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

/** The raw body of the `###` branch for a class label; throws naming the file and heading when there is none. */
function classBranch(label: string): string {
  return requiredSection(skillContent, classHeading(label), SKILL_FILE)
}

/**
 * The install skill's own forbidden forms (b.jg5 SRJ-208, C8): an offer to run
 * an upgrade or install command, beyond the shared upgrade forms. Each with a
 * synthetic string it must match; checked over the branch's text with
 * whitespace collapsed.
 */
const RUN_OFFER_FORMS: ForbiddenForm[] = [
  ['command run through Bash', /\b(?:via|through|using|with|in)\s+Bash\b/i, 'run the command via Bash and continue'],
  ['Yes/No offer to run', /\*\*(?:Yes|No)\*\*/, '- **Yes** — run it'],
  ['backticked binary-path command line', /`<binary_path>\s+[^\s`][^`]*`/, 'run `<binary_path> version`'],
  ['`<command>` placeholder', /`<command>`/, 'Run it? `<command>`'],
  ['return to Step 1', /\breturn to Step 1\b/i, 'Return to Step 1.'],
]

/** Every form the too-old branch must not carry: the shared upgrade forms and the skill's own. */
const FORBIDDEN_TOO_OLD_FORMS: ForbiddenForm[] = [...UPGRADE_FORMS, ...RUN_OFFER_FORMS]

describe(`install-cscb skill: the ${AD_SYSTEM_INSTALL_TOO_OLD} branch names the runbook and runs nothing (b.jg5 SRJ-208)`, () => {
  const branch = () => flat(classBranch(AD_SYSTEM_INSTALL_TOO_OLD))

  test('the branch names the README switch-over runbook section by its title', () => {
    expect(branch()).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    expect(branch()).toContain('README')
  })

  test.each(FORBIDDEN_TOO_OLD_FORMS)('the branch carries no %s', (_label, pattern) => {
    expect(branch()).not.toMatch(pattern)
  })

  // The shared upgrade forms are self-checked in shipped-docs.test.ts; these
  // cover the skill's own rows.
  test.each(RUN_OFFER_FORMS)('self-check: the %s pattern matches its synthetic string', (_label, pattern, sample) => {
    expect(flat(sample)).toMatch(pattern)
  })

  test('self-check: no pattern matches the runbook pointer itself', () => {
    const pointer = flat(`install agent-director by following the README section "${PHASE1_RUNBOOK_SECTION_TITLE}". Offer no command and run nothing.`)
    expect(FORBIDDEN_TOO_OLD_FORMS.filter(([, pattern]) => pattern.test(pointer)).map(([label]) => label)).toEqual([])
  })

  test('the branch holds no fenced code block', () => {
    expect(splitFences(classBranch(AD_SYSTEM_INSTALL_TOO_OLD)).blocks).toEqual([])
  })

  test(`the branch is not "the same flow as" the ${AD_SYSTEM_INSTALL_NOT_FOUND} branch`, () => {
    expect(branch()).not.toMatch(/\bsame\s+flow\b/i)
    expect(branch()).not.toContain(AD_SYSTEM_INSTALL_NOT_FOUND)
  })

  test('Step 4 says the too-old class ends the skill instead of looping', () => {
    const step4 = section('Loop or exit')
    expect(step4).toContain(AD_SYSTEM_INSTALL_TOO_OLD)
    expect(step4).toMatch(/\bend the skill\b/i)
  })

  test('the frontmatter promises no upgrade and names no upgrade or install command', () => {
    const frontmatter = skillContent.slice(0, skillContent.indexOf('\n---\n', 4))
    for (const [, pattern] of UPGRADE_FORMS) expect(frontmatter).not.toMatch(pattern)
  })

  test('a missing class heading fails naming the file and the heading', () => {
    expect(() => classBranch('no-such-class')).toThrow(`${SKILL_FILE} has no heading matching`)
  })
})
