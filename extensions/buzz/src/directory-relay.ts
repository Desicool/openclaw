import type { Event, Filter, Relay } from "nostr-tools";
import {
  BUZZ_PROFILE_KIND,
  BUZZ_PROFILE_QUERY_CHUNK_SIZE,
  BUZZ_ROOM_METADATA_KIND,
  type BuzzDirectoryState,
} from "./directory-state.js";
import { openBuzzRelaySubscription } from "./relay-subscription.js";

const BUZZ_ROOM_QUERY_CHUNK_SIZE = 1_000;
const PROFILE_SUBSCRIPTION_REPLACED_REASON = "directory profile subscription replaced";
const DIRECTORY_SHUTDOWN_REASON = "directory shutdown";
const DIRECTORY_QUERY_COMPLETE_REASON = "directory query complete";

type BuzzSubscription = ReturnType<Relay["prepareSubscription"]>;
type ProfileSubscriptionGeneration = {
  subscriptions: BuzzSubscription[];
  pendingReady: number;
  opening: boolean;
};

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
  signal?: AbortSignal;
}): Promise<void> {
  params.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let receivedEose = false;
    const subscriptionRef: { current?: BuzzSubscription } = {};
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      params.signal?.removeEventListener("abort", onAbort);
      if (receivedEose) {
        subscriptionRef.current?.close(DIRECTORY_QUERY_COMPLETE_REASON);
      }
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
    params.signal?.addEventListener("abort", onAbort, { once: true });
    subscriptionRef.current = openBuzzRelaySubscription(params.relay, [params.filter], {
      onevent: params.onEvent,
      oneose: () => {
        receivedEose = true;
        if (settled) {
          subscriptionRef.current?.close(DIRECTORY_QUERY_COMPLETE_REASON);
        } else {
          finish();
        }
      },
      onclose: (reason) => {
        if (reason !== DIRECTORY_QUERY_COMPLETE_REASON) {
          finish(new Error(`Buzz directory query closed: ${reason}`));
        }
      },
    });
    if (settled && receivedEose) {
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
      signal: params.signal,
    });
  }
}

export async function queryBuzzDirectoryRooms(params: {
  relay: Relay;
  relayPublicKey: string;
  state: BuzzDirectoryState;
  channelIds: string[];
  signal?: AbortSignal;
}): Promise<void> {
  for (const roomIds of chunkValues(params.channelIds, BUZZ_ROOM_QUERY_CHUNK_SIZE)) {
    await queryBuzzDirectoryBatch({
      relay: params.relay,
      filter: {
        kinds: [BUZZ_ROOM_METADATA_KIND],
        authors: [params.relayPublicKey],
        "#d": roomIds,
        limit: roomIds.length,
      },
      onEvent: (event) => {
        if (event.pubkey.toLowerCase() === params.relayPublicKey) {
          params.state.applyRoomEvent(event);
        }
      },
      signal: params.signal,
    });
  }
}

export function startBuzzDirectoryRelay(params: {
  relay: Relay;
  relayPublicKey: string;
  state: BuzzDirectoryState;
  signal?: AbortSignal;
  onError?: (error: Error) => void;
}): {
  replaceProfilePublicKeys: (publicKeys: string[]) => void;
  refreshRooms: (channelIds: string[]) => Promise<void>;
  close: () => void;
} {
  let closed = false;
  let profileGeneration: ProfileSubscriptionGeneration | undefined;
  let queuedProfilePublicKeys: string[] | undefined;
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

  const closeProfileGeneration = (reason: string) => {
    const current = profileGeneration;
    profileGeneration = undefined;
    if (!current) {
      return;
    }
    for (const subscription of current.subscriptions) {
      subscription.close(reason);
    }
  };

  const applyQueuedProfilePublicKeys = () => {
    if (
      closed ||
      params.signal?.aborted ||
      queuedProfilePublicKeys === undefined ||
      profileGeneration?.opening ||
      (profileGeneration?.pendingReady ?? 0) > 0
    ) {
      return;
    }
    const publicKeys = queuedProfilePublicKeys;
    queuedProfilePublicKeys = undefined;
    closeProfileGeneration(PROFILE_SUBSCRIPTION_REPLACED_REASON);
    const authorChunks = chunkValues(publicKeys, BUZZ_PROFILE_QUERY_CHUNK_SIZE);
    if (authorChunks.length === 0) {
      return;
    }
    const generation: ProfileSubscriptionGeneration = {
      subscriptions: [],
      pendingReady: authorChunks.length,
      opening: true,
    };
    profileGeneration = generation;
    try {
      for (const authors of authorChunks) {
        let ready = false;
        const markReady = () => {
          if (ready || profileGeneration !== generation) {
            return;
          }
          ready = true;
          generation.pendingReady -= 1;
          if (!generation.opening && generation.pendingReady === 0) {
            applyQueuedProfilePublicKeys();
          }
        };
        const subscription = openBuzzRelaySubscription(
          params.relay,
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
            oneose: markReady,
            onclose: (reason) => {
              if (profileGeneration === generation) {
                profileGeneration = undefined;
                queuedProfilePublicKeys = undefined;
              }
              if (
                reason !== PROFILE_SUBSCRIPTION_REPLACED_REASON &&
                reason !== DIRECTORY_SHUTDOWN_REASON &&
                reason !== "relay connection closed by us"
              ) {
                reportError(new Error(`Buzz profile subscription closed: ${reason}`));
              }
            },
          },
        );
        generation.subscriptions.push(subscription);
      }
    } catch (error) {
      if (profileGeneration === generation) {
        closeProfileGeneration(PROFILE_SUBSCRIPTION_REPLACED_REASON);
      }
      reportError(error);
      return;
    }
    generation.opening = false;
    if (generation.pendingReady === 0) {
      applyQueuedProfilePublicKeys();
    }
  };

  const replaceProfilePublicKeys = (publicKeys: string[]) => {
    if (closed || params.signal?.aborted) {
      return;
    }
    queuedProfilePublicKeys = publicKeys.slice();
    applyQueuedProfilePublicKeys();
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
      while (pendingRoomIds.size > 0) {
        if (closed || params.signal?.aborted) {
          pendingRoomIds.clear();
          return;
        }
        const nextRoomIds = [...pendingRoomIds];
        pendingRoomIds.clear();
        await queryBuzzDirectoryRooms({
          relay: params.relay,
          relayPublicKey: params.relayPublicKey,
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
      queuedProfilePublicKeys = undefined;
      closeProfileGeneration(DIRECTORY_SHUTDOWN_REASON);
      pendingRoomIds.clear();
    },
  };
}
