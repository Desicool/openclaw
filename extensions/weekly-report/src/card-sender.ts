/**
 * Card delivery: shells out to the official `@larksuite/cli` (binary name `lark-cli`) to send a
 * Feishu interactive card AS THE BOT to the user's open_id. The lark plugin's
 * `feishu_ask_user_question` requires a `getTicket()` AsyncLocalStorage context that only exists
 * for Feishu-inbound-triggered turns; cron-fired turns have no ticket and the tool rejects. Other
 * lark CLIs (`@fanfanv5/feishu-cli`, `@richord/lark-cli`) only support `as: 'user'` sends, which
 * routes the card from the user's own account — wrong for a bot-to-user flow.
 *
 * `@larksuite/cli` is the official tool from larksuite/ByteDance and supports `--as bot` for
 * messenger commands. It manages the bot's tenant_access_token transparently after a one-time
 * `lark-cli config init --app-id ... --app-secret-stdin`. We invoke it via
 * `runtime.system.runCommandWithTimeout`, same shell-out pattern as `git-activity.ts`.
 *
 * Setup prerequisite (one-time on host): `npm install -g @larksuite/cli@latest` plus the config
 * init step (documented in README). The plugin's `larkOfficialCliBinPath` setting (default
 * `lark-cli`) controls the binary lookup.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";

export type RunCommandFn = PluginRuntime["system"]["runCommandWithTimeout"];

export type SendCardResult =
  | { ok: true; messageId: string; chatId: string }
  | { ok: false; error: string };

export type SendInteractiveCardParams = {
  runCommand: RunCommandFn;
  binPath: string;
  toOpenId: string;
  card: Record<string, unknown>;
  timeoutMs: number;
  idempotencyKey?: string;
};

function summarizeExecFailure(result: {
  stdout: string;
  stderr: string;
  code: number | null;
}): string {
  const trailer = result.stderr.trim() || result.stdout.trim() || `code=${result.code}`;
  return trailer.length > 240 ? `${trailer.slice(0, 239)}…` : trailer;
}

function detectKnownError(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (lower.includes("config init") || lower.includes("appid") || lower.includes("app id")) {
    return (
      "lark-cli not configured for bot mode. Run once on host: " +
      '`printf %s "<silver-chariot appSecret>" | lark-cli config init --app-id <silver-chariot appId> --app-secret-stdin --brand feishu`'
    );
  }
  if (lower.includes("auth") && (lower.includes("login") || lower.includes("token"))) {
    return (
      "lark-cli auth issue. For bot-mode sends, no user login is required — only `lark-cli config init` with bot " +
      "appId/appSecret. Verify with `lark-cli config show`."
    );
  }
  return undefined;
}

/**
 * Step 1: register the card JSON with Feishu CardKit. This is REQUIRED for schema-2.0 form
 * cards — `card.action.trigger` callbacks for `form_action_type: "submit"` buttons only route
 * to the bot's webhook when the card has a CardKit-issued `card_id`. Cards sent inline via
 * `im/v1/messages` with `msg_type=interactive, content=<full JSON>` silently fail click delivery
 * — Feishu's client shows error 200530 (callback timeout) because there's no card_id to bind
 * the click to.
 */
async function cardKitCreate(params: {
  runCommand: RunCommandFn;
  binPath: string;
  card: Record<string, unknown>;
  timeoutMs: number;
}): Promise<{ ok: true; cardId: string } | { ok: false; error: string }> {
  const data = JSON.stringify({ type: "card_json", data: JSON.stringify(params.card) });
  const argv = [
    params.binPath,
    "api",
    "POST",
    "/open-apis/cardkit/v1/cards",
    "--as",
    "bot",
    "--data",
    data,
  ];
  let result;
  try {
    result = await params.runCommand(argv, { timeoutMs: params.timeoutMs });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === "ENOENT") {
      return {
        ok: false,
        error:
          `lark-cli not found at "${params.binPath}" — install via ` +
          "`npm install -g @larksuite/cli@latest` and configure with " +
          "`lark-cli config init --app-id <silver-chariot appId> --app-secret-stdin --brand feishu` " +
          "+ `lark-cli config bind --source openclaw --app-id <appId> --identity bot-only`",
      };
    }
    return { ok: false, error: `lark-cli spawn failed: ${(err as Error).message}` };
  }
  if (result.code !== 0) {
    const trailer = summarizeExecFailure(result);
    const hint = detectKnownError(`${result.stderr}\n${result.stdout}`);
    return { ok: false, error: hint ?? `cardkit create exit ${result.code} — ${trailer}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      error: `cardkit create: unparseable stdout — ${result.stdout.slice(0, 240)}`,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "cardkit create: response missing object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.code !== 0) {
    return {
      ok: false,
      error: `cardkit create code=${String(obj.code)} msg=${String(obj.msg)}`,
    };
  }
  const data2 = obj.data;
  if (!data2 || typeof data2 !== "object") {
    return { ok: false, error: "cardkit create: response missing data field" };
  }
  const cardId = (data2 as Record<string, unknown>).card_id;
  if (typeof cardId !== "string" || cardId.length === 0) {
    return { ok: false, error: "cardkit create: response missing card_id" };
  }
  return { ok: true, cardId };
}

export async function sendInteractiveCard(
  params: SendInteractiveCardParams,
): Promise<SendCardResult> {
  const createRes = await cardKitCreate({
    runCommand: params.runCommand,
    binPath: params.binPath,
    card: params.card,
    timeoutMs: params.timeoutMs,
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
    content,
  ];
  if (params.idempotencyKey) {
    argv.push("--idempotency-key", params.idempotencyKey);
  }

  let result;
  try {
    result = await params.runCommand(argv, { timeoutMs: params.timeoutMs });
  } catch (err) {
    return { ok: false, error: `lark-cli spawn failed: ${(err as Error).message}` };
  }

  if (result.code !== 0) {
    const trailer = summarizeExecFailure(result);
    const hint = detectKnownError(`${result.stderr}\n${result.stdout}`);
    return { ok: false, error: hint ?? `lark-cli card send exit ${result.code} — ${trailer}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      error: `lark-cli card send: unparseable stdout — ${result.stdout.slice(0, 240)}`,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "lark-cli card send: response missing object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.ok !== true) {
    return {
      ok: false,
      error: `lark-cli card send returned ok=false: ${JSON.stringify(obj).slice(0, 240)}`,
    };
  }
  const data = obj.data;
  if (!data || typeof data !== "object") {
    return { ok: false, error: "lark-cli card send: response missing data field" };
  }
  const dataObj = data as Record<string, unknown>;
  const messageId = dataObj.message_id;
  const chatId = dataObj.chat_id;
  if (typeof messageId !== "string" || typeof chatId !== "string") {
    return { ok: false, error: "lark-cli card send: response missing message_id/chat_id" };
  }
  return { ok: true, messageId, chatId };
}
