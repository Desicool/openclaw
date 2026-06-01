import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSchedulerLock } from "./scheduler-lock.js";

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  // This file uses real process spawns and real setTimeout; guard against
  // fake-timer bleed-in from another --isolate=false test file.
  vi.useRealTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-lock-"));
  lockPath = path.join(tmpDir, "scheduler.lock");
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("acquireSchedulerLock", () => {
  it("acquires when lock file is absent", async () => {
    const result = await acquireSchedulerLock({ path: lockPath, pid: 12_345 });
    expect(result.kind).toBe("acquired");
    if (result.kind !== "acquired") {
      return;
    }
    expect(result.handle.heldByPid).toBe(12_345);
    expect(result.handle.path).toBe(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    await result.handle.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("returns held when another live process holds the lock", async () => {
    // Spawn a real long-lived child so its pid is genuinely alive while we test.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      // Wait for the process to actually start (avoids relying on setTimeout which
      // can be faked in --isolate=false test runs sharing a worker with fake-timer tests).
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const childPid = child.pid;
      if (!childPid) {
        throw new Error("child pid missing");
      }
      const first = await acquireSchedulerLock({ path: lockPath, pid: childPid });
      expect(first.kind).toBe("acquired");

      const second = await acquireSchedulerLock({ path: lockPath, pid: 22_222 });
      expect(second.kind).toBe("held");
      if (second.kind !== "held") {
        return;
      }
      expect(second.holderPid).toBe(childPid);
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
      });
    }
  });

  it("release lets a subsequent acquisition succeed", async () => {
    const first = await acquireSchedulerLock({ path: lockPath, pid: 30_001 });
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") {
      return;
    }
    await first.handle.release();

    const second = await acquireSchedulerLock({ path: lockPath, pid: 30_002 });
    expect(second.kind).toBe("acquired");
  });

  it("steals a stale lock whose holder pid is dead", async () => {
    // Spawn a short-lived child, capture its pid, then let it exit. Its pid is
    // guaranteed to be dead (and not recycled within this tick) when we test.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const deadPid = await new Promise<number>((resolve, reject) => {
      child.once("exit", () => {
        if (child.pid) {
          resolve(child.pid);
        } else {
          reject(new Error("child pid missing"));
        }
      });
    });
    // Write the stale lock content directly.
    await fsp.writeFile(lockPath, `${JSON.stringify({ pid: deadPid })}\n`);

    const stolen = await acquireSchedulerLock({ path: lockPath, pid: 40_001 });
    expect(stolen.kind).toBe("acquired");
    if (stolen.kind !== "acquired") {
      return;
    }
    const content = await fsp.readFile(lockPath, "utf8");
    expect(JSON.parse(content)).toEqual({ pid: 40_001 });
  });

  it("does not steal when the lock holder pid equals our own pid", async () => {
    // Pre-populate with our own pid; even though we are alive, "steal == own pid"
    // is explicitly forbidden so we get held with our own pid back.
    await fsp.writeFile(lockPath, `${JSON.stringify({ pid: process.pid })}\n`);
    const result = await acquireSchedulerLock({ path: lockPath, pid: process.pid });
    expect(result.kind).toBe("held");
    if (result.kind !== "held") {
      return;
    }
    expect(result.holderPid).toBe(process.pid);
  });

  it("does not steal when holder pid is 1 (init)", async () => {
    await fsp.writeFile(lockPath, `${JSON.stringify({ pid: 1 })}\n`);
    const result = await acquireSchedulerLock({ path: lockPath, pid: 50_001 });
    expect(result.kind).toBe("held");
    if (result.kind !== "held") {
      return;
    }
    expect(result.holderPid).toBe(1);
  });

  it("returns null holder pid when lock content is unparseable", async () => {
    await fsp.writeFile(lockPath, "not json at all");
    const result = await acquireSchedulerLock({ path: lockPath, pid: 60_001 });
    expect(result.kind).toBe("held");
    if (result.kind !== "held") {
      return;
    }
    expect(result.holderPid).toBeNull();
  });

  it("release is idempotent — calling release twice does not throw", async () => {
    const result = await acquireSchedulerLock({ path: lockPath, pid: 70_001 });
    expect(result.kind).toBe("acquired");
    if (result.kind !== "acquired") {
      return;
    }
    await result.handle.release();
    // Second call must not throw.
    await expect(result.handle.release()).resolves.toBeUndefined();
  });

  it("release does not unlink when lock file content has been corrupted by another process", async () => {
    const result = await acquireSchedulerLock({ path: lockPath, pid: 80_001 });
    expect(result.kind).toBe("acquired");
    if (result.kind !== "acquired") {
      return;
    }
    // Simulate another process corrupting the file.
    await fsp.writeFile(lockPath, "garbage content — unreadable");
    await result.handle.release();
    // The corrupted file must still exist because we did not own it.
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});
