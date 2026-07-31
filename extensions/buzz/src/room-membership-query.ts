import type { Relay } from "nostr-tools";
import {
  BUZZ_ROOM_MEMBERSHIP_KIND,
  isNewerBuzzRoomMembership,
  parseBuzzRoomMembershipEvent,
  type BuzzRoomMembership,
} from "./room-membership.js";

const MEMBERSHIP_QUERY_TIMEOUT_MS = 10_000;
const RELAY_QUERY_EVENT_LIMIT = 1_000;
const MEMBERSHIP_QUERY_COMPLETE_REASON = "membership snapshot loaded";

async function queryBuzzRoomMembershipBatch(params: {
  relay: Relay;
  channelIds: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Map<string, BuzzRoomMembership>> {
  const configuredRooms = new Set(params.channelIds);
  const memberships = new Map<string, BuzzRoomMembership>();
  return await new Promise<Map<string, BuzzRoomMembership>>((resolve, reject) => {
    let settled = false;
    const subscriptionRef: { current?: ReturnType<Relay["subscribe"]> } = {};
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      subscriptionRef.current?.close(MEMBERSHIP_QUERY_COMPLETE_REASON);
      if (error === undefined) {
        resolve(memberships);
      } else {
        reject(
          error instanceof Error
            ? error
            : new Error("Buzz room membership query failed", { cause: error }),
        );
      }
    };
    const onAbort = () =>
      finish(params.signal?.reason ?? new Error("Buzz room membership query aborted"));
    const timeout = setTimeout(
      () => finish(new Error("Timed out loading Buzz room membership")),
      params.timeoutMs ?? MEMBERSHIP_QUERY_TIMEOUT_MS,
    );
    params.signal?.addEventListener("abort", onAbort, { once: true });
    subscriptionRef.current = params.relay.subscribe(
      [
        {
          kinds: [BUZZ_ROOM_MEMBERSHIP_KIND],
          "#d": params.channelIds,
          limit: params.channelIds.length,
        },
      ],
      {
        onevent: (event) => {
          const membership = parseBuzzRoomMembershipEvent(event);
          if (
            !membership ||
            !configuredRooms.has(membership.roomId) ||
            !isNewerBuzzRoomMembership(membership, memberships.get(membership.roomId))
          ) {
            return;
          }
          memberships.set(membership.roomId, membership);
        },
        oneose: () => finish(),
        onclose: (reason) => {
          if (reason !== MEMBERSHIP_QUERY_COMPLETE_REASON) {
            finish(new Error(`Buzz room membership query closed: ${reason}`));
          }
        },
      },
    );
    if (settled) {
      subscriptionRef.current.close(MEMBERSHIP_QUERY_COMPLETE_REASON);
    }
    if (params.signal?.aborted) {
      onAbort();
    }
  });
}

export async function queryBuzzRoomMemberships(params: {
  relay: Relay;
  channelIds: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Map<string, BuzzRoomMembership>> {
  const memberships = new Map<string, BuzzRoomMembership>();
  for (let index = 0; index < params.channelIds.length; index += RELAY_QUERY_EVENT_LIMIT) {
    const batch = await queryBuzzRoomMembershipBatch({
      ...params,
      channelIds: params.channelIds.slice(index, index + RELAY_QUERY_EVENT_LIMIT),
    });
    for (const [roomId, membership] of batch) {
      if (isNewerBuzzRoomMembership(membership, memberships.get(roomId))) {
        memberships.set(roomId, membership);
      }
    }
  }
  return memberships;
}
