import { describe, expect, it } from "vitest";
import { parseWeeklyReportPluginConfig } from "./settings.js";
import { createBeginWeeklyReportTool } from "./tools.js";

describe("begin_weekly_report tool", () => {
  it("returns the drafting contract plus week hints, with no side effects", async () => {
    const settings = parseWeeklyReportPluginConfig({});
    const tool = createBeginWeeklyReportTool({ settings });
    expect(tool.name).toBe("begin_weekly_report");

    const result = await tool.execute("call-1", {});
    const details = result.details as {
      ok: boolean;
      weekKeyHint: string;
      weekTitleHint: string;
      contract: string;
    };
    expect(details.ok).toBe(true);
    expect(details.weekKeyHint).toMatch(/^\d{4}-W\d{2}$/);
    expect(details.weekTitleHint).toMatch(/^\d{4}\.\d{1,2}\.\d{1,2}-\d{4}\.\d{1,2}\.\d{1,2}$/);
    // The contract is the plugin-owned first-person drafting guidance, with hints substituted in.
    expect(details.contract).toContain("第一人称");
    expect(details.contract).toContain(details.weekKeyHint);
    expect(details.contract).not.toContain("{weekKeyHint}");
  });
});
