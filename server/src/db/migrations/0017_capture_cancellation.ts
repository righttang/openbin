import type { Migration } from './types.js';

const cancellationTable = `CREATE TABLE IF NOT EXISTS capture_cancellations (
  id TEXT PRIMARY KEY,
  bin_id TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cancelled_at TEXT NOT NULL
)`;

/** Additive migration: existing photos, observations and item identities stay intact. */
export const captureCancellation: Migration = {
  name: '0017_capture_cancellation',
  sqlite(db) {
    db.transaction(() => {
      const columns = db.prepare('PRAGMA table_info(capture_batches)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'cancelled_at')) db.exec('ALTER TABLE capture_batches ADD COLUMN cancelled_at TEXT');
      db.exec(cancellationTable);
    })();
  },
  async postgres(pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE capture_batches ADD COLUMN IF NOT EXISTS cancelled_at TEXT');
      await client.query(cancellationTable);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  },
};
