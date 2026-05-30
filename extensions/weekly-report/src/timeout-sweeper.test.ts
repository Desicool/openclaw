import { describe, expect, it, vi } from "vitest";
import type { WeeklyReportPluginSettings } from "./settings.js";
import { sweepOnce } from "./timeout-sweeper.js";
import { WEEKLY_REPORT_CONTROLLER_ID, type WeeklyReportFlowState } from "./types.js";

const MS_PER_DAY = 86_400_000;

function makeSettings(
  overrides: Partial<WeeklyReportPluginSettings> = {},
): WeeklyReportPluginSettings {
  return {
    targetDocToken: "doc-token",
    recipientSessionKey: "agent:x:feishu:direct:ou_x",
    reminderAfterDays: 3,
    failAfterDays: 7,
    weekStartsOn: "monday",
    sweeperIntervalMs: 60 * 60 * 1000,
    gitRemotes: [],
    gitAuthor: undefined,
    gitWorkspaceDir: undefined,
    gitFetchTimeoutMs: 30_000,
    gitMaxCommitsPerRepo: 200,
    gitHostAllowlist: ["gitlab.com", "github.com"],
    gitMaxParallelOps: 3,
    gitMaxRepoCount: 10,
    gitOverallTimeoutMs: 120_000,
    userOpenId: undefined,
    botOpenId: undefined,
    groupDenylist: [],
    groupMaxMessagesPerPass: 200,
    larkCliBinPath: "larkcli",
    larkCliAccountId: undefined,
    larkCliTimeoutMs: 30_000,
    larkCliMaxPages: 4,
    larkOfficialCliBinPath: "lark-cli",
    larkOfficialCliTimeoutMs: 30_000,
    docIdentity: "user",
    ...overrides,
  };
}

function makeState(overrides: Partial<WeeklyReportFlowState> = {}): WeeklyReportFlowState {
  return {
    weekKey: "2026-W21",
    weekTitle: "2026.5.18-2026.5.24",
    recipientSessionKey: "agent:x:feishu:direct:ou_x",
    targetDocToken: "doc-token",
    draft: { week_title: "2026.5.18-2026.5.24", current_week: [], next_week: [] } as never,
    ...overrides,
  };
}

function makeFlow(overrides: {
  flowId: string;
  status?: string;
  controllerId?: string;
  updatedAt: number;
  state?: WeeklyReportFlowState;
}) {
  return {
    flowId: overrides.flowId,
    controllerId: overrides.controllerId ?? WEEKLY_REPORT_CONTROLLER_ID,
    status: overrides.status ?? "waiting",
    revision: 1,
    updatedAt: overrides.updatedAt,
    stateJson: overrides.state ?? makeState(),
    waitJson: null,
  };
}

function makeBound(flows: ReturnType<typeof makeFlow>[]) {
  const setWaiting = vi.fn().mockImplementation(({ flowId, expectedRevision }) => {
    const flow = flows.find((f) => f.flowId === flowId);
    if (!flow || flow.revision !== expectedRevision) {
      return { applied: false, code: "revision_conflict" };
    }
    return { applied: true, flow };
  });
  const fail = vi.fn().mockImplementation(({ flowId, expectedRevision }) => {
    const flow = flows.find((f) => f.flowId === flowId);
    if (!flow || flow.revision !== expectedRevision) {
      return { applied: false, code: "revision_conflict" };
    }
    return { applied: true, flow };
  });
  return {
    list: () => flows,
    setWaiting,
    fail,
  };
}

function makeRuntime(boundFlows: ReturnType<typeof makeFlow>[]) {
  const bound = makeBound(boundFlows);
  const enqueueSystemEvent = vi.fn();
  return {
    runtime: {
      tasks: {
        managedFlows: {
          bindSession: () => bound,
        },
      },
      system: { enqueueSystemEvent },
    } as never,
    bound,
    enqueueSystemEvent,
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("sweepOnce", () => {
  it("does nothing when no flows are waiting", () => {
    const { runtime, bound } = makeRuntime([
      makeFlow({ flowId: "f1", status: "done", updatedAt: Date.now() }),
    ]);
    const result = sweepOnce({
      runtime,
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      settings: makeSettings(),
      recipientSessionKey: "agent:x:feishu:direct:ou_x",
      now: () => Date.now(),
      logger: makeLogger(),
    });
    expect(result).toEqual({ reminded: 0, failed: 0, skipped: 0 });
    expect(bound.setWaiting).not.toHaveBeenCalled();
    expect(bound.fail).not.toHaveBeenCalled();
  });

  it("posts a reminder once when waiting past reminderAfterDays", () => {
    const now = 2_000_000_000_000;
    const fourDaysAgo = now - 4 * MS_PER_DAY;
    const { runtime, bound, enqueueSystemEvent } = makeRuntime([
      makeFlow({ flowId: "f1", updatedAt: fourDaysAgo }),
    ]);
    const result = sweepOnce({
      runtime,
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      settings: makeSettings(),
      recipientSessionKey: "agent:x:feishu:direct:ou_x",
      now: () => now,
      logger: makeLogger(),
    });
    expect(result).toEqual({ reminded: 1, failed: 0, skipped: 0 });
    expect(bound.setWaiting).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(bound.fail).not.toHaveBeenCalled();
  });

  it("does not re-post when reminderSentAt is already set", () => {
    const now = 2_000_000_000_000;
    const fourDaysAgo = now - 4 * MS_PER_DAY;
    const { runtime, bound, enqueueSystemEvent } = makeRuntime([
      makeFlow({
        flowId: "f1",
        updatedAt: fourDaysAgo,
        state: makeState({ reminderSentAt: fourDaysAgo + 60_000 }),
      }),
    ]);
    const result = sweepOnce({
      runtime,
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      settings: makeSettings(),
      recipientSessionKey: "agent:x:feishu:direct:ou_x",
      now: () => now,
      logger: makeLogger(),
    });
    expect(result).toEqual({ reminded: 0, failed: 0, skipped: 1 });
    expect(bound.setWaiting).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("fails the flow past failAfterDays", () => {
    const now = 2_000_000_000_000;
    const eightDaysAgo = now - 8 * MS_PER_DAY;
    const { runtime, bound, enqueueSystemEvent } = makeRuntime([
      makeFlow({ flowId: "f1", updatedAt: eightDaysAgo }),
    ]);
    const result = sweepOnce({
      runtime,
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      settings: makeSettings(),
      recipientSessionKey: "agent:x:feishu:direct:ou_x",
      now: () => now,
      logger: makeLogger(),
    });
    expect(result).toEqual({ reminded: 0, failed: 1, skipped: 0 });
    expect(bound.fail).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("revision conflict on setWaiting is treated as skipped (CAS idempotency)", () => {
    const now = 2_000_000_000_000;
    const fourDaysAgo = now - 4 * MS_PER_DAY;
    const flows = [makeFlow({ flowId: "f1", updatedAt: fourDaysAgo })];
    flows[0].revision = 7;
    const bound = {
      list: () => flows,
      setWaiting: vi.fn().mockReturnValue({ applied: false, code: "revision_conflict" }),
      fail: vi.fn(),
    };
    const enqueueSystemEvent = vi.fn();
    const runtime = {
      tasks: { managedFlows: { bindSession: () => bound } },
      system: { enqueueSystemEvent },
    } as never;
    const result = sweepOnce({
      runtime,
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      settings: makeSettings(),
      recipientSessionKey: "agent:x:feishu:direct:ou_x",
      now: () => now,
      logger: makeLogger(),
    });
    expect(result).toEqual({ reminded: 0, failed: 0, skipped: 1 });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
