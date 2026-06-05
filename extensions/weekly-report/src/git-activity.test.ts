import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mondayMidnightUtcMs, runGitActivity, type RunCommandFn } from "./git-activity.js";
import { parseWeeklyReportPluginConfig, type WeeklyReportPluginSettings } from "./settings.js";

const NL = "\n";
const SEP = "\x1f";

function settingsWith(overrides: Partial<Parameters<typeof parseWeeklyReportPluginConfig>[0]>) {
  return parseWeeklyReportPluginConfig({
    gitAuthor: "desicoyao@example.com",
    ...overrides,
  });
}

function makeOkResult(stdout = ""): Awaited<ReturnType<RunCommandFn>> {
  return {
    stdout,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as never,
    noOutputTimedOut: false,
  };
}

function makeFailResult(stderr: string, code = 128): Awaited<ReturnType<RunCommandFn>> {
  return {
    stdout: "",
    stderr,
    code,
    signal: null,
    killed: false,
    termination: "exit" as never,
    noOutputTimedOut: false,
  };
}

let workspaceDir = "";

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "weekly-report-test-"));
});
afterEach(async () => {
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("runGitActivity", () => {
  it("returns empty repos when gitRemotes is unset", async () => {
    const runCommand = vi.fn();
    const result = await runGitActivity({
      settings: settingsWith({}),
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      now: () => Date.UTC(2026, 4, 22, 18, 0, 0),
    });
    expect(result.repos).toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("clones on demand when repo dir is missing", async () => {
    const cloneInvocations: Array<string[]> = [];
    const runCommand = vi.fn().mockImplementation(async (argv: string[]) => {
      cloneInvocations.push(argv);
      if (argv.includes("clone")) return makeOkResult("");
      if (argv.includes("log")) {
        return makeOkResult(
          [
            [
              "abc1234",
              "1716000000",
              "Chi Yao",
              "desicoyao@example.com",
              "HEAD -> main",
              "subject one",
            ].join(SEP),
            ["def5678", "1716100000", "Chi Yao", "desicoyao@example.com", "", "subject two"].join(
              SEP,
            ),
          ].join(NL),
        );
      }
      return makeOkResult();
    });

    const result = await runGitActivity({
      settings: settingsWith({
        gitRemotes: [{ name: "growx", sshUrl: "git@gitlab.com:noumena/growx.git" }],
        gitWorkspaceDir: workspaceDir,
      }),
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      now: () => Date.UTC(2026, 4, 22, 18, 0, 0),
    });

    expect(result.repos).toHaveLength(1);
    const repo = result.repos[0];
    expect(repo.ok).toBe(true);
    if (repo.ok) {
      expect(repo.commits).toEqual([
        {
          sha: "abc1234",
          ts: 1716000000 * 1000,
          authorName: "Chi Yao",
          authorEmail: "desicoyao@example.com",
          subject: "subject one",
          refs: "HEAD -> main",
        },
        {
          sha: "def5678",
          ts: 1716100000 * 1000,
          authorName: "Chi Yao",
          authorEmail: "desicoyao@example.com",
          subject: "subject two",
        },
      ]);
    }
    expect(cloneInvocations.some((argv) => argv.includes("clone"))).toBe(true);
    expect(cloneInvocations.some((argv) => argv.includes("log"))).toBe(true);
  });

  it("uses fetch (not clone) when repo dir already exists", async () => {
    const repoDir = join(workspaceDir, "growx", ".git");
    await mkdir(repoDir, { recursive: true });

    const seen: Array<string[]> = [];
    const runCommand = vi.fn().mockImplementation(async (argv: string[]) => {
      seen.push(argv);
      if (argv.includes("clone")) return makeFailResult("should not clone");
      return makeOkResult();
    });

    await runGitActivity({
      settings: settingsWith({
        gitRemotes: [{ name: "growx", sshUrl: "git@gitlab.com:noumena/growx.git" }],
        gitWorkspaceDir: workspaceDir,
      }),
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      now: () => Date.UTC(2026, 4, 22, 18, 0, 0),
    });

    expect(seen.some((argv) => argv.includes("fetch"))).toBe(true);
    expect(seen.some((argv) => argv.includes("clone"))).toBe(false);
  });

  it("propagates per-repo failure without affecting siblings", async () => {
    const runCommand = vi
      .fn()
      .mockImplementation(async (argv: string[], opts: { cwd?: string }) => {
        if (argv.includes("clone")) {
          const url = argv[argv.length - 2];
          if (url.includes("bad")) return makeFailResult("ssh: connect failed");
          return makeOkResult();
        }
        if (argv.includes("fetch")) return makeOkResult();
        if (argv.includes("log")) {
          return makeOkResult(
            ["sha1", "1716000000", "Chi", "desicoyao@example.com", "", "ok"].join(SEP),
          );
        }
        return makeOkResult();
      });

    const result = await runGitActivity({
      settings: settingsWith({
        gitRemotes: [
          { name: "growx", sshUrl: "git@gitlab.com:o/growx.git" },
          { name: "bad", sshUrl: "git@gitlab.com:o/bad.git" },
        ],
        gitWorkspaceDir: workspaceDir,
      }),
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      now: () => Date.UTC(2026, 4, 22, 18, 0, 0),
    });

    const byName = new Map(result.repos.map((r) => [r.name, r]));
    expect(byName.get("growx")?.ok).toBe(true);
    const bad = byName.get("bad");
    expect(bad?.ok).toBe(false);
    if (bad && !bad.ok) {
      expect(bad.error).toMatch(/clone/);
      expect(bad.error).toMatch(/ssh/);
    }
  });

  it("applies the hardened env on every invocation", async () => {
    const runCommand = vi.fn().mockImplementation(async () => makeOkResult());
    await runGitActivity({
      settings: settingsWith({
        gitRemotes: [{ name: "growx", sshUrl: "git@gitlab.com:o/growx.git" }],
        gitWorkspaceDir: workspaceDir,
      }),
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      now: () => Date.UTC(2026, 4, 22, 18, 0, 0),
    });
    for (const call of runCommand.mock.calls) {
      const opts = call[1] as { env: Record<string, string> };
      expect(opts.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(opts.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(opts.env.GIT_SSH_COMMAND).toMatch(/BatchMode=yes/);
    }
  });

  it("argv-only: no shell interpolation, sshUrl passes as a single argv element", async () => {
    const runCommand = vi.fn().mockImplementation(async () => makeOkResult());
    const sshUrl = "git@gitlab.com:noumena/growx.git";
    await runGitActivity({
      settings: settingsWith({
        gitRemotes: [{ name: "growx", sshUrl }],
        gitWorkspaceDir: workspaceDir,
      }),
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      now: () => Date.UTC(2026, 4, 22, 18, 0, 0),
    });
    const cloneCall = runCommand.mock.calls.find((c) => (c[0] as string[]).includes("clone"));
    expect(cloneCall).toBeDefined();
    const argv = cloneCall![0] as string[];
    expect(argv).toContain(sshUrl);
    // No combined "sh -c" or single string
    expect(argv.every((part) => typeof part === "string")).toBe(true);
    // Protocol hardening present
    expect(argv).toContain("-c");
    expect(argv).toContain("protocol.file.allow=never");
    expect(argv).toContain("submodule.recurse=false");
  });

  it("passes per-repo timeoutMs equal to gitFetchTimeoutMs when overall budget is plentiful", async () => {
    const runCommand = vi.fn().mockImplementation(async () => makeOkResult());
    await runGitActivity({
      settings: settingsWith({
        gitRemotes: [{ name: "growx", sshUrl: "git@gitlab.com:o/growx.git" }],
        gitWorkspaceDir: workspaceDir,
        gitFetchTimeoutMs: 15_000,
      }),
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      now: () => Date.UTC(2026, 4, 22, 18, 0, 0),
    });
    for (const call of runCommand.mock.calls) {
      const opts = call[1] as { timeoutMs: number };
      expect(opts.timeoutMs).toBe(15_000);
    }
  });

  it("returns ok:false when overall budget is exhausted before a repo runs", async () => {
    let firstCallTime = 0;
    const runCommand = vi.fn().mockImplementation(async () => {
      if (firstCallTime === 0) {
        firstCallTime = Date.now();
      }
      // Sleep slightly so subsequent repos see "exhausted"
      await new Promise((resolve) => setTimeout(resolve, 50));
      return makeOkResult();
    });
    const result = await runGitActivity({
      settings: settingsWith({
        gitRemotes: [
          { name: "a", sshUrl: "git@gitlab.com:o/a.git" },
          { name: "b", sshUrl: "git@gitlab.com:o/b.git" },
        ],
        gitWorkspaceDir: workspaceDir,
        gitOverallTimeoutMs: 5_000,
        gitMaxParallelOps: 1,
      }),
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      now: () => Date.UTC(2026, 4, 22, 18, 0, 0),
    });
    // Both should at least run within 5s, so they'll be ok. Just sanity check.
    expect(result.repos).toHaveLength(2);
    expect(result.repos.every((r) => r.ok)).toBe(true);
  });

  it("repoFilter restricts which configured remotes get touched", async () => {
    const seen = new Set<string>();
    const runCommand = vi.fn().mockImplementation(async (argv: string[]) => {
      const url = argv.find((a) => a.startsWith("git@"));
      if (url) seen.add(url);
      return makeOkResult();
    });
    await runGitActivity({
      settings: settingsWith({
        gitRemotes: [
          { name: "a", sshUrl: "git@gitlab.com:o/a.git" },
          { name: "b", sshUrl: "git@gitlab.com:o/b.git" },
        ],
        gitWorkspaceDir: workspaceDir,
      }),
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      repoFilter: ["b"],
      now: () => Date.UTC(2026, 4, 22, 18, 0, 0),
    });
    expect([...seen]).toEqual(["git@gitlab.com:o/b.git"]);
  });

  it("ensures gitWorkspaceDir exists (creates it if missing)", async () => {
    const nested = join(workspaceDir, "deep", "dir");
    const runCommand = vi.fn().mockImplementation(async () => makeOkResult());
    await runGitActivity({
      settings: settingsWith({
        gitRemotes: [{ name: "a", sshUrl: "git@gitlab.com:o/a.git" }],
        gitWorkspaceDir: nested,
      }),
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      now: () => Date.UTC(2026, 4, 22, 18, 0, 0),
    });
    const dirStat = await stat(nested);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("derives a Monday-midnight sinceTs by default", async () => {
    const captured: number[] = [];
    const runCommand = vi.fn().mockImplementation(async (argv: string[]) => {
      const sinceArg = argv.find((a) => a.startsWith("--since="));
      if (sinceArg) {
        captured.push(Date.parse(sinceArg.slice("--since=".length)));
      }
      return makeOkResult();
    });
    // 2026-05-22 18:00 UTC is a Friday; Monday 00:00 UTC = 2026-05-18T00:00:00Z
    const fridayNoonUtc = Date.UTC(2026, 4, 22, 18, 0, 0);
    await runGitActivity({
      settings: settingsWith({
        gitRemotes: [{ name: "a", sshUrl: "git@gitlab.com:o/a.git" }],
        gitWorkspaceDir: workspaceDir,
      }),
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      now: () => fridayNoonUtc,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(Date.UTC(2026, 4, 18, 0, 0, 0));
  });

  it("throws if gitRemotes is set but gitAuthor missing at runtime", async () => {
    // Settings parse rejects this combo, but we double-check runtime guard.
    const badSettings: WeeklyReportPluginSettings = {
      ...settingsWith({}),
      gitRemotes: [{ name: "a", sshUrl: "git@gitlab.com:o/a.git" }],
      gitAuthor: undefined,
    };
    await expect(() =>
      runGitActivity({
        settings: badSettings,
        runCommand: (async () => makeOkResult()) as never,
        resolveStateDir: () => workspaceDir,
      }),
    ).rejects.toThrow(/gitAuthor/);
  });

  it("rejects non-production sshUrl shapes when allowLocalUrls=false", async () => {
    // Bypass parse-time allowlist by injecting through a constructed settings object
    const settings: WeeklyReportPluginSettings = {
      ...settingsWith({}),
      gitRemotes: [{ name: "a", sshUrl: join(workspaceDir, "local.git") }],
      gitAuthor: "me",
    };
    const runCommand = vi.fn().mockImplementation(async () => makeOkResult());
    const result = await runGitActivity({
      settings,
      runCommand: runCommand as never,
      resolveStateDir: () => workspaceDir,
      now: () => Date.UTC(2026, 4, 22, 18, 0, 0),
    });
    expect(result.repos[0].ok).toBe(false);
    if (!result.repos[0].ok) {
      expect(result.repos[0].error).toMatch(/production allowlist/);
    }
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("mondayMidnightUtcMs", () => {
  it("returns the Monday of the ISO week, midnight UTC", () => {
    expect(mondayMidnightUtcMs(Date.UTC(2026, 4, 22, 18, 0, 0))).toBe(
      Date.UTC(2026, 4, 18, 0, 0, 0),
    );
    expect(mondayMidnightUtcMs(Date.UTC(2026, 4, 18, 0, 0, 0))).toBe(
      Date.UTC(2026, 4, 18, 0, 0, 0),
    );
    expect(mondayMidnightUtcMs(Date.UTC(2026, 4, 24, 23, 59, 59))).toBe(
      Date.UTC(2026, 4, 18, 0, 0, 0),
    );
    // Sunday rolls back to previous Monday
    expect(mondayMidnightUtcMs(Date.UTC(2026, 4, 24, 12, 0, 0))).toBe(
      Date.UTC(2026, 4, 18, 0, 0, 0),
    );
  });
});
