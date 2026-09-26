/**
 * container-boot.ts — reading the live entrypoint's boot record.
 *
 * The entrypoint (docker/live/entrypoint.sh) writes `<boot number> <status>`
 * to BOOT_DONE_FILE at the end of each boot: the first start is boot 1 and
 * each `docker restart` adds one (Check 28's reboot). The runner waits for
 * the boot it expects and refuses any other number or a status but `ok`.
 * Pure: runtime/container-run.ts reads the file in the container.
 */

/** Where the entrypoint records each finished boot: `<boot number> <ok|first-boot-failed>`. */
export const BOOT_DONE_FILE = '/var/lib/cscb-live/boot-done'

export interface BootRecord {
  boot: number
  status: string
}

/** The boot record from `cat BOOT_DONE_FILE`'s exit code and output, or `null` when there is none (yet). */
export function parseBootDone(code: number, stdout: string): BootRecord | null {
  const m = /^(\d+) ([a-z-]+)$/.exec(stdout.trim())
  return code === 0 && m ? { boot: Number(m[1]), status: m[2] as string } : null
}

/** `last` once it records boot `n` or a later one; `null` while the entrypoint is still short of it. */
export function bootReached(last: BootRecord | null, n: number): BootRecord | null {
  return last && last.boot >= n ? last : null
}

/** Why a finished boot is not a good boot `n` (another number, or a failed boot), or `null` when it is. */
export function bootProblem(done: BootRecord, n: number): string | null {
  if (done.boot !== n) return `the container entrypoint reports boot ${done.boot}, not boot ${n}`
  if (done.status !== 'ok') return `the container entrypoint's boot ${n} failed (${done.status})`
  return null
}
