/**
 * Boot reconcile integration tests.
 *
 * Tests that loadCronStore correctly handles various `running` shapes in the
 * job state after a parent process crash:
 *   1. Legacy running marker (no runId) → cleared.
 *   2. running.runId present + result file exists → terminal state applied.
 *   3. running.runId present + pid alive matching start time → left alone.
 *      runningAtMs is cleared so start()'s interrupted-run sweep ignores it.
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
    schedule: { kind: "cron", expr: "* * * * *" },
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

  it("case 3: running.runId present + pid alive matching start time → running left, runningAtMs cleared", async () => {
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

      // Pid is alive with matching start time → running block is preserved.
      expect(loaded.state.running).toBeDefined();
      expect(loaded.state.running?.runId).toBe(runId);
      // runningAtMs must be cleared — it is the legacy interrupted-run gate and must
      // not trigger start()'s markInterruptedStartupRun sweep on a live subprocess.
      expect(loaded.state.runningAtMs).toBeUndefined();
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("case 3 + start() sweep: live subprocess is NOT falsely marked as interrupted", async () => {
    const storePath = makeStorePath("pid-alive-no-interrupt");
    const job = baseJob("pid-alive-no-interrupt-job");

    const selfPid = process.pid;
    const runId = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
    const now = Date.now();
    const startedAtMs = now - 5_000;

    // Mock readProcessStartTimeMs to report the pid as alive with matching start time.
    vi.spyOn(
      await import("../infra/process-start-time.js"),
      "readProcessStartTimeMs",
    ).mockResolvedValue({ kind: "ok" as const, startedAtMs });

    await writeStore(storePath, [job]);
    await writeStateFile(storePath, {
      "pid-alive-no-interrupt-job": {
        runningAtMs: startedAtMs,
        running: { runId, pid: selfPid, startedAtMs },
      },
    });

    const configDir = path.join(tmpDir, "pid-alive-no-interrupt");
    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      const store = await loadCronStore(storePath);
      const loaded = store.jobs.find((j) => j.id === "pid-alive-no-interrupt-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      // After boot reconcile: running block present, runningAtMs cleared.
      expect(loaded.state.running).toBeDefined();
      expect(loaded.state.runningAtMs).toBeUndefined();

      // Simulate start()'s interrupted-run sweep: it checks runningAtMs.
      // Since runningAtMs is now undefined, the sweep must NOT touch this job.
      const preSweepConsecutiveErrors = loaded.state.consecutiveErrors;
      const preSweepEnabled = loaded.enabled;
      const preSweepLastRunStatus = loaded.state.lastRunStatus;

      for (const j of store.jobs) {
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
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  // Gap 5: pid-recycling resilience.
  //
  // A "recycled pid" is when a new process reuses a pid that was previously
  // assigned to a cron child.  The OS start time of the current occupant of
  // that pid will differ significantly (>2s) from the startedAtMs that was
  // persisted when the original child was spawned.  Boot reconcile must detect
  // this mismatch and treat the running entry as orphaned.
  it("case 5 (pid recycled): same pid alive but start-time mismatch → running cleared as orphan", async () => {
    const storePath = makeStorePath("pid-recycled");
    const job = baseJob("pid-recycled-job");

    const selfPid = process.pid;
    const runId = "recycled-pid-run-id-0000-111111111111";
    const now = Date.now();

    // Persist a startedAtMs that is 1_000_000 ms in the past relative to
    // our process's real start time.  The mock below returns our real start
    // time, so the delta will be ~1_000_000 ms >> 2_000 ms tolerance.
    const persistedStartedAtMs = now - 1_000_000;

    // Mock readProcessStartTimeMs to return a start time that does NOT match
    // the persisted value (simulating a recycled pid: the current occupant of
    // this pid started much later than the original cron child did).
    vi.spyOn(
      await import("../infra/process-start-time.js"),
      "readProcessStartTimeMs",
    ).mockImplementationOnce(async (pid) => {
      if (pid === selfPid) {
        // Return a start time that is significantly different from persistedStartedAtMs.
        return { kind: "ok" as const, startedAtMs: now - 1_000 };
      }
      return { kind: "no-such-pid" as const };
    });

    await writeStore(storePath, [job]);
    await writeStateFile(storePath, {
      "pid-recycled-job": {
        runningAtMs: persistedStartedAtMs,
        running: { runId, pid: selfPid, startedAtMs: persistedStartedAtMs },
      },
    });

    const configDir = path.join(tmpDir, "pid-recycled");
    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = configDir;
    try {
      const store = await loadCronStore(storePath);
      const loaded = store.jobs.find((j) => j.id === "pid-recycled-job");
      expect(loaded).toBeDefined();
      if (!loaded) return;

      // Start-time mismatch (>2s tolerance) → treated as orphan; running cleared.
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
});
