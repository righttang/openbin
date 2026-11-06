// Full HTTP + real-model smoke, isolated from the owner's inventory and image storage.
// From repository root: server/node_modules/.bin/tsx --env-file=.env server/scripts/smoke-capture.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import sharp from 'sharp';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remindme-smoke-'));
fs.mkdirSync(path.join(root, 'db'));
Object.assign(process.env, {
  // This isolated API smoke uses its own signed test identity.
  REMINDME_LOCAL_MODE: 'false',
  SELF_HOSTED: 'true', DATABASE_PATH: path.join(root, 'db/test.db'),
  PHOTO_STORAGE_PATH: path.join(root, 'photos'), CAPTURE_SCRATCH_PATH: path.join(root, 'scratch'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: 'smoke-admin@example.invalid',
  ADMIN_PASSWORD: crypto.randomBytes(24).toString('hex'), DISABLE_RATE_LIMIT: 'true',
});
delete process.env.DATABASE_URL;
const { initialize, getDb, closeDb } = await import('../src/db.js');
const { createApp } = await import('../src/index.js');
const { signToken } = await import('../src/middleware/auth.js');
const { startCaptureWorker } = await import('../src/lib/captures/worker.js');
await initialize();
const db = getDb();
const userId = crypto.randomUUID();
const locationId = crypto.randomUUID();
const binId = crypto.randomUUID();
db.prepare('INSERT INTO users (id,email,display_name) VALUES (?,?,?)').run(userId, 'capture-smoke@example.invalid', 'Smoke');
db.prepare('INSERT INTO locations (id,name,created_by,invite_code) VALUES (?,?,?,?)').run(locationId, 'Smoke home', userId, crypto.randomUUID());
db.prepare('INSERT INTO location_members (id,location_id,user_id,role) VALUES (?,?,?,?)').run(crypto.randomUUID(), locationId, userId, 'admin');
db.prepare('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES (?,?,?,?,?)').run(binId, 'SMOKE', locationId, 'Desk drawer', userId);
const token = await signToken({ id: userId, email: 'capture-smoke@example.invalid' });
const app = createApp().listen(0, '127.0.0.1');
await once(app, 'listening');
const address = app.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}/api/captures`;
const worker = startCaptureWorker();
async function request(route: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  assert(response.ok, `HTTP ${response.status}: ${data.message ?? 'request failed'}`);
  return data;
}
const overview = Buffer.from(`<svg width="1000" height="750" xmlns="http://www.w3.org/2000/svg">
  <rect width="1000" height="750" fill="#e9dfcc"/><rect x="30" y="30" width="940" height="690" rx="18" fill="#f9f3e8" stroke="#87633a" stroke-width="22"/>
  <rect x="110" y="150" width="320" height="440" rx="10" fill="#2864a5"/><rect x="120" y="155" width="25" height="430" fill="#173962"/>
  <rect x="195" y="300" width="160" height="65" fill="#fff"/><text x="275" y="345" text-anchor="middle" font-family="sans-serif" font-size="30">NOTES</text>
  <path d="M650 350 L570 160 L680 320 L790 160 L710 350" fill="#b9bec3" stroke="#74787b" stroke-width="9"/>
  <circle cx="680" cy="345" r="16" fill="#6b6b6b"/>
  <ellipse cx="630" cy="425" rx="44" ry="65" fill="none" stroke="#c92d32" stroke-width="26"/>
  <ellipse cx="730" cy="425" rx="44" ry="65" fill="none" stroke="#c92d32" stroke-width="26"/>
  <path d="M647 375 L673 346 M713 375 L687 346" stroke="#c92d32" stroke-width="25"/>
  <rect x="520" y="550" width="310" height="22" rx="9" fill="#1655ba"/><polygon points="520,550 492,561 520,572" fill="#ccc"/>
  <rect x="520" y="610" width="310" height="22" rx="9" fill="#1655ba"/><polygon points="520,610 492,621 520,632" fill="#ccc"/>
</svg>`);
const image = await sharp(overview).png().toBuffer();
const started = Date.now();
try {
  const id = crypto.randomUUID();
  await request('', 'POST', { id, bin_id: binId });
  const photos = [];
  for (let order = 0; order < 20; order++) {
    // The same scene at slightly different resolutions: 20 inputs must not become 20 inventories.
    const bytes = await sharp(image).resize(1000 - order * 5).jpeg({ quality: 90 }).toBuffer();
    const photo = { id: crypto.randomUUID(), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length, order };
    await request(`/${id}/photos/${photo.id}`, 'PUT', bytes, { 'Content-Type': 'image/jpeg', 'X-Photo-SHA256': photo.sha256, 'X-Photo-Size': String(bytes.length) });
    photos.push(photo);
  }
  const accepted = await request(`/${id}/complete`, 'POST', { photos });
  assert.equal(accepted.state, 'queued');
  // Simulate leaving the browser: the complete request is over while the server worker continues.
  let status;
  const deadline = Date.now() + 180_000;
  do {
    await new Promise(resolve => setTimeout(resolve, 500));
    status = await request(`/${id}`);
  } while (['queued', 'processing'].includes(status.state) && Date.now() < deadline);
  assert.equal(status.state, 'applied', `Capture did not apply: ${status.state}/${status.error_category}`);
  assert(status.cleanup_completed_at, 'Successful capture image cleanup incomplete');
  assert(!fs.existsSync(path.join(root, 'scratch', id)), 'Capture directory still exists');
  const inventory = await request(`/inventory?bin_id=${binId}`);
  assert(inventory.items.length >= 1 && inventory.items.length <= 6, 'Repeated views were not reconciled into a small inventory');
  assert(inventory.items.every((item: { quantity: number | null }) => item.quantity === null || item.quantity <= 2), 'Repeated views inflated quantities');
  const original = inventory.items.map((item: { id: string }) => item.id).sort();
  await request(`/${id}/complete`, 'POST', { photos });
  const repeated = await request(`/inventory?bin_id=${binId}`);
  assert.deepEqual(repeated.items.map((item: { id: string }) => item.id).sort(), original);
  assert.equal((db.prepare('SELECT count(*) AS n FROM analysis_jobs WHERE capture_id=?').get(id) as { n: number }).n, 1);
  console.log(JSON.stringify({ result: 'passed', photos: 20, items: inventory.items.map(({ name, quantity }: { name: string; quantity: number | null }) => ({ name, quantity })), one_job: true, duplicate_completion_idempotent: true, images_deleted: true, elapsed_seconds: Math.round((Date.now() - started) / 1000) }));
} finally {
  await worker.stop();
  await new Promise<void>(resolve => app.close(() => resolve()));
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
