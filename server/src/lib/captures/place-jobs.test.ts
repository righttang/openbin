import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../db.js';
import { createApp } from '../../index.js';
import { signToken } from '../../middleware/auth.js';
import { withCaptureTransaction } from './database.js';
import { enqueuePlaceJob, getPlaceJob, processPlaceJob } from './place-jobs.js';
import { CaptureProcessingError } from './recognition.js';
import { claimCapture, processNextCapture, startCaptureWorker } from './worker.js';

const app = createApp();
let userId: string, binId: string, token: string;
const empty = { merged_items: 0, merged_groups: 0, redirects: [] };
const send = () => request(app).post(`/api/captures/places/${binId}/deduplicate`).set('Authorization', `Bearer ${token}`).send({ queued: true });
const status = (id: string) => request(app).get(`/api/captures/place-jobs/${id}`).set('Authorization', `Bearer ${token}`);
const cancel = (id: string) => request(app).post(`/api/captures/place-jobs/${id}/cancel`).set('Authorization', `Bearer ${token}`).send({});
const row = (id: string) => getDb().prepare('SELECT * FROM place_jobs WHERE id=?').get(id) as Record<string, unknown>;
beforeEach(async () => {
  userId = crypto.randomUUID(); binId = crypto.randomUUID(); const locationId = crypto.randomUUID(), db = getDb();
  db.prepare('INSERT INTO users (id,email,display_name) VALUES (?,?,?)').run(userId, `${userId}@test.invalid`, 'Job tester');
  db.prepare('INSERT INTO locations (id,name,created_by,invite_code) VALUES (?,?,?,?)').run(locationId, 'Home', userId, crypto.randomUUID());
  db.prepare("INSERT INTO location_members (id,location_id,user_id,role) VALUES (?,?,?,'admin')").run(crypto.randomUUID(), locationId, userId);
  db.prepare('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES (?,?,?,?,?)').run(binId, 'JOBS', locationId, 'Shelf', userId);
  token = await signToken({ id: userId, email: `${userId}@test.invalid` });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('durable place jobs', () => {
  it('returns a job immediately, deduplicates repeated taps, and persists an explicit zero-merge result', async () => {
    const first = await send(); expect(first.status).toBe(202); expect(first.body).toMatchObject({ kind: 'deduplicate', state: 'queued', result: null });
    expect((await send()).body.id).toBe(first.body.id);
    await processNextCapture();
    expect((await status(first.body.id)).body).toMatchObject({ state: 'completed', result: empty });
    const list = await request(app).get('/api/captures/place-jobs').set('Authorization', `Bearer ${token}`);
    expect(list.body.jobs).toHaveLength(1); expect(list.body.jobs[0].result).toEqual(empty);
    expect((await send()).body.id).not.toBe(first.body.id);
  });
  it('makes a queued cancellation terminal without running a model', async () => {
    const job = (await send()).body;
    expect((await cancel(job.id)).body.state).toBe('cancelled');
    const model = vi.fn(); expect(await processNextCapture({ deduplicate: model })).toBe(false); expect(model).not.toHaveBeenCalled();
  });
  it('aborts a running merge and rejects its late commit', async () => {
    const job = (await send()).body;
    let complete!: () => void;
    let aborted = false;
    const running = processNextCapture({ deduplicate: async (_bin, _user, options) => {
      await new Promise<void>(resolve => {
        complete = resolve; options.signal!.addEventListener('abort', () => { aborted = true; }, { once: true });
      });
      return withCaptureTransaction(async execute => { await options.assertActive!(execute); await options.completed!(empty, execute); return empty; });
    } });
    try {
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      expect((await cancel(job.id)).body.state).toBe('cancelled'); expect(aborted).toBe(true);
    } finally { complete(); await running; }
    expect(row(job.id)).toMatchObject({ state: 'cancelled', result_json: null });
  });
  it('shares the three-job cap across place and photo jobs, including a second process claim', async () => {
    const db = getDb(), jobs = [await enqueuePlaceJob(binId, userId)];
    for (let index = 0; index < 2; index++) {
      const otherBin = crypto.randomUUID(), location = db.prepare('SELECT location_id FROM bins WHERE id=?').get(binId) as { location_id: string };
      db.prepare('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES (?,?,?,?,?)').run(otherBin, `JOB${index}`, location.location_id, 'Other shelf', userId);
      jobs.push(await enqueuePlaceJob(otherBin, userId));
    }
    const finishes: Array<() => void> = [];
    const running = jobs.map(() => processNextCapture({ deduplicate: async (_bin, _user, options) => {
      await new Promise<void>(resolve => finishes.push(resolve));
      return withCaptureTransaction(async execute => { await options.completed!(empty, execute); return empty; });
    } }));
    try {
      await vi.waitFor(() => expect(finishes).toHaveLength(3));
      expect(await claimCapture(new Date())).toBeUndefined(); expect(await processNextCapture()).toBe(false);
      expect(db.prepare("SELECT COUNT(*) AS n FROM place_jobs WHERE state='processing'").get()).toEqual({ n: 3 });
    } finally { for (const finish of finishes) finish(); await Promise.all(running); }
    expect(db.prepare("SELECT COUNT(*) AS n FROM place_jobs WHERE state='completed'").get()).toEqual({ n: 3 });
  });
  it('recovers a crashed merge job and does not let a cancelled or stale lease publish results', async () => {
    const job = (await send()).body, db = getDb();
    db.prepare("UPDATE place_jobs SET state='processing',attempts=1,lease_token='old',lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
    await processNextCapture(); expect(row(job.id)).toMatchObject({ state: 'completed', attempts: 2 });
    const current = row(job.id);
    await processPlaceJob({ ...current, state: 'processing', lease_token: 'old' } as unknown as Parameters<typeof processPlaceJob>[0], new AbortController().signal, () => new Date());
    expect(row(job.id)).toEqual(current);
  });
  it('returns all running jobs to retry state when the server stops', async () => {
    const job = (await send()).body;
    const worker = startCaptureWorker({ deduplicate: async (_bin, _user, options) => {
      await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new CaptureProcessingError('worker_interrupted')), { once: true }));
      return empty;
    } });
    try { await vi.waitFor(() => expect(row(job.id).state).toBe('processing')); }
    finally { await worker.stop(); }
    expect(row(job.id)).toMatchObject({ state: 'retry', attempts: 0, error_category: 'worker_interrupted' });
    await processNextCapture(); expect((await getPlaceJob(job.id, userId)).state).toBe('completed');
  });
  it('persists failure categories for the app without leaking model messages', async () => {
    const job = (await send()).body;
    const now = new Date();
    for (let attempt = 0; attempt < 3; attempt++) {
      await processNextCapture({ now: () => new Date(now.getTime() + attempt * 3000), deduplicate: async () => { throw new CaptureProcessingError('model_unavailable'); } });
    }
    expect((await status(job.id)).body).toMatchObject({ state: 'failed', attempts: 3, error_category: 'model_unavailable' });
  });
  it('keeps the previous synchronous client compatible while using the same durable job', async () => {
    const worker = startCaptureWorker();
    try {
      const reply = await request(app).post(`/api/captures/places/${binId}/deduplicate`).set('Authorization', `Bearer ${token}`).send({});
      expect(reply.status).toBe(200); expect(reply.body).toEqual(empty);
      expect(getDb().prepare('SELECT state FROM place_jobs').get()).toEqual({ state: 'completed' });
    } finally { await worker.stop(); }
  });
  it('checks write access before enqueueing and hides another user’s job', async () => {
    const job = (await send()).body;
    getDb().prepare("UPDATE location_members SET role='viewer' WHERE user_id=?").run(userId);
    expect((await send()).status).toBe(403);
    expect((await status(job.id)).status).toBe(403);
  });
});
