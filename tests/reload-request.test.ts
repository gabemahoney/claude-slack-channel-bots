import { expect, test } from 'bun:test'
import { buildOperatorAssignment, buildReviewRequest, composeReviewRequest, emptyOperatorIntent, parseReviewRequestBytes, reviewIntentLine, reviewRequestDiagnostic, validateOperatorIntent, REVIEW_REQUEST_FORMAT, REVIEW_REQUEST_SUFFIX } from '../src/reload-request.ts'
import { assertNoLeak, LEAK_SENTINEL } from './test-helpers/credentials.ts'

const target = buildOperatorAssignment({ key: 'alpha', name: 'alpha', working_directory: '/fixture/work', credentials_file: '/fixture/credentials.json' }, 'current-life', 'C0TEST001', 'all')
const seed = () => buildReviewRequest('review_1', 0, 'request', [target])

test.each(['request', 'revise', 'refresh', 'cancel'] as const)('%s grammar roundtrips without aliases or caller mutation', action => {
  const request = buildReviewRequest('review-1', 7, action, action === 'request' || action === 'revise' ? [target] : [])
  const bytes = composeReviewRequest(request)
  expect(parseReviewRequestBytes(Buffer.from(bytes))).toEqual(request)
  const parsed = parseReviewRequestBytes(Buffer.from(bytes))!
  if ('assignments' in parsed) parsed.assignments[0]!.delivery = 'off'
  expect(composeReviewRequest(request)).toBe(bytes)
  expect(bytes.endsWith('\n')).toBe(true)
})

test.each(['unknown', 'missing', 'action', 'format', 'id-empty', 'id-long', 'id-path', 'negative', 'fraction', 'generation-type', 'duplicate', 'bad-channel', 'bad-value', 'missing-life', 'bad-declaration', 'extra-declaration', 'extra-assignment', 'refresh-assignment'] as const)('invalid %s request is refused without exposing the submitted content', variant => {
  const request = JSON.parse(composeReviewRequest(seed()))
  switch (variant) {
    case 'unknown': request.secret = LEAK_SENTINEL; break
    case 'missing': delete request.request_id; break
    case 'action': request.action = LEAK_SENTINEL; break
    case 'format': request.format = 'legacy'; break
    case 'id-empty': request.request_id = ''; break
    case 'id-long': request.request_id = 'a'.repeat(129); break
    case 'id-path': request.request_id = '../request'; break
    case 'negative': request.intent_generation = -1; break
    case 'fraction': request.intent_generation = 1.5; break
    case 'generation-type': request.intent_generation = '0'; break
    case 'duplicate': request.assignments.push(request.assignments[0]); break
    case 'bad-channel': request.assignments[0].channel = LEAK_SENTINEL; break
    case 'bad-value': request.assignments[0].delivery = LEAK_SENTINEL; break
    case 'missing-life': delete request.assignments[0].incarnation; break
    case 'bad-declaration': request.assignments[0].declaration.working_directory = null; break
    case 'extra-declaration': request.assignments[0].declaration.secret = LEAK_SENTINEL; break
    case 'extra-assignment': request.assignments[0].secret = LEAK_SENTINEL; break
    case 'refresh-assignment': request.action = 'refresh'; break
  }
  expect(parseReviewRequestBytes(Buffer.from(JSON.stringify(request)))).toBeUndefined()
  let error: unknown
  try { composeReviewRequest(request) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(Error); assertNoLeak(String(error))
})

test('request parsing refuses malformed JSON/UTF-8, accepts the ID boundary and rejects declarations on nonassignment actions', () => {
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff, 0xfe]), Buffer.from('null'), Buffer.from('[]')]) expect(parseReviewRequestBytes(bytes)).toBeUndefined()
  expect(parseReviewRequestBytes(Buffer.from(composeReviewRequest(buildReviewRequest('a'.repeat(128), Number.MAX_SAFE_INTEGER, 'refresh'))))).toBeDefined()
  expect(() => buildReviewRequest('id', 0, 'cancel', [target])).toThrow('takes no assignments')
  expect(() => buildReviewRequest('id', 0, 'refresh', [target])).toThrow('takes no assignments')
})

test.each(['wrong-id', 'future-generation', 'wrong-base-generation', 'cancelled-assignment'] as const)('durable operator history rejects %s evidence', variant => {
  const intent = { ...emptyOperatorIntent(), generation: 1, requested: true, assignments: [target], requests: { review_1: { request: seed(), generation: 1 } } }
  validateOperatorIntent(intent)
  if (variant === 'wrong-id') intent.requests.review_1.request.request_id = 'foreign'
  if (variant === 'future-generation') intent.requests.review_1.generation = 2
  if (variant === 'wrong-base-generation') intent.requests.review_1.request.intent_generation = 1
  if (variant === 'cancelled-assignment') intent.requested = false
  expect(() => validateOperatorIntent(intent)).toThrow()
})

test('operator grammar and intent text have one literal pin; diagnostic categories expose only result and generation', () => {
  expect(REVIEW_REQUEST_FORMAT).toBe('cscb-review-request-v1'); expect(REVIEW_REQUEST_SUFFIX).toBe('.request')
  expect(reviewIntentLine(2, 3)).toBe('Operator intent generation=2; declared assignments=3. Requests change intent only; rename the reviewed pending file to the apply name to confirm.')
  for (const result of ['recorded', 'duplicate', 'invalid', 'stale', 'failed', 'unresolved'] as const) {
    const line = reviewRequestDiagnostic(result, 2)
    expect(line).toContain(`${result}; intent generation=2.`)
    expect(line).toContain('Applied configuration is unchanged.')
    assertNoLeak(line)
  }
})
