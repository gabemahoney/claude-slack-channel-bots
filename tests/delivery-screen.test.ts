/** b.omv SR-5.3/5.4: the adapter reads the bottom composer, never history. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { readDeliveryScreen } from '../src/delivery-screen.ts'
import * as panes from './test-helpers/working-row-panes.ts'

describe('Claude screen contract', () => {
  test.each([
    ['idle', panes.IDLE_PANE, false], ['other idle', panes.OTHER_IDLE_PANE, false],
    ['Linux', panes.LINUX_IDLE_PANE, false], ['spinner', panes.SPINNER_PANE, true],
    ['custom spinner', panes.CUSTOM_VERB_SPINNER_PANE, true],
    ['quoted dialog', panes.QUOTED_DIALOG_PANE, false], ['quoted menu', panes.QUOTED_MENU_PANE, false],
  ] as const)('%s has an empty composer with its expected running state', (_name, pane, running) => {
    expect(readDeliveryScreen('claude', pane)).toEqual({ kind: 'empty', running })
  })
  test.each([
    ['permission', panes.PERMISSION_PANE], ['plan', panes.PLAN_APPROVAL_PANE],
    ['selection', panes.SELECT_MENU_PANE], ['model', panes.MODEL_PICKER_PANE],
    ['trust', panes.TRUST_DIALOG_PANE], ['channels', panes.DEV_CHANNELS_DIALOG_PANE],
    ['MCP', panes.MCP_SERVER_DIALOG_PANE], ['no composer', 'A reply only'],
  ])('%s is a menu', (_name, pane) => expect(readDeliveryScreen('claude', pane)).toEqual({ kind: 'menu', running: false }))
  test.each(['>', '❯'] as const)('marker %s supports placeholders, ANSI, drafts and multiline own text', marker => {
    for (const text of ['', '   ', 'Try "fix the build"', 'Press up to edit queued messages', 'Message @helper…']) {
      expect(readDeliveryScreen('claude', `\x1b[32m${panes.deliveryPane(text, { marker })}\x1b[0m`)).toEqual({ kind: 'empty', running: false })
    }
    const own = '<channel>one\ntwo</channel>'
    expect(readDeliveryScreen('claude', panes.deliveryPane(own, { marker }), own)).toEqual({ kind: 'own', text: own, running: false })
    expect(readDeliveryScreen('claude', panes.deliveryPane('a human draft', { marker }), own)).toEqual({ kind: 'input', text: 'a human draft', running: false })
    expect(readDeliveryScreen('claude', panes.deliveryPane('[Pasted text #1 +3 lines]', { marker }), own).kind).toBe('own')
  })
  test.each(['Esc to cancel', 'ENTER TO SELECT', 'Enter to confirm', 'arrows to navigate'])('footer %s blocks, history does not', footer => {
    expect(readDeliveryScreen('claude', panes.deliveryPane('', { footer })).kind).toBe('menu')
    expect(readDeliveryScreen('claude', panes.deliveryPane('', { history: `${footer}\n❯ old draft\n` }))).toEqual({ kind: 'empty', running: false })
  })
  test('earlier matching text cannot make an unrelated current draft ours', () => {
    expect(readDeliveryScreen('claude', panes.deliveryPane('human', { history: '❯ <channel>mine</channel>\n' }), '<channel>mine</channel>').kind).toBe('input')
    expect(readDeliveryScreen('claude', panes.withLastLine('A dialog after the box')).kind).toBe('menu')
  })
})

describe('Codex known composer contract (popup research belongs to E7)', () => {
  test.each(['', 'Ask Codex to do anything', 'Ask a follow-up question'])('empty placeholder %p with arbitrary configured footer', text => {
    expect(readDeliveryScreen('codex', panes.deliveryPane(text, { agent: 'codex', footer: 'custom worktree status', history: '› old draft\n' }))).toEqual({ kind: 'empty', running: false })
  })
  test.each(['human', 'first\nsecond', '\nsecond'])('draft %p is input', text => {
    expect(readDeliveryScreen('codex', panes.deliveryPane(text, { agent: 'codex' })).kind).toBe('input')
  })
  test('own prefix, running, disabled input and menu footers', () => {
    const text = '<channel>mine\nbody</channel>'
    expect(readDeliveryScreen('codex', panes.deliveryPane(text, { agent: 'codex', running: true }), text)).toEqual({ kind: 'own', text, running: true })
    for (const text of ['Viewing sub-agent — direct input is disabled', 'Enter to select']) {
      expect(readDeliveryScreen('codex', panes.deliveryPane(text, { agent: 'codex' })).kind).toBe('menu')
    }
    expect(readDeliveryScreen('codex', 'No composer')).toEqual({ kind: 'menu', running: false })
  })
})

// b.omv SR-14.2 case 10: native 2.1.280/296 panes captured in E6.
describe('observed native Claude composer forms', () => {
  test.each([
    '⏸ manual mode on · ? for shortcuts · ← for agents         ◐ medium · /effort',
    '⏸ manual mode on                                          ◐ medium · /effort',
  ])('NBSP prompt and manual footer %p are idle', footer => {
    expect(readDeliveryScreen('claude', `────────────────
❯\u00a0
────────────────
  ${footer}
`)).toEqual({ kind: 'empty', running: false })
  })
  test.each(['[Pasted text #1]', '[Pasted text #2 +59 lines]'])('long/taller-than-read marker %p belongs only to an in-flight item', marker => {
    const pane = `────────────────
❯\u00a0${marker}
────────────────
  paste again to expand
`
    expect(readDeliveryScreen('claude', pane, '<channel>known item</channel>')).toEqual({ kind: 'own', text: marker, running: false })
    expect(readDeliveryScreen('claude', pane).kind).toBe('input')
  })
  test('soft wraps at words and columns recognize the complete item, rejecting an unrelated draft', () => {
    const own = '<channel source="slack-channel-router" chat_id="D1">longword tail</channel>'
    const shown = '<channel source="slack-channel-router"\nchat_id="D1">longwo\nrd tail</channel>'
    const pane = (text: string) => `────────────────
❯\u00a0${text.replaceAll('\n', '\n  ')}
────────────────
  ⏸ manual mode on
`
    expect(readDeliveryScreen('claude', pane(shown), own).kind).toBe('own')
    expect(readDeliveryScreen('claude', pane(shown.replace('tail', 'human draft')), own).kind).toBe('input')
    expect(readDeliveryScreen('claude', pane(shown.replace('</channel>', '</wrong>')), own).kind).toBe('input')
  })
})

// Verbatim safe read-pane capture from Test 39, full CI 20261016t203545z-4p0a3mof.
// Keep the native header/history, 80-column rules, NBSP and l> residue together.
const observedSeparatorPane = readFileSync(new URL('./fixtures/claude-observed-separator-pane.txt', import.meta.url), 'utf8')

describe('observed native empty frame after an emoji turn', () => {
  test.each([
    ['verbatim capture', observedSeparatorPane],
    ['ANSI and trailing blank pane padding', `\x1b[32m${observedSeparatorPane}\x1b[0m\n   \n\n`],
  ])('%s is an empty composer', (_name, pane) => {
    expect(readDeliveryScreen('claude', pane)).toEqual({ kind: 'empty', running: false })
  })
  test('the frame does not hide a running turn above it', () => {
    expect(readDeliveryScreen('claude', observedSeparatorPane.replace('✻ Baked for 4s · done 8:42 PM', '✻ Thinking… (2s · ↓ 100 tokens)'))).toEqual({ kind: 'empty', running: true })
  })
  test.each([
    ['human draft', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a0a human draft\n')],
    ['known in-flight text', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a0<channel>mine</channel>\n')],
    ['literal residue in the composer', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a0l>draft\n')],
    ['numbered selection', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a01. Yes\n')],
    ['multiline draft', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a0\n  a human draft\n')],
    ['extra empty composer row', observedSeparatorPane.replace('❯\u00a0\n', '❯\u00a0\n\n')],
    ['different upper width', observedSeparatorPane.replace('─'.repeat(80) + '\n', '─'.repeat(79) + '\n')],
    ['missing upper rule', observedSeparatorPane.replace('─'.repeat(80) + '\n', '')],
    ['unknown residue', observedSeparatorPane.replace('l>─', 'x>─')],
    ['missing footer', observedSeparatorPane.slice(0, observedSeparatorPane.lastIndexOf('  ⏸'))],
    ['unknown footer', observedSeparatorPane.replace('⏸ manual mode on · ? for shortcuts · ← for agents', '⏸ manual mode on · unknown status')],
    ['menu overlay', `${observedSeparatorPane}Enter to select · Esc to cancel\n`],
  ])('%s supplies no empty or own-text proof', (_name, pane) => {
    expect(readDeliveryScreen('claude', pane, '<channel>mine</channel>')).toEqual({ kind: 'menu', running: false })
  })
  test('a normal lower rule preserves a literal l> draft as input', () => {
    expect(readDeliveryScreen('claude', panes.deliveryPane('l>draft'))).toEqual({ kind: 'input', text: 'l>draft', running: false })
  })
  test('a historical observed frame cannot hide the current human draft', () => {
    expect(readDeliveryScreen('claude', panes.deliveryPane('current human draft', { history: observedSeparatorPane }))).toEqual({ kind: 'input', text: 'current human draft', running: false })
  })
})
