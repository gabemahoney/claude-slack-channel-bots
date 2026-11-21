/** Deterministic typed tags, with no I/O or module state. */
export const TAG_MAX_BYTES = 1900
/** Claude Code on macOS loses a typed burst over about 900 bytes, wrapper included. */
export const TAG_MAX_BYTES_MACOS = 880
export const TAG_MIN_BODY_BYTES = 400
/** Bound per-code-point normalization work on pathological combining runs. */
export const TAG_NFC_MAX_SUFFIX_UNITS = 64
export const NAME_LOOKUP_TIMEOUT_MS = 2000
export const TAG_SOURCE = 'slack-channel-router'
export const TAG_ATTRIBUTE_ORDER = ['chat_id', 'channel_name', 'message_id', 'user', 'user_id', 'bot_id', 'ts', 'thread_ts', 'via', 'reaction', 'emoji', 'attachment_count', 'attachments', 'part'] as const
export type TagAttributes = Partial<Record<typeof TAG_ATTRIBUTE_ORDER[number], string>>
export type TagMessage = TagAttributes & { text?: string }
/** A Reaction Notice's fields: message_id is the reacted message's ts, ts the reaction event's ts, emoji the name without colons. */
export type ReactionNoticeInput = {
  chat_id: string; channel_name: string; message_id: string; user: string; ts: string; thread_ts?: string
  reaction: 'added' | 'removed'; emoji: string
} & ({ user_id: string; bot_id?: never } | { bot_id: string; user_id?: never })
/** The only builder that sets via="reaction", reaction or emoji. Fields are copied by name, never spread, so nothing else reaches the tag. */
export function buildReactionNoticeMessage(input: ReactionNoticeInput): TagMessage {
  const message: TagMessage = {
    chat_id: input.chat_id, channel_name: input.channel_name, message_id: input.message_id, user: input.user,
    ts: input.ts, thread_ts: input.thread_ts, via: 'reaction', reaction: input.reaction, emoji: input.emoji, text: '',
  }
  if (input.user_id !== undefined) message.user_id = input.user_id
  else message.bot_id = input.bot_id
  return message
}
const PY_SPACE = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u
const WORD = /^[\p{L}\p{N}_]$/u
const OPENERS = '<\uff1c\ufe64\u2039\u2329\u27e8\u3008\u276e'
const ANY_OPENER = /[<\uff1c\ufe64\u2039\u2329\u27e8\u3008\u276e]/
const NATIVE_REWRITE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\u2028\u2029\u0301\u0308]/u
const MARK = /^\p{M}$/u
/** Keep an NFC-stable suffix: the last non-mark and following marks, bounded
 * by an escaped mark. NFC can reach past marks; Hangul composes non-marks. */
function escapeNativeRewrites(value: string): string {
  // A split can put any mark beside the tag's closing '>'. Protect marks
  // that compose there too, even when they were stable in their original place.
  const escaped = value.replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{M}\u2028\u2029]/gu, c =>
    NATIVE_REWRITE.test(c) || ('>' + c).normalize('NFC') !== '>' + c ? `&#${c.codePointAt(0)};` : c)
  let out = '', suffix = ''
  for (const c of escaped) {
    const next = suffix + c
    const mark = MARK.test(c)
    // A decimal entity ends the normalization segment without losing c.
    // Thus the walk normalizes at most MAX_SUFFIX_UNITS + 2 units per step.
    if ((mark && next.length > TAG_NFC_MAX_SUFFIX_UNITS) || next.normalize('NFC') !== next) {
      out += `&#${c.codePointAt(0)};`
      suffix = '' // The entity's final semicolon blocks composition/reordering.
    } else {
      out += c
      suffix = mark ? next : c
    }
  }
  return out
}
/** Each unpaired surrogate becomes U+FFFD; paired ones stay. */
export function replaceLoneSurrogates(value: string): string {
  return (value as string & { toWellFormed(): string }).toWellFormed()
}
export function escapeAttr(value: unknown): string {
  // XML first: its ampersand replacement must not double-escape the new
  // decimal entities. The same bounded native protection covers every value.
  const xml = replaceLoneSurrogates(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escapeNativeRewrites(xml)
}
/** Python whitespace and alphanumeric boundaries, plus extended openers. */
export function escapeBody(value: string): string {
  // Neutralize channel/paste-frame openers, then decimal-escape DICP/Cf,
  // line/paragraph separators and characters that would change under NFC.
  // Preserve the unconditional acute/diaeresis escapes. Escape before fixing
  // parts; receipt matching stays exact, without normalization in the matcher.
  const cleaned = replaceLoneSurrogates(value).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
  // With no opener, the walk below copies every character unchanged.
  const chars = ANY_OPENER.test(cleaned) ? Array.from(cleaned) : []
  let out = chars.length ? '' : cleaned
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!
    if (!OPENERS.includes(c)) { out += c; continue }
    let j = i + 1
    const skip = () => { while (j < chars.length && (PY_SPACE.test(chars[j]!) || IGNORABLE.test(chars[j]!))) j++ }
    skip()
    if (chars[j] === '/' || chars[j] === '\uff0f') j++
    skip()
    const nameStart = j
    const nameEnd = ['channel', 'pasted_content'].map(target => {
      let end = nameStart, name = ''
      while (end < chars.length && name.length < target.length) name += chars[end++]!.normalize('NFKC').toLowerCase()
      return name === target && !(end < chars.length && WORD.test(chars[end]!)) ? end : 0
    }).find(Boolean)
    if (!nameEnd) { out += c; continue }
    j = nameEnd
    // Preserve Python's whitespace/slash bytes; remove only ignorable prefix characters.
    out += '&lt;' + chars.slice(i + 1, nameStart).filter(x => !IGNORABLE.test(x)).join('')
    out += chars.slice(nameStart, j).join('')
    i = j - 1
  }
  return escapeNativeRewrites(out)
}
/** UTF-8 bytes, counting an unpaired surrogate as its U+FFFD replacement's three, as `TextEncoder` encodes it. */
export function tagByteLength(value: string): number { return Buffer.byteLength(value, 'utf8') }
/** The typed part limit for the host the agent runs on, which is the server's own host. */
export function tagMaxBytesFor(platform: string): number { return platform === 'darwin' ? TAG_MAX_BYTES_MACOS : TAG_MAX_BYTES }
function render(attrs: TagAttributes, body: string, part?: string): string {
  const values = { ...attrs, part }
  const attributes = TAG_ATTRIBUTE_ORDER.flatMap(key => values[key] === undefined || values[key] === '' ? [] : [`${key}="${escapeAttr(values[key])}"`])
  return `<channel source="${TAG_SOURCE}" ${attributes.join(' ')}>${body}</channel>`
}
/** Unsized reference formatter, useful for wrapper.py parity. */
export function buildWrapper(message: TagMessage): string { return render(message, escapeBody(message.text ?? ''), message.part) }
function boundedAttrs(input: TagAttributes, maxBytes: number, part?: string): TagAttributes {
  const attrs = { ...input }
  const allowance = maxBytes - TAG_MIN_BODY_BYTES
  for (const key of ['attachments', 'user', 'channel_name'] as const) {
    if (tagByteLength(render(attrs, '', part)) <= allowance) break
    const original = attrs[key]
    if (original === undefined || original === '') continue
    // Trim original code points, then render each candidate through escapeAttr:
    // byte budgets include all expansions and no generated entity can be cut.
    const chars = Array.from(replaceLoneSurrogates(original))
    let low = 0, high = chars.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      attrs[key] = chars.slice(0, mid).join('') + '…'
      if (tagByteLength(render(attrs, '', part)) <= allowance) low = mid
      else high = mid - 1
    }
    attrs[key] = chars.slice(0, low).join('') + '…'
  }
  if (tagByteLength(render(attrs, '', part)) > allowance) throw new Error('Tag attributes exceed the minimum body allowance')
  return attrs
}
/** `tagByteLength` of one code point: an unpaired surrogate's is U+FFFD's. */
function codePointBytes(codePoint: number): number { return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4 }
function cutBody(body: string, budget: number): [string, string] {
  let used = 0, end = 0
  while (end < body.length) {
    // Keep generated decimal escapes and literal 1–7-digit decimal references
    // whole. Other entities and longer literal references may split.
    const entity = body[end] === '&' ? /^&#\d{1,7};/.exec(body.slice(end))?.[0] : undefined
    const codePoint = body.codePointAt(end)!, size = entity?.length ?? codePointBytes(codePoint)
    if (used + size > budget) break
    used += size; end += entity?.length ?? (codePoint > 0xffff ? 2 : 1)
  }
  if (end === body.length) return [body, '']
  const prefix = body.slice(0, end)
  const lf = prefix.lastIndexOf('\n')
  const space = prefix.lastIndexOf(' ')
  const cut = lf >= 0 ? lf + 1 : space >= 0 ? space + 1 : end
  if (cut === 0) throw new Error('No room for a tag body code point')
  return [body.slice(0, cut), body.slice(cut)]
}
/** Escape once, then split losslessly, accounting for the widest part index. */
export function buildTagParts(message: TagMessage, maxBytes: number = TAG_MAX_BYTES): string[] {
  const body = escapeBody(message.text ?? '')
  const singleAttrs = boundedAttrs(message, maxBytes)
  if (tagByteLength(render(singleAttrs, body)) <= maxBytes) return [render(singleAttrs, body)]
  let count = 2
  for (;;) {
    const widest = `${count}/${count}`
    const attrs = boundedAttrs(message, maxBytes, widest)
    const budget = maxBytes - tagByteLength(render(attrs, '', widest))
    const bodies: string[] = []
    let remaining = body
    do { const [part, rest] = cutBody(remaining, budget); bodies.push(part); remaining = rest } while (remaining !== '')
    if (bodies.length > count) { count = bodies.length; continue }
    return bodies.map((part, i) => render(attrs, part, `${i + 1}/${bodies.length}`))
  }
}
