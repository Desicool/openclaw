/**
 * Integration tests for the subprocess execution path in executeDetachedCronJob.
 * Uses a small fake child script that writes a result file and exits.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCronServiceState } from "../../cron/service/state.js";
import type { CronSubprocessEntry } from "../../cron/service/state.js";
import { executeJobCore, runMissedJobs } from "../../cron/service/timer.js";
import type { CronJob } from "../../cron/types.js";

// Minimal logger that drops everything.
const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let tmpDir = "";
// runsDir = <tmpDir>/cron/runs, matching resolveConfigDir()/cron/runs when OPENCLAW_STATE_DIR=tmpDir
let runsDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-subprocess-spawn-test-"));
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
  // Subprocess tests use real timers (real setTimeout for abort, real process
  // spawn). Ensure a previous --isolate=false test file's fake-timer state
  // does not bleed in and prevent the abort-controller timer from firing.
  vi.useRealTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function makeStorePath(): string {
  return path.join(tmpDir, `jobs-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeIsolatedAgentJob(overrides?: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "test-job-subprocess",
    name: "test subprocess job",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test subprocess" },
    state: { nextRunAtMs: now - 1, runningAtMs: now },
    ...overrides,
  };
}

/**
 * Write a fake child script to a temp file that:
 *  1. Writes a valid result file to the runs directory.
 *  2. Emits a stdout marker line.
 *  3. Exits 0 for ok/skipped, 1 for error.
 */
async function writeFakeChildScript(params: {
  jobId: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  exitCode?: number;
  omitResultFile?: boolean;
}): Promise<string> {
  const scriptPath = path.join(
    tmpDir,
    `fake-child-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );

  const resultPayload = JSON.stringify({
    schemaVersion: 1,
    runId: process.env.OPENCLAW_CRON_RUN_ID ?? "unknown-run-id",
    jobId: params.jobId,
    status: params.status,
    startedAtMs: Date.now(),
    endedAtMs: Date.now() + 10,
    ...(params.error ? { error: params.error } : {}),
  });

  const markerPayload = JSON.stringify({
    runId: process.env.OPENCLAW_CRON_RUN_ID ?? "unknown-run-id",
    status: params.status,
    durationMs: 10,
  });

  const omitFile = params.omitResultFile === true;

  const scriptContent = `
import fs from "node:fs/promises";
import path from "node:path";

const runId = process.env.OPENCLAW_CRON_RUN_ID;
const jobId = process.env.OPENCLAW_CRON_JOB_ID;
const runsDir = ${JSON.stringify(runsDir)};
const omitFile = ${omitFile};

const resultPayload = {
  schemaVersion: 1,
  runId,
  jobId,
  status: ${JSON.stringify(params.status)},
  startedAtMs: Date.now(),
  endedAtMs: Date.now() + 10,
  ${params.error ? `error: ${JSON.stringify(params.error)},` : ""}
};

if (!omitFile) {
  const dir = path.join(runsDir, jobId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, runId + ".result.json");
  await fs.writeFile(filePath, JSON.stringify(resultPayload, null, 2), "utf8");
}

// Emit stdout marker.
const markerPrefix = "OPENCLAW_CRON_RESULT ";
const marker = { runId, status: ${JSON.stringify(params.status)}, durationMs: 10 };
process.stdout.write(markerPrefix + JSON.stringify(marker) + "\\n");

process.exit(${params.exitCode ?? (params.status === "ok" || params.status === "skipped" ? 0 : 1)});
`;

  await fs.writeFile(scriptPath, scriptContent, "utf8");
  return scriptPath;
}

/**
 * Create a state with subprocess mode enabled, pointing to a real script.
 */
async function createSubprocessState(params: {
  scriptPath: string;
  storePath?: string;
  configDir?: string;
}) {
  const storePath = params.storePath ?? makeStorePath();
  await fs.mkdir(path.dirname(storePath), { recursive: true });

  const state = createCronServiceState({
    storePath,
    cronEnabled: true,
    log: noopLog,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });

  state.openClawNode = process.execPath;
  // The "bin" is our fake script. We pass it as argv[1] equivalent.
  state.openClawBin = params.scriptPath;

  // Store an empty jobs file so persist can work.
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }, null, 2), "utf8");
  state.store = { version: 1, jobs: [] };

  return { state, storePath };
}

describe("executeJobCore subprocess spawn", () => {
  it("ok-status path: spawns child, reads result file, returns ok", async () => {
    const job = makeIsolatedAgentJob({ id: "sub-ok-job" });
    const scriptPath = await writeFakeChildScript({
      jobId: job.id,
      status: "ok",
    });
    const { state } = await createSubprocessState({ scriptPath });

    // Override configDir by pointing runsDir via env.
    // The subprocess function uses resolveConfigDir() which reads process.env.OPENCLAW_STATE_DIR.
    // For this test, we write the result file in the script to our tmpDir/runs.
    // But executeJobInSubprocess reads from resolveConfigDir()/cron/runs.
    // We need to point OPENCLAW_STATE_DIR to our tmpDir so the result is found.
    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      const result = await executeJobCore(state, job);
      expect(result.status).toBe("ok");
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("error-status path: spawns child, reads result file, returns error", async () => {
    const job = makeIsolatedAgentJob({ id: "sub-error-job" });
    const scriptPath = await writeFakeChildScript({
      jobId: job.id,
      status: "error",
      error: "agent run failed",
    });
    const { state } = await createSubprocessState({ scriptPath });

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      const result = await executeJobCore(state, job);
      expect(result.status).toBe("error");
      expect(result.error).toBe("agent run failed");
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("skipped-status path: spawns child, reads result file, returns skipped", async () => {
    const job = makeIsolatedAgentJob({ id: "sub-skipped-job" });
    const scriptPath = await writeFakeChildScript({
      jobId: job.id,
      status: "skipped",
    });
    const { state } = await createSubprocessState({ scriptPath });

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      const result = await executeJobCore(state, job);
      expect(result.status).toBe("skipped");
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("missing result file → falls back to marker, then error if no marker", async () => {
    const job = makeIsolatedAgentJob({ id: "sub-no-file-job" });
    const scriptPath = await writeFakeChildScript({
      jobId: job.id,
      status: "error",
      omitResultFile: true,
    });
    const { state } = await createSubprocessState({ scriptPath });

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      const result = await executeJobCore(state, job);
      // Marker says "error", so result should be error (from marker fallback).
      expect(result.status).toBe("error");
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("parent abort (SIGTERM) sends SIGTERM to child and eventually resolves", async () => {
    // Script that sleeps for 30s — we'll abort it.
    const scriptPath = path.join(tmpDir, `fake-sleep-${Date.now()}.mjs`);
    await fs.writeFile(
      scriptPath,
      `
import { setTimeout as sleep } from "node:timers/promises";
await sleep(30_000);
`,
      "utf8",
    );

    const job = makeIsolatedAgentJob({ id: "sub-abort-job" });
    const { state } = await createSubprocessState({ scriptPath });

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const abortController = new AbortController();

    // Abort quickly.
    const abortTimer = setTimeout(() => abortController.abort("test-timeout"), 200);

    try {
      const result = await executeJobCore(state, job, abortController.signal, undefined);
      // After abort, result should be error (no result file was written by sleep script).
      expect(result.status).toBe("error");
    } finally {
      clearTimeout(abortTimer);
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  }, 15_000);
});

describe("executeJobCore inline fallback (no subprocess paths)", () => {
  it("falls back to runIsolatedAgentJob when openClawNode/openClawBin are not set", async () => {
    const storePath = makeStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }, null, 2), "utf8");

    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "inline ran",
    }));

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: noopLog,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    state.store = { version: 1, jobs: [] };

    // No openClawNode/openClawBin set → inline path.
    const job = makeIsolatedAgentJob({ id: "inline-fallback-job" });
    const result = await executeJobCore(state, job);

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
  });
});

describe("skip-on-collision: missedCount and lastMissedAtMs", () => {
  it("increments missedCount and sets lastMissedAtMs when child is still alive in pidTable", async () => {
    const storePath = makeStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }, null, 2), "utf8");

    const now = Date.now();
    const job = makeIsolatedAgentJob({
      id: "collision-miss-job",
      state: { nextRunAtMs: now - 1 },
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: noopLog,
      schedulerLockPath: null,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    state.store = { version: 1, jobs: [job] };

    // Simulate an alive child in the pidTable (exitCode === null means still running).
    const fakeChild = {
      exitCode: null,
      pid: 99999,
      kill: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      stdout: null,
    } as unknown as import("node:child_process").ChildProcess;

    const entry: CronSubprocessEntry = {
      pid: 99999,
      runId: "fake-run-id",
      startedAtMs: now - 10_000,
      child: fakeChild,
    };
    state.pidTable.set(job.id, entry);

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    try {
      // runMissedJobs calls collectRunnableJobs → isRunnableJob, which detects
      // the collision and records the miss on job.state.
      await runMissedJobs(state);

      expect(job.state.missedCount).toBe(1);
      expect(typeof job.state.lastMissedAtMs).toBe("number");
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
});
