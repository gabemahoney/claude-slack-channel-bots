/**
 * tmux-probe-stub.ts — Test helper that mints fake TmuxProbeFn instances for
 * unit tests (SR-29.5, Epic t1.a3g.b7).
 *
 * Exports two factories:
 *
 *   makeStubTmuxProbe(classification, signal?)
 *     Returns a { probe, killSession, probeCalls, killSessionCalls } bundle
 *     where probe always resolves to the given classification (and signal, if
 *     provided; otherwise a canonical signal is inferred). kill-session
 *     invocations are recorded but otherwise no-op.
 *
 *   makeStubTmuxProbeQueue(responses)
 *     Same bundle shape, but probe works FIFO: shifts the next response off
 *     the front on each call; the last entry sticks once the queue is
 *     exhausted. Mirrors the readPaneResults pattern in agent-director-stub.ts.
 *
 * Call recording:
 *   probeCalls      — session names passed to probe(), in order
 *   killSessionCalls — session names passed to killSession(), in order
 *
 * No child_process / real tmux involved anywhere in this file.
 *
 * SPDX-License-Identifier: MIT
 */

import type {
  TmuxProbeClassification,
  TmuxProbeResult,
  TmuxProbeFn,
  TmuxProbeSignal,
} from '../../src/tmux-probe.ts'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The surface returned by both stub factories. */
export interface StubTmuxProbeBundle {
  /** Probe function — resolves to the configured TmuxProbeResult. */
  probe: TmuxProbeFn
  /** kill-session operation — records the invocation and resolves. */
  killSession: (sessionName: string) => Promise<void>
  /** Session names passed to probe(), in order. */
  probeCalls: string[]
  /** Session names passed to killSession(), in order. */
  killSessionCalls: string[]
}

// ---------------------------------------------------------------------------
// Canonical default signals per classification
// ---------------------------------------------------------------------------

/**
 * Infer a representative signal for a given classification when the caller
 * does not specify one explicitly.
 */
function defaultSignalFor(classification: TmuxProbeClassification): TmuxProbeSignal {
  switch (classification) {
    case 'definitely-alive':
      return 'exit-0'
    case 'definitely-dead':
      return 'exit-1-session-not-found'
    case 'transient-inconclusive':
      return 'exit-1-unparseable'
  }
}

// ---------------------------------------------------------------------------
// makeStubTmuxProbe — single fixed response
// ---------------------------------------------------------------------------

/**
 * Build a stub { probe, killSession } bundle that always resolves to the
 * given classification (and optional signal).
 *
 * Usage:
 *   const { probe, killSession, probeCalls, killSessionCalls } =
 *     makeStubTmuxProbe('definitely-dead')
 *
 *   await probe('my-session')  // → { classification: 'definitely-dead', signal: 'exit-1-session-not-found' }
 *   probeCalls         // → ['my-session']
 *
 *   await killSession('my-session')
 *   killSessionCalls   // → ['my-session']
 */
export function makeStubTmuxProbe(
  classification: TmuxProbeClassification,
  signal?: TmuxProbeSignal,
): StubTmuxProbeBundle {
  const result: TmuxProbeResult = {
    classification,
    signal: signal ?? defaultSignalFor(classification),
  }

  const probeCalls: string[] = []
  const killSessionCalls: string[] = []

  const probe: TmuxProbeFn = async (sessionName: string): Promise<TmuxProbeResult> => {
    probeCalls.push(sessionName)
    return result
  }

  const killSession = async (sessionName: string): Promise<void> => {
    killSessionCalls.push(sessionName)
  }

  return { probe, killSession, probeCalls, killSessionCalls }
}

// ---------------------------------------------------------------------------
// makeStubTmuxProbeQueue — FIFO sequence, last entry sticks
// ---------------------------------------------------------------------------

/**
 * Build a stub { probe, killSession } bundle driven by a FIFO queue of
 * TmuxProbeResult values. The last entry sticks once the queue is exhausted
 * (same semantics as readPaneResults in agent-director-stub.ts).
 *
 * Usage:
 *   const { probe, probeCalls } = makeStubTmuxProbeQueue([
 *     { classification: 'transient-inconclusive', signal: 'timeout' },
 *     { classification: 'definitely-alive',       signal: 'exit-0' },
 *   ])
 *
 *   await probe('s1')  // → transient-inconclusive (shifts first entry)
 *   await probe('s2')  // → definitely-alive       (shifts second entry)
 *   await probe('s3')  // → definitely-alive       (last entry sticks)
 *   probeCalls         // → ['s1', 's2', 's3']
 */
export function makeStubTmuxProbeQueue(
  responses: TmuxProbeResult[],
): StubTmuxProbeBundle {
  // Work on a shallow copy so callers can't mutate the queue after construction.
  const queue: TmuxProbeResult[] = [...responses]

  const probeCalls: string[] = []
  const killSessionCalls: string[] = []

  const probe: TmuxProbeFn = async (sessionName: string): Promise<TmuxProbeResult> => {
    probeCalls.push(sessionName)
    if (queue.length === 0) {
      throw new Error('tmux-probe-stub: probe called but no responses configured')
    }
    // FIFO; last entry sticks (do not pop the tail).
    return queue.length === 1 ? queue[0] : queue.shift()!
  }

  const killSession = async (sessionName: string): Promise<void> => {
    killSessionCalls.push(sessionName)
  }

  return { probe, killSession, probeCalls, killSessionCalls }
}
