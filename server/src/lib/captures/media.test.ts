import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CROP_BYTES, MAX_PREVIEW_BYTES, makePhotoPreview, prepareObservationMedia } from './media.js';
import type { RecognitionPhoto, RecognizedItem } from './recognition.js';
import { validateRecognition } from './recognition.js';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remindme-media-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

async function photo(id: string, bytes: Buffer): Promise<RecognitionPhoto> {
  const storage_path = path.join(directory, id);
  await fs.writeFile(storage_path, bytes);
  return { id, storage_path, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function item(photoIds: string[], regions?: RecognizedItem['regions']): RecognizedItem {
  return {
    name: 'Blue object', description: 'Solid blue rectangle', aliases: [], quantity: 1,
    existing_item_id: null, photo_ids: photoIds, ...(regions === undefined ? {} : { regions }),
  };
}

async function splitPhoto() {
  const pixels = Buffer.alloc(120 * 80 * 3);
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 120; x++) pixels[(y * 120 + x) * 3 + (x < 60 ? 0 : 2)] = 255;
  }
  return sharp(pixels, { raw: { width: 120, height: 80, channels: 3 } })
    .jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
}

describe('photo history image derivation', () => {
  it('creates an upright preview and strips EXIF metadata', async () => {
    const source = await photo('rotated', await splitPhoto());
    const preview = await makePhotoPreview(source.storage_path);
    expect([preview.width, preview.height]).toEqual([80, 120]);
    const metadata = await sharp(preview.jpeg).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(preview.jpeg.length).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
  });

  it('extracts actual pixels using the upright coordinate system', async () => {
    const source = await photo('rotated', await splitPhoto());
    const media = await prepareObservationMedia([source], [item([source.id], [{ photo_id: source.id, box: [0, 0.55, 1, 1] }])]);
    expect(media[0]).toHaveLength(1);
    expect(media[0][0].photoId).toBe(source.id);
    const metadata = await sharp(media[0][0].jpeg).metadata();
    expect(metadata.width).toBe(80);
    expect(metadata.height).toBe(54);
    const stats = await sharp(media[0][0].jpeg).stats();
    expect(stats.channels[2].mean).toBeGreaterThan(230);
    expect(stats.channels[0].mean).toBeLessThan(20);
    expect(stats.channels[1].mean).toBeLessThan(20);
  });

  it('bounds noisy previews and item crops by pixel dimensions and encoded bytes', async () => {
    const bytes = await sharp(crypto.randomBytes(1800 * 1200 * 3), { raw: { width: 1800, height: 1200, channels: 3 } })
      .jpeg({ quality: 85 }).toBuffer();
    const source = await photo('noise', bytes);
    const preview = await makePhotoPreview(source.storage_path);
    expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(960);
    expect(preview.jpeg.length).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
    const [[crop]] = await prepareObservationMedia([source], [item([source.id], [{ photo_id: source.id, box: [0, 0, 1, 1] }])]);
    const metadata = await sharp(crop.jpeg).metadata();
    expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(512);
    expect(crop.jpeg.length).toBeLessThanOrEqual(MAX_CROP_BYTES);
  });

  it('uses just the best region per item and leaves absent or missing regions empty', async () => {
    const a = await photo('a', await splitPhoto());
    const b = await photo('b', await splitPhoto());
    const media = await prepareObservationMedia([a, b], [
      item(['a', 'b'], [{ photo_id: 'b', box: [0, 0, 1, 1] }, { photo_id: 'a', box: [0, 0, 1, 1] }]),
      item(['a']), item(['a'], null),
      item(['missing'], [{ photo_id: 'missing', box: [0, 0, 1, 1] }]),
    ]);
    expect(media.map((entry) => entry.map((crop) => crop.photoId))).toEqual([['b'], [], [], []]);
  });

  it('does not substitute corrupt, missing or checksum-mismatched sources', async () => {
    const good = await photo('good', await splitPhoto());
    const corrupt = await photo('corrupt', Buffer.from('not an image'));
    const missing = { ...good, id: 'missing', storage_path: path.join(directory, 'absent') };
    const mismatch = { ...good, id: 'wrong', sha256: '0'.repeat(64) };
    const sources = [corrupt, missing, mismatch];
    const media = await prepareObservationMedia(sources, sources.map((source) => item([source.id], [{ photo_id: source.id, box: [0, 0, 1, 1] }])));
    expect(media).toEqual([[], [], []]);
    await expect(makePhotoPreview(corrupt.storage_path)).rejects.toThrow();
  });

  it('rejects pixel decompression beyond the decode limit', async () => {
    const source = await photo('large', Buffer.from('<svg width="10000" height="10000" xmlns="http://www.w3.org/2000/svg"><rect width="10000" height="10000" fill="red"/></svg>'));
    await expect(makePhotoPreview(source.storage_path)).rejects.toThrow();
    expect(await prepareObservationMedia([source], [item([source.id], [{ photo_id: source.id, box: [0, 0, 1, 1] }])])).toEqual([[]]);
  });
});

describe('recognition regions', () => {
  const input: Parameters<typeof validateRecognition>[1] = {
    photos: ['a', 'b'].map((id) => ({ id, storage_path: '', size: 1, sha256: '' })), existingItems: [],
  };

  it('accepts normalized regions and backward-compatible results without regions', () => {
    for (const regions of [undefined, null, [], [{ photo_id: 'a', box: [0, 0.1, 1, 0.9] as [number, number, number, number] }]]) {
      expect(() => validateRecognition({ usable: true, items: [item(['a'], regions)] }, input)).not.toThrow();
    }
  });

  it('rejects malformed, out-of-bounds and degenerate boxes', () => {
    for (const box of [[0, 0, 1.01, 1], [-0.1, 0, 1, 1], [0.5, 0, 0.5, 1], [0, 0.9, 1, 0.1], [0, 0, Infinity, 1], [0, 0, 1]]) {
      expect(() => validateRecognition({ usable: true, items: [{ ...item(['a']), regions: [{ photo_id: 'a', box }] }] }, input))
        .toThrow('invalid_response');
    }
  });

  it('rejects regions from non-supporting photos and duplicate regions in one photo', () => {
    const region = { photo_id: 'a', box: [0, 0, 1, 1] };
    for (const regions of [[{ ...region, photo_id: 'b' }], [{ ...region, photo_id: 'unknown' }], [region, region]]) {
      expect(() => validateRecognition({ usable: true, items: [{ ...item(['a']), regions }] }, input)).toThrow('invalid_response');
    }
  });
});
