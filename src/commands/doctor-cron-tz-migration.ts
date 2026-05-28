import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronStorePath } from "../cron/store.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";

export type CronTzMigrationStats = {
  examined: number;
  atMigrated: number; // kind:"at" with tz pre-resolved to UTC
  cronStripped: number; // kind:"cron" with tz/staggerMs stripped
  archived: number;
  failed: number; // at-kind with unparseable tz/at
};

export type MaybeMigrateLegacyCronTzParams = {
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
  return path.join(dir, `${base}.json.tz-migrated-${suffix}.json`);
}

/**
 * Convert a naive local ISO datetime string (e.g. "2026-06-01T09:00:00") in the
 * given IANA timezone (or fixed-offset string) to an absolute UTC ISO string.
 *
 * Returns null if the timezone or datetime is unparseable.
 */
function convertLocalToUtc(localIso: string, tz: string): string | null {
  // Normalise: strip any trailing Z or offset so we treat it as naive local time.
  const naive = localIso
    .replace(/Z$/, "")
    .replace(/[+-]\d{2}:\d{2}$/, "")
    .replace(/[+-]\d{4}$/, "");

  // Handle fixed-offset strings like "+08:00", "-05:00", "+0800".
  const fixedMatch = tz.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (fixedMatch) {
    const sign = fixedMatch[1] === "+" ? 1 : -1;
    const hours = Number.parseInt(fixedMatch[2] ?? "0", 10);
    const minutes = Number.parseInt(fixedMatch[3] ?? "0", 10);
    const offsetMs = sign * (hours * 60 + minutes) * 60_000;
    const utcMs = new Date(`${naive}Z`).getTime() - offsetMs;
    if (!Number.isFinite(utcMs)) {
      return null;
    }
    return new Date(utcMs).toISOString();
  }

  // Use Intl.DateTimeFormat to determine the UTC offset for the given local
  // datetime in the named timezone.  We create a reference Date from the naive
  // ISO (interpreted as UTC), then compare Intl-formatted year/month/day/hour/
  // minute/second parts against the actual UTC components to determine the offset.
  try {
    // Parse the naive ISO as UTC to get a candidate epoch.
    const candidateUtcMs = new Date(`${naive}Z`).getTime();
    if (!Number.isFinite(candidateUtcMs)) {
      return null;
    }

    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    // Build local datetime parts for the candidate epoch in the target tz.
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(candidateUtcMs)).map((p) => [p.type, p.value]),
    ) as Record<string, string>;

    const tzYear = Number.parseInt(parts.year ?? "0", 10);
    const tzMonth = Number.parseInt(parts.month ?? "0", 10);
    const tzDay = Number.parseInt(parts.day ?? "0", 10);
    const tzHour = Number.parseInt(parts.hour ?? "0", 10) % 24; // 24:00 → 0
    const tzMinute = Number.parseInt(parts.minute ?? "0", 10);
    const tzSecond = Number.parseInt(parts.second ?? "0", 10);

    // Parse the naive input to extract the target local time.
    const naiveParts = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
    if (!naiveParts) {
      return null;
    }
    const wantYear = Number.parseInt(naiveParts[1] ?? "0", 10);
    const wantMonth = Number.parseInt(naiveParts[2] ?? "0", 10);
    const wantDay = Number.parseInt(naiveParts[3] ?? "0", 10);
    const wantHour = Number.parseInt(naiveParts[4] ?? "0", 10);
    const wantMinute = Number.parseInt(naiveParts[5] ?? "0", 10);
    const wantSecond = Number.parseInt(naiveParts[6] ?? "0", 10);
    const wantMs = naiveParts[7]
      ? Number.parseInt(naiveParts[7].padEnd(3, "0").slice(0, 3), 10)
      : 0;

    // Compute the difference between what Intl reports for the candidate epoch
    // and what we want (in seconds), then adjust.
    const tzMs = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute, tzSecond);
    const wantMs2 = Date.UTC(wantYear, wantMonth - 1, wantDay, wantHour, wantMinute, wantSecond);
    const diffMs = wantMs2 - tzMs;

    const utcMs = candidateUtcMs + diffMs + wantMs;
    if (!Number.isFinite(utcMs)) {
      return null;
    }
    return new Date(utcMs).toISOString();
  } catch {
    return null;
  }
}

export async function maybeMigrateLegacyCronTz(
  params: MaybeMigrateLegacyCronTzParams,
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

  // Find kind:at jobs with a non-empty tz field.
  type JobWithTz = { job: Record<string, unknown>; schedule: Record<string, unknown> };
  const atTzJobs: JobWithTz[] = [];

  // Find kind:cron jobs with tz or staggerMs fields (legacy fields to strip).
  type CronStripJob = {
    job: Record<string, unknown>;
    schedule: Record<string, unknown>;
    hasTz: boolean;
    hasStaggerMs: boolean;
  };
  const cronStripJobs: CronStripJob[] = [];

  for (const job of rawJobs) {
    const schedule = job.schedule;
    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
      continue;
    }
    const sched = schedule as Record<string, unknown>;
    if (sched.kind === "at") {
      const tz = typeof sched.tz === "string" ? sched.tz.trim() : "";
      if (tz) {
        atTzJobs.push({ job, schedule: sched });
      }
    } else if (sched.kind === "cron") {
      const hasTz = sched.tz !== undefined;
      const hasStaggerMs = sched.staggerMs !== undefined;
      if (hasTz || hasStaggerMs) {
        cronStripJobs.push({ job, schedule: sched, hasTz, hasStaggerMs });
      }
    }
  }

  if (atTzJobs.length === 0 && cronStripJobs.length === 0) {
    return;
  }

  const stats: CronTzMigrationStats = {
    examined: rawJobs.length,
    atMigrated: 0,
    cronStripped: 0,
    archived: 0,
    failed: 0,
  };

  // Compute at-kind conversions to surface a preview (without mutating yet).
  const conversions: Array<{
    job: Record<string, unknown>;
    schedule: Record<string, unknown>;
    utcAt: string | null;
    tz: string;
  }> = atTzJobs.map(({ job, schedule }) => {
    const tz = String(schedule.tz);
    const at = typeof schedule.at === "string" ? schedule.at : "";
    const utcAt = at ? convertLocalToUtc(at, tz) : null;
    return { job, schedule, utcAt, tz };
  });

  const parseable = conversions.filter((c) => c.utcAt !== null);
  const unparseable = conversions.filter((c) => c.utcAt === null);

  const noteLines: string[] = [];

  if (atTzJobs.length > 0) {
    noteLines.push(
      `${atTzJobs.length} cron job(s) at ${shortenHomePath(storePath)} have a tz field on a kind:at schedule:`,
    );
    for (const c of parseable) {
      noteLines.push(
        `  - ${typeof c.job.id === "string" ? c.job.id : "<unknown>"}: at ${String(c.schedule.at)} (${c.tz}) → ${String(c.utcAt)} UTC`,
      );
    }
    if (unparseable.length > 0) {
      noteLines.push(
        `  - ${unparseable.length} job(s) could not be parsed (tz or at value unrecognized) — will be left unchanged.`,
      );
    }
  }

  if (cronStripJobs.length > 0) {
    noteLines.push(
      `${cronStripJobs.length} kind:cron job(s) carry legacy tz/staggerMs fields that will be stripped:`,
    );
    for (const { job, hasTz, hasStaggerMs } of cronStripJobs) {
      const fields = [hasTz ? "tz" : null, hasStaggerMs ? "staggerMs" : null]
        .filter(Boolean)
        .join(", ");
      noteLines.push(
        `  - ${typeof job.id === "string" ? job.id : "<unknown>"}: will strip ${fields}`,
      );
    }
  }

  if (atTzJobs.length > 0) {
    noteLines.push(`Run \`openclaw doctor --fix\` to convert at to UTC and drop the tz field.`);
  } else {
    noteLines.push(`Run \`openclaw doctor --fix\` to strip tz/staggerMs from cron schedules.`);
  }

  note(noteLines.join("\n"), "Cron tz migration");

  if (!params.prompter.shouldRepair) {
    return;
  }

  const hasAtWork = parseable.length > 0;
  const hasCronWork = cronStripJobs.length > 0;

  if (!hasAtWork && !hasCronWork) {
    stats.failed = unparseable.length;
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
      "Cron tz migration",
    );
    return;
  }

  // Migrate kind:at jobs.
  for (const conv of conversions) {
    if (conv.utcAt === null) {
      stats.failed++;
      continue;
    }
    conv.schedule.at = conv.utcAt;
    delete conv.schedule.tz;
    stats.atMigrated++;
  }

  // Strip tz/staggerMs from kind:cron jobs.
  for (const { schedule } of cronStripJobs) {
    delete schedule.tz;
    delete schedule.staggerMs;
    stats.cronStripped++;
  }

  const updated = JSON.stringify({ ...store, jobs: rawJobs }, null, 2);
  fs.writeFileSync(storePath, updated, "utf-8");

  const resultLines: string[] = [];
  if (stats.atMigrated > 0) {
    resultLines.push(
      `Migrated ${stats.atMigrated} job(s): tz-aware at → UTC at ${shortenHomePath(storePath)}.`,
    );
  }
  if (stats.cronStripped > 0) {
    resultLines.push(
      `Stripped tz/staggerMs from ${stats.cronStripped} kind:cron job(s) at ${shortenHomePath(storePath)}.`,
    );
  }
  if (stats.failed > 0) {
    resultLines.push(`${stats.failed} job(s) could not be parsed and were left unchanged.`);
  }
  resultLines.push(`Archived prior jobs.json to ${shortenHomePath(archivePath)}.`);

  note(resultLines.join("\n"), "Doctor changes");

  if (stats.cronStripped > 0) {
    note(
      "After tz is dropped, cron expressions fire under the gateway process TZ. Verify your gateway's TZ env var or system timezone matches the previous `tz` value, or the cron schedules will fire at different wall-clock times.",
      "Cron tz migration",
    );
  }
}
