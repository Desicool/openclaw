import type { CronJob } from "./types.js";

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function schedulePayloadFromRecord(
  schedule: Record<string, unknown>,
): { kind: "at"; at: string } | { kind: "cron"; expr: string; staggerMs?: number } | undefined {
  const rawKind = readString(schedule, "kind")?.toLowerCase();
  const expr = readString(schedule, "expr") ?? readString(schedule, "cron");
  const at = readString(schedule, "at");
  const atMs = readNumber(schedule, "atMs");
  const staggerMs = readNumber(schedule, "staggerMs");
  const kind =
    rawKind === "at" || rawKind === "cron"
      ? rawKind
      : at || atMs !== undefined
        ? "at"
        : expr
          ? "cron"
          : undefined;

  if (kind === "at") {
    return at
      ? { kind: "at", at }
      : atMs !== undefined
        ? { kind: "at", at: String(atMs) }
        : undefined;
  }
  if (kind === "cron" && expr) {
    return { kind: "cron", expr, staggerMs };
  }
  return undefined;
}

function resolveSchedulePayload(
  job: { schedule?: unknown } & Record<string, unknown>,
): ReturnType<typeof schedulePayloadFromRecord> {
  if (job.schedule && typeof job.schedule === "object" && !Array.isArray(job.schedule)) {
    return schedulePayloadFromRecord(job.schedule as Record<string, unknown>);
  }
  return schedulePayloadFromRecord(job);
}

export function tryCronScheduleIdentity(
  job: { schedule?: unknown; enabled?: unknown } & Record<string, unknown>,
): string | undefined {
  const schedule = resolveSchedulePayload(job);
  if (!schedule) {
    return undefined;
  }
  return JSON.stringify({
    version: 1,
    enabled: typeof job.enabled === "boolean" ? job.enabled : true,
    schedule,
  });
}

export function cronSchedulingInputsEqual(
  previous: Pick<CronJob, "schedule"> & { enabled?: unknown },
  next: Pick<CronJob, "schedule"> & { enabled?: unknown },
): boolean {
  const previousIdentity = tryCronScheduleIdentity(previous as Record<string, unknown>);
  const nextIdentity = tryCronScheduleIdentity(next as Record<string, unknown>);
  return (
    previousIdentity !== undefined &&
    nextIdentity !== undefined &&
    previousIdentity === nextIdentity
  );
}
