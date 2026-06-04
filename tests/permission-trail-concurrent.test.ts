/**
 * permission-trail-concurrent.test.ts — Multi-call-site interleaving for
 * src/permission-trail.ts. In production three CSCB call sites share one
 * writer in the same Node process: the permission poller, the click
 * handler, and the decide-call site. Each must produce a complete,
 * self-contained JSONL line — no partial writes, no interleaved bytes.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _resetTrailFdForTests, emitTrail } from '../src/permission-trail.ts'

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

let tempDir: string
let origStateDir: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'permission-trail-concurrent-test-'))
  origStateDir = process.env['SLACK_STATE_DIR']
  process.env['SLACK_STATE_DIR'] = tempDir
  _resetTrailFdForTests()
})

afterEach(() => {
  if (origStateDir === undefined) {
    delete process.env['SLACK_STATE_DIR']
  } else {
    process.env['SLACK_STATE_DIR'] = origStateDir
  }
  _resetTrailFdForTests()
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers / factories
// ---------------------------------------------------------------------------

function trailFile(): string {
  return join(tempDir, 'permission-trail.jsonl')
}

function readLines(): string[] {
  return readFileSync(trailFile(), 'utf-8').split('\n').filter(l => l.length > 0)
}

interface CallSiteEmission {
  callSite: string
  event: string
  claudeInstanceId: string
  requestToken: string
}

function emitForCallSite(c: CallSiteEmission): void {
  emitTrail({
    event: c.event,
    claude_instance_id: c.claudeInstanceId,
    request_token: c.requestToken,
    call_site: c.callSite,
  })
}

// ---------------------------------------------------------------------------
// Three production call sites
// ---------------------------------------------------------------------------

describe('permission-trail — concurrent emissions', () => {
  test('three call sites firing back-to-back produce three complete lines', () => {
    emitForCallSite({
      callSite: 'poller',
      event: 'cscb.chat_post.attempted',
      claudeInstanceId: 'cscb_a_C123',
      requestToken: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    })
    emitForCallSite({
      callSite: 'click_handler',
      event: 'cscb.click_handler.invoked',
      claudeInstanceId: 'cscb_b_C123',
      requestToken: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    })
    emitForCallSite({
      callSite: 'decide',
      event: 'cscb.decide.attempted',
      claudeInstanceId: 'cscb_c_C123',
      requestToken: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    })

    const lines = readLines()
    expect(lines).toHaveLength(3)
  })

  test('every line independently parses as a complete JSON object', () => {
    emitForCallSite({
      callSite: 'poller',
      event: 'cscb.chat_post.attempted',
      claudeInstanceId: 'cscb_a_C123',
      requestToken: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    })
    emitForCallSite({
      callSite: 'click_handler',
      event: 'cscb.click_handler.invoked',
      claudeInstanceId: 'cscb_b_C123',
      requestToken: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    })
    emitForCallSite({
      callSite: 'decide',
      event: 'cscb.decide.attempted',
      claudeInstanceId: 'cscb_c_C123',
      requestToken: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    })

    for (const line of readLines()) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  test('no line is missing ts or event after the volley', () => {
    emitForCallSite({
      callSite: 'poller',
      event: 'cscb.chat_post.attempted',
      claudeInstanceId: 'cscb_a_C123',
      requestToken: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    })
    emitForCallSite({
      callSite: 'click_handler',
      event: 'cscb.click_handler.invoked',
      claudeInstanceId: 'cscb_b_C123',
      requestToken: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    })
    emitForCallSite({
      callSite: 'decide',
      event: 'cscb.decide.attempted',
      claudeInstanceId: 'cscb_c_C123',
      requestToken: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    })

    for (const line of readLines()) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(typeof parsed['ts']).toBe('string')
      expect((parsed['ts'] as string).length).toBeGreaterThan(0)
      expect(typeof parsed['event']).toBe('string')
      expect((parsed['event'] as string).length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Volume + interleaving
// ---------------------------------------------------------------------------

describe('permission-trail — interleaved volume', () => {
  test('30 interleaved emits produce 30 self-contained lines with no truncation', () => {
    const callSites = ['poller', 'click_handler', 'decide']
    for (let i = 0; i < 30; i++) {
      const cs = callSites[i % callSites.length]!
      emitForCallSite({
        callSite: cs,
        event: `cscb.${cs}.tick`,
        claudeInstanceId: `cscb_x_C${i}`,
        requestToken: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      })
    }

    const lines = readLines()
    expect(lines).toHaveLength(30)
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(typeof parsed['call_site']).toBe('string')
      expect(typeof parsed['request_token']).toBe('string')
      expect(typeof parsed['claude_instance_id']).toBe('string')
    }
  })
})
