import type { Migration } from './types.js';

// Keep this SQL in sync with the RemindMe section of schema.pg.sql. Fresh
// installs load the schema directly; existing installations execute this new
// migration even if 0014/0015 were already recorded as PostgreSQL no-ops.
export const CAPTURE_POSTGRES_SCHEMA = `-- RemindMe PostgreSQL capture/history parity; also repairs installations that
-- recorded the SQLite-only 0014/0015 migrations without running their bodies.
ALTER TABLE bin_items ADD COLUMN IF NOT EXISTS normalized_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bin_items ADD COLUMN IF NOT EXISTS aliases_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bin_items ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE bin_items ADD COLUMN IF NOT EXISTS last_seen_batch_id TEXT;
ALTER TABLE bin_items ADD COLUMN IF NOT EXISTS last_seen_at TEXT;
ALTER TABLE bin_items ADD COLUMN IF NOT EXISTS observation_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE bin_items ADD COLUMN IF NOT EXISTS capture_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_ai_settings ALTER COLUMN temperature TYPE DOUBLE PRECISION;
ALTER TABLE user_ai_settings ALTER COLUMN top_p TYPE DOUBLE PRECISION;
CREATE TABLE IF NOT EXISTS bin_capture_state (
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
  dismissed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_capture ON observations(capture_id);
CREATE INDEX IF NOT EXISTS idx_observations_item ON observations(item_id);

-- Retained, bounded previews and item crops; raw capture inputs stay temporary.
CREATE TABLE IF NOT EXISTS capture_photo_history (
  capture_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  preview_jpeg BYTEA,
  width INTEGER,
  height INTEGER,
  dismissed_at TEXT,
  PRIMARY KEY(capture_id, photo_id),
  FOREIGN KEY(capture_id, photo_id) REFERENCES capture_photos(capture_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS observation_photos (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  capture_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  bbox_json TEXT,
  crop_jpeg BYTEA,
  PRIMARY KEY(observation_id, photo_id),
  FOREIGN KEY(capture_id, photo_id) REFERENCES capture_photos(capture_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_observation_photos_photo ON observation_photos(capture_id, photo_id);
CREATE TABLE IF NOT EXISTS capture_item_baselines (
  item_id TEXT PRIMARY KEY REFERENCES bin_items(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL
);


ALTER TABLE observations ADD COLUMN IF NOT EXISTS dismissed_at TEXT;

-- The same revision invalidation as SQLite, including moves between drawers.
CREATE OR REPLACE FUNCTION capture_bump_item_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $capture_revision$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.bin_capture_state SET revision = revision + 1 WHERE bin_id = NEW.bin_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.bin_capture_state SET revision = revision + 1 WHERE bin_id = OLD.bin_id;
    RETURN OLD;
  ELSE
    UPDATE public.bin_capture_state SET revision = revision + 1 WHERE bin_id = OLD.bin_id;
    IF NEW.bin_id IS DISTINCT FROM OLD.bin_id THEN
      UPDATE public.bin_capture_state SET revision = revision + 1 WHERE bin_id = NEW.bin_id;
    END IF;
    RETURN NEW;
  END IF;
END;
$capture_revision$;
DO $capture_trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.bin_items'::regclass AND tgname = 'capture_item_revision') THEN
    CREATE TRIGGER capture_item_revision AFTER INSERT OR UPDATE OR DELETE ON public.bin_items
      FOR EACH ROW EXECUTE FUNCTION capture_bump_item_revision();
  END IF;
END;
$capture_trigger$;
`;

export const capturePostgres: Migration = {
  name: '0016_capture_postgres',
  async postgres(pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(CAPTURE_POSTGRES_SCHEMA);
      await client.query(`INSERT INTO capture_photo_history (capture_id, photo_id)
        SELECT capture_id, id FROM capture_photos ON CONFLICT DO NOTHING`);
      // JSON fields intentionally remain TEXT. Parsing here avoids aborting a
      // schema repair because an old diagnostic row contains malformed JSON.
      const { rows } = await client.query<{ id: string; capture_id: string; photo_ids_json: string }>(
        'SELECT id, capture_id, photo_ids_json FROM observations',
      );
      for (const observation of rows) {
        let photoIds: unknown;
        try { photoIds = JSON.parse(observation.photo_ids_json); } catch { continue; }
        if (!Array.isArray(photoIds)) continue;
        for (const photoId of photoIds) {
          if (typeof photoId !== 'string') continue;
          await client.query(`INSERT INTO observation_photos (observation_id, capture_id, photo_id)
            SELECT $1, capture_id, id FROM capture_photos WHERE capture_id = $2 AND id = $3
            ON CONFLICT DO NOTHING`, [observation.id, observation.capture_id, photoId]);
        }
      }
      await client.query(`UPDATE bin_items SET capture_created = 1 WHERE last_seen_batch_id IS NOT NULL
        AND capture_created = 0 AND EXISTS (SELECT 1 FROM observations o
          WHERE o.item_id = bin_items.id AND o.created_at = bin_items.created_at)`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  },
};
