import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecognitionInput, RecognitionResult } from './recognition.js';
import { rematchCapture } from './rematch.js';

const input: RecognitionInput = { captureId: 'photo-job', binName: 'Shelf', photos: [{ id: 'photo', storage_path: '', size: 0, sha256: '' }],
  existingItems: [{ id: 'camera', name: '小米室外摄像头', description: '用户确认的白色监控摄像头', aliases: ['室外监控'], quantity: 1 }] };
const result: RecognitionResult = { usable: true, photo_rotations: [{ photo_id: 'photo', clockwise_degrees: 90 }], items: [{
  name: 'Camera', description: 'White camera', aliases: ['camera'], quantity: 2, existing_item_id: null,
  photo_ids: ['photo'], regions: [{ photo_id: 'photo', box: [0.1, 0.2, 0.6, 0.8] }],
}] };
const envelope = (matches: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ matches }) } }] }));
const media = [[{ photoId: 'photo', box: [0.1, 0.2, 0.6, 0.8] as [number, number, number, number], jpeg: Buffer.from('crop') }]];
// No JPEG parsing is needed to verify the identity protocol.
vi.mock('./item-references.js', () => ({ itemReferencePictures: async () => new Map(), referenceSheets: async () => [] }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function configure(matches: unknown) {
  vi.stubEnv('AI_ENDPOINT_URL', 'https://gateway.test/v1'); vi.stubEnv('AI_MODEL', 'vision'); vi.stubEnv('AI_API_KEY', 'test-key');
  const fetcher = vi.fn().mockResolvedValue(envelope(matches)); vi.stubGlobal('fetch', fetcher); return fetcher;
}
describe('identity-only reconciliation after parallel recognition', () => {
  it('preserves current voice corrections, photo quantity, rotations and bounding boxes', async () => {
    const fetcher = configure([{ index: 0, existing_item_id: 'camera' }]);
    const updated = await rematchCapture(input, result, media);
    expect(updated).toEqual({ ...result, items: [{ ...result.items[0], existing_item_id: 'camera', name: '小米室外摄像头',
      description: '用户确认的白色监控摄像头', aliases: ['室外监控', 'camera'] }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(JSON.parse(payload.messages[1].content[0].text).recognized_items[0]).toMatchObject({ index: 0, previous_match: null });
    expect(payload.messages[0].content).toContain('Do not re-inventory');
  });
  it('retains distinct new objects without forcing a match', async () => {
    configure([{ index: 0, existing_item_id: null }]);
    expect(await rematchCapture(input, result, media)).toEqual(result);
  });
  it.each([[], [{ index: 1, existing_item_id: 'camera' }], [{ index: 0, existing_item_id: 'unknown' }],
    [{ index: 0, existing_item_id: 'camera', name: 'invented' }]].map(matches => ({ matches })))('rejects invalid assignments', async ({ matches }) => {
    configure(matches); await expect(rematchCapture(input, result, media)).rejects.toMatchObject({ category: 'invalid_response' });
  });
  it('rejects collapsing two visible objects to the same existing item', async () => {
    configure([{ index: 0, existing_item_id: 'camera' }, { index: 1, existing_item_id: 'camera' }]);
    await expect(rematchCapture(input, { ...result, items: [...result.items, { ...result.items[0], name: 'Another camera' }] }, [...media, ...media]))
      .rejects.toMatchObject({ category: 'invalid_response' });
  });
});
