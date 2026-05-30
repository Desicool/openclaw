import { describe, expect, it } from "vitest";
import {
  WEEKLY_REPORT_SUPPLEMENT_SESSION_SEGMENT,
  isWeeklyReportSupplementSession,
} from "./types.js";

describe("isWeeklyReportSupplementSession", () => {
  it("matches the isolated re-draft sub-session key, not the main DM session", () => {
    // Built by interactive-handler as agent:<id>:weekly-report-supplement:<flowId>:<ts>
    const supplement = `agent:silver-chariot:${WEEKLY_REPORT_SUPPLEMENT_SESSION_SEGMENT}:flow-1:1780000000000`;
    expect(isWeeklyReportSupplementSession(supplement)).toBe(true);
    // The recipient/main DM session must NOT match — respond_to_weekly_report_card stays available there.
    expect(isWeeklyReportSupplementSession("agent:silver-chariot:feishu:direct:ou_abc")).toBe(
      false,
    );
    expect(isWeeklyReportSupplementSession(undefined)).toBe(false);
    expect(isWeeklyReportSupplementSession("")).toBe(false);
  });
});
