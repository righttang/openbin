import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db.js';
import { captureConfig } from './config.js';
import type { CaptureBatch, CapturePhoto } from './types.js';

const active = new Map<string, number>();

/** Protect readers and uploads from the expiry sweeper until they have stopped. */
export function holdCapture(id: string): () => void {
  active.set(id, (active.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (active.get(id) ?? 1) - 1;
    if (count === 0) active.delete(id);
    else active.set(id, count);
  };
}

export function captureIsActive(id: string): boolean { return active.has(id); }

export function captureDirectory(id: string): string {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Error('Invalid capture directory');
  return path.join(captureConfig.scratchPath, id);
}

/** Deletion is restart-safe: a durable terminal state precedes unlinking. */
export async function cleanupCapture(id: string): Promise<boolean> {
  if (active.has(id)) return false;
  const db = getDb();
  const batch = db.prepare('SELECT * FROM capture_batches WHERE id = ?').get(id) as CaptureBatch | undefined;
  if (!batch || batch.cleanup_completed_at) return true;
  const expiredFailure = batch.state === 'failed' && batch.expires_at <= new Date().toISOString();
  if (!['applied', 'superseded', 'expired'].includes(batch.state) && !expiredFailure) return false;
  try {
    const photos = db.prepare('SELECT id,storage_path FROM capture_photos WHERE capture_id = ?').all(id) as Pick<CapturePhoto, 'id' | 'storage_path'>[];
    // Stored paths can point to the previous scratch directory after a config
    // change. Remove those inputs too, rather than marking them deleted merely
    // because the new directory is empty.
    for (const photo of photos) {
      if (!path.isAbsolute(photo.storage_path) || path.basename(photo.storage_path) !== photo.id
        || path.basename(path.dirname(photo.storage_path)) !== id) return false;
      fs.rmSync(photo.storage_path, { force: true });
      fs.rmSync(`${photo.storage_path}.part`, { force: true });
    }
    fs.rmSync(captureDirectory(id), { recursive: true, force: true });
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE capture_photos SET deleted_at = COALESCE(deleted_at, ?) WHERE capture_id = ?').run(now, id);
      db.prepare('UPDATE capture_batches SET cleanup_completed_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    })();
    return true;
  } catch {
    // Keep cleanup_completed_at NULL so startup/periodic sweep retries.
    return false;
  }
}

export async function sweepCaptures(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const expired = db.prepare("SELECT id FROM capture_batches WHERE state = 'uploading' AND expires_at <= ?").all(now) as { id: string }[];
  for (const { id } of expired) {
    if (!active.has(id)) db.prepare("UPDATE capture_batches SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'uploading'").run(now, id);
  }
  const pending = db.prepare(`SELECT id FROM capture_batches WHERE cleanup_completed_at IS NULL
    AND (state IN ('applied','superseded','expired') OR (state = 'failed' AND expires_at <= ?))`).all(now) as { id: string }[];
  for (const { id } of pending) await cleanupCapture(id);

  fs.mkdirSync(captureConfig.scratchPath, { recursive: true, mode: 0o700 });
  // No metadata means an interrupted write or deleted account/bin. A grace period
  // prevents touching newly arriving files; known active inputs are never evicted.
  for (const entry of fs.readdirSync(captureConfig.scratchPath, { withFileTypes: true })) {
    if (active.has(entry.name)) continue;
    if (db.prepare('SELECT 1 FROM capture_batches WHERE id = ?').get(entry.name)) continue;
    const filename = path.join(captureConfig.scratchPath, entry.name);
    try {
      if (fs.lstatSync(filename).mtimeMs > Date.now() - captureConfig.uploadExpiryMs) continue;
      fs.rmSync(filename, { recursive: true, force: true });
    } catch { /* Retry at the next sweep. */ }
  }
}
