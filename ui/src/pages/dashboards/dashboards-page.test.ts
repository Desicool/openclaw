/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { page as dashboardsRoute } from "./route.ts";
import type { DashboardsRouteData } from "./view.ts";
import "./dashboards-page.ts";

type DashboardsPageElement = HTMLElement & {
  routeData?: DashboardsRouteData;
  updateComplete: Promise<boolean>;
};

async function loadDashboards(
  context: ApplicationContext,
  options: Parameters<NonNullable<typeof dashboardsRoute.loader>>[1],
): Promise<DashboardsRouteData> {
  return (await Promise.resolve(dashboardsRoute.loader!(context, options))) as DashboardsRouteData;
}

function result(sessionRow: GatewaySessionRow): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [sessionRow],
  };
}

function row(key: string, displayName: string): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    boardFace: "dashboard",
    displayName,
    updatedAt: 1,
  };
}

describe("DashboardsPage", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("reloads rendered rows once per canonical revision or agent scope change", async () => {
    const sessionListeners = new Set<() => void>();
    const selectionListeners = new Set<() => void>();
    let canonicalListRevision = 1;
    const selectionState = { selectedId: "main", scopeId: null as string | null };
    let element: DashboardsPageElement;
    const list = vi
      .fn<() => Promise<SessionsListResult | null>>()
      .mockResolvedValueOnce(result(row("agent:main:before", "Before")))
      .mockResolvedValueOnce(result(row("agent:main:after", "After")))
      .mockResolvedValueOnce(result(row("agent:writer:scoped", "Writer dashboard")));
    const context = {
      basePath: "",
      gateway: { snapshot: { client: {}, phase: "connected", hello: null } },
      sessions: {
        get canonicalListRevision() {
          return canonicalListRevision;
        },
        list,
        subscribe(listener: () => void) {
          sessionListeners.add(listener);
          return () => sessionListeners.delete(listener);
        },
      },
      agentSelection: {
        state: selectionState,
        subscribe(listener: () => void) {
          selectionListeners.add(listener);
          return () => selectionListeners.delete(listener);
        },
      },
      agents: { state: { agentsList: null } },
      revalidate: vi.fn(async () => {
        element.routeData = await loadDashboards(context, {
          ...loaderOptions,
          revalidating: true,
          cause: "revalidate",
        });
        await element.updateComplete;
      }),
    } as unknown as ApplicationContext;
    if (!dashboardsRoute.loader) {
      throw new Error("dashboards route has no loader");
    }
    const loaderOptions = {
      signal: new AbortController().signal,
      shouldRun: () => true,
      revalidating: false,
      location: { pathname: "/dashboards", search: "", hash: "" },
      deps: "",
      cause: "navigation" as const,
    };
    element = document.createElement("openclaw-dashboards-page") as DashboardsPageElement;
    element.routeData = await loadDashboards(context, loaderOptions);
    const provider = createApplicationContextProvider(context);
    provider.append(element);
    document.body.append(provider);
    await element.updateComplete;

    expect(list).toHaveBeenCalledTimes(1);
    expect(context.revalidate).not.toHaveBeenCalled();
    expect(element.textContent).toContain("Before");

    canonicalListRevision += 1;
    sessionListeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(element.textContent).toContain("After"));
    expect(list).toHaveBeenCalledTimes(2);
    expect(context.revalidate).toHaveBeenCalledTimes(1);

    sessionListeners.forEach((listener) => listener());
    await Promise.resolve();
    expect(context.revalidate).toHaveBeenCalledTimes(1);

    selectionState.scopeId = "writer";
    selectionListeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(element.textContent).toContain("Writer dashboard"));
    expect(list).toHaveBeenCalledTimes(3);
    expect(context.revalidate).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({
      limit: 50,
      boardFace: "dashboard",
      archivedFilter: "all",
      agentId: "writer",
    });
  });
});
