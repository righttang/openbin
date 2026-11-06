import type { Migration } from './types.js';

export const captureHistory: Migration = {
  name: '0015_capture_history',
  sqlite(db) {
    db.transaction(() => {
      const itemColumns = new Set((db.prepare('PRAGMA table_info(bin_items)').all() as { name: string }[]).map(c => c.name));
      if (!itemColumns.has('capture_created')) db.exec('ALTER TABLE bin_items ADD COLUMN capture_created INTEGER NOT NULL DEFAULT 0');
      const observationColumns = new Set((db.prepare('PRAGMA table_info(observations)').all() as { name: string }[]).map(c => c.name));
      if (!observationColumns.has('dismissed_at')) db.exec('ALTER TABLE observations ADD COLUMN dismissed_at TEXT');
      db.exec(`
CREATE TABLE IF NOT EXISTS capture_photo_history (
  capture_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  preview_jpeg BLOB,
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
  crop_jpeg BLOB,
  PRIMARY KEY(observation_id, photo_id),
  FOREIGN KEY(capture_id, photo_id) REFERENCES capture_photos(capture_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_observation_photos_photo ON observation_photos(capture_id, photo_id);
CREATE INDEX IF NOT EXISTS idx_observations_item ON observations(item_id);
CREATE TABLE IF NOT EXISTS capture_item_baselines (
  item_id TEXT PRIMARY KEY REFERENCES bin_items(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL
);
INSERT OR IGNORE INTO capture_photo_history (capture_id, photo_id)
  SELECT capture_id, id FROM capture_photos;
INSERT OR IGNORE INTO observation_photos (observation_id, capture_id, photo_id)
  SELECT o.id, o.capture_id, p.id FROM observations o
  JOIN json_each(CASE WHEN json_valid(o.photo_ids_json) THEN o.photo_ids_json ELSE '[]' END) j
  JOIN capture_photos p ON p.capture_id=o.capture_id AND p.id=j.value;
-- Old captures created items and their first observations at the same timestamp.
-- Be conservative: a legacy manual item stays manual unless that provenance is exact.
UPDATE bin_items SET capture_created=1 WHERE last_seen_batch_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM observations o WHERE o.item_id=bin_items.id AND o.created_at=bin_items.created_at);
`);
    })();
  },
};
