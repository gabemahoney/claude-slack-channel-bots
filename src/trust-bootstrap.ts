/**
 * trust-bootstrap.ts — Pre-accept the trust dialog and project onboarding in
 * each persona's `.claude.json` (b.av2 SR-6.2).
 *
 * For a persona, ensures that `projects[<working_directory>].hasTrustDialogAccepted`
 * and `projects[<working_directory>].hasCompletedProjectOnboarding` are both
 * `true` in `<claude_config_dir>/.claude.json`, where `claude_config_dir` is
 * the persona's effective directory (per-persona, else top-level). Two entry
 * points share one patch:
 *
 *   - `trustBootstrap(personaConfig)` — the start pass: patches once per
 *     applied persona before anything launches. Failures are recorded with
 *     `recordStartupError` (classes `trust-bootstrap`,
 *     `trust-bootstrap-config-missing`, `trust-bootstrap-config-parse`).
 *   - `trustPatchPersona(persona)` — the per-launch patch: the session manager
 *     calls it (through its pre-launch patcher seam) before every spawn,
 *     resume or restart. Failures are only logged, never recorded, so a
 *     restart adds nothing to `startup-errors.log`.
 *
 * The patch is idempotent (no write when both flags are already `true`),
 * writes atomically (`.tmp` + rename), never creates a missing `.claude.json`
 * and never throws. A persona with no configured `claude_config_dir` is logged
 * and skipped: Claude uses its own default and there is nothing to patch.
 *
 * The read-modify-write is fully synchronous (no `await` between reading and
 * writing): the start's worker pool launches several personas at once and two
 * personas can share one config dir, so an interleaved patch of the same file
 * could otherwise lose an update.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { type Persona, type PersonaConfig } from './config.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { recordStartupError } from './startup-errors.ts'

// ---------------------------------------------------------------------------
// Types for .claude.json shape (minimal — we only care about projects[cwd])
// ---------------------------------------------------------------------------

interface ClaudeJsonProject {
  hasTrustDialogAccepted?: boolean
  hasCompletedProjectOnboarding?: boolean
  [key: string]: unknown
}

interface ClaudeJson {
  projects?: Record<string, ClaudeJsonProject>
  [key: string]: unknown
}

/** Where a patch failure goes: its startup-error class, detail text and cause. */
type TrustPatchFailureSink = (errorClass: string, detail: string, cause: unknown) => void

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start pass: patch `<claude_config_dir>/.claude.json` for every applied
 * persona so that the trust dialog and project onboarding are pre-accepted.
 * Each persona is patched once, whatever the number of channels it lists.
 * Idempotent. Never throws; per-persona failures are recorded with
 * `recordStartupError` so one bad persona cannot block the rest.
 */
export async function trustBootstrap(personaConfig: PersonaConfig): Promise<void> {
  for (const persona of personaConfig.personas) {
    try {
      patchPersonaClaudeJson(persona, recordStartupError)
    } catch (err) {
      // Catch-all: any per-persona failure that slips past inner handlers
      recordStartupError(
        'trust-bootstrap',
        `unexpected error for ${personaRef(persona)} cwd=${persona.working_directory}`,
        err,
      )
    }
  }
}

/**
 * Per-launch patch for one persona (b.av2 SR-6.2): the same patch as the start
 * pass, run before every spawn, resume or restart. Failures are logged only —
 * never recorded with `recordStartupError` — and never thrown.
 */
export function trustPatchPersona(persona: Persona): void {
  const logFailure: TrustPatchFailureSink = (errorClass, detail, cause) => {
    console.error(`[slack] trust-bootstrap: pre-launch patch failed [${errorClass}] ${detail} — ${describeCause(cause)}`)
  }
  try {
    patchPersonaClaudeJson(persona, logFailure)
  } catch (err) {
    logFailure('trust-bootstrap', `unexpected error for ${personaRef(persona)} cwd=${persona.working_directory}`, err)
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function personaRef(persona: Pick<Persona, 'name' | 'key'>): string {
  return renderPersonaRef(persona.name, persona.key)
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`
  return String(cause)
}

/**
 * The patch shared by both entry points. Fully synchronous. Read and parse
 * failures go to `onFailure`; a write failure throws to the caller's catch-all.
 */
function patchPersonaClaudeJson(persona: Persona, onFailure: TrustPatchFailureSink): void {
  const ref = personaRef(persona)
  const cwd = persona.working_directory
  const claudeConfigDir = persona.claude_config_dir

  // If no claude_config_dir is configured, Claude uses its own default and
  // there is nothing for us to patch.
  if (claudeConfigDir === undefined) {
    console.error(`[slack] trust-bootstrap: ${ref} has no claude_config_dir — skipping`)
    return
  }

  const configPath = join(claudeConfigDir, '.claude.json')

  // Read .claude.json — soft-fail if missing or unreadable
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch (err) {
    console.error(
      `[slack] trust-bootstrap: ${ref} .claude.json not found or unreadable at ${configPath} — skipping`,
    )
    onFailure('trust-bootstrap-config-missing', `${ref}: cannot read ${configPath}`, err)
    return
  }

  // Parse JSON
  let doc: ClaudeJson
  try {
    doc = JSON.parse(raw) as ClaudeJson
  } catch (err) {
    onFailure('trust-bootstrap-config-parse', `${ref}: malformed JSON in ${configPath}`, err)
    return
  }

  // Locate or create projects[cwd]
  if (typeof doc.projects !== 'object' || doc.projects === null) {
    doc.projects = {}
  }
  const project: ClaudeJsonProject = doc.projects[cwd] ?? {}

  // Idempotency: skip write if both flags are already true
  if (project.hasTrustDialogAccepted === true && project.hasCompletedProjectOnboarding === true) {
    return
  }

  // Patch flags
  project.hasTrustDialogAccepted = true
  project.hasCompletedProjectOnboarding = true
  doc.projects[cwd] = project

  // Write atomically: write to .tmp + rename
  const tmp = configPath + '.tmp'
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf-8')
  renameSync(tmp, configPath)
}
