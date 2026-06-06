// Scheduler instance lock. Single-writer guarantee for jobs.json/jobs-state.json:
// the gateway scheduler holds this lock for its lifetime, and offline CLI tools
// (cron purge, doctor --fix) acquire it when the gateway is stopped.
//
// Approach: POSIX `open(O_EXCL)` via the `wx` flag is race-safe across processes.
// No external file-locking dep is available in this repo and adding one is out of
// scope. The lock file content is just the holder pid (JSON). Stale-lock detection
// uses `process.kill(pid, 0)` and only steals when the OS confirms ESRCH.

import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigDir } from "../utils.js";

export type SchedulerLockHandle = {
  readonly heldByPid: number;
  readonly path: string;
  release(): Promise<void>;
};

export type AcquireSchedulerLockResult =
  | { kind: "acquired"; handle: SchedulerLockHandle }
  | { kind: "held"; holderPid: number | null };

export type AcquireSchedulerLockParams = {
  path?: string;
  pid?: number;
};

const INIT_PID = 1;

export async function acquireSchedulerLock(
  params: AcquireSchedulerLockParams = {},
): Promise<AcquireSchedulerLockResult> {
  const lockPath = params.path ?? resolveDefaultSchedulerLockPath();
  const pid = params.pid ?? process.pid;

  await ensureParentDir(lockPath);

  const direct = await tryCreateLockFile(lockPath, pid);
  if (direct.kind === "created") {
    return { kind: "acquired", handle: makeHandle(lockPath, pid) };
  }
  if (direct.kind === "error") {
    return { kind: "held", holderPid: null };
  }

  // Lock file exists. Inspect holder; steal only if OS confirms dead and safe.
  const holderPid = await readHolderPid(lockPath);
  if (canStealLock(holderPid, pid)) {
    const stolen = await tryStealLockFile(lockPath, pid);
    if (stolen) {
      return { kind: "acquired", handle: makeHandle(lockPath, pid) };
    }
  }
  return { kind: "held", holderPid };
}

function resolveDefaultSchedulerLockPath(): string {
  return path.join(resolveConfigDir(), "cron", "scheduler.lock");
}

async function ensureParentDir(lockPath: string): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
}

type CreateLockOutcome = { kind: "created" } | { kind: "exists" } | { kind: "error" };

async function tryCreateLockFile(lockPath: string, pid: number): Promise<CreateLockOutcome> {
  try {
    await fs.writeFile(lockPath, serializeLockContent(pid), { flag: "wx" });
    return { kind: "created" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return { kind: "exists" };
    }
    return { kind: "error" };
  }
}

async function tryStealLockFile(lockPath: string, pid: number): Promise<boolean> {
  // Race-tolerant: re-create with `wx` after unlink. If another process wins
  // the race we report "held"; the caller decides what to do.
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return false;
    }
  }
  const recreate = await tryCreateLockFile(lockPath, pid);
  return recreate.kind === "created";
}

async function readHolderPid(lockPath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "pid" in parsed) {
      const candidate = (parsed as { pid: unknown }).pid;
      if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) {
        return candidate;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function canStealLock(holderPid: number | null, ownPid: number): boolean {
  if (holderPid === null) {
    return false;
  }
  if (holderPid === INIT_PID) {
    return false;
  }
  if (holderPid === ownPid) {
    return false;
  }
  return isPidDead(holderPid);
}

function isPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function makeHandle(lockPath: string, pid: number): SchedulerLockHandle {
  let released = false;
  return {
    heldByPid: pid,
    path: lockPath,
    async release() {
      if (released) {
        return;
      }
      released = true;
      try {
        // Only unlink if we still own the file (pid still matches).
        // If file content is unreadable, the lock was stolen or corrupted — leave it for the current owner.
        const holderPid = await readHolderPid(lockPath);
        if (holderPid === pid) {
          await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") {
              throw error;
            }
          });
        }
      } catch {
        // Release is best-effort; never throw.
      }
    },
  };
}

function serializeLockContent(pid: number): string {
  return `${JSON.stringify({ pid })}\n`;
}
