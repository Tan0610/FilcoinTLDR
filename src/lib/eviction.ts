/**
 * The opt-in that lets a `PRUNE_DATASET` decision actually reach the chain.
 *
 * WHY AN OPT-IN AT ALL
 * --------------------
 * Every other action this agent can take is additive: a deposit moves USDFC it
 * can move again. Terminating a data set is not. `terminateService` ends the
 * PDP payment rail, and the provider stops being paid to keep the pieces — the
 * data goes. There is no undo, and a demo is exactly the setting in which an
 * unexpected destructive action does the most damage.
 *
 * So execution is gated on a variable that is OFF unless someone deliberately
 * turned it on, and the gate is checked twice: once in the policy engine (which
 * is told the answer as an explicit input, so it stays pure) and again in the
 * agent runner immediately before the call. A decision that says EXECUTE and an
 * environment that says no results in nothing being submitted.
 *
 * WHAT HAPPENS WHEN IT IS OFF
 * ---------------------------
 * The agent still MAKES the decision. It still records it, with its target, its
 * reading and its full reasoning, in the durable journal — and the outcome says
 * plainly that execution is disabled and which variable enables it. That record
 * is the autonomy artifact; the transaction is only its consequence. An agent
 * that can say "I have decided this data set is not worth paying for, and I am
 * not permitted to act on it" is more honest than one that quietly holds.
 *
 * CONFIGURATION
 * -------------
 *   FILRUNWAY_ENABLE_EVICTION=on   (also 1 / true / yes)
 *
 * Anything else — unset, empty, "off", a typo — is off. A destructive
 * capability must never be enabled by a value nobody meant.
 */

/** The slice of the environment this module reads. */
export type EvictionEnv = Record<string, string | undefined>;

/** The variable that permits a `PRUNE_DATASET` decision to be submitted. */
export const EVICTION_ENV = "FILRUNWAY_ENABLE_EVICTION";

/** Exactly the values that mean "yes". Everything else means no. */
const ENABLED_VALUES = new Set(["on", "1", "true", "yes"]);

/** May a `PRUNE_DATASET` decision be submitted to the chain here? */
export function evictionEnabled(env: EvictionEnv = process.env): boolean {
  const raw = env[EVICTION_ENV]?.trim().toLowerCase();
  return raw !== undefined && ENABLED_VALUES.has(raw);
}

/**
 * The sentence appended to a `PRUNE_DATASET` decision whose execution is
 * withheld. Built here so the wording is identical everywhere it appears and
 * can be asserted in a test rather than eyeballed in a screenshot.
 */
export function evictionDisabledNote(dataSetId: string): string {
  return (
    `Execution is DISABLED on this deployment: terminating a data set is irreversible, so ` +
    `it requires the explicit opt-in ${EVICTION_ENV}=on, which is not set. No transaction ` +
    `was attempted and data set #${dataSetId} is untouched. The decision is recorded as ` +
    `made — this is what the agent concluded, not what it did.`
  );
}

/** One line for the agent trace, raised only when the capability is armed. */
export function describeEvictionGate(): string {
  return (
    `Data set eviction is ARMED (${EVICTION_ENV}=on): a decision that a data set is past ` +
    "its proving deadline and not worth paying for may submit terminateService, which is " +
    "irreversible. Unset the variable to record such decisions without executing them."
  );
}
