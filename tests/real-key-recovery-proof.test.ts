import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertFirstLaunchWaiting, assertResetKeyRecovery, assertSameConversationReplyPermission, assertSwallowedEnterRecovery, assertUnknownKeyRecovery } from './integration/fixtures/real-case-assertions.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { cannedGetResult } from './test-helpers/agent-director-stub.ts'
import { makePersonaConfig } from './test-helpers/persona-config.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken } from './test-helpers/credentials.ts'
import { buildTemplateParams, REPLY_TOOL_ALLOW_RULE } from '../src/agent-director-template.ts'
import { REPLY_TOOL_PREALLOWED_LABEL } from '../src/reply-reminder.ts'
import { ENTER_DELAY_MS } from '../src/delivery-engine.ts'

const instance = 'cscb_control'
const fault = { at: 2000, pid: '2000', words: ['send-keys', 'key=Enter', 'swallow'] }
const key = (at: number, kind: 'enter' | 'text', id = instance) => ({
  at, pid: String(at), words: ['send-keys', '--instance-id', id, ...(kind === 'enter' ? ['--key', 'Enter'] : ['--text', 'message', '--no-enter'])],
})
const text = { kind: 'sent', seq: 1, part: 1, send_kind: 'text', session_id: 'native-session', at: 1000 }
const enter = { ...text, send_kind: 'enter', at: 12000 }
const fixed = { kind: 'fixed', seq: 1, parts: ['message'] }
function proveEnter(journal: any[], calls: Parameters<typeof assertSwallowedEnterRecovery>[1], faults: Parameters<typeof assertSwallowedEnterRecovery>[2]) {
  return assertSwallowedEnterRecovery([fixed, ...journal], [key(1000, 'text'), key(2000, 'enter'), ...calls], faults, 1, instance)
}

describe('same-conversation reply permission proof (b.pb8)', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'reply-permission-proof-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function rows(freshSystemPrompt = true) {
    const params = buildTemplateParams(makePersonaConfig({ system_prompt_mode: 'none', fresh_system_prompt: freshSystemPrompt }, home))
    assertNoLeak({ params })
    const before = cannedGetResult({ instance_id: instance, session_id: 'native-session', agent_args: params.agent_args })
    before.labels = { ...before.labels, ...Object.fromEntries([REPLY_TOOL_PREALLOWED_LABEL.split('=')]) }
    // Canned saved rows test the oracle; they do not simulate AD's resume policy.
    return { before, after: structuredClone(before) }
  }
  function prove(f: ReturnType<typeof rows>) {
    return assertSameConversationReplyPermission(f.before, f.after, instance, REPLY_TOOL_ALLOW_RULE)
  }
  function expectProofRejection(f: ReturnType<typeof rows>, message: string) {
    let failure: unknown
    try { prove(f) } catch (error) { failure = error }
    // Check the whole error, including its stack/cause/properties, before an assertion can print it.
    assertNoLeak({ error: failure })
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(message)
  }

  test.each([true, false])('accepts the actual template argument pair in the same saved conversation (snapshot=%s)', snapshot => {
    const f = rows(snapshot)
    expect(f.after.agent_args).toContain(REPLY_TOOL_ALLOW_RULE)
    expect(() => prove(f)).not.toThrow()
  })

  test.each([
    ['before', undefined], ['after', undefined],
    ['before', ''], ['after', ''],
    ['before', 'another-session'], ['after', 'another-session'],
  ] as const)('rejects %s session %s despite a valid saved pair', (side, session) => {
    const f = rows()
    Object.assign(f[side], { session_id: session })
    expectProofRejection(f, 'same native session')
  })

  test('rejects matching blank session identifiers', () => {
    const f = rows()
    f.before.session_id = f.after.session_id = ' \t'
    expectProofRejection(f, 'same native session')
  })

  test.each(['before', 'after'] as const)('rejects a different %s instance despite matching session and pair', side => {
    const f = rows()
    f[side].instance_id = 'cscb_other'
    expectProofRejection(f, 'wrong AD instance')
  })

  test('a retained preallowed label and pre-resume pair cannot replace missing resumed arguments', () => {
    const f = rows()
    expect(f.after.labels).toEqual(f.before.labels)
    expect(f.before.agent_args).toContain(REPLY_TOOL_ALLOW_RULE)
    f.after.agent_args = []
    expectProofRejection(f, 'exact reply permission pair')
  })

  test.each([
    ['rule without flag', [REPLY_TOOL_ALLOW_RULE]],
    ['flag without rule', ['--allowedTools']],
    ['wrong rule', ['--allowedTools', 'Bash(*)']],
    ['nonadjacent rule', ['--allowedTools', '--system-prompt-snapshot', REPLY_TOOL_ALLOW_RULE]],
    ['widened tool list', ['--allowedTools', `${REPLY_TOOL_ALLOW_RULE},Bash(*)`]],
    ['wildcard rule', ['--allowedTools', `${REPLY_TOOL_ALLOW_RULE}*`]],
    ['duplicate exact flags', ['--allowedTools', REPLY_TOOL_ALLOW_RULE, '--allowedTools', REPLY_TOOL_ALLOW_RULE]],
    ['duplicate flags with a later exact pair', ['--allowedTools', 'Bash(*)', '--allowedTools', REPLY_TOOL_ALLOW_RULE]],
    ['missing args', undefined],
    ['null args', null],
    ['string args', `--allowedTools ${REPLY_TOOL_ALLOW_RULE}`],
    ['array-like args', { 0: '--allowedTools', 1: REPLY_TOOL_ALLOW_RULE, length: 2 }],
    ['non-string rule', ['--allowedTools', { rule: REPLY_TOOL_ALLOW_RULE }]],
  ] as const)('rejects %s', (_, args) => {
    const f = rows()
    // Deliberately malformed JSON evidence crosses the typed AD row boundary.
    Object.assign(f.after, { agent_args: args })
    expectProofRejection(f, 'exact reply permission pair')
  })

  test.each([
    ['before', 'instance_id', 'wrong AD instance'],
    ['after', 'instance_id', 'wrong AD instance'],
    ['before', 'session_id', 'same native session'],
    ['after', 'session_id', 'same native session'],
    ['after', 'agent_args', 'exact reply permission pair'],
  ] as const)('rejects a token-bearing %s %s without echoing the saved evidence', (side, field, message) => {
    const f = rows()
    const secret = fakeToken(BOT_TOKEN_PREFIX, 'reply-permission-evidence')
    Object.assign(f[side], { [field]: field === 'agent_args' ? ['--allowedTools', secret] : secret })
    expectProofRejection(f, message)
  })
})

describe('real key recovery proof', () => {
  test.each([
    ['own waiting', 'control', 'native-session', 1000, true],
    ['foreign persona waiting', 'other', 'native-session', 1000, false],
    ['foreign session waiting', 'control', 'other-session', 1000, false],
    ['late waiting', 'control', 'native-session', 1001, false],
    ['stale waiting', 'control', 'native-session', 999, false],
    ['missing session', 'control', '', 1000, false],
  ] as const)('first launch binds %s to the own persona and durable session', (_, key, session_id, at, allowed) => {
    const proof = () => assertFirstLaunchWaiting([{ key, session_id, at }], [text], 'control', 1000, 1000)
    if (allowed) expect(proof().session_id).toBe(text.session_id)
    else expect(proof).toThrow()
  })

  function resetFixture() {
    const sent = (at: number, send_kind: string) => ({
      kind: 'sent', seq: 4, part: 1, session_id: 'native-session', send_kind, at,
    })
    return {
      journal: [sent(0, 'text'), sent(20500, 'retype'), sent(81000, 'retype'),
        sent(101000, 'enter'), sent(111000, 'retype'), sent(141500, 'enter'), sent(171500, 'retype')],
      calls: [key(101000, 'enter'), key(111000, 'text'), key(111500, 'enter'), key(141500, 'enter'), key(171500, 'text')]
        .map((call, n) => ({ ...call, pid: String(n + 1) })),
      faults: [{ at: 111000, pid: '2', words: ['send-keys', 'no_enter', 'swallow'] }],
      waiting: [{ key: 'control', session_id: 'native-session', at: 100000 }],
    }
  }
  function proveReset(f: ReturnType<typeof resetFixture>) {
    return assertResetKeyRecovery(f.journal, f.calls, f.faults, f.waiting, 4, instance)
  }

  test('restart proves the reset 10s wait and both 30s recovery stages even with a 60.5s text gap', () => {
    const f = resetFixture()
    expect(f.journal.at(-1)!.at - f.journal[4]!.at).toBe(60500)
    expect(proveReset(f)).toMatchObject({ session: 'native-session', stages: [10000, 30000, 30000] })
  })

  test('reset oracle accepts the production executor recovery sequence after an interrupted growing episode', async () => {
    const h = await makeEngineHarness({ keys: ['control'] })
    try {
      const item = await h.accept('message', 'control')
      const p = h.p('control'); p.autoReceipt = false
      await h.tick('control')
      await h.until(() => h.textCalls('control').length === 3)
      // A native launch loses the swallowed draft but retains its journal.
      h.lifecycle.observeRow('control', { state: 'pending' }); p.box = ''
      let swallowed = false
      p.keyHook = params => {
        if (params.no_enter && !swallowed) { swallowed = true; p.box = ''; p.autoReceipt = false }
        else if (params.key === 'Enter' && swallowed) p.box = ''
        return undefined
      }
      await h.until(() => h.textCalls('control').length === 5)
      const calls = h.keyCalls('control').map((call, n) => ({ ...key(call.at, call.params.no_enter ? 'text' : 'enter'), pid: String(n) }))
      const first = calls.filter(call => call.words.includes('--no-enter'))[3]!
      const waiting = h.events.flatMap(event => event.type === 'launch-first-waiting'
        ? [{ key: event.key, session_id: event.sessionId, at: event.at }] : [])
      const proof = assertResetKeyRecovery(h.records('control'), calls,
        [{ at: first.at, pid: first.pid, words: ['send-keys', 'no_enter', 'swallow'] }], waiting, item.accepted.seq, instance)
      expect(proof.stages).toEqual([10000, 30000, 30000])
      const newerText = h.textCalls('control').slice(3)
      expect(newerText[1]!.at - newerText[0]!.at).toBe(60000 + ENTER_DELAY_MS)
    } finally { await h.cleanup() }
  })

  test.each([
    ['missing initial recovery', (f: ReturnType<typeof resetFixture>) => { f.journal.splice(3, 1) }],
    ['missing second recovery', (f: ReturnType<typeof resetFixture>) => { f.journal.splice(5, 1) }],
    ['wrong part', (f: ReturnType<typeof resetFixture>) => { f.journal[5]!.part = 2 }],
    ['wrong native session', (f: ReturnType<typeof resetFixture>) => { f.journal[5]!.session_id = 'other' }],
    ['no growing old episode', (f: ReturnType<typeof resetFixture>) => { f.journal.splice(0, 2) }],
    ['no observed launch', (f: ReturnType<typeof resetFixture>) => { f.waiting.length = 0 }],
    ['wrong observed persona', (f: ReturnType<typeof resetFixture>) => { f.waiting[0]!.key = 'other' }],
    ['wrong observed session', (f: ReturnType<typeof resetFixture>) => { f.waiting[0]!.session_id = 'other' }],
    ['no swallowed text fault', (f: ReturnType<typeof resetFixture>) => { f.faults.length = 0 }],
    ['wrong fault stage', (f: ReturnType<typeof resetFixture>) => { f.faults[0]!.words[1] = 'key=Enter' }],
    ['fault on another attempt', (f: ReturnType<typeof resetFixture>) => { f.faults[0]!.at = 81000 }],
    ['fault from another process', (f: ReturnType<typeof resetFixture>) => { f.faults[0]!.pid = 'other' }],
    ['fault without process identity', (f: ReturnType<typeof resetFixture>) => { f.faults[0]!.pid = '' }],
    ['no actual recovery Enter', (f: ReturnType<typeof resetFixture>) => { f.calls.splice(3, 1) }],
    ['no actual delayed Enter', (f: ReturnType<typeof resetFixture>) => { f.calls.splice(2, 1) }],
    ['wrong actual persona', (f: ReturnType<typeof resetFixture>) => { f.calls[3] = { ...key(141500, 'enter', 'other'), pid: '4' } }],
    ['native pane read', (f: ReturnType<typeof resetFixture>) => { f.calls.push({ at: 120000, words: ['read-pane'], pid: 'other' }) }],
  ] as const)('reset proof rejects %s', (_, mutate) => {
    const f = resetFixture(); mutate(f)
    expect(() => proveReset(f)).toThrow()
  })

  test.each([0, 1, 2])('reset proof rejects retaining the next backoff slot at stage %s', stage => {
    const f = resetFixture()
    const boundary = [111000, 141500, 171500][stage]!, extra = stage === 0 ? 20000 : 30000
    for (const record of f.journal) if (record.at >= boundary) record.at += extra
    for (const call of f.calls) if (call.at >= boundary) call.at += extra
    for (const fault of f.faults) if (fault.at >= boundary) fault.at += extra
    expect(() => proveReset(f)).toThrow('backoff stage')
  })

  test.each([0, 1, 2])('reset proof rejects an early key at stage %s', stage => {
    const f = resetFixture()
    const boundary = [111000, 141500, 171500][stage]!
    for (const record of f.journal) if (record.at >= boundary) record.at--
    for (const call of f.calls) if (call.at >= boundary) call.at--
    for (const fault of f.faults) if (fault.at >= boundary) fault.at--
    expect(() => proveReset(f)).toThrow('backoff stage')
  })

  test.each(['enter', 'text'] as const)('unknown outcome permits %s recovery at the backoff boundary', kind => {
    expect(() => assertUnknownKeyRecovery([key(12000, kind)], fault, instance)).not.toThrow()
    expect(() => assertUnknownKeyRecovery([key(11999, kind), key(13000, kind)], fault, instance)).toThrow('existing backoff')
  })

  test.each([
    ['no recovery', []],
    ['another persona', [key(12000, 'enter', 'cscb_other')]],
    ['native pane read', [{ at: 3000, words: ['read-pane'] }, key(12000, 'enter')]],
  ])('unknown recovery rejects %s', (_, calls) => {
    expect(() => assertUnknownKeyRecovery(calls, fault, instance)).toThrow()
  })

  test('swallowed Enter permits a durable Enter-only recovery without a second text', () => {
    expect(() => proveEnter([text, enter], [key(12000, 'enter')], [fault])).not.toThrow()
  })

  test.each([
    ['no durable Enter', [text], [key(12000, 'enter')], [fault]],
    ['no actual Enter', [text, enter], [key(12000, 'text')], [fault]],
    ['another persona', [text, enter], [key(12000, 'enter', 'cscb_other')], [fault]],
    ['early recovery', [text, { ...enter, at: 11999 }], [key(11999, 'enter'), key(13000, 'enter')], [fault]],
    ['early retype before later Enter', [text, enter], [key(11999, 'text'), key(13000, 'enter')], [fault]],
    ['another part', [text, { ...enter, part: 2 }], [key(12000, 'enter')], [fault]],
    ['another launch', [text, { ...enter, session_id: 'other' }], [key(12000, 'enter')], [fault]],
    ['no injected fault', [text, enter], [key(12000, 'enter')], []],
  ])('swallowed Enter proof rejects %s', (_, journal, calls, faults) => {
    expect(() => proveEnter(journal, calls, faults)).toThrow('durable Enter-only recovery')
  })

  test.each([
    ['fault on a reminder', (calls: any[], faults: any[]) => { calls[0].words[calls[0].words.indexOf('--text') + 1] = 'reply reminder' }],
    ['fault on another persona', (calls: any[], faults: any[]) => { calls[1] = key(2000, 'enter', 'cscb_other') }],
    ['fault on another PID', (calls: any[], faults: any[]) => { faults[0].pid = 'other' }],
    ['fault without PID', (calls: any[], faults: any[]) => { delete faults[0].pid }],
    ['no durable fixed part', (calls: any[], faults: any[], journal: any[]) => { journal.shift() }],
  ])('swallowed Enter proof rejects %s despite a later durable recovery', (_, mutate) => {
    const calls = [key(1000, 'text'), key(2000, 'enter'), key(12000, 'enter')]
    const faults = [{ ...fault }], journal = [fixed, text, enter]
    mutate(calls, faults, journal)
    expect(() => assertSwallowedEnterRecovery(journal, calls, faults, 1, instance)).toThrow('durable Enter-only recovery')
  })
})
