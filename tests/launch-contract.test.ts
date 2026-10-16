/** b.omv SR-7.2/4/6: every actual launch prepares current bytes and fails closed. */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareBotSystemPrompt, botSystemPromptPath } from '../src/bot-system-prompt.ts'
import { TAG_DESCRIPTION } from '../src/tag-description.ts'
import { compareRowToPersona, setSystemPromptPreparer } from '../src/session-manager.ts'
import { makeRecoveryHarness, personaOf, personaRow, type RecoveryHarness } from './test-helpers/recovery-harness.ts'
import { cannedErr, errInstanceIdCollision } from './test-helpers/agent-director-stub.ts'
import { useImmediateTypingLifecycle } from './test-helpers/legacy-typing.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
useImmediateTypingLifecycle()
const runs: RecoveryHarness[] = []
afterEach(() => { setSystemPromptPreparer(undefined); for (const h of runs.splice(0)) { try { assertNoLeak(h.captured()) } finally { h.cleanup() } } })
function build() { const h = makeRecoveryHarness({ harnessNow: true }); runs.push(h); return h }

describe('production launch prompt gate', () => {
  test.each(['spawn', 'reuse', 'resume'] as const)('%s prepares immediately before the AD call, reads changed operator bytes, carries fixed launch controls', async route => {
    const h = build(), p = h.keys[0]!, persona = personaOf(h, p)
    const file = join(h.home, 'operator.md')
    h.config.system_prompt_mode = 'append'; h.config.append_system_prompt_file = file
    writeFileSync(file, 'current operator instruction')
    const calls: string[] = []
    if (route === 'reuse') h.config.resume_enabled = false
    const row = personaRow(h, p, { state: 'ended' })
    if (route !== 'spawn') h.script({ spawnQueue: [cannedErr(errInstanceIdCollision())], getResult: route === 'reuse' ? { ...row, session_id: '' } : { ...row, session_id: 'marked-session' } })
    setSystemPromptPreparer(key => {
      calls.push(key)
      prepareBotSystemPrompt(h.config, h.stateDir)
    })
    const stub = h.stub.client
    const spawn = stub.spawn, resume = stub.resume
    const expectPrepared = () => expect(readFileSync(botSystemPromptPath(h.stateDir), 'utf8')).toBe(TAG_DESCRIPTION + '\n\ncurrent operator instruction')
    stub.spawn = async params => { expectPrepared(); return spawn(params) }
    stub.resume = async params => { expectPrepared(); return resume(params) }
    expect((await h.launch(p)).action).toBe(route === 'resume' ? 'resumed' : 'spawned')
    await h.settle()
    expect(calls).toEqual(Array(route === 'spawn' ? 1 : 2).fill(p))
    for (const params of h.stub.calls.spawnCalls) {
      expect(params.label).toContain('tag_prompt=1')
      expect(params.extra_env).toMatchObject({ DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' })
    }
    expect(h.stub.calls.deleteCalls).toEqual([])
  })

  test.each(['reuse', 'resume'] as const)('%s cannot use an earlier successful preparation after its own refresh fails', async route => {
    const h = build(), p = h.keys[0]!
    if (route === 'reuse') h.config.resume_enabled = false
    h.script({ spawnQueue: [cannedErr(errInstanceIdCollision())], getResult: personaRow(h, p, { state: 'ended', session_id: 'marked-conversation' }) })
    let writes = 0
    setSystemPromptPreparer(() => {
      writes++
      prepareBotSystemPrompt(h.config, h.stateDir, writes === 2 ? { writeFile: () => { throw new Error('second refresh failed') } } : {})
    })
    expect(await h.launch(p)).toEqual({ key: p, action: 'retrying' })
    expect(writes).toBe(2)
    expect(readFileSync(botSystemPromptPath(h.stateDir), 'utf8')).toBe(TAG_DESCRIPTION)
    expect(h.stub.calls.spawnCalls).toHaveLength(1)
    expect(h.stub.calls.resumeCalls).toEqual([])
    expect(h.triggers).toEqual([{ key: p, kind: 'system-prompt-unwritable' }])
    expect(h.controller.isArmed(p)).toBe(true)
  })

  test('a failed refresh with an older readable prompt blocks AD, arms the existing retry and lets another persona progress', async () => {
    const h = build(), [p, q] = h.keys as [string, string]
    const path = botSystemPromptPath(h.stateDir)
    writeFileSync(path, 'older generated prompt')
    let broken = true
    setSystemPromptPreparer(key => prepareBotSystemPrompt(h.config, h.stateDir, key === p && broken ? { writeFile: () => { throw Object.assign(new Error('injected write failure'), { code: 'EIO' }) } } : {}))
    expect(await h.launch(p)).toEqual({ key: p, action: 'retrying' })
    expect(readFileSync(path, 'utf8')).toBe('older generated prompt')
    expect(h.stub.calls.spawnCalls).toEqual([])
    expect(h.stub.calls.resumeCalls).toEqual([])
    expect(h.triggers).toEqual([{ key: p, kind: 'system-prompt-unwritable' }])
    expect(h.controller.isArmed(p)).toBe(true)
    expect((await h.launch(q)).action).toBe('spawned')
    broken = false
    expect((await h.launch(p)).action).toBe('spawned')
    await h.settle()
    expect(h.stub.calls.spawnCalls.map(call => call.instance_id)).toEqual([`cscb_${q}`, `cscb_${p}`])
    expect(h.stub.calls.deleteCalls).toEqual([])
  })

  test.each([undefined, '0', 'true', '1'])('row marker %p is accepted only as the exact current provenance', marker => {
    const h = build(), p = h.keys[0]!, persona = personaOf(h, p)
    const row = personaRow(h, p)
    const { tag_prompt: _current, ...labels } = row.labels
    const reading = compareRowToPersona({ ...row, labels: marker === undefined ? labels : { ...labels, tag_prompt: marker } }, persona, h.home)
    expect(reading.tagPrompt).toBe(marker === '1')
    expect(reading.cwdMatches).toBe(true)
    expect(reading.configDirMatches).toBe(true)
  })
})
