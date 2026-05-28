/**
 * Drafting prompt + schema contract for the agent-as-collector pattern.
 *
 * The agent receives this contract via tool descriptions and the cron prompt. It must:
 *  1. Call `runtime.subagent.getSessionMessages` to retrieve transcript beyond the active window
 *     (and filter by the weekKey's boundary timestamps).
 *  2. Optionally consult the configured `notesDocToken` via `feishu_doc read`.
 *  3. Produce a JSON object conforming to the schema below.
 *  4. Call `submit_weekly_report_draft({weekKey, draft})`.
 *
 * The schema is what the renderer enforces (`report-renderer.ts`). Keeping the prompt and the
 * schema in one file means future schema changes never drift from agent guidance.
 */

export const DRAFTING_PROMPT_TEMPLATE = `\
You are drafting a weekly report for the human owner of this conversation.

Steps:
1. Determine the target ISO week from context (typically the current week unless explicitly told otherwise). Compute weekKey ("YYYY-Www") and weekTitle ("YYYY.M.D-YYYY.M.D", Monday→Sunday, NOT zero-padded).
2. Collect raw input. Call these THREE tools in the SAME TURN so they run in parallel — none blocks the others:
   - \`runtime.subagent.getSessionMessages\` (or your transcript-read facility) for chat from the past 7 days of THIS DM session.
   - \`fetch_git_activity\` for commits across configured repos in the week window. Returns an empty result if no \`gitRemotes\` are configured.
   - \`fetch_recent_group_messages\` for the user's contributions in Feishu group chats — own messages, mentions, and threads they participated in. Returns a single ok:false entry if userOpenId isn't resolvable; otherwise per-group structured records.
   - Optionally read the configured notesDocToken (if any) via \`feishu_doc read\`.
3. Organize the inputs into the strict JSON schema below. Group by project, not by chronology. Each \`current_week\` item must have a real \`intent\` (why this project exists), \`objective\` (what success looks like this week), and at least one \`completed\` bullet (what actually shipped). Anchor \`completed\` bullets in factual records: quote commit subjects + branch/ref names from \`fetch_git_activity\`, and quote substantive statements the user made in groups from \`fetch_recent_group_messages\`. If you cannot identify a project's intent/objective from context, ASK the user before submitting — do not fabricate placeholder text.
4. **Failure transparency rule (applies to all three data sources)**: if any entry in \`fetch_git_activity.repos\` OR \`fetch_recent_group_messages.groups\` has \`ok: false\`, OR if either tool returned a top-level \`ok: false\` (e.g. userOpenId unresolved), mention the missing data in the draft (e.g. "git data for \`growx\` was unavailable: <error>" / "group \`oc_team\` data unavailable: <error>") rather than silently dropping it. Hidden gaps defeat the purpose of the fact sources.
5. Call \`submit_weekly_report_draft\` with \`{ weekKey, weekTitle, draftJson }\`. It will create a TaskFlow, return \`{flowId, previewMarkdown, questionHeader, confirmLabel, supplementLabel, instructions}\`, and tell you to deliver the card via \`feishu_ask_user_question\` — NEVER reply with the preview as plain text or JSON, that will not render as an interactive card.
6. Call \`feishu_ask_user_question\` with one question entry: \`{ header: questionHeader, question: previewMarkdown, options: [confirmLabel, supplementLabel] }\`. That tool sends the actual Feishu card and returns immediately; the user's answer will arrive as a NEW message in this conversation.
7. When the user's answer arrives:
   - If they picked the confirm label → call \`respond_to_weekly_report_card({ flowId, weekKey, sessionKey, action: "confirm" })\`. The tool returns splice instructions; follow them (feishu_doc read → splice_weekly_report_doc → feishu_doc write → finalize_weekly_report).
   - If they picked the supplement label OR added free-text → call \`respond_to_weekly_report_card({ flowId, weekKey, sessionKey, action: "supplement", supplement: <their text> })\`. The tool returns the originalDraft + supplement; merge them yourself and call \`submit_weekly_report_draft\` again with \`supersedeFlowId\` set to the returned flowId.

JSON schema:
{
  "week_title": "YYYY.M.D-YYYY.M.D",
  "current_week": [
    {
      "title": "Project / initiative name",
      "intent": "Why this project exists in 1-2 sentences",
      "objective": "What success looks like this week",
      "completed": ["bullet 1", "bullet 2", ...]
    }
  ],
  "next_week": [
    { "project": "Project name", "plan": "Plan for next week" }
  ]
}

Constraints:
- "current_week" and "next_week" must each have at least one entry. If you genuinely have nothing for next_week, ASK the user before submitting.
- All strings must be non-empty after trimming.
- Output MUST be valid JSON conforming to the schema; the tool rejects anything else.`;

export function resolveDraftingPrompt(override: string | undefined): string {
  return override && override.trim().length > 0 ? override : DRAFTING_PROMPT_TEMPLATE;
}
