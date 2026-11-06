import crypto from 'node:crypto';
import { getDb, getDialect } from '../../db.js';
import { createLogger } from '../logger.js';
import { isRestoreInProgress } from '../restore.js';
import { cleanupCapture, holdCapture, sweepCaptures } from './cleanup.js';
import { captureConfig } from './config.js';
import { prepareObservationMedia } from './media.js';
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

function claimCapture(now: Date): ClaimedCapture | undefined {
  const db = getDb();
  return db.transaction(() => {
    const timestamp = now.toISOString();
    // A crashed process leaves its lease behind. Only an expired lease is reclaimed.
    db.prepare(`UPDATE analysis_jobs SET state='retry',lease_token=NULL,lease_until=NULL,
      error_category='worker_interrupted',next_attempt_at=?,updated_at=?
      WHERE state='processing' AND (lease_until IS NULL OR lease_until<=?)`)
      .run(timestamp, timestamp, timestamp);
    db.prepare(`UPDATE capture_batches SET state='queued',updated_at=? WHERE state='processing'
      AND id IN (SELECT capture_id FROM analysis_jobs WHERE state='retry')`).run(timestamp);
    // A job that exhausted its budget before a crash must not get an unbounded extra attempt.
    const exhausted = db.prepare(`SELECT id,capture_id FROM analysis_jobs
      WHERE state IN ('queued','retry') AND attempts>=?`).all(maxAttempts()) as Array<{ id: string; capture_id: string }>;
    for (const job of exhausted) {
      db.prepare(`UPDATE analysis_jobs SET state='failed',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?`)
        .run(timestamp, job.id);
      db.prepare(`UPDATE capture_batches SET state='failed',expires_at=?,updated_at=? WHERE id=?`)
        .run(new Date(now.getTime() + captureConfig.failureTtlMs).toISOString(), timestamp, job.capture_id);
    }
    const row = db.prepare(`SELECT j.id AS job_id,j.capture_id,j.attempts,c.bin_id,c.created_by,c.sequence,c.captured_at,
      b.name AS bin_name,s.revision FROM analysis_jobs j
      JOIN capture_batches c ON c.id=j.capture_id JOIN bins b ON b.id=c.bin_id
      JOIN bin_capture_state s ON s.bin_id=c.bin_id
      WHERE j.state IN ('queued','retry') AND j.next_attempt_at<=? AND j.analysis_version=?
      AND c.state='queued'
      ORDER BY c.sequence,c.created_at LIMIT 1`).get(timestamp, CAPTURE_ANALYSIS_VERSION) as {
        job_id: string; capture_id: string; attempts: number; bin_id: string; created_by: string;
        sequence: number; captured_at: string; bin_name: string; revision: number;
      } | undefined;
    if (!row) return undefined;
    const token = crypto.randomUUID();
    db.prepare(`UPDATE analysis_jobs SET state='processing',attempts=attempts+1,lease_until=?,lease_token=?,
      model_alias=?,prompt_version=?,updated_at=? WHERE id=?`)
      .run(new Date(now.getTime() + LEASE_MS).toISOString(), token, process.env.AI_MODEL || null,
        CAPTURE_PROMPT_VERSION, timestamp, row.job_id);
    db.prepare(`UPDATE capture_batches SET state='processing',updated_at=? WHERE id=?`).run(timestamp, row.capture_id);
    return {
      jobId: row.job_id, captureId: row.capture_id, binId: row.bin_id, binName: row.bin_name,
      createdBy: row.created_by, sequence: row.sequence, capturedAt: row.captured_at,
      revision: row.revision, leaseToken: token, attempts: row.attempts + 1,
      existingItems: readExistingCaptureItems(row.bin_id),
    };
  }).immediate();
}

function recordFailure(claim: ClaimedCapture, error: CaptureProcessingError, now: Date): void {
  const db = getDb();
  db.transaction(() => {
    const job = db.prepare('SELECT state,lease_token FROM analysis_jobs WHERE id=?').get(claim.jobId) as
      { state: string; lease_token: string | null } | undefined;
    if (!job || job.state !== 'processing' || job.lease_token !== claim.leaseToken) return;
    const interrupted = error.category === 'worker_interrupted';
    const retry = interrupted || (error.retryable && claim.attempts < maxAttempts());
    const timestamp = now.toISOString();
    const rawBase = Number(process.env.CAPTURE_RETRY_BASE_MS || 10_000);
    const base = Number.isFinite(rawBase) ? Math.max(100, Math.min(60_000, rawBase)) : 10_000;
    const delay = interrupted ? 0 : Math.min(600_000, base * 2 ** (claim.attempts - 1));
    db.prepare(`UPDATE analysis_jobs SET state=?,lease_until=NULL,lease_token=NULL,error_category=?,
      next_attempt_at=?,attempts=?,updated_at=? WHERE id=?`)
      .run(retry ? 'retry' : 'failed', error.category, new Date(now.getTime() + delay).toISOString(),
        interrupted ? Math.max(0, claim.attempts - 1) : claim.attempts, timestamp, claim.jobId);
    if (retry) {
      db.prepare(`UPDATE capture_batches SET state='queued',updated_at=? WHERE id=?`).run(timestamp, claim.captureId);
    } else {
      const expiry = error.category === 'input_missing' ? timestamp : new Date(now.getTime() + captureConfig.failureTtlMs).toISOString();
      db.prepare(`UPDATE capture_batches SET state='failed',expires_at=?,updated_at=? WHERE id=?`)
        .run(expiry, timestamp, claim.captureId);
    }
  }).immediate();
}

/** Processes at most one durable job, independently of an HTTP request. */
export async function processNextCapture(options: CaptureWorkerOptions = {}): Promise<boolean> {
  if (busy || options.signal?.aborted || isRestoreInProgress() || getDialect() !== 'sqlite') return false;
  busy = true;
  let release: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let claim: ClaimedCapture | undefined;
  let successful = false;
  const now = options.now ?? (() => new Date());
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  try {
    claim = claimCapture(now());
    if (!claim) return false;
    assertCaptureWritable(claim);
    const activeClaim = claim;
    release = holdCapture(claim.captureId);
    heartbeat = setInterval(() => {
      try {
        const changed = getDb().prepare(`UPDATE analysis_jobs SET lease_until=?,updated_at=?
          WHERE id=? AND lease_token=? AND state='processing'`)
          .run(new Date(now().getTime() + LEASE_MS).toISOString(), now().toISOString(), activeClaim.jobId, activeClaim.leaseToken).changes;
        if (!changed) controller.abort();
      } catch { controller.abort(); }
    }, 10_000);
    heartbeat.unref();
    const photos = getDb().prepare(`SELECT id,storage_path,size,sha256 FROM capture_photos
      WHERE capture_id=? AND received_at IS NOT NULL AND deleted_at IS NULL ORDER BY position,id`)
      .all(claim.captureId) as RecognitionPhoto[];
    const batch = getDb().prepare('SELECT manifest_json FROM capture_batches WHERE id=?').get(claim.captureId) as
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
    const input = { captureId: claim.captureId, binName: claim.binName, photos, existingItems: claim.existingItems, signal };
    const output = await (options.recognize ?? recognizeCapture)(input);
    if (signal.aborted) throw new CaptureProcessingError('worker_interrupted');
    const result = validateRecognition(output, input);
    const media = await prepareObservationMedia(photos, result.items);
    if (signal.aborted) throw new CaptureProcessingError('worker_interrupted');
    commitRecognition(claim, result, now(), media);
    successful = true;
    return true;
  } catch (error) {
    if (claim) recordFailure(claim, error instanceof CaptureProcessingError ? error : new CaptureProcessingError('internal_error'), now());
    return !!claim;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    release?.();
    // Commit precedes deletion; deletion failure remains durable cleanup-pending work for the sweeper.
    if (successful && claim) await cleanupCapture(claim.captureId).catch(() => {});
    busy = false;
  }
}

export function startCaptureWorker(): { stop: () => Promise<void> } {
  if (getDialect() !== 'sqlite') return { stop: async () => {} };
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
