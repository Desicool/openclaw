import { describe, expect, it } from "vitest";
import { DRAFTING_PROMPT_TEMPLATE, resolveDraftingPrompt } from "./prompt.js";

describe("DRAFTING_PROMPT_TEMPLATE", () => {
  it("mentions the chat-history tool", () => {
    expect(DRAFTING_PROMPT_TEMPLATE).toContain("runtime.subagent.getSessionMessages");
  });

  it("mentions fetch_git_activity as a data source called in parallel", () => {
    expect(DRAFTING_PROMPT_TEMPLATE).toContain("fetch_git_activity");
    expect(DRAFTING_PROMPT_TEMPLATE).toMatch(/parallel|SAME TURN/iu);
  });

  it("instructs the agent to surface per-repo ok:false gaps", () => {
    expect(DRAFTING_PROMPT_TEMPLATE).toMatch(/ok:\s*false/u);
    expect(DRAFTING_PROMPT_TEMPLATE).toMatch(/missing repo|unavailable/iu);
  });

  it("still names the kickoff tool", () => {
    expect(DRAFTING_PROMPT_TEMPLATE).toContain("submit_weekly_report_draft");
  });

  it("still ships the strict JSON schema fields", () => {
    for (const field of ["current_week", "next_week", "intent", "objective", "completed"]) {
      expect(DRAFTING_PROMPT_TEMPLATE).toContain(field);
    }
  });
});

describe("resolveDraftingPrompt", () => {
  it("returns the default when override is undefined or blank", () => {
    expect(resolveDraftingPrompt(undefined)).toBe(DRAFTING_PROMPT_TEMPLATE);
    expect(resolveDraftingPrompt("")).toBe(DRAFTING_PROMPT_TEMPLATE);
    expect(resolveDraftingPrompt("   ")).toBe(DRAFTING_PROMPT_TEMPLATE);
  });

  it("returns the override when supplied", () => {
    expect(resolveDraftingPrompt("Custom prompt")).toBe("Custom prompt");
  });
});
