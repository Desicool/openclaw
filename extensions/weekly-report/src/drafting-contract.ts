/**
 * Plugin-owned drafting contract for the weekly report.
 *
 * Why this lives in the plugin (not the host cron `jobs.json`): the report's VOICE and CONTENT rules
 * are product behavior, not per-deployment config, so they ship with the plugin and stay consistent
 * for everyone who installs it. The cron entry is reduced to a one-line trigger that tells the agent
 * to call `begin_weekly_report` and follow the contract this module returns. Per-deployment specifics
 * (which projects, who the DRI is) still come from the agent's own context and the user's supplement
 * input — never hardcoded here.
 *
 * `DRAFTING_HARD_RULES` is the single source of truth for the voice/content rules. It is spliced into
 * both the first-round contract (`DRAFTING_CONTRACT`, returned by `begin_weekly_report`) and the
 * supplement re-draft prompt (`interactive-handler.ts`), so the two rounds never drift.
 */

/**
 * Voice + content rules shared by the first-round draft and every supplement re-draft.
 *
 * Perspective is first person ("我"/I): the report is authored BY the user FOR their manager, so it
 * reports what *I* did — never second-person advice ("你应该…" / "You should…"). `completed` bullets
 * are concrete facts (shipped code, submissions, agreed conclusions), not a recap of conversations.
 */
export const DRAFTING_HARD_RULES = `\
**草稿硬规则（第一轮和补充修订都必须遵守，不允许放松）：**

1. **视角＝第一人称「我」。** 这份周报是「我」（对话的人类主人）写给「我的主管」看的，汇报「我」本周
   做了什么。所有文字用第一人称：「我实现了 X」「我提交了 Y」「我和团队定下了 Z」。
   - **禁止第二人称建议口吻**：不允许出现「你应该…」「建议你…」「You should…」这类把读者当成被指导对象的写法。
   - \`intent\`＝我为什么做这个项目（动机）；\`objective\`＝这个项目本身在产品/业务/技术上要达成什么，
     **不是**「让周报写清楚」这种写作目标；\`completed\`＝本周我实际产出/推进的动作。

2. **\`completed\` 写事实，不写聊天记录。** 每条 bullet 必须落在可核验的产出上：
   - 引用真实代码动作——提交/合并/上线（引用 \`fetch_git_activity\` 的 commit 标题 + 分支/ref）。
   - 引用真实交付物——提交的方案、文档、PR、发布。
   - 引用**已达成并对齐的结论/决策**（写清结论本身，而不是「我们聊到了这个话题」）。
   - **禁止**写「我们讨论了 X」「和某某聊了 Y」这类对话复述。如果某件事只有讨论、没有具体产出或结论，
     要么把它挂到它产生的产物/决策上，要么直接不写。

3. **禁止 meta 项目。** current_week 不允许出现以「对上一次周报草稿的反思 / 职责边界澄清 / 群聊素材校正 /
   周报口径」为主题的项目。识别信号：title 含「素材校正」「职责边界澄清」「周报口径」，或 intent/objective
   在谈「周报应该如何写 / 草稿如何修正」——直接砍掉。

4. **bullet 文本禁止出现飞书机器 ID。** 不允许 \`chat_id\`、\`message_id\`、\`oc_xxx\`、\`om_xxx\`。
   引用群必须用群名（如「技术基建小组」「claude code 群」），引用消息直接引用原话或关键短语，不带 ID 括号。`;

/**
 * The full first-round drafting contract returned by `begin_weekly_report`. Rebuilt from the v2-era
 * `DRAFTING_PROMPT_TEMPLATE` (removed in v3 when the prompt moved to the host cron) — restored here so
 * the plugin is self-contained and shareable, and rewritten to first person with `DRAFTING_HARD_RULES`
 * as the voice/content authority.
 *
 * `{weekKeyHint}` / `{weekTitleHint}` are substituted by the tool at call time.
 */
export const DRAFTING_CONTRACT = `\
你正在为这段对话的人类主人起草本周周报。这份周报由「我」（主人）写给「我的主管」，所以全程用第一人称。

本周大概率是：weekKey=\`{weekKeyHint}\`，weekTitle=\`{weekTitleHint}\`（如果上下文明确指向另一周，以上下文为准；
weekTitle 格式为 "YYYY.M.D-YYYY.M.D"，周一→周日，月/日不补零）。

步骤：
1. **同一回合内并行调用三个事实源**（互不阻塞，必须一起发起）：
   - \`runtime.subagent.getSessionMessages\`（或等价的本会话转写读取）——本 DM 会话过去 7 天的对话。
   - \`fetch_git_activity\`——本周配置仓库里我的提交。未配置 gitRemotes 时返回空，跳过即可。
   - \`fetch_recent_group_messages\`——本周我在飞书群里的发言/被提及/参与的话题。
2. **把素材按项目（而不是时间线）归并成下面的 JSON schema。** 每个 current_week 项目都要有真实的
   \`intent\`（项目为什么存在）、\`objective\`（这个项目要达成什么）、以及至少一条 \`completed\`（本周实际产出）。
   按「草稿硬规则」把 completed 落在真实的 commit / 提交 / 结论上。如果某个项目的 intent/objective 无法从
   上下文判断，**先问我**，不要编占位文字。
3. **失败透明规则**：如果 \`fetch_git_activity.repos\` 或 \`fetch_recent_group_messages.passes\` 里有任何
   \`ok: false\`，或工具返回了顶层 \`ok: false\`（如 userOpenId 无法解析），在草稿里点明这块数据缺失
   （例如「\`growx\` 的 git 数据本次不可用：<error>」），而不是悄悄丢掉。
4. **调用 \`submit_weekly_report_draft({ weekKey, weekTitle, draftJson })\`** 提交草稿。它会创建 TaskFlow、
   把确认卡片直接投递到我的 DM（通过 lark-cli bot 模式），并返回 \`{flowId, weekKey, weekTitle, ...}\`。
   **不要**再调用 \`feishu_ask_user_question\`，也不要把预览当成纯文本/JSON 回复——卡片已经由该工具发出。
   你这一回合到此结束；我会在 DM 里点「直接写入」或「提交补充」。

${DRAFTING_HARD_RULES}

JSON schema：
{
  "week_title": "YYYY.M.D-YYYY.M.D",
  "current_week": [
    {
      "title": "项目 / 方向名称",
      "intent": "我为什么做这个项目（1-2 句）",
      "objective": "这个项目要达成什么",
      "completed": ["事实 bullet 1", "事实 bullet 2", ...]
    }
  ],
  "next_week": [
    { "project": "项目名", "plan": "下周计划" }
  ]
}

约束：
- "current_week" 和 "next_week" 至少各一条。next_week 实在没有内容时，先问我，不要编。
- 所有字符串去空白后必须非空。
- 输出必须是符合 schema 的合法 JSON，否则工具会拒绝。`;

/** Substitute the week hints into the contract. */
export function buildDraftingContract(params: {
  weekKeyHint: string;
  weekTitleHint: string;
}): string {
  return DRAFTING_CONTRACT.replace("{weekKeyHint}", params.weekKeyHint).replace(
    "{weekTitleHint}",
    params.weekTitleHint,
  );
}
