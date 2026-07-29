// Whatsapp plugin module owns inbound message admission and delivery.
import { createHash } from "node:crypto";
import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  proto,
  WAMessage,
  WASocket,
} from "baileys";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  formatInboundMediaUnavailableText,
  formatLocationText,
  type MediaPlaceholderTextFact,
} from "openclaw/plugin-sdk/channel-inbound";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { getChildLogger } from "openclaw/plugin-sdk/logging-core";
import { parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { maybeResolveWhatsAppApprovalReaction } from "../approval-reactions.js";
import { getPrimaryIdentityId, resolveComparableIdentity } from "../identity.js";
import { addWhatsAppImagePreviewFields } from "../image-preview.js";
import { maybeResolveWhatsAppQuestionReaction } from "../question-reactions.js";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { formatError } from "../session.js";
import {
  checkInboundAccessControl,
  type AcceptedInboundAccessControlResult,
} from "./access-control.js";
import { requireWhatsAppInboundAdmission } from "./admission.js";
import { isRecentOutboundMessage } from "./dedupe.js";
import {
  createWhatsAppDurableInboundQueue,
  createWhatsAppIngressMonitor,
  type WhatsAppDurableInboundQueue,
  type WhatsAppIngressAdmission,
  type WhatsAppIngressLifecycle,
  type WhatsAppReadReceiptTarget,
} from "./durable-receive.js";
import {
  describeReplyContext,
  extractExternalAdReplyContext,
  extractLocationData,
  extractContactContext,
  extractMediaKind,
  extractMentionedJids,
  extractText,
  hasInboundUserContent,
} from "./extract.js";
import type { WhatsAppGroupMetadataCacheOwner } from "./group-metadata-cache.js";
import { attachWhatsAppIngressLifecycle } from "./ingress-lifecycle.js";
import { resolveInboundMediaMimetype } from "./media-mimetype.js";
import { downloadInboundMedia, downloadQuotedInboundMedia } from "./media.js";
import { withDeprecatedWebInboundMessageFlatAliases } from "./message-aliases.js";
import { addWhatsAppOutboundMentionsToContent } from "./outbound-mentions.js";
import { isJidGroup } from "./runtime-api.js";
import { normalizeWhatsAppSendResult } from "./send-result.js";
import type { WhatsAppAttachedSocketSession } from "./socket-session.js";
import type {
  AdmittedWebInboundMessage,
  WebInboundMessage,
  WebInboundMessageInput,
} from "./types.js";

const INBOUND_CLOSE_DRAIN_TIMEOUT_MS = 5_000;
const WHATSAPP_INGRESS_DRAIN_INTERVAL_MS = 1_000;

function parseWhatsAppTimestampSeconds(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return parseStrictFiniteNumber(value);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function logWhatsAppVerbose(enabled: boolean | undefined, message: string) {
  if (!enabled) {
    return;
  }
  defaultRuntime.log(message);
}

function recordAcceptedInboundActivity(accountId: string): void {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "inbound",
  });
}

type AdmittedWebInboundCallbackMessage = WebInboundMessage & {
  admission: AdmittedWebInboundMessage["admission"];
};

export type WhatsAppAppendReplyWindow = {
  afterMs: number;
  untilMs: number;
  maxAgeMs: number;
};

export type WhatsAppMessageDeliveryOptions = {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  verbose: boolean;
  accountId: string;
  sock: WASocket;
  socketSession: WhatsAppAttachedSocketSession;
  groupMetadata: WhatsAppGroupMetadataCacheOwner;
  onMessage: (msg: WebInboundMessageInput) => Promise<void>;
  mediaMaxMb?: number;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Bounded reconnect window for offline append auto-replies. */
  appendReplyWindow?: WhatsAppAppendReplyWindow;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessageInput) => boolean;
  onPendingWorkChanged?: (pendingWorkCount: number, at?: number) => void;
  durableInboundQueue?: WhatsAppDurableInboundQueue;
};

export function createWhatsAppMessageDeliveryCoordinator(options: WhatsAppMessageDeliveryOptions) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = options.sock;
  const socketSession = options.socketSession;
  const groupMetadata = options.groupMetadata;
  const {
    connectedAtMs,
    self,
    getCurrentSock,
    resolveInboundJid,
    resolveReactionTargetJids,
    rememberBaileysMessage,
    assertCanSendToJid,
    sendTrackedMessage,
    socketOperations,
  } = socketSession;
  type QueuedInboundMessageMetadata = {
    admission: AdmittedWebInboundCallbackMessage["admission"];
    debounceKey?: string;
    debounceKeyTracked?: boolean;
    turnAdoptionLifecycle?: WhatsAppIngressLifecycle;
    readReceipt?: WhatsAppReadReceiptTarget;
    receiveOrder?: number;
  };
  type QueuedInboundMessage = AdmittedWebInboundCallbackMessage & QueuedInboundMessageMetadata;
  const durableInboundQueue =
    options.durableInboundQueue ?? createWhatsAppDurableInboundQueue(options.accountId);
  const inboundDebounceMs = Math.max(0, Math.trunc(options.debounceMs ?? 0));
  const pendingDebounceKeys = new Map<string, number>();
  const activeInboundFlushes = new Set<Promise<void>>();
  const pendingMessageHandlers = new Set<Promise<void>>();
  let durableIngressActive = false;
  // Close-path coordination: resolve waiters when debounce work appears so
  // shutdown can force-flush without timer-driven polling (fake-timer safe).
  const debounceWorkWaiters = new Set<() => void>();
  const notifyDebounceWork = () => {
    if (debounceWorkWaiters.size === 0) {
      return;
    }
    const waiters = [...debounceWorkWaiters];
    debounceWorkWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  };
  const waitForDebounceWorkOrIdle = (handlers: ReadonlyArray<Promise<void>>) => {
    if (pendingDebounceKeys.size > 0 || activeInboundFlushes.size > 0) {
      return Promise.resolve();
    }
    if (pendingMessageHandlers.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = () => {
        debounceWorkWaiters.delete(finish);
        resolve();
      };
      debounceWorkWaiters.add(finish);
      void Promise.allSettled(handlers).then(finish);
    });
  };
  let nextReceiveOrder = 0;
  const publishPendingWorkState = (at = Date.now()) => {
    options.onPendingWorkChanged?.(
      pendingMessageHandlers.size +
        pendingDebounceKeys.size +
        activeInboundFlushes.size +
        (durableIngressActive ? 1 : 0),
      at,
    );
  };
  const buildInboundDebounceKey = (msg: QueuedInboundMessage): string | null => {
    const admission = requireWhatsAppInboundAdmission(msg);
    const sender = msg.platform.sender;
    const senderKey =
      admission.conversation.kind === "group"
        ? (getPrimaryIdentityId(sender ?? null) ??
          msg.platform.senderJid ??
          msg.platform.senderE164 ??
          msg.platform.senderName ??
          admission.sender.id)
        : admission.conversation.id;
    if (!senderKey) {
      return null;
    }
    return `${admission.accountId}:${admission.conversation.id}:${senderKey}`;
  };
  const shouldDebounceInboundMessage = (msg: AdmittedWebInboundCallbackMessage): boolean =>
    options.shouldDebounce?.(msg) ?? true;
  const trackPendingDebounceKey = (key: string) => {
    pendingDebounceKeys.set(key, (pendingDebounceKeys.get(key) ?? 0) + 1);
  };
  const releasePendingDebounceKey = (entry: QueuedInboundMessage) => {
    if (!entry.debounceKey || entry.debounceKeyTracked !== true) {
      return;
    }
    const remaining = (pendingDebounceKeys.get(entry.debounceKey) ?? 0) - 1;
    if (remaining > 0) {
      pendingDebounceKeys.set(entry.debounceKey, remaining);
      return;
    }
    pendingDebounceKeys.delete(entry.debounceKey);
  };
  const orderDebouncedInboundEntries = (entries: QueuedInboundMessage[]) =>
    entries.toSorted((a, b) => {
      const timestampDiff = (a.event.timestamp ?? 0) - (b.event.timestamp ?? 0);
      if (timestampDiff !== 0) {
        return timestampDiff;
      }
      return (a.receiveOrder ?? 0) - (b.receiveOrder ?? 0);
    });

  const debouncer = createInboundDebouncer<QueuedInboundMessage>({
    debounceMs: inboundDebounceMs,
    buildKey: (msg) => msg.debounceKey ?? buildInboundDebounceKey(msg),
    shouldDebounce: shouldDebounceInboundMessage,
    onFlush: (entries, createFlush) => {
      for (const entry of entries) {
        releasePendingDebounceKey(entry);
      }
      const orderedEntries = orderDebouncedInboundEntries(entries);
      const { lifecycle, settle, abandon } = fanInChannelIngressLifecycles(
        orderedEntries.map((entry) => entry.turnAdoptionLifecycle),
      );
      const flush = createFlush({
        lifecycle,
        dispatch: async (admissionLifecycle) => {
          const last = orderedEntries.at(-1);
          if (!last) {
            return;
          }
          try {
            if (orderedEntries.length === 1) {
              await options.onMessage(attachWhatsAppIngressLifecycle(last, admissionLifecycle));
              await settle();
              await Promise.all(
                orderedEntries.map((entry) => maybeMarkInboundAsRead(entry.readReceipt)),
              );
              return;
            }
            const mentioned = new Set<string>();
            for (const entry of orderedEntries) {
              for (const jid of entry.group?.mentions?.jids ?? []) {
                mentioned.add(jid);
              }
            }
            const combinedBody = orderedEntries
              .map((entry) => entry.payload.body)
              .filter(Boolean)
              .join("\n");
            const combinedCommandBody = orderedEntries
              .map((entry) => entry.payload.commandBody ?? entry.payload.body)
              .filter(Boolean)
              .join("\n");
            const combinedMentions =
              mentioned.size > 0
                ? {
                    ...last.group?.mentions,
                    jids: Array.from(mentioned),
                  }
                : last.group?.mentions;
            const combinedGroup =
              last.group || combinedMentions
                ? {
                    ...last.group,
                    mentions: combinedMentions,
                  }
                : undefined;
            const combinedMessage: QueuedInboundMessage = attachWhatsAppIngressLifecycle(
              withDeprecatedWebInboundMessageFlatAliases({
                ...last,
                turnAdoptionLifecycle: admissionLifecycle,
                payload: {
                  ...last.payload,
                  body: combinedBody,
                  commandBody: combinedCommandBody,
                },
                group: combinedGroup,
                event: {
                  ...last.event,
                  isBatched: true,
                },
              }),
              admissionLifecycle,
            );
            await options.onMessage(combinedMessage);
            await settle();
            await Promise.all(
              orderedEntries.map((entry) => maybeMarkInboundAsRead(entry.readReceipt)),
            );
          } catch (error) {
            await abandon();
            throw error;
          }
        },
      });
      activeInboundFlushes.add(flush.completion);
      publishPendingWorkState();
      notifyDebounceWork();
      const cleanup = () => {
        activeInboundFlushes.delete(flush.completion);
        publishPendingWorkState();
      };
      void flush.completion.then(cleanup, cleanup);
      return flush;
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
  });
  type NormalizedInboundMessage = {
    id?: string;
    remoteJid: string;
    group: boolean;
    participantJid?: string;
    from: string;
    senderE164: string | null;
    groupSubject?: string;
    groupParticipants?: string[];
    messageTimestampMs?: number;
    access: AcceptedInboundAccessControlResult;
  };

  const shouldSkipRecentOutboundEcho = (msg: WAMessage): boolean => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (
      !msg.key?.fromMe ||
      !id ||
      !remoteJid ||
      !isRecentOutboundMessage({
        accountId: options.accountId,
        remoteJid,
        messageId: id,
      })
    ) {
      return false;
    }
    logWhatsAppVerbose(
      options.verbose,
      `Skipping recent outbound WhatsApp echo ${id} for ${remoteJid}`,
    );
    return true;
  };

  const normalizeInboundMessage = async (
    msg: WAMessage,
  ): Promise<NormalizedInboundMessage | null> => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) {
      return null;
    }
    if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      return null;
    }

    const group = isJidGroup(remoteJid) === true;
    // Drop echoes of messages the gateway itself sent (tracked by sendTrackedMessage).
    // Applies to both groups and DMs/self-chat — without this, self-chat mode
    // re-processes the bot's own replies as new inbound user messages.
    if (shouldSkipRecentOutboundEcho(msg)) {
      return null;
    }
    // Gate pairing access-control on extractable inbound user content. Baileys
    // delivers receipts, typing indicators, presence updates, and protocol
    // messages on the same `messages.upsert` stream as real messages; without
    // this gate, `checkInboundAccessControl` can send an unsolicited pairing
    // verification reply to a `dmPolicy: pairing` peer who never typed
    // anything (e.g. when Master sends an outbound message to a new JID and
    // the receipt round-trip arrives before the recipient ever replies).
    // Echoes of our own outbound messages are already handled above.
    if (!hasInboundUserContent(msg.message ?? undefined)) {
      return null;
    }

    const participantJid = msg.key?.participant ?? undefined;
    const from = group ? remoteJid : await resolveInboundJid(remoteJid);
    if (!from) {
      return null;
    }
    const senderE164 = group
      ? participantJid
        ? await resolveInboundJid(participantJid)
        : null
      : from;

    let groupSubject: string | undefined;
    let groupParticipants: string[] | undefined;
    if (group) {
      const meta = await groupMetadata.get(remoteJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }
    const messageTimestampSeconds = parseWhatsAppTimestampSeconds(msg.messageTimestamp);
    const messageTimestampMs =
      messageTimestampSeconds !== undefined ? messageTimestampSeconds * 1000 : undefined;

    const accessCfg = options.loadConfig?.() ?? options.cfg;
    const access = await checkInboundAccessControl({
      cfg: accessCfg,
      accountId: options.accountId,
      from,
      selfE164: self.e164 ?? null,
      senderE164,
      senderJid: participantJid,
      group,
      pushName: msg.pushName ?? undefined,
      isFromMe: Boolean(msg.key?.fromMe),
      messageTimestampMs,
      connectedAtMs,
      verbose: options.verbose,
      sock: {
        sendMessage: (jid: string, content: AnyMessageContent) => sendTrackedMessage(jid, content),
      },
      remoteJid,
    });
    if (!access.allowed) {
      return null;
    }

    return {
      id,
      remoteJid,
      group,
      participantJid,
      from,
      senderE164,
      groupSubject,
      groupParticipants,
      messageTimestampMs,
      access,
    };
  };

  const buildReadReceiptTarget = (
    inbound: NormalizedInboundMessage,
  ): WhatsAppReadReceiptTarget | undefined =>
    inbound.id
      ? {
          remoteJid: inbound.remoteJid,
          id: inbound.id,
          ...(inbound.participantJid ? { participant: inbound.participantJid } : {}),
        }
      : undefined;

  const maybeMarkInboundAsRead = async (target: WhatsAppReadReceiptTarget | undefined) => {
    if (!target || options.sendReadReceipts === false) {
      return;
    }
    const { id, remoteJid, participant } = target;
    try {
      await socketSession.markRead(target);
      const suffix = participant ? ` (participant ${participant})` : "";
      logWhatsAppVerbose(options.verbose, `Marked message ${id} as read for ${remoteJid}${suffix}`);
    } catch (err) {
      logWhatsAppVerbose(options.verbose, `Failed to mark message ${id} read: ${String(err)}`);
    }
  };

  const maybeLogSkippedSelfChatReadReceipt = (
    inbound: NormalizedInboundMessage,
    target: WhatsAppReadReceiptTarget | undefined,
  ) => {
    if (target?.id && inbound.access.isSelfChat && options.verbose) {
      // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
      logWhatsAppVerbose(options.verbose, `Self-chat mode: skipping read receipt for ${target.id}`);
    }
  };

  const maybeMarkNonSelfChatReadReceipt = async (
    inbound: NormalizedInboundMessage,
    target: WhatsAppReadReceiptTarget | undefined,
  ) => {
    if (inbound.access.isSelfChat) {
      maybeLogSkippedSelfChatReadReceipt(inbound, target);
      return;
    }
    await maybeMarkInboundAsRead(target);
  };

  const shouldSkipStaleAppend = (msg: WAMessage, upsertType: string | undefined): boolean => {
    if (upsertType !== "append") {
      return false;
    }
    const APPEND_RECENT_GRACE_MS = 60_000;
    const msgTsSeconds = parseWhatsAppTimestampSeconds(msg.messageTimestamp);
    const msgTsMs = msgTsSeconds !== undefined ? msgTsSeconds * 1000 : 0;
    // Reconnect catch-up is temporary; after it expires, preserve steady-state
    // handling for fresh appends instead of rejecting every later append.
    const nowMs = Date.now();
    const appendAfterMs =
      options.appendReplyWindow && nowMs <= options.appendReplyWindow.untilMs
        ? Math.max(options.appendReplyWindow.afterMs, nowMs - options.appendReplyWindow.maxAgeMs)
        : connectedAtMs - APPEND_RECENT_GRACE_MS;
    return msgTsMs < appendAfterMs;
  };

  // Live rows keep receive-time identity facts until their first drain attempt.
  // Restart replay has no entry and re-normalizes from the persisted payload.
  type PreparedInbound = NonNullable<Awaited<ReturnType<typeof normalizeInboundMessage>>>;
  const preparedInboundByDurableId = new Map<string, Promise<PreparedInbound | null | undefined>>();

  type EnrichedInboundMessage = {
    body: string;
    commandBody: string;
    location?: ReturnType<typeof extractLocationData>;
    contactContext?: ReturnType<typeof extractContactContext>;
    externalAdReplyContext?: ReturnType<typeof extractExternalAdReplyContext>;
    replyContext?: ReturnType<typeof describeReplyContext>;
    mediaPath?: string;
    mediaType?: string;
    mediaFileName?: string;
    mediaKind?: NonNullable<ReturnType<typeof extractMediaKind>>;
    nativeMedia?: MediaPlaceholderTextFact;
  };

  const enrichInboundMessage = async (msg: WAMessage): Promise<EnrichedInboundMessage | null> => {
    const location = extractLocationData(msg.message ?? undefined);
    const locationText = location ? formatLocationText(location) : undefined;
    const contactContext = extractContactContext(msg.message ?? undefined);
    const externalAdReplyContext = extractExternalAdReplyContext(msg.message ?? undefined);
    let mediaKind = extractMediaKind(msg.message ?? undefined);
    let body = extractText(msg.message ?? undefined);
    if (locationText) {
      body = [body, locationText].filter(Boolean).join("\n").trim();
    }
    if (!body && !mediaKind) {
      return null;
    }
    body = body ?? "";
    const commandBody = body;
    const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

    let mediaPath: string | undefined;
    let mediaType = mediaKind
      ? resolveInboundMediaMimetype(msg.message as proto.IMessage)
      : undefined;
    const nativeMedia = mediaKind ? { contentType: mediaType, kind: mediaKind } : undefined;
    let mediaFileName: string | undefined;
    const maxMb =
      typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0 ? options.mediaMaxMb : 50;
    const maxBytes = maxMb * 1024 * 1024;
    const saveInboundMedia = async (
      inboundMedia: Awaited<ReturnType<typeof downloadInboundMedia>>,
    ) => {
      if (!inboundMedia) {
        return;
      }
      mediaPath = inboundMedia.saved.path;
      mediaType = inboundMedia.mimetype;
      mediaFileName = inboundMedia.fileName;
    };
    try {
      const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock, maxBytes);
      await saveInboundMedia(inboundMedia);
    } catch (err) {
      logWhatsAppVerbose(options.verbose, `Inbound media download failed: ${String(err)}`);
      body = formatInboundMediaUnavailableText({
        body,
        notice: "[whatsapp attachment unavailable]",
      });
    }
    if (!mediaPath && !mediaKind && replyContext?.media) {
      try {
        await saveInboundMedia(
          await downloadQuotedInboundMedia(msg as proto.IWebMessageInfo, sock, maxBytes),
        );
        mediaKind = replyContext.media.kind ?? undefined;
        mediaType = mediaType ?? replyContext.media.contentType ?? undefined;
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Quoted media download failed: ${String(err)}`);
        body = formatInboundMediaUnavailableText({
          body,
          notice: "[whatsapp quoted attachment unavailable]",
        });
      }
    }

    return {
      body,
      commandBody,
      location: location ?? undefined,
      contactContext,
      externalAdReplyContext,
      replyContext,
      mediaPath,
      mediaType,
      mediaFileName,
      mediaKind,
      nativeMedia,
    };
  };

  const enqueueInboundMessage = async (
    msg: WAMessage,
    inbound: NormalizedInboundMessage,
    enriched: EnrichedInboundMessage,
    durable: {
      readReceipt?: WhatsAppReadReceiptTarget;
      receiveOrder?: number;
      turnAdoptionLifecycle?: WhatsAppIngressLifecycle;
    },
  ) => {
    const chatJid = inbound.remoteJid;
    const sendComposing = async () => {
      const currentSock = getCurrentSock();
      if (!currentSock) {
        return;
      }
      try {
        await assertCanSendToJid(chatJid, currentSock);
        await socketOperations.sendPresenceUpdate("composing", chatJid);
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Presence update failed: ${String(err)}`);
      }
    };
    const reply = async (text: string, optionsResult?: MiscMessageGenerationOptions) => {
      const resolved = await groupMetadata.resolveOutboundMentions(chatJid, text);
      const result = await sendTrackedMessage(
        chatJid,
        addWhatsAppOutboundMentionsToContent({ text: resolved.text }, resolved.mentionedJids),
        optionsResult,
      );
      return normalizeWhatsAppSendResult(result, "text");
    };
    const sendMedia = async (
      payload: AnyMessageContent,
      optionsValue?: MiscMessageGenerationOptions,
    ) => {
      const previewPayload = await addWhatsAppImagePreviewFields(payload);
      const result = await sendTrackedMessage(
        chatJid,
        await groupMetadata.applyOutboundMentions(chatJid, previewPayload),
        optionsValue,
      );
      return normalizeWhatsAppSendResult(result, "media");
    };
    const timestamp = inbound.messageTimestampMs;
    const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
    const senderName = msg.pushName ?? undefined;

    inboundLogger.info(
      {
        from: inbound.from,
        to: self.e164 ?? "me",
        body: enriched.body,
        mediaPath: enriched.mediaPath,
        mediaType: enriched.mediaType,
        mediaFileName: enriched.mediaFileName,
        timestamp,
      },
      "inbound message",
    );
    const media =
      enriched.mediaPath || enriched.mediaType || enriched.mediaFileName || enriched.mediaKind
        ? {
            path: enriched.mediaPath,
            type: enriched.mediaType,
            fileName: enriched.mediaFileName,
            kind: enriched.mediaKind,
          }
        : undefined;
    const groupMentions = mentionedJids ? { jids: mentionedJids } : undefined;
    const group =
      inbound.group && (inbound.groupSubject || inbound.groupParticipants?.length || groupMentions)
        ? {
            subject: inbound.groupSubject,
            participants: inbound.groupParticipants,
            mentions: groupMentions,
          }
        : undefined;
    const channelStructuredContext = [
      ...(enriched.nativeMedia
        ? [
            {
              label: "WhatsApp media",
              source: "whatsapp",
              type: "media",
              payload: enriched.nativeMedia,
            },
          ]
        : []),
      ...(enriched.contactContext
        ? [
            {
              label: "WhatsApp contact",
              source: "whatsapp",
              type: enriched.contactContext.kind,
              payload: enriched.contactContext,
            },
          ]
        : []),
      ...(enriched.externalAdReplyContext
        ? [
            {
              label: "WhatsApp external ad reply",
              source: "whatsapp",
              type: "external_ad_reply",
              payload: enriched.externalAdReplyContext,
            },
          ]
        : []),
    ];
    const inboundMessage: QueuedInboundMessage = withDeprecatedWebInboundMessageFlatAliases({
      admission: inbound.access.admission,
      event: {
        id: inbound.id,
        timestamp,
      },
      payload: {
        body: enriched.body,
        commandBody: enriched.commandBody,
        location: enriched.location ?? undefined,
        channelStructuredContext:
          channelStructuredContext.length > 0 ? channelStructuredContext : undefined,
        media,
      },
      platform: {
        chatJid: inbound.remoteJid,
        recipientJid: self.e164 ?? "me",
        pushName: senderName,
        sender: resolveComparableIdentity({
          jid: inbound.participantJid,
          e164: inbound.senderE164 ?? undefined,
          name: senderName,
        }),
        senderJid: inbound.participantJid,
        senderE164: inbound.senderE164 ?? undefined,
        senderName,
        self,
        selfJid: self.jid ?? undefined,
        selfLid: self.lid ?? undefined,
        selfE164: self.e164 ?? undefined,
        fromMe: Boolean(msg.key?.fromMe),
        sendComposing,
        reply,
        sendMedia,
      },
      quote: enriched.replyContext
        ? {
            context: enriched.replyContext,
            id: enriched.replyContext.id,
            body: enriched.replyContext.body,
            media: enriched.replyContext.media,
            sender: {
              displayName: enriched.replyContext.sender?.label ?? undefined,
              jid: enriched.replyContext.sender?.jid ?? undefined,
              e164: enriched.replyContext.sender?.e164 ?? undefined,
            },
          }
        : undefined,
      group,
      turnAdoptionLifecycle: durable.turnAdoptionLifecycle,
      readReceipt: durable.readReceipt,
      receiveOrder: durable.receiveOrder,
    });
    const debounceKey = buildInboundDebounceKey(inboundMessage);
    if (debounceKey) {
      inboundMessage.debounceKey = debounceKey;
      if (inboundDebounceMs > 0 && shouldDebounceInboundMessage(inboundMessage)) {
        inboundMessage.debounceKeyTracked = true;
        trackPendingDebounceKey(debounceKey);
        publishPendingWorkState();
        notifyDebounceWork();
      }
    }
    if (inboundMessage.event.id) {
      const admission = requireWhatsAppInboundAdmission(inboundMessage);
      cacheInboundMessageMeta(
        admission.accountId,
        inboundMessage.platform.chatJid,
        inboundMessage.event.id,
        {
          participant: inboundMessage.platform.senderJid,
          participantE164:
            admission.conversation.kind === "direct"
              ? inboundMessage.platform.senderE164
              : undefined,
          body: inboundMessage.payload.body,
          media: enriched.nativeMedia,
          fromMe: inboundMessage.platform.fromMe,
        },
      );
    }
    await debouncer.enqueue(inboundMessage);
  };

  const processDurableInboundMessage = async (
    admission: WhatsAppIngressAdmission,
    lifecycle: WhatsAppIngressLifecycle,
  ): Promise<"completed" | "deferred"> => {
    const { message: msg, ...context } = admission;
    rememberBaileysMessage(msg.key?.remoteJid, msg.key?.id, msg.message);
    const remoteJid = msg.key?.remoteJid;
    const id = msg.key?.id;
    const durableId =
      remoteJid && id
        ? createHash("sha256").update(`${remoteJid}\n${id}`).digest("hex")
        : undefined;
    const preparation = durableId ? preparedInboundByDurableId.get(durableId) : undefined;
    if (durableId) {
      preparedInboundByDurableId.delete(durableId);
    }
    if (context.skipRecentOutboundEcho === true) {
      return "completed";
    }
    const prepared = await preparation;
    if (prepared === null) {
      return "completed";
    }
    const inbound = prepared ?? (await normalizeInboundMessage(msg));
    if (!inbound) {
      return "completed";
    }
    if (
      await maybeResolveWhatsAppQuestionReaction({
        cfg: options.loadConfig?.() ?? options.cfg,
        accountId: options.accountId,
        msg,
        senderId: inbound.senderE164 ?? inbound.from,
        resolveReactionTargetJids,
        logDebug: (message) => logWhatsAppVerbose(options.verbose, message),
      })
    ) {
      return "completed";
    }
    const readReceipt = buildReadReceiptTarget(inbound);
    const deliveryReadReceipt = inbound.access.isSelfChat ? undefined : readReceipt;
    if (context.skipStaleAppend === true) {
      await maybeMarkNonSelfChatReadReceipt(inbound, readReceipt);
      return "completed";
    }

    const enriched = await enrichInboundMessage(msg);
    if (!enriched) {
      await maybeMarkNonSelfChatReadReceipt(inbound, deliveryReadReceipt);
      return "completed";
    }

    recordAcceptedInboundActivity(options.accountId);
    await enqueueInboundMessage(msg, inbound, enriched, {
      readReceipt: deliveryReadReceipt,
      receiveOrder: context.receiveOrder ?? context.receivedAt,
      turnAdoptionLifecycle: lifecycle,
    });
    return "deferred";
  };

  const durableInboundMonitor = createWhatsAppIngressMonitor({
    queue: durableInboundQueue,
    dispatch: async (admission, lifecycle) => ({
      kind: await processDurableInboundMessage(admission, lifecycle),
    }),
    pollIntervalMs: WHATSAPP_INGRESS_DRAIN_INTERVAL_MS,
    onLog: (message) => inboundLogger.warn({ message }, "whatsapp ingress drain"),
    onError: (error) =>
      inboundLogger.error({ error: formatError(error) }, "whatsapp durable inbound drain failed"),
    onActivityChange: (active) => {
      durableIngressActive = active;
      publishPendingWorkState();
    },
  });

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      rememberBaileysMessage(msg.key?.remoteJid, msg.key?.id, msg.message);

      const receiveOrder = nextReceiveOrder++;
      if (
        await maybeResolveWhatsAppApprovalReaction({
          cfg: options.loadConfig?.() ?? options.cfg,
          accountId: options.accountId,
          msg,
          selfJid: self.jid,
          selfLid: self.lid,
          resolveInboundJid,
          resolveReactionTargetJids,
          logVerboseMessage: (message) => logWhatsAppVerbose(options.verbose, message),
        })
      ) {
        continue;
      }

      const receivedAt = Date.now();
      const skipStaleAppend = shouldSkipStaleAppend(msg, upsert.type);
      const skipRecentOutboundEcho = shouldSkipRecentOutboundEcho(msg);
      const remoteJid = msg.key?.remoteJid;
      const id = msg.key?.id;
      const durableId =
        remoteJid && id
          ? createHash("sha256").update(`${remoteJid}\n${id}`).digest("hex")
          : undefined;
      let resolvePrepared: ((inbound: PreparedInbound | null | undefined) => void) | undefined;
      // A redelivery must not replace the first accepted delivery's preparation.
      if (durableId && !preparedInboundByDurableId.has(durableId)) {
        if (preparedInboundByDurableId.size >= 1000) {
          const oldest = preparedInboundByDurableId.keys().next().value;
          if (oldest !== undefined) {
            preparedInboundByDurableId.delete(oldest);
          }
        }
        preparedInboundByDurableId.set(
          durableId,
          new Promise((resolve) => {
            resolvePrepared = resolve;
          }),
        );
      }
      const finishPreparation = (
        inbound: PreparedInbound | null | undefined,
        keepForDrain = false,
      ) => {
        resolvePrepared?.(inbound);
        if (!keepForDrain && durableId && resolvePrepared) {
          preparedInboundByDurableId.delete(durableId);
        }
      };
      let result: Awaited<ReturnType<typeof durableInboundMonitor.admit>>;
      try {
        // Shared admission owns the serialized [0, 100, 300] append retries and
        // returns the atomic accepted/pending/completed queue verdict.
        result = await durableInboundMonitor.admit(
          {
            message: msg,
            upsertType: upsert.type,
            skipStaleAppend,
            skipRecentOutboundEcho,
            receivedAt,
            receiveOrder,
          },
          { receivedAt },
        );
      } catch (error) {
        finishPreparation(undefined);
        const formattedError = formatError(error);
        inboundLogger.error(
          { error: formattedError },
          "failed persisting durable WhatsApp inbound after retries; message dropped",
        );
        inboundConsoleLog.error(
          `Failed persisting durable WhatsApp inbound after retries; message dropped: ${formattedError}`,
        );
        continue;
      }
      if (result.kind === "durable" && result.queueResult.kind === "completed") {
        finishPreparation(undefined);
        const inbound = await normalizeInboundMessage(msg);
        if (inbound) {
          await maybeMarkNonSelfChatReadReceipt(inbound, buildReadReceiptTarget(inbound));
        }
      } else if (result.kind === "durable" && result.queueResult.kind === "accepted") {
        if (skipRecentOutboundEcho) {
          finishPreparation(null);
        } else {
          try {
            finishPreparation(await normalizeInboundMessage(msg), true);
          } catch (error) {
            finishPreparation(undefined);
            inboundLogger.warn(
              { error: formatError(error) },
              "failed preparing WhatsApp inbound identity; durable drain will normalize again",
            );
          }
        }
      } else {
        // Pending redelivery leaves the first accepted delivery's preparation in place.
        finishPreparation(undefined);
      }
    }
  };
  const handleMessagesUpsertEvent = (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    const task = handleMessagesUpsert(upsert).catch((err: unknown) => {
      inboundLogger.error({ error: String(err) }, "messages.upsert handler error");
      inboundConsoleLog.error(`Messages upsert handler error: ${String(err)}`);
    });
    pendingMessageHandlers.add(task);
    publishPendingWorkState();
    void task.finally(() => {
      pendingMessageHandlers.delete(task);
      publishPendingWorkState();
    });
  };
  const drainDebouncedInboundMessages = async () => {
    while (pendingDebounceKeys.size > 0 || activeInboundFlushes.size > 0) {
      const debounceKeys = Array.from(pendingDebounceKeys.keys());
      if (debounceKeys.length > 0) {
        await Promise.all(debounceKeys.map((key) => debouncer.flushKey(key)));
      }

      await debouncer.drain();

      await Promise.resolve();
    }
  };
  const drainInboundBeforeSocketClose = async () => {
    // Interleave force-flush with event-driven wait for drain dispatch so close
    // cannot deadlock inside the debounce window. Debounce semantics stay intact.
    for (;;) {
      await drainDebouncedInboundMessages();
      if (pendingMessageHandlers.size === 0) {
        break;
      }
      const handlers = Array.from(pendingMessageHandlers);
      await Promise.race([Promise.allSettled(handlers), waitForDebounceWorkOrIdle(handlers)]);
      if (
        pendingMessageHandlers.size === 0 &&
        pendingDebounceKeys.size === 0 &&
        activeInboundFlushes.size === 0
      ) {
        break;
      }
    }
    await drainDebouncedInboundMessages();
    // A flush can adopt one claim and wake the next row in the same lane.
    // Alternate until neither the monitor nor debounce layer can create more work.
    for (;;) {
      await durableInboundMonitor.waitForIdle();
      if (pendingDebounceKeys.size === 0 && activeInboundFlushes.size === 0) {
        break;
      }
      await drainDebouncedInboundMessages();
    }
    await durableInboundMonitor.stop();
  };
  const drainInboundBeforeSocketCloseWithTimeout = async () => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        drainInboundBeforeSocketClose(),
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Timed out draining WhatsApp inbound debounce after ${INBOUND_CLOSE_DRAIN_TIMEOUT_MS}ms`,
              ),
            );
          }, INBOUND_CLOSE_DRAIN_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      // Start abort/dispose even when channel work ignored the graceful bound;
      // a successor must not share this account queue with a live owner.
      void durableInboundMonitor.stop();
    }
  };
  let detachMessagesUpsert: (() => void) | undefined;
  const start = () => {
    if (detachMessagesUpsert) {
      return;
    }
    detachMessagesUpsert = socketSession.listen(
      "messages.upsert",
      handleMessagesUpsertEvent as unknown as (...args: unknown[]) => void,
    );
    durableInboundMonitor.start();
  };
  const stopIntake = () => {
    detachMessagesUpsert?.();
    detachMessagesUpsert = undefined;
  };

  return {
    start,
    stopIntake,
    drain: drainInboundBeforeSocketCloseWithTimeout,
  } as const;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
