import { describe, expect, it } from "vitest";
import { validateCardActionTrust } from "./tools.js";
import { WEEKLY_REPORT_CONTROLLER_ID, type WeeklyReportFlowState } from "./types.js";

const BOUND_SESSION_KEY = "agent:silver:feishu:direct:ou_x";
const OTHER_SESSION_KEY = "agent:silver:feishu:direct:ou_other";

function makeState(weekKey = "2026-W21"): WeeklyReportFlowState {
  return {
    weekKey,
    weekTitle: "2026.5.18-2026.5.24",
    recipientSessionKey: BOUND_SESSION_KEY,
    targetDocToken: "doc-token",
    draft: { week_title: "2026.5.18-2026.5.24", current_week: [], next_week: [] } as never,
  };
}

function makeTaskFlow(opts: {
  sessionKey?: string;
  flow?: {
    flowId: string;
    controllerId: string;
    status: string;
    stateJson: WeeklyReportFlowState;
  } | null;
}) {
  return {
    sessionKey: opts.sessionKey ?? BOUND_SESSION_KEY,
    get: (id: string) => (opts.flow && opts.flow.flowId === id ? opts.flow : undefined),
  } as never;
}

describe("validateCardActionTrust", () => {
  it("accepts happy path", () => {
    const flow = {
      flowId: "f1",
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      status: "waiting",
      stateJson: makeState(),
    };
    const result = validateCardActionTrust({
      taskFlow: makeTaskFlow({ flow }),
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      bindings: { sessionKey: BOUND_SESSION_KEY, weekKey: "2026-W21", flowId: "f1" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects on missing flow (guard a)", () => {
    const result = validateCardActionTrust({
      taskFlow: makeTaskFlow({ flow: null }),
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      bindings: { sessionKey: BOUND_SESSION_KEY, weekKey: "2026-W21", flowId: "f1" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("flow_not_found");
    }
  });

  it("rejects on wrong controllerId (guard b)", () => {
    const flow = {
      flowId: "f1",
      controllerId: "some-other-controller",
      status: "waiting",
      stateJson: makeState(),
    };
    const result = validateCardActionTrust({
      taskFlow: makeTaskFlow({ flow }),
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      bindings: { sessionKey: BOUND_SESSION_KEY, weekKey: "2026-W21", flowId: "f1" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong_controller");
    }
  });

  it("rejects on wrong sessionKey (guard c — cross-session forgery defense)", () => {
    const flow = {
      flowId: "f1",
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      status: "waiting",
      stateJson: makeState(),
    };
    const result = validateCardActionTrust({
      taskFlow: makeTaskFlow({ flow, sessionKey: BOUND_SESSION_KEY }),
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      bindings: { sessionKey: OTHER_SESSION_KEY, weekKey: "2026-W21", flowId: "f1" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_mismatch");
    }
  });

  it("rejects on non-waiting status (guard d)", () => {
    const flow = {
      flowId: "f1",
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      status: "done",
      stateJson: makeState(),
    };
    const result = validateCardActionTrust({
      taskFlow: makeTaskFlow({ flow }),
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      bindings: { sessionKey: BOUND_SESSION_KEY, weekKey: "2026-W21", flowId: "f1" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_waiting:done");
    }
  });

  it("rejects on stale weekKey (guard e — stale-card defense)", () => {
    const flow = {
      flowId: "f1",
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      status: "waiting",
      stateJson: makeState("2026-W20"),
    };
    const result = validateCardActionTrust({
      taskFlow: makeTaskFlow({ flow }),
      controllerId: WEEKLY_REPORT_CONTROLLER_ID,
      bindings: { sessionKey: BOUND_SESSION_KEY, weekKey: "2026-W21", flowId: "f1" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("week_mismatch");
    }
  });
});
