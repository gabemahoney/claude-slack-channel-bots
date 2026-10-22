/** real intake/queue/engine/reporting/reply, in-process Slack and AD. */
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { _resetAckTracker, createQueuedAckCallback, createDeliveryAckCallback, consumeAck } from '../../src/ack-tracker.ts'
import { DEFAULT_ACK_REACTION, DEFAULT_QUEUED_ACK_REACTION, DEFAULT_REPLY_CHUNK_LIMIT, DEFAULT_REPLY_CHUNK_MODE } from '../../src/config.ts'
import { createDeliveryReporting, type DeliveryReportingDeps } from '../../src/delivery-notices.ts'
import { createDeliveryPreparation } from '../../src/delivery-intake.ts'
import type { QueueItem } from '../../src/delivery-queue.ts'
import { createPersonaEventRouter } from '../../src/persona-event-router.ts'
import { createPersonaRouting } from '../../src/persona-routing.ts'
import { createSessionServer, registerSession, unregisterSession, type SessionEntry } from '../../src/registry.ts'
import { assertNoLeak, LEAK_SENTINEL } from './credentials.ts'
import { makeEngineHarness } from './delivery-engine.ts'
import { makeDeliveryNoticeHarness } from './delivery-notices.ts'
import { asWebClient, makeChannelMessage, makeDeferredWebApiCall, type DeferredWebApiCall, type StubWebClient } from './slack-stub.ts'

type AckCallback = (key: string, item: QueueItem) => Promise<void>
export async function makeQueuedAckHarness() {
  let reporting: ReturnType<typeof createDeliveryReporting> | undefined
  const e = await makeEngineHarness({ keys: ['alpha', 'beta'], onEvent: event => reporting?.engineEvent(event) })
  const n = await makeDeliveryNoticeHarness({ queue: e.queue, leakMarker: LEAK_SENTINEL })
  const settings = { queued_ack_reaction: DEFAULT_QUEUED_ACK_REACTION, ack_reaction: DEFAULT_ACK_REACTION, reply_chunk_limit: DEFAULT_REPLY_CHUNK_LIMIT, reply_chunk_mode: DEFAULT_REPLY_CHUNK_MODE }
  Object.assign(n.config, settings)
  const entries = new Map<string, SessionEntry>(), clients = new Map<string, McpClient>()
  const servers: ReturnType<typeof createSessionServer>[] = []
  const held: DeferredWebApiCall[] = []
  const pending = new Set<Promise<void>>()
  const visible = new Map<string, Set<string>>()
  const snapshots: { key: string; channel: string; ts: string; names: string[] }[] = []
  const order: string[] = [], failures = new Set<string>()
  let envelopeAcks = 0
  const originalAccept = e.queue.accept
  e.queue.accept = async (key, input) => {
    if (failures.has(key)) return { status: 'failed', error: Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
    const result = await originalAccept(key, input)
    order.push(`store:${key}:${result.status}`)
    return result
  }
  const reactionKey = (key: string, channel: string, ts: string) => JSON.stringify([key, channel, ts])
  // Model a Slack-side mutation independently of whether its response arrives.
  function applyReaction(key: string, method: 'add' | 'remove', args: { name: string; channel?: string; timestamp?: string }) {
    if (!args.channel || !args.timestamp) throw new Error('expected a message reaction')
    const id = reactionKey(key, args.channel, args.timestamp)
    const names = visible.get(id) ?? new Set<string>()
    if (method === 'add') names.add(args.name)
    else names.delete(args.name)
    visible.set(id, names)
    snapshots.push({ key, channel: args.channel, ts: args.timestamp, names: [...names] })
  }
  for (const persona of n.config.personas) {
    e.p(persona.key).row.state = 'working'
    const transport = { close: async () => {} } as SessionEntry['transport']
    entries.set(persona.key, registerSession(persona.working_directory, persona.key, transport, {} as SessionEntry['server']))
    const web = n.h.stub(persona.key).web
    const add = web.reactions.add, remove = web.reactions.remove
    web.reactions.add = async args => {
      order.push(`add:${persona.key}:${args.name}`)
      const result = await add(args)
      applyReaction(persona.key, 'add', args)
      return result
    }
    web.reactions.remove = async args => {
      order.push(`remove:${persona.key}:${args.name}`)
      const result = await remove(args)
      applyReaction(persona.key, 'remove', args)
      return result
    }
  }
  const clientOverrides = new Map<string, StubWebClient>()
  const clientFor = (key: string) => clientOverrides.get(key) ?? n.h.stub(key).web
  const unavailableClients = new Set<string>()
  const ackClientFor = (key: string) => unavailableClients.has(key) ? undefined : clientFor(key)
  const queued = createQueuedAckCallback({ getReaction: () => settings.queued_ack_reaction, clientFor: ackClientFor, queue: e.queue })
  const delivered = createDeliveryAckCallback({ getReaction: () => settings.ack_reaction, clientFor: ackClientFor, queue: e.queue })
  function watch(callback: AckCallback): AckCallback {
    return (key, item) => {
      const work = callback(key, item)
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => {})
      return work
    }
  }
  const deps: DeliveryReportingDeps = {
    queue: e.queue, episodes: n.rig.episodes,
    persona: key => n.config.personas.find(p => p.key === key), state: () => ({ up: true }),
    log: line => n.logs.push(line), notify: (key, text) => n.h.notifier.notify(key, text),
    queued: watch(queued), delivered: watch(delivered), now: e.clock.now,
  }
  reporting = createDeliveryReporting(deps)
  const routing = createPersonaRouting({
    getPersonaConfig: () => ({ ...n.config, ...settings }), getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }),
    queue: e.queue, prepare: e.preparation.prepare, onReceived: (key, item) => reporting!.received(key, item),
    archive: () => {}, log: line => n.logs.push(line), now: e.clock.now,
  })
  const handler = createPersonaEventRouter({ routing, clientFor: key => asWebClient(clientFor(key)),
    getPersona: key => n.config.personas.find(p => p.key === key), log: line => n.logs.push(line),
  })
  const event = { ...makeChannelMessage({ text: 'queued body' }), channel: 'C0ALPHA01', ts: '1700000000.000001' }
  const h = {
    e, n, settings, routing, event, order, snapshots, failures, clientOverrides, unavailableClients, applyReaction,
    get reporting() { return reporting! },
    get envelopeAcks() { return envelopeAcks },
    stub: (key = 'alpha') => n.h.stub(key),
    visible(key = 'alpha', ts = event.ts as string, channel = event.channel as string) {
      return [...(visible.get(reactionKey(key, channel, ts)) ?? [])]
    },
    item(key = 'alpha', ts = event.ts as string) { return e.queue.items(key).find(item => item.accepted.ts === ts)! },
    hold(method: 'reactionsAdd' | 'reactionsRemove' | 'post', key = 'alpha') {
      const call = makeDeferredWebApiCall(); held.push(call)
      n.h.stub(key).script[method].push(call.outcome)
      return call
    },
    async receive(key = 'alpha', overrides: Record<string, unknown> = {}) {
      await handler(key, 'message', { event: { ...event, ...overrides }, ack: async () => { envelopeAcks++; order.push('envelope-ack') } })
      await e.clock.flush()
    },
    async deliver(key = 'alpha') {
      e.p(key).row.state = 'waiting'
      await e.tick(key)
      await e.until(() => e.queue.openCount(key) === 0)
      await e.clock.flush()
    },
    async restartServer(recoverFirst = true) {
      await Promise.allSettled([...pending])
      _resetAckTracker()
      reporting = createDeliveryReporting(deps)
      // Reopen the actual journal and rebuild the engine; Slack state survives.
      await e.restartServer()
      if (recoverFirst) await h.recover()
      await e.clock.flush()
    },
    async recover() {
      const preparation = createDeliveryPreparation({ queue: e.queue, clock: e.clock, clientFor: key => asWebClient(clientFor(key)),
        resolveUserName: async (_key, user) => user, onReceived: (key, item) => reporting!.received(key, item),
        wake: key => e.engine.wake(key),
      })
      try { await preparation.recover() } finally { await preparation.stop() }
      await e.clock.flush()
    },
    async reply(args: Record<string, unknown> = {}, key = 'alpha') {
      let client = clients.get(key)
      if (!client) {
        const server = createSessionServer(entries.get(key)!, {
          assertSendable: () => {}, getReplySettings: () => settings,
          getPersona: personaKey => n.config.personas.find(p => p.key === personaKey),
          clientFor: personaKey => asWebClient(clientFor(personaKey)),
          resolveUserName: async (_key, user) => user, inboxDir: e.root,
          consumeAck, serverPort: 0, log: line => n.logs.push(line),
        })
        servers.push(server)
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        client = new McpClient({ name: 'queued-ack-test', version: '1.0.0' }, { capabilities: {} })
        clients.set(key, client)
        await client.connect(clientTransport)
      }
      const result = await client.callTool({ name: 'reply', arguments: { chat_id: event.channel, message_id: event.ts, text: 'answer', ...args } })
      await e.clock.flush()
      assertNoLeak(result)
      return result
    },
    async cleanup() {
      for (const call of held) if (!call.settled) call.settle()
      await e.clock.flush()
      await Promise.allSettled([...pending])
      await Promise.all([...clients.values()].map(client => client.close()))
      await Promise.all(servers.map(server => server.close()))
      for (const persona of n.config.personas) unregisterSession(persona.key)
      await e.cleanup()
      assertNoLeak({ logs: n.logs, posts: n.h.allPosts() })
      await n.cleanup()
    },
  }
  return h
}
export type QueuedAckHarness = Awaited<ReturnType<typeof makeQueuedAckHarness>>
