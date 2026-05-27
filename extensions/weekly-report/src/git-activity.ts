/**
 * Git-activity runner for the weekly-report drafting phase.
 *
 * Per the v2 plan (decisions 14-20):
 *  - argv-only invocations; never construct a shell command string.
 *  - GIT_TERMINAL_PROMPT=0 + GIT_CONFIG_NOSYSTEM=1 + -c protocol.{file,ext}.allow=never
 *    -c submodule.recurse=false to disable risky protocol shims and hooks.
 *  - Clone-on-demand into `{gitWorkspaceDir}/{name}/` (shallow, blobless, no tags).
 *  - Per-repo timeouts via `gitFetchTimeoutMs`, parallelism cap via `gitMaxParallelOps`,
 *    overall budget via `gitOverallTimeoutMs`.
 *  - Per-repo failure → `{ok: false, error}`; tool never throws and never fails the TaskFlow.
 *  - URL allowlist + name regex are enforced at config-parse time (settings.ts), so by the time
 *    we get here we trust the spec shapes. We still validate the workspace directory exists or
 *    is creatable, and we still wrap every exec in a timeout.
 */

import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { GitRemoteSpec, WeeklyReportPluginSettings } from "./settings.js";

export type GitCommitRecord = {
  sha: string;
  ts: number;
  authorName: string;
  authorEmail: string;
  subject: string;
  refs?: string;
};

export type GitActivityRepoResult =
  | {
      name: string;
      sshUrl: string;
      ok: true;
      commits: GitCommitRecord[];
    }
  | {
      name: string;
      sshUrl: string;
      ok: false;
      error: string;
    };

export type GitActivityResult = {
  windowStart: number;
  windowEnd: number;
  repos: GitActivityRepoResult[];
};

export type RunCommandFn = PluginRuntime["system"]["runCommandWithTimeout"];

export type RunGitActivityParams = {
  settings: WeeklyReportPluginSettings;
  runCommand: RunCommandFn;
  resolveStateDir: () => string;
  /** Override window. Defaults: sinceTs = Monday 00:00 UTC of the current week; untilTs = now. */
  sinceTs?: number;
  untilTs?: number;
  /** Optional subset filter by `name`. */
  repoFilter?: string[];
  /** Test-only escape hatch: when true, skip the production sshUrl shape check. */
  allowLocalUrls?: boolean;
  /** Override clock for tests. */
  now?: () => number;
};

const GIT_BIN = "git";
const COMMIT_FORMAT = "%H%x1f%ct%x1f%an%x1f%ae%x1f%D%x1f%s";
const SAFE_PROTOCOL_FLAGS = [
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "submodule.recurse=false",
];

function hardenedEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    // SSH session: never spawn a TTY/askpass, and prefer batch mode.
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function formatExecError(label: string, result: Awaited<ReturnType<RunCommandFn>>): string {
  const trailer = result.stderr.trim() || result.stdout.trim() || `code=${result.code}`;
  const reason = result.noOutputTimedOut
    ? "no-output timeout"
    : result.termination === "signal"
      ? `killed (${result.signal ?? "SIGTERM"})`
      : `exit ${result.code}`;
  return `${label}: ${reason} — ${trimTo(trailer, 240)}`;
}

function trimTo(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function parseGitLogOutput(stdout: string): GitCommitRecord[] {
  if (!stdout) return [];
  const records: GitCommitRecord[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("");
    if (parts.length < 6) continue;
    const ctSeconds = Number(parts[1]);
    if (!Number.isFinite(ctSeconds)) continue;
    const refs = parts[4].trim();
    const record: GitCommitRecord = {
      sha: parts[0],
      ts: ctSeconds * 1000,
      authorName: parts[2],
      authorEmail: parts[3],
      subject: parts[5],
    };
    if (refs) record.refs = refs;
    records.push(record);
  }
  return records;
}

function buildLogArgs(params: {
  author: string;
  sinceIso: string;
  untilIso: string;
  maxCommits: number;
  includeMerges: boolean;
}): string[] {
  return [
    ...SAFE_PROTOCOL_FLAGS,
    "log",
    `--author=${params.author}`,
    `--since=${params.sinceIso}`,
    `--until=${params.untilIso}`,
    `--max-count=${params.maxCommits}`,
    "--all",
    params.includeMerges ? "--merges" : "--no-merges",
    `--format=${COMMIT_FORMAT}`,
  ];
}

function buildCloneArgs(sshUrl: string, dest: string): string[] {
  return [
    ...SAFE_PROTOCOL_FLAGS,
    "clone",
    "--depth=200",
    "--no-tags",
    "--filter=blob:none",
    "--quiet",
    sshUrl,
    dest,
  ];
}

const FETCH_ARGS: string[] = [...SAFE_PROTOCOL_FLAGS, "fetch", "--all", "--prune", "--quiet"];

function isProductionSshUrl(sshUrl: string): boolean {
  return /^[A-Za-z0-9_-]+@[A-Za-z0-9.-]+:[\w./-]+\.git$/u.test(sshUrl);
}

export async function runGitActivity(params: RunGitActivityParams): Promise<GitActivityResult> {
  const {
    settings,
    runCommand,
    resolveStateDir,
    repoFilter,
    allowLocalUrls = false,
    now = Date.now,
  } = params;

  const nowMs = now();
  const sinceTs = params.sinceTs ?? mondayMidnightUtcMs(nowMs);
  const untilTs = params.untilTs ?? nowMs;

  if (settings.gitRemotes.length === 0) {
    return { windowStart: sinceTs, windowEnd: untilTs, repos: [] };
  }
  if (!settings.gitAuthor) {
    throw new Error("gitAuthor is not configured");
  }

  const workspaceDir =
    settings.gitWorkspaceDir ?? join(resolveStateDir(), "weekly-report", "repos");
  await ensureDir(workspaceDir);

  const filterSet = repoFilter ? new Set(repoFilter) : null;
  const eligibleRemotes = settings.gitRemotes.filter(
    (remote) => !filterSet || filterSet.has(remote.name),
  );

  const ctx: PerRepoContext = {
    workspaceDir,
    author: settings.gitAuthor,
    sinceIso: new Date(sinceTs).toISOString(),
    untilIso: new Date(untilTs).toISOString(),
    maxCommits: settings.gitMaxCommitsPerRepo,
    fetchTimeoutMs: settings.gitFetchTimeoutMs,
    runCommand,
    overallDeadlineMs: nowMs + settings.gitOverallTimeoutMs,
    allowLocalUrls,
    now,
  };

  const results: GitActivityRepoResult[] = new Array(eligibleRemotes.length);
  const parallelism = Math.max(1, Math.min(settings.gitMaxParallelOps, eligibleRemotes.length));
  let cursor = 0;

  const workers = Array.from({ length: parallelism }, async () => {
    for (;;) {
      const myIndex = cursor++;
      if (myIndex >= eligibleRemotes.length) return;
      const remote = eligibleRemotes[myIndex];
      results[myIndex] = await processRepo(remote, ctx);
    }
  });
  await Promise.all(workers);

  return { windowStart: sinceTs, windowEnd: untilTs, repos: results };
}

type PerRepoContext = {
  workspaceDir: string;
  author: string;
  sinceIso: string;
  untilIso: string;
  maxCommits: number;
  fetchTimeoutMs: number;
  runCommand: RunCommandFn;
  overallDeadlineMs: number;
  allowLocalUrls: boolean;
  now: () => number;
};

async function processRepo(
  remote: GitRemoteSpec,
  ctx: PerRepoContext,
): Promise<GitActivityRepoResult> {
  const repoDir = join(ctx.workspaceDir, remote.name);
  try {
    if (!ctx.allowLocalUrls && !isProductionSshUrl(remote.sshUrl)) {
      return {
        name: remote.name,
        sshUrl: remote.sshUrl,
        ok: false,
        error: "sshUrl rejected by production allowlist",
      };
    }

    const remainingBudget = Math.max(0, ctx.overallDeadlineMs - ctx.now());
    if (remainingBudget <= 0) {
      return {
        name: remote.name,
        sshUrl: remote.sshUrl,
        ok: false,
        error: "gitOverallTimeoutMs exhausted before repo could run",
      };
    }
    const stepTimeout = Math.min(ctx.fetchTimeoutMs, remainingBudget);

    const exists = await pathExists(join(repoDir, ".git"));
    if (!exists) {
      const cloneRes = await ctx.runCommand([GIT_BIN, ...buildCloneArgs(remote.sshUrl, repoDir)], {
        timeoutMs: stepTimeout,
        env: hardenedEnv(),
      });
      if (cloneRes.code !== 0) {
        return {
          name: remote.name,
          sshUrl: remote.sshUrl,
          ok: false,
          error: formatExecError("clone", cloneRes),
        };
      }
    } else {
      const fetchRes = await ctx.runCommand([GIT_BIN, ...FETCH_ARGS], {
        timeoutMs: stepTimeout,
        cwd: repoDir,
        env: hardenedEnv(),
      });
      if (fetchRes.code !== 0) {
        return {
          name: remote.name,
          sshUrl: remote.sshUrl,
          ok: false,
          error: formatExecError("fetch", fetchRes),
        };
      }
    }

    const logRes = await ctx.runCommand(
      [
        GIT_BIN,
        ...buildLogArgs({
          author: ctx.author,
          sinceIso: ctx.sinceIso,
          untilIso: ctx.untilIso,
          maxCommits: ctx.maxCommits,
          includeMerges: false,
        }),
      ],
      { timeoutMs: stepTimeout, cwd: repoDir, env: hardenedEnv() },
    );
    if (logRes.code !== 0) {
      return {
        name: remote.name,
        sshUrl: remote.sshUrl,
        ok: false,
        error: formatExecError("log", logRes),
      };
    }
    const commits = parseGitLogOutput(logRes.stdout);
    return { name: remote.name, sshUrl: remote.sshUrl, ok: true, commits };
  } catch (err) {
    return {
      name: remote.name,
      sshUrl: remote.sshUrl,
      ok: false,
      error: `unexpected: ${(err as Error).message}`,
    };
  }
}

async function ensureDir(path: string): Promise<void> {
  if (await pathExists(path)) return;
  await mkdir(path, { recursive: true });
  await mkdir(dirname(path), { recursive: true });
}

function mondayMidnightUtcMs(refMs: number): number {
  const d = new Date(refMs);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const isoDayIndex = day === 0 ? 7 : day; // 1=Mon..7=Sun
  d.setUTCDate(d.getUTCDate() - (isoDayIndex - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export { mondayMidnightUtcMs };
