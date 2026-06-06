/**
 * Legacy cron-schema migrations that operate on raw persisted job rows BEFORE
 * the main normalizeStoredCronJobs pass.  Each migration scans rawJobs in-memory
 * and, when asked to repair, mutates the rows directly so the subsequent
 * normalizer and persisted-shape validator see the corrected data.
 *
 * Three migrations are provided:
 *
 *   migrateEveryKindToCron   – kind:"every" (everyMs+anchorMs) → kind:"cron"
 *                              with an auto-computed 5-field cron expression.
 *   migrateCronTzFields      – strips the legacy tz field from kind:"cron"
 *                              schedules; converts kind:"at" + tz to a UTC
 *                              absolute timestamp.
 *   migrateNonIsolatedSessionTargets – rewrites any non-isolated sessionTarget
 *                              value to "isolated".  All cron jobs on this
 *                              base must use sessionTarget:"isolated".
 */

import { normalizeOptionalLowercaseString } from "../../../../packages/normalization-core/src/string-coerce.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isRawObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function getSchedule(raw: Record<string, unknown>): Record<string, unknown> | null {
  return isRawObject(raw.schedule) ? (raw.schedule as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// every → cron migration
// ---------------------------------------------------------------------------

type ConvertEveryResult = { expr: string } | { unmigratable: true; reason: string };

function everyMsToCronExpr(everyMs: number, anchorMs: number | undefined): ConvertEveryResult {
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    return { unmigratable: true, reason: "invalid everyMs" };
  }
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  const validAnchor =
    typeof anchorMs === "number" && Number.isFinite(anchorMs) ? new Date(anchorMs) : null;
  const anchorMinute = validAnchor ? validAnchor.getMinutes() : 0;
  const anchorHour = validAnchor ? validAnchor.getHours() : 0;

  if (everyMs < MIN) {
    return {
      unmigratable: true,
      reason: "everyMs below 1 minute is not expressible in 5-field cron",
    };
  }

  if (everyMs % MIN !== 0) {
    return { unmigratable: true, reason: "everyMs is not a multiple of 1 minute" };
  }

  if (everyMs < HOUR) {
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

  if (everyMs === DAY) {
    return { expr: `${anchorMinute} ${anchorHour} * * *` };
  }

  return {
    unmigratable: true,
    reason: `everyMs=${everyMs} cannot be cleanly converted to 5-field cron`,
  };
}

export type EveryKindMigrationResult = {
  /** Number of kind:every jobs found. */
  found: number;
  /** Number that can be converted to kind:cron. */
  convertible: number;
  /** Number that cannot be converted automatically. */
  unmigratable: number;
  /** Per-job preview lines (shown before repair prompt). */
  previewLines: string[];
  /** Apply mutations to rawJobs (call only after repair is confirmed). */
  apply: () => void;
};

export function detectEveryKindMigration(
  rawJobs: Array<Record<string, unknown>>,
): EveryKindMigrationResult {
  type Entry = {
    sched: Record<string, unknown>;
    everyMs: number;
    result: ConvertEveryResult;
  };

  const entries: Entry[] = [];
  for (const raw of rawJobs) {
    const sched = getSchedule(raw);
    if (!sched) continue;
    const kind = normalizeOptionalLowercaseString(sched.kind) ?? "";
    if (kind !== "every") continue;
    const everyMs = typeof sched.everyMs === "number" ? sched.everyMs : Number.NaN;
    const anchorMs =
      typeof sched.anchorMs === "number" && Number.isFinite(sched.anchorMs)
        ? sched.anchorMs
        : undefined;
    entries.push({ sched, everyMs, result: everyMsToCronExpr(everyMs, anchorMs) });
  }

  const convertibleEntries = entries.filter(
    (e): e is Entry & { result: { expr: string } } => "expr" in e.result,
  );
  const unmigratableEntries = entries.filter((e) => "unmigratable" in e.result);

  const previewLines: string[] = [];
  for (const { everyMs, result } of entries) {
    if ("expr" in result) {
      previewLines.push(
        `- 1 kind:every job (${everyMs}ms): will convert to kind:cron expr:"${result.expr}"`,
      );
    } else {
      previewLines.push(
        `- 1 kind:every job (${everyMs}ms): cannot be auto-converted — ${(result as { reason: string }).reason}`,
      );
    }
  }

  return {
    found: entries.length,
    convertible: convertibleEntries.length,
    unmigratable: unmigratableEntries.length,
    previewLines,
    apply() {
      for (const { sched, result } of convertibleEntries) {
        sched.kind = "cron";
        sched.expr = result.expr;
        delete sched.everyMs;
        delete sched.anchorMs;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// tz-field strip / at+tz → UTC migration
// ---------------------------------------------------------------------------

/**
 * Convert a naive local ISO datetime string in the given IANA timezone (or
 * fixed-offset string) to an absolute UTC ISO string.  Returns null when the
 * timezone or datetime cannot be parsed.
 */
function convertLocalToUtc(localIso: string, tz: string): string | null {
  const naive = localIso
    .replace(/Z$/, "")
    .replace(/[+-]\d{2}:\d{2}$/, "")
    .replace(/[+-]\d{4}$/, "");

  const fixedMatch = tz.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (fixedMatch) {
    const sign = fixedMatch[1] === "+" ? 1 : -1;
    const hours = Number.parseInt(fixedMatch[2] ?? "0", 10);
    const minutes = Number.parseInt(fixedMatch[3] ?? "0", 10);
    const offsetMs = sign * (hours * 60 + minutes) * 60_000;
    const utcMs = new Date(`${naive}Z`).getTime() - offsetMs;
    if (!Number.isFinite(utcMs)) return null;
    return new Date(utcMs).toISOString();
  }

  try {
    const candidateUtcMs = new Date(`${naive}Z`).getTime();
    if (!Number.isFinite(candidateUtcMs)) return null;

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

    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(candidateUtcMs)).map((p) => [p.type, p.value]),
    ) as Record<string, string>;

    const tzYear = Number.parseInt(parts.year ?? "0", 10);
    const tzMonth = Number.parseInt(parts.month ?? "0", 10);
    const tzDay = Number.parseInt(parts.day ?? "0", 10);
    const tzHour = Number.parseInt(parts.hour ?? "0", 10) % 24;
    const tzMinute = Number.parseInt(parts.minute ?? "0", 10);
    const tzSecond = Number.parseInt(parts.second ?? "0", 10);

    const naiveParts = naive.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/,
    );
    if (!naiveParts) return null;

    const wantYear = Number.parseInt(naiveParts[1] ?? "0", 10);
    const wantMonth = Number.parseInt(naiveParts[2] ?? "0", 10);
    const wantDay = Number.parseInt(naiveParts[3] ?? "0", 10);
    const wantHour = Number.parseInt(naiveParts[4] ?? "0", 10);
    const wantMinute = Number.parseInt(naiveParts[5] ?? "0", 10);
    const wantSecond = Number.parseInt(naiveParts[6] ?? "0", 10);
    const wantSubMs = naiveParts[7]
      ? Number.parseInt(naiveParts[7].padEnd(3, "0").slice(0, 3), 10)
      : 0;

    const tzMs = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute, tzSecond);
    const wantMs = Date.UTC(wantYear, wantMonth - 1, wantDay, wantHour, wantMinute, wantSecond);
    const diffMs = wantMs - tzMs;

    const utcMs = candidateUtcMs + diffMs + wantSubMs;
    if (!Number.isFinite(utcMs)) return null;
    return new Date(utcMs).toISOString();
  } catch {
    return null;
  }
}

export type TzFieldMigrationResult = {
  /** kind:cron jobs with a tz field that will be stripped. */
  cronTzFound: number;
  /** kind:at jobs with a tz field that can be converted to UTC. */
  atTzConvertible: number;
  /** kind:at jobs with a tz field that cannot be parsed. */
  atTzUnparseable: number;
  previewLines: string[];
  apply: () => void;
};

export function detectTzFieldMigration(
  rawJobs: Array<Record<string, unknown>>,
): TzFieldMigrationResult {
  type CronEntry = { sched: Record<string, unknown> };
  type AtEntry = {
    sched: Record<string, unknown>;
    tz: string;
    utcAt: string | null;
    jobId: string;
  };

  const cronEntries: CronEntry[] = [];
  const atEntries: AtEntry[] = [];

  for (const raw of rawJobs) {
    const sched = getSchedule(raw);
    if (!sched) continue;
    const kind = normalizeOptionalLowercaseString(sched.kind) ?? "";

    if (kind === "cron" && sched.tz !== undefined) {
      cronEntries.push({ sched });
    } else if (kind === "at" && typeof sched.tz === "string" && sched.tz.trim()) {
      const tz = sched.tz.trim();
      const at = typeof sched.at === "string" ? sched.at : "";
      const utcAt = at ? convertLocalToUtc(at, tz) : null;
      const jobId = typeof raw.id === "string" ? raw.id : "<unknown>";
      atEntries.push({ sched, tz, utcAt, jobId });
    }
  }

  const atConvertible = atEntries.filter((e) => e.utcAt !== null);
  const atUnparseable = atEntries.filter((e) => e.utcAt === null);

  const previewLines: string[] = [];
  if (cronEntries.length > 0) {
    previewLines.push(
      `- ${pluralize(cronEntries.length, "kind:cron job")} ${cronEntries.length === 1 ? "has" : "have"} a legacy \`tz\` field that will be stripped`,
    );
  }
  for (const e of atConvertible) {
    previewLines.push(
      `- kind:at job ${e.jobId}: at with tz (${e.tz}) → UTC ${String(e.utcAt)}`,
    );
  }
  for (const e of atUnparseable) {
    previewLines.push(
      `- kind:at job ${e.jobId}: tz (${e.tz}) could not be parsed — will be left unchanged`,
    );
  }

  return {
    cronTzFound: cronEntries.length,
    atTzConvertible: atConvertible.length,
    atTzUnparseable: atUnparseable.length,
    previewLines,
    apply() {
      for (const { sched } of cronEntries) {
        delete sched.tz;
      }
      for (const { sched, utcAt } of atConvertible) {
        sched.at = utcAt;
        delete sched.tz;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// non-isolated sessionTarget → isolated migration
// ---------------------------------------------------------------------------

export type SessionTargetMigrationResult = {
  /** Number of jobs with a non-isolated sessionTarget that will be migrated. */
  found: number;
  previewLines: string[];
  apply: () => void;
};

export function detectSessionTargetMigration(
  rawJobs: Array<Record<string, unknown>>,
): SessionTargetMigrationResult {
  const affected: Array<{ raw: Record<string, unknown>; currentTarget: string }> = [];

  for (const raw of rawJobs) {
    const t = normalizeOptionalLowercaseString(raw.sessionTarget) ?? "";
    // "isolated", "session:*", and "current" are fine on this base.
    // Anything else (notably "main") needs migrating.
    if (t === "isolated" || t === "current" || t.startsWith("session:") || t === "") continue;
    const currentTarget = typeof raw.sessionTarget === "string" ? raw.sessionTarget : String(t);
    affected.push({ raw, currentTarget });
  }

  const previewLines: string[] = affected.map(
    ({ raw, currentTarget }) =>
      `- job ${typeof raw.id === "string" ? raw.id : "<unknown>"}: sessionTarget "${currentTarget}" → "isolated"`,
  );

  return {
    found: affected.length,
    previewLines,
    apply() {
      for (const { raw } of affected) {
        raw.sessionTarget = "isolated";
      }
    },
  };
}

// ---------------------------------------------------------------------------
// legacy systemEvent payload → disable migration
// ---------------------------------------------------------------------------

export type SystemEventPayloadMigrationResult = {
  /** Number of enabled jobs with a legacy systemEvent payload that will be disabled. */
  found: number;
  previewLines: string[];
  apply: () => void;
};

/**
 * The isolated cron runner only executes `payload.kind:"agentTurn"` jobs;
 * `assertSupportedJobSpec` rejects systemEvent payloads at run time. Legacy
 * systemEvent ("main"-session wake/reminder) jobs imported from an older base
 * would otherwise survive persisted-shape validation and then error on every
 * fire. Disable them so the scheduler skips them and the operator can recreate
 * the intent as an isolated agentTurn. Disabling (not deleting) keeps the job
 * visible for reference.
 */
export function detectSystemEventPayloadMigration(
  rawJobs: Array<Record<string, unknown>>,
): SystemEventPayloadMigrationResult {
  const affected = rawJobs.filter((raw) => {
    const payload = isRawObject(raw.payload) ? raw.payload : null;
    const kind = payload ? (normalizeOptionalLowercaseString(payload.kind) ?? "") : "";
    return kind === "systemevent" && raw.enabled !== false;
  });

  const previewLines = affected.map(
    (raw) =>
      `- job ${typeof raw.id === "string" ? raw.id : "<unknown>"}: legacy systemEvent payload is unsupported by the isolated cron runner → disabling`,
  );

  return {
    found: affected.length,
    previewLines,
    apply() {
      for (const raw of affected) {
        raw.enabled = false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared pluralize (local, mirrors the one in index.ts)
// ---------------------------------------------------------------------------

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
