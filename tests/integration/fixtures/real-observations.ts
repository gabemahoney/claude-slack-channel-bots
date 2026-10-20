/** Credential masking and structured AD observations for real scenarios. */
import { existsSync, readFileSync } from 'node:fs'
/** Mask runtime credentials before bounding or printing retained UI evidence. */
export function redactRealObservation(text: string, env: Record<string, string | undefined>): string {
  const secrets = Object.entries(env).filter(([name, value]) => /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name) && value).flatMap(([, value]) => [value!, JSON.stringify(value).slice(1, -1)])
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '<redacted>')
  return text
}
if (import.meta.main) {
  try {
    if (!existsSync('/etc/cscb-ci-image')) throw new Error('CI image required')
    const { projectFailureState } = await import('../../real-agent/ai-failure-diagnostics.ts')
    const status = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
    console.log(`recorded: AD state ${JSON.stringify(projectFailureState(status))}`)
  } catch { console.error('recorded: AD state diagnostic unavailable'); process.exit(1) }
}
