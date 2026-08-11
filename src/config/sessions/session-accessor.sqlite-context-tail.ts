import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  getActiveTranscriptKysely,
  withCurrentProjectionSnapshot,
} from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";

type SessionTranscriptBoundedContextTail = {
  activeLeafEntryId?: string | null;
  contextSummary?: { text: string; ts: number };
  events: Array<{ event: TranscriptEvent; seq: number }>;
  scannedMessages: number;
  serializedBytes: number;
  totalMessages: number;
};

type ContextWindow = {
  contextSummary?: { text: string; ts: number };
  kept: number[];
  postStart: number;
  total: number;
};

type ContextProjection = {
  database: OpenClawAgentDatabase;
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>;
  state: SessionTranscriptProjectionState;
};

const CONTEXT_TAIL_PAGE_MESSAGES = 160;

function parseEventType(eventJson: string): string | undefined {
  try {
    const parsed = JSON.parse(eventJson) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

function readContextWindow(projection: ContextProjection): ContextWindow {
  const db = getActiveTranscriptKysely(projection.database);
  const nonMessageRows = executeSqliteQuerySync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select(["active.active_position", "event.event_json"])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.message_position", "is", null)
      .orderBy("active.active_position", "desc"),
  ).rows;
  const boundaryRow = nonMessageRows.find((row) => {
    const type = parseEventType(row.event_json);
    return type === "reset" || type === "compaction";
  });
  if (!boundaryRow) {
    return { kept: [], postStart: 0, total: projection.state.activeMessageCount };
  }
  const boundaryType = parseEventType(boundaryRow.event_json);
  const boundary = JSON.parse(boundaryRow.event_json) as {
    firstKeptEntryId?: unknown;
    summary?: unknown;
    timestamp?: unknown;
  };
  const postStart =
    executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events")
        .select("message_position")
        .where("session_id", "=", projection.resolved.sessionId)
        .where("active_position", ">", boundaryRow.active_position)
        .where("message_position", "is not", null)
        .orderBy("active_position", "asc")
        .limit(1),
    )?.message_position ?? projection.state.activeMessageCount;
  let kept: number[] = [];
  if (typeof boundary.firstKeptEntryId === "string") {
    const firstKept = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .select("active.active_position")
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "=", boundary.firstKeptEntryId),
    );
    if (firstKept && firstKept.active_position < boundaryRow.active_position) {
      kept = executeSqliteQuerySync(
        projection.database.db,
        db
          .selectFrom("session_transcript_active_events as active")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "active.session_id")
              .onRef("event.seq", "=", "active.event_seq"),
          )
          .select(["active.message_position", "event.event_json"])
          .where("active.session_id", "=", projection.resolved.sessionId)
          .where("active.active_position", ">=", firstKept.active_position)
          .where("active.active_position", "<", boundaryRow.active_position)
          .where("active.message_position", "is not", null)
          .orderBy("active.active_position", "asc"),
      ).rows.flatMap((row) => {
        if (row.message_position === null) {
          return [];
        }
        if (boundaryType === "compaction") {
          return [row.message_position];
        }
        try {
          const role = (JSON.parse(row.event_json) as { message?: { role?: unknown } }).message
            ?.role;
          return role === "user" || role === "assistant" ? [row.message_position] : [];
        } catch {
          return [];
        }
      });
    }
  }
  return {
    ...(boundaryType === "compaction" && typeof boundary.summary === "string"
      ? {
          contextSummary: {
            text: boundary.summary,
            ts:
              typeof boundary.timestamp === "string"
                ? Date.parse(boundary.timestamp) || 0
                : typeof boundary.timestamp === "number" && Number.isFinite(boundary.timestamp)
                  ? boundary.timestamp
                  : 0,
          },
        }
      : {}),
    kept,
    postStart,
    total: kept.length + Math.max(0, projection.state.activeMessageCount - postStart),
  };
}

function selectTailPositions(window: ContextWindow, maxScannedMessages: number): number[] {
  const start = Math.max(0, window.total - maxScannedMessages);
  const keptEnd = Math.min(window.total, window.kept.length);
  const positions = window.kept.slice(Math.min(start, keptEnd), keptEnd);
  const postStart = Math.max(start, window.kept.length);
  for (let logical = postStart; logical < window.total; logical += 1) {
    positions.push(window.postStart + logical - window.kept.length);
  }
  return positions;
}

function isSeedableContextEvent(event: TranscriptEvent): boolean {
  if (!event || typeof event !== "object") {
    return false;
  }
  const role = (event as { message?: { role?: unknown } }).message?.role;
  return role === "user" || role === "assistant";
}

/** Reads one bounded model-context tail from a single active-projection snapshot. */
export function readSessionTranscriptBoundedContextTail(
  scope: SessionTranscriptReadScope,
  options: { maxBytes: number; maxContextMessages: number; maxScannedMessages: number },
): SessionTranscriptBoundedContextTail {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const window = readContextWindow(projection);
    const maxScannedMessages = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxScannedMessages) ? options.maxScannedMessages : 0),
    );
    const maxBytes = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxBytes) ? options.maxBytes : 0),
    );
    const maxContextMessages = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxContextMessages) ? options.maxContextMessages : 0),
    );
    const positions = selectTailPositions(window, maxScannedMessages);
    if (positions.length === 0 || maxBytes === 0) {
      return {
        activeLeafEntryId: projection.state.leafEventId,
        contextSummary: window.contextSummary,
        events: [],
        scannedMessages: positions.length,
        serializedBytes: 0,
        totalMessages: window.total,
      };
    }
    const db = getActiveTranscriptKysely(projection.database);
    const remainingPositions = positions.toReversed();
    const newestEvents: Array<{ event: TranscriptEvent; seq: number }> = [];
    let contextMessages = window.contextSummary ? 1 : 0;
    let scannedMessages = 0;
    let serializedBytes = 0;
    while (
      remainingPositions.length > 0 &&
      serializedBytes < maxBytes &&
      contextMessages < maxContextMessages
    ) {
      const batchPositions = remainingPositions.splice(0, CONTEXT_TAIL_PAGE_MESSAGES);
      scannedMessages += batchPositions.length;
      const metadata = executeSqliteQuerySync(
        projection.database.db,
        db
          .selectFrom("session_transcript_active_events as active")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "active.session_id")
              .onRef("event.seq", "=", "active.event_seq"),
          )
          .select([
            "active.message_position",
            /* kysely-allow-raw: byte budget covers the exact newline-terminated JSON event. */
            sql<number>`LENGTH(CAST(event.event_json AS BLOB)) + 1`.as("serialized_bytes"),
          ])
          .where("active.session_id", "=", projection.resolved.sessionId)
          .where("active.message_position", "in", batchPositions)
          .orderBy("active.message_position", "desc"),
      ).rows;
      const selectedPositions: number[] = [];
      for (const row of metadata) {
        if (row.message_position === null || serializedBytes + row.serialized_bytes > maxBytes) {
          continue;
        }
        selectedPositions.push(row.message_position);
        serializedBytes += row.serialized_bytes;
      }
      if (selectedPositions.length === 0) {
        continue;
      }
      const rows = executeSqliteQuerySync(
        projection.database.db,
        db
          .selectFrom("session_transcript_active_events as active")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "active.session_id")
              .onRef("event.seq", "=", "active.event_seq"),
          )
          .select(["active.message_position", "event.event_json"])
          .where("active.session_id", "=", projection.resolved.sessionId)
          .where("active.message_position", "in", selectedPositions)
          .orderBy("active.message_position", "desc"),
      ).rows;
      for (const row of rows) {
        if (row.message_position === null) {
          continue;
        }
        const event = JSON.parse(row.event_json) as TranscriptEvent;
        newestEvents.push({ event, seq: row.message_position + 1 });
        if (isSeedableContextEvent(event)) {
          contextMessages += 1;
          if (contextMessages >= maxContextMessages) {
            break;
          }
        }
      }
    }
    return {
      activeLeafEntryId: projection.state.leafEventId,
      contextSummary: window.contextSummary,
      events: newestEvents.toReversed(),
      scannedMessages,
      serializedBytes,
      totalMessages: window.total,
    };
  });
}
