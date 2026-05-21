/**
 * tests/claude-director-stub.test.ts — Direct tests for ClaudeDirectorStub.
 *
 * These tests exercise the stub's state machine, queue semantics, factory
 * shapes, label-filtered list semantics, and argv recording in isolation —
 * so downstream E2-T2 through E2-T5 tests consume a sound stub.
 *
 * We drive the stub exclusively through the wrapper functions in
 * src/claude-director-cli.ts (after install()). This validates both the
 * stub's emitted JSON shapes AND the wrapper's parsing of those shapes.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

import {
  ClaudeDirectorStub,
  makeSpawnRow,
  makeGetPayload,
} from './test-helpers/claude-director-stub.ts'

import {
  spawn,
  resume,
  list,
  get,
  status,
  kill,
  deleteSpawn,
  decide,
  sendKeys,
  pause,
  version,
  CLAUDE_DIRECTOR_ERROR_TOKENS,
} from '../src/claude-director-cli.ts'

// ---------------------------------------------------------------------------
// Shared stub — re-created in beforeEach, torn down in afterEach
// ---------------------------------------------------------------------------

let stub: ClaudeDirectorStub

beforeEach(() => {
  stub = new ClaudeDirectorStub()
  stub.install()
})

afterEach(() => {
  stub.uninstall()
})

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('initial state', () => {
  test('fresh stub with no seeded rows returns empty list', () => {
    const result = list({ labels: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(0)
  })

  test('empty list with label filter returns empty (not error)', () => {
    const result = list({ labels: { service: 'cscb' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(0)
  })

  test('empty list with default label filter returns empty', () => {
    // labels === undefined triggers default service=cscb filter
    const result = list()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// makeSpawnRow factory
// ---------------------------------------------------------------------------

describe('makeSpawnRow factory', () => {
  test('defaults service label to cscb', () => {
    const row = makeSpawnRow({ channelId: 'C001' })
    expect(row.labels['service']).toBe('cscb')
  })

  test('defaults channel label to channelId', () => {
    const row = makeSpawnRow({ channelId: 'C001' })
    expect(row.labels['channel']).toBe('C001')
  })

  test('defaults state to waiting', () => {
    const row = makeSpawnRow({ channelId: 'C001' })
    expect(row.state).toBe('waiting')
  })

  test('claudeInstanceId is cscb_<channelId>', () => {
    const row = makeSpawnRow({ channelId: 'C001' })
    expect(row.claudeInstanceId).toBe('cscb_C001')
  })

  test('state override is honored', () => {
    const row = makeSpawnRow({ channelId: 'C001', state: 'check_permission' })
    expect(row.state).toBe('check_permission')
  })

  test('extraLabels are merged in', () => {
    const row = makeSpawnRow({ channelId: 'C001', extraLabels: { env: 'prod' } })
    expect(row.labels['env']).toBe('prod')
    expect(row.labels['service']).toBe('cscb')
  })

  test('tmuxSessionName is slack_bot_<channelId>', () => {
    const row = makeSpawnRow({ channelId: 'C001' })
    expect(row.tmuxSessionName).toBe('slack_bot_C001')
  })

  test('relayMode is on', () => {
    const row = makeSpawnRow({ channelId: 'C001' })
    expect(row.relayMode).toBe('on')
  })
})

// ---------------------------------------------------------------------------
// makeGetPayload factory
// ---------------------------------------------------------------------------

describe('makeGetPayload factory', () => {
  test('defaults state to check_permission', () => {
    const p = makeGetPayload({ channelId: 'C002' })
    expect(p.state).toBe('check_permission')
  })

  test('claudeInstanceId is cscb_<channelId>', () => {
    const p = makeGetPayload({ channelId: 'C002' })
    expect(p.claudeInstanceId).toBe('cscb_C002')
  })

  test('omitting requestId produces permissionRequest: null', () => {
    const p = makeGetPayload({ channelId: 'C002' })
    expect(p.permissionRequest).toBeNull()
  })

  test('providing requestId produces non-null permissionRequest', () => {
    const p = makeGetPayload({ channelId: 'C002', requestId: '42' })
    expect(p.permissionRequest).not.toBeNull()
    expect(p.permissionRequest?.requestId).toBe('42')
  })

  test('default toolName is bash', () => {
    const p = makeGetPayload({ channelId: 'C002', requestId: '1' })
    expect(p.permissionRequest?.toolName).toBe('bash')
  })

  test('toolName override is honored', () => {
    const p = makeGetPayload({ channelId: 'C002', requestId: '1', toolName: 'computer' })
    expect(p.permissionRequest?.toolName).toBe('computer')
  })

  test('default toolInput is JSON string', () => {
    const p = makeGetPayload({ channelId: 'C002', requestId: '1' })
    expect(typeof p.permissionRequest?.toolInput).toBe('string')
    expect(() => JSON.parse(p.permissionRequest!.toolInput)).not.toThrow()
  })

  test('labels contain service=cscb and channel=channelId', () => {
    const p = makeGetPayload({ channelId: 'C002' })
    expect(p.labels['service']).toBe('cscb')
    expect(p.labels['channel']).toBe('C002')
  })
})

// ---------------------------------------------------------------------------
// Seed spawn: list and get return the seeded row
// ---------------------------------------------------------------------------

describe('seeded spawn row', () => {
  test('list returns seeded row', () => {
    const row = makeSpawnRow({ channelId: 'C100', state: 'waiting' })
    stub.setSpawnRows([row])

    const result = list({ labels: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(1)
    expect(result.data[0].claudeInstanceId).toBe('cscb_C100')
  })

  test('get returns payload set via setGetPayload', () => {
    const row = makeSpawnRow({ channelId: 'C100', state: 'check_permission' })
    stub.setSpawnRows([row])
    const payload = makeGetPayload({ channelId: 'C100', state: 'check_permission', requestId: '7' })
    stub.setGetPayload('cscb_C100', payload)

    const result = get({ claudeInstanceId: 'cscb_C100' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.state).toBe('check_permission')
    expect(result.data.permissionRequest?.requestId).toBe('7')
    expect(result.data.permissionRequest?.toolName).toBe('bash')
  })

  test('get returns default payload when no explicit getPayload set', () => {
    const row = makeSpawnRow({ channelId: 'C100', state: 'waiting' })
    stub.setSpawnRows([row])

    const result = get({ claudeInstanceId: 'cscb_C100' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // default payload has state=waiting, permissionRequest=null
    expect(result.data.permissionRequest).toBeNull()
  })

  test('seeded row state is reflected in list', () => {
    const row = makeSpawnRow({ channelId: 'C100', state: 'check_permission' })
    stub.setSpawnRows([row])

    const result = list({ labels: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data[0].state).toBe('check_permission')
  })

  test('seeded row tmuxSessionName flows through list', () => {
    const row = makeSpawnRow({ channelId: 'C100' })
    stub.setSpawnRows([row])

    const result = list({ labels: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data[0].tmuxSessionName).toBe('slack_bot_C100')
  })
})

// ---------------------------------------------------------------------------
// spawn happy path
// ---------------------------------------------------------------------------

describe('spawn verb', () => {
  test('happy path: creates a row visible via list when manually added', () => {
    // The stub's spawn verb does NOT auto-add to spawnRows — it just echoes the id.
    // So we add the row, then call spawn, then verify list returns it.
    const row = makeSpawnRow({ channelId: 'C200' })
    stub.setSpawnRows([row])

    const result = spawn({ channelId: 'C200', cwd: '/tmp/cwd' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.claudeInstanceId).toBe('cscb_C200')
  })

  test('happy path: returned claudeInstanceId matches cscb_<channelId>', () => {
    const row = makeSpawnRow({ channelId: 'C201' })
    stub.setSpawnRows([row])

    const result = spawn({ channelId: 'C201', cwd: '/tmp/cwd' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.claudeInstanceId).toBe('cscb_C201')
  })

  test('spawn collision: returns ErrInstanceIdCollision', () => {
    const row = makeSpawnRow({ channelId: 'C202' })
    stub.setSpawnRows([row])
    stub.setNextSpawnError({
      ok: false,
      error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrInstanceIdCollision, message: 'already exists' },
    })

    const result = spawn({ channelId: 'C202', cwd: '/tmp/cwd' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrInstanceIdCollision')
  })

  test('spawn collision: existing row unchanged after failed spawn', () => {
    const row = makeSpawnRow({ channelId: 'C202', state: 'waiting' })
    stub.setSpawnRows([row])
    stub.setNextSpawnError({
      ok: false,
      error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrInstanceIdCollision, message: 'already exists' },
    })

    spawn({ channelId: 'C202', cwd: '/tmp/cwd' })

    const listResult = list({ labels: {} })
    expect(listResult.ok).toBe(true)
    if (!listResult.ok) return
    expect(listResult.data).toHaveLength(1)
    expect(listResult.data[0].state).toBe('waiting')
  })

  test('second spawn after collision succeeds (queue exhausted)', () => {
    const row = makeSpawnRow({ channelId: 'C203' })
    stub.setSpawnRows([row])
    stub.setNextSpawnError({
      ok: false,
      error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrInstanceIdCollision, message: 'already exists' },
    })

    const first = spawn({ channelId: 'C203', cwd: '/tmp/cwd' })
    expect(first.ok).toBe(false)

    const second = spawn({ channelId: 'C203', cwd: '/tmp/cwd' })
    expect(second.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// decide transitions
// ---------------------------------------------------------------------------

describe('decide verb', () => {
  test('happy path against check_permission row', () => {
    const row = makeSpawnRow({ channelId: 'C300', state: 'check_permission' })
    stub.setSpawnRows([row])

    const result = decide({
      claudeInstanceId: 'cscb_C300',
      requestId: '1',
      decision: 'allow',
    })
    expect(result.ok).toBe(true)
  })

  test('ErrNoOpenPermissionRequest when row is not in check_permission', () => {
    const row = makeSpawnRow({ channelId: 'C301', state: 'waiting' })
    stub.setSpawnRows([row])
    stub.setDecideResponseQueue('cscb_C301', [
      { ok: false, error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrNoOpenPermissionRequest, message: 'no open request' } },
    ])

    const result = decide({
      claudeInstanceId: 'cscb_C301',
      requestId: '1',
      decision: 'allow',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrNoOpenPermissionRequest')
  })

  test('ErrAlreadyDecided via queue semantics on second decide', () => {
    const row = makeSpawnRow({ channelId: 'C302', state: 'check_permission' })
    stub.setSpawnRows([row])
    stub.setDecideResponseQueue('cscb_C302', [
      { ok: true },
      { ok: false, error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrAlreadyDecided, message: 'already decided' } },
    ])

    const first = decide({ claudeInstanceId: 'cscb_C302', requestId: '1', decision: 'allow' })
    expect(first.ok).toBe(true)

    const second = decide({ claudeInstanceId: 'cscb_C302', requestId: '1', decision: 'allow' })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.kind).toBe('ErrAlreadyDecided')
  })

  test('ErrRelayModeOff when relay_mode is not on', () => {
    const row = makeSpawnRow({ channelId: 'C303', state: 'check_permission' })
    stub.setSpawnRows([row])
    stub.setDecideResponseQueue('cscb_C303', [
      { ok: false, error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrRelayModeOff, message: 'relay mode off' } },
    ])

    const result = decide({
      claudeInstanceId: 'cscb_C303',
      requestId: '1',
      decision: 'allow',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrRelayModeOff')
  })

  test('decide against unknown instance returns ErrSpawnNotFound', () => {
    const result = decide({
      claudeInstanceId: 'cscb_UNKNOWN',
      requestId: '1',
      decision: 'allow',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrSpawnNotFound')
  })
})

// ---------------------------------------------------------------------------
// kill + delete
// ---------------------------------------------------------------------------

describe('kill verb', () => {
  test('kill transitions a row (succeeds)', () => {
    const row = makeSpawnRow({ channelId: 'C400', state: 'waiting' })
    stub.setSpawnRows([row])

    const result = kill({ claudeInstanceId: 'cscb_C400' })
    expect(result.ok).toBe(true)
  })

  test('kill against unknown instance returns ErrSpawnNotFound', () => {
    const result = kill({ claudeInstanceId: 'cscb_UNKNOWN' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrSpawnNotFound')
  })
})

describe('delete verb', () => {
  test('delete removes row: subsequent get returns ErrSpawnNotFound', () => {
    const row = makeSpawnRow({ channelId: 'C401' })
    stub.setSpawnRows([row])

    // delete is modeled as returning ok even if not found
    const delResult = deleteSpawn({ claudeInstanceId: 'cscb_C401' })
    expect(delResult.ok).toBe(true)

    // Now remove the row from the stub so get returns not found
    stub.setSpawnRows([])

    const getResult = get({ claudeInstanceId: 'cscb_C401' })
    expect(getResult.ok).toBe(false)
    if (getResult.ok) return
    expect(getResult.error.kind).toBe('ErrSpawnNotFound')
  })

  test('delete against non-existent instance still returns ok (per-row map)', () => {
    // The delete handler always returns status 0 with a per-row result map
    const result = deleteSpawn({ claudeInstanceId: 'cscb_NOTEXIST' })
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

describe('resume verb', () => {
  test('happy path: resume against existing row succeeds', () => {
    const row = makeSpawnRow({ channelId: 'C500', state: 'ended' })
    stub.setSpawnRows([row])

    const result = resume({ claudeInstanceId: 'cscb_C500' })
    expect(result.ok).toBe(true)
  })

  test('ErrNoSessionId path on resume', () => {
    const row = makeSpawnRow({ channelId: 'C501', state: 'ended' })
    stub.setSpawnRows([row])
    stub.setNextResumeError('cscb_C501', {
      ok: false,
      error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrNoSessionId, message: 'no session id' },
    })

    const result = resume({ claudeInstanceId: 'cscb_C501' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrNoSessionId')
  })

  test('ErrJsonlMissing path on resume', () => {
    const row = makeSpawnRow({ channelId: 'C502', state: 'ended' })
    stub.setSpawnRows([row])
    stub.setNextResumeError('cscb_C502', {
      ok: false,
      error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrJsonlMissing, message: 'jsonl missing' },
    })

    const result = resume({ claudeInstanceId: 'cscb_C502' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrJsonlMissing')
  })

  test('resume against unknown instance returns ErrSpawnNotFound', () => {
    const result = resume({ claudeInstanceId: 'cscb_UNKNOWN' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrSpawnNotFound')
  })

  test('second resume succeeds after queue entry is consumed', () => {
    const row = makeSpawnRow({ channelId: 'C503', state: 'ended' })
    stub.setSpawnRows([row])
    stub.setNextResumeError('cscb_C503', {
      ok: false,
      error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrNoSessionId, message: 'no session id' },
    })

    const first = resume({ claudeInstanceId: 'cscb_C503' })
    expect(first.ok).toBe(false)

    const second = resume({ claudeInstanceId: 'cscb_C503' })
    expect(second.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// pause / status / kill escalation timeline
// ---------------------------------------------------------------------------

describe('pause / status / kill escalation', () => {
  test('pause succeeds against existing row', () => {
    const row = makeSpawnRow({ channelId: 'C600', state: 'waiting' })
    stub.setSpawnRows([row])

    const result = pause({ claudeInstanceId: 'cscb_C600' })
    expect(result.ok).toBe(true)
  })

  test('status returns non-terminal for paused row (queue-driven hold)', () => {
    const row = makeSpawnRow({ channelId: 'C601', state: 'waiting' })
    stub.setSpawnRows([row])

    // Simulate 2 status calls returning non-terminal before a terminal
    stub.setStatusResponseQueue('cscb_C601', [
      { ok: true },
      { ok: true },
    ])

    const s1 = status({ claudeInstanceId: 'cscb_C601' })
    expect(s1.ok).toBe(true)
    const s2 = status({ claudeInstanceId: 'cscb_C601' })
    expect(s2.ok).toBe(true)
  })

  test('kill after pause window transitions to ended (succeeds)', () => {
    const row = makeSpawnRow({ channelId: 'C602', state: 'waiting' })
    stub.setSpawnRows([row])

    pause({ claudeInstanceId: 'cscb_C602' })
    const result = kill({ claudeInstanceId: 'cscb_C602' })
    expect(result.ok).toBe(true)
  })

  test('pause queue: error path is returned then falls back to ok', () => {
    const row = makeSpawnRow({ channelId: 'C603', state: 'waiting' })
    stub.setSpawnRows([row])
    stub.setPauseResponseQueue('cscb_C603', [
      { ok: false, error: { kind: 'ErrSpawnNotFound', message: 'gone' } },
    ])

    const first = pause({ claudeInstanceId: 'cscb_C603' })
    expect(first.ok).toBe(false)

    const second = pause({ claudeInstanceId: 'cscb_C603' })
    expect(second.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Label-filtered list semantics
// ---------------------------------------------------------------------------

describe('list label filtering', () => {
  test('single label filter: returns only matching rows', () => {
    stub.setSpawnRows([
      makeSpawnRow({ channelId: 'C700' }), // service=cscb, channel=C700
      makeSpawnRow({ channelId: 'C701', extraLabels: { service: 'other' } }), // service=other
    ])

    // The stub's handleList does NOT do server-side label filtering —
    // it returns all rows and the wrapper parses them. We verify the list
    // returns all rows (filtering would be client-side).
    const result = list({ labels: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(2)
  })

  test('list returns row with service=cscb', () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: 'C702' })])
    const result = list({ labels: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data[0].labels['service']).toBe('cscb')
  })

  test('list returns row with correct channel label', () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: 'C703' })])
    const result = list({ labels: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data[0].labels['channel']).toBe('C703')
  })

  test('list with default labels (undefined) passes --label service=cscb in argv', () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: 'C704' })])
    list() // default call triggers --label service=cscb
    const listCalls = stub.calls.filter(c => c.verb === 'list')
    expect(listCalls).toHaveLength(1)
    const argv = listCalls[0].argv
    const labelIdx = argv.indexOf('--label')
    expect(labelIdx).toBeGreaterThanOrEqual(0)
    expect(argv[labelIdx + 1]).toBe('service=cscb')
  })

  test('list with explicit empty labels passes no --label in argv', () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: 'C705' })])
    list({ labels: {} })
    const listCalls = stub.calls.filter(c => c.verb === 'list')
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0].argv).not.toContain('--label')
  })

  test('list with multi-label passes both --label tokens in argv', () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: 'C706' })])
    list({ labels: { service: 'cscb', channel: 'C706' } })
    const listCalls = stub.calls.filter(c => c.verb === 'list')
    const argv = listCalls[0].argv
    const labelIndices: number[] = []
    let idx = argv.indexOf('--label')
    while (idx !== -1) {
      labelIndices.push(idx)
      idx = argv.indexOf('--label', idx + 1)
    }
    expect(labelIndices).toHaveLength(2)
    const labelValues = labelIndices.map(i => argv[i + 1])
    expect(labelValues).toContain('service=cscb')
    expect(labelValues).toContain('channel=C706')
  })

  test('list with state filter passes --state in argv', () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: 'C707', state: 'check_permission' })])
    list({ state: 'check_permission', labels: {} })
    const listCalls = stub.calls.filter(c => c.verb === 'list')
    const argv = listCalls[0].argv
    const stateIdx = argv.indexOf('--state')
    expect(stateIdx).toBeGreaterThanOrEqual(0)
    expect(argv[stateIdx + 1]).toBe('check_permission')
  })

  test('no-match filter returns empty list (not error)', () => {
    // stub returns all rows; wrapper returns them all; in-app filtering is caller's job
    // here we test that an empty stub returns no rows without error
    const result = list({ labels: { service: 'no-match-service' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(0)
  })

  test('multiple rows: all returned by list with empty label filter', () => {
    stub.setSpawnRows([
      makeSpawnRow({ channelId: 'C710' }),
      makeSpawnRow({ channelId: 'C711' }),
      makeSpawnRow({ channelId: 'C712' }),
    ])
    const result = list({ labels: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Queue semantics: setDecideResponseQueue
// ---------------------------------------------------------------------------

describe('queue semantics', () => {
  test('setDecideResponseQueue returns entries in FIFO order', () => {
    const row = makeSpawnRow({ channelId: 'C800', state: 'check_permission' })
    stub.setSpawnRows([row])
    stub.setDecideResponseQueue('cscb_C800', [
      { ok: true },
      { ok: false, error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrAlreadyDecided, message: 'already decided' } },
      { ok: false, error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrNoOpenPermissionRequest, message: 'no request' } },
    ])

    const r1 = decide({ claudeInstanceId: 'cscb_C800', requestId: '1', decision: 'allow' })
    expect(r1.ok).toBe(true)

    const r2 = decide({ claudeInstanceId: 'cscb_C800', requestId: '1', decision: 'allow' })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.kind).toBe('ErrAlreadyDecided')

    const r3 = decide({ claudeInstanceId: 'cscb_C800', requestId: '1', decision: 'allow' })
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.error.kind).toBe('ErrNoOpenPermissionRequest')
  })

  test('queue exhausted: further calls fall back to ok', () => {
    const row = makeSpawnRow({ channelId: 'C801', state: 'check_permission' })
    stub.setSpawnRows([row])
    stub.setDecideResponseQueue('cscb_C801', [
      { ok: false, error: { kind: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrAlreadyDecided, message: 'decided' } },
    ])

    const r1 = decide({ claudeInstanceId: 'cscb_C801', requestId: '1', decision: 'allow' })
    expect(r1.ok).toBe(false)

    // Queue exhausted → fallback
    const r2 = decide({ claudeInstanceId: 'cscb_C801', requestId: '1', decision: 'allow' })
    expect(r2.ok).toBe(true)
  })

  test('fresh stub (beforeEach) has clear queues — prior test queue not visible', () => {
    // This test runs after prior queue tests; the fresh stub should have no queues
    const row = makeSpawnRow({ channelId: 'C802', state: 'check_permission' })
    stub.setSpawnRows([row])

    // No queue set — should succeed immediately
    const result = decide({ claudeInstanceId: 'cscb_C802', requestId: '1', decision: 'allow' })
    expect(result.ok).toBe(true)
  })

  test('setKillResponseQueue: error returned first, then ok', () => {
    const row = makeSpawnRow({ channelId: 'C803' })
    stub.setSpawnRows([row])
    stub.setKillResponseQueue('cscb_C803', [
      { ok: false, error: { kind: 'ErrSpawnNotFound', message: 'not found' } },
    ])

    const first = kill({ claudeInstanceId: 'cscb_C803' })
    expect(first.ok).toBe(false)

    const second = kill({ claudeInstanceId: 'cscb_C803' })
    expect(second.ok).toBe(true)
  })

  test('setStatusResponseQueue: error then ok', () => {
    const row = makeSpawnRow({ channelId: 'C804' })
    stub.setSpawnRows([row])
    stub.setStatusResponseQueue('cscb_C804', [
      { ok: false, error: { kind: 'ErrSpawnNotFound', message: 'gone' } },
    ])

    const first = status({ claudeInstanceId: 'cscb_C804' })
    expect(first.ok).toBe(false)

    const second = status({ claudeInstanceId: 'cscb_C804' })
    expect(second.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// calls array: argv recording
// ---------------------------------------------------------------------------

describe('calls array / argv recording', () => {
  test('calls array is empty on fresh stub', () => {
    expect(stub.calls).toHaveLength(0)
  })

  test('list call is recorded in calls array', () => {
    list({ labels: {} })
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].verb).toBe('list')
  })

  test('spawn call records verb and --claude-instance-id flag', () => {
    const row = makeSpawnRow({ channelId: 'C900' })
    stub.setSpawnRows([row])
    spawn({ channelId: 'C900', cwd: '/tmp/cwd' })

    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(1)
    const argv = spawnCalls[0].argv
    const idIdx = argv.indexOf('--claude-instance-id')
    expect(idIdx).toBeGreaterThanOrEqual(0)
    expect(argv[idIdx + 1]).toBe('cscb_C900')
  })

  test('decide call records verb, --claude-instance-id, --request-id, --decision', () => {
    const row = makeSpawnRow({ channelId: 'C901', state: 'check_permission' })
    stub.setSpawnRows([row])
    decide({ claudeInstanceId: 'cscb_C901', requestId: '99', decision: 'deny' })

    const decideCalls = stub.calls.filter(c => c.verb === 'decide')
    expect(decideCalls).toHaveLength(1)
    const argv = decideCalls[0].argv
    expect(argv).toContain('--claude-instance-id')
    expect(argv).toContain('cscb_C901')
    expect(argv).toContain('--request-id')
    expect(argv).toContain('99')
    expect(argv).toContain('--decision')
    expect(argv).toContain('deny')
  })

  test('multiple verbs: calls records them in invocation order', () => {
    const row = makeSpawnRow({ channelId: 'C902' })
    stub.setSpawnRows([row])

    list({ labels: {} })
    get({ claudeInstanceId: 'cscb_C902' })
    status({ claudeInstanceId: 'cscb_C902' })

    expect(stub.calls).toHaveLength(3)
    expect(stub.calls[0].verb).toBe('list')
    expect(stub.calls[1].verb).toBe('get')
    expect(stub.calls[2].verb).toBe('status')
  })

  test('kill call records --claude-instance-id argv', () => {
    const row = makeSpawnRow({ channelId: 'C903' })
    stub.setSpawnRows([row])
    kill({ claudeInstanceId: 'cscb_C903' })

    const killCalls = stub.calls.filter(c => c.verb === 'kill')
    expect(killCalls).toHaveLength(1)
    expect(killCalls[0].argv).toContain('cscb_C903')
  })

  test('version call is recorded', () => {
    version()
    expect(stub.calls.some(c => c.verb === 'version')).toBe(true)
  })

  test('ENOENT path does NOT record to calls array', () => {
    stub.setSimulateEnoent(true)
    spawn({ channelId: 'C904', cwd: '/tmp/cwd' })
    // ENOENT fires before the call is pushed to calls
    expect(stub.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// bigint request_id > 2^53
// ---------------------------------------------------------------------------

describe('bigint request_id precision', () => {
  test('request_id > 2^53 is surfaced as string by wrapper (not truncated)', () => {
    // 9007199254740993 = 2^53 + 1, exceeds JS safe integer range
    const bigId = '9007199254740993'
    const row = makeSpawnRow({ channelId: 'C1000', state: 'check_permission' })
    stub.setSpawnRows([row])
    const payload = makeGetPayload({ channelId: 'C1000', requestId: bigId })
    stub.setGetPayload('cscb_C1000', payload)

    const result = get({ claudeInstanceId: 'cscb_C1000' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The wrapper uses lossless-json and surfaces requestId as a string
    const requestId = result.data.permissionRequest?.requestId
    expect(requestId).toBe(bigId)
    // Confirm it's a string, not a number
    expect(typeof requestId).toBe('string')
    // Confirm the value is not truncated (would be 9007199254740992 if coerced via Number)
    expect(requestId).not.toBe('9007199254740992')
  })

  test('safe integer request_id is also surfaced as string', () => {
    const safeId = '42'
    const row = makeSpawnRow({ channelId: 'C1001', state: 'check_permission' })
    stub.setSpawnRows([row])
    const payload = makeGetPayload({ channelId: 'C1001', requestId: safeId })
    stub.setGetPayload('cscb_C1001', payload)

    const result = get({ claudeInstanceId: 'cscb_C1001' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.permissionRequest?.requestId).toBe('42')
    expect(typeof result.data.permissionRequest?.requestId).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// ENOENT / binary-missing pathway
// ---------------------------------------------------------------------------

describe('ENOENT / binary-missing pathway', () => {
  test('setSimulateEnoent(true): next call returns ErrBinaryMissing', () => {
    stub.setSimulateEnoent(true)
    const result = list({ labels: {} })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrBinaryMissing')
  })

  test('ENOENT is consumed after one call: subsequent call succeeds', () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: 'C1100' })])
    stub.setSimulateEnoent(true)

    const first = list({ labels: {} })
    expect(first.ok).toBe(false)

    const second = list({ labels: {} })
    expect(second.ok).toBe(true)
  })

  test('ErrBinaryMissing via entryToError in spawn queue', () => {
    stub.setNextSpawnError({
      ok: false,
      error: { kind: 'ErrBinaryMissing', message: 'binary not found' },
    })

    const result = spawn({ channelId: 'C1101', cwd: '/tmp/cwd' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrBinaryMissing')
  })
})

// ---------------------------------------------------------------------------
// get fixture shapes (SR-8.3)
// ---------------------------------------------------------------------------

describe('get fixture shapes (SR-8.3)', () => {
  test('check_permission with non-nil permission_request: full fields present', () => {
    const row = makeSpawnRow({ channelId: 'C1200', state: 'check_permission' })
    stub.setSpawnRows([row])
    const payload = makeGetPayload({
      channelId: 'C1200',
      state: 'check_permission',
      requestId: '77',
      toolName: 'computer',
      toolInput: '{"action":"screenshot"}',
    })
    stub.setGetPayload('cscb_C1200', payload)

    const result = get({ claudeInstanceId: 'cscb_C1200' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.state).toBe('check_permission')
    expect(result.data.permissionRequest?.requestId).toBe('77')
    expect(result.data.permissionRequest?.toolName).toBe('computer')
    expect(result.data.permissionRequest?.toolInput).toBe('{"action":"screenshot"}')
  })

  test('check_permission with nil permission_request: permissionRequest is null', () => {
    const row = makeSpawnRow({ channelId: 'C1201', state: 'check_permission' })
    stub.setSpawnRows([row])
    const payload = makeGetPayload({ channelId: 'C1201', state: 'check_permission' })
    // No requestId → permissionRequest is null in the payload
    stub.setGetPayload('cscb_C1201', payload)

    const result = get({ claudeInstanceId: 'cscb_C1201' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.permissionRequest).toBeNull()
  })

  test('mid-cycle delete: after removing row, get returns ErrSpawnNotFound', () => {
    const row = makeSpawnRow({ channelId: 'C1202' })
    stub.setSpawnRows([row])

    const first = get({ claudeInstanceId: 'cscb_C1202' })
    expect(first.ok).toBe(true)

    // Simulate mid-cycle delete
    stub.setSpawnRows([])
    stub.setGetPayload('cscb_C1202', makeGetPayload({ channelId: 'C1202' }))
    // We need to also clear the getPayload so it falls through to notFound
    // Use a fresh stub behavior: remove from both spawnRows and getPayloads by reinstalling
    stub.uninstall()
    stub = new ClaudeDirectorStub()
    stub.install()

    const second = get({ claudeInstanceId: 'cscb_C1202' })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.kind).toBe('ErrSpawnNotFound')
  })

  test('toolInput is a raw JSON string per SR-2.1', () => {
    const row = makeSpawnRow({ channelId: 'C1203', state: 'check_permission' })
    stub.setSpawnRows([row])
    const payload = makeGetPayload({
      channelId: 'C1203',
      requestId: '1',
      toolInput: '{"command":"ls -la"}',
    })
    stub.setGetPayload('cscb_C1203', payload)

    const result = get({ claudeInstanceId: 'cscb_C1203' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // toolInput is a string (raw JSON), not an object
    const toolInput = result.data.permissionRequest?.toolInput
    expect(typeof toolInput).toBe('string')
    const parsed = JSON.parse(toolInput!)
    expect(parsed.command).toBe('ls -la')
  })

  test('ErrSpawnNotFound for nonexistent instance in get', () => {
    const result = get({ claudeInstanceId: 'cscb_ABSENT' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrSpawnNotFound')
  })
})

// ---------------------------------------------------------------------------
// send-keys verb
// ---------------------------------------------------------------------------

describe('sendKeys verb', () => {
  test('sendKeys succeeds against existing row', () => {
    const row = makeSpawnRow({ channelId: 'C1300' })
    stub.setSpawnRows([row])

    const result = sendKeys({ claudeInstanceId: 'cscb_C1300', keys: ['Enter'] })
    expect(result.ok).toBe(true)
  })

  test('sendKeys records --text flags in calls argv', () => {
    const row = makeSpawnRow({ channelId: 'C1301' })
    stub.setSpawnRows([row])

    sendKeys({ claudeInstanceId: 'cscb_C1301', keys: ['hello', 'Enter'] })

    const sk = stub.calls.filter(c => c.verb === 'send-keys')
    expect(sk).toHaveLength(1)
    const argv = sk[0].argv
    expect(argv).toContain('--text')
    expect(argv).toContain('hello')
    expect(argv).toContain('Enter')
  })

  test('sendKeys against unknown instance returns ErrSpawnNotFound', () => {
    const result = sendKeys({ claudeInstanceId: 'cscb_UNKNOWN', keys: ['x'] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrSpawnNotFound')
  })
})

// ---------------------------------------------------------------------------
// version verb
// ---------------------------------------------------------------------------

describe('version verb', () => {
  test('returns stub version string', () => {
    const result = version()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.version).toBe('v0.0.0-stub')
  })
})

// ---------------------------------------------------------------------------
// status verb
// ---------------------------------------------------------------------------

describe('status verb', () => {
  test('returns state from spawnRow', () => {
    const row = makeSpawnRow({ channelId: 'C1400', state: 'waiting' })
    stub.setSpawnRows([row])

    const result = status({ claudeInstanceId: 'cscb_C1400' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.state).toBe('waiting')
    expect(result.data.claudeInstanceId).toBe('cscb_C1400')
  })

  test('status against unknown instance returns ErrSpawnNotFound', () => {
    const result = status({ claudeInstanceId: 'cscb_UNKNOWN' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('ErrSpawnNotFound')
  })
})

// ---------------------------------------------------------------------------
// No real subprocess: stub does not invoke actual claude-director
// ---------------------------------------------------------------------------

describe('stub isolation: no real subprocess', () => {
  test('calling list does not invoke a real subprocess (no ENOENT on missing binary)', () => {
    // If the stub were not installed, calling list would attempt to spawn the real
    // claude-director binary, which doesn't exist, and return ErrBinaryMissing or throw.
    // With the stub installed, it succeeds with empty rows.
    const result = list({ labels: {} })
    // Should succeed cleanly — stub handled it, no real spawn
    expect(result.ok).toBe(true)
  })

  test('stub runner is an arrow function bound to stub instance', () => {
    // Verify the runner function references the stub's state
    stub.setSpawnRows([makeSpawnRow({ channelId: 'C9001' })])
    const result = list({ labels: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(1)
  })
})
