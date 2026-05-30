/**
 * Card builder and payload codec for the weekly-report confirmation card.
 *
 * Each card exposes one text input and two buttons: `[直接写入]` confirms the current draft and
 * triggers a write, `[提交补充]` submits supplement text and triggers a re-draft loop.
 *
 * v5 (2026-05-29): button `value` follows the OpenClaw SDK interactive-handler dispatch contract
 * (`{action: "<namespace>:<verb>", ...fields}`). The lark plugin's interactive-dispatch
 * (`extensions/openclaw-lark/src/channel/interactive-dispatch.js:25` `extractBasics`) reads
 * `value.action`, splits on `:`, and routes to the plugin handler registered for the
 * `weekly-report` namespace. `flowId` and `weekKey` ride on the value object alongside `action`.
 *
 * `weekKey` and `action` are required and trusted only after `validateCardActionTrust` rebinds
 * them against the live flow state.
 */

import type { WeeklyReportInput } from "./report-renderer.js";
import { WEEKLY_REPORT_CARD_ACTIONS, type WeeklyReportCardAction } from "./types.js";

export const CARD_NAMESPACE = "weekly-report";
export const SUPPLEMENT_INPUT_NAME = "supplement";

export type WeeklyReportCardMetadata = {
  flowId: string;
  weekKey: string;
  action: WeeklyReportCardAction;
};

export type WeeklyReportCardEnvelope = {
  /** `weekly-report:<action>` — matches the OpenClaw SDK interactive-dispatch namespace contract. */
  action: string;
  flowId: string;
  weekKey: string;
};

export type WeeklyReportCard = {
  schema: "2.0";
  config: { wide_screen_mode: boolean; update_multi?: boolean };
  header: {
    template: string;
    title: { tag: "plain_text"; content: string };
  };
  body: {
    elements: Array<Record<string, unknown>>;
  };
};

const V2_CARD_CONFIG = { wide_screen_mode: true, update_multi: true } as const;

export function buildCardEnvelope(params: {
  flowId: string;
  weekKey: string;
  action: WeeklyReportCardAction;
}): WeeklyReportCardEnvelope {
  return {
    action: `${CARD_NAMESPACE}:${params.action}`,
    flowId: params.flowId,
    weekKey: params.weekKey,
  };
}

export function parseEnvelopeAction(action: unknown): WeeklyReportCardAction | null {
  if (typeof action !== "string") return null;
  const parts = action.split(":");
  if (parts.length !== 2 || parts[0] !== CARD_NAMESPACE) return null;
  const verb = parts[1];
  return WEEKLY_REPORT_CARD_ACTIONS.includes(verb as WeeklyReportCardAction)
    ? (verb as WeeklyReportCardAction)
    : null;
}

const PREVIEW_MAX_CHARS = 3800;
const PREVIEW_BULLETS_PER_ITEM = 4;
const PREVIEW_BULLET_MAX_CHARS = 180;

function truncateBullet(text: string): string {
  if (text.length <= PREVIEW_BULLET_MAX_CHARS) return text;
  return `${text.slice(0, PREVIEW_BULLET_MAX_CHARS - 1)}…`;
}

export function buildDraftPreview(draft: WeeklyReportInput): string {
  const lines: string[] = [];
  lines.push(`**${draft.week_title}**`);
  lines.push("");
  lines.push("**本周工作**");
  draft.current_week.forEach((item, idx) => {
    lines.push("");
    lines.push(`**${idx + 1}. ${item.title}**`);
    lines.push(`*意图*: ${item.intent}`);
    lines.push(`*目标*: ${item.objective}`);
    lines.push(`*已完成*:`);
    const shown = item.completed.slice(0, PREVIEW_BULLETS_PER_ITEM);
    for (const bullet of shown) {
      lines.push(`- ${truncateBullet(bullet)}`);
    }
    const hidden = item.completed.length - shown.length;
    if (hidden > 0) {
      lines.push(`- …还有 ${hidden} 条已完成`);
    }
  });
  if (draft.next_week.length > 0) {
    lines.push("");
    lines.push("**下周计划**");
    for (const row of draft.next_week) {
      lines.push(`- **${row.project}**: ${row.plan}`);
    }
  }
  const out = lines.join("\n");
  if (out.length <= PREVIEW_MAX_CHARS) return out;
  return `${out.slice(0, PREVIEW_MAX_CHARS - 60)}…\n\n*(预览已截断，完整内容确认后写入文档)*`;
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

  const formElements: Array<Record<string, unknown>> = [
    { tag: "markdown", content: previewMarkdown },
    { tag: "hr" },
    {
      tag: "markdown",
      content:
        "**确认或补充本周报：**\n" +
        "- 直接写入：点「直接写入」把当前草稿写入飞书文档。\n" +
        "- 调整草稿：在下方输入框写补充意图，然后点「提交补充」。例如：\n" +
        "  - `加上：周三和欢哥对齐了 demo 节奏`\n" +
        "  - `删除第 2 条`\n" +
        "  - `第 1 条改为：完成 growx-runtime compaction issue 的方案评审`",
    },
    {
      tag: "input",
      name: SUPPLEMENT_INPUT_NAME,
      input_type: "multiline_text",
      rows: 6,
      placeholder: {
        tag: "plain_text",
        content: "补充 / 修改 / 删除（提交后由 silver-chariot 重新整理草稿并再发卡片）",
      },
    },
    // NOTE: For v2 cards with `form_action_type: "submit"`, the callback payload MUST live in
    // `behaviors: [{type: "callback", value: ...}]`, NOT as a top-level `value` field. Top-level
    // `value` is v1 syntax and v2 form-submit buttons ignore it (Feishu delivers `hasValue=false`
    // in the click event). See https://open.larksuite.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/button.
    {
      tag: "button",
      name: "weekly_report_confirm_button",
      text: { tag: "plain_text", content: "直接写入" },
      type: "primary",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: confirmEnvelope }],
    },
    {
      tag: "button",
      name: "weekly_report_supplement_button",
      text: { tag: "plain_text", content: "提交补充" },
      type: "default",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: supplementEnvelope }],
    },
  ];

  return {
    schema: "2.0",
    config: { ...V2_CARD_CONFIG },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: headerTitle },
    },
    body: {
      elements: [
        {
          tag: "form",
          name: "weekly_report_form",
          elements: formElements,
        },
      ],
    },
  };
}

export function decodeCardMetadata(value: unknown): WeeklyReportCardMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const parsedAction = parseEnvelopeAction(candidate.action);
  if (
    !parsedAction ||
    typeof candidate.flowId !== "string" ||
    typeof candidate.weekKey !== "string"
  ) {
    return null;
  }
  return {
    flowId: candidate.flowId,
    weekKey: candidate.weekKey,
    action: parsedAction,
  };
}
