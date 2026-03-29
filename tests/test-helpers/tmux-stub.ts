/**
 * test-helpers/tmux-stub.ts — Shared TmuxClient stub factory for tests
 *
 * SPDX-License-Identifier: MIT
 */

import { type TmuxClient } from '../tmux.ts'

export type Call = { method: string; args: unknown[] }

export type TmuxStubOpts = {
  checkAvailabilityResult?: string | Error
  hasSessionResult?: boolean | Error
  getPanePidResult?: string | Error
  newSessionResult?: Error
  sendKeysResult?: Error
  capturePaneResult?: string | Error
  killSessionResult?: Error
}

/**
 * Returns a TmuxClient stub with configurable responses and a `calls` array
 * that records every invocation for assertion in tests.
 */
export function makeTmuxStub(opts: TmuxStubOpts = {}): TmuxClient & { calls: Call[] } {
  const calls: Call[] = []

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
      const r = opts.capturePaneResult ?? 'pane output'
      if (r instanceof Error) throw r
      return r
    },

    async killSession(session) {
      calls.push({ method: 'killSession', args: [session] })
      if (opts.killSessionResult instanceof Error) throw opts.killSessionResult
    },
  }
}
