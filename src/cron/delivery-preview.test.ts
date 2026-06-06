// Delivery preview tests cover dry-run delivery plan output for cron jobs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveDeliveryTarget: vi.fn(),
}));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

const { resolveCronDeliveryPreview } = await import("./delivery-preview.js");

describe("resolveCronDeliveryPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDeliveryTarget.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "direct-123",
      mode: "implicit",
    });
  });

  it("does not resolve routes for explicit no-delivery jobs", async () => {
    const job = makeCronJob({
      delivery: { mode: "none" },
      sessionTarget: "isolated",
    });

    const preview = await resolveCronDeliveryPreview({
      cfg: {} as never,
      job,
    });

    expect(preview).toEqual({ label: "not requested", detail: "not requested" });
    expect(mocks.resolveDeliveryTarget).not.toHaveBeenCalled();
  });

  it("previews explicit message-tool targets on no-delivery jobs", async () => {
    const job = makeCronJob({
      agentId: "avery",
      delivery: {
        mode: "none",
        channel: "topicchat",
        to: "room#42",
        threadId: 42,
        accountId: "ops",
      },
      sessionTarget: "isolated",
    });

    const preview = await resolveCronDeliveryPreview({
      cfg: {} as never,
      job,
    });

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {},
      "avery",
      {
        channel: "topicchat",
        to: "room#42",
        threadId: 42,
        accountId: "ops",
        sessionKey: undefined,
      },
      { dryRun: true },
    );
    expect(preview).toEqual({
      label: "none -> telegram:direct-123",
      detail: "explicit",
    });
  });

  it("does not describe unresolved no-delivery message-tool targets as fail-closed", async () => {
    mocks.resolveDeliveryTarget.mockResolvedValueOnce({
      ok: false,
      mode: "implicit",
      error: new Error("no route"),
    });
    const job = makeCronJob({
      agentId: "avery",
      delivery: {
        mode: "none",
        threadId: 0,
      },
      sessionTarget: "isolated",
    });

    const preview = await resolveCronDeliveryPreview({
      cfg: {} as never,
      job,
    });

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {},
      "avery",
      {
        channel: "last",
        to: undefined,
        threadId: 0,
        accountId: undefined,
        sessionKey: undefined,
      },
      { dryRun: true },
    );
    expect(preview).toEqual({
      label: "none -> last",
      detail: "message tool target unresolved: no route",
    });
  });
});
