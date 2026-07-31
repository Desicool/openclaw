// Mistral lifecycle tests cover bounded transcript accumulation and terminal events.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMistralRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

const { FakeWebSocket } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    binaryType = "nodebuffer";
    closeCalls = 0;
    readonly listeners = new Map<string, Listener[]>();
    readyState = 0;
    sent: string[] = [];

    constructor() {
      MockWebSocket.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(code?: number, reason?: string): void {
      this.closeCalls += 1;
      if (this.readyState === MockWebSocket.CLOSED) {
        return;
      }
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }
  }

  return { FakeWebSocket: MockWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;

function emitEvent(socket: FakeWebSocketInstance, event: unknown): void {
  socket.emit("message", Buffer.from(JSON.stringify(event)));
}

async function connectSession(callbacks: {
  onError?: (error: Error) => void;
  onPartial?: (partial: string) => void;
  onTranscript?: (transcript: string) => void;
}) {
  const session = buildMistralRealtimeTranscriptionProvider().createSession({
    providerConfig: {
      apiKey: "fixture-value",
      baseUrl: "ws://mistral.test",
    },
    ...callbacks,
  });
  const connecting = session.connect();
  let socket: FakeWebSocketInstance | undefined;
  await vi.waitFor(() => {
    socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected session to create a websocket");
    }
  });
  if (!socket) {
    throw new Error("expected session to create a websocket");
  }
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  emitEvent(socket, { type: "session.created" });
  await connecting;
  return { session, socket };
}

describe("Mistral realtime transcription lifecycle", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it("preserves partial, segment, and done transcript semantics", async () => {
    const errors: string[] = [];
    const partials: string[] = [];
    const transcripts: string[] = [];
    const { session, socket } = await connectSession({
      onError: (error) => errors.push(error.message),
      onPartial: (partial) => partials.push(partial),
      onTranscript: (transcript) => transcripts.push(transcript),
    });

    emitEvent(socket, { type: "transcription.text.delta", text: "hel" });
    emitEvent(socket, { type: "transcription.text.delta", text: "lo" });
    emitEvent(socket, { type: "transcription.segment", text: "hello final" });
    emitEvent(socket, { type: "transcription.text.delta", text: "next" });
    emitEvent(socket, {
      type: "transcription.done",
      text: "provider full transcript remains ignored",
    });

    expect(partials).toEqual(["hel", "hello", "next"]);
    expect(transcripts).toEqual(["hello final", "next"]);
    expect(errors).toEqual([]);
    expect(socket.closeCalls).toBe(1);
    expect(session.isConnected()).toBe(false);
  });

  it("tracks the in-progress transcript limit as aggregate UTF-8 bytes", async () => {
    const errors: string[] = [];
    const transcripts: string[] = [];
    const { socket } = await connectSession({
      onError: (error) => errors.push(error.message),
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    const exactUtf8Limit = "🙂".repeat((256 * 1024) / 4);
    const splitSurrogatePrefix = "x".repeat(256 * 1024 - 4);
    const splitSurrogateTranscript = `${splitSurrogatePrefix}🙂`;

    emitEvent(socket, { type: "transcription.text.delta", text: exactUtf8Limit });
    emitEvent(socket, { type: "transcription.segment", text: "first segment" });
    emitEvent(socket, {
      type: "transcription.text.delta",
      text: `${splitSurrogatePrefix}\ud83d`,
    });
    emitEvent(socket, { type: "transcription.text.delta", text: "\ude42" });
    emitEvent(socket, { type: "transcription.done" });

    expect(errors).toEqual([]);
    expect(transcripts).toEqual(["first segment", splitSurrogateTranscript]);
    expect(socket.closeCalls).toBe(1);
  });

  it("fails once and ignores late terminal events after 10,000 runaway deltas", async () => {
    const errors: string[] = [];
    const transcripts: string[] = [];
    let lastPartialLength = 0;
    let partialCalls = 0;
    const { session, socket } = await connectSession({
      onError: (error) => errors.push(error.message),
      onPartial: (partial) => {
        lastPartialLength = partial.length;
        partialCalls += 1;
      },
      onTranscript: (transcript) => transcripts.push(transcript),
    });

    for (let index = 0; index < 10_000; index += 1) {
      emitEvent(socket, { type: "transcription.text.delta", text: "x".repeat(32) });
    }
    emitEvent(socket, { type: "transcription.segment", text: "late segment" });
    emitEvent(socket, { type: "transcription.done", text: "late done" });

    expect(errors).toEqual([
      "Mistral realtime transcription exceeded the 256 KiB in-progress transcript limit",
    ]);
    expect(partialCalls).toBe(8_192);
    expect(lastPartialLength).toBe(256 * 1024);
    expect(transcripts).toEqual([]);
    expect(socket.closeCalls).toBe(1);
    expect(session.isConnected()).toBe(false);
  });
});
