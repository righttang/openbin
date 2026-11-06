import fs from 'node:fs';
import path from 'node:path';
import { getDialect, query, type TxQueryFn } from '../../db.js';
import { requireCreatorOrAdmin, requireMemberOrAbove, verifyBinAccess } from '../binAccess.js';
import { config } from '../config.js';
import { NotFoundError } from '../httpErrors.js';
import { captureConfig } from './config.js';
import { withCaptureTransaction } from './database.js';
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

type CaptureContent = { name?: unknown; description?: unknown; quantity?: unknown; aliases_json?: unknown };

export function sameCaptureContent(left: CaptureContent, right: CaptureContent): boolean {
  return left.name === right.name && left.description === right.description
    && left.quantity === right.quantity && left.aliases_json === right.aliases_json;
}

/** Manual baselines retain the item-specific evidence version even after its photo is cancelled. */
export async function baselineCaptureSequence(snapshot: Record<string, unknown>, execute: TxQueryFn): Promise<number> {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 0;
  const recorded = Number(snapshot.capture_sequence);
  const source = typeof snapshot.last_seen_batch_id === 'string'
    ? (await execute<{ sequence: number }>('SELECT sequence FROM capture_batches WHERE id=$1', [snapshot.last_seen_batch_id])).rows[0]?.sequence ?? 0
    : 0;
  return Math.max(Number.isSafeInteger(recorded) && recorded >= 0 ? recorded : 0, source);
}

export async function saveManualCaptureBaseline(itemId: string, snapshot: Record<string, unknown>, execute: TxQueryFn): Promise<void> {
  const prior = (await execute<{ snapshot_json: string }>('SELECT snapshot_json FROM capture_item_baselines WHERE item_id=$1', [itemId])).rows[0];
  let previous: Record<string, unknown> = {};
  try { previous = JSON.parse(prior?.snapshot_json ?? '{}'); } catch { /* Ignore invalid legacy metadata. */ }
  const sequence = Math.max(await baselineCaptureSequence(snapshot, execute), await baselineCaptureSequence(previous, execute));
  await execute(`INSERT INTO capture_item_baselines (item_id,snapshot_json) VALUES ($1,$2)
    ON CONFLICT(item_id) DO UPDATE SET snapshot_json=excluded.snapshot_json`, [itemId, JSON.stringify({ ...snapshot, capture_sequence: sequence })]);
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
export async function canStoreHistoryBytes(bytes: number, execute: TxQueryFn = query): Promise<boolean> {
  const configured = Number(process.env.CAPTURE_HISTORY_QUOTA_BYTES ?? 512 * 1024 * 1024);
  const quota = Number.isSafeInteger(configured) && configured >= 0 ? configured : 512 * 1024 * 1024;
  const { bytes: used } = (await execute(`SELECT
    (SELECT COALESCE(SUM(length(preview_jpeg)),0) FROM capture_photo_history) +
    (SELECT COALESCE(SUM(length(crop_jpeg)),0) FROM observation_photos) AS bytes`, [])).rows[0] as { bytes: number };
  if (!Number.isSafeInteger(bytes) || bytes < 0 || used + bytes > quota) return false;
  if (getDialect() === 'sqlite' && config.databasePath !== ':memory:') {
    try {
      const disk = fs.statfsSync(path.dirname(path.resolve(config.databasePath)));
      // SQLite's journal/WAL may temporarily duplicate the incoming image bytes.
      if (disk.bavail * disk.bsize < bytes * 3 + captureConfig.minFreeDiskBytes) return false;
    } catch { return false; }
  }
  return true;
}

export async function storePhotoPreview(
  captureId: string,
  photoId: string,
  preview: { jpeg: Buffer; width: number; height: number } | null,
  transaction?: TxQueryFn,
): Promise<void> {
  const store = async (execute: TxQueryFn) => {
    const batch = (await execute<{ cancelled_at: string | null }>('SELECT cancelled_at FROM capture_batches WHERE id=$1', [captureId])).rows[0];
    if (batch?.cancelled_at) return;
    await execute('INSERT INTO capture_photo_history (capture_id,photo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [captureId, photoId]);
    const current = (await execute('SELECT dismissed_at,length(preview_jpeg) AS size FROM capture_photo_history WHERE capture_id=$1 AND photo_id=$2', [captureId, photoId])).rows[0] as { dismissed_at: string | null; size: number | null };
    if (!preview || current.dismissed_at || preview.jpeg.length > 256 * 1024
      || !await canStoreHistoryBytes(Math.max(0, preview.jpeg.length - (current.size ?? 0)), execute)) return;
    await execute('UPDATE capture_photo_history SET preview_jpeg=$1,width=$2,height=$3 WHERE capture_id=$4 AND photo_id=$5 AND dismissed_at IS NULL', [preview.jpeg, preview.width, preview.height, captureId, photoId]);
  };
  if (transaction) await store(transaction);
  else await withCaptureTransaction(store);
}

export async function listPhotoHistory(userId: string, binId: string | null, locationId: string | null) {
  const execute = query;
  const rows = (await execute(`SELECT c.id AS capture_id,p.id AS photo_id,c.bin_id,b.name AS bin_name,
    l.name AS location_name,c.captured_at,c.state,c.sequence,
    (SELECT j.error_category FROM analysis_jobs j WHERE j.capture_id=c.id ORDER BY j.analysis_version DESC LIMIT 1) AS error_category,
    CASE WHEN h.preview_jpeg IS NOT NULL THEN 1 ELSE 0 END AS has_preview
    FROM capture_photos p JOIN capture_batches c ON c.id=p.capture_id
    JOIN bins b ON b.id=c.bin_id JOIN locations l ON l.id=b.location_id
    JOIN location_members lm ON lm.location_id=b.location_id AND lm.user_id=$1
    LEFT JOIN capture_photo_history h ON h.capture_id=p.capture_id AND h.photo_id=p.id
    WHERE b.deleted_at IS NULL AND (b.visibility='location' OR b.created_by=$2)
      AND p.received_at IS NOT NULL AND h.dismissed_at IS NULL AND c.cancelled_at IS NULL
      AND (CAST($3 AS TEXT) IS NULL OR b.id=$4) AND (CAST($5 AS TEXT) IS NULL OR l.id=$6)
    ORDER BY c.created_at DESC,c.sequence DESC,p.position,p.id LIMIT 100`, [userId, userId, binId, binId, locationId, locationId])).rows as HistoryPhotoRow[];
  const observationsSql = `SELECT o.id,o.item_id,o.name,o.description,o.aliases_json,o.quantity,
    CASE WHEN op.crop_jpeg IS NOT NULL THEN 1 ELSE 0 END AS has_crop
    FROM observation_photos op JOIN observations o ON o.id=op.observation_id
    WHERE op.capture_id=$1 AND op.photo_id=$2 AND o.dismissed_at IS NULL
    ORDER BY o.name,o.id`;
  return Promise.all(rows.map(async ({ has_preview, ...photo }) => ({
    ...photo,
    preview_url: has_preview ? previewUrl(photo.capture_id, photo.photo_id) : null,
    items: ((await execute(observationsSql, [photo.capture_id, photo.photo_id])).rows as Array<Pick<ObservationRow, 'id' | 'item_id' | 'name' | 'description' | 'aliases_json' | 'quantity'> & { has_crop: number }>).map(
      ({ id, aliases_json, has_crop, ...item }) => ({
        ...item, observation_id: id, aliases: aliases(aliases_json),
        crop_url: has_crop ? cropUrl(id, photo.photo_id) : null,
      }),
    ),
  })));
}

export async function latestItemMedia(itemId: string, execute: TxQueryFn = query) {
  const row = (await execute(`SELECT o.id AS observation_id,op.photo_id,op.capture_id,
    CASE WHEN op.crop_jpeg IS NOT NULL THEN 1 ELSE 0 END AS has_crop,
    CASE WHEN h.preview_jpeg IS NOT NULL THEN 1 ELSE 0 END AS has_preview
    FROM observations o JOIN capture_batches c ON c.id=o.capture_id
    JOIN observation_photos op ON op.observation_id=o.id
    JOIN capture_photo_history h ON h.capture_id=op.capture_id AND h.photo_id=op.photo_id
    WHERE o.item_id=$1 AND o.dismissed_at IS NULL AND h.dismissed_at IS NULL AND c.cancelled_at IS NULL AND c.state IN ('applied','superseded')
    ORDER BY c.sequence DESC,has_crop DESC,has_preview DESC,op.photo_id LIMIT 1`, [itemId])).rows[0] as {
      observation_id: string; photo_id: string; capture_id: string; has_crop: number; has_preview: number;
    } | undefined;
  return {
    observation_id: row?.observation_id ?? null,
    crop_url: row?.has_crop ? cropUrl(row.observation_id, row.photo_id) : null,
    photo_preview_url: row?.has_preview ? previewUrl(row.capture_id, row.photo_id) : null,
  };
}

async function restoreFromObservation(itemId: string, observation: ObservationRow & { captured_at: string }, execute: TxQueryFn) {
  await execute(`UPDATE bin_items SET name=$1,description=$2,quantity=$3,aliases_json=$4,normalized_name=$5,
    last_seen_batch_id=$6,last_seen_at=$7,observation_state='seen',updated_at=$8 WHERE id=$9`, [
    observation.name,
    observation.description,
    observation.quantity,
    observation.aliases_json,
    normalizeItemName(observation.name),
    observation.capture_id,
    observation.captured_at,
    observation.created_at,
    itemId,
  ]);
}

async function restoreBaseline(itemId: string, json: string, execute: TxQueryFn): Promise<boolean> {
  let value: Record<string, unknown>;
  try { value = JSON.parse(json); } catch { return false; }
  if (!value || typeof value.name !== 'string' || typeof value.description !== 'string' || typeof value.aliases_json !== 'string') return false;
  await execute(`UPDATE bin_items SET name=$1,description=$2,quantity=$3,aliases_json=$4,normalized_name=$5,
    last_seen_batch_id=$6,last_seen_at=$7,observation_state=$8,updated_at=$9 WHERE id=$10`, [
    value.name,
    value.description,
    value.quantity ?? null,
    value.aliases_json,
    normalizeItemName(value.name),
    value.last_seen_batch_id ?? null,
    value.last_seen_at ?? null,
    value.observation_state ?? 'unknown',
    value.updated_at,
    itemId,
  ]);
  return true;
}

async function refreshItemEvidence(itemId: string, observation: (ObservationRow & { captured_at: string }) | undefined, execute: TxQueryFn) {
  await execute('UPDATE bin_items SET last_seen_batch_id=$1,last_seen_at=$2,observation_state=$3 WHERE id=$4', [
    observation?.capture_id ?? null,
    observation?.captured_at ?? null,
    observation ? 'seen' : 'unknown',
    itemId,
  ]);
}

/** Remove this photo's evidence atomically; other photos continue to support shared items. */
export async function dismissPhotoHistory(captureId: string, photoId: string, userId: string) {
  const execute = query;
  const batch = (await execute('SELECT bin_id FROM capture_batches WHERE id=$1', [captureId])).rows[0] as { bin_id: string } | undefined;
  const access = batch ? await verifyBinAccess(batch.bin_id, userId) : null;
  if (!batch || !access) throw new NotFoundError('Photo record not found');
  await requireMemberOrAbove(access.locationId, userId, 'remove recognition history');
  await requireCreatorOrAdmin(access.locationId, userId, access.createdBy, 'remove recognition history');
  return withCaptureTransaction(execute => dismissPhotoEvidence(captureId, photoId, batch.bin_id, execute));
}

/** Caller owns one capture transaction, allowing all photos to be cancelled atomically. */
export async function dismissPhotoEvidence(captureId: string, photoId: string, binId: string, execute: TxQueryFn) {
  const photo = (await execute('SELECT id FROM capture_photos WHERE capture_id=$1 AND id=$2', [captureId, photoId])).rows[0];
  if (!photo) throw new NotFoundError('Photo record not found');
  await execute('INSERT INTO capture_photo_history (capture_id,photo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [captureId, photoId]);
  const existing = (await execute('SELECT dismissed_at FROM capture_photo_history WHERE capture_id=$1 AND photo_id=$2', [captureId, photoId])).rows[0] as { dismissed_at: string | null };
  if (existing.dismissed_at) return { removed: true, removed_items: 0 };
  const now = new Date().toISOString();
  const affected = (await execute(`SELECT DISTINCT o.item_id FROM observations o JOIN observation_photos op ON op.observation_id=o.id
    WHERE op.capture_id=$1 AND op.photo_id=$2 AND o.item_id IS NOT NULL`, [captureId, photoId])).rows as { item_id: string }[];
  await execute('UPDATE capture_photo_history SET dismissed_at=$1,preview_jpeg=NULL,width=NULL,height=NULL WHERE capture_id=$2 AND photo_id=$3', [now, captureId, photoId]);
  await execute('UPDATE observation_photos SET crop_jpeg=NULL,bbox_json=NULL WHERE capture_id=$1 AND photo_id=$2', [captureId, photoId]);
  await execute(`UPDATE observations SET dismissed_at=$1 WHERE capture_id=$2 AND dismissed_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM observation_photos op JOIN capture_photo_history h ON h.capture_id=op.capture_id AND h.photo_id=op.photo_id
    WHERE op.observation_id=observations.id AND h.dismissed_at IS NULL)`, [now, captureId]);
  let removedItems = 0;
  for (const { item_id: itemId } of affected) {
    const item = (await execute('SELECT * FROM bin_items WHERE id=$1', [itemId])).rows[0] as InventoryRow | undefined;
    if (!item || item.deleted_at) continue;
    const currentObservation = (await execute(`SELECT o.* FROM observations o JOIN capture_batches c ON c.id=o.capture_id
      WHERE o.item_id=$1 AND o.capture_id=$2 AND c.cancelled_at IS NULL AND c.state IN ('applied','superseded') ORDER BY o.created_at DESC LIMIT 1`, [itemId, item.last_seen_batch_id])).rows[0] as ObservationRow | undefined;
    const surviving = (await execute(`SELECT o.*,c.captured_at FROM observations o JOIN capture_batches c ON c.id=o.capture_id
      WHERE o.item_id=$1 AND o.dismissed_at IS NULL AND c.cancelled_at IS NULL AND c.state IN ('applied','superseded')
        AND EXISTS (SELECT 1 FROM observation_photos op JOIN capture_photo_history h
          ON h.capture_id=op.capture_id AND h.photo_id=op.photo_id
          WHERE op.observation_id=o.id AND h.dismissed_at IS NULL)
      ORDER BY c.sequence DESC,o.created_at DESC,o.id DESC LIMIT 1`, [itemId])).rows[0] as (ObservationRow & { captured_at: string }) | undefined;
    const baseline = (await execute('SELECT snapshot_json FROM capture_item_baselines WHERE item_id=$1', [itemId])).rows[0] as { snapshot_json: string } | undefined;
    let baselineSnapshot: Record<string, unknown> | undefined;
    if (baseline) {
      try { baselineSnapshot = JSON.parse(baseline.snapshot_json); } catch { /* Ignore invalid legacy metadata. */ }
    }
    const baselineUpdatedAt = captureTimestampMs(baselineSnapshot?.updated_at as string | undefined);
    const keepsManualBaseline = baselineSnapshot?.updated_at === item.updated_at && sameCaptureContent(item, baselineSnapshot);
    // A late older photo can have a newer processing timestamp than a manual
    // edit. Preserve explicit manual provenance when its evidence pointer moves.
    const manuallyEdited = !currentObservation || !sameCaptureContent(item, currentObservation)
      || captureTimestampMs(item.updated_at) > captureTimestampMs(currentObservation.created_at)
      || keepsManualBaseline;
    if (manuallyEdited) {
      if (!keepsManualBaseline) await saveManualCaptureBaseline(itemId, { ...item }, execute);
      await execute('UPDATE bin_items SET capture_created=0 WHERE id=$1', [itemId]);
      await refreshItemEvidence(itemId, surviving, execute);
      continue;
    }
    if (surviving && baseline && baselineUpdatedAt > captureTimestampMs(surviving.created_at)
      && await restoreBaseline(itemId, baseline.snapshot_json, execute)) await refreshItemEvidence(itemId, surviving, execute);
    else if (surviving) await restoreFromObservation(itemId, surviving, execute);
    else if (item.capture_created) {
      await execute('UPDATE bin_items SET deleted_at=$1,updated_at=$2 WHERE id=$3', [now, now, itemId]);
      removedItems++;
    } else {
      if (!baseline || !await restoreBaseline(itemId, baseline.snapshot_json, execute)) {
        await execute("UPDATE bin_items SET last_seen_batch_id=NULL,last_seen_at=NULL,observation_state='unknown' WHERE id=$1", [itemId]);
      } else await refreshItemEvidence(itemId, undefined, execute);
    }
  }
  // In-flight recognition must re-read the surviving item snapshot before applying.
  await execute('UPDATE bin_capture_state SET revision=revision+1 WHERE bin_id=$1', [binId]);
  await execute('UPDATE bins SET updated_at=$1 WHERE id=$2', [now, binId]);
  return { removed: true, removed_items: removedItems };
}
