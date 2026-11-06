import type { CaptureDraft } from './types';

const DB_NAME = 'remindme-capture-queue';
const SHADOW_KEY = 'remindme-capture-manifests';
const MAX_LOCAL_BYTES = 100 * 1024 * 1024;
const MAX_DRAFTS = 10;
let lastSavedAt = 0;

function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('此浏览器无法保存待上传照片。')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭其他 RemindMe 页面后重试。'));
  });
}

function shadows(): CaptureDraft[] {
  try { return JSON.parse(localStorage.getItem(SHADOW_KEY) || '[]'); }
  catch { return []; }
}

function saveShadow(draft: CaptureDraft) {
  const all = shadows().filter((entry) => entry.id !== draft.id && Date.parse(entry.expiresAt) > Date.now());
  all.push({ ...draft, photos: draft.photos.map(({ blob: _blob, ...photo }) => photo) });
  localStorage.setItem(SHADOW_KEY, JSON.stringify(all.slice(-MAX_DRAFTS)));
}

async function readAll(): Promise<CaptureDraft[]> {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readonly');
    const request = transaction.objectStore('drafts').getAll();
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

export async function saveDraft(draft: CaptureDraft): Promise<boolean> {
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1);
  draft = { ...draft, updatedAt: lastSavedAt };
  // A small metadata shadow can still identify missing files after IndexedDB eviction.
  try { saveShadow(draft); } catch { /* IndexedDB may still be available. */ }
  try {
    const db = await openQueue();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite');
      const store = transaction.objectStore('drafts');
      const request = store.getAll();
      let capacityError = false;
      request.onsuccess = () => {
        const all = request.result as CaptureDraft[];
        const remaining = all.filter((entry) => entry.id !== draft.id && Date.parse(entry.expiresAt) > Date.now());
        const bytes = [...remaining, draft].reduce((total, entry) => total + entry.photos.reduce((sum, photo) => sum + (photo.blob?.size ?? 0), 0), 0);
        if (remaining.length >= MAX_DRAFTS || bytes > MAX_LOCAL_BYTES) {
          capacityError = true; transaction.abort(); return;
        }
        for (const entry of all) if (Date.parse(entry.expiresAt) <= Date.now()) store.delete(entry.id);
        store.put(draft);
      };
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = transaction.onerror = () => {
        db.close(); reject(new Error(capacityError ? '浏览器待上传照片已达到 100 MiB 上限。' : '浏览器无法保存照片。'));
      };
    });
    return true;
  } catch { return false; }
}

export async function loadDrafts(ownerId: string): Promise<CaptureDraft[]> {
  const merged = new Map(shadows().filter((entry) => entry.ownerId === ownerId).map((entry) => [entry.id, entry]));
  try {
    for (const draft of await readAll()) {
      if (draft.ownerId !== ownerId) continue;
      const shadow = merged.get(draft.id);
      if (shadow && (shadow.updatedAt ?? 0) > (draft.updatedAt ?? 0)) {
        // A failed blob write must not silently revert the final manifest to an older subset.
        const blobs = new Map(draft.photos.map((photo) => [photo.id, photo]));
        merged.set(draft.id, { ...shadow, photos: shadow.photos.map((photo) => ({
          ...photo, blob: blobs.get(photo.id)?.sha256 === photo.sha256 ? blobs.get(photo.id)?.blob : undefined,
        })) });
      } else merged.set(draft.id, draft);
    }
  } catch { /* The metadata shadow provides an explicit missing-file recovery path. */ }
  for (const [id, draft] of merged) {
    if (Date.parse(draft.expiresAt) <= Date.now()) {
      await clearDraft(id);
      merged.delete(id);
    }
  }
  return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function clearDraft(id: string): Promise<void> {
  try { localStorage.setItem(SHADOW_KEY, JSON.stringify(shadows().filter((entry) => entry.id !== id))); }
  catch { /* A stale metadata entry is reconciled against server status on reopening. */ }
  try {
    const db = await openQueue();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite');
      transaction.objectStore('drafts').delete(id);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error); };
    });
  } catch { /* Storage may have been evicted already. */ }
}
