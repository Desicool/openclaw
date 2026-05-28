/**
 * Cron session reaper — periodic file sweep for cron run artifacts.
 *
 * Phase 2 moved job execution to OS subprocesses that exit naturally, so
 * in-process session tracking is gone.  What remains is a best-effort sweep
 * of the on-disk run artifact tree:
 *
 *   ~/.openclaw/cron/runs/<jobId>/<runId>.result.json
 *   ~/.openclaw/cron/runs/<jobId>/<runId>.pid
 *   ~/.openclaw/cron/runs/<jobId>/session-*.json
 *
 * Files older than retentionMs are removed; empty <jobId>/ directories are
 * pruned afterwards.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigDir } from "../utils.js";

const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export type CronRunsSweepResult = {
  filesRemoved: number;
  emptyDirsRemoved: number;
};

export type CronRunsSweepOptions = {
  /** Override the runs directory (defaults to <configDir>/cron/runs). */
  runsDir?: string;
  /** Files older than this many ms are deleted. Default: 14 days. */
  retentionMs?: number;
  /** Override for testing. Default: Date.now(). */
  nowMs?: number;
};

/**
 * Walk <runsDir>/<jobId>/* one level deep.  For each file matching
 * /(\.result\.json|\.pid|^session-.*\.json)$/, removes if (now - mtime) > retentionMs.
 * After per-job sweep, removes the <jobId>/ dir if it is empty.
 *
 * Returns counts.  Never throws on per-file errors (best-effort); throws only if
 * the runsDir itself is unreadable (e.g. EACCES on root).
 */
export async function sweepCronRunsArtifacts(
  opts: CronRunsSweepOptions = {},
): Promise<CronRunsSweepResult> {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const runsDir = opts.runsDir ?? path.join(resolveConfigDir(), "cron", "runs");

  const cutoff = nowMs - retentionMs;

  let filesRemoved = 0;
  let emptyDirsRemoved = 0;

  // May throw with ENOENT (treated as nothing to sweep) or EACCES (re-thrown).
  let jobDirents: Dirent[];
  try {
    jobDirents = await fs.readdir(runsDir, { withFileTypes: true, encoding: "utf8" });
  } catch (err) {
    if (isEnoent(err)) {
      return { filesRemoved: 0, emptyDirsRemoved: 0 };
    }
    throw err;
  }

  for (const jobDirent of jobDirents) {
    if (!jobDirent.isDirectory()) {
      continue;
    }
    const jobDir = path.join(runsDir, jobDirent.name);

    let fileDirents: Dirent[];
    try {
      fileDirents = await fs.readdir(jobDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      // Best-effort: skip unreadable job dirs.
      continue;
    }

    for (const fileDirent of fileDirents) {
      if (!fileDirent.isFile()) {
        continue;
      }
      if (!isArtifactFile(fileDirent.name)) {
        continue;
      }
      const filePath = path.join(jobDir, fileDirent.name);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filePath);
          filesRemoved++;
        }
      } catch {
        // Best-effort: skip unreadable/already-gone files.
        continue;
      }
    }

    // Remove the job directory if it is now empty.
    try {
      const remaining = await fs.readdir(jobDir);
      if (remaining.length === 0) {
        await fs.rmdir(jobDir);
        emptyDirsRemoved++;
      }
    } catch {
      // Best-effort.
    }
  }

  return { filesRemoved, emptyDirsRemoved };
}

// ---------------------------------------------------------------------------
// Legacy exports — kept so existing callers don't break while they migrate.
// The "in-process session" model was removed in Phase 2 (subprocess execution).
// ---------------------------------------------------------------------------

/** @deprecated Use sweepCronRunsArtifacts instead. In-process session tracking was removed in Phase 2. */
export type ReaperResult = {
  swept: boolean;
  pruned: number;
};

/** @deprecated Params accepted for call-site compat; all are ignored except nowMs. */
export type SweepCronRunSessionsParams = {
  cronConfig?: { sessionRetention?: string | boolean };
  sessionStorePath?: string;
  nowMs?: number;
  log?: unknown;
  force?: boolean;
};

/**
 * @deprecated In-process cron run sessions no longer exist (Phase 2 subprocess
 * execution).  Delegates to sweepCronRunsArtifacts and returns a compat result.
 * The sessionStorePath / cronConfig / log params are ignored.
 */
export async function sweepCronRunSessions(
  params: SweepCronRunSessionsParams,
): Promise<ReaperResult> {
  await sweepCronRunsArtifacts({ nowMs: params.nowMs });
  return { swept: true, pruned: 0 };
}

/**
 * @deprecated In-process session retention config no longer applies.
 * Returns the default 14-day retention value expressed in ms, or null when
 * sessionRetention is explicitly false.
 */
export function resolveRetentionMs(cronConfig?: {
  sessionRetention?: string | boolean;
}): number | null {
  if (cronConfig?.sessionRetention === false) {
    return null;
  }
  return DEFAULT_RETENTION_MS;
}

/**
 * @deprecated The per-store throttle map no longer exists; this is a no-op.
 * Call sweepCronRunsArtifacts directly instead.
 */
export function resetReaperThrottle(): void {
  // No-op: the throttle map was removed with in-process session tracking.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ARTIFACT_RE = /\.result\.json$|\.pid$|^session-.*\.json$/;

function isArtifactFile(name: string): boolean {
  return ARTIFACT_RE.test(name);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
