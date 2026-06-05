import { describe, expect, it } from "vitest";
import { isoWeekNumber, weekBoundaries, weekKey, weekTitle } from "./week-key.js";

describe("week-key", () => {
  it("matches ISO week numbers for representative dates", () => {
    expect(isoWeekNumber(new Date("2026-05-22T18:00:00Z"))).toEqual({ isoYear: 2026, isoWeek: 21 });
    expect(weekKey(new Date("2026-05-22T18:00:00Z"))).toBe("2026-W21");
  });

  it("handles week-of-year boundary on Thursday rule", () => {
    expect(weekKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(weekKey(new Date("2027-01-04T00:00:00Z"))).toBe("2027-W01");
    expect(weekKey(new Date("2025-12-29T00:00:00Z"))).toBe("2026-W01");
    expect(weekKey(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
  });

  it("formats weekTitle as Monday.compact-Sunday.compact", () => {
    expect(weekTitle(new Date("2026-05-22T18:00:00Z"))).toBe("2026.5.18-2026.5.24");
    expect(weekTitle(new Date("2027-01-01T00:00:00Z"))).toBe("2026.12.28-2027.1.3");
  });

  it("returns Monday→following Monday boundaries (UTC, exclusive end)", () => {
    const { startUtc, endUtcExclusive } = weekBoundaries(new Date("2026-05-22T18:00:00Z"));
    expect(startUtc.toISOString()).toBe("2026-05-18T00:00:00.000Z");
    expect(endUtcExclusive.toISOString()).toBe("2026-05-25T00:00:00.000Z");
  });

  it("rejects Sunday week start in v1", () => {
    expect(() => weekKey(new Date(), "sunday")).toThrow(/not supported/);
    expect(() => weekTitle(new Date(), "sunday")).toThrow(/not supported/);
  });
});
