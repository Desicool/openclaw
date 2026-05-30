import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "./runtime-api.js";
import { sendInteractiveCard } from "./src/card-sender.js";
import { createWeeklyReportInteractiveHandler } from "./src/interactive-handler.js";
import {
  parseWeeklyReportPluginConfig,
  weeklyReportConfigSchema,
  type WeeklyReportPluginSettings,
} from "./src/settings.js";
import { startTimeoutSweeper } from "./src/timeout-sweeper.js";
import {
  createBeginWeeklyReportTool,
  createFetchGitActivityTool,
  createFetchRecentGroupMessagesTool,
  createFinalizeWeeklyReportTool,
  createRespondToWeeklyReportCardTool,
  createSubmitWeeklyReportDraftTool,
} from "./src/tools.js";
import { isWeeklyReportSupplementSession } from "./src/types.js";

const WEEKLY_REPORT_CONTROLLER_ID = "weekly-report";

type ToolBuilder = (params: {
  taskFlow: NonNullable<
    ReturnType<
      NonNullable<OpenClawPluginApi["runtime"]>["tasks"]["managedFlows"]["fromToolContext"]
    >
  >;
}) => AnyAgentTool;

/**
 * Bind all weekly-report tool factories to `recipientSessionKey` (the user's DM session) rather
 * than the calling agent's `ctx.sessionKey`. The cron-fired draft runs in an isolated runner
 * session whose sessionKey shifts every run (`agent:<id>:cron:<jobId>:run:<startedAt>`), but the
 * card click event from the lark plugin's interactive dispatcher arrives outside any agent
 * session. To make `submit_weekly_report_draft` (create) + `respond_to_weekly_report_card`
 * (transition) + the interactive handler's trust check all see the same `ownerKey`, every
 * weekly-report tool binds to the stable `recipientSessionKey` from config.
 *
 * Fallback to `ctx.sessionKey` when `recipientSessionKey` isn't configured (early-deploy and
 * test environments) — keeps the tool registrable but means the legacy "tool runs in user DM
 * directly" path keeps working.
 */
function withBoundFlow(
  api: OpenClawPluginApi,
  settings: WeeklyReportPluginSettings,
  build: ToolBuilder,
  opts?: { unavailableWhen?: (ctx: OpenClawPluginToolContext) => boolean },
): OpenClawPluginToolFactory {
  return ((ctx: OpenClawPluginToolContext) => {
    if (ctx.sandboxed) {
      return null;
    }
    // Hard-gate: don't even register the tool for contexts where calling it is always wrong (e.g.
    // the re-draft sub-session must NOT call respond_to_weekly_report_card). Enforcement by absence
    // beats a prompt-level "please don't" — the model can't pick a tool it can't see.
    if (opts?.unavailableWhen?.(ctx)) {
      return null;
    }
    const managedFlows = api.runtime?.tasks?.managedFlows;
    if (!managedFlows) {
      return null;
    }
    const boundSessionKey = settings.recipientSessionKey ?? ctx.sessionKey;
    if (!boundSessionKey) {
      return null;
    }
    const taskFlow = managedFlows.bindSession({ sessionKey: boundSessionKey });
    return build({ taskFlow });
  }) as OpenClawPluginToolFactory;
}

export default definePluginEntry({
  id: "weekly-report",
  name: "Weekly Report",
  description: "Cron-triggered weekly report flow with Feishu card confirmation and doc write.",
  configSchema: weeklyReportConfigSchema,
  register(api) {
    const settings = parseWeeklyReportPluginConfig(api.pluginConfig);

    api.registerTool(
      withBoundFlow(api, settings, ({ taskFlow }) => {
        const runtime = api.runtime;
        const cardSender = runtime?.system
          ? async (params: { card: Record<string, unknown>; toOpenId: string }) =>
              sendInteractiveCard({
                runCommand: runtime.system.runCommandWithTimeout,
                binPath: settings.larkOfficialCliBinPath,
                toOpenId: params.toOpenId,
                card: params.card,
                timeoutMs: settings.larkOfficialCliTimeoutMs,
              })
          : undefined;
        return createSubmitWeeklyReportDraftTool({
          taskFlow,
          controllerId: WEEKLY_REPORT_CONTROLLER_ID,
          settings,
          ...(cardSender ? { cardSender } : {}),
        }) as AnyAgentTool;
      }),
    );

    api.registerTool(
      withBoundFlow(
        api,
        settings,
        ({ taskFlow }) =>
          createRespondToWeeklyReportCardTool({
            taskFlow,
            controllerId: WEEKLY_REPORT_CONTROLLER_ID,
          }) as AnyAgentTool,
        {
          // The re-draft sub-session must submit via submit_weekly_report_draft, never this tool —
          // so it isn't exposed there at all (the prior revision failed because the model called it).
          unavailableWhen: (ctx) => isWeeklyReportSupplementSession(ctx.sessionKey),
        },
      ),
    );

    api.registerTool(((ctx: OpenClawPluginToolContext) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createBeginWeeklyReportTool({ settings }) as AnyAgentTool;
    }) as OpenClawPluginToolFactory);

    api.registerTool(
      withBoundFlow(
        api,
        settings,
        ({ taskFlow }) =>
          createFinalizeWeeklyReportTool({
            taskFlow,
            controllerId: WEEKLY_REPORT_CONTROLLER_ID,
          }) as AnyAgentTool,
      ),
    );

    api.registerTool(((ctx: OpenClawPluginToolContext) => {
      if (ctx.sandboxed) {
        return null;
      }
      const runtime = api.runtime;
      if (!runtime?.system?.runCommandWithTimeout || !runtime?.state?.resolveStateDir) {
        return null;
      }
      return createFetchGitActivityTool({
        settings,
        runCommand: runtime.system.runCommandWithTimeout,
        resolveStateDir: () => runtime.state.resolveStateDir(),
      }) as AnyAgentTool;
    }) as OpenClawPluginToolFactory);

    api.registerTool(((ctx: OpenClawPluginToolContext) => {
      if (ctx.sandboxed) {
        return null;
      }
      const runtime = api.runtime;
      if (!runtime?.system?.runCommandWithTimeout) {
        return null;
      }
      return createFetchRecentGroupMessagesTool({
        settings,
        runCommand: runtime.system.runCommandWithTimeout,
      }) as AnyAgentTool;
    }) as OpenClawPluginToolFactory);

    if (
      api.runtime?.tasks?.managedFlows &&
      api.runtime?.system?.runCommandWithTimeout &&
      settings.recipientSessionKey
    ) {
      const boundTaskFlowForHandler = api.runtime.tasks.managedFlows.bindSession({
        sessionKey: settings.recipientSessionKey,
      });
      const handlerRunCommand = api.runtime.system.runCommandWithTimeout;
      const subagentApi = api.runtime?.subagent;
      api.registerInteractiveHandler({
        channel: "feishu",
        namespace: "weekly-report",
        handler: createWeeklyReportInteractiveHandler({
          taskFlow: boundTaskFlowForHandler,
          controllerId: WEEKLY_REPORT_CONTROLLER_ID,
          settings,
          runCommand: handlerRunCommand,
          ...(subagentApi ? { subagentRun: (params) => subagentApi.run(params) } : {}),
        }),
      } as never);
    }

    if (api.runtime?.tasks?.managedFlows) {
      const stop = startTimeoutSweeper({
        runtime: api.runtime,
        controllerId: WEEKLY_REPORT_CONTROLLER_ID,
        settings,
        logger: api.logger,
      });
      api.registerService({
        id: "weekly-report-sweeper",
        start: () => {},
        stop: async () => {
          stop();
        },
      });
    }
  },
});
