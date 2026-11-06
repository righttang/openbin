import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import type { Request } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, initialize } from '../../db/init.js';
import { captureCancellation } from '../../db/migrations/0017_capture_cancellation.js';
import { getPool } from '../../db/postgres.js';
import { getDb, getDialect, query } from '../../db.js';
import { createApp } from '../../index.js';
import { signToken } from '../../middleware/auth.js';
import { captureDirectory } from './cleanup.js';
import { captureConfig } from './config.js';
import * as media from './media.js';
import { CaptureProcessingError, type RecognitionResult } from './recognition.js';
import { receivePhoto } from './store.js';
import { processNextCapture } from './worker.js';

const app = createApp();
let userId: string;
let binId: string;
let token: string;
let png: Buffer;
let hash: string;

beforeAll(async () => {
  if (process.env.DATABASE_URL && !new URL(process.env.DATABASE_URL).pathname.endsWith('_capture_test')) {
    throw new Error('Capture cancellation tests require a dedicated *_capture_test database');
  }
  await initialize();
  png = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#3377aa' } }).png().toBuffer();
  hash = crypto.createHash('sha256').update(png).digest('hex');
});

beforeEach(async () => {
  if (getDialect() === 'postgres') await query('TRUNCATE users CASCADE');
  fs.rmSync(captureConfig.scratchPath, { recursive: true, force: true });
  userId = crypto.randomUUID();
  binId = crypto.randomUUID();
  const locationId = crypto.randomUUID();
  await query('INSERT INTO users (id,email,display_name) VALUES ($1,$2,$3)', [userId, `${userId}@test.invalid`, 'Capture tester']);
  await query('INSERT INTO locations (id,name,created_by,invite_code) VALUES ($1,$2,$3,$4)', [locationId, 'Home', userId, crypto.randomUUID()]);
  await query("INSERT INTO location_members (id,location_id,user_id,role) VALUES ($1,$2,$3,'admin')", [crypto.randomUUID(), locationId, userId]);
  await query('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES ($1,$2,$3,$4,$5)', [binId, 'CANCEL', locationId, 'Desk', userId]);
  token = await signToken({ id: userId, email: `${userId}@test.invalid` });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(captureConfig.scratchPath, { recursive: true, force: true });
});

afterAll(async () => {
  if (getDialect() === 'postgres') {
    const { closeThumbnailPool } = await import('../thumbnailPool.js');
    await closeThumbnailPool();
    await closeDb();
  }
});

function create(id = crypto.randomUUID(), source = 'web-instant') {
  return request(app).post('/api/captures').set('Authorization', `Bearer ${token}`).send({ id, bin_id: binId, source });
}
function cancel(id: string, auth = token) {
  return request(app).post(`/api/captures/${id}/cancel`).set('Authorization', `Bearer ${auth}`).send({ bin_id: binId });
}
function complete(id: string, photoId: string) {
  return request(app).post(`/api/captures/${id}/complete`).set('Authorization', `Bearer ${token}`)
    .send({ photos: [{ id: photoId, sha256: hash, size: png.length, order: 0 }] });
}
function upload(id: string, photoId: string) {
  return request(app).put(`/api/captures/${id}/photos/${photoId}`).set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'image/png').set('X-Photo-SHA256', hash).send(png);
}
async function seal(id: string) {
  const photoId = crypto.randomUUID();
  expect((await upload(id, photoId)).status).toBe(200);
  expect((await complete(id, photoId)).status).toBe(200);
  return { id, photoId };
}
async function queued() { return seal((await create()).body.id); }
function recognized(photoId: string, itemId: string | null = null, quantity = 1): RecognitionResult {
  return { usable: true, items: [{ name: 'Cable', description: 'Blue cable', aliases: ['USB lead'], quantity,
    existing_item_id: itemId, photo_ids: [photoId], regions: [{ photo_id: photoId, box: [0.1, 0.1, 0.8, 0.9] }] }] };
}
async function items() {
  return (await query<{ id: string; name: string; quantity: number; updated_at: string; last_seen_batch_id: string | null; observation_state: string }>(
    'SELECT id,name,quantity,updated_at,last_seen_batch_id,observation_state FROM bin_items WHERE deleted_at IS NULL ORDER BY name',
  )).rows;
}
function uploadStream() {
  const headers: Record<string, string> = { 'Content-Length': String(png.length), 'Content-Type': 'image/png', 'X-Photo-SHA256': hash };
  const stream = Object.assign(new PassThrough(), { header: (name: string) => headers[name], setTimeout: () => stream });
  return stream;
}

async function assertCancelled(id: string) {
  const status = await request(app).get(`/api/captures/${id}`).set('Authorization', `Bearer ${token}`);
  expect(status.body.state).toBe('cancelled');
  for (const endpoint of ['/api/captures', '/api/captures/history']) {
    const response = await request(app).get(endpoint).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(id);
  }
  expect((await query('SELECT * FROM analysis_jobs WHERE capture_id=$1 AND lease_token IS NOT NULL', [id])).rows).toEqual([]);
  expect((await query('SELECT * FROM capture_photo_history WHERE capture_id=$1 AND preview_jpeg IS NOT NULL', [id])).rows).toEqual([]);
  expect((await query('SELECT * FROM observation_photos WHERE capture_id=$1 AND crop_jpeg IS NOT NULL', [id])).rows).toEqual([]);
}

describe('capture cancellation and instant photos', () => {
  it('tombstones an unknown ID and handles cancellation racing with creation', async () => {
    const id = crypto.randomUUID();
    expect((await cancel(id)).body).toMatchObject({ id, state: 'cancelled', removed_items: 0 });
    expect((await cancel(id)).status).toBe(200);
    expect((await create(id)).status).toBe(410);
    expect((await query('SELECT * FROM capture_batches WHERE id=$1', [id])).rows).toEqual([]);
    const raced = crypto.randomUUID();
    const outcomes = await Promise.all([create(raced), cancel(raced)]);
    expect([201, 410]).toContain(outcomes[0].status);
    expect(outcomes[1].body.state).toBe('cancelled');
    expect((await create(raced)).body.error).toBe('CAPTURE_CANCELLED');
    expect((await upload(raced, crypto.randomUUID())).status).not.toBe(200);
  });

  it('adds cancellation columns without removing existing data and can rerun the migration', async () => {
    const batch = await queued();
    const before = (await query('SELECT preview_jpeg FROM capture_photo_history WHERE capture_id=$1', [batch.id])).rows[0].preview_jpeg;
    await query('DROP TABLE capture_cancellations');
    await query('ALTER TABLE capture_batches DROP COLUMN cancelled_at');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (getDialect() === 'postgres') await captureCancellation.postgres!(getPool());
      else captureCancellation.sqlite!(getDb());
    }
    expect((await query('SELECT state,cancelled_at FROM capture_batches WHERE id=$1', [batch.id])).rows[0])
      .toEqual({ state: 'queued', cancelled_at: null });
    expect((await query('SELECT preview_jpeg FROM capture_photo_history WHERE capture_id=$1', [batch.id])).rows[0].preview_jpeg).toEqual(before);
    expect((await cancel(batch.id)).status).toBe(200);
  });

  it('requires capture ownership and location write permission before creating a tombstone', async () => {
    const batch = (await create()).body;
    const otherId = crypto.randomUUID();
    await query('INSERT INTO users (id,email,display_name) VALUES ($1,$2,$3)', [otherId, `${otherId}@test.invalid`, 'Other']);
    const otherToken = await signToken({ id: otherId, email: `${otherId}@test.invalid` });
    expect((await cancel(batch.id, otherToken)).status).toBe(404);
    const unknown = crypto.randomUUID();
    expect((await cancel(unknown, otherToken)).status).toBe(404);
    expect((await query('SELECT * FROM capture_cancellations WHERE id=$1', [unknown])).rows).toEqual([]);
    const locationId = (await query('SELECT location_id FROM bins WHERE id=$1', [binId])).rows[0].location_id;
    await query("INSERT INTO location_members (id,location_id,user_id,role) VALUES ($1,$2,$3,'viewer')", [crypto.randomUUID(), locationId, otherId]);
    expect((await cancel(unknown, otherToken)).status).toBe(403);
    expect((await query('SELECT * FROM capture_cancellations WHERE id=$1', [unknown])).rows).toEqual([]);
    expect((await request(app).post(`/api/captures/${unknown}/cancel`).set('Authorization', `Bearer ${token}`)).status).toBe(422);
  });

  it('cancels queued work idempotently and rejects later uploads and completion', async () => {
    const batch = await queued();
    expect((await cancel(batch.id)).body.state).toBe('cancelled');
    expect((await cancel(batch.id)).body.removed_items).toBe(0);
    expect((await complete(batch.id, batch.photoId)).status).toBe(410);
    expect((await upload(batch.id, batch.photoId)).status).toBe(410);
    expect(await processNextCapture({ recognize: async () => { throw new Error('must not run'); } })).toBe(false);
    expect(fs.existsSync(captureDirectory(batch.id))).toBe(false);
    await assertCancelled(batch.id);
  });

  it('stops a streaming upload and removes its partial input after cancellation', async () => {
    const id = (await create()).body.id;
    const stream = uploadStream();
    const pending = receivePhoto(stream as unknown as Request, id, crypto.randomUUID(), userId).catch(error => error);
    stream.write(png.subarray(0, 10));
    await vi.waitFor(async () => expect((await query('SELECT * FROM capture_photos WHERE capture_id=$1', [id])).rows).toHaveLength(1));
    expect((await cancel(id)).status).toBe(200);
    expect(await pending).toBeInstanceOf(Error);
    expect(stream.destroyed).toBe(true);
    expect(fs.existsSync(captureDirectory(id))).toBe(false);
    await assertCancelled(id);
  });

  it('does not acknowledge or restore preview bytes when cancellation wins during image decoding', async () => {
    const id = (await create()).body.id;
    let decoding!: () => void;
    const started = new Promise<void>(resolve => { decoding = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const jpeg = await sharp(png).jpeg().toBuffer();
    vi.spyOn(media, 'makePhotoPreview').mockImplementation(async () => { decoding(); await gate; return { jpeg, width: 60, height: 40 }; });
    const stream = uploadStream();
    const pending = receivePhoto(stream as unknown as Request, id, crypto.randomUUID(), userId).catch(error => error);
    stream.end(png);
    await started;
    try { expect((await cancel(id)).status).toBe(200); }
    finally { release(); }
    expect(await pending).toMatchObject({ code: 'CAPTURE_CANCELLED' });
    expect(fs.existsSync(captureDirectory(id))).toBe(false);
    await assertCancelled(id);
  });

  it('aborts the actual model HTTP request and ignores its cancelled lease', async () => {
    const batch = await queued();
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    let closed = false;
    const server = http.createServer((req, res) => {
      req.resume();
      res.on('close', () => { closed = true; });
      started();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    vi.stubEnv('AI_ENDPOINT_URL', `http://127.0.0.1:${address.port}/v1`);
    vi.stubEnv('AI_MODEL', 'cancel-test');
    vi.stubEnv('AI_API_KEY', 'cancel-test-key');
    const running = processNextCapture();
    try {
      await requested;
      expect((await cancel(batch.id)).status).toBe(200);
      await running;
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(await items()).toEqual([]);
      expect(fs.existsSync(captureDirectory(batch.id))).toBe(false);
      await assertCancelled(batch.id);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('rejects a late recognizer result even when it ignores the abort signal', async () => {
    const batch = await queued();
    let finish!: (result: RecognitionResult) => void;
    const running = processNextCapture({ recognize: () => new Promise(resolve => { finish = resolve; }) });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect((await cancel(batch.id)).status).toBe(200);
    finish(recognized(batch.photoId));
    await running;
    expect(await items()).toEqual([]);
    expect((await query('SELECT * FROM observations WHERE capture_id=$1', [batch.id])).rows).toEqual([]);
    expect(fs.existsSync(captureDirectory(batch.id))).toBe(false);
    await assertCancelled(batch.id);
  });

  it('retracts all photos and images from a completed batch atomically', async () => {
    const id = (await create()).body.id;
    const other = await sharp(png).negate().png().toBuffer();
    const manifests = [];
    for (const [order, bytes] of [png, other].entries()) {
      const photoId = crypto.randomUUID();
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      const response = await request(app).put(`/api/captures/${id}/photos/${photoId}`).set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'image/png').set('X-Photo-SHA256', digest).send(bytes);
      expect(response.status).toBe(200);
      manifests.push({ id: photoId, sha256: digest, size: bytes.length, order });
    }
    expect((await request(app).post(`/api/captures/${id}/complete`).set('Authorization', `Bearer ${token}`).send({ photos: manifests })).status).toBe(200);
    const result = recognized(manifests[0].id);
    result.items[0].photo_ids = manifests.map(photo => photo.id);
    await processNextCapture({ recognize: async () => result });
    expect((await cancel(id)).body.removed_items).toBe(1);
    expect(await items()).toEqual([]);
    expect((await query('SELECT * FROM capture_photo_history WHERE capture_id=$1 AND dismissed_at IS NOT NULL', [id])).rows).toHaveLength(2);
    await assertCancelled(id);
  });

  it('rolls back cancellation flags, image removal and tombstone if inventory retraction fails', async () => {
    const batch = await queued();
    await processNextCapture({ recognize: async () => recognized(batch.photoId) });
    if (getDialect() === 'postgres') {
      await query(`CREATE OR REPLACE FUNCTION capture_cancel_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`);
      await query('CREATE TRIGGER capture_cancel_test_failure BEFORE UPDATE ON bin_items FOR EACH ROW EXECUTE FUNCTION capture_cancel_test_failure()');
    } else {
      await query(`CREATE TEMP TRIGGER capture_cancel_test_failure BEFORE UPDATE ON bin_items
        WHEN NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'test rollback'); END`);
    }
    try {
      expect((await cancel(batch.id)).status).toBe(500);
      expect((await query('SELECT state,cancelled_at FROM capture_batches WHERE id=$1', [batch.id])).rows[0])
        .toEqual({ state: 'applied', cancelled_at: null });
      expect((await query('SELECT * FROM capture_cancellations WHERE id=$1', [batch.id])).rows).toEqual([]);
      expect((await query('SELECT * FROM capture_photo_history WHERE capture_id=$1 AND preview_jpeg IS NOT NULL AND dismissed_at IS NULL', [batch.id])).rows).toHaveLength(1);
      expect(await items()).toHaveLength(1);
    } finally {
      await query(getDialect() === 'postgres' ? 'DROP TRIGGER capture_cancel_test_failure ON bin_items' : 'DROP TRIGGER capture_cancel_test_failure');
      if (getDialect() === 'postgres') await query('DROP FUNCTION capture_cancel_test_failure()');
    }
  });

  it.each(['late upload', 'retry'] as const)('merges an older instant photo after a newer one without overwriting newer evidence (%s)', async mode => {
    const firstId = (await create()).body.id;
    let first: { id: string; photoId: string } | undefined;
    if (mode === 'retry') {
      first = await seal(firstId);
      await processNextCapture({ recognize: async () => { throw new CaptureProcessingError('model_unavailable'); } });
    }
    const second = await queued();
    await processNextCapture({ recognize: async () => recognized(second.photoId, null, 2) });
    const current = (await items())[0];
    first ??= await seal(firstId);
    await query('UPDATE analysis_jobs SET next_attempt_at=$1 WHERE capture_id=$2', ['2000-01-01T00:00:00.000Z', first.id]);
    const olderResult = recognized(first.photoId, current.id, 9);
    olderResult.items.push({ ...olderResult.items[0], name: 'Adapter', existing_item_id: null, quantity: 1 });
    await processNextCapture({ recognize: async () => olderResult });
    expect((await items()).find(item => item.id === current.id)).toEqual(current);
    expect((await items()).map(item => item.name)).toEqual(['Adapter', 'Cable']);
    expect((await query('SELECT latest_applied_sequence FROM bin_capture_state WHERE bin_id=$1', [binId])).rows[0].latest_applied_sequence).toBe(2);
    expect((await query('SELECT state FROM capture_batches WHERE id=$1', [first.id])).rows[0].state).toBe('applied');
    expect((await query('SELECT * FROM observations WHERE capture_id=$1 AND item_id IS NOT NULL', [first.id])).rows).toHaveLength(2);
    expect((await cancel(second.id)).body.removed_items).toBe(0);
    expect((await items()).find(item => item.id === current.id)?.quantity).toBe(9);
    expect((await cancel(first.id)).body.removed_items).toBe(2);
    expect(await items()).toEqual([]);
  });

  it('retains manual evidence priority when the newer photo is cancelled before an older upload arrives', async () => {
    const firstId = (await create()).body.id;
    const second = await queued();
    await processNextCapture({ recognize: async () => recognized(second.photoId, null, 2) });
    const current = (await items())[0];
    await query('UPDATE bin_items SET quantity=5 WHERE id=$1', [current.id]);
    expect((await cancel(second.id)).body.removed_items).toBe(0);
    const first = await seal(firstId);
    await processNextCapture({ recognize: async () => recognized(first.photoId, current.id, 9) });
    expect((await items())[0].quantity).toBe(5);
    expect((await cancel(first.id)).body.removed_items).toBe(0);
    expect((await items())[0].quantity).toBe(5);
  });

  it.each(['older first', 'newer first'] as const)('keeps manual data when late older evidence and newer evidence are cancelled (%s)', async order => {
    const firstId = (await create()).body.id;
    const second = await queued();
    await processNextCapture({ recognize: async () => recognized(second.photoId, null, 2) });
    const current = (await items())[0];
    // Deliberately retain the old timestamp: content/provenance must also
    // protect manual edits on SQLite's second-resolution update timestamps.
    await query('UPDATE bin_items SET quantity=5 WHERE id=$1', [current.id]);
    const first = await seal(firstId);
    await processNextCapture({ recognize: async () => recognized(first.photoId, current.id, 9) });
    for (const batch of order === 'older first' ? [first, second] : [second, first]) {
      expect((await cancel(batch.id)).body.removed_items).toBe(0);
      expect((await items())[0].quantity).toBe(5);
    }
    expect((await items())[0].last_seen_batch_id).toBeNull();
    expect((await query('SELECT capture_created FROM bin_items WHERE id=$1', [current.id])).rows[0].capture_created).toBe(0);
  });
});
