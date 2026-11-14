/** Synthetic AD custody facts; no Claude route, hooks or pane parsing.
 * The shell shim holds the control lock and records the invocation first.
 * Exit 75 preserves the real binary's authority for nonmatching calls.
 */
import assert from 'node:assert/strict'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fixtureBusyResult } from './busy-result.ts'

const [directory, real, verbIndex, ...argv] = process.argv.slice(2)
const control = join(directory, 'agent-director-busy-send.json')
const verb = argv[Number(verbIndex)]
const options: Record<string, string | boolean> = {}
for (let i = Number(verbIndex) + 1; i < argv.length; i++) {
  const arg = argv[i], equals = arg.indexOf('=')
  if (equals !== -1) options[arg.slice(0, equals)] = arg.slice(equals + 1)
  else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) options[arg] = argv[++i]
  else options[arg] = true
}
const config = JSON.parse(readFileSync(control, 'utf8'))
if (!['get', 'send-keys', 'get-delivery'].includes(verb) ||
    (verb !== 'get-delivery' && options['--instance-id'] !== config.instance_id)) process.exit(75)
function save() {
  const temporary = `${control}.${process.pid}`
  writeFileSync(temporary, JSON.stringify(config))
  renameSync(temporary, control)
}
function error(name: string, details?: unknown): never {
  console.error(JSON.stringify({ err_name: name, err_description: 'synthetic busy-send fixture', err_details: details ?? null }))
  process.exit(1)
}
function answer(value: unknown): never { console.log(JSON.stringify(value)); process.exit(0) }
if (verb === 'get') {
  const result = spawnSync(real, argv, { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    process.exit(result.status ?? 1)
  }
  const row = JSON.parse(result.stdout)
  const coverage = config.busy_send ?? 'absent'
  delete row.busy_send
  if (coverage !== 'absent') row.busy_send = coverage
  // Legacy waiting rows have no public launch identity. A covered simulation
  // must supply its own stable identity explicitly; never replace a real one.
  if (!row.launch_token && config.synthetic_launch_token) row.launch_token = config.synthetic_launch_token
  row.delivery = { awaiting_turn_start: 0 }
  if (config.fallback_needs_get) { delete config.fallback_needs_get; save() }
  answer(row)
}
if (verb === 'send-keys') {
  if (config.busy_send !== 'covered') {
    if (config.fallback_needs_get) error('ErrInternal', { fixture: 'raw fallback preceded fresh get' })
    process.exit(75)
  }
  const forbidden = ['--key', '--no-enter', '--request-token', '--as', '--expect-pane-sha256', '--n-lines']
  if (forbidden.some(key => key in options) || !options['--text']) error('ErrInvalidFlags')
  assert.equal(options['--send-mode'], 'wait_turn', 'missing wait_turn')
  assert.equal(options['--confirmed-delivery'], true, 'missing confirmation')
  const caller = options['--caller-uuid'], request = options['--delivery-request-id']
  assert(caller && request, 'missing custody identity')
  if (config.send === 'agent_not_covered') {
    config.busy_send = 'not_covered'; config.fallback_needs_get = true; save()
    error('ErrCantSend', { class: 'cant_send', reason: 'agent_not_covered', resend_safe: true, retry_with: 'new_send' })
  }
  assert(!('request' in config), 'duplicate covered submission')
  config.caller = caller; config.request = request; save()
  answer(fixtureBusyResult({ instance_id: config.instance_id, caller_uuid: String(caller), request_id: String(request) }, false))
}
assert.equal(options['--caller-uuid'], config.caller, 'wrong caller lookup')
assert.equal(options['--delivery-request-id'], config.request, 'wrong request lookup')
if (config.lookup === 'unknown') answer({ lookup: 'unknown', result: null })
answer({ lookup: 'found', result: fixtureBusyResult({ instance_id: config.instance_id,
  caller_uuid: config.caller, request_id: config.request }, true) })
