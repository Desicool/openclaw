import { beforeEach, describe, expect, it } from "vitest";
import {
  coerceFiniteScheduleNumber,
  clearCronScheduleCacheForTest,
  computeNextRunAtMs,
  computePreviousRunAtMs,
  getCronScheduleCacheMaxForTest,
  getCronScheduleCacheSizeForTest,
  hasCronInCacheForTest,
} from "./schedule.js";

function requireTimestamp(value: number | undefined, label: string): number {
  if (value === undefined) {
    throw new Error(`expected ${label} timestamp`);
  }
  return value;
}

describe("cron schedule", () => {
  beforeEach(() => {
    clearCronScheduleCacheForTest();
  });

  it("computes next run for a weekly cron expression", () => {
    // Saturday, Dec 13 2025 00:00:00Z — test uses UTC-safe expression
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeNextRunAtMs({ kind: "cron", expr: "0 9 * * 3" }, nowMs);
    // Result is timezone-dependent on the process tz; just verify it is in the future.
    expect(requireTimestamp(next, "next run")).toBeGreaterThan(nowMs);
  });

  it("throws a clear error when cron expr is missing at runtime", () => {
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    expect(() =>
      computeNextRunAtMs(
        {
          kind: "cron",
        } as unknown as { kind: "cron"; expr: string },
        nowMs,
      ),
    ).toThrow("invalid cron schedule: expr is required");
  });

  it("supports legacy cron field when expr is missing", () => {
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeNextRunAtMs(
      { kind: "cron", cron: "0 9 * * 3" } as unknown as { kind: "cron"; expr: string },
      nowMs,
    );
    expect(requireTimestamp(next, "next run")).toBeGreaterThan(nowMs);
  });

  it("never returns a past timestamp for a daily UTC cron schedule", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    const next = computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *" }, nowMs);
    expect(requireTimestamp(next, "next run")).toBeGreaterThan(nowMs);
  });

  it("never returns a previous run that is at-or-after now", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    const previous = computePreviousRunAtMs({ kind: "cron", expr: "0 8 * * *" }, nowMs);
    if (previous !== undefined) {
      expect(previous).toBeLessThan(nowMs);
    }
  });

  it("reuses compiled cron evaluators for the same expression", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    expect(getCronScheduleCacheSizeForTest()).toBe(0);

    requireTimestamp(
      computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *" }, nowMs),
      "first next run",
    );
    requireTimestamp(
      computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *" }, nowMs + 1_000),
      "second next run",
    );
    requireTimestamp(
      computeNextRunAtMs({ kind: "cron", expr: "0 10 * * *" }, nowMs),
      "third next run",
    );
    // Two distinct expressions → two cache entries.
    expect(getCronScheduleCacheSizeForTest()).toBe(2);
  });

  it("promotes accessed entries to avoid premature LRU eviction", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    const cacheMax = getCronScheduleCacheMaxForTest();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Fill cache to capacity with unique expressions.
    // i=0 → "0 0 * * *", i=1 → "1 0 * * *", ..., i=511 → "31 8 * * *"
    for (let i = 0; i < cacheMax; i++) {
      computeNextRunAtMs({ kind: "cron", expr: `${i % 60} ${Math.floor(i / 60)} * * *` }, nowMs);
    }
    expect(getCronScheduleCacheSizeForTest()).toBe(cacheMax);

    // Entry #0 ("0 0 * * *") is the oldest by insertion order.
    // Access it so LRU promotes it (delete + re-insert at end of Map).
    computeNextRunAtMs({ kind: "cron", expr: "0 0 * * *" }, nowMs);

    // Entry #1 ("1 0 * * *") is now the least-recently-used.
    // Insert a new entry to trigger one eviction.
    computeNextRunAtMs({ kind: "cron", expr: "0 0 1 1 *" }, nowMs);
    expect(getCronScheduleCacheSizeForTest()).toBe(cacheMax);

    // Under LRU: entry #0 survived (was promoted), entry #1 was evicted.
    // Under FIFO: entry #0 would be evicted instead — this assertion would fail.
    expect(hasCronInCacheForTest("0 0 * * *", tz)).toBe(true);
    expect(hasCronInCacheForTest("1 0 * * *", tz)).toBe(false);

    // The new entry and a non-evicted middle entry should both be present.
    expect(hasCronInCacheForTest("0 0 1 1 *", tz)).toBe(true);
    expect(hasCronInCacheForTest("2 0 * * *", tz)).toBe(true);
  });

  describe("cron with specific seconds (6-field pattern)", () => {
    // Pattern: fire at exactly second 0 of minute 0 of hour 12 every day.
    // noonMs is computed in local time so it matches what the scheduler sees.
    const dailyNoon = { kind: "cron" as const, expr: "0 0 12 * * *" };
    const noonMs = new Date(2026, 1, 8, 12, 0, 0, 0).getTime();

    it("advances past current second when nowMs is exactly at the match", () => {
      // Fix #14164: must NOT return the current second — that caused infinite
      // re-fires when multiple jobs triggered simultaneously.
      const next = computeNextRunAtMs(dailyNoon, noonMs);
      expect(next).toBe(noonMs + 86_400_000); // next day
    });

    it("advances past current second when nowMs is mid-second (.500) within the match", () => {
      // Fix #14164: returning the current second caused rapid duplicate fires.
      const next = computeNextRunAtMs(dailyNoon, noonMs + 500);
      expect(next).toBe(noonMs + 86_400_000); // next day
    });

    it("advances past current second when nowMs is late in the matching second (.999)", () => {
      const next = computeNextRunAtMs(dailyNoon, noonMs + 999);
      expect(next).toBe(noonMs + 86_400_000); // next day
    });

    it("advances to next day once the matching second is fully past", () => {
      const next = computeNextRunAtMs(dailyNoon, noonMs + 1000);
      expect(next).toBe(noonMs + 86_400_000); // next day
    });

    it("returns today when nowMs is before the match", () => {
      const next = computeNextRunAtMs(dailyNoon, noonMs - 500);
      expect(next).toBe(noonMs);
    });

    it("advances to next day when job completes within same second it fired (#17821)", () => {
      // Regression test for #17821: cron jobs that fire and complete within
      // the same second (e.g., fire at 12:00:00.014, complete at 12:00:00.021)
      // were getting nextRunAtMs set to the same second, causing a spin loop.
      //
      // Simulating: job scheduled for 12:00:00, fires at .014, completes at .021
      const completedAtMs = noonMs + 21; // 12:00:00.021
      const next = computeNextRunAtMs(dailyNoon, completedAtMs);
      expect(next).toBe(noonMs + 86_400_000); // must be next day, NOT noonMs
    });

    it("advances to next day when job completes just before second boundary (#17821)", () => {
      // Edge case: job completes at .999, still within the firing second
      const completedAtMs = noonMs + 999; // 12:00:00.999
      const next = computeNextRunAtMs(dailyNoon, completedAtMs);
      expect(next).toBe(noonMs + 86_400_000); // next day
    });
  });
});

describe("coerceFiniteScheduleNumber", () => {
  it("returns finite numbers directly", () => {
    expect(coerceFiniteScheduleNumber(60_000)).toBe(60_000);
  });

  it("parses numeric strings", () => {
    expect(coerceFiniteScheduleNumber("60000")).toBe(60_000);
    expect(coerceFiniteScheduleNumber(" 60000 ")).toBe(60_000);
  });

  it("returns undefined for invalid inputs", () => {
    expect(coerceFiniteScheduleNumber("")).toBeUndefined();
    expect(coerceFiniteScheduleNumber("abc")).toBeUndefined();
    expect(coerceFiniteScheduleNumber(Number.NaN)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(Infinity)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(null)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(undefined)).toBeUndefined();
  });
});
