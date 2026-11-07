// Real-model verification against a disposable in-memory database and synthetic books.
// npm --prefix server run build && node --env-file=.env scripts/verify-place-dedup.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
process.env.DATABASE_URL = '';
process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'synthetic-dedup-verification';
process.env.ADMIN_EMAIL = 'dedup-verify@example.invalid';
process.env.ADMIN_PASSWORD = 'disposable-in-memory-verification';
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'remindme-dedup-'));
process.env.PHOTO_STORAGE_PATH = folder;
const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const { initialize, closeDb } = await import('../server/dist/db/init.js');
const { getDb } = await import('../server/dist/db.js');
const { deduplicatePlace } = await import('../server/dist/lib/captures/deduplicate.js');
const { recognizeCapture } = await import('../server/dist/lib/captures/recognition.js');
function book(title, color) {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640">
    <rect width="480" height="640" fill="#eee9df"/><rect x="40" y="25" width="400" height="590" rx="10" fill="white" stroke="#26364b" stroke-width="8"/>
    <rect x="45" y="30" width="390" height="150" fill="${color}"/>
    <text x="240" y="285" text-anchor="middle" font-family="sans-serif" font-size="48">${title}</text>
    <text x="240" y="365" text-anchor="middle" font-family="sans-serif" font-size="38">HANDBOOK</text>
    <text x="240" y="440" text-anchor="middle" font-family="sans-serif" font-size="24">Illustrated guide</text>
    <rect x="45" y="520" width="390" height="90" fill="${color}"/></svg>`)).jpeg().toBuffer();
}
try {
  await initialize();
  const db = getDb(), user = crypto.randomUUID(), location = crypto.randomUUID(), bin = crypto.randomUUID();
  db.prepare('INSERT INTO users (id,email,display_name) VALUES (?,?,?)').run(user, `${user}@example.invalid`, 'Synthetic verification');
  db.prepare('INSERT INTO locations (id,name,created_by,invite_code) VALUES (?,?,?,?)').run(location, 'Synthetic home', user, crypto.randomUUID());
  db.prepare("INSERT INTO location_members (id,location_id,user_id,role) VALUES (?,?,?,'admin')").run(crypto.randomUUID(), location, user);
  db.prepare('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES (?,?,?,?,?)').run(bin, 'SYNTHETIC', location, 'Book shelf', user);
  const home = await book('HOME', '#ad273e'), garden = await book('GARDEN', '#287a43');
  const ids = [];
  for (const [index, image] of [home, await sharp(home).rotate(3, { background: '#eee9df' }).jpeg().toBuffer(), garden].entries()) {
    const id = crypto.randomUUID(), capture = crypto.randomUUID(), photo = crypto.randomUUID(), observation = crypto.randomUUID(); ids.push(id);
    const at = `2026-11-0${index + 1}T12:00:00.000Z`, name = index < 2 ? 'Red home handbook' : 'Green garden handbook';
    db.prepare(`INSERT INTO capture_batches (id,bin_id,created_by,captured_at,sequence,state,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'applied',?,?,?)`).run(capture, bin, user, at, index + 1, at, at, at);
    db.prepare(`INSERT INTO capture_photos (capture_id,id,position,sha256,size,mime_type,storage_path,received_at)
      VALUES (?,?,0,?,?,'image/jpeg','/tmp/synthetic-unused',?)`).run(capture, photo, 'a'.repeat(64), image.length, at);
    db.prepare('INSERT INTO capture_photo_history (capture_id,photo_id,preview_jpeg,width,height) VALUES (?,?,?,480,640)').run(capture, photo, image);
    db.prepare(`INSERT INTO bin_items (id,bin_id,name,description,position,quantity,last_seen_batch_id,last_seen_at,capture_created,updated_at)
      VALUES (?,?,?, ?,?,1,?,?,1,?)`).run(id, bin, name, name, index, capture, at, at);
    db.prepare(`INSERT INTO observations (id,capture_id,item_id,name,description,quantity,photo_ids_json,created_at)
      VALUES (?,?,?,?,?,1,?,?)`).run(observation, capture, id, name, name, JSON.stringify([photo]), at);
    db.prepare('INSERT INTO observation_photos (observation_id,capture_id,photo_id,crop_jpeg) VALUES (?,?,?,?)').run(observation, capture, photo, image);
  }
  const started = Date.now();
  const merged = await deduplicatePlace(bin, user);
  assert.deepEqual(merged.redirects, [{ from_id: ids[1], into_id: ids[0] }]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM capture_photo_history WHERE dismissed_at IS NULL').get().n, 3);
  const storage_path = path.join(folder, 'new-view.jpg'); await fs.writeFile(storage_path, home);
  const matched = await recognizeCapture({ captureId: crypto.randomUUID(), binId: bin, binName: 'Book shelf',
    existingItems: [0, 2].map(index => ({ id: ids[index], name: index ? 'Garden handbook' : 'Home handbook', description: '', aliases: [], quantity: 1 })),
    photos: [{ id: 'new-view', storage_path, size: home.length, sha256: crypto.createHash('sha256').update(home).digest('hex') }] });
  assert.equal(matched.items.length, 1); assert.equal(matched.items[0].existing_item_id, ids[0]);
  console.log(JSON.stringify({ verified: true, merged_duplicates: merged.merged_items, distinct_book_preserved: true,
    photo_history_preserved: 3, subsequent_photo_matched_existing: true, elapsed_seconds: Math.round((Date.now() - started) / 1000) }));
} finally { await closeDb(); await fs.rm(folder, { recursive: true, force: true }); }
