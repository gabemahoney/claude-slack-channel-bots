/**
 * test-helpers/reply-guard-launch.ts — Order-log instruments for the
 * pre-launch reply guard and the stub's launch verbs (b.av2 SR-6.2, SR-9.4).
 *
 * `installRecordingReplyGuard(personas, stateDir, events)` installs the REAL
 * `preLaunchReplyGuard` through the session manager's
 * `setPreLaunchReplyGuard` seam, over the given persona set (the array or
 * getter form `preLaunchReplyGuard` takes) and the test's own state
 * directory. Each step appends 'guard' to `events` before it runs; its undo
 * appends 'undo' before it runs.
 *
 * `observeLaunchCalls(stub, onCall)` wraps the stub's `spawn` and `resume` so
 * each call first runs `onCall('spawn' | 'resume')` (append to the same log,
 * snapshot the record) and then delegates to the stub's own verb, so its call
 * captures and queues still apply.
 *
 * Isolation (b.av2 SR-13.2): no module-scope state and no I/O of its own. The
 * installed step writes only under `stateDir` and the persona's
 * claude_config_dir; the caller passes its own `mkdtempSync` directories and
 * resets the seam (`_resetPreLaunchReplyGuard`) and the launched-with
 * directories (`_resetLaunchedWithDirs`) in `afterEach`.
 *
 * SPDX-License-Identifier: MIT
 */

import { setPreLaunchReplyGuard } from '../../src/session-manager.ts'
import { preLaunchReplyGuard } from '../../src/stop-hook-bootstrap.ts'
import type { StubClient } from './agent-director-stub.ts'

/** What the recording reply guard logs: a step ('guard') or its undo ('undo'). */
export type ReplyGuardLogEvent = 'guard' | 'undo'

/** An agent-director launch verb `observeLaunchCalls` reports. */
export type LaunchCall = 'spawn' | 'resume'

/**
 * Install the real pre-launch reply guard over `personas` and `stateDir`,
 * appending 'guard' to `events` for each step and 'undo' for each undo.
 */
export function installRecordingReplyGuard(
  personas: Parameters<typeof preLaunchReplyGuard>[1],
  stateDir: string,
  events: { push(event: ReplyGuardLogEvent): unknown },
): void {
  setPreLaunchReplyGuard((persona) => {
    events.push('guard')
    const undo = preLaunchReplyGuard(persona, personas, stateDir)
    return () => {
      events.push('undo')
      undo()
    }
  })
}

/**
 * Run `onCall` at each `spawn` / `resume` through `stub`, before delegating
 * to the stub's own verb. Returns `stub`.
 */
export function observeLaunchCalls<S extends Pick<StubClient, 'spawn' | 'resume'>>(
  stub: S,
  onCall: (call: LaunchCall) => void,
): S {
  const spawn = stub.spawn.bind(stub)
  const resume = stub.resume.bind(stub)
  stub.spawn = (params) => {
    onCall('spawn')
    return spawn(params)
  }
  stub.resume = (params) => {
    onCall('resume')
    return resume(params)
  }
  return stub
}
