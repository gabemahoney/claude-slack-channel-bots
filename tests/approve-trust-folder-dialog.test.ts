/**
 * approve-trust-folder-dialog.test.ts — Direct unit tests for
 * approvePreSessionDialogs exercising the TRUST needle specifically (b.4ie).
 *
 * The session-manager.test.ts block covers the dev-channels needle via
 * spawnForRoute. This file calls approvePreSessionDialogs directly to give
 * focused coverage of the trust-folder path.
 *
 * Same mocked getClient() via setClientForTests / makeStubClient.
 * Same captureStartupErrors / SLACK_STATE_DIR pattern for recordStartupError assertions.
 *
 * No mock.module() — use SLACK_STATE_DIR log-file reads.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approvePreSessionDialogs,
  TRUST_DIALOG_NEEDLE,
  _setDialogReadyTimeoutMs,
  _resetDialogReadyTimeoutMs,
  _setDialogPollIntervalMs,
  _resetDialogPollIntervalMs,
} from '../src/session-manager.ts'
import { resetClientForTests, setClientForTests, getClient } from '../src/agent-director-client.ts'
import { initOutageState, _resetOutageState } from '../src/outage-state.ts'
import {
  cannedOk,
  makeStubClient,
} from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRUST_PANE = `
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Do you trust the files in this folder?                                  │
  │                                                                          │
  │  > Yes, I trust this folder                                               │
  │    No, exit                                                               │
  └──────────────────────────────────────────────────────────────────────────┘
`.trim()

const CLEAR_PANE = 'Listening for channel messages from: server:slack-channel-router'

function installStub(opts?: Parameters<typeof makeStubClient>[0]) {
  const stub = makeStubClient(opts)
  setClientForTests(stub as unknown as Parameters<typeof setClientForTests>[0])
  return stub
}

let tempDirs: string[] = []

/**
 * Redirect startup-errors.log into a fresh temp dir and return a reader.
 * The temp dir is tracked in `tempDirs` and cleaned up in `afterEach`.
 * Env restoration is handled separately via savedEnv.
 */
function captureStartupErrors(): () => string {
  const dir = mkdtempSync(join(tmpdir(), 'cscb-trust-'))
  tempDirs.push(dir)
  process.env['SLACK_STATE_DIR'] = dir
  const logPath = join(dir, 'startup-errors.log')
  return () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '')
}

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  _setDialogPollIntervalMs(1)
  _setDialogReadyTimeoutMs(50)
  initOutageState({ postToChannel: () => {}, getClient })
})

afterEach(() => {
  resetClientForTests()
  _resetOutageState()
  _resetDialogPollIntervalMs()
  _resetDialogReadyTimeoutMs()
  process.env = savedEnv as NodeJS.ProcessEnv
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true }) } catch { /* ignore */ }
  }
  tempDirs = []
})

// ---------------------------------------------------------------------------
// approvePreSessionDialogs — trust needle focused tests
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs (trust needle, b.4ie)', () => {
  // -------------------------------------------------------------------------
  // Case 1: Trust needle present while pending → Enter sent, then session live
  // -------------------------------------------------------------------------

  test('trust needle present while pending → Enter sent (allow_pending true, id cscb_C); statusQueue reaches waiting → returns; no startup error', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      // pending first → Enter gets pressed; then waiting → function returns
      statusQueue: [
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'waiting' }),
      ],
      readPaneResults: [
        { pane: TRUST_PANE },
        { pane: CLEAR_PANE },
      ],
    })
    const readLog = captureStartupErrors()

    await approvePreSessionDialogs('C', undefined, true)

    // Enter sent once with allow_pending:true and correct instance id
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toBe('')
    expect(sendKeysCalls[0].allow_pending).toBe(true)
    expect(sendKeysCalls[0].claude_instance_id).toBe('cscb_C')

    // readPane called with n_lines 40, allow_pending true, correct instance id
    expect(readPaneCalls.length).toBeGreaterThanOrEqual(1)
    for (const r of readPaneCalls) {
      expect(r.claude_instance_id).toBe('cscb_C')
      expect(r.n_lines).toBe(40)
      expect(r.allow_pending).toBe(true)
    }

    // No startup error recorded
    expect(readLog()).toBe('')
  })

  // -------------------------------------------------------------------------
  // Case 2: Already-live (statusQueue [waiting]) → no readPane, no sendKeys
  // -------------------------------------------------------------------------

  test('already-live (statusQueue [waiting]) → no readPane, no sendKeys, no startup error', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      statusQueue: [cannedOk({ state: 'waiting' })],
    })
    const readLog = captureStartupErrors()

    await approvePreSessionDialogs('C', undefined, true)

    expect(sendKeysCalls).toHaveLength(0)
    expect(readPaneCalls).toHaveLength(0)
    expect(readLog()).toBe('')
  })

  // -------------------------------------------------------------------------
  // Case 3: Cap hit with sticky pending + no needle → not-ready startup error
  // -------------------------------------------------------------------------

  test('cap hit: sticky pending + no trust needle → dev-channels-approve-not-ready recorded', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      // sticky: status always returns pending, never reaches live
      statusResult: { state: 'pending' },
      readPaneResults: [{ pane: 'unrelated pane text' }],
    })
    const readLog = captureStartupErrors()

    await approvePreSessionDialogs('C', undefined, true)

    // Never sent Enter (no needle)
    expect(sendKeysCalls).toHaveLength(0)
    const log = readLog()
    expect(log).toContain('[dev-channels-approve-not-ready]')
    expect(log).toContain('channel=C')
  })

  // -------------------------------------------------------------------------
  // Case 4: Dead state — statusQueue [pending, ended] + no needle → spawn-died
  // -------------------------------------------------------------------------

  test('dead state: statusQueue [pending, ended] + non-needle pane → dev-channels-approve-spawn-died recorded', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      statusQueue: [
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'ended' }),
      ],
      readPaneResults: [{ pane: 'no trust needle here' }],
    })
    const readLog = captureStartupErrors()

    await approvePreSessionDialogs('C', undefined, true)

    expect(sendKeysCalls).toHaveLength(0)
    const log = readLog()
    expect(log).toContain('[dev-channels-approve-spawn-died]')
  })

  // -------------------------------------------------------------------------
  // Case 5: Self-heal — sticky TRUST_PANE while pending → Enter pressed ≥2×
  // -------------------------------------------------------------------------

  test('self-heal: statusQueue [pending, pending, waiting] + sticky TRUST_PANE → Enter pressed ≥2 times', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      statusQueue: [
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'pending' }),
        cannedOk({ state: 'waiting' }),
      ],
      // sticky: every readPane returns the trust pane
      readPaneResults: [{ pane: TRUST_PANE }],
    })

    await approvePreSessionDialogs('C', undefined, true)

    expect(sendKeysCalls.length).toBeGreaterThanOrEqual(2)
  })

  // -------------------------------------------------------------------------
  // Additional: TRUST_DIALOG_NEEDLE constant matches the pane fixture
  // -------------------------------------------------------------------------

  test('TRUST_DIALOG_NEEDLE matches the verified Claude Code 2.1.120 label', () => {
    expect(TRUST_DIALOG_NEEDLE).toBe('Yes, I trust this folder')
    expect(TRUST_PANE).toContain(TRUST_DIALOG_NEEDLE)
  })
})
