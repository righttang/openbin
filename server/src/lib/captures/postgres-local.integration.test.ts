import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { closeDb, initialize } from '../../db/init.js';
import { query } from '../../db.js';
import { createApp } from '../../index.js';
import { initializeLocalMode } from '../localMode.js';
import { captureConfig } from './config.js';
import { processNextCapture } from './worker.js';

vi.hoisted(() => { process.env.REMINDME_LOCAL_MODE = 'true'; });

beforeAll(async () => {
  const database = new URL(process.env.DATABASE_URL!);
  if (!database.pathname.endsWith('_capture_test')) throw new Error('Fresh startup tests require a dedicated *_capture_test database');
  const pool = new pg.Pool({ connectionString: database.href });
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
  } finally { await pool.end(); }
  await initialize();
  await initializeLocalMode();
});

afterAll(async () => {
  fs.rmSync(captureConfig.scratchPath, { recursive: true, force: true });
  const { closeThumbnailPool } = await import('../thumbnailPool.js');
  await closeThumbnailPool();
  await closeDb();
});

it('starts from an empty PostgreSQL schema and completes a photo capture without login', async () => {
  const app = createApp();
  expect((await query('SELECT COUNT(*) AS n FROM bin_items')).rows[0].n).toBe(0);
  expect((await query('SELECT COUNT(*) AS n FROM capture_batches')).rows[0].n).toBe(0);
  const me = await request(app).get('/api/auth/me');
  expect(me.status).toBe(200);
  const cookies = me.headers['set-cookie'] as unknown as string[];
  const cookie = cookies.find(value => value.startsWith('openbin-csrf='))!.split(';')[0];
  const csrf = cookie.slice('openbin-csrf='.length);
  const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
  const created = await request(app).post('/api/bins').set(headers).send({ name: '新地点', locationId: me.body.activeLocationId });
  expect(created.status).toBe(201);
  const captureId = crypto.randomUUID();
  expect((await request(app).post('/api/captures').set(headers).send({ id: captureId, bin_id: created.body.id })).status).toBe(201);
  const photoId = crypto.randomUUID();
  const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#dd8833' } }).png().toBuffer();
  const sha256 = crypto.createHash('sha256').update(png).digest('hex');
  expect((await request(app).put(`/api/captures/${captureId}/photos/${photoId}`).set(headers)
    .set('Content-Type', 'image/png').set('X-Photo-SHA256', sha256).send(png)).status).toBe(200);
  expect((await request(app).post(`/api/captures/${captureId}/complete`).set(headers)
    .send({ photos: [{ id: photoId, sha256, size: png.length, order: 0 }] })).body.state).toBe('queued');
  await processNextCapture({ recognize: async () => ({ usable: true, items: [{
    name: '充电线', description: '橙色充电线', aliases: ['数据线'], quantity: 1, existing_item_id: null,
    photo_ids: [photoId], regions: [{ photo_id: photoId, box: [0.1, 0.1, 0.9, 0.8] }],
  }] }) });
  const history = await request(app).get('/api/captures/history');
  expect(history.status).toBe(200);
  expect(history.body.photos).toHaveLength(1);
  expect(history.body.photos[0]).toMatchObject({ state: 'applied', items: [{ name: '充电线', quantity: 1 }] });
  const image = await request(app).get(history.body.photos[0].items[0].crop_url);
  expect(image.status).toBe(200);
  expect((await sharp(image.body).metadata()).format).toBe('jpeg');
  await initializeLocalMode();
  const secondDevice = await request(app).get('/api/auth/me');
  expect(secondDevice.body.id).toBe(me.body.id);
  expect(secondDevice.body.activeLocationId).toBe(me.body.activeLocationId);
  expect((await request(app).get('/api/captures/inventory')).body.items).toHaveLength(1);
});
