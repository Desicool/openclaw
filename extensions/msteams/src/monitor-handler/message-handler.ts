// Msteams plugin module implements message handler behavior.
import {
  buildChannelInboundEventContext,
  createChannelInboundEnvelopeBuilder,
  formatMediaPlaceholderText,
  resolveInboundMentionDecision,
  resolveInboundSupplementalSenderAllowed,
  toInboundMediaFactsWithMetadata,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  hasFinalInboundReplyDispatch,
  resolveInboundReplyDispatchCounts,
} from "openclaw/plugin-sdk/channel-inbound";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  createChannelHistoryWindow,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { sliceUtf16Safe, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatUnknownError } from "../errors.js";
import { normalizeMSTeamsConversationId, parseMSTeamsActivityTimestamp } from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import { resolveMSTeamsAllowlistMatch, resolveMSTeamsReplyPolicy } from "../policy.js";
import { extractMSTeamsPollVote } from "../polls.js";
import { createMSTeamsReplyDispatcher } from "../reply-dispatcher.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { recordMSTeamsSentMessage } from "../sent-message-cache.js";
import { admitMSTeamsMessage } from "./access.js";
import { prepareMSTeamsInboundContent } from "./inbound-content.js";
import {
  assembleMSTeamsInboundFacts,
  prepareMSTeamsDebounceEntry,
  type MSTeamsDebounceEntry,
} from "./inbound-facts.js";
import { prepareMSTeamsThreadRouting, resolveMSTeamsThreadContext } from "./thread-context.js";

export function createMSTeamsMessageHandler(deps: MSTeamsMessageHandlerDeps) {
  const {
    cfg,
    runtime,
    appId,
    app,
    tokenProvider,
    textLimit,
    mediaMaxBytes,
    conversationStore,
    pollStore,
    log,
  } = deps;
  const core = getMSTeamsRuntime();
  const logVerboseMessage = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      log.debug?.(message);
    }
  };
  const msteamsCfg = cfg.channels?.msteams;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "msteams",
  });
  const historyLimit = Math.max(
    0,
    msteamsCfg?.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const conversationHistories = new Map<string, HistoryEntry[]>();
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "msteams",
  });

  const handleTeamsMessageNow = async (params: MSTeamsDebounceEntry) => {
    const facts = assembleMSTeamsInboundFacts({ entry: params, mediaMaxBytes });
    const {
      context,
      activity,
      rawText,
      text,
      attachments,
      advertisedMedia,
      rawBody,
      quoteInfo,
      from,
      conversation,
      attachmentTypes,
      htmlSummary,
      conversationId,
      conversationMessageId,
      conversationType,
      isChannel,
      teamId,
      graphChannelId,
      conversationRef,
    } = facts;
    const historyBody = [text, formatMediaPlaceholderText(advertisedMedia)]
      .filter(Boolean)
      .join("\n");
    log.info("received message", {
      rawText: truncateUtf16Safe(rawText, 50),
      text: truncateUtf16Safe(text, 50),
      attachments: attachments.length,
      attachmentTypes,
      from: from?.id,
      conversation: conversation?.id,
    });
    if (htmlSummary) {
      log.debug?.("html attachment summary", htmlSummary);
    }

    if (!from?.id) {
      log.debug?.("skipping message without from.id");
      return;
    }

    const admission = await admitMSTeamsMessage({
      cfg,
      activity,
      text,
      conversationId,
      conversationRef,
      isChannel,
      conversationStore,
      log,
      logVerboseMessage,
    });
    if (!admission) {
      return;
    }
    const {
      senderId,
      senderName,
      isDirectMessage,
      channelGate,
      allowNameMatching,
      groupPolicy,
      commandAuthorized,
      effectiveGroupAllowFrom,
      allowTextCommands,
      isControlCommand,
    } = admission;

    const pollVote = extractMSTeamsPollVote(activity);
    if (pollVote) {
      try {
        const poll = await pollStore.recordVote({
          pollId: pollVote.pollId,
          voterId: senderId,
          selections: pollVote.selections,
        });
        if (!poll) {
          log.debug?.("poll vote ignored (poll not found)", {
            pollId: pollVote.pollId,
          });
        } else {
          log.info("recorded poll vote", {
            pollId: pollVote.pollId,
            voter: senderId,
            selections: pollVote.selections,
          });
        }
      } catch (err) {
        log.error("failed to record poll vote", {
          pollId: pollVote.pollId,
          error: formatUnknownError(err),
        });
      }
      return;
    }

    const teamsFrom = isDirectMessage
      ? `msteams:${senderId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`;
    const teamsTo = isDirectMessage ? `user:${senderId}` : `conversation:${conversationId}`;

    const threadRouting = prepareMSTeamsThreadRouting({
      cfg,
      context,
      isDirectMessage,
      isChannel,
      senderId,
      conversationId,
      conversationMessageId: conversationMessageId ?? undefined,
      teamId,
      log,
    });
    const { route, deadline: preprocessingDeadline } = threadRouting;

    const preview = sliceUtf16Safe(rawBody.replace(/\s+/g, " "), 0, 160);
    const inboundLabel = isDirectMessage
      ? `Teams DM from ${senderName}`
      : `Teams message in ${conversationType} from ${senderName}`;

    const enqueuePrimaryMessageSystemEvent = () =>
      core.system.enqueueSystemEvent(inboundLabel, {
        sessionKey: route.sessionKey,
        contextKey: `msteams:message:${conversationId}:${activity.id ?? "unknown"}`,
      });

    const channelId = conversationId;
    const { teamConfig, channelConfig } = channelGate;
    const { requireMention, replyStyle } = resolveMSTeamsReplyPolicy({
      isDirectMessage,
      globalConfig: msteamsCfg,
      teamConfig,
      channelConfig,
    });
    const timestamp = parseMSTeamsActivityTimestamp(activity.timestamp);
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: params.wasMentioned,
        implicitMentionKinds: params.implicitMentionKinds,
      },
      policy: {
        isGroup: !isDirectMessage,
        requireMention,
        allowTextCommands,
        hasControlCommand: isControlCommand,
        commandAuthorized: commandAuthorized === true,
      },
    });

    if (!isDirectMessage) {
      const mentioned = mentionDecision.effectiveWasMentioned;
      if (requireMention && mentionDecision.shouldSkip) {
        log.debug?.("skipping message (mention required)", {
          teamId,
          channelId,
          requireMention,
          mentioned,
        });
        if (historyBody) {
          enqueuePrimaryMessageSystemEvent();
          createChannelHistoryWindow({ historyMap: conversationHistories }).record({
            historyKey: conversationId,
            limit: historyLimit,
            entry: {
              sender: senderName,
              body: historyBody,
              timestamp: timestamp?.getTime(),
              messageId: activity.id ?? undefined,
            },
          });
        }
        return;
      }
    }
    const content = await prepareMSTeamsInboundContent({
      entry: params,
      rawBody,
      advertisedMedia,
      htmlSummary: htmlSummary ?? undefined,
      conversationType,
      conversationId,
      conversationMessageId: conversationMessageId ?? undefined,
      teamAadGroupId: threadRouting.getTeamAadGroupId(),
      resolveTeamAadGroupId: threadRouting.resolveTeamAadGroupId,
      mediaMaxBytes,
      tokenProvider,
      mediaAllowHosts: msteamsCfg?.mediaAllowHosts,
      mediaAuthAllowHosts: msteamsCfg?.mediaAuthAllowHosts,
      graphMediaFallback: msteamsCfg?.graphMediaFallback,
      deadline: preprocessingDeadline,
      log,
    });
    if (!content) {
      return;
    }
    const { agentBody, inboundMedia } = content;
    enqueuePrimaryMessageSystemEvent();

    const { teamAadGroupId, quoteBodyFull, quoteSenderId, quoteSenderName, threadContext } =
      await resolveMSTeamsThreadContext({
        routing: threadRouting,
        context,
        tokenProvider,
        quoteInfo,
        isDirectMessage,
        isChannel,
        conversationId,
        contextVisibilityMode,
        groupPolicy,
        effectiveGroupAllowFrom,
        allowNameMatching,
        log,
      });

    const envelopeFrom = isDirectMessage ? senderName : conversationType;
    const buildEnvelope = createChannelInboundEnvelopeBuilder({ cfg, route });
    const body = buildEnvelope({
      channel: "Teams",
      from: envelopeFrom,
      timestamp,
      body: agentBody,
    });
    let combinedBody = body;
    const isRoomish = !isDirectMessage;
    const historyKey = isRoomish ? conversationId : undefined;
    if (isRoomish && historyKey) {
      const channelHistory = createChannelHistoryWindow({ historyMap: conversationHistories });
      combinedBody = channelHistory.buildPendingContext({
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          buildEnvelope({
            channel: "Teams",
            from: conversationType,
            timestamp: entry.timestamp,
            previousTimestamp: null,
            body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
          }),
      });
    }

    const inboundHistory =
      isRoomish && historyKey && historyLimit > 0
        ? createChannelHistoryWindow({ historyMap: conversationHistories }).buildInboundHistory({
            historyKey,
            limit: historyLimit,
          })
        : undefined;
    const commandBody = text.trim();
    const quoteSenderAllowed =
      quoteInfo && quoteInfo.sender
        ? resolveInboundSupplementalSenderAllowed({
            isGroup: !isDirectMessage,
            groupPolicy,
            allowFrom: effectiveGroupAllowFrom,
            isSenderAllowed: (allowFrom) =>
              resolveMSTeamsAllowlistMatch({
                allowFrom,
                senderId: quoteSenderId ?? "",
                senderName: quoteSenderName,
                allowNameMatching,
              }).allowed,
          })
        : true;
    // Prepend thread history to the agent body so the agent has full thread context.
    const bodyForAgent = threadContext
      ? `[Thread history]\n${threadContext}\n[/Thread history]\n\n${agentBody}`
      : agentBody;

    // For Teams *channel* messages (not group chats / DMs), preserve the
    // `aadGroupId/channelId` pair on NativeChannelId so downstream action handlers
    // can route through `/teams/{aadGroupId}/channels/{channelId}` via Graph API.
    // The bare conversation id (`19:...@thread.tacv2`) is insufficient on its
    // own because channel Graph endpoints require the owning team id too.
    const nativeChannelId =
      isChannel && teamAadGroupId ? `${teamAadGroupId}/${graphChannelId}` : undefined;
    const ctxPayload = buildChannelInboundEventContext({
      channel: "msteams",
      contextVisibility: contextVisibilityMode,
      supplemental: {
        quote: quoteInfo
          ? {
              id: quoteInfo.id ?? activity.replyToId ?? undefined,
              body: quoteBodyFull ?? quoteInfo.body,
              sender: quoteInfo.sender,
              senderAllowed: quoteSenderAllowed,
              isQuote: true,
            }
          : undefined,
      },
      media: await toInboundMediaFactsWithMetadata(inboundMedia),
      messageId: activity.id,
      timestamp: timestamp?.getTime() ?? Date.now(),
      from: teamsFrom,
      sender: {
        id: senderId,
        name: senderName,
      },
      conversation: {
        kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
        id: conversationId,
        label: envelopeFrom,
        spaceId: teamId,
        nativeChannelId,
      },
      route: {
        agentId: route.agentId,
        dmScope: route.dmScope,
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
      },
      reply: {
        to: teamsTo,
        replyToId: activity.replyToId ?? undefined,
        nativeChannelId,
      },
      message: {
        body: combinedBody,
        bodyForAgent,
        inboundHistory,
        rawBody,
        commandBody,
      },
      sessionTranscript: { historyLimit: isRoomish ? historyLimit : 0 },
      access: {
        mentions: {
          canDetectMention: !isDirectMessage,
          wasMentioned: isDirectMessage || mentionDecision.effectiveWasMentioned,
        },
        commands: {
          authorized: commandAuthorized === true,
        },
      },
      extra: {
        GroupSubject: !isDirectMessage ? conversationType : undefined,
        ReplyToIsQuote: quoteInfo ? true : undefined,
      },
    });

    logVerboseMessage(`msteams inbound: from=${ctxPayload.From} preview="${preview}"`);

    const sharePointSiteId = msteamsCfg?.sharePointSiteId;
    const { dispatcherOptions, delivery, replyOptions } = createMSTeamsReplyDispatcher({
      cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      accountId: route.accountId,
      runtime,
      log,
      app,
      appId,
      conversationRef,
      context,
      replyStyle,
      textLimit,
      onSentMessageIds: (ids) => {
        for (const id of ids) {
          recordMSTeamsSentMessage(conversationId, id);
        }
      },
      tokenProvider,
      sharePointSiteId,
    });

    // Use Teams clientInfo timezone if no explicit userTimezone is configured.
    // This ensures the agent knows the sender's timezone for time-aware responses
    // and proactive sends within the same session.
    const activityClientInfo = activity.entities?.find((e) => e.type === "clientInfo") as
      | { timezone?: string }
      | undefined;
    const senderTimezone = activityClientInfo?.timezone || conversationRef.timezone;
    const turnConfig =
      senderTimezone && !cfg.agents?.defaults?.userTimezone
        ? {
            ...cfg,
            agents: {
              ...cfg.agents,
              defaults: { ...cfg.agents?.defaults, userTimezone: senderTimezone },
            },
          }
        : cfg;
    log.info("dispatching to agent", { sessionKey: route.sessionKey });
    try {
      const turnResult = await core.channel.inbound.run({
        channel: "msteams",
        accountId: route.accountId,
        raw: context,
        adapter: {
          ingest: () => ({
            id: activity.id ?? `${teamsFrom}:${Date.now()}`,
            timestamp: timestamp?.getTime(),
            rawText: rawBody,
            textForAgent: bodyForAgent,
            textForCommands: commandBody,
            raw: activity,
          }),
          resolveTurn: () => ({
            cfg: turnConfig,
            channel: "msteams",
            accountId: route.accountId,
            route: { agentId: route.agentId, sessionKey: route.sessionKey },
            ctxPayload,
            record: {
              onRecordError: (err) => {
                logVerboseMessage(
                  `msteams: failed updating session meta: ${formatUnknownError(err)}`,
                );
              },
            },
            history: {
              isGroup: isRoomish,
              historyKey,
              historyMap: conversationHistories,
              limit: historyLimit,
            },
            dispatcherOptions,
            delivery,
            replyOptions: {
              ...replyOptions,
              ...(params.turnAdoptionLifecycle
                ? bindIngressLifecycleToReplyOptions(params.turnAdoptionLifecycle)
                : {}),
            },
          }),
        },
      });
      const dispatchResult = turnResult.dispatched ? turnResult.dispatchResult : undefined;
      const queuedFinal = dispatchResult?.queuedFinal ?? false;
      const counts = resolveInboundReplyDispatchCounts(dispatchResult);
      const hasFinalResponse = hasFinalInboundReplyDispatch(dispatchResult);

      log.info("dispatch complete", { queuedFinal, counts });

      if (!hasFinalResponse) {
        return;
      }
      const finalCount = counts.final;
      logVerboseMessage(
        `msteams: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${teamsTo}`,
      );
    } catch (err) {
      log.error("dispatch failed", { error: formatUnknownError(err) });
      runtime.error(`msteams dispatch failed: ${formatUnknownError(err)}`);
      if (params.turnAdoptionLifecycle) {
        throw err;
      }
      try {
        await context.sendActivity("⚠️ Something went wrong. Please try again.");
      } catch {
        // Best effort.
      }
    }
  };

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<MSTeamsDebounceEntry>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const conversationId = normalizeMSTeamsConversationId(
        entry.context.activity.conversation?.id ?? "",
      );
      const senderId =
        entry.context.activity.from?.aadObjectId ?? entry.context.activity.from?.id ?? "";
      if (!senderId || !conversationId) {
        return null;
      }
      return `msteams:${appId}:${conversationId}:${senderId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.text.trim()) {
        return false;
      }
      if (entry.attachments.length > 0) {
        return false;
      }
      return !core.channel.commands.isControlCommandMessage(entry.text, cfg);
    },
    onFlush: (entries, createFlush) => {
      const last = entries.at(-1);
      const { lifecycle, settle } = fanInChannelIngressLifecycles(
        entries.map((entry) => entry.turnAdoptionLifecycle),
      );
      return createFlush({
        lifecycle,
        dispatch: async (admissionLifecycle) => {
          if (!last) {
            return;
          }
          try {
            if (entries.length === 1) {
              await handleTeamsMessageNow({ ...last, turnAdoptionLifecycle: admissionLifecycle });
            } else {
              const combinedText = entries
                .map((entry) => entry.text)
                .filter(Boolean)
                .join("\n");
              if (combinedText.trim()) {
                const combinedRawText = entries
                  .map((entry) => entry.rawText)
                  .filter(Boolean)
                  .join("\n");
                const wasMentioned = entries.some((entry) => entry.wasMentioned);
                const implicitMentionKinds = entries.flatMap((entry) => entry.implicitMentionKinds);
                await handleTeamsMessageNow({
                  context: last.context,
                  rawText: combinedRawText,
                  text: combinedText,
                  attachments: [],
                  wasMentioned,
                  implicitMentionKinds,
                  turnAdoptionLifecycle: admissionLifecycle,
                });
              }
            }
            await settle();
          } catch (err) {
            await admissionLifecycle.onAbandoned();
            throw err;
          }
        },
      });
    },
    onError: (err) => {
      runtime.error(`msteams debounce flush failed: ${formatUnknownError(err)}`);
    },
  });

  return async function handleTeamsMessage(
    context: MSTeamsTurnContext,
    turnAdoptionLifecycle?: MSTeamsIngressLifecycle,
  ) {
    const entry = await prepareMSTeamsDebounceEntry({
      context,
      turnAdoptionLifecycle,
    });
    await inboundDebouncer.enqueue(entry);
    if (turnAdoptionLifecycle) {
      // Keep the durable claim held across the debounce window. The merged
      // flush completes it only when the reply lane adopts (or terminally skips).
      return { kind: "deferred" } as const;
    }
    return undefined;
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
