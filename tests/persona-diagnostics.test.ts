import { describe, expect, test } from 'bun:test'
import { formatPersonaDiagnostic, PERSONA_THREAD_STAMP_UNDECIDED, threadStampUndecidedCause } from '../src/persona-diagnostics.ts'
import { threadMemoryLoadAtApplyFailedLine } from '../src/persona-lifecycle.ts'
import { assertNoLeak, LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, sentinelInMessage } from './test-helpers/credentials.ts'

describe('undecided Thread Memory stamp diagnostic', () => {
  test('pins the exported cause, review/apply remedy and finite-Slack-retry limitation', () => {
    const cause = threadStampUndecidedCause('C123')
    expect(cause).toBe("channel=C123: thread-dependent replies remain unacknowledged until the shared-state restoration is reviewed and applied; finite Slack retries do not guarantee recovery of never-accepted events. Check the app's event subscriptions and resend missing replies after recovery.")
    const line = formatPersonaDiagnostic({ class: PERSONA_THREAD_STAMP_UNDECIDED, name: 'Alpha', key: 'alpha', index: 0, cause })
    expect(line).toBe(`[slack] ${PERSONA_THREAD_STAMP_UNDECIDED}: personas[0] "Alpha" (key=alpha): ${cause}`)
    assertNoLeak({ cause, line })
  })

  test('redacts token and URL-shaped input and keeps the diagnostic on one line', () => {
    const cause = threadStampUndecidedCause(`C123\r\n${sentinelInMessage('stamp')}\u2028\u001b`)
    const line = formatPersonaDiagnostic({ class: PERSONA_THREAD_STAMP_UNDECIDED, name: 'Alpha', key: 'alpha', index: 0, cause })
    expect(cause).toContain(REDACTED_SENTINEL_TAIL)
    expect(line).toContain(REDACTED_SENTINEL_TAIL)
    expect(line).not.toMatch(/[\r\n\u2028\u001b]/)
    expect(line).toContain('\\u2028\\u001b')
    assertNoLeak({ cause, line })
  })
})

describe('Thread Memory load failure diagnostic', () => {
  test('pins the exported apply-load failure line', () => {
    const error = Object.assign(new Error('journal unavailable'), { code: 'EIO', stack: undefined })
    const line = threadMemoryLoadAtApplyFailedLine({ name: 'Alpha Desk', key: 'alpha' }, error)
    expect(line).toBe('[slack] persona "Alpha Desk" (key=alpha): Thread Memory load at apply failed: Error code=EIO message="journal unavailable"')
    assertNoLeak({ line })
  })

  test('keeps a described failure while redacting tokens and ticket URLs and ignoring raw error payloads', () => {
    const error = Object.assign(new Error(sentinelInMessage('load-builder')), {
      code: 'EACCES', stack: undefined, data: LEAK_SENTINEL, original: LEAK_SENTINEL,
    })
    const line = threadMemoryLoadAtApplyFailedLine({ name: 'Alpha Desk', key: 'alpha' }, error)
    expect(line).toContain(`Error code=EACCES message="${REDACTED_SENTINEL_TAIL}"`)
    assertNoLeak({ line })
  })
})
