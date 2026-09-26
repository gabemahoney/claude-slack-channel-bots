/**
 * secrecy-scan.ts — the closing scan over everything the run wrote on the
 * host side (the results dir, run.log, the container's docker logs): per
 * file, how many token-shaped strings and how many occurrences of a secret
 * value the process knows. It reports counts and file names only, never a
 * match. The run passes only when every count is 0.
 *
 * File access is injected (`ScanFs`), so tests scan an in-memory tree.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { countKnownSecrets, countTokenShaped } from './redact.ts'

export interface ScanFs {
  /** Every regular file under `dir`, recursively. */
  listFiles(dir: string): string[]
  readFile(path: string): string
}

export const nodeScanFs: ScanFs = {
  listFiles(dir) {
    const out: string[] = []
    const walk = (d: string): void => {
      for (const entry of readdirSync(d).sort()) {
        const path = join(d, entry)
        const st = statSync(path)
        if (st.isDirectory()) walk(path)
        else if (st.isFile()) out.push(path)
      }
    }
    walk(dir)
    return out
  },
  readFile: (path) => readFileSync(path, 'latin1'),
}

export interface ScanCount {
  source: string
  tokenShaped: number
  knownSecrets: number
}

export interface ScanReport {
  counts: ScanCount[]
  total: number
}

export function scanText(source: string, text: string, secrets: readonly string[]): ScanCount {
  return { source, tokenShaped: countTokenShaped(text), knownSecrets: countKnownSecrets(text, secrets) }
}

/**
 * What a file read as `nodeScanFs` reads it (latin1: one character per byte)
 * shows of `secrets`: each as it is, and each holding a character past ASCII
 * also as its UTF-8 bytes read that way, the spelling it has there.
 */
export function latin1Spellings(secrets: readonly string[]): string[] {
  const out = new Set(secrets)
  for (const s of secrets) if (/[^\x00-\x7f]/.test(s)) out.add(Buffer.from(s, 'utf-8').toString('latin1'))
  return [...out]
}

/**
 * Scan every file under `dirs` and the extra named texts. `secrets` are the
 * redactor's known forms (`knownSecrets`, every escaped form included); a
 * file is also scanned for their latin1 spellings (`latin1Spellings`).
 */
export function scanOutputs(
  dirs: readonly string[],
  extra: ReadonlyArray<{ source: string; text: string }>,
  secrets: readonly string[],
  fs: ScanFs = nodeScanFs,
): ScanReport {
  const counts: ScanCount[] = []
  const inFiles = latin1Spellings(secrets)
  for (const dir of dirs) {
    for (const file of fs.listFiles(dir)) counts.push(scanText(file, fs.readFile(file), inFiles))
  }
  for (const { source, text } of extra) counts.push(scanText(source, text, secrets))
  const total = counts.reduce((n, c) => n + c.tokenShaped + c.knownSecrets, 0)
  return { counts, total }
}

/** One line per source with a non-zero count, plus a total. Names and numbers only. */
export function describeScan(report: ScanReport): string[] {
  const lines = report.counts
    .filter((c) => c.tokenShaped + c.knownSecrets > 0)
    .map((c) => `${c.source}: ${c.tokenShaped} token-shaped, ${c.knownSecrets} known-secret`)
  lines.push(`secrecy scan: ${report.counts.length} sources, ${report.total} finding(s)`)
  return lines
}
