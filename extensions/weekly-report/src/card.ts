/**
 * Card builder and payload codec for the weekly-report confirmation card.
 *
 * Each card exposes one text input and two buttons: `[直接写入]` confirms the current draft and
 * triggers a write, `[提交补充]` submits supplement text and triggers a re-draft loop. The card
 * payload (`m` field of the Feishu card-interaction envelope) carries `{flowId, action, weekKey}`
 * — `flowId` for routing, `action` for branching, `weekKey` as a stale-card sanity check.
 *
 * `weekKey` and `action` are required and trusted only after the card-action-handler validates
 * them against the bound flow state.
 */

import type { WeeklyReportInput } from "./report-renderer.js";
import { WEEKLY_REPORT_CARD_ACTIONS, type WeeklyReportCardAction } from "./types.js";

export const CARD_INTERACTION_VERSION = "ocf1";
export const CARD_PAYLOAD_TYPE = "weekly_report_card";
export const SUPPLEMENT_INPUT_NAME = "supplement";

export type WeeklyReportCardMetadata = {
  type: typeof CARD_PAYLOAD_TYPE;
  flowId: string;
  weekKey: string;
  action: WeeklyReportCardAction;
};

export type WeeklyReportCardEnvelope = {
  oc: typeof CARD_INTERACTION_VERSION;
  k: "button";
  a: WeeklyReportCardAction;
  m: WeeklyReportCardMetadata;
};

export type WeeklyReportCard = {
  config: { wide_screen_mode: boolean };
  header: {
    template: string;
    title: { tag: "plain_text"; content: string };
  };
  elements: Array<Record<string, unknown>>;
};

export function buildCardEnvelope(params: {
  flowId: string;
  weekKey: string;
  action: WeeklyReportCardAction;
}): WeeklyReportCardEnvelope {
  return {
    oc: CARD_INTERACTION_VERSION,
    k: "button",
    a: params.action,
    m: {
      type: CARD_PAYLOAD_TYPE,
      flowId: params.flowId,
      weekKey: params.weekKey,
      action: params.action,
    },
  };
}

export function buildDraftPreview(draft: WeeklyReportInput): string {
  const lines: string[] = [];
  lines.push(`**${draft.week_title}**`);
  lines.push("");
  lines.push("**本周工作**");
  draft.current_week.forEach((item, idx) => {
    lines.push(`${idx + 1}. **${item.title}** — ${item.objective}`);
  });
  if (draft.next_week.length > 0) {
    lines.push("");
    lines.push("**下周计划**");
    for (const row of draft.next_week) {
      lines.push(`- **${row.project}**: ${row.plan}`);
    }
  }
  return lines.join("\n");
}

export function buildConfirmationCard(params: {
  flowId: string;
  weekKey: string;
  weekTitle: string;
  draft: WeeklyReportInput;
  revisionLabel?: string;
}): WeeklyReportCard {
  const previewMarkdown = buildDraftPreview(params.draft);
  const headerTitle = params.revisionLabel
    ? `Weekly Report — ${params.weekTitle} (${params.revisionLabel})`
    : `Weekly Report — ${params.weekTitle}`;

  const confirmEnvelope = buildCardEnvelope({
    flowId: params.flowId,
    weekKey: params.weekKey,
    action: "confirm",
  });
  const supplementEnvelope = buildCardEnvelope({
    flowId: params.flowId,
    weekKey: params.weekKey,
    action: "supplement",
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: headerTitle },
    },
    elements: [
      { tag: "markdown", content: previewMarkdown },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: "需要补充就在下方输入并提交，否则直接写入。",
        },
      },
      {
        tag: "input",
        name: SUPPLEMENT_INPUT_NAME,
        placeholder: { tag: "plain_text", content: "补充本周新增事项（可选）" },
        max_length: 1000,
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "直接写入" },
            type: "primary",
            value: confirmEnvelope,
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "提交补充" },
            type: "default",
            value: supplementEnvelope,
          },
        ],
      },
    ],
  };
}

export function decodeCardMetadata(value: unknown): WeeklyReportCardMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== CARD_PAYLOAD_TYPE ||
    typeof candidate.flowId !== "string" ||
    typeof candidate.weekKey !== "string" ||
    typeof candidate.action !== "string" ||
    !WEEKLY_REPORT_CARD_ACTIONS.includes(candidate.action as WeeklyReportCardAction)
  ) {
    return null;
  }
  return {
    type: CARD_PAYLOAD_TYPE,
    flowId: candidate.flowId,
    weekKey: candidate.weekKey,
    action: candidate.action as WeeklyReportCardAction,
  };
}
