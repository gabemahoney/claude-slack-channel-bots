/** b.bvq: strict released-AD provenance. All I/O is injected, including time. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  AD_BASE_RECORD_MAX_BYTES, AD_CLIENT_MAX_BYTES, AD_HTTP_TIMEOUT_MS,
  AD_INSTALLER_MAX_BYTES, AD_LATEST_DEADLINE_MS, AD_METADATA_MAX_BYTES,
  checkLatestAd, compareBaseAdRecord, parseAdPins,
  type AdCheckCode, type AdCheckResult, type AdCheckSource, type AdPinSources, type AdHttpOptions,
} from '../scripts/lib/ad-latest.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import {
  AD_FIXTURE_NEWER_VERSION, AD_FIXTURE_OTHER_COMMIT, AD_FIXTURE_OTHER_DIGEST,
  AD_FIXTURE_OTHER_VERSION, adBytes, adIntegrity, adJson, makeAdLatestFixture, treeAdSources,
} from './test-helpers/ad-latest.ts'
import { CI_AD_CLIENT_SHA256, CI_AD_CLIENT_INTEGRITY, CI_AD_INSTALLER_SHA256, CI_AD_RUNTIME_VERSION } from './test-helpers/agent-director-versions.ts'

function failure(result: AdCheckResult<unknown>, code: AdCheckCode, source?: AdCheckSource, field?: string) {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected strict refusal')
  expect(result.error.code).toBe(code)
  if (source !== undefined) expect(result.error.source).toBe(source)
  if (field !== undefined) expect(result.error.field).toBe(field)
  return result.error
}

describe('AD literal pin parser', () => {
  test('reads the real Docker/package/Bun formats and keeps client independent of the floor', () => {
    const f = makeAdLatestFixture()
    expect(parseAdPins(f.sources)).toEqual({ ok: true, value: f.pins })
  })

  const args = ['AD_VERSION', 'AD_COMMIT', 'AD_SHA256', 'AD_ADMIN_SHA256', 'AD_INSTALL_SH_SHA256', 'AD_CLIENT_VERSION', 'AD_CLIENT_TGZ_SHA256']
  test.each(args)('%s must occur once and have a literal default', (arg) => {
    const f = makeAdLatestFixture()
    const pattern = new RegExp(`^ARG ${arg}=.*$`, 'm')
    const line = f.sources.dockerfile.match(pattern)![0]
    for (const dockerfile of [f.sources.dockerfile.replace(pattern, ''), `${f.sources.dockerfile}\n${line}\n`, f.sources.dockerfile.replace(pattern, `ARG ${arg}=\${OTHER_PIN}`)]) {
      failure(parseAdPins({ ...f.sources, dockerfile }), 'PINS_INVALID', 'pins', arg)
    }
  })

  test.each([
    ['AD_VERSION', `v${CI_AD_RUNTIME_VERSION}`], ['AD_VERSION', `0${CI_AD_RUNTIME_VERSION}`], ['AD_VERSION', `${CI_AD_RUNTIME_VERSION}-rc.1`],
    ['AD_CLIENT_VERSION', `^${CI_AD_RUNTIME_VERSION}`], ['AD_COMMIT', 'abc123'], ['AD_COMMIT', 'A'.repeat(40)],
    ...['AD_SHA256', 'AD_ADMIN_SHA256', 'AD_INSTALL_SH_SHA256', 'AD_CLIENT_TGZ_SHA256'].flatMap(arg => [[arg, 'a'.repeat(63)], [arg, 'G'.repeat(64)]]),
  ])('rejects malformed %s=%s', (arg, value) => {
    const f = makeAdLatestFixture()
    failure(parseAdPins({ ...f.sources, dockerfile: f.sources.dockerfile.replace(new RegExp(`^ARG ${arg}=.*$`, 'm'), `ARG ${arg}=${value}`) }), 'PINS_INVALID', 'pins', arg)
  })

  test.each([
    ['package dependency', 'packageJson', (s: string) => s.replace(/("agent-director"\s*:\s*")[^"]+/, `$1${AD_FIXTURE_OTHER_VERSION}`), 'PACKAGE_PIN_MISMATCH'],
    ['lock workspace', 'lockfile', (s: string) => s.replace(/("agent-director"\s*:\s*")[^"]+/, `$1${AD_FIXTURE_OTHER_VERSION}`), 'LOCK_PIN_MISMATCH'],
    ['lock resolved package', 'lockfile', (s: string) => s.replace(/agent-director@[^"\s]+/, `agent-director@${AD_FIXTURE_OTHER_VERSION}`), 'LOCK_PIN_MISMATCH'],
  ] as const)('rejects disagreement in %s', (_label, key, mutate, code) => {
    const f = makeAdLatestFixture()
    failure(parseAdPins({ ...f.sources, [key]: mutate(f.sources[key]) }), code, 'pins')
  })

  test.each(['packageJson', 'lockfile'] as const)('rejects unparseable %s', key => {
    const f = makeAdLatestFixture()
    failure(parseAdPins({ ...f.sources, [key]: '{broken' }), 'PINS_INVALID', 'pins')
  })

  test('rejects missing or malformed lock integrity', () => {
    const f = makeAdLatestFixture()
    for (const integrity of ['', 'sha512-bad', 'sha256-' + 'a'.repeat(64)]) {
      const sources: AdPinSources = { ...f.sources, lockfile: f.sources.lockfile.replace(f.pins.clientIntegrity, integrity) }
      const result = parseAdPins(sources)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(['PINS_INVALID', 'LOCK_PIN_MISMATCH']).toContain(result.error.code)
    }
  })
})

describe('latest released AD check', () => {
  test('pins the documented bounds once', () => {
    expect([AD_HTTP_TIMEOUT_MS, AD_LATEST_DEADLINE_MS, AD_METADATA_MAX_BYTES, AD_INSTALLER_MAX_BYTES, AD_CLIENT_MAX_BYTES, AD_BASE_RECORD_MAX_BYTES])
      .toEqual([15_000, 120_000, 1_048_576, 1_048_576, 8_388_608, 16_384])
  })
  test('passes only after all six public observations match; releases timers', async () => {
    const f = makeAdLatestFixture(), clock = createFakeClock()
    const result = await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock })
    expect(result).toEqual({ ok: true, value: {
      runtimeVersion: f.pins.version, runtimeCommit: f.pins.commit, clientVersion: f.pins.clientVersion,
      binarySha256: f.pins.binarySha256, adminSha256: f.pins.adminSha256,
      installerSha256: f.pins.installerSha256, clientTarballSha256: f.pins.clientTarballSha256,
      clientIntegrity: f.pins.clientIntegrity,
    } })
    expect(f.requests.map(r => r.url).sort()).toEqual(Object.values(f.urls).sort())
    expect(clock.pendingCount()).toBe(0)
  })

  test.each([AD_FIXTURE_OTHER_VERSION, AD_FIXTURE_NEWER_VERSION])('refuses runtime %s whether older or newer than latest', async version => {
    const f = makeAdLatestFixture()
    failure(await checkLatestAd({ ...f.pins, version }, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'RUNTIME_NOT_LATEST', 'github-release')
  })

  test('refuses a client different from npm latest', async () => {
    const f = makeAdLatestFixture()
    failure(await checkLatestAd({ ...f.pins, clientVersion: AD_FIXTURE_OTHER_VERSION }, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'CLIENT_NOT_LATEST', 'npm-metadata')
  })

  test('peels the annotated tag and refuses a different commit, despite target_commitish=main', async () => {
    const f = makeAdLatestFixture()
    f.routes.set(f.urls.tag, { status: 200, body: adJson({ object: { type: 'commit', sha: AD_FIXTURE_OTHER_COMMIT } }) })
    failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'COMMIT_MISMATCH', 'github-tag')
    expect(f.requests.some(r => r.url === f.urls.installer)).toBe(false)
  })

  test('accepts a lightweight tag pointing directly to the pinned commit', async () => {
    const f = makeAdLatestFixture()
    f.routes.set(f.urls.ref, { status: 200, body: adJson({ object: { type: 'commit', sha: f.pins.commit } }) })
    expect((await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() })).ok).toBe(true)
    expect(f.requests.some(r => r.url === f.urls.tag)).toBe(false)
  })

  test.each(['cycle', 'too-deep'] as const)('bounds annotated tag peeling: %s', async kind => {
    const f = makeAdLatestFixture(), clock = createFakeClock()
    if (kind === 'cycle') f.routes.set(f.urls.tag, { status: 200, body: adJson({ object: { type: 'tag', sha: f.tagSha } }) })
    else for (let n = 0; n < 10; n++) {
      const sha = n === 0 ? f.tagSha : n.toString(16).padStart(40, '0')
      const next = (n + 1).toString(16).padStart(40, '0')
      f.routes.set(f.urls.tag.replace(f.tagSha, sha), { status: 200, body: adJson({ object: { type: 'tag', sha: next } }) })
    }
    failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock }), 'METADATA_INVALID', 'github-tag')
    expect(f.requests.filter(r => r.url.includes('/git/tags/')).length).toBeLessThanOrEqual(8)
    expect(clock.pendingCount()).toBe(0)
  })

  test.each([['binarySha256', 0], ['adminSha256', 1]] as const)('refuses a valid but different %s asset digest', async (field, index) => {
    const f = makeAdLatestFixture()
    f.release.assets[index]!.digest = `sha256:${AD_FIXTURE_OTHER_DIGEST}`
    f.routes.set(f.urls.release, { status: 200, body: adJson(f.release) })
    failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'RELEASE_DIGEST_MISMATCH', 'github-release', field)
  })

  test.each([0, 1])('refuses absent, duplicate or malformed asset %s metadata', async index => {
    for (const form of ['missing', 'duplicate', 'no-digest', 'bad-digest']) {
      const f = makeAdLatestFixture()
      const asset = f.release.assets[index]!
      const assets: unknown[] = form === 'missing' ? f.release.assets.filter((_, i) => i !== index)
        : form === 'duplicate' ? [...f.release.assets, asset]
        : f.release.assets.map((a, i) => i !== index ? a : { name: a.name, ...(form === 'bad-digest' ? { digest: 'sha256:nope' } : {}) })
      f.routes.set(f.urls.release, { status: 200, body: adJson({ ...f.release, assets }) })
      const error = failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'METADATA_INVALID', 'github-release')
      expect(error.field).toBeDefined()
    }
  })

  test('hashes installer bytes independently of binary assets', async () => {
    const f = makeAdLatestFixture()
    f.routes.set(f.urls.installer, { status: 200, body: adBytes('wrong installer') })
    failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'INSTALLER_DIGEST_MISMATCH', 'installer')
  })

  test.each(['integrity', 'lockIntegrity', 'shasum', 'sha256'] as const)('rejects npm tarball disagreement: %s', async field => {
    const f = makeAdLatestFixture()
    let pins = f.pins
    if (field === 'lockIntegrity') pins = { ...pins, clientIntegrity: adIntegrity(adBytes('other lock bytes')) }
    else if (field === 'sha256') pins = { ...pins, clientTarballSha256: AD_FIXTURE_OTHER_DIGEST }
    else {
      if (field === 'integrity') f.npm.dist.integrity = adIntegrity(adBytes('other registry bytes'))
      else f.npm.dist.shasum = 'd'.repeat(40)
      f.routes.set(f.urls.npm, { status: 200, body: adJson(f.npm) })
    }
    failure(await checkLatestAd(pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), field === 'sha256' ? 'CLIENT_DIGEST_MISMATCH' : 'CLIENT_INTEGRITY_MISMATCH', 'npm-tarball', field === 'sha256' ? undefined : field)
  })

  test('corrupt tarball bytes fail the advertised integrity', async () => {
    const f = makeAdLatestFixture()
    f.routes.set(f.urls.tarball, { status: 200, body: adBytes('corrupt package bytes') })
    failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'CLIENT_INTEGRITY_MISMATCH', 'npm-tarball')
  })

  test.each([401, 403, 404, 429, 500, 503])('GitHub status %i is fatal, never a warning', async status => {
    const f = makeAdLatestFixture()
    f.routes.set(f.urls.release, { status, body: adBytes('untrusted body') })
    failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'HTTP_STATUS', 'github-release')
    expect(f.requests).toHaveLength(1)
  })

  test.each(['tarball', 'integrity', 'shasum'] as const)('npm missing/malformed %s is fatal', async field => {
    for (const value of [undefined, 'invalid']) {
      const f = makeAdLatestFixture()
      const dist = { ...f.npm.dist, [field]: value }
      f.routes.set(f.urls.npm, { status: 200, body: adJson({ ...f.npm, dist }) })
      failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'METADATA_INVALID', 'npm-metadata')
    }
  })

  test.each(['https://example.invalid/package.tgz', 'http://registry.npmjs.org/agent-director/-/agent-director.tgz', 'https://user:pass@registry.npmjs.org/agent-director/-/agent-director.tgz'])('npm tarball URL must be canonical: %s', async tarball => {
    const f = makeAdLatestFixture()
    f.routes.set(f.urls.npm, { status: 200, body: adJson({ ...f.npm, dist: { ...f.npm.dist, tarball } }) })
    const error = failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'METADATA_INVALID', 'npm-metadata')
    expect(JSON.stringify(error)).not.toContain(tarball)
    expect(f.requests.every(r => r.url !== tarball)).toBe(true)
  })

  const endpoints: readonly (readonly [keyof ReturnType<typeof makeAdLatestFixture>['urls'], AdCheckSource, number])[] = [
    ['release', 'github-release', AD_METADATA_MAX_BYTES], ['npm', 'npm-metadata', AD_METADATA_MAX_BYTES],
    ['ref', 'github-tag', AD_METADATA_MAX_BYTES], ['tag', 'github-tag', AD_METADATA_MAX_BYTES],
    ['installer', 'installer', AD_INSTALLER_MAX_BYTES], ['tarball', 'npm-tarball', AD_CLIENT_MAX_BYTES],
  ] as const

  test.each(endpoints)('%s: HTTP status, rejection, oversized body and timeout all fail closed', async (key, source, maxBytes) => {
    for (const mode of ['status', 'reject', 'oversize', 'timeout'] as const) {
      const f = makeAdLatestFixture(), clock = createFakeClock()
      const signals: AbortSignal[] = []
      const resultPromise = checkLatestAd(f.pins, { clock, fetchAd: async (url: string, options: AdHttpOptions) => {
        if (url !== f.urls[key]) return f.fetchAd(url, options)
        signals.push(options.signal)
        expect(options.maxBytes).toBe(maxBytes)
        if (mode === 'status') return { status: 503, body: adBytes('untrusted response body') }
        if (mode === 'reject') throw new Error('untrusted transport message')
        if (mode === 'oversize') return { status: 200, body: new Uint8Array(maxBytes + 1) }
        return new Promise(() => {})
      } })
      await clock.flush()
      if (mode === 'timeout') await clock.advance(AD_HTTP_TIMEOUT_MS)
      const error = failure(await resultPromise, { status: 'HTTP_STATUS', reject: 'HTTP_FAILED', oversize: 'HTTP_BODY_TOO_LARGE', timeout: 'HTTP_TIMEOUT' }[mode] as AdCheckCode, source)
      if (mode === 'status') expect(error.status).toBe(503)
      if (mode === 'timeout') expect(signals[0]!.aborted).toBe(true)
      expect(JSON.stringify(error)).not.toMatch(/untrusted/)
      expect(clock.pendingCount()).toBe(0)
    }
  })

  test.each(endpoints.slice(0, 4))('%s: non-JSON and missing fields are fatal', async (key, source) => {
    for (const body of [adBytes('not JSON'), adJson({})]) {
      const f = makeAdLatestFixture()
      f.routes.set(f.urls[key], { status: 200, body })
      failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'METADATA_INVALID', source)
    }
  })

  test.each([{ draft: true }, { prerelease: true }, { tag_name: 'main' }])('rejects unreleased GitHub metadata %j', async patch => {
    const f = makeAdLatestFixture()
    f.routes.set(f.urls.release, { status: 200, body: adJson({ ...f.release, ...patch }) })
    failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'METADATA_INVALID', 'github-release')
  })

  test('the whole observation has a deadline even when every request individually fits', async () => {
    const f = makeAdLatestFixture(), clock = createFakeClock()
    // Eight annotated tag requests allow total time to exceed the overall bound.
    for (let n = 0; n < 8; n++) {
      const sha = n === 0 ? f.tagSha : n.toString(16).padStart(40, '0')
      const next = (n + 1).toString(16).padStart(40, '0')
      f.routes.set(f.urls.tag.replace(f.tagSha, sha), { status: 200, body: adJson({ object: { type: n === 7 ? 'commit' : 'tag', sha: n === 7 ? f.pins.commit : next } }) })
    }
    const signals: AbortSignal[] = []
    const promise = checkLatestAd(f.pins, { clock, fetchAd: (url: string, options: AdHttpOptions) => new Promise(resolve => {
      signals.push(options.signal)
      const timer = clock.setTimeout(() => { void f.fetchAd(url, options).then(resolve) }, AD_HTTP_TIMEOUT_MS - 1)
      options.signal.addEventListener('abort', () => clock.clearTimeout(timer), { once: true })
    }) })
    await clock.advance(AD_LATEST_DEADLINE_MS)
    failure(await promise, 'HTTP_TIMEOUT')
    expect(signals.at(-1)!.aborted).toBe(true)
    expect(clock.pendingCount()).toBe(0)
  })

  test('the tree pins match canned, verified public release bytes', async () => {
    const dir = join(import.meta.dir, 'fixtures/ad-latest')
    const f = makeAdLatestFixture({ installer: gunzipSync(readFileSync(join(dir, 'install.sh.gz'))), tarball: readFileSync(join(dir, 'agent-director.tgz.bin')) })
    expect(f.pins.installerSha256).toBe(CI_AD_INSTALLER_SHA256)
    expect(f.pins.clientTarballSha256).toBe(CI_AD_CLIENT_SHA256)
    expect(f.pins.clientIntegrity).toBe(CI_AD_CLIENT_INTEGRITY)
    const parsed = parseAdPins(treeAdSources())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(await checkLatestAd(parsed.value, { fetchAd: f.fetchAd, clock: createFakeClock() })).toEqual({ ok: true, value: {
      runtimeVersion: f.pins.version, runtimeCommit: f.pins.commit, clientVersion: f.pins.clientVersion,
      binarySha256: f.pins.binarySha256, adminSha256: f.pins.adminSha256,
      installerSha256: f.pins.installerSha256, clientTarballSha256: f.pins.clientTarballSha256, clientIntegrity: f.pins.clientIntegrity,
    } })
  })
})

describe('base record identity', () => {
  test('all eight fields match exactly', () => {
    const f = makeAdLatestFixture()
    expect(compareBaseAdRecord(f.pins, f.recordBytes)).toEqual({ ok: true, value: f.record })
  })

  test('allows unrelated fields, but still bounds and strictly decodes the whole record', () => {
    const f = makeAdLatestFixture()
    expect(compareBaseAdRecord(f.pins, adJson({ ...f.record, unrelated: 'allowed' })).ok).toBe(true)
    failure(compareBaseAdRecord(f.pins, adJson({ ...f.record, unrelated: 'x'.repeat(AD_BASE_RECORD_MAX_BYTES) })), 'BASE_RECORD_INVALID', 'base')
    const prefix = adBytes(JSON.stringify(f.record).slice(0, -1) + ',"unrelated":"')
    const suffix = adBytes('"}')
    const nonUtf8 = new Uint8Array(prefix.length + 1 + suffix.length)
    nonUtf8.set(prefix)
    nonUtf8[prefix.length] = 0xff
    nonUtf8.set(suffix, prefix.length + 1)
    failure(compareBaseAdRecord(f.pins, nonUtf8), 'BASE_RECORD_INVALID', 'base')
  })

  test.each(['version', 'commit', 'binary_sha256', 'admin_sha256', 'installer_sha256', 'client_version', 'client_tarball', 'client_tarball_sha256'] as const)('missing, malformed or different %s refuses', field => {
    const f = makeAdLatestFixture()
    const missing: Record<string, unknown> = { ...f.record }
    delete missing[field]
    for (const record of [missing, { ...f.record, [field]: 42 }, { ...f.record, [field]: '' }]) {
      failure(compareBaseAdRecord(f.pins, adJson(record)), 'BASE_RECORD_INVALID', 'base')
    }
    const other = field === 'version' || field === 'client_version' ? AD_FIXTURE_OTHER_VERSION
      : field === 'commit' ? AD_FIXTURE_OTHER_COMMIT
      : field === 'client_tarball' ? `/opt/agent-director/client/agent-director-${AD_FIXTURE_OTHER_VERSION}.tgz` : AD_FIXTURE_OTHER_DIGEST
    const error = failure(compareBaseAdRecord(f.pins, adJson({ ...f.record, [field]: other })), 'BASE_RECORD_MISMATCH', 'base', field)
    expect(error.expected).toBe(f.record[field])
    expect(error.actual).toBe(other)
  })

  test.each([new Uint8Array(), adBytes('{broken'), adJson(null), adJson([]), new Uint8Array([0xff]), new Uint8Array(AD_BASE_RECORD_MAX_BYTES + 1)])('rejects missing, malformed, non-UTF8 or oversized bytes %#', bytes => {
    failure(compareBaseAdRecord(makeAdLatestFixture().pins, bytes), 'BASE_RECORD_INVALID', 'base')
  })
})
