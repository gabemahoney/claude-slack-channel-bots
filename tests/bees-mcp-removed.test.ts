/**
 * bees-mcp-removed.test.ts — b.w7w regression guard.
 *
 * Asserts that the bees MCP plumbing removed in b.w7w does NOT re-appear in
 * shipping artifacts. Each test is a simple grep that would fail before the
 * fix and pass after it.
 *
 *   1. .claude/skills/ci/SKILL.md must NOT contain BEES_MCP_URL or
 *      host.docker.internal (dropped from docker run invocation).
 *   2. docker/test_runner.sh must NOT contain `claude mcp add bees`
 *      (dropped registration step).
 *   3. .claude/skills/release-test/SKILL.md must NOT list any mcp__bees__*
 *      entries in allowed-tools (switched to plain Bash + bees CLI).
 *   4. docker/Dockerfile.test must NOT contain `bees-md[serve]`
 *      (serve extras dropped along with MCP).
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
// b.w7w — no `claude mcp add bees` in docker/test_runner.sh
// ---------------------------------------------------------------------------

describe('b.w7w: test_runner.sh has no bees MCP registration', () => {
  test('`claude mcp add bees` is absent from docker/test_runner.sh', () => {
    const testRunner = read('docker/test_runner.sh')
    expect(testRunner).not.toContain('claude mcp add bees')
  })
})

// ---------------------------------------------------------------------------
// b.w7w — no mcp__bees__* tools in release-test/SKILL.md allowed-tools
// ---------------------------------------------------------------------------

describe('b.w7w: release-test SKILL.md allowed-tools has no mcp__bees__* entries', () => {
  test('mcp__bees__ prefix is absent from .claude/skills/release-test/SKILL.md', () => {
    const releaseTestSkill = read('.claude/skills/release-test/SKILL.md')
    expect(releaseTestSkill).not.toContain('mcp__bees__')
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
