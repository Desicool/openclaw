// Design note — two complementary sources of "is this job running?":
//
//   1. activeJobIds (this module's Set)
//      - Module-level global singleton, readable from any subsystem (infra,
//        tasks, tests) without importing the cron service.
//      - Authoritative for cross-subsystem queries: heartbeat-runner skips
//        the session lane while any job is active; task-registry.maintenance
//        treats a session backed by an active cron job as healthy (not lost).
//      - Lifecycle: markCronJobActive() called before execution starts;
//        clearCronJobActive() called in a finally-equivalent position after
//        the run finishes (timer.ts runDueJob/executeJob, ops.ts
//        finishPreparedManualRun). Every mark has a paired clear.
//
//   2. CronServiceState.pidTable (Map<jobId, CronSubprocessEntry>)
//      - Lives on the service-state object; only accessible inside the cron
//        service itself.
//      - Authoritative for in-service subprocess concerns: collision guard
//        (skip if child still alive), signal propagation (SIGTERM/SIGKILL),
//        and exit-code reading.
//      - Lifecycle: set immediately after spawn, deleted after child "close"
//        event fires — scoped entirely within executeJobInSubprocess().
//
//   The two are intentionally redundant for the subprocess execution path.
//   Maintaining both during a spawn (one mark + one pidTable insert) is cheap.
//   Removing the Set in favour of pidTable would require dragging the service
//   state into infra/tasks consumers — wrong architectural direction.

import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CronActiveJobState = {
  activeJobIds: Set<string>;
};

const CRON_ACTIVE_JOB_STATE_KEY = Symbol.for("openclaw.cron.activeJobs");

function getCronActiveJobState(): CronActiveJobState {
  return resolveGlobalSingleton<CronActiveJobState>(CRON_ACTIVE_JOB_STATE_KEY, () => ({
    activeJobIds: new Set<string>(),
  }));
}

export function markCronJobActive(jobId: string) {
  if (!jobId) {
    return;
  }
  getCronActiveJobState().activeJobIds.add(jobId);
}

export function clearCronJobActive(jobId: string) {
  if (!jobId) {
    return;
  }
  getCronActiveJobState().activeJobIds.delete(jobId);
}

export function isCronJobActive(jobId: string) {
  if (!jobId) {
    return false;
  }
  return getCronActiveJobState().activeJobIds.has(jobId);
}

export function hasActiveCronJobs() {
  return getCronActiveJobState().activeJobIds.size > 0;
}

export function resetCronActiveJobsForTests() {
  getCronActiveJobState().activeJobIds.clear();
}
