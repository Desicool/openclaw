// Top-of-hour stagger tests cover spreading jobs that would otherwise collide.
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { computeNextRunAtMs } from "./schedule.js";
import { computeJobNextRunAtMs } from "./service/jobs.js";
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS } from "./stagger.js";
import type { CronJob } from "./types.js";

function stableOffsetMs(jobId: string, windowMs: number) {
  const digest = crypto.createHash("sha256").update(jobId).digest();
  return digest.readUInt32BE(0) % windowMs;
}

function createCronJob(params: {
  id: string;
  expr: string;
  staggerMs?: number;
  state?: CronJob["state"];
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    createdAtMs: Date.parse("2026-02-06T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-06T00:00:00.000Z"),
    schedule: { kind: "cron", expr: params.expr, staggerMs: params.staggerMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "tick" },
    state: params.state ?? {},
  };
}

describe("computeJobNextRunAtMs top-of-hour staggering", () => {
  it("applies deterministic 0..5m stagger for recurring top-of-hour schedules", () => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createCronJob({ id: "hourly-job-a", expr: "0 * * * *" });
    const offsetMs = stableOffsetMs(job.id, DEFAULT_TOP_OF_HOUR_STAGGER_MS);

    const next = computeJobNextRunAtMs(job, now);
    // Compute the base next-hour boundary in the local timezone — timezone-agnostic.
    const baseNext = computeNextRunAtMs({ kind: "cron", expr: "0 * * * *" }, now);

    expect(next).toBe(baseNext! + offsetMs);
    expect(offsetMs).toBeGreaterThanOrEqual(0);
    expect(offsetMs).toBeLessThan(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("can still fire in the current hour when the staggered slot is ahead", () => {
    const now = Date.parse("2026-02-06T10:02:00.000Z");
    const job = createCronJob({ id: "hourly-job-b", expr: "0 * * * *" });
    const offsetMs = stableOffsetMs(job.id, DEFAULT_TOP_OF_HOUR_STAGGER_MS);

    // Determine the "current hour" base in local timezone by looking backwards one
    // natural cron interval from the base next run.
    const baseNext = computeNextRunAtMs({ kind: "cron", expr: "0 * * * *" }, now)!;
    const baseNextPrev = computeNextRunAtMs(
      { kind: "cron", expr: "0 * * * *" },
      baseNext - 3_600_000 - 1,
    )!;
    const thisHour = baseNextPrev; // top-of-current-hour in local tz
    const nextHour = baseNext; // top-of-next-hour in local tz

    const expected = thisHour + offsetMs > now ? thisHour + offsetMs : nextHour + offsetMs;
    const next = computeJobNextRunAtMs(job, now);

    expect(next).toBe(expected);
  });

  it("also applies to 6-field top-of-hour cron expressions", () => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createCronJob({ id: "hourly-job-seconds", expr: "0 0 * * * *" });
    const offsetMs = stableOffsetMs(job.id, DEFAULT_TOP_OF_HOUR_STAGGER_MS);

    const next = computeJobNextRunAtMs(job, now);
    const baseNext = computeNextRunAtMs({ kind: "cron", expr: "0 0 * * * *" }, now);

    expect(next).toBe(baseNext! + offsetMs);
  });

  it("supports explicit stagger for non top-of-hour cron expressions", () => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const windowMs = 30_000;
    const job = createCronJob({
      id: "minute-17-staggered",
      expr: "17 * * * *",
      staggerMs: windowMs,
    });
    const offsetMs = stableOffsetMs(job.id, windowMs);

    const next = computeJobNextRunAtMs(job, now);
    const baseNext = computeNextRunAtMs({ kind: "cron", expr: "17 * * * *" }, now);

    expect(next).toBe(baseNext! + offsetMs);
  });

  it("keeps schedules exact when staggerMs is set to 0", () => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createCronJob({ id: "daily-job", expr: "0 7 * * *", staggerMs: 0 });

    const next = computeJobNextRunAtMs(job, now);
    // With staggerMs = 0 the result must equal the unshifted next occurrence.
    const baseNext = computeNextRunAtMs({ kind: "cron", expr: "0 7 * * *" }, now);

    expect(next).toBe(baseNext);
  });

  it("caches stable stagger offsets per job/window", () => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createCronJob({ id: "hourly-job-cache", expr: "0 * * * *" });
    const hashSpy = vi.spyOn(crypto, "createHash");

    const first = computeJobNextRunAtMs(job, now);
    const second = computeJobNextRunAtMs(job, now);

    expect(second).toBe(first);
    expect(hashSpy).toHaveBeenCalledTimes(1);
    hashSpy.mockRestore();
  });
});
