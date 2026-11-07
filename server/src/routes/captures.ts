import { Router } from 'express';
import { query as execute } from '../db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { verifyBinAccess } from '../lib/binAccess.js';
import { cancelCapture } from '../lib/captures/cancel.js';
import { captureConfig, supportedMimeTypes } from '../lib/captures/config.js';
import { dismissObservation, dismissPhotoHistory, latestItemMedia, listPhotoHistory } from '../lib/captures/history.js';
import { refineItem } from '../lib/captures/refine.js';
import { authorizeCapture, captureStatus, completeCapture, createCapture, receivePhoto } from '../lib/captures/store.js';
import { NotFoundError, ValidationError } from '../lib/httpErrors.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/config', (_req, res) => {
  res.json({
    maxPhotos: captureConfig.maxPhotos,
    maxPhotoBytes: captureConfig.maxPhotoBytes,
    supportedMimeTypes,
    uploadExpiryMs: captureConfig.uploadExpiryMs,
    modelConfigured: !!(process.env.AI_ENDPOINT_URL && process.env.AI_MODEL && process.env.AI_API_KEY),
  });
});

router.get('/inventory', asyncHandler(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  const binId = typeof req.query.bin_id === 'string' ? req.query.bin_id : null;
  const locationId = typeof req.query.location_id === 'string' ? req.query.location_id : null;
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = (await execute(`SELECT i.id,i.name,i.description,i.aliases_json,i.quantity,
    i.bin_id,b.name AS bin_name,l.name AS location_name,a.name AS area_name,
    i.last_seen_at,i.last_seen_batch_id,i.observation_state
    FROM bin_items i JOIN bins b ON b.id = i.bin_id
    JOIN locations l ON l.id = b.location_id
    JOIN location_members lm ON lm.location_id = b.location_id AND lm.user_id = $1
    LEFT JOIN areas a ON a.id = b.area_id
    WHERE i.deleted_at IS NULL AND b.deleted_at IS NULL
      AND (b.visibility = 'location' OR b.created_by = $2)
      AND (CAST($3 AS TEXT) IS NULL OR b.id = $4) AND (CAST($5 AS TEXT) IS NULL OR b.location_id = $6)
      AND ($7 = '' OR LOWER(i.name) LIKE LOWER($8) ESCAPE '\\' OR LOWER(i.description) LIKE LOWER($9) ESCAPE '\\'
        OR LOWER(i.aliases_json) LIKE LOWER($10) ESCAPE '\\' OR LOWER(b.name) LIKE LOWER($11) ESCAPE '\\')
    ORDER BY i.last_seen_at DESC NULLS LAST, i.name LIMIT 200`, [
    req.user!.id,
    req.user!.id,
    binId,
    binId,
    locationId,
    locationId,
    q,
    pattern,
    pattern,
    pattern,
    pattern,
  ])).rows as Record<string, unknown>[];
  const items = await Promise.all(rows.map(async ({ aliases_json, ...item }) => {
    let aliases: string[] = [];
    try { aliases = JSON.parse(String(aliases_json)); } catch { /* Legacy metadata. */ }
    return { ...item, aliases, ...await latestItemMedia(String(item.id)) };
  }));
  res.json({ items });
}));

router.get('/history', asyncHandler(async (req, res) => {
  const binId = typeof req.query.bin_id === 'string' ? req.query.bin_id : null;
  const locationId = typeof req.query.location_id === 'string' ? req.query.location_id : null;
  res.json({ photos: await listPhotoHistory(req.user!.id, binId, locationId) });
}));

router.post('/items/:itemId/refine', asyncHandler(async (req, res) => {
  res.json(await refineItem('items', req.params.itemId, req.body?.instruction, req.user!.id));
}));

router.post('/observations/:observationId/refine', asyncHandler(async (req, res) => {
  res.json(await refineItem('observations', req.params.observationId, req.body?.instruction, req.user!.id));
}));

router.get('/:id/photos/:photoId/preview', asyncHandler(async (req, res) => {
  if ((await authorizeCapture(req.params.id, req.user!.id)).cancelled_at) throw new NotFoundError('Photo preview not available');
  const row = (await execute(`SELECT preview_jpeg FROM capture_photo_history
    WHERE capture_id=$1 AND photo_id=$2 AND dismissed_at IS NULL AND preview_jpeg IS NOT NULL`, [req.params.id, req.params.photoId])).rows[0] as { preview_jpeg: Buffer } | undefined;
  if (!row) throw new NotFoundError('Photo preview not available');
  res.type('image/jpeg').send(row.preview_jpeg);
}));

router.get('/observations/:observationId/photos/:photoId/crop', asyncHandler(async (req, res) => {
  const row = (await execute(`SELECT op.capture_id,op.crop_jpeg FROM observation_photos op
    JOIN observations o ON o.id=op.observation_id
    JOIN capture_photo_history h ON h.capture_id=op.capture_id AND h.photo_id=op.photo_id
    WHERE op.observation_id=$1 AND op.photo_id=$2 AND op.crop_jpeg IS NOT NULL
      AND o.dismissed_at IS NULL AND h.dismissed_at IS NULL`, [req.params.observationId, req.params.photoId])).rows[0] as { capture_id: string; crop_jpeg: Buffer } | undefined;
  if (!row) throw new NotFoundError('Item crop not available');
  if ((await authorizeCapture(row.capture_id, req.user!.id)).cancelled_at) throw new NotFoundError('Item crop not available');
  res.type('image/jpeg').send(row.crop_jpeg);
}));

router.delete('/:id/photos/:photoId/history', asyncHandler(async (req, res) => {
  res.json(await dismissPhotoHistory(req.params.id, req.params.photoId, req.user!.id));
}));

router.delete('/observations/:observationId', asyncHandler(async (req, res) => {
  res.json(await dismissObservation(req.params.observationId, req.user!.id));
}));

router.get('/', asyncHandler(async (req, res) => {
  const binId = typeof req.query.bin_id === 'string' ? req.query.bin_id : null;
  if (binId && !(await verifyBinAccess(binId, req.user!.id))) throw new NotFoundError('Storage location not found');
  const captures = (await execute(`SELECT c.id FROM capture_batches c
    JOIN bins b ON b.id = c.bin_id
    JOIN location_members lm ON lm.location_id = b.location_id AND lm.user_id = $1
    WHERE b.deleted_at IS NULL AND c.cancelled_at IS NULL AND (b.visibility = 'location' OR b.created_by = $2)
      AND (CAST($3 AS TEXT) IS NULL OR c.bin_id = $4)
      AND (NOT EXISTS (SELECT 1 FROM capture_photos p WHERE p.capture_id=c.id)
        OR EXISTS (SELECT 1 FROM capture_photos p LEFT JOIN capture_photo_history h
          ON h.capture_id=p.capture_id AND h.photo_id=p.id
          WHERE p.capture_id=c.id AND h.dismissed_at IS NULL))
    ORDER BY c.created_at DESC, c.sequence DESC LIMIT 30`, [req.user!.id, req.user!.id, binId, binId])).rows as { id: string }[];
  res.json({ captures: await Promise.all(captures.map(({ id }) => captureStatus(id))) });
}));

router.post('/', asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ValidationError('Capture details are required');
  res.status(201).json(await createCapture(req.body, req.user!.id));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  await authorizeCapture(req.params.id, req.user!.id);
  res.json(await captureStatus(req.params.id));
}));

// Body remains a bounded stream; image data never goes through JSON or logs.
router.put('/:id/photos/:photoId', asyncHandler(async (req, res) => {
  res.json(await receivePhoto(req, req.params.id, req.params.photoId, req.user!.id));
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  res.json(await cancelCapture(req.params.id, req.user!.id, req.body?.bin_id));
}));

router.post('/:id/complete', asyncHandler(async (req, res) => {
  res.json(await completeCapture(req.params.id, req.body?.photos, req.user!.id));
}));

export default router;
