import type { Filter, Relay } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { openBuzzRelaySubscription } from "./relay-subscription.js";

describe("openBuzzRelaySubscription", () => {
  it("sends an explicit REQ without synthesizing EOSE", async () => {
    vi.useFakeTimers();
    const oneose = vi.fn();
    const subscription = {
      id: "sub:1",
      close: vi.fn(),
    } as unknown as ReturnType<Relay["prepareSubscription"]>;
    const relay = {
      idleSince: Date.now(),
      ongoingOperations: 0,
      prepareSubscription: vi.fn(() => subscription),
      send: vi.fn(async () => {}),
    } as unknown as Relay;
    const filters: Filter[] = [{ kinds: [0], authors: ["a".repeat(64)] }];

    const opened = openBuzzRelaySubscription(relay, filters, { oneose });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(opened).toBe(subscription);
    expect(relay.prepareSubscription).toHaveBeenCalledWith(filters, { oneose });
    expect(relay.send).toHaveBeenCalledWith(JSON.stringify(["REQ", "sub:1", ...filters]));
    expect(relay.ongoingOperations).toBe(1);
    expect(relay.idleSince).toBeUndefined();
    expect(oneose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
