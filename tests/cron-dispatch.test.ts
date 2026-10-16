/** Direct scheduled acceptance over the real queue and log: no HTTP or session dependency. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCronDispatcher, resolvePromptPath } from '../src/cron-dispatch.ts'
import { createCronLog } from '../src/cron-log.ts'
import { INTERJECT_BODY_CAP_BYTES } from '../src/interject.ts'
import type { CronSchedule } from '../src/crontable.ts'
import { resolvePersonaTarget } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeQueue } from './test-helpers/delivery-queue.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
let dir: string, queue: Awaited<ReturnType<typeof makeQueue>>, clock: ReturnType<typeof createFakeClock>
let config: ReturnType<typeof makeMultiPersonaConfig>, failures: Set<string>, attempts: string[], logs: string[]
let fire: ReturnType<typeof createCronDispatcher>['fire']
const timestamp = 1700000000123
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cron-queue-')); clock = createFakeClock({ start: timestamp }); queue = await makeQueue(dir, { now: clock.now }); config = makeMultiPersonaConfig([{ name: 'Planner' }, { name: 'reviewer' }], dir); failures = new Set(); attempts = []; logs = []
  fire = createCronDispatcher({ accept: async (key, input) => { attempts.push(key); return failures.has(key) ? { status: 'failed', error: new Error('EIO') } : queue.accept(key, input) }, now: clock.now, cronTablePath: join(dir, 'crontab'), resolveTarget: target => resolvePersonaTarget(config, target)?.key, cronLog: createCronLog(join(dir, 'cron.log')) }).fire
})
afterEach(async () => { assertNoLeak({ logs }); await queue.stop(); rmSync(dir, { recursive: true, force: true }) })
function prompt(text = 'prompt', name = 'prompt.md') { const path = join(dir, name); writeFileSync(path, text); return path }
function schedule(path: string, targets: string[] = ['Planner', 'reviewer'], identity = 'cscb-cron:test'): CronSchedule { return { identity, expression: '* * * * *', promptPath: path, targets: { kind: 'explicit', targets }, rawLine: '', lineNumber: 1 } }
function lines() { return readFileSync(join(dir, 'cron.log'), 'utf8').trim().split('\n').map(s => { const [at, identity, target, outcome, ...rest] = s.split(' '); return { at, identity, target, outcome, detail: rest.join(' ') } }) }
function texts(key: string) { return queue.items(key).map(i => i.accepted.text) }
test('each fire target is an independent durable item; fire-time reading also timestamps every log line', async () => {
  await fire(schedule(prompt()))
  expect(attempts).toEqual(config.personas.map(p => p.key))
  for (const p of config.personas) expect(queue.items(p.key).map(i => ({ source: i.accepted.source, sender: i.accepted.sender, text: i.accepted.text, received_at: i.accepted.received_at, ts: i.accepted.ts }))).toEqual([{ source: 'cron', sender: 'cscb-cron:test', text: 'prompt', received_at: timestamp, ts: '1700000000.123000' }])
  expect(lines().map(l => l.outcome)).toEqual(['queued', 'queued', 'summary']); expect(lines().at(-1)!.detail).toBe('queued=2 failed=0'); expect(new Set(lines().map(l => l.at))).toEqual(new Set([new Date(timestamp).toISOString()]))
})
test.each([0, 1])('failure of target %i does not block siblings or claim successful storage', async failing => {
  failures.add(config.personas[failing]!.key); await fire(schedule(prompt())); expect(attempts).toEqual(config.personas.map(p => p.key))
  for (const [i, p] of config.personas.entries()) expect(texts(p.key)).toEqual(i === failing ? [] : ['prompt'])
  expect(lines().slice(0, -1).map(l => l.outcome)).toEqual(failing === 0 ? ['queue-failed', 'queued'] : ['queued', 'queue-failed']); expect(lines().at(-1)!.detail).toBe('queued=1 failed=1')
})
test.each([[['Planner', 'Planner']], [['Planner', 'planner']], [['reviewer', 'reviewer']]])('dedupes aliases in one fire: %p', async targets => {
  const key = resolvePersonaTarget(config, targets[0]!)!.key
  // The hashed key is the valid alias for the capitalized name.
  if (targets[1] === 'planner') targets = [targets[0]!, key]
  await fire(schedule(prompt(), targets)); expect(attempts).toEqual([key]); expect(texts(key)).toEqual(['prompt']); for (const p of config.personas.filter(p => p.key !== key)) expect(texts(p.key)).toEqual([])
})
test('repeated fires never coalesce and read changed content fresh', async () => {
  const path = prompt('first'); const s = schedule(path, ['reviewer']); await fire(s); writeFileSync(path, 'second'); await fire(s); await fire(s)
  expect(texts('reviewer')).toEqual(['first', 'second', 'second']); expect(queue.items('reviewer').map(i => i.accepted.ts)).toEqual(['1700000000.123000', '1700000000.123001', '1700000000.123002']); expect(texts(config.personas[0]!.key)).toEqual([])
})
test('unknown target is logged and does not obstruct a configured target', async () => {
  await fire(schedule(prompt(), ['nobody', 'reviewer'])); expect(attempts).toEqual(['reviewer']); expect(lines().map(l => l.outcome)).toEqual(['unknown-persona', 'queued', 'summary']); expect(lines().at(-1)!.detail).toBe('queued=1 failed=1')
})
test.each(['missing', 'directory'] as const)('prompt %s produces one failure and no accepts', async type => {
  const path = join(dir, 'absent'); if (type === 'directory') mkdirSync(path)
  await fire(schedule(path)); expect(attempts).toEqual([]); expect(lines().map(l => l.outcome)).toEqual([type === 'missing' ? 'prompt-missing' : 'prompt-unreadable', 'summary']); expect(lines().at(-1)!.detail).toBe('queued=0 failed=2')
})
test.each([0, 1])('serialized body cap boundary +%i preserves UTF-8 and never truncates', async over => {
  const sender = 'cscb-cron:test', persona = 'reviewer', head = 'é'; const overhead = Buffer.byteLength(JSON.stringify({ persona, message: head, sender })); const message = head + 'x'.repeat(INTERJECT_BODY_CAP_BYTES - overhead + over)
  await fire(schedule(prompt(message), [persona], sender)); expect(attempts).toEqual(over ? [] : [persona]); expect(texts(persona)).toEqual(over ? [] : [message]); expect(lines()[0]!.outcome).toBe(over ? 'prompt-oversize' : 'queued')
})
test('all-bots remains deferred without accepting or reading a missing prompt', async () => {
  await fire({ ...schedule(join(dir, 'absent')), targets: { kind: 'all-bots' } }); expect(attempts).toEqual([]); expect(lines().map(l => l.outcome)).toEqual(['fanout-deferred', 'summary']); expect(lines().at(-1)!.detail).toBe('queued=0 failed=0')
})
test('relative prompt paths anchor to crontable directory and preserve bytes', async () => {
  prompt('one\n"two"\\🙂'); await fire(schedule('prompt.md', ['reviewer'])); expect(texts('reviewer')).toEqual(['one\n"two"\\🙂']); expect(resolvePromptPath('prompt.md', join(dir, 'crontab'))).toBe(join(dir, 'prompt.md'))
})
test('target resolution reads configuration anew at fire time', async () => {
  const path = prompt(); config = makeMultiPersonaConfig([{ name: 'reviewer' }], dir); await fire(schedule(path)); expect(attempts).toEqual(['reviewer']); expect(lines()[0]!.outcome).toBe('unknown-persona'); expect(texts('reviewer')).toEqual(['prompt'])
})
