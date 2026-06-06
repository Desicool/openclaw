// Cron schedule tests cover schedule parsing and next-run calculations.
import { beforeEach, describe, expect, it } from "vitest";
import { coerceFiniteScheduleNumber } from "./schedule-number.js";
import {
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

  it("computes next run for cron expression", () => {
    // Saturday, Dec 13 2025 00:00:00Z; next Wednesday at 09:00 (system tz)
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeNextRunAtMs({ kind: "cron", expr: "0 9 * * 3" }, nowMs);
    expect(typeof next).toBe("number");
    expect(next).toBeGreaterThan(nowMs);
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
      {
        kind: "cron",
        cron: "0 9 * * 3",
      } as unknown as { kind: "cron"; expr: string },
      nowMs,
    );
    expect(typeof next).toBe("number");
    expect(next).toBeGreaterThan(nowMs);
  });

  it("never returns a past timestamp for a daily schedule", () => {
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

    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    requireTimestamp(
      computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *" }, nowMs),
      "first next run",
    );
    requireTimestamp(
      computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *" }, nowMs + 1_000),
      "second next run",
    );
    // Both calls use the same system timezone → only one cache entry.
    expect(getCronScheduleCacheSizeForTest()).toBe(1);
    expect(hasCronInCacheForTest("0 8 * * *", systemTz)).toBe(true);
  });

  it("promotes accessed entries to avoid premature LRU eviction", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    const cacheMax = getCronScheduleCacheMaxForTest();
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
    expect(hasCronInCacheForTest("0 0 * * *", systemTz)).toBe(true);
    expect(hasCronInCacheForTest("1 0 * * *", systemTz)).toBe(false);

    // The new entry and a non-evicted middle entry should both be present.
    expect(hasCronInCacheForTest("0 0 1 1 *", systemTz)).toBe(true);
    expect(hasCronInCacheForTest("2 0 * * *", systemTz)).toBe(true);
  });

  describe("cron with specific seconds (6-field pattern)", () => {
    // "0 0 12 * * *": fire at second 0, minute 0, hour 12 every day (system tz).
    // Discover the first fire time dynamically so the tests are tz-agnostic.
    const schedule = { kind: "cron" as const, expr: "0 0 12 * * *" };
    // Reference point well before any noon on 2026-02-08 local time.
    const beforeNoon = Date.parse("2026-02-08T00:00:00.000Z");
    // fireMs = the next noon-local after beforeNoon, whatever the system tz is.
    const fireMs = requireTimestamp(computeNextRunAtMs(schedule, beforeNoon), "fireMs");

    it("advances past current second when nowMs is exactly at the match", () => {
      // Fix #14164: must NOT return the current second — that caused infinite
      // re-fires when multiple jobs triggered simultaneously.
      const next = computeNextRunAtMs(schedule, fireMs);
      expect(next).toBeGreaterThan(fireMs);
      // Must be at least one full second later.
      expect(next).toBeGreaterThanOrEqual(fireMs + 1000);
    });

    it("advances past current second when nowMs is mid-second (.500) within the match", () => {
      // Fix #14164: returning the current second caused rapid duplicate fires.
      const next = computeNextRunAtMs(schedule, fireMs + 500);
      expect(next).toBeGreaterThan(fireMs);
      expect(next).toBeGreaterThanOrEqual(fireMs + 1000);
    });

    it("advances past current second when nowMs is late in the matching second (.999)", () => {
      const next = computeNextRunAtMs(schedule, fireMs + 999);
      expect(next).toBeGreaterThan(fireMs);
      expect(next).toBeGreaterThanOrEqual(fireMs + 1000);
    });

    it("advances once the matching second is fully past", () => {
      const next = computeNextRunAtMs(schedule, fireMs + 1000);
      expect(next).toBeGreaterThan(fireMs + 1000);
    });

    it("returns fireMs when nowMs is just before the match", () => {
      const next = computeNextRunAtMs(schedule, fireMs - 500);
      expect(next).toBe(fireMs);
    });

    it("advances when job completes within same second it fired (#17821)", () => {
      // Regression test for #17821: cron jobs that fire and complete within
      // the same second were getting nextRunAtMs set to the same second,
      // causing a spin loop.
      const completedAtMs = fireMs + 21;
      const next = computeNextRunAtMs(schedule, completedAtMs);
      // Must NOT return fireMs; must be strictly after the firing second.
      expect(next).not.toBe(fireMs);
      expect(next).toBeGreaterThanOrEqual(fireMs + 1000);
    });

    it("advances when job completes just before second boundary (#17821)", () => {
      const completedAtMs = fireMs + 999;
      const next = computeNextRunAtMs(schedule, completedAtMs);
      expect(next).not.toBe(fireMs);
      expect(next).toBeGreaterThanOrEqual(fireMs + 1000);
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
    expect(coerceFiniteScheduleNumber("60000ms")).toBeUndefined();
    expect(coerceFiniteScheduleNumber("0x10")).toBeUndefined();
    expect(coerceFiniteScheduleNumber(Number.NaN)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(Infinity)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(null)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(undefined)).toBeUndefined();
  });
});
