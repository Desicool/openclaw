import { describe, expect, it } from "vitest";
import { findActiveWeeklyReportFlow } from "./dedupe.js";
import { WEEKLY_REPORT_CONTROLLER_ID, type WeeklyReportFlowState } from "./types.js";

function fakeState(
  weekKey: string,
  overrides: Partial<WeeklyReportFlowState> = {},
): WeeklyReportFlowState {
  return {
    weekKey,
    weekTitle: "2026.5.18-2026.5.24",
    recipientSessionKey: "agent:x:feishu:direct:ou_x",
    targetDocToken: "doc-token",
    draft: { week_title: "2026.5.18-2026.5.24", current_week: [], next_week: [] } as never,
    ...overrides,
  };
}

function fakeFlow(params: {
  flowId: string;
  controllerId?: string;
  status: string;
  weekKey: string;
  revision?: number;
}): never {
  return {
    flowId: params.flowId,
    controllerId: params.controllerId ?? WEEKLY_REPORT_CONTROLLER_ID,
    status: params.status,
    revision: params.revision ?? 1,
    stateJson: fakeState(params.weekKey),
  } as never;
}

describe("findActiveWeeklyReportFlow", () => {
  it("returns null when the list is empty", () => {
    expect(
      findActiveWeeklyReportFlow({
        flows: [],
        controllerId: WEEKLY_REPORT_CONTROLLER_ID,
        weekKey: "2026-W21",
      }),
    ).toBeNull();
  });

  it("returns the matching active flow", () => {
    const result = findActiveWeeklyReportFlow({
      flows: [
        fakeFlow({ flowId: "f1", status: "waiting", weekKey: "2026-W21", revision: 3 }),
      ] as never,
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      weekKey: "2026-W21",
    });
    expect(result).toEqual({ flowId: "f1", revision: 3, weekKey: "2026-W21" });
  });

  it("ignores completed and failed flows", () => {
    expect(
      findActiveWeeklyReportFlow({
        flows: [
          fakeFlow({ flowId: "f1", status: "done", weekKey: "2026-W21" }),
          fakeFlow({ flowId: "f2", status: "failed", weekKey: "2026-W21" }),
        ] as never,
        controllerId: WEEKLY_REPORT_CONTROLLER_ID,
        weekKey: "2026-W21",
      }),
    ).toBeNull();
  });

  it("ignores flows for a different weekKey", () => {
    expect(
      findActiveWeeklyReportFlow({
        flows: [fakeFlow({ flowId: "f1", status: "waiting", weekKey: "2026-W20" })] as never,
        controllerId: WEEKLY_REPORT_CONTROLLER_ID,
        weekKey: "2026-W21",
      }),
    ).toBeNull();
  });

  it("ignores flows for a different controllerId", () => {
    expect(
      findActiveWeeklyReportFlow({
        flows: [
          fakeFlow({
            flowId: "f1",
            status: "waiting",
            weekKey: "2026-W21",
            controllerId: "some-other-controller",
          }),
        ] as never,
        controllerId: WEEKLY_REPORT_CONTROLLER_ID,
        weekKey: "2026-W21",
      }),
    ).toBeNull();
  });
});
