import crypto from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../db.js';
import { createApp } from '../../index.js';
import { signToken } from '../../middleware/auth.js';
import { HttpError } from '../httpErrors.js';
import { deduplicatePlace } from './deduplicate.js';
import { dismissPhotoHistory } from './history.js';
import { recognizeCapture } from './recognition.js';

const app = createApp();
let userId: string, binId: string, token: string, jpeg: Buffer;
const at = '2026-11-01T12:00:00.000Z';
const later = '2026-11-02T12:00:00.000Z';
const envelope = (groups: string[][]) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ groups }) } }] }));
const row = (id: string) => getDb().prepare('SELECT * FROM bin_items WHERE id=?').get(id) as Record<string, unknown>;
const send = async () => {
  try { return { status: 200, body: await deduplicatePlace(binId, userId) }; }
  catch (error) { if (error instanceof HttpError) return { status: error.statusCode, body: { merged_items: undefined } }; throw error; }
};

function evidence(name: string, position = 0, quantity: number | null = 1, bin = binId, shared?: { captureId: string; photoId: string }) {
  const db = getDb(), id = crypto.randomUUID(), observationId = crypto.randomUUID();
  const captureId = shared?.captureId ?? crypto.randomUUID(), photoId = shared?.photoId ?? crypto.randomUUID();
  const timestamp = position ? later : at;
  if (!shared) {
    db.prepare(`INSERT INTO capture_batches (id,bin_id,created_by,captured_at,sequence,state,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'applied',?,?,?)`).run(captureId, bin, userId, timestamp, position + 1, timestamp, timestamp, timestamp);
    db.prepare(`INSERT INTO capture_photos (capture_id,id,position,sha256,size,mime_type,storage_path,received_at)
      VALUES (?,?,0,?,4,'image/jpeg','/tmp/removed-original',?)`).run(captureId, photoId, 'a'.repeat(64), timestamp);
    db.prepare('INSERT INTO capture_photo_history (capture_id,photo_id,preview_jpeg,width,height) VALUES (?,?,?,80,60)').run(captureId, photoId, jpeg);
  }
  db.prepare(`INSERT INTO bin_items (id,bin_id,name,description,quantity,position,aliases_json,normalized_name,last_seen_batch_id,last_seen_at,capture_created,updated_at)
    VALUES (?,?,?,'White camera',?,?,'["camera"]','camera',?,?,1,?)`).run(id, bin, name, quantity, position, captureId, timestamp, timestamp);
  db.prepare(`INSERT INTO observations (id,capture_id,item_id,name,description,quantity,aliases_json,photo_ids_json,created_at)
    VALUES (?,?,?,?,'White camera',?,'["camera"]',?,?)`).run(observationId, captureId, id, name, quantity, JSON.stringify([photoId]), timestamp);
  db.prepare('INSERT INTO observation_photos (observation_id,capture_id,photo_id,crop_jpeg) VALUES (?,?,?,?)').run(observationId, captureId, photoId, jpeg);
  return { id, observationId, captureId, photoId };
}
beforeEach(async () => {
  vi.stubEnv('AI_ENDPOINT_URL', 'https://gateway.test/v1'); vi.stubEnv('AI_MODEL', 'vision'); vi.stubEnv('AI_API_KEY', 'test-key');
  userId = crypto.randomUUID(); binId = crypto.randomUUID(); const locationId = crypto.randomUUID();
  const db = getDb();
  db.prepare('INSERT INTO users (id,email,display_name) VALUES (?,?,?)').run(userId, `${userId}@test.invalid`, 'Dedup tester');
  db.prepare('INSERT INTO locations (id,name,created_by,invite_code) VALUES (?,?,?,?)').run(locationId, 'Home', userId, crypto.randomUUID());
  db.prepare("INSERT INTO location_members (id,location_id,user_id,role) VALUES (?,?,?,'admin')").run(crypto.randomUUID(), locationId, userId);
  db.prepare('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES (?,?,?,?,?)').run(binId, 'DEDUP', locationId, 'Shelf', userId);
  db.prepare('INSERT INTO bin_capture_state (bin_id) VALUES (?)').run(binId);
  jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#eeeeee' } }).jpeg().toBuffer();
  token = await signToken({ id: userId, email: `${userId}@test.invalid` });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('place photo deduplication', () => {
  it('merges cross-photo identities at the earliest position, keeps all crops/history, and never adds quantities', async () => {
    const first = evidence('Camera', 0, 1), second = evidence('小米室外摄像头', 1, 1);
    // A voice correction on the newer row takes precedence over the generic older name.
    getDb().prepare('UPDATE observations SET updated_at=? WHERE id=?').run(later, second.observationId);
    const fetcher = vi.fn().mockResolvedValue(envelope([[second.id, first.id]])); vi.stubGlobal('fetch', fetcher);
    const result = await send();
    expect(result.status).toBe(200); expect(result.body).toEqual({ merged_items: 1, merged_groups: 1, redirects: [{ from_id: second.id, into_id: first.id }] });
    expect(row(first.id)).toMatchObject({ name: '小米室外摄像头', quantity: 1, position: 0, capture_created: 1, deleted_at: null });
    expect(row(second.id).deleted_at).not.toBeNull();
    expect(getDb().prepare('SELECT item_id FROM observations ORDER BY id').all()).toEqual([{ item_id: first.id }, { item_id: first.id }]);
    expect(getDb().prepare('SELECT crop_jpeg FROM observation_photos').all()).toEqual([{ crop_jpeg: jpeg }, { crop_jpeg: jpeg }]);
    const history = (await request(app).get('/api/captures/history').set('Authorization', `Bearer ${token}`)).body.photos;
    expect(history).toHaveLength(2); expect(history.every((photo: { items: Array<{ item_id: string }> }) => photo.items[0].item_id === first.id)).toBe(true);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.messages[1].content.filter((part: { type: string }) => part.type === 'image_url')).toHaveLength(2);
    expect(body.messages[1].content[0].text).toContain(second.photoId);
    // Deleting the latest photo restores the remaining evidence but keeps the voice correction.
    await dismissPhotoHistory(second.captureId, second.photoId, userId);
    expect(row(first.id)).toMatchObject({ name: '小米室外摄像头', deleted_at: null, last_seen_batch_id: first.captureId });
    await dismissPhotoHistory(first.captureId, first.photoId, userId);
    expect(row(first.id).deleted_at).not.toBeNull();
  });
  it('keeps separate co-visible objects even if a model groups their identical names', async () => {
    const first = evidence('Camera'), second = evidence('Camera', 1, 1, binId, first);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope([[first.id, second.id]])));
    expect((await send()).body.merged_items).toBe(0);
    expect(row(first.id).deleted_at).toBeNull(); expect(row(second.id).deleted_at).toBeNull();
  });
  it('preserves a manual item when all merged photo evidence is deleted', async () => {
    const first = evidence('Camera'), second = evidence('Camera', 1);
    getDb().prepare('UPDATE bin_items SET capture_created=0 WHERE id=?').run(second.id);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope([[first.id, second.id]])));
    expect((await send()).status).toBe(200);
    await dismissPhotoHistory(first.captureId, first.photoId, userId);
    await dismissPhotoHistory(second.captureId, second.photoId, userId);
    expect(row(first.id)).toMatchObject({ deleted_at: null, capture_created: 0, last_seen_batch_id: null });
  });
  it.each(['edit', 'delete', 'dismiss'] as const)('does not overwrite a concurrent %s during inference', async action => {
    const first = evidence('Camera'), second = evidence('Camera', 1);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      if (action === 'edit') getDb().prepare("UPDATE bin_items SET name='My correction' WHERE id=?").run(second.id);
      if (action === 'delete') getDb().prepare('UPDATE bin_items SET deleted_at=? WHERE id=?').run(later, second.id);
      if (action === 'dismiss') await dismissPhotoHistory(second.captureId, second.photoId, userId);
      return envelope([[first.id, second.id]]);
    }));
    expect((await send()).status).toBe(409);
    expect(row(first.id)).toMatchObject({ name: 'Camera', deleted_at: null });
    expect(getDb().prepare('SELECT item_id FROM observations WHERE id=?').get(first.observationId)).toEqual({ item_id: first.id });
  });
  it.each(['unknown', 'overlapping', 'unavailable'] as const)('leaves originals intact on %s model output', async kind => {
    const first = evidence('Camera'), second = evidence('Camera', 1);
    const before = [row(first.id), row(second.id)];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(kind === 'unavailable' ? new Response('', { status: 503 }) : envelope(
      kind === 'unknown' ? [[first.id, crypto.randomUUID()]] : [[first.id, second.id], [first.id, second.id]])));
    expect((await send()).status).toBe(502); expect([row(first.id), row(second.id)]).toEqual(before);
  });
  it('scopes references to the selected place and denies viewer writes before model access', async () => {
    const first = evidence('Camera'), second = evidence('Camera', 1);
    const db = getDb(), otherBin = crypto.randomUUID();
    const place = db.prepare('SELECT location_id FROM bins WHERE id=?').get(binId) as { location_id: string };
    db.prepare('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES (?,?,?,?,?)').run(otherBin, 'OTHER', place.location_id, 'Other shelf', userId);
    const other = evidence('Another place camera', 2, 1, otherBin);
    const fetcher = vi.fn().mockResolvedValue(envelope([[first.id, second.id]])); vi.stubGlobal('fetch', fetcher);
    expect((await send()).status).toBe(200);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).messages[1].content[0].text).not.toContain(other.id);
    expect(row(other.id).deleted_at).toBeNull();
    fetcher.mockClear(); db.prepare("UPDATE location_members SET role='viewer' WHERE user_id=?").run(userId);
    expect((await send()).status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
  });
  it('supplies existing crop references to subsequent photo recognition', async () => {
    const first = evidence('Camera');
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"usable":true,"items":[]}' } }] })));
    vi.stubGlobal('fetch', fetcher);
    await recognizeCapture({ captureId: 'new', binId, binName: 'Shelf', photos: [], existingItems: [{ id: first.id, name: 'Camera', description: '', quantity: 1, aliases: [] }] });
    const content = JSON.parse(fetcher.mock.calls[0][1].body).messages[1].content;
    expect(content[1].text).toContain(first.id); expect(content[2].type).toBe('image_url');
  });
});
