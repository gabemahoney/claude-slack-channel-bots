/** Offline evidence checks for D1. Synthetic controls are never native provenance.
 * Raw rollout objects and the Codex home must remain inside the container. */
export interface CodexRecord {
  offset: number; end: number; at?: number; type: string; kind: string
  session?: string; turn?: string; model?: string; role?: string; text?: string
  tool?: string; failed?: boolean
  usage?: { input: number; output: number; cache_read: number; cache_creation: number }
}
export interface CodexRollout { session: string; size: number; incomplete: boolean; records: CodexRecord[] }
const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined
const safeId = (v: unknown): string | undefined => typeof v === 'string' && /^[A-Za-z0-9._:/-]+$/.test(v) ? v : undefined

/** Allowlist metadata; never project config, headers, auth, cwd or raw objects. */
export function projectCodexRollout(bytes: Buffer, session: string): CodexRollout {
  if (!safeId(session)) throw new Error('invalid rollout session')
  const records: CodexRecord[] = []
  let offset = 0, owner: string | undefined, incomplete = false
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset)
    if (newline < 0) { incomplete = true; break }
    const end = newline + 1
    let value: any
    try { value = JSON.parse(bytes.subarray(offset, newline).toString('utf8')) } catch { throw new Error('damaged rollout record') }
    const p = object(value.payload), type = typeof value.type === 'string' ? value.type : 'unknown'
    if (type === 'session_meta') {
      const id = safeId(p?.id)
      if (!id || id !== session || owner !== undefined) throw new Error('rollout session ownership mismatch')
      owner = id
    }
    if (owner === undefined) throw new Error('rollout has no session ownership')
    const at = typeof value.timestamp === 'number' ? value.timestamp : Date.parse(value.timestamp ?? '')
    const r: CodexRecord = { offset, end, type, kind: safeId(p?.type) ?? type }
    if (Number.isFinite(at)) r.at = at
    const turn = safeId(p?.turn_id)
    if (turn) r.turn = turn
    if (type === 'session_meta') r.session = owner
    if (type === 'turn_context') r.model = safeId(p?.model)
    if (/refusal|classifier|fallback|error|abort/i.test(r.kind)) r.failed = true
    if (type === 'response_item' && /(?:_call|tool_use)$/.test(r.kind)) r.tool = safeId(p?.name) ?? r.kind
    if (Array.isArray(p?.content) && p.content.some((b: any) => /^(?:tool_use|server_tool_use)$/.test(b?.type ?? ''))) r.tool = 'tool_use'
    if (Array.isArray(p?.content) && p.content.some((b: any) => b?.type === 'refusal')) r.failed = true
    if (type === 'response_item' && p?.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      r.role = p.role
      const blockType = p.role === 'user' ? 'input_text' : 'output_text'
      if (Array.isArray(p.content) && p.content.length && p.content.every((b: any) => b?.type === blockType && typeof b.text === 'string')) r.text = p.content.map((b: any) => b.text).join('')
    }
    if (type === 'event_msg' && p?.type === 'token_count') {
      const u = object(p.info?.total_token_usage)
      if (u && ['input_tokens', 'output_tokens', 'cached_input_tokens'].every(k => Number.isSafeInteger(u[k]) && u[k] >= 0)) {
        r.usage = { input: u.input_tokens, output: u.output_tokens, cache_read: u.cached_input_tokens, cache_creation: 0 }
      }
    }
    records.push(r); offset = end
  }
  if (owner !== session) throw new Error('rollout has no session ownership')
  return { session, size: bytes.length, incomplete, records }
}

export interface CodexWindow { session: string; offset: number; sentAt: number; text: string; model: string }

/** Independently require own post-send take-in, pinned turn context, assistant
 * output and native turn completion. A receipt alone is never a completed turn. */
export function completedCodexTurn(rollout: CodexRollout, window: CodexWindow) {
  if (rollout.session !== window.session || rollout.incomplete || !Number.isSafeInteger(window.offset) || window.offset < 0 || window.offset > rollout.size || !Number.isFinite(window.sentAt)) throw new Error('invalid completion evidence window')
  const after = rollout.records.filter(r => r.offset >= window.offset)
  const receiptIndex = after.findIndex(r => r.type === 'response_item' && r.role === 'user' && r.text === window.text && r.at !== undefined && r.at >= window.sentAt)
  if (receiptIndex < 0) throw new Error('no exact post-send user take-in')
  const receipt = after[receiptIndex]!
  const previousStart = after.slice(0, receiptIndex).map(r => r.type === 'event_msg' && r.kind === 'task_started').lastIndexOf(true)
  const nextReceipt = after.findIndex((r, i) => i > receiptIndex && r.type === 'response_item' && r.role === 'user')
  const nextStart = after.findIndex((r, i) => i > receiptIndex && r.type === 'event_msg' && r.kind === 'task_started')
  const end = Math.min(...[nextReceipt, nextStart, after.length].filter(i => i >= 0))
  const turn = after.slice(previousStart >= 0 ? previousStart : 0, end)
  const starts = turn.filter(r => r.type === 'event_msg' && r.kind === 'task_started')
  if (starts.length !== 1 || !starts[0]!.turn || starts[0]!.at === undefined || starts[0]!.at! < window.sentAt) throw new Error('native turn start identity missing')
  const contexts = turn.filter(r => r.type === 'turn_context')
  if (!contexts.length || contexts.some(r => r.model !== window.model || r.at === undefined || r.at < window.sentAt)) throw new Error('missing or mismatched rollout model')
  const assistant = turn.filter(r => r.offset > receipt.offset && r.type === 'response_item' && r.role === 'assistant' && r.text !== undefined)
  if (!assistant.length || assistant.some(r => r.at === undefined || r.at < window.sentAt)) throw new Error('no current native assistant output')
  const completion = turn.find(r => r.type === 'event_msg' && r.kind === 'task_complete' && r.offset > assistant.at(-1)!.offset && r.at !== undefined && r.at >= assistant.at(-1)!.at!)
  if (!completion || completion.at! > window.sentAt + 180000) throw new Error('native turn incomplete within bound')
  const ids = [...starts, ...contexts, ...assistant, completion].flatMap(r => r.turn ? [r.turn] : [])
  if (!completion.turn || new Set(ids).size !== 1) throw new Error('native turn identity mismatch')
  if (turn.some(r => r.failed || r.type === 'event_msg' && ['error', 'turn_aborted'].includes(r.kind))) throw new Error('native turn failed')
  return { receipt, completion, send: { session: window.session, at: window.sentAt, offset: window.offset }, model: window.model, answer: assistant.map(r => r.text).join(''),
    tokens: turn.filter(r => r.usage && r.offset > receipt.offset && r.offset <= completion.offset).at(-1)?.usage }
}

export function safeCodexEvents(rollout: CodexRollout) {
  return rollout.records.map(({ offset, end, at, type, kind, session, turn, model, role, usage }) => ({ offset, end, at, type, kind, session, turn, model, role, usage }))
}
