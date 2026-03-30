/**
 * test-helpers/tmux-stub.ts — Shared TmuxClient stub factory for tests
 *
 * SPDX-License-Identifier: MIT
 */

import { type TmuxClient } from '../../src/tmux.ts'

export type Call = { method: string; args: unknown[] }

export type TmuxStubOpts = {
  checkAvailabilityResult?: string | Error
  hasSessionResult?: boolean | Error
  getPanePidResult?: string | Error
  newSessionResult?: Error
  sendKeysResult?: Error
  capturePaneResult?: string | Error
  /** Sequential capturePane responses. Each call returns the next entry; last entry repeats. */
  capturePaneResults?: Array<string | Error>
  killSessionResult?: Error
}

/**
 * Returns a TmuxClient stub with configurable responses and a `calls` array
 * that records every invocation for assertion in tests.
 */
export function makeTmuxStub(opts: TmuxStubOpts = {}): TmuxClient & { calls: Call[] } {
  const calls: Call[] = []
  let capturePaneCallCount = 0

  return {
    calls,

    async checkAvailability() {
      calls.push({ method: 'checkAvailability', args: [] })
      const r = opts.checkAvailabilityResult ?? 'tmux 3.3a'
      if (r instanceof Error) throw r
      return r
    },

    async hasSession(name) {
      calls.push({ method: 'hasSession', args: [name] })
      const r = opts.hasSessionResult ?? true
      if (r instanceof Error) throw r
      return r
    },

    async getPanePid(session) {
      calls.push({ method: 'getPanePid', args: [session] })
      const r = opts.getPanePidResult ?? '12345'
      if (r instanceof Error) throw r
      return r
    },

    async newSession(name, cwd) {
      calls.push({ method: 'newSession', args: [name, cwd] })
      if (opts.newSessionResult instanceof Error) throw opts.newSessionResult
    },

    async sendKeys(session, keys) {
      calls.push({ method: 'sendKeys', args: [session, keys] })
      if (opts.sendKeysResult instanceof Error) throw opts.sendKeysResult
    },

    async capturePane(session) {
      calls.push({ method: 'capturePane', args: [session] })
      let r: string | Error
      if (opts.capturePaneResults && opts.capturePaneResults.length > 0) {
        const idx = Math.min(capturePaneCallCount, opts.capturePaneResults.length - 1)
        r = opts.capturePaneResults[idx]
      } else {
        r = opts.capturePaneResult ?? 'pane output'
      }
      capturePaneCallCount++
      if (r instanceof Error) throw r
      return r
    },

    async killSession(session) {
      calls.push({ method: 'killSession', args: [session] })
      if (opts.killSessionResult instanceof Error) throw opts.killSessionResult
    },
  }
}
