import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import sharp from 'sharp';
import { query, type TxQueryFn } from '../../db.js';
import { requireCreatorOrAdmin, requireMemberOrAbove, verifyBinAccess } from '../binAccess.js';
import { ConflictError, HttpError, NotFoundError, ValidationError } from '../httpErrors.js';
import { captureDirectory, cleanupCapture, holdCapture, registerCaptureAbort } from './cleanup.js';
import { captureConfig, supportedMimeTypes } from './config.js';
import { withCaptureTransaction } from './database.js';
import { storePhotoPreview } from './history.js';
import { makePhotoPreview } from './media.js';
import type { CaptureBatch, CapturePhoto, PhotoManifestEntry } from './types.js';

const stableId = /^[a-zA-Z0-9_-]{8,80}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const uploadLocks = new Set<string>();

function requireId(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !stableId.test(value)) throw new ValidationError(`${name} must be an 8–80 character stable ID`);
}

export async function getCapture(id: string, execute: TxQueryFn = query): Promise<CaptureBatch> {
  const row = (await execute('SELECT * FROM capture_batches WHERE id = $1', [id])).rows[0] as CaptureBatch | undefined;
  if (!row) throw new NotFoundError('Capture not found');
  return row;
}

export async function authorizeCapture(id: string, userId: string, write = false): Promise<CaptureBatch> {
  const batch = await getCapture(id);
  const access = await verifyBinAccess(batch.bin_id, userId);
  if (!access || (write && batch.created_by !== userId)) throw new NotFoundError('Capture not found');
  if (write) {
    await requireMemberOrAbove(access.locationId, userId, 'capture contents');
    await requireCreatorOrAdmin(access.locationId, userId, access.createdBy, 'capture contents');
  }
  return batch;
}

export async function captureStatus(id: string, execute: TxQueryFn = query) {
  const batch = await getCapture(id, execute);
  const rows = (await execute('SELECT * FROM capture_photos WHERE capture_id = $1 ORDER BY position, id', [id])).rows as CapturePhoto[];
  const photos = rows.map(photo => ({
    id: photo.id, sha256: photo.sha256, size: photo.size, order: photo.position,
    // A restored uploading manifest may outlive its scratch volume. Let the
    // browser resend the original photo IDs instead of falsely acknowledging.
    received_at: batch.state === 'uploading' && !fs.existsSync(photo.storage_path) ? null : photo.received_at,
    deleted_at: photo.deleted_at,
  }));
  const job = (await execute('SELECT state, attempts, error_category, next_attempt_at FROM analysis_jobs WHERE capture_id = $1 ORDER BY analysis_version DESC LIMIT 1', [id])).rows[0] as Record<string, unknown> | undefined;
  const { manifest_json: _manifest, ...safe } = batch;
  return { ...safe, state: batch.cancelled_at ? 'cancelled' as const : batch.state, photos, error_category: job?.error_category ?? null, job: job ?? null };
}

export async function createCapture(input: Record<string, unknown>, userId: string) {
  requireId(input.id, 'id');
  if (typeof input.bin_id !== 'string' || !input.bin_id) throw new ValidationError('bin_id is required');
  const access = await verifyBinAccess(input.bin_id, userId);
  if (!access) throw new NotFoundError('Storage location not found');
  await requireMemberOrAbove(access.locationId, userId, 'capture contents');
  await requireCreatorOrAdmin(access.locationId, userId, access.createdBy, 'capture contents');
  const source = input.source ?? 'web';
  for (const [name, value] of [['source', source], ['device_id', input.device_id], ['event_id', input.event_id]] as const) {
    if (value != null && (typeof value !== 'string' || value.length > 120)) throw new ValidationError(`${name} is invalid`);
  }
  const capturedAt = input.captured_at ?? new Date().toISOString();
  if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) throw new ValidationError('captured_at is invalid');
  await withCaptureTransaction(async (execute) => {
    const cancelled = (await execute<{ created_by: string }>('SELECT created_by FROM capture_cancellations WHERE id=$1', [input.id])).rows[0];
    if (cancelled) {
      if (cancelled.created_by !== userId) throw new NotFoundError('Capture not found');
      throw new HttpError(410, 'CAPTURE_CANCELLED', 'This capture was cancelled. Start a new capture.');
    }
    const existing = (await execute('SELECT * FROM capture_batches WHERE id = $1', [input.id])).rows[0] as CaptureBatch | undefined;
    if (existing) {
      assertNotCancelled(existing);
      if (existing.created_by !== userId) throw new NotFoundError('Capture not found');
      if (existing.bin_id !== input.bin_id || existing.source !== source
        || (input.device_id != null && existing.device_id !== input.device_id)
        || (input.event_id != null && existing.event_id !== input.event_id)
        || (input.captured_at != null && existing.captured_at !== new Date(capturedAt).toISOString())) {
        throw new ConflictError('Capture ID already belongs to a different capture');
      }
      return;
    }
    const now = new Date().toISOString();
    await execute('INSERT INTO bin_capture_state (bin_id) VALUES ($1) ON CONFLICT DO NOTHING', [input.bin_id]);
    const sequence = (await execute('UPDATE bin_capture_state SET next_sequence = next_sequence + 1 WHERE bin_id = $1 RETURNING next_sequence', [input.bin_id])).rows[0] as { next_sequence: number };
    await execute(`INSERT INTO capture_batches
      (id,bin_id,created_by,source,device_id,event_id,captured_at,sequence,state,expires_at,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'uploading',$9,$10,$11)`, [
      input.id,
      input.bin_id,
      userId,
      source,
      input.device_id ?? null,
      input.event_id ?? null,
      new Date(capturedAt).toISOString(),
      sequence.next_sequence,
      new Date(Date.now() + captureConfig.uploadExpiryMs).toISOString(),
      now,
      now,
    ]);
  });
  return captureStatus(input.id);
}

function diskFiles(directory: string): Map<string, number> {
  const files = new Map<string, number>();
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) for (const [p, size] of diskFiles(filename)) files.set(p, size);
    else files.set(filename, fs.lstatSync(filename).size);
  }
  return files;
}

/** Include durable reservations, actual files, partial writes and untracked leftovers. */
export async function scratchUsage(execute: TxQueryFn = query): Promise<number> {
  const files = diskFiles(captureConfig.scratchPath);
  let bytes = 0;
  const photos = (await execute('SELECT storage_path,size FROM capture_photos WHERE deleted_at IS NULL', [])).rows as Pick<CapturePhoto, 'storage_path' | 'size'>[];
  for (const photo of photos) {
    const actual = (files.get(photo.storage_path) ?? 0) + (files.get(`${photo.storage_path}.part`) ?? 0);
    bytes += Math.max(photo.size, actual);
    files.delete(photo.storage_path);
    files.delete(`${photo.storage_path}.part`);
  }
  for (const size of files.values()) bytes += size;
  return bytes;
}

export function assertNotCancelled(batch: Pick<CaptureBatch, 'cancelled_at'>): void {
  if (batch.cancelled_at) throw new HttpError(410, 'CAPTURE_CANCELLED', 'This capture was cancelled. Start a new capture.');
}

function assertUploadable(batch: CaptureBatch) {
  assertNotCancelled(batch);
  if (batch.state !== 'uploading') throw new ConflictError('This capture is sealed');
  if (batch.expires_at <= new Date().toISOString()) throw new HttpError(410, 'CAPTURE_EXPIRED', 'Capture expired. Start a new capture.');
}

export async function receivePhoto(req: Request, captureId: string, photoId: string, userId: string, queueAfterUpload = false) {
  requireId(photoId, 'photoId');
  assertNotCancelled(await authorizeCapture(captureId, userId, true));
  const sha256 = req.header('X-Photo-SHA256')?.toLowerCase();
  const size = Number(req.header('Content-Length') ?? req.header('X-Photo-Size'));
  const declaredSize = req.header('X-Photo-Size');
  const mimeType = req.header('Content-Type')?.split(';')[0].toLowerCase();
  if (!sha256 || !sha256Pattern.test(sha256)) throw new ValidationError('X-Photo-SHA256 is required');
  if (!Number.isSafeInteger(size) || size <= 0 || (declaredSize && Number(declaredSize) !== size)) throw new ValidationError('A valid photo byte size is required');
  if (size > captureConfig.maxPhotoBytes) throw new HttpError(413, 'PHOTO_TOO_LARGE', 'Photo exceeds the configured size limit');
  if (!mimeType || !supportedMimeTypes.includes(mimeType as typeof supportedMimeTypes[number])) {
    throw new HttpError(415, 'UNSUPPORTED_IMAGE', 'Use JPEG, PNG or WebP. Export HEIC photos as JPEG first.');
  }
  const lock = `${captureId}/${photoId}`;
  if (uploadLocks.has(lock)) throw new ConflictError('This photo is already uploading. Retry shortly.');
  uploadLocks.add(lock);
  const release = holdCapture(captureId);
  const unregister = registerCaptureAbort(captureId, () => req.destroy());
  try {
    const execute = query;
    let photo: CapturePhoto;
    assertNotCancelled(await getCapture(captureId, execute));
    const existing = (await execute('SELECT * FROM capture_photos WHERE capture_id = $1 AND id = $2', [captureId, photoId])).rows[0] as CapturePhoto | undefined;
    if (existing) {
      if (existing.sha256 !== sha256 || existing.size !== size || existing.mime_type !== mimeType) throw new ConflictError('Photo ID already has different content');
      const current = await getCapture(captureId, execute);
      assertNotCancelled(current);
      if (existing.received_at && (current.state !== 'uploading' || fs.existsSync(existing.storage_path))) {
        if (queueAfterUpload) await completeCapture(captureId, [{ id: photoId, sha256, size, order: 0 }], userId);
        return { id: photoId, sha256, size, received_at: existing.received_at };
      }
      if (existing.received_at) await execute('UPDATE capture_photos SET received_at = NULL WHERE capture_id = $1 AND id = $2', [captureId, photoId]);
    }
    fs.mkdirSync(captureDirectory(captureId), { recursive: true, mode: 0o700 });
    await withCaptureTransaction(async (execute) => {
      assertUploadable(await getCapture(captureId, execute));
      const count = (await execute('SELECT COUNT(*) AS n FROM capture_photos WHERE capture_id = $1', [captureId])).rows[0] as { n: number };
      if (!existing && count.n >= captureConfig.maxPhotos) throw new ValidationError(`Maximum ${captureConfig.maxPhotos} photos per capture`);
      const duplicate = (await execute('SELECT id FROM capture_photos WHERE capture_id = $1 AND sha256 = $2 AND id != $3', [captureId, sha256, photoId])).rows[0];
      if (duplicate) throw new ConflictError('This exact image is already in the capture');
      const additional = existing ? 0 : size;
      if ((await scratchUsage(execute)) + additional + captureConfig.reservedHeadroomBytes > captureConfig.scratchQuotaBytes) {
        throw new HttpError(507, 'SCRATCH_QUOTA', 'Temporary photo storage is full. Try again after processing finishes.');
      }
      const disk = fs.statfsSync(captureConfig.scratchPath);
      const reservations = (await execute('SELECT size, storage_path FROM capture_photos WHERE deleted_at IS NULL', [])).rows as Pick<CapturePhoto, 'storage_path' | 'size'>[];
      const outstanding = reservations.reduce((sum, reservation) => {
        let written = 0;
        for (const filename of [reservation.storage_path, `${reservation.storage_path}.part`]) {
          try { written += fs.statSync(filename).size; } catch { /* Not written yet. */ }
        }
        return sum + Math.max(0, reservation.size - written);
      }, 0);
      if (disk.bavail * disk.bsize < outstanding + additional + captureConfig.minFreeDiskBytes + captureConfig.reservedHeadroomBytes) {
        throw new HttpError(507, 'DISK_SPACE', 'Not enough free disk space for this photo');
      }
      const filename = path.join(captureDirectory(captureId), photoId);
      if (!existing) {
        await execute(`INSERT INTO capture_photos (capture_id,id,position,sha256,size,mime_type,storage_path)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [captureId, photoId, count.n, sha256, size, mimeType, filename]);
      }
    });
    photo = (await execute('SELECT * FROM capture_photos WHERE capture_id = $1 AND id = $2', [captureId, photoId])).rows[0] as CapturePhoto;
    // Socket inactivity alone is insufficient: a trickling client must not hold
    // an expired batch's files indefinitely. Bound the entire upload lifetime.
    const deadlineMs = Math.max(1, Math.min(120_000, Date.parse((await getCapture(captureId)).expires_at) - Date.now()));
    const deadline = setTimeout(() => req.destroy(new Error('Photo upload deadline exceeded')), deadlineMs);
    deadline.unref();
    let handle: fs.promises.FileHandle | undefined;
    try {
      // A restarted upload overwrites only its own unacknowledged partial file.
      // Remove a final file left by a crash between rename and DB acknowledgement
      // before writing again, so retrying cannot occupy twice its reservation.
      fs.rmSync(photo.storage_path, { force: true });
      handle = await fs.promises.open(`${photo.storage_path}.part`, 'w', 0o600);
      const hash = crypto.createHash('sha256');
      let received = 0;
      req.setTimeout(120_000, () => req.destroy(new Error('Photo upload timeout')));
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > size) throw new ValidationError('Photo exceeds declared size');
        hash.update(bytes);
        await handle.writeFile(bytes);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (received !== size || hash.digest('hex') !== sha256) throw new ValidationError('Photo size or checksum does not match');
      let format: string | undefined;
      try {
        const metadata = await sharp(`${photo.storage_path}.part`, { limitInputPixels: 40_000_000 }).metadata();
        format = metadata.format;
        if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error('Invalid image');
      } catch { throw new ValidationError('Photo could not be decoded. Use a JPEG, PNG or WebP image.'); }
      const expectedFormat = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[mimeType];
      if (format !== expectedFormat) throw new ValidationError('Photo format does not match Content-Type');
      fs.renameSync(`${photo.storage_path}.part`, photo.storage_path);
      let preview: Awaited<ReturnType<typeof makePhotoPreview>> | null = null;
      try { preview = await makePhotoPreview(photo.storage_path); } catch { /* The original remains available for recognition. */ }
      const receivedAt = new Date().toISOString();
      await withCaptureTransaction(async (execute) => {
        assertUploadable(await getCapture(captureId, execute));
        await storePhotoPreview(captureId, photoId, preview, execute);
        await execute('UPDATE capture_photos SET received_at = $1 WHERE capture_id = $2 AND id = $3', [receivedAt, captureId, photoId]);
        if (queueAfterUpload) await sealReceivedCapture(captureId, [{ id: photoId, sha256, size, order: 0 }], execute);
      });
      return { id: photoId, sha256, size, received_at: receivedAt };
    } catch (error) {
      await handle?.close().catch(() => {});
      // On unlink failure keep the reservation so quota accounting remains safe.
      let removed = true;
      for (const filename of [`${photo.storage_path}.part`, photo.storage_path]) {
        try { fs.rmSync(filename, { force: true }); } catch { removed = false; }
      }
      if (removed) await execute('DELETE FROM capture_photos WHERE capture_id = $1 AND id = $2 AND received_at IS NULL', [captureId, photoId]);
      throw error;
    } finally {
      clearTimeout(deadline);
      req.setTimeout(0);
    }
  } finally {
    unregister();
    release();
    uploadLocks.delete(lock);
    await cleanupCapture(captureId).catch(() => {});
  }
}

export function parseManifest(value: unknown): PhotoManifestEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > captureConfig.maxPhotos) throw new ValidationError(`A capture needs 1–${captureConfig.maxPhotos} photos`);
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const orders = new Set<number>();
  const photos = value.map((p: Record<string, unknown>) => {
    if (!p || typeof p !== 'object') throw new ValidationError('Invalid photo manifest');
    requireId(p.id, 'photo.id');
    if (typeof p.sha256 !== 'string' || !sha256Pattern.test(p.sha256) || !Number.isSafeInteger(p.size) || Number(p.size) <= 0
      || Number(p.size) > captureConfig.maxPhotoBytes || !Number.isSafeInteger(p.order) || Number(p.order) < 0 || Number(p.order) >= value.length) throw new ValidationError('Invalid photo manifest');
    if (ids.has(p.id) || hashes.has(p.sha256) || orders.has(Number(p.order))) throw new ValidationError('Manifest contains duplicate photos or positions');
    ids.add(p.id); hashes.add(p.sha256); orders.add(Number(p.order));
    return { id: p.id, sha256: p.sha256, size: Number(p.size), order: Number(p.order) };
  });
  return photos.sort((a, b) => a.order - b.order);
}

export async function completeCapture(id: string, input: unknown, userId: string) {
  await authorizeCapture(id, userId, true);
  const manifest = parseManifest(input);
  await withCaptureTransaction(execute => sealReceivedCapture(id, manifest, execute));
  return captureStatus(id);
}

/** Receipt and native queue entry commit together, even if the client disappears. */
async function sealReceivedCapture(id: string, manifest: PhotoManifestEntry[], execute: TxQueryFn) {
  const serialized = JSON.stringify(manifest);
  const batch = await getCapture(id, execute);
  assertNotCancelled(batch);
  if (batch.manifest_json !== null) {
    if (batch.manifest_json !== serialized) throw new ConflictError('The sealed photo manifest cannot change');
    return;
  }
  assertUploadable(batch);
  const received = (await execute('SELECT * FROM capture_photos WHERE capture_id = $1', [id])).rows as CapturePhoto[];
  if (received.length !== manifest.length) throw new ConflictError('Not all declared photos have been received');
  for (const photo of manifest) {
    const found = received.find(p => p.id === photo.id);
    if (!found?.received_at || found.deleted_at || found.sha256 !== photo.sha256 || found.size !== photo.size || !fs.existsSync(found.storage_path)) {
      throw new ConflictError('Not all declared photos have been received');
    }
    await execute('UPDATE capture_photos SET position = $1 WHERE capture_id = $2 AND id = $3', [photo.order, id, photo.id]);
  }
  const now = new Date().toISOString();
  await execute("UPDATE capture_batches SET manifest_json = $1, state = 'queued', received_at = $2, updated_at = $3 WHERE id = $4", [serialized, now, now, id]);
  await execute(`INSERT INTO analysis_jobs (id,capture_id,analysis_version,state,next_attempt_at,created_at,updated_at)
    VALUES ($1,$2,1,'queued',$3,$4,$5) ON CONFLICT(capture_id,analysis_version) DO NOTHING`, [crypto.randomUUID(), id, now, now, now]);
}
