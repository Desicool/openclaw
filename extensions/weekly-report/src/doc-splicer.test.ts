import { describe, expect, it } from "vitest";
import {
  buildSentinelEnd,
  buildSentinelStart,
  spliceWeeklySection,
  wrapSectionWithSentinels,
} from "./doc-splicer.js";

const WEEK_21 = "2026-W21";
const WEEK_20 = "2026-W20";

const SECTION_BODY = "## 2026.5.18-2026.5.24\n### 本周工作\n(content)";
const PREV_SECTION_BODY = "## 2026.5.11-2026.5.17\n### 本周工作\n(prev content)";

function wrap(weekKey: string, body: string): string {
  return wrapSectionWithSentinels(weekKey, body);
}

describe("spliceWeeklySection", () => {
  it("prepends into an empty doc", () => {
    const result = spliceWeeklySection({
      existingDoc: "",
      weekKey: WEEK_21,
      newSectionBody: SECTION_BODY,
    });
    expect(result).toBe(`${wrap(WEEK_21, SECTION_BODY)}\n`);
  });

  it("prepends above pre-plugin freeform content (untouched)", () => {
    const preExisting = "Pre-plugin notes that the user wrote by hand.\nLine 2.\n";
    const result = spliceWeeklySection({
      existingDoc: preExisting,
      weekKey: WEEK_21,
      newSectionBody: SECTION_BODY,
    });
    expect(result).toBe(`${wrap(WEEK_21, SECTION_BODY)}\n\n${preExisting.replace(/^\n+/u, "")}`);
    expect(result).toContain("Pre-plugin notes");
  });

  it("replaces an existing same-weekKey bounded section in place", () => {
    const initial = `${wrap(WEEK_21, "OLD week 21 body")}\n\n${wrap(WEEK_20, PREV_SECTION_BODY)}\n`;
    const result = spliceWeeklySection({
      existingDoc: initial,
      weekKey: WEEK_21,
      newSectionBody: SECTION_BODY,
    });
    expect(result.startsWith(wrap(WEEK_21, SECTION_BODY))).toBe(true);
    expect(result).not.toContain("OLD week 21 body");
    expect(result).toContain(wrap(WEEK_20, PREV_SECTION_BODY));
  });

  it("only replaces the matching weekKey when multiple weeks are present", () => {
    const initial = `${wrap(WEEK_21, "21 body")}\n\n${wrap(WEEK_20, "20 body")}\n`;
    const result = spliceWeeklySection({
      existingDoc: initial,
      weekKey: WEEK_20,
      newSectionBody: "NEW 20 body",
    });
    expect(result).toContain(wrap(WEEK_21, "21 body"));
    expect(result).toContain(wrap(WEEK_20, "NEW 20 body"));
    expect(result).not.toContain(wrap(WEEK_20, "20 body"));
  });

  it("preserves user-renamed headings inside a sentinel-bounded block (sentinel is the anchor)", () => {
    const renamedHeading = "## (我手动改了标题)\n旧内容";
    const initial = `${wrap(WEEK_21, renamedHeading)}\n`;
    const result = spliceWeeklySection({
      existingDoc: initial,
      weekKey: WEEK_21,
      newSectionBody: SECTION_BODY,
    });
    expect(result).toContain(wrap(WEEK_21, SECTION_BODY));
    expect(result).not.toContain("(我手动改了标题)");
  });

  it("prepends and leaves an orphan begin sentinel in place when end sentinel is missing", () => {
    const orphan = `${buildSentinelStart(WEEK_21)}\nbroken section without end\n`;
    const result = spliceWeeklySection({
      existingDoc: orphan,
      weekKey: WEEK_21,
      newSectionBody: SECTION_BODY,
    });
    expect(result.startsWith(wrap(WEEK_21, SECTION_BODY))).toBe(true);
    expect(result).toContain("broken section without end");
    expect(result).toContain(buildSentinelStart(WEEK_21));
  });

  it("builds sentinels with the documented exact string shape", () => {
    expect(buildSentinelStart(WEEK_21)).toBe("<!-- weekly-report:begin weekKey=2026-W21 -->");
    expect(buildSentinelEnd(WEEK_21)).toBe("<!-- weekly-report:end weekKey=2026-W21 -->");
  });
});
