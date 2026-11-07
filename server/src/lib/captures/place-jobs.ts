import crypto from 'node:crypto';
import { query, type TxQueryFn } from '../../db.js';
import { HttpError, NotFoundError } from '../httpErrors.js';
import { assertLocationWritable } from '../planGate.js';
import { abortCaptureActivity, registerCaptureAbort } from './cleanup.js';
import { withCaptureTransaction } from './database.js';
import { type DeduplicationOptions, type DeduplicationResult, deduplicatePlace } from './deduplicate.js';
import { loadPlace } from './place-refine.js';
import { CaptureProcessingError } from './recognition.js';

export interface PlaceJob {
  id: string; bin_id: string; created_by: string; kind: string; state: string; attempts: number;
  lease_token: string | null; lease_until: string | null; next_attempt_at: string;
  result_json: string | null; error_category: string | null; created_at: string; updated_at: string;
}
export type Deduplicator = (binId: string, userId: string, options: DeduplicationOptions) => Promise<DeduplicationResult>;
export function publicPlaceJob(job: PlaceJob) {
  return { id: job.id, bin_id: job.bin_id, kind: job.kind, state: job.state, attempts: job.attempts,
    result: job.result_json ? JSON.parse(job.result_json) as DeduplicationResult : null,
    error_category: job.error_category, created_at: job.created_at, updated_at: job.updated_at };
}
export async function enqueuePlaceJob(binId: string, userId: string) {
  const place = await loadPlace(binId, userId);
  await assertLocationWritable(place.location_id);
  return withCaptureTransaction(async execute => {
    await loadPlace(binId, userId, execute);
    const active = (await execute<PlaceJob>("SELECT * FROM place_jobs WHERE bin_id=$1 AND state IN ('queued','processing','retry')", [binId])).rows[0];
    if (active) return publicPlaceJob(active);
    const now = new Date().toISOString(), id = crypto.randomUUID();
    await execute('INSERT INTO place_jobs (id,bin_id,created_by,next_attempt_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$4,$4)', [id, binId, userId, now]);
    return publicPlaceJob((await execute<PlaceJob>('SELECT * FROM place_jobs WHERE id=$1', [id])).rows[0]);
  });
}
export async function getPlaceJob(id: string, userId: string) {
  const row = (await query<PlaceJob>('SELECT * FROM place_jobs WHERE id=$1', [id])).rows[0];
  if (!row) throw new NotFoundError('任务不存在。');
  await loadPlace(row.bin_id, userId);
  return publicPlaceJob(row);
}
export async function listPlaceJobs(userId: string) {
  const rows = (await query<PlaceJob>(`SELECT j.* FROM place_jobs j JOIN bins b ON b.id=j.bin_id
    JOIN location_members lm ON lm.location_id=b.location_id AND lm.user_id=$1
    WHERE b.deleted_at IS NULL AND (b.visibility='location' OR b.created_by=$1)
    ORDER BY j.created_at DESC,j.id DESC LIMIT 100`, [userId])).rows;
  return rows.map(publicPlaceJob);
}
export async function cancelPlaceJob(id: string, userId: string) {
  const job = await getPlaceJob(id, userId);
  const result = await withCaptureTransaction(async execute => {
    await loadPlace(job.bin_id, userId, execute);
    await execute("UPDATE place_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL,updated_at=$1 WHERE id=$2 AND state IN ('queued','processing','retry')", [new Date().toISOString(), id]);
    return publicPlaceJob((await execute<PlaceJob>('SELECT * FROM place_jobs WHERE id=$1', [id])).rows[0]);
  });
  abortCaptureActivity(id);
  return result;
}

export async function processPlaceJob(job: PlaceJob, signal: AbortSignal, now: () => Date, deduplicate: Deduplicator = deduplicatePlace) {
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  const unregister = registerCaptureAbort(job.id, () => controller.abort());
  const heartbeat = setInterval(async () => {
    try {
      const updated = await query("UPDATE place_jobs SET lease_until=$1,updated_at=$2 WHERE id=$3 AND lease_token=$4 AND state='processing'",
        [new Date(now().getTime() + 60_000).toISOString(), now().toISOString(), job.id, job.lease_token]);
      if (!updated.rowCount) controller.abort();
    } catch { controller.abort(); }
  }, 10_000);
  heartbeat.unref();
  try {
    const assertActive = async (execute: TxQueryFn) => {
      if (combined.aborted) throw new CaptureProcessingError('worker_interrupted');
      const current = (await execute<PlaceJob>('SELECT * FROM place_jobs WHERE id=$1', [job.id])).rows[0];
      if (!current || current.state !== 'processing' || current.lease_token !== job.lease_token || !current.lease_until || current.lease_until <= now().toISOString()) {
        throw new CaptureProcessingError('worker_interrupted');
      }
    };
    await assertActive(query);
    await deduplicate(job.bin_id, job.created_by, { signal: combined, assertActive,
      completed: async (result, execute) => {
        await assertActive(execute);
        await execute("UPDATE place_jobs SET state='completed',result_json=$1,error_category=NULL,lease_token=NULL,lease_until=NULL,updated_at=$2 WHERE id=$3",
          [JSON.stringify(result), now().toISOString(), job.id]);
      },
    });
  } catch (error) {
    await withCaptureTransaction(async execute => {
      const current = (await execute<PlaceJob>('SELECT * FROM place_jobs WHERE id=$1', [job.id])).rows[0];
      if (current?.state !== 'processing' || current.lease_token !== job.lease_token) return;
      const interrupted = combined.aborted;
      const category = interrupted ? 'worker_interrupted' : error instanceof HttpError ? error.code : error instanceof CaptureProcessingError ? error.category : 'internal_error';
      const retry = interrupted || error instanceof HttpError && error.statusCode === 409
        || (job.attempts < 3 && (error instanceof HttpError ? [502, 504].includes(error.statusCode) : error instanceof CaptureProcessingError && error.retryable));
      const attempts = interrupted || category === 'CONFLICT' ? Math.max(0, job.attempts - 1) : job.attempts;
      await execute('UPDATE place_jobs SET state=$1,error_category=$2,attempts=$3,lease_token=NULL,lease_until=NULL,next_attempt_at=$4,updated_at=$5 WHERE id=$6',
        [retry ? 'retry' : 'failed', category, attempts, new Date(now().getTime() + (interrupted ? 0 : 2000)).toISOString(), now().toISOString(), job.id]);
    });
  } finally { clearInterval(heartbeat); unregister(); }
}
