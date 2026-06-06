import { describe, expect, it } from "vitest";
import {
  detectEveryKindMigration,
  detectSessionTargetMigration,
  detectSystemEventPayloadMigration,
  detectTzFieldMigration,
} from "./schema-migrations.js";

// ---------------------------------------------------------------------------
// detectEveryKindMigration
// ---------------------------------------------------------------------------

describe("detectEveryKindMigration", () => {
  it("returns empty result when no kind:every jobs exist", () => {
    const jobs = [
      { id: "a", schedule: { kind: "cron", expr: "0 9 * * *" } },
      { id: "b", schedule: { kind: "at", at: "2026-06-01T09:00:00.000Z" } },
    ] as Array<Record<string, unknown>>;

    const result = detectEveryKindMigration(jobs);

    expect(result.found).toBe(0);
    expect(result.convertible).toBe(0);
    expect(result.unmigratable).toBe(0);
    expect(result.previewLines).toHaveLength(0);
  });

  it("converts every-5min to */5 * * * * cron expression", () => {
    const jobs = [
      { id: "j1", schedule: { kind: "every", everyMs: 5 * 60_000 } },
    ] as Array<Record<string, unknown>>;

    const result = detectEveryKindMigration(jobs);

    expect(result.found).toBe(1);
    expect(result.convertible).toBe(1);
    expect(result.unmigratable).toBe(0);
    expect(result.previewLines[0]).toContain("*/5 * * * *");

    result.apply();

    const sched = jobs[0]?.schedule as Record<string, unknown>;
    expect(sched.kind).toBe("cron");
    expect(sched.expr).toBe("*/5 * * * *");
    expect(sched.everyMs).toBeUndefined();
    expect(sched.anchorMs).toBeUndefined();
  });

  it("converts every-1min to * * * * *", () => {
    const jobs = [
      { id: "j1", schedule: { kind: "every", everyMs: 60_000 } },
    ] as Array<Record<string, unknown>>;

    const result = detectEveryKindMigration(jobs);

    expect(result.convertible).toBe(1);
    result.apply();
    const sched = jobs[0]?.schedule as Record<string, unknown>;
    expect(sched.expr).toBe("* * * * *");
  });

  it("converts every-1hour using anchor minute", () => {
    // anchor at :15
    const anchorDate = new Date("2026-01-01T08:15:00.000Z");
    const jobs = [
      { id: "j1", schedule: { kind: "every", everyMs: 60 * 60_000, anchorMs: anchorDate.getTime() } },
    ] as Array<Record<string, unknown>>;

    const result = detectEveryKindMigration(jobs);

    expect(result.convertible).toBe(1);
    result.apply();
    const sched = jobs[0]?.schedule as Record<string, unknown>;
    expect(sched.kind).toBe("cron");
    // expr should be "<minute> * * * *"
    expect(typeof sched.expr).toBe("string");
    expect((sched.expr as string).endsWith("* * * *")).toBe(true);
  });

  it("converts every-24h to daily cron using anchor minute and hour", () => {
    const anchorDate = new Date("2026-01-01T09:30:00.000Z");
    const jobs = [
      { id: "j1", schedule: { kind: "every", everyMs: 24 * 60 * 60_000, anchorMs: anchorDate.getTime() } },
    ] as Array<Record<string, unknown>>;

    const result = detectEveryKindMigration(jobs);

    expect(result.convertible).toBe(1);
    result.apply();
    const sched = jobs[0]?.schedule as Record<string, unknown>;
    expect(sched.kind).toBe("cron");
    // Should be "<minute> <hour> * * *" in the system's local time for the anchor
    expect(typeof sched.expr).toBe("string");
    const parts = (sched.expr as string).split(" ");
    expect(parts).toHaveLength(5);
    expect(parts[2]).toBe("*");
    expect(parts[3]).toBe("*");
    expect(parts[4]).toBe("*");
  });

  it("marks sub-minute everyMs as unmigratable", () => {
    const jobs = [
      { id: "j1", schedule: { kind: "every", everyMs: 30_000 } },
    ] as Array<Record<string, unknown>>;

    const result = detectEveryKindMigration(jobs);

    expect(result.found).toBe(1);
    expect(result.convertible).toBe(0);
    expect(result.unmigratable).toBe(1);
    expect(result.previewLines[0]).toContain("cannot be auto-converted");

    result.apply(); // no-op for unmigratable
    const sched = jobs[0]?.schedule as Record<string, unknown>;
    expect(sched.kind).toBe("every"); // unchanged
  });

  it("marks non-divisor-of-60 minute steps as unmigratable", () => {
    // 7 minutes does not divide 60 cleanly
    const jobs = [
      { id: "j1", schedule: { kind: "every", everyMs: 7 * 60_000 } },
    ] as Array<Record<string, unknown>>;

    const result = detectEveryKindMigration(jobs);

    expect(result.unmigratable).toBe(1);
    expect(result.convertible).toBe(0);
  });

  it("marks multi-day intervals as unmigratable", () => {
    const jobs = [
      { id: "j1", schedule: { kind: "every", everyMs: 3 * 24 * 60 * 60_000 } },
    ] as Array<Record<string, unknown>>;

    const result = detectEveryKindMigration(jobs);

    expect(result.unmigratable).toBe(1);
  });

  it("handles a mix of convertible and unmigratable jobs", () => {
    const jobs = [
      { id: "convertible", schedule: { kind: "every", everyMs: 15 * 60_000 } },
      { id: "unmigratable", schedule: { kind: "every", everyMs: 7 * 60_000 } },
    ] as Array<Record<string, unknown>>;

    const result = detectEveryKindMigration(jobs);

    expect(result.found).toBe(2);
    expect(result.convertible).toBe(1);
    expect(result.unmigratable).toBe(1);

    result.apply();

    const first = jobs[0]?.schedule as Record<string, unknown>;
    expect(first.kind).toBe("cron");
    expect(first.expr).toBe("*/15 * * * *");

    const second = jobs[1]?.schedule as Record<string, unknown>;
    expect(second.kind).toBe("every"); // unchanged
  });

  it("does not apply mutations before apply() is called", () => {
    const jobs = [
      { id: "j1", schedule: { kind: "every", everyMs: 60_000 } },
    ] as Array<Record<string, unknown>>;

    detectEveryKindMigration(jobs);

    // Not called apply() — jobs should be unchanged
    const sched = jobs[0]?.schedule as Record<string, unknown>;
    expect(sched.kind).toBe("every");
  });
});

// ---------------------------------------------------------------------------
// detectTzFieldMigration
// ---------------------------------------------------------------------------

describe("detectTzFieldMigration", () => {
  it("returns empty result when no tz fields exist", () => {
    const jobs = [
      { id: "a", schedule: { kind: "cron", expr: "0 9 * * *" } },
    ] as Array<Record<string, unknown>>;

    const result = detectTzFieldMigration(jobs);

    expect(result.cronTzFound).toBe(0);
    expect(result.atTzConvertible).toBe(0);
    expect(result.atTzUnparseable).toBe(0);
    expect(result.previewLines).toHaveLength(0);
  });

  it("detects and strips tz from kind:cron schedules", () => {
    const jobs = [
      { id: "j1", schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Tokyo" } },
      { id: "j2", schedule: { kind: "cron", expr: "30 8 * * *", tz: "UTC" } },
    ] as Array<Record<string, unknown>>;

    const result = detectTzFieldMigration(jobs);

    expect(result.cronTzFound).toBe(2);
    expect(result.previewLines[0]).toContain("legacy `tz` field");

    result.apply();

    const sched1 = jobs[0]?.schedule as Record<string, unknown>;
    expect(sched1.tz).toBeUndefined();
    expect(sched1.expr).toBe("0 9 * * *");

    const sched2 = jobs[1]?.schedule as Record<string, unknown>;
    expect(sched2.tz).toBeUndefined();
  });

  it("converts kind:at + tz to UTC ISO string", () => {
    // 2026-06-01T09:00:00 in Asia/Tokyo (UTC+9) → 2026-06-01T00:00:00.000Z
    const jobs = [
      {
        id: "j1",
        schedule: { kind: "at", at: "2026-06-01T09:00:00", tz: "Asia/Tokyo" },
      },
    ] as Array<Record<string, unknown>>;

    const result = detectTzFieldMigration(jobs);

    expect(result.atTzConvertible).toBe(1);
    expect(result.previewLines[0]).toContain("UTC");

    result.apply();

    const sched = jobs[0]?.schedule as Record<string, unknown>;
    expect(typeof sched.at).toBe("string");
    expect(sched.tz).toBeUndefined();
    // The UTC time should be around midnight UTC (Asia/Tokyo is UTC+9)
    const utcMs = new Date(sched.at as string).getTime();
    const expectedMs = new Date("2026-06-01T00:00:00.000Z").getTime();
    expect(Math.abs(utcMs - expectedMs)).toBeLessThan(60_000); // within 1 minute
  });

  it("handles fixed-offset tz strings for kind:at", () => {
    // 2026-06-01T09:00:00 in +08:00 → 2026-06-01T01:00:00.000Z
    const jobs = [
      {
        id: "j1",
        schedule: { kind: "at", at: "2026-06-01T09:00:00", tz: "+08:00" },
      },
    ] as Array<Record<string, unknown>>;

    const result = detectTzFieldMigration(jobs);

    expect(result.atTzConvertible).toBe(1);

    result.apply();

    const sched = jobs[0]?.schedule as Record<string, unknown>;
    const utcMs = new Date(sched.at as string).getTime();
    const expectedMs = new Date("2026-06-01T01:00:00.000Z").getTime();
    expect(utcMs).toBe(expectedMs);
    expect(sched.tz).toBeUndefined();
  });

  it("marks kind:at with unrecognized tz as unparseable and leaves unchanged", () => {
    const jobs = [
      {
        id: "j1",
        schedule: { kind: "at", at: "not-a-date", tz: "America/New_York" },
      },
    ] as Array<Record<string, unknown>>;

    const result = detectTzFieldMigration(jobs);

    // "not-a-date" won't parse so convertLocalToUtc returns null
    expect(result.atTzUnparseable).toBe(1);
    expect(result.atTzConvertible).toBe(0);

    result.apply();

    const sched = jobs[0]?.schedule as Record<string, unknown>;
    // Unchanged
    expect(sched.at).toBe("not-a-date");
    expect(sched.tz).toBe("America/New_York");
  });

  it("does not touch kind:cron or kind:at schedules without tz", () => {
    const jobs = [
      { id: "a", schedule: { kind: "cron", expr: "0 9 * * *" } },
      { id: "b", schedule: { kind: "at", at: "2026-06-01T09:00:00.000Z" } },
    ] as Array<Record<string, unknown>>;

    const result = detectTzFieldMigration(jobs);

    expect(result.cronTzFound).toBe(0);
    expect(result.atTzConvertible).toBe(0);
    expect(result.previewLines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectSessionTargetMigration
// ---------------------------------------------------------------------------

describe("detectSessionTargetMigration", () => {
  it("returns empty result when all jobs have isolated sessionTarget", () => {
    const jobs = [
      { id: "a", sessionTarget: "isolated" },
      { id: "b", sessionTarget: "session:ProjectAlpha" },
      { id: "c" }, // no sessionTarget
    ] as Array<Record<string, unknown>>;

    const result = detectSessionTargetMigration(jobs);

    expect(result.found).toBe(0);
    expect(result.previewLines).toHaveLength(0);
  });

  it("detects jobs with sessionTarget:main and migrates them to isolated", () => {
    const jobs = [
      { id: "j1", sessionTarget: "main" },
      { id: "j2", sessionTarget: "isolated" },
    ] as Array<Record<string, unknown>>;

    const result = detectSessionTargetMigration(jobs);

    expect(result.found).toBe(1);
    expect(result.previewLines[0]).toContain("j1");
    expect(result.previewLines[0]).toContain("main");
    expect(result.previewLines[0]).toContain("isolated");

    result.apply();

    expect(jobs[0]?.sessionTarget).toBe("isolated");
    expect(jobs[1]?.sessionTarget).toBe("isolated");
  });

  it("migrates all non-isolated non-session string targets to isolated", () => {
    const jobs = [
      { id: "j1", sessionTarget: "main" },
      { id: "j2", sessionTarget: "MAIN" },
      { id: "j3", sessionTarget: "other-target" },
    ] as Array<Record<string, unknown>>;

    const result = detectSessionTargetMigration(jobs);

    expect(result.found).toBe(3);

    result.apply();

    for (const job of jobs) {
      expect(job.sessionTarget).toBe("isolated");
    }
  });

  it("preserves session: prefixed targets", () => {
    const jobs = [
      { id: "j1", sessionTarget: "session:ProjectAlpha" },
    ] as Array<Record<string, unknown>>;

    const result = detectSessionTargetMigration(jobs);

    expect(result.found).toBe(0);

    result.apply();

    expect(jobs[0]?.sessionTarget).toBe("session:ProjectAlpha");
  });

  it("preserves current sessionTarget (handled by store-migration)", () => {
    const jobs = [
      { id: "j1", sessionTarget: "current" },
    ] as Array<Record<string, unknown>>;

    const result = detectSessionTargetMigration(jobs);

    expect(result.found).toBe(0);
  });

  it("does not apply mutations before apply() is called", () => {
    const jobs = [
      { id: "j1", sessionTarget: "main" },
    ] as Array<Record<string, unknown>>;

    detectSessionTargetMigration(jobs);

    expect(jobs[0]?.sessionTarget).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// detectSystemEventPayloadMigration
// ---------------------------------------------------------------------------

describe("detectSystemEventPayloadMigration", () => {
  it("returns empty result when all jobs are agentTurn", () => {
    const jobs = [
      { id: "a", enabled: true, payload: { kind: "agentTurn", message: "hi" } },
      { id: "b", payload: { kind: "agentTurn", message: "yo" } },
    ] as Array<Record<string, unknown>>;

    const result = detectSystemEventPayloadMigration(jobs);

    expect(result.found).toBe(0);
    expect(result.previewLines).toHaveLength(0);
  });

  it("disables enabled systemEvent jobs (case-insensitive) and reports them", () => {
    const jobs = [
      { id: "j1", enabled: true, payload: { kind: "systemEvent", text: "wake up" } },
      { id: "j2", enabled: true, payload: { kind: "SystemEvent", text: "again" } },
      { id: "j3", enabled: true, payload: { kind: "agentTurn", message: "ok" } },
    ] as Array<Record<string, unknown>>;

    const result = detectSystemEventPayloadMigration(jobs);

    expect(result.found).toBe(2);
    expect(result.previewLines[0]).toContain("j1");
    expect(result.previewLines[0]).toContain("systemEvent");

    result.apply();

    expect(jobs[0]?.enabled).toBe(false);
    expect(jobs[1]?.enabled).toBe(false);
    expect(jobs[2]?.enabled).toBe(true);
  });

  it("skips systemEvent jobs that are already disabled", () => {
    const jobs = [
      { id: "j1", enabled: false, payload: { kind: "systemEvent", text: "wake up" } },
    ] as Array<Record<string, unknown>>;

    const result = detectSystemEventPayloadMigration(jobs);

    expect(result.found).toBe(0);
    expect(result.previewLines).toHaveLength(0);
  });
});
