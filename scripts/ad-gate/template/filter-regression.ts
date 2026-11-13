// filter-regression.ts — the ad-gate job's permission filter regression.
//
// Shipped CSCB finds permission prompts with exactly one call, the permission
// poller's list({state: ['check_permission'], label: ['service=cscb']})
// through its pinned agent-director client. This drives a real row of the
// candidate agent-director, at its default [state] timeouts, into a relayed
// permission request whose relay hook then ends with no answer (the request
// falls back, the agent's own prompt stays unanswered), and makes that same
// call through the same client for HOLD_MS after the hook ends. The row must
// be listed at every read, more than 30 s after the hook ended included.
//
// Usage (as testuser, HOME a scratch home holding the candidate's install,
// PATH starting with the directory of perm-stub-claude.sh as `claude`):
//   bun filter-regression.ts <stub dir> <working directory>
// Last line: FILTER-REGRESSION PASS: … or FILTER-REGRESSION FAIL: …; exit 0 or 1.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CLIENT_DIR = '/test-repo/node_modules/agent-director'
const { Client } = await import(join(CLIENT_DIR, 'dist/index.js'))
const CSCB_PROMPT_LIST = { state: ['check_permission'], label: ['service=cscb'] }

const [stubDir, work] = process.argv.slice(2)
const HOLD_MS = Number(process.env.FILTER_HOLD_MS ?? 75000)
const POLL_MS = 2500
// The default needs_intelligence_timeout_seconds is 30: reads from 35 s on
// are past it with margin.
const PAST_TIMEOUT_MS = 35000
const MIN_PAST_TIMEOUT_READS = 3

const started = Date.now()
const say = (s: string) => console.log(`filter-regression: [${((Date.now() - started) / 1000).toFixed(1).padStart(5)} s] ${s}`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const describe = (e: any) => `${e?.name ?? 'Error'}: ${String(e?.message ?? e).split('\n')[0]}`

async function waitFor<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await probe()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`)
    await sleep(500)
  }
}

function verdict(pass: boolean, why: string): never {
  console.log(`FILTER-REGRESSION ${pass ? 'PASS' : 'FAIL'}: ${why}`)
  process.exit(pass ? 0 : 1)
}

if (!stubDir || !work) verdict(false, 'setup: usage: filter-regression.ts <stub dir> <working directory>')
const clientVersion = JSON.parse(readFileSync(join(CLIENT_DIR, 'package.json'), 'utf8')).version
const client = await Client.create()
say(`CSCB's pinned client ${clientVersion}; candidate binary ${client.binaryVersion} at ${client.binaryPath}`)

type Read = { at: number, listed: boolean, listError?: string, state?: string, delivery?: string[], getError?: string }
let id = ''
let outcome: { pass: boolean, why: string } | undefined
try {
  const spawned = await client.spawn({ cwd: work, agent: 'claude', relay_mode: 'on', label: ['service=cscb', 'persona=adgate'] })
  id = spawned.instance_id
  say(`spawned ${id} (relay on, label service=cscb)`)
  await waitFor('the row to report in (waiting)', 90000, async () => {
    const r = await client.get({ instance_id: id })
    return r.state === 'waiting' ? r : undefined
  })
  say('row reads waiting; firing the PermissionRequest hook')
  writeFileSync(join(stubDir, 'fire-permission'), '')
  const open = await waitFor('the relay hook to record its request (check_permission)', 30000, async () => {
    const r = await client.get({ instance_id: id })
    return r.state === 'check_permission' && (r.permission_requests?.length ?? 0) > 0 ? r : undefined
  })
  say(`request open: ${JSON.stringify(open.permission_requests.map((p: any) => ({ token: p.request_token, tool: p.tool_name, delivery: p.delivery })))}`)
  const control = await client.list(CSCB_PROMPT_LIST)
  if (!control.spawns.some((s: any) => s.instance_id === id)) {
    throw new Error('control: CSCB\'s list did not find the row while its relay hook was alive')
  }
  say('control: CSCB\'s list finds the row while its relay hook is alive; ending the hook')
  writeFileSync(join(stubDir, 'kill-hook'), '')
  const hookEnded = await waitFor('the stub to end the relay hook', 15000, async () =>
    existsSync(join(stubDir, 'hook-killed')) ? Number(readFileSync(join(stubDir, 'hook-killed'), 'utf8')) : undefined)

  const reads: Read[] = []
  while (Date.now() < hookEnded + HOLD_MS) {
    const read: Read = { at: Date.now() - hookEnded, listed: false }
    try {
      read.listed = (await client.list(CSCB_PROMPT_LIST)).spawns.some((s: any) => s.instance_id === id)
    } catch (e) { read.listError = describe(e) }
    try {
      const r = await client.get({ instance_id: id })
      read.state = r.state
      read.delivery = (r.permission_requests ?? []).map((p: any) => String(p.delivery))
    } catch (e) { read.getError = describe(e) }
    reads.push(read)
    say(`+${(read.at / 1000).toFixed(1)} s after the hook ended: CSCB's list ${read.listed ? 'finds' : 'MISSES'} the row` +
      `${read.listError ? ` (${read.listError})` : ''}; get: ${read.getError ?? `state ${read.state}, delivery ${JSON.stringify(read.delivery)}`}`)
    await sleep(POLL_MS)
  }

  const fellBack = reads.some(r => r.state === 'needs_intelligence' || (r.delivery ?? []).includes('fallen_back'))
  const late = reads.filter(r => r.at >= PAST_TIMEOUT_MS)
  const misses = reads.filter(r => !r.listed)
  const states = [...new Set(reads.map(r => r.state ?? 'unread'))].join(', ')
  if (!fellBack) {
    outcome = { pass: false, why: `invalid run: the request never read fallen_back and the row never read needs_intelligence (get states: ${states}), so the regression's condition was not reached` }
  } else if (late.length < MIN_PAST_TIMEOUT_READS) {
    outcome = { pass: false, why: `invalid run: only ${late.length} reads at or after ${PAST_TIMEOUT_MS / 1000} s` }
  } else if (misses.length) {
    const first = misses[0]
    outcome = { pass: false, why: `list({state:['check_permission'],label:['service=cscb']}) missed the held row at ${misses.length} of ${reads.length} reads, first at ${(first.at / 1000).toFixed(1)} s after its relay hook ended (get read ${first.state ?? first.getError}${first.listError ? `; list: ${first.listError}` : ''}); get states seen: ${states}` }
  } else {
    outcome = { pass: true, why: `list({state:['check_permission'],label:['service=cscb']}) found the held row at all ${reads.length} reads up to ${(reads[reads.length - 1].at / 1000).toFixed(1)} s after its relay hook ended (${late.length} past ${PAST_TIMEOUT_MS / 1000} s); get states seen: ${states}` }
  }
} catch (e) {
  outcome = { pass: false, why: `setup: ${describe(e)}` }
} finally {
  if (id) {
    try { await client.kill({ instance_id: id }) } catch (e) { say(`kill ${id}: ${describe(e)}`) }
  }
  client.close()
}
verdict(outcome!.pass, outcome!.why)
