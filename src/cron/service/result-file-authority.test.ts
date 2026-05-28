/**
 * Gap 3 — Result-file authority cross-process tests.
 *
 * The §8 contract: "authoritative terminal record is a file on disk."
 * These tests exercise two scenarios:
 *
 *   A. Child writes result file with status "ok" then exits with code 1
 *      (parent never saw the marker). Parent must read the file as authoritative
 *      and return status "ok" — not "error" from the exit code.
 *
 *   B. Child exits 0 but writes NO result file AND NO stdout marker.
 *      Outcome must be status "error" with message "no terminal record".
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer.js";

const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let tmpDir = "";
let runsDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-result-authority-test-"));
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

function makeAtJob(id: string): CronJob {
  const now = Date.now();
  return {
    id,
    name: `test job ${id}`,
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "at", at: new Date(now + 3_600_000).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "result authority test" },
    state: { nextRunAtMs: now - 1, runningAtMs: now },
  };
}

async function createSubprocessState(params: { scriptPath: string }) {
  const storePath = makeStorePath();
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

describe("result-file authority: file beats exit code", () => {
  it("child writes ok result file then exits with code 1 — parent returns ok", async () => {
    const jobId = "authority-ok-file-nonzero-exit";
    const job = makeAtJob(jobId);

    // Child script: writes a result file with status "ok" then exits with code 1.
    // The marker also says "ok" so even marker-based fallback would yield ok.
    // The critical assertion is that the file (not exit code) is authoritative.
    const scriptPath = path.join(
      tmpDir,
      `fake-authority-ok-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
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
  endedAtMs: Date.now() + 10,
};

const dir = path.join(runsDir, jobId);
await fs.mkdir(dir, { recursive: true });
const filePath = path.join(dir, runId + ".result.json");
await fs.writeFile(filePath, JSON.stringify(resultPayload, null, 2), "utf8");

// Emit no stdout marker — parent gets no live marker at all.
// Exit with code 1 to simulate parent never seeing a clean exit.
process.exit(1);
`;
    await fs.writeFile(scriptPath, scriptContent, "utf8");

    const { state } = await createSubprocessState({ scriptPath });
    state.store!.jobs = [job];

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      const result = await executeJobCore(state, job);
      // File says "ok" — that is authoritative; exit code 1 is irrelevant.
      expect(result.status).toBe("ok");
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
});

describe("result-file authority: no terminal record", () => {
  it("child exits 0 with no result file and no stdout marker → error with no-terminal-record message", async () => {
    const jobId = "authority-no-file-no-marker";
    const job = makeAtJob(jobId);

    // Child script: writes nothing and exits 0.
    const scriptPath = path.join(
      tmpDir,
      `fake-authority-empty-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
    );
    const scriptContent = `
// No result file, no stdout marker.
process.exit(0);
`;
    await fs.writeFile(scriptPath, scriptContent, "utf8");

    const { state } = await createSubprocessState({ scriptPath });
    state.store!.jobs = [job];

    const originalConfigDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    try {
      const result = await executeJobCore(state, job);
      expect(result.status).toBe("error");
      // The §8 contract message for this case.
      expect(result.error).toBe("cron: subprocess exited without a terminal record");
    } finally {
      if (originalConfigDir !== undefined) {
        process.env.OPENCLAW_STATE_DIR = originalConfigDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
});
