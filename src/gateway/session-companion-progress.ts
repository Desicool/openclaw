type SessionCompanionProgressListener = (payload: { empty: boolean }) => void;

const listeners = new Map<string, SessionCompanionProgressListener>();

function progressKey(connId: string, sessionKey: string): string {
  return `${connId}\0${sessionKey}`;
}

export function registerSessionCompanionProgress(params: {
  connId: string;
  sessionKey: string;
  listener: SessionCompanionProgressListener;
}): () => void {
  const key = progressKey(params.connId, params.sessionKey);
  listeners.set(key, params.listener);
  return () => {
    if (listeners.get(key) === params.listener) {
      listeners.delete(key);
    }
  };
}

export function notifySessionCompanionPrepared(params: {
  connId: string;
  empty: boolean;
  sessionKey: string;
}): void {
  listeners.get(progressKey(params.connId, params.sessionKey))?.({ empty: params.empty });
}
