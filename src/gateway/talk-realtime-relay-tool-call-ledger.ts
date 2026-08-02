// Providers commonly cap native calls at 1,024, while the relay can retain both
// a provider id and a synthetic owner-facing alias for one lifecycle.
export const MAX_RELAY_TOOL_CALL_IDENTITIES = 2_048;

type RelayToolCallEntry = {
  agentCompleted?: true;
  providerCompleted?: true;
  cancelledTurnId?: string;
};

export class RelayToolCallLedger {
  // Identities remain for the session lifetime even when individual terminal
  // facts clear, so late events cannot regain admission after capacity pressure.
  private readonly entries = new Map<string, RelayToolCallEntry>();
  private overflowReported = false;

  constructor(
    private readonly options: {
      onOverflow: () => void;
      maxEntries?: number;
    },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  has(callId: string): boolean {
    return this.entries.has(callId);
  }

  tryAdmit(callIds: Iterable<string>): boolean {
    const uniqueCallIds = new Set(callIds);
    let additions = 0;
    for (const callId of uniqueCallIds) {
      if (callId && !this.entries.has(callId)) {
        additions += 1;
      }
    }
    const maxEntries = this.options.maxEntries ?? MAX_RELAY_TOOL_CALL_IDENTITIES;
    if (this.entries.size + additions > maxEntries) {
      if (!this.overflowReported) {
        this.overflowReported = true;
        this.options.onOverflow();
      }
      return false;
    }
    for (const callId of uniqueCallIds) {
      if (callId && !this.entries.has(callId)) {
        this.entries.set(callId, {});
      }
    }
    return true;
  }

  private mark(callIds: Iterable<string>, mutate: (entry: RelayToolCallEntry) => void): boolean {
    const retainedCallIds = [...callIds];
    if (!this.tryAdmit(retainedCallIds)) {
      return false;
    }
    for (const callId of retainedCallIds) {
      const entry = this.entries.get(callId);
      if (entry) {
        mutate(entry);
      }
    }
    return true;
  }

  isAgentCompleted(callId: string): boolean {
    return this.entries.get(callId)?.agentCompleted === true;
  }

  markAgentCompleted(callIds: Iterable<string>): boolean {
    return this.mark(callIds, (entry) => {
      entry.agentCompleted = true;
    });
  }

  deleteAgentCompleted(callId: string): void {
    delete this.entries.get(callId)?.agentCompleted;
  }

  isProviderCompleted(callId: string): boolean {
    return this.entries.get(callId)?.providerCompleted === true;
  }

  markProviderCompleted(callIds: Iterable<string>): boolean {
    return this.mark(callIds, (entry) => {
      entry.providerCompleted = true;
    });
  }

  deleteProviderCompleted(callId: string): void {
    delete this.entries.get(callId)?.providerCompleted;
  }

  clearProviderCompleted(): void {
    for (const entry of this.entries.values()) {
      delete entry.providerCompleted;
    }
  }

  hasCancelled(callId: string): boolean {
    return this.entries.get(callId)?.cancelledTurnId !== undefined;
  }

  cancelledTurnId(callId: string): string | undefined {
    return this.entries.get(callId)?.cancelledTurnId;
  }

  markCancelled(callIds: Iterable<string>, turnId: string): boolean {
    return this.mark(callIds, (entry) => {
      entry.cancelledTurnId = turnId;
    });
  }

  deleteCancelled(callId: string): void {
    delete this.entries.get(callId)?.cancelledTurnId;
  }

  cancelledCallIds(): string[] {
    return [...this.entries]
      .filter(([, entry]) => entry.cancelledTurnId !== undefined)
      .map(([callId]) => callId);
  }

  clearCancelled(): void {
    for (const entry of this.entries.values()) {
      delete entry.cancelledTurnId;
    }
  }
}
