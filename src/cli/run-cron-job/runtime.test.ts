import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronRunnerResultFile } from "../../cron/runner-protocol.js";
import {
  CRON_RUNNER_STDOUT_MARKER_PREFIX,
  formatStdoutMarkerLine,
} from "../../cron/runner-protocol.js";
import { assertCronRunnerContext, emitStdoutMarker, writeRunnerResultFile } from "./runtime.js";

// ── assertCronRunnerContext ───────────────────────────────────────────────────

describe("assertCronRunnerContext", () => {
  const originalEnv = process.env.OPENCLAW_CRON_RUNNER;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_CRON_RUNNER;
    } else {
      process.env.OPENCLAW_CRON_RUNNER = originalEnv;
    }
  });

  it("throws when OPENCLAW_CRON_RUNNER is not set", () => {
    delete process.env.OPENCLAW_CRON_RUNNER;
    expect(() => assertCronRunnerContext()).toThrow("cron runner subprocess");
  });

  it("throws when OPENCLAW_CRON_RUNNER is set to a value other than '1'", () => {
    process.env.OPENCLAW_CRON_RUNNER = "0";
    expect(() => assertCronRunnerContext()).toThrow("cron runner subprocess");
  });

  it("does not throw when OPENCLAW_CRON_RUNNER=1", () => {
    process.env.OPENCLAW_CRON_RUNNER = "1";
    expect(() => assertCronRunnerContext()).not.toThrow();
  });
});

// ── writeRunnerResultFile ─────────────────────────────────────────────────────

describe("writeRunnerResultFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-runner-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes the file at the expected relative path under runsDir", async () => {
    const { resultFilePath } = await writeRunnerResultFile(
      {
        jobId: "job-1",
        runId: "run-abc",
        startedAtMs: 1000,
        endedAtMs: 2000,
        status: "ok",
      },
      { runsDir: tmpDir },
    );
    expect(resultFilePath).toBe(path.join(tmpDir, "job-1", "run-abc.result.json"));
    const exists = await fs
      .access(resultFilePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("written file content matches the schema and input values", async () => {
    const { resultFilePath } = await writeRunnerResultFile(
      {
        jobId: "job-2",
        runId: "run-xyz",
        startedAtMs: 5000,
        endedAtMs: 6000,
        status: "error",
        error: "something went wrong",
      },
      { runsDir: tmpDir },
    );
    const raw = await fs.readFile(resultFilePath, "utf-8");
    const parsed = JSON.parse(raw) as CronRunnerResultFile;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.runId).toBe("run-xyz");
    expect(parsed.jobId).toBe("job-2");
    expect(parsed.status).toBe("error");
    expect(parsed.startedAtMs).toBe(5000);
    expect(parsed.endedAtMs).toBe(6000);
    expect(parsed.error).toBe("something went wrong");
  });

  it("creates parent directories if missing", async () => {
    const nestedDir = path.join(tmpDir, "deep", "nested");
    const { resultFilePath } = await writeRunnerResultFile(
      {
        jobId: "job-3",
        runId: "run-nested",
        startedAtMs: 0,
        endedAtMs: 1,
        status: "ok",
      },
      { runsDir: nestedDir },
    );
    const exists = await fs
      .access(resultFilePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("throws on schema-invalid input (negative startedAtMs)", async () => {
    await expect(
      writeRunnerResultFile(
        {
          jobId: "job-4",
          runId: "run-invalid",
          startedAtMs: -1,
          endedAtMs: 100,
          status: "ok",
        },
        { runsDir: tmpDir },
      ),
    ).rejects.toThrow(/schema validation/);
  });
});

// ── emitStdoutMarker ──────────────────────────────────────────────────────────

describe("emitStdoutMarker", () => {
  it("writes the exact expected marker line to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      emitStdoutMarker({ runId: "run-marker", status: "ok", durationMs: 42 });
      expect(spy).toHaveBeenCalledTimes(1);
      const written = spy.mock.calls[0]?.[0];
      const expected = formatStdoutMarkerLine({
        runId: "run-marker",
        status: "ok",
        durationMs: 42,
      });
      expect(written).toBe(expected);
      expect(
        typeof written === "string" && written.startsWith(CRON_RUNNER_STDOUT_MARKER_PREFIX),
      ).toBe(true);
      expect(typeof written === "string" && written.endsWith("\n")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
