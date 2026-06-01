import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";
import { maybeMigrateLegacyCronEveryKind } from "./doctor-cron-every-migration.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

const noteSpy = vi.mocked(note);

type TmpDir = { dir: string; storePath: string };

function makeTmpCronDir(): TmpDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-cron-every-migration-"));
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

describe("maybeMigrateLegacyCronEveryKind", () => {
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

  // Test 1: No-op
  it("no-op when store has no kind:every jobs", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-cron",
        name: "normal cron",
        enabled: true,
        schedule: { kind: "cron", expr: "0 9 * * *" },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronEveryKind({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    expect(noteSpy).not.toHaveBeenCalled();
    // File unchanged.
    const jobs = readJobs(tmp.storePath) as Array<{ schedule: { kind: string } }>;
    expect(jobs[0]?.schedule.kind).toBe("cron");
  });

  // Test 2: Convertible hourly
  it("fix mode: convertible hourly everyMs:3600000 with anchor minute → expr with anchor", async () => {
    tmp = makeTmpCronDir();
    // anchorMs: some date where minutes=26
    const anchorDate = new Date("2025-01-01T10:26:00.000Z");
    writeJobs(tmp.storePath, [
      {
        id: "job-hourly",
        name: "hourly",
        enabled: true,
        schedule: { kind: "every", everyMs: 3_600_000, anchorMs: anchorDate.getTime() },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronEveryKind({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    const jobs = readJobs(tmp.storePath) as Array<{
      id: string;
      schedule: { kind: string; expr?: string; everyMs?: number; anchorMs?: number };
    }>;
    expect(jobs).toHaveLength(1);
    const sched = jobs[0]?.schedule;
    expect(sched?.kind).toBe("cron");
    // Anchor minute=26 in local TZ. The expr should be "26 * * * *".
    expect(sched?.expr).toBe(`${anchorDate.getMinutes()} * * * *`);
    expect(sched?.everyMs).toBeUndefined();
    expect(sched?.anchorMs).toBeUndefined();

    // Archive must exist.
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("every-migrated"))).toHaveLength(1);

    // Stats: examined=1, converted=1.
    const changeNote = noteSpy.mock.calls.find((c) => String(c[0]).includes("Converted"));
    expect(changeNote).toBeDefined();
    expect(String(changeNote?.[0])).toContain("1 kind:every job(s)");
  });

  // Test 3: Convertible 15-min
  it("fix mode: convertible 15-min everyMs:900000 → expr:*/15 * * * *", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-15min",
        name: "15 min",
        enabled: true,
        schedule: { kind: "every", everyMs: 900_000 },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronEveryKind({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    const jobs = readJobs(tmp.storePath) as Array<{
      schedule: { kind: string; expr?: string };
    }>;
    expect(jobs[0]?.schedule.kind).toBe("cron");
    expect(jobs[0]?.schedule.expr).toBe("*/15 * * * *");
  });

  // Test 4: Convertible daily
  it("fix mode: convertible daily everyMs:86400000 with anchor → expr with anchor hour/min", async () => {
    tmp = makeTmpCronDir();
    // Anchor at 2025-01-01T02:30:00.000Z; local interpretation depends on process TZ.
    const anchorDate = new Date("2025-01-01T02:30:00.000Z");
    writeJobs(tmp.storePath, [
      {
        id: "job-daily",
        name: "daily",
        enabled: true,
        schedule: { kind: "every", everyMs: 86_400_000, anchorMs: anchorDate.getTime() },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronEveryKind({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    const jobs = readJobs(tmp.storePath) as Array<{
      schedule: { kind: string; expr?: string };
    }>;
    expect(jobs[0]?.schedule.kind).toBe("cron");
    // The expr should be "<min> <hour> * * *" based on the local TZ interpretation of anchorDate.
    const expectedExpr = `${anchorDate.getMinutes()} ${anchorDate.getHours()} * * *`;
    expect(jobs[0]?.schedule.expr).toBe(expectedExpr);
  });

  // Test 5: Unmigratable 7-min
  it("unmigratable: everyMs:420000 (7 min, not clean divisor of 60)", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-7min",
        name: "7 min",
        enabled: true,
        schedule: { kind: "every", everyMs: 420_000 },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);
    const beforeContent = fs.readFileSync(tmp.storePath, "utf-8");

    await maybeMigrateLegacyCronEveryKind({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    // Job left alone.
    expect(fs.readFileSync(tmp.storePath, "utf-8")).toBe(beforeContent);

    // No archive created (nothing converted).
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("every-migrated"))).toHaveLength(0);

    // Preview note emitted with unmigratable reason.
    expect(noteSpy).toHaveBeenCalled();
    const allNoteText = noteSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allNoteText).toContain("unmigratable");
  });

  // Test 6: Unmigratable sub-minute
  it("unmigratable: everyMs:5000 (sub-minute)", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-5sec",
        name: "5 sec",
        enabled: true,
        schedule: { kind: "every", everyMs: 5_000 },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);
    const beforeContent = fs.readFileSync(tmp.storePath, "utf-8");

    await maybeMigrateLegacyCronEveryKind({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    expect(fs.readFileSync(tmp.storePath, "utf-8")).toBe(beforeContent);
    expect(noteSpy).toHaveBeenCalled();
    const allNoteText = noteSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allNoteText).toContain("below 1 minute");
  });

  // Test 7: Missing anchor defaults to 0
  it("fix mode: missing anchor → defaults to minute=0, expr:0 * * * * for hourly", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-hourly-no-anchor",
        name: "hourly no anchor",
        enabled: true,
        schedule: { kind: "every", everyMs: 3_600_000 },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronEveryKind({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    const jobs = readJobs(tmp.storePath) as Array<{
      schedule: { kind: string; expr?: string };
    }>;
    expect(jobs[0]?.schedule.kind).toBe("cron");
    // No anchor → anchorMinute defaults to 0.
    expect(jobs[0]?.schedule.expr).toBe("0 * * * *");
  });

  // Test 8: Non-fix mode → preview only, no mutation, no archive
  it("non-fix mode: emits preview note but does not mutate or archive", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-every-preview",
        name: "every preview",
        enabled: true,
        schedule: { kind: "every", everyMs: 3_600_000 },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);
    const beforeContent = fs.readFileSync(tmp.storePath, "utf-8");

    await maybeMigrateLegacyCronEveryKind({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: false }),
    });

    expect(noteSpy).toHaveBeenCalled();
    expect(fs.readFileSync(tmp.storePath, "utf-8")).toBe(beforeContent);
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("every-migrated"))).toHaveLength(0);
  });

  // Test 9: Fix mode → mutation occurs; archive written
  it("fix mode: mutation occurs and archive is written", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-every-fix",
        name: "every fix",
        enabled: true,
        schedule: { kind: "every", everyMs: 900_000 },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);
    const beforeContent = fs.readFileSync(tmp.storePath, "utf-8");

    await maybeMigrateLegacyCronEveryKind({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    // File must be mutated.
    expect(fs.readFileSync(tmp.storePath, "utf-8")).not.toBe(beforeContent);

    // Archive must exist.
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("every-migrated"))).toHaveLength(1);

    // Job must be converted.
    const jobs = readJobs(tmp.storePath) as Array<{
      schedule: { kind: string; expr?: string };
    }>;
    expect(jobs[0]?.schedule.kind).toBe("cron");
  });

  // Additional: no-op when store file does not exist
  it("no-op when store file does not exist", async () => {
    tmp = makeTmpCronDir();
    // Do not write any file.

    await maybeMigrateLegacyCronEveryKind({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    expect(noteSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(tmp.storePath)).toBe(false);
  });

  // Additional: mixed convertible + unmigratable — only convertible ones get migrated
  it("fix mode: mixed convertible + unmigratable — only convertible are migrated", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-good",
        name: "good",
        enabled: true,
        schedule: { kind: "every", everyMs: 900_000 },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
      {
        id: "job-bad",
        name: "bad",
        enabled: true,
        schedule: { kind: "every", everyMs: 7_000 },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronEveryKind({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    const jobs = readJobs(tmp.storePath) as Array<{
      id: string;
      schedule: { kind: string; expr?: string; everyMs?: number };
    }>;
    expect(jobs).toHaveLength(2);

    const goodJob = jobs.find((j) => j.id === "job-good");
    expect(goodJob?.schedule.kind).toBe("cron");
    expect(goodJob?.schedule.expr).toBe("*/15 * * * *");

    const badJob = jobs.find((j) => j.id === "job-bad");
    expect(badJob?.schedule.kind).toBe("every");
    expect(badJob?.schedule.everyMs).toBe(7_000);

    // Archive must exist.
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("every-migrated"))).toHaveLength(1);
  });
});
