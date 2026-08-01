import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  excludeComposerAttachments,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  captureChatComposerMemoryFallbackOwnership,
  clearChatComposerMemoryFallback,
  ownsChatComposerMemoryFallback,
  retainChatComposerMemoryFallback,
  type ChatComposerMemoryFallbackOwnership,
} from "./chat-state-route.ts";
import type { StoredChatOutboxScope } from "./composer-persistence.ts";

export type ChatCommandComposerRecovery = {
  attachments: ChatAttachment[];
  client: ChatHost["client"];
  connectionEpoch: ChatHost["connectionEpoch"];
  draft: string;
  fallbackOwnership?: ChatComposerMemoryFallbackOwnership;
  scope: StoredChatOutboxScope;
};

function chatCommandRecoveryHost(host: ChatHost): ChatPageHost | undefined {
  return "chatComposerFallbackByScope" in host &&
    typeof host.chatComposerFallbackByScope === "object" &&
    host.chatComposerFallbackByScope !== null
    ? (host as ChatPageHost)
    : undefined;
}

export function captureChatCommandComposerRecovery(
  host: ChatHost,
  scope: StoredChatOutboxScope,
  draft: string,
  attachments: ChatAttachment[],
): ChatCommandComposerRecovery {
  const fallbackHost = chatCommandRecoveryHost(host);
  return {
    attachments,
    client: host.client,
    connectionEpoch: host.connectionEpoch,
    draft,
    ...(fallbackHost
      ? {
          fallbackOwnership: captureChatComposerMemoryFallbackOwnership(fallbackHost, scope, {
            message: draft,
            attachments,
          }),
        }
      : {}),
    scope,
  };
}

export function submittedCommandConnectionIsCurrent(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  return host.client === recovery.client && host.connectionEpoch === recovery.connectionEpoch;
}

export function submittedCommandScopeIsVisible(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  return (
    submittedCommandConnectionIsCurrent(host, recovery) &&
    visibleSessionMatches(host, recovery.scope.sessionKey, recovery.scope.agentId)
  );
}

export function clearOwnedCommandComposerFallback(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  const fallbackHost = chatCommandRecoveryHost(host);
  return fallbackHost
    ? clearChatComposerMemoryFallback(fallbackHost, recovery.fallbackOwnership)
    : false;
}

export function commandComposerFallbackRetainsAttachments(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  const fallbackHost = chatCommandRecoveryHost(host);
  return Boolean(
    recovery.fallbackOwnership &&
    fallbackHost &&
    ownsChatComposerMemoryFallback(fallbackHost, recovery.fallbackOwnership),
  );
}

export function restoreFailedCommandComposer(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  const fallbackHost = chatCommandRecoveryHost(host);
  if (!submittedCommandConnectionIsCurrent(host, recovery)) {
    return (
      recovery.attachments.length === 0 || commandComposerFallbackRetainsAttachments(host, recovery)
    );
  }
  if (!submittedCommandScopeIsVisible(host, recovery)) {
    if (!fallbackHost) {
      return recovery.attachments.length === 0;
    }
    const ownership = retainChatComposerMemoryFallback(fallbackHost, recovery.scope, {
      message: recovery.draft,
      attachments: recovery.attachments,
    });
    recovery.fallbackOwnership = ownership;
    return recovery.attachments.length === 0 || ownership !== undefined;
  }
  const restorePlan = pendingComposerRestorePlan(host, {
    previousAttachments: recovery.attachments,
    previousDraft: recovery.draft,
  });
  if (restorePlan.willRestoreDraft) {
    host.chatMessage = recovery.draft;
  }
  if (restorePlan.willRestoreAttachments) {
    host.chatAttachments = recovery.attachments;
  }
  const retained = recovery.attachments.length === 0 || restorePlan.willRestoreAttachments;
  if (!restorePlan.complete) {
    clearOwnedCommandComposerFallback(host, recovery);
  }
  return retained;
}

export function restoreComposerAfterFailedSend(
  host: ChatHost,
  opts: {
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
  },
) {
  if (opts.previousDraft != null && !host.chatMessage.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (opts.previousAttachments?.length && host.chatAttachments.length === 0) {
    host.chatAttachments = opts.previousAttachments;
  }
}

type PendingComposerSnapshot = {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
};

export function pendingComposerRestorePlan(host: ChatHost, snapshot: PendingComposerSnapshot) {
  const willRestoreDraft = snapshot.previousDraft != null && !host.chatMessage.trim();
  const willRestoreAttachments = Boolean(
    snapshot.previousAttachments?.length &&
    host.chatAttachments.length === 0 &&
    (willRestoreDraft || !host.chatMessage.trim()),
  );
  return {
    complete:
      (!snapshot.previousDraft?.trim() || willRestoreDraft) &&
      (!snapshot.previousAttachments?.length || willRestoreAttachments),
    willRestoreAttachments,
    willRestoreDraft,
  };
}

export function cancelPendingSendBeforeRequest(
  host: ChatHost,
  queued: ChatQueueItem,
  opts: PendingComposerSnapshot & {
    restoreComposer?: boolean;
  },
) {
  const removed = removeVisibleOrScopedQueuedMessageWithoutReleasing(
    host,
    queued.id,
    queued.sessionKey,
  );
  const restoreComposer = opts.restoreComposer !== false && removed != null;
  const restorePlan = pendingComposerRestorePlan(host, opts);
  const willRestoreDraft = restoreComposer && restorePlan.willRestoreDraft;
  const willRestoreAttachments = restoreComposer && restorePlan.willRestoreAttachments;
  if (restoreComposer) {
    if (willRestoreDraft) {
      host.chatMessage = opts.previousDraft ?? "";
    }
    if (willRestoreAttachments) {
      host.chatAttachments = opts.previousAttachments ?? [];
    }
  }
  if (removed && !willRestoreAttachments) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
}
