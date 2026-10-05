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
 *     block by its heading (`PUBLISHING_HOST_BLOCK_HEADING`, from
 *     src/ad-version-gate.ts) and the section by its title, holds no
 *     fenced block, and carries no upgrade form and no offer to run a command.
 *   - `ad-version-floor-unreadable` names the client-package check (the first
 *     clause of `CLIENT_PACKAGE_REMEDY`, src/install-check.ts) and the section
 *     title, holds no fenced block, and carries no upgrade form (package-manager
 *     commands included) and no offer to run a command. `@latest` is checked
 *     over the whole skill (below), not per branch.
 *   - Each `ad-system-install-unreachable` reason, one case per reason, names
 *     the section title and carries no upgrade form (the re-install row
 *     included) and no file removal. `PROBE_COMMAND_SPAN`, the read-only probe
 *     the reasons name as what failed, is removed before the forms apply (as
 *     ruling C-1's spans in shipped-docs.test.ts); any other backticked
 *     agent-director command still fails. Only `not-executable` holds a fenced
 *     block, and it is `chmod +x` alone.
 * Self-checks edit an in-memory copy of the skill: a re-install, an upgrade,
 * an installer or a package-manager command put back into a branch fails
 * that branch's case.
 *
 * The pinned client, the install check's note, the coupling and the runbooks
 * (b.jg5 SRJ-1110, AC 15, AC 20, AC 81; SRJ-101's skill clause; hatch notes
 * E5, E35, E36):
 *   - The pin: every `agent-director@<spec>` in the whole skill (a file-local
 *     extractor) equals `PHASE1_FLOOR_VERSION`, and equals `package.json`'s
 *     `dependencies['agent-director']`, read from the file (SRJ-101); there is
 *     at least one. No
 *     `@latest` and no other dist-tag appears anywhere in the skill. Self-checks
 *     build `@latest`, a caret range of the floor, the floor's release
 *     candidate (`PHASE1_RC_VERSION`) and `OLD_AD_VERSION` from the shared
 *     versions; each is extracted and fails. The skill's whole prose carries
 *     no package-manager install command (the shared upgrade-forms row taken
 *     by its label; the skill runs no client install); self-checks put
 *     `bun add agent-director@<floor>` into the "This release and
 *     agent-director Phase 1" section, Step 5 and the Notes, and each fails.
 *   - The install check: Step 1's one fenced block runs the `package.json`
 *     script that runs `scripts/install-check.ts`, its name read from
 *     `package.json`.
 *   - The note: Step 1 has one bullet for a pass with a line under the
 *     install check's exported note label (`INSTALL_CHECK_NOTE_LABEL`). It
 *     says to relay the note as printed, that the server refuses to start
 *     until the switch-over (naming `PHASE1_RUNBOOK_SECTION_TITLE`), and to
 *     offer no command and run nothing; it carries no upgrade form and no
 *     offer to run a command. A Step 1 with no such bullet fails naming the
 *     count. Step 4 ends the loop on such a pass. "Next
 *     steps" says agent-director is ready only for a pass with no note line,
 *     and says it is not ready on a pass with one.
 *   - The coupling: one case per clause of SRJ-1110's statement (installed
 *     together; rolled back together; every agent on the host and every
 *     long-running agent-director process stopped before either binary
 *     change; started again after it), each self-checked against the
 *     statement with that clause dropped.
 *   - The runbooks: the skill names the README section of each runbook by its
 *     title (the switch-over title from `src/`, the rollback title from
 *     tests/test-helpers/runbooks.ts). No step title of either README section
 *     (collected with the helper's step matcher) appears in the skill, and the
 *     skill has no heading in the runbook step form.
 * The too-old clause of SRJ-1110 is the too-old branch's block above; the
 * `access.json` ban for skills lives in tests/access-file-retired.test.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { UnreachableReason } from 'agent-director'

import { INSTALL_CHECK_NOTE_LABEL } from '../scripts/install-check.ts'
import { PHASE1_FLOOR_VERSION, PHASE1_RUNBOOK_SECTION_TITLE, PUBLISHING_HOST_BLOCK_HEADING } from '../src/ad-version-gate.ts'
import { CLIENT_PACKAGE_REMEDY } from '../src/install-check.ts'
import {
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
  AD_VERSION_FLOOR_UNREADABLE,
} from '../src/install-check-labels.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import { UNREACHABLE_REASONS } from './test-helpers/install-check-fixtures.ts'
import { classHeading, flat, headings, requiredSection, splitFences } from './test-helpers/markdown.ts'
import { ROLLBACK_RUNBOOK_SECTION_TITLE, stepHeadingPrefix, stepNumberOf } from './test-helpers/runbooks.ts'
import { type ForbiddenForm, UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'

const SKILLS_DIR = resolve(import.meta.dirname, '..', 'skills')
const SKILL_PATH = resolve(SKILLS_DIR, 'install-cscb', 'SKILL.md')
const skillContent = readFileSync(SKILL_PATH, 'utf-8')

/** The repo's `package.json`: its scripts and its runtime dependencies. */
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf-8')) as {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
}

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
 * The raw body of the `##` section of `text` (the skill by default) whose
 * title holds `title` as whole words (after any "Step 5 — " label). Throws
 * naming the file and heading when there is none.
 */
function rawSection(title: string, text: string = skillContent): string {
  return requiredSection(text, new RegExp(`^## (?:.*\\W)?${title}(?:\\W.*)?$`), SKILL_FILE)
}

/** `rawSection` with whitespace collapsed, so a phrase wrapped across lines still matches. */
function section(title: string, text: string = skillContent): string {
  return flat(rawSection(title, text))
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
 * offer to run a command or branch form, and any fenced block (quoted ones
 * included). `[]` when the branch holds.
 */
function pointerBranchProblems(label: string, required: readonly string[], text: string = skillContent): string[] {
  const raw = unquoted(classBranch(label, text))
  const branch = flat(raw)
  return [
    ...lacks(branch, [PHASE1_RUNBOOK_SECTION_TITLE, 'README', ...required]),
    ...formsIn(branch, [...FORBIDDEN_TOO_OLD_FORMS, ...BRANCH_FORMS]),
    ...splitFences(raw).blocks.map((block) => `a fenced block: ${block.body.trim()}`),
  ]
}

describe(`install-cscb skill: the ${AD_SYSTEM_INSTALL_NOT_FOUND} and ${AD_VERSION_FLOOR_UNREADABLE} branches point to the runbook and run nothing (E2 gate; b.jg5 SRJ-208, SRJ-1101)`, () => {
  test.each(POINTER_BRANCHES)('the %s branch names the README section and %p, and holds no command, upgrade, re-install or removal', (label, required) => {
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

/** `value` with every RegExp metacharacter escaped, so a pattern built around it matches it literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The skill as prose: blockquote markers dropped and whitespace collapsed, so a phrase in a quote or across a wrap matches. */
const skillProse = flat(unquoted(skillContent))

/**
 * Every `agent-director@<spec>` in `text`, as its spec: everything after the
 * `@` up to whitespace, a backtick, a quote, a bracket, `,` or `;`, less a
 * trailing `.` or `:` that ends the sentence. An `@` with nothing after it
 * gives the empty spec.
 */
function clientPins(text: string): string[] {
  return [...text.matchAll(/\bagent-director@([^\s`'"()[\],;]*)/g)].map((m) => m[1].replace(/[.:]+$/, ''))
}

/**
 * An npm dist-tag: `@latest` anywhere, or a package spec whose part after `@`
 * is a letter-led tag, not a version; a `.` may end the sentence after it. An
 * e-mail address's domain, a dot inside it, is not a tag.
 */
const DIST_TAG = /@latest\b|[\w-]@[A-Za-z][\w-]*(?![\w-]|\.\w)/gi

/** The label of the shared upgrade-forms row for a package-manager install command. */
const PACKAGE_MANAGER_LABEL = 'package-manager install'

/**
 * The shared upgrade-forms row for a package-manager install command, taken by
 * its label. The one row read over the whole skill (R7: the skill runs no
 * client install); the others would hit Step 5's read-only
 * `agent-director list` command.
 */
const PACKAGE_MANAGER_FORM: ForbiddenForm = (() => {
  const row = UPGRADE_FORMS.find(([label]) => label === PACKAGE_MANAGER_LABEL)
  if (!row) throw new Error(`UPGRADE_FORMS has no row labelled "${PACKAGE_MANAGER_LABEL}"`)
  return row
})()

/** Each `##` section the self-check puts a client install into: [section title, its heading line]. */
const CLIENT_INSTALL_SECTIONS: [title: string, heading: string][] = [
  ['This release and agent-director Phase 1', '## This release and agent-director Phase 1\n'],
  ['Next steps', '## Step 5 — Next steps\n'],
  ['Notes', '## Notes\n'],
]

describe('install-cscb skill: the pinned agent-director client (b.jg5 SRJ-1110, SRJ-101; hatch notes E5, E36)', () => {
  test('removing the pin: the skill names the client as agent-director@<version> at least once', () => {
    expect(clientPins(skillContent).length).toBeGreaterThan(0)
  })

  test('a pin other than the floor: every agent-director@<spec> in the skill is PHASE1_FLOOR_VERSION', () => {
    expect(clientPins(skillContent).filter((spec) => spec !== PHASE1_FLOOR_VERSION)).toEqual([])
  })

  test("a pin other than package.json's: every agent-director@<spec> in the skill is package.json's dependencies['agent-director']", () => {
    const pkgSpec = PACKAGE_JSON.dependencies?.['agent-director']
    expect(pkgSpec).toBeDefined()
    expect(clientPins(skillContent).filter((spec) => spec !== pkgSpec)).toEqual([])
  })

  test('no @latest and no other dist-tag anywhere in the skill', () => {
    expect(skillContent.match(DIST_TAG) ?? []).toEqual([])
  })

  test(`a client install put back: no ${PACKAGE_MANAGER_LABEL} command anywhere in the skill`, () => {
    expect(skillProse).not.toMatch(PACKAGE_MANAGER_FORM[1])
  })

  test.each(CLIENT_INSTALL_SECTIONS)('self-check: `bun add agent-director@<floor>` put into the "%s" section fails', (title, heading) => {
    const command = `\`bun add agent-director@${PHASE1_FLOOR_VERSION}\``
    const edited = skillContent.replace(heading, `${heading}\nInstall the client with ${command}.\n`)
    expect(edited).not.toBe(skillContent)
    expect(rawSection(title, edited)).toContain(command)
    expect(flat(unquoted(edited))).toMatch(PACKAGE_MANAGER_FORM[1])
  })

  test.each([
    ['@latest', 'latest'],
    ['a caret range of the floor', `^${PHASE1_FLOOR_VERSION}`],
    ["the floor's release candidate", PHASE1_RC_VERSION],
    ['the release before Phase 1', OLD_AD_VERSION],
    ['an empty spec', ''],
  ])('self-check: %s is extracted and is not the pin', (_how, spec) => {
    const pins = clientPins(`The client is \`agent-director@${spec}\`; run nothing for agent-director@${spec}.`)
    expect(pins).toEqual([spec, spec])
    expect(pins.filter((pin) => pin !== PHASE1_FLOOR_VERSION)).toEqual([spec, spec])
  })

  test('self-check: the floor itself is extracted and passes', () => {
    expect(clientPins(`The client is \`agent-director@${PHASE1_FLOOR_VERSION}\`, as agent-director@${PHASE1_FLOOR_VERSION}.`)).toEqual([PHASE1_FLOOR_VERSION, PHASE1_FLOOR_VERSION])
  })

  test.each(['bun add agent-director@latest', 'pin @latest', 'npx claude-slack-channel-bots@next', 'agent-director@beta.'])(
    'self-check: the dist-tag pattern matches %p',
    (sample) => {
      expect(sample.match(DIST_TAG) ?? []).not.toEqual([])
    },
  )

  test.each([`agent-director@${PHASE1_FLOOR_VERSION}`, `agent-director@${PHASE1_RC_VERSION}`, 'mail someone@example.test.'])(
    'self-check: the dist-tag pattern does not match %p',
    (sample) => {
      expect(sample.match(DIST_TAG) ?? []).toEqual([])
    },
  )
})

/** The title of the skill's Step 1, which runs the install check. */
const STEP1_TITLE = 'Run the shared check'

/** `package.json`'s script names whose command runs the install check's script. */
const INSTALL_CHECK_SCRIPTS: string[] = Object.entries(PACKAGE_JSON.scripts ?? {})
  .filter(([, command]) => command.split(/\s+/).includes('scripts/install-check.ts'))
  .map(([name]) => name)

/** The install check's note label as a code span, as the skill names it. */
const NOTE_LABEL_SPAN = `\`${INSTALL_CHECK_NOTE_LABEL}\``

/** Step 1's top-level bullets in `text`, raw, each up to the next. */
function step1Bullets(text: string = skillContent): string[] {
  return rawSection(STEP1_TITLE, text)
    .split(/\n(?=- )/)
    .filter((chunk) => chunk.startsWith('- '))
}

/** Step 1's bullets for a pass with a note line: the bold lead names the label and does not say "no" note. */
function noteBullets(text: string = skillContent): string[] {
  return step1Bullets(text).filter((bullet) => {
    const lead = /^- \*\*(.*?)\*\*/.exec(bullet)?.[1] ?? ''
    return lead.includes(NOTE_LABEL_SPAN) && !/\b(?:no|without)\b/i.test(lead)
  })
}

/** The one Step 1 bullet in `text` (the skill by default) for a pass with a note line, flattened; throws naming the count otherwise. */
function noteBullet(text: string = skillContent): string {
  const found = noteBullets(text)
  if (found.length !== 1) throw new Error(`${SKILL_FILE}: Step 1 has ${found.length} bullets for a pass with a ${NOTE_LABEL_SPAN} line, expected 1`)
  return flat(unquoted(found[0]))
}

/** A sentence saying agent-director is ready. */
const READY = /\bagent-director\b[^.]*\bis\s+(?:now\s+)?ready\b/i

/** A pass with no note line, named by the label. */
const NO_NOTE = new RegExp(`\\b(?:no|without an?)\\s+${escapeRegExp(NOTE_LABEL_SPAN)}`, 'i')

/** The sentences of the flattened `text` that say agent-director is ready without limiting it to a pass with no note line. */
function unqualifiedReady(text: string): string[] {
  return text.split(/(?<=\.)\s+/).filter((sentence) => READY.test(sentence) && !NO_NOTE.test(sentence))
}

describe("install-cscb skill: the install check and its note (b.jg5 SRJ-1110, SRJ-212; hatch note E5)", () => {
  test('Step 1 runs the package.json script that runs scripts/install-check.ts, in its one fenced block', () => {
    expect(INSTALL_CHECK_SCRIPTS).toHaveLength(1)
    expect(splitFences(rawSection(STEP1_TITLE)).blocks.map((block) => block.body.trim())).toEqual([`bun run ${INSTALL_CHECK_SCRIPTS[0]}`])
  })

  test(`dropping the note relay: Step 1 has one bullet for a pass with a ${NOTE_LABEL_SPAN} line`, () => {
    expect(noteBullets()).toHaveLength(1)
  })

  test('dropping the note relay: the note bullet says to relay the note as printed', () => {
    expect(noteBullet()).toMatch(/\brelay\b[^.]*\bnote\b[^.]*\bas printed\b/i)
  })

  test('the note bullet says the server refuses to start until the switch-over, naming the runbook section', () => {
    expect(noteBullet()).toMatch(/\bserver refuses to start\b[^.]*\buntil the switch-over\b/i)
    expect(noteBullet()).toContain(`README section "${PHASE1_RUNBOOK_SECTION_TITLE}"`)
  })

  test('the note bullet offers no command and runs nothing', () => {
    expect(noteBullet()).toMatch(/\boffer no command and run nothing\b/i)
  })

  test.each(FORBIDDEN_TOO_OLD_FORMS)('the note bullet carries no %s', (_label, pattern) => {
    expect(noteBullet()).not.toMatch(pattern)
  })

  test(`Step 4 ends the loop on a pass with a ${NOTE_LABEL_SPAN} line`, () => {
    const step4 = section('Loop or exit')
    expect(step4).toContain(NOTE_LABEL_SPAN)
    expect(step4).toMatch(/\bends the loop\b/i)
  })

  test(`"Next steps" says agent-director is ready only for a pass with no ${NOTE_LABEL_SPAN} line`, () => {
    const next = section('Next steps')
    expect(next).toMatch(READY)
    expect(unqualifiedReady(next)).toEqual([])
  })

  test(`"Next steps" says agent-director is not ready on a pass with a ${NOTE_LABEL_SPAN} line`, () => {
    const sentences = section('Next steps').split(/(?<=\.)\s+/)
    expect(sentences.filter((s) => s.includes(NOTE_LABEL_SPAN) && !NO_NOTE.test(s) && /\bagent-director is not ready\b/i.test(s))).not.toEqual([])
  })

  test('self-check: an unqualified "ready" fails and a qualified one passes', () => {
    expect(unqualifiedReady('Once the check passes, agent-director is ready to run the personas.')).not.toEqual([])
    expect(unqualifiedReady(`On a pass with no ${NOTE_LABEL_SPAN} line, agent-director is ready to run the personas.`)).toEqual([])
  })

  test('self-check: a Step 1 with no note bullet fails naming the count', () => {
    const edited = skillContent.replace(`with a ${NOTE_LABEL_SPAN} line**`, 'whatever it prints**')
    expect(edited).not.toBe(skillContent)
    expect(noteBullets(edited)).toEqual([])
    expect(() => noteBullet(edited)).toThrow(`${SKILL_FILE}: Step 1 has 0 bullets for a pass with a ${NOTE_LABEL_SPAN} line, expected 1`)
  })
})

/** SRJ-1110's coupling statement, as the clauses' self-checks read it. */
const COUPLING_STATEMENT =
  'This CSCB release and agent-director Phase 1 are installed, and rolled back, together. ' +
  'Every agent on the host, with every long-running agent-director process, is stopped before either binary change and started again after it.'

/** Each clause of the coupling statement: its label, its pattern over the skill's prose, and the statement with that clause dropped. */
const COUPLING_CLAUSES: [label: string, pattern: RegExp, without: string][] = [
  [
    'installed together',
    /\bthis (?:CSCB )?release and agent-director Phase 1 are installed\b[^.]*\btogether\b/i,
    COUPLING_STATEMENT.replace('installed, and rolled back,', 'rolled back'),
  ],
  [
    'rolled back together',
    /\bthis (?:CSCB )?release and agent-director Phase 1 are\b[^.]*\brolled back\b[^.]*\btogether\b/i,
    COUPLING_STATEMENT.replace('installed, and rolled back,', 'installed'),
  ],
  [
    'every agent on the host and every long-running agent-director process stopped before either binary change',
    /\bevery agent on the host\b[^.]*\bevery long-running agent-director process\b[^.]*\bstopped before either binary change\b/i,
    COUPLING_STATEMENT.replace(', with every long-running agent-director process,', ''),
  ],
  [
    'started again after it',
    /\bevery agent on the host\b[^.]*\bstarted again after (?:it|either binary change)\b/i,
    COUPLING_STATEMENT.replace(' and started again after it', ''),
  ],
]

describe('install-cscb skill: the coupled install and rollback (b.jg5 SRJ-1110; HO C15)', () => {
  test.each(COUPLING_CLAUSES)('the skill states the clause: %s', (_label, pattern) => {
    expect(skillProse).toMatch(pattern)
  })

  test.each(COUPLING_CLAUSES)('self-check: the clause "%s" matches the statement and fails with it dropped, the others still matching', (label, pattern, without) => {
    expect(without).not.toBe(COUPLING_STATEMENT)
    expect(COUPLING_STATEMENT).toMatch(pattern)
    expect(COUPLING_CLAUSES.filter(([, p]) => !p.test(without)).map(([l]) => l)).toEqual([label])
  })
})

const README_TEXT = readFileSync(resolve(import.meta.dirname, '..', 'README.md'), 'utf-8')

/** The README's two runbooks: [which, section title]. */
const RUNBOOKS: [which: string, title: string][] = [
  ['switch-over', PHASE1_RUNBOOK_SECTION_TITLE],
  ['rollback', ROLLBACK_RUNBOOK_SECTION_TITLE],
]

/** Each step heading's title in the README's `title` runbook section, without its `Step <n>: ` start. */
function runbookStepTitles(title: string): string[] {
  return headings(requiredSection(README_TEXT, `### ${title}`, 'README.md')).flatMap((h) => {
    const n = stepNumberOf(h.title)
    return n === undefined ? [] : [h.title.slice(stepHeadingPrefix(n).length)]
  })
}

/** Each runbook step title `text` repeats (case-insensitive, over its prose), as `"<section>": <step title>`. */
function repeatedSteps(text: string): string[] {
  const prose = flat(unquoted(text)).toLowerCase()
  return RUNBOOKS.flatMap(([, title]) => runbookStepTitles(title).filter((step) => prose.includes(step.toLowerCase())).map((step) => `"${title}": ${step}`))
}

describe('install-cscb skill: the runbooks by title, their steps not repeated (b.jg5 SRJ-1110, SRJ-1516; hatch note E35)', () => {
  test.each(RUNBOOKS)('dropping a runbook title: the skill names the README %s runbook section by its title', (_which, title) => {
    expect(skillProse).toContain(`README section "${title}"`)
  })

  test.each(RUNBOOKS)('sanity: the README %s runbook section yields at least one step', (_which, title) => {
    expect(runbookStepTitles(title).length).toBeGreaterThan(0)
  })

  test('copying a runbook step: no step title of either runbook appears in the skill', () => {
    expect(repeatedSteps(skillContent)).toEqual([])
  })

  test('the skill has no heading in the runbook step form', () => {
    expect(headings(skillContent).filter((h) => stepNumberOf(h.title) !== undefined).map((h) => h.text)).toEqual([])
  })

  test.each(RUNBOOKS)('self-check: a %s step title copied into the skill fails naming it', (_which, title) => {
    const step = runbookStepTitles(title).at(-1)!
    const edited = skillContent.replace('\n## Notes\n', `\n## Notes\n\n- ${step}.\n`)
    expect(edited).not.toBe(skillContent)
    expect(repeatedSteps(edited)).toContain(`"${title}": ${step}`)
  })
})
