import type { Event, Filter, Relay } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { startBuzzDirectoryRelay } from "./directory-relay.js";
import { BuzzDirectoryState } from "./directory-state.js";

type SubscriptionRecord = {
  filters: Filter[];
  handlers: {
    onevent: (event: Event) => void;
    oneose: () => void;
    onclose: (reason: string) => void;
  };
  close: ReturnType<typeof vi.fn>;
};

const BOT_PUBLIC_KEY = "a".repeat(64);
const FIRST_MEMBER_PUBLIC_KEY = "b".repeat(64);
const SECOND_MEMBER_PUBLIC_KEY = "c".repeat(64);
const LATEST_MEMBER_PUBLIC_KEY = "d".repeat(64);

describe("Buzz directory relay", () => {
  it("waits for EOSE and collapses queued profile replacements to the latest set", () => {
    const subscriptions: SubscriptionRecord[] = [];
    const relay = {
      subscribe: vi.fn(
        (
          filters: Filter[],
          handlers: SubscriptionRecord["handlers"],
        ): ReturnType<Relay["subscribe"]> => {
          const close = vi.fn();
          subscriptions.push({ filters, handlers, close });
          return { close } as ReturnType<Relay["subscribe"]>;
        },
      ),
    } as unknown as Relay;
    const directory = startBuzzDirectoryRelay({
      relay,
      state: new BuzzDirectoryState({
        publicKey: BOT_PUBLIC_KEY,
        fallbackProfileName: "OpenClaw",
        channelIds: [],
      }),
    });

    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, FIRST_MEMBER_PUBLIC_KEY]);
    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, SECOND_MEMBER_PUBLIC_KEY]);
    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, LATEST_MEMBER_PUBLIC_KEY]);

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.close).not.toHaveBeenCalled();

    subscriptions[0]?.handlers.oneose();

    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0]?.close).toHaveBeenCalledWith("directory profile subscription replaced");
    expect(subscriptions[1]?.filters[0]?.authors).toEqual([
      BOT_PUBLIC_KEY,
      LATEST_MEMBER_PUBLIC_KEY,
    ]);

    directory.close();
    expect(subscriptions[1]?.close).toHaveBeenCalledWith("directory shutdown");
  });
});
