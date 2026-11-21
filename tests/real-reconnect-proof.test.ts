import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertReconnectProof } from './integration/fixtures/real-case-assertions.ts'
import { runFixture } from './test-helpers/test33-receipt-boundary.ts'

// test-37's reconnect proofs. Case 4 (gate held) accepts the native client's
// own MCP re-init as well as a typed reconnect: b.88t decision 7, a proof
// change the user approved. Every condition fails closed. The native fixture is
// the r37a timeline (j20261121034227-697b5f server.log and transcript); the hold
// start (the consumed Enter-delay fault) is placed just before the 5 s hold that
// ended in item 3's delivery at 53.978.
const at = (clock: string) => Date.parse(`2026-11-21T03:${clock}Z`)
const KEY = 'mcp', ITEM = '<channel>gate held second</channel>', RECONNECT = '/mcp reconnect slack-channel-router'
const HOLD = at('44:48.950'), RELEASE = HOLD + 5000, TEXT = at('45:01.300')
type Call = { at: number; pid?: string; words: string[] }
const call = (when: number, text: string): Call => ({ at: when, pid: String(when), words: ['send-keys', '--instance-id', 'cscb_' + KEY, '--text', text, '--no-enter'] })
const line = (clock: string, body: string) => `[2026-11-21T03:${clock}Z] [slack] ${body}`
const connected = (clock: string, key = KEY) => line(clock, `Session connected: persona "${key}" (key=${key}) cwd="/tmp/t/work/${key}"`)
const cscbReconnect = (clock: string) => line(clock, `reconnecting MCP server "slack-channel-router": persona=${KEY}`)
const r37aLog = [
  line('44:47.393', `dispatch: persona="mcp" (key=mcp) source=slack chat_id="D0MCP" ts="1795232687.266663" sender_id="U0MCP" text="gate held first"`),
  line('44:48.004', 'test-only MCP drop: persona=mcp'),
  line('44:48.004', `Session disconnected: persona "mcp" (key=mcp) cwd="/tmp/t/work/mcp"`),
  line('44:48.005', 'Scheduling restart for persona=mcp in 60s (backoff)'),
  line('44:53.978', `message-delivered: persona="mcp" (key=mcp) source=slack chat_id="D0MCP" ts="1795232687.266663" sender_id="U0MCP" at=1795232693978 wait_ms=6674`),
  line('44:55.701', 'Session "0741bac2-ac7e-42ef-9fba-3c4d11d22c66" initialized'),
  connected('44:55.752'),
  line('45:01.251', `dispatch: persona="mcp" (key=mcp) source=slack chat_id="D0MCP" ts="1795232688.006546" sender_id="U0MCP" text="gate held second"`),
]
// Cases 1 and 2's typed reconnects, both before the hold.
const earlier = [call(at('44:31.000'), RECONNECT), call(at('44:33.000'), RECONNECT)]
const r37aCalls = () => [...earlier, call(TEXT, ITEM)]
// `null` is an ungated case (no hold start argument).
const prove = (calls: Call[], log: string[], hold: number | null = HOLD, after = RELEASE, key = KEY) =>
  assertReconnectProof(ITEM, calls, log, key, after, hold ?? undefined)
const reason = (f: () => unknown) => { try { f() } catch (e) { return (e as Error).message } return 'accepted' }

describe('gate-held reconnect proof (case 4)', () => {
  test('typed reconnect after the release passes as before and records the typed path', () => {
    const calls = [...earlier, call(RELEASE + 1000, RECONNECT), call(TEXT, ITEM)]
    expect(prove(calls, r37aLog)).toEqual({ path: 'typed', at: RELEASE + 1000, sent: TEXT })
  })
  test('r37a: native re-init after the release, no typed or CSCB reconnect, passes as the native path', () => {
    expect(prove(r37aCalls(), r37aLog)).toEqual({ path: 'native', at: at('44:55.752'), sent: TEXT })
  })
  test('a reconnect typed inside the hold fails on both paths, even with a later typed one', () => {
    const inside = call(HOLD + 2000, RECONNECT)
    expect(reason(() => prove([...r37aCalls(), inside], r37aLog))).toBe('MCP reconnect typed inside the gate hold')
    expect(reason(() => prove([...earlier, inside, call(RELEASE + 1000, RECONNECT), call(TEXT, ITEM)], r37aLog)))
      .toBe('MCP reconnect typed inside the gate hold')
    expect(reason(() => prove([...r37aCalls(), call(HOLD, RECONNECT)], r37aLog))).toBe('MCP reconnect typed inside the gate hold')
  })
  test('a typed reconnect with no usable time counts as inside the hold', () => {
    expect(reason(() => prove([...r37aCalls(), call(NaN, RECONNECT)], r37aLog))).toBe('MCP reconnect typed inside the gate hold')
  })
  test('a CSCB reconnect line in the window rejects the native path, stamped or not', () => {
    const rejected = 'native recovery window holds a CSCB MCP reconnect that was not typed'
    for (const extra of [cscbReconnect('44:49.500'), cscbReconnect('44:55.000'), cscbReconnect('45:01.000'),
      `[slack] reconnecting MCP server "slack-channel-router": persona=${KEY}`]) {
      expect(reason(() => prove(r37aCalls(), [...r37aLog, extra]))).toBe(rejected)
    }
    // Outside [hold start, text call) it is not this window's.
    expect(prove(r37aCalls(), [...r37aLog, cscbReconnect('44:33.000'), cscbReconnect('45:02.000')]).path).toBe('native')
  })
  test('the native connect must be stamped, for this key, after the release and before the text call', () => {
    const none = 'gate-held delivery has neither a typed reconnect nor a native MCP session reconnect after the hold'
    const without = r37aLog.filter(l => !l.includes('Session connected'))
    expect(reason(() => prove(r37aCalls(), without))).toBe(none)
    expect(reason(() => prove(r37aCalls(), [...without, connected('44:53.000')]))).toBe(none) // inside the hold
    expect(reason(() => prove(r37aCalls(), [...without, connected('45:01.300')]))).toBe(none) // not before the text
    expect(reason(() => prove(r37aCalls(), [...without, connected('45:05.000')]))).toBe(none)
    expect(reason(() => prove(r37aCalls(), [...without, connected('44:55.752', 'mcp2')]))).toBe(none)
    expect(reason(() => prove(r37aCalls(), [...without, `[slack] Session connected: persona "mcp" (key=mcp) cwd="/tmp/t"`]))).toBe(none)
    expect(reason(() => prove(r37aCalls(), [...without, line('44:55.752', 'Session "x" initialized')]))).toBe(none)
  })
  test('a typed reconnect only after the text call does not count', () => {
    expect(reason(() => prove([...r37aCalls(), call(TEXT + 1, RECONNECT)], r37aLog.filter(l => !l.includes('Session connected')))))
      .toBe('gate-held delivery has neither a typed reconnect nor a native MCP session reconnect after the hold')
  })
  test('an invalid hold interval, mark, key or missing delivery fails closed', () => {
    expect(reason(() => prove(r37aCalls(), r37aLog, NaN))).toBe('invalid gate hold interval')
    expect(reason(() => prove(r37aCalls(), r37aLog, RELEASE))).toBe('invalid gate hold interval')
    expect(reason(() => prove(r37aCalls(), r37aLog, -1))).toBe('invalid gate hold interval')
    expect(reason(() => prove(r37aCalls(), r37aLog, HOLD, NaN))).toBe('invalid reconnect mark')
    expect(reason(() => prove(r37aCalls(), r37aLog, HOLD, RELEASE, 'MCP'))).toBe('invalid reconnect key')
    expect(reason(() => prove(earlier, r37aLog))).toBe('delivery was not typed')
    expect(reason(() => prove([...earlier, call(NaN, ITEM)], r37aLog))).toBe('delivery was not typed')
    expect(reason(() => assertReconnectProof(undefined as unknown as string, r37aCalls(), r37aLog, KEY, RELEASE, HOLD))).toBe('reconnect target not fixed')
  })
})

describe('ungated reconnect proofs (cases 1, 2 and 5) still require a typed reconnect', () => {
  test('typed reconnect after the mark passes', () => {
    expect(prove([call(RELEASE + 10, RECONNECT), call(TEXT, ITEM)], r37aLog, null).path).toBe('typed')
    // Ungated, a reconnect before the mark is simply not counted (no hold check).
    expect(prove([call(RELEASE - 1, RECONNECT), call(RELEASE + 10, RECONNECT), call(TEXT, ITEM)], r37aLog, null).path).toBe('typed')
  })
  test('a native re-init alone fails, as do typed reconnects outside [mark, text call)', () => {
    const old = 'delivery preceded its reconnect or reconnect violated the hold interval'
    expect(reason(() => prove(r37aCalls(), r37aLog, null))).toBe(old)
    expect(reason(() => prove([call(RELEASE - 1, RECONNECT), call(TEXT, ITEM), call(TEXT + 1, RECONNECT)], r37aLog, null))).toBe(old)
  })
})

describe('reconnect-proof and reconnects CLI', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'reconnect-proof-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })
  function write(calls: Call[], log: string[]) {
    mkdirSync(join(home, 'queue'), { recursive: true })
    const journal = [
      { v: 1, kind: 'accepted', seq: 1, source: 'slack', text: 'gate held second', ts: '1795232688.006546', channel: 'D0MCP', user: 'U0MCP', received_at: at('44:48.046') },
      { v: 1, kind: 'fixed', seq: 1, parts: [ITEM] },
    ]
    writeFileSync(join(home, 'queue', `${KEY}.jsonl`), journal.map(r => JSON.stringify(r)).join('\n') + '\n')
    writeFileSync(join(home, 'server.log'), log.join('\n') + '\n')
    const quote = (w: string) => w.replace(/[\\ <>]/g, m => '\\' + m)
    writeFileSync(join(home, 'shim.log'), calls.map(c => ['call', c.at / 1000, c.pid, '1', 'bun', c.words.map(quote).join(' ')].join('\t')).join('\n') + '\n')
  }
  const cli = (...args: string[]) => runFixture('fixtures/real-case-assertions.ts', [args[0]!, home, KEY, join(home, 'shim.log'), join(home, 'projects'), ...args.slice(1)])
  test('case 4 records the native path; ungated use of the same evidence fails', async () => {
    write(r37aCalls(), r37aLog)
    const native = await cli('reconnect-proof', '1', String(RELEASE), String(HOLD))
    expect(native.out.join('\n')).toContain('recorded: native MCP session reconnect precedes item 1 after hold ')
    expect(native.code).toBe(0)
    const ungated = await cli('reconnect-proof', '1', String(RELEASE))
    expect(ungated.err).toEqual(['real-case-assertions: delivery preceded its reconnect or reconnect violated the hold interval'])
  })
  test('case 4 records the typed path and rejects a reconnect typed inside the hold', async () => {
    write([...earlier, call(RELEASE + 1000, RECONNECT), call(TEXT, ITEM)], r37aLog)
    const typed = await cli('reconnect-proof', '1', String(RELEASE), String(HOLD))
    expect(typed.out.join('\n')).toContain('recorded: MCP reconnect precedes item 1 after hold ' + RELEASE + ', none typed inside the hold from ' + HOLD)
    write([...earlier, call(HOLD + 10, RECONNECT), call(RELEASE + 1000, RECONNECT), call(TEXT, ITEM)], r37aLog)
    expect((await cli('reconnect-proof', '1', String(RELEASE), String(HOLD))).err).toEqual(['real-case-assertions: MCP reconnect typed inside the gate hold'])
    expect((await cli('reconnect-proof', '1', String(RELEASE), 'not-a-time')).err).toEqual(['real-case-assertions: invalid gate hold interval'])
  })
  test('reconnects requires 4 typed variants by default, 3 only when asked, and no other count', async () => {
    write(r37aCalls(), r37aLog) // 2 typed reconnects
    expect((await cli('reconnects')).err).toEqual(['real-case-assertions: not all MCP reconnect variants typed'])
    expect((await cli('reconnects', '3')).err).toEqual(['real-case-assertions: not all MCP reconnect variants typed'])
    for (const count of ['2', '5', 'x']) expect((await cli('reconnects', count)).err).toEqual(['real-case-assertions: invalid reconnect variant count'])
    write([...earlier, call(at('44:40.000'), RECONNECT), call(TEXT, ITEM)], r37aLog) // 3 typed
    expect((await cli('reconnects', '3')).code).toBe(0)
    expect((await cli('reconnects')).err).toEqual(['real-case-assertions: not all MCP reconnect variants typed'])
    write([...earlier, call(at('44:40.000'), RECONNECT), call(at('44:41.000'), RECONNECT), call(TEXT, ITEM)], r37aLog)
    expect((await cli('reconnects')).code).toBe(0)
  })
})
