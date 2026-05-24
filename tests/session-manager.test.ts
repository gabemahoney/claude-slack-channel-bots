/**
 * session-manager.test.ts — Library-backed session-manager tests.
 *
 * Replaces the deleted tmux-direct test suite. Drives spawnForRoute via the
 * agent-director-stub (no real FFI). Coverage:
 *
 *   - Fresh-spawn happy path: emits SpawnParams matching SR-1.1
 *     (relay_mode='on', service=cscb + channel labels, template name,
 *     correct claude_instance_id and tmux_session_name).
 *   - SR-1.4 idempotency: ErrInstanceIdCollision → client.get(); each state
 *     drives the documented branch.
 *   - SR-1.6 orphan reconciliation: list-then-kill-then-delete for spawns
 *     whose channel label is not in routingConfig.routes.
 *   - SR-8.6 invariant: every successful spawn call site passes
 *     relay_mode='on'.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  reconcileOrphans,
  spawnForRoute,
  startupSessionManager,
  instanceIdFor,
  AGENT_DIRECTOR_LIVE_STATES,
} from '../src/session-manager.ts'
import { resetClientForTests, setClientForTests } from '../src/agent-director-client.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedOk,
  cannedErr,
  errInstanceIdCollision,
  errNoSessionId,
  errSpawnNotFound,
  makeStubClient,
  type StubClient,
} from './test-helpers/agent-director-stub.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function installStub(opts?: Parameters<typeof makeStubClient>[0]): StubClient {
  const stub = makeStubClient(opts)
  setClientForTests(stub as unknown as Parameters<typeof setClientForTests>[0])
  return stub
}

afterEach(() => {
  resetClientForTests()
})

// ---------------------------------------------------------------------------
// SR-1.1 — fresh spawn shape
// ---------------------------------------------------------------------------

describe('spawnForRoute: SR-1.1 fresh spawn', () => {
  test('emits SpawnParams with the SR-1.1 shape', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeRoutingConfig({
      routes: {
        C012345: { cwd: '/repo/x' },
      },
      claude_config_dir: '/home/u/.claude-corp',
    })
    const result = await spawnForRoute('C012345', { cwd: '/repo/x' }, cfg)
    expect(result.action).toBe('spawned')
    expect(spawnCalls).toHaveLength(1)
    const params = spawnCalls[0]
    expect(params.template).toBe('slack-channel-bot')
    expect(params.cwd).toBe('/repo/x')
    expect(params.claude_instance_id).toBe('cscb_C012345')
    expect(params.tmux_session_name).toBe('slack_bot_C012345')
    expect(params.relay_mode).toBe('on')
    expect(params.label).toEqual(['service=cscb', 'channel=C012345'])
    expect(params.extra_env).toEqual({ CLAUDE_CONFIG_DIR: '/home/u/.claude-corp' })
    expect(params.claude_args).toBeUndefined()
  })

  test('per-route claude_config_dir wins over top-level', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeRoutingConfig({
      routes: {
        C: { cwd: '/repo', claude_config_dir: '/per-route' },
      },
      claude_config_dir: '/top-level',
    })
    await spawnForRoute('C', { cwd: '/repo' }, cfg)
    expect(spawnCalls[0].extra_env).toEqual({ CLAUDE_CONFIG_DIR: '/per-route' })
  })

  test('omits extra_env when no claude_config_dir', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(spawnCalls[0].extra_env).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SR-1.4 — idempotency dispatch on ErrInstanceIdCollision
// ---------------------------------------------------------------------------

describe('spawnForRoute: SR-1.4 collision-then-act', () => {
  test('ended state + resume_enabled → resume()', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      spawnCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0].claude_instance_id).toBe('cscb_C')
  })

  test('ended state + ErrNoSessionId on resume → delete + fresh spawn', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      spawnCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      resumeError: errNoSessionId(),
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('spawned')
    expect(spawnCalls).toHaveLength(2)
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].claude_instance_id).toEqual(['cscb_C'])
  })

  test('ended state + resume_enabled=false → kill + delete + fresh spawn (no resume)', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      spawnCalls,
      killCalls,
      deleteCalls,
      resumeCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'missing' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, resume_enabled: false })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('spawned')
    expect(resumeCalls).toHaveLength(0)
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
  })

  test('waiting state → reconnectMcp (sendKeys with /mcp reconnect)', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('reconnected')
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toContain('/mcp reconnect')
  })

  test('pending/check_permission/ask_user → no-op', async () => {
    for (const state of ['pending', 'check_permission', 'ask_user']) {
      installStub({
        spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
        getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state }),
      })
      const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
      const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
      expect(result.action).toBe('no-op')
      resetClientForTests()
    }
  })

  test('ErrSpawnNotFound after collision → single retry-spawn', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getError: errSpawnNotFound(),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('spawned')
    expect(spawnCalls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// SR-1.6 — orphan reconciliation
// ---------------------------------------------------------------------------

describe('reconcileOrphans (SR-1.6)', () => {
  test('kills + deletes spawns whose channel label is not in routes', async () => {
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      deleteCalls,
      listResult: {
        spawns: [
          cannedListRow({ claude_instance_id: 'cscb_C_LIVE', labels: { service: 'cscb', channel: 'C_LIVE' } }),
          cannedListRow({ claude_instance_id: 'cscb_C_ORPH', labels: { service: 'cscb', channel: 'C_ORPH' } }),
          cannedListRow({ claude_instance_id: 'cscb_C_NOLBL', labels: { service: 'cscb' } }),
        ],
      },
    })
    const cfg = makeRoutingConfig({ routes: { C_LIVE: { cwd: '/x' } } })
    const result = await reconcileOrphans(cfg)
    expect(result.found).toBe(2) // C_ORPH + the unlabeled one
    expect(result.killed).toBe(2)
    expect(result.failed).toBe(0)
    expect(killCalls.map((k) => k.claude_instance_id).sort()).toEqual(['cscb_C_NOLBL', 'cscb_C_ORPH'])
    expect(deleteCalls.map((d) => d.claude_instance_id[0]).sort()).toEqual(['cscb_C_NOLBL', 'cscb_C_ORPH'])
  })

  test('list failure → recorded + zero counts (no crash)', async () => {
    installStub({ listError: new Error('AD down') })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await reconcileOrphans(cfg)
    expect(result.found).toBe(0)
    expect(result.killed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// startupSessionManager — iterate routes
// ---------------------------------------------------------------------------

describe('startupSessionManager', () => {
  test('counts succeeded/failed per route', async () => {
    let callIdx = 0
    const stub = installStub({})
    const realSpawn = stub.spawn.bind(stub)
    stub.spawn = async (params) => {
      callIdx++
      if (callIdx === 2) throw new Error('boom')
      return realSpawn(params)
    }
    const cfg = makeRoutingConfig({
      routes: {
        C1: { cwd: '/x1' },
        C2: { cwd: '/x2' },
        C3: { cwd: '/x3' },
      },
    })
    const result = await startupSessionManager(cfg, { concurrency: 1 })
    expect(result.succeeded + result.failed).toBe(3)
    expect(result.failed).toBe(1)
    expect(result.succeeded).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// SR-8.6 invariant: live state set + instance-id helper
// ---------------------------------------------------------------------------

describe('SR-8.6 invariants', () => {
  test('AGENT_DIRECTOR_LIVE_STATES covers all expected SR-11 live states', () => {
    expect(AGENT_DIRECTOR_LIVE_STATES.has('pending')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('waiting')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('working')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('ask_user')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('check_permission')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('ended')).toBe(false)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('missing')).toBe(false)
  })

  test('instanceIdFor produces deterministic cscb_<channelId>', () => {
    expect(instanceIdFor('C012345')).toBe('cscb_C012345')
  })

  test('every spawn call site emits relay_mode=on', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      resumeError: errNoSessionId(),
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    await spawnForRoute('C', { cwd: '/x' }, cfg)
    // Both spawns (initial + retry-after-delete) must carry relay_mode='on'.
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1)
    for (const p of spawnCalls) {
      expect(p.relay_mode).toBe('on')
    }
  })
})
