/**
 * Five agent-facing tools wiring the weekly-report flow.
 *
 *   submit_weekly_report_draft    : kickoff or revision (creates/supersedes flow, returns card spec)
 *   respond_to_weekly_report_card : handles synthetic card-action events (confirm | supplement)
 *   splice_weekly_report_doc      : pure server-side splice on a doc body the agent fetched
 *   finalize_weekly_report        : finalize success or failure after the agent writes the doc
 *   fetch_git_activity            : v2 fact source — clone-on-demand + `git log` for the week
 *
 * Each tool keeps its own error surface so failures are localized.
 */

import { Type } from "typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { parseCardActionInput, type RespondToCardArgs } from "./card-action-handler.js";
import { buildConfirmationCard, type WeeklyReportCard } from "./card.js";
import { findActiveWeeklyReportFlow } from "./dedupe.js";
import { buildSentinelEnd, buildSentinelStart, spliceWeeklySection } from "./doc-splicer.js";
import { runGitActivity, type RunCommandFn } from "./git-activity.js";
import { renderReport, type WeeklyReportInput } from "./report-renderer.js";
import type { WeeklyReportPluginSettings } from "./settings.js";
import {
  WEEKLY_REPORT_CARD_ACTIONS,
  WEEKLY_REPORT_STEPS,
  isWeeklyReportFlowState,
  type WeeklyReportFlowState,
} from "./types.js";

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

// ── submit_weekly_report_draft ─────────────────────────────────────

export function createSubmitWeeklyReportDraftTool(
  deps: CommonToolDeps & { settings: WeeklyReportPluginSettings },
) {
  const { taskFlow, controllerId, settings } = deps;
  return {
    name: "submit_weekly_report_draft",
    label: "Submit Weekly Report Draft",
    description:
      "Submit a structured weekly-report draft. Creates a managed TaskFlow, builds a Feishu confirmation card, and stores `waiting` state. Use `supersedeFlowId` when revising after a 'supplement' card click. Returns the card JSON to send to the user.",
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

      const card: WeeklyReportCard = buildConfirmationCard({
        flowId: flow.flowId,
        weekKey,
        weekTitle,
        draft,
        ...(revisionLabel ? { revisionLabel } : {}),
      });

      const setWaitResult = taskFlow.setWaiting({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: WEEKLY_REPORT_STEPS.awaitUserReply,
        stateJson: initialState as never,
        waitJson: {
          kind: "weekly_report_card",
          weekKey,
          recipientSessionKey,
        } as never,
      });

      return buildResponse({
        ok: true,
        action: "card_ready",
        flowId: flow.flowId,
        revision: flow.revision,
        weekKey,
        weekTitle,
        recipientSessionKey,
        card,
        waitingMutation: setWaitResult,
        instructions:
          "Send the `card` JSON to `recipientSessionKey` via the appropriate Feishu card delivery mechanism. Then wait for the user's card-action event.",
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
      "Handle a synthetic card-action event from the Feishu plugin. Validates trust and routes to confirm (transition to writing_doc, return splice instructions) or supplement (transition to revising, return draft + supplement for re-drafting).",
    parameters: Type.Object({
      metadataJson: Type.String({
        description:
          "JSON string of the card-action envelope `.m` metadata (the {type, flowId, weekKey, action} payload).",
      }),
      supplement: Type.Optional(
        Type.String({
          description: "Supplement text supplied by the user when action='supplement'.",
        }),
      ),
      sessionKey: Type.String({
        description: "Bound session key of the inbound card-action event (for trust check).",
      }),
    }),
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolContent> {
      const metadataRaw = readRequiredString(params.metadataJson, "metadataJson");
      let metadata: unknown;
      try {
        metadata = JSON.parse(metadataRaw);
      } catch (err) {
        throw new Error(`metadataJson must be valid JSON: ${(err as Error).message}`);
      }

      const sessionKey = readRequiredString(params.sessionKey, "sessionKey");
      const parse = parseCardActionInput({
        metadata,
        supplement: params.supplement,
      });
      if (!parse.ok) {
        return buildResponse({
          ok: false,
          action: "invalid",
          reason: parse.reason,
          userMessage:
            parse.reason === "wrong_action_supplement_required"
              ? "Supplement card was clicked but no supplement text was provided. Please type a supplement and resubmit."
              : "This weekly-report card is no longer valid.",
        });
      }

      const args: RespondToCardArgs = parse.args;
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
          targetDocToken: state.targetDocToken,
          sentinelStart: buildSentinelStart(state.weekKey),
          sentinelEnd: buildSentinelEnd(state.weekKey),
          instructions: [
            "Call `feishu_doc` with action=read on targetDocToken to obtain the current doc body.",
            "Call `splice_weekly_report_doc` with the read body and this flowId to obtain the spliced body.",
            "Call `feishu_doc` with action=write on targetDocToken with the spliced body.",
            "Call `finalize_weekly_report` with `{ flowId, success: true }` when the write succeeds, or `{ flowId, success: false, error: '...' }` if it fails.",
          ].join("\n"),
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
        supplement: args.supplement!,
        instructions: [
          "Merge the supplement into the original draft (likely as a new current_week item or additional bullet on an existing item). Use your judgment about grouping.",
          "Call `submit_weekly_report_draft` again with the revised draft and `supersedeFlowId` set to this flowId.",
          "Use a `revisionLabel` like 'Revision 2' to make the new card distinguishable.",
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

// ── splice_weekly_report_doc ───────────────────────────────────────

export function createSpliceWeeklyReportDocTool(deps: CommonToolDeps) {
  const { taskFlow, controllerId } = deps;
  return {
    name: "splice_weekly_report_doc",
    label: "Splice Weekly Report Doc",
    description:
      "Pure server-side splice: given the current weekly-report doc body, return the body with this flow's section replaced (or prepended). Call between `feishu_doc read` and `feishu_doc write`.",
    parameters: Type.Object({
      flowId: Type.String({}),
      currentDocBody: Type.String({
        description: "The complete current body of the weekly-report doc (from `feishu_doc read`).",
      }),
    }),
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolContent> {
      const flowId = readRequiredString(params.flowId, "flowId");
      const currentDocBody = typeof params.currentDocBody === "string" ? params.currentDocBody : "";

      const flow = taskFlow.get(flowId);
      if (!flow) {
        throw new Error(`flow not found: ${flowId}`);
      }
      if (flow.controllerId !== controllerId) {
        throw new Error(`flow ${flowId} is not a weekly-report flow`);
      }
      const state = requireWeeklyReportState(flow);

      const sectionBody = renderReport(state.draft);
      const splicedBody = spliceWeeklySection({
        existingDoc: currentDocBody,
        weekKey: state.weekKey,
        newSectionBody: sectionBody.trimEnd(),
      });

      return buildResponse({
        ok: true,
        flowId,
        weekKey: state.weekKey,
        sectionPreviewLength: sectionBody.length,
        splicedBody,
      });
    },
  };
}

// ── finalize_weekly_report ─────────────────────────────────────────

export function createFinalizeWeeklyReportTool(deps: CommonToolDeps) {
  const { taskFlow, controllerId } = deps;
  return {
    name: "finalize_weekly_report",
    label: "Finalize Weekly Report",
    description:
      "Mark the weekly-report flow as completed (success=true) or failed (success=false, error). Call after the `feishu_doc write` step.",
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

// Re-export the action enum so callers can validate independently.
export { WEEKLY_REPORT_CARD_ACTIONS };
