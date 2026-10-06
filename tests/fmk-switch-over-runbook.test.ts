/**
 * fmk-switch-over-runbook.test.ts — test-13 follows the README's switch-over
 * runbook, with exactly SRJ-1402's host-only substitutions (b.jg5 SRJ-1402;
 * SRJ-1108's /ci Test line; the E35 hatch note; ruling Q13).
 *
 * Reads two texts and runs neither, spawning nothing (SRJ-1301):
 * - the README's switch-over section, found by its title imported from `src/`
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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PHASE1_RUNBOOK_SECTION_TITLE } from '../src/ad-version-gate.ts'
import { requiredSection } from './test-helpers/markdown.ts'
import { runbookSteps, stepHeadingPrefix } from './test-helpers/runbooks.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')

const SCRIPT_FILE = 'tests/integration/test-13-fmk-switch-over.sh'

/** The switch-over section's heading, a `###` section under `## Migration` (runbooks.ts's contract). */
const SECTION_HEADING = `### ${PHASE1_RUNBOOK_SECTION_TITLE}`

/** Where the steps come from, put before every step reader failure. */
const SECTION_NAME = `README.md "${SECTION_HEADING}"`

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
}

/** One substitution test-13 may declare: its step, its kind, and the SRJ-1402 clause it rests on. */
interface Substitution {
  step: number
  kind: string
  basis: string
}

/**
 * The substitutions test-13 declares, by step: SRJ-1402's host-only steps
 * (b.jg5 SRD, bees `t1.jg5.kt`, SRJ-1402 "Host-only steps"), each `basis`
 * quoting the clause the kind rests on. Steps 3 to 6 have none.
 *
 * SRJ-1402 ties two clauses to no step: "Slack apps and token variables are
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
 * What keeps `script` from following the runbook `section` (the README
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
    if (s.step < 1 || s.step > count) findings.push(`step ${s.step}: entered at line ${s.line}, but the README's runbook has steps 1 to ${count}`)
  }
  steps.forEach((s, k) => {
    if (k > 0 && s.step < steps[k - 1].step) findings.push(`step ${s.step}: entered at line ${s.line}, after step ${steps[k - 1].step}`)
  })

  for (const d of substitutions) {
    const inside = steps.filter((s) => s.line < d.line).at(-1)?.step
    if (inside !== d.step) findings.push(`step ${d.step}: ${d.kind} declared at line ${d.line}, ${inside === undefined ? 'before any step' : `inside step ${inside}'s section`}`)
    if (!SUBSTITUTIONS.some((e) => e.step === d.step && e.kind === d.kind)) findings.push(`step ${d.step}: ${d.kind} is not one of SRJ-1402's substitutions for step ${d.step}`)
  }
  for (const e of SUBSTITUTIONS) {
    const times = substitutions.filter((d) => d.step === e.step && d.kind === e.kind).length
    if (times === 0) findings.push(`step ${e.step}: ${e.kind} is not declared (SRJ-1402: ${e.basis})`)
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

describe(`test-13 follows the README's "${PHASE1_RUNBOOK_SECTION_TITLE}" runbook with exactly SRJ-1402's substitutions (b.jg5 SRJ-1402, SRJ-1108)`, () => {
  const section = requiredSection(readRepoFile('README.md'), SECTION_HEADING, 'README.md')
  const script = readRepoFile(SCRIPT_FILE)
  const count = runbookSteps(section, { name: SECTION_NAME }).length

  test(`${SCRIPT_FILE} enters steps 1 to N of the README once each, in order, and declares exactly SRJ-1402's substitutions, each inside its step's section`, () => {
    expect(runbookFindings(section, script)).toEqual([])
  })

  /** A step heading one past the README's last, at the steps' own level. */
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
    ['a step beyond the README', () => [section, `${script}runbook_step ${count + 1}\n`], [new RegExp(`^step ${count + 1}: entered at line \\d+, but the README's runbook has steps 1 to ${count}$`)]],
    ['a README with one more step', () => [withExtraStep(), script], [new RegExp(`^step ${count + 1}: never entered \\(no runbook_step ${count + 1} call\\)$`)]],
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
      [/^step 4: wait-skipped is not one of SRJ-1402's substitutions for step 4$/],
    ],
    [
      'a substitution declared twice',
      () => [section, edit(script, '\nrunbook_step 9\n', '\nrunbook_step 9\nrunbook_substitute 9 no-agents-restarted "again"\n')],
      [/^step 9: no-agents-restarted is declared 2 times$/],
    ],
    ['a missing substitution', () => [section, edit(script, lineStarting(script, 'runbook_substitute 11 expire-skipped '), '')], [/^step 11: expire-skipped is not declared \(SRJ-1402: step 11's expire schedule is skipped\)$/]],
    [
      'a substitution moved to the wrong step',
      () => [section, moveDeclaration(script, 'runbook_substitute 2 autostart-skipped ', 3, 3)],
      [/^step 3: autostart-skipped is not one of SRJ-1402's substitutions for step 3$/, /^step 2: autostart-skipped is not declared \(SRJ-1402: /],
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

  test('self-check: a README step missing below N fails through the step reader, naming the section and the step', () => {
    const last = runbookSteps(section, { name: SECTION_NAME }).at(-1)!
    const gap = edit(section, stepHeadingPrefix(last.number - 1), 'Then: ')

    expect(() => runbookFindings(gap, script)).toThrow(`${SECTION_NAME}: step ${last.number - 1} is missing`)
  })
})
