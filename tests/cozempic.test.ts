/**
 * cozempic.test.ts — Unit tests for cozempic.ts pure helpers.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { homedir } from 'os'
import { resolveJsonlPath } from '../src/cozempic.ts'

describe('resolveJsonlPath', () => {
  test('uses custom configDir when provided', () => {
    const path = resolveJsonlPath('/some/cwd', 'abc-123', '/custom/dir')
    expect(path).toBe('/custom/dir/projects/-some-cwd/abc-123.jsonl')
  })

  test('falls back to ${homedir()}/.claude when configDir is omitted', () => {
    const path = resolveJsonlPath('/some/cwd', 'abc-123')
    expect(path).toBe(`${homedir()}/.claude/projects/-some-cwd/abc-123.jsonl`)
  })

  test('falls back to ${homedir()}/.claude when configDir is explicitly undefined', () => {
    const path = resolveJsonlPath('/some/cwd', 'abc-123', undefined)
    expect(path).toBe(`${homedir()}/.claude/projects/-some-cwd/abc-123.jsonl`)
  })

  test('slug computation replaces non-[a-zA-Z0-9-] with hyphens', () => {
    // Underscore is NOT in the allowed set → becomes hyphen
    const path = resolveJsonlPath('/home/user/my_project', 'sess-1', '/cfg')
    expect(path).toBe('/cfg/projects/-home-user-my-project/sess-1.jsonl')
  })

  test('configDir without trailing slash is joined cleanly', () => {
    const path = resolveJsonlPath('/x', 'id', '/home/horde/.claude-maxauth')
    expect(path).toBe('/home/horde/.claude-maxauth/projects/-x/id.jsonl')
  })
})
