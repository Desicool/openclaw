/**
 * Plugin config schema + parser. Validates and normalizes `api.pluginConfig` into a typed
 * settings object. Hard requirements throw at parse time; optional values get explicit defaults.
 *
 * v2 adds the git-activity fact source. The git fields default to "disabled" — empty gitRemotes
 * means the plugin does not touch git at all. If gitRemotes is non-empty, gitAuthor MUST be set
 * and every remote MUST pass URL + name validation before any subprocess can be considered.
 */

import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import type { WeekStartsOn } from "./week-key.js";

export type GitRemoteSpec = {
  name: string;
  sshUrl: string;
};

export type WeeklyReportPluginSettings = {
  targetDocToken: string | undefined;
  recipientSessionKey: string | undefined;
  reminderAfterDays: number;
  failAfterDays: number;
  notesDocToken: string | undefined;
  draftPromptOverride: string | undefined;
  weekStartsOn: WeekStartsOn;
  sweeperIntervalMs: number;
  gitRemotes: GitRemoteSpec[];
  gitAuthor: string | undefined;
  gitWorkspaceDir: string | undefined;
  gitFetchTimeoutMs: number;
  gitMaxCommitsPerRepo: number;
  gitHostAllowlist: string[];
  gitMaxParallelOps: number;
  gitMaxRepoCount: number;
  gitOverallTimeoutMs: number;
};

const DEFAULT_REMINDER_DAYS = 3;
const DEFAULT_FAIL_DAYS = 7;
const DEFAULT_WEEK_STARTS_ON: WeekStartsOn = "monday";
const ONE_HOUR_MS = 60 * 60 * 1000;

const DEFAULT_GIT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_GIT_MAX_COMMITS_PER_REPO = 200;
const DEFAULT_GIT_HOST_ALLOWLIST = ["gitlab.com", "github.com"] as const;
const DEFAULT_GIT_MAX_PARALLEL_OPS = 3;
const DEFAULT_GIT_MAX_REPO_COUNT = 10;
const DEFAULT_GIT_OVERALL_TIMEOUT_MS = 120_000;

const GIT_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const GIT_HOST_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/u;
// scp-style ssh: user@host:path/to/repo.git
const GIT_SSH_URL_REGEX = /^[A-Za-z0-9_-]+@([A-Za-z0-9._-]+):([\w./-]+)\.git$/u;
const FORBIDDEN_URL_SUBSTRINGS = ["..", "--", "`", "$", " ", "\t", "\n", "\r"];

export const weeklyReportConfigSchema = buildJsonPluginConfigSchema({
  type: "object",
  additionalProperties: false,
  properties: {
    targetDocToken: { type: "string" },
    recipientSessionKey: { type: "string" },
    reminderAfterDays: { type: "integer", minimum: 1 },
    failAfterDays: { type: "integer", minimum: 1 },
    notesDocToken: { type: "string" },
    draftPromptOverride: { type: "string" },
    weekStartsOn: { type: "string", enum: ["monday", "sunday"] },
    sweeperIntervalMs: { type: "integer", minimum: 60_000 },
    gitRemotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "sshUrl"],
        properties: {
          name: { type: "string" },
          sshUrl: { type: "string" },
        },
      },
    },
    gitAuthor: { type: "string" },
    gitWorkspaceDir: { type: "string" },
    gitFetchTimeoutMs: { type: "integer", minimum: 1_000 },
    gitMaxCommitsPerRepo: { type: "integer", minimum: 1 },
    gitHostAllowlist: { type: "array", items: { type: "string" } },
    gitMaxParallelOps: { type: "integer", minimum: 1 },
    gitMaxRepoCount: { type: "integer", minimum: 1 },
    gitOverallTimeoutMs: { type: "integer", minimum: 5_000 },
  },
});

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`weekly-report.${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readPositiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`weekly-report.${field} must be a positive integer`);
  }
  return value;
}

function readBoundedInteger(value: unknown, field: string, fallback: number, min: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`weekly-report.${field} must be an integer >= ${min}`);
  }
  return value;
}

function readWeekStartsOn(value: unknown): WeekStartsOn {
  if (value === undefined || value === null) {
    return DEFAULT_WEEK_STARTS_ON;
  }
  if (value === "monday" || value === "sunday") {
    return value;
  }
  throw new Error(`weekly-report.weekStartsOn must be "monday" or "sunday"`);
}

function readHostAllowlist(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [...DEFAULT_GIT_HOST_ALLOWLIST];
  }
  if (!Array.isArray(value)) {
    throw new Error("weekly-report.gitHostAllowlist must be a string[]");
  }
  const normalized = value.map((entry, idx) => {
    if (typeof entry !== "string") {
      throw new Error(`weekly-report.gitHostAllowlist[${idx}] must be a string`);
    }
    const host = entry.trim();
    if (!GIT_HOST_REGEX.test(host)) {
      throw new Error(`weekly-report.gitHostAllowlist[${idx}] is not a valid hostname: ${entry}`);
    }
    return host;
  });
  return normalized.length === 0 ? [...DEFAULT_GIT_HOST_ALLOWLIST] : normalized;
}

export function validateGitRemoteSpec(
  raw: unknown,
  index: number,
  allowedHosts: string[],
): GitRemoteSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`weekly-report.gitRemotes[${index}] must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  const sshUrl = typeof entry.sshUrl === "string" ? entry.sshUrl.trim() : "";
  if (!name || !GIT_NAME_REGEX.test(name)) {
    throw new Error(
      `weekly-report.gitRemotes[${index}].name "${entry.name}" must match ${GIT_NAME_REGEX.source}`,
    );
  }
  if (!sshUrl) {
    throw new Error(`weekly-report.gitRemotes[${index}].sshUrl is required`);
  }
  for (const forbidden of FORBIDDEN_URL_SUBSTRINGS) {
    if (sshUrl.includes(forbidden)) {
      throw new Error(
        `weekly-report.gitRemotes[${index}].sshUrl contains forbidden substring "${forbidden}"`,
      );
    }
  }
  const match = GIT_SSH_URL_REGEX.exec(sshUrl);
  if (!match) {
    throw new Error(
      `weekly-report.gitRemotes[${index}].sshUrl "${sshUrl}" must be scp-style: user@host:path.git`,
    );
  }
  const host = match[1];
  if (!allowedHosts.includes(host)) {
    throw new Error(
      `weekly-report.gitRemotes[${index}].sshUrl host "${host}" not in gitHostAllowlist [${allowedHosts.join(", ")}]`,
    );
  }
  return { name, sshUrl };
}

function readGitRemotes(value: unknown, allowedHosts: string[]): GitRemoteSpec[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("weekly-report.gitRemotes must be an array of {name, sshUrl}");
  }
  return value.map((entry, idx) => validateGitRemoteSpec(entry, idx, allowedHosts));
}

export function parseWeeklyReportPluginConfig(raw: unknown): WeeklyReportPluginSettings {
  const cfg: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const reminderAfterDays = readPositiveInteger(
    cfg.reminderAfterDays,
    "reminderAfterDays",
    DEFAULT_REMINDER_DAYS,
  );
  const failAfterDays = readPositiveInteger(cfg.failAfterDays, "failAfterDays", DEFAULT_FAIL_DAYS);
  if (failAfterDays <= reminderAfterDays) {
    throw new Error("weekly-report.failAfterDays must be strictly greater than reminderAfterDays");
  }

  const sweeperIntervalMs = readPositiveInteger(
    cfg.sweeperIntervalMs,
    "sweeperIntervalMs",
    ONE_HOUR_MS,
  );

  const gitHostAllowlist = readHostAllowlist(cfg.gitHostAllowlist);
  const gitRemotes = readGitRemotes(cfg.gitRemotes, gitHostAllowlist);
  const gitAuthor = readOptionalString(cfg.gitAuthor, "gitAuthor");
  const gitWorkspaceDir = readOptionalString(cfg.gitWorkspaceDir, "gitWorkspaceDir");
  const gitFetchTimeoutMs = readBoundedInteger(
    cfg.gitFetchTimeoutMs,
    "gitFetchTimeoutMs",
    DEFAULT_GIT_FETCH_TIMEOUT_MS,
    1_000,
  );
  const gitMaxCommitsPerRepo = readPositiveInteger(
    cfg.gitMaxCommitsPerRepo,
    "gitMaxCommitsPerRepo",
    DEFAULT_GIT_MAX_COMMITS_PER_REPO,
  );
  const gitMaxParallelOps = readPositiveInteger(
    cfg.gitMaxParallelOps,
    "gitMaxParallelOps",
    DEFAULT_GIT_MAX_PARALLEL_OPS,
  );
  const gitMaxRepoCount = readPositiveInteger(
    cfg.gitMaxRepoCount,
    "gitMaxRepoCount",
    DEFAULT_GIT_MAX_REPO_COUNT,
  );
  const gitOverallTimeoutMs = readBoundedInteger(
    cfg.gitOverallTimeoutMs,
    "gitOverallTimeoutMs",
    DEFAULT_GIT_OVERALL_TIMEOUT_MS,
    5_000,
  );

  if (gitRemotes.length > 0) {
    if (!gitAuthor) {
      throw new Error("weekly-report.gitAuthor is required when gitRemotes is non-empty");
    }
    if (gitRemotes.length > gitMaxRepoCount) {
      throw new Error(
        `weekly-report.gitRemotes has ${gitRemotes.length} entries (cap is gitMaxRepoCount=${gitMaxRepoCount})`,
      );
    }
    const seenNames = new Set<string>();
    for (const remote of gitRemotes) {
      if (seenNames.has(remote.name)) {
        throw new Error(`weekly-report.gitRemotes duplicate name "${remote.name}"`);
      }
      seenNames.add(remote.name);
    }
  }

  return {
    targetDocToken: readOptionalString(cfg.targetDocToken, "targetDocToken"),
    recipientSessionKey: readOptionalString(cfg.recipientSessionKey, "recipientSessionKey"),
    reminderAfterDays,
    failAfterDays,
    notesDocToken: readOptionalString(cfg.notesDocToken, "notesDocToken"),
    draftPromptOverride: readOptionalString(cfg.draftPromptOverride, "draftPromptOverride"),
    weekStartsOn: readWeekStartsOn(cfg.weekStartsOn),
    sweeperIntervalMs,
    gitRemotes,
    gitAuthor,
    gitWorkspaceDir,
    gitFetchTimeoutMs,
    gitMaxCommitsPerRepo,
    gitHostAllowlist,
    gitMaxParallelOps,
    gitMaxRepoCount,
    gitOverallTimeoutMs,
  };
}
