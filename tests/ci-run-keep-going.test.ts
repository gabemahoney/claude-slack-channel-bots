/** public runner contracts. No ambient credentials or external processes. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runner from '../scripts/ci-run.ts'
import * as reader from '../scripts/ci-verdict.ts'
import { buildWorktree, createSpawnRecorder, realScriptFileName } from './test-helpers/ci-run.ts'
import { assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('keep-going is explicit and does not weaken gate eligibility', () => {
  test.each([
    ['default', [], false, true],
    ['full keep-going', ['--keep-going'], true, true],
    ['explicit shard count', ['--shards', '2', '--keep-going'], true, true],
    ['selected keep-going', ['test-2', '--keep-going'], true, false],
    ['injected keep-going', ['--keep-going', '--inject', 'fail:test-2'], true, false],
  ] as const)('%s', (_label, args, keepGoing, gate) => {
    const parsed = runner.argumentStage(args)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.invocation).toHaveProperty('keepGoing', keepGoing)
    expect(runner.isGateEligible(parsed.invocation)).toBe(gate)
    expect(parsed.invocation.args).toEqual(args)
  })

  test.each(['--keep-going=true', '--keep-going=false'])('does not accept ambiguous boolean spelling %s', arg => {
    expect(runner.argumentStage([arg]).ok).toBe(false)
  })

  test('the verdict reader recognizes a complete full keep-going PASS', () => {
    expect(reader.judgeFirstLine(['--keep-going'], runner.PASS_VERDICT))
      .toEqual(reader.judgeFirstLine([], runner.PASS_VERDICT))
  })

  test.each([
    ['selected', ['test-2', '--keep-going']],
    ['injected', ['--keep-going', '--inject', 'fail:test-2']],
  ] as const)('a bare PASS cannot upgrade %s work into a full gate', (_label, args) => {
    expect(reader.judgeFirstLine(args, runner.PASS_VERDICT))
      .not.toEqual(reader.judgeFirstLine([], runner.PASS_VERDICT))
  })
})

describe('CI-prefixed credentials are direct runner inputs', () => {
  test.each(['raw', 'gateway'] as const)('%s input validates without host ANTHROPIC assignments', kind => {
    const env = {
      CI_ANTHROPIC_API_KEY: fakeToken(kind === 'raw' ? runner.RAW_KEY_PREFIX : '', `pb8-${kind}`),
      CI_ANTHROPIC_MODEL: 'fixture/model',
      ...(kind === 'gateway' ? { CI_ANTHROPIC_BASE_URL: 'https://gateway.invalid/v1' } : {}),
    }
    const before = { ...env }
    const failures = runner.checkCredentials(env)
    assertNoLeak(failures)
    expect(failures).toEqual([])
    expect(JSON.stringify(env) === JSON.stringify(before)).toBe(true)
    expect(Object.keys(env).some(name => name.startsWith('ANTHROPIC_'))).toBe(false)
  })

  test('the real validation pipeline accepts CI input and keep-going together', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-pb8-'))
    roots.push(root)
    const worktree = buildWorktree(root, { scripts: [realScriptFileName(1), realScriptFileName(2)] })
    const validated = runner.validateRun(['--keep-going'], worktree.root, {
      CI_ANTHROPIC_API_KEY: fakeToken(runner.RAW_KEY_PREFIX, 'pb8-validation'),
    })
    assertNoLeak(validated)
    expect(validated.ok).toBe(true)
  })

  test.each(['empty CI key', 'CI gateway without its own URL'] as const)('%s never borrows personal credentials or routing', kind => {
    const env = {
      CI_ANTHROPIC_API_KEY: kind === 'empty CI key' ? '' : fakeToken('', 'pb8-ci-gateway'),
      ANTHROPIC_API_KEY: fakeToken(runner.RAW_KEY_PREFIX, 'pb8-legacy'),
      ANTHROPIC_BASE_URL: 'https://personal.invalid/v1',
    }
    const failures = runner.checkCredentials(env)
    assertNoLeak(failures)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ kind: 'missing', variable: 'CI_ANTHROPIC_API_KEY' })
  })

  test('secret scanning includes the CI key but excludes CI model and base URL', () => {
    const key = fakeToken(runner.RAW_KEY_PREFIX, 'pb8-scan')
    const model = 'fixture-model', url = 'https://gateway.invalid/v1'
    const secrets = runner.secretCredentialSet({ CI_ANTHROPIC_API_KEY: key, CI_ANTHROPIC_MODEL: model, CI_ANTHROPIC_BASE_URL: url })
    // Boolean operands keep even regression diagnostics free of fake secrets.
    expect(secrets.has(key)).toBe(true)
    expect(secrets.has(model)).toBe(false)
    expect(secrets.has(url)).toBe(false)
    expect(secrets.size).toBe(1)
  })

  test('the verdict reader gathers the CI key and masks it in reports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-pb8-reader-'))
    roots.push(root)
    const recorder = createSpawnRecorder({ root, clock: createFakeClock() })
    recorder.answer(runner.GH_AUTH_TOKEN_ARGV, { exitCode: 1 })
    const key = fakeToken(runner.RAW_KEY_PREFIX, 'pb8-reader')
    const values = await reader.gatherSecretValues({
      spawn: recorder.spawn, worktreeRoot: root,
      env: { HOME: root, CI_ANTHROPIC_API_KEY: key },
    })
    recorder.assertNoFailures()
    expect(values.has(key)).toBe(true)
    const masked = reader.secretMask(values)(`failed workload: ${key}`)
    expect(masked.includes(key)).toBe(false)
    assertNoLeak(masked)
    expect(recorder.spawns().every(spawn => !spawn.argv.some(arg => arg.includes(key)))).toBe(true)
  })

  test.each([
    ['missing', {}], ['empty', { CI_ANTHROPIC_API_KEY: '' }],
    ['gateway without URL', { CI_ANTHROPIC_API_KEY: fakeToken('', 'pb8-no-url') }],
    ['short', { CI_ANTHROPIC_API_KEY: 'short', CI_ANTHROPIC_BASE_URL: 'https://gateway.invalid/v1' }],
  ] as const)('%s CI key is refused without quoting its value', (_label, env) => {
    const failures = runner.checkCredentials({ CI_ANTHROPIC_MODEL: 'fixture/model', ...env })
    assertNoLeak(failures)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ variable: 'CI_ANTHROPIC_API_KEY' })
  })
})

describe('durable notrun reasons', () => {
  test.each(['fail-fast', 'unsafe-cleanup', `dependency:${realScriptFileName(2)}`])('%s survives the production result-file codec', reason => {
    const line = `${runner.RESULT_WORD_NOTRUN} ${realScriptFileName(3)} ${reason}`
    const event = runner.parseResultLine(line)
    expect(event).not.toBeNull()
    if (event === null) return
    expect(runner.formatResultLine(event)).toBe(line)
  })

  test('old reasonless records remain readable', () => {
    const line = `${runner.RESULT_WORD_NOTRUN} ${realScriptFileName(3)}`
    const event = runner.parseResultLine(line)
    expect(event).not.toBeNull()
    if (event !== null) expect(runner.formatResultLine(event)).toBe(line)
  })

  test.each(['unknown-reason', 'dependency:', 'unsafe-cleanup extra', 'dependency:../foreign.sh'])('malformed reason %s fails closed', reason => {
    expect(runner.parseResultLine(`${runner.RESULT_WORD_NOTRUN} ${realScriptFileName(3)} ${reason}`)).toBeNull()
  })
})

describe('performance guard uses one shared/exclusive flock inode', () => {
  test('shared work overlaps, exclusive measurement waits for every reader, and release permits the next run', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-pb8-lock-'))
    roots.push(root)
    const path = join(root, runner.PERFORMANCE_LOCK_FILE)
    const files: runner.LockFile[] = []
    const open = (mode: 'shared' | 'exclusive') => {
      const result = runner.openLockFile(path, mode)
      if (!result.ok) throw new Error(result.error)
      files.push(result.value)
      return result.value
    }
    try {
      const first = open('shared'), second = open('shared'), measurement = open('exclusive')
      expect(first.tryLock()).toEqual({ kind: 'taken' })
      expect(second.tryLock()).toEqual({ kind: 'taken' })
      expect(measurement.tryLock()).toEqual({ kind: 'held' })
      first.release()
      expect(measurement.tryLock()).toEqual({ kind: 'held' })
      second.release()
      expect(measurement.tryLock()).toEqual({ kind: 'taken' })
      const nextWork = open('shared'), nextMeasurement = open('exclusive')
      expect(nextWork.tryLock()).toEqual({ kind: 'held' })
      expect(nextMeasurement.tryLock()).toEqual({ kind: 'held' })
      measurement.release()
      expect(nextWork.tryLock()).toEqual({ kind: 'taken' })
      expect(nextMeasurement.tryLock()).toEqual({ kind: 'held' })
      nextWork.release()
      expect(nextMeasurement.tryLock()).toEqual({ kind: 'taken' })
    } finally {
      for (const file of files) file.release()
    }
  })
})
