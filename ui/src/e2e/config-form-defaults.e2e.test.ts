// Control UI tests cover schema defaults and restoring inherited config values.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "config-form-defaults",
);

let browser: Browser;
let server: ControlUiE2eServer;

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config.set params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

describeControlUiE2e("Control UI config form defaults mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows defaults and removes restored optional overrides from config.set", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    const config = {
      runtime: {
        enabled: false,
        keep: "preserved",
        mode: "custom",
        retries: 9,
      },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config,
          hash: "config-form-defaults-e2e",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "config.schema": {
          generatedAt: "2026-07-31T00:00:00.000Z",
          schema: {
            type: "object",
            properties: {
              runtime: {
                type: "object",
                title: "Runtime defaults",
                properties: {
                  enabled: {
                    type: "boolean",
                    title: "Enabled",
                    description: "Controls runtime processing.",
                    default: true,
                  },
                  keep: { type: "string", title: "Keep" },
                  mode: {
                    type: "string",
                    title: "Mode",
                    default: "balanced",
                    enum: ["balanced", "fast", "careful", "safe", "strict", "custom"],
                  },
                  retries: { type: "integer", title: "Retries", default: 3 },
                },
              },
            },
          },
          uiHints: {
            "runtime.enabled": { advanced: false },
            "runtime.keep": { advanced: false },
            "runtime.mode": { advanced: false },
            "runtime.retries": { advanced: false },
          },
          version: "e2e",
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/advanced?section=runtime`);
      expect(response?.status()).toBe(200);

      const panel = page.locator("#config-section-panel");
      const enabledRow = panel.locator(".settings-row").filter({ hasText: "Enabled" });
      const modeRow = panel.locator(".settings-row").filter({ hasText: "Mode" });
      const retriesRow = panel.locator(".settings-row").filter({ hasText: "Retries" });

      await expect.poll(() => enabledRow.textContent()).toContain("Default: true");
      await expect
        .poll(() => enabledRow.textContent().then((text) => text?.replace(/\s+/gu, " ").trim()))
        .toContain("Controls runtime processing. Default: true");
      await expect.poll(() => modeRow.textContent()).toContain("Default: balanced");
      await expect.poll(() => modeRow.locator("select").inputValue()).not.toBe("__unset__");
      await expect.poll(() => retriesRow.getByRole("spinbutton").inputValue()).toBe("9");
      await expect
        .poll(() => panel.getByRole("button", { name: "Reset to default" }).count())
        .toBe(2);

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await panel.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "01-explicit-overrides.png"),
        });
      }

      await enabledRow.getByRole("button", { name: "Reset to default" }).click();
      await modeRow.locator("select").selectOption("__unset__");
      await retriesRow.getByRole("button", { name: "Reset to default" }).click();

      // Form mutations schedule config.set automatically; form mode has no manual Save control.
      const saved = requestRaw(await gateway.waitForRequest("config.set"));
      expect(saved).toEqual({ runtime: { keep: "preserved" } });

      await expect.poll(() => enabledRow.textContent()).toContain("Using default: true");
      await expect.poll(() => modeRow.locator("select").inputValue()).toBe("__unset__");
      await expect.poll(() => retriesRow.getByRole("spinbutton").inputValue()).toBe("");
      await expect
        .poll(() => retriesRow.getByRole("spinbutton").getAttribute("placeholder"))
        .toBe("Default: 3");
      await expect
        .poll(() => panel.getByRole("button", { name: "Reset to default" }).count())
        .toBe(0);

      if (captureUiProofEnabled) {
        await panel.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "02-inherited-defaults.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
