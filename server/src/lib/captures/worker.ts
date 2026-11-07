import crypto from 'node:crypto';
import { query } from '../../db.js';
import { createLogger } from '../logger.js';
import { isRestoreInProgress } from '../restore.js';
import { cleanupCapture, holdCapture, registerCaptureAbort, sweepCaptures } from './cleanup.js';
import { captureConfig } from './config.js';
import { withCaptureTransaction } from './database.js';
import { prepareObservationMedia, prepareRotationPreviews } from './media.js';
import type { RecognitionPhoto, Recognizer } from './recognition.js';
import {
  CAPTURE_ANALYSIS_VERSION,
  CAPTURE_PROMPT_VERSION,
  CaptureProcessingError,
  recognizeCapture,
  validateRecognition,
} from './recognition.js';
import type { ClaimedCapture } from './reconcile.js';
import { assertCaptureWritable, commitRecognition, readExistingCaptureItems } from './reconcile.js';

const log = createLogger('captures');
const LEASE_MS = 60_000;
let busy = false;

export interface CaptureWorkerOptions {
  recognize?: Recognizer;
  now?: () => Date;
  signal?: AbortSignal;
}

function maxAttempts(): number {
  const value = Number(process.env.CAPTURE_MAX_ATTEMPTS || 3);
  return Number.isInteger(value) ? Math.min(10, Math.max(1, value)) : 3;
}

export async function claimCapture(now: Date): Promise<ClaimedCapture | undefined> {
  return withCaptureTransaction(async (execute) => {
    const timestamp = now.toISOString();
    // A crashed process leaves its lease behind. Only an expired lease is reclaimed.
    await execute(`UPDATE analysis_jobs SET state='retry',lease_token=NULL,lease_until=NULL,
      error_category='worker_interrupted',next_attempt_at=$1,updated_at=$2
      WHERE state='processing' AND (lease_until IS NULL OR lease_until<=$3)
      AND capture_id IN (SELECT id FROM capture_batches WHERE cancelled_at IS NULL)`, [timestamp, timestamp, timestamp]);
    await execute(`UPDATE capture_batches SET state='queued',updated_at=$1 WHERE state='processing' AND cancelled_at IS NULL
      AND id IN (SELECT capture_id FROM analysis_jobs WHERE state='retry')`, [timestamp]);
    // A job that exhausted its budget before a crash must not get an unbounded extra attempt.
    const exhausted = (await execute(`SELECT id,capture_id FROM analysis_jobs
      WHERE state IN ('queued','retry') AND attempts>=$1
        AND capture_id IN (SELECT id FROM capture_batches WHERE cancelled_at IS NULL)`, [maxAttempts()])).rows as Array<{ id: string; capture_id: string }>;
    for (const job of exhausted) {
      await execute(`UPDATE analysis_jobs SET state='failed',lease_token=NULL,lease_until=NULL,updated_at=$1 WHERE id=$2`, [timestamp, job.id]);
      await execute(`UPDATE capture_batches SET state='failed',expires_at=$1,updated_at=$2 WHERE id=$3`, [new Date(now.getTime() + captureConfig.failureTtlMs).toISOString(), timestamp, job.capture_id]);
    }
    const row = (await execute(`SELECT j.id AS job_id,j.capture_id,j.attempts,c.bin_id,c.created_by,c.sequence,c.captured_at,c.source,
      b.name AS bin_name,s.revision FROM analysis_jobs j
      JOIN capture_batches c ON c.id=j.capture_id JOIN bins b ON b.id=c.bin_id
      JOIN bin_capture_state s ON s.bin_id=c.bin_id
      WHERE j.state IN ('queued','retry') AND j.next_attempt_at<=$1 AND j.analysis_version=$2
      AND c.state='queued' AND c.cancelled_at IS NULL
      ORDER BY c.sequence,c.created_at LIMIT 1`, [timestamp, CAPTURE_ANALYSIS_VERSION])).rows[0] as {
        job_id: string; capture_id: string; attempts: number; bin_id: string; created_by: string;
        sequence: number; captured_at: string; source: string; bin_name: string; revision: number;
      } | undefined;
    if (!row) return undefined;
    const token = crypto.randomUUID();
    await execute(`UPDATE analysis_jobs SET state='processing',attempts=attempts+1,lease_until=$1,lease_token=$2,
      model_alias=$3,prompt_version=$4,updated_at=$5 WHERE id=$6`, [
      new Date(now.getTime() + LEASE_MS).toISOString(),
      token,
      process.env.AI_MODEL || null,
      CAPTURE_PROMPT_VERSION,
      timestamp,
      row.job_id,
    ]);
    await execute(`UPDATE capture_batches SET state='processing',updated_at=$1 WHERE id=$2`, [timestamp, row.capture_id]);
    return {
      jobId: row.job_id, captureId: row.capture_id, binId: row.bin_id, binName: row.bin_name,
      createdBy: row.created_by, source: row.source, sequence: row.sequence, capturedAt: row.captured_at,
      revision: row.revision, leaseToken: token, attempts: row.attempts + 1,
      existingItems: await readExistingCaptureItems(row.bin_id, execute),
    };
  });
}

async function recordFailure(claim: ClaimedCapture, error: CaptureProcessingError, now: Date): Promise<void> {
  await withCaptureTransaction(async (execute) => {
    const job = (await execute('SELECT state,lease_token FROM analysis_jobs WHERE id=$1', [claim.jobId])).rows[0] as
      { state: string; lease_token: string | null } | undefined;
    if (!job || job.state !== 'processing' || job.lease_token !== claim.leaseToken) return;
    const interrupted = error.category === 'worker_interrupted';
    const retry = interrupted || (error.retryable && claim.attempts < maxAttempts());
    const timestamp = now.toISOString();
    const rawBase = Number(process.env.CAPTURE_RETRY_BASE_MS || 10_000);
    const base = Number.isFinite(rawBase) ? Math.max(100, Math.min(60_000, rawBase)) : 10_000;
    const delay = interrupted ? 0 : Math.min(600_000, base * 2 ** (claim.attempts - 1));
    await execute(`UPDATE analysis_jobs SET state=$1,lease_until=NULL,lease_token=NULL,error_category=$2,
      next_attempt_at=$3,attempts=$4,updated_at=$5 WHERE id=$6`, [
      retry ? 'retry' : 'failed',
      error.category,
      new Date(now.getTime() + delay).toISOString(),
      interrupted ? Math.max(0, claim.attempts - 1) : claim.attempts,
      timestamp,
      claim.jobId,
    ]);
    if (retry) {
      await execute(`UPDATE capture_batches SET state='queued',updated_at=$1 WHERE id=$2`, [timestamp, claim.captureId]);
    } else {
      const expiry = error.category === 'input_missing' ? timestamp : new Date(now.getTime() + captureConfig.failureTtlMs).toISOString();
      await execute(`UPDATE capture_batches SET state='failed',expires_at=$1,updated_at=$2 WHERE id=$3`, [expiry, timestamp, claim.captureId]);
    }
  });
}

/** Processes at most one durable job, independently of an HTTP request. */
export async function processNextCapture(options: CaptureWorkerOptions = {}): Promise<boolean> {
  if (busy || options.signal?.aborted || isRestoreInProgress()) return false;
  busy = true;
  let release: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let claim: ClaimedCapture | undefined;
  let unregister: (() => void) | undefined;
  const execute = query;
  const now = options.now ?? (() => new Date());
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  try {
    claim = await claimCapture(now());
    if (!claim) return false;
    unregister = registerCaptureAbort(claim.captureId, () => controller.abort());
    await assertCaptureWritable(claim);
    const activeClaim = claim;
    release = holdCapture(claim.captureId);
    heartbeat = setInterval(async () => {
      try {
        const changed = (await execute(`UPDATE analysis_jobs SET lease_until=$1,updated_at=$2
          WHERE id=$3 AND lease_token=$4 AND state='processing'`, [
          new Date(now().getTime() + LEASE_MS).toISOString(),
          now().toISOString(),
          activeClaim.jobId,
          activeClaim.leaseToken,
        ])).rowCount;
        if (!changed) controller.abort();
      } catch { controller.abort(); }
    }, 10_000);
    heartbeat.unref();
    const photos = (await execute(`SELECT p.id,p.storage_path,p.size,p.sha256,length(h.preview_jpeg) AS preview_bytes FROM capture_photos p
      LEFT JOIN capture_photo_history h ON h.capture_id=p.capture_id AND h.photo_id=p.id
      WHERE p.capture_id=$1 AND p.received_at IS NOT NULL AND p.deleted_at IS NULL ORDER BY p.position,p.id`, [claim.captureId])).rows as Array<RecognitionPhoto & { preview_bytes: number | null }>;
    const batch = (await execute('SELECT manifest_json FROM capture_batches WHERE id=$1', [claim.captureId])).rows[0] as
      { manifest_json: string | null };
    let manifest: unknown;
    try { manifest = JSON.parse(batch.manifest_json || 'null'); } catch { throw new CaptureProcessingError('input_invalid', false); }
    if (!Array.isArray(manifest) || manifest.length !== photos.length || photos.length === 0 || photos.length > captureConfig.maxPhotos) {
      throw new CaptureProcessingError('input_missing', false);
    }
    const declaredIds = new Set<string>();
    for (const entry of manifest) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || declaredIds.has(entry.id)) {
        throw new CaptureProcessingError('input_invalid', false);
      }
      declaredIds.add(entry.id);
      const photo = photos.find((photo) => photo.id === entry.id);
      if (!photo || photo.sha256 !== entry.sha256 || photo.size !== entry.size) {
        throw new CaptureProcessingError('input_invalid', false);
      }
    }
    const input = { captureId: claim.captureId, binId: claim.binId, binName: claim.binName, photos, existingItems: claim.existingItems, signal };
    if (signal.aborted) throw new CaptureProcessingError('worker_interrupted');
    const output = await (options.recognize ?? recognizeCapture)(input);
    if (signal.aborted) throw new CaptureProcessingError('worker_interrupted');
    const result = validateRecognition(output, input);
    const previews = await prepareRotationPreviews(photos, result.photo_rotations ?? []);
    const rotations = (result.photo_rotations ?? []).filter(rotation => previews.has(rotation.photo_id));
    const media = await prepareObservationMedia(photos, result.items, rotations);
    if (signal.aborted) throw new CaptureProcessingError('worker_interrupted');
    await commitRecognition(claim, result, now(), media, previews);
    return true;
  } catch (error) {
    if (claim) await recordFailure(claim, error instanceof CaptureProcessingError ? error : new CaptureProcessingError('internal_error'), now());
    return !!claim;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    unregister?.();
    release?.();
    // Commit precedes deletion; deletion failure remains durable cleanup-pending work for the sweeper.
    if (claim) await cleanupCapture(claim.captureId).catch(() => {});
    busy = false;
  }
}

export function startCaptureWorker(): { stop: () => Promise<void> } {
  const controller = new AbortController();
  let active: Promise<void> | undefined;
  let sweeping: Promise<void> | undefined;
  const tick = () => {
    if (active || controller.signal.aborted) return;
    active = processNextCapture({ signal: controller.signal }).then(() => {}).catch(() => {
      log.warn('Capture job could not run; it remains eligible for recovery.');
    }).finally(() => { active = undefined; });
  };
  const sweep = () => {
    if (sweeping || controller.signal.aborted || isRestoreInProgress()) return;
    sweeping = sweepCaptures().catch(() => {
      log.warn('Capture cleanup will be retried.');
    }).finally(() => { sweeping = undefined; });
  };
  sweep();
  tick();
  const pollTimer = setInterval(tick, 1000);
  const sweepTimer = setInterval(sweep, 30_000);
  pollTimer.unref();
  sweepTimer.unref();
  return {
    async stop() {
      clearInterval(pollTimer);
      clearInterval(sweepTimer);
      controller.abort();
      await Promise.all([active, sweeping]);
    },
  };
}
