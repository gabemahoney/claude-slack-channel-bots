/** Case 8 preparation only: observe the denied Agent settling before item six.
 * b.omv SR-14.2 case 8 / SR-14.6; never infer completion from elapsed time.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { jsonLines, packedReceiptAdapters, personaTranscripts, readTranscripts, receiptJournal, transcriptFiles, type TranscriptEntry } from '../integration/fixtures/transcript-receipts.ts'

const blocks = (entry: TranscriptEntry): any[] => Array.isArray(entry.value?.message?.content) ? entry.value.message.content : []
const ended = (entry: TranscriptEntry) => entry.value?.type === 'assistant'
  && ['end_turn', 'stop_sequence', 'refusal'].includes(entry.value.message?.stop_reason)
  && !blocks(entry).some(block => block.type === 'tool_use')
const requireEvidence = (value: unknown, reason: string): void => { if (!value) throw new Error(reason) }

export function denialSettled(key: string, action: any, slack: any[], own: TranscriptEntry[], all: TranscriptEntry[]) {
  const click = action?.interactive, button = click?.actions?.[0]
  const prefix = `perm_deny_cscb_${key}_`
  requireEvidence(button?.action_id?.startsWith(prefix), 'not this persona deny action')
  const token = button.action_id.slice(prefix.length)
  const post = slack.find(row => row.event === 'api' && row.method === 'chat.postMessage'
    && row.label === action.label && row.channel === click.channel.id && row.response_ts === click.message.ts
    && row.blocks?.some((block: any) => block.elements?.some((b: any) => b.action_id === button.action_id))
    && row.blocks?.some((block: any) => block.text?.text?.includes('`printf subagent-deny-probe`')))
  requireEvidence(post, 'denied probe relay identity missing')
  const pushed = slack.find(row => row.event === 'push' && row.event_type === 'block_actions'
    && row.label === action.label && Date.parse(row.ts) >= Date.parse(post.ts))
  requireEvidence(pushed, 'deny click not observed')
  const decision = slack.find(row => row.event === 'api' && row.method === 'chat.update'
    && row.label === action.label && row.channel === click.channel.id && row.response_ts === click.message.ts
    && row.text === '*Permission* — Denied by operator' && row.answer === 'ok' && row.status === 200
    && Date.parse(row.ts) >= Date.parse(pushed.ts))
  requireEvidence(decision, 'matching successful denial response not observed')

  for (const launch of own) for (const use of blocks(launch)) {
    if (use.type !== 'tool_use' || use.name !== 'Agent' || !use.input?.prompt?.includes('printf subagent-deny-probe')) continue
    const result = own.find(entry => entry.path === launch.path && entry.offset > launch.offset
      && entry.value?.type === 'user' && blocks(entry).some(block => block.type === 'tool_result' && block.tool_use_id === use.id && !block.is_error)
      && typeof entry.value.toolUseResult?.agentId === 'string')
    if (!result) continue
    const agent = result.value.toolUseResult.agentId, session = basename(launch.path, '.jsonl')
    const sidePath = join(dirname(launch.path), session, 'subagents', `agent-${agent}.jsonl`)
    const side = all.filter(entry => entry.path === sidePath && entry.value?.sessionId === session && entry.value?.agentId === agent && entry.value?.isSidechain === true)
    const probe = side.find(entry => blocks(entry).some(block => block.type === 'tool_use' && block.name === 'Bash' && block.input?.command === 'printf subagent-deny-probe'))
    if (!probe) continue
    const probeId = blocks(probe).find(block => block.type === 'tool_use' && block.name === 'Bash')?.id
    const denied = side.find(entry => entry.offset > probe.offset && entry.value?.type === 'user'
      && entry.value.toolDenialKind === 'permission-rule' && entry.at >= Date.parse(pushed.ts)
      && blocks(entry).some(block => block.type === 'tool_result' && block.tool_use_id === probeId && block.is_error === true))
    const complete = denied && side.find(entry => entry.offset > denied.offset && ended(entry))
    if (!complete) continue
    let mainAfter = result.offset
    if (result.value.toolUseResult.isAsync === true || result.value.toolUseResult.status === 'async_launched') {
      const notification = own.find(entry => entry.path === launch.path && entry.offset > result.offset && entry.value?.type === 'user'
        && typeof entry.value.message?.content === 'string' && entry.value.message.content.includes('<task-notification>')
        && entry.value.message.content.includes(`<task-id>${agent}</task-id>`)
        && entry.value.message.content.includes(`<tool-use-id>${use.id}</tool-use-id>`)
        && entry.value.message.content.includes('<status>completed</status>') && entry.at >= complete.at)
      if (!notification) continue
      mainAfter = notification.offset
    } else if (result.value.toolUseResult.status !== 'completed') continue
    const mainEnd = own.find(entry => entry.path === launch.path && entry.offset > mainAfter && entry.at >= complete.at && ended(entry))
    if (mainEnd) return { request_token: token, agent_id: agent, session_id: session, denial_at: decision.ts, subagent_completed_at: complete.at, main_completed_at: mainEnd.at }
  }
  throw new Error('matching denied subagent and main completion not observed')
}

if (import.meta.main) {
  try {
    if (!existsSync('/etc/cscb-ci-image')) throw new Error('Test101 observer requires the CI image')
    const [state, key, root, slack, action] = process.argv.slice(2)
    const log = readFileSync(join(state!, 'server.log'), 'utf8').split('\n')
    const all = readTranscripts(transcriptFiles(root!), await packedReceiptAdapters(), true)
    const own = personaTranscripts(key!, receiptJournal(state!, key!), log, all)
    console.log('recorded: denied subagent settled ' + JSON.stringify(denialSettled(key!, JSON.parse(readFileSync(action!, 'utf8')), jsonLines(slack!), own, all)))
  } catch (error) { console.error(error instanceof Error ? error.message : 'Test101 observation unavailable'); process.exitCode = 1 }
}
