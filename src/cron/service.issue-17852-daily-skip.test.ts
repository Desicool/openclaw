import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { recomputeNextRuns, recomputeNextRunsForMaintenance } from "./service/jobs.js";
import type { CronJob } from "./types.js";

/**
 * Regression test for issue #17852: daily cron jobs skip a day (48h jump).
 *
 * Root cause: onTimer's results-processing block used the full
 * recomputeNextRuns which could silently advance a past-due nextRunAtMs
 * for a job that became due between findDueJobs and the post-execution
 * locked block — skipping that run and jumping 48h ahead.
 *
 * Fix: use recomputeNextRunsForMaintenance in the post-execution block,
 * which only fills in missing nextRunAtMs values and never overwrites
 * existing (including past-due) ones.
 */
describe("issue #17852 - daily cron jobs should not skip days", () => {
  const MIN_MS = 60_000;

  // Use a "every minute" schedule so the test is timezone-agnostic.
  // The regression applies to any recurring cron — not just daily ones.
  function createEveryMinuteJob(scheduledAt: number): CronJob {
    return {
      id: "recurring-job",
      name: "every minute",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: { kind: "agentTurn", message: "tick" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      createdAtMs: scheduledAt - MIN_MS,
      updatedAtMs: scheduledAt - MIN_MS,
      state: {
        nextRunAtMs: scheduledAt,
      },
    };
  }

  it("recomputeNextRunsForMaintenance should NOT advance past-due nextRunAtMs by default", () => {
    // Simulate: job scheduled for a minute boundary; timer fires 1 second later.
    // The job was NOT executed in this tick (e.g., it became due between
    // findDueJobs and the post-execution block).
    const scheduledAt = Date.parse("2026-02-16T03:00:00.000Z");
    const now = scheduledAt + 1_000; // 1 second after the due slot

    const job = createEveryMinuteJob(scheduledAt);

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Maintenance should NOT touch existing past-due nextRunAtMs.
    // The job should still be eligible for execution on the next timer tick.
    expect(job.state.nextRunAtMs).toBe(scheduledAt);
  });

  it("recomputeNextRunsForMaintenance can advance expired nextRunAtMs on recovery path when slot already executed", () => {
    const scheduledAt = Date.parse("2026-02-16T03:00:00.000Z");
    const now = scheduledAt + 1_000; // 1 second after the due slot

    const job = createEveryMinuteJob(scheduledAt);
    job.state.lastRunAtMs = scheduledAt + 1; // mark slot as already executed

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true });

    // Slot already executed: maintenance should advance to the next occurrence.
    // With `* * * * *` the next slot is exactly one minute ahead.
    const nextSlot = scheduledAt + MIN_MS;
    expect(job.state.nextRunAtMs).toBe(nextSlot);
  });

  it("full recomputeNextRuns WOULD silently advance past-due nextRunAtMs (the bug)", () => {
    // This test documents the buggy behavior that caused #17852.
    // The full recomputeNextRuns sees a past-due nextRunAtMs and advances it
    // to the next occurrence WITHOUT executing the job.
    const scheduledAt = Date.parse("2026-02-16T03:00:00.000Z");
    const now = scheduledAt + 1_000; // 1 second after the due slot

    const job = createEveryMinuteJob(scheduledAt);

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRuns(state);

    // The full recomputeNextRuns advances to the NEXT slot — skipping the
    // current slot's execution entirely.  This is the jump bug.
    const nextSlot = scheduledAt + MIN_MS;
    expect(job.state.nextRunAtMs).toBe(nextSlot);
  });
});
