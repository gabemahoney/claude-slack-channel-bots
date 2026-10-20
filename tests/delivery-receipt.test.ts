/** b.omv SR-6.1–6.4/11: exact, offset-bounded, uncredited transcript evidence. */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueueItem, SentRecord } from '../src/delivery-queue.ts'
import { createDeliveryReceiptReader, deliveryTranscriptPath, parseDeliveryTranscriptRecord, receiptTextMatches, type DeliveryAgent } from '../src/delivery-receipt.ts'
import { buildWrapper, type TagMessage } from '../src/tag-wrapper.ts'
import { deliveryFailureEvidence, readTranscripts } from './integration/fixtures/transcript-receipts.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken } from './test-helpers/credentials.ts'
import { injectedInput, makeQueue } from './test-helpers/delivery-queue.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { appendTranscript, codexPromptEntry, pastedText, promptEntry, queuedCommandEntry, queueOperationEntry, toolResultEntry, transcriptJsonl, writeTranscript, type TranscriptEntry } from './test-helpers/working-row-panes.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(agent: DeliveryAgent = 'claude', text = 'one\ntwo') {
  const root = fs.mkdtempSync(join(tmpdir(), 'delivery-receipt-')), path = join(root, 'current.jsonl')
  const queue = await makeQueue(root)
  cleanups.push(async () => { await queue.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  fs.writeFileSync(path, '')
  const reader = createDeliveryReceiptReader()
  let seq = 0
  async function accept() {
    const result = await queue.accept('alpha', injectedInput({ text }))
    if (result.status === 'failed') throw new Error('fixture acceptance failed')
    seq = result.seq
    await queue.append('alpha', { v: 1, kind: 'fixed', seq, parts: [text] })
    return seq
  }
  await accept()
  const item = (): QueueItem => queue.items('alpha').find(i => i.accepted.seq === seq)!
  const row = { jsonl_path: path, transcript_status: 'present', session_id: 'current', cwd: root }
  async function send(offset = fs.statSync(path).size, sendPath = path) {
    const record: SentRecord = { v: 1, kind: 'sent', seq, part: 1, attempt: item().nextAttempt, send_kind: 'text', at: 1000, session_id: row.session_id, transcript_path: sendPath, transcript_size: offset }
    await queue.append('alpha', record)
    return record
  }
  const read = () => reader.read(agent, row, item(), 1, queue.items('alpha'))
  return { root, path, queue, row, reader, item, accept, send, read, text, append: (...entries: TranscriptEntry[]) => appendTranscript(path, entries) }
}

describe('real delivery timeout evidence (synthetic, no native launch)', () => {
  const adapters = { receiptTextMatches, parseDeliveryTranscriptRecord }
  test('delivery failure retains bounded exact own receipt evidence and AD state without private fields', async () => {
    const secret = fakeToken(BOT_TOKEN_PREFIX, 'deliverydiagnostic'), h = await fixture('claude', secret)
    fs.writeFileSync(join(h.root, 'server.log'), '')
    fs.writeFileSync(join(h.root, 'shim.log'), '')
    const options = { stateDir: h.root, key: 'alpha', shimLog: join(h.root, 'shim.log'), transcripts: [h.path], expectedCount: 1 }
    const unsent = deliveryFailureEvidence(options, [], adapters, { state: 'waiting', credentials: secret, pane: secret })
    expect(unsent).toMatchObject({ reason: 'missing-receive-log', accepted: 1, open: 1, head: { seq: 1, part: 1, attempts: 0, exactReceipts: 0 }, rowState: 'waiting' })
    for (let n = 0; n < 12; n++) await h.send()
    h.append({ ...promptEntry(secret), sessionId: 'current', timestamp: new Date(h.item().accepted.received_at + 1).toISOString() })
    const entries = readTranscripts([h.path], adapters)
    const evidence = deliveryFailureEvidence(options, entries, adapters, { state: secret })
    expect(evidence.head).toMatchObject({ attempts: 12, exactReceipts: 1 })
    expect(evidence.head!.recentAttempts).toHaveLength(8)
    expect(evidence.rowState).toBe('unreadable')
    expect(JSON.stringify(evidence).length).toBeLessThan(3000)
    expect(JSON.stringify(evidence)).not.toContain(secret)
    expect(JSON.stringify(evidence)).not.toContain(h.path)
    expect(evidence).not.toHaveProperty('screen')
    assertNoLeak(evidence)
    const foreign = deliveryFailureEvidence(options, [{ ...entries[0]!, path: join(h.root, 'foreign.jsonl') }], adapters)
    expect(foreign.head!.exactReceipts).toBe(0)
  })
  test('damaged diagnostic evidence reports unavailability without echoing parser input', async () => {
    const h = await fixture(), secret = fakeToken(BOT_TOKEN_PREFIX, 'brokenjournal')
    fs.writeFileSync(join(h.root, 'queue/alpha.jsonl'), secret)
    const evidence = deliveryFailureEvidence({ stateDir: h.root, key: 'alpha', shimLog: '', transcripts: [] }, [], adapters)
    expect(evidence).toMatchObject({ reason: 'audit-unavailable', journalReadable: false, sessionEvidenceReadable: false, head: null })
    assertNoLeak(evidence)
    expect(JSON.stringify(evidence)).not.toContain(secret)
  })
  test.each(['own', 'absent', 'foreign-persona', 'foreign-instance', 'foreign-session', 'foreign-directory'] as const)(
    'pathless send accepts only independently observed AD transcript ownership: %s', async binding => {
      const h = await fixture()
      await h.send(0, '')
      h.append({ ...promptEntry(h.text), sessionId: 'current', timestamp: new Date(h.item().accepted.received_at + 1).toISOString() })
      // A delivered record alone must never establish ownership of its path.
      await h.queue.append('alpha', { v: 1, kind: 'delivered', seq: 1, part: 1, at: h.item().accepted.received_at + 2, receipt: { path: h.path, uuid: 'receipt' } })
      const reference = { key: 'alpha', instance_id: 'cscb_alpha', session_id: 'current', jsonl_path: h.path, at: 1500 }
      if (binding === 'foreign-persona') reference.key = 'beta'
      if (binding === 'foreign-instance') reference.instance_id = 'cscb_beta'
      if (binding === 'foreign-session') reference.session_id = 'other'
      if (binding === 'foreign-directory') reference.jsonl_path = join(h.root, 'foreign', 'current.jsonl')
      fs.writeFileSync(join(h.root, 'server.log'), binding === 'absent' ? '' : '[slack] delivery-transcript-reference: ' + JSON.stringify(reference) + '\n')
      fs.writeFileSync(join(h.root, 'shim.log'), '')
      const evidence = deliveryFailureEvidence({ stateDir: h.root, key: 'alpha', shimLog: join(h.root, 'shim.log'), transcripts: [h.path] }, readTranscripts([h.path], adapters), adapters)
      expect(evidence.sessionEntries).toBe(binding === 'own' ? 1 : 0)
    })
  test.each(['waiting', 'working', 'pending', 'ended', 'unknown'])('real readiness follows AD state %s without reading a pane', state => {
    const root = fs.mkdtempSync(join(tmpdir(), 'ad-waiting-control-'))
    try {
      const source = fs.readFileSync(join(import.meta.dir, 'integration/lib/real-scenario.sh'), 'utf8')
      const waiting = source.match(/^_real_waiting\(\) \{[\s\S]*?^\}/m)![0]
      const script = ['set -euo pipefail', 'real_instance() { echo own-row; }',
        `real_ad() { [[ "$*" == "status --instance-id own-row" ]] || return 9; printf '{"state":"%s","pane":"ignored"}\\n' "$STATE"; }`,
        'real_pane() { echo forbidden-pane-read; exit 9; }', waiting, '_real_waiting alpha'].join('\n')
      const path = join(root, 'control.sh'); fs.writeFileSync(path, script)
      const child = spawnSync('bash', [path], { env: hostSafeChildEnv(root, { tools: ['bash', 'jq'], extras: { STATE: state } }), encoding: 'utf8', timeout: 5000 })
      expect(child.error).toBeUndefined(); expect(child.stderr).toBe(''); expect(child.stdout).toBe('')
      expect(child.status).toBe(state === 'waiting' ? 0 : 1)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  test.each([
    ['old waiting row', { session_id: 'old-session' }, false],
    ['old working row', { state: 'working', session_id: 'old-session' }, false],
    ['new pending row', { state: 'pending' }, false],
    ['new ended row', { state: 'ended' }, false],
    ['unbound row', { session_id: '' }, false],
    ['missing session', { session_id: null }, false],
    ['foreign row', { instance_id: 'neighbour-row' }, false],
    ['untagged row', { labels: {} }, false],
    ['new waiting session', {}, true],
    ['new working session', { state: 'working' }, true],
  ] as const)('replacement launch rejects historical connection plus %s', (_label, patch, ready) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'replacement-launch-control-'))
    try {
      const source = fs.readFileSync(join(import.meta.dir, 'integration/lib/real-scenario.sh'), 'utf8')
      const connected = source.match(/^_real_connected\(\) \{[\s\S]*?^\}/m)![0]
      fs.writeFileSync(join(root, 'server.log'), '[historical] Session connected: persona "alpha" (key=alpha)\n')
      const row = { instance_id: 'own-row', state: 'waiting', session_id: 'new-session', labels: { tag_prompt: '1' }, ...patch }
      const script = ['set -euo pipefail', 'SLACK_STATE_DIR="$HOME"', 'real_instance() { echo own-row; }',
        'real_ad() { case "$*" in "status --instance-id own-row") echo \'{"state":"waiting"}\';; "get --instance-id own-row") printf "%s\\n" "$ROW";; *) exit 9;; esac; }',
        connected, '_real_connected alpha old-session'].join('\n')
      const path = join(root, 'control.sh'); fs.writeFileSync(path, script)
      const child = spawnSync('bash', [path], { env: hostSafeChildEnv(root, { tools: ['bash', 'jq', 'grep'], extras: { ROW: JSON.stringify(row) } }), encoding: 'utf8', timeout: 5000 })
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
      expect(child.stderr).toBe(''); expect(child.stdout).toBe('')
      expect(child.status).toBe(ready ? 0 : 1)
      assertNoLeak({ stdout: child.stdout, stderr: child.stderr })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  test('replacement launch waits through the old live row and new pending row before AD binds a new session', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'replacement-sequence-control-'))
    try {
      const source = fs.readFileSync(join(import.meta.dir, 'integration/lib/real-scenario.sh'), 'utf8')
      const extract = (name: string) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))![0]
      fs.writeFileSync(join(root, 'server.log'), '[historical] Session connected: persona "alpha" (key=alpha)\n')
      const script = ['set -euo pipefail', 'SLACK_STATE_DIR="$HOME"', 'REAL_LAUNCH_WAIT_S=300', 'real_instance() { echo own-row; }',
        'real_ad() { case "$*" in "status --instance-id own-row") printf \'{"state":"%s"}\\n\' "$ROW_STATE";; "get --instance-id own-row") printf \'{"instance_id":"own-row","state":"%s","session_id":"%s","labels":{"tag_prompt":"1"}}\\n\' "$ROW_STATE" "$ROW_SESSION";; *) exit 9;; esac; }',
        // No time passes: each explicit AD answer advances the actual predicate.
        'wait_until() { [[ "$1" == 300 ]]; shift 2; [[ "$*" == "_real_connected alpha old-session" ]]; ROW_STATE=waiting; ROW_SESSION=old-session; if "$@"; then exit 10; fi; echo old-rejected; ROW_STATE=pending; ROW_SESSION=""; if "$@"; then exit 11; fi; echo pending-rejected; ROW_STATE=waiting; ROW_SESSION=new-session; "$@"; echo new-bound; }',
        'real_wait_idle() { [[ "$*" == "alpha 300" ]]; echo ad-waiting; }', extract('_real_connected'), extract('real_wait_launch'),
        'real_wait_launch alpha old-session'].join('\n')
      const path = join(root, 'control.sh'); fs.writeFileSync(path, script)
      const child = spawnSync('bash', [path], { env: hostSafeChildEnv(root, { tools: ['bash', 'jq', 'grep'] }), encoding: 'utf8', timeout: 5000 })
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(0)
      expect(child.stderr).toBe(''); expect(child.stdout).toBe('old-rejected\npending-rejected\nnew-bound\nad-waiting\n')
      assertNoLeak({ stdout: child.stdout, stderr: child.stderr })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  test.each(['success', 'failure', 'diagnostic-failure'])('%s preserves polling arguments, original failure and cleanup order', mode => {
    const root = fs.mkdtempSync(join(tmpdir(), 'delivery-wait-control-'))
    try {
      const source = fs.readFileSync(join(import.meta.dir, 'integration/lib/real-scenario.sh'), 'utf8')
      const wait = source.match(/^real_wait_delivery\(\) \{[\s\S]*?^\}/m)![0]
      const script = ['set -euo pipefail', 'REAL_DELIVERY_WAIT_S=180', 'REAL_RECEIPTS=receipts', 'SLACK_STATE_DIR=state', 'SCENARIO_AD_SHIM_LOG=shim',
        'fail() { echo "FAIL: $*"; exit 17; }', '_scenario_check_timeout() { [[ "$1" == 180 ]]; }',
        '_scenario_poll_until() { printf "poll:%s:%s:%s:%s:%s:%s:%s:%s:%s\\n" "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$9" "${10}"; [[ "$MODE" == success ]]; }',
        '_real_delivery_diagnostic() { echo "evidence-before-cleanup:$*"; [[ "$MODE" != diagnostic-failure ]]; }',
        'trap \'echo cleanup\' EXIT', wait, 'real_wait_delivery alpha 13 no-retype', 'echo success'].join('\n')
      const path = join(root, 'control.sh'); fs.writeFileSync(path, script)
      const child = spawnSync('bash', [path], { env: hostSafeChildEnv(root, { tools: ['bash'], extras: { MODE: mode } }), encoding: 'utf8', timeout: 5000 })
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.stderr).toBe('')
      const lines = child.stdout.trim().split('\n')
      expect(lines[0]).toBe('poll:180:bun:receipts:ready:state:alpha:shim:13:no-retype')
      if (mode === 'success') { expect(child.status).toBe(0); expect(lines.slice(1)).toEqual(['success', 'cleanup']) }
      else {
        expect(child.status).toBe(17)
        expect(lines[1]).toBe('evidence-before-cleanup:alpha 13 no-retype')
        expect(lines.slice(-2)).toEqual(['FAIL: real persona alpha has open/unconfirmed deliveries (not within 180s)', 'cleanup'])
        expect(lines.includes('recorded: delivery diagnostic unavailable')).toBe(mode === 'diagnostic-failure')
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  test.each(['readable', 'unreadable', 'formatter-failure'])('%s diagnostic captures the live AD row before the original FAIL', mode => {
    const root = fs.mkdtempSync(join(tmpdir(), 'delivery-diagnostic-control-'))
    try {
      const source = fs.readFileSync(join(import.meta.dir, 'integration/lib/real-scenario.sh'), 'utf8')
      const declarations = ['real_wait_delivery', '_real_delivery_diagnostic'].map(name => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))![0]).join('\n')
      const script = ['set -euo pipefail', 'SCENARIO_ROOT="$1"', 'REAL_DELIVERY_WAIT_S=180', 'REAL_RECEIPTS=receipts', 'SLACK_STATE_DIR=state', 'SCENARIO_AD_SHIM_LOG=shim', 'SCENARIO_FIXTURES=fixtures',
        'fail() { echo "FAIL: $*"; exit 17; }', '_scenario_check_timeout() { :; }', '_scenario_poll_until() { return 1; }',
        'real_instance() { echo own-row; }', 'real_ad() { [[ "$*" == "status --instance-id own-row" ]] || return 8; [[ "$MODE" != unreadable ]] || return 1; echo \'{"state":"working","private":"withheld"}\'; }',
        'bun() { [[ -s "$SCENARIO_ROOT/real-delivery-status.json" ]] || return 9; printf "capture:%s:%s\\n" "$1" "$2"; [[ "$MODE" != formatter-failure ]]; }',
        'trap \'echo cleanup\' EXIT', declarations, 'real_wait_delivery alpha 13 no-retype'].join('\n')
      const path = join(root, 'control.sh'); fs.writeFileSync(path, script)
      const child = spawnSync('bash', [path, root], { env: hostSafeChildEnv(root, { tools: ['bash'], extras: { MODE: mode } }), encoding: 'utf8', timeout: 5000 })
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(17); expect(child.stderr).toBe('')
      const lines = child.stdout.trim().split('\n')
      expect(lines.indexOf('capture:receipts:diagnostic')).toBe(0)
      expect(lines.some(line => line.startsWith('capture:fixtures/real-observations.ts:'))).toBe(true)
      expect(lines.slice(-2)).toEqual(['FAIL: real persona alpha has open/unconfirmed deliveries (not within 180s)', 'cleanup'])
      expect(child.stdout.includes('private')).toBe(false)
      expect(JSON.parse(fs.readFileSync(join(root, 'real-delivery-status.json'), 'utf8'))).toEqual(mode === 'unreadable' ? {} : { state: 'working', private: 'withheld' })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

describe('exact matching and agent schema', () => {
  test.each([
    ['raw', 'a\nb', 'a\nb', true], ['meaningful LF', 'a\nb', 'ab', false],
    ['whole paste', pastedText('a\nb'), 'a\nb', true],
    ['mixed paste', `a\n\n${pastedText('b')}\n\nc`, 'abc', true],
    ['junction LF kept', `a\n\n${pastedText('b')}\n\nc`, 'a\nb\nc', true],
    ['two paste blocks', `a${pastedText('b', '1111')}c${pastedText('d', '2222')}`, 'abcd', true],
    ['spaces significant', ' a ', 'a', false], ['different id', '<pasted_content id="a">\nx\n</pasted_content id="b">', 'x', false],
    ['three optional LFs forbidden', `a\n\n\n${pastedText('b')}`, 'ab', false],
  ] as const)('%s', (_label, record, expected, matches) => expect(receiptTextMatches(record, expected)).toBe(matches))

  test.each([
    ['user string', promptEntry('x'), 'take-in', 'x'],
    ['user text blocks', { ...promptEntry(), message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_result', content: 'ignored' }, { type: 'text', text: 'b' }] } }, 'take-in', 'ab'],
    ['human origin', { ...promptEntry('x'), origin: { kind: 'human' } }, 'take-in', 'x'],
    ['queued command', queuedCommandEntry('x'), 'take-in', 'x'],
    ['queued human', queuedCommandEntry('x', { attachment: { type: 'queued_command', prompt: 'x', origin: { kind: 'human' } } }), 'take-in', 'x'],
    ['sidechain', { ...promptEntry('x'), isSidechain: true }, 'other', undefined],
    ['agent origin', { ...promptEntry('x'), origin: { kind: 'agent' } }, 'other', undefined],
    ['queued nonhuman', queuedCommandEntry('x', { attachment: { type: 'queued_command', prompt: 'x', origin: { kind: 'agent' } } }), 'other', undefined],
    ['queued sidechain', queuedCommandEntry('x', { isSidechain: true }), 'other', undefined],
    ['meta', { ...promptEntry('x'), isMeta: true }, 'other', undefined],
    ['tool result', toolResultEntry(), 'take-in', undefined],
    ['enqueue never receipt', queueOperationEntry('enqueue', 'x'), 'other', undefined],
    ['background delivery never receipt', queueOperationEntry('remove', 'x', 'delivered_to_agent'), 'other', undefined],
  ] as const)('Claude %s', (_name, entry, kind, text) => {
    const actual = parseDeliveryTranscriptRecord('claude', entry)
    expect([actual.kind, actual.text]).toEqual([kind, text])
  })
  test('Codex accepts user input_text blocks only', () => {
    expect(parseDeliveryTranscriptRecord('codex', codexPromptEntry('x'))).toMatchObject({ kind: 'take-in', text: 'x' })
    expect(parseDeliveryTranscriptRecord('codex', { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'output_text', text: 'ignored' }, { type: 'input_text', text: 'b' }] } })).toMatchObject({ kind: 'take-in', text: 'ab' })
    for (const entry of [promptEntry('x'), queueOperationEntry('enqueue', 'x'), { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'x' } }]) {
      expect(parseDeliveryTranscriptRecord('codex', entry).kind).toBe('other')
    }
  })
})

describe('receipt reader', () => {
  test('Codex receipt matching preserves every wrapper newline', async () => {
    const own = buildWrapper({ source: 'slack', text: 'a long exact body', user: 'U0SENDER', channel: 'C0CHANNEL', ts: '1792000100.000001' } as TagMessage), h = await fixture('codex', own)
    await h.send()
    // These are display line breaks, not bytes in the accepted message.
    h.append(codexPromptEntry(own.replace(' message_id=', '\nmessage_id=').replace(' ts=', '\nts=')))
    expect(h.read().receipt).toBeUndefined()
    const exactOffset = fs.statSync(h.path).size
    h.append(codexPromptEntry(own))
    expect(h.read().receipt).toMatchObject({ path: h.path, offset: exactOffset, text: own })
  })
  test.each(['claude', 'codex'] as const)('%s needs a post-send record; identical items need distinct identities', async agent => {
    const h = await fixture(agent), entry = agent === 'claude' ? promptEntry : codexPromptEntry
    h.append(entry(h.text))
    await h.send()
    expect(h.read().receipt).toBeUndefined()
    const receipt = entry(h.text)
    h.append(receipt)
    const first = h.read().receipt!
    expect(first).toBeDefined()
    await h.queue.append('alpha', { v: 1, kind: 'delivered', seq: h.item().accepted.seq, part: 1, at: 2000, receipt: { path: first.path, uuid: first.uuid, offset: first.offset } })
    await h.accept()
    await h.send(0)
    // Credit both earlier records to isolate the identity check from the window.
    const old = h.read().records[0]!
    await h.queue.append('alpha', { v: 1, kind: 'delivered', seq: 1, part: 1, at: 2000, receipt: { path: old.path, uuid: old.uuid, offset: old.offset } })
    expect(h.read().receipt).toBeUndefined()
    h.append(entry(h.text))
    expect(h.read().receipt?.offset).toBeGreaterThan(first.offset)
  })
  test('refused attempts cannot open the matching window', async () => {
    const h = await fixture()
    const refused = await h.send(0)
    await h.queue.append('alpha', { v: 1, kind: 'refused', seq: 1, attempt: refused.attempt, at: 1500 })
    h.append(promptEntry(h.text))
    expect(h.read().receipt).toBeUndefined()
    await h.send()
    expect(h.read().receipt).toBeUndefined()
    h.append(queuedCommandEntry(h.text))
    expect(h.read().receipt).toBeDefined()
  })

  test('rotated, prior and sent paths remain searchable; new transcript matches at any offset', async () => {
    const h = await fixture(), old = join(h.root, 'prior.jsonl')
    fs.writeFileSync(old, '')
    await h.send(0, old)
    writeTranscript(old, [promptEntry(h.text)])
    h.row.transcript_status = 'rotated'
    h.row.jsonl_path = join(h.root, 'not-written.jsonl')
    expect(h.read().receipt?.path).toBe(old)
    const priorOnly = h.reader.read('claude', { ...h.row, prior_sessions: [{ jsonl_path: old }] }, h.item(), 1)
    expect(priorOnly.receipt?.path).toBe(old)
  })

  test.each(['claude', 'codex'] as const)('%s excludes pre-send receipts in a previously observed prior session', async agent => {
    const h = await fixture(agent), prior = join(h.root, 'prior.jsonl')
    const entry = agent === 'claude' ? promptEntry : codexPromptEntry
    writeTranscript(prior, [entry(h.text)])
    const row = { ...h.row, prior_sessions: [{ jsonl_path: prior }] }
    const read = () => h.reader.read(agent, row, h.item(), 1, h.queue.items('alpha'))
    expect(read().receipt).toBeUndefined()
    const beforeSend = fs.statSync(prior).size
    await h.send()
    expect(read().receipt).toBeUndefined()
    appendTranscript(prior, [entry(h.text)])
    expect(read().receipt).toMatchObject({ path: prior, offset: beforeSend, text: h.text, kind: 'take-in' })
  })

  test.each(['claude', 'codex'] as const)('%s accepts offset-zero receipts in a prior file first discovered after the send', async agent => {
    const h = await fixture(agent), prior = join(h.root, 'newly-discovered.jsonl')
    const entry = agent === 'claude' ? promptEntry : codexPromptEntry
    h.read()
    await h.send()
    writeTranscript(prior, [{ ...entry(h.text), timestamp: '1970-01-01T00:00:00.000Z' }])
    const observed = h.reader.read(agent, { ...h.row, prior_sessions: [{ jsonl_path: prior }] }, h.item(), 1)
    expect(observed.receipt).toMatchObject({ path: prior, offset: 0, at: 0, text: h.text, kind: 'take-in' })
  })

  test.each(['never_written', 'no_session', 'rotated', 'present'])('missing current path with transcript_status=%s', async transcript_status => {
    const h = await fixture()
    fs.unlinkSync(h.path)
    h.row.transcript_status = transcript_status
    expect(h.read().availability).toBe(transcript_status === 'present' ? 'unreadable' : 'not-yet-written')
    fs.writeFileSync(h.path, '')
    expect(h.read().availability).toBe('not-yet-written')
  })
  test('stat-first incremental reads handle partial JSON, replacement and truncation', async () => {
    const h = await fixture()
    await h.send()
    const calls: string[] = [], positions: number[] = []
    const reader = createDeliveryReceiptReader({ fs: { ...fs,
      statSync: ((...args: any[]) => { calls.push('stat'); return (fs.statSync as any)(...args) }) as typeof fs.statSync,
      openSync: ((...args: any[]) => { calls.push('open'); return (fs.openSync as any)(...args) }) as typeof fs.openSync,
      fstatSync: ((...args: any[]) => { calls.push('fstat'); return (fs.fstatSync as any)(...args) }) as typeof fs.fstatSync,
      readSync: ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => { calls.push('read'); positions.push(position); return fs.readSync(fd, buffer, offset, length, position) }) as typeof fs.readSync,
    } })
    const read = () => reader.read('claude', h.row, h.item(), 1)
    const json = transcriptJsonl([promptEntry(h.text)])
    fs.appendFileSync(h.path, json.slice(0, -2))
    expect(read().receipt).toBeUndefined()
    const size = fs.statSync(h.path).size
    calls.length = 0
    fs.appendFileSync(h.path, json.slice(-2))
    expect(read().receipt).toBeDefined()
    expect(calls.slice(0, 4)).toEqual(['stat', 'open', 'fstat', 'read'])
    expect(positions).toEqual([0, size])
    calls.length = 0
    read()
    expect(calls).toEqual(['stat', 'open', 'fstat'])
    fs.renameSync(h.path, join(h.root, 'rotated.jsonl'))
    fs.writeFileSync(h.path, 'broken JSON\n')
    expect(read().receipt).toBeUndefined()
    fs.truncateSync(h.path, 0)
    expect(read().records).toEqual([])
    writeTranscript(h.path, [promptEntry(h.text)])
    expect(read().receipt).toBeDefined()
    fs.truncateSync(h.path, 0)
    expect(read()).toMatchObject({ availability: 'not-yet-written', records: [], receipt: undefined })
  })

  test.each(['claude', 'codex'] as const)('%s rechecks cached receipts after EACCES and never credits an unreadable file', async agent => {
    const h = await fixture(agent)
    await h.send()
    h.append((agent === 'claude' ? promptEntry : codexPromptEntry)(h.text))
    let refused = false
    const reader = createDeliveryReceiptReader({ fs: { ...fs,
      openSync: ((...args: any[]) => {
        if (refused) throw Object.assign(new Error('refused'), { code: 'EACCES' })
        return (fs.openSync as any)(...args)
      }) as typeof fs.openSync,
    } })
    const read = () => reader.read(agent, h.row, h.item(), 1)
    const readable = read()
    expect(readable.availability).toBe('readable')
    expect(readable.receipt).toMatchObject({ path: h.path, offset: 0, text: h.text })
    expect(readable.records).toEqual([readable.receipt!])
    refused = true
    expect(read()).toMatchObject({ availability: 'unreadable', receipt: undefined, records: readable.records })
    refused = false
    expect(read()).toEqual(readable)
  })

  test('both agents use AD transcript references without synthesizing a native path', () => {
    for (const agent of ['claude', 'codex'] as const) {
      expect(deliveryTranscriptPath(agent, { cwd: '/work', session_id: 'session' })).toBeUndefined()
      expect(deliveryTranscriptPath(agent, { session_id: 'different-session', jsonl_path: '/ad/opaque.jsonl' })).toBe('/ad/opaque.jsonl')
    }
  })
})
