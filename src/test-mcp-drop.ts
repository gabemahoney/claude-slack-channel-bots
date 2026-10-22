/** Startup-only, injected fault route; importing it performs no I/O. */
import { isLocalAddress, INTERJECT_BODY_CAP_BYTES } from './interject.ts'

export const TEST_MCP_DROP_ROUTE = '/test/drop-mcp'
export const TEST_MCP_DROP_START_LINE = '[slack] WARNING: test-only MCP drop route is ON; not for production use'
export interface TestMcpDropDeps {
  getPersonaConfig(): { personas: readonly { key: string }[] } | null
  disconnect(key: string): Promise<void>
  log(line: string): void
}
export function testMcpDropLine(key: string): string {
  return `[slack] test-only MCP drop: persona=${key}`
}
export async function handleTestMcpDrop(req: Request, peer: string | null | undefined, deps: TestMcpDropDeps): Promise<Response> {
  const answer = (status: number, body: object) => Response.json(body, { status })
  if (req.method !== 'POST') return answer(405, { error: 'Method Not Allowed' })
  if (!isLocalAddress(peer ?? '')) return answer(403, { error: 'Forbidden' })
  let value: unknown
  try {
    const text = await req.text()
    if (Buffer.byteLength(text) > INTERJECT_BODY_CAP_BYTES) return answer(400, { error: 'Request body too large' })
    value = JSON.parse(text)
  } catch { return answer(400, { error: 'Invalid JSON' }) }
  const key = value && typeof value === 'object' ? (value as { persona?: unknown }).persona : undefined
  if (typeof key !== 'string' || !key) return answer(400, { error: 'Missing or invalid persona' })
  const persona = deps.getPersonaConfig()?.personas.find(p => p.key === key)
  if (!persona) return answer(404, { error: 'Persona not found' })
  deps.log(testMcpDropLine(persona.key))
  try { await deps.disconnect(persona.key) }
  catch { return answer(500, { error: 'MCP disconnect failed' }) }
  return answer(200, { ok: true, persona: persona.key })
}
