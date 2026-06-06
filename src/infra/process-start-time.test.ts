import { describe, expect, it } from "vitest";
import { readProcessStartTimeMs } from "./process-start-time.js";

const SUPPORTED = process.platform === "darwin" || process.platform === "linux";

describe.skipIf(!SUPPORTED)("readProcessStartTimeMs (supported platform)", () => {
  it("returns ok with a plausible start time for our own pid", async () => {
    const expectedStartedAt = Date.now() - Math.floor(process.uptime() * 1000);
    const result = await readProcessStartTimeMs(process.pid);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    // macOS `lstart` is second-resolution; Linux uses btime + jiffies.
    // ±5s tolerance covers both, plus scheduling jitter.
    expect(Math.abs(result.startedAtMs - expectedStartedAt)).toBeLessThanOrEqual(5_000);
  });

  it("returns no-such-pid for a definitely-not-running pid", async () => {
    const result = await readProcessStartTimeMs(99_999_999);
    expect(result.kind).toBe("no-such-pid");
  });

  it("returns no-such-pid for non-positive pid", async () => {
    const result = await readProcessStartTimeMs(0);
    expect(result.kind).toBe("no-such-pid");
  });
});

describe.skipIf(SUPPORTED)("readProcessStartTimeMs (unsupported platform)", () => {
  it("returns unsupported-platform without throwing", async () => {
    const result = await readProcessStartTimeMs(process.pid);
    expect(result.kind).toBe("unsupported-platform");
  });
});
