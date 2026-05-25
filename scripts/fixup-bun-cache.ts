#!/usr/bin/env bun
/**
 * fixup-bun-cache.ts — Workaround for bun's tarball-extraction bug.
 *
 * bun (observed in 1.3.13) sometimes drops files during tarball extraction when
 * a directory and a file share a name prefix in the same parent — e.g.
 *   node_modules/ajv/dist/core.js   (file, dropped)
 *   node_modules/ajv/dist/compile/  (sibling directory)
 * or
 *   node_modules/zod/v4/core/core.js  (file, dropped)
 *   node_modules/zod/v4/core/        (parent directory of itself)
 *
 * The cache entry under ~/.bun/install/cache/<name>@<version>@@@N contains the
 * complete tarball contents. Once a broken extraction has been hardlinked into
 * node_modules, subsequent `bun install` invocations reuse the broken state.
 *
 * This script walks every installed package, finds its cache directory, and
 * hardlinks (or copies) any file present in the cache but missing in node_modules.
 * Safe to re-run.
 */

import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  linkSync,
  copyFileSync,
} from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const ROOT = process.cwd()
const NM = join(ROOT, 'node_modules')
const CACHE = join(homedir(), '.bun', 'install', 'cache')

function* walkPackages(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.bin' || entry.name === '.cache') continue
    const child = join(dir, entry.name)
    if (entry.name.startsWith('@')) {
      for (const inner of readdirSync(child, { withFileTypes: true })) {
        if (inner.isDirectory()) {
          const innerPath = join(child, inner.name)
          yield innerPath
          const nested = join(innerPath, 'node_modules')
          if (existsSync(nested)) yield* walkPackages(nested)
        }
      }
    } else {
      yield child
      const nested = join(child, 'node_modules')
      if (existsSync(nested)) yield* walkPackages(nested)
    }
  }
}

function readVersion(pkgDir: string): string | null {
  const pj = join(pkgDir, 'package.json')
  if (!existsSync(pj)) return null
  try {
    return JSON.parse(readFileSync(pj, 'utf-8')).version ?? null
  } catch {
    return null
  }
}

function* walkFiles(dir: string, base = dir): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkFiles(child, base)
    else yield child.slice(base.length + 1)
  }
}

function findCacheDir(scope: string, name: string, version: string): string | null {
  const base = scope ? join(CACHE, `@${scope}`) : CACHE
  const prefix = `${name}@${version}@@@`
  if (!existsSync(base)) return null
  for (const entry of readdirSync(base)) {
    if (entry.startsWith(prefix)) return join(base, entry)
  }
  return null
}

function pkgIdentity(pkgDir: string): { scope: string; name: string } {
  const tail = pkgDir.split('/node_modules/').pop()!
  const parts = tail.split('/')
  if (parts[0].startsWith('@')) return { scope: parts[0].slice(1), name: parts[1] }
  return { scope: '', name: parts[0] }
}

let scanned = 0
let restored = 0
const restoredPaths: string[] = []

for (const pkgDir of walkPackages(NM)) {
  scanned++
  const version = readVersion(pkgDir)
  if (!version) continue
  const { scope, name } = pkgIdentity(pkgDir)
  const cacheDir = findCacheDir(scope, name, version)
  if (!cacheDir) continue

  for (const relFile of walkFiles(cacheDir)) {
    const installedPath = join(pkgDir, relFile)
    if (existsSync(installedPath)) continue
    const cachePath = join(cacheDir, relFile)
    mkdirSync(dirname(installedPath), { recursive: true })
    try {
      linkSync(cachePath, installedPath)
    } catch {
      copyFileSync(cachePath, installedPath)
    }
    restored++
    restoredPaths.push(installedPath.slice(NM.length + 1))
  }
}

if (restored > 0) {
  for (const p of restoredPaths) console.log(`fixup-bun-cache: restored ${p}`)
}
console.log(`fixup-bun-cache: scanned ${scanned} packages, restored ${restored} file(s)`)
