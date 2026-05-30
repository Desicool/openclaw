/**
 * Shared types and constants for the weekly-report extension.
 *
 * Anything serialized to `stateJson` MUST be JSON-safe (no Date instances, no undefined values
 * inside arrays). The `WeeklyReportFlowState` shape is the single source of truth for what gets
 * persisted via `setWaiting`/`resume`.
 */

import type { WeeklyReportInput } from "./report-renderer.js";

export const WEEKLY_REPORT_CONTROLLER_ID = "weekly-report";

/**
 * Session-key segment for the isolated re-draft sub-session spawned on a supplement. Used both to
 * build the sub-session key (interactive-handler) and to HARD-GATE `respond_to_weekly_report_card`
 * out of that session (index.ts) — a re-draft must submit via `submit_weekly_report_draft`, never
 * call the card-action handler, so we don't even expose it there rather than relying on the prompt.
 */
export const WEEKLY_REPORT_SUPPLEMENT_SESSION_SEGMENT = "weekly-report-supplement";

/** True for the isolated re-draft sub-session spawned on a supplement (key carries the segment). */
export function isWeeklyReportSupplementSession(sessionKey: string | undefined): boolean {
  return (
    typeof sessionKey === "string" &&
    sessionKey.includes(`:${WEEKLY_REPORT_SUPPLEMENT_SESSION_SEGMENT}:`)
  );
}

export const WEEKLY_REPORT_STEPS = {
  awaitUserReply: "await_user_reply",
  revising: "revising",
  writingDoc: "writing_doc",
  done: "done",
  failed: "failed",
} as const;

export type WeeklyReportStep = (typeof WEEKLY_REPORT_STEPS)[keyof typeof WEEKLY_REPORT_STEPS];

export const WEEKLY_REPORT_CARD_ACTIONS = ["confirm", "supplement"] as const;
export type WeeklyReportCardAction = (typeof WEEKLY_REPORT_CARD_ACTIONS)[number];

export type WeeklyReportFlowState = {
  weekKey: string;
  weekTitle: string;
  draft: WeeklyReportInput;
  recipientSessionKey: string;
  targetDocToken: string;
  cardMessageId?: string;
  cardChatId?: string;
  supplementSubmittedAt?: number;
  reminderSentAt?: number;
  writeStartedAt?: number;
  writtenAt?: number;
  lastError?: string;
  supersededAt?: number;
  supersededBy?: string;
  supersedeOf?: string;
};

export function isWeeklyReportFlowState(value: unknown): value is WeeklyReportFlowState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.weekKey === "string" &&
    typeof obj.weekTitle === "string" &&
    typeof obj.recipientSessionKey === "string" &&
    typeof obj.targetDocToken === "string" &&
    typeof obj.draft === "object" &&
    obj.draft !== null
  );
}

export type WeeklyReportFlowStatus = "queued" | "running" | "waiting" | "done" | "failed";

export const ACTIVE_STATUSES: ReadonlySet<WeeklyReportFlowStatus> = new Set([
  "queued",
  "running",
  "waiting",
]);
