import { describe, expect, it, vi } from "vitest";
import type { CronServiceDeps } from "./service.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createDeferred,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
installCronTestHooks({ logger: noopLogger });
const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-runs-one-shot-",
});

type CronEvent = NonNullable<CronServiceDeps["onEvent"]> extends (e: infer E) => void ? E : never;

function createCronEventHarness() {
  const events: CronEvent[] = [];
  const waiters: Array<{
    predicate: (evt: CronEvent) => boolean;
    deferred: ReturnType<typeof createDeferred<CronEvent>>;
  }> = [];

  const onEvent = (evt: CronEvent) => {
    events.push(evt);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter && waiter.predicate(evt)) {
        waiters.splice(i, 1);
        waiter.deferred.resolve(evt);
      }
    }
  };

  const waitFor = (predicate: (evt: CronEvent) => boolean) => {
    for (const evt of events) {
      if (predicate(evt)) {
        return Promise.resolve(evt);
      }
    }
    const deferred = createDeferred<CronEvent>();
    waiters.push({ predicate, deferred });
    return deferred.promise;
  };

  return { onEvent, waitFor, events };
}

async function createIsolatedHarness(runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"]) {
  const store = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const events = createCronEventHarness();

  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent,
    requestHeartbeat,
    runIsolatedAgentJob,
    onEvent: events.onEvent,
    schedulerLockPath: null,
  });
  await cron.start();
  return { store, cron, enqueueSystemEvent, requestHeartbeat, events };
}

async function addDefaultIsolatedAnnounceJob(cron: CronService, name: string) {
  const runAt = new Date("2025-12-13T00:00:01.000Z");
  const job = await cron.add({
    enabled: true,
    name,
    schedule: { kind: "at", at: runAt.toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "do it" },
    delivery: { mode: "announce" },
  });
  return { job, runAt };
}

async function runIsolatedAnnounceJobAndWait(params: {
  cron: CronService;
  events: ReturnType<typeof createCronEventHarness>;
  name: string;
  status: "ok" | "error";
}) {
  const { job, runAt } = await addDefaultIsolatedAnnounceJob(params.cron, params.name);
  vi.setSystemTime(runAt);
  await vi.runOnlyPendingTimersAsync();
  await params.events.waitFor(
    (evt) => evt.jobId === job.id && evt.action === "finished" && evt.status === params.status,
  );
  return job;
}

async function runIsolatedAnnounceScenario(params: {
  cron: CronService;
  events: ReturnType<typeof createCronEventHarness>;
  name: string;
  status?: "ok" | "error";
}) {
  await runIsolatedAnnounceJobAndWait({
    cron: params.cron,
    events: params.events,
    name: params.name,
    status: params.status ?? "ok",
  });
}

async function stopCronAndCleanup(cron: CronService, store: { cleanup: () => Promise<void> }) {
  await cron.status();
  cron.stop();
  await store.cleanup();
}

function createStartedCronService(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    schedulerLockPath: null,
  });
}

describe("CronService", () => {
  it("runs an isolated job without posting a fallback summary to main", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
      await createIsolatedHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceScenario({ cron, events, name: "weekly" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("does not post isolated summary to main when run already delivered output", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      delivered: true,
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
      await createIsolatedHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceScenario({ cron, events, name: "weekly delivered" });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("does not post isolated summary to main when announce delivery was attempted", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      delivered: false,
      deliveryAttempted: true,
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
      await createIsolatedHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceScenario({ cron, events, name: "weekly attempted" });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("does not post a fallback main summary when an isolated job errors", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "boom",
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
      await createIsolatedHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated error test",
      status: "error",
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("does not post fallback main summary for isolated delivery-target errors", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "Channel is required when multiple channels are configured: telegram, discord",
      errorKind: "delivery-target" as const,
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
      await createIsolatedHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated delivery target error test",
      status: "error",
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("rejects unsupported session/payload combinations", async () => {
    const store = await makeStorePath();
    const cron = createStartedCronService(store.storePath);
    await cron.start();

    // isolated + systemEvent is not supported
    await expect(
      cron.add({
        name: "bad combo (isolated/systemEvent)",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "nope" },
      }),
    ).rejects.toThrow(/isolated.*cron jobs require/);

    cron.stop();
    await store.cleanup();
  });
});
