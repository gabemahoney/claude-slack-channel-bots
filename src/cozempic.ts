/**
 * cozempic.ts — Session cleaning via the cozempic CLI.
 *
 * Provides PATH availability checking, JSONL path resolution, file size
 * inspection, and async session cleaning using `cozempic treat`.
 *
 * SPDX-License-Identifier: MIT
 */

import { spawn } from 'child_process'
import { statSync } from 'fs'
import { homedir } from 'node:os'

// ---------------------------------------------------------------------------
// PATH availability check
// ---------------------------------------------------------------------------

let cozempicAvailable: boolean | null = null

/**
 * Checks whether `cozempic` is on PATH by spawning `which cozempic`.
 * Sets the module-scoped flag and logs the result to stderr.
 */
export async function checkCozempicAvailable(): Promise<void> {
  return new Promise<void>((resolve) => {
    const proc = spawn('which', ['cozempic'])
    proc.on('error', () => {
      cozempicAvailable = false
      console.error('[slack] Warning: cozempic not found on PATH — session cleaning disabled')
      resolve()
    })
    proc.on('close', (code) => {
      if (code === 0) {
        cozempicAvailable = true
        console.error('[slack] cozempic available')
      } else {
        cozempicAvailable = false
        console.error('[slack] Warning: cozempic not found on PATH — session cleaning disabled')
      }
      resolve()
    })
  })
}

/** Returns true if cozempic was found on PATH during the last availability check. */
export function getCozempicAvailable(): boolean {
  return cozempicAvailable === true
}

/** Resets the availability flag to null (for testing). */
export function _resetCozempicAvailable(): void {
  cozempicAvailable = null
}

// ---------------------------------------------------------------------------
// JSONL path resolution
// ---------------------------------------------------------------------------

/**
 * Builds the absolute JSONL path for a given cwd and session ID.
 * Pure function — no I/O, no validation.
 */
export function resolveJsonlPath(cwd: string, sessionId: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9-]/g, '-')
  return `${homedir()}/.claude/projects/${slug}/${sessionId}.jsonl`
}

// ---------------------------------------------------------------------------
// File size helper
// ---------------------------------------------------------------------------

/**
 * Returns the size of the file at `path` in bytes, or null if the file
 * cannot be stat'd (missing, permission error, etc.).
 */
export function readFileSizeBytes(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Session cleaning
// ---------------------------------------------------------------------------

export type CleanSessionFn = (sessionId: string, cwd: string, prescription: string) => Promise<void>

/**
 * Runs `cozempic treat <sessionId> -rx <prescription> --execute` against the
 * session's JSONL file. Always resolves — never rejects.
 *
 * Skips if the JSONL is missing or empty. Streams cozempic output to stderr
 * with the `[slack] cozempic:` prefix and logs before/after file sizes.
 */
export async function cleanSession(sessionId: string, cwd: string, prescription: string): Promise<void> {
  const path = resolveJsonlPath(cwd, sessionId)
  const beforeSize = readFileSizeBytes(path)

  if (beforeSize === null) {
    console.error(`[slack] cozempic: JSONL not found — skipping clean session=${sessionId}`)
    return
  }

  if (beforeSize === 0) {
    console.error(`[slack] cozempic: JSONL empty — skipping clean session=${sessionId}`)
    return
  }

  console.error(`[slack] cozempic: cleaning started session=${sessionId} size=${beforeSize}`)

  return new Promise<void>((resolve) => {
    const proc = spawn('cozempic', ['treat', sessionId, '-rx', prescription, '--execute'])

    proc.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.length > 0) console.error(`[slack] cozempic: ${line}`)
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.length > 0) console.error(`[slack] cozempic: ${line}`)
      }
    })

    proc.on('error', (err) => {
      console.error(`[slack] cozempic: spawn error session=${sessionId}: ${err.message}`)
      resolve()
    })

    proc.on('close', (code) => {
      const afterSize = readFileSizeBytes(path)
      if (code !== 0 && code !== null) {
        console.error(`[slack] cozempic: exit code ${code} session=${sessionId}`)
      }
      console.error(`[slack] cozempic: cleaning done session=${sessionId} size=${afterSize ?? 'unknown'}`)
      resolve()
    })
  })
}
