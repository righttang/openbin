import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../db.js';
import { createApp } from '../../index.js';
import { signToken } from '../../middleware/auth.js';
import { dismissObservation } from './history.js';

const app = createApp();
let userId: string, binId: string, captureId: string, photoId: string, itemId: string, observationId: string, token: string;
const at = '2026-11-01T12:00:00.000Z';
const crop = Buffer.from('retained-item-crop');
const corrected = { name: '小米室外摄像头', description: '白色小米室外摄像头，用于室外监控。', aliases: ['监控', '室外摄像机'] };
const envelope = (value: unknown = corrected) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { status: 200 });
const path = () => `/api/captures/observations/${observationId}/refine`;
const send = (instruction: unknown = '啊，这个是小米室外的摄像头。', route = path()) => request(app).post(route).set('Authorization', `Bearer ${token}`).send({ instruction });
const item = () => getDb().prepare('SELECT * FROM bin_items WHERE id=?').get(itemId) as Record<string, unknown>;

beforeEach(async () => {
  vi.stubEnv('AI_ENDPOINT_URL', 'https://gateway.test/v1'); vi.stubEnv('AI_MODEL', 'vision'); vi.stubEnv('AI_API_KEY', 'test-key');
  [userId, binId, captureId, photoId, itemId, observationId] = Array.from({ length: 6 }, () => crypto.randomUUID());
  const locationId = crypto.randomUUID();
  const db = getDb();
  db.prepare('INSERT INTO users (id,email,display_name) VALUES (?,?,?)').run(userId, `${userId}@test.invalid`, 'Voice tester');
  db.prepare('INSERT INTO locations (id,name,created_by,invite_code) VALUES (?,?,?,?)').run(locationId, 'Home', userId, crypto.randomUUID());
  db.prepare("INSERT INTO location_members (id,location_id,user_id,role) VALUES (?,?,?,'admin')").run(crypto.randomUUID(), locationId, userId);
  db.prepare('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES (?,?,?,?,?)').run(binId, 'VOICE', locationId, 'Desk', userId);
  db.prepare('INSERT INTO bin_capture_state (bin_id) VALUES (?)').run(binId);
  db.prepare(`INSERT INTO capture_batches (id,bin_id,created_by,captured_at,sequence,state,expires_at,created_at,updated_at)
    VALUES (?,?,?,?,1,'applied',?,?,?)`).run(captureId, binId, userId, at, at, at, at);
  db.prepare(`INSERT INTO capture_photos (capture_id,id,position,sha256,size,mime_type,storage_path,received_at)
    VALUES (?,?,0,?,4,'image/jpeg','/tmp/removed-original',?)`).run(captureId, photoId, 'a'.repeat(64), at);
  db.prepare('INSERT INTO capture_photo_history (capture_id,photo_id,preview_jpeg,width,height) VALUES (?,?,?,640,480)').run(captureId, photoId, Buffer.from('full-photo'));
  db.prepare(`INSERT INTO bin_items (id,bin_id,name,description,quantity,aliases_json,normalized_name,last_seen_batch_id,last_seen_at,capture_created,updated_at)
    VALUES (?,?,'Camera','White camera',2,'["camera"]','camera',?,?,1,?)`).run(itemId, binId, captureId, at, at);
  db.prepare(`INSERT INTO observations (id,capture_id,item_id,name,description,quantity,aliases_json,photo_ids_json,created_at)
    VALUES (?,?,?,'Camera','White camera',2,'["camera"]',?,?)`).run(observationId, captureId, itemId, JSON.stringify([photoId]), at);
  db.prepare('INSERT INTO observation_photos (observation_id,capture_id,photo_id,crop_jpeg) VALUES (?,?,?,?)').run(observationId, captureId, photoId, crop);
  token = await signToken({ id: userId, email: `${userId}@test.invalid` });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('spoken item correction', () => {
  it('sends the selected crop, current record and transcript in one request, then updates history and search', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope()); vi.stubGlobal('fetch', fetcher);
    const before = item();
    const revision = (getDb().prepare('SELECT revision FROM bin_capture_state WHERE bin_id=?').get(binId) as { revision: number }).revision;
    const response = await send();
    expect(response.status).toBe(200); expect(response.body).toEqual({ ...corrected, item_id: itemId, observation_id: observationId });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.messages[1].content[0].text).toContain('小米室外的摄像头');
    expect(JSON.parse(body.messages[1].content[0].text).current_item.name).toBe('Camera');
    expect(body.messages[1].content[1].image_url.url).toBe(`data:image/jpeg;base64,${crop.toString('base64')}`);
    expect(body.store).toBe(false);
    expect(item()).toMatchObject({ name: corrected.name, description: corrected.description, quantity: before.quantity, bin_id: before.bin_id,
      last_seen_at: before.last_seen_at, last_seen_batch_id: before.last_seen_batch_id });
    const history = await request(app).get('/api/captures/history').set('Authorization', `Bearer ${token}`);
    expect(history.body.photos[0].items[0]).toMatchObject(corrected);
    const search = await request(app).get('/api/captures/inventory').query({ q: '监控' }).set('Authorization', `Bearer ${token}`);
    expect(search.body.items.map((v: { id: string }) => v.id)).toContain(itemId);
    expect((getDb().prepare('SELECT revision FROM bin_capture_state WHERE bin_id=?').get(binId) as { revision: number }).revision).toBeGreaterThan(revision);
  });
  it('also corrects from an inventory detail and falls back to the whole photo when no crop exists', async () => {
    getDb().prepare('UPDATE observation_photos SET crop_jpeg=NULL WHERE observation_id=?').run(observationId);
    const fetcher = vi.fn().mockResolvedValue(envelope()); vi.stubGlobal('fetch', fetcher);
    expect((await send(undefined, `/api/captures/items/${itemId}/refine`)).status).toBe(200);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.messages[1].content[1].image_url.url).toBe(`data:image/jpeg;base64,${Buffer.from('full-photo').toString('base64')}`);
  });
  it('can supplement an old item whose images are no longer retained', async () => {
    getDb().prepare('UPDATE observation_photos SET crop_jpeg=NULL WHERE observation_id=?').run(observationId);
    getDb().prepare('UPDATE capture_photo_history SET preview_jpeg=NULL WHERE capture_id=?').run(captureId);
    const fetcher = vi.fn().mockResolvedValue(envelope()); vi.stubGlobal('fetch', fetcher);
    expect((await send()).status).toBe(200);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).messages[1].content).toHaveLength(1);
  });
  it.each(['', 'x'.repeat(2001), null])('rejects an invalid instruction without calling the model', async instruction => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await send(instruction)).status).toBe(422); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ name: '', description: 'bad', aliases: [] }, { ...corrected, quantity: 99 }])('retains the original record when the model output is invalid', async result => {
    const before = item(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope(result)));
    expect((await send()).status).toBe(502); expect(item()).toEqual(before);
  });
  it('keeps the original record and returns a useful error when the gateway is unavailable', async () => {
    const before = item(); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private gateway details')));
    const response = await send(); expect(response.status).toBe(502); expect(response.text).not.toContain('private gateway'); expect(item()).toEqual(before);
  });
  it('does not resurrect a result removed while inference is running', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => { await dismissObservation(observationId, userId); return envelope(); }));
    expect((await send()).status).toBe(404);
    expect(item().deleted_at).not.toBeNull();
    expect(getDb().prepare('SELECT dismissed_at FROM observations WHERE id=?').get(observationId)).toMatchObject({ dismissed_at: expect.any(String) });
  });
  it('still removes a corrected unique item when its only recognition is deleted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope()));
    expect((await send()).status).toBe(200);
    const removed = await dismissObservation(observationId, userId);
    expect(removed.removed_items).toBe(1);
    expect(item().deleted_at).not.toBeNull();
  });
  it('preserves a newer edit made while inference is running', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      getDb().prepare('UPDATE bin_items SET name=? WHERE id=?').run('Newer correction', itemId); return envelope();
    }));
    expect((await send()).status).toBe(409); expect(item().name).toBe('Newer correction');
  });
  it('does not send an inaccessible item to the model', async () => {
    const outsider = crypto.randomUUID();
    getDb().prepare('INSERT INTO users (id,email,display_name) VALUES (?,?,?)').run(outsider, `${outsider}@test.invalid`, 'Other');
    token = await signToken({ id: outsider, email: `${outsider}@test.invalid` });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await send()).status).toBe(404); expect(fetcher).not.toHaveBeenCalled();
  });
});
