import { describe, expect, it, vi } from "vitest";
import {
  buildSearchArgv,
  extractJsonPayload,
  mondayMidnightUtcMs,
  parseLarkCliTimestamp,
  runGroupActivity,
  type RunCommandFn,
} from "./group-activity.js";
import { parseWeeklyReportPluginConfig, type WeeklyReportPluginSettings } from "./settings.js";

const USER_OPEN_ID = "ou_f95d535ac705bf89608914906e339424";
const TEAMMATE_OPEN_ID = "ou_teammate0123456789abcdef01234567";
const BOT_OPEN_ID = "ou_botaccount0123456789abcdef0123";
const NOW_MS = Date.UTC(2026, 4, 28, 18, 0, 0); // Thu 2026-05-28 18:00 UTC
const WEEK_START = mondayMidnightUtcMs(NOW_MS); // Mon 2026-05-25 00:00 UTC

const ACCOUNT_ID = "silver-chariot";

function settingsWith(
  overrides: Partial<Parameters<typeof parseWeeklyReportPluginConfig>[0]> = {},
): WeeklyReportPluginSettings {
  return parseWeeklyReportPluginConfig({
    userOpenId: USER_OPEN_ID,
    larkCliAccountId: ACCOUNT_ID,
    ...overrides,
  });
}

type SpawnResultLike = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  killed: boolean;
  termination: "exited" | "signal" | "timeout";
};

function ok(stdout: object): SpawnResultLike {
  // Mimic lark-cli's stdout: info log noise (column-0 single chars are NOT introduced) followed by
  // pretty-printed JSON. Tests exercise the extractor + JSON.parse pipeline through this shape.
  const noise = "[info]: [ 'client ready' ]\n[feishu/core/tool-client] feishu: fetched scopes\n";
  return {
    stdout: noise + JSON.stringify(stdout, null, 2) + "\n",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exited",
  };
}

function fail(opts: { stderr?: string; stdout?: string; code?: number }): SpawnResultLike {
  return {
    stdout: opts.stdout ?? "",
    stderr: opts.stderr ?? "",
    code: opts.code ?? 1,
    signal: null,
    killed: false,
    termination: "exited",
  };
}

function cliMessage(opts: {
  messageId: string;
  chatId: string;
  senderOpenId: string;
  ts?: number;
  text?: string;
  mentions?: string[];
  threadId?: string;
  msgType?: string;
  chatName?: string;
}): Record<string, unknown> {
  const ts = opts.ts ?? NOW_MS - 60_000;
  // lark-cli's broken create_time format: UTC labeled +08:00
  const createTime = `${new Date(ts).toISOString().slice(0, -1)}+08:00`.replace(".000", ".000");
  return {
    message_id: opts.messageId,
    chat_id: opts.chatId,
    msg_type: opts.msgType ?? "text",
    content: opts.text ?? "hello",
    sender: { id: opts.senderOpenId, sender_type: "user" },
    create_time: createTime,
    ...(opts.threadId ? { thread_id: opts.threadId } : {}),
    ...(opts.mentions
      ? { mentions: opts.mentions.map((id, i) => ({ key: `@_user_${i}`, id, name: "" })) }
      : {}),
    ...(opts.chatName ? { chat_name: opts.chatName } : {}),
  };
}

function asRunCommand(impl: (argv: string[]) => Promise<SpawnResultLike>): RunCommandFn {
  return (async (argv: readonly string[], _opts?: unknown) =>
    impl([...argv])) as unknown as RunCommandFn;
}

describe("extractJsonPayload", () => {
  const noisy = [
    "[info]: [ 'client ready' ]",
    "[36m[feishu/core/app-scope-checker][0m feishu: fetched 59 scopes for app cli_a976edca72fa5bc1 {}",
    "[feishu/core/tool-client] feishu: Using app owner as fallback {",
    "  toolAction: 'foo',",
    "  appId: 'cli_xxx'",
    "}",
    "{",
    '  "messages": [],',
    '  "has_more": false',
    "}",
    "",
  ].join("\n");

  it("returns the last column-anchored {...} block, skipping log noise", () => {
    const json = extractJsonPayload(noisy);
    expect(json).toBeDefined();
    expect(JSON.parse(json!)).toEqual({ messages: [], has_more: false });
  });

  it("handles stdout that's already pure JSON", () => {
    const pure = '{\n  "messages": [{"id": "x"}],\n  "has_more": true\n}';
    expect(JSON.parse(extractJsonPayload(pure)!)).toEqual({
      messages: [{ id: "x" }],
      has_more: true,
    });
  });

  it("returns undefined when stdout has no JSON object", () => {
    expect(extractJsonPayload("not json at all")).toBeUndefined();
    expect(extractJsonPayload("")).toBeUndefined();
  });
});

describe("parseLarkCliTimestamp", () => {
  it("reverses the +08:00 mangling and returns ms-since-epoch", () => {
    const ms = Date.UTC(2026, 4, 28, 10, 30, 0);
    const cliString = `${new Date(ms).toISOString().slice(0, -1)}+08:00`;
    expect(parseLarkCliTimestamp(cliString)).toBe(ms);
  });

  it("handles plain ISO with Z too", () => {
    const ms = Date.UTC(2026, 4, 28, 10, 30, 0);
    expect(parseLarkCliTimestamp(new Date(ms).toISOString())).toBe(ms);
  });

  it("returns undefined for unparseable input", () => {
    expect(parseLarkCliTimestamp(undefined)).toBeUndefined();
    expect(parseLarkCliTimestamp("not-a-date")).toBeUndefined();
    expect(parseLarkCliTimestamp(123)).toBeUndefined();
  });
});

describe("buildSearchArgv", () => {
  it("builds an argv with --sender_ids for author kind, JSON-encoded user open_id", () => {
    const argv = buildSearchArgv({
      bin: "larkcli",
      accountId: ACCOUNT_ID,
      kind: "author",
      userOpenId: USER_OPEN_ID,
      sinceIso: "2026-05-25T00:00:00.000Z",
      untilIso: "2026-05-28T18:00:00.000Z",
      pageSize: 50,
      pageToken: undefined,
    });
    expect(argv[0]).toBe("larkcli");
    expect(argv).toContain("-a");
    expect(argv).toContain(ACCOUNT_ID);
    expect(argv).toContain("im");
    expect(argv).toContain("search-messages");
    expect(argv).toContain("--sender_ids");
    expect(argv).toContain(JSON.stringify([USER_OPEN_ID]));
    expect(argv).toContain("--chat_type");
    expect(argv).toContain("group");
    expect(argv).not.toContain("--relative_time");
  });

  it("uses --mention_ids for mention kind and appends page_token when given", () => {
    const argv = buildSearchArgv({
      bin: "larkcli",
      accountId: ACCOUNT_ID,
      kind: "mention",
      userOpenId: USER_OPEN_ID,
      sinceIso: "2026-05-25T00:00:00.000Z",
      untilIso: "2026-05-28T18:00:00.000Z",
      pageSize: 50,
      pageToken: "next-page",
    });
    expect(argv).toContain("--mention_ids");
    expect(argv).not.toContain("--sender_ids");
    expect(argv).toContain("--page_token");
    expect(argv).toContain("next-page");
  });

  it("never contains shell metacharacters interpolated into one string", () => {
    const argv = buildSearchArgv({
      bin: "larkcli",
      accountId: ACCOUNT_ID,
      kind: "author",
      userOpenId: USER_OPEN_ID,
      sinceIso: "2026-05-25T00:00:00.000Z",
      untilIso: "2026-05-28T18:00:00.000Z",
      pageSize: 50,
      pageToken: undefined,
    });
    for (const piece of argv) {
      expect(piece).not.toMatch(/[;&|`$()<>]/u);
    }
  });
});

describe("runGroupActivity", () => {
  it("returns top-level ok:false when userOpenId is unresolved", async () => {
    const runCommand = vi.fn() as unknown as RunCommandFn;
    const result = await runGroupActivity({
      settings: settingsWith({ userOpenId: undefined } as never),
      runCommand,
      now: () => NOW_MS,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("userOpenId");
    expect(result.passes).toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("returns top-level ok:false when larkCliAccountId is unset, no spawn attempt", async () => {
    const runCommand = vi.fn() as unknown as RunCommandFn;
    const result = await runGroupActivity({
      settings: settingsWith({ larkCliAccountId: undefined } as never),
      runCommand,
      now: () => NOW_MS,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("larkCliAccountId");
    expect(result.passes).toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("runs author + mention passes, dedupes by message_id, groups by chat_id", async () => {
    const ts = NOW_MS - 60_000;
    const authorReply = ok({
      messages: [
        cliMessage({
          messageId: "om_a1",
          chatId: "oc_proj",
          senderOpenId: USER_OPEN_ID,
          ts,
          text: "shipped milestone X",
        }),
        cliMessage({
          messageId: "om_shared",
          chatId: "oc_team",
          senderOpenId: USER_OPEN_ID,
          ts,
          text: "I'll handle the migration",
        }),
      ],
      has_more: false,
    });
    const mentionReply = ok({
      messages: [
        cliMessage({
          messageId: "om_m1",
          chatId: "oc_team",
          senderOpenId: TEAMMATE_OPEN_ID,
          ts,
          text: `cc @${USER_OPEN_ID} for migration plan`,
          mentions: [USER_OPEN_ID],
        }),
        // Duplicate of om_shared (showed up under both filters somehow) → dedupe
        cliMessage({
          messageId: "om_shared",
          chatId: "oc_team",
          senderOpenId: USER_OPEN_ID,
          ts,
        }),
      ],
      has_more: false,
    });
    const calls: string[][] = [];
    const runCommand = asRunCommand(async (argv) => {
      calls.push(argv);
      return argv.includes("--sender_ids") ? authorReply : mentionReply;
    });
    const result = await runGroupActivity({
      settings: settingsWith(),
      runCommand,
      now: () => NOW_MS,
    });
    expect(result.ok).not.toBe(false);
    expect(result.passes).toHaveLength(2);
    expect(result.passes.map((p) => p.kind)).toEqual(["author", "mention"]);
    expect(result.passes.every((p) => p.ok)).toBe(true);
    expect(Object.keys(result.groupedByChat).sort()).toEqual(["oc_proj", "oc_team"]);
    const teamMessages = result.groupedByChat.oc_team!;
    const ids = teamMessages.map((m) => m.messageId).sort();
    expect(ids).toEqual(["om_m1", "om_shared"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--sender_ids");
    expect(calls[1]).toContain("--mention_ids");
  });

  it("handles single-pass failure without faulting the whole tool", async () => {
    const runCommand = asRunCommand(async (argv) => {
      if (argv.includes("--sender_ids")) {
        return ok({
          messages: [
            cliMessage({
              messageId: "om_x",
              chatId: "oc_a",
              senderOpenId: USER_OPEN_ID,
            }),
          ],
          has_more: false,
        });
      }
      return fail({ stderr: "transient feishu API error", code: 1 });
    });
    const result = await runGroupActivity({
      settings: settingsWith(),
      runCommand,
      now: () => NOW_MS,
    });
    expect(result.ok).not.toBe(false);
    const author = result.passes.find((p) => p.kind === "author")!;
    const mention = result.passes.find((p) => p.kind === "mention")!;
    expect(author.ok).toBe(true);
    expect(mention.ok).toBe(false);
    if (!mention.ok) expect(mention.error).toContain("transient feishu API error");
    expect(Object.keys(result.groupedByChat)).toEqual(["oc_a"]);
  });

  it("returns top-level ok:false when both passes fail", async () => {
    const runCommand = asRunCommand(async () => fail({ stderr: "broken", code: 2 }));
    const result = await runGroupActivity({
      settings: settingsWith(),
      runCommand,
      now: () => NOW_MS,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("author");
    expect(result.error).toContain("mention");
  });

  it("detects ENOENT from a thrown error and reports install hint", async () => {
    const enoent = Object.assign(new Error("spawn larkcli ENOENT"), { code: "ENOENT" });
    const runCommand = (async () => {
      throw enoent;
    }) as unknown as RunCommandFn;
    const result = await runGroupActivity({
      settings: settingsWith(),
      runCommand,
      now: () => NOW_MS,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("larkcli not found");
    expect(result.error).toContain("npm install -g @richord/lark-cli");
  });

  it("walks page_tokens and marks truncated when has_more stays true at cap", async () => {
    const settings = settingsWith({ larkCliMaxPages: 2, groupMaxMessagesPerPass: 50 });
    let pageCount = 0;
    const runCommand = asRunCommand(async (argv) => {
      if (!argv.includes("--sender_ids")) {
        return ok({ messages: [], has_more: false });
      }
      pageCount++;
      const messages = [
        cliMessage({
          messageId: `om_p${pageCount}_1`,
          chatId: "oc_busy",
          senderOpenId: USER_OPEN_ID,
        }),
      ];
      return ok({ messages, has_more: true, page_token: `tok-${pageCount}` });
    });
    const result = await runGroupActivity({ settings, runCommand, now: () => NOW_MS });
    const author = result.passes.find((p) => p.kind === "author")!;
    expect(author.ok).toBe(true);
    if (author.ok) {
      expect(author.truncated).toBe(true);
      expect(author.pagesWalked).toBe(2);
    }
    expect(pageCount).toBe(2); // hit maxPages cap exactly
  });

  it("groupDenylist drops chats from groupedByChat after fetch", async () => {
    const ts = NOW_MS - 60_000;
    const runCommand = asRunCommand(async (argv) => {
      if (!argv.includes("--sender_ids")) return ok({ messages: [], has_more: false });
      return ok({
        messages: [
          cliMessage({ messageId: "om_keep", chatId: "oc_keep", senderOpenId: USER_OPEN_ID, ts }),
          cliMessage({ messageId: "om_skip", chatId: "oc_noisy", senderOpenId: USER_OPEN_ID, ts }),
        ],
        has_more: false,
      });
    });
    const result = await runGroupActivity({
      settings: settingsWith({ groupDenylist: ["oc_noisy"] }),
      runCommand,
      now: () => NOW_MS,
    });
    expect(Object.keys(result.groupedByChat)).toEqual(["oc_keep"]);
  });

  it("botOpenId drops bot self-messages from groupedByChat", async () => {
    const ts = NOW_MS - 60_000;
    const runCommand = asRunCommand(async (argv) => {
      if (!argv.includes("--mention_ids")) return ok({ messages: [], has_more: false });
      return ok({
        messages: [
          cliMessage({
            messageId: "om_user",
            chatId: "oc_team",
            senderOpenId: TEAMMATE_OPEN_ID,
            ts,
            mentions: [USER_OPEN_ID],
          }),
          cliMessage({
            messageId: "om_bot",
            chatId: "oc_team",
            senderOpenId: BOT_OPEN_ID,
            ts,
            mentions: [USER_OPEN_ID],
          }),
        ],
        has_more: false,
      });
    });
    const result = await runGroupActivity({
      settings: settingsWith({ botOpenId: BOT_OPEN_ID }),
      runCommand,
      now: () => NOW_MS,
    });
    const team = result.groupedByChat.oc_team ?? [];
    expect(team.map((m) => m.messageId)).toEqual(["om_user"]);
  });

  it("filters out-of-window messages even if the API returned them", async () => {
    const inWindow = WEEK_START + 60_000;
    const outOfWindow = WEEK_START - 60_000;
    const runCommand = asRunCommand(async (argv) => {
      if (!argv.includes("--sender_ids")) return ok({ messages: [], has_more: false });
      return ok({
        messages: [
          cliMessage({
            messageId: "om_in",
            chatId: "oc_x",
            senderOpenId: USER_OPEN_ID,
            ts: inWindow,
          }),
          cliMessage({
            messageId: "om_out",
            chatId: "oc_x",
            senderOpenId: USER_OPEN_ID,
            ts: outOfWindow,
          }),
        ],
        has_more: false,
      });
    });
    const result = await runGroupActivity({
      settings: settingsWith(),
      runCommand,
      now: () => NOW_MS,
    });
    const messages = result.groupedByChat.oc_x ?? [];
    expect(messages.map((m) => m.messageId)).toEqual(["om_in"]);
  });

  it("includeReasons=[author] only runs the author pass", async () => {
    const runCommand = vi.fn(async () =>
      ok({
        messages: [cliMessage({ messageId: "om_a", chatId: "oc_a", senderOpenId: USER_OPEN_ID })],
        has_more: false,
      }),
    ) as unknown as RunCommandFn;
    const result = await runGroupActivity({
      settings: settingsWith(),
      runCommand,
      includeReasons: ["author"],
      now: () => NOW_MS,
    });
    expect(result.passes).toHaveLength(1);
    expect(result.passes[0]!.kind).toBe("author");
    expect((runCommand as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("detects auth-error stderr and surfaces the device-flow remediation hint", async () => {
    const runCommand = asRunCommand(async () =>
      fail({ stderr: "Error: not authorized; run auth device-flow first", code: 1 }),
    );
    const result = await runGroupActivity({
      settings: settingsWith(),
      runCommand,
      now: () => NOW_MS,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/device-flow/);
  });

  it("detects search:message scope error and surfaces scope-grant remediation hint", async () => {
    const runCommand = asRunCommand(async () =>
      fail({
        stderr: "scope_not_granted: search:message scope grant required",
        code: 1,
      }),
    );
    const result = await runGroupActivity({
      settings: settingsWith(),
      runCommand,
      now: () => NOW_MS,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/search:message/);
  });
});

describe("mondayMidnightUtcMs", () => {
  it("snaps a Thursday to the previous Monday 00:00 UTC", () => {
    const thu = Date.UTC(2026, 4, 28, 18, 0, 0);
    const mon = Date.UTC(2026, 4, 25, 0, 0, 0);
    expect(mondayMidnightUtcMs(thu)).toBe(mon);
  });

  it("snaps a Monday to itself at 00:00 UTC", () => {
    const mon = Date.UTC(2026, 4, 25, 14, 0, 0);
    expect(mondayMidnightUtcMs(mon)).toBe(Date.UTC(2026, 4, 25, 0, 0, 0));
  });

  it("with weekStartsOn=sunday, snaps to the previous Sunday 00:00 UTC", () => {
    const tue = Date.UTC(2026, 4, 26, 10, 0, 0);
    const sun = Date.UTC(2026, 4, 24, 0, 0, 0);
    expect(mondayMidnightUtcMs(tue, "sunday")).toBe(sun);
  });
});
