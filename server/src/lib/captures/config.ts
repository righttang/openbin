import os from 'node:os';
import path from 'node:path';

function integer(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

// Keep scratch outside the backed-up database and permanent photo directories.
const defaultScratch = process.env.NODE_ENV === 'test'
  ? path.join(os.tmpdir(), `remindme-captures-${process.pid}`)
  : path.join(path.dirname(path.resolve(process.env.DATABASE_PATH || './data/openbin.db')), '..', 'capture-scratch');

export const captureConfig = Object.freeze({
  scratchPath: path.resolve(process.env.CAPTURE_SCRATCH_PATH || defaultScratch),
  maxPhotos: integer('CAPTURE_MAX_PHOTOS', 20, 1, 20),
  maxPhotoBytes: integer('CAPTURE_MAX_PHOTO_BYTES', 5 * 1024 * 1024, 1, 20 * 1024 * 1024),
  scratchQuotaBytes: integer('CAPTURE_SCRATCH_QUOTA_BYTES', 512 * 1024 * 1024),
  reservedHeadroomBytes: integer('CAPTURE_HEADROOM_BYTES', 32 * 1024 * 1024, 0),
  minFreeDiskBytes: integer('CAPTURE_MIN_FREE_DISK_BYTES', 64 * 1024 * 1024, 0),
  uploadExpiryMs: integer('CAPTURE_UPLOAD_EXPIRY_MS', 60 * 60 * 1000),
  failureTtlMs: integer('CAPTURE_FAILURE_TTL_MS', 60 * 60 * 1000),
});

function overlaps(a: string, b: string) {
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}
const persistentDirectories = [path.resolve(process.env.PHOTO_STORAGE_PATH || './uploads')];
if (process.env.DATABASE_PATH !== ':memory:') persistentDirectories.push(path.dirname(path.resolve(process.env.DATABASE_PATH || './data/openbin.db')));
if (persistentDirectories.some(directory => overlaps(captureConfig.scratchPath, directory))) {
  throw new Error('CAPTURE_SCRATCH_PATH must be separate from database, backups and permanent photo storage');
}

export const supportedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
