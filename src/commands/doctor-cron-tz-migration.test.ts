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

  it("kind:cron job with tz field is ignored (not counted)", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      {
        id: "job-cron-tz",
        name: "cron with tz",
        enabled: true,
        // kind:cron shouldn't normally have a tz field post-schema change,
        // but if present it must be ignored by this migration.
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/New_York" },
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);

    await maybeMigrateLegacyCronTz({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    // No note, no archive, no mutation.
    expect(noteSpy).not.toHaveBeenCalled();
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("tz-migrated"))).toHaveLength(0);
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
});
