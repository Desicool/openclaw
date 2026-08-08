import { consume } from "@lit/context";
import { property } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderDashboards, type DashboardsRouteData } from "./view.ts";

class DashboardsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) routeData?: DashboardsRouteData;

  private observedSessions?: ApplicationContext["sessions"];
  private observedAgentSelection?: ApplicationContext["agentSelection"];
  private observedDependencies = "";
  private dependenciesInitialized = false;
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.sessions,
      (sessions) => {
        this.synchronizeDependencies();
        return sessions.subscribe(() => this.synchronizeDependencies());
      },
    )
    .effect(
      () => this.context?.agentSelection,
      (agentSelection) => {
        this.synchronizeDependencies();
        return agentSelection.subscribe(() => this.synchronizeDependencies());
      },
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private synchronizeDependencies(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const sessions = context.sessions;
    const agentSelection = context.agentSelection;
    const dependencies = `${agentSelection.state.scopeId ?? "all"}\u0000${
      sessions.canonicalListRevision
    }`;
    const sourceChanged =
      sessions !== this.observedSessions || agentSelection !== this.observedAgentSelection;
    if (
      this.dependenciesInitialized &&
      !sourceChanged &&
      dependencies === this.observedDependencies
    ) {
      return;
    }
    const shouldRevalidate =
      this.dependenciesInitialized && context.gateway.snapshot.phase === "connected";
    this.dependenciesInitialized = true;
    this.observedSessions = sessions;
    this.observedAgentSelection = agentSelection;
    this.observedDependencies = dependencies;
    if (shouldRevalidate) {
      void context.revalidate("dashboards").catch(() => undefined);
    }
  }

  override render() {
    return renderDashboards(this.routeData);
  }
}

if (!customElements.get("openclaw-dashboards-page")) {
  customElements.define("openclaw-dashboards-page", DashboardsPage);
}
