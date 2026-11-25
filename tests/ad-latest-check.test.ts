/** The publish CLI adapter, invoked in process; no Docker, network or child. */
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { AD_LATEST_CHECK_EXIT, AD_LATEST_CHECK_SR, adLatestFailureLine, runAdLatestCheck, type AdLatestCliDeps } from '../scripts/ad-latest-check.ts'
import { AD_BASE_RECORD_PATH, AD_LATEST_DEADLINE_MS, AD_GITHUB_CREDENTIAL_MISSING_REASON, AD_GITHUB_CREDENTIAL_INVALID_REASON, AD_GITHUB_CREDENTIAL_REJECTED_REASON, formatAdCheckError, type AdCheckError, type AdFetch } from '../scripts/lib/ad-latest.ts'
import { GH_AUTH_TOKEN_ARGV, GH_PERSONAL_CONFIG_SUBPATH } from '../scripts/ci-run.ts'
import { adBytes, adJson, makeAdLatestFixture, AD_FIXTURE_OTHER_VERSION } from './test-helpers/ad-latest.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { createSpawnRecorder, type SpawnRecorder } from './test-helpers/ci-run.ts'
import { assertNoLeak, fakeToken } from './test-helpers/credentials.ts'

const recorders: SpawnRecorder[] = []
afterEach(() => { for (const recorder of recorders.splice(0)) recorder.assertNoFailures() })

function rig() {
  const f = makeAdLatestFixture(), clock = createFakeClock()
  const root = '/fixture/worktree'
  const env = { HOME: '/fixture/home', LANG: 'C' }
  const recorder = createSpawnRecorder({ clock })
  recorders.push(recorder)
  recorder.answer(GH_AUTH_TOKEN_ARGV, { exitCode: 1 })
  const reads: string[] = [], baseReads: string[] = [], stdout: string[] = [], stderr: string[] = []
  const image = 'cscb-ci-base:v11'
  const files = new Map([
    [join(root, 'docker/Dockerfile.test.base'), f.sources.dockerfile],
    [join(root, 'package.json'), f.sources.packageJson], [join(root, 'bun.lock'), f.sources.lockfile],
    [join(root, 'docker/Dockerfile.test'), `FROM ${image}\n`],
  ])
  const deps: AdLatestCliDeps = {
    worktreeRoot: root, fetchAd: f.fetchAd, clock, spawn: recorder.spawn, env,
    readText(path: string) { reads.push(path); const text = files.get(path); if (text === undefined) throw new Error('untrusted read exception'); return text },
    async readBaseRecord(tag: string) { baseReads.push(tag); return { ok: true, bytes: f.recordBytes } },
    writeStdout: (text: string) => { stdout.push(text) }, writeStderr: (text: string) => { stderr.push(text) },
  }
  return { f, deps, clock, recorder, env, root, image, files, reads, baseReads, stdout, stderr }
}

/** Only the anonymous release response changes; the successful fixture still validates all pins and the base. */
function refusedRelease(r: ReturnType<typeof rig>, status: 403 | 429, signedInStatus?: number, delayMs = 0): AdFetch {
  return async (url, options) => {
    if (url === r.f.urls.release && (!options.githubCredential || signedInStatus !== undefined)) {
      r.f.requests.push({ url, options })
      if (delayMs) await new Promise<void>(resolve => r.clock.setTimeout(resolve, delayMs))
      return { status: options.githubCredential ? signedInStatus! : status, body: adBytes(fakeToken('', 'private-http-body')) }
    }
    return r.f.fetchAd(url, options)
  }
}
function publicOutputs(r: ReturnType<typeof rig>) {
  return { stdout: r.stdout, stderr: r.stderr, reads: r.reads, baseReads: r.baseReads,
    spawns: r.recorder.spawns().map(({ argv, env, cwd }) => ({ argv, env, cwd })) }
}

describe('fresh /publish prepare AD check', () => {
  test('checks latest and the present base before returning success', async () => {
    const r = rig()
    expect(await runAdLatestCheck(r.deps)).toBe(0)
    expect(r.baseReads).toEqual([r.image])
    expect(r.f.requests.length).toBe(6)
    expect(r.recorder.spawns()).toEqual([])
    expect(r.stderr).toEqual([])
    expect(r.clock.pendingCount()).toBe(0)
  })

  test('pin disagreement stops before HTTP or a base read', async () => {
    const r = rig()
    r.files.set(join(r.root, 'package.json'), r.f.sources.packageJson.replace(r.f.pins.clientVersion, AD_FIXTURE_OTHER_VERSION))
    expect(await runAdLatestCheck(r.deps)).toBe(AD_LATEST_CHECK_EXIT)
    expect(r.stderr.join('')).toContain('PACKAGE_PIN_MISMATCH')
    expect(r.baseReads).toEqual([])
    expect(r.f.requests).toEqual([])
  })

  test('unreadable pins fail with a safe code and no HTTP', async () => {
    const r = rig()
    r.files.delete(join(r.root, 'bun.lock'))
    expect(await runAdLatestCheck(r.deps)).toBe(AD_LATEST_CHECK_EXIT)
    expect(r.stderr.join('')).toContain('PINS_UNREADABLE')
    expect(r.stderr.join('')).not.toContain('untrusted read exception')
    expect(r.f.requests).toEqual([])
  })

  test('a fresh lookup failure cannot reuse an earlier successful invocation', async () => {
    const r = rig()
    expect(await runAdLatestCheck(r.deps)).toBe(0)
    r.f.routes.set(r.f.urls.release, { status: 429, body: adBytes('private server body') })
    expect(await runAdLatestCheck(r.deps)).toBe(AD_LATEST_CHECK_EXIT)
    expect(r.stderr.join('')).toContain('GITHUB_CREDENTIAL_MISSING')
    expect(r.stderr.join('')).not.toContain('private server body')
    expect(r.baseReads).toHaveLength(1)
  })

  test('fallback binds the bounded personal/plain lookup to the release checkout, then validates the base', async () => {
    const r = rig(), token = fakeToken('', 'release-lookup')
    const requestMs = 11, personalMs = 7
    r.recorder.answer(GH_AUTH_TOKEN_ARGV, { stdout: `${token}\n` })
    r.recorder.answer(GH_AUTH_TOKEN_ARGV, { exitCode: 1, delayMs: personalMs }, { times: 1 })
    const result = runAdLatestCheck({ ...r.deps, fetchAd: refusedRelease(r, 429, undefined, requestMs) })
    await r.clock.advance(requestMs + personalMs)
    expect(await result).toBe(0)
    expect(r.baseReads).toEqual([r.image])
    expect(r.recorder.spawns().map(({ argv, env, cwd, timeoutMs, atMs }) => ({ argv, env, cwd, timeoutMs, atMs }))).toEqual([
      { argv: GH_AUTH_TOKEN_ARGV, env: { ...r.env, GH_CONFIG_DIR: `${r.env.HOME}/${GH_PERSONAL_CONFIG_SUBPATH}` }, cwd: r.root, timeoutMs: AD_LATEST_DEADLINE_MS - requestMs, atMs: requestMs },
      { argv: GH_AUTH_TOKEN_ARGV, env: r.env, cwd: r.root, timeoutMs: AD_LATEST_DEADLINE_MS - requestMs - personalMs, atMs: requestMs + personalMs },
    ])
    expect(r.f.requests.filter(request => request.url === r.f.urls.release).map(request => request.options.githubCredential)).toEqual([undefined, token])
    expect(r.f.requests).toHaveLength(7)
    expect(r.stderr).toEqual([])
    expect(r.clock.pendingCount()).toBe(0)
    assertNoLeak(publicOutputs(r))
  })

  test.each([
    ['GITHUB_CREDENTIAL_MISSING', AD_GITHUB_CREDENTIAL_MISSING_REASON],
    ['GITHUB_CREDENTIAL_INVALID', AD_GITHUB_CREDENTIAL_INVALID_REASON],
    ['GITHUB_CREDENTIAL_REJECTED', AD_GITHUB_CREDENTIAL_REJECTED_REASON],
  ] as const)('%s gives the labelled exit and recovery before any base read', async (code, reason) => {
    const r = rig(), token = fakeToken('', 'release-failure')
    r.recorder.answer(GH_AUTH_TOKEN_ARGV, code === 'GITHUB_CREDENTIAL_MISSING'
      ? { notStarted: token }
      : { stdout: `${token}${code === 'GITHUB_CREDENTIAL_INVALID' ? '\r' : ''}\n` })
    const error: AdCheckError = { code, source: 'github-release', status: code === 'GITHUB_CREDENTIAL_REJECTED' ? 401 : 403,
      ...(code === 'GITHUB_CREDENTIAL_REJECTED' ? { access: 'signed-in' as const } : {}) }
    expect(await runAdLatestCheck({ ...r.deps, fetchAd: refusedRelease(r, 403, code === 'GITHUB_CREDENTIAL_REJECTED' ? 401 : undefined) })).toBe(AD_LATEST_CHECK_EXIT)
    expect(r.stderr).toEqual([`${adLatestFailureLine(error)}\n`])
    expect(r.stderr[0]).toContain(`${AD_LATEST_CHECK_SR}: ${formatAdCheckError(error)}; ${reason}`)
    expect(r.stdout).toEqual([])
    expect(r.baseReads).toEqual([])
    expect(r.f.requests).toHaveLength(code === 'GITHUB_CREDENTIAL_REJECTED' ? 2 : 1)
    expect(r.clock.pendingCount()).toBe(0)
    assertNoLeak(publicOutputs(r))
  })

  test('a lookup still running at the deadline refuses prepare and its late credential cannot restart it', async () => {
    const r = rig()
    r.recorder.answer(GH_AUTH_TOKEN_ARGV, { stdout: fakeToken('', 'late-release'), delayMs: AD_LATEST_DEADLINE_MS + 1 })
    const result = runAdLatestCheck({ ...r.deps, fetchAd: refusedRelease(r, 429) })
    await r.clock.advance(AD_LATEST_DEADLINE_MS)
    expect(await result).toBe(AD_LATEST_CHECK_EXIT)
    expect(r.stderr).toEqual([`${adLatestFailureLine({ code: 'GITHUB_CREDENTIAL_MISSING', source: 'github-release', status: 429 })}\n`])
    await r.clock.advance(1)
    expect(r.recorder.spawns().map(spawn => spawn.timeoutMs)).toEqual([AD_LATEST_DEADLINE_MS])
    expect(r.f.requests).toHaveLength(1)
    expect(r.baseReads).toEqual([])
    expect(r.clock.pendingCount()).toBe(0)
    assertNoLeak(publicOutputs(r))
  })

  test('a signed-in transport exception is reported without its contaminated message', async () => {
    const r = rig(), token = fakeToken('', 'release-transport-error')
    r.recorder.answer(GH_AUTH_TOKEN_ARGV, { stdout: token })
    const fetchAd = refusedRelease(r, 403)
    const exit = await runAdLatestCheck({ ...r.deps, fetchAd: (url, options) => {
      if (options.githubCredential) throw new Error(token)
      return fetchAd(url, options)
    } })
    expect(exit).toBe(AD_LATEST_CHECK_EXIT)
    expect(r.stderr).toEqual([`${adLatestFailureLine({ code: 'HTTP_FAILED', source: 'github-release', access: 'signed-in' })}\n`])
    expect(r.baseReads).toEqual([])
    assertNoLeak(publicOutputs(r))
  })

  test.each(['missing', 'malformed', 'mismatch'] as const)('present base %s refuses prepare', async mode => {
    const r = rig()
    const error: AdCheckError = { code: 'BASE_RECORD_READ_FAILED', source: 'base' }
    r.deps.readBaseRecord = async (tag: string) => {
      r.baseReads.push(tag)
      return mode === 'missing' ? { ok: false, error } : { ok: true, bytes: mode === 'malformed' ? adBytes('{') : adJson({ ...r.f.record, version: AD_FIXTURE_OTHER_VERSION }) }
    }
    expect(await runAdLatestCheck(r.deps)).toBe(AD_LATEST_CHECK_EXIT)
    expect(r.baseReads).toEqual([r.image])
    expect(r.stderr.join('')).toContain({ missing: 'BASE_RECORD_READ_FAILED', malformed: 'BASE_RECORD_INVALID', mismatch: 'BASE_RECORD_MISMATCH' }[mode])
  })

  test('stable failure line names SR-2.8 and recovery; no unchecked body is required', () => {
    const error: AdCheckError = { code: 'HTTP_STATUS', source: 'github-release', status: 503 }
    expect(adLatestFailureLine(error)).toContain('SR-2.8 (latest agent-director)')
    expect(adLatestFailureLine(error)).toContain(error.code)
    expect(adLatestFailureLine(error)).toBe(`${AD_LATEST_CHECK_SR}: ${formatAdCheckError(error)}; update and commit pins or restore lookup access, rebuild the base when appropriate, and rerun the entire /ci/prepare path`)
    expect(AD_LATEST_CHECK_EXIT).toBe(16)
    expect(AD_BASE_RECORD_PATH).toBe('/opt/agent-director/client/release.json')
  })
})
