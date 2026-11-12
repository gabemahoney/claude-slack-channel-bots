/**
 * Reaction preparation's server-log lines (SR-10.1): the class labels and the
 * two pure builders, pinned once here; and their same-change entries in the
 * debugging skill and the architecture Logging section (SR-10.2).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactionFungibleCondition, ReactionWithdrawalReason } from '../src/delivery-queue.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import {
  buildReactionMessageUnknownLine,
  buildReactionWithdrawnLine,
  REACTION_MESSAGE_UNKNOWN,
  REACTION_WITHDRAWN,
  type ReactionDiagnosticSubject,
} from '../src/reaction-preparation-diagnostics.ts'
import { REDACTED_TOKEN_PLACEHOLDER, REDACTED_URL_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL, sentinelInMessage, withoutName } from './test-helpers/credentials.ts'
import { classHeading, requiredSection } from './test-helpers/markdown.ts'

const SUBJECT: ReactionDiagnosticSubject = { key: 'ops_bot', name: 'Ops Bot', chat_id: 'C0GENERAL', message_ts: '1700000100.000100' }
const KEY_ONLY: ReactionDiagnosticSubject = { key: 'ops_bot', chat_id: 'C0GENERAL', message_ts: '1700000100.000100' }

describe('pins: the one place the class labels and line spelling are written out', () => {
  test('labels', () => {
    expect(REACTION_WITHDRAWN).toBe('reaction-withdrawn')
    expect(REACTION_MESSAGE_UNKNOWN).toBe('reaction-message-unknown')
  })

  test('lines', () => {
    const lines = [
      buildReactionWithdrawnLine(SUBJECT, 'fungible-refused', 'externally-shared'),
      buildReactionWithdrawnLine(KEY_ONLY, 'server-post'),
      buildReactionMessageUnknownLine(SUBJECT),
      buildReactionMessageUnknownLine(KEY_ONLY),
    ]
    expect(lines).toEqual([
      '[slack] reaction-withdrawn: persona="Ops Bot" (key=ops_bot) chat_id="C0GENERAL" message_ts="1700000100.000100" reason=fungible-refused failed_condition=externally-shared',
      '[slack] reaction-withdrawn: persona=ops_bot chat_id="C0GENERAL" message_ts="1700000100.000100" reason=server-post',
      '[slack] reaction-message-unknown: persona="Ops Bot" (key=ops_bot) chat_id="C0GENERAL" message_ts="1700000100.000100"',
      '[slack] reaction-message-unknown: persona=ops_bot chat_id="C0GENERAL" message_ts="1700000100.000100"',
    ])
    assertNoLeak(lines)
  })
})

const NAMED_REF = renderPersonaRef(SUBJECT.name!, SUBJECT.key)
const WHERE = `chat_id=${JSON.stringify(SUBJECT.chat_id)} message_ts=${JSON.stringify(SUBJECT.message_ts)}`

describe('builders', () => {
  const WITHDRAWALS: Array<[ReactionWithdrawalReason, ReactionFungibleCondition | undefined]> = [
    ['server-post', undefined],
    ['conversation-unknown', undefined],
    ['group-dm', undefined],
    ['fungible-refused', 'not-a-channel'],
    ['fungible-refused', 'externally-shared'],
    ['fungible-refused', 'not_in_channel'],
    ['fungible-refused', 'channel_not_found'],
  ]
  test.each(WITHDRAWALS.map(([reason, condition]) => [condition ? `${reason} ${condition}` : reason, reason, condition] as const))('withdrawal %s: the reason, and the condition only when given', (_label, reason, condition) => {
    const end = `reason=${reason}${condition === undefined ? '' : ` failed_condition=${condition}`}`
    const lines = [buildReactionWithdrawnLine(SUBJECT, reason, condition), buildReactionWithdrawnLine(KEY_ONLY, reason, condition)]
    expect(lines).toEqual([
      `[slack] ${REACTION_WITHDRAWN}: persona=${NAMED_REF} ${WHERE} ${end}`,
      `[slack] ${REACTION_WITHDRAWN}: persona=${KEY_ONLY.key} ${WHERE} ${end}`,
    ])
    assertNoLeak(lines)
  })

  test('message unknown: the named persona reference, or the key alone', () => {
    const lines = [buildReactionMessageUnknownLine(SUBJECT), buildReactionMessageUnknownLine(KEY_ONLY)]
    expect(lines).toEqual([
      `[slack] ${REACTION_MESSAGE_UNKNOWN}: persona=${NAMED_REF} ${WHERE}`,
      `[slack] ${REACTION_MESSAGE_UNKNOWN}: persona=${KEY_ONLY.key} ${WHERE}`,
    ])
    assertNoLeak(lines)
  })

  test('external fields stay on one line, with tokens and URLs redacted', () => {
    const hostile: ReactionDiagnosticSubject = {
      ...SUBJECT,
      chat_id: `C0GENERAL\r\n[slack] forged line ${fakeToken(BOT_TOKEN_PREFIX, 'chat')}`,
      message_ts: `1700000100.000100\nhttps://files.slack.com/files-pri/T0/F0/x?pub_secret=${LEAK_SENTINEL}`,
    }
    const lines = [buildReactionWithdrawnLine(hostile, 'group-dm'), buildReactionMessageUnknownLine(hostile)]
    for (const line of lines) {
      expect(line.split(/[\r\n]/)).toHaveLength(1)
      expect(line).toContain(` persona=${NAMED_REF} chat_id="C0GENERAL`)
      expect(line).toContain(REDACTED_TOKEN_PLACEHOLDER)
      expect(line).toContain(REDACTED_URL_PLACEHOLDER)
    }
    expect(lines.map(line => line.slice(0, line.indexOf(':')))).toEqual([`[slack] ${REACTION_WITHDRAWN}`, `[slack] ${REACTION_MESSAGE_UNKNOWN}`])
    expect(lines[0]!.endsWith(' reason=group-dm')).toBe(true)
    assertNoLeak(lines)
  })

  test('only the subject reaches a line: planted content, names, emoji and errors never do', () => {
    const MARKERS = ['body-marker', 'Reactor Display Marker', 'channel-name-marker', 'emoji-marker']
    const planted = {
      ...SUBJECT,
      text: `${MARKERS[0]} ${LEAK_SENTINEL}`,
      user: MARKERS[1],
      channel_name: MARKERS[2],
      emoji: MARKERS[3],
      blocks: [{ type: 'section', text: LEAK_SENTINEL }],
      error: new Error(sentinelInMessage('replies')),
      response: { ok: false, error: 'not_in_channel', token: fakeToken(BOT_TOKEN_PREFIX, 'response') },
    } as ReactionDiagnosticSubject
    const lines = [buildReactionWithdrawnLine(planted, 'fungible-refused', 'not_in_channel'), buildReactionMessageUnknownLine(planted)]
    expect(lines).toEqual([buildReactionWithdrawnLine(SUBJECT, 'fungible-refused', 'not_in_channel'), buildReactionMessageUnknownLine(SUBJECT)])
    for (const marker of MARKERS) expect(lines.join('\n')).not.toContain(marker)
    assertNoLeak(lines)
  })

  test('a token-shaped receiving persona name appears as configured and leaks nothing else', () => {
    const name = fakeToken(BOT_TOKEN_PREFIX, 'persona-name')
    const key = personaKey(name)
    const subject: ReactionDiagnosticSubject = { key, name, chat_id: 'C0GENERAL', message_ts: '1700000100.000100' }
    const lines = [buildReactionWithdrawnLine(subject, 'conversation-unknown'), buildReactionMessageUnknownLine(subject)]
    expect(lines).toEqual([
      `[slack] ${REACTION_WITHDRAWN}: persona=${renderPersonaRef(name, key)} ${WHERE} reason=conversation-unknown`,
      `[slack] ${REACTION_MESSAGE_UNKNOWN}: persona=${renderPersonaRef(name, key)} ${WHERE}`,
    ])
    for (const line of lines) expect(line).not.toContain(REDACTED_TOKEN_PLACEHOLDER)
    assertNoLeak(withoutName(lines, name, key))
  })

  test('a receiving persona name with quotes, control characters and a URL keeps its JSON-quoted configured form on one line', () => {
    const name = 'Ops "Night"\r\nDesk\t\\ https://ops.example.test/desk'
    const key = personaKey(name)
    const subject: ReactionDiagnosticSubject = { key, name, chat_id: 'C0GENERAL', message_ts: '1700000100.000100' }
    const lines = [buildReactionWithdrawnLine(subject, 'group-dm'), buildReactionMessageUnknownLine(subject)]
    expect(lines).toEqual([
      `[slack] ${REACTION_WITHDRAWN}: persona=${renderPersonaRef(name, key)} ${WHERE} reason=group-dm`,
      `[slack] ${REACTION_MESSAGE_UNKNOWN}: persona=${renderPersonaRef(name, key)} ${WHERE}`,
    ])
    for (const line of lines) {
      expect(line.split(/[\r\n]/)).toHaveLength(1)
      expect(line).not.toContain(REDACTED_URL_PLACEHOLDER)
    }
    assertNoLeak(lines)
  })
})

describe('catalogue entries in the same change (SR-10.2)', () => {
  const REPO_ROOT = resolve(import.meta.dir, '..')
  const SKILL_FILE = 'skills/debug-slack-channel-bots/SKILL.md'
  const ARCHITECTURE_FILE = 'docs/architecture.md'
  const read = (file: string) => readFileSync(resolve(REPO_ROOT, file), 'utf-8')

  test.each([REACTION_WITHDRAWN, REACTION_MESSAGE_UNKNOWN])('the debugging skill has a %s entry quoting its line', label => {
    expect(requiredSection(read(SKILL_FILE), classHeading(label), SKILL_FILE)).toContain(`[slack] ${label}:`)
  })

  test.each([REACTION_WITHDRAWN, REACTION_MESSAGE_UNKNOWN])('the architecture Logging section lists the %s line', label => {
    expect(requiredSection(read(ARCHITECTURE_FILE), '## Logging', ARCHITECTURE_FILE)).toContain(`\`[slack] ${label}:`)
  })
})
