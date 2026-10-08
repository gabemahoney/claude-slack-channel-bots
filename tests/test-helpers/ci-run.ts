/**
 * test-helpers/ci-run.ts — Builders and fakes for the sharded `/ci` runner's
 * component tests (`tests/ci-run-*.test.ts`; b.uqm SR-21.4).
 *
 * Every test of `scripts/ci-run.ts` drives the runner in process through its
 * injected dependencies (`RunnerDeps`), and takes those fakes and the files it
 * reads from here. Rules:
 *
 * - No test hand-writes a status file, reservation, results file, result-file
 *   line or verdict. Each is built here: a valid one through the runner's own
 *   writers and names, an invalid one from a valid one by a stated change.
 * - The helper types no runner constant or message: it imports them from
 *   `scripts/ci-run.ts`.
 * - It never starts a real child process, references a child-process function
 *   or uses `mock.module`. Children are answered by the spawn recorder and the
 *   fake container interface; time moves only on `createFakeClock`
 *   (`./fake-clock.ts`), which the runner takes as its `RunnerClock`.
 *
 * Layout. One banner per owner, in this fixed order; each lane writes only
 * under its own banner (Plan b.t6s, "One runner file"):
 *
 *    1. spawn recorder (E1 T6)
 *    2. process table, signals and `/proc` (E1 T6)
 *    3. lock probe (E1 T6)
 *    4. fake container interface (E1 T6)
 *    5. worktree builder (E1 T7)
 *    6. run-directory builder (E1 T7)
 *    7. reader additions (E3)
 *    8. lock directory and password file (E5)
 *    9. cgroups, `/ci-live` and readings (E6)
 *   10. sample sequences (E7)
 *
 * The import from the runner below also keeps `scripts/ci-run.ts` in
 * `bun run typecheck`: `tsconfig.json` includes only `src/`,
 * `tests/*.test.ts` and `tests/test-helpers/*.ts`, so the runner is checked
 * only through a file that imports it. Keep at least one import from it.
 *
 * SPDX-License-Identifier: MIT
 */

// The typecheck anchor (see above); each lane adds the names it uses.
import type { RunnerDeps } from '../../scripts/ci-run.ts'

// ---------------------------------------------------------------------------
// 1. Spawn recorder (E1 T6)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2. Process table, signals and /proc (E1 T6)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. Lock probe (E1 T6)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4. Fake container interface (E1 T6)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. Worktree builder (E1 T7)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. Run-directory builder (E1 T7)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. Reader additions (E3)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 8. Lock directory and password file (E5)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 9. Cgroups, /ci-live and readings (E6)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10. Sample sequences (E7)
// ---------------------------------------------------------------------------
