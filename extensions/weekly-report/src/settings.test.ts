import { describe, expect, it } from "vitest";
import { parseWeeklyReportPluginConfig, validateGitRemoteSpec } from "./settings.js";

describe("parseWeeklyReportPluginConfig", () => {
  it("returns defaults when nothing is supplied", () => {
    const result = parseWeeklyReportPluginConfig({});
    expect(result).toEqual({
      targetDocToken: undefined,
      recipientSessionKey: undefined,
      reminderAfterDays: 3,
      failAfterDays: 7,
      notesDocToken: undefined,
      draftPromptOverride: undefined,
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
    });
  });

  it("accepts a fully populated config", () => {
    const result = parseWeeklyReportPluginConfig({
      targetDocToken: "Kes2d3MG2orxhdxykCDcLhmunkg",
      recipientSessionKey: "agent:silver-chariot:feishu:direct:ou_xxx",
      reminderAfterDays: 2,
      failAfterDays: 5,
      notesDocToken: "NotesDocToken123",
      draftPromptOverride: "Custom drafting prompt",
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
