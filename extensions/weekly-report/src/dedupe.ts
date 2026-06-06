/**
 * Best-effort dedupe helper. Reads all flows for the bound sessionKey, filters in-memory by
 * controllerId + stateJson.weekKey + active status. Returns the first match, if any.
 *
 * The race window between this read and the subsequent `createManaged` is documented in the plan
 * and accepted for the single-user weekly cron use case.
 */

import type { OpenClawPluginApi } from "../runtime-api.js";
import { ACTIVE_STATUSES, isWeeklyReportFlowState } from "./types.js";

type FlowsList = ReturnType<
  ReturnType<
    NonNullable<OpenClawPluginApi["runtime"]>["tasks"]["managedFlows"]["fromToolContext"]
  >["list"]
>;

export type WeeklyReportFlowDescriptor = {
  flowId: string;
  revision: number;
  weekKey: string;
};

export function findActiveWeeklyReportFlow(params: {
  flows: FlowsList;
  controllerId: string;
  weekKey: string;
}): WeeklyReportFlowDescriptor | null {
  for (const flow of params.flows) {
    if (flow.controllerId !== params.controllerId) {
      continue;
    }
    if (!ACTIVE_STATUSES.has(flow.status as never)) {
      continue;
    }
    if (!isWeeklyReportFlowState(flow.stateJson)) {
      continue;
    }
    if (flow.stateJson.weekKey !== params.weekKey) {
      continue;
    }
    return {
      flowId: flow.flowId,
      revision: flow.revision,
      weekKey: flow.stateJson.weekKey,
    };
  }
  return null;
}
