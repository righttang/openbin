import type { Migration } from './types.js';

export const captureBatches: Migration = {
  name: '0014_capture_batches',
  sqlite(db) {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS bin_capture_state (
  bin_id TEXT PRIMARY KEY REFERENCES bins(id) ON DELETE CASCADE,
  next_sequence INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  latest_applied_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS capture_batches (
  id TEXT PRIMARY KEY,
  bin_id TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'web',
  device_id TEXT,
  event_id TEXT,
  captured_at TEXT NOT NULL,
  received_at TEXT,
  sequence INTEGER NOT NULL,
  manifest_json TEXT,
  state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','queued','processing','applied','superseded','failed','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cleanup_completed_at TEXT,
  UNIQUE(bin_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_capture_batches_bin ON capture_batches(bin_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_capture_batches_cleanup ON capture_batches(state, cleanup_completed_at, expires_at);
CREATE TABLE IF NOT EXISTS capture_photos (
  capture_id TEXT NOT NULL REFERENCES capture_batches(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0),
  mime_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  received_at TEXT,
  deleted_at TEXT,
  PRIMARY KEY(capture_id, id)
);
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL REFERENCES capture_batches(id) ON DELETE CASCADE,
  analysis_version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','retry','applied','superseded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  lease_token TEXT,
  error_category TEXT,
  model_alias TEXT,
  prompt_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(capture_id,analysis_version)
);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_ready ON analysis_jobs(state,next_attempt_at,lease_until);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL REFERENCES capture_batches(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES bin_items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  quantity INTEGER,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  photo_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_capture ON observations(capture_id);
`);
      const columns = new Set((db.prepare('PRAGMA table_info(bin_items)').all() as { name: string }[]).map(c => c.name));
      const additions: Record<string, string> = {
        normalized_name: "TEXT NOT NULL DEFAULT ''", aliases_json: "TEXT NOT NULL DEFAULT '[]'",
        description: "TEXT NOT NULL DEFAULT ''", last_seen_batch_id: 'TEXT', last_seen_at: 'TEXT',
        observation_state: "TEXT NOT NULL DEFAULT 'unknown'",
      };
      for (const [name, declaration] of Object.entries(additions)) {
        if (!columns.has(name)) db.exec(`ALTER TABLE bin_items ADD COLUMN ${name} ${declaration}`);
      }
      db.exec(`
-- Manual edits invalidate any recognition snapshot taken before the edit.
CREATE TRIGGER IF NOT EXISTS capture_item_insert_revision AFTER INSERT ON bin_items
BEGIN
  UPDATE bin_capture_state SET revision = revision + 1 WHERE bin_id = NEW.bin_id;
END;
CREATE TRIGGER IF NOT EXISTS capture_item_update_revision AFTER UPDATE ON bin_items
BEGIN
  UPDATE bin_capture_state SET revision = revision + 1 WHERE bin_id = OLD.bin_id;
  UPDATE bin_capture_state SET revision = revision + 1 WHERE bin_id = NEW.bin_id AND NEW.bin_id != OLD.bin_id;
END;
CREATE TRIGGER IF NOT EXISTS capture_item_delete_revision AFTER DELETE ON bin_items
BEGIN
  UPDATE bin_capture_state SET revision = revision + 1 WHERE bin_id = OLD.bin_id;
END;
`);
    })();
  },
};
