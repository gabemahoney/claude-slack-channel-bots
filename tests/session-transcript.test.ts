import { describe, expect, test } from 'bun:test'
import { locateTranscript } from '../src/session-transcript.ts'

describe('locateTranscript', () => {
  test.each([
    { jsonl_path: '/ad/opaque/rollout.jsonl', session_id: 'different-session', cwd: '/unrelated/work' },
    { jsonl_path: 'relative/ad-reported-path', session_id: 'session' },
    { jsonl_path: '/ad/no-session.jsonl' },
  ])('uses AD jsonl_path verbatim: %j', row => {
    expect(locateTranscript(row)).toBe(row.jsonl_path)
  })
  test.each([
    { session_id: 'session', cwd: '/work' },
    { jsonl_path: '', session_id: 'session', cwd: '/work' },
    {},
  ])('a row without a transcript path supplies no evidence: %j', row => {
    expect(locateTranscript(row)).toBeUndefined()
  })
})
