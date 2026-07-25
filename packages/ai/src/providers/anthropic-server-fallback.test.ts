import { describe, expect, it } from "vitest";
import {
  CLAUDE_OPUS_FALLBACK_MODEL_COST,
  resolveAnthropicFallbackServingModelCost,
  resolveAnthropicPreOutputFallbackBoundary,
} from "./anthropic-server-fallback.js";

const FABLE_COST = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
const OPUS_FAST_COST = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

describe("Anthropic server-side fallback", () => {
  it.each(["claude-opus-5", "claude-opus-4-8"])(
    "uses standard Opus pricing when Fable falls back to %s",
    (servingModelId) => {
      expect(
        resolveAnthropicFallbackServingModelCost({
          requestedModelId: "claude-fable-5",
          servingModelId,
          requestedCost: FABLE_COST,
        }),
      ).toEqual(CLAUDE_OPUS_FALLBACK_MODEL_COST);
    },
  );

  it("preserves fast-mode pricing when Opus 5 falls back to Opus 4.8", () => {
    expect(
      resolveAnthropicFallbackServingModelCost({
        requestedModelId: "claude-opus-5",
        servingModelId: "claude-opus-4-8",
        requestedCost: OPUS_FAST_COST,
      }),
    ).toEqual(OPUS_FAST_COST);
  });

  it("keeps requested pricing for an unknown future fallback target", () => {
    expect(
      resolveAnthropicFallbackServingModelCost({
        requestedModelId: "claude-fable-5",
        servingModelId: "claude-future-6",
        requestedCost: FABLE_COST,
      }),
    ).toBe(FABLE_COST);
  });

  it("detects pre-output fallback only when the serving model changed", () => {
    expect(
      resolveAnthropicPreOutputFallbackBoundary({
        requestedModelId: "claude-fable-5",
        servingModelId: "claude-opus-5",
      }),
    ).toEqual({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });
    expect(
      resolveAnthropicPreOutputFallbackBoundary({
        requestedModelId: "anthropic/claude-opus-5@20260701",
        servingModelId: "claude-opus-5",
      }),
    ).toBeNull();
  });

  it("preserves fast pricing when an Opus 5 alias resolves to its canonical id", () => {
    expect(
      resolveAnthropicFallbackServingModelCost({
        requestedModelId: "opus",
        servingModelId: "claude-opus-5",
        requestedCost: OPUS_FAST_COST,
      }),
    ).toBe(OPUS_FAST_COST);
  });
});
