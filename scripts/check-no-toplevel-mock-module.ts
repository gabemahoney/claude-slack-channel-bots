#!/usr/bin/env bun
/**
 * check-no-toplevel-mock-module.ts — CI gate against top-level mock.module() calls.
 *
 * WHAT IT CHECKS
 * --------------
 * Scans every *.test.ts and *.ts file under tests/ for calls to
 * `mock.module(...)` or `mock.restore(...)` that appear at the top level of
 * the file (zero indentation).
 *
 * WHY THIS MATTERS
 * ----------------
 * bun runs all test files in a single process. `mock.module()` patches the
 * module registry at the process level — it is process-global state. A
 * top-level (or describe-body-level) `mock.module()` call fires at import
 * time and is never cleaned up, which causes the patched module to leak into
 * every subsequent test file loaded in the same process. This produces
 * non-deterministic failures that are extremely hard to diagnose.
 *
 * THE RULE
 * --------
 * `mock.module(...)` must always live inside a `beforeAll` or `beforeEach`
 * block, paired with a matching `afterAll` or `afterEach` that calls
 * `mock.restore()`. Never call either at file-top-level.
 *
 * HEURISTIC USED
 * --------------
 * This scanner uses a simple line-based indentation heuristic: any line
 * whose first non-whitespace content starts at column 0 (i.e. zero leading
 * spaces) is considered "top-level". In this codebase's style, code inside
 * hooks and describe callbacks is indented by at least 2 spaces, so a
 * zero-indentation match reliably identifies leaked top-level calls.
 *
 * Bug reference: b.5wd — "add CI gate against top-level mock.module() in tests/"
 */

import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const TESTS_DIR = join(ROOT, 'tests')

function* walkTestFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkTestFiles(child)
    } else if (entry.isFile() && (entry.name.endsWith('.test.ts') || entry.name.endsWith('.ts'))) {
      yield child
    }
  }
}

const VIOLATION_RE = /^(mock\.module\(|mock\.restore\()/

let filesScanned = 0
let violations = 0

for (const filePath of walkTestFiles(TESTS_DIR)) {
  filesScanned++
  const lines = readFileSync(filePath, 'utf-8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Strip leading whitespace to check indentation
    const stripped = line.trimStart()
    // Only flag lines at column 0 (no leading whitespace)
    if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t') {
      if (VIOLATION_RE.test(stripped)) {
        process.stderr.write(
          `[check-no-toplevel-mock-module] VIOLATION: ${filePath}:${i + 1}: ${line.trim()}\n`,
        )
        violations++
      }
    }
  }
}

if (violations > 0) {
  process.stderr.write(
    `[check-no-toplevel-mock-module] FAIL — ${violations} violation(s) found in ${filesScanned} file(s) scanned.\n`,
  )
  process.exit(1)
} else {
  process.stderr.write(
    `[check-no-toplevel-mock-module] OK — ${filesScanned} test files scanned, 0 violations\n`,
  )
  process.exit(0)
}
