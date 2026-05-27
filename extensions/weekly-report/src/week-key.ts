/**
 * ISO 8601 week helpers.
 *
 * `weekKey`   -> "YYYY-Www" (zero-padded). ISO week year may differ from calendar year near boundaries.
 * `weekTitle` -> "YYYY.M.D-YYYY.M.D" inclusive range. Month and day are NOT zero-padded (matches the
 *                renderer's existing fixture style).
 *
 * `weekStartsOn` is settable; only "monday" affects the boundary today. "sunday" is reserved for
 * future use and currently throws if requested. The plan acknowledges Monday-only support for v1.
 */

export type WeekStartsOn = "monday" | "sunday";

const MS_PER_DAY = 86_400_000;

function asUtcDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoWeekMonday(date: Date): Date {
  const d = asUtcDate(date);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const isoDayIndex = day === 0 ? 7 : day; // 1=Mon..7=Sun
  d.setUTCDate(d.getUTCDate() - (isoDayIndex - 1));
  return d;
}

function isoWeekThursday(monday: Date): Date {
  const t = new Date(monday);
  t.setUTCDate(t.getUTCDate() + 3);
  return t;
}

function firstThursdayOfYear(year: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  return isoWeekThursday(isoWeekMonday(jan4));
}

export function isoWeekNumber(
  date: Date,
  weekStartsOn: WeekStartsOn = "monday",
): {
  isoYear: number;
  isoWeek: number;
} {
  if (weekStartsOn !== "monday") {
    throw new Error(`weekStartsOn="${weekStartsOn}" not supported in v1; use "monday".`);
  }
  const mon = isoWeekMonday(date);
  const thu = isoWeekThursday(mon);
  const isoYear = thu.getUTCFullYear();
  const firstThu = firstThursdayOfYear(isoYear);
  const firstMonday = isoWeekMonday(firstThu);
  const weeks = Math.round((mon.getTime() - firstMonday.getTime()) / (7 * MS_PER_DAY)) + 1;
  return { isoYear, isoWeek: weeks };
}

export function weekKey(date: Date, weekStartsOn: WeekStartsOn = "monday"): string {
  const { isoYear, isoWeek } = isoWeekNumber(date, weekStartsOn);
  return `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
}

export function weekTitle(date: Date, weekStartsOn: WeekStartsOn = "monday"): string {
  if (weekStartsOn !== "monday") {
    throw new Error(`weekStartsOn="${weekStartsOn}" not supported in v1; use "monday".`);
  }
  const mon = isoWeekMonday(date);
  const sun = new Date(mon);
  sun.setUTCDate(sun.getUTCDate() + 6);
  return `${formatDateCompact(mon)}-${formatDateCompact(sun)}`;
}

function formatDateCompact(date: Date): string {
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
}

export function weekBoundaries(
  date: Date,
  weekStartsOn: WeekStartsOn = "monday",
): {
  startUtc: Date;
  endUtcExclusive: Date;
} {
  if (weekStartsOn !== "monday") {
    throw new Error(`weekStartsOn="${weekStartsOn}" not supported in v1; use "monday".`);
  }
  const mon = isoWeekMonday(date);
  const endExclusive = new Date(mon);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 7);
  return { startUtc: mon, endUtcExclusive: endExclusive };
}
