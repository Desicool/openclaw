import { describe, expect, it } from "vitest";
import {
  CARD_INTERACTION_VERSION,
  CARD_PAYLOAD_TYPE,
  buildCardEnvelope,
  buildConfirmationCard,
  buildDraftPreview,
  decodeCardMetadata,
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
  it("round-trips a confirm envelope", () => {
    const envelope = buildCardEnvelope({
      flowId: "flow-123",
      weekKey: "2026-W21",
      action: "confirm",
    });
    expect(envelope.oc).toBe(CARD_INTERACTION_VERSION);
    expect(envelope.a).toBe("confirm");
    const decoded = decodeCardMetadata(envelope.m);
    expect(decoded).toEqual({
      type: CARD_PAYLOAD_TYPE,
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
    expect(envelope.a).toBe("supplement");
    expect(decodeCardMetadata(envelope.m)?.action).toBe("supplement");
  });

  it("rejects unknown action values", () => {
    expect(
      decodeCardMetadata({
        type: CARD_PAYLOAD_TYPE,
        flowId: "f",
        weekKey: "2026-W21",
        action: "approve",
      }),
    ).toBeNull();
  });

  it("rejects metadata with wrong type marker", () => {
    expect(
      decodeCardMetadata({
        type: "other_card",
        flowId: "f",
        weekKey: "2026-W21",
        action: "confirm",
      }),
    ).toBeNull();
  });

  it("rejects metadata with missing fields", () => {
    expect(decodeCardMetadata({ type: CARD_PAYLOAD_TYPE })).toBeNull();
    expect(decodeCardMetadata(null)).toBeNull();
    expect(decodeCardMetadata("string")).toBeNull();
  });

  it("metadata values are envelope-compatible primitives only", () => {
    const env = buildCardEnvelope({ flowId: "f", weekKey: "2026-W21", action: "confirm" });
    for (const value of Object.values(env.m)) {
      const t = typeof value;
      expect(t === "string" || t === "number" || t === "boolean" || value === null).toBe(true);
    }
  });
});

describe("buildDraftPreview", () => {
  it("renders project headlines, not full DocXML", () => {
    const preview = buildDraftPreview(SAMPLE);
    expect(preview).toContain("**2026.5.18-2026.5.24**");
    expect(preview).toContain("1. **Item A** — obj-a");
    expect(preview).toContain("2. **Item B** — obj-b");
    expect(preview).toContain("- **P**: do P");
    expect(preview).not.toContain("<lark-table");
  });
});

describe("buildConfirmationCard", () => {
  it("includes both buttons each carrying the envelope payload", () => {
    const card = buildConfirmationCard({
      flowId: "flow-1",
      weekKey: "2026-W21",
      weekTitle: "2026.5.18-2026.5.24",
      draft: SAMPLE,
    });
    expect(card.header.title.content).toBe("Weekly Report — 2026.5.18-2026.5.24");
    const action = card.elements.find((el) => el.tag === "action") as
      | { actions: Array<{ text: { content: string }; value: { m: { action: string } } }> }
      | undefined;
    expect(action).toBeDefined();
    expect(action!.actions).toHaveLength(2);
    expect(action!.actions[0].text.content).toBe("直接写入");
    expect(action!.actions[0].value.m.action).toBe("confirm");
    expect(action!.actions[1].text.content).toBe("提交补充");
    expect(action!.actions[1].value.m.action).toBe("supplement");
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
