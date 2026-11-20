/** The publish CLI adapter, invoked in process; no Docker, network or child. */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { AD_LATEST_CHECK_EXIT, adLatestFailureLine, runAdLatestCheck, type AdLatestCliDeps } from '../scripts/ad-latest-check.ts'
import { AD_BASE_RECORD_PATH, type AdCheckError } from '../scripts/lib/ad-latest.ts'
import { adBytes, adJson, makeAdLatestFixture, AD_FIXTURE_OTHER_VERSION } from './test-helpers/ad-latest.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'

function rig() {
  const f = makeAdLatestFixture(), clock = createFakeClock()
  const root = '/fixture/worktree'
  const reads: string[] = [], baseReads: string[] = [], stdout: string[] = [], stderr: string[] = []
  const image = 'cscb-ci-base:v11'
  const files = new Map([
    [join(root, 'docker/Dockerfile.test.base'), f.sources.dockerfile],
    [join(root, 'package.json'), f.sources.packageJson], [join(root, 'bun.lock'), f.sources.lockfile],
    [join(root, 'docker/Dockerfile.test'), `FROM ${image}\n`],
  ])
  const deps: AdLatestCliDeps = {
    worktreeRoot: root, fetchAd: f.fetchAd, clock,
    readText(path: string) { reads.push(path); const text = files.get(path); if (text === undefined) throw new Error('untrusted read exception'); return text },
    async readBaseRecord(tag: string) { baseReads.push(tag); return { ok: true, bytes: f.recordBytes } },
    writeStdout: (text: string) => { stdout.push(text) }, writeStderr: (text: string) => { stderr.push(text) },
  }
  return { f, deps, clock, root, image, files, reads, baseReads, stdout, stderr }
}

describe('fresh /publish prepare AD check', () => {
  test('checks latest and the present base before returning success', async () => {
    const r = rig()
    expect(await runAdLatestCheck(r.deps)).toBe(0)
    expect(r.baseReads).toEqual([r.image])
    expect(r.f.requests.length).toBe(6)
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
    expect(r.stderr.join('')).toContain('HTTP_STATUS')
    expect(r.stderr.join('')).not.toContain('private server body')
    expect(r.baseReads).toHaveLength(1)
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
    expect(AD_LATEST_CHECK_EXIT).toBe(16)
    expect(AD_BASE_RECORD_PATH).toBe('/opt/agent-director/client/release.json')
  })
})
