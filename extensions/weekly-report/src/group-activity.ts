/**
 * Group-message collection runner for the weekly-report drafting phase.
 *
 * Per the v3 plan (decisions 21-26):
 *  - Enumerate the agent's sessions via runtime.agent.session.listSessionEntries.
 *  - Filter for `:feishu:group:` sessions, drop stale, drop denylisted, optionally exclude
 *    topic-group sub-sessions (collapse-by-chatid deferred to v3.1).
 *  - Per-group: runtime.subagent.getSessionMessages, filter messages by time window, classify
 *    by reason (author / mention / thread) against the configured user open_id, optionally
 *    drop messages from the configured bot open_id.
 *  - Bounded parallelism, overall deadline, per-group failure isolation.
 *
 * Message-shape introspection: `getSessionMessages` returns `unknown[]`. We probe a handful of
 * common field names used by openclaw-lark's stored transcripts and degrade gracefully when
 * fields are missing.
 */

import type { WeeklyReportPluginSettings } from "./settings.js";

export type GroupMessageReason = "author" | "mention" | "thread";

export type GroupMessageRecord = {
  ts: number;
  senderOpenId: string;
  text: string;
  reason: GroupMessageReason;
  threadRootId?: string;
};

export type GroupActivityGroupResult =
  | {
      sessionKey: string;
      chatId?: string;
      ok: true;
      messages: GroupMessageRecord[];
      threadFilterAvailable: boolean;
    }
  | {
      sessionKey: string;
      chatId?: string;
      ok: false;
      error: string;
    };

export type GroupActivityResult = {
  windowStart: number;
  windowEnd: number;
  scannedGroups: number;
  skippedGroups: number;
  userOpenId: string | undefined;
  threadFilterAvailable: boolean;
  groups: GroupActivityGroupResult[];
};

export type SessionEntryLike = {
  updatedAt?: number;
  lastInteractionAt?: number;
  groupId?: string;
  chatType?: string;
};

export type SessionListItem = {
  sessionKey: string;
  entry: SessionEntryLike;
};

export type ListSessionEntriesFn = (params: { agentId: string }) => SessionListItem[];

export type GetSessionMessagesFn = (params: {
  sessionKey: string;
  limit?: number;
}) => Promise<{ messages: unknown[] }>;

export type RunGroupActivityParams = {
  settings: WeeklyReportPluginSettings;
  agentId: string;
  listSessionEntries: ListSessionEntriesFn;
  getSessionMessages: GetSessionMessagesFn;
  sinceTs?: number;
  untilTs?: number;
  includeReasons?: GroupMessageReason[];
  now?: () => number;
};

const SESSION_KEY_FEISHU_GROUP_RE = /:feishu:group:([^:]+)$/u;
const MS_PER_DAY = 86_400_000;

export function mondayMidnightUtcMs(refMs: number): number {
  const d = new Date(refMs);
  const day = d.getUTCDay();
  const isoDayIndex = day === 0 ? 7 : day;
  d.setUTCDate(d.getUTCDate() - (isoDayIndex - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function extractChatId(sessionKey: string): string | undefined {
  const m = SESSION_KEY_FEISHU_GROUP_RE.exec(sessionKey);
  return m?.[1];
}

function isDenylisted(sessionKey: string, denylist: string[]): boolean {
  if (denylist.length === 0) return false;
  if (denylist.includes(sessionKey)) return true;
  const chatId = extractChatId(sessionKey);
  if (chatId && denylist.includes(chatId)) return true;
  return false;
}

function isStale(entry: SessionEntryLike, nowMs: number, staleAfterDays: number): boolean {
  const lastActive = entry.lastInteractionAt ?? entry.updatedAt ?? 0;
  if (lastActive === 0) return false; // unknown activity → keep
  return nowMs - lastActive > staleAfterDays * MS_PER_DAY;
}

// ── message-shape introspection ─────────────────────────────────────

function readMessageTs(msg: Record<string, unknown>): number | undefined {
  if (typeof msg.ts === "number") return msg.ts;
  if (typeof msg.timestamp === "number") return msg.timestamp;
  if (typeof msg.created_time === "string") {
    const n = Number(msg.created_time);
    if (Number.isFinite(n)) return n;
  }
  if (typeof msg.createdAt === "number") return msg.createdAt;
  return undefined;
}

function readSenderOpenId(msg: Record<string, unknown>): string | undefined {
  if (typeof msg.senderOpenId === "string") return msg.senderOpenId;
  if (typeof msg.open_id === "string") return msg.open_id;
  const sender = msg.sender;
  if (typeof sender === "string") return sender;
  if (sender && typeof sender === "object") {
    const s = sender as Record<string, unknown>;
    if (typeof s.open_id === "string") return s.open_id;
    if (typeof s.openId === "string") return s.openId;
    const id = s.sender_id;
    if (id && typeof id === "object") {
      const inner = (id as Record<string, unknown>).open_id;
      if (typeof inner === "string") return inner;
    }
  }
  return undefined;
}

function readMentions(msg: Record<string, unknown>): string[] {
  const m = msg.mentions;
  if (!Array.isArray(m)) return [];
  const out: string[] = [];
  for (const entry of m) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      if (typeof e.open_id === "string") out.push(e.open_id);
      else if (typeof e.openId === "string") out.push(e.openId);
      else if (e.id && typeof e.id === "object") {
        const inner = (e.id as Record<string, unknown>).open_id;
        if (typeof inner === "string") out.push(inner);
      }
    }
  }
  return out;
}

function readThreadRootId(msg: Record<string, unknown>): string | undefined {
  if (typeof msg.thread_id === "string") return msg.thread_id;
  if (typeof msg.threadId === "string") return msg.threadId;
  if (typeof msg.root_id === "string") return msg.root_id;
  if (typeof msg.rootId === "string") return msg.rootId;
  if (typeof msg.parent_id === "string") return msg.parent_id;
  if (typeof msg.parentId === "string") return msg.parentId;
  return undefined;
}

function readMessageText(msg: Record<string, unknown>): string {
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.content === "string") return msg.content;
  if (msg.content && typeof msg.content === "object") {
    const c = msg.content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

type ProcessedMessage = {
  ts: number;
  senderOpenId: string;
  text: string;
  mentions: string[];
  threadRootId?: string;
};

function preprocessMessage(raw: unknown): ProcessedMessage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const msg = raw as Record<string, unknown>;
  const ts = readMessageTs(msg);
  const senderOpenId = readSenderOpenId(msg);
  if (ts === undefined || senderOpenId === undefined) return undefined;
  const processed: ProcessedMessage = {
    ts,
    senderOpenId,
    text: readMessageText(msg),
    mentions: readMentions(msg),
  };
  const root = readThreadRootId(msg);
  if (root) processed.threadRootId = root;
  return processed;
}

// ── public runner ──────────────────────────────────────────────────

export async function runGroupActivity(
  params: RunGroupActivityParams,
): Promise<GroupActivityResult> {
  const { settings, agentId, listSessionEntries, getSessionMessages } = params;
  const now = params.now ?? Date.now;
  const includeReasons = new Set(params.includeReasons ?? ["author", "mention", "thread"]);

  const nowMs = now();
  const sinceTs = params.sinceTs ?? mondayMidnightUtcMs(nowMs);
  const untilTs = params.untilTs ?? nowMs;

  const userOpenId = settings.userOpenId;
  if (!userOpenId) {
    return {
      windowStart: sinceTs,
      windowEnd: untilTs,
      scannedGroups: 0,
      skippedGroups: 0,
      userOpenId: undefined,
      threadFilterAvailable: false,
      groups: [
        {
          sessionKey: "(none)",
          ok: false,
          error:
            "userOpenId not configured and not derivable from recipientSessionKey. Set plugins.entries.weekly-report.userOpenId to your Feishu open_id (ou_...) to enable group-message collection.",
        },
      ],
    };
  }

  const allEntries = listSessionEntries({ agentId });
  const candidateGroups: SessionListItem[] = [];
  for (const item of allEntries) {
    if (!SESSION_KEY_FEISHU_GROUP_RE.test(item.sessionKey)) continue;
    if (isDenylisted(item.sessionKey, settings.groupDenylist)) continue;
    if (isStale(item.entry, nowMs, settings.groupStaleAfterDays)) continue;
    candidateGroups.push(item);
  }

  // topicGroups handling. "include" (default) keeps every topic sub-session as its own group.
  // "exclude" keeps only the first session per groupId (best-effort dedupe). "collapse-by-chatid"
  // is deferred to v3.1 — for now it behaves like "include" with a note in the result.
  let scanList = candidateGroups;
  if (settings.topicGroups === "exclude") {
    const seenGroupIds = new Set<string>();
    scanList = candidateGroups.filter((item) => {
      const gid = item.entry.groupId;
      if (!gid) return true;
      if (seenGroupIds.has(gid)) return false;
      seenGroupIds.add(gid);
      return true;
    });
  }

  if (scanList.length > settings.groupMaxGroupsScanned) {
    scanList = scanList.slice(0, settings.groupMaxGroupsScanned);
  }
  const skippedGroups = candidateGroups.length - scanList.length;

  const results: GroupActivityGroupResult[] = new Array(scanList.length);
  const parallelism = Math.max(1, Math.min(settings.groupMaxParallelOps, scanList.length));
  const overallDeadlineMs = nowMs + settings.groupOverallTimeoutMs;
  let cursor = 0;
  let aggregateThreadFilterAvailable = false;

  const worker = async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= scanList.length) return;
      const item = scanList[idx];
      const chatId = extractChatId(item.sessionKey);
      if (now() >= overallDeadlineMs) {
        const baseResult: GroupActivityGroupResult = {
          sessionKey: item.sessionKey,
          ok: false,
          error: "budget_exhausted",
        };
        if (chatId) baseResult.chatId = chatId;
        results[idx] = baseResult;
        continue;
      }
      try {
        const raw = await getSessionMessages({
          sessionKey: item.sessionKey,
          limit: settings.groupMaxMessagesPerGroup,
        });
        const processed: ProcessedMessage[] = [];
        for (const m of raw.messages ?? []) {
          const p = preprocessMessage(m);
          if (!p) continue;
          if (p.ts < sinceTs || p.ts > untilTs) continue;
          processed.push(p);
        }

        const userThreadRoots = new Set<string>();
        for (const p of processed) {
          if (p.senderOpenId === userOpenId && p.threadRootId) {
            userThreadRoots.add(p.threadRootId);
          }
        }
        const threadFilterAvailable = processed.some((p) => p.threadRootId !== undefined);
        if (threadFilterAvailable) aggregateThreadFilterAvailable = true;

        const messages: GroupMessageRecord[] = [];
        for (const p of processed) {
          if (settings.botOpenId && p.senderOpenId === settings.botOpenId) continue;
          let reason: GroupMessageReason | undefined;
          if (p.senderOpenId === userOpenId) {
            reason = "author";
          } else if (p.mentions.includes(userOpenId)) {
            reason = "mention";
          } else if (p.threadRootId !== undefined && userThreadRoots.has(p.threadRootId)) {
            reason = "thread";
          } else if (p.threadRootId !== undefined) {
            // partial-trace drop: thread metadata present but no user root match
            continue;
          }
          if (!reason) continue;
          if (!includeReasons.has(reason)) continue;
          const record: GroupMessageRecord = {
            ts: p.ts,
            senderOpenId: p.senderOpenId,
            text: p.text,
            reason,
          };
          if (p.threadRootId) record.threadRootId = p.threadRootId;
          messages.push(record);
        }

        const okResult: GroupActivityGroupResult = {
          sessionKey: item.sessionKey,
          ok: true,
          messages,
          threadFilterAvailable,
        };
        if (chatId) okResult.chatId = chatId;
        results[idx] = okResult;
      } catch (err) {
        const errMessage = err instanceof Error && err.message ? err.message : "unknown_error";
        const failResult: GroupActivityGroupResult = {
          sessionKey: item.sessionKey,
          ok: false,
          error: errMessage,
        };
        if (chatId) failResult.chatId = chatId;
        results[idx] = failResult;
      }
    }
  };

  await Promise.all(Array.from({ length: parallelism }, worker));

  return {
    windowStart: sinceTs,
    windowEnd: untilTs,
    scannedGroups: scanList.length,
    skippedGroups,
    userOpenId,
    threadFilterAvailable: aggregateThreadFilterAvailable,
    groups: results,
  };
}
