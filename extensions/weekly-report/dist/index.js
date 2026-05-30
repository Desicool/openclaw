// extensions/weekly-report/index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// extensions/weekly-report/src/card-sender.ts
function summarizeExecFailure(result) {
  const trailer = result.stderr.trim() || result.stdout.trim() || `code=${result.code}`;
  return trailer.length > 240 ? `${trailer.slice(0, 239)}\u2026` : trailer;
}
function detectKnownError(text) {
  const lower = text.toLowerCase();
  if (lower.includes("config init") || lower.includes("appid") || lower.includes("app id")) {
    return 'lark-cli not configured for bot mode. Run once on host: `printf %s "<silver-chariot appSecret>" | lark-cli config init --app-id <silver-chariot appId> --app-secret-stdin --brand feishu`';
  }
  if (lower.includes("auth") && (lower.includes("login") || lower.includes("token"))) {
    return "lark-cli auth issue. For bot-mode sends, no user login is required \u2014 only `lark-cli config init` with bot appId/appSecret. Verify with `lark-cli config show`.";
  }
  return void 0;
}
async function cardKitCreate(params) {
  const data = JSON.stringify({ type: "card_json", data: JSON.stringify(params.card) });
  const argv = [
    params.binPath,
    "api",
    "POST",
    "/open-apis/cardkit/v1/cards",
    "--as",
    "bot",
    "--data",
    data
  ];
  let result;
  try {
    result = await params.runCommand(argv, { timeoutMs: params.timeoutMs });
  } catch (err) {
    const e = err;
    if (e && e.code === "ENOENT") {
      return {
        ok: false,
        error: `lark-cli not found at "${params.binPath}" \u2014 install via \`npm install -g @larksuite/cli@latest\` and configure with \`lark-cli config init --app-id <silver-chariot appId> --app-secret-stdin --brand feishu\` + \`lark-cli config bind --source openclaw --app-id <appId> --identity bot-only\``
      };
    }
    return { ok: false, error: `lark-cli spawn failed: ${err.message}` };
  }
  if (result.code !== 0) {
    const trailer = summarizeExecFailure(result);
    const hint = detectKnownError(`${result.stderr}
${result.stdout}`);
    return { ok: false, error: hint ?? `cardkit create exit ${result.code} \u2014 ${trailer}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      error: `cardkit create: unparseable stdout \u2014 ${result.stdout.slice(0, 240)}`
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "cardkit create: response missing object" };
  }
  const obj = parsed;
  if (obj.code !== 0) {
    return {
      ok: false,
      error: `cardkit create code=${String(obj.code)} msg=${String(obj.msg)}`
    };
  }
  const data2 = obj.data;
  if (!data2 || typeof data2 !== "object") {
    return { ok: false, error: "cardkit create: response missing data field" };
  }
  const cardId = data2.card_id;
  if (typeof cardId !== "string" || cardId.length === 0) {
    return { ok: false, error: "cardkit create: response missing card_id" };
  }
  return { ok: true, cardId };
}
async function sendInteractiveCard(params) {
  const createRes = await cardKitCreate({
    runCommand: params.runCommand,
    binPath: params.binPath,
    card: params.card,
    timeoutMs: params.timeoutMs
  });
  if (!createRes.ok) {
    return { ok: false, error: createRes.error };
  }
  const content = JSON.stringify({ type: "card", data: { card_id: createRes.cardId } });
  const argv = [
    params.binPath,
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--user-id",
    params.toOpenId,
    "--msg-type",
    "interactive",
    "--content",
    content
  ];
  if (params.idempotencyKey) {
    argv.push("--idempotency-key", params.idempotencyKey);
  }
  let result;
  try {
    result = await params.runCommand(argv, { timeoutMs: params.timeoutMs });
  } catch (err) {
    return { ok: false, error: `lark-cli spawn failed: ${err.message}` };
  }
  if (result.code !== 0) {
    const trailer = summarizeExecFailure(result);
    const hint = detectKnownError(`${result.stderr}
${result.stdout}`);
    return { ok: false, error: hint ?? `lark-cli card send exit ${result.code} \u2014 ${trailer}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      error: `lark-cli card send: unparseable stdout \u2014 ${result.stdout.slice(0, 240)}`
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "lark-cli card send: response missing object" };
  }
  const obj = parsed;
  if (obj.ok !== true) {
    return {
      ok: false,
      error: `lark-cli card send returned ok=false: ${JSON.stringify(obj).slice(0, 240)}`
    };
  }
  const data = obj.data;
  if (!data || typeof data !== "object") {
    return { ok: false, error: "lark-cli card send: response missing data field" };
  }
  const dataObj = data;
  const messageId = dataObj.message_id;
  const chatId = dataObj.chat_id;
  if (typeof messageId !== "string" || typeof chatId !== "string") {
    return { ok: false, error: "lark-cli card send: response missing message_id/chat_id" };
  }
  return { ok: true, messageId, chatId };
}

// extensions/weekly-report/src/types.ts
var WEEKLY_REPORT_SUPPLEMENT_SESSION_SEGMENT = "weekly-report-supplement";
function isWeeklyReportSupplementSession(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.includes(`:${WEEKLY_REPORT_SUPPLEMENT_SESSION_SEGMENT}:`);
}
var WEEKLY_REPORT_STEPS = {
  awaitUserReply: "await_user_reply",
  revising: "revising",
  writingDoc: "writing_doc",
  done: "done",
  failed: "failed"
};
var WEEKLY_REPORT_CARD_ACTIONS = ["confirm", "supplement"];
function isWeeklyReportFlowState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value;
  return typeof obj.weekKey === "string" && typeof obj.weekTitle === "string" && typeof obj.recipientSessionKey === "string" && typeof obj.targetDocToken === "string" && typeof obj.draft === "object" && obj.draft !== null;
}
var ACTIVE_STATUSES = /* @__PURE__ */ new Set([
  "queued",
  "running",
  "waiting"
]);

// extensions/weekly-report/src/card.ts
var CARD_NAMESPACE = "weekly-report";
var SUPPLEMENT_INPUT_NAME = "supplement";
var V2_CARD_CONFIG = { wide_screen_mode: true, update_multi: true };
function buildCardEnvelope(params) {
  return {
    action: `${CARD_NAMESPACE}:${params.action}`,
    flowId: params.flowId,
    weekKey: params.weekKey
  };
}
function parseEnvelopeAction(action) {
  if (typeof action !== "string") return null;
  const parts = action.split(":");
  if (parts.length !== 2 || parts[0] !== CARD_NAMESPACE) return null;
  const verb = parts[1];
  return WEEKLY_REPORT_CARD_ACTIONS.includes(verb) ? verb : null;
}
var PREVIEW_MAX_CHARS = 3800;
var PREVIEW_BULLETS_PER_ITEM = 4;
var PREVIEW_BULLET_MAX_CHARS = 180;
function truncateBullet(text) {
  if (text.length <= PREVIEW_BULLET_MAX_CHARS) return text;
  return `${text.slice(0, PREVIEW_BULLET_MAX_CHARS - 1)}\u2026`;
}
function buildDraftPreview(draft) {
  const lines = [];
  lines.push(`**${draft.week_title}**`);
  lines.push("");
  lines.push("**\u672C\u5468\u5DE5\u4F5C**");
  draft.current_week.forEach((item, idx) => {
    lines.push("");
    lines.push(`**${idx + 1}. ${item.title}**`);
    lines.push(`*\u610F\u56FE*: ${item.intent}`);
    lines.push(`*\u76EE\u6807*: ${item.objective}`);
    lines.push(`*\u5DF2\u5B8C\u6210*:`);
    const shown = item.completed.slice(0, PREVIEW_BULLETS_PER_ITEM);
    for (const bullet of shown) {
      lines.push(`- ${truncateBullet(bullet)}`);
    }
    const hidden = item.completed.length - shown.length;
    if (hidden > 0) {
      lines.push(`- \u2026\u8FD8\u6709 ${hidden} \u6761\u5DF2\u5B8C\u6210`);
    }
  });
  if (draft.next_week.length > 0) {
    lines.push("");
    lines.push("**\u4E0B\u5468\u8BA1\u5212**");
    for (const row of draft.next_week) {
      lines.push(`- **${row.project}**: ${row.plan}`);
    }
  }
  const out = lines.join("\n");
  if (out.length <= PREVIEW_MAX_CHARS) return out;
  return `${out.slice(0, PREVIEW_MAX_CHARS - 60)}\u2026

*(\u9884\u89C8\u5DF2\u622A\u65AD\uFF0C\u5B8C\u6574\u5185\u5BB9\u786E\u8BA4\u540E\u5199\u5165\u6587\u6863)*`;
}
function buildConfirmationCard(params) {
  const previewMarkdown = buildDraftPreview(params.draft);
  const headerTitle = params.revisionLabel ? `Weekly Report \u2014 ${params.weekTitle} (${params.revisionLabel})` : `Weekly Report \u2014 ${params.weekTitle}`;
  const confirmEnvelope = buildCardEnvelope({
    flowId: params.flowId,
    weekKey: params.weekKey,
    action: "confirm"
  });
  const supplementEnvelope = buildCardEnvelope({
    flowId: params.flowId,
    weekKey: params.weekKey,
    action: "supplement"
  });
  const formElements = [
    { tag: "markdown", content: previewMarkdown },
    { tag: "hr" },
    {
      tag: "markdown",
      content: "**\u786E\u8BA4\u6216\u8865\u5145\u672C\u5468\u62A5\uFF1A**\n- \u76F4\u63A5\u5199\u5165\uFF1A\u70B9\u300C\u76F4\u63A5\u5199\u5165\u300D\u628A\u5F53\u524D\u8349\u7A3F\u5199\u5165\u98DE\u4E66\u6587\u6863\u3002\n- \u8C03\u6574\u8349\u7A3F\uFF1A\u5728\u4E0B\u65B9\u8F93\u5165\u6846\u5199\u8865\u5145\u610F\u56FE\uFF0C\u7136\u540E\u70B9\u300C\u63D0\u4EA4\u8865\u5145\u300D\u3002\u4F8B\u5982\uFF1A\n  - `\u52A0\u4E0A\uFF1A\u5468\u4E09\u548C\u6B22\u54E5\u5BF9\u9F50\u4E86 demo \u8282\u594F`\n  - `\u5220\u9664\u7B2C 2 \u6761`\n  - `\u7B2C 1 \u6761\u6539\u4E3A\uFF1A\u5B8C\u6210 growx-runtime compaction issue \u7684\u65B9\u6848\u8BC4\u5BA1`"
    },
    {
      tag: "input",
      name: SUPPLEMENT_INPUT_NAME,
      input_type: "multiline_text",
      rows: 6,
      placeholder: {
        tag: "plain_text",
        content: "\u8865\u5145 / \u4FEE\u6539 / \u5220\u9664\uFF08\u63D0\u4EA4\u540E\u7531 silver-chariot \u91CD\u65B0\u6574\u7406\u8349\u7A3F\u5E76\u518D\u53D1\u5361\u7247\uFF09"
      }
    },
    // NOTE: For v2 cards with `form_action_type: "submit"`, the callback payload MUST live in
    // `behaviors: [{type: "callback", value: ...}]`, NOT as a top-level `value` field. Top-level
    // `value` is v1 syntax and v2 form-submit buttons ignore it (Feishu delivers `hasValue=false`
    // in the click event). See https://open.larksuite.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/button.
    {
      tag: "button",
      name: "weekly_report_confirm_button",
      text: { tag: "plain_text", content: "\u76F4\u63A5\u5199\u5165" },
      type: "primary",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: confirmEnvelope }]
    },
    {
      tag: "button",
      name: "weekly_report_supplement_button",
      text: { tag: "plain_text", content: "\u63D0\u4EA4\u8865\u5145" },
      type: "default",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: supplementEnvelope }]
    }
  ];
  return {
    schema: "2.0",
    config: { ...V2_CARD_CONFIG },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: headerTitle }
    },
    body: {
      elements: [
        {
          tag: "form",
          name: "weekly_report_form",
          elements: formElements
        }
      ]
    }
  };
}

// extensions/weekly-report/src/doc-writer.ts
function parseCliJson(stdout) {
  const direct = tryParse(stdout);
  if (direct) {
    return direct;
  }
  const trimmed = stdout.trimEnd();
  const end = trimmed.lastIndexOf("}");
  if (end < 0) {
    return void 0;
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
  return void 0;
}
function tryParse(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function readDocument(envelope) {
  const data = envelope.data;
  if (!data || typeof data !== "object") {
    return void 0;
  }
  const document = data.document;
  if (!document || typeof document !== "object") {
    return void 0;
  }
  return document;
}
function parseFetchEnvelope(stdout) {
  const envelope = parseCliJson(stdout);
  if (!envelope) {
    return { ok: false, error: `unparseable fetch JSON \u2014 ${stdout.slice(0, 200)}` };
  }
  if (envelope.ok === false) {
    return {
      ok: false,
      error: `fetch returned ok=false: ${JSON.stringify(envelope).slice(0, 200)}`
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
function extractHeadings(xml) {
  const out = [];
  const re = /<h([1-9])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gu;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push({ level: Number(m[1]), id: m[2], text: stripTags(m[3]).trim() });
  }
  return out;
}
function collectBlockIds(xml) {
  const re = /\bid="([^"]+)"/gu;
  const seen = /* @__PURE__ */ new Set();
  let m;
  while ((m = re.exec(xml)) !== null) {
    seen.add(m[1]);
  }
  return [...seen];
}
function stripTags(value) {
  return value.replace(/<[^>]*>/gu, "");
}
function findWeekSectionHeadingId(headings, weekTitle2) {
  const target = weekTitle2.trim();
  const exact = headings.find((h) => h.level === 2 && h.text === target);
  if (exact) {
    return exact.id;
  }
  return headings.find((h) => h.text === target)?.id;
}
function formatMMDD(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}${dd}`;
}
var UPDATED_AT_MARKER = /([（(]\s*updated at\s*)(\d+)(\s*[）)])/iu;
function nextDocTitle(currentTitle, todayMMDD) {
  if (!UPDATED_AT_MARKER.test(currentTitle)) {
    return void 0;
  }
  return currentTitle.replace(UPDATED_AT_MARKER, `$1${todayMMDD}$3`);
}
function parseInspectTitle(stdout) {
  const envelope = parseCliJson(stdout);
  const data = envelope?.data;
  if (data && typeof data === "object") {
    const title = data.title;
    if (typeof title === "string" && title.length > 0) {
      return title;
    }
  }
  return void 0;
}
function fetchArgv(p) {
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
    "json"
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
function updateArgv(p) {
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
    p.asIdentity
  ];
  if (p.command === "block_insert_after" && p.content !== void 0) {
    argv.push("--doc-format", "markdown", "--content", p.content);
  }
  return argv;
}
function inspectArgv(binPath, docToken, asIdentity) {
  return [binPath, "drive", "+inspect", "--url", docToken, "--type", "docx", "--as", asIdentity];
}
function patchTitleArgv(binPath, docToken, asIdentity, newTitle) {
  return [
    binPath,
    "drive",
    "files",
    "patch",
    "--params",
    JSON.stringify({ file_token: docToken, type: "docx" }),
    "--data",
    JSON.stringify({ new_title: newTitle }),
    "--as",
    asIdentity
  ];
}
function summarizeFailure(result) {
  const trailer = result.stderr.trim() || result.stdout.trim() || `code=${result.code}`;
  return trailer.length > 240 ? `${trailer.slice(0, 239)}\u2026` : trailer;
}
function detectDocAccessError(text, asIdentity) {
  const lower = text.toLowerCase();
  if (lower.includes("permission") || lower.includes("forbidden") || lower.includes("not authorized") || lower.includes("no access") || lower.includes("99991")) {
    return `lark-cli docs op denied for identity "${asIdentity}" \u2014 ` + (asIdentity === "bot" ? "the bot needs EDIT access: share the target doc with the bot app, or switch doc identity to user." : "run `lark-cli` user auth (device-flow) for the configured account, or share the doc with the bot and use bot identity.");
  }
  return void 0;
}
async function runCli(runCommand, argv, timeoutMs, asIdentity) {
  let result;
  try {
    result = await runCommand(argv, { timeoutMs });
  } catch (err) {
    const e = err;
    if (e && e.code === "ENOENT") {
      return {
        ok: false,
        error: `lark-cli not found at "${argv[0]}" \u2014 install via \`npm install -g @larksuite/cli@latest\` and complete \`lark-cli config init\` / user auth on the host`
      };
    }
    return { ok: false, error: `lark-cli spawn failed: ${err.message}` };
  }
  if (result.code !== 0) {
    const hint = detectDocAccessError(`${result.stderr}
${result.stdout}`, asIdentity);
    return {
      ok: false,
      error: hint ?? `lark-cli exit ${result.code} \u2014 ${summarizeFailure(result)}`
    };
  }
  return { ok: true, stdout: result.stdout };
}
async function writeWeeklySection(params) {
  const { runCommand, binPath, asIdentity, docToken, weekKey: weekKey2, weekTitle: weekTitle2, timeoutMs } = params;
  const outlineRes = await runCli(
    runCommand,
    fetchArgv({ binPath, docToken, asIdentity, scope: "outline" }),
    timeoutMs,
    asIdentity
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
  const deleteIds = /* @__PURE__ */ new Set();
  const headingId = findWeekSectionHeadingId(headings, weekTitle2);
  if (headingId) {
    const sectionRes = await runCli(
      runCommand,
      fetchArgv({ binPath, docToken, asIdentity, scope: "section", startBlockId: headingId }),
      timeoutMs,
      asIdentity
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
  await collectOrphanSentinelIds({
    runCommand,
    binPath,
    asIdentity,
    docToken,
    weekKey: weekKey2,
    timeoutMs
  }).then(
    (ids) => ids.forEach((id) => deleteIds.add(id)),
    () => {
    }
  );
  if (deleteIds.size > 0) {
    const delRes = await runCli(
      runCommand,
      updateArgv({
        binPath,
        docToken,
        asIdentity,
        command: "block_delete",
        blockId: [...deleteIds].join(",")
      }),
      timeoutMs,
      asIdentity
    );
    if (!delRes.ok) {
      return { ok: false, error: `block_delete: ${delRes.error}` };
    }
  }
  const insertRes = await runCli(
    runCommand,
    updateArgv({
      binPath,
      docToken,
      asIdentity,
      command: "block_insert_after",
      blockId: pageId,
      // page anchor = document head
      content: params.sectionMarkdown
    }),
    timeoutMs,
    asIdentity
  );
  if (!insertRes.ok) {
    return { ok: false, error: `block_insert_after: ${insertRes.error}` };
  }
  const titleNote = await bumpDocTitleDate({
    runCommand,
    binPath,
    asIdentity,
    docToken,
    todayMMDD: formatMMDD(params.now ?? /* @__PURE__ */ new Date()),
    timeoutMs
  });
  return titleNote ? { ok: true, titleNote } : { ok: true };
}
async function bumpDocTitleDate(p) {
  const inspectRes = await runCli(
    p.runCommand,
    inspectArgv(p.binPath, p.docToken, p.asIdentity),
    p.timeoutMs,
    p.asIdentity
  );
  if (!inspectRes.ok) {
    return `\u6807\u9898\u65E5\u671F\u672A\u66F4\u65B0\uFF08\u8BFB\u53D6\u6807\u9898\u5931\u8D25\uFF1A${inspectRes.error}\uFF09`;
  }
  const currentTitle = parseInspectTitle(inspectRes.stdout);
  if (!currentTitle) {
    return void 0;
  }
  const newTitle = nextDocTitle(currentTitle, p.todayMMDD);
  if (!newTitle || newTitle === currentTitle) {
    return void 0;
  }
  const patchRes = await runCli(
    p.runCommand,
    patchTitleArgv(p.binPath, p.docToken, p.asIdentity, newTitle),
    p.timeoutMs,
    p.asIdentity
  );
  if (!patchRes.ok) {
    return `\u6807\u9898\u65E5\u671F\u672A\u66F4\u65B0\uFF08${patchRes.error}\uFF09`;
  }
  return void 0;
}
function legacySentinelKeyword(weekKey2) {
  return `weekly-report:begin weekKey=${weekKey2}|weekly-report:end weekKey=${weekKey2}`;
}
async function collectOrphanSentinelIds(p) {
  const res = await runCli(
    p.runCommand,
    fetchArgv({
      binPath: p.binPath,
      docToken: p.docToken,
      asIdentity: p.asIdentity,
      scope: "keyword",
      keyword: legacySentinelKeyword(p.weekKey)
    }),
    p.timeoutMs,
    p.asIdentity
  );
  if (!res.ok) {
    return [];
  }
  const parsed = parseFetchEnvelope(res.stdout);
  return parsed.ok ? collectBlockIds(parsed.content) : [];
}

// extensions/weekly-report/src/drafting-contract.ts
var DRAFTING_HARD_RULES = `**\u8349\u7A3F\u786C\u89C4\u5219\uFF08\u7B2C\u4E00\u8F6E\u548C\u8865\u5145\u4FEE\u8BA2\u90FD\u5FC5\u987B\u9075\u5B88\uFF0C\u4E0D\u5141\u8BB8\u653E\u677E\uFF09\uFF1A**

1. **\u89C6\u89D2\uFF1D\u7B2C\u4E00\u4EBA\u79F0\u300C\u6211\u300D\u3002** \u8FD9\u4EFD\u5468\u62A5\u662F\u300C\u6211\u300D\uFF08\u5BF9\u8BDD\u7684\u4EBA\u7C7B\u4E3B\u4EBA\uFF09\u5199\u7ED9\u300C\u6211\u7684\u4E3B\u7BA1\u300D\u770B\u7684\uFF0C\u6C47\u62A5\u300C\u6211\u300D\u672C\u5468
   \u505A\u4E86\u4EC0\u4E48\u3002\u6240\u6709\u6587\u5B57\u7528\u7B2C\u4E00\u4EBA\u79F0\uFF1A\u300C\u6211\u5B9E\u73B0\u4E86 X\u300D\u300C\u6211\u63D0\u4EA4\u4E86 Y\u300D\u300C\u6211\u548C\u56E2\u961F\u5B9A\u4E0B\u4E86 Z\u300D\u3002
   - **\u7981\u6B62\u7B2C\u4E8C\u4EBA\u79F0\u5EFA\u8BAE\u53E3\u543B**\uFF1A\u4E0D\u5141\u8BB8\u51FA\u73B0\u300C\u4F60\u5E94\u8BE5\u2026\u300D\u300C\u5EFA\u8BAE\u4F60\u2026\u300D\u300CYou should\u2026\u300D\u8FD9\u7C7B\u628A\u8BFB\u8005\u5F53\u6210\u88AB\u6307\u5BFC\u5BF9\u8C61\u7684\u5199\u6CD5\u3002
   - \`intent\`\uFF1D\u6211\u4E3A\u4EC0\u4E48\u505A\u8FD9\u4E2A\u9879\u76EE\uFF08\u52A8\u673A\uFF09\uFF1B\`objective\`\uFF1D\u8FD9\u4E2A\u9879\u76EE\u672C\u8EAB\u5728\u4EA7\u54C1/\u4E1A\u52A1/\u6280\u672F\u4E0A\u8981\u8FBE\u6210\u4EC0\u4E48\uFF0C
     **\u4E0D\u662F**\u300C\u8BA9\u5468\u62A5\u5199\u6E05\u695A\u300D\u8FD9\u79CD\u5199\u4F5C\u76EE\u6807\uFF1B\`completed\`\uFF1D\u672C\u5468\u6211\u5B9E\u9645\u4EA7\u51FA/\u63A8\u8FDB\u7684\u52A8\u4F5C\u3002

2. **\`completed\` \u5199\u4E8B\u5B9E\uFF0C\u4E0D\u5199\u804A\u5929\u8BB0\u5F55\u3002** \u6BCF\u6761 bullet \u5FC5\u987B\u843D\u5728\u53EF\u6838\u9A8C\u7684\u4EA7\u51FA\u4E0A\uFF1A
   - \u5F15\u7528\u771F\u5B9E\u4EE3\u7801\u52A8\u4F5C\u2014\u2014\u63D0\u4EA4/\u5408\u5E76/\u4E0A\u7EBF\uFF08\u5F15\u7528 \`fetch_git_activity\` \u7684 commit \u6807\u9898 + \u5206\u652F/ref\uFF09\u3002
   - \u5F15\u7528\u771F\u5B9E\u4EA4\u4ED8\u7269\u2014\u2014\u63D0\u4EA4\u7684\u65B9\u6848\u3001\u6587\u6863\u3001PR\u3001\u53D1\u5E03\u3002
   - \u5F15\u7528**\u5DF2\u8FBE\u6210\u5E76\u5BF9\u9F50\u7684\u7ED3\u8BBA/\u51B3\u7B56**\uFF08\u5199\u6E05\u7ED3\u8BBA\u672C\u8EAB\uFF0C\u800C\u4E0D\u662F\u300C\u6211\u4EEC\u804A\u5230\u4E86\u8FD9\u4E2A\u8BDD\u9898\u300D\uFF09\u3002
   - **\u7981\u6B62**\u5199\u300C\u6211\u4EEC\u8BA8\u8BBA\u4E86 X\u300D\u300C\u548C\u67D0\u67D0\u804A\u4E86 Y\u300D\u8FD9\u7C7B\u5BF9\u8BDD\u590D\u8FF0\u3002\u5982\u679C\u67D0\u4EF6\u4E8B\u53EA\u6709\u8BA8\u8BBA\u3001\u6CA1\u6709\u5177\u4F53\u4EA7\u51FA\u6216\u7ED3\u8BBA\uFF0C
     \u8981\u4E48\u628A\u5B83\u6302\u5230\u5B83\u4EA7\u751F\u7684\u4EA7\u7269/\u51B3\u7B56\u4E0A\uFF0C\u8981\u4E48\u76F4\u63A5\u4E0D\u5199\u3002

3. **\u7981\u6B62 meta \u9879\u76EE\u3002** current_week \u4E0D\u5141\u8BB8\u51FA\u73B0\u4EE5\u300C\u5BF9\u4E0A\u4E00\u6B21\u5468\u62A5\u8349\u7A3F\u7684\u53CD\u601D / \u804C\u8D23\u8FB9\u754C\u6F84\u6E05 / \u7FA4\u804A\u7D20\u6750\u6821\u6B63 /
   \u5468\u62A5\u53E3\u5F84\u300D\u4E3A\u4E3B\u9898\u7684\u9879\u76EE\u3002\u8BC6\u522B\u4FE1\u53F7\uFF1Atitle \u542B\u300C\u7D20\u6750\u6821\u6B63\u300D\u300C\u804C\u8D23\u8FB9\u754C\u6F84\u6E05\u300D\u300C\u5468\u62A5\u53E3\u5F84\u300D\uFF0C\u6216 intent/objective
   \u5728\u8C08\u300C\u5468\u62A5\u5E94\u8BE5\u5982\u4F55\u5199 / \u8349\u7A3F\u5982\u4F55\u4FEE\u6B63\u300D\u2014\u2014\u76F4\u63A5\u780D\u6389\u3002

4. **bullet \u6587\u672C\u7981\u6B62\u51FA\u73B0\u98DE\u4E66\u673A\u5668 ID\u3002** \u4E0D\u5141\u8BB8 \`chat_id\`\u3001\`message_id\`\u3001\`oc_xxx\`\u3001\`om_xxx\`\u3002
   \u5F15\u7528\u7FA4\u5FC5\u987B\u7528\u7FA4\u540D\uFF08\u5982\u300C\u6280\u672F\u57FA\u5EFA\u5C0F\u7EC4\u300D\u300Cclaude code \u7FA4\u300D\uFF09\uFF0C\u5F15\u7528\u6D88\u606F\u76F4\u63A5\u5F15\u7528\u539F\u8BDD\u6216\u5173\u952E\u77ED\u8BED\uFF0C\u4E0D\u5E26 ID \u62EC\u53F7\u3002`;
var DRAFTING_CONTRACT = `\u4F60\u6B63\u5728\u4E3A\u8FD9\u6BB5\u5BF9\u8BDD\u7684\u4EBA\u7C7B\u4E3B\u4EBA\u8D77\u8349\u672C\u5468\u5468\u62A5\u3002\u8FD9\u4EFD\u5468\u62A5\u7531\u300C\u6211\u300D\uFF08\u4E3B\u4EBA\uFF09\u5199\u7ED9\u300C\u6211\u7684\u4E3B\u7BA1\u300D\uFF0C\u6240\u4EE5\u5168\u7A0B\u7528\u7B2C\u4E00\u4EBA\u79F0\u3002

\u672C\u5468\u5927\u6982\u7387\u662F\uFF1AweekKey=\`{weekKeyHint}\`\uFF0CweekTitle=\`{weekTitleHint}\`\uFF08\u5982\u679C\u4E0A\u4E0B\u6587\u660E\u786E\u6307\u5411\u53E6\u4E00\u5468\uFF0C\u4EE5\u4E0A\u4E0B\u6587\u4E3A\u51C6\uFF1B
weekTitle \u683C\u5F0F\u4E3A "YYYY.M.D-YYYY.M.D"\uFF0C\u5468\u4E00\u2192\u5468\u65E5\uFF0C\u6708/\u65E5\u4E0D\u8865\u96F6\uFF09\u3002

\u6B65\u9AA4\uFF1A
1. **\u540C\u4E00\u56DE\u5408\u5185\u5E76\u884C\u8C03\u7528\u4E09\u4E2A\u4E8B\u5B9E\u6E90**\uFF08\u4E92\u4E0D\u963B\u585E\uFF0C\u5FC5\u987B\u4E00\u8D77\u53D1\u8D77\uFF09\uFF1A
   - \`runtime.subagent.getSessionMessages\`\uFF08\u6216\u7B49\u4EF7\u7684\u672C\u4F1A\u8BDD\u8F6C\u5199\u8BFB\u53D6\uFF09\u2014\u2014\u672C DM \u4F1A\u8BDD\u8FC7\u53BB 7 \u5929\u7684\u5BF9\u8BDD\u3002
   - \`fetch_git_activity\`\u2014\u2014\u672C\u5468\u914D\u7F6E\u4ED3\u5E93\u91CC\u6211\u7684\u63D0\u4EA4\u3002\u672A\u914D\u7F6E gitRemotes \u65F6\u8FD4\u56DE\u7A7A\uFF0C\u8DF3\u8FC7\u5373\u53EF\u3002
   - \`fetch_recent_group_messages\`\u2014\u2014\u672C\u5468\u6211\u5728\u98DE\u4E66\u7FA4\u91CC\u7684\u53D1\u8A00/\u88AB\u63D0\u53CA/\u53C2\u4E0E\u7684\u8BDD\u9898\u3002
2. **\u628A\u7D20\u6750\u6309\u9879\u76EE\uFF08\u800C\u4E0D\u662F\u65F6\u95F4\u7EBF\uFF09\u5F52\u5E76\u6210\u4E0B\u9762\u7684 JSON schema\u3002** \u6BCF\u4E2A current_week \u9879\u76EE\u90FD\u8981\u6709\u771F\u5B9E\u7684
   \`intent\`\uFF08\u9879\u76EE\u4E3A\u4EC0\u4E48\u5B58\u5728\uFF09\u3001\`objective\`\uFF08\u8FD9\u4E2A\u9879\u76EE\u8981\u8FBE\u6210\u4EC0\u4E48\uFF09\u3001\u4EE5\u53CA\u81F3\u5C11\u4E00\u6761 \`completed\`\uFF08\u672C\u5468\u5B9E\u9645\u4EA7\u51FA\uFF09\u3002
   \u6309\u300C\u8349\u7A3F\u786C\u89C4\u5219\u300D\u628A completed \u843D\u5728\u771F\u5B9E\u7684 commit / \u63D0\u4EA4 / \u7ED3\u8BBA\u4E0A\u3002\u5982\u679C\u67D0\u4E2A\u9879\u76EE\u7684 intent/objective \u65E0\u6CD5\u4ECE
   \u4E0A\u4E0B\u6587\u5224\u65AD\uFF0C**\u5148\u95EE\u6211**\uFF0C\u4E0D\u8981\u7F16\u5360\u4F4D\u6587\u5B57\u3002
3. **\u5931\u8D25\u900F\u660E\u89C4\u5219**\uFF1A\u5982\u679C \`fetch_git_activity.repos\` \u6216 \`fetch_recent_group_messages.passes\` \u91CC\u6709\u4EFB\u4F55
   \`ok: false\`\uFF0C\u6216\u5DE5\u5177\u8FD4\u56DE\u4E86\u9876\u5C42 \`ok: false\`\uFF08\u5982 userOpenId \u65E0\u6CD5\u89E3\u6790\uFF09\uFF0C\u5728\u8349\u7A3F\u91CC\u70B9\u660E\u8FD9\u5757\u6570\u636E\u7F3A\u5931
   \uFF08\u4F8B\u5982\u300C\`growx\` \u7684 git \u6570\u636E\u672C\u6B21\u4E0D\u53EF\u7528\uFF1A<error>\u300D\uFF09\uFF0C\u800C\u4E0D\u662F\u6084\u6084\u4E22\u6389\u3002
4. **\u8C03\u7528 \`submit_weekly_report_draft({ weekKey, weekTitle, draftJson })\`** \u63D0\u4EA4\u8349\u7A3F\u3002\u5B83\u4F1A\u521B\u5EFA TaskFlow\u3001
   \u628A\u786E\u8BA4\u5361\u7247\u76F4\u63A5\u6295\u9012\u5230\u6211\u7684 DM\uFF08\u901A\u8FC7 lark-cli bot \u6A21\u5F0F\uFF09\uFF0C\u5E76\u8FD4\u56DE \`{flowId, weekKey, weekTitle, ...}\`\u3002
   **\u4E0D\u8981**\u518D\u8C03\u7528 \`feishu_ask_user_question\`\uFF0C\u4E5F\u4E0D\u8981\u628A\u9884\u89C8\u5F53\u6210\u7EAF\u6587\u672C/JSON \u56DE\u590D\u2014\u2014\u5361\u7247\u5DF2\u7ECF\u7531\u8BE5\u5DE5\u5177\u53D1\u51FA\u3002
   \u4F60\u8FD9\u4E00\u56DE\u5408\u5230\u6B64\u7ED3\u675F\uFF1B\u6211\u4F1A\u5728 DM \u91CC\u70B9\u300C\u76F4\u63A5\u5199\u5165\u300D\u6216\u300C\u63D0\u4EA4\u8865\u5145\u300D\u3002

${DRAFTING_HARD_RULES}

JSON schema\uFF1A
{
  "week_title": "YYYY.M.D-YYYY.M.D",
  "current_week": [
    {
      "title": "\u9879\u76EE / \u65B9\u5411\u540D\u79F0",
      "intent": "\u6211\u4E3A\u4EC0\u4E48\u505A\u8FD9\u4E2A\u9879\u76EE\uFF081-2 \u53E5\uFF09",
      "objective": "\u8FD9\u4E2A\u9879\u76EE\u8981\u8FBE\u6210\u4EC0\u4E48",
      "completed": ["\u4E8B\u5B9E bullet 1", "\u4E8B\u5B9E bullet 2", ...]
    }
  ],
  "next_week": [
    { "project": "\u9879\u76EE\u540D", "plan": "\u4E0B\u5468\u8BA1\u5212" }
  ]
}

\u7EA6\u675F\uFF1A
- "current_week" \u548C "next_week" \u81F3\u5C11\u5404\u4E00\u6761\u3002next_week \u5B9E\u5728\u6CA1\u6709\u5185\u5BB9\u65F6\uFF0C\u5148\u95EE\u6211\uFF0C\u4E0D\u8981\u7F16\u3002
- \u6240\u6709\u5B57\u7B26\u4E32\u53BB\u7A7A\u767D\u540E\u5FC5\u987B\u975E\u7A7A\u3002
- \u8F93\u51FA\u5FC5\u987B\u662F\u7B26\u5408 schema \u7684\u5408\u6CD5 JSON\uFF0C\u5426\u5219\u5DE5\u5177\u4F1A\u62D2\u7EDD\u3002`;
function buildDraftingContract(params) {
  return DRAFTING_CONTRACT.replace("{weekKeyHint}", params.weekKeyHint).replace(
    "{weekTitleHint}",
    params.weekTitleHint
  );
}

// extensions/weekly-report/src/report-renderer.ts
var RenderError = class extends Error {
};
function requireString(obj, key) {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RenderError(`Field '${key}' must be a non-empty string`);
  }
  return value.trim();
}
function requireList(obj, key) {
  const value = obj[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new RenderError(`Field '${key}' must be a non-empty list`);
  }
  return value;
}
function normalizeBulletLines(lines, fieldName) {
  return lines.map((line, idx) => {
    if (typeof line !== "string" || line.trim() === "") {
      throw new RenderError(`${fieldName}[${idx + 1}] must be a non-empty string`);
    }
    return line.trim();
  });
}
function renderItem(index, item) {
  const title = requireString(item, "title");
  const intent = requireString(item, "intent");
  const objective = requireString(item, "objective");
  const completed = normalizeBulletLines(requireList(item, "completed"), "completed");
  const lines = [];
  lines.push(`#### ${index}. ${title}`);
  lines.push("**\u610F\u56FE\uFF1A**");
  lines.push(intent);
  lines.push("");
  lines.push("**\u76EE\u6807\uFF1A**");
  lines.push(objective);
  lines.push("");
  lines.push("**\u5B8C\u6210\u5185\u5BB9\uFF1A**");
  for (const bullet of completed) {
    lines.push(`- ${bullet}`);
  }
  return lines.join("\n");
}
function escapeCell(value) {
  return value.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}
function renderNextWeekTable(rows) {
  const parts = ["| \u9879\u76EE | \u8BA1\u5212 |", "| --- | --- |"];
  for (const row of rows) {
    const project = escapeCell(requireString(row, "project"));
    const plan = escapeCell(requireString(row, "plan"));
    parts.push(`| **${project}** | ${plan} |`);
  }
  return parts.join("\n");
}
function renderReport(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new RenderError("input must be an object");
  }
  const data = input;
  const weekTitle2 = requireString(data, "week_title");
  const currentItems = requireList(data, "current_week");
  const nextWeekRowsRaw = requireList(data, "next_week");
  const lines = [];
  lines.push(`## ${weekTitle2}`);
  lines.push("### \u672C\u5468\u5DE5\u4F5C");
  lines.push("");
  currentItems.forEach((item, idx) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new RenderError(`current_week[${idx + 1}] must be an object`);
    }
    lines.push(renderItem(idx + 1, item));
    lines.push("");
  });
  const nextWeekRows = nextWeekRowsRaw.map((row, idx) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new RenderError(`next_week[${idx + 1}] must be an object`);
    }
    return row;
  });
  lines.push("### \u4E0B\u5468\u8BA1\u5212");
  lines.push(renderNextWeekTable(nextWeekRows));
  lines.push("");
  lines.push("---");
  return `${lines.join("\n").replace(/\s+$/u, "")}
`;
}

// extensions/weekly-report/src/tools.ts
import { Type } from "typebox";

// extensions/weekly-report/src/dedupe.ts
function findActiveWeeklyReportFlow(params) {
  for (const flow of params.flows) {
    if (flow.controllerId !== params.controllerId) {
      continue;
    }
    if (!ACTIVE_STATUSES.has(flow.status)) {
      continue;
    }
    if (!isWeeklyReportFlowState(flow.stateJson)) {
      continue;
    }
    if (flow.stateJson.weekKey !== params.weekKey) {
      continue;
    }
    return {
      flowId: flow.flowId,
      revision: flow.revision,
      weekKey: flow.stateJson.weekKey
    };
  }
  return null;
}

// extensions/weekly-report/src/git-activity.ts
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
var GIT_BIN = "git";
var COMMIT_FORMAT = "%H%x1f%ct%x1f%an%x1f%ae%x1f%D%x1f%s";
var SAFE_PROTOCOL_FLAGS = [
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "submodule.recurse=false"
];
function hardenedEnv() {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    // SSH session: never spawn a TTY/askpass, and prefer batch mode.
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10"
  };
}
async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
function formatExecError(label, result) {
  const trailer = result.stderr.trim() || result.stdout.trim() || `code=${result.code}`;
  const reason = result.noOutputTimedOut ? "no-output timeout" : result.termination === "signal" ? `killed (${result.signal ?? "SIGTERM"})` : `exit ${result.code}`;
  return `${label}: ${reason} \u2014 ${trimTo(trailer, 240)}`;
}
function trimTo(value, limit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}\u2026`;
}
function parseGitLogOutput(stdout) {
  if (!stdout) return [];
  const records = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("");
    if (parts.length < 6) continue;
    const ctSeconds = Number(parts[1]);
    if (!Number.isFinite(ctSeconds)) continue;
    const refs = parts[4].trim();
    const record = {
      sha: parts[0],
      ts: ctSeconds * 1e3,
      authorName: parts[2],
      authorEmail: parts[3],
      subject: parts[5]
    };
    if (refs) record.refs = refs;
    records.push(record);
  }
  return records;
}
function buildLogArgs(params) {
  return [
    ...SAFE_PROTOCOL_FLAGS,
    "log",
    `--author=${params.author}`,
    `--since=${params.sinceIso}`,
    `--until=${params.untilIso}`,
    `--max-count=${params.maxCommits}`,
    "--all",
    params.includeMerges ? "--merges" : "--no-merges",
    `--format=${COMMIT_FORMAT}`
  ];
}
function buildCloneArgs(sshUrl, dest) {
  return [
    ...SAFE_PROTOCOL_FLAGS,
    "clone",
    "--depth=200",
    "--no-tags",
    "--filter=blob:none",
    "--quiet",
    sshUrl,
    dest
  ];
}
var FETCH_ARGS = [...SAFE_PROTOCOL_FLAGS, "fetch", "--all", "--prune", "--quiet"];
function isProductionSshUrl(sshUrl) {
  return /^[A-Za-z0-9_-]+@[A-Za-z0-9.-]+:[\w./-]+\.git$/u.test(sshUrl);
}
async function runGitActivity(params) {
  const {
    settings,
    runCommand,
    resolveStateDir,
    repoFilter,
    allowLocalUrls = false,
    now = Date.now
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
  const workspaceDir = settings.gitWorkspaceDir ?? join(resolveStateDir(), "weekly-report", "repos");
  await ensureDir(workspaceDir);
  const filterSet = repoFilter ? new Set(repoFilter) : null;
  const eligibleRemotes = settings.gitRemotes.filter(
    (remote) => !filterSet || filterSet.has(remote.name)
  );
  const ctx = {
    workspaceDir,
    author: settings.gitAuthor,
    sinceIso: new Date(sinceTs).toISOString(),
    untilIso: new Date(untilTs).toISOString(),
    maxCommits: settings.gitMaxCommitsPerRepo,
    fetchTimeoutMs: settings.gitFetchTimeoutMs,
    runCommand,
    overallDeadlineMs: nowMs + settings.gitOverallTimeoutMs,
    allowLocalUrls,
    now
  };
  const results = new Array(eligibleRemotes.length);
  const parallelism = Math.max(1, Math.min(settings.gitMaxParallelOps, eligibleRemotes.length));
  let cursor = 0;
  const workers = Array.from({ length: parallelism }, async () => {
    for (; ; ) {
      const myIndex = cursor++;
      if (myIndex >= eligibleRemotes.length) return;
      const remote = eligibleRemotes[myIndex];
      results[myIndex] = await processRepo(remote, ctx);
    }
  });
  await Promise.all(workers);
  return { windowStart: sinceTs, windowEnd: untilTs, repos: results };
}
async function processRepo(remote, ctx) {
  const repoDir = join(ctx.workspaceDir, remote.name);
  try {
    if (!ctx.allowLocalUrls && !isProductionSshUrl(remote.sshUrl)) {
      return {
        name: remote.name,
        sshUrl: remote.sshUrl,
        ok: false,
        error: "sshUrl rejected by production allowlist"
      };
    }
    const remainingBudget = Math.max(0, ctx.overallDeadlineMs - ctx.now());
    if (remainingBudget <= 0) {
      return {
        name: remote.name,
        sshUrl: remote.sshUrl,
        ok: false,
        error: "gitOverallTimeoutMs exhausted before repo could run"
      };
    }
    const stepTimeout = Math.min(ctx.fetchTimeoutMs, remainingBudget);
    const exists = await pathExists(join(repoDir, ".git"));
    if (!exists) {
      const cloneRes = await ctx.runCommand([GIT_BIN, ...buildCloneArgs(remote.sshUrl, repoDir)], {
        timeoutMs: stepTimeout,
        env: hardenedEnv()
      });
      if (cloneRes.code !== 0) {
        return {
          name: remote.name,
          sshUrl: remote.sshUrl,
          ok: false,
          error: formatExecError("clone", cloneRes)
        };
      }
    } else {
      const fetchRes = await ctx.runCommand([GIT_BIN, ...FETCH_ARGS], {
        timeoutMs: stepTimeout,
        cwd: repoDir,
        env: hardenedEnv()
      });
      if (fetchRes.code !== 0) {
        return {
          name: remote.name,
          sshUrl: remote.sshUrl,
          ok: false,
          error: formatExecError("fetch", fetchRes)
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
          includeMerges: false
        })
      ],
      { timeoutMs: stepTimeout, cwd: repoDir, env: hardenedEnv() }
    );
    if (logRes.code !== 0) {
      return {
        name: remote.name,
        sshUrl: remote.sshUrl,
        ok: false,
        error: formatExecError("log", logRes)
      };
    }
    const commits = parseGitLogOutput(logRes.stdout);
    return { name: remote.name, sshUrl: remote.sshUrl, ok: true, commits };
  } catch (err) {
    return {
      name: remote.name,
      sshUrl: remote.sshUrl,
      ok: false,
      error: `unexpected: ${err.message}`
    };
  }
}
async function ensureDir(path) {
  if (await pathExists(path)) return;
  await mkdir(path, { recursive: true });
  await mkdir(dirname(path), { recursive: true });
}
function mondayMidnightUtcMs(refMs) {
  const d = new Date(refMs);
  const day = d.getUTCDay();
  const isoDayIndex = day === 0 ? 7 : day;
  d.setUTCDate(d.getUTCDate() - (isoDayIndex - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// extensions/weekly-report/src/group-activity.ts
var MAX_PAGE_SIZE = 50;
function mondayMidnightUtcMs2(refMs, weekStartsOn = "monday") {
  const d = new Date(refMs);
  const day = d.getUTCDay();
  if (weekStartsOn === "sunday") {
    d.setUTCDate(d.getUTCDate() - day);
  } else {
    const isoDayIndex = day === 0 ? 7 : day;
    d.setUTCDate(d.getUTCDate() - (isoDayIndex - 1));
  }
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
function parseLarkCliTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return void 0;
  const normalized = value.endsWith("+08:00") ? `${value.slice(0, -6)}Z` : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : void 0;
}
function readSenderId(sender) {
  if (sender && typeof sender === "object") {
    const s = sender;
    if (typeof s.id === "string" && s.id.length > 0) return s.id;
  }
  return void 0;
}
function readSenderType(sender) {
  if (sender && typeof sender === "object") {
    const s = sender;
    if (typeof s.sender_type === "string") return s.sender_type;
  }
  return "unknown";
}
function readMentions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const m of value) {
    if (m && typeof m === "object") {
      const id = m.id;
      if (typeof id === "string" && id.length > 0) out.push(id);
    }
  }
  return out;
}
function preprocessMessage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const msg = raw;
  const messageId = typeof msg.message_id === "string" ? msg.message_id : "";
  const chatId = typeof msg.chat_id === "string" ? msg.chat_id : "";
  if (!messageId || !chatId) return void 0;
  const ts = parseLarkCliTimestamp(msg.create_time);
  const senderOpenId = readSenderId(msg.sender);
  if (ts === void 0 || !senderOpenId) return void 0;
  const text = typeof msg.content === "string" ? msg.content : "";
  const msgType = typeof msg.msg_type === "string" ? msg.msg_type : "unknown";
  const out = {
    messageId,
    chatId,
    ts,
    senderOpenId,
    senderType: readSenderType(msg.sender),
    text,
    msgType
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
function extractJsonPayload(stdout) {
  if (!stdout) return void 0;
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
    return void 0;
  }
  let startIdx = -1;
  for (let i = endIdx; i >= 0; i--) {
    if (lines[i] === "{") {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return void 0;
  return lines.slice(startIdx, endIdx + 1).join("\n");
}
function extractMessagePage(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { items: [], hasMore: false, pageToken: void 0 };
  }
  const obj = parsed;
  const items = Array.isArray(obj.messages) ? obj.messages : [];
  const hasMore = obj.has_more === true;
  const pageToken = typeof obj.page_token === "string" && obj.page_token.length > 0 ? obj.page_token : void 0;
  return { items, hasMore, pageToken };
}
function isDenylisted(chatId, denylist) {
  if (denylist.length === 0) return false;
  return denylist.includes(chatId);
}
function buildSearchArgv(params) {
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
    String(params.pageSize)
  ];
  if (params.pageToken) {
    argv.push("--page_token", params.pageToken);
  }
  return argv;
}
function detectAuthOrScopeError(text, accountId) {
  const lower = text.toLowerCase();
  if (lower.includes("not authorized") || lower.includes("device-flow") || lower.includes("user-mapping") || lower.includes(".user not found")) {
    return `larkcli auth invalid for account "${accountId}" \u2014 run \`larkcli -a ${accountId} auth device-flow\` once to populate the user-mapping file (openclaw-lark's UAT keychain entry is reused, but the <appId>.user mapping is owned by lark-cli)`;
  }
  if (lower.includes("search:message") || lower.includes("scope grant") || lower.includes("scope_not_granted")) {
    return `larkcli scope missing for account "${accountId}" \u2014 run \`larkcli -a ${accountId} im search-messages --query test --page_size 1\` interactively once and complete the search:message scope grant prompt`;
  }
  return void 0;
}
function summarizeExecFailure2(result) {
  const trailer = result.stderr.trim() || result.stdout.trim() || `code=${result.code}`;
  return trailer.length > 240 ? `${trailer.slice(0, 239)}\u2026` : trailer;
}
async function runPass(params) {
  const { kind, settings, userOpenId, accountId, runCommand, sinceIso, untilIso } = params;
  const pageSize = Math.min(settings.groupMaxMessagesPerPass, MAX_PAGE_SIZE);
  const maxPages = Math.max(1, settings.larkCliMaxPages);
  const messages = [];
  let pageToken;
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
      pageToken
    });
    let result;
    try {
      result = await runCommand(argv, { timeoutMs: settings.larkCliTimeoutMs });
    } catch (err) {
      const e = err;
      pagesWalked++;
      if (e && e.code === "ENOENT") {
        return {
          kind,
          ok: false,
          messages: [],
          error: `larkcli not found at "${settings.larkCliBinPath}" \u2014 install via \`npm install -g @richord/lark-cli@0.0.4\` and bootstrap ~/.feishu-cli/config.json with account "${accountId}"`,
          pagesWalked
        };
      }
      return {
        kind,
        ok: false,
        messages: [],
        error: `larkcli spawn failed: ${err.message}`,
        pagesWalked
      };
    }
    pagesWalked++;
    if (result.code !== 0) {
      const trailer = summarizeExecFailure2(result);
      const hint = detectAuthOrScopeError(`${result.stderr}
${result.stdout}`, accountId);
      return {
        kind,
        ok: false,
        messages: [],
        error: hint ?? `larkcli ${kind} pass exit ${result.code} \u2014 ${trailer}`,
        pagesWalked
      };
    }
    const jsonPayload = extractJsonPayload(result.stdout);
    if (!jsonPayload) {
      const head = result.stdout.slice(0, 240);
      return {
        kind,
        ok: false,
        messages: [],
        error: `larkcli ${kind} pass: no JSON payload in stdout \u2014 ${head}`,
        pagesWalked
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonPayload);
    } catch {
      const head = jsonPayload.slice(0, 240);
      return {
        kind,
        ok: false,
        messages: [],
        error: `larkcli ${kind} pass: unparseable JSON payload \u2014 ${head}`,
        pagesWalked
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
        pagesWalked
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
        ...pre.chatName ? { chatName: pre.chatName } : {},
        ...pre.threadId ? { threadId: pre.threadId } : {},
        ...pre.mentions ? { mentions: pre.mentions } : {}
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
  const ok = { kind, ok: true, messages, pagesWalked };
  if (hasMoreAtCap) ok.truncated = true;
  return ok;
}
async function runGroupActivity(params) {
  const { settings, runCommand } = params;
  const now = params.now ?? Date.now;
  const nowMs = now();
  const sinceTs = params.sinceTs ?? mondayMidnightUtcMs2(nowMs, settings.weekStartsOn);
  const untilTs = params.untilTs ?? nowMs;
  if (!settings.userOpenId) {
    return {
      windowStart: sinceTs,
      windowEnd: untilTs,
      userOpenId: void 0,
      accountId: settings.larkCliAccountId,
      passes: [],
      groupedByChat: {},
      ok: false,
      error: "userOpenId not configured and not derivable from recipientSessionKey. Set plugins.entries.weekly-report.userOpenId to your Feishu open_id (ou_...) to enable group-message collection."
    };
  }
  if (!settings.larkCliAccountId) {
    return {
      windowStart: sinceTs,
      windowEnd: untilTs,
      userOpenId: settings.userOpenId,
      accountId: void 0,
      passes: [],
      groupedByChat: {},
      ok: false,
      error: "larkCliAccountId is required to enable group-message collection. Set plugins.entries.weekly-report.larkCliAccountId to your lark-cli account id (matching ~/.feishu-cli/config.json)."
    };
  }
  const includeReasons = params.includeReasons ?? ["author", "mention"];
  const passKinds = [];
  if (includeReasons.includes("author")) passKinds.push("author");
  if (includeReasons.includes("mention")) passKinds.push("mention");
  if (passKinds.length === 0) {
    return {
      windowStart: sinceTs,
      windowEnd: untilTs,
      userOpenId: settings.userOpenId,
      accountId: settings.larkCliAccountId,
      passes: [],
      groupedByChat: {}
    };
  }
  const sinceIso = new Date(sinceTs).toISOString();
  const untilIso = new Date(untilTs).toISOString();
  const passes = [];
  for (const kind of passKinds) {
    const pass = await runPass({
      kind,
      settings,
      userOpenId: settings.userOpenId,
      accountId: settings.larkCliAccountId,
      runCommand,
      sinceIso,
      untilIso
    });
    passes.push(pass);
  }
  const seen = /* @__PURE__ */ new Set();
  const groupedByChat = {};
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
    groupedByChat[chatId].sort((a, b) => a.ts - b.ts);
  }
  const allFailed = passes.length > 0 && passes.every((p) => !p.ok);
  if (allFailed) {
    const error = passes.map((p) => p.ok ? "" : `${p.kind}: ${p.error}`).filter(Boolean).join(" / ");
    return {
      windowStart: sinceTs,
      windowEnd: untilTs,
      userOpenId: settings.userOpenId,
      accountId: settings.larkCliAccountId,
      passes,
      groupedByChat: {},
      ok: false,
      error
    };
  }
  return {
    windowStart: sinceTs,
    windowEnd: untilTs,
    userOpenId: settings.userOpenId,
    accountId: settings.larkCliAccountId,
    passes,
    groupedByChat
  };
}

// extensions/weekly-report/src/week-key.ts
var MS_PER_DAY = 864e5;
function asUtcDate(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
function isoWeekMonday(date) {
  const d = asUtcDate(date);
  const day = d.getUTCDay();
  const isoDayIndex = day === 0 ? 7 : day;
  d.setUTCDate(d.getUTCDate() - (isoDayIndex - 1));
  return d;
}
function isoWeekThursday(monday) {
  const t = new Date(monday);
  t.setUTCDate(t.getUTCDate() + 3);
  return t;
}
function firstThursdayOfYear(year) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  return isoWeekThursday(isoWeekMonday(jan4));
}
function isoWeekNumber(date, weekStartsOn = "monday") {
  if (weekStartsOn !== "monday") {
    throw new Error(`weekStartsOn="${weekStartsOn}" not supported in v1; use "monday".`);
  }
  const mon = isoWeekMonday(date);
  const thu = isoWeekThursday(mon);
  const isoYear = thu.getUTCFullYear();
  const firstThu = firstThursdayOfYear(isoYear);
  const firstMonday = isoWeekMonday(firstThu);
  const weeks = Math.round((mon.getTime() - firstMonday.getTime()) / (7 * MS_PER_DAY)) + 1;
  return { isoYear, isoWeek: weeks };
}
function weekKey(date, weekStartsOn = "monday") {
  const { isoYear, isoWeek } = isoWeekNumber(date, weekStartsOn);
  return `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
}
function weekTitle(date, weekStartsOn = "monday") {
  if (weekStartsOn !== "monday") {
    throw new Error(`weekStartsOn="${weekStartsOn}" not supported in v1; use "monday".`);
  }
  const mon = isoWeekMonday(date);
  const sun = new Date(mon);
  sun.setUTCDate(sun.getUTCDate() + 6);
  return `${formatDateCompact(mon)}-${formatDateCompact(sun)}`;
}
function formatDateCompact(date) {
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
}

// extensions/weekly-report/src/tools.ts
function buildResponse(details) {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details
  };
}
function readRequiredString(value, field) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}
function readOptionalString(value, field) {
  if (value === void 0 || value === null) {
    return void 0;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? void 0 : trimmed;
}
function parseDraftJson(raw) {
  if (typeof raw !== "string") {
    throw new Error("draftJson must be a JSON string");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`draftJson must be valid JSON: ${err.message}`);
  }
  renderReport(parsed);
  return parsed;
}
function requireWeeklyReportState(flow) {
  if (!isWeeklyReportFlowState(flow.stateJson)) {
    throw new Error("flow stateJson is not a valid WeeklyReportFlowState");
  }
  return flow.stateJson;
}
function createBeginWeeklyReportTool(deps) {
  const { settings } = deps;
  return {
    name: "begin_weekly_report",
    label: "Begin Weekly Report",
    description: "Start the weekly-report flow. Returns the plugin-owned first-person drafting contract (voice + content rules + the exact tool sequence) plus this week's weekKey/weekTitle hints. Call this FIRST when nudged to draft the weekly report, then follow the returned `contract` verbatim. This is the single source of drafting guidance \u2014 the cron entry only needs to tell you to call this tool.",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      const now = /* @__PURE__ */ new Date();
      let weekKeyHint;
      let weekTitleHint;
      try {
        weekKeyHint = weekKey(now, settings.weekStartsOn);
        weekTitleHint = weekTitle(now, settings.weekStartsOn);
      } catch {
        weekKeyHint = weekKey(now);
        weekTitleHint = weekTitle(now);
      }
      const contract = buildDraftingContract({ weekKeyHint, weekTitleHint });
      return buildResponse({ ok: true, weekKeyHint, weekTitleHint, contract });
    }
  };
}
function createSubmitWeeklyReportDraftTool(deps) {
  const { taskFlow, controllerId, settings, cardSender } = deps;
  return {
    name: "submit_weekly_report_draft",
    label: "Submit Weekly Report Draft",
    description: "Step 1 of the weekly-report flow. Submits a structured draft, creates a managed TaskFlow, AND SENDS THE CONFIRMATION CARD TO THE USER'S DM via lark-cli bot-mode. Returns `{ok, flowId, weekKey, weekTitle, cardDelivered, cardMessageId?, cardError?}`. **Do NOT call `feishu_ask_user_question` afterwards** \u2014 the card is already delivered by this tool. Your turn ends after this returns; the user will reply in DM with `confirm <flowId>` or `supplement <flowId>: <text>`. Use `supersedeFlowId` when revising after a 'supplement' answer.",
    parameters: Type.Object({
      weekKey: Type.String({ description: "ISO week key, e.g. 2026-W21" }),
      weekTitle: Type.String({
        description: "Human-readable week range, e.g. 2026.5.18-2026.5.24"
      }),
      draftJson: Type.String({
        description: "JSON string conforming to the renderer schema (week_title/current_week/next_week)."
      }),
      supersedeFlowId: Type.Optional(Type.String({})),
      revisionLabel: Type.Optional(Type.String({}))
    }),
    async execute(_id, params) {
      const weekKey2 = readRequiredString(params.weekKey, "weekKey");
      const weekTitle2 = readRequiredString(params.weekTitle, "weekTitle");
      const draft = parseDraftJson(params.draftJson);
      const supersedeFlowId = readOptionalString(params.supersedeFlowId, "supersedeFlowId");
      const revisionLabel = readOptionalString(params.revisionLabel, "revisionLabel");
      const targetDocToken = settings.targetDocToken;
      const recipientSessionKey = settings.recipientSessionKey;
      if (!targetDocToken) {
        throw new Error(
          "weekly-report.targetDocToken is not configured; cannot create a flow without a write target."
        );
      }
      if (!recipientSessionKey) {
        throw new Error(
          "weekly-report.recipientSessionKey is not configured; cannot deliver the card."
        );
      }
      let supersedeInfo = {};
      if (supersedeFlowId) {
        const existing = taskFlow.get(supersedeFlowId);
        if (existing) {
          taskFlow.fail({
            flowId: existing.flowId,
            expectedRevision: existing.revision,
            stateJson: {
              ...existing.stateJson ?? {},
              supersededAt: Date.now()
            }
          });
          supersedeInfo = { supersedeOf: existing.flowId };
        }
      } else {
        const existing = findActiveWeeklyReportFlow({
          flows: taskFlow.list(),
          controllerId,
          weekKey: weekKey2
        });
        if (existing) {
          return buildResponse({
            ok: true,
            action: "noop_already_pending",
            existingFlowId: existing.flowId,
            weekKey: weekKey2,
            note: "A weekly-report flow for this week already exists and is awaiting reply. No new card was sent. Tell the user that the prior card is still valid, or trigger again after that flow completes/expires."
          });
        }
      }
      const initialState = {
        weekKey: weekKey2,
        weekTitle: weekTitle2,
        draft,
        recipientSessionKey,
        targetDocToken,
        ...supersedeInfo
      };
      const flow = taskFlow.createManaged({
        controllerId,
        goal: `Generate weekly report for ${weekTitle2} and write it to the configured Feishu doc after user confirmation.`,
        currentStep: WEEKLY_REPORT_STEPS.awaitUserReply,
        stateJson: initialState
      });
      const previewMarkdown = buildDraftPreview(draft);
      const userOpenId = settings.userOpenId;
      let cardResult;
      if (cardSender && userOpenId) {
        const card = buildConfirmationCard({
          flowId: flow.flowId,
          weekKey: weekKey2,
          weekTitle: weekTitle2,
          draft,
          ...revisionLabel ? { revisionLabel } : {}
        });
        cardResult = await cardSender({ card, toOpenId: userOpenId });
      }
      const stateWithCard = cardResult && cardResult.ok ? { ...initialState, cardMessageId: cardResult.messageId, cardChatId: cardResult.chatId } : initialState;
      const setWaitResult = taskFlow.setWaiting({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: WEEKLY_REPORT_STEPS.awaitUserReply,
        stateJson: stateWithCard,
        waitJson: {
          kind: "weekly_report_card",
          weekKey: weekKey2,
          recipientSessionKey
        }
      });
      if (!cardSender || !userOpenId) {
        return buildResponse({
          ok: true,
          action: "waiting_card_delivery_unavailable",
          flowId: flow.flowId,
          revision: flow.revision,
          weekKey: weekKey2,
          weekTitle: weekTitle2,
          previewMarkdown,
          waitingMutation: setWaitResult,
          note: !cardSender ? "Plugin runtime missing lark-cli runCommand binding; install @larksuite/cli and configure it on the host, then redeploy. No card was sent." : "userOpenId not configured; cannot deliver card. Set plugins.entries.weekly-report.userOpenId (or recipientSessionKey ending in :direct:<open_id>) and retry."
        });
      }
      if (cardResult && !cardResult.ok) {
        return buildResponse({
          ok: false,
          action: "card_send_failed",
          flowId: flow.flowId,
          revision: flow.revision,
          weekKey: weekKey2,
          weekTitle: weekTitle2,
          previewMarkdown,
          error: cardResult.error,
          instruction: "Card delivery failed. The flow is now in waiting state but no card reached the user. Either retry submit_weekly_report_draft with supersedeFlowId, or escalate to the user via plain DM reply with the preview text."
        });
      }
      return buildResponse({
        ok: true,
        action: "card_delivered",
        flowId: flow.flowId,
        revision: flow.revision,
        weekKey: weekKey2,
        weekTitle: weekTitle2,
        cardMessageId: cardResult && cardResult.ok ? cardResult.messageId : void 0,
        cardChatId: cardResult && cardResult.ok ? cardResult.chatId : void 0,
        previewMarkdown,
        waitingMutation: setWaitResult,
        note: "Card sent to user's DM via lark-cli bot-mode. Your turn ends now. The user's text reply (e.g. `confirm <flowId>` or `supplement <flowId>: <text>`) will arrive as a new DM message; when it does, call `respond_to_weekly_report_card` with the parsed action."
      });
    }
  };
}
function createRespondToWeeklyReportCardTool(deps) {
  const { taskFlow, controllerId } = deps;
  return {
    name: "respond_to_weekly_report_card",
    label: "Respond to Weekly Report Card",
    description: "Call after the user submits the feishu_ask_user_question card created by submit_weekly_report_draft. Validates trust and either transitions to writing_doc (action='confirm', returns splice instructions) or to revising (action='supplement', returns the originalDraft + supplement for re-drafting).",
    parameters: Type.Object({
      flowId: Type.String({ description: "Flow id returned by submit_weekly_report_draft." }),
      weekKey: Type.String({ description: "Week key returned alongside the flowId." }),
      action: Type.String({
        description: "Either 'confirm' (user wants the current draft written as-is) or 'supplement' (user added text to be merged into a revised draft)."
      }),
      supplement: Type.Optional(
        Type.String({
          description: "Supplement text supplied by the user when action='supplement'."
        })
      ),
      sessionKey: Type.String({
        description: "Bound session key (your current ctx.sessionKey) for trust check."
      })
    }),
    async execute(_id, params) {
      const flowId = readRequiredString(params.flowId, "flowId");
      const weekKey2 = readRequiredString(params.weekKey, "weekKey");
      const actionRaw = readRequiredString(params.action, "action");
      const sessionKey = readRequiredString(params.sessionKey, "sessionKey");
      if (!WEEKLY_REPORT_CARD_ACTIONS.includes(actionRaw)) {
        return buildResponse({
          ok: false,
          action: "invalid",
          reason: "unknown_action",
          userMessage: `Unknown action "${actionRaw}". Expected one of: ${WEEKLY_REPORT_CARD_ACTIONS.join(", ")}.`
        });
      }
      const action = actionRaw;
      const supplementText = action === "supplement" ? readOptionalString(params.supplement, "supplement") : void 0;
      if (action === "supplement" && !supplementText) {
        return buildResponse({
          ok: false,
          action: "invalid",
          reason: "supplement_required",
          userMessage: "User picked supplement but did not provide text. Ask them again with feishu_ask_user_question."
        });
      }
      const args = { flowId, weekKey: weekKey2, action, supplement: supplementText };
      const trustResult = validateTrust({
        taskFlow,
        controllerId,
        bindings: { sessionKey, weekKey: args.weekKey, flowId: args.flowId }
      });
      if (!trustResult.ok) {
        return buildResponse({
          ok: false,
          action: "invalid",
          reason: trustResult.reason,
          userMessage: "This weekly-report card is no longer valid."
        });
      }
      const flow = trustResult.flow;
      const state = requireWeeklyReportState(flow);
      if (args.action === "confirm") {
        const writingState = {
          ...state,
          writeStartedAt: Date.now()
        };
        const transition2 = taskFlow.resume({
          flowId: flow.flowId,
          expectedRevision: flow.revision,
          status: "running",
          currentStep: WEEKLY_REPORT_STEPS.writingDoc,
          stateJson: writingState
        });
        if (!transition2.applied) {
          return buildResponse({
            ok: false,
            action: "invalid",
            reason: `transition_failed:${transition2.code}`,
            userMessage: "Could not transition the weekly-report flow; please try again."
          });
        }
        return buildResponse({
          ok: true,
          action: "ready_to_write",
          flowId: flow.flowId,
          revision: transition2.flow.revision,
          weekKey: state.weekKey,
          weekTitle: state.weekTitle,
          note: "The plugin writes the doc itself when the user taps \u300C\u76F4\u63A5\u5199\u5165\u300D on the confirmation card \u2014 the interactive handler inserts this week's section at the TOP of the doc non-destructively (prior weeks, images, comments preserved) and finalizes the flow. Do NOT call any feishu_fetch_doc / feishu_update_doc tools. If the user confirmed by plain text instead of the card button, ask them to tap \u300C\u76F4\u63A5\u5199\u5165\u300D on the card so the write is triggered."
        });
      }
      const revisingState = {
        ...state,
        supplementSubmittedAt: Date.now()
      };
      const transition = taskFlow.resume({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        status: "running",
        currentStep: WEEKLY_REPORT_STEPS.revising,
        stateJson: revisingState
      });
      if (!transition.applied) {
        return buildResponse({
          ok: false,
          action: "invalid",
          reason: `transition_failed:${transition.code}`,
          userMessage: "Could not transition the weekly-report flow; please try again."
        });
      }
      return buildResponse({
        ok: true,
        action: "re_draft",
        flowId: flow.flowId,
        revision: transition.flow.revision,
        weekKey: state.weekKey,
        weekTitle: state.weekTitle,
        originalDraft: state.draft,
        supplement: supplementText,
        instructions: [
          "Merge the supplement into the original draft (likely as a new current_week item or additional bullet on an existing item). Use your judgment about grouping.",
          `Call \`submit_weekly_report_draft\` again with the revised draft, \`supersedeFlowId: "${flow.flowId}"\`, and a \`revisionLabel\` like 'Revision 2' to make the new card distinguishable.`,
          "The follow-up will return new instructions to call `feishu_ask_user_question` again with the revised preview."
        ].join("\n")
      });
    }
  };
}
function validateCardActionTrust(params) {
  return validateTrust(params);
}
function validateTrust(params) {
  const { taskFlow, controllerId, bindings } = params;
  const flow = taskFlow.get(bindings.flowId);
  if (!flow) {
    return { ok: false, reason: "flow_not_found" };
  }
  if (flow.controllerId !== controllerId) {
    return { ok: false, reason: "wrong_controller" };
  }
  if (taskFlow.sessionKey !== bindings.sessionKey) {
    return { ok: false, reason: "session_mismatch" };
  }
  if (flow.status !== "waiting") {
    return { ok: false, reason: `not_waiting:${flow.status}` };
  }
  if (!isWeeklyReportFlowState(flow.stateJson)) {
    return { ok: false, reason: "state_invalid" };
  }
  if (flow.stateJson.weekKey !== bindings.weekKey) {
    return { ok: false, reason: "week_mismatch" };
  }
  return { ok: true, flow };
}
function createFinalizeWeeklyReportTool(deps) {
  const { taskFlow, controllerId } = deps;
  return {
    name: "finalize_weekly_report",
    label: "Finalize Weekly Report",
    description: "Mark the weekly-report flow as completed (success=true) or failed (success=false, error). Call after the `feishu_update_doc` step.",
    parameters: Type.Object({
      flowId: Type.String({}),
      success: Type.Boolean({}),
      error: Type.Optional(Type.String({}))
    }),
    async execute(_id, params) {
      const flowId = readRequiredString(params.flowId, "flowId");
      const success = params.success === true;
      const errorText = readOptionalString(params.error, "error");
      const flow = taskFlow.get(flowId);
      if (!flow) {
        throw new Error(`flow not found: ${flowId}`);
      }
      if (flow.controllerId !== controllerId) {
        throw new Error(`flow ${flowId} is not a weekly-report flow`);
      }
      const state = requireWeeklyReportState(flow);
      if (success) {
        const finalState = {
          ...state,
          writtenAt: Date.now()
        };
        const mutation2 = taskFlow.finish({
          flowId: flow.flowId,
          expectedRevision: flow.revision,
          stateJson: finalState
        });
        return buildResponse({
          ok: true,
          action: "finished",
          flowId,
          mutation: mutation2
        });
      }
      const failureMessage = errorText ?? "doc-write-failed";
      const failureState = {
        ...state,
        lastError: failureMessage
      };
      const mutation = taskFlow.fail({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson: failureState
      });
      return buildResponse({
        ok: false,
        action: "failed",
        flowId,
        lastError: failureMessage,
        mutation
      });
    }
  };
}
function createFetchGitActivityTool(deps) {
  const { settings, runCommand, resolveStateDir } = deps;
  return {
    name: "fetch_git_activity",
    label: "Fetch Weekly Git Activity",
    description: "Return commits across configured git remotes for a time window, filtered by the configured author. Use this alongside `runtime.subagent.getSessionMessages` when drafting the weekly report so `completed` bullets cite real commits. Returns an empty result if no gitRemotes are configured.",
    parameters: Type.Object({
      sinceTs: Type.Optional(
        Type.Number({
          description: "Unix ms. Default: Monday 00:00 UTC of the current ISO week."
        })
      ),
      untilTs: Type.Optional(
        Type.Number({
          description: "Unix ms. Default: now."
        })
      ),
      repoFilter: Type.Optional(
        Type.String({
          description: "Comma-separated list of configured repo `name`s to include. Default: all."
        })
      )
    }),
    async execute(_id, params) {
      const sinceTs = typeof params.sinceTs === "number" && Number.isFinite(params.sinceTs) ? params.sinceTs : void 0;
      const untilTs = typeof params.untilTs === "number" && Number.isFinite(params.untilTs) ? params.untilTs : void 0;
      const repoFilter = typeof params.repoFilter === "string" && params.repoFilter.trim().length > 0 ? params.repoFilter.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0) : void 0;
      try {
        const result = await runGitActivity({
          settings,
          runCommand,
          resolveStateDir,
          ...sinceTs !== void 0 ? { sinceTs } : {},
          ...untilTs !== void 0 ? { untilTs } : {},
          ...repoFilter ? { repoFilter } : {}
        });
        const failures = result.repos.filter((repo) => !repo.ok);
        return buildResponse({
          ok: true,
          windowStart: result.windowStart,
          windowEnd: result.windowEnd,
          repos: result.repos,
          partial: failures.length > 0,
          partialNote: failures.length > 0 ? "One or more repos returned ok=false. Mention them in the draft rather than hiding the gap." : void 0
        });
      } catch (err) {
        return buildResponse({
          ok: false,
          action: "git_activity_failed",
          reason: err.message,
          instruction: "Continue drafting using chat history only. Mention in the draft that git activity wasn't available because: " + err.message
        });
      }
    }
  };
}
var KNOWN_REASONS = ["author", "mention"];
function createFetchRecentGroupMessagesTool(deps) {
  const { settings, runCommand } = deps;
  return {
    name: "fetch_recent_group_messages",
    label: "Fetch Recent Group Messages",
    description: "v4 fact source. Searches Feishu group messages via lark-cli for messages you authored or were mentioned in during the configured window. Returns {windowStart, windowEnd, userOpenId, accountId, passes: [{kind, ok, messages|error, truncated?}], groupedByChat: {chatId: messages[]}}. Call this alongside `getSessionMessages` (DM) and `fetch_git_activity` (commits) during drafting. If any `passes[].ok: false`, any `passes[].truncated: true`, or top-level `ok: false` is set, mention the gap in the draft rather than hiding it. Requires lark-cli installed on the host and `larkCliAccountId` configured.",
    parameters: Type.Object({
      sinceTs: Type.Optional(
        Type.Number({
          description: "Unix ms. Default: Monday 00:00 UTC of the current ISO week (or Sunday if weekStartsOn=sunday)."
        })
      ),
      untilTs: Type.Optional(Type.Number({ description: "Unix ms. Default: now." })),
      includeReasons: Type.Optional(
        Type.String({
          description: "Comma-separated subset of `author,mention`. Default: both."
        })
      )
    }),
    async execute(_id, params) {
      const sinceTs = typeof params.sinceTs === "number" && Number.isFinite(params.sinceTs) ? params.sinceTs : void 0;
      const untilTs = typeof params.untilTs === "number" && Number.isFinite(params.untilTs) ? params.untilTs : void 0;
      let includeReasons;
      if (typeof params.includeReasons === "string" && params.includeReasons.trim().length > 0) {
        const requested = params.includeReasons.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
        const invalid = requested.filter(
          (entry) => !KNOWN_REASONS.includes(entry)
        );
        if (invalid.length > 0) {
          return buildResponse({
            ok: false,
            action: "invalid",
            reason: "unknown_include_reasons",
            invalid,
            userMessage: `Unknown includeReasons: ${invalid.join(", ")}. Expected subset of ${KNOWN_REASONS.join(", ")}.`
          });
        }
        includeReasons = requested;
      }
      const result = await runGroupActivity({
        settings,
        runCommand,
        ...sinceTs !== void 0 ? { sinceTs } : {},
        ...untilTs !== void 0 ? { untilTs } : {},
        ...includeReasons ? { includeReasons } : {}
      });
      const passFailures = result.passes.filter((p) => !p.ok);
      const truncatedPasses = result.passes.filter((p) => p.ok && p.truncated);
      return buildResponse({
        ok: result.ok !== false,
        ...result.ok === false && result.error ? { error: result.error } : {},
        windowStart: result.windowStart,
        windowEnd: result.windowEnd,
        userOpenId: result.userOpenId,
        accountId: result.accountId,
        passes: result.passes,
        groupedByChat: result.groupedByChat,
        partial: passFailures.length > 0 || truncatedPasses.length > 0,
        partialNote: passFailures.length > 0 || truncatedPasses.length > 0 ? "One or more passes returned ok=false or truncated=true. Mention the gap in the draft rather than hiding it." : void 0
      });
    }
  };
}

// extensions/weekly-report/src/interactive-handler.ts
function safeParseEvent(raw) {
  let event = null;
  if (typeof raw === "string") {
    try {
      event = JSON.parse(raw);
    } catch {
      return {};
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    event = raw;
  }
  if (!event) {
    return {};
  }
  const action = event.action;
  const value = action && typeof action.value === "object" && action.value !== null && !Array.isArray(action.value) ? action.value : void 0;
  const formCandidates = [
    action?.form_value,
    action?.input_value,
    event.form_value,
    event.input_value
  ];
  let formValue;
  for (const cand of formCandidates) {
    if (cand && typeof cand === "object" && !Array.isArray(cand)) {
      formValue = cand;
      break;
    }
  }
  return value ? { value, ...formValue ? { formValue } : {} } : {};
}
function readSupplementText(formValue) {
  if (!formValue) {
    return void 0;
  }
  const raw = formValue[SUPPLEMENT_INPUT_NAME];
  if (typeof raw !== "string") {
    return void 0;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? void 0 : trimmed;
}
function createWeeklyReportInteractiveHandler(deps) {
  const { taskFlow, controllerId, settings, runCommand, subagentRun } = deps;
  const { recipientSessionKey } = settings;
  return async function handler(ctx) {
    const { value, formValue } = safeParseEvent(ctx.rawEvent);
    if (!value) {
      return { handled: true, toast: { type: "error", content: "\u5361\u7247\u4E8B\u4EF6\u65E0\u6CD5\u89E3\u6790" } };
    }
    const actionVerb = parseEnvelopeAction(value.action);
    const flowId = typeof value.flowId === "string" ? value.flowId : void 0;
    const weekKey2 = typeof value.weekKey === "string" ? value.weekKey : void 0;
    if (!actionVerb || !flowId || !weekKey2) {
      return { handled: true, toast: { type: "error", content: "\u5361\u7247\u5143\u6570\u636E\u4E0D\u5B8C\u6574" } };
    }
    if (!recipientSessionKey) {
      return {
        handled: true,
        toast: { type: "error", content: "\u63D2\u4EF6\u672A\u914D\u7F6E recipientSessionKey\uFF0C\u65E0\u6CD5\u9A8C\u8BC1 flow\u3002" }
      };
    }
    const trustResult = validateCardActionTrust({
      taskFlow,
      controllerId,
      bindings: { flowId, weekKey: weekKey2, sessionKey: recipientSessionKey }
    });
    if (!trustResult.ok) {
      const reasonText = trustResult.reason.replace(/_/g, " ");
      return { handled: true, toast: { type: "warning", content: `\u5361\u7247\u5DF2\u5931\u6548\uFF08${reasonText}\uFF09` } };
    }
    const flow = trustResult.flow;
    if (!isWeeklyReportFlowState(flow.stateJson)) {
      return { handled: true, toast: { type: "error", content: "flow \u72B6\u6001\u635F\u574F\uFF0C\u65E0\u6CD5\u8BFB\u53D6\u8349\u7A3F\u3002" } };
    }
    const state = flow.stateJson;
    if (actionVerb === "supplement") {
      const supplementText = readSupplementText(formValue);
      if (!supplementText) {
        return {
          handled: true,
          toast: { type: "warning", content: "\u8865\u5145\u5185\u5BB9\u4E3A\u7A7A\u3002\u8BF7\u5728\u8F93\u5165\u6846\u586B\u5199\u540E\u518D\u70B9\u51FB\u8865\u5145\u3002" }
        };
      }
      const revisingTransition = taskFlow.resume({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        status: "running",
        currentStep: WEEKLY_REPORT_STEPS.revising,
        stateJson: { ...state, supplementSubmittedAt: Date.now() }
      });
      if (!revisingTransition.applied) {
        return {
          handled: true,
          toast: { type: "error", content: "\u65E0\u6CD5\u5C06 flow \u8F6C\u5165 revising \u72B6\u6001\u3002" }
        };
      }
      await ctx.respond.reply({ text: "\u{1F4DD} \u5DF2\u6536\u5230\u8865\u5145\u5185\u5BB9\uFF0C\u542F\u52A8\u9694\u79BB\u5B50\u4F1A\u8BDD\u91CD\u65B0\u6574\u7406\u8349\u7A3F\u2026" }).catch(() => {
      });
      if (!subagentRun) {
        return {
          handled: true,
          toast: {
            type: "error",
            content: "runtime.subagent \u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u89E6\u53D1 re-draft\u3002\u8BF7\u76F4\u63A5\u5728 DM \u56DE\u590D\u8865\u5145\u5185\u5BB9\u3002"
          }
        };
      }
      const messageText = [
        `\u627F\u592A\u90CE\u5BF9\u672C\u5468\u5468\u62A5\uFF08flow=${flow.flowId}\uFF0CweekKey=${weekKey2}\uFF09\u7684\u8865\u5145\u8F93\u5165\uFF1A`,
        `"""`,
        supplementText,
        `"""`,
        ``,
        `**\u8FD9\u6BB5\u6587\u5B57\u662F\u7814\u7A76\u63D0\u793A\uFF0C\u4E0D\u662F\u8981\u76F4\u63A5\u6284\u8FDB\u8349\u7A3F\u7684\u5185\u5BB9\u3002\u8BF7\u6309\u4E0B\u9762\u8FD9\u4E2A\u6D41\u7A0B\u5904\u7406\uFF1A**`,
        ``,
        `**\u91CD\u8981\u2014\u2014\u4F60\u7684\u89D2\u8272\u548C\u552F\u4E00\u51FA\u53E3**\uFF1A\u4F60\u73B0\u5728\u5728\u4E00\u4E2A\u9694\u79BB\u5B50\u4F1A\u8BDD\u91CC\u300C\u91CD\u65B0\u8D77\u8349\u4FEE\u8BA2\u7248\u300D\u3002\u5361\u7247\u70B9\u51FB\u5DF2\u7ECF\u7531\u63D2\u4EF6\u5904\u7406\u5B8C\u6BD5\uFF0Cflow=${flow.flowId} \u5DF2\u8FDB\u5165 revising \u72B6\u6001\u3002\u672C\u56DE\u5408**\u552F\u4E00**\u7684\u63D0\u4EA4\u52A8\u4F5C\u662F\u8C03\u7528 \`submit_weekly_report_draft\`\uFF08\u5E26 \`supersedeFlowId: "${flow.flowId}"\`\uFF09\u3002**\u7EDD\u5BF9\u7981\u6B62\u8C03\u7528 \`respond_to_weekly_report_card\`**\u2014\u2014\u90A3\u662F\u5904\u7406\u5361\u7247\u70B9\u51FB\u7684\u5DE5\u5177\uFF0C\u4E0D\u662F\u7ED9\u4F60\u91CD\u65B0\u8D77\u8349\u7528\u7684\uFF1B\u4ECE\u8FD9\u4E2A\u5B50\u4F1A\u8BDD\u8C03\u7528\u5B83\u4F1A\u56E0 session \u4E0D\u5339\u914D\u88AB\u62D2\u7EDD\uFF08\u8FD4\u56DE "card no longer valid"\uFF09\uFF0C\u4FEE\u8BA2\u76F4\u63A5\u5931\u8D25\u3002\u4E5F\u4E0D\u8981\u8C03\u7528 \`feishu_ask_user_question\`\u3002\u4E0D\u8981\u4F20 \`sessionKey: "current"\` \u4E4B\u7C7B\u7684\u5360\u4F4D\u503C\u3002`,
        ``,
        `**1) \u89E3\u6790\u63D0\u793A\u610F\u56FE**\uFF1A\u628A\u4E0A\u9762\u8FD9\u6BB5\u6587\u5B57\u5206\u7C7B\u6210\u4E0B\u9762\u4E4B\u4E00\uFF08\u6216\u51E0\u79CD\u53E0\u52A0\uFF09\u3002`,
        `   a) **\u5220\u9664/\u91CD\u6392\u6307\u4EE4**\uFF08"\u5220\u9664\u7B2C N \u6761" / "\u7B2C N \u6761\u6539\u4E3A X" / "\u628A A \u548C B \u5408\u5E76" / "\u987A\u5E8F\u6362\u6210 \u2026"\uFF09\u2192 \u6309\u6307\u793A\u76F4\u63A5\u5BF9 current_week \u6570\u7EC4\u505A\u7ED3\u6784\u8C03\u6574\u3002`,
        `   b) **\u957F\u671F\u4E8B\u5B9E / \u89D2\u8272\u6846\u5B9A**\uFF08"\u6211\u662F X \u9879\u76EE\u7684 DRI"\u3001"\u6211\u4EEC\u505A AI agent"\u3001"\u56E2\u961F\u5728 jackery \u6295\u653E\u65B9\u5411"\uFF09\u2192 \u4F5C\u4E3A\u641C\u7D22/\u8FC7\u6EE4\u4E0A\u4E0B\u6587\u4F7F\u7528\uFF0C\u4E0D\u8981\u5199\u8FDB completed \u6216 intent \u91CC\u3002`,
        `   c) **\u65B0\u589E\u4E8B\u5B9E\u6307\u9488**\uFF08"\u52A0\u4E0A\uFF1A\u672C\u5468\u548C\u6B22\u54E5\u5BF9\u9F50\u4E86 demo \u8282\u594F"\u3001"\u8FD8\u8981\u8865\u4E00\u6761 growx-runtime \u7684\u8FDB\u5C55"\uFF09\u2192 \u4F5C\u4E3A\u67E5\u627E\u4E8B\u5B9E\u7684 hint\u3002`,
        ``,
        `**2) \u91CD\u65B0\u6316\u6398\u4E8B\u5B9E**\uFF08\u4E0D\u8981\u51ED\u8FD9\u6BB5\u6587\u5B57\u672C\u8EAB\u5199 bullet\uFF09\uFF1A\u57FA\u4E8E\u4E0A\u9762\u89E3\u6790\u51FA\u6765\u7684\u63D0\u793A\uFF0C\u5728\u540C\u4E00\u56DE\u5408\u5185\u91CD\u65B0\u5E76\u884C\u8C03\u7528\uFF1A`,
        `   - runtime.subagent.getSessionMessages \u2014\u2014 \u672C DM \u5BF9\u8BDD\u8FC7\u53BB 7 \u5929\uFF0C\u91CD\u70B9\u67E5\u4E0E\u63D0\u793A\u76F8\u5173\u7684\u8BA8\u8BBA\u3002`,
        `   - fetch_git_activity \u2014\u2014 \u672C\u5468\u914D\u7F6E\u4ED3\u5E93\u4E2D\u4F60\u7684\u63D0\u4EA4\uFF0C\u91CD\u70B9\u627E\u63D0\u793A\u76F8\u5173\u7684 commit\u3002`,
        `   - fetch_recent_group_messages \u2014\u2014 \u672C\u5468\u98DE\u4E66\u7FA4\u6D88\u606F\uFF0C\u91CD\u70B9\u63D0\u53D6\u63D0\u793A\u63D0\u5230\u7684\u4EBA/\u9879\u76EE/\u8BDD\u9898\u3002`,
        ``,
        `**3) \u5408\u5E76\u800C\u4E0D\u662F\u66FF\u6362**\uFF1A\u4EE5\u539F\u8349\u7A3F\u4F5C\u4E3A\u57FA\u7EBF\uFF08\u5DF2\u7ECF\u5728 flow stateJson \u91CC\uFF09\uFF0C\u6309\u4E0B\u9762\u89C4\u5219\u66F4\u65B0\uFF1A`,
        `   - \u5220\u9664/\u91CD\u6392\u6307\u4EE4\uFF1A\u6309\u6307\u4EE4\u91CD\u6392 current_week\uFF1B\u5982\u679C\u67D0\u9879\u88AB\u5220\uFF0C\u628A\u5B83\u7684 next_week \u4E5F\u4E00\u5E76\u53BB\u6389\u3002`,
        `   - \u65B0\u589E\u4E8B\u5B9E\u6307\u9488\uFF1A\u6839\u636E hint \u91CD\u65B0\u6316\u6398\u5230\u7684\u771F\u5B9E\u7D20\u6750\uFF0C\u8865 completed bullet\uFF0C\u53EF\u80FD\u65B0\u589E current_week \u9879\u76EE\u3002**\u4E0D\u8981\u628A\u627F\u592A\u90CE\u7684\u8BDD\u672C\u8EAB\u5F53\u6210 bullet \u5185\u5BB9\u3002**`,
        `   - \u957F\u671F\u4E8B\u5B9E / \u89D2\u8272\u6846\u5B9A\uFF1A\u5438\u6536\u4E3A\u672C\u56DE\u5408\u7684\u67E5\u8BE2/\u8FC7\u6EE4\u4E0A\u4E0B\u6587\uFF0C\u8BA9\u4F60\u66F4\u7CBE\u51C6\u627E\u5230\u5BF9\u5E94\u9879\u76EE\u7684 commits/\u7FA4\u804A\uFF1B\u4E0D\u8981\u628A\u5B83\u672C\u8EAB\u5199\u8FDB intent / objective / completed\u3002`,
        `   - \u5176\u4ED6\u539F\u8349\u7A3F\u91CC\u5DF2\u7ECF\u6210\u7ACB\u7684 bullet \u5168\u90E8\u4FDD\u7559\uFF0C\u9664\u975E\u548C\u8865\u5145\u76F4\u63A5\u51B2\u7A81\u3002`,
        ``,
        // The supplement re-draft runs in a fresh isolated sub-session that does NOT carry the
        // original cron turn's context, so the begin_weekly_report contract is NOT visible here.
        // Inline the shared rules verbatim so this round enforces the exact same voice/content rules.
        `**4) \u8349\u7A3F\u786C\u89C4\u5219**\uFF08\u5468\u62A5\u7684\u7EDF\u4E00\u53E3\u5F84\uFF0Crevision \u4E2D\u540C\u6837\u4E0D\u5141\u8BB8\u653E\u677E\uFF09\uFF1A`,
        DRAFTING_HARD_RULES,
        ``,
        `**5) \u552F\u4E00\u63D0\u4EA4\u65B9\u5F0F\uFF1A\u8C03\u7528 submit_weekly_report_draft({ weekKey: "${weekKey2}", weekTitle, draftJson, supersedeFlowId: "${flow.flowId}", revisionLabel: "revision 2" })** \u63D0\u4EA4\u4FEE\u8BA2\u7248\u3002\u8BE5\u5DE5\u5177\u4F1A\u81EA\u52A8\u6295\u9012\u65B0\u5361\u7247\uFF1B\u4F60\u8FD9\u4E00\u56DE\u5408\u5230\u6B64\u7ED3\u675F\u3002\u8FD9\u662F\u672C\u56DE\u5408\u552F\u4E00\u5141\u8BB8\u7684\u5361\u7247\u76F8\u5173\u5DE5\u5177\u3002`,
        ``,
        `**\u7981\u6B62**\uFF1A\u8C03\u7528 \`respond_to_weekly_report_card\`\uFF08\u4E0A\u4E00\u6B21\u4FEE\u8BA2\u5C31\u662F\u56E0\u6B64\u5931\u8D25\u2014\u2014\u5B83\u4F1A\u88AB session_mismatch \u62D2\u7EDD\uFF1B\u91CD\u65B0\u8D77\u8349\u53EA\u7528 submit_weekly_report_draft\uFF09\uFF1B\u8C03\u7528 \`feishu_ask_user_question\`\uFF1B\u628A\u627F\u592A\u90CE\u7684\u539F\u8BDD\u5F53 completed bullet\uFF1B\u53EA\u6539 intent/objective \u4E0D\u6539\u4E8B\u5B9E\uFF1B\u4E0D\u91CD\u65B0\u8C03\u7528\u4E09\u4E2A\u4E8B\u5B9E\u6E90\uFF1B\u5728 bullet \u4E2D\u4FDD\u7559 chat_id/message_id\uFF1B\u628A"\u804C\u8D23\u8FB9\u754C\u6F84\u6E05"\u4E4B\u7C7B\u5143\u5DE5\u4F5C\u5199\u6210\u9879\u76EE\u3002`
      ].join("\n");
      const supplementAgentId = /^agent:([^:]+):/u.exec(recipientSessionKey)?.[1] ?? "silver-chariot";
      const isolatedSessionKey = `agent:${supplementAgentId}:${WEEKLY_REPORT_SUPPLEMENT_SESSION_SEGMENT}:${flow.flowId}:${Date.now()}`;
      try {
        await subagentRun({
          sessionKey: isolatedSessionKey,
          message: messageText,
          deliver: false
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          handled: true,
          toast: { type: "error", content: `\u8865\u5145\u56DE\u4F20\u5931\u8D25: ${msg.slice(0, 100)}` }
        };
      }
      return { handled: true, toast: { type: "success", content: "Supplement queued" } };
    }
    const writingTransition = taskFlow.resume({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      status: "running",
      currentStep: WEEKLY_REPORT_STEPS.writingDoc,
      stateJson: { ...state, writeStartedAt: Date.now() }
    });
    if (!writingTransition.applied) {
      return {
        handled: true,
        toast: { type: "error", content: "\u65E0\u6CD5\u5C06 flow \u8F6C\u5165 writing_doc \u72B6\u6001\u3002" }
      };
    }
    const writingRevision = writingTransition.flow.revision;
    const docToken = state.targetDocToken;
    if (!docToken) {
      taskFlow.fail({
        flowId: flow.flowId,
        expectedRevision: writingRevision,
        stateJson: { ...state, lastError: "targetDocToken missing" }
      });
      return {
        handled: true,
        toast: { type: "error", content: "\u672A\u914D\u7F6E targetDocToken\uFF0C\u65E0\u6CD5\u5199\u5165\u6587\u6863\u3002" }
      };
    }
    void (async () => {
      await ctx.respond.reply({ text: "\u2705 \u5DF2\u6536\u5230\u786E\u8BA4\uFF0C\u6B63\u5728\u5199\u5165\u5468\u62A5\u6587\u6863\u2026" }).catch(() => {
      });
      let renderedSection;
      try {
        renderedSection = renderReport(state.draft).trimEnd();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        taskFlow.fail({
          flowId: flow.flowId,
          expectedRevision: writingRevision,
          stateJson: { ...state, lastError: `render failed: ${msg}` }
        });
        await ctx.respond.reply({ text: `\u6E32\u67D3\u8349\u7A3F\u5931\u8D25: ${msg.slice(0, 100)}` }).catch(() => {
        });
        return;
      }
      const writeRes = await writeWeeklySection({
        runCommand,
        binPath: settings.larkOfficialCliBinPath,
        asIdentity: settings.docIdentity,
        docToken,
        weekKey: weekKey2,
        weekTitle: state.weekTitle,
        sectionMarkdown: renderedSection,
        timeoutMs: settings.larkOfficialCliTimeoutMs
      });
      if (!writeRes.ok) {
        taskFlow.fail({
          flowId: flow.flowId,
          expectedRevision: writingRevision,
          stateJson: { ...state, lastError: writeRes.error }
        });
        await ctx.respond.reply({ text: `\u5199\u5165\u5468\u62A5\u6587\u6863\u5931\u8D25: ${writeRes.error.slice(0, 100)}` }).catch(() => {
        });
        return;
      }
      taskFlow.finish({
        flowId: flow.flowId,
        expectedRevision: writingRevision,
        stateJson: {
          ...state,
          writeStartedAt: state.writeStartedAt ?? Date.now(),
          writtenAt: Date.now()
        }
      });
      const writtenText = writeRes.titleNote ? `\u2705 \u5468\u62A5\u5DF2\u5199\u5165\u6587\u6863\uFF08${state.weekTitle}\uFF09\u3002
\u26A0\uFE0F ${writeRes.titleNote}` : `\u2705 \u5468\u62A5\u5DF2\u5199\u5165\u6587\u6863\uFF08${state.weekTitle}\uFF09\u3002`;
      await ctx.respond.reply({ text: writtenText }).catch(() => {
      });
    })();
    return { handled: true, toast: { type: "info", content: "\u5DF2\u6536\u5230\uFF0C\u6B63\u5728\u5199\u5165\u6587\u6863\u2026" } };
  };
}

// extensions/weekly-report/src/settings.ts
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
var DEFAULT_REMINDER_DAYS = 3;
var DEFAULT_FAIL_DAYS = 7;
var DEFAULT_WEEK_STARTS_ON = "monday";
var ONE_HOUR_MS = 60 * 60 * 1e3;
var DEFAULT_GIT_FETCH_TIMEOUT_MS = 3e4;
var DEFAULT_GIT_MAX_COMMITS_PER_REPO = 200;
var DEFAULT_GIT_HOST_ALLOWLIST = ["gitlab.com", "github.com"];
var DEFAULT_GIT_MAX_PARALLEL_OPS = 3;
var DEFAULT_GIT_MAX_REPO_COUNT = 10;
var DEFAULT_GIT_OVERALL_TIMEOUT_MS = 12e4;
var DEFAULT_GROUP_MAX_MESSAGES_PER_PASS = 200;
var DEFAULT_LARK_CLI_BIN_PATH = "larkcli";
var DEFAULT_LARK_CLI_TIMEOUT_MS = 3e4;
var DEFAULT_LARK_CLI_MAX_PAGES = 4;
var DEFAULT_LARK_OFFICIAL_CLI_BIN_PATH = "lark-cli";
var DEFAULT_LARK_OFFICIAL_CLI_TIMEOUT_MS = 3e4;
var DEFAULT_DOC_IDENTITY = "user";
var GIT_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
var GIT_HOST_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/u;
var GIT_SSH_URL_REGEX = /^[A-Za-z0-9_-]+@([A-Za-z0-9._-]+):([\w./-]+)\.git$/u;
var FORBIDDEN_URL_SUBSTRINGS = ["..", "--", "`", "$", " ", "	", "\n", "\r"];
var FEISHU_OPEN_ID_REGEX = /^ou_[A-Za-z0-9_-]{8,}$/u;
var FEISHU_DIRECT_SESSION_KEY_REGEX = /:feishu:direct:(ou_[A-Za-z0-9_-]+)$/u;
var weeklyReportConfigSchema = buildJsonPluginConfigSchema({
  type: "object",
  additionalProperties: false,
  properties: {
    targetDocToken: { type: "string" },
    recipientSessionKey: { type: "string" },
    reminderAfterDays: { type: "integer", minimum: 1 },
    failAfterDays: { type: "integer", minimum: 1 },
    weekStartsOn: { type: "string", enum: ["monday", "sunday"] },
    sweeperIntervalMs: { type: "integer", minimum: 6e4 },
    gitRemotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "sshUrl"],
        properties: {
          name: { type: "string" },
          sshUrl: { type: "string" }
        }
      }
    },
    gitAuthor: { type: "string" },
    gitWorkspaceDir: { type: "string" },
    gitFetchTimeoutMs: { type: "integer", minimum: 1e3 },
    gitMaxCommitsPerRepo: { type: "integer", minimum: 1 },
    gitHostAllowlist: { type: "array", items: { type: "string" } },
    gitMaxParallelOps: { type: "integer", minimum: 1 },
    gitMaxRepoCount: { type: "integer", minimum: 1 },
    gitOverallTimeoutMs: { type: "integer", minimum: 5e3 },
    userOpenId: { type: "string" },
    botOpenId: { type: "string" },
    groupDenylist: { type: "array", items: { type: "string" } },
    groupMaxMessagesPerPass: { type: "integer", minimum: 1 },
    larkCliBinPath: { type: "string" },
    larkCliAccountId: { type: "string" },
    larkCliTimeoutMs: { type: "integer", minimum: 1e3 },
    larkCliMaxPages: { type: "integer", minimum: 1 },
    larkOfficialCliBinPath: { type: "string" },
    larkOfficialCliTimeoutMs: { type: "integer", minimum: 1e3 },
    docIdentity: { type: "string", enum: ["user", "bot"] }
  }
});
function readOptionalString2(value, field) {
  if (value === void 0 || value === null) {
    return void 0;
  }
  if (typeof value !== "string") {
    throw new Error(`weekly-report.${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? void 0 : trimmed;
}
function readPositiveInteger(value, field, fallback) {
  if (value === void 0 || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`weekly-report.${field} must be a positive integer`);
  }
  return value;
}
function readBoundedInteger(value, field, fallback, min) {
  if (value === void 0 || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`weekly-report.${field} must be an integer >= ${min}`);
  }
  return value;
}
function readWeekStartsOn(value) {
  if (value === void 0 || value === null) {
    return DEFAULT_WEEK_STARTS_ON;
  }
  if (value === "monday" || value === "sunday") {
    return value;
  }
  throw new Error(`weekly-report.weekStartsOn must be "monday" or "sunday"`);
}
function readHostAllowlist(value) {
  if (value === void 0 || value === null) {
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
function readStringArray(value, field) {
  if (value === void 0 || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`weekly-report.${field} must be a string[]`);
  }
  return value.map((entry, idx) => {
    if (typeof entry !== "string") {
      throw new Error(`weekly-report.${field}[${idx}] must be a string`);
    }
    return entry.trim();
  }).filter((entry) => entry.length > 0);
}
function validateGitRemoteSpec(raw, index, allowedHosts) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`weekly-report.gitRemotes[${index}] must be an object`);
  }
  const entry = raw;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  const sshUrl = typeof entry.sshUrl === "string" ? entry.sshUrl.trim() : "";
  if (!name || !GIT_NAME_REGEX.test(name)) {
    throw new Error(
      `weekly-report.gitRemotes[${index}].name "${entry.name}" must match ${GIT_NAME_REGEX.source}`
    );
  }
  if (!sshUrl) {
    throw new Error(`weekly-report.gitRemotes[${index}].sshUrl is required`);
  }
  for (const forbidden of FORBIDDEN_URL_SUBSTRINGS) {
    if (sshUrl.includes(forbidden)) {
      throw new Error(
        `weekly-report.gitRemotes[${index}].sshUrl contains forbidden substring "${forbidden}"`
      );
    }
  }
  const match = GIT_SSH_URL_REGEX.exec(sshUrl);
  if (!match) {
    throw new Error(
      `weekly-report.gitRemotes[${index}].sshUrl "${sshUrl}" must be scp-style: user@host:path.git`
    );
  }
  const host = match[1];
  if (!allowedHosts.includes(host)) {
    throw new Error(
      `weekly-report.gitRemotes[${index}].sshUrl host "${host}" not in gitHostAllowlist [${allowedHosts.join(", ")}]`
    );
  }
  return { name, sshUrl };
}
function readGitRemotes(value, allowedHosts) {
  if (value === void 0 || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("weekly-report.gitRemotes must be an array of {name, sshUrl}");
  }
  return value.map((entry, idx) => validateGitRemoteSpec(entry, idx, allowedHosts));
}
function deriveUserOpenIdFromSessionKey(sessionKey) {
  if (!sessionKey) {
    return void 0;
  }
  const match = FEISHU_DIRECT_SESSION_KEY_REGEX.exec(sessionKey);
  if (!match) {
    return void 0;
  }
  const candidate = match[1];
  return FEISHU_OPEN_ID_REGEX.test(candidate) ? candidate : void 0;
}
function readOpenIdField(value, field) {
  const raw = readOptionalString2(value, field);
  if (!raw) {
    return void 0;
  }
  if (!FEISHU_OPEN_ID_REGEX.test(raw)) {
    throw new Error(
      `weekly-report.${field} "${raw}" must match Feishu open_id shape (${FEISHU_OPEN_ID_REGEX.source})`
    );
  }
  return raw;
}
function parseWeeklyReportPluginConfig(raw) {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const reminderAfterDays = readPositiveInteger(
    cfg.reminderAfterDays,
    "reminderAfterDays",
    DEFAULT_REMINDER_DAYS
  );
  const failAfterDays = readPositiveInteger(cfg.failAfterDays, "failAfterDays", DEFAULT_FAIL_DAYS);
  if (failAfterDays <= reminderAfterDays) {
    throw new Error("weekly-report.failAfterDays must be strictly greater than reminderAfterDays");
  }
  const sweeperIntervalMs = readPositiveInteger(
    cfg.sweeperIntervalMs,
    "sweeperIntervalMs",
    ONE_HOUR_MS
  );
  const gitHostAllowlist = readHostAllowlist(cfg.gitHostAllowlist);
  const gitRemotes = readGitRemotes(cfg.gitRemotes, gitHostAllowlist);
  const gitAuthor = readOptionalString2(cfg.gitAuthor, "gitAuthor");
  const gitWorkspaceDir = readOptionalString2(cfg.gitWorkspaceDir, "gitWorkspaceDir");
  const gitFetchTimeoutMs = readBoundedInteger(
    cfg.gitFetchTimeoutMs,
    "gitFetchTimeoutMs",
    DEFAULT_GIT_FETCH_TIMEOUT_MS,
    1e3
  );
  const gitMaxCommitsPerRepo = readPositiveInteger(
    cfg.gitMaxCommitsPerRepo,
    "gitMaxCommitsPerRepo",
    DEFAULT_GIT_MAX_COMMITS_PER_REPO
  );
  const gitMaxParallelOps = readPositiveInteger(
    cfg.gitMaxParallelOps,
    "gitMaxParallelOps",
    DEFAULT_GIT_MAX_PARALLEL_OPS
  );
  const gitMaxRepoCount = readPositiveInteger(
    cfg.gitMaxRepoCount,
    "gitMaxRepoCount",
    DEFAULT_GIT_MAX_REPO_COUNT
  );
  const gitOverallTimeoutMs = readBoundedInteger(
    cfg.gitOverallTimeoutMs,
    "gitOverallTimeoutMs",
    DEFAULT_GIT_OVERALL_TIMEOUT_MS,
    5e3
  );
  if (gitRemotes.length > 0) {
    if (!gitAuthor) {
      throw new Error("weekly-report.gitAuthor is required when gitRemotes is non-empty");
    }
    if (gitRemotes.length > gitMaxRepoCount) {
      throw new Error(
        `weekly-report.gitRemotes has ${gitRemotes.length} entries (cap is gitMaxRepoCount=${gitMaxRepoCount})`
      );
    }
    const seenNames = /* @__PURE__ */ new Set();
    for (const remote of gitRemotes) {
      if (seenNames.has(remote.name)) {
        throw new Error(`weekly-report.gitRemotes duplicate name "${remote.name}"`);
      }
      seenNames.add(remote.name);
    }
  }
  const recipientSessionKey = readOptionalString2(cfg.recipientSessionKey, "recipientSessionKey");
  const explicitUserOpenId = readOpenIdField(cfg.userOpenId, "userOpenId");
  const userOpenId = explicitUserOpenId ?? deriveUserOpenIdFromSessionKey(recipientSessionKey);
  const botOpenId = readOpenIdField(cfg.botOpenId, "botOpenId");
  const groupDenylist = readStringArray(cfg.groupDenylist, "groupDenylist");
  const groupMaxMessagesPerPass = readPositiveInteger(
    cfg.groupMaxMessagesPerPass,
    "groupMaxMessagesPerPass",
    DEFAULT_GROUP_MAX_MESSAGES_PER_PASS
  );
  const larkCliBinPath = readOptionalString2(cfg.larkCliBinPath, "larkCliBinPath") ?? DEFAULT_LARK_CLI_BIN_PATH;
  const larkCliAccountId = readOptionalString2(cfg.larkCliAccountId, "larkCliAccountId");
  const larkCliTimeoutMs = readBoundedInteger(
    cfg.larkCliTimeoutMs,
    "larkCliTimeoutMs",
    DEFAULT_LARK_CLI_TIMEOUT_MS,
    1e3
  );
  const larkCliMaxPages = readPositiveInteger(
    cfg.larkCliMaxPages,
    "larkCliMaxPages",
    DEFAULT_LARK_CLI_MAX_PAGES
  );
  const larkOfficialCliBinPath = readOptionalString2(cfg.larkOfficialCliBinPath, "larkOfficialCliBinPath") ?? DEFAULT_LARK_OFFICIAL_CLI_BIN_PATH;
  const larkOfficialCliTimeoutMs = readBoundedInteger(
    cfg.larkOfficialCliTimeoutMs,
    "larkOfficialCliTimeoutMs",
    DEFAULT_LARK_OFFICIAL_CLI_TIMEOUT_MS,
    1e3
  );
  const docIdentity = readDocIdentity(cfg.docIdentity);
  return {
    targetDocToken: readOptionalString2(cfg.targetDocToken, "targetDocToken"),
    recipientSessionKey,
    reminderAfterDays,
    failAfterDays,
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
    userOpenId,
    botOpenId,
    groupDenylist,
    groupMaxMessagesPerPass,
    larkCliBinPath,
    larkCliAccountId,
    larkCliTimeoutMs,
    larkCliMaxPages,
    larkOfficialCliBinPath,
    larkOfficialCliTimeoutMs,
    docIdentity
  };
}
function readDocIdentity(value) {
  if (value === void 0 || value === null) {
    return DEFAULT_DOC_IDENTITY;
  }
  if (value === "user" || value === "bot") {
    return value;
  }
  throw new Error(`weekly-report.docIdentity must be "user" or "bot"`);
}

// extensions/weekly-report/src/timeout-sweeper.ts
var MS_PER_DAY2 = 864e5;
function startTimeoutSweeper(deps) {
  const { runtime, controllerId, settings, logger } = deps;
  const now = deps.now ?? Date.now;
  const recipientSessionKey = settings.recipientSessionKey;
  if (!recipientSessionKey) {
    logger.info("weekly-report: timeout sweeper idle (recipientSessionKey not configured)");
    return () => {
    };
  }
  const tick = () => {
    try {
      sweepOnce({ runtime, controllerId, settings, recipientSessionKey, now, logger });
    } catch (err) {
      logger.error(`weekly-report sweeper tick failed: ${err.message}`);
    }
  };
  tick();
  const interval = setInterval(tick, settings.sweeperIntervalMs);
  if (typeof interval.unref === "function") {
    interval.unref();
  }
  return () => clearInterval(interval);
}
function sweepOnce(params) {
  const { runtime, controllerId, settings, recipientSessionKey, now, logger } = params;
  const bound = runtime.tasks.managedFlows.bindSession({ sessionKey: recipientSessionKey });
  const flows = bound.list();
  const reminderThresholdMs = settings.reminderAfterDays * MS_PER_DAY2;
  const failThresholdMs = settings.failAfterDays * MS_PER_DAY2;
  const nowTs = now();
  let reminded = 0;
  let failed = 0;
  let skipped = 0;
  for (const flow of flows) {
    if (flow.controllerId !== controllerId) {
      continue;
    }
    if (flow.status !== "waiting") {
      continue;
    }
    if (!isWeeklyReportFlowState(flow.stateJson)) {
      continue;
    }
    const ageMs = nowTs - flow.updatedAt;
    if (ageMs >= failThresholdMs) {
      const result = bound.fail({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson: { ...flow.stateJson, lastError: "expired" }
      });
      if (result.applied) {
        failed += 1;
        logger.info(
          `weekly-report: flow ${flow.flowId} expired (weekKey=${flow.stateJson.weekKey}, ageDays=${(ageMs / MS_PER_DAY2).toFixed(1)})`
        );
      } else {
        skipped += 1;
      }
      continue;
    }
    if (ageMs >= reminderThresholdMs && flow.stateJson.reminderSentAt === void 0) {
      const result = bound.setWaiting({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: WEEKLY_REPORT_STEPS.awaitUserReply,
        stateJson: { ...flow.stateJson, reminderSentAt: nowTs },
        waitJson: flow.waitJson ?? null
      });
      if (result.applied) {
        try {
          runtime.system.enqueueSystemEvent(
            `Reminder: your weekly-report card for ${flow.stateJson.weekTitle} (flowId=${flow.flowId}) is still waiting for confirmation. Please re-send the card or remind the user politely.`,
            { sessionKey: recipientSessionKey }
          );
        } catch (err) {
          logger.warn(
            `weekly-report: reminder system-event enqueue failed for ${flow.flowId}: ${err.message}`
          );
        }
        reminded += 1;
      } else {
        skipped += 1;
      }
      continue;
    }
    skipped += 1;
  }
  return { reminded, failed, skipped };
}

// extensions/weekly-report/index.ts
var WEEKLY_REPORT_CONTROLLER_ID = "weekly-report";
function withBoundFlow(api, settings, build, opts) {
  return ((ctx) => {
    if (ctx.sandboxed) {
      return null;
    }
    if (opts?.unavailableWhen?.(ctx)) {
      return null;
    }
    const managedFlows = api.runtime?.tasks?.managedFlows;
    if (!managedFlows) {
      return null;
    }
    const boundSessionKey = settings.recipientSessionKey ?? ctx.sessionKey;
    if (!boundSessionKey) {
      return null;
    }
    const taskFlow = managedFlows.bindSession({ sessionKey: boundSessionKey });
    return build({ taskFlow });
  });
}
var index_default = definePluginEntry({
  id: "weekly-report",
  name: "Weekly Report",
  description: "Cron-triggered weekly report flow with Feishu card confirmation and doc write.",
  configSchema: weeklyReportConfigSchema,
  register(api) {
    const settings = parseWeeklyReportPluginConfig(api.pluginConfig);
    api.registerTool(
      withBoundFlow(api, settings, ({ taskFlow }) => {
        const runtime = api.runtime;
        const cardSender = runtime?.system ? async (params) => sendInteractiveCard({
          runCommand: runtime.system.runCommandWithTimeout,
          binPath: settings.larkOfficialCliBinPath,
          toOpenId: params.toOpenId,
          card: params.card,
          timeoutMs: settings.larkOfficialCliTimeoutMs
        }) : void 0;
        return createSubmitWeeklyReportDraftTool({
          taskFlow,
          controllerId: WEEKLY_REPORT_CONTROLLER_ID,
          settings,
          ...cardSender ? { cardSender } : {}
        });
      })
    );
    api.registerTool(
      withBoundFlow(
        api,
        settings,
        ({ taskFlow }) => createRespondToWeeklyReportCardTool({
          taskFlow,
          controllerId: WEEKLY_REPORT_CONTROLLER_ID
        }),
        {
          // The re-draft sub-session must submit via submit_weekly_report_draft, never this tool —
          // so it isn't exposed there at all (the prior revision failed because the model called it).
          unavailableWhen: (ctx) => isWeeklyReportSupplementSession(ctx.sessionKey)
        }
      )
    );
    api.registerTool(((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createBeginWeeklyReportTool({ settings });
    }));
    api.registerTool(
      withBoundFlow(
        api,
        settings,
        ({ taskFlow }) => createFinalizeWeeklyReportTool({
          taskFlow,
          controllerId: WEEKLY_REPORT_CONTROLLER_ID
        })
      )
    );
    api.registerTool(((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      const runtime = api.runtime;
      if (!runtime?.system?.runCommandWithTimeout || !runtime?.state?.resolveStateDir) {
        return null;
      }
      return createFetchGitActivityTool({
        settings,
        runCommand: runtime.system.runCommandWithTimeout,
        resolveStateDir: () => runtime.state.resolveStateDir()
      });
    }));
    api.registerTool(((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      const runtime = api.runtime;
      if (!runtime?.system?.runCommandWithTimeout) {
        return null;
      }
      return createFetchRecentGroupMessagesTool({
        settings,
        runCommand: runtime.system.runCommandWithTimeout
      });
    }));
    if (api.runtime?.tasks?.managedFlows && api.runtime?.system?.runCommandWithTimeout && settings.recipientSessionKey) {
      const boundTaskFlowForHandler = api.runtime.tasks.managedFlows.bindSession({
        sessionKey: settings.recipientSessionKey
      });
      const handlerRunCommand = api.runtime.system.runCommandWithTimeout;
      const subagentApi = api.runtime?.subagent;
      api.registerInteractiveHandler({
        channel: "feishu",
        namespace: "weekly-report",
        handler: createWeeklyReportInteractiveHandler({
          taskFlow: boundTaskFlowForHandler,
          controllerId: WEEKLY_REPORT_CONTROLLER_ID,
          settings,
          runCommand: handlerRunCommand,
          ...subagentApi ? { subagentRun: (params) => subagentApi.run(params) } : {}
        })
      });
    }
    if (api.runtime?.tasks?.managedFlows) {
      const stop = startTimeoutSweeper({
        runtime: api.runtime,
        controllerId: WEEKLY_REPORT_CONTROLLER_ID,
        settings,
        logger: api.logger
      });
      api.registerService({
        id: "weekly-report-sweeper",
        start: () => {
        },
        stop: async () => {
          stop();
        }
      });
    }
  }
});
export {
  index_default as default
};
