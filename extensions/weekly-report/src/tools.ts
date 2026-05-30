/**
 * Agent-facing tools wiring the weekly-report flow.
 *
 *   begin_weekly_report           : kickoff — returns the first-person drafting contract + week hints
 *   submit_weekly_report_draft    : kickoff or revision (creates/supersedes flow, sends the card)
 *   respond_to_weekly_report_card : handles card-action events (confirm | supplement)
 *   finalize_weekly_report        : finalize success or failure
 *   fetch_git_activity            : fact source — clone-on-demand + `git log` for the week
 *   fetch_recent_group_messages   : fact source — user's messages/mentions/threads across groups
 *
 * The doc write itself is NOT an agent tool: on card confirm the interactive handler writes the doc
 * non-destructively via `doc-writer.writeWeeklySection`. Each tool keeps its own error surface.
 */

import { Type } from "typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { buildConfirmationCard, buildDraftPreview } from "./card.js";
import { findActiveWeeklyReportFlow } from "./dedupe.js";
import { buildDraftingContract } from "./drafting-contract.js";
import { runGitActivity, type RunCommandFn } from "./git-activity.js";
import { runGroupActivity, type GroupMessageReason } from "./group-activity.js";
import { renderReport, type WeeklyReportInput } from "./report-renderer.js";
import type { WeeklyReportPluginSettings } from "./settings.js";
import {
  WEEKLY_REPORT_CARD_ACTIONS,
  WEEKLY_REPORT_STEPS,
  isWeeklyReportFlowState,
  type WeeklyReportCardAction,
  type WeeklyReportFlowState,
} from "./types.js";
import { weekKey as computeWeekKey, weekTitle as computeWeekTitle } from "./week-key.js";

type BoundTaskFlow = ReturnType<
  NonNullable<OpenClawPluginApi["runtime"]>["tasks"]["managedFlows"]["fromToolContext"]
>;

type FlowRecord = ReturnType<BoundTaskFlow["createManaged"]>;

type ToolContent = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type CommonToolDeps = {
  taskFlow: BoundTaskFlow;
  controllerId: string;
};

function buildResponse(details: Record<string, unknown>): ToolContent {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseDraftJson(raw: unknown): WeeklyReportInput {
  if (typeof raw !== "string") {
    throw new Error("draftJson must be a JSON string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`draftJson must be valid JSON: ${(err as Error).message}`);
  }
  // Run through renderer once to validate schema. Throws on bad input.
  renderReport(parsed);
  return parsed as WeeklyReportInput;
}

function requireWeeklyReportState(flow: { stateJson?: unknown }): WeeklyReportFlowState {
  if (!isWeeklyReportFlowState(flow.stateJson)) {
    throw new Error("flow stateJson is not a valid WeeklyReportFlowState");
  }
  return flow.stateJson;
}

// ── begin_weekly_report ────────────────────────────────────────────

export function createBeginWeeklyReportTool(deps: { settings: WeeklyReportPluginSettings }) {
  const { settings } = deps;
  return {
    name: "begin_weekly_report",
    label: "Begin Weekly Report",
    description:
      "Start the weekly-report flow. Returns the plugin-owned first-person drafting contract (voice + content rules + the exact tool sequence) plus this week's weekKey/weekTitle hints. Call this FIRST when nudged to draft the weekly report, then follow the returned `contract` verbatim. This is the single source of drafting guidance — the cron entry only needs to tell you to call this tool.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: Record<string, unknown>): Promise<ToolContent> {
      const now = new Date();
      let weekKeyHint: string;
      let weekTitleHint: string;
      try {
        weekKeyHint = computeWeekKey(now, settings.weekStartsOn);
        weekTitleHint = computeWeekTitle(now, settings.weekStartsOn);
      } catch {
        // weekStartsOn="sunday" is reserved/unsupported in week-key v1; hints fall back to Monday.
        weekKeyHint = computeWeekKey(now);
        weekTitleHint = computeWeekTitle(now);
      }
      const contract = buildDraftingContract({ weekKeyHint, weekTitleHint });
      return buildResponse({ ok: true, weekKeyHint, weekTitleHint, contract });
    },
  };
}

// ── submit_weekly_report_draft ─────────────────────────────────────

export type LarkOfficialCliCardSender = (params: {
  card: Record<string, unknown>;
  toOpenId: string;
}) => Promise<{ ok: true; messageId: string; chatId: string } | { ok: false; error: string }>;

export function createSubmitWeeklyReportDraftTool(
  deps: CommonToolDeps & {
    settings: WeeklyReportPluginSettings;
    cardSender?: LarkOfficialCliCardSender;
  },
) {
  const { taskFlow, controllerId, settings, cardSender } = deps;
  return {
    name: "submit_weekly_report_draft",
    label: "Submit Weekly Report Draft",
    description:
      "Step 1 of the weekly-report flow. Submits a structured draft, creates a managed TaskFlow, AND SENDS THE CONFIRMATION CARD TO THE USER'S DM via lark-cli bot-mode. Returns `{ok, flowId, weekKey, weekTitle, cardDelivered, cardMessageId?, cardError?}`. **Do NOT call `feishu_ask_user_question` afterwards** — the card is already delivered by this tool. Your turn ends after this returns; the user will reply in DM with `confirm <flowId>` or `supplement <flowId>: <text>`. Use `supersedeFlowId` when revising after a 'supplement' answer.",
    parameters: Type.Object({
      weekKey: Type.String({ description: "ISO week key, e.g. 2026-W21" }),
      weekTitle: Type.String({
        description: "Human-readable week range, e.g. 2026.5.18-2026.5.24",
      }),
      draftJson: Type.String({
        description:
          "JSON string conforming to the renderer schema (week_title/current_week/next_week).",
      }),
      supersedeFlowId: Type.Optional(Type.String({})),
      revisionLabel: Type.Optional(Type.String({})),
    }),
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolContent> {
      const weekKey = readRequiredString(params.weekKey, "weekKey");
      const weekTitle = readRequiredString(params.weekTitle, "weekTitle");
      const draft = parseDraftJson(params.draftJson);
      const supersedeFlowId = readOptionalString(params.supersedeFlowId, "supersedeFlowId");
      const revisionLabel = readOptionalString(params.revisionLabel, "revisionLabel");

      const targetDocToken = settings.targetDocToken;
      const recipientSessionKey = settings.recipientSessionKey;
      if (!targetDocToken) {
        throw new Error(
          "weekly-report.targetDocToken is not configured; cannot create a flow without a write target.",
        );
      }
      if (!recipientSessionKey) {
        throw new Error(
          "weekly-report.recipientSessionKey is not configured; cannot deliver the card.",
        );
      }

      let supersedeInfo: { supersedeOf?: string } = {};
      if (supersedeFlowId) {
        const existing = taskFlow.get(supersedeFlowId);
        if (existing) {
          taskFlow.fail({
            flowId: existing.flowId,
            expectedRevision: existing.revision,
            stateJson: {
              ...((existing.stateJson as Record<string, unknown> | null | undefined) ?? {}),
              supersededAt: Date.now(),
            } as never,
          });
          supersedeInfo = { supersedeOf: existing.flowId };
        }
      } else {
        const existing = findActiveWeeklyReportFlow({
          flows: taskFlow.list(),
          controllerId,
          weekKey,
        });
        if (existing) {
          return buildResponse({
            ok: true,
            action: "noop_already_pending",
            existingFlowId: existing.flowId,
            weekKey,
            note: "A weekly-report flow for this week already exists and is awaiting reply. No new card was sent. Tell the user that the prior card is still valid, or trigger again after that flow completes/expires.",
          });
        }
      }

      const initialState: WeeklyReportFlowState = {
        weekKey,
        weekTitle,
        draft,
        recipientSessionKey,
        targetDocToken,
        ...supersedeInfo,
      };
      const flow = taskFlow.createManaged({
        controllerId,
        goal: `Generate weekly report for ${weekTitle} and write it to the configured Feishu doc after user confirmation.`,
        currentStep: WEEKLY_REPORT_STEPS.awaitUserReply,
        stateJson: initialState as never,
      });

      const previewMarkdown = buildDraftPreview(draft);

      const userOpenId = settings.userOpenId;
      let cardResult:
        | { ok: true; messageId: string; chatId: string }
        | { ok: false; error: string }
        | undefined;
      if (cardSender && userOpenId) {
        const card = buildConfirmationCard({
          flowId: flow.flowId,
          weekKey,
          weekTitle,
          draft,
          ...(revisionLabel ? { revisionLabel } : {}),
        });
        cardResult = await cardSender({ card, toOpenId: userOpenId });
      }
      const stateWithCard: WeeklyReportFlowState =
        cardResult && cardResult.ok
          ? { ...initialState, cardMessageId: cardResult.messageId, cardChatId: cardResult.chatId }
          : initialState;

      const setWaitResult = taskFlow.setWaiting({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: WEEKLY_REPORT_STEPS.awaitUserReply,
        stateJson: stateWithCard as never,
        waitJson: {
          kind: "weekly_report_card",
          weekKey,
          recipientSessionKey,
        } as never,
      });

      if (!cardSender || !userOpenId) {
        return buildResponse({
          ok: true,
          action: "waiting_card_delivery_unavailable",
          flowId: flow.flowId,
          revision: flow.revision,
          weekKey,
          weekTitle,
          previewMarkdown,
          waitingMutation: setWaitResult,
          note: !cardSender
            ? "Plugin runtime missing lark-cli runCommand binding; install @larksuite/cli and configure it on the host, then redeploy. No card was sent."
            : "userOpenId not configured; cannot deliver card. Set plugins.entries.weekly-report.userOpenId (or recipientSessionKey ending in :direct:<open_id>) and retry.",
        });
      }
      if (cardResult && !cardResult.ok) {
        return buildResponse({
          ok: false,
          action: "card_send_failed",
          flowId: flow.flowId,
          revision: flow.revision,
          weekKey,
          weekTitle,
          previewMarkdown,
          error: cardResult.error,
          instruction:
            "Card delivery failed. The flow is now in waiting state but no card reached the user. Either retry submit_weekly_report_draft with supersedeFlowId, or escalate to the user via plain DM reply with the preview text.",
        });
      }
      return buildResponse({
        ok: true,
        action: "card_delivered",
        flowId: flow.flowId,
        revision: flow.revision,
        weekKey,
        weekTitle,
        cardMessageId: cardResult && cardResult.ok ? cardResult.messageId : undefined,
        cardChatId: cardResult && cardResult.ok ? cardResult.chatId : undefined,
        previewMarkdown,
        waitingMutation: setWaitResult,
        note: "Card sent to user's DM via lark-cli bot-mode. Your turn ends now. The user's text reply (e.g. `confirm <flowId>` or `supplement <flowId>: <text>`) will arrive as a new DM message; when it does, call `respond_to_weekly_report_card` with the parsed action.",
      });
    },
  };
}

// ── respond_to_weekly_report_card ──────────────────────────────────

export function createRespondToWeeklyReportCardTool(deps: CommonToolDeps) {
  const { taskFlow, controllerId } = deps;
  return {
    name: "respond_to_weekly_report_card",
    label: "Respond to Weekly Report Card",
    description:
      "Call after the user submits the feishu_ask_user_question card created by submit_weekly_report_draft. Validates trust and either transitions to writing_doc (action='confirm', returns splice instructions) or to revising (action='supplement', returns the originalDraft + supplement for re-drafting).",
    parameters: Type.Object({
      flowId: Type.String({ description: "Flow id returned by submit_weekly_report_draft." }),
      weekKey: Type.String({ description: "Week key returned alongside the flowId." }),
      action: Type.String({
        description:
          "Either 'confirm' (user wants the current draft written as-is) or 'supplement' (user added text to be merged into a revised draft).",
      }),
      supplement: Type.Optional(
        Type.String({
          description: "Supplement text supplied by the user when action='supplement'.",
        }),
      ),
      sessionKey: Type.String({
        description: "Bound session key (your current ctx.sessionKey) for trust check.",
      }),
    }),
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolContent> {
      const flowId = readRequiredString(params.flowId, "flowId");
      const weekKey = readRequiredString(params.weekKey, "weekKey");
      const actionRaw = readRequiredString(params.action, "action");
      const sessionKey = readRequiredString(params.sessionKey, "sessionKey");
      if (!WEEKLY_REPORT_CARD_ACTIONS.includes(actionRaw as WeeklyReportCardAction)) {
        return buildResponse({
          ok: false,
          action: "invalid",
          reason: "unknown_action",
          userMessage: `Unknown action "${actionRaw}". Expected one of: ${WEEKLY_REPORT_CARD_ACTIONS.join(", ")}.`,
        });
      }
      const action = actionRaw as WeeklyReportCardAction;
      const supplementText =
        action === "supplement" ? readOptionalString(params.supplement, "supplement") : undefined;
      if (action === "supplement" && !supplementText) {
        return buildResponse({
          ok: false,
          action: "invalid",
          reason: "supplement_required",
          userMessage:
            "User picked supplement but did not provide text. Ask them again with feishu_ask_user_question.",
        });
      }
      const args = { flowId, weekKey, action, supplement: supplementText };
      const trustResult = validateTrust({
        taskFlow,
        controllerId,
        bindings: { sessionKey, weekKey: args.weekKey, flowId: args.flowId },
      });
      if (!trustResult.ok) {
        return buildResponse({
          ok: false,
          action: "invalid",
          reason: trustResult.reason,
          userMessage: "This weekly-report card is no longer valid.",
        });
      }

      const flow = trustResult.flow;
      const state = requireWeeklyReportState(flow);

      if (args.action === "confirm") {
        const writingState: WeeklyReportFlowState = {
          ...state,
          writeStartedAt: Date.now(),
        };
        const transition = taskFlow.resume({
          flowId: flow.flowId,
          expectedRevision: flow.revision,
          status: "running",
          currentStep: WEEKLY_REPORT_STEPS.writingDoc,
          stateJson: writingState as never,
        });
        if (!transition.applied) {
          return buildResponse({
            ok: false,
            action: "invalid",
            reason: `transition_failed:${transition.code}`,
            userMessage: "Could not transition the weekly-report flow; please try again.",
          });
        }
        return buildResponse({
          ok: true,
          action: "ready_to_write",
          flowId: flow.flowId,
          revision: transition.flow.revision,
          weekKey: state.weekKey,
          weekTitle: state.weekTitle,
          note:
            "The plugin writes the doc itself when the user taps 「直接写入」 on the confirmation card — " +
            "the interactive handler inserts this week's section at the TOP of the doc non-destructively " +
            "(prior weeks, images, comments preserved) and finalizes the flow. Do NOT call any " +
            "feishu_fetch_doc / feishu_update_doc tools. If the user confirmed by plain text instead of " +
            "the card button, ask them to tap 「直接写入」 on the card so the write is triggered.",
        });
      }

      // supplement
      const revisingState: WeeklyReportFlowState = {
        ...state,
        supplementSubmittedAt: Date.now(),
      };
      const transition = taskFlow.resume({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        status: "running",
        currentStep: WEEKLY_REPORT_STEPS.revising,
        stateJson: revisingState as never,
      });
      if (!transition.applied) {
        return buildResponse({
          ok: false,
          action: "invalid",
          reason: `transition_failed:${transition.code}`,
          userMessage: "Could not transition the weekly-report flow; please try again.",
        });
      }
      return buildResponse({
        ok: true,
        action: "re_draft",
        flowId: flow.flowId,
        revision: transition.flow.revision,
        weekKey: state.weekKey,
        weekTitle: state.weekTitle,
        originalDraft: state.draft,
        supplement: supplementText,
        instructions: [
          "Merge the supplement into the original draft (likely as a new current_week item or additional bullet on an existing item). Use your judgment about grouping.",
          `Call \`submit_weekly_report_draft\` again with the revised draft, \`supersedeFlowId: "${flow.flowId}"\`, and a \`revisionLabel\` like 'Revision 2' to make the new card distinguishable.`,
          "The follow-up will return new instructions to call `feishu_ask_user_question` again with the revised preview.",
        ].join("\n"),
      });
    },
  };
}

export function validateCardActionTrust(params: {
  taskFlow: BoundTaskFlow;
  controllerId: string;
  bindings: { sessionKey: string; weekKey: string; flowId: string };
}): { ok: true; flow: FlowRecord } | { ok: false; reason: string } {
  return validateTrust(params);
}

function validateTrust(params: {
  taskFlow: BoundTaskFlow;
  controllerId: string;
  bindings: { sessionKey: string; weekKey: string; flowId: string };
}): { ok: true; flow: FlowRecord } | { ok: false; reason: string } {
  const { taskFlow, controllerId, bindings } = params;
  const flow = taskFlow.get(bindings.flowId);
  if (!flow) {
    return { ok: false, reason: "flow_not_found" };
  }
  if (flow.controllerId !== controllerId) {
    return { ok: false, reason: "wrong_controller" };
  }
  if (taskFlow.sessionKey !== bindings.sessionKey) {
    return { ok: false, reason: "session_mismatch" };
  }
  if (flow.status !== "waiting") {
    return { ok: false, reason: `not_waiting:${flow.status}` };
  }
  if (!isWeeklyReportFlowState(flow.stateJson)) {
    return { ok: false, reason: "state_invalid" };
  }
  if (flow.stateJson.weekKey !== bindings.weekKey) {
    return { ok: false, reason: "week_mismatch" };
  }
  return { ok: true, flow: flow as FlowRecord };
}

// ── finalize_weekly_report ─────────────────────────────────────────

export function createFinalizeWeeklyReportTool(deps: CommonToolDeps) {
  const { taskFlow, controllerId } = deps;
  return {
    name: "finalize_weekly_report",
    label: "Finalize Weekly Report",
    description:
      "Mark the weekly-report flow as completed (success=true) or failed (success=false, error). Call after the `feishu_update_doc` step.",
    parameters: Type.Object({
      flowId: Type.String({}),
      success: Type.Boolean({}),
      error: Type.Optional(Type.String({})),
    }),
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolContent> {
      const flowId = readRequiredString(params.flowId, "flowId");
      const success = params.success === true;
      const errorText = readOptionalString(params.error, "error");

      const flow = taskFlow.get(flowId);
      if (!flow) {
        throw new Error(`flow not found: ${flowId}`);
      }
      if (flow.controllerId !== controllerId) {
        throw new Error(`flow ${flowId} is not a weekly-report flow`);
      }
      const state = requireWeeklyReportState(flow);

      if (success) {
        const finalState: WeeklyReportFlowState = {
          ...state,
          writtenAt: Date.now(),
        };
        const mutation = taskFlow.finish({
          flowId: flow.flowId,
          expectedRevision: flow.revision,
          stateJson: finalState as never,
        });
        return buildResponse({
          ok: true,
          action: "finished",
          flowId,
          mutation,
        });
      }

      const failureMessage = errorText ?? "doc-write-failed";
      const failureState: WeeklyReportFlowState = {
        ...state,
        lastError: failureMessage,
      };
      const mutation = taskFlow.fail({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson: failureState as never,
      });
      return buildResponse({
        ok: false,
        action: "failed",
        flowId,
        lastError: failureMessage,
        mutation,
      });
    },
  };
}

// ── fetch_git_activity ─────────────────────────────────────────────

export type FetchGitActivityDeps = {
  settings: WeeklyReportPluginSettings;
  runCommand: RunCommandFn;
  resolveStateDir: () => string;
};

export function createFetchGitActivityTool(deps: FetchGitActivityDeps) {
  const { settings, runCommand, resolveStateDir } = deps;
  return {
    name: "fetch_git_activity",
    label: "Fetch Weekly Git Activity",
    description:
      "Return commits across configured git remotes for a time window, filtered by the configured author. Use this alongside `runtime.subagent.getSessionMessages` when drafting the weekly report so `completed` bullets cite real commits. Returns an empty result if no gitRemotes are configured.",
    parameters: Type.Object({
      sinceTs: Type.Optional(
        Type.Number({
          description: "Unix ms. Default: Monday 00:00 UTC of the current ISO week.",
        }),
      ),
      untilTs: Type.Optional(
        Type.Number({
          description: "Unix ms. Default: now.",
        }),
      ),
      repoFilter: Type.Optional(
        Type.String({
          description: "Comma-separated list of configured repo `name`s to include. Default: all.",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolContent> {
      const sinceTs =
        typeof params.sinceTs === "number" && Number.isFinite(params.sinceTs)
          ? params.sinceTs
          : undefined;
      const untilTs =
        typeof params.untilTs === "number" && Number.isFinite(params.untilTs)
          ? params.untilTs
          : undefined;
      const repoFilter =
        typeof params.repoFilter === "string" && params.repoFilter.trim().length > 0
          ? params.repoFilter
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : undefined;

      try {
        const result = await runGitActivity({
          settings,
          runCommand,
          resolveStateDir,
          ...(sinceTs !== undefined ? { sinceTs } : {}),
          ...(untilTs !== undefined ? { untilTs } : {}),
          ...(repoFilter ? { repoFilter } : {}),
        });
        const failures = result.repos.filter((repo) => !repo.ok);
        return buildResponse({
          ok: true,
          windowStart: result.windowStart,
          windowEnd: result.windowEnd,
          repos: result.repos,
          partial: failures.length > 0,
          partialNote:
            failures.length > 0
              ? "One or more repos returned ok=false. Mention them in the draft rather than hiding the gap."
              : undefined,
        });
      } catch (err) {
        return buildResponse({
          ok: false,
          action: "git_activity_failed",
          reason: (err as Error).message,
          instruction:
            "Continue drafting using chat history only. Mention in the draft that git activity wasn't available because: " +
            (err as Error).message,
        });
      }
    },
  };
}

// ── fetch_recent_group_messages ────────────────────────────────────

export type FetchRecentGroupMessagesDeps = {
  settings: WeeklyReportPluginSettings;
  runCommand: RunCommandFn;
};

const KNOWN_REASONS: GroupMessageReason[] = ["author", "mention"];

export function createFetchRecentGroupMessagesTool(deps: FetchRecentGroupMessagesDeps) {
  const { settings, runCommand } = deps;
  return {
    name: "fetch_recent_group_messages",
    label: "Fetch Recent Group Messages",
    description:
      "v4 fact source. Searches Feishu group messages via lark-cli for messages you authored or were mentioned in during the configured window. Returns {windowStart, windowEnd, userOpenId, accountId, passes: [{kind, ok, messages|error, truncated?}], groupedByChat: {chatId: messages[]}}. Call this alongside `getSessionMessages` (DM) and `fetch_git_activity` (commits) during drafting. If any `passes[].ok: false`, any `passes[].truncated: true`, or top-level `ok: false` is set, mention the gap in the draft rather than hiding it. Requires lark-cli installed on the host and `larkCliAccountId` configured.",
    parameters: Type.Object({
      sinceTs: Type.Optional(
        Type.Number({
          description:
            "Unix ms. Default: Monday 00:00 UTC of the current ISO week (or Sunday if weekStartsOn=sunday).",
        }),
      ),
      untilTs: Type.Optional(Type.Number({ description: "Unix ms. Default: now." })),
      includeReasons: Type.Optional(
        Type.String({
          description: "Comma-separated subset of `author,mention`. Default: both.",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolContent> {
      const sinceTs =
        typeof params.sinceTs === "number" && Number.isFinite(params.sinceTs)
          ? params.sinceTs
          : undefined;
      const untilTs =
        typeof params.untilTs === "number" && Number.isFinite(params.untilTs)
          ? params.untilTs
          : undefined;

      let includeReasons: GroupMessageReason[] | undefined;
      if (typeof params.includeReasons === "string" && params.includeReasons.trim().length > 0) {
        const requested = params.includeReasons
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0);
        const invalid = requested.filter(
          (entry) => !KNOWN_REASONS.includes(entry as GroupMessageReason),
        );
        if (invalid.length > 0) {
          return buildResponse({
            ok: false,
            action: "invalid",
            reason: "unknown_include_reasons",
            invalid,
            userMessage: `Unknown includeReasons: ${invalid.join(", ")}. Expected subset of ${KNOWN_REASONS.join(", ")}.`,
          });
        }
        includeReasons = requested as GroupMessageReason[];
      }

      const result = await runGroupActivity({
        settings,
        runCommand,
        ...(sinceTs !== undefined ? { sinceTs } : {}),
        ...(untilTs !== undefined ? { untilTs } : {}),
        ...(includeReasons ? { includeReasons } : {}),
      });
      const passFailures = result.passes.filter((p) => !p.ok);
      const truncatedPasses = result.passes.filter((p) => p.ok && p.truncated);
      return buildResponse({
        ok: result.ok !== false,
        ...(result.ok === false && result.error ? { error: result.error } : {}),
        windowStart: result.windowStart,
        windowEnd: result.windowEnd,
        userOpenId: result.userOpenId,
        accountId: result.accountId,
        passes: result.passes,
        groupedByChat: result.groupedByChat,
        partial: passFailures.length > 0 || truncatedPasses.length > 0,
        partialNote:
          passFailures.length > 0 || truncatedPasses.length > 0
            ? "One or more passes returned ok=false or truncated=true. Mention the gap in the draft rather than hiding it."
            : undefined,
      });
    },
  };
}

// Re-export the action enum so callers can validate independently.
export { WEEKLY_REPORT_CARD_ACTIONS };
