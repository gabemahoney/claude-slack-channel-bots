/** Agent UI details stay behind this adapter (b.omv SR-5.3/5.4). */
export type DeliveryAgent = 'claude' | 'codex'
export type DeliveryScreen = { kind: 'empty' | 'own' | 'input' | 'menu'; text?: string; running: boolean }
export const FULL_PANE_READ_LINES = 40
export function stripDeliveryAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}
const rule = (line: string): boolean => /^\s*[─━\-]{8,}\s*$/.test(line)
const menuFooter = /esc to cancel|enter to select|enter to confirm|to navigate/i
const runningLine = /^[✢✳✶✻✽·*].*[……].*(?:\(|tokens|thinking)|esc to interrupt|interrupt.*esc/i
function observation(text: string, own: string | undefined, running: boolean, claude: boolean): DeliveryScreen {
  const empty = text.trim() === '' || (claude
    ? /^(?:Try ["“].*["”]|Press up to edit queued messages|Message @\S+…)\s*$/.test(text.trim())
    : /^(?:Ask Codex to do anything|Ask a follow-up question)\s*$/.test(text.trim()))
  if (empty) return { kind: 'empty', running }
  // Prefix recognition is deliberately conservative: it must start at the
  // composer, never at a quoted historical prompt. Long-paste drawing is SR-5.4.
  const prefix = own?.split('\n')[0]
  if (own && ((prefix && text.startsWith(prefix)) || (claude && text.startsWith('[Pasted text')))) return { kind: 'own', text, running }
  return { kind: 'input', text, running }
}
export function readDeliveryScreen(agent: DeliveryAgent, pane: string, ownText?: string): DeliveryScreen {
  const lines = stripDeliveryAnsi(pane).split('\n')
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  if (agent === 'claude') {
    let lower = -1
    for (let i = lines.length - 1; i >= 0; i--) if (rule(lines[i]!)) { lower = i; break }
    if (lower < 0) return { kind: 'menu', running: false }
    const footer = lines.slice(lower + 1)
    if (footer.some(line => menuFooter.test(line))) return { kind: 'menu', running: false }
    // A completed prompt box is followed only by actual footer/status lines.
    if (footer.some(line => line.trim() && !/^\s*(?:[⏵▶▸]|\?|shift\+|ctrl\+|context|\d+%|\$|auto|accept|bypass|plan mode|permission|←|!)/i.test(line))) return { kind: 'menu', running: false }
    let upper = lower - 1
    while (upper >= 0 && !rule(lines[upper]!)) upper--
    if (upper < 0) return { kind: 'menu', running: false }
    const box = lines.slice(upper + 1, lower)
    const first = box[0]?.match(/^\s*[❯>] ?(.*)$/)
    if (!first) return { kind: 'menu', running: false }
    // A menu cursor (❯ 1. …) inside a bordered dialog is not a composer.
    if (/^\d+[.)]\s/.test(first[1]!)) return { kind: 'menu', running: false }
    return observation([first[1]!, ...box.slice(1).map(s => s.replace(/^  /, ''))].join('\n'), ownText, lines.slice(0, upper).some(line => runningLine.test(line)), true)
  }
  let composer = -1
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*›(?: |$)/.test(lines[i]!)) { composer = i; break }
  if (composer < 0) return { kind: 'menu', running: false }
  const block = lines.slice(composer)
  if (block.some(line => menuFooter.test(line) || /Viewing sub-agent — direct input is disabled/i.test(line))) return { kind: 'menu', running: false }
  const text = [block[0]!.replace(/^\s*› ?/, '')]
  // Codex reserves the bottom row for its footer, whose configured text is
  // arbitrary. It is a position, not the '? for shortcuts' string anchor.
  for (const line of block.slice(1, block.length > 1 ? -1 : undefined)) {
    if (/\? for shortcuts|context left|\d+% left|^\s*(?:gpt-|codex-|model:)|esc to interrupt/i.test(line)) break
    if (line.trim()) text.push(line.replace(/^  /, ''))
  }
  return observation(text.join('\n'), ownText, lines.slice(0, composer).some(line => runningLine.test(line) || /esc to interrupt/i.test(line)), false)
}
