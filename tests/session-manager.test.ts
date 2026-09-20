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
  reconcileInstanceIds,
  reconcileOrphans,
  refreshRouteNameFromEvent,
  resolveChannelNames,
  reconnectMcp,
  waitForWaitingAndReconnect,
  approvePreSessionDialogs,
  spawnForRoute,
  startupSessionManager,
  instanceIdFor,
  tmuxSessionNameFor,
  AGENT_DIRECTOR_LIVE_STATES,
  DEV_CHANNELS_DIALOG_NEEDLE,
  TRUST_DIALOG_NEEDLE,
  _setDialogReadyTimeoutMs,
  _setDialogPollIntervalMs,
  _resetDialogReadyTimeoutMs,
  _resetDialogPollIntervalMs,
  _setWaitForWaitingTimeoutMs,
  _resetWaitForWaitingTimeoutMs,
  _setTmuxSessionKiller,
  _resetTmuxSessionKiller,
  _setTmuxServerEnsurer,
  _resetTmuxServerEnsurer,
  _setTmuxSessionProber,
  _resetTmuxSessionProber,
  _setTmuxCapturePane,
  _setTmuxSendEnter,
  _resetTmuxDialogHelpers,
  _setDialogDeadGracePolls,
  _resetDialogDeadGracePolls,
} from '../src/session-manager.ts'
import { resetClientForTests, setClientForTests, getClient } from '../src/agent-director-client.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedFindMissing,
  cannedOk,
  cannedErr,
  errInstanceIdCollision,
  errNoSessionId,
  errJsonlMissing,
  errSpawnNotFound,
  errSpawnNotResumable,
  errGeneric,
  errSpawnNotInteractive,
  errTmuxSendKeys,
  errTmuxSessionCreate,
  makeStubClient,
  type StubClient,
} from './test-helpers/agent-director-stub.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'
import {
  initOutageState,
  getOutageFlags,
  setOutageFlag,
  _resetOutageState,
} from '../src/outage-state.ts'
import {
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
  ErrCwdNotFound,
} from '../src/agent-director-errors.ts'

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function installStub(opts?: Parameters<typeof makeStubClient>[0]): StubClient {
  const stub = makeStubClient(opts)
  setClientForTests(stub as unknown as Parameters<typeof setClientForTests>[0])
  return stub
}

/** Capture of outage-state Slack emissions (onsets + all-clears) across each test. */
let outageEmissions: Array<{ channelId: string; text: string }> = []

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  // Keep dialog approval polling tight so the merged approvePreSessionDialogs
  // running on every fresh-spawn doesn't add seconds to the suite. Individual
  // tests can override these as needed.
  _setDialogPollIntervalMs(1)
  // Use a large-enough ready timeout that the happy path (statusQueue reaches
  // 'waiting' in 2-3 polls at 1ms interval) completes before the cap. Tests
  // that need to exercise the cap override this locally.
  _setDialogReadyTimeoutMs(200)
  // Wire the outage-state module so withOutageDetection / withSpawnDetection
  // can resolve the AD client and emit Slack onset/all-clear messages.
  outageEmissions = []
  initOutageState({
    getClient,
    postToChannel: (channelId, text) => { outageEmissions.push({ channelId, text }) },
  })
  // Default the raw-tmux dialog seams to safe no-ops so unit tests never shell
  // out to real tmux (b.vub). Dead-row tests override these to drive behavior.
  _setTmuxCapturePane(async () => '')
  _setTmuxSendEnter(async () => {})
  // Default the b.3ce timeout-liveness prober to "alive" so unit tests never
  // shell out to real tmux and the timeout verdict stays 'ok' unless a test
  // explicitly drives the dead-session path.
  _setTmuxSessionProber(async () => true)
})

afterEach(() => {
  resetClientForTests()
  _resetDialogPollIntervalMs()
  _resetDialogReadyTimeoutMs()
  _resetWaitForWaitingTimeoutMs()
  _resetTmuxSessionKiller()
  _resetTmuxServerEnsurer()
  _resetTmuxSessionProber()
  _resetTmuxDialogHelpers()
  _resetDialogDeadGracePolls()
  _resetOutageState()
  process.env = savedEnv as NodeJS.ProcessEnv
})

// ---------------------------------------------------------------------------
// b.en2 Epic 4 shared helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock WebClient to assert postSpawnFailureToChannel was NOT called. */
function makeMockWeb(): {
  web: { chat: { postMessage: (...a: unknown[]) => Promise<unknown> } }
  calls: unknown[][]
} {
  const calls: unknown[][] = []
  const web = { chat: { postMessage: async (...a: unknown[]) => { calls.push(a); return {} } } }
  return { web, calls }
}

/** Pre-raise all three outage flags for a channel so success-clear tests start with full bad-stretch. */
function preSetAllFlags(channelId: string): void {
  setOutageFlag(channelId, 'cwd-unreachable', '/test/cwd')
  setOutageFlag(channelId, 'ad-unreachable', '/bin/ad')
  setOutageFlag(channelId, 'tmux-unavailable')
}

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
    expect(params.extra_env).toEqual({ CLAUDE_CONFIG_DIR: '/home/u/.claude-corp', CLAUDE_MANAGED_CHANNEL: 'C012345' })
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
    expect(spawnCalls[0].extra_env).toEqual({ CLAUDE_CONFIG_DIR: '/per-route', CLAUDE_MANAGED_CHANNEL: 'C' })
  })

  test('omits extra_env when no claude_config_dir', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(spawnCalls[0].extra_env).toEqual({ CLAUDE_MANAGED_CHANNEL: 'C' })
  })
})

// ---------------------------------------------------------------------------
// SR-1.4 — idempotency dispatch on ErrInstanceIdCollision
// ---------------------------------------------------------------------------

describe('spawnForRoute: SR-1.4 collision-then-act', () => {
  /**
   * Redirect startup-errors.log into a temp dir for this test and return a
   * helper that reads back recorded entries. Restores the previous
   * SLACK_STATE_DIR via the file-level afterEach.
   */
  function captureStartupErrors(): () => string {
    const dir = mkdtempSync(join(tmpdir(), 'cscb-2oy-'))
    process.env['SLACK_STATE_DIR'] = dir
    const logPath = join(dir, 'startup-errors.log')
    return () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '')
  }

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

  // b.2oy — resume rejects with ErrSpawnNotFound (row vanished between the
  // dead-session verdict and resume: operator delete, expire, race). Recovery
  // must fresh-spawn directly with the original params — NO kill, NO delete,
  // no channel-facing failure post — and report 'spawned'. Pre-fix this fell
  // into the generic resume-catch, which posted a Slack "spawn failure" and
  // returned action: 'failed'.
  test('b.2oy: ErrSpawnNotFound on resume → fresh spawn (no kill, no delete, no channel post)', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      spawnCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      resumeError: errSpawnNotFound(),
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
    })
    const { web, calls } = makeMockWeb()
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, web as never)
    expect(result).toEqual({ channelId: 'C', action: 'spawned' })
    // initial collision spawn + the fresh spawn after ErrSpawnNotFound
    expect(spawnCalls).toHaveLength(2)
    // fresh spawn carries the original params (same channel labels / id)
    expect(spawnCalls[1].claude_instance_id).toBe('cscb_C')
    expect(spawnCalls[1].label).toEqual(['service=cscb', 'channel=C'])
    // row was already gone — no kill and no delete of a missing row
    expect(killCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
    // no channel-facing spawn-failure post
    expect(calls).toHaveLength(0)
  })

  // b.2oy — ErrSpawnNotFound recovery still surfaces genuine spawn failures.
  // Resume throws ErrSpawnNotFound, then the fresh spawn fails with a generic
  // error → 'failed' and postSpawnFailureToChannel fires.
  test('b.2oy: ErrSpawnNotFound on resume + fresh spawn fails → failed + channel post', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const readLog = captureStartupErrors()
    installStub({
      spawnCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errGeneric('spawn', 'ErrSpawnBroken')),
      ],
      resumeError: errSpawnNotFound(),
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
    })
    const { web, calls } = makeMockWeb()
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, web as never)
    expect(result.action).toBe('failed')
    expect(spawnCalls).toHaveLength(2)
    expect(deleteCalls).toHaveLength(0)
    // generic spawn failure is surfaced to the channel
    expect(calls.length).toBeGreaterThanOrEqual(1)
    // startup-error side effect is part of the tested contract
    expect(readLog()).toContain('[spawn-failed]')
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
// b.rmy — ErrTmuxSendKeys self-heal + accurate reconnect outcome reporting
// ---------------------------------------------------------------------------

describe('b.rmy: ErrTmuxSendKeys self-heal + reconnect outcome', () => {
  /**
   * Redirect startup-errors.log into a temp dir for this test and return a
   * helper that reads back recorded entries. Restores the previous
   * SLACK_STATE_DIR via the file-level afterEach.
   */
  function captureStartupErrors(): () => string {
    const dir = mkdtempSync(join(tmpdir(), 'cscb-rmy-'))
    process.env['SLACK_STATE_DIR'] = dir
    const logPath = join(dir, 'startup-errors.log')
    return () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '')
  }

  test('reconnectMcp: ErrTmuxSendKeys → ensure tmux server + retry once → success', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let ensureCalls = 0
    _setTmuxServerEnsurer(async () => { ensureCalls++ })
    installStub({
      sendKeysCalls,
      sendKeysQueue: [
        cannedErr<import('agent-director').SendKeysResult>(errTmuxSendKeys()),
        cannedOk<import('agent-director').SendKeysResult>({}),
      ],
    })
    const { web, calls } = makeMockWeb()
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await reconnectMcp('C', web as never, cfg)
    expect(result).toBe('ok')
    expect(ensureCalls).toBe(1)
    expect(sendKeysCalls).toHaveLength(2)
    expect(sendKeysCalls[1].text).toContain('/mcp reconnect')
    // Retry succeeded — no Slack failure post
    expect(calls).toHaveLength(0)
  })

  test('reconnectMcp: retry after ErrTmuxSendKeys also fails → dead-session (b.3ce: caller recovers, no failure post)', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let ensureCalls = 0
    _setTmuxServerEnsurer(async () => { ensureCalls++ })
    installStub({
      sendKeysCalls,
      sendKeysError: errTmuxSendKeys(), // persistent — first attempt AND retry fail
    })
    const { web, calls } = makeMockWeb()
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await reconnectMcp('C', web as never, cfg)
    expect(result).toBe('dead-session')
    expect(ensureCalls).toBe(1) // self-heal attempted exactly once (single retry)
    expect(sendKeysCalls).toHaveLength(2)
    // b.3ce: dead-session hands recovery to the caller — no premature failure post
    expect(calls).toHaveLength(0)
  })

  test('reconnectMcp: non-tmux sendKeys error → no self-heal, no retry', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let ensureCalls = 0
    _setTmuxServerEnsurer(async () => { ensureCalls++ })
    installStub({
      sendKeysCalls,
      sendKeysError: errGeneric('send-keys', 'ErrSomethingElse'),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await reconnectMcp('C', undefined, cfg)
    expect(result).toBe('failed')
    expect(ensureCalls).toBe(0)
    expect(sendKeysCalls).toHaveLength(1)
  })

  test('spawnForRoute waiting branch: self-heal retry succeeds → reconnected', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    _setTmuxServerEnsurer(async () => {})
    installStub({
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
      sendKeysQueue: [
        cannedErr<import('agent-director').SendKeysResult>(errTmuxSendKeys()),
        cannedOk<import('agent-director').SendKeysResult>({}),
      ],
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('reconnected')
    expect(sendKeysCalls).toHaveLength(2)
  })

  test('spawnForRoute waiting branch (b.3ce): persistent ErrTmuxSendKeys → resume recovery, not failed', async () => {
    const readLog = captureStartupErrors()
    _setTmuxServerEnsurer(async () => {})
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(), // persistent — self-heal retry fails too (dead session)
      resumeCalls,
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    // b.3ce: pre-fix this reported 'failed' and gave up; now the dead session
    // falls through to the ended/missing recovery logic (resume-first).
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
    expect(readLog()).toBe('')
  })

  test('spawnForRoute waiting branch (b.3ce): dead session + resume not resumable → kill+delete+fresh spawn', async () => {
    _setTmuxServerEnsurer(async () => {})
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      spawnCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      resumeError: errSpawnNotResumable(), // stale `waiting` row rejects resume
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('spawned')
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
    expect(spawnCalls).toHaveLength(2) // initial collision + fresh spawn
  })

  test('spawnForRoute waiting branch: dead session and recovery also fails → action=failed', async () => {
    const readLog = captureStartupErrors()
    _setTmuxServerEnsurer(async () => {})
    installStub({
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      resumeError: errGeneric('resume', 'ErrResumeBroken'), // recovery fails too
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('failed')
    expect(readLog()).toBe('') // resume-failure path posts to Slack; no reconnect-failed startup entry
  })

  test('startupSessionManager: unrecoverable channels are counted (no false "0 failed")', async () => {
    captureStartupErrors() // keep startup-errors.log in a temp dir
    _setTmuxServerEnsurer(async () => {})
    // Both routes collide into `waiting` rows whose reconnect send-keys fails
    // persistently — the 2026-09-18 post-reboot outage shape — AND the b.3ce
    // resume recovery fails, so both must land in the failed bucket.
    installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
      ],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_X', state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      resumeError: errGeneric('resume', 'ErrResumeBroken'),
    })
    const cfg = makeRoutingConfig({ routes: { C1: { cwd: '/x1' }, C2: { cwd: '/x2' } } })
    const result = await startupSessionManager(cfg, { concurrency: 1 })
    expect(result.failed).toBe(2)
    expect(result.succeeded).toBe(0)
    expect(result.perChannel.every((p) => p.action === 'failed')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// b.3ce — waitForWaitingAndReconnect timeout liveness verdict + working-branch
// dead-session recovery
// ---------------------------------------------------------------------------

describe('b.3ce: waitForWaitingAndReconnect timeout liveness + dead-session recovery', () => {
  test('timeout with tmux session alive → ok (long turns are not errors — regression guard)', async () => {
    _setWaitForWaitingTimeoutMs(30)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true })
    installStub({
      statusResult: { state: 'working' } as import('agent-director').StatusResult, // frozen mid-long-turn
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('ok')
    expect(probed).toEqual([tmuxSessionNameFor('C', undefined)])
  })

  test('timeout with tmux session gone → dead-session', async () => {
    _setWaitForWaitingTimeoutMs(30)
    _setTmuxSessionProber(async () => false)
    installStub({
      statusResult: { state: 'working' } as import('agent-director').StatusResult, // DB row frozen post-reboot
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
  })

  test('spawnForRoute working branch: timeout + dead session → resume recovery instead of reconnected', async () => {
    _setWaitForWaitingTimeoutMs(30)
    _setTmuxSessionProber(async () => false)
    _setTmuxServerEnsurer(async () => {})
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'working' }),
      statusResult: { state: 'working' } as import('agent-director').StatusResult,
      resumeCalls,
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
  })

  test('spawnForRoute working branch: timeout + session alive → reconnected (no kill/resume/spawn)', async () => {
    _setWaitForWaitingTimeoutMs(30)
    _setTmuxSessionProber(async () => true)
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      spawnCalls,
      killCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'working' }),
      statusResult: { state: 'working' } as import('agent-director').StatusResult,
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('reconnected')
    expect(resumeCalls).toHaveLength(0)
    expect(killCalls).toHaveLength(0)
    expect(spawnCalls).toHaveLength(1) // only the initial colliding spawn
  })
})

// ---------------------------------------------------------------------------
// b.4dk — findMissing-before-resume on the dead-session recovery path
//
// AD's resume verb requires a terminal (ended/missing) row. A dead-session
// verdict arrives with a LIVE-state row (waiting/working), so pre-fix resume
// was structurally guaranteed to throw ErrSpawnNotResumable → kill+delete+
// fresh, destroying the session_id resume needed. The fix runs one
// client.findMissing({}) BEFORE resume (only on the dead-session callers) so
// AD transitions the dead row to `missing` and resume can succeed.
//
// The `callLog` capture proves relative ordering; `findMissingCalls` proves
// the call count and that it carries an empty-params sweep ({}).
// ---------------------------------------------------------------------------

describe('b.4dk: findMissing-before-resume on dead-session recovery', () => {
  // Drive the WAITING-branch dead-session verdict: reconnectMcp send-keys fails
  // persistently even after the b.vub self-heal (tmux server ensurer no-op),
  // which is the 'dead-session' signal for a waiting row.
  test('waiting dead-session: findMissing runs exactly once BEFORE resume → resumed', async () => {
    _setTmuxServerEnsurer(async () => {})
    const callLog: string[] = []
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      callLog,
      findMissingCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(), // persistent → dead session
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('resumed')
    expect(findMissingCalls).toHaveLength(1)
    expect(findMissingCalls[0]).toEqual({})
    expect(resumeCalls).toHaveLength(1)
    // Ordering: findMissing must be the immediately-preceding verb before resume.
    expect(callLog.indexOf('findMissing')).toBeGreaterThanOrEqual(0)
    expect(callLog.indexOf('findMissing')).toBeLessThan(callLog.indexOf('resume'))
  })

  // Drive the WORKING-branch dead-session verdict: waitForWaitingAndReconnect
  // times out with the tmux session gone (prober false).
  test('working dead-session: findMissing runs exactly once BEFORE resume → resumed', async () => {
    _setWaitForWaitingTimeoutMs(30)
    _setTmuxSessionProber(async () => false)
    _setTmuxServerEnsurer(async () => {})
    const callLog: string[] = []
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      callLog,
      findMissingCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'working' }),
      statusResult: { state: 'working' } as import('agent-director').StatusResult,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('resumed')
    expect(findMissingCalls).toHaveLength(1)
    expect(resumeCalls).toHaveLength(1)
    expect(callLog.indexOf('findMissing')).toBeLessThan(callLog.indexOf('resume'))
  })

  // ended/missing caller (SR-1.4 collision resolved to a terminal row) does NOT
  // set reconcileMissingFirst — the row is already terminal, straight to resume.
  test('ended/missing path: resume called with NO findMissing call', async () => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      findMissingCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('resumed')
    expect(findMissingCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(1)
  })

  // findMissing rejects → still attempt resume anyway → on a still-live row AD
  // throws ErrSpawnNotResumable → existing defensive kill+delete+fresh preserved.
  test('waiting dead-session: findMissing rejects → resume attempted → ErrSpawnNotResumable → kill+delete+fresh', async () => {
    _setTmuxServerEnsurer(async () => {})
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      findMissingCalls,
      resumeCalls,
      killCalls,
      deleteCalls,
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      findMissingError: errGeneric('find-missing', 'ErrProbeFailed'),
      resumeError: errSpawnNotResumable(), // row still live-state → resume rejects
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('spawned')
    expect(findMissingCalls).toHaveLength(1)
    expect(resumeCalls).toHaveLength(1) // resume still attempted despite findMissing failure
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
    expect(spawnCalls).toHaveLength(2)
  })

  // resume_enabled=false short-circuits BEFORE the findMissing block —
  // kill+delete+fresh as before, no findMissing, no resume.
  test('resume_enabled=false dead-session: no findMissing, no resume (kill+delete+fresh)', async () => {
    _setTmuxServerEnsurer(async () => {})
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      findMissingCalls,
      resumeCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, resume_enabled: false })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('spawned')
    expect(findMissingCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
  })

  // Regression guard for b.vub self-heal: an ErrTmuxSessionCreate on resume in
  // the dead-session path must still trigger the orphan-tmux-kill self-heal and
  // a fresh respawn — unchanged by the findMissing insertion.
  test('waiting dead-session: findMissing then resume ErrTmuxSessionCreate → b.vub self-heal respawn → spawned', async () => {
    _setTmuxServerEnsurer(async () => {})
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      findMissingCalls,
      resumeCalls,
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      resumeError: errTmuxSessionCreate('resume'),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('spawned')
    expect(findMissingCalls).toHaveLength(1) // findMissing still runs once, before resume
    expect(resumeCalls).toHaveLength(1) // resume attempted once, threw ErrTmuxSessionCreate
    expect(killedSessions).toHaveLength(1) // b.vub self-heal killed the orphan tmux session
    expect(spawnCalls).toHaveLength(2) // initial collision + self-heal fresh spawn
  })
})

// ---------------------------------------------------------------------------
// b.c3o — waitForWaitingAndReconnect early-abort liveness verdict
// ---------------------------------------------------------------------------

describe('b.c3o: waitForWaitingAndReconnect early-abort liveness verdict', () => {
  test('transition to missing + tmux gone → dead-session', async () => {
    _setTmuxSessionProber(async () => false)
    installStub({
      statusResult: { state: 'missing' } as import('agent-director').StatusResult,
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
  })

  test('transition to ended + tmux gone → dead-session', async () => {
    _setTmuxSessionProber(async () => false)
    installStub({
      statusResult: { state: 'ended' } as import('agent-director').StatusResult,
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
  })

  test('transition to missing + tmux alive → ok (probe decides, not the DB row)', async () => {
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true })
    installStub({
      statusResult: { state: 'missing' } as import('agent-director').StatusResult,
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('ok')
    expect(probed).toEqual([tmuxSessionNameFor('C', undefined)])
  })

  test('transition to live transient state (ask_user) → ok without probing or recovery (regression guard)', async () => {
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return false }) // even a "dead" probe must not matter
    installStub({
      statusResult: { state: 'ask_user' } as import('agent-director').StatusResult,
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('ok')
    expect(probed).toEqual([]) // live transient states never reach the prober
  })

  test('transition to live transient state (check_permission) → ok, never dead-session', async () => {
    _setTmuxSessionProber(async () => false)
    installStub({
      statusResult: { state: 'check_permission' } as import('agent-director').StatusResult,
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('ok')
  })

  test('ErrSpawnNotFound + tmux gone → dead-session', async () => {
    _setTmuxSessionProber(async () => false)
    installStub({ statusError: errSpawnNotFound() })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
  })

  test('ErrSpawnNotFound + tmux alive → ok', async () => {
    _setTmuxSessionProber(async () => true)
    installStub({ statusError: errSpawnNotFound() })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('ok')
  })

  test('spawnForRoute working branch: transition to missing + dead tmux → resume recovery instead of misreported ok', async () => {
    _setTmuxSessionProber(async () => false)
    _setTmuxServerEnsurer(async () => {})
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'working' }),
      statusResult: { state: 'missing' } as import('agent-director').StatusResult,
      resumeCalls,
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
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

  test('instanceIdFor produces deterministic cscb_<channelId> (no name)', () => {
    expect(instanceIdFor('C012345')).toBe('cscb_C012345')
  })

  test('instanceIdFor composes cscb_<name>_<channelId> when name is provided', () => {
    expect(instanceIdFor('C012345', 'general')).toBe('cscb_general_C012345')
    expect(instanceIdFor('C0B3X876XSB', 'horde_agent_director')).toBe('cscb_horde_agent_director_C0B3X876XSB')
  })

  test('instanceIdFor falls back to bare-ID for empty/undefined name', () => {
    expect(instanceIdFor('C012345', '')).toBe('cscb_C012345')
    expect(instanceIdFor('C012345', undefined)).toBe('cscb_C012345')
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
// b.4ie — merged approvePreSessionDialogs (dev-channels + trust needle)
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs (b.4ie)', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'cscb-4ie-'))
    process.env['SLACK_STATE_DIR'] = dir
    const logPath = join(dir, 'startup-errors.log')
    return () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '')
  }

  // -------------------------------------------------------------------------
  // Happy path: dialog detected → Enter sent (via spawnForRoute, the SR-1.1
  // fresh-spawn path that calls approvePreSessionDialogs).
  // statusQueue drives pending→waiting so the approver presses Enter then exits.
  // -------------------------------------------------------------------------

  test('happy path: dialog detected → Enter sent (allow_pending true, id cscb_C)', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      // pending → approver reads pane and presses Enter; then waiting → returns
      statusQueue: [
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'waiting' }),
      ],
      readPaneResults: [
        { pane: DEV_CHANNELS_PANE },
        { pane: WELCOME_PANE },
      ],
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(result.action).toBe('spawned')
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toBe('')
    expect(sendKeysCalls[0].claude_instance_id).toBe('cscb_C')
    // readPane should have been invoked at least once while pending
    expect(readPaneCalls.length).toBeGreaterThanOrEqual(1)
    for (const r of readPaneCalls) {
      expect(r.claude_instance_id).toBe('cscb_C')
      expect(r.n_lines).toBe(40)
      // b.98w: every readPane call must carry allow_pending=true
      expect(r.allow_pending).toBe(true)
    }
    // b.98w: the sendKeys call that presses Enter must also carry allow_pending=true
    for (const s of sendKeysCalls) {
      expect(s.allow_pending).toBe(true)
    }
  })

  // -------------------------------------------------------------------------
  // needle lock-in constant test
  // -------------------------------------------------------------------------

  test('needle lock-in: matches the verified Claude Code 2.1.120 label', () => {
    expect(DEV_CHANNELS_DIALOG_NEEDLE).toBe('I am using this for local development')
    expect(DEV_CHANNELS_PANE).toContain(DEV_CHANNELS_DIALOG_NEEDLE)
  })

  // -------------------------------------------------------------------------
  // Collision/skip tests — no approvePreSessionDialogs on collision paths
  // -------------------------------------------------------------------------

  test('collision-resume path: approver runs but returns immediately when status is already live (no readPane)', async () => {
    // b.vub: the resume-success path now calls approvePreSessionDialogs. When
    // the resumed row is already live (default stub status='waiting'), the
    // approver returns before ever reading the pane.
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      readPaneCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
      statusResult: { state: 'waiting' },
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

  // -------------------------------------------------------------------------
  // isStartup=false path: no startup error recorded on cap hit
  // -------------------------------------------------------------------------

  test('launchSession (restart path, isStartup=false): does not record startup error on cap hit', async () => {
    // sticky pending → cap hit; isStartup=false means no startup error
    _setDialogReadyTimeoutMs(20)
    installStub({
      statusResult: { state: 'pending' },
      readPaneResults: [{ pane: 'unrelated' }],
    })
    const readLog = captureStartupErrors()
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, false)

    expect(result.action).toBe('spawned')
    expect(readLog()).toBe('')
  })

  // -------------------------------------------------------------------------
  // b.98w regression: readPane/sendKeys must pass allow_pending:true
  // -------------------------------------------------------------------------

  test('b.98w / allow_pending: Enter pressed with allow_pending:true while spawn is pending', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []

    // Install a baseline stub, then override readPane and sendKeys to simulate
    // the agent-director rejecting calls that lack allow_pending:true.
    const stub = installStub({ sendKeysCalls, readPaneCalls })

    stub.readPane = async (params: import('agent-director').ReadPaneParams): Promise<import('agent-director').ReadPaneResult> => {
      readPaneCalls.push(params)
      if (!params.allow_pending) {
        throw errSpawnNotInteractive('read-pane')
      }
      // Return the dialog needle on the first detection call, then clear it.
      const callIdx = readPaneCalls.length
      if (callIdx === 1) return { pane: DEV_CHANNELS_PANE }
      return { pane: WELCOME_PANE }
    }

    stub.sendKeys = async (params: import('agent-director').SendKeysParams): Promise<import('agent-director').SendKeysResult> => {
      sendKeysCalls.push(params)
      if (!params.allow_pending) {
        throw errSpawnNotInteractive('send-keys')
      }
      return {}
    }

    // statusQueue: pending → (readPane+sendKeys fire) → waiting → exit
    stub.status = async (_params: import('agent-director').StatusParams): Promise<import('agent-director').StatusResult> => {
      const enterCount = sendKeysCalls.length
      return { state: enterCount >= 1 ? 'waiting' : 'pending' }
    }

    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    // If allow_pending is present everywhere the spawn must complete cleanly.
    expect(result.action).toBe('spawned')
    // Exactly one sendKeys (the Enter key that dismisses the dialog).
    const enterCalls = sendKeysCalls.filter((s) => s.text === '')
    expect(enterCalls).toHaveLength(1)
    // The sendKeys call must carry allow_pending:true
    expect(enterCalls[0].allow_pending).toBe(true)
  })

  // -------------------------------------------------------------------------
  // b.ben regression: composed instance id used when route has normalizedName
  // -------------------------------------------------------------------------

  test('b.ben: uses composed instance id when route has normalizedName', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      statusQueue: [
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'waiting' }),
      ],
      readPaneResults: [
        { pane: DEV_CHANNELS_PANE },
        { pane: WELCOME_PANE },
      ],
    })
    const cfg = makeRoutingConfig({
      routes: { C_TEST1: { cwd: '/x', name: 'my_chan', normalizedName: 'my_chan' } },
    })
    const result = await spawnForRoute('C_TEST1', { cwd: '/x' }, cfg)

    expect(result.action).toBe('spawned')
    // Approver must address the composed id, not the bare cscb_<id>.
    expect(readPaneCalls.length).toBeGreaterThanOrEqual(1)
    for (const r of readPaneCalls) {
      expect(r.claude_instance_id).toBe('cscb_my_chan_C_TEST1')
    }
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].claude_instance_id).toBe('cscb_my_chan_C_TEST1')
    expect(sendKeysCalls[0].text).toBe('')
  })

  // -------------------------------------------------------------------------
  // New behavior tests for merged approver (b.4ie)
  // -------------------------------------------------------------------------

  test('cap hit: sticky pending + unrecognized pane → records dev-channels-approve-not-ready, no sendKeys, posts Slack failure (isStartup=true)', async () => {
    _setDialogReadyTimeoutMs(30)
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      // sticky pending: never becomes live
      statusResult: { state: 'pending' },
      readPaneResults: [{ pane: 'unrelated pane text' }],
    })
    const readLog = captureStartupErrors()
    const { web, calls } = makeMockWeb()
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    await spawnForRoute('C', { cwd: '/x' }, cfg, web as never)

    expect(sendKeysCalls).toHaveLength(0)
    const log = readLog()
    expect(log).toContain('[dev-channels-approve-not-ready]')
    expect(log).toContain('channel=C')
    // cap path must also fire postSpawnFailureToChannel (core requirement of b.4ie)
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  test('dead state: sticky ended + no needle (grace exhausted) → records dev-channels-approve-spawn-died', async () => {
    // b.vub: dead rows are driven via RAW tmux (AD refuses missing/ended panes).
    // With no needle in the raw pane and the grace streak set to 1, the first
    // ended poll exhausts the grace and records the death.
    _setDialogDeadGracePolls(1)
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let rawEnterCount = 0
    _setTmuxCapturePane(async () => 'no needle here') // raw pane, no dialog
    _setTmuxSendEnter(async () => { rawEnterCount += 1 })
    installStub({
      sendKeysCalls,
      statusQueue: [
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'ended' }),
      ],
      readPaneResults: [{ pane: 'no needle here' }],
    })
    const readLog = captureStartupErrors()
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    await spawnForRoute('C', { cwd: '/x' }, cfg)

    const log = readLog()
    expect(log).toContain('[dev-channels-approve-spawn-died]')
    // No needle anywhere → neither AD nor raw Enter was pressed.
    expect(sendKeysCalls).toHaveLength(0)
    expect(rawEnterCount).toBe(0)
  })

  test('already-live: statusQueue [waiting] → no readPane, no sendKeys, no startup error', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      statusQueue: [cannedOk({ state: 'waiting' })],
    })
    const readLog = captureStartupErrors()
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(readPaneCalls).toHaveLength(0)
    expect(sendKeysCalls).toHaveLength(0)
    expect(readLog()).toBe('')
  })

  test('self-heal: statusQueue [pending, pending, waiting] + sticky dialog → Enter pressed ≥2 times', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      statusQueue: [
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'waiting' }),
      ],
      // sticky: every readPane returns the dialog needle
      readPaneResults: [{ pane: DEV_CHANNELS_PANE }],
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    await spawnForRoute('C', { cwd: '/x' }, cfg)

    // Enter pressed each time the pane shows the needle while pending
    expect(sendKeysCalls.length).toBeGreaterThanOrEqual(2)
  })

  // -------------------------------------------------------------------------
  // b.vub — pane-first / state-tolerant: press Enter despite missing/ended
  // -------------------------------------------------------------------------

  test('b.vub: dead row (missing) with needle → RAW tmux Enter, NOT agent-director sendKeys', async () => {
    // A resumed bot blocked at the dialog reports state=missing while the pane
    // still shows the needle. agent-director REFUSES read-pane/send-keys on a
    // missing row (ErrSpawnNotInteractive), so the approver must drive the
    // dialog via raw tmux keyed on the deterministic session name.
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    const rawCaptured: string[] = []
    const rawEntered: string[] = []
    _setTmuxCapturePane(async (name) => { rawCaptured.push(name); return DEV_CHANNELS_PANE })
    _setTmuxSendEnter(async (name) => { rawEntered.push(name) })
    const readLog = captureStartupErrors()
    installStub({
      sendKeysCalls,
      readPaneCalls,
      // missing (raw needle → raw Enter) → then waiting → return
      statusQueue: [
        cannedOk({ state: 'missing' }),
        cannedOk({ state: 'waiting' }),
      ],
    })

    await approvePreSessionDialogs('C', undefined, true)

    // Raw tmux was used, keyed on the deterministic session name.
    expect(rawCaptured).toContain('slack_bot_C')
    expect(rawEntered).toEqual(['slack_bot_C'])
    // agent-director's interactive verbs were NOT used on the dead row.
    expect(readPaneCalls).toHaveLength(0)
    expect(sendKeysCalls).toHaveLength(0)
    // Must NOT have recorded spawn-died — the needle was present, not dead.
    expect(readLog()).not.toContain('[dev-channels-approve-spawn-died]')
  })

  test('b.vub: dead row (ended) with needle → RAW tmux Enter clears the dialog', async () => {
    const rawEntered: string[] = []
    _setTmuxCapturePane(async () => DEV_CHANNELS_PANE)
    _setTmuxSendEnter(async (name) => { rawEntered.push(name) })
    installStub({
      statusQueue: [
        cannedOk({ state: 'ended' }),
        cannedOk({ state: 'waiting' }),
      ],
    })

    await approvePreSessionDialogs('C', undefined, true)

    expect(rawEntered).toEqual(['slack_bot_C'])
  })

  test('b.vub: dead row with NO needle in raw pane (grace exhausted) → terminal, no Enter', async () => {
    // Without a needle in the RAW pane, a sticky missing row exhausts the grace
    // streak and is recorded as dead — no stray Enter, AD verbs untouched.
    _setDialogDeadGracePolls(1)
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const rawEntered: string[] = []
    _setTmuxCapturePane(async () => 'no needle here')
    _setTmuxSendEnter(async (name) => { rawEntered.push(name) })
    installStub({
      sendKeysCalls,
      statusResult: { state: 'missing' },
    })
    const readLog = captureStartupErrors()

    await approvePreSessionDialogs('C', undefined, true)

    expect(sendKeysCalls).toHaveLength(0)
    expect(rawEntered).toHaveLength(0)
    expect(readLog()).toContain('[dev-channels-approve-spawn-died]')
  })

  // -------------------------------------------------------------------------
  // b.vub — resume-success path invokes the approver
  // -------------------------------------------------------------------------

  test('b.vub: resume-success path drives the dialog approver via RAW tmux (missing row)', async () => {
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const rawEntered: string[] = []
    _setTmuxCapturePane(async () => DEV_CHANNELS_PANE)
    _setTmuxSendEnter(async (name) => { rawEntered.push(name) })
    installStub({
      resumeCalls,
      // fresh spawn collides → get=missing → resume succeeds → approver runs
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'missing' }),
      // resumed bot is still `missing` while blocked at the dialog, then waiting
      statusQueue: [
        cannedOk({ state: 'missing' }),
        cannedOk({ state: 'waiting' }),
      ],
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
    // The approver ran on the resume path and dismissed the dialog via raw tmux.
    expect(rawEntered).toEqual(['slack_bot_C'])
  })

  // -------------------------------------------------------------------------
  // b.vub — ErrTmuxSessionCreate self-heal (kill orphan tmux + retry once)
  // -------------------------------------------------------------------------

  test('b.vub: ErrTmuxSessionCreate on resume → kill orphan tmux by name + retry spawn once', async () => {
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      spawnCalls,
      // 1st spawn: instance-id collision → get=missing → resume throws tmux-create
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        // 2nd spawn (the self-heal retry) succeeds
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'missing' }),
      resumeError: errTmuxSessionCreate('resume'),
      // approver on the retry-spawn: already live → returns immediately
      statusResult: { state: 'waiting' },
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(result.action).toBe('spawned')
    // Orphan tmux killed by its deterministic per-channel name.
    expect(killedSessions).toEqual(['slack_bot_C'])
    // Exactly one retry spawn after the collision spawn (2 spawn calls total).
    expect(spawnCalls).toHaveLength(2)
  })

  test('b.vub: ErrTmuxSessionCreate on fresh spawn → kill orphan tmux by name + retry spawn once', async () => {
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      spawnCalls,
      // 1st fresh spawn throws tmux-create (no instance-id collision) → self-heal
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      statusResult: { state: 'waiting' },
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(result.action).toBe('spawned')
    expect(killedSessions).toEqual(['slack_bot_C'])
    expect(spawnCalls).toHaveLength(2)
  })

  test('b.vub: ErrTmuxSessionCreate self-heal uses composed tmux name when route has normalizedName', async () => {
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_my_chan_C_T1' }),
      ],
      statusResult: { state: 'waiting' },
    })
    const cfg = makeRoutingConfig({
      routes: { C_T1: { cwd: '/x', name: 'my chan', normalizedName: 'my_chan' } },
    })
    const result = await spawnForRoute('C_T1', { cwd: '/x' }, cfg)

    expect(result.action).toBe('spawned')
    expect(killedSessions).toEqual(['slack_bot_my_chan_C_T1'])
  })

  test('b.vub: ErrTmuxSessionCreate self-heal that fails on retry → posts Slack failure', async () => {
    _setTmuxSessionKiller(async () => { /* orphan killed but retry still fails */ })
    const { web, calls } = makeMockWeb()
    const readLog = captureStartupErrors()
    installStub({
      // fresh spawn throws tmux-create; retry spawn also throws (generic)
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
      ],
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, web as never)

    expect(result.action).toBe('failed')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(readLog()).toContain('[spawn-failed]')
  })
})

// b.1m9 — tmuxSessionNameFor naming layer
// ---------------------------------------------------------------------------

describe('tmuxSessionNameFor (b.1m9)', () => {
  test('falls back to slack_bot_<id> when no normalized name', () => {
    expect(tmuxSessionNameFor('C0AMDDZEHCY')).toBe('slack_bot_C0AMDDZEHCY')
    expect(tmuxSessionNameFor('C0AMDDZEHCY', undefined)).toBe('slack_bot_C0AMDDZEHCY')
    expect(tmuxSessionNameFor('C0AMDDZEHCY', '')).toBe('slack_bot_C0AMDDZEHCY')
  })

  test('composes slack_bot_<name>_<id> when name is provided', () => {
    expect(tmuxSessionNameFor('C0AMDDZEHCY', 'general')).toBe('slack_bot_general_C0AMDDZEHCY')
    expect(tmuxSessionNameFor('C0B3X876XSB', 'horde_agent_director'))
      .toBe('slack_bot_horde_agent_director_C0B3X876XSB')
  })

  test('does not normalize internally — caller must pre-normalize', () => {
    // Whatever string the caller passes is concatenated verbatim. (Production
    // callers go through normalizeChannelName before this; the function trusts
    // its argument.)
    expect(tmuxSessionNameFor('C', 'has space')).toBe('slack_bot_has space_C')
  })

  test('output is glanceable for realistic channel names', () => {
    // Mirrors the acceptance examples from b.1m9 body.
    const cases: [string, string, string][] = [
      ['C0AMDDZEHCY', 'general', 'slack_bot_general_C0AMDDZEHCY'],
      ['C0B2A9D2THT', 'horde', 'slack_bot_horde_C0B2A9D2THT'],
      ['C0B3X876XSB', 'horde_agent_director', 'slack_bot_horde_agent_director_C0B3X876XSB'],
      ['C0B2UB0LR9A', 'horde_apiary', 'slack_bot_horde_apiary_C0B2UB0LR9A'],
    ]
    for (const [id, name, expected] of cases) {
      expect(tmuxSessionNameFor(id, name)).toBe(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// b.1m9 — spawn-params composition uses normalizedName from the route
// ---------------------------------------------------------------------------

describe('spawnForRoute: name-aware composition (b.1m9)', () => {
  test('uses cscb_<name>_<id> and slack_bot_<name>_<id> when route has normalizedName', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeRoutingConfig({
      routes: {
        C0AMDDZEHCY: { cwd: '/repo/general', name: 'general', normalizedName: 'general' },
      },
    })
    await spawnForRoute('C0AMDDZEHCY', { cwd: '/repo/general' }, cfg)
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].claude_instance_id).toBe('cscb_general_C0AMDDZEHCY')
    expect(spawnCalls[0].tmux_session_name).toBe('slack_bot_general_C0AMDDZEHCY')
  })

  test('falls back to bare-ID when route has no normalizedName', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeRoutingConfig({
      routes: { C_BARE: { cwd: '/repo' } },
    })
    await spawnForRoute('C_BARE', { cwd: '/repo' }, cfg)
    expect(spawnCalls[0].claude_instance_id).toBe('cscb_C_BARE')
    expect(spawnCalls[0].tmux_session_name).toBe('slack_bot_C_BARE')
  })

  test('collision-handling uses the same composed id for get/resume/delete', async () => {
    const getCalls: import('agent-director').GetParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      getCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_general_C', state: 'ended' }),
    })
    const cfg = makeRoutingConfig({
      routes: { C: { cwd: '/x', name: 'general', normalizedName: 'general' } },
    })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)
    expect(result.action).toBe('resumed')
    expect(getCalls[0].claude_instance_id).toBe('cscb_general_C')
    expect(resumeCalls[0].claude_instance_id).toBe('cscb_general_C')
  })
})

// ---------------------------------------------------------------------------
// b.1m9 — resolveChannelNames flow
// ---------------------------------------------------------------------------

describe('resolveChannelNames (b.1m9)', () => {
  test('populates route.name + route.normalizedName from conversations.info', async () => {
    const infoCalls: Array<{ channel: string }> = []
    const fakeWeb = {
      conversations: {
        info: async ({ channel }: { channel: string }) => {
          infoCalls.push({ channel })
          const nameMap: Record<string, string> = {
            C0AMDDZEHCY: 'general',
            C0B3X876XSB: 'horde-agent-director',
          }
          const name = nameMap[channel]
          return name ? { channel: { name } } : {}
        },
      },
    }
    const cfg = makeRoutingConfig({
      routes: {
        C0AMDDZEHCY: { cwd: '/repo/general' },
        C0B3X876XSB: { cwd: '/repo/agent-director' },
      },
    })
    const results = await resolveChannelNames(cfg, fakeWeb)
    expect(infoCalls.map((c) => c.channel).sort()).toEqual(['C0AMDDZEHCY', 'C0B3X876XSB'])
    expect(cfg.routes['C0AMDDZEHCY'].name).toBe('general')
    expect(cfg.routes['C0AMDDZEHCY'].normalizedName).toBe('general')
    expect(cfg.routes['C0B3X876XSB'].name).toBe('horde-agent-director')
    expect(cfg.routes['C0B3X876XSB'].normalizedName).toBe('horde_agent_director')
    expect(results).toHaveLength(2)
    for (const r of results) expect(r.error).toBeUndefined()
  })

  test('graceful fallback: conversations.info rejection leaves the route nameless', async () => {
    const fakeWeb = {
      conversations: {
        info: async ({ channel }: { channel: string }) => {
          if (channel === 'C_OK') return { channel: { name: 'okchan' } }
          throw new Error('not_authorized')
        },
      },
    }
    const cfg = makeRoutingConfig({
      routes: {
        C_OK: { cwd: '/a' },
        C_FAIL: { cwd: '/b' },
      },
    })
    const results = await resolveChannelNames(cfg, fakeWeb)
    expect(cfg.routes['C_OK'].normalizedName).toBe('okchan')
    expect(cfg.routes['C_FAIL'].name).toBeUndefined()
    expect(cfg.routes['C_FAIL'].normalizedName).toBeUndefined()
    const failResult = results.find((r) => r.channelId === 'C_FAIL')!
    expect(failResult.error).toContain('not_authorized')
  })

  test('graceful fallback: response without a channel.name leaves the route nameless', async () => {
    const fakeWeb = {
      conversations: {
        info: async () => ({}), // no channel field
      },
    }
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const results = await resolveChannelNames(cfg, fakeWeb)
    expect(cfg.routes['C'].normalizedName).toBeUndefined()
    expect(results[0].error).toContain('no name')
  })

  test('subsequent spawn for a name-fallback route uses bare-ID naming', async () => {
    // Composite: resolve fails → spawn falls back to cscb_<id>.
    const fakeWeb = {
      conversations: { info: async () => { throw new Error('boom') } },
    }
    const cfg = makeRoutingConfig({ routes: { C_X: { cwd: '/x' } } })
    await resolveChannelNames(cfg, fakeWeb)

    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    await spawnForRoute('C_X', { cwd: '/x' }, cfg)
    expect(spawnCalls[0].claude_instance_id).toBe('cscb_C_X')
    expect(spawnCalls[0].tmux_session_name).toBe('slack_bot_C_X')
  })

  test('undefined web → no-op (no rejections)', async () => {
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const results = await resolveChannelNames(cfg, undefined)
    expect(results).toEqual([])
    expect(cfg.routes['C'].name).toBeUndefined()
  })

  test('normalizes empty-string normalize result back to undefined', async () => {
    // Channel name with no alnum chars → normalize returns '', which would
    // produce ugly "slack_bot__C…" suffixes. The resolver should leave
    // normalizedName undefined in that case so the bare-ID fallback kicks in.
    const fakeWeb = {
      conversations: { info: async () => ({ channel: { name: '🎉' } }) },
    }
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    await resolveChannelNames(cfg, fakeWeb)
    expect(cfg.routes['C'].name).toBe('🎉')
    expect(cfg.routes['C'].normalizedName).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// b.1m9 — refreshRouteNameFromEvent
// ---------------------------------------------------------------------------

describe('refreshRouteNameFromEvent (b.1m9)', () => {
  test('updates route on channel_rename-shape event (channel + channel_name fields)', () => {
    const cfg = makeRoutingConfig({
      routes: { C0AMDDZEHCY: { cwd: '/x', name: 'oldname', normalizedName: 'oldname' } },
    })
    refreshRouteNameFromEvent(cfg, { channel: 'C0AMDDZEHCY', channel_name: 'new-name' })
    expect(cfg.routes['C0AMDDZEHCY'].name).toBe('new-name')
    expect(cfg.routes['C0AMDDZEHCY'].normalizedName).toBe('new_name')
  })

  test('updates route on nested-channel-object event shape', () => {
    const cfg = makeRoutingConfig({ routes: { C0AMDDZEHCY: { cwd: '/x' } } })
    refreshRouteNameFromEvent(cfg, { channel: { id: 'C0AMDDZEHCY', name: 'general' } })
    expect(cfg.routes['C0AMDDZEHCY'].name).toBe('general')
    expect(cfg.routes['C0AMDDZEHCY'].normalizedName).toBe('general')
  })

  test('no-ops when event has no channel name', () => {
    const cfg = makeRoutingConfig({
      routes: { C: { cwd: '/x', name: 'unchanged', normalizedName: 'unchanged' } },
    })
    refreshRouteNameFromEvent(cfg, { channel: 'C', type: 'message', text: 'hi' })
    expect(cfg.routes['C'].name).toBe('unchanged')
  })

  test('no-ops when channel is not in routes', () => {
    const cfg = makeRoutingConfig({ routes: { C_OTHER: { cwd: '/x' } } })
    refreshRouteNameFromEvent(cfg, { channel: 'C_NOT_ROUTED', channel_name: 'foo' })
    expect(cfg.routes['C_OTHER'].name).toBeUndefined()
  })

  test('no-ops when cached name already matches', () => {
    const cfg = makeRoutingConfig({
      routes: { C: { cwd: '/x', name: 'general', normalizedName: 'general' } },
    })
    refreshRouteNameFromEvent(cfg, { channel: 'C', channel_name: 'general' })
    expect(cfg.routes['C'].name).toBe('general')
    expect(cfg.routes['C'].normalizedName).toBe('general')
  })

  test('handles malformed event input safely', () => {
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    refreshRouteNameFromEvent(cfg, null)
    refreshRouteNameFromEvent(cfg, undefined)
    refreshRouteNameFromEvent(cfg, 'not-an-object')
    refreshRouteNameFromEvent(cfg, 42)
    expect(cfg.routes['C'].name).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// b.1m9 — reconcileInstanceIds migration warner / auto-delete
// ---------------------------------------------------------------------------

describe('reconcileInstanceIds (b.1m9)', () => {
  test('warns about stale bare-ID rows when new naming differs (no delete by default)', async () => {
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const warnings: string[] = []
    const originalErr = console.error
    console.error = ((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }) as typeof console.error
    try {
      installStub({
        deleteCalls,
        listResult: {
          spawns: [
            // Stale: cscb_C0AMDDZEHCY but route now expects cscb_general_C0AMDDZEHCY
            cannedListRow({
              claude_instance_id: 'cscb_C0AMDDZEHCY',
              labels: { service: 'cscb', channel: 'C0AMDDZEHCY' },
            }),
            // Already new-style: cscb_horde_C0B2A9D2THT — should not flag.
            cannedListRow({
              claude_instance_id: 'cscb_horde_C0B2A9D2THT',
              labels: { service: 'cscb', channel: 'C0B2A9D2THT' },
            }),
          ],
        },
      })
      const cfg = makeRoutingConfig({
        routes: {
          C0AMDDZEHCY: { cwd: '/a', name: 'general', normalizedName: 'general' },
          C0B2A9D2THT: { cwd: '/b', name: 'horde', normalizedName: 'horde' },
        },
      })
      const r = await reconcileInstanceIds(cfg, false)
      expect(r.orphans).toHaveLength(1)
      expect(r.orphans[0]).toEqual({
        channelId: 'C0AMDDZEHCY',
        oldInstanceId: 'cscb_C0AMDDZEHCY',
        expectedInstanceId: 'cscb_general_C0AMDDZEHCY',
      })
      expect(r.deleted).toBe(0)
      expect(deleteCalls).toHaveLength(0)
      // The operator-facing one-liner with the exact delete command must be present.
      const combined = warnings.join('\n')
      expect(combined).toContain('agent-director delete --claude-instance-id cscb_C0AMDDZEHCY')
    } finally {
      console.error = originalErr
    }
  })

  test('autoDelete=true issues delete for each orphan', async () => {
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      deleteCalls,
      listResult: {
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_C0AMDDZEHCY',
            labels: { service: 'cscb', channel: 'C0AMDDZEHCY' },
          }),
          cannedListRow({
            claude_instance_id: 'cscb_C0B2A9D2THT',
            labels: { service: 'cscb', channel: 'C0B2A9D2THT' },
          }),
        ],
      },
    })
    const cfg = makeRoutingConfig({
      routes: {
        C0AMDDZEHCY: { cwd: '/a', name: 'general', normalizedName: 'general' },
        C0B2A9D2THT: { cwd: '/b', name: 'horde', normalizedName: 'horde' },
      },
    })
    const r = await reconcileInstanceIds(cfg, true)
    expect(r.orphans).toHaveLength(2)
    expect(r.deleted).toBe(2)
    expect(r.failed).toBe(0)
    const deletedIds = deleteCalls.flatMap((d) => d.claude_instance_id).sort()
    expect(deletedIds).toEqual(['cscb_C0AMDDZEHCY', 'cscb_C0B2A9D2THT'])
  })

  test('no orphans when every row matches the expected new naming', async () => {
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      deleteCalls,
      listResult: {
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_general_C0AMDDZEHCY',
            labels: { service: 'cscb', channel: 'C0AMDDZEHCY' },
          }),
        ],
      },
    })
    const cfg = makeRoutingConfig({
      routes: { C0AMDDZEHCY: { cwd: '/a', name: 'general', normalizedName: 'general' } },
    })
    const r = await reconcileInstanceIds(cfg, true)
    expect(r.orphans).toEqual([])
    expect(r.deleted).toBe(0)
    expect(deleteCalls).toHaveLength(0)
  })

  test('rows without a route entry are skipped (handled by reconcileOrphans)', async () => {
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      deleteCalls,
      listResult: {
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_C_NOT_CONFIGURED',
            labels: { service: 'cscb', channel: 'C_NOT_CONFIGURED' },
          }),
        ],
      },
    })
    const cfg = makeRoutingConfig({ routes: { C_OTHER: { cwd: '/x' } } })
    const r = await reconcileInstanceIds(cfg, true)
    expect(r.orphans).toEqual([])
    expect(deleteCalls).toHaveLength(0)
  })

  test('list failure → empty result, no crash', async () => {
    installStub({ listError: new Error('AD down') })
    const cfg = makeRoutingConfig({
      routes: { C: { cwd: '/x', name: 'g', normalizedName: 'g' } },
    })
    const r = await reconcileInstanceIds(cfg, true)
    expect(r.orphans).toEqual([])
    expect(r.deleted).toBe(0)
  })

  test('mixed routes: some new, some bare — only the bare get flagged', async () => {
    installStub({
      listResult: {
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_general_C1',
            labels: { service: 'cscb', channel: 'C1' },
          }),
          cannedListRow({
            claude_instance_id: 'cscb_C2',
            labels: { service: 'cscb', channel: 'C2' },
          }),
          cannedListRow({
            claude_instance_id: 'cscb_horde_C3',
            labels: { service: 'cscb', channel: 'C3' },
          }),
        ],
      },
    })
    const cfg = makeRoutingConfig({
      routes: {
        C1: { cwd: '/1', name: 'general', normalizedName: 'general' },
        C2: { cwd: '/2', name: 'horde', normalizedName: 'horde' },
        C3: { cwd: '/3', name: 'horde', normalizedName: 'horde' },
      },
    })
    const r = await reconcileInstanceIds(cfg, false)
    expect(r.orphans).toHaveLength(1)
    expect(r.orphans[0].channelId).toBe('C2')
    expect(r.orphans[0].oldInstanceId).toBe('cscb_C2')
    expect(r.orphans[0].expectedInstanceId).toBe('cscb_horde_C2')
  })
})

// ---------------------------------------------------------------------------
// b.en2 Epic 4 — wrapper-migration assertions
// ---------------------------------------------------------------------------

// Shared constants for wrapper tests
const BIN = '/usr/bin/agent-director'
const CWD = '/test/cwd'

// ---------------------------------------------------------------------------
// Group A: 13 non-dialog wrapped catch sites
// Each asserts: outage-class typed error raises the matching flag AND
// postSpawnFailureToChannel (web.chat.postMessage) is NOT invoked.
// ---------------------------------------------------------------------------

describe('wrapper-migration: non-dialog outage cases (Group A)', () => {
  // -------------------------------------------------------------------------
  // Site #1 — reconnectMcp → sendKeys
  // -------------------------------------------------------------------------

  test('site #1: reconnectMcp ErrSystemInstallDisappeared → ad-unreachable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({ sendKeysError: new ErrSystemInstallDisappeared('send-keys', BIN) })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })
    const result = await reconnectMcp('C', web as never, cfg)
    expect(result).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('site #1b: reconnectMcp ErrTmuxNotAvailable → tmux-unavailable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({ sendKeysError: new ErrTmuxNotAvailable('send-keys', 'ErrTmuxNotAvailable', 'tmux not available') })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })
    const result = await reconnectMcp('C', web as never, cfg)
    expect(result).toBe('failed')
    expect(getOutageFlags('C').has('tmux-unavailable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #8 — waitForWaitingAndReconnect → status
  // -------------------------------------------------------------------------

  test('site #8: waitForWaitingAndReconnect ErrSystemInstallDisappeared → ad-unreachable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    _setWaitForWaitingTimeoutMs(50)
    installStub({ statusError: new ErrSystemInstallDisappeared('status', BIN) })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })
    const result = await waitForWaitingAndReconnect('C', cfg, web as never)
    expect(result).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #9 — tryKill → kill (tested via spawnForRoute collision path)
  // kill errors are silently ignored by tryKill, but the outage flag IS raised.
  // -------------------------------------------------------------------------

  test('site #9: tryKill kill ErrSystemInstallDisappeared → ad-unreachable, error ignored (no postSpawnFailureToChannel)', async () => {
    const { web, calls } = makeMockWeb()
    // collision → get=ended → resume_enabled=false → kill throws (flag set, ignored)
    // delete also throws so flow terminates without a fresh spawn that would clear the flag
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
      killError: new ErrSystemInstallDisappeared('kill', BIN),
      deleteError: new ErrSystemInstallDisappeared('delete', BIN),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } }, resume_enabled: false })
    const result = await spawnForRoute('C', { cwd: CWD }, cfg, web as never)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #10 — tryDelete → delete
  // -------------------------------------------------------------------------

  test('site #10: tryDelete delete ErrSystemInstallDisappeared → ad-unreachable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
      // kill succeeds; delete fails with typed outage error
      deleteError: new ErrSystemInstallDisappeared('delete', BIN),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } }, resume_enabled: false })
    const result = await spawnForRoute('C', { cwd: CWD }, cfg, web as never)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #11 — spawnForRoute initial spawn (withSpawnDetection)
  // -------------------------------------------------------------------------

  test('site #11: initial spawn ErrSystemInstallDisappeared → ad-unreachable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({ spawnError: new ErrSystemInstallDisappeared('spawn', BIN) })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })
    const result = await spawnForRoute('C', { cwd: CWD }, cfg, web as never)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('site #11b: initial spawn ErrCwdNotFound → cwd-unreachable with route.cwd as detail, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({ spawnError: new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${CWD} does not exist`) })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })
    const result = await spawnForRoute('C', { cwd: CWD }, cfg, web as never)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    // The detail should be route.cwd (from withSpawnDetection's routeCwd arg)
    expect(outageEmissions.some(e => e.text.includes(CWD))).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #12 — spawnForRoute collision-get (withOutageDetection)
  // -------------------------------------------------------------------------

  test('site #12: collision-get ErrSystemInstallDisappeared → ad-unreachable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getError: new ErrSystemInstallDisappeared('get', BIN),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })
    const result = await spawnForRoute('C', { cwd: CWD }, cfg, web as never)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #13 — spawnForRoute retry-spawn after ErrSpawnNotFound
  // -------------------------------------------------------------------------

  test('site #13: retry-spawn after ErrSpawnNotFound ErrSystemInstallDisappeared → ad-unreachable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrSystemInstallDisappeared('spawn', BIN)),
      ],
      getError: errSpawnNotFound(),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })
    const result = await spawnForRoute('C', { cwd: CWD }, cfg, web as never)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #14 — spawnForRoute fresh-spawn after kill+delete (resume_enabled=false)
  // -------------------------------------------------------------------------

  test('site #14: fresh-spawn after kill+delete ErrCwdNotFound → cwd-unreachable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${CWD} does not exist`)),
      ],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } }, resume_enabled: false })
    const result = await spawnForRoute('C', { cwd: CWD }, cfg, web as never)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #15 — spawnForRoute resume (withSpawnDetection)
  // -------------------------------------------------------------------------

  test('site #15: resume ErrSystemInstallDisappeared → ad-unreachable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
      resumeError: new ErrSystemInstallDisappeared('resume', BIN),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })
    const result = await spawnForRoute('C', { cwd: CWD }, cfg, web as never)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #16 — spawnForRoute spawn after ErrNoSessionId → delete → spawn
  // -------------------------------------------------------------------------

  test('site #16: spawn after ErrNoSessionId-delete ErrCwdNotFound → cwd-unreachable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${CWD} does not exist`)),
      ],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
      resumeError: errNoSessionId(),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })
    const result = await spawnForRoute('C', { cwd: CWD }, cfg, web as never)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #17 — spawnForRoute spawn after ErrSpawnNotResumable → kill+delete → spawn
  // -------------------------------------------------------------------------

  test('site #17: spawn after ErrSpawnNotResumable kill+delete ErrSystemInstallDisappeared → ad-unreachable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrSystemInstallDisappeared('spawn', BIN)),
      ],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
      resumeError: errSpawnNotResumable(),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })
    const result = await spawnForRoute('C', { cwd: CWD }, cfg, web as never)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #18 — reconcileInstanceIds per-orphan delete (withOutageDetection)
  // -------------------------------------------------------------------------

  test('site #18: reconcileInstanceIds per-orphan delete ErrSystemInstallDisappeared → ad-unreachable, counted as failed', async () => {
    installStub({
      listResult: {
        spawns: [
          cannedListRow({
            claude_instance_id: 'cscb_C_OLD',
            labels: { service: 'cscb', channel: 'C_REC' },
          }),
        ],
      },
      deleteError: new ErrSystemInstallDisappeared('delete', BIN),
    })
    const cfg = makeRoutingConfig({
      routes: { C_REC: { cwd: CWD, name: 'new_name', normalizedName: 'new_name' } },
    })
    const result = await reconcileInstanceIds(cfg, true)
    expect(result.deleted).toBe(0)
    expect(result.failed).toBe(1)
    expect(getOutageFlags('C_REC').has('ad-unreachable')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Group B: 6 dialog wrapped catch sites (sites #2-#7)
// Each asserts: (a) dialog function returns normally, (b) ad-unreachable flag
// is raised, (c) binaryPath detail is captured in the onset emission.
// Uses poll seams to keep tests near-instant.
// ---------------------------------------------------------------------------

describe('wrapper-migration: dialog outage cases (Group B)', () => {
  const CH = 'C_DIALOG'
  const errSID = () => new ErrSystemInstallDisappeared('read-pane', BIN)

  // -------------------------------------------------------------------------
  // Merged approvePreSessionDialogs — 3 wrapped call sites: status, readPane,
  // sendKeys. Each exercises an AD-outage error at one site, asserting the
  // outage flag is raised and the function resolves normally.
  // -------------------------------------------------------------------------

  test('status outage: status always throws ErrSystemInstallDisappeared → ad-unreachable, resolves (cap hit)', async () => {
    _setDialogReadyTimeoutMs(50)
    installStub({ statusError: errSID() })
    // status throws every poll → transient → cap hit → resolves
    await expect(approvePreSessionDialogs(CH, undefined, false)).resolves.toBeUndefined()
    expect(getOutageFlags(CH).has('ad-unreachable')).toBe(true)
    expect(outageEmissions.some(e => e.channelId === CH && e.text.includes(BIN))).toBe(true)
  })

  test('readPane outage: status=pending, readPane throws ErrSystemInstallDisappeared → ad-unreachable, resolves (cap hit)', async () => {
    _setDialogReadyTimeoutMs(50)
    installStub({
      statusResult: { state: 'pending' },
      readPaneError: errSID(),
    })
    await expect(approvePreSessionDialogs(CH, undefined, false)).resolves.toBeUndefined()
    expect(getOutageFlags(CH).has('ad-unreachable')).toBe(true)
    expect(outageEmissions.some(e => e.channelId === CH && e.text.includes(BIN))).toBe(true)
  })

  test('sendKeys outage: status=pending + dialog pane, sendKeys throws ErrSystemInstallDisappeared → ad-unreachable, resolves (cap hit)', async () => {
    _setDialogReadyTimeoutMs(50)
    // readPane returns the dialog needle so sendKeys is reached; sendKeys throws
    installStub({
      statusResult: { state: 'pending' },
      readPaneResults: [{ pane: DEV_CHANNELS_DIALOG_NEEDLE }],
      sendKeysError: new ErrSystemInstallDisappeared('send-keys', BIN),
    })
    await expect(approvePreSessionDialogs(CH, undefined, false)).resolves.toBeUndefined()
    expect(getOutageFlags(CH).has('ad-unreachable')).toBe(true)
    expect(outageEmissions.some(e => e.channelId === CH && e.text.includes(BIN))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Group C: spawn/resume success-clear (sites #11, #13, #14, #15, #16, #17)
// Each pre-sets all three outage flags then exercises a spawn/resume success
// path, asserting flags are empty and exactly one all-clear was emitted
// naming all three classes.
// ---------------------------------------------------------------------------

describe('wrapper-migration: spawn/resume success-clear (Group C)', () => {
  const CH = 'C_CLEAR'

  function setupFlags(): void {
    preSetAllFlags(CH)
    outageEmissions = [] // reset after pre-set; only capture all-clear from success path
  }

  function assertAllClear(): void {
    expect(getOutageFlags(CH).size).toBe(0)
    const allClear = outageEmissions.filter(e => e.channelId === CH && e.text.includes('All clear'))
    expect(allClear).toHaveLength(1)
    expect(allClear[0].text).toContain('ad-unreachable')
    expect(allClear[0].text).toContain('cwd-unreachable')
    expect(allClear[0].text).toContain('tmux-unavailable')
  }

  // -------------------------------------------------------------------------
  // Site #11 — initial spawn success
  // -------------------------------------------------------------------------

  test('site #11: initial spawn success clears all three flags + emits all-clear', async () => {
    setupFlags()
    installStub({})
    const cfg = makeRoutingConfig({ routes: { [CH]: { cwd: CWD } } })
    const result = await spawnForRoute(CH, { cwd: CWD }, cfg, undefined, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #13 — retry-spawn after ErrSpawnNotFound success
  // -------------------------------------------------------------------------

  test('site #13: retry-spawn after ErrSpawnNotFound success clears all three flags', async () => {
    setupFlags()
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getError: errSpawnNotFound(),
    })
    const cfg = makeRoutingConfig({ routes: { [CH]: { cwd: CWD } } })
    const result = await spawnForRoute(CH, { cwd: CWD }, cfg, undefined, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #14 — fresh-spawn after kill+delete (resume_enabled=false) success
  // -------------------------------------------------------------------------

  test('site #14: fresh-spawn after kill+delete (resume_enabled=false) clears all three flags', async () => {
    setupFlags()
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getResult: cannedGetResult({ claude_instance_id: `cscb_${CH}`, state: 'ended' }),
    })
    const cfg = makeRoutingConfig({ routes: { [CH]: { cwd: CWD } }, resume_enabled: false })
    const result = await spawnForRoute(CH, { cwd: CWD }, cfg, undefined, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #15 — resume success
  // -------------------------------------------------------------------------

  test('site #15: resume success clears all three flags + emits all-clear', async () => {
    setupFlags()
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: `cscb_${CH}`, state: 'ended' }),
    })
    const cfg = makeRoutingConfig({ routes: { [CH]: { cwd: CWD } } })
    const result = await spawnForRoute(CH, { cwd: CWD }, cfg, undefined, false)
    expect(result.action).toBe('resumed')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #16 — fresh-spawn after ErrNoSessionId → delete → spawn success
  // -------------------------------------------------------------------------

  test('site #16: spawn after ErrNoSessionId-delete success clears all three flags', async () => {
    setupFlags()
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getResult: cannedGetResult({ claude_instance_id: `cscb_${CH}`, state: 'ended' }),
      resumeError: errNoSessionId(),
    })
    const cfg = makeRoutingConfig({ routes: { [CH]: { cwd: CWD } } })
    const result = await spawnForRoute(CH, { cwd: CWD }, cfg, undefined, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #17 — fresh-spawn after ErrSpawnNotResumable → kill+delete → spawn success
  // -------------------------------------------------------------------------

  test('site #17: spawn after ErrSpawnNotResumable kill+delete success clears all three flags', async () => {
    setupFlags()
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getResult: cannedGetResult({ claude_instance_id: `cscb_${CH}`, state: 'ended' }),
      resumeError: errSpawnNotResumable(),
    })
    const cfg = makeRoutingConfig({ routes: { [CH]: { cwd: CWD } } })
    const result = await spawnForRoute(CH, { cwd: CWD }, cfg, undefined, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })
})
