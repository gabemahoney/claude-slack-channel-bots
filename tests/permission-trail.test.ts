/**
 * permission-trail.test.ts — Single-emitter correctness tests for
 * src/permission-trail.ts. Covers schema serialization, RFC 3339 sub-second
 * `ts` formatting, append semantics, first-write directory creation, and
 * SLACK_STATE_DIR env override.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetTrailFdForTests,
  emitTrail,
  emitTrailEvent,
  type TrailEvent,
  type TrailEventBase,
} from '../src/permission-trail.ts'

type EmitTrailInput = Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown }

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

let tempDir: string
let origStateDir: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'permission-trail-test-'))
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
  const raw = readFileSync(trailFile(), 'utf-8')
  return raw.split('\n').filter(l => l.length > 0)
}

function readParsedLines(): Array<Record<string, unknown>> {
  return readLines().map(l => JSON.parse(l) as Record<string, unknown>)
}

function makeTrailEvent(overrides?: Partial<TrailEvent>): TrailEvent {
  return {
    ts: '2026-06-04T22:00:00.123Z',
    event: 'cscb.test.fixture',
    claude_instance_id: 'cscb_fixture_C123',
    ...overrides,
  }
}

function makeEmitTrailInput(overrides?: Partial<EmitTrailInput>): EmitTrailInput {
  return {
    event: 'cscb.test.autostamp',
    claude_instance_id: 'cscb_fixture_C123',
    ...overrides,
  }
}

// SR-V-4.3 / SR-V-4.5: ≥ millisecond fractional component on the ts field.
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,}Z$/

// ---------------------------------------------------------------------------
// schema serialization
// ---------------------------------------------------------------------------

describe('emitTrailEvent — schema serialization', () => {
  test('writes one JSON-parseable line', () => {
    emitTrailEvent(makeTrailEvent())
    const lines = readLines()
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0]!)).not.toThrow()
  })

  test('written line round-trips through JSON.parse with all envelope fields', () => {
    const ev = makeTrailEvent({
      request_token: '6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd',
      channel: 'C0B1ZJJLJ9M',
      message_ts: '1717536002.000100',
    })
    emitTrailEvent(ev)
    const parsed = readParsedLines()[0]!
    expect(parsed['event']).toBe('cscb.test.fixture')
    expect(parsed['claude_instance_id']).toBe('cscb_fixture_C123')
    expect(parsed['request_token']).toBe('6f3a1d2c-aaaa-bbbb-cccc-dddddddddddd')
    expect(parsed['channel']).toBe('C0B1ZJJLJ9M')
    expect(parsed['message_ts']).toBe('1717536002.000100')
  })

  test('per-event-class fields pass through verbatim with no truncation', () => {
    // Long blocks payload mirrors what SR-V-2.4 (Epic 2) will emit.
    const bigBlocks = Array.from({ length: 50 }, (_, i) => ({
      type: 'section',
      block_id: `b${i}`,
      text: { type: 'mrkdwn', text: 'x'.repeat(500) },
    }))
    emitTrailEvent(
      makeTrailEvent({
        event: 'cscb.chat_post.attempted',
        text: 'permission prompt',
        blocks: bigBlocks,
      }),
    )
    const parsed = readParsedLines()[0]!
    expect(Array.isArray(parsed['blocks'])).toBe(true)
    expect((parsed['blocks'] as unknown[]).length).toBe(50)
    const section = (parsed['blocks'] as Array<{ text: { text: string } }>)[0]!
    expect(section.text.text.length).toBe(500)
    expect(parsed['text']).toBe('permission prompt')
  })
})

// ---------------------------------------------------------------------------
// RFC 3339 sub-second timestamp
// ---------------------------------------------------------------------------

describe('emitTrail — ts auto-stamping', () => {
  test('emitTrail stamps ts in RFC 3339 with ≥ ms precision', () => {
    emitTrail(makeEmitTrailInput())
    const parsed = readParsedLines()[0]!
    const ts = parsed['ts']
    expect(typeof ts).toBe('string')
    expect(ISO_MS_RE.test(ts as string)).toBe(true)
  })

  test('emitTrail stamped ts round-trips through Date without NaN', () => {
    emitTrail(makeEmitTrailInput())
    const parsed = readParsedLines()[0]!
    const t = new Date(parsed['ts'] as string).getTime()
    expect(isNaN(t)).toBe(false)
  })

  test('caller-supplied valid ts is preserved by emitTrailEvent', () => {
    const fixed = '2026-06-04T22:30:00.456Z'
    emitTrailEvent(makeTrailEvent({ ts: fixed }))
    const parsed = readParsedLines()[0]!
    expect(parsed['ts']).toBe(fixed)
  })

  test('missing ts on emitTrailEvent is substituted with auto-stamp', () => {
    // Force the defensive guard: cast through unknown to bypass the type
    // requirement, mirroring how a buggy caller would land here at runtime.
    emitTrailEvent({
      event: 'cscb.test.no_ts',
      claude_instance_id: 'cscb_fixture_C123',
    } as unknown as TrailEvent)
    const parsed = readParsedLines()[0]!
    expect(typeof parsed['ts']).toBe('string')
    expect(ISO_MS_RE.test(parsed['ts'] as string)).toBe(true)
  })

  test('empty-string ts is substituted with auto-stamp', () => {
    emitTrailEvent(makeTrailEvent({ ts: '   ' }))
    const parsed = readParsedLines()[0]!
    expect(ISO_MS_RE.test(parsed['ts'] as string)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Append semantics
// ---------------------------------------------------------------------------

describe('emitTrail — append semantics', () => {
  test('three calls produce three independently-parseable lines', () => {
    emitTrail(makeEmitTrailInput({ event: 'cscb.a' }))
    emitTrail(makeEmitTrailInput({ event: 'cscb.b' }))
    emitTrail(makeEmitTrailInput({ event: 'cscb.c' }))
    const lines = readLines()
    expect(lines).toHaveLength(3)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  test('lines are written in call order', () => {
    emitTrail(makeEmitTrailInput({ event: 'cscb.first' }))
    emitTrail(makeEmitTrailInput({ event: 'cscb.second' }))
    const parsed = readParsedLines()
    expect(parsed[0]!['event']).toBe('cscb.first')
    expect(parsed[1]!['event']).toBe('cscb.second')
  })
})

// ---------------------------------------------------------------------------
// File / directory creation
// ---------------------------------------------------------------------------

describe('emitTrail — file & directory creation', () => {
  test('creates the file on first emit when absent', () => {
    expect(existsSync(trailFile())).toBe(false)
    emitTrail(makeEmitTrailInput())
    expect(existsSync(trailFile())).toBe(true)
  })

  test('creates a missing parent directory recursively', () => {
    const nested = join(tempDir, 'deeper', 'nest')
    process.env['SLACK_STATE_DIR'] = nested
    _resetTrailFdForTests()

    expect(existsSync(nested)).toBe(false)
    emitTrail(makeEmitTrailInput({ event: 'cscb.nested' }))
    expect(existsSync(join(nested, 'permission-trail.jsonl'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SLACK_STATE_DIR env override
// ---------------------------------------------------------------------------

describe('emitTrail — SLACK_STATE_DIR override', () => {
  test('writes land under SLACK_STATE_DIR, not the canonical homedir path', () => {
    emitTrail(makeEmitTrailInput())
    // File exists under the override.
    expect(existsSync(trailFile())).toBe(true)
    // And the per-test temp dir is what was honored — not the homedir default.
    expect(trailFile().startsWith(tempDir)).toBe(true)
  })
})
