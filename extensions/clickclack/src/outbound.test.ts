// Covers ClickClack outbound routing and sender-boundary assistant text sanitization.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendClickClackMedia, sendClickClackText } from "./outbound.js";
import type { CoreConfig } from "./types.js";

const createChannelMessage = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createThreadReply = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createDirectMessage = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createDirectConversation = vi.hoisted(() => vi.fn(async () => ({ id: "dm_1" })));
const createUpload = vi.hoisted(() => vi.fn(async () => ({ id: "upl_1" })));
const attachUpload = vi.hoisted(() => vi.fn(async () => undefined));
const message = vi.hoisted(() =>
  vi.fn(async () => ({ id: "msg_out", attachments: [] as Array<{ id: string }> })),
);
const createClientOptions = vi.hoisted(() => vi.fn());
const loadOutboundMediaFromUrl = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({ loadOutboundMediaFromUrl }));

vi.mock("./accounts.js", () => ({
  resolveClickClackAccount: () => ({
    baseUrl: "https://clickclack.example",
    token: "test-token",
    workspace: "wsp_1",
  }),
}));

vi.mock("./http-client.js", () => ({
  createClickClackClient: (options: unknown) => {
    createClientOptions(options);
    return {
      createChannelMessage,
      createThreadReply,
      createDirectMessage,
      createDirectConversation,
      createUpload,
      attachUpload,
      message,
    };
  },
}));

vi.mock("./resolve.js", () => ({
  resolveWorkspaceId: async () => "wsp_1",
  resolveChannelId: async (_client: unknown, _workspaceId: string, id: string) => id,
}));

const cfg = {} as CoreConfig;

describe("sendClickClackText routing", () => {
  beforeEach(() => {
    createChannelMessage.mockClear();
    createThreadReply.mockClear();
    createDirectMessage.mockClear();
    createDirectConversation.mockClear();
    createUpload.mockClear();
    attachUpload.mockClear();
    message.mockClear();
    createClientOptions.mockClear();
    loadOutboundMediaFromUrl.mockReset();
  });

  it("sanitizes a top-level channel quote-reply", async () => {
    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
      replyToId: "msg_root",
    });

    expect(createChannelMessage).toHaveBeenCalledTimes(1);
    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "Done.",
      expect.objectContaining({ quotedMessageId: "msg_root" }),
    );
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("posts a plain channel message when there is no reply context", async () => {
    await sendClickClackText({ cfg, to: "channel:general", text: "hi" });

    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "hi",
      expect.objectContaining({ quotedMessageId: undefined }),
    );
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("uses the inbound correlation id for outbound ClickClack HTTP calls", async () => {
    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "hi",
      correlationId: "fakeco.case_1",
    });

    expect(createClientOptions).toHaveBeenCalledWith({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      correlationId: "fakeco.case_1",
    });
  });

  it("sanitizes replies inside a genuine thread", async () => {
    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
      threadId: "msg_thread_root",
      replyToId: "msg_root",
    });

    expect(createThreadReply).toHaveBeenCalledWith("msg_thread_root", "Done.", expect.anything());
    expect(createChannelMessage).not.toHaveBeenCalled();
  });

  it("threads when the target itself names a thread", async () => {
    await sendClickClackText({ cfg, to: "thread:msg_root", text: "hi" });

    expect(createThreadReply).toHaveBeenCalledWith("msg_root", "hi", expect.anything());
    expect(createChannelMessage).not.toHaveBeenCalled();
  });

  it("sanitizes leaked tool XML in a DM quote-reply", async () => {
    await sendClickClackText({
      cfg,
      to: "dm:usr_1",
      text: '<tool_call>{"name":"exec"}</tool_call>Deploy finished.',
      replyToId: "msg_root",
    });

    expect(createDirectMessage).toHaveBeenCalledWith(
      "dm_1",
      "Deploy finished.",
      expect.objectContaining({ quotedMessageId: "msg_root" }),
    );
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("suppresses replies containing only internal scaffolding", async () => {
    await expect(
      sendClickClackText({
        cfg,
        to: "channel:general",
        text: "⚠️ 🛠️ `search repos (agent)` failed",
      }),
    ).resolves.toBeUndefined();

    expect(createClientOptions).not.toHaveBeenCalled();
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(createThreadReply).not.toHaveBeenCalled();
    expect(createDirectConversation).not.toHaveBeenCalled();
    expect(createDirectMessage).not.toHaveBeenCalled();
  });
});

describe("sendClickClackMedia", () => {
  beforeEach(() => {
    createChannelMessage.mockClear();
    createThreadReply.mockClear();
    createDirectMessage.mockClear();
    createDirectConversation.mockClear();
    createUpload.mockReset().mockResolvedValue({ id: "upl_1" });
    attachUpload.mockReset().mockResolvedValue(undefined);
    message.mockReset().mockResolvedValue({ id: "msg_out", attachments: [] });
    createClientOptions.mockClear();
    loadOutboundMediaFromUrl.mockReset().mockResolvedValue({
      buffer: Buffer.from("const proof = true;"),
      contentType: "text/typescript",
      fileName: "viewer-proof.ts",
    });
  });

  it("preserves filename and MIME while uploading before channel delivery", async () => {
    const order: string[] = [];
    createUpload.mockImplementationOnce(async () => {
      order.push("upload");
      return { id: "upl_1" };
    });
    createChannelMessage.mockImplementationOnce(async () => {
      order.push("message");
      return { id: "msg_out" };
    });
    attachUpload.mockImplementationOnce(async () => {
      order.push("attach");
    });
    const mediaReadFile = vi.fn();

    const messageId = await sendClickClackMedia({
      cfg,
      to: "channel:general",
      text: "Artifact proof",
      mediaUrl: "/workspace/viewer-proof.ts",
      mediaLocalRoots: ["/workspace"],
      mediaReadFile,
    });

    expect(loadOutboundMediaFromUrl).toHaveBeenCalledWith("/workspace/viewer-proof.ts", {
      maxBytes: 64 * 1024 * 1024,
      mediaAccess: undefined,
      mediaLocalRoots: ["/workspace"],
      mediaReadFile,
    });
    expect(createUpload).toHaveBeenCalledWith({
      workspaceId: "wsp_1",
      buffer: Buffer.from("const proof = true;"),
      filename: "viewer-proof.ts",
      contentType: "text/typescript",
    });
    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "Artifact proof",
      expect.objectContaining({ quotedMessageId: undefined }),
    );
    expect(attachUpload).toHaveBeenCalledWith("msg_out", "upl_1");
    expect(order).toEqual(["upload", "message", "attach"]);
    expect(messageId).toBe("msg_out");
  });

  it("uses the filename as the minimal media-only body and routes DMs", async () => {
    const messageId = await sendClickClackMedia({
      cfg,
      to: "dm:usr_1",
      text: "",
      mediaUrl: "https://files.example/viewer-proof.ts",
    });

    expect(createDirectConversation).toHaveBeenCalledWith("wsp_1", ["usr_1"]);
    expect(createDirectMessage).toHaveBeenCalledWith(
      "dm_1",
      "viewer-proof.ts",
      expect.objectContaining({ quotedMessageId: undefined }),
    );
    expect(attachUpload).toHaveBeenCalledWith("msg_out", "upl_1");
    expect(messageId).toBe("msg_out");
  });

  it("routes explicit thread targets before attaching the upload", async () => {
    await sendClickClackMedia({
      cfg,
      to: "thread:msg_root",
      text: "Thread artifact",
      mediaUrl: "/workspace/viewer-proof.ts",
    });

    expect(createThreadReply).toHaveBeenCalledWith(
      "msg_root",
      "Thread artifact",
      expect.anything(),
    );
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(attachUpload).toHaveBeenCalledWith("msg_out", "upl_1");
  });

  it("rejects oversized media before creating a ClickClack client or upload", async () => {
    loadOutboundMediaFromUrl.mockRejectedValueOnce(new Error("media exceeds 67108864 bytes"));

    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Too large",
        mediaUrl: "/workspace/oversized.bin",
      }),
    ).rejects.toThrow("media exceeds 67108864 bytes");

    expect(createClientOptions).not.toHaveBeenCalled();
    expect(createUpload).not.toHaveBeenCalled();
    expect(createChannelMessage).not.toHaveBeenCalled();
  });

  it("retries attachment association with the same upload and message", async () => {
    attachUpload.mockRejectedValueOnce(new Error("attachment response lost"));

    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Artifact proof",
        mediaUrl: "/workspace/viewer-proof.ts",
      }),
    ).resolves.toBe("msg_out");

    expect(createUpload).toHaveBeenCalledTimes(1);
    expect(createChannelMessage).toHaveBeenCalledTimes(1);
    expect(attachUpload).toHaveBeenCalledTimes(2);
    expect(attachUpload).toHaveBeenNthCalledWith(1, "msg_out", "upl_1");
    expect(attachUpload).toHaveBeenNthCalledWith(2, "msg_out", "upl_1");
  });

  it("accepts a persisted attachment when the success response was lost", async () => {
    attachUpload.mockRejectedValueOnce(new Error("attachment response lost"));
    message.mockResolvedValueOnce({ id: "msg_out", attachments: [{ id: "upl_1" }] });

    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Artifact proof",
        mediaUrl: "/workspace/viewer-proof.ts",
      }),
    ).resolves.toBe("msg_out");

    expect(createUpload).toHaveBeenCalledTimes(1);
    expect(createChannelMessage).toHaveBeenCalledTimes(1);
    expect(message).toHaveBeenCalledWith("msg_out");
    expect(attachUpload).toHaveBeenCalledTimes(1);
  });

  it("reuses the durable message nonce and skips a duplicate upload after queue retry", async () => {
    message.mockResolvedValueOnce({ id: "msg_out", attachments: [{ id: "upl_existing" }] });

    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Artifact proof",
        mediaUrl: "/workspace/viewer-proof.ts",
        deliveryQueueId: "queue-1",
      }),
    ).resolves.toBe("msg_out");

    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "Artifact proof",
      expect.objectContaining({
        nonce: "openclaw-media:f27622b50e7607cc421a35e2d7f10f23b043bb7318ca67e98927c7bd41887a2a",
      }),
    );
    expect(message).toHaveBeenCalledWith("msg_out");
    expect(createUpload).not.toHaveBeenCalled();
    expect(attachUpload).not.toHaveBeenCalled();
  });

  it("still rejects when attachment association and its bounded retry both fail", async () => {
    attachUpload.mockRejectedValue(new Error("attachment rejected"));

    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Artifact proof",
        mediaUrl: "/workspace/viewer-proof.ts",
      }),
    ).rejects.toThrow("attachment rejected");

    expect(createUpload).toHaveBeenCalledTimes(1);
    expect(createChannelMessage).toHaveBeenCalledTimes(1);
    expect(attachUpload).toHaveBeenCalledTimes(2);
  });
});
