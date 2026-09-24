/**
 * test-helpers/permission-relay-harness.ts — Shared plumbing for the
 * permission-relay suites (poller, click handler, trail file, capstone).
 *
 * - `startManualPoller(deps)` starts the poller on a manual interval: nothing
 *   runs until the test fires a tick (`tick(settleMs?)` or `fire()`). Every
 *   persona is up unless the test passes its own `isPersonaUp`.
 * - `makePersonaClients(stubFor)` is the injected per-persona client lookup:
 *   each key gets its own `makeStubSlack` stub's Web client, and a test can
 *   mark a key's client unavailable (as production does before validation, in
 *   dry run or for an unknown key). Every key asked for is recorded.
 * - `makeTrailCapture()` captures the trail events the code under test emits.
 * - `posts`, `updates` and `slackCalls` read a stub's captured calls.
 *
 * Slack failures are scripted on the stub itself (`script.post`,
 * `script.update`), never through a hand-built client or error.
 *
 * No module-scope state, no timers of its own, no file system.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'
import { startPermissionPoller, type PollerDeps } from '../../src/permission-poller.ts'
import type { TrailEventBase } from '../../src/permission-trail.ts'
import type { StubSlack } from './slack-stub.ts'

// ---------------------------------------------------------------------------
// Manual interval
// ---------------------------------------------------------------------------

/** One interval the code under test registered. */
export interface ManualInterval {
  cb: () => void
  ms: number
  cleared: boolean
}

export interface ManualIntervalControl {
  /** Pass as the poller's `setInterval`: records the callback, schedules nothing. */
  setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
  /** Pass as the poller's `clearInterval`: marks the interval cleared. */
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
  /** Every interval registered, in order. */
  pending: ManualInterval[]
  /** Run the first registered callback once, without waiting. */
  fire(): void
  /** Run the first registered callback once and let the tick settle (default 10 ms). */
  tick(settleMs?: number): Promise<void>
}

export function makeManualInterval(): ManualIntervalControl {
  const pending: ManualInterval[] = []
  const fire = (): void => {
    const first = pending[0]
    if (first === undefined) throw new Error('permission-relay-harness: no interval registered')
    first.cb()
  }
  return {
    setInterval: (cb, ms) => {
      const entry: ManualInterval = { cb, ms, cleared: false }
      pending.push(entry)
      return entry as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: (handle) => {
      ;(handle as unknown as ManualInterval).cleared = true
    },
    pending,
    fire,
    async tick(settleMs = 10) {
      fire()
      await new Promise((r) => setTimeout(r, settleMs))
    },
  }
}

/**
 * Start the poller on a manual interval (1000 ms unless `deps.intervalMs`
 * says otherwise). Every persona is up unless `deps.isPersonaUp` says
 * otherwise. Returns the interval control.
 */
export function startManualPoller(
  deps: Omit<PollerDeps, 'intervalMs' | 'setInterval' | 'clearInterval' | 'isPersonaUp'> & Partial<PollerDeps>,
): ManualIntervalControl {
  const ivl = makeManualInterval()
  startPermissionPoller({
    intervalMs: 1000,
    ...deps,
    isPersonaUp: deps.isPersonaUp ?? (() => true),
    setInterval: ivl.setInterval,
    clearInterval: ivl.clearInterval,
  })
  return ivl
}

// ---------------------------------------------------------------------------
// Per-persona client lookup
// ---------------------------------------------------------------------------

/** The Slack surface the poller and the click handler use on a persona's client: chat and DM opens. */
export type RelaySlackClient = Pick<WebClient, 'chat' | 'conversations'>

export interface PersonaClients {
  /** The injected lookup: the key's stub Web client, or undefined when unknown or marked unavailable. */
  clientFor: (key: string) => RelaySlackClient | undefined
  /** Mark a key's client unavailable (default) or available again. */
  setUnavailable(key: string, unavailable?: boolean): void
  /** Every key `clientFor` was asked for, in order. */
  readonly calls: string[]
}

/** A client lookup over `stubFor` (read on every call, so a test may swap stubs). */
export function makePersonaClients(stubFor: (key: string) => StubSlack | undefined): PersonaClients {
  const unavailable = new Set<string>()
  const calls: string[] = []
  return {
    clientFor: (key) => {
      calls.push(key)
      if (unavailable.has(key)) return undefined
      return stubFor(key)?.web as unknown as RelaySlackClient | undefined
    },
    setUnavailable(key, on = true) {
      if (on) unavailable.add(key)
      else unavailable.delete(key)
    },
    calls,
  }
}

// ---------------------------------------------------------------------------
// Trail capture
// ---------------------------------------------------------------------------

/** A trail event as the code under test hands it to `emitTrail`. */
export type CapturedTrailEvent = Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown }

export interface TrailCapture {
  /** Pass as `emitTrail`. */
  emit: (partial: CapturedTrailEvent) => void
  /** Every event emitted, in order. */
  events: CapturedTrailEvent[]
}

export function makeTrailCapture(): TrailCapture {
  const events: CapturedTrailEvent[] = []
  return { events, emit: (partial) => { events.push(partial) } }
}

// ---------------------------------------------------------------------------
// Stub call accessors
// ---------------------------------------------------------------------------

/** The fields of a captured `chat.postMessage` or `chat.update` call. */
export interface ChatCall {
  channel: string
  ts?: string
  text?: string
  blocks?: unknown
}

/** The `chat.postMessage` calls captured on a stub. */
export const posts = (stub: StubSlack): ChatCall[] => stub.calls.postMessage as unknown as ChatCall[]

/** The `chat.update` calls captured on a stub. */
export const updates = (stub: StubSlack): ChatCall[] => stub.calls.update as unknown as ChatCall[]

/** Every Web API call captured on the given stubs, across all methods. */
export const slackCalls = (...stubs: StubSlack[]): number =>
  stubs.reduce((n, stub) => n + Object.values(stub.calls).reduce((m, list) => m + (list as unknown[]).length, 0), 0)
