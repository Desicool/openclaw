import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderReport, type WeeklyReportInput } from "./report-renderer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "fixtures");

function readFixture(name: string): string {
  return readFileSync(resolve(fixturesDir, name), "utf8");
}

describe("renderReport", () => {
  it("matches the golden Markdown fixture byte-for-byte", () => {
    const input = JSON.parse(readFixture("sample.input.json")) as WeeklyReportInput;
    const expected = readFixture("sample.expected.md");
    expect(renderReport(input)).toBe(expected);
  });

  it("rejects empty week_title", () => {
    expect(() =>
      renderReport({
        week_title: "  ",
        current_week: [{ title: "X", intent: "Y", objective: "Z", completed: ["a"] }],
        next_week: [{ project: "P", plan: "Q" }],
      }),
    ).toThrow(/week_title/);
  });

  it("rejects empty current_week", () => {
    expect(() =>
      renderReport({
        week_title: "2026.5.18-2026.5.24",
        current_week: [],
        next_week: [{ project: "P", plan: "Q" }],
      }),
    ).toThrow(/current_week/);
  });

  it("rejects empty completed bullets", () => {
    expect(() =>
      renderReport({
        week_title: "2026.5.18-2026.5.24",
        current_week: [{ title: "X", intent: "Y", objective: "Z", completed: [] }],
        next_week: [{ project: "P", plan: "Q" }],
      }),
    ).toThrow(/completed/);
  });

  it("renders single-item current_week and next_week without trailing whitespace", () => {
    const output = renderReport({
      week_title: "2026.5.18-2026.5.24",
      current_week: [{ title: "X", intent: "Y", objective: "Z", completed: ["a"] }],
      next_week: [{ project: "P", plan: "Q" }],
    });
    expect(output.endsWith("---\n")).toBe(true);
    expect(/\s+\n$/u.test(output)).toBe(false);
  });
});
