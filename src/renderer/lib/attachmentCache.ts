// Local IndexedDB cache for user-uploaded image attachments.
//
// The backend intentionally doesn't persist image data: chat.py builds a
// multimodal content list only for the current turn's API call and writes a
// plain-text placeholder like "这是什么 [图片:image.png]" into SessionDB.
// That means switching sessions and coming back loses the original image.
//
// To restore the image without touching the backend persistence layer, we
// cache attachments locally in IndexedDB (keyed by session + user-message
// ordinal) and rehydrate them when history is re-loaded.

const DB_NAME = 'vonvon-attachments'
const STORE = 'attachments'
const DB_VERSION = 1

export interface CachedAttachment {
  dataUrl: string
  name?: string
}

interface CachedRecord {
  key: string                   // `${sessionId}::${ordinal}`
  sessionId: string
  ordinal: number               // 0-based index among user messages in the session
  attachments: CachedAttachment[]
  contentHint?: string          // e.g. "[图片:image.png]"; used to guard against compress drift
  createdAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' })
          store.createIndex('sessionId', 'sessionId', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    // If opening fails, clear the cached promise so a later call can retry.
    dbPromise.catch(() => {
      dbPromise = null
    })
  }
  return dbPromise
}

function makeKey(sessionId: string, ordinal: number): string {
  return `${sessionId}::${ordinal}`
}

export async function putAttachments(
  sessionId: string,
  ordinal: number,
  attachments: CachedAttachment[],
  contentHint?: string
): Promise<void> {
  if (!attachments.length) return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({
        key: makeKey(sessionId, ordinal),
        sessionId,
        ordinal,
        attachments,
        contentHint,
        createdAt: Date.now()
      } satisfies CachedRecord)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    // Swallow: attachment cache is best-effort, never block a send.
  }
}

export async function getSessionAttachments(
  sessionId: string
): Promise<Map<number, CachedRecord>> {
  const map = new Map<number, CachedRecord>()
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const idx = tx.objectStore(STORE).index('sessionId')
      const req = idx.openCursor(IDBKeyRange.only(sessionId))
      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const rec = cursor.value as CachedRecord
          map.set(rec.ordinal, rec)
          cursor.continue()
        } else {
          resolve()
        }
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    // Return empty map on any failure.
  }
  return map
}

export async function deleteSessionAttachments(sessionId: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const idx = tx.objectStore(STORE).index('sessionId')
      const req = idx.openCursor(IDBKeyRange.only(sessionId))
      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          resolve()
        }
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    // Best-effort cleanup.
  }
}
