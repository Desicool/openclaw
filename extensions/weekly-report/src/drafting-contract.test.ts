import { describe, expect, it } from "vitest";
import {
  DRAFTING_CONTRACT,
  DRAFTING_HARD_RULES,
  buildDraftingContract,
} from "./drafting-contract.js";

describe("DRAFTING_HARD_RULES", () => {
  it("mandates first-person voice and bans second-person advice", () => {
    expect(DRAFTING_HARD_RULES).toContain("第一人称");
    expect(DRAFTING_HARD_RULES).toMatch(/禁止第二人称/);
    expect(DRAFTING_HARD_RULES).toContain("You should");
  });

  it("requires concrete facts and bans chat-history recap in completed bullets", () => {
    expect(DRAFTING_HARD_RULES).toMatch(/completed[\s\S]*事实/);
    expect(DRAFTING_HARD_RULES).toContain("我们讨论了");
    expect(DRAFTING_HARD_RULES).toMatch(/commit/);
  });

  it("bans meta projects and machine ids", () => {
    expect(DRAFTING_HARD_RULES).toMatch(/禁止 meta 项目/);
    expect(DRAFTING_HARD_RULES).toContain("chat_id");
    expect(DRAFTING_HARD_RULES).toContain("message_id");
  });
});

describe("DRAFTING_CONTRACT", () => {
  it("embeds the hard rules and the three fact sources and the JSON schema", () => {
    expect(DRAFTING_CONTRACT).toContain(DRAFTING_HARD_RULES);
    expect(DRAFTING_CONTRACT).toContain("getSessionMessages");
    expect(DRAFTING_CONTRACT).toContain("fetch_git_activity");
    expect(DRAFTING_CONTRACT).toContain("fetch_recent_group_messages");
    expect(DRAFTING_CONTRACT).toContain("submit_weekly_report_draft");
    expect(DRAFTING_CONTRACT).toContain("week_title");
    expect(DRAFTING_CONTRACT).toContain("current_week");
    expect(DRAFTING_CONTRACT).toContain("next_week");
  });

  it("does not instruct the agent to deliver the card via feishu_ask_user_question itself", () => {
    // submit_weekly_report_draft sends the card; the contract must steer away from the old path.
    expect(DRAFTING_CONTRACT).toMatch(/不要.*feishu_ask_user_question/);
  });
});

describe("buildDraftingContract", () => {
  it("substitutes the week hints", () => {
    const out = buildDraftingContract({
      weekKeyHint: "2026-W22",
      weekTitleHint: "2026.5.25-2026.5.31",
    });
    expect(out).toContain("2026-W22");
    expect(out).toContain("2026.5.25-2026.5.31");
    expect(out).not.toContain("{weekKeyHint}");
    expect(out).not.toContain("{weekTitleHint}");
  });
});
