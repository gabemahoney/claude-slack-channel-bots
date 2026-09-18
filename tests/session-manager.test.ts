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
  _setTmuxCapturePane,
  _setTmuxSendEnter,
  _resetTmuxDialogHelpers,
  _setDialogDeadGracePolls,
  _resetDialogDeadGracePolls,
  _setTmuxProbeForTests,
  _resetTmuxProbeForTests,
} from '../src/session-manager.ts'
import { resetClientForTests, setClientForTests, getClient } from '../src/agent-director-client.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedOk,
  cannedErr,
  errInstanceIdCollision,
  errNoSessionId,
  errJsonlMissing,
  errGeneric,
  errSpawnNotFound,
  errSpawnNotResumable,
  errSpawnNotInteractive,
  errTmuxSessionCreate,
  errTmuxSendKeysNotFound,
  errTmuxSendKeysGeneric,
  errCallTimeout,
  makeStubClient,
  type StubClient,
} from './test-helpers/agent-director-stub.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'
import {
  makeStubTmuxProbe,
  makeStubTmuxProbeQueue,
} from './test-helpers/tmux-probe-stub.ts'
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
  // t1.a3g.mb: install a safe always-alive probe stub so the collision branch
  // never shells out to real tmux in CI. Tests that exercise dead/transient
  // probe behavior must install their own probe stub via _setTmuxProbeForTests
  // or pass a per-call probe to spawnForRoute. The Test Writer (epic mb test
  // subtasks) will complete per-test stubbing for the new probe-aware paths.
  _setTmuxProbeForTests(async (_sessionName) => ({
    classification: 'definitely-alive',
    signal: 'exit-0',
  }))
})

afterEach(() => {
  resetClientForTests()
  _resetDialogPollIntervalMs()
  _resetDialogReadyTimeoutMs()
  _resetWaitForWaitingTimeoutMs()
  _resetTmuxSessionKiller()
  _resetTmuxDialogHelpers()
  _resetDialogDeadGracePolls()
  _resetTmuxProbeForTests()
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
    expect(result).toBe('transient') // was: false (u4 test subtask owns full migration)
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('site #1b: reconnectMcp ErrTmuxNotAvailable → tmux-unavailable, no postSpawnFailureToChannel', async () => {
    const { web, calls } = makeMockWeb()
    installStub({ sendKeysError: new ErrTmuxNotAvailable('send-keys', 'ErrTmuxNotAvailable', 'tmux not available') })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })
    const result = await reconnectMcp('C', web as never, cfg)
    expect(result).toBe('transient') // was: false (u4 test subtask owns full migration)
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
    expect(result).toBe('transient') // was: false (u4 test subtask owns full migration)
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

// ---------------------------------------------------------------------------
// t3.a3g.mb.95.i4 — Alive/transient escape-hatch closure (SR-20.4, SR-29.3)
//
// PM ruling 2: with the always-on probe, every pre-existing live-state
// collision test must inject an explicit probe stub. This describe block
// injects definitely-alive stubs into copies of those tests and adds:
//  - Alive pins: waiting→reconnected; working→wait-then-reconnect; pending/
//    check_permission/ask_user→no-op
//  - Five transient pins (one per live state: zero mutation, zero kill/resume/delete)
//
// Note: "zero kills" here means zero AD client.kill() calls (killCalls) —
// the probe bundle's killSession method is a separate utility and is never
// called by production code paths tested here.
// ---------------------------------------------------------------------------

describe('SR-20.4 / SR-29.3: alive/transient escape-hatch closure (i4)', () => {
  // -------------------------------------------------------------------------
  // Alive pins: existing collision behaviors preserved with explicit probe stubs.
  // The only addition vs. the originals above is the explicit probe injection.
  // -------------------------------------------------------------------------

  test('[alive-pin] waiting + definitely-alive → reconnectMcp (sendKeys /mcp reconnect)', async () => {
    const { probe } = makeStubTmuxProbe('definitely-alive')
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    // Explicit alive probe — no escape hatch remains.
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)
    expect(result.action).toBe('reconnected')
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toContain('/mcp reconnect')
  })

  test('[alive-pin] working + definitely-alive → waitForWaitingAndReconnect path (action reconnected)', async () => {
    const { probe } = makeStubTmuxProbe('definitely-alive')
    // waitForWaitingAndReconnect polls status at agent_director_poll_interval_ms.
    // Set poll interval to 1ms so the test completes immediately.
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    _setWaitForWaitingTimeoutMs(500)
    installStub({
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'working' }),
      statusQueue: [
        cannedOk({ state: 'working' }),
        cannedOk({ state: 'waiting' }),
      ],
    })
    // agent_director_poll_interval_ms: 1 avoids the 1-second default poll sleep.
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)
    expect(result.action).toBe('reconnected')
    expect(sendKeysCalls).toHaveLength(1)
  })

  test('[alive-pin] pending + definitely-alive → no-op (zero AD kill/resume/delete calls)', async () => {
    const { probe } = makeStubTmuxProbe('definitely-alive')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'pending' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)
    expect(result.action).toBe('no-op')
    expect(killCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
  })

  test('[alive-pin] check_permission + definitely-alive → no-op (zero AD kill/resume/delete calls)', async () => {
    const { probe } = makeStubTmuxProbe('definitely-alive')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'check_permission' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)
    expect(result.action).toBe('no-op')
    expect(killCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
  })

  test('[alive-pin] ask_user + definitely-alive → no-op (zero AD kill/resume/delete calls)', async () => {
    const { probe } = makeStubTmuxProbe('definitely-alive')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ask_user' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)
    expect(result.action).toBe('no-op')
    expect(killCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Five transient pins — one per live state.
  // transient-inconclusive → today's exact action; zero AD kill/resume/delete.
  // -------------------------------------------------------------------------

  test('[transient-pin] waiting + transient → reconnected, zero AD kill/resume/delete calls', async () => {
    const { probe } = makeStubTmuxProbe('transient-inconclusive')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)
    expect(result.action).toBe('reconnected')
    expect(killCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
  })

  test('[transient-pin] working + transient → reconnected, zero AD kill/resume/delete calls', async () => {
    const { probe } = makeStubTmuxProbe('transient-inconclusive')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    _setWaitForWaitingTimeoutMs(500)
    installStub({
      killCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'working' }),
      statusQueue: [
        cannedOk({ state: 'working' }),
        cannedOk({ state: 'waiting' }),
      ],
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, agent_director_poll_interval_ms: 1 })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)
    expect(result.action).toBe('reconnected')
    expect(killCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
  })

  test('[transient-pin] pending + transient → no-op, zero AD kill/resume/delete calls', async () => {
    const { probe } = makeStubTmuxProbe('transient-inconclusive')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'pending' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)
    expect(result.action).toBe('no-op')
    expect(killCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
  })

  test('[transient-pin] check_permission + transient → no-op, zero AD kill/resume/delete calls', async () => {
    const { probe } = makeStubTmuxProbe('transient-inconclusive')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'check_permission' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)
    expect(result.action).toBe('no-op')
    expect(killCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
  })

  test('[transient-pin] ask_user + transient → no-op, zero AD kill/resume/delete calls', async () => {
    const { probe } = makeStubTmuxProbe('transient-inconclusive')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ask_user' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)
    expect(result.action).toBe('no-op')
    expect(killCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// t3.a3g.mb.95.tj — SR-29.2 #2: dead-probe waiting/working steered to resume
//
// Root-cause test pair. Pre-fix: waiting→reconnectMcp regardless of tmux
// reality. Post-fix (2befca7): definitely-dead probe steers to resume.
// These tests document the red→green transition.
//
// Pre-fix failure mode:
//  - Test 1 (waiting + dead): would get action='reconnected', not 'resumed'
//  - Test 2 (working + dead): would get action='reconnected', not 'resumed'
//
// Note on kill semantics: the "steering kill" is AD client.kill() (via tryKill),
// captured by killCalls on the stub. The probe bundle's killSession utility is
// separate and is never called by production spawnForRoute code.
// ---------------------------------------------------------------------------

describe('SR-29.2 #2: dead-probe waiting/working steered to resume (tj)', () => {
  // SR-29.2 #2 test 1: waiting row + dead probe → resumed
  // Pre-fix failure: waiting→reconnectMcp (sendKeys /mcp reconnect) regardless
  // of tmux reality. Post-fix: definitely-dead probe steers to resume branch.
  test('SR-29.2 #2.1: waiting + dead probe → resumed, one resume call, one steering kill, zero sendKeys', async () => {
    const { probe } = makeStubTmuxProbe('definitely-dead')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      // waiting state — non-empty claude_session_id (usable session id present)
      getResult: cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'waiting',
        claude_session_id: 'sess-abc123',
      }),
      // approvePreSessionDialogs: status returns 'waiting' so it exits immediately
      statusResult: { state: 'waiting' },
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)

    // Post-fix: steered to resume branch.
    expect(result.action).toBe('resumed')
    // Exactly one steering kill (AD client.kill via tryKill, before state reassignment).
    expect(killCalls).toHaveLength(1)
    expect(killCalls[0].claude_instance_id).toBe('cscb_C')
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0].claude_instance_id).toBe('cscb_C')
    // Zero sendKeys — reconnectMcp was NOT called.
    expect(sendKeysCalls).toHaveLength(0)
  })

  // SR-29.2 #2 test 2: working row + dead probe → resumed
  // Pre-fix failure: working→waitForWaitingAndReconnect regardless of tmux
  // reality. Post-fix: definitely-dead probe steers to resume branch, and
  // waitForWaitingAndReconnect's status polling is never entered.
  test('SR-29.2 #2.2: working + dead probe → resumed, one resume call, one steering kill, zero sendKeys', async () => {
    const { probe } = makeStubTmuxProbe('definitely-dead')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const statusCalls: import('agent-director').StatusParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      sendKeysCalls,
      statusCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      // working state with usable claude_session_id
      getResult: cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'working',
        claude_session_id: 'sess-def456',
      }),
      // approvePreSessionDialogs: status returns 'waiting' so it exits immediately.
      // If dead-probe steering is correct, waitForWaitingAndReconnect is never entered
      // (which would poll status multiple times before reconnectMcp fires sendKeys).
      statusResult: { state: 'waiting' },
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)

    // Post-fix: steered to resume branch.
    expect(result.action).toBe('resumed')
    // Exactly one steering kill (AD client.kill via tryKill).
    expect(killCalls).toHaveLength(1)
    expect(killCalls[0].claude_instance_id).toBe('cscb_C')
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0].claude_instance_id).toBe('cscb_C')
    // Zero sendKeys — waitForWaitingAndReconnect was NOT entered.
    expect(sendKeysCalls).toHaveLength(0)
    // Status calls come only from approvePreSessionDialogs (returns immediately
    // on 'waiting'). No multi-poll waitForWaiting sequence.
    expect(statusCalls.length).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// t3.a3g.mb.95.v5 — SR-21.3: pending-trio dead-probe resume and rejection fallbacks
//
// Dead-probed pending/check_permission/ask_user rows: resume ATTEMPTED (never
// pre-guessed from DB state). Usable-id → 'resumed'. Rejection → delete+fresh.
//
// Kill semantics: the steering kill is AD client.kill() captured by killCalls.
// ---------------------------------------------------------------------------

describe('SR-21.3: pending-trio dead-probe resume and rejection fallbacks (v5)', () => {
  // -------------------------------------------------------------------------
  // Usable-id path: all three pending-trio states → resumed
  // -------------------------------------------------------------------------

  test('pending + dead probe + usable claude_session_id → resumed, one resume, one steering kill, zero deletes', async () => {
    const { probe } = makeStubTmuxProbe('definitely-dead')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'pending',
        claude_session_id: 'sess-pending-abc',
      }),
      statusResult: { state: 'waiting' },
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)

    expect(result.action).toBe('resumed')
    expect(killCalls).toHaveLength(1) // steering kill
    expect(killCalls[0].claude_instance_id).toBe('cscb_C')
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0].claude_instance_id).toBe('cscb_C')
    expect(deleteCalls).toHaveLength(0) // no delete on resume success
  })

  test('check_permission + dead probe + usable claude_session_id → resumed, one resume, one steering kill, zero deletes', async () => {
    const { probe } = makeStubTmuxProbe('definitely-dead')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'check_permission',
        claude_session_id: 'sess-chkperm-abc',
      }),
      statusResult: { state: 'waiting' },
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)

    expect(result.action).toBe('resumed')
    expect(killCalls).toHaveLength(1)
    expect(killCalls[0].claude_instance_id).toBe('cscb_C')
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0].claude_instance_id).toBe('cscb_C')
    expect(deleteCalls).toHaveLength(0)
  })

  test('ask_user + dead probe + usable claude_session_id → resumed, one resume, one steering kill, zero deletes', async () => {
    const { probe } = makeStubTmuxProbe('definitely-dead')
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'ask_user',
        claude_session_id: 'sess-askuser-abc',
      }),
      statusResult: { state: 'waiting' },
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)

    expect(result.action).toBe('resumed')
    expect(killCalls).toHaveLength(1)
    expect(killCalls[0].claude_instance_id).toBe('cscb_C')
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0].claude_instance_id).toBe('cscb_C')
    expect(deleteCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Rejection path: errNoSessionId → delete AFTER resume attempt + fresh spawn
  // -------------------------------------------------------------------------

  test('pending + dead probe + errNoSessionId → resume ATTEMPTED first, then delete + fresh spawn', async () => {
    const { probe } = makeStubTmuxProbe('definitely-dead')
    const callOrder: string[] = []
    // Instrument via stub overrides to capture call ordering.
    const stub = installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'pending',
        claude_session_id: 'sess-pending-xyz',
      }),
      resumeError: errNoSessionId(),
      statusResult: { state: 'waiting' },
    })
    const origResume = stub.resume.bind(stub)
    stub.resume = async (params) => { callOrder.push('resume'); return origResume(params) }
    const origDelete = stub.delete.bind(stub)
    stub.delete = async (params) => { callOrder.push('delete'); return origDelete(params) }
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)

    expect(result.action).toBe('spawned')
    // Resume attempted first, then delete (ordering assertion via call-capture array).
    const resumeDeleteOrder = callOrder.filter(k => k === 'resume' || k === 'delete')
    expect(resumeDeleteOrder).toEqual(['resume', 'delete'])
  })

  // -------------------------------------------------------------------------
  // Rejection path: errJsonlMissing → delete AFTER resume attempt + fresh spawn
  // -------------------------------------------------------------------------

  test('pending + dead probe + errJsonlMissing → resume ATTEMPTED first, then delete + fresh spawn', async () => {
    const { probe } = makeStubTmuxProbe('definitely-dead')
    const callOrder: string[] = []
    const stub = installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'pending',
        claude_session_id: 'sess-pending-jsonl',
      }),
      resumeError: errJsonlMissing(),
      statusResult: { state: 'waiting' },
    })
    const origResume = stub.resume.bind(stub)
    stub.resume = async (params) => { callOrder.push('resume'); return origResume(params) }
    const origDelete = stub.delete.bind(stub)
    stub.delete = async (params) => { callOrder.push('delete'); return origDelete(params) }
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)

    expect(result.action).toBe('spawned')
    // Resume attempted first, then delete.
    const resumeDeleteOrder = callOrder.filter(k => k === 'resume' || k === 'delete')
    expect(resumeDeleteOrder).toEqual(['resume', 'delete'])
  })
})

// ---------------------------------------------------------------------------
// t3.a3g.mb.95.jz — SR-23.1: delete-ordering invariant
//
// Hard invariant: delete only after resume rejection proves the id unusable.
// Call ORDER matters (not just counts). All kill calls here are AD client.kill()
// captured by killCalls; the probe bundle's killSession is a separate utility.
// ---------------------------------------------------------------------------

describe('SR-23.1: delete-ordering invariant (jz)', () => {
  // (1) waiting + dead probe + resume succeeds → zero deletes
  test('waiting + dead probe + resume succeeds → zero deletes', async () => {
    const { probe } = makeStubTmuxProbe('definitely-dead')
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      deleteCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'waiting',
        claude_session_id: 'sess-abc',
      }),
      statusResult: { state: 'waiting' },
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)

    expect(result.action).toBe('resumed')
    expect(deleteCalls).toHaveLength(0)
  })

  // (2) waiting + dead probe + errNoSessionId → exactly one delete AFTER the resume call
  test('waiting + dead probe + errNoSessionId → delete recorded AFTER resume call (sequence assertion)', async () => {
    const { probe } = makeStubTmuxProbe('definitely-dead')
    const callOrder: string[] = []
    const stub = installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'waiting',
        claude_session_id: 'sess-abc',
      }),
      resumeError: errNoSessionId(),
      statusResult: { state: 'waiting' },
    })
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const origResume = stub.resume.bind(stub)
    stub.resume = async (params) => {
      callOrder.push('resume')
      resumeCalls.push(params)
      return origResume(params)
    }
    const origDelete = stub.delete.bind(stub)
    stub.delete = async (params) => {
      callOrder.push('delete')
      deleteCalls.push(params)
      return origDelete(params)
    }
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)

    expect(result.action).toBe('spawned')
    // Exactly one resume (which threw errNoSessionId).
    expect(resumeCalls).toHaveLength(1)
    // Exactly one delete.
    expect(deleteCalls).toHaveLength(1)
    // Critical ordering: resume is recorded BEFORE delete.
    const idx_resume = callOrder.indexOf('resume')
    const idx_delete = callOrder.indexOf('delete')
    expect(idx_resume).toBeGreaterThanOrEqual(0)
    expect(idx_delete).toBeGreaterThanOrEqual(0)
    expect(idx_resume).toBeLessThan(idx_delete)
  })

  // (3) errSpawnNotResumable → steering kill, then resume attempt, then kill+delete after rejection
  // Sequence: [kill(steering), resume(throws ErrSpawnNotResumable), kill(ladder), delete, spawn]
  test('waiting + dead probe + errSpawnNotResumable → steering kill first, resume, then kill+delete+fresh', async () => {
    const { probe } = makeStubTmuxProbe('definitely-dead')
    const callOrder: string[] = []
    const stub = installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'waiting',
        claude_session_id: 'sess-abc',
      }),
      resumeError: errSpawnNotResumable(),
      statusResult: { state: 'waiting' },
    })
    const killCalls: import('agent-director').KillParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const origKill = stub.kill.bind(stub)
    stub.kill = async (params) => {
      callOrder.push('kill')
      killCalls.push(params)
      return origKill(params)
    }
    const origResume = stub.resume.bind(stub)
    stub.resume = async (params) => {
      callOrder.push('resume')
      resumeCalls.push(params)
      return origResume(params)
    }
    const origDelete = stub.delete.bind(stub)
    stub.delete = async (params) => {
      callOrder.push('delete')
      deleteCalls.push(params)
      return origDelete(params)
    }
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)

    expect(result.action).toBe('spawned')
    // Two AD kill calls: one steering (before resume), one from ErrSpawnNotResumable ladder.
    expect(killCalls).toHaveLength(2)
    expect(resumeCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
    // Ordering: steering kill → resume (throws) → ladder kill → delete.
    const idx_first_kill = callOrder.indexOf('kill')
    const idx_resume = callOrder.indexOf('resume')
    const idx_last_kill = callOrder.lastIndexOf('kill')
    const idx_delete = callOrder.indexOf('delete')
    expect(idx_first_kill).toBeLessThan(idx_resume) // steering kill before resume
    expect(idx_resume).toBeLessThan(idx_last_kill)  // ladder kill after resume rejection
    expect(idx_last_kill).toBeLessThan(idx_delete)  // delete after ladder kill
  })

  // (4) resume_enabled=false with ended state → kill+delete+fresh unchanged
  // ended state bypasses the probe (not in LIVE_STATES) so the always-alive
  // beforeEach default handles it. This pin verifies the existing behavior.
  test('resume_enabled=false + ended state → kill+delete+fresh unchanged (no probe concern)', async () => {
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      resumeCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'ended' }),
      // approvePreSessionDialogs: status returns 'waiting' immediately.
      statusResult: { state: 'waiting' },
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } }, resume_enabled: false })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    expect(result.action).toBe('spawned')
    expect(resumeCalls).toHaveLength(0) // no resume on resume_enabled=false
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// t3.a3g.mb.95.fh — Whole-fleet reboot scenario
//
// PRD #1 success criterion as stubbed integration proof: all channels had
// live-state AD rows with dead tmux sessions → all resume successfully.
// Zero sendKeys fleet-wide; per-channel resume instance ids correct.
//
// Kill semantics: steering kills are AD client.kill() calls per channel.
// We verify fleet-wide resume count and instance ids, and zero sendKeys.
// ---------------------------------------------------------------------------

describe('Whole-fleet reboot scenario (fh)', () => {
  test('4 channels, all live-state, all dead probes → all resumed, zero sendKeys fleet-wide', async () => {
    // Single dead probe used for all channels (per-call injection via spawnForRoute 6th param).
    const { probe } = makeStubTmuxProbe('definitely-dead')

    // Four channels: mix of waiting and pending-with-usable-id states.
    const channels = ['C_FLEET1', 'C_FLEET2', 'C_FLEET3', 'C_FLEET4']
    const stateMap: Record<string, string> = {
      C_FLEET1: 'waiting',
      C_FLEET2: 'pending',
      C_FLEET3: 'waiting',
      C_FLEET4: 'pending',
    }

    const routesConfig = Object.fromEntries(
      channels.map(ch => [ch, { cwd: '/fleet/cwd' }])
    )
    const cfg = makeRoutingConfig({ routes: routesConfig })

    const results: Array<{ channelId: string; action: string }> = []
    const allResumeCalls: import('agent-director').ResumeParams[] = []
    const allSendKeysCalls: import('agent-director').SendKeysParams[] = []

    // Run spawnForRoute for each channel sequentially with per-call probe injection.
    for (const ch of channels) {
      const instanceId = `cscb_${ch}`
      installStub({
        resumeCalls: allResumeCalls,
        sendKeysCalls: allSendKeysCalls,
        spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
        getResult: cannedGetResult({
          claude_instance_id: instanceId,
          state: stateMap[ch],
          claude_session_id: `sess-${ch.toLowerCase()}`,
        }),
        // approvePreSessionDialogs: status returns 'waiting' immediately.
        statusResult: { state: 'waiting' },
      })
      const result = await spawnForRoute(ch, { cwd: '/fleet/cwd' }, cfg, undefined, true, probe)
      results.push(result)
      resetClientForTests()
    }

    // All channels resumed.
    expect(results).toHaveLength(4)
    for (const r of results) {
      expect(r.action).toBe('resumed')
    }

    // Zero sendKeys fleet-wide — reconnectMcp was never entered.
    expect(allSendKeysCalls).toHaveLength(0)

    // Exactly one resume call per channel.
    expect(allResumeCalls).toHaveLength(4)

    // Correct instance ids resumed, one per channel.
    const resumedIds = allResumeCalls.map(r => r.claude_instance_id).sort()
    expect(resumedIds).toEqual(channels.map(ch => `cscb_${ch}`).sort())
  })
})

// ---------------------------------------------------------------------------
// t3.a3g.mb.95.c6 — SR-24.2 pins: arbitrary-unknown resume error → 'failed'
//
// SR-24.2 has two pins:
//
// Pin 1 (this describe): arbitrary-unknown resume error.
//   A dead-probed live-state row whose resume throws an unrecognised
//   AgentDirectorError (e.g. ErrUnknownResumeError) falls through to the
//   catch-all ladder arm and returns action='failed'.
//   'failed' semantics: loud (postSpawnFailureToChannel → Slack post) and
//   retry-eligible (the next cron tick or manual /start will retry spawnForRoute).
//   It is NOT a wedge — the bot is not silently stuck; the operator sees the
//   error in Slack and the next cycle re-enters the spawn ladder cleanly.
//
// Pin 2 (documentation assertion only — no test arm):
//   The corrupt-JSONL case collapses into this pin per the SR-24.2 research
//   (t3.a3g.mb.yy.bz). See the comment at src/session-manager.ts ~line 932
//   ("SR-24.2 research") for the full explanation: AD v0.7.8 resume.go uses
//   an os.Stat-only guard — corrupt-but-present JSONL passes the check and
//   client.resume() returns success (exit 0). The failure surfaces later via
//   the approvePreSessionDialogs 5-minute hard cap. Because client.resume()
//   does NOT throw, no error arm is entered and no separate test pin exists.
//   The errJsonlMissing arm (tested in v5) covers the MISSING-JSONL identity
//   (ErrJsonlMissing), which is a distinct error with a distinct handler
//   (delete+fresh). Corrupt-JSONL ≠ missing JSONL at the AD layer.
// ---------------------------------------------------------------------------

describe('SR-24.2: arbitrary-unknown resume error → failed, loud, retry-eligible (c6)', () => {
  // Dead-probed live-state row (waiting) whose resume throws an arbitrary
  // unknown error. The catch-all arm in spawnForRoute returns action='failed'.
  // No retry loop: the test completes synchronously after the single resume
  // attempt; the next launch cycle is what retries (cron / manual /start).
  test('live-state waiting + dead probe + ErrUnknownResumeError → action failed, zero deletes, zero spawns', async () => {
    const { probe } = makeStubTmuxProbe('definitely-dead')
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      resumeCalls,
      deleteCalls,
      spawnCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({
        claude_instance_id: 'cscb_C',
        state: 'waiting',
        claude_session_id: 'sess-unknown-resume',
      }),
      // Arbitrary unknown resume error — not ErrNoSessionId, not ErrJsonlMissing,
      // not ErrSpawnNotResumable, not ErrTmuxSessionCreate. Falls through to the
      // catch-all ladder arm: postSpawnFailureToChannel + action='failed'.
      resumeError: errGeneric('resume', 'ErrUnknownResumeError', 'unexpected resume failure'),
      statusResult: { state: 'waiting' },
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg, undefined, true, probe)

    // Catch-all arm: loud failure (Slack post via postSpawnFailureToChannel).
    // Retry-eligible: next spawnForRoute call re-enters the ladder from scratch.
    // NOT a wedge: no silent stuck state.
    expect(result.action).toBe('failed')
    // Exactly one resume attempt — catch-all does not retry internally.
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0].claude_instance_id).toBe('cscb_C')
    // No delete — catch-all does not delete on unknown error (only known
    // rejection identities trigger delete+fresh).
    expect(deleteCalls).toHaveLength(0)
    // Only the initial collision-triggering spawn call; no fresh spawn issued
    // by the catch-all arm after the resume failure.
    expect(spawnCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// t3.a3g.u4.mp.tn — SR-22 escalation matrix for reconnectMcp
//
// Pins the full discriminated-result surface of reconnectMcp:
//   SR-22.1 (ErrTmuxSendKeys path):
//     (1) errTmuxSendKeysNotFound + dead probe   → 'escalate-dead'
//         SR-29.2 #3 positive: was red pre-fix (escalation logic did not exist).
//         Exactly ONE sendKeys call (SR-22.3 no-loop) — the escalation exits
//         without retrying, deferring recovery to the scheduled-restart path.
//     (2) errTmuxSendKeysNotFound + transient probe → 'transient', no escalation
//     (3) errTmuxSendKeysGeneric  → 'transient', Slack post with typed errName
//         'ErrTmuxSendKeys' (not rewrapped as UnknownError). Assert the post
//         payload errName directly, not just the call count.
//     (4) errCallTimeout          → 'transient'
//     (5) success                 → 'success', probe NEVER called (zero probeCalls)
//   SR-22.2 (ErrTmuxNotAvailable path):
//     (6) ErrTmuxNotAvailable + dead probe  → 'escalate-dead'
//         (red pre-fix: early-return fired; now defers to probe)
//     (7) ErrTmuxNotAvailable + transient probe → tmux-unavailable flag + 'transient'
//         (site #1b semantics: conservative, flag preserved)
//     (8) ErrTmuxNotAvailable + alive probe → 'transient', conservative no-kill/no-delete
//         (contradictory signals: tmux binary absent but has-session reports alive;
//          conservatism wins — do not escalate on conflicting evidence)
//   Waiting-branch race (SR-23.2, SR-22.3):
//     (9) spawnForRoute waiting + collision-probe=alive + sendKeys errTmuxSendKeysNotFound
//         + re-probe=dead → action='reconnected', zero resumeCalls.
//         Session died between the collision-branch probe (alive) and the sendKeys
//         attempt. spawnForRoute returns 'reconnected' and defers recovery to the
//         scheduled-restart path — this call has already done its one send-keys
//         attempt (SR-22.3 no-loop; no inline resume from the waiting branch).
//
// Helpers used: makeStubTmuxProbe (fixed result), makeStubTmuxProbeQueue (FIFO).
// No mock.module. All injection via factories and the probe parameter of reconnectMcp
// (4th positional) or the 6th positional of spawnForRoute.
// ---------------------------------------------------------------------------

describe('SR-22 escalation matrix: reconnectMcp (t3.a3g.u4.mp.tn)', () => {
  // -------------------------------------------------------------------------
  // (1) SR-22.1 positive / SR-29.2 #3: errTmuxSendKeysNotFound + dead probe
  //     → 'escalate-dead', exactly ONE sendKeys call (SR-22.3 no-loop).
  //
  // Pre-fix failure (red): the ErrTmuxSendKeys path collapsed into UnknownError
  // and returned 'transient' — no probe fired, no escalation. Post-fix (62ec245):
  // the not-found description matches SEND_KEYS_NOT_FOUND_NEEDLES, the
  // confirming probe returns definitely-dead, and reconnectMcp returns
  // 'escalate-dead'. These are the ship pins.
  // -------------------------------------------------------------------------

  test('SR-22.1 positive (SR-29.2 #3): errTmuxSendKeysNotFound + dead probe → escalate-dead, one sendKeys call', async () => {
    const { probe, probeCalls } = makeStubTmuxProbe('definitely-dead')
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({ sendKeysCalls, sendKeysError: errTmuxSendKeysNotFound() })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })

    const result = await reconnectMcp('C', undefined, cfg, probe)

    // Post-fix: escalate-dead (SR-22.1 positive).
    expect(result).toBe('escalate-dead')
    // Exactly one sendKeys call — no retry loop (SR-22.3).
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toContain('/mcp reconnect')
    // Confirming probe was called exactly once (session-name derived from channelId).
    expect(probeCalls).toHaveLength(1)
    expect(probeCalls[0]).toBe('slack_bot_C')
  })

  // -------------------------------------------------------------------------
  // (2) SR-22.1 negative: errTmuxSendKeysNotFound + transient probe → 'transient'
  //     Conservative conservatism (SR-20.4): inconclusive probe does NOT escalate.
  // -------------------------------------------------------------------------

  test('SR-22.1 negative: errTmuxSendKeysNotFound + transient probe → transient, no escalation', async () => {
    const { probe, probeCalls } = makeStubTmuxProbe('transient-inconclusive')
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({ sendKeysCalls, sendKeysError: errTmuxSendKeysNotFound() })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })

    const result = await reconnectMcp('C', undefined, cfg, probe)

    // Transient verdict from probe → no escalation.
    expect(result).toBe('transient')
    // Probe was called (hint matched, confirming probe fired).
    expect(probeCalls).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // (3) SR-22.1 generic send-keys: errTmuxSendKeysGeneric → 'transient',
  //     Slack post preserved with typed errName 'ErrTmuxSendKeys' (not UnknownError).
  //     Assert the post payload text contains the typed errName, not just call count.
  // -------------------------------------------------------------------------

  test('SR-22.1 generic: errTmuxSendKeysGeneric → transient, Slack post with typed ErrTmuxSendKeys errName', async () => {
    const postCalls: unknown[][] = []
    const web = { chat: { postMessage: async (...a: unknown[]) => { postCalls.push(a); return {} } } }
    const { probe, probeCalls } = makeStubTmuxProbe('definitely-dead')
    installStub({ sendKeysError: errTmuxSendKeysGeneric() })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })

    const result = await reconnectMcp('C', web as never, cfg, probe)

    // Generic send-keys error: transient, no escalation, probe NOT called
    // (description does not match SEND_KEYS_NOT_FOUND_NEEDLES → hint branch skipped).
    expect(result).toBe('transient')
    // Probe must NOT have been called — the not-found hint did not match.
    expect(probeCalls).toHaveLength(0)
    // Slack post was made (postSpawnFailureToChannel called for generic ErrTmuxSendKeys).
    expect(postCalls).toHaveLength(1)
    // The post text must include the typed errName 'ErrTmuxSendKeys', not 'UnknownError'.
    const postText = String(JSON.stringify(postCalls[0]))
    expect(postText).toContain('ErrTmuxSendKeys')
    expect(postText).not.toContain('UnknownError')
  })

  // -------------------------------------------------------------------------
  // (4) errCallTimeout → 'transient'
  //     ErrCallTimeout is not ErrTmuxSendKeys or ErrTmuxNotAvailable;
  //     it falls through to the generic AgentDirectorError arm → 'transient'.
  // -------------------------------------------------------------------------

  test('errCallTimeout → transient (generic AD error arm)', async () => {
    const { probe, probeCalls } = makeStubTmuxProbe('definitely-dead')
    installStub({ sendKeysError: errCallTimeout('send-keys') })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })

    const result = await reconnectMcp('C', undefined, cfg, probe)

    expect(result).toBe('transient')
    // Probe must NOT be called — ErrCallTimeout does not enter the ErrTmuxSendKeys branch.
    expect(probeCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // (5) success → 'success', probe NEVER called (zero probeCalls)
  //     The probe fires ONLY inside ErrTmuxSendKeys-not-found and ErrTmuxNotAvailable
  //     branches; it is not called on the success path.
  // -------------------------------------------------------------------------

  test('success → success, probe never called (zero probeCalls)', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const { probe, probeCalls } = makeStubTmuxProbe('definitely-dead')
    installStub({ sendKeysCalls })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })

    const result = await reconnectMcp('C', undefined, cfg, probe)

    expect(result).toBe('success')
    // sendKeys was called once (the /mcp reconnect command).
    expect(sendKeysCalls).toHaveLength(1)
    // Probe is NEVER called on the success path — no probe invocation.
    expect(probeCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // (6) SR-22.2: ErrTmuxNotAvailable + dead probe → 'escalate-dead'
  //     Red pre-fix: the ErrTmuxNotAvailable arm returned 'transient' (early-
  //     return without probing). Post-fix: probe fires; definitely-dead → escalate.
  //
  // This pin extends site #1b (which uses the module-level probe set to alive
  // in beforeEach). Here we pass an explicit dead probe to test the escalation
  // arm — the existing site #1b covers the alive/transient semantics.
  //
  // Note on tmux-unavailable flag: withOutageDetection sets the tmux-unavailable
  // flag when ErrTmuxNotAvailable is caught (before rethrowing to reconnectMcp).
  // The flag is set regardless of the subsequent probe verdict — this is correct
  // behavior: tmux IS unavailable (the binary failed), even if the escalation arm
  // later determines the session is dead. The flag will be cleared on next success.
  // -------------------------------------------------------------------------

  test('SR-22.2: ErrTmuxNotAvailable + dead probe → escalate-dead', async () => {
    const { probe, probeCalls } = makeStubTmuxProbe('definitely-dead')
    const { web, calls } = makeMockWeb()
    installStub({ sendKeysError: new ErrTmuxNotAvailable('send-keys', 'ErrTmuxNotAvailable', 'tmux not available') })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })

    const result = await reconnectMcp('C', web as never, cfg, probe)

    // Post-fix: escalate-dead (was 'transient' pre-fix — early-return without probe).
    expect(result).toBe('escalate-dead')
    // Probe was called exactly once.
    expect(probeCalls).toHaveLength(1)
    expect(probeCalls[0]).toBe('slack_bot_C')
    // No Slack post on the escalate-dead arm (the caller, not reconnectMcp, handles UX).
    expect(calls).toHaveLength(0)
    // tmux-unavailable flag IS set: withOutageDetection raises it on ErrTmuxNotAvailable
    // before rethrowing, regardless of the subsequent probe verdict. The escalation
    // arm does not clear it — recovery via scheduled-restart will clear on next success.
    expect(getOutageFlags('C').has('tmux-unavailable')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // (7) SR-22.2: ErrTmuxNotAvailable + transient probe → tmux-unavailable flag + 'transient'
  //     Site #1b semantics preserved: the ErrTmuxNotAvailable branch sets the
  //     outage flag and returns 'transient' when probe is inconclusive.
  //     (Site #1b in Group A tests this with the module-level alive-default probe;
  //     this pin exercises it explicitly with a transient probe.)
  // -------------------------------------------------------------------------

  test('SR-22.2: ErrTmuxNotAvailable + transient probe → tmux-unavailable flag + transient', async () => {
    const { probe, probeCalls } = makeStubTmuxProbe('transient-inconclusive')
    installStub({ sendKeysError: new ErrTmuxNotAvailable('send-keys', 'ErrTmuxNotAvailable', 'tmux not available') })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })

    const result = await reconnectMcp('C', undefined, cfg, probe)

    expect(result).toBe('transient')
    // Probe was called (ErrTmuxNotAvailable arm always probes).
    expect(probeCalls).toHaveLength(1)
    // tmux-unavailable outage flag raised (site #1b semantics preserved).
    expect(getOutageFlags('C').has('tmux-unavailable')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // (8) SR-22.2: ErrTmuxNotAvailable + alive probe → 'transient', conservative no-kill/no-delete
  //     Contradictory signals: tmux binary absent/broken but has-session returns alive.
  //     Conservatism wins — do not escalate on conflicting evidence. The function
  //     returns 'transient' and sets the tmux-unavailable flag (same as transient-probe).
  // -------------------------------------------------------------------------

  test('SR-22.2: ErrTmuxNotAvailable + alive probe → transient, conservative (contradictory signals, conservatism wins)', async () => {
    const { probe, probeCalls } = makeStubTmuxProbe('definitely-alive')
    const { web, calls } = makeMockWeb()
    installStub({ sendKeysError: new ErrTmuxNotAvailable('send-keys', 'ErrTmuxNotAvailable', 'tmux not available') })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })

    const result = await reconnectMcp('C', web as never, cfg, probe)

    // Contradictory signals (tmux binary absent but session alive) → conservative transient.
    // Do NOT escalate-dead on conflicting evidence; do not kill or delete.
    expect(result).toBe('transient')
    // Probe was called to determine the classification.
    expect(probeCalls).toHaveLength(1)
    // tmux-unavailable flag raised (same as transient/alive: ErrTmuxNotAvailable fired).
    expect(getOutageFlags('C').has('tmux-unavailable')).toBe(true)
    // No Slack post on the ErrTmuxNotAvailable arm (postSpawnFailureToChannel not called).
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // (9) Waiting-branch race (SR-23.2, SR-22.3):
  //     spawnForRoute waiting + collision-probe=alive (first probe) + sendKeys
  //     errTmuxSendKeysNotFound + confirming probe=dead (second probe, inside
  //     reconnectMcp) → action='reconnected', zero resumeCalls.
  //
  //     Construct via makeStubTmuxProbeQueue:
  //       queue[0] = alive   (collision-branch probe: session appears alive → proceed to reconnect)
  //       queue[1] = dead    (reconnectMcp confirming probe: definitely-dead → escalate-dead)
  //
  //     spawnForRoute's waiting branch (line ~1160) catches escalate-dead and
  //     returns action='reconnected', deferring recovery to the scheduled-restart
  //     path (SR-23.2). This call has done its one send-keys attempt (SR-22.3
  //     no-loop); no inline resume is attempted from the waiting branch.
  // -------------------------------------------------------------------------

  test('SR-22.3 waiting-branch race: alive collision-probe + errTmuxSendKeysNotFound + dead re-probe → action reconnected, zero resumeCalls', async () => {
    // Probe queue installed via _setTmuxProbeForTests (the module-level seam).
    // Both spawnForRoute's collision-branch probe AND reconnectMcp's confirming
    // probe use this seam — installing via _setTmuxProbeForTests ensures both
    // calls come from the same FIFO queue:
    //   queue[0] = alive   (collision-branch: session appears alive → proceed to waiting branch)
    //   queue[1] = dead    (reconnectMcp confirming probe: definitely-dead → escalate-dead)
    // Note: spawnForRoute's waiting branch calls reconnectMcp without a probe arg,
    // so reconnectMcp uses the module-level _tmuxProbe (this queue). The per-call
    // probe param of spawnForRoute (6th arg) is NOT passed here — both probes use
    // the installed module-level queue.
    const { probe, probeCalls } = makeStubTmuxProbeQueue([
      { classification: 'definitely-alive', signal: 'exit-0' },
      { classification: 'definitely-dead', signal: 'exit-1-session-not-found' },
    ])
    _setTmuxProbeForTests(probe)

    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      sendKeysCalls,
      resumeCalls,
      // sendKeys throws errTmuxSendKeysNotFound (session died between probe and sendKeys).
      sendKeysError: errTmuxSendKeysNotFound(),
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ claude_instance_id: 'cscb_C', state: 'waiting' }),
    })
    const cfg = makeRoutingConfig({ routes: { C: { cwd: CWD } } })

    // Do NOT pass a per-call probe to spawnForRoute; both probes use the module-level queue.
    const result = await spawnForRoute('C', { cwd: CWD }, cfg)

    // Session died between the alive collision-branch probe and the sendKeys attempt
    // (race condition). spawnForRoute's waiting branch returns 'reconnected' and defers
    // recovery to the scheduled-restart path — this call has done its one send-keys
    // attempt (SR-22.3 no-loop; no inline resume from the waiting branch).
    expect(result.action).toBe('reconnected')
    // Exactly one sendKeys call — no retry loop after escalation.
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toContain('/mcp reconnect')
    // Zero resume calls — the waiting branch does NOT inline-resume after escalation.
    // Recovery is deferred to the scheduled-restart path (SR-23.2).
    expect(resumeCalls).toHaveLength(0)
    // Two probe calls: (1) collision-branch → alive; (2) reconnectMcp confirm → dead.
    expect(probeCalls).toHaveLength(2)
  })
})
