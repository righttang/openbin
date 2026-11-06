import { Router } from 'express';
import { getDb } from '../db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { verifyBinAccess } from '../lib/binAccess.js';
import { captureConfig, supportedMimeTypes } from '../lib/captures/config.js';
import { dismissPhotoHistory, latestItemMedia, listPhotoHistory } from '../lib/captures/history.js';
import { authorizeCapture, captureStatus, completeCapture, createCapture, receivePhoto } from '../lib/captures/store.js';
import { config } from '../lib/config.js';
import { HttpError, NotFoundError, ValidationError } from '../lib/httpErrors.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (config.dbEngine !== 'sqlite') return next(new HttpError(503, 'SQLITE_REQUIRED', 'RemindMe capture requires SQLite in this release'));
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
  const rows = getDb().prepare(`SELECT i.id,i.name,i.description,i.aliases_json,i.quantity,
    i.bin_id,b.name AS bin_name,l.name AS location_name,a.name AS area_name,
    i.last_seen_at,i.last_seen_batch_id,i.observation_state
    FROM bin_items i JOIN bins b ON b.id = i.bin_id
    JOIN locations l ON l.id = b.location_id
    JOIN location_members lm ON lm.location_id = b.location_id AND lm.user_id = ?
    LEFT JOIN areas a ON a.id = b.area_id
    WHERE i.deleted_at IS NULL AND b.deleted_at IS NULL
      AND (b.visibility = 'location' OR b.created_by = ?)
      AND (? IS NULL OR b.id = ?) AND (? IS NULL OR b.location_id = ?)
      AND (? = '' OR i.name LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\'
        OR i.aliases_json LIKE ? ESCAPE '\\' OR b.name LIKE ? ESCAPE '\\')
    ORDER BY i.last_seen_at DESC, i.name LIMIT 200`).all(req.user!.id, req.user!.id,
    binId, binId, locationId, locationId, q, pattern, pattern, pattern, pattern) as Record<string, unknown>[];
  const items = rows.map(({ aliases_json, ...item }) => {
    let aliases: string[] = [];
    try { aliases = JSON.parse(String(aliases_json)); } catch { /* Legacy metadata. */ }
    return { ...item, aliases, ...latestItemMedia(String(item.id)) };
  });
  res.json({ items });
}));

router.get('/history', asyncHandler(async (req, res) => {
  const binId = typeof req.query.bin_id === 'string' ? req.query.bin_id : null;
  const locationId = typeof req.query.location_id === 'string' ? req.query.location_id : null;
  res.json({ photos: listPhotoHistory(req.user!.id, binId, locationId) });
}));

router.get('/:id/photos/:photoId/preview', asyncHandler(async (req, res) => {
  await authorizeCapture(req.params.id, req.user!.id);
  const row = getDb().prepare(`SELECT preview_jpeg FROM capture_photo_history
    WHERE capture_id=? AND photo_id=? AND dismissed_at IS NULL AND preview_jpeg IS NOT NULL`)
    .get(req.params.id, req.params.photoId) as { preview_jpeg: Buffer } | undefined;
  if (!row) throw new NotFoundError('Photo preview not available');
  res.type('image/jpeg').send(row.preview_jpeg);
}));

router.get('/observations/:observationId/photos/:photoId/crop', asyncHandler(async (req, res) => {
  const row = getDb().prepare(`SELECT op.capture_id,op.crop_jpeg FROM observation_photos op
    JOIN observations o ON o.id=op.observation_id
    JOIN capture_photo_history h ON h.capture_id=op.capture_id AND h.photo_id=op.photo_id
    WHERE op.observation_id=? AND op.photo_id=? AND op.crop_jpeg IS NOT NULL
      AND o.dismissed_at IS NULL AND h.dismissed_at IS NULL`)
    .get(req.params.observationId, req.params.photoId) as { capture_id: string; crop_jpeg: Buffer } | undefined;
  if (!row) throw new NotFoundError('Item crop not available');
  await authorizeCapture(row.capture_id, req.user!.id);
  res.type('image/jpeg').send(row.crop_jpeg);
}));

router.delete('/:id/photos/:photoId/history', asyncHandler(async (req, res) => {
  res.json(await dismissPhotoHistory(req.params.id, req.params.photoId, req.user!.id));
}));

router.get('/', asyncHandler(async (req, res) => {
  const binId = typeof req.query.bin_id === 'string' ? req.query.bin_id : null;
  if (binId && !(await verifyBinAccess(binId, req.user!.id))) throw new NotFoundError('Storage location not found');
  const captures = getDb().prepare(`SELECT c.id FROM capture_batches c
    JOIN bins b ON b.id = c.bin_id
    JOIN location_members lm ON lm.location_id = b.location_id AND lm.user_id = ?
    WHERE b.deleted_at IS NULL AND (b.visibility = 'location' OR b.created_by = ?)
      AND (? IS NULL OR c.bin_id = ?)
      AND (NOT EXISTS (SELECT 1 FROM capture_photos p WHERE p.capture_id=c.id)
        OR EXISTS (SELECT 1 FROM capture_photos p LEFT JOIN capture_photo_history h
          ON h.capture_id=p.capture_id AND h.photo_id=p.id
          WHERE p.capture_id=c.id AND h.dismissed_at IS NULL))
    ORDER BY c.created_at DESC, c.sequence DESC LIMIT 30`).all(req.user!.id, req.user!.id, binId, binId) as { id: string }[];
  res.json({ captures: captures.map(({ id }) => captureStatus(id)) });
}));

router.post('/', asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ValidationError('Capture details are required');
  res.status(201).json(await createCapture(req.body, req.user!.id));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  await authorizeCapture(req.params.id, req.user!.id);
  res.json(captureStatus(req.params.id));
}));

// Body remains a bounded stream; image data never goes through JSON or logs.
router.put('/:id/photos/:photoId', asyncHandler(async (req, res) => {
  res.json(await receivePhoto(req, req.params.id, req.params.photoId, req.user!.id));
}));

router.post('/:id/complete', asyncHandler(async (req, res) => {
  res.json(await completeCapture(req.params.id, req.body?.photos, req.user!.id));
}));

export default router;
