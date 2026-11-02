import { describe, expect, test } from 'bun:test'
import {
  buildTagParts, buildWrapper, escapeAttr, escapeBody, tagMaxBytesFor,
  TAG_ATTRIBUTE_ORDER, TAG_MAX_BYTES, TAG_MAX_BYTES_MACOS, TAG_MIN_BODY_BYTES, TAG_SOURCE,
  type TagMessage,
} from '../src/tag-wrapper'
import cases from './fixtures/delivery-wrapper/wrapper-cases.json'
import edges from './fixtures/delivery-wrapper/escaping-edges.json'

const LIMITS = [
  { name: 'default', limit: TAG_MAX_BYTES },
  { name: 'macOS', limit: TAG_MAX_BYTES_MACOS },
]

function injected(text: string, overrides: Partial<TagMessage> = {}): TagMessage {
  return { user: 'interject', ts: '1792000000.123456', text, ...overrides }
}

function injectedFrame(part?: string): string {
  return `<channel source="${TAG_SOURCE}" user="interject" ts="1792000000.123456"${part ? ` part="${part}"` : ''}></channel>`
}

function bodiesOf(parts: string[], expectedBody: string, limit = TAG_MAX_BYTES): string[] {
  const bodies = parts.map((part, i) => {
    expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(limit)
    expect(Buffer.from(part, 'utf8').toString('utf8')).toBe(part)
    const match = /^<channel ([^>]*)>([\s\S]*)<\/channel>$/.exec(part)
    expect(match).not.toBeNull()
    expect(match![1]!.startsWith(`source="${TAG_SOURCE}"`)).toBe(true)
    const names = [...match![1]!.matchAll(/(?:^| )([a-z_]+)="[^"]*"/g)].map(m => m[1]!)
    expect(names).toEqual(['source', ...TAG_ATTRIBUTE_ORDER.filter(name => names.includes(name))])
    if (parts.length > 1) expect(match![1]).toContain(`part="${i + 1}/${parts.length}"`)
    else expect(names).not.toContain('part')
    return match![2]!
  })
  expect(bodies.join('')).toBe(expectedBody)
  return bodies
}

describe('wrapper.py byte parity and escaping', () => {
  test.each(cases)('$name matches the independent Python wrapper exactly', ({ msg, typed }) => {
    expect(Buffer.from(buildWrapper(msg))).toEqual(Buffer.from(typed))
    expect(buildTagParts(msg)).toEqual([typed])
    expect(buildTagParts(msg, tagMaxBytesFor('linux'))).toEqual([typed])
  })

  test.each(edges.reference.attributes)('Python attribute edge: $name', ({ input, expected }) => {
    expect(escapeAttr(input)).toBe(expected)
  })

  test.each([...edges.reference.bodies, ...edges.lookalikes])('body edge: $name', ({ input, expected }) => {
    expect(escapeBody(input)).toBe(expected)
  })

  test.each([
    ['lone high', '\ud800', '\ufffd'],
    ['lone low', '\udfff', '\ufffd'],
    ['mixed paired and lone', '\ud800🦀\udfff', '\ufffd🦀\ufffd'],
    ['adjacent high', '\ud800\ud801\udc00', '\ufffd𐐀'],
  ] as const)('replaces %s surrogates before fixing body and attributes', (_, input, expected) => {
    expect(escapeAttr(input)).toBe(expected)
    expect(escapeBody(input)).toBe(expected)
    expect(buildTagParts(injected(input, { user: input }))).toEqual([
      `<channel source="${TAG_SOURCE}" user="${expected}" ts="1792000000.123456">${expected}</channel>`,
    ])
  })

  test('writes only known attributes, in canonical order, omitting empty values', () => {
    const message = {
      text: 'body', attachments: 'log.txt', attachment_count: '1', via: 'mention',
      thread_ts: 'thread', ts: 'stamp', user_id: 'U1', user: 'User', message_id: 'message',
      channel_name: 'news', chat_id: 'C1', bot_id: '', unexpected: 'ignored', source: 'forged',
    }
    expect(buildTagParts(message)).toEqual([
      `<channel source="${TAG_SOURCE}" chat_id="C1" channel_name="news" message_id="message" user="User" user_id="U1" ts="stamp" thread_ts="thread" via="mention" attachment_count="1" attachments="log.txt">body</channel>`,
    ])
    expect(buildTagParts({ user: '', text: '' })).toEqual([`<channel source="${TAG_SOURCE}" ></channel>`])
  })
})

describe('per-platform part limit', () => {
  test('pins the macOS cap and picks it only for darwin', () => {
    expect(TAG_MAX_BYTES_MACOS).toBe(880)
    expect(tagMaxBytesFor('darwin')).toBe(880)
    expect(tagMaxBytesFor('linux')).toBe(1900)
    expect(tagMaxBytesFor('win32')).toBe(TAG_MAX_BYTES)
    expect(tagMaxBytesFor('')).toBe(TAG_MAX_BYTES)
  })

  const slack = { chat_id: 'C0123456789', channel_name: 'general', user: 'laptop_sysadmin', user_id: 'U0123456789', via: 'mention', thread_ts: '1793513529.593959' }
  const slackMsg = (ts: string, text: string): TagMessage => ({ ...slack, message_id: ts, ts, text })
  const frame175 = Buffer.byteLength(buildTagParts(slackMsg('1793607852.829489', ''))[0]!)
  const line = (n: number) => 'see &lt;thing&gt; and more words '.repeat(20).slice(0, n)
  test.each([
    { name: 'seq 175 (1,023-byte single-line tag)', message: slackMsg('1793607852.829489', 'x '.repeat(600).slice(0, 1023 - frame175)) },
    { name: 'seq 182 (4 lines with Slack entities)', message: slackMsg('1793628770.052939', [line(300), line(250), line(250), line(200)].join('\n')) },
  ])('$name stays one part by default and splits under the macOS cap', ({ message }) => {
    const single = buildTagParts(message)
    expect(single).toHaveLength(1)
    expect(Buffer.byteLength(single[0]!)).toBeGreaterThan(TAG_MAX_BYTES_MACOS)
    expect(buildTagParts(message, TAG_MAX_BYTES)).toEqual(single)
    const parts = buildTagParts(message, tagMaxBytesFor('darwin'))
    expect(parts.length).toBeGreaterThan(1)
    bodiesOf(parts, escapeBody(message.text!), TAG_MAX_BYTES_MACOS)
  })
})

describe.each(LIMITS)('UTF-8 bounded parts ($name limit)', ({ limit }) => {
  test('keeps an exactly full tag unsplit and splits one more byte', () => {
    const budget = limit - Buffer.byteLength(injectedFrame())
    const exact = 'x'.repeat(budget)
    expect(buildTagParts(injected(exact), limit)).toEqual([injectedFrame().replace('></channel>', `>${exact}</channel>`)])
    const parts = buildTagParts(injected(exact + 'x'), limit)
    expect(parts).toHaveLength(2)
    const bodies = bodiesOf(parts, exact + 'x', limit)
    expect(bodies[0]).toBe('x'.repeat(limit - Buffer.byteLength(injectedFrame('2/2'))))
  })

  test.each([
    { name: 'last LF before any later space', prefix: 'a'.repeat(30) + '\n' + 'b'.repeat(40) + '\n', tail: 'c '.repeat(limit) },
    { name: 'last space when no LF fits', prefix: 'a'.repeat(30) + ' ' + 'b'.repeat(40) + ' ', tail: 'c'.repeat(limit) },
    { name: 'code point when no separator fits', prefix: '', tail: '🦀'.repeat(limit) },
  ])('splits at the $name', ({ prefix, tail }) => {
    const text = prefix + tail
    const parts = buildTagParts(injected(text), limit)
    const bodies = bodiesOf(parts, text, limit)
    const count = parts.length
    const budget = limit - Buffer.byteLength(injectedFrame(`${count}/${count}`))
    if (prefix !== '' && !tail.includes(' ')) expect(bodies[0]).toBe(prefix)
    else if (prefix.includes('\n')) expect(bodies[0]).toBe(prefix)
    else expect(bodies[0]).toBe('🦀'.repeat(Math.floor(budget / Buffer.byteLength('🦀'))))
  })

  test.each([9, 10, 99, 100])('accounts for the widest part attribute with %i parts', count => {
    const budget = limit - Buffer.byteLength(injectedFrame(`${count}/${count}`))
    const previousBudget = limit - Buffer.byteLength(injectedFrame(`${count - 1}/${count - 1}`))
    // One byte beyond the previous count's capacity forces the digit transition.
    const text = 'x'.repeat(previousBudget * (count - 1) + 1)
    const parts = buildTagParts(injected(text), limit)
    expect(parts).toHaveLength(count)
    const bodies = bodiesOf(parts, text, limit)
    expect(bodies[0]).toBe('x'.repeat(budget))
    expect(bodies.at(-1)).toBe('x'.repeat(text.length - budget * (count - 1)))
  })

  test('escapes the entire body before any split, preserving all escaped bytes', () => {
    const rawUnit = '🦀<channel>\r\n\t</CHANNEL> &lt; <@U1>\u001b'
    const escapedUnit = '🦀&lt;channel>\n    &lt;/CHANNEL> &lt; <@U1>'
    const parts = buildTagParts(injected(rawUnit.repeat(TAG_MIN_BODY_BYTES)), limit)
    expect(parts.length).toBeGreaterThan(1)
    const bodies = bodiesOf(parts, escapedUnit.repeat(TAG_MIN_BODY_BYTES), limit)
    expect(bodies.join('')).not.toMatch(/<\/?channel/i)
  })

  test('repairs lone surrogates before multibyte splitting', () => {
    const raw = '猫\ud800🦀\udfff'.repeat(TAG_MIN_BODY_BYTES)
    const expected = '猫\ufffd🦀\ufffd'.repeat(TAG_MIN_BODY_BYTES)
    bodiesOf(buildTagParts(injected(raw), limit), expected, limit)
  })
})

describe.each(LIMITS)('metadata truncation preserves the minimum body allowance ($name limit)', ({ limit }) => {
  test.each([
    { name: 'multibyte code points', inputUnit: '🦀', encodedUnit: '🦀' },
    { name: 'XML-escaped attribute expansion', inputUnit: '&', encodedUnit: '&amp;' },
  ])('truncates attachments at $name and keeps the full sender and true count', ({ inputUnit, encodedUnit }) => {
    const text = 'x'.repeat(TAG_MIN_BODY_BYTES * 4)
    const parts = buildTagParts(injected(text, { attachment_count: '73', attachments: inputUnit.repeat(limit) }), limit)
    const count = parts.length
    const frame = `<channel source="${TAG_SOURCE}" user="interject" ts="1792000000.123456" attachment_count="73" attachments="…" part="${count}/${count}"></channel>`
    const available = limit - TAG_MIN_BODY_BYTES - Buffer.byteLength(frame)
    const kept = encodedUnit.repeat(Math.floor(available / Buffer.byteLength(encodedUnit))) + '…'
    bodiesOf(parts, text, limit)
    for (const part of parts) {
      expect(part).toContain('user="interject"')
      expect(part).toContain(`attachment_count="73" attachments="${kept}"`)
      const overhead = Buffer.byteLength(part.slice(0, part.indexOf('>') + 1) + '</channel>')
      expect(limit - overhead).toBeGreaterThanOrEqual(TAG_MIN_BODY_BYTES)
    }
  })

  test('exhausts attachments before shortening a still oversized sender', () => {
    const text = 'x'.repeat(TAG_MIN_BODY_BYTES * 4)
    const parts = buildTagParts(injected(text, {
      user: '猫'.repeat(limit), attachment_count: '73', attachments: '🦀'.repeat(limit),
    }), limit)
    const count = parts.length
    const frame = `<channel source="${TAG_SOURCE}" user="…" ts="1792000000.123456" attachment_count="73" attachments="…" part="${count}/${count}"></channel>`
    const available = limit - TAG_MIN_BODY_BYTES - Buffer.byteLength(frame)
    const keptUser = '猫'.repeat(Math.floor(available / Buffer.byteLength('猫'))) + '…'
    bodiesOf(parts, text, limit)
    for (const part of parts) {
      expect(part).toContain(`user="${keptUser}" ts="1792000000.123456" attachment_count="73" attachments="…"`)
      const overhead = Buffer.byteLength(part.slice(0, part.indexOf('>') + 1) + '</channel>')
      expect(limit - overhead).toBeGreaterThanOrEqual(TAG_MIN_BODY_BYTES)
    }
  })

  test('shortens a CJK channel name last, only when attachments and sender cannot fit', () => {
    const text = 'x'.repeat(TAG_MIN_BODY_BYTES * 4)
    const channel = '営'.repeat(80)
    const parts = buildTagParts(injected(text, {
      chat_id: 'C0123456789', channel_name: channel, message_id: '1793607852.829489', user: '猫'.repeat(limit),
      user_id: 'U0123456789', thread_ts: '1793513529.593959', via: 'receive_all', attachment_count: '73', attachments: '🦀'.repeat(limit),
    }), limit)
    const count = parts.length
    const attrs = (channelName: string, user: string) => `chat_id="C0123456789" channel_name="${channelName}" message_id="1793607852.829489" user="${user}" user_id="U0123456789" ts="1792000000.123456" thread_ts="1793513529.593959" via="receive_all" attachment_count="73" attachments="…"`
    const available = (channelName: string) => limit - TAG_MIN_BODY_BYTES - Buffer.byteLength(`<channel source="${TAG_SOURCE}" ${attrs(channelName, '…')} part="${count}/${count}"></channel>`)
    const fits = available(channel) >= 0
    expect(fits).toBe(limit === TAG_MAX_BYTES)
    const keptUser = fits ? '猫'.repeat(Math.floor(available(channel) / Buffer.byteLength('猫'))) + '…' : '…'
    const keptChannel = fits ? channel : '営'.repeat(Math.floor(available('…') / Buffer.byteLength('営'))) + '…'
    bodiesOf(parts, text, limit)
    for (const part of parts) {
      expect(part).toContain(attrs(keptChannel, keptUser))
      const overhead = Buffer.byteLength(part.slice(0, part.indexOf('>') + 1) + '</channel>')
      expect(limit - overhead).toBeGreaterThanOrEqual(TAG_MIN_BODY_BYTES)
    }
  })

  test('shortens a long injected sender even with no attachments', () => {
    const text = 'x'.repeat(TAG_MIN_BODY_BYTES)
    const frame = `<channel source="${TAG_SOURCE}" user="…" ts="1792000000.123456"></channel>`
    const kept = '猫'.repeat(Math.floor((limit - TAG_MIN_BODY_BYTES - Buffer.byteLength(frame)) / Buffer.byteLength('猫'))) + '…'
    expect(buildTagParts(injected(text, { user: '猫'.repeat(limit) }), limit)).toEqual([
      `<channel source="${TAG_SOURCE}" user="${kept}" ts="1792000000.123456">${text}</channel>`,
    ])
  })

  test('does not truncate metadata leaving exactly the minimum body bytes', () => {
    const text = 'x'.repeat(TAG_MIN_BODY_BYTES)
    const frame = `<channel source="${TAG_SOURCE}" user="interject" ts="1792000000.123456" attachment_count="73" attachments=""></channel>`
    const attachment = 'a'.repeat(limit - TAG_MIN_BODY_BYTES - Buffer.byteLength(frame))
    expect(buildTagParts(injected(text, { attachment_count: '73', attachments: attachment }), limit)).toEqual([
      `<channel source="${TAG_SOURCE}" user="interject" ts="1792000000.123456" attachment_count="73" attachments="${attachment}">${text}</channel>`,
    ])
  })

  test('is deterministic across unrelated calls and neither mutates nor reuses input/output state', () => {
    const message = Object.freeze(injected('🦀'.repeat(limit), { user: '猫'.repeat(limit) }))
    const before = { ...message }
    const first = buildTagParts(message, limit)
    const expected = [...first]
    buildTagParts(injected('different', { user: 'another' }), limit)
    first[0] = 'caller mutation'
    expect(buildTagParts(message, limit)).toEqual(expected)
    expect(message).toEqual(before)
  })
})

// Native input observations extend body escaping only; reference corpus is unchanged.
describe('native input rewrites', () => {
  test.each([
    ['line separator', '\u2028', '&#8232;'],
    ['combining acute', 'e\u0301', 'e&#769;'],
    ['combining diaeresis', 'u\u0308', 'u&#776;'],
  ])('escapes %s in the body while preserving attribute bytes', (_name, raw, escaped) => {
    expect(escapeBody(raw)).toBe(escaped)
    expect(escapeAttr(raw)).toBe(raw)
    expect(buildTagParts(injected(raw))).toEqual([injectedFrame().replace('></channel>', `>${escaped}</channel>`)])
  })
})
