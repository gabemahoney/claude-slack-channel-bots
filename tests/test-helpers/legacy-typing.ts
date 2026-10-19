/** Legacy recovery matrices classify replies without testing the Enter pause.
 * Real clock-driven key timing and ownership are covered by the E3 entry tests. */
import { afterEach, beforeEach } from 'bun:test'
import { createDeliveryLifecycle, type DeliveryLifecycle } from '../../src/delivery-lifecycle.ts'
import { _setDeliveryLifecycle } from '../../src/server.ts'
import { createFakeClock } from './fake-clock.ts'

export function useImmediateTypingLifecycle(): void {
  let life: DeliveryLifecycle
  beforeEach(() => {
    life = createDeliveryLifecycle({ startId: 'legacy-recovery', clock: createFakeClock() })
    _setDeliveryLifecycle({ ...life, pause: async () => {} })
  })
  afterEach(async () => {
    await life.stop()
    _setDeliveryLifecycle(undefined)
  })
}
