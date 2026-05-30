import { describe, expect, it } from "vitest";
import {
  CARD_NAMESPACE,
  buildCardEnvelope,
  buildConfirmationCard,
  buildDraftPreview,
  decodeCardMetadata,
  parseEnvelopeAction,
} from "./card.js";
import type { WeeklyReportInput } from "./report-renderer.js";

const SAMPLE: WeeklyReportInput = {
  week_title: "2026.5.18-2026.5.24",
  current_week: [
    { title: "Item A", intent: "i", objective: "obj-a", completed: ["x"] },
    { title: "Item B", intent: "i", objective: "obj-b", completed: ["y"] },
  ],
  next_week: [{ project: "P", plan: "do P" }],
};

describe("card payload codec", () => {
  it("round-trips a confirm envelope using the SDK-standard action namespace format", () => {
    const envelope = buildCardEnvelope({
      flowId: "flow-123",
      weekKey: "2026-W21",
      action: "confirm",
    });
    expect(envelope.action).toBe(`${CARD_NAMESPACE}:confirm`);
    expect(envelope.flowId).toBe("flow-123");
    expect(envelope.weekKey).toBe("2026-W21");
    expect(decodeCardMetadata(envelope)).toEqual({
      flowId: "flow-123",
      weekKey: "2026-W21",
      action: "confirm",
    });
  });

  it("round-trips a supplement envelope", () => {
    const envelope = buildCardEnvelope({
      flowId: "flow-123",
      weekKey: "2026-W21",
      action: "supplement",
    });
    expect(envelope.action).toBe(`${CARD_NAMESPACE}:supplement`);
    expect(decodeCardMetadata(envelope)?.action).toBe("supplement");
  });

  it("parseEnvelopeAction rejects unknown verbs and wrong namespace", () => {
    expect(parseEnvelopeAction(`${CARD_NAMESPACE}:approve`)).toBeNull();
    expect(parseEnvelopeAction("other-plugin:confirm")).toBeNull();
    expect(parseEnvelopeAction("noprefix")).toBeNull();
    expect(parseEnvelopeAction(`${CARD_NAMESPACE}:confirm`)).toBe("confirm");
  });

  it("decodeCardMetadata rejects unknown action verbs", () => {
    expect(
      decodeCardMetadata({
        action: `${CARD_NAMESPACE}:approve`,
        flowId: "f",
        weekKey: "2026-W21",
      }),
    ).toBeNull();
  });

  it("decodeCardMetadata rejects wrong namespace", () => {
    expect(
      decodeCardMetadata({
        action: "other-plugin:confirm",
        flowId: "f",
        weekKey: "2026-W21",
      }),
    ).toBeNull();
  });

  it("decodeCardMetadata rejects missing fields", () => {
    expect(decodeCardMetadata({ action: `${CARD_NAMESPACE}:confirm` })).toBeNull();
    expect(decodeCardMetadata(null)).toBeNull();
    expect(decodeCardMetadata("string")).toBeNull();
  });

  it("envelope values are JSON-primitive only (safe to embed in card button.value)", () => {
    const env = buildCardEnvelope({ flowId: "f", weekKey: "2026-W21", action: "confirm" });
    for (const value of Object.values(env)) {
      const t = typeof value;
      expect(t === "string" || t === "number" || t === "boolean" || value === null).toBe(true);
    }
  });
});

describe("buildDraftPreview", () => {
  it("renders project headlines plus intent + objective + completed bullets per project", () => {
    const preview = buildDraftPreview(SAMPLE);
    expect(preview).toContain("**2026.5.18-2026.5.24**");
    expect(preview).toContain("**1. Item A**");
    expect(preview).toContain("**2. Item B**");
    expect(preview).toContain("*意图*: i");
    expect(preview).toContain("*目标*: obj-a");
    expect(preview).toContain("*目标*: obj-b");
    expect(preview).toContain("*已完成*:");
    expect(preview).toContain("- x");
    expect(preview).toContain("- y");
    expect(preview).toContain("- **P**: do P");
  });

  it("caps bullets per project and adds an overflow indicator", () => {
    const sample: WeeklyReportInput = {
      week_title: "2026.5.18-2026.5.24",
      current_week: [
        {
          title: "Heavy week",
          intent: "i",
          objective: "obj",
          completed: ["a", "b", "c", "d", "e", "f"],
        },
      ],
      next_week: [{ project: "P", plan: "do P" }],
    };
    const preview = buildDraftPreview(sample);
    expect(preview).toContain("- a");
    expect(preview).toContain("- d");
    expect(preview).not.toContain("- e");
    expect(preview).toMatch(/还有 2 条已完成/);
  });

  it("truncates individual bullets longer than the per-bullet cap", () => {
    const long = "x".repeat(400);
    const sample: WeeklyReportInput = {
      week_title: "2026.5.18-2026.5.24",
      current_week: [{ title: "Long bullet", intent: "i", objective: "obj", completed: [long] }],
      next_week: [{ project: "P", plan: "do P" }],
    };
    const preview = buildDraftPreview(sample);
    expect(preview).toContain("…");
    const lineCount = preview.split("\n").filter((l) => l.startsWith("- x")).length;
    expect(lineCount).toBe(1);
  });

  it("caps total preview length and appends a truncation note", () => {
    const huge = "工作内容描述".repeat(200);
    const sample: WeeklyReportInput = {
      week_title: "2026.5.18-2026.5.24",
      current_week: Array.from({ length: 6 }, (_, i) => ({
        title: `项目 ${i + 1}`,
        intent: "i",
        objective: huge,
        completed: [huge, huge, huge, huge],
      })),
      next_week: [{ project: "P", plan: "do P" }],
    };
    const preview = buildDraftPreview(sample);
    expect(preview.length).toBeLessThanOrEqual(3900);
    expect(preview).toContain("预览已截断");
  });
});

describe("buildConfirmationCard", () => {
  it("uses schema 2.0 with a form wrapper containing input + buttons", () => {
    const card = buildConfirmationCard({
      flowId: "flow-1",
      weekKey: "2026-W21",
      weekTitle: "2026.5.18-2026.5.24",
      draft: SAMPLE,
    });
    expect(card.schema).toBe("2.0");
    expect(card.header.title.content).toBe("Weekly Report — 2026.5.18-2026.5.24");
    const form = card.body.elements.find((el) => el.tag === "form") as
      | { name: string; elements: Array<Record<string, unknown>> }
      | undefined;
    expect(form).toBeDefined();
    expect(form!.name).toBe("weekly_report_form");
    const input = form!.elements.find((el) => el.tag === "input") as { name: string } | undefined;
    expect(input).toBeDefined();
    expect(input!.name).toBe("supplement");
    const buttons = form!.elements.filter((el) => el.tag === "button") as Array<{
      name: string;
      text: { content: string };
      form_action_type: string;
      behaviors: Array<{
        type: string;
        value: { action: string; flowId: string; weekKey: string };
      }>;
    }>;
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.name).toBe("weekly_report_confirm_button");
    expect(buttons[0]!.text.content).toBe("直接写入");
    expect(buttons[0]!.form_action_type).toBe("submit");
    expect(buttons[0]!.behaviors).toHaveLength(1);
    expect(buttons[0]!.behaviors[0]!.type).toBe("callback");
    expect(buttons[0]!.behaviors[0]!.value.action).toBe(`${CARD_NAMESPACE}:confirm`);
    expect(buttons[0]!.behaviors[0]!.value.flowId).toBe("flow-1");
    expect(buttons[0]!.behaviors[0]!.value.weekKey).toBe("2026-W21");
    expect(buttons[1]!.name).toBe("weekly_report_supplement_button");
    expect(buttons[1]!.text.content).toBe("提交补充");
    expect(buttons[1]!.form_action_type).toBe("submit");
    expect(buttons[1]!.behaviors[0]!.type).toBe("callback");
    expect(buttons[1]!.behaviors[0]!.value.action).toBe(`${CARD_NAMESPACE}:supplement`);
    expect(buttons[1]!.behaviors[0]!.value.flowId).toBe("flow-1");
    expect(buttons[1]!.behaviors[0]!.value.weekKey).toBe("2026-W21");
  });

  it("supplement input is multiline (textarea) with rows ≥ 4", () => {
    const card = buildConfirmationCard({
      flowId: "flow-1",
      weekKey: "2026-W21",
      weekTitle: "2026.5.18-2026.5.24",
      draft: SAMPLE,
    });
    const form = card.body.elements.find((el) => el.tag === "form") as
      | { elements: Array<Record<string, unknown>> }
      | undefined;
    const input = form!.elements.find((el) => el.tag === "input") as
      | { name: string; input_type?: string; rows?: number }
      | undefined;
    expect(input).toBeDefined();
    expect(input!.input_type).toBe("multiline_text");
    expect(input!.rows).toBeGreaterThanOrEqual(4);
  });

  it("includes a markdown hint about delete/modify supplement syntax", () => {
    const card = buildConfirmationCard({
      flowId: "flow-1",
      weekKey: "2026-W21",
      weekTitle: "2026.5.18-2026.5.24",
      draft: SAMPLE,
    });
    const form = card.body.elements.find((el) => el.tag === "form") as
      | { elements: Array<{ tag: string; content?: string }> }
      | undefined;
    const hint = form!.elements.find(
      (el) =>
        el.tag === "markdown" &&
        typeof el.content === "string" &&
        el.content.includes("删除第") &&
        el.content.includes("改为"),
    );
    expect(hint).toBeDefined();
  });

  it("decorates the header with a revision label when supplied", () => {
    const card = buildConfirmationCard({
      flowId: "flow-1",
      weekKey: "2026-W21",
      weekTitle: "2026.5.18-2026.5.24",
      draft: SAMPLE,
      revisionLabel: "Revision 2",
    });
    expect(card.header.title.content).toContain("(Revision 2)");
  });
});
