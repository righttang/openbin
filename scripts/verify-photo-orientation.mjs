// Exercise the real vision model on one book cover shown at four orientations.
// Run after `npm --prefix server run build`:
// node --env-file=.env scripts/verify-photo-orientation.mjs [output-directory]
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { recognizeCapture } from '../server/dist/lib/captures/recognition.js';
import { makePhotoPreview } from '../server/dist/lib/captures/media.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'remindme-orientation-'));
const output = process.argv[2];
const book = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640">
  <rect width="480" height="640" fill="#eee9df"/><rect x="45" y="25" width="390" height="590" rx="12" fill="#f7f4eb" stroke="#26364b" stroke-width="8"/>
  <rect x="50" y="30" width="380" height="125" fill="#ad273e"/><path d="M240 45l-25 30h15v35h20V75h15z" fill="white"/>
  <text x="240" y="143" text-anchor="middle" font-family="sans-serif" font-size="27" fill="white">TOP</text>
  <text x="240" y="255" text-anchor="middle" font-family="sans-serif" font-size="48" fill="#17283b">HOME</text>
  <text x="240" y="320" text-anchor="middle" font-family="sans-serif" font-size="48" fill="#17283b">HANDBOOK</text>
  <text x="240" y="415" text-anchor="middle" font-family="sans-serif" font-size="24">An illustrated guide</text>
  <rect x="50" y="520" width="380" height="90" fill="#287ca5"/>
</svg>`);
try {
  if (output) await fs.mkdir(output, { recursive: true });
  const photos = [];
  for (const rotation of [0, 90, 180, 270]) {
    const bytes = await sharp(book).rotate(rotation).jpeg({ quality: 90 }).toBuffer();
    const storage_path = path.join(folder, `book-${rotation}.jpg`);
    await fs.writeFile(storage_path, bytes);
    photos.push({ id: `book-${rotation}`, storage_path, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    if (output) await fs.writeFile(path.join(output, `input-${rotation}.jpg`), bytes);
  }
  const started = Date.now();
  const result = await recognizeCapture({ captureId: crypto.randomUUID(), binName: 'Book shelf', photos, existingItems: [] });
  const decisions = [];
  for (const [index, photo] of photos.entries()) {
    const original = index * 90;
    const expected = (360 - original) % 360;
    const actual = result.photo_rotations?.find(entry => entry.photo_id === photo.id)?.clockwise_degrees;
    decisions.push({ input_degrees: original, expected_clockwise: expected, actual_clockwise: actual ?? null });
    if (actual !== expected) throw new Error(`Orientation verification failed: ${JSON.stringify(decisions)}`);
    if (output) await fs.writeFile(path.join(output, `corrected-${original}.jpg`), (await makePhotoPreview(photo.storage_path, actual)).jpeg);
  }
  console.log(JSON.stringify({ verified: true, model_requests: 1, decisions, elapsed_seconds: Math.round((Date.now() - started) / 1000) }));
} finally { await fs.rm(folder, { recursive: true, force: true }); }
