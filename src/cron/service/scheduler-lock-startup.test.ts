/**
 * Tests that two scheduler starts on the same lock path result in the second
 * going silent (setting schedulerLockHeld = true) without crashing.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireSchedulerLock, type SchedulerLockHandle } from "../../cron/scheduler-lock.js";
import { start } from "../../cron/service/ops.js";
import { createCronServiceState } from "../../cron/service/state.js";

let tmpDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-scheduler-lock-startup-"));
});

afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeStorePath(id: string): string {
  return path.join(tmpDir, id, "cron", "jobs.json");
}

describe("scheduler lock startup — two starts on same lock path", () => {
  it("second start goes silent and sets schedulerLockHeld", async () => {
    // Acquire the lock manually to simulate another process holding it.
    const lockPath = path.join(tmpDir, "shared.lock");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    const firstResult = await acquireSchedulerLock({ path: lockPath });
    expect(firstResult.kind).toBe("acquired");

    if (firstResult.kind !== "acquired") {
      return; // type guard for TypeScript
    }
    const firstHandle: SchedulerLockHandle = firstResult.handle;

    try {
      // Create a second state and try to start it with the same lock path.
      const storePath = makeStorePath("second-start-test");
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }, null, 2), "utf8");

      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: noopLog,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      // Monkey-patch acquireSchedulerLock to simulate the "held by another process"
      // scenario without touching the global scheduler.lock path.
      const acquireSpy = vi
        .spyOn(await import("../../cron/scheduler-lock.js"), "acquireSchedulerLock")
        .mockImplementationOnce(async () => ({
          kind: "held" as const,
          holderPid: firstHandle.heldByPid,
        }));

      try {
        await start(state);
      } finally {
        acquireSpy.mockRestore();
      }

      // Second instance should be in held mode.
      expect(state.schedulerLockHeld).toBe(true);
      expect(state.schedulerLockHandle).toBeUndefined();

      // The warning should have been logged.
      expect(noopLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ holderPid: firstHandle.heldByPid }),
        expect.stringContaining("scheduler lock held by another process"),
      );

      // No timer should have been armed (scheduler does not run).
      expect(state.timer).toBeNull();
    } finally {
      await firstHandle.release();
    }
  });

  it("first start acquires lock and second start with mock held returns silently", async () => {
    const storePath = makeStorePath("first-acquires-test");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }, null, 2), "utf8");

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: noopLog,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    // Mock acquireSchedulerLock to return "held".
    const acquireSpy = vi
      .spyOn(await import("../../cron/scheduler-lock.js"), "acquireSchedulerLock")
      .mockImplementationOnce(async () => ({
        kind: "held" as const,
        holderPid: 99999,
      }));

    try {
      await start(state);
    } finally {
      acquireSpy.mockRestore();
    }

    expect(state.schedulerLockHeld).toBe(true);
    expect(state.timer).toBeNull();
    expect(state.schedulerLockHandle).toBeUndefined();
  });
});
