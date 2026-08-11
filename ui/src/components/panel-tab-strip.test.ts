/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  panelTabStripStyles,
  renderPanelTabStrip,
  type PanelTabStripTab,
} from "./panel-tab-strip.ts";

const TAB: PanelTabStripTab = {
  id: "tab-1",
  domId: "test-tab-1",
  label: "First tab",
  closeLabel: "Close tab: First tab",
};

type RenderedTab = HTMLElement & {
  active: boolean;
  panel: string;
};

type RenderedTabGroup = HTMLElement & {
  active: string;
};

function renderStrip(options: {
  tabs?: PanelTabStripTab[];
  activeId?: string | null;
  onClose?: (id: string) => void;
  onNew?: () => void;
  onSelect?: (id: string) => void;
  container?: HTMLDivElement;
}) {
  const container = options.container ?? document.createElement("div");
  render(
    renderPanelTabStrip({
      tabs: options.tabs ?? [],
      activeId: options.activeId ?? options.tabs?.[0]?.id ?? null,
      ariaControls: "test-tab-panel",
      onSelect: options.onSelect ?? vi.fn(),
      onClose: options.onClose ?? vi.fn(),
      onNew: options.onNew ?? vi.fn(),
      newLabel: "New tab",
    }),
    container,
  );
  return container;
}

function readTabStrip(container: ParentNode): {
  group: RenderedTabGroup;
  tabs: RenderedTab[];
} {
  const group = container.querySelector<RenderedTabGroup>("wa-tab-group");
  if (!group) {
    throw new Error("expected rendered tab group");
  }
  const tabs = [...container.querySelectorAll<RenderedTab>("wa-tab")];
  return { group, tabs };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("renderPanelTabStrip", () => {
  it("keeps the new-tab control from shrinking when the strip overflows", () => {
    expect(panelTabStripStyles.cssText).toMatch(/\.tabstrip-new\s*\{[^}]*flex:\s*none/u);
  });

  it("renders an unslotted new button without an empty tab group", () => {
    const onNew = vi.fn();
    const container = renderStrip({ onNew });

    expect(container.querySelector("wa-tab-group")).toBeNull();
    const button = container.querySelector<HTMLButtonElement>(".tabstrip-new");
    expect(button?.hasAttribute("slot")).toBe(false);
    button?.click();
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("slots the new button into a nonempty tab group", () => {
    const container = renderStrip({ tabs: [TAB] });

    expect(container.querySelector("wa-tab-group")).not.toBeNull();
    expect(container.querySelector(".tabstrip-new")?.getAttribute("slot")).toBe("nav");
  });

  it("closes the requested tab from its labeled close button", () => {
    const onClose = vi.fn();
    const container = renderStrip({ tabs: [TAB], onClose });
    const closeButton = container.querySelector<HTMLButtonElement>(".tabstrip-tab__close");

    expect(closeButton?.getAttribute("aria-label")).toBe(TAB.closeLabel);
    closeButton?.click();
    expect(onClose).toHaveBeenCalledWith(TAB.id);
  });

  it("closes a tab on middle click", () => {
    const onClose = vi.fn();
    const container = renderStrip({ tabs: [TAB], onClose });

    container.querySelector("wa-tab")?.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
    expect(onClose).toHaveBeenCalledWith(TAB.id);
  });

  it("keeps the controlled active tab coherent when stateful tab elements reorder", async () => {
    const first: PanelTabStripTab = {
      ...TAB,
      id: "a",
      domId: "test-tab-a",
      label: "Alpha",
      title: "https://example.com/a",
    };
    const second: PanelTabStripTab = {
      ...TAB,
      id: "b",
      domId: "test-tab-b",
      label: "Beta",
      title: "https://example.com/b",
    };
    const container = renderStrip({ tabs: [first, second], activeId: first.id });
    document.body.append(container);
    const initial = readTabStrip(container);
    const firstElement = initial.tabs.find((tab) => tab.panel === first.id);
    const secondElement = initial.tabs.find((tab) => tab.panel === second.id);
    if (!firstElement || !secondElement) {
      throw new Error("expected initial active tab");
    }
    firstElement.active = true;
    firstElement.setAttribute("active", "");
    firstElement.setAttribute("aria-selected", "true");
    firstElement.tabIndex = 0;
    secondElement.active = false;
    secondElement.removeAttribute("active");
    secondElement.setAttribute("aria-selected", "false");
    secondElement.tabIndex = -1;

    renderStrip({
      container,
      tabs: [
        { ...second, label: "Beta navigated", title: "https://example.com/b/next" },
        { ...first, label: "Alpha navigated", title: "https://example.com/a/next" },
      ],
      activeId: first.id,
    });

    await vi.waitFor(() => {
      const reordered = readTabStrip(container);
      const active = reordered.tabs.filter(
        (tab) =>
          tab.active || tab.hasAttribute("active") || tab.getAttribute("aria-selected") === "true",
      );
      const reorderedFirst = reordered.tabs.find((tab) => tab.panel === first.id);

      expect(reorderedFirst).toBe(firstElement);
      expect(reordered.group.active).toBe(first.id);
      expect(active).toEqual([firstElement]);
      expect(firstElement.getAttribute("aria-selected")).toBe("true");
      expect(firstElement.tabIndex).toBe(0);
      expect(reordered.tabs.find((tab) => tab.panel === second.id)).toMatchObject({
        active: false,
        tabIndex: -1,
      });
    });
  });
});
