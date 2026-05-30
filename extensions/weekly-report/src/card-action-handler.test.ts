import { describe, expect, it } from "vitest";
import { parseCardActionInput } from "./card-action-handler.js";
import { buildCardEnvelope } from "./card.js";

describe("parseCardActionInput", () => {
  it("parses a confirm envelope without supplement", () => {
    const envelope = buildCardEnvelope({
      flowId: "flow-1",
      weekKey: "2026-W21",
      action: "confirm",
    });
    const result = parseCardActionInput({ metadata: envelope });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({
        flowId: "flow-1",
        weekKey: "2026-W21",
        action: "confirm",
      });
    }
  });

  it("parses a supplement envelope with trimmed supplement text", () => {
    const envelope = buildCardEnvelope({
      flowId: "flow-1",
      weekKey: "2026-W21",
      action: "supplement",
    });
    const result = parseCardActionInput({
      metadata: envelope,
      supplement: "  also worked on GrowX  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.action).toBe("supplement");
      expect(result.args.supplement).toBe("also worked on GrowX");
    }
  });

  it("rejects a supplement envelope without supplement text", () => {
    const envelope = buildCardEnvelope({
      flowId: "flow-1",
      weekKey: "2026-W21",
      action: "supplement",
    });
    const result = parseCardActionInput({ metadata: envelope });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong_action_supplement_required");
    }
  });

  it("rejects malformed metadata", () => {
    const result = parseCardActionInput({ metadata: { foo: "bar" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed_metadata");
    }
  });
});
