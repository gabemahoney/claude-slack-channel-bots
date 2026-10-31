/** b.iy3: execute the gate's selection/check shell with isolated inputs.
 * Docker, git and credential lookup are recording shell functions. The
 * client checks execute only their version comparisons, never a client or
 * agent-director binary. Real image/runtime proof still belongs to /ci.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PHASE1_FLOOR_VERSION } from '../src/ad-version-gate.ts'
import { CI_AD_RUNTIME_COMMIT, CI_AD_RUNTIME_VERSION, OLD_AD_VERSION } from './test-helpers/agent-director-versions.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const repo = join(import.meta.dir, '..')
const source = (file: string) => readFileSync(join(repo, file), 'utf8')

function block(text: string, start: string, end: string): string {
  const from = text.indexOf(start), to = text.indexOf(end, from)
  if (from < 0 || to <= from) throw new Error(`Missing executable check block ${start}`)
  return text.slice(from, to)
}

function shell(program: string, extras: Record<string, string> = {}, files: Record<string, string> = {}) {
  const home = mkdtempSync('/tmp/cscb-ad-runtime-')
  try {
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(home, name), contents)
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${program}`], {
      cwd: repo,
      env: hostSafeChildEnv(home, {
        tools: ['bash', 'jq', 'cat', 'sed', 'mktemp', 'rm'],
        extras: { SLACK_STATE_DIR: join(home, 'state'), ...extras },
      }),
      encoding: 'utf8', timeout: 3000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    return result
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('b.iy3 current AD runtime provenance', () => {
  test('base build selects the approved runtime installer tag, regardless of source checkout HEAD', () => {
    const result = shell(`
CSCB_AD_SRC_DIR="$HOME/source-checkout"
export CSCB_AD_SRC_DIR
git() {
    [[ "$1" == -C && "$2" == "$CSCB_AD_SRC_DIR" ]] || return 91
    shift 2
    case "$1" in
        rev-parse) [[ "$*" == "rev-parse --verify --quiet refs/tags/"* ]] || return 92 ;;
        show) printf 'installer from %s\\n' "$2" ;;
        *) return 93 ;;
    esac
}
# No credential discovery or real build: all calls terminate here.
gh() { return 1; }
docker() {
    [[ "$1" == build ]] || return 94
    local arg context=''
    for arg in "$@"; do
        case "$arg" in agent-director-install=*) context="\${arg#*=}" ;; esac
    done
    [[ -n "$context" && -f "$context/install.sh" ]] || return 95
    cat "$context/install.sh"
}
source scripts/ci-base-build.sh
`)
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe(`installer from v${CI_AD_RUNTIME_VERSION}:skills/install-agent-director/install.sh`)
  })

  test.each([
    ['unchanged pinned client with a newer runtime', PHASE1_FLOOR_VERSION, 0],
    ['client drift to the runtime release', CI_AD_RUNTIME_VERSION, 1],
  ] as const)('client provenance: %s', (_label, clientVersion, exitCode) => {
    const check = source('docker/ad-client-check.sh')
    const result = shell(`
SCRATCH="$HOME"
TARGET="$HOME"
CLIENT_DIR="$HOME"
MODE=--package
PHASE1_MODULE=src/ad-version-gate.ts
PLAIN_RELEASE_RE='^[0-9]+\\.[0-9]+\\.[0-9]+$'
fail() { printf '%s: %s\\n' "$1" "$2" >&2; exit 1; }
first_line() { printf 'unexpected import failure'; }
# The only bun call in this block reads the package floor. No module loads.
bun() { printf '%s' "$PACKAGE_FLOOR"; }
${block(check, '# --- 2 version', '# --- 3 content')}
`, {
      AD_VERSION: CI_AD_RUNTIME_VERSION,
      AD_CLIENT_VERSION: PHASE1_FLOOR_VERSION,
      PACKAGE_FLOOR: PHASE1_FLOOR_VERSION,
    }, { 'package.json': JSON.stringify({ version: clientVersion, dependencies: { 'agent-director': PHASE1_FLOOR_VERSION } }) })
    expect(result.status).toBe(exitCode)
    if (exitCode === 0) expect(result.stderr).toBe('')
    else expect(result.stderr).toContain('2 (version)')
  })

  test.each([
    ['matching current runtime', CI_AD_RUNTIME_VERSION, CI_AD_RUNTIME_COMMIT, 0],
    ['stale cached runtime', PHASE1_FLOOR_VERSION, CI_AD_RUNTIME_COMMIT, 1],
    ['correct version but foreign commit', CI_AD_RUNTIME_VERSION, '0'.repeat(40), 1],
    ['old migration fixture on ordinary PATH', OLD_AD_VERSION, CI_AD_RUNTIME_COMMIT, 1],
  ] as const)('runtime provenance: %s', (_label, binaryVersion, binaryCommit, exitCode) => {
    const check = source('docker/ad-client-check.sh')
    // Execute the actual binary identity decision with already-read version
    // values. No command lookup or version probe can reach the host binary.
    const result = shell(`
fail() { printf '%s: %s\\n' "$1" "$2" >&2; exit 1; }
${block(check, 'if [ "${BIN_VERSION}"', '# --- 6 floor')}
`, {
      BIN: '/image-only/agent-director', BIN_VERSION: binaryVersion, BIN_COMMIT: binaryCommit,
      AD_VERSION: CI_AD_RUNTIME_VERSION, AD_COMMIT: CI_AD_RUNTIME_COMMIT,
      CLIENT_VERSION: PHASE1_FLOOR_VERSION,
    })
    expect(result.status).toBe(exitCode)
    if (exitCode === 0) expect(result.stderr).toBe('')
    else expect(result.stderr).toContain('5 (binary)')
  })
})
