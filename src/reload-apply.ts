/**
 * reload-apply.ts — The step-ordered apply of a confirmed change and its log
 * lines (b.av2 SR-8.5, SR-8.6, SR-10.3).
 *
 * A confirmed, valid candidate is applied in six steps; each step completes
 * for every persona before the next starts (b.av2 SR-8.6):
 *
 *   1. rewrite the last-applied record and swap the applied set (the reload
 *      controller in `reload.ts` does this itself);
 *   2. teardowns of removed personas (and the old half of a destructive
 *      modify);
 *   3. in-place updates;
 *   4. credentials reconnects;
 *   5. the agent-director template refresh, only when the set of effective
 *      config directories changed (`configDirsChanged`);
 *   6. bring-ups of added personas (and the new half of a destructive
 *      modify).
 *
 * Steps 2–6 are slots (`ApplyStepSlots`): a body per step, bound by the work
 * that implements it; an unbound slot does nothing. `applyStepInputs` hands
 * each slot the `Persona` declarations its step acts on, taken from the change
 * plan the detection tick built from the confirmed bytes (`buildChangePlan`,
 * `reload-plan.ts`), never from a second diff. `applyStepsFor` decides which
 * slots run: a plan with no effective change runs only slot 5, and only when
 * its config directories changed. `runApplySteps` runs them in order, each
 * awaited before the next.
 *
 * The line renderers here give the apply-time reload classes their text:
 * `reload-applied`, `reload-noop`, `reload-stale-confirmation`, and the
 * `reload-invalid` line of a confirmed candidate.
 *
 * Pure (b.av2 SR-13.1): nothing here reads or writes a file, calls Slack or
 * agent-director, arms a timer, logs or holds state, and nothing runs at
 * import; `runApplySteps` only awaits the injected bodies. No output holds a
 * token, credentials content, a digest or a fingerprint.
 *
 * SPDX-License-Identifier: MIT
 */

import { configReadFailurePredicate, type Persona, type PersonaConfig } from './config.ts'
import { escapeCause } from './persona-diagnostics.ts'
import {
  changePlanCounts,
  RELOAD_INVALID,
  renderChangePlanCounts,
  type CredentialsPersonaChange,
  type InPlaceSetting,
  type InvalidChangePlan,
  type ValidChangePlan,
} from './reload-plan.ts'

// ---------------------------------------------------------------------------
// Diagnostic classes (b.av2 SR-10.3); listed in `RELOAD_DIAGNOSTIC_CLASSES`
// ---------------------------------------------------------------------------

/** A confirmed change was applied without a restart. */
export const RELOAD_APPLIED = 'reload-applied'

/** A confirmed candidate had no effective change; only the record was rewritten. */
export const RELOAD_NOOP = 'reload-noop'

/**
 * A confirmation that does not match the current contents, or cannot be read,
 * or holds no fingerprint: nothing is applied.
 */
export const RELOAD_STALE_CONFIRMATION = 'reload-stale-confirmation'

// ---------------------------------------------------------------------------
// Steps 2–6
// ---------------------------------------------------------------------------

/** The apply steps after step 1, in the order they run (b.av2 SR-8.6 steps 2–6). */
export const APPLY_STEPS = [
  'teardowns',
  'in-place-updates',
  'credentials-reconnects',
  'template-refresh',
  'bring-ups',
] as const

/** One apply step after step 1. */
export type ApplyStepName = (typeof APPLY_STEPS)[number]

/** A persona modified in place: its new and its previous declaration, and what changed. */
export interface InPlaceApplyInput {
  persona: Persona
  previous: Persona
  settings: InPlaceSetting[]
}

/** A persona whose credentials content changed: its declaration and the plan's entry for it. */
export interface CredentialsApplyInput {
  persona: Persona
  change: CredentialsPersonaChange
}

/** What the steps after step 1 act on, from one change plan. Holds no token or digest. */
export interface ApplyStepInputs {
  /** The applied configuration before step 1. */
  previous: PersonaConfig
  /** The configuration step 1 applied (the confirmed candidate). */
  applied: PersonaConfig
  /**
   * Step 2: the removed personas, then the destructively modified ones, as
   * the previous configuration declares them.
   */
  teardowns: Persona[]
  /** Step 3: the personas modified in place, in candidate order. */
  inPlaceUpdates: InPlaceApplyInput[]
  /** Step 4: the personas whose credentials content changed, in candidate order. */
  credentialsReconnects: CredentialsApplyInput[]
  /** Step 5: whether the set of effective config directories changed. */
  configDirsChanged: boolean
  /**
   * Step 6: the added personas, then the destructively modified ones, as the
   * candidate declares them.
   */
  bringUps: Persona[]
}

/** The body of one step: acts on its inputs for every persona and settles once all of them are done. */
export type ApplyStepBody = (inputs: ApplyStepInputs) => Promise<unknown>

/** The bodies of steps 2–6; an unbound slot does nothing. */
export type ApplyStepSlots = Partial<Record<ApplyStepName, ApplyStepBody>>

/** `config`'s persona with `key`; throws when there is none (a plan built from another configuration). */
function personaByKey(config: PersonaConfig, key: string): Persona {
  const persona = config.personas.find((p) => p.key === key)
  if (persona === undefined) throw new Error(`reload apply: the change plan names a persona key the configuration lacks`)
  return persona
}

/**
 * The inputs of steps 2–6 for `plan`, the plan of `applied` against
 * `previous`: each persona the plan lists, taken by key from the
 * configuration that declares it (a removed persona and the old half of a
 * destructive modify from `previous`, everything else from `applied`). Pure.
 */
export function applyStepInputs(plan: ValidChangePlan, previous: PersonaConfig, applied: PersonaConfig): ApplyStepInputs {
  return {
    previous,
    applied,
    teardowns: [...plan.removed, ...plan.destructive].map((p) => personaByKey(previous, p.key)),
    inPlaceUpdates: plan.inPlace.map((p) => ({
      persona: personaByKey(applied, p.key),
      previous: personaByKey(previous, p.key),
      settings: [...p.settings],
    })),
    credentialsReconnects: plan.credentials.map((change) => ({ persona: personaByKey(applied, change.key), change })),
    configDirsChanged: plan.configDirsChanged,
    bringUps: [...plan.added, ...plan.destructive].map((p) => personaByKey(applied, p.key)),
  }
}

/**
 * The steps after step 1 that run for `plan`, in order: every step for a plan
 * with an effect, the template refresh (step 5) only when the config
 * directories changed, and for a plan with no effective change nothing but
 * that refresh (b.av2 SR-8.6: a no-op still refreshes the template whose rule
 * text changed). Pure.
 */
export function applyStepsFor(plan: ValidChangePlan): ApplyStepName[] {
  return APPLY_STEPS.filter((step) =>
    step === 'template-refresh' ? plan.configDirsChanged : !plan.noEffectiveChange,
  )
}

/**
 * Run the bound bodies of `steps` in `APPLY_STEPS` order, each awaited before
 * the next starts. A body that throws or rejects is reported to `onFailure`
 * and the next step still runs: a step isolates its personas' failures, and
 * a failure it lets through must not stop the later steps. Resolves once the
 * last step settled; never rejects.
 */
export async function runApplySteps(
  slots: ApplyStepSlots,
  inputs: ApplyStepInputs,
  steps: readonly ApplyStepName[],
  onFailure: (step: ApplyStepName, err: unknown) => void,
): Promise<void> {
  for (const step of APPLY_STEPS) {
    const body = slots[step]
    if (body === undefined || !steps.includes(step)) continue
    try {
      await body(inputs)
    } catch (err) {
      onFailure(step, err)
    }
  }
}

/** The SR-8.6 step number of a step after step 1, for log lines. */
export function applyStepNumber(step: ApplyStepName): number {
  return APPLY_STEPS.indexOf(step) + 2
}

// ---------------------------------------------------------------------------
// Log lines (b.av2 SR-10.3: one class label per line)
// ---------------------------------------------------------------------------

/**
 * The `reload-applied` line: the counts in the preview header's terms and
 * the record that now holds the change. Pure.
 */
export function renderAppliedLogLine(plan: ValidChangePlan, recordPath: string): string {
  return (
    `[slack] ${RELOAD_APPLIED}: applied the confirmed configuration change without a restart ` +
    `(${renderChangePlanCounts(changePlanCounts(plan))}); the last-applied record ${JSON.stringify(recordPath)} now holds it`
  )
}

/** The `reload-noop` line. Pure. */
export function renderNoopLogLine(recordPath: string): string {
  return (
    `[slack] ${RELOAD_NOOP}: the confirmed configuration has no effective change, so no persona and no ` +
    `server-wide setting changed; the last-applied record ${JSON.stringify(recordPath)} was rewritten with it`
  )
}

/**
 * The `reload-invalid` line of a confirmed candidate that fails to parse or
 * validate (or a configuration file that is missing or unreadable): the full
 * error, as the loader words it. Distinct from the pending-time line
 * (`renderInvalidLogLine`). Pure.
 */
export function renderConfirmedInvalidLogLine(plan: InvalidChangePlan): string {
  return (
    `[slack] ${RELOAD_INVALID}: the confirmed configuration is invalid, so nothing is applied: ` +
    escapeCause(plan.error)
  )
}

/** Why a confirmation was not acted on. */
export type StaleConfirmationReason =
  /** Its fingerprint differs from that of the current contents. */
  | { kind: 'mismatch' }
  /**
   * It could not be read (a directory, not a regular file, over the size
   * limit, …); `code` is the reader's safe code (`PersonaConfigReadError`).
   */
  | { kind: 'unreadable'; code: string | undefined }
  /** It holds no well-formed fingerprint. */
  | { kind: 'malformed' }

/**
 * The one `reload-stale-confirmation` line: the confirmation's path and the
 * reason, never any of its content. Pure.
 */
export function renderStaleConfirmationLogLine(applyPath: string, reason: StaleConfirmationReason): string {
  const path = JSON.stringify(applyPath)
  let what: string
  switch (reason.kind) {
    case 'mismatch':
      what =
        `does not match the configuration as it stands (the configuration file or a credentials file it ` +
        `references changed after that preview was written)`
      break
    case 'unreadable':
      what = configReadFailurePredicate(reason.code)
      break
    case 'malformed':
      what = 'holds no well-formed fingerprint (it is not a pending-change file as the server writes it)'
      break
  }
  return `[slack] ${RELOAD_STALE_CONFIRMATION}: the confirmation ${path} ${what}; nothing is applied`
}
