/** Async-local client ownership lets shared guards retain their production
 * classification while engine reconnects use the isolated client (SR-5.1/5.8). */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Client } from 'agent-director'
export interface DeliveryAdScope {
  current(key: string): { client: Client; beforeCall(): void } | undefined
  run<T>(key: string, client: Client, beforeCall: () => void, work: () => Promise<T>): Promise<T>
}
export function createDeliveryAdScope(): DeliveryAdScope {
  const storage = new AsyncLocalStorage<{ key: string; client: Client; beforeCall(): void }>()
  return {
    current(key) { const s = storage.getStore(); return s?.key === key ? s : undefined },
    run: (key, client, beforeCall, work) => storage.run({ key, client, beforeCall }, work),
  }
}
