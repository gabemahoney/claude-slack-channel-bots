import { expect, test } from 'bun:test'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeReloadHarness } from './test-helpers/reload-harness.ts'
import { makeChannelMessage } from './test-helpers/slack-stub.ts'
import { membershipPage } from './test-helpers/shared-channels.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const scenario = readFileSync(new URL('./real-agent/ai-scenario.sh', import.meta.url), 'utf8')
const condition = scenario.indexOf(' == receive_all ]]; then\n')
const branch = scenario.slice(scenario.lastIndexOf('\n', condition) + 1, scenario.indexOf('\n        fi', condition) + '\n        fi'.length)
const move = branch.split('\n').find(line => line.trimStart().startsWith('mv '))!
const wait = branch.split('\n').find(line => line.trimStart().startsWith('wait_until '))!
const library = readFileSync(new URL('./integration/lib/scenario.sh', import.meta.url), 'utf8')
const writersStart = library.indexOf('write_file() {')
const writers = library.slice(writersStart, library.indexOf('\n# ---------------------------------------------------------------------------', writersStart))
const channel = 'C0TESTCHAN1'

test.each([11, 20])('AC%i receive_all scenario applies corpuspeer off while the tested persona keeps receiving', async criterion => {
  const h = makeReloadHarness(), tested = `aiac${criterion}`, outputs: unknown[] = []
  try {
    const personas = [tested, 'corpuspeer'].map(name => h.persona(name, {
      channels: [{ id: channel, delivery: 'all' }], permission_prompts: 'dm',
      dm: { enabled: true, contact: 'U0TESTUSER1' },
    }))
    h.materialize(...personas)
    h.writeRecord({ personas }); h.writeConfig({ personas })
    const run = await h.startDetecting({ realLifecycle: true })
    await run.ticks.tick()
    for (const name of [tested, 'corpuspeer']) {
      run.registerSession(name)
      run.stub(name).script.inventory.push(membershipPage([channel]))
    }
    await run.membershipClock.runNext()
    const expected = join(h.root, 'expected'); mkdirSync(expected)
    writeFileSync(join(expected, 'corpus.json'), JSON.stringify([{ msg: { via: 'receive_all' } }]))
    function shell(script: string) {
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
        env: hostSafeChildEnv(h.home, { tools: ['bash', 'jq', 'cat', 'mv', 'mktemp', 'dirname', 'chmod'], extras: {
          SLACK_STATE_DIR: h.dir, EXPECTED: expected, n: '1', AI_CRITERION: String(criterion),
        } }), encoding: 'utf8', timeout: 5000,
      })
      outputs.push({ status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error })
      expect(result.error).toBeUndefined()
      return result
    }
    const probe = () => shell(`wait_until() { shift 2; "$@"; }\n${wait}`)
    async function recipients(ts: string) {
      const received: string[] = []
      for (const name of [tested, 'corpuspeer']) {
        const before = run.deliveries(name).length
        await run.deliver(name, makeChannelMessage({ channel, ts }))
        if (run.deliveries(name).length > before) received.push(name)
      }
      return received
    }
    expect(await recipients('1792000000.000001')).toEqual([tested, 'corpuspeer'])
    expect(probe().status).not.toBe(0)
    // Execute the real branch until its pending-file boundary; the production
    // controller supplies the preview and apply between these shell phases.
    expect(shell(`fail() { exit 1; }\n${writers}\nwait_for_file() { exit 0; }\n${branch}`).status).toBe(0)
    expect(probe().status).not.toBe(0) // editing config.json is not application
    await run.ticks.tick()
    expect(h.pendingExists()).toBe(true)
    expect(shell(move).status).toBe(0)
    const logStart = run.logs.length
    await run.ticks.tick()
    expect(await recipients('1792000000.000002')).toEqual([tested])
    expect(run.deliveries(tested).at(-1)!.via).toBe('receive_all')
    expect(run.controller.applied()!.config.personas.find(p => p.name === 'corpuspeer')!.channels)
      .toContainEqual({ id: channel, delivery: 'off' })
    expect(run.controller.applied()!.config.personas.find(p => p.name === tested)!.channels)
      .toContainEqual({ id: channel, delivery: 'all' })
    expect(run.logs.slice(logStart).some(line => line.startsWith('[slack] reload-applied:'))).toBe(true)
    expect(probe().status).toBe(0)
    expect(run.slackPosts()).toEqual([])
  } finally {
    try { for (const run of h.runs) assertNoLeak(run.captured({ outputs, config: writtenFile(h.paths.config) })) }
    finally { await h.cleanup() }
  }
})
