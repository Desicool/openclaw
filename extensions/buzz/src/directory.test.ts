import { getPublicKey, type Event, type Filter } from "nostr-tools";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const relayMocks = vi.hoisted(() => ({
  auth: vi.fn(async () => "ok"),
  close: vi.fn(),
  connect: vi.fn(async () => {}),
  filters: [] as Filter[],
  subscribe: vi.fn(),
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      auth = relayMocks.auth;
      close = relayMocks.close;
      connect = relayMocks.connect;
      onauth: unknown;

      subscribe(
        filters: Filter[],
        handlers: {
          onevent: (event: Event) => void;
          oneose: () => void;
        },
      ) {
        const filter = filters[0] ?? {};
        relayMocks.filters.push(filter);
        return relayMocks.subscribe(filter, handlers);
      }
    },
  };
});

vi.mock("./gateway.js", () => ({
  getActiveBuzzBus: () => undefined,
}));

const PRIVATE_KEY = "11".repeat(32);
const BOT_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const MEMBER_PUBLIC_KEY = "b".repeat(64);
const ROOM_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";

function event(params: Partial<Event> & Pick<Event, "kind" | "pubkey">): Event {
  return {
    id: params.id ?? "f".repeat(64),
    kind: params.kind,
    pubkey: params.pubkey,
    created_at: params.created_at ?? 1_700_000_000,
    content: params.content ?? "",
    sig: params.sig ?? "e".repeat(128),
    tags: params.tags ?? [],
  };
}

describe("Buzz live directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relayMocks.filters.length = 0;
    relayMocks.subscribe.mockImplementation(
      (
        filter: Filter,
        handlers: {
          onevent: (event: Event) => void;
          oneose: () => void;
        },
      ) => {
        if (filter.kinds?.includes(39_002)) {
          handlers.onevent(
            event({
              kind: 39_002,
              pubkey: "c".repeat(64),
              tags: [
                ["d", ROOM_ID],
                ["p", BOT_PUBLIC_KEY, "", "bot"],
                ["p", MEMBER_PUBLIC_KEY, "", "member"],
              ],
            }),
          );
        } else if (filter.kinds?.includes(39_000)) {
          handlers.onevent(
            event({
              kind: 39_000,
              pubkey: "c".repeat(64),
              tags: [
                ["d", ROOM_ID],
                ["name", "Engineering"],
              ],
            }),
          );
        } else if (filter.kinds?.includes(0)) {
          handlers.onevent(
            event({
              kind: 0,
              pubkey: MEMBER_PUBLIC_KEY,
              content: JSON.stringify({
                display_name: "Alice",
                picture: "https://example.com/alice.png",
              }),
            }),
          );
        }
        handlers.oneose();
        return { close: vi.fn() };
      },
    );
  });

  it("loads current room membership and member profiles in one authenticated snapshot", async () => {
    const { listBuzzDirectoryPeersLive } = await import("./directory.js");
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: PRIVATE_KEY,
          groups: { [ROOM_ID]: {} },
        },
      },
    } as unknown as OpenClawConfig;

    await expect(
      listBuzzDirectoryPeersLive({
        cfg,
        accountId: "default",
        query: "alice",
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "user",
        id: MEMBER_PUBLIC_KEY,
        name: "Alice",
        avatarUrl: "https://example.com/alice.png",
      }),
    ]);

    expect(relayMocks.filters).toEqual([
      { kinds: [39_002], "#d": [ROOM_ID], limit: 1 },
      { kinds: [39_000], "#d": [ROOM_ID], limit: 1 },
      { kinds: [0], authors: [BOT_PUBLIC_KEY, MEMBER_PUBLIC_KEY], limit: 2 },
    ]);
    expect(relayMocks.auth).toHaveBeenCalledOnce();
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });
});
