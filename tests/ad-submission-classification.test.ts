import { describe, expect, test } from 'bun:test'
import { ErrAgentCapabilityUnsupported, ErrExperimentalAgentDisabled, ErrHostCredentialMissing, ErrModelMissing, ErrTooManyIds, ErrSubmissionUnconfirmed } from '../src/agent-director-errors.ts'
import * as policy from '../src/ad-error-class.ts'
import { REQUIRED_ERR_NAMES, checkErrorCatalog, runStartupGate } from '../src/agent-director-startup.ts'
import { errGeneric, errSubmissionUnconfirmed, errUnknownErrorName, makePassingGateDeps } from './test-helpers/agent-director-stub.ts'
import { resetClientForTests } from '../src/agent-director-client.ts'
import { afterEach } from 'bun:test'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'

afterEach(resetClientForTests)

const additions = ['ErrSubmissionUnconfirmed', 'ErrExperimentalAgentDisabled', 'ErrAgentCapabilityUnsupported', 'ErrModelMissing', 'ErrHostCredentialMissing', 'ErrTooManyIds'] as const

describe('0.18.8 startup catalogue', () => {
  test.each([...additions])('%s is required and a dist without its class fails startup', async missing => {
    const source = [...new Set<string>([...REQUIRED_ERR_NAMES, ...additions])]
      .filter(name => name !== missing).map(name => `class ${name} extends Error {}`).join('\n')
      + `\nconst metadata = { name: '${missing}' }`
    const catalogue = checkErrorCatalog(source)
    const result = await runStartupGate(makePassingGateDeps({ probeErrorCatalog: () => catalogue }))
    expect(result.ok).toBe(false)
    expect(catalogue).toEqual({ ok: false, missing: [missing] })
    expect<readonly string[]>(REQUIRED_ERR_NAMES).toContain(missing)
  })
})

const noInput = { outcome: 'not_started', keys_sent: false, submission_confirmed: false, enter_may_have_been_sent: false }
const partial = { outcome: 'partial_input_unconfirmed', keys_sent: true, submission_confirmed: false, enter_may_have_been_sent: false }
const submitted = { outcome: 'submission_unconfirmed', keys_sent: true, submission_confirmed: false, enter_may_have_been_sent: true }

describe('native submission outcome validation', () => {
  test.each(['text', 'enter', 'pause'] as const)('not_started on %s allows only read-before-retry of that call', step => {
    const error = errSubmissionUnconfirmed(noInput)
    expect(error).toBeInstanceOf(ErrSubmissionUnconfirmed)
    expect(policy.classifyAdError(error).errorClass).toBe(policy.AD_ERROR_CLASS_STATE)
    expect(policy.submissionUnconfirmedFactsOf(error, step)).toEqual({ kind: 'not_started', step, keysSent: false, next: 'read-before-retry' })
  })

  test.each([
    ['partial_input_unconfirmed', partial],
    ['submission_unconfirmed', submitted],
    ['legacy_unconfirmed', { keys_sent: true, submission_confirmed: false, row_state: 'pending' }],
  ] as const)('%s holds automatic input and requests AD facts', (kind, details) => {
    const error = errSubmissionUnconfirmed(details)
    expect(policy.classifyAdError(error).errorClass).toBe(policy.AD_ERROR_CLASS_STATE)
    expect(policy.submissionUnconfirmedFactsOf(error, 'text')).toEqual({ kind, step: 'text', keysSent: true, next: 'hold-and-read' })
  })

  test.each(['capacity', 'admission-held'])('gateway_refused (%s) requires explicit resubmission', reason => {
    const error = errSubmissionUnconfirmed({ ...submitted, outcome: 'gateway_refused', reason })
    expect(policy.classifyAdError(error).errorClass).toBe(policy.AD_ERROR_CLASS_STATE)
    expect(policy.submissionUnconfirmedFactsOf(error, 'enter')).toEqual({ kind: 'gateway_refused', step: 'enter', keysSent: true, gatewayReason: reason === 'capacity' ? 'capacity' : 'other', next: 'explicit-resubmit' })
  })

  test.each([
    ['absent', undefined, 'missing-details'], ['null', null, 'missing-details'],
    ['empty', {}, 'missing-details'], ['array', [], 'malformed-details'],
    ['boolean string', { ...noInput, keys_sent: 'false' }, 'malformed-details'],
    ['unknown outcome', { ...submitted, outcome: 'future_outcome' }, 'unknown-outcome'],
    ['not_started attempted keys', { ...noInput, keys_sent: true }, 'contradictory-details'],
    ['not_started attempted Enter', { ...noInput, enter_may_have_been_sent: true }, 'contradictory-details'],
    ['not_started confirmed', { ...noInput, submission_confirmed: true }, 'contradictory-details'],
    ['partial attempted Enter', { ...partial, enter_may_have_been_sent: true }, 'contradictory-details'],
    ['submission Enter ruled out', { ...submitted, enter_may_have_been_sent: false }, 'contradictory-details'],
  ] as const)('%s fails closed', (_label, details, issue) => {
    const error = errSubmissionUnconfirmed(details)
    expect(policy.classifyAdError(error).errorClass).toBe(policy.AD_ERROR_CLASS_STATE)
    expect(policy.submissionUnconfirmedFactsOf(error, 'text')).toEqual({ kind: 'unknown', step: 'text', keysSent: 'unknown', issue, next: 'hold-and-read' })
  })

  test('a throwing details getter fails closed without throwing', () => {
    const error = errSubmissionUnconfirmed({})
    Object.defineProperty(error, 'errDetails', { get() { throw new Error('unreadable details') } })
    expect(policy.submissionUnconfirmedFactsOf(error, 'text')).toMatchObject({ kind: 'unknown', next: 'hold-and-read' })
  })

  test.each([
    ['base error', () => errGeneric('send-keys', 'ErrSubmissionUnconfirmed')],
    ['unknown-name wrapper', () => errUnknownErrorName('ErrSubmissionUnconfirmed')],
    ['structural error', () => Object.assign(new Error('not_started'), { errName: 'ErrSubmissionUnconfirmed', errDetails: noInput })],
  ] as const)('%s lookalike cannot authorize a retry', (_label, build) => {
    expect(policy.submissionUnconfirmedFactsOf(build(), 'text')).toBeUndefined()
  })

  test.each([ErrExperimentalAgentDisabled, ErrAgentCapabilityUnsupported, ErrModelMissing, ErrHostCredentialMissing, ErrTooManyIds].map(Constructor => [Constructor.name, Constructor] as const))('%s is operator-report, never UNAVAILABLE', (_name, Constructor) => {
    const error = new Constructor('send-keys', Constructor.name, `operator action required ${sentinelInMessage(Constructor.name)}`)
    const classification = policy.classifyAdError(error)
    expect(classification.errorClass).toBe(policy.AD_ERROR_CLASS_UNCLASSIFIED)
    assertNoLeak({ classification, line: policy.describeAdErrorClassification(classification) })
  })

  test('native facts discard sensitive descriptions and generic detail fields', () => {
    const error = errSubmissionUnconfirmed({ ...submitted, reason: sentinelInMessage('submission-reason'), private_text: sentinelInMessage('submission-body') })
    Object.defineProperty(error, 'errDescription', { value: sentinelInMessage('submission-description') })
    const classification = policy.classifyAdError(error), facts = policy.submissionUnconfirmedFactsOf(error, 'enter')
    expect(facts).toEqual({ kind: 'submission_unconfirmed', step: 'enter', keysSent: true, next: 'hold-and-read' })
    assertNoLeak({ classification, facts, line: policy.describeAdErrorClassification(classification) })
  })
})
