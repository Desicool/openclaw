import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { loadCronStore, saveCronStore } from "./store.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-issue-35195-" });

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

describe("cron backup timing for edit", () => {
  it("updates SQLite cron jobs without creating a legacy migration archive", async () => {
    const store = await makeStorePath();
    const base = Date.now();

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        {
          id: "job-35195",
          name: "job-35195",
          enabled: true,
          createdAtMs: base,
          updatedAtMs: base,
          schedule: { kind: "cron", expr: "* * * * *" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "hello" },
          state: {},
        },
      ],
    });

    const service = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    try {
      await service.start();

      await service.update("job-35195", {
        payload: { kind: "agentTurn", message: "edited" },
      });

      expect(await pathExists(`${store.storePath}.migrated`)).toBe(false);
      const persistedAfterEdit = await loadCronStore(store.storePath);
      expect(persistedAfterEdit.jobs[0]?.payload).toEqual({
        kind: "agentTurn",
        message: "edited",
      });
    } finally {
      service.stop();
      await store.cleanup();
    }
  });
});
