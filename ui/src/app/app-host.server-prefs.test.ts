/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-host.ts";
import type { ApplicationContext } from "./context.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings } from "./settings.ts";

type ShellServerPreferencesState = {
  runtime: { context: ApplicationContext };
  reconcileServerUiPrefs: (runtimeConfig: ApplicationContext["runtimeConfig"]) => void;
};

describe("OpenClaw shell locale preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
  });

  afterEach(() => {
    resetServerUiPrefsSync();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses canonical server locale provenance and clears a stale local pin", () => {
    localStorage.setItem("openclaw.i18n.locale", "fr");
    const setLocale = vi.spyOn(i18n, "setLocale").mockResolvedValue();
    const useSystemLocale = vi.spyOn(i18n, "useSystemLocale").mockResolvedValue();
    const state = {
      configSnapshot: {
        config: { ui: { prefs: { locale: "de" } } },
        hash: "locale-config-hash",
      },
    };
    const runtimeConfig = { state } as unknown as ApplicationContext["runtimeConfig"];
    const context = {
      gateway: { connection: { gatewayUrl: "ws://locale.test" } },
      navigation: { update: vi.fn() },
      theme: { refresh: vi.fn() },
      runtimeConfig,
    } as unknown as ApplicationContext;
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellServerPreferencesState;
    shell.runtime = { context };

    shell.reconcileServerUiPrefs(runtimeConfig);
    shell.reconcileServerUiPrefs(runtimeConfig);
    state.configSnapshot = {
      config: { ui: { prefs: {} } },
      hash: "locale-config-cleared-hash",
    };
    shell.reconcileServerUiPrefs(runtimeConfig);
    shell.reconcileServerUiPrefs(runtimeConfig);

    expect(setLocale).toHaveBeenCalledExactlyOnceWith("de");
    expect(useSystemLocale).toHaveBeenCalledOnce();
    expect(loadSettings().locale).toBeUndefined();
  });
});
