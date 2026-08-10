import type { ChatAttachment } from "../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayloads } from "../pages/chat/attachment-payload-store.ts";
import type { ApplicationChatAttachmentHandoff } from "./context.ts";

const MAX_PENDING_CHAT_ATTACHMENT_ENTRIES = 32;
// Hidden split panes can remain unmounted indefinitely, so wall-clock expiry
// would lose valid drafts. Bounded oldest-first eviction owns abandoned cleanup.

type PendingChatAttachmentHandoff = {
  owner: NonNullable<Parameters<ApplicationChatAttachmentHandoff["prepare"]>[0]["owner"]>;
  scopeKey: string;
  attachments: ChatAttachment[];
};

export function createChatAttachmentHandoff(): ApplicationChatAttachmentHandoff {
  const pending = new Map<string, PendingChatAttachmentHandoff>();
  let disposed = false;

  const release = (attachments: readonly ChatAttachment[] = []) =>
    releaseChatAttachmentPayloads(attachments);
  const take = (paneId: string) => {
    const handoff = pending.get(paneId);
    if (handoff) {
      pending.delete(paneId);
    }
    return handoff;
  };

  return {
    prepare: ({ owner, paneId, scopeKey, attachments }) => {
      const previous = take(paneId);
      if (attachments.length === 0) {
        release(previous?.attachments);
        return;
      }
      const retainedIds = new Set(attachments.map((attachment) => attachment.id));
      release(previous?.attachments.filter((attachment) => !retainedIds.has(attachment.id)));
      if (!owner || disposed) {
        release(attachments);
        return;
      }
      pending.set(paneId, { owner, scopeKey, attachments: [...attachments] });
      // Route handoffs normally consume immediately. Bounds make abandoned
      // split panes release their packages instead of leaking for the tab lifetime.
      for (const oldestPaneId of pending.keys()) {
        if (pending.size <= MAX_PENDING_CHAT_ATTACHMENT_ENTRIES) {
          break;
        }
        release(take(oldestPaneId)?.attachments);
      }
    },
    consume: ({ owner, paneId, scopeKey }) => {
      const match = take(paneId);
      // Reusing a pane id with another session or Gateway is terminal for the
      // old owner; keeping it would allow a later remount to recover stale evidence.
      if (match?.owner === owner && match.scopeKey === scopeKey) {
        return match.attachments;
      }
      release(match?.attachments);
      return null;
    },
    clearPane: (paneId) => release(take(paneId)?.attachments),
    dispose: () => {
      disposed = true;
      for (const handoff of pending.values()) {
        release(handoff.attachments);
      }
      pending.clear();
    },
  };
}
