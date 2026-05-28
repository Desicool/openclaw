import AjvPkg, { type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import {
  buildResultFileRelativePath,
  CRON_RUNNER_STDOUT_MARKER_PREFIX,
  CronJobRunningEntrySchema,
  CronJobTerminalRecordSchema,
  CronRunnerResultFileSchema,
  CronRunnerStdoutMarkerSchema,
  formatStdoutMarkerLine,
  tryParseStdoutMarkerLine,
} from "./runner-protocol.js";

type AjvInstance = { compile<T>(schema: unknown): ValidateFunction<T> };
const AjvCtor = AjvPkg as unknown as new (opts?: object) => AjvInstance;

function compile<T>(schema: unknown): ValidateFunction<T> {
  return new AjvCtor({ allErrors: false, strict: false }).compile<T>(schema);
}

describe("buildResultFileRelativePath", () => {
  it("joins jobId and runId with forward slash and the .result.json suffix", () => {
    expect(buildResultFileRelativePath("job-abc", "run-xyz")).toBe("job-abc/run-xyz.result.json");
  });

  it("rejects jobId containing '/'", () => {
    expect(() => buildResultFileRelativePath("a/b", "run")).toThrow(/jobId/);
  });

  it("rejects jobId containing '..'", () => {
    expect(() => buildResultFileRelativePath("..", "run")).toThrow(/jobId/);
  });

  it("rejects jobId containing backslash", () => {
    expect(() => buildResultFileRelativePath("a\\b", "run")).toThrow(/jobId/);
  });

  it("rejects runId containing '/'", () => {
    expect(() => buildResultFileRelativePath("job", "a/b")).toThrow(/runId/);
  });

  it("rejects runId containing '..'", () => {
    expect(() => buildResultFileRelativePath("job", "..")).toThrow(/runId/);
  });

  it("rejects runId containing backslash", () => {
    expect(() => buildResultFileRelativePath("job", "a\\b")).toThrow(/runId/);
  });

  it("rejects empty jobId", () => {
    expect(() => buildResultFileRelativePath("", "run")).toThrow(/jobId/);
  });

  it("rejects empty runId", () => {
    expect(() => buildResultFileRelativePath("job", "")).toThrow(/runId/);
  });
});

describe("stdout marker line roundtrip", () => {
  it("formatStdoutMarkerLine emits the documented prefix + JSON + newline", () => {
    const line = formatStdoutMarkerLine({ runId: "run-1", status: "ok", durationMs: 42 });
    expect(line.startsWith(CRON_RUNNER_STDOUT_MARKER_PREFIX)).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    const body = line.slice(CRON_RUNNER_STDOUT_MARKER_PREFIX.length, -1);
    expect(JSON.parse(body)).toEqual({ runId: "run-1", status: "ok", durationMs: 42 });
  });

  it("roundtrips via tryParseStdoutMarkerLine", () => {
    const original = { runId: "run-2", status: "error" as const, durationMs: 0 };
    const parsed = tryParseStdoutMarkerLine(formatStdoutMarkerLine(original));
    expect(parsed).toEqual(original);
  });

  it("returns null when the prefix is absent", () => {
    expect(tryParseStdoutMarkerLine('{"runId":"x","status":"ok","durationMs":0}')).toBeNull();
  });

  it("returns null when the JSON payload is malformed", () => {
    expect(tryParseStdoutMarkerLine(`${CRON_RUNNER_STDOUT_MARKER_PREFIX}not json`)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(
      tryParseStdoutMarkerLine(
        `${CRON_RUNNER_STDOUT_MARKER_PREFIX}${JSON.stringify({ runId: "r" })}`,
      ),
    ).toBeNull();
  });

  it("returns null when extra fields are present", () => {
    expect(
      tryParseStdoutMarkerLine(
        `${CRON_RUNNER_STDOUT_MARKER_PREFIX}${JSON.stringify({
          runId: "r",
          status: "ok",
          durationMs: 1,
          extra: true,
        })}`,
      ),
    ).toBeNull();
  });

  it("returns null when field types are wrong", () => {
    expect(
      tryParseStdoutMarkerLine(
        `${CRON_RUNNER_STDOUT_MARKER_PREFIX}${JSON.stringify({
          runId: "r",
          status: "bogus",
          durationMs: 1,
        })}`,
      ),
    ).toBeNull();
  });

  it("returns null when durationMs is negative", () => {
    expect(
      tryParseStdoutMarkerLine(
        `${CRON_RUNNER_STDOUT_MARKER_PREFIX}${JSON.stringify({
          runId: "r",
          status: "ok",
          durationMs: -1,
        })}`,
      ),
    ).toBeNull();
  });
});

describe("CronRunnerResultFileSchema", () => {
  const validate = compile(CronRunnerResultFileSchema);

  it("accepts a minimal happy-path file", () => {
    expect(
      validate({
        schemaVersion: 1,
        runId: "r",
        jobId: "j",
        status: "ok",
        startedAtMs: 1,
        endedAtMs: 2,
      }),
    ).toBe(true);
  });

  it("accepts optional error and deliveryReceipt", () => {
    expect(
      validate({
        schemaVersion: 1,
        runId: "r",
        jobId: "j",
        status: "error",
        startedAtMs: 1,
        endedAtMs: 2,
        error: "boom",
        deliveryReceipt: { ok: true },
      }),
    ).toBe(true);
  });

  it("rejects extra properties", () => {
    expect(
      validate({
        schemaVersion: 1,
        runId: "r",
        jobId: "j",
        status: "ok",
        startedAtMs: 1,
        endedAtMs: 2,
        leaked: "x",
      }),
    ).toBe(false);
  });

  it("rejects unknown status", () => {
    expect(
      validate({
        schemaVersion: 1,
        runId: "r",
        jobId: "j",
        status: "bogus",
        startedAtMs: 1,
        endedAtMs: 2,
      }),
    ).toBe(false);
  });

  it("rejects wrong schemaVersion", () => {
    expect(
      validate({
        schemaVersion: 2,
        runId: "r",
        jobId: "j",
        status: "ok",
        startedAtMs: 1,
        endedAtMs: 2,
      }),
    ).toBe(false);
  });
});

describe("CronJobRunningEntrySchema", () => {
  const validate = compile(CronJobRunningEntrySchema);

  it("accepts a valid running entry", () => {
    expect(validate({ runId: "r", pid: 1234, startedAtMs: 1 })).toBe(true);
  });

  it("rejects empty runId", () => {
    expect(validate({ runId: "", pid: 1234, startedAtMs: 1 })).toBe(false);
  });

  it("rejects extras", () => {
    expect(validate({ runId: "r", pid: 1234, startedAtMs: 1, hello: 1 })).toBe(false);
  });

  it("rejects pid 0 (not a valid process target)", () => {
    expect(validate({ runId: "r", pid: 0, startedAtMs: 1 })).toBe(false);
  });
});

describe("CronJobTerminalRecordSchema", () => {
  const validate = compile(CronJobTerminalRecordSchema);

  it("accepts terminal record with optional error", () => {
    expect(validate({ runId: "r", status: "timeout", endedAtMs: 1, error: "x" })).toBe(true);
  });

  it("rejects unknown status", () => {
    expect(validate({ runId: "r", status: "bogus", endedAtMs: 1 })).toBe(false);
  });
});

describe("CronRunnerStdoutMarkerSchema", () => {
  const validate = compile(CronRunnerStdoutMarkerSchema);

  it("accepts the wire shape", () => {
    expect(validate({ runId: "r", status: "ok", durationMs: 0 })).toBe(true);
  });

  it("rejects extras", () => {
    expect(validate({ runId: "r", status: "ok", durationMs: 0, hint: "x" })).toBe(false);
  });
});
