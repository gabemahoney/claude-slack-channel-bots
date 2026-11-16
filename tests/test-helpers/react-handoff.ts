/** Real detached hand-off owner shared by its unit and MCP registry consumers. */
import { expect } from 'bun:test'
import type { Persona } from '../../src/config.ts'
import type { BotToolReactionInput, BotToolReactionIntakeResult } from '../../src/persona-routing.ts'
import { createReactHandoff, type ReactHandoff } from '../../src/react-handoff.ts'
import { assertNoLeak } from './credentials.ts'
import { createFakeClock, type FakeClock } from './fake-clock.ts'

export interface ReactHandoffFixture {
  clock: FakeClock
  identities: Map<string, string>
  intakes: Array<{ key: string; input: BotToolReactionInput }>
  answer: (key: string, input: BotToolReactionInput) => Promise<BotToolReactionIntakeResult>
  logs: string[]
  shuttingDown: boolean
  releases: Array<() => void>
  handoff: ReactHandoff
}

export function makeReactHandoffFixture(opts: {
  getAppliedPersonas(): readonly Persona[]
  identities: Map<string, string>
  clock?: FakeClock
  log?: (line: string) => void
  isShuttingDown?: () => boolean
  lookupTimeoutMs?: number
}): ReactHandoffFixture {
  const state: Omit<ReactHandoffFixture, 'handoff'> = {
    clock: opts.clock ?? createFakeClock(), identities: opts.identities,
    intakes: [], logs: [],
    answer: async () => ({ status: 'stored', seq: 1 }),
    shuttingDown: false, releases: [],
  }
  const handoff = createReactHandoff({
    getAppliedPersonas: opts.getAppliedPersonas,
    getBotIdentity: key => {
      const botUserId = state.identities.get(key)
      return botUserId === undefined ? undefined : { botUserId }
    },
    receiveBotToolReaction: (key, input) => {
      state.intakes.push({ key, input: structuredClone(input) })
      return state.answer(key, input)
    },
    clock: state.clock,
    ...(opts.lookupTimeoutMs === undefined ? {} : { lookupTimeoutMs: opts.lookupTimeoutMs }),
    isShuttingDown: opts.isShuttingDown ?? (() => state.shuttingDown),
    log: line => { state.logs.push(line); opts.log?.(line) },
  })
  return Object.assign(state, { handoff })
}

/** Cancel first, release held work even after a failed assertion, then drain and verify. */
export async function drainReactHandoff(f: ReactHandoffFixture): Promise<void> {
  const stopped = f.handoff.stop()
  try {
    for (const release of f.releases.splice(0)) release()
  } finally {
    await stopped
    await f.clock.flush()
    expect(f.clock.pendingCount()).toBe(0)
    assertNoLeak({ logs: f.logs, intakes: f.intakes })
  }
}
