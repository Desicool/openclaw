import Testing
@testable import OpenClaw

struct AgentOverviewRefreshGateTests {
    @Test func `new overview refresh invalidates an older result`() {
        var gate = AgentOverviewRefreshGate()

        let first = gate.begin()
        let second = gate.begin()

        #expect(!gate.isCurrent(first))
        #expect(gate.isCurrent(second))
    }

    @Test func `current overview refresh remains accepted until superseded`() {
        var gate = AgentOverviewRefreshGate()
        let generation = gate.begin()

        #expect(gate.isCurrent(generation))
    }
}
