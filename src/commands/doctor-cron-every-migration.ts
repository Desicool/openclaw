import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronStorePath } from "../cron/store.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";

export type CronEveryMigrationStats = {
  examined: number; // count of kind:"every" jobs found
  converted: number;
  archived: number;
  unmigratable: number;
};

export type MaybeMigrateLegacyCronEveryKindParams = {
  cfg: OpenClawConfig;
  options: DoctorOptions;
  prompter: DoctorPrompter;
};

type ConvertResult = { expr: string } | { unmigratable: true; reason: string };

function everyMsToCronExpr(everyMs: number, anchorMs: number | undefined): ConvertResult {
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    return { unmigratable: true, reason: "invalid everyMs" };
  }
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // Compute anchor offsets (in the gateway's local TZ) — preserved when expressible.
  // Default to 0 if anchor is missing/invalid.
  const validAnchor =
    typeof anchorMs === "number" && Number.isFinite(anchorMs) ? new Date(anchorMs) : null;
  const anchorMinute = validAnchor ? validAnchor.getMinutes() : 0;
  const anchorHour = validAnchor ? validAnchor.getHours() : 0;

  // Sub-minute → not expressible in 5-field cron
  if (everyMs < MIN) {
    return {
      unmigratable: true,
      reason: "everyMs below 1 minute is not expressible in 5-field cron",
    };
  }

  // everyMs must divide evenly by 1 minute
  if (everyMs % MIN !== 0) {
    return { unmigratable: true, reason: "everyMs is not a multiple of 1 minute" };
  }

  if (everyMs < HOUR) {
    // every N minutes; N must be a clean divisor of 60 for */N to fire on minute 0 reliably
    const stepMin = everyMs / MIN;
    if (60 % stepMin !== 0) {
      return {
        unmigratable: true,
        reason: `everyMs=${everyMs} (${stepMin}min) is not a clean divisor of 60 minutes`,
      };
    }
    if (stepMin === 1) {
      return { expr: "* * * * *" };
    }
    return { expr: `*/${stepMin} * * * *` };
  }

  if (everyMs < DAY) {
    if (everyMs % HOUR !== 0) {
      return {
        unmigratable: true,
        reason: "everyMs is hours-scale but not a multiple of 1 hour",
      };
    }
    const stepHour = everyMs / HOUR;
    if (24 % stepHour !== 0) {
      return {
        unmigratable: true,
        reason: `everyMs=${stepHour}h is not a clean divisor of 24 hours`,
      };
    }
    if (stepHour === 1) {
      return { expr: `${anchorMinute} * * * *` };
    }
    return { expr: `${anchorMinute} */${stepHour} * * *` };
  }

  // Daily and beyond
  if (everyMs === DAY) {
    return { expr: `${anchorMinute} ${anchorHour} * * *` };
  }
  if (everyMs > DAY && everyMs % DAY === 0) {
    const stepDay = everyMs / DAY;
    // No clean */N pattern for day-of-month in standard cron (months have variable length).
    // Acceptable expression: every N days starting from anchorDayOfMonth — but this isn't truly */N safe.
    // Mark unmigratable; user should adjust manually.
    return {
      unmigratable: true,
      reason: `everyMs=${stepDay}d not cleanly expressible; user should choose a specific schedule`,
    };
  }

  return {
    unmigratable: true,
    reason: `everyMs=${everyMs} cannot be cleanly converted to 5-field cron`,
  };
}

function formatArchiveTimestamp(nowMs: number): string {
  return new Date(nowMs)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
}

function buildArchivePath(storePath: string, suffix: string): string {
  const dir = path.dirname(storePath);
  const base = path.basename(storePath, ".json");
  return path.join(dir, `${base}.json.every-migrated-${suffix}.json`);
}

export async function maybeMigrateLegacyCronEveryKind(
  params: MaybeMigrateLegacyCronEveryKindParams,
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

  // Find kind:every jobs.
  type EveryJob = {
    job: Record<string, unknown>;
    schedule: Record<string, unknown>;
    everyMs: number;
    anchorMs: number | undefined;
    result: ConvertResult;
  };

  const everyJobs: EveryJob[] = [];
  for (const job of rawJobs) {
    const schedule = job.schedule;
    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
      continue;
    }
    const sched = schedule as Record<string, unknown>;
    if (sched.kind !== "every") {
      continue;
    }
    const everyMs = typeof sched.everyMs === "number" ? sched.everyMs : Number.NaN;
    const anchorMs =
      typeof sched.anchorMs === "number" && Number.isFinite(sched.anchorMs)
        ? sched.anchorMs
        : undefined;
    const result = everyMsToCronExpr(everyMs, anchorMs);
    everyJobs.push({ job, schedule: sched, everyMs, anchorMs, result });
  }

  if (everyJobs.length === 0) {
    return;
  }

  const stats: CronEveryMigrationStats = {
    examined: everyJobs.length,
    converted: 0,
    archived: 0,
    unmigratable: 0,
  };

  const convertible = everyJobs.filter((j): j is EveryJob & { result: { expr: string } } => {
    return "expr" in j.result;
  });
  const unmigratable = everyJobs.filter((j) => "unmigratable" in j.result);

  // Always emit a preview note.
  const noteLines: string[] = [
    `${everyJobs.length} kind:every job(s) found at ${shortenHomePath(storePath)}:`,
  ];
  for (const { job, everyMs, result } of everyJobs) {
    const id = typeof job.id === "string" ? job.id : "<unknown>";
    if ("expr" in result) {
      noteLines.push(`  - ${id} (${everyMs}ms): would convert to kind:cron expr:"${result.expr}"`);
    } else {
      noteLines.push(
        `  - ${id} (${everyMs}ms): unmigratable — ${(result as { unmigratable: true; reason: string }).reason}`,
      );
    }
  }
  noteLines.push(`Run \`openclaw doctor --fix\` to convert kind:every jobs to kind:cron.`);

  note(noteLines.join("\n"), "Cron every-kind migration");

  if (!params.prompter.shouldRepair) {
    return;
  }

  if (convertible.length === 0) {
    stats.unmigratable = unmigratable.length;
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
      "Cron every-kind migration",
    );
    return;
  }

  // Mutate convertible jobs.
  for (const { schedule, result } of convertible) {
    schedule.kind = "cron";
    schedule.expr = result.expr;
    delete schedule.everyMs;
    delete schedule.anchorMs;
    stats.converted++;
  }

  stats.unmigratable = unmigratable.length;

  const updated = JSON.stringify({ ...store, jobs: rawJobs }, null, 2);
  fs.writeFileSync(storePath, updated, "utf-8");

  const resultLines: string[] = [
    `Converted ${stats.converted} kind:every job(s) to kind:cron at ${shortenHomePath(storePath)}.`,
  ];
  if (stats.unmigratable > 0) {
    resultLines.push(
      `${stats.unmigratable} job(s) could not be automatically converted and were left unchanged.`,
    );
  }
  resultLines.push(`Archived prior jobs.json to ${shortenHomePath(archivePath)}.`);

  note(resultLines.join("\n"), "Doctor changes");
}
