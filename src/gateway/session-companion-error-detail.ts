const detailReasons = new WeakMap<Error, "context-unavailable" | "session-missing">();

export function attachSessionCompanionErrorDetail<TError extends Error>(
  error: TError,
  reason: "context-unavailable" | "session-missing",
): TError {
  detailReasons.set(error, reason);
  return error;
}

export function readSessionCompanionErrorReason(
  error: Error & { reason?: string },
): string | undefined {
  return detailReasons.get(error) ?? error.reason;
}
