/** Execute session-manager's exact covered branch with the E6 factory enabled.
 * Production deliberately provides no flag override. This evaluates its actual
 * callbacks, rather than duplicating pause/lease/resume wiring in a fake.
 * Row reads and AD wrappers are injected; no process or runtime client starts.
 */
import { readFileSync } from 'node:fs'
import type { GetResult } from 'agent-director'
import type { DeliveryLifecycle } from '../../src/delivery-lifecycle.ts'
import { AGENT_DIRECTOR_DEAD_STATES } from '../../src/liveness-reading.ts'
import { OWN_ROW_READ_ROW, type ReconnectResult } from '../../src/session-manager.ts'
import { personaInstanceId } from '../../src/persona-identity.ts'
import { makeStubClient } from './agent-director-stub.ts'
import { balancedAfter, stripComments } from './source-audit.ts'

export async function runEnabledReconnectBranch(options: {
  key: string; row: GetResult; life: DeliveryLifecycle
  client: ReturnType<typeof makeStubClient>
  readRow(): Promise<GetResult | undefined>
  log: string[]; notices: unknown[]
}) {
  const { createCoveredReconnect } = await import('../../src/covered-delivery.ts')
  const source = stripComments(readFileSync(new URL('../../src/session-manager.ts', import.meta.url), 'utf8'))
  const start = source.indexOf('if (isCoveredRow(row))', source.indexOf('export async function reconnectMcpWithCause'))
  if (start < 0) throw new Error('session-manager covered reconnect branch absent')
  const [open, close] = balancedAfter(source, start, '{', '}')
  const { key, row, life, client } = options
  const deps = {
    key, row, life, reconnectCovered: createCoveredReconnect({ onlyIfWaiting: true }),
    clearInput: () => life.clearReconnectInput(key),
    defer: () => { life.defer(key); return { outcome: 'transient' } },
    personaLatchedNow: () => false, isOwnRowOldLifeHeld: () => false,
    heldGateReadingOf: () => undefined, waitsOnKillFailedHold: () => false,
    AGENT_DIRECTOR_DEAD_STATES, OWN_ROW_READ_ROW, personaInstanceId,
    readPersonaOwnRow: async () => {
      const fresh = await options.readRow()
      if (!fresh) return { kind: 'unreadable' }
      life.observeRow(key, fresh)
      return { kind: OWN_ROW_READ_ROW, row: fresh }
    },
    withOutageDetection: async (_key: string, _unused: unknown, _verb: string, call: (client: typeof options.client) => Promise<unknown>) => call(client),
    launchCallWithWindow: async (_key: string, _cwd: string, _verb: string, call: (client: typeof options.client) => Promise<unknown>) => call(client),
    notifyPersonaNotConnected: (...args: unknown[]) => options.notices.push(args),
    console: { error: (line: string) => options.log.push(line) },
    describeAdFailureForLog: (error: unknown) => String(error),
  }
  const execute = new Function(...Object.keys(deps), 'return (async () => {' + source.slice(open + 1, close) + '})()')
  return await execute(...Object.values(deps)) as ReconnectResult
}
