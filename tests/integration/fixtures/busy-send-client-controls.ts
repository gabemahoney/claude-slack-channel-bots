/** Real client decoding with an inert executable. Explicit package override is
 * read-only; no installed dependency, native AD, Docker or account is touched.
 * Bundling gives CSCB and the decoder the same client class identities.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dir, '../../..')
const clientEntry = process.argv[2] ? join(resolve(process.argv[2]), 'dist/index.js') : Bun.resolveSync('agent-director', repo)
mkdirSync(join(repo, '.scratch'), { recursive: true })
const root = mkdtempSync(join(repo, '.scratch/busy-client-'))
try {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'busy-send-client-cases.ts')],
    target: 'bun', packages: 'external', outdir: root,
    plugins: [{ name: 'explicit-client-under-test', setup(build) {
      build.onResolve({ filter: /^agent-director$/ }, () => ({ path: clientEntry }))
      // Optional fail-before source, without editing the checkout or history.
      if (process.argv[3]) build.onLoad({ filter: /\/src\/ad-error-class\.ts$/ }, args => ({
        contents: readFileSync(resolve(process.argv[3]), 'utf8'), loader: 'ts', resolveDir: dirname(args.path),
      }))
    } }],
  })
  assert(built.success, built.logs.map(String).join('\n'))
  const child = spawnSync(process.execPath, [join(root, 'busy-send-client-cases.js'), root, process.argv[2] ? 'native' : 'legacy-envelope'], { encoding: 'utf8', timeout: 30000 })
  process.stdout.write(child.stdout)
  process.stderr.write(child.stderr)
  assert.equal(child.status, 0, 'real-client refusal controls failed')
} finally { rmSync(root, { recursive: true, force: true }) }
