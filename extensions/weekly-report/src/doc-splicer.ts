/**
 * Sentinel-bounded splice of a weekly-report section inside an existing Feishu doc body.
 *
 * Each managed section is wrapped by HTML comments:
 *   <!-- weekly-report:begin weekKey={weekKey} -->
 *   ...section content...
 *   <!-- weekly-report:end weekKey={weekKey} -->
 *
 * The splicer matches on the begin/end sentinel pair carrying the SAME weekKey, replacing the
 * bounded range in-place. If no matching pair exists the section is prepended at the document
 * head (latest-first ordering). Non-matching content — pre-plugin freeform notes, other weeks,
 * heading renames inside a sentinel-bounded block — is preserved.
 *
 * Malformed sentinels (a `:begin` without a matching `:end` for the same weekKey) are treated as
 * orphans: the new section is still prepended, the orphan stays untouched. We never try to guess
 * its boundary.
 */

const SENTINEL_PREFIX = "<!-- weekly-report:";

export function buildSentinelStart(weekKey: string): string {
  return `${SENTINEL_PREFIX}begin weekKey=${weekKey} -->`;
}

export function buildSentinelEnd(weekKey: string): string {
  return `${SENTINEL_PREFIX}end weekKey=${weekKey} -->`;
}

export function wrapSectionWithSentinels(weekKey: string, sectionBody: string): string {
  const start = buildSentinelStart(weekKey);
  const end = buildSentinelEnd(weekKey);
  const trimmed = sectionBody.replace(/^\n+|\n+$/gu, "");
  return `${start}\n${trimmed}\n${end}`;
}

export function spliceWeeklySection(params: {
  existingDoc: string;
  weekKey: string;
  newSectionBody: string;
}): string {
  const { existingDoc, weekKey, newSectionBody } = params;
  const wrapped = wrapSectionWithSentinels(weekKey, newSectionBody);

  const start = buildSentinelStart(weekKey);
  const end = buildSentinelEnd(weekKey);

  const startIdx = existingDoc.indexOf(start);
  if (startIdx >= 0) {
    const endIdx = existingDoc.indexOf(end, startIdx + start.length);
    if (endIdx >= 0) {
      const endClose = endIdx + end.length;
      const before = existingDoc.slice(0, startIdx).replace(/\n+$/u, "");
      const after = existingDoc.slice(endClose).replace(/^\n+/u, "");
      return joinSegments([before, wrapped, after]);
    }
  }

  // Prepend at head (latest week first).
  const trimmedExisting = existingDoc.replace(/^\n+/u, "");
  if (trimmedExisting === "") {
    return `${wrapped}\n`;
  }
  return `${wrapped}\n\n${trimmedExisting}`;
}

function joinSegments(segments: string[]): string {
  return segments
    .filter((segment) => segment.length > 0)
    .join("\n\n")
    .concat(segments[segments.length - 1].endsWith("\n") ? "" : "\n");
}
