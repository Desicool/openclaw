// Cron service job tests cover job creation, updates, and runtime scheduling.
import { describe, expect, it } from "vitest";
import {
  applyJobPatch,
  createJob,
  recomputeNextRuns,
  recomputeNextRunsForMaintenance,
} from "./service/jobs.js";
import type { CronServiceState } from "./service/state.js";
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS } from "./stagger.js";
import type { CronJob, CronJobPatch } from "./types.js";

function expectCronStaggerMs(job: CronJob, expected: number): void {
  expect(job.schedule.kind).toBe("cron");
  if (job.schedule.kind === "cron") {
    expect(job.schedule.staggerMs).toBe(expected);
  }
}

describe("applyJobPatch", () => {
  const createIsolatedAgentTurnJob = (
    id: string,
    delivery: CronJob["delivery"],
    overrides?: Partial<CronJob>,
  ): CronJob => {
    const now = Date.now();
    return {
      id,
      name: id,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery,
      state: {},
      ...overrides,
    };
  };

  it("clears chat delivery fields when switching delivery to webhook", () => {
    const job = createIsolatedAgentTurnJob("job-webhook-switch", {
      mode: "announce",
      channel: "telegram",
      to: "-100123",
      threadId: 42,
      accountId: "coordinator",
      completionDestination: {
        mode: "webhook",
        to: "https://example.invalid/legacy-completion",
      },
    });

    applyJobPatch(job, {
      delivery: { mode: "webhook", to: "https://example.invalid/cron" },
    });

    expect(job.delivery).toEqual({
      mode: "webhook",
      to: "https://example.invalid/cron",
      bestEffort: undefined,
      completionDestination: undefined,
      failureDestination: undefined,
    });
  });

  it("clears migrated completion webhook when disabling delivery", () => {
    const job = createIsolatedAgentTurnJob("job-disable-completion-webhook", {
      mode: "announce",
      completionDestination: {
        mode: "webhook",
        to: "https://example.invalid/legacy-completion",
      },
    });

    applyJobPatch(job, {
      delivery: { mode: "none" },
    });

    expect(job.delivery?.mode).toBe("none");
    expect(job.delivery?.completionDestination).toBeUndefined();
  });

  it("rejects completion webhook on disabled delivery", () => {
    const job = createIsolatedAgentTurnJob("job-disable-with-completion-webhook", {
      mode: "announce",
    });

    expect(() =>
      applyJobPatch(job, {
        delivery: {
          mode: "none",
          completionDestination: {
            mode: "webhook",
            to: "https://example.invalid/legacy-completion",
          },
        },
      }),
    ).toThrow(
      'cron completion destination webhook is only supported with delivery.mode="announce"',
    );
  });

  it("clears migrated completion webhook while keeping announce delivery", () => {
    const job = createIsolatedAgentTurnJob("job-clear-completion-webhook", {
      mode: "announce",
      completionDestination: {
        mode: "webhook",
        to: "https://example.invalid/legacy-completion",
      },
    });

    applyJobPatch(job, {
      delivery: { completionDestination: null },
    });

    expect(job.delivery?.mode).toBe("announce");
    expect(job.delivery?.completionDestination).toBeUndefined();
  });

  it("clears webhook delivery targets when switching delivery to announce", () => {
    const job = createIsolatedAgentTurnJob("job-announce-switch", {
      mode: "webhook",
      to: "https://example.invalid/cron",
    });

    applyJobPatch(job, {
      delivery: { mode: "announce" },
    });

    expect(job.delivery).toEqual({
      mode: "announce",
      channel: undefined,
      to: undefined,
      threadId: undefined,
      accountId: undefined,
      bestEffort: undefined,
      failureDestination: undefined,
    });
  });

  it("keeps explicit chat targets when switching webhook delivery to announce", () => {
    const job = createIsolatedAgentTurnJob("job-announce-switch-target", {
      mode: "webhook",
      to: "https://example.invalid/cron",
    });

    applyJobPatch(job, {
      delivery: { mode: "announce", channel: "telegram", to: "-100123" },
    });

    expect(job.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "-100123",
    });
  });

  it("applies explicit delivery patches", () => {
    const job = createIsolatedAgentTurnJob("job-2", {
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    const patch: CronJobPatch = {
      delivery: {
        mode: "none",
        channel: "signal",
        to: "555",
        bestEffort: true,
      },
    };

    applyJobPatch(job, patch);
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("do it");
    }
    expect(job.delivery).toEqual({
      mode: "none",
      channel: "signal",
      to: "555",
      bestEffort: true,
    });
  });

  it("applies explicit delivery patches for isolated agentTurn jobs", () => {
    const job = createIsolatedAgentTurnJob("job-isolated-delivery", {
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    applyJobPatch(job, {
      delivery: { mode: "announce", to: "555" },
    });

    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "555",
      bestEffort: undefined,
    });
  });

  it("merges delivery.accountId from patch and preserves existing", () => {
    const job = createIsolatedAgentTurnJob("job-acct", {
      mode: "announce",
      channel: "telegram",
      to: "-100123",
    });

    applyJobPatch(job, { delivery: { mode: "announce", accountId: " coordinator " } });
    expect(job.delivery?.accountId).toBe("coordinator");
    expect(job.delivery?.mode).toBe("announce");
    expect(job.delivery?.to).toBe("-100123");

    // Updating other fields preserves accountId
    applyJobPatch(job, { delivery: { mode: "announce", to: "-100999" } });
    expect(job.delivery?.accountId).toBe("coordinator");
    expect(job.delivery?.to).toBe("-100999");

    // Clearing accountId with empty string
    applyJobPatch(job, { delivery: { mode: "announce", accountId: "" } });
    expect(job.delivery?.accountId).toBeUndefined();
  });

  it("persists agentTurn payload.lightContext updates when editing existing jobs", () => {
    const job = createIsolatedAgentTurnJob("job-light-context", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = {
      kind: "agentTurn",
      message: "do it",
      lightContext: true,
    };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        lightContext: false,
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.lightContext).toBe(false);
    }
  });

  it("persists agentTurn payload.fallbacks updates when editing existing jobs", () => {
    const job = createIsolatedAgentTurnJob("job-fallbacks", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = {
      kind: "agentTurn",
      message: "do it",
      fallbacks: ["openrouter/gpt-4.1-mini"],
    };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        fallbacks: ["anthropic/claude-haiku-3-5", "openai/gpt-5"],
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.fallbacks).toEqual(["anthropic/claude-haiku-3-5", "openai/gpt-5"]);
    }
  });

  it("persists agentTurn payload.toolsAllow updates when editing existing jobs", () => {
    const job = createIsolatedAgentTurnJob("job-tools", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = {
      kind: "agentTurn",
      message: "do it",
      toolsAllow: ["exec"],
    };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        toolsAllow: ["read", "write"],
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.toolsAllow).toEqual(["read", "write"]);
    }
  });

  it("clears agentTurn payload.toolsAllow when patch requests null", () => {
    const job = createIsolatedAgentTurnJob("job-tools-clear", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = {
      kind: "agentTurn",
      message: "do it",
      toolsAllow: ["exec", "read"],
    };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        toolsAllow: null,
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.toolsAllow).toBeUndefined();
    }
  });

  it("applies payload.lightContext when replacing payload kind via patch", () => {
    const job = createIsolatedAgentTurnJob("job-light-context-switch", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = { kind: "systemEvent", text: "ping" };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        lightContext: true,
      },
    });

    const payload = job.payload as CronJob["payload"];
    expect(payload.kind).toBe("agentTurn");
    if (payload.kind === "agentTurn") {
      expect(payload.lightContext).toBe(true);
    }
  });

  it("carries payload.fallbacks when replacing payload kind via patch", () => {
    const job = createIsolatedAgentTurnJob("job-fallbacks-switch", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = { kind: "systemEvent", text: "ping" };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        fallbacks: ["anthropic/claude-haiku-3-5", "openai/gpt-5"],
      },
    });

    const payload = job.payload as CronJob["payload"];
    expect(payload.kind).toBe("agentTurn");
    if (payload.kind === "agentTurn") {
      expect(payload.fallbacks).toEqual(["anthropic/claude-haiku-3-5", "openai/gpt-5"]);
    }
  });

  it("carries payload.toolsAllow when replacing payload kind via patch", () => {
    const job = createIsolatedAgentTurnJob("job-tools-switch", {
      mode: "announce",
      channel: "telegram",
    });
    job.payload = { kind: "systemEvent", text: "ping" };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        toolsAllow: ["exec", "read"],
      },
    });

    const payload = job.payload as CronJob["payload"];
    expect(payload.kind).toBe("agentTurn");
    if (payload.kind === "agentTurn") {
      expect(payload.toolsAllow).toEqual(["exec", "read"]);
    }
  });

  it.each([
    { name: "no delivery update", patch: { enabled: true } satisfies CronJobPatch },
    {
      name: "blank webhook target",
      patch: { delivery: { mode: "webhook", to: "" } } satisfies CronJobPatch,
    },
    {
      name: "non-http protocol",
      patch: {
        delivery: { mode: "webhook", to: "ftp://example.invalid" },
      } satisfies CronJobPatch,
    },
    {
      name: "invalid URL",
      patch: { delivery: { mode: "webhook", to: "not-a-url" } } satisfies CronJobPatch,
    },
  ] as const)("rejects invalid webhook delivery target URL: $name", ({ patch }) => {
    const expectedError = "cron webhook delivery requires delivery.to to be a valid http(s) URL";
    const job = createIsolatedAgentTurnJob("job-webhook-invalid", { mode: "webhook" });
    expect(() => applyJobPatch(job, patch)).toThrow(expectedError);
  });

  it("trims webhook delivery target URLs", () => {
    const job = createIsolatedAgentTurnJob("job-webhook-trim", {
      mode: "webhook",
      to: "https://example.invalid/original",
    });

    applyJobPatch(job, { delivery: { mode: "webhook", to: "  https://example.invalid/trim  " } });
    expect(job.delivery).toEqual({ mode: "webhook", to: "https://example.invalid/trim" });
  });

  it("validates and trims webhook failureDestination target URLs", () => {
    const expectedError =
      "cron failure destination webhook requires delivery.failureDestination.to to be a valid http(s) URL";
    const job = createIsolatedAgentTurnJob("job-failure-webhook-target", {
      mode: "announce",
      channel: "telegram",
      to: "123",
      failureDestination: {
        mode: "webhook",
        to: "not-a-url",
      },
    });

    expect(() => applyJobPatch(job, { enabled: true })).toThrow(expectedError);

    job.delivery = {
      mode: "announce",
      channel: "telegram",
      to: "123",
      failureDestination: {
        mode: "webhook",
        to: "  https://example.invalid/failure  ",
      },
    };
    applyJobPatch(job, { enabled: true });
    expect(job.delivery?.failureDestination?.to).toBe("https://example.invalid/failure");
  });

  it("preserves raw channel delivery targets for plugin-owned validation", () => {
    const job = createIsolatedAgentTurnJob("job-telegram-invalid", {
      mode: "announce",
      channel: "telegram",
      to: "-10012345/6789",
    });

    applyJobPatch(job, { enabled: true });
    expect(job.delivery?.to).toBe("-10012345/6789");
  });

  it.each([
    { name: "t.me URL", to: "https://t.me/mychannel" },
    { name: "t.me URL (no https)", to: "t.me/mychannel" },
    { name: "valid target (plain chat id)", to: "-1001234567890" },
    { name: "valid target (colon delimiter)", to: "-1001234567890:123" },
    { name: "valid target (topic marker)", to: "-1001234567890:topic:456" },
    { name: "@username", to: "@mybot" },
    { name: "without target", to: undefined },
  ] as const)("accepts Telegram delivery with $name", ({ to }) => {
    const job = createIsolatedAgentTurnJob("job-telegram-valid", {
      mode: "announce",
      channel: "telegram",
      ...(to ? { to } : {}),
    });

    applyJobPatch(job, { enabled: true });
    expect(job.enabled).toBe(true);
  });
});

function createMockState(now: number): CronServiceState {
  return {
    deps: {
      nowMs: () => now,
    },
  } as unknown as CronServiceState;
}

describe("createJob for isolated agentTurn jobs", () => {
  const now = Date.parse("2026-02-28T12:00:00.000Z");

  it("creates isolated agentTurn job", () => {
    const state = createMockState(now);
    const job = createJob(state, {
      name: "isolated-job",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
    });
    expect(job.sessionTarget).toBe("isolated");
    expect(job.payload.kind).toBe("agentTurn");
  });

  it("rejects non-isolated session targets", () => {
    const state = createMockState(now);
    expect(() =>
      createJob(state, {
        name: "bad-session",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "main" as never,
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "do it" },
      }),
    ).toThrow(/isolated/);
  });

  it("rejects non-agentTurn payload for isolated jobs", () => {
    const state = createMockState(now);
    expect(() =>
      createJob(state, {
        name: "bad-payload",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "nope" } as never,
      }),
    ).toThrow(/agentTurn/);
  });
});

describe("cron stagger defaults", () => {
  it("defaults top-of-hour cron jobs to 5m stagger", () => {
    const now = Date.parse("2026-02-08T10:00:00.000Z");
    const state = createMockState(now);

    const job = createJob(state, {
      name: "hourly",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
    });

    expectCronStaggerMs(job, DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("keeps exact schedules when staggerMs is explicitly 0", () => {
    const now = Date.parse("2026-02-08T10:00:00.000Z");
    const state = createMockState(now);

    const job = createJob(state, {
      name: "exact-hourly",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 0 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
    });

    expectCronStaggerMs(job, 0);
  });

  it("preserves existing stagger when editing cron expression without stagger", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-keep-stagger",
      name: "job-keep-stagger",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 120_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
      state: {},
    };

    applyJobPatch(job, {
      schedule: { kind: "cron", expr: "0 */2 * * *" },
    });

    expect(job.schedule.kind).toBe("cron");
    if (job.schedule.kind === "cron") {
      expect(job.schedule.expr).toBe("0 */2 * * *");
      expect(job.schedule.staggerMs).toBe(120_000);
    }
  });

  it("applies default stagger when switching from at to top-of-hour cron", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-switch-cron",
      name: "job-switch-cron",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now + 60_000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
      state: {},
    };

    applyJobPatch(job, {
      schedule: { kind: "cron", expr: "0 * * * *" },
    });

    expect(job.schedule.kind).toBe("cron");
    if (job.schedule.kind === "cron") {
      expect(job.schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
    }
  });
});

describe("createJob delivery defaults", () => {
  const now = Date.parse("2026-02-28T12:00:00.000Z");

  it('defaults delivery to { mode: "announce" } for isolated agentTurn jobs without explicit delivery', () => {
    const state = createMockState(now);
    const job = createJob(state, {
      name: "isolated-no-delivery",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello" },
    });
    expect(job.delivery).toEqual({ mode: "announce" });
  });

  it("preserves explicit delivery for isolated agentTurn jobs", () => {
    const state = createMockState(now);
    const job = createJob(state, {
      name: "isolated-explicit-delivery",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: { mode: "none" },
    });
    expect(job.delivery).toEqual({ mode: "none" });
  });
});

describe("recomputeNextRuns", () => {
  it("keeps recovered recurring error retries behind run-end backoff", () => {
    const startedAt = Date.parse("2026-03-01T12:00:00.000Z");
    const durationMs = 90_000;
    const now = startedAt + 31_000;
    const job: CronJob = {
      id: "failed-cron-long-run",
      name: "failed cron long run",
      enabled: true,
      createdAtMs: startedAt - 60_000,
      updatedAtMs: startedAt,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
      state: {
        lastRunAtMs: startedAt,
        lastDurationMs: durationMs,
        lastStatus: "error",
        consecutiveErrors: 1,
      },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRuns(state)).toBe(true);
    expect(job.state.nextRunAtMs).toBe(startedAt + durationMs + 30_000);
  });

  it("repairs future cron nextRunAtMs values that are not schedule slots", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const badFuture = Date.parse("2026-05-12T16:00:00.000Z");
    const job: CronJob = {
      id: "daily-bad-future",
      name: "daily bad future",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      // Use a minute-based cron to avoid timezone-dependent exact timestamps
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 0 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
      state: { nextRunAtMs: badFuture },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    const changed = recomputeNextRunsForMaintenance(state);
    expect(changed).toBe(true);
    // Should repair to the next hourly slot after now
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
    expect(job.state.nextRunAtMs).toBeLessThan(badFuture);
  });

  it("preserves valid future cron nextRunAtMs values during maintenance", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    // Next slot just 1 minute away
    const validFuture = Date.parse("2026-05-05T12:01:00.000Z");
    const job: CronJob = {
      id: "daily-valid-future",
      name: "daily valid future",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "* * * * *", staggerMs: 0 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
      state: { nextRunAtMs: validFuture },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRunsForMaintenance(state)).toBe(false);
    expect(job.state.nextRunAtMs).toBe(validFuture);
  });

  it("preserves deferred agent-turn cron nextRunAtMs values before the next natural slot", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const deferred = Date.parse("2026-05-05T12:02:00.000Z");
    const job: CronJob = {
      id: "daily-deferred-agent-turn",
      name: "daily deferred agent turn",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: {
        kind: "cron",
        expr: "0 0 21 * * *",
        staggerMs: 0,
      } as unknown as CronJob["schedule"],
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
      state: { nextRunAtMs: deferred },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRunsForMaintenance(state)).toBe(false);
    expect(job.state.nextRunAtMs).toBe(deferred);
  });

  it("preserves cron retry backoff nextRunAtMs values during maintenance", () => {
    const now = Date.parse("2025-12-13T04:02:00.000Z");
    const retryAt = Date.parse("2025-12-13T04:10:00.000Z");
    const job: CronJob = {
      id: "backoff-pending",
      name: "backoff pending",
      enabled: true,
      createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
      updatedAtMs: Date.parse("2025-12-13T04:01:10.000Z"),
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do not run during backoff" },
      state: {
        nextRunAtMs: retryAt,
        lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
        lastStatus: "error",
        consecutiveErrors: 4,
      },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRunsForMaintenance(state)).toBe(false);
    expect(job.state.nextRunAtMs).toBe(retryAt);
  });

  it("preserves cron retry backoff nextRunAtMs values from the run end time", () => {
    const now = Date.parse("2025-12-13T04:10:00.000Z");
    const retryAt = Date.parse("2025-12-13T04:20:30.000Z");
    const job: CronJob = {
      id: "backoff-from-ended-at",
      name: "backoff from ended at",
      enabled: true,
      createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
      updatedAtMs: Date.parse("2025-12-13T04:05:30.000Z"),
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "preserve run-end retry backoff" },
      state: {
        nextRunAtMs: retryAt,
        lastRunAtMs: Date.parse("2025-12-13T04:01:30.000Z"),
        lastDurationMs: 4 * 60_000,
        lastStatus: "error",
        consecutiveErrors: 4,
      },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    expect(recomputeNextRunsForMaintenance(state)).toBe(false);
    expect(job.state.nextRunAtMs).toBe(retryAt);
  });

  it("repairs stale future cron nextRunAtMs values after error backoff has elapsed", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const badFuture = Date.parse("2026-05-12T16:00:00.000Z");
    const job: CronJob = {
      id: "daily-expired-error",
      name: "daily expired error",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 0 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
      state: {
        nextRunAtMs: badFuture,
        lastRunAtMs: Date.parse("2026-05-04T00:00:00.000Z"),
        lastStatus: "error",
        consecutiveErrors: 1,
      },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    const changed = recomputeNextRunsForMaintenance(state);
    expect(changed).toBe(true);
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
    expect(job.state.nextRunAtMs).toBeLessThan(badFuture);
  });

  it("keeps future nextRunAtMs while probing malformed cron schedules", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const future = Date.parse("2026-05-12T16:00:00.000Z");
    const job: CronJob = {
      id: "malformed-future",
      name: "malformed future",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "not a valid cron" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
      state: { nextRunAtMs: future },
    };
    const state = {
      ...createMockState(now),
      store: { version: 1 as const, jobs: [job] },
    } as CronServiceState;

    recomputeNextRunsForMaintenance(state);
    expect(job.state.nextRunAtMs).toBe(future);
    expect(job.state.scheduleErrorCount).toBeUndefined();
  });
});
