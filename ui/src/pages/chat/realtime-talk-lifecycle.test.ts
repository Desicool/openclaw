// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTalkTransportContext } from "./realtime-talk-shared.ts";

const transportMock = vi.hoisted(() => ({
  relayContexts: [] as RealtimeTalkTransportContext[],
  webRtcContexts: [] as RealtimeTalkTransportContext[],
  start: vi.fn(async () => undefined),
  stop: vi.fn(),
}));

vi.mock("./realtime-talk-gateway-relay.ts", () => ({
  GatewayRelayRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    transportMock.relayContexts.push(context);
    return { start: transportMock.start, stop: transportMock.stop };
  }),
}));
vi.mock("./realtime-talk-google-live.ts", () => ({
  GoogleLiveRealtimeTalkTransport: vi.fn(),
}));
vi.mock("./realtime-talk-webrtc.ts", () => ({
  WebRtcSdpRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    transportMock.webRtcContexts.push(context);
    return { start: transportMock.start, stop: transportMock.stop };
  }),
}));

import { RealtimeTalkSession } from "./realtime-talk.ts";

const requestTimeoutOptions = { timeoutMs: 30_000 };

type TranscriptContext = RealtimeTalkTransportContext & {
  callbacks: {
    onTranscript?: (entry: { role: "user" | "assistant"; text: string; final: boolean }) => void;
  };
  flushTranscriptWrites?: () => Promise<void>;
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function transcriptContext(contexts: RealtimeTalkTransportContext[], index = 0): TranscriptContext {
  const context = contexts[index];
  if (!context) {
    throw new Error("expected realtime transport context");
  }
  return context as TranscriptContext;
}

describe("RealtimeTalkSession lifecycle", () => {
  beforeEach(() => {
    transportMock.relayContexts.length = 0;
    transportMock.webRtcContexts.length = 0;
    transportMock.start.mockClear();
    transportMock.stop.mockClear();
  });

  it("retries finalized transcript writes in order", async () => {
    vi.useFakeTimers();
    try {
      const transcriptEntryIds: string[] = [];
      let firstAttempt = true;
      const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-queue",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.transcript") {
          transcriptEntryIds.push(String(params?.entryId));
          if (params?.entryId === "1" && firstAttempt) {
            firstAttempt = false;
            throw new Error("temporary failure");
          }
          return { ok: true };
        }
        return { ok: true };
      });
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
      await session.start();
      const context = transcriptContext(transportMock.webRtcContexts);
      context.callbacks.onTranscript?.({ role: "user", text: "first", final: true });
      context.callbacks.onTranscript?.({ role: "assistant", text: "second", final: true });

      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(transcriptEntryIds).toEqual(["1", "1", "2"]));
      session.stop();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues entry ids when the same voice session replaces its transport", async () => {
    const transcriptEntryIds: string[] = [];
    const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-resume",
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.transcript") {
        transcriptEntryIds.push(String(params?.entryId));
      }
      return { ok: true };
    });
    const client = { request } as never;
    const session = new RealtimeTalkSession(client, "agent:main:main", {});

    await session.start();
    const firstContext = transcriptContext(transportMock.webRtcContexts);
    firstContext.callbacks.onTranscript?.({ role: "user", text: "first", final: true });
    await firstContext.flushTranscriptWrites?.();

    await session.start();
    const secondContext = transcriptContext(transportMock.webRtcContexts, 1);
    secondContext.callbacks.onTranscript?.({ role: "assistant", text: "second", final: true });
    await secondContext.flushTranscriptWrites?.();

    expect(transcriptEntryIds).toEqual(["1", "2"]);
    expect(request.mock.calls.filter(([method]) => method === "talk.client.create")).toEqual([
      [
        "talk.client.create",
        { sessionKey: "agent:main:main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
      [
        "talk.client.create",
        {
          sessionKey: "agent:main:main",
          voiceSessionId: "voice-resume",
          capabilities: ["voice-transcript"],
        },
        requestTimeoutOptions,
      ],
    ]);
    session.stop();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        1,
      ),
    );
    await Promise.resolve();

    const firstReplacement = new RealtimeTalkSession(client, "agent:main:main");
    const secondReplacement = new RealtimeTalkSession(client, "agent:main:main");
    await firstReplacement.start();
    await secondReplacement.start();
    firstReplacement.stop();
    secondReplacement.stop();
  });

  it("surfaces transcript failure after three attempts", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-failure",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.transcript") {
          throw new Error("still unavailable");
        }
        return { ok: true };
      });
      const onStatus = vi.fn();
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
        onStatus,
      });
      await session.start();
      const context = transcriptContext(transportMock.webRtcContexts);
      context.callbacks.onTranscript?.({ role: "user", text: "save me", final: true });

      await vi.advanceTimersByTimeAsync(2_500);
      await vi.waitFor(() =>
        expect(onStatus).toHaveBeenCalledWith(
          "error",
          expect.stringContaining("Voice transcript could not be saved"),
        ),
      );
      expect(
        request.mock.calls.filter(([method]) => method === "talk.client.transcript"),
      ).toHaveLength(3);
      expect(warn).toHaveBeenCalled();
      session.stop();
      await vi.runAllTimersAsync();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries logical voice-session close after transient failures", async () => {
    vi.useFakeTimers();
    try {
      let closeAttempts = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-close-retry",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.close" && ++closeAttempts < 3) {
          throw new Error("temporary close failure");
        }
        return { ok: true };
      });
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
      await session.start();

      session.stop();
      await vi.runAllTimersAsync();

      expect(closeAttempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a new call without resuming the voice session being closed", async () => {
    let createCount = 0;
    let finishClose: (() => void) | undefined;
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.close") {
        await closing;
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();

    session.stop();
    await session.start();

    const creates = request.mock.calls.filter(([method]) => method === "talk.client.create");
    expect(creates).toEqual([
      [
        "talk.client.create",
        { sessionKey: "agent:main:main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
      [
        "talk.client.create",
        { sessionKey: "agent:main:main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
    ]);
    finishClose?.();
    await Promise.resolve();
  });

  it("bounds active and draining client voice owners across session objects", async () => {
    let createCount = 0;
    const closes: Array<ReturnType<typeof createDeferred<void>>> = [];
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.close") {
        const close = createDeferred<void>();
        closes.push(close);
        await close.promise;
      }
      return { ok: true };
    });
    const client = { request } as never;
    const first = new RealtimeTalkSession(client, "agent:main:main");
    const second = new RealtimeTalkSession(client, "agent:main:main");
    const third = new RealtimeTalkSession(client, "agent:main:main");

    await first.start();
    first.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(1));
    await second.start();
    second.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(2));

    await expect(third.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(createCount).toBe(2);

    closes[0]?.resolve();
    await vi.waitFor(async () => {
      await third.start();
      expect(createCount).toBe(3);
    });

    third.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(3));
    closes[1]?.resolve();
    closes[2]?.resolve();
  });

  it("releases bounded startup owners after request deadlines", async () => {
    vi.useFakeTimers();
    let failCreate = true;
    try {
      const request = vi.fn(
        async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
          if (method !== "talk.client.create") {
            return { ok: true };
          }
          if (!failCreate) {
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-recovered",
              clientSecret: "secret",
            };
          }
          await new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error("request timeout")), options?.timeoutMs);
          });
          return { ok: true };
        },
      );
      const client = { request } as never;
      const first = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });
      const second = new RealtimeTalkSession(
        client,
        "agent:main:main",
        {},
        { transport: "webrtc" },
      );
      const third = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });

      const startsSettled = Promise.allSettled([first.start(), second.start()]);
      await Promise.resolve();
      await Promise.resolve();
      await expect(third.start()).rejects.toThrow(
        "Too many active or closing realtime Talk voice sessions",
      );
      expect(request.mock.calls.filter(([method]) => method === "talk.client.create")).toHaveLength(
        2,
      );

      await vi.advanceTimersByTimeAsync(30_000);
      const settled = await startsSettled;
      expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);

      failCreate = false;
      await third.start();
      third.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores final transcript callbacks emitted after shutdown begins", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-shutdown",
          clientSecret: "secret",
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    const context = transcriptContext(transportMock.webRtcContexts);

    session.stop();
    context.callbacks.onTranscript?.({ role: "user", text: "too late", final: true });
    await Promise.resolve();

    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
  });

  it("drops a previous transport's delayed transcript after stop and restart", async () => {
    let createCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-${createCount}`,
          clientSecret: "secret",
        };
      }
      return { ok: true };
    });
    const onTranscript = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
      onTranscript,
    });
    await session.start();
    const previousContext = transcriptContext(transportMock.webRtcContexts);

    session.stop();
    await session.start();
    previousContext.callbacks.onTranscript?.({
      role: "user",
      text: "stale transcript",
      final: true,
    });
    await Promise.resolve();

    expect(onTranscript).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
  });

  it("does not report Gateway relay transcripts through the client RPC", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "gateway-relay",
          relaySessionId: "relay-voice",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 24_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    const context = transcriptContext(transportMock.relayContexts);
    context.callbacks.onTranscript?.({ role: "user", text: "server owns this", final: true });
    await Promise.resolve();

    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
    session.stop();
    await Promise.resolve();
    expect(request.mock.calls.some(([method]) => method === "talk.client.close")).toBe(false);
  });
});
