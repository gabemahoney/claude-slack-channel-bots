/**
 * bees-mcp-removed.test.ts — b.w7w regression guard.
 *
 * Asserts that the bees MCP plumbing removed in b.w7w does NOT re-appear in
 * shipping artifacts. Each test is a simple grep that would fail before the
 * fix and pass after it.
 *
 *   1. The /ci code must NOT contain BEES_MCP_URL or host.docker.internal
 *      (dropped from the docker run invocation). b.w7w guarded the skill;
 *      b.uqm SR-20.2 extends both guards to the three scripts behind it, so
 *      they cover .claude/skills/ci/SKILL.md, scripts/ci-run.ts,
 *      scripts/ci-base-build.sh and scripts/ci-verdict.ts.
 *   2. docker/Dockerfile.test must NOT contain `bees-md[serve]`
 *      (serve extras dropped along with MCP).
 *
 * Note: b.upy later deleted docker/test_runner.sh and
 * .claude/skills/release-test/SKILL.md entirely as part of the in-container
 * test-orchestrator collapse. The b.w7w guards for those files are now
 * trivially satisfied by the files' absence and have been removed from this
 * suite.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
}

// ---------------------------------------------------------------------------
// b.w7w, b.uqm SR-20.2 — no BEES_MCP_URL / host.docker.internal in /ci code
// ---------------------------------------------------------------------------

const CI_FILES = [
  '.claude/skills/ci/SKILL.md',
  'scripts/ci-run.ts',
  'scripts/ci-base-build.sh',
  'scripts/ci-verdict.ts',
]

const GUARDS = CI_FILES.flatMap((file) =>
  ['BEES_MCP_URL', 'host.docker.internal'].map((needle) => [needle, file]),
)

describe('b.w7w, b.uqm SR-20.2: /ci code has no bees MCP env vars or add-host', () => {
  test.each(GUARDS)('%s is absent from %s', (needle, file) => {
    expect(read(file)).not.toContain(needle)
  })
})

// ---------------------------------------------------------------------------
// b.w7w — no bees-md[serve] extras in docker/Dockerfile.test
// ---------------------------------------------------------------------------

describe('b.w7w: Dockerfile.test has no bees-md serve extras', () => {
  test('`bees-md[serve]` is absent from docker/Dockerfile.test', () => {
    const dockerfile = read('docker/Dockerfile.test')
    expect(dockerfile).not.toContain('bees-md[serve]')
  })
})
