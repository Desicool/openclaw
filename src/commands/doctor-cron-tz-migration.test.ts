import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";
import { maybeMigrateLegacyCronTz } from "./doctor-cron-tz-migration.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

const noteSpy = vi.mocked(note);

type TmpDir = { dir: string; storePath: string };

function makeTmpCronDir(): TmpDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-cron-tz-migration-"));
  const storePath = path.join(dir, "jobs.json");
  return { dir, storePath };
}

function writeJobs(storePath: string, jobs: unknown[]): void {
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, jobs }, null, 2));
}

function readJobs(storePath: string): unknown[] {
  const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as { jobs?: unknown[] };
  return raw.jobs ?? [];
}

function makePrompter(params: { shouldRepair: boolean }): DoctorPrompter {
  return {
    confirm: vi.fn(async () => false),
    confirmAutoFix: vi.fn(async () => false),
    confirmAggressiveAutoFix: vi.fn(async () => false),
    confirmRuntimeRepair: vi.fn(async () => false),
    select: vi.fn(async (_p, fallback) => fallback),
    shouldRepair: params.shouldRepair,
    shouldForce: false,
    repairMode: {
      shouldRepair: params.shouldRepair,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

function makeCfg(storePath: string): OpenClawConfig {
  return { cron: { store: storePath } } as OpenClawConfig;
}

function makeOptions(): DoctorOptions {
  return {};
}

describe("maybeMigrateLegacyCronTz", () => {
  let tmp: TmpDir | undefined;

  beforeEach(() => {
    noteSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (tmp) {
      try {
        fs.rmSync(tmp.dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      tmp = undefined;
    }
  });

  it("no-op when kind:at jobs have no tz field", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-no-tz",
        name: "no tz",
        enabled: true,
        schedule: { kind: "at", at: "2026-06-01T09:00:00.000Z" },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronTz({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    expect(noteSpy).not.toHaveBeenCalled();
  });

  it("fix mode: tz=America/New_York, at=2026-06-01T09:00:00 → UTC", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-ny",
        name: "ny",
        enabled: true,
        schedule: { kind: "at", at: "2026-06-01T09:00:00", tz: "America/New_York" },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronTz({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    const jobs = readJobs(tmp.storePath) as Array<{
      id: string;
      schedule: { kind: string; at: string; tz?: string };
    }>;
    expect(jobs).toHaveLength(1);
    const sched = jobs[0]?.schedule;
    expect(sched?.kind).toBe("at");
    // June 1 in EDT is UTC-4, so 09:00 EDT = 13:00 UTC.
    expect(sched?.at).toBe("2026-06-01T13:00:00.000Z");
    expect(sched?.tz).toBeUndefined();
  });

  it("fix mode: tz=Asia/Shanghai, at=2026-06-01T17:00:00 → UTC 09:00", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-shanghai",
        name: "shanghai",
        enabled: true,
        schedule: { kind: "at", at: "2026-06-01T17:00:00", tz: "Asia/Shanghai" },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronTz({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    const jobs = readJobs(tmp.storePath) as Array<{
      id: string;
      schedule: { kind: string; at: string; tz?: string };
    }>;
    expect(jobs).toHaveLength(1);
    const sched = jobs[0]?.schedule;
    expect(sched?.kind).toBe("at");
    // Asia/Shanghai is UTC+8, so 17:00 CST = 09:00 UTC.
    expect(sched?.at).toBe("2026-06-01T09:00:00.000Z");
    expect(sched?.tz).toBeUndefined();
  });

  it("unparseable tz is counted as failed and job is left unchanged", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-bad-tz",
        name: "bad tz",
        enabled: true,
        schedule: { kind: "at", at: "2026-06-01T09:00:00", tz: "Garbage/NotAZone" },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronTz({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    // No archive created (nothing migrated).
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("tz-migrated"))).toHaveLength(0);

    // Job must be untouched.
    const jobs = readJobs(tmp.storePath) as Array<{
      schedule: { tz?: string };
    }>;
    expect(jobs[0]?.schedule.tz).toBe("Garbage/NotAZone");

    // Preview note must have been emitted (mentions the failed job).
    expect(noteSpy).toHaveBeenCalled();
  });

  it("non-fix mode: emits preview note but does not mutate or archive", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-tz-preview",
        name: "tz preview",
        enabled: true,
        schedule: { kind: "at", at: "2026-06-01T17:00:00", tz: "Asia/Shanghai" },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);
    const beforeContent = fs.readFileSync(tmp.storePath, "utf-8");

    await maybeMigrateLegacyCronTz({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: false }),
    });

    expect(noteSpy).toHaveBeenCalled();
    expect(fs.readFileSync(tmp.storePath, "utf-8")).toBe(beforeContent);
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("tz-migrated"))).toHaveLength(0);
  });

  // --- New cases for kind:cron tz/staggerMs stripping ---

  it("fix mode: kind:cron with tz and staggerMs → both stripped, expr unchanged", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-cron-tz",
        name: "cron with tz",
        enabled: true,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronTz({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    const jobs = readJobs(tmp.storePath) as Array<{
      id: string;
      schedule: { kind: string; expr: string; tz?: string; staggerMs?: number };
    }>;
    expect(jobs).toHaveLength(1);
    const sched = jobs[0]?.schedule;
    expect(sched?.kind).toBe("cron");
    expect(sched?.expr).toBe("0 9 * * *");
    expect(sched?.tz).toBeUndefined();
    expect(sched?.staggerMs).toBeUndefined();

    // Archive must exist.
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("tz-migrated"))).toHaveLength(1);
  });

  it("fix mode: kind:cron with only staggerMs (no tz) → staggerMs stripped", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-cron-stagger",
        name: "cron with staggerMs only",
        enabled: true,
        schedule: { kind: "cron", expr: "*/15 * * * *", staggerMs: 0 },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronTz({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    const jobs = readJobs(tmp.storePath) as Array<{
      id: string;
      schedule: { kind: string; expr: string; tz?: string; staggerMs?: number };
    }>;
    expect(jobs).toHaveLength(1);
    const sched = jobs[0]?.schedule;
    expect(sched?.kind).toBe("cron");
    expect(sched?.expr).toBe("*/15 * * * *");
    expect(sched?.tz).toBeUndefined();
    expect(sched?.staggerMs).toBeUndefined();
  });

  it("fix mode: cron-kind tz strip emits process-TZ warning note", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-cron-tz-warn",
        name: "cron tz warn",
        enabled: true,
        schedule: { kind: "cron", expr: "0 17 * * *", tz: "Asia/Shanghai" },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronTz({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    // The warning about process TZ must be emitted.
    const allNoteText = noteSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allNoteText).toContain("process TZ");
  });

  it("fix mode: stats counters — atMigrated and cronStripped tracked separately", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-at",
        name: "at with tz",
        enabled: true,
        schedule: { kind: "at", at: "2026-06-01T17:00:00", tz: "Asia/Shanghai" },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
      {
        id: "job-cron",
        name: "cron with tz",
        enabled: true,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronTz({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    const jobs = readJobs(tmp.storePath) as Array<{
      id: string;
      schedule: Record<string, unknown>;
    }>;
    expect(jobs).toHaveLength(2);

    // at job migrated to UTC.
    const atJob = jobs.find((j) => j.id === "job-at");
    expect(atJob?.schedule.tz).toBeUndefined();
    expect(typeof atJob?.schedule.at).toBe("string");
    expect(String(atJob?.schedule.at).endsWith("Z")).toBe(true);

    // cron job stripped.
    const cronJob = jobs.find((j) => j.id === "job-cron");
    expect(cronJob?.schedule.tz).toBeUndefined();
    expect(cronJob?.schedule.staggerMs).toBeUndefined();
    expect(cronJob?.schedule.expr).toBe("0 9 * * *");

    // Result note mentions both.
    const allNoteText = noteSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allNoteText).toContain("tz-aware at → UTC");
    expect(allNoteText).toContain("Stripped tz/staggerMs");
  });

  it("non-fix mode: kind:cron with tz emits preview note but does not mutate", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-cron-tz-preview",
        name: "cron tz preview",
        enabled: true,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);
    const beforeContent = fs.readFileSync(tmp.storePath, "utf-8");

    await maybeMigrateLegacyCronTz({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: false }),
    });

    expect(noteSpy).toHaveBeenCalled();
    expect(fs.readFileSync(tmp.storePath, "utf-8")).toBe(beforeContent);
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("tz-migrated"))).toHaveLength(0);
  });
});
