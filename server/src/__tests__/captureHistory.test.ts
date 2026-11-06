import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureHistory } from '../db/migrations/0015_capture_history.js';
import { getDb } from '../db.js';
import { createApp } from '../index.js';
import { canStoreHistoryBytes, storePhotoPreview } from '../lib/captures/history.js';
import { signToken } from '../middleware/auth.js';

const app = createApp();
const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
let userId: string;
let locationId: string;
let binId: string;
let token: string;
const initialQuota = process.env.CAPTURE_HISTORY_QUOTA_BYTES;

beforeEach(async () => {
  const db = getDb();
  userId = crypto.randomUUID();
  locationId = crypto.randomUUID();
  binId = crypto.randomUUID();
  db.prepare('INSERT INTO users (id,email,display_name) VALUES (?,?,?)').run(userId, `${userId}@test.invalid`, 'Home');
  db.prepare('INSERT INTO locations (id,name,created_by,invite_code) VALUES (?,?,?,?)').run(locationId, 'Home', userId, crypto.randomUUID());
  db.prepare('INSERT INTO location_members (id,location_id,user_id,role) VALUES (?,?,?,?)').run(crypto.randomUUID(), locationId, userId, 'admin');
  db.prepare('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES (?,?,?,?,?)').run(binId, 'BOX', locationId, 'Tray', userId);
  db.prepare('INSERT INTO bin_capture_state (bin_id) VALUES (?)').run(binId);
  token = await signToken({ id: userId, email: `${userId}@test.invalid` });
});

afterEach(() => {
  if (initialQuota === undefined) delete process.env.CAPTURE_HISTORY_QUOTA_BYTES;
  else process.env.CAPTURE_HISTORY_QUOTA_BYTES = initialQuota;
});

function batch(sequence: number, count = 1, state = 'applied', includeHistory = true) {
  const db = getDb();
  const id = crypto.randomUUID();
  const at = `2026-10-${String(sequence).padStart(2, '0')}T12:00:00.000Z`;
  db.prepare(`INSERT INTO capture_batches
    (id,bin_id,created_by,captured_at,received_at,sequence,state,expires_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, binId, userId, at, at, sequence, state, at, at, at);
  const photoIds = Array.from({ length: count }, () => crypto.randomUUID());
  for (const [position, photoId] of photoIds.entries()) {
    db.prepare(`INSERT INTO capture_photos
      (capture_id,id,position,sha256,size,mime_type,storage_path,received_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, photoId, position, 'a'.repeat(64), 4, 'image/jpeg', `/tmp/${id}/${photoId}`, at);
    if (includeHistory) storePhotoPreview(id, photoId, { jpeg: image, width: 20, height: 10 });
  }
  return { id, at, photoIds };
}

function observe(capture: ReturnType<typeof batch>, itemId = crypto.randomUUID(), name = 'Headphones', quantity: number | null = 1, photoIds = capture.photoIds, links = true) {
  const db = getDb();
  db.prepare(`INSERT INTO bin_items
    (id,bin_id,name,quantity,description,aliases_json,last_seen_batch_id,last_seen_at,observation_state,capture_created,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'seen',1,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,quantity=excluded.quantity,description=excluded.description,
    aliases_json=excluded.aliases_json,last_seen_batch_id=excluded.last_seen_batch_id,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`)
    .run(itemId, binId, name, quantity, `${name} description`, JSON.stringify([name.toLowerCase()]), capture.id, capture.at, capture.at, capture.at);
  const observationId = crypto.randomUUID();
  db.prepare(`INSERT INTO observations (id,capture_id,item_id,name,description,quantity,aliases_json,photo_ids_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(observationId, capture.id, itemId, name, `${name} description`, quantity,
      JSON.stringify([name.toLowerCase()]), JSON.stringify(photoIds), capture.at);
  if (links) {
    for (const photoId of photoIds) db.prepare(`INSERT INTO observation_photos
      (observation_id,capture_id,photo_id,bbox_json,crop_jpeg) VALUES (?,?,?,?,?)`)
      .run(observationId, capture.id, photoId, '[0.1,0.2,0.5,0.8]', image);
  }
  return { itemId, observationId };
}

function remove(capture: ReturnType<typeof batch>, photoId = capture.photoIds[0], auth = token) {
  return request(app).delete(`/api/captures/${capture.id}/photos/${photoId}/history`).set('Authorization', `Bearer ${auth}`);
}

describe('photo recognition history', () => {
  it('groups results by photo and serves authorized previews and item crops', async () => {
    const capture = batch(1, 2);
    const first = observe(capture, undefined, 'Headphones', 1, [capture.photoIds[0]]);
    observe(capture, undefined, 'Power board', 1, [capture.photoIds[1]]);
    const response = await request(app).get(`/api/captures/history?bin_id=${binId}`).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.photos).toHaveLength(2);
    expect(response.body.photos[0]).toMatchObject({ photo_id: capture.photoIds[0], bin_name: 'Tray', state: 'applied' });
    expect(response.body.photos[0].items).toMatchObject([{ observation_id: first.observationId, name: 'Headphones', quantity: 1 }]);
    const preview = await request(app).get(response.body.photos[0].preview_url).set('Authorization', `Bearer ${token}`);
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toContain('image/jpeg');
    expect(preview.headers['cache-control']).toBe('no-store');
    expect(preview.body).toEqual(image);
    const crop = await request(app).get(response.body.photos[0].items[0].crop_url).set('Authorization', `Bearer ${token}`);
    expect(crop.status).toBe(200);
    expect(crop.body).toEqual(image);
    const inventory = await request(app).get('/api/captures/inventory').set('Authorization', `Bearer ${token}`);
    expect(inventory.body.items.find((item: { id: string }) => item.id === first.itemId)).toMatchObject({
      observation_id: first.observationId, crop_url: response.body.photos[0].items[0].crop_url,
    });
  });

  it('keeps multi-photo evidence until its last supporting photo is removed', async () => {
    const capture = batch(1, 2);
    const item = observe(capture);
    expect((await remove(capture)).body.removed_items).toBe(0);
    expect(getDb().prepare('SELECT dismissed_at FROM observations WHERE id=?').get(item.observationId)).toEqual({ dismissed_at: null });
    expect((await request(app).get('/api/captures/history').set('Authorization', `Bearer ${token}`)).body.photos).toHaveLength(1);
    expect((await remove(capture, capture.photoIds[1])).body.removed_items).toBe(1);
    expect(getDb().prepare('SELECT deleted_at FROM bin_items WHERE id=?').get(item.itemId)).toEqual({ deleted_at: expect.any(String) });
    expect((await request(app).get('/api/captures/inventory').set('Authorization', `Bearer ${token}`)).body.items).toHaveLength(0);
    expect((await remove(capture, capture.photoIds[1])).body).toEqual({ removed: true, removed_items: 0 });
    expect((await request(app).get('/api/captures').set('Authorization', `Bearer ${token}`)).body.captures).toHaveLength(0);
    expect(getDb().prepare('SELECT SUM(length(preview_jpeg)) AS n FROM capture_photo_history').get()).toEqual({ n: null });
    expect(getDb().prepare('SELECT SUM(length(crop_jpeg)) AS n FROM observation_photos').get()).toEqual({ n: null });
    expect((await request(app).get(`/api/captures/${capture.id}/photos/${capture.photoIds[0]}/preview`).set('Authorization', `Bearer ${token}`)).status).toBe(404);
  });

  it('restores the last surviving observation and handles removal in either order', async () => {
    const old = batch(1);
    const item = observe(old, undefined, 'Old headphones', 2);
    const newer = batch(2);
    observe(newer, item.itemId, 'New headphones', null);
    expect((await remove(newer)).status).toBe(200);
    expect(getDb().prepare('SELECT name,quantity,last_seen_batch_id FROM bin_items WHERE id=?').get(item.itemId))
      .toEqual({ name: 'Old headphones', quantity: 2, last_seen_batch_id: old.id });
    expect((await remove(old)).body.removed_items).toBe(1);

    const third = batch(3);
    const other = observe(third, undefined, 'Before', 2);
    const fourth = batch(4);
    observe(fourth, other.itemId, 'After', 3);
    expect((await remove(third)).body.removed_items).toBe(0);
    expect(getDb().prepare('SELECT name,quantity FROM bin_items WHERE id=?').get(other.itemId)).toEqual({ name: 'After', quantity: 3 });
  });

  it('preserves newer manual edits and restores a manual baseline when its recognition disappears', async () => {
    const capture = batch(1);
    const edited = observe(capture);
    getDb().prepare('UPDATE bin_items SET name=?,updated_at=? WHERE id=?').run('My correction', '2026-11-01T12:00:00.000Z', edited.itemId);
    await remove(capture);
    expect(getDb().prepare('SELECT name,deleted_at,last_seen_batch_id,last_seen_at FROM bin_items WHERE id=?').get(edited.itemId))
      .toEqual({ name: 'My correction', deleted_at: null, last_seen_batch_id: null, last_seen_at: null });

    const second = batch(2);
    const manual = observe(second);
    getDb().prepare('UPDATE bin_items SET capture_created=0 WHERE id=?').run(manual.itemId);
    getDb().prepare('INSERT INTO capture_item_baselines (item_id,snapshot_json) VALUES (?,?)').run(manual.itemId, JSON.stringify({
      name: 'Manual original', description: 'Original description', quantity: 4, aliases_json: '[]',
      last_seen_batch_id: null, last_seen_at: null, observation_state: 'unknown', updated_at: '2026-09-01T12:00:00.000Z',
    }));
    await remove(second);
    expect(getDb().prepare('SELECT name,quantity,last_seen_batch_id,deleted_at FROM bin_items WHERE id=?').get(manual.itemId))
      .toEqual({ name: 'Manual original', quantity: 4, last_seen_batch_id: null, deleted_at: null });
  });

  it('backs old text-only observations into photo groups without inventing images', async () => {
    const capture = batch(1, 1, 'applied', false);
    const item = observe(capture, undefined, 'Old item', 1, capture.photoIds, false);
    getDb().prepare('UPDATE bin_items SET capture_created=0 WHERE id=?').run(item.itemId);
    captureHistory.sqlite!(getDb());
    captureHistory.sqlite!(getDb());
    const history = await request(app).get('/api/captures/history').set('Authorization', `Bearer ${token}`);
    expect(history.body.photos[0]).toMatchObject({ preview_url: null, items: [{ name: 'Old item', crop_url: null }] });
    expect((await remove(capture)).body.removed_items).toBe(1);
  });

  it('restores a manual revision newer than the remaining automatic observation', async () => {
    const first = batch(1);
    const item = observe(first, undefined, 'Old automatic name', 1);
    const second = batch(3);
    observe(second, item.itemId, 'New automatic name', 2);
    getDb().prepare('UPDATE bin_items SET capture_created=0 WHERE id=?').run(item.itemId);
    getDb().prepare('INSERT INTO capture_item_baselines (item_id,snapshot_json) VALUES (?,?)').run(item.itemId, JSON.stringify({
      name: 'Manual correction', description: 'User description', quantity: 5, aliases_json: '[]',
      last_seen_batch_id: first.id, last_seen_at: first.at, observation_state: 'seen', updated_at: '2026-10-02 12:00:00',
    }));
    await remove(second);
    expect(getDb().prepare('SELECT name,quantity,description FROM bin_items WHERE id=?').get(item.itemId))
      .toEqual({ name: 'Manual correction', quantity: 5, description: 'User description' });
    // Removing the older observation must not erase the restored manual revision.
    await remove(first);
    expect(getDb().prepare('SELECT name,quantity,deleted_at,last_seen_batch_id,last_seen_at FROM bin_items WHERE id=?').get(item.itemId))
      .toEqual({ name: 'Manual correction', quantity: 5, deleted_at: null, last_seen_batch_id: null, last_seen_at: null });
  });

  it('keeps matched superseded observations as fallback evidence without inventing items', async () => {
    const older = batch(1, 1, 'superseded');
    const item = observe(older, undefined, 'Earlier photo name', 2);
    const newer = batch(2);
    observe(newer, item.itemId, 'Latest photo name', 3);
    await remove(newer);
    expect(getDb().prepare('SELECT name,quantity,last_seen_batch_id,deleted_at FROM bin_items WHERE id=?').get(item.itemId))
      .toEqual({ name: 'Earlier photo name', quantity: 2, last_seen_batch_id: older.id, deleted_at: null });
    const inventory = await request(app).get('/api/captures/inventory').set('Authorization', `Bearer ${token}`);
    expect(inventory.body.items[0].observation_id).toBe(item.observationId);
  });

  it('keeps the history entry if retained-image quota is full and does not replace a dismissed preview', async () => {
    const capture = batch(1, 1, 'queued', false);
    process.env.CAPTURE_HISTORY_QUOTA_BYTES = '1';
    expect(canStoreHistoryBytes(image.length)).toBe(false);
    storePhotoPreview(capture.id, capture.photoIds[0], { jpeg: image, width: 20, height: 10 });
    expect(getDb().prepare('SELECT preview_jpeg FROM capture_photo_history').get()).toEqual({ preview_jpeg: null });
    const oldRevision = (getDb().prepare('SELECT revision FROM bin_capture_state WHERE bin_id=?').get(binId) as { revision: number }).revision;
    await remove(capture);
    expect((getDb().prepare('SELECT revision FROM bin_capture_state WHERE bin_id=?').get(binId) as { revision: number }).revision).toBeGreaterThan(oldRevision);
    process.env.CAPTURE_HISTORY_QUOTA_BYTES = '1000';
    storePhotoPreview(capture.id, capture.photoIds[0], { jpeg: image, width: 20, height: 10 });
    expect(getDb().prepare('SELECT preview_jpeg FROM capture_photo_history').get()).toEqual({ preview_jpeg: null });
  });

  it('enforces household/private visibility and prevents viewers from removing records', async () => {
    const capture = batch(1);
    const item = observe(capture);
    const otherId = crypto.randomUUID();
    getDb().prepare('INSERT INTO users (id,email,display_name) VALUES (?,?,?)').run(otherId, 'other@test.invalid', 'Other');
    const otherToken = await signToken({ id: otherId, email: 'other@test.invalid' });
    expect((await request(app).get('/api/captures/history').set('Authorization', `Bearer ${otherToken}`)).body.photos).toHaveLength(0);
    expect((await remove(capture, capture.photoIds[0], otherToken)).status).toBe(404);
    const cropPath = `/api/captures/observations/${item.observationId}/photos/${capture.photoIds[0]}/crop`;
    expect((await request(app).get(cropPath).set('Authorization', `Bearer ${otherToken}`)).status).toBe(404);
    getDb().prepare('INSERT INTO location_members (id,location_id,user_id,role) VALUES (?,?,?,?)').run(crypto.randomUUID(), locationId, otherId, 'viewer');
    expect((await remove(capture, capture.photoIds[0], otherToken)).status).toBe(403);
    getDb().prepare("UPDATE bins SET visibility='private' WHERE id=?").run(binId);
    expect((await request(app).get('/api/captures/history').set('Authorization', `Bearer ${otherToken}`)).body.photos).toHaveLength(0);
    expect((await request(app).get(cropPath).set('Authorization', `Bearer ${otherToken}`)).status).toBe(404);
  });
});
