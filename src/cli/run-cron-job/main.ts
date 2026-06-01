import type { Command } from "commander";
import { getRuntimeConfig } from "../../config/io.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { RunCronAgentTurnResult } from "../../cron/isolated-agent/run.types.js";
import type { CronRunnerResultStatus } from "../../cron/runner-protocol.js";
import { resolveCronSessionTargetSessionKey } from "../../cron/session-target.js";
import { loadCronStore, resolveCronStorePath } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import { routeLogsToStderr } from "../../logging/console.js";
import { assertCronRunnerContext, emitStdoutMarker, writeRunnerResultFile } from "./runtime.js";

export type RunCronJobDeps = {
  runIsolatedAgent: (params: { job: CronJob; message: string }) => Promise<RunCronAgentTurnResult>;
  writeResult: typeof writeRunnerResultFile;
};

function resolveExitCode(status: CronRunnerResultStatus): number {
  return status === "ok" || status === "skipped" ? 0 : 1;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Testable core of the run-cron-job verb. The deps parameter allows test
 * injection of the agent runner and result writer without spawning real processes.
 */
export async function runCronJobHandler(params: {
  jobId: string;
  runId: string;
  deps: RunCronJobDeps;
}): Promise<number> {
  const { jobId, runId, deps } = params;

  const startedAtMs = Date.now();
  let status: CronRunnerResultStatus;
  let error: string | undefined;
  let deliveryReceipt: unknown;

  try {
    // Locate the job in the cron store.
    const storePath = resolveCronStorePath();
    const store = await loadCronStore(storePath);
    const job = store.jobs.find((j) => j.id === jobId);
    if (!job) {
      throw new Error(`cron job not found: ${jobId}`);
    }
    if (job.payload.kind !== "agentTurn") {
      throw new Error(
        `cron job ${jobId} has payload.kind="${job.payload.kind}"; run-cron-job only supports agentTurn`,
      );
    }

    const agentResult = await deps.runIsolatedAgent({ job, message: job.payload.message });

    if (agentResult.status === "ok") {
      status = "ok";
      deliveryReceipt = agentResult.delivery;
    } else if (agentResult.status === "skipped") {
      status = "skipped";
      error = agentResult.error;
    } else {
      status = agentResult.status;
      error = agentResult.error ?? `cron run ${jobId} returned status: ${agentResult.status}`;
    }
  } catch (err) {
    status = "error";
    error = formatError(err);
  }

  const endedAtMs = Date.now();
  const durationMs = endedAtMs - startedAtMs;

  // Result file is authoritative — write it first before emitting the marker.
  try {
    await deps.writeResult({
      jobId,
      runId,
      startedAtMs,
      endedAtMs,
      status,
      ...(error !== undefined ? { error } : {}),
      ...(deliveryReceipt !== undefined ? { deliveryReceipt } : {}),
    });
  } catch (writeErr) {
    process.stderr.write(
      `[run-cron-job] failed to write result file for run ${runId}: ${formatError(writeErr)}\n`,
    );
    // Exit non-zero; parent treats missing result file as orphaned terminal.
    return 1;
  }

  // Stdout marker is the live-path optimization — best-effort after the durable write.
  try {
    emitStdoutMarker({ runId, status, durationMs });
  } catch {
    // Marker emission failure must not corrupt the result — the file is already written.
  }

  return resolveExitCode(status);
}

function createRealDeps(): RunCronJobDeps {
  return {
    runIsolatedAgent: async ({ job, message }) => {
      const cfg = getRuntimeConfig();
      const sessionKey = resolveCronSessionTargetSessionKey(job.sessionTarget) ?? `cron:${job.id}`;
      return await runCronIsolatedAgentTurn({
        cfg,
        deps: {},
        job,
        message,
        sessionKey,
        lane: "cron",
      });
    },
    writeResult: writeRunnerResultFile,
  };
}

export function registerRunCronJobCommand(program: Command): void {
  program
    .command("run-cron-job")
    .description("Execute a single cron job in a subprocess (internal; for cron scheduler use)")
    .argument("<jobId>", "Cron job id to execute")
    .option("--run-id <uuid>", "Run id (UUID); generated if omitted")
    .action(async (jobId: string, opts: { runId?: string }) => {
      // Route all logs to stderr immediately so stdout stays clean for the marker line.
      routeLogsToStderr();

      try {
        assertCronRunnerContext();
      } catch (err) {
        process.stderr.write(`[run-cron-job] ${formatError(err)}\n`);
        process.exit(1);
        return;
      }

      const runId =
        typeof opts.runId === "string" && opts.runId.trim() ? opts.runId : crypto.randomUUID();
      const exitCode = await runCronJobHandler({
        jobId,
        runId,
        deps: createRealDeps(),
      });
      process.exit(exitCode);
    });
}
