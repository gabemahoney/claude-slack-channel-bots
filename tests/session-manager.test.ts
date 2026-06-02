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
  spawnForRoute,
  startupSessionManager,
  instanceIdFor,
  tmuxSessionNameFor,
  AGENT_DIRECTOR_LIVE_STATES,
  DEV_CHANNELS_DIALOG_NEEDLE,
  _setDialogPollTimeoutMs,
  _setDialogPollIntervalMs,
  _resetDialogPollTimeoutMs,
  _resetDialogPollIntervalMs,
  _setTrustDialogPollTimeoutMs,
  _setTrustDialogPollIntervalMs,
  _resetTrustDialogPollTimeoutMs,
  _resetTrustDialogPollIntervalMs,
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
  errSpawnNotInteractive,
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
  // Keep dialog approval polling tight so the helpers firing on every
  // fresh-spawn test don't add seconds to the suite. Individual tests can
  // override these as needed. Both approvers (dev-channels and trust-folder)
  // run at every spawn site, so both seams must be set.
  _setDialogPollIntervalMs(1)
  _setDialogPollTimeoutMs(20)
  // Trust-folder approver runs first at every spawn site (b.uhv Fix B). The
  // existing `readPaneResults` sequences in this file were authored before
  // the trust approver existed and assume the dev-channels approver gets the
  // first reads. Set the trust timeout to 0 so its while-loop never enters and
  // consumes no canned reads — the dedicated trust-approver tests live in
  // tests/approve-trust-folder-dialog.test.ts where the seam is overridden
  // with realistic values.
  _setTrustDialogPollIntervalMs(1)
  _setTrustDialogPollTimeoutMs(0)
})

afterEach(() => {
  resetClientForTests()
  _resetDialogPollIntervalMs()
  _resetDialogPollTimeoutMs()
  _resetTrustDialogPollIntervalMs()
  _resetTrustDialogPollTimeoutMs()
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
      // b.98w: every readPane call must carry allow_pending=true so the verb
      // succeeds while the spawn is still in 'pending' state.
      expect(r.allow_pending).toBe(true)
    }
    // b.98w: the sendKeys call that presses Enter must also carry allow_pending=true.
    for (const s of sendKeysCalls) {
      expect(s.allow_pending).toBe(true)
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

  // -------------------------------------------------------------------------
  // b.98w regression: readPane/sendKeys must pass allow_pending:true or the
  // agent-director rejects with ErrSpawnNotInteractive while still pending.
  // -------------------------------------------------------------------------

  test('b.98w / ErrSpawnNotInteractive: rejects if readPane or sendKeys omit allow_pending', async () => {
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

    const cfg = makeRoutingConfig({ routes: { C: { cwd: '/x' } } })
    const result = await spawnForRoute('C', { cwd: '/x' }, cfg)

    // If allow_pending is present everywhere the spawn must complete cleanly.
    expect(result.action).toBe('spawned')
    // Exactly one sendKeys (the Enter key that dismisses the dialog).
    const enterCalls = sendKeysCalls.filter((s) => s.text === '')
    expect(enterCalls).toHaveLength(1)
    // The sendKeys call must carry allow_pending:true — without it the mock
    // throws ErrSpawnNotInteractive and the dialog approval silently fails.
    expect(enterCalls[0].allow_pending).toBe(true)
  })

  // -------------------------------------------------------------------------
  // b.ben regression: approveDevChannelsDialog must use the composed instance
  // id (cscb_<name>_<id>) when the route carries a normalizedName. The bug
  // produced cscb_<id> here, polling a non-existent spawn and leaving the
  // real bot pane stuck on the dev-channels dialog after every clean_restart.
  // -------------------------------------------------------------------------

  test('b.ben: uses composed instance id when route has normalizedName', async () => {
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
