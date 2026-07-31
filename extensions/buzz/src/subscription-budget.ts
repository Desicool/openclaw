import { BUZZ_PROFILE_QUERY_CHUNK_SIZE } from "./directory-state.js";

const BUZZ_RELAY_MAX_SUBSCRIPTIONS = 1_024;
const BUZZ_RELAY_TRANSIENT_SUBSCRIPTION_RESERVE = 3;
const BUZZ_DIRECTORY_MAX_PROFILE_SUBSCRIPTIONS = 10;

export function resolveBuzzSubscriptionBudget(roomCount: number): {
  profileLimit: number;
} {
  if (!Number.isSafeInteger(roomCount) || roomCount < 0) {
    throw new Error("Buzz configured room count must be a non-negative integer");
  }
  const availableProfileSubscriptions =
    BUZZ_RELAY_MAX_SUBSCRIPTIONS - BUZZ_RELAY_TRANSIENT_SUBSCRIPTION_RESERVE - roomCount;
  if (availableProfileSubscriptions < 0) {
    throw new Error(
      `Buzz supports at most ${
        BUZZ_RELAY_MAX_SUBSCRIPTIONS - BUZZ_RELAY_TRANSIENT_SUBSCRIPTION_RESERVE
      } configured rooms per account`,
    );
  }
  return {
    profileLimit:
      Math.min(BUZZ_DIRECTORY_MAX_PROFILE_SUBSCRIPTIONS, availableProfileSubscriptions) *
      BUZZ_PROFILE_QUERY_CHUNK_SIZE,
  };
}
