/**
 * persona-serializer.ts — Per-persona lifecycle serialization (b.av2 SR-6.6).
 *
 * Lifecycle operations on one persona run strictly in sequence; operations on
 * different personas are independent. `createPersonaSerializer()` returns a
 * serializer keyed by persona key: `run(key, operation)` starts `operation`
 * only after every operation already submitted for that key has settled
 * (resolved or rejected), and resolves or rejects with the operation's own
 * result. The per-key state is one promise chain, the tail of the key's
 * queue; no lock, queue or timer spans two keys (b.av2 SR-3.3), so an
 * operation for one persona never waits on another persona's.
 *
 * What runs through it (production wires one shared instance in server.ts):
 * - the work a restart timer does when it fires (`restart.ts`, through
 *   `RestartDeps.serialize`): the shutdown and not-up checks, the liveness
 *   probe, reconnect, kill and launch. Scheduling, backoff, the cap, the
 *   `activeLaunches` guard and the human-trigger clamp are not serialized;
 * - each bring-up retry attempt, through to the launch it triggers
 *   (`persona-bringup-controller.ts`, through its `serialize` dependency): a
 *   directory re-check with its Slack step and launch, and the launch after a
 *   Slack retry reached `up`;
 * - the apply's lifecycle operations (`persona-lifecycle.ts`): teardown,
 *   in-place update, credentials change (step 4's reconnect, which awaits
 *   the new connection's first attempt) and bring-up (step 6, the recovery
 *   bring-up of a credentials-broken persona included; a recovery that
 *   finds the persona no longer broken runs the credentials change body
 *   directly in the same turn, never through `run` again);
 * - the connection manager's network close of the socket it detached when
 *   a running persona's Web API call was refused for its bot token
 *   (`persona-connections.ts`, bug b.ujn). It is submitted, never awaited,
 *   because the refusal can arrive inside an operation already holding the
 *   persona's turn; the credentials-broken mark itself is synchronous and
 *   never waits for the serializer.
 * A credentials reconnect's later attempts (retries on its own timer) and
 * its swap or refusal do not go through it: they touch only the
 * connection, and whatever they trigger that launches (the launch after a
 * late swap brought a refused persona back up) is submitted by the bring-up
 * controller.
 * The start's bring-up pass does not: the reload detection tick, the only
 * source of applies, is armed only after that pass returns. The launch
 * single-flight (`spawnForPersona`'s in-flight launches) stays inside the
 * operations that launch.
 *
 * Guards are the operation's own: an operation checks the applied set and the
 * up state when it starts, not when it is submitted, so work that waited
 * behind a teardown does nothing for a key that has left the applied set.
 *
 * Failure isolation: a rejected or throwing operation does not stop later
 * operations for the same key. Its rejection reaches the submitter through
 * the promise `run` returned, and the serializer's own chain swallows it, so
 * nothing becomes an unhandled rejection unless the submitter drops the
 * promise `run` returned. A submitter that does not await it must attach its
 * own `.catch`.
 *
 * RE-ENTRANCY RULE: an operation running for key K must never await `run(K,
 * …)` or `whenIdle(K)`. Both wait for the running operation itself to settle,
 * so the operation would wait for itself forever. Nested calls are not run
 * inline; callers are structured so this cannot happen: code that already
 * runs inside K's operation calls the next step's body directly (as the
 * bring-up controller's directory re-check calls its launch body), and only
 * code outside any operation for K submits to K. An operation may submit
 * work for K without awaiting it (it runs after the operation settles), and
 * may freely await operations for other keys.
 *
 * Pure module (b.av2 SR-13.1): importing it creates nothing, and all state
 * lives in the instance `createPersonaSerializer` returns, so tests build a
 * fresh one instead of resetting module state.
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Submit `operation` for persona `key`: it starts once every operation
 * already submitted for `key` has settled. Resolves or rejects as the
 * operation does. A synchronous throw becomes a rejection.
 */
export type PersonaSerialize = <T>(key: string, operation: () => T | Promise<T>) => Promise<T>

/** A per-persona lifecycle serializer. */
export interface PersonaSerializer {
  /** Submit an operation for `key` (see `PersonaSerialize`). */
  run: PersonaSerialize
  /**
   * Resolves once every operation submitted for `key` before this call has
   * settled; at once when none is queued or running. Never rejects, and never
   * waits for an operation submitted after the call or for another key. Must
   * not be awaited inside an operation for the same key (see the re-entrancy
   * rule).
   */
  whenIdle(key: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function ignore(): void {
  /* the submitter gets the rejection; the chain only orders */
}

/** Create a serializer. Holds nothing until the first `run`. */
export function createPersonaSerializer(): PersonaSerializer {
  /** Per key, the settled-marker of the last operation submitted; removed once it settles with nothing after it. */
  const tails = new Map<string, Promise<void>>()

  function run<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve()
    const result = previous.then(() => operation())
    const tail = result.then(ignore, ignore)
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return result
  }

  return {
    run,
    whenIdle: (key) => tails.get(key) ?? Promise.resolve(),
  }
}
