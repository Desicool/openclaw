import fs from "node:fs/promises";
import path from "node:path";
import type { Static } from "typebox";
import {
  buildResultFileRelativePath,
  CronRunnerResultFileSchema,
  formatStdoutMarkerLine,
  type CronRunnerResultStatus,
  validateCronRunnerResultFile,
} from "../../cron/runner-protocol.js";
import { replaceFileAtomic } from "../../infra/replace-file.js";
import { resolveConfigDir } from "../../utils.js";

export function assertCronRunnerContext(): void {
  if (process.env.OPENCLAW_CRON_RUNNER !== "1") {
    throw new Error(
      "runJob must be invoked via the cron runner subprocess (OPENCLAW_CRON_RUNNER=1 not set)",
    );
  }
}

export type WriteResultFileInput = {
  jobId: string;
  runId: string;
  startedAtMs: number;
  endedAtMs: number;
  status: CronRunnerResultStatus;
  error?: string;
  deliveryReceipt?: unknown;
};

export async function writeRunnerResultFile(
  input: WriteResultFileInput,
  opts?: { runsDir?: string },
): Promise<{ resultFilePath: string }> {
  const runsDir = opts?.runsDir ?? path.join(resolveConfigDir(), "cron", "runs");
  const relativePath = buildResultFileRelativePath(input.jobId, input.runId);
  const resultFilePath = path.join(runsDir, relativePath);

  const payload: Static<typeof CronRunnerResultFileSchema> = {
    schemaVersion: 1,
    runId: input.runId,
    jobId: input.jobId,
    status: input.status,
    startedAtMs: input.startedAtMs,
    endedAtMs: input.endedAtMs,
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.deliveryReceipt !== undefined ? { deliveryReceipt: input.deliveryReceipt } : {}),
  };

  // Internal consistency check — schema violations here are programming errors.
  if (!validateCronRunnerResultFile(payload)) {
    throw new Error(
      `cron runner: result file payload failed schema validation: ${JSON.stringify(validateCronRunnerResultFile.errors)}`,
    );
  }

  await fs.mkdir(path.dirname(resultFilePath), { recursive: true });
  await replaceFileAtomic({
    filePath: resultFilePath,
    content: JSON.stringify(payload, null, 2),
    mode: 0o600,
    tempPrefix: ".openclaw-cron-run",
  });

  return { resultFilePath };
}

export function emitStdoutMarker(payload: {
  runId: string;
  status: CronRunnerResultStatus;
  durationMs: number;
}): void {
  process.stdout.write(formatStdoutMarkerLine(payload));
}
