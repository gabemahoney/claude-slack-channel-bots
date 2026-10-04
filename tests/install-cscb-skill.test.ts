/**
 * install-cscb-skill.test.ts — Structural verification for the install-cscb skill.
 *
 * The skill body is interactive markdown driven by Claude — there is no
 * behavioral unit test. But its STRUCTURE is asserted here: frontmatter
 * fields must be present, all eight UnreachableReason branch labels
 * (`UNREACHABLE_REASONS` from tests/test-helpers/install-check-fixtures.ts)
 * must appear in the body, each of the four install-check class labels
 * (imported from src/install-check-labels.ts) must be named, and there must
 * be no `default:`-only fallthrough construct that would collapse multiple
 * reasons.
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
 * The other branches (the E2-gate hatch note; b.jg5 SRJ-208, SRJ-1101; E36
 * T2): no branch names an install, re-install or upgrade command or runs the
 * installer, and each points to the README switch-over runbook.
 *   - `ad-system-install-not-found` names the runbook section's publishing-host
 *     block by its heading (`PUBLISHING_HOST_BLOCK_HEADING`, through
 *     tests/test-helpers/runbooks.ts) and the section by its title, holds no
 *     fenced block, and carries no upgrade form and no offer to run a command.
 *   - `ad-version-floor-unreadable` names the client-package check (the first
 *     clause of `CLIENT_PACKAGE_REMEDY`, src/install-check.ts) and the section
 *     title, holds no fenced block, and carries no upgrade form (`@latest`
 *     and package-manager commands included) and no offer to run a command.
 *   - Each `ad-system-install-unreachable` reason, one case per reason, names
 *     the section title and carries no upgrade form (the re-install row
 *     included) and no file removal. `PROBE_COMMAND_SPAN`, the read-only probe
 *     the reasons name as what failed, is removed before the forms apply (as
 *     ruling C-1's spans in shipped-docs.test.ts); any other backticked
 *     agent-director command still fails. Only `not-executable` holds a fenced
 *     block, and it is `chmod +x` alone.
 * Self-checks edit an in-memory copy of the skill: a re-install, an upgrade,
 * an installer or `@latest` put back into a branch fails that branch's case.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { UnreachableReason } from 'agent-director'

import { PHASE1_RUNBOOK_SECTION_TITLE } from '../src/ad-version-gate.ts'
import { CLIENT_PACKAGE_REMEDY } from '../src/install-check.ts'
import {
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
  AD_VERSION_FLOOR_UNREADABLE,
} from '../src/install-check-labels.ts'
import { UNREACHABLE_REASONS } from './test-helpers/install-check-fixtures.ts'
import { classHeading, flat, requiredSection, splitFences } from './test-helpers/markdown.ts'
import { PUBLISHING_HOST_BLOCK_HEADING } from './test-helpers/runbooks.ts'
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
  for (const reason of UNREACHABLE_REASONS) {
    test(`reason label '${reason}' appears in the body`, () => {
      expect(skillContent).toContain(reason)
    })
  }
})

describe('install-cscb skill: failure-class handlers', () => {
  // What each handler says is checked per branch below.
  test.each([AD_SYSTEM_INSTALL_NOT_FOUND, AD_SYSTEM_INSTALL_TOO_OLD, AD_SYSTEM_INSTALL_UNREACHABLE, AD_VERSION_FLOOR_UNREADABLE])(
    '%s is named',
    (label) => {
      expect(skillContent).toContain(label)
    },
  )
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
    for (const reason of UNREACHABLE_REASONS) {
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

/** The raw body of the `###` branch for a class label in `text` (the skill by default); throws naming the file and heading when there is none. */
function classBranch(label: string, text: string = skillContent): string {
  return requiredSection(text, classHeading(label), SKILL_FILE)
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

/**
 * SRJ-208's client-package check: the first clause of `CLIENT_PACKAGE_REMEDY`
 * (src/install-check.ts), before its pointer to the runbook section, which
 * the skill words as the README section.
 */
const CLIENT_PACKAGE_CHECK = (() => {
  const end = CLIENT_PACKAGE_REMEDY.indexOf(';')
  if (end <= 0) throw new Error(`CLIENT_PACKAGE_REMEDY has no clause before ";": ${CLIENT_PACKAGE_REMEDY}`)
  return CLIENT_PACKAGE_REMEDY.slice(0, end)
})()

/**
 * The skill's own forbidden forms in a branch beyond the shared upgrade forms
 * (the E2-gate hatch note; b.jg5 SRJ-1101): a re-install of anything, even
 * one that names no agent-director ("then reinstall."), and the removal or
 * re-creation of a file ("removal of the bad entry"). Each with a synthetic
 * string it must match; checked with whitespace collapsed.
 */
const BRANCH_FORMS: ForbiddenForm[] = [
  ['re-install of anything', /\bre-?install\w*/i, 'then re-installation via the AD install command. Re-run Step 1.'],
  ['file removal or re-creation', /\b(?:remov\w*|delet\w*|recreat\w*|rm)\b/i, 'Recommend inspection and removal of the bad entry.'],
]

/**
 * The read-only probe the unreachable reasons name as what failed
 * ("`agent-director version` did not return"), removed exactly before the
 * upgrade forms apply, as ruling C-1's spans are in shipped-docs.test.ts; any
 * other backticked agent-director command line still fails.
 */
const PROBE_COMMAND_SPAN = '`agent-director version`'

/** The one unreachable reason whose branch may run a command, `chmod +x`, and loop back to Step 1. */
const CHMOD_REASON: UnreachableReason = 'not-executable'

/** The one fenced command `CHMOD_REASON`'s branch may hold. */
const CHMOD_COMMAND = 'chmod +x <binary_path>'

/** A loop back to Step 1, which only `CHMOD_REASON` may take (Step 4). */
const RERUN_STEP_1 = /\bre-?run Step 1\b/i

/** `raw` with each line's blockquote marker dropped, so a fence or a phrase inside a quote is read like any other. */
function unquoted(raw: string): string {
  return raw.replace(/^(\s*)>[ \t]?/gm, '$1')
}

/** The labels of `forms` matching the flattened `text`. */
function formsIn(text: string, forms: readonly ForbiddenForm[]): string[] {
  return forms.filter(([, pattern]) => pattern.test(text)).map(([label]) => label)
}

/** Each of `required` the flattened `text` lacks, as a problem. */
function lacks(text: string, required: readonly string[]): string[] {
  return required.filter((item) => !text.includes(item)).map((item) => `lacks ${item}`)
}

/**
 * The numbered branch for `reason` in the `ad-system-install-unreachable`
 * section of `text`, raw, up to the next numbered branch. Throws naming the
 * reason when no branch opens with it.
 */
function reasonBranch(reason: string, text: string = skillContent): string {
  const lines = classBranch(AD_SYSTEM_INSTALL_UNREACHABLE, text).split('\n')
  const start = lines.findIndex((line) => /^\d+\. \*\*`([^`]+)`\*\*/.exec(line)?.[1] === reason)
  if (start < 0) throw new Error(`${SKILL_FILE}: no numbered branch for reason \`${reason}\` under ${AD_SYSTEM_INSTALL_UNREACHABLE}`)
  const next = lines.findIndex((line, i) => i > start && /^\d+\. /.test(line))
  return lines.slice(start, next < 0 ? undefined : next).join('\n')
}

/** An unreachable reason's problems in `text`: see the header. `[]` when the branch holds. */
function reasonBranchProblems(reason: UnreachableReason, text: string = skillContent): string[] {
  const raw = reasonBranch(reason, text)
  const branch = flat(raw)
  const scanned = branch.split(PROBE_COMMAND_SPAN).join('')
  const blocks = splitFences(raw).blocks.map((block) => block.body.trim())
  return [
    ...lacks(branch, [PHASE1_RUNBOOK_SECTION_TITLE, 'README']),
    ...formsIn(scanned, [...UPGRADE_FORMS, ...BRANCH_FORMS]),
    ...(reason === CHMOD_REASON
      ? blocks.filter((body) => body !== CHMOD_COMMAND).map((body) => `a fenced block other than ${CHMOD_COMMAND}: ${body}`)
      : [...blocks.map((body) => `a fenced block: ${body}`), ...(RERUN_STEP_1.test(branch) ? ['loops back to Step 1'] : [])]),
  ]
}

/** What the not-found and floor-unreadable branches must name besides the README section by its title. */
const POINTER_BRANCHES: readonly [label: string, required: readonly string[]][] = [
  [AD_SYSTEM_INSTALL_NOT_FOUND, [`"${PUBLISHING_HOST_BLOCK_HEADING}"`]],
  [AD_VERSION_FLOOR_UNREADABLE, [CLIENT_PACKAGE_CHECK]],
]

/**
 * A pointer branch's problems in `text`: what it lacks, any upgrade form,
 * offer to run a command or branch form, `@latest`, and any fenced block
 * (quoted ones included). `[]` when the branch holds.
 */
function pointerBranchProblems(label: string, required: readonly string[], text: string = skillContent): string[] {
  const raw = unquoted(classBranch(label, text))
  const branch = flat(raw)
  return [
    ...lacks(branch, [PHASE1_RUNBOOK_SECTION_TITLE, 'README', ...required]),
    ...formsIn(branch, [...FORBIDDEN_TOO_OLD_FORMS, ...BRANCH_FORMS]),
    ...(branch.includes('@latest') ? ['`@latest`'] : []),
    ...splitFences(raw).blocks.map((block) => `a fenced block: ${block.body.trim()}`),
  ]
}

describe(`install-cscb skill: the ${AD_SYSTEM_INSTALL_NOT_FOUND} and ${AD_VERSION_FLOOR_UNREADABLE} branches point to the runbook and run nothing (E2 gate; b.jg5 SRJ-208, SRJ-1101)`, () => {
  test.each(POINTER_BRANCHES)('the %s branch names the README section and %p, and holds no command, upgrade, re-install, removal or @latest', (label, required) => {
    expect(pointerBranchProblems(label, required)).toEqual([])
  })

  test.each([
    [AD_SYSTEM_INSTALL_NOT_FOUND, 'the installer offer back', (text: string) =>
      text.replace(/(### `ad-system-install-not-found`[^\n]*\n)/, '$1\nThe current installer is `install.sh`; offer it:\n\n> Run it? `<command>`\n>\n> - **Yes** — run the command via Bash and continue.\n')],
    [AD_SYSTEM_INSTALL_NOT_FOUND, 'a fenced install command', (text: string) =>
      text.replace(/(### `ad-system-install-not-found`[^\n]*\n)/, '$1\nRun:\n\n```sh\n<the published one-liner>\n```\n')],
    [AD_VERSION_FLOOR_UNREADABLE, "the old `bun add agent-director@latest`, quoted", (text: string) =>
      text.replace(/(### `ad-version-floor-unreadable`[^\n]*\n)/, '$1\n> Reinstall it from npm in the project root:\n>\n> ```sh\n> bun add agent-director@latest\n> ```\n')],
    [AD_VERSION_FLOOR_UNREADABLE, 'a re-install with no command', (text: string) =>
      text.replace(CLIENT_PACKAGE_CHECK, 'Reinstall agent-director from npm and retry')],
  ] as const)('self-check: the %s branch fails with %s', (label, _how, edit) => {
    const edited = edit(skillContent)
    expect(edited).not.toBe(skillContent)
    const required = POINTER_BRANCHES.find(([l]) => l === label)![1]
    expect(pointerBranchProblems(label, required, edited)).not.toEqual([])
  })
})

describe(`install-cscb skill: each ${AD_SYSTEM_INSTALL_UNREACHABLE} reason points to the runbook and names no install, re-install or removal (E2 gate; b.jg5 SRJ-208, SRJ-1101)`, () => {
  test.each(UNREACHABLE_REASONS.map((reason) => [reason] as const))('reason %s', (reason) => {
    expect(reasonBranchProblems(reason)).toEqual([])
  })

  test(`only ${CHMOD_REASON} holds a command, ${CHMOD_COMMAND}`, () => {
    expect(splitFences(reasonBranch(CHMOD_REASON)).blocks.map((block) => block.body.trim())).toEqual([CHMOD_COMMAND])
  })

  /** `text` with `insert` put right after the lead of `reason`'s branch. */
  const insertInto = (reason: string, insert: string) => (text: string) => text.replace(`**\`${reason}\`** — `, `**\`${reason}\`** — ${insert} `)

  test.each([
    ['not-a-regular-file', 'removal of the bad entry, then re-installation', insertInto('not-a-regular-file', 'Recommend removal of the bad entry, then re-installation via the AD install command.')],
    ['probe-nonzero-exit', 'a bare "then reinstall"', insertInto('probe-nonzero-exit', 'Then reinstall.')],
    ['unparseable-version', 'an upgrade', insertInto('unparseable-version', 'Recommend upgrading to a release AD version.')],
    ['spawn-failed', 'a loop back to Step 1', insertInto('spawn-failed', 'Re-run Step 1.')],
    ['other', 'another backticked agent-director command', insertInto('other', 'Run `agent-director doctor --fix`.')],
    ['probe-timeout', 'a fenced command', insertInto('probe-timeout', '\n   ```sh\n   <binary_path> version\n   ```\n')],
    [CHMOD_REASON, 'a fenced command other than chmod', insertInto(CHMOD_REASON, '\n   ```sh\n   rm <binary_path>\n   ```\n')],
  ] as const)('self-check: reason %s fails with %s', (reason, _how, edit) => {
    const edited = edit(skillContent)
    expect(edited).not.toBe(skillContent)
    expect(reasonBranchProblems(reason as UnreachableReason, edited)).not.toEqual([])
  })

  test.each(BRANCH_FORMS)('self-check: the %s pattern matches its synthetic string', (_label, pattern, sample) => {
    expect(flat(sample)).toMatch(pattern)
  })

  test('self-check: a missing reason fails naming it', () => {
    expect(() => reasonBranch('no-such-reason')).toThrow('no numbered branch for reason `no-such-reason`')
  })
})
