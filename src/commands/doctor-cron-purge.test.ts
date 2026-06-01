import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";
import { maybeRunCronPurgeSafeSubset } from "./doctor-cron-purge.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

const noteSpy = vi.mocked(note);

type TmpDir = { dir: string; storePath: string; runsDir: string };

function makeTmpCronDir(): TmpDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-cron-purge-"));
  const storePath = path.join(dir, "jobs.json");
  const runsDir = path.join(dir, "runs");
  return { dir, storePath, runsDir };
}

function writeJobs(storePath: string, jobs: unknown[]): void {
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, jobs }, null, 2));
}

function buildAtJob(id: string, fireAtMs: number, name = id): Record<string, unknown> {
  return {
    id,
    name,
    enabled: true,
    schedule: { kind: "at", at: new Date(fireAtMs).toISOString() },
    payload: { kind: "systemEvent", text: "hello" },
    createdAtMs: fireAtMs - 1000,
    updatedAtMs: fireAtMs - 1000,
    state: {},
  };
}

function touchOld(filePath: string, ageMs: number, nowMs: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x");
  const ts = (nowMs - ageMs) / 1000;
  fs.utimesSync(filePath, ts, ts);
}

function makePrompter(params: { shouldRepair: boolean; confirmResult?: boolean }): DoctorPrompter {
  const confirmResult = params.confirmResult ?? false;
  return {
    confirm: vi.fn(async () => confirmResult),
    confirmAutoFix: vi.fn(async () => confirmResult),
    confirmAggressiveAutoFix: vi.fn(async () => confirmResult),
    confirmRuntimeRepair: vi.fn(async () => confirmResult),
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

const NOW = Date.parse("2026-05-27T12:00:00Z");

describe("maybeRunCronPurgeSafeSubset", () => {
  let tmp: TmpDir | undefined;

  beforeEach(() => {
    tmp = makeTmpCronDir();
    noteSpy.mockReset();
  });

  afterEach(() => {
    if (tmp && fs.existsSync(tmp.dir)) {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
    tmp = undefined;
    vi.restoreAllMocks();
  });

  it("gateway-up branch: surfaces a single informational note and mutates nothing", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    const expiredFireAt = NOW - 8 * 86_400_000;
    writeJobs(tmp.storePath, [buildAtJob("expired-1", expiredFireAt, "old")]);
    const oldFile = path.join(tmp.runsDir, "zz.jsonl");
    touchOld(oldFile, 30 * 86_400_000, NOW);
    const beforeStoreMtime = fs.statSync(tmp.storePath).mtimeMs;

    await maybeRunCronPurgeSafeSubset({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: true }),
      deps: { storePath: tmp.storePath, nowMs: NOW, probeGatewayUp: async () => true },
    });

    expect(noteSpy).toHaveBeenCalledTimes(1);
    expect(noteSpy.mock.calls[0]?.[0]).toMatch(/gateway is currently running/);
    expect(fs.statSync(tmp.storePath).mtimeMs).toBe(beforeStoreMtime);
    expect(fs.existsSync(oldFile)).toBe(true);
    const archives = fs.readdirSync(tmp.dir).filter((name) => name.includes(".purged-"));
    expect(archives).toHaveLength(0);
  });

  it("empty findings branch: prints a clean note and skips confirm", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    writeJobs(tmp.storePath, []);
    fs.mkdirSync(tmp.runsDir, { recursive: true });
    const prompter = makePrompter({ shouldRepair: false });

    await maybeRunCronPurgeSafeSubset({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter,
      deps: { storePath: tmp.storePath, nowMs: NOW, probeGatewayUp: async () => false },
    });

    expect(noteSpy).toHaveBeenCalledTimes(1);
    expect(noteSpy.mock.calls[0]?.[0]).toMatch(/clean/);
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("findings + shouldRepair=true: archives, removes zombies and expired jobs, surfaces summary", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    const expiredFireAt = NOW - 8 * 86_400_000;
    const futureFireAt = NOW + 1 * 86_400_000;
    writeJobs(tmp.storePath, [
      buildAtJob("expired-1", expiredFireAt, "old"),
      buildAtJob("future-1", futureFireAt, "soon"),
    ]);
    const oldFile = path.join(tmp.runsDir, "abc.jsonl");
    touchOld(oldFile, 30 * 86_400_000, NOW);
    const prompter = makePrompter({ shouldRepair: true });

    await maybeRunCronPurgeSafeSubset({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter,
      deps: { storePath: tmp.storePath, nowMs: NOW, probeGatewayUp: async () => false },
    });

    // Confirm is never called when shouldRepair=true.
    expect(prompter.confirm).not.toHaveBeenCalled();
    // Two notes: preview + post-fix summary.
    expect(noteSpy).toHaveBeenCalledTimes(2);
    expect(noteSpy.mock.calls[0]?.[0]).toMatch(/would clean leaked entries/);
    expect(noteSpy.mock.calls[1]?.[0]).toMatch(/Removed/);

    expect(fs.existsSync(oldFile)).toBe(false);
    const reloaded = JSON.parse(fs.readFileSync(tmp.storePath, "utf-8")) as {
      jobs: { id: string }[];
    };
    expect(reloaded.jobs.map((job) => job.id)).toEqual(["future-1"]);
    const archives = fs.readdirSync(tmp.dir).filter((name) => name.includes(".purged-"));
    expect(archives).toHaveLength(1);
  });

  it("findings + non-fix + confirm=no: zero mutation, manual hint surfaced", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    const expiredFireAt = NOW - 8 * 86_400_000;
    writeJobs(tmp.storePath, [buildAtJob("expired-1", expiredFireAt, "old")]);
    const oldFile = path.join(tmp.runsDir, "abc.jsonl");
    touchOld(oldFile, 30 * 86_400_000, NOW);
    const beforeStoreMtime = fs.statSync(tmp.storePath).mtimeMs;
    const prompter = makePrompter({ shouldRepair: false, confirmResult: false });

    await maybeRunCronPurgeSafeSubset({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter,
      deps: { storePath: tmp.storePath, nowMs: NOW, probeGatewayUp: async () => false },
    });

    expect(prompter.confirm).toHaveBeenCalledTimes(1);
    expect(noteSpy).toHaveBeenCalledTimes(2);
    expect(noteSpy.mock.calls[0]?.[0]).toMatch(/would clean leaked entries/);
    expect(noteSpy.mock.calls[1]?.[0]).toMatch(/Manual cleanup:.*cron purge --zombies --expired/);
    expect(fs.existsSync(oldFile)).toBe(true);
    expect(fs.statSync(tmp.storePath).mtimeMs).toBe(beforeStoreMtime);
    const archives = fs.readdirSync(tmp.dir).filter((name) => name.includes(".purged-"));
    expect(archives).toHaveLength(0);
  });

  it("findings + non-fix + confirm=yes: mutates and surfaces summary", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    const expiredFireAt = NOW - 8 * 86_400_000;
    writeJobs(tmp.storePath, [buildAtJob("expired-1", expiredFireAt, "old")]);
    const oldFile = path.join(tmp.runsDir, "abc.jsonl");
    touchOld(oldFile, 30 * 86_400_000, NOW);
    const prompter = makePrompter({ shouldRepair: false, confirmResult: true });

    await maybeRunCronPurgeSafeSubset({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter,
      deps: { storePath: tmp.storePath, nowMs: NOW, probeGatewayUp: async () => false },
    });

    expect(prompter.confirm).toHaveBeenCalledTimes(1);
    expect(noteSpy).toHaveBeenCalledTimes(2);
    expect(noteSpy.mock.calls[1]?.[0]).toMatch(/Removed/);
    expect(fs.existsSync(oldFile)).toBe(false);
    const reloaded = JSON.parse(fs.readFileSync(tmp.storePath, "utf-8")) as {
      jobs: { id: string }[];
    };
    expect(reloaded.jobs).toEqual([]);
  });

  it("deferred classifiers surface as info but do not prompt or error", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    // No actionable findings; only deferred classifiers should show as info.
    writeJobs(tmp.storePath, []);
    fs.mkdirSync(tmp.runsDir, { recursive: true });
    const prompter = makePrompter({ shouldRepair: false });

    await maybeRunCronPurgeSafeSubset({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter,
      deps: { storePath: tmp.storePath, nowMs: NOW, probeGatewayUp: async () => false },
    });

    // Empty findings: the preview note is "clean", confirm is never called.
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(noteSpy).toHaveBeenCalledTimes(1);
    expect(noteSpy.mock.calls[0]?.[0]).toMatch(/clean/);

    // With findings: preview should mention deferred classifiers.
    noteSpy.mockReset();
    const oldFile = path.join(tmp.runsDir, "z.jsonl");
    touchOld(oldFile, 30 * 86_400_000, NOW);
    await maybeRunCronPurgeSafeSubset({
      cfg: makeCfg(tmp.storePath),
      options: makeOptions(),
      prompter: makePrompter({ shouldRepair: false, confirmResult: false }),
      deps: { storePath: tmp.storePath, nowMs: NOW, probeGatewayUp: async () => false },
    });
    const previewBody = noteSpy.mock.calls[0]?.[0];
    expect(typeof previewBody === "string" ? previewBody : "").toMatch(
      /orphaned classifier: deferred/,
    );
    expect(typeof previewBody === "string" ? previewBody : "").toMatch(
      /stale-running classifier: deferred/,
    );
  });
});
