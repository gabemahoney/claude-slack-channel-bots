/** b.bvq: strict released-AD provenance. All I/O is injected, including time. */
import { describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  AD_BASE_RECORD_MAX_BYTES, AD_CLIENT_MAX_BYTES, AD_HTTP_TIMEOUT_MS,
  AD_INSTALLER_MAX_BYTES, AD_LATEST_DEADLINE_MS, AD_METADATA_MAX_BYTES,
  AD_GITHUB_CREDENTIAL_MISSING_REASON, AD_GITHUB_CREDENTIAL_INVALID_REASON, AD_GITHUB_CREDENTIAL_REJECTED_REASON,
  SECRET_MIN_LENGTH, adCredentialFailureReason, checkLatestAd, compareBaseAdRecord, fetchReleasedAd, formatAdCheckError, parseAdPins,
  type AdCheckCode, type AdCheckResult, type AdCheckSource, type AdPinSources, type AdHttpOptions,
  type AdCredentialProvider, type AdLatestDeps, type AdPins,
} from '../scripts/lib/ad-latest.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import {
  AD_FIXTURE_NEWER_VERSION, AD_FIXTURE_OTHER_COMMIT, AD_FIXTURE_OTHER_DIGEST,
  AD_FIXTURE_OTHER_VERSION, adBytes, adIntegrity, adJson, makeAdLatestFixture, treeAdSources,
} from './test-helpers/ad-latest.ts'
import { CI_AD_CLIENT_SHA256, CI_AD_CLIENT_INTEGRITY, CI_AD_INSTALLER_SHA256, CI_AD_RUNTIME_VERSION } from './test-helpers/agent-director-versions.ts'

function failure(result: AdCheckResult<unknown>, code: AdCheckCode, source?: AdCheckSource, field?: string) {
  publicResult(result)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected strict refusal')
  expect(result.error.code).toBe(code)
  if (source !== undefined) expect(result.error.source).toBe(source)
  if (field !== undefined) expect(result.error.field).toBe(field)
  return result.error
}

function publicResult(result: AdCheckResult<unknown>, credential?: string) {
  const captured = { result, diagnostic: result.ok ? '' : formatAdCheckError(result.error) }
  assertNoLeak(captured)
  // Short fake-token slices need an exact check as well as the sentinel check.
  if (credential) expect(JSON.stringify(captured)).not.toContain(credential)
}

type Access = 'anonymous' | 'signed-in'
type Fixture = ReturnType<typeof makeAdLatestFixture>
const orderedUrls = (f: Fixture) => [f.urls.release, f.urls.npm, f.urls.ref, f.urls.tag, f.urls.installer, f.urls.tarball]
const githubUrl = (url: string) => ['https://api.github.com', 'https://raw.githubusercontent.com'].includes(new URL(url).origin)

/** Run the existing failure fixtures through both access states, without copying their matrices. */
async function checkWithAccess(access: Access, pins: AdPins, deps: AdLatestDeps & { clock: ReturnType<typeof createFakeClock> }) {
  const credential = fakeToken('', 'latest-matrix'), requests: Fixture['requests'] = [], lookups: number[] = []
  const result = await checkLatestAd(pins, { ...deps,
    fetchAd: async (url, options) => {
      requests.push({ url, options })
      if (access === 'signed-in' && requests.length === 1) return { status: 403, body: adBytes(credential) }
      return deps.fetchAd(url, options)
    },
    getGitHubCredential: async remaining => { lookups.push(remaining); return credential },
  })
  expect(lookups).toEqual(access === 'signed-in' ? [AD_LATEST_DEADLINE_MS] : [])
  if (access === 'signed-in') expect(requests[1]!.url).toBe(requests[0]!.url)
  const observations = requests.slice(access === 'signed-in' ? 1 : 0)
  expect(new Set(observations.map(r => r.url)).size).toBe(observations.length)
  for (const [index, { url, options }] of requests.entries()) {
    expect(options.githubCredential).toBe(access === 'signed-in' && index > 0 && githubUrl(url) ? credential : undefined)
  }
  if (!result.ok) {
    expect(result.error.access).toBe(access === 'signed-in' ? 'signed-in' : undefined)
    expect(formatAdCheckError(result.error).split(': ').includes('signed-in')).toBe(access === 'signed-in')
  }
  expect(deps.clock.pendingCount()).toBe(0)
  publicResult(result, credential)
  return result
}

const githubRequests = [
  ['release', 'github-release'], ['ref', 'github-tag'], ['tag', 'github-tag'], ['installer', 'installer'],
] as const

/** Refuse exactly one anonymous request; all responses and captures use the shared fixture. */
function fallbackFixture(key: typeof githubRequests[number][0], status: number, provider?: AdCredentialProvider) {
  const f = makeAdLatestFixture(), clock = createFakeClock(), credential = fakeToken('', 'latest-fallback')
  const lookups: number[] = []
  let refused = false
  const deps: AdLatestDeps = { clock,
    fetchAd: async (url, options) => {
      const answer = await f.fetchAd(url, options)
      if (url === f.urls[key] && !refused) {
        refused = true
        return { status, body: adBytes(credential) }
      }
      return answer
    },
    getGitHubCredential: async remaining => {
      lookups.push(remaining)
      return provider ? provider(remaining) : credential
    },
  }
  return { f, clock, credential, lookups, deps }
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
  test.each([401, 403, 404, 429, 500, 503])('GitHub status %i is fatal, never a warning', async status => {
    const f = makeAdLatestFixture()
    f.routes.set(f.urls.release, { status, body: adBytes('untrusted body') })
    const clock = createFakeClock()
    const error = failure(await checkLatestAd(f.pins, { fetchAd: f.fetchAd, clock }),
      status === 403 || status === 429 ? 'GITHUB_CREDENTIAL_MISSING' : 'HTTP_STATUS', 'github-release')
    expect(error).toEqual({ code: status === 403 || status === 429 ? 'GITHUB_CREDENTIAL_MISSING' : 'HTTP_STATUS', source: 'github-release', status })
    expect(clock.pendingCount()).toBe(0)
    expect(f.requests).toHaveLength(1)
  })

  describe.each(['anonymous', 'signed-in'] as const)('%s access', access => {
    const check = (pins: AdPins, deps: AdLatestDeps & { clock: ReturnType<typeof createFakeClock> }) => checkWithAccess(access, pins, deps)
    test('passes only after all six public observations match; releases timers', async () => {
      const f = makeAdLatestFixture(), clock = createFakeClock()
      const result = await check(f.pins, { fetchAd: f.fetchAd, clock })
      expect(result).toEqual({ ok: true, value: {
        runtimeVersion: f.pins.version, runtimeCommit: f.pins.commit, clientVersion: f.pins.clientVersion,
        binarySha256: f.pins.binarySha256, adminSha256: f.pins.adminSha256,
        installerSha256: f.pins.installerSha256, clientTarballSha256: f.pins.clientTarballSha256,
        clientIntegrity: f.pins.clientIntegrity,
      } })
      expect(f.requests.map(r => r.url)).toEqual(orderedUrls(f))
      expect(clock.pendingCount()).toBe(0)
    })

    test.each([AD_FIXTURE_OTHER_VERSION, AD_FIXTURE_NEWER_VERSION])('refuses runtime %s whether older or newer than latest', async version => {
      const f = makeAdLatestFixture()
      failure(await check({ ...f.pins, version }, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'RUNTIME_NOT_LATEST', 'github-release')
    })

    test('refuses a client different from npm latest', async () => {
      const f = makeAdLatestFixture()
      failure(await check({ ...f.pins, clientVersion: AD_FIXTURE_OTHER_VERSION }, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'CLIENT_NOT_LATEST', 'npm-metadata')
    })

    test('peels the annotated tag and refuses a different commit, despite target_commitish=main', async () => {
      const f = makeAdLatestFixture()
      f.routes.set(f.urls.tag, { status: 200, body: adJson({ object: { type: 'commit', sha: AD_FIXTURE_OTHER_COMMIT } }) })
      failure(await check(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'COMMIT_MISMATCH', 'github-tag')
      expect(f.requests.some(r => r.url === f.urls.installer)).toBe(false)
    })

    test('accepts a lightweight tag pointing directly to the pinned commit', async () => {
      const f = makeAdLatestFixture()
      f.routes.set(f.urls.ref, { status: 200, body: adJson({ object: { type: 'commit', sha: f.pins.commit } }) })
      expect((await check(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() })).ok).toBe(true)
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
      failure(await check(f.pins, { fetchAd: f.fetchAd, clock }), 'METADATA_INVALID', 'github-tag')
      expect(f.requests.filter(r => r.url.includes('/git/tags/')).length).toBeLessThanOrEqual(8)
      expect(clock.pendingCount()).toBe(0)
    })

    test.each([['binarySha256', 0], ['adminSha256', 1]] as const)('refuses a valid but different %s asset digest', async (field, index) => {
      const f = makeAdLatestFixture()
      f.release.assets[index]!.digest = `sha256:${AD_FIXTURE_OTHER_DIGEST}`
      f.routes.set(f.urls.release, { status: 200, body: adJson(f.release) })
      failure(await check(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'RELEASE_DIGEST_MISMATCH', 'github-release', field)
    })

    test.each([0, 1])('refuses absent, duplicate or malformed asset %s metadata', async index => {
      for (const form of ['missing', 'duplicate', 'no-digest', 'bad-digest']) {
        const f = makeAdLatestFixture()
        const asset = f.release.assets[index]!
        const assets: unknown[] = form === 'missing' ? f.release.assets.filter((_, i) => i !== index)
          : form === 'duplicate' ? [...f.release.assets, asset]
          : f.release.assets.map((a, i) => i !== index ? a : { name: a.name, ...(form === 'bad-digest' ? { digest: 'sha256:nope' } : {}) })
        f.routes.set(f.urls.release, { status: 200, body: adJson({ ...f.release, assets }) })
        const error = failure(await check(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'METADATA_INVALID', 'github-release')
        expect(error.field).toBeDefined()
      }
    })

    test('hashes installer bytes independently of binary assets', async () => {
      const f = makeAdLatestFixture()
      f.routes.set(f.urls.installer, { status: 200, body: adBytes('wrong installer') })
      failure(await check(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'INSTALLER_DIGEST_MISMATCH', 'installer')
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
      failure(await check(pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), field === 'sha256' ? 'CLIENT_DIGEST_MISMATCH' : 'CLIENT_INTEGRITY_MISMATCH', 'npm-tarball', field === 'sha256' ? undefined : field)
    })

    test('corrupt tarball bytes fail the advertised integrity', async () => {
      const f = makeAdLatestFixture()
      f.routes.set(f.urls.tarball, { status: 200, body: adBytes('corrupt package bytes') })
      failure(await check(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'CLIENT_INTEGRITY_MISMATCH', 'npm-tarball')
    })

    test.each(['tarball', 'integrity', 'shasum'] as const)('npm missing/malformed %s is fatal', async field => {
      for (const value of [undefined, 'invalid']) {
        const f = makeAdLatestFixture()
        const dist = { ...f.npm.dist, [field]: value }
        f.routes.set(f.urls.npm, { status: 200, body: adJson({ ...f.npm, dist }) })
        failure(await check(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'METADATA_INVALID', 'npm-metadata')
      }
    })

    test.each(['https://example.invalid/package.tgz', 'http://registry.npmjs.org/agent-director/-/agent-director.tgz', 'https://user:pass@registry.npmjs.org/agent-director/-/agent-director.tgz'])('npm tarball URL must be canonical: %s', async tarball => {
      const f = makeAdLatestFixture()
      f.routes.set(f.urls.npm, { status: 200, body: adJson({ ...f.npm, dist: { ...f.npm.dist, tarball } }) })
      const error = failure(await check(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'METADATA_INVALID', 'npm-metadata')
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
        const resultPromise = check(f.pins, { clock, fetchAd: async (url: string, options: AdHttpOptions) => {
          if (url !== f.urls[key]) return f.fetchAd(url, options)
          signals.push(options.signal)
          expect(options.maxBytes).toBe(maxBytes)
          if (mode === 'status') return { status: 503, body: adBytes(fakeToken('', 'response')) }
          if (mode === 'reject') throw new Error(fakeToken('', 'transport'))
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
        failure(await check(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'METADATA_INVALID', source)
      }
    })

    test.each([{ draft: true }, { prerelease: true }, { tag_name: 'main' }])('rejects unreleased GitHub metadata %j', async patch => {
      const f = makeAdLatestFixture()
      f.routes.set(f.urls.release, { status: 200, body: adJson({ ...f.release, ...patch }) })
      failure(await check(f.pins, { fetchAd: f.fetchAd, clock: createFakeClock() }), 'METADATA_INVALID', 'github-release')
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
      const promise = check(f.pins, { clock, fetchAd: (url: string, options: AdHttpOptions) => new Promise(resolve => {
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
      expect(await check(parsed.value, { fetchAd: f.fetchAd, clock: createFakeClock() })).toEqual({ ok: true, value: {
        runtimeVersion: f.pins.version, runtimeCommit: f.pins.commit, clientVersion: f.pins.clientVersion,
        binarySha256: f.pins.binarySha256, adminSha256: f.pins.adminSha256,
        installerSha256: f.pins.installerSha256, clientTarballSha256: f.pins.clientTarballSha256, clientIntegrity: f.pins.clientIntegrity,
      } })
    })
  })
})

describe('latest released AD access transitions', () => {
  test.each(githubRequests.flatMap(([key, source]) => [403, 429].map(status => [key, source, status] as const)))
  ('%s (%s) refused with %i: one retry, one lookup, then GitHub stays signed in', async (key, _source, status) => {
    const { f, clock, credential, lookups, deps } = fallbackFixture(key, status)
    const result = await checkLatestAd(f.pins, deps)
    expect(result.ok).toBe(true)
    const expected = orderedUrls(f), at = expected.indexOf(f.urls[key])
    expected.splice(at, 0, f.urls[key])
    expect(f.requests.map(r => r.url)).toEqual(expected)
    expect(lookups).toEqual([AD_LATEST_DEADLINE_MS])
    for (const [index, { url, options }] of f.requests.entries()) {
      expect(options.githubCredential).toBe(index > at && githubUrl(url) ? credential : undefined)
    }
    expect(clock.pendingCount()).toBe(0)
    publicResult(result, credential)
  })

  test.each([
    ['null', 'ref', 403, async (): Promise<string | null> => null],
    ['empty', 'installer', 429, async (): Promise<string | null> => ''],
    ['throwing', 'tag', 403, async (): Promise<string | null> => { throw new Error(fakeToken('', 'provider-error')) }],
  ] as const)('%s provider fails with the refused request source and status', async (_label, key, status, provider) => {
    const { f, clock, lookups, deps } = fallbackFixture(key, status, provider)
    const source = githubRequests.find(([candidate]) => candidate === key)![1]
    expect(failure(await checkLatestAd(f.pins, deps), 'GITHUB_CREDENTIAL_MISSING')).toEqual({
      code: 'GITHUB_CREDENTIAL_MISSING', source, status,
    })
    expect(f.requests.map(r => r.url)).toEqual(orderedUrls(f).slice(0, orderedUrls(f).indexOf(f.urls[key]) + 1))
    expect(f.requests.every(r => r.options.githubCredential === undefined)).toBe(true)
    expect(lookups).toEqual([AD_LATEST_DEADLINE_MS])
    expect(clock.pendingCount()).toBe(0)
  })

  test.each([
    ['short', (token: string) => token.slice(0, SECRET_MIN_LENGTH - 1)],
    ...[' ', '\t', '\r', '\n', '\0', '\x7f', '\u0080', '\u00e9', '\u2028'].map(char => [
      `character ${char.charCodeAt(0)}`, (token: string) => token + char,
    ] as const),
  ] as const)('%s credential is invalid and is never sent', async (_label, invalid) => {
    const credential = invalid(fakeToken('', 'invalid'))
    const { f, clock, lookups, deps } = fallbackFixture('installer', 429, async () => credential)
    const result = await checkLatestAd(f.pins, deps)
    expect(failure(result, 'GITHUB_CREDENTIAL_INVALID')).toEqual({ code: 'GITHUB_CREDENTIAL_INVALID', source: 'installer', status: 429 })
    expect(f.requests.map(r => r.url)).toEqual(orderedUrls(f).slice(0, -1))
    expect(f.requests.every(r => r.options.githubCredential === undefined)).toBe(true)
    expect(lookups).toEqual([AD_LATEST_DEADLINE_MS])
    expect(clock.pendingCount()).toBe(0)
    publicResult(result, credential)
  })

  test('a credential exactly at the shared length floor is usable', async () => {
    const credential = fakeToken('', 'minimum').slice(0, SECRET_MIN_LENGTH)
    const { f, clock, lookups, deps } = fallbackFixture('release', 403, async () => credential)
    const result = await checkLatestAd(f.pins, deps)
    expect(result.ok).toBe(true)
    expect(f.requests[1]!.options.githubCredential).toBe(credential)
    expect(lookups).toEqual([AD_LATEST_DEADLINE_MS])
    expect(clock.pendingCount()).toBe(0)
    publicResult(result, credential)
  })

  test.each(githubRequests.flatMap(([key, source]) => [401, 403, 429].map(status => [key, source, status] as const)))
  ('%s (%s) signed-in status %i is fatal without another retry or lookup', async (key, source, status) => {
    const { f, clock, credential, lookups, deps } = fallbackFixture(key, 403)
    f.routes.set(f.urls[key], { status, body: adBytes(credential) })
    const result = await checkLatestAd(f.pins, deps)
    const code = status === 401 ? 'GITHUB_CREDENTIAL_REJECTED' : 'HTTP_STATUS'
    expect(failure(result, code)).toEqual({ code, source, status, access: 'signed-in' })
    const expected = orderedUrls(f).slice(0, orderedUrls(f).indexOf(f.urls[key]) + 1)
    expect(f.requests.map(r => r.url)).toEqual([...expected, f.urls[key]])
    expect(f.requests.at(-1)!.options.githubCredential).toBe(credential)
    expect(lookups).toEqual([AD_LATEST_DEADLINE_MS])
    expect(clock.pendingCount()).toBe(0)
    publicResult(result, credential)
  })

  test.each(['anonymous', 'signed-in'] as const)('%s npm 401/403/429 never triggers GitHub fallback or credential rejection', async access => {
    for (const [key, source] of [['npm', 'npm-metadata'], ['tarball', 'npm-tarball']] as const) for (const status of [401, 403, 429]) {
      const f = makeAdLatestFixture(), clock = createFakeClock()
      f.routes.set(f.urls[key], { status, body: adBytes(fakeToken('', 'npm-body')) })
      const error = failure(await checkWithAccess(access, f.pins, { fetchAd: f.fetchAd, clock }), 'HTTP_STATUS', source)
      expect(error.status).toBe(status)
      expect(f.requests.map(r => r.url)).toEqual(orderedUrls(f).slice(0, orderedUrls(f).indexOf(f.urls[key]) + 1))
    }
  })

  test.each(['resolve', 'reject'] as const)('provider deadline ignores a late %s and never starts a retry', async late => {
    let resolve!: (value: string) => void, reject!: (error: Error) => void
    const held = new Promise<string>((yes, no) => { resolve = yes; reject = no })
    const { f, clock, credential, lookups, deps } = fallbackFixture('tag', 429, () => held)
    const fetchAd = deps.fetchAd
    const elapsed = AD_HTTP_TIMEOUT_MS - 1
    const promise = checkLatestAd(f.pins, { ...deps, fetchAd: (url, options) => url === f.urls.release
      ? new Promise(resolve => clock.setTimeout(() => { void fetchAd(url, options).then(resolve) }, elapsed))
      : fetchAd(url, options) })
    await clock.advance(elapsed)
    expect(lookups).toEqual([AD_LATEST_DEADLINE_MS - elapsed])
    let settled = false
    void promise.then(() => { settled = true })
    await clock.advance(AD_LATEST_DEADLINE_MS - elapsed - 1)
    expect(settled).toBe(false)
    await clock.advance(1)
    const result = await promise
    expect(failure(result, 'GITHUB_CREDENTIAL_MISSING')).toEqual({ code: 'GITHUB_CREDENTIAL_MISSING', source: 'github-tag', status: 429 })
    if (late === 'resolve') resolve(credential)
    else reject(new Error(credential))
    await clock.flush()
    expect(f.requests.map(r => r.url)).toEqual(orderedUrls(f).slice(0, 4))
    expect(f.requests.every(r => r.options.githubCredential === undefined)).toBe(true)
    expect(clock.pendingCount()).toBe(0)
    publicResult(result, credential)
  })

  test('a last-moment credential leaves only the original deadline for the retry', async () => {
    const { f, clock, credential, lookups, deps } = fallbackFixture('release', 403)
    const fetchAd = deps.fetchAd
    const promise = checkLatestAd(f.pins, { ...deps,
      getGitHubCredential: remaining => {
        lookups.push(remaining)
        return new Promise(resolve => clock.setTimeout(() => resolve(credential), remaining - 1))
      },
      fetchAd: async (url, options) => {
        const response = await fetchAd(url, options)
        return options.githubCredential ? new Promise(() => {}) : response
      },
    })
    await clock.advance(AD_LATEST_DEADLINE_MS - 1)
    expect(f.requests.map(r => r.url)).toEqual([f.urls.release, f.urls.release])
    expect(f.requests[1]!.options.githubCredential).toBe(credential)
    expect(clock.pending().map(t => t.dueAt)).toEqual([AD_LATEST_DEADLINE_MS])
    await clock.advance(1)
    expect(failure(await promise, 'HTTP_TIMEOUT')).toEqual({ code: 'HTTP_TIMEOUT', source: 'github-release', access: 'signed-in' })
    expect(f.requests[1]!.options.signal.aborted).toBe(true)
    expect(lookups).toEqual([AD_LATEST_DEADLINE_MS])
    expect(clock.pendingCount()).toBe(0)
  })

  test.each(['anonymous', 'signed-in'] as const)('%s checks observe a runtime or client release between invocations', async access => {
    for (const component of ['runtime', 'client'] as const) {
      const f = makeAdLatestFixture(), clock = createFakeClock(), lookups: number[] = []
      const credentials = [fakeToken('', 'first-run'), fakeToken('', 'second-run')]
      const deps: AdLatestDeps = { clock,
        fetchAd: async (url, options) => {
          const response = await f.fetchAd(url, options)
          return access === 'signed-in' && url === f.urls.release && !options.githubCredential
            ? { status: 429, body: adBytes('allowance used') } : response
        },
        getGitHubCredential: async remaining => { lookups.push(remaining); return credentials[lookups.length - 1]! },
      }
      const first = await checkLatestAd(f.pins, deps)
      expect(first.ok).toBe(true)
      const firstRequests = f.requests.splice(0)
      expect(firstRequests.map(r => r.url)).toEqual(access === 'signed-in' ? [f.urls.release, ...orderedUrls(f)] : orderedUrls(f))
      if (component === 'runtime') f.routes.set(f.urls.release, { status: 200, body: adJson({ ...f.release, tag_name: `v${AD_FIXTURE_NEWER_VERSION}` }) })
      else f.routes.set(f.urls.npm, { status: 200, body: adJson({ ...f.npm, version: AD_FIXTURE_NEWER_VERSION }) })
      const second = await checkLatestAd(f.pins, deps)
      const error = failure(second, component === 'runtime' ? 'RUNTIME_NOT_LATEST' : 'CLIENT_NOT_LATEST', component === 'runtime' ? 'github-release' : 'npm-metadata')
      expect(error.access).toBe(access === 'signed-in' ? 'signed-in' : undefined)
      const urls = component === 'runtime' ? [f.urls.release] : [f.urls.release, f.urls.npm]
      expect(f.requests.map(r => r.url)).toEqual(access === 'signed-in' ? [f.urls.release, ...urls] : urls)
      expect(lookups).toEqual(access === 'signed-in' ? [AD_LATEST_DEADLINE_MS, AD_LATEST_DEADLINE_MS] : [])
      for (const [run, requests] of [firstRequests, f.requests].entries()) for (const [index, { url, options }] of requests.entries()) {
        expect(options.githubCredential).toBe(access === 'signed-in' && index > 0 && githubUrl(url) ? credentials[run] : undefined)
      }
      expect(clock.pendingCount()).toBe(0)
      publicResult(first)
      publicResult(second)
    }
  })

  // One independent SR-4.3 content oracle; caller assertions share the exports.
  test.each([
    ['missing', AD_GITHUB_CREDENTIAL_MISSING_REASON, [
      /GitHub refused anonymous (?:access|lookup)/i, /no gh sign-in was found/i,
      /sign gh in to GitHub/i, /gh auth status/i, /retry after.*anonymous allowance resets/i,
    ]],
    ['invalid', AD_GITHUB_CREDENTIAL_INVALID_REASON, [
      /gh sign-in.*unusable credential/i, /sign gh in to GitHub again/i,
    ]],
    ['rejected', AD_GITHUB_CREDENTIAL_REJECTED_REASON, [
      /GitHub refused the gh sign-in/i, /sign gh in to GitHub again/i, /gh auth status/i,
    ]],
  ] as const)('%s credential reason explains the failed confirmation, cause and recovery', (_label, reason, requiredContent) => {
    expect(reason).toMatch(/latest agent-director release could not be confirmed/i)
    for (const content of requiredContent) expect(reason).toMatch(content)
    assertNoLeak(reason)
  })

  test.each([
    ['GITHUB_CREDENTIAL_MISSING', AD_GITHUB_CREDENTIAL_MISSING_REASON, 403, undefined],
    ['GITHUB_CREDENTIAL_INVALID', AD_GITHUB_CREDENTIAL_INVALID_REASON, 429, undefined],
    ['GITHUB_CREDENTIAL_REJECTED', AD_GITHUB_CREDENTIAL_REJECTED_REASON, 401, 'signed-in'],
  ] as const)('%s formats only trusted fields and uses the exported recovery text', (code, reason, status, access) => {
    const credential = fakeToken('', 'diagnostic')
    const diagnostic = formatAdCheckError({ code, source: 'github-release', status, access, field: credential, expected: credential, actual: credential })
    expect(diagnostic).toBe(`${code}: github-release: HTTP ${status}${access ? ': signed-in' : ''}`)
    expect(adCredentialFailureReason(code)).toBe(reason)
    assertNoLeak({ diagnostic, reason })
  })
})

type FetchCall = { url: string; init: RequestInit }
async function withCapturedFetch(answer: (call: FetchCall) => Promise<Response>, run: (calls: FetchCall[]) => Promise<void>) {
  const calls: FetchCall[] = []
  const stub = spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return answer(call)
  }) as typeof fetch)
  try { await run(calls) } finally { stub.mockRestore() }
}

describe('released AD HTTP transport', () => {
  test.each(['anonymous', 'signed-in'] as const)('%s complete check sends no-cache on every request and Authorization only to GitHub', async access => {
    const f = makeAdLatestFixture(), clock = createFakeClock(), credential = fakeToken('', 'transport')
    let first = true, lookups = 0
    await withCapturedFetch(async ({ url }) => {
      if (first && access === 'signed-in') { first = false; return new Response('allowance used', { status: 403 }) }
      const response = f.routes.get(url)!
      return new Response(new Uint8Array(response.body), { status: response.status })
    }, async calls => {
      const result = await checkLatestAd(f.pins, { clock, fetchAd: fetchReleasedAd, getGitHubCredential: async () => { lookups++; return credential } })
      expect(result.ok).toBe(true)
      expect(calls.map(c => c.url)).toEqual(access === 'signed-in' ? [f.urls.release, ...orderedUrls(f)] : orderedUrls(f))
      expect(lookups).toBe(access === 'signed-in' ? 1 : 0)
      for (const [index, { url, init }] of calls.entries()) {
        const headers = new Headers(init.headers)
        expect(headers.get('cache-control')).toBe('no-cache')
        expect(headers.get('authorization')).toBe(access === 'signed-in' && index > 0 && githubUrl(url) ? `token ${credential}` : null)
        expect(headers.has('if-none-match')).toBe(false)
        expect(headers.has('if-modified-since')).toBe(false)
        expect(init.redirect).toBe('error')
        expect(init.signal).toBeInstanceOf(AbortSignal)
        // Header captures intentionally contain the fake; URLs and public output must not.
        assertNoLeak(url)
      }
      expect(clock.pendingCount()).toBe(0)
      publicResult(result, credential)
    })
  })

  test.each([
    'https://registry.npmjs.org/agent-director/latest', 'https://example.invalid/release',
    'http://api.github.com/release', 'https://api.github.com:444/release',
    'https://api.github.com.example.invalid/release', 'https://raw.githubusercontent.com.example.invalid/install.sh',
    'https://user@api.github.com/release', 'https://user:pass@raw.githubusercontent.com/install.sh',
  ])('refuses a credential for %s before sending anything', async url => {
    const credential = fakeToken('', 'origin')
    await withCapturedFetch(async () => { throw new Error('unexpected send') }, async calls => {
      let error: unknown
      try { await fetchReleasedAd(url, { signal: new AbortController().signal, maxBytes: AD_METADATA_MAX_BYTES, githubCredential: credential }) }
      catch (caught) { error = caught }
      expect(error).toBeInstanceOf(Error)
      expect(calls).toEqual([])
      assertNoLeak(error)
    })
  })

  test.each(['https://example.invalid/release', 'http://registry.npmjs.org/package', 'https://user@api.github.com/release'])
  ('anonymous transport still refuses unsupported origin/userinfo: %s', async url => {
    await withCapturedFetch(async () => { throw new Error('unexpected send') }, async calls => {
      await expect(fetchReleasedAd(url, { signal: new AbortController().signal, maxBytes: AD_METADATA_MAX_BYTES })).rejects.toThrow('Unsupported release origin')
      expect(calls).toEqual([])
    })
  })

  test.each(['short', 'newline'] as const)('transport independently refuses a %s credential before fetch', async kind => {
    const credential = kind === 'short' ? fakeToken('').slice(0, SECRET_MIN_LENGTH - 1) : fakeToken('') + '\n'
    await withCapturedFetch(async () => { throw new Error('unexpected send') }, async calls => {
      let error: unknown
      try { await fetchReleasedAd(makeAdLatestFixture().urls.release, { signal: new AbortController().signal, maxBytes: AD_METADATA_MAX_BYTES, githubCredential: credential }) }
      catch (caught) { error = caught }
      expect(error).toBeInstanceOf(Error)
      expect(calls).toEqual([])
      assertNoLeak(error)
      expect(String(error)).not.toContain(credential)
    })
  })

  test('redirect refusal is passed to fetch and its contaminated exception stays out of check diagnostics', async () => {
    const f = makeAdLatestFixture(), clock = createFakeClock(), credential = fakeToken('', 'redirect')
    let attempts = 0
    await withCapturedFetch(async ({ init }) => {
      if (++attempts === 1) return new Response('', { status: 429 })
      expect(init.redirect).toBe('error')
      throw new TypeError(`redirect to https://example.invalid/${credential}`)
    }, async calls => {
      const result = await checkLatestAd(f.pins, { clock, fetchAd: fetchReleasedAd, getGitHubCredential: async () => credential })
      expect(failure(result, 'HTTP_FAILED')).toEqual({ code: 'HTTP_FAILED', source: 'github-release', access: 'signed-in' })
      expect(calls.map(c => c.url)).toEqual([f.urls.release, f.urls.release])
      expect(clock.pendingCount()).toBe(0)
      publicResult(result, credential)
    })
  })

  test.each([0, 1])('stream at body limit + %i bytes is bounded and releases its reader', async extra => {
    const bytes = new Uint8Array(AD_METADATA_MAX_BYTES + extra)
    let cancelled = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.subarray(0, AD_METADATA_MAX_BYTES)); if (extra) controller.enqueue(bytes.subarray(AD_METADATA_MAX_BYTES)) },
      pull(controller) { if (!extra) controller.close() },
      cancel() { cancelled++ },
    })
    await withCapturedFetch(async () => new Response(stream), async calls => {
      const result = await fetchReleasedAd(makeAdLatestFixture().urls.release, { signal: new AbortController().signal, maxBytes: AD_METADATA_MAX_BYTES })
      expect(result.status).toBe(200)
      expect(result.body.byteLength).toBe(AD_METADATA_MAX_BYTES + extra)
      expect(cancelled).toBe(extra)
      expect(stream.locked).toBe(false)
      expect(calls).toHaveLength(1)
      assertNoLeak(result)
    })
  })

  test('signed-in fetch receives the retry AbortSignal and a late response cannot restart the check', async () => {
    const f = makeAdLatestFixture(), clock = createFakeClock(), credential = fakeToken('', 'abort')
    let attempts = 0, resolveLate!: (response: Response) => void
    await withCapturedFetch(async () => {
      if (++attempts === 1) return new Response('', { status: 403 })
      return new Promise<Response>(resolve => { resolveLate = resolve })
    }, async calls => {
      const promise = checkLatestAd(f.pins, { clock, fetchAd: fetchReleasedAd, getGitHubCredential: async () => credential })
      await clock.flush()
      expect(calls).toHaveLength(2)
      expect(calls[1]!.init.signal!.aborted).toBe(false)
      await clock.advance(AD_HTTP_TIMEOUT_MS)
      const result = await promise
      expect(failure(result, 'HTTP_TIMEOUT')).toEqual({ code: 'HTTP_TIMEOUT', source: 'github-release', access: 'signed-in' })
      expect(calls[1]!.init.signal!.aborted).toBe(true)
      resolveLate(new Response(new Uint8Array(adJson(f.release))))
      await clock.flush()
      expect(calls).toHaveLength(2)
      expect(clock.pendingCount()).toBe(0)
      publicResult(result, credential)
    })
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
