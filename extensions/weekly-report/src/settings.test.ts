import { describe, expect, it } from "vitest";
import {
  deriveUserOpenIdFromSessionKey,
  parseWeeklyReportPluginConfig,
  validateGitRemoteSpec,
} from "./settings.js";

const REAL_OPEN_ID = "ou_f95d535ac705bf89608914906e339424";
const BOT_OPEN_ID = "ou_botaccount0123456789abcdef0123";
const REAL_DIRECT_SESSION_KEY = `agent:silver-chariot:feishu:direct:${REAL_OPEN_ID}`;

describe("parseWeeklyReportPluginConfig", () => {
  it("returns defaults when nothing is supplied", () => {
    const result = parseWeeklyReportPluginConfig({});
    expect(result).toEqual({
      targetDocToken: undefined,
      recipientSessionKey: undefined,
      reminderAfterDays: 3,
      failAfterDays: 7,
      weekStartsOn: "monday",
      sweeperIntervalMs: 60 * 60 * 1000,
      gitRemotes: [],
      gitAuthor: undefined,
      gitWorkspaceDir: undefined,
      gitFetchTimeoutMs: 30_000,
      gitMaxCommitsPerRepo: 200,
      gitHostAllowlist: ["gitlab.com", "github.com"],
      gitMaxParallelOps: 3,
      gitMaxRepoCount: 10,
      gitOverallTimeoutMs: 120_000,
      userOpenId: undefined,
      botOpenId: undefined,
      groupDenylist: [],
      groupMaxMessagesPerPass: 200,
      larkCliBinPath: "larkcli",
      larkCliAccountId: undefined,
      larkCliTimeoutMs: 30_000,
      larkCliMaxPages: 4,
      larkOfficialCliBinPath: "lark-cli",
      larkOfficialCliTimeoutMs: 30_000,
      docIdentity: "user",
    });
  });

  it("accepts docIdentity=bot and rejects anything else", () => {
    expect(parseWeeklyReportPluginConfig({ docIdentity: "bot" }).docIdentity).toBe("bot");
    expect(parseWeeklyReportPluginConfig({ docIdentity: "user" }).docIdentity).toBe("user");
    expect(() => parseWeeklyReportPluginConfig({ docIdentity: "admin" })).toThrow(/docIdentity/);
  });

  it("accepts a fully populated config", () => {
    const result = parseWeeklyReportPluginConfig({
      targetDocToken: "Kes2d3MG2orxhdxykCDcLhmunkg",
      recipientSessionKey: "agent:silver-chariot:feishu:direct:ou_xxx",
      reminderAfterDays: 2,
      failAfterDays: 5,
      weekStartsOn: "monday",
      sweeperIntervalMs: 5 * 60 * 1000,
      gitRemotes: [{ name: "growx", sshUrl: "git@gitlab.com:noumena/growx.git" }],
      gitAuthor: "desicoyao@example.com",
    });
    expect(result.targetDocToken).toBe("Kes2d3MG2orxhdxykCDcLhmunkg");
    expect(result.gitRemotes).toEqual([
      { name: "growx", sshUrl: "git@gitlab.com:noumena/growx.git" },
    ]);
    expect(result.gitAuthor).toBe("desicoyao@example.com");
  });

  it("rejects failAfterDays not strictly greater than reminderAfterDays", () => {
    expect(() => parseWeeklyReportPluginConfig({ reminderAfterDays: 5, failAfterDays: 5 })).toThrow(
      /strictly greater/,
    );
    expect(() => parseWeeklyReportPluginConfig({ reminderAfterDays: 7, failAfterDays: 3 })).toThrow(
      /strictly greater/,
    );
  });

  it("rejects non-integer reminderAfterDays", () => {
    expect(() => parseWeeklyReportPluginConfig({ reminderAfterDays: 2.5 })).toThrow(
      /positive integer/,
    );
  });

  it("trims blank strings to undefined", () => {
    const result = parseWeeklyReportPluginConfig({
      targetDocToken: "   ",
      recipientSessionKey: "",
    });
    expect(result.targetDocToken).toBeUndefined();
    expect(result.recipientSessionKey).toBeUndefined();
  });

  it("rejects gitRemotes without gitAuthor", () => {
    expect(() =>
      parseWeeklyReportPluginConfig({
        gitRemotes: [{ name: "x", sshUrl: "git@gitlab.com:o/x.git" }],
      }),
    ).toThrow(/gitAuthor is required/);
  });

  it("rejects gitRemotes exceeding gitMaxRepoCount", () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      name: `repo${i}`,
      sshUrl: `git@gitlab.com:o/repo${i}.git`,
    }));
    expect(() =>
      parseWeeklyReportPluginConfig({ gitRemotes: tooMany, gitAuthor: "me", gitMaxRepoCount: 5 }),
    ).toThrow(/cap is gitMaxRepoCount/);
  });

  it("rejects duplicate gitRemotes names", () => {
    expect(() =>
      parseWeeklyReportPluginConfig({
        gitRemotes: [
          { name: "x", sshUrl: "git@gitlab.com:o/x.git" },
          { name: "x", sshUrl: "git@gitlab.com:o/y.git" },
        ],
        gitAuthor: "me",
      }),
    ).toThrow(/duplicate name/);
  });

  it("rejects gitFetchTimeoutMs below 1000", () => {
    expect(() => parseWeeklyReportPluginConfig({ gitFetchTimeoutMs: 500 })).toThrow(
      /integer >= 1000/,
    );
  });

  it("preserves a custom gitHostAllowlist", () => {
    const result = parseWeeklyReportPluginConfig({
      gitHostAllowlist: ["gitlab.internal.example.com"],
    });
    expect(result.gitHostAllowlist).toEqual(["gitlab.internal.example.com"]);
  });

  // v3 — group collection config

  it("auto-derives userOpenId from recipientSessionKey :direct: suffix", () => {
    const result = parseWeeklyReportPluginConfig({
      recipientSessionKey: REAL_DIRECT_SESSION_KEY,
    });
    expect(result.userOpenId).toBe(REAL_OPEN_ID);
  });

  it("leaves userOpenId undefined when recipientSessionKey doesn't match :direct:<open_id>", () => {
    const result = parseWeeklyReportPluginConfig({
      recipientSessionKey: "agent:silver:feishu:group:oc_someGroup",
    });
    expect(result.userOpenId).toBeUndefined();
  });

  it("prefers explicit userOpenId over auto-derived", () => {
    const explicit = "ou_alternateopenid0123456789abcdef";
    const result = parseWeeklyReportPluginConfig({
      recipientSessionKey: REAL_DIRECT_SESSION_KEY,
      userOpenId: explicit,
    });
    expect(result.userOpenId).toBe(explicit);
  });

  it("rejects userOpenId not matching Feishu open_id shape", () => {
    expect(() => parseWeeklyReportPluginConfig({ userOpenId: "not_an_open_id" })).toThrow(
      /open_id shape/,
    );
    expect(() => parseWeeklyReportPluginConfig({ userOpenId: "ou_short" })).toThrow(
      /open_id shape/,
    );
  });

  it("rejects botOpenId not matching Feishu open_id shape", () => {
    expect(() => parseWeeklyReportPluginConfig({ botOpenId: "cli_botappid" })).toThrow(
      /open_id shape/,
    );
  });

  it("accepts botOpenId in canonical shape", () => {
    const result = parseWeeklyReportPluginConfig({ botOpenId: BOT_OPEN_ID });
    expect(result.botOpenId).toBe(BOT_OPEN_ID);
  });

  it("accepts groupDenylist as a string array, trims and drops empties", () => {
    const result = parseWeeklyReportPluginConfig({
      groupDenylist: ["oc_groupA", "  oc_groupB  ", ""],
    });
    expect(result.groupDenylist).toEqual(["oc_groupA", "oc_groupB"]);
  });

  it("rejects groupDenylist with non-string entries", () => {
    expect(() => parseWeeklyReportPluginConfig({ groupDenylist: ["ok", 42 as never] })).toThrow(
      /groupDenylist\[1\] must be a string/,
    );
  });

  // v4 — lark-cli fields

  it("accepts the lark-cli config block", () => {
    const result = parseWeeklyReportPluginConfig({
      larkCliBinPath: "/usr/local/bin/larkcli",
      larkCliAccountId: "silver-chariot",
      larkCliTimeoutMs: 45_000,
      larkCliMaxPages: 8,
      groupMaxMessagesPerPass: 100,
    });
    expect(result.larkCliBinPath).toBe("/usr/local/bin/larkcli");
    expect(result.larkCliAccountId).toBe("silver-chariot");
    expect(result.larkCliTimeoutMs).toBe(45_000);
    expect(result.larkCliMaxPages).toBe(8);
    expect(result.groupMaxMessagesPerPass).toBe(100);
  });

  it("rejects larkCliTimeoutMs below 1000", () => {
    expect(() => parseWeeklyReportPluginConfig({ larkCliTimeoutMs: 500 })).toThrow(
      /integer >= 1000/,
    );
  });

  it("rejects larkCliMaxPages of 0", () => {
    expect(() => parseWeeklyReportPluginConfig({ larkCliMaxPages: 0 })).toThrow(/positive integer/);
  });

  it("rejects groupMaxMessagesPerPass of 0", () => {
    expect(() => parseWeeklyReportPluginConfig({ groupMaxMessagesPerPass: 0 })).toThrow(
      /positive integer/,
    );
  });
});

describe("deriveUserOpenIdFromSessionKey", () => {
  it("extracts the open_id from a canonical Feishu direct sessionKey", () => {
    expect(deriveUserOpenIdFromSessionKey(REAL_DIRECT_SESSION_KEY)).toBe(REAL_OPEN_ID);
  });

  it("returns undefined for a group sessionKey", () => {
    expect(
      deriveUserOpenIdFromSessionKey("agent:silver:feishu:group:oc_someGroup"),
    ).toBeUndefined();
  });

  it("returns undefined when the suffix doesn't pass open_id regex (too short)", () => {
    expect(deriveUserOpenIdFromSessionKey("agent:x:feishu:direct:ou_x")).toBeUndefined();
  });

  it("returns undefined for undefined / empty / non-feishu inputs", () => {
    expect(deriveUserOpenIdFromSessionKey(undefined)).toBeUndefined();
    expect(deriveUserOpenIdFromSessionKey("")).toBeUndefined();
    expect(deriveUserOpenIdFromSessionKey("agent:silver:telegram:direct:123456")).toBeUndefined();
  });
});

describe("validateGitRemoteSpec", () => {
  const allowed = ["gitlab.com", "github.com"];

  it("accepts canonical scp-style ssh URL", () => {
    expect(
      validateGitRemoteSpec(
        { name: "growx", sshUrl: "git@gitlab.com:noumena/growx.git" },
        0,
        allowed,
      ),
    ).toEqual({ name: "growx", sshUrl: "git@gitlab.com:noumena/growx.git" });
  });

  it("rejects file:// URL", () => {
    expect(() =>
      validateGitRemoteSpec({ name: "x", sshUrl: "file:///etc/passwd" }, 0, allowed),
    ).toThrow(/scp-style/);
  });

  it("rejects ssh:// URL", () => {
    expect(() =>
      validateGitRemoteSpec({ name: "x", sshUrl: "ssh://git@gitlab.com:22/x.git" }, 0, allowed),
    ).toThrow(/scp-style/);
  });

  it("rejects host not on allowlist", () => {
    expect(() =>
      validateGitRemoteSpec({ name: "x", sshUrl: "git@evil.example:o/x.git" }, 0, allowed),
    ).toThrow(/not in gitHostAllowlist/);
  });

  it("rejects forbidden substrings", () => {
    expect(() =>
      validateGitRemoteSpec({ name: "x", sshUrl: "git@gitlab.com:o/x` rm -rf /`.git" }, 0, allowed),
    ).toThrow(/forbidden substring/);
    expect(() =>
      validateGitRemoteSpec({ name: "x", sshUrl: "git@gitlab.com:o/../x.git" }, 0, allowed),
    ).toThrow(/forbidden substring/);
    expect(() =>
      validateGitRemoteSpec(
        { name: "x", sshUrl: "git@gitlab.com:o/x --upload-pack=evil.git" },
        0,
        allowed,
      ),
    ).toThrow(/forbidden substring/);
  });

  it("rejects name with traversal characters", () => {
    expect(() =>
      validateGitRemoteSpec({ name: "../escape", sshUrl: "git@gitlab.com:o/x.git" }, 0, allowed),
    ).toThrow(/must match/);
  });

  it("rejects name with uppercase or dots", () => {
    expect(() =>
      validateGitRemoteSpec({ name: "Foo", sshUrl: "git@gitlab.com:o/x.git" }, 0, allowed),
    ).toThrow(/must match/);
    expect(() =>
      validateGitRemoteSpec({ name: "foo.bar", sshUrl: "git@gitlab.com:o/x.git" }, 0, allowed),
    ).toThrow(/must match/);
  });
});
