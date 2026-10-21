/** Recording wrappers for the stub's launch verbs. */
import type { StubClient } from './agent-director-stub.ts'

export type LaunchCall = 'spawn' | 'resume'

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
