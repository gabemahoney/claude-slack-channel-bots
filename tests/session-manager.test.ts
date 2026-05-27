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
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  reconcileOrphans,
  spawnForRoute,
  startupSessionManager,
  instanceIdFor,
  AGENT_DIRECTOR_LIVE_STATES,
  DEV_CHANNELS_DIALOG_NEEDLE,
  _setDialogPollTimeoutMs,
  _setDialogPollIntervalMs,
  _resetDialogPollTimeoutMs,
  _resetDialogPollIntervalMs,
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

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  // Keep dev-channels approval polling tight so the helper firing on every
  // fresh-spawn test doesn't add seconds to the suite. Individual tests can
  // override these as needed.
  _setDialogPollIntervalMs(1)
  _setDialogPollTimeoutMs(20)
})

afterEach(() => {
  resetClientForTests()
  _resetDialogPollIntervalMs()
  _resetDialogPollTimeoutMs()
  process.env = savedEnv as NodeJS.ProcessEnv
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

// ---------------------------------------------------------------------------
// b.yy6 — dev-channels dialog auto-approve
// ---------------------------------------------------------------------------

describe('approveDevChannelsDialog (b.yy6)', () => {
  const DEV_CHANNELS_PANE = readFileSync(
    join(import.meta.dir, 'fixtures', 'dev-channels-pane-2.1.120.txt'),
    'utf-8',
  )
  const WELCOME_PANE = 'Listening for channel messages from: server:slack-channel-router'

  /**
   * Redirect startup-errors.log into a temp dir for this test and return a
   * helper that reads back recorded entries. Restores the previous
   * SLACK_STATE_DIR via the file-level afterEach.
   */
  function captureStartupErrors(): () => string {
    const dir = mkdtempSync(join(tmpdir(), 'cscb-yy6-'))
    process.env['SLACK_STATE_DIR'] = dir
    const logPath = join(dir, 'startup-errors.log')
    return () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '')
  }

  test('happy path: dialog detected → Enter sent → confirmed gone', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      readPaneResults: [
        { pane: DEV_CHANNELS_PANE },
        { pane: WELCOME_PANE },
        { pane: WELCOME_PANE },
      ],
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(result.action).toBe('spawned')
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toBe('')
    expect(sendKeysCalls[0].claude_instance_id).toBe('cscb_C')
    // readPane should have been invoked at least once for detection and
    // twice more to confirm the dialog cleared.
    expect(readPaneCalls.length).toBeGreaterThanOrEqual(3)
    for (const r of readPaneCalls) {
      expect(r.claude_instance_id).toBe('cscb_C')
      expect(r.n_lines).toBe(40)
    }
  })

  test('timeout: no dialog → no sendKeys → records dev-channels-approve-no-dialog', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      readPaneResults: [{ pane: 'unrelated pane text' }],
    })
    const readLog = captureStartupErrors()
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(result.action).toBe('spawned')
    expect(sendKeysCalls).toHaveLength(0)
    const log = readLog()
    expect(log).toContain('[dev-channels-approve-no-dialog]')
    expect(log).toContain('channel=C')
    expect(log).toContain('b.yy6')
  })

  test('still-visible after Enter → records dev-channels-approve-still-visible', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      // Sticky needle: every read returns the dialog → after sendKeys the
      // post-approval confirmation loop never sees the needle clear.
      readPaneResults: [{ pane: DEV_CHANNELS_PANE }],
    })
    const readLog = captureStartupErrors()
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(result.action).toBe('spawned')
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toBe('')
    const log = readLog()
    expect(log).toContain('[dev-channels-approve-still-visible]')
    expect(log).toContain('channel=C')
  })

  test('needle lock-in: matches the verified Claude Code 2.1.120 label', () => {
    expect(DEV_CHANNELS_DIALOG_NEEDLE).toBe('I am using this for local development')
    expect(DEV_CHANNELS_PANE).toContain(DEV_CHANNELS_DIALOG_NEEDLE)
  })

  test('skipped on collision-resume path (no fresh spawn → no readPane)', async () => {
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      readPaneCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(result.action).toBe('resumed')
    expect(readPaneCalls).toHaveLength(0)
  })

  test('skipped on collision-reconnect path (waiting state → no readPane)', async () => {
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      readPaneCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(result.action).toBe('reconnected')
    expect(readPaneCalls).toHaveLength(0)
  })

  test('skipped on collision-noop path (pending state → no readPane)', async () => {
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      readPaneCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'pending' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(result.action).toBe('no-op')
    expect(readPaneCalls).toHaveLength(0)
  })

  test('launchSession (restart path, isStartup=false): does not record startup error on timeout', async () => {
    installStub({
      readPaneResults: [{ pane: 'no dialog' }],
    })
    const readLog = captureStartupErrors()
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    // Drive the non-startup branch explicitly.
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, false)

    expect(result.action).toBe('spawned')
    expect(readLog()).toBe('')
  })
})
