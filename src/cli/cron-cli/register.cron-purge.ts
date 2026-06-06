import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Command } from "commander";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveGatewayPort } from "../../config/paths.js";
import { parseAbsoluteTimeMs } from "../../cron/parse.js";
import { loadCronStoreSync, resolveCronStorePath, saveCronStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import { replaceFileAtomic } from "../../infra/replace-file.js";
import { defaultRuntime, type OutputRuntimeEnv } from "../../runtime.js";
import { handleCronCliError } from "./shared.js";

const ZOMBIE_AGE_MS = 14 * 86_400_000;
const EXPIRED_AGE_MS = 7 * 86_400_000;
const GATEWAY_PROBE_TIMEOUT_MS = 500;
const MAX_ARCHIVE_COLLISIONS = 1000;
const DEFERRED_PHASE_2_REASON =
  "deferred to Phase 2 (requires runId / idempotencyKey fields not yet present)";
const GATEWAY_UP_MESSAGE =
  "openclaw gateway is currently running. Stop it (`openclaw gateway stop`) before running `cron purge`, or use the gateway-up path planned for Phase 2.";

export type RunCronPurgeFlags = {
  dryRun: boolean;
  orphaned: boolean;
  staleRunning: boolean;
  duplicates: boolean;
  zombies: boolean;
  expired: boolean;
  force: boolean;
};

export type RunCronPurgeInput = {
  flags: RunCronPurgeFlags;
};

export type ZombieEntry = { path: string; sizeBytes: number; mtimeMs: number };
export type ExpiredEntry = { id: string; name: string; fireAtMs: number };

export type PurgeReport = {
  dryRun: boolean;
  classifiers: {
    orphaned: { status: "deferred"; reason: string } | null;
    staleRunning: { status: "deferred"; reason: string } | null;
    duplicates: { status: "deferred"; reason: string } | null;
    zombies: { files: ZombieEntry[]; emptyDirsRemoved: string[] } | null;
    expired: { jobs: ExpiredEntry[] } | null;
  };
  archive: { jobsJson?: string };
};

export type RunCronPurgeDeps = {
  storePath?: string;
  nowMs?: number;
  probeGatewayUp?: () => Promise<boolean>;
};

type CommanderPurgeOpts = {
  dryRun?: boolean;
  orphaned?: boolean;
  staleRunning?: boolean;
  duplicates?: boolean;
  zombies?: boolean;
  expired?: boolean;
  all?: boolean;
  force?: boolean;
  json?: boolean;
};

export function registerCronPurgeCommand(cron: Command) {
  cron
    .command("purge")
    .description("Preventively clean leaked, expired, or zombie cron entries (local)")
    .option("--dry-run", "Print what would be removed; make no changes", false)
    .option("--orphaned", `Orphan-running classifier (${DEFERRED_PHASE_2_REASON})`, false)
    .option("--stale-running", `Stale-running classifier (${DEFERRED_PHASE_2_REASON})`, false)
    .option(
      "--duplicates",
      `Duplicate idempotencyKey classifier (${DEFERRED_PHASE_2_REASON})`,
      false,
    )
    .option("--zombies", "Remove run-artifact files older than 14 days", false)
    .option(
      "--expired",
      "Remove `at` jobs whose fireAt is more than 7 days in the past and not currently running",
      false,
    )
    .option("--all", "Enable every classifier flag", false)
    .option(
      "--force",
      "Required to remove duplicates (no-op in Phase 1); not required for zombies/expired",
      false,
    )
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (opts: CommanderPurgeOpts) => {
      try {
        const all = Boolean(opts.all);
        const flags: RunCronPurgeFlags = {
          dryRun: Boolean(opts.dryRun),
          orphaned: Boolean(opts.orphaned) || all,
          staleRunning: Boolean(opts.staleRunning) || all,
          duplicates: Boolean(opts.duplicates) || all,
          zombies: Boolean(opts.zombies) || all,
          expired: Boolean(opts.expired) || all,
          force: Boolean(opts.force),
        };
        const anyClassifier =
          flags.orphaned ||
          flags.staleRunning ||
          flags.duplicates ||
          flags.zombies ||
          flags.expired;
        if (!anyClassifier) {
          throw new Error(
            "specify at least one classifier flag (--orphaned, --stale-running, --duplicates, --zombies, --expired, --all) or use --dry-run --all to preview",
          );
        }
        const report = await runCronPurge({ flags });
        if (opts.json) {
          defaultRuntime.writeJson(report);
        } else {
          printHumanReport(defaultRuntime, report);
        }
      } catch (err) {
        handleCronCliError(err);
      }
    });
}

/**
 * Pure orchestration for cron purge. Returns a structured report; never
 * prints, never exits. CLI/doctor surface results their own way.
 */
export async function runCronPurge(
  input: RunCronPurgeInput,
  deps: RunCronPurgeDeps = {},
): Promise<PurgeReport> {
  const { flags } = input;
  const nowMs = deps.nowMs ?? Date.now();

  const probeGatewayUp = deps.probeGatewayUp ?? probeGatewayUpDefault;
  if (!flags.dryRun) {
    const gatewayUp = await probeGatewayUp();
    if (gatewayUp) {
      throw new Error(GATEWAY_UP_MESSAGE);
    }
  }

  const storePath = resolveCronStorePath(deps.storePath);
  const cronDir = path.dirname(storePath);
  const runsDir = path.join(cronDir, "runs");

  const report: PurgeReport = {
    dryRun: flags.dryRun,
    classifiers: {
      orphaned: flags.orphaned ? { status: "deferred", reason: DEFERRED_PHASE_2_REASON } : null,
      staleRunning: flags.staleRunning
        ? { status: "deferred", reason: DEFERRED_PHASE_2_REASON }
        : null,
      duplicates: flags.duplicates ? { status: "deferred", reason: DEFERRED_PHASE_2_REASON } : null,
      zombies: flags.zombies ? { files: [], emptyDirsRemoved: [] } : null,
      expired: flags.expired ? { jobs: [] } : null,
    },
    archive: {},
  };

  if (flags.zombies) {
    const found = classifyZombies(runsDir, nowMs);
    // Sort by path so removal order and reports are deterministic across
    // platforms (readdir order is FS-dependent).
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    report.classifiers.zombies = { files: found, emptyDirsRemoved: [] };
  }

  let expiredJobs: ExpiredEntry[] = [];
  if (flags.expired) {
    expiredJobs = classifyExpired(storePath, nowMs);
    report.classifiers.expired = { jobs: expiredJobs };
  }

  if (!flags.dryRun) {
    if (
      flags.zombies &&
      report.classifiers.zombies &&
      report.classifiers.zombies.files.length > 0
    ) {
      const classified = report.classifiers.zombies.files;
      const removed: ZombieEntry[] = [];
      let firstError: { path: string; err: unknown } | null = null;
      for (const entry of classified) {
        try {
          fs.rmSync(entry.path, { force: true });
          removed.push(entry);
        } catch (err) {
          firstError = { path: entry.path, err };
          break;
        }
      }
      // The report must reflect on-disk state, not intent: only files we
      // actually removed are listed. emptyDirsRemoved is computed from the
      // verified-removed set so we never claim a dir was cleaned that still
      // holds files.
      report.classifiers.zombies.files = removed;
      report.classifiers.zombies.emptyDirsRemoved = removeEmptyJobDirs(runsDir, removed);
      if (firstError) {
        const cause =
          firstError.err instanceof Error ? firstError.err.message : String(firstError.err);
        throw new Error(
          `removed ${String(removed.length)} of ${String(classified.length)} zombie file(s) before failing on ${firstError.path}: ${cause}`,
        );
      }
    }

    if (flags.expired && expiredJobs.length > 0) {
      const archivePath = await archiveJobsJson(storePath, nowMs);
      report.archive.jobsJson = archivePath;
      await removeExpiredJobsFromStore(storePath, expiredJobs);
    }
  }

  return report;
}

export function probeGatewayUpDefault(): Promise<boolean> {
  // Canonical port resolution: env override > config > default. The config
  // path stays undefined here because purge is a local-only command and we do
  // not pull the full config graph in just to read one field; env override
  // covers the common case in CI/scripted scenarios.
  return probeTcpPort(resolveGatewayPort(undefined, process.env), GATEWAY_PROBE_TIMEOUT_MS);
}

function probeTcpPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

function classifyZombies(runsDir: string, nowMs: number): ZombieEntry[] {
  const cutoff = nowMs - ZOMBIE_AGE_MS;
  const found: ZombieEntry[] = [];
  let topLevel: fs.Dirent[];
  try {
    topLevel = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return found;
    }
    throw err;
  }
  for (const entry of topLevel) {
    const entryPath = path.join(runsDir, entry.name);
    if (entry.isDirectory()) {
      walkZombiesInJobDir(entryPath, cutoff, found);
      continue;
    }
    if (entry.isFile()) {
      const stat = safeStat(entryPath);
      if (stat && stat.mtimeMs < cutoff) {
        found.push({ path: entryPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  return found;
}

function walkZombiesInJobDir(jobDir: string, cutoffMs: number, out: ZombieEntry[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(jobDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(jobDir, entry.name);
    if (entry.isDirectory()) {
      walkZombiesInJobDir(entryPath, cutoffMs, out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!isZombieCandidateName(entry.name)) {
      continue;
    }
    const stat = safeStat(entryPath);
    if (stat && stat.mtimeMs < cutoffMs) {
      out.push({ path: entryPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
}

function isZombieCandidateName(name: string): boolean {
  return (
    name.endsWith(".jsonl") ||
    name.endsWith(".result.json") ||
    name.endsWith(".pid") ||
    name.startsWith("session-")
  );
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function removeEmptyJobDirs(runsDir: string, removed: ZombieEntry[]): string[] {
  const candidateDirs = new Set<string>();
  for (const entry of removed) {
    const parent = path.dirname(entry.path);
    if (parent !== runsDir && parent.startsWith(`${runsDir}${path.sep}`)) {
      candidateDirs.add(parent);
    }
  }
  const removedDirs: string[] = [];
  for (const dir of candidateDirs) {
    try {
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) {
        fs.rmdirSync(dir);
        removedDirs.push(dir);
      }
    } catch {
      // best-effort
    }
  }
  return removedDirs;
}

function classifyExpired(storePath: string, nowMs: number): ExpiredEntry[] {
  const store = loadCronStoreSync(storePath);
  const cutoff = nowMs - EXPIRED_AGE_MS;
  const expired: ExpiredEntry[] = [];
  for (const job of store.jobs) {
    if (job.schedule?.kind !== "at") {
      continue;
    }
    if (job.state?.runningAtMs) {
      continue;
    }
    const fireAtMs = parseAbsoluteTimeMs(job.schedule.at);
    if (fireAtMs === null || fireAtMs >= cutoff) {
      continue;
    }
    expired.push({ id: job.id, name: job.name, fireAtMs });
  }
  return expired;
}

async function removeExpiredJobsFromStore(
  storePath: string,
  expired: ExpiredEntry[],
): Promise<void> {
  const store = loadCronStoreSync(storePath);
  const toRemove = new Set(expired.map((entry) => entry.id));
  const kept: CronJob[] = store.jobs.filter((job) => !toRemove.has(job.id));
  if (kept.length === store.jobs.length) {
    return;
  }
  await saveCronStore(storePath, { version: 1, jobs: kept });
}

async function archiveJobsJson(storePath: string, nowMs: number): Promise<string> {
  const stamp = formatArchiveTimestamp(nowMs);
  let archivePath = buildArchivePath(storePath, stamp, 0);
  let attempt = 1;
  while (fs.existsSync(archivePath)) {
    if (attempt >= MAX_ARCHIVE_COLLISIONS) {
      // Refuse to silently overwrite: a purge tool whose job is "never lose
      // state silently" must not clobber an existing archive after exhausting
      // the tie-breaker suffix space.
      throw new Error(
        `could not allocate purge archive filename within ${String(MAX_ARCHIVE_COLLISIONS)} attempts at ${archivePath}; rerun in a moment`,
      );
    }
    archivePath = buildArchivePath(storePath, stamp, attempt);
    attempt += 1;
  }
  // Export the current SQLite store as JSON for the archive.
  const store = loadCronStoreSync(storePath);
  const content = JSON.stringify({ version: store.version, jobs: store.jobs }, null, 2);
  await replaceFileAtomic({
    filePath: archivePath,
    content,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: ".openclaw-cron-purged",
    renameMaxRetries: 3,
    copyFallbackOnPermissionError: true,
  });
  return archivePath;
}

function buildArchivePath(storePath: string, stamp: string, attempt: number): string {
  const dir = path.dirname(storePath);
  const base = path.basename(storePath, ".json");
  const suffix = attempt === 0 ? stamp : `${stamp}-${String(attempt).padStart(3, "0")}`;
  return path.join(dir, `${base}.json.purged-${suffix}.json`);
}

function formatArchiveTimestamp(nowMs: number): string {
  return new Date(nowMs)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
}

function printHumanReport(runtime: OutputRuntimeEnv, report: PurgeReport): void {
  const heading = report.dryRun ? "cron purge (dry-run)" : "cron purge";
  runtime.log(theme.heading(heading));

  if (report.classifiers.orphaned) {
    runtime.log(`orphaned:      ${report.classifiers.orphaned.reason}`);
  }
  if (report.classifiers.staleRunning) {
    runtime.log(`stale-running: ${report.classifiers.staleRunning.reason}`);
  }
  if (report.classifiers.duplicates) {
    runtime.log(`duplicates:    ${report.classifiers.duplicates.reason}`);
  }

  if (report.classifiers.zombies) {
    const { files, emptyDirsRemoved } = report.classifiers.zombies;
    const verb = report.dryRun ? "would remove" : "removed";
    runtime.log(`zombies:       ${verb} ${String(files.length)} file(s)`);
    for (const file of files) {
      runtime.log(`  - ${file.path}`);
    }
    if (emptyDirsRemoved.length > 0) {
      runtime.log(`  removed ${String(emptyDirsRemoved.length)} empty job dir(s)`);
    }
  }

  if (report.classifiers.expired) {
    const verb = report.dryRun ? "would remove" : "removed";
    const expired = report.classifiers.expired.jobs;
    runtime.log(`expired:       ${verb} ${String(expired.length)} job(s)`);
    for (const job of expired) {
      runtime.log(`  - ${job.id} (${job.name})`);
    }
  }

  if (report.archive.jobsJson) {
    runtime.log(`archive:       ${report.archive.jobsJson}`);
  }
}
