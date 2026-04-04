/**
 * test-helpers/peer-pid-stub.ts — Injectable stub for peer PID discovery functions.
 *
 * Returns implementations of getPeerPidByPort and getSessionIdForPid that
 * resolve to configured values without spawning real ss processes or reading
 * real PID session files.
 *
 * Usage:
 *   const stub = makePeerPidStub({ peerPidResult: 12345, sessionIdResult: 'abc-session' })
 *   createSessionServer(entry, makeDeps(web, {
 *     getPeerPidByPort: stub.getPeerPidByPort,
 *     getSessionIdForPid: stub.getSessionIdForPid,
 *   }))
 *
 * SPDX-License-Identifier: MIT
 */

export type PeerPidStubOpts = {
  /** Value getPeerPidByPort resolves to. null → no matching connection found. */
  peerPidResult?: number | null
  /** Value getSessionIdForPid resolves to. null → session file missing or invalid. */
  sessionIdResult?: string | null
}

export type PeerPidStub = {
  /** Stub for injection as deps.getPeerPidByPort */
  getPeerPidByPort: (peerPort: number, serverPort: number) => Promise<number | null>
  /** Stub for injection as deps.getSessionIdForPid */
  getSessionIdForPid: (pid: number) => Promise<string | null>
  /** All recorded calls to getPeerPidByPort */
  peerPidCalls: Array<{ peerPort: number; serverPort: number }>
  /** All recorded calls to getSessionIdForPid */
  sessionIdCalls: Array<{ pid: number }>
}

/**
 * Creates injectable stubs for getPeerPidByPort and getSessionIdForPid.
 * Both return the configured values and record every call.
 */
export function makePeerPidStub(opts: PeerPidStubOpts = {}): PeerPidStub {
  const peerPidResult = opts.peerPidResult ?? null
  const sessionIdResult = opts.sessionIdResult ?? null

  const peerPidCalls: Array<{ peerPort: number; serverPort: number }> = []
  const sessionIdCalls: Array<{ pid: number }> = []

  return {
    peerPidCalls,
    sessionIdCalls,

    async getPeerPidByPort(peerPort: number, serverPort: number): Promise<number | null> {
      peerPidCalls.push({ peerPort, serverPort })
      return peerPidResult
    },

    async getSessionIdForPid(pid: number): Promise<string | null> {
      sessionIdCalls.push({ pid })
      return sessionIdResult
    },
  }
}
