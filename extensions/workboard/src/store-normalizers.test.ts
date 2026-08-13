// Regression coverage for the bounded-string normalizer used across Workboard
// input validators. The helper is shared by comment body, card id, link
// target, link URL, and link title; an opaque error message blocks agents
// that overshoot the limit because they cannot tell how far over they are.
// Title / notes / labels use their own independent validators and emit
// generic error messages that are intentionally out of scope for this
// helper.
import { describe, expect, it } from "vitest";
import { normalizeBoundedString } from "./store-normalizers.js";

describe("normalizeBoundedString", () => {
  it("returns the fallback for empty or whitespace input", () => {
    expect(normalizeBoundedString(undefined, "fallback", 10, "field")).toBe("fallback");
    expect(normalizeBoundedString("", "fallback", 10, "field")).toBe("fallback");
    expect(normalizeBoundedString("   ", "fallback", 10, "field")).toBe("fallback");
  });

  it("returns the trimmed value when within the limit", () => {
    expect(normalizeBoundedString("  hello  ", undefined, 10, "field")).toBe("hello");
  });

  it("throws an error that names the actual length when over the limit", () => {
    // Build a body that exceeds the 2000-char comment limit so we exercise the
    // exact path the issue reports (clawsweeper:source-repro).
    const overlong = "x".repeat(3502);
    expect(() => normalizeBoundedString(overlong, undefined, 2000, "comment body")).toThrow(
      /^comment body must be 2000 characters or fewer \(got 3502\)\.$/,
    );
  });

  it("keeps the error message length-aware for every bounded field", () => {
    // The `normalizeBoundedString` helper is the shared diagnostic owner for
    // comment body, card id, link target, link URL, and link title. A
    // regression that drops the (got N) suffix will fail here.
    //
    // Note: `normalizeTitle`, `normalizeNotes`, and `normalizeLabels` are
    // independent validators with their own generic error messages, not
    // consumers of this helper, so they are intentionally excluded from
    // this matrix. Closes the false-confidence gap that ClawSweeper
    // flagged on the prior matrix.
    const cases: ReadonlyArray<{
      readonly field: string;
      readonly limit: number;
      readonly actual: number;
    }> = [
      { field: "link title", limit: 180, actual: 181 },
      { field: "link target", limit: 120, actual: 121 },
      { field: "link URL", limit: 2000, actual: 2001 },
      { field: "card id", limit: 120, actual: 121 },
    ];
    for (const c of cases) {
      const overlong = "x".repeat(c.actual);
      expect(() => normalizeBoundedString(overlong, undefined, c.limit, c.field)).toThrow(
        new RegExp(`^${c.field} must be ${c.limit} characters or fewer \\(got ${c.actual}\\)\\.$`),
      );
    }
  });
});
