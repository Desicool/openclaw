import { describe, expect, it } from "vitest";
import {
  appendOpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";

const MAX_PENDING_AUDIO_BYTES = OPENAI_QUICKSILVER_RELAY_FRAME_BYTES * 250;

describe("GPT-Live pending microphone audio", () => {
  it("copies caller-owned PCM16 and drops an incomplete sample", () => {
    const source = Buffer.from([0x01, 0x02, 0x03]);
    const pending = appendOpenAIQuicksilverPendingAudio(Buffer.alloc(0), source);
    source.fill(0xff);

    expect(pending).toEqual(Buffer.from([0x01, 0x02]));
  });

  it("appends audio in capture order while it fits", () => {
    const first = appendOpenAIQuicksilverPendingAudio(Buffer.alloc(0), Buffer.from([0x01, 0x02]));
    const second = appendOpenAIQuicksilverPendingAudio(first, Buffer.from([0x03, 0x04]));

    expect(second).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
  });

  it("retains the newest bounded tail across existing and oversized input", () => {
    const existing = Buffer.alloc(MAX_PENDING_AUDIO_BYTES, 0x01);
    const appended = appendOpenAIQuicksilverPendingAudio(existing, Buffer.from([0x02, 0x02]));
    const oversized = Buffer.alloc(MAX_PENDING_AUDIO_BYTES + 2, 0x03);

    expect(appended).toHaveLength(MAX_PENDING_AUDIO_BYTES);
    expect(appended.subarray(0, -2).every((byte) => byte === 0x01)).toBe(true);
    expect(appended.subarray(-2)).toEqual(Buffer.from([0x02, 0x02]));
    expect(
      appendOpenAIQuicksilverPendingAudio(appended, oversized).equals(
        Buffer.alloc(MAX_PENDING_AUDIO_BYTES, 0x03),
      ),
    ).toBe(true);
  });
});
