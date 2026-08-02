export type MeetingNodeHostOptions = {
  commandName: string;
  displayName: string;
  browserLabel: string;
  bridgeIdPrefix: string;
  defaultAudioInputCommand: readonly string[];
  defaultAudioOutputCommand: readonly string[];
  talkBackModes: ReadonlySet<string>;
  agentMode: string;
  normalizeUrl(input: unknown): string;
  normalizeMeetingKey(url?: string): string | undefined;
  assertAudioAvailable(timeoutMs: number): void;
  browser: {
    application: string;
    buildProfileArgs(profile: string): string[];
    openedStatus: string;
    openedNotes: string[];
  };
};
