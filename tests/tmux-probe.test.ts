/**
 * tmux-probe.test.ts — Unit tests for classifyAdError (SR-20.2 AD-verb rows)
 * and the real has-session classifier via buildTmuxProbe.
 *
 * Scope:
 *   - classifyAdError: one test per mapping row in the SR-20.2 table
 *   - table-completeness: iterates all documented signals; asserts defined result
 *   - no-mutation: classifyAdError never touches exec/kill-session
 *   - buildTmuxProbe (real classifier): driven by injected exec returning each
 *     TmuxExecResult shape; asserts classification + signal
 *   - killSession: asserts it sends ['kill-session', '-t', name] via exec
 *
 * Does NOT duplicate b7's stub self-tests (tmux-probe-fixture.test.ts).
 * Does NOT use spawnForRoute or any steering assertions.
 * No mock.module.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import {
  classifyAdError,
  buildTmuxProbe,
} from '../src/tmux-probe.ts'
import type { AdErrorClassification, TmuxExecResult } from '../src/tmux-probe.ts'
import {
  ErrCwdNotFound,
  ErrCwdNotADirectory,
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
} from '../src/agent-director-errors.ts'
import {
  errSpawnNotFound,
  errCallTimeout,
  errTmuxSendKeysNotFound,
  errTmuxSendKeysGeneric,
  errTmuxSessionCreate,
  errInstanceIdCollision,
} from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Helpers — factories for error classes that have no typed stub factory
// ---------------------------------------------------------------------------

/**
 * ErrSystemInstallDisappeared has no typed factory in agent-director-stub.ts.
 * Constructor: (verb: string, binaryPath: string)
 */
function makeErrSystemInstallDisappeared(): ErrSystemInstallDisappeared {
  return new ErrSystemInstallDisappeared('status', '/usr/local/bin/agent-director')
}

/**
 * ErrTmuxNotAvailable has no typed factory in agent-director-stub.ts.
 * Constructor: (verb: string, errName: string, message: string)
 */
function makeErrTmuxNotAvailable(): ErrTmuxNotAvailable {
  return new ErrTmuxNotAvailable('spawn', 'ErrTmuxNotAvailable', 'tmux not available')
}

// ---------------------------------------------------------------------------
// classifyAdError — one test per SR-20.2 mapping row
// ---------------------------------------------------------------------------

describe('classifyAdError', () => {
  describe('definitely-dead mappings', () => {
    test('ErrSpawnNotFound → definitely-dead', () => {
      expect(classifyAdError(errSpawnNotFound())).toBe('definitely-dead')
    })
  })

  describe('transient-inconclusive mappings', () => {
    test('ErrSystemInstallDisappeared → transient-inconclusive', () => {
      expect(classifyAdError(makeErrSystemInstallDisappeared())).toBe('transient-inconclusive')
    })

    test('ErrTmuxNotAvailable (AD-sourced) → transient-inconclusive', () => {
      expect(classifyAdError(makeErrTmuxNotAvailable())).toBe('transient-inconclusive')
    })

    test('ErrCallTimeout → transient-inconclusive', () => {
      expect(classifyAdError(errCallTimeout())).toBe('transient-inconclusive')
    })

    test('plain Error (connection-refused-like) → transient-inconclusive', () => {
      expect(classifyAdError(new Error('connect ECONNREFUSED 127.0.0.1:50051'))).toBe('transient-inconclusive')
    })

    test('unrecognized AgentDirectorError subclass (e.g. ErrInstanceIdCollision) → transient-inconclusive', () => {
      // errInstanceIdCollision() is an AgentDirectorError subclass not listed
      // in the named branches of classifyAdError → falls through to the
      // catch-all transient branch.
      expect(classifyAdError(errInstanceIdCollision())).toBe('transient-inconclusive')
    })

    describe('ErrTmuxSendKeys variants — both must be transient-inconclusive (NOT definitely-dead)', () => {
      test('errTmuxSendKeysGeneric() → transient-inconclusive', () => {
        const result = classifyAdError(errTmuxSendKeysGeneric())
        expect(result).toBe('transient-inconclusive')
      })

      test('errTmuxSendKeysNotFound() → transient-inconclusive (NOT definitely-dead)', () => {
        // SR-20.2 row 8 / footnote ³: re-probe + escalation is u4's
        // responsibility; classifyAdError must never return definitely-dead here.
        const result = classifyAdError(errTmuxSendKeysNotFound())
        expect(result).toBe('transient-inconclusive')
        expect(result).not.toBe('definitely-dead')
      })
    })
  })

  describe('not-a-liveness-signal mappings', () => {
    test('ErrTmuxSessionCreate → not-a-liveness-signal', () => {
      expect(classifyAdError(errTmuxSessionCreate())).toBe('not-a-liveness-signal')
    })

    test('ErrCwdNotFound → not-a-liveness-signal', () => {
      const err = new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'cwd not found')
      expect(classifyAdError(err)).toBe('not-a-liveness-signal')
    })

    test('ErrCwdNotADirectory → not-a-liveness-signal', () => {
      const err = new ErrCwdNotADirectory('spawn', 'ErrCwdNotADirectory', 'path is not a directory')
      expect(classifyAdError(err)).toBe('not-a-liveness-signal')
    })
  })

  // -------------------------------------------------------------------------
  // Table-completeness assertion
  // -------------------------------------------------------------------------

  describe('table completeness — all documented signal inputs yield a defined classification (no throw, no undefined)', () => {
    // These are the canonical inputs representing every SR-20.2 AD-verb row.
    // Each must resolve to a non-undefined AdErrorClassification.
    const validClassifications = new Set<AdErrorClassification>([
      'definitely-dead',
      'definitely-alive',
      'transient-inconclusive',
      'not-a-liveness-signal',
    ])

    const signalInputs: Array<{ label: string; err: unknown }> = [
      { label: 'ErrSpawnNotFound',            err: errSpawnNotFound() },
      { label: 'ErrSystemInstallDisappeared', err: makeErrSystemInstallDisappeared() },
      { label: 'ErrTmuxNotAvailable',         err: makeErrTmuxNotAvailable() },
      { label: 'ErrCallTimeout',              err: errCallTimeout() },
      { label: 'ErrTmuxSendKeys (generic)',   err: errTmuxSendKeysGeneric() },
      { label: 'ErrTmuxSendKeys (not-found)', err: errTmuxSendKeysNotFound() },
      { label: 'ErrTmuxSessionCreate',        err: errTmuxSessionCreate() },
      { label: 'ErrCwdNotFound',              err: new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'x') },
      { label: 'ErrCwdNotADirectory',         err: new ErrCwdNotADirectory('spawn', 'ErrCwdNotADirectory', 'x') },
      { label: 'plain Error',                 err: new Error('connection refused') },
      { label: 'ErrInstanceIdCollision (unrecognized AD sub)', err: errInstanceIdCollision() },
    ]

    for (const { label, err } of signalInputs) {
      test(`${label} → defined AdErrorClassification (not undefined, no throw)`, () => {
        let result: AdErrorClassification | undefined
        expect(() => { result = classifyAdError(err) }).not.toThrow()
        expect(result).toBeDefined()
        expect(validClassifications.has(result!)).toBe(true)
      })
    }
  })

  // -------------------------------------------------------------------------
  // No-mutation assertion — classifyAdError is a pure function
  // -------------------------------------------------------------------------

  describe('no-mutation — classifyAdError never invokes exec or kill-session', () => {
    test('calling classifyAdError with all input variants records zero exec invocations on a buildTmuxProbe stub', async () => {
      // Use buildTmuxProbe with a recording exec.  classifyAdError does NOT
      // accept or call exec — this confirms it truly has no side effects on the
      // exec dep that the real has-session probe uses.
      const execCalls: string[][] = []
      buildTmuxProbe({
        exec: async (args) => {
          execCalls.push(args)
          return { exitCode: 0, stderr: '' }
        },
      })

      // Call classifyAdError for every documented input variant.
      classifyAdError(errSpawnNotFound())
      classifyAdError(makeErrSystemInstallDisappeared())
      classifyAdError(makeErrTmuxNotAvailable())
      classifyAdError(errCallTimeout())
      classifyAdError(errTmuxSendKeysGeneric())
      classifyAdError(errTmuxSendKeysNotFound())
      classifyAdError(errTmuxSessionCreate())
      classifyAdError(new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'x'))
      classifyAdError(new ErrCwdNotADirectory('spawn', 'ErrCwdNotADirectory', 'x'))
      classifyAdError(new Error('connection refused'))
      classifyAdError(errInstanceIdCollision())

      // classifyAdError is synchronous and never touches exec.
      expect(execCalls).toHaveLength(0)
    })
  })
})

// ---------------------------------------------------------------------------
// buildTmuxProbe — real classifier via injected exec
// (These rows belong here, not in tmux-probe-fixture.test.ts which tests the STUB only)
// ---------------------------------------------------------------------------

describe('buildTmuxProbe (real classifier via injected exec)', () => {
  /**
   * Build a probe backed by a recording exec that returns the given TmuxExecResult.
   */
  function makeProbeWithResult(result: TmuxExecResult) {
    const execCalls: string[][] = []
    const { probe, killSession } = buildTmuxProbe({
      exec: async (args) => {
        execCalls.push(args)
        return result
      },
    })
    return { probe, killSession, execCalls }
  }

  describe('exit-0 signal → definitely-alive', () => {
    test('exec returns exitCode 0 → classification=definitely-alive, signal=exit-0', async () => {
      const { probe } = makeProbeWithResult({ exitCode: 0, stderr: '' })
      const result = await probe('my-session')
      expect(result.classification).toBe('definitely-alive')
      expect(result.signal).toBe('exit-0')
    })

    test('exec is called with has-session -t <name>', async () => {
      const { probe, execCalls } = makeProbeWithResult({ exitCode: 0, stderr: '' })
      await probe('test-session')
      expect(execCalls).toHaveLength(1)
      expect(execCalls[0]).toEqual(['has-session', '-t', 'test-session'])
    })
  })

  describe('exit-1-session-not-found signal → definitely-dead', () => {
    test("exit 1 + \"can't find session\" stderr → definitely-dead", async () => {
      const { probe } = makeProbeWithResult({ exitCode: 1, stderr: "can't find session: my-session" })
      const result = await probe('my-session')
      expect(result.classification).toBe('definitely-dead')
      expect(result.signal).toBe('exit-1-session-not-found')
    })

    test('exit 1 + "session not found" stderr → definitely-dead', async () => {
      const { probe } = makeProbeWithResult({ exitCode: 1, stderr: 'session not found: my-session' })
      const result = await probe('my-session')
      expect(result.classification).toBe('definitely-dead')
      expect(result.signal).toBe('exit-1-session-not-found')
    })
  })

  describe('exit-1-no-server signal → definitely-dead', () => {
    test('exit 1 + "no server running" stderr → definitely-dead', async () => {
      const { probe } = makeProbeWithResult({ exitCode: 1, stderr: 'no server running on /tmp/tmux-1000/default' })
      const result = await probe('my-session')
      expect(result.classification).toBe('definitely-dead')
      expect(result.signal).toBe('exit-1-no-server')
    })

    test('exit 1 + "failed to connect to server" stderr → definitely-dead', async () => {
      const { probe } = makeProbeWithResult({ exitCode: 1, stderr: 'failed to connect to server' })
      const result = await probe('my-session')
      expect(result.classification).toBe('definitely-dead')
      expect(result.signal).toBe('exit-1-no-server')
    })
  })

  describe('spawn-enoent signal → transient-inconclusive', () => {
    test('spawnError=true → transient-inconclusive, signal=spawn-enoent', async () => {
      const { probe } = makeProbeWithResult({ exitCode: null, stderr: '', spawnError: true })
      const result = await probe('my-session')
      expect(result.classification).toBe('transient-inconclusive')
      expect(result.signal).toBe('spawn-enoent')
    })
  })

  describe('timeout signal → transient-inconclusive', () => {
    test('timedOut=true → transient-inconclusive, signal=timeout', async () => {
      const { probe } = makeProbeWithResult({ exitCode: null, stderr: '', timedOut: true })
      const result = await probe('my-session')
      expect(result.classification).toBe('transient-inconclusive')
      expect(result.signal).toBe('timeout')
    })
  })

  describe('signal-killed → transient-inconclusive', () => {
    test('signalKilled=true → transient-inconclusive, signal=signal-killed', async () => {
      const { probe } = makeProbeWithResult({ exitCode: null, stderr: '', signalKilled: true })
      const result = await probe('my-session')
      expect(result.classification).toBe('transient-inconclusive')
      expect(result.signal).toBe('signal-killed')
    })
  })

  describe('exit-1-unparseable signal → transient-inconclusive', () => {
    test('exit 1 + unrecognized stderr → transient-inconclusive, signal=exit-1-unparseable', async () => {
      const { probe } = makeProbeWithResult({ exitCode: 1, stderr: 'some unrecognised tmux error output' })
      const result = await probe('my-session')
      expect(result.classification).toBe('transient-inconclusive')
      expect(result.signal).toBe('exit-1-unparseable')
    })
  })

  // -------------------------------------------------------------------------
  // killSession — asserts correct exec args
  // -------------------------------------------------------------------------

  describe('killSession sends [kill-session, -t, name] via exec', () => {
    test('killSession sends correct args to exec', async () => {
      const { killSession, execCalls } = makeProbeWithResult({ exitCode: 0, stderr: '' })
      await killSession('target-session')
      expect(execCalls).toHaveLength(1)
      expect(execCalls[0]).toEqual(['kill-session', '-t', 'target-session'])
    })

    test('killSession sends correct args for multiple calls', async () => {
      const { killSession, execCalls } = makeProbeWithResult({ exitCode: 0, stderr: '' })
      await killSession('session-a')
      await killSession('session-b')
      expect(execCalls).toHaveLength(2)
      expect(execCalls[0]).toEqual(['kill-session', '-t', 'session-a'])
      expect(execCalls[1]).toEqual(['kill-session', '-t', 'session-b'])
    })

    test('probe and killSession share the same exec and are independently recorded', async () => {
      const { probe, killSession, execCalls } = makeProbeWithResult({ exitCode: 0, stderr: '' })
      await probe('p-session')
      await killSession('k-session')
      expect(execCalls).toHaveLength(2)
      expect(execCalls[0]).toEqual(['has-session', '-t', 'p-session'])
      expect(execCalls[1]).toEqual(['kill-session', '-t', 'k-session'])
    })
  })
})
