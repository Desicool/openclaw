/**
 * Outbound ClickClack delivery helpers for channel messages, thread replies,
 * and direct messages.
 */
import { createHash } from "node:crypto";
import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient, type ClickClackClient } from "./http-client.js";
import { resolveChannelId, resolveWorkspaceId } from "./resolve.js";
import { parseClickClackTarget } from "./target.js";
import type { ClickClackMessage, ClickClackMessageProvenance, CoreConfig } from "./types.js";

const CLICKCLACK_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

async function createTargetMessage(params: {
  client: ClickClackClient;
  workspaceId: string;
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  provenance?: ClickClackMessageProvenance;
  nonce?: string;
}): Promise<ClickClackMessage> {
  const parsed = parseClickClackTarget(params.to);
  const explicitThreadId = params.threadId == null ? "" : String(params.threadId);
  const replyToId = params.replyToId == null ? "" : String(params.replyToId);
  if (explicitThreadId || parsed.kind === "thread") {
    // Genuine thread context stays in that thread. A bare reply to a top-level
    // message remains a quote-reply so it does not silently leave the timeline.
    const rootId = explicitThreadId || parsed.id;
    return await params.client.createThreadReply(rootId, params.text, {
      provenance: params.provenance,
      nonce: params.nonce,
    });
  }
  if (parsed.kind === "dm") {
    const dm = await params.client.createDirectConversation(params.workspaceId, [parsed.id]);
    return await params.client.createDirectMessage(dm.id, params.text, {
      quotedMessageId: replyToId || undefined,
      nonce: params.nonce,
    });
  }
  const channelId = await resolveChannelId(params.client, params.workspaceId, parsed.id);
  return await params.client.createChannelMessage(channelId, params.text, {
    provenance: params.provenance,
    quotedMessageId: replyToId || undefined,
    nonce: params.nonce,
  });
}

function mediaDeliveryNonce(params: {
  deliveryQueueId?: string;
  mediaUrl: string;
  to: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
}): string | undefined {
  if (!params.deliveryQueueId) {
    return undefined;
  }
  const identity = [
    params.deliveryQueueId,
    params.to,
    String(params.threadId ?? ""),
    String(params.replyToId ?? ""),
    params.mediaUrl,
  ].join("\n");
  return `openclaw-media:${createHash("sha256").update(identity).digest("hex")}`;
}

async function attachUploadRetrySafe(params: {
  client: ClickClackClient;
  messageId: string;
  uploadId: string;
}): Promise<void> {
  try {
    await params.client.attachUpload(params.messageId, params.uploadId);
  } catch (firstError) {
    // The attachment write is idempotent. A read distinguishes a lost success
    // response; otherwise one bounded retry reuses the same upload and message.
    try {
      const persisted = await params.client.message(params.messageId);
      if (persisted.attachments?.some((attachment) => attachment.id === params.uploadId)) {
        return;
      }
    } catch {
      // A failed reconciliation read must not prevent the safe attach retry.
    }
    try {
      await params.client.attachUpload(params.messageId, params.uploadId);
    } catch {
      throw firstError;
    }
  }
}

function createOutboundContext(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  correlationId?: string;
}) {
  const account = resolveClickClackAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createClickClackClient({
    baseUrl: account.baseUrl,
    token: account.token,
    correlationId: params.correlationId,
  });
  return { account, client };
}

/**
 * Sends visible text to a normalized ClickClack target and returns the created
 * message id, or undefined when sanitization removes all content.
 */
export async function sendClickClackText(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  /** Safe request correlation inherited from an inbound ClickClack event. */
  correlationId?: string;
  /** Optional model/thinking attribution stamped onto the created message. */
  provenance?: ClickClackMessageProvenance;
}): Promise<string | undefined> {
  // Custom inbound replies bypass shared outbound normalization, so this private
  // sender owns ClickClack assistant-text sanitization for every delivery path.
  const text = sanitizeAssistantVisibleText(params.text);
  if (!text) {
    return undefined;
  }
  const { account, client } = createOutboundContext(params);
  const workspaceId = await resolveWorkspaceId(client, account.workspace);
  const message = await createTargetMessage({
    client,
    workspaceId,
    to: params.to,
    text,
    threadId: params.threadId,
    replyToId: params.replyToId,
    provenance: params.provenance,
  });
  return message.id;
}

/** Resolves, uploads, sends, then attaches one file to a ClickClack message. */
export async function sendClickClackMedia(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  mediaUrl: string;
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  /** Opaque durable intent id used only to derive ClickClack's message nonce. */
  deliveryQueueId?: string;
}): Promise<string> {
  const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: CLICKCLACK_MAX_UPLOAD_BYTES,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
  });
  const filename = media.fileName?.trim() || "attachment";
  const contentType = media.contentType?.trim() || "application/octet-stream";
  const text = sanitizeAssistantVisibleText(params.text) || filename;
  const { account, client } = createOutboundContext(params);
  const workspaceId = await resolveWorkspaceId(client, account.workspace);
  const nonce = mediaDeliveryNonce(params);
  // Durable sends create the nonce-keyed message first. A queue retry reuses
  // that message and can observe an attachment whose success response was lost.
  const upload = nonce
    ? undefined
    : await client.createUpload({
        workspaceId,
        buffer: media.buffer,
        filename,
        contentType,
      });
  const message = await createTargetMessage({
    client,
    workspaceId,
    to: params.to,
    text,
    threadId: params.threadId,
    replyToId: params.replyToId,
    nonce,
  });
  if (nonce) {
    const persisted = await client.message(message.id);
    if (persisted.attachments?.length) {
      return message.id;
    }
  }
  const pendingUpload =
    upload ??
    (await client.createUpload({
      workspaceId,
      buffer: media.buffer,
      filename,
      contentType,
    }));
  // Do not report delivery until ClickClack has durably attached the upload and
  // emitted message.updated; otherwise callers would accept a text-only receipt.
  await attachUploadRetrySafe({ client, messageId: message.id, uploadId: pendingUpload.id });
  return message.id;
}
