/**
 * tests/fixtures/ad-gate/fake-prepare.ts — stands in for
 * scripts/ad-gate/prepare.sh in the command-line runs of tests/ad-gate.test.ts:
 * it fetches nothing and writes a small fixture input tree instead, with the
 * manifest prepare.sh would write over it.
 *
 * Takes prepare.sh's arguments (`--inputs DIR --cscb-version V --ad-role
 * cand|ref`, the candidate's `--ad-expected-version X` or the reference's
 * `--ad-tag vX`, and others it ignores). Reads the scenario named by
 * `AD_GATE_FAKE_SCENARIO` (`FakeScenario` in tests/ad-gate.test.ts) for the
 * tag commit, the scripts and their duration table, and appends each call's
 * role and arguments to `prepare-calls.jsonl` beside it. With the scenario's
 * `badInputs` naming the role (and `onlyRelease`, if set, naming the CSCB
 * release), the manifest's binary sha256 is wrong; with
 * `refCscbDiffers`, the reference gets another CSCB package than the
 * candidate, its own manifest matching it. The scripts are written as
 * tests/ad-gate.test.ts commits them into its scratch tag. Runs no child.
 *
 * SPDX-License-Identifier: MIT
 */

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface Scenario {
  readonly tagCommit: string
  /** Each script's file name and its `# ci-requires:` words, or null. */
  readonly scripts: Readonly<Record<string, string | null>>
  readonly durations: string
  readonly badInputs?: 'cand' | 'ref'
  readonly onlyRelease?: string
  readonly refCscbDiffers?: boolean
}

const scenarioPath = process.env['AD_GATE_FAKE_SCENARIO'] ?? ''
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as Scenario
const args = process.argv.slice(2)
const value = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const inputs = value('--inputs') ?? ''
const role = value('--ad-role') as 'cand' | 'ref'
const adVersion = value('--ad-expected-version') ?? (value('--ad-tag') ?? '').slice(1)
const badInputs = scenario.badInputs === role && (scenario.onlyRelease === undefined || scenario.onlyRelease === value('--cscb-version'))
appendFileSync(join(dirname(scenarioPath), 'prepare-calls.jsonl'), `${JSON.stringify({ role, args })}\n`)

/** Writes a fixture file and returns its sha256. */
function put(path: string, text: string): string {
  mkdirSync(dirname(join(inputs, path)), { recursive: true })
  writeFileSync(join(inputs, path), text)
  return createHash('sha256').update(text).digest('hex')
}

const integration = join('cscb-src', 'tests', 'integration')
for (const [fileName, requires] of Object.entries(scenario.scripts)) {
  put(join(integration, fileName), ['#!/usr/bin/env bash', '# fixture integration script', ...(requires === null ? [] : [`# ci-requires: ${requires}`]), 'exit 0', ''].join('\n'))
}
put(join('cscb-src', 'tests', 'ci-durations.tsv'), scenario.durations)

const manifest = {
  cscb: {
    version: value('--cscb-version'),
    tests_commit: scenario.tagCommit,
    tarball_sha256: put(join('cscb', 'package.tgz'), scenario.refCscbDiffers === true && role === 'ref' ? 'fixture CSCB package, another build\n' : 'fixture CSCB package\n'),
    ad_client_pin: '0.0.0',
  },
  candidate: {
    source: `fixture ${role}`,
    expected_version: adVersion,
    binary_sha256: badInputs ? '0'.repeat(64) : put(join('ad', 'agent-director'), `fixture ${role} binary (never run)\n`),
    admin_sha256: put(join('ad', 'agent-director-admin'), `fixture ${role} admin binary (never run)\n`),
    installer_sha256: put(join('ad', 'install.sh'), `fixture ${role} installer (never run)\n`),
    client_tgz_sha256: '',
  },
  ad_role: role,
}
if (badInputs) put(join('ad', 'agent-director'), `fixture ${role} binary (never run)\n`)
put('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`fake prepare: wrote the ${role} fixture inputs in ${inputs}\n`)
