/**
 * Interactive handler for the weekly-report card buttons.
 *
 * Confirm path delegates the doc write to `doc-writer.writeWeeklySection`, which does NON-DESTRUCTIVE
 * block-level surgery on the official `lark-cli` (`larkOfficialCli*` settings, identity = `docIdentity`):
 * it inserts the new week's section at the document head and replaces only this week's prior section,
 * leaving every other block (other weeks, images, comments) intact. This replaced the old
 * fetch→splice→`doc update --mode overwrite` path, which cleared and re-rendered the whole doc.
 * Card sender also runs on `larkOfficialCli*` (`im +messages-send --as bot`).
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { SUPPLEMENT_INPUT_NAME, parseEnvelopeAction } from "./card.js";
import { writeWeeklySection } from "./doc-writer.js";
import { DRAFTING_HARD_RULES } from "./drafting-contract.js";
import { renderReport } from "./report-renderer.js";
import type { WeeklyReportPluginSettings } from "./settings.js";
import { validateCardActionTrust } from "./tools.js";
import {
  WEEKLY_REPORT_STEPS,
  WEEKLY_REPORT_SUPPLEMENT_SESSION_SEGMENT,
  isWeeklyReportFlowState,
} from "./types.js";

export type RunCommandFn = PluginRuntime["system"]["runCommandWithTimeout"];

export type InteractiveRespond = {
  reply: (args: { text: string }) => Promise<void>;
  followUp?: (args: { text: string }) => Promise<void>;
  editMessage?: (args: { blocks?: unknown[]; toast?: unknown }) => Promise<void>;
};

export type WeeklyReportInteractiveCtx = {
  channel: string;
  accountId?: string;
  senderId?: string;
  conversationId?: string;
  messageId?: string;
  namespace: string;
  payload: string;
  action: string;
  rawEvent: unknown;
  respond: InteractiveRespond;
};

export type WeeklyReportInteractiveResult = {
  handled: boolean;
  toast?: { type: "info" | "success" | "error" | "warning"; content: string };
};

export type CreateInteractiveHandlerDeps = {
  taskFlow: Parameters<typeof validateCardActionTrust>[0]["taskFlow"];
  controllerId: string;
  settings: WeeklyReportPluginSettings;
  runCommand: RunCommandFn;
  /** Optional. When provided, the supplement path spawns a real agent turn to re-draft. */
  subagentRun?: SubagentRunFn;
};

function safeParseEvent(raw: unknown): {
  value?: Record<string, unknown>;
  formValue?: Record<string, unknown>;
} {
  let event: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      event = JSON.parse(raw) as Record<string, unknown> | null;
    } catch {
      return {};
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    event = raw as Record<string, unknown>;
  }
  if (!event) {
    return {};
  }
  const action = event.action as Record<string, unknown> | undefined;
  const value =
    action &&
    typeof action.value === "object" &&
    action.value !== null &&
    !Array.isArray(action.value)
      ? (action.value as Record<string, unknown>)
      : undefined;
  const formCandidates = [
    action?.form_value,
    action?.input_value,
    event.form_value,
    event.input_value,
  ];
  let formValue: Record<string, unknown> | undefined;
  for (const cand of formCandidates) {
    if (cand && typeof cand === "object" && !Array.isArray(cand)) {
      formValue = cand as Record<string, unknown>;
      break;
    }
  }
  return value ? { value, ...(formValue ? { formValue } : {}) } : {};
}

function readSupplementText(formValue: Record<string, unknown> | undefined): string | undefined {
  if (!formValue) {
    return undefined;
  }
  const raw = formValue[SUPPLEMENT_INPUT_NAME];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export type SubagentRunFn = (params: {
  sessionKey: string;
  message: string;
  deliver?: boolean;
  lightContext?: boolean;
}) => Promise<{ runId: string }>;

export function createWeeklyReportInteractiveHandler(deps: CreateInteractiveHandlerDeps) {
  const { taskFlow, controllerId, settings, runCommand, subagentRun } = deps;
  const { recipientSessionKey } = settings;

  return async function handler(
    ctx: WeeklyReportInteractiveCtx,
  ): Promise<WeeklyReportInteractiveResult> {
    const { value, formValue } = safeParseEvent(ctx.rawEvent);
    if (!value) {
      return { handled: true, toast: { type: "error", content: "卡片事件无法解析" } };
    }

    const actionVerb = parseEnvelopeAction(value.action);
    const flowId = typeof value.flowId === "string" ? value.flowId : undefined;
    const weekKey = typeof value.weekKey === "string" ? value.weekKey : undefined;
    if (!actionVerb || !flowId || !weekKey) {
      return { handled: true, toast: { type: "error", content: "卡片元数据不完整" } };
    }

    if (!recipientSessionKey) {
      return {
        handled: true,
        toast: { type: "error", content: "插件未配置 recipientSessionKey，无法验证 flow。" },
      };
    }

    const trustResult = validateCardActionTrust({
      taskFlow,
      controllerId,
      bindings: { flowId, weekKey, sessionKey: recipientSessionKey },
    });
    if (!trustResult.ok) {
      const reasonText = trustResult.reason.replace(/_/g, " ");
      return { handled: true, toast: { type: "warning", content: `卡片已失效（${reasonText}）` } };
    }
    const flow = trustResult.flow;
    if (!isWeeklyReportFlowState(flow.stateJson)) {
      return { handled: true, toast: { type: "error", content: "flow 状态损坏，无法读取草稿。" } };
    }
    const state = flow.stateJson;

    if (actionVerb === "supplement") {
      const supplementText = readSupplementText(formValue);
      if (!supplementText) {
        return {
          handled: true,
          toast: { type: "warning", content: "补充内容为空。请在输入框填写后再点击补充。" },
        };
      }

      const revisingTransition = taskFlow.resume({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        status: "running",
        currentStep: WEEKLY_REPORT_STEPS.revising,
        stateJson: { ...state, supplementSubmittedAt: Date.now() } as never,
      });
      if (!revisingTransition.applied) {
        return {
          handled: true,
          toast: { type: "error", content: "无法将 flow 转入 revising 状态。" },
        };
      }

      await ctx.respond
        .reply({ text: "📝 已收到补充内容，启动隔离子会话重新整理草稿…" })
        .catch(() => {});

      if (!subagentRun) {
        return {
          handled: true,
          toast: {
            type: "error",
            content: "runtime.subagent 不可用，无法触发 re-draft。请直接在 DM 回复补充内容。",
          },
        };
      }

      const messageText = [
        `承太郎对本周周报（flow=${flow.flowId}，weekKey=${weekKey}）的补充输入：`,
        `"""`,
        supplementText,
        `"""`,
        ``,
        `**这段文字是研究提示，不是要直接抄进草稿的内容。请按下面这个流程处理：**`,
        ``,
        `**重要——你的角色和唯一出口**：你现在在一个隔离子会话里「重新起草修订版」。卡片点击已经由插件处理完毕，flow=${flow.flowId} 已进入 revising 状态。本回合**唯一**的提交动作是调用 \`submit_weekly_report_draft\`（带 \`supersedeFlowId: "${flow.flowId}"\`）。**绝对禁止调用 \`respond_to_weekly_report_card\`**——那是处理卡片点击的工具，不是给你重新起草用的；从这个子会话调用它会因 session 不匹配被拒绝（返回 "card no longer valid"），修订直接失败。也不要调用 \`feishu_ask_user_question\`。不要传 \`sessionKey: "current"\` 之类的占位值。`,
        ``,
        `**1) 解析提示意图**：把上面这段文字分类成下面之一（或几种叠加）。`,
        `   a) **删除/重排指令**（"删除第 N 条" / "第 N 条改为 X" / "把 A 和 B 合并" / "顺序换成 …"）→ 按指示直接对 current_week 数组做结构调整。`,
        `   b) **长期事实 / 角色框定**（"我是 X 项目的 DRI"、"我们做 AI agent"、"团队在 jackery 投放方向"）→ 作为搜索/过滤上下文使用，不要写进 completed 或 intent 里。`,
        `   c) **新增事实指针**（"加上：本周和欢哥对齐了 demo 节奏"、"还要补一条 growx-runtime 的进展"）→ 作为查找事实的 hint。`,
        ``,
        `**2) 重新挖掘事实**（不要凭这段文字本身写 bullet）：基于上面解析出来的提示，在同一回合内重新并行调用：`,
        `   - runtime.subagent.getSessionMessages —— 本 DM 对话过去 7 天，重点查与提示相关的讨论。`,
        `   - fetch_git_activity —— 本周配置仓库中你的提交，重点找提示相关的 commit。`,
        `   - fetch_recent_group_messages —— 本周飞书群消息，重点提取提示提到的人/项目/话题。`,
        ``,
        `**3) 合并而不是替换**：以原草稿作为基线（已经在 flow stateJson 里），按下面规则更新：`,
        `   - 删除/重排指令：按指令重排 current_week；如果某项被删，把它的 next_week 也一并去掉。`,
        `   - 新增事实指针：根据 hint 重新挖掘到的真实素材，补 completed bullet，可能新增 current_week 项目。**不要把承太郎的话本身当成 bullet 内容。**`,
        `   - 长期事实 / 角色框定：吸收为本回合的查询/过滤上下文，让你更精准找到对应项目的 commits/群聊；不要把它本身写进 intent / objective / completed。`,
        `   - 其他原草稿里已经成立的 bullet 全部保留，除非和补充直接冲突。`,
        ``,
        // The supplement re-draft runs in a fresh isolated sub-session that does NOT carry the
        // original cron turn's context, so the begin_weekly_report contract is NOT visible here.
        // Inline the shared rules verbatim so this round enforces the exact same voice/content rules.
        `**4) 草稿硬规则**（周报的统一口径，revision 中同样不允许放松）：`,
        DRAFTING_HARD_RULES,
        ``,
        `**5) 唯一提交方式：调用 submit_weekly_report_draft({ weekKey: "${weekKey}", weekTitle, draftJson, supersedeFlowId: "${flow.flowId}", revisionLabel: "revision 2" })** 提交修订版。该工具会自动投递新卡片；你这一回合到此结束。这是本回合唯一允许的卡片相关工具。`,
        ``,
        `**禁止**：调用 \`respond_to_weekly_report_card\`（上一次修订就是因此失败——它会被 session_mismatch 拒绝；重新起草只用 submit_weekly_report_draft）；调用 \`feishu_ask_user_question\`；把承太郎的原话当 completed bullet；只改 intent/objective 不改事实；不重新调用三个事实源；在 bullet 中保留 chat_id/message_id；把"职责边界澄清"之类元工作写成项目。`,
      ].join("\n");

      // Run the re-draft in an isolated sub-session (same shape as cron runs use). Keeps
      // the user's DM clean and prevents the main silver-chariot loop from being entangled in
      // weekly-report meta-conversation. The submit_weekly_report_draft tool, when called from
      // this isolated session, still creates flows owned by recipientSessionKey because the
      // plugin's `withBoundFlow` always binds via `settings.recipientSessionKey` (see index.ts).
      const supplementAgentId =
        /^agent:([^:]+):/u.exec(recipientSessionKey)?.[1] ?? "silver-chariot";
      const isolatedSessionKey = `agent:${supplementAgentId}:${WEEKLY_REPORT_SUPPLEMENT_SESSION_SEGMENT}:${flow.flowId}:${Date.now()}`;
      try {
        await subagentRun({
          sessionKey: isolatedSessionKey,
          message: messageText,
          deliver: false,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          handled: true,
          toast: { type: "error", content: `补充回传失败: ${msg.slice(0, 100)}` },
        };
      }
      return { handled: true, toast: { type: "success", content: "Supplement queued" } };
    }

    // confirm path — do the whole doc-write inline via lark-cli.
    const writingTransition = taskFlow.resume({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      status: "running",
      currentStep: WEEKLY_REPORT_STEPS.writingDoc,
      stateJson: { ...state, writeStartedAt: Date.now() } as never,
    });
    if (!writingTransition.applied) {
      return {
        handled: true,
        toast: { type: "error", content: "无法将 flow 转入 writing_doc 状态。" },
      };
    }
    const writingRevision = writingTransition.flow.revision;

    await ctx.respond.reply({ text: "✅ 已收到确认，正在写入周报文档…" }).catch(() => {});

    const docToken = state.targetDocToken;
    if (!docToken) {
      taskFlow.fail({
        flowId: flow.flowId,
        expectedRevision: writingRevision,
        stateJson: { ...state, lastError: "targetDocToken missing" } as never,
      });
      return {
        handled: true,
        toast: { type: "error", content: "未配置 targetDocToken，无法写入文档。" },
      };
    }

    let renderedSection: string;
    try {
      renderedSection = renderReport(state.draft).trimEnd();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      taskFlow.fail({
        flowId: flow.flowId,
        expectedRevision: writingRevision,
        stateJson: { ...state, lastError: `render failed: ${msg}` } as never,
      });
      return {
        handled: true,
        toast: { type: "error", content: `渲染草稿失败: ${msg.slice(0, 100)}` },
      };
    }

    const writeRes = await writeWeeklySection({
      runCommand,
      binPath: settings.larkOfficialCliBinPath,
      asIdentity: settings.docIdentity,
      docToken,
      weekKey,
      weekTitle: state.weekTitle,
      sectionMarkdown: renderedSection,
      timeoutMs: settings.larkOfficialCliTimeoutMs,
    });
    if (!writeRes.ok) {
      taskFlow.fail({
        flowId: flow.flowId,
        expectedRevision: writingRevision,
        stateJson: { ...state, lastError: writeRes.error } as never,
      });
      return {
        handled: true,
        toast: { type: "error", content: `写入周报文档失败: ${writeRes.error.slice(0, 100)}` },
      };
    }

    taskFlow.finish({
      flowId: flow.flowId,
      expectedRevision: writingRevision,
      stateJson: {
        ...state,
        writeStartedAt: state.writeStartedAt ?? Date.now(),
        writtenAt: Date.now(),
      } as never,
    });

    const writtenText = writeRes.titleNote
      ? `✅ 周报已写入文档（${state.weekTitle}）。\n⚠️ ${writeRes.titleNote}`
      : `✅ 周报已写入文档（${state.weekTitle}）。`;
    await ctx.respond.reply({ text: writtenText }).catch(() => {});

    return { handled: true, toast: { type: "success", content: "Report written" } };
  };
}
