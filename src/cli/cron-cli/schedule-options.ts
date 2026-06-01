import type { CronSchedule } from "../../cron/types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { parseAt, parseCronStaggerMs } from "./shared.js";

type ScheduleOptionInput = {
  at?: unknown;
  cron?: unknown;
  every?: unknown;
  exact?: unknown;
  stagger?: unknown;
};

type NormalizedScheduleOptions = {
  at: string;
  cronExpr: string;
  requestedStaggerMs: number | undefined;
};

export type CronEditScheduleRequest =
  | { kind: "direct"; schedule: CronSchedule }
  | { kind: "patch-existing-cron"; staggerMs: number | undefined }
  | { kind: "none" };

export function resolveCronCreateSchedule(options: ScheduleOptionInput): CronSchedule {
  const normalized = normalizeScheduleOptions(options);
  const chosen = countChosenSchedules(normalized);
  if (chosen !== 1) {
    throw new Error("Choose exactly one schedule: --at or --cron");
  }
  const schedule = resolveDirectSchedule(normalized);
  if (!schedule) {
    throw new Error("Choose exactly one schedule: --at or --cron");
  }
  return schedule;
}

export function resolveCronEditScheduleRequest(
  options: ScheduleOptionInput,
): CronEditScheduleRequest {
  const normalized = normalizeScheduleOptions(options);
  const chosen = countChosenSchedules(normalized);
  if (chosen > 1) {
    throw new Error("Choose at most one schedule change");
  }
  const schedule = resolveDirectSchedule(normalized);
  if (schedule) {
    return { kind: "direct", schedule };
  }
  if (normalized.requestedStaggerMs !== undefined) {
    return {
      kind: "patch-existing-cron",
      staggerMs: normalized.requestedStaggerMs,
    };
  }
  return { kind: "none" };
}

export function applyExistingCronSchedulePatch(
  existingSchedule: CronSchedule,
  request: Extract<CronEditScheduleRequest, { kind: "patch-existing-cron" }>,
): CronSchedule {
  if (existingSchedule.kind !== "cron") {
    throw new Error("Current job is not a cron schedule; use --cron to convert first");
  }
  return {
    kind: "cron",
    expr: existingSchedule.expr,
    staggerMs: request.staggerMs !== undefined ? request.staggerMs : existingSchedule.staggerMs,
  };
}

function normalizeScheduleOptions(options: ScheduleOptionInput): NormalizedScheduleOptions {
  const staggerRaw = normalizeOptionalString(options.stagger) ?? "";
  const useExact = Boolean(options.exact);
  if (staggerRaw && useExact) {
    throw new Error("Choose either --stagger or --exact, not both");
  }
  if ((options as { tz?: unknown }).tz) {
    throw new Error("--tz is no longer supported; per-job timezone has been removed");
  }
  if ((options as { every?: unknown }).every) {
    throw new Error("--every is no longer supported; use --cron with a cron expression instead");
  }
  return {
    at: normalizeOptionalString(options.at) ?? "",
    cronExpr: normalizeOptionalString(options.cron) ?? "",
    requestedStaggerMs: parseCronStaggerMs({ staggerRaw, useExact }),
  };
}

function countChosenSchedules(options: NormalizedScheduleOptions): number {
  return [Boolean(options.at), Boolean(options.cronExpr)].filter(Boolean).length;
}

function resolveDirectSchedule(options: NormalizedScheduleOptions): CronSchedule | undefined {
  if (options.requestedStaggerMs !== undefined && options.at) {
    throw new Error("--stagger/--exact are only valid for cron schedules");
  }
  if (options.at) {
    const atIso = parseAt(options.at);
    if (!atIso) {
      throw new Error("Invalid --at. Use an ISO timestamp or a duration like 20m.");
    }
    return { kind: "at", at: atIso };
  }
  if (options.cronExpr) {
    return {
      kind: "cron",
      expr: options.cronExpr,
      staggerMs: options.requestedStaggerMs,
    };
  }
  return undefined;
}
