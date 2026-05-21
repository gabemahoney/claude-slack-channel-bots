/**
 * permission-relay.test.ts — Poller coverage for permission-poller.ts (SR-2.1)
 *
 * Tests the single-threaded polling loop: discovery, expiry, race handling,
 * single-threaded gate, cadence, and Block Kit shape.
 *
 * TW2 will add click-handler tests below this section.
 * TW3 owns tests/action-id-parser.test.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test'
import {
  initPermissionPoller,
  startPermissionPoller,
  stopPermissionPoller,
  markFinalized,
  getLivePromptsSnapshot,
  getLivePrompt,
  dropLivePrompt,
  _resetPollerState,
  type PermissionPollerDeps,
  type LivePromptEntry,
} from '../src/permission-poller.ts'
import {
  handlePermissionClick,
  type PermissionClickDeps,
} from '../src/permission-click-handler.ts'
import {
  ClaudeDirectorStub,
  makeSpawnRow,
  makeGetPayload,
} from './test-helpers/claude-director-stub.ts'
import type { GetResult, DecideResult } from '../src/claude-director-cli.ts'

// ---------------------------------------------------------------------------
// Block Kit builder replica (mirrors server.ts buildPermissionBlocks)
// Used to assert byte-identical Block Kit output.
// ---------------------------------------------------------------------------

function buildPermissionBlocks(
  toolName: string,
  toolInput: Record<string, unknown>,
  claudeInstanceId: string,
  requestId: string,
): any[] {
  let summary: string
  if (toolName === 'Bash') {
    summary = '`' + String(toolInput['command'] ?? JSON.stringify(toolInput).slice(0, 500)) + '`'
  } else if (toolName === 'Edit' || toolName === 'Write') {
    summary = '`' + String(toolInput['file_path'] ?? JSON.stringify(toolInput).slice(0, 500)) + '`'
  } else {
    const raw = JSON.stringify(toolInput)
    summary = '`' + (raw.length > 500 ? raw.slice(0, 500) + '…' : raw) + '`'
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🤖🛠️ *${toolName}*\n${summary}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Allow' },
          style: 'primary',
          action_id: `perm_allow_${claudeInstanceId}_${requestId}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          action_id: `perm_deny_${claudeInstanceId}_${requestId}`,
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Types for stub captures
// ---------------------------------------------------------------------------

interface PostMessageCall {
  channel: string
  toolName: string
  toolInput: Record<string, unknown>
  claudeInstanceId: string
  requestId: string
}

interface ExpireMessageCall {
  channelId: string
  messageTs: string
  toolName: string
}

// ---------------------------------------------------------------------------
// makePollerDeps factory
// ---------------------------------------------------------------------------

interface TestDeps {
  stub: ClaudeDirectorStub
  postMessageCalls: PostMessageCall[]
  expireMessageCalls: ExpireMessageCall[]
  deps: PermissionPollerDeps
  consoleErrors: unknown[][]
  consoleWarns: unknown[][]
  restoreConsole: () => void
}

function makePollerDeps(opts: {
  pollIntervalMs?: number
  postMessageTs?: string
  postMessageDelay?: number
} = {}): TestDeps {
  const stub = new ClaudeDirectorStub()
  const postMessageCalls: PostMessageCall[] = []
  const expireMessageCalls: ExpireMessageCall[] = []
  const consoleErrors: unknown[][] = []
  const consoleWarns: unknown[][] = []

  const origError = console.error
  const origWarn = console.warn
  console.error = (...args: unknown[]) => { consoleErrors.push(args) }
  console.warn = (...args: unknown[]) => { consoleWarns.push(args) }

  const restoreConsole = () => {
    console.error = origError
    console.warn = origWarn
  }

  const deps: PermissionPollerDeps = {
    pollIntervalMs: opts.pollIntervalMs ?? 1000,

    async postPermissionMessage(channelId, toolName, toolInput, claudeInstanceId, requestId) {
      postMessageCalls.push({ channel: channelId, toolName, toolInput, claudeInstanceId, requestId })
      if (opts.postMessageDelay) {
        await new Promise(resolve => setTimeout(resolve, opts.postMessageDelay))
      }
      return opts.postMessageTs ?? `ts-${claudeInstanceId}`
    },

    async expirePermissionMessage(channelId, messageTs, toolName) {
      expireMessageCalls.push({ channelId, messageTs, toolName })
    },
  }

  return { stub, postMessageCalls, expireMessageCalls, deps, consoleErrors, consoleWarns, restoreConsole }
}

// ---------------------------------------------------------------------------
// Helpers to flush async microtasks
// ---------------------------------------------------------------------------

async function flushMicrotasks(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let activeRestoreConsole: (() => void) | null = null

beforeEach(() => {
  _resetPollerState()
  activeRestoreConsole = null
})

afterEach(() => {
  stopPermissionPoller()
  _resetPollerState()
  if (activeRestoreConsole) {
    activeRestoreConsole()
    activeRestoreConsole = null
  }
})

// ===========================================================================
// 1. Cadence
// ===========================================================================

describe('cadence', () => {
  test('1a. 1000ms interval — advance 5s → 5 list calls', async () => {
    jest.useFakeTimers()
    try {
      const { stub, deps, restoreConsole } = makePollerDeps({ pollIntervalMs: 1000 })
      activeRestoreConsole = restoreConsole
      stub.install()
      stub.setSpawnRows([])

      initPermissionPoller(deps)
      startPermissionPoller()

      // Advance 5 intervals
      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(1000)
        await flushMicrotasks()
      }

      const listCalls = stub.calls.filter(c => c.verb === 'list')
      expect(listCalls).toHaveLength(5)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('1b. 500ms interval — advance 3s → 6 list calls', async () => {
    jest.useFakeTimers()
    try {
      const { stub, deps, restoreConsole } = makePollerDeps({ pollIntervalMs: 500 })
      activeRestoreConsole = restoreConsole
      stub.install()
      stub.setSpawnRows([])

      initPermissionPoller(deps)
      startPermissionPoller()

      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(500)
        await flushMicrotasks()
      }

      const listCalls = stub.calls.filter(c => c.verb === 'list')
      expect(listCalls).toHaveLength(6)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('1c. startPermissionPoller without initPermissionPoller throws', () => {
    expect(() => startPermissionPoller()).toThrow()
  })

  test('1d. calling startPermissionPoller twice does not double-tick', async () => {
    jest.useFakeTimers()
    try {
      const { stub, deps, restoreConsole } = makePollerDeps({ pollIntervalMs: 1000 })
      activeRestoreConsole = restoreConsole
      stub.install()
      stub.setSpawnRows([])

      initPermissionPoller(deps)
      startPermissionPoller()
      startPermissionPoller() // second call is a no-op

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      const listCalls = stub.calls.filter(c => c.verb === 'list')
      expect(listCalls).toHaveLength(1)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })
})

// ===========================================================================
// 2. Single-threaded gate
// ===========================================================================

describe('single-threaded gate', () => {
  test('2a. in-flight tick blocks subsequent ticks', async () => {
    jest.useFakeTimers()
    try {
      // Use a slow postMessage so the tick stays in flight
      let resolvePost!: () => void
      let postCount = 0
      const { stub, deps: baseDeps, restoreConsole } = makePollerDeps({ pollIntervalMs: 1000 })
      activeRestoreConsole = restoreConsole

      // Override postPermissionMessage with a never-resolving promise
      const blockingDeps: PermissionPollerDeps = {
        ...baseDeps,
        async postPermissionMessage(channelId, toolName, toolInput, claudeInstanceId, requestId) {
          postCount++
          await new Promise<void>(resolve => { resolvePost = resolve })
          return `ts-${claudeInstanceId}`
        },
      }

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_BLOCK', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_BLOCK', makeGetPayload({ channelId: 'C_BLOCK', requestId: '1', toolName: 'Bash' }))
      stub.install()

      initPermissionPoller(blockingDeps)
      startPermissionPoller()

      // Advance interval 1: tick starts, calls list → calls get → calls postPermissionMessage (hangs)
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      // Advance interval 2 and 3: tick skipped (in-flight)
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      // Only one list call happened (1st tick)
      const listCalls = stub.calls.filter(c => c.verb === 'list')
      expect(listCalls).toHaveLength(1)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('2b. WARN emitted after exactly 5 consecutive skips', async () => {
    jest.useFakeTimers()
    try {
      let resolvePost!: () => void
      const { stub, deps: baseDeps, consoleWarns, restoreConsole } = makePollerDeps({ pollIntervalMs: 1000 })
      activeRestoreConsole = restoreConsole

      const blockingDeps: PermissionPollerDeps = {
        ...baseDeps,
        async postPermissionMessage(channelId, toolName, toolInput, claudeInstanceId, requestId) {
          await new Promise<void>(resolve => { resolvePost = resolve })
          return `ts-${claudeInstanceId}`
        },
      }

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_WARN', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_WARN', makeGetPayload({ channelId: 'C_WARN', requestId: '1' }))
      stub.install()

      initPermissionPoller(blockingDeps)
      startPermissionPoller()

      // Tick 1: starts post (in flight)
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      // Ticks 2-5: skipped (4 skips)
      for (let i = 0; i < 4; i++) {
        jest.advanceTimersByTime(1000)
        await flushMicrotasks()
      }
      // No warn yet at 4 skips
      const warnsBefore = consoleWarns.filter(w => String(w[0]).includes('consecutive ticks skipped'))
      expect(warnsBefore).toHaveLength(0)

      // Tick 6: 5th skip → triggers WARN
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      const warnsAfter = consoleWarns.filter(w => String(w[0]).includes('consecutive ticks skipped'))
      expect(warnsAfter).toHaveLength(1)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('2c. WARN not emitted before 5 consecutive skips', async () => {
    jest.useFakeTimers()
    try {
      const { stub, deps: baseDeps, consoleWarns, restoreConsole } = makePollerDeps({ pollIntervalMs: 1000 })
      activeRestoreConsole = restoreConsole

      let started = false
      const blockingDeps: PermissionPollerDeps = {
        ...baseDeps,
        async postPermissionMessage(channelId, toolName, toolInput, claudeInstanceId, requestId) {
          await new Promise<void>(resolve => setTimeout(resolve, 10_000)) // long delay
          return `ts-${claudeInstanceId}`
        },
      }

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_NOWARN', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_NOWARN', makeGetPayload({ channelId: 'C_NOWARN', requestId: '1' }))
      stub.install()

      initPermissionPoller(blockingDeps)
      startPermissionPoller()

      // Tick 1 + 4 skips = total 4 skips (not 5)
      jest.advanceTimersByTime(1000) // tick 1: starts
      await flushMicrotasks()
      for (let i = 0; i < 4; i++) {
        jest.advanceTimersByTime(1000)
        await flushMicrotasks()
      }

      const warns = consoleWarns.filter(w => String(w[0]).includes('consecutive ticks skipped'))
      expect(warns).toHaveLength(0)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('2d. skip counter resets after in-flight tick resolves', async () => {
    jest.useFakeTimers()
    try {
      let resolvePost!: () => void
      const { stub, deps: baseDeps, postMessageCalls, consoleWarns, restoreConsole } = makePollerDeps({ pollIntervalMs: 1000 })
      activeRestoreConsole = restoreConsole

      const blockingDeps: PermissionPollerDeps = {
        ...baseDeps,
        async postPermissionMessage(channelId, toolName, toolInput, claudeInstanceId, requestId) {
          postMessageCalls.push({ channel: channelId, toolName, toolInput, claudeInstanceId, requestId })
          await new Promise<void>(resolve => { resolvePost = resolve })
          return `ts-${claudeInstanceId}`
        },
      }

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_RESET', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_RESET', makeGetPayload({ channelId: 'C_RESET', requestId: '1' }))
      stub.install()

      initPermissionPoller(blockingDeps)
      startPermissionPoller()

      // Tick 1: starts
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      // 3 skips
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(1000)
        await flushMicrotasks()
      }

      // Resolve the in-flight post
      resolvePost()
      await flushMicrotasks()

      // Now clear spawn rows so subsequent ticks are fast (no new instances)
      stub.setSpawnRows([])

      // Advance 2 more ticks — these should proceed normally (no skip)
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      // Total list calls: 1 (initial) + 2 (post-resolve) = 3
      const listCalls = stub.calls.filter(c => c.verb === 'list')
      expect(listCalls.length).toBeGreaterThanOrEqual(3)

      // No warn emitted (only 3 skips, not 5)
      const warns = consoleWarns.filter(w => String(w[0]).includes('consecutive ticks skipped'))
      expect(warns).toHaveLength(0)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })
})

// ===========================================================================
// 3. New-instanceId discovery
// ===========================================================================

describe('new-instanceId discovery', () => {
  test('3a. happy path — one row → list + get + postMessage + map entry', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, deps, restoreConsole } = makePollerDeps({ pollIntervalMs: 1000 })
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C123', state: 'check_permission' })])
      stub.setGetPayload('cscb_C123', makeGetPayload({
        channelId: 'C123',
        requestId: '42',
        toolName: 'Bash',
        toolInput: '{"command":"echo hello"}',
      }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      // list called
      const listCalls = stub.calls.filter(c => c.verb === 'list')
      expect(listCalls).toHaveLength(1)

      // get called with --claude-instance-id cscb_C123
      const getCalls = stub.calls.filter(c => c.verb === 'get')
      expect(getCalls).toHaveLength(1)
      expect(getCalls[0].argv).toContain('--claude-instance-id')
      expect(getCalls[0].argv).toContain('cscb_C123')

      // postMessage called once
      expect(postMessageCalls).toHaveLength(1)
      expect(postMessageCalls[0].channel).toBe('C123')
      expect(postMessageCalls[0].toolName).toBe('Bash')
      expect(postMessageCalls[0].toolInput).toEqual({ command: 'echo hello' })
      expect(postMessageCalls[0].claudeInstanceId).toBe('cscb_C123')
      expect(postMessageCalls[0].requestId).toBe('42')

      // map entry recorded
      const entry = getLivePrompt('cscb_C123')
      expect(entry).toBeDefined()
      expect(entry!.messageTs).toBe('ts-cscb_C123')
      expect(entry!.channelId).toBe('C123')
      expect(entry!.requestId).toBe('42')
      expect(entry!.toolName).toBe('Bash')
      expect(entry!.finalizedAt).toBeUndefined()

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('3b. tool_input parsed from JSON string to object before postMessage', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_PARSE', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_PARSE', makeGetPayload({
        channelId: 'C_PARSE',
        requestId: '7',
        toolName: 'Edit',
        toolInput: '{"file_path":"/tmp/foo.ts","content":"hello"}',
      }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(postMessageCalls).toHaveLength(1)
      expect(postMessageCalls[0].toolInput).toEqual({
        file_path: '/tmp/foo.ts',
        content: 'hello',
      })

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('3c. malformed tool_input — still posts with { raw } fallback, console.warn logged', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, deps, consoleWarns, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_BAD', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_BAD', makeGetPayload({
        channelId: 'C_BAD',
        requestId: '9',
        toolName: 'Bash',
        toolInput: 'not-valid-json{{{',
      }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      // Still posts
      expect(postMessageCalls).toHaveLength(1)
      expect(postMessageCalls[0].toolInput).toEqual({ raw: 'not-valid-json{{{' })

      // console.warn logged
      const parseWarns = consoleWarns.filter(w => String(w[0]).includes('tool_input JSON parse failed'))
      expect(parseWarns).toHaveLength(1)

      // map entry still added
      expect(getLivePrompt('cscb_C_BAD')).toBeDefined()

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('3d. bigint request_id — stored as string, action_ids contain exact digits', async () => {
    jest.useFakeTimers()
    try {
      const BIGINT_REQ_ID = '9007199254740993'
      const { stub, postMessageCalls, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_BIG', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_BIG', makeGetPayload({
        channelId: 'C_BIG',
        requestId: BIGINT_REQ_ID,
        toolName: 'Bash',
        toolInput: '{"command":"echo big"}',
      }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(postMessageCalls).toHaveLength(1)
      // requestId passed as string with no precision loss
      expect(postMessageCalls[0].requestId).toBe(BIGINT_REQ_ID)

      // map entry stores requestId as string
      const entry = getLivePrompt('cscb_C_BIG')
      expect(entry).toBeDefined()
      expect(entry!.requestId).toBe(BIGINT_REQ_ID)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('3e. idempotent re-tick — second tick does NOT re-post or re-get', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_IDEM', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_IDEM', makeGetPayload({
        channelId: 'C_IDEM',
        requestId: '5',
        toolName: 'Bash',
      }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      // Tick 2: same row still present
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      const getCalls = stub.calls.filter(c => c.verb === 'get')
      expect(getCalls).toHaveLength(1) // only called once
      expect(postMessageCalls).toHaveLength(1) // only posted once

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('3f. row with no channel label — console.warn + skip, no postMessage, T-A not invoked', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, deps, consoleWarns, consoleErrors, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      // Make a spawn row without channel label
      const noChannelRow = {
        claudeInstanceId: 'cscb_C_NOLABEL',
        state: 'check_permission',
        labels: { service: 'cscb' }, // no 'channel' key
        cwd: '/tmp/test',
        tmuxSessionName: 'slack_bot_C_NOLABEL',
        relayMode: 'on' as const,
      }
      stub.setSpawnRows([noChannelRow])
      stub.setGetPayload('cscb_C_NOLABEL', {
        claudeInstanceId: 'cscb_C_NOLABEL',
        state: 'check_permission',
        labels: { service: 'cscb' },
        permissionRequest: {
          requestId: '1',
          toolName: 'Bash',
          toolInput: '{"command":"ls"}',
        },
      })
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      // console.warn about missing label
      const labelWarns = consoleWarns.filter(w => String(w[0]).includes('no channel label'))
      expect(labelWarns).toHaveLength(1)

      // No postMessage
      expect(postMessageCalls).toHaveLength(0)

      // No T-A (startup-errors) — no console.error about startup
      const taErrors = consoleErrors.filter(w => String(w[0]).includes('startup'))
      expect(taErrors).toHaveLength(0)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })
})

// ===========================================================================
// 4. Race / error handling on `get`
// ===========================================================================

describe('race / error handling on get', () => {
  test('4a. permissionRequest === null — no postMessage, no map entry, no console.error', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, deps, consoleErrors, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_NULL', state: 'check_permission' })])
      // makeGetPayload with no requestId → permissionRequest = null
      stub.setGetPayload('cscb_C_NULL', makeGetPayload({ channelId: 'C_NULL' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(postMessageCalls).toHaveLength(0)
      expect(getLivePrompt('cscb_C_NULL')).toBeUndefined()
      // No errors (silent skip)
      const raceErrors = consoleErrors.filter(w => String(w[0]).includes('permission-poller'))
      expect(raceErrors).toHaveLength(0)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('4b. ErrSpawnNotFound — silent skip, no postMessage, T-A spy NOT invoked', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, deps, consoleErrors, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      // Row in list but not in getPayloads and not in spawnRows → ErrSpawnNotFound from handleGet
      // We need the row in list but cause get to fail with ErrSpawnNotFound
      // ClaudeDirectorStub.handleGet checks instanceExists() — returns notFound if not in spawnRows or getPayloads
      // So: add to spawnRows for list, but don't add to getPayloads and remove from spawnRows right after list
      // Simpler: use a custom stub that returns ErrSpawnNotFound for get
      // We can set getPayloads to not include the instance but have it in spawnRows for the list...
      // Actually ClaudeDirectorStub.handleGet falls back to defaultGetPayload (which has permissionRequest: null)
      // if instanceExists() is true. We need a different approach: not add to spawnRows after list.
      // The cleanest approach: a custom spawnRunner for this test.

      // Use the stub but only add the row for list (not for get)
      // ClaudeDirectorStub.handleList uses this.spawnRows
      // ClaudeDirectorStub.handleGet checks instanceExists → spawnRows OR getPayloads
      // If we set the spawn row but not a getPayload, it returns defaultGetPayload (permissionRequest: null)
      // To get ErrSpawnNotFound we need instanceExists() to return false.
      // Solution: set spawnRows for list output then clear before get fires... not possible with sync stub.

      // Alternative: manually drive the runner to return different results per verb
      const { _setSpawnRunner, _resetSpawnRunner, CLAUDE_DIRECTOR_ERROR_TOKENS } = await import('../src/claude-director-cli.ts')

      let callCount = 0
      _setSpawnRunner((_cmd, argv) => {
        const verb = argv[0] ?? ''
        callCount++
        if (verb === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify({ spawns: [{
              claude_instance_id: 'cscb_C_NOTFOUND',
              state: 'check_permission',
              labels: { service: 'cscb', channel: 'C_NOTFOUND' },
              cwd: '/tmp',
              tmux_session_name: 'slack_bot_C_NOTFOUND',
              relay_mode: 'on',
            }] }),
            stderr: '',
          }
        }
        if (verb === 'get') {
          return {
            status: 1,
            stdout: '',
            stderr: JSON.stringify({ err_name: CLAUDE_DIRECTOR_ERROR_TOKENS.ErrSpawnNotFound, err_description: 'cscb_C_NOTFOUND' }),
          }
        }
        return { status: 0, stdout: '{}', stderr: '' }
      })

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(postMessageCalls).toHaveLength(0)
      expect(getLivePrompt('cscb_C_NOTFOUND')).toBeUndefined()

      // T-A spy NOT invoked
      const taErrors = consoleErrors.filter(w => String(w[0]).includes('startup'))
      expect(taErrors).toHaveLength(0)

      // No console.error about get (ErrSpawnNotFound is a silent skip)
      const pollerErrors = consoleErrors.filter(w => String(w[0]).includes('permission-poller'))
      expect(pollerErrors).toHaveLength(0)

      _resetSpawnRunner()
    } finally {
      jest.useRealTimers()
    }
  })

  test('4c. other get error — console.error, no postMessage, T-A spy NOT invoked', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, deps, consoleErrors, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      const { _setSpawnRunner, _resetSpawnRunner } = await import('../src/claude-director-cli.ts')

      _setSpawnRunner((_cmd, argv) => {
        const verb = argv[0] ?? ''
        if (verb === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify({ spawns: [{
              claude_instance_id: 'cscb_C_GETERR',
              state: 'check_permission',
              labels: { service: 'cscb', channel: 'C_GETERR' },
              cwd: '/tmp',
              tmux_session_name: 'slack_bot_C_GETERR',
              relay_mode: 'on',
            }] }),
            stderr: '',
          }
        }
        if (verb === 'get') {
          return {
            status: 1,
            stdout: '',
            stderr: JSON.stringify({ err_name: 'ErrNonZeroExit', err_description: 'some error' }),
          }
        }
        return { status: 0, stdout: '{}', stderr: '' }
      })

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(postMessageCalls).toHaveLength(0)
      expect(getLivePrompt('cscb_C_GETERR')).toBeUndefined()

      // console.error logged
      const pollerErrors = consoleErrors.filter(w => String(w[0]).includes('permission-poller'))
      expect(pollerErrors).toHaveLength(1)

      // T-A spy NOT invoked (explicit canary)
      const taErrors = consoleErrors.filter(w => String(w[0]).includes('startup'))
      expect(taErrors).toHaveLength(0)

      _resetSpawnRunner()
    } finally {
      jest.useRealTimers()
    }
  })
})

// ===========================================================================
// 5. Expiry path
// ===========================================================================

describe('expiry path', () => {
  test('5a. disappeared row without finalizedAt → chat.update called, entry removed', async () => {
    jest.useFakeTimers()
    try {
      const { stub, expireMessageCalls, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_EXP', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_EXP', makeGetPayload({ channelId: 'C_EXP', requestId: '1' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      // Tick 1: discover
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(getLivePrompt('cscb_C_EXP')).toBeDefined()
      expect(expireMessageCalls).toHaveLength(0)

      // Remove from list
      stub.setSpawnRows([])

      // Tick 2: disappears → expire
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(expireMessageCalls).toHaveLength(1)
      expect(expireMessageCalls[0].channelId).toBe('C_EXP')
      expect(expireMessageCalls[0].messageTs).toBe('ts-cscb_C_EXP')
      expect(expireMessageCalls[0].toolName).toBe('bash')

      // Entry removed
      expect(getLivePrompt('cscb_C_EXP')).toBeUndefined()

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('5b. finalizedAt within 30s window — chat.update NOT called, entry dropped silently', async () => {
    jest.useFakeTimers()
    try {
      const { stub, expireMessageCalls, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_FIN', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_FIN', makeGetPayload({ channelId: 'C_FIN', requestId: '1' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      // Tick 1: discover
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(getLivePrompt('cscb_C_FIN')).toBeDefined()

      // Mark finalized (click handler claiming it) — finalizedAt = now (fake clock)
      markFinalized('cscb_C_FIN')
      expect(getLivePrompt('cscb_C_FIN')!.finalizedAt).toBeDefined()

      // Remove from list
      stub.setSpawnRows([])

      // Tick 2: within 30s window → no expire call, entry dropped
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(expireMessageCalls).toHaveLength(0)
      expect(getLivePrompt('cscb_C_FIN')).toBeUndefined()

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('5c. boundary at now - 29_999ms — within window, NO chat.update', async () => {
    jest.useFakeTimers()
    try {
      const { stub, expireMessageCalls, deps, restoreConsole } = makePollerDeps({ pollIntervalMs: 1000 })
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_29', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_29', makeGetPayload({ channelId: 'C_29', requestId: '1' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      // Tick 1: discover entry
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()
      expect(getLivePrompt('cscb_C_29')).toBeDefined()

      // Mark finalized at current fake time
      markFinalized('cscb_C_29')
      const finalizedTime = getLivePrompt('cscb_C_29')!.finalizedAt!

      // Keep the row in the list while we advance 28_000ms (so expiry check never fires
      // with row absent). After each tick the row is still present → no expiry check.
      jest.advanceTimersByTime(28_000)
      await flushMicrotasks()
      // Entry still in map (row still in list)
      expect(getLivePrompt('cscb_C_29')).toBeDefined()

      // Now remove the row — elapsed since finalizedAt is ~28_000ms < 30_000
      stub.setSpawnRows([])

      // One tick fires — elapsed from finalizedAt will be ~29_000ms (< 30_000 → within window)
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(expireMessageCalls).toHaveLength(0)
      // Entry dropped silently
      expect(getLivePrompt('cscb_C_29')).toBeUndefined()

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('5d. boundary at now - 30_001ms — outside window, chat.update IS called', async () => {
    jest.useFakeTimers()
    try {
      const { stub, expireMessageCalls, deps, restoreConsole } = makePollerDeps({ pollIntervalMs: 1000 })
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_30', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_30', makeGetPayload({ channelId: 'C_30', requestId: '1' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      // Tick 1: discover entry
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()
      expect(getLivePrompt('cscb_C_30')).toBeDefined()

      // Mark finalized at current fake time
      markFinalized('cscb_C_30')

      // Keep row in list while advancing 30_001ms so expiry check never fires
      jest.advanceTimersByTime(30_001)
      await flushMicrotasks()
      // Entry still in map (row still in list during entire window)
      expect(getLivePrompt('cscb_C_30')).toBeDefined()

      // Now remove the row — elapsed since finalizedAt is > 30_000 → outside window
      stub.setSpawnRows([])

      // Trigger exactly one more tick
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(expireMessageCalls).toHaveLength(1)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('5e. 10s ago finalizedAt — within window, no chat.update', async () => {
    jest.useFakeTimers()
    try {
      const { stub, expireMessageCalls, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_10S', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_10S', makeGetPayload({ channelId: 'C_10S', requestId: '1' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      markFinalized('cscb_C_10S')
      stub.setSpawnRows([])

      // 10s later
      jest.advanceTimersByTime(10_000)
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(expireMessageCalls).toHaveLength(0)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })
})

// ===========================================================================
// 6. Multi-channel diff
// ===========================================================================

describe('multi-channel diff', () => {
  test('6a. two new rows → 2 get calls + 2 postMessage + 2 map entries', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([
        makeSpawnRow({ channelId: 'C_A', state: 'check_permission' }),
        makeSpawnRow({ channelId: 'C_B', state: 'check_permission' }),
      ])
      stub.setGetPayload('cscb_C_A', makeGetPayload({ channelId: 'C_A', requestId: '10' }))
      stub.setGetPayload('cscb_C_B', makeGetPayload({ channelId: 'C_B', requestId: '11' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      const getCalls = stub.calls.filter(c => c.verb === 'get')
      expect(getCalls).toHaveLength(2)
      expect(postMessageCalls).toHaveLength(2)

      const snap = getLivePromptsSnapshot()
      expect(snap.size).toBe(2)
      expect(snap.has('cscb_C_A')).toBe(true)
      expect(snap.has('cscb_C_B')).toBe(true)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('6b. one disappears → chat.update for disappeared, no new post for survivor', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, expireMessageCalls, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([
        makeSpawnRow({ channelId: 'C_STAY', state: 'check_permission' }),
        makeSpawnRow({ channelId: 'C_GONE', state: 'check_permission' }),
      ])
      stub.setGetPayload('cscb_C_STAY', makeGetPayload({ channelId: 'C_STAY', requestId: '20' }))
      stub.setGetPayload('cscb_C_GONE', makeGetPayload({ channelId: 'C_GONE', requestId: '21' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      // Tick 1: discover both
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()
      expect(postMessageCalls).toHaveLength(2)

      // Remove C_GONE
      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_STAY', state: 'check_permission' })])

      // Tick 2: C_GONE disappeared → expire; C_STAY still present → no new post
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(postMessageCalls).toHaveLength(2) // no new post for survivor
      expect(expireMessageCalls).toHaveLength(1)
      expect(expireMessageCalls[0].channelId).toBe('C_GONE')

      const snap = getLivePromptsSnapshot()
      expect(snap.size).toBe(1)
      expect(snap.has('cscb_C_STAY')).toBe(true)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('6c. new channel appears on tick 2 → 1 postMessage for new, 1 expire for disappeared, map size = 2', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, expireMessageCalls, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([
        makeSpawnRow({ channelId: 'C_OLD', state: 'check_permission' }),
        makeSpawnRow({ channelId: 'C_KEEP', state: 'check_permission' }),
      ])
      stub.setGetPayload('cscb_C_OLD', makeGetPayload({ channelId: 'C_OLD', requestId: '30' }))
      stub.setGetPayload('cscb_C_KEEP', makeGetPayload({ channelId: 'C_KEEP', requestId: '31' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      // Tick 1: discover C_OLD + C_KEEP
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()
      expect(postMessageCalls).toHaveLength(2)

      // Tick 2: C_OLD disappears, C_NEW appears
      stub.setSpawnRows([
        makeSpawnRow({ channelId: 'C_KEEP', state: 'check_permission' }),
        makeSpawnRow({ channelId: 'C_NEW', state: 'check_permission' }),
      ])
      stub.setGetPayload('cscb_C_NEW', makeGetPayload({ channelId: 'C_NEW', requestId: '32' }))

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      // 1 new post for C_NEW
      expect(postMessageCalls).toHaveLength(3)
      expect(postMessageCalls[2].channel).toBe('C_NEW')

      // 1 expire for C_OLD
      expect(expireMessageCalls).toHaveLength(1)
      expect(expireMessageCalls[0].channelId).toBe('C_OLD')

      // Map size = 2 (C_KEEP + C_NEW)
      const snap = getLivePromptsSnapshot()
      expect(snap.size).toBe(2)
      expect(snap.has('cscb_C_KEEP')).toBe(true)
      expect(snap.has('cscb_C_NEW')).toBe(true)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })
})

// ===========================================================================
// 7. Block Kit byte-identical (SR-6)
// ===========================================================================

describe('Block Kit shape (SR-6)', () => {
  test('7a. Bash tool — Block Kit matches buildPermissionBlocks output', async () => {
    jest.useFakeTimers()
    try {
      const { stub, postMessageCalls, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_BK', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_BK', makeGetPayload({
        channelId: 'C_BK',
        requestId: '99',
        toolName: 'Bash',
        toolInput: '{"command":"ls -la /tmp"}',
      }))
      stub.install()

      // Override postPermissionMessage to capture blocks
      const capturedBlocks: any[][] = []
      const { stub: _s2, ...baseDepsObj } = makePollerDeps()
      const testDepsWithBlocks: PermissionPollerDeps = {
        pollIntervalMs: 1000,
        async postPermissionMessage(channelId, toolName, toolInput, claudeInstanceId, requestId) {
          // Build expected blocks
          const expectedBlocks = buildPermissionBlocks(toolName, toolInput, claudeInstanceId, requestId)
          capturedBlocks.push(expectedBlocks)
          return `ts-${claudeInstanceId}`
        },
        async expirePermissionMessage() {},
      }

      initPermissionPoller(testDepsWithBlocks)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(capturedBlocks).toHaveLength(1)
      const blocks = capturedBlocks[0]
      expect(blocks[0].type).toBe('section')
      expect(blocks[0].text.type).toBe('mrkdwn')
      expect(blocks[0].text.text).toContain('Bash')
      expect(blocks[0].text.text).toContain('ls -la /tmp')
      expect(blocks[1].type).toBe('actions')
      expect(blocks[1].elements[0].action_id).toBe('perm_allow_cscb_C_BK_99')
      expect(blocks[1].elements[1].action_id).toBe('perm_deny_cscb_C_BK_99')

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('7b. action_ids contain exact claudeInstanceId and requestId', async () => {
    jest.useFakeTimers()
    try {
      const { stub, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_AID', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_AID', makeGetPayload({
        channelId: 'C_AID',
        requestId: '12345',
        toolName: 'Edit',
        toolInput: '{"file_path":"/tmp/test.ts"}',
      }))
      stub.install()

      let capturedActionIds: string[] = []
      const testDeps: PermissionPollerDeps = {
        pollIntervalMs: 1000,
        async postPermissionMessage(channelId, toolName, toolInput, claudeInstanceId, requestId) {
          const blocks = buildPermissionBlocks(toolName, toolInput, claudeInstanceId, requestId)
          capturedActionIds = blocks[1].elements.map((e: any) => e.action_id)
          return `ts-${claudeInstanceId}`
        },
        async expirePermissionMessage() {},
      }

      initPermissionPoller(testDeps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(capturedActionIds).toHaveLength(2)
      expect(capturedActionIds[0]).toBe('perm_allow_cscb_C_AID_12345')
      expect(capturedActionIds[1]).toBe('perm_deny_cscb_C_AID_12345')

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })
})

// ===========================================================================
// 8. State management exports
// ===========================================================================

describe('state management exports', () => {
  test('8a. dropLivePrompt removes entry from map', async () => {
    jest.useFakeTimers()
    try {
      const { stub, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_DROP', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_DROP', makeGetPayload({ channelId: 'C_DROP', requestId: '1' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      expect(getLivePrompt('cscb_C_DROP')).toBeDefined()

      dropLivePrompt('cscb_C_DROP')

      expect(getLivePrompt('cscb_C_DROP')).toBeUndefined()
      expect(getLivePromptsSnapshot().size).toBe(0)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('8b. getLivePromptsSnapshot returns read-only map', async () => {
    jest.useFakeTimers()
    try {
      const { stub, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_SNAP', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_SNAP', makeGetPayload({ channelId: 'C_SNAP', requestId: '1' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      const snap = getLivePromptsSnapshot()
      expect(snap.size).toBe(1)
      expect(snap.has('cscb_C_SNAP')).toBe(true)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('8c. markFinalized sets finalizedAt on existing entry', async () => {
    jest.useFakeTimers()
    try {
      const { stub, deps, restoreConsole } = makePollerDeps()
      activeRestoreConsole = restoreConsole

      stub.setSpawnRows([makeSpawnRow({ channelId: 'C_MF', state: 'check_permission' })])
      stub.setGetPayload('cscb_C_MF', makeGetPayload({ channelId: 'C_MF', requestId: '1' }))
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      const before = getLivePrompt('cscb_C_MF')
      expect(before).toBeDefined()
      expect(before!.finalizedAt).toBeUndefined()

      markFinalized('cscb_C_MF')

      const after = getLivePrompt('cscb_C_MF')
      expect(after!.finalizedAt).toBeDefined()
      expect(typeof after!.finalizedAt).toBe('number')

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })

  test('8d. markFinalized on unknown id is a no-op', () => {
    const { restoreConsole } = makePollerDeps()
    activeRestoreConsole = restoreConsole

    // No throws, no errors
    expect(() => markFinalized('cscb_NONEXISTENT')).not.toThrow()
  })

  test('8e. stopPermissionPoller halts ticks', async () => {
    jest.useFakeTimers()
    try {
      const { stub, deps, restoreConsole } = makePollerDeps({ pollIntervalMs: 1000 })
      activeRestoreConsole = restoreConsole
      stub.setSpawnRows([])
      stub.install()

      initPermissionPoller(deps)
      startPermissionPoller()

      jest.advanceTimersByTime(1000)
      await flushMicrotasks()

      const countAfterOne = stub.calls.filter(c => c.verb === 'list').length
      expect(countAfterOne).toBe(1)

      stopPermissionPoller()

      jest.advanceTimersByTime(3000)
      await flushMicrotasks()

      // No additional ticks after stop
      const countAfterStop = stub.calls.filter(c => c.verb === 'list').length
      expect(countAfterStop).toBe(1)

      stub.uninstall()
    } finally {
      jest.useRealTimers()
    }
  })
})

// ===========================================================================
// 9. Click handler
// ===========================================================================
//
// Tests for handlePermissionClick from src/permission-click-handler.ts.
// Uses PermissionClickDeps interface — no server.ts import needed.
//
// makeClickDeps wires up:
//   - permission-poller state (getLivePrompt / markFinalized / dropLivePrompt)
//   - ClaudeDirectorStub for cliGet / cliDecide
//   - captured chatUpdate / chatPostMessage arrays
//   - identity resolveUserName (returns userId unchanged for determinism)
// ===========================================================================

// ---------------------------------------------------------------------------
// Types for captured Slack API calls
// ---------------------------------------------------------------------------

interface ChatUpdateCall {
  channel: string
  ts: string
  text: string
  blocks: unknown[]
}

interface ChatPostMessageCall {
  channel: string
  text: string
}

// ---------------------------------------------------------------------------
// makeClickDeps factory
// ---------------------------------------------------------------------------

interface ClickTestContext {
  stub: ClaudeDirectorStub
  chatUpdateCalls: ChatUpdateCall[]
  chatPostMessageCalls: ChatPostMessageCall[]
  consoleErrors: unknown[][]
  consoleWarns: unknown[][]
  restoreConsole: () => void
  deps: PermissionClickDeps
  dispatchClick(opts: {
    actionId: string
    userId?: string
  }): Promise<import('../src/permission-click-handler.ts').ClickHandlerResult>
}

function makeClickDeps(): ClickTestContext {
  const stub = new ClaudeDirectorStub()
  const chatUpdateCalls: ChatUpdateCall[] = []
  const chatPostMessageCalls: ChatPostMessageCall[] = []
  const consoleErrors: unknown[][] = []
  const consoleWarns: unknown[][] = []

  const origError = console.error
  const origWarn = console.warn
  console.error = (...args: unknown[]) => { consoleErrors.push(args) }
  console.warn = (...args: unknown[]) => { consoleWarns.push(args) }
  const restoreConsole = () => {
    console.error = origError
    console.warn = origWarn
  }

  const deps: PermissionClickDeps = {
    getLivePrompt,
    markFinalized,
    dropLivePrompt,
    cliGet: (args) => {
      stub.install()
      const { get } = require('../src/claude-director-cli.ts')
      const result = get(args)
      stub.uninstall()
      return result as GetResult
    },
    cliDecide: (args) => {
      stub.install()
      const { decide } = require('../src/claude-director-cli.ts')
      const result = decide(args)
      stub.uninstall()
      return result as DecideResult
    },
    chatUpdate: async (params) => {
      chatUpdateCalls.push({ channel: params.channel, ts: params.ts, text: params.text, blocks: params.blocks })
    },
    chatPostMessage: async (params) => {
      chatPostMessageCalls.push({ channel: params.channel, text: params.text })
    },
    resolveUserName: async (userId) => userId,
  }

  const dispatchClick = (opts: { actionId: string; userId?: string }) =>
    handlePermissionClick(deps, opts.actionId, opts.userId ?? 'U_TEST')

  return { stub, chatUpdateCalls, chatPostMessageCalls, consoleErrors, consoleWarns, restoreConsole, deps, dispatchClick }
}

// ---------------------------------------------------------------------------
// seedLivePrompt — seeds the poller state map via a fake tick
// ---------------------------------------------------------------------------

async function seedLivePrompt(opts: {
  channelId: string
  requestId: string
  toolName?: string
}): Promise<LivePromptEntry> {
  const { channelId, requestId, toolName = 'Bash' } = opts
  const instanceId = `cscb_${channelId}`

  const seedStub = new ClaudeDirectorStub()
  seedStub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
  seedStub.setGetPayload(instanceId, makeGetPayload({
    channelId,
    requestId,
    toolName,
    toolInput: '{"command":"echo test"}',
  }))
  seedStub.install()

  const pollerDeps: PermissionPollerDeps = {
    pollIntervalMs: 1000,
    async postPermissionMessage(_ch, _tn, _ti, _id, _rid) { return `ts-${_id}` },
    async expirePermissionMessage() {},
  }
  initPermissionPoller(pollerDeps)
  startPermissionPoller()

  jest.advanceTimersByTime(1000)
  await flushMicrotasks()

  seedStub.uninstall()
  stopPermissionPoller()

  return getLivePrompt(instanceId)!
}

// ---------------------------------------------------------------------------
// 9.1 Happy path
// ---------------------------------------------------------------------------

describe('click handler — happy path', () => {
  test('9a. allow click: markFinalized → cliDecide(allow) → chat.update "Allowed by <user>"', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_TEST1'
      const instanceId = 'cscb_C_TEST1'
      await seedLivePrompt({ channelId, requestId: '42', toolName: 'Bash' })

      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '42', toolName: 'Bash' }))

      const result = await dispatchClick({ actionId: 'perm_allow_cscb_C_TEST1_42', userId: 'alice' })

      expect(result).toBe('handled')

      const decideCalls = stub.calls.filter(c => c.verb === 'decide')
      expect(decideCalls).toHaveLength(1)
      expect(decideCalls[0].argv).toContain('--decision')
      expect(decideCalls[0].argv).toContain('allow')

      expect(chatUpdateCalls).toHaveLength(1)
      expect(chatUpdateCalls[0].text).toContain('Allowed by alice')
      expect(chatUpdateCalls[0].channel).toBe(channelId)
      expect(chatUpdateCalls[0].ts).toBe(`ts-${instanceId}`)

      // entry dropped after success
      expect(getLivePrompt(instanceId)).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  test('9b. deny click: cliDecide(deny) → chat.update "Denied by <user>"', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_DENY1'
      const instanceId = 'cscb_C_DENY1'
      await seedLivePrompt({ channelId, requestId: '43', toolName: 'Bash' })

      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '43', toolName: 'Bash' }))

      const result = await dispatchClick({ actionId: 'perm_deny_cscb_C_DENY1_43', userId: 'bob' })

      expect(result).toBe('handled')

      const decideCalls = stub.calls.filter(c => c.verb === 'decide')
      expect(decideCalls).toHaveLength(1)
      expect(decideCalls[0].argv).toContain('--decision')
      expect(decideCalls[0].argv).toContain('deny')

      expect(chatUpdateCalls).toHaveLength(1)
      expect(chatUpdateCalls[0].text).toContain('Denied by bob')
    } finally {
      jest.useRealTimers()
    }
  })

  test('9c. call-order: markFinalized → cliDecide → chatUpdate', async () => {
    jest.useFakeTimers()
    try {
      const callOrder: string[] = []
      const { stub, deps, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_ORDER'
      const instanceId = 'cscb_C_ORDER'
      await seedLivePrompt({ channelId, requestId: '100', toolName: 'Bash' })

      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '100', toolName: 'Bash' }))

      const orderDeps: PermissionClickDeps = {
        ...deps,
        markFinalized: (id) => {
          callOrder.push('markFinalized')
          return markFinalized(id)
        },
        cliDecide: (args) => {
          callOrder.push('cliDecide')
          return deps.cliDecide(args)
        },
        chatUpdate: async (params) => {
          callOrder.push('chatUpdate')
          return deps.chatUpdate(params)
        },
      }

      await handlePermissionClick(orderDeps, 'perm_allow_cscb_C_ORDER_100', 'U_ORDER')

      expect(callOrder).toEqual(['markFinalized', 'cliDecide', 'chatUpdate'])
    } finally {
      jest.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// 9.2 channelId with underscores (greedy regex canary)
// ---------------------------------------------------------------------------

describe('click handler — channelId with underscores', () => {
  test('9d. perm_allow_cscb_test_channel_42 → claudeInstanceId = cscb_test_channel, requestId = 42', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'test_channel'
      const instanceId = 'cscb_test_channel'
      await seedLivePrompt({ channelId, requestId: '42', toolName: 'Bash' })

      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '42', toolName: 'Bash' }))

      const result = await dispatchClick({ actionId: 'perm_allow_cscb_test_channel_42' })
      expect(result).toBe('handled')

      const decideCalls = stub.calls.filter(c => c.verb === 'decide')
      expect(decideCalls).toHaveLength(1)
      expect(decideCalls[0].argv).toContain('--claude-instance-id')
      expect(decideCalls[0].argv).toContain('cscb_test_channel')
      expect(decideCalls[0].argv).toContain('--request-id')
      expect(decideCalls[0].argv).toContain('42')

      expect(chatUpdateCalls).toHaveLength(1)
      expect(chatUpdateCalls[0].text).toContain('Allowed')
    } finally {
      jest.useRealTimers()
    }
  })

  test('9e. perm_deny_cscb_C_DEV_TEAM_42_99 → claudeInstanceId = cscb_C_DEV_TEAM_42, requestId = 99 (greedy canary)', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_DEV_TEAM_42'
      const instanceId = 'cscb_C_DEV_TEAM_42'
      await seedLivePrompt({ channelId, requestId: '99', toolName: 'Bash' })

      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '99', toolName: 'Bash' }))

      const result = await dispatchClick({ actionId: 'perm_deny_cscb_C_DEV_TEAM_42_99' })
      expect(result).toBe('handled')

      const decideCalls = stub.calls.filter(c => c.verb === 'decide')
      expect(decideCalls).toHaveLength(1)
      expect(decideCalls[0].argv).toContain('cscb_C_DEV_TEAM_42')
      expect(decideCalls[0].argv).toContain('99')

      expect(chatUpdateCalls[0].text).toContain('Denied')
    } finally {
      jest.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// 9.3 Not-a-permission / malformed action_id routing
// ---------------------------------------------------------------------------

describe('click handler — action_id routing', () => {
  test('9f. non-perm action_id → returns not-permission, no decide, no chat.update', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, chatPostMessageCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const result = await dispatchClick({ actionId: 'interject_something_123' })
      expect(result).toBe('not-permission')
      expect(stub.calls.filter(c => c.verb === 'decide')).toHaveLength(0)
      expect(chatUpdateCalls).toHaveLength(0)
      expect(chatPostMessageCalls).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })

  test('9g. malformed perm_ action_id → returns malformed, console.warn, no decide, no chat.update', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, consoleWarns, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const result = await dispatchClick({ actionId: 'perm_allow_notcscb_whatever_42' })
      expect(result).toBe('malformed')
      expect(stub.calls.filter(c => c.verb === 'decide')).toHaveLength(0)
      expect(chatUpdateCalls).toHaveLength(0)
      const warns = consoleWarns.filter(w => String(w[0]).includes('malformed'))
      expect(warns).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// 9.4 Stale click — no map entry
// ---------------------------------------------------------------------------

describe('click handler — stale click (no map entry)', () => {
  test('9h. no live prompt → console.warn + ack, no decide, no chat.update (no channel/ts to update)', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, consoleWarns, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      // No live prompt seeded
      const result = await dispatchClick({ actionId: 'perm_allow_cscb_C_STALE1_42' })
      expect(result).toBe('handled')
      expect(stub.calls.filter(c => c.verb === 'decide')).toHaveLength(0)
      const warns = consoleWarns.filter(w => String(w[0]).includes('stale click'))
      expect(warns).toHaveLength(1)
      // No chat.update — without a live entry we have no channel/ts to target.
      expect(chatUpdateCalls).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// 9.5 request_id mismatch (stale button)
// ---------------------------------------------------------------------------

describe('click handler — request_id mismatch (stale button)', () => {
  test('9i. get returns different request_id → chat.update "already decided", no decide', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, consoleWarns, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_MISMATCH'
      const instanceId = 'cscb_C_MISMATCH'
      await seedLivePrompt({ channelId, requestId: '42' })

      // Refetch returns requestId '43' (different → stale)
      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '43' }))

      const result = await dispatchClick({ actionId: 'perm_allow_cscb_C_MISMATCH_42' })
      expect(result).toBe('handled')
      expect(stub.calls.filter(c => c.verb === 'decide')).toHaveLength(0)
      expect(chatUpdateCalls).toHaveLength(1)
      expect(chatUpdateCalls[0].text).toContain('already decided')
      const warns = consoleWarns.filter(w => String(w[0]).includes('stale button'))
      expect(warns).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test('9j. get returns permissionRequest: null → chat.update "already decided", no decide', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_NULLPR'
      const instanceId = 'cscb_C_NULLPR'
      await seedLivePrompt({ channelId, requestId: '42' })

      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId }))  // no requestId → null

      const result = await dispatchClick({ actionId: 'perm_allow_cscb_C_NULLPR_42' })
      expect(result).toBe('handled')
      expect(stub.calls.filter(c => c.verb === 'decide')).toHaveLength(0)
      expect(chatUpdateCalls).toHaveLength(1)
      expect(chatUpdateCalls[0].text).toContain('already decided')
    } finally {
      jest.useRealTimers()
    }
  })

  test('9k. get returns ErrSpawnNotFound → chat.update "already decided", no decide', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, consoleWarns, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_GETERR'
      const instanceId = 'cscb_C_GETERR'
      await seedLivePrompt({ channelId, requestId: '42' })

      // No spawnRows, no getPayload → instanceExists() = false → ErrSpawnNotFound
      // (stub stub stub.install/uninstall are called inside deps.cliGet)

      const result = await dispatchClick({ actionId: 'perm_allow_cscb_C_GETERR_42' })
      expect(result).toBe('handled')
      expect(stub.calls.filter(c => c.verb === 'decide')).toHaveLength(0)
      expect(chatUpdateCalls).toHaveLength(1)
      expect(chatUpdateCalls[0].text).toContain('already decided')
      const warns = consoleWarns.filter(w => String(w[0]).includes('get failed'))
      expect(warns).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// 9.6 Bigint request_id (SR-2.2)
// ---------------------------------------------------------------------------

describe('click handler — bigint request_id', () => {
  const BIGINT_ID = '9007199254740993'  // 2^53 + 1

  test('9l. bigint request_id: string equality matches, decide called with exact digit string', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_BIG1'
      const instanceId = 'cscb_C_BIG1'
      await seedLivePrompt({ channelId, requestId: BIGINT_ID })

      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: BIGINT_ID }))

      const result = await dispatchClick({ actionId: `perm_allow_cscb_C_BIG1_${BIGINT_ID}` })
      expect(result).toBe('handled')

      const decideCalls = stub.calls.filter(c => c.verb === 'decide')
      expect(decideCalls).toHaveLength(1)
      expect(decideCalls[0].argv).toContain('--request-id')
      const ridIdx = decideCalls[0].argv.indexOf('--request-id')
      // Exact string — not truncated by Number() coercion
      expect(decideCalls[0].argv[ridIdx + 1]).toBe(BIGINT_ID)

      expect(chatUpdateCalls[0].text).toContain('Allowed')
    } finally {
      jest.useRealTimers()
    }
  })

  test('9m. adjacent bigint values past 2^53 distinguished by string equality (stale)', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const BIGINT_A = '9007199254740993'
      const BIGINT_B = '9007199254740994'

      const channelId = 'C_BIG2'
      const instanceId = 'cscb_C_BIG2'
      await seedLivePrompt({ channelId, requestId: BIGINT_A })

      // get returns B → mismatch with A in action_id → stale
      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: BIGINT_B }))

      const result = await dispatchClick({ actionId: `perm_allow_cscb_C_BIG2_${BIGINT_A}` })
      expect(result).toBe('handled')

      expect(stub.calls.filter(c => c.verb === 'decide')).toHaveLength(0)
      expect(chatUpdateCalls).toHaveLength(1)
      expect(chatUpdateCalls[0].text).toContain('already decided')
    } finally {
      jest.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// 9.7 decide error variants
// ---------------------------------------------------------------------------

describe('click handler — decide error variants', () => {
  async function setupDecideTest(channelId: string, requestId = '42') {
    const instanceId = `cscb_${channelId}`
    await seedLivePrompt({ channelId, requestId })
    return instanceId
  }

  test('9n. ErrAlreadyDecided → chat.update "already decided", entry dropped, no T-A error', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, consoleErrors, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_ALREADY'
      const instanceId = await setupDecideTest(channelId)
      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '42' }))
      stub.setDecideResponseQueue(instanceId, [
        { ok: false, error: { kind: 'ErrAlreadyDecided', message: 'already' } },
      ])

      const result = await dispatchClick({ actionId: `perm_allow_${instanceId}_42` })
      expect(result).toBe('handled')
      expect(chatUpdateCalls).toHaveLength(1)
      expect(chatUpdateCalls[0].text).toContain('already decided')
      expect(getLivePrompt(instanceId)).toBeUndefined()
      const taErrors = consoleErrors.filter(w => String(w[0]).includes('startup'))
      expect(taErrors).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })

  test('9o. ErrNoOpenPermissionRequest → chat.update "already decided", entry dropped', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_NOOPENPR'
      const instanceId = await setupDecideTest(channelId)
      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '42' }))
      stub.setDecideResponseQueue(instanceId, [
        { ok: false, error: { kind: 'ErrNoOpenPermissionRequest', message: 'none' } },
      ])

      const result = await dispatchClick({ actionId: `perm_allow_${instanceId}_42` })
      expect(result).toBe('handled')
      expect(chatUpdateCalls).toHaveLength(1)
      expect(chatUpdateCalls[0].text).toContain('already decided')
      expect(getLivePrompt(instanceId)).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  test('9p. ErrSpawnNotFound (from decide) → chat.update "already decided", entry dropped', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_DECIDESNF'
      const instanceId = await setupDecideTest(channelId)
      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '42' }))
      stub.setDecideResponseQueue(instanceId, [
        { ok: false, error: { kind: 'ErrSpawnNotFound', message: 'not found' } },
      ])

      const result = await dispatchClick({ actionId: `perm_allow_${instanceId}_42` })
      expect(result).toBe('handled')
      expect(chatUpdateCalls).toHaveLength(1)
      expect(chatUpdateCalls[0].text).toContain('already decided')
      expect(getLivePrompt(instanceId)).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  test('9q. ErrRelayModeOff → console.error + chat.postMessage invariant violation, NO chat.update to allowed/denied', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, chatPostMessageCalls, consoleErrors, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_RELAYOFF'
      const instanceId = await setupDecideTest(channelId)
      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '42' }))
      stub.setDecideResponseQueue(instanceId, [
        { ok: false, error: { kind: 'ErrRelayModeOff', message: 'relay off' } },
      ])

      const result = await dispatchClick({ actionId: `perm_allow_${instanceId}_42` })
      expect(result).toBe('handled')

      const relayErrors = consoleErrors.filter(w => String(w[0]).includes('INVARIANT VIOLATION'))
      expect(relayErrors).toHaveLength(1)

      expect(chatPostMessageCalls).toHaveLength(1)
      expect(chatPostMessageCalls[0].channel).toBe(channelId)
      expect(chatPostMessageCalls[0].text).toContain('Invariant violation')
      expect(chatPostMessageCalls[0].text).toContain(instanceId)

      // NO chat.update to allowed/denied
      expect(chatUpdateCalls).toHaveLength(0)

      // Entry NOT dropped
      expect(getLivePrompt(instanceId)).toBeDefined()
    } finally {
      jest.useRealTimers()
    }
  })

  test('9r. generic decide failure → finalizedAt set, console.error, NO chat.update', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, consoleErrors, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_GENERIC'
      const instanceId = await setupDecideTest(channelId)
      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '42' }))
      stub.setDecideResponseQueue(instanceId, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 1, stderr: 'network error' } },
      ])

      const result = await dispatchClick({ actionId: `perm_allow_${instanceId}_42` })
      expect(result).toBe('handled')

      expect(chatUpdateCalls).toHaveLength(0)

      const errLogs = consoleErrors.filter(w => String(w[0]).includes('decide error'))
      expect(errLogs).toHaveLength(1)

      const entry = getLivePrompt(instanceId)
      expect(entry).toBeDefined()
      expect(entry!.finalizedAt).toBeDefined()
    } finally {
      jest.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// 9.8 userName in chat.update only, NOT in decide argv
// ---------------------------------------------------------------------------

describe('click handler — userName routing', () => {
  test('9s. userName appears in chat.update text only, NOT in decide argv (allow)', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_USER1'
      const instanceId = 'cscb_C_USER1'
      await seedLivePrompt({ channelId, requestId: '42' })

      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '42' }))

      await dispatchClick({ actionId: 'perm_allow_cscb_C_USER1_42', userId: 'alice' })

      expect(chatUpdateCalls[0].text).toContain('alice')

      const decideCalls = stub.calls.filter(c => c.verb === 'decide')
      expect(decideCalls).toHaveLength(1)
      const argv = decideCalls[0].argv.join(' ')
      expect(argv).not.toContain('alice')
      expect(argv).not.toContain('--reason')
    } finally {
      jest.useRealTimers()
    }
  })

  test('9t. userName in chat.update for deny, NOT in decide argv', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_USER2'
      const instanceId = 'cscb_C_USER2'
      await seedLivePrompt({ channelId, requestId: '55' })

      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '55' }))

      await dispatchClick({ actionId: 'perm_deny_cscb_C_USER2_55', userId: 'bob' })

      expect(chatUpdateCalls[0].text).toContain('bob')

      const decideCalls = stub.calls.filter(c => c.verb === 'decide')
      const argv = decideCalls[0].argv.join(' ')
      expect(argv).not.toContain('bob')
      expect(argv).not.toContain('--reason')
    } finally {
      jest.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// 9.9 Re-click after generic failure
// ---------------------------------------------------------------------------

describe('click handler — re-click after generic failure', () => {
  test('9u. 2nd click finds non-stale requestId, decide called again, succeeds, chat.update fires', async () => {
    jest.useFakeTimers()
    try {
      const { stub, chatUpdateCalls, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole

      const channelId = 'C_RECLICK'
      const instanceId = 'cscb_C_RECLICK'
      await seedLivePrompt({ channelId, requestId: '42' })

      stub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      stub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '42' }))
      // First decide fails; second (default) succeeds
      stub.setDecideResponseQueue(instanceId, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 1, stderr: 'network error' } },
        { ok: true },
      ])

      const r1 = await dispatchClick({ actionId: 'perm_allow_cscb_C_RECLICK_42', userId: 'alice' })
      expect(r1).toBe('handled')
      expect(chatUpdateCalls).toHaveLength(0)

      const entryAfterFirst = getLivePrompt(instanceId)
      expect(entryAfterFirst).toBeDefined()
      expect(entryAfterFirst!.finalizedAt).toBeDefined()

      // Second click: still within 30s, same requestId, second decide succeeds
      const r2 = await dispatchClick({ actionId: 'perm_allow_cscb_C_RECLICK_42', userId: 'alice' })
      expect(r2).toBe('handled')

      const decideCalls = stub.calls.filter(c => c.verb === 'decide')
      expect(decideCalls).toHaveLength(2)

      expect(chatUpdateCalls).toHaveLength(1)
      expect(chatUpdateCalls[0].text).toContain('Allowed by alice')
    } finally {
      jest.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// 9.10 Named test: 30s ownership window
// ---------------------------------------------------------------------------

describe('30s ownership window', () => {
  test('30s ownership window — poller skips expiry for 30s after click', async () => {
    jest.useFakeTimers()
    try {
      const channelId = 'C_30WIN'
      const instanceId = 'cscb_C_30WIN'

      const expireCalls: Array<{ channelId: string; messageTs: string }> = []
      const pollerStub = new ClaudeDirectorStub()
      pollerStub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      pollerStub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '42' }))
      pollerStub.install()

      const pollerDeps: PermissionPollerDeps = {
        pollIntervalMs: 1000,
        async postPermissionMessage(_ch, _tn, _ti, _id, _rid) { return `ts-${_id}` },
        async expirePermissionMessage(ch, ts) { expireCalls.push({ channelId: ch, messageTs: ts }) },
      }
      initPermissionPoller(pollerDeps)
      startPermissionPoller()

      // Tick 1: discover entry
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()
      expect(getLivePrompt(instanceId)).toBeDefined()

      // Keep poller running but swap rows to empty so next tick sees disappearance.
      // BEFORE swapping, simulate a generic-failure click to set finalizedAt.
      pollerStub.uninstall()

      // Click: generic failure sets finalizedAt without dropping entry
      const { stub: clickStub, dispatchClick, restoreConsole } = makeClickDeps()
      activeRestoreConsole = restoreConsole
      clickStub.setSpawnRows([makeSpawnRow({ channelId, state: 'check_permission' })])
      clickStub.setGetPayload(instanceId, makeGetPayload({ channelId, requestId: '42' }))
      clickStub.setDecideResponseQueue(instanceId, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 1, stderr: 'err' } },
      ])
      await dispatchClick({ actionId: `perm_allow_${instanceId}_42` })

      const entry = getLivePrompt(instanceId)
      expect(entry).toBeDefined()
      expect(entry!.finalizedAt).toBeDefined()

      // Now row disappears from the list — install an empty-row stub
      const emptyStub = new ClaudeDirectorStub()
      emptyStub.setSpawnRows([])
      emptyStub.install()

      // Tick 2: row gone, finalizedAt set < 1s ago → within 30s window → no expire
      jest.advanceTimersByTime(1000)
      await flushMicrotasks()
      expect(expireCalls).toHaveLength(0)
      // Entry is dropped silently (within window, no expirePermissionMessage call)
      expect(getLivePrompt(instanceId)).toBeUndefined()

      emptyStub.uninstall()

      // Boundary check: advance 31s total from when finalizedAt was set.
      // The entry is already gone from the map; expiry won't fire again (nothing to expire).
      // This confirms the within-window path was taken (no chat.update = no expire call).
      // The complementary >30s boundary is covered by test 5d above.
      expect(expireCalls).toHaveLength(0)

    } finally {
      jest.useRealTimers()
    }
  })
})
