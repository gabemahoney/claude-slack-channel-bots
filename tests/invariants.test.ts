/**
 * invariants.test.ts — SR-0.3 / SR-8.6 grep-style + type-level tripwires.
 *
 *   - SR-0.3 no-shellout: no CSCB source file invokes `agent-director` as
 *     a subprocess. The only legal reference is `from 'agent-director'`
 *     (typed import).
 *   - SR-8.6 request_id is `number`: a compile-time tripwire that fails
 *     closed if the library widens the type.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { PermissionRequestInfo } from 'agent-director'

// ---------------------------------------------------------------------------
// SR-0.3 — no shellout to agent-director
// ---------------------------------------------------------------------------

function walkSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...walkSources(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('SR-0.3: no-shellout invariant', () => {
  test('no src/ file invokes agent-director as a subprocess', () => {
    const srcDir = join(__dirname, '..', 'src')
    const sourceFiles = walkSources(srcDir)
    const offending: Array<{ file: string; line: number; text: string }> = []
    const subprocessIdents = ['spawnSync', 'exec', 'execSync', 'spawn', 'Bun.$']
    for (const file of sourceFiles) {
      const lines = readFileSync(file, 'utf-8').split('\n')
      lines.forEach((text, i) => {
        // Skip comments
        const stripped = text.replace(/\/\/.*$/, '').trim()
        if (!stripped) return
        // The legal reference is `from 'agent-director'` — skip those lines.
        if (/from\s+['"]agent-director['"]/.test(stripped)) return
        // The `client.spawn(...)` library call is explicitly allowed — its
        // identifier is `spawn` but matched only when prefixed by `.` or
        // `client`. We disallow `spawn(` only when paired with a subprocess
        // identifier in the same line.
        for (const ident of subprocessIdents) {
          // Build a regex that matches the ident as a CALL form, not member access.
          const regex = new RegExp(`\\b${ident.replace('$', '\\$').replace('.', '\\.')}\\s*\\(`)
          if (regex.test(stripped) && /agent-director/.test(stripped)) {
            offending.push({ file, line: i + 1, text: stripped })
          }
        }
      })
    }
    expect(offending).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// SR-8.6 — PermissionRequestInfo.request_id is number
// ---------------------------------------------------------------------------

describe('SR-8.6: PermissionRequestInfo.request_id type', () => {
  test('request_id is typed as number — fails compile if widened', () => {
    // This is a compile-time tripwire: if the agent-director library
    // widens request_id beyond `number`, this assertion stops compiling.
    // No runtime expectation; the existence of the assignment is the test.
    const info: PermissionRequestInfo = {
      request_id: Number.MAX_SAFE_INTEGER,
      request_token: '00000000-0000-4000-8000-000000000000',
      tool_name: 'Bash',
      tool_input: '{}',
      requested_at: '2026-01-01T00:00:00Z',
    }
    // Assignment back to a `number` variable confirms the type.
    const n: number = info.request_id
    expect(typeof n).toBe('number')
    expect(n).toBe(Number.MAX_SAFE_INTEGER)
  })
})
