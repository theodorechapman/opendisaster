import type { ReplaySession } from "./types.ts";

const DB_NAME = "opendisaster-replays";
const STORE_NAME = "sessions";
const DB_VERSION = 1;
const MAX_SESSIONS = 10;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "sessionId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSession(session: ReplaySession): Promise<void> {
  console.log(`[Replay/Storage] saveSession called: ${session.sessionId}, ${session.frames.length} frames`);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(session);
    req.onerror = () => {
      console.error("[Replay/Storage] put request error:", req.error);
    };
    tx.oncomplete = () => {
      console.log("[Replay/Storage] transaction committed");
      resolve();
    };
    tx.onerror = () => {
      console.error("[Replay/Storage] transaction error:", tx.error);
      reject(tx.error);
    };
    tx.onabort = () => {
      console.error("[Replay/Storage] transaction aborted:", tx.error);
      reject(tx.error ?? new Error("Transaction aborted"));
    };
  });
  db.close();
  await pruneOldSessions();
}

export async function getSession(id: string): Promise<ReplaySession | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => {
      resolve(req.result as ReplaySession | undefined);
      db.close();
    };
    req.onerror = () => {
      reject(req.error);
      db.close();
    };
  });
}

export async function listSessions(): Promise<Pick<ReplaySession, "sessionId" | "location" | "startTime" | "endTime" | "totalSteps" | "agents">[]> {
  console.log("[Replay/Storage] listSessions called");
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const raw = req.result as ReplaySession[];
      console.log(`[Replay/Storage] listSessions found ${raw.length} session(s)`);
      const sessions = raw
        .map(({ sessionId, location, startTime, endTime, totalSteps, agents }) => ({
          sessionId, location, startTime, endTime, totalSteps, agents,
        }))
        .sort((a, b) => b.startTime - a.startTime);
      resolve(sessions);
      db.close();
    };
    req.onerror = () => {
      console.error("[Replay/Storage] listSessions error:", req.error);
      reject(req.error);
      db.close();
    };
  });
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
  db.close();
}

async function pruneOldSessions(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length <= MAX_SESSIONS) return;
  const toDelete = sessions.slice(MAX_SESSIONS);
  for (const s of toDelete) {
    await deleteSession(s.sessionId);
  }
  console.log(`[Replay] Pruned ${toDelete.length} old session(s)`);
}
