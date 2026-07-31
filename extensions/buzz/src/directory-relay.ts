import type { Event, Filter, Relay } from "nostr-tools";
import {
  BUZZ_PROFILE_KIND,
  BUZZ_PROFILE_QUERY_CHUNK_SIZE,
  BUZZ_ROOM_METADATA_KIND,
  type BuzzDirectoryState,
} from "./directory-state.js";

const BUZZ_DIRECTORY_QUERY_TIMEOUT_MS = 5_000;
const BUZZ_ROOM_QUERY_CHUNK_SIZE = 1_000;
const PROFILE_SUBSCRIPTION_REPLACED_REASON = "directory profile subscription replaced";
const DIRECTORY_SHUTDOWN_REASON = "directory shutdown";
const DIRECTORY_QUERY_COMPLETE_REASON = "directory query complete";

type BuzzSubscription = ReturnType<Relay["subscribe"]>;

function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function queryBuzzDirectoryBatch(params: {
  relay: Relay;
  filter: Filter;
  onEvent: (event: Event) => void;
  timeoutMessage: string;
  signal?: AbortSignal;
}): Promise<void> {
  params.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const subscriptionRef: { current?: BuzzSubscription } = {};
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      subscriptionRef.current?.close(DIRECTORY_QUERY_COMPLETE_REASON);
      if (error === undefined) {
        resolve();
      } else {
        reject(
          error instanceof Error
            ? error
            : new Error("Buzz directory query failed", { cause: error }),
        );
      }
    };
    const onAbort = () =>
      finish(params.signal?.reason ?? new Error("Buzz directory query aborted"));
    const timeout = setTimeout(
      () => finish(new Error(params.timeoutMessage)),
      BUZZ_DIRECTORY_QUERY_TIMEOUT_MS,
    );
    params.signal?.addEventListener("abort", onAbort, { once: true });
    subscriptionRef.current = params.relay.subscribe([params.filter], {
      onevent: params.onEvent,
      oneose: () => finish(),
      onclose: (reason) => {
        if (reason !== DIRECTORY_QUERY_COMPLETE_REASON) {
          finish(new Error(`Buzz directory query closed: ${reason}`));
        }
      },
    });
    if (settled) {
      subscriptionRef.current.close(DIRECTORY_QUERY_COMPLETE_REASON);
    }
    if (params.signal?.aborted) {
      onAbort();
    }
  });
}

export async function queryBuzzDirectoryProfiles(params: {
  relay: Relay;
  state: BuzzDirectoryState;
  publicKeys: string[];
  signal?: AbortSignal;
}): Promise<void> {
  for (const authors of chunkValues(params.publicKeys, BUZZ_PROFILE_QUERY_CHUNK_SIZE)) {
    await queryBuzzDirectoryBatch({
      relay: params.relay,
      filter: {
        kinds: [BUZZ_PROFILE_KIND],
        authors,
        limit: authors.length,
      },
      onEvent: (event) => {
        params.state.applyProfileEvent(event);
      },
      timeoutMessage: "Timed out querying Buzz directory profiles",
      signal: params.signal,
    });
  }
}

export async function queryBuzzDirectoryRooms(params: {
  relay: Relay;
  state: BuzzDirectoryState;
  channelIds: string[];
  signal?: AbortSignal;
}): Promise<void> {
  for (const roomIds of chunkValues(params.channelIds, BUZZ_ROOM_QUERY_CHUNK_SIZE)) {
    await queryBuzzDirectoryBatch({
      relay: params.relay,
      filter: {
        kinds: [BUZZ_ROOM_METADATA_KIND],
        "#d": roomIds,
        limit: roomIds.length,
      },
      onEvent: (event) => {
        params.state.applyRoomEvent(event);
      },
      timeoutMessage: "Timed out querying Buzz room metadata",
      signal: params.signal,
    });
  }
}

export function startBuzzDirectoryRelay(params: {
  relay: Relay;
  state: BuzzDirectoryState;
  signal?: AbortSignal;
  onError?: (error: Error) => void;
}): {
  replaceProfilePublicKeys: (publicKeys: string[]) => void;
  refreshRooms: (channelIds: string[]) => Promise<void>;
  close: () => void;
} {
  let closed = false;
  let profileSubscriptions: BuzzSubscription[] = [];
  const pendingRoomIds = new Set<string>();
  let refreshInFlight: Promise<void> | undefined;

  const reportError = (error: unknown) => {
    if (closed || params.signal?.aborted) {
      return;
    }
    params.onError?.(
      error instanceof Error ? error : new Error("Buzz directory refresh failed", { cause: error }),
    );
  };

  const replaceProfilePublicKeys = (publicKeys: string[]) => {
    if (closed || params.signal?.aborted) {
      return;
    }
    const previousSubscriptions = profileSubscriptions;
    profileSubscriptions = [];
    for (const subscription of previousSubscriptions) {
      subscription.close(PROFILE_SUBSCRIPTION_REPLACED_REASON);
    }
    const nextSubscriptions: BuzzSubscription[] = [];
    try {
      for (const authors of chunkValues(publicKeys, BUZZ_PROFILE_QUERY_CHUNK_SIZE)) {
        nextSubscriptions.push(
          params.relay.subscribe(
            [
              {
                kinds: [BUZZ_PROFILE_KIND],
                authors,
                limit: authors.length,
              },
            ],
            {
              onevent: (event) => {
                params.state.applyProfileEvent(event);
              },
              oneose: () => {},
              onclose: (reason) => {
                if (
                  reason !== PROFILE_SUBSCRIPTION_REPLACED_REASON &&
                  reason !== DIRECTORY_SHUTDOWN_REASON &&
                  reason !== "relay connection closed by us"
                ) {
                  reportError(new Error(`Buzz profile subscription closed: ${reason}`));
                }
              },
            },
          ),
        );
      }
    } catch (error) {
      for (const subscription of nextSubscriptions) {
        subscription.close(PROFILE_SUBSCRIPTION_REPLACED_REASON);
      }
      reportError(error);
      return;
    }
    profileSubscriptions = nextSubscriptions;
  };

  const refreshRooms = (channelIds: string[]): Promise<void> => {
    if (closed || params.signal?.aborted) {
      return Promise.resolve();
    }
    for (const channelId of channelIds) {
      pendingRoomIds.add(channelId);
    }
    if (refreshInFlight) {
      return refreshInFlight;
    }
    refreshInFlight = (async () => {
      while (pendingRoomIds.size > 0 && !closed && !params.signal?.aborted) {
        const nextRoomIds = [...pendingRoomIds];
        pendingRoomIds.clear();
        await queryBuzzDirectoryRooms({
          relay: params.relay,
          state: params.state,
          channelIds: nextRoomIds,
          signal: params.signal,
        });
      }
    })().finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  };

  return {
    replaceProfilePublicKeys,
    refreshRooms,
    close: () => {
      closed = true;
      for (const subscription of profileSubscriptions) {
        subscription.close(DIRECTORY_SHUTDOWN_REASON);
      }
      profileSubscriptions = [];
      pendingRoomIds.clear();
    },
  };
}
