import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  sweepCronRunsArtifacts,
  resolveRetentionMs,
  resetReaperThrottle,
  sweepCronRunSessions,
} from "./session-reaper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkRunsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cron-reaper-"));
}

/** Age a file by setting its mtime to (now - ageMs). */
function ageFile(filePath: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, t, t);
}

function writeFile(filePath: string, content = ""): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ---------------------------------------------------------------------------
// sweepCronRunsArtifacts
// ---------------------------------------------------------------------------

describe("sweepCronRunsArtifacts", () => {
  let runsDir: string;
  const RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  const OLD_AGE_MS = RETENTION_MS + 1000; // just past the retention window

  beforeEach(() => {
    runsDir = mkRunsDir();
  });

  it("removes old .result.json and .pid files; keeps fresh ones", async () => {
    const jobDir = path.join(runsDir, "job-a");
    const oldResult = path.join(jobDir, "run-1.result.json");
    const oldPid = path.join(jobDir, "run-1.pid");
    const freshResult = path.join(jobDir, "run-2.result.json");

    writeFile(oldResult, "{}");
    writeFile(oldPid, "12345");
    writeFile(freshResult, "{}");

    ageFile(oldResult, OLD_AGE_MS);
    ageFile(oldPid, OLD_AGE_MS);
    // freshResult mtime stays at now

    const result = await sweepCronRunsArtifacts({ runsDir });

    expect(result.filesRemoved).toBe(2);
    expect(result.emptyDirsRemoved).toBe(0);
    expect(fs.existsSync(oldResult)).toBe(false);
    expect(fs.existsSync(oldPid)).toBe(false);
    expect(fs.existsSync(freshResult)).toBe(true);
  });

  it("removes old session-*.json files", async () => {
    const jobDir = path.join(runsDir, "job-b");
    const oldSession = path.join(jobDir, "session-abc123.json");

    writeFile(oldSession, "{}");
    ageFile(oldSession, OLD_AGE_MS);

    const result = await sweepCronRunsArtifacts({ runsDir });

    expect(result.filesRemoved).toBe(1);
    expect(fs.existsSync(oldSession)).toBe(false);
  });

  it("removes empty job directory after all files are swept", async () => {
    const jobDir = path.join(runsDir, "job-c");
    const oldResult = path.join(jobDir, "run-1.result.json");

    writeFile(oldResult, "{}");
    ageFile(oldResult, OLD_AGE_MS);

    const result = await sweepCronRunsArtifacts({ runsDir });

    expect(result.filesRemoved).toBe(1);
    expect(result.emptyDirsRemoved).toBe(1);
    expect(fs.existsSync(jobDir)).toBe(false);
  });

  it("does not remove job directory when fresh files remain", async () => {
    const jobDir = path.join(runsDir, "job-d");
    const oldResult = path.join(jobDir, "run-old.result.json");
    const freshResult = path.join(jobDir, "run-new.result.json");

    writeFile(oldResult, "{}");
    writeFile(freshResult, "{}");
    ageFile(oldResult, OLD_AGE_MS);

    const result = await sweepCronRunsArtifacts({ runsDir });

    expect(result.filesRemoved).toBe(1);
    expect(result.emptyDirsRemoved).toBe(0);
    expect(fs.existsSync(jobDir)).toBe(true);
    expect(fs.existsSync(freshResult)).toBe(true);
  });

  it("respects custom retentionMs option", async () => {
    const jobDir = path.join(runsDir, "job-e");
    const recentResult = path.join(jobDir, "run-1.result.json");

    writeFile(recentResult, "{}");
    // Age the file 2 hours
    ageFile(recentResult, 2 * 60 * 60 * 1000);

    // Default 14-day retention: file is fresh, should be kept
    const r1 = await sweepCronRunsArtifacts({ runsDir });
    expect(r1.filesRemoved).toBe(0);

    // Custom 1-hour retention: file is now "old"
    const r2 = await sweepCronRunsArtifacts({ runsDir, retentionMs: 60 * 60 * 1000 });
    expect(r2.filesRemoved).toBe(1);
  });

  it("ignores files that do not match artifact patterns", async () => {
    const jobDir = path.join(runsDir, "job-f");
    const otherFile = path.join(jobDir, "something-else.txt");

    writeFile(otherFile, "data");
    ageFile(otherFile, OLD_AGE_MS);

    const result = await sweepCronRunsArtifacts({ runsDir });

    expect(result.filesRemoved).toBe(0);
    expect(fs.existsSync(otherFile)).toBe(true);
  });

  it("returns zeros and does not throw when runsDir does not exist", async () => {
    const missing = path.join(runsDir, "does-not-exist");
    const result = await sweepCronRunsArtifacts({ runsDir: missing });
    expect(result).toEqual({ filesRemoved: 0, emptyDirsRemoved: 0 });
  });

  it("is best-effort: unreadable file does not crash sweep; other files still processed", async () => {
    const jobDir = path.join(runsDir, "job-g");
    const lockedFile = path.join(jobDir, "run-locked.result.json");
    const oldResult = path.join(jobDir, "run-old.result.json");

    writeFile(lockedFile, "{}");
    writeFile(oldResult, "{}");
    ageFile(lockedFile, OLD_AGE_MS);
    ageFile(oldResult, OLD_AGE_MS);

    // Make lockedFile unreadable (stat will fail)
    fs.chmodSync(lockedFile, 0o000);

    try {
      const result = await sweepCronRunsArtifacts({ runsDir });
      // The old result should still be removed despite the locked file error
      expect(fs.existsSync(oldResult)).toBe(false);
      // We removed at least one file (the old result)
      expect(result.filesRemoved).toBeGreaterThanOrEqual(1);
    } finally {
      // Restore so temp dir cleanup works
      try {
        fs.chmodSync(lockedFile, 0o644);
      } catch {
        // ignore
      }
    }
  });

  it("handles multiple job directories in one sweep", async () => {
    for (const jobId of ["job1", "job2", "job3"]) {
      const jobDir = path.join(runsDir, jobId);
      const f = path.join(jobDir, "run.result.json");
      writeFile(f, "{}");
      ageFile(f, OLD_AGE_MS);
    }

    const result = await sweepCronRunsArtifacts({ runsDir });

    expect(result.filesRemoved).toBe(3);
    expect(result.emptyDirsRemoved).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Deprecated shims — smoke tests to ensure they don't throw
// ---------------------------------------------------------------------------

describe("resolveRetentionMs (deprecated shim)", () => {
  it("returns 14-day default when no config", () => {
    expect(resolveRetentionMs()).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("returns null when sessionRetention is false", () => {
    expect(resolveRetentionMs({ sessionRetention: false })).toBeNull();
  });

  it("returns default even when a duration string is passed (config ignored)", () => {
    // The old parseDurationMs logic is gone; shim always returns the default.
    expect(resolveRetentionMs({ sessionRetention: "1h" })).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe("resetReaperThrottle (deprecated shim)", () => {
  it("is a no-op and does not throw", () => {
    expect(() => resetReaperThrottle()).not.toThrow();
  });
});

describe("sweepCronRunSessions (deprecated shim)", () => {
  it("returns {swept: true, pruned: 0} and does not throw", async () => {
    const result = await sweepCronRunSessions({ sessionStorePath: "/dev/null", log: {} });
    expect(result).toEqual({ swept: true, pruned: 0 });
  });
});
