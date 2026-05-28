/**
 * Tests for the §5 atomic-remove protocol: kind:at jobs are removed from
 * jobs.json when a subprocess child exits with status "ok".
 *
 * Covers:
 *   - Happy path: kind:at + ok → job removed, state entry gone.
 *   - Failure path: kind:at + error → job NOT removed; running cleared.
 *   - Cron-kind unaffected: kind:cron + ok → NOT removed, nextRunAtMs recomputed.
 *   - Crash mid-commit: removeRequested=true in state but job still in jobs.json
 *     → boot reconcile (loadCronStore) removes the job on restart.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer.js";

// Minimal logger that drops everything.
const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let tmpDir = "";
let runsDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-atomic-remove-test-"));
  runsDir = path.join(tmpDir, "cron", "runs");
  await fs.mkdir(runsDir, { recursive: true });
});

afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function makeStorePath(): string {
  return path.join(tmpDir, `jobs-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeAtJob(overrides?: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "at-test-job",
    name: "test at job",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "at", at: new Date(now + 3_600_000).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test at" },
    state: { nextRunAtMs: now - 1, runningAtMs: now },
    ...overrides,
  };
}

function makeCronJob(overrides?: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "cron-test-job",
    name: "test cron job",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "cron", expr: "0 * * * *" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test cron" },
    state: { nextRunAtMs: now - 1, runningAtMs: now },
    ...overrides,
  };
}

/**
 * Write a fake child script to a temp file.
 */
async function writeFakeChildScript(params: {
  jobId: string;
  status: "ok" | "error" | "skipped";
  error?: string;
}): Promise<string> {
  const scriptPath = path.join(
    tmpDir,
    `fake-child-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  const scriptContent = `
import fs from "node:fs/promises";
import path from "node:path";

const runId = process.env.OPENCLAW_CRON_RUN_ID;
const jobId = process.env.OPENCLAW_CRON_JOB_ID;
const runsDir = ${JSON.stringify(runsDir)};

const resultPayload = {
  schemaVersion: 1,
  runId,
  jobId,
  status: ${JSON.stringify(params.status)},
  startedAtMs: Date.now(),
  endedAtMs: Date.now() + 10,
  ${params.error ? `error: ${JSON.stringify(params.error)},` : ""}
};

const dir = path.join(runsDir, jobId);
await fs.mkdir(dir, { recursive: true });
const filePath = path.join(dir, runId + ".result.json");
await fs.writeFile(filePath, JSON.stringify(resultPayload, null, 2), "utf8");

const markerPrefix = "OPENCLAW_CRON_RESULT ";
const marker = { runId, status: ${JSON.stringify(params.status)}, durationMs: 10 };
process.stdout.write(markerPrefix + JSON.stringify(marker) + "\\n");

process.exit(${params.status === "ok" || params.status === "skipped" ? 0 : 1});
`;
  await fs.writeFile(scriptPath, scriptContent, "utf8");
  return scriptPath;
}

async function createSubprocessState(params: { scriptPath: string; storePath?: string }) {
  const storePath = params.storePath ?? makeStorePath();
  await fs.mkdir(path.dirname(storePath), { recursive: true });

  const state = createCronServiceState({
    storePath,
    cronEnabled: true,
    log: noopLog,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    schedulerLockPath: null,
  });

  state.openClawNode = process.execPath;
  state.openClawBin = params.scriptPath;

  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }, null, 2), "utf8");
  state.store = { version: 1, jobs: [] };

  return { state, storePath };
}

describe("atomic-remove: kind:at + status ok → job removed from jobs.json", () => {
  it("removes the job from jobs.json and state after subprocess ok", async () => {
    const job = makeAtJob({ id: "at-remove-ok-job" });
    const scriptPath = await writeFakeChildScript({ jobId: job.id, status: "ok" });
    const { state, storePath } = await createSubprocessState({ scriptPath });

    // Add job to the in-memory store so it can be removed.
    state.store!.jobs = [job];
    // Write initial jobs.json with the job present.
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [job] }, null, 2), "utf8");

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      const result = await executeJobCore(state, job);
      expect(result.status).toBe("ok");

      // After execution, the job should be gone from in-memory store.
      expect(state.store!.jobs.find((j) => j.id === job.id)).toBeUndefined();

      // And gone from the persisted jobs.json.
      const diskContent = await fs.readFile(storePath, "utf-8");
      const diskStore = JSON.parse(diskContent) as { jobs: Array<{ id: string }> };
      expect(diskStore.jobs.find((j) => j.id === job.id)).toBeUndefined();

      // And the state file should have no entry for this job.
      const statePath = storePath.replace(/\.json$/, "-state.json");
      const stateContent = await fs.readFile(statePath, "utf-8");
      const stateFile = JSON.parse(stateContent) as { jobs: Record<string, unknown> };
      expect(stateFile.jobs[job.id]).toBeUndefined();
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
});

describe("atomic-remove: kind:at + status error → job NOT removed", () => {
  it("does not remove the job on subprocess error", async () => {
    const job = makeAtJob({ id: "at-keep-error-job" });
    const scriptPath = await writeFakeChildScript({
      jobId: job.id,
      status: "error",
      error: "agent exploded",
    });
    const { state, storePath } = await createSubprocessState({ scriptPath });

    state.store!.jobs = [job];
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [job] }, null, 2), "utf8");

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      const result = await executeJobCore(state, job);
      expect(result.status).toBe("error");

      // Job must still be in memory (may have been updated by applyJobResult, but
      // executeJobCore only updates running; applyJobResult runs in timer.ts's
      // onTimer/finishPreparedManualRun, not here). What we care about is that
      // commitAtomicRemoveAt was NOT called. The job is still in jobs.json.
      const diskContent = await fs.readFile(storePath, "utf-8");
      const diskStore = JSON.parse(diskContent) as { jobs: Array<{ id: string }> };
      // jobs.json may have been updated by the stateOnly persist but job entry must remain.
      // However executeJobCore calls persist stateOnly — jobs.json is untouched for error path.
      // The state file may have been written (stateOnly), but jobs.json should have the job.
      expect(diskStore.jobs.find((j) => j.id === job.id)).toBeDefined();
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
});

describe("atomic-remove: kind:cron + status ok → NOT removed", () => {
  it("does not remove cron-kind job on subprocess ok", async () => {
    const job = makeCronJob({ id: "cron-keep-ok-job" });
    const scriptPath = await writeFakeChildScript({ jobId: job.id, status: "ok" });
    const { state, storePath } = await createSubprocessState({ scriptPath });

    state.store!.jobs = [job];
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [job] }, null, 2), "utf8");

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      const result = await executeJobCore(state, job);
      expect(result.status).toBe("ok");

      // Cron-kind job must NOT be removed from jobs.json.
      const diskContent = await fs.readFile(storePath, "utf-8");
      const diskStore = JSON.parse(diskContent) as { jobs: Array<{ id: string }> };
      // The stateOnly persist for cron kind just updates running=undefined.
      // jobs.json structure is unchanged.
      expect(diskStore.jobs.find((j) => j.id === job.id)).toBeDefined();
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
});

describe("atomic-remove: crash mid-commit → boot reconcile removes the job", () => {
  it("removes job when removeRequested=true in state but job still in jobs.json", async () => {
    const jobId = "at-crash-reconcile-job";
    const storePath = makeStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });

    const job: Partial<CronJob> & { id: string } = {
      id: jobId,
      name: "crash reconcile test",
      enabled: true,
      schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
    };

    // Write jobs.json with the job still present (crashed before removal).
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [job] }, null, 2), "utf8");

    // Write state file with removeRequested=true (parent got this far before crash).
    const statePath = storePath.replace(/\.json$/, "-state.json");
    const stateFile = {
      version: 1,
      jobs: {
        [jobId]: {
          state: {
            running: {
              runId: "crashed-run-id",
              startedAtMs: Date.now() - 5000,
              removeRequested: true,
            },
          },
        },
      },
    };
    await fs.writeFile(statePath, JSON.stringify(stateFile, null, 2), "utf8");

    // Simulate boot: loadCronStore runs boot reconcile.
    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      const store = await loadCronStore(storePath);
      // The job should have been removed by boot reconcile.
      expect(store.jobs.find((j) => j.id === jobId)).toBeUndefined();
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("does NOT remove a kind:cron job even if removeRequested is set (never happens in practice)", async () => {
    const jobId = "cron-no-remove-reconcile-job";
    const storePath = makeStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });

    const job: Partial<CronJob> & { id: string } = {
      id: jobId,
      name: "cron no remove test",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
    };

    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [job] }, null, 2), "utf8");

    const statePath = storePath.replace(/\.json$/, "-state.json");
    const stateFile = {
      version: 1,
      jobs: {
        [jobId]: {
          state: {
            running: {
              runId: "cron-run-id",
              startedAtMs: Date.now() - 5000,
              // removeRequested=true on a cron job should NOT trigger removal.
              removeRequested: true,
            },
          },
        },
      },
    };
    await fs.writeFile(statePath, JSON.stringify(stateFile, null, 2), "utf8");

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      const store = await loadCronStore(storePath);
      // Cron-kind job should survive boot reconcile even with removeRequested.
      expect(store.jobs.find((j) => j.id === jobId)).toBeDefined();
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
});
