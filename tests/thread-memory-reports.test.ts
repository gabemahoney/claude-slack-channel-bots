/** t3.yiv.c9.4b.wx: typed events -> episodes -> complete notifier payloads.
 * CR2 keeps observation-time readiness across replay; CR3 measures the actual
 * Slack payload; CR4 leaves ordinary closed-reporter observations silent.
 * CR5/CR6 preserve configured fields; CR8 observes settled outage recovery.
 * Server shutdown and lifecycle cancellation schedules belong to av/pb.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { SERVER_POST_METADATA } from './test-helpers/server-post.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { THREAD_MEMORY_NOTICE_MAX_CHARS } from '../src/delivery-constants.ts'
import { createPersonaEpisodes, type PersonaEpisodeSinkOptions } from '../src/persona-episodes.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import {
  THREAD_MEMORY_NOT_SAVED, THREAD_MEMORY_UNREADABLE, THREAD_MEMORY_CHANGED_WHILE_STOPPED,
  THREAD_MEMORY_JOINS_LOST,
  buildPostAcceptPreparationFailedLine,
} from '../src/persona-diagnostics.ts'
import { describeSlackCallFailure } from '../src/persona-connection-errors.ts'
import {
  createThreadMemoryReporting, buildThreadMemoryNotSavedNotice, buildThreadMemoryNotSavedLine,
  buildThreadMemoryUnreadableNotice, buildThreadMemoryUnreadableLine,
  buildThreadMemoryRecoveredNotice, buildThreadMemoryRecoveredLine,
  buildThreadMemoryJoinsLostNotice, buildThreadMemoryJoinsLostLine,
  buildThreadMemoryChangedWhileStoppedNotice, buildThreadMemoryChangedWhileStoppedLine,
  buildThreadMemoryQuarantinedLine, buildThreadMemoryCompactionFailedLine,
  buildThreadMemoryRemovalFailedLine, buildThreadMemorySealUnreadableLine,
  buildThreadMemorySealNotSavedLine, buildThreadMemoryHoldsNotResolvedLine,
  buildThreadMemoryCompactionRecoveredLine, buildThreadMemorySealSavedLine, buildThreadMemoryHoldsResolvedLine,
  type ThreadMemoryLoss, type ThreadMemoryReportingDeps,
} from '../src/thread-memory-reports.ts'
import { createThreadMemory, type ThreadMemoryEvent, type ThreadMemoryOutage, type ThreadMemoryQuarantineFact } from '../src/thread-memory.ts'
import type { ThreadMemoryRetryEvent } from '../src/thread-memory-retry.ts'
import type { ThreadMemorySealEvent, ThreadMemorySealFinding, ThreadMemoryChangedFinding, ThreadMemoryOwnPostLossFinding } from '../src/thread-memory-seal.ts'
import type { MemoryHoldEvent, WithdrawnMemoryHold } from '../src/memory-holds.ts'
import type { OwnPostLookupEvent } from '../src/own-post-lookup.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { assertNoLeak, LEAK_SENTINEL, sentinelInMessage, fakeToken, BOT_TOKEN_PREFIX, withoutName } from './test-helpers/credentials.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness } from './test-helpers/persona-notifier.ts'
import { slackPlatformError } from './test-helpers/slack-stub.ts'
import {
  THREAD_CHANNELS as C, THREAD_ROOTS as R, THREAD_STAMP, THREAD_TIME,
  threadJoin, threadHeader, joinRecord, seedThreads, threadFsControls, threadPath, threadSealPath,
} from './test-helpers/thread-memory.ts'

const MESSAGE_BODY = 'reporter-private-message-body'
const UPLOAD_NAME = 'reporter-private-upload.txt'
const healthy = (): ThreadMemoryOutage => ({ unknown: false, unsaved: 0, missing: false })
const quotedPath = (path: string) => JSON.stringify(path).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const failure = () => Object.assign(new Error(`fixture failure ${sentinelInMessage('thread-report')}`), {
  code: 'EIO', body: MESSAGE_BODY, headers: LEAK_SENTINEL, original: { text: MESSAGE_BODY },
})
// Deliberately attach fields the event consumer must never inspect or serialize.
const privateFields = <T extends object>(event: T): T => Object.assign(event, { text: MESSAGE_BODY, file: { name: UPLOAD_NAME }, headers: LEAK_SENTINEL })
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  try { for (const cleanup of cleanups.reverse()) await cleanup() }
  finally { cleanups.length = 0 }
})

function fixture(name = 'alpha', validated = true) {
  const dir = mkdtempSync(join(tmpdir(), 'thread-report-'))
  const config = makeMultiPersonaConfig([name, 'beta'].map(name => ({ name,
    channels: [{ id: C.primary, delivery: 'thread_hybrid' }], permission_prompts: C.primary,
  })), dir)
  const [a, b] = config.personas
  const clock = createFakeClock({ start: THREAD_TIME })
  const notifier = makeNotifierHarness(config, { clock, validated, leakMarker: LEAK_SENTINEL })
  const requests: Array<{ key: string; text: string; options?: PersonaEpisodeSinkOptions }> = []
  const logs: string[] = [], episodeLogs: string[] = []
  const configuredPaths: string[] = []
  const outages = new Map(config.personas.map(p => [p.key, healthy()]))
  const channels = new Map(config.personas.map(p => [p.key, [C.primary] as string[]]))
  const throws = new Set<'sink' | 'async-sink' | 'log' | 'persona' | 'channels' | 'outage'>()
  const episodes = createPersonaEpisodes({ clock,
    sink(key, text, options) {
      requests.push({ key, text, options })
      if (throws.has('sink')) throw failure()
      if (throws.has('async-sink')) return Promise.reject(failure())
      return notifier.notifier.notify(key, text, options)
    },
    log: line => { episodeLogs.push(line) },
    teardownWindow: key => notifier.notifier.teardownWindowState(key),
  })
  const deps: ThreadMemoryReportingDeps = {
    episodes,
    log(line) { logs.push(line); if (throws.has('log')) throw failure() },
    persona(key) { if (throws.has('persona')) throw failure(); return config.personas.find(p => p.key === key) },
    threadHybridChannels(key) { if (throws.has('channels')) throw failure(); return channels.get(key) ?? [] },
    outage(key) { if (throws.has('outage')) throw failure(); return outages.get(key) ?? healthy() },
  }
  const reporter = createThreadMemoryReporting(deps)
  const path = threadPath(dir, a!.key), sealPath = threadSealPath(dir)
  const ref = (key = a!.key) => {
    const p = config.personas.find(p => p.key === key)!
    return renderPersonaRef(p.name, p.key)
  }
  const append = (key = a!.key, noticeOnly = false): Extract<ThreadMemoryEvent, { type: 'append-failed' }> => privateFields({ type: 'append-failed', key,
    path: threadPath(dir, key), step: 'journal-append', noticeOnly, error: failure() })
  const unreadable = (key = a!.key): ThreadMemoryEvent => privateFields({ type: 'read-failed', key,
    path: threadPath(dir, key), error: failure() })
  const saved = (key = a!.key): ThreadMemoryEvent => ({ type: 'saved-after-failure', key, path: threadPath(dir, key) })
  const settled = (key = a!.key): ThreadMemoryEvent => ({ type: 'outage-settled', key, path: threadPath(dir, key) })
  const quarantined = (finalOnly = false, key = a!.key): Extract<ThreadMemoryEvent, { type: 'lines-quarantined' }> => privateFields({
    type: 'lines-quarantined', key, path: threadPath(dir, key), quarantinePath: `${threadPath(dir, key)}.quarantine`,
    facts: finalOnly ? [{ line: 2, invalidFinalLine: true }] : [
      { line: 2, invalidFinalLine: false, channel: C.secondary, root: R.primary },
      { line: 3, invalidFinalLine: false }, { line: 4, invalidFinalLine: true },
    ],
  })
  cleanups.push(async () => {
    await clock.flush()
    try {
      const captured = { requests, logs, episodeLogs, posts: notifier.allPosts(), notifierLogs: notifier.logs,
        entries: notifier.startupEntries() }
      let checked = JSON.stringify(captured)
      // CR6 permits these complete quoted configured fields only. Distinct
      // credential/error tokens and all opaque payload fields remain checked.
      for (const path of configuredPaths) {
        for (const rendered of [quotedPath(path), escapeSlackControlCharacters(quotedPath(path))]) {
          checked = checked.replaceAll(JSON.stringify(rendered).slice(1, -1), '<configured-path>')
        }
      }
      assertNoLeak(withoutName(checked, name, a!.key))
      expect(JSON.stringify(captured)).not.toContain(MESSAGE_BODY)
      expect(JSON.stringify(captured)).not.toContain(UPLOAD_NAME)
      expect(clock.pendingCount()).toBe(0)
    } finally {
      episodes.close(); reporter.close(); notifier.cleanup(); rmSync(dir, { recursive: true, force: true })
    }
  })
  return { dir, config, a: a!, b: b!, clock, notifier, requests, logs, episodeLogs, outages, channels, throws,
    episodes, deps, reporter, path, sealPath, ref, append, unreadable, saved, settled, quarantined, configuredPaths }
}
type Fixture = ReturnType<typeof fixture>
/** Event inputs and expected public builders; episode decisions stay in production. */
function operation(f: Fixture, kind: 'compaction' | 'seal' | 'resolution', key = f.a.key) {
  const path = threadPath(f.dir, key)
  return {
    fail(error: unknown, unsynced = false) {
      if (kind === 'compaction') f.reporter.threadMemoryEvent(privateFields({ type: 'compaction-failed', key, path, step: 'journal-rewrite', error }))
      else if (kind === 'seal') f.reporter.sealEvent(privateFields({ type: 'seal-write-failed', path: f.sealPath, error, unsynced }))
      else f.reporter.holdsEvent(privateFields({ type: 'resolution-failed', key, error }))
    },
    complete() {
      if (kind === 'compaction') f.reporter.threadMemoryEvent(privateFields({ type: 'compacted', key, path, outcome: 'rewritten' }))
      else if (kind === 'seal') f.reporter.sealEvent(privateFields({ type: 'seal-written', path: f.sealPath }))
      else f.reporter.holdsEvent(privateFields({ type: 'resolution-saved', key }))
    },
    onset: (error: unknown) => kind === 'compaction' ? buildThreadMemoryCompactionFailedLine(key, path, 'journal-rewrite', error)
      : kind === 'seal' ? buildThreadMemorySealNotSavedLine(f.sealPath, error, false) : buildThreadMemoryHoldsNotResolvedLine(key, error),
    recovery: kind === 'compaction' ? buildThreadMemoryCompactionRecoveredLine(key, path)
      : kind === 'seal' ? buildThreadMemorySealSavedLine(f.sealPath) : buildThreadMemoryHoldsResolvedLine(key),
  }
}
function holds(count = 1): WithdrawnMemoryHold[] {
  return Array.from({ length: count }, (_, i) => {
    const fact = threadJoin({ channel: i % 2 ? C.secondary : C.primary,
      root: `1700000000.${String(i + 1).padStart(6, '0')}` })
    return privateFields({ seq: i + 1, channel: fact.channel, thread_ts: fact.root,
      ts: `1700000100.${String(i + 1).padStart(6, '0')}` })
  })
}
const holdLoss = (rows: WithdrawnMemoryHold[]): ThreadMemoryLoss => ({
  threads: rows.map(h => ({ channel: h.channel, root: h.thread_ts })),
  messages: rows.map(h => ({ channel: h.channel, ts: h.ts })),
})
const withdraw = (f: Fixture, rows = holds()): MemoryHoldEvent => privateFields({ type: 'withdrawn', key: f.a.key, holds: rows })
const lostLookup = (f: Fixture, overrides: Partial<OwnPostLookupEvent> = {}): OwnPostLookupEvent => privateFields({
  kind: 'joins-lost', key: f.a.key, channel: C.secondary, threads: [R.primary, R.secondary], cause: 'several', ...overrides,
})
const lookupLoss = ({ channel, threads, cause }: OwnPostLookupEvent): ThreadMemoryLoss => ({
  threads: [], messages: [], ownPosts: [{ channel, threads, cause }],
})

describe('Thread Memory reporter event mappings and episodes', () => {
  test.each(['seal-entry', 'journal-header', 'marker', 'journal-append'] as const)('%s failures post and log once until recovery', step => {
    const f = fixture(), error = failure()
    const event: ThreadMemoryEvent = privateFields(step === 'journal-append'
      ? { type: 'append-failed', key: f.a.key, path: f.path, step, error, noticeOnly: false }
      : { type: 'creation-failed', key: f.a.key, path: f.path, step, error })
    for (let i = 0; i < 3; i++) f.reporter.threadMemoryEvent(event)
    expect(f.requests).toEqual([{ key: f.a.key, text: buildThreadMemoryNotSavedNotice(f.ref(), [C.primary], f.path, step, error), options: undefined }])
    expect(f.logs).toEqual([buildThreadMemoryNotSavedLine(f.a.key, [C.primary], f.path, step, error)])
    expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_NOT_SAVED)).toBe(true)
    f.reporter.threadMemoryEvent(f.saved())
    f.reporter.threadMemoryEvent(event)
    expect(f.requests).toHaveLength(3)
    expect(f.logs.at(-1)).toBe(f.logs[0])
  })

  test('repeated read failures and a missing retry keep one unreadable episode until recovery or forget', () => {
    const f = fixture(), error = failure()
    const event: ThreadMemoryEvent = { type: 'read-failed', key: f.a.key, path: f.path, error }
    const missing: ThreadMemoryRetryEvent = { type: 'journal-missing-on-retry', key: f.a.key }
    f.reporter.threadMemoryEvent(event); f.reporter.threadMemoryEvent(event)
    f.reporter.retryEvent(missing); f.reporter.retryEvent(missing)
    expect(f.requests.map(p => p.text)).toEqual([buildThreadMemoryUnreadableNotice(f.ref(), [C.primary], f.path)])
    expect(f.logs).toEqual([buildThreadMemoryUnreadableLine(f.a.key, [C.primary], f.path, error),
      buildThreadMemoryUnreadableLine(f.a.key, [C.primary], '', undefined, true)])
    f.outages.set(f.a.key, { unknown: true, unsaved: 0, missing: true })
    f.reporter.threadMemoryEvent(f.saved())
    expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_UNREADABLE)).toBe(true)
    expect(f.requests).toHaveLength(1)
    f.outages.set(f.a.key, healthy()); f.reporter.threadMemoryEvent(f.saved())
    f.reporter.retryEvent(missing); f.reporter.retryEvent(missing)
    expect(f.logs).toHaveLength(4)
    f.episodes.forget(f.a.key); f.reporter.retryEvent(missing)
    expect(f.logs).toHaveLength(5)
  })

  test.each(['read', 'saved-after-failure', 'outage-settled', 'read-after-retries', 'saved-after-retries'] as const)('%s recovers both episodes once only after every outage flag clears', type => {
    const f = fixture()
    f.reporter.threadMemoryEvent(f.unreadable()); f.reporter.threadMemoryEvent(f.append())
    const report = () => {
      if (type === 'read' || type === 'saved-after-failure' || type === 'outage-settled') f.reporter.threadMemoryEvent({ type, key: f.a.key, path: f.path, firstSuccessfulRead: true })
      else f.reporter.retryEvent({ type, key: f.a.key, attempts: 2 })
    }
    for (const state of [{ ...healthy(), unknown: true }, { ...healthy(), unsaved: 1 }, { ...healthy(), missing: true }]) {
      f.outages.set(f.a.key, state); report()
      expect(f.requests).toHaveLength(2)
      expect(f.logs).toHaveLength(2)
      expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_NOT_SAVED)).toBe(true)
      expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_UNREADABLE)).toBe(true)
    }
    f.outages.set(f.a.key, healthy()); report(); report()
    expect(f.requests.map(p => p.text).slice(2)).toEqual([buildThreadMemoryRecoveredNotice(f.ref(), [C.primary])])
    expect(f.logs.slice(2)).toEqual([buildThreadMemoryRecoveredLine(f.a.key, [C.primary])])
    expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_NOT_SAVED)).toBe(false)
    expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_UNREADABLE)).toBe(false)
  })

  test.each([
    ['append', 'saved'], ['unreadable', 'saved'], ['append', 'settled'], ['unreadable', 'settled'],
  ] as const)('a lone %s episode gets one recovery from %s and healthy events alone post nothing', (kind, recovery) => {
    const f = fixture()
    f.reporter.threadMemoryEvent(f[recovery]()); expect(f.requests).toEqual([]); expect(f.logs).toEqual([])
    f.reporter.threadMemoryEvent(f[kind]()); f.reporter.threadMemoryEvent(f[recovery]()); f.reporter.threadMemoryEvent(f[recovery]())
    expect(f.requests.map(p => p.text).slice(1)).toEqual([buildThreadMemoryRecoveredNotice(f.ref(), [C.primary])])
    expect(f.logs.slice(1)).toEqual([buildThreadMemoryRecoveredLine(f.a.key, [C.primary])])
  })

  test('each quarantining read is a loss episode, excluding the torn final line and counting unidentified lines', () => {
    const f = fixture(), event = f.quarantined()
    const loss: ThreadMemoryLoss = { threads: [{ channel: C.secondary, root: R.primary }], messages: [], unreadableLines: 1 }
    const notice = buildThreadMemoryJoinsLostNotice(f.a, loss)
    f.reporter.threadMemoryEvent(event); f.reporter.threadMemoryEvent(event)
    expect(f.requests).toEqual(Array.from({ length: 2 }, () => ({ key: f.a.key, ...notice })))
    expect(f.logs).toEqual(Array.from({ length: 2 }, () => [
      buildThreadMemoryQuarantinedLine(f.a.key, event.quarantinePath, 3, 1), buildThreadMemoryJoinsLostLine(f.a, loss),
    ]).flat())
  })

  test('a lone invalid final line logs quarantine without a loss post', () => {
    const f = fixture(), event = f.quarantined(true)
    f.reporter.threadMemoryEvent(event)
    expect(f.requests).toEqual([])
    expect(f.logs).toEqual([buildThreadMemoryQuarantinedLine(f.a.key, event.quarantinePath, 1, 1)])
  })

  test('quarantine and its withdrawn holds are separate losses, and every resolution names all its holds', () => {
    const f = fixture(), rows = holds(3), loss = holdLoss(rows)
    f.reporter.threadMemoryEvent(f.quarantined())
    f.reporter.holdsEvent(withdraw(f, rows)); f.reporter.holdsEvent(withdraw(f, []))
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]).toEqual({ key: f.a.key, ...buildThreadMemoryJoinsLostNotice(f.a, loss) })
    expect(f.logs.at(-1)).toBe(buildThreadMemoryJoinsLostLine(f.a, loss))
    f.reporter.holdsEvent(withdraw(f, rows))
    expect(f.requests).toHaveLength(3)
    expect(f.logs.at(-1)).toBe(buildThreadMemoryJoinsLostLine(f.a, loss))
  })

  test.each([
    { label: 'several candidates', cause: 'several', threads: [R.primary, R.secondary] },
    { label: 'unmatched own posts', cause: 'unmatched', threads: [R.secondary] },
    { label: 'permanent Slack refusal', cause: 'channel_not_found', threads: [] },
    { label: 'token-bearing Slack code', cause: sentinelInMessage('lookup-code'), threads: [], name: fakeToken(BOT_TOKEN_PREFIX, 'configured-lookup-name') },
  ])('$label: each lookup posts and logs once with its own channel and threads', async ({ cause, threads, name }) => {
    const f = fixture(name ?? 'Ops <&> "night" 🐝'), event = lostLookup(f, { cause, threads })
    const loss = lookupLoss(event), notice = buildThreadMemoryJoinsLostNotice(f.a, loss)
    for (let i = 0; i < 2; i++) {
      f.reporter.lookupEvent(event)
      expect(f.requests).toHaveLength(i + 1)
      expect(f.logs).toHaveLength(i + 1)
      expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_JOINS_LOST)).toBe(false)
    }
    expect(f.requests).toEqual(Array.from({ length: 2 }, () => ({ key: f.a.key, ...notice })))
    expect(f.logs).toEqual(Array.from({ length: 2 }, () => buildThreadMemoryJoinsLostLine(f.a, loss)))
    await f.clock.flush()
    expect(f.notifier.posts(f.a.key)).toEqual(Array.from({ length: 2 }, () => ({
      channel: C.primary, text: formatPersonaNotice(f.a, notice.text, notice.options), metadata: SERVER_POST_METADATA,
    })))
    expect(f.notifier.posts(f.b.key)).toEqual([])
  })

  test.each(['quarantine', 'withdrawn holds'] as const)('lookup losses remain separate before and after %s', source => {
    const f = fixture(), lookup = lostLookup(f), rows = holds(2), quarantine = f.quarantined()
    const earlierLoss: ThreadMemoryLoss = source === 'quarantine'
      ? { threads: [{ channel: C.secondary, root: R.primary }], messages: [], unreadableLines: 1 }
      : holdLoss(rows)
    f.reporter.lookupEvent(lookup)
    if (source === 'quarantine') f.reporter.threadMemoryEvent(quarantine)
    else f.reporter.holdsEvent(withdraw(f, rows))
    f.reporter.lookupEvent(lookup)
    expect(f.requests).toEqual([lookupLoss(lookup), earlierLoss, lookupLoss(lookup)].map(loss => ({
      key: f.a.key, ...buildThreadMemoryJoinsLostNotice(f.a, loss),
    })))
    expect(f.logs).toEqual([
      buildThreadMemoryJoinsLostLine(f.a, lookupLoss(lookup)),
      ...(source === 'quarantine' ? [buildThreadMemoryQuarantinedLine(f.a.key, quarantine.quarantinePath, 3, 1)] : []),
      buildThreadMemoryJoinsLostLine(f.a, earlierLoss),
      buildThreadMemoryJoinsLostLine(f.a, lookupLoss(lookup)),
    ])
  })

  test('a key\'s lookup losses leave its sibling\'s open episodes unchanged', () => {
    const f = fixture()
    f.reporter.threadMemoryEvent(f.append(f.b.key)); f.reporter.threadMemoryEvent(f.unreadable(f.b.key))
    const siblingRequests = [...f.requests], siblingLogs = [...f.logs]
    f.reporter.lookupEvent(lostLookup(f)); f.reporter.lookupEvent(lostLookup(f))
    expect(f.requests.filter(p => p.key === f.b.key)).toEqual(siblingRequests)
    expect(f.logs.slice(0, 2)).toEqual(siblingLogs)
    expect(f.episodes.isOpen(f.b.key, THREAD_MEMORY_NOT_SAVED)).toBe(true)
    expect(f.episodes.isOpen(f.b.key, THREAD_MEMORY_UNREADABLE)).toBe(true)
    const siblingLookup = lostLookup(f, { key: f.b.key, channel: C.primary })
    f.reporter.lookupEvent(siblingLookup)
    expect(f.requests).toHaveLength(5)
    expect(f.requests.at(-1)).toEqual({ key: f.b.key, ...buildThreadMemoryJoinsLostNotice(f.b, lookupLoss(siblingLookup)) })
    expect(f.logs.at(-1)).toBe(buildThreadMemoryJoinsLostLine(f.b, lookupLoss(siblingLookup)))
    f.reporter.threadMemoryEvent(f.append(f.b.key)); f.reporter.threadMemoryEvent(f.unreadable(f.b.key))
    expect(f.requests).toHaveLength(5)
    f.reporter.threadMemoryEvent(f.saved(f.b.key))
    expect(f.requests).toHaveLength(6)
    expect(f.requests.at(-1)!.text).toBe(buildThreadMemoryRecoveredNotice(f.ref(f.b.key), [C.primary]))
  })

  const sealedLoss = (key: string): ThreadMemoryOwnPostLossFinding => privateFields({
    key, case: 'own-post-joins-lost', threads: [{ channel: C.primary, root: R.primary }, { channel: C.secondary, root: R.secondary }],
  })
  test.each([
    { case: 'journal-missing', wording: 'changed' },
    { case: 'unclean-stop', wording: 'unclean' },
  ] as const)('sealed own-post losses coexist with $case, end their own episodes and do not consume later losses', value => {
    const f = fixture(), a = sealedLoss(f.a.key), b = sealedLoss(f.b.key)
    const changed: ThreadMemoryChangedFinding = { key: f.a.key, ...value }
    f.reporter.startupFindings([a, changed, b])
    const loss: ThreadMemoryLoss = { threads: a.threads, messages: [] }
    expect(f.requests).toEqual([
      { key: f.a.key, ...buildThreadMemoryJoinsLostNotice(f.a, loss) },
      { key: f.a.key, text: buildThreadMemoryChangedWhileStoppedNotice(f.ref(), [C.primary], changed.wording), options: undefined },
      { key: f.b.key, ...buildThreadMemoryJoinsLostNotice(f.b, loss) },
    ])
    expect(f.logs).toEqual([
      buildThreadMemoryJoinsLostLine(f.a, loss),
      buildThreadMemoryChangedWhileStoppedLine(f.a.key, [C.primary], changed.case, changed.wording),
      buildThreadMemoryJoinsLostLine(f.b, loss),
    ])
    for (const key of [f.a.key, f.b.key]) expect(f.episodes.isOpen(key, THREAD_MEMORY_JOINS_LOST)).toBe(false)
    f.reporter.threadMemoryEvent(f.quarantined())
    f.reporter.lookupEvent(lostLookup(f))
    expect(f.requests).toHaveLength(5)
    expect(f.requests.at(-1)).toEqual({ key: f.a.key, ...buildThreadMemoryJoinsLostNotice(f.a, lookupLoss(lostLookup(f))) })
    expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_JOINS_LOST)).toBe(false)
  })

  test('sealed own-post loss is replayed only by startupFindings, not again by its seal event', () => {
    const f = fixture(), finding = sealedLoss(f.a.key)
    const event: ThreadMemorySealEvent = { type: 'own-post-joins-lost', ...finding }
    f.reporter.sealEvent(event)
    f.reporter.startupFindings([finding])
    f.reporter.sealEvent(event)
    expect(f.requests).toEqual([{ key: f.a.key, ...buildThreadMemoryJoinsLostNotice(f.a, { threads: finding.threads, messages: [] }) }])
    expect(f.logs).toEqual([buildThreadMemoryJoinsLostLine(f.a, { threads: finding.threads, messages: [] })])
  })

  test.each(['submitted', 'open', 'closed'] as const)('sealed own-post loss stays silent when %s', state => {
    const f = fixture(), finding = sealedLoss(f.a.key)
    if (state === 'closed') f.episodes.close()
    else {
      f.notifier.notifier.submitTeardown(f.a.key)
      if (state === 'open') f.notifier.notifier.openTeardownWindow(f.a)
    }
    f.reporter.startupFindings([finding])
    f.reporter.sealEvent({ type: 'own-post-joins-lost', ...finding })
    expect(f.requests).toEqual([]); expect(f.logs).toEqual([])
  })

  test('notice-only failures join an already reported outage without posting, logging or closing it', () => {
    const f = fixture()
    f.outages.set(f.a.key, { ...healthy(), unsaved: 3 })
    f.reporter.threadMemoryEvent(f.append())
    const requests = [...f.requests], logs = [...f.logs]
    f.reporter.threadMemoryEvent(f.append(f.a.key, true)); f.reporter.threadMemoryEvent(f.saved())
    expect(f.requests).toEqual(requests); expect(f.logs).toEqual(logs)
    expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_NOT_SAVED)).toBe(true)
    f.outages.set(f.a.key, healthy()); f.reporter.threadMemoryEvent(f.saved()); f.reporter.threadMemoryEvent(f.saved())
    expect(f.requests.map(p => p.text).slice(1)).toEqual([buildThreadMemoryRecoveredNotice(f.ref(), [C.primary])])
    expect(f.logs.slice(1)).toEqual([buildThreadMemoryRecoveredLine(f.a.key, [C.primary])])
  })

  test('notice-only outages log once, stay open while unsaved, end silently and can open again', () => {
    const f = fixture(), event = f.append(f.a.key, true)
    const line = buildThreadMemoryNotSavedLine(f.a.key, [C.primary], f.path, event.step, event.error, true)
    for (let episode = 1; episode <= 2; episode++) {
      f.outages.set(f.a.key, { ...healthy(), unsaved: 1 })
      f.reporter.threadMemoryEvent(event); f.reporter.threadMemoryEvent(event); f.reporter.threadMemoryEvent(f.saved())
      expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_NOT_SAVED)).toBe(true)
      expect(f.episodes.hasPosted(f.a.key, THREAD_MEMORY_NOT_SAVED)).toBe(false)
      expect(f.logs).toEqual(Array(episode).fill(line)); expect(f.requests).toEqual([])
      f.outages.set(f.a.key, healthy()); f.reporter.threadMemoryEvent(f.settled())
      expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_NOT_SAVED)).toBe(false)
      expect(f.requests).toEqual([]); expect(f.logs).toEqual(Array(episode).fill(line))
    }
  })

  test.each(['append', 'creation', 'read'] as const)('an ordinary %s failure after a silent episode still reports and recovers once, then a notice flap stays silent', kind => {
    const f = fixture(), silent = f.append(f.a.key, true)
    f.reporter.threadMemoryEvent(silent)
    const event: ThreadMemoryEvent = kind === 'append' ? f.append() : kind === 'read' ? f.unreadable()
      : { type: 'creation-failed', key: f.a.key, path: f.path, step: 'marker', error: failure() }
    f.outages.set(f.a.key, { ...healthy(), unsaved: 3 })
    f.reporter.threadMemoryEvent(event); f.reporter.threadMemoryEvent(event)
    expect(f.requests.map(p => p.text)).toEqual([kind === 'read'
      ? buildThreadMemoryUnreadableNotice(f.ref(), [C.primary], f.path)
      : buildThreadMemoryNotSavedNotice(f.ref(), [C.primary], f.path, kind === 'creation' ? 'marker' : 'journal-append', failure())])
    f.reporter.threadMemoryEvent(f.saved()); expect(f.requests).toHaveLength(1)
    f.outages.set(f.a.key, healthy()); f.reporter.threadMemoryEvent(f.saved())
    expect(f.requests.map(p => p.text).slice(1)).toEqual([buildThreadMemoryRecoveredNotice(f.ref(), [C.primary])])
    const prior = [...f.requests], logs = f.logs.length
    f.reporter.threadMemoryEvent(silent); f.reporter.threadMemoryEvent(silent); f.reporter.threadMemoryEvent(f.saved())
    expect(f.requests).toEqual(prior)
    expect(f.logs.slice(logs)).toEqual([buildThreadMemoryNotSavedLine(f.a.key, [C.primary], f.path, silent.step, silent.error, true)])
    expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_NOT_SAVED)).toBe(false)
  })

  const findings: Array<Pick<ThreadMemoryChangedFinding, 'case' | 'wording'>> = [
    { case: 'unclean-stop', wording: 'unclean' },
    ...(['journal-missing', 'journal-changed', 'entry-missing', 'hybrid-without-store', 'marker-without-store', 'queue-changed'] as const)
      .map(value => ({ case: value, wording: 'changed' as const })),
  ]
  test.each(findings)('$case startup and later first-read findings post once per key until forget', value => {
    const f = fixture(), finding = { ...value, key: f.a.key }
    f.reporter.startupFindings([finding, finding])
    f.reporter.sealEvent({ type: 'changed-while-stopped', ...finding })
    expect(f.requests.map(p => p.text)).toEqual([buildThreadMemoryChangedWhileStoppedNotice(f.ref(), [C.primary], finding.wording)])
    expect(f.logs).toEqual([buildThreadMemoryChangedWhileStoppedLine(f.a.key, [C.primary], finding.case, finding.wording)])
    expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_CHANGED_WHILE_STOPPED)).toBe(true)
    f.episodes.forget(f.a.key)
    f.reporter.sealEvent({ type: 'changed-while-stopped', ...finding })
    f.reporter.startupFindings([finding])
    expect(f.requests).toHaveLength(2)
    expect(f.logs).toEqual([f.logs[0]!, f.logs[0]!])
  })

  test('every log-only failure uses its diagnostic builder and never posts', () => {
    const f = fixture(), error = failure(), expected: string[] = []
    f.reporter.threadMemoryEvent({ type: 'compaction-failed', key: f.a.key, path: f.path, step: 'journal-rewrite', error })
    expected.push(buildThreadMemoryCompactionFailedLine(f.a.key, f.path, 'journal-rewrite', error))
    for (const step of ['journal-unlink', 'seal-entry', 'marker'] as const) {
      f.reporter.threadMemoryEvent({ type: 'removal-failed', key: f.a.key, path: f.path, step, error })
      expected.push(buildThreadMemoryRemovalFailedLine(f.a.key, f.path, step, error))
    }
    for (const type of ['seal-read-failed', 'seal-invalid'] as const) {
      f.reporter.sealEvent({ type, path: f.sealPath, error })
      expected.push(buildThreadMemorySealUnreadableLine(f.sealPath, error))
    }
    for (const unsynced of [false, true]) {
      f.reporter.sealEvent({ type: 'seal-write-failed', path: f.sealPath, error, unsynced })
    }
    expected.push(buildThreadMemorySealNotSavedLine(f.sealPath, error, false))
    f.reporter.holdsEvent({ type: 'resolution-failed', key: f.a.key, error })
    expected.push(buildThreadMemoryHoldsNotResolvedLine(f.a.key, error))
    expect(f.logs).toEqual(expected)
    expect(f.requests).toEqual([])
  })

  test.each(['compaction', 'seal', 'resolution'] as const)('%s logs one onset and matching recovery, stays quiet while healthy, then reports recurrence', async kind => {
    const f = fixture(), op = operation(f, kind), error = failure()
    op.complete(); op.complete(); expect(f.logs).toEqual([])
    op.fail(error)
    op.fail(Object.assign(failure(), { message: sentinelInMessage('changed-error') }), true)
    f.reporter.retryEvent({ type: 'seal-written-after-retries', attempts: 19 })
    expect(f.logs).toEqual([op.onset(error)])
    op.complete(); op.complete()
    expect(f.logs).toEqual([op.onset(error), op.recovery])
    op.fail(error); op.complete()
    expect(f.logs).toEqual([op.onset(error), op.recovery, op.onset(error), op.recovery])
    await f.clock.flush()
    expect(f.requests).toEqual([]); expect(f.notifier.allPosts()).toEqual({ [f.a.key]: [], [f.b.key]: [] }); expect(f.notifier.startupEntries()).toEqual([])
  })

  test('operation and persona recoveries remain independent from each other and the readable/every-kept-join-saved outage', async () => {
    const f = fixture(), error = failure()
    const ops = [operation(f, 'compaction'), operation(f, 'resolution'), operation(f, 'compaction', f.b.key), operation(f, 'seal')]
    f.outages.set(f.a.key, { ...healthy(), unknown: true, unsaved: 1 })
    f.reporter.threadMemoryEvent(f.unreadable()); f.reporter.threadMemoryEvent(f.append())
    const outageLogs = [...f.logs], notices = [...f.requests]
    for (const op of ops) op.fail(error)
    ops[1]!.complete(); ops[0]!.complete()
    ops[2]!.fail(error); ops[3]!.fail(error, true)
    f.reporter.threadMemoryEvent(f.settled())
    expect(f.logs).toEqual([...outageLogs, ...ops.map(op => op.onset(error)), ops[1]!.recovery, ops[0]!.recovery])
    expect(f.requests).toEqual(notices)
    f.outages.set(f.a.key, healthy()); f.reporter.threadMemoryEvent(f.settled())
    expect(f.requests.map(p => p.text)).toEqual([...notices.map(p => p.text), buildThreadMemoryRecoveredNotice(f.ref(), [C.primary])])
    // Readable-memory recovery did not close either of the remaining operations.
    ops[2]!.fail(error); ops[3]!.fail(error); ops[2]!.complete(); ops[3]!.complete()
    expect(f.logs.slice(-3)).toEqual([buildThreadMemoryRecoveredLine(f.a.key, [C.primary]), ops[2]!.recovery, ops[3]!.recovery])
    await f.clock.flush(); expect(f.notifier.startupEntries()).toEqual([])
  })

  test.each(['compaction', 'resolution'] as const)('forget silently drops %s for one persona; teardown and a real persona named all cannot reset the shared seal episode', kind => {
    const f = fixture('all'), error = failure(), a = operation(f, kind), b = operation(f, kind, f.b.key), seal = operation(f, 'seal')
    expect(f.a.key).toBe('all')
    a.fail(error); b.fail(error); seal.fail(error)
    f.episodes.forget(f.a.key); f.notifier.notifier.submitTeardown(f.a.key)
    a.fail(error); a.complete(); seal.fail(error, true)
    expect(f.logs).toEqual([a.onset(error), b.onset(error), seal.onset(error)])
    b.complete(); seal.complete()
    expect(f.logs.slice(-2)).toEqual([b.recovery, seal.recovery])
    f.notifier.notifier.settleTeardown(f.a.key)
    a.complete(); expect(f.logs).toHaveLength(5)
    a.fail(error); a.complete()
    expect(f.logs.slice(-2)).toEqual([a.onset(error), a.recovery]); expect(f.requests).toEqual([])
  })

  test.each(['episodes', 'reporter'] as const)('closing %s suppresses late failures, completions and release callbacks for open episodes', close => {
    const f = fixture(), error = failure(), ops = (['compaction', 'seal', 'resolution'] as const).map(kind => operation(f, kind))
    for (const op of ops) op.fail(error)
    if (close === 'episodes') f.episodes.close(); else f.reporter.close()
    for (const op of ops) { op.complete(); op.fail(error, true); op.complete() }
    f.reporter.holdsEvent(privateFields({ type: 'release-failed', key: f.a.key, seq: 1, error }))
    expect(f.logs).toEqual(ops.map(op => op.onset(error))); expect(f.requests).toEqual([])
  })

  test('each release failure uses the shared safe preparation builder without opening a persistence or recovery episode', () => {
    const f = fixture(), errors = [failure(), slackPlatformError('missing_scope', undefined, sentinelInMessage('release-feedback'))]
    for (const [index, error] of errors.entries()) f.reporter.holdsEvent(privateFields({ type: 'release-failed', key: f.a.key, seq: index + 1, error }))
    operation(f, 'resolution').complete()
    expect(f.logs).toEqual(errors.map(error => buildPostAcceptPreparationFailedLine(describeSlackCallFailure(error))))
    expect(f.logs[1]).toContain('missing_scope')
    expect(f.requests).toEqual([])
  })

  test('successful creation, removal, seal writes and retry bookkeeping stay silent', () => {
    const f = fixture()
    for (const type of ['created', 'removed'] as const) f.reporter.threadMemoryEvent({ type, key: f.a.key, path: f.path })
    f.reporter.sealEvent({ type: 'seal-written', path: f.sealPath })
    const retries: ThreadMemoryRetryEvent[] = [
      { type: 'append-retry-started', key: f.a.key }, { type: 'read-retry-started', key: f.a.key },
      { type: 'seal-retry-started' }, { type: 'seal-written-after-retries', attempts: 1 },
      { type: 'retry-cancelled', series: 'append', key: f.a.key, why: 'teardown' },
      { type: 'retry-cancelled', series: 'read', key: f.a.key, why: 'removal' },
      { type: 'retry-cancelled', series: 'seal', why: 'shutdown' },
    ]
    for (const event of retries) f.reporter.retryEvent(event)
    expect(f.requests).toEqual([]); expect(f.logs).toEqual([])
  })

  test('whole-memory notices read all current channels anew, including at recovery', () => {
    const f = fixture()
    f.channels.set(f.a.key, [C.primary, C.secondary])
    f.reporter.threadMemoryEvent(f.append())
    expect(f.requests.at(-1)!.text).toBe(buildThreadMemoryNotSavedNotice(f.ref(), [C.primary, C.secondary], f.path, 'journal-append', failure()))
    expect(f.logs.at(-1)).toBe(buildThreadMemoryNotSavedLine(f.a.key, [C.primary, C.secondary], f.path, 'journal-append', failure()))
    f.channels.set(f.a.key, [C.secondary])
    f.reporter.threadMemoryEvent(f.unreadable())
    expect(f.requests.at(-1)!.text).toBe(buildThreadMemoryUnreadableNotice(f.ref(), [C.secondary], f.path))
    expect(f.logs.at(-1)).toBe(buildThreadMemoryUnreadableLine(f.a.key, [C.secondary], f.path, failure()))
    f.channels.set(f.a.key, [])
    f.reporter.threadMemoryEvent(f.saved())
    expect(f.requests.at(-1)!.text).toBe(buildThreadMemoryRecoveredNotice(f.ref(), []))
    expect(f.logs.at(-1)).toBe(buildThreadMemoryRecoveredLine(f.a.key, []))
    f.channels.set(f.a.key, [C.primary])
    f.reporter.startupFindings([{ key: f.a.key, case: 'journal-changed', wording: 'changed' }])
    expect(f.requests.at(-1)!.text).toBe(buildThreadMemoryChangedWhileStoppedNotice(f.ref(), [C.primary], 'changed'))
    expect(f.logs.at(-1)).toBe(buildThreadMemoryChangedWhileStoppedLine(f.a.key, [C.primary], 'journal-changed', 'changed'))
  })

  test.each(['submitted', 'open'] as const)('%s teardown suppresses every key event; a later life starts fresh', state => {
    const f = fixture()
    f.reporter.threadMemoryEvent(f.append())
    f.episodes.forget(f.a.key)
    f.notifier.notifier.submitTeardown(f.a.key)
    if (state === 'open') f.notifier.notifier.openTeardownWindow(f.a)
    const priorRequests = [...f.requests], priorLogs = [...f.logs]
    f.reporter.threadMemoryEvent(f.append()); f.reporter.threadMemoryEvent(f.unreadable())
    f.reporter.threadMemoryEvent(f.quarantined()); f.reporter.threadMemoryEvent(f.saved())
    f.reporter.threadMemoryEvent(f.settled(), healthy())
    f.reporter.holdsEvent(withdraw(f))
    f.reporter.lookupEvent(lostLookup(f))
    f.reporter.retryEvent({ type: 'journal-missing-on-retry', key: f.a.key })
    f.reporter.startupFindings([{ key: f.a.key, case: 'unclean-stop', wording: 'unclean' }])
    f.reporter.sealEvent({ type: 'changed-while-stopped', key: f.a.key, case: 'journal-changed', wording: 'changed' })
    expect(f.requests).toEqual(priorRequests); expect(f.logs).toEqual(priorLogs)
    if (state === 'open') f.notifier.notifier.closeTeardownWindow(f.a.key)
    f.notifier.notifier.settleTeardown(f.a.key)
    f.reporter.threadMemoryEvent(f.append())
    expect(f.requests).toHaveLength(2); expect(f.logs).toHaveLength(2)
    f.reporter.lookupEvent(lostLookup(f))
    expect(f.requests).toHaveLength(3); expect(f.logs).toHaveLength(3)
  })

  test('CR4: closed episodes suppress normal reporter observations, including late failed and unsynced seals', () => {
    const f = fixture()
    f.reporter.threadMemoryEvent(f.append()); f.episodes.close()
    const requests = [...f.requests], logs = [...f.logs]
    f.reporter.threadMemoryEvent(f.append()); f.reporter.threadMemoryEvent(f.unreadable())
    f.reporter.threadMemoryEvent(f.saved()); f.reporter.threadMemoryEvent(f.quarantined())
    f.reporter.threadMemoryEvent(f.settled(), healthy())
    f.reporter.threadMemoryEvent({ type: 'compaction-failed', key: f.a.key, path: f.path, step: 'journal-rewrite', error: failure() })
    f.reporter.holdsEvent(withdraw(f)); f.reporter.holdsEvent({ type: 'resolution-failed', key: f.a.key, error: failure() })
    f.reporter.lookupEvent(lostLookup(f))
    f.reporter.retryEvent({ type: 'journal-missing-on-retry', key: f.a.key })
    f.reporter.retryEvent({ type: 'saved-after-retries', key: f.a.key, attempts: 1 })
    const finding: ThreadMemorySealFinding = { key: f.a.key, case: 'unclean-stop', wording: 'unclean' }
    f.reporter.startupFindings([finding]); f.reporter.sealEvent({ type: 'changed-while-stopped', ...finding })
    const sealEvents: ThreadMemorySealEvent[] = [
      { type: 'seal-read-failed', path: f.sealPath, error: failure() },
      { type: 'seal-invalid', path: f.sealPath, error: failure() },
      ...[false, true].map(unsynced => ({ type: 'seal-write-failed' as const, path: f.sealPath, error: failure(), unsynced })),
    ]
    for (const event of sealEvents) f.reporter.sealEvent(event)
    expect(f.requests).toEqual(requests); expect(f.logs).toEqual(logs)
    // The server's failed writeShutdown result owns its final diagnostic; this
    // standalone observer must not claim it or resurrect a notice episode.
    expect(f.episodes.isOpen(f.a.key, THREAD_MEMORY_NOT_SAVED)).toBe(false)
  })

  test.each(['sink', 'async-sink', 'log', 'persona', 'channels', 'outage'] as const)('%s failures never escape to the event producer', async dependency => {
    const f = fixture()
    if (dependency === 'outage') f.reporter.threadMemoryEvent(f.unreadable())
    f.throws.add(dependency)
    expect(() => f.reporter.threadMemoryEvent(dependency === 'outage' ? f.saved() : f.append())).not.toThrow()
    expect(() => f.reporter.threadMemoryEvent(f.settled())).not.toThrow()
    for (const kind of ['compaction', 'seal', 'resolution'] as const) {
      const op = operation(f, kind)
      expect(() => { op.fail(failure()); op.complete() }).not.toThrow()
    }
    expect(() => f.reporter.holdsEvent(privateFields({ type: 'release-failed', key: f.a.key, seq: 1, error: failure() }))).not.toThrow()
    expect(() => f.reporter.holdsEvent(withdraw(f))).not.toThrow()
    expect(() => f.reporter.lookupEvent(lostLookup(f))).not.toThrow()
    expect(() => f.reporter.startupFindings([{ key: f.a.key, case: 'unclean-stop', wording: 'unclean' }])).not.toThrow()
    await f.clock.flush()
    f.throws.clear(); f.episodes.forget(f.a.key)
    const before = f.requests.length
    f.reporter.threadMemoryEvent(f.append())
    expect(f.requests).toHaveLength(before + 1)
    f.reporter.lookupEvent(lostLookup(f))
    expect(f.requests).toHaveLength(before + 2)
  })

  test.each(['saved', 'settled'] as const)('one key recovers via %s and forgets without changing its sibling episodes', recovery => {
    const f = fixture()
    for (const key of [f.a.key, f.b.key]) { f.reporter.threadMemoryEvent(f.append(key)); f.reporter.threadMemoryEvent(f.unreadable(key)) }
    f.outages.set(f.b.key, { ...healthy(), unsaved: 1 })
    f.reporter.threadMemoryEvent(f[recovery](f.a.key)); f.episodes.forget(f.a.key)
    f.reporter.threadMemoryEvent(f.append(f.b.key)); f.reporter.threadMemoryEvent(f[recovery](f.b.key))
    expect(f.requests.filter(p => p.key === f.b.key)).toHaveLength(2)
    expect(f.episodes.isOpen(f.b.key, THREAD_MEMORY_NOT_SAVED)).toBe(true)
    expect(f.episodes.isOpen(f.b.key, THREAD_MEMORY_UNREADABLE)).toBe(true)
    f.outages.set(f.b.key, healthy()); f.reporter.threadMemoryEvent(f[recovery](f.b.key))
    expect(f.requests.filter(p => p.key === f.b.key).map(p => p.text).slice(2)).toEqual([buildThreadMemoryRecoveredNotice(f.ref(f.b.key), [C.primary])])
    f.reporter.threadMemoryEvent(f.append(f.a.key))
    expect(f.requests.filter(p => p.key === f.a.key)).toHaveLength(4)
  })
})

describe('CR5/CR6 configured fields through the reporter and notifier', () => {
  test.each([true, false])('preserves configured identity and paths while redacting errors; validated=%s', async validated => {
    const name = fakeToken(BOT_TOKEN_PREFIX, 'configured-persona'), f = fixture(name, validated)
    const pathToken = fakeToken(BOT_TOKEN_PREFIX, 'configured-store')
    const storeDir = join(f.dir, pathToken, '<&> "quoted" \\\n\u2028\u2029')
    const path = threadPath(storeDir, f.a.key), sealPath = threadSealPath(storeDir), quarantinePath = `${path}.quarantine`
    f.configuredPaths.push(path, sealPath, quarantinePath)
    const external = join(f.dir, fakeToken(BOT_TOKEN_PREFIX, 'error-only-path'), 'private')
    // Even the configured path must be redacted when quoted inside an error;
    // its separate structured field is the only permitted occurrence.
    const error = Object.assign(failure(), { message: `open ${JSON.stringify(path)}; external ${JSON.stringify(external)}; ${sentinelInMessage('reporter-error')}` })
    const originalPersona = structuredClone(f.a)
    f.reporter.threadMemoryEvent({ type: 'append-failed', key: f.a.key, path, step: 'journal-append', error, noticeOnly: false })
    f.reporter.threadMemoryEvent({ type: 'read-failed', key: f.a.key, path, error })
    f.reporter.threadMemoryEvent(f.settled(), healthy())
    f.reporter.startupFindings([{ key: f.a.key, case: 'unclean-stop', wording: 'unclean' }])
    f.episodes.forget(f.a.key)
    f.reporter.sealEvent({ type: 'changed-while-stopped', key: f.a.key, case: 'journal-changed', wording: 'changed' })
    const bodies = [
      buildThreadMemoryNotSavedNotice(f.ref(), [C.primary], path, 'journal-append', error),
      buildThreadMemoryUnreadableNotice(f.ref(), [C.primary], path),
      buildThreadMemoryRecoveredNotice(f.ref(), [C.primary]),
      buildThreadMemoryChangedWhileStoppedNotice(f.ref(), [C.primary], 'unclean'),
      buildThreadMemoryChangedWhileStoppedNotice(f.ref(), [C.primary], 'changed'),
    ]
    expect(f.requests.map(p => p.text)).toEqual(bodies)
    expect(f.logs).toEqual([
      buildThreadMemoryNotSavedLine(f.a.key, [C.primary], path, 'journal-append', error),
      buildThreadMemoryUnreadableLine(f.a.key, [C.primary], path, error),
      buildThreadMemoryRecoveredLine(f.a.key, [C.primary]),
      buildThreadMemoryChangedWhileStoppedLine(f.a.key, [C.primary], 'unclean-stop', 'unclean'),
      buildThreadMemoryChangedWhileStoppedLine(f.a.key, [C.primary], 'journal-changed', 'changed'),
    ])
    // Exercise the remaining structured paths through typed producer events,
    // without duplicating the catalogue's exhaustive builder matrix.
    f.reporter.threadMemoryEvent({ ...f.quarantined(true), quarantinePath })
    f.reporter.threadMemoryEvent({ type: 'compaction-failed', key: f.a.key, path, step: 'journal-rewrite', error })
    f.reporter.threadMemoryEvent({ type: 'removal-failed', key: f.a.key, path, step: 'journal-unlink', error })
    f.reporter.sealEvent({ type: 'seal-read-failed', path: sealPath, error })
    f.reporter.sealEvent({ type: 'seal-write-failed', path: sealPath, error, unsynced: true })
    expect(f.logs.slice(5)).toEqual([
      buildThreadMemoryQuarantinedLine(f.a.key, quarantinePath, 1, 1),
      buildThreadMemoryCompactionFailedLine(f.a.key, path, 'journal-rewrite', error),
      buildThreadMemoryRemovalFailedLine(f.a.key, path, 'journal-unlink', error),
      buildThreadMemorySealUnreadableLine(sealPath, error),
      buildThreadMemorySealNotSavedLine(sealPath, error, true),
    ])
    const pathLines = [f.logs[0]!, f.logs[1]!, ...f.logs.slice(5)]
    for (const [index, line] of pathLines.entries()) {
      const configured = [path, path, quarantinePath, path, path, sealPath, sealPath][index]!
      const field = `path=${quotedPath(configured)}`
      expect(line).toContain(field)
      expect(line.split(pathToken)).toHaveLength(2)
      expect(line).not.toMatch(/[\r\n\u2028\u2029]/)
      assertNoLeak(withoutName(line.replace(field, '<configured-path>'), name, f.a.key))
    }
    f.reporter.threadMemoryEvent({ type: 'compacted', key: f.a.key, path, outcome: 'skipped' })
    f.reporter.sealEvent({ type: 'seal-written', path: sealPath })
    f.reporter.holdsEvent({ type: 'resolution-failed', key: f.a.key, error })
    f.reporter.holdsEvent({ type: 'resolution-saved', key: f.a.key })
    expect(f.logs.slice(-4)).toEqual([
      buildThreadMemoryCompactionRecoveredLine(f.a.key, path), buildThreadMemorySealSavedLine(sealPath),
      buildThreadMemoryHoldsNotResolvedLine(f.a.key, error), buildThreadMemoryHoldsResolvedLine(f.a.key),
    ])
    if (!validated) {
      expect(f.notifier.posts(f.a.key)).toEqual([])
      f.notifier.validate(f.a.key); await f.notifier.notifier.flush(f.a.key)
    }
    await f.clock.flush()
    const posts = f.notifier.posts(f.a.key)
    expect(posts).toEqual(bodies.map(text => ({ channel: C.primary, text: formatPersonaNotice(f.a, text), metadata: SERVER_POST_METADATA })))
    const ref = escapeSlackControlCharacters(renderPersonaRef(name, f.a.key))
    for (const { text } of posts) {
      expect(text.startsWith(`Persona ${ref}: `)).toBe(true)
      expect(text.split(ref)).toHaveLength(3)
      expect(text.replace(/&(amp|lt|gt);/g, '')).not.toMatch(/[&<>]/)
    }
    for (const { text } of posts.slice(0, 2)) {
      const rendered = escapeSlackControlCharacters(quotedPath(path))
      expect(text).toContain(rendered)
      expect(text.split(pathToken)).toHaveLength(2)
      assertNoLeak(withoutName(text.replace(rendered, '<configured-path>'), name, f.a.key))
    }
    expect(f.a).toEqual(originalPersona)
  })
})

describe('CR2 observation-time readiness', () => {
  test('a real read-failed/read-with-unsaved/append-failed/saved sequence replays exactly like live consumption', async () => {
    const live = fixture(), delayed = fixture(), key = live.a.key
    const io = threadFsControls(live.dir), snapshots: Array<{ event: ThreadMemoryEvent; outage: ThreadMemoryOutage }> = []
    seedThreads(live.dir, [threadHeader(), joinRecord(threadJoin())], key)
    const memory = createThreadMemory({ stateDir: live.dir, fs: io.fs, now: live.clock.now,
      appliedKeys: () => [key], stamp: () => ({ kind: 'decided', ...THREAD_STAMP, delivery: 'thread_hybrid' }),
      threadHybridChannels: () => [C.primary], markerKeys: () => [key],
      setCreated: () => ({ kind: 'saved' }), clearCreated: () => ({ kind: 'saved' }),
      onEvent(event) {
        const outage = { ...memory.outage(key) }
        snapshots.push({ event, outage }); live.reporter.threadMemoryEvent(event, outage)
      },
    })
    cleanups.push(() => memory.stop())
    io.fail('readFileSync', key); memory.readAtStart(); await memory.activate()
    expect(memory.addJoin(key, threadJoin({ root: R.secondary }))).toBe(true)
    io.heal(); expect(await memory.retryRead(key)).toBe('read')
    io.fail('writeSync', key); expect((await memory.flush(key)).kind).toBe('failed')
    io.heal(); expect((await memory.flush(key)).kind).toBe('saved')
    expect(snapshots.map(s => s.event.type)).toEqual(['read-failed', 'read', 'append-failed', 'saved-after-failure'])
    expect(snapshots[1]!.outage).toEqual({ unknown: false, unsaved: 1, missing: false })
    expect(memory.outage(key)).toEqual(healthy())
    delayed.deps.outage = () => memory.outage(key)
    for (const { event, outage } of snapshots) delayed.reporter.threadMemoryEvent(event, outage)
    expect(delayed.requests).toEqual(live.requests)
    expect(delayed.logs).toEqual(live.logs)
    expect(delayed.requests.map(p => p.text)).toEqual([
      buildThreadMemoryUnreadableNotice(live.ref(), [C.primary], live.path),
      buildThreadMemoryNotSavedNotice(live.ref(), [C.primary], live.path, 'journal-append', snapshots[2]!.event.type === 'append-failed' ? snapshots[2]!.event.error : undefined),
      buildThreadMemoryRecoveredNotice(live.ref(), [C.primary]),
    ])
    await live.clock.flush(); await delayed.clock.flush()
    expect(delayed.notifier.posts(key)).toEqual(live.notifier.posts(key))
  })

  test.each(['read', 'saved-after-failure', 'outage-settled', 'read-after-retries', 'saved-after-retries'] as const)('%s replay honors its own snapshot even when the current store disagrees', type => {
    const f = fixture()
    const replay = (outage: ThreadMemoryOutage) => {
      if (type === 'read-after-retries' || type === 'saved-after-retries') f.reporter.retryEvent({ type, key: f.a.key, attempts: 1 }, outage)
      else f.reporter.threadMemoryEvent({ type, key: f.a.key, path: f.path, firstSuccessfulRead: true }, outage)
    }
    f.reporter.threadMemoryEvent(f.unreadable()); f.reporter.threadMemoryEvent(f.append())
    replay({ ...healthy(), unsaved: 1 })
    expect(f.requests).toHaveLength(2)
    f.outages.set(f.a.key, { unknown: true, unsaved: 1, missing: false })
    replay(healthy()); replay(healthy())
    expect(f.requests.map(p => p.text).slice(2)).toEqual([buildThreadMemoryRecoveredNotice(f.ref(), [C.primary])])
    expect(f.logs.slice(2)).toEqual([buildThreadMemoryRecoveredLine(f.a.key, [C.primary])])
  })
})

// The catalogue owns literal prose. Build the unbounded expected text from
// small, fitting production fragments, independently of the overflow branch.
function completeLossText(persona: { name: string; key: string }, loss: ThreadMemoryLoss, displayName = persona.name) {
  const seed = { name: 'reference', key: persona.key }
  const ref = escapeSlackControlCharacters(renderPersonaRef(displayName, persona.key))
  const base = buildThreadMemoryJoinsLostNotice(seed, { threads: [], messages: [], unreadableLines: loss.unreadableLines })
  const heading = base.text.replace(base.options.personaRef, ref)
  const lines = [
    ...loss.threads.map(t => buildThreadMemoryJoinsLostNotice(seed, { threads: [t], messages: [] }).text.split('\n')[1]!),
    ...loss.messages.map(m => buildThreadMemoryJoinsLostNotice(seed, { threads: [], messages: [m] }).text.split('\n')[1]!),
    ...(loss.ownPosts ?? []).flatMap(post => (post.threads.length ? post.threads.map(root => [root]) : [[]]).map(threads =>
      buildThreadMemoryJoinsLostNotice(seed, { threads: [], messages: [], ownPosts: [{ ...post, threads }] }).text.split('\n')[1]!,
    )),
  ]
  return formatPersonaNotice(persona, [heading, ...lines].join('\n'), { personaRef: ref })
}
async function checkLossDelivery(name: string, rows: WithdrawnMemoryHold[], displayName: string, validated = true) {
  const f = fixture(name, validated), loss = holdLoss(rows), before = structuredClone(f.a)
  f.reporter.holdsEvent(withdraw(f, rows))
  if (!validated) {
    expect(f.notifier.posts(f.a.key)).toEqual([])
    f.notifier.validate(f.a.key); await f.notifier.notifier.flush(f.a.key)
  }
  await f.clock.flush()
  const posts = f.notifier.posts(f.a.key)
  expect(posts).toHaveLength(1)
  expect(posts[0]!.channel).toBe(C.primary)
  const actual = posts[0]!.text, ref = escapeSlackControlCharacters(renderPersonaRef(displayName, f.a.key))
  expect(actual.length).toBeLessThanOrEqual(THREAD_MEMORY_NOTICE_MAX_CHARS)
  expect(actual.startsWith(`Persona ${ref}: `)).toBe(true)
  expect(actual.split(ref)).toHaveLength(3) // the same reference in prefix and body
  expect(actual).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
  expect(actual.replace(/&(amp|lt|gt);/g, '')).not.toMatch(/[&<>]/)
  expect(f.logs).toEqual([buildThreadMemoryJoinsLostLine(f.a, loss)])
  expect(f.logs[0]).toContain(renderPersonaRef(name, f.a.key))
  for (const row of rows) {
    expect(f.logs[0]).toContain(`channel=${row.channel} root=${row.thread_ts}`)
    expect(f.logs[0]).toContain(`channel=${row.channel} ts=${row.ts}`)
  }
  expect(f.a).toEqual(before)
  expect(f.a.key).toBe(personaKey(name))
  return { f, actual, loss }
}

describe('CR3 full escaped Joins lost payload through episodes and notifier', () => {
  test.each(['Ops team', 'Ops <north> & "backup" \\ 🐝'])('ordinary fitting name %s is preserved byte for byte', async name => {
    const { f, actual, loss } = await checkLossDelivery(name, holds(), name)
    expect(Buffer.from(actual)).toEqual(Buffer.from(completeLossText(f.a, loss)))
  })

  // Private excerpt size is specified by the MI/SRD exception, not a public API.
  const excerpt = (name: string) => Array.from(name).slice(0, 64).join('') + '…'
  test('a lookup overflow held until validation keeps its budget, loss count and uncapped log', async () => {
    const name = 'Ops <&> 🐝 '.repeat(200), f = fixture(name, false), before = structuredClone(f.a)
    const event = lostLookup(f, { threads: holds(160).map(row => row.thread_ts) }), loss = lookupLoss(event)
    f.reporter.lookupEvent(event)
    expect(f.requests).toHaveLength(1)
    expect(f.notifier.posts(f.a.key)).toEqual([])
    f.notifier.validate(f.a.key); await f.notifier.notifier.flush(f.a.key); await f.clock.flush()
    const posts = f.notifier.posts(f.a.key)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.channel).toBe(C.primary)
    const actual = posts[0]!.text, complete = completeLossText(f.a, loss, excerpt(name)).split('\n')
    const lines = actual.split('\n'), footer = lines.pop()!
    expect(actual.length).toBeLessThanOrEqual(THREAD_MEMORY_NOTICE_MAX_CHARS)
    expect(actual).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
    expect(actual.replace(/&(amp|lt|gt);/g, '')).not.toMatch(/[&<>]/)
    expect(lines).toEqual(complete.slice(0, lines.length))
    expect(lines.length).toBeGreaterThan(1)
    const omitted = event.threads.length - (lines.length - 1)
    expect(omitted).toBeGreaterThan(0)
    expect(footer).toMatch(new RegExp(`^${omitted} more thread/message entry\\(s\\);.*server log.*identifiers\\.$`))
    expect(f.logs).toEqual([buildThreadMemoryJoinsLostLine(f.a, loss)])
    expect(f.logs[0]!.length).toBeGreaterThan(THREAD_MEMORY_NOTICE_MAX_CHARS)
    expect(f.logs[0]).toContain(renderPersonaRef(name, f.a.key))
    expect(f.logs[0]).toContain(`channel=${event.channel} threads=${JSON.stringify(event.threads)} cause=${event.cause}`)
    expect(f.a).toEqual(before)
  })

  test('names immediately below and above the full-payload threshold choose the correct branch', async () => {
    const rows = holds(), loss = holdLoss(rows), seedName = 'A'.repeat(100)
    const seed = { name: seedName, key: personaKey(seedName) }
    const overhead = completeLossText(seed, loss).length - seedName.length * 2
    const belowName = 'A'.repeat(Math.floor((THREAD_MEMORY_NOTICE_MAX_CHARS - overhead) / 2))
    const aboveName = belowName + 'A'
    const below = await checkLossDelivery(belowName, rows, belowName)
    expect(THREAD_MEMORY_NOTICE_MAX_CHARS - completeLossText(below.f.a, loss).length).toBeLessThan(2)
    expect(below.actual).toBe(completeLossText(below.f.a, loss))
    const above = await checkLossDelivery(aboveName, rows, excerpt(aboveName))
    expect(completeLossText(above.f.a, loss).length).toBeGreaterThan(THREAD_MEMORY_NOTICE_MAX_CHARS)
    expect(completeLossText(above.f.a, loss).length - THREAD_MEMORY_NOTICE_MAX_CHARS).toBeLessThanOrEqual(2)
    expect(above.actual).toBe(completeLossText(above.f.a, loss, excerpt(aboveName)))
  })

  test.each([true, false])('a 2,100-character name uses the exact excerpt; validated=%s preserves options', async validated => {
    const name = 'N'.repeat(2100), { f, actual, loss } = await checkLossDelivery(name, holds(), excerpt(name), validated)
    expect(completeLossText(f.a, loss).length).toBeGreaterThan(THREAD_MEMORY_NOTICE_MAX_CHARS)
    expect(actual).toBe(completeLossText(f.a, loss, excerpt(name)))
  })

  test('Slack escaping alone crosses the threshold, and the excerpt keeps whole entities and a boundary surrogate pair', async () => {
    const name = 'A'.repeat(61) + '<&🐝' + '<&>'.repeat(200)
    const { f, actual, loss } = await checkLossDelivery(name, holds(), excerpt(name))
    const unescaped = completeLossText(f.a, loss).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    expect(unescaped.length).toBeLessThan(THREAD_MEMORY_NOTICE_MAX_CHARS)
    expect(completeLossText(f.a, loss).length).toBeGreaterThan(THREAD_MEMORY_NOTICE_MAX_CHARS)
    expect(excerpt(name)).toBe('A'.repeat(61) + '<&🐝…')
    expect(actual).toBe(completeLossText(f.a, loss, excerpt(name)))
  })

  test('step 4 retains complete ordered identifiers and fixed advice, counts every omitted entry, and logs everything', async () => {
    const name = 'Escaped <&> name 🐝 '.repeat(120), rows = holds(120)
    const { f, actual, loss } = await checkLossDelivery(name, rows, excerpt(name), false)
    const unbounded = completeLossText(f.a, loss, excerpt(name)).split('\n')
    const delivered = actual.split('\n'), footer = delivered.pop()!
    expect(delivered[0]).toBe(unbounded[0]) // all fixed advice, both references included
    expect(delivered.slice(1)).toEqual(unbounded.slice(1, delivered.length))
    expect(delivered.length).toBeGreaterThan(1)
    const omitted = unbounded.length - delivered.length
    expect(omitted).toBeGreaterThan(0)
    expect(footer).toMatch(new RegExp(`^${omitted} more thread/message entry\\(s\\);.*server log.*identifiers\\.$`))
    expect(delivered.length - 1 + omitted).toBe(loss.threads.length + loss.messages.length)
    // Counting only the body, or forgetting the footer budget, exceeds the cap.
    expect(actual.length).toBeLessThanOrEqual(THREAD_MEMORY_NOTICE_MAX_CHARS)
    expect(f.logs[0]!.length).toBeGreaterThan(THREAD_MEMORY_NOTICE_MAX_CHARS)
  })

  test('identifier overflow with an ordinary name uses the same prescribed excerpt and retains the unreadable count', async () => {
    const f = fixture('Ops'), rows = holds(140)
    const facts: ThreadMemoryQuarantineFact[] = rows.map((row, i) => ({
      line: i + 2, invalidFinalLine: false, channel: C.secondary, root: row.thread_ts,
    }))
    facts.push({ line: 142, invalidFinalLine: false })
    const event: ThreadMemoryEvent = { ...f.quarantined(), facts }
    const loss: ThreadMemoryLoss = { threads: facts.slice(0, -1).map(({ channel, root }) => ({ channel: channel!, root: root! })), messages: [], unreadableLines: 1 }
    f.reporter.threadMemoryEvent(event); await f.clock.flush()
    const actual = f.notifier.posts(f.a.key)[0]!.text
    const complete = completeLossText(f.a, loss, excerpt(f.a.name)).split('\n')
    const lines = actual.split('\n'), footer = lines.pop()!
    expect(lines[0]).toBe(complete[0])
    expect(lines.slice(1)).toEqual(complete.slice(1, lines.length))
    expect(footer).toMatch(new RegExp(`^${complete.length - lines.length} more thread/message entry\\(s\\);.*server log.*identifiers\\.$`))
    expect(actual.length).toBeLessThanOrEqual(THREAD_MEMORY_NOTICE_MAX_CHARS)
    expect(f.logs.at(-1)).toBe(buildThreadMemoryJoinsLostLine(f.a, loss))
    expect(f.logs.at(-1)).toContain(renderPersonaRef(f.a.name, f.a.key))
    for (const { channel, root } of loss.threads) expect(f.logs.at(-1)).toContain(`channel=${channel} root=${root}`)
  })
})
