/** The cgroup type and LRU counters used by both /ci and /ci-live. */
export interface NonReclaimableMemoryReading {
  readonly anonBytes: number
  /** Optional only for legacy /ci diagnostics; live readings require every counter. */
  readonly shmemBytes?: number
  readonly activeAnonBytes?: number
  readonly inactiveAnonBytes?: number
  readonly unevictableBytes?: number
}

/**
 * Memory counted by admission and the watchdog, excluding reclaimable file
 * cache. anon and shmem are separate type counters. shmem is on the anon LRU
 * lists; locked anon/shmem move to the unevictable list, so adding unevictable
 * to the type counters would count those pages twice. The disjoint anon and
 * unevictable lists account for locked file pages too. Take the larger of
 * that sum and anon + shmem because type and LRU counters can differ.
 * Legacy diagnostics have only anon; production reads all four extra keys.
 */
export function nonReclaimableMemoryBytes(reading: NonReclaimableMemoryReading): number {
  const anonAndShmem = reading.anonBytes + (reading.shmemBytes ?? 0)
  const anonAndUnevictableLists = (reading.activeAnonBytes ?? 0) + (reading.inactiveAnonBytes ?? 0) + (reading.unevictableBytes ?? 0)
  return Math.max(anonAndShmem, anonAndUnevictableLists)
}
