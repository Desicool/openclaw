import { spawnSync } from "node:child_process";
import type { MeetingNodeHostOptions } from "./node-host.js";

export type MeetingConfiguredNodeHostOptions = Omit<
  MeetingNodeHostOptions,
  "assertAudioAvailable"
> & {
  meetingLabel: string;
  outputMentionsAudioDevice(output: string): boolean;
  sharePrerequisiteDeadline: boolean;
  systemProfilerCommand: string;
};

type MeetingConfiguredNodeHostDeps = {
  asRecord(value: unknown): Record<string, unknown>;
  createMeetingNodeHost(options: MeetingNodeHostOptions): {
    handleCommand(paramsJSON?: string | null): Promise<string>;
  };
};

function readSetupCommand(params: Record<string, unknown>, name: string): string[] {
  const value = params[name];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${name} must be a non-empty string array.`);
  }
  return value as string[];
}

export function createMeetingConfiguredNodeHostImpl(
  options: MeetingConfiguredNodeHostOptions,
  deps: MeetingConfiguredNodeHostDeps,
) {
  const commandExists = (command: string, timeoutMs: number): boolean => {
    const result = spawnSync("/bin/sh", ["-lc", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return result.status === 0;
  };
  const assertAudioAvailable = (
    timeoutMs: number,
    commands: readonly (readonly string[])[] = [
      options.defaultAudioInputCommand,
      options.defaultAudioOutputCommand,
    ],
  ) => {
    if (process.platform !== "darwin") {
      throw new Error(`${options.meetingLabel} talk-back with BlackHole 2ch is macOS-only`);
    }
    const deadline = Date.now() + timeoutMs;
    const commandTimeout = () =>
      options.sharePrerequisiteDeadline ? Math.max(1, deadline - Date.now()) : timeoutMs;
    const result = spawnSync(options.systemProfilerCommand, ["SPAudioDataType"], {
      encoding: "utf8",
      timeout: commandTimeout(),
    });
    const stderr =
      result.stderr ??
      (result.error
        ? result.error instanceof Error
          ? result.error.message
          : String(result.error)
        : "");
    const output = `${result.stdout ?? ""}\n${stderr}`;
    if (
      (typeof result.status === "number" ? result.status : result.error ? 1 : 0) !== 0 ||
      !options.outputMentionsAudioDevice(output)
    ) {
      throw new Error("BlackHole 2ch audio device not found on the node.");
    }
    for (const argv of commands) {
      const command = argv[0];
      if (
        !command ||
        (options.sharePrerequisiteDeadline && Date.now() >= deadline) ||
        !commandExists(command, commandTimeout())
      ) {
        throw new Error(`Configured audio command not found on the node: ${command || "<empty>"}`);
      }
    }
  };
  const host = deps.createMeetingNodeHost({ ...options, assertAudioAvailable });

  return async (paramsJSON?: string | null): Promise<string> => {
    if (paramsJSON) {
      let raw: unknown;
      try {
        raw = JSON.parse(paramsJSON) as unknown;
      } catch {
        throw new Error(`${options.displayName} node host received malformed params JSON.`);
      }
      const params = deps.asRecord(raw);
      if (params.action === "setup") {
        const commands = [
          readSetupCommand(params, "audioInputCommand"),
          readSetupCommand(params, "audioOutputCommand"),
        ];
        if (params.bargeInInputCommand !== undefined) {
          commands.push(readSetupCommand(params, "bargeInInputCommand"));
        }
        assertAudioAvailable(10_000, commands);
        return JSON.stringify({ ok: true });
      }
    }
    return await host.handleCommand(paramsJSON);
  };
}
