import crypto from 'node:crypto';
import { getDb } from '../../db.js';
import { canStoreHistoryBytes, captureTimestampMs } from './history.js';
import type { ObservationMedia } from './media.js';
import type { ExistingCaptureItem, RecognitionResult } from './recognition.js';
import { CAPTURE_PROMPT_VERSION, CaptureProcessingError, normalizeItemName } from './recognition.js';

export interface ClaimedCapture {
  jobId: string;
  captureId: string;
  binId: string;
  binName: string;
  createdBy: string;
  sequence: number;
  capturedAt: string;
  revision: number;
  leaseToken: string;
  attempts: number;
  existingItems: ExistingCaptureItem[];
}

export function readExistingCaptureItems(binId: string): ExistingCaptureItem[] {
  return (getDb().prepare(`SELECT id,name,description,aliases_json,quantity FROM bin_items
    WHERE bin_id=? AND deleted_at IS NULL ORDER BY position,id`).all(binId) as Array<{
    id: string; name: string; description: string; aliases_json: string; quantity: number | null;
  }>).map((item) => {
    let aliases: string[] = [];
    try {
      const parsed: unknown = JSON.parse(item.aliases_json);
      if (Array.isArray(parsed)) aliases = parsed.filter((value): value is string => typeof value === 'string').slice(0, 12);
    } catch { /* Old metadata cannot prevent a new observation. */ }
    return { id: item.id, name: item.name, description: item.description, aliases, quantity: item.quantity };
  });
}

/** Check before inference and again at commit, since permissions can change while the model runs. */
export function assertCaptureWritable(claim: ClaimedCapture): void {
  const access = getDb().prepare(`SELECT b.created_by,lm.role FROM bins b
    JOIN users u ON u.id=? AND u.deleted_at IS NULL AND u.suspended_at IS NULL
    JOIN location_members lm ON lm.location_id=b.location_id AND lm.user_id=u.id
    WHERE b.id=? AND b.deleted_at IS NULL AND (b.visibility!='private' OR b.created_by=u.id)`)
    .get(claim.createdBy, claim.binId) as { created_by: string; role: string } | undefined;
  if (!access || (access.role !== 'admin' && !(access.role === 'member' && access.created_by === claim.createdBy))) {
    throw new CaptureProcessingError('access_revoked', false);
  }
}

/** Applies observations, stable inventory records and the job result as one short SQLite transaction. */
export function commitRecognition(
  claim: ClaimedCapture, result: RecognitionResult, now = new Date(), media: ObservationMedia[][] = [],
): 'applied' | 'superseded' {
  const db = getDb();
  return db.transaction(() => {
    const timestamp = now.toISOString();
    const job = db.prepare('SELECT state,lease_token,lease_until FROM analysis_jobs WHERE id=?').get(claim.jobId) as
      { state: string; lease_token: string | null; lease_until: string | null } | undefined;
    if (!job || job.state !== 'processing' || job.lease_token !== claim.leaseToken || !job.lease_until || job.lease_until <= timestamp) {
      throw new CaptureProcessingError('worker_interrupted');
    }
    assertCaptureWritable(claim);
    // Old jobs may predate preview storage. Preserve their photo-level evidence,
    // without recreating images or reviving a photo dismissed during inference.
    db.prepare(`INSERT OR IGNORE INTO capture_photo_history (capture_id,photo_id)
      SELECT capture_id,id FROM capture_photos WHERE capture_id=?`).run(claim.captureId);
    const activePhotos = new Set((db.prepare(`SELECT photo_id FROM capture_photo_history
      WHERE capture_id=? AND dismissed_at IS NULL`).all(claim.captureId) as { photo_id: string }[]).map((p) => p.photo_id));
    const current = db.prepare('SELECT revision,latest_applied_sequence FROM bin_capture_state WHERE bin_id=?')
      .get(claim.binId) as { revision: number; latest_applied_sequence: number };
    const superseded = claim.sequence <= current.latest_applied_sequence;
    const applyInventory = !superseded && activePhotos.size > 0;
    if (applyInventory && current.revision !== claim.revision) throw new CaptureProcessingError('revision_conflict');

    const existing = new Map(readExistingCaptureItems(claim.binId).map((item) => [item.id, item]));
    if (applyInventory && result.items.some((item) => item.photo_ids.some((id) => activePhotos.has(id))
      && item.existing_item_id && !existing.has(item.existing_item_id))) {
      throw new CaptureProcessingError('revision_conflict');
    }
    if (applyInventory) {
      db.prepare(`UPDATE bin_items SET observation_state='not_seen_in_latest_capture'
        WHERE bin_id=? AND deleted_at IS NULL`).run(claim.binId);
    }
    let position = (db.prepare('SELECT COALESCE(MAX(position),-1) AS position FROM bin_items WHERE bin_id=?')
      .get(claim.binId) as { position: number }).position + 1;
    for (const [index, item] of result.items.entries()) {
      const photoIds = item.photo_ids.filter((id) => activePhotos.has(id));
      if (!photoIds.length) continue;
      const old = item.existing_item_id ? existing.get(item.existing_item_id) : undefined;
      let itemId: string | null = old?.id ?? null;
      const aliases = [...new Set([
        ...item.aliases, ...(old?.aliases ?? []), ...(old && old.name !== item.name ? [old.name] : []),
      ].filter(Boolean))].slice(0, 12);
      if (applyInventory) {
        if (old) {
          const original = db.prepare(`SELECT name,quantity,normalized_name,aliases_json,description,
            last_seen_batch_id,last_seen_at,observation_state,updated_at,capture_created FROM bin_items
            WHERE id=?`).get(old.id) as { updated_at: string; last_seen_batch_id: string | null; capture_created: number };
          const prior = db.prepare(`SELECT created_at FROM observations WHERE item_id=? AND capture_id=?
            ORDER BY created_at DESC LIMIT 1`).get(old.id, original.last_seen_batch_id) as { created_at: string } | undefined;
          const manuallyEdited = !prior || captureTimestampMs(original.updated_at) > captureTimestampMs(prior.created_at);
          if (!original.capture_created || manuallyEdited) {
            if (manuallyEdited) {
              db.prepare(`INSERT INTO capture_item_baselines (item_id,snapshot_json) VALUES (?,?)
                ON CONFLICT(item_id) DO UPDATE SET snapshot_json=excluded.snapshot_json`).run(old.id, JSON.stringify(original));
              // A later manual edit gives an automatically-created item its own provenance.
              db.prepare('UPDATE bin_items SET capture_created=0 WHERE id=?').run(old.id);
            } else {
              db.prepare('INSERT OR IGNORE INTO capture_item_baselines (item_id,snapshot_json) VALUES (?,?)')
                .run(old.id, JSON.stringify(original));
            }
          }
          db.prepare(`UPDATE bin_items SET name=?,quantity=?,normalized_name=?,aliases_json=?,description=?,
            last_seen_batch_id=?,last_seen_at=?,observation_state='seen',updated_at=? WHERE id=? AND bin_id=?`)
            .run(item.name, item.quantity, normalizeItemName(item.name), JSON.stringify(aliases), item.description,
              claim.captureId, claim.capturedAt, timestamp, old.id, claim.binId);
        } else {
          itemId = crypto.randomUUID();
          db.prepare(`INSERT INTO bin_items
            (id,bin_id,name,quantity,position,normalized_name,aliases_json,description,last_seen_batch_id,last_seen_at,observation_state,created_at,updated_at,capture_created)
            VALUES (?,?,?,?,?,?,?,?,?,?,'seen',?,?,1)`)
            .run(itemId, claim.binId, item.name, item.quantity, position++, normalizeItemName(item.name),
              JSON.stringify(aliases), item.description, claim.captureId, claim.capturedAt, timestamp, timestamp);
        }
      }
      const observationId = crypto.randomUUID();
      db.prepare(`INSERT INTO observations (id,capture_id,item_id,name,description,quantity,aliases_json,photo_ids_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(observationId, claim.captureId, itemId, item.name, item.description, item.quantity,
          JSON.stringify(aliases), JSON.stringify(photoIds), timestamp);
      for (const photoId of photoIds) {
        const crop = media[index]?.find((entry) => entry.photoId === photoId);
        const image = crop && canStoreHistoryBytes(crop.jpeg.length) ? crop.jpeg : null;
        db.prepare(`INSERT INTO observation_photos (observation_id,capture_id,photo_id,bbox_json,crop_jpeg)
          VALUES (?,?,?,?,?)`).run(observationId, claim.captureId, photoId, crop ? JSON.stringify(crop.box) : null, image);
      }
    }
    const state = superseded ? 'superseded' : 'applied';
    if (applyInventory) {
      db.prepare(`UPDATE bin_capture_state SET revision=revision+1,latest_applied_sequence=? WHERE bin_id=?`)
        .run(claim.sequence, claim.binId);
      db.prepare('UPDATE bins SET updated_at=? WHERE id=?').run(timestamp, claim.binId);
    }
    db.prepare(`UPDATE analysis_jobs SET state=?,lease_until=NULL,lease_token=NULL,error_category=NULL,
      prompt_version=?,updated_at=? WHERE id=?`).run(state, CAPTURE_PROMPT_VERSION, timestamp, claim.jobId);
    db.prepare('UPDATE capture_batches SET state=?,updated_at=? WHERE id=?').run(state, timestamp, claim.captureId);
    return state;
  }).immediate();
}
