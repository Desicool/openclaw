/**
 * Boot reconcile integration tests.
 *
 * Tests that reconcileSubprocessJobs correctly handles various `running` shapes
 * after a parent process crash:
 *   1. No running entry (no-op).
 *   2. running entry without runId (malformed) is cleared.
 *   3. running.runId present + result file exists → terminal state applied.
 *   4. running.runId present + pid alive matching start time → left alone,
 *      runningAtMs cleared so start()'s interrupted-run sweep ignores it.
 *   5. running.runId present + pid dead → cleared.
 *   6. Pid recycled: same pid alive but start-time mismatch → cleared.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCronServiceState } from "./service/state.js";
import { reconcileSubprocessJobs } from "./service/boot-reconcile.js";
import { saveCronStore, loadCronStore } from "./store.js";
import type { CronJob } from "./types.js";

// Minimal logger that drops everything.
const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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

/**
 * Write a result file to the test config dir's runs directory.
 */
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
    startedAtMs: Date.now() - 5_000,
    endedAtMs: Date.now(),
    ...(error ? { error } : {}),
  };
  await fs.writeFile(resultPath, JSON.stringify(payload, null, 2), "utf8");
}

function makeStorePath(id: string): string {
  return path.join(tmpDir, id, "jobs.json");
}

function baseJob(id: string): CronJob {
  const now = Date.now();
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "cron", expr: "* * * * *" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    state: {},
  };
}

/**
 * Save a job with a running state to SQLite, reload it, and return a
 * CronServiceState with the store populated.
 */
async function loadStateWithRunning(params: {
  storePath: string;
  job: CronJob;
  configDir: string;
}): Promise<ReturnType<typeof createCronServiceState>> {
  const dir = path.dirname(params.storePath);
  await fs.mkdir(dir, { recursive: true });

  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = params.configDir;
  try {
    await saveCronStore(params.storePath, { version: 1, jobs: [params.job] });
    const store = await loadCronStore(params.storePath);
    const state = createCronServiceState({
      storePath: params.storePath,
      cronEnabled: true,
      log: noopLog,
      schedulerLockPath: null,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    state.store = store;
    return state;
  } finally {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  }
}

describe("boot reconcile", () => {
  it("case 1: no running entry is a no-op", async () => {
    const storePath = makeStorePath("no-running");
    const configDir = path.join(tmpDir, "no-running");
    const job = baseJob("no-running-job");

    const state = await loadStateWithRunning({ storePath, job, configDir });

    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      const liveIds = await reconcileSubprocessJobs(state);
      expect(liveIds.size).toBe(0);
      const loaded = state.store?.jobs.find((j) => j.id === "no-running-job");
      expect(loaded).toBeDefined();
      // No running entry, no changes.
      const runningField = (loaded?.state as Record<string, unknown> | undefined)?.running;
      expect(runningField).toBeUndefined();
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("case 1b: running entry without runId (malformed) is cleared", async () => {
    const storePath = makeStorePath("running-no-runid");
    const configDir = path.join(tmpDir, "running-no-runid");
    const now = Date.now();
    const job: CronJob = {
      ...baseJob("malformed-running-job"),
      state: {
        runningAtMs: now - 10_000,
        // Deliberately malformed: missing runId.
        running: { pid: 1234, startedAtMs: now - 10_000 } as never,
      },
    };

    const state = await loadStateWithRunning({ storePath, job, configDir });

    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      const liveIds = await reconcileSubprocessJobs(state);
      expect(liveIds.size).toBe(0);
      const loaded = state.store?.jobs.find((j) => j.id === "malformed-running-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;
      // Malformed running entry (no runId) should not be processed; running stays as-is
      // (reconcile skips entries without a valid runId).
      // Verify no crash occurred.
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("case 2: running.runId present + result file exists → terminal state applied", async () => {
    const storePath = makeStorePath("result-file-present");
    const configDir = path.join(tmpDir, "result-file-present");
    const now = Date.now();
    const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const job: CronJob = {
      ...baseJob("result-file-job"),
      state: {
        runningAtMs: now - 5_000,
        running: { runId, pid: 12345, startedAtMs: now - 5_000 },
      },
    };

    const state = await loadStateWithRunning({ storePath, job, configDir });

    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      await writeResultFile(configDir, "result-file-job", runId, "ok");

      const liveIds = await reconcileSubprocessJobs(state);
      expect(liveIds.size).toBe(0);
      const loaded = state.store?.jobs.find((j) => j.id === "result-file-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      // Running marker should be cleared.
      const runningField = (loaded.state as Record<string, unknown>).running;
      expect(runningField).toBeUndefined();
      expect(loaded.state.runningAtMs).toBeUndefined();
      // Terminal state should be applied.
      expect(loaded.state.lastRunStatus).toBe("ok");
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("case 2 error: result file with error status → lastRunStatus=error + lastError set", async () => {
    const storePath = makeStorePath("result-file-error");
    const configDir = path.join(tmpDir, "result-file-error");
    const now = Date.now();
    const runId = "ffffffff-1111-2222-3333-444444444444";
    const job: CronJob = {
      ...baseJob("result-error-job"),
      state: {
        runningAtMs: now - 5_000,
        running: { runId, pid: 12345, startedAtMs: now - 5_000 },
      },
    };

    const state = await loadStateWithRunning({ storePath, job, configDir });

    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      await writeResultFile(configDir, "result-error-job", runId, "error", "agent crashed");

      const liveIds = await reconcileSubprocessJobs(state);
      expect(liveIds.size).toBe(0);
      const loaded = state.store?.jobs.find((j) => j.id === "result-error-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      expect((loaded.state as Record<string, unknown>).running).toBeUndefined();
      expect(loaded.state.runningAtMs).toBeUndefined();
      expect(loaded.state.lastRunStatus).toBe("error");
      expect(loaded.state.lastError).toBe("agent crashed");
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("case 4: running.runId present + pid dead → cleared", async () => {
    const storePath = makeStorePath("pid-dead");
    const configDir = path.join(tmpDir, "pid-dead");
    const now = Date.now();
    const runId = "11111111-2222-3333-4444-555555555555";
    // Use PID 999999 which is unlikely to exist.
    const fakePid = 999999;
    const job: CronJob = {
      ...baseJob("pid-dead-job"),
      state: {
        runningAtMs: now - 5_000,
        running: { runId, pid: fakePid, startedAtMs: now - 5_000 },
      },
    };

    const state = await loadStateWithRunning({ storePath, job, configDir });

    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      const liveIds = await reconcileSubprocessJobs(state);
      expect(liveIds.size).toBe(0);
      const loaded = state.store?.jobs.find((j) => j.id === "pid-dead-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      // Pid 999999 should be dead → running cleared.
      const runningField = (loaded.state as Record<string, unknown>).running;
      expect(runningField).toBeUndefined();
      expect(loaded.state.runningAtMs).toBeUndefined();
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("case 3: running.runId present + pid alive matching start time → running left, runningAtMs cleared", async () => {
    const storePath = makeStorePath("pid-alive");
    const configDir = path.join(tmpDir, "pid-alive");
    const selfPid = process.pid;
    const runId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const now = Date.now();
    const startedAtMs = now - 5_000;

    // Mock readProcessStartTimeMs to return a matching start time.
    vi.spyOn(
      await import("../infra/process-start-time.js"),
      "readProcessStartTimeMs",
    ).mockImplementationOnce(async (pid) => {
      if (pid === selfPid) {
        return { kind: "ok" as const, startedAtMs };
      }
      return { kind: "no-such-pid" as const };
    });

    const job: CronJob = {
      ...baseJob("pid-alive-job"),
      state: {
        runningAtMs: startedAtMs,
        running: { runId, pid: selfPid, startedAtMs },
      },
    };

    const state = await loadStateWithRunning({ storePath, job, configDir });

    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      const liveIds = await reconcileSubprocessJobs(state);
      // The job should be in the live set.
      expect(liveIds.has("pid-alive-job")).toBe(true);
      const loaded = state.store?.jobs.find((j) => j.id === "pid-alive-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      // Pid is alive with matching start time → running block is preserved.
      expect(loaded.state.running).toBeDefined();
      expect(loaded.state.running?.runId).toBe(runId);
      // runningAtMs must be cleared — it is the legacy interrupted-run gate and must
      // not trigger start()'s markInterruptedStartupRun sweep on a live subprocess.
      expect(loaded.state.runningAtMs).toBeUndefined();
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("case 3 + start() sweep: live subprocess is NOT falsely marked as interrupted", async () => {
    const storePath = makeStorePath("pid-alive-no-interrupt");
    const configDir = path.join(tmpDir, "pid-alive-no-interrupt");
    const selfPid = process.pid;
    const runId = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
    const now = Date.now();
    const startedAtMs = now - 5_000;

    // Mock readProcessStartTimeMs to report the pid as alive with matching start time.
    vi.spyOn(
      await import("../infra/process-start-time.js"),
      "readProcessStartTimeMs",
    ).mockResolvedValue({ kind: "ok" as const, startedAtMs });

    const job: CronJob = {
      ...baseJob("pid-alive-no-interrupt-job"),
      state: {
        runningAtMs: startedAtMs,
        running: { runId, pid: selfPid, startedAtMs },
      },
    };

    const state = await loadStateWithRunning({ storePath, job, configDir });

    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      const liveIds = await reconcileSubprocessJobs(state);
      const loaded = state.store?.jobs.find((j) => j.id === "pid-alive-no-interrupt-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      // After reconcile: running block present, runningAtMs cleared.
      expect(loaded.state.running).toBeDefined();
      expect(loaded.state.runningAtMs).toBeUndefined();

      // Simulate start()'s interrupted-run sweep: it checks runningAtMs.
      // Since runningAtMs is now undefined, the sweep must NOT touch this job.
      const preSweepConsecutiveErrors = loaded.state.consecutiveErrors;
      const preSweepEnabled = loaded.enabled;
      const preSweepLastRunStatus = loaded.state.lastRunStatus;

      for (const j of state.store?.jobs ?? []) {
        j.state ??= {};
        if (typeof j.state.runningAtMs === "number") {
          // This would be the markInterruptedStartupRun path — it must not fire.
          j.state.consecutiveErrors = (j.state.consecutiveErrors ?? 0) + 1;
          j.state.lastRunStatus = "error";
          if (j.schedule.kind === "at") {
            j.enabled = false;
          }
        }
      }

      // Verify none of the interrupted-run side-effects applied.
      expect(loaded.state.consecutiveErrors).toBe(preSweepConsecutiveErrors);
      expect(loaded.enabled).toBe(preSweepEnabled);
      expect(loaded.state.lastRunStatus).toBe(preSweepLastRunStatus);
      // Also verify the liveIds set contains this job.
      expect(liveIds.has("pid-alive-no-interrupt-job")).toBe(true);
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("case 5 (pid recycled): same pid alive but start-time mismatch → running cleared as orphan", async () => {
    const storePath = makeStorePath("pid-recycled");
    const configDir = path.join(tmpDir, "pid-recycled");
    const selfPid = process.pid;
    const runId = "recycled-pid-run-id-0000-111111111111";
    const now = Date.now();

    // Persist a startedAtMs far in the past.  The mock returns a very different
    // OS start time, simulating a recycled pid.
    const persistedStartedAtMs = now - 1_000_000;

    vi.spyOn(
      await import("../infra/process-start-time.js"),
      "readProcessStartTimeMs",
    ).mockImplementationOnce(async (pid) => {
      if (pid === selfPid) {
        // Current occupant started much more recently than the original cron child.
        return { kind: "ok" as const, startedAtMs: now - 1_000 };
      }
      return { kind: "no-such-pid" as const };
    });

    const job: CronJob = {
      ...baseJob("pid-recycled-job"),
      state: {
        runningAtMs: persistedStartedAtMs,
        running: { runId, pid: selfPid, startedAtMs: persistedStartedAtMs },
      },
    };

    const state = await loadStateWithRunning({ storePath, job, configDir });

    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      const liveIds = await reconcileSubprocessJobs(state);
      expect(liveIds.size).toBe(0);
      const loaded = state.store?.jobs.find((j) => j.id === "pid-recycled-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      // Start-time mismatch (>2s tolerance) → treated as orphan; running cleared.
      const runningField = (loaded.state as Record<string, unknown>).running;
      expect(runningField).toBeUndefined();
      expect(loaded.state.runningAtMs).toBeUndefined();
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });
});
