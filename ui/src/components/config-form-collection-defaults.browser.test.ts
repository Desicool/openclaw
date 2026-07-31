// Control UI tests cover collection default provenance and restore behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderArray, renderObject } from "./config-form.node.collection.ts";
import { renderJsonTextarea } from "./config-form.node.json.ts";
import { renderNode } from "./config-form.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

function resetButton(container: ParentNode): HTMLButtonElement {
  return expectElement(
    container.querySelector<HTMLButtonElement>("button[aria-label='Reset to default']"),
    "reset to default button",
  );
}

describe("config form collection defaults", () => {
  it("shows and restores optional JSON defaults without authoring the inherited value", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const schema = {
      anyOf: [{ type: "object" as const }, { type: "array" as const }],
      default: { mode: "balanced" },
    };

    render(
      renderJsonTextarea({
        schema,
        value: { mode: "custom" },
        path: ["payload"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain('Default: {"mode":"balanced"}');
    expectElement(container.querySelector<HTMLTextAreaElement>("textarea"), "explicit JSON").value =
      '{\n  "mode": "custom"\n}';
    resetButton(container).click();
    expect(onPatch).toHaveBeenCalledWith(["payload"], undefined);

    onPatch.mockClear();
    render(
      renderJsonTextarea({
        schema,
        value: undefined,
        path: ["payload"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain('Using default: {"mode":"balanced"}');
    expectElement(
      container.querySelector<HTMLTextAreaElement>("textarea"),
      "inherited JSON",
    ).value = '{\n  "mode": "balanced"\n}';
    expect(container.querySelector("button[aria-label='Reset to default']")).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("shows optional array defaults and keeps rejected restores in the DOM", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn(() => false);
    const schema = {
      type: "array" as const,
      items: { type: "string" as const },
      default: ["a", "b"],
    };

    render(
      renderArray(
        {
          schema,
          value: ["custom"],
          path: ["values"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    expect(container.textContent).toContain('Default: ["a","b"]');
    expect(container.textContent).toContain("1 item");
    expectElement(container.querySelector<HTMLInputElement>("input"), "explicit array item").value =
      "custom";
    resetButton(container).click();
    expect(onPatch).toHaveBeenCalledWith(["values"], undefined);
    expect(container.textContent).toContain("1 item");
    expectElement(container.querySelector<HTMLInputElement>("input"), "rejected array item").value =
      "custom";

    onPatch.mockClear();
    render(
      renderArray(
        {
          schema,
          value: undefined,
          path: ["values"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    expect(container.textContent).toContain('Using default: ["a","b"]');
    expect(container.textContent).toContain("2 items");
    const inheritedInputs = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    expect(inheritedInputs.map((input) => input.value)).toEqual(["", ""]);
    expect(inheritedInputs.map((input) => input.placeholder)).toEqual(["Default: a", "Default: b"]);
    expect(container.querySelector("button[aria-label='Reset to default']")).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("removes an optional object as one value and keeps inherited children inherited", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const onRemove = vi.fn();
    const schema = {
      type: "object" as const,
      properties: {
        profile: {
          type: "object" as const,
          title: "Profile",
          default: { enabled: true, mode: "balanced" },
          properties: {
            enabled: { type: "boolean" as const, title: "Enabled" },
            mode: { type: "string" as const, title: "Mode" },
          },
        },
        sibling: { type: "string" as const, title: "Sibling" },
      },
    };

    render(
      renderObject(
        {
          schema,
          value: {
            profile: { enabled: false, mode: "custom" },
            sibling: "preserved",
          },
          path: ["settings"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
          onRemove,
        },
        renderNode,
      ),
      container,
    );

    const profile = expectElement(
      Array.from(container.querySelectorAll("details")).find((details) =>
        details.textContent?.includes("Profile"),
      ),
      "explicit profile object",
    );
    expect(profile.textContent).toContain('Default: {"enabled":true,"mode":"balanced"}');
    resetButton(profile).click();
    expect(onRemove).toHaveBeenCalledWith(["settings", "profile"]);
    expect(onPatch).not.toHaveBeenCalled();

    onRemove.mockClear();
    render(
      renderObject(
        {
          schema,
          value: { sibling: "preserved" },
          path: ["settings"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
          onRemove,
        },
        renderNode,
      ),
      container,
    );

    const inheritedProfile = expectElement(
      Array.from(container.querySelectorAll("details")).find((details) =>
        details.textContent?.includes("Profile"),
      ),
      "inherited profile object",
    );
    expect(inheritedProfile.textContent).toContain(
      'Using default: {"enabled":true,"mode":"balanced"}',
    );
    const enabledRow = expectElement(
      Array.from(inheritedProfile.querySelectorAll(".settings-row")).find((row) =>
        row.textContent?.includes("Enabled"),
      ),
      "inherited enabled row",
    );
    const modeRow = expectElement(
      Array.from(inheritedProfile.querySelectorAll(".settings-row")).find((row) =>
        row.textContent?.includes("Mode"),
      ),
      "inherited mode row",
    );
    expect(enabledRow.textContent).toContain("Using default: true");
    expect(modeRow.textContent).toContain("Using default: balanced");
    expect(
      expectElement(modeRow.querySelector<HTMLInputElement>("input"), "inherited mode input")
        .placeholder,
    ).toBe("Default: balanced");
    expect(inheritedProfile.querySelector("button[aria-label='Reset to default']")).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("deep-clones required collection defaults before restoring them", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const schemaDefault = { nested: { enabled: true } };

    render(
      renderObject(
        {
          schema: {
            type: "object",
            title: "Required object",
            default: schemaDefault,
            properties: {
              nested: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                },
              },
            },
          },
          value: { nested: { enabled: false } },
          path: ["settings", "requiredObject"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          isRequired: true,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    resetButton(container).click();
    expect(onPatch).toHaveBeenCalledWith(["settings", "requiredObject"], schemaDefault);
    const restored = onPatch.mock.calls[0]?.[1] as typeof schemaDefault;
    expect(restored).not.toBe(schemaDefault);
    expect(restored.nested).not.toBe(schemaDefault.nested);
    restored.nested.enabled = false;
    expect(schemaDefault.nested.enabled).toBe(true);
  });
});
