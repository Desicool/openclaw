import { describe, expect, it, vi } from "vitest";
import {
  mondayMidnightUtcMs,
  runGroupActivity,
  type GetSessionMessagesFn,
  type ListSessionEntriesFn,
  type SessionListItem,
} from "./group-activity.js";
import { parseWeeklyReportPluginConfig, type WeeklyReportPluginSettings } from "./settings.js";

const USER_OPEN_ID = "ou_f95d535ac705bf89608914906e339424";
const OTHER_USER_OPEN_ID = "ou_teammate0123456789abcdef01234567";
const BOT_OPEN_ID = "ou_botaccount0123456789abcdef0123";
const NOW_MS = Date.UTC(2026, 4, 28, 18, 0, 0); // Thursday 2026-05-28 18:00 UTC
const WEEK_START = mondayMidnightUtcMs(NOW_MS); // Monday 2026-05-25 00:00 UTC

function settingsWith(
  overrides: Partial<Parameters<typeof parseWeeklyReportPluginConfig>[0]> = {},
): WeeklyReportPluginSettings {
  return parseWeeklyReportPluginConfig({
    userOpenId: USER_OPEN_ID,
    ...overrides,
  });
}

function makeSessionList(
  items: Array<{
    sessionKey: string;
    updatedAt?: number;
    lastInteractionAt?: number;
    groupId?: string;
  }>,
): ListSessionEntriesFn {
  return ({ agentId: _agentId }) =>
    items.map<SessionListItem>((i) => ({
      sessionKey: i.sessionKey,
      entry: {
        updatedAt: i.updatedAt ?? NOW_MS - 60_000,
        ...(i.lastInteractionAt !== undefined ? { lastInteractionAt: i.lastInteractionAt } : {}),
        ...(i.groupId !== undefined ? { groupId: i.groupId } : {}),
      },
    }));
}

function makeGetMessages(perSession: Record<string, unknown[]>): {
  fn: GetSessionMessagesFn;
  mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn().mockImplementation(async ({ sessionKey }: { sessionKey: string }) => ({
    messages: perSession[sessionKey] ?? [],
  }));
  return { fn: mock as never, mock };
}

function msg(opts: {
  ts?: number;
  senderOpenId: string;
  text?: string;
  mentions?: string[];
  threadRootId?: string;
}): Record<string, unknown> {
  return {
    ts: opts.ts ?? NOW_MS - 1_000,
    senderOpenId: opts.senderOpenId,
    text: opts.text ?? "",
    mentions: (opts.mentions ?? []).map((open_id) => ({ open_id })),
    ...(opts.threadRootId !== undefined ? { thread_id: opts.threadRootId } : {}),
  };
}

describe("runGroupActivity", () => {
  it("returns single error entry when userOpenId is unresolved", async () => {
    const { fn: getMessages } = makeGetMessages({});
    const result = await runGroupActivity({
      settings: settingsWith({ userOpenId: undefined } as never),
      agentId: "silver-chariot",
      listSessionEntries: makeSessionList([]),
      getSessionMessages: getMessages,
      now: () => NOW_MS,
    });
    expect(result.userOpenId).toBeUndefined();
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].ok).toBe(false);
    if (!result.groups[0].ok) {
      expect(result.groups[0].error).toMatch(/userOpenId not configured/);
    }
  });

  it("filters out non-feishu and direct sessions, keeps only :feishu:group:", async () => {
    const sessions = makeSessionList([
      { sessionKey: `agent:silver:feishu:direct:${USER_OPEN_ID}` },
      { sessionKey: "agent:silver:feishu:group:oc_groupA" },
      { sessionKey: "agent:silver:telegram:group:tg_1" },
      { sessionKey: "agent:silver:feishu:group:oc_groupB" },
    ]);
    const { fn, mock } = makeGetMessages({});
    const result = await runGroupActivity({
      settings: settingsWith(),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn,
      now: () => NOW_MS,
    });
    expect(result.scannedGroups).toBe(2);
    expect(mock.mock.calls.map((c) => (c[0] as { sessionKey: string }).sessionKey)).toEqual([
      "agent:silver:feishu:group:oc_groupA",
      "agent:silver:feishu:group:oc_groupB",
    ]);
  });

  it("respects groupDenylist by full sessionKey AND bare chatId", async () => {
    const sessions = makeSessionList([
      { sessionKey: "agent:silver:feishu:group:oc_keep1" },
      { sessionKey: "agent:silver:feishu:group:oc_keep2" },
      { sessionKey: "agent:silver:feishu:group:oc_noisy" },
      { sessionKey: "agent:silver:feishu:group:oc_alsoNoisy" },
    ]);
    const { fn, mock } = makeGetMessages({});
    await runGroupActivity({
      settings: settingsWith({
        groupDenylist: [
          "oc_noisy", // bare chatId
          "agent:silver:feishu:group:oc_alsoNoisy", // full sessionKey
        ],
      }),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn,
      now: () => NOW_MS,
    });
    expect(mock.mock.calls.map((c) => (c[0] as { sessionKey: string }).sessionKey)).toEqual([
      "agent:silver:feishu:group:oc_keep1",
      "agent:silver:feishu:group:oc_keep2",
    ]);
  });

  it("drops stale sessions (older than groupStaleAfterDays)", async () => {
    const sessions = makeSessionList([
      { sessionKey: "agent:silver:feishu:group:oc_fresh", updatedAt: NOW_MS - 60_000 },
      {
        sessionKey: "agent:silver:feishu:group:oc_old",
        updatedAt: NOW_MS - 30 * 86_400_000, // 30 days old
      },
    ]);
    const { fn, mock } = makeGetMessages({});
    const result = await runGroupActivity({
      settings: settingsWith({ groupStaleAfterDays: 14 }),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn,
      now: () => NOW_MS,
    });
    expect(result.scannedGroups).toBe(1);
    expect(mock).toHaveBeenCalledTimes(1);
    expect((mock.mock.calls[0][0] as { sessionKey: string }).sessionKey).toBe(
      "agent:silver:feishu:group:oc_fresh",
    );
  });

  it("classifies author / mention / thread reasons correctly", async () => {
    const sessions = makeSessionList([{ sessionKey: "agent:silver:feishu:group:oc_groupA" }]);
    const { fn } = makeGetMessages({
      "agent:silver:feishu:group:oc_groupA": [
        msg({ senderOpenId: USER_OPEN_ID, text: "my status", threadRootId: "om_thread1" }),
        msg({
          senderOpenId: OTHER_USER_OPEN_ID,
          text: "asking the team",
          mentions: [USER_OPEN_ID],
        }),
        msg({
          senderOpenId: OTHER_USER_OPEN_ID,
          text: "replying in thread1",
          threadRootId: "om_thread1",
        }),
        msg({ senderOpenId: OTHER_USER_OPEN_ID, text: "unrelated chatter" }),
        msg({
          senderOpenId: OTHER_USER_OPEN_ID,
          text: "in someone else's thread",
          threadRootId: "om_thread999",
        }),
      ],
    });
    const result = await runGroupActivity({
      settings: settingsWith(),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn,
      now: () => NOW_MS,
    });
    expect(result.groups).toHaveLength(1);
    const g = result.groups[0];
    expect(g.ok).toBe(true);
    if (g.ok) {
      const reasons = g.messages.map((m) => ({ text: m.text, reason: m.reason }));
      expect(reasons).toEqual([
        { text: "my status", reason: "author" },
        { text: "asking the team", reason: "mention" },
        { text: "replying in thread1", reason: "thread" },
      ]);
      expect(g.threadFilterAvailable).toBe(true);
    }
  });

  it("filters by time window (sinceTs/untilTs)", async () => {
    const sessions = makeSessionList([{ sessionKey: "agent:silver:feishu:group:oc_groupA" }]);
    const inWindow = WEEK_START + 60_000;
    const beforeWindow = WEEK_START - 60_000;
    const { fn } = makeGetMessages({
      "agent:silver:feishu:group:oc_groupA": [
        msg({ ts: beforeWindow, senderOpenId: USER_OPEN_ID, text: "last week" }),
        msg({ ts: inWindow, senderOpenId: USER_OPEN_ID, text: "this week" }),
      ],
    });
    const result = await runGroupActivity({
      settings: settingsWith(),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn,
      now: () => NOW_MS,
    });
    const g = result.groups[0];
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.messages.map((m) => m.text)).toEqual(["this week"]);
    }
  });

  it("enforces groupMaxGroupsScanned (skips overflow)", async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      sessionKey: `agent:silver:feishu:group:oc_group${i}`,
    }));
    const { fn, mock } = makeGetMessages({});
    const result = await runGroupActivity({
      settings: settingsWith({ groupMaxGroupsScanned: 3 }),
      agentId: "silver-chariot",
      listSessionEntries: makeSessionList(items),
      getSessionMessages: fn,
      now: () => NOW_MS,
    });
    expect(result.scannedGroups).toBe(3);
    expect(result.skippedGroups).toBe(4);
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("isolates per-group failures: one bad sessionKey → ok:false, siblings ok:true", async () => {
    const sessions = makeSessionList([
      { sessionKey: "agent:silver:feishu:group:oc_good1" },
      { sessionKey: "agent:silver:feishu:group:oc_bad" },
      { sessionKey: "agent:silver:feishu:group:oc_good2" },
    ]);
    const fn = vi.fn().mockImplementation(async ({ sessionKey }: { sessionKey: string }) => {
      if (sessionKey.endsWith("oc_bad")) {
        throw new Error("permission_denied");
      }
      return { messages: [msg({ senderOpenId: USER_OPEN_ID, text: `from ${sessionKey}` })] };
    });
    const result = await runGroupActivity({
      settings: settingsWith(),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn as never,
      now: () => NOW_MS,
    });
    const byKey = new Map(result.groups.map((g) => [g.sessionKey, g]));
    expect(byKey.get("agent:silver:feishu:group:oc_good1")?.ok).toBe(true);
    expect(byKey.get("agent:silver:feishu:group:oc_good2")?.ok).toBe(true);
    const bad = byKey.get("agent:silver:feishu:group:oc_bad");
    expect(bad?.ok).toBe(false);
    if (bad && !bad.ok) {
      expect(bad.error).toBe("permission_denied");
    }
  });

  it("filters out messages authored by the configured botOpenId", async () => {
    const sessions = makeSessionList([{ sessionKey: "agent:silver:feishu:group:oc_groupA" }]);
    const { fn } = makeGetMessages({
      "agent:silver:feishu:group:oc_groupA": [
        msg({ senderOpenId: BOT_OPEN_ID, text: "bot reply" }),
        msg({ senderOpenId: USER_OPEN_ID, text: "real user msg" }),
      ],
    });
    const result = await runGroupActivity({
      settings: settingsWith({ botOpenId: BOT_OPEN_ID }),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn,
      now: () => NOW_MS,
    });
    const g = result.groups[0];
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.messages.map((m) => m.text)).toEqual(["real user msg"]);
    }
  });

  it("includeReasons restricts classification (e.g. author-only)", async () => {
    const sessions = makeSessionList([{ sessionKey: "agent:silver:feishu:group:oc_groupA" }]);
    const { fn } = makeGetMessages({
      "agent:silver:feishu:group:oc_groupA": [
        msg({ senderOpenId: USER_OPEN_ID, text: "I said this" }),
        msg({
          senderOpenId: OTHER_USER_OPEN_ID,
          text: "@me",
          mentions: [USER_OPEN_ID],
        }),
      ],
    });
    const result = await runGroupActivity({
      settings: settingsWith(),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn,
      includeReasons: ["author"],
      now: () => NOW_MS,
    });
    const g = result.groups[0];
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.messages.map((m) => m.text)).toEqual(["I said this"]);
    }
  });

  it("threadFilterAvailable=false when no message has thread metadata", async () => {
    const sessions = makeSessionList([{ sessionKey: "agent:silver:feishu:group:oc_groupA" }]);
    const { fn } = makeGetMessages({
      "agent:silver:feishu:group:oc_groupA": [
        msg({ senderOpenId: USER_OPEN_ID, text: "flat" }),
        msg({ senderOpenId: OTHER_USER_OPEN_ID, text: "also flat" }),
      ],
    });
    const result = await runGroupActivity({
      settings: settingsWith(),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn,
      now: () => NOW_MS,
    });
    expect(result.threadFilterAvailable).toBe(false);
    const g = result.groups[0];
    if (g.ok) expect(g.threadFilterAvailable).toBe(false);
  });

  it("topicGroups=exclude dedupes by groupId, keeping the first session per group", async () => {
    const sessions = makeSessionList([
      { sessionKey: "agent:silver:feishu:group:oc_topic1", groupId: "oc_parentA" },
      { sessionKey: "agent:silver:feishu:group:oc_topic2", groupId: "oc_parentA" },
      { sessionKey: "agent:silver:feishu:group:oc_other", groupId: "oc_parentB" },
    ]);
    const { fn, mock } = makeGetMessages({});
    await runGroupActivity({
      settings: settingsWith({ topicGroups: "exclude" }),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn,
      now: () => NOW_MS,
    });
    const scanned = mock.mock.calls.map((c) => (c[0] as { sessionKey: string }).sessionKey);
    expect(scanned).toEqual([
      "agent:silver:feishu:group:oc_topic1",
      "agent:silver:feishu:group:oc_other",
    ]);
  });

  it("budget_exhausted marks remaining groups as ok:false", async () => {
    const sessions = makeSessionList([
      { sessionKey: "agent:silver:feishu:group:oc_a" },
      { sessionKey: "agent:silver:feishu:group:oc_b" },
    ]);
    // Use a `now` source whose value drifts past the deadline by the second iteration.
    let nowCallCount = 0;
    const fakeNow = () => {
      nowCallCount += 1;
      // Start at NOW_MS, jump way past the deadline after the first worker iteration's check.
      return nowCallCount === 1 ? NOW_MS : NOW_MS + 999_999;
    };
    const { fn } = makeGetMessages({});
    const result = await runGroupActivity({
      settings: settingsWith({ groupOverallTimeoutMs: 5_000, groupMaxParallelOps: 1 }),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn,
      now: fakeNow,
    });
    expect(result.groups).toHaveLength(2);
    // first group succeeds; second hits budget_exhausted
    const second = result.groups[1];
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("budget_exhausted");
  });

  it("derives Monday-midnight sinceTs by default", async () => {
    const sessions = makeSessionList([{ sessionKey: "agent:silver:feishu:group:oc_groupA" }]);
    const { fn } = makeGetMessages({});
    const result = await runGroupActivity({
      settings: settingsWith(),
      agentId: "silver-chariot",
      listSessionEntries: sessions,
      getSessionMessages: fn,
      now: () => NOW_MS,
    });
    expect(result.windowStart).toBe(WEEK_START);
    expect(result.windowEnd).toBe(NOW_MS);
  });
});

describe("mondayMidnightUtcMs", () => {
  it("rolls Thursday back to Monday 00:00 UTC", () => {
    expect(mondayMidnightUtcMs(Date.UTC(2026, 4, 28, 18, 0, 0))).toBe(
      Date.UTC(2026, 4, 25, 0, 0, 0),
    );
  });
});
