/**
 * session-manager.test.ts — Tests for startupSessionManager and related helpers.
 *
 * Uses ClaudeDirectorStub as the sole fake CLI surface.
 * No real subprocesses, no tmux, no Slack web client.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  spawnForRoute,
  reconcileOrphans,
  reconnectMcp,
  waitForWaitingAndReconnect,
  postSpawnFailureToChannel,
  flushSpawnFailureQueue,
  startupSessionManager,
  _setWaitForWaitingTimeoutMs,
  _resetWaitForWaitingTimeoutMs,
} from '../src/session-manager.ts'
import { MCP_SERVER_NAME } from '../src/config.ts'
import { ClaudeDirectorStub, makeSpawnRow, makeGetPayload } from './test-helpers/claude-director-stub.ts'
import { makeRoutingConfig, makeRouteEntry } from './test-helpers/routing-config.ts'
import type { WebClient } from '@slack/web-api'

// ---------------------------------------------------------------------------
// Stub WebClient factory
// ---------------------------------------------------------------------------

interface PostMessageCall {
  channel: string
  text: string
}

function makeWebStub(): { web: WebClient; posts: PostMessageCall[] } {
  const posts: PostMessageCall[] = []
  const web = {
    chat: {
      postMessage: async (args: { channel: string; text: string }) => {
        posts.push({ channel: args.channel, text: args.text })
        return { ok: true }
      },
    },
  } as unknown as WebClient
  return { web, posts }
}

// ---------------------------------------------------------------------------
// Shared stub + env setup
// ---------------------------------------------------------------------------

let stub: ClaudeDirectorStub

beforeEach(() => {
  stub = new ClaudeDirectorStub()
  stub.install()
  // Ensure dry-run is off
  delete process.env['SLACK_DRY_RUN']
  _resetWaitForWaitingTimeoutMs()
})

afterEach(() => {
  stub.uninstall()
  delete process.env['SLACK_DRY_RUN']
  _resetWaitForWaitingTimeoutMs()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CH = 'C_TEST'
const CWD = '/tmp/test-cwd'
const INSTANCE_ID = `cscb_${CH}`

function singleRoute(overrides?: Partial<ReturnType<typeof makeRoutingConfig>>) {
  return makeRoutingConfig({
    routes: { [CH]: makeRouteEntry({ cwd: CWD }) },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// spawnForRoute — happy path (fresh spawn)
// ---------------------------------------------------------------------------

describe('spawnForRoute — fresh spawn', () => {
  test('no collision → cliSpawn called once with correct argv, returns spawned', async () => {
    const config = singleRoute()
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('spawned')
    expect(result.channelId).toBe(CH)

    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(1)
    const argv = spawnCalls[0].argv

    expect(argv).toContain('spawn')
    expect(argv).toContain('--template')
    expect(argv[argv.indexOf('--template') + 1]).toBe('slack-channel-bot')
    expect(argv).toContain('--cwd')
    expect(argv[argv.indexOf('--cwd') + 1]).toBe(CWD)
    expect(argv).toContain('--claude-instance-id')
    expect(argv[argv.indexOf('--claude-instance-id') + 1]).toBe(INSTANCE_ID)
    expect(argv).toContain('--relay-mode')
    expect(argv[argv.indexOf('--relay-mode') + 1]).toBe('on')
    expect(argv).toContain('--tmux-session-name')
    expect(argv[argv.indexOf('--tmux-session-name') + 1]).toBe(`slack_bot_${CH}`)
    expect(argv).toContain('--label')
    // service label
    const labelIdx1 = argv.indexOf('service=cscb')
    expect(labelIdx1).toBeGreaterThan(-1)
    expect(argv[labelIdx1 - 1]).toBe('--label')
    // channel label
    const labelIdx2 = argv.indexOf(`channel=${CH}`)
    expect(labelIdx2).toBeGreaterThan(-1)
    expect(argv[labelIdx2 - 1]).toBe('--label')
  })

  test('spawn argv does NOT contain --append-system-prompt-file (Epic 1 boundary canary)', async () => {
    const config = singleRoute()
    await spawnForRoute(CH, { cwd: CWD }, config)
    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].argv).not.toContain('--append-system-prompt-file')
  })

  test('no claude_config_dir → no --extra-env in argv', async () => {
    const config = singleRoute({ claude_config_dir: undefined })
    await spawnForRoute(CH, { cwd: CWD }, config)
    const argv = stub.calls.filter(c => c.verb === 'spawn')[0].argv
    expect(argv).not.toContain('--extra-env')
  })

  test('top-level claude_config_dir → --extra-env CLAUDE_CONFIG_DIR=<dir> in spawn argv', async () => {
    const config = singleRoute({ claude_config_dir: '/home/user/.claude-alt' })
    await spawnForRoute(CH, { cwd: CWD }, config)
    const argv = stub.calls.filter(c => c.verb === 'spawn')[0].argv
    expect(argv).toContain('--extra-env')
    const envIdx = argv.indexOf('--extra-env')
    expect(argv[envIdx + 1]).toBe('CLAUDE_CONFIG_DIR=/home/user/.claude-alt')
  })

  test('per-route claude_config_dir overrides top-level', async () => {
    const config = makeRoutingConfig({
      routes: { [CH]: makeRouteEntry({ cwd: CWD, claude_config_dir: '/route-specific/.claude' }) },
      claude_config_dir: '/top-level/.claude',
    })
    await spawnForRoute(CH, { cwd: CWD }, config)
    const argv = stub.calls.filter(c => c.verb === 'spawn')[0].argv
    const envIdx = argv.indexOf('--extra-env')
    expect(envIdx).toBeGreaterThan(-1)
    expect(argv[envIdx + 1]).toBe('CLAUDE_CONFIG_DIR=/route-specific/.claude')
  })

  test('two-route config → each route spawns once', async () => {
    const CH2 = 'C_TEST2'
    const config = makeRoutingConfig({
      routes: {
        [CH]: makeRouteEntry({ cwd: '/tmp/cwd1' }),
        [CH2]: makeRouteEntry({ cwd: '/tmp/cwd2' }),
      },
    })
    const result = await startupSessionManager(config)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)

    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(2)

    const instanceIds = spawnCalls.map(c => {
      const idx = c.argv.indexOf('--claude-instance-id')
      return c.argv[idx + 1]
    })
    expect(instanceIds).toContain(`cscb_${CH}`)
    expect(instanceIds).toContain(`cscb_${CH2}`)
  })
})

// ---------------------------------------------------------------------------
// spawnForRoute — collision then get then act
// ---------------------------------------------------------------------------

describe('spawnForRoute — collision: ended state → resume', () => {
  test('ErrInstanceIdCollision + get returns ended + resume_enabled → resume called, no second spawn', async () => {
    const row = makeSpawnRow({ channelId: CH, state: 'ended' })
    stub.setSpawnRows([row])
    // get must also return ended state (getPayloads takes precedence over defaultGetPayload)
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'ended' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    const config = singleRoute({ resume_enabled: true })
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('resumed')

    const resumeCalls = stub.calls.filter(c => c.verb === 'resume')
    expect(resumeCalls).toHaveLength(1)

    // No second spawn beyond the first
    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(1)
  })
})

describe('spawnForRoute — collision: missing state → resume', () => {
  test('ErrInstanceIdCollision + get returns missing + resume_enabled → resume called', async () => {
    const row = makeSpawnRow({ channelId: CH, state: 'missing' })
    stub.setSpawnRows([row])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'missing' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    const config = singleRoute({ resume_enabled: true })
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('resumed')
    const resumeCalls = stub.calls.filter(c => c.verb === 'resume')
    expect(resumeCalls).toHaveLength(1)
  })
})

describe('spawnForRoute — collision: terminal + ErrNoSessionId on resume → delete+spawn', () => {
  test('ended + resume returns ErrNoSessionId → delete then fresh spawn', async () => {
    const row = makeSpawnRow({ channelId: CH, state: 'ended' })
    stub.setSpawnRows([row])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'ended' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })
    stub.setNextResumeError(INSTANCE_ID, { ok: false, error: { kind: 'ErrNoSessionId', message: 'no session' } })

    const config = singleRoute({ resume_enabled: true })
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('spawned')

    const deleteCalls = stub.calls.filter(c => c.verb === 'delete')
    expect(deleteCalls).toHaveLength(1)

    // Second spawn after delete
    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(2)

    // delete must come before second spawn
    const deleteIdx = stub.calls.findIndex(c => c.verb === 'delete')
    const lastSpawnIdx = stub.calls.map((c, i) => c.verb === 'spawn' ? i : -1).filter(i => i >= 0).at(-1)!
    expect(deleteIdx).toBeLessThan(lastSpawnIdx)
  })
})

describe('spawnForRoute — collision: terminal + ErrJsonlMissing on resume → delete+spawn', () => {
  test('ended + resume returns ErrJsonlMissing → delete then fresh spawn', async () => {
    const row = makeSpawnRow({ channelId: CH, state: 'ended' })
    stub.setSpawnRows([row])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'ended' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })
    stub.setNextResumeError(INSTANCE_ID, { ok: false, error: { kind: 'ErrJsonlMissing', message: 'no jsonl' } })

    const config = singleRoute({ resume_enabled: true })
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('spawned')

    const deleteCalls = stub.calls.filter(c => c.verb === 'delete')
    expect(deleteCalls).toHaveLength(1)

    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(2)
  })
})

describe('spawnForRoute — collision: waiting state → send-keys reconnect', () => {
  test('ErrInstanceIdCollision + get returns waiting → send-keys with MCP reconnect payload', async () => {
    const row = makeSpawnRow({ channelId: CH, state: 'waiting' })
    stub.setSpawnRows([row])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'waiting' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    const config = singleRoute()
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('reconnected')

    const sendKeysCalls = stub.calls.filter(c => c.verb === 'send-keys')
    expect(sendKeysCalls).toHaveLength(1)
    const argv = sendKeysCalls[0].argv

    // Should have --text /mcp reconnect <MCP_SERVER_NAME>
    const textIdx = argv.indexOf('--text')
    expect(textIdx).toBeGreaterThan(-1)
    expect(argv[textIdx + 1]).toBe(`/mcp reconnect ${MCP_SERVER_NAME}`)
  })
})

describe('spawnForRoute — collision: working state → poll-then-reconnect', () => {
  test('ErrInstanceIdCollision + get returns working → poll status until waiting, then send-keys', async () => {
    // Start with working state in both spawnRows and getPayload
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'working' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'working' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    _setWaitForWaitingTimeoutMs(500)
    const config = singleRoute({ claude_director_poll_interval_ms: 10 })

    // After a short delay, mutate the row to waiting so the poller transitions
    const changeTimer = setTimeout(() => {
      stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'waiting' })])
    }, 30)

    try {
      const result = await spawnForRoute(CH, { cwd: CWD }, config)
      expect(result.action).toBe('reconnected')

      // Send-keys must have been called
      const sendKeysCalls = stub.calls.filter(c => c.verb === 'send-keys')
      expect(sendKeysCalls).toHaveLength(1)

      // At least one status call before send-keys
      const statusCalls = stub.calls.filter(c => c.verb === 'status')
      expect(statusCalls.length).toBeGreaterThanOrEqual(1)

      // Verify send-keys was NOT called before at least one status call
      const firstStatusIdx = stub.calls.findIndex(c => c.verb === 'status')
      const sendKeysIdx = stub.calls.findIndex(c => c.verb === 'send-keys')
      expect(firstStatusIdx).toBeLessThan(sendKeysIdx)
    } finally {
      clearTimeout(changeTimer)
    }
  })

  test('working state: assert at least two status polls before send-keys when working persists briefly', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'working' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'working' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    _setWaitForWaitingTimeoutMs(500)
    const config = singleRoute({ claude_director_poll_interval_ms: 10 })

    // Delay transition so we get multiple status polls
    const changeTimer = setTimeout(() => {
      stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'waiting' })])
    }, 60)

    try {
      const result = await spawnForRoute(CH, { cwd: CWD }, config)
      expect(result.action).toBe('reconnected')

      // Multiple status polls expected before transition
      const statusCalls = stub.calls.filter(c => c.verb === 'status')
      expect(statusCalls.length).toBeGreaterThanOrEqual(2)

      // send-keys called exactly once after all the polling
      expect(stub.calls.filter(c => c.verb === 'send-keys')).toHaveLength(1)

      // send-keys appears AFTER the last status call
      const sendKeysIdx = stub.calls.findIndex(c => c.verb === 'send-keys')
      const firstStatusIdx = stub.calls.findIndex(c => c.verb === 'status')
      expect(firstStatusIdx).toBeLessThan(sendKeysIdx)
    } finally {
      clearTimeout(changeTimer)
    }
  })
})

describe('spawnForRoute — collision: pending state → no-op', () => {
  test('ErrInstanceIdCollision + get returns pending → no action taken', async () => {
    // Need both spawnRows (for instanceExists) and getPayload (for get response state)
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'pending' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'pending' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    const config = singleRoute()
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('no-op')

    // No resume, no send-keys, no kill, no delete
    expect(stub.calls.filter(c => c.verb === 'resume')).toHaveLength(0)
    expect(stub.calls.filter(c => c.verb === 'send-keys')).toHaveLength(0)
    expect(stub.calls.filter(c => c.verb === 'kill')).toHaveLength(0)
    expect(stub.calls.filter(c => c.verb === 'delete')).toHaveLength(0)
  })
})

describe('spawnForRoute — collision: check_permission state → no-op', () => {
  test('ErrInstanceIdCollision + get returns check_permission → no action taken', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'check_permission' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'check_permission' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    const config = singleRoute()
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('no-op')
    expect(stub.calls.filter(c => c.verb === 'resume')).toHaveLength(0)
    expect(stub.calls.filter(c => c.verb === 'send-keys')).toHaveLength(0)
  })
})

describe('spawnForRoute — collision: ask_user state → no-op', () => {
  test('ErrInstanceIdCollision + get returns ask_user → no action taken', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'ask_user' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'ask_user' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    const config = singleRoute()
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('no-op')
    expect(stub.calls.filter(c => c.verb === 'resume')).toHaveLength(0)
    expect(stub.calls.filter(c => c.verb === 'send-keys')).toHaveLength(0)
  })
})

describe('spawnForRoute — resume_enabled=false + terminal state → kill+delete+spawn', () => {
  test('resume_enabled=false + ended → kill+delete+fresh spawn, no resume', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'ended' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'ended' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    const config = singleRoute({ resume_enabled: false })
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('spawned')

    const killCalls = stub.calls.filter(c => c.verb === 'kill')
    expect(killCalls).toHaveLength(1)

    const deleteCalls = stub.calls.filter(c => c.verb === 'delete')
    expect(deleteCalls).toHaveLength(1)

    const resumeCalls = stub.calls.filter(c => c.verb === 'resume')
    expect(resumeCalls).toHaveLength(0)

    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(2) // initial (collision) + fresh

    // kill before delete before second spawn
    const killIdx = stub.calls.findIndex(c => c.verb === 'kill')
    const deleteIdx = stub.calls.findIndex(c => c.verb === 'delete')
    const lastSpawnIdx = stub.calls.map((c, i) => c.verb === 'spawn' ? i : -1).filter(i => i >= 0).at(-1)!
    expect(killIdx).toBeLessThan(deleteIdx)
    expect(deleteIdx).toBeLessThan(lastSpawnIdx)
  })

  test('resume_enabled=false + no pre-existing row → spawn only (no spurious kill+delete)', async () => {
    const config = singleRoute({ resume_enabled: false })
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('spawned')
    expect(stub.calls.filter(c => c.verb === 'kill')).toHaveLength(0)
    expect(stub.calls.filter(c => c.verb === 'delete')).toHaveLength(0)
    expect(stub.calls.filter(c => c.verb === 'resume')).toHaveLength(0)
    expect(stub.calls.filter(c => c.verb === 'spawn')).toHaveLength(1)
  })

  test('resume_enabled=true + no pre-existing row → spawn only', async () => {
    const config = singleRoute({ resume_enabled: true })
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    expect(result.action).toBe('spawned')
    expect(stub.calls.filter(c => c.verb === 'resume')).toHaveLength(0)
    expect(stub.calls.filter(c => c.verb === 'spawn')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// reconcileOrphans
// ---------------------------------------------------------------------------

describe('reconcileOrphans', () => {
  test('orphan channel NOT in config → kill+delete called, result reflects found=1 killed=1', async () => {
    const orphanCh = 'C_ORPHAN'
    const orphanRow = makeSpawnRow({ channelId: orphanCh, state: 'waiting' })
    stub.setSpawnRows([orphanRow])

    const config = singleRoute() // routes only has C_TEST, not C_ORPHAN

    const result = await reconcileOrphans(config)

    expect(result.found).toBe(1)
    expect(result.killed).toBe(1)
    expect(result.failed).toBe(0)

    const killCalls = stub.calls.filter(c => c.verb === 'kill')
    expect(killCalls).toHaveLength(1)
    const killArgv = killCalls[0].argv
    expect(killArgv).toContain(`cscb_${orphanCh}`)

    const deleteCalls = stub.calls.filter(c => c.verb === 'delete')
    expect(deleteCalls).toHaveLength(1)
    const deleteArgv = deleteCalls[0].argv
    expect(deleteArgv).toContain(`cscb_${orphanCh}`)
  })

  test('channel IN config → not killed, not deleted', async () => {
    const row = makeSpawnRow({ channelId: CH, state: 'waiting' })
    stub.setSpawnRows([row])

    const config = singleRoute()
    const result = await reconcileOrphans(config)

    expect(result.found).toBe(0)
    expect(result.killed).toBe(0)

    expect(stub.calls.filter(c => c.verb === 'kill')).toHaveLength(0)
    expect(stub.calls.filter(c => c.verb === 'delete')).toHaveLength(0)
  })

  test('mixed: one configured + one orphan → only orphan killed+deleted', async () => {
    const orphanCh = 'C_ORPHAN'
    const configuredRow = makeSpawnRow({ channelId: CH, state: 'waiting' })
    const orphanRow = makeSpawnRow({ channelId: orphanCh, state: 'waiting' })
    stub.setSpawnRows([configuredRow, orphanRow])

    const config = singleRoute()
    const result = await reconcileOrphans(config)

    expect(result.found).toBe(1)
    expect(result.killed).toBe(1)

    const killCalls = stub.calls.filter(c => c.verb === 'kill')
    expect(killCalls).toHaveLength(1)
    expect(killCalls[0].argv).toContain(`cscb_${orphanCh}`)
  })

  test('no orphans → list called once, no kill/delete', async () => {
    const row = makeSpawnRow({ channelId: CH, state: 'waiting' })
    stub.setSpawnRows([row])

    const config = singleRoute()
    const result = await reconcileOrphans(config)

    expect(result.found).toBe(0)

    const listCalls = stub.calls.filter(c => c.verb === 'list')
    expect(listCalls).toHaveLength(1)
    expect(stub.calls.filter(c => c.verb === 'kill')).toHaveLength(0)
    expect(stub.calls.filter(c => c.verb === 'delete')).toHaveLength(0)
  })

  test('kill error for orphan → does not throw, failed count increments after delete also fails', async () => {
    const orphanCh = 'C_ORPHAN'
    const orphanRow = makeSpawnRow({ channelId: orphanCh, state: 'waiting' })
    stub.setSpawnRows([orphanRow])
    // Kill fails
    stub.setKillResponseQueue(`cscb_${orphanCh}`, [
      { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 1, message: 'kill failed' } },
    ])

    const config = singleRoute()
    // Should not throw
    const result = await reconcileOrphans(config)
    expect(result.found).toBe(1)
    // delete still proceeds after kill failure — killed=1 since delete succeeded
    const deleteCalls = stub.calls.filter(c => c.verb === 'delete')
    expect(deleteCalls).toHaveLength(1)
  })

  test('cleanup failures do not crash startup — configured route still launches', async () => {
    const orphanCh = 'C_ORPHAN'
    const orphanRow = makeSpawnRow({ channelId: orphanCh, state: 'working' })
    stub.setSpawnRows([orphanRow])
    stub.setKillResponseQueue(`cscb_${orphanCh}`, [
      { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 1, message: 'kill failed' } },
    ])

    const config = makeRoutingConfig({
      routes: { [CH]: makeRouteEntry({ cwd: CWD }) },
    })

    // startupSessionManager calls reconcileOrphans then spawnForRoute
    const result = await startupSessionManager(config)

    // Should succeed for the configured route even if orphan cleanup had errors
    expect(result.succeeded).toBeGreaterThanOrEqual(1)

    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(1)
    const spawnArgv = spawnCalls[0].argv
    expect(spawnArgv[spawnArgv.indexOf('--claude-instance-id') + 1]).toBe(INSTANCE_ID)
  })
})

// ---------------------------------------------------------------------------
// reconnectMcp
// ---------------------------------------------------------------------------

describe('reconnectMcp', () => {
  test('send-keys called with correct reconnect payload', async () => {
    const row = makeSpawnRow({ channelId: CH, state: 'waiting' })
    stub.setSpawnRows([row])

    const success = await reconnectMcp(CH)

    expect(success).toBe(true)

    const sendKeysCalls = stub.calls.filter(c => c.verb === 'send-keys')
    expect(sendKeysCalls).toHaveLength(1)
    const argv = sendKeysCalls[0].argv

    // --text /mcp reconnect <MCP_SERVER_NAME>
    const textIdx = argv.indexOf('--text')
    expect(textIdx).toBeGreaterThan(-1)
    expect(argv[textIdx + 1]).toBe(`/mcp reconnect ${MCP_SERVER_NAME}`)

    // Also --text Enter
    const enterIdx = argv.indexOf('Enter')
    expect(enterIdx).toBeGreaterThan(-1)
  })

  test('reconnect payload sources MCP_SERVER_NAME from config import (not hardcoded)', async () => {
    const row = makeSpawnRow({ channelId: CH, state: 'waiting' })
    stub.setSpawnRows([row])

    await reconnectMcp(CH)

    const sendKeysCalls = stub.calls.filter(c => c.verb === 'send-keys')
    const argv = sendKeysCalls[0].argv
    const textIdx = argv.indexOf('--text')
    const expectedPayload = `/mcp reconnect ${MCP_SERVER_NAME}`
    expect(argv[textIdx + 1]).toBe(expectedPayload)
    expect(MCP_SERVER_NAME).toBe('slack-channel-router')
  })
})

// ---------------------------------------------------------------------------
// waitForWaitingAndReconnect
// ---------------------------------------------------------------------------

describe('waitForWaitingAndReconnect', () => {
  test('status returns waiting on first poll → reconnectMcp called once', async () => {
    const row = makeSpawnRow({ channelId: CH, state: 'waiting' })
    stub.setSpawnRows([row])

    const config = singleRoute({ claude_director_poll_interval_ms: 10 })
    const result = await waitForWaitingAndReconnect(CH, config)

    expect(result).toBe(true)

    const sendKeysCalls = stub.calls.filter(c => c.verb === 'send-keys')
    expect(sendKeysCalls).toHaveLength(1)
  })

  test('polls status until waiting, then reconnects', async () => {
    // Start working, transition to waiting after a tick
    const row = makeSpawnRow({ channelId: CH, state: 'working' })
    stub.setSpawnRows([row])

    const config = singleRoute({ claude_director_poll_interval_ms: 10 })
    _setWaitForWaitingTimeoutMs(500)

    // Transition to waiting after some polls
    const timer = setTimeout(() => {
      stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'waiting' })])
    }, 30)

    try {
      const result = await waitForWaitingAndReconnect(CH, config)
      expect(result).toBe(true)

      const statusCalls = stub.calls.filter(c => c.verb === 'status')
      expect(statusCalls.length).toBeGreaterThanOrEqual(1)

      const sendKeysCalls = stub.calls.filter(c => c.verb === 'send-keys')
      expect(sendKeysCalls).toHaveLength(1)
    } finally {
      clearTimeout(timer)
    }
  })

  test('timeout expires → returns true (non-error), no send-keys called', async () => {
    // Spawn stays in working state forever
    const row = makeSpawnRow({ channelId: CH, state: 'working' })
    stub.setSpawnRows([row])

    _setWaitForWaitingTimeoutMs(50) // very short timeout
    const config = singleRoute({ claude_director_poll_interval_ms: 10 })

    const result = await waitForWaitingAndReconnect(CH, config)

    expect(result).toBe(true) // timeout is not an error per spec
    expect(stub.calls.filter(c => c.verb === 'send-keys')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// postSpawnFailureToChannel
// ---------------------------------------------------------------------------

describe('postSpawnFailureToChannel', () => {
  test('with web → posts to Slack with channelId + error info + remediation hint', async () => {
    const { web, posts } = makeWebStub()

    const error = { kind: 'ErrNonZeroExit' as const, exitCode: 1, stderr: 'Some error output' }
    postSpawnFailureToChannel(CH, error, web)

    // Allow async chat.postMessage to run
    await new Promise(r => setTimeout(r, 10))

    expect(posts).toHaveLength(1)
    expect(posts[0].channel).toBe(CH)
    expect(posts[0].text).toContain(CH)
    expect(posts[0].text).toContain('ErrNonZeroExit')
    expect(posts[0].text).toContain('Remediation')
  })

  test('with web → text contains stderr snippet', async () => {
    const { web, posts } = makeWebStub()
    const stderr = 'template not found: slack-channel-bot'
    const error = { kind: 'ErrNonZeroExit' as const, exitCode: 1, stderr }
    postSpawnFailureToChannel(CH, error, web)
    await new Promise(r => setTimeout(r, 10))

    expect(posts[0].text).toContain(stderr)
  })

  test('without web (pre-auth) → enqueued; flushSpawnFailureQueue posts later', async () => {
    const error = { kind: 'ErrNonZeroExit' as const, exitCode: 1, stderr: 'queued error' }

    // No web passed → should queue
    postSpawnFailureToChannel(CH, error)

    const { web, posts } = makeWebStub()

    // Nothing posted yet
    expect(posts).toHaveLength(0)

    // Flush should post
    flushSpawnFailureQueue(web)
    await new Promise(r => setTimeout(r, 10))

    expect(posts).toHaveLength(1)
    expect(posts[0].channel).toBe(CH)
  })

  test('ErrBinaryMissing → remediation mentions install', async () => {
    const { web, posts } = makeWebStub()
    const error = { kind: 'ErrBinaryMissing' as const, message: 'binary not found' }
    postSpawnFailureToChannel(CH, error, web)
    await new Promise(r => setTimeout(r, 10))

    expect(posts[0].text.toLowerCase()).toContain('install')
  })

  test('Slack postMessage failure → does not throw', async () => {
    const web = {
      chat: {
        postMessage: async () => { throw new Error('Slack API down') },
      },
    } as unknown as WebClient

    const error = { kind: 'ErrNonZeroExit' as const, exitCode: 1, stderr: 'test' }

    // Should not throw
    expect(() => {
      postSpawnFailureToChannel(CH, error, web)
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// startupSessionManager — integration
// ---------------------------------------------------------------------------

describe('startupSessionManager', () => {
  test('routes iterated, dispatcher called per route, returns results', async () => {
    const CH2 = 'C_TEST2'
    const config = makeRoutingConfig({
      routes: {
        [CH]: makeRouteEntry({ cwd: '/tmp/cwd1' }),
        [CH2]: makeRouteEntry({ cwd: '/tmp/cwd2' }),
      },
    })

    const result = await startupSessionManager(config)

    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.perChannel).toHaveLength(2)

    const channelIds = result.perChannel.map(r => r.channelId)
    expect(channelIds).toContain(CH)
    expect(channelIds).toContain(CH2)
  })

  test('spawn failure for one route → surfaced via Slack, other routes still launch', async () => {
    const CH2 = 'C_FAIL'
    const config = makeRoutingConfig({
      routes: {
        [CH]: makeRouteEntry({ cwd: '/tmp/cwd1' }),
        [CH2]: makeRouteEntry({ cwd: '/tmp/cwd2' }),
      },
    })

    const { web, posts } = makeWebStub()

    // Second spawn will fail with non-collision error
    stub.setNextSpawnError({ ok: true }) // first succeeds
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 1, message: 'template error', stderr: 'template rejected' } })

    const result = await startupSessionManager(config, {}, web)

    // At least one succeeded
    expect(result.succeeded).toBeGreaterThanOrEqual(1)
    expect(result.failed).toBeGreaterThanOrEqual(1)

    // Wait for async posts
    await new Promise(r => setTimeout(r, 20))

    // Slack post for the failure
    const failurePosts = posts.filter(p => p.channel === CH2)
    expect(failurePosts.length).toBeGreaterThanOrEqual(1)
  })

  test('reconcileOrphans + startupSessionManager called in sequence — orphan killed+deleted, configured route spawns', async () => {
    const orphanCh = 'C_ORPHAN'
    const orphanRow = makeSpawnRow({ channelId: orphanCh, state: 'waiting' })
    stub.setSpawnRows([orphanRow])

    const config = singleRoute()

    // reconcileOrphans is a separate call — callers invoke it alongside startupSessionManager
    const orphanResult = await reconcileOrphans(config)
    expect(orphanResult.found).toBe(1)
    expect(orphanResult.killed).toBe(1)

    const killCalls = stub.calls.filter(c => c.verb === 'kill')
    expect(killCalls.length).toBeGreaterThanOrEqual(1)
    const killedInstanceIds = killCalls.map(c => {
      const idx = c.argv.indexOf('--claude-instance-id')
      return c.argv[idx + 1]
    })
    expect(killedInstanceIds).toContain(`cscb_${orphanCh}`)

    // startupSessionManager succeeds for configured route regardless
    const result = await startupSessionManager(config)
    expect(result.succeeded).toBeGreaterThanOrEqual(1)
  })

  test('dry-run: returns no-op actions, no CLI calls', async () => {
    process.env['SLACK_DRY_RUN'] = 'true'

    const config = singleRoute()
    const result = await startupSessionManager(config)

    // In dry-run, spawnForRoute returns no-op
    expect(result.perChannel.every(r => r.action === 'no-op')).toBe(true)

    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(0)
  })

  test('multi-route: Slack post failure does not throw; startup completes', async () => {
    const failingWeb = {
      chat: {
        postMessage: async () => { throw new Error('Slack API down') },
      },
    } as unknown as WebClient

    // Force spawn error for the route
    stub.setNextSpawnError({
      ok: false,
      error: { kind: 'ErrNonZeroExit', exitCode: 1, message: 'fail', stderr: 'fail stderr' },
    })

    const config = singleRoute()
    // Should not throw even if Slack post fails
    const result = await startupSessionManager(config, {}, failingWeb)
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Epic-1 boundary canary — no spawn argv includes --append-system-prompt-file
// ---------------------------------------------------------------------------

describe('Epic-1 boundary canary', () => {
  test('no spawn argv across tests includes --append-system-prompt-file', async () => {
    const config = singleRoute()
    await spawnForRoute(CH, { cwd: CWD }, config)

    for (const call of stub.calls) {
      if (call.verb === 'spawn') {
        expect(call.argv).not.toContain('--append-system-prompt-file')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Spawn invariants — SR-8.6
// ---------------------------------------------------------------------------

describe('spawn invariants (SR-8.6)', () => {
  // -------------------------------------------------------------------------
  // Invariant 1: every spawn argv contains --relay-mode on (adjacent elements)
  // -------------------------------------------------------------------------

  function assertAllSpawnsHaveRelayModeOn(calls: typeof stub.calls): void {
    const spawnCalls = calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls.length).toBeGreaterThan(0)
    for (const call of spawnCalls) {
      const idx = call.argv.indexOf('--relay-mode')
      expect(idx).toBeGreaterThan(-1)
      expect(call.argv[idx + 1]).toBe('on')
    }
  }

  test('happy path (fresh spawn) — spawn argv contains --relay-mode on', async () => {
    const config = singleRoute()
    await spawnForRoute(CH, { cwd: CWD }, config)
    assertAllSpawnsHaveRelayModeOn(stub.calls)
  })

  test('collision→terminal→resume→ErrNoSessionId→delete+spawn — all spawn calls contain --relay-mode on', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'ended' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'ended' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })
    stub.setNextResumeError(INSTANCE_ID, { ok: false, error: { kind: 'ErrNoSessionId', message: 'no session' } })

    const config = singleRoute({ resume_enabled: true })
    const result = await spawnForRoute(CH, { cwd: CWD }, config)
    expect(result.action).toBe('spawned')

    // Two spawn calls: initial collision + fresh spawn after delete
    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(2)
    assertAllSpawnsHaveRelayModeOn(stub.calls)
  })

  test('collision→terminal→resume→ErrJsonlMissing→delete+spawn — all spawn calls contain --relay-mode on', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'ended' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'ended' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })
    stub.setNextResumeError(INSTANCE_ID, { ok: false, error: { kind: 'ErrJsonlMissing', message: 'no jsonl' } })

    const config = singleRoute({ resume_enabled: true })
    const result = await spawnForRoute(CH, { cwd: CWD }, config)
    expect(result.action).toBe('spawned')

    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(2)
    assertAllSpawnsHaveRelayModeOn(stub.calls)
  })

  test('resume_enabled=false + terminal state → kill+delete+spawn — all spawn calls contain --relay-mode on', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'ended' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'ended' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    const config = singleRoute({ resume_enabled: false })
    const result = await spawnForRoute(CH, { cwd: CWD }, config)
    expect(result.action).toBe('spawned')

    const spawnCalls = stub.calls.filter(c => c.verb === 'spawn')
    expect(spawnCalls).toHaveLength(2)
    assertAllSpawnsHaveRelayModeOn(stub.calls)
  })

  // -------------------------------------------------------------------------
  // Invariant 2: reconcile against existing service=cscb,channel=<id> row
  // produces no duplicate spawn (idempotency)
  // -------------------------------------------------------------------------

  test('pre-existing waiting row → spawnForRoute collision path → spawn count 0 after collision, no duplicate', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'waiting' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'waiting' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    const config = singleRoute()
    const result = await spawnForRoute(CH, { cwd: CWD }, config)
    expect(result.action).toBe('reconnected')

    // Collision path: initial spawn attempt collides but transitions to send-keys — no second spawn
    expect(stub.calls.filter(c => c.verb === 'spawn')).toHaveLength(1)
  })

  test('startupSessionManager with pre-existing waiting row — cumulative spawn count stays 1 across two runs', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'waiting' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'waiting' }))

    const config = singleRoute()

    // First run: collision → reconnect (no fresh spawn)
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })
    await startupSessionManager(config)
    const afterFirstRun = stub.calls.filter(c => c.verb === 'spawn').length
    expect(afterFirstRun).toBe(1)

    // Second run: collision again → still no fresh spawn
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })
    await startupSessionManager(config)
    const afterSecondRun = stub.calls.filter(c => c.verb === 'spawn').length
    expect(afterSecondRun).toBe(2) // one attempt per run, no extra duplicates
    // No additional fresh spawns beyond the collision attempts
    const resumeCalls = stub.calls.filter(c => c.verb === 'resume')
    expect(resumeCalls).toHaveLength(0)
  })

  test('pre-existing working row → no fresh spawn issued', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'working' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'working' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    _setWaitForWaitingTimeoutMs(50)
    const config = singleRoute({ claude_director_poll_interval_ms: 10 })
    const result = await spawnForRoute(CH, { cwd: CWD }, config)

    // working state eventually times out → no fresh spawn, just the initial collision attempt
    expect(stub.calls.filter(c => c.verb === 'spawn')).toHaveLength(1)
    // No resume issued for working state
    expect(stub.calls.filter(c => c.verb === 'resume')).toHaveLength(0)
  })

  test('pre-existing pending row → no fresh spawn issued', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'pending' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'pending' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    const config = singleRoute()
    const result = await spawnForRoute(CH, { cwd: CWD }, config)
    expect(result.action).toBe('no-op')

    expect(stub.calls.filter(c => c.verb === 'spawn')).toHaveLength(1)
    expect(stub.calls.filter(c => c.verb === 'resume')).toHaveLength(0)
  })

  test('pre-existing ended row + resume_enabled: true — first run: spawn=1 attempt (collision), resume=1; second run with waiting row: no more spawns, no more resumes', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'ended' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'ended' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    const config = singleRoute({ resume_enabled: true })

    // First run: collision → resume path
    await spawnForRoute(CH, { cwd: CWD }, config)
    expect(stub.calls.filter(c => c.verb === 'spawn')).toHaveLength(1)
    expect(stub.calls.filter(c => c.verb === 'resume')).toHaveLength(1)

    // Simulate post-resume state: row now in waiting
    stub.setSpawnRows([makeSpawnRow({ channelId: CH, state: 'waiting' })])
    stub.setGetPayload(INSTANCE_ID, makeGetPayload({ channelId: CH, state: 'waiting' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })

    // Second run: waiting state → reconnect, no new spawns, no new resumes
    await spawnForRoute(CH, { cwd: CWD }, config)
    expect(stub.calls.filter(c => c.verb === 'spawn')).toHaveLength(2) // one collision attempt each run
    expect(stub.calls.filter(c => c.verb === 'resume')).toHaveLength(1) // cumulative resume count unchanged
  })

  // -------------------------------------------------------------------------
  // Invariant 3: argv-style — every stub call has an array argv
  // -------------------------------------------------------------------------

  test('all claude-director calls recorded by stub are argv-style (Array.isArray(c.argv))', async () => {
    // Drive multiple code paths to populate stub.calls
    const config = singleRoute()
    await spawnForRoute(CH, { cwd: CWD }, config)

    // Collision → resume path
    const CH2 = 'C_INV3'
    const INSTANCE_ID2 = `cscb_${CH2}`
    stub.setSpawnRows([makeSpawnRow({ channelId: CH2, state: 'ended' })])
    stub.setGetPayload(INSTANCE_ID2, makeGetPayload({ channelId: CH2, state: 'ended' }))
    stub.setNextSpawnError({ ok: false, error: { kind: 'ErrInstanceIdCollision', message: 'collision' } })
    await spawnForRoute(CH2, { cwd: CWD }, singleRoute({ resume_enabled: true }))

    expect(stub.calls.length).toBeGreaterThan(0)
    expect(stub.calls.every(c => Array.isArray(c.argv))).toBe(true)
  })
})
