/**
 * fmk-switch-over-runbook.test.ts — test-13 follows the switch-over runbook
 * in docs/migration.md, with exactly host-only substitutions (
 * /ci Test line; the design note; ruling Q13).
 *
 * The runbook checks read two texts without running them:
 * - the switch-over section of docs/migration.md, found by its title imported from `src/`
 *   and read through the shared step reader (`runbookSteps`,
 *   tests/test-helpers/runbooks.ts); N, its step count, comes from it;
 * - `tests/integration/test-13-fmk-switch-over.sh`, whose two runbook markers
 *   it reads: `runbook_step <n>` enters step <n>, and
 *   `runbook_substitute <n> <kind> <reason>` declares one substitution.
 *
 * The rules:
 * - the script's `runbook_step` calls are steps 1 to N, in order, once each;
 * - its `runbook_substitute` calls are exactly `SUBSTITUTIONS`, each inside
 *   its step's section (after that step's `runbook_step` call and before the
 *   next one);
 * - every marker call is a top-level line with a literal step (and kind), so
 *   none is hidden from the check.
 *
 * The mutation self-checks edit in-memory copies of both texts.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PHASE1_RUNBOOK_DOC, PHASE1_RUNBOOK_SECTION_TITLE } from '../src/ad-version-gate.ts'
import { requiredSection } from './test-helpers/markdown.ts'
import { runbookSteps, stepHeadingPrefix } from './test-helpers/runbooks.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { OLD_AD_VERSION } from './test-helpers/agent-director-versions.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')

const SCRIPT_FILE = 'tests/integration/test-13-fmk-switch-over.sh'

/** The switch-over section's heading, a `###` section under `## Migration` (runbooks.ts's contract). */
const SECTION_HEADING = `### ${PHASE1_RUNBOOK_SECTION_TITLE}`

/** Where the steps come from, put before every step reader failure. */
const SECTION_NAME = `${PHASE1_RUNBOOK_DOC} "${SECTION_HEADING}"`

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
}

/** One substitution test-13 may declare: its step, its kind, and the clause it rests on. */
interface Substitution {
  step: number
  kind: string
  basis: string
}

/**
 * The substitutions test-13 declares, by step: host-only steps
 * (host-only steps), each `basis`
 * quoting the clause the kind rests on. Steps 3 to 6 have none.
 *
 * ties two clauses to no step: "Slack apps and token variables are
 * the container's fixtures" and "the §6 prompt wording [is] skipped". The
 * §6 orchestrator prompt changes at steps 1 ("ship now"), 10 (worker
 * cleanup) and 11 ("hold until after"). By ruling, the build under test that
 * step 1 stages and the Slack fixtures are declared at step 7 too, where the
 * staged build is installed and the credentials files are written.
 *
 * Step 10's post-install check is recorded in the switch-over log as the
 * runbook says; it is no substitution.
 */
const SUBSTITUTIONS: readonly Substitution[] = [
  { step: 1, kind: 'operator-go-ahead', basis: 'the harness records the operator go-ahead in the switch-over log, and the go-ahead checks of steps 1 and 8 read it from there' },
  { step: 1, kind: 'one-socket', basis: "the C7 socket pinning and its display-message check run against the container's one tmux socket" },
  { step: 1, kind: 'claude-code-check-skipped', basis: "step 1's Claude Code check is skipped (the container's workers are stub-claude.sh)" },
  { step: 1, kind: 'staging-build-under-test', basis: "step 1's staging stages the build under test" },
  { step: 1, kind: 'container-settings', basis: "the timing-settings checks of steps 1 and 8 read the container's agent-director config" },
  { step: 1, kind: 'slack-fixtures', basis: "Slack apps and token variables are the container's fixtures (the loopback Slack stub)" },
  { step: 1, kind: 'prompt-wording-skipped', basis: 'the §6 prompt wording is skipped ("ship now")' },
  { step: 2, kind: 'autostart-skipped', basis: 'the host-autostart steps 2 and 10 are skipped' },
  { step: 7, kind: 'staging-build-under-test', basis: "step 1's staging stages the build under test (installed at step 7, by ruling)" },
  { step: 7, kind: 'slack-fixtures', basis: "Slack apps and token variables are the container's fixtures (the credentials files of step 7, by ruling)" },
  { step: 8, kind: 'operator-go-ahead', basis: 'the harness records the operator go-ahead in the switch-over log, and the go-ahead checks of steps 1 and 8 read it from there' },
  { step: 8, kind: 'harness-stops-agents', basis: "step 8's stop of every other agent is the harness's" },
  {
    step: 8,
    kind: 'release-install-script',
    basis: "step 8's Phase 1 install is the release's install script, and its serve restart and start-time check cover only the agent-director processes the container runs",
  },
  { step: 8, kind: 'container-settings', basis: "the timing-settings checks of steps 1 and 8 read the container's agent-director config" },
  { step: 9, kind: 'no-agents-restarted', basis: 'step 9 starts none again' },
  { step: 10, kind: 'prompt-wording-skipped', basis: 'the §6 prompt wording is skipped (worker cleanup)' },
  { step: 10, kind: 'autostart-skipped', basis: 'the host-autostart steps 2 and 10 are skipped' },
  { step: 10, kind: 'container-list', basis: "step 10's launch-start check reads the container's list" },
  { step: 11, kind: 'expire-skipped', basis: "step 11's expire schedule is skipped" },
  { step: 11, kind: 'prompt-wording-skipped', basis: 'the §6 prompt wording is skipped ("hold until after")' },
]

/** One marker call in the script: its 1-based line, its step and, for a substitution, its kind. */
interface Marker {
  line: number
  step: number
  kind: string
}

/**
 * The script's marker calls. A readable call is a whole top-level line:
 * `runbook_step <n>`, or `runbook_substitute <n> <kind> <reason>` with a
 * literal step and kind. Any other line naming a marker (indented, after
 * another command, or with a computed step) is a problem. Comment lines are
 * skipped, and a function definition (`runbook_step() {`) is not a call.
 */
function scriptMarkers(script: string): { steps: Marker[]; substitutions: Marker[]; problems: string[] } {
  const steps: Marker[] = []
  const substitutions: Marker[] = []
  const problems: string[] = []
  script.split('\n').forEach((text, i) => {
    const line = i + 1
    if (text.trimStart().startsWith('#') || !/\brunbook_(?:step|substitute)\b(?!\s*\()/.test(text)) return
    const step = /^runbook_step (\d+)\s*$/.exec(text)
    const sub = /^runbook_substitute (\d+) ([a-z][a-z0-9-]*) \S/.exec(text)
    if (step !== null) steps.push({ line, step: Number(step[1]), kind: '' })
    else if (sub !== null) substitutions.push({ line, step: Number(sub[1]), kind: sub[2] })
    else problems.push(`line ${line}: a runbook marker the check cannot read (a top-level call with a literal step and kind): ${text.trim()}`)
  })
  return { steps, substitutions, problems }
}

/**
 * What keeps `script` from following the runbook `section` (the docs/migration.md
 * section's body) with exactly `SUBSTITUTIONS`, each naming its step and,
 * for a substitution, its kind. Empty when it follows it. Throws as the step
 * reader does when the section's steps are not 1 to N. Pure.
 */
function runbookFindings(section: string, script: string): string[] {
  const count = runbookSteps(section, { name: SECTION_NAME }).length
  const { steps, substitutions, problems } = scriptMarkers(script)
  const findings = [...problems]

  for (let n = 1; n <= count; n++) {
    const times = steps.filter((s) => s.step === n).length
    if (times === 0) findings.push(`step ${n}: never entered (no runbook_step ${n} call)`)
    if (times > 1) findings.push(`step ${n}: entered ${times} times`)
  }
  for (const s of steps) {
    if (s.step < 1 || s.step > count) findings.push(`step ${s.step}: entered at line ${s.line}, but the doc's runbook has steps 1 to ${count}`)
  }
  steps.forEach((s, k) => {
    if (k > 0 && s.step < steps[k - 1].step) findings.push(`step ${s.step}: entered at line ${s.line}, after step ${steps[k - 1].step}`)
  })

  for (const d of substitutions) {
    const inside = steps.filter((s) => s.line < d.line).at(-1)?.step
    if (inside !== d.step) findings.push(`step ${d.step}: ${d.kind} declared at line ${d.line}, ${inside === undefined ? 'before any step' : `inside step ${inside}'s section`}`)
    if (!SUBSTITUTIONS.some((e) => e.step === d.step && e.kind === d.kind)) findings.push(`step ${d.step}: ${d.kind} is not one of the documented substitutions for step ${d.step}`)
  }
  for (const e of SUBSTITUTIONS) {
    const times = substitutions.filter((d) => d.step === e.step && d.kind === e.kind).length
    if (times === 0) findings.push(`step ${e.step}: ${e.kind} is not declared (${e.basis})`)
    if (times > 1) findings.push(`step ${e.step}: ${e.kind} is declared ${times} times`)
  }
  return findings
}

/** `text` with its one occurrence of `from` replaced by `to`; throws unless `from` occurs exactly once, so no mutation is a no-op. */
function edit(text: string, from: string, to: string): string {
  const at = text.indexOf(from)
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`expected exactly one ${JSON.stringify(from)}`)
  return text.slice(0, at) + to + text.slice(at + from.length)
}

/** The one whole line of `text` that starts with `prefix`, with its newline; throws unless exactly one does. */
function lineStarting(text: string, prefix: string): string {
  const found = text.split('\n').filter((line) => line.startsWith(prefix))
  if (found.length !== 1) throw new Error(`expected one line starting ${JSON.stringify(prefix)}, found ${found.length}`)
  return `${found[0]}\n`
}

/** `script` with the whole line starting `prefix` moved to just after the line `runbook_step <to>`, its step rewritten to `as` when given. */
function moveDeclaration(script: string, prefix: string, to: number, as?: number): string {
  const line = lineStarting(script, prefix)
  const moved = as === undefined ? line : line.replace(/^runbook_substitute \d+/, `runbook_substitute ${as}`)
  return edit(edit(script, line, ''), `\nrunbook_step ${to}\n`, `\nrunbook_step ${to}\n${moved}`)
}

describe(`test-13 follows docs/migration.md's "${PHASE1_RUNBOOK_SECTION_TITLE}" runbook with exactly substitutions`, () => {
  const section = requiredSection(readRepoFile(PHASE1_RUNBOOK_DOC), SECTION_HEADING, PHASE1_RUNBOOK_DOC)
  const script = readRepoFile(SCRIPT_FILE)
  const count = runbookSteps(section, { name: SECTION_NAME }).length

  test(`${SCRIPT_FILE} enters steps 1 to N of the runbook once each, in order, and declares exactly substitutions, each inside its step's section`, () => {
    expect(runbookFindings(section, script)).toEqual([])
  })

  /** A step heading one past the runbook's last, at the steps' own level. */
  const withExtraStep = (): string => {
    const last = runbookSteps(section, { name: SECTION_NAME }).at(-1)!
    const heading = section.split('\n')[last.line]
    return `${section}\n${heading.slice(0, heading.length - last.title.length)}${stepHeadingPrefix(count + 1)}Later\nMore.\n`
  }

  const mutations: [label: string, mutate: () => [section: string, script: string], expected: RegExp[]][] = [
    ['a removed step', () => [section, edit(script, '\nrunbook_step 6\n', '\n')], [/^step 6: never entered \(no runbook_step 6 call\)$/]],
    [
      'a reordered step',
      () => [section, edit(edit(edit(script, '\nrunbook_step 5\n', '\n@@\n'), '\nrunbook_step 6\n', '\nrunbook_step 5\n'), '\n@@\n', '\nrunbook_step 6\n')],
      [/^step 5: entered at line \d+, after step 6$/],
    ],
    ['a step entered twice', () => [section, edit(script, '\nrunbook_step 4\n', '\nrunbook_step 4\nrunbook_step 4\n')], [/^step 4: entered 2 times$/]],
    ['a step beyond the runbook', () => [section, `${script}runbook_step ${count + 1}\n`], [new RegExp(`^step ${count + 1}: entered at line \\d+, but the doc's runbook has steps 1 to ${count}$`)]],
    ['a runbook with one more step', () => [withExtraStep(), script], [new RegExp(`^step ${count + 1}: never entered \\(no runbook_step ${count + 1} call\\)$`)]],
    [
      'a step entered with a computed number',
      () => [section, edit(script, '\nrunbook_step 3\n', '\nrunbook_step "$((2 + 1))"\n')],
      [/^line \d+: a runbook marker the check cannot read .*: runbook_step "\$\(\(2 \+ 1\)\)"$/, /^step 3: never entered/],
    ],
    [
      'a step entered inside an if',
      () => [section, edit(script, '\nrunbook_step 3\n', '\nif true; then\n    runbook_step 3\nfi\n')],
      [/^line \d+: a runbook marker the check cannot read .*: runbook_step 3$/, /^step 3: never entered/],
    ],
    [
      'an extra substitution',
      () => [section, edit(script, '\nrunbook_step 4\n', '\nrunbook_step 4\nrunbook_substitute 4 wait-skipped "the five-minute wait is skipped"\n')],
      [/^step 4: wait-skipped is not one of the documented substitutions for step 4$/],
    ],
    [
      'a substitution declared twice',
      () => [section, edit(script, '\nrunbook_step 9\n', '\nrunbook_step 9\nrunbook_substitute 9 no-agents-restarted "again"\n')],
      [/^step 9: no-agents-restarted is declared 2 times$/],
    ],
    ['a missing substitution', () => [section, edit(script, lineStarting(script, 'runbook_substitute 11 expire-skipped '), '')], [/^step 11: expire-skipped is not declared \(step 11's expire schedule is skipped\)$/]],
    [
      'a substitution moved to the wrong step',
      () => [section, moveDeclaration(script, 'runbook_substitute 2 autostart-skipped ', 3, 3)],
      [/^step 3: autostart-skipped is not one of the documented substitutions for step 3$/, /^step 2: autostart-skipped is not declared \(/],
    ],
    [
      "a substitution declared inside another step's section",
      () => [section, moveDeclaration(script, 'runbook_substitute 9 no-agents-restarted ', 10)],
      [/^step 9: no-agents-restarted declared at line \d+, inside step 10's section$/],
    ],
  ]

  test.each(mutations)('self-check: %s fails, naming its step or kind', (_label, mutate, expected) => {
    const [mutatedSection, mutatedScript] = mutate()

    expect(runbookFindings(mutatedSection, mutatedScript)).toEqual(expected.map((pattern) => expect.stringMatching(pattern)))
  })

  test('self-check: a runbook step missing below N fails through the step reader, naming the section and the step', () => {
    const last = runbookSteps(section, { name: SECTION_NAME }).at(-1)!
    const gap = edit(section, stepHeadingPrefix(last.number - 1), 'Then: ')

    expect(() => runbookFindings(gap, script)).toThrow(`${SECTION_NAME}: step ${last.number - 1} is missing`)
  })
})

// provenance must precede replacement; later marked rows resume.
test('test-13 explicitly proves earlier-release provenance before the fresh upgrade and later ordinary resume', () => {
  const script = readRepoFile(SCRIPT_FILE)
  const seed = script.indexOf('# E4_EARLIER_RELEASE_PROVENANCE')
  const replace = script.indexOf('# E4_FRESH_UPGRADE_REPLACEMENT')
  const resume = script.indexOf('# E4_LATER_MARKED_RESUME')
  expect(seed).toBeGreaterThan(-1)
  expect(replace).toBeGreaterThan(seed)
  expect(resume).toBeGreaterThan(replace)
  expect(script.slice(seed, replace)).toContain('tag_prompt')
  expect(script.slice(replace, resume)).toContain('session_id')
  expect(script.slice(replace, resume)).toContain('cmp -s')
  expect(script.slice(resume)).toContain('tag_prompt')
})

describe('b.92v: test-13 old-client content verification', () => {
  // Execute only the real comparison and refusal block over scratch trees.
  // Never source the scenario or run an install, Docker, CSCB or agent-director.
  const script = readRepoFile(SCRIPT_FILE)
  const start = script.indexOf('OLD_CLIENT_DIR="$(client_dir_of ')
  const end = script.indexOf('\nrecord "the old package:', start)
  if (start < 0 || end < start) throw new Error('test-13 old-client comparison block not found')
  const comparison = script.slice(start, end)
  const cases = [
    { label: 'identical client passes', metadata: false, change: 'none', accepted: true },
    { label: 'only Bun .bun-tag metadata passes', metadata: true, change: 'none', accepted: true },
    { label: 'changed client bytes fail even with the same version', metadata: false, change: 'changed', accepted: false },
    { label: 'missing client file fails', metadata: false, change: 'missing', accepted: false },
    { label: 'extra client file fails', metadata: false, change: 'extra', accepted: false },
    { label: 'metadata does not hide changed client bytes', metadata: true, change: 'changed', accepted: false },
    { label: 'metadata does not hide a missing client file', metadata: true, change: 'missing', accepted: false },
    { label: 'metadata does not hide an extra client file', metadata: true, change: 'extra', accepted: false },
    { label: 'other hidden files are substantive', metadata: false, change: 'hidden', accepted: false },
  ] as const

  test.each(cases.map(c => [c.label, c] as const))('%s', (_label, { metadata, change, accepted }) => {
    const root = mkdtempSync('/tmp/cscb-old-client-regression-')
    try {
      const reference = join(root, 'ad-010-client')
      const installed = join(root, 'resolved client')
      for (const dir of [reference, installed]) {
        mkdirSync(join(dir, 'dist'), { recursive: true })
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'agent-director', version: OLD_AD_VERSION }))
        writeFileSync(join(dir, 'dist', 'index.js'), 'export const client = "original";\n')
      }
      if (metadata) writeFileSync(join(installed, '.bun-tag'), 'installer metadata\n')
      if (change === 'changed') writeFileSync(join(installed, 'dist', 'index.js'), 'export const client = "changed";\n')
      if (change === 'missing') rmSync(join(installed, 'dist', 'index.js'))
      if (change === 'extra') writeFileSync(join(installed, 'dist', 'extra.js'), 'unexpected client content\n')
      if (change === 'hidden') writeFileSync(join(installed, '.unexpected'), 'unexpected hidden content\n')

      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        'SCENARIO_ROOT="$HOME"',
        'CSCB_PKG_DIR="$HOME/old-package"',
        'client_dir_of() { printf "%s\\n" "$HOME/resolved client"; }',
        'fail() { printf "FAIL: %s\\n" "$*" >&2; exit 1; }',
        comparison,
        'printf "client verification passed\\n"',
      ].join('\n')], {
        env: hostSafeChildEnv(root, { tools: ['bash', 'diff', 'sed'] }),
        encoding: 'utf8', timeout: 2000,
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      // Include the real refusal/diff in a failure so the red run is evidence
      // of the metadata-only setup defect, not just an unexplained exit code.
      expect({ status: result.status, stderr: accepted ? result.stderr : '' }).toEqual({ status: accepted ? 0 : 1, stderr: '' })
      if (accepted) expect(result.stdout).toContain('client verification passed')
      else {
        expect(result.stdout).not.toContain('client verification passed')
        expect(result.stderr).toContain('setup: the old package resolves the client at')
        expect(readFileSync(join(root, 'old-client.diff'), 'utf8')).toContain(change === 'extra' ? 'extra.js' : change === 'hidden' ? '.unexpected' : 'index.js')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
