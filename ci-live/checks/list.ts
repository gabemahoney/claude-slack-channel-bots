/**
 * list.ts — every check in the testplan's run order, then the two runner
 * checks: Teardown (the container is removed; apps and channels are kept for
 * reruns, plan Teardown step 6) and HOST (the production side of this machine
 * is unchanged: agent-director rows, tmux sessions, the port-3100 listener
 * and the host config.json's hash, before vs after; a probe that failed
 * either time fails it, "probe failed: …").
 */

import { compareSnapshots, describeSnapshot, probeFailures } from '../lib/host-state.ts'
import { CHANNEL_CHECKS } from './channel-checks.ts'
import type { CheckContext } from './context.ts'
import { DM_CHECKS } from './dm-checks.ts'
import { Findings, type CheckDef } from './framework.ts'
import { LIFECYCLE_CHECKS } from './lifecycle-checks.ts'
import { installCheck, preflightCheck, s1Check, s2Check, s3Check, setupCheck } from './setup-checks.ts'

export const teardownCheck: CheckDef<CheckContext> = {
  id: 'teardown',
  title: 'Teardown: the test container is removed (apps and channels kept for reruns)',
  needs: [],
  row: null,
  always: true,
  async run(ctx) {
    const f = new Findings()
    f.expect(await ctx.removeContainer(), 'the test container could not be removed')
    f.add(`container ${ctx.container.name} removed; test apps and channels kept`)
    f.note('Teardown: the four test apps and the channels were left in place for a rerun')
    return f.result()
  },
}

export const hostCheck: CheckDef<CheckContext> = {
  id: 'HOST',
  title: 'HOST: the production CSCB on this machine is untouched',
  needs: [],
  row: null,
  always: true,
  async run(ctx) {
    const f = new Findings()
    const after = await ctx.hostNow()
    f.add(`before: ${describeSnapshot(ctx.hostBefore)}`)
    f.add(`after: ${describeSnapshot(after)}`)
    // A probe that failed compares equal to itself: that would be a vacuous pass.
    for (const failure of probeFailures(ctx.hostBefore)) f.expect(false, `probe failed before the run: ${failure}`)
    for (const failure of probeFailures(after)) f.expect(false, `probe failed after the run: ${failure}`)
    for (const diff of compareSnapshots(ctx.hostBefore, after)) f.expect(false, diff)
    return f.result()
  },
}

/** The testplan's checks in run order (Parts 1–11). */
export const PLAN_CHECKS: CheckDef<CheckContext>[] = [
  preflightCheck,
  installCheck,
  setupCheck,
  s1Check,
  s2Check,
  s3Check,
  ...CHANNEL_CHECKS,
  ...DM_CHECKS,
  ...LIFECYCLE_CHECKS,
]

/** Run after the plan's checks, in this order, whatever happened before. */
export const FINAL_CHECKS: CheckDef<CheckContext>[] = [teardownCheck, hostCheck]
