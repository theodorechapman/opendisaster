import type { ReplaySession, ReplayVideoFrame } from "./types.ts";

const DB_NAME = "opendisaster-replays";
const DB_VERSION = 2;
const MAX_SESSIONS = 10;

const STORE_SESSIONS = "sessions";
const STORE_FRAMES = "frames";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      // Migration: delete old v1 data
      if (oldVersion < 2) {
        if (db.objectStoreNames.contains("sessions")) {
          db.deleteObjectStore("sessions");
        }
      }

      // Create session metadata store
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: "sessionId" });
      }

      // Create frames store with auto-increment key and compound index
      if (!db.objectStoreNames.contains(STORE_FRAMES)) {
        const frameStore = db.createObjectStore(STORE_FRAMES, { autoIncrement: true });
        frameStore.createIndex("by_session_agent_time", ["sessionId", "agentIndex", "time"]);
        frameStore.createIndex("by_session", ["sessionId"]);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSession(session: ReplaySession): Promise<void> {
  console.log(`[Replay/Storage] saveSession: ${session.sessionId}, ${session.vlmEntries.length} VLM entries`);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    tx.objectStore(STORE_SESSIONS).put(session);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
  db.close();
  await pruneOldSessions();
}

export async function saveFramesBatch(frames: ReplayVideoFrame[]): Promise<void> {
  if (frames.length === 0) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_FRAMES, "readwrite");
    const store = tx.objectStore(STORE_FRAMES);
    for (const frame of frames) {
      store.put(frame);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
  db.close();
}

export async function getSession(id: string): Promise<ReplaySession | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const req = tx.objectStore(STORE_SESSIONS).get(id);
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

export async function getFramesForAgent(
  sessionId: string,
  agentIndex: number,
): Promise<ReplayVideoFrame[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FRAMES, "readonly");
    const index = tx.objectStore(STORE_FRAMES).index("by_session_agent_time");
    // Range: all frames for this session + agent, any time
    const lower = [sessionId, agentIndex, -Infinity];
    const upper = [sessionId, agentIndex, Infinity];
    const range = IDBKeyRange.bound(lower, upper);
    const req = index.getAll(range);
    req.onsuccess = () => {
      resolve(req.result as ReplayVideoFrame[]);
      db.close();
    };
    req.onerror = () => {
      reject(req.error);
      db.close();
    };
  });
}

export async function listSessions(): Promise<
  Pick<ReplaySession, "sessionId" | "location" | "startTime" | "endTime" | "durationSec" | "agents">[]
> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const req = tx.objectStore(STORE_SESSIONS).getAll();
    req.onsuccess = () => {
      const raw = req.result as ReplaySession[];
      const sessions = raw
        .map(({ sessionId, location, startTime, endTime, durationSec, agents }) => ({
          sessionId, location, startTime, endTime, durationSec, agents,
        }))
        .sort((a, b) => b.startTime - a.startTime);
      resolve(sessions);
      db.close();
    };
    req.onerror = () => {
      reject(req.error);
      db.close();
    };
  });
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    // Delete session metadata and all its frames in one transaction
    const tx = db.transaction([STORE_SESSIONS, STORE_FRAMES], "readwrite");
    tx.objectStore(STORE_SESSIONS).delete(id);

    // Delete all frames for this session via index cursor
    const index = tx.objectStore(STORE_FRAMES).index("by_session");
    const range = IDBKeyRange.only([id]);
    const cursorReq = index.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

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
