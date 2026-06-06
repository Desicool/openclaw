/**
 * Periodic sweeper for waiting weekly-report flows.
 *
 *  - Past `reminderAfterDays` and `!reminderSentAt` → enqueue a reminder system event into the
 *    recipient session and set `reminderSentAt` via a CAS `setWaiting` (concurrent sweepers race
 *    on revision and only one wins).
 *  - Past `failAfterDays` → CAS `fail` with reason='expired'.
 *
 * The sweeper is intentionally simple: it sweeps the configured `recipientSessionKey` only. If
 * the recipient session isn't configured yet, the sweeper is a no-op.
 */

import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/core";
import type { WeeklyReportPluginSettings } from "./settings.js";
import { isWeeklyReportFlowState, WEEKLY_REPORT_STEPS } from "./types.js";

type StopSweeper = () => void;

const MS_PER_DAY = 86_400_000;

export type SweeperDeps = {
  runtime: PluginRuntime;
  controllerId: string;
  settings: WeeklyReportPluginSettings;
  logger: RuntimeLogger;
  now?: () => number;
};

export function startTimeoutSweeper(deps: SweeperDeps): StopSweeper {
  const { runtime, controllerId, settings, logger } = deps;
  const now = deps.now ?? Date.now;

  const recipientSessionKey = settings.recipientSessionKey;
  if (!recipientSessionKey) {
    logger.info("weekly-report: timeout sweeper idle (recipientSessionKey not configured)");
    return () => {};
  }

  const tick = () => {
    try {
      sweepOnce({ runtime, controllerId, settings, recipientSessionKey, now, logger });
    } catch (err) {
      logger.error(`weekly-report sweeper tick failed: ${(err as Error).message}`);
    }
  };

  // Run once at startup so abandoned flows get attention right after gateway boot.
  tick();
  const interval = setInterval(tick, settings.sweeperIntervalMs);
  if (typeof interval.unref === "function") {
    interval.unref();
  }
  return () => clearInterval(interval);
}

export function sweepOnce(params: {
  runtime: PluginRuntime;
  controllerId: string;
  settings: WeeklyReportPluginSettings;
  recipientSessionKey: string;
  now: () => number;
  logger: RuntimeLogger;
}): { reminded: number; failed: number; skipped: number } {
  const { runtime, controllerId, settings, recipientSessionKey, now, logger } = params;
  const bound = runtime.tasks.managedFlows.bindSession({ sessionKey: recipientSessionKey });
  const flows = bound.list();
  const reminderThresholdMs = settings.reminderAfterDays * MS_PER_DAY;
  const failThresholdMs = settings.failAfterDays * MS_PER_DAY;
  const nowTs = now();

  let reminded = 0;
  let failed = 0;
  let skipped = 0;

  for (const flow of flows) {
    if (flow.controllerId !== controllerId) {
      continue;
    }
    if (flow.status !== "waiting") {
      continue;
    }
    if (!isWeeklyReportFlowState(flow.stateJson)) {
      continue;
    }
    const ageMs = nowTs - flow.updatedAt;

    if (ageMs >= failThresholdMs) {
      const result = bound.fail({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson: { ...flow.stateJson, lastError: "expired" } as never,
      });
      if (result.applied) {
        failed += 1;
        logger.info(
          `weekly-report: flow ${flow.flowId} expired (weekKey=${flow.stateJson.weekKey}, ageDays=${(
            ageMs / MS_PER_DAY
          ).toFixed(1)})`,
        );
      } else {
        skipped += 1;
      }
      continue;
    }

    if (ageMs >= reminderThresholdMs && flow.stateJson.reminderSentAt === undefined) {
      const result = bound.setWaiting({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: WEEKLY_REPORT_STEPS.awaitUserReply,
        stateJson: { ...flow.stateJson, reminderSentAt: nowTs } as never,
        waitJson: (flow.waitJson ?? null) as never,
      });
      if (result.applied) {
        try {
          runtime.system.enqueueSystemEvent(
            `Reminder: your weekly-report card for ${flow.stateJson.weekTitle} (flowId=${flow.flowId}) is still waiting for confirmation. Please re-send the card or remind the user politely.`,
            { sessionKey: recipientSessionKey },
          );
        } catch (err) {
          logger.warn(
            `weekly-report: reminder system-event enqueue failed for ${flow.flowId}: ${
              (err as Error).message
            }`,
          );
        }
        reminded += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    skipped += 1;
  }

  return { reminded, failed, skipped };
}
