import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { readCronRunLogEntriesSync } from "../../../cron/run-log.js";
import { loadCronStore, resolveCronQuarantinePath, saveCronStore } from "../../../cron/store.js";
import {
  collectLegacyWhatsAppCrontabHealthWarning,
  maybeRepairLegacyCronStore,
  noteLegacyWhatsAppCrontabHealthCheck,
} from "./index.js";

type TerminalNote = (message: string, title?: string) => void;

const noteMock = vi.hoisted(() => vi.fn<TerminalNote>());

vi.mock("../../../../packages/terminal-core/src/note.js", () => ({
  note: noteMock,
}));

let tempRoot: string | null = null;

async function makeTempStorePath() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-cron-"));
  return path.join(tempRoot, "cron", "jobs.json");
}

afterEach(async () => {
  noteMock.mockClear();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function makePrompter(confirmResult = true) {
  return {
    confirm: vi.fn().mockResolvedValue(confirmResult),
  };
}

function createCronConfig(storePath: string): OpenClawConfig {
  return {
    cron: {
      store: storePath,
      webhook: "https://example.invalid/cron-finished",
    },
  };
}

function createLegacyCronJob(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "legacy-job",
    name: "Legacy job",
    notify: true,
    createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
    schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
    payload: {
      kind: "systemEvent",
      text: "Morning brief",
    },
    state: {},
    ...overrides,
  };
}

function createCurrentCronJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "sqlite-job",
    name: "SQLite job",
    enabled: true,
    createdAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "systemEvent",
      text: "SQLite brief",
    },
    state: {},
    ...overrides,
  };
}

async function writeCronStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        version: 1,
        jobs,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function writeCurrentCronStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await saveCronStore(storePath, {
    version: 1,
    jobs: jobs as never,
  });
}

async function writeLegacyCronArrayStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(jobs, null, 2), "utf-8");
}

async function readPersistedJobs(storePath: string): Promise<Array<Record<string, unknown>>> {
  return (await loadCronStore(storePath)).jobs as unknown as Array<Record<string, unknown>>;
}

function requirePersistedJob(jobs: Array<Record<string, unknown>>, index: number) {
  const job = jobs[index];
  if (!job) {
    throw new Error(`expected persisted cron job ${index}`);
  }
  return job;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectNoteContaining(message: string, title: string): void {
  expect(
    noteMock.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes(message) && call[1] === title,
    ),
  ).toBe(true);
}

function expectNoNoteContaining(message: string, title: string): void {
  expect(
    noteMock.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes(message) && call[1] === title,
    ),
  ).toBe(false);
}

describe("maybeRepairLegacyCronStore", () => {
  it("reports quarantined cron rows even when the active store is already sanitized", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, []);
    await fs.writeFile(
      resolveCronQuarantinePath(storePath),
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              quarantinedAtMs: Date.parse("2026-05-29T09:00:00.000Z"),
              sourceIndex: 1,
              reason: "missing-schedule",
              job: { id: "bad-cron", name: "Bad cron" },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expectNoteContaining("Quarantined cron job rows found", "Cron");
    expectNoteContaining("1 row was removed from the active cron store", "Cron");
  });

  it("surfaces cron payload model overrides without rewriting current jobs", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      {
        id: "api-pinned",
        name: "API pinned",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
          model: "openai/gpt-5.4",
          thinking: "high",
        },
        state: {},
      },
      {
        id: "other-pinned",
        name: "Other pinned",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
          model: "anthropic/claude-sonnet-4-6",
        },
        state: {},
      },
      {
        id: "inherits-default",
        name: "Inherits default",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
        },
        state: {},
      },
    ]);
    const prompter = makePrompter(true);

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: { store: storePath },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5", fallbacks: [] },
          },
        },
      },
      options: {},
      prompter,
    });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expectNoteContaining("Cron model overrides detected", "Cron");
    expectNoteContaining("2 jobs set `payload.model`", "Cron");
    expectNoteContaining("Provider namespaces: anthropic=1, openai=1", "Cron");
    expectNoteContaining("2 jobs use a different model than `agents.defaults.model`", "Cron");

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.model).toBe("openai/gpt-5.4");
    expect(payload.thinking).toBe("high");
  });

  it("does not surface cron model override diagnostics when jobs inherit the default", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      {
        id: "inherits-default",
        name: "Inherits default",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
        },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    expectNoNoteContaining("Cron model overrides detected", "Cron");
  });

  it("counts alias model pins as default mismatches", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      {
        id: "alias-pinned",
        name: "Alias the native runtime",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 10 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
          model: "gpt",
        },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: { store: storePath },
        agents: {
          defaults: {
            model: { primary: "test:opus", fallbacks: [] },
          },
        },
      },
      options: {},
      prompter: makePrompter(true),
    });

    expectNoteContaining("1 job set `payload.model`", "Cron");
    expectNoteContaining("Provider namespaces: bare/alias=1", "Cron");
    expectNoteContaining("1 job uses a different model than `agents.defaults.model`", "Cron");
    expectNoteContaining("Examples: alias-pinned -> gpt", "Cron");
  });

  it("repairs legacy cron store fields and migrates notify fallback to webhook delivery", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const cfg = createCronConfig(storePath);

    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.jobId).toBeUndefined();
    expect(job.id).toBe("legacy-job");
    expect(job.notify).toBeUndefined();
    const schedule = requireRecord(job.schedule, "cron schedule");
    expect(schedule.kind).toBe("cron");
    expect(schedule.expr).toBe("0 7 * * *");
    // tz is stripped by detectTzFieldMigration — kind:cron no longer carries tz.
    expect(schedule.tz).toBeUndefined();
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron-finished");
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.kind).toBe("systemEvent");
    expect(payload.text).toBe("Morning brief");

    expectNoteContaining("Legacy cron job storage detected", "Cron");
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("repairs legacy top-level array cron stores instead of treating them as empty (#60799)", async () => {
    const storePath = await makeTempStorePath();
    await writeLegacyCronArrayStore(storePath, [createLegacyCronJob()]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.jobId).toBeUndefined();
    expect(job.id).toBe("legacy-job");
    expect(job.notify).toBeUndefined();
    expectNoteContaining("Legacy cron job storage detected", "Cron");
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("imports legacy-only jobs when SQLite already has cron rows", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      createCurrentCronJob({
        id: "legacy-job",
        name: "SQLite wins",
      }),
    ]);
    await writeCronStore(storePath, [
      createLegacyCronJob({
        name: "Stale duplicate",
      }),
      createLegacyCronJob({
        jobId: "legacy-only",
        name: "Legacy only",
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.id)).toEqual(["legacy-job", "legacy-only"]);
    expect(requirePersistedJob(jobs, 0).name).toBe("SQLite wins");
    expect(requirePersistedJob(jobs, 1).name).toBe("Legacy only");
    expectNoteContaining("1 legacy JSON cron job will be imported into SQLite", "Cron");
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("migrates legacy run logs even when the legacy job store was already archived", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [createCurrentCronJob()]);
    const runLogPath = path.join(path.dirname(storePath), "runs", "sqlite-job.jsonl");
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    await fs.writeFile(
      runLogPath,
      `${JSON.stringify({
        ts: Date.parse("2026-02-04T00:00:00.000Z"),
        jobId: "sqlite-job",
        action: "finished",
        status: "ok",
        summary: "done",
      })}\n`,
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const entries = readCronRunLogEntriesSync({ storePath, jobId: "sqlite-job" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.jobId).toBe("sqlite-job");
    expect(entries[0]?.summary).toBe("done");
    await expect(fs.stat(runLogPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${runLogPath}.migrated`)).resolves.toBeTruthy();
    expectNoteContaining("legacy JSON cron run logs will be imported into SQLite", "Cron");
    expectNoteContaining("Cron run logs migrated to SQLite", "Doctor changes");
  });

  it("repairs malformed persisted cron ids before list rendering sees them", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      createLegacyCronJob({
        id: 42,
        jobId: undefined,
        notify: false,
      }),
      createLegacyCronJob({
        id: undefined,
        jobId: undefined,
        name: "Missing id",
        notify: false,
      }),
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const firstJob = requirePersistedJob(jobs, 0);
    const secondJob = requirePersistedJob(jobs, 1);
    expect(firstJob.id).toBe("42");
    expect(typeof secondJob.id).toBe("string");
    expect(String(secondJob.id)).toMatch(/^cron-/);
    expectNoteContaining("stores `id` as a non-string value", "Cron");
    expectNoteContaining("missing a canonical string `id`", "Cron");
  });

  it("warns instead of replacing announce delivery for notify fallback jobs", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "notify-and-announce",
              name: "Notify and announce",
              notify: true,
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "Status" },
              delivery: { mode: "announce", channel: "telegram", to: "123" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: {
          store: storePath,
          webhook: "https://example.invalid/cron-finished",
        },
      },
      options: { nonInteractive: true },
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.notify).toBe(true);
    expectNoteContaining(
      'uses legacy notify fallback alongside delivery mode "announce"',
      "Doctor warnings",
    );
  });

  it("does not auto-repair in non-interactive mode without explicit repair approval", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const prompter = makePrompter(false);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: { nonInteractive: true },
      prompter,
    });

    expect(await readPersistedJobs(storePath)).toEqual([]);
    const legacy = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    const job = requirePersistedJob(legacy.jobs, 0);
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Repair legacy cron jobs now?",
      initialValue: true,
    });
    expect(job.jobId).toBe("legacy-job");
    expect(job.id).toBeUndefined();
    expect(job.notify).toBe(true);
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("migrates notify fallback none delivery jobs to cron.webhook", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "notify-none",
              name: "Notify none",
              notify: true,
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
              schedule: { kind: "every", everyMs: 60_000 },
              payload: {
                kind: "systemEvent",
                text: "Status",
              },
              delivery: { mode: "none", to: "123456789" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: {
          store: storePath,
          webhook: "https://example.invalid/cron-finished",
        },
      },
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.notify).toBeUndefined();
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron-finished");
  });

  it("repairs legacy root delivery threadId hints into delivery", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "legacy-thread-hint",
        name: "Legacy thread hint",
        enabled: true,
        createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
        schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
        },
        channel: " telegram ",
        to: "-1001234567890",
        threadId: " 99 ",
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.channel).toBeUndefined();
    expect(job.to).toBeUndefined();
    expect(job.threadId).toBeUndefined();
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("announce");
    expect(delivery.channel).toBe("telegram");
    expect(delivery.to).toBe("-1001234567890");
    expect(delivery.threadId).toBe("99");
  });

  it("rewrites stale managed dreaming jobs to the isolated agentTurn shape", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "memory-dreaming",
        name: "Memory Dreaming Promotion",
        description:
          "[managed-by=memory-core.short-term-promotion] Promote weighted short-term recalls.",
        enabled: true,
        createdAtMs: Date.parse("2026-04-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-04-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: {
          kind: "systemEvent",
          text: "__openclaw_memory_core_short_term_promotion_dream__",
        },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.sessionTarget).toBe("isolated");
    const payload = requireRecord(job.payload, "cron payload");
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toBe("__openclaw_memory_core_short_term_promotion_dream__");
    expect(payload.lightContext).toBe(true);
    const delivery = requireRecord(job.delivery, "cron delivery");
    expect(delivery.mode).toBe("none");
    expectNoteContaining("managed dreaming job", "Cron");
    expectNoteContaining("Rewrote 1 managed dreaming job", "Doctor changes");
  });

  it("warns and continues when the cron job store cannot be read", async () => {
    const storePath = await makeTempStorePath();
    // Force loadCronStore to throw a non-ENOENT read error by placing a
    // directory where the cron job store file would be. This mirrors the
    // Docker-on-root permission failure reported in #86102 without depending
    // on the test runner's effective uid (root bypasses chmod gates).
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.mkdir(storePath);
    const prompter = makePrompter(true);

    await expect(
      maybeRepairLegacyCronStore({
        cfg: { cron: { store: storePath } },
        options: {},
        prompter,
      }),
    ).resolves.toBeUndefined();

    expect(prompter.confirm).not.toHaveBeenCalled();
    expectNoteContaining("Unable to read cron job store at", "Cron");
    expectNoteContaining("later health checks will continue", "Cron");
  });

  // ---------------------------------------------------------------------------
  // Schema migrations: every→cron, tz strip, sessionTarget→isolated
  // ---------------------------------------------------------------------------

  it("converts kind:every job to kind:cron with auto-computed expression", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "every-15min",
        name: "Every 15 min",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "every", everyMs: 15 * 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "ping" },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    const schedule = requireRecord(job.schedule, "cron schedule");
    expect(schedule.kind).toBe("cron");
    expect(schedule.expr).toBe("*/15 * * * *");
    expect(schedule.everyMs).toBeUndefined();
    expect(schedule.anchorMs).toBeUndefined();
    expectNoteContaining("Legacy cron job storage detected", "Cron");
    expectNoteContaining("Cron store", "Doctor changes");
  });

  it("converts every-1min to * * * * * with apply() through the full repair path", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "every-1min",
        name: "Every minute",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "tick" },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    const schedule = requireRecord(job.schedule, "cron schedule");
    expect(schedule.kind).toBe("cron");
    expect(schedule.expr).toBe("* * * * *");
  });

  it("strips tz from kind:cron schedules through the full repair path", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "cron-with-tz",
        name: "Cron with tz",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Tokyo" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "morning" },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    const schedule = requireRecord(job.schedule, "cron schedule");
    expect(schedule.kind).toBe("cron");
    expect(schedule.expr).toBe("0 9 * * *");
    expect(schedule.tz).toBeUndefined();
    expectNoteContaining("Legacy cron job storage detected", "Cron");
    expectNoteContaining("Cron store", "Doctor changes");
  });

  it("converts kind:at + tz to UTC through the full repair path", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "at-with-tz",
        name: "At with tz",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        // 09:00 local Asia/Tokyo (UTC+9) → 00:00 UTC
        schedule: { kind: "at", at: "2026-06-10T09:00:00", tz: "Asia/Tokyo" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "once" },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    const schedule = requireRecord(job.schedule, "cron schedule");
    expect(schedule.kind).toBe("at");
    expect(schedule.tz).toBeUndefined();
    const utcMs = new Date(schedule.at as string).getTime();
    const expectedMs = new Date("2026-06-10T00:00:00.000Z").getTime();
    expect(Math.abs(utcMs - expectedMs)).toBeLessThan(60_000);
  });

  it("migrates non-isolated sessionTarget to isolated through the full repair path", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "main-target",
        name: "Main target",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 8 * * *" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "brief" },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(job.sessionTarget).toBe("isolated");
    expectNoteContaining("Legacy cron job storage detected", "Cron");
    expectNoteContaining("Cron store", "Doctor changes");
  });

  it("applies all three schema migrations together in one repair pass", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "job-every",
        name: "Every job",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "every", everyMs: 30 * 60_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "a" },
        state: {},
      },
      {
        id: "job-cron-tz",
        name: "Cron with tz",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 10 * * *", tz: "America/New_York" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "b" },
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const jobs = await readPersistedJobs(storePath);

    const everyJob = jobs.find((j) => j.id === "job-every");
    const cronTzJob = jobs.find((j) => j.id === "job-cron-tz");

    if (!everyJob || !cronTzJob) throw new Error("expected both jobs to be persisted");

    const everySched = requireRecord(everyJob.schedule, "every schedule");
    expect(everySched.kind).toBe("cron");
    expect(everySched.expr).toBe("*/30 * * * *");
    expect(everySched.everyMs).toBeUndefined();
    expect(everyJob.sessionTarget).toBe("isolated");

    const cronSched = requireRecord(cronTzJob.schedule, "cron schedule");
    expect(cronSched.kind).toBe("cron");
    expect(cronSched.tz).toBeUndefined();
    expect(cronSched.expr).toBe("0 10 * * *");
  });

  it("does not write the store when no schema migrations are needed and jobs are already canonical", async () => {
    const storePath = await makeTempStorePath();
    await writeCurrentCronStore(storePath, [
      {
        id: "canonical-job",
        name: "Canonical",
        enabled: true,
        createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 9 * * *" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "already fine" },
        state: {},
      },
    ]);
    const prompter = makePrompter(true);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter,
    });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expectNoNoteContaining("Legacy cron job storage detected", "Cron");
  });
});

describe("legacy WhatsApp crontab health check", () => {
  it("collects a warning about legacy ensure-whatsapp crontab entries on Linux", async () => {
    const warning = await collectLegacyWhatsAppCrontabHealthWarning({
      platform: "linux",
      readCrontab: async () => ({
        stdout: [
          "# keep comments ignored",
          "*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh >> ~/.openclaw/logs/whatsapp-health.log 2>&1",
          "0 9 * * * /usr/bin/true",
          "",
        ].join("\n"),
      }),
    });

    expect(warning).toContain("Legacy WhatsApp crontab health check detected");
    expect(warning).toContain("systemd user bus environment is missing");
    expect(warning).toContain("Matched 1 entry");
  });

  it("warns about legacy ensure-whatsapp crontab entries on Linux", async () => {
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "linux",
      readCrontab: async () => ({
        stdout: [
          "# keep comments ignored",
          "*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh >> ~/.openclaw/logs/whatsapp-health.log 2>&1",
          "0 9 * * * /usr/bin/true",
          "",
        ].join("\n"),
      }),
    });

    expectNoteContaining("Legacy WhatsApp crontab health check detected", "Cron");
    expectNoteContaining("systemd user bus environment is missing", "Cron");
    expectNoteContaining("Matched 1 entry", "Cron");
  });

  it("ignores missing crontab support and non-Linux hosts", async () => {
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "darwin",
      readCrontab: async () => {
        throw new Error("should not read crontab on non-Linux");
      },
    });
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "linux",
      readCrontab: async () => {
        throw Object.assign(new Error("crontab missing"), { code: "ENOENT" });
      },
    });

    expect(noteMock).not.toHaveBeenCalled();
  });

  it("ignores malformed crontab output instead of crashing", async () => {
    await expect(
      noteLegacyWhatsAppCrontabHealthCheck({
        platform: "linux",
        readCrontab: async () => ({
          stdout: undefined,
        }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      noteLegacyWhatsAppCrontabHealthCheck({
        platform: "linux",
        readCrontab: async () => ({
          stdout: 12345,
        }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      noteLegacyWhatsAppCrontabHealthCheck({
        platform: "linux",
        readCrontab: async () => ({
          stdout: { lines: ["*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh"] },
        }),
      }),
    ).resolves.toBeUndefined();

    expect(noteMock).not.toHaveBeenCalled();
  });
});
