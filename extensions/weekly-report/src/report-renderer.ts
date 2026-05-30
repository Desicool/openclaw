/**
 * Weekly report renderer. Emits Markdown written into the Feishu doc as blocks by
 * `doc-writer.writeWeeklySection`. The next-week table is a GFM pipe table.
 *
 * The leading `## <week_title>` H2 is load-bearing: `doc-writer` locates and replaces a week's
 * existing section by matching that H2 text (each week = exactly one H2 block), so the H2 line and the
 * week_title value must stay 1:1. Do not change the heading level or interpose another H2.
 *
 * Output shape is verified against fixtures/sample.expected.md.
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

function escapeCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

function renderNextWeekTable(rows: Array<Record<string, unknown>>): string {
  const parts: string[] = ["| 项目 | 计划 |", "| --- | --- |"];
  for (const row of rows) {
    const project = escapeCell(requireString(row, "project"));
    const plan = escapeCell(requireString(row, "plan"));
    parts.push(`| **${project}** | ${plan} |`);
  }
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
