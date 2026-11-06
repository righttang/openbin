import { query } from '../../db.js';
import { requireCreatorOrAdmin, requireMemberOrAbove, verifyBinAccess } from '../binAccess.js';
import { NotFoundError, ValidationError } from '../httpErrors.js';
import { abortCaptureActivity, cleanupCapture } from './cleanup.js';
import { withCaptureTransaction } from './database.js';
import { dismissPhotoEvidence } from './history.js';
import { captureStatus } from './store.js';
import type { CaptureBatch } from './types.js';

/** Cancellation also records IDs whose create request has not reached us yet. */
export async function cancelCapture(id: string, userId: string, requestedBinId?: unknown) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new ValidationError('Invalid capture ID');
  const known = (await query<CaptureBatch>('SELECT * FROM capture_batches WHERE id=$1', [id])).rows[0];
  const binId = known?.bin_id ?? requestedBinId;
  if (typeof binId !== 'string' || !binId) throw new ValidationError('bin_id is required when the capture has not been created');
  if (known && known.created_by !== userId) throw new NotFoundError('Capture not found');
  if (requestedBinId != null && requestedBinId !== binId) throw new NotFoundError('Capture not found');
  const access = await verifyBinAccess(binId, userId);
  if (!access) throw new NotFoundError('Capture not found');
  await requireMemberOrAbove(access.locationId, userId, 'cancel capture');
  await requireCreatorOrAdmin(access.locationId, userId, access.createdBy, 'cancel capture');

  const outcome = await withCaptureTransaction(async execute => {
    const batch = (await execute<CaptureBatch>('SELECT * FROM capture_batches WHERE id=$1', [id])).rows[0];
    const tombstone = (await execute<{ created_by: string; bin_id: string; cancelled_at: string }>(
      'SELECT created_by,bin_id,cancelled_at FROM capture_cancellations WHERE id=$1', [id],
    )).rows[0];
    if ((batch && (batch.created_by !== userId || batch.bin_id !== binId))
      || (tombstone && (tombstone.created_by !== userId || tombstone.bin_id !== binId))) {
      throw new NotFoundError('Capture not found');
    }
    const cancelledAt = batch?.cancelled_at ?? tombstone?.cancelled_at ?? new Date().toISOString();
    let removedItems = 0;
    if (batch && !batch.cancelled_at) {
      const photos = await execute<{ id: string }>('SELECT id FROM capture_photos WHERE capture_id=$1 ORDER BY position,id', [id]);
      // Keep the old successful state while retracting evidence: otherwise an
      // automatic item could be mistaken for a manual item and survive removal.
      for (const photo of photos.rows) {
        removedItems += (await dismissPhotoEvidence(id, photo.id, binId, execute)).removed_items;
      }
      await execute(`UPDATE capture_batches SET cancelled_at=$1,state='expired',expires_at=$1,updated_at=$1,
        cleanup_completed_at=NULL WHERE id=$2`, [cancelledAt, id]);
      await execute(`UPDATE analysis_jobs SET state='failed',lease_token=NULL,lease_until=NULL,
        error_category='capture_cancelled',updated_at=$1 WHERE capture_id=$2`, [cancelledAt, id]);
    }
    await execute(`INSERT INTO capture_cancellations (id,bin_id,created_by,cancelled_at)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [id, binId, userId, cancelledAt]);
    return { exists: !!batch, cancelledAt, removedItems };
  });
  abortCaptureActivity(id);
  await cleanupCapture(id);
  if (outcome.exists) return { ...await captureStatus(id), removed_items: outcome.removedItems };
  return { id, bin_id: binId, state: 'cancelled' as const, cancelled_at: outcome.cancelledAt, photos: [], removed_items: 0 };
}
