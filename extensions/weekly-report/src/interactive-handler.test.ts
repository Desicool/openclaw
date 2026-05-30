import { describe, expect, it, vi } from "vitest";
import { CARD_NAMESPACE, SUPPLEMENT_INPUT_NAME, buildCardEnvelope } from "./card.js";
import {
  createWeeklyReportInteractiveHandler,
  type CreateInteractiveHandlerDeps,
  type RunCommandFn,
  type SubagentRunFn,
  type WeeklyReportInteractiveCtx,
} from "./interactive-handler.js";
import { parseWeeklyReportPluginConfig, type WeeklyReportPluginSettings } from "./settings.js";

const USER_OPEN_ID = "ou_f95d535ac705bf89608914906e339424";
const RECIPIENT_SESSION_KEY = `agent:silver-chariot:feishu:direct:${USER_OPEN_ID}`;
const CONTROLLER_ID = "weekly-report";

function settingsWithRecipient(): WeeklyReportPluginSettings {
  return parseWeeklyReportPluginConfig({
    recipientSessionKey: RECIPIENT_SESSION_KEY,
    targetDocToken: "doc-token-123",
    larkCliBinPath: "feishu",
    larkCliAccountId: "silver-chariot",
  });
}

function fakeTaskFlow(opts: {
  flowId: string;
  weekKey: string;
  sessionKey: string;
  status?: "waiting" | "running" | "done";
  cardChatId?: string;
}) {
  const baseFlow = {
    flowId: opts.flowId,
    controllerId: CONTROLLER_ID,
    status: opts.status ?? "waiting",
    revision: 1,
    stateJson: {
      weekKey: opts.weekKey,
      weekTitle: "2026.5.25-2026.5.31",
      draft: {
        week_title: "2026.5.25-2026.5.31",
        current_week: [{ title: "X", intent: "i", objective: "o", completed: ["a"] }],
        next_week: [{ project: "P", plan: "Q" }],
      },
      recipientSessionKey: opts.sessionKey,
      targetDocToken: "doc-token-123",
      ...(opts.cardChatId ? { cardChatId: opts.cardChatId } : {}),
    },
  };
  return {
    sessionKey: opts.sessionKey,
    get: (id: string) => (id === opts.flowId ? baseFlow : undefined),
    resume: vi.fn(({ flowId }: { flowId: string }) => ({
      applied: true,
      code: "ok",
      flow: { ...baseFlow, flowId, revision: baseFlow.revision + 1 },
    })),
    finish: vi.fn(({ flowId }: { flowId: string }) => ({
      applied: true,
      code: "ok",
      flow: { ...baseFlow, flowId, revision: baseFlow.revision + 2, status: "done" },
    })),
    fail: vi.fn(({ flowId }: { flowId: string }) => ({
      applied: true,
      code: "ok",
      flow: { ...baseFlow, flowId, revision: baseFlow.revision + 2, status: "failed" },
    })),
  } as unknown as CreateInteractiveHandlerDeps["taskFlow"];
}

function makeCtx(opts: {
  envelope: ReturnType<typeof buildCardEnvelope>;
  supplement?: string;
}): WeeklyReportInteractiveCtx & { respond: { reply: ReturnType<typeof vi.fn> } } {
  const reply = vi.fn(async () => undefined);
  const event = {
    action: {
      value: opts.envelope,
      ...(opts.supplement !== undefined
        ? { form_value: { [SUPPLEMENT_INPUT_NAME]: opts.supplement } }
        : {}),
    },
  };
  return {
    channel: "feishu",
    accountId: "silver-chariot",
    senderId: USER_OPEN_ID,
    conversationId: "oc_dm",
    messageId: "om_card",
    namespace: CARD_NAMESPACE,
    payload: opts.envelope.action.split(":")[1] ?? "",
    action: opts.envelope.action,
    rawEvent: event,
    respond: { reply, followUp: async () => undefined, editMessage: async () => undefined },
  };
}

type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  killed: boolean;
  termination: "exited" | "signal" | "timeout";
};

function ok(stdout: string): SpawnResult {
  return { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exited" };
}

function fail(stderr: string, code = 1): SpawnResult {
  return { stdout: "", stderr, code, signal: null, killed: false, termination: "exited" };
}

// Route a stubbed official-CLI invocation by its `--scope` / `--command` flags.
function routeOfficialCli(
  argv: readonly string[],
  docs: { outline: unknown; section: unknown; keyword: unknown; insert: unknown; other: unknown },
): SpawnResult {
  const a = [...argv];
  const json = (v: unknown) => ok(`${JSON.stringify(v)}\n`);
  if (a.includes("drive") && a.includes("+inspect")) {
    return json({ ok: true, data: { title: "周报（updated at 0101）", type: "docx" } });
  }
  if (a.includes("drive") && a.includes("patch")) {
    return json({ ok: true });
  }
  if (a.includes("+fetch")) {
    const scope = a[a.indexOf("--scope") + 1];
    if (scope === "outline") {
      return json(docs.outline);
    }
    if (scope === "section") {
      return json(docs.section);
    }
    return json(docs.keyword);
  }
  if (a.includes("+update")) {
    const command = a[a.indexOf("--command") + 1];
    if (command === "block_insert_after") {
      return json(docs.insert);
    }
    return json(docs.other);
  }
  return fail("unexpected cmd");
}

const EMPTY_DOC = { ok: true, data: { document: { document_id: "page-root", content: "" } } };
const INSERT_OK = { ok: true, data: { document: { new_blocks: [{ block_id: "blk-new-1" }] } } };
const UPDATE_OK = { ok: true, data: { document: {} } };

describe("createWeeklyReportInteractiveHandler (confirm → non-destructive block write)", () => {
  it("inserts the section at the top via official lark-cli and finishes the flow (fresh doc)", async () => {
    const taskFlow = fakeTaskFlow({
      flowId: "flow-1",
      weekKey: "2026-W22",
      sessionKey: RECIPIENT_SESSION_KEY,
    });
    const commands: string[][] = [];
    const runCommand = vi.fn(async (argv: readonly string[]) => {
      commands.push([...argv]);
      return routeOfficialCli(argv, {
        // outline has no H2 matching the week title → no existing section to replace.
        outline: {
          ok: true,
          data: { document: { document_id: "page-root", content: '<h1 id="t">2026 周报</h1>' } },
        },
        section: EMPTY_DOC,
        keyword: EMPTY_DOC,
        insert: INSERT_OK,
        other: UPDATE_OK,
      });
    }) as unknown as RunCommandFn;
    const handler = createWeeklyReportInteractiveHandler({
      taskFlow,
      controllerId: CONTROLLER_ID,
      settings: settingsWithRecipient(),
      runCommand,
    });
    const ctx = makeCtx({
      envelope: buildCardEnvelope({ flowId: "flow-1", weekKey: "2026-W22", action: "confirm" }),
    });
    const res = await handler(ctx);
    expect(res.handled).toBe(true);
    // Callback is acked immediately (Feishu's ~3s deadline); the write runs detached.
    expect(res.toast?.type).toBe("info");
    await vi.waitFor(() => expect(taskFlow.finish).toHaveBeenCalledOnce());
    expect(taskFlow.fail).not.toHaveBeenCalled();
    // Official CLI used; section inserted at the page head; never the destructive overwrite.
    expect(commands.every((c) => c[0] === "lark-cli")).toBe(true);
    expect(commands.some((c) => c.includes("+update") && c.includes("block_insert_after"))).toBe(
      true,
    );
    expect(commands.some((c) => c.includes("block_delete"))).toBe(false);
    expect(commands.some((c) => c.includes("--mode") && c.includes("overwrite"))).toBe(false);
    expect(ctx.respond.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/已写入文档/) }),
    );
  });

  it("replaces the existing same-week section (block_delete) before inserting", async () => {
    const taskFlow = fakeTaskFlow({
      flowId: "flow-1",
      weekKey: "2026-W22",
      sessionKey: RECIPIENT_SESSION_KEY,
    });
    const commands: string[][] = [];
    const runCommand = vi.fn(async (argv: readonly string[]) => {
      commands.push([...argv]);
      return routeOfficialCli(argv, {
        // outline H2 text equals the flow's weekTitle "2026.5.25-2026.5.31".
        outline: {
          ok: true,
          data: {
            document: {
              document_id: "page-root",
              content: '<h2 id="blk-week">2026.5.25-2026.5.31</h2>',
            },
          },
        },
        section: {
          ok: true,
          data: {
            document: {
              document_id: "page-root",
              content: '<h2 id="blk-week">2026.5.25-2026.5.31</h2><p id="blk-body">x</p>',
            },
          },
        },
        keyword: EMPTY_DOC,
        insert: INSERT_OK,
        other: UPDATE_OK,
      });
    }) as unknown as RunCommandFn;
    const handler = createWeeklyReportInteractiveHandler({
      taskFlow,
      controllerId: CONTROLLER_ID,
      settings: settingsWithRecipient(),
      runCommand,
    });
    const res = await handler(
      makeCtx({
        envelope: buildCardEnvelope({ flowId: "flow-1", weekKey: "2026-W22", action: "confirm" }),
      }),
    );
    expect(res.handled).toBe(true);
    await vi.waitFor(() => expect(taskFlow.finish).toHaveBeenCalledOnce());
    const del = commands.find((c) => c.includes("block_delete"));
    expect(del).toBeDefined();
    const deletedIds = del![del!.indexOf("--block-id") + 1];
    expect(deletedIds).toContain("blk-week");
    expect(deletedIds).toContain("blk-body");
  });

  it("on confirm: doc access failure → flow failed (detached), callback still acked", async () => {
    const taskFlow = fakeTaskFlow({
      flowId: "flow-1",
      weekKey: "2026-W22",
      sessionKey: RECIPIENT_SESSION_KEY,
    });
    const runCommand = (async () => fail("permission denied")) as unknown as RunCommandFn;
    const handler = createWeeklyReportInteractiveHandler({
      taskFlow,
      controllerId: CONTROLLER_ID,
      settings: settingsWithRecipient(),
      runCommand,
    });
    const ctx = makeCtx({
      envelope: buildCardEnvelope({ flowId: "flow-1", weekKey: "2026-W22", action: "confirm" }),
    });
    const res = await handler(ctx);
    // The callback is acked immediately (info toast), NOT blocked on the failing write.
    expect(res.handled).toBe(true);
    expect(res.toast?.type).toBe("info");
    expect(taskFlow.resume).toHaveBeenCalledOnce();
    // The failure is detected on the detached task and surfaced as a DM follow-up.
    await vi.waitFor(() => expect(taskFlow.fail).toHaveBeenCalledOnce());
    expect(taskFlow.finish).not.toHaveBeenCalled();
    expect(ctx.respond.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/写入周报文档失败/) }),
    );
  });
});

describe("createWeeklyReportInteractiveHandler v9 (supplement path)", () => {
  it("on supplement with text: transitions to revising and spawns a subagent turn", async () => {
    const taskFlow = fakeTaskFlow({
      flowId: "flow-1",
      weekKey: "2026-W22",
      sessionKey: RECIPIENT_SESSION_KEY,
      cardChatId: "oc_user_dm",
    });
    const runCommand = vi.fn(() => Promise.resolve(ok("{}"))) as unknown as RunCommandFn;
    const subagentRun = vi.fn<SubagentRunFn>(async () => ({ runId: "run-abc" }));
    const handler = createWeeklyReportInteractiveHandler({
      taskFlow,
      controllerId: CONTROLLER_ID,
      settings: settingsWithRecipient(),
      runCommand,
      subagentRun,
    });
    const ctx = makeCtx({
      envelope: buildCardEnvelope({ flowId: "flow-1", weekKey: "2026-W22", action: "supplement" }),
      supplement: "  请把第 2 条改为 X  ",
    });
    const res = await handler(ctx);
    expect(res.handled).toBe(true);
    expect(taskFlow.resume).toHaveBeenCalledOnce();
    expect(taskFlow.finish).not.toHaveBeenCalled();
    expect(subagentRun).toHaveBeenCalledOnce();
    const [params] = subagentRun.mock.calls[0];
    // The supplement re-draft runs in an isolated sub-session, NOT in the user's DM session,
    // so that the main silver-chariot loop isn't entangled in weekly-report meta-conversation.
    expect(params.sessionKey).not.toBe(RECIPIENT_SESSION_KEY);
    expect(params.sessionKey).toMatch(/^agent:silver-chariot:weekly-report-supplement:flow-1:\d+$/);
    expect(params.message).toMatch(/请把第 2 条改为 X/);
    expect(params.message).toMatch(/supersedeFlowId/);
    // The message must instruct the agent to TREAT the supplement as a research hint,
    // not as text to splice into the draft verbatim.
    expect(params.message).toMatch(/研究提示/);
    expect(params.message).toMatch(/不要把承太郎的话本身当成 bullet/);
    expect(params.message).toMatch(/重新并行调用/);
    // The re-draft sub-session must submit via submit_weekly_report_draft and must NOT call
    // respond_to_weekly_report_card (that caused the revision to fail with session_mismatch).
    expect(params.message).toMatch(/submit_weekly_report_draft/);
    expect(params.message).toMatch(/禁止调用 `?respond_to_weekly_report_card/);
  });

  it("on supplement with empty text: warn toast, no transition, no subagent", async () => {
    const taskFlow = fakeTaskFlow({
      flowId: "flow-1",
      weekKey: "2026-W22",
      sessionKey: RECIPIENT_SESSION_KEY,
    });
    const runCommand = vi.fn(() => Promise.resolve(ok("{}"))) as unknown as RunCommandFn;
    const subagentRun = vi.fn(async () => ({ runId: "x" }));
    const handler = createWeeklyReportInteractiveHandler({
      taskFlow,
      controllerId: CONTROLLER_ID,
      settings: settingsWithRecipient(),
      runCommand,
      subagentRun,
    });
    const res = await handler(
      makeCtx({
        envelope: buildCardEnvelope({
          flowId: "flow-1",
          weekKey: "2026-W22",
          action: "supplement",
        }),
        supplement: "   ",
      }),
    );
    expect(res.toast?.type).toBe("warning");
    expect(taskFlow.resume).not.toHaveBeenCalled();
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("on supplement when subagentRun is unavailable: error toast", async () => {
    const taskFlow = fakeTaskFlow({
      flowId: "flow-1",
      weekKey: "2026-W22",
      sessionKey: RECIPIENT_SESSION_KEY,
    });
    const runCommand = vi.fn(() => Promise.resolve(ok("{}"))) as unknown as RunCommandFn;
    const handler = createWeeklyReportInteractiveHandler({
      taskFlow,
      controllerId: CONTROLLER_ID,
      settings: settingsWithRecipient(),
      runCommand,
    });
    const res = await handler(
      makeCtx({
        envelope: buildCardEnvelope({
          flowId: "flow-1",
          weekKey: "2026-W22",
          action: "supplement",
        }),
        supplement: "real text",
      }),
    );
    expect(res.toast?.type).toBe("error");
  });
});

describe("createWeeklyReportInteractiveHandler v9 (validation)", () => {
  it("rejects bad envelope shape", async () => {
    const taskFlow = fakeTaskFlow({
      flowId: "flow-1",
      weekKey: "2026-W22",
      sessionKey: RECIPIENT_SESSION_KEY,
    });
    const runCommand = (() => Promise.resolve(ok("{}"))) as unknown as RunCommandFn;
    const handler = createWeeklyReportInteractiveHandler({
      taskFlow,
      controllerId: CONTROLLER_ID,
      settings: settingsWithRecipient(),
      runCommand,
    });
    const ctxBad = makeCtx({
      envelope: { action: "other-plugin:confirm", flowId: "x", weekKey: "y" },
    });
    const r1 = await handler(ctxBad);
    expect(r1.toast?.type).toBe("error");
  });

  it("rejects when flow trust fails (session mismatch)", async () => {
    const taskFlow = fakeTaskFlow({
      flowId: "flow-1",
      weekKey: "2026-W22",
      sessionKey: "agent:other:feishu:direct:ou_other",
    });
    const runCommand = (() => Promise.resolve(ok("{}"))) as unknown as RunCommandFn;
    const handler = createWeeklyReportInteractiveHandler({
      taskFlow,
      controllerId: CONTROLLER_ID,
      settings: settingsWithRecipient(),
      runCommand,
    });
    const res = await handler(
      makeCtx({
        envelope: buildCardEnvelope({ flowId: "flow-1", weekKey: "2026-W22", action: "confirm" }),
      }),
    );
    expect(res.toast?.type).toBe("warning");
    expect(res.toast?.content).toMatch(/session mismatch|失效/);
  });
});
