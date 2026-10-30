/** Thread Memory's operator texts and reporting. Builders accept metadata only. */
import { THREAD_MEMORY_NOTICE_MAX_CHARS } from './delivery-constants.ts'
import { escapeSlackControlCharacters } from './slack-text-escape.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'
import { describeThrownValueWithoutStack } from './persona-connection-errors.ts'
import {
  buildThreadMemoryDiagnostic, THREAD_MEMORY_NOT_SAVED, THREAD_MEMORY_UNREADABLE,
  THREAD_MEMORY_JOINS_LOST, THREAD_MEMORY_CHANGED_WHILE_STOPPED, THREAD_MEMORY_RECOVERED,
  THREAD_MEMORY_QUARANTINED, THREAD_MEMORY_COMPACTION_FAILED, THREAD_MEMORY_REMOVAL_FAILED,
  THREAD_MEMORY_SEAL_UNREADABLE, THREAD_MEMORY_SEAL_NOT_SAVED, THREAD_MEMORY_HOLDS_NOT_RESOLVED,
} from './persona-diagnostics.ts'
import type { ThreadMemorySealCase, ThreadMemorySealFinding, ThreadMemorySealEvent } from './thread-memory-seal.ts'
import type { ThreadMemoryEvent, ThreadMemoryOutage } from './thread-memory.ts'
import type { ThreadMemoryRetryEvent } from './thread-memory-retry.ts'
import type { MemoryHoldEvent } from './memory-holds.ts'
import type { PersonaEpisodes, PersonaEpisodeKind } from './persona-episodes.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { formatPersonaNotice } from './persona-notifier.ts'

export { THREAD_MEMORY_DIAGNOSTIC_CLASSES, buildThreadMemoryDiagnostic } from './persona-diagnostics.ts'
export type { ThreadMemorySealCase } from './thread-memory-seal.ts'
export type ThreadMemoryChangedWording = ThreadMemorySealFinding['wording']
export interface ThreadMemoryLostThread { channel: string; root: string }
export interface ThreadMemoryWithdrawnMessage { channel: string; ts: string }
/** Additional loss sources can supply these same identifiers without passing a record. */
export interface ThreadMemoryLoss {
  threads: readonly ThreadMemoryLostThread[]
  messages: readonly ThreadMemoryWithdrawnMessage[]
  unreadableLines?: number
}
const safe = (text: string): string => redactSlackLogText(text).replace(/[\r\n\u2028\u2029]/g, ' ')
const slack = (text: string): string => escapeSlackControlCharacters(safe(text))
// Persona references are already JSON-quoted by renderPersonaRef. Paths are
// quoted here. Neither configured value is an untrusted error description.
const configuredSlack = (text: string): string => escapeSlackControlCharacters(text.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'))
const channelsText = (channels: readonly string[]): string => channels.length ? channels.map(slack).join(', ') : '(no current thread_hybrid channels)'
const channelIdentity = (channels: readonly string[]): string => `channels=${JSON.stringify(channels.map(safe))}`
const cause = (error: unknown): string => safe(describeThrownValueWithoutStack(error))
export const THREAD_MEMORY_SLACK_RETRY_WARNING = "If CSCB also can't save this bot's incoming messages, Slack retries each a limited number of times and can turn off the app's events. Check the app's Event Subscriptions page in Slack for disabled events; after storage works, send missing messages again."

export function buildThreadMemoryNotSavedNotice(persona: string, channels: readonly string[], path: string, step: string, error: unknown): string {
  return `:warning: *Thread Memory not saved* — ${configuredSlack(persona)}; channels: ${channelsText(channels)}. Could not save ${configuredSlack(JSON.stringify(path))} (${slack(step)}): ${slack(cause(error))}. Joins are kept and will be saved once storage works. Check the file's permissions and storage. ${THREAD_MEMORY_SLACK_RETRY_WARNING}`
}
export function buildThreadMemoryUnreadableNotice(persona: string, channels: readonly string[], path: string): string {
  return `:warning: *Thread Memory unreadable* — ${configuredSlack(persona)}; channels: ${channelsText(channels)}. Cannot read ${configuredSlack(JSON.stringify(path))}. Replies in this bot's threads are saved and wait until Thread Memory can be read. ${THREAD_MEMORY_SLACK_RETRY_WARNING} Fix the file's permissions or storage. To start this bot's Thread Memory empty, stop CSCB, move the journal aside and start CSCB again; a Thread Memory changed while stopped report follows, and Joins lost names waiting replies to send again.`
}
export interface ThreadMemoryLossNotice {
  text: string
  options: { personaRef: string }
}
const LOSS_PERSONA_NAME_EXCERPT_CHARS = 64
const lossPersonaRef = (persona: { name: string; key: string }): string =>
  renderPersonaRef(persona.name, persona.key).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
/** Budget the final escaped prefix and body together. The approved display
 * exception applies only after the complete notice with the full name fails. */
export function buildThreadMemoryJoinsLostNotice(persona: { name: string; key: string }, loss: ThreadMemoryLoss): ThreadMemoryLossNotice {
  const lines = [
    ...loss.threads.map(t => `Thread: ${slack(t.channel)} / ${slack(t.root)}.`),
    ...loss.messages.map(m => `Send again: ${slack(m.channel)} / ${slack(m.ts)}.`),
  ]
  const unreadable = loss.unreadableLines ?? 0
  const heading = (ref: string) => `:warning: *Joins lost* — ${ref} is no longer in the listed threads. A new @mention in a thread puts the bot back in it. Send each listed message again if it was meant for the bot.` +
    (unreadable ? ` ${unreadable} quarantined line(s) have no readable thread identity.` : '')
  const render = (ref: string): ThreadMemoryLossNotice => ({ text: [heading(ref), ...lines].join('\n'), options: { personaRef: ref } })
  const fits = (notice: ThreadMemoryLossNotice) => formatPersonaNotice(persona, notice.text, notice.options).length <= THREAD_MEMORY_NOTICE_MAX_CHARS
  let notice = render(escapeSlackControlCharacters(lossPersonaRef(persona)))
  if (fits(notice)) return notice
  // Slice characters before JSON quoting and Slack escaping, never encoded
  // entities or UTF-16 halves. The key and every fixed clause remain complete.
  const name = Array.from(persona.name).slice(0, LOSS_PERSONA_NAME_EXCERPT_CHARS).join('') + '…'
  notice = render(escapeSlackControlCharacters(lossPersonaRef({ ...persona, name })))
  if (fits(notice)) return notice
  let text = heading(notice.options.personaRef)
  let shown = 0
  for (const line of lines) {
    const rest = lines.length - shown - 1
    const tail = rest ? `\n${rest} more thread/message entry(s); see the server log for all identifiers.` : ''
    if (!fits({ text: text + `\n${line}` + tail, options: notice.options })) break
    text += `\n${line}`; shown++
  }
  if (shown < lines.length) text += `\n${lines.length - shown} more thread/message entry(s); see the server log for all identifiers.`
  return { text, options: notice.options }
}
export function buildThreadMemoryChangedWhileStoppedNotice(persona: string, channels: readonly string[], wording: ThreadMemoryChangedWording): string {
  const change = wording === 'unclean'
    ? "CSCB didn't shut down cleanly, so it can't tell whether Thread Memory changed."
    : 'Some Joined Threads may be missing, or may be ones the bot should have forgotten.'
  return `:warning: *Thread Memory changed while stopped* — ${configuredSlack(persona)}; channels: ${channelsText(channels)}. ${change} CSCB uses the Thread Memory it found. Check the threads the bot should be in; a new @mention puts it back in a thread.`
}
export function buildThreadMemoryRecoveredNotice(persona: string, channels: readonly string[]): string {
  return `:white_check_mark: *Thread Memory recovered* — ${configuredSlack(persona)}; channels: ${channelsText(channels)}. Thread Memory can be read and every kept join is saved.`
}

export function buildThreadMemoryNotSavedLine(key: string, channels: readonly string[], path: string, step: string, error: unknown): string {
  return buildThreadMemoryDiagnostic(THREAD_MEMORY_NOT_SAVED, key, `${channelIdentity(channels)} step=${safe(step)}`, `${cause(error)}; joins kept, saving retried; check permissions/storage. ${THREAD_MEMORY_SLACK_RETRY_WARNING}`, path)
}
export function buildThreadMemoryUnreadableLine(key: string, channels: readonly string[], path: string, error?: unknown, missing = false): string {
  return buildThreadMemoryDiagnostic(THREAD_MEMORY_UNREADABLE, key, channelIdentity(channels),
    missing ? 'journal missing on retry; Thread Memory stays unknown until the next start; waiting replies remain saved'
      : `${cause(error)}; replies saved and waiting; fix permissions/storage, or stop CSCB, move the journal aside and start again. ${THREAD_MEMORY_SLACK_RETRY_WARNING}`, path)
}
export function buildThreadMemoryJoinsLostLine(persona: { name: string; key: string }, loss: ThreadMemoryLoss): string {
  const threads = loss.threads.map(t => `channel=${safe(t.channel)} root=${safe(t.root)}`).join('; ')
  const messages = loss.messages.map(m => `channel=${safe(m.channel)} ts=${safe(m.ts)}`).join('; ')
  return buildThreadMemoryDiagnostic(THREAD_MEMORY_JOINS_LOST, persona.key,
    `threads=[${threads}] messages=[${messages}] unreadable_lines=${loss.unreadableLines ?? 0}`,
    'bot no longer in these threads; a new @mention puts it back; send each listed message again if meant for the bot') +
    ` bot=${lossPersonaRef(persona)}`
}
export function buildThreadMemoryChangedWhileStoppedLine(key: string, channels: readonly string[], finding: ThreadMemorySealCase, wording: ThreadMemoryChangedWording): string {
  return buildThreadMemoryDiagnostic(THREAD_MEMORY_CHANGED_WHILE_STOPPED, key, `${channelIdentity(channels)} case=${finding} wording=${wording}`,
    wording === 'unclean' ? "CSCB didn't shut down cleanly; cannot tell whether Thread Memory changed; check threads, a new @mention puts the bot back"
      : 'Joined Threads may be missing or ones the bot should have forgotten; check threads, a new @mention puts the bot back')
}
export function buildThreadMemoryRecoveredLine(key: string, channels: readonly string[]): string {
  return buildThreadMemoryDiagnostic(THREAD_MEMORY_RECOVERED, key, channelIdentity(channels), 'Thread Memory readable; every kept join saved')
}
export function buildThreadMemoryQuarantinedLine(key: string, path: string, count: number, invalidFinal: number): string {
  return buildThreadMemoryDiagnostic(THREAD_MEMORY_QUARANTINED, key, `lines=${count} invalid_final_lines=${invalidFinal}`, 'invalid lines quarantined; an invalid final line has no Joins lost report', path)
}
export function buildThreadMemoryCompactionFailedLine(key: string, path: string, step: string, error: unknown): string {
  return buildThreadMemoryDiagnostic(THREAD_MEMORY_COMPACTION_FAILED, key, `step=${safe(step)}`, `${cause(error)}; compaction not confirmed; journal retained, retried at maintenance`, path)
}
export function buildThreadMemoryRemovalFailedLine(key: string, path: string, step: string, error: unknown): string {
  return buildThreadMemoryDiagnostic(THREAD_MEMORY_REMOVAL_FAILED, key, `step=${safe(step)}`, `${cause(error)}; removal retried at next start`, path)
}
export function buildThreadMemorySealUnreadableLine(path: string, error: unknown): string {
  return buildThreadMemoryDiagnostic(THREAD_MEMORY_SEAL_UNREADABLE, 'all', '', `${cause(error)}; seal treated as having no entries`, path)
}
export function buildThreadMemorySealNotSavedLine(path: string, error: unknown, unsynced: boolean): string {
  return buildThreadMemoryDiagnostic(THREAD_MEMORY_SEAL_NOT_SAVED, 'all', `written_but_not_synced=${unsynced}`, `${cause(error)}; seal write retried`, path)
}
export function buildThreadMemoryHoldsNotResolvedLine(key: string, error: unknown): string {
  return buildThreadMemoryDiagnostic(THREAD_MEMORY_HOLDS_NOT_RESOLVED, key, 'step=resolution-append', `${cause(error)}; Memory Hold resolution not saved, retried`)
}

export interface ThreadMemoryReportingDeps {
  episodes: PersonaEpisodes
  log(line: string): void
  persona(key: string): { name: string; key: string } | undefined
  threadHybridChannels(key: string): readonly string[]
  outage(key: string): ThreadMemoryOutage
}
/** Synchronous observers: neither a sink nor a logger can interrupt a store. */
export function createThreadMemoryReporting(deps: ThreadMemoryReportingDeps) {
  let lossNumber = 0
  const protect = (work: () => unknown): void => {
    try { void Promise.resolve(work()).catch(() => {}) } catch { /* reporting cannot affect durable outcomes */ }
  }
  const active = (key: string) => !deps.episodes.isClosed() && deps.episodes.teardownWindowState(key) === 'none'
  const ref = (key: string): string => {
    const persona = deps.persona(key)
    return persona ? renderPersonaRef(persona.name, key) : `persona=${key}`
  }
  const log = (line: string) => protect(() => deps.log(line))
  function post(key: string, kind: PersonaEpisodeKind, text: string, line: string, mark?: string): void {
    if (deps.episodes.post(key, kind, text, mark)) log(line)
  }
  function recover(key: string, outage = deps.outage(key)): void {
    if (outage.unknown || outage.unsaved || outage.missing) return
    const open = ([THREAD_MEMORY_NOT_SAVED, THREAD_MEMORY_UNREADABLE] as const).filter(kind => deps.episodes.isOpen(key, kind))
    const last = open.pop()
    for (const kind of open) deps.episodes.end(key, kind)
    if (!last) return
    const channels = deps.threadHybridChannels(key)
    post(key, last, buildThreadMemoryRecoveredNotice(ref(key), channels), buildThreadMemoryRecoveredLine(key, channels), 'recovered')
    deps.episodes.end(key, last)
    deps.episodes.resetCount(key, THREAD_MEMORY_UNREADABLE)
  }
  function loss(key: string, facts: ThreadMemoryLoss): void {
    if (deps.episodes.begin(key, THREAD_MEMORY_JOINS_LOST, `loss-${++lossNumber}`) === 'closed') return
    try {
      const persona = deps.persona(key) ?? { name: key, key }
      const notice = buildThreadMemoryJoinsLostNotice(persona, facts)
      if (deps.episodes.post(key, THREAD_MEMORY_JOINS_LOST, notice.text, undefined, notice.options)) log(buildThreadMemoryJoinsLostLine(persona, facts))
    }
    finally { deps.episodes.end(key, THREAD_MEMORY_JOINS_LOST) }
  }
  function changed(finding: ThreadMemorySealFinding): void {
    const { key } = finding
    if (!active(key) || deps.episodes.begin(key, THREAD_MEMORY_CHANGED_WHILE_STOPPED) === 'closed') return
    const channels = deps.threadHybridChannels(key)
    post(key, THREAD_MEMORY_CHANGED_WHILE_STOPPED,
      buildThreadMemoryChangedWhileStoppedNotice(ref(key), channels, finding.wording),
      buildThreadMemoryChangedWhileStoppedLine(key, channels, finding.case, finding.wording))
  }
  function threadMemoryEvent(event: ThreadMemoryEvent, outage?: ThreadMemoryOutage): void {
    const { key } = event
    if (!active(key)) return
    switch (event.type) {
      case 'append-failed': case 'creation-failed': {
        if (deps.episodes.begin(key, THREAD_MEMORY_NOT_SAVED) === 'closed') return
        const channels = deps.threadHybridChannels(key)
        post(key, THREAD_MEMORY_NOT_SAVED, buildThreadMemoryNotSavedNotice(ref(key), channels, event.path, event.step, event.error),
          buildThreadMemoryNotSavedLine(key, channels, event.path, event.step, event.error))
        return
      }
      case 'read-failed': {
        if (deps.episodes.begin(key, THREAD_MEMORY_UNREADABLE) === 'closed') return
        const channels = deps.threadHybridChannels(key)
        post(key, THREAD_MEMORY_UNREADABLE, buildThreadMemoryUnreadableNotice(ref(key), channels, event.path),
          buildThreadMemoryUnreadableLine(key, channels, event.path, event.error))
        return
      }
      case 'read': case 'saved-after-failure': case 'outage-settled': recover(key, outage); return
      case 'lines-quarantined': {
        log(buildThreadMemoryQuarantinedLine(key, event.quarantinePath, event.facts.length, event.facts.filter(f => f.invalidFinalLine).length))
        const lost = event.facts.filter(f => !f.invalidFinalLine)
        if (!lost.length) return
        loss(key, {
          threads: lost.flatMap(f => f.channel && f.root ? [{ channel: f.channel, root: f.root }] : []), messages: [],
          unreadableLines: lost.filter(f => !f.channel || !f.root).length,
        })
        return
      }
      case 'compaction-failed': log(buildThreadMemoryCompactionFailedLine(key, event.path, event.step, event.error)); return
      case 'removal-failed': log(buildThreadMemoryRemovalFailedLine(key, event.path, event.step, event.error)); return
      case 'created': case 'removed': return
    }
  }
  function retryEvent(event: ThreadMemoryRetryEvent, outage?: ThreadMemoryOutage): void {
    if (!('key' in event) || !active(event.key)) return
    const key = event.key
    if (event.type === 'saved-after-retries' || event.type === 'read-after-retries') { recover(key, outage); return }
    if (event.type === 'journal-missing-on-retry') {
      // The central episode's counter claims the one log-only missing line;
      // recovery/forget clear it without posting an empty notice.
      if (deps.episodes.begin(key, THREAD_MEMORY_UNREADABLE) === 'closed') return
      if (deps.episodes.addCount(key, THREAD_MEMORY_UNREADABLE) === 1) {
        log(buildThreadMemoryUnreadableLine(key, deps.threadHybridChannels(key), '', undefined, true))
      }
    }
  }
  function sealEvent(event: ThreadMemorySealEvent): void {
    if (deps.episodes.isClosed()) return
    switch (event.type) {
      case 'changed-while-stopped': changed(event); return
      case 'seal-read-failed': case 'seal-invalid': log(buildThreadMemorySealUnreadableLine(event.path, event.error)); return
      case 'seal-write-failed': log(buildThreadMemorySealNotSavedLine(event.path, event.error, event.unsynced)); return
      default: return
    }
  }
  function holdsEvent(event: MemoryHoldEvent): void {
    if (!active(event.key)) return
    if (event.type === 'resolution-failed') { log(buildThreadMemoryHoldsNotResolvedLine(event.key, event.error)); return }
    if (event.type === 'withdrawn' && event.holds.length) loss(event.key, {
      threads: event.holds.map(h => ({ channel: h.channel, root: h.thread_ts })),
      messages: event.holds.map(h => ({ channel: h.channel, ts: h.ts })),
    })
  }
  return {
    // Buffered startup callers supply the readiness observed with the event;
    // live callers may omit it and read the current state synchronously.
    threadMemoryEvent: (event: ThreadMemoryEvent, outage?: ThreadMemoryOutage): void => protect(() => threadMemoryEvent(event, outage)),
    retryEvent: (event: ThreadMemoryRetryEvent, outage?: ThreadMemoryOutage): void => protect(() => retryEvent(event, outage)),
    sealEvent: (event: ThreadMemorySealEvent): void => protect(() => sealEvent(event)),
    holdsEvent: (event: MemoryHoldEvent): void => protect(() => holdsEvent(event)),
    startupFindings: (findings: readonly ThreadMemorySealFinding[]): void => {
      for (const finding of findings) protect(() => changed(finding))
    },
  }
}
