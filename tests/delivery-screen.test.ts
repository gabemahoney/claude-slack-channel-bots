/** b.omv SR-5.3/5.4: the adapter reads the bottom composer, never history. */
import { describe, expect, test } from 'bun:test'
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
