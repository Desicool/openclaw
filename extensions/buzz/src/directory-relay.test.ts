import type { Event, Filter, Relay } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { queryBuzzDirectoryRooms, startBuzzDirectoryRelay } from "./directory-relay.js";
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
const RELAY_PUBLIC_KEY = "f".repeat(64);
const FIRST_MEMBER_PUBLIC_KEY = "b".repeat(64);
const SECOND_MEMBER_PUBLIC_KEY = "c".repeat(64);
const LATEST_MEMBER_PUBLIC_KEY = "d".repeat(64);

describe("Buzz directory relay", () => {
  it("waits for EOSE and collapses queued profile replacements to the latest set", () => {
    const subscriptions: SubscriptionRecord[] = [];
    const relay = {
      idleSince: undefined,
      ongoingOperations: 0,
      prepareSubscription: vi.fn(
        (
          filters: Filter[],
          handlers: SubscriptionRecord["handlers"],
        ): ReturnType<Relay["prepareSubscription"]> => {
          const close = vi.fn();
          subscriptions.push({ filters, handlers, close });
          return {
            id: `sub:${subscriptions.length}`,
            close,
          } as ReturnType<Relay["prepareSubscription"]>;
        },
      ),
      send: vi.fn(async () => {}),
    } as unknown as Relay;
    const directory = startBuzzDirectoryRelay({
      relay,
      relayPublicKey: RELAY_PUBLIC_KEY,
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

  it("does not start a queued profile replacement after the relay closes", () => {
    const subscriptions: SubscriptionRecord[] = [];
    const relay = {
      idleSince: undefined,
      ongoingOperations: 0,
      prepareSubscription: vi.fn(
        (
          filters: Filter[],
          handlers: SubscriptionRecord["handlers"],
        ): ReturnType<Relay["prepareSubscription"]> => {
          const close = vi.fn();
          subscriptions.push({ filters, handlers, close });
          return {
            id: `sub:${subscriptions.length}`,
            close,
          } as ReturnType<Relay["prepareSubscription"]>;
        },
      ),
      send: vi.fn(async () => {}),
    } as unknown as Relay;
    const directory = startBuzzDirectoryRelay({
      relay,
      relayPublicKey: RELAY_PUBLIC_KEY,
      state: new BuzzDirectoryState({
        publicKey: BOT_PUBLIC_KEY,
        fallbackProfileName: "OpenClaw",
        channelIds: [],
      }),
    });

    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, FIRST_MEMBER_PUBLIC_KEY]);
    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, SECOND_MEMBER_PUBLIC_KEY]);
    subscriptions[0]?.handlers.onclose("relay connection closed");

    expect(subscriptions).toHaveLength(1);
  });

  it("defers query cleanup until the relay confirms EOSE", async () => {
    const abort = new AbortController();
    let handlers: SubscriptionRecord["handlers"] | undefined;
    const close = vi.fn();
    const relay = {
      idleSince: undefined,
      ongoingOperations: 0,
      prepareSubscription: vi.fn(
        (
          _filters: Filter[],
          nextHandlers: SubscriptionRecord["handlers"],
        ): ReturnType<Relay["prepareSubscription"]> => {
          handlers = nextHandlers;
          return { id: "sub:1", close } as ReturnType<Relay["prepareSubscription"]>;
        },
      ),
      send: vi.fn(async () => {}),
    } as unknown as Relay;
    const query = queryBuzzDirectoryRooms({
      relay,
      relayPublicKey: RELAY_PUBLIC_KEY,
      state: new BuzzDirectoryState({
        publicKey: BOT_PUBLIC_KEY,
        fallbackProfileName: "OpenClaw",
        channelIds: [],
      }),
      channelIds: ["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
      signal: abort.signal,
    });

    abort.abort(new Error("stop"));
    await expect(query).rejects.toThrow("stop");
    expect(close).not.toHaveBeenCalled();

    handlers?.oneose();
    expect(close).toHaveBeenCalledWith("directory query complete");
  });
});
