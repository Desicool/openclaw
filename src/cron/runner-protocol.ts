// Wire contract between the cron parent (scheduler) and the cron child runner.
// Schemas only — runtime I/O lives in the parent (`src/cron/service/...`) and
// child (`src/cli/run-cron-job/...`). The result file is the authoritative
// terminal record; the stdout marker is the live-path optimization.

import AjvPkg, { type ValidateFunction } from "ajv";
import { type Static, Type } from "typebox";

export const CronRunnerResultStatusSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("timeout"),
]);

export const CronRunnerResultFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    jobId: Type.String({ minLength: 1 }),
    status: CronRunnerResultStatusSchema,
    startedAtMs: Type.Integer({ minimum: 0 }),
    endedAtMs: Type.Integer({ minimum: 0 }),
    error: Type.Optional(Type.String()),
    deliveryReceipt: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const CRON_RUNNER_STDOUT_MARKER_PREFIX = "OPENCLAW_CRON_RESULT ";

export const CronRunnerStdoutMarkerSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    status: CronRunnerResultStatusSchema,
    durationMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const CronJobRunningEntrySchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    pid: Type.Integer({ minimum: 1 }),
    startedAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const CronJobTerminalRecordSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    status: CronRunnerResultStatusSchema,
    endedAtMs: Type.Integer({ minimum: 0 }),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type CronRunnerResultStatus = Static<typeof CronRunnerResultStatusSchema>;
export type CronRunnerResultFile = Static<typeof CronRunnerResultFileSchema>;
export type CronRunnerStdoutMarker = Static<typeof CronRunnerStdoutMarkerSchema>;
export type CronJobRunningEntry = Static<typeof CronJobRunningEntrySchema>;
export type CronJobTerminalRecord = Static<typeof CronJobTerminalRecordSchema>;

// AJV validator compiled at module load — pay the compile cost once, not per call.
type AjvInstance = { compile<T>(schema: unknown): ValidateFunction<T> };
const AjvCtor = AjvPkg as unknown as new (opts?: object) => AjvInstance;
const validateStdoutMarker: ValidateFunction<CronRunnerStdoutMarker> = new AjvCtor({
  allErrors: false,
  strict: false,
}).compile<CronRunnerStdoutMarker>(CronRunnerStdoutMarkerSchema);

// Compose the relative path under `~/.openclaw/cron/runs/`. Callers join with
// the runs directory. Reject any traversal-style id; cron core controls these
// values, so a violation here is a programming error worth surfacing loudly.
export function buildResultFileRelativePath(jobId: string, runId: string): string {
  assertSafeIdSegment("jobId", jobId);
  assertSafeIdSegment("runId", runId);
  return `${jobId}/${runId}.result.json`;
}

function assertSafeIdSegment(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`cron runner-protocol: ${label} must be a non-empty string`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`cron runner-protocol: ${label} must not contain "/", "\\\\", or ".."`);
  }
}

export function formatStdoutMarkerLine(payload: CronRunnerStdoutMarker): string {
  return `${CRON_RUNNER_STDOUT_MARKER_PREFIX}${JSON.stringify(payload)}\n`;
}

export function tryParseStdoutMarkerLine(line: string): CronRunnerStdoutMarker | null {
  if (typeof line !== "string") {
    return null;
  }
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (!trimmed.startsWith(CRON_RUNNER_STDOUT_MARKER_PREFIX)) {
    return null;
  }
  const jsonPart = trimmed.slice(CRON_RUNNER_STDOUT_MARKER_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return null;
  }
  if (!validateStdoutMarker(parsed)) {
    return null;
  }
  return parsed;
}
