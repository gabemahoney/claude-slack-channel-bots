/** Private, import-safe D1 AI inputs and answer oracles. Nothing in this module
 * is written into a native bot's working directory. Synthetic controls do not
 * constitute a real-agent verdict. */
import { auditedAICorpus } from './ai-fixture-audit.ts'
import { completedCodexTurn, type CodexRollout, type CodexWindow } from './codex-evidence.ts'

export function requireEvidence(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason)
}

/** AC15 alone waits for the submitted part's completed native answer before
 * the production engine may send its successor. Other scenarios retain the
 * ordinary working-row delivery policy. No expected answer reaches the bot. */
export function codexMultipartSender<P extends { text?: string; no_enter?: boolean; key?: string }, R>(
  send: (params: P) => Promise<R>, completed: (text: string) => Promise<unknown>,
) {
  let pending: string | undefined, completing = false
  return async (params: P): Promise<R> => {
    requireEvidence(!completing, 'AC15 successor preceded completed acknowledgement')
    if (params.text !== undefined) requireEvidence(pending === undefined, 'AC15 replaced an unacknowledged part')
    const result = await send(params)
    if (params.text !== undefined && params.no_enter) pending = params.text
    else if (params.key === 'Enter' && pending !== undefined) {
      completing = true
      try { await completed(pending); pending = undefined }
      finally { completing = false }
    }
    return result
  }
}
const stable = (v: any): string => JSON.stringify(v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(stable(v[k]))]))
  : Array.isArray(v) ? v.map(x => JSON.parse(stable(x))) : v)

export function tagReadback(typed: string, label: string) {
  const match = /^<channel ((?:[a-z_]+="[^"]*" ?)+)>([\s\S]*)<\/channel>$/.exec(typed)
  requireEvidence(match, 'invalid independent reference tag')
  const decode = (s: string) => s.replace(/&(amp|quot|lt|gt);/g, (_, name: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>' })[name]!)
  return { case: label, attributes: Object.fromEntries([...match[1]!.matchAll(/([a-z_]+)="([^"]*)"/g)].map(m => [m[1], decode(m[2]!)])), body: match[2] }
}

export function codexAICases(ac: number) {
  requireEvidence([11, 12, 20].includes(ac), 'unsupported corpus criterion')
  const corpus = structuredClone(auditedAICorpus().ai) as any[]
  let rows = ac === 11 ? corpus : corpus.filter(row => (ac === 12
    ? ['hz_bang', 'hz_slash', 'hz_question', 'hz_tab', 'hz_backslash']
    : ['ex3_peer_bot_spoof', 'hz_attr_quotes']).includes(row.name))
  if (ac === 12) {
    const question = structuredClone(rows.find(row => row.name === 'hz_question'))
    question.name = 'hz_question_prefix'
    question.msg.text = '? ordinary question'
    question.msg.ts = question.msg.message_id = '1792000000.001401'
    question.typed = question.typed.replaceAll('1792000000.001400', question.msg.ts).replace('>?</channel>', '>? ordinary question</channel>')
    question.typed_len = question.typed.length
    rows.push(question)
  }
  if (ac === 20) {
    const row = rows[0]!
    const originalSender = `user="${row.msg.user}" bot_id="${row.msg.bot_id}"`
    row.msg.user_id = 'U0REAL20'; row.msg.user = 'E6 Real Sender'; delete row.msg.bot_id
    row.typed = row.typed.replace(originalSender, 'user="E6 Real Sender" user_id="U0REAL20"')
    row.typed_len = row.typed.length
  }
  return rows.map((row, i) => ({ ...row, label: `case_${String(i + 1).padStart(2, '0')}`,
    expected: tagReadback(row.typed, `case_${String(i + 1).padStart(2, '0')}`) }))
}

/** Exactly decision 20's E6 generator: fixed seed, vocabulary, punctuation
 * and natural spaces at 1700/3400/5000. No expected body in model files. */
export function codexAC15Body() {
  let state = 20261017
  const words = 'amber birch cedar dawn elm fern grove harbor iris jade kelp lake maple nest oak pine quartz reed shore thyme umber vale willow yarrow zephyr acorn brook coral dune ember field garden hazel island juniper kite linen meadow nutmeg olive pebble robin sage tulip violet walnut azure blossom clover drift feather ginger honey ivory jasmine lilac moss orchard petal ripple sorrel'.split(' ')
  const separators = [' ', ' ', ' ', ', ', '. ', '; ', ': ', ' - ', '! ', '? ']
  const pick = (values: string[]) => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return values[(state >>> 16) % values.length]! }
  let body = ''
  for (const width of [1700, 1700, 1600]) {
    let span = ''
    while (span.length < width) {
      let token = pick(words) + pick(separators)
      const remaining = width - span.length
      if (token.length > remaining || remaining - token.length === 1) token = remaining % 2 === 0 ? 'a ' : 'ox '
      span += token
    }
    body += span
  }
  requireEvidence(Buffer.byteLength(body) === 5000, 'AC15 body recipe drift')
  return body
}

export function codexAC15Message() {
  // Preserve E6's actual DM metadata width, hence its reviewed part boundaries.
  const ts = '1792000100.000100'
  return { chat_id: 'D0AIAC15', channel_name: 'dm', message_id: ts, user: 'stub-u0aiac15', user_id: 'U0AIAC15', ts, via: 'dm', text: codexAC15Body() }
}

export function codexSlackInput(msg: any) {
  return { source: 'slack', text: msg.text, key: { chat_id: msg.chat_id, ts: msg.ts }, channel: msg.chat_id,
    channel_type: msg.chat_id.startsWith('D') ? 'im' : 'channel', ts: msg.ts, via: msg.via,
    user: msg.user_id, bot_id: msg.bot_id, username: msg.user, thread_ts: msg.thread_ts,
    files: msg.attachment_count ? [{ name: 'build-log.txt', mimetype: 'text/plain', size: 18342 }] : undefined }
}

export function assertCodexNoShell(rollout: CodexRollout) {
  // rust-v0.159.2 core/src/user_shell_command.rs and its formats_basic_record
  // test: native ! commands are ordinary user Message/InputText records with
  // this contextual-fragment wrapper, not only an event with a special kind.
  requireEvidence(!rollout.records.some(r => /user_shell_command|user_shell|bash-input/.test(r.kind)
    || r.role === 'user' && r.text?.trimStart().startsWith('<user_shell_command>')), 'native user shell mode observed')
}

export function assertCodexAnswer(rollout: CodexRollout, window: CodexWindow, expected: unknown, options: { noTools?: boolean } = {}) {
  const complete = completedCodexTurn(rollout, window)
  // Check the entire observed exchange, including late stops/tool actions and
  // duplicate copies, rather than accepting an earlier matching JSON alone.
  const exchange = rollout.records.filter(r => r.offset >= window.offset)
  requireEvidence(!exchange.some(r => r.failed || r.model !== undefined && r.model !== window.model), 'AI exchange stopped or changed model')
  if (options.noTools) requireEvidence(!exchange.some(r => r.tool), 'AI exchange performed a tool action')
  assertCodexNoShell(rollout)
  let answer: unknown
  try { answer = JSON.parse(complete.answer) } catch { throw new Error('native answer is not one complete JSON value') }
  requireEvidence(stable(answer) === stable(expected), 'native JSON read-back differs')
  requireEvidence(complete.tokens && complete.tokens.input > 0 && complete.tokens.output > 0, 'native positive usage missing')
  return complete
}

export function assertCodexMultipart(parts: string[], body: string, completions: { answer: string; receipt: { offset: number }; completion: { offset: number } }[]) {
  requireEvidence(parts.length === 3 && completions.length === 3, 'AC15 requires exactly three parts and completed acknowledgements')
  const bodies = parts.map((part, i) => {
    requireEvidence(Buffer.byteLength(part) <= 1900, 'AC15 part exceeds byte limit')
    const tag = tagReadback(part, 'AC15')
    requireEvidence(tag.attributes.part === `${i + 1}/3`, 'AC15 part identity/order differs')
    if (i < 2) {
      let ack: any
      try { ack = JSON.parse(completions[i]!.answer) } catch { throw new Error('AC15 nonfinal acknowledgement missing') }
      requireEvidence(stable(ack) === stable({ status: 'received' }), 'AC15 nonfinal acknowledgement differs')
      requireEvidence(completions[i]!.completion.offset < completions[i + 1]!.receipt.offset, 'AC15 acknowledgement did not precede next part')
    }
    return tag.body
  })
  requireEvidence(JSON.stringify(bodies.map(s => Buffer.byteLength(s))) === '[1700,1700,1600]', 'AC15 reviewed part boundaries differ')
  requireEvidence(bodies.join('') === body && Buffer.byteLength(body) === 5000, 'AC15 reassembly differs')
}

export function assertCodexDuplicateTakeins(rollout: CodexRollout, first: CodexWindow, second: CodexWindow) {
  requireEvidence(first.session === second.session && first.text === second.text && second.offset > first.offset && second.sentAt > first.sentAt, 'duplicate lacks two independent send windows')
  const a = completedCodexTurn(rollout, first), b = completedCodexTurn(rollout, second)
  requireEvidence(a.receipt.offset < second.offset && a.completion.offset < b.receipt.offset && a.receipt.offset !== b.receipt.offset,
    'two actual identical DM take-ins not established')
  return [a, b]
}
