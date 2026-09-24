/**
 * tokens.test.ts — Tests for isDryRun() dry-run detection (`SLACK_DRY_RUN`).
 *
 * The server reads no Slack token from the environment (b.av2 SR-3.1,
 * SR-10.2); `src/tokens.ts` now only answers whether dry-run mode is on.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { isDryRun } from '../src/tokens.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save and restore process.env around each test for isolation. */
let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  delete process.env['SLACK_DRY_RUN']
})

afterEach(() => {
  process.env = savedEnv as NodeJS.ProcessEnv
})

// ---------------------------------------------------------------------------
// isDryRun
// ---------------------------------------------------------------------------

describe('isDryRun — truthy values', () => {
  test.each(['1', 'true', 'yes', 'TRUE', 'YES', 'True'])('returns true for SLACK_DRY_RUN=%s', (val) => {
    process.env['SLACK_DRY_RUN'] = val

    expect(isDryRun()).toBe(true)
  })
})

describe('isDryRun — falsy values', () => {
  test('returns false when SLACK_DRY_RUN is "0"', () => {
    process.env['SLACK_DRY_RUN'] = '0'
    expect(isDryRun()).toBe(false)
  })

  test('returns false when SLACK_DRY_RUN is "false"', () => {
    process.env['SLACK_DRY_RUN'] = 'false'
    expect(isDryRun()).toBe(false)
  })

  test('returns false when SLACK_DRY_RUN is unset', () => {
    delete process.env['SLACK_DRY_RUN']
    expect(isDryRun()).toBe(false)
  })

  test('returns false when SLACK_DRY_RUN is empty string', () => {
    process.env['SLACK_DRY_RUN'] = ''
    expect(isDryRun()).toBe(false)
  })
})
