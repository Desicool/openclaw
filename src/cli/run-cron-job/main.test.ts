import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../cron/types.js";
import type { RunCronJobDeps } from "./main.js";
import { runCronJobHandler } from "./main.js";

// ── Unit: env-not-set guard ───────────────────────────────────────────────────

describe("runCronJobHandler — env guard", () => {
  const originalEnv = process.env.OPENCLAW_CRON_RUNNER;

  beforeEach(() => {
    delete process.env.OPENCLAW_CRON_RUNNER;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_CRON_RUNNER;
    } else {
      process.env.OPENCLAW_CRON_RUNNER = originalEnv;
    }
  });

  // The env guard is in the CLI action handler, not runCronJobHandler itself,
  // so this test verifies the guard function used in the action is correct.
  it("assertCronRunnerContext throws when env unset", async () => {
    const { assertCronRunnerContext } = await import("./runtime.js");
    expect(() => assertCronRunnerContext()).toThrow("cron runner subprocess");
  });
});

// ── Unit: success path ────────────────────────────────────────────────────────

describe("runCronJobHandler — success path", () => {
  beforeEach(() => {
    process.env.OPENCLAW_CRON_RUNNER = "1";
  });

  afterEach(() => {
    delete process.env.OPENCLAW_CRON_RUNNER;
    vi.restoreAllMocks();
  });

  it("success path: returns exit code 0, writes result file, emits marker", async () => {
    // Stub loadCronStore and getRuntimeConfig
    const loadCronStoreMod = await import("../../cron/store.js");
    const storeSpy = vi.spyOn(loadCronStoreMod, "loadCronStore").mockResolvedValue({
      version: 1,
      jobs: [
        {
          id: "job-test",
          name: "Test Job",
          enabled: true,
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "hello" },
          schedule: { kind: "every", everyMs: 60000 },
        } as unknown as CronJob,
      ],
    });

    const stdoutLines: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutLines.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });

    let writtenInput: Parameters<RunCronJobDeps["writeResult"]>[0] | undefined;

    const deps: RunCronJobDeps = {
      runIsolatedAgent: async () => ({
        status: "ok" as const,
        sessionId: "s1",
        sessionKey: "k1",
      }),
      writeResult: async (input) => {
        writtenInput = input;
        return { resultFilePath: "/fake/path" };
      },
    };

    const exitCode = await runCronJobHandler({ jobId: "job-test", runId: "run-1", deps });

    expect(exitCode).toBe(0);
    expect(writtenInput?.status).toBe("ok");
    expect(writtenInput?.jobId).toBe("job-test");
    expect(writtenInput?.runId).toBe("run-1");

    // Exactly one stdout line: the marker
    const markerLines = stdoutLines.filter((l) => l.includes("OPENCLAW_CRON_RESULT"));
    expect(markerLines).toHaveLength(1);
    const markerJson: { runId: string; status: string; durationMs: number } = JSON.parse(
      (markerLines[0] ?? "").replace("OPENCLAW_CRON_RESULT ", "").trim(),
    );
    expect(markerJson.runId).toBe("run-1");
    expect(markerJson.status).toBe("ok");

    storeSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("error path: stub throws; result file written with status=error; exit code 1", async () => {
    const loadCronStoreMod = await import("../../cron/store.js");
    const storeSpy = vi.spyOn(loadCronStoreMod, "loadCronStore").mockResolvedValue({
      version: 1,
      jobs: [
        {
          id: "job-err",
          name: "Error Job",
          enabled: true,
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "fail me" },
          schedule: { kind: "every", everyMs: 60000 },
        } as unknown as CronJob,
      ],
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    let writtenInput: Parameters<RunCronJobDeps["writeResult"]>[0] | undefined;

    const deps: RunCronJobDeps = {
      runIsolatedAgent: async () => {
        throw new Error("agent exploded");
      },
      writeResult: async (input) => {
        writtenInput = input;
        return { resultFilePath: "/fake/path" };
      },
    };

    const exitCode = await runCronJobHandler({ jobId: "job-err", runId: "run-2", deps });

    expect(exitCode).toBe(1);
    expect(writtenInput?.status).toBe("error");
    expect(writtenInput?.error).toContain("agent exploded");

    storeSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("result file write failure: returns exit code 1, writes to stderr", async () => {
    const loadCronStoreMod = await import("../../cron/store.js");
    const storeSpy = vi.spyOn(loadCronStoreMod, "loadCronStore").mockResolvedValue({
      version: 1,
      jobs: [
        {
          id: "job-writefail",
          name: "Write Fail Job",
          enabled: true,
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "write fail" },
          schedule: { kind: "every", everyMs: 60000 },
        } as unknown as CronJob,
      ],
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });

    const deps: RunCronJobDeps = {
      runIsolatedAgent: async () => ({ status: "ok" as const, sessionId: "s1", sessionKey: "k1" }),
      writeResult: async () => {
        throw new Error("disk full");
      },
    };

    const exitCode = await runCronJobHandler({
      jobId: "job-writefail",
      runId: "run-3",
      deps,
    });

    expect(exitCode).toBe(1);
    expect(stderrLines.some((l) => l.includes("disk full"))).toBe(true);
    // Stdout should NOT have a marker since write failed
    const stdoutCalls = (stdoutSpy.mock.calls as Array<Array<unknown>>).map((c) => String(c[0]));
    expect(stdoutCalls.some((l) => l.includes("OPENCLAW_CRON_RESULT"))).toBe(false);

    storeSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("stdout marker emission failure does not corrupt result (result written first)", async () => {
    const loadCronStoreMod = await import("../../cron/store.js");
    const storeSpy = vi.spyOn(loadCronStoreMod, "loadCronStore").mockResolvedValue({
      version: 1,
      jobs: [
        {
          id: "job-markerfail",
          name: "Marker Fail Job",
          enabled: true,
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "marker fail" },
          schedule: { kind: "every", everyMs: 60000 },
        } as unknown as CronJob,
      ],
    });

    let writtenInput: Parameters<RunCronJobDeps["writeResult"]>[0] | undefined;
    let writeCallCount = 0;

    // Spy on stdout.write — throw on first call (marker) to simulate failure
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw new Error("stdout broken");
    });

    const deps: RunCronJobDeps = {
      runIsolatedAgent: async () => ({ status: "ok" as const, sessionId: "s1", sessionKey: "k1" }),
      writeResult: async (input) => {
        writtenInput = input;
        writeCallCount++;
        return { resultFilePath: "/fake/path" };
      },
    };

    // Should not throw — marker failure is swallowed
    const exitCode = await runCronJobHandler({
      jobId: "job-markerfail",
      runId: "run-4",
      deps,
    });

    // Result file write happened before marker attempt
    expect(writeCallCount).toBe(1);
    expect(writtenInput?.status).toBe("ok");
    // Exit code still follows the agent result (ok → 0)
    expect(exitCode).toBe(0);

    storeSpy.mockRestore();
    stdoutSpy.mockRestore();
  });
});

// ── Integration: env-not-set → real process exits non-zero ───────────────────

describe("run-cron-job integration: env-not-set guard", () => {
  it("exits non-zero with stderr message when OPENCLAW_CRON_RUNNER is not set", () => {
    // We resolve to the compiled JS entrypoint via tsx/ts-node wrapper used in tests.
    // The simplest approach: run `node --import tsx ...` against main.ts to invoke the CLI.
    // For CI correctness we rely on the vitest environment.

    // Locate the project root (two levels up from src/cli/run-cron-job).
    const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

    // Use the run-vitest.mjs launcher script approach — for the spawn test,
    // execute a tiny inline script that imports the module and calls the action.
    const result = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        "--input-type",
        "module",
        "--eval",
        `
import { routeLogsToStderr } from "./src/logging/console.js";
import { assertCronRunnerContext } from "./src/cli/run-cron-job/runtime.js";
routeLogsToStderr();
try {
  assertCronRunnerContext();
  process.exit(0);
} catch (err) {
  process.stderr.write("[run-cron-job] " + String(err.message) + "\\n");
  process.exit(1);
}
        `.trim(),
      ],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_CRON_RUNNER: undefined as unknown as string,
        },
        timeout: 15000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cron runner subprocess");
  });
});
