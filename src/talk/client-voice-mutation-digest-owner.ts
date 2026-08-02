import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveSessionDeliveryTarget } from "../infra/outbound/targets-session.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  type ClientVoiceSessionRecord,
  type ClientVoiceToolEffect,
  readVoiceSessionRecordInTransaction,
  writeVoiceSessionRecordInTransaction,
} from "./client-voice-session-store.js";

export const CLIENT_VOICE_MUTATION_DIGEST_POLICY = {
  maxRetainedIntents: 64,
  maxRetainedIdentityBytes: 64 * 1024,
  maxConcurrentAttempts: 2,
  attemptTimeoutMs: 30_000,
} as const;

function formatMutationDigest(effects: ClientVoiceToolEffect[]): string | undefined {
  if (effects.length === 0) {
    return undefined;
  }
  return [
    "Voice call changes",
    ...effects
      .slice(0, 12)
      .map(
        (effect) =>
          `- ${effect.toolName}: ${effect.status === "started" ? "outcome not confirmed" : effect.status}`,
      ),
  ].join("\n");
}

/** Deliver one point-in-time summary and mark the durable voice record after success. */
export async function deliverClientVoiceMutationDigest(
  record: ClientVoiceSessionRecord,
  config: OpenClawConfig,
  signal: AbortSignal,
): Promise<void> {
  if (record.digestDeliveredAt) {
    return;
  }
  const text = formatMutationDigest(record.effects);
  if (!text) {
    return;
  }
  const entry = loadSessionEntryReadOnly({
    agentId: record.agentId,
    sessionKey: record.sessionKey,
  });
  const target = resolveSessionDeliveryTarget({ entry, requestedChannel: "last" });
  if (!target.channel || target.channel === "webchat" || !target.to) {
    return;
  }
  const { sendDurableMessageBatch } = await import("../channels/message/runtime.js");
  const send = await sendDurableMessageBatch({
    cfg: config,
    channel: target.channel,
    to: target.to,
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.threadId != null ? { threadId: target.threadId } : {}),
    payloads: [{ text }],
    durability: "required",
    requireUnknownSendReconciliation: true,
    signal,
    session: buildOutboundSessionContext({
      cfg: config,
      agentId: record.agentId,
      sessionKey: record.sessionKey,
      policySessionKey: record.sessionKey,
    }),
  });
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
  const deliveredAt = Date.now();
  runOpenClawAgentWriteTransaction(
    (database) => {
      const current = readVoiceSessionRecordInTransaction(database, record.voiceSessionId);
      if (!current || current.digestDeliveredAt) {
        return;
      }
      current.digestDeliveredAt = deliveredAt;
      current.updatedAt = deliveredAt;
      writeVoiceSessionRecordInTransaction(database, current);
    },
    { agentId: record.agentId },
  );
}

type MutationDigestIntent<TContext> = {
  agentId: string;
  voiceSessionId: string;
  context: TContext;
  identityBytes: number;
};

type MutationDigestAttempt<TContext> = {
  controller: AbortController;
  intent: MutationDigestIntent<TContext>;
};

type MutationDigestPolicy = {
  maxRetainedIntents: number;
  maxRetainedIdentityBytes: number;
  maxConcurrentAttempts: number;
  attemptTimeoutMs: number;
};

export class ClientVoiceMutationDigestOwner<TContext> {
  private readonly intents = new Map<string, MutationDigestIntent<TContext>>();
  private readonly pendingKeys = new Set<string>();
  private readonly retryAfterActiveKeys = new Set<string>();
  private readonly activeAttempts = new Map<string, MutationDigestAttempt<TContext>>();
  private retainedIdentityBytes = 0;

  constructor(
    private readonly options: {
      attempt: (intent: {
        agentId: string;
        voiceSessionId: string;
        context: TContext;
        signal: AbortSignal;
      }) => Promise<boolean>;
      warn: (message: string) => void;
      policy?: MutationDigestPolicy;
    },
  ) {}

  private get policy(): MutationDigestPolicy {
    return this.options.policy ?? CLIENT_VOICE_MUTATION_DIGEST_POLICY;
  }

  record(params: { agentId: string; voiceSessionId: string; context: TContext }): void {
    const key = this.key(params);
    const existing = this.intents.get(key);
    if (existing) {
      existing.context = params.context;
      if (this.activeAttempts.has(key)) {
        this.retryAfterActiveKeys.add(key);
      } else {
        this.pendingKeys.add(key);
      }
      this.pump();
      return;
    }
    const identityBytes =
      Buffer.byteLength(params.agentId, "utf8") +
      Buffer.byteLength(params.voiceSessionId, "utf8") +
      1;
    if (identityBytes > this.policy.maxRetainedIdentityBytes) {
      this.options.warn("voice mutation digest identity exceeds the retry owner byte limit");
      return;
    }
    if (
      this.intents.size >= this.policy.maxRetainedIntents ||
      this.retainedIdentityBytes + identityBytes > this.policy.maxRetainedIdentityBytes
    ) {
      this.options.warn("voice mutation digest retry owner is full");
      return;
    }
    const intent = { ...params, identityBytes };
    this.intents.set(key, intent);
    this.retainedIdentityBytes += identityBytes;
    this.pendingKeys.add(key);
    this.pump();
  }

  retry(params: { agentId: string; voiceSessionId: string }): void {
    const key = this.key(params);
    if (!this.intents.has(key)) {
      return;
    }
    if (this.activeAttempts.has(key)) {
      this.retryAfterActiveKeys.add(key);
    } else {
      this.pendingKeys.add(key);
    }
    this.pump();
  }

  retryAgent(agentId: string, context: TContext): void {
    for (const [key, intent] of this.intents) {
      if (intent.agentId !== agentId) {
        continue;
      }
      intent.context = context;
      if (this.activeAttempts.has(key)) {
        this.retryAfterActiveKeys.add(key);
      } else {
        this.pendingKeys.add(key);
      }
    }
    this.pump();
  }

  snapshot(): {
    active: number;
    pending: number;
    retained: number;
    retainedIdentityBytes: number;
  } {
    return {
      active: this.activeAttempts.size,
      pending: this.pendingKeys.size,
      retained: this.intents.size,
      retainedIdentityBytes: this.retainedIdentityBytes,
    };
  }

  clear(): void {
    for (const attempt of this.activeAttempts.values()) {
      attempt.controller.abort(new Error("voice mutation digest delivery owner reset"));
    }
    this.intents.clear();
    this.pendingKeys.clear();
    this.retryAfterActiveKeys.clear();
    this.activeAttempts.clear();
    this.retainedIdentityBytes = 0;
  }

  private key(params: { agentId: string; voiceSessionId: string }): string {
    return `${params.agentId}\0${params.voiceSessionId}`;
  }

  private deleteIntent(key: string, expected?: MutationDigestIntent<TContext>): void {
    const current = this.intents.get(key);
    if (!current || (expected && current !== expected)) {
      return;
    }
    this.intents.delete(key);
    this.pendingKeys.delete(key);
    this.retryAfterActiveKeys.delete(key);
    this.retainedIdentityBytes -= current.identityBytes;
  }

  private pump(): void {
    while (
      this.activeAttempts.size < this.policy.maxConcurrentAttempts &&
      this.pendingKeys.size > 0
    ) {
      const key = this.pendingKeys.values().next().value as string | undefined;
      if (!key) {
        return;
      }
      this.pendingKeys.delete(key);
      const intent = this.intents.get(key);
      if (!intent || this.activeAttempts.has(key)) {
        continue;
      }
      this.startAttempt(key, intent);
    }
  }

  private startAttempt(key: string, intent: MutationDigestIntent<TContext>): void {
    const controller = new AbortController();
    const attempt = { controller, intent };
    this.activeAttempts.set(key, attempt);
    const timeout = setTimeout(
      () => controller.abort(new Error("voice mutation digest delivery timed out")),
      this.policy.attemptTimeoutMs,
    );
    timeout.unref?.();
    // Do not race the timeout. An adapter that ignores abort keeps this exact
    // attempt and concurrency slot until its underlying promise really settles.
    void this.options
      .attempt({ ...intent, signal: controller.signal })
      .then((complete) => {
        if (complete) {
          this.deleteIntent(key, intent);
        }
      })
      .catch((error: unknown) => {
        this.options.warn(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.activeAttempts.get(key) === attempt) {
          this.activeAttempts.delete(key);
        }
        if (this.retryAfterActiveKeys.delete(key) && this.intents.has(key)) {
          this.pendingKeys.add(key);
        }
        this.pump();
      });
  }
}
