import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronStorePath } from "../cron/store.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";

export type CronTzMigrationStats = {
  examined: number;
  migrated: number;
  archived: number;
  failed: number; // unparseable `at` / `tz`
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
    const hours = parseInt(fixedMatch[2] ?? "0", 10);
    const minutes = parseInt(fixedMatch[3] ?? "0", 10);
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

    const tzYear = parseInt(parts.year ?? "0", 10);
    const tzMonth = parseInt(parts.month ?? "0", 10);
    const tzDay = parseInt(parts.day ?? "0", 10);
    const tzHour = parseInt(parts.hour ?? "0", 10) % 24; // 24:00 → 0
    const tzMinute = parseInt(parts.minute ?? "0", 10);
    const tzSecond = parseInt(parts.second ?? "0", 10);

    // Parse the naive input to extract the target local time.
    const naiveParts = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
    if (!naiveParts) {
      return null;
    }
    const wantYear = parseInt(naiveParts[1] ?? "0", 10);
    const wantMonth = parseInt(naiveParts[2] ?? "0", 10);
    const wantDay = parseInt(naiveParts[3] ?? "0", 10);
    const wantHour = parseInt(naiveParts[4] ?? "0", 10);
    const wantMinute = parseInt(naiveParts[5] ?? "0", 10);
    const wantSecond = parseInt(naiveParts[6] ?? "0", 10);
    const wantMs = naiveParts[7] ? parseInt(naiveParts[7].padEnd(3, "0").slice(0, 3), 10) : 0;

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
  const tzJobs: JobWithTz[] = [];
  for (const job of rawJobs) {
    const schedule = job.schedule;
    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
      continue;
    }
    const sched = schedule as Record<string, unknown>;
    if (sched.kind !== "at") {
      continue;
    }
    const tz = typeof sched.tz === "string" ? sched.tz.trim() : "";
    if (!tz) {
      continue;
    }
    tzJobs.push({ job, schedule: sched });
  }

  if (tzJobs.length === 0) {
    return;
  }

  const stats: CronTzMigrationStats = {
    examined: rawJobs.length,
    migrated: 0,
    archived: 0,
    failed: 0,
  };

  // Compute conversions to surface a preview (without mutating yet).
  const conversions: Array<{
    job: Record<string, unknown>;
    schedule: Record<string, unknown>;
    utcAt: string | null;
    tz: string;
  }> = tzJobs.map(({ job, schedule }) => {
    const tz = String(schedule.tz);
    const at = typeof schedule.at === "string" ? schedule.at : "";
    const utcAt = at ? convertLocalToUtc(at, tz) : null;
    return { job, schedule, utcAt, tz };
  });

  const parseable = conversions.filter((c) => c.utcAt !== null);
  const unparseable = conversions.filter((c) => c.utcAt === null);

  note(
    [
      `${tzJobs.length} cron job(s) at ${shortenHomePath(storePath)} have a tz field on a kind:at schedule:`,
      ...parseable.map(
        (c) =>
          `  - ${typeof c.job.id === "string" ? c.job.id : "<unknown>"}: at ${String(c.schedule.at)} (${c.tz}) → ${String(c.utcAt)} UTC`,
      ),
      ...(unparseable.length > 0
        ? [
            `  - ${unparseable.length} job(s) could not be parsed (tz or at value unrecognized) — will be left unchanged.`,
          ]
        : []),
      `Run \`openclaw doctor --fix\` to convert at to UTC and drop the tz field.`,
    ].join("\n"),
    "Cron tz migration",
  );

  if (!params.prompter.shouldRepair) {
    return;
  }

  if (parseable.length === 0) {
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

  for (const conv of conversions) {
    if (conv.utcAt === null) {
      stats.failed++;
      continue;
    }
    conv.schedule.at = conv.utcAt;
    delete conv.schedule.tz;
    stats.migrated++;
  }

  const updated = JSON.stringify({ ...store, jobs: rawJobs }, null, 2);
  fs.writeFileSync(storePath, updated, "utf-8");

  note(
    [
      `Migrated ${stats.migrated} job(s): tz-aware at → UTC at ${shortenHomePath(storePath)}.`,
      ...(stats.failed > 0
        ? [`${stats.failed} job(s) could not be parsed and were left unchanged.`]
        : []),
      `Archived prior jobs.json to ${shortenHomePath(archivePath)}.`,
    ].join("\n"),
    "Doctor changes",
  );
}
