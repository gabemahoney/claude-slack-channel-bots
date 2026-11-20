/** Canned public metadata and bytes for b.bvq. No production HTTP binding. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdBaseReleaseRecord, AdFetch, AdHttpOptions, AdHttpResponse, AdPins, AdPinSources } from '../../scripts/lib/ad-latest.ts'
import { AD_FIXTURE_OTHER_VERSION, AD_FIXTURE_NEWER_VERSION, CI_AD_ADMIN_SHA256, CI_AD_BINARY_SHA256, CI_AD_CLIENT_VERSION, CI_AD_RUNTIME_COMMIT, CI_AD_RUNTIME_VERSION } from './agent-director-versions.ts'

export { AD_FIXTURE_OTHER_VERSION, AD_FIXTURE_NEWER_VERSION }

export const adBytes = (text: string): Uint8Array => new TextEncoder().encode(text)
export const adJson = (value: unknown): Uint8Array => adBytes(JSON.stringify(value))
export const adHash = (algorithm: string, bytes: Uint8Array): string => createHash(algorithm).update(bytes).digest('hex')
export const adIntegrity = (bytes: Uint8Array): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
export const AD_FIXTURE_OTHER_COMMIT = 'a'.repeat(40)
export const AD_FIXTURE_OTHER_DIGEST = 'b'.repeat(64)
const API = 'https://api.github.com/repos/gabemahoney/agent-director'

/** Read the real formats, including Bun's trailing commas; tests mutate one source. */
export function treeAdSources(root = join(import.meta.dir, '../..')): AdPinSources {
  return {
    dockerfile: readFileSync(join(root, 'docker/Dockerfile.test.base'), 'utf8'),
    packageJson: readFileSync(join(root, 'package.json'), 'utf8'),
    lockfile: readFileSync(join(root, 'bun.lock'), 'utf8'),
  }
}

export function adBaseRecord(pins: AdPins): AdBaseReleaseRecord {
  return {
    version: pins.version, commit: pins.commit,
    binary_sha256: pins.binarySha256, admin_sha256: pins.adminSha256,
    installer_sha256: pins.installerSha256, client_version: pins.clientVersion,
    client_tarball: `/opt/agent-director/client/agent-director-${pins.clientVersion}.tgz`,
    client_tarball_sha256: pins.clientTarballSha256,
  }
}

/** Synthetic short bytes keep normal tests small. Optional bytes replay the real release. */
export function makeAdLatestFixture(bytes: { installer?: Uint8Array; tarball?: Uint8Array } = {}) {
  const installer = bytes.installer ?? adBytes('#!/bin/sh\n# canned installer, never executed\n')
  const tarball = bytes.tarball ?? adBytes('canned npm tarball bytes; no extraction or execution')
  const pins: AdPins = {
    version: CI_AD_RUNTIME_VERSION, commit: CI_AD_RUNTIME_COMMIT,
    binarySha256: CI_AD_BINARY_SHA256, adminSha256: CI_AD_ADMIN_SHA256,
    installerSha256: adHash('sha256', installer), clientVersion: CI_AD_CLIENT_VERSION,
    clientTarballSha256: adHash('sha256', tarball), clientIntegrity: adIntegrity(tarball),
  }
  const sources = treeAdSources()
  const defaults: Record<string, string> = {
    AD_VERSION: pins.version, AD_COMMIT: pins.commit, AD_SHA256: pins.binarySha256,
    AD_ADMIN_SHA256: pins.adminSha256, AD_INSTALL_SH_SHA256: pins.installerSha256,
    AD_CLIENT_VERSION: pins.clientVersion, AD_CLIENT_TGZ_SHA256: pins.clientTarballSha256,
  }
  let dockerfile = sources.dockerfile
  for (const [name, value] of Object.entries(defaults)) dockerfile = dockerfile.replace(new RegExp(`^ARG ${name}=.*$`, 'm'), `ARG ${name}=${value}`)
  const fixtureSources: AdPinSources = {
    dockerfile,
    packageJson: sources.packageJson.replace(/("agent-director"\s*:\s*")[^"]+"/, `$1${pins.clientVersion}"`),
    lockfile: sources.lockfile
      .replace(/("agent-director"\s*:\s*")[^"]+"/, `$1${pins.clientVersion}"`)
      .replace(/("agent-director"\s*:\s*\["agent-director@)[^"]+"/, `$1${pins.clientVersion}"`)
      .replace(/("agent-director"\s*:\s*\[[^\n]*")sha512-[^"]+"/, `$1${pins.clientIntegrity}"`),
  }
  // Resolve an annotated tag, so accepting target_commitish=main cannot pass.
  const tagSha = 'c'.repeat(40)
  const urls = {
    release: `${API}/releases/latest`, npm: 'https://registry.npmjs.org/agent-director/latest',
    ref: `${API}/git/ref/tags/v${pins.version}`, tag: `${API}/git/tags/${tagSha}`,
    installer: `https://raw.githubusercontent.com/gabemahoney/agent-director/${pins.commit}/skills/install-agent-director/install.sh`,
    tarball: `https://registry.npmjs.org/agent-director/-/agent-director-${pins.clientVersion}.tgz`,
  }
  const release = {
    tag_name: `v${pins.version}`, draft: false, prerelease: false, target_commitish: 'main',
    assets: [
      { name: 'agent-director-linux-amd64', digest: `sha256:${pins.binarySha256}` },
      { name: 'agent-director-admin-linux-amd64', digest: `sha256:${pins.adminSha256}` },
    ],
  }
  const npm = { name: 'agent-director', version: pins.clientVersion, dist: {
    tarball: urls.tarball, integrity: pins.clientIntegrity, shasum: adHash('sha1', tarball),
  } }
  const routes = new Map<string, AdHttpResponse>([
    [urls.release, { status: 200, body: adJson(release) }],
    [urls.npm, { status: 200, body: adJson(npm) }],
    [urls.ref, { status: 200, body: adJson({ ref: `refs/tags/v${pins.version}`, object: { type: 'tag', sha: tagSha } }) }],
    [urls.tag, { status: 200, body: adJson({ object: { type: 'commit', sha: pins.commit } }) }],
    [urls.installer, { status: 200, body: installer }],
    [urls.tarball, { status: 200, body: tarball }],
  ])
  const requests: { url: string; options: AdHttpOptions }[] = []
  const fetchAd: AdFetch = async (url: string, options: AdHttpOptions) => {
    requests.push({ url, options })
    const response = routes.get(url)
    if (response === undefined) throw new Error('unlisted canned AD endpoint')
    return response
  }
  return { pins, sources: fixtureSources, urls, release, npm, tagSha, installer, tarball, routes, requests, fetchAd,
    record: adBaseRecord(pins), recordBytes: adJson(adBaseRecord(pins)) }
}
