/**
 * Boot reconcile for subprocess-executed cron jobs.
 *
 * When the gateway restarts it calls reconcileSubprocessJobs() inside the
 * startup lock, BEFORE the interrupt sweep in ops.start().  For every job
 * that has a persisted `state.running` entry (written by executeJobInSubprocess
 * before it spawned the child):
 *
 *   1. If a result file exists for the run:  apply the terminal state from it
 *      (clear running + runningAtMs, set lastRunStatus/lastError).
 *
 *   2. If no result file but the pid is alive with a matching start time:
 *      the subprocess is still running — clear runningAtMs only (keeps the
 *      `running` block so the scheduler re-attaches after restart) and skip
 *      the interrupt sweep for this job.
 *
 *   3. Otherwise (pid dead or recycled, no result file):  clear both
 *      `running` and `runningAtMs`.  The job has no terminal record; it will
 *      be treated as if it never started (no false error increment).
 *
 * Return value: set of jobIds that were reconciled as still-alive (case 2).
 * The caller (ops.start) uses this set to skip those jobs in the interrupt sweep.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { readProcessStartTimeMs } from "../../infra/process-start-time.js";
import { resolveConfigDir } from "../../utils.js";
import {
  buildResultFileRelativePath,
  validateCronRunnerResultFile,
} from "../runner-protocol.js";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";

// Maximum start-time delta (ms) between the persisted value and the OS-reported
// value before the pid is treated as recycled.  2 s matches the feature-branch
// convention; ps lstart resolution is typically 1 s so 2 s gives one clock
// step of tolerance.
const PID_START_TIME_TOLERANCE_MS = 2_000;

export type SubprocessReconcileOutcome =
  | { kind: "terminal"; status: "ok" | "error" | "skipped"; error?: string }
  | { kind: "alive" }
  | { kind: "orphan" };

/**
 * Attempt to read and validate the result file for a run.
 * Returns the result file contents on success, null otherwise.
 */
async function tryReadResultFile(
  jobId: string,
  runId: string,
): Promise<{ status: "ok" | "error" | "skipped"; error?: string } | null> {
  try {
    const runsDir = path.join(resolveConfigDir(), "cron", "runs");
    const relPath = buildResultFileRelativePath(jobId, runId);
    const resultFilePath = path.join(runsDir, relPath);
    const raw = await fs.readFile(resultFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (validateCronRunnerResultFile(parsed)) {
      const status = parsed.status === "timeout" ? "error" : parsed.status;
      return { status, error: parsed.error };
    }
  } catch {
    // Missing or unparseable result file — fall through.
  }
  return null;
}

/**
 * Check whether a pid is still alive with a start time that matches the
 * persisted startedAtMs (within tolerance).
 */
async function isPidAliveWithMatchingStartTime(
  pid: number,
  persistedStartedAtMs: number,
): Promise<boolean> {
  const result = await readProcessStartTimeMs(pid);
  if (result.kind !== "ok") {
    return false;
  }
  const delta = Math.abs(result.startedAtMs - persistedStartedAtMs);
  return delta <= PID_START_TIME_TOLERANCE_MS;
}

/**
 * Determine the outcome for a single subprocess running entry.
 */
async function resolveSubprocessOutcome(
  jobId: string,
  running: { runId: string; pid?: number; startedAtMs?: number },
): Promise<SubprocessReconcileOutcome> {
  // Case 1: result file present → apply terminal state.
  const fromFile = await tryReadResultFile(jobId, running.runId);
  if (fromFile) {
    return { kind: "terminal", status: fromFile.status, error: fromFile.error };
  }

  // Case 2/3: no result file — check if the pid is still alive.
  const pid = running.pid;
  const startedAtMs = running.startedAtMs;
  if (typeof pid === "number" && pid > 0 && typeof startedAtMs === "number") {
    const alive = await isPidAliveWithMatchingStartTime(pid, startedAtMs);
    if (alive) {
      return { kind: "alive" };
    }
  }

  // Case 3: pid dead / recycled / unknown — orphan.
  return { kind: "orphan" };
}

/**
 * Apply a terminal result from a result file to a job's state, clearing the
 * running marker.  This is a minimal apply used only during boot reconcile;
 * it does not recompute delivery state or emit events (that is deferred to
 * ops.start after the reconcile pass).
 */
function applyTerminalFromFile(
  job: CronJob,
  result: { status: "ok" | "error" | "skipped"; error?: string },
  nowMs: number,
): void {
  const runningAtMs = job.state.runningAtMs ?? nowMs;
  job.state.running = undefined;
  job.state.runningAtMs = undefined;
  job.state.lastRunAtMs = runningAtMs;
  job.state.lastRunStatus = result.status;
  job.state.lastStatus = result.status;
  job.state.lastError = result.error;
  job.state.lastDurationMs = Math.max(0, nowMs - runningAtMs);
  if (result.status === "ok") {
    job.state.consecutiveErrors = 0;
  } else if (result.status === "error") {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
  }
  job.updatedAtMs = nowMs;
}

/**
 * Reconcile all jobs with a persisted subprocess running entry.
 *
 * Called from ops.start() after ensureLoaded (between two lock acquisitions
 * — async I/O for pid/result-file checks must not hold the store lock).
 * Mutates job state in-place; the caller is responsible for persisting.
 *
 * Returns a Set of jobIds that were found alive (case 2) — the interrupt
 * sweep in ops.start() should skip these.
 */
export async function reconcileSubprocessJobs(
  state: CronServiceState,
): Promise<Set<string>> {
  const liveJobIds = new Set<string>();
  const jobs = state.store?.jobs ?? [];

  for (const job of jobs) {
    job.state ??= {};
    const running = job.state.running;
    if (!running || typeof running.runId !== "string" || !running.runId) {
      // No subprocess running entry — not a subprocess job, skip.
      continue;
    }

    const outcome = await resolveSubprocessOutcome(job.id, running);

    if (outcome.kind === "terminal") {
      const nowMs = state.deps.nowMs();
      state.deps.log.info(
        { jobId: job.id, runId: running.runId, status: outcome.status },
        "cron: boot-reconcile: applied terminal state from result file",
      );
      applyTerminalFromFile(job, { status: outcome.status, error: outcome.error }, nowMs);
    } else if (outcome.kind === "alive") {
      state.deps.log.info(
        { jobId: job.id, runId: running.runId, pid: running.pid },
        "cron: boot-reconcile: subprocess still alive, leaving running state",
      );
      // Clear runningAtMs so the interrupt sweep in start() does not falsely
      // mark this job as failed.  The `running` block stays intact so future
      // timer ticks know a child is live.
      job.state.runningAtMs = undefined;
      liveJobIds.add(job.id);
    } else {
      // Orphan: pid dead or unverifiable, no result file.
      state.deps.log.warn(
        { jobId: job.id, runId: running.runId, pid: running.pid },
        "cron: boot-reconcile: subprocess orphaned (pid dead, no result file); clearing running state",
      );
      job.state.running = undefined;
      job.state.runningAtMs = undefined;
    }
  }

  return liveJobIds;
}
