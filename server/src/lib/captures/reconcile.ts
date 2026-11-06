import crypto from 'node:crypto';
import { query, type TxQueryFn } from '../../db.js';
import { withCaptureTransaction } from './database.js';
import { baselineCaptureVersion, canStoreHistoryBytes, captureTimestampMs, compareCaptureVersions, sameCaptureContent, saveManualCaptureBaseline } from './history.js';
import type { ObservationMedia } from './media.js';
import type { ExistingCaptureItem, RecognitionResult } from './recognition.js';
import { CAPTURE_PROMPT_VERSION, CaptureProcessingError, normalizeItemName } from './recognition.js';

export interface ClaimedCapture {
  jobId: string;
  captureId: string;
  binId: string;
  binName: string;
  createdBy: string;
  source: string;
  sequence: number;
  capturedAt: string;
  revision: number;
  leaseToken: string;
  attempts: number;
  existingItems: ExistingCaptureItem[];
}

export async function readExistingCaptureItems(binId: string, execute: TxQueryFn = query): Promise<ExistingCaptureItem[]> {
  return ((await execute(`SELECT id,name,description,aliases_json,quantity FROM bin_items
    WHERE bin_id=$1 AND deleted_at IS NULL ORDER BY position,id`, [binId])).rows as Array<{
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
export async function assertCaptureWritable(claim: ClaimedCapture, execute: TxQueryFn = query): Promise<void> {
  const batch = (await execute<{ cancelled_at: string | null }>('SELECT cancelled_at FROM capture_batches WHERE id=$1', [claim.captureId])).rows[0];
  if (batch?.cancelled_at) throw new CaptureProcessingError('capture_cancelled', false);
  const access = (await execute(`SELECT b.created_by,lm.role FROM bins b
    JOIN users u ON u.id=$1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL
    JOIN location_members lm ON lm.location_id=b.location_id AND lm.user_id=u.id
    WHERE b.id=$2 AND b.deleted_at IS NULL AND (b.visibility!='private' OR b.created_by=u.id)`, [claim.createdBy, claim.binId])).rows[0] as { created_by: string; role: string } | undefined;
  if (!access || (access.role !== 'admin' && !(access.role === 'member' && access.created_by === claim.createdBy))) {
    throw new CaptureProcessingError('access_revoked', false);
  }
}

/** Applies observations, stable inventory records and the job result as one short transaction. */
export async function commitRecognition(
  claim: ClaimedCapture, result: RecognitionResult, now = new Date(), media: ObservationMedia[][] = [],
): Promise<'applied' | 'superseded'> {
  return withCaptureTransaction(async (execute) => {
    const timestamp = now.toISOString();
    const job = (await execute('SELECT state,lease_token,lease_until FROM analysis_jobs WHERE id=$1', [claim.jobId])).rows[0] as
      { state: string; lease_token: string | null; lease_until: string | null } | undefined;
    if (!job || job.state !== 'processing' || job.lease_token !== claim.leaseToken || !job.lease_until || job.lease_until <= timestamp) {
      throw new CaptureProcessingError('worker_interrupted');
    }
    await assertCaptureWritable(claim, execute);
    // Old jobs may predate preview storage. Preserve their photo-level evidence,
    // without recreating images or reviving a photo dismissed during inference.
    await execute(`INSERT INTO capture_photo_history (capture_id,photo_id)
      SELECT capture_id,id FROM capture_photos WHERE capture_id=$1 ON CONFLICT DO NOTHING`, [claim.captureId]);
    const activePhotos = new Set(((await execute(`SELECT photo_id FROM capture_photo_history
      WHERE capture_id=$1 AND dismissed_at IS NULL`, [claim.captureId])).rows as { photo_id: string }[]).map((p) => p.photo_id));
    const current = (await execute('SELECT revision,latest_applied_sequence FROM bin_capture_state WHERE bin_id=$1', [claim.binId])).rows[0] as { revision: number; latest_applied_sequence: number };
    const instant = claim.source === 'web-instant';
    const superseded = !instant && claim.sequence <= current.latest_applied_sequence;
    const applyInventory = !superseded && activePhotos.size > 0;
    if (applyInventory && current.revision !== claim.revision) throw new CaptureProcessingError('revision_conflict');

    const existing = new Map((await readExistingCaptureItems(claim.binId, execute)).map((item) => [item.id, item]));
    if (applyInventory && result.items.some((item) => item.photo_ids.some((id) => activePhotos.has(id))
      && item.existing_item_id && !existing.has(item.existing_item_id))) {
      throw new CaptureProcessingError('revision_conflict');
    }
    if (applyInventory && !instant) {
      await execute(`UPDATE bin_items SET observation_state='not_seen_in_latest_capture'
        WHERE bin_id=$1 AND deleted_at IS NULL`, [claim.binId]);
    }
    let position = ((await execute('SELECT COALESCE(MAX(position),-1) AS position FROM bin_items WHERE bin_id=$1', [claim.binId])).rows[0] as { position: number }).position + 1;
    for (const [index, item] of result.items.entries()) {
      const photoIds = item.photo_ids.filter((id) => activePhotos.has(id));
      if (!photoIds.length) continue;
      const old = item.existing_item_id ? existing.get(item.existing_item_id) : undefined;
      let itemId: string | null = old?.id ?? null;
      const aliases = [...new Set([
        ...item.aliases, ...(old?.aliases ?? []), ...(old && old.name !== item.name ? [old.name] : []),
      ].filter(Boolean))].slice(0, 12);
      // An older instant photo can contribute its own evidence and new items,
      // but must not overwrite a newer photo's fields for a shared item.
      let applyItem = applyInventory;
      if (instant && old) {
        const currentItem = (await execute<{
          name: string; description: string; quantity: number | null; aliases_json: string;
          updated_at: string; sequence: number | null; captured_at: string | null; snapshot_json: string | null;
        }>(`SELECT i.name,i.description,i.quantity,i.aliases_json,i.updated_at,c.sequence,c.captured_at,bl.snapshot_json
          FROM bin_items i LEFT JOIN capture_batches c ON c.id=i.last_seen_batch_id
          LEFT JOIN capture_item_baselines bl ON bl.item_id=i.id WHERE i.id=$1`, [old.id])).rows[0];
        let existingVersion = { sequence: currentItem?.sequence ?? 0, captured_at: currentItem?.captured_at ?? null };
        if (currentItem?.snapshot_json) {
          let baseline: Record<string, unknown> | undefined;
          try { baseline = JSON.parse(currentItem.snapshot_json); } catch { /* Ignore invalid legacy metadata. */ }
          if (baseline?.updated_at === currentItem.updated_at && sameCaptureContent(currentItem, baseline)) {
            const baselineVersion = await baselineCaptureVersion(baseline, execute);
            if (compareCaptureVersions(baselineVersion, existingVersion) > 0) existingVersion = baselineVersion;
          }
        }
        applyItem = applyItem && compareCaptureVersions({ sequence: claim.sequence, captured_at: claim.capturedAt }, existingVersion) >= 0;
      }
      if (applyItem) {
        if (old) {
          const original = (await execute(`SELECT name,quantity,normalized_name,aliases_json,description,
            last_seen_batch_id,last_seen_at,observation_state,updated_at,capture_created FROM bin_items
            WHERE id=$1`, [old.id])).rows[0] as { name: string; description: string; quantity: number | null; aliases_json: string; updated_at: string; last_seen_batch_id: string | null; capture_created: number };
          const prior = (await execute(`SELECT name,description,quantity,aliases_json,created_at FROM observations WHERE item_id=$1 AND capture_id=$2
            ORDER BY created_at DESC LIMIT 1`, [old.id, original.last_seen_batch_id])).rows[0] as { name: string; description: string; quantity: number | null; aliases_json: string; created_at: string } | undefined;
          const manuallyEdited = !prior || !sameCaptureContent(original, prior) || captureTimestampMs(original.updated_at) > captureTimestampMs(prior.created_at);
          if (!original.capture_created || manuallyEdited) {
            if (manuallyEdited) {
              await saveManualCaptureBaseline(old.id, { ...original }, execute);
              // A later manual edit gives an automatically-created item its own provenance.
              await execute('UPDATE bin_items SET capture_created=0 WHERE id=$1', [old.id]);
            } else {
              await execute('INSERT INTO capture_item_baselines (item_id,snapshot_json) VALUES ($1,$2) ON CONFLICT DO NOTHING', [old.id, JSON.stringify(original)]);
            }
          }
          await execute(`UPDATE bin_items SET name=$1,quantity=$2,normalized_name=$3,aliases_json=$4,description=$5,
            last_seen_batch_id=$6,last_seen_at=$7,observation_state='seen',updated_at=$8 WHERE id=$9 AND bin_id=$10`, [
            item.name,
            item.quantity,
            normalizeItemName(item.name),
            JSON.stringify(aliases),
            item.description,
            claim.captureId,
            claim.capturedAt,
            timestamp,
            old.id,
            claim.binId,
          ]);
        } else {
          itemId = crypto.randomUUID();
          await execute(`INSERT INTO bin_items
            (id,bin_id,name,quantity,position,normalized_name,aliases_json,description,last_seen_batch_id,last_seen_at,observation_state,created_at,updated_at,capture_created)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'seen',$11,$12,1)`, [
            itemId,
            claim.binId,
            item.name,
            item.quantity,
            position++,
            normalizeItemName(item.name),
            JSON.stringify(aliases),
            item.description,
            claim.captureId,
            claim.capturedAt,
            timestamp,
            timestamp,
          ]);
        }
      }
      const observationId = crypto.randomUUID();
      await execute(`INSERT INTO observations (id,capture_id,item_id,name,description,quantity,aliases_json,photo_ids_json,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
        observationId,
        claim.captureId,
        itemId,
        item.name,
        item.description,
        item.quantity,
        JSON.stringify(aliases),
        JSON.stringify(photoIds),
        timestamp,
      ]);
      for (const photoId of photoIds) {
        const crop = media[index]?.find((entry) => entry.photoId === photoId);
        const image = crop && await canStoreHistoryBytes(crop.jpeg.length, execute) ? crop.jpeg : null;
        await execute(`INSERT INTO observation_photos (observation_id,capture_id,photo_id,bbox_json,crop_jpeg)
          VALUES ($1,$2,$3,$4,$5)`, [observationId, claim.captureId, photoId, crop ? JSON.stringify(crop.box) : null, image]);
      }
    }
    const state = superseded ? 'superseded' : 'applied';
    if (applyInventory) {
      await execute(`UPDATE bin_capture_state SET revision=revision+1,latest_applied_sequence=$1 WHERE bin_id=$2`, [Math.max(claim.sequence, current.latest_applied_sequence), claim.binId]);
      await execute('UPDATE bins SET updated_at=$1 WHERE id=$2', [timestamp, claim.binId]);
    }
    await execute(`UPDATE analysis_jobs SET state=$1,lease_until=NULL,lease_token=NULL,error_category=NULL,
      prompt_version=$2,updated_at=$3 WHERE id=$4`, [state, CAPTURE_PROMPT_VERSION, timestamp, claim.jobId]);
    await execute('UPDATE capture_batches SET state=$1,updated_at=$2 WHERE id=$3', [state, timestamp, claim.captureId]);
    return state;
  });
}
