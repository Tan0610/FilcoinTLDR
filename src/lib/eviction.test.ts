/**
 * The eviction opt-in.
 *
 * Small module, disproportionate stakes: this is the only thing standing
 * between a `PRUNE_DATASET` decision and an irreversible `terminateService`.
 * The tests are therefore about what must NOT arm it — an empty string, a
 * typo, a value someone half-set — rather than about what does.
 */

import { describe, expect, it } from "vitest";

import {
  EVICTION_ENV,
  describeEvictionGate,
  evictionDisabledNote,
  evictionEnabled,
} from "./eviction";

describe("evictionEnabled", () => {
  it("is off when the variable is absent", () => {
    expect(evictionEnabled({})).toBe(false);
  });

  it("accepts only the four values that unambiguously mean yes", () => {
    for (const value of ["on", "1", "true", "yes", "ON", " True "]) {
      expect(evictionEnabled({ [EVICTION_ENV]: value })).toBe(true);
    }
  });

  it("refuses anything that only looks like a yes", () => {
    // A destructive capability must never be armed by a value nobody meant.
    // "enabled", "y" and "2" are all plausible typos for an operator who thinks
    // they turned this on; every one of them leaves it off.
    for (const value of ["", " ", "off", "0", "false", "no", "enabled", "y", "2", "on!"]) {
      expect(evictionEnabled({ [EVICTION_ENV]: value })).toBe(false);
    }
  });
});

describe("the withheld-execution wording", () => {
  it("names the data set, the variable, and that nothing was attempted", () => {
    const note = evictionDisabledNote("30292");

    expect(note).toContain("#30292");
    expect(note).toContain(EVICTION_ENV);
    expect(note).toContain("No transaction");
    // The point of the record: the agent DECIDED this. It was simply not
    // permitted to act, which is a different thing from having held.
    expect(note).toContain("recorded as made");
  });

  it("warns, in the armed notice, that the capability is irreversible", () => {
    expect(describeEvictionGate()).toContain("irreversible");
    expect(describeEvictionGate()).toContain(EVICTION_ENV);
  });
});
