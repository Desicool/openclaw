import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { DEFAULT_SESSION_LIST_QUERY } from "../../lib/sessions/index.ts";
import { resolveSessionNavigationAgentId } from "../../lib/sessions/route-navigation.ts";
import { resolveUiConfiguredMainKey } from "../../lib/sessions/session-key.ts";
import type { DashboardsRouteData } from "./view.ts";

function waitForSupersedingNavigation(signal: AbortSignal): Promise<never> {
  const abortError = () =>
    signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Dashboard route load superseded", "AbortError");
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

async function loadDashboardsRoute(
  context: ApplicationContext,
  signal: AbortSignal,
): Promise<DashboardsRouteData> {
  const gateway = context.gateway;
  const client = gateway.snapshot.phase === "connected" ? gateway.snapshot.client : null;
  let value = null;
  let error: string | null = null;
  try {
    value = await context.sessions.list({
      ...DEFAULT_SESSION_LIST_QUERY,
      boardFace: "dashboard",
      archivedFilter: "all",
      ...(context.agentSelection.state.scopeId
        ? { agentId: context.agentSelection.state.scopeId }
        : {}),
    });
  } catch (cause) {
    error = String(cause);
  }
  if (
    client &&
    (gateway !== context.gateway ||
      gateway.snapshot.phase !== "connected" ||
      gateway.snapshot.client !== client ||
      (error === null && value === null))
  ) {
    // Keep the last successful match visible until reconnect hydration starts
    // a current-connection load and the router aborts this retired request.
    return waitForSupersedingNavigation(signal);
  }
  return {
    result: value,
    error,
    basePath: context.basePath,
    fallbackAgentId: resolveSessionNavigationAgentId(context),
    mainKey: resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }),
  };
}

export const page = definePage({
  ...routePageSpec("dashboards"),
  loaderDeps: (context: ApplicationContext) =>
    `${context.agentSelection.state.scopeId ?? "all"}\u0000${context.sessions.canonicalListRevision}`,
  loader: (context: ApplicationContext, { signal }) => loadDashboardsRoute(context, signal),
  component: () =>
    import("./dashboards-page.ts").then(() => ({
      header: true,
      render: (data: DashboardsRouteData | undefined) =>
        html`<openclaw-dashboards-page .routeData=${data}></openclaw-dashboards-page>`,
    })),
});
