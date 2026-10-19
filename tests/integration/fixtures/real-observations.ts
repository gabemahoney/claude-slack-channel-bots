/** Packed production composer observations for real scenarios (b.omv SR-14.1). */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
/** Mask runtime credentials before bounding or printing retained UI evidence. */
export function redactRealObservation(text: string, env: Record<string, string | undefined>): string {
  const secrets = Object.entries(env).filter(([name, value]) => /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name) && value).flatMap(([, value]) => [value!, JSON.stringify(value).slice(1, -1)])
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '<redacted>')
  return text
}
if (import.meta.main) {
  const args = process.argv.slice(2), diagnostic = args[0] === '--idle-diagnostic'
  if (diagnostic) args.shift()
  try {
    if (!existsSync('/etc/cscb-ci-image')) throw new Error('real-observations requires the CI image')
    const [file, ownFile] = args
    if (!file) throw new Error('real-observations requires a read-pane JSON file')
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!diagnostic && typeof value.pane !== 'string') throw new Error('read-pane returned no pane')
    const pkg = resolve(process.env.CSCB_PKG_DIR ?? '/test-repo/node_modules/claude-slack-channel-bots')
    const { readDeliveryScreen } = await import(join(pkg, 'src/delivery-screen.ts'))
    if (diagnostic) {
      const { redactSlackLogText } = await import(join(pkg, 'src/slack-log-redaction.ts'))
      const status = ownFile ? JSON.parse(readFileSync(ownFile, 'utf8')) : {}
      const pane = typeof value.pane === 'string' ? value.pane : undefined
      const screen = pane === undefined ? null : readDeliveryScreen('claude', pane)
      const evidence = redactSlackLogText(redactRealObservation(JSON.stringify({ state: status.state ?? 'unreadable', pane: pane ?? null, screen }), process.env))
      console.log(`recorded: idle diagnostic ${evidence.slice(0, 24000)}${evidence.length > 24000 ? ' [truncated]' : ''}`)
      process.exit(0)
    }
    console.log(JSON.stringify({ pane: value.pane, screen: readDeliveryScreen('claude', value.pane, ownFile ? readFileSync(ownFile, 'utf8') : undefined) }))
  } catch (error) { console.error(`real-observations: ${diagnostic ? 'idle diagnostic unavailable' : error instanceof Error ? error.message : 'unknown failure'}`); process.exit(1) }
}
