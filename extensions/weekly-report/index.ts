import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "./runtime-api.js";
import { parseWeeklyReportPluginConfig, weeklyReportConfigSchema } from "./src/settings.js";
import { startTimeoutSweeper } from "./src/timeout-sweeper.js";
import {
  createFetchGitActivityTool,
  createFinalizeWeeklyReportTool,
  createRespondToWeeklyReportCardTool,
  createSpliceWeeklyReportDocTool,
  createSubmitWeeklyReportDraftTool,
} from "./src/tools.js";

const WEEKLY_REPORT_CONTROLLER_ID = "weekly-report";

type ToolBuilder = (params: {
  taskFlow: NonNullable<
    ReturnType<
      NonNullable<OpenClawPluginApi["runtime"]>["tasks"]["managedFlows"]["fromToolContext"]
    >
  >;
}) => AnyAgentTool;

function withBoundFlow(api: OpenClawPluginApi, build: ToolBuilder): OpenClawPluginToolFactory {
  return ((ctx: OpenClawPluginToolContext) => {
    if (ctx.sandboxed) {
      return null;
    }
    if (!api.runtime?.tasks?.managedFlows || !ctx.sessionKey) {
      return null;
    }
    const taskFlow = api.runtime.tasks.managedFlows.fromToolContext(ctx);
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
      withBoundFlow(
        api,
        ({ taskFlow }) =>
          createSubmitWeeklyReportDraftTool({
            taskFlow,
            controllerId: WEEKLY_REPORT_CONTROLLER_ID,
            settings,
          }) as AnyAgentTool,
      ),
    );

    api.registerTool(
      withBoundFlow(
        api,
        ({ taskFlow }) =>
          createRespondToWeeklyReportCardTool({
            taskFlow,
            controllerId: WEEKLY_REPORT_CONTROLLER_ID,
          }) as AnyAgentTool,
      ),
    );

    api.registerTool(
      withBoundFlow(
        api,
        ({ taskFlow }) =>
          createSpliceWeeklyReportDocTool({
            taskFlow,
            controllerId: WEEKLY_REPORT_CONTROLLER_ID,
          }) as AnyAgentTool,
      ),
    );

    api.registerTool(
      withBoundFlow(
        api,
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
