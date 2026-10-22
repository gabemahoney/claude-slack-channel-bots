/** Regression guards against reintroducing a private scenario service in CI. */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')
function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
}

const CI_FILES = [
  '.claude/skills/ci/SKILL.md',
  'scripts/ci-run.ts',
  'scripts/ci-base-build.sh',
  'scripts/ci-verdict.ts',
]
// These literal names are negative controls for the retired dependency.
const GUARDS = CI_FILES.flatMap((file) =>
  ['BEES_MCP_URL', 'host.docker.internal'].map((needle) => [needle, file]),
)

describe('/ci has no private scenario service or host-network alias', () => {
  test.each(GUARDS)('%s is absent from %s', (needle, file) => {
    expect(read(file)).not.toContain(needle)
  })
  test('the test image has no retired server dependency', () => {
    expect(read('docker/Dockerfile.test')).not.toContain('bees-md[serve]')
  })
})
