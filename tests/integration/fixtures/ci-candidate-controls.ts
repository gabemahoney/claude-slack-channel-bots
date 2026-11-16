/** Cheap, import-safe runner controls. No child, Docker, native agent or HOME
 * state. Run directly with bun; this is not a new unit-suite file.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseCiArguments, isGateEligible, isSelectiveRun, isDefaultFullRun, testImageBuildArgs, buildVerdictLine } from '../../../scripts/ci-run.ts'

const ordinary = parseCiArguments([])
assert(ordinary.ok)
assert.equal(ordinary.invocation.adCandidateDist, undefined)
assert(isGateEligible(ordinary.invocation))
const candidate = parseCiArguments(['test-68', '--ad-candidate-dist', '/tmp/candidate AD'])
assert(candidate.ok)
assert.equal(candidate.invocation.adCandidateDist, '/tmp/candidate AD')
assert(isSelectiveRun(candidate.invocation))
assert(!isGateEligible(candidate.invocation))
assert(!isDefaultFullRun(candidate.invocation))
const fullCandidate = parseCiArguments(['--ad-candidate-dist', '/tmp/candidate'])
assert(fullCandidate.ok)
assert(isSelectiveRun(fullCandidate.invocation), 'candidate cannot claim ordinary full PASS')
assert(!isGateEligible(fullCandidate.invocation))
assert.equal(buildVerdictLine({ invocation: fullCandidate.invocation, passed: true, ranked: [], scripts: ['test-1', 'test-68'] }),
  'SELECTIVE (test-1 test-68): PASS')
for (const args of [
  ['--ad-candidate-dist'], ['--ad-candidate-dist', 'relative'], ['--ad-candidate-dist=/tmp/ad'],
  ['--ad-candidate-dist', '/tmp/ad', '--ad-candidate-dist', '/tmp/ad'], ['--ad-candidate-dist', '/tmp/\nAD'],
]) assert.equal(parseCiArguments(args).ok, false, `accepted malformed option ${JSON.stringify(args)}`)
const spec = { dockerfilePath: 'docker/Dockerfile.test.candidate', contextDir: '/repo', labels: {}, tag: 'cscb-ci-run:20261113t120000z-abcdefgh-123-test' }
const argv = testImageBuildArgs({ ...spec, adCandidateDist: '/tmp/candidate AD' })
assert.deepEqual(argv.slice(argv.indexOf('--build-context'), argv.indexOf('--build-context') + 2),
  ['--build-context', 'ad-candidate=/tmp/candidate AD'])
assert(!testImageBuildArgs({ ...spec, dockerfilePath: 'docker/Dockerfile.test' }).includes('--build-context'))
console.log('recorded: CI candidate controls passed (off by default, parse refusals, exact named-context argument, non-gate verdict)')

// Execute the actual scenario setup's provenance boundary against an inert
// executable, with only the CI/home guards replaced. Never source the harness.
const scenario = readFileSync(new URL('../lib/scenario.sh', import.meta.url), 'utf8')
const check = scenario.match(/^check_ad_runtime\(\) \{\n[\s\S]*?^\}/m)![0]
const root = mkdtempSync(join(tmpdir(), 'cscb-candidate-controls-'))
try {
  for (const [label, version, candidate, mutation, expected] of [
    ['candidate prerelease', '0.19.0-rc.1+build.2', true, '', 0],
    ['ordinary prerelease', '0.19.0-rc.1', false, '', 91],
    ['ordinary release', '0.18.6', false, '', 0],
    ['string opt-in is not authority', '0.19.0-rc.1', 'true', '', 91],
    ['malformed version', '0.19.0-rc.1/invalid', true, '', 91],
    ['malformed commit', '0.19.0-rc.1', true, 'bad-commit', 91],
    ['mismatched version', '0.19.0-rc.1', true, 'version', 1],
    ['mismatched commit', '0.19.0-rc.1', true, 'commit', 1],
    ['mismatched digest', '0.19.0-rc.1', true, 'digest', 1],
  ] as const) {
    const binary = join(root, 'inert-ad'), record = join(root, 'record.json')
    const bytes = '#!/bin/bash\nprintf \'%s\\n\' \'' + JSON.stringify({ version, commit: 'a'.repeat(40) }) + '\'\n'
    writeFileSync(binary, bytes, { mode: 0o755 })
    writeFileSync(record, JSON.stringify({ version: mutation === 'version' ? version + 'x' : version,
      commit: mutation === 'bad-commit' ? 'bad' : (mutation === 'commit' ? 'b' : 'a').repeat(40),
      binary_sha256: mutation === 'digest' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), candidate_overlay: candidate }))
    const shell = 'set -euo pipefail\nrequire_ci_image() { :; }\nrequire_scenario_home() { :; }\nfail() { printf "%s\\n" "$1" >&2; exit 91; }\n' +
      check + '\nSCENARIO_ROOT="$3"\ncheck_ad_runtime "$1" "$2" control\n'
    const result = spawnSync('/bin/bash', ['-c', shell, 'control', binary, record, root], { encoding: 'utf8', timeout: 3000 })
    assert.equal(result.status, expected, `${label}: ${result.stderr}`)
  }
  console.log('recorded: candidate runtime shell controls passed (explicit boolean opt-in, release/prerelease, malformed and exact-identity negatives)')
} finally { rmSync(root, { recursive: true, force: true }) }
