import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import type { Request } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureBatches } from '../db/migrations/0014_capture_batches.js';
import { getDb } from '../db.js';
import { createApp } from '../index.js';
import { captureDirectory, cleanupCapture, holdCapture, sweepCaptures } from '../lib/captures/cleanup.js';
import { captureConfig } from '../lib/captures/config.js';
import { receivePhoto, scratchUsage } from '../lib/captures/store.js';
import { createTestBin, createTestLocation, createTestUser, joinTestLocation } from './helpers.js';

const app = createApp();
let token: string;
let userId: string;
let binId: string;
let locationId: string;
let inviteCode: string;
let png: Buffer;
let hash: string;

beforeEach(async () => {
  fs.rmSync(captureConfig.scratchPath, { recursive: true, force: true });
  const account = await createTestUser(app);
  token = account.token;
  userId = account.user.id;
  const location = await createTestLocation(app, token);
  locationId = location.id;
  inviteCode = location.invite_code;
  binId = (await createTestBin(app, token, locationId)).id;
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#3366ff' } }).png().toBuffer();
  hash = crypto.createHash('sha256').update(png).digest('hex');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(captureConfig.scratchPath, { recursive: true, force: true });
});

function create(id = crypto.randomUUID(), auth = token) {
  return request(app).post('/api/captures').set('Authorization', `Bearer ${auth}`).send({ id, bin_id: binId });
}
function upload(id: string, photoId = crypto.randomUUID(), bytes = png, digest = hash) {
  return request(app).put(`/api/captures/${id}/photos/${photoId}`)
    .set('Authorization', `Bearer ${token}`).set('Content-Type', 'image/png')
    .set('X-Photo-SHA256', digest).send(bytes);
}
function complete(id: string, photoId: string) {
  return request(app).post(`/api/captures/${id}/complete`).set('Authorization', `Bearer ${token}`)
    .send({ photos: [{ id: photoId, sha256: hash, size: png.length, order: 0 }] });
}

describe('capture ingestion', () => {
  it('recovers the same capture sequence and seals exactly one durable job', async () => {
    const id = crypto.randomUUID();
    const photoId = crypto.randomUUID();
    const first = await create(id);
    expect(first.status).toBe(201);
    expect((await create(id)).body.sequence).toBe(first.body.sequence);
    expect((await upload(id, photoId)).status).toBe(200);
    expect((await upload(id, photoId)).status).toBe(200);
    expect((await complete(id, photoId)).body.state).toBe('queued');
    expect((await complete(id, photoId)).body.state).toBe('queued');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM analysis_jobs').get()).toEqual({ n: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM bin_items WHERE bin_id = ?').get(binId)).toEqual({ n: 0 });
    expect((await create()).body.sequence).toBe(first.body.sequence + 1);
  });

  it('keeps incomplete batches unqueued and rejects changed sealed manifests', async () => {
    const { body: batch } = await create();
    const photoId = crypto.randomUUID();
    expect((await complete(batch.id, photoId)).status).toBe(409);
    expect(getDb().prepare('SELECT state FROM capture_batches WHERE id = ?').get(batch.id)).toEqual({ state: 'uploading' });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM analysis_jobs').get()).toEqual({ n: 0 });
    await upload(batch.id, photoId);
    await complete(batch.id, photoId);
    expect((await complete(batch.id, crypto.randomUUID())).status).toBe(409);
    expect((await upload(batch.id, crypto.randomUUID())).status).toBe(409);
  });

  it('rejects checksum mismatches and conflicting IDs without leaking scratch reservations', async () => {
    const { body: batch } = await create();
    const photoId = crypto.randomUUID();
    expect((await upload(batch.id, photoId, png, '0'.repeat(64))).status).toBe(422);
    expect(scratchUsage()).toBe(0);
    expect((await upload(batch.id, photoId)).status).toBe(200);
    expect((await upload(batch.id, photoId, png, '0'.repeat(64))).status).toBe(409);
    expect((await upload(batch.id)).status).toBe(409); // duplicate bytes under a new ID
    expect(scratchUsage()).toBe(png.length);
  });

  it('checks image bytes and rejects unsupported HEIC before accepting data', async () => {
    const { body: batch } = await create();
    const bad = Buffer.from('this is not an image');
    expect((await upload(batch.id, crypto.randomUUID(), bad, crypto.createHash('sha256').update(bad).digest('hex'))).status).toBe(422);
    const heic = await request(app).put(`/api/captures/${batch.id}/photos/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${token}`).set('Content-Type', 'image/heic')
      .set('X-Photo-SHA256', hash).send(png);
    expect(heic.status).toBe(415);
    expect(scratchUsage()).toBe(0);
  });

  it('enforces owner/member access for writes and hides other households', async () => {
    const { body: batch } = await create();
    const stranger = await createTestUser(app);
    expect((await request(app).get(`/api/captures/${batch.id}`).set('Authorization', `Bearer ${stranger.token}`)).status).toBe(404);
    expect((await create(crypto.randomUUID(), stranger.token)).status).toBe(404);
    await joinTestLocation(app, stranger.token, inviteCode);
    expect((await create(crypto.randomUUID(), stranger.token)).status).toBe(403);
    getDb().prepare("UPDATE location_members SET role = 'viewer' WHERE user_id = ? AND location_id = ?").run(userId, locationId);
    expect((await upload(batch.id)).status).toBe(403);
  });

  it('counts durable in-flight reservations and untracked partial files against the shared quota', async () => {
    const { body: batch } = await create();
    const reserveId = crypto.randomUUID();
    getDb().prepare(`INSERT INTO capture_photos (capture_id,id,sha256,size,mime_type,storage_path)
      VALUES (?,?,?,?,?,?)`).run(batch.id, reserveId, 'f'.repeat(64), captureConfig.scratchQuotaBytes - captureConfig.reservedHeadroomBytes,
      'image/png', path.join(captureDirectory(batch.id), reserveId));
    expect((await upload(batch.id)).status).toBe(507);
    getDb().prepare('DELETE FROM capture_photos').run();
    fs.mkdirSync(captureConfig.scratchPath, { recursive: true });
    const orphan = path.join(captureConfig.scratchPath, 'orphan.part');
    const handle = fs.openSync(orphan, 'w');
    fs.ftruncateSync(handle, captureConfig.scratchQuotaBytes); // sparse file
    fs.closeSync(handle);
    expect((await upload(batch.id)).status).toBe(507);
    expect(scratchUsage()).toBe(captureConfig.scratchQuotaBytes);
  });

  it('refuses new uploads below the free disk threshold', async () => {
    const { body: batch } = await create();
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0, bsize: 4096 } as ReturnType<typeof fs.statfsSync>);
    expect((await upload(batch.id)).body.error).toBe('DISK_SPACE');
    expect(scratchUsage()).toBe(0);
  });

  it('reserves before concurrent requests write, leaving shared headroom intact', async () => {
    const first = (await create()).body.id;
    const second = (await create()).body.id;
    fs.mkdirSync(captureConfig.scratchPath, { recursive: true });
    const handle = fs.openSync(path.join(captureConfig.scratchPath, 'orphan.part'), 'w');
    fs.ftruncateSync(handle, captureConfig.scratchQuotaBytes - captureConfig.reservedHeadroomBytes - png.length);
    fs.closeSync(handle);
    const responses = await Promise.all([upload(first), upload(second)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 507]);
    expect(scratchUsage()).toBe(captureConfig.scratchQuotaBytes - captureConfig.reservedHeadroomBytes);
  });

  it('can recover a restored uploading manifest whose acknowledged scratch file is missing', async () => {
    const { body: batch } = await create();
    const photoId = crypto.randomUUID();
    await upload(batch.id, photoId);
    fs.rmSync(path.join(captureDirectory(batch.id), photoId));
    const status = await request(app).get(`/api/captures/${batch.id}`).set('Authorization', `Bearer ${token}`);
    expect(status.body.photos[0].received_at).toBeNull();
    expect((await complete(batch.id, photoId)).status).toBe(409);
    expect((await upload(batch.id, photoId)).status).toBe(200);
    expect((await complete(batch.id, photoId)).body.state).toBe('queued');
  });

  it('stops an incomplete active stream at its absolute batch expiry', async () => {
    const { body: batch } = await create();
    getDb().prepare('UPDATE capture_batches SET expires_at = ? WHERE id = ?').run(new Date(Date.now() + 80).toISOString(), batch.id);
    const headers: Record<string, string> = { 'Content-Length': String(png.length), 'Content-Type': 'image/png', 'X-Photo-SHA256': hash };
    const stream = Object.assign(new PassThrough(), {
      header: (name: string) => headers[name],
      setTimeout: () => stream,
    });
    const pending = receivePhoto(stream as unknown as Request, batch.id, crypto.randomUUID(), userId);
    const trickle = setInterval(() => stream.write(png.subarray(0, 1)), 10);
    try { await expect(pending).rejects.toThrow('Photo upload deadline exceeded'); }
    finally { clearInterval(trickle); }
    expect(scratchUsage()).toBe(0);
    await sweepCaptures();
    expect(getDb().prepare('SELECT state FROM capture_batches WHERE id = ?').get(batch.id)).toEqual({ state: 'expired' });
  });
});

it('upgrades existing item records without changing IDs and invalidates snapshots on manual edits', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE bins (id TEXT PRIMARY KEY);
      CREATE TABLE bin_items (id TEXT PRIMARY KEY,bin_id TEXT,name TEXT);
      INSERT INTO bin_items VALUES ('existing','drawer','Cable');`);
    captureBatches.sqlite!(db);
    captureBatches.sqlite!(db);
    expect(db.prepare('SELECT id,name,observation_state,aliases_json FROM bin_items').get()).toEqual({
      id: 'existing', name: 'Cable', observation_state: 'unknown', aliases_json: '[]',
    });
    db.prepare('INSERT INTO bins (id) VALUES (?)').run('drawer');
    db.prepare('INSERT INTO bin_capture_state (bin_id) VALUES (?)').run('drawer');
    db.prepare('UPDATE bin_items SET name = ? WHERE id = ?').run('New label', 'existing');
    expect(db.prepare('SELECT revision FROM bin_capture_state').get()).toEqual({ revision: 1 });
  } finally { db.close(); }
});

describe('capture cleanup and inventory', () => {
  it('defers expiry while an input is active, then removes all files and marks cleanup complete', async () => {
    const { body: batch } = await create();
    await upload(batch.id);
    const release = holdCapture(batch.id);
    getDb().prepare('UPDATE capture_batches SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', batch.id);
    await sweepCaptures();
    expect(fs.existsSync(captureDirectory(batch.id))).toBe(true);
    expect(getDb().prepare('SELECT state FROM capture_batches WHERE id = ?').get(batch.id)).toEqual({ state: 'uploading' });
    release();
    await sweepCaptures();
    expect(fs.existsSync(captureDirectory(batch.id))).toBe(false);
    expect(getDb().prepare('SELECT state,cleanup_completed_at FROM capture_batches WHERE id = ?').get(batch.id)).toEqual({ state: 'expired', cleanup_completed_at: expect.any(String) });
  });

  it('retries failed deletions without declaring cleanup successful or freeing quota', async () => {
    const { body: batch } = await create();
    await upload(batch.id);
    getDb().prepare("UPDATE capture_batches SET state = 'applied' WHERE id = ?").run(batch.id);
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('disk busy'); });
    expect(await cleanupCapture(batch.id)).toBe(false);
    expect(scratchUsage()).toBe(png.length);
    expect(await cleanupCapture(batch.id)).toBe(true);
    expect(await cleanupCapture(batch.id)).toBe(true);
    expect(scratchUsage()).toBe(0);
  });

  it('returns aliases, descriptions and last-known observations after image deletion with household-scoped search', async () => {
    getDb().prepare(`INSERT INTO bin_items
      (id,bin_id,name,description,aliases_json,last_seen_at,observation_state)
      VALUES (?,?,?,?,?,?,?)`).run(crypto.randomUUID(), binId, 'USB cable', 'Braided blue cable', '["charging cord"]', '2026-11-06T00:00:00.000Z', 'not_seen_in_latest_capture');
    const result = await request(app).get('/api/captures/inventory?q=charging').set('Authorization', `Bearer ${token}`);
    expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]).toMatchObject({ name: 'USB cable', aliases: ['charging cord'], quantity: null, observation_state: 'not_seen_in_latest_capture' });
    const stranger = await createTestUser(app);
    expect((await request(app).get('/api/captures/inventory?q=charging').set('Authorization', `Bearer ${stranger.token}`)).body.items).toEqual([]);
  });
});
