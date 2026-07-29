import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { appendSkillProposalEvent, type NewSkillProposalEvent } from "./store-sqlite-event.js";
import { parseSkillProposalRow, updateProposal } from "./store-sqlite-record.js";
import {
  databaseOptions,
  ensureSkillWorkshopSchema,
  type SkillWorkshopDatabase,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import type { SkillProposalEvent, SkillProposalRecord } from "./types.js";

export type PendingSkillProposalTransitionCommit =
  | { state: "committed"; event?: SkillProposalEvent }
  | { state: "conflict"; current?: SkillProposalRecord };

export function commitPendingSkillProposalTransition(params: {
  expected: SkillProposalRecord;
  record: SkillProposalRecord;
  event?: NewSkillProposalEvent;
  store?: SkillWorkshopStoreOptions;
  operationLabel: string;
}): PendingSkillProposalTransitionCommit {
  ensureSkillWorkshopSchema(params.store);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
      const current = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("skill_workshop_proposals")
          .selectAll()
          .where("proposal_id", "=", params.expected.id),
      );
      const currentRecord = current ? parseSkillProposalRow(current) : null;
      if (
        !current ||
        !currentRecord ||
        currentRecord.status !== "pending" ||
        current.record_json !== JSON.stringify(params.expected)
      ) {
        return {
          state: "conflict" as const,
          ...(currentRecord ? { current: currentRecord } : {}),
        };
      }
      updateProposal(db, current, params.record);
      return {
        state: "committed" as const,
        ...(params.event ? { event: appendSkillProposalEvent(db, params.event) } : {}),
      };
    },
    databaseOptions(params.store),
    { operationLabel: params.operationLabel },
  );
}
