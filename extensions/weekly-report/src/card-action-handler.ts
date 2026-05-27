/**
 * Card-action input normalization for `respond_to_weekly_report_card`.
 *
 * The agent is the caller of `respond_to_weekly_report_card`. It receives a synthetic card-action
 * event from the Feishu plugin, extracts the metadata + optional supplement text, and passes them
 * to this extension's tool. This module hosts the pure parsing logic so it can be unit-tested in
 * isolation from the tool's flow-mutation side effects.
 */

import { decodeCardMetadata, type WeeklyReportCardMetadata } from "./card.js";

export type RespondToCardArgs = {
  flowId: string;
  action: "confirm" | "supplement";
  weekKey: string;
  supplement?: string;
};

export type CardActionParseResult =
  | { ok: true; args: RespondToCardArgs }
  | { ok: false; reason: "malformed_metadata" | "wrong_action_supplement_required" };

export function parseCardActionInput(input: {
  metadata: unknown;
  supplement?: unknown;
}): CardActionParseResult {
  const metadata: WeeklyReportCardMetadata | null = decodeCardMetadata(input.metadata);
  if (!metadata) {
    return { ok: false, reason: "malformed_metadata" };
  }

  if (metadata.action === "supplement") {
    const supplement = readOptionalSupplement(input.supplement);
    if (!supplement) {
      return { ok: false, reason: "wrong_action_supplement_required" };
    }
    return {
      ok: true,
      args: {
        flowId: metadata.flowId,
        weekKey: metadata.weekKey,
        action: "supplement",
        supplement,
      },
    };
  }

  return {
    ok: true,
    args: {
      flowId: metadata.flowId,
      weekKey: metadata.weekKey,
      action: "confirm",
    },
  };
}

function readOptionalSupplement(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
