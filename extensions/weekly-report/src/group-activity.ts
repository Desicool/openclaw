/**
 * Group-message collection runner for the weekly-report drafting phase (v4).
 *
 * v3 enumerated via `runtime.agent.session.listSessionEntries`, which only saw groups the agent
 * had local session records for — far less than the user's real Feishu membership. v4 pivots to
 * a shell-out against `@richord/lark-cli` (or `@fanfanv5/feishu-cli`) `im search-messages`, which
 * filters server-side via the Feishu `search:message` API. Discovery (chat_id) comes free as a
 * byproduct of the message hit set.
 *
 * Two passes per drafting call:
 *   - author:  `larkcli -a <accountId> im search-messages --sender_ids '["<userOpenId>"]' ...`
 *   - mention: `larkcli -a <accountId> im search-messages --mention_ids '["<userOpenId>"]' ...`
 *
 * Time window is computed from `mondayMidnightUtcMs` and passed as explicit `--start_time`/
 * `--end_time` ISO 8601 (we deliberately avoid `--relative_time this_week` because lark-cli's
 * notion of week-start may differ from the plugin's configured `weekStartsOn`). Pagination walks
 * up to `larkCliMaxPages`; if `has_more` is still true after the cap, the pass is marked
 * `truncated: true` (drafting prompt mentions this so the agent can flag incomplete coverage).
 *
 * Failure modes (all surfaced as structured results — the tool never throws):
 *   - Binary missing: caught from a thrown ENOENT and reported with install hint.
 *   - Auth invalid (`<appId>.user` mapping missing): caught from stderr/stdout heuristics.
 *   - search:message scope missing: caught from stderr/stdout heuristics; the deploy doc tells
 *     the operator how to pre-warm the scope via one interactive call.
 *   - `larkCliAccountId` unset: synchronous ok:false, no spawn attempt.
 *
 * Post-processing: dedupe by `message_id` across the two passes, drop bot self-messages, drop
 * out-of-window messages, post-filter by `groupDenylist`, group by `chat_id` for the agent.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { WeeklyReportPluginSettings } from "./settings.js";
import type { WeekStartsOn } from "./week-key.js";

export type RunCommandFn = PluginRuntime["system"]["runCommandWithTimeout"];

export type GroupMessageReason = "author" | "mention";

export type GroupMessageRecord = {
  messageId: string;
  chatId: string;
  ts: number;
  senderOpenId: string;
  senderType: string;
  text: string;
  reason: GroupMessageReason;
  msgType: string;
  chatName?: string;
  threadId?: string;
  mentions?: string[];
};

export type GroupActivityPassResult =
  | {
      kind: GroupMessageReason;
      ok: true;
      messages: GroupMessageRecord[];
      pagesWalked: number;
      truncated?: boolean;
    }
  | {
      kind: GroupMessageReason;
      ok: false;
      messages: [];
      error: string;
      pagesWalked: number;
    };

export type GroupActivityResult = {
  windowStart: number;
  windowEnd: number;
  userOpenId: string | undefined;
  accountId: string | undefined;
  passes: GroupActivityPassResult[];
  groupedByChat: Record<string, GroupMessageRecord[]>;
  ok?: false;
  error?: string;
};

export type RunGroupActivityParams = {
  settings: WeeklyReportPluginSettings;
  runCommand: RunCommandFn;
  sinceTs?: number;
  untilTs?: number;
  includeReasons?: GroupMessageReason[];
  now?: () => number;
};

const MAX_PAGE_SIZE = 50;

// ── time helpers ────────────────────────────────────────────────────

export function mondayMidnightUtcMs(refMs: number, weekStartsOn: WeekStartsOn = "monday"): number {
  const d = new Date(refMs);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  if (weekStartsOn === "sunday") {
    d.setUTCDate(d.getUTCDate() - day);
  } else {
    const isoDayIndex = day === 0 ? 7 : day; // 1=Mon..7=Sun
    d.setUTCDate(d.getUTCDate() - (isoDayIndex - 1));
  }
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * lark-cli emits `create_time` as `new Date(epochMs).toISOString().replace("Z", "+08:00")`.
 * The string is mathematically wrong — it's UTC time labeled with +08:00. Reverse the mangling
 * by swapping back to Z and parsing. Returns undefined if the format is unrecognized.
 */
export function parseLarkCliTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const normalized = value.endsWith("+08:00") ? `${value.slice(0, -6)}Z` : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

// ── message preprocessing ───────────────────────────────────────────

function readSenderId(sender: unknown): string | undefined {
  if (sender && typeof sender === "object") {
    const s = sender as Record<string, unknown>;
    if (typeof s.id === "string" && s.id.length > 0) return s.id;
  }
  return undefined;
}

function readSenderType(sender: unknown): string {
  if (sender && typeof sender === "object") {
    const s = sender as Record<string, unknown>;
    if (typeof s.sender_type === "string") return s.sender_type;
  }
  return "unknown";
}

function readMentions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const m of value) {
    if (m && typeof m === "object") {
      const id = (m as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) out.push(id);
    }
  }
  return out;
}

type PreprocessedMessage = {
  messageId: string;
  chatId: string;
  ts: number;
  senderOpenId: string;
  senderType: string;
  text: string;
  msgType: string;
  chatName?: string;
  threadId?: string;
  mentions?: string[];
};

function preprocessMessage(raw: unknown): PreprocessedMessage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const msg = raw as Record<string, unknown>;
  const messageId = typeof msg.message_id === "string" ? msg.message_id : "";
  const chatId = typeof msg.chat_id === "string" ? msg.chat_id : "";
  if (!messageId || !chatId) return undefined;
  const ts = parseLarkCliTimestamp(msg.create_time);
  const senderOpenId = readSenderId(msg.sender);
  if (ts === undefined || !senderOpenId) return undefined;
  const text = typeof msg.content === "string" ? msg.content : "";
  const msgType = typeof msg.msg_type === "string" ? msg.msg_type : "unknown";
  const out: PreprocessedMessage = {
    messageId,
    chatId,
    ts,
    senderOpenId,
    senderType: readSenderType(msg.sender),
    text,
    msgType,
  };
  if (typeof msg.chat_name === "string" && msg.chat_name.length > 0) {
    out.chatName = msg.chat_name;
  }
  if (typeof msg.thread_id === "string" && msg.thread_id.length > 0) {
    out.threadId = msg.thread_id;
  }
  const mentions = readMentions(msg.mentions);
  if (mentions.length > 0) {
    out.mentions = mentions;
  }
  return out;
}

/**
 * lark-cli writes informational `[feishu/...]` log lines to STDOUT alongside the actual JSON
 * payload (the logger uses `console.log` for info-level — no `--quiet` flag exists). Pull the
 * pretty-printed JSON object out by scanning for the last `{` at column 0 and slicing from there.
 * The CLI's `outputResult` always emits `JSON.stringify(data, null, 2)` as the final line group,
 * so the last column-0 `{...}` block is the payload.
 */
export function extractJsonPayload(stdout: string): string | undefined {
  if (!stdout) return undefined;
  const lines = stdout.split("\n");
  let endIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === "}") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) {
    if (stdout.trimStart().startsWith("{")) return stdout;
    return undefined;
  }
  let startIdx = -1;
  for (let i = endIdx; i >= 0; i--) {
    if (lines[i] === "{") {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return undefined;
  return lines.slice(startIdx, endIdx + 1).join("\n");
}

function extractMessagePage(parsed: unknown): {
  items: unknown[];
  hasMore: boolean;
  pageToken: string | undefined;
} {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { items: [], hasMore: false, pageToken: undefined };
  }
  const obj = parsed as Record<string, unknown>;
  const items = Array.isArray(obj.messages) ? (obj.messages as unknown[]) : [];
  const hasMore = obj.has_more === true;
  const pageToken =
    typeof obj.page_token === "string" && obj.page_token.length > 0 ? obj.page_token : undefined;
  return { items, hasMore, pageToken };
}

// ── filter helpers ──────────────────────────────────────────────────

function isDenylisted(chatId: string, denylist: string[]): boolean {
  if (denylist.length === 0) return false;
  return denylist.includes(chatId);
}

// ── argv + error classification ─────────────────────────────────────

export function buildSearchArgv(params: {
  bin: string;
  accountId: string;
  kind: GroupMessageReason;
  userOpenId: string;
  sinceIso: string;
  untilIso: string;
  pageSize: number;
  pageToken: string | undefined;
}): string[] {
  const idsFlag = params.kind === "author" ? "--sender_ids" : "--mention_ids";
  const argv = [
    params.bin,
    "-a",
    params.accountId,
    "im",
    "search-messages",
    idsFlag,
    JSON.stringify([params.userOpenId]),
    "--chat_type",
    "group",
    "--start_time",
    params.sinceIso,
    "--end_time",
    params.untilIso,
    "--page_size",
    String(params.pageSize),
  ];
  if (params.pageToken) {
    argv.push("--page_token", params.pageToken);
  }
  return argv;
}

function detectAuthOrScopeError(text: string, accountId: string): string | undefined {
  const lower = text.toLowerCase();
  if (
    lower.includes("not authorized") ||
    lower.includes("device-flow") ||
    lower.includes("user-mapping") ||
    lower.includes(".user not found")
  ) {
    return (
      `larkcli auth invalid for account "${accountId}" — ` +
      `run \`larkcli -a ${accountId} auth device-flow\` once to populate the user-mapping file ` +
      `(openclaw-lark's UAT keychain entry is reused, but the <appId>.user mapping is owned by lark-cli)`
    );
  }
  if (
    lower.includes("search:message") ||
    lower.includes("scope grant") ||
    lower.includes("scope_not_granted")
  ) {
    return (
      `larkcli scope missing for account "${accountId}" — ` +
      `run \`larkcli -a ${accountId} im search-messages --query test --page_size 1\` ` +
      `interactively once and complete the search:message scope grant prompt`
    );
  }
  return undefined;
}

function summarizeExecFailure(result: {
  stdout: string;
  stderr: string;
  code: number | null;
}): string {
  const trailer = result.stderr.trim() || result.stdout.trim() || `code=${result.code}`;
  return trailer.length > 240 ? `${trailer.slice(0, 239)}…` : trailer;
}

// ── per-pass runner ─────────────────────────────────────────────────

async function runPass(params: {
  kind: GroupMessageReason;
  settings: WeeklyReportPluginSettings;
  userOpenId: string;
  accountId: string;
  runCommand: RunCommandFn;
  sinceIso: string;
  untilIso: string;
}): Promise<GroupActivityPassResult> {
  const { kind, settings, userOpenId, accountId, runCommand, sinceIso, untilIso } = params;
  const pageSize = Math.min(settings.groupMaxMessagesPerPass, MAX_PAGE_SIZE);
  const maxPages = Math.max(1, settings.larkCliMaxPages);
  const messages: GroupMessageRecord[] = [];
  let pageToken: string | undefined;
  let pagesWalked = 0;
  let hasMoreAtCap = false;

  for (let i = 0; i < maxPages; i++) {
    const argv = buildSearchArgv({
      bin: settings.larkCliBinPath,
      accountId,
      kind,
      userOpenId,
      sinceIso,
      untilIso,
      pageSize,
      pageToken,
    });

    let result;
    try {
      result = await runCommand(argv, { timeoutMs: settings.larkCliTimeoutMs });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      pagesWalked++;
      if (e && e.code === "ENOENT") {
        return {
          kind,
          ok: false,
          messages: [],
          error:
            `larkcli not found at "${settings.larkCliBinPath}" — ` +
            `install via \`npm install -g @richord/lark-cli@0.0.4\` and bootstrap ` +
            `~/.feishu-cli/config.json with account "${accountId}"`,
          pagesWalked,
        };
      }
      return {
        kind,
        ok: false,
        messages: [],
        error: `larkcli spawn failed: ${(err as Error).message}`,
        pagesWalked,
      };
    }
    pagesWalked++;

    if (result.code !== 0) {
      const trailer = summarizeExecFailure(result);
      const hint = detectAuthOrScopeError(`${result.stderr}\n${result.stdout}`, accountId);
      return {
        kind,
        ok: false,
        messages: [],
        error: hint ?? `larkcli ${kind} pass exit ${result.code} — ${trailer}`,
        pagesWalked,
      };
    }

    const jsonPayload = extractJsonPayload(result.stdout);
    if (!jsonPayload) {
      const head = result.stdout.slice(0, 240);
      return {
        kind,
        ok: false,
        messages: [],
        error: `larkcli ${kind} pass: no JSON payload in stdout — ${head}`,
        pagesWalked,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonPayload);
    } catch {
      const head = jsonPayload.slice(0, 240);
      return {
        kind,
        ok: false,
        messages: [],
        error: `larkcli ${kind} pass: unparseable JSON payload — ${head}`,
        pagesWalked,
      };
    }

    const page = extractMessagePage(parsed);
    const errorHint = detectAuthOrScopeError(JSON.stringify(parsed), accountId);
    if (errorHint && page.items.length === 0) {
      return {
        kind,
        ok: false,
        messages: [],
        error: errorHint,
        pagesWalked,
      };
    }

    for (const raw of page.items) {
      const pre = preprocessMessage(raw);
      if (!pre) continue;
      messages.push({
        messageId: pre.messageId,
        chatId: pre.chatId,
        ts: pre.ts,
        senderOpenId: pre.senderOpenId,
        senderType: pre.senderType,
        text: pre.text,
        reason: kind,
        msgType: pre.msgType,
        ...(pre.chatName ? { chatName: pre.chatName } : {}),
        ...(pre.threadId ? { threadId: pre.threadId } : {}),
        ...(pre.mentions ? { mentions: pre.mentions } : {}),
      });
    }

    if (!page.hasMore || !page.pageToken) {
      return { kind, ok: true, messages, pagesWalked };
    }
    pageToken = page.pageToken;
    if (i === maxPages - 1) {
      hasMoreAtCap = true;
    }
  }

  const ok: GroupActivityPassResult = { kind, ok: true, messages, pagesWalked };
  if (hasMoreAtCap) ok.truncated = true;
  return ok;
}

// ── public runner ───────────────────────────────────────────────────

export async function runGroupActivity(
  params: RunGroupActivityParams,
): Promise<GroupActivityResult> {
  const { settings, runCommand } = params;
  const now = params.now ?? Date.now;
  const nowMs = now();
  const sinceTs = params.sinceTs ?? mondayMidnightUtcMs(nowMs, settings.weekStartsOn);
  const untilTs = params.untilTs ?? nowMs;

  if (!settings.userOpenId) {
    return {
      windowStart: sinceTs,
      windowEnd: untilTs,
      userOpenId: undefined,
      accountId: settings.larkCliAccountId,
      passes: [],
      groupedByChat: {},
      ok: false,
      error:
        "userOpenId not configured and not derivable from recipientSessionKey. " +
        "Set plugins.entries.weekly-report.userOpenId to your Feishu open_id (ou_...) " +
        "to enable group-message collection.",
    };
  }

  if (!settings.larkCliAccountId) {
    return {
      windowStart: sinceTs,
      windowEnd: untilTs,
      userOpenId: settings.userOpenId,
      accountId: undefined,
      passes: [],
      groupedByChat: {},
      ok: false,
      error:
        "larkCliAccountId is required to enable group-message collection. " +
        "Set plugins.entries.weekly-report.larkCliAccountId to your lark-cli account id " +
        "(matching ~/.feishu-cli/config.json).",
    };
  }

  const includeReasons = params.includeReasons ?? ["author", "mention"];
  const passKinds: GroupMessageReason[] = [];
  if (includeReasons.includes("author")) passKinds.push("author");
  if (includeReasons.includes("mention")) passKinds.push("mention");
  if (passKinds.length === 0) {
    return {
      windowStart: sinceTs,
      windowEnd: untilTs,
      userOpenId: settings.userOpenId,
      accountId: settings.larkCliAccountId,
      passes: [],
      groupedByChat: {},
    };
  }

  const sinceIso = new Date(sinceTs).toISOString();
  const untilIso = new Date(untilTs).toISOString();

  const passes: GroupActivityPassResult[] = [];
  for (const kind of passKinds) {
    const pass = await runPass({
      kind,
      settings,
      userOpenId: settings.userOpenId,
      accountId: settings.larkCliAccountId,
      runCommand,
      sinceIso,
      untilIso,
    });
    passes.push(pass);
  }

  // Dedupe by messageId across passes; post-filter by groupDenylist, botOpenId, time window.
  const seen = new Set<string>();
  const groupedByChat: Record<string, GroupMessageRecord[]> = {};
  for (const pass of passes) {
    if (!pass.ok) continue;
    for (const msg of pass.messages) {
      if (seen.has(msg.messageId)) continue;
      seen.add(msg.messageId);
      if (msg.ts < sinceTs || msg.ts > untilTs) continue;
      if (isDenylisted(msg.chatId, settings.groupDenylist)) continue;
      if (settings.botOpenId && msg.senderOpenId === settings.botOpenId) continue;
      const bucket = groupedByChat[msg.chatId] ?? [];
      bucket.push(msg);
      groupedByChat[msg.chatId] = bucket;
    }
  }
  for (const chatId of Object.keys(groupedByChat)) {
    groupedByChat[chatId]!.sort((a, b) => a.ts - b.ts);
  }

  const allFailed = passes.length > 0 && passes.every((p) => !p.ok);
  if (allFailed) {
    const error = passes
      .map((p) => (p.ok ? "" : `${p.kind}: ${p.error}`))
      .filter(Boolean)
      .join(" / ");
    return {
      windowStart: sinceTs,
      windowEnd: untilTs,
      userOpenId: settings.userOpenId,
      accountId: settings.larkCliAccountId,
      passes,
      groupedByChat: {},
      ok: false,
      error,
    };
  }

  return {
    windowStart: sinceTs,
    windowEnd: untilTs,
    userOpenId: settings.userOpenId,
    accountId: settings.larkCliAccountId,
    passes,
    groupedByChat,
  };
}
