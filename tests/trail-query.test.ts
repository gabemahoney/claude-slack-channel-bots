/**
 * trail-query.test.ts — Unit tests for src/trail-query.ts. Exercises both
 * query shapes (SR-V-5.1 token, SR-V-5.2 channel+timerange), path
 * resolution via SLACK_STATE_DIR, tolerance to malformed lines, and
 * boundary semantics.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  queryByChannelTimerange,
  queryByToken,
  resolveTrailPathForQuery,
} from '../src/trail-query.ts'
import type { TrailEvent } from '../src/permission-trail.ts'

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

let tempDir: string
let origStateDir: string | undefined
let trailPath: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trail-query-test-'))
  origStateDir = process.env['SLACK_STATE_DIR']
  process.env['SLACK_STATE_DIR'] = tempDir
  trailPath = join(tempDir, 'permission-trail.jsonl')
})

afterEach(() => {
  if (origStateDir === undefined) delete process.env['SLACK_STATE_DIR']
  else process.env['SLACK_STATE_DIR'] = origStateDir
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fixture writers
// ---------------------------------------------------------------------------

function makeEvent(overrides?: Partial<TrailEvent>): TrailEvent {
  return {
    ts: '2026-06-04T20:00:00.000Z',
    event: 'cscb.test.fixture',
    ...overrides,
  } as TrailEvent
}

function writeLines(lines: string[]): void {
  writeFileSync(trailPath, lines.map(l => l + '\n').join(''))
}

function writeEvents(events: TrailEvent[]): void {
  writeLines(events.map(e => JSON.stringify(e)))
}

// ---------------------------------------------------------------------------
// queryByToken
// ---------------------------------------------------------------------------

describe('queryByToken', () => {
  test('returns only events matching the request_token, sorted by ts ascending', () => {
    writeEvents([
      makeEvent({ ts: '2026-06-04T20:00:00.100Z', request_token: 'A', event: 'cscb.first' }),
      makeEvent({ ts: '2026-06-04T20:00:00.200Z', request_token: 'B', event: 'cscb.unrelated' }),
      makeEvent({ ts: '2026-06-04T20:00:00.150Z', request_token: 'A', event: 'cscb.second' }),
      makeEvent({ ts: '2026-06-04T20:00:00.050Z', request_token: 'A', event: 'cscb.zeroth' }),
      makeEvent({ ts: '2026-06-04T20:00:00.075Z', event: 'cscb.no_token' }),
    ])

    const result = queryByToken('A')
    expect(result).toHaveLength(3)
    expect(result.map(e => e.event)).toEqual(['cscb.zeroth', 'cscb.first', 'cscb.second'])
    expect(result.every(e => e.request_token === 'A')).toBe(true)
  })

  test('returns empty array when no events match', () => {
    writeEvents([
      makeEvent({ request_token: 'A' }),
      makeEvent({ request_token: 'B' }),
    ])
    expect(queryByToken('Z')).toEqual([])
  })

  test('returns empty array when trail file does not exist', () => {
    // No file created in this test — beforeEach leaves the dir empty.
    expect(queryByToken('any')).toEqual([])
  })

  test('SLACK_STATE_DIR override is honored on every call', () => {
    writeEvents([makeEvent({ request_token: 'A', event: 'cscb.tmp_dir' })])
    expect(queryByToken('A')).toHaveLength(1)

    // Point env to an empty dir; should now read 0 events.
    const otherDir = mkdtempSync(join(tmpdir(), 'trail-query-test-empty-'))
    process.env['SLACK_STATE_DIR'] = otherDir
    expect(queryByToken('A')).toEqual([])
    rmSync(otherDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// queryByChannelTimerange
// ---------------------------------------------------------------------------

describe('queryByChannelTimerange', () => {
  test('returns only events for the channel within the inclusive window, sorted by ts', () => {
    writeEvents([
      makeEvent({ ts: '2026-06-04T20:00:00.200Z', channel: 'C1', event: 'cscb.in_window_late' }),
      makeEvent({ ts: '2026-06-04T19:59:59.999Z', channel: 'C1', event: 'cscb.before_window' }),
      makeEvent({ ts: '2026-06-04T20:00:00.100Z', channel: 'C2', event: 'cscb.wrong_channel' }),
      makeEvent({ ts: '2026-06-04T20:00:00.050Z', channel: 'C1', event: 'cscb.in_window_early' }),
      makeEvent({ ts: '2026-06-04T20:00:01.000Z', channel: 'C1', event: 'cscb.after_window' }),
    ])

    const result = queryByChannelTimerange(
      'C1',
      '2026-06-04T20:00:00.000Z',
      '2026-06-04T20:00:00.500Z',
    )
    expect(result.map(e => e.event)).toEqual(['cscb.in_window_early', 'cscb.in_window_late'])
  })

  test('inclusive boundaries: events at exactly since and until are included', () => {
    const since = '2026-06-04T20:00:00.000Z'
    const until = '2026-06-04T20:00:01.000Z'
    writeEvents([
      makeEvent({ ts: since, channel: 'C1', event: 'cscb.at_since' }),
      makeEvent({ ts: until, channel: 'C1', event: 'cscb.at_until' }),
    ])
    const result = queryByChannelTimerange('C1', since, until)
    expect(result.map(e => e.event)).toEqual(['cscb.at_since', 'cscb.at_until'])
  })

  test('returns empty array when no events match channel', () => {
    writeEvents([
      makeEvent({ ts: '2026-06-04T20:00:00.000Z', channel: 'C2' }),
    ])
    expect(queryByChannelTimerange('C1', '2026-06-04T00:00:00.000Z', '2026-06-04T23:59:59.999Z')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Tolerance to malformed input
// ---------------------------------------------------------------------------

describe('tolerance to malformed JSONL', () => {
  test('blank lines and unparseable lines are skipped without throwing', () => {
    writeLines([
      '',
      JSON.stringify(makeEvent({ request_token: 'A', event: 'cscb.first' })),
      'not_json_at_all',
      '',
      JSON.stringify(makeEvent({ request_token: 'A', event: 'cscb.second', ts: '2026-06-04T20:00:00.500Z' })),
      '{ partial json',
    ])
    const result = queryByToken('A')
    expect(result.map(e => e.event)).toEqual(['cscb.first', 'cscb.second'])
  })

  test('null and non-object JSON values are skipped (not returned)', () => {
    writeLines([
      'null',
      '42',
      '"a string"',
      JSON.stringify(makeEvent({ request_token: 'A', event: 'cscb.real' })),
    ])
    const result = queryByToken('A')
    expect(result).toHaveLength(1)
    expect(result[0]!.event).toBe('cscb.real')
  })
})

// ---------------------------------------------------------------------------
// resolveTrailPathForQuery
// ---------------------------------------------------------------------------

describe('resolveTrailPathForQuery', () => {
  test('honors SLACK_STATE_DIR', () => {
    expect(resolveTrailPathForQuery()).toBe(trailPath)
  })

  test('uses ~/.claude/channels/slack when SLACK_STATE_DIR is unset', () => {
    delete process.env['SLACK_STATE_DIR']
    const resolved = resolveTrailPathForQuery()
    expect(resolved.endsWith('/.claude/channels/slack/permission-trail.jsonl')).toBe(true)
  })
})
