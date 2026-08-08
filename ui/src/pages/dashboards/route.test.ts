// @vitest-environment node

import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";
import type { DashboardsRouteData } from "./view.ts";

const loaderOptions: RouteLoaderOptions = {
  signal: new AbortController().signal,
  shouldRun: () => true,
  revalidating: false,
  location: { pathname: "/dashboards", search: "", hash: "" },
  deps: "",
  cause: "navigation",
};

function sessionsResult(key: string): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [{ key, kind: "direct", boardFace: "dashboard", updatedAt: 1 }],
  };
}

async function loadDashboards(
  context: ApplicationContext,
  options: RouteLoaderOptions,
): Promise<Awaited<ReturnType<NonNullable<typeof page.loader>>>> {
  return await Promise.resolve(page.loader!(context, options));
}

describe("dashboards route", () => {
  it("requests the dashboard face from the server before pagination", async () => {
    const list = vi.fn(async () => null);
    const context = {
      basePath: "",
      sessions: { list, canonicalListRevision: 4 },
      agentSelection: { state: { selectedId: "main", scopeId: null } },
      agents: { state: { agentsList: null } },
      gateway: { snapshot: { hello: null } },
    } as unknown as ApplicationContext;
    if (!page.loader) {
      throw new Error("dashboards route has no loader");
    }

    await loadDashboards(context, loaderOptions);

    expect(list).toHaveBeenCalledWith({
      limit: 50,
      boardFace: "dashboard",
      archivedFilter: "all",
    });
  });

  it("does not publish a retired connection result while replacement hydration is pending", async () => {
    let resolveRetired!: (value: SessionsListResult | null) => void;
    const retiredResult = new Promise<SessionsListResult | null>((resolve) => {
      resolveRetired = resolve;
    });
    const clientA = {} as GatewayBrowserClient;
    const clientB = {} as GatewayBrowserClient;
    let canonicalListRevision = 1;
    let gatewaySnapshot = { client: clientA, phase: "connected", hello: null };
    const gateway = {
      get snapshot() {
        return gatewaySnapshot;
      },
    } as unknown as ApplicationContext["gateway"];
    const list = vi
      .fn<() => Promise<SessionsListResult | null>>()
      .mockImplementationOnce(() => retiredResult)
      .mockResolvedValueOnce(sessionsResult("agent:main:current"));
    const context = {
      basePath: "",
      sessions: {
        list,
        get canonicalListRevision() {
          return canonicalListRevision;
        },
      },
      agentSelection: { state: { selectedId: "main", scopeId: null } },
      agents: { state: { agentsList: null } },
      gateway,
    } as unknown as ApplicationContext;
    if (!page.loader) {
      throw new Error("dashboards route has no loader");
    }

    const retiredAbort = new AbortController();
    let retiredSettled = false;
    const retiredLoad = loadDashboards(context, {
      ...loaderOptions,
      signal: retiredAbort.signal,
      revalidating: true,
    }).finally(() => {
      retiredSettled = true;
    });
    gatewaySnapshot = { client: clientA, phase: "reconnecting", hello: null };
    resolveRetired(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(retiredSettled).toBe(false);

    gatewaySnapshot = { client: clientB, phase: "connected", hello: null };
    canonicalListRevision = 2;
    retiredAbort.abort();
    await expect(retiredLoad).rejects.toMatchObject({ name: "AbortError" });

    const current = (await loadDashboards(context, loaderOptions)) as DashboardsRouteData;
    expect(current.result?.sessions[0]?.key).toBe("agent:main:current");
  });
});
