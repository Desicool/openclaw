/**
 * Weekly report renderer. Port of generate_weekly_report.py — byte-equivalent output is verified
 * by a golden fixture in fixtures/sample.expected.docxml.
 *
 * Output is Feishu DocXML (uses <lark-table>), not generic Markdown. The header line is
 *   ## {weekTitle}
 * which the splicer treats as a structural anchor (in addition to invisible sentinels).
 */

export type WeeklyReportItem = {
  title: string;
  intent: string;
  objective: string;
  completed: string[];
};

export type WeeklyReportNextWeekRow = {
  project: string;
  plan: string;
};

export type WeeklyReportInput = {
  week_title: string;
  current_week: WeeklyReportItem[];
  next_week: WeeklyReportNextWeekRow[];
};

class RenderError extends Error {}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RenderError(`Field '${key}' must be a non-empty string`);
  }
  return value.trim();
}

function requireList(obj: Record<string, unknown>, key: string): unknown[] {
  const value = obj[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new RenderError(`Field '${key}' must be a non-empty list`);
  }
  return value;
}

function normalizeBulletLines(lines: unknown[], fieldName: string): string[] {
  return lines.map((line, idx) => {
    if (typeof line !== "string" || line.trim() === "") {
      throw new RenderError(`${fieldName}[${idx + 1}] must be a non-empty string`);
    }
    return line.trim();
  });
}

function renderItem(index: number, item: Record<string, unknown>): string {
  const title = requireString(item, "title");
  const intent = requireString(item, "intent");
  const objective = requireString(item, "objective");
  const completed = normalizeBulletLines(requireList(item, "completed"), "completed");

  const lines: string[] = [];
  lines.push(`#### ${index}. ${title}`);
  lines.push("**意图：**");
  lines.push(intent);
  lines.push("");
  lines.push("**目标：**");
  lines.push(objective);
  lines.push("");
  lines.push("**完成内容：**");
  for (const bullet of completed) {
    lines.push(`- ${bullet}`);
  }
  return lines.join("\n");
}

function renderNextWeekTable(rows: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  parts.push(
    `<lark-table rows="${rows.length + 1}" cols="2" header-row="true" column-widths="212,526">`,
  );
  parts.push("  <lark-tr>");
  parts.push("    <lark-td>");
  parts.push("      项目");
  parts.push("    </lark-td>");
  parts.push("    <lark-td>");
  parts.push("      计划");
  parts.push("    </lark-td>");
  parts.push("  </lark-tr>");

  for (const row of rows) {
    const project = requireString(row, "project");
    const plan = requireString(row, "plan");
    parts.push("  <lark-tr>");
    parts.push("    <lark-td>");
    parts.push(`      **${project}**`);
    parts.push("    </lark-td>");
    parts.push("    <lark-td>");
    parts.push(`      ${plan}`);
    parts.push("    </lark-td>");
    parts.push("  </lark-tr>");
  }

  parts.push("</lark-table>");
  return parts.join("\n");
}

export function renderReport(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new RenderError("input must be an object");
  }
  const data = input as Record<string, unknown>;
  const weekTitle = requireString(data, "week_title");
  const currentItems = requireList(data, "current_week");
  const nextWeekRowsRaw = requireList(data, "next_week");

  const lines: string[] = [];
  lines.push(`## ${weekTitle}`);
  lines.push("### 本周工作");
  lines.push("");

  currentItems.forEach((item, idx) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new RenderError(`current_week[${idx + 1}] must be an object`);
    }
    lines.push(renderItem(idx + 1, item as Record<string, unknown>));
    lines.push("");
  });

  const nextWeekRows = nextWeekRowsRaw.map((row, idx) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new RenderError(`next_week[${idx + 1}] must be an object`);
    }
    return row as Record<string, unknown>;
  });

  lines.push("### 下周计划");
  lines.push(renderNextWeekTable(nextWeekRows));
  lines.push("");
  lines.push("---");
  return `${lines.join("\n").replace(/\s+$/u, "")}\n`;
}
