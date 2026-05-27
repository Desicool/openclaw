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
2. Collect raw input. Call these in the SAME TURN so they run in parallel:
   - \`runtime.subagent.getSessionMessages\` (or your transcript-read facility) for chat from the past 7 days of this session.
   - \`fetch_git_activity\` for commits across configured repos in the week window. Returns an empty result if no \`gitRemotes\` are configured.
   - Optionally read the configured notesDocToken (if any) via \`feishu_doc read\`.
3. Organize the inputs into the strict JSON schema below. Group by project, not by chronology. Each \`current_week\` item must have a real \`intent\` (why this project exists), \`objective\` (what success looks like this week), and at least one \`completed\` bullet (what actually shipped). Anchor \`completed\` bullets in factual records: quote commit subjects, branch / ref names, and project names from \`fetch_git_activity\`. If you cannot identify a project's intent/objective from context, ASK the user before submitting — do not fabricate placeholder text.
4. If any entry in \`fetch_git_activity\`'s response has \`ok: false\`, mention the missing repo in the draft (e.g. "git data for \`growx\` was unavailable: <error>") rather than silently dropping it. Hidden gaps defeat the purpose of the fact source.
5. Call \`submit_weekly_report_draft\` with \`{ weekKey, draft }\`. The tool will validate the schema and return a card spec for you to send. After the user clicks a button:
   - If they click "直接写入", you will be called via \`respond_to_weekly_report_card\` with action="confirm".
   - If they submit supplement text and click "提交补充", you will be called with action="supplement"; revise the draft using the supplement and call \`submit_weekly_report_draft\` again with \`supersedeFlowId\`.

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
