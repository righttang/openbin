import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import pg from 'pg';
import { migrateSqliteToPostgres } from './migrate-sqlite-to-postgres.mjs';

const url = process.env.MIGRATION_TEST_DATABASE_URL;
const enabled = !!url;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remindme-pg-migration-test-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = enabled ? new pg.Pool({ connectionString: url, max: 2 }) : undefined;
const preview = Buffer.from([0xff, 0xd8, 0x00, 0x80, 0xff, 0xd9]);
const crop = Buffer.from([0xff, 0xd8, 0x01, 0x00, 0x02, 0xff, 0xd9]);

beforeEach(async () => {
  if (!enabled) return;
  const name = new URL(url).pathname.slice(1);
  assert.match(name, /(?:^|_)test(?:_|$)/, 'Migration tests require a dedicated database whose name includes test');
  // This destructive reset is test-only and never exists in the importer.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
});

after(async () => {
  await pool?.end();
  fs.rmSync(directory, { recursive: true, force: true });
});

function sourceFixture() {
  const filename = path.join(directory, `${crypto.randomUUID()}.db`);
  const db = new Database(filename);
  db.pragma('foreign_keys = OFF');
  db.exec(fs.readFileSync(path.join(root, 'schema.sqlite.sql'), 'utf8'));
  function insert(table, record) {
    const keys = Object.keys(record);
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(record));
  }
  insert('users', { id: 'user-1', email: 'owner@example.test', display_name: '汤姆', password_hash: 'preserve-this-hash',
    is_admin: 1, force_password_change: 0, marketing_opt_in: 1, active_location_id: 'location-1' });
  insert('locations', { id: 'location-1', name: '家庭 / Study', created_by: 'user-1', invite_code: 'fixture-invite' });
  insert('location_members', { id: 'member-1', user_id: 'user-1', location_id: 'location-1', role: 'admin' });
  // Deliberately insert the child first, exercising deferred self-references.
  insert('areas', { id: 'area-child', name: 'Cabinet', location_id: 'location-1', parent_id: 'area-parent', created_by: 'user-1' });
  insert('areas', { id: 'area-parent', name: 'Study', location_id: 'location-1', created_by: 'user-1' });
  insert('bins', { id: 'bin-1', short_code: 'DRAWER1', location_id: 'location-1', name: 'Drawer A', area_id: 'area-child', created_by: 'user-1',
    tags: '["cables",9007199254740993123456789]' });
  insert('bins', { id: 'bin-2', short_code: 'DRAWER2', location_id: 'location-1', name: 'Drawer B', created_by: 'user-1' });
  insert('bin_items', { id: 'item-1', bin_id: 'bin-1', name: 'USB-C cable', quantity: null, normalized_name: 'usb-c cable',
    description: '蓝色 braided cable', aliases_json: '["charging cord","数据线"]', capture_created: 1,
    last_seen_batch_id: 'capture-1', last_seen_at: '2026-11-06T11:00:00.000Z', observation_state: 'seen',
    created_at: '2026-11-06T11:00:00.000Z' });
  insert('capture_batches', { id: 'capture-1', bin_id: 'bin-1', created_by: 'user-1', captured_at: '2026-11-06T11:00:00.000Z',
    received_at: '2026-11-06T11:00:01.000Z', sequence: 4, state: 'applied', manifest_json: '[{"id":"photo-1","order":0}]',
    expires_at: '2026-11-06T12:00:00.000Z', created_at: '2026-11-06T11:00:00.000Z', updated_at: '2026-11-06T11:00:02.000Z',
    cleanup_completed_at: '2026-11-06T11:00:03.000Z' });
  insert('capture_photos', { capture_id: 'capture-1', id: 'photo-1', position: 0, sha256: 'f'.repeat(64), size: 4096,
    mime_type: 'image/jpeg', storage_path: '/scratch/capture-1/photo-1', received_at: '2026-11-06T11:00:01.000Z', deleted_at: '2026-11-06T11:00:03.000Z' });
  insert('analysis_jobs', { id: 'job-1', capture_id: 'capture-1', state: 'applied', attempts: 1, model_alias: 'home-vision',
    next_attempt_at: '2026-11-06T11:00:01.000Z', created_at: '2026-11-06T11:00:01.000Z', updated_at: '2026-11-06T11:00:02.000Z' });
  insert('observations', { id: 'observation-1', capture_id: 'capture-1', item_id: 'item-1', name: 'USB-C cable', quantity: null,
    description: '蓝色 braided cable', aliases_json: '["数据线"]', photo_ids_json: '["photo-1"]', created_at: '2026-11-06T11:00:00.000Z' });
  insert('capture_photo_history', { capture_id: 'capture-1', photo_id: 'photo-1', preview_jpeg: preview, width: 960, height: 720, dismissed_at: null });
  insert('observation_photos', { observation_id: 'observation-1', capture_id: 'capture-1', photo_id: 'photo-1',
    bbox_json: '[0.1,0.2,0.6,0.8]', crop_jpeg: crop });
  insert('capture_item_baselines', { item_id: 'item-1', snapshot_json: '{"name":"Original cable","quantity":null}' });
  insert('bin_capture_state', { bin_id: 'bin-1', next_sequence: 9, revision: 17, latest_applied_sequence: 4 });
  insert('bin_capture_state', { bin_id: 'bin-2', next_sequence: 0, revision: 0, latest_applied_sequence: 0 });
  insert('user_preferences', { id: 'preferences-1', user_id: 'user-1', settings: '{"z":1,"a":{"n":9007199254740993123456789}}' });
  insert('user_ai_settings', { id: 'ai-1', user_id: 'user-1', provider: 'openai-compatible', api_key: 'sensitive-fixture-key',
    model: 'home-vision', is_active: 1, temperature: 0.123456789123, top_p: 0.987654321987 });
  insert('photos', { id: 'legacy-photo-1', bin_id: 'bin-1', filename: 'photo.jpg', mime_type: 'image/jpeg', size: 123,
    storage_path: '/uploads/original.jpg', thumb_path: '/uploads/thumb.jpg', created_by: 'user-1' });
  insert('attachments', { id: 'attachment-1', bin_id: 'bin-1', filename: 'manual.pdf', mime_type: 'application/pdf', size: 456,
    storage_path: '/uploads/manual.pdf', created_by: 'user-1' });
  insert('ai_usage', { id: 42, user_id: 'user-1', call_count: 7, date: '2026-11-06' });
  insert('subscription_orphans', { id: 'orphan-1', user_id_attempted: 'unknown', payload_json: '{}', reason: 'test',
    received_at: '2026-11-06 21:00:00.123456+11:00' });
  insert('settings', { key: 'db_engine', value: 'sqlite' });
  insert('schema_migrations', { name: '0014_capture_batches' });
  insert('schema_migrations', { name: '0015_capture_history' });
  db.close();
  return filename;
}

function logicalSourceDigest(filename) {
  // File bytes also remain unchanged: source is opened read-only, never migrated.
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

async function tableCount() {
  const result = await pool.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  return result.rows[0].count;
}

test('dry-run imports and verifies every table and binary image, then rolls back schema and data', { skip: !enabled }, async () => {
  const sqlitePath = sourceFixture();
  const before = logicalSourceDigest(sqlitePath);
  const report = await migrateSqliteToPostgres({ sqlitePath, postgresUrl: url });
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.verified, true);
  assert.equal(report.totalBlobBytes, preview.length + crop.length);
  assert.ok(report.tables.length > 45);
  assert.ok(report.tables.every(table => table.sourceRows === table.targetRows && /^[a-f0-9]{64}$/.test(table.sha256)));
  assert.equal(await tableCount(), 0);
  assert.equal(logicalSourceDigest(sqlitePath), before);
  assert.ok(!JSON.stringify(report).includes('sensitive-fixture-key'));
});

test('apply preserves IDs, relationships, nullable quantities, exact JSON numbers, previews and crops', { skip: !enabled }, async () => {
  const sqlitePath = sourceFixture();
  const before = logicalSourceDigest(sqlitePath);
  const report = await migrateSqliteToPostgres({ sqlitePath, postgresUrl: url, apply: true });
  assert.equal(report.mode, 'applied');
  assert.equal(logicalSourceDigest(sqlitePath), before);
  const { rows: [item] } = await pool.query("SELECT * FROM bin_items WHERE id='item-1'");
  assert.equal(item.quantity, null);
  assert.equal(item.description, '蓝色 braided cable');
  assert.equal(item.aliases_json, '["charging cord","数据线"]');
  assert.equal(item.capture_created, 1);
  assert.equal((await pool.query("SELECT active_location_id FROM users WHERE id='user-1'")).rows[0].active_location_id, 'location-1');
  assert.equal((await pool.query("SELECT parent_id FROM areas WHERE id='area-child'")).rows[0].parent_id, 'area-parent');
  const { rows: [history] } = await pool.query('SELECT preview_jpeg FROM capture_photo_history');
  const { rows: [observation] } = await pool.query('SELECT crop_jpeg,bbox_json FROM observation_photos');
  assert.deepEqual(history.preview_jpeg, preview);
  assert.deepEqual(observation.crop_jpeg, crop);
  assert.equal(observation.bbox_json, '[0.1,0.2,0.6,0.8]');
  assert.deepEqual((await pool.query("SELECT revision,next_sequence FROM bin_capture_state WHERE bin_id='bin-1'")).rows[0], { revision: 17, next_sequence: 9 });
  assert.equal((await pool.query('SELECT temperature FROM user_ai_settings')).rows[0].temperature, 0.123456789123);
  assert.match((await pool.query('SELECT settings::text FROM user_preferences')).rows[0].settings, /9007199254740993123456789/);
  assert.equal((await pool.query("SELECT value FROM settings WHERE key='db_engine'")).rows[0].value, 'postgres');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM schema_migrations WHERE name='0016_capture_postgres'")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS value FROM subscription_orphans")).rows[0].value, '2026-11-06 10:00:00.123456');
  const { rows: [usage] } = await pool.query("INSERT INTO ai_usage (user_id,date) VALUES ('user-1','2026-11-07') RETURNING id");
  assert.equal(usage.id, 43);
  const { rows: [fk] } = await pool.query("SELECT condeferrable FROM pg_constraint WHERE conname='fk_users_active_location'");
  assert.equal(fk.condeferrable, false);
});

test('rejects nonempty targets without deleting or changing existing data', { skip: !enabled }, async () => {
  await pool.query('CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES (\'keep me\')');
  const sqlitePath = sourceFixture();
  await assert.rejects(migrateSqliteToPostgres({ sqlitePath, postgresUrl: url, apply: true }), /Target is not empty/);
  assert.deepEqual((await pool.query('SELECT * FROM sentinel')).rows, [{ value: 'keep me' }]);
  assert.equal(await tableCount(), 1);
});

test('a mid-import type error rolls back all target writes and leaves the SQLite source unchanged', { skip: !enabled }, async () => {
  const sqlitePath = sourceFixture();
  const db = new Database(sqlitePath);
  db.prepare("UPDATE bins SET tags='not valid JSON' WHERE id='bin-1'").run();
  db.close();
  const before = logicalSourceDigest(sqlitePath);
  await assert.rejects(migrateSqliteToPostgres({ sqlitePath, postgresUrl: url, apply: true }));
  assert.equal(await tableCount(), 0);
  assert.equal(logicalSourceDigest(sqlitePath), before);
});

test('refuses to omit unknown source columns or tables', { skip: !enabled }, async () => {
  const sqlitePath = sourceFixture();
  const db = new Database(sqlitePath);
  db.exec('ALTER TABLE bin_items ADD COLUMN unknown_inventory_note TEXT');
  db.close();
  await assert.rejects(migrateSqliteToPostgres({ sqlitePath, postgresUrl: url, apply: true }), /no target schema/);
  assert.equal(await tableCount(), 0);
});

test('rejects invalid source foreign keys before writing PostgreSQL', { skip: !enabled }, async () => {
  const sqlitePath = sourceFixture();
  const db = new Database(sqlitePath);
  db.pragma('foreign_keys = OFF');
  db.prepare("UPDATE observations SET item_id='missing-item'").run();
  db.close();
  await assert.rejects(migrateSqliteToPostgres({ sqlitePath, postgresUrl: url, apply: true }), /foreign-key violations/);
  assert.equal(await tableCount(), 0);
});

test('PostgreSQL revision triggers invalidate manual inserts, edits, moves and removals', { skip: !enabled }, async () => {
  await migrateSqliteToPostgres({ sqlitePath: sourceFixture(), postgresUrl: url, apply: true });
  const revision = async id => (await pool.query('SELECT revision FROM bin_capture_state WHERE bin_id=$1', [id])).rows[0].revision;
  await pool.query("UPDATE bin_items SET name='New name' WHERE id='item-1'");
  assert.equal(await revision('bin-1'), 18);
  await pool.query("UPDATE bin_items SET bin_id='bin-2' WHERE id='item-1'");
  assert.equal(await revision('bin-1'), 19);
  assert.equal(await revision('bin-2'), 1);
  await pool.query("INSERT INTO bin_items (id,bin_id,name) VALUES ('manual-2','bin-2','Manual item')");
  assert.equal(await revision('bin-2'), 2);
  await pool.query("DELETE FROM bin_items WHERE id='manual-2'");
  assert.equal(await revision('bin-2'), 3);
});

test('0016 repairs old PostgreSQL installs already marked 0014/0015, and is idempotent', { skip: !enabled }, async () => {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  const baseSchema = fs.readFileSync(path.join(root, 'schema.pg.sql'), 'utf8').split('-- RemindMe PostgreSQL capture/history parity;')[0];
  await pool.query(baseSchema);
  for (const column of ['normalized_name', 'aliases_json', 'description', 'last_seen_batch_id', 'last_seen_at', 'observation_state', 'capture_created']) {
    await pool.query(`ALTER TABLE bin_items DROP COLUMN ${column}`);
  }
  await pool.query("INSERT INTO schema_migrations (name) VALUES ('0014_capture_batches'),('0015_capture_history')");
  // Tests can use the installed TS dev loader; the production importer remains
  // plain .mjs and needs only pg and better-sqlite3.
  const { tsImport } = await import('tsx/esm/api');
  const { capturePostgres } = await tsImport('../src/db/migrations/0016_capture_postgres.ts', import.meta.url);
  await capturePostgres.postgres(pool);
  await capturePostgres.postgres(pool);
  assert.equal((await pool.query("SELECT data_type FROM information_schema.columns WHERE table_name='capture_photo_history' AND column_name='preview_jpeg'")).rows[0].data_type, 'bytea');
  assert.equal((await pool.query("SELECT data_type FROM information_schema.columns WHERE table_name='bin_items' AND column_name='capture_created'")).rows[0].data_type, 'integer');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname='capture_item_revision'")).rows[0].n, 1);
});
