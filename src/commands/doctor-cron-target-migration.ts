import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronStorePath } from "../cron/store.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";

export type CronTargetMigrationStats = {
  examined: number;
  migrated: number;
  archived: number;
  unmigratable: number;
};

export type MaybeMigrateLegacyCronSessionTargetsParams = {
  cfg: OpenClawConfig;
  options: DoctorOptions;
  prompter: DoctorPrompter;
};

function formatArchiveTimestamp(nowMs: number): string {
  return new Date(nowMs)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
}

function buildArchivePath(storePath: string, suffix: string): string {
  const dir = path.dirname(storePath);
  const base = path.basename(storePath, ".json");
  return path.join(dir, `${base}.json.target-migrated-${suffix}.json`);
}

function findNonIsolatedJobs(
  rawJobs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rawJobs.filter(
    (job) => typeof job.sessionTarget === "string" && job.sessionTarget !== "isolated",
  );
}

export async function maybeMigrateLegacyCronSessionTargets(
  params: MaybeMigrateLegacyCronSessionTargetsParams,
): Promise<void> {
  const storePath = resolveCronStorePath(params.cfg.cron?.store);

  let raw: string;
  try {
    raw = fs.readFileSync(storePath, "utf-8");
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }
  const store = parsed as Record<string, unknown>;
  if (!Array.isArray(store.jobs)) {
    return;
  }
  const rawJobs = (store.jobs as unknown[]).filter(
    (j): j is Record<string, unknown> => j !== null && typeof j === "object" && !Array.isArray(j),
  );

  const nonIsolated = findNonIsolatedJobs(rawJobs);
  if (nonIsolated.length === 0) {
    return;
  }

  const stats: CronTargetMigrationStats = {
    examined: rawJobs.length,
    migrated: 0,
    archived: 0,
    unmigratable: 0,
  };

  // Always surface a preview note so the user knows what would change.
  note(
    [
      `${nonIsolated.length} cron job(s) at ${shortenHomePath(storePath)} have a non-isolated sessionTarget:`,
      ...nonIsolated.map(
        (job) =>
          `  - ${typeof job.id === "string" ? job.id : "<unknown>"} (sessionTarget: ${String(job.sessionTarget)})`,
      ),
      `Run \`openclaw doctor --fix\` to migrate these jobs to sessionTarget: "isolated".`,
    ].join("\n"),
    "Cron sessionTarget migration",
  );

  if (!params.prompter.shouldRepair) {
    return;
  }

  // Archive the current jobs.json before mutating.
  const archiveSuffix = formatArchiveTimestamp(Date.now());
  const archivePath = buildArchivePath(storePath, archiveSuffix);
  try {
    fs.copyFileSync(storePath, archivePath);
    stats.archived = 1;
  } catch (err) {
    note(
      `Could not archive ${shortenHomePath(storePath)} before migration: ${String(err)}. Skipping.`,
      "Cron sessionTarget migration",
    );
    return;
  }

  // Rewrite sessionTarget = "isolated" for all non-isolated jobs.
  for (const job of rawJobs) {
    if (typeof job.sessionTarget === "string" && job.sessionTarget !== "isolated") {
      job.sessionTarget = "isolated";
      stats.migrated++;
    }
  }

  const updated = JSON.stringify({ ...store, jobs: rawJobs }, null, 2);
  fs.writeFileSync(storePath, updated, "utf-8");

  note(
    [
      `Migrated ${stats.migrated} job(s) to sessionTarget: "isolated" at ${shortenHomePath(storePath)}.`,
      `Archived prior jobs.json to ${shortenHomePath(archivePath)}.`,
    ].join("\n"),
    "Doctor changes",
  );
}
