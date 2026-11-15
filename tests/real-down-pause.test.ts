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
  const live = { instance_id: 'cscb_order', state: 'waiting', session_id: 'native-session', started_at: 'start', launch_started_at: 'launch', launch_token: 'token' }
  const row = { ...live, state, ...(state === 'ended' ? { ended_at: 'end' } : {}) }
  const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value))
  save(down, row); save(down + '.end', row); save(down + '.before-pause', live)
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
    `real_ad() { if [[ "$1" == pause ]]; then return ${status}; fi; printf '%s' '${JSON.stringify(h.live)}'; }`,
    script.slice(start, end),
  ].join('\n')], { env: hostSafeChildEnv(h.root, { tools: ['bash'] }) })
  expect(result.exitCode).toBe(status)
  expect(existsSync(h.down + '.pause-succeeded')).toBe(status === 0)
})
