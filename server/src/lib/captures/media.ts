import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { captureConfig } from './config.js';
import type { PhotoRotation, RecognitionPhoto, RecognizedItem } from './recognition.js';

export const MAX_PREVIEW_BYTES = 256 * 1024;
export const MAX_CROP_BYTES = 128 * 1024;
// Bound retained buffers while a large batch is awaiting its atomic DB commit.
export const MAX_BATCH_CROP_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;

export interface PhotoPreview {
  jpeg: Buffer;
  width: number;
  height: number;
}

export interface ObservationMedia {
  photoId: string;
  box: [number, number, number, number];
  jpeg: Buffer;
}

async function readBoundedPhoto(filename: string): Promise<Buffer> {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size <= 0 || stat.size > captureConfig.maxPhotoBytes) {
    throw new Error('Image exceeds preview input limits');
  }
  const bytes = await fs.readFile(filename);
  if (bytes.length > captureConfig.maxPhotoBytes) throw new Error('Image exceeds preview input limits');
  return bytes;
}

/** Encode only real image pixels, strip metadata and cap both dimensions and bytes. */
async function boundedJpeg(source: sharp.Sharp, maxDimension: number, maxBytes: number): Promise<PhotoPreview> {
  for (const dimension of [maxDimension, Math.floor(maxDimension * 0.75), Math.floor(maxDimension * 0.5), 128]) {
    for (const quality of [80, 65, 45]) {
      const { data, info } = await source.clone()
        .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, chromaSubsampling: '4:2:0' }).toBuffer({ resolveWithObject: true });
      if (data.length <= maxBytes) return { jpeg: data, width: info.width, height: info.height };
    }
  }
  throw new Error('Could not generate a bounded image');
}

/** Small upright history image. Caller may retain a text-only record if decoding fails. */
export async function makePhotoPreview(photoPath: string, rotation = 0): Promise<PhotoPreview> {
  const bytes = await readBoundedPhoto(photoPath);
  return boundedJpeg(sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).autoOrient().rotate(rotation), 960, MAX_PREVIEW_BYTES);
}

/** Used when normalizing retained history after its temporary originals were cleaned. */
export async function rotateRetainedJpeg(bytes: Buffer, rotation: number, kind: 'preview' | 'crop'): Promise<PhotoPreview> {
  return boundedJpeg(sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).autoOrient().rotate(rotation),
    kind === 'preview' ? 960 : 512, Math.min(bytes.length, kind === 'preview' ? MAX_PREVIEW_BYTES : MAX_CROP_BYTES));
}

/** Keep the source coordinate system for extraction; rotate its visible bounds for the preview. */
export function rotateBox(box: readonly [number, number, number, number], rotation: number): [number, number, number, number] {
  const [left, top, right, bottom] = box;
  switch (rotation) {
    case 90: return [1 - bottom, left, 1 - top, right];
    case 180: return [1 - right, 1 - bottom, 1 - left, 1 - top];
    case 270: return [top, 1 - right, bottom, 1 - left];
    default: return [...box];
  }
}

export async function prepareRotationPreviews(
  photos: Array<RecognitionPhoto & { preview_bytes?: number | null }>, rotations: PhotoRotation[],
): Promise<Map<string, PhotoPreview>> {
  const result = new Map<string, PhotoPreview>();
  for (const photo of photos) {
    const rotation = rotations.find(entry => entry.photo_id === photo.id)?.clockwise_degrees ?? 0;
    if (!rotation) continue;
    try {
      const bytes = await readBoundedPhoto(photo.storage_path);
      if (bytes.length !== photo.size || crypto.createHash('sha256').update(bytes).digest('hex') !== photo.sha256) continue;
      // Replacing an existing preview must not need additional history quota.
      const maxBytes = Math.min(photo.preview_bytes || MAX_PREVIEW_BYTES, MAX_PREVIEW_BYTES);
      result.set(photo.id, await boundedJpeg(sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).autoOrient().rotate(rotation), 960, maxBytes));
    } catch { /* Keep this photo's original orientation when its preview cannot be regenerated. */ }
  }
  return result;
}

function validBox(box: readonly number[]): box is [number, number, number, number] {
  return box.length === 4 && box.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && box[2] > box[0] && box[3] > box[1];
}

/**
 * Keep output aligned to recognition items, including empty entries for missing regions.
 * Normalizing before extraction gives EXIF photos the same coordinate system the model saw.
 * Failures affect the image only: structured results can still be kept without a crop.
 */
export async function prepareObservationMedia(photos: RecognitionPhoto[], items: RecognizedItem[], rotations: PhotoRotation[] = []): Promise<ObservationMedia[][]> {
  const output: ObservationMedia[][] = items.map(() => []);
  let retainedBytes = 0;
  for (const photo of photos) {
    if (retainedBytes >= MAX_BATCH_CROP_BYTES) break;
    const rotation = rotations.find(entry => entry.photo_id === photo.id)?.clockwise_degrees ?? 0;
    const requests = items.slice(0, 300).flatMap((item, itemIndex) => {
      if (!item.photo_ids.includes(photo.id)) return [];
      // One best crop per item bounds work to the schema's maximum of 300 items.
      const region = item.regions?.[0];
      return region?.photo_id === photo.id && validBox(region.box) ? [{ itemIndex, box: region.box }] : [];
    });
    if (requests.length === 0) continue;
    let normalized: { data: Buffer; info: sharp.OutputInfo };
    try {
      const bytes = await readBoundedPhoto(photo.storage_path);
      if (bytes.length !== photo.size || crypto.createHash('sha256').update(bytes).digest('hex') !== photo.sha256) continue;
      // At most ~10 MiB decoded per source, processed one photo at a time.
      normalized = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
        .autoOrient().rotate(rotation).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .raw().toBuffer({ resolveWithObject: true });
    } catch { continue; }
    const { width, height, channels } = normalized.info;
    for (const { itemIndex, box } of requests) {
      if (retainedBytes >= MAX_BATCH_CROP_BYTES) break;
      const orientedBox = rotateBox(box, rotation);
      const left = Math.min(width - 1, Math.floor(orientedBox[0] * width));
      const top = Math.min(height - 1, Math.floor(orientedBox[1] * height));
      const right = Math.min(width, Math.max(left + 1, Math.ceil(orientedBox[2] * width)));
      const bottom = Math.min(height, Math.max(top + 1, Math.ceil(orientedBox[3] * height)));
      try {
        const crop = await boundedJpeg(
          sharp(normalized.data, { raw: { width, height, channels } })
            .extract({ left, top, width: right - left, height: bottom - top }),
          512, MAX_CROP_BYTES,
        );
        if (retainedBytes + crop.jpeg.length > MAX_BATCH_CROP_BYTES) continue;
        output[itemIndex].push({ photoId: photo.id, box: orientedBox, jpeg: crop.jpeg });
        retainedBytes += crop.jpeg.length;
      } catch { /* Missing image is explicit; never substitute another object or a generated picture. */ }
    }
  }
  return output;
}
