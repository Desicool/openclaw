import { describe, expect, it, vi } from "vitest";
import { RelayToolCallLedger } from "./talk-realtime-relay-tool-call-ledger.js";

describe("RelayToolCallLedger", () => {
  it("shares one retained identity across cancellation and terminal outcomes", () => {
    const ledger = new RelayToolCallLedger({ onOverflow: vi.fn(), maxEntries: 2 });

    expect(ledger.tryAdmit(["call-1"])).toBe(true);
    expect(ledger.markCancelled(["call-1"], "turn-1")).toBe(true);
    expect(ledger.markAgentCompleted(["call-1"])).toBe(true);
    expect(ledger.markProviderCompleted(["call-1"])).toBe(true);

    expect(ledger.size).toBe(1);
    expect(ledger.cancelledTurnId("call-1")).toBe("turn-1");
    expect(ledger.isAgentCompleted("call-1")).toBe(true);
    expect(ledger.isProviderCompleted("call-1")).toBe(true);
  });

  it("rejects overflowing batches atomically while admitting retained duplicates", () => {
    const onOverflow = vi.fn();
    const ledger = new RelayToolCallLedger({ onOverflow, maxEntries: 2 });

    expect(ledger.tryAdmit(["call-1"])).toBe(true);
    expect(ledger.markAgentCompleted(["call-2", "call-3"])).toBe(false);
    expect(ledger.size).toBe(1);
    expect(ledger.has("call-2")).toBe(false);
    expect(ledger.has("call-3")).toBe(false);
    expect(onOverflow).toHaveBeenCalledOnce();

    expect(ledger.tryAdmit(["call-1"])).toBe(true);
    expect(onOverflow).toHaveBeenCalledOnce();
  });

  it("clears lifecycle facts without releasing the retained identity", () => {
    const ledger = new RelayToolCallLedger({ onOverflow: vi.fn(), maxEntries: 1 });

    ledger.markCancelled(["call-1"], "turn-1");
    ledger.markAgentCompleted(["call-1"]);
    ledger.markProviderCompleted(["call-1"]);
    ledger.deleteCancelled("call-1");
    ledger.deleteAgentCompleted("call-1");
    ledger.clearProviderCompleted();

    expect(ledger.has("call-1")).toBe(true);
    expect(ledger.size).toBe(1);
    expect(ledger.hasCancelled("call-1")).toBe(false);
    expect(ledger.isAgentCompleted("call-1")).toBe(false);
    expect(ledger.isProviderCompleted("call-1")).toBe(false);
    expect(ledger.tryAdmit(["call-2"])).toBe(false);
  });
});
