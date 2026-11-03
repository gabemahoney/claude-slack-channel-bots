/** every actual launch prepares current bytes and fails closed, and every plain and reuse spawn passes its persona's own start arguments and Start Labels. */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpawnParams } from 'agent-director'
import { buildTemplateParams, EFFORT_ARG_PREFIX, MODEL_ARG_PREFIX } from '../src/agent-director-template.ts'
import { prepareBotSystemPrompt, botSystemPromptPath } from '../src/bot-system-prompt.ts'
import type { EffortLevel } from '../src/config.ts'
import { LATCH_CASE_LEFTOVER, LATCH_CASE_NO_VALID_ID, LATCH_ROW_STATE_NO_ROW, latchRowStateRead, REFUSED_OPERATION_PLAIN_SPAWN, REFUSED_OPERATION_RESUME, REFUSED_OPERATION_REUSE_SPAWN, type ConflictLatchSetInput } from '../src/conflict-latch.ts'
import { LIVENESS_DEAD_ROW_ENDED } from '../src/liveness-reading.ts'
import { CONFIG_DIR_LABEL_PREFIX, EFFORT_LABEL_KEY, EFFORT_LABEL_PREFIX, effortLabelValue, MODEL_LABEL_KEY, MODEL_LABEL_PREFIX, modelLabelValue, PERSONA_LABEL_PREFIX, personaInstanceId, personaSpawnEnv, personaTmuxSessionName, SERVICE_LABEL } from '../src/persona-identity.ts'
import { REPLY_TOOL_PREALLOWED_LABEL } from '../src/reply-reminder.ts'
import { TAG_DESCRIPTION } from '../src/tag-description.ts'
import { _forceResumeForPersona, _forceReuseSpawnForPersona, compareRowToPersona, launchSession, setSystemPromptPreparer } from '../src/session-manager.ts'
import { collided, makeRecoveryHarness, personaOf, personaRow, type RecoveryHarness, type RecoveryHarnessOptions, type RecoveryStubScript } from './test-helpers/recovery-harness.ts'
import { cannedErr, cannedStatusResult, errInstanceIdCollision, errNoSessionId, errSpawnNotFound, type PersonaGetResultOverrides } from './test-helpers/agent-director-stub.ts'
import type { PersonaSpec } from './test-helpers/persona-config.ts'
import { useImmediateTypingLifecycle } from './test-helpers/legacy-typing.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
useImmediateTypingLifecycle()
const runs: RecoveryHarness[] = []
afterEach(() => { setSystemPromptPreparer(undefined); for (const h of runs.splice(0)) { try { assertNoLeak(h.captured()) } finally { h.cleanup() } } })
function build() { const h = makeRecoveryHarness({ harnessNow: true }); runs.push(h); return h }
function buildWith(personas: PersonaSpec[], options: RecoveryHarnessOptions = {}) { const h = makeRecoveryHarness({ ...options, personas }); runs.push(h); return h }

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

/** A persona's `model` and `effort`, as a case sets them. */
interface StartValues { readonly model?: string; readonly effort?: EffortLevel }

/** Both keys, each key alone and neither. */
const START_VALUES: ReadonlyArray<readonly [string, StartValues]> = [
  ['both keys', { model: 'opus-test-model', effort: 'high' }],
  ['model only', { model: 'sonnet-test-model' }],
  ['effort only', { effort: 'low' }],
  ['neither key', {}],
]

/** The template's arguments with the set elements inserted, model then effort, before the trailing snapshot pair. */
function expectedArgs(h: RecoveryHarness, values: StartValues): string[] {
  const base = buildTemplateParams(h.config).agent_args!
  const pair = base.indexOf('--system-prompt-snapshot')
  expect(pair).toBe(base.length - 2)
  const set = [...(values.model === undefined ? [] : [`${MODEL_ARG_PREFIX}${values.model}`]), ...(values.effort === undefined ? [] : [`${EFFORT_ARG_PREFIX}${values.effort}`])]
  return [...base.slice(0, pair), ...set, ...base.slice(pair)]
}

/** Persona `key`'s plain spawn: today's five labels in today's order, then the set Start Labels, model then effort. */
function expectedPlainSpawn(h: RecoveryHarness, key: string, values: StartValues): SpawnParams {
  const persona = personaOf(h, key)
  return {
    agent: 'claude',
    template: buildTemplateParams(h.config).name,
    cwd: persona.working_directory,
    instance_id: personaInstanceId(key),
    relay_mode: 'on',
    tmux_session_name: personaTmuxSessionName(key),
    agent_args: expectedArgs(h, values),
    label: [
      SERVICE_LABEL,
      'tag_prompt=1',
      REPLY_TOOL_PREALLOWED_LABEL,
      `${PERSONA_LABEL_PREFIX}${key}`,
      `${CONFIG_DIR_LABEL_PREFIX}${personaRow(h, key).labels.config_dir}`,
      ...(values.model === undefined ? [] : [`${MODEL_LABEL_PREFIX}${modelLabelValue(values.model)}`]),
      ...(values.effort === undefined ? [] : [`${EFFORT_LABEL_PREFIX}${effortLabelValue(values.effort)}`]),
    ],
    extra_env: personaSpawnEnv({ key, crontablePath: h.config.cron_table_path, claudeConfigDir: persona.claude_config_dir }),
  }
}

/** Persona `key`'s row read `ended`, carrying its Start Labels, so a resume route stays a resume under a Start Values comparison. */
function finishedRow(h: RecoveryHarness, key: string, overrides: PersonaGetResultOverrides = {}): PersonaGetResultOverrides {
  const { model, effort } = personaOf(h, key)
  const labels = { ...personaRow(h, key).labels }
  if (model !== undefined) labels[MODEL_LABEL_KEY] = modelLabelValue(model)
  if (effort !== undefined) labels[EFFORT_LABEL_KEY] = effortLabelValue(effort)
  return { state: LIVENESS_DEAD_ROW_ENDED, labels, ...overrides }
}

const WITH_SESSION = { session_id: 'a-session-id' }
const ENDED_STATUS: RecoveryStubScript = { statusResult: cannedStatusResult({ state: LIVENESS_DEAD_ROW_ENDED }) }
const RESUME_LATCH: ConflictLatchSetInput = { latchCase: LATCH_CASE_NO_VALID_ID, refusedOperation: REFUSED_OPERATION_RESUME, rowState: latchRowStateRead(LIVENESS_DEAD_ROW_ENDED) }

/** Latch P with `latch`, script `knobs` and run P's first latch re-check round. */
async function recheck(h: RecoveryHarness, p: string, latch: ConflictLatchSetInput, knobs: RecoveryStubScript): Promise<number> {
  h.latchSet.set(p, latch)
  h.script(knobs)
  return h.advanceToRecheck()
}

/** A path that spawns: its harness options, the spawns and resumes it makes, in order, and how it is driven for P. */
interface SpawnRoute {
  readonly options?: RecoveryHarnessOptions
  readonly spawns: ReadonlyArray<'plain' | 'reuse'>
  readonly resumes: number
  drive(h: RecoveryHarness, p: string): Promise<unknown>
}

const RECHECK: RecoveryHarnessOptions = { latchRecheck: true }

const SPAWN_ROUTES: ReadonlyArray<readonly [string, SpawnRoute]> = [
  ['the ladder\'s first plain spawn at the start bring-up (spawnForPersona)', { spawns: ['plain'], resumes: 0, drive: (h, p) => h.launch(p) }],
  ['the ladder\'s first plain spawn on the restart path (launchSession)', { spawns: ['plain'], resumes: 0, drive: (h, p) => launchSession(p, h.config) }],
  ['the ladder\'s resume', { spawns: ['plain'], resumes: 1, drive: (h, p) => { h.script(collided(h, personaOf(h, p), finishedRow(h, p, WITH_SESSION))); return h.launch(p) } }],
  ['the ladder\'s plain spawn after the resume\'s ErrSpawnNotFound', { spawns: ['plain', 'plain'], resumes: 1, drive: (h, p) => { h.script({ ...collided(h, personaOf(h, p), finishedRow(h, p, WITH_SESSION)), resumeError: errSpawnNotFound() }); return h.launch(p) } }],
  ['the ladder\'s finished-row reuse (row in another directory)', { spawns: ['plain', 'reuse'], resumes: 0, drive: (h, p) => { h.script(collided(h, personaOf(h, p), finishedRow(h, p, { cwd: h.home }))); return h.launch(p) } }],
  ['the ladder\'s no-transcript reuse', { spawns: ['plain', 'reuse'], resumes: 1, drive: (h, p) => { h.script({ ...collided(h, personaOf(h, p), finishedRow(h, p, WITH_SESSION)), resumeError: errNoSessionId() }); return h.launch(p) } }],
  ['the live-row sequence\'s reuse', { spawns: ['reuse'], resumes: 0, drive: (h, p) => { h.script({ getResult: personaRow(h, p, finishedRow(h, p)) }); return h.runSequence(p, { lastReadState: cannedStatusResult().state }) } }],
  ['the live-row sequence\'s plain spawn after the resume\'s ErrSpawnNotFound', { spawns: ['plain'], resumes: 1, drive: (h, p) => { h.script({ getResult: personaRow(h, p, finishedRow(h, p, WITH_SESSION)), resumeError: errSpawnNotFound() }); return h.runSequence(p, { lastReadState: cannedStatusResult().state, keepsConversation: true }) } }],
  ['the latch re-check\'s plain spawn', { options: RECHECK, spawns: ['plain'], resumes: 0, drive: (h, p) => recheck(h, p, { latchCase: LATCH_CASE_LEFTOVER, refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: LATCH_ROW_STATE_NO_ROW }, { statusError: errSpawnNotFound() }) }],
  ['the latch re-check\'s reuse', { options: RECHECK, spawns: ['reuse'], resumes: 0, drive: (h, p) => recheck(h, p, { ...RESUME_LATCH, refusedOperation: REFUSED_OPERATION_REUSE_SPAWN }, ENDED_STATUS) }],
  ['the latch re-check\'s resume', { options: RECHECK, spawns: [], resumes: 1, drive: (h, p) => recheck(h, p, RESUME_LATCH, { ...ENDED_STATUS, getResult: personaRow(h, p, finishedRow(h, p, WITH_SESSION)) }) }],
  ['the latch re-check\'s spawn after the resume\'s ErrSpawnNotFound', { options: RECHECK, spawns: ['plain'], resumes: 1, drive: (h, p) => recheck(h, p, RESUME_LATCH, { ...ENDED_STATUS, getResult: personaRow(h, p, finishedRow(h, p, WITH_SESSION)), resumeError: errSpawnNotFound() }) }],
  ['the forced reuse spawn', { spawns: ['reuse'], resumes: 0, drive: (h, p) => _forceReuseSpawnForPersona(personaOf(h, p), h.config) }],
  ['the forced resume\'s spawn after ErrSpawnNotFound', { spawns: ['plain'], resumes: 1, drive: (h, p) => { h.script({ resumeError: errSpawnNotFound() }); return _forceResumeForPersona(personaOf(h, p), h.config) } }],
]

describe('spawn start arguments and Start Labels', () => {
  test.each(SPAWN_ROUTES.flatMap(([route, spec]) => START_VALUES.map(([set, values]) => [route, set, spec, values] as const)))('%s, %s: each spawn is the plain spawn (a reuse adds only reuse_finished); resume passes only the instance id', async (_route, _set, route, values) => {
    const h = buildWith([{ model: 'neighbour-test-model', effort: 'medium' }, values], route.options), p = h.keys[1]!
    await route.drive(h, p)
    await h.settle()
    const plain = expectedPlainSpawn(h, p, values)
    expect(h.stub.calls.spawnCalls).toEqual(route.spawns.map(kind => (kind === 'reuse' ? { ...plain, reuse_finished: true } : plain)))
    expect(h.stub.calls.resumeCalls).toEqual(Array(route.resumes).fill({ instance_id: personaInstanceId(p) }))
    const { model } = values
    if (model !== undefined) expect(h.stub.calls.spawnCalls.flatMap(params => [...params.label!, ...Object.values(params.extra_env!)]).filter(value => value.includes(model))).toEqual([])
  })

  test.each(['-starts-with-a-dash', 'holds some spaces', 'holds=an-equals-sign'])('model %p is the one element --model=<value>, never --model and a value element', async model => {
    const h = buildWith([{ model }, {}]), p = h.keys[0]!
    expect((await h.launch(p)).action).toBe('spawned')
    const args = h.stub.calls.spawnCalls[0]!.agent_args!
    expect(args).toEqual(expectedArgs(h, { model }))
    expect(args.filter(arg => arg.includes(model))).toEqual([`${MODEL_ARG_PREFIX}${model}`])
    expect(args).not.toContain('--model')
  })

  test.each([['the persona with values first', 0, 1], ['the persona with none first', 1, 0]] as const)('two personas side by side, %s: each spawn carries only its own persona\'s values', async (_order, first, second) => {
    const both: StartValues = { model: 'opus-test-model', effort: 'max' }
    const h = buildWith([both, {}]), [p, q] = h.keys as [string, string]
    for (const key of [h.keys[first]!, h.keys[second]!]) expect((await h.launch(key)).action).toBe('spawned')
    await h.settle()
    const expected = { [p]: expectedPlainSpawn(h, p, both), [q]: expectedPlainSpawn(h, q, {}) }
    expect(h.stub.calls.spawnCalls).toEqual([expected[h.keys[first]!], expected[h.keys[second]!]])
  })
})
