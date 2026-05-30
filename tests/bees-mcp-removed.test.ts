/**
 * bees-mcp-removed.test.ts — b.w7w regression guard.
 *
 * Asserts that the bees MCP plumbing removed in b.w7w does NOT re-appear in
 * shipping artifacts. Each test is a simple grep that would fail before the
 * fix and pass after it.
 *
 *   1. .claude/skills/ci/SKILL.md must NOT contain BEES_MCP_URL or
 *      host.docker.internal (dropped from docker run invocation).
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
// b.w7w — no BEES_MCP_URL / host.docker.internal in /ci SKILL.md
// ---------------------------------------------------------------------------

describe('b.w7w: ci SKILL.md has no bees MCP env vars or add-host', () => {
  test('BEES_MCP_URL is absent from .claude/skills/ci/SKILL.md', () => {
    const ciSkill = read('.claude/skills/ci/SKILL.md')
    expect(ciSkill).not.toContain('BEES_MCP_URL')
  })

  test('host.docker.internal is absent from .claude/skills/ci/SKILL.md', () => {
    const ciSkill = read('.claude/skills/ci/SKILL.md')
    expect(ciSkill).not.toContain('host.docker.internal')
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
