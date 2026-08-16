import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";

type WorkerPlacementBinding = Readonly<{
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
}>;

export type WorkerPlacementTurnBinding = WorkerPlacementBinding &
  Readonly<{
    runId: string;
    claimId: string;
    placementGeneration: number;
  }>;

export type WorkerSessionPlacementGate = {
  hasWorkerTurn(binding: WorkerPlacementBinding): boolean;
  /** Credential verification only; this does not grant operational worker authority. */
  readWorkerTurnClaim(binding: WorkerPlacementBinding): WorkerSessionTurnClaim | undefined;
  resolveWorkerTurn(binding: WorkerPlacementTurnLookup): WorkerSessionTurnClaim | undefined;
  validateWorkerTurn(binding: WorkerPlacementTurnBinding): boolean;
  isWorkerTurnToolAuthorized(binding: WorkerPlacementTurnBinding, toolName: string): boolean;
  updateAckCursors(
    binding: WorkerPlacementTurnBinding & {
      transcriptSeq?: number;
      liveSeq?: number;
    },
  ): void;
  registerTurnClaimClosedHandler(handler: (claim: WorkerSessionTurnClaim) => void): () => void;
};

type WorkerPlacementTurnLookup = WorkerPlacementBinding & Readonly<{ runId: string }>;

function claimKey(claim: WorkerSessionTurnClaim): string {
  if (claim.owner.kind !== "worker") {
    throw new Error("Worker placement gate requires a worker-owned claim");
  }
  return JSON.stringify([
    claim.sessionId,
    claim.owner.environmentId,
    claim.owner.ownerEpoch,
    claim.runId,
    claim.claimId,
    claim.placementGeneration,
  ]);
}

function claimForBinding(
  record: WorkerSessionPlacementRecord | undefined,
  binding: WorkerPlacementBinding & {
    runId?: string;
    claimId?: string;
    placementGeneration?: number;
  },
): WorkerSessionTurnClaim | undefined {
  const persisted = record?.turnClaim;
  if (
    !record ||
    (record.state !== "active" && record.state !== "draining") ||
    record.environmentId !== binding.environmentId ||
    record.activeOwnerEpoch !== binding.ownerEpoch ||
    persisted?.owner !== "worker" ||
    (binding.runId !== undefined && persisted.runId !== binding.runId) ||
    (binding.claimId !== undefined && persisted.claimId !== binding.claimId) ||
    (binding.placementGeneration !== undefined &&
      persisted.generation !== binding.placementGeneration) ||
    persisted.ownerEpoch !== binding.ownerEpoch
  ) {
    return undefined;
  }
  return {
    sessionId: binding.sessionId,
    claimId: persisted.claimId,
    runId: persisted.runId,
    placementGeneration: persisted.generation,
    owner: {
      kind: "worker",
      environmentId: binding.environmentId,
      ownerEpoch: binding.ownerEpoch,
    },
  };
}

export function createWorkerSessionPlacementGate(
  store: WorkerSessionPlacementStore,
  options: { rejectExistingWorkerClaims?: boolean } = {},
): WorkerSessionPlacementGate {
  const recoveryOnlyClaims = new Set(
    options.rejectExistingWorkerClaims
      ? store.list().flatMap((record) => {
          const claim =
            record.environmentId && record.activeOwnerEpoch !== null
              ? claimForBinding(record, {
                  sessionId: record.sessionId,
                  environmentId: record.environmentId,
                  ownerEpoch: record.activeOwnerEpoch,
                })
              : undefined;
          return claim ? [claimKey(claim)] : [];
        })
      : [],
  );
  const isOperational = (claim: WorkerSessionTurnClaim) =>
    !recoveryOnlyClaims.has(claimKey(claim)) && store.validateTurnClaim(claim);

  const readWorkerTurnClaim = (binding: WorkerPlacementBinding) => {
    const claim = claimForBinding(store.get(binding.sessionId), binding);
    return claim && store.validateTurnClaim(claim) ? claim : undefined;
  };

  const resolveWorkerTurn = (
    binding: WorkerPlacementTurnLookup | WorkerPlacementTurnBinding,
  ): WorkerSessionTurnClaim | undefined => {
    const claim = readWorkerTurnClaim(binding);
    const exact =
      claim?.runId === binding.runId &&
      (!("claimId" in binding) ||
        (claim.claimId === binding.claimId &&
          claim.placementGeneration === binding.placementGeneration));
    return claim && exact && isOperational(claim) ? claim : undefined;
  };

  const validateWorkerTurn = (binding: WorkerPlacementTurnBinding) =>
    resolveWorkerTurn(binding) !== undefined;

  return {
    hasWorkerTurn(binding): boolean {
      const claim = readWorkerTurnClaim(binding);
      return claim ? isOperational(claim) : false;
    },

    readWorkerTurnClaim,
    resolveWorkerTurn,
    validateWorkerTurn,

    isWorkerTurnToolAuthorized(binding, toolName): boolean {
      return validateWorkerTurn(binding) && store.isWorkerTurnToolAuthorized(binding, toolName);
    },

    updateAckCursors(binding): void {
      const claim = resolveWorkerTurn(binding);
      if (!claim) {
        throw new Error(`Cannot ACK stale worker turn for session ${binding.sessionId}`);
      }
      store.updateAckCursors({
        claim,
        ...(binding.transcriptSeq === undefined ? {} : { transcript: binding.transcriptSeq }),
        ...(binding.liveSeq === undefined ? {} : { liveEvent: binding.liveSeq }),
      });
    },

    registerTurnClaimClosedHandler: (handler) => store.registerTurnClaimClosedHandler(handler),
  };
}
