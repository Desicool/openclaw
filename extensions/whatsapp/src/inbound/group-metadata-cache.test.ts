// Whatsapp tests cover the group metadata cache owner.
import { EventEmitter } from "node:events";
import type { GroupMetadata, WASocket } from "baileys";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppBaileysGroupMetadataCache } from "./baileys-cache.js";
import {
  createWhatsAppGroupMetadataCacheOwner,
  type WhatsAppGroupMetadataCache,
} from "./group-metadata-cache.js";

function createGroupMetadata(params: {
  id: string;
  subject?: string;
  participantId?: string;
}): GroupMetadata {
  return {
    id: params.id,
    subject: params.subject ?? params.id,
    participants: params.participantId ? [{ id: params.participantId }] : [],
  } as GroupMetadata;
}

function createSocket(params?: {
  groupMetadata?: (jid: string) => Promise<GroupMetadata>;
  groupFetchAllParticipating?: () => Promise<Record<string, GroupMetadata>>;
}) {
  const ev = new EventEmitter();
  const sock = {
    ev,
    groupMetadata: vi.fn(
      params?.groupMetadata ??
        (async (jid: string) => createGroupMetadata({ id: jid, subject: "Fetched group" })),
    ),
    groupFetchAllParticipating: vi.fn(params?.groupFetchAllParticipating ?? (async () => ({}))),
  } as unknown as WASocket;
  return { ev, sock };
}

function createOwner(params: {
  sock: WASocket;
  reconnectCache?: WhatsAppGroupMetadataCache;
  baileysCache?: WhatsAppBaileysGroupMetadataCache;
}) {
  return createWhatsAppGroupMetadataCacheOwner({
    sock: params.sock,
    getCurrentSock: () => params.sock,
    resolveInboundJid: async (jid) => jid?.replace("@s.whatsapp.net", "") ?? null,
    reconnectCache: params.reconnectCache,
    baileysCache: params.baileysCache,
    logVerbose: vi.fn(),
    logHydrationWarning: vi.fn(),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WhatsApp group metadata cache owner", () => {
  it("owns fetched metadata, reconnect fallback, and Baileys participant data", async () => {
    const metadata = createGroupMetadata({
      id: "123@g.us",
      subject: "Project room",
      participantId: "15550001111@s.whatsapp.net",
    });
    const { sock } = createSocket({ groupMetadata: async () => metadata });
    const reconnectCache: WhatsAppGroupMetadataCache = new Map();
    const baileysCache: WhatsAppBaileysGroupMetadataCache = new Map();
    const owner = createOwner({ sock, reconnectCache, baileysCache });

    owner.start();
    const result = await owner.get(metadata.id);

    expect(result).toMatchObject({
      subject: "Project room",
      participants: ["15550001111"],
    });
    expect(reconnectCache.get(metadata.id)?.subject).toBe("Project room");
    expect(baileysCache.get(metadata.id)?.value.participants).toHaveLength(1);
    owner.close();
  });

  it("does not republish metadata invalidated while hydration is pending", async () => {
    let resolveHydration: ((groups: Record<string, GroupMetadata>) => void) | undefined;
    const hydration = new Promise<Record<string, GroupMetadata>>((resolve) => {
      resolveHydration = resolve;
    });
    const { ev, sock } = createSocket({
      groupFetchAllParticipating: async () => await hydration,
    });
    const reconnectCache: WhatsAppGroupMetadataCache = new Map();
    const baileysCache: WhatsAppBaileysGroupMetadataCache = new Map();
    const owner = createOwner({ sock, reconnectCache, baileysCache });

    owner.start();
    ev.emit("groups.update", [{ id: "123@g.us" }]);
    resolveHydration?.({
      "123@g.us": createGroupMetadata({ id: "123@g.us", subject: "Stale group" }),
    });
    await vi.waitFor(() => {
      expect(sock.groupFetchAllParticipating).toHaveBeenCalledOnce();
    });
    await Promise.resolve();

    expect(reconnectCache.has("123@g.us")).toBe(false);
    expect(baileysCache.has("123@g.us")).toBe(false);
    owner.close();
  });

  it("bounds reconnect metadata and detaches group listeners on close", () => {
    const { ev, sock } = createSocket();
    const reconnectCache: WhatsAppGroupMetadataCache = new Map();
    const owner = createOwner({ sock, reconnectCache });

    owner.start();
    for (let index = 0; index < 501; index += 1) {
      const id = `${index}@g.us`;
      ev.emit("groups.upsert", [createGroupMetadata({ id })]);
    }

    expect(reconnectCache.size).toBe(500);
    expect(reconnectCache.has("0@g.us")).toBe(false);
    expect(ev.listenerCount("groups.upsert")).toBe(1);
    expect(ev.listenerCount("groups.update")).toBe(1);
    expect(ev.listenerCount("group-participants.update")).toBe(1);

    owner.close();

    expect(ev.listenerCount("groups.upsert")).toBe(0);
    expect(ev.listenerCount("groups.update")).toBe(0);
    expect(ev.listenerCount("group-participants.update")).toBe(0);
  });

  it("expires local metadata before fetching it again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00Z"));
    const { sock } = createSocket();
    const owner = createOwner({ sock });

    await owner.get("123@g.us");
    await owner.get("123@g.us");
    expect(sock.groupMetadata).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await owner.get("123@g.us");

    expect(sock.groupMetadata).toHaveBeenCalledTimes(2);
    owner.close();
  });
});
