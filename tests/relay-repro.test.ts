/**
 * relay-repro.test.ts — relay-bug reproducers / acceptance scenarios.
 *
 * The pre-Epic-1 (b.o5y) scenarios drove tick-driven `request_id`
 * reconciliation. Epic 1 removes Case 4 entirely, so those scenarios no
 * longer apply. Epic 3 (`t1.5hs.wi`) repopulates this file with the
 * two-row capstone scenario against the verdict-rendered wire.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test } from 'bun:test'

describe('relay-repro — Epic 3 placeholder', () => {
  test.skip('two-row capstone scenario lands with Epic 3 (t1.5hs.wi)', () => { /* Epic 3 */ })
})
