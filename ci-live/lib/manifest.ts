/**
 * manifest.ts — the test apps' manifests, generated from the repo's shipped
 * `slack-app-manifest.yml` (the manifest a customer creates each persona's app
 * from), with only the app name and bot display name changed per persona.
 *
 * `manifestDrift` compares a wanted manifest with what
 * `apps.manifest.export` returns: every leaf the wanted manifest sets must be
 * present with the same value (string arrays compare as sets). Keys Slack adds
 * on export are ignored, and so is `_metadata`.
 *
 * Pure apart from `loadRepoManifest`, whose file read is injected.
 */

import { join } from 'node:path'

import { appDisplayName, type PersonaLetter } from './personas.ts'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

export const MANIFEST_FILE = 'slack-app-manifest.yml'

/** Parse the repo manifest (YAML) into a JSON object. */
export function parseManifestYaml(text: string, parseYaml: (text: string) => unknown = (t) => Bun.YAML.parse(t)): JsonObject {
  const parsed = parseYaml(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${MANIFEST_FILE} is not a YAML mapping`)
  }
  return JSON.parse(JSON.stringify(parsed)) as JsonObject
}

export function loadRepoManifest(repoRoot: string, readFile: (path: string) => string): JsonObject {
  return parseManifestYaml(readFile(join(repoRoot, MANIFEST_FILE)))
}

function asObject(value: Json | undefined): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * The persona's manifest: the repo manifest with `display_information.name`
 * and `features.bot_user.display_name` set to "CSCB Test <X>". Everything
 * else is exactly as shipped.
 */
export function personaManifest(base: JsonObject, letter: PersonaLetter): JsonObject {
  const out = JSON.parse(JSON.stringify(base)) as JsonObject
  const name = appDisplayName(letter)
  const display = asObject(out.display_information)
  if (!display) throw new Error(`${MANIFEST_FILE} has no display_information`)
  display.name = name
  const features = asObject(out.features)
  const botUser = features ? asObject(features.bot_user) : null
  if (!botUser) throw new Error(`${MANIFEST_FILE} has no features.bot_user`)
  botUser.display_name = name
  return out
}

/** Keys of the wanted manifest that the comparison skips. */
const IGNORED_TOP_LEVEL_KEYS = new Set(['_metadata'])

function isPrimitiveArray(value: Json[]): boolean {
  return value.every((v) => v === null || typeof v !== 'object')
}

/**
 * Dotted paths of the wanted manifest's leaves that the exported manifest
 * lacks or holds with another value. Empty when the export matches.
 */
export function manifestDrift(wanted: JsonObject, exported: JsonObject): string[] {
  const drift: string[] = []
  const walk = (w: Json, e: Json | undefined, path: string): void => {
    if (Array.isArray(w)) {
      if (!Array.isArray(e)) {
        drift.push(path)
        return
      }
      if (isPrimitiveArray(w) && isPrimitiveArray(e)) {
        const ws = new Set(w.map((v) => JSON.stringify(v)))
        const es = new Set(e.map((v) => JSON.stringify(v)))
        if (ws.size !== es.size || [...ws].some((v) => !es.has(v))) drift.push(path)
        return
      }
      if (w.length !== e.length) {
        drift.push(path)
        return
      }
      w.forEach((item, i) => walk(item, e[i], `${path}[${i}]`))
      return
    }
    const wo = asObject(w)
    if (wo) {
      const eo = asObject(e ?? null)
      if (!eo) {
        drift.push(path)
        return
      }
      for (const [key, value] of Object.entries(wo)) {
        if (path === '' && IGNORED_TOP_LEVEL_KEYS.has(key)) continue
        walk(value, eo[key], path === '' ? key : `${path}.${key}`)
      }
      return
    }
    if (w !== e) drift.push(path)
  }
  walk(wanted, exported, '')
  return drift
}
