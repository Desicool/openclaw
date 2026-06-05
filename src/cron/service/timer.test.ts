import { afterEach, describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState } from "../../cron/service/state.js";
import { executeJobCore, onTimer } from "../../cron/service/timer.js";
import { loadCronStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import * as detachedTaskRuntime from "../../tasks/detached-task-runtime.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { formatTaskStatusDetail } from "../../tasks/task-status.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-timer-seam",
});

function createDueIsolatedJob(params: {
  now: number;
  wakeMode?: CronJob["wakeMode"];
  id?: string;
  name?: string;
  agentId?: string;
  message?: string;
  sessionKey?: string;
}): CronJob {
  return {
    id: params.id ?? "isolated-cron-job",
    agentId: params.agentId,
    name: params.name ?? params.id ?? "isolated cron job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "cron", expr: "* * * * *" },
    sessionTarget: "isolated",
    wakeMode: params.wakeMode ?? "now",
    payload: { kind: "agentTurn", message: params.message ?? "run isolated cron" },
    sessionKey: params.sessionKey,
    state: { nextRunAtMs: params.now - 1 },
  };
}

function createDueIsolatedAgentJob(params: { now: number }): CronJob {
  return createDueIsolatedJob({
    now: params.now,
    id: "isolated-agent-job",
    agentId: "finn",
    message: "run isolated cron",
  });
}

afterEach(() => {
  resetTaskRegistryForTests();
});

describe("cron service timer seam coverage", () => {
  it("routes isolated cron jobs to runIsolatedAgentJob with the correct params", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      sessionKey: `agent:main:cron:isolated-cron-job:run:${now}`,
    }));
    const job = createDueIsolatedJob({
      now,
      id: "isolated-cron-job",
      message: "do the thing",
      wakeMode: "now",
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    const result = await executeJobCore(state, job);

    expect(result).toMatchObject({ status: "ok" });
    expect(runIsolatedAgentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: "isolated-cron-job" }),
        message: "do the thing",
      }),
    );
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("persists the next schedule after an isolated agent job completes", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const runSessionKey = `agent:main:cron:isolated-cron-job:run:${now}`;

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        createDueIsolatedJob({
          now,
          id: "isolated-cron-job",
          name: "isolated cron job",
          wakeMode: "now",
        }),
      ],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        sessionKey: runSessionKey,
      })),
    });

    await onTimer(state);

    const persisted = await loadCronStore(storePath);
    const job = persisted.jobs[0];
    if (!job) {
      throw new Error("expected persisted isolated cron job");
    }
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
    const task = findTaskByRunId(`cron:isolated-cron-job:${now}`);
    if (!task) {
      throw new Error("expected cron task ledger record");
    }
    expect(task.runtime).toBe("cron");
    expect(task.sourceId).toBe("isolated-cron-job");
    expect(task.ownerKey).toBe("");
    expect(task.scopeKind).toBe("system");
    expect(task.childSessionKey).toBe("agent:main:cron:isolated-cron-job");
    expect(task.runId).toBe(`cron:isolated-cron-job:${now}`);
    expect(task.label).toBe("isolated cron job");
    expect(task.task).toBe("isolated cron job");
    expect(task.status).toBe("succeeded");
    expect(task.startedAt).toBe(now);
    expect(task.lastEventAt).toBe(now);
    expect(task.endedAt).toBe(now);
    expect(task?.cleanupAfter).toBe(now + 7 * 24 * 60 * 60_000);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    const positiveDelays = delays.filter((delay) => delay > 0);
    expect(positiveDelays.length).toBeGreaterThan(0);

    timeoutSpy.mockRestore();
  });

  it("records isolated cron task runs against the backing cron session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionKey: "agent:finn:cron:isolated-agent-job:run:run-1",
    }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedAgentJob({ now })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    await onTimer(state);

    expect(runIsolatedAgentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: "isolated-agent-job" }),
        message: "run isolated cron",
      }),
    );
    const task = findTaskByRunId(`cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected isolated cron task ledger record");
    }
    expect(task.childSessionKey).toBe("agent:finn:cron:isolated-agent-job");
    expect(task.status).toBe("succeeded");
    expect(task.terminalSummary).toBe("done");
  });

  it("seeds active scheduled cron task progress for status surfaces", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    let resolveRun: ((value: { status: "ok"; summary: string }) => void) | undefined;
    const runIsolatedAgentJob = vi.fn(
      () =>
        new Promise<{ status: "ok"; summary: string }>((resolve) => {
          resolveRun = resolve;
        }),
    );

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedAgentJob({ now })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    const timerRun = onTimer(state);
    await vi.waitFor(() => {
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    });

    const task = findTaskByRunId(`cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected active cron task ledger record");
    }
    expect(task.status).toBe("running");
    expect(task.progressSummary).toBe("Running cron job.");
    expect(formatTaskStatusDetail(task)).toBe("Running cron job.");

    resolveRun?.({ status: "ok", summary: "done" });
    await timerRun;
  });

  it("keeps scheduler progress when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const ledgerError = new Error("disk full");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedJob({ now, id: "isolated-cron-job", wakeMode: "now" })],
    });

    const createTaskRecordSpy = vi
      .spyOn(detachedTaskRuntime, "createRunningTaskRun")
      .mockImplementation(() => {
        throw ledgerError;
      });

    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    await onTimer(state);

    expect(logger.warn).toHaveBeenCalledWith(
      { jobId: "isolated-cron-job", error: ledgerError },
      "cron: failed to create task ledger record",
    );
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    createTaskRecordSpy.mockRestore();
  });
});
