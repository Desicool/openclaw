import { t } from "../../i18n/index.ts";
import { renderPanelTabStrip, type PanelTabStripTab } from "../panel-tab-strip.ts";
import type { BrowserPageMetrics, BrowserPanelTab } from "./browser-client.ts";

export function reconcileCapturedTab(
  tabs: BrowserPanelTab[],
  targetId: string,
  metrics: BrowserPageMetrics | null,
  screenshotUrl: string,
): BrowserPanelTab[] {
  const tab = tabs.find((entry) => entry.id === targetId);
  if (!tab) {
    return tabs;
  }
  const title = metrics?.title ?? tab.title;
  const url = metrics?.url || screenshotUrl || tab.url;
  if (title === tab.title && url === tab.url) {
    return tabs;
  }
  return tabs.map((entry) => (entry.id === targetId ? { ...entry, title, url } : entry));
}

function tabLabel(tab: BrowserPanelTab): string {
  if (tab.title.trim()) {
    return tab.title.trim();
  }
  try {
    return new URL(tab.url).host || t("browser.untitledTab");
  } catch {
    return tab.url || t("browser.untitledTab");
  }
}

export function renderBrowserPanelTabs(params: {
  tabs: BrowserPanelTab[];
  activeTargetId: string | null;
  onSelect: (targetId: string) => void;
  onClose: (targetId: string) => void;
  onNew: () => void;
}) {
  const tabs: PanelTabStripTab[] = params.tabs.map((tab) => {
    const label = tabLabel(tab);
    return {
      id: tab.id,
      domId: `browser-tab-${tab.id}`,
      label,
      title: tab.url,
      closeLabel: `${t("browser.closeTab")}: ${label}`,
    };
  });
  return renderPanelTabStrip({
    tabs,
    activeId: params.activeTargetId,
    ariaControls: "browser-tab-panel",
    onSelect: params.onSelect,
    onClose: params.onClose,
    onNew: params.onNew,
    newLabel: t("browser.newTab"),
  });
}
