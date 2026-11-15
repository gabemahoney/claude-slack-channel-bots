/** Host-safe controls: actual shell shim + inert executable, never AD/tmux.
 * All writes belong to this temporary directory; no home state is read.
 */
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertBusyFixtureResult } from './busy-result.ts'
import { checkBusyPackedConsumer, checkBusyShimConsumer } from './busy-send-consumer-controls.ts'

const root = mkdtempSync(join(tmpdir(), 'cscb-busy-controls-'))
try {
  const shim = join(root, 'agent-director'), control = join(root, 'agent-director-busy-send.json')
  copyFileSync(join(import.meta.dir, 'agent-director-shim.sh'), shim)
  copyFileSync(join(import.meta.dir, 'agent-director-busy-send.ts'), join(root, 'agent-director-busy-send.ts'))
  copyFileSync(join(import.meta.dir, 'busy-result.ts'), join(root, 'busy-result.ts'))
  symlinkSync(process.execPath, join(root, 'agent-director-busy-bun'))
  chmodSync(shim, 0o755)
  const real = join(root, 'agent-director.real')
  writeFileSync(real, '#!/bin/bash\nprintf \'{"instance_id":"own","state":"waiting","busy_send":"covered"}\\n\'\n', { mode: 0o755 })
  const configure = (value: object) => writeFileSync(control, JSON.stringify(value))
  function run(args: string[], code = 0): any {
    const result = spawnSync(shim, args, { encoding: 'utf8', timeout: 3000 })
    assert.equal(result.status, code, result.stderr)
    return JSON.parse(code === 0 ? result.stdout : result.stderr)
  }
  assert.equal(run(['get', '--instance-id', 'own']).busy_send, 'covered')
  configure({ instance_id: 'own', busy_send: 'absent' })
  assert(!('busy_send' in run(['--store-path', 'ignored', 'get', '--instance-id', 'own'])))
  assert.equal(run(['get', '--instance-id', 'other']).busy_send, 'covered')
  configure({ instance_id: 'own', busy_send: 'not_covered' })
  assert.equal(run(['get', '--instance-id', 'own']).busy_send, 'not_covered')
  const request = ['send-keys', '--instance-id', 'own', '--text', 'exact\n🙂 bytes', '--send-mode', 'wait_turn',
    '--confirmed-delivery', '--caller-uuid', 'caller', '--delivery-request-id', 'request']
  configure({ instance_id: 'own', busy_send: 'covered', send: 'agent_not_covered' })
  const refusal = run(request, 1)
  assert.equal(refusal.err_name, 'ErrCantSend')
  assert.deepEqual(refusal.err_details, { class: 'cant_send', reason: 'agent_not_covered', resend_safe: true, retry_with: 'new_send' })
  assert.equal(run(['send-keys', '--instance-id', 'own', '--text', 'legacy', '--no-enter'], 1).err_name, 'ErrInternal')
  assert.equal(run(['get', '--instance-id', 'own']).busy_send, 'not_covered')
  configure({ instance_id: 'own', busy_send: 'covered' })
  assert.equal(run([...request, '--no-enter'], 1).err_name, 'ErrInvalidFlags')
  const held = run(request)
  assertBusyFixtureResult(held)
  assert.equal(held.class, 'held')
  assert.equal(held.launch_token, null)
  const lookup = ['get-delivery', '--caller-uuid', 'caller', '--delivery-request-id', 'request']
  const final = run(lookup).result
  assertBusyFixtureResult(final)
  assert.equal(final.class, 'delivered_confirmed')
  assert.equal(final.launch_token, 'fixture-handover')
  for (const field of ['instance_id', 'launch_token', 'wait', 'session_id', 'caller_uuid', 'request_id', 'evidence_kind']) {
    const incomplete = { ...final }; delete incomplete[field]
    assert.throws(() => assertBusyFixtureResult(incomplete), `accepted incomplete ${field}`)
  }
  await checkBusyPackedConsumer(root, held, final)
  const incompleteFinal = { ...final }; delete incompleteFinal.launch_token
  await assert.rejects(() => checkBusyPackedConsumer(root, held, incompleteFinal), /shim Final must pass the production journal validator/)
  console.log('recorded: packed queue/engine accepts complete held/Final and rejects the pre-repair incomplete Final')
  configure({ ...JSON.parse(readFileSync(control, 'utf8')), lookup: 'unknown' })
  assert.deepEqual(run(lookup), { lookup: 'unknown', result: null })
  for (const args of [['get-delivery', '--caller-uuid', 'foreign', '--delivery-request-id', 'request'], request]) {
    const result = spawnSync(shim, args, { encoding: 'utf8', timeout: 3000 })
    assert.equal(result.status, 1, 'wrong identity or duplicate submission was accepted')
  }
  const calls = readFileSync(join(root, 'agent-director-shim.log'), 'utf8').trimEnd().split('\n')
  assert.equal(calls.length, 13)
  assert(calls.every(line => line.startsWith('call\t')))
  console.log('recorded: busy-send shim controls passed (scope, absent/not_covered, fresh-get barrier, no raw keys, held/final/unknown, wrong ID and duplicate negatives)')
  // Covered waiting get rows, like legacy waiting rows, omit launch identity.
  const legacyRow = { instance_id: 'own', state: 'waiting', session_id: 'legacy-session', agent: 'claude',
    cwd: root, relay_mode: 'on', labels: { tag_prompt: '1' }, jsonl_path: join(root, 'legacy-transcript.jsonl') }
  writeFileSync(`${real}.json`, JSON.stringify(legacyRow))
  writeFileSync(real, '#!/bin/bash\ncat -- "${0}.json"\n', { mode: 0o755 })
  configure({ instance_id: 'own', busy_send: 'covered' })
  const projected = run(['get', '--instance-id', 'own'])
  assert(!('launch_token' in projected))
  assert(!('launch_started_at' in projected))
  assert.equal(projected.session_id, legacyRow.session_id)
  assert.equal(projected.jsonl_path, legacyRow.jsonl_path)
  assert(!('busy_send' in run(['get', '--instance-id', 'other'])), 'coverage escaped instance scope')
  const invoke = (verb: string, params: Record<string, unknown>) => {
    const argv = [verb]
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === false) continue
      argv.push('--' + key.replaceAll('_', '-'))
      if (value !== true) argv.push(String(value))
    }
    const result = spawnSync(shim, argv, { encoding: 'utf8', timeout: 3000 })
    assert(result.status === 0 || result.status === 1, result.stderr)
    return JSON.parse(result.status === 0 ? result.stdout : result.stderr)
  }
  for (const mode of ['fallback', 'covered', 'unknown']) {
    configure({ instance_id: 'own', busy_send: 'covered',
      send: mode === 'fallback' ? 'agent_not_covered' : 'held', lookup: mode === 'unknown' ? 'unknown' : 'final' })
    writeFileSync(legacyRow.jsonl_path, '')
    await checkBusyShimConsumer(root, mode, invoke)
  }
  console.log('recorded: actual shim get from a legacy waiting row reaches fallback, held/Final and unknown through the packed engine')
} finally { rmSync(root, { recursive: true, force: true }) }
