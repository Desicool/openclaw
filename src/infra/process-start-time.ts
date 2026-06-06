// Platform-gated helper to read the OS-reported start time of a process.
// Used by the cron scheduler's cross-boot reconcile to detect pid recycling:
// the persisted (pid, startedAtMs) tuple must match the OS-reported start time
// or the pid has been reused by an unrelated process.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";

export type ProcessStartTimeQueryResult =
  | { kind: "ok"; startedAtMs: number }
  | { kind: "no-such-pid" }
  | { kind: "unsupported-platform" }
  | { kind: "query-failed"; reason: string };

const PS_TIMEOUT_MS = 2_000;
const LINUX_DEFAULT_CLOCK_TICKS_PER_SECOND = 100;

export async function readProcessStartTimeMs(pid: number): Promise<ProcessStartTimeQueryResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { kind: "no-such-pid" };
  }
  if (process.platform === "darwin") {
    return readDarwinStartTimeMs(pid);
  }
  if (process.platform === "linux") {
    return readLinuxStartTimeMs(pid);
  }
  return { kind: "unsupported-platform" };
}

async function readDarwinStartTimeMs(pid: number): Promise<ProcessStartTimeQueryResult> {
  // `ps -o lstart= -p <pid>` prints the process start time in the form
  // `Wed May 28 09:15:32 2026` (locale-independent, no header due to trailing `=`).
  // Empty stdout means no such pid.
  const psOutput = await runPs(pid);
  if (psOutput.kind !== "ok") {
    return psOutput;
  }
  const trimmed = psOutput.stdout.trim();
  if (!trimmed) {
    return { kind: "no-such-pid" };
  }
  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) {
    return { kind: "query-failed", reason: `unparseable ps lstart output: ${trimmed}` };
  }
  return { kind: "ok", startedAtMs: parsedMs };
}

type PsOutcome =
  | { kind: "ok"; stdout: string }
  | { kind: "no-such-pid" }
  | { kind: "query-failed"; reason: string };

function runPs(pid: number): Promise<PsOutcome> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { timeout: PS_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (!error) {
          resolve({ kind: "ok", stdout });
          return;
        }
        // `ps` exits non-zero with empty stdout when the pid is absent.
        if (typeof stdout === "string" && stdout.trim() === "") {
          resolve({ kind: "no-such-pid" });
          return;
        }
        resolve({ kind: "query-failed", reason: error.message });
      },
    );
  });
}

async function readLinuxStartTimeMs(pid: number): Promise<ProcessStartTimeQueryResult> {
  const statContent = await readFileSafe(`/proc/${pid}/stat`);
  if (statContent.kind === "missing") {
    return { kind: "no-such-pid" };
  }
  if (statContent.kind === "error") {
    return { kind: "query-failed", reason: statContent.reason };
  }
  const starttimeTicks = parseProcStatStarttimeTicks(statContent.content);
  if (starttimeTicks === null) {
    return { kind: "query-failed", reason: "unparseable /proc/<pid>/stat" };
  }
  const bootTimeMs = await readLinuxBootTimeMs();
  if (bootTimeMs.kind !== "ok") {
    return bootTimeMs;
  }
  const ticksPerSecond = LINUX_DEFAULT_CLOCK_TICKS_PER_SECOND;
  const startedAtMs = bootTimeMs.bootTimeMs + Math.round((starttimeTicks * 1000) / ticksPerSecond);
  return { kind: "ok", startedAtMs };
}

// /proc/<pid>/stat field 22 is the process start time in clock ticks since boot.
// The comm field (2) may contain spaces / parentheses, so we slice from the last
// `)` and split the remainder.
function parseProcStatStarttimeTicks(content: string): number | null {
  const lastParen = content.lastIndexOf(")");
  if (lastParen < 0) {
    return null;
  }
  const afterComm = content.slice(lastParen + 1).trim();
  const parts = afterComm.split(/\s+/);
  // After the comm field, field 3 onward; starttime is field 22 → index (22 - 3) = 19.
  const starttimeRaw = parts[19];
  if (!starttimeRaw) {
    return null;
  }
  const ticks = Number.parseInt(starttimeRaw, 10);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks : null;
}

type LinuxBootTimeResult =
  | { kind: "ok"; bootTimeMs: number }
  | { kind: "query-failed"; reason: string };

async function readLinuxBootTimeMs(): Promise<LinuxBootTimeResult> {
  const statContent = await readFileSafe("/proc/stat");
  if (statContent.kind === "missing") {
    return { kind: "query-failed", reason: "/proc/stat not found" };
  }
  if (statContent.kind === "error") {
    return { kind: "query-failed", reason: statContent.reason };
  }
  const match = /^btime\s+(\d+)/m.exec(statContent.content);
  if (!match) {
    return { kind: "query-failed", reason: "btime missing from /proc/stat" };
  }
  const secondsRaw = match[1];
  const seconds = Number.parseInt(secondsRaw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { kind: "query-failed", reason: `unparseable btime: ${secondsRaw}` };
  }
  return { kind: "ok", bootTimeMs: seconds * 1000 };
}

type ReadFileSafeResult =
  | { kind: "ok"; content: string }
  | { kind: "missing" }
  | { kind: "error"; reason: string };

async function readFileSafe(filePath: string): Promise<ReadFileSafeResult> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { kind: "ok", content };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") {
      return { kind: "missing" };
    }
    return { kind: "error", reason: (error as Error).message };
  }
}
