import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";
import { maybeMigrateLegacyCronSessionTargets } from "./doctor-cron-target-migration.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

const noteSpy = vi.mocked(note);

type TmpDir = { dir: string; storePath: string };

function makeTmpCronDir(): TmpDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-cron-target-migration-"));
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

function makeIsolatedJob(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    enabled: true,
    sessionTarget: "isolated",
    schedule: { kind: "at", at: "2026-06-01T09:00:00.000Z" },
    payload: { kind: "agentTurn", message: "test" },
    createdAtMs: 1_000_000,
    updatedAtMs: 1_000_000,
    state: {},
  };
}

function makeNonIsolatedJob(id: string, sessionTarget: string): Record<string, unknown> {
  return {
    id,
    name: id,
    enabled: true,
    sessionTarget,
    schedule: { kind: "cron", expr: "* * * * *" },
    payload: { kind: "agentTurn", message: "test" },
    createdAtMs: 1_000_000,
    updatedAtMs: 1_000_000,
    state: {},
  };
}

describe("maybeMigrateLegacyCronSessionTargets", () => {
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

  it("no-op when store has only isolated jobs", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [makeIsolatedJob("job-a"), makeIsolatedJob("job-b")]);

    await maybeMigrateLegacyCronSessionTargets({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: false }),
    });

    expect(noteSpy).not.toHaveBeenCalled();
    const jobs = readJobs(tmp.storePath) as Array<{ sessionTarget: unknown }>;
    expect(jobs.every((j) => j.sessionTarget === "isolated")).toBe(true);
  });

  it("no-op when store file does not exist", async () => {
    tmp = makeTmpCronDir();
    // Do not write any file.

    await maybeMigrateLegacyCronSessionTargets({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    expect(noteSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(tmp.storePath)).toBe(false);
  });

  it("non-fix mode: emits preview note but does not mutate or archive", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [makeNonIsolatedJob("job-main", "main")]);
    const beforeContent = fs.readFileSync(tmp.storePath, "utf-8");

    await maybeMigrateLegacyCronSessionTargets({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: false }),
    });

    expect(noteSpy).toHaveBeenCalledOnce();
    const noteArg = noteSpy.mock.calls[0]?.[0] ?? "";
    expect(noteArg).toContain("non-isolated sessionTarget");
    expect(noteArg).toContain("job-main");
    // File must not be mutated.
    expect(fs.readFileSync(tmp.storePath, "utf-8")).toBe(beforeContent);
    // No archive created.
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("target-migrated"))).toHaveLength(0);
  });

  it("fix mode: archives jobs.json and rewrites all non-isolated targets", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      makeIsolatedJob("job-already-isolated"),
      makeNonIsolatedJob("job-main", "main"),
    ]);

    await maybeMigrateLegacyCronSessionTargets({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    // Archive must exist.
    const files = fs.readdirSync(tmp.dir);
    const archive = files.find((f) => f.includes("target-migrated"));
    expect(archive).toBeDefined();

    // Rewritten jobs.json: all jobs have sessionTarget "isolated".
    const jobs = readJobs(tmp.storePath) as Array<{ id: string; sessionTarget: unknown }>;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.sessionTarget === "isolated")).toBe(true);

    // Doctor changes note was emitted.
    const notes = noteSpy.mock.calls.map((c) => String(c[0]));
    expect(notes.some((n) => n.includes("Migrated"))).toBe(true);
  });

  it("mixed: 2 isolated + 1 main + 1 session:abc → exactly 2 migrated, archive written", async () => {
    tmp = makeTmpCronDir();
    writeJobs(tmp.storePath, [
      makeIsolatedJob("job-iso-1"),
      makeIsolatedJob("job-iso-2"),
      makeNonIsolatedJob("job-main", "main"),
      makeNonIsolatedJob("job-session", "session:abc"),
    ]);

    await maybeMigrateLegacyCronSessionTargets({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
    });

    // Exactly 2 jobs were migrated.
    const changeNote = noteSpy.mock.calls.find((c) => String(c[0]).includes("Migrated"));
    expect(changeNote).toBeDefined();
    expect(String(changeNote?.[0])).toContain("2 job(s)");

    // All 4 jobs now have sessionTarget "isolated".
    const jobs = readJobs(tmp.storePath) as Array<{ id: string; sessionTarget: unknown }>;
    expect(jobs).toHaveLength(4);
    expect(jobs.every((j) => j.sessionTarget === "isolated")).toBe(true);

    // Archive was written.
    const files = fs.readdirSync(tmp.dir);
    expect(files.filter((f) => f.includes("target-migrated"))).toHaveLength(1);
  });
});
