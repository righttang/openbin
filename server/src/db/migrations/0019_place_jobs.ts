import type { Migration } from './types.js';

export const placeJobsSql = `CREATE TABLE IF NOT EXISTS place_jobs (
  id TEXT PRIMARY KEY,
  bin_id TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'deduplicate' CHECK (kind='deduplicate'),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','retry','completed','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TEXT,
  next_attempt_at TEXT NOT NULL,
  result_json TEXT,
  error_category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS place_jobs_active_bin ON place_jobs(bin_id) WHERE state IN ('queued','processing','retry');
CREATE INDEX IF NOT EXISTS place_jobs_queue ON place_jobs(state,next_attempt_at,created_at);`;

export const placeJobs: Migration = {
  name: '0019_place_jobs',
  sqlite(db) { db.exec(placeJobsSql); },
  async postgres(pool) { await pool.query(placeJobsSql); },
};
