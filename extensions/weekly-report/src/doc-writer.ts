/**
 * Non-destructive weekly-section writer for a Feishu doc, via the OFFICIAL `lark-cli`
 * (`@larksuite/cli`, the same binary `card-sender.ts` uses for bot-mode sends and the `lark-doc`
 * skill uses for `docs +fetch`/`docs +update`).
 *
 * Why not `larkcli doc update --mode overwrite` (the old path): overwrite CLEARS the whole doc and
 * re-renders it from a lossy Markdown snapshot, destroying images/comments/rich blocks and any
 * non-weekly content. This writer instead does block-level surgery so everything else is untouched:
 *
 *   1. fetch the doc OUTLINE with ids (`docs +fetch --scope outline --detail with-ids`) and find the
 *      H2 heading whose text == weekTitle (each week renders as one `## <week_title>` H2 block).
 *   2. if found, fetch that SECTION (`--scope section --start-block-id <id>`, which auto-expands a
 *      heading to the next same/higher heading) and delete its blocks (`--command block_delete`).
 *      Best-effort: also delete leftover `<!-- weekly-report:* weekKey=… -->` sentinel text blocks
 *      from the old overwrite-era docs (H3 migration).
 *   3. append the freshly rendered section (`block_insert_after --block-id -1`) and then move the new
 *      blocks to the document head (`block_move_after --block-id <page_id>`), so the latest week sits
 *      at the top.
 *
 * IDENTITY (G1): doc ops run `--as <identity>`. Default is `user` — a bot generally cannot see a
 * user-owned cloud doc unless the doc is explicitly shared with it, and the old code deliberately used
 * user identity for doc ops (see `interactive-handler.ts` header). The official CLI's `docs +update`
 * runs as user too. Bot identity + sharing the doc with the bot is the documented fallback.
 *
 * HOST VERIFICATION GATES (lark-cli is not installed in the dev checkout): G1 = which `--as` works for
 * both fetch and a no-op update on the target doc; G2 = the append→`block_move_after <page_id>`
 * head-insert sequence actually lands the section first (do NOT assume `block_insert_after page_id`
 * means "top"); G3 = `--content @<file>` is accepted. Argv below follows the documented contract.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";

export type RunCommandFn = PluginRuntime["system"]["runCommandWithTimeout"];

export type DocIdentity = "user" | "bot";

export type WriteWeeklySectionParams = {
  runCommand: RunCommandFn;
  binPath: string;
  asIdentity: DocIdentity;
  docToken: string;
  weekKey: string;
  weekTitle: string;
  sectionMarkdown: string;
  timeoutMs: number;
};

export type WriteWeeklySectionResult = { ok: true } | { ok: false; error: string };

type ExecResult = { stdout: string; stderr: string; code: number | null };

// ── pure parse helpers (unit-tested without a CLI) ──────────────────────────

/**
 * The official lark-cli emits a clean JSON object on stdout. Be lenient anyway: JSON.parse the whole
 * thing, falling back to the last balanced `{...}` block if a log line slipped in.
 */
export function parseCliJson(stdout: string): Record<string, unknown> | undefined {
  const direct = tryParse(stdout);
  if (direct) {
    return direct;
  }
  const trimmed = stdout.trimEnd();
  const end = trimmed.lastIndexOf("}");
  if (end < 0) {
    return undefined;
  }
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = end; i >= 0; i -= 1) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) {
      continue;
    }
    if (ch === "}") {
      depth += 1;
    } else if (ch === "{") {
      depth -= 1;
      if (depth === 0) {
        return tryParse(trimmed.slice(i, end + 1));
      }
    }
  }
  return undefined;
}

function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readDocument(envelope: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = envelope.data;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const document = (data as Record<string, unknown>).document;
  if (!document || typeof document !== "object") {
    return undefined;
  }
  return document as Record<string, unknown>;
}

/** A `+fetch` response → `{ documentId (page anchor), content (XML body) }`. */
export function parseFetchEnvelope(
  stdout: string,
): { ok: true; documentId: string; content: string } | { ok: false; error: string } {
  const envelope = parseCliJson(stdout);
  if (!envelope) {
    return { ok: false, error: `unparseable fetch JSON — ${stdout.slice(0, 200)}` };
  }
  if (envelope.ok === false) {
    return {
      ok: false,
      error: `fetch returned ok=false: ${JSON.stringify(envelope).slice(0, 200)}`,
    };
  }
  const document = readDocument(envelope);
  if (!document) {
    return { ok: false, error: "fetch: response missing data.document" };
  }
  const documentId = typeof document.document_id === "string" ? document.document_id : "";
  const content = typeof document.content === "string" ? document.content : "";
  if (!documentId) {
    return { ok: false, error: "fetch: response missing document_id" };
  }
  return { ok: true, documentId, content };
}

export type OutlineHeading = { id: string; level: number; text: string };

/**
 * Extract `{ id, level, text }` for each heading from outline/section XML. Headings render as
 * `<h1 id="…">text</h1>` … `<h9 …>`. Matching is text-content based (the renderer puts the week title
 * in the H2), so leading/trailing whitespace is trimmed.
 */
export function extractHeadings(xml: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  const re = /<h([1-9])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push({ level: Number(m[1]), id: m[2], text: stripTags(m[3]).trim() });
  }
  return out;
}

/** All block ids (`id="…"`) in a fragment, in document order, de-duplicated. */
export function collectBlockIds(xml: string): string[] {
  const re = /\bid="([^"]+)"/gu;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    seen.add(m[1]);
  }
  return [...seen];
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/gu, "");
}

/** Find the block id of the H2 heading that opens this week's section, by exact title match. */
export function findWeekSectionHeadingId(
  headings: OutlineHeading[],
  weekTitle: string,
): string | undefined {
  const target = weekTitle.trim();
  const exact = headings.find((h) => h.level === 2 && h.text === target);
  if (exact) {
    return exact.id;
  }
  // Fall back to any level if the heading level shifted (renamed/structure edit); still title-matched.
  return headings.find((h) => h.text === target)?.id;
}

// ── argv builders ───────────────────────────────────────────────────────────

function fetchArgv(p: {
  binPath: string;
  docToken: string;
  asIdentity: DocIdentity;
  scope: "outline" | "section" | "keyword";
  startBlockId?: string;
  keyword?: string;
}): string[] {
  const argv = [
    p.binPath,
    "docs",
    "+fetch",
    "--api-version",
    "v2",
    "--doc",
    p.docToken,
    "--scope",
    p.scope,
    "--detail",
    "with-ids",
    "--as",
    p.asIdentity,
    "--format",
    "json",
  ];
  if (p.scope === "outline") {
    argv.push("--max-depth", "3");
  }
  if (p.startBlockId) {
    argv.push("--start-block-id", p.startBlockId);
  }
  if (p.keyword) {
    argv.push("--keyword", p.keyword);
  }
  return argv;
}

function updateArgv(p: {
  binPath: string;
  docToken: string;
  asIdentity: DocIdentity;
  command: "block_delete" | "block_insert_after";
  blockId: string;
  content?: string;
}): string[] {
  // NOTE: `docs +update` does NOT accept `--format` (that flag is `docs +fetch`-only) — passing it
  // makes lark-cli exit "unknown flag: --format". Output is JSON by default and `parseCliJson`
  // tolerates leading log lines. Content is passed INLINE (not `--content @file`): runCommand takes
  // an argv array, so there's no shell escaping to worry about, and this lark-cli rejects the
  // `@file` form ("--content: invalid file path"). A markdown insert also returns no `new_blocks`
  // ids, so we never try to move blocks afterward — `block_insert_after --block-id <page_id>` already
  // lands the new section at the document head.
  const argv = [
    p.binPath,
    "docs",
    "+update",
    "--api-version",
    "v2",
    "--doc",
    p.docToken,
    "--command",
    p.command,
    "--block-id",
    p.blockId,
    "--as",
    p.asIdentity,
  ];
  if (p.command === "block_insert_after" && p.content !== undefined) {
    argv.push("--doc-format", "markdown", "--content", p.content);
  }
  return argv;
}

// ── orchestrator ────────────────────────────────────────────────────────────

function summarizeFailure(result: ExecResult): string {
  const trailer = result.stderr.trim() || result.stdout.trim() || `code=${result.code}`;
  return trailer.length > 240 ? `${trailer.slice(0, 239)}…` : trailer;
}

function detectDocAccessError(text: string, asIdentity: DocIdentity): string | undefined {
  const lower = text.toLowerCase();
  if (
    lower.includes("permission") ||
    lower.includes("forbidden") ||
    lower.includes("not authorized") ||
    lower.includes("no access") ||
    lower.includes("99991")
  ) {
    return (
      `lark-cli docs op denied for identity "${asIdentity}" — ` +
      (asIdentity === "bot"
        ? "the bot needs EDIT access: share the target doc with the bot app, or switch doc identity to user."
        : "run `lark-cli` user auth (device-flow) for the configured account, or share the doc with the bot and use bot identity.")
    );
  }
  return undefined;
}

async function runCli(
  runCommand: RunCommandFn,
  argv: string[],
  timeoutMs: number,
  asIdentity: DocIdentity,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  let result: ExecResult;
  try {
    result = await runCommand(argv, { timeoutMs });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === "ENOENT") {
      return {
        ok: false,
        error:
          `lark-cli not found at "${argv[0]}" — install via \`npm install -g @larksuite/cli@latest\` ` +
          "and complete `lark-cli config init` / user auth on the host",
      };
    }
    return { ok: false, error: `lark-cli spawn failed: ${(err as Error).message}` };
  }
  if (result.code !== 0) {
    const hint = detectDocAccessError(`${result.stderr}\n${result.stdout}`, asIdentity);
    return {
      ok: false,
      error: hint ?? `lark-cli exit ${result.code} — ${summarizeFailure(result)}`,
    };
  }
  return { ok: true, stdout: result.stdout };
}

export async function writeWeeklySection(
  params: WriteWeeklySectionParams,
): Promise<WriteWeeklySectionResult> {
  const { runCommand, binPath, asIdentity, docToken, weekKey, weekTitle, timeoutMs } = params;

  // 1. Outline → page anchor + headings.
  const outlineRes = await runCli(
    runCommand,
    fetchArgv({ binPath, docToken, asIdentity, scope: "outline" }),
    timeoutMs,
    asIdentity,
  );
  if (!outlineRes.ok) {
    return { ok: false, error: `outline fetch: ${outlineRes.error}` };
  }
  const outline = parseFetchEnvelope(outlineRes.stdout);
  if (!outline.ok) {
    return { ok: false, error: `outline fetch: ${outline.error}` };
  }
  const pageId = outline.documentId;
  const headings = extractHeadings(outline.content);

  // 2. Collect the block ids to delete: this week's existing section + any orphan sentinel blocks.
  const deleteIds = new Set<string>();
  const headingId = findWeekSectionHeadingId(headings, weekTitle);
  if (headingId) {
    const sectionRes = await runCli(
      runCommand,
      fetchArgv({ binPath, docToken, asIdentity, scope: "section", startBlockId: headingId }),
      timeoutMs,
      asIdentity,
    );
    if (!sectionRes.ok) {
      return { ok: false, error: `section fetch: ${sectionRes.error}` };
    }
    const section = parseFetchEnvelope(sectionRes.stdout);
    if (!section.ok) {
      return { ok: false, error: `section fetch: ${section.error}` };
    }
    for (const id of collectBlockIds(section.content)) {
      deleteIds.add(id);
    }
  }
  // Best-effort migration: remove leftover `<!-- weekly-report:* weekKey=… -->` text blocks written by
  // the old overwrite path. Scoped to this weekKey; never fails the write.
  await collectOrphanSentinelIds({
    runCommand,
    binPath,
    asIdentity,
    docToken,
    weekKey,
    timeoutMs,
  }).then(
    (ids) => ids.forEach((id) => deleteIds.add(id)),
    () => {},
  );

  // 3. Delete the old section (if any).
  if (deleteIds.size > 0) {
    const delRes = await runCli(
      runCommand,
      updateArgv({
        binPath,
        docToken,
        asIdentity,
        command: "block_delete",
        blockId: [...deleteIds].join(","),
      }),
      timeoutMs,
      asIdentity,
    );
    if (!delRes.ok) {
      return { ok: false, error: `block_delete: ${delRes.error}` };
    }
  }

  // 4. Insert the rendered section at the document head. `block_insert_after --block-id <page_id>`
  //    places the new blocks as the first content block (right after the title), so the newest week is
  //    always on top — no separate "move" step. Content is passed inline (markdown); a markdown insert
  //    returns no block ids, but we don't need any here.
  const insertRes = await runCli(
    runCommand,
    updateArgv({
      binPath,
      docToken,
      asIdentity,
      command: "block_insert_after",
      blockId: pageId, // page anchor = document head
      content: params.sectionMarkdown,
    }),
    timeoutMs,
    asIdentity,
  );
  if (!insertRes.ok) {
    return { ok: false, error: `block_insert_after: ${insertRes.error}` };
  }

  return { ok: true };
}

/** Sentinel strings the old overwrite path embedded; used only for one-time orphan cleanup. */
export function legacySentinelKeyword(weekKey: string): string {
  return `weekly-report:begin weekKey=${weekKey}|weekly-report:end weekKey=${weekKey}`;
}

async function collectOrphanSentinelIds(p: {
  runCommand: RunCommandFn;
  binPath: string;
  asIdentity: DocIdentity;
  docToken: string;
  weekKey: string;
  timeoutMs: number;
}): Promise<string[]> {
  const res = await runCli(
    p.runCommand,
    fetchArgv({
      binPath: p.binPath,
      docToken: p.docToken,
      asIdentity: p.asIdentity,
      scope: "keyword",
      keyword: legacySentinelKeyword(p.weekKey),
    }),
    p.timeoutMs,
    p.asIdentity,
  );
  if (!res.ok) {
    return [];
  }
  const parsed = parseFetchEnvelope(res.stdout);
  return parsed.ok ? collectBlockIds(parsed.content) : [];
}
