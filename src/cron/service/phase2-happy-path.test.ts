/**
 * Gap 6 — Phase 2 end-to-end happy-path integration test.
 *
 * A single high-value test that walks the entire Phase 2 subprocess flow:
 *
 *   1. Create a CronServiceState with the subprocess pathway active (fake
 *      bin script that writes a result file and exits 0).
 *   2. Add a kind:at job via ops.add() with nextRunAtMs of now-1 (immediately due).
 *   3. Call runMissedJobs() to execute the job.
 *   4. Wait for the fake child to exit (runMissedJobs awaits it).
 *   5. Assert: job is REMOVED from jobs.json (§5 commit protocol), terminal
 *      status is "ok", no orphaned running state.
 *
 * If any future change breaks the §5 atomic-remove commit protocol, this test
 * catches it.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCronStore } from "../store.js";
import { add } from "./ops.js";
import { createCronServiceState } from "./state.js";
import { runMissedJobs } from "./timer.js";

const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let tmpDir = "";
let runsDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-phase2-happy-path-test-"));
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

describe("Phase 2 happy path: runMissedJobs → subprocess → §5 commit protocol", () => {
  it("kind:at job is removed from jobs.json after subprocess ok via runMissedJobs", async () => {
    const storePath = makeStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });

    // Fake child script: writes a valid result file with status "ok" and exits 0.
    const scriptPath = path.join(
      tmpDir,
      `fake-e2e-child-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
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
  status: "ok",
  startedAtMs: Date.now(),
  endedAtMs: Date.now() + 5,
};

const dir = path.join(runsDir, jobId);
await fs.mkdir(dir, { recursive: true });
const filePath = path.join(dir, runId + ".result.json");
await fs.writeFile(filePath, JSON.stringify(resultPayload, null, 2), "utf8");

const marker = { runId, status: "ok", durationMs: 5 };
process.stdout.write("OPENCLAW_CRON_RESULT " + JSON.stringify(marker) + "\\n");
process.exit(0);
`;
    await fs.writeFile(scriptPath, scriptContent, "utf8");

    const now = Date.now();
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: noopLog,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      schedulerLockPath: null,
    });

    state.openClawNode = process.execPath;
    state.openClawBin = scriptPath;

    // Initialise the empty store on disk.
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }, null, 2), "utf8");
    state.store = { version: 1, jobs: [] };

    // Add a kind:at job that is immediately due (fireAt in the past).
    const job = await add(state, {
      name: "e2e-at-job",
      enabled: true,
      deleteAfterRun: true,
      schedule: { kind: "at", at: new Date(now - 1).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "e2e test run" },
    });
    // Clear the timer armed by add() — we drive execution manually.
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    expect(job.id).toBeTruthy();

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      // Drive the scheduler: runMissedJobs executes the job in subprocess and
      // applies the §5 commit protocol (remove kind:at job on ok).
      await runMissedJobs(state);
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      // Assert: job is GONE from in-memory store.
      expect(state.store?.jobs.find((j) => j.id === job.id)).toBeUndefined();

      // Assert: job is GONE from disk (§5 commit persisted the removal).
      const diskStore = await loadCronStore(storePath);
      expect(diskStore.jobs.find((j) => j.id === job.id)).toBeUndefined();

      // Assert: no orphaned running state entry in the state sidecar.
      const statePath = storePath.replace(/\.json$/, "-state.json");
      let stateFileJobs: Record<string, unknown> = {};
      try {
        const stateRaw = await fs.readFile(statePath, "utf-8");
        const parsed = JSON.parse(stateRaw) as { jobs?: Record<string, unknown> };
        stateFileJobs = parsed.jobs ?? {};
      } catch {
        // State file may not exist if the removal was clean — that is fine.
      }
      expect(stateFileJobs[job.id]).toBeUndefined();
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  }, 15_000);
});
