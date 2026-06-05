/**
 * cli-trail.test.ts — Tests for the `cscb trail` CLI subcommand
 * (src/trail-cli.ts). Drives the parser + dispatcher directly so stdout /
 * stderr / exit code are deterministic and capturable without spawning
 * subprocesses.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runTrailCli, type TrailCliIo } from '../src/trail-cli.ts'
import type { TrailEvent } from '../src/permission-trail.ts'

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

let tempDir: string
let origStateDir: string | undefined
let trailPath: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cli-trail-test-'))
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
// Helpers
// ---------------------------------------------------------------------------

function makeIo(): { io: TrailCliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    },
    out,
    err,
  }
}

function makeEvent(overrides?: Partial<TrailEvent>): TrailEvent {
  return {
    ts: '2026-06-04T20:00:00.000Z',
    event: 'cscb.test.fixture',
    ...overrides,
  } as TrailEvent
}

function seedTrail(events: TrailEvent[]): void {
  writeFileSync(trailPath, events.map(e => JSON.stringify(e) + '\n').join(''))
}

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

describe('runTrailCli — --help', () => {
  test('--help prints usage covering both query shapes and exits 0', () => {
    const { io, out } = makeIo()
    const code = runTrailCli(['--help'], io)
    expect(code).toBe(0)
    const blob = out.join('\n')
    expect(blob.includes('--token')).toBe(true)
    expect(blob.includes('--channel')).toBe(true)
    expect(blob.includes('--since')).toBe(true)
    expect(blob.includes('--until')).toBe(true)
  })

  test('--help includes the trail file path', () => {
    const { io, out } = makeIo()
    runTrailCli(['--help'], io)
    expect(out.some(l => l.includes(trailPath))).toBe(true)
  })

  test('no flags also prints usage (zero-arg discoverability) and exits 0', () => {
    const { io, out } = makeIo()
    const code = runTrailCli([], io)
    expect(code).toBe(0)
    expect(out.some(l => l.includes('--token'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// --token
// ---------------------------------------------------------------------------

describe('runTrailCli — --token', () => {
  test('happy path: prints matching events as JSONL in ts order, exit 0', () => {
    seedTrail([
      makeEvent({ ts: '2026-06-04T20:00:00.200Z', request_token: 'A', event: 'cscb.second' }),
      makeEvent({ ts: '2026-06-04T20:00:00.100Z', request_token: 'A', event: 'cscb.first' }),
      makeEvent({ ts: '2026-06-04T20:00:00.150Z', request_token: 'B', event: 'cscb.unrelated' }),
    ])
    const { io, out, err } = makeIo()
    const code = runTrailCli(['--token', 'A'], io)
    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(out).toHaveLength(2)
    const parsed = out.map(l => JSON.parse(l) as TrailEvent)
    expect(parsed.map(e => e.event)).toEqual(['cscb.first', 'cscb.second'])
  })

  test('empty result: zero stdout lines, exit 0', () => {
    seedTrail([makeEvent({ request_token: 'A' })])
    const { io, out, err } = makeIo()
    const code = runTrailCli(['--token', 'NO_MATCH'], io)
    expect(code).toBe(0)
    expect(out).toEqual([])
    expect(err).toEqual([])
  })

  test('empty --token value is rejected with non-zero exit and stderr', () => {
    const { io, err } = makeIo()
    const code = runTrailCli(['--token', ''], io)
    expect(code).toBe(1)
    expect(err.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// --channel
// ---------------------------------------------------------------------------

describe('runTrailCli — --channel/--since/--until', () => {
  test('happy path: window-filtered events sorted ts-asc, exit 0', () => {
    seedTrail([
      makeEvent({ ts: '2026-06-04T20:00:00.500Z', channel: 'C1', event: 'cscb.in_late' }),
      makeEvent({ ts: '2026-06-04T20:00:00.200Z', channel: 'C2', event: 'cscb.wrong_channel' }),
      makeEvent({ ts: '2026-06-04T20:00:00.100Z', channel: 'C1', event: 'cscb.in_early' }),
      makeEvent({ ts: '2026-06-04T20:00:02.000Z', channel: 'C1', event: 'cscb.after_window' }),
    ])
    const { io, out, err } = makeIo()
    const code = runTrailCli(
      ['--channel', 'C1', '--since', '2026-06-04T20:00:00.000Z', '--until', '2026-06-04T20:00:01.000Z'],
      io,
    )
    expect(code).toBe(0)
    expect(err).toEqual([])
    const parsed = out.map(l => JSON.parse(l) as TrailEvent)
    expect(parsed.map(e => e.event)).toEqual(['cscb.in_early', 'cscb.in_late'])
  })

  test('missing --since rejects with non-zero exit and stderr', () => {
    const { io, err } = makeIo()
    const code = runTrailCli(['--channel', 'C1', '--until', '2026-06-04T20:00:01.000Z'], io)
    expect(code).toBe(1)
    expect(err.some(l => l.includes('--since'))).toBe(true)
  })

  test('missing --until rejects with non-zero exit and stderr', () => {
    const { io, err } = makeIo()
    const code = runTrailCli(['--channel', 'C1', '--since', '2026-06-04T20:00:00.000Z'], io)
    expect(code).toBe(1)
    expect(err.some(l => l.includes('--until'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Conflicting / missing flags
// ---------------------------------------------------------------------------

describe('runTrailCli — flag validation', () => {
  test('--token and --channel together rejects with non-zero exit', () => {
    const { io, err } = makeIo()
    const code = runTrailCli(['--token', 'A', '--channel', 'C1'], io)
    expect(code).toBe(1)
    expect(err.some(l => l.toLowerCase().includes('mutually exclusive'))).toBe(true)
  })

  test('unrecognized mode (e.g. --bogus) falls through to "must specify either --token or --channel"', () => {
    const { io, err } = makeIo()
    const code = runTrailCli(['--bogus'], io)
    expect(code).toBe(1)
    expect(err.some(l => l.includes('--token') && l.includes('--channel'))).toBe(true)
  })
})
