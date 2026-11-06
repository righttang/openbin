import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Express } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../db.js';
import { createApp } from '../index.js';
import { captureConfig } from '../lib/captures/config.js';
import { initializeLocalMode } from '../lib/localMode.js';

const mode = vi.hoisted(() => ({ enabled: true, userId: null as string | null }));
vi.mock('../lib/config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/config.js')>();
  return {
    ...original,
    config: {
      ...original.config,
      get localMode() { return mode.enabled; },
      get localUserId() { return mode.userId; },
    },
  };
});

let app: Express;

beforeEach(async () => {
  mode.enabled = true;
  mode.userId = null;
  await initializeLocalMode();
  app = createApp();
});

afterEach(() => {
  fs.rmSync(captureConfig.scratchPath, { recursive: true, force: true });
});

async function localSession() {
  const response = await request(app).get('/api/auth/me');
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const cookie = cookies.find((value) => value.startsWith('openbin-csrf='))?.split(';')[0];
  expect(cookie).toBeDefined();
  expect(cookies.some((value) => value.startsWith('openbin-access=') || value.startsWith('openbin-refresh='))).toBe(false);
  return { user: response.body, cookie: cookie!, csrf: cookie!.slice('openbin-csrf='.length) };
}

describe('shared local household without login', () => {
  it('opens one stable household across new devices and repeated initialization', async () => {
    const first = await localSession();
    await initializeLocalMode();
    const second = await localSession();
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.activeLocationId).toBe(first.user.activeLocationId);
    const locations = await request(app).get('/api/locations');
    expect(locations.status).toBe(200);
    expect(locations.body.results).toHaveLength(1);
    expect(locations.body.results[0]).toMatchObject({ id: first.user.activeLocationId, name: '我的家', role: 'admin' });
    expect((await request(app).get('/api/auth/status')).body).toMatchObject({
      localMode: true, registrationEnabled: false, registrationMode: 'closed', oauthProviders: [],
    });
  });

  it('creates a bin and accepts a full capture using only the CSRF cookie', async () => {
    const { user, cookie, csrf } = await localSession();
    const bin = await request(app).post('/api/bins')
      .set('Cookie', cookie).set('X-CSRF-Token', csrf)
      .send({ name: '手机测试盒', locationId: user.activeLocationId });
    expect(bin.status).toBe(201);
    const id = crypto.randomUUID();
    const capture = await request(app).post('/api/captures')
      .set('Cookie', cookie).set('X-CSRF-Token', csrf)
      .send({ id, bin_id: bin.body.id });
    expect(capture.status).toBe(201);
    const photoId = crypto.randomUUID();
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#3366ff' } }).png().toBuffer();
    const sha256 = crypto.createHash('sha256').update(png).digest('hex');
    const uploaded = await request(app).put(`/api/captures/${id}/photos/${photoId}`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf)
      .set('Content-Type', 'image/png').set('X-Photo-SHA256', sha256).send(png);
    expect(uploaded.status).toBe(200);
    const completed = await request(app).post(`/api/captures/${id}/complete`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf)
      .send({ photos: [{ id: photoId, sha256, size: png.length, order: 0 }] });
    expect(completed.status).toBe(200);
    expect(completed.body.state).toBe('queued');
    const fromAnotherDevice = await request(app).get(`/api/captures/${id}`);
    expect(fromAnotherDevice.status).toBe(200);
    expect(fromAnotherDevice.body.state).toBe('queued');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM analysis_jobs').get()).toEqual({ n: 1 });
  });

  it('requires CSRF for local writes even without auth cookies or with a Bearer header', async () => {
    const { user, cookie } = await localSession();
    for (const headers of [{}, { Authorization: 'Bearer invalid-token' }, { Cookie: cookie, 'X-CSRF-Token': 'wrong' }]) {
      const response = await request(app).post('/api/bins').set(headers)
        .send({ name: 'Should not exist', locationId: user.activeLocationId });
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('CSRF_INVALID');
    }
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM bins').get()).toEqual({ n: 0 });
  });

  it('disables account lifecycle endpoints and denies global administration', async () => {
    const { user, cookie, csrf } = await localSession();
    const usersBefore = getDb().prepare('SELECT COUNT(*) AS n FROM users').get();
    for (const path of ['login', 'register', 'refresh', 'logout', 'forgot-password', 'reset-password', 'demo-login']) {
      const response = await request(app).post(`/api/auth/${path}`)
        .set('Cookie', cookie).set('X-CSRF-Token', csrf)
        .send({ email: 'someone@example.invalid', password: 'TestPass123!', displayName: 'Someone' });
      expect(response.status, path).toBe(404);
    }
    for (const path of ['profile', 'password']) {
      expect((await request(app).put(`/api/auth/${path}`)
        .set('Cookie', cookie).set('X-CSRF-Token', csrf).send({})).status).toBe(404);
    }
    expect((await request(app).delete('/api/auth/account')
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).send({})).status).toBe(404);
    expect((await request(app).get(`/api/locations/${user.activeLocationId}/members`)).status).toBe(404);
    for (const path of [
      `/api/locations/${user.activeLocationId}/members/${user.id}/reset-password`,
      `/api/locations/${user.activeLocationId}/regenerate-invite`,
      '/api/locations/join',
    ]) {
      expect((await request(app).post(path)
        .set('Cookie', cookie).set('X-CSRF-Token', csrf).send({})).status).toBe(404);
    }
    expect((await request(app).get('/api/api-keys')).status).toBe(404);
    expect((await request(app).post('/api/api-keys')
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).send({ name: 'Disabled' })).status).toBe(404);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM api_keys').get()).toEqual({ n: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual(usersBefore);
    // Even an explicitly selected legacy admin must not expose server administration.
    getDb().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
    expect((await request(app).get('/api/auth/me')).body.isAdmin).toBe(false);
    expect((await request(app).get('/api/admin/users')).status).toBe(403);
  });

  it('reuses an explicitly selected existing profile and keeps its data and memberships', async () => {
    const db = getDb();
    const userId = crypto.randomUUID();
    const locationId = crypto.randomUUID();
    const binId = crypto.randomUUID();
    db.prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)').run(userId, 'existing@example.invalid', 'Existing');
    db.prepare('INSERT INTO locations (id, name, created_by, invite_code) VALUES (?, ?, ?, ?)')
      .run(locationId, 'Existing household', userId, 'existing-invite');
    db.prepare('INSERT INTO location_members (id, location_id, user_id, role) VALUES (?, ?, ?, ?)')
      .run(crypto.randomUUID(), locationId, userId, 'admin');
    db.prepare('INSERT INTO bins (id, short_code, location_id, name, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(binId, 'EXISTING', locationId, 'Existing bin', userId);
    mode.userId = userId;
    await initializeLocalMode();
    const { user } = await localSession();
    expect(user.id).toBe(userId);
    expect(user.activeLocationId).toBe(locationId);
    expect((await request(app).get(`/api/bins/${binId}`)).body.name).toBe('Existing bin');
    expect(db.prepare('SELECT COUNT(*) AS n FROM location_members WHERE user_id = ?').get(userId)).toEqual({ n: 1 });
  });

  it('fails a missing or suspended selected profile without falling back to someone else', async () => {
    const { user } = await localSession();
    const counts = getDb().prepare('SELECT COUNT(*) AS n FROM users').get();
    mode.userId = crypto.randomUUID();
    await expect(initializeLocalMode()).rejects.toThrow('Local household profile is unavailable');
    expect((await request(app).get('/api/auth/me')).status).toBe(500);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual(counts);
    mode.userId = user.id;
    getDb().prepare("UPDATE users SET suspended_at = datetime('now') WHERE id = ?").run(user.id);
    await expect(initializeLocalMode()).rejects.toThrow('Local household profile is unavailable');
  });

  it('keeps authentication required when local mode is off', async () => {
    mode.enabled = false;
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/locations')).status).toBe(401);
  });
});
