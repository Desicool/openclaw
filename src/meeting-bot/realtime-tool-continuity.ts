import type { RealtimeVoiceToolCallEvent } from "../talk/provider-types.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import type { TalkEventInput } from "../talk/talk-events.js";

export type MeetingRealtimeToolCallParams = {
  strategy: string;
  session: RealtimeVoiceBridgeSession;
  event: RealtimeVoiceToolCallEvent;
  meetingSessionId: string;
  requesterSessionKey?: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  onTalkEvent: (event: TalkEventInput) => void;
};

const meetingRealtimeToolAbortSignals = new WeakMap<RealtimeVoiceBridgeSession, AbortSignal>();

export function readMeetingRealtimeToolAbortSignal(
  session: RealtimeVoiceBridgeSession,
): AbortSignal | undefined {
  return meetingRealtimeToolAbortSignals.get(session);
}

export function createMeetingRealtimeToolContinuity(
  handleToolCall: (call: MeetingRealtimeToolCallParams) => Promise<void>,
) {
  let epoch = 0;
  const activeControllers = new Set<AbortController>();

  // Reset invalidates provider submissions and Talk events together so late
  // async completions cannot leak into the replacement provider generation.
  const reset = (reason: string) => {
    epoch += 1;
    for (const controller of activeControllers) {
      controller.abort(reason);
    }
    activeControllers.clear();
  };

  const run = (params: {
    session: RealtimeVoiceBridgeSession;
    call: Omit<MeetingRealtimeToolCallParams, "session" | "onTalkEvent">;
    onTalkEvent: (event: TalkEventInput) => void;
  }): Promise<void> => {
    const callEpoch = epoch;
    const controller = new AbortController();
    activeControllers.add(controller);
    const isActive = () => !controller.signal.aborted && callEpoch === epoch;
    const guardedSession = Object.create(params.session) as RealtimeVoiceBridgeSession;
    meetingRealtimeToolAbortSignals.set(guardedSession, controller.signal);
    guardedSession.submitToolResult = (callId, result, options) => {
      if (!isActive()) {
        return;
      }
      return params.session.submitToolResult(callId, result, options);
    };
    return handleToolCall({
      ...params.call,
      session: guardedSession,
      onTalkEvent: (event) => {
        if (isActive()) {
          params.onTalkEvent(event);
        }
      },
    })
      .catch((error: unknown) => {
        if (isActive()) {
          throw error;
        }
      })
      .finally(() => {
        meetingRealtimeToolAbortSignals.delete(guardedSession);
        activeControllers.delete(controller);
      });
  };

  return { reset, run };
}
