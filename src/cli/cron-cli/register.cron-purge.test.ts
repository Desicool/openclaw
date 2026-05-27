import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputRuntimeEnv } from "../../runtime.js";
import { runCronPurge } from "./register.cron-purge.js";

type Logs = { log: string[]; error: string[]; json: unknown[] };

function makeRuntime(): { runtime: OutputRuntimeEnv; logs: Logs } {
  const logs: Logs = { log: [], error: [], json: [] };
  const runtime: OutputRuntimeEnv = {
    log: (...args) => {
      logs.log.push(args.map((arg) => String(arg)).join(" "));
    },
    error: (...args) => {
      logs.error.push(args.map((arg) => String(arg)).join(" "));
    },
    writeStdout: (value) => {
      logs.log.push(value);
    },
    writeJson: (value) => {
      logs.json.push(value);
    },
    exit: (code) => {
      throw new Error(`exit ${String(code)}`);
    },
  };
  return { runtime, logs };
}

function makeTmpCronDir(): { dir: string; storePath: string; runsDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-purge-"));
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

const NOW = Date.parse("2026-05-27T12:00:00Z");

describe("cron purge", () => {
  let tmp: ReturnType<typeof makeTmpCronDir> | undefined;

  beforeEach(() => {
    tmp = makeTmpCronDir();
  });

  afterEach(() => {
    if (tmp && fs.existsSync(tmp.dir)) {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
    tmp = undefined;
    vi.restoreAllMocks();
  });

  it("refuses to mutate when gateway-up probe returns true", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    writeJobs(tmp.storePath, []);
    const { runtime } = makeRuntime();
    await expect(
      runCronPurge(
        {
          dryRun: false,
          orphaned: false,
          staleRunning: false,
          duplicates: false,
          zombies: true,
          expired: false,
          all: false,
          force: false,
          json: false,
        },
        {
          storePath: tmp.storePath,
          nowMs: NOW,
          probeGatewayUp: async () => true,
          runtime,
        },
      ),
    ).rejects.toThrow(/gateway is currently running/);
  });

  it("dry-run --zombies lists old run-artifact files and writes nothing", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    writeJobs(tmp.storePath, []);
    const oldFile = path.join(tmp.runsDir, "abc.jsonl");
    const oldNested = path.join(tmp.runsDir, "abc", "session-deadbeef.json");
    const youngFile = path.join(tmp.runsDir, "def.jsonl");
    touchOld(oldFile, 15 * 86_400_000, NOW);
    touchOld(oldNested, 20 * 86_400_000, NOW);
    touchOld(youngFile, 1 * 86_400_000, NOW);

    const { runtime, logs } = makeRuntime();
    await runCronPurge(
      {
        dryRun: true,
        orphaned: false,
        staleRunning: false,
        duplicates: false,
        zombies: true,
        expired: false,
        all: false,
        force: false,
        json: true,
      },
      {
        storePath: tmp.storePath,
        nowMs: NOW,
        probeGatewayUp: async () => false,
        runtime,
      },
    );

    expect(fs.existsSync(oldFile)).toBe(true);
    expect(fs.existsSync(oldNested)).toBe(true);
    expect(fs.existsSync(youngFile)).toBe(true);

    const report = logs.json[0] as { classifiers: { zombies: { files: { path: string }[] } } };
    const paths = report.classifiers.zombies.files.map((entry) => entry.path).toSorted();
    expect(paths).toEqual([oldFile, oldNested].toSorted());
  });

  it("--zombies (live) removes old files and creates no archive when jobs.json is unchanged", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    writeJobs(tmp.storePath, []);
    const stateBefore = JSON.stringify(fs.statSync(tmp.storePath).mtimeMs);
    const oldFile = path.join(tmp.runsDir, "abc.jsonl");
    const oldNested = path.join(tmp.runsDir, "abc", "session-deadbeef.json");
    touchOld(oldFile, 15 * 86_400_000, NOW);
    touchOld(oldNested, 20 * 86_400_000, NOW);

    const { runtime } = makeRuntime();
    await runCronPurge(
      {
        dryRun: false,
        orphaned: false,
        staleRunning: false,
        duplicates: false,
        zombies: true,
        expired: false,
        all: false,
        force: false,
        json: true,
      },
      {
        storePath: tmp.storePath,
        nowMs: NOW,
        probeGatewayUp: async () => false,
        runtime,
      },
    );

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(oldNested)).toBe(false);
    expect(fs.existsSync(path.dirname(oldNested))).toBe(false);
    expect(JSON.stringify(fs.statSync(tmp.storePath).mtimeMs)).toBe(stateBefore);
    const archives = fs.readdirSync(tmp.dir).filter((name) => name.includes(".purged-"));
    expect(archives).toHaveLength(0);
  });

  it("zombie rm partial failure throws and report reflects only files actually removed", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    writeJobs(tmp.storePath, []);
    // Names chosen so directory iteration order processes the OK file first,
    // then the failing one (a-ok < b-fail < c-skipped). The exact order of
    // readdirSync is not contractually sorted, but for fresh empty entries on
    // the common FS layouts it tracks creation order; alphabetic prefixes give
    // us a stable assertion either way.
    const okFile = path.join(tmp.runsDir, "a-ok.jsonl");
    const failingFile = path.join(tmp.runsDir, "b-fail.jsonl");
    const skippedFile = path.join(tmp.runsDir, "c-skipped.jsonl");
    touchOld(okFile, 15 * 86_400_000, NOW);
    touchOld(failingFile, 16 * 86_400_000, NOW);
    touchOld(skippedFile, 17 * 86_400_000, NOW);

    const realRmSync = fs.rmSync;
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(((
      p: fs.PathLike,
      options?: fs.RmOptions,
    ) => {
      if (typeof p === "string" && p === failingFile) {
        const err = new Error("EACCES: simulated") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return realRmSync(p, options);
    }) as typeof fs.rmSync);

    const { runtime } = makeRuntime();
    await expect(
      runCronPurge(
        {
          dryRun: false,
          orphaned: false,
          staleRunning: false,
          duplicates: false,
          zombies: true,
          expired: false,
          all: false,
          force: false,
          json: true,
        },
        {
          storePath: tmp.storePath,
          nowMs: NOW,
          probeGatewayUp: async () => false,
          runtime,
        },
      ),
    ).rejects.toThrow(/removed 1 of 3 zombie file\(s\) before failing on .*b-fail\.jsonl/);

    rmSpy.mockRestore();
    // The first file should be gone, the failing and later files still on disk.
    expect(fs.existsSync(okFile)).toBe(false);
    expect(fs.existsSync(failingFile)).toBe(true);
    expect(fs.existsSync(skippedFile)).toBe(true);
  });

  it("--expired removes one-shot jobs older than 7 days and archives jobs.json", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    const expiredFireAt = NOW - 8 * 86_400_000;
    const futureFireAt = NOW + 1 * 86_400_000;
    writeJobs(tmp.storePath, [
      buildAtJob("expired-1", expiredFireAt, "old reminder"),
      buildAtJob("future-1", futureFireAt, "still pending"),
    ]);

    const { runtime } = makeRuntime();
    await runCronPurge(
      {
        dryRun: false,
        orphaned: false,
        staleRunning: false,
        duplicates: false,
        zombies: false,
        expired: true,
        all: false,
        force: false,
        json: true,
      },
      {
        storePath: tmp.storePath,
        nowMs: NOW,
        probeGatewayUp: async () => false,
        runtime,
      },
    );

    const reloaded = JSON.parse(fs.readFileSync(tmp.storePath, "utf-8")) as {
      jobs: { id: string }[];
    };
    expect(reloaded.jobs.map((job) => job.id)).toEqual(["future-1"]);

    const archives = fs.readdirSync(tmp.dir).filter((name) => name.includes(".purged-"));
    expect(archives).toHaveLength(1);
    const archive = archives[0];
    if (!archive) {
      throw new Error("archive missing");
    }
    expect(archive).toMatch(/^jobs\.json\.purged-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/);
    const archiveContents = JSON.parse(fs.readFileSync(path.join(tmp.dir, archive), "utf-8")) as {
      jobs: { id: string }[];
    };
    expect(archiveContents.jobs.map((job) => job.id).toSorted()).toEqual(["expired-1", "future-1"]);
  });

  it("--expired skips at-jobs that are currently running", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    const expiredFireAt = NOW - 8 * 86_400_000;
    const job = buildAtJob("running-old", expiredFireAt, "stuck");
    (job.state as Record<string, unknown>).runningAtMs = NOW - 60_000;
    writeJobs(tmp.storePath, [job]);

    const { runtime } = makeRuntime();
    await runCronPurge(
      {
        dryRun: false,
        orphaned: false,
        staleRunning: false,
        duplicates: false,
        zombies: false,
        expired: true,
        all: false,
        force: false,
        json: true,
      },
      {
        storePath: tmp.storePath,
        nowMs: NOW,
        probeGatewayUp: async () => false,
        runtime,
      },
    );

    const reloaded = JSON.parse(fs.readFileSync(tmp.storePath, "utf-8")) as {
      jobs: { id: string }[];
    };
    expect(reloaded.jobs.map((job_) => job_.id)).toEqual(["running-old"]);
  });

  it("--all --dry-run lists zombies and expired jobs together", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    const expiredFireAt = NOW - 8 * 86_400_000;
    writeJobs(tmp.storePath, [buildAtJob("expired-2", expiredFireAt, "old")]);
    const oldFile = path.join(tmp.runsDir, "zz.jsonl");
    touchOld(oldFile, 30 * 86_400_000, NOW);

    const { runtime, logs } = makeRuntime();
    await runCronPurge(
      {
        dryRun: true,
        orphaned: false,
        staleRunning: false,
        duplicates: false,
        zombies: false,
        expired: false,
        all: true,
        force: false,
        json: true,
      },
      {
        storePath: tmp.storePath,
        nowMs: NOW,
        probeGatewayUp: async () => false,
        runtime,
      },
    );

    expect(fs.existsSync(oldFile)).toBe(true);
    const report = logs.json[0] as {
      classifiers: {
        orphaned: { status: string };
        staleRunning: { status: string };
        duplicates: { status: string };
        zombies: { files: { path: string }[] };
        expired: { jobs: { id: string }[] };
      };
    };
    expect(report.classifiers.zombies.files.map((entry) => entry.path)).toEqual([oldFile]);
    expect(report.classifiers.expired.jobs.map((entry) => entry.id)).toEqual(["expired-2"]);
    expect(report.classifiers.orphaned.status).toBe("deferred");
    expect(report.classifiers.staleRunning.status).toBe("deferred");
    expect(report.classifiers.duplicates.status).toBe("deferred");
  });

  it("rejects when no classifier flag is provided", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    writeJobs(tmp.storePath, []);
    const { runtime } = makeRuntime();
    await expect(
      runCronPurge(
        {
          dryRun: false,
          orphaned: false,
          staleRunning: false,
          duplicates: false,
          zombies: false,
          expired: false,
          all: false,
          force: false,
          json: false,
        },
        {
          storePath: tmp.storePath,
          nowMs: NOW,
          probeGatewayUp: async () => false,
          runtime,
        },
      ),
    ).rejects.toThrow(/specify at least one classifier flag/);
  });

  it("archive naming uses second-precision UTC and tie-breaks rapid re-runs", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    const expiredFireAt = NOW - 8 * 86_400_000;
    writeJobs(tmp.storePath, [
      buildAtJob("expired-a", expiredFireAt, "one"),
      buildAtJob("expired-b", expiredFireAt, "two"),
    ]);

    const { runtime } = makeRuntime();
    // First run removes expired-a only by feeding a curated single-id store.
    // Simpler: run twice with the same now; second run will be a no-op because
    // store is empty, so simulate collision by pre-creating the archive file.
    const stamp = new Date(NOW)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z")
      .replace(/:/g, "-");
    const collisionPath = path.join(tmp.dir, `jobs.json.purged-${stamp}.json`);
    fs.writeFileSync(collisionPath, "{}");

    await runCronPurge(
      {
        dryRun: false,
        orphaned: false,
        staleRunning: false,
        duplicates: false,
        zombies: false,
        expired: true,
        all: false,
        force: false,
        json: true,
      },
      {
        storePath: tmp.storePath,
        nowMs: NOW,
        probeGatewayUp: async () => false,
        runtime,
      },
    );

    const archives = fs.readdirSync(tmp.dir).filter((name) => name.startsWith("jobs.json.purged-"));
    expect(archives).toHaveLength(2);
    expect(archives).toContain(`jobs.json.purged-${stamp}.json`);
    const tieBreaker = archives.find((name) => name.includes("-001"));
    expect(tieBreaker).toMatch(
      new RegExp(`^jobs\\.json\\.purged-${stamp.replace(/[-Z]/g, (m) => `\\${m}`)}-\\d{3}\\.json$`),
    );
  });

  it("orphaned/stale-running/duplicates report deferred and remove nothing", async () => {
    if (!tmp) {
      throw new Error("tmp missing");
    }
    writeJobs(tmp.storePath, [buildAtJob("future-1", NOW + 86_400_000, "soon")]);
    const oldFile = path.join(tmp.runsDir, "zz.jsonl");
    touchOld(oldFile, 30 * 86_400_000, NOW);

    const { runtime, logs } = makeRuntime();
    await runCronPurge(
      {
        dryRun: false,
        orphaned: true,
        staleRunning: true,
        duplicates: true,
        zombies: false,
        expired: false,
        all: false,
        force: true,
        json: true,
      },
      {
        storePath: tmp.storePath,
        nowMs: NOW,
        probeGatewayUp: async () => false,
        runtime,
      },
    );

    expect(fs.existsSync(oldFile)).toBe(true);
    expect(fs.readFileSync(tmp.storePath, "utf-8")).toContain("future-1");
    const archives = fs.readdirSync(tmp.dir).filter((name) => name.includes(".purged-"));
    expect(archives).toHaveLength(0);
    const report = logs.json[0] as {
      classifiers: {
        orphaned: { status: string };
        staleRunning: { status: string };
        duplicates: { status: string };
        zombies: unknown;
        expired: unknown;
      };
    };
    expect(report.classifiers.orphaned.status).toBe("deferred");
    expect(report.classifiers.staleRunning.status).toBe("deferred");
    expect(report.classifiers.duplicates.status).toBe("deferred");
    expect(report.classifiers.zombies).toBeNull();
    expect(report.classifiers.expired).toBeNull();
  });

  it("help text mentions every flag and the --force note", async () => {
    const { Command } = await import("commander");
    const { registerCronPurgeCommand } = await import("./register.cron-purge.js");
    const program = new Command();
    program.exitOverride();
    registerCronPurgeCommand(program);
    const purgeCmd = program.commands.find((cmd) => cmd.name() === "purge");
    const help = purgeCmd?.helpInformation() ?? "";
    expect(help).toContain("--dry-run");
    expect(help).toContain("--orphaned");
    expect(help).toContain("--stale-running");
    expect(help).toContain("--duplicates");
    expect(help).toContain("--zombies");
    expect(help).toContain("--expired");
    expect(help).toContain("--all");
    expect(help).toContain("--force");
    expect(help).toContain("--json");
    const normalized = help.replace(/\s+/g, " ");
    expect(normalized).toMatch(/Required to remove duplicates.*not required for zombies\/expired/);
  });
});
