/**
 * Detects whether a ClickClack group message contains a direct mention of the
 * current account.
 *
 * Pure helper – no side effects, no runtime imports.
 */

import {
  buildMentionRegexes,
  normalizeMentionText,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type ClickClackMentionFacts = {
  canDetectMention: boolean;
  wasMentioned: boolean;
  hasAnyMention?: boolean;
};

function buildLocalMentionRegexes(params: {
  cfg?: OpenClawConfig;
  mentionPatterns: string[];
  channelId?: string;
}): RegExp[] {
  if (params.mentionPatterns.length === 0) {
    return [];
  }
  const cfg = params.cfg;
  const syntheticCfg = {
    ...(cfg ?? {}),
    messages: {
      ...(cfg?.messages ?? {}),
      groupChat: {
        ...(cfg?.messages?.groupChat ?? {}),
        mentionPatterns: params.mentionPatterns,
      },
    },
  } as OpenClawConfig;
  return buildMentionRegexes(syntheticCfg, undefined, {
    provider: "clickclack",
    conversationId: params.channelId,
  });
}

function resolveNativeMentionIds(body: string): string[] {
  return [...body.matchAll(/<@([^>\\s]+)>/gi)]
    .map((match) => match[1]?.toLowerCase())
    .filter((id): id is string => Boolean(id));
}

/**
 * Builds mention facts for a ClickClack message.
 *
 * Rules:
 * - DMs always have canDetectMention: false, wasMentioned: false
 *   (DMs bypass mention gating).
 * - Group messages: canDetectMention: true when body text is available.
 * - Checks the message body against shared and account-local mention patterns.
 * - If botUserId is provided and the message body contains the native
 *   ClickClack user mention syntax (<@user_id>), treat it as a mention.
 * - Plain display names do not count unless explicitly configured as a pattern.
 */
export function resolveClickClackMentionFacts(params: {
  isDirect: boolean;
  body?: string;
  mentionPatterns: string[];
  botUserId?: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  channelId?: string;
}): ClickClackMentionFacts {
  const { isDirect, body, mentionPatterns, botUserId, cfg, agentId, channelId } = params;

  if (isDirect) {
    return {
      canDetectMention: false,
      wasMentioned: false,
    };
  }

  if (!body) {
    return {
      canDetectMention: true,
      wasMentioned: false,
      hasAnyMention: false,
    };
  }

  const sharedMentionRegexes = buildMentionRegexes(cfg, agentId, {
    provider: "clickclack",
    conversationId: channelId,
  });
  const localMentionRegexes = buildLocalMentionRegexes({
    cfg,
    mentionPatterns,
    channelId,
  });
  const mentionRegexes = [...sharedMentionRegexes, ...localMentionRegexes];
  const bodyForRegex = normalizeMentionText(body);
  const hasConfiguredMention = mentionRegexes.some((regex) => regex.test(bodyForRegex));

  const nativeMentionIds = resolveNativeMentionIds(body);
  const botId = botUserId?.toLowerCase();
  const hasNativeMention = botId ? nativeMentionIds.includes(botId) : false;
  const hasAnyNativeMention = nativeMentionIds.length > 0;
  const wasMentioned = hasNativeMention || hasConfiguredMention;

  return {
    canDetectMention: true,
    wasMentioned,
    hasAnyMention: hasAnyNativeMention || hasConfiguredMention,
  };
}
