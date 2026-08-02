import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

describe("live inbound voice talkback scenario", () => {
  it("reuses the spoken WAV fixture for one visible reply", async () => {
    const state = createQaBusState();
    const expectedReply = "Matrix QA voice pre-flight OK.";

    const result = await runLoadedScenarioFlow("inbound-voice-talkback-live", {
      state,
      api: {
        env: {
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.4",
          gateway: {
            runtimeEnv: {
              OPENAI_API_KEY: "test-openai-key",
            },
          },
        },
        splitModelRef: (ref: string) => {
          const slash = ref.indexOf("/");
          return slash > 0 ? { provider: ref.slice(0, slash), model: ref.slice(slash + 1) } : null;
        },
        markGatewayLogCursor: () => 0,
        readGatewayLogs: () => "",
        resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      },
      onWaitForOutboundMessage: ({ state: currentState }) => {
        currentState.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-live-voice-talkback",
          text: expectedReply,
        });
      },
    });

    expect(result.status).toBe("pass");
    const inbound = state.getSnapshot().messages.find((message) => message.direction === "inbound");
    const audioBase64 = inbound?.attachments?.[0]?.contentBase64;
    expect(audioBase64).toBeTruthy();
    const audio = Buffer.from(audioBase64 ?? "", "base64");
    expect(audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(audio.length).toBeGreaterThan(44);
    expect(
      state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound")
        .map((message) => message.text),
    ).toEqual([expectedReply]);
  });
});
