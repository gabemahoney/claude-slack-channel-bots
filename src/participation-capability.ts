/**
 * participation-capability.ts — Each persona's root-lookup capability: the
 * connection-time history-scope check and the lazy method verification.
 *
 * `connected` runs when the persona's connection is up and reads the scopes
 * Slack reported when its token was validated; it never calls Slack. Unknown
 * scopes are not a gap and not a verification. `lookupSucceeded` and
 * `lookupRefused` record what the first real bounded root lookup showed.
 * A gap is reported through `report.gap` (delivery reporting posts it once
 * per episode) and ends through `report.cleared` when a later connection or
 * recovery's re-read of the granted scopes (`recheckScopes`) reports every
 * required scope (a scope gap), or a lookup succeeds (a method refusal)
 * while no configured history scope is missing; with one still missing, the
 * success turns the refusal into that scope gap and the episode stays open.
 * A connection missing only scopes that hold no lookup keeps an open refusal.
 * The persona's connection is never touched.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Persona } from './config.ts'
import { capabilityGapHoldsLookups, missingHistoryScopes, type RootLookupCapabilityGap } from './participation-channel-evidence.ts'

/** `unknown`: no evidence yet; `scopes-present`: scopes granted, method not yet used; `verified`: a lookup succeeded. */
export type RootLookupCapabilityState = 'unknown' | 'scopes-present' | 'verified' | 'missing'

export interface RootLookupCapabilityDeps {
  grantedScopes(key: string): readonly string[] | undefined
  persona(key: string): Pick<Persona, 'dm'> | undefined
  report: {
    gap(key: string, gap: RootLookupCapabilityGap): void
    cleared(key: string): void
  }
}

export interface RootLookupCapability {
  /** The persona's connection came up: check its configured history scopes. */
  connected(key: string): void
  /**
   * The granted scopes were read again while a missing-scope gap is open
   * (recovery's re-check): clear the gap when every required scope is now
   * granted. Unknown scopes and any other state change nothing.
   */
  recheckScopes(key: string): void
  lookupSucceeded(key: string): void
  /** A real lookup was refused for its scope, token type or permission. */
  lookupRefused(key: string, slackError: string): void
  state(key: string): RootLookupCapabilityState
  gap(key: string): RootLookupCapabilityGap | undefined
  /**
   * Whether a root lookup may be attempted: false only while a channel
   * history scope is known missing. A refused method is retried by
   * recovery's capability re-check, so a later success can clear it; a
   * repeat of the same refusal reports nothing.
   */
  usable(key: string): boolean
  forget(key: string): void
}

export function createRootLookupCapability(deps: RootLookupCapabilityDeps): RootLookupCapability {
  const states = new Map<string, { state: RootLookupCapabilityState; gap?: RootLookupCapabilityGap }>()
  const protect = (run: () => void) => { try { run() } catch { /* reporting cannot change capability */ } }
  function set(key: string, state: RootLookupCapabilityState, gap?: RootLookupCapabilityGap): void {
    const before = states.get(key)
    states.set(key, { state, ...(gap ? { gap } : {}) })
    if (gap) protect(() => deps.report.gap(key, gap))
    else if (before?.gap) protect(() => deps.report.cleared(key))
  }
  return {
    connected(key) {
      let missing: string[] | undefined
      try { missing = missingHistoryScopes(deps.grantedScopes(key), deps.persona(key)) } catch { missing = undefined }
      const current = states.get(key)
      if (missing === undefined) {
        // Unknown scopes neither prove nor clear a refused method.
        if (current?.gap?.kind !== 'method-refused') set(key, 'unknown')
        return
      }
      if (missing.length) {
        if (current?.gap?.kind === 'method-refused' && !capabilityGapHoldsLookups({ kind: 'missing-scope', scopes: missing })) return
        if (current?.gap?.kind === 'missing-scope' && current.gap.scopes.join() === missing.join()) return
        set(key, 'missing', { kind: 'missing-scope', scopes: missing })
        return
      }
      if (current?.gap?.kind === 'method-refused') return
      set(key, current?.state === 'verified' ? 'verified' : 'scopes-present')
    },
    recheckScopes(key) {
      const current = states.get(key)
      if (current?.gap?.kind !== 'missing-scope') return
      let missing: string[] | undefined
      try { missing = missingHistoryScopes(deps.grantedScopes(key), deps.persona(key)) } catch { return }
      if (missing === undefined) return
      if (!missing.length) { set(key, 'scopes-present'); return }
      if (current.gap.scopes.join() !== missing.join()) set(key, 'missing', { kind: 'missing-scope', scopes: missing })
    },
    lookupSucceeded(key) {
      const current = states.get(key)
      // A channel lookup proves nothing about a missing `im:history`.
      if (current?.state === 'verified' || current?.gap?.kind === 'missing-scope') return
      if (current?.gap?.kind === 'method-refused') {
        let missing: string[] | undefined
        try { missing = missingHistoryScopes(deps.grantedScopes(key), deps.persona(key)) } catch { missing = undefined }
        if (missing?.length) { set(key, 'missing', { kind: 'missing-scope', scopes: missing }); return }
      }
      set(key, 'verified')
    },
    lookupRefused(key, slackError) {
      const current = states.get(key)
      if (current?.gap?.kind === 'method-refused' && current.gap.slackError === slackError) return
      // A missing channel scope already explains the refusal; one of only `im:history` does not.
      if (current?.gap?.kind === 'missing-scope' && capabilityGapHoldsLookups(current.gap)) return
      set(key, 'missing', { kind: 'method-refused', method: 'conversations.replies', slackError })
    },
    state: key => states.get(key)?.state ?? 'unknown',
    gap: key => states.get(key)?.gap,
    usable: key => {
      const gap = states.get(key)?.gap
      return gap?.kind !== 'missing-scope' || !capabilityGapHoldsLookups(gap)
    },
    forget(key) { states.delete(key) },
  }
}
