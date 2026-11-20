/** Real scratch files and the existing atomic writer, with injectable I/O faults. */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableUnlinkSync, durableWriteFileSync } from '../../src/atomic-write.ts'
import type { AdInputBinding, AdInputHoldIo, AdInputHoldStore } from '../../src/ad-input-holds.ts'

export function inputBinding(overrides: Partial<AdInputBinding> = {}): AdInputBinding {
  return { instanceId: 'cscb_alpha', rowStartedAt: '2026-11-20T00:00:00Z', sessionId: 'alpha-session', launchStartedAt: '2026-11-20T01:00:00Z', ...overrides }
}

export async function makeInputHoldFixture(stateDir: string, now: () => number = () => Date.parse('2026-11-20T02:00:00Z')) {
  const { createAdInputHoldStore } = await import('../../src/ad-input-holds.ts')
  const faults = { read: false, write: false, remove: false, unsynced: false }
  const writes: string[] = []
  const io: AdInputHoldIo = {
    read(path: string) {
      if (faults.read) throw Object.assign(new Error('fixture read failure'), { code: 'EACCES' })
      try { return readFileSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    write(path: string, bytes: Uint8Array) {
      if (faults.write) throw Object.assign(new Error('fixture write failure'), { code: 'ENOSPC' })
      mkdirSync(dirname(path), { recursive: true })
      durableWriteFileSync(path, bytes)
      writes.push(path)
      if (faults.unsynced) throw new Error('fixture directory sync failure after replacement')
    },
    remove(path: string) {
      if (faults.remove) throw Object.assign(new Error('fixture unlink failure'), { code: 'EACCES' })
      durableUnlinkSync(path)
    },
  }
  const fresh = (): AdInputHoldStore => createAdInputHoldStore({ stateDir, now, io })
  return { store: fresh(), fresh, io, faults, writes }
}
