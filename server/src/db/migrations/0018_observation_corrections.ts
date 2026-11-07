import type { Migration } from './types.js';

/** A corrected result keeps its original photographed time and deletion provenance. */
export const observationCorrections: Migration = {
  name: '0018_observation_corrections',
  sqlite(db) {
    const columns = db.prepare('PRAGMA table_info(observations)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'updated_at')) db.exec('ALTER TABLE observations ADD COLUMN updated_at TEXT');
  },
  async postgres(pool) {
    await pool.query('ALTER TABLE observations ADD COLUMN IF NOT EXISTS updated_at TEXT');
  },
};
