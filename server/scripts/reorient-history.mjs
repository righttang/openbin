// One-off orientation of existing PostgreSQL history, without changing recognition or inventory.
// Preview: node --env-file=../.env scripts/reorient-history.mjs
// Apply:   node --env-file=../.env scripts/reorient-history.mjs --apply
// Container: docker exec -i -e REMINDME_APP_ROOT=/app CONTAINER node --input-type=module - --apply < server/scripts/reorient-history.mjs
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.REMINDME_APP_ROOT || fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { Client } = require('pg');
const { recognizeCapture } = await import(pathToFileURL(path.join(root, 'dist/lib/captures/recognition.js')));
const { rotateRetainedJpeg, rotateBox } = await import(pathToFileURL(path.join(root, 'dist/lib/captures/media.js')));
const client = new Client({ connectionString: process.env.DATABASE_URL });
const apply = process.argv.includes('--apply');
const captureId = process.argv.find(value => value.startsWith('--capture='))?.slice('--capture='.length) || null;
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'remindme-history-orientation-'));
const report = { checked: 0, rotated: 0, unchanged: 0, skipped: 0, apply, rotations: [] };
await client.connect();
try {
  const photos = (await client.query(`SELECT h.capture_id,h.photo_id,h.preview_jpeg,b.name AS bin_name
    FROM capture_photo_history h JOIN capture_batches c ON c.id=h.capture_id JOIN bins b ON b.id=c.bin_id
    WHERE h.dismissed_at IS NULL AND h.preview_jpeg IS NOT NULL AND c.cancelled_at IS NULL
      AND c.state IN ('applied','superseded') AND b.deleted_at IS NULL
      AND ($1::text IS NULL OR c.id=$1) ORDER BY c.captured_at DESC LIMIT 100`, [captureId])).rows;
  for (const photo of photos) {
    report.checked++;
    const filename = path.join(folder, crypto.randomUUID() + '.jpg');
    try {
      await fs.writeFile(filename, photo.preview_jpeg, { mode: 0o600 });
      const result = await recognizeCapture({ captureId: photo.capture_id, binName: photo.bin_name, existingItems: [],
        photos: [{ id: photo.photo_id, storage_path: filename, size: photo.preview_jpeg.length, sha256: crypto.createHash('sha256').update(photo.preview_jpeg).digest('hex') }] });
      const angle = result.photo_rotations?.find(entry => entry.photo_id === photo.photo_id)?.clockwise_degrees ?? 0;
      if (!angle) { report.unchanged++; continue; }
      report.rotations.push({ capture_id: photo.capture_id, photo_id: photo.photo_id, clockwise_degrees: angle });
      const preview = await rotateRetainedJpeg(photo.preview_jpeg, angle, 'preview');
      const crops = (await client.query(`SELECT op.observation_id,op.crop_jpeg,op.bbox_json FROM observation_photos op
        JOIN observations o ON o.id=op.observation_id WHERE op.capture_id=$1 AND op.photo_id=$2
        AND op.crop_jpeg IS NOT NULL AND o.dismissed_at IS NULL`, [photo.capture_id, photo.photo_id])).rows;
      const corrected = [];
      for (const crop of crops) {
        const image = await rotateRetainedJpeg(crop.crop_jpeg, angle, 'crop');
        let box = null;
        try { const old = JSON.parse(crop.bbox_json); if (Array.isArray(old) && old.length === 4) box = JSON.stringify(rotateBox(old, angle)); } catch { /* Legacy crops may not have a box. */ }
        corrected.push({ ...crop, jpeg: image.jpeg, box });
      }
      if (!apply) continue;
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [0x524d4341]);
        const current = (await client.query(`SELECT h.preview_jpeg FROM capture_photo_history h JOIN capture_batches c ON c.id=h.capture_id
          WHERE h.capture_id=$1 AND h.photo_id=$2 AND h.dismissed_at IS NULL AND c.cancelled_at IS NULL`, [photo.capture_id, photo.photo_id])).rows[0];
        if (!current?.preview_jpeg?.equals(photo.preview_jpeg)) {
          await client.query('ROLLBACK'); report.skipped++; continue;
        }
        await client.query('UPDATE capture_photo_history SET preview_jpeg=$1,width=$2,height=$3 WHERE capture_id=$4 AND photo_id=$5',
          [preview.jpeg, preview.width, preview.height, photo.capture_id, photo.photo_id]);
        for (const crop of corrected) {
          await client.query(`UPDATE observation_photos SET crop_jpeg=$1,bbox_json=$2 WHERE observation_id=$3 AND photo_id=$4
            AND crop_jpeg=$5 AND EXISTS (SELECT 1 FROM observations o WHERE o.id=observation_photos.observation_id AND o.dismissed_at IS NULL)`,
          [crop.jpeg, crop.box, crop.observation_id, photo.photo_id, crop.crop_jpeg]);
        }
        await client.query('UPDATE capture_batches SET updated_at=$1 WHERE id=$2', [new Date().toISOString(), photo.capture_id]);
        await client.query('COMMIT'); report.rotated++;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    } catch { report.skipped++; }
    finally { await fs.rm(filename, { force: true }); }
  }
  console.log(JSON.stringify(report));
} finally {
  await client.end();
  await fs.rm(folder, { recursive: true, force: true });
}
