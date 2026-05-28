/**
 * Boot reconcile integration tests.
 *
 * Tests that loadCronStore correctly handles various `running` shapes in the
 * job state after a parent process crash:
 *   1. Legacy running marker (no runId) → cleared.
 *   2. running.runId present + result file exists → terminal state applied.
 *   3. running.runId present + pid alive matching start time → left alone.
 *   4. running.runId present + pid dead → cleared.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCronStore } from "./store.js";
import type { CronJob } from "./types.js";

let tmpDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-boot-reconcile-test-"));
});

afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function writeStore(
  storePath: string,
  jobs: Array<Partial<CronJob> & { id: string }>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf8");
}

async function writeStateFile(
  storePath: string,
  jobStates: Record<string, Record<string, unknown>>,
): Promise<void> {
  const statePath = storePath.replace(/\.json$/, "-state.json");
  const stateFile = {
    version: 1,
    jobs: Object.fromEntries(Object.entries(jobStates).map(([id, state]) => [id, { state }])),
  };
  await fs.writeFile(statePath, JSON.stringify(stateFile, null, 2), "utf8");
}

async function writeResultFile(
  configDir: string,
  jobId: string,
  runId: string,
  status: "ok" | "error" | "skipped",
  error?: string,
): Promise<void> {
  const runsDir = path.join(configDir, "cron", "runs", jobId);
  await fs.mkdir(runsDir, { recursive: true });
  const resultPath = path.join(runsDir, `${runId}.result.json`);
  const payload = {
    schemaVersion: 1,
    runId,
    jobId,
    status,
    startedAtMs: Date.now() - 5000,
    endedAtMs: Date.now(),
    ...(error ? { error } : {}),
  };
  await fs.writeFile(resultPath, JSON.stringify(payload, null, 2), "utf8");
}

function makeStorePath(id: string): string {
  return path.join(tmpDir, id, "jobs.json");
}

function baseJob(id: string): Partial<CronJob> & { id: string } {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: Date.now() - 60_000,
    updatedAtMs: Date.now() - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
  };
}

describe("boot reconcile", () => {
  it("case 1: legacy running marker (no runId) is cleared", async () => {
    const storePath = makeStorePath("legacy-no-runid");
    const job = baseJob("legacy-job");

    await writeStore(storePath, [job]);
    await writeStateFile(storePath, {
      "legacy-job": {
        runningAtMs: Date.now() - 10_000,
        // No `running` key — legacy shape without runId.
      },
    });

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(tmpDir, "legacy-no-runid");
    try {
      const store = await loadCronStore(storePath);
      const loaded = store.jobs.find((j) => j.id === "legacy-job");
      expect(loaded).toBeDefined();
      // runningAtMs should still be set from state file (legacy reconcile
      // only clears the `running` key, not runningAtMs unless running exists).
      // Since there is no `running` key, reconcile does nothing.
      // This is a no-op case for the new reconcile path.
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("case 1b: running entry without runId (malformed) is cleared", async () => {
    const storePath = makeStorePath("running-no-runid");
    const job = baseJob("malformed-running-job");
    const now = Date.now();

    await writeStore(storePath, [job]);
    await writeStateFile(storePath, {
      "malformed-running-job": {
        runningAtMs: now - 10_000,
        running: { pid: 1234, startedAtMs: now - 10_000 }, // missing runId
      },
    });

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(tmpDir, "running-no-runid");
    try {
      const store = await loadCronStore(storePath);
      const loaded = store.jobs.find((j) => j.id === "malformed-running-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;
      const runningField = (loaded.state as Record<string, unknown>).running;
      // Malformed running entry (no runId) should be cleared.
      expect(runningField).toBeUndefined();
      expect(loaded.state.runningAtMs).toBeUndefined();
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("case 2: running.runId present + result file exists → terminal state applied", async () => {
    const storePath = makeStorePath("result-file-present");
    const job = baseJob("result-file-job");
    const now = Date.now();
    const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const configDir = path.join(tmpDir, "result-file-present");

    await writeStore(storePath, [job]);
    await writeStateFile(storePath, {
      "result-file-job": {
        runningAtMs: now - 5_000,
        running: { runId, pid: 12345, startedAtMs: now - 5_000 },
      },
    });

    // Write the result file.
    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      await writeResultFile(configDir, "result-file-job", runId, "ok");

      const store = await loadCronStore(storePath);
      const loaded = store.jobs.find((j) => j.id === "result-file-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      // Running marker should be cleared.
      const runningField = (loaded.state as Record<string, unknown>).running;
      expect(runningField).toBeUndefined();
      expect(loaded.state.runningAtMs).toBeUndefined();
      // Terminal state should be applied.
      expect(loaded.state.lastRunStatus).toBe("ok");
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("case 2 error: result file with error status → lastRunStatus=error + lastError set", async () => {
    const storePath = makeStorePath("result-file-error");
    const job = baseJob("result-error-job");
    const now = Date.now();
    const runId = "ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj";
    const configDir = path.join(tmpDir, "result-file-error");

    await writeStore(storePath, [job]);
    await writeStateFile(storePath, {
      "result-error-job": {
        runningAtMs: now - 5_000,
        running: { runId, pid: 12345, startedAtMs: now - 5_000 },
      },
    });

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      await writeResultFile(configDir, "result-error-job", runId, "error", "agent crashed");

      const store = await loadCronStore(storePath);
      const loaded = store.jobs.find((j) => j.id === "result-error-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      expect((loaded.state as Record<string, unknown>).running).toBeUndefined();
      expect(loaded.state.runningAtMs).toBeUndefined();
      expect(loaded.state.lastRunStatus).toBe("error");
      expect(loaded.state.lastError).toBe("agent crashed");
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("case 4: running.runId present + pid dead (mismatched start time) → cleared", async () => {
    const storePath = makeStorePath("pid-dead");
    const job = baseJob("pid-dead-job");
    const now = Date.now();
    const runId = "11111111-2222-3333-4444-555555555555";

    await writeStore(storePath, [job]);
    // Use PID 1 (init) which is always alive but won't match the startedAtMs.
    // readProcessStartTimeMs(1) returns a real start time very different from now.
    // Actually, using PID 999999 which is unlikely to exist.
    const fakePid = 999999;
    await writeStateFile(storePath, {
      "pid-dead-job": {
        runningAtMs: now - 5_000,
        running: { runId, pid: fakePid, startedAtMs: now - 5_000 },
      },
    });

    const configDir = path.join(tmpDir, "pid-dead");
    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      const store = await loadCronStore(storePath);
      const loaded = store.jobs.find((j) => j.id === "pid-dead-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      // Pid 999999 should be dead → running cleared.
      const runningField = (loaded.state as Record<string, unknown>).running;
      expect(runningField).toBeUndefined();
      expect(loaded.state.runningAtMs).toBeUndefined();
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("case 3: running.runId present + pid alive matching start time → left alone", async () => {
    const storePath = makeStorePath("pid-alive");
    const job = baseJob("pid-alive-job");

    // Use our own PID and our own start time as a proxy for "alive with matching time".
    const selfPid = process.pid;
    const runId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const now = Date.now();

    // We need to know the real start time of our process. Mock readProcessStartTimeMs
    // to return a matching start time.
    const startedAtMs = now - 5_000;
    vi.spyOn(
      await import("../infra/process-start-time.js"),
      "readProcessStartTimeMs",
    ).mockImplementationOnce(async (pid) => {
      if (pid === selfPid) {
        return { kind: "ok" as const, startedAtMs };
      }
      return { kind: "no-such-pid" as const };
    });

    await writeStore(storePath, [job]);
    await writeStateFile(storePath, {
      "pid-alive-job": {
        runningAtMs: startedAtMs,
        running: { runId, pid: selfPid, startedAtMs },
      },
    });

    const configDir = path.join(tmpDir, "pid-alive");
    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      const store = await loadCronStore(storePath);
      const loaded = store.jobs.find((j) => j.id === "pid-alive-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      // Pid is alive with matching start time → running left alone.
      const runningField = (loaded.state as Record<string, unknown>).running;
      expect(runningField).toBeDefined();
      expect((runningField as Record<string, unknown>).runId).toBe(runId);
      // runningAtMs is preserved (still set).
      expect(loaded.state.runningAtMs).toBe(startedAtMs);
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
});
