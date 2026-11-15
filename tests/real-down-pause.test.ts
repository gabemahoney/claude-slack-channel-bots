/** Synthetic test-32 DOWN evidence; no native agent or credentials. */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFixture } from './test-helpers/test33-receipt-boundary.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(state: 'ended' | 'missing' = 'missing', proof = true) {
  const root = mkdtempSync(join(tmpdir(), 'down-pause-')); roots.push(root)
  const down = join(root, 'order-down-row.json'), shim = join(root, 'shim.log')
  const live = { instance_id: 'cscb_order', state: 'waiting', session_id: 'native-session', transcript_status: 'present', started_at: 'start', launch_started_at: 'launch', launch_token: 'token' }
  const row = { ...live, state, ...(state === 'ended' ? { ended_at: 'end' } : {}) }
  const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value))
  save(down, row); save(down + '.end', row); save(down + '.before-pause', live)
  save(down + '.down-start', { accepted: [], sent: 0, delivered: 0, logLines: 0 })
  if (proof) writeFileSync(down + '.pause-succeeded', live.instance_id + '\n')
  mkdirSync(join(root, 'queue'))
  writeFileSync(join(root, 'queue/order.jsonl'), Array.from({ length: 13 }, (_, i) => JSON.stringify({
    v: 1, kind: 'accepted', seq: i + 1, source: i < 10 ? 'slack' : i < 12 ? 'interject' : 'cron',
  })).join('\n') + '\n')
  writeFileSync(join(root, 'server.log'), '')
  writeFileSync(shim, 'call\t1\t11\t1\tbun\tresume --instance-id cscb_order\nfault\t1\t11\t1\tbun\tresume * unknown-untyped 1\n')
  return { root, down, row, live, save, run: () => runFixture('fixtures/real-case-assertions.ts', ['down', root, 'order', shim, root, down, '0', '13']) }
}

test('regression: test-32 accepts missing only after its successful pause with the native session kept', async () => {
  const h = fixture()
  const answer = await h.run()
  expect(answer.err).toEqual([])
  expect(answer.code).toBe(0)
  expect(answer.out.join('\n')).toContain('recorded: DOWN interval')
})

test('pinning: test-32 still accepts ended', async () => {
  expect((await fixture('ended').run()).code).toBe(0)
})

test.each(['same', 'different', 'empty', 'foreign-instance'])('test-32 verifies native conversation after resume: %s', async fault => {
  const h = fixture(), resumed = join(h.root, 'resumed.json')
  h.save(resumed, { ...h.live, session_id: fault === 'different' ? 'replacement' : fault === 'empty' ? '' : h.live.session_id,
    instance_id: fault === 'foreign-instance' ? 'cscb_foreign' : h.live.instance_id })
  const answer = await runFixture('fixtures/real-case-assertions.ts', ['same-conversation-resume', h.root, 'order',
    join(h.root, 'shim.log'), h.root, h.down + '.before-pause', resumed])
  expect(answer.code).toBe(fault === 'same' ? 0 : 1)
  if (fault === 'same') expect(answer.out.join('\n')).toContain('recorded: same native conversation resumed')
})

test('test-32 runs the same-conversation assertion before waiting for resumed receipts', async () => {
  const text = await Bun.file(join(import.meta.dir, 'integration/test-32-fmk-real-order.sh')).text()
  const resume = text.indexOf('start_server --live', text.indexOf('case_assert down'))
  const proof = text.indexOf('case_assert same-conversation-resume', resume)
  expect(proof).toBeGreaterThan(resume)
  expect(proof).toBeLessThan(text.indexOf('real_wait_delivery "${REAL_KEY}" 14', resume))
  expect(text.slice(resume, proof)).toContain('real_ad get --instance-id')
  expect(text.slice(proof, text.indexOf('\n', proof))).toContain('"${DOWN_ROW}.before-pause"')
})

test.each(['no-success', 'wrong-success', 'missing-before', 'wrong-before', 'lost-session', 'changed-session', 'changed-start', 'changed-launch', 'changed-token', 'live-end', 'wrong-end', 'changed-end-session', 'changed-end-launch'])(
  'pinning: test-32 rejects missing with %s evidence', async fault => {
    const h = fixture('missing', fault !== 'no-success')
    if (fault === 'wrong-success') writeFileSync(h.down + '.pause-succeeded', 'cscb_foreign\n')
    if (fault === 'missing-before') rmSync(h.down + '.before-pause')
    if (fault === 'wrong-before') h.save(h.down + '.before-pause', { ...h.live, instance_id: 'cscb_foreign' })
    if (fault === 'lost-session') { h.save(h.down, { ...h.row, session_id: '' }); h.save(h.down + '.end', { ...h.row, session_id: '' }) }
    const fields: Record<string, string> = { 'changed-session': 'session_id', 'changed-start': 'started_at', 'changed-launch': 'launch_started_at', 'changed-token': 'launch_token' }
    const field = fields[fault]
    if (field) h.save(h.down + '.before-pause', { ...h.live, [field]: 'foreign' })
    if (fault === 'live-end') h.save(h.down + '.end', { ...h.row, state: 'working' })
    if (fault === 'wrong-end') h.save(h.down + '.end', { ...h.row, instance_id: 'cscb_foreign' })
    if (fault === 'changed-end-session') h.save(h.down + '.end', { ...h.row, session_id: 'foreign' })
    if (fault === 'changed-end-launch') h.save(h.down + '.end', { ...h.row, launch_started_at: 'foreign' })
    expect((await h.run()).code).toBe(1)
  },
)

test('regression: test-32 missing proof tolerates absent optional launch fields', async () => {
  const h = fixture()
  const { launch_started_at, launch_token, ...live } = h.live
  h.save(h.down + '.before-pause', live)
  h.save(h.down, { ...live, state: 'missing' }); h.save(h.down + '.end', { ...live, state: 'missing' })
  expect((await h.run()).code).toBe(0)
})

// Execute the actual pause boundary. A failed pause must not publish success.
test.each([0, 1])('regression: test-32 records pause proof only after exit status %s', async status => {
  const h = fixture('missing', false)
  const script = await Bun.file(join(import.meta.dir, 'integration/test-32-fmk-real-order.sh')).text()
  const start = script.indexOf('DOWN_ROW=')
  const end = script.indexOf('DOWN_MARK=', start)
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const result = Bun.spawnSync(['bash', '-c', [
    'set -euo pipefail', 'SCENARIO_ROOT="$HOME"', 'REAL_KEY=order',
    'real_instance() { printf "%s" cscb_order; }',
    'case_assert() { :; }',
    `real_ad() { if [[ "$1" == pause ]]; then return ${status}; fi; printf '%s' '${JSON.stringify(h.live)}'; }`,
    script.slice(start, end),
  ].join('\n')], { env: hostSafeChildEnv(h.root, { tools: ['bash'] }) })
  expect(result.exitCode).toBe(status)
  expect(existsSync(h.down + '.pause-succeeded')).toBe(status === 0)
})

test.each(['present', 'never_written', 'no_session', 'rotated', undefined])(
  'test-32 requires a written before-pause transcript: %s', async transcript_status => {
    const h = fixture()
    h.save(h.down + '.before-pause', { ...h.live, transcript_status })
    const result = await runFixture('fixtures/real-case-assertions.ts', ['before-pause-transcript', h.root, 'order',
      join(h.root, 'shim.log'), h.root, h.down + '.before-pause'])
    expect(result.code).toBe(transcript_status === 'present' ? 0 : 1)
    if (transcript_status !== 'present') expect(result.err.join('\n'))
      .toContain('before-pause transcript must be present after the receipted Claude turn')
  },
)

// Only the pre-DOWN slice, with inert shell functions. No integration script
// is sourced, and no AD binary, shim, Slack service or native agent is run.
test.each([0, 1])('test-32 receipts one real turn before pause and stops on transcript-check exit %s', async verdict => {
  const h = fixture('missing', false)
  const script = await Bun.file(join(import.meta.dir, 'integration/test-32-fmk-real-order.sh')).text()
  const start = script.indexOf('real_wait_launch "${REAL_KEY}"\n')
  const end = script.indexOf('DOWN_MARK=', start)
  const result = Bun.spawnSync(['bash', '-c', [
    'set -euo pipefail', 'SCENARIO_ROOT="$HOME"', 'REAL_KEY=order', 'REAL_LABEL=order',
    'real_instance() { printf "%s" cscb_order; }',
    `real_ad() { if [[ "$1" == get ]]; then printf '%s' '${JSON.stringify(h.live)}'; else printf 'pause\\n' >&2; fi; }`,
    'real_wait_launch() { :; }', 'real_fault() { printf "fault\\n" >&2; }',
    'real_dm() { printf "dm\\n" >&2; }', 'real_wait_delivery() { printf "receipts:%s\\n" "$2" >&2; }',
    'real_wait_idle() { printf "idle\\n" >&2; }',
    `case_assert() { printf '%s\\n' "$1" >&2; if [[ "$1" == before-pause-transcript ]]; then return ${verdict}; fi; }`,
    script.slice(start, end),
  ].join('\n')], { env: hostSafeChildEnv(h.root, { tools: ['bash'] }) })
  expect(result.exitCode).toBe(verdict)
  const trace = result.stderr.toString().trim().split('\n')
  expect(trace.slice(0, 3)).toEqual(['dm', 'receipts:1', 'idle'])
  expect(trace).toContain('before-pause-transcript')
  expect(trace.includes('pause')).toBe(verdict === 0)
  if (verdict === 0) expect(trace.indexOf('before-pause-transcript')).toBeLessThan(trace.indexOf('pause'))
})

test.each(['none', 'send', 'delivery', 'log', 'extra-accepted'])(
  'test-32 DOWN baseline allows the completed pre-pause DM but rejects new %s', async fault => {
    const h = fixture(), queue = join(h.root, 'queue/order.jsonl'), log = join(h.root, 'server.log')
    const interval = (await Bun.file(queue).text()).trim().split('\n')
      .map(line => ({ ...JSON.parse(line), seq: JSON.parse(line).seq + 1 }))
      .map(row => JSON.stringify(row) + '\n').join('')
    const warmup = [
      { kind: 'accepted', seq: 1, source: 'slack' },
      { kind: 'sent', seq: 1, at: 1 }, { kind: 'delivered', seq: 1, at: 2 },
    ].map(r => JSON.stringify(r) + '\n').join('')
    writeFileSync(queue, warmup)
    writeFileSync(log, '[slack] message-delivered: persona="order" (key=order)\n')
    const baseline = await runFixture('fixtures/real-case-assertions.ts', ['down-start', h.root, 'order',
      join(h.root, 'shim.log'), h.root, h.down])
    expect(baseline.code).toBe(0)
    const extra = fault === 'send' ? { kind: 'sent', seq: 1, at: 3 }
      : fault === 'delivery' ? { kind: 'delivered', seq: 1, at: 4 }
      : fault === 'extra-accepted' ? { kind: 'accepted', seq: 15, source: 'slack' } : undefined
    writeFileSync(queue, warmup + interval + (extra ? JSON.stringify(extra) + '\n' : ''))
    if (fault === 'log') writeFileSync(log, (await Bun.file(log).text()) + '[slack] message-delivered: persona="order" (key=order)\n')
    const result = await h.run()
    expect(result.code).toBe(fault === 'none' ? 0 : 1)
    const reason = { none: undefined, send: 'send recorded', delivery: 'delivery recorded', log: 'delivery logged', 'extra-accepted': 'acceptance count differs' }[fault]
    if (reason) expect(result.err.join('\n')).toContain(reason)
    else expect(result.out.join('\n')).toContain('"accepted":13')
  },
)

test('test-32 pins cumulative 14/34 inputs and all 20 shifted latency indices', async () => {
  const h = fixture()
  const script = await Bun.file(join(import.meta.dir, 'integration/test-32-fmk-real-order.sh')).text()
  expect(script).toContain("case_assert accepted 14")
  expect(script).toContain('case_assert down "${DOWN_ROW}" "${DOWN_MARK}" 13')
  const resume = script.indexOf('case_assert same-conversation-resume')
  expect(script.slice(resume)).toContain('real_wait_delivery "${REAL_KEY}" 14')
  const start = script.indexOf('# Admit each sample'), end = script.indexOf('\ncase_assert launches', start)
  const result = Bun.spawnSync(['bash', '-c', [
    'set -euo pipefail', 'REAL_KEY=order', 'REAL_LABEL=order',
    'real_wait_latency_admission() { printf "admit:%s\\n" "$2"; }', 'real_dm() { :; }',
    'real_wait_delivery() { printf "receipt:%s\\n" "$2"; }', 'real_assert_latency() { printf "samples:%s\\n" "$2"; }',
    script.slice(start, end),
  ].join('\n')], { env: hostSafeChildEnv(h.root, { tools: ['bash'] }) })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString().trim().split('\n')).toEqual([
    ...Array.from({ length: 20 }, (_, i) => [`admit:${34 + i}`, `receipt:${35 + i}`]).flat(), 'samples:20',
  ])
})
