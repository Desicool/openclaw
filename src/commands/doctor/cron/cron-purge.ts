import { note } from "../../../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import {
  probeGatewayUpDefault,
  runCronPurge,
  type PurgeReport,
  type RunCronPurgeDeps,
  type RunCronPurgeFlags,
} from "../../../cli/cron-cli/register.cron-purge.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCronStorePath } from "../../../cron/store.js";
import { shortenHomePath } from "../../../utils.js";
import type { DoctorOptions, DoctorPrompter } from "../../doctor-prompter.js";

const SAFE_SUBSET_FLAGS: RunCronPurgeFlags = {
  dryRun: true,
  orphaned: true,
  staleRunning: true,
  zombies: true,
  expired: true,
  duplicates: false,
  force: false,
};

const GATEWAY_UP_NOTE =
  "cron purge skipped: openclaw gateway is currently running. Stop it before running `openclaw doctor --fix` for cron cleanup.";

function noteGatewayUp(): void {
  note(GATEWAY_UP_NOTE, "Cron purge");
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function summarizePreview(report: PurgeReport): string[] {
  const lines: string[] = [];
  const zombies = report.classifiers.zombies?.files.length ?? 0;
  const expired = report.classifiers.expired?.jobs.length ?? 0;
  lines.push(`- ${pluralize(zombies, "zombie run-artifact file")} (older than 14 days)`);
  lines.push(`- ${pluralize(expired, "expired at-job")} (fireAt more than 7 days in the past)`);
  if (report.classifiers.orphaned) {
    lines.push(`- orphaned classifier: ${report.classifiers.orphaned.reason}`);
  }
  if (report.classifiers.staleRunning) {
    lines.push(`- stale-running classifier: ${report.classifiers.staleRunning.reason}`);
  }
  return lines;
}

function summarizeRemoved(report: PurgeReport): string[] {
  const lines: string[] = [];
  const zombiesRemoved = report.classifiers.zombies?.files.length ?? 0;
  const emptyDirs = report.classifiers.zombies?.emptyDirsRemoved.length ?? 0;
  const expiredRemoved = report.classifiers.expired?.jobs.length ?? 0;
  lines.push(`- Removed ${pluralize(zombiesRemoved, "zombie run-artifact file")}.`);
  if (emptyDirs > 0) {
    lines.push(`- Removed ${pluralize(emptyDirs, "empty run-artifact directory")}.`);
  }
  lines.push(`- Removed ${pluralize(expiredRemoved, "expired at-job")} from jobs.json.`);
  if (report.archive.jobsJson) {
    lines.push(`- Archived prior jobs.json to ${shortenHomePath(report.archive.jobsJson)}.`);
  }
  return lines;
}

function hasFindings(report: PurgeReport): boolean {
  const zombies = report.classifiers.zombies?.files.length ?? 0;
  const expired = report.classifiers.expired?.jobs.length ?? 0;
  return zombies > 0 || expired > 0;
}

export async function maybeRunCronPurgeSafeSubset(params: {
  cfg: OpenClawConfig;
  options: DoctorOptions;
  prompter: Pick<DoctorPrompter, "confirm" | "shouldRepair">;
  /** Test seam: override runCronPurge dependencies (gateway probe, nowMs, storePath). */
  deps?: RunCronPurgeDeps;
}): Promise<void> {
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const deps: RunCronPurgeDeps = { storePath, ...params.deps };

  // Probe gateway up-front so both classify and mutate paths share the same
  // "skipped" branch with a single informational note. The probe in
  // runCronPurge() itself only fires for non-dry-run, which would let the
  // dry-run preview succeed and then surface two notes downstream.
  const probeGatewayUp = deps.probeGatewayUp ?? probeGatewayUpDefault;
  if (await probeGatewayUp()) {
    noteGatewayUp();
    return;
  }
  // Hand the resolved probe to runCronPurge so it doesn't re-probe.
  const purgeDeps: RunCronPurgeDeps = { ...deps, probeGatewayUp: async () => false };

  // Phase 1: always classify (dry-run) so we can show what would be removed
  // regardless of --fix. The mutating second call only runs if prompter says so.
  const preview = await runCronPurge({ flags: SAFE_SUBSET_FLAGS }, purgeDeps);

  if (!hasFindings(preview)) {
    note(
      `Cron state at ${shortenHomePath(storePath)} is clean: no zombie run artifacts or expired at-jobs to purge.`,
      "Cron purge",
    );
    return;
  }

  // Always surface the findings preview before any branch decision so the
  // log shows what would be removed regardless of --fix.
  note(
    [
      `Cron purge would clean leaked entries at ${shortenHomePath(storePath)}.`,
      ...summarizePreview(preview),
    ].join("\n"),
    "Cron purge",
  );

  let shouldPurge = params.prompter.shouldRepair;
  if (!shouldPurge) {
    shouldPurge = await params.prompter.confirm({
      message: "Run safe-subset cron purge now (zombies + expired)?",
      initialValue: true,
    });
  }
  if (!shouldPurge) {
    note(
      `Manual cleanup: ${formatCliCommand("openclaw cron purge --zombies --expired")}.`,
      "Cron purge",
    );
    return;
  }

  const result = await runCronPurge({ flags: { ...SAFE_SUBSET_FLAGS, dryRun: false } }, purgeDeps);

  note(summarizeRemoved(result).join("\n"), "Doctor changes");
}
