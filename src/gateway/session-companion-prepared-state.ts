import type { SessionCompanionPreparedContext } from "./session-companion-context.js";
import type { SessionCompanionThread } from "./session-companion-state.js";

type SessionCompanionPreparedState = {
  context: SessionCompanionPreparedContext;
  digestText: string;
};

const preparedStates = new WeakMap<SessionCompanionThread, SessionCompanionPreparedState>();

export function getSessionCompanionPreparedState(
  thread: SessionCompanionThread,
): SessionCompanionPreparedState | undefined {
  return preparedStates.get(thread);
}

export function setSessionCompanionPreparedState(
  thread: SessionCompanionThread,
  state: SessionCompanionPreparedState,
): void {
  preparedStates.set(thread, state);
}
