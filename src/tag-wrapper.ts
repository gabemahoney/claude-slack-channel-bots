/** Deterministic typed tags, with no I/O or module state (b.omv SR-2). */
export const TAG_MAX_BYTES = 1900
export const TAG_MIN_BODY_BYTES = 400
export const NAME_LOOKUP_TIMEOUT_MS = 2000
export const TAG_SOURCE = 'slack-channel-router'
export const TAG_ATTRIBUTE_ORDER = ['chat_id', 'channel_name', 'message_id', 'user', 'user_id', 'bot_id', 'ts', 'thread_ts', 'via', 'attachment_count', 'attachments', 'part'] as const
export type TagAttributes = Partial<Record<typeof TAG_ATTRIBUTE_ORDER[number], string>>
export type TagMessage = TagAttributes & { text?: string }
const PY_SPACE = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u
const WORD = /^[\p{L}\p{N}_]$/u
const OPENERS = '<\uff1c\ufe64\u2039\u2329\u27e8\u3008\u276e'
export function replaceLoneSurrogates(value: string): string {
  return Array.from(value, c => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff ? '\ufffd' : c).join('')
}
export function escapeAttr(value: unknown): string {
  return replaceLoneSurrogates(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
/** Python whitespace and alphanumeric boundaries, plus SR-2.2's extended openers. */
export function escapeBody(value: string): string {
  // b.omv SR-14.2 case 10: native Claude 2.1.296 rewrites U+2028 to
  // LF and composes U+0301/U+0308 with their preceding letters. Escape
  // those observed characters in the body before fixing parts;
  // receipt matching stays exact, with no normalization in the matcher.
  const chars = Array.from(replaceLoneSurrogates(value).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ''))
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!
    if (!OPENERS.includes(c)) { out += c; continue }
    let j = i + 1
    const skip = () => { while (j < chars.length && (PY_SPACE.test(chars[j]!) || IGNORABLE.test(chars[j]!))) j++ }
    skip()
    if (chars[j] === '/' || chars[j] === '\uff0f') j++
    skip()
    const nameStart = j
    let name = ''
    while (j < chars.length && name.length < 7) name += chars[j++]!.normalize('NFKC').toLowerCase()
    if (name !== 'channel' || (j < chars.length && WORD.test(chars[j]!))) { out += c; continue }
    // Preserve Python's whitespace/slash bytes; remove only ignorable prefix characters.
    out += '&lt;' + chars.slice(i + 1, nameStart).filter(x => !IGNORABLE.test(x)).join('')
    out += chars.slice(nameStart, j).join('')
    i = j - 1
  }
  return out.replace(/[\u0301\u0308\u2028]/g, c => `&#${c.codePointAt(0)};`)
}
export function tagByteLength(value: string): number { return new TextEncoder().encode(value).byteLength }
function render(attrs: TagAttributes, body: string, part?: string): string {
  const values = { ...attrs, part }
  const attributes = TAG_ATTRIBUTE_ORDER.flatMap(key => values[key] === undefined || values[key] === '' ? [] : [`${key}="${escapeAttr(values[key])}"`])
  return `<channel source="${TAG_SOURCE}" ${attributes.join(' ')}>${body}</channel>`
}
/** Unsized reference formatter, useful for wrapper.py parity. */
export function buildWrapper(message: TagMessage): string { return render(message, escapeBody(message.text ?? ''), message.part) }
function boundedAttrs(input: TagAttributes, part?: string): TagAttributes {
  const attrs = { ...input }
  for (const key of ['attachments', 'user'] as const) {
    if (tagByteLength(render(attrs, '', part)) <= TAG_MAX_BYTES - TAG_MIN_BODY_BYTES) break
    const original = attrs[key]
    if (original === undefined || original === '') continue
    const chars = Array.from(replaceLoneSurrogates(original))
    let low = 0, high = chars.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      attrs[key] = chars.slice(0, mid).join('') + '…'
      if (tagByteLength(render(attrs, '', part)) <= TAG_MAX_BYTES - TAG_MIN_BODY_BYTES) low = mid
      else high = mid - 1
    }
    attrs[key] = chars.slice(0, low).join('') + '…'
  }
  if (tagByteLength(render(attrs, '', part)) > TAG_MAX_BYTES - TAG_MIN_BODY_BYTES) throw new Error('Tag attributes exceed the minimum body allowance')
  return attrs
}
function cutBody(body: string, budget: number): [string, string] {
  let used = 0, end = 0
  for (const c of body) { const size = tagByteLength(c); if (used + size > budget) break; used += size; end += c.length }
  if (end === body.length) return [body, '']
  const prefix = body.slice(0, end)
  const lf = prefix.lastIndexOf('\n')
  const space = prefix.lastIndexOf(' ')
  const cut = lf >= 0 ? lf + 1 : space >= 0 ? space + 1 : end
  if (cut === 0) throw new Error('No room for a tag body code point')
  return [body.slice(0, cut), body.slice(cut)]
}
/** Escape once, then split losslessly, accounting for the widest part index (SR-2.3). */
export function buildTagParts(message: TagMessage): string[] {
  const body = escapeBody(message.text ?? '')
  const singleAttrs = boundedAttrs(message)
  if (tagByteLength(render(singleAttrs, body)) <= TAG_MAX_BYTES) return [render(singleAttrs, body)]
  let count = 2
  for (;;) {
    const widest = `${count}/${count}`
    const attrs = boundedAttrs(message, widest)
    const budget = TAG_MAX_BYTES - tagByteLength(render(attrs, '', widest))
    const bodies: string[] = []
    let remaining = body
    do { const [part, rest] = cutBody(remaining, budget); bodies.push(part); remaining = rest } while (remaining !== '')
    if (bodies.length > count) { count = bodies.length; continue }
    return bodies.map((part, i) => render(attrs, part, `${i + 1}/${bodies.length}`))
  }
}
