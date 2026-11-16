/**
 * Test-only Bun preload for the profiled starts of tests 44, 45 and 32; see cpu-profile.ts. It does
 * nothing unless cpuProfileOptIn finds the opt-in in the CI image's daemon
 * child. Then it removes the opt-in from this process's environment, so the
 * server's own children never load it, and runs startCpuProfile. Everything,
 * the module load included, is contained here: a profiler failure leaves
 * only its marker, and the server starts as it would without the preload.
 */
try {
  const { CPU_PROFILE_DIR_ENV, cpuProfileOptIn, startCpuProfile } = await import('./cpu-profile.ts')
  const dir = cpuProfileOptIn(process.env, process.argv)
  if (dir) {
    delete process.env['BUN_OPTIONS']
    delete process.env[CPU_PROFILE_DIR_ENV]
    await startCpuProfile(dir)
  }
} catch { /* diagnostic only: never changes the server's start */ }

export {}
