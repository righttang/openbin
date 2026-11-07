import sharp from 'sharp';
import { query, type TxQueryFn } from '../../db.js';

/** Only live evidence from this place can establish cross-photo identity. */
export async function itemReferencePictures(binId: string, execute: TxQueryFn = query): Promise<Map<string, Buffer>> {
  const rows = (await execute<{ item_id: string; jpeg: Buffer | null }>(`WITH ranked AS (
    SELECT o.item_id,op.observation_id,op.photo_id,op.capture_id,
      ROW_NUMBER() OVER (PARTITION BY o.item_id ORDER BY
        CASE WHEN op.crop_jpeg IS NOT NULL THEN 0 ELSE 1 END,c.captured_at DESC,c.sequence DESC,o.id,op.photo_id) AS rank
    FROM observations o JOIN bin_items i ON i.id=o.item_id
    JOIN capture_batches c ON c.id=o.capture_id
    JOIN observation_photos op ON op.observation_id=o.id
    JOIN capture_photo_history h ON h.capture_id=op.capture_id AND h.photo_id=op.photo_id
    WHERE i.bin_id=$1 AND i.deleted_at IS NULL AND o.dismissed_at IS NULL AND h.dismissed_at IS NULL
      AND c.cancelled_at IS NULL AND c.state IN ('applied','superseded')
      AND (op.crop_jpeg IS NOT NULL OR h.preview_jpeg IS NOT NULL)
    ) SELECT r.item_id,COALESCE(op.crop_jpeg,h.preview_jpeg) AS jpeg FROM ranked r
      JOIN observation_photos op ON op.observation_id=r.observation_id AND op.photo_id=r.photo_id
      JOIN capture_photo_history h ON h.capture_id=r.capture_id AND h.photo_id=r.photo_id
      WHERE r.rank=1`, [binId])).rows;
  return new Map(rows.filter(row => row.jpeg).map(row => [row.item_id, row.jpeg!]));
}

/** Bounded-size contact sheets avoid resending scores of full-resolution photos. */
export async function referenceSheets(items: Array<{ id: string }>, pictures: Map<string, Buffer>, prefix = 'E') {
  const content: Array<Record<string, unknown>> = [];
  const illustrated = items.flatMap((item, index) => pictures.has(item.id) ? [{ id: item.id, label: `${prefix}${index + 1}`, jpeg: pictures.get(item.id)! }] : []);
  const width = prefix === 'S' ? 640 : 320, height = prefix === 'S' ? 520 : 280;
  const columns = prefix === 'S' ? 2 : 4, pageSize = prefix === 'S' ? 4 : 16;
  for (let start = 0; start < illustrated.length; start += pageSize) {
    const page = illustrated.slice(start, start + pageSize);
    const overlays: sharp.OverlayOptions[] = [];
    for (const [index, item] of page.entries()) {
      const left = (index % columns) * width, top = Math.floor(index / columns) * height;
      const jpeg = await sharp(item.jpeg).rotate().resize(width - 8, height - 36, { fit: 'contain', background: '#ffffff' }).jpeg().toBuffer();
      overlays.push({ input: jpeg, left: left + 4, top: top + 32 });
      overlays.push({ input: Buffer.from(`<svg width="${width}" height="32"><rect width="${width}" height="32" fill="#eeeeee"/><text x="10" y="24" font-size="22" font-family="sans-serif">${item.label}</text></svg>`), left, top });
    }
    const jpeg = await sharp({ create: { width: width * columns, height: height * Math.ceil(page.length / columns), channels: 3, background: '#ffffff' } })
      .composite(overlays).jpeg({ quality: 85 }).toBuffer();
    content.push({ type: 'text', text: `${prefix === 'S' ? 'Original-scene' : 'Existing-item'} reference sheet: ${page.map(item => `${item.label} = ${item.id}`).join('; ')}. These are reference views, not new capture photos.` });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
  }
  return content;
}
