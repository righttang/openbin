import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db.js';
import { requireCreatorOrAdmin, requireMemberOrAbove, verifyBinAccess } from '../binAccess.js';
import { NotFoundError } from '../httpErrors.js';
import { captureConfig } from './config.js';
import { normalizeItemName } from './recognition.js';

interface HistoryPhotoRow {
  capture_id: string; photo_id: string; bin_id: string; bin_name: string; location_name: string;
  captured_at: string; state: string; sequence: number; error_category: string | null; has_preview: number;
}

interface ObservationRow {
  id: string; item_id: string | null; name: string; description: string; aliases_json: string;
  quantity: number | null; capture_id: string; created_at: string;
}

interface InventoryRow {
  id: string; name: string; description: string; quantity: number | null; aliases_json: string;
  last_seen_batch_id: string | null; last_seen_at: string | null; observation_state: string;
  capture_created: number; updated_at: string; deleted_at: string | null;
}

/** SQLite datetime('now') is UTC even though its text omits the timezone. */
export function captureTimestampMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value;
  return Date.parse(normalized);
}

function aliases(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch { return []; }
}

function previewUrl(captureId: string, photoId: string): string {
  return `/api/captures/${encodeURIComponent(captureId)}/photos/${encodeURIComponent(photoId)}/preview`;
}

function cropUrl(observationId: string, photoId: string): string {
  return `/api/captures/observations/${encodeURIComponent(observationId)}/photos/${encodeURIComponent(photoId)}/crop`;
}

/** Retained images have a separate bounded budget; never silently evict older history. */
export function canStoreHistoryBytes(bytes: number): boolean {
  const configured = Number(process.env.CAPTURE_HISTORY_QUOTA_BYTES ?? 512 * 1024 * 1024);
  const quota = Number.isSafeInteger(configured) && configured >= 0 ? configured : 512 * 1024 * 1024;
  const db = getDb();
  const { bytes: used } = db.prepare(`SELECT
    (SELECT COALESCE(SUM(length(preview_jpeg)),0) FROM capture_photo_history) +
    (SELECT COALESCE(SUM(length(crop_jpeg)),0) FROM observation_photos) AS bytes`).get() as { bytes: number };
  if (!Number.isSafeInteger(bytes) || bytes < 0 || used + bytes > quota) return false;
  if (db.name !== ':memory:') {
    try {
      const disk = fs.statfsSync(path.dirname(path.resolve(db.name)));
      // SQLite's journal/WAL may temporarily duplicate the incoming image bytes.
      if (disk.bavail * disk.bsize < bytes * 3 + captureConfig.minFreeDiskBytes) return false;
    } catch { return false; }
  }
  return true;
}

export function storePhotoPreview(
  captureId: string,
  photoId: string,
  preview: { jpeg: Buffer; width: number; height: number } | null,
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO capture_photo_history (capture_id,photo_id) VALUES (?,?)').run(captureId, photoId);
    const current = db.prepare('SELECT dismissed_at,length(preview_jpeg) AS size FROM capture_photo_history WHERE capture_id=? AND photo_id=?')
      .get(captureId, photoId) as { dismissed_at: string | null; size: number | null };
    if (!preview || current.dismissed_at || preview.jpeg.length > 256 * 1024
      || !canStoreHistoryBytes(Math.max(0, preview.jpeg.length - (current.size ?? 0)))) return;
    db.prepare('UPDATE capture_photo_history SET preview_jpeg=?,width=?,height=? WHERE capture_id=? AND photo_id=? AND dismissed_at IS NULL')
      .run(preview.jpeg, preview.width, preview.height, captureId, photoId);
  })();
}

export function listPhotoHistory(userId: string, binId: string | null, locationId: string | null) {
  const db = getDb();
  const rows = db.prepare(`SELECT c.id AS capture_id,p.id AS photo_id,c.bin_id,b.name AS bin_name,
    l.name AS location_name,c.captured_at,c.state,c.sequence,
    (SELECT j.error_category FROM analysis_jobs j WHERE j.capture_id=c.id ORDER BY j.analysis_version DESC LIMIT 1) AS error_category,
    CASE WHEN h.preview_jpeg IS NOT NULL THEN 1 ELSE 0 END AS has_preview
    FROM capture_photos p JOIN capture_batches c ON c.id=p.capture_id
    JOIN bins b ON b.id=c.bin_id JOIN locations l ON l.id=b.location_id
    JOIN location_members lm ON lm.location_id=b.location_id AND lm.user_id=?
    LEFT JOIN capture_photo_history h ON h.capture_id=p.capture_id AND h.photo_id=p.id
    WHERE b.deleted_at IS NULL AND (b.visibility='location' OR b.created_by=?)
      AND p.received_at IS NOT NULL AND h.dismissed_at IS NULL
      AND (? IS NULL OR b.id=?) AND (? IS NULL OR l.id=?)
    ORDER BY c.created_at DESC,c.sequence DESC,p.position,p.id LIMIT 100`)
    .all(userId, userId, binId, binId, locationId, locationId) as HistoryPhotoRow[];
  const observations = db.prepare(`SELECT o.id,o.item_id,o.name,o.description,o.aliases_json,o.quantity,
    CASE WHEN op.crop_jpeg IS NOT NULL THEN 1 ELSE 0 END AS has_crop
    FROM observation_photos op JOIN observations o ON o.id=op.observation_id
    WHERE op.capture_id=? AND op.photo_id=? AND o.dismissed_at IS NULL
    ORDER BY o.name,o.id`);
  return rows.map(({ has_preview, ...photo }) => ({
    ...photo,
    preview_url: has_preview ? previewUrl(photo.capture_id, photo.photo_id) : null,
    items: (observations.all(photo.capture_id, photo.photo_id) as Array<Pick<ObservationRow, 'id' | 'item_id' | 'name' | 'description' | 'aliases_json' | 'quantity'> & { has_crop: number }>).map(
      ({ id, aliases_json, has_crop, ...item }) => ({
        ...item, observation_id: id, aliases: aliases(aliases_json),
        crop_url: has_crop ? cropUrl(id, photo.photo_id) : null,
      }),
    ),
  }));
}

export function latestItemMedia(itemId: string) {
  const row = getDb().prepare(`SELECT o.id AS observation_id,op.photo_id,op.capture_id,
    CASE WHEN op.crop_jpeg IS NOT NULL THEN 1 ELSE 0 END AS has_crop,
    CASE WHEN h.preview_jpeg IS NOT NULL THEN 1 ELSE 0 END AS has_preview
    FROM observations o JOIN capture_batches c ON c.id=o.capture_id
    JOIN observation_photos op ON op.observation_id=o.id
    JOIN capture_photo_history h ON h.capture_id=op.capture_id AND h.photo_id=op.photo_id
    WHERE o.item_id=? AND o.dismissed_at IS NULL AND h.dismissed_at IS NULL AND c.state IN ('applied','superseded')
    ORDER BY c.sequence DESC,has_crop DESC,has_preview DESC,op.photo_id LIMIT 1`).get(itemId) as {
      observation_id: string; photo_id: string; capture_id: string; has_crop: number; has_preview: number;
    } | undefined;
  return {
    observation_id: row?.observation_id ?? null,
    crop_url: row?.has_crop ? cropUrl(row.observation_id, row.photo_id) : null,
    photo_preview_url: row?.has_preview ? previewUrl(row.capture_id, row.photo_id) : null,
  };
}

function restoreFromObservation(itemId: string, observation: ObservationRow & { captured_at: string }) {
  getDb().prepare(`UPDATE bin_items SET name=?,description=?,quantity=?,aliases_json=?,normalized_name=?,
    last_seen_batch_id=?,last_seen_at=?,observation_state='seen',updated_at=? WHERE id=?`)
    .run(observation.name, observation.description, observation.quantity, observation.aliases_json,
      normalizeItemName(observation.name), observation.capture_id, observation.captured_at, observation.created_at, itemId);
}

function restoreBaseline(itemId: string, json: string): boolean {
  let value: Record<string, unknown>;
  try { value = JSON.parse(json); } catch { return false; }
  if (!value || typeof value.name !== 'string' || typeof value.description !== 'string' || typeof value.aliases_json !== 'string') return false;
  getDb().prepare(`UPDATE bin_items SET name=?,description=?,quantity=?,aliases_json=?,normalized_name=?,
    last_seen_batch_id=?,last_seen_at=?,observation_state=?,updated_at=? WHERE id=?`)
    .run(value.name, value.description, value.quantity ?? null, value.aliases_json, normalizeItemName(value.name),
      value.last_seen_batch_id ?? null, value.last_seen_at ?? null, value.observation_state ?? 'unknown', value.updated_at, itemId);
  return true;
}

function refreshItemEvidence(itemId: string, observation: (ObservationRow & { captured_at: string }) | undefined) {
  getDb().prepare('UPDATE bin_items SET last_seen_batch_id=?,last_seen_at=?,observation_state=? WHERE id=?')
    .run(observation?.capture_id ?? null, observation?.captured_at ?? null, observation ? 'seen' : 'unknown', itemId);
}

/** Remove this photo's evidence atomically; other photos continue to support shared items. */
export async function dismissPhotoHistory(captureId: string, photoId: string, userId: string) {
  const db = getDb();
  const batch = db.prepare('SELECT bin_id FROM capture_batches WHERE id=?').get(captureId) as { bin_id: string } | undefined;
  const access = batch ? await verifyBinAccess(batch.bin_id, userId) : null;
  if (!batch || !access) throw new NotFoundError('Photo record not found');
  await requireMemberOrAbove(access.locationId, userId, 'remove recognition history');
  await requireCreatorOrAdmin(access.locationId, userId, access.createdBy, 'remove recognition history');
  return db.transaction(() => {
    const photo = db.prepare('SELECT id FROM capture_photos WHERE capture_id=? AND id=?').get(captureId, photoId);
    if (!photo) throw new NotFoundError('Photo record not found');
    db.prepare('INSERT OR IGNORE INTO capture_photo_history (capture_id,photo_id) VALUES (?,?)').run(captureId, photoId);
    const existing = db.prepare('SELECT dismissed_at FROM capture_photo_history WHERE capture_id=? AND photo_id=?')
      .get(captureId, photoId) as { dismissed_at: string | null };
    if (existing.dismissed_at) return { removed: true, removed_items: 0 };
    const now = new Date().toISOString();
    const affected = db.prepare(`SELECT DISTINCT o.item_id FROM observations o JOIN observation_photos op ON op.observation_id=o.id
      WHERE op.capture_id=? AND op.photo_id=? AND o.item_id IS NOT NULL`).all(captureId, photoId) as { item_id: string }[];
    db.prepare('UPDATE capture_photo_history SET dismissed_at=?,preview_jpeg=NULL,width=NULL,height=NULL WHERE capture_id=? AND photo_id=?')
      .run(now, captureId, photoId);
    db.prepare('UPDATE observation_photos SET crop_jpeg=NULL,bbox_json=NULL WHERE capture_id=? AND photo_id=?').run(captureId, photoId);
    db.prepare(`UPDATE observations SET dismissed_at=? WHERE capture_id=? AND dismissed_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM observation_photos op JOIN capture_photo_history h ON h.capture_id=op.capture_id AND h.photo_id=op.photo_id
      WHERE op.observation_id=observations.id AND h.dismissed_at IS NULL)`).run(now, captureId);
    let removedItems = 0;
    for (const { item_id: itemId } of affected) {
      const item = db.prepare('SELECT * FROM bin_items WHERE id=?').get(itemId) as InventoryRow | undefined;
      if (!item || item.deleted_at) continue;
      const currentObservation = db.prepare(`SELECT o.created_at FROM observations o JOIN capture_batches c ON c.id=o.capture_id
        WHERE o.item_id=? AND o.capture_id=? AND c.state IN ('applied','superseded') ORDER BY o.created_at DESC LIMIT 1`)
        .get(itemId, item.last_seen_batch_id) as { created_at: string } | undefined;
      const surviving = db.prepare(`SELECT o.*,c.captured_at FROM observations o JOIN capture_batches c ON c.id=o.capture_id
        WHERE o.item_id=? AND o.dismissed_at IS NULL AND c.state IN ('applied','superseded')
          AND EXISTS (SELECT 1 FROM observation_photos op JOIN capture_photo_history h
            ON h.capture_id=op.capture_id AND h.photo_id=op.photo_id
            WHERE op.observation_id=o.id AND h.dismissed_at IS NULL)
        ORDER BY c.sequence DESC,o.created_at DESC,o.id DESC LIMIT 1`).get(itemId) as (ObservationRow & { captured_at: string }) | undefined;
      // Preserve manual content, but never retain a last-seen pointer to dismissed evidence.
      if (!currentObservation || captureTimestampMs(item.updated_at) > captureTimestampMs(currentObservation.created_at)) {
        refreshItemEvidence(itemId, surviving);
        continue;
      }
      const baseline = db.prepare('SELECT snapshot_json FROM capture_item_baselines WHERE item_id=?').get(itemId) as { snapshot_json: string } | undefined;
      let baselineUpdatedAt = Number.NaN;
      if (baseline) {
        try {
          const snapshot = JSON.parse(baseline.snapshot_json) as { updated_at?: string };
          baselineUpdatedAt = captureTimestampMs(snapshot.updated_at);
        } catch { /* Invalid baseline cannot supersede valid surviving evidence. */ }
      }
      if (surviving && baseline && baselineUpdatedAt > captureTimestampMs(surviving.created_at)
        && restoreBaseline(itemId, baseline.snapshot_json)) refreshItemEvidence(itemId, surviving);
      else if (surviving) restoreFromObservation(itemId, surviving);
      else if (item.capture_created) {
        db.prepare('UPDATE bin_items SET deleted_at=?,updated_at=? WHERE id=?').run(now, now, itemId);
        removedItems++;
      } else {
        if (!baseline || !restoreBaseline(itemId, baseline.snapshot_json)) {
          db.prepare("UPDATE bin_items SET last_seen_batch_id=NULL,last_seen_at=NULL,observation_state='unknown' WHERE id=?").run(itemId);
        } else refreshItemEvidence(itemId, undefined);
      }
    }
    // In-flight recognition must re-read the surviving item snapshot before applying.
    db.prepare('UPDATE bin_capture_state SET revision=revision+1 WHERE bin_id=?').run(batch.bin_id);
    db.prepare('UPDATE bins SET updated_at=? WHERE id=?').run(now, batch.bin_id);
    return { removed: true, removed_items: removedItems };
  }).immediate();
}
