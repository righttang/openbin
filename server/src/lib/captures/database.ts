import { getDialect, type TxQueryFn, withTransaction } from '../../db.js';

/**
 * Capture mutations share a short transaction lock: sequence allocation, job
 * leases, image quotas and evidence removal must agree across PostgreSQL clients.
 * Image decoding, uploads and inference always happen outside this transaction.
 * SQLite's engine serializes transactions instead.
 */
export async function withCaptureTransaction<T>(fn: (execute: TxQueryFn) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(async (execute) => {
        if (getDialect() === 'postgres') {
          // Manual inventory edits use their own transactions. Serializable
          // isolation prevents a concurrent edit from slipping past revision
          // validation, without imposing a conflicting row-lock order on it.
          await execute('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
          await execute('SELECT pg_advisory_xact_lock($1)', [0x524d4341]);
        }
        return fn(execute);
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (getDialect() !== 'postgres' || attempt >= 31 || !['40001', '40P01'].includes(code ?? '')) throw error;
      // Lock waiters may hold an older MVCC snapshot. Retry the whole callback
      // with a fresh snapshot, yielding between attempts during upload bursts.
      await new Promise(resolve => setTimeout(resolve, Math.min(50, 5 * (attempt + 1))));
    }
  }
}
