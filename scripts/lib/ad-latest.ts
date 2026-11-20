/** Released AD provenance. Importing this module performs no I/O. */
import { createHash } from 'node:crypto'

export interface AdPins {
  readonly version: string; readonly commit: string
  readonly binarySha256: string; readonly adminSha256: string; readonly installerSha256: string
  readonly clientVersion: string; readonly clientTarballSha256: string; readonly clientIntegrity: string
}
export interface AdPinSources { readonly dockerfile: string; readonly packageJson: string; readonly lockfile: string }
export type AdCheckCode = 'PINS_UNREADABLE' | 'PINS_INVALID' | 'PACKAGE_PIN_MISMATCH' | 'LOCK_PIN_MISMATCH'
  | 'HTTP_FAILED' | 'HTTP_STATUS' | 'HTTP_TIMEOUT' | 'HTTP_BODY_TOO_LARGE' | 'METADATA_INVALID'
  | 'RUNTIME_NOT_LATEST' | 'CLIENT_NOT_LATEST' | 'COMMIT_MISMATCH' | 'RELEASE_DIGEST_MISMATCH'
  | 'INSTALLER_DIGEST_MISMATCH' | 'CLIENT_INTEGRITY_MISMATCH' | 'CLIENT_DIGEST_MISMATCH'
  | 'BASE_RECORD_READ_FAILED' | 'BASE_RECORD_INVALID' | 'BASE_RECORD_MISMATCH'
export type AdCheckSource = 'pins' | 'github-release' | 'github-tag' | 'installer' | 'npm-metadata' | 'npm-tarball' | 'base'
export interface AdCheckError {
  readonly code: AdCheckCode; readonly source: AdCheckSource; readonly field?: string
  readonly expected?: string; readonly actual?: string; readonly status?: number
}
export type AdCheckResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AdCheckError }
export interface AdLatestClock {
  now(): number; setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void
}
export interface AdHttpOptions { readonly signal: AbortSignal; readonly maxBytes: number }
export interface AdHttpResponse { readonly status: number; readonly body: Uint8Array }
export type AdFetch = (url: string, options: AdHttpOptions) => Promise<AdHttpResponse>
export interface AdLatestDeps { readonly fetchAd: AdFetch; readonly clock: AdLatestClock }
export interface LatestAdEvidence {
  readonly runtimeVersion: string; readonly runtimeCommit: string; readonly clientVersion: string
  readonly binarySha256: string; readonly adminSha256: string; readonly installerSha256: string
  readonly clientTarballSha256: string; readonly clientIntegrity: string
}
export interface AdBaseReleaseRecord {
  readonly version: string; readonly commit: string; readonly binary_sha256: string; readonly admin_sha256: string
  readonly installer_sha256: string; readonly client_version: string; readonly client_tarball: string; readonly client_tarball_sha256: string
}
export type AdBaseRecordRead =
  { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly error: AdCheckError }

export const AD_HTTP_TIMEOUT_MS = 15_000
export const AD_LATEST_DEADLINE_MS = 120_000
export const AD_METADATA_MAX_BYTES = 1_048_576
export const AD_INSTALLER_MAX_BYTES = 1_048_576
export const AD_CLIENT_MAX_BYTES = 8_388_608
export const AD_BASE_RECORD_MAX_BYTES = 16_384
const API = 'https://api.github.com/repos/gabemahoney/agent-director'
export const AD_GITHUB_LATEST_URL = `${API}/releases/latest`
export const AD_NPM_LATEST_URL = 'https://registry.npmjs.org/agent-director/latest'
export const AD_BASE_RECORD_PATH = '/opt/agent-director/client/release.json'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/
const hash = (algorithm: string, bytes: Uint8Array) => createHash(algorithm).update(bytes).digest('hex')
const integrity = (bytes: Uint8Array) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined
function fail<T>(code: AdCheckCode, source: AdCheckSource, field?: string, expected?: string, actual?: string): AdCheckResult<T> {
  return { ok: false, error: { code, source, ...(field === undefined ? {} : { field }), ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }) } }
}

export function parseAdPins(sources: AdPinSources): AdCheckResult<AdPins> {
  const fields = { AD_VERSION: VERSION, AD_COMMIT: COMMIT, AD_SHA256: SHA256, AD_ADMIN_SHA256: SHA256,
    AD_INSTALL_SH_SHA256: SHA256, AD_CLIENT_VERSION: VERSION, AD_CLIENT_TGZ_SHA256: SHA256 }
  const args: Record<string, string> = {}
  for (const [field, pattern] of Object.entries(fields)) {
    const lines = sources.dockerfile.split('\n').filter(line => new RegExp(`^\\s*ARG\\s+${field}(?:=|\\s|$)`, 'i').test(line))
    const value = lines.length === 1 ? new RegExp(`^ARG ${field}=([^\\s]+)$`).exec(lines[0]!)?.[1] : undefined
    if (value === undefined || !pattern.test(value)) return fail('PINS_INVALID', 'pins', field)
    args[field] = value
  }
  try {
    const pkg = object(JSON.parse(sources.packageJson))
    const lock = object(Bun.JSONC.parse(sources.lockfile))
    if (!pkg || !lock) return fail('PINS_INVALID', 'pins')
    if (pkg.dependencies?.['agent-director'] !== args.AD_CLIENT_VERSION) return fail('PACKAGE_PIN_MISMATCH', 'pins')
    const entry = lock.packages?.['agent-director']
    if (lock.workspaces?.['']?.dependencies?.['agent-director'] !== args.AD_CLIENT_VERSION || !Array.isArray(entry) ||
      entry[0] !== `agent-director@${args.AD_CLIENT_VERSION}` || typeof entry[3] !== 'string' || !INTEGRITY.test(entry[3])) return fail('LOCK_PIN_MISMATCH', 'pins')
    return { ok: true, value: { version: args.AD_VERSION!, commit: args.AD_COMMIT!, binarySha256: args.AD_SHA256!,
      adminSha256: args.AD_ADMIN_SHA256!, installerSha256: args.AD_INSTALL_SH_SHA256!, clientVersion: args.AD_CLIENT_VERSION!,
      clientTarballSha256: args.AD_CLIENT_TGZ_SHA256!, clientIntegrity: entry[3] } }
  } catch { return fail('PINS_INVALID', 'pins') }
}

/** One deadline also bounds transports which ignore AbortSignal. */
async function request(url: string, source: AdCheckSource, maxBytes: number, deadline: number, deps: AdLatestDeps): Promise<AdCheckResult<Uint8Array>> {
  const controller = new AbortController()
  const wait = Math.min(AD_HTTP_TIMEOUT_MS, deadline - deps.clock.now())
  if (wait <= 0) return fail('HTTP_TIMEOUT', source)
  let timer: unknown
  const timeout = new Promise<AdCheckResult<Uint8Array>>(resolve => {
    timer = deps.clock.setTimeout(() => { controller.abort(); resolve(fail('HTTP_TIMEOUT', source)) }, wait)
  })
  const work = Promise.resolve().then(() => deps.fetchAd(url, { signal: controller.signal, maxBytes })).then((r): AdCheckResult<Uint8Array> => {
    if (r.status < 200 || r.status >= 300) return { ok: false, error: { code: 'HTTP_STATUS', source, status: r.status } }
    if (r.body.byteLength > maxBytes) return fail('HTTP_BODY_TOO_LARGE', source)
    return { ok: true, value: r.body }
  }, () => fail<Uint8Array>('HTTP_FAILED', source))
  try { return await Promise.race([work, timeout]) } finally { deps.clock.clearTimeout(timer) }
}

function json(bytes: Uint8Array): Record<string, any> | undefined {
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) } catch { return undefined }
}
class CheckFailure { constructor(readonly error: AdCheckError) {} }

export async function checkLatestAd(pins: AdPins, deps: AdLatestDeps): Promise<AdCheckResult<LatestAdEvidence>> {
  const deadline = deps.clock.now() + AD_LATEST_DEADLINE_MS
  const refuse = (code: AdCheckCode, source: AdCheckSource, field?: string): never => { throw new CheckFailure({ code, source, ...(field ? { field } : {}) }) }
  const bytes = async (url: string, source: AdCheckSource, max = AD_METADATA_MAX_BYTES): Promise<Uint8Array> => {
    const result = await request(url, source, max, deadline, deps)
    if (!result.ok) throw new CheckFailure(result.error)
    return result.value
  }
  const metadata = async (url: string, source: AdCheckSource): Promise<Record<string, any>> => {
    const value = json(await bytes(url, source))
    return value ?? refuse('METADATA_INVALID', source)
  }
  try {
    const release = await metadata(AD_GITHUB_LATEST_URL, 'github-release')
    if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || !VERSION.test(release.tag_name.slice(1)) || release.tag_name[0] !== 'v') refuse('METADATA_INVALID', 'github-release')
    if (release.tag_name !== `v${pins.version}`) refuse('RUNTIME_NOT_LATEST', 'github-release')
    const npm = await metadata(AD_NPM_LATEST_URL, 'npm-metadata')
    if (npm.name !== 'agent-director' || typeof npm.version !== 'string' || !VERSION.test(npm.version)) refuse('METADATA_INVALID', 'npm-metadata')
    if (npm.version !== pins.clientVersion) refuse('CLIENT_NOT_LATEST', 'npm-metadata')
    const tarballUrl = `https://registry.npmjs.org/agent-director/-/agent-director-${pins.clientVersion}.tgz`
    if (npm.dist?.tarball !== tarballUrl || typeof npm.dist.integrity !== 'string' || !INTEGRITY.test(npm.dist.integrity) ||
      typeof npm.dist.shasum !== 'string' || !COMMIT.test(npm.dist.shasum)) refuse('METADATA_INVALID', 'npm-metadata')
    let ref = (await metadata(`${API}/git/ref/tags/${release.tag_name}`, 'github-tag')).object
    const seen = new Set<string>()
    for (let count = 0; ref?.type === 'tag'; count++) {
      if (count >= 8 || typeof ref.sha !== 'string' || !COMMIT.test(ref.sha) || seen.has(ref.sha)) refuse('METADATA_INVALID', 'github-tag')
      seen.add(ref.sha)
      ref = (await metadata(`${API}/git/tags/${ref.sha}`, 'github-tag')).object
    }
    if (ref?.type !== 'commit' || typeof ref.sha !== 'string' || !COMMIT.test(ref.sha)) refuse('METADATA_INVALID', 'github-tag')
    if (ref.sha !== pins.commit) refuse('COMMIT_MISMATCH', 'github-tag')
    for (const [name, field] of [['agent-director-linux-amd64', 'binarySha256'], ['agent-director-admin-linux-amd64', 'adminSha256']] as const) {
      const assets = Array.isArray(release.assets) ? release.assets.filter((a: any) => a?.name === name) : []
      const digest = assets.length === 1 ? assets[0]?.digest : undefined
      if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) refuse('METADATA_INVALID', 'github-release', field)
      if (digest.slice(7) !== pins[field]) refuse('RELEASE_DIGEST_MISMATCH', 'github-release', field)
    }
    const installer = await bytes(`https://raw.githubusercontent.com/gabemahoney/agent-director/${pins.commit}/skills/install-agent-director/install.sh`, 'installer', AD_INSTALLER_MAX_BYTES)
    if (hash('sha256', installer) !== pins.installerSha256) refuse('INSTALLER_DIGEST_MISMATCH', 'installer')
    const tarball = await bytes(tarballUrl, 'npm-tarball', AD_CLIENT_MAX_BYTES)
    for (const [field, actual, expected] of [['integrity', integrity(tarball), npm.dist.integrity], ['lockIntegrity', integrity(tarball), pins.clientIntegrity], ['shasum', hash('sha1', tarball), npm.dist.shasum]]) {
      if (actual !== expected) refuse('CLIENT_INTEGRITY_MISMATCH', 'npm-tarball', field)
    }
    if (hash('sha256', tarball) !== pins.clientTarballSha256) refuse('CLIENT_DIGEST_MISMATCH', 'npm-tarball')
    return { ok: true, value: { runtimeVersion: pins.version, runtimeCommit: pins.commit, clientVersion: pins.clientVersion,
      binarySha256: pins.binarySha256, adminSha256: pins.adminSha256, installerSha256: pins.installerSha256,
      clientTarballSha256: pins.clientTarballSha256, clientIntegrity: pins.clientIntegrity } }
  } catch (error) { return { ok: false, error: error instanceof CheckFailure ? error.error : { code: 'METADATA_INVALID', source: 'github-release' } } }
}

export function compareBaseAdRecord(pins: AdPins, bytes: Uint8Array): AdCheckResult<AdBaseReleaseRecord> {
  const record = bytes.length <= AD_BASE_RECORD_MAX_BYTES ? json(bytes) : undefined
  if (!record) return fail('BASE_RECORD_INVALID', 'base')
  const expected: AdBaseReleaseRecord = { version: pins.version, commit: pins.commit, binary_sha256: pins.binarySha256,
    admin_sha256: pins.adminSha256, installer_sha256: pins.installerSha256, client_version: pins.clientVersion,
    client_tarball: `/opt/agent-director/client/agent-director-${pins.clientVersion}.tgz`, client_tarball_sha256: pins.clientTarballSha256 }
  for (const field of Object.keys(expected) as (keyof AdBaseReleaseRecord)[]) {
    const pattern = field === 'version' || field === 'client_version' ? VERSION : field === 'commit' ? COMMIT :
      field === 'client_tarball' ? /^\/opt\/agent-director\/client\/agent-director-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.tgz$/ : SHA256
    if (typeof record[field] !== 'string' || !pattern.test(record[field])) return fail('BASE_RECORD_INVALID', 'base', field)
  }
  for (const field of Object.keys(expected) as (keyof AdBaseReleaseRecord)[]) {
    if (record[field] !== expected[field]) return fail('BASE_RECORD_MISMATCH', 'base', field, expected[field], record[field])
  }
  return { ok: true, value: expected }
}

/** Print only trusted enum labels and validated comparison values. */
export function formatAdCheckError(error: AdCheckError): string {
  const parts: string[] = [error.code, error.source]
  if (error.field && /^[A-Za-z0-9_]+$/.test(error.field)) parts.push(error.field)
  if (error.status !== undefined && Number.isInteger(error.status)) parts.push(`HTTP ${error.status}`)
  for (const field of ['expected', 'actual'] as const) {
    const v = error[field]
    if (v && (VERSION.test(v) || COMMIT.test(v) || SHA256.test(v) || INTEGRITY.test(v))) parts.push(`${field}=${v}`)
  }
  return parts.join(': ')
}

/** The public, bounded HTTP binding. No auth or environment lookup. */
export const fetchReleasedAd: AdFetch = async (url, options) => {
  const target = new URL(url)
  if (target.username || target.password || !['https://api.github.com', 'https://raw.githubusercontent.com', 'https://registry.npmjs.org'].includes(target.origin)) throw new Error('Unsupported release origin')
  const response = await fetch(url, { signal: options.signal, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'cscb-ad-release-check' } })
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []
  let size = 0
  if (reader) try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > options.maxBytes) { await reader.cancel(); return { status: response.status, body: new Uint8Array(options.maxBytes + 1) } }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length }
  return { status: response.status, body }
}
