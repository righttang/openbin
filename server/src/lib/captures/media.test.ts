import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CROP_BYTES, MAX_PREVIEW_BYTES, makePhotoPreview, prepareObservationMedia, prepareRotationPreviews, rotateBox } from './media.js';
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
  it.each([0, 90, 180, 270] as const)('applies EXIF once then turns the preview and actual crop %i degrees', async rotation => {
    const source = await photo('sideways', await splitPhoto());
    const rotations = [{ photo_id: source.id, clockwise_degrees: rotation }];
    const preview = rotation ? (await prepareRotationPreviews([source], rotations)).get(source.id)! : await makePhotoPreview(source.storage_path);
    expect([preview.width, preview.height]).toEqual(rotation % 180 ? [120, 80] : [80, 120]);
    const points = {
      0: [[0.5, 0.25], [0.5, 0.75]], 90: [[0.75, 0.5], [0.25, 0.5]],
      180: [[0.5, 0.75], [0.5, 0.25]], 270: [[0.25, 0.5], [0.75, 0.5]],
    }[rotation];
    for (const [index, [x, y]] of points.entries()) {
      const sample = await sharp(preview.jpeg).extract({ left: Math.floor(preview.width * x) - 2, top: Math.floor(preview.height * y) - 2, width: 4, height: 4 }).toBuffer();
      const stats = await sharp(sample).stats();
      expect(stats.channels[index === 0 ? 0 : 2].mean).toBeGreaterThan(230);
      expect(stats.channels[index === 0 ? 2 : 0].mean).toBeLessThan(20);
    }
    const [[crop]] = await prepareObservationMedia([source], [item([source.id], [{ photo_id: source.id, box: [0, 0.55, 1, 1] }])], rotations);
    const metadata = await sharp(crop.jpeg).metadata();
    expect([metadata.width, metadata.height]).toEqual(rotation % 180 ? [54, 80] : [80, 54]);
    expect((await sharp(crop.jpeg).stats()).channels[2].mean).toBeGreaterThan(230);
    const expected = { 0: [0, 0.55, 1, 1], 90: [0, 0, 0.45, 1], 180: [0, 0, 1, 0.45], 270: [0.55, 0, 1, 1] }[rotation];
    crop.box.forEach((value, index) => { expect(value).toBeCloseTo(expected[index]); });
    expect(crypto.createHash('sha256').update(await fs.readFile(source.storage_path)).digest('hex')).toBe(source.sha256);
  });

  it('fits a corrected preview into its existing byte budget and skips damaged sources', async () => {
    const source = await photo('sideways', await splitPhoto());
    const before = await makePhotoPreview(source.storage_path);
    const result = await prepareRotationPreviews([{ ...source, preview_bytes: before.jpeg.length }], [{ photo_id: source.id, clockwise_degrees: 90 }]);
    expect(result.get(source.id)!.jpeg.length).toBeLessThanOrEqual(before.jpeg.length);
    const corrupt = await photo('corrupt', Buffer.from('invalid'));
    expect((await prepareRotationPreviews([corrupt], [{ photo_id: corrupt.id, clockwise_degrees: 90 }])).size).toBe(0);
    expect((await prepareRotationPreviews([{ ...source, sha256: '0'.repeat(64) }], [{ photo_id: source.id, clockwise_degrees: 90 }])).size).toBe(0);
  });
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

  it('accepts quarter-turn corrections only for known, unique photo IDs', () => {
    for (const clockwise_degrees of [0, 90, 180, 270]) {
      expect(validateRecognition({ usable: true, items: [], photo_rotations: [{ photo_id: 'a', clockwise_degrees }] }, input).photo_rotations?.[0].clockwise_degrees).toBe(clockwise_degrees);
    }
    for (const photo_rotations of [[{ photo_id: 'a', clockwise_degrees: 45 }], [{ photo_id: 'unknown', clockwise_degrees: 90 }], [{ photo_id: 'a', clockwise_degrees: 90 }, { photo_id: 'a', clockwise_degrees: 180 }]]) {
      expect(() => validateRecognition({ usable: true, items: [], photo_rotations }, input)).toThrow('invalid_response');
    }
    expect(rotateBox([0.1, 0.2, 0.6, 0.8], 0)).toEqual([0.1, 0.2, 0.6, 0.8]);
  });

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
