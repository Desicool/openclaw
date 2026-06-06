/** Detached task-ledger integration for cron runs. */
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/detached-task-runtime.js";
import { resolveCronAgentSessionKey } from "../isolated-agent/session-key.js";
import { createCronExecutionId } from "../run-id.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { normalizeCronRunErrorText, timeoutErrorMessage } from "./execution-errors.js";
import type { CronServiceState } from "./state.js";
import { CRON_TASK_RUNNING_PROGRESS_SUMMARY } from "./task-ledger.js";

function resolveCronTaskChildSessionKey(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
}): string | undefined {
  const explicitSessionKey = params.job.sessionKey?.trim();
  if (explicitSessionKey) {
    // Explicit session bindings must win over generated cron session keys so
    // task drill-down opens the same transcript the cron run actually used.
    return explicitSessionKey;
  }
  return resolveCronAgentSessionKey({
    sessionKey: `cron:${params.job.id}`,
    agentId: params.job.agentId ?? params.state.deps.defaultAgentId ?? DEFAULT_AGENT_ID,
  });
}

/** Creates a best-effort detached task ledger row for a cron run. */
export function tryCreateCronTaskRun(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
}): string | undefined {
  const runId = createCronExecutionId(params.job.id, params.startedAt);
  try {
    const task = createRunningTaskRun({
      runtime: "cron",
      sourceId: params.job.id,
      ownerKey: "",
      scopeKind: "system",
      childSessionKey: resolveCronTaskChildSessionKey(params),
      agentId: params.job.agentId,
      runId,
      label: params.job.name,
      task: params.job.name || params.job.id,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: params.startedAt,
      lastEventAt: params.startedAt,
      progressSummary: CRON_TASK_RUNNING_PROGRESS_SUMMARY,
    });
    if (!task) {
      params.state.deps.log.warn(
        { jobId: params.job.id },
        "cron: task ledger record was not persisted",
      );
      return undefined;
    }
    return runId;
  } catch (error) {
    params.state.deps.log.warn(
      { jobId: params.job.id, error },
      "cron: failed to create task ledger record",
    );
    return undefined;
  }
}

/** Completes or fails the detached task ledger row for a cron run when one exists. */
export function tryFinishCronTaskRun(
  state: CronServiceState,
  result: {
    taskRunId?: string;
    status: CronRunStatus;
    error?: unknown;
    endedAt: number;
    summary?: string;
  },
): void {
  if (!result.taskRunId) {
    return;
  }
  try {
    if (result.status === "ok" || result.status === "skipped") {
      completeTaskRunByRunId({
        runId: result.taskRunId,
        runtime: "cron",
        endedAt: result.endedAt,
        lastEventAt: result.endedAt,
        terminalSummary: result.summary ?? undefined,
      });
      return;
    }
    failTaskRunByRunId({
      runId: result.taskRunId,
      runtime: "cron",
      status:
        normalizeCronRunErrorText(result.error) === timeoutErrorMessage() ? "timed_out" : "failed",
      endedAt: result.endedAt,
      lastEventAt: result.endedAt,
      error: result.status === "error" ? normalizeCronRunErrorText(result.error) : undefined,
      terminalSummary: result.summary ?? undefined,
    });
  } catch (error) {
    state.deps.log.warn(
      { runId: result.taskRunId, jobStatus: result.status, error },
      "cron: failed to update task ledger record",
    );
  }
}
