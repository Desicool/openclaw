// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import type {
  RealtimeTalkCallbacks,
  RealtimeTalkJsonPcmWebSocketSessionResult,
} from "./realtime-talk-shared.ts";

const SETUP_TIMEOUT_MS = 30_000;
const sockets: FakeGoogleLiveWebSocket[] = [];
const audioContexts: FakeAudioContext[] = [];
let stopInputTrack: ReturnType<typeof vi.fn>;

class FakeGoogleLiveWebSocket extends EventTarget {
  static OPEN = 1;

  readyState = FakeGoogleLiveWebSocket.OPEN;
  binaryType: BinaryType = "blob";

  constructor(readonly url: string) {
    super();
    sockets.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  emitOpen(): void {
    this.dispatchEvent(new Event("open"));
  }

  emitMessage(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

class FakeAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  readonly sampleRate: number;
  readonly close = vi.fn(async () => undefined);

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 24_000;
    audioContexts.push(this);
  }

  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }

  createScriptProcessor() {
    return { connect() {}, disconnect() {}, onaudioprocess: null };
  }

  createGain() {
    return { connect() {}, disconnect() {}, gain: { value: 1 } };
  }
}

function createSession(): RealtimeTalkJsonPcmWebSocketSessionResult {
  return {
    provider: "google",
    transport: "provider-websocket",
    protocol: "google-live-bidi",
    clientSecret: ["auth_tokens", "browser-timeout-test"].join("/"),
    websocketUrl:
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 16_000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24_000,
    },
  };
}

function createTransport(callbacks: RealtimeTalkCallbacks = {}) {
  return new GoogleLiveRealtimeTalkTransport(createSession(), {
    callbacks,
    client: { request: vi.fn(), addEventListener: vi.fn() } as never,
    sessionKey: "main",
  });
}

function latestSocket(): FakeGoogleLiveWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("missing Google Live WebSocket");
  }
  return socket;
}

describe("Google Live setup timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    audioContexts.length = 0;
    stopInputTrack = vi.fn();
    vi.stubGlobal("WebSocket", FakeGoogleLiveWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: stopInputTrack }],
        })),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("releases browser resources when the WebSocket never opens", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onStatus, onTalkEvent });

    await expect(transport.start()).resolves.toBe("ready");
    const socket = latestSocket();
    socket.readyState = 0;
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    expect(onStatus).toHaveBeenCalledExactlyOnceWith(
      "error",
      "Realtime connection timed out after 30000ms",
    );
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(audioContexts).toHaveLength(2);
    expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
    expect(socket.readyState).toBe(3);
    expect(onTalkEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "session.closed", final: true }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out an open socket that never completes Google setup", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });

    await transport.start();
    latestSocket().emitOpen();
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    expect(onStatus).toHaveBeenCalledExactlyOnceWith(
      "error",
      "Realtime connection timed out after 30000ms",
    );
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
  });

  it.each(["status", "talk event"] as const)(
    "releases timed-out resources when the terminal %s callback throws",
    async (callbackKind) => {
      const throwingCallback = vi.fn(() => {
        throw new Error("consumer failed");
      });
      const transport = createTransport(
        callbackKind === "status"
          ? { onStatus: throwingCallback }
          : { onTalkEvent: throwingCallback },
      );

      await transport.start();
      const socket = latestSocket();
      socket.readyState = 0;
      expect(() => vi.advanceTimersByTime(SETUP_TIMEOUT_MS)).toThrow("consumer failed");

      expect(stopInputTrack).toHaveBeenCalledOnce();
      expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
      expect(socket.readyState).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("clears the deadline after Google setup completes", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });

    await transport.start();
    const socket = latestSocket();
    socket.emitOpen();
    socket.emitMessage({ setupComplete: {} });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    expect(onStatus).toHaveBeenCalledExactlyOnceWith("listening");
    transport.stop();
  });

  it("clears the deadline when the transport stops", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });

    await transport.start();
    transport.stop();
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    expect(onStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
