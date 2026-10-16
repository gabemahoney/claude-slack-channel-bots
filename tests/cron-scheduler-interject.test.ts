/** Real scheduler -> direct dispatcher -> durable queue composition. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCronScheduler } from '../src/cron-scheduler.ts'
import { createCronDispatcher } from '../src/cron-dispatch.ts'
import { createCronLog } from '../src/cron-log.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeQueue } from './test-helpers/delivery-queue.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { resolvePersonaTarget } from '../src/persona-identity.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
let dir: string, queue: Awaited<ReturnType<typeof makeQueue>>, scheduler: ReturnType<typeof createCronScheduler> | undefined
let clock: ReturnType<typeof createFakeClock>
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'cron-composition-')); clock = createFakeClock({start:Date.parse('2026-01-15T10:30:30.000Z')}); queue = await makeQueue(dir,{now:clock.now}) })
afterEach(async () => { scheduler?.stop(); expect(clock.pendingCount()).toBe(0); await queue.stop(); rmSync(dir,{recursive:true,force:true}) })
test('manual ticks queue every matching fire separately, keep exact sender/body and use the same fire clock in logs',async()=>{
 const config=makeMultiPersonaConfig([{name:'Planner'},{name:'reviewer'}],dir);const table=join(dir,'crontab'),path=join(dir,'tick.md'),log=join(dir,'cron.log');writeFileSync(path,'first');writeFileSync(table,'* * * * * tick.md reviewer\n')
 const cronLog=createCronLog(log);const dispatcher=createCronDispatcher({accept:queue.accept,now:clock.now,cronLog,cronTablePath:table,resolveTarget:t=>resolvePersonaTarget(config,t)?.key})
 scheduler=createCronScheduler({dispatcher,cronLog,cronTablePath:table,clock:{now:()=>new Date(clock.now()),setTimeout:clock.setTimeout as never,clearTimeout:clock.clearTimeout}});scheduler.start();await scheduler.tick();await scheduler.tick()
 expect(queue.items('reviewer').map(i=>[i.accepted.source,i.accepted.sender,i.accepted.text,i.accepted.received_at])).toEqual([['cron','cscb-cron:tick','first',clock.now()]]);expect(queue.items(config.personas[0]!.key)).toEqual([])
 writeFileSync(path,'second');await clock.advance(60000);await scheduler.tick();expect(queue.items('reviewer').map(i=>i.accepted.text)).toEqual(['first','second']);const text=readFileSync(log,'utf8');expect(text).toContain('queued=1 failed=0');expect(text).toContain(new Date(queue.items('reviewer')[1]!.accepted.received_at).toISOString());assertNoLeak({text})
})
