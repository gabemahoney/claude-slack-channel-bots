/**
 * preflight-ad-check.test.ts — `/publish`'s agent-director host check, gate
 * SR-2.5 (b.jg5 SRJ-211, AC 81): `scripts/ad-version-check.ts`, the SR-2.5
 * block of `scripts/preflight.sh` and the publish skills' SR-2.5 text.
 *
 * - The check runs in process through its exported `runAdVersionCheck`, with
 *   `makeStubResolveSystemBinary` as its resolver and `CLIENT_MIN_VERSION`
 *   through an injected minimum reader, so no case reads the install check's
 *   cache. Never `main()`, never a child process.
 * - `scripts/preflight.sh` and `scripts/publish-prepare.sh` are read as text
 *   (comment lines dropped for the code checks); no test runs them.
 * - `.claude/skills/publish/SKILL.md` and `.claude/skills/publish-prepare/SKILL.md`
 *   are read with the markdown helpers.
 *
 * No line the check writes, no SR-2.5 line of the scripts and no SR-2.5 line
 * of either skill advises upgrading agent-director or names `package.json`.
 * The forms are `tests/test-helpers/upgrade-forms.ts`'s, as written, plus
 * `package.json` (see `SR25_FORMS`). Each audit is also run on an in-memory
 * copy with the old SR-2.5 put back, which it must flag.
 *
 * Every version, title, phrase, prefix and exit code is imported from `src/`,
 * `scripts/` or `tests/test-helpers/`.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  AD_VERSION_CHECK_FAIL_EXIT_CODE,
  runAdVersionCheck,
  SR25_NOTE_PREFIX,
  SR25_PREFIX,
  type AdVersionCheckRun,
} from '../scripts/ad-version-check.ts'
import {
  buildPhase1HostNote,
  compareAdVersions,
  PHASE1_HOST_NOTE_PHRASE,
  PHASE1_RUNBOOK_SECTION_TITLE,
} from '../src/ad-version-gate.ts'
import type { InstallCheckClassLabel, InstallCheckFailure } from '../src/install-check.ts'
import {
  errSystemInstallNotFound,
  errSystemInstallTooOld,
  errSystemInstallUnreachable,
  makeStubResolveSystemBinary,
  STUB_RESOLVE_DEFAULT_PATH,
  type StubResolveSystemBinaryOutcome,
} from './test-helpers/agent-director-stub.ts'
import {
  CLIENT_MIN_VERSION,
  DEV_PLACEHOLDER_VERSION,
  DEV_UNPARSEABLE_VERSION,
  OLD_AD_VERSION,
  PHASE1_RC_VERSION,
} from './test-helpers/agent-director-versions.ts'
import { cannedFailureResult, STALE_VERSION } from './test-helpers/install-check-fixtures.ts'
import { flat, requiredSection, splitFences } from './test-helpers/markdown.ts'
import { UPGRADE_FORMS, type ForbiddenForm } from './test-helpers/upgrade-forms.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const readRepo = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8')

const CHECK_SCRIPT = 'scripts/ad-version-check.ts'
const PREFLIGHT = 'scripts/preflight.sh'
const PUBLISH_PREPARE_SCRIPT = 'scripts/publish-prepare.sh'
const SKILLS = ['.claude/skills/publish/SKILL.md', '.claude/skills/publish-prepare/SKILL.md'] as const
const EXIT_TABLE_HEADING = '## Exit code → operator recovery'

/** The bump kind every run's rerun hint names. */
const BUMP = 'minor'

// ---------------------------------------------------------------------------
// Forbidden forms
// ---------------------------------------------------------------------------

/** "Upgrade agent-director", any case: no line of either skill says it. */
const UPGRADE_AD = /\bupgrade\s+agent-director\b/i

/** Every SR-2.5 text: the upgrade forms as written, and `package.json`. */
const SR25_FORMS: readonly ForbiddenForm[] = [
  ...UPGRADE_FORMS,
  ['`package.json`', /package\.json/i, "edit package.json's agent-director range"],
]

/** The labels of the SR-2.5 forms `text` holds (whitespace collapsed). */
function forbiddenHits(text: string): string[] {
  const f = flat(text)
  return SR25_FORMS.filter(([, pattern]) => pattern.test(f)).map(([label]) => label)
}

/** A dependency restore with no package named: the general package-manager form must still flag it. */
const DEPENDENCY_RESTORE = "restore the installed client with 'bun install --frozen-lockfile'"

test('the forbidden-form matcher flags a mixed-case upgrade line, each sample, a dependency restore and package.json', () => {
  const line = 'uPGRADE Agent-Director and retry'
  expect(UPGRADE_AD.test(line)).toBe(true)
  expect(forbiddenHits(line)).not.toEqual([])
  for (const [label, , sample] of SR25_FORMS) expect(forbiddenHits(sample)).toContain(label)
  expect(forbiddenHits(DEPENDENCY_RESTORE)).not.toEqual([])
  // UPGRADE_FORMS as written, every row unchanged and in order, then package.json.
  expect(SR25_FORMS).toHaveLength(UPGRADE_FORMS.length + 1)
  UPGRADE_FORMS.forEach((form, i) => expect(SR25_FORMS[i]).toBe(form))
})

// ---------------------------------------------------------------------------
// scripts/ad-version-check.ts, in process
// ---------------------------------------------------------------------------

/** One check run with one stub resolver outcome and the given minimum reader; returns the run and the resolver's calls. */
async function runCheck(
  outcome: StubResolveSystemBinaryOutcome,
  readClientMinVersion: () => string | InstallCheckFailure = () => CLIENT_MIN_VERSION,
): Promise<{ run: AdVersionCheckRun; calls: Array<object | undefined> }> {
  const calls: Array<object | undefined> = []
  const resolveSystemBinary = makeStubResolveSystemBinary({ outcomes: [outcome], calls })
  const run = await runAdVersionCheck({ resolveSystemBinary, readClientMinVersion, bumpKind: BUMP })
  return { run, calls }
}

/** No stdout or stderr line advises an upgrade or names package.json. */
function expectNoAdvice(run: AdVersionCheckRun): void {
  for (const line of [...run.stdout, ...run.stderr]) expect(forbiddenHits(line)).toEqual([])
}

/** A failed run: the fail code, nothing on stdout, one SR-2.5 diagnostic naming the runbook, the rerun hint and `named`. */
function expectFailure(run: AdVersionCheckRun, named: readonly string[]): void {
  expect(run.exitCode).toBe(AD_VERSION_CHECK_FAIL_EXIT_CODE)
  expect(run.exitCode).not.toBe(0)
  expect(run.stdout).toEqual([])
  expect(run.stderr).toHaveLength(1)
  const [line] = run.stderr
  expect(line!.startsWith(`${SR25_PREFIX}: `)).toBe(true)
  expect(line!.startsWith(SR25_NOTE_PREFIX)).toBe(false)
  expect(line).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
  expect(line).toContain(`/publish ${BUMP}`)
  for (const text of named) expect(line).toContain(text)
  expectNoAdvice(run)
}

describe('scripts/ad-version-check.ts', () => {
  test('the below-minimum version sits below the client minimum', () => {
    expect(compareAdVersions(STALE_VERSION, CLIENT_MIN_VERSION)).toBe(-1)
  })

  test.each([
    ['the Phase 1 release candidate passes with no note', PHASE1_RC_VERSION, false],
    ['the release before Phase 1 passes with the note', OLD_AD_VERSION, true],
    ["the client's development sentinel passes with the note", DEV_PLACEHOLDER_VERSION, true],
  ])('%s', async (_name, version, noted) => {
    const { run, calls } = await runCheck({ version })
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toHaveLength(1)
    expect(run.stdout[0]!.startsWith(`${SR25_PREFIX}: `)).toBe(true)
    expect(run.stdout[0]).toContain(version)
    expect(run.stdout[0]).toContain(STUB_RESOLVE_DEFAULT_PATH)
    const note = buildPhase1HostNote({ foundVersion: version, binaryPath: STUB_RESOLVE_DEFAULT_PATH })
    expect(run.stderr).toEqual(noted ? [`${SR25_NOTE_PREFIX}: ${note}`] : [])
    if (noted) {
      expect(note).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
      expect(note).toContain(PHASE1_HOST_NOTE_PHRASE)
    }
    expect(calls).toHaveLength(1)
    expectNoAdvice(run)
  })

  test.each<[string, StubResolveSystemBinaryOutcome, readonly string[]]>([
    ['a version below the client minimum', { version: STALE_VERSION }, [STALE_VERSION, CLIENT_MIN_VERSION, STUB_RESOLVE_DEFAULT_PATH]],
    ['ErrSystemInstallTooOld', { throws: errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION, STUB_RESOLVE_DEFAULT_PATH) }, [STALE_VERSION, CLIENT_MIN_VERSION]],
    ['ErrSystemInstallNotFound', { throws: errSystemInstallNotFound() }, []],
    ['ErrSystemInstallUnreachable', { throws: errSystemInstallUnreachable('other', null, STUB_RESOLVE_DEFAULT_PATH) }, [STUB_RESOLVE_DEFAULT_PATH]],
    ['a version that does not parse', { version: DEV_UNPARSEABLE_VERSION }, [DEV_UNPARSEABLE_VERSION]],
    ['an error of no install class', { throws: new Error('resolver failed') }, []],
  ])('%s fails SR-2.5 naming the runbook', async (_name, outcome, named) => {
    const { run, calls } = await runCheck(outcome)
    expectFailure(run, named)
    expect(calls).toHaveLength(1)
  })

  // No exported constant holds this label; the type pins it to a real install-check label.
  const FLOOR_UNREADABLE: InstallCheckClassLabel = 'ad-version-floor-unreadable'

  test.each<[string, () => string | InstallCheckFailure, number]>([
    ['returns its read failure', () => cannedFailureResult(FLOOR_UNREADABLE), 0],
    ['throws', () => { throw new Error('floor read failed') }, 0],
    ['returns a minimum that does not parse', () => DEV_UNPARSEABLE_VERSION, 1],
  ])('a client-minimum reader that %s fails SR-2.5 naming the runbook', async (_name, reader, resolverCalls) => {
    const { run, calls } = await runCheck({ version: PHASE1_RC_VERSION }, reader)
    // expectFailure holds the diagnostic to every SR-2.5 form: UPGRADE_FORMS as written and package.json.
    expectFailure(run, [])
    // A minimum that cannot be read at all fails before the host binary is resolved.
    expect(calls).toHaveLength(resolverCalls)
  })
})

// ---------------------------------------------------------------------------
// scripts/preflight.sh and scripts/publish-prepare.sh, read as text
// ---------------------------------------------------------------------------

/** `text` without its comment lines (the shebang included). */
function shellCode(text: string): string {
  return text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
}

/** The script's leading comment block. */
function shellHeader(text: string): string {
  const lines = text.split('\n')
  return lines.slice(0, lines.findIndex((line) => !/^\s*#/.test(line))).join('\n')
}

/** The header's SR-2.5 exit-code entry: its code and its text, continuation lines included. */
function headerEntry(text: string): { code: number; text: string } | undefined {
  const m = /^#\s+(\d+)\s+SR-2\.5\b.*(?:\n#\s+(?!\d)\S.*)*/m.exec(shellHeader(text))
  return m ? { code: Number(m[1]), text: m[0] } : undefined
}

/** SR-2.5's block: from its `# SR-2.5` comment to the `# SR-2.6` comment. */
function sr25Block(text: string): string {
  const start = text.search(/^# SR-2\.5\b/m)
  const end = text.search(/^# SR-2\.6\b/m)
  if (start < 0 || end < start) throw new Error(`${PREFLIGHT} has no # SR-2.5 block before # SR-2.6`)
  return text.slice(start, end)
}

/** What is wrong with preflight.sh's SR-2.5 and header, given the exit code the publish skill lists. */
function preflightFindings(text: string, listedCode: number): string[] {
  const findings: string[] = []
  const code = shellCode(text)
  const block = shellCode(sr25Block(text))
  const runLine = block.split('\n').find((line) => new RegExp(`^\\s*bun\\s+${CHECK_SCRIPT.replace(/\./g, '\\.')}\\b`).test(line))
  if (runLine === undefined) findings.push(`SR-2.5 does not run ${CHECK_SCRIPT} through bun`)
  else if (/[<>]|(?<!\|)\|(?!\|)/.test(runLine)) findings.push("SR-2.5 redirects or pipes the check's output")
  const exits = [...block.matchAll(/\bsr_exit\s+(\d+)/g)].map((m) => Number(m[1]))
  if (exits.length === 0 || exits.some((c) => c !== listedCode)) findings.push(`SR-2.5 exits through sr_exit ${exits.join(',')}, not ${listedCode}`)
  if (![...block.matchAll(/-ne\s+(\d+)/g)].some((m) => Number(m[1]) === listedCode)) findings.push(`SR-2.5 does not tell the check's ${listedCode} from a crash`)
  if (/\bagent-director\s+version\b/.test(code)) findings.push('runs `agent-director version`')
  if (/\bsemver\b/.test(code)) findings.push('calls semver')
  if (/dependencies[^\n]*agent-director/.test(code)) findings.push("reads package.json's agent-director dependency")
  if (/\bjq\b/.test(block)) findings.push('SR-2.5 runs jq')
  const echoes = block.split('\n').filter((line) => line.includes(`echo "${SR25_PREFIX}`))
  if (echoes.length === 0) findings.push('SR-2.5 writes no fallback diagnostic')
  for (const line of echoes) if (!line.includes(PHASE1_RUNBOOK_SECTION_TITLE)) findings.push(`SR-2.5 line lacks the runbook title: ${line.trim()}`)
  for (const hit of forbiddenHits(block)) findings.push(`SR-2.5 code: ${hit}`)
  const entry = headerEntry(text)
  if (entry === undefined) findings.push('header has no SR-2.5 exit-code entry')
  else {
    if (entry.code !== listedCode) findings.push(`header lists SR-2.5 as ${entry.code}, not ${listedCode}`)
    for (const hit of forbiddenHits(entry.text)) findings.push(`header SR-2.5 entry: ${hit}`)
  }
  const header = flat(shellHeader(text))
  if (/\bupgrad\w*\s+(?:the\s+host's\s+)?agent-director\b/i.test(header)) findings.push('header advises upgrading agent-director')
  if (/package\.json'?s?\s+(?:declared\s+)?range/i.test(header)) findings.push("header names package.json's range")
  return findings
}

/** The SR-2.5 row of a skill's exit-code table, and its code. */
function skillRow(text: string, file: string): { code: number; row: string } {
  const rows = requiredSection(text, EXIT_TABLE_HEADING, file)
    .split('\n')
    .filter((line) => /^\|\s*\d+\s*\|\s*SR-2\.5\s*\|/.test(line))
  if (rows.length !== 1) throw new Error(`${file}: expected one SR-2.5 exit row, found ${rows.length}`)
  return { code: Number(/\d+/.exec(rows[0]!)![0]), row: rows[0]! }
}

/** What is wrong with a publish skill's SR-2.5 text. */
function skillFindings(text: string, file: string): string[] {
  const findings: string[] = []
  const prose = splitFences(text).prose.split('\n')
  for (const line of prose) if (UPGRADE_AD.test(line)) findings.push(`advises upgrading agent-director: ${line.trim()}`)
  const { code, row } = skillRow(text, file)
  if (code !== AD_VERSION_CHECK_FAIL_EXIT_CODE) findings.push(`SR-2.5 row lists ${code}, not ${AD_VERSION_CHECK_FAIL_EXIT_CODE}`)
  if (!row.includes(PHASE1_RUNBOOK_SECTION_TITLE)) findings.push('SR-2.5 row does not name the runbook section')
  for (const line of prose.filter((l) => l.includes('SR-2.5'))) {
    for (const hit of forbiddenHits(line)) findings.push(`SR-2.5 line: ${hit}: ${line.trim().slice(0, 80)}`)
  }
  const note = prose.find((line) => !line.startsWith('|') && line.includes(SR25_NOTE_PREFIX) && line.includes(PHASE1_HOST_NOTE_PHRASE))
  if (note === undefined) findings.push('no paragraph describes the SR-2.5 note')
  else if (!note.includes(PHASE1_RUNBOOK_SECTION_TITLE) || !/\bverbatim\b/.test(note) || !/\bcontinue/.test(note)) {
    findings.push('the SR-2.5 note paragraph does not name the runbook section, or relay the note verbatim and continue')
  }
  return findings
}

describe('SR-2.5 in the scripts and the publish skills', () => {
  const preflight = readRepo(PREFLIGHT)
  const publishSkill = readRepo(SKILLS[0])
  const listedCode = skillRow(publishSkill, SKILLS[0]).code

  test("the publish skill lists the check's fail code for SR-2.5", () => {
    expect(listedCode).toBe(AD_VERSION_CHECK_FAIL_EXIT_CODE)
  })

  test('preflight.sh runs the check through bun, exits with the listed code, and neither reads the range nor advises an upgrade', () => {
    expect(preflightFindings(preflight, listedCode)).toEqual([])
  })

  test.each([
    ['a package.json range read', `AD_RANGE="$(jq -r '.dependencies["agent-director"] // empty' package.json)"`],
    ['a direct version call', `AD_VERSION="$(agent-director version)"`],
    ['a semver range check', `node -e "process.exit(require('semver').satisfies(process.env.AD_VERSION, process.env.AD_RANGE) ? 0 : 1)"`],
    ['upgrade advice', `echo "${SR25_PREFIX}: upgrade the host's agent-director to match the range, then rerun." >&2`],
    ['a changed exit code', `sr_exit ${AD_VERSION_CHECK_FAIL_EXIT_CODE + 1}`],
  ])('the preflight audit flags %s put back into SR-2.5', (_name, line) => {
    const mutated = preflight.replace(/^# SR-2\.6\b/m, `${line}\n$&`)
    expect(preflightFindings(mutated, listedCode)).not.toEqual([])
  })

  /** SR-2.5's own diagnostic: the one `echo "SR-2.5 …"` line, written when the check crashes. */
  const fallbackLines = shellCode(sr25Block(preflight))
    .split('\n')
    .filter((line) => line.includes(`echo "${SR25_PREFIX}`))

  test('the crash fallback names the runbook section and holds no SR-2.5 form', () => {
    expect(fallbackLines).toHaveLength(1)
    const [fallback] = fallbackLines
    expect(fallback).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    expect(forbiddenHits(fallback!)).toEqual([])
  })

  test('the preflight audit flags a dependency restore put into the crash fallback', () => {
    const [fallback] = fallbackLines
    const restored = fallback!.replace(/" >&2\s*$/, ` Run 'bun install --frozen-lockfile' first." >&2`)
    expect(restored).not.toBe(fallback)
    expect(preflightFindings(preflight.replace(fallback!, restored), listedCode)).not.toEqual([])
  })

  test("the preflight audit flags a header line advising an upgrade to package.json's range", () => {
    const mutated = preflight.replace('\n', "\n# Upgrade agent-director to satisfy package.json's declared range.\n")
    expect(preflightFindings(mutated, listedCode)).not.toEqual([])
  })

  test("publish-prepare.sh's header lists SR-2.5 with the fail code and no upgrade or package.json", () => {
    const entry = headerEntry(readRepo(PUBLISH_PREPARE_SCRIPT))
    expect(entry?.code).toBe(AD_VERSION_CHECK_FAIL_EXIT_CODE)
    expect(forbiddenHits(entry!.text)).toEqual([])
  })

  test.each([...SKILLS])('%s: no upgrade line; the SR-2.5 row and note name the runbook, with no upgrade or package.json', (file) => {
    expect(skillFindings(readRepo(file), file)).toEqual([])
  })

  test.each([
    ['the old upgrade-or-edit recovery', (row: string) => row.replace(/\|[^|]*\|\s*$/, '| operator: upgrade agent-director to match the range, or edit the range in package.json |')],
    ['an extra "Upgrade agent-director" line', (row: string) => `${row}\n\nUpgrade agent-director and retry.`],
  ])('the skill audit flags %s', (_name, mutate) => {
    const { row } = skillRow(publishSkill, SKILLS[0])
    expect(skillFindings(publishSkill.replace(row, mutate(row)), SKILLS[0])).not.toEqual([])
  })
})
