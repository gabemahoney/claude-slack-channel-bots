/**
 * approve-trust-folder-dialog.test.ts — Unit tests for approveTrustFolderDialog
 *
 * Mirrors the `approveDevChannelsDialog (b.yy6)` blocks in session-manager.test.ts:
 *   - Same `_setTrustDialogPollIntervalMs` / `_setTrustDialogPollTimeoutMs` seam driving
 *   - Same mocked `getClient()` via setClientForTests / makeStubClient
 *   - Same `captureStartupErrors` / `SLACK_STATE_DIR` pattern for recordStartupError assertions
 *
 * No `mock.module('../src/startup-errors.ts', …)` — use SLACK_STATE_DIR log-file reads.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approveTrustFolderDialog,
  TRUST_DIALOG_NEEDLE,
  _setTrustDialogPollIntervalMs,
  _setTrustDialogPollTimeoutMs,
  _resetTrustDialogPollIntervalMs,
  _resetTrustDialogPollTimeoutMs,
} from '../src/session-manager.ts'
import { resetClientForTests, setClientForTests, getClient } from '../src/agent-director-client.ts'
import { initOutageState, _resetOutageState } from '../src/outage-state.ts'
import {
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
  _setTrustDialogPollIntervalMs(1)
  _setTrustDialogPollTimeoutMs(50)
  initOutageState({ postToChannel: () => {}, getClient })
})

afterEach(() => {
  resetClientForTests()
  _resetOutageState()
  _resetTrustDialogPollIntervalMs()
  _resetTrustDialogPollTimeoutMs()
  process.env = savedEnv as NodeJS.ProcessEnv
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true }) } catch { /* ignore */ }
  }
  tempDirs = []
})

// ---------------------------------------------------------------------------
// approveTrustFolderDialog
// ---------------------------------------------------------------------------

describe('approveTrustFolderDialog', () => {
  // -------------------------------------------------------------------------
  // Case 1: Needle present → accept sequence sent and needle clears
  // -------------------------------------------------------------------------

  test('needle present → Enter sent, needle clears, no recordStartupError', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      readPaneResults: [
        { pane: TRUST_PANE },
        { pane: CLEAR_PANE },
        { pane: CLEAR_PANE },
      ],
    })
    const readLog = captureStartupErrors()

    await approveTrustFolderDialog('C', undefined, true)

    // sendKeys called once with Enter
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toBe('')
    expect(sendKeysCalls[0].allow_pending).toBe(true)
    expect(sendKeysCalls[0].claude_instance_id).toBe('cscb_C')

    // readPane called at least 3 times (1 detection + 2+ confirm-gone)
    expect(readPaneCalls.length).toBeGreaterThanOrEqual(3)
    for (const r of readPaneCalls) {
      expect(r.claude_instance_id).toBe('cscb_C')
      expect(r.n_lines).toBe(40)
      expect(r.allow_pending).toBe(true)
    }

    // No startup error
    expect(readLog()).toBe('')
  })

  // -------------------------------------------------------------------------
  // Case 2: Needle never present within timeout → silent return, no error
  // -------------------------------------------------------------------------

  test('needle never present within timeout → silent return, no sendKeys, no recordStartupError', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      readPaneResults: [{ pane: 'unrelated pane text' }],
    })
    const readLog = captureStartupErrors()

    await approveTrustFolderDialog('C', undefined, true)

    // Silent return — no sendKeys, no error
    expect(sendKeysCalls).toHaveLength(0)
    expect(readLog()).toBe('')
  })

  // -------------------------------------------------------------------------
  // Case 3: Needle persists after Enter → trust-folder-approve-still-visible
  // -------------------------------------------------------------------------

  test('needle persists after Enter → trust-folder-approve-still-visible recorded', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      // Sticky needle: always returns the trust pane so confirm-gone loop never clears
      readPaneResults: [{ pane: TRUST_PANE }],
    })
    const readLog = captureStartupErrors()

    await approveTrustFolderDialog('C', undefined, true)

    // Enter was sent once
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toBe('')

    // Startup error recorded with the correct tag
    const log = readLog()
    expect(log).toContain('[trust-folder-approve-still-visible]')
    expect(log).toContain('channel=C')
  })

  // -------------------------------------------------------------------------
  // Additional: isStartup=false → no recordStartupError even on still-visible
  // -------------------------------------------------------------------------
  // Mirrors the dev-channels approver: recordStartupError is only called when
  // isStartup=true. Verify the guard holds for the trust approver too.

  test('still-visible with isStartup=false → no recordStartupError', async () => {
    installStub({
      readPaneResults: [{ pane: TRUST_PANE }],
    })
    const readLog = captureStartupErrors()

    await approveTrustFolderDialog('C', undefined, false)

    expect(readLog()).toBe('')
  })

  // -------------------------------------------------------------------------
  // Additional: needle constant matches the pane fixture
  // -------------------------------------------------------------------------

  test('TRUST_DIALOG_NEEDLE matches the verified Claude Code 2.1.120 label', () => {
    expect(TRUST_DIALOG_NEEDLE).toBe('Yes, I trust this folder')
    expect(TRUST_PANE).toContain(TRUST_DIALOG_NEEDLE)
  })
})
