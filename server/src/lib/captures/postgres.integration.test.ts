import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, initialize } from '../../db/init.js';
import { query, withTransaction } from '../../db.js';
import { createApp } from '../../index.js';
import { signToken } from '../../middleware/auth.js';
import { captureDirectory } from './cleanup.js';
import { captureConfig } from './config.js';
import { withCaptureTransaction } from './database.js';
import { storePhotoPreview } from './history.js';
import type { RecognitionResult } from './recognition.js';
import { commitRecognition } from './reconcile.js';
import { claimCapture, processNextCapture } from './worker.js';

const app = createApp();
let userId: string;
let binId: string;
let token: string;
let png: Buffer;
let hash: string;

beforeAll(async () => {
  // This suite deliberately resets its own dedicated database, never app data.
  const database = new URL(process.env.DATABASE_URL!);
  if (!database.pathname.endsWith('_capture_test')) throw new Error('Capture integration tests require a dedicated *_capture_test database');
  await initialize();
  png = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#369aff' } }).png().toBuffer();
  hash = crypto.createHash('sha256').update(png).digest('hex');
});

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
  fs.rmSync(captureConfig.scratchPath, { recursive: true, force: true });
  userId = crypto.randomUUID();
  binId = crypto.randomUUID();
  const locationId = crypto.randomUUID();
  await query('INSERT INTO users (id,email,display_name) VALUES ($1,$2,$3)', [userId, `${userId}@test.invalid`, 'Capture tester']);
  await query('INSERT INTO locations (id,name,created_by,invite_code) VALUES ($1,$2,$3,$4)', [locationId, 'Home', userId, crypto.randomUUID()]);
  await query("INSERT INTO location_members (id,location_id,user_id,role) VALUES ($1,$2,$3,'admin')", [crypto.randomUUID(), locationId, userId]);
  await query('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES ($1,$2,$3,$4,$5)', [binId, 'PGCAPTURE', locationId, 'Desk', userId]);
  token = await signToken({ id: userId, email: `${userId}@test.invalid` });
});

afterEach(() => {
  delete process.env.CAPTURE_HISTORY_QUOTA_BYTES;
  fs.rmSync(captureConfig.scratchPath, { recursive: true, force: true });
});

afterAll(async () => {
  const { closeThumbnailPool } = await import('../thumbnailPool.js');
  await closeThumbnailPool();
  await closeDb();
});

function create(id = crypto.randomUUID()) {
  return request(app).post('/api/captures').set('Authorization', `Bearer ${token}`).send({ id, bin_id: binId });
}
function upload(id: string, photoId = crypto.randomUUID()) {
  return request(app).put(`/api/captures/${id}/photos/${photoId}`)
    .set('Authorization', `Bearer ${token}`).set('Content-Type', 'image/png').set('X-Photo-SHA256', hash).send(png);
}
async function queued() {
  const { body: batch, status } = await create();
  expect(status).toBe(201);
  const photoId = crypto.randomUUID();
  expect((await upload(batch.id, photoId)).status).toBe(200);
  const sealed = await request(app).post(`/api/captures/${batch.id}/complete`).set('Authorization', `Bearer ${token}`)
    .send({ photos: [{ id: photoId, sha256: hash, size: png.length, order: 0 }] });
  expect(sealed.status).toBe(200);
  return { id: batch.id as string, photoId };
}
function recognized(photoId: string, itemId: string | null = null, quantity: number | null = null): RecognitionResult {
  return { usable: true, items: [{ name: 'Cable', description: 'Blue charging cable', aliases: ['USB lead'], quantity,
    existing_item_id: itemId, photo_ids: [photoId], regions: [{ photo_id: photoId, box: [0.1, 0.1, 0.8, 0.9] }] }] };
}
function remove(batch: { id: string; photoId: string }) {
  return request(app).delete(`/api/captures/${batch.id}/photos/${batch.photoId}/history`).set('Authorization', `Bearer ${token}`);
}
async function inventory() {
  const response = await request(app).get(`/api/captures/inventory?bin_id=${binId}`).set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(200);
  return response.body.items as Array<{ id: string; name: string; quantity: number | null; last_seen_batch_id: string | null; crop_url: string }>;
}

describe('PostgreSQL capture pipeline', () => {
  it('deletes a selected result, keeps its photo and restores the other scan supporting the item', async () => {
    const first = await queued();
    await processNextCapture({ recognize: async () => recognized(first.photoId, null, 1) });
    const original = (await inventory())[0];
    const second = await queued();
    await processNextCapture({ recognize: async () => {
      const result = recognized(second.photoId, original.id, 9);
      result.items.push({ ...result.items[0], name: 'Correct adapter', existing_item_id: null, quantity: 2 });
      return result;
    } });
    const history = await request(app).get('/api/captures/history').set('Authorization', `Bearer ${token}`);
    const photo = history.body.photos.find((entry: { capture_id: string }) => entry.capture_id === second.id);
    const wrong = photo.items.find((entry: { item_id: string }) => entry.item_id === original.id);
    expect((await request(app).delete(`/api/captures/observations/${wrong.observation_id}`).set('Authorization', `Bearer ${token}`)).body).toEqual({ removed: true, removed_items: 0 });
    expect((await inventory()).find(item => item.id === original.id)).toMatchObject({ quantity: 1, last_seen_batch_id: first.id });
    const remaining = await request(app).get('/api/captures/history').set('Authorization', `Bearer ${token}`);
    expect(remaining.body.photos.find((entry: { capture_id: string }) => entry.capture_id === second.id).items).toMatchObject([{ name: 'Correct adapter' }]);
    expect((await request(app).get(photo.preview_url).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get(wrong.crop_url).set('Authorization', `Bearer ${token}`)).status).toBe(404);
  });
  it('uploads, recognizes, retains BYTEA crops, restores shared evidence and removes exclusive items', async () => {
    const first = await queued();
    expect(await processNextCapture({ recognize: async () => recognized(first.photoId, null, null) })).toBe(true);
    expect(fs.existsSync(captureDirectory(first.id))).toBe(false);
    let items = await inventory();
    for (const endpoint of ['/api/captures', '/api/captures/history', '/api/captures/inventory']) {
      expect((await request(app).get(endpoint).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    }
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBeNull();
    const cropUrl = items[0].crop_url;
    const crop = await request(app).get(cropUrl).set('Authorization', `Bearer ${token}`);
    expect(crop.status).toBe(200);
    expect((await sharp(crop.body).metadata()).format).toBe('jpeg');
    const second = await queued();
    await processNextCapture({ recognize: async () => recognized(second.photoId, items[0].id, 3) });
    expect((await inventory())[0].quantity).toBe(3);
    const history = await request(app).get('/api/captures/history').set('Authorization', `Bearer ${token}`);
    expect(history.body.photos).toHaveLength(2);
    expect(history.body.photos[0].items).toHaveLength(1);
    const preview = await request(app).get(history.body.photos[0].preview_url).set('Authorization', `Bearer ${token}`);
    expect((await sharp(preview.body).metadata()).format).toBe('jpeg');
    expect((await remove(second)).body).toEqual({ removed: true, removed_items: 0 });
    items = await inventory();
    expect(items[0]).toMatchObject({ quantity: null, last_seen_batch_id: first.id });
    expect((await remove(first)).body).toEqual({ removed: true, removed_items: 1 });
    expect(await inventory()).toEqual([]);
    expect((await request(app).get(cropUrl).set('Authorization', `Bearer ${token}`)).status).toBe(404);
  });

  it('searches names, descriptions, aliases and storage names without case sensitivity', async () => {
    const batch = await queued();
    await processNextCapture({ recognize: async () => recognized(batch.photoId) });
    for (const term of ['cAbLe', 'bLuE', 'uSb', 'dEsK']) {
      const response = await request(app).get('/api/captures/inventory').query({ q: term }).set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
    }
    const literal = await request(app).get('/api/captures/inventory').query({ q: '%' }).set('Authorization', `Bearer ${token}`);
    expect(literal.body.items).toHaveLength(0);
  });

  it('allocates unique sequences and an idempotent capture under concurrent requests', async () => {
    const id = crypto.randomUUID();
    const same = await Promise.all(Array.from({ length: 4 }, () => create(id)));
    expect(same.map(response => response.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(same.map(response => response.body.sequence)).size).toBe(1);
    const different = await Promise.all(Array.from({ length: 12 }, () => create()));
    expect(different.every(response => response.status === 201)).toBe(true);
    expect(new Set(different.map(response => response.body.sequence)).size).toBe(12);
    expect((await query('SELECT COUNT(*) AS n FROM capture_batches')).rows[0].n).toBe(13);
  });

  it('rejects concurrent duplicate photo content and seals exactly one job', async () => {
    const batch = (await create()).body;
    const responses = await Promise.all([upload(batch.id), upload(batch.id)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const photo = responses.find(response => response.status === 200)!.body;
    const complete = () => request(app).post(`/api/captures/${batch.id}/complete`).set('Authorization', `Bearer ${token}`)
      .send({ photos: [{ id: photo.id, sha256: hash, size: png.length, order: 0 }] });
    expect((await Promise.all([complete(), complete()])).map(response => response.status)).toEqual([200, 200]);
    expect((await query('SELECT COUNT(*) AS n FROM analysis_jobs')).rows[0].n).toBe(1);
  });

  it('claims one job exactly once and rejects a stale worker after lease recovery', async () => {
    const batch = await queued();
    const claims = await Promise.all([claimCapture(new Date()), claimCapture(new Date())]);
    const first = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    await query("UPDATE analysis_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=$1", [first.jobId]);
    const recovered = (await claimCapture(new Date()))!;
    expect(recovered.leaseToken).not.toBe(first.leaseToken);
    await expect(commitRecognition(first, recognized(batch.photoId))).rejects.toMatchObject({ category: 'worker_interrupted' });
    await commitRecognition(recovered, recognized(batch.photoId));
    expect((await inventory())).toHaveLength(1);
  });

  it('serializes scratch reservations so concurrent uploads cannot exceed quota', async () => {
    const reserved = (await create()).body;
    const first = (await create()).body;
    const second = (await create()).body;
    await query(`INSERT INTO capture_photos (capture_id,id,sha256,size,mime_type,storage_path)
      VALUES ($1,$2,$3,$4,'image/png',$5)`, [reserved.id, crypto.randomUUID(), 'f'.repeat(64),
      captureConfig.scratchQuotaBytes - png.length - Math.floor(png.length / 2), path.join(captureDirectory(reserved.id), 'reservation')]);
    const uploaded = await Promise.all([upload(first.id), upload(second.id)]);
    expect(uploaded.map(response => response.status).sort()).toEqual([200, 507]);
    expect(Number((await query('SELECT SUM(size) AS n FROM capture_photos')).rows[0].n)).toBeLessThanOrEqual(captureConfig.scratchQuotaBytes);
  });

  it('serializes retained image quota across simultaneous previews', async () => {
    const first = await queued();
    const second = await queued();
    await query('UPDATE capture_photo_history SET preview_jpeg=NULL');
    const jpeg = await sharp(png).jpeg().toBuffer();
    process.env.CAPTURE_HISTORY_QUOTA_BYTES = String(jpeg.length);
    await Promise.all([first, second].map(batch => storePhotoPreview(batch.id, batch.photoId, { jpeg, width: 80, height: 60 })));
    expect((await query('SELECT SUM(length(preview_jpeg)) AS bytes FROM capture_photo_history')).rows[0].bytes).toBe(jpeg.length);
  });

  it('counts preview bytes committed while recognition waits for the transaction lock', async () => {
    const first = await queued();
    const second = await queued();
    const claim = (await claimCapture(new Date()))!;
    expect(claim.captureId).toBe(first.id);
    await query('UPDATE capture_photo_history SET preview_jpeg=NULL');
    const jpeg = await sharp(png).jpeg().toBuffer();
    process.env.CAPTURE_HISTORY_QUOTA_BYTES = String(jpeg.length);
    let wrote!: () => void;
    const written = new Promise<void>(resolve => { wrote = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const preview = withCaptureTransaction(async execute => {
      await storePhotoPreview(second.id, second.photoId, { jpeg, width: 80, height: 60 }, execute);
      wrote();
      await gate;
    });
    await written;
    const recognition = commitRecognition(claim, recognized(first.photoId), new Date(), [[{
      photoId: first.photoId, box: [0.1, 0.1, 0.8, 0.9], jpeg,
    }]]);
    try {
      await vi.waitFor(async () => {
        const waiting = await query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'`);
        expect(waiting.rowCount).toBe(1);
      });
    } finally { release(); }
    await Promise.all([preview, recognition]);
    const retained = await query(`SELECT
      (SELECT COALESCE(SUM(length(preview_jpeg)),0) FROM capture_photo_history) +
      (SELECT COALESCE(SUM(length(crop_jpeg)),0) FROM observation_photos) AS bytes`);
    expect(retained.rows[0].bytes).toBe(jpeg.length);
    expect((await query('SELECT crop_jpeg FROM observation_photos')).rows[0].crop_jpeg).toBeNull();
  });

  it('rejects recognition snapshots changed by manual inventory edits and never resurrects dismissed photos', async () => {
    const batch = await queued();
    const claim = (await claimCapture(new Date()))!;
    const itemId = crypto.randomUUID();
    await query('INSERT INTO bin_items (id,bin_id,name) VALUES ($1,$2,$3)', [itemId, binId, 'Manual item']);
    await expect(commitRecognition(claim, recognized(batch.photoId))).rejects.toMatchObject({ category: 'revision_conflict' });
    expect((await inventory()).map(item => item.name)).toEqual(['Manual item']);
    await remove(batch);
    await commitRecognition(claim, recognized(batch.photoId));
    expect((await inventory()).map(item => item.name)).toEqual(['Manual item']);
    expect((await query('SELECT * FROM observations')).rows).toEqual([]);
  });

  it('preserves a manual update that races with a recognition transaction', async () => {
    const first = await queued();
    await processNextCapture({ recognize: async () => recognized(first.photoId, null, 1) });
    const itemId = (await inventory())[0].id;
    const second = await queued();
    const claim = (await claimCapture(new Date()))!;
    let wrote!: () => void;
    const written = new Promise<void>(resolve => { wrote = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const manual = withTransaction(async execute => {
      await execute("UPDATE bin_items SET name='Manual winner',updated_at=$1 WHERE id=$2", [new Date(Date.now() + 1000).toISOString(), itemId]);
      wrote();
      await gate;
    });
    await written;
    const recognition = commitRecognition(claim, recognized(second.photoId, itemId, 7));
    try {
      await vi.waitFor(async () => {
        const waiting = await query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE 'UPDATE bin_items SET observation_state%'`);
        expect(waiting.rowCount).toBe(1);
      });
    } finally { release(); }
    await manual;
    await expect(recognition).rejects.toMatchObject({ category: 'revision_conflict' });
    expect((await inventory())[0]).toMatchObject({ name: 'Manual winner', quantity: 1 });
  });

  it('removes shared evidence consistently when two history records are dismissed together', async () => {
    const first = await queued();
    await processNextCapture({ recognize: async () => recognized(first.photoId, null, 1) });
    const itemId = (await inventory())[0].id;
    const second = await queued();
    await processNextCapture({ recognize: async () => recognized(second.photoId, itemId, 2) });
    const responses = await Promise.all([remove(first), remove(second)]);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(responses.reduce((sum, response) => sum + response.body.removed_items, 0)).toBe(1);
    expect(await inventory()).toEqual([]);
    expect((await query('SELECT * FROM capture_photo_history WHERE dismissed_at IS NULL')).rows).toEqual([]);
  });

  it('rolls back all evidence deletion if a later inventory update fails', async () => {
    const batch = await queued();
    await processNextCapture({ recognize: async () => recognized(batch.photoId, null, 1) });
    await query(`CREATE OR REPLACE FUNCTION capture_test_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'test rejection'; END IF; RETURN NEW; END $$`);
    await query('CREATE TRIGGER capture_test_reject_delete BEFORE UPDATE ON bin_items FOR EACH ROW EXECUTE FUNCTION capture_test_reject_delete()');
    try {
      expect((await remove(batch)).status).toBe(500);
      expect((await query('SELECT dismissed_at FROM capture_photo_history WHERE capture_id=$1', [batch.id])).rows[0].dismissed_at).toBeNull();
      expect((await query('SELECT crop_jpeg IS NOT NULL AS present FROM observation_photos')).rows[0].present).toBe(true);
      expect((await inventory())).toHaveLength(1);
    } finally {
      await query('DROP TRIGGER capture_test_reject_delete ON bin_items');
      await query('DROP FUNCTION capture_test_reject_delete()');
    }
  });

  it('rolls back a failing short capture transaction', async () => {
    await expect(withCaptureTransaction(async execute => {
      await execute("UPDATE bins SET name='Uncommitted' WHERE id=$1", [binId]);
      throw new Error('stop');
    })).rejects.toThrow('stop');
    expect((await query('SELECT name FROM bins WHERE id=$1', [binId])).rows[0].name).toBe('Desk');
  });
});
