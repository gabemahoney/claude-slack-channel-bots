

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateTranscript } from '../src/session-transcript.ts'
import {
  TRANSCRIPT_SESSION_ID
} from './test-helpers/working-row-panes.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cscb-transcript-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// locateTranscript — which file belongs to the row's session
// ---------------------------------------------------------------------------

describe('locateTranscript', () => {
  const persisted = `/cfg/.claude/projects/-work-nightly/${TRANSCRIPT_SESSION_ID}.jsonl`
  const composed = `/other/.claude/projects/-work-nightly-bot/${TRANSCRIPT_SESSION_ID}.jsonl`
  const row = { jsonl_path: persisted, session_id: TRANSCRIPT_SESSION_ID, cwd: '/work/nightly bot' }

  test.each<[string, Parameters<typeof locateTranscript>[0], string | undefined, string | undefined]>([
    ['the persisted jsonl_path, named for the row\'s session', row, '/other/.claude', persisted],
    ['a persisted path left from an earlier session: the composed path under the config dir', { ...row, jsonl_path: '/cfg/.claude/projects/-work-nightly/0000aaaa-old-session.jsonl' }, '/other/.claude', composed],
    ['no persisted path (a fresh session\'s row): the composed path', { ...row, jsonl_path: '' }, '/other/.claude', composed],
    ['a persisted path from an earlier session and no config dir: none', { ...row, jsonl_path: '/cfg/old.jsonl' }, undefined, undefined],
    ['no persisted path and no cwd: none', { ...row, jsonl_path: '', cwd: '' }, '/other/.claude', undefined],
    ['no session ID: the persisted path as it is', { ...row, jsonl_path: '/cfg/any.jsonl', session_id: '' }, '/other/.claude', '/cfg/any.jsonl'],
    ['no session ID and no persisted path: none', { jsonl_path: '', session_id: '', cwd: '/work' }, '/other/.claude', undefined],
  ])('%s', (_label, fields, configDir, expected) => {
    expect(locateTranscript(fields, configDir)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
