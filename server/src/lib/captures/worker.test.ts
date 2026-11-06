import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../db.js';
import { captureDirectory, sweepCaptures } from './cleanup.js';
import { dismissPhotoHistory, listPhotoHistory } from './history.js';
import type { RecognitionResult, Recognizer } from './recognition.js';
import { CaptureProcessingError, recognizeCapture, validateRecognition } from './recognition.js';
import { processNextCapture } from './worker.js';

const userId = 'capture-test-user';
const locationId = 'capture-test-location';
const binId = 'capture-test-bin';
let bytes: Buffer;
const directories = new Set<string>();

beforeEach(async () => {
  const db = getDb();
  db.prepare('INSERT INTO users (id,email,display_name) VALUES (?,?,?)').run(userId, 'capture-test@example.com', 'Capture Test');
  db.prepare('INSERT INTO locations (id,name,invite_code,created_by) VALUES (?,?,?,?)').run(locationId, 'Home', 'capture-test-invite', userId);
  db.prepare('INSERT INTO location_members (id,location_id,user_id,role) VALUES (?,?,?,?)').run('capture-member', locationId, userId, 'admin');
  db.prepare('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES (?,?,?,?,?)').run(binId, 'CAPTEST', locationId, 'Study drawer', userId);
  db.prepare('INSERT INTO bin_capture_state (bin_id) VALUES (?)').run(binId);
  bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function capture(sequence: number, photoCount = 2) {
  const db = getDb();
  const id = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const directory = captureDirectory(id);
  directories.add(directory);
  fs.mkdirSync(directory, { recursive: true });
  const photos = Array.from({ length: photoCount }, (_, order) => ({
    id: crypto.randomUUID(), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length, order,
  }));
  db.prepare(`INSERT INTO capture_batches
    (id,bin_id,created_by,captured_at,sequence,manifest_json,state,expires_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'queued',?,?,?)`).run(id, binId, userId, now, sequence,
      JSON.stringify(photos), new Date(Date.now() + 3600_000).toISOString(), now, now);
  for (const photo of photos) {
    const filename = path.join(directory, photo.id);
    fs.writeFileSync(filename, bytes);
    db.prepare(`INSERT INTO capture_photos (capture_id,id,position,sha256,size,mime_type,storage_path,received_at)
      VALUES (?,?,?,?,?,'image/png',?,?)`).run(id, photo.id, photo.order, photo.sha256, photo.size, filename, now);
  }
  db.prepare(`INSERT INTO analysis_jobs (id,capture_id,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?)`)
    .run(jobId, id, now, now, now);
  return { id, jobId, photos, directory };
}

function recognized(photoIds: string[], existingId: string | null = null, quantity: number | null = null): RecognitionResult {
  return { usable: true, items: [{
    name: 'USB-C cable', description: 'Black braided cable, silver connectors', aliases: ['charging cable'],
    quantity, existing_item_id: existingId, photo_ids: photoIds,
  }] };
}

function job(id: string) {
  return getDb().prepare('SELECT * FROM analysis_jobs WHERE id=?').get(id) as {
    state: string; error_category: string | null; attempts: number; next_attempt_at: string;
  };
}

describe('durable capture recognition', () => {
  it('keeps a real item crop after original cleanup and removes it with its last photo record', async () => {
    const batch = capture(1, 1);
    const result = recognized([batch.photos[0].id], null, 1);
    result.items[0].regions = [{ photo_id: batch.photos[0].id, box: [0.1, 0.1, 0.8, 0.8] }];
    await processNextCapture({ recognize: async () => result });
    expect(job(batch.jobId).state).toBe('applied');
    expect(fs.existsSync(batch.directory)).toBe(false);
    const media = getDb().prepare('SELECT crop_jpeg FROM observation_photos').get() as { crop_jpeg: Buffer };
    expect((await sharp(media.crop_jpeg).metadata()).format).toBe('jpeg');
    expect(listPhotoHistory(userId, binId, null)[0].items[0].crop_url).toBeTruthy();
    await dismissPhotoHistory(batch.id, batch.photos[0].id, userId);
    expect(listPhotoHistory(userId, binId, null)).toEqual([]);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM bin_items WHERE deleted_at IS NULL').get()).toEqual({ n: 0 });
    expect(getDb().prepare('SELECT crop_jpeg FROM observation_photos').get()).toEqual({ crop_jpeg: null });
  });

  it('does not resurrect a photo or its items when dismissed while the model is running', async () => {
    const batch = capture(1, 1);
    await processNextCapture({ recognize: async (input) => {
      await dismissPhotoHistory(batch.id, batch.photos[0].id, userId);
      return recognized(input.photos.map((photo) => photo.id));
    } });
    expect(job(batch.jobId).state).toBe('applied');
    expect(getDb().prepare('SELECT * FROM bin_items').all()).toEqual([]);
    expect(getDb().prepare('SELECT * FROM observations').all()).toEqual([]);
    expect(listPhotoHistory(userId, binId, null)).toEqual([]);
    expect(fs.existsSync(batch.directory)).toBe(false);
  });

  it('restores a newer manual edit when a subsequent recognition is removed', async () => {
    const first = capture(1, 1);
    await processNextCapture({ recognize: async () => recognized(first.photos.map((p) => p.id), null, 1) });
    const { id } = getDb().prepare('SELECT id FROM bin_items').get() as { id: string };
    const manualTime = new Date(Date.now() + 1000).toISOString();
    getDb().prepare('UPDATE bin_items SET name=?,quantity=?,updated_at=? WHERE id=?')
      .run('My labelled cable', 7, manualTime, id);
    const second = capture(2, 1);
    await processNextCapture({
      recognize: async () => recognized(second.photos.map((p) => p.id), id, 2),
      now: () => new Date(Date.parse(manualTime) + 1000),
    });
    expect(job(second.jobId).state).toBe('applied');
    await dismissPhotoHistory(second.id, second.photos[0].id, userId);
    expect(getDb().prepare('SELECT name,quantity,deleted_at FROM bin_items WHERE id=?').get(id))
      .toEqual({ name: 'My labelled cable', quantity: 7, deleted_at: null });
    await dismissPhotoHistory(first.id, first.photos[0].id, userId);
    expect(getDb().prepare('SELECT name,quantity,deleted_at FROM bin_items WHERE id=?').get(id))
      .toEqual({ name: 'My labelled cable', quantity: 7, deleted_at: null });
    expect(getDb().prepare('SELECT last_seen_at,last_seen_batch_id FROM bin_items WHERE id=?').get(id))
      .toEqual({ last_seen_at: null, last_seen_batch_id: null });
  });

  it('uses one joint request for 20 photos, commits once, and immediately removes inputs', async () => {
    const batch = capture(1, 20);
    const recognize = vi.fn<Recognizer>(async (input) => recognized(input.photos.map((p) => p.id)));
    expect(await processNextCapture({ recognize })).toBe(true);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(recognize.mock.calls[0][0].photos).toHaveLength(20);
    expect(job(batch.jobId).state).toBe('applied');
    const inventory = getDb().prepare('SELECT * FROM bin_items WHERE bin_id=?').all(binId) as Array<{ quantity: number | null }>;
    expect(inventory).toHaveLength(1);
    expect(inventory[0].quantity).toBeNull();
    expect(fs.existsSync(batch.directory)).toBe(false);
    expect(await processNextCapture({ recognize })).toBe(false);
    expect(getDb().prepare('SELECT * FROM observations').all()).toHaveLength(1);
  });

  it('preserves matched IDs, replaces observed quantities, and keeps occluded last-known items', async () => {
    const db = getDb();
    const oldTime = '2026-01-01T00:00:00.000Z';
    db.prepare(`INSERT INTO bin_items (id,bin_id,name,quantity,last_seen_at,observation_state)
      VALUES ('cable',?,'USB-C cable',7,?,'seen'),('hidden',?,'Scissors',1,?,'seen')`).run(binId, oldTime, binId, oldTime);
    const first = capture(1);
    await processNextCapture({ recognize: async () => recognized(first.photos.map((p) => p.id), 'cable', 2) });
    expect(db.prepare('SELECT id,quantity,observation_state FROM bin_items WHERE id=?').get('cable'))
      .toEqual({ id: 'cable', quantity: 2, observation_state: 'seen' });
    expect(db.prepare('SELECT last_seen_at,observation_state FROM bin_items WHERE id=?').get('hidden'))
      .toEqual({ last_seen_at: oldTime, observation_state: 'not_seen_in_latest_capture' });
    const second = capture(2);
    await processNextCapture({ recognize: async () => recognized(second.photos.map((p) => p.id), 'cable', null) });
    expect(db.prepare('SELECT quantity FROM bin_items WHERE id=?').get('cable')).toEqual({ quantity: null });
    expect(db.prepare('SELECT * FROM bin_items').all()).toHaveLength(2);
  });

  it('late older captures retain observations but cannot overwrite newer inventory', async () => {
    const newer = capture(2);
    await processNextCapture({ recognize: async () => recognized(newer.photos.map((p) => p.id), null, 2) });
    const older = capture(1);
    await processNextCapture({ recognize: async () => recognized(older.photos.map((p) => p.id), null, 9) });
    expect(job(older.jobId).state).toBe('superseded');
    expect(getDb().prepare('SELECT quantity FROM bin_items').all()).toEqual([{ quantity: 2 }]);
    expect(getDb().prepare('SELECT quantity FROM observations WHERE capture_id=?').all(older.id)).toEqual([{ quantity: 9 }]);
    expect(fs.existsSync(older.directory)).toBe(false);
  });

  it('invalid model responses retry within a budget and never change previous inventory', async () => {
    const db = getDb();
    db.prepare("INSERT INTO bin_items (id,bin_id,name,quantity) VALUES ('old',?,'Original',4)").run(binId);
    const batch = capture(1);
    const recognize = vi.fn<Recognizer>(async () => recognized(['unknown-photo-id'], 'old', 6));
    let now = new Date();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await processNextCapture({ recognize, now: () => now });
      now = new Date(new Date(job(batch.jobId).next_attempt_at).getTime() + 1);
    }
    expect(job(batch.jobId)).toMatchObject({ state: 'failed', attempts: 3, error_category: 'invalid_response' });
    expect(db.prepare('SELECT name,quantity FROM bin_items').all()).toEqual([{ name: 'Original', quantity: 4 }]);
    expect(db.prepare('SELECT * FROM observations').all()).toHaveLength(0);
    expect(fs.existsSync(batch.directory)).toBe(true);
    db.prepare('UPDATE capture_batches SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', batch.id);
    await sweepCaptures();
    expect(fs.existsSync(batch.directory)).toBe(false);
  });

  it('reclaims an expired process lease after restart', async () => {
    const batch = capture(1);
    const db = getDb();
    db.prepare(`UPDATE analysis_jobs SET state='processing',attempts=1,lease_token='previous-process',lease_until=? WHERE id=?`)
      .run('2000-01-01T00:00:00.000Z', batch.jobId);
    db.prepare("UPDATE capture_batches SET state='processing' WHERE id=?").run(batch.id);
    await processNextCapture({ recognize: async () => recognized(batch.photos.map((p) => p.id)) });
    expect(job(batch.jobId)).toMatchObject({ state: 'applied', attempts: 2 });
  });

  it('does not claim a live lease or run two recognizers concurrently', async () => {
    const first = capture(1);
    const second = capture(2);
    let finish!: (result: RecognitionResult) => void;
    const running = processNextCapture({ recognize: () => new Promise((resolve) => { finish = resolve; }) });
    expect(await processNextCapture({ recognize: async () => recognized(second.photos.map((p) => p.id)) })).toBe(false);
    expect(job(second.jobId).state).toBe('queued');
    finish(recognized(first.photos.map((p) => p.id)));
    await running;
    expect(job(first.jobId).state).toBe('applied');
  });

  it('does not steal an unexpired lease from another process', async () => {
    const batch = capture(1);
    const db = getDb();
    db.prepare(`UPDATE analysis_jobs SET state='processing',attempts=1,lease_token='other-process',lease_until=? WHERE id=?`)
      .run(new Date(Date.now() + 60_000).toISOString(), batch.jobId);
    db.prepare("UPDATE capture_batches SET state='processing' WHERE id=?").run(batch.id);
    const recognize = vi.fn<Recognizer>(async () => recognized(batch.photos.map((p) => p.id)));
    expect(await processNextCapture({ recognize })).toBe(false);
    expect(recognize).not.toHaveBeenCalled();
  });

  it('rejects a corrupted sealed manifest before inference', async () => {
    const batch = capture(1);
    const db = getDb();
    db.prepare('UPDATE capture_batches SET manifest_json=? WHERE id=?')
      .run(JSON.stringify(batch.photos.map((photo) => ({ ...photo, sha256: 'wrong-checksum' }))), batch.id);
    const recognize = vi.fn<Recognizer>(async () => recognized(batch.photos.map((p) => p.id)));
    await processNextCapture({ recognize });
    expect(job(batch.jobId)).toMatchObject({ state: 'failed', error_category: 'input_invalid' });
    expect(recognize).not.toHaveBeenCalled();
  });

  it('stops before inference if permission was revoked after upload', async () => {
    const batch = capture(1);
    getDb().prepare("UPDATE location_members SET role='viewer' WHERE user_id=?").run(userId);
    const recognize = vi.fn<Recognizer>(async () => recognized(batch.photos.map((p) => p.id)));
    await processNextCapture({ recognize });
    expect(job(batch.jobId)).toMatchObject({ state: 'failed', error_category: 'access_revoked' });
    expect(recognize).not.toHaveBeenCalled();
  });

  it('an interrupted worker returns its job to the queue without consuming another attempt', async () => {
    const batch = capture(1);
    const controller = new AbortController();
    await processNextCapture({ signal: controller.signal, recognize: async () => {
      controller.abort();
      return recognized(batch.photos.map((p) => p.id));
    } });
    expect(job(batch.jobId)).toMatchObject({ state: 'retry', attempts: 0, error_category: 'worker_interrupted' });
    expect(getDb().prepare('SELECT * FROM bin_items').all()).toHaveLength(0);
    expect(fs.existsSync(batch.directory)).toBe(true);
  });

  it('resumes cleanup after a commit/deletion crash without applying the result again', async () => {
    const batch = capture(1);
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('simulated unavailable storage'); });
    const recognize = vi.fn<Recognizer>(async () => recognized(batch.photos.map((p) => p.id)));
    await processNextCapture({ recognize });
    expect(job(batch.jobId).state).toBe('applied');
    expect(fs.existsSync(batch.directory)).toBe(true);
    spy.mockRestore();
    await sweepCaptures();
    expect(await processNextCapture({ recognize })).toBe(false);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(batch.directory)).toBe(false);
    expect(getDb().prepare('SELECT * FROM bin_items').all()).toHaveLength(1);
  });

  it('a concurrent manual item edit invalidates the inference snapshot', async () => {
    const db = getDb();
    db.prepare("INSERT INTO bin_items (id,bin_id,name) VALUES ('old',?,'Original')").run(binId);
    const batch = capture(1);
    await processNextCapture({ recognize: async () => {
      db.prepare("UPDATE bin_items SET name='Manually edited' WHERE id='old'").run();
      return recognized(batch.photos.map((p) => p.id), 'old');
    } });
    expect(job(batch.jobId)).toMatchObject({ state: 'retry', error_category: 'revision_conflict' });
    expect(db.prepare('SELECT name FROM bin_items').all()).toEqual([{ name: 'Manually edited' }]);
    expect(db.prepare('SELECT * FROM observations').all()).toHaveLength(0);
  });

  it('a restored job with missing input fails without changing inventory', async () => {
    const batch = capture(1);
    fs.rmSync(batch.directory, { recursive: true });
    vi.stubEnv('AI_ENDPOINT_URL', 'http://model.test/v1');
    vi.stubEnv('AI_MODEL', 'test-vision');
    vi.stubEnv('AI_API_KEY', 'test-key');
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await processNextCapture();
    expect(job(batch.jobId)).toMatchObject({ state: 'failed', error_category: 'input_missing' });
    expect(request).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT * FROM bin_items').all()).toHaveLength(0);
  });

  it('a timeout leaves inventory unchanged and stores only a fixed error category', async () => {
    const batch = capture(1);
    await processNextCapture({ recognize: async () => { throw new CaptureProcessingError('model_timeout'); } });
    expect(job(batch.jobId)).toMatchObject({ state: 'retry', error_category: 'model_timeout' });
    expect(getDb().prepare('SELECT * FROM bin_items').all()).toHaveLength(0);
  });

  it('rejects invented IDs, duplicate identities, unknown photo evidence, and image-bearing text', () => {
    const input = { photos: [{ id: 'photo' }], existingItems: [{ id: 'item' }] } as Parameters<typeof validateRecognition>[1];
    const valid = recognized(['photo'], 'item');
    expect(() => validateRecognition(valid, input)).not.toThrow();
    expect(() => validateRecognition(recognized(['photo'], 'other-item'), input)).toThrow('invalid_response');
    expect(() => validateRecognition(recognized(['other-photo'], 'item'), input)).toThrow('invalid_response');
    expect(() => validateRecognition({ usable: true, items: [...valid.items, { ...valid.items[0], description: 'Other view' }] }, input))
      .toThrow('invalid_response');
    expect(() => validateRecognition({ usable: true, items: [{ ...valid.items[0], description: 'data:image/png;base64,AAA' }] }, input))
      .toThrow('invalid_response');
    expect(() => validateRecognition({ usable: false, items: [] }, input)).toThrow('unusable_capture');
  });

  it('sends all image inputs and gateway privacy options in a single bounded JSON request', async () => {
    const batch = capture(1, 3);
    vi.stubEnv('AI_ENDPOINT_URL', 'http://model.test/v1');
    vi.stubEnv('AI_MODEL', 'test-vision');
    vi.stubEnv('AI_API_KEY', 'test-key');
    const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{
      finish_reason: 'stop', message: { content: JSON.stringify(recognized(batch.photos.map((p) => p.id))) },
    }] }), { status: 200 }));
    vi.stubGlobal('fetch', request);
    await processNextCapture({ recognize: recognizeCapture });
    expect(request).toHaveBeenCalledTimes(1);
    const [, init] = (request.mock.calls[0] as unknown) as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[1].content.filter((part: { type: string }) => part.type === 'image_url')).toHaveLength(3);
    expect(body).toMatchObject({ 'no-log': true, store: false, cache: { 'no-cache': true, 'no-store': true } });
    expect(job(batch.jobId).state).toBe('applied');
  });
});
